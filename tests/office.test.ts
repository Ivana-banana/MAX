import { describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import { transition, type Session } from "../src/bot/dialog.js";
import { officeReport, officeSnapshot, SMALL } from "../src/bot/office.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };

/** A student who went through the chat: university, citizenship, entry date, then some clicks. */
function student(start: string, citizenship: string, entry: string, clicks: string[] = [], typed: string[] = []): Session {
  let s: Session = transition(null, { text: start, callback: false }, ctx).session!;
  for (const a of ["ru", "accept", "yes", citizenship]) s = transition(s, { text: `${s.nonce}.${s.revision}|${a}`, callback: true }, ctx).session!;
  s = transition(s, { text: entry, callback: false }, ctx).session!;
  clicks.forEach((a, i) => {
    s = transition(s, { text: `${s.nonce}.${s.revision}|${a}`, callback: true }, ctx).session!;
    if (typed[i]) s = transition(s, { text: typed[i]!, callback: false }, ctx).session!;
  });
  return s;
}

describe("summary for the university's international office", () => {
  // On 24.09, entries 01.09 and 02.09 put the medical examination at 30.09 and 01.10 — within 7 days;
  // entry 10.09 puts it at 09.10, and that student has already marked it as done.
  const kfu = [
    student("/start", "KZ", "2026-09-01", ["reminders"]),
    student("/start", "UZ", "2026-09-02", ["reminders", "card:medical-examination", "visit:medical-examination"], ["", "", "2026-09-28"]),
    student("/start", "CN", "2026-09-01"),
    student("/start", "KG", "2026-09-10", ["card:medical-examination", "done:medical-examination"], ["", "/today"]),
  ];
  const itmo = [student("/start itmo", "IN", "2026-09-01")];
  const snapshot = officeSnapshot([...kfu, ...itmo], ctx);

  it("counts plans, reminders, deadlines and visits per university, without identifiers", () => {
    expect(snapshot.kfu).toMatchObject({ plans: 4, reminders: 2, visits: 1 });
    expect(snapshot.kfu!.procedures["medical-examination"]).toEqual({ dueSoon: 3, overdue: 0, done: 1 });
    expect(snapshot.itmo).toMatchObject({ plans: 1 });
    expect(JSON.stringify(snapshot)).not.toMatch(/KZ|UZ|CN|2026-09-0|nonce/);
  });

  it("prints small groups as «<3», so a student in a group of one or two cannot be recognised", () => {
    const text = officeReport(snapshot, [], ctx, "kfu");
    expect(SMALL).toBe(3);
    expect(text).toContain("Профилей с планом: 4");
    expect(text).toContain("Включили напоминания: <3");
    expect(text).toContain("Медицинское освидетельствование: срок в ближайшие 7 дней — 3, просрочено без отметки — 0, отмечено — <3");
    expect(text).not.toContain("ИТМО");
  });

  it("adds the anonymous funnel counters of the chosen university", () => {
    const text = officeReport(snapshot, [
      { day: "2026-09-20", university: "kfu", event: "help_opened", n: 4 },
      { day: "2026-09-21", university: "kfu", event: "reminder_sent", n: 7 },
      { day: "2026-09-21", university: "itmo", event: "help_opened", n: 9 },
    ], ctx, "kfu");
    expect(text).toContain("Открыли «Не получилось»: 4");
    expect(text).toContain("Отправлено напоминаний: 7");
  });

  it("says the numbers are self-reported and not a check by the Interior Ministry", () => {
    expect(officeReport(snapshot, [], ctx, "kfu")).toContain("со слов студентов");
  });
});
