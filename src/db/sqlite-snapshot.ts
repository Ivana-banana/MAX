import { DatabaseSync } from "node:sqlite";
import { FUNNEL_EVENTS, type FunnelCount } from "../bot/funnel.js";

export interface SqliteSnapshot {
  sessions: { userId: number; data: unknown; rawDataJson: string; updatedAt: number }[];
  events: { id: string; createdAt: number }[];
  outbox: {
    id: string;
    userId: number;
    payload: unknown;
    rawPayloadJson: string;
    kind: "reply" | "reminder";
    attempts: number;
    nextAttempt: number;
    status: "pending" | "sent" | "cancelled" | "failed";
    createdAt: number;
  }[];
  // Empty for databases created before the funnel counters (D-019).
  funnel: FunnelCount[];
}

type Row = Record<string, unknown>;

export function readSqliteSnapshot(path: string): SqliteSnapshot {
  const db = new DatabaseSync(path, { readOnly: true });

  try {
    const sessions = readRows(db, "sessions", `
      SELECT user_id, data, updated_at
      FROM sessions
      ORDER BY user_id
    `).map(readSession);

    const events = readRows(db, "events", `
      SELECT id, created_at
      FROM events
      ORDER BY created_at, id
    `).map(readEvent);

    const outbox = readRows(db, "outbox", `
      SELECT id, user_id, payload, kind, attempts, next_attempt, status, created_at
      FROM outbox
      ORDER BY created_at, id
    `).map(readOutboxJob);

    const hasFunnel = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'funnel'").get() !== undefined;
    const funnel = hasFunnel ? readRows(db, "funnel", `
      SELECT day, university, event, n
      FROM funnel
      ORDER BY day, university, event
    `).map(readFunnelCount) : [];

    return { sessions, events, outbox, funnel };
  } finally {
    db.close();
  }
}

function readRows(db: DatabaseSync, table: string, sql: string): unknown[] {
  try {
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all();
  } catch {
    throw new Error(`Не удалось прочитать таблицу SQLite ${table}`);
  }
}

function readSession(value: unknown): SqliteSnapshot["sessions"][number] {
  const row = asRow(value, "sessions");
  const data = parseJson(row.data, "sessions.data");
  return {
    userId: safeInteger(row.user_id, "sessions.user_id", 1),
    data: data.value,
    rawDataJson: data.rawJson,
    updatedAt: safeInteger(row.updated_at, "sessions.updated_at"),
  };
}

function readEvent(value: unknown): SqliteSnapshot["events"][number] {
  const row = asRow(value, "events");
  return {
    id: nonEmptyString(row.id, "events.id"),
    createdAt: safeInteger(row.created_at, "events.created_at"),
  };
}

function readOutboxJob(value: unknown): SqliteSnapshot["outbox"][number] {
  const row = asRow(value, "outbox");
  const payload = parseJson(row.payload, "outbox.payload");
  return {
    id: nonEmptyString(row.id, "outbox.id"),
    userId: safeInteger(row.user_id, "outbox.user_id", 1),
    payload: payload.value,
    rawPayloadJson: payload.rawJson,
    kind: outboxKind(row.kind),
    attempts: safeInteger(row.attempts, "outbox.attempts"),
    nextAttempt: safeInteger(row.next_attempt, "outbox.next_attempt"),
    status: outboxStatus(row.status),
    createdAt: safeInteger(row.created_at, "outbox.created_at"),
  };
}

function readFunnelCount(value: unknown): FunnelCount {
  const row = asRow(value, "funnel");
  if (!FUNNEL_EVENTS.includes(row.event as FunnelCount["event"])) throw invalidValue("funnel.event");
  return {
    day: nonEmptyString(row.day, "funnel.day"),
    university: nonEmptyString(row.university, "funnel.university"),
    event: row.event as FunnelCount["event"],
    n: safeInteger(row.n, "funnel.n", 1),
  };
}

function asRow(value: unknown, table: string): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidValue(`${table} row`);
  }
  return value as Row;
}

function safeInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value === "bigint") {
    if (value < BigInt(minimum) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw invalidValue(field);
    }
    return Number(value);
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw invalidValue(field);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalidValue(field);
  return value;
}

function parseJson(value: unknown, field: string): { value: unknown; rawJson: string } {
  if (typeof value !== "string") throw invalidValue(field);
  try {
    return { value: JSON.parse(value) as unknown, rawJson: value };
  } catch {
    throw invalidValue(field);
  }
}

function outboxKind(value: unknown): "reply" | "reminder" {
  if (value === "reply" || value === "reminder") return value;
  throw invalidValue("outbox.kind");
}

function outboxStatus(value: unknown): "pending" | "sent" | "cancelled" | "failed" {
  if (value === "pending" || value === "sent" || value === "cancelled" || value === "failed") {
    return value;
  }
  throw invalidValue("outbox.status");
}

function invalidValue(field: string): Error {
  return new Error(`Некорректное значение SQLite: ${field}`);
}
