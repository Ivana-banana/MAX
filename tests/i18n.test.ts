import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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
  const kkRules = rules.rules.map(r => ({ ...r, title: tr(r.title), action: tr(r.action), legal: { ...r.legal, article: tr(r.legal.article) },
    ...(r.consequence ? { consequence: { ...r.consequence, text: tr(r.consequence.text), article: tr(r.consequence.article) } } : {}),
    documents: r.documents.map(d => ({ ...d, title: tr(d.title) })) }));
  const kkUniversities = universities.map(u => ({ ...u, name: tr(u.name),
    procedures: u.procedures.map(p => ({ ...p, title: tr(p.title), action: tr(p.action), when: tr(p.when),
      documents: p.documents.map(d => ({ ...d, title: tr(d.title) })) })),
    rulePlaces: Object.fromEntries(Object.entries(u.rulePlaces).map(([id, place]) => [id, { ...place, where: tr(place.where) }])),
    beforeEntry: u.beforeEntry.map(c => ({ ...c, title: tr(c.title), text: tr(c.text), ...(c.assumption ? { assumption: tr(c.assumption) } : {}) })),
    changeTerms: Object.fromEntries(Object.entries(u.changeTerms).map(([id, term]) => [id, { ...term, words: tr(term.words) }])) }));
  checkTexts(all); checkTranslated(all, kkRules, kkUniversities);
  return { rules: kkRules, universities: kkUniversities, texts: all, version: rules.version, demo: true, today: "2026-09-24" };
}

// #114, step 2: laid out in Russian first, as the team asked; the other languages follow. A key leaves
// this list once every language has its layout — then the test above checks it as well.
const RUSSIAN_ONLY = [
  "card.visit",
  "card.deadline", "card.consequence", "card.overdue", "card.when", "card.place", "card.uniTarget", "card.window",
  "card.byDate", "card.endPassed", "calendar.intro", "help.unsupported", "help.unsupported.scope",
  "help.unsupported.citizenship", "help.unsupported.other", "help.unsupported.ask", "help.generic", "help.intro",
  "help.intro.overdue", "help.contacts", "university.gone", "university.choose", "university.missing", "completion",
  "completion.invalid", "docEnd.visa-end", "docEnd.registration-end", "docEnd.invalid", "home.undatedDue",
  "procedure.reminder", "visit", "visit.invalid", "visit.saved", "visit.late", "visit.remindOn", "visit.remindOff",
  "visit.reminder", "delete", "deleted", "expired", "limited", "stopped", "stoppedNoPlan", "rulesChanged", "reminder",
  "reminder.overdue", "beforeEntry.title", "beforeEntry.next", "pdf.intro", "pdf.failed", "change.choose", "change.noPlan",
  "change.date", "change.invalid", "change.saved", "change.federal", "change.federalWords", "change.law",
  "change.university", "change.universityWords", "change.due.both", "change.due.one", "change.now", "change.dueWords",
  "change.handover.university", "change.handover.place", "change.handover.passport", "change.closed", "change.reminder",
  "change.off", "home.change", "home.changeWords",
] as const;

describe("interface texts live in data", () => {
  it("has the same keys, placeholders and needed plural forms in every language", () => {
    expect([...texts.keys()]).toEqual(["ru", "en", "tt", "uz", "zh"]);
    expect(() => checkTexts(texts)).not.toThrow();
    expect(() => checkTranslated(texts, rules.rules, universities)).not.toThrow();
  });
  it("lays out every text the same way in every language: bold, italics, list items, line breaks (#114)", () => {
    const layout = (v: string) => ({ bold: v.split("**").length - 1, italic: v.replaceAll("**", "").split("*").length - 1,
      items: v.split("•").length - 1, lines: v.split("\n").length - 1 });
    const reference = texts.get("ru")!;
    const formatted = Object.keys(reference).filter(k => reference[k]!.includes("*") && !(RUSSIAN_ONLY as readonly string[]).includes(k));
    for (const [lang, table] of texts) for (const key of formatted) expect(layout(table[key]!), `${lang}.${key}`).toEqual(layout(reference[key]!));
  });
  it("gives no fixed example date for a day from today on, which would fall in the past (#97)", () => {
    for (const [lang, t] of texts) for (const key of ["visit.invalid", "docEnd.invalid"])
      expect(t[key], `${lang} ${key}`).not.toMatch(/\d{2}\.\d{2}\.\d{4}/);
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
  it("does not take plural rules from the host locale for a language ICU lacks (tt, #87)", () => {
    // ICU has no Tatar rules: Intl falls back to the process locale, so a ru_RU host turned tt into Russian forms.
    const script = `import { readTexts, pluralForms, format } from "./src/data/loadTexts.ts";
      const texts = readTexts("src/data/i18n");
      console.log(JSON.stringify([pluralForms("tt"), pluralForms("ru"), format(texts, "tt", "days", { n: 5 }) === texts.get("tt")["days#other"].replace("{n}", "5")]));`;
    for (const locale of ["ru_RU.UTF-8", "en_US.UTF-8"]) {
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, LANG: locale, LC_ALL: locale }, encoding: "utf8" });
      expect(JSON.parse(out), locale).toEqual([["one", "other"], ["one", "few", "many", "other"], true]);
    }
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
    expect(first.reply.buttons.flat().map(b => b.text)).toEqual(["Русский", "English", "Татарча", "Oʻzbekcha", "中文", "Qazaqşa"]);
    let s: Session = transition(null, { text: "/start", callback: false, locale: "kk-KZ" }, ctx).session!;
    expect(s.lang).toBe("kk");
    const click = (action: string) => { const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx); s = r.session!; return r.reply; };
    for (const a of ["accept", "yes", "KZ"]) click(a);
    const home = transition(s, { text: "2026-09-01", callback: false }, ctx);
    s = home.session!;
    expect(home.reply.text).toContain("[kk] **Your preparation plan**");
    expect(home.reply.text).toContain("**[kk] Medical examination**\n  **2026 ж. 30 қыркүйек** — [kk] due soon, [kk] 6 days left");
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
    expect(zh.home).toContain("**体检（医学检查）**\n  **2026年9月30日** — 即将到期，还剩6天");
    expect(zh.card).toContain("请向喀山联邦大学确认地点和材料清单");
    const uz = run("uz");
    expect(uz.home).toContain("**Tibbiy koʻrik**\n  **30-sentabr, 2026** — yaqin, 6 kun qoldi");
    expect(format(texts, "uz", "left", { n: 1 })).toBe("1 kun qoldi");
    expect(format(texts, "zh", "days", { n: 21 })).toBe("21天");
  });
});
