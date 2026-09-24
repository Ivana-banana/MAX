import { Pool } from "pg";
import { PostgresStore } from "./db/postgres-store.js";
import { funnelReport } from "./bot/funnel.js";

// For the operator: prints anonymous funnel totals from the bot database.
const url = process.env.DATABASE_URL;
if (!url) { console.error("Задайте DATABASE_URL базы бота."); process.exit(1); }
const store = await PostgresStore.open(new Pool({ connectionString: url }));
try { console.log(funnelReport(await store.funnel())); } finally { await store.close(); }
