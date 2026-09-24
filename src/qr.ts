import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRuleSet } from "./data/loadRules.js";
import { readUniversities } from "./data/loadUniversities.js";
import { checkTranslated, readTexts } from "./data/loadTexts.js";
import { deepLink, posterSvg } from "./poster.js";

// Operator tool, run locally without a database: npm run qr -- kfu itmo (no ids — every university profile).
const env = process.env;
const rules = parseRuleSet(JSON.parse(readFileSync(env.RULES_PATH ?? "./src/data/rules/ru-student.json", "utf8")));
const universities = readUniversities(env.UNIVERSITIES_PATH ?? "./src/data/universities", env.DEFAULT_UNIVERSITY ?? "kfu");
const texts = readTexts(env.TEXTS_PATH ?? "./src/data/i18n");
checkTranslated(texts, rules.rules, universities);
const botLink = env.BOT_LINK ?? "https://max.ru/t149_hakaton_max_bot";
const dir = env.POSTERS_DIR ?? "./posters";
const ids = process.argv.slice(2);
const unknown = ids.filter(id => !universities.some(u => u.id === id));
if (unknown.length) { console.error(`Нет профиля вуза: ${unknown.join(", ")}. Есть: ${universities.map(u => u.id).join(", ")}.`); process.exit(1); }
mkdirSync(dir, { recursive: true });
for (const u of universities.filter(u => !ids.length || ids.includes(u.id))) {
  const file = join(dir, `${u.id}.svg`);
  writeFileSync(file, posterSvg(u, texts, { botLink, demo: (env.APP_MODE ?? "demo") !== "live" }));
  console.log(`${file} → ${deepLink(botLink, u)}`);
}
