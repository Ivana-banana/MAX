import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importSqlite } from "../src/db/import-sqlite.js";
import { readSqliteSnapshot, type SqliteSnapshot } from "../src/db/sqlite-snapshot.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("importSqlite transaction contract", () => {
  it("migrates first, imports parameterized rows, and preserves JSON and timestamps", async () => {
    const pool = new RecordingPool();
    const snapshot = syntheticSnapshot();

    await expect(importSqlite(pool.asPool(), snapshot)).resolves.toEqual({
      sessions: 1,
      events: 2,
      outbox: 2,
      funnel: 1,
    });

    expect(pool.clients).toHaveLength(2);
    expect(pool.queries.filter((query) => query === "BEGIN")).toHaveLength(2);
    expect(pool.queries.indexOf("LOCK TABLE sessions, events, outbox, funnel IN ACCESS EXCLUSIVE MODE"))
      .toBeGreaterThan(pool.queries.indexOf("COMMIT"));
    expect(pool.clients.every((client) => client.released)).toBe(true);
    expect(pool.state.sessions).toEqual([
      [42, '{"step":"plan","nested":{"reminders":true}}', 1_760_000_000_123],
    ]);
    expect(pool.state.events).toEqual([
      ["synthetic-event-1", 1_760_000_000_456],
      ["synthetic-event-2", 1_760_000_000_789],
    ]);
    expect(pool.state.outbox).toEqual([
      ["synthetic-job-1", 42, '{"text":"synthetic reminder","extra":{"day":7}}', "reminder", 2,
        1_760_000_001_001, "pending", 1_760_000_000_001],
      ["synthetic-job-2", 42, '{"text":"synthetic reply","buttons":["open","copy"]}', "reply", 1,
        1_760_000_001_234, "sent", 1_760_000_000_002],
    ]);
    expect(pool.state.funnel).toEqual([["2026-09-20", "kfu", "started", 3]]);

    const insertQueries = pool.clients[1]?.queries.filter((query) => query.text.startsWith("INSERT INTO ")) ?? [];
    expect(insertQueries).toHaveLength(6);
    expect(insertQueries.every((query) => query.text.includes("$1"))).toBe(true);
    expect(insertQueries.every((query) => query.values.length > 0)).toBe(true);
  });

  it("passes original JSON text to PostgreSQL for integers beyond JavaScript safe precision", async () => {
    const pool = new RecordingPool();
    const snapshot = readSqliteSnapshot(createSqliteSourceWithLargeNumbers());

    await importSqlite(pool.asPool(), snapshot);

    expect(snapshot.sessions[0]?.data).toEqual({ value: 9007199254740992 });
    expect(pool.state.sessions[0]?.[1]).toBe('{"value":9007199254740993}');
    expect(pool.state.outbox[0]?.[2]).toBe('{"value":9007199254740993}');
  });

  it("rejects non-empty target tables before inserting any rows", async () => {
    const pool = new RecordingPool();
    pool.state.events.push(["existing-synthetic-event", 1_759_000_000_000]);
    const existingRows = structuredClone({
      sessions: pool.state.sessions,
      events: pool.state.events,
      outbox: pool.state.outbox,
    });

    await expect(importSqlite(pool.asPool(), syntheticSnapshot())).rejects.toThrow();

    expect({
      sessions: pool.state.sessions,
      events: pool.state.events,
      outbox: pool.state.outbox,
    }).toEqual(existingRows);
    expect(pool.clients[1]?.queries.some((query) => query.text.startsWith("INSERT INTO sessions"))).toBe(false);
    expect(pool.clients[1]?.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rolls back sessions, events, and outbox when a later row is invalid", async () => {
    const pool = new RecordingPool();
    const snapshot = syntheticSnapshot();
    snapshot.outbox[0] = { ...snapshot.outbox[0]!, kind: "invalid" } as unknown as SqliteSnapshot["outbox"][number];

    await expect(importSqlite(pool.asPool(), snapshot)).rejects.toThrow();

    expect(pool.state.sessions).toEqual([]);
    expect(pool.state.events).toEqual([]);
    expect(pool.state.outbox).toEqual([]);
    expect(pool.clients[1]?.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(pool.clients[1]?.queries.some((query) => query.text === "COMMIT")).toBe(false);
  });

  it("rolls back when the post-insert row counts do not match the snapshot", async () => {
    const pool = new RecordingPool();
    pool.reportWrongCounts = true;

    await expect(importSqlite(pool.asPool(), syntheticSnapshot())).rejects.toThrow();

    expect(pool.state.sessions).toEqual([]);
    expect(pool.state.events).toEqual([]);
    expect(pool.state.outbox).toEqual([]);
    expect(pool.clients[1]?.queries.at(-1)?.text).toBe("ROLLBACK");
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe : describe.skip;

postgresDescribe("importSqlite PostgreSQL integration", () => {
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let schemaName: string;

  beforeEach(async () => {
    if (!testDatabaseUrl) {
      throw new Error("TEST_DATABASE_URL is required to create an isolated test schema");
    }

    schemaName = `import_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminPool = new Pool({ connectionString: testDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schemaName}`,
    });
  });

  afterEach(async () => {
    try {
      await pool?.end();
      if (adminPool && schemaName) {
        await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      }
    } finally {
      await adminPool?.end();
      pool = undefined;
      adminPool = undefined;
    }
  });

  it("preserves all JSON and timestamps, rejects a repeat import, and leaves SQLite untouched", async () => {
    if (!pool) throw new Error("PostgreSQL test pool was not initialized");
    const sourcePath = createSqliteSource(syntheticSnapshot());
    const sourceBefore = readFileSync(sourcePath);
    const snapshot = readSqliteSnapshot(sourcePath);

    await expect(importSqlite(pool, snapshot)).resolves.toEqual({ sessions: 1, events: 2, outbox: 2, funnel: 1 });

    const sessions = await pool.query(
      "SELECT user_id::text AS user_id, data, updated_at::text AS updated_at FROM sessions",
    );
    const events = await pool.query(
      "SELECT id, created_at::text AS created_at FROM events ORDER BY id",
    );
    const outbox = await pool.query(
      `SELECT id, user_id::text AS user_id, payload, kind, attempts,
              next_attempt::text AS next_attempt, status, created_at::text AS created_at
       FROM outbox ORDER BY id`,
    );
    expect(sessions.rows).toEqual([
      { user_id: "42", data: { step: "plan", nested: { reminders: true } }, updated_at: "1760000000123" },
    ]);
    expect(events.rows).toEqual([
      { id: "synthetic-event-1", created_at: "1760000000456" },
      { id: "synthetic-event-2", created_at: "1760000000789" },
    ]);
    expect(outbox.rows).toEqual([
      {
        id: "synthetic-job-1",
        user_id: "42",
        payload: { text: "synthetic reminder", extra: { day: 7 } },
        kind: "reminder",
        attempts: 2,
        next_attempt: "1760000001001",
        status: "pending",
        created_at: "1760000000001",
      },
      {
        id: "synthetic-job-2",
        user_id: "42",
        payload: { text: "synthetic reply", buttons: ["open", "copy"] },
        kind: "reply",
        attempts: 1,
        next_attempt: "1760000001234",
        status: "sent",
        created_at: "1760000000002",
      },
    ]);

    const funnel = await pool.query("SELECT day, university, event, n FROM funnel");
    expect(funnel.rows).toEqual([{ day: "2026-09-20", university: "kfu", event: "started", n: 3 }]);

    const rowsBeforeRepeat = { sessions: sessions.rows, events: events.rows, outbox: outbox.rows };
    await expect(importSqlite(pool, snapshot)).rejects.toThrow();
    expect(await pool.query("SELECT user_id::text AS user_id, data, updated_at::text AS updated_at FROM sessions"))
      .toMatchObject({ rows: rowsBeforeRepeat.sessions });
    expect(await pool.query("SELECT id, created_at::text AS created_at FROM events ORDER BY id"))
      .toMatchObject({ rows: rowsBeforeRepeat.events });
    expect(await pool.query(
      `SELECT id, user_id::text AS user_id, payload, kind, attempts,
              next_attempt::text AS next_attempt, status, created_at::text AS created_at
       FROM outbox ORDER BY id`,
    )).toMatchObject({ rows: rowsBeforeRepeat.outbox });
    expect(existsSync(sourcePath)).toBe(true);
    expect(readFileSync(sourcePath)).toEqual(sourceBefore);
  });

  it("preserves JSON numbers beyond JavaScript safe precision in JSONB", async () => {
    if (!pool) throw new Error("PostgreSQL test pool was not initialized");
    const snapshot = readSqliteSnapshot(createSqliteSourceWithLargeNumbers());

    await importSqlite(pool, snapshot);

    const values = await pool.query<{ session_value: string; outbox_value: string }>(`
      SELECT
        (SELECT data #>> '{value}' FROM sessions WHERE user_id = 42) AS session_value,
        (SELECT payload #>> '{value}' FROM outbox WHERE id = 'job-large-number') AS outbox_value
    `);
    expect(values.rows[0]).toEqual({
      session_value: "9007199254740993",
      outbox_value: "9007199254740993",
    });
  });

  it("rolls back the three target tables when an invalid outbox row follows valid rows", async () => {
    if (!pool) throw new Error("PostgreSQL test pool was not initialized");
    const snapshot = syntheticSnapshot();
    snapshot.outbox[0] = { ...snapshot.outbox[0]!, kind: "invalid" } as unknown as SqliteSnapshot["outbox"][number];

    await expect(importSqlite(pool, snapshot)).rejects.toThrow();

    const counts = await pool.query<{ sessions: string; events: string; outbox: string }>(`
      SELECT
        (SELECT COUNT(*)::text FROM sessions) AS sessions,
        (SELECT COUNT(*)::text FROM events) AS events,
        (SELECT COUNT(*)::text FROM outbox) AS outbox
    `);
    expect(counts.rows[0]).toEqual({ sessions: "0", events: "0", outbox: "0" });
  });
});

interface RecordedQuery {
  text: string;
  values: unknown[];
}

interface ImportTables {
  sessions: unknown[][];
  events: unknown[][];
  outbox: unknown[][];
  funnel: unknown[][];
}

interface FakeState extends ImportTables {
  migrationVersion: number | undefined;
}

class RecordingPool {
  state: FakeState = {
    sessions: [],
    events: [],
    outbox: [],
    funnel: [],
    migrationVersion: undefined,
  };
  clients: RecordingClient[] = [];
  queries: string[] = [];
  reportWrongCounts = false;

  async connect(): Promise<RecordingClient> {
    const client = new RecordingClient(this);
    this.clients.push(client);
    return client;
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }
}

class RecordingClient {
  queries: RecordedQuery[] = [];
  released = false;
  private transactionState: FakeState | undefined;

  constructor(private readonly pool: RecordingPool) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const text = queryText.trim().replace(/\s+/g, " ");
    this.queries.push({ text, values: [...values] });
    this.pool.queries.push(text);

    if (text === "BEGIN") {
      this.transactionState = structuredClone(this.pool.state);
      return queryResult<Row>([]);
    }
    if (text === "COMMIT") {
      if (!this.transactionState) throw new Error("no active transaction");
      this.pool.state = this.transactionState;
      this.transactionState = undefined;
      return queryResult<Row>([]);
    }
    if (text === "ROLLBACK") {
      this.transactionState = undefined;
      return queryResult<Row>([]);
    }
    if (text.startsWith("SELECT version FROM schema_migrations")) {
      const version = this.currentState().migrationVersion;
      return queryResult<Row>(version === undefined ? [] : [{ version } as unknown as Row]);
    }
    if (text.startsWith("INSERT INTO schema_migrations")) {
      this.currentState().migrationVersion = Number(values[0]);
      return queryResult<Row>([]);
    }
    if (text.startsWith("SELECT EXISTS")) {
      const state = this.currentState();
      return queryResult<Row>([{
        sessions: state.sessions.length > 0,
        events: state.events.length > 0,
        outbox: state.outbox.length > 0,
        funnel: state.funnel.length > 0,
      } as unknown as Row]);
    }
    if (text.startsWith("INSERT INTO sessions")) {
      this.currentState().sessions.push([...values]);
      return queryResult<Row>([]);
    }
    if (text.startsWith("INSERT INTO events")) {
      this.currentState().events.push([...values]);
      return queryResult<Row>([]);
    }
    if (text.startsWith("INSERT INTO outbox")) {
      if (values[3] !== "reply" && values[3] !== "reminder") {
        throw new Error("outbox kind check constraint");
      }
      this.currentState().outbox.push([...values]);
      return queryResult<Row>([]);
    }
    if (text.startsWith("INSERT INTO funnel")) {
      this.currentState().funnel.push([...values]);
      return queryResult<Row>([]);
    }
    if (text.includes("AS sessions") && text.includes("AS events") && text.includes("AS outbox")) {
      const state = this.currentState();
      return queryResult<Row>([{
        sessions: String(state.sessions.length + (this.pool.reportWrongCounts ? 1 : 0)),
        events: String(state.events.length),
        outbox: String(state.outbox.length),
        funnel: String(state.funnel.length),
      } as unknown as Row]);
    }

    return queryResult<Row>([]);
  }

  release(): void {
    this.released = true;
  }

  private currentState(): FakeState {
    if (!this.transactionState) throw new Error("query must run in a transaction");
    return this.transactionState;
  }
}

function queryResult<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return { command: "", rowCount: rows.length, oid: 0, rows, fields: [] };
}

