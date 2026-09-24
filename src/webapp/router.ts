/**
 * HTTP surface of the mini app: a small JSON API plus the built React bundle.
 *
 * The bundle is served by the same process as the webhook, because a MAX mini app needs one
 * public HTTPS origin (https://dev.max.ru/docs/webapps/introduction) and the project ships one
 * container. Every API request is authenticated by the signed launch data, never by a user id
 * in the request body.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { plan, type Session } from "../bot/dialog.js";
import { CALENDAR_FILE, planToIcs } from "../bot/calendar.js";
import type { Service } from "../bot/service.js";
import { LaunchError, verifyLaunch } from "./initData.js";
import { applyAction, isAppAction, readState, RevisionConflict } from "./state.js";

export interface WebappOptions {
  /** Bot token: the launch signature is derived from it. Empty disables the signed path. */
  token: string;
  /** Directory with the built bundle (`npm --prefix web run build`). */
  dir: string;
  /**
   * Accept `Authorization: MaxWebApp demo:<id>` without a signature. Local demonstration only;
   * `readConfig` refuses it outside `APP_MODE=demo` with `TRANSPORT=console`.
   */
  devLaunch: boolean;
  /** Origin of the Vite dev server, allowed through CORS during local development only. */
  devOrigin: string;
}

const JSON_LIMIT = 4096;
const TYPES = new Map(Object.entries({
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json; charset=utf-8",
}));

/**
 * No `frame-ancestors`: the origin the MAX web client embeds a mini app from is not documented,
 * and a wrong value would break the very scenario reviewers open. TBD — measure inside real MAX,
 * then pin it here.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://st.max.ru",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
].join("; ");

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = "HttpError"; }
}

interface Caller { user: number; mocked: boolean; startParam?: string; languageCode?: string }

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "json_required");
  const body = await new Promise<string>((done, fail) => {
    let size = 0, over = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > JSON_LIMIT) { over = true; chunks.length = 0; fail(new HttpError(413, "body_too_large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!over) done(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", () => fail(new HttpError(400, "invalid_body")));
  });
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { throw new HttpError(400, "invalid_body"); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "invalid_body");
  return raw as Record<string, unknown>;
}

let mockedLaunchLogged = false;

function authenticate(req: IncomingMessage, options: WebappOptions, now: number): Caller {
  const header = req.headers.authorization;
  const scheme = "MaxWebApp ";
  if (typeof header !== "string" || !header.startsWith(scheme)) throw new HttpError(401, "unauthorized");
  const value = header.slice(scheme.length);
  if (options.devLaunch && value.startsWith("demo:")) {
    const user = Number(value.slice("demo:".length));
    if (!Number.isSafeInteger(user) || user <= 0) throw new HttpError(401, "unauthorized");
    if (!mockedLaunchLogged) {
      mockedLaunchLogged = true;
      console.log("[MOCKED: mini app launch data; the local demo has no bot token, so there is no MAX signature to verify]");
    }
    return { user, mocked: true };
  }
  if (!options.token) throw new HttpError(503, "launch_validation_unavailable");
  try {
    const launch = verifyLaunch(value, options.token, now);
    return {
      user: launch.userId, mocked: false,
      ...(launch.startParam === undefined ? {} : { startParam: launch.startParam }),
      ...(launch.languageCode === undefined ? {} : { languageCode: launch.languageCode }),
    };
  } catch (e) {
    // One answer for every reason: which check failed is a hint to a forger, not to a user.
    if (e instanceof LaunchError) throw new HttpError(401, "unauthorized");
    throw e;
  }
}

function icsFor(session: Session | null, service: Service): string | null {
  if (!session) return null;
  const ctx = service.ctx();
  const items = plan(session, ctx).filter(i => i.status !== "done");
  if (!items.length) return null;
  return planToIcs(items, { lang: session.lang, demo: ctx.demo, uid: session.nonce, today: ctx.today });
}

/**
 * Handles mini app routes. Returns `false` when the request belongs to someone else, so the
 * webhook server keeps its own 404 behaviour.
 */
