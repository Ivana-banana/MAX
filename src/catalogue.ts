/**
 * Check of the university catalogue for whoever adds a university (docs/add-university.md):
 * the same validation the bot runs at startup, plus what each profile gives a student and
 * which data is getting old. Pure: the CLI in src/university-check.ts only prints the result.
 */

import { buildPlan, coverage } from "./core/deadlines.js";
import { daysBetween } from "./core/dates.js";
import type { DeadlineRule } from "./core/types.js";
import { loadRules, loadTexts, loadUniversities, type Config } from "./bot/config.js";
import type { Texts } from "./data/loadTexts.js";
import type { University } from "./data/loadUniversities.js";

/** A contact page or a procedure source older than this is flagged for a new check. */
export const MAX_SOURCE_AGE_DAYS = 180;

export interface CatalogueCheck { lines: string[]; warnings: string[] }

export function catalogueReport(rules: DeadlineRule[], universities: University[], texts: Texts, today: string): CatalogueCheck {
  const lines: string[] = [], warnings: string[] = [];
  const { from } = coverage(rules);
  const age = (id: string, what: string, checkedAt: string) => {
    const days = daysBetween(checkedAt, today);
    if (days > MAX_SOURCE_AGE_DAYS) warnings.push(`${id}: ${what} сверены ${checkedAt} — ${days} дн. назад, сверьте заново`);
  };
  for (const u of universities) {
    lines.push(`${u.id} — ${u.name.ru}: ${[...texts.keys()].map(l => u.name[l]).join(" / ")}; диплинк ?start=${u.id}`,
      `  контакты: ${u.contactUrl} (сверено ${u.checkedAt})`,
      `  гражданства: ${u.citizenships.join(", ")}`,
      `  без расчётного срока: ${u.procedures.length ? u.procedures.map(p => `${p.id} (${p.source.url})`).join(", ") : "нет"}`,
      `  раньше закона: ${Object.keys(u.ruleTargets).length ? Object.entries(u.ruleTargets).map(([id, t]) => `${id} — ${t.days} дн. (${t.source.url})`).join(", ") : "нет"}`,
      `  до въезда: ${u.beforeEntry.length ? u.beforeEntry.map(c => `${c.id} (${c.source.url})`).join(", ") : "нет"}`);
    age(u.id, "контакты", u.checkedAt);
    for (const p of u.procedures) age(u.id, `источник «${p.id}»`, p.source.checkedAt);
    for (const c of u.beforeEntry) age(u.id, `источник «${c.id}» (до въезда)`, c.source.checkedAt);
    for (const citizenship of u.citizenships) {
      const items = buildPlan(rules, { citizenship, entryDate: from, purpose: "study" }, {}, from);
      if (!items.length) warnings.push(`${u.id}: для гражданства ${citizenship} не применяется ни одна норма — студент получит пустой план`);
      else if (citizenship === u.citizenships[0]) {
        lines.push(`  пример (${citizenship}, въезд ${from}): ${items.map(i => `${i.ruleId} → ${i.dueDate}`).join(", ")}`);
      }
    }
  }
  return { lines, warnings };
}

/** Loads rules, profiles and texts exactly as the bot does and reports on the catalogue; throws on an invalid profile. */
export function checkCatalogue(
  paths: Pick<Config, "rulesPath" | "universitiesPath" | "defaultUniversity" | "textsPath">, today: string,
): CatalogueCheck {
  const rules = loadRules({ rulesPath: paths.rulesPath, mode: "demo" }).rules;
  const universities = loadUniversities(paths);
  return catalogueReport(rules, universities, loadTexts(paths, rules, universities), today);
}
