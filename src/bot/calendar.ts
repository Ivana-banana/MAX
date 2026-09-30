import { REMINDER_OFFSETS, reminderDates } from "../core/deadlines.js";
import { addDays } from "../core/dates.js";
import type { Lang, PlanItem } from "../core/types.js";
import { format, type Texts } from "../data/loadTexts.js";

// iCalendar (RFC 5545) export of the personal plan: deadlines land in the phone's own
// calendar with alarms, so they keep working even if the bot is muted or offline.
// sequence: grows with every change of the session (its revision), so a re-import replaces the older event.
export interface CalendarOptions {
  lang: Lang; texts: Texts; demo: boolean; uid: string; today: string; sequence: number;
  /** Planned visit days (rule id → date, D-039): each is its own event with an alarm the evening before. */
  visits?: Record<string, string>;
  /** University deadlines counted from a document end date (D-040), with the same alarms as the plan. */
  procedures?: { id: string; title: string; due: string }[];
}
export const CALENDAR_FILE = "first-90-days.ics";
const REMIND_AT = "T060000Z"; // 09:00 Moscow time, the same hour the bot reminds
const VISIT_EVE_AT = "T150000Z"; // 18:00 Moscow time the day before a visit, as the bot does

const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const compact = (date: string) => date.replaceAll("-", "");
// Lines longer than 75 octets are folded; never split inside a UTF-8 character.
function fold(line: string): string {
  const out: string[] = [];
  let current = "", size = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (size + n > (out.length ? 74 : 75)) { out.push(current); current = ""; size = 0; }
    current += ch; size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}
export function planToIcs(items: PlanItem[], o: CalendarOptions): string {
  const t = (key: string) => format(o.texts, o.lang, key);
  const demo = o.demo ? t("ics.demo") : "";
  const stamp = compact(o.today) + "T000000Z";
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//max-first-90-days//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:" + escape(t("ics.name"))];
  for (const item of items) {
    // A marked procedure stays under its UID as cancelled: re-importing removes it with its alarms.
    const done = item.status === "done";
    const note = [item.action[o.lang],
      ...(item.recommendedDate ? [t("ics.recommended") + item.recommendedDate] : []),
      t("ics.calculated"),
      ...(item.provisional ? [t("ics.provisional")] : []),
      `${item.legal.act}, ${item.legal.article}`, item.legal.url].join("\n");
    lines.push("BEGIN:VEVENT", `UID:${item.ruleId}-${o.uid}@max-first-90-days`, `DTSTAMP:${stamp}`, `SEQUENCE:${o.sequence}`,
      ...(done ? ["STATUS:CANCELLED"] : []),
      `DTSTART;VALUE=DATE:${compact(item.dueDate)}`, `DTEND;VALUE=DATE:${compact(addDays(item.dueDate, 1))}`,
      "SUMMARY:" + escape(demo + t("ics.deadline") + item.title[o.lang]),
      "DESCRIPTION:" + escape(note), "TRANSP:TRANSPARENT");
    for (const day of done ? [] : reminderDates(item, o.today)) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER;VALUE=DATE-TIME:${compact(day)}${REMIND_AT}`,
        "DESCRIPTION:" + escape(demo + item.title[o.lang] + " — " + item.dueDate), "END:VALARM");
    }
    lines.push("END:VEVENT");
    const visit = done ? undefined : o.visits?.[item.ruleId];
    if (visit) {
      lines.push("BEGIN:VEVENT", `UID:${item.ruleId}-visit-${o.uid}@max-first-90-days`, `DTSTAMP:${stamp}`, `SEQUENCE:${o.sequence}`,
        `DTSTART;VALUE=DATE:${compact(visit)}`, `DTEND;VALUE=DATE:${compact(addDays(visit, 1))}`,
        "SUMMARY:" + escape(demo + t("ics.visit") + item.title[o.lang]),
        "DESCRIPTION:" + escape(item.documents.map(d => "□ " + d.title[o.lang]).join("\n")), "TRANSP:TRANSPARENT",
        ...(addDays(visit, -1) >= o.today ? ["BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER;VALUE=DATE-TIME:${compact(addDays(visit, -1))}${VISIT_EVE_AT}`,
          "DESCRIPTION:" + escape(demo + t("ics.visit") + item.title[o.lang]), "END:VALARM"] : []),
        "END:VEVENT");
    }
  }
  for (const p of o.procedures ?? []) {
    lines.push("BEGIN:VEVENT", `UID:${p.id}-${o.uid}@max-first-90-days`, `DTSTAMP:${stamp}`, `SEQUENCE:${o.sequence}`,
      `DTSTART;VALUE=DATE:${compact(p.due)}`, `DTEND;VALUE=DATE:${compact(addDays(p.due, 1))}`,
      "SUMMARY:" + escape(demo + t("ics.university") + p.title), "DESCRIPTION:" + escape(t("ics.universityNote")), "TRANSP:TRANSPARENT");
    for (const offset of REMINDER_OFFSETS) {
      const day = addDays(p.due, -offset);
      if (day >= o.today) lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER;VALUE=DATE-TIME:${compact(day)}${REMIND_AT}`,
        "DESCRIPTION:" + escape(demo + p.title + " — " + p.due), "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
