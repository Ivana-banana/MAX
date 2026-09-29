import { checkCatalogue } from "./catalogue.js";

// Tool for whoever adds a university (docs/add-university.md), run locally without a database:
// npm run university:check. Exit code 1 — a profile the bot would refuse at startup.
const env = process.env;
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date());
try {
  const { lines, warnings } = checkCatalogue({
    rulesPath: env.RULES_PATH ?? "./src/data/rules/ru-student.json",
    universitiesPath: env.UNIVERSITIES_PATH ?? "./src/data/universities",
    defaultUniversity: env.DEFAULT_UNIVERSITY ?? "kfu",
    textsPath: env.TEXTS_PATH ?? "./src/data/i18n",
  }, today);
  console.log(lines.join("\n"));
  for (const w of warnings) console.warn(`⚠ ${w}`);
  console.log(`\nКаталог принят: бот запустится с этими профилями.${warnings.length ? ` Предупреждений: ${warnings.length}.` : ""}`);
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
