/**
 * Summary for a university's international office (D-042): how many students have a plan, turned
 * reminders on, have a deadline this week or a missed one, planned a visit. Counts only — no MAX ID,
 * entry date or citizenship — and small groups are hidden, so one student cannot be recognised.
 * The marks are the students' own words, not a check by the Interior Ministry.
 */

import { plan, profile, type DialogueContext, type Session } from "./dialog.js";
import { funnelUniversity, type FunnelCount, type FunnelEvent } from "./funnel.js";

/** Counts below this are printed as "<3". */
export const SMALL = 3;

export interface ProcedureCounts { dueSoon: number; overdue: number; done: number }
export interface UniversityCounts { plans: number; reminders: number; visits: number; procedures: Record<string, ProcedureCounts> }

export function officeSnapshot(sessions: Session[], ctx: DialogueContext): Record<string, UniversityCounts> {
  const out: Record<string, UniversityCounts> = {};
  for (const s of sessions) {
    if (!profile(s) || s.ruleVersion !== ctx.version) continue;
    const u = (out[funnelUniversity(s, ctx)] ??= { plans: 0, reminders: 0, visits: 0, procedures: {} });
    u.plans++;
    if (s.reminders) u.reminders++;
    if (Object.keys(s.visits ?? {}).length) u.visits++;
    for (const item of plan(s, ctx)) {
      const p = (u.procedures[item.ruleId] ??= { dueSoon: 0, overdue: 0, done: 0 });
      if (s.completions[item.ruleId]) p.done++;
      else if (item.status === "dueSoon") p.dueSoon++;
      else if (item.status === "overdue") p.overdue++;
    }
  }
  return out;
}

const shown = (n: number) => n > 0 && n < SMALL ? `<${SMALL}` : String(n);

/** Plain text for one university, ready to send to its office. */
export function officeReport(snapshot: Record<string, UniversityCounts>, funnel: FunnelCount[], ctx: DialogueContext, universityId: string): string {
  const university = ctx.universities.find(u => u.id === universityId);
  const name = university?.name.ru ?? universityId;
  const u = snapshot[universityId] ?? { plans: 0, reminders: 0, visits: 0, procedures: {} };
  const total = (event: FunnelEvent) => funnel.filter(r => r.university === universityId && r.event === event).reduce((a, r) => a + r.n, 0);
  const lines = [`Сводка для международного отдела: ${name}, на ${ctx.today}`, "",
    `Профилей с планом: ${shown(u.plans)}`,
    `Включили напоминания: ${shown(u.reminders)}`,
    `Запланировали визит: ${shown(u.visits)}`, ""];
  for (const rule of ctx.rules) {
    const p = u.procedures[rule.id] ?? { dueSoon: 0, overdue: 0, done: 0 };
    lines.push(`${rule.title.ru}: срок в ближайшие 7 дней — ${shown(p.dueSoon)}, просрочено без отметки — ${shown(p.overdue)}, отмечено — ${shown(p.done)}`);
  }
  lines.push("", `Отправлено напоминаний: ${shown(total("reminder_sent"))}`, `Открыли «Не получилось»: ${shown(total("help_opened"))}`, "",
    `Числа меньше ${SMALL} скрыты, чтобы нельзя было узнать конкретного студента. Отметки «пройдено» — со слов студентов, а не проверка МВД.`,
    "MAX ID, даты въезда и гражданство в сводку не попадают.");
  return lines.join("\n");
}
