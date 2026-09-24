/**
 * Anonymous funnel counters for the hypothesis metrics (docs/product/hypothesis.md):
 * how many reach a plan, receive a reminder, return from it, prepare and mark a procedure.
 * Only per-day totals per university are kept — no MAX ID, dates of entry or citizenship,
 * so the counters are not linked to a person and survive /delete.
 */

import { FROM_REMINDER, plan, profile, type DialogueContext, type Input, type Session } from "./dialog.js";

export const FUNNEL_EVENTS = ["started", "plan_ready", "reminders_on", "reminder_sent", "reminder_opened", "checklist_completed",
  "marked_done", "help_opened", "deleted"] as const;
export type FunnelEvent = typeof FUNNEL_EVENTS[number];
export interface FunnelCount { day: string; university: string; event: FunnelEvent; n: number }

const ready = (s: Session, ctx: DialogueContext) => new Set(plan(s, ctx)
  .filter(i => i.documents.length > 0 && i.documents.every(d => s.documents[`${i.ruleId}:${i.dueDate}:${d.id}`]))
  .map(i => i.ruleId));

/** Events caused by one user action: compares the session before and after the transition. */
export function funnelEvents(before: Session | null, after: Session | null, input: Input, ctx: DialogueContext): FunnelEvent[] {
  const events: FunnelEvent[] = [];
  const action = input.callback ? input.text.slice(input.text.indexOf("|") + 1) : input.text.trim();
  if (!before && after) events.push("started");
  if (before && !after) events.push("deleted");
  if (!after) return events;
  if (!(before && profile(before)) && profile(after)) events.push("plan_ready");
  if (!before?.reminders && after.reminders) events.push("reminders_on");
  if (input.callback && action.startsWith("card:") && action.endsWith(FROM_REMINDER)) events.push("reminder_opened");
  if (action === "help" || action === "/help" || action.startsWith("help:")) events.push("help_opened");
  const was = before ? ready(before, ctx) : new Set<string>();
  for (const id of ready(after, ctx)) if (!was.has(id)) events.push("checklist_completed");
  for (const id of Object.keys(after.completions)) if (after.completions[id] !== before?.completions[id]) events.push("marked_done");
  return events;
}

/** University id for the counters: sessions without one belong to the default university. */
export const funnelUniversity = (s: Session | null, ctx: Pick<DialogueContext, "universities">) =>
  s?.university ?? ctx.universities[0]!.id;

const share = (part: number, whole: number) => whole ? `${Math.round(100 * part / whole)}%` : "—";

/** Text report: totals per university and the steps of the reminder metric. */
export function funnelReport(rows: FunnelCount[]): string {
  if (!rows.length) return "Счётчиков пока нет: в этой базе не было действий пользователей.";
  const days = rows.map(r => r.day).sort();
  const lines = [`Обезличенные счётчики за ${days[0]} — ${days.at(-1)} (МСК), без MAX ID:`];
  for (const university of [...new Set(rows.map(r => r.university))].sort()) {
    const total = (event: FunnelEvent) => rows.filter(r => r.university === university && r.event === event).reduce((a, r) => a + r.n, 0);
    lines.push("", `Вуз: ${university}`, ...FUNNEL_EVENTS.map(e => `  ${e.padEnd(20)} ${total(e)}`),
      `  дошли до плана из начавших:          ${share(total("plan_ready"), total("started"))}`,
      `  открыли напоминание из отправленных: ${share(total("reminder_opened"), total("reminder_sent"))}`);
  }
  lines.push("", "Это суммы событий, а не люди: один человек может открыть несколько напоминаний.",
    "Отметки «пройдено» — со слов пользователя, не подтверждение МВД (docs/product/hypothesis.md).");
  return lines.join("\n");
}
