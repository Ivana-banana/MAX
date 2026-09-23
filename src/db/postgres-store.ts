import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { Reply, Session } from "../bot/dialog.js";
import { migrate } from "./migrate.js";

type PostgresJobKind = "reply" | "reminder";
type PostgresJobStatus = "pending" | "sending" | "sent" | "cancelled" | "failed";

interface PostgresReminderPayload {
  ruleId: string;
  dueDate: string;
}

export interface PostgresJob {
  id: string;
  user_id: number;
  payload: string;
  kind: PostgresJobKind;
  attempts: number;
  next_attempt: number;
  lease_token: string;
}

export interface PostgresStoreTx {
  get(): Promise<Session | null>;
  save(state: Session, now: number): Promise<void>;
  remove(): Promise<void>;
  seen(id: string, now: number): Promise<boolean>;
  enqueue(
    id: string,
    payload: Reply | PostgresReminderPayload,
    kind: PostgresJobKind,
    nextAttempt: number,
    now: number,
  ): Promise<void>;
  cancelReminders(): Promise<void>;
  supersedeReplies(): Promise<void>;
}

const dayMs = 86_400_000;
const sessionRetentionMs = 400 * dayMs;
const eventRetentionMs = 7 * dayMs;
const jobRetentionMs = 7 * dayMs;
const leaseDurationMs = 60_000;
const retryBaseMs = 5_000;
const retryMaxMs = 3_600_000;
const maxAttempts = 8;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const getSessionSql = "SELECT user_id, data FROM sessions WHERE user_id = $1";
const sessionSteps = new Set([
  "language",
  "consent",
  "scope",
  "citizenship",
  "entry",
  "plan",
  "completion",
  "delete",
]);
const jobStatuses: readonly PostgresJobStatus[] = ["pending", "sending", "sent", "cancelled", "failed"];

export class PostgresStore {
  private closePromise: Promise<void> | undefined;

  /** Takes ownership of pool. Call close() to close it. */
  private constructor(private readonly pool: Pool) {}

  static async open(pool: Pool): Promise<PostgresStore> {
    await migrate(pool);
    return new PostgresStore(pool);
  }

  async transaction<T>(userId: number, fn: (tx: PostgresStoreTx) => Promise<T>): Promise<T> {
    safeInteger(userId, "user_id", 1);
    const client = await this.pool.connect();

    try {
      return await runInTransaction(client, async () => {
        await lockUser(client, userId);
        return fn(transactionFor(client, userId));
      });
    } finally {
      client.release();
    }
  }

  async get(userId: number): Promise<Session | null> {
    safeInteger(userId, "user_id", 1);
    const result = await this.pool.query<SessionRow>(getSessionSql, [userId]);
    const row = result.rows[0];
    return row ? readSessionRow(row).state : null;
  }

  async sessions(): Promise<{ user: number; state: Session }[]> {
    const result = await this.pool.query<SessionRow>(
      "SELECT user_id, data FROM sessions ORDER BY user_id",
    );
    return result.rows.map(readSessionRow);
  }

  async counts(): Promise<Record<PostgresJobStatus, number>> {
    const result = await this.pool.query<StatusCountRow>(
      "SELECT status, COUNT(*) AS count FROM outbox GROUP BY status",
    );
    const counts: Record<PostgresJobStatus, number> = {
      pending: 0,
      sending: 0,
      sent: 0,
      cancelled: 0,
      failed: 0,
    };

    for (const row of result.rows) {
      const status = readJobStatus(row.status);
      counts[status] = safeInteger(row.count, "outbox.count");
    }
    return counts;
  }

  async claim(now: number, leaseToken: string): Promise<PostgresJob | undefined> {
    validateTimestamp(now, "claim.now");
    readLeaseToken(leaseToken);
    const leaseUntil = addSafeIntegers(now, leaseDurationMs, "outbox.lease_until");
    const result = await this.pool.query<ClaimedJobRow>(
      `WITH candidate AS (
         SELECT id
         FROM outbox
         WHERE (status = 'pending' AND next_attempt <= $1)
            OR (status = 'sending' AND lease_until <= $1)
         ORDER BY next_attempt, created_at, id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox AS job
       SET status = 'sending', lease_token = $2::uuid, lease_until = $3
       FROM candidate
       WHERE job.id = candidate.id
       RETURNING job.id, job.user_id, job.payload::text AS payload, job.kind,
                 job.attempts, job.next_attempt, job.lease_token`,
      [now, leaseToken, leaseUntil],
    );
    const row = result.rows[0];
    return row ? readClaimedJob(row) : undefined;
  }

  async finish(id: string, leaseToken: string): Promise<boolean> {
    validateId(id, "outbox.id");
    readLeaseToken(leaseToken);
    const result = await this.pool.query(
      `UPDATE outbox
       SET status = 'sent', lease_token = NULL, lease_until = NULL
       WHERE id = $1 AND status = 'sending' AND lease_token = $2::uuid`,
      [id, leaseToken],
    );
    return result.rowCount === 1;
  }

