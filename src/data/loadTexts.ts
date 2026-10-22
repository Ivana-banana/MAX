/**
 * Interface texts, one JSON file per language in src/data/i18n. Adding a language is
 * adding a file (plus its names in rules and university profiles), not editing the dialogue.
 *
 * A key is either plain ("btn.plan") or a plural form ("days#one"): the forms a language
 * needs come from Intl.PluralRules, so Russian has one/few/many/other and English one/other.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeSet, DeadlineRule, Lang } from "../core/types.js";
import type { University } from "./loadUniversities.js";

/** Language code → key → text. The base language (ru) comes first, then en, then the rest. */
export type Texts = Map<Lang, Record<string, string>>;
export const BASE_LANG = "ru";

export class TextsValidationError extends Error {
  constructor(path: string, problem: string) {
    super(`Тексты интерфейса невалидны (${path}): ${problem}`);
    this.name = "TextsValidationError";
  }
}

const base = (key: string) => key.split("#")[0]!;
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]!).sort().join(",");
// ICU has no plural rules for some languages (tt): Intl then silently uses the host locale, so a ru_RU server
// would demand Russian forms. Such a language takes the English one/other rule explicitly, whatever the host (#87).
const pluralRules = (lang: Lang) => new Intl.PluralRules(Intl.PluralRules.supportedLocalesOf([lang]).length ? lang : "en");
export const pluralForms = (lang: Lang) => pluralRules(lang).resolvedOptions().pluralCategories;

export function parseTexts(lang: Lang, raw: unknown, path = lang): Record<string, string> {
  // "no" is also the scope screen's answer button, so it cannot name a language action.
  if (!/^[a-z]{2}$/.test(lang) || lang === "no") throw new TextsValidationError(path, "имя файла — код языка ISO 639-1");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TextsValidationError(path, "ожидается объект");
  const texts: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("$")) continue;
    if (typeof value !== "string" || !value.trim()) throw new TextsValidationError(`${path}.${key}`, "ожидается непустая строка");
    // An unclosed **…** or *…* (#114) would leave stars in plain channels and turn the rest of a chat message bold or italic.
    if ((value.match(/\*\*/g)?.length ?? 0) % 2) throw new TextsValidationError(`${path}.${key}`, "незакрытое выделение **");
    if ((value.replaceAll("**", "").match(/\*/g)?.length ?? 0) % 2) throw new TextsValidationError(`${path}.${key}`, "незакрытый курсив *");
    texts[key] = value;
  }
  return texts;
}

/** Every language has the base language's keys, the same placeholders and all its own plural forms. */
export function checkTexts(texts: Texts): void {
  const reference = texts.get(BASE_LANG);
  if (!reference) throw new TextsValidationError(BASE_LANG, "нет базового языка");
  const expected = new Set(Object.keys(reference).map(base));
  const slots = (table: Record<string, string>, key: string) =>
    [...new Set(Object.entries(table).filter(([k]) => base(k) === key).flatMap(([, v]) => placeholders(v).split(",")))].sort().join(",");
  for (const [lang, table] of texts) {
    const keys = new Set(Object.keys(table).map(base));
    const missing = [...expected].filter(k => !keys.has(k)), extra = [...keys].filter(k => !expected.has(k));
    if (missing.length || extra.length) throw new TextsValidationError(lang, `ключи не совпадают с ${BASE_LANG}: нет ${missing.join(", ") || "—"}; лишние ${extra.join(", ") || "—"}`);
    for (const key of expected) {
      // "{n}" in plural forms may be written out ("остался один день") only where a language wants it; others must match.
      const own = slots(table, key).split(",").filter(x => x !== "n"), ref = slots(reference, key).split(",").filter(x => x !== "n");
      if (own.join() !== ref.join()) throw new TextsValidationError(`${lang}.${key}`, `подстановки ${own.join(", ") || "—"} вместо ${ref.join(", ") || "—"}`);
      const forms = Object.keys(table).filter(k => base(k) === key && k.includes("#")).map(k => k.split("#")[1]!);
      if (!forms.length) continue;
      const need: string[] = [...pluralForms(lang)];
      if (need.some(f => !forms.includes(f)) || forms.some(f => !need.includes(f))) {
        throw new TextsValidationError(`${lang}.${key}`, `формы множественного числа ${forms.join(", ")} вместо ${need.join(", ")}`);
      }
    }
  }
}

