import { afterEach, describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import type { Reply } from "../src/bot/dialog.js";
import { Service } from "../src/bot/service.js";
import { funnelReport, type FunnelCount } from "../src/bot/funnel.js";
import { testSchema } from "./pg.js";
import { plain } from "../src/core/markup.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function fixture() {
  const schema = await testSchema(); cleanups.push(schema.drop);
  const { store, pool } = await schema.open();
  cleanups.push(() => store.close());
  let now = Date.parse("2026-09-23T10:00:00+03:00");
  const sent: Reply[] = [];
  const service = new Service(store, { rules: rules.rules, universities, texts, version: rules.version, demo: true },
    { send(_user, reply) { sent.push(reply); return Promise.resolve(); } }, () => now);
  let n = 0;
  const input = (text: string, user = 1, callback = false) => service.receive({ id: String(++n), user, input: { text, callback } });
  const click = async (action: string, user = 1) => {
    const s = (await store.get(user))!; await input(`${s.nonce}.${s.revision}|${action}`, user, true);
  };
  const onboard = async (user = 1, start = "/start") => {
    await input(start, user); for (const a of ["ru", "accept", "yes", "KZ"]) await click(a, user); await input("2026-09-01", user);
  };
  const totals = async () => Object.fromEntries((await store.funnel()).map(r => [`${r.university}:${r.event}`, r.n]));
  return { store, pool, service, sent, input, click, onboard, totals, time: (d: string) => { now = Date.parse(d); } };
}

describe("anonymous funnel counters", () => {
  it("counts each step of the reminder metric once, per university and day", async () => {
    const f = await fixture();
    await f.onboard(1); await f.onboard(2, "/start itmo"); await f.click("reminders", 1);
    await f.service.flush();
    const reminder = f.sent.find(r => r.text.includes("Напоминание:"))!;
    const details = reminder.buttons.flat().find(b => "action" in b && b.action.endsWith("|card:medical-examination:reminder")) as { action: string };
    await f.click("card:fingerprinting", 1);
    await f.input(details.action, 1, true);
    await f.service.flush();
    expect(plain(f.sent.at(-1)!.text)).toContain("Расчётный предельный срок: 30 сентября 2026 г.");
    for (const doc of ["passport", "passport-translation", "arrival-notification", "previous-results"]) await f.click(`doc:medical-examination:${doc}`, 1);
    await f.click("done:medical-examination", 1); await f.input("/today", 1);
    await f.click("help:fingerprinting", 2);
    expect(await f.totals()).toEqual({ "kfu:started": 1, "kfu:plan_ready": 1, "kfu:reminders_on": 1, "kfu:reminder_sent": 1, "kfu:reminder_opened": 1,
      "kfu:checklist_completed": 1, "kfu:marked_done": 1, "itmo:started": 1, "itmo:plan_ready": 1, "itmo:help_opened": 1 });
    expect(new Set((await f.store.funnel()).map(r => r.day))).toEqual(new Set(["2026-09-23"]));
  });
  it("keeps no user id, survives /delete and counts the deletion itself", async () => {
    const f = await fixture(); await f.onboard();
    await f.input("/delete"); await f.click("confirm-delete");
    expect(await f.store.get(1)).toBeNull();
    expect(await f.totals()).toMatchObject({ "kfu:started": 1, "kfu:plan_ready": 1, "kfu:deleted": 1 });
    const columns = (await f.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'funnel' ORDER BY ordinal_position",
    )).rows.map(c => c.column_name);
    expect(columns).toEqual(["day", "university", "event", "n"]);
  });
  it("does not count repeated screens as progress", async () => {
    const f = await fixture(); await f.onboard();
    await f.input("/plan"); await f.click("card:medical-examination"); await f.input("/start");
    expect(await f.totals()).toEqual({ "kfu:started": 1, "kfu:plan_ready": 1 });
  });
  it("counts opening the before-entry cards (#25)", async () => {
    const f = await fixture();
    await f.input("/start"); for (const a of ["ru", "accept", "yes", "KZ", "before-entry"]) await f.click(a);
    expect(await f.totals()).toEqual({ "kfu:started": 1, "kfu:before_entry_opened": 1 });
  });
  it("drops counters older than the profile retention period", async () => {
    const f = await fixture(); await f.onboard();
    f.time("2027-11-01T10:00:00+03:00"); await f.service.maintain();
    expect(await f.store.funnel()).toEqual([]);
  });
  it("reports totals and conversion without claiming they are people", () => {
    const rows: FunnelCount[] = [
      { day: "2026-09-23", university: "kfu", event: "started", n: 4 }, { day: "2026-09-24", university: "kfu", event: "plan_ready", n: 3 },
      { day: "2026-09-24", university: "kfu", event: "reminder_sent", n: 2 }, { day: "2026-09-24", university: "kfu", event: "reminder_opened", n: 1 }];
    const report = funnelReport(rows);
    expect(report).toContain("за 2026-09-23 — 2026-09-24");
    expect(report).toContain("дошли до плана из начавших:          75%");
    expect(report).toContain("открыли напоминание из отправленных: 50%");
    expect(report).toContain("суммы событий, а не люди");
    expect(funnelReport([])).toContain("Счётчиков пока нет");
  });
});

describe("funnel and expired buttons", () => {
  it("counts no return from a reminder whose button the dialogue refused", async () => {
    const f = await fixture();
    await f.onboard(1);
    const old = (await f.store.get(1))!;
    await f.click("delete"); await f.click("confirm-delete");
    await f.onboard(1);
    await f.input(`${old.nonce}.${old.revision}|card:medical-examination:reminder`, 1, true);
    await f.input(`${old.nonce}.${old.revision}|help:medical-examination`, 1, true);
    const totals = await f.totals();
    expect(totals["kfu:reminder_opened"]).toBeUndefined();
    expect(totals["kfu:help_opened"]).toBeUndefined();
  });
});