  async cancel(id: string, leaseToken: string): Promise<boolean> {
    validateId(id, "outbox.id");
    readLeaseToken(leaseToken);
    const result = await this.pool.query(
      `UPDATE outbox
       SET status = 'cancelled', lease_token = NULL, lease_until = NULL
       WHERE id = $1 AND status = 'sending' AND lease_token = $2::uuid`,
      [id, leaseToken],
    );
    return result.rowCount === 1;
  }

  async retry(job: PostgresJob, now: number): Promise<void> {
    validateTimestamp(now, "retry.now");
    validateId(job.id, "outbox.id");
    readLeaseToken(job.lease_token);
    const attempts = addSafeIntegers(safeInteger(job.attempts, "outbox.attempts"), 1, "outbox.attempts");
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** attempts);
    const nextAttempt = addSafeIntegers(now, delay, "outbox.next_attempt");
    const status: Exclude<PostgresJobStatus, "sending" | "sent" | "cancelled"> =
      attempts >= maxAttempts ? "failed" : "pending";

    await this.pool.query(
      `UPDATE outbox
       SET attempts = $3, next_attempt = $4, status = $5,
           lease_token = NULL, lease_until = NULL
       WHERE id = $1 AND status = 'sending' AND lease_token = $2::uuid AND attempts = $6`,
      [job.id, job.lease_token, attempts, nextAttempt, status, job.attempts],
    );
  }

  async prune(now: number): Promise<void> {
    validateTimestamp(now, "prune.now");
    const sessionCutoff = now - sessionRetentionMs;
    const eventCutoff = now - eventRetentionMs;
    const jobCutoff = now - jobRetentionMs;
    const expired = await this.pool.query<UserIdRow>(
      "SELECT user_id FROM sessions WHERE updated_at < $1 ORDER BY user_id",
      [sessionCutoff],
    );

    for (const row of expired.rows) {
      const userId = safeInteger(row.user_id, "sessions.user_id", 1);
      await this.pruneUser(userId, sessionCutoff);
    }

    await this.pool.query("DELETE FROM events WHERE created_at < $1", [eventCutoff]);
    await this.pool.query(
      `DELETE FROM outbox
       WHERE status <> 'pending'
         AND GREATEST(created_at, next_attempt) < $1
         AND (status <> 'sending' OR lease_until <= $2)`,
      [jobCutoff, now],
    );
  }

  async close(): Promise<void> {
    this.closePromise ??= this.pool.end();
    await this.closePromise;
  }

  private async pruneUser(userId: number, cutoff: number): Promise<void> {
    const client = await this.pool.connect();

    try {
      await runInTransaction(client, async () => {
        // Use the same lock as user work, then recheck the age after waiting for it.
        await lockUser(client, userId);
        const deleted = await client.query(
          "DELETE FROM sessions WHERE user_id = $1 AND updated_at < $2 RETURNING user_id",
          [userId, cutoff],
        );
        if (deleted.rowCount === 1) {
          await client.query("DELETE FROM outbox WHERE user_id = $1", [userId]);
        }
      });
    } finally {
      client.release();
    }
  }
}

interface SessionRow extends QueryResultRow {
  user_id: unknown;
  data: unknown;
}

interface UserIdRow extends QueryResultRow {
  user_id: unknown;
}

interface StatusCountRow extends QueryResultRow {
  status: unknown;
  count: unknown;
}

interface ClaimedJobRow extends QueryResultRow {
  id: unknown;
  user_id: unknown;
  payload: unknown;
  kind: unknown;
  attempts: unknown;
  next_attempt: unknown;
  lease_token: unknown;
}

function transactionFor(client: PoolClient, userId: number): PostgresStoreTx {
  return {
    async get() {
      const result = await client.query<SessionRow>(
        getSessionSql,
        [userId],
      );
      const row = result.rows[0];
      return row ? readSessionRow(row).state : null;
    },
    async save(state, now) {
      validateTimestamp(now, "sessions.updated_at");
      const data = serializeObject(state, "sessions.data");
      await client.query(
        `INSERT INTO sessions (user_id, data, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (user_id) DO UPDATE
         SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [userId, data, now],
      );
    },
    async remove() {
      await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM outbox WHERE user_id = $1", [userId]);
    },
    async seen(id, now) {
      validateId(id, "events.id");
      validateTimestamp(now, "events.created_at");
      const result = await client.query(
        `INSERT INTO events (id, created_at)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [id, now],
      );
      return result.rowCount === 0;
    },
    async enqueue(id, payload, kind, nextAttempt, now) {
      validateId(id, "outbox.id");
      const checkedKind = readJobKind(kind);
      validateTimestamp(nextAttempt, "outbox.next_attempt");
      validateTimestamp(now, "outbox.created_at");
      const json = serializeObject(payload, "outbox.payload");
      await client.query(
        `INSERT INTO outbox (id, user_id, payload, kind, next_attempt, status, created_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, 'pending', $6)
         ON CONFLICT (id) DO NOTHING`,
        [id, userId, json, checkedKind, nextAttempt, now],
      );
    },
    async cancelReminders() {
      await client.query(
        "DELETE FROM outbox WHERE user_id = $1 AND kind = 'reminder' AND status = 'pending'",
        [userId],
      );
    },
    async supersedeReplies() {
      await client.query(
        "DELETE FROM outbox WHERE user_id = $1 AND kind = 'reply' AND status = 'pending'",
        [userId],
      );
    },
  };
}

