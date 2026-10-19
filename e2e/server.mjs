// Starts the built bot in demo mode for Playwright: a throwaway PostgreSQL unless DATABASE_URL is set (CI service).
import { startDevPostgres } from "../dist/db/dev-postgres.js";

const dev = process.env.DATABASE_URL ? undefined : await startDevPostgres();
process.env.DATABASE_URL ??= dev.url;
process.env.APP_MODE = "demo";
process.env.TRANSPORT = "console";
process.env.PORT ??= "3100";
if (dev) {
  // main.js stops itself on SIGTERM; the database must go down with it.
  const stop = () => { void dev.stop().finally(() => process.exit(0)); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
await import("../dist/main.js");
