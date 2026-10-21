import { afterEach, describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import { transition, type Reply, type Session } from "../src/bot/dialog.js";
import { planToIcs } from "../src/bot/calendar.js";
import { plan } from "../src/bot/dialog.js";
import { Service } from "../src/bot/service.js";
import { isAppAction, readState } from "../src/webapp/state.js";
import { testSchema } from "./pg.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };
const actions = (r: Reply) => r.buttons.flat().flatMap(b => "action" in b ? [b.action.split("|")[1]!] : []);

/** A chat with a plan (KZ, entry 01.09: medical examination due 30.09), clicked through as a student would. */
function planned() {
  let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
  let last!: Reply;
  const click = (action: string) => {
    const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);
    s = r.session!; last = r.reply; return r.reply;
  };
  const type = (text: string) => { const r = transition(s, { text, callback: false }, ctx); s = r.session!; last = r.reply; return r.reply; };
  for (const a of ["ru", "accept", "yes", "KZ"]) click(a);
  type("2026-09-01");
  return { click, type, get session() { return s; }, get reply() { return last; } };
}

describe("planning a visit in the chat", () => {
  it("offers the visit from the card and asks for the day, with today and tomorrow as buttons", () => {
    const f = planned();
    expect(actions(f.click("card:medical-examination"))).toContain("visit:medical-examination");
    const ask = f.click("visit:medical-examination");
    expect(f.session.step).toBe("visit");
    expect(ask.text).toContain("в какой день пойдёте");
    expect(actions(ask)).toEqual(expect.arrayContaining(["/today", "/tomorrow", "plan"]));
  });

  it("saves the day, shows it on the card and says what the bot will do the evening before", () => {
    const f = planned();
    f.click("card:medical-examination"); f.click("visit:medical-examination");
    const card = f.type("26.09.2026");
    expect(f.session.visits).toEqual({ "medical-examination": "2026-09-26" });
    expect(f.session.step).toBe("plan");
    expect(card.text).toContain("Визит: 26 сентября 2026 г.");
    expect(card.text).toContain("Включите напоминания");
    expect(card.buttons.flat().map(b => b.text)).toContain("🗓 Изменить день визита");
  });

  it("refuses a day in the past or more than a year ahead, keeping the question", () => {
    const f = planned();
    f.click("card:medical-examination"); f.click("visit:medical-examination");
    for (const day of ["2026-09-23", "2027-09-25", "31.02.2026"]) {
      expect(f.type(day).text).toContain("Нужна дата не раньше сегодняшней");
      expect(f.session.step).toBe("visit");
    }
  });

  it("warns, without refusing, when the visit is after the calculated deadline", () => {
    const f = planned();
    f.click("card:medical-examination"); f.click("visit:medical-examination");
    expect(f.type("2026-10-05").text).toContain("позже расчётного срока");
    expect(f.session.visits?.["medical-examination"]).toBe("2026-10-05");
  });

  it("reads the day buttons when pressed, not when shown: yesterday's \"Today\" and \"Tomorrow\" mean today and tomorrow", () => {
    const nextDay = { ...ctx, today: "2026-09-25" };
    for (const [button, expected] of [["/today", "2026-09-25"], ["/tomorrow", "2026-09-26"]] as const) {
      const f = planned();
      f.click("card:medical-examination");
      const shown = f.click("visit:medical-examination");
      expect(actions(shown)).toContain(button);
      const s = f.session;
      const r = transition(s, { text: `${s.nonce}.${s.revision}|${button}`, callback: true }, nextDay);
      expect(r.session!.visits).toEqual({ "medical-examination": expected });
    }
  });

  it("marks a procedure done on the day of the press, not of the shown button", () => {
    const f = planned();
    f.click("card:medical-examination");
    const shown = f.click("done:medical-examination");
    expect(actions(shown)).toContain("/today");
    const s = f.session;
    const r = transition(s, { text: `${s.nonce}.${s.revision}|/today`, callback: true }, { ...ctx, today: "2026-09-25" });
    expect(r.session!.completions).toEqual({ "medical-examination": "2026-09-25" });
  });

  it("keeps the day buttons working after a refused day or date (#109)", () => {
    for (const [ask, answer, wrong, field] of [
      ["visit:medical-examination", "/tomorrow", "2026-09-23", "visits"],
      ["done:medical-examination", "/today", "01.01.2020", "completions"],
    ] as const) {
      const f = planned();
      f.click("card:medical-examination"); f.click(ask);
      const refused = f.type(wrong);
      expect(actions(refused)).toContain(answer);
      expect(actions(refused)).toContain("plan");
      // The button of the refusal itself: its stamp is the one the session expects now.
      const pressed = refused.buttons.flat().find(b => "action" in b && b.action.endsWith(`|${answer}`))!;
      const r = transition(f.session, { text: "action" in pressed ? pressed.action : "", callback: true }, ctx);
      expect(r.expired).toBeUndefined();
      expect(r.session![field]).toEqual({ "medical-examination": answer === "/today" ? "2026-09-24" : "2026-09-25" });
    }
  });

  it("does not offer a visit for a procedure already marked as done", () => {
    const f = planned();
    f.click("card:fingerprinting"); f.click("done:fingerprinting"); f.type("/today");
    expect(actions(f.click("card:fingerprinting"))).not.toContain("visit:fingerprinting");
  });
});