function readSessionRow(row: SessionRow): { user: number; state: Session } {
  return {
    user: safeInteger(row.user_id, "sessions.user_id", 1),
    state: readSession(row.data),
  };
}

function readSession(value: unknown): Session {
  if (!isRecord(value) ||
      !nonEmptyStringValue(value.nonce) ||
      !isSafeInteger(value.revision, 0) ||
      (value.lang !== "ru" && value.lang !== "en") ||
      typeof value.step !== "string" || !sessionSteps.has(value.step) ||
      !isRecord(value.completions) || !isRecord(value.documents) ||
      typeof value.reminders !== "boolean" || !nonEmptyStringValue(value.ruleVersion)) {
    throw invalidValue("sessions.data");
  }

  if (("citizenship" in value && typeof value.citizenship !== "string") ||
      ("entryDate" in value && typeof value.entryDate !== "string") ||
      ("selected" in value && typeof value.selected !== "string")) {
    throw invalidValue("sessions.data");
  }
  for (const completion of Object.values(value.completions)) {
    if (typeof completion !== "string") throw invalidValue("sessions.data.completions");
  }
  for (const checked of Object.values(value.documents)) {
    if (typeof checked !== "boolean") throw invalidValue("sessions.data.documents");
  }
  return value as unknown as Session;
}

function readClaimedJob(row: ClaimedJobRow): PostgresJob {
  const id = nonEmptyString(row.id, "outbox.id");
  const userId = safeInteger(row.user_id, "outbox.user_id", 1);
  const payload = nonEmptyString(row.payload, "outbox.payload");
  const kind = readJobKind(row.kind);
  const attempts = safeInteger(row.attempts, "outbox.attempts");
  const nextAttempt = safeInteger(row.next_attempt, "outbox.next_attempt");
  const leaseToken = readLeaseToken(row.lease_token);
  try {
    if (!isRecord(JSON.parse(payload) as unknown)) throw invalidValue("outbox.payload");
  } catch {
    throw invalidValue("outbox.payload");
  }
  return {
    id,
    user_id: userId,
    payload,
    kind,
    attempts,
    next_attempt: nextAttempt,
    lease_token: leaseToken,
  };
}

function readJobKind(value: unknown): PostgresJobKind {
  if (value === "reply" || value === "reminder") return value;
  throw invalidValue("outbox.kind");
}

function readJobStatus(value: unknown): PostgresJobStatus {
  if (typeof value === "string" && jobStatuses.includes(value as PostgresJobStatus)) {
    return value as PostgresJobStatus;
  }
  throw invalidValue("outbox.status");
}

function readLeaseToken(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw invalidValue("outbox.lease_token");
  return value;
}

function validateTimestamp(value: number, field: string): void {
  safeInteger(value, field);
}

function validateId(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw invalidValue(field);
}

function serializeObject(value: object, field: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalidValue(field);
  }
  if (typeof serialized !== "string") throw invalidValue(field);

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw invalidValue(field);
  }
  if (!isRecord(parsed)) throw invalidValue(field);
  return serialized;
}

function safeInteger(value: unknown, field: string, minimum = 0): number {
  const min = BigInt(minimum);
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (typeof value === "bigint") {
    if (value < min || value > max) throw invalidValue(field);
    return Number(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < minimum) throw invalidValue(field);
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const integer = BigInt(value);
    if (integer < min || integer > max) throw invalidValue(field);
    return Number(integer);
  }
  throw invalidValue(field);
}

function addSafeIntegers(left: number, right: number, field: string): number {
  const value = left + right;
  return safeInteger(value, field);
}

function nonEmptyString(value: unknown, field: string): string {
  if (!nonEmptyStringValue(value)) throw invalidValue(field);
  return value;
}

function nonEmptyStringValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafeInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidValue(field: string): Error {
  return new Error(`Некорректное значение PostgreSQL: ${field}`);
}

async function runInTransaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const value = await fn();
    await client.query("COMMIT");
    transactionStarted = false;
    return value;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original failure if PostgreSQL has already lost the connection.
      }
    }
    throw error;
  }
}

async function lockUser(client: PoolClient, userId: number): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [userId]);
}
