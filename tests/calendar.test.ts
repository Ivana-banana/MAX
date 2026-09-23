import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/core/deadlines.js";
import { parseRuleSet } from "../src/data/loadRules.js";
import { planToIcs } from "../src/bot/calendar.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };

const { rules } = parseRuleSet(raw);
const profile = { citizenship: "KZ", purpose: "study" as const, entryDate: "2026-09-01" };
const options = { lang: "ru" as const, demo: true, uid: "abc123", today: "2026-09-24" };
const events = (ics: string) => ics.split("BEGIN:VEVENT").slice(1);

describe("calendar export", () => {
  it("emits one all-day event per open procedure with the deadline date", () => {
    const ics = planToIcs(buildPlan(rules, profile, {}, "2026-09-24"), options);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.replaceAll("\r\n", "")).not.toMatch(/\n/);
    expect(events(ics)).toHaveLength(2);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261001\r\nDTEND;VALUE=DATE:20261002");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261130");
  });
  it("sets alarms at 09:00 Moscow time only for reminder days still ahead", () => {
    const ics = planToIcs(buildPlan(rules, profile, {}, "2026-09-24"), options);
    const medical = events(ics).find(e => e.includes("20261001"))!;
    // 7 days before 01.10 is 24.09 (today, kept); 3 and 1 days before follow.
    expect(medical.match(/TRIGGER;VALUE=DATE-TIME:\d{8}T060000Z/g)).toEqual([
      "TRIGGER;VALUE=DATE-TIME:20260924T060000Z", "TRIGGER;VALUE=DATE-TIME:20260928T060000Z",
      "TRIGGER;VALUE=DATE-TIME:20260930T060000Z"]);
    const late = planToIcs(buildPlan(rules, profile, {}, "2026-09-29"), { ...options, today: "2026-09-29" });
    expect(events(late).find(e => e.includes("20261001"))!.match(/BEGIN:VALARM/g)).toHaveLength(1);
  });
  it("skips completed one-time procedures and exports the next round of repeating ones", () => {
    const plan = buildPlan(rules, profile, { fingerprinting: "2026-09-10", "medical-examination": "2026-09-20" }, "2026-09-24");
    const ics = planToIcs(plan, options).replaceAll("\r\n ", "");
    expect(events(ics)).toHaveLength(1);
    expect(ics).toContain("DTSTART;VALUE=DATE:20271020");
    expect(ics).toContain("Рекомендуемая дата: 2027-09-20");
  });
  it("marks demo data, calculated status and the legal source", () => {
    const text = planToIcs(buildPlan(rules, profile, {}, "2026-09-24"), options).replaceAll("\r\n ", "");
    expect(text).toContain("SUMMARY:[ДЕМО] Крайний срок: Медицинское освидетельствование");
    expect(text).toContain("не решение МВД");
    expect(text).toContain("Норма ещё не вычитана юристом");
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
    expect(uids(planToIcs(buildPlan(rules, profile, {}, "2026-09-24"), { ...options, uid: "other" }))).not.toEqual(uids(first));
  });
});
