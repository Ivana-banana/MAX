import { describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import { transition, type DialogueContext, type Session } from "../src/bot/dialog.js";

const rules = parseRuleSet(raw);
const texts = readTexts("src/data/i18n");
const ctx: DialogueContext = { rules: rules.rules, universities: readUniversities("src/data/universities", "kfu"),
  texts, version: rules.version, demo: true, today: "2026-09-24" };

/** A chat that entered on 03.09.2026 and marked the medical examination done on 24.09.2026. */
function afterDone(lang = "ru") {
  let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
  const click = (action: string) => { const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx); s = r.session!; return r.reply; };
  const type = (text: string) => { const r = transition(s, { text, callback: false }, ctx); s = r.session!; return r.reply; };
  for (const a of [lang, "accept", "yes", "KZ"]) click(a);
  type("03.09.2026");
  click("card:medical-examination"); click("done:medical-examination"); type("24.09.2026");
  return { click, type };
}

describe("a marked yearly procedure is shown as a repeat", () => {
  it("plan: the label with the period from the data and the date it was done", () => {
    const plan = afterDone().click("plan").text;
    expect(plan).toContain("• Медицинское освидетельствование, повторно (ежегодно): 24 октября 2027 г.");
    expect(plan).toContain("пройдено вами 24 сентября 2026 г.");
  });

  it("card: the same two facts, once", () => {
    const card = afterDone().click("card:medical-examination").text;
    expect(card).toContain("Повторно (ежегодно). Пройдено вами 24 сентября 2026 г.");
  });

  it("a first round has neither", () => {
    const f = afterDone();
    const line = f.click("plan").text.split("\n").find(l => l.startsWith("• Дактилоскопия"))!;
    expect(line).not.toContain("овторно");
    expect(f.click("card:fingerprinting").text).not.toContain("овторно");
  });

  it("every language words it from its own texts", () => {
    for (const lang of texts.keys()) {
      const reply = afterDone(lang).click("plan").text;
      const t = texts.get(lang)!;
      expect(reply, lang).toContain(t["repeat.label"]!.replace("{period}", t["repeat.yearly"]!));
    }
  });
});