function syntheticSnapshot(): SqliteSnapshot {
  return {
    sessions: [
      {
        userId: 42,
        data: { step: "plan", nested: { reminders: true } },
        rawDataJson: '{"step":"plan","nested":{"reminders":true}}',
        updatedAt: 1_760_000_000_123,
      },
    ],
    events: [
      { id: "synthetic-event-1", createdAt: 1_760_000_000_456 },
      { id: "synthetic-event-2", createdAt: 1_760_000_000_789 },
    ],
    outbox: [
      {
        id: "synthetic-job-1",
        userId: 42,
        payload: { text: "synthetic reminder", extra: { day: 7 } },
        rawPayloadJson: '{"text":"synthetic reminder","extra":{"day":7}}',
        kind: "reminder",
        attempts: 2,
        nextAttempt: 1_760_000_001_001,
        status: "pending",
        createdAt: 1_760_000_000_001,
      },
      {
        id: "synthetic-job-2",
        userId: 42,
        payload: { text: "synthetic reply", buttons: ["open", "copy"] },
        rawPayloadJson: '{"text":"synthetic reply","buttons":["open","copy"]}',
        kind: "reply",
        attempts: 1,
        nextAttempt: 1_760_000_001_234,
        status: "sent",
        createdAt: 1_760_000_000_002,
      },
    ],
    funnel: [{ day: "2026-09-20", university: "kfu", event: "started", n: 3 }],
  };
}

