import { describe, expect, it } from "vitest";

import { buildPlan } from "../src/core/deadlines.js";
import { parseRuleSet, RuleValidationError } from "../src/data/loadRules.js";
import type { UserProfile } from "../src/core/types.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };

const ruleSet = parseRuleSet(raw);

describe("файл норм ru-student.json", () => {
  it("проходит валидацию", () => {
    expect(ruleSet.rules.length).toBeGreaterThan(0);
  });

  it("у каждого правила есть ссылка на норму, редакция и дата сверки", () => {
    for (const rule of ruleSet.rules) {
      expect(rule.legal.url, rule.id).toMatch(/^https:\/\//);
      expect(rule.legal.article, rule.id).not.toHaveLength(0);
      expect(rule.legal.edition, rule.id).not.toHaveLength(0);
      expect(rule.legal.checkedAt, rule.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("все нормы пока не вычитаны юристом — продукт обязан показывать их как предварительные", () => {
    // Когда вычитка пройдена, этот тест падает и его меняют вместе со статусами
    // в JSON. Так изменение статуса нельзя протащить молча.
    for (const rule of ruleSet.rules) {
      expect(rule.legal.status, rule.id).toBe("draft");
    }
  });

  it("граждане Беларуси исключены из всех правил", () => {
    const belarus: UserProfile = { citizenship: "BY", purpose: "study", entryDate: "2026-09-01" };
    expect(buildPlan(ruleSet.rules, belarus, {}, "2026-09-16")).toEqual([]);
  });
});

describe("переходное правило по дате въезда", () => {
  const base = { citizenship: "KZ", purpose: "study" } as const;

  it("въехавшему после 31.08.2026 медосвидетельствование считается по новому сроку", () => {
    const plan = buildPlan(ruleSet.rules, { ...base, entryDate: "2026-09-01" }, {}, "2026-09-16");
    const ids = plan.map((i) => i.ruleId);
    expect(ids).toContain("medical-examination");
    expect(ids).not.toContain("medical-examination-transitional");
  });

  it("въехавшему до 01.09.2026 не выдаёт неподтверждённый план", () => {
    const plan = buildPlan(ruleSet.rules, { ...base, entryDate: "2026-08-15" }, {}, "2026-09-16");
    const ids = plan.map((i) => i.ruleId);
    expect(ids).not.toContain("medical-examination-transitional");
    expect(ids).not.toContain("medical-examination");
  });

  it("две версии медосвидетельствования никогда не применяются одновременно", () => {
    for (const entryDate of ["2026-07-01", "2026-08-31", "2026-09-01", "2026-10-15"]) {
      const ids = buildPlan(ruleSet.rules, { ...base, entryDate }, {}, "2026-09-16").map((i) => i.ruleId);
      const applied = ids.filter((id) => id.startsWith("medical-examination"));
      expect(applied, entryDate).toHaveLength(entryDate >= "2026-09-01" ? 1 : 0);
    }
  });

  it("сроки медосвидетельствования и дактилоскопии различаются — это и есть исходная проблема", () => {
    const plan = buildPlan(ruleSet.rules, { ...base, entryDate: "2026-09-01" }, {}, "2026-09-16");
    const medical = plan.find((i) => i.ruleId === "medical-examination");
    const fingerprints = plan.find((i) => i.ruleId === "fingerprinting");
    expect(medical?.dueDate).toBe("2026-10-01");
    expect(fingerprints?.dueDate).toBe("2026-11-30");
    expect(medical?.dueDate).not.toBe(fingerprints?.dueDate);
  });
});

describe("parseRuleSet", () => {
  const valid = {
    version: "2026-09-16",
    rules: [
      {
        id: "r1",
        title: { ru: "П", en: "P" },
        action: { ru: "С", en: "D" },
        term: { event: "entry", days: 30, counting: "dayAfterEvent" },
        appliesIf: [],
        documents: [],
        legal: {
          act: "А",
          article: "ст. 1",
          url: "https://example.org",
          edition: "ред.",
          checkedAt: "2026-09-16",
          status: "draft",
        },
      },
    ],
  };

  it("принимает корректный набор", () => {
    expect(parseRuleSet(valid).rules).toHaveLength(1);
  });

  it("отвергает approved без указания, кто проверил", () => {
    const broken = structuredClone(valid);
    broken.rules[0]!.legal.status = "approved";
    expect(() => parseRuleSet(broken)).toThrow(RuleValidationError);
  });

  it("принимает approved с reviewedBy", () => {
    const ok = structuredClone(valid) as typeof valid & { rules: [{ legal: Record<string, string> }] };
    ok.rules[0]!.legal.status = "approved";
    ok.rules[0]!.legal.reviewedBy = "Юрист";
    expect(parseRuleSet(ok).rules[0]?.legal.reviewedBy).toBe("Юрист");
  });

  it("отвергает повторяющийся id", () => {
    const broken = structuredClone(valid);
    broken.rules.push(structuredClone(valid.rules[0]!));
    expect(() => parseRuleSet(broken)).toThrow(/повторяющийся id/);
  });

  it("отвергает нулевой и отрицательный срок", () => {
    for (const days of [0, -5, 1.5]) {
      const broken = structuredClone(valid);
      broken.rules[0]!.term.days = days;
      expect(() => parseRuleSet(broken), String(days)).toThrow(RuleValidationError);
    }
  });

  it("отвергает неизвестное поле условия", () => {
    const broken = structuredClone(valid) as unknown as { rules: { appliesIf: unknown[] }[] };
    broken.rules[0]!.appliesIf = [{ field: "hairColor", op: "eq", value: "рыжий" }];
    expect(() => parseRuleSet(broken)).toThrow(/неизвестное поле условия/);
  });

  it("отвергает некорректную дату сверки", () => {
    const broken = structuredClone(valid);
    broken.rules[0]!.legal.checkedAt = "16.09.2026";
    expect(() => parseRuleSet(broken)).toThrow(RuleValidationError);
  });

  it("отвергает пропущенный перевод", () => {
    const broken = structuredClone(valid) as unknown as { rules: { title: Record<string, string> }[] };
    delete broken.rules[0]!.title.en;
    expect(() => parseRuleSet(broken)).toThrow(RuleValidationError);
  });
});
