import { describe, expect, it } from "vitest";

import { buildPlan, computeDueDate, isApplicable, reminderDates } from "../src/core/deadlines.js";
import type { DeadlineRule, UserProfile } from "../src/core/types.js";

const legal = {
  act: "Тестовый акт",
  article: { ru: "ст. 1", en: "Art. 1" },
  url: "https://example.org",
  edition: "ред. от 01.01.2026",
  checkedAt: "2026-09-16",
  status: "draft" as const,
};

function rule(overrides: Partial<DeadlineRule> = {}): DeadlineRule {
  return {
    id: "r1",
    title: { ru: "Процедура", en: "Procedure" },
    action: { ru: "Сделать", en: "Do" },
    term: { event: "entry", days: 30, counting: "dayAfterEvent" },
    appliesIf: [],
    documents: [],
    legal,
    ...overrides,
  };
}

const profile: UserProfile = {
  citizenship: "KZ",
  purpose: "study",
  entryDate: "2026-09-01",
};

describe("isApplicable", () => {
  it("правило без условий применимо всегда", () => {
    expect(isApplicable(rule(), profile)).toBe(true);
  });

  it("notIn исключает перечисленные гражданства", () => {
    const r = rule({ appliesIf: [{ field: "citizenship", op: "notIn", values: ["BY"] }] });
    expect(isApplicable(r, profile)).toBe(true);
    expect(isApplicable(r, { ...profile, citizenship: "BY" })).toBe(false);
  });

  it("purpose сравнивается точно", () => {
    const r = rule({ appliesIf: [{ field: "purpose", op: "eq", value: "study" }] });
    expect(isApplicable(r, profile)).toBe(true);
    expect(isApplicable(r, { ...profile, purpose: "work" })).toBe(false);
  });

  it("onOrAfter включает саму граничную дату", () => {
    const r = rule({ appliesIf: [{ field: "entryDate", op: "onOrAfter", value: "2026-09-01" }] });
    expect(isApplicable(r, { ...profile, entryDate: "2026-09-01" })).toBe(true);
    expect(isApplicable(r, { ...profile, entryDate: "2026-08-31" })).toBe(false);
  });

  it("before не включает граничную дату", () => {
    const r = rule({ appliesIf: [{ field: "entryDate", op: "before", value: "2026-09-01" }] });
    expect(isApplicable(r, { ...profile, entryDate: "2026-08-31" })).toBe(true);
    expect(isApplicable(r, { ...profile, entryDate: "2026-09-01" })).toBe(false);
  });

  it("условия соединяются логическим И", () => {
    const r = rule({
      appliesIf: [
        { field: "citizenship", op: "notIn", values: ["BY"] },
        { field: "purpose", op: "eq", value: "study" },
      ],
    });
    expect(isApplicable(r, { ...profile, citizenship: "BY" })).toBe(false);
    expect(isApplicable(r, { ...profile, purpose: "work" })).toBe(false);
  });
});

describe("computeDueDate", () => {
  it("dayAfterEvent: день въезда не входит в срок", () => {
    const r = rule({ term: { event: "entry", days: 30, counting: "dayAfterEvent" } });
    expect(computeDueDate(r, profile)).toBe("2026-10-01");
  });

  it("eventDay: день въезда считается первым днём срока", () => {
    const r = rule({ term: { event: "entry", days: 30, counting: "eventDay" } });
    expect(computeDueDate(r, profile)).toBe("2026-09-30");
  });

  it("два способа отсчёта дают разные даты — поэтому способ задаётся в данных", () => {
    const after = computeDueDate(rule({ term: { event: "entry", days: 30, counting: "dayAfterEvent" } }), profile);
    const on = computeDueDate(rule({ term: { event: "entry", days: 30, counting: "eventDay" } }), profile);
    expect(after).not.toBe(on);
  });

  it("падает на некорректной дате въезда, а не выдаёт мусорный срок", () => {
    expect(() => computeDueDate(rule(), { ...profile, entryDate: "01.09.2026" })).toThrow();
  });
});

