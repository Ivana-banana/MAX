import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import { migrate } from "./migrate.js";
import { readSqliteSnapshot, type SqliteSnapshot } from "./sqlite-snapshot.js";

export interface SqliteImportCounts {
  sessions: number;
  events: number;
  outbox: number;
  funnel: number;
}

interface SqliteCountText {
  sessions: string;
  events: string;
  outbox: string;
  funnel: string;
}

export async function importSqlite(pool: Pool, snapshot: SqliteSnapshot): Promise<SqliteImportCounts> {
  await migrate(pool);

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    await client.query("LOCK TABLE sessions, events, outbox, funnel IN ACCESS EXCLUSIVE MODE");
    const existing = await client.query<{
      sessions: boolean;
      events: boolean;
      outbox: boolean;
      funnel: boolean;
    }>(`
      SELECT
        EXISTS (SELECT 1 FROM sessions) AS sessions,
        EXISTS (SELECT 1 FROM events) AS events,
        EXISTS (SELECT 1 FROM outbox) AS outbox,
        EXISTS (SELECT 1 FROM funnel) AS funnel
    `);
    const target = existing.rows[0];
    if (!target || target.sessions || target.events || target.outbox || target.funnel) {
      throw new Error("PostgreSQL target tables must be empty before importing SQLite");
    }

    await insertSessions(client, snapshot.sessions);
    await insertEvents(client, snapshot.events);
    await insertOutbox(client, snapshot.outbox);
    await insertFunnel(client, snapshot.funnel);

    const actual = await client.query<SqliteCountText>(`
      SELECT
        (SELECT COUNT(*)::text FROM sessions) AS sessions,
        (SELECT COUNT(*)::text FROM events) AS events,
        (SELECT COUNT(*)::text FROM outbox) AS outbox,
        (SELECT COUNT(*)::text FROM funnel) AS funnel
    `);
    const counts = actual.rows[0];
    const expected = {
      sessions: snapshot.sessions.length,
      events: snapshot.events.length,
      outbox: snapshot.outbox.length,
      funnel: snapshot.funnel.length,
    };
    if (
      !counts ||
      counts.sessions !== String(expected.sessions) ||
      counts.events !== String(expected.events) ||
      counts.outbox !== String(expected.outbox) ||
      counts.funnel !== String(expected.funnel)
    ) {
      throw new Error("PostgreSQL import row counts do not match the SQLite snapshot");
    }

    await client.query("COMMIT");
    transactionStarted = false;
    return expected;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the import error if PostgreSQL has already lost the connection.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function insertSessions(
  client: PoolClient,
  sessions: SqliteSnapshot["sessions"],
): Promise<void> {
  for (const session of sessions) {
    await client.query(
      `INSERT INTO sessions (user_id, data, updated_at)
       VALUES ($1, $2::jsonb, $3)`,
      [session.userId, session.rawDataJson, session.updatedAt],
    );
  }
}

async function insertEvents(client: PoolClient, events: SqliteSnapshot["events"]): Promise<void> {
  for (const event of events) {
    await client.query(
      "INSERT INTO events (id, created_at) VALUES ($1, $2)",
      [event.id, event.createdAt],
    );
  }
}

async function insertOutbox(client: PoolClient, outbox: SqliteSnapshot["outbox"]): Promise<void> {
  for (const job of outbox) {
    await client.query(
      `INSERT INTO outbox
        (id, user_id, payload, kind, attempts, next_attempt, status, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)`,
      [
        job.id,
        job.userId,
        job.rawPayloadJson,
        job.kind,
        job.attempts,
        job.nextAttempt,
        job.status,
        job.createdAt,
      ],
    );
  }
}

async function insertFunnel(client: PoolClient, funnel: SqliteSnapshot["funnel"]): Promise<void> {
  for (const row of funnel) {
    await client.query(
      "INSERT INTO funnel (day, university, event, n) VALUES ($1, $2, $3, $4)",
      [row.day, row.university, row.event, row.n],
    );
  }
}

async function runCli(): Promise<void> {
  const [sourcePath, ...extraArguments] = process.argv.slice(2);
  if (!sourcePath || extraArguments.length > 0) {
    process.stderr.write("Usage: npm run db:import-sqlite -- <sqlite-path>\n");
    process.exitCode = 2;
    return;
  }

  const pool = new Pool();
  try {
    const snapshot = readSqliteSnapshot(sourcePath);
    const counts = await importSqlite(pool, snapshot);
    process.stdout.write(`sessions=${counts.sessions} events=${counts.events} outbox=${counts.outbox} funnel=${counts.funnel}\n`);
  } catch {
    process.stderr.write("SQLite-to-PostgreSQL import failed; details are omitted to avoid exposing stored data.\n");
    process.exitCode = 1;
  } finally {
    try {
      await pool.end();
    } catch {
      // The command is already failing or complete; no database details are printed.
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void runCli();
}
