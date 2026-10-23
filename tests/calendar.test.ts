import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/core/deadlines.js";
import { parseRuleSet } from "../src/data/loadRules.js";
import { planToIcs } from "../src/bot/calendar.js";
import { readTexts } from "../src/data/loadTexts.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };

const { rules } = parseRuleSet(raw);
const profile = { citizenship: "KZ", purpose: "study" as const, entryDate: "2026-09-01" };
const options = { lang: "ru", texts: readTexts("src/data/i18n"), demo: true, uid: "abc123", today: "2026-09-24", sequence: 5 };
const events = (ics: string) => ics.split("BEGIN:VEVENT").slice(1);

describe("calendar export", () => {
  it("emits one all-day event per open procedure with the deadline date", () => {
    const ics = planToIcs(buildPlan(rules, profile, {}, "2026-09-24"), options);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.replaceAll("\r\n", "")).not.toMatch(/\n/);
    expect(events(ics)).toHaveLength(2);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260930\r\nDTEND;VALUE=DATE:20261001");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261129");
  });
  it("sets alarms at 09:00 Moscow time only for reminder days still ahead", () => {
    const ics = planToIcs(buildPlan(rules, profile, {}, "2026-09-24"), options);
    const medical = events(ics).find(e => e.includes("20260930"))!;
    // Entry day counts (D-016): due 30.09; 7 days before is 23.09 (past, dropped), 3 and 1 days before stay.
    expect(medical.match(/TRIGGER;VALUE=DATE-TIME:\d{8}T060000Z/g)).toEqual([
      "TRIGGER;VALUE=DATE-TIME:20260927T060000Z", "TRIGGER;VALUE=DATE-TIME:20260929T060000Z"]);
    const late = planToIcs(buildPlan(rules, profile, {}, "2026-09-29"), { ...options, today: "2026-09-29" });
    expect(events(late).find(e => e.includes("20260930"))!.match(/BEGIN:VALARM/g)).toHaveLength(1);
  });
  it("cancels completed one-time procedures and exports the next round of repeating ones", () => {
    const plan = buildPlan(rules, profile, { fingerprinting: "2026-09-10", "medical-examination": "2026-09-20" }, "2026-09-24");
    const ics = planToIcs(plan, options).replaceAll("\r\n ", "");
    // A re-export must take the marked procedure out of the phone calendar, not leave its alarms firing.
    const done = events(ics).find(e => e.includes("UID:fingerprinting-"))!;
    expect(done).toContain("STATUS:CANCELLED");
    expect(done).not.toContain("BEGIN:VALARM");
    const next = events(ics).find(e => e.includes("UID:medical-examination-"))!;
    expect(next).not.toContain("STATUS:CANCELLED");
    expect(next).toContain("DTSTART;VALUE=DATE:20271020");
    expect(ics).toContain("Рекомендуемая дата: 2027-09-20");
  });
  it("labels a repeat round in the title and the note, and leaves a first round alone", () => {
    const first = events(planToIcs(buildPlan(rules, profile, {}, "2026-09-24"), options).replaceAll("\r\n ", ""));
    expect(first.join("")).not.toContain("повторно (");
    expect(first.join("")).not.toContain("пройдено вами");
    const plan = buildPlan(rules, profile, { "medical-examination": "2026-09-20" }, "2026-09-24");
    const next = events(planToIcs(plan, options).replaceAll("\r\n ", "")).find(e => e.includes("UID:medical-examination-"))!;
    expect(next).toContain("Медицинское освидетельствование\\, повторно (ежегодно)");
    expect(next).toContain("пройдено вами 20 сентября 2026 г.");
    const en = events(planToIcs(plan, { ...options, lang: "en" }).replaceAll("\r\n ", "")).find(e => e.includes("UID:medical-examination-"))!;
    expect(en).toContain("\\, repeat (yearly)");
    expect(en).toContain("marked done by you on September 20\\, 2026");
  });
  it("a repeat round: Chinese comma before the label, and the label in the alarm too", () => {
    const plan = buildPlan(rules, profile, { "medical-examination": "2026-09-20" }, "2027-09-24");
    const title = rules.find(r => r.id === "medical-examination")!.title.zh!;
    const zh = events(planToIcs(plan, { ...options, lang: "zh", today: "2027-09-24" }).replaceAll("\r\n ", "")).find(e => e.includes("UID:medical-examination-"))!;
    expect(zh).toContain(`${title}，再次办理（每年）`);
    expect(zh).toMatch(/BEGIN:VALARM[^]*DESCRIPTION:\[[^\r]*，再次办理（每年） — 2027-10-20/);
  });
  it("marks demo data, calculated status and the legal source", () => {
    const text = planToIcs(buildPlan(rules, profile, {}, "2026-09-24"), options).replaceAll("\r\n ", "");
    expect(text).toContain("SUMMARY:[ДЕМО] Предельный срок: Медицинское освидетельствование");
    expect(text).toContain("не решение МВД");
    expect(text).not.toContain("Юрист ещё не проверил норму");
    const draft = rules.map(r => ({ ...r, legal: { ...r.legal, status: "draft" as const } }));
    expect(planToIcs(buildPlan(draft, profile, {}, "2026-09-24"), options).replaceAll("\r\n ", "")).toContain("Юрист ещё не проверил норму");
    expect(text).toContain("115-ФЗ\\, ст. 5\\, п. 13");
    expect(planToIcs(buildPlan(rules, profile, {}, "2026-09-24"), { ...options, demo: false })).not.toContain("ДЕМО");
  });
  it("folds long lines at 75 octets without splitting UTF-8 characters", () => {
    const ics = planToIcs(buildPlan(rules, profile, {}, "2026-09-24"), options);
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(ics).not.toContain("�");
  });
  it("keeps event UIDs stable so a re-export updates instead of duplicating", () => {
    const uids = (ics: string) => ics.match(/^UID:.*$/gm);
    const first = planToIcs(buildPlan(rules, profile, {}, "2026-09-24"), options);
    const again = planToIcs(buildPlan(rules, profile, {}, "2026-09-25"), { ...options, today: "2026-09-25" });
    expect(uids(again)).toEqual(uids(first));
    // A changed event carries a higher SEQUENCE, so the calendar takes it as the newer version.
    expect(first.match(/^SEQUENCE:5$/gm)).toHaveLength(2);
    expect(planToIcs(buildPlan(rules, profile, {}, "2026-09-25"), { ...options, sequence: 9 })).toMatch(/^SEQUENCE:9$/m);
    expect(uids(planToIcs(buildPlan(rules, profile, {}, "2026-09-24"), { ...options, uid: "other" }))).not.toEqual(uids(first));
  });
});
