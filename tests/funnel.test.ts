import { afterEach, describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import type { Reply } from "../src/bot/dialog.js";
import { Store } from "../src/bot/store.js";
import { Service } from "../src/bot/service.js";
import { funnelReport, type FunnelCount } from "../src/bot/funnel.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
function fixture() {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  let now = Date.parse("2026-09-23T10:00:00+03:00");
  const sent: Reply[] = [];
  const service = new Service(store, { rules: rules.rules, universities, texts, version: rules.version, demo: true },
    { async send(_user, reply) { sent.push(reply); } }, () => now);
  let n = 0;
  const input = (text: string, user = 1, callback = false) => service.receive({ id: String(++n), user, input: { text, callback } });
  const click = (action: string, user = 1) => { const s = store.get(user)!; input(`${s.nonce}.${s.revision}|${action}`, user, true); };
  const onboard = (user = 1, start = "/start") => {
    input(start, user); for (const a of ["ru", "accept", "yes", "KZ"]) click(a, user); input("2026-09-01", user);
  };
  const totals = () => Object.fromEntries(store.funnel().map(r => [`${r.university}:${r.event}`, r.n]));
  return { store, service, sent, input, click, onboard, totals, time: (d: string) => { now = Date.parse(d); } };
}

describe("anonymous funnel counters", () => {
  it("counts each step of the reminder metric once, per university and day", async () => {
    const f = fixture();
    f.onboard(1); f.onboard(2, "/start itmo"); f.click("reminders", 1);
    await f.service.flush();
    const reminder = f.sent.find(r => r.text.includes("Напоминание:"))!;
    const details = reminder.buttons.flat().find(b => "action" in b && b.action.endsWith("|card:medical-examination:reminder")) as { action: string };
    f.click("card:fingerprinting", 1);
    f.input(details.action, 1, true);
    await f.service.flush();
    expect(f.sent.at(-1)!.text).toContain("Расчётный предельный срок: 2026-09-30");
    for (const doc of ["passport", "passport-translation", "migration-card", "arrival-notification"]) f.click(`doc:medical-examination:${doc}`, 1);
    f.click("done:medical-examination", 1); f.input("/today", 1);
    f.click("help:fingerprinting", 2);
    expect(f.totals()).toEqual({ "kfu:started": 1, "kfu:plan_ready": 1, "kfu:reminders_on": 1, "kfu:reminder_sent": 1, "kfu:reminder_opened": 1,
      "kfu:checklist_completed": 1, "kfu:marked_done": 1, "itmo:started": 1, "itmo:plan_ready": 1, "itmo:help_opened": 1 });
    expect(new Set(f.store.funnel().map(r => r.day))).toEqual(new Set(["2026-09-23"]));
  });
  it("keeps no user id, survives /delete and counts the deletion itself", () => {
    const f = fixture(); f.onboard();
    f.input("/delete"); f.click("confirm-delete");
    expect(f.store.get(1)).toBeNull();
    expect(f.totals()).toMatchObject({ "kfu:started": 1, "kfu:plan_ready": 1, "kfu:deleted": 1 });
    const columns = (f.store.db.prepare("PRAGMA table_info(funnel)").all() as { name: string }[]).map(c => c.name);
    expect(columns).toEqual(["day", "university", "event", "n"]);
  });
  it("does not count repeated screens as progress", () => {
    const f = fixture(); f.onboard();
    f.input("/plan"); f.click("card:medical-examination"); f.input("/start");
    expect(f.totals()).toEqual({ "kfu:started": 1, "kfu:plan_ready": 1 });
  });
  it("drops counters older than the profile retention period", () => {
    const f = fixture(); f.onboard();
    f.time("2027-11-01T10:00:00+03:00"); f.service.maintain();
    expect(f.store.funnel()).toEqual([]);
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
