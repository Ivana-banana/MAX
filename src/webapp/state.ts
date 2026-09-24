/**
 * State of the mini app: the same session, the same rule engine and the same wording as the chat.
 *
 * The app sends the action vocabulary the chat buttons already use, so `transition`
 * (src/bot/dialog.ts) stays the single state machine, and every text comes from
 * `src/data/i18n` (`D-020`). Nothing here decides what a step means, what a deadline is or how a
 * warning is worded: a second implementation of the scenario would be a second set of legal
 * answers, which is exactly what this product exists to prevent.
 */

import { isValidDate } from "../core/dates.js";
import type { Lang } from "../core/types.js";
import { countdown, plan, profile, transition, type DialogueContext, type Input, type Session } from "../bot/dialog.js";
import { funnelEvents, funnelUniversity } from "../bot/funnel.js";
import { BASE_LANG, format } from "../data/loadTexts.js";
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
    || /^[a-z]{2}$/.test(action)
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
  return { id: found.id, name: found.name[lang] ?? found.name[BASE_LANG]!, contactUrl: found.contactUrl };
};

/**
 * Every plain key of the interface language. Plural forms (`days#one`) are left out: they need a
 * number at render time, so the server renders those strings itself (see `countdown` below).
 */
function texts(ctx: DialogueContext, lang: Lang): Record<string, string> {
  const table: Record<string, string> = {};
  for (const key of Object.keys(ctx.texts.get(BASE_LANG) ?? {})) {
    if (key.includes("#")) continue;
    table[key] = format(ctx.texts, lang, key);
  }
  return table;
}

const languages = (ctx: DialogueContext) => [...ctx.texts.keys()]
  .map(code => ({ code, name: format(ctx.texts, code, "language.name") }));

function view(session: Session | null, ctx: DialogueContext, mocked: boolean): AppState {
  const lang = session?.lang ?? BASE_LANG;
  const localized = (value: Record<string, string>) => value[lang] ?? value[BASE_LANG]!;
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
        title: localized(item.title),
        action: localized(item.action),
        dueDate: item.dueDate,
        ...(item.recommendedDate === undefined ? {} : { recommendedDate: item.recommendedDate }),
        daysLeft: item.daysLeft,
        countdown: countdown(session, ctx, item),
        status: item.status,
        provisional: item.provisional,
        isRepeat: item.isRepeat,
        documents: item.documents.map(d => ({
          id: d.id,
          title: localized(d.title),
          checked: session.documents[`${item.ruleId}:${item.dueDate}:${d.id}`] === true,
        })),
        legal: item.legal,
      })) : [],
    },
    universities: ctx.universities.map(u => ({ id: u.id, name: localized(u.name), contactUrl: u.contactUrl })),
    texts: texts(ctx, lang),
    languages: languages(ctx),
    today: ctx.today,
    ruleVersion: ctx.version,
    demo: ctx.demo,
    mocked,
  };
}

/** Current state without side effects: a screen refresh must not start a session. */
export async function readState(service: Service, user: number, mocked: boolean): Promise<AppState> {
  return view(await service.store.get(user), service.ctx(), mocked);
}

/**
 * Applies one action and returns the new state together with the dialogue's own wording.
 *
 * The app always renders the state it just received, so its actions carry no staleness stamp:
 * they travel as plain text, exactly like a typed message, and the revision check below does
 * the job the chat's button stamp does. The whole thing runs in the store's per-user transaction,
 * so a webhook update for the same person cannot interleave with it.
 */
export async function applyAction(
  service: Service, user: number, action: string, mocked: boolean, revision?: number,
): Promise<AppResult> {
  return service.store.transaction(user, async tx => {
    const before = await tx.get();
    const ctx = service.ctx();
    if (revision !== undefined && (before?.revision ?? 0) !== revision) {
      throw new RevisionConflict(before?.revision ?? 0);
    }
    const input: Input = { text: action, callback: false };
    const outcome = transition(before, input, ctx);
    const target = funnelUniversity(outcome.session ?? before, ctx);
    for (const event of funnelEvents(before, outcome.session, input, ctx)) await tx.count(ctx.today, target, event);
    // A chat reply queued earlier carries buttons stamped with the previous revision. The dialogue
    // already refuses them, so drop them rather than leave the user a dead button in the chat.
    await tx.supersedeReplies();
    await tx.cancelReminders();
    if (outcome.session) await tx.save(outcome.session, service.clock());
    else await tx.remove();
    await service.scheduleUser(tx, user, outcome.session);
    return { state: view(outcome.session, ctx, mocked), message: outcome.reply.text };
  });
}
