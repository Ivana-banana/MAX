import { describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import { transition, type DialogueContext, type Session } from "../src/bot/dialog.js";

const rules = parseRuleSet(raw);
const ctx: DialogueContext = { rules: rules.rules, universities: readUniversities("src/data/universities", "kfu"),
  texts: readTexts("src/data/i18n"), version: rules.version, demo: true, today: "2026-09-24" };

/** A chat walked to the entry question; `type` sends a typed message, `click` a button. */
function atEntry(c = ctx) {
  let s: Session = transition(null, { text: "/start", callback: false }, c).session!;
  const click = (action: string) => { const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, c); s = r.session!; return r.reply; };
  for (const a of ["ru", "accept", "yes", "KZ"]) click(a);
  const type = (text: string) => { const r = transition(s, { text, callback: false }, c); s = r.session!; return r.reply; };
  return { type, click, get s() { return s; } };
}
const home = (entry: string, today: string) => { const c = { ...ctx, today }; return atEntry(c).type(entry).text; };

describe("scenario traps: what the bot answers", () => {
  it("entry before 01.09.2026: no plan, the answer names the first covered date", () => {
    const f = atEntry();
    expect(f.type("31.08.2026").text).toContain("с 1 сентября 2026 г. по сегодня");
    expect(f.s.step).toBe("entry");
    expect(f.s.entryDate).toBeUndefined();
  });

  it("entry date in the future: no plan, the answer says the date must be up to today", () => {
    const f = atEntry();
    expect(f.type("25.09.2026").text).toContain("по сегодня");
    expect(f.s.entryDate).toBeUndefined();
  });

  it("private housing or a repeated entry (answer 'no' on the scope question): unsupported, no calculation", () => {
    let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
    const click = (action: string) => transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);
    for (const a of ["ru", "accept"]) s = click(a).session!;
    const no = click("no");
    expect(no.reply.text).toContain("Для неподдержанного случая расчёт не выполняем");
    expect(no.reply.text).toContain("admissions.kpfu.ru");
    expect(no.session!.step).toBe("scope");
  });

  it("entry today: accepted, medical examination has 29 days left", () => {
    expect(home("24.09.2026", "2026-09-24")).toContain("Медицинское освидетельствование: 23 октября 2026 г. — есть время, осталось 29 дней");
  });

  it("day 30 is the last day, day 31 is already past", () => {
    expect(home("01.09.2026", "2026-09-30")).toContain("Медицинское освидетельствование: 30 сентября 2026 г. — сегодня последний день");
    expect(home("01.09.2026", "2026-10-01")).toContain("Медицинское освидетельствование: 30 сентября 2026 г. — расчётный срок прошёл 1 день назад");
  });

  it("day 90 is the last day, day 91 is already past", () => {
    expect(home("01.09.2026", "2026-11-29")).toContain("29 ноября 2026 г. — сегодня последний день");
    expect(home("01.09.2026", "2026-11-30")).toContain("29 ноября 2026 г. — расчётный срок прошёл 1 день назад");
  });
});
