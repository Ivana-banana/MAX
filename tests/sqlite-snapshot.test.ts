import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SqliteSnapshot } from "../src/db/sqlite-snapshot.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("readSqliteSnapshot", () => {
  it("preserves session JSON, event IDs, outbox fields, and millisecond timestamps", async () => {
    const path = createLegacyDatabase();
    write(path, db => {
      db.prepare("INSERT INTO sessions (user_id, data, updated_at) VALUES (?, ?, ?)")
        .run(42, JSON.stringify({ step: "plan", reminders: true }), 1_760_000_000_123);
      db.prepare("INSERT INTO events (id, created_at) VALUES (?, ?)")
        .run("event-1", 1_760_000_000_456);
      db.prepare("INSERT INTO events (id, created_at) VALUES (?, ?)")
        .run("event-2", 1_760_000_000_789);
      db.prepare(`INSERT INTO outbox
        (id, user_id, payload, kind, attempts, next_attempt, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("job-pending", 42, JSON.stringify({ text: "synthetic reminder" }), "reminder", 2,
          1_760_000_001_001, "pending", 1_760_000_000_001);
      db.prepare(`INSERT INTO outbox
        (id, user_id, payload, kind, attempts, next_attempt, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("job-sent", 42, JSON.stringify({ text: "synthetic reply" }), "reply", 1,
          1_760_000_001_234, "sent", 1_760_000_000_002);
    });

    const readSqliteSnapshot = await snapshotReader();

    expect(readSqliteSnapshot(path)).toEqual({
      sessions: [{
        userId: 42,
        data: { step: "plan", reminders: true },
        rawDataJson: '{"step":"plan","reminders":true}',
        updatedAt: 1_760_000_000_123,
      }],
      events: [
        { id: "event-1", createdAt: 1_760_000_000_456 },
        { id: "event-2", createdAt: 1_760_000_000_789 },
      ],
      outbox: [
        {
          id: "job-pending",
          userId: 42,
          payload: { text: "synthetic reminder" },
          rawPayloadJson: '{"text":"synthetic reminder"}',
          kind: "reminder",
          attempts: 2,
          nextAttempt: 1_760_000_001_001,
          status: "pending",
          createdAt: 1_760_000_000_001,
        },
        {
          id: "job-sent",
          userId: 42,
          payload: { text: "synthetic reply" },
          rawPayloadJson: '{"text":"synthetic reply"}',
          kind: "reply",
          attempts: 1,
          nextAttempt: 1_760_000_001_234,
          status: "sent",
          createdAt: 1_760_000_000_002,
        },
      ],
      funnel: [],
    });
  });

  it("reads anonymous funnel counters when the database already has them", async () => {
    const path = createLegacyDatabase({ includeFunnel: true });
    write(path, db => {
      db.prepare("INSERT INTO funnel (day, university, event, n) VALUES (?, ?, ?, ?)").run("2026-09-20", "kfu", "started", 3);
    });

    const readSqliteSnapshot = await snapshotReader();

    expect(readSqliteSnapshot(path).funnel).toEqual([{ day: "2026-09-20", university: "kfu", event: "started", n: 3 }]);
  });

  it("rejects an unknown funnel event without returning a partial snapshot", async () => {
    const path = createLegacyDatabase({ includeFunnel: true });
    write(path, db => {
      db.prepare("INSERT INTO funnel (day, university, event, n) VALUES (?, ?, ?, ?)").run("2026-09-20", "kfu", "clicked", 1);
    });

    const readSqliteSnapshot = await snapshotReader();
    expectNoSnapshot(readSqliteSnapshot, path);
  });

  it("retains original JSON text for integers beyond JavaScript safe precision", async () => {
    const path = createLegacyDatabase();
    const sessionJson = '{"value":9007199254740993}';
    const payloadJson = '{"value":9007199254740993}';
    write(path, db => {
      db.prepare("INSERT INTO sessions (user_id, data, updated_at) VALUES (?, ?, ?)")
        .run(42, sessionJson, 1_760_000_000_123);
      db.prepare(`INSERT INTO outbox
        (id, user_id, payload, kind, attempts, next_attempt, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("job-large-number", 42, payloadJson, "reply", 0,
          1_760_000_001_234, "pending", 1_760_000_000_001);
    });

    const readSqliteSnapshot = await snapshotReader();
    const snapshot = readSqliteSnapshot(path);

    expect(snapshot.sessions[0]?.data).toEqual({ value: 9007199254740992 });
    expect(snapshot).toMatchObject({
      sessions: [{ rawDataJson: sessionJson }],
      outbox: [{ rawPayloadJson: payloadJson }],
    });
  });

  it("rejects a legacy database with a missing table without returning a partial snapshot", async () => {
    const path = createLegacyDatabase({ includeOutbox: false });
    write(path, db => {
      db.prepare("INSERT INTO sessions (user_id, data, updated_at) VALUES (?, ?, ?)")
        .run(42, JSON.stringify({ step: "plan" }), 1_760_000_000_123);
    });

    const readSqliteSnapshot = await snapshotReader();
    expectNoSnapshot(readSqliteSnapshot, path);
  });

  it("rejects malformed session JSON without returning a partial snapshot", async () => {
    const path = createLegacyDatabase();
    write(path, db => {
      db.prepare("INSERT INTO sessions (user_id, data, updated_at) VALUES (?, ?, ?)")
        .run(42, JSON.stringify({ step: "plan" }), 1_760_000_000_123);
      db.prepare("INSERT INTO sessions (user_id, data, updated_at) VALUES (?, ?, ?)")
        .run(43, "{broken-json", 1_760_000_000_456);
    });

    const readSqliteSnapshot = await snapshotReader();
    expectNoSnapshot(readSqliteSnapshot, path);
  });

  it.each(["sessions", "outbox"] as const)(
    "rejects an unsafe user_id in %s without returning a partial snapshot",
    async table => {
      const path = createLegacyDatabase();
      write(path, db => {
        if (table === "sessions") {
          db.exec(`INSERT INTO sessions (user_id, data, updated_at)
            VALUES (9007199254740992, '{"step":"plan"}', 1760000000123)`);
        } else {
          db.exec(`INSERT INTO outbox
            (id, user_id, payload, kind, attempts, next_attempt, status, created_at)
            VALUES ('job-invalid', 9007199254740992, '{"text":"synthetic"}', 'reply', 0,
              1760000000123, 'pending', 1760000000123)`);
        }
      });

      const readSqliteSnapshot = await snapshotReader();
      expectNoSnapshot(readSqliteSnapshot, path);
    },
  );

  it("rejects an unknown outbox status without returning a partial snapshot", async () => {
    const path = createLegacyDatabase();
    write(path, db => {
      db.prepare(`INSERT INTO outbox
        (id, user_id, payload, kind, attempts, next_attempt, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("job-invalid", 42, JSON.stringify({ text: "synthetic" }), "reply", 0,
          1_760_000_000_123, "waiting", 1_760_000_000_123);
    });

    const readSqliteSnapshot = await snapshotReader();
    expectNoSnapshot(readSqliteSnapshot, path);
  });

  it("does not create a file when the requested source database is absent", async () => {
    const path = join(createTempDirectory(), "missing.sqlite");
    const readSqliteSnapshot = await snapshotReader();

    expect(() => readSqliteSnapshot(path)).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

function createLegacyDatabase(options: { includeOutbox?: boolean; includeFunnel?: boolean } = {}): string {
  const path = join(createTempDirectory(), "legacy.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE sessions (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      ${options.includeOutbox === false ? "" : `CREATE TABLE outbox (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, payload TEXT NOT NULL, kind TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
      );`}
      ${options.includeFunnel ? `CREATE TABLE funnel (day TEXT NOT NULL, university TEXT NOT NULL, event TEXT NOT NULL,
        n INTEGER NOT NULL, PRIMARY KEY (day, university, event));` : ""}
    `);
  } finally {
    db.close();
  }
  return path;
}

function write(path: string, setup: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  try {
    setup(db);
  } finally {
    db.close();
  }
}

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-snapshot-test-"));
  tempDirectories.push(directory);
  return directory;
}

async function snapshotReader(): Promise<(path: string) => SqliteSnapshot> {
  const module = await import("../src/db/sqlite-snapshot.js");
  return module.readSqliteSnapshot;
}

function expectNoSnapshot(read: (path: string) => unknown, path: string): void {
  let snapshot: unknown;
  expect(() => {
    snapshot = read(path);
  }).toThrow();
  expect(snapshot).toBeUndefined();
}
