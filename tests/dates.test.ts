import { describe, expect, it } from "vitest";

import { addDays, addMonths, compareDates, daysBetween, InvalidDateError, isValidDate, parseDate } from "../src/core/dates.js";

describe("parseDate", () => {
  it("принимает корректную дату", () => {
    expect(parseDate("2026-09-16")).toEqual({ year: 2026, month: 9, day: 16 });
  });

  it.each(["2026-9-16", "16.09.2026", "2026/09/16", "", "не дата"])(
    "отвергает неверный формат: %s",
    (value) => {
      expect(() => parseDate(value)).toThrow(InvalidDateError);
    },
  );

  it("отвергает несуществующий день вместо молчаливого переноса на следующий месяц", () => {
    expect(() => parseDate("2026-02-30")).toThrow(InvalidDateError);
    expect(() => parseDate("2026-13-01")).toThrow(InvalidDateError);
  });

  it("принимает 29 февраля в високосный год и отвергает в обычный", () => {
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
  });
});

describe("addDays", () => {
  it("прибавляет дни через границу месяца", () => {
    expect(addDays("2026-09-01", 30)).toBe("2026-10-01");
  });

  it("прибавляет дни через границу года", () => {
    expect(addDays("2026-12-25", 10)).toBe("2027-01-04");
  });

  it("вычитает дни при отрицательном сдвиге", () => {
    expect(addDays("2026-10-01", -7)).toBe("2026-09-24");
  });
});

describe("addMonths", () => {
  it("прибавляет месяцы", () => {
    expect(addMonths("2026-09-16", 12)).toBe("2027-09-16");
  });

  it("не перескакивает в следующий месяц, если в целевом меньше дней", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  });
});

describe("daysBetween", () => {
  it("считает целые дни", () => {
    expect(daysBetween("2026-09-01", "2026-10-01")).toBe(30);
  });

  it("возвращает отрицательное число для прошедшей даты", () => {
    expect(daysBetween("2026-10-01", "2026-09-24")).toBe(-7);
  });

  it("возвращает ноль для одной и той же даты", () => {
    expect(daysBetween("2026-09-16", "2026-09-16")).toBe(0);
  });
});

describe("compareDates", () => {
  it("упорядочивает даты", () => {
    expect(compareDates("2026-09-01", "2026-09-02")).toBeLessThan(0);
    expect(compareDates("2026-09-02", "2026-09-01")).toBeGreaterThan(0);
    expect(compareDates("2026-09-01", "2026-09-01")).toBe(0);
  });
});
