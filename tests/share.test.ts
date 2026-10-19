import { describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import { shareText, transition, type Session } from "../src/bot/dialog.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };

function planned(lang = "ru", start = "/start"): Session {
  let s: Session = transition(null, { text: start, callback: false }, ctx).session!;
  for (const a of [lang, "accept", "yes", "KZ"]) s = transition(s, { text: `${s.nonce}.${s.revision}|${a}`, callback: true }, ctx).session!;
  return transition(s, { text: "2026-09-01", callback: false }, ctx).session!;
}

describe("sharing the plan from the mini app (shareMaxContent)", () => {
  it("lists the procedures with their deadlines in words, the university and the caveats", () => {
    const text = shareText(planned(), ctx);
    expect(text).toContain("ДЕМО");
    expect(text).toContain("КФУ");
    expect(text).toContain("Медицинское освидетельствование — до 30 сентября 2026 г.");
    expect(text).toContain("Дактилоскопия и фотографирование — до 29 ноября 2026 г.");
    expect(text).not.toContain("не вычитаны юристом");
  });

  it("says a one-off procedure is done once marked, instead of repeating its deadline", () => {
    let s = planned();
    s = transition(s, { text: `${s.nonce}.${s.revision}|card:fingerprinting`, callback: true }, ctx).session!;
    s = transition(s, { text: `${s.nonce}.${s.revision}|done:fingerprinting`, callback: true }, ctx).session!;
    s = transition(s, { text: "2026-09-20", callback: false }, ctx).session!;
    expect(shareText(s, ctx)).toMatch(/Дактилоскопия и фотографирование — пройдено/);
  });

  it("carries no citizenship, entry date or MAX identifiers", () => {
    const text = shareText(planned(), ctx);
    expect(text).not.toContain("Казахстан");
    expect(text).not.toContain("1 сентября");
    expect(text).not.toMatch(/\bKZ\b/);
  });

  it("is written in the student's language, without placeholders", () => {
    for (const lang of texts.keys()) {
      const text = shareText(planned(lang, "/start itmo"), ctx);
      expect(text).toContain(universities.find(u => u.id === "itmo")!.name[lang]!);
      expect(text).not.toMatch(/\{[a-z]+\}/);
    }
  });

  it("is empty before a plan exists", () => {
    expect(shareText(transition(null, { text: "/start", callback: false }, ctx).session!, ctx)).toBe("");
  });
});
