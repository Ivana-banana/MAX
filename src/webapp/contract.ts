/**
 * Wire contract between the server and the mini app.
 *
 * Types only, and no Node imports: the React bundle type-checks against this very file, so the
 * screens and the API cannot drift apart. The runtime lives in state.ts and router.ts.
 */

import type { Lang, LegalBasis, PlanItemStatus } from "../core/types.js";

/** Steps of the shared dialogue (src/bot/dialog.ts); the app renders a screen per step. */
export type AppStep = "language" | "consent" | "scope" | "citizenship" | "entry" | "plan" | "completion" | "delete";

export interface AppDocument { id: string; title: string; checked: boolean }

export interface AppPlanItem {
  ruleId: string;
  title: string;
  action: string;
  dueDate: string;
  recommendedDate?: string;
  /** Negative once the calculated deadline has passed. */
  daysLeft: number;
  status: PlanItemStatus;
  /** The legal basis is not confirmed by a lawyer yet: the screen must say so. */
  provisional: boolean;
  isRepeat: boolean;
  documents: AppDocument[];
  legal: LegalBasis;
}

export interface AppUniversity { id: string; name: string; contactUrl: string }

export interface AppSession {
  /** Optimistic concurrency: an action carries the revision the screen was rendered from. */
  revision: number;
  step: AppStep;
  lang: Lang;
  university: AppUniversity;
  /** Citizenships this university's scenario supports, for the picker. */
  citizenships: string[];
  citizenship?: string;
  entryDate?: string;
  /** Procedure the "completed" date is being asked for. */
  selected?: string;
  reminders: boolean;
  plan: AppPlanItem[];
}

export interface AppState {
  /** `null` until the user starts, and again after they delete their data. */
  session: AppSession | null;
  universities: AppUniversity[];
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
