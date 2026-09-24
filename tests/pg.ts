import { scratchSchema, type ScratchSchema } from "../src/db/dev-postgres.js";

/** Isolated schema in the test PostgreSQL (tests/setup-postgres.ts starts one when TEST_DATABASE_URL is unset). */
export function testSchema(): Promise<ScratchSchema> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set: tests/setup-postgres.ts should have started PostgreSQL");
  return scratchSchema(url);
}
