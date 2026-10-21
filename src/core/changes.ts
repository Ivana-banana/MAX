/**
 * Deadline after a change of circumstances (#41, D-061): the stricter of the federal term and the
 * university's own term, both in working days after the day of the event.
 */

import { addDays, addWorkdays, compareDates, type WorkCalendar } from "./dates.js";
import type { PlainDate } from "./types.js";

/** Reminders before a change deadline, in days: the terms are 1–7 working days, so 7 days before would come before the event. */
export const CHANGE_REMINDER_OFFSETS = [3, 1, 0] as const;

export interface ChangeDeadline {
  /** The federal date; null when the count leaves the calendar period. */
  federal: PlainDate | null;
  /** The university's date when its term covers the case; null outside the calendar; absent without a term. */
  university?: PlainDate | null;
  /** Whose term is stricter. Both count from the same day the same way, so fewer working days is the earlier date. */
  stricter: "federal" | "university";
  /** Date of the stricter term; null outside the calendar: the caller says the norm in words. */
  due: PlainDate | null;
}

export function changeDeadline(event: PlainDate, federalDays: number, universityDays: number | undefined, calendar: WorkCalendar): ChangeDeadline {
  const federal = addWorkdays(event, federalDays, calendar);
  if (universityDays === undefined) return { federal, stricter: "federal", due: federal };
  const university = addWorkdays(event, universityDays, calendar);
  const stricter = universityDays < federalDays ? "university" : "federal";
  return { federal, university, stricter, due: stricter === "university" ? university : federal };
}

/** Reminder days for a change deadline, earliest first; days already past are dropped. */
export function changeReminderDates(due: PlainDate, today: PlainDate): PlainDate[] {
  return CHANGE_REMINDER_OFFSETS.map(offset => addDays(due, -offset)).filter(day => compareDates(day, today) >= 0);
}
