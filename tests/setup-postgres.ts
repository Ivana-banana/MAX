import { startDevPostgres } from "../src/db/dev-postgres.js";

// CI passes TEST_DATABASE_URL (PostgreSQL service); locally a throwaway server starts for the run.
export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.TEST_DATABASE_URL) return undefined;
  const server = await startDevPostgres();
  process.env.TEST_DATABASE_URL = server.url;
  return () => server.stop();
}
