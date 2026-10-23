import { createHash, randomUUID } from "node:crypto";
import { REMINDER_OFFSETS, reminderDates } from "../core/deadlines.js";
import { changeReminderDates } from "../core/changes.js";
import { addDays } from "../core/dates.js";
import type { PostgresJob, PostgresStore, PostgresStoreTx } from "../db/postgres-store.js";
import { errorInfo } from "../log.js";
import { changeReminderReply, limitedReply, plan, procedureDue, procedureReminderReply, reminderReply, reportedChanges, transition, undated, visitReply,
  type DialogueContext, type Input, type Reply, type Session } from "./dialog.js";
import { funnelEvents, funnelUniversity, type FunnelEvent } from "./funnel.js";
import { PLAN_FILE, renderPlanPdf } from "./pdf.js";
import { RateLimit } from "./rate.js";

export interface Incoming { id: string; user: number; input: Input; callbackId?: string }
/** `notification`: a one-time notice on the pressed button (POST /answers). */
export interface Transport { send(user: number, reply: Reply): Promise<void>; answer?(id: string, notification?: string): Promise<void> }
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
/**
 * D-047: started and deleted count once per user a day, so a /start → /delete loop cannot inflate them.
 * The mark is a hash in the events table (kept 7 days like update ids); the funnel itself gets no MAX ID.
 */