export function readTexts(dir: string): Texts {
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  const order = (lang: string) => lang === BASE_LANG ? "0" : lang === "en" ? "1" : "2" + lang;
  const texts: Texts = new Map(files.map(f => f.slice(0, -5)).sort((a, b) => order(a).localeCompare(order(b)))
    .map(lang => [lang, parseTexts(lang, JSON.parse(readFileSync(join(dir, `${lang}.json`), "utf8")), `${lang}.json`)]));
  checkTexts(texts);
  return texts;
}

/** Rules and university names must exist in every interface language, or a card would show a hole. */
export function checkTranslated(texts: Texts, rules: DeadlineRule[], universities: University[]): void {
  const localized = [
    ...rules.flatMap(r => [[`${r.id}.title`, r.title], [`${r.id}.action`, r.action], [`${r.id}.legal.article`, r.legal.article],
      ...(r.consequence ? [[`${r.id}.consequence.text`, r.consequence.text], [`${r.id}.consequence.article`, r.consequence.article]] : []),
      ...r.documents.map(d => [`${r.id}.documents.${d.id}`, d.title])]),
    ...universities.map(u => [`${u.id}.name`, u.name]),
    ...universities.flatMap(u => u.procedures.flatMap(p => [[`${u.id}.${p.id}.title`, p.title],
      [`${u.id}.${p.id}.action`, p.action], [`${u.id}.${p.id}.when`, p.when],
      ...p.documents.map(d => [`${u.id}.${p.id}.documents.${d.id}`, d.title])])),
    ...universities.flatMap(u => Object.entries(u.rulePlaces).map(([id, place]) => [`${u.id}.rulePlaces.${id}.where`, place.where])),
    ...universities.flatMap(u => u.beforeEntry.flatMap(c => [[`${u.id}.beforeEntry.${c.id}.title`, c.title],
      [`${u.id}.beforeEntry.${c.id}.text`, c.text], ...(c.assumption ? [[`${u.id}.beforeEntry.${c.id}.assumption`, c.assumption]] : [])])),
    ...universities.flatMap(u => Object.entries(u.changeTerms).map(([id, term]) => [`${u.id}.changeTerms.${id}.words`, term.words])),
  ] as [string, Record<string, string>][];
  for (const lang of texts.keys()) {
    const hole = localized.find(([, value]) => !value[lang]?.trim());
    if (hole) throw new TextsValidationError(lang, `нет перевода для ${hole[0]}`);
  }
}

/** The changes of circumstances (#41) in every interface language, like the rules. */
export function checkTranslatedChanges(texts: Texts, changes: ChangeSet): void {
  const localized = [["filing.article", changes.filing.article],
    ...changes.situations.flatMap(s => [[`${s.id}.title`, s.title], [`${s.id}.norm`, s.norm], [`${s.id}.legal.article`, s.legal.article],
      ...(s.event ? [[`${s.id}.event`, s.event]] : []), ...(s.assumption ? [[`${s.id}.assumption`, s.assumption]] : [])])] as [string, Record<string, string>][];
  for (const lang of texts.keys()) {
    const hole = localized.find(([, value]) => !value[lang]?.trim());
    if (hole) throw new TextsValidationError(lang, `нет перевода для ${hole[0]}`);
  }
}

/** Text by key with {placeholders}; a number `n` picks the plural form. */
export function format(texts: Texts, lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  const table = texts.get(lang) ?? texts.get(BASE_LANG)!;
  const n = vars.n;
  const text = typeof n === "number" && table[`${key}#other`] !== undefined
    ? table[`${key}#${pluralRules(lang).select(n)}`] ?? table[`${key}#other`]
    : table[key];
  if (text === undefined) throw new Error(`Missing text: ${lang}.${key}`);
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}
