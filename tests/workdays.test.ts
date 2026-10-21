import { describe, expect, it } from "vitest";
import { addWorkdays } from "../src/core/dates.js";
import { CalendarValidationError, parseCalendar, readCalendar } from "../src/data/loadCalendar.js";

const { calendar } = readCalendar("src/data/calendar/ru.json");

describe("addWorkdays", () => {
  it("skips a weekend", () => {
    expect(addWorkdays("2026-09-04", 1, calendar)).toBe("2026-09-07"); // Fri -> Mon
  });

  it("does not count the start day, even when it is a day off", () => {
    expect(addWorkdays("2026-09-05", 1, calendar)).toBe("2026-09-07"); // Sat -> Mon
  });

  it("skips a holiday", () => {
    expect(addWorkdays("2026-11-03", 1, calendar)).toBe("2026-11-05"); // 4 Nov is a holiday
  });

  it("skips a day off moved by the decree", () => {
    expect(addWorkdays("2026-01-08", 1, calendar)).toBe("2026-01-12"); // 9 Jan 2026 is off (ПП № 1466)
    expect(addWorkdays("2026-12-30", 1, calendar)).toBe("2027-01-11"); // 31 Dec 2026 off, then 1-8 Jan 2027
  });

  it("counts a Saturday that the decree made a workday", () => {
    expect(addWorkdays("2027-02-19", 1, calendar)).toBe("2027-02-20"); // ПП № 1187: 20 Feb 2027 works
  });

  it("counts seven workdays over a weekend and a holiday", () => {
    expect(addWorkdays("2026-10-29", 7, calendar)).toBe("2026-11-10");
  });

  it("returns null when the walk leaves the calendar period", () => {
    expect(addWorkdays("2027-12-29", 1, calendar)).toBe("2027-12-30");
    expect(addWorkdays("2027-12-30", 1, calendar)).toBeNull(); // 31 Dec 2027 is off, 2028 is unknown
    expect(addWorkdays("2025-12-31", 1, calendar)).toBeNull();
    expect(addWorkdays("2028-01-10", 1, calendar)).toBeNull();
  });

  it("refuses a count below one", () => {
    expect(() => addWorkdays("2026-09-04", 0, calendar)).toThrow(RangeError);
  });
});

describe("the production calendar follows the Labour Code and the decrees", () => {
  // Weekdays off and weekends worked, written out from ТК ст. 112 and the two decrees (docs/legal-review.md, 7.5).
  const weekdaysOff = (year: string) => [...calendar.daysOff].filter(d => d.startsWith(year) && ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()));

  it("2026: holidays, the moved weekends of 3 and 4 January, and 9 and 11 March, May", () => {
    expect(weekdaysOff("2026")).toEqual([
      "2026-01-01", "2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09",
      "2026-02-23", "2026-03-09", "2026-05-01", "2026-05-11", "2026-06-12", "2026-11-04", "2026-12-31",
    ]);
  });

  it("2027: the moved weekends of 2 and 3 January and 20 February, holidays that fell on a weekend", () => {
    expect(weekdaysOff("2027")).toEqual([
      "2027-01-01", "2027-01-04", "2027-01-05", "2027-01-06", "2027-01-07", "2027-01-08",
      "2027-02-22", "2027-02-23", "2027-03-08", "2027-05-03", "2027-05-10", "2027-06-14", "2027-11-04", "2027-11-05", "2027-12-31",
    ]);
    expect(calendar.daysOff.has("2027-02-20")).toBe(false);
  });

  it("covers 2026 and 2027 only", () => {
    expect([calendar.from, calendar.to]).toEqual(["2026-01-01", "2027-12-31"]);
  });
});

describe("parseCalendar refuses an inconsistent file", () => {
  const holidays = { url: "https://a.ru/tk", days: [{ day: "01-01", name: "Новый год", shiftIfWeekend: false }, { day: "03-08", name: "8 марта", shiftIfWeekend: true }] };
  const year = (patch: Record<string, unknown> = {}) => ({ year: 2026, checkedAt: "2026-10-21", decree: "ПП", url: "https://a.ru/pp", transfers: [], ...patch });
  const load = (years: unknown[], h: unknown = holidays) => parseCalendar({ holidays: h, years });

  it("accepts a minimal file and moves a holiday weekend to the next workday", () => {
    const { calendar: c, urls } = load([year()]);
    expect(urls).toEqual(["https://a.ru/tk", "https://a.ru/pp"]);
    expect(c.daysOff.has("2026-03-09")).toBe(true); // 8 March 2026 is a Sunday
  });

  it("refuses a transfer from a weekday", () => {
    expect(() => load([year({ transfers: [{ from: "2026-09-02", to: "2026-09-05" }] })])).toThrow(CalendarValidationError);
  });

  it("refuses a transfer to a day that is already off", () => {
    expect(() => load([year({ transfers: [{ from: "2026-01-03", to: "2026-01-10" }] })])).toThrow(/уже нерабочий/);
  });

  it("refuses a gap between years", () => {
    expect(() => load([year(), year({ year: 2028, transfers: [] })])).toThrow(/подряд/);
  });

  it("refuses a link that is not https", () => {
    expect(() => load([year({ url: "http://a.ru/pp" })])).toThrow(/https/);
  });

  it("refuses a holiday that does not exist", () => {
    expect(() => load([year()], { ...holidays, days: [{ day: "02-30", name: "x", shiftIfWeekend: false }] })).toThrow(/ММ-ДД/);
  });
});
