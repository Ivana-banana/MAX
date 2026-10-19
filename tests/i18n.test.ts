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

// One more language built only from data: interface file, rule texts and university names.
function withKazakh(): DialogueContext {
  const en = texts.get("en")!;
  const kk = Object.fromEntries(Object.entries(en).map(([k, v]) => [k, k === "language.name" ? "Qazaqşa" : `[kk] ${v}`]));
  const all: Texts = new Map([...texts, ["kk", kk]]);
  const tr = (l: Record<string, string>) => ({ ...l, kk: `[kk] ${l.en}` });
  const kkRules = rules.rules.map(r => ({ ...r, title: tr(r.title), action: tr(r.action),
    documents: r.documents.map(d => ({ ...d, title: tr(d.title) })) }));
  const kkUniversities = universities.map(u => ({ ...u, name: tr(u.name),
    procedures: u.procedures.map(p => ({ ...p, title: tr(p.title), action: tr(p.action), when: tr(p.when),
      documents: p.documents.map(d => ({ ...d, title: tr(d.title) })) })),
    rulePlaces: Object.fromEntries(Object.entries(u.rulePlaces).map(([id, place]) => [id, { ...place, where: tr(place.where) }])),
    beforeEntry: u.beforeEntry.map(c => ({ ...c, title: tr(c.title), text: tr(c.text), ...(c.assumption ? { assumption: tr(c.assumption) } : {}) })) }));
  checkTexts(all); checkTranslated(all, kkRules, kkUniversities);
  return { rules: kkRules, universities: kkUniversities, texts: all, version: rules.version, demo: true, today: "2026-09-24" };
}

describe("interface texts live in data", () => {
  it("has the same keys, placeholders and needed plural forms in every language", () => {
    expect([...texts.keys()]).toEqual(["ru", "en", "uz", "zh"]);
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
    const ctx = withKazakh();
    const first = transition(null, { text: "/start", callback: false }, ctx);
    expect(first.reply.buttons.flat().map(b => b.text)).toEqual(["Русский", "English", "Oʻzbekcha", "中文", "Qazaqşa"]);
    let s: Session = transition(null, { text: "/start", callback: false, locale: "kk-KZ" }, ctx).session!;
    expect(s.lang).toBe("kk");
    const click = (action: string) => { const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx); s = r.session!; return r.reply; };
    for (const a of ["accept", "yes", "KZ"]) click(a);
    const home = transition(s, { text: "2026-09-01", callback: false }, ctx);
    s = home.session!;
    expect(home.reply.text).toContain("[kk] Your preparation plan");
    expect(home.reply.text).toContain("[kk] Medical examination: 2026 ж. 30 қыркүйек — [kk] due soon, [kk] 6 days left");
    expect(click("card:medical-examination").text).toContain("[kk] \nConfirm location and checklist with [kk] KFU: ");
  });
  it("speaks Chinese and Uzbek from MAX locale through the plan, card and reminder", () => {
    const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };
    const run = (locale: string) => {
      let s: Session = transition(null, { text: "/start", callback: false, locale }, ctx).session!;
      const click = (action: string) => { const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx); s = r.session!; return r.reply; };
      for (const a of ["accept", "yes", "KZ"]) click(a);
      const home = transition(s, { text: "2026-09-01", callback: false }, ctx); s = home.session!;
      return { lang: s.lang, home: home.reply.text, card: click("card:medical-examination").text };
    };
    const zh = run("zh-CN");
    expect(zh.lang).toBe("zh");
    expect(zh.home).toContain("体检（医学检查）: 2026年9月30日 — 即将到期，还剩6天");
    expect(zh.card).toContain("请向喀山联邦大学确认地点和材料清单");
    const uz = run("uz");
    expect(uz.home).toContain("Tibbiy koʻrik: 30-sentabr, 2026 — yaqin, 6 kun qoldi");
    expect(format(texts, "uz", "left", { n: 1 })).toBe("1 kun qoldi");
    expect(format(texts, "zh", "days", { n: 21 })).toBe("21天");
  });
});
