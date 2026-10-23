import { describe, expect, it } from "vitest";
import { buildPlan, reminderDates } from "../src/core/deadlines.js";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { checkRuleTargets, parseUniversity, readUniversities } from "../src/data/loadUniversities.js";
import { transition, type Session } from "../src/bot/dialog.js";
import { plain } from "../src/core/markup.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };
const profile = { citizenship: "KZ", entryDate: "2026-09-01", purpose: "study" as const };

function planned(start: string) {
  let s: Session = transition(null, { text: start, callback: false }, ctx).session!;
  const click = (action: string) => {
    const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);
    s = r.session!; return r.reply;
  };
  for (const a of ["ru", "accept", "yes", "KZ"]) click(a);
  s = transition(s, { text: "2026-09-01", callback: false }, ctx).session!;
  return { click };
}

describe("a university deadline earlier than the law (D-043)", () => {
  it("adds the earlier date as a target and keeps the legal deadline and its reminders", () => {
    const plain = buildPlan(rules.rules, profile, {}, "2026-09-24");
    const withTarget = buildPlan(rules.rules, profile, {}, "2026-09-24", { fingerprinting: 30 });
    const f = withTarget.find(i => i.ruleId === "fingerprinting")!;
    expect(f.recommendedDate).toBe("2026-09-30");
    expect(f.dueDate).toBe(plain.find(i => i.ruleId === "fingerprinting")!.dueDate);
    expect(reminderDates(f, "2026-09-24")).toEqual(reminderDates(plain.find(i => i.ruleId === "fingerprinting")!, "2026-09-24"));
    expect(withTarget.find(i => i.ruleId === "medical-examination")!.recommendedDate).toBeUndefined();
  });

  it("drops the target once the procedure is done", () => {
    const f = buildPlan(rules.rules, profile, { fingerprinting: "2026-09-20" }, "2026-09-24", { fingerprinting: 30 })
      .find(i => i.ruleId === "fingerprinting")!;
    expect(f.status).toBe("done");
    expect(f.recommendedDate).toBeUndefined();
  });

  it("shows ITMO's 30 days for fingerprinting next to the legal 90, with the source", () => {
    const card = planned("/start itmo").click("card:fingerprinting");
    expect(plain(card.text)).toContain("Расчётный предельный срок: 29 ноября 2026 г.");
    expect(card.text).toContain("ИТМО просит раньше: до 30 сентября 2026 г.");
    expect(card.text).toContain("по странице ИТМО");
  });

  it("does not add a target where the university's page gives none", () => {
    for (const start of ["/start", "/start spbgeu"]) {
      expect(planned(start).click("card:fingerprinting").text).not.toContain("просит раньше");
    }
  });

  it("refuses a university term that is not earlier than the law, e.g. 90 days for the medical examination", () => {
    const base = { id: "u", name: { ru: "У" }, contactUrl: "https://u.ru", citizenships: ["KZ"], checkedAt: "2026-09-29" };
    const source = { url: "https://u.ru", checkedAt: "2026-09-30" };
    const weaker = parseUniversity({ ...base, ruleTargets: { "medical-examination": { days: 90, source } } });
    expect(() => checkRuleTargets([weaker], rules.rules)).toThrow(/ослаб/);
    const same = parseUniversity({ ...base, ruleTargets: { "medical-examination": { days: 30, source } } });
    expect(() => checkRuleTargets([same], rules.rules)).toThrow(/ослаб|раньше/);
    const unknown = parseUniversity({ ...base, ruleTargets: { nope: { days: 5, source } } });
    expect(() => checkRuleTargets([unknown], rules.rules)).toThrow(/nope/);
    expect(() => parseUniversity({ ...base, ruleTargets: { fingerprinting: { days: 30 } } })).toThrow(/source/);
    expect(() => parseUniversity({ ...base, ruleTargets: { fingerprinting: { days: 0, source } } })).toThrow(/days/);
    expect(() => checkRuleTargets(universities, rules.rules)).not.toThrow();
  });
});
