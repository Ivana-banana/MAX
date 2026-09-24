import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readUniversities } from "../src/data/loadUniversities.js";
import { checkTexts, checkTranslated, format, parseTexts, readTexts, type Texts } from "../src/data/loadTexts.js";
import { transition, type DialogueContext, type Session } from "../src/bot/dialog.js";

const texts = readTexts("src/data/i18n");
const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");

// A third language built only from data: interface file, rule texts and university names.
function withUzbek(): DialogueContext {
  const en = texts.get("en")!;
  const uz = Object.fromEntries(Object.entries(en).map(([k, v]) => [k, k === "language.name" ? "Oʻzbekcha" : `[uz] ${v}`]));
  const all: Texts = new Map([...texts, ["uz", uz]]);
  const tr = (l: Record<string, string>) => ({ ...l, uz: `[uz] ${l.en}` });
  const uzRules = rules.rules.map(r => ({ ...r, title: tr(r.title), action: tr(r.action),
    documents: r.documents.map(d => ({ ...d, title: tr(d.title) })) }));
  const uzUniversities = universities.map(u => ({ ...u, name: tr(u.name) }));
  checkTexts(all); checkTranslated(all, uzRules, uzUniversities);
  return { rules: uzRules, universities: uzUniversities, texts: all, version: rules.version, demo: true, today: "2026-09-24" };
}

describe("interface texts live in data", () => {
  it("has the same keys, placeholders and needed plural forms in every language", () => {
    expect([...texts.keys()]).toEqual(["ru", "en"]);
    expect(() => checkTexts(texts)).not.toThrow();
    expect(() => checkTranslated(texts, rules.rules, universities)).not.toThrow();
  });
  it("rejects a file that would show a hole or a broken sentence", () => {
    const ru = texts.get("ru")!, en = texts.get("en")!;
    const broken = (patch: Record<string, string | undefined>) => {
      const table = { ...en, ...patch } as Record<string, string>;
      for (const k of Object.keys(patch)) if (patch[k] === undefined) delete table[k];
      return () => checkTexts(new Map([["ru", ru], ["en", table]]));
    };
    expect(broken({ "btn.plan": undefined })).toThrow(/нет btn.plan/);
    expect(broken({ "btn.extra": "x" })).toThrow(/лишние btn.extra/);
    expect(broken({ "card.confirm": "Confirm with the university: " })).toThrow(/подстановки — вместо uni/);
    expect(broken({ "days#few": "{n} days" })).toThrow(/формы множественного числа/);
    expect(() => parseTexts("no", {})).toThrow(/код языка/);
    expect(() => parseTexts("de", { "btn.plan": " " })).toThrow(/непустая строка/);
  });
  it("picks plural forms by the rules of each language", () => {
    const days = (lang: string, n: number) => format(texts, lang, "days", { n });
    expect([1, 2, 5, 11, 21, 22, 25].map(n => days("ru", n))).toEqual(["1 день", "2 дня", "5 дней", "11 дней", "21 день", "22 дня", "25 дней"]);
    expect([1, 2].map(n => days("en", n))).toEqual(["1 day", "2 days"]);
    expect(format(texts, "ru", "left", { n: 1 })).toBe("остался 1 день");
  });
  it("keeps the dialogue and calendar code free of user-facing Russian text", () => {
    for (const file of ["src/bot/dialog.ts", "src/bot/calendar.ts"]) {
      const code = readFileSync(file, "utf8").split("\n").filter(line => !line.trim().startsWith("//"));
      expect(code.filter(line => /[А-Яа-яЁё]/.test(line)), file).toEqual([]);
    }
  });
  it("adds a language with data files only: button, MAX locale, plan and card", () => {
    const ctx = withUzbek();
    const first = transition(null, { text: "/start", callback: false }, ctx);
    expect(first.reply.buttons.flat().map(b => b.text)).toEqual(["Русский", "English", "Oʻzbekcha"]);
    let s: Session = transition(null, { text: "/start", callback: false, locale: "uz-UZ" }, ctx).session!;
    expect(s.lang).toBe("uz");
    const click = (action: string) => { const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx); s = r.session!; return r.reply; };
    for (const a of ["accept", "yes", "KZ"]) click(a);
    const home = transition(s, { text: "2026-09-01", callback: false }, ctx);
    s = home.session!;
    expect(home.reply.text).toContain("[uz] Your preparation plan");
    expect(home.reply.text).toContain("[uz] Medical examination: 2026-09-30 — [uz] due soon, [uz] 6 days left");
    expect(click("card:medical-examination").text).toContain("[uz] \nConfirm location and checklist with [uz] KFU: ");
  });
});
