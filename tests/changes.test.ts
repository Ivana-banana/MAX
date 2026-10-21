import { afterEach, describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { checkChangeTerms, readUniversities } from "../src/data/loadUniversities.js";
import { loadChanges } from "../src/bot/config.js";
import { changeDeadline, changeReminderDates } from "../src/core/changes.js";
import { planToIcs } from "../src/bot/calendar.js";
import { transition, type DialogueContext, type Reply, type Session } from "../src/bot/dialog.js";
import { Service } from "../src/bot/service.js";
import { testSchema } from "./pg.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const changes = loadChanges({ changesPath: "src/data/rules/ru-change.json", calendarPath: "src/data/calendar/ru.json", mode: "demo" }, texts, universities)!;
const ctx: DialogueContext = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-10-21", changes };
const actions = (r: Reply) => r.buttons.flat().flatMap(b => "action" in b ? [b.action.split("|")[1]!] : []);

/** A chat with a plan (KZ, entry 01.09), clicked through as a student would. */
function planned(context = ctx, start = "/start") {
  let s: Session = transition(null, { text: start, callback: false }, context).session!;
  const click = (action: string) => { const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, context); s = r.session!; return r.reply; };
  const type = (text: string) => { const r = transition(s, { text, callback: false }, context); s = r.session!; return r.reply; };
  for (const a of ["ru", "accept", "yes", "KZ"]) click(a);
  type("2026-09-01");
  return { click, type, get session() { return s; } };
}

describe("deadline after a change of circumstances", () => {
  it("takes the stricter of the federal and the university term and shows both grounds", () => {
    expect(changeDeadline("2026-10-29", 7, 1, changes.calendar))
      .toEqual({ federal: "2026-11-10", university: "2026-10-30", stricter: "university", due: "2026-10-30" });
    const f = planned();
    expect(actions(f.click("change"))).toEqual(expect.arrayContaining(["change:moving", "change:trip", "change:hotel", "change:passport"]));
    f.click("change:moving");
    expect(f.session.step).toBe("changeDate");
    const card = f.type("29.10.2026");
    expect(f.session.changes).toEqual({ moving: "2026-10-29" });
    expect(card.text).toContain("Срок подачи уведомления по закону (подаёт КФУ) — не позже 10 ноября 2026 г.");
    expect(card.text).toContain("Допущение: если вы живёте в общежитии, закон может требовать 1 рабочий день");
    expect(card.text).toContain("ст. 20 ч. 3");
    expect(card.text).toContain("Срок КФУ для вас — не позже 30 октября 2026 г.");
    expect(card.text).toContain("https://kpfu.ru/international/migracionnoe-soprovozhdenie-inostrannyh-grazhdan/bezvizovyi-vjezd");
    expect(card.text).toContain("Ваш срок по правилам КФУ: 30 октября 2026 г. (есть время, осталось 9 дней) — раньше срока по закону.");
    expect(card.text).toContain("Ваш шаг — сейчас: сразу после заселения или возвращения передайте паспорт и миграционную карту принимающей стороне.");
    expect(card.text).toContain("пятидневной неделе");
    expect(card.text).toContain("Региональные нерабочие дни, если их ввёл субъект РФ, бот не учитывает (TBD)");
    expect(card.text).toContain("отрывную часть уведомления");
    expect(card.text).toContain("не решение МВД");
    expect(actions(card)).toEqual(expect.arrayContaining(["change-done:moving", "card:registration-change"]));
  });

  it("counts 1 working day for a hotel or hospital and 7 for a move, skipping the 4 November holiday", () => {
    const hotel = planned();
    hotel.click("change"); hotel.click("change:hotel");
    const card = hotel.type("03.11.2026");
    expect(card.text).toContain("Срок подачи уведомления (подаёт гостиница или больница): 5 ноября 2026 г.");
    expect(card.text).toContain("Это срок принимающей стороны, а не ваш.");
    expect(card.text).not.toContain("общежитии");
    expect(card.text).toContain("администрации гостиницы или больницы");
    // The hotel files the notification: no university term is expected there.
    expect(card.text).not.toContain("TBD). Уточните");
    // A university without its own term: the federal 7 days only, and the missing term said as TBD.
    const itmo = planned(ctx, "/start itmo");
    itmo.click("change"); itmo.click("change:moving");
    const moving = itmo.type("03.11.2026");
    expect(moving.text).toContain("Срок подачи уведомления (подаёт ИТМО): 13 ноября 2026 г.");
    expect(moving.text).toContain("на странице вуза бот не нашёл (TBD)");
  });

  it("says the norm in words when the count leaves the calendar", () => {
    const f = planned({ ...ctx, today: "2027-12-20" });
    f.click("change"); f.click("change:trip");
    const card = f.type("30.12.2027");
    expect(card.text).toContain("День бот не называет");
    expect(card.text).toContain("в течение 7 рабочих дней");
    expect(card.text).toContain("Ваш срок бот не посчитал");
    expect(card.text).not.toContain("Срок подачи уведомления (");
  });

  it("counts a hotel arrival on a non-working day to the first working day after it (ч. 3.1)", () => {
    const f = planned();
    f.click("change"); f.click("change:hotel");
    // Saturday 31.10: Sunday is off too, so the first working day after the arrival is Monday 02.11.
    expect(f.type("31.10.2026").text).toContain("(подаёт гостиница или больница): 2 ноября 2026 г.");
  });

  it("asks no date for a new passport and counts no deadline", () => {
    const f = planned();
    f.click("change");
    const card = f.click("change:passport");
    expect(f.session.step).toBe("plan");
    expect(f.session.changes).toBeUndefined();
    expect(card.text).toContain("Числа дней для вас норма не называет");
    expect(card.text).toContain("п. 42");
    expect(card.text).toContain("сообщите в КФУ о новом паспорте");
    expect(card.text).not.toContain("Ваш срок");
    expect(actions(card)).not.toContain("change-done:passport");
  });

  it("refuses a date before the entry and keeps the date buttons", () => {
    const f = planned();
    f.click("change"); f.click("change:moving");
    const wrong = f.type("31.08.2026");
    expect(wrong.text).toContain("не раньше въезда");
    expect(f.session.step).toBe("changeDate");
    expect(actions(wrong)).toEqual(expect.arrayContaining(["/today", "/yesterday", "plan"]));
  });

  it("closes only a reported case, not an inherited object key", () => {
    const f = planned();
    f.click("change:moving"); f.type("29.10.2026");
    expect(f.click("change-done:constructor").text).not.toContain("Отметили");
    expect(f.session.changes).toEqual({ moving: "2026-10-29" });
  });

  it("turns /change off in live mode while the norms are draft", () => {
    expect(loadChanges({ changesPath: "src/data/rules/ru-change.json", calendarPath: "src/data/calendar/ru.json", mode: "live" }, texts, universities)).toBeUndefined();
    const off: DialogueContext = { ...ctx };
    delete off.changes;
    const f = planned(off);
    expect(actions(f.click("plan"))).not.toContain("change");
    expect(f.type("/change").text).toContain("пока выключен");
  });

  it("does not let a university term be as long as the federal one", () => {
    const kfu = universities.find(u => u.id === "kfu")!;
    const weak = { ...kfu, changeTerms: { moving: { ...kfu.changeTerms.moving!, workdays: 7 } } };
    expect(() => checkChangeTerms([weak], changes.situations)).toThrow(/не может ослабить закон/);
  });
});

