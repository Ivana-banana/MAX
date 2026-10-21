import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseRuleSet } from "./data/loadRules.js";
import { checkCitizenships, checkProcedures, checkRuleTargets, readUniversities } from "./data/loadUniversities.js";
import { coverage } from "./core/deadlines.js";
import { checkTranslated, readTexts } from "./data/loadTexts.js";
import { scratchSchema, startDevPostgres } from "./db/dev-postgres.js";
import { Service, moscowDate } from "./bot/service.js";
import { loadChanges } from "./bot/config.js";
import { addDays } from "./core/dates.js";
import type { Reply } from "./bot/dialog.js";

const scripted = process.argv.includes("--script");
const rules = parseRuleSet(JSON.parse(readFileSync("./src/data/rules/ru-student.json", "utf8")));
const universities = readUniversities("./src/data/universities", "kfu");
const texts = readTexts("./src/data/i18n");
checkTranslated(texts, rules.rules, universities);
checkCitizenships(universities, coverage(rules.rules).excluded);
checkProcedures(universities, rules.rules.map(r => r.id));
checkRuleTargets(universities, rules.rules);
const changes = loadChanges({ changesPath: "./src/data/rules/ru-change.json", calendarPath: "./src/data/calendar/ru.json", mode: "demo" }, texts, universities);
// Synthetic profile in a temporary schema, dropped on exit: inside Compose it is the bot's DATABASE_URL,
// locally a throwaway PostgreSQL (embedded-postgres, dev dependency).
const dev = process.env.DATABASE_URL ? undefined : await startDevPostgres();
const schema = await scratchSchema(process.env.DATABASE_URL ?? dev!.url);
const { store } = await schema.open();
let last: Reply;
let reminderCount = 0;
const clock = scripted ? () => Date.parse("2026-09-24T10:00:00+03:00") : Date.now;
const service = new Service(store, { rules: rules.rules, universities, texts, version: rules.version, demo: true, ...(changes ? { changes } : {}) }, {
  send(_user, reply) {
    last = reply;
    if (reply.text.includes("Напоминание:")) reminderCount++;
    console.log("\n[MOCKED: MAX transport] " + reply.text);
    if (reply.file) console.log(`[MOCKED: MAX file upload] ${reply.file.name}, ${reply.file.content.length} bytes`);
    reply.buttons.flat().forEach((b, i) => console.log(`${i + 1}. ${b.text}` +
      ("url" in b ? ` → ${b.url}` : "copy" in b ? " → [MOCKED: copied to clipboard]" : "")));
    return Promise.resolve();
  },
}, clock);
async function act(text: string, callback = false) {
  await service.receive({ id: randomUUID(), user: 1, input: { text, callback } });
  await service.flush();
}
try {
  if (scripted) {
    console.log("[MOCKED: clock frozen at 2026-09-24 for repeatable demonstration]");
    // Entry day counts toward the 30-day term, so the 7-day reminder falls on the frozen day.
    const entry = addDays(moscowDate(clock()), -22);
    if (entry < "2026-09-01") throw new Error("Demo date must fall within the supported period");
    for (const text of ["/start", "ru", "accept", "yes", "KZ", entry, "card:medical-examination",
      "doc:medical-examination:passport", "plan", "reminders"]) await act(text);
    await service.maintain(); await service.flush();
    if (reminderCount !== 1) throw new Error("Expected exactly one due reminder");
    for (const text of ["done:medical-examination", "/today", "/stop"]) await act(text);
    if (!(await store.get(1))?.completions["medical-examination"]) throw new Error("Demo did not complete");
    console.log("\nDemo completed: progress saved, reminder delivered, completion recorded, reminders stopped.");
  } else {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    console.log("Учебный профиль. Введите номер кнопки или текст. /exit завершает; /delete удаляет профиль.");
    try {
      await act("/start");
      for (;;) {
        const text = await terminal.question("> ");
        if (text === "/exit") break;
        const option = /^\d+$/.test(text) ? last!.buttons.flat()[Number(text) - 1] : undefined;
        if (option && !("action" in option)) {
          console.log("url" in option ? option.url : "copy" in option ? option.copy : `[open_app ${option.app} startapp=${option.payload}]`);
          continue;
        }
        await act(option?.action ?? text, option !== undefined);
      }
    } finally { terminal.close(); }
  }
} finally { await store.close(); await schema.drop(); await dev?.stop(); }
