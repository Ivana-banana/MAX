/**
 * State of the mini app: the same session, the same rule engine and the same wording as the chat.
 *
 * The app sends the action vocabulary the chat buttons already use, so `transition`
 * (src/bot/dialog.ts) stays the single state machine. Nothing here decides what a step means or
 * what a deadline is: a second implementation of the scenario would be a second set of legal
 * answers, which is exactly what this product exists to prevent.
 */

import { isValidDate } from "../core/dates.js";
import type { Lang } from "../core/types.js";
import { plan, profile, transition, type DialogueContext, type Input, type Session } from "../bot/dialog.js";
import { funnelEvents, funnelUniversity } from "../bot/funnel.js";
import type { Service } from "../bot/service.js";
import type { AppResult, AppState, AppUniversity } from "./contract.js";

export type {
  AppDocument, AppLaunch, AppPlanItem, AppResult, AppSession, AppState, AppStateResponse, AppStep, AppTicket, AppUniversity,
} from "./contract.js";

/** Another tab (or the chat) moved the session on while this screen was open. */
export class RevisionConflict extends Error {
  constructor(readonly revision: number) {
    super("session revision moved on");
    this.name = "RevisionConflict";
  }
}

/**
 * Actions the mini app is allowed to send. Explicit, because the vocabulary also contains
 * chat-only branches (`/stop`, `calendar`, `help:`) that must not be reachable from a screen.
 */
export function isAppAction(action: string): boolean {
  return action === "/start" || /^\/start [a-z0-9_-]{1,32}$/.test(action)
    || action === "ru" || action === "en"
    || action === "accept" || action === "yes"
    || action === "plan" || action === "reminders" || action === "/today"
    || action === "/delete" || action === "confirm-delete" || action === "cancel-delete"
    || /^[A-Z]{2}$/.test(action) || action === "OTHER"
    || isValidDate(action)
    || /^doc:[a-z0-9-]{1,64}:[a-z0-9-]{1,64}$/.test(action)
    || /^done:[a-z0-9-]{1,64}$/.test(action);
}

const university = (id: string | undefined, ctx: DialogueContext, lang: Lang): AppUniversity => {
  const found = ctx.universities.find(u => u.id === id) ?? ctx.universities[0]!;
  return { id: found.id, name: found.name[lang], contactUrl: found.contactUrl };
};

function view(session: Session | null, ctx: DialogueContext, mocked: boolean): AppState {
  const lang = session?.lang ?? "ru";
  return {
    session: session === null ? null : {
      revision: session.revision,
      step: session.step,
      lang: session.lang,
      university: university(session.university, ctx, lang),
      citizenships: (ctx.universities.find(u => u.id === session.university) ?? ctx.universities[0]!).citizenships,
      ...(session.citizenship === undefined ? {} : { citizenship: session.citizenship }),
      ...(session.entryDate === undefined ? {} : { entryDate: session.entryDate }),
      ...(session.selected === undefined ? {} : { selected: session.selected }),
      reminders: session.reminders,
      plan: profile(session) ? plan(session, ctx).map(item => ({
        ruleId: item.ruleId,
        title: item.title[lang],
        action: item.action[lang],
        dueDate: item.dueDate,
        ...(item.recommendedDate === undefined ? {} : { recommendedDate: item.recommendedDate }),
        daysLeft: item.daysLeft,
        status: item.status,
        provisional: item.provisional,
        isRepeat: item.isRepeat,
        documents: item.documents.map(d => ({
          id: d.id,
          title: d.title[lang],
          checked: session.documents[`${item.ruleId}:${item.dueDate}:${d.id}`] === true,
        })),
        legal: item.legal,
      })) : [],
    },
    universities: ctx.universities.map(u => ({ id: u.id, name: u.name[lang], contactUrl: u.contactUrl })),
    today: ctx.today,
    ruleVersion: ctx.version,
    demo: ctx.demo,
    mocked,
  };
}

/** Current state without side effects: a screen refresh must not start a session. */
export function readState(service: Service, user: number, mocked: boolean): AppState {
  return view(service.store.get(user), service.ctx(), mocked);
}

/**
 * Applies one action and returns the new state together with the dialogue's own wording.
 *
 * The app always renders the state it just received, so its actions carry no staleness stamp:
 * they travel as plain text, exactly like a typed message, and the revision check below does
 * the job the chat's button stamp does.
 */
export function applyAction(
  service: Service, user: number, action: string, mocked: boolean, revision?: number,
): AppResult {
  return service.store.transaction(() => {
    const before = service.store.get(user);
    const ctx = service.ctx();
    if (revision !== undefined && (before?.revision ?? 0) !== revision) {
      throw new RevisionConflict(before?.revision ?? 0);
    }
    const input: Input = { text: action, callback: false };
    const outcome = transition(before, input, ctx);
    const target = funnelUniversity(outcome.session ?? before, ctx);
    for (const event of funnelEvents(before, outcome.session, input, ctx)) service.store.count(ctx.today, target, event);
    // A chat reply queued earlier carries buttons stamped with the previous revision. The dialogue
    // already refuses them, so drop them rather than leave the user a dead button in the chat.
    service.store.supersedeReplies(user);
    service.store.cancelReminders(user);
    if (outcome.session) service.store.save(user, outcome.session, service.clock());
    else service.store.remove(user);
    service.scheduleUser(user, outcome.session);
    return { state: view(outcome.session, ctx, mocked), message: outcome.reply.text };
  });
}
