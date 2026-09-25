/**
 * Pure helpers behind the date field: typing DD.MM.YYYY, sending YYYY-MM-DD.
 * Kept apart from the component so the root test suite can check them without a DOM.
 */

/** `DD.MM.YYYY` → `YYYY-MM-DD`, or "" while the input is incomplete or not a real day. */
export function toIso(display: string): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(display);
  if (match === null) return "";
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const iso = `${year}-${month}-${day}`;
  return date.toISOString().slice(0, 10) === iso ? iso : "";
}

/** Digits only, dots inserted after the day and the month. */
export function mask(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(part => part !== "").join(".");
}