describe("the visit in the calendar file", () => {
  it("adds the visit day as its own event with an alarm the evening before, and updates it when moved", () => {
    const f = planned();
    f.click("card:medical-examination"); f.click("visit:medical-examination"); f.type("2026-09-26");
    const ics = (visits: Record<string, string>, sequence: number) => planToIcs(plan(f.session, ctx),
      { lang: "ru", texts, demo: false, uid: "u1", today: ctx.today, sequence, visits }).replace(/\r\n /g, "");
    const first = ics(f.session.visits!, 1);
    expect(first).toContain("UID:medical-examination-visit-u1@max-first-90-days");
    expect(first).toContain("DTSTART;VALUE=DATE:20260926");
    expect(first).toContain("SUMMARY:Визит: Медицинское освидетельствование");
    expect(first).toContain("TRIGGER;VALUE=DATE-TIME:20260925T150000Z");
    const moved = ics({ "medical-examination": "2026-09-29" }, 2);
    expect(moved).toContain("DTSTART;VALUE=DATE:20260929");
    expect(moved).toContain("SEQUENCE:2");
    expect(ics({}, 3)).not.toContain("-visit-");
  });
});

describe("the evening before the visit", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

  async function fixture() {
    const schema = await testSchema(); cleanups.push(schema.drop);
    const { store } = await schema.open(); cleanups.push(() => store.close());
    let now = Date.parse("2026-09-24T10:00:00+03:00");
    const sent: Reply[] = [];
    const service = new Service(store, ctx, { send(_user, reply) { sent.push(reply); return Promise.resolve(); } }, () => now);
    let n = 0;
    const input = (text: string, callback = false) => service.receive({ id: String(++n), user: 1, input: { text, callback } });
    const click = async (action: string) => { const s = (await store.get(1))!; await input(`${s.nonce}.${s.revision}|${action}`, true); };
    for (const a of ["/start"]) await input(a);
    for (const a of ["ru", "accept", "yes", "KZ"]) await click(a);
    await input("2026-09-01");
    return { store, service, sent, input, click, at: (iso: string) => { now = Date.parse(iso); } };
  }
  const visitReminders = (sent: Reply[]) => sent.filter(r => r.text.includes("Завтра"));

  it("sends at 18:00 Moscow time the day before, listing the documents still unchecked", async () => {
    const f = await fixture();
    await f.click("reminders");
    await f.click("card:medical-examination"); await f.click("doc:medical-examination:passport");
    await f.click("visit:medical-examination"); await f.input("26.09.2026");
    await f.service.flush();
    f.at("2026-09-25T17:59:00+03:00"); await f.service.flush();
    expect(visitReminders(f.sent)).toHaveLength(0);
    f.at("2026-09-25T18:00:00+03:00"); await f.service.flush();
    const [evening] = visitReminders(f.sent);
    expect(evening?.text).toContain("Завтра — Медицинское освидетельствование");
    expect(evening?.text).toContain("□ Нотариальный перевод паспорта");
    expect(evening?.text).not.toContain("□ Паспорт\n");
    expect(evening?.buttons.flat().some(b => "action" in b && b.action.endsWith("|card:medical-examination"))).toBe(true);
  });

  it("says everything is ready once all documents are checked", async () => {
    const f = await fixture();
    await f.click("reminders");
    await f.click("card:fingerprinting");
    await f.click("doc:fingerprinting:passport"); await f.click("doc:fingerprinting:passport-translation");
    await f.click("visit:fingerprinting"); await f.input("2026-09-26");
    f.at("2026-09-25T18:00:00+03:00"); await f.service.flush();
    expect(visitReminders(f.sent).at(-1)?.text).toContain("Все документы из списка отмечены");
  });

  it("shows the mini app the same visit day, and lets it plan one", async () => {
    expect(isAppAction("visit:medical-examination")).toBe(true);
    const f = await fixture();
    await f.click("card:medical-examination"); await f.click("visit:medical-examination"); await f.input("2026-09-26");
    const item = (await readState(f.service, 1, false)).session?.plan.find(i => i.ruleId === "medical-examination");
    expect(item?.visit).toBe("2026-09-26");
  });

  it("stays silent when reminders are off, the procedure is marked done or the visit moved", async () => {
    const off = await fixture();
    await off.click("card:medical-examination"); await off.click("visit:medical-examination"); await off.input("2026-09-26");
    off.at("2026-09-25T18:00:00+03:00"); await off.service.flush();
    expect(visitReminders(off.sent)).toHaveLength(0);

    const done = await fixture();
    await done.click("reminders");
    await done.click("card:fingerprinting"); await done.click("visit:fingerprinting"); await done.input("2026-09-26");
    await done.click("done:fingerprinting"); await done.input("/today");
    done.at("2026-09-25T18:00:00+03:00"); await done.service.flush();
    expect(visitReminders(done.sent)).toHaveLength(0);

    const moved = await fixture();
    await moved.click("reminders");
    await moved.click("card:fingerprinting"); await moved.click("visit:fingerprinting"); await moved.input("2026-09-26");
    await moved.click("visit:fingerprinting"); await moved.input("2026-09-29");
    moved.at("2026-09-25T18:00:00+03:00"); await moved.service.flush();
    expect(visitReminders(moved.sent)).toHaveLength(0);
    moved.at("2026-09-28T18:00:00+03:00"); await moved.service.flush();
    expect(visitReminders(moved.sent)).toHaveLength(1);
  });
});
