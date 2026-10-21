import { describe, expect, it } from "vitest";
import { planProgress } from "../src/core/progress.js";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import { transition, type DialogueContext, type Session } from "../src/bot/dialog.js";
import type { PlanItemStatus } from "../src/core/types.js";

const item = (status: PlanItemStatus, isRepeat = false) => ({ status, isRepeat });

describe("planProgress", () => {
  it("counts the passed ones of all, and the next is the first open one", () => {
    const [a, b, c] = [item("done"), item("dueSoon"), item("ok")];
    expect(planProgress([a, b, c])).toEqual({ done: 1, total: 3, next: b });
  });

  it("counts a repeat round as passed and never offers it as the next step", () => {
    const repeat = item("ok", true), open = item("overdue");
    expect(planProgress([repeat, open])).toEqual({ done: 1, total: 2, next: open });
  });

  it("has no next step once everything is passed", () => {
    expect(planProgress([item("done"), item("ok", true)])).toEqual({ done: 2, total: 2 });
  });

  it("has nothing to count in an empty plan", () => {
    expect(planProgress([])).toEqual({ done: 0, total: 0 });
  });
});

const rules = parseRuleSet(raw);
const texts = readTexts("src/data/i18n");
const ctx: DialogueContext = { rules: rules.rules, universities: readUniversities("src/data/universities", "kfu"),
  texts, version: rules.version, demo: true, today: "2026-09-24" };

/** A chat that entered on 03.09.2026 and marked the given procedures on 24.09.2026; returns its plan. */
function chat(lang: string, marked: string[]) {
  let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
  const click = (action: string) => { const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx); s = r.session!; return r.reply; };
  const type = (text: string) => { const r = transition(s, { text, callback: false }, ctx); s = r.session!; return r.reply; };
  for (const a of [lang, "accept", "yes", "KZ"]) click(a);
  type("03.09.2026");
  for (const id of marked) { click(`card:${id}`); click(`done:${id}`); type("24.09.2026"); }
  return click("plan");
}

describe("the plan in the chat opens with the progress", () => {
  it("says how many are passed and puts the nearest step on the first button", () => {
    const plan = chat("ru", ["medical-examination"]);
    expect(plan.text).toContain("Пройдено 1 из 2. Ближайший шаг — Дактилоскопия");
    expect(plan.buttons[1]![0]!.text).toBe("➡ Ближайший шаг: Дактилоскопия и фотографирование");
  });

  it("says that all are marked once they are, and offers no step", () => {
    const plan = chat("ru", ["medical-examination", "fingerprinting"]);
    expect(plan.text).toContain("Пройдено 2 из 2. Все процедуры отмечены");
    expect(plan.buttons.flat().some(b => b.text.startsWith("➡"))).toBe(false);
  });

  it("is worded from the texts of every language", () => {
    for (const lang of texts.keys()) {
      const t = texts.get(lang)!;
      expect(chat(lang, []).text, lang).toContain(t["progress.line"]!.replace("{done}", "0").replace("{total}", "2"));
    }
  });
});
