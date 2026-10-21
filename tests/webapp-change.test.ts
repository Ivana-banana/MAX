import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import { loadChanges } from "../src/bot/config.js";
import { changeCard, type DialogueContext } from "../src/bot/dialog.js";
import { Service } from "../src/bot/service.js";
import { webhookServer } from "../src/bot/server.js";
import { webappRouter } from "../src/webapp/router.js";
import { isAppAction } from "../src/webapp/state.js";
import type { AppResult, AppStateResponse } from "../src/webapp/contract.js";
import { testSchema } from "./pg.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const changes = loadChanges({ changesPath: "src/data/rules/ru-change.json", calendarPath: "src/data/calendar/ru.json", mode: "demo" }, texts, universities)!;
const ctx: DialogueContext = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-10-21", changes };
const NOW = Date.parse("2026-10-21T10:00:00+03:00");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

/** The mini app API over HTTP with an unsigned local launch, onboarded to a KFU plan (KZ, entry 01.09). */
async function app(context: DialogueContext) {
  const schema = await testSchema(); cleanups.push(schema.drop);
  const { store } = await schema.open(); cleanups.push(() => store.close());
  const service = new Service(store, context, { send() { return Promise.resolve(); } }, () => NOW);
  const server = webhookServer(service, "test-secret-that-is-long-enough-32",
    webappRouter(service, { token: "", dir: "./web/dist", devLaunch: true, devOrigin: "" }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { authorization: "MaxWebApp demo:7", "content-type": "application/json" };
  const act = async (action: string) => {
    const response = await fetch(`${url}/api/action`, { method: "POST", headers, body: JSON.stringify({ action }) });
    expect(response.status, action).toBe(200);
    return await response.json() as AppResult;
  };
  for (const action of ["/start", "ru", "accept", "yes", "KZ", "2026-09-01"]) await act(action);
  return { act, store, url, headers };
}

describe("«Изменились обстоятельства» in the mini app (#91)", () => {
  it("saves the event date into the one plan and shows the chat's card word for word", async () => {
    const f = await app(ctx);
    const ask = await f.act("change:moving");
    expect(ask.state.session!.step).toBe("changeDate");
    expect(ask.state.session!.prompt).toContain("день, когда вы заселились на новом месте");
    const saved = await f.act("2026-10-29");
    expect(saved.message).toContain("Дата сохранена.");
    expect((await f.store.get(7))!.changes).toEqual({ moving: "2026-10-29" });
    const session = saved.state.session!;
    expect(session.step).toBe("plan");
    const moving = session.changes.find(c => c.id === "moving")!;
    expect(moving).toMatchObject({ event: "2026-10-29", due: "2026-10-30", dated: true });
    expect(moving.line).toBe("Переезд — ваш срок по правилам КФУ: 30 октября 2026 г. (есть время, осталось 9 дней)");
    const chat = changeCard((await f.store.get(7))!, ctx, changes.situations.find(c => c.id === "moving")!).text;
    expect(chat.endsWith(moving.card)).toBe(true);
    expect(moving.card).toContain("(подаёт КФУ)");
    // A new passport asks no date and counts no deadline.
    expect(session.changes.find(c => c.id === "passport")).toMatchObject({ dated: false });
    expect(session.changes.find(c => c.id === "passport")!.due).toBeUndefined();
    // The same deadline goes into the app's calendar file.
    const ticket = await (await fetch(`${f.url}/api/calendar-ticket`, { method: "POST", headers: f.headers })).json() as { url: string };
    expect(await (await fetch(`${f.url}/${ticket.url}`)).text()).toContain("UID:change-moving-");
  });

  it("refuses a date before the entry, keeps the date step and accepts a retry", async () => {
    const f = await app(ctx);
    await f.act("change:trip");
    const wrong = await f.act("2026-08-31");
    expect(wrong.message).toContain("Нужна дата не раньше въезда");
    expect(wrong.state.session!.step).toBe("changeDate");
    const retry = await f.act("/yesterday");
    expect(retry.state.session!.changes.find(c => c.id === "trip")!.event).toBe("2026-10-20");
  });

  it("says /change is off in live mode with draft norms and saves nothing", async () => {
    const off: DialogueContext = { ...ctx };
    delete off.changes;
    const f = await app(off);
    const state = await (await fetch(`${f.url}/api/state`, { headers: f.headers })).json() as AppStateResponse;
    expect(state.state.session!.changes).toEqual([]);
    expect(state.state.session!.changeIntro).toContain("пока выключен");
    expect((await f.act("change:moving")).state.session!.step).toBe("plan");
    expect((await f.store.get(7))!.changes).toBeUndefined();
  });

  it("lets the app send the chat's change actions, not its commands", () => {
    for (const action of ["change:moving", "change-done:moving", "/yesterday"]) expect(isAppAction(action), action).toBe(true);
    for (const action of ["change", "/change", "changed:moving", "change:../x"]) expect(isAppAction(action), action).toBe(false);
  });
});
