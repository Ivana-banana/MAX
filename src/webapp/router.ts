/**
 * HTTP surface of the mini app: a small JSON API plus the built React bundle.
 *
 * The bundle is served by the same process as the webhook, because a MAX mini app needs one
 * public HTTPS origin (https://dev.max.ru/docs/webapps/introduction) and the project ships one
 * container. Every API request is authenticated by the signed launch data, never by a user id
 * in the request body.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { plan } from "../bot/dialog.js";
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

/**
 * A download cannot carry an Authorization header: `WebApp.downloadFile()` and a plain browser
 * link both just fetch a URL. So the app asks for a ticket first — signed, five minutes, one
 * user — instead of putting the launch data in a URL that ends up in logs and history.
 */
const TICKET_TTL = 300;

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

const ticketMac = (secret: string, user: number, expires: number) =>
  createHmac("sha256", secret).update(`calendar:${user}:${expires}`).digest("hex");

const issueTicket = (secret: string, user: number, now: number): string => {
  const expires = Math.floor(now / 1000) + TICKET_TTL;
  return `${user}.${expires}.${ticketMac(secret, user, expires)}`;
};

function readTicket(secret: string, ticket: string, now: number): number | null {
  const [rawUser, rawExpires, mac] = ticket.split(".");
  const user = Number(rawUser), expires = Number(rawExpires);
  if (!Number.isSafeInteger(user) || user <= 0 || !Number.isSafeInteger(expires) || mac === undefined) return null;
  const expected = Buffer.from(ticketMac(secret, user, expires), "utf8");
  const given = Buffer.from(mac, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return Math.floor(now / 1000) <= expires ? user : null;
}

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

async function icsFor(service: Service, user: number): Promise<string | null> {
  const session = await service.store.get(user);
  const ctx = service.ctx();
  // The chat has stopped a plan built on older rules (rulesChanged); no calendar for it either.
  if (!session || session.ruleVersion !== ctx.version) return null;
  const items = plan(session, ctx);
  if (!items.some(i => i.status !== "done")) return null;
  return planToIcs(items,
    { lang: session.lang, texts: ctx.texts, demo: ctx.demo, uid: session.nonce, today: ctx.today, sequence: session.revision });
}

/**
 * Handles mini app routes. Returns `false` when the request belongs to someone else, so the
 * webhook server keeps its own 404 behaviour.
 */
export function webappRouter(service: Service, options: WebappOptions) {
  const root = resolve(options.dir);
  // Tickets live five minutes, so a key of this process alone is enough, and no configured secret
  // (the webhook one is known to MAX as well) can mint a ticket for somebody else.
  const ticketSecret = randomBytes(32).toString("hex");
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const api = path === "/api/state" || path === "/api/action"
      || path === "/api/calendar.ics" || path === "/api/calendar-ticket";
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
        // The calendar file is the one route a ticket may open: a download carries no header.
        const ticket = path === "/api/calendar.ics" ? url.searchParams.get("ticket") : null;
        const ticketUser = ticket === null ? null : readTicket(ticketSecret, ticket, service.clock());
        if (ticket !== null && ticketUser === null) throw new HttpError(401, "unauthorized");
        const caller = ticketUser === null
          ? authenticate(req, options, service.clock())
          : { user: ticketUser, mocked: false };
        if (path === "/api/state") {
          if (req.method !== "GET") throw new HttpError(405, "method_not_allowed");
          send(200, {
            state: await readState(service, caller.user, caller.mocked, caller.languageCode),
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
          send(200, await applyAction(service, caller.user, action, caller.mocked,
            revision === undefined ? undefined : Number(revision), caller.languageCode));
          return true;
        }
        if (path === "/api/calendar-ticket") {
          if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
          send(200, {
            url: `api/calendar.ics?ticket=${issueTicket(ticketSecret, caller.user, service.clock())}`,
            fileName: CALENDAR_FILE, expiresIn: TICKET_TTL,
          });
          return true;
        }
        if (req.method !== "GET") throw new HttpError(405, "method_not_allowed");
        const ics = await icsFor(service, caller.user);
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
    // Vite fingerprints bundle file names (`index-C5bBlBUA.js`), so only index.html is revalidated.
    const immutable = candidate !== "index.html" && /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(candidate);
    res.writeHead(200, head({
      "content-type": type,
      "content-length": String(size),
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    }));
    if (req.method === "HEAD") { res.end(); return true; }
    // pipeline closes the file when the client drops the download. Headers are already out, so a
    // read error can only cut the response short, not turn into a second answer.
    try { await pipeline(createReadStream(file), res); } catch { res.destroy(); }
    return true;
  };
}
