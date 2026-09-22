import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Reply, Session } from "./dialog.js";

export interface Job { id: string; user_id: number; payload: string; kind: string; attempts: number; next_attempt: number }
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, payload TEXT NOT NULL, kind TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_jobs ON outbox(status, next_attempt);
    `);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  get(user: number): Session | null {
    const row = this.db.prepare("SELECT data FROM sessions WHERE user_id=?").get(user) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Session : null;
  }
  save(user: number, state: Session, now: number): void {
    this.db.prepare("INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at")
      .run(user, JSON.stringify(state), now);
  }
  remove(user: number): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(user);
    this.db.prepare("DELETE FROM outbox WHERE user_id=?").run(user);
  }
  seen(id: string, now: number): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO events VALUES(?,?)").run(id, now).changes === 0;
  }
  enqueue(id: string, user: number, payload: Reply | { ruleId: string; dueDate: string }, kind: string, when: number, now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO outbox(id,user_id,payload,kind,next_attempt,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, user, JSON.stringify(payload), kind, when, now);
  }
  cancelReminders(user: number): void {
    this.db.prepare("DELETE FROM outbox WHERE user_id=? AND kind='reminder' AND status='pending'").run(user);
  }
  supersedeReplies(user: number): void {
    this.db.prepare("DELETE FROM outbox WHERE user_id=? AND kind='reply' AND status='pending'").run(user);
  }
  sessions(): { user: number; state: Session }[] {
    return (this.db.prepare("SELECT user_id,data FROM sessions").all() as {user_id:number;data:string}[])
      .map(row => ({ user: row.user_id, state: JSON.parse(row.data) as Session }));
  }
  next(now: number): Job | undefined {
    return this.db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_attempt<=? ORDER BY next_attempt, rowid LIMIT 1").get(now) as Job | undefined;
  }
  finish(id: string): void { this.db.prepare("UPDATE outbox SET status='sent' WHERE id=?").run(id); }
  cancel(id: string): void { this.db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(id); }
  retry(job: Job, now: number): void {
    const attempts = job.attempts + 1;
    this.db.prepare("UPDATE outbox SET attempts=?,next_attempt=?,status=? WHERE id=?")
      .run(attempts, now + Math.min(3_600_000, 5000 * 2 ** attempts), attempts >= 8 ? "failed" : "pending", job.id);
  }
  counts(): Record<string, number> {
    return Object.fromEntries((this.db.prepare("SELECT status,COUNT(*) AS n FROM outbox GROUP BY status").all() as {status:string;n:number}[])
      .map(x => [x.status, x.n]));
  }
  prune(now: number): void {
    const expired = this.db.prepare("SELECT user_id FROM sessions WHERE updated_at<?").all(now - 400 * 86400000) as {user_id:number}[];
    for (const row of expired) this.remove(row.user_id);
    this.db.prepare("DELETE FROM events WHERE created_at<?").run(now - 7 * 86400000);
    this.db.prepare("DELETE FROM outbox WHERE status!='pending' AND MAX(created_at,next_attempt)<?").run(now - 7 * 86400000);
  }
  close(): void { this.db.close(); }
}