export function webappRouter(service: Service, options: WebappOptions) {
  const root = resolve(options.dir);
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const api = path === "/api/state" || path === "/api/action" || path === "/api/calendar.ics";
    if (!api && !(req.method === "GET" || req.method === "HEAD")) return false;

    const cors = options.devOrigin !== "" && req.headers.origin === options.devOrigin;
    const head = (extra: Record<string, string> = {}) => ({
      ...(cors ? {
        "access-control-allow-origin": options.devOrigin,
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        vary: "origin",
      } : {}),
      ...extra,
    });
    const send = (status: number, value: object) => {
      res.writeHead(status, head({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }));
      res.end(JSON.stringify(value));
    };
    if (api && req.method === "OPTIONS") { res.writeHead(cors ? 204 : 405, head()); res.end(); return true; }

    if (api) {
      try {
        const caller = authenticate(req, options, service.clock());
        if (path === "/api/state") {
          if (req.method !== "GET") throw new HttpError(405, "method_not_allowed");
          send(200, {
            state: readState(service, caller.user, caller.mocked),
            // The client turns these into the first action: the university a QR poster chose and
            // the MAX interface language. Both are hints, both are re-checked by the dialogue.
            launch: {
              ...(caller.startParam === undefined ? {} : { startParam: caller.startParam }),
              ...(caller.languageCode === undefined ? {} : { languageCode: caller.languageCode }),
            },
          });
          return true;
        }
        if (path === "/api/action") {
          if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
          const body = await readJson(req);
          const action = body.action;
          if (typeof action !== "string" || !isAppAction(action)) throw new HttpError(400, "unsupported_action");
          const revision = body.revision;
          if (revision !== undefined && !(Number.isSafeInteger(revision) && Number(revision) >= 0)) {
            throw new HttpError(400, "invalid_revision");
          }
          send(200, applyAction(service, caller.user, action, caller.mocked,
            revision === undefined ? undefined : Number(revision)));
          return true;
        }
        if (req.method !== "GET") throw new HttpError(405, "method_not_allowed");
        const ics = icsFor(service.store.get(caller.user), service);
        if (ics === null) throw new HttpError(404, "nothing_to_export");
        res.writeHead(200, head({
          "content-type": "text/calendar; charset=utf-8",
          "content-disposition": `attachment; filename="${CALENDAR_FILE}"`,
          "cache-control": "no-store",
        }));
        res.end(ics);
        return true;
      } catch (e) {
        if (e instanceof HttpError) { send(e.status, { error: e.code }); return true; }
        if (e instanceof RevisionConflict) { send(409, { error: "revision_conflict", revision: e.revision }); return true; }
        console.error("Mini app request failed; inspect storage.");
        send(503, { error: "unavailable" });
        return true;
      }
    }

    // Static bundle. A path without an extension falls back to index.html, so a reload inside the
    // app does not 404 once the UI grows client-side routes.
    let requested: string;
    try { requested = decodeURIComponent(path); } catch { res.writeHead(400, head()); res.end(); return true; }
    if (requested.includes("\0")) { res.writeHead(400, head()); res.end(); return true; }
    const relative = normalize(requested).replace(/^[/\\]+/, "");
    const candidate = relative === "" || !relative.includes(".") ? "index.html" : relative;
    const file = join(root, candidate);
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403, head()); res.end(); return true; }
    const type = TYPES.get(file.slice(file.lastIndexOf(".")).toLowerCase());
    if (type === undefined) { res.writeHead(403, head()); res.end(); return true; }
    let size: number;
    try {
      const info = await stat(file);
      if (!info.isFile()) return false;
      size = info.size;
    } catch {
      // Nothing built yet: let the webhook server answer 404 instead of pretending the app exists.
      return false;
    }
    // Vite fingerprints bundle file names, so only index.html has to be revalidated.
    const immutable = candidate !== "index.html" && /\.[0-9a-f]{8,}\./i.test(candidate);
    res.writeHead(200, head({
      "content-type": type,
      "content-length": String(size),
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    }));
    if (req.method === "HEAD") { res.end(); return true; }
    await new Promise<void>((done, fail) => {
      createReadStream(file).on("error", fail).pipe(res).on("finish", () => done()).on("error", fail);
    });
    return true;
  };
}
