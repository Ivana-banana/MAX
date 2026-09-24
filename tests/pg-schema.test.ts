import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;
const schemaName = `test_pg_schema_${process.pid}_${randomUUID().replaceAll("-", "")}`;

postgresDescribe("PostgreSQL v1 schema migration", () => {
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;

  beforeAll(async () => {
    if (!testDatabaseUrl) {
      throw new Error("TEST_DATABASE_URL is required to create an isolated test schema");
    }

    adminPool = new Pool({ connectionString: testDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schemaName}`,
    });
  });

  afterAll(async () => {
    try {
      await pool?.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      }
    } finally {
      await adminPool?.end();
    }
  });

  it("records each version once and creates the required tables after repeated migrations", async () => {
    if (!pool) throw new Error("PostgreSQL test pool was not initialized");

    await migrate(pool);
    await migrate(pool);

    const migration = await pool.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(migration.rows.map((row) => row.version)).toEqual([1, 2]);

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN ('sessions', 'events', 'outbox', 'funnel')
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(["events", "funnel", "outbox", "sessions"]);
  });
});
