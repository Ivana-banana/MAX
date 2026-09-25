import { describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readUniversities } from "../src/data/loadUniversities.js";
import { readTexts } from "../src/data/loadTexts.js";
import { coverage } from "../src/core/deadlines.js";
import { transition, type DialogueContext, type Session } from "../src/bot/dialog.js";

const rules = parseRuleSet(raw);
const base: DialogueContext = { rules: rules.rules, universities: readUniversities("src/data/universities", "kfu"),
  texts: readTexts("src/data/i18n"), version: rules.version, demo: true, today: "2026-09-24" };
function walk(ctx: DialogueContext, until: "citizenship" | "entry", citizenship = "KZ") {
  let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
  let last = transition(null, { text: "/start", callback: false }, ctx).reply;
  const click = (action: string) => { const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx); s = r.session!; last = r.reply; };
  for (const a of ["ru", "accept", "yes"]) click(a);
  if (until === "entry") click(citizenship);
  return { get s() { return s; }, get reply() { return last; },
    type: (text: string) => { const r = transition(s, { text, callback: false }, ctx); s = r.session!; last = r.reply; } };
}

describe("segment bounds come from the rules, not from the dialogue code", () => {
  it("reads the earliest entry date and the excluded citizenships from the rule conditions", () => {
    expect(coverage(rules.rules)).toEqual({ from: "2026-09-01", excluded: ["BY"] });
  });
  it("a new period and exclusion change the questions without touching src/bot", () => {
    // A hypothetical next intake: entries from 2027-01-15, Armenia excluded as well.
    const next = rules.rules.map(r => ({ ...r, appliesIf: r.appliesIf.map(c =>
      c.field === "entryDate" ? { ...c, value: "2027-01-15" } : c.field === "citizenship" && c.op === "notIn" ? { ...c, values: ["BY", "AM"] } : c) }));
    const ctx = { ...base, rules: next, today: "2027-02-01" };
    const choose = walk(ctx, "citizenship");
    expect(choose.reply.buttons.flat().map(b => b.text).slice(-3)).toEqual(["Беларусь", "Армения", "Другое"]);
    const entry = walk(ctx, "entry");
    expect(entry.reply.text).toContain("с 15 января 2027 г. по сегодня");
    entry.type("2027-01-10");
    expect(entry.reply.text).toContain("Дата вне сценария");
    entry.type("20.01.2027");
    expect(entry.s.entryDate).toBe("2027-01-20");
    const help = walk(ctx, "citizenship");
    expect(transition(help.s, { text: `${help.s.nonce}.${help.s.revision}|AM`, callback: true }, ctx).reply.text).toContain("Для неподдержанного случая");
  });
});

describe("dates people can read and type", () => {
  it("shows countries by name and accepts DD.MM.YYYY for entry and completion", () => {
    const flow = walk(base, "citizenship");
    expect(flow.reply.buttons.flat().map(b => b.text)).toContain("Казахстан");
    const entry = walk(base, "entry");
    entry.type("1.9.2026");
    expect(entry.s.entryDate).toBe("2026-09-01");
    expect(entry.reply.text).toContain("Медицинское освидетельствование: 30 сентября 2026 г. — скоро, осталось 6 дней");
    const s = entry.s;
    const r1 = transition(s, { text: `${s.nonce}.${s.revision}|done:medical-examination`, callback: true }, base);
    const r2 = transition(r1.session!, { text: "20.09.2026", callback: false }, base);
    expect(r2.session!.completions["medical-examination"]).toBe("2026-09-20");
    expect(transition(r1.session!, { text: "31.02.2026", callback: false }, base).reply.text).toContain("Нужна дата между въездом и сегодня");
  });
});

describe("where the checklist comes from", () => {
  it("names the published list and its check date, or says plainly that there is none", () => {
    const entry = walk(base, "entry");
    entry.type("01.09.2026");
    const s = entry.s;
    const card = (id: string) => transition(s, { text: `${s.nonce}.${s.revision}|card:${id}`, callback: true }, base).reply.text;
    expect(card("medical-examination")).toContain("Комплект — по странице https://kpfu.ru/international/migracionnoe-soprovozhdenie-inostrannyh-grazhdan/daktiloskopiya-i-medicinskoe-osvidetelstvovanie (сверено 24 сентября 2026 г.)");
    expect(card("medical-examination")).toContain("Результаты ранее пройденных обследований — если есть");
    expect(card("medical-examination")).not.toContain("Миграционная карта");
    expect(card("fingerprinting")).toContain("Официальный перечень документов не опубликован: паспорт нужен всегда, остальное уточните у КФУ.");
  });
  it("rejects a checklist source that is not an https page", () => {
    const broken = structuredClone(raw) as { rules: { documentsSource?: { url: string } }[] };
    broken.rules[0]!.documentsSource!.url = "http://kpfu.ru/";
    expect(() => parseRuleSet(broken)).toThrow(/https/);
  });
});
