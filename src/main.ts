import { Pool } from "pg";
import { readConfig, loadRules, loadTexts, loadUniversities, webappDevLaunch } from "./bot/config.js";
import { PostgresStore } from "./db/postgres-store.js";
import { Service } from "./bot/service.js";
import { RateLimit } from "./bot/rate.js";
import { createTransport } from "./bot/transport.js";
import { webhookServer } from "./bot/server.js";
import { webappRouter } from "./webapp/router.js";

const config = readConfig();
const rules = loadRules(config);
const universities = loadUniversities(config);
const texts = loadTexts(config, rules.rules, universities);
const pool = new Pool({ connectionString: config.databaseUrl });
// An idle connection dropped by PostgreSQL must not crash the process; the pool reconnects on the next query.
pool.on("error", () => { console.error("PostgreSQL connection lost; the pool will reconnect."); });
// Migrates the schema before the webhook accepts anything; a failure exits and Docker restarts the bot.
const store = await PostgresStore.open(pool);
const service = new Service(store, { rules: rules.rules, universities, texts, version: rules.version, demo: config.mode === "demo",
  ...(config.webappBot ? { webApp: config.webappBot } : {}) }, createTransport(config), Date.now, new RateLimit(config.rateLimit), config.sendTimeoutMs);
const webapp = webappRouter(service, { token: config.token, dir: config.webappDir,
  devLaunch: webappDevLaunch(config), devOrigin: config.webappDevOrigin });
const server = webhookServer(service, config.secret, webapp, config.deployedCommit);
server.requestTimeout = 10000;
server.headersTimeout = 10000;
let active: Promise<void> | undefined;
const timer = setInterval(() => {
  if (active) return;
  active = service.tick()
    .catch(() => { console.error("Queue processing failed; inspect storage and health counters."); })
    .finally(() => { active = undefined; });
}, 1000);
server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ event: "started", mode: config.mode, transport: config.transport, port: config.port,
    webapp: config.webappDir }));
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.close(() => { void Promise.resolve(active).finally(() => store.close()).finally(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 15000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
