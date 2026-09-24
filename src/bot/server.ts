import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { parseUpdate, Service } from "./service.js";
/** Mini app routes, if one is enabled: returns true once it has answered the request. */
export type ExtraRoutes = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
export function webhookServer(service: Service, secret: string, extra?: ExtraRoutes) {
  return createServer(async (req, res) => {
    const send = (status: number, value: object) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "GET" && req.url === "/health") {
      try { send(200, { status: "ok", mode: service.context.demo ? "demo" : "live", queue: await service.store.counts() }); }
      catch { send(503, { error: "storage_unavailable" }); }
      return;
    }
    if (extra) {
      // The mini app answers its own routes; anything it does not own falls through to the webhook.
      try { if (await extra(req, res)) return; }
      catch { send(503, { error: "webapp_unavailable" }); return; }
    }
    if (req.method !== "POST" || req.url !== "/webhook") { send(404, { error: "not_found" }); return; }
    const header = req.headers["x-max-bot-api-secret"];
    if (typeof header !== "string" || Buffer.byteLength(header) !== Buffer.byteLength(secret) ||
        !timingSafeEqual(Buffer.from(header), Buffer.from(secret))) { send(401, { error: "unauthorized" }); return; }
    if (!req.headers["content-type"]?.startsWith("application/json")) { send(415, { error: "json_required" }); return; }
    let raw: unknown;
    try { raw = JSON.parse(await readBody(req)); }
    catch (e) { send(e instanceof RangeError ? 413 : 400, { error: "invalid_body" }); return; }
    let update;
    try { update = parseUpdate(raw); }
    catch { send(400, { error: "invalid_update" }); return; }
    try { if (update) await service.receive(update); }
    catch { send(503, { error: "storage_or_processing_failure" }); return; }
    send(200, { success: true });
    if (update?.callbackId) void service.transport.answer?.(update.callbackId).catch(() => {});
  });
}
async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0, rejected = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > 65536) { rejected = true; chunks.length = 0; reject(new RangeError("body too large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!rejected) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}
