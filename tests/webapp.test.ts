import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import { readConfig } from "../src/bot/config.js";
import type { Reply } from "../src/bot/dialog.js";
import { Service } from "../src/bot/service.js";
import { webhookServer } from "../src/bot/server.js";
import { verifyLaunch, LaunchError } from "../src/webapp/initData.js";
import { applyAction, isAppAction, readState, RevisionConflict } from "../src/webapp/state.js";
import { webappRouter } from "../src/webapp/router.js";
import { testSchema } from "./pg.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };
const NOW = Date.parse("2026-09-24T10:00:00+03:00");
const TOKEN = "test-token-not-a-real-one"; // secret-scan: allow — fixture, not a credential
const TICKET_KEY = "ticket-key-for-tests"; // secret-scan: allow — fixture, not a credential
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

/** Builds startup data the way MAX does (https://dev.max.ru/docs/webapps/validation). */
function launch(fields: Record<string, string>, token = TOKEN): string {
  const entries = Object.entries(fields).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(entries.map(([k, v]) => `${k}=${v}`).join("\n")).digest("hex");
  return [...entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`), `hash=${hash}`].join("&");
}
const person = (id = 7, language = "ru-RU") =>
  JSON.stringify({ id, first_name: "Max", last_name: "User", username: null, language_code: language, photo_url: null });
const genuine = (extra: Record<string, string> = {}, at = NOW, token = TOKEN) => launch({
  auth_date: String(Math.floor(at / 1000)), query_id: "4c0ab423-342b-4e45-aea4-2747dbc500cd",
  chat: JSON.stringify({ id: 12345, type: "DIALOG" }), user: person(), ...extra,
}, token);

async function fixture(dir = "./web/dist", devLaunch = true) {
  const schema = await testSchema();
  cleanups.push(schema.drop);
  const { store, pool } = await schema.open();
  cleanups.push(() => store.close());
  const sent: { user: number; reply: Reply }[] = [];
  const service = new Service(store, ctx, { async send(u, reply) { sent.push({ user: u, reply }); } }, () => NOW);
  const router = webappRouter(service, { token: TOKEN, dir, devLaunch, devOrigin: "" });
  return { store, pool, service, sent, router };
}

async function serve(router: ReturnType<typeof webappRouter>, service: Service) {
  const server = webhookServer(service, "test-secret-that-is-long-enough-32", router);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  });
  return `http://127.0.0.1:${port}`;
}
const auth = (value: string) => ({ authorization: `MaxWebApp ${value}` });
const act = (url: string, value: string, body: object) => fetch(`${url}/api/action`,
  { method: "POST", headers: { ...auth(value), "content-type": "application/json" }, body: JSON.stringify(body) });
const ONBOARDING = ["/start", "ru", "accept", "yes", "KZ", "2026-09-01"];

describe("mini app startup data", () => {
  it("accepts a genuine launch and returns only the signed facts", () => {
    const result = verifyLaunch(genuine({ start_param: "itmo" }), TOKEN, NOW);
    expect(result).toEqual({ userId: 7, authDate: Math.floor(NOW / 1000), languageCode: "ru-RU", startParam: "itmo" });
  });
  it("rejects a tampered payload, another bot's token and a broken envelope", () => {
    const reason = (data: string, token = TOKEN) => {
      try { verifyLaunch(data, token, NOW); return "accepted"; }
      catch (e) { return e instanceof LaunchError ? e.reason : "other"; }
    };
    const valid = genuine();
    // Same signature, different user: the classic forgery the signature exists to stop.
    expect(reason(valid.replace(encodeURIComponent(person()), encodeURIComponent(person(8))))).toBe("bad_signature");
    expect(reason(valid, "another-bot-token")).toBe("bad_signature");
    expect(reason(valid.replace(/&hash=.*/, ""))).toBe("no_hash");
    expect(reason(valid + "&hash=00")).toBe("duplicate_key");
    expect(reason("auth_date")).toBe("malformed");
    expect(reason("=x&hash=00")).toBe("malformed");
    expect(reason("x".repeat(5000))).toBe("too_large");
    expect(reason("")).toBe("too_large");
    expect(reason(launch({ auth_date: String(Math.floor(NOW / 1000)), user: "not json" }))).toBe("no_user");
    expect(reason(launch({ auth_date: String(Math.floor(NOW / 1000)), user: JSON.stringify({ id: 0 }) }))).toBe("no_user");
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
  it("walks the same scenario as the chat and computes the same plan", async () => {
    const f = await fixture();
    expect((await readState(f.service, 7, false)).session).toBeNull();
    for (const action of ["/start kfu", ...ONBOARDING.slice(1)]) await applyAction(f.service, 7, action, false);
    const state = await readState(f.service, 7, false);
    expect(state.session?.step).toBe("plan");
    expect(state.session?.university).toEqual({ id: "kfu", name: "КФУ", contactUrl: expect.stringContaining("kpfu.ru") });
    expect(state.session?.plan.map(i => [i.ruleId, i.dueDate]))
      .toEqual([["medical-examination", "2026-09-30"], ["fingerprinting", "2026-11-29"]]);
    // The legal basis travels with every item: a screen must never show a date without its source.
    expect(state.session?.plan[0]?.provisional).toBe(true);
    expect(state.session?.plan[0]?.legal.url).toContain("consultant.ru");
    expect(state.demo).toBe(true);
  });
  it("takes every text from src/data/i18n instead of a dictionary of its own", async () => {
    const f = await fixture();
    for (const action of ONBOARDING) await applyAction(f.service, 7, action, false);
    const ru = await readState(f.service, 7, false);
    expect(ru.texts["app.title"]).toBe("Первые 90 дней");
    expect(ru.texts["btn.done"]).toBeDefined();
    // Plural forms need a number, so the server renders the countdown itself.
    expect(Object.keys(ru.texts).some(key => key.includes("#"))).toBe(false);
    expect(ru.session?.plan[0]?.countdown).toContain("дн");
    expect(ru.languages).toEqual(expect.arrayContaining([{ code: "ru", name: "Русский" }]));

    const english = await fixture();
    for (const action of ["/start", "en", "accept", "yes", "KZ", "2026-09-01"]) {
      await applyAction(english.service, 7, action, false);
    }
    const en = await readState(english.service, 7, false);
    expect(en.texts["app.title"]).toBe("First 90 days");
    expect(en.session?.plan[0]?.title).not.toBe(ru.session?.plan[0]?.title);
  });
  it("refuses an action built on a revision someone else has already moved past", async () => {
    const f = await fixture();
    await applyAction(f.service, 7, "/start", false);
    const revision = (await readState(f.service, 7, false)).session!.revision;
    await expect(applyAction(f.service, 7, "ru", false, revision - 1)).rejects.toThrow(RevisionConflict);
    expect((await readState(f.service, 7, false)).session?.step).toBe("language");
    await applyAction(f.service, 7, "ru", false, revision);
    expect((await readState(f.service, 7, false)).session?.step).toBe("consent");
  });
  it("keeps chat-only branches out of the app's vocabulary", () => {
    for (const action of ["/start", "/start kfu", "ru", "en", "accept", "yes", "KZ", "OTHER", "2026-09-01", "/today",
      "plan", "reminders", "doc:medical-examination:passport", "done:fingerprinting", "/delete", "confirm-delete",
      "cancel-delete", "help:fingerprinting"]) expect(isAppAction(action), action).toBe(true);
    for (const action of ["/stop", "calendar", "help", "/help", "help:", "help:../x", "card:fingerprinting",
      "/start ../etc", "doc:x", "done:", "reminders ", "2026-02-30", ""]) expect(isAppAction(action), action).toBe(false);
  });
  it("gives the card the chat's ready question to the university, and changes nothing", async () => {
    const f = await fixture();
    for (const action of ONBOARDING) await applyAction(f.service, 7, action, false);
    const before = await readState(f.service, 7, false);
    const result = await applyAction(f.service, 7, "help:medical-examination", false);
    // The same text the chat puts behind its "Copy" button: the app never words a request itself.
    expect(result.copy).toContain("КФУ");
    expect(result.message).toContain(result.copy!);
    expect(result.state.session?.step).toBe("plan");
    expect(result.state.session?.plan).toEqual(before.session?.plan);
    // An ordinary action carries no question.
    expect((await applyAction(f.service, 7, "plan", false)).copy).toBeUndefined();
  });
  it("drops chat messages that the app's change would have made stale", async () => {
    const f = await fixture();
    await f.service.receive({ id: "a", user: 7, input: { text: "/start", callback: false } });
    expect((await f.store.counts()).pending).toBe(1);
    await applyAction(f.service, 7, "ru", false);
    expect((await f.store.counts()).pending ?? 0).toBe(0);
  });
  it("counts the same anonymous funnel events the chat counts", async () => {
    const f = await fixture();
    for (const action of ONBOARDING) await applyAction(f.service, 7, action, false);
    const rows = await f.store.funnel();
    const events = rows.filter(r => r.n > 0).map(r => r.event);
    expect(events).toContain("started");
    expect(events).toContain("plan_ready");
    expect(rows.every(r => r.university === "kfu")).toBe(true);
  });
  it("schedules the chat reminders the switch turns on", async () => {
    const f = await fixture();
    for (const action of ONBOARDING) await applyAction(f.service, 7, action, false);
    expect((await f.store.counts()).pending ?? 0).toBe(0);
    await applyAction(f.service, 7, "reminders", false);
    expect((await readState(f.service, 7, false)).session?.reminders).toBe(true);
    expect((await f.store.counts()).pending ?? 0).toBeGreaterThan(0);
  });
});

describe("mini app shows what the chat shows", () => {
  it("brings the step's own wording, without a second demo banner", async () => {
    const f = await fixture();
    await f.service.receive({ id: "1", user: 7, input: { text: "/start", callback: false, locale: "ru-RU" } });
    const opened = await readState(f.service, 7, false);
    expect(opened.session?.step).toBe("consent");
    expect(opened.session?.prompt).toContain("MAX ID");
    const accepted = await applyAction(f.service, 7, "accept", false);
    expect(accepted.message.startsWith(texts.get("ru")!["banner.demo"]!)).toBe(false);
    expect(accepted.state.session?.prompt.startsWith(texts.get("ru")!["banner.demo"]!)).toBe(false);
  });
  it("stops a plan built on rules that have changed since, as the chat does", async () => {
    const f = await fixture();
    const old = new Service(f.store, { ...ctx, version: "old-version" }, { async send() {} }, () => NOW);
    for (const action of ONBOARDING) await applyAction(old, 7, action, false);
    const state = await readState(f.service, 7, false);
    expect(state.session?.stale).toBe(true);
    expect(state.session?.plan).toEqual([]);
    const url = await serve(f.router, f.service);
    const issued = await (await fetch(`${url}/api/calendar-ticket`, { method: "POST", headers: auth(genuine()) })).json() as { url: string };
    expect((await fetch(`${url}/${issued.url}`)).status).toBe(404);
  });
  it("says where each checklist comes from, or that there is no official one", async () => {
    const f = await fixture();
    for (const action of ONBOARDING) await applyAction(f.service, 7, action, false);
    const items = (await readState(f.service, 7, false)).session!.plan;
    expect(items.find(i => i.ruleId === "medical-examination")?.documentsNote).toContain("Комплект — по странице https://");
    expect(items.find(i => i.ruleId === "fingerprinting")?.documentsNote).toContain("Официальный перечень документов не опубликован");
  });
  it("offers the citizenships the rules exclude, which lead to help as in the chat", async () => {
    const f = await fixture();
    for (const action of ONBOARDING.slice(0, 4)) await applyAction(f.service, 7, action, false);
    expect((await readState(f.service, 7, false)).session?.citizenships).toContain("BY");
    const other = await applyAction(f.service, 7, "BY", false);
    expect(other.copy).toContain("Я учусь в");
  });
  it("starts in the MAX interface language, as the chat does", async () => {
    const f = await fixture();
    const url = await serve(f.router, f.service);
    const value = genuine({ user: person(7, "en-US") });
    const first = await (await fetch(`${url}/api/state`, { headers: auth(value) })).json() as { state: { texts: Record<string, string> } };
    expect(first.state.texts["app.start.action"]).toBe(texts.get("en")!["app.start.action"]);
    const started = await (await act(url, value, { action: "/start" })).json() as { state: { session: { step: string; lang: string } } };
    expect(started.state.session).toMatchObject({ step: "consent", lang: "en" });
  });
  it("takes the first entry date of the app screens from the rules", async () => {
    const f = await fixture();
    const shifted = parseRuleSet(JSON.parse(JSON.stringify(raw).replaceAll("2026-09-01", "2027-09-01")));
    const later = new Service(f.store, { ...ctx, rules: shifted.rules }, { async send() {} }, () => NOW);
    const table = (await readState(later, 7, false)).texts;
    expect(table["app.entry.body"]).toContain("01.09.2027");
    expect(table["app.entry.invalid"]).toContain("01.09.2027");
    // Chat texts keep their placeholder: the app matches server messages against the fixed part.
    expect(table["entry.invalid"]).toContain("{from}");
  });
});

describe("mini app HTTP surface", () => {
  it("answers only with a verified launch, and never says which check failed", async () => {
    const f = await fixture();
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
    const f = await fixture();
    const url = await serve(f.router, f.service);
    const value = genuine({ start_param: "itmo" });
    const first = await (await fetch(`${url}/api/state`, { headers: auth(value) })).json() as
      { state: { session: null }; launch: { startParam?: string; languageCode?: string } };
    expect(first.state.session).toBeNull();
    expect(first.launch).toEqual({ startParam: "itmo", languageCode: "ru-RU" });

    let revision = 0;
    for (const action of ["/start itmo", ...ONBOARDING.slice(1)]) {
      const response = await act(url, value, { action, revision });
      expect(response.status, action).toBe(200);
      const body = await response.json() as { state: { session: { revision: number } }; message: string };
      expect(body.message.length).toBeGreaterThan(0);
      revision = body.state.session.revision;
    }
    const state = await (await fetch(`${url}/api/state`, { headers: auth(value) })).json() as
      { state: { session: { step: string; university: { id: string }; plan: unknown[] } } };
    expect(state.state.session.step).toBe("plan");
    expect(state.state.session.university.id).toBe("itmo");
    expect(state.state.session.plan).toHaveLength(2);
  });
  it("rejects bad bodies, unsupported actions and a stale revision", async () => {
    const f = await fixture();
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
    const f = await fixture();
    const url = await serve(f.router, f.service);
    const value = genuine();
    expect((await fetch(`${url}/api/calendar.ics`, { headers: auth(value) })).status).toBe(404);
    for (const action of ONBOARDING) await act(url, value, { action });
    const ics = await fetch(`${url}/api/calendar.ics`, { headers: auth(value) });
    expect(ics.headers.get("content-disposition")).toContain("first-90-days.ics");
    expect((await ics.text()).match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });
  it("hands out a short-lived download ticket, because a download carries no header", async () => {
    const f = await fixture();
    const url = await serve(f.router, f.service);
    const value = genuine();
    for (const action of ONBOARDING) await act(url, value, { action });
    const issued = await fetch(`${url}/api/calendar-ticket`, { method: "POST", headers: auth(value) });
    expect(issued.status).toBe(200);
    const ticket = await issued.json() as { url: string; fileName: string; expiresIn: number };
    expect(ticket.fileName).toBe("first-90-days.ics");
    const downloaded = await fetch(`${url}/${ticket.url}`);
    expect(downloaded.status).toBe(200);
    expect((await downloaded.text()).match(/BEGIN:VEVENT/g)).toHaveLength(2);
    // A ticket for somebody else, or with the signature edited, opens nothing.
    expect((await fetch(`${url}/api/calendar.ics?ticket=8.9999999999.${"0".repeat(64)}`)).status).toBe(401);
    expect((await fetch(`${url}/${ticket.url.replace(/.$/, (last) => (last === "0" ? "1" : "0"))}`)).status).toBe(401);
    expect((await fetch(`${url}/api/calendar-ticket`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${url}/api/calendar-ticket`, { headers: auth(value) })).status).toBe(405);
    // The signing key never leaves the process: a secret known outside it (the webhook one, which
    // MAX holds too) cannot mint a ticket for another user.
    const expires = Math.floor(NOW / 1000) + 60;
    const forged = `7.${expires}.${createHmac("sha256", TICKET_KEY).update(`calendar:7:${expires}`).digest("hex")}`;
    expect((await fetch(`${url}/api/calendar.ics?ticket=${forged}`)).status).toBe(401);
  });
  it("accepts an unsigned demo launch only where the config allows one", async () => {
    const open = await fixture();
    const openUrl = await serve(open.router, open.service);
    expect((await fetch(`${openUrl}/api/state`, { headers: auth("demo:42") })).status).toBe(200);
    const closed = await fixture("./web/dist", false);
    const closedUrl = await serve(closed.router, closed.service);
    expect((await fetch(`${closedUrl}/api/state`, { headers: auth("demo:42") })).status).toBe(401);
  });
  it("refuses a dev origin outside the local console demo", () => {
    const env = {
      WEBHOOK_SECRET: "a".repeat(32), DATABASE_URL: "postgres://localhost/x",
      WEBAPP_DEV_ORIGIN: "http://localhost:5173",
    };
    expect(readConfig(env).webappDevOrigin).toBe("http://localhost:5173");
    expect(() => readConfig({ ...env, TRANSPORT: "max", MAX_BOT_TOKEN: "t" })).toThrow(/WEBAPP_DEV_ORIGIN/);
    expect(() => readConfig({ ...env, WEBAPP_DEV_ORIGIN: "http://localhost:5173/app" })).toThrow(/bare origin/);
    expect(readConfig({ WEBHOOK_SECRET: "a".repeat(32), DATABASE_URL: "postgres://localhost/x" }).webappDir)
      .toBe("./web/dist");
  });
  it("serves the built bundle and refuses to leave its directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webapp-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>app</title>");
    writeFileSync(join(dir, "app-C5bBlBUA.js"), "export const ok = 1;");
    writeFileSync(join(dir, "notes.md"), "not part of the bundle");
    const f = await fixture(dir);
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
  // Root reads any file, so an unreadable one cannot be staged there.
  it.skipIf(process.getuid?.() === 0)("survives a bundle file that fails to open after the headers went out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webapp-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>app</title>");
    writeFileSync(join(dir, "locked-ABCDEFGH.js"), "export const ok = 1;");
    chmodSync(join(dir, "locked-ABCDEFGH.js"), 0o000);
    const f = await fixture(dir);
    const url = await serve(f.router, f.service);
    const crashes: unknown[] = [];
    const record = (e: unknown) => { crashes.push(e); };
    process.on("unhandledRejection", record);
    cleanups.push(async () => { process.off("unhandledRejection", record); });
    await fetch(`${url}/locked-ABCDEFGH.js`).then(r => r.text()).catch(() => "");
    await new Promise(done => setTimeout(done, 50));
    expect(crashes).toEqual([]);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
  it("closes the file when a client drops a download halfway", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webapp-"));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "big-ABCDEFGH.js"), "x".repeat(4_000_000));
    const f = await fixture(dir);
    const pending = new Set<Promise<boolean>>();
    const tracked: typeof f.router = (req, res) => {
      const handled = f.router(req, res);
      pending.add(handled);
      void handled.finally(() => pending.delete(handled)).catch(() => {});
      return handled;
    };
    const url = new URL(await serve(tracked, f.service));
    const socket = connect(Number(url.port), url.hostname);
    socket.write(`GET /big-ABCDEFGH.js HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`);
    await once(socket, "data");
    socket.destroy();
    for (let n = 0; n < 50 && pending.size > 0; n++) await new Promise(done => setTimeout(done, 20));
    expect(pending.size).toBe(0);
  });
  it("answers 404 for the app while no bundle has been built", async () => {
    const f = await fixture(join(tmpdir(), "webapp-missing-on-purpose"));
    const url = await serve(f.router, f.service);
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(`${url}/api/state`, { headers: auth(genuine()) })).status).toBe(200);
  });
  it("lets the chat and the app act on one session in turn", async () => {
    const f = await fixture();
    const url = await serve(f.router, f.service);
    const value = genuine();
    await f.service.receive({ id: "1", user: 7, input: { text: "/start", callback: false } });
    for (const action of ONBOARDING.slice(1)) {
      const session = (await f.store.get(7))!;
      await f.service.receive({
        id: action, user: 7,
        input: { text: `${session.nonce}.${session.revision}|${action}`, callback: true },
      });
    }
    const toggled = await act(url, value, { action: "doc:medical-examination:passport" });
    expect(toggled.status).toBe(200);
    expect((await f.store.get(7))?.documents["medical-examination:2026-09-30:passport"]).toBe(true);
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
