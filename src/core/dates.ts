/**
 * Plain calendar-date arithmetic.
 *
 * Deadlines here are whole calendar days from a personal event, so we never touch
 * clock time or local timezones: `2026-09-01` plus 30 days is the same date for a
 * student in Kazan and for a test running in CI. Using `Date` with time would make
 * the result depend on the server's timezone, which is exactly the class of silent
 * off-by-one this product must not produce.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MS_PER_DAY = 86_400_000;

export class InvalidDateError extends Error {
  constructor(value: string) {
    super(`Ожидается дата в формате ГГГГ-ММ-ДД, получено: ${value}`);
    this.name = "InvalidDateError";
  }
}

/** Parses `YYYY-MM-DD` and rejects both malformed strings and non-existent days. */
export function parseDate(value: string): { year: number; month: number; day: number } {
  const match = ISO_DATE.exec(value);
  if (!match) throw new InvalidDateError(value);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Round-trip through UTC to reject 2026-02-30 and friends, which Date would
  // otherwise silently roll over into March.
  const utc = Date.UTC(year, month - 1, day);
  const back = new Date(utc);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    throw new InvalidDateError(value);
  }

  return { year, month, day };
}

export function isValidDate(value: string): boolean {
  try {
    parseDate(value);
    return true;
  } catch {
    return false;
  }
}

function toTimestamp(value: string): number {
  const { year, month, day } = parseDate(value);
  return Date.UTC(year, month - 1, day);
}

function fromTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(value: string, days: number): string {
  return fromTimestamp(toTimestamp(value) + days * MS_PER_DAY);
}

/**
 * Adds whole months, clamping to the last day of the target month so that
 * 2026-01-31 plus one month is 2026-02-28 rather than rolling into March.
 */
export function addMonths(value: string, months: number): string {
  const { year, month, day } = parseDate(value);
  const zeroBased = month - 1 + months;
  const targetYear = year + Math.floor(zeroBased / 12);
  const targetMonth = ((zeroBased % 12) + 12) % 12;

  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return fromTimestamp(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toTimestamp(to) - toTimestamp(from)) / MS_PER_DAY);
}

export function compareDates(a: string, b: string): number {
  return toTimestamp(a) - toTimestamp(b);
}
