import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities, type University } from "../src/data/loadUniversities.js";
import { catalogueReport, checkCatalogue } from "../src/catalogue.js";
import { coverage } from "../src/core/deadlines.js";
import { plan, transition, undated, type Reply, type Session } from "../src/bot/dialog.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const TODAY = "2026-09-24";
const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: TODAY };
const paths = { rulesPath: "src/data/rules/ru-student.json", universitiesPath: "src/data/universities", defaultUniversity: "kfu", textsPath: "src/data/i18n" };

/** A copy of the catalogue in a temporary directory, with one profile replaced. */
function catalogueWith(file: string, profile: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "unis-"));
  for (const u of universities) writeFileSync(join(dir, `${u.id}.json`), readFileSync(`src/data/universities/${u.id}.json`));
  writeFileSync(join(dir, file), JSON.stringify(profile));
  return dir;
}

describe("npm run university:check", () => {
  it("accepts the committed catalogue and says what each profile gives a student", () => {
    const { lines, warnings } = checkCatalogue(paths, TODAY);
    expect(warnings).toEqual([]);
    for (const u of universities) {
      expect(lines.join("\n")).toContain(`${u.id} — ${u.name.ru}`);
      expect(lines.join("\n")).toContain(`?start=${u.id}`);
    }
    // An example plan per profile shows the dates a student would get.
    expect(lines.join("\n")).toMatch(/medical-examination → 2026-09-30/);
  });

  it("names the file and the field of a broken profile", () => {
    const dir = catalogueWith("itmo.json", { id: "itmo", name: { ru: "ИТМО" }, contactUrl: "http://int.itmo.ru", citizenships: ["KZ"], checkedAt: "2026-09-23" });
    expect(() => checkCatalogue({ ...paths, universitiesPath: dir }, TODAY)).toThrow(/itmo\.json.*contactUrl.*https/);
  });

  it("refuses a profile whose name is missing in an interface language, as the bot does at startup", () => {
    const dir = catalogueWith("itmo.json", { id: "itmo", name: { ru: "ИТМО" }, contactUrl: "https://int.itmo.ru", citizenships: ["KZ"], checkedAt: "2026-09-23" });
    expect(() => checkCatalogue({ ...paths, universitiesPath: dir }, TODAY)).toThrow(/itmo/);
  });

  it("warns when a profile or a procedure source has not been checked for half a year", () => {
    const stale: University = { ...universities.find(u => u.id === "kfu")!, checkedAt: "2026-01-10" };
    const { warnings } = catalogueReport(rules.rules, [stale], texts, TODAY);
    expect(warnings).toEqual([expect.stringMatching(/kfu: контакты сверены 2026-01-10 — 257 дн\. назад/)]);
  });

  it("warns about a citizenship for which no rule applies: the student would get an empty plan", () => {
    const odd: University = { ...universities[0]!, citizenships: [...universities[0]!.citizenships, "BY"] };
    const { warnings } = catalogueReport(rules.rules, [odd], texts, TODAY);
    expect(warnings.some(w => w.includes("BY"))).toBe(true);
  });
});

/** The chat from a university's deep link to the plan, as a student would go. */
function onboard(university: string, citizenship: string, entry: string, lang = "ru") {
  let s: Session = transition(null, { text: `/start ${university}`, callback: false }, ctx).session!;
  let last!: Reply;
  const click = (action: string) => {
    const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);
    s = r.session!; last = r.reply;
  };
  for (const a of [lang, "accept", "yes", citizenship]) click(a);
  const home = transition(s, { text: entry, callback: false }, ctx);
  s = home.session!; last = home.reply;
  return { session: s, reply: last, click: (a: string) => { click(a); return last; } };
}

describe("every profile of the catalogue, every citizenship, the boundary entry dates", () => {
  const { from } = coverage(rules.rules);
  const cases = universities.flatMap(u => u.citizenships.flatMap(c => [from, TODAY].map(entry => [u.id, c, entry] as const)));

  it.each(cases)("%s · %s · entry %s: a plan with dates, the university's own contacts and procedures", (id, citizenship, entry) => {
    const u = universities.find(x => x.id === id)!;
    const f = onboard(id, citizenship, entry);
    expect(f.session.step).toBe("plan");
    expect(f.session.university).toBe(id);
    const items = plan(f.session, ctx);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.dueDate > entry).toBe(true);
    // The help question names this university and links to its page, never the default one's.
    const help = f.click(`help:${items[0]!.ruleId}`);
    expect(help.text).toContain(u.name.ru!);
    expect(help.buttons.flat().some(b => "url" in b && b.url === u.contactUrl)).toBe(true);
    // Procedures without a deadline come from this profile only.
    for (const note of undated(f.session, ctx)) expect(u.procedures.map(p => p.id)).toContain(note.id);
  });

  it.each(universities.flatMap(u => [...texts.keys()].map(lang => [u.id, lang] as const)))(
    "%s in %s: the plan names the university and leaves no placeholder", (id, lang) => {
      const f = onboard(id, universities.find(u => u.id === id)!.citizenships[0]!, from, lang);
      const card = f.click(`card:${plan(f.session, ctx)[0]!.ruleId}`);
      expect(card.text).toContain(universities.find(u => u.id === id)!.name[lang]!);
      expect(card.text).not.toMatch(/\{[a-z]+\}/);
    });
});