describe("reminders and calendar after a change", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

  it("reminds 3 days and 1 day before and on the day; stops once the torn-off part is received", async () => {
    expect(changeReminderDates("2026-10-30", "2026-10-28")).toEqual(["2026-10-29", "2026-10-30"]);
    const schema = await testSchema(); cleanups.push(schema.drop);
    const { store } = await schema.open(); cleanups.push(() => store.close());
    let now = Date.parse("2026-10-21T10:00:00+03:00");
    const sent: Reply[] = [];
    const service = new Service(store, ctx,
      { send(_u, reply) { sent.push(reply); return Promise.resolve(); } }, () => now);
    let n = 0;
    const input = (text: string, callback = false) => service.receive({ id: String(++n), user: 1, input: { text, callback } });
    const click = async (a: string) => { const s = (await store.get(1))!; await input(`${s.nonce}.${s.revision}|${a}`, true); };
    await input("/start");
    for (const a of ["ru", "accept", "yes", "KZ"]) await click(a);
    await input("2026-09-01");
    await click("reminders");
    await input("/change"); await click("change:moving"); await input("29.10.2026");
    const change = () => sent.filter(r => r.text.includes("ваш срок по правилам КФУ: 30 октября 2026 г."));
    for (const [day, count] of [["2026-10-26", 0], ["2026-10-27", 1], ["2026-10-28", 1], ["2026-10-29", 2]] as const) {
      now = Date.parse(`${day}T09:00:00+03:00`); await service.flush();
      expect(change(), day).toHaveLength(count);
    }
    expect(change()[0]!.text).toContain("Переезд");
    expect(change()[0]!.text).toContain("передали паспорт и миграционную карту принимающей стороне, сделайте это сейчас");
    const s = (await store.get(1))!;
    const ics = planToIcs([], { lang: "ru", texts, demo: true, uid: s.nonce, today: "2026-10-29", sequence: s.revision,
      changes: [{ id: "moving", title: "Переезд", due: "2026-10-30" }] });
    expect(ics).toContain("UID:change-moving-");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261030");
    expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(2); // the day before and the day itself; 3 days before is past
    await click("change-done:moving");
    expect((await store.get(1))!.changes).toEqual({});
    now = Date.parse("2026-10-30T09:00:00+03:00"); await service.maintain(); await service.flush();
    expect(change()).toHaveLength(2);
  });
});
