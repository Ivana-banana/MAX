import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../src/bot/dialog.js";
import { PostgresStore } from "../src/db/postgres-store.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const postgresDescribe = testDatabaseUrl ? describe.sequential : describe.skip;
const schemaName = `test_store_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const DAY = 86_400_000;

function session(revision = 0): Session {
  return {
    nonce: "0123456789abcdef",
    revision,
    lang: "ru",
    step: "language",
    completions: {},
    documents: {},
    reminders: false,
    ruleVersion: "test",
  };
}

function getStore(store: PostgresStore | undefined): PostgresStore {
  if (!store) throw new Error("PostgreSQL store was not initialized");
  return store;
}

function uniqueUserId(): number {
  return 1 + (Number.parseInt(randomUUID().slice(0, 8), 16) % 2_000_000_000);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAdvisoryWaiter(pool: Pool, userId: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT pid FROM pg_locks
       WHERE locktype = 'advisory' AND classid = 0::oid AND objid = $1::oid
         AND objsubid = 1 AND NOT granted`,
      [userId],
    );
    if (result.rows.length > 0) return;
    await pause(10);
  }
  throw new Error(`Timed out waiting for user ${userId} advisory-lock waiter`);
}

postgresDescribe("PostgreSQL storage", () => {
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let store: PostgresStore | undefined;

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

  beforeEach(async () => {
    if (store && pool) await pool.query("TRUNCATE sessions, events, outbox, funnel");
  });

  afterAll(async () => {
    try {
      if (store) await store.close();
      else await pool?.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      }
    } finally {
      await adminPool?.end();
    }
  });

  it("runs the PostgreSQL migration before returning an open store", async () => {
    if (!pool) throw new Error("PostgreSQL test pool was not initialized");

    store = await PostgresStore.open(pool);

    const migration = await pool.query<{ version: number }>(
      "SELECT version FROM schema_migrations WHERE version = 1",
    );
    expect(migration.rows).toHaveLength(1);
  });

  it("closes the owned pool when migration fails and preserves the migration error", async () => {
    const failingPool = new Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schemaName}_missing_migration`,
    });
    let migrationError: unknown;

    try {
      await PostgresStore.open(failingPool);
    } catch (error) {
      migrationError = error;
    }

    try {
      expect(migrationError).toBeInstanceOf(Error);
      expect((migrationError as Error).message).toMatch(/schema/i);
      await expect(failingPool.query("SELECT 1")).rejects.toThrow();
    } finally {
      if (!failingPool.ended) await failingPool.end();
    }
  });

  it("serializes same-user transactions with one advisory lock", async () => {
    const db = getStore(store);
    const increment = () => db.transaction(41, async (tx) => {
      const current = await tx.get();
      await pause(20);
      await tx.save(session((current?.revision ?? 0) + 1), 1_000);
    });

    await Promise.all([increment(), increment()]);

    expect((await db.get(41))?.revision).toBe(2);
  });

  it("rolls back event deduplication when saving the typed session fails", async () => {
    const db = getStore(store);
    if (!pool) throw new Error("PostgreSQL test pool was not initialized");
    await pool.query("ALTER TABLE sessions ADD CONSTRAINT force_session_save_failure CHECK (user_id <> 42)");

    try {
      await expect(db.transaction(42, async (tx) => {
        expect(await tx.seen("failed-save", 1_000)).toBe(false);
        await tx.save(session(), 1_000);
      })).rejects.toThrow();
    } finally {
      await pool.query("ALTER TABLE sessions DROP CONSTRAINT force_session_save_failure");
    }

    const seenOnRetry = await db.transaction(42, (tx) => tx.seen("failed-save", 1_001));
    expect(seenOnRetry).toBe(false);
  });

  it("ignores duplicate event and outbox IDs inside a user transaction", async () => {
    const db = getStore(store);
    const reply = { text: "first", buttons: [], ruleVersion: "test" };

    const duplicateEventResults = await db.transaction(43, async (tx) => {
      const first = await tx.seen("duplicate-event", 1_000);
      const duplicate = await tx.seen("duplicate-event", 1_001);
      await tx.enqueue("duplicate-job", reply, "reply", 1_000, 1_000);
      await tx.enqueue("duplicate-job", { ...reply, text: "second" }, "reply", 1_001, 1_001);
      return [first, duplicate];
    });
    const row = await pool?.query<{ text: string }>(
      "SELECT payload->>'text' AS text FROM outbox WHERE id = $1",
      ["duplicate-job"],
    );

    expect(duplicateEventResults).toEqual([false, true]);
    expect(row?.rows[0]?.text).toBe("first");
  });

  it("removes a session and all of its outbox rows atomically", async () => {
    const db = getStore(store);
    await db.transaction(44, async (tx) => {
      await tx.save(session(), 1_000);
      await tx.enqueue("remove-pending", { ruleId: "r", dueDate: "2026-10-01" }, "reminder", 1_000, 1_000);
      await tx.enqueue("remove-reply", { text: "reply", buttons: [], ruleVersion: "test" }, "reply", 1_000, 1_000);
    });

    await db.transaction(44, (tx) => tx.remove());

    expect(await db.get(44)).toBeNull();
    const rows = await pool?.query("SELECT id FROM outbox WHERE user_id = $1", [44]);
    expect(rows?.rows).toHaveLength(0);
  });

  it("cancels and supersedes pending jobs while retaining sending leases", async () => {
    const db = getStore(store);
    if (!pool) throw new Error("PostgreSQL test pool was not initialized");
    const rows = [
      ["pending-reminder", "reminder", "pending", null, null],
      ["sending-reminder", "reminder", "sending", randomUUID(), 10_000],
      ["pending-reply", "reply", "pending", null, null],
      ["sending-reply", "reply", "sending", randomUUID(), 10_000],
    ] as const;
    for (const [id, kind, status, token, leaseUntil] of rows) {
      await pool.query(
        `INSERT INTO outbox (id, user_id, payload, kind, next_attempt, status, created_at, lease_token, lease_until)
         VALUES ($1, 45, '{}'::jsonb, $2, 1_000, $3, 1_000, $4, $5)`,
        [id, kind, status, token, leaseUntil],
      );
    }

    await db.transaction(45, async (tx) => {
      await tx.cancelReminders();
      await tx.supersedeReplies();
    });

    const remaining = await pool.query<{ id: string }>("SELECT id FROM outbox ORDER BY id");
    expect(remaining.rows.map((row) => row.id)).toEqual(["sending-reminder", "sending-reply"]);
  });

  it("returns typed session snapshots and counts for each outbox status", async () => {
    const db = getStore(store);
    await db.transaction(46, async (tx) => {
      await tx.save(session(3), 2_000);
      await tx.enqueue("count-pending", { text: "reply", buttons: [], ruleVersion: "test" }, "reply", 2_000, 2_000);
    });
    const result = await db.get(46);
    const snapshots = await db.sessions();
    const counts = await db.counts();

    expect(result?.revision).toBe(3);
    expect(snapshots).toEqual([{ user: 46, state: session(3) }]);
    expect(counts).toEqual({ pending: 1, sending: 0, sent: 0, cancelled: 0, failed: 0 });
  });

  it("rejects invalid or unsafe user IDs before touching PostgreSQL", async () => {
    const db = getStore(store);
    await expect(db.get(0)).rejects.toThrow();
    await expect(db.transaction(Number.MAX_SAFE_INTEGER + 1, () => Promise.resolve(undefined))).rejects.toThrow();
  });

  it("rejects an unsafe BIGINT user ID read from PostgreSQL", async () => {
    const db = getStore(store);
    if (!pool) throw new Error("PostgreSQL test pool was not initialized");
    await pool.query(
      "INSERT INTO sessions (user_id, data, updated_at) VALUES ($1::bigint, $2::jsonb, 1)",
      ["9007199254740992", JSON.stringify(session())],
    );

    await expect(db.sessions()).rejects.toThrow();
  });

  it("rejects session JSON that does not match the typed dialogue session", async () => {
    const db = getStore(store);
    if (!pool) throw new Error("PostgreSQL test pool was not initialized");
    await pool.query("INSERT INTO sessions (user_id, data, updated_at) VALUES (57, '{}'::jsonb, 1)");

    await expect(db.get(57)).rejects.toThrow();
  });

  it("claims due jobs in next-attempt, creation-time, and ID order", async () => {
    const db = getStore(store);
    await db.transaction(47, async (tx) => {
      await tx.enqueue("z-old", { ruleId: "z", dueDate: "2026-10-01" }, "reminder", 100, 20);
      await tx.enqueue("c-tie", { ruleId: "c", dueDate: "2026-10-01" }, "reminder", 100, 10);
      await tx.enqueue("b-tie", { ruleId: "b", dueDate: "2026-10-01" }, "reminder", 100, 10);
      await tx.enqueue("a-later", { ruleId: "a", dueDate: "2026-10-01" }, "reminder", 101, 1);
    });
    const firstToken = randomUUID();
    const first = await db.claim(100, firstToken);
    const second = await db.claim(100, randomUUID());
    const third = await db.claim(100, randomUUID());

    expect(first?.id).toBe("b-tie");
    expect(first?.attempts).toBe(0);
    expect(first?.lease_token).toBe(firstToken);
    expect(first?.user_id).toBe(47);
    expect(JSON.parse(first?.payload ?? "null")).toEqual({ ruleId: "b", dueDate: "2026-10-01" });
    expect(second?.id).toBe("c-tie");
    expect(third?.id).toBe("z-old");
    expect(await db.claim(100, randomUUID())).toBeUndefined();
  });

  it("claims concurrent jobs once and gives each a finite lease", async () => {
    const db = getStore(store);
    await db.transaction(48, async (tx) => {
      await tx.enqueue("parallel-a", { ruleId: "a", dueDate: "2026-10-01" }, "reminder", 1_000, 1_000);
      await tx.enqueue("parallel-b", { ruleId: "b", dueDate: "2026-10-01" }, "reminder", 1_000, 1_000);
    });

    const [first, second] = await Promise.all([
      db.claim(1_000, randomUUID()),
      db.claim(1_000, randomUUID()),
    ]);
    const leaseRows = await pool?.query<{ lease_until: string }>(
      "SELECT lease_until::text AS lease_until FROM outbox WHERE status = 'sending' ORDER BY id",
    );

    expect(new Set([first?.id, second?.id]).size).toBe(2);
    expect(leaseRows?.rows.map((row) => Number(row.lease_until))).toEqual([61_000, 61_000]);
  });

  it("requires the current token to finish or cancel a sending job", async () => {
    const db = getStore(store);
    await db.transaction(49, async (tx) => {
      await tx.enqueue("finish-job", { ruleId: "a", dueDate: "2026-10-01" }, "reminder", 1_000, 1_000);
      await tx.enqueue("cancel-job", { ruleId: "b", dueDate: "2026-10-01" }, "reminder", 1_000, 1_000);
    });
    const finishJob = await db.claim(1_000, randomUUID());
    const cancelToken = randomUUID();
    const cancelJob = await db.claim(1_000, cancelToken);
    if (!finishJob || !cancelJob) throw new Error("Expected both jobs to be claimed");

    expect(await db.finish(finishJob.id, randomUUID())).toBe(false);
    expect(await db.finish(finishJob.id, finishJob.lease_token)).toBe(true);
    expect(await db.cancel(cancelJob.id, randomUUID())).toBe(false);
    expect(await db.cancel(cancelJob.id, cancelToken)).toBe(true);
    expect(await db.finish(cancelJob.id, cancelToken)).toBe(false);
  });

  it("reclaims an expired lease and ignores stale finish, retry, and cancel tokens", async () => {
    const db = getStore(store);
    await db.transaction(50, (tx) => tx.enqueue(
      "lease-job",
      { ruleId: "a", dueDate: "2026-10-01" },
      "reminder",
      100,
      100,
    ));
    const oldToken = randomUUID();
    const oldJob = await db.claim(100, oldToken);
    const beforeExpiry = await db.claim(60_099, randomUUID());
    const newToken = randomUUID();
    const reClaimed = await db.claim(60_100, newToken);
    if (!oldJob || !reClaimed) throw new Error("Expected expired job to be reclaimed");

    expect(beforeExpiry).toBeUndefined();
    expect(reClaimed.lease_token).toBe(newToken);
    expect(await db.finish(reClaimed.id, oldToken)).toBe(false);
    expect(await db.cancel(reClaimed.id, oldToken)).toBe(false);
    await db.retry(oldJob, 60_101);
    const row = await pool?.query<{ status: string; attempts: number; lease_token: string }>(
      "SELECT status, attempts, lease_token FROM outbox WHERE id = $1",
      ["lease-job"],
    );
    expect(row?.rows[0]).toMatchObject({ status: "sending", attempts: 1, lease_token: newToken });
    await db.retry(reClaimed, 60_102);
    const retried = await pool?.query<{ status: string; attempts: number }>(
      "SELECT status, attempts FROM outbox WHERE id = $1",
      ["lease-job"],
    );
    expect(retried?.rows[0]).toEqual({ status: "pending", attempts: 2 });
  });

  it("fails a job after eight consecutive expired leases", async () => {
    const db = getStore(store);
    await db.transaction(54, (tx) => tx.enqueue(
      "expired-lease-job",
      { ruleId: "a", dueDate: "2026-10-01" },
      "reminder",
      100,
      100,
    ));
    const first = await db.claim(100, randomUUID());
    expect(first?.attempts).toBe(0);

    for (let expiry = 1; expiry < 8; expiry += 1) {
      const job = await db.claim(100 + expiry * 60_000, randomUUID());
      expect(job?.id).toBe("expired-lease-job");
      expect(job?.attempts).toBe(expiry);
    }

    expect(await db.claim(100 + 8 * 60_000, randomUUID())).toBeUndefined();
    const row = await pool?.query<{ status: string; attempts: number; lease_token: string | null }>(
      "SELECT status, attempts, lease_token FROM outbox WHERE id = $1",
      ["expired-lease-job"],
    );
    expect(row?.rows[0]).toEqual({ status: "failed", attempts: 8, lease_token: null });
    expect(await db.claim(100 + 9 * 60_000, randomUUID())).toBeUndefined();
  });

  it("retries with exponential backoff and fails after eight attempts", async () => {
    const db = getStore(store);
    await db.transaction(51, (tx) => tx.enqueue(
      "retry-job",
      { ruleId: "a", dueDate: "2026-10-01" },
      "reminder",
      100,
      100,
    ));
    let now = 100;

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const job = await db.claim(now, randomUUID());
      if (!job) throw new Error("Expected retry job to be due");
      await db.retry(job, now);
      const row = await pool?.query<{ attempts: number; next_attempt: string; status: string }>(
        "SELECT attempts, next_attempt::text AS next_attempt, status FROM outbox WHERE id = $1",
        ["retry-job"],
      );
      const delay = Math.min(3_600_000, 5_000 * 2 ** attempt);
      expect(row?.rows[0]).toEqual({
        attempts: attempt,
        next_attempt: String(now + delay),
        status: attempt === 8 ? "failed" : "pending",
      });
      now += delay;
    }
  });

  it("prunes expired sessions and terminal rows but keeps old pending and reclaimable sending jobs", async () => {
    const db = getStore(store);
    if (!pool) throw new Error("PostgreSQL test pool was not initialized");
    const now = 500 * DAY;
    const sessionCutoff = now - 400 * DAY;
    const jobCutoff = now - 7 * DAY;
    await db.transaction(52, async (tx) => {
      await tx.save(session(), sessionCutoff - 1);
      await tx.enqueue("expired-session-job", { ruleId: "a", dueDate: "2026-10-01" }, "reminder", 0, 0);
    });
    await db.transaction(53, (tx) => tx.save(session(1), sessionCutoff + 1));
    await pool.query(
      `INSERT INTO outbox (id, user_id, payload, kind, attempts, next_attempt, status, created_at, lease_token, lease_until)
       VALUES
       ('old-pending', 53, '{}'::jsonb, 'reply', 0, $1, 'pending', 0, NULL, NULL),
       ('old-sent', 53, '{}'::jsonb, 'reply', 1, 0, 'sent', 0, NULL, NULL),
       ('old-sending', 53, '{}'::jsonb, 'reply', 0, 0, 'sending', 0, $2, $3),
       ('old-expired-sending', 53, '{}'::jsonb, 'reply', 0, 0, 'sending', 0, $4, $5)`,
      [now + 1, randomUUID(), now + 60_000, randomUUID(), now - 1],
    );
    await pool.query("INSERT INTO events (id, created_at) VALUES ('old-event', $1), ('new-event', $2)", [jobCutoff - 1, jobCutoff + 1]);

    await db.prune(now);

    expect(await db.get(52)).toBeNull();
    expect((await db.get(53))?.revision).toBe(1);
    const jobs = await pool.query<{ id: string }>("SELECT id FROM outbox ORDER BY id");
    const events = await pool.query<{ id: string }>("SELECT id FROM events ORDER BY id");
    expect(jobs.rows.map((row) => row.id)).toEqual([
      "old-expired-sending",
      "old-pending",
      "old-sending",
    ]);
    expect(events.rows.map((row) => row.id)).toEqual(["new-event"]);

    const leaseToken = randomUUID();
    expect(await db.claim(now, leaseToken)).toMatchObject({
      id: "old-expired-sending",
      lease_token: leaseToken,
    });
  });

  it("rechecks an expired profile after waiting for its user transaction lock", async () => {
    const db = getStore(store);
    if (!pool) throw new Error("PostgreSQL test pool was not initialized");
    const userId = uniqueUserId();
    const now = 500 * DAY;
    const cutoff = now - 400 * DAY;
    await db.transaction(userId, (tx) => tx.save(session(), cutoff - 1));

    let announceLocked!: () => void;
    const locked = new Promise<void>((resolve) => { announceLocked = resolve; });
    let releaseTransaction!: () => void;
    const hold = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const refreshing = db.transaction(userId, async (tx) => {
      await tx.save(session(1), now);
      announceLocked();
      await hold;
    });
    let pruning: Promise<void> | undefined;
    try {
      await Promise.race([
        locked,
        refreshing.then(() => {
          throw new Error("Refreshing transaction completed before acquiring its hold");
        }),
      ]);
      pruning = db.prune(now);
      await waitForAdvisoryWaiter(pool, userId);
    } finally {
      releaseTransaction();
      await Promise.all([refreshing, ...(pruning ? [pruning] : [])]);
    }

    expect((await db.get(userId))?.revision).toBe(1);
  });

  it("serializes removal and cancellation before later user work", async () => {
    const db = getStore(store);
    if (!pool) throw new Error("PostgreSQL test pool was not initialized");
    const userId = uniqueUserId();
    await db.transaction(userId, async (tx) => {
      await tx.save(session(), 1_000);
      await tx.enqueue("before-remove", { ruleId: "a", dueDate: "2026-10-01" }, "reminder", 1_000, 1_000);
    });

    let removed!: () => void;
    const didRemove = new Promise<void>((resolve) => { removed = resolve; });
    let finishRemoval!: () => void;
    const holdRemoval = new Promise<void>((resolve) => { finishRemoval = resolve; });
    const removing = db.transaction(userId, async (tx) => {
      await tx.remove();
      await tx.cancelReminders();
      removed();
      await holdRemoval;
    });
    let later: Promise<void> | undefined;
    try {
      await Promise.race([
        didRemove,
        removing.then(() => {
          throw new Error("Removal transaction completed before acquiring its hold");
        }),
      ]);
      later = db.transaction(userId, async (tx) => {
        await tx.save(session(2), 2_000);
        await tx.enqueue("after-remove", { ruleId: "b", dueDate: "2026-10-02" }, "reminder", 2_000, 2_000);
        await tx.cancelReminders();
        await tx.enqueue("after-cancel", { ruleId: "c", dueDate: "2026-10-03" }, "reminder", 2_000, 2_000);
      });
      await waitForAdvisoryWaiter(pool, userId);
    } finally {
      finishRemoval();
      await Promise.all([removing, ...(later ? [later] : [])]);
    }

    expect((await db.get(userId))?.revision).toBe(2);
    const rows = await pool.query<{ id: string }>("SELECT id FROM outbox WHERE user_id = $1 ORDER BY id", [userId]);
    expect(rows.rows.map((row) => row.id)).toEqual(["after-cancel"]);
  });

  it("survives closing and reopening with session and outbox data intact", async () => {
    if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required to reopen the store");
    const options = { connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` };
    const firstPool = new Pool(options);
    const firstStore = await PostgresStore.open(firstPool);
    await firstStore.transaction(56, async (tx) => {
      await tx.save(session(4), 4_000);
      await tx.enqueue("restart-job", { text: "durable", buttons: [], ruleVersion: "test" }, "reply", 4_000, 4_000);
    });
    await firstStore.close();
    await expect(firstPool.query("SELECT 1")).rejects.toThrow();

    const secondPool = new Pool(options);
    const reopened = await PostgresStore.open(secondPool);
    try {
      expect((await reopened.get(56))?.revision).toBe(4);
      expect(await reopened.claim(4_000, randomUUID())).toMatchObject({ id: "restart-job", user_id: 56 });
    } finally {
      await reopened.close();
    }
  });

  it("adds anonymous funnel counts inside and outside a user transaction and prunes them after 400 days", async () => {
    const db = getStore(store);
    await db.transaction(57, async (tx) => {
      await tx.count("2026-09-01", "kfu", "started");
      await tx.count("2026-09-01", "kfu", "started");
    });
    await db.count("2026-09-02", "itmo", "reminder_sent");
    await expect(db.transaction(57, async (tx) => {
      await tx.count("2026-09-01", "kfu", "plan_ready");
      throw new Error("rolled back");
    })).rejects.toThrow("rolled back");

    expect(await db.funnel()).toEqual([
      { day: "2026-09-01", university: "kfu", event: "started", n: 2 },
      { day: "2026-09-02", university: "itmo", event: "reminder_sent", n: 1 },
    ]);

    await db.prune(Date.parse("2026-09-01T00:00:00Z") + 401 * DAY);
    expect((await db.funnel()).map((row) => row.day)).toEqual(["2026-09-02"]);
  });

  it("rejects unsafe BIGINT job fields returned by a claim", async () => {
    const db = getStore(store);
    if (!pool) throw new Error("PostgreSQL test pool was not initialized");
    await pool.query(
      `INSERT INTO outbox (id, user_id, payload, kind, next_attempt, status, created_at)
       VALUES ('unsafe-job-user', $1::bigint, '{}'::jsonb, 'reply', 1, 'pending', 1)`,
      ["9007199254740992"],
    );

    await expect(db.claim(1, randomUUID())).rejects.toThrow();
  });
});
