import { Pool } from "pg";
import { PostgresStore } from "./db/postgres-store.js";
import { loadRules, loadTexts, loadUniversities, readConfig } from "./bot/config.js";
import { moscowDate } from "./bot/service.js";
import { officeReport, officeSnapshot } from "./bot/office.js";

// For the operator: npm run office -- <university id> prints the anonymous summary for that
// university's international office (D-042). No MAX ID, entry date or citizenship leaves the database.
const config = readConfig();
const rules = loadRules(config), universities = loadUniversities(config);
const ctx = { rules: rules.rules, universities, texts: loadTexts(config, rules.rules, universities), version: rules.version,
  demo: config.mode === "demo", today: moscowDate(Date.now()) };
const id = process.argv[2] ?? config.defaultUniversity;
if (!universities.some(u => u.id === id)) { console.error(`Нет профиля вуза «${id}». Есть: ${universities.map(u => u.id).join(", ")}.`); process.exit(1); }
const store = await PostgresStore.open(new Pool({ connectionString: config.databaseUrl }));
try {
  const snapshot = officeSnapshot((await store.sessions()).map(s => s.state), ctx);
  console.log(officeReport(snapshot, await store.funnel(), ctx, id));
} finally { await store.close(); }
