/**
 * Loads the production calendar (src/data/calendar) and turns it into the days off that
 * `addWorkdays` counts over. Every day off follows from the Labour Code (holidays, the move of a
 * weekend that fell on a holiday) or from a government decree (transfers); nothing is typed in by
 * hand, so a wrong date has nowhere to hide. A malformed file fails at load time (as in loadRules).
 */

import { readFileSync } from "node:fs";
import { addDays, isValidDate, isWeekend, type WorkCalendar } from "../core/dates.js";

export class CalendarValidationError extends Error {
  constructor(path: string, problem: string) {
    super(`Календарь невалиден (${path}): ${problem}`);
    this.name = "CalendarValidationError";
  }
}

export interface LoadedCalendar {
  calendar: WorkCalendar;
  /** Every page the calendar stands on; each one must be in src/data/sources.json. */
  urls: string[];
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CalendarValidationError(path, "ожидается объект");
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new CalendarValidationError(path, "ожидается непустой массив");
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new CalendarValidationError(path, "ожидается непустая строка");
  return value;
}

function asUrl(value: unknown, path: string): string {
  const url = asString(value, path);
  if (!url.startsWith("https://")) throw new CalendarValidationError(path, `нужна ссылка https://, получено «${url}»`);
  return url;
}

function asDate(value: unknown, path: string): string {
  const date = asString(value, path);
  if (!isValidDate(date)) throw new CalendarValidationError(path, `ожидается дата ГГГГ-ММ-ДД, получено «${date}»`);
  return date;
}

interface Holiday { day: string; shiftIfWeekend: boolean }

function asHolidays(value: unknown, path: string): Holiday[] {
  const days = asArray(value, path).map((raw, i) => {
    const record = asRecord(raw, `${path}[${i}]`);
    const day = asString(record.day, `${path}[${i}].day`);
    // 2001 is not a leap year: 02-29 is refused, the Labour Code has no such holiday.
    if (!/^\d{2}-\d{2}$/.test(day) || !isValidDate(`2001-${day}`)) throw new CalendarValidationError(`${path}[${i}].day`, `ожидается ММ-ДД, получено «${day}»`);
    asString(record.name, `${path}[${i}].name`);
    if (typeof record.shiftIfWeekend !== "boolean") throw new CalendarValidationError(`${path}[${i}].shiftIfWeekend`, "ожидается true или false");
    return { day, shiftIfWeekend: record.shiftIfWeekend };
  });
  const twice = days.find((h, i) => days.findIndex(o => o.day === h.day) !== i);
  if (twice) throw new CalendarValidationError(path, `повторяющийся день «${twice.day}»`);
  return days;
}

/** Days off of one calendar year; `daysOff` has no weekend that the decree turned into a workday. */
function yearDaysOff(year: number, holidays: Holiday[], transfers: { from: string; to: string }[], path: string): string[] {
  const holidayDates = new Set(holidays.map(h => `${year}-${h.day}`));
  const from = new Set(transfers.map(t => t.from));
  const to = new Set(transfers.map(t => t.to));

  for (const [i, t] of transfers.entries()) {
    if (!t.from.startsWith(`${year}-`) || !t.to.startsWith(`${year}-`)) throw new CalendarValidationError(`${path}.transfers[${i}]`, `перенос должен лежать в ${year} году`);
    if (!isWeekend(t.from)) throw new CalendarValidationError(`${path}.transfers[${i}].from`, `${t.from} не суббота и не воскресенье`);
    if (isWeekend(t.to) || holidayDates.has(t.to)) throw new CalendarValidationError(`${path}.transfers[${i}].to`, `${t.to} уже нерабочий день`);
  }
  if (from.size !== transfers.length || to.size !== transfers.length) throw new CalendarValidationError(`${path}.transfers`, "день встречается в переносах дважды");

  // Labour Code, ст. 112 ч. 2: a weekend that fell on a holiday moves to the next workday after it.
  const shifted = new Set<string>();
  for (const h of holidays) {
    const date = `${year}-${h.day}`;
    if (!h.shiftIfWeekend || !isWeekend(date) || from.has(date)) continue;
    let next = date;
    do next = addDays(next, 1); while (isWeekend(next) || holidayDates.has(next) || to.has(next) || shifted.has(next));
    if (!next.startsWith(`${year}-`)) throw new CalendarValidationError(path, `выходной ${date} переносится за пределы года: ${next}`);
    shifted.add(next);
  }

  const daysOff: string[] = [];
  for (let day = `${year}-01-01`; day.startsWith(`${year}-`); day = addDays(day, 1)) {
    const workingWeekend = isWeekend(day) && from.has(day) && !holidayDates.has(day);
    if ((isWeekend(day) && !workingWeekend) || holidayDates.has(day) || to.has(day) || shifted.has(day)) daysOff.push(day);
  }
  return daysOff;
}

export function parseCalendar(raw: unknown): LoadedCalendar {
  const record = asRecord(raw, "$");
  const holidaysRecord = asRecord(record.holidays, "$.holidays");
  const holidays = asHolidays(holidaysRecord.days, "$.holidays.days");
  const urls = [asUrl(holidaysRecord.url, "$.holidays.url")];

  const daysOff = new Set<string>();
  let previous: number | undefined;
  const years = asArray(record.years, "$.years").map((raw, i) => {
    const path = `$.years[${i}]`;
    const year = asRecord(raw, path);
    if (!Number.isInteger(year.year) || (year.year as number) < 2000 || (year.year as number) > 2100) throw new CalendarValidationError(`${path}.year`, "ожидается год");
    const number = year.year as number;
    // A gap would make addWorkdays walk over a year it knows nothing about.
    if (previous !== undefined && number !== previous + 1) throw new CalendarValidationError(`${path}.year`, `годы идут подряд по возрастанию, после ${previous} получено ${number}`);
    previous = number;
    asDate(year.checkedAt, `${path}.checkedAt`);
    asString(year.decree, `${path}.decree`);
    urls.push(asUrl(year.url, `${path}.url`));
    const transfers = (Array.isArray(year.transfers) ? year.transfers : []).map((t, j) => {
      const transfer = asRecord(t, `${path}.transfers[${j}]`);
      return { from: asDate(transfer.from, `${path}.transfers[${j}].from`), to: asDate(transfer.to, `${path}.transfers[${j}].to`) };
    });
    for (const day of yearDaysOff(number, holidays, transfers, path)) daysOff.add(day);
    return number;
  });

  return { calendar: { from: `${years[0]}-01-01`, to: `${years[years.length - 1]}-12-31`, daysOff }, urls: [...new Set(urls)] };
}

export function readCalendar(path: string): LoadedCalendar {
  return parseCalendar(JSON.parse(readFileSync(path, "utf8")));
}
