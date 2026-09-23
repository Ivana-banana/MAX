import type { Pool } from "pg";
import { SCHEMA_V1 } from "./schema.js";

const SCHEMA_VERSION = 1;

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    await client.query("SELECT pg_advisory_xact_lock(91824001)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY
      )
    `);

    const applied = await client.query<{ version: number }>(
      "SELECT version FROM schema_migrations WHERE version = $1",
      [SCHEMA_VERSION],
    );

    if (applied.rows.length === 0) {
      await client.query(SCHEMA_V1);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [SCHEMA_VERSION]);
    }

    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the migration error if PostgreSQL has already lost the connection.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
