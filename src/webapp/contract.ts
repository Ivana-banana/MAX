/**
 * Wire contract between the server and the mini app.
 *
 * Types only, and no Node imports: the React bundle type-checks against this very file, so the
 * screens and the API cannot drift apart. The runtime lives in state.ts and router.ts.
 */

import type { Lang, LegalBasis, PlanItemStatus } from "../core/types.js";

/** Steps of the shared dialogue (src/bot/dialog.ts); the app renders a screen per step. */
export type AppStep = "language" | "consent" | "scope" | "citizenship" | "entry" | "plan" | "completion" | "visit" | "docEnd" | "delete";

export interface AppDocument { id: string; title: string; checked: boolean }

export interface AppPlanItem {
  ruleId: string;
  title: string;
  action: string;
  dueDate: string;
  recommendedDate?: string;
  /** Negative once the calculated deadline has passed. */
  daysLeft: number;
  /** The chat's own wording for the time left, plural forms included (src/data/i18n). */
  countdown: string;
  status: PlanItemStatus;
  /** The legal basis is not confirmed by a lawyer yet: the screen must say so. */
  provisional: boolean;
  isRepeat: boolean;
  documents: AppDocument[];
  /** The chat's line on where the checklist comes from, or that no official list exists (D-027). */
  documentsNote: string;
  legal: LegalBasis;
  /** Planned visit day (D-039); absent when none or the procedure is done. */
  visit?: string;
  /** D-041: where the university sends its students for this procedure (the chat's line) and a map link. */
  place?: { text: string; mapUrl: string };
}

/**
 * A university procedure whose deadline the bot cannot calculate (it counts from the move-in date).
 * Shown apart from the plan, without a countdown; `when` is the source's own wording.
 */
export interface AppUndatedItem {
  id: string;
  title: string;
  action: string;
  when: string;
  documents: { id: string; title: string; checked: boolean }[];
  sourceUrl: string;
  /** The chat's line on where the procedure comes from. */
  sourceNote: string;
  /** The chat's label of the link to the university page. */
  sourceLabel: string;
  /** D-040: the procedure's deadline can be counted from a document end date; the chat's button label to enter it. */
  endLabel?: string;
  /** D-041: map search for the office named in `action`. */
  mapUrl?: string;
  /** The entered end date and the counted last (and first) day to act, with the chat's wording of them. */
  end?: string;
  due?: string;
  from?: string;
  dueText?: string;
}

export interface AppUniversity { id: string; name: string; contactUrl: string }

export interface AppSession {
  /** Optimistic concurrency: an action carries the revision the screen was rendered from. */
  revision: number;
  step: AppStep;
  lang: Lang;
  university: AppUniversity;
  /** Citizenship buttons as the chat offers them: the university's, then those the rules exclude (they lead to help). */
  citizenships: string[];
  citizenship?: string;
  entryDate?: string;
  /** Procedure the "completed" date is being asked for. */
  selected?: string;
  reminders: boolean;
  /** The rules changed after this plan was built: the chat has stopped it (`rulesChanged`), and `plan` is empty. */
  stale: boolean;
  /** The dialogue's own wording of the current step (consent, scope, delete), without the demo banner. */
  prompt: string;
  /** Demo only, on the entry step: label of the chat's "show an example" button; the app sends `example`. */
  example?: string;
  plan: AppPlanItem[];
  /** The university's procedures without a calculated deadline (`AppUndatedItem`); empty for most profiles. */
  undated: AppUndatedItem[];
  /** The plan as a message to forward (`shareText`): procedures and deadlines only; empty without a plan. */
  share: string;
}

export interface AppState {
  /** `null` until the user starts, and again after they delete their data. */
  session: AppSession | null;
  universities: AppUniversity[];
  /**
   * Interface texts for the current language, resolved from `src/data/i18n` (`D-020`). The app has
   * no dictionary of its own: a new language is a new file there, and nothing else.
   */
  texts: Record<string, string>;
  /** Languages the bot has texts for, so the picker is data too. */
  languages: { code: Lang; name: string }[];
  today: string;
  ruleVersion: string;
  /** Synthetic demonstration data; the UI must label it. */
  demo: boolean;
  /** The launch was not cryptographically verified (local development only). */
  mocked: boolean;
}

export interface AppResult {
  state: AppState;
  /** Wording from the dialogue itself, so the app never invents its own legal or error text. */
  message: string;
  /** The ready question to the university that the chat puts behind its "Copy" button, when there is one. */
  copy?: string;
}

/** Hints MAX passed with the launch; the dialogue re-checks both before using them. */
export interface AppLaunch {
  /** `?startapp=<payload>`, e.g. the university a QR poster points at. */
  startParam?: string;
  /** MAX interface language, for the first screen only. */
  languageCode?: string;
}

/** `GET /api/state`. */
export interface AppStateResponse { state: AppState; launch: AppLaunch }

/** `POST /api/calendar-ticket`: a signed, short-lived URL a download can actually open. */
export interface AppTicket { url: string; fileName: string; expiresIn: number }
