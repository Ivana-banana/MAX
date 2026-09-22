/**
 * Contracts for the deadline engine.
 *
 * Everything that changes when the product moves to another region, university or
 * category of foreigner lives in data (see docs/product/scaling.md). This file holds
 * only the shapes; no rule text, no country, no procedure name.
 */

/** Calendar date without time, ISO `YYYY-MM-DD`. Deadlines are whole days. */
export type PlainDate = string;

export type Lang = "ru" | "en";

export type Localized = Record<Lang, string>;

/** Personal event a deadline is counted from. */
export type BaseEventId = "entry";

/**
 * Whether the day of the base event itself counts as the first day of the term.
 * Legally significant and NOT decided in code: each rule states it explicitly and a
 * lawyer confirms it (docs/product/mvp.md, "Правило для нормативных данных").
 */
export type DayCounting = "eventDay" | "dayAfterEvent";

/**
 * Limited typed conditions. Deliberately not a mini-language: JSON must not contain
 * executable code (docs/product/scaling.md). Adding a new field is a code change and
 * a deliberate decision, not a config tweak.
 */
export type Condition =
  | { field: "citizenship"; op: "in" | "notIn"; values: string[] }
  | { field: "purpose"; op: "eq"; value: StayPurpose }
  | { field: "entryDate"; op: "onOrAfter" | "before"; value: PlainDate };

export type StayPurpose = "study" | "work" | "other";

/**
 * Review state of a norm. A rule that a lawyer has not confirmed still produces a
 * date, but the product must mark it as provisional: showing an unverified term as
 * fact is exactly the failure this product exists to prevent.
 */
export type LegalStatus = "draft" | "approved";

export interface LegalBasis {
  /** Human-readable act, e.g. "Федеральный закон от 25.07.2002 № 115-ФЗ". */
  act: string;
  /** Specific article or clause the term comes from. */
  article: string;
  url: string;
  /** Wording of the act as of this date. */
  edition: string;
  /** When a human last compared this row against the source. */
  checkedAt: PlainDate;
  status: LegalStatus;
  /** Who confirmed it. Required once status is "approved". */
  reviewedBy?: string;
}

export interface RequiredDocument {
  id: string;
  title: Localized;
}

export interface DeadlineRule {
  id: string;
  title: Localized;
  /** What the user actually has to do, shown on the procedure card. */
  action: Localized;
  /** Term: base event + offset in calendar days. */
  term: {
    event: BaseEventId;
    days: number;
    counting: DayCounting;
  };
  /** Optional recurrence, counted from the completion of the previous round. */
  repeat?: {
    months: number;
    /** Additional window after the anniversary, distinct from the recommended date. */
    graceDays?: number;
  };
  /** Rule applies only if every condition holds. Empty means "always". */
  appliesIf: Condition[];
  documents: RequiredDocument[];
  legal: LegalBasis;
}

/** What the user told us about themselves. Never inferred, never guessed. */
export interface UserProfile {
  citizenship: string;
  purpose: StayPurpose;
  entryDate: PlainDate;
}

/** Procedures the user marked as done, with the date they were completed. */
export type Completions = Record<string, PlainDate | undefined>;

export type PlanItemStatus = "done" | "overdue" | "dueSoon" | "ok";

export interface PlanItem {
  ruleId: string;
  title: Localized;
  action: Localized;
  dueDate: PlainDate;
  /** Earlier planning target; never labelled as a legal deadline. */
  recommendedDate?: PlainDate;
  /** Negative when the deadline has passed. */
  daysLeft: number;
  status: PlanItemStatus;
  documents: RequiredDocument[];
  legal: LegalBasis;
  /** True when the term is a repeat round rather than the first one. */
  isRepeat: boolean;
  /**
   * True when the legal basis has not been confirmed by a human yet. The UI must
   * show these as provisional (docs/architecture.md, "Обновление официальных данных").
   */
  provisional: boolean;
}