export async function countEvents(tx: PostgresStoreTx, user: number, day: string, university: string, events: FunnelEvent[], now: number): Promise<void> {
  for (const event of events) {
    if ((event === "started" || event === "deleted") &&
        await tx.seen(createHash("sha256").update(JSON.stringify(["funnel", user, day, event])).digest("hex"), now)) continue;
    await tx.count(day, university, event);
  }
}
export class Service {
  private sending = false;
  private maintained = -Infinity;
  constructor(readonly store: PostgresStore, readonly context: Omit<DialogueContext, "today">, readonly transport: Transport, readonly clock: () => number = Date.now,
    readonly limit = new RateLimit(Infinity), readonly sendTimeoutMs = 30_000) {}
  ctx(): DialogueContext { return { ...this.context, today: moscowDate(this.clock()) }; }
  // Resolves after COMMIT: the webhook answers 200 only for a stored update. Returns the notice for the pressed button.
  async receive(update: Incoming): Promise<string | undefined> {
    const now = this.clock();
    let notice: string | undefined;
    await this.store.transaction(update.user, async tx => {
      if (await tx.seen(update.id, now)) return;
      // After seen(): a redelivered update must not spend the limit. Over it the update is dropped, not
      // refused: MAX would retry a non-200 answer. One notice a minute.
      const over = this.limit.take(update.user, now);
      if (over > 0) {
        if (over === 1) await tx.enqueue(update.id, limitedReply(await tx.get(), update.input, this.ctx()), "reply", now, now);
        return;
      }
      const before = await tx.get(), ctx = this.ctx();
      const outcome = transition(before, update.input, ctx);
      notice = outcome.notice;
      const university = funnelUniversity(outcome.session ?? before, ctx);
      // A refused stale button (a double tap) changed nothing: it must neither count as a step nor
      // replace the screen the first tap queued, or the user gets only "the button is outdated".
      if (!outcome.expired) {
        await countEvents(tx, update.user, ctx.today, university, funnelEvents(before, outcome.session, update.input, ctx), now);
        await tx.supersedeReplies();
      }
      await tx.cancelReminders();
      if (outcome.session) await tx.save(outcome.session, now);
      else await tx.remove();
      await tx.enqueue(update.id, outcome.reply, "reply", now, now);
      await this.scheduleUser(tx, update.user, outcome.session);
    });
    return notice;
  }
  async scheduleUser(tx: PostgresStoreTx, user: number, state: Session | null): Promise<void> {
    const now = this.clock(), ctx = this.ctx();
    if (!state?.reminders || state.ruleVersion !== ctx.version) return;
    for (const item of plan(state, ctx)) {
      // One calm follow-up the day after the calculated date: the procedure is still required (D-021).
      const followUp = addDays(item.dueDate, 1);
      const days = [...reminderDates(item, ctx.today), ...(item.status !== "done" && followUp >= ctx.today ? [followUp] : [])];
      for (const day of days) {
        const when = Date.parse(day + "T09:00:00+03:00");
        const key = createHash("sha256").update(JSON.stringify([state.nonce, user, ctx.version, item.ruleId, item.dueDate, day])).digest("hex");
        await tx.enqueue(key, { ruleId: item.ruleId, dueDate: item.dueDate, day }, "reminder", when, now);
      }
      // The evening before a planned visit (18:00 Moscow time): what is still missing from the checklist.
      const visit = item.status === "done" ? undefined : state.visits?.[item.ruleId];
      if (visit && addDays(visit, -1) >= ctx.today) {
        const key = createHash("sha256").update(JSON.stringify([state.nonce, user, ctx.version, item.ruleId, item.dueDate, "visit", visit])).digest("hex");
        await tx.enqueue(key, { ruleId: item.ruleId, dueDate: item.dueDate, visit }, "reminder", Date.parse(addDays(visit, -1) + "T18:00:00+03:00"), now);
      }
    }
    await this.scheduleProcedures(tx, user, state, ctx, now);
    // #41: a deadline after a change of circumstances, 3 days and 1 day before and on the day, at 09:00.
    for (const { situation, deadline } of reportedChanges(state, ctx)) {
      if (!deadline.due) continue;
      for (const day of changeReminderDates(deadline.due, ctx.today)) {
        const key = createHash("sha256").update(JSON.stringify([state.nonce, user, ctx.version, "change", situation.id, deadline.event, day])).digest("hex");
        await tx.enqueue(key, { ruleId: situation.id, dueDate: deadline.due, change: situation.id, event: deadline.event, day }, "reminder",
          Date.parse(day + "T09:00:00+03:00"), now);
      }
    }
  }
  // D-040: a university deadline counted from a document end date, reminded 7, 3 and 1 days before at 09:00.
  private async scheduleProcedures(tx: PostgresStoreTx, user: number, state: Session, ctx: DialogueContext, now: number): Promise<void> {
    for (const note of undated(state, ctx)) {
      const counted = procedureDue(state, ctx, note);
      if (!counted) continue;
      for (const offset of REMINDER_OFFSETS) {
        const day = addDays(counted.due, -offset);
        if (day < ctx.today) continue;
        const key = createHash("sha256").update(JSON.stringify([state.nonce, user, ctx.version, "procedure", note.id, counted.end, day])).digest("hex");
        await tx.enqueue(key, { ruleId: note.id, dueDate: counted.due, procedure: note.id, end: counted.end, day }, "reminder",
          Date.parse(day + "T09:00:00+03:00"), now);
      }
    }
  }
  // One user at a time under the same lock as receive(): a concurrent update cannot interleave.
  async maintain(): Promise<void> {
    this.limit.prune(this.clock());
    await this.store.prune(this.clock());
    for (const { user } of await this.store.sessions()) {
      await this.store.transaction(user, async tx => this.scheduleUser(tx, user, await tx.get()));
    }
  }
  // #65: a hung request must not hold the tick. On timeout the caller takes its usual failure path (retry).
  private async deliver(user: number, message: Reply): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { console.error("Send timed out; the message stays in the outbox for a retry."); reject(new Error("send timeout")); }, this.sendTimeoutMs);
    });
    try { await Promise.race([this.transport.send(user, message), timeout]); } finally { clearTimeout(timer); }
  }
  /**
   * The PDF is built here, after the button has its notice and outside the user lock. A file that cannot
   * be built or delivered is said in the chat with a retry (#112), not left to the queue in silence.
   */
  private async deliverReply(user: number, { pdf, failed, ...reply }: Reply): Promise<void> {
    try {
      if (pdf) reply.file = { name: PLAN_FILE, content: (await renderPlanPdf(pdf)).toString("base64"), encoding: "base64" };
      await this.deliver(user, reply);
    } catch (e) {
      if (!failed) throw e;
      console.error(`File reply failed (${errorInfo(e)}); the user is offered a retry.`);
      await this.deliver(user, failed);
    }
  }
  /** One pass of the background loop: maintenance once a minute, then the queue. */
  async tick(): Promise<void> {
    const now = this.clock();
    if (now - this.maintained >= 60_000) {
      this.maintained = now;
      // Maintenance only prunes and schedules reminders: its failure must not hold back replies already queued.
      try { await this.maintain(); } catch (e) { console.error(`Maintenance failed (${errorInfo(e)}); inspect storage.`); }
    }
    await this.flush();
  }
  /** A failed send goes back to the queue; the log says why, and which attempt it was. */
  private async failed(job: PostgresJob, error: unknown): Promise<void> {
    console.error(`Send failed (job ${job.id}, ${job.kind}, attempt ${job.attempts + 1}): ${errorInfo(error)}`);
    await this.store.retry(job, this.clock());
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
          const ref = JSON.parse(job.payload) as {ruleId:string;dueDate:string;day?:string;visit?:string;procedure?:string;end?:string;change?:string;event?:string};
          if (ref.change !== undefined) {
            const ctx = this.ctx();
            const found = state && state.ruleVersion === this.context.version && state.reminders
              ? reportedChanges(state, ctx).find(r => r.situation.id === ref.change) : undefined;
            // Only for the event date still entered, and not after the deadline.
            if (!state || !found?.deadline.due || found.deadline.event !== ref.event || found.deadline.due < ctx.today) { await this.store.cancel(job.id, job.lease_token); continue; }
            message = changeReminderReply(state, ctx, found.situation, found.deadline.due);
            try { await this.deliver(job.user_id, message); await this.store.finish(job.id, job.lease_token); }
            catch (e) { await this.failed(job, e); }
            continue;
          }
          if (ref.procedure !== undefined) {
            const ctx = this.ctx();
            const note = state && state.ruleVersion === this.context.version && state.reminders
              ? undated(state, ctx).find(n => n.id === ref.procedure) : undefined;
            const counted = note && state ? procedureDue(state, ctx, note) : undefined;
            // Only for the end date still entered, and not after the counted date.
            if (!state || !note || !counted || counted.end !== ref.end || counted.due < ctx.today) { await this.store.cancel(job.id, job.lease_token); continue; }
            message = procedureReminderReply(state, ctx, note, counted.due);
            try { await this.deliver(job.user_id, message); await this.store.finish(job.id, job.lease_token); }
            catch (e) { await this.failed(job, e); }
            continue;
          }
          const item = state && state.ruleVersion === this.context.version && state.reminders
            ? plan(state, this.ctx()).find(i => i.ruleId === ref.ruleId && i.dueDate === ref.dueDate && i.status !== "done") : undefined;
          if (ref.visit !== undefined) {
            // Only the visit still planned for that day, and not once it has passed.
            if (!state || !item || state.visits?.[item.ruleId] !== ref.visit || ref.visit < this.ctx().today) { await this.store.cancel(job.id, job.lease_token); continue; }
            message = visitReply(state, this.ctx(), item);
            try { await this.deliver(job.user_id, message); await this.store.finish(job.id, job.lease_token); }
            catch (e) { await this.failed(job, e); }
            continue;
          }
          // Before the date a late reminder is still useful; the follow-up after it goes only on its own day.
          const today = this.ctx().today, followUp = ref.day !== undefined && ref.day > ref.dueDate;
          if (!state || !item || (followUp ? ref.day !== today : item.dueDate < today)) { await this.store.cancel(job.id, job.lease_token); continue; }
          message = reminderReply(state, this.ctx(), item);
        } else {
          message = JSON.parse(job.payload) as Reply;
          if (message.ruleVersion !== this.context.version) { await this.store.cancel(job.id, job.lease_token); continue; }
        }
        try { await this.deliverReply(job.user_id, message); await this.store.finish(job.id, job.lease_token); }
        catch (e) { await this.failed(job, e); continue; }
        // Outside the send block: a failed counter must not resend the reminder.
        if (job.kind === "reminder") {
          try { await this.store.count(this.ctx().today, funnelUniversity(await this.store.get(job.user_id), this.context), "reminder_sent"); }
          catch (e) { console.error(`Funnel counter failed (${errorInfo(e)}); the reminder was delivered.`); }
        }
      }
    } finally { this.sending = false; }
  }
}
