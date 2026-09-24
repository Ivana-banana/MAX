import { createHash } from "node:crypto";
import { reminderDates } from "../core/deadlines.js";
import { addDays } from "../core/dates.js";
import { plan, reminderReply, transition, type DialogueContext, type Input, type Reply } from "./dialog.js";
import { funnelEvents, funnelUniversity } from "./funnel.js";
import { Store } from "./store.js";

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
  constructor(readonly store: Store, readonly context: Omit<DialogueContext, "today">, readonly transport: Transport, readonly clock: () => number = Date.now) {}
  ctx(): DialogueContext { return { ...this.context, today: moscowDate(this.clock()) }; }
  receive(update: Incoming): void {
    const now = this.clock();
    this.store.transaction(() => {
      if (this.store.seen(update.id, now)) return;
      const before = this.store.get(update.user), ctx = this.ctx();
      const outcome = transition(before, update.input, ctx);
      const university = funnelUniversity(outcome.session ?? before, ctx);
      for (const event of funnelEvents(before, outcome.session, update.input, ctx)) this.store.count(ctx.today, university, event);
      this.store.supersedeReplies(update.user);
      this.store.cancelReminders(update.user);
      if (outcome.session) this.store.save(update.user, outcome.session, now);
      else this.store.remove(update.user);
      this.store.enqueue(update.id, update.user, outcome.reply, "reply", now, now);
      this.scheduleUser(update.user);
    });
  }
  scheduleUser(user: number, state = this.store.get(user)): void {
    const now = this.clock(), ctx = this.ctx();
    if (!state?.reminders || state.ruleVersion !== ctx.version) return;
    for (const item of plan(state, ctx)) {
      // One calm follow-up the day after the calculated date: the procedure is still required (D-021).
      const followUp = addDays(item.dueDate, 1);
      const days = [...reminderDates(item, ctx.today), ...(item.status !== "done" && followUp >= ctx.today ? [followUp] : [])];
      for (const day of days) {
        const when = Date.parse(day + "T09:00:00+03:00");
        const key = createHash("sha256").update(JSON.stringify([state.nonce, user, ctx.version, item.ruleId, item.dueDate, day])).digest("hex");
        this.store.enqueue(key, user, { ruleId: item.ruleId, dueDate: item.dueDate, day }, "reminder", when, now);
      }
    }
  }
  maintain(): void {
    this.store.transaction(() => {
      this.store.prune(this.clock());
      for (const { user, state } of this.store.sessions()) this.scheduleUser(user, state);
    });
  }
  async flush(limit = 20): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      for (let n = 0; n < limit; n++) {
        const job = this.store.next(this.clock());
        if (!job) return;
        let message: Reply;
        if (job.kind === "reminder") {
          const state = this.store.get(job.user_id);
          const ref = JSON.parse(job.payload) as {ruleId:string;dueDate:string;day?:string};
          const item = state && state.ruleVersion === this.context.version && state.reminders
            ? plan(state, this.ctx()).find(i => i.ruleId === ref.ruleId && i.dueDate === ref.dueDate && i.status !== "done") : undefined;
          // Before the date a late reminder is still useful; the follow-up after it goes only on its own day.
          const today = this.ctx().today, followUp = ref.day !== undefined && ref.day > ref.dueDate;
          if (!state || !item || (followUp ? ref.day !== today : item.dueDate < today)) { this.store.cancel(job.id); continue; }
          message = reminderReply(state, this.ctx(), item);
        } else {
          message = JSON.parse(job.payload) as Reply;
          if (message.ruleVersion !== this.context.version) { this.store.cancel(job.id); continue; }
        }
        try { await this.transport.send(job.user_id, message); this.store.finish(job.id); }
        catch { this.store.retry(job, this.clock()); continue; }
        // Outside the send block: a failed counter must not resend the reminder.
        if (job.kind === "reminder") {
          try { this.store.count(this.ctx().today, funnelUniversity(this.store.get(job.user_id), this.context), "reminder_sent"); }
          catch { console.error("Funnel counter failed; the reminder was delivered."); }
        }
      }
    } finally { this.sending = false; }
  }
}
