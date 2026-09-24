import { createHash, randomUUID } from "node:crypto";
import { reminderDates } from "../core/deadlines.js";
import type { PostgresStore, PostgresStoreTx } from "../db/postgres-store.js";
import { plan, reminderReply, transition, type DialogueContext, type Input, type Reply, type Session } from "./dialog.js";
import { funnelEvents, funnelUniversity } from "./funnel.js";

export interface Incoming { id: string; user: number; input: Input; callbackId?: string }
export interface Transport { send(user: number, reply: Reply): Promise<void>; answer?(id: string): Promise<void> }
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
export function parseUpdate(raw: unknown): Incoming | null {
  const u = object(raw);
  if (!u || typeof u.update_type !== "string") throw new Error("invalid update");
  let user: unknown, text: unknown, id: unknown, callbackId: string | undefined, locale: string | undefined;
  if (u.update_type === "bot_started") {
    // ?start=<payload> (up to 128 characters) selects the university; anything else starts as usual.
    const payload = typeof u.payload === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(u.payload) ? u.payload : undefined;
    user = object(u.user)?.user_id; text = payload ? `/start ${payload}` : "/start"; id = u.timestamp;
    if (typeof u.user_locale === "string" && /^[A-Za-z_-]{2,16}$/.test(u.user_locale)) locale = u.user_locale;
  } else if (u.update_type === "message_created" || u.update_type === "message_callback") {
    const m = object(u.message), recipient = object(m?.recipient);
    if (recipient?.chat_type !== "dialog") return null;
    if (u.update_type === "message_created") {
      if (object(m?.sender)?.is_bot === true) return null;
      user = object(m?.sender)?.user_id; text = object(m?.body)?.text; id = object(m?.body)?.mid;
      if (text == null) return null;
    } else {
      const cb = object(u.callback);
      user = object(cb?.user)?.user_id; text = cb?.payload; id = cb?.callback_id;
      if (typeof id === "string") callbackId = id;
    }
  } else return null;
  if (!Number.isSafeInteger(user) || Number(user) <= 0 || typeof text !== "string" || text.length > 4096 ||
      !((typeof id === "string" && id.length > 0 && id.length <= 256) || (typeof id === "number" && Number.isSafeInteger(id) && id > 0))) {
    throw new Error("invalid update");
  }
  const digest = createHash("sha256").update(JSON.stringify([u.update_type, user, id])).digest("hex");
  return { id: digest, user: Number(user), input: { text, callback: u.update_type === "message_callback", ...(locale ? { locale } : {}) },
    ...(callbackId === undefined ? {} : { callbackId }) };
}
export function moscowDate(now: number): string {
  return new Date(now + 3 * 3600000).toISOString().slice(0, 10);
}
export class Service {
  private sending = false;
  constructor(readonly store: PostgresStore, readonly context: Omit<DialogueContext, "today">, readonly transport: Transport, readonly clock: () => number = Date.now) {}
  ctx(): DialogueContext { return { ...this.context, today: moscowDate(this.clock()) }; }
  // Resolves after COMMIT: the webhook answers 200 only for a stored update.
  async receive(update: Incoming): Promise<void> {
    const now = this.clock();
    await this.store.transaction(update.user, async tx => {
      if (await tx.seen(update.id, now)) return;
      const before = await tx.get(), ctx = this.ctx();
      const outcome = transition(before, update.input, ctx);
      const university = funnelUniversity(outcome.session ?? before, ctx);
      for (const event of funnelEvents(before, outcome.session, update.input, ctx)) await tx.count(ctx.today, university, event);
      await tx.supersedeReplies();
      await tx.cancelReminders();
      if (outcome.session) await tx.save(outcome.session, now);
      else await tx.remove();
      await tx.enqueue(update.id, outcome.reply, "reply", now, now);
      await this.scheduleUser(tx, update.user, outcome.session);
    });
  }
  async scheduleUser(tx: PostgresStoreTx, user: number, state: Session | null): Promise<void> {
    const now = this.clock(), ctx = this.ctx();
    if (!state?.reminders || state.ruleVersion !== ctx.version) return;
    for (const item of plan(state, ctx)) {
      for (const day of reminderDates(item, ctx.today)) {
        const when = Date.parse(day + "T09:00:00+03:00");
        const key = createHash("sha256").update(JSON.stringify([state.nonce, user, ctx.version, item.ruleId, item.dueDate, day])).digest("hex");
        await tx.enqueue(key, { ruleId: item.ruleId, dueDate: item.dueDate }, "reminder", when, now);
      }
    }
  }
  // One user at a time under the same lock as receive(): a concurrent update cannot interleave.
  async maintain(): Promise<void> {
    await this.store.prune(this.clock());
    for (const { user } of await this.store.sessions()) {
      await this.store.transaction(user, async tx => this.scheduleUser(tx, user, await tx.get()));
    }
  }
  async flush(limit = 20): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      for (let n = 0; n < limit; n++) {
        const job = await this.store.claim(this.clock(), randomUUID());
        if (!job) return;
        let message: Reply;
        if (job.kind === "reminder") {
          const state = await this.store.get(job.user_id);
          const ref = JSON.parse(job.payload) as {ruleId:string;dueDate:string};
          const item = state && state.ruleVersion === this.context.version && state.reminders
            ? plan(state, this.ctx()).find(i => i.ruleId === ref.ruleId && i.dueDate === ref.dueDate && i.status !== "done") : undefined;
          if (!state || !item || item.dueDate < this.ctx().today) { await this.store.cancel(job.id, job.lease_token); continue; }
          message = reminderReply(state, this.ctx(), item);
        } else {
          message = JSON.parse(job.payload) as Reply;
          if (message.ruleVersion !== this.context.version) { await this.store.cancel(job.id, job.lease_token); continue; }
        }
        try { await this.transport.send(job.user_id, message); await this.store.finish(job.id, job.lease_token); }
        catch { await this.store.retry(job, this.clock()); continue; }
        // Outside the send block: a failed counter must not resend the reminder.
        if (job.kind === "reminder") {
          try { await this.store.count(this.ctx().today, funnelUniversity(await this.store.get(job.user_id), this.context), "reminder_sent"); }
          catch { console.error("Funnel counter failed; the reminder was delivered."); }
        }
      }
    } finally { this.sending = false; }
  }
}
