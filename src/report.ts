import { existsSync } from "node:fs";
import { Store } from "./bot/store.js";
import { funnelReport } from "./bot/funnel.js";

// Read-only for the operator: prints anonymous funnel totals from the bot database.
const path = process.env.DB_PATH ?? "./data/bot.sqlite";
if (!existsSync(path)) { console.error(`Нет базы ${path}: задайте DB_PATH.`); process.exit(1); }
const store = new Store(path);
try { console.log(funnelReport(store.funnel())); } finally { store.close(); }
