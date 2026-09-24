import { readConfig, loadRules, loadUniversities } from "./bot/config.js";
import { Store } from "./bot/store.js";
import { Service } from "./bot/service.js";
import { createTransport } from "./bot/transport.js";
import { webhookServer } from "./bot/server.js";

const config = readConfig();
const rules = loadRules(config);
const universities = loadUniversities(config);
const store = new Store(config.dbPath);
const service = new Service(store, { rules: rules.rules, universities, version: rules.version, demo: config.mode === "demo" }, createTransport(config));
const server = webhookServer(service, config.secret);
server.requestTimeout = 10000;
server.headersTimeout = 10000;
service.maintain();
let maintenance = Date.now();
let active: Promise<void> | undefined;
const timer = setInterval(() => {
  if (active) return;
  try {
    if (Date.now() - maintenance > 60000) { service.maintain(); maintenance = Date.now(); }
    active = service.flush().catch(() => { console.error("Queue processing failed; inspect storage and health counters."); })
      .finally(() => { active = undefined; });
  } catch { console.error("Maintenance failed; inspect storage."); }
}, 1000);
server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ event: "started", mode: config.mode, transport: config.transport, port: config.port }));
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.close(() => { void Promise.resolve(active).finally(() => { store.close(); process.exit(0); }); });
  setTimeout(() => process.exit(1), 15000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
