import { reminderDates } from "../core/deadlines.js";
import { addDays } from "../core/dates.js";
import type { Lang, PlanItem } from "../core/types.js";

// iCalendar (RFC 5545) export of the personal plan: deadlines land in the phone's own
// calendar with alarms, so they keep working even if the bot is muted or offline.
export interface CalendarOptions { lang: Lang; demo: boolean; uid: string; today: string }
export const CALENDAR_FILE = "first-90-days.ics";
const REMIND_AT = "T060000Z"; // 09:00 Moscow time, the same hour the bot reminds

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
  const t = (ru: string, en: string) => o.lang === "ru" ? ru : en;
  const demo = o.demo ? t("[ДЕМО] ", "[DEMO] ") : "";
  const stamp = compact(o.today) + "T000000Z";
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//max-first-90-days//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:" + escape(t("Первые 90 дней", "First 90 days"))];
  for (const item of items) {
    if (item.status === "done") continue;
    const note = [item.action[o.lang],
      ...(item.recommendedDate ? [t("Рекомендуемая дата: ", "Recommended date: ") + item.recommendedDate] : []),
      t("Расчётный срок по справочнику, не решение МВД.", "Calculated date, not an official decision."),
      ...(item.provisional ? [t("Норма ещё не вычитана юристом.", "The rule has not been legally reviewed yet.")] : []),
      `${item.legal.act}, ${item.legal.article}`, item.legal.url].join("\n");
    lines.push("BEGIN:VEVENT", `UID:${item.ruleId}-${o.uid}@max-first-90-days`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(item.dueDate)}`, `DTEND;VALUE=DATE:${compact(addDays(item.dueDate, 1))}`,
      "SUMMARY:" + escape(demo + t("Крайний срок: ", "Deadline: ") + item.title[o.lang]),
      "DESCRIPTION:" + escape(note), "TRANSP:TRANSPARENT");
    for (const day of reminderDates(item, o.today)) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER;VALUE=DATE-TIME:${compact(day)}${REMIND_AT}`,
        "DESCRIPTION:" + escape(demo + item.title[o.lang] + " — " + item.dueDate), "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
