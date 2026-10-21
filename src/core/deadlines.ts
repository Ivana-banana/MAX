/**
 * The deadline engine: personal dates from a personal event.
 *
 * This is the core that must survive a move to another region, university or
 * category of foreigner (docs/product/scaling.md). It therefore knows nothing about
 * migration, Russia or universities — only about rules, profiles and dates.
 */

import { addDays, addMonths, compareDates, daysBetween, parseDate } from "./dates.js";
import type {
  Completions,
  Condition,
  DeadlineRule,
  PlainDate,
  PlanItem,
  PlanItemStatus,
  UserProfile,
} from "./types.js";

/** A deadline closer than this many days is shown as urgent. */
export const DUE_SOON_DAYS = 7;

/** When reminders fire before a deadline, in days. */
export const REMINDER_OFFSETS = [7, 3, 1] as const;

export function matchesCondition(condition: Condition, profile: UserProfile): boolean {
  switch (condition.field) {
    case "citizenship": {
      const has = condition.values.includes(profile.citizenship);
      return condition.op === "in" ? has : !has;
    }
    case "purpose":
      return profile.purpose === condition.value;
    case "entryDate": {
      const diff = compareDates(profile.entryDate, condition.value);
      return condition.op === "onOrAfter" ? diff >= 0 : diff < 0;
    }
  }
}

/**
 * What a rule set covers, read from its own conditions: the earliest entry date any rule
 * accepts and the citizenships every rule excludes. The dialogue asks only within these
 * bounds, so a new category or period is a data change, not a code change.
 */
export function coverage(rules: DeadlineRule[]): { from: PlainDate; excluded: string[] } {
  const starts = rules.flatMap(r => r.appliesIf.flatMap(c => c.field === "entryDate" && c.op === "onOrAfter" ? [c.value] : []));
  if (!starts.length) throw new Error("Rules must bound the entry date (entryDate onOrAfter)");
  const excludedBy = rules.map(r => new Set(r.appliesIf.flatMap(c => c.field === "citizenship" && c.op === "notIn" ? c.values : [])));
  return { from: starts.sort(compareDates)[0]!, excluded: [...excludedBy[0] ?? []].filter(code => excludedBy.every(set => set.has(code))) };
}

export function isApplicable(rule: DeadlineRule, profile: UserProfile): boolean {
  return rule.appliesIf.every((condition) => matchesCondition(condition, profile));
}

/**
 * Due date for the first round of a rule.
 *
 * `counting` decides whether the day of the event is day one. That is a legal
 * question, not a coding one, so each rule carries the answer and a lawyer confirms
 * it; the engine only applies what the data says.
 */
export function computeDueDate(rule: DeadlineRule, profile: UserProfile, days = rule.term.days): PlainDate {
  parseDate(profile.entryDate);
  const offset = rule.term.counting === "eventDay" ? days - 1 : days;
  return addDays(profile.entryDate, offset);
}

function statusFor(dueDate: PlainDate, today: PlainDate, done: boolean): PlanItemStatus {
  if (done) return "done";
  const daysLeft = daysBetween(today, dueDate);
  if (daysLeft < 0) return "overdue";
  if (daysLeft <= DUE_SOON_DAYS) return "dueSoon";
  return "ok";
}

/**
 * Builds the personal plan.
 *
 * A completed rule that repeats is replaced by its next round, counted from the
 * completion date: that is the case nobody currently reminds anyone about
 * (docs/product/as-is-to-be.md, step 10). A completed rule that does not repeat
 * stays in the plan as `done` so the user can see what is already closed.
 *
 * `earlierDays` (rule id → days) is an earlier target set by someone other than the law, e.g. the
 * university: counted like the rule's own term, it becomes `recommendedDate`, while `dueDate` and the
 * reminders stay on the legal term.
 */
export function buildPlan(
  rules: readonly DeadlineRule[],
  profile: UserProfile,
  completions: Completions,
  today: PlainDate,
  earlierDays: Readonly<Record<string, number>> = {},
): PlanItem[] {
  const items: PlanItem[] = [];

  for (const rule of rules) {
    if (!isApplicable(rule, profile)) continue;

    const completedAt = completions[rule.id];
    const isRepeat = completedAt !== undefined && rule.repeat !== undefined;

    const done = completedAt !== undefined && !isRepeat;
    const earlier = earlierDays[rule.id];
    const recommendedDate = isRepeat ? addMonths(completedAt, rule.repeat!.months)
      : earlier !== undefined && !done ? computeDueDate(rule, profile, earlier) : undefined;
    const dueDate = isRepeat
      ? addDays(recommendedDate!, rule.repeat!.graceDays ?? 0)
      : computeDueDate(rule, profile);

    items.push({
      ruleId: rule.id,
      title: rule.title,
      action: rule.action,
      dueDate,
      ...(recommendedDate === undefined ? {} : { recommendedDate }),
      daysLeft: daysBetween(today, dueDate),
      status: statusFor(dueDate, today, done),
      documents: rule.documents,
      ...(rule.documentsSource === undefined ? {} : { documentsSource: rule.documentsSource }),
      ...(rule.consequence === undefined ? {} : { consequence: rule.consequence }),
      legal: rule.legal,
      isRepeat,
      provisional: rule.legal.status !== "approved",
    });
  }

  return sortPlan(items);
}

/**
 * Closed items sink to the bottom; the rest are ordered by how soon they are due, so
 * the first thing the user sees is the thing that bites first.
 */
function sortPlan(items: PlanItem[]): PlanItem[] {
  return [...items].sort((a, b) => {
    if (a.status === "done" && b.status !== "done") return 1;
    if (b.status === "done" && a.status !== "done") return -1;
    const byDate = compareDates(a.dueDate, b.dueDate);
    return byDate !== 0 ? byDate : a.ruleId.localeCompare(b.ruleId);
  });
}

/**
 * Reminder dates for one plan item, earliest first.
 *
 * Reminders in the past are dropped: a student who installs the bot on day 40 must
 * not receive three notifications about a deadline that has already passed.
 */
export function reminderDates(item: PlanItem, today: PlainDate): PlainDate[] {
  if (item.status === "done") return [];

  return REMINDER_OFFSETS.map((offset) => addDays(item.dueDate, -offset))
    .filter((date) => compareDates(date, today) >= 0)
    .sort(compareDates);
}
