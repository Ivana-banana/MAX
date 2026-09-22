import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/core/deadlines.js";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };

describe("audit regressions", () => {
  it("rejects a completion event until an explicit base date contract exists", () => {
    const input = structuredClone(raw);
    input.rules[0]!.term.event = "completion";
    expect(() => parseRuleSet(input)).toThrow(/entry/);
  });
  it("keeps the annual target separate from the end of the repeat window", () => {
    const { rules } = parseRuleSet(raw);
    const plan = buildPlan(rules,
      { citizenship: "KZ", purpose: "study", entryDate: "2026-09-01" },
      { "medical-examination": "2026-09-20" }, "2027-09-21");
    expect(plan.find(x => x.ruleId === "medical-examination")?.status).not.toBe("overdue");
    expect(plan.find(x => x.ruleId === "medical-examination")?.dueDate).toBe("2027-10-20");
  });
});
