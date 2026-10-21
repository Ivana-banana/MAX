/**
 * Contracts for the deadline engine.
 *
 * Everything that changes when the product moves to another region, university or
 * category of foreigner lives in data (see docs/product/scaling.md). This file holds
 * only the shapes; no rule text, no country, no procedure name.
 */

/** Calendar date without time, ISO `YYYY-MM-DD`. Deadlines are whole days. */
export type PlainDate = string;

/** ISO 639-1 code; the available languages are the files in src/data/i18n. */
export type Lang = string;

/** Text per language; every interface language must be present (checked at startup by checkTranslated). */
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
  /** Specific article or clause the term comes from; the act name stays in the original, explanatory words are translated. */
  article: Localized;
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

/** What the law says happens if the procedure is not done; the clause is in the same act as `legal`. */
export interface Consequence {
  text: Localized;
  article: Localized;
  checkedAt: PlainDate;
}

/** Where the checklist comes from; absent when no official list is published. */
export interface DocumentsSource {
  url: string;
  checkedAt: PlainDate;
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
  documentsSource?: DocumentsSource;
  consequence?: Consequence;
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
  documentsSource?: DocumentsSource;
  consequence?: Consequence;
  legal: LegalBasis;
  /** True when the term is a repeat round rather than the first one. */
  isRepeat: boolean;
  /** For a repeat round: when the student marked the previous round and the rule's period, so the UI can say both. */
  repeat?: { completedAt: PlainDate; months: number };
  /**
   * True when the legal basis has not been confirmed by a human yet. The UI must
   * show these as provisional (docs/architecture.md, "Обновление официальных данных").
   */
  provisional: boolean;
}

/**
 * A change of circumstances the student reports (#41, D-061): moving, a return, a hotel or hospital,
 * a new passport. The federal term is counted in working days from the day of the event.
 */
export interface ChangeSituation {
  id: string;
  title: Localized;
  /** Which day the student enters: "the day you moved in". Absent when nothing is counted. */
  event?: Localized;
  /** The norm in words: shown as is when the date falls outside the calendar or the norm has no number. */
  norm: Localized;
  /** The n-th working day after the event day (the event day is not counted); absent when the norm gives the student no number. */
  workdays?: number;
  /** Who files the notification of arrival: the university as the receiving side, or the place of stay itself (hotel, hospital). */
  receiver: "university" | "place";
  legal: LegalBasis;
}

export interface ChangeSet {
  situations: ChangeSituation[];
  /** Who files the notification and what the student hands over (109-ФЗ ст. 22 ч. 2); the card cites it. */
  filing: { act: string; article: Localized; url: string; checkedAt: PlainDate };
}
