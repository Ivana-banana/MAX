/**
 * How far along the plan is: "passed 2 of 5" and the one nearest step.
 *
 * Counted from the current plan, nothing is stored. A procedure the student has already passed and
 * that comes round again (`isRepeat`) is a passed one while its new date is far: it counts as done,
 * so the figure does not drop when a yearly procedure is marked. Once that date is near or missed,
 * it is open again and can be the next step (#103).
 */

import type { PlanItem } from "./types.js";

export interface PlanProgress<T> {
  done: number;
  total: number;
  /** The first unfinished procedure of a plan sorted by date; absent once all are passed. */
  next?: T;
}

export function planProgress<T extends Pick<PlanItem, "status" | "isRepeat">>(items: readonly T[]): PlanProgress<T> {
  const open = (item: T) => item.status !== "done" && (!item.isRepeat || item.status !== "ok");
  const next = items.find(open);
  return { done: items.filter(item => !open(item)).length, total: items.length, ...(next === undefined ? {} : { next }) };
}