function createSqliteSource(snapshot: SqliteSnapshot): string {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-import-test-"));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, "legacy.sqlite");
  const db = new DatabaseSync(sourcePath);

  try {
    db.exec(`
      CREATE TABLE sessions (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, payload TEXT NOT NULL, kind TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
      );
      CREATE TABLE funnel (day TEXT NOT NULL, university TEXT NOT NULL, event TEXT NOT NULL, n INTEGER NOT NULL,
        PRIMARY KEY (day, university, event));
    `);
    for (const row of snapshot.funnel) {
      db.prepare("INSERT INTO funnel (day, university, event, n) VALUES (?, ?, ?, ?)")
        .run(row.day, row.university, row.event, row.n);
    }
    for (const session of snapshot.sessions) {
      db.prepare("INSERT INTO sessions (user_id, data, updated_at) VALUES (?, ?, ?)")
        .run(session.userId, session.rawDataJson, session.updatedAt);
    }
    for (const event of snapshot.events) {
      db.prepare("INSERT INTO events (id, created_at) VALUES (?, ?)")
        .run(event.id, event.createdAt);
    }
    for (const job of snapshot.outbox) {
      db.prepare(`INSERT INTO outbox
        (id, user_id, payload, kind, attempts, next_attempt, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(job.id, job.userId, job.rawPayloadJson, job.kind, job.attempts,
          job.nextAttempt, job.status, job.createdAt);
    }
  } finally {
    db.close();
  }

  return sourcePath;
}

function createSqliteSourceWithLargeNumbers(): string {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-import-precision-test-"));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, "legacy.sqlite");
  const db = new DatabaseSync(sourcePath);

  try {
    db.exec(`
      CREATE TABLE sessions (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, payload TEXT NOT NULL, kind TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
      );
    `);
    db.prepare("INSERT INTO sessions (user_id, data, updated_at) VALUES (?, ?, ?)")
      .run(42, '{"value":9007199254740993}', 1_760_000_000_123);
    db.prepare(`INSERT INTO outbox
      (id, user_id, payload, kind, attempts, next_attempt, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("job-large-number", 42, '{"value":9007199254740993}', "reply", 0,
        1_760_000_001_234, "pending", 1_760_000_000_001);
  } finally {
    db.close();
  }

  return sourcePath;
}
