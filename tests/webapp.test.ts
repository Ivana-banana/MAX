import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readUniversities } from "../src/data/loadUniversities.js";
import { readConfig } from "../src/bot/config.js";
import type { Reply } from "../src/bot/dialog.js";
import { Store } from "../src/bot/store.js";
import { Service } from "../src/bot/service.js";
import { webhookServer } from "../src/bot/server.js";
import { verifyLaunch, LaunchError } from "../src/webapp/initData.js";
import { applyAction, isAppAction, readState, RevisionConflict } from "../src/webapp/state.js";
import { webappRouter } from "../src/webapp/router.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const ctx = { rules: rules.rules, universities, version: rules.version, demo: true, today: "2026-09-24" };
const NOW = Date.parse("2026-09-24T10:00:00+03:00");
const TOKEN = "test-token-not-a-real-one"; // secret-scan: allow — fixture, not a credential
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

/** Builds startup data the way MAX does (https://dev.max.ru/docs/webapps/validation). */
function launch(fields: Record<string, string>, token = TOKEN): string {
  const entries = Object.entries(fields).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(entries.map(([k, v]) => `${k}=${v}`).join("\n")).digest("hex");
  return [...entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`), `hash=${hash}`].join("&");
}
const user = (id = 7, language = "ru-RU") =>
  JSON.stringify({ id, first_name: "Max", last_name: "User", username: null, language_code: language, photo_url: null });
const genuine = (extra: Record<string, string> = {}, at = NOW, token = TOKEN) => launch({
  auth_date: String(Math.floor(at / 1000)), query_id: "4c0ab423-342b-4e45-aea4-2747dbc500cd",
  chat: JSON.stringify({ id: 12345, type: "DIALOG" }), user: user(), ...extra,
}, token);

function fixture(dir = "./web/dist", devLaunch = true) {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  const sent: { user: number; reply: Reply }[] = [];
  const service = new Service(store, ctx, { async send(u, reply) { sent.push({ user: u, reply }); } }, () => NOW);
  const router = webappRouter(service, { token: TOKEN, dir, devLaunch, devOrigin: "", ticketSecret: "ticket-key-for-tests" });
  return { store, service, sent, router };
}

async function serve(router: ReturnType<typeof webappRouter>, service: Service) {
  const server = webhookServer(service, "test-secret-that-is-long-enough-32", router);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${port}`;
}
const auth = (value: string) => ({ authorization: `MaxWebApp ${value}` });
const act = (url: string, value: string, body: object) => fetch(`${url}/api/action`,
  { method: "POST", headers: { ...auth(value), "content-type": "application/json" }, body: JSON.stringify(body) });

describe("mini app startup data", () => {
  it("accepts a genuine launch and returns only the signed facts", () => {
    const result = verifyLaunch(genuine({ start_param: "itmo" }), TOKEN, NOW);
    expect(result).toEqual({ userId: 7, authDate: Math.floor(NOW / 1000), languageCode: "ru-RU", startParam: "itmo" });
  });
  it("rejects a tampered payload, another bot's token and a broken envelope", () => {
    const reasons = (data: string, token = TOKEN) => {
      try { verifyLaunch(data, token, NOW); return "accepted"; }
      catch (e) { return e instanceof LaunchError ? e.reason : "other"; }
    };
    const valid = genuine();
    // Same signature, different user: the classic forgery the signature exists to stop.
    expect(reasons(valid.replace(encodeURIComponent(user()), encodeURIComponent(user(8))))).toBe("bad_signature");
    expect(reasons(valid, "another-bot-token")).toBe("bad_signature");
    expect(reasons(valid.replace(/&hash=.*/, ""))).toBe("no_hash");
    expect(reasons(valid + "&hash=00")).toBe("duplicate_key");
    expect(reasons("auth_date")).toBe("malformed");
    expect(reasons("=x&hash=00")).toBe("malformed");
    expect(reasons("x".repeat(5000))).toBe("too_large");
    expect(reasons("")).toBe("too_large");
    expect(reasons(launch({ auth_date: String(Math.floor(NOW / 1000)), user: "not json" }))).toBe("no_user");
    expect(reasons(launch({ auth_date: String(Math.floor(NOW / 1000)), user: JSON.stringify({ id: 0 }) }))).toBe("no_user");
  });
  it("expires an hour-old launch and refuses one from the future", () => {
    const reason = (at: number) => {
      try { verifyLaunch(genuine({}, at), TOKEN, NOW); return "accepted"; }
      catch (e) { return e instanceof LaunchError ? e.reason : "other"; }
    };
    expect(reason(NOW - 3599_000)).toBe("accepted");
    expect(reason(NOW - 3601_000)).toBe("expired");
    expect(reason(NOW + 299_000)).toBe("accepted");
    expect(reason(NOW + 301_000)).toBe("future");
  });
});

describe("mini app actions on the shared session", () => {
  it("walks the same scenario as the chat and computes the same plan", () => {
    const f = fixture();
    expect(readState(f.service, 7, false).session).toBeNull();
    for (const action of ["/start kfu", "ru", "accept", "yes", "KZ", "2026-09-01"]) {
      applyAction(f.service, 7, action, false);
    }
    const state = readState(f.service, 7, false);
    expect(state.session?.step).toBe("plan");
    expect(state.session?.university).toEqual({ id: "kfu", name: "КФУ", contactUrl: expect.stringContaining("kpfu.ru") });
    expect(state.session?.plan.map(i => [i.ruleId, i.dueDate]))
      .toEqual([["medical-examination", "2026-09-30"], ["fingerprinting", "2026-11-29"]]);
    // The legal basis travels with every item: a screen must never show a date without its source.
    expect(state.session?.plan[0]?.provisional).toBe(true);
    expect(state.session?.plan[0]?.legal.url).toContain("consultant.ru");
    expect(state.demo).toBe(true);
  });
  it("refuses an action built on a revision someone else has already moved past", () => {
    const f = fixture();
    applyAction(f.service, 7, "/start", false);
    const revision = readState(f.service, 7, false).session!.revision;
    expect(() => applyAction(f.service, 7, "ru", false, revision - 1)).toThrow(RevisionConflict);
    expect(readState(f.service, 7, false).session?.step).toBe("language");
    applyAction(f.service, 7, "ru", false, revision);
    expect(readState(f.service, 7, false).session?.step).toBe("consent");
  });
  it("keeps chat-only branches out of the app's vocabulary", () => {
    for (const action of ["/start", "/start kfu", "ru", "accept", "yes", "KZ", "OTHER", "2026-09-01", "/today",
      "plan", "reminders", "doc:medical-examination:passport", "done:fingerprinting", "/delete", "confirm-delete",
      "cancel-delete"]) expect(isAppAction(action), action).toBe(true);
    for (const action of ["/stop", "calendar", "help", "/help", "help:fingerprinting", "card:fingerprinting",
      "/start ../etc", "doc:x", "done:", "reminders ", "2026-02-30", ""]) expect(isAppAction(action), action).toBe(false);
  });
  it("drops chat messages that the app's change would have made stale", async () => {
    const f = fixture();
    f.service.receive({ id: "a", user: 7, input: { text: "/start", callback: false } });
    expect(f.store.counts().pending).toBe(1);
    applyAction(f.service, 7, "ru", false);
    expect(f.store.counts().pending ?? 0).toBe(0);
  });
  it("counts the same anonymous funnel events the chat counts", () => {
    const f = fixture();
    for (const action of ["/start", "ru", "accept", "yes", "KZ", "2026-09-01"]) applyAction(f.service, 7, action, false);
    const events = f.store.funnel().filter(r => r.n > 0).map(r => r.event);
    expect(events).toContain("started");
    expect(events).toContain("plan_ready");
    expect(f.store.funnel().every(r => r.university === "kfu")).toBe(true);
  });
});

describe("mini app HTTP surface", () => {
  it("answers only with a verified launch, and never says which check failed", async () => {
    const f = fixture();
    const url = await serve(f.router, f.service);
    expect((await fetch(`${url}/api/state`)).status).toBe(401);
    expect((await fetch(`${url}/api/state`, { headers: { authorization: "Bearer x" } })).status).toBe(401);
    const forged = genuine().replace(/hash=.*/, "hash=" + "0".repeat(64));
    const bad = await fetch(`${url}/api/state`, { headers: auth(forged) });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "unauthorized" });
    expect((await fetch(`${url}/api/state`, { headers: auth(genuine()) })).status).toBe(200);
  });
  it("starts empty, onboards over the API and reports the dialogue's own wording", async () => {
    const f = fixture();
    const url = await serve(f.router, f.service);
    const value = genuine({ start_param: "itmo" });
    const first = await (await fetch(`${url}/api/state`, { headers: auth(value) })).json() as
      { state: { session: null }; launch: { startParam?: string; languageCode?: string } };
    expect(first.state.session).toBeNull();
    expect(first.launch).toEqual({ startParam: "itmo", languageCode: "ru-RU" });

    let revision = 0;
    for (const action of ["/start itmo", "ru", "accept", "yes", "KZ", "2026-09-01"]) {
      const response = await act(url, value, { action, revision });
      expect(response.status, action).toBe(200);
      const body = await response.json() as { state: { session: { revision: number } }; message: string };
      expect(typeof body.message).toBe("string");
      revision = body.state.session.revision;
    }
    const state = await (await fetch(`${url}/api/state`, { headers: auth(value) })).json() as
      { state: { session: { step: string; university: { id: string }; plan: unknown[] } } };
    expect(state.state.session.step).toBe("plan");
    expect(state.state.session.university.id).toBe("itmo");
    expect(state.state.session.plan).toHaveLength(2);
  });
  it("rejects bad bodies, unsupported actions and a stale revision", async () => {
    const f = fixture();
    const url = await serve(f.router, f.service);
    const value = genuine();
    const headers = { ...auth(value), "content-type": "application/json" };
    expect((await fetch(`${url}/api/action`, { method: "POST", headers: auth(value), body: "{}" })).status).toBe(415);
    expect((await fetch(`${url}/api/action`, { method: "POST", headers, body: "{" })).status).toBe(400);
    expect((await fetch(`${url}/api/action`, { method: "POST", headers, body: "[]" })).status).toBe(400);
    expect((await fetch(`${url}/api/action`, { method: "POST", headers, body: JSON.stringify({ data: "x".repeat(5000) }) })).status).toBe(413);
    expect((await act(url, value, { action: "/stop" })).status).toBe(400);
    expect((await act(url, value, { action: "reminders", revision: -1 })).status).toBe(400);
    expect((await fetch(`${url}/api/action`, { headers: auth(value) })).status).toBe(405);
    expect((await fetch(`${url}/api/state`, { method: "POST", headers })).status).toBe(405);
    await act(url, value, { action: "/start" });
    const conflict = await act(url, value, { action: "ru", revision: 99 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "revision_conflict", revision: 1 });
  });
  it("exports the plan as a calendar file and says so when there is nothing to export", async () => {
    const f = fixture();
    const url = await serve(f.router, f.service);
    const value = genuine();
    expect((await fetch(`${url}/api/calendar.ics`, { headers: auth(value) })).status).toBe(404);
    for (const action of ["/start", "ru", "accept", "yes", "KZ", "2026-09-01"]) await act(url, value, { action });
    const ics = await fetch(`${url}/api/calendar.ics`, { headers: auth(value) });
    expect(ics.headers.get("content-disposition")).toContain("first-90-days.ics");
    expect((await ics.text()).match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });
  it("hands out a short-lived download ticket, because a download carries no header", async () => {
    const f = fixture();
    const url = await serve(f.router, f.service);
    const value = genuine();
    for (const action of ["/start", "ru", "accept", "yes", "KZ", "2026-09-01"]) await act(url, value, { action });
    const issued = await fetch(`${url}/api/calendar-ticket`, { method: "POST", headers: auth(value) });
    expect(issued.status).toBe(200);
    const ticket = await issued.json() as { url: string; fileName: string; expiresIn: number };
    expect(ticket.fileName).toBe("first-90-days.ics");
    const downloaded = await fetch(`${url}/${ticket.url}`);
    expect(downloaded.status).toBe(200);
    expect((await downloaded.text()).match(/BEGIN:VEVENT/g)).toHaveLength(2);
    // A ticket for somebody else, or with the signature edited, opens nothing.
    expect((await fetch(`${url}/api/calendar.ics?ticket=8.9999999999.${"0".repeat(64)}`)).status).toBe(401);
    expect((await fetch(`${url}/${ticket.url.replace(/.$/, "f")}`)).status).toBe(401);
    expect((await fetch(`${url}/api/calendar-ticket`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${url}/api/calendar-ticket`, { headers: auth(value) })).status).toBe(405);
  });
  it("accepts an unsigned demo launch only where the config allows one", async () => {
    const open = fixture();
    const openUrl = await serve(open.router, open.service);
    expect((await fetch(`${openUrl}/api/state`, { headers: auth("demo:42") })).status).toBe(200);
    const closed = fixture("./web/dist", false);
    const closedUrl = await serve(closed.router, closed.service);
    expect((await fetch(`${closedUrl}/api/state`, { headers: auth("demo:42") })).status).toBe(401);
  });
  it("refuses a dev origin outside the local console demo", () => {
    const env = { WEBHOOK_SECRET: "a".repeat(32), WEBAPP_DEV_ORIGIN: "http://localhost:5173" };
    expect(readConfig(env).webappDevOrigin).toBe("http://localhost:5173");
    expect(() => readConfig({ ...env, TRANSPORT: "max", MAX_BOT_TOKEN: "t" })).toThrow(/WEBAPP_DEV_ORIGIN/);
    expect(() => readConfig({ ...env, WEBAPP_DEV_ORIGIN: "http://localhost:5173/app" })).toThrow(/bare origin/);
    expect(readConfig({ WEBHOOK_SECRET: "a".repeat(32) }).webappDir).toBe("./web/dist");
  });
  it("serves the built bundle and refuses to leave its directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webapp-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>app</title>");
    writeFileSync(join(dir, "app-C5bBlBUA.js"), "export const ok = 1;");
    writeFileSync(join(dir, "notes.md"), "not part of the bundle");
    const f = fixture(dir);
    const url = await serve(f.router, f.service);
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("https://st.max.ru");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    // A reload on a client-side route must reach the app, not a 404.
    expect((await fetch(`${url}/plan`)).status).toBe(200);
    const asset = await fetch(`${url}/app-C5bBlBUA.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${url}/notes.md`)).status).toBe(403);
    // Traversal is normalised away before it can leave the root, so these end as plain misses.
    for (const attack of ["/%2e%2e/package.json", "/a/%2e%2e/%2e%2e/package.json", "/C:/Windows/win.ini"]) {
      const response = await fetch(url + attack);
      expect(response.status, attack).not.toBe(200);
      expect(await response.text(), attack).not.toContain("max-first-90-days");
    }
    expect((await fetch(`${url}/missing.js`)).status).toBe(404);
    // The webhook still belongs to the bot.
    expect((await fetch(`${url}/webhook`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
  it("answers 404 for the app while no bundle has been built", async () => {
    const f = fixture(join(tmpdir(), "webapp-missing-on-purpose"));
    const url = await serve(f.router, f.service);
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(`${url}/api/state`, { headers: auth(genuine()) })).status).toBe(200);
  });
  it("lets the chat and the app act on one session in turn", async () => {
    const f = fixture();
    const url = await serve(f.router, f.service);
    const value = genuine();
    f.service.receive({ id: "1", user: 7, input: { text: "/start", callback: false } });
    for (const action of ["ru", "accept", "yes", "KZ", "2026-09-01"]) {
      const session = f.store.get(7)!;
      f.service.receive({ id: action, user: 7, input: { text: `${session.nonce}.${session.revision}|${action}`, callback: true } });
    }
    const toggled = await act(url, value, { action: "doc:medical-examination:passport" });
    expect(toggled.status).toBe(200);
    expect(f.store.get(7)?.documents["medical-examination:2026-09-30:passport"]).toBe(true);
    const state = await (await fetch(`${url}/api/state`, { headers: auth(value) })).json() as
      { state: { session: { plan: { documents: { id: string; checked: boolean }[] }[] } } };
    expect(state.state.session.plan[0]?.documents.find(d => d.id === "passport")?.checked).toBe(true);
  });
});

describe("mini app packaging", () => {
  it("builds the bundle in the image and points the server at it", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    // Its own stage, so the React toolchain never reaches the runtime image.
    expect(dockerfile).toMatch(/^FROM \S+ AS web$/m);
    expect(dockerfile).toContain("COPY --from=web --chown=node:node /app/web/dist ./web/dist");
    expect(dockerfile).toContain("WEBAPP_DIR=/app/web/dist");
    // The bundle type-checks against the wire contract, so both files must be in that stage.
    expect(dockerfile).toContain("COPY src/webapp/contract.ts /app/src/webapp/contract.ts");
    expect(dockerfile).toContain("COPY src/core/types.ts /app/src/core/types.ts");
    // Nested node_modules and dist would otherwise be shipped into the build context.
    const ignore = readFileSync(".dockerignore", "utf8");
    expect(ignore).toContain("**/node_modules");
    expect(ignore).toContain("**/dist");
  });
  it("pins the mini app dependencies in its own lock file", () => {
    const manifest = JSON.parse(readFileSync("web/package.json", "utf8")) as
      { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const pinned = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const [name, version] of Object.entries(pinned)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pinned["@maxhub/max-ui"]).toBeDefined();
    const lock = JSON.parse(readFileSync("web/package-lock.json", "utf8")) as { lockfileVersion: number };
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(3);
  });
  it("loads MAX Bridge from the documented CDN and nowhere else", () => {
    const html = readFileSync("web/index.html", "utf8");
    expect(html).toContain('src="https://st.max.ru/js/max-web-app.js"');
    expect(html.match(/<script[^>]*src="http/g)).toHaveLength(1);
  });
});