describe("buildPlan", () => {
  const medical = rule({ id: "medical", term: { event: "entry", days: 30, counting: "dayAfterEvent" }, repeat: { months: 12 } });
  const fingerprints = rule({ id: "fingerprints", term: { event: "entry", days: 90, counting: "dayAfterEvent" } });

  it("сортирует по близости срока", () => {
    const plan = buildPlan([fingerprints, medical], profile, {}, "2026-09-16");
    expect(plan.map((i) => i.ruleId)).toEqual(["medical", "fingerprints"]);
  });

  it("пропускает неприменимые правила", () => {
    const belarus = rule({ id: "x", appliesIf: [{ field: "citizenship", op: "notIn", values: ["BY"] }] });
    const plan = buildPlan([belarus], { ...profile, citizenship: "BY" }, {}, "2026-09-16");
    expect(plan).toEqual([]);
  });

  it("считает статусы от сегодняшней даты", () => {
    const plan = buildPlan([medical, fingerprints], profile, {}, "2026-09-28");
    const byId = Object.fromEntries(plan.map((i) => [i.ruleId, i]));
    expect(byId.medical?.status).toBe("dueSoon");
    expect(byId.medical?.daysLeft).toBe(3);
    expect(byId.fingerprints?.status).toBe("ok");
  });

  it("помечает просроченное отрицательным daysLeft", () => {
    const plan = buildPlan([medical], profile, {}, "2026-10-05");
    expect(plan[0]?.status).toBe("overdue");
    expect(plan[0]?.daysLeft).toBe(-4);
  });

  it("граница dueSoon — ровно 7 дней", () => {
    expect(buildPlan([medical], profile, {}, "2026-09-24")[0]?.status).toBe("dueSoon");
    expect(buildPlan([medical], profile, {}, "2026-09-23")[0]?.status).toBe("ok");
  });

  it("выполненное неповторяющееся правило остаётся как done", () => {
    const plan = buildPlan([fingerprints], profile, { fingerprints: "2026-09-10" }, "2026-09-16");
    expect(plan[0]?.status).toBe("done");
    expect(plan[0]?.isRepeat).toBe(false);
  });

  it("выполненное повторяющееся правило превращается в следующий срок от даты выполнения", () => {
    const plan = buildPlan([medical], profile, { medical: "2026-09-20" }, "2026-09-25");
    expect(plan[0]?.isRepeat).toBe(true);
    expect(plan[0]?.dueDate).toBe("2027-09-20");
    expect(plan[0]?.status).toBe("ok");
  });

  it("повторный круг помнит дату отметки и период из правила, первый круг — нет", () => {
    const plan = buildPlan([medical], profile, { medical: "2026-09-20" }, "2026-09-25");
    expect(plan[0]?.repeat).toEqual({ completedAt: "2026-09-20", months: medical.repeat!.months });
    expect(buildPlan([medical], profile, {}, "2026-09-25")[0]?.repeat).toBeUndefined();
  });

  it("выполненные опускаются в конец списка", () => {
    const plan = buildPlan([medical, fingerprints], profile, { fingerprints: "2026-09-10" }, "2026-09-16");
    expect(plan.at(-1)?.ruleId).toBe("fingerprints");
  });

  it("правило со статусом draft помечается как предварительное", () => {
    expect(buildPlan([medical], profile, {}, "2026-09-16")[0]?.provisional).toBe(true);
  });

  it("правило, проверенное юристом, предварительным не помечается", () => {
    const approved = rule({ legal: { ...legal, status: "approved", reviewedBy: "Юрист" } });
    expect(buildPlan([approved], profile, {}, "2026-09-16")[0]?.provisional).toBe(false);
  });
});

describe("reminderDates", () => {
  const medical = rule({ id: "medical" });

  it("даёт напоминания за 7, 3 и 1 день", () => {
    const [item] = buildPlan([medical], profile, {}, "2026-09-16");
    expect(reminderDates(item!, "2026-09-16")).toEqual(["2026-09-24", "2026-09-28", "2026-09-30"]);
  });

  it("не назначает напоминаний на прошедшие даты", () => {
    const [item] = buildPlan([medical], profile, {}, "2026-09-29");
    expect(reminderDates(item!, "2026-09-29")).toEqual(["2026-09-30"]);
  });

  it("у просроченного срока напоминаний не остаётся", () => {
    const [item] = buildPlan([medical], profile, {}, "2026-10-05");
    expect(reminderDates(item!, "2026-10-05")).toEqual([]);
  });

  it("выполненному правилу не напоминаем", () => {
    const fingerprints = rule({ id: "fingerprints" });
    const [item] = buildPlan([fingerprints], profile, { fingerprints: "2026-09-10" }, "2026-09-16");
    expect(reminderDates(item!, "2026-09-16")).toEqual([]);
  });
});
