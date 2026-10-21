/**
 * State of the mini app: the same session, the same rule engine and the same wording as the chat.
 *
 * The app sends the action vocabulary the chat buttons already use, so `transition`
 * (src/bot/dialog.ts) stays the single state machine, and every text comes from
 * `src/data/i18n` (`D-020`). Nothing here decides what a step means, what a deadline is or how a
 * warning is worded: a second implementation of the scenario would be a second set of legal
 * answers, which is exactly what this product exists to prevent.
 */

import { coverage } from "../core/deadlines.js";
import { isValidDate } from "../core/dates.js";
import type { Lang, PlanItem } from "../core/types.js";
import {
  beforeEntry, beforeEntryNote, consequenceText, countdown, documentsNote, mapUrl, pageLabel, placeText, plan, repeatParts, targetText, procedureDue, procedureDueText, procedureSource, profile, prompt, shareText, transition, undated, universityLost, type DialogueContext, type Input, type Session,
} from "../bot/dialog.js";
import { funnelEvents, funnelUniversity } from "../bot/funnel.js";
import { BASE_LANG, format } from "../data/loadTexts.js";
import { countEvents, type Service } from "../bot/service.js";
import type { AppResult, AppState, AppUniversity } from "./contract.js";

export type {
  AppBeforeEntryItem, AppDocument, AppLaunch, AppPlanItem, AppResult, AppSession, AppState, AppStateResponse, AppStep, AppTicket, AppUniversity,
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
 * chat-only branches (`/stop`, `calendar`, the generic `help`) that must not be reachable from a
 * screen. `help:<procedure>` is shared: it changes nothing and returns the ready question to the
 * university, which the card shows next to a copy button (`AppResult.copy`).
 */
export function isAppAction(action: string): boolean {
  return action === "/start" || /^\/start [a-z0-9_-]{1,32}$/.test(action)
    || /^[a-z]{2}$/.test(action)
    || action === "accept" || action === "yes"
    || action === "universities" || action === "uni-missing" || /^uni:[a-z0-9_-]{1,32}$/.test(action)
    // demo-only example entry date: outside the demo the dialogue treats it as an invalid date
    || action === "example"
    // "Change citizenship" on the entry step; elsewhere it changes nothing: before the plan it repeats the question
    || action === "back"
    || action === "plan" || action === "reminders" || action === "/today"
    || action === "/delete" || action === "confirm-delete" || action === "cancel-delete"
    || /^[A-Z]{2}$/.test(action) || action === "OTHER"
    || isValidDate(action)
    || /^doc:[a-z0-9-]{1,64}:[a-z0-9-]{1,64}$/.test(action)
    || /^done:[a-z0-9-]{1,64}$/.test(action)
    || /^visit:[a-z0-9-]{1,64}$/.test(action)
    || /^end:[a-z0-9-]{1,64}$/.test(action)
    || /^help:[a-z0-9-]{1,64}$/.test(action);
}

// An id the catalogue lacks gets the default profile only as a placeholder: `universityGone` tells the app to ask again.
const university = (id: string | undefined, ctx: DialogueContext, lang: Lang): AppUniversity => {
  const found = ctx.universities.find(u => u.id === id) ?? ctx.universities[0]!;
  return { id: found.id, name: found.name[lang] ?? found.name[BASE_LANG]!, contactUrl: found.contactUrl };
};

/**
 * Every plain key of the interface language. Plural forms (`days#one`) are left out: they need a
 * number at render time, so the server renders those strings itself (see `countdown` below).
 */
function texts(ctx: DialogueContext, lang: Lang): Record<string, string> {
  // App-only texts are filled here; the chat's keep their placeholders, because the app recognises a
  // server message by the fixed part before the first one (web/src/texts.ts).
  const from = coverage(ctx.rules).from.split("-").reverse().join(".");
  const table: Record<string, string> = {};
  for (const key of Object.keys(ctx.texts.get(BASE_LANG) ?? {})) {
    if (key.includes("#")) continue;
    table[key] = format(ctx.texts, lang, key, key.startsWith("app.") ? { from } : {});
  }
  return table;
}

/** The app shows the demo banner once, at the top; the chat repeats it in every message. */
function withoutBanner(text: string, ctx: DialogueContext): string {
  if (!ctx.demo) return text;
  const banner = [...ctx.texts.keys()].map(l => format(ctx.texts, l, "banner.demo")).find(b => text.startsWith(b));
  return banner === undefined ? text : text.slice(banner.length);
}

const languages = (ctx: DialogueContext) => [...ctx.texts.keys()]
  .map(code => ({ code, name: format(ctx.texts, code, "language.name") }));

/** The chat's own "show an example" button, when the dialogue offers it (demo, entry step). */
function exampleLabel(session: Session, ctx: DialogueContext): { example?: string } {
  const button = prompt(session, ctx).buttons.flat().find(b => "action" in b && b.action.endsWith("|example"));
  return button === undefined ? {} : { example: button.text };
}

/** D-041: the university's place for a federal procedure, worded as in the chat card. */
function placeView(session: Session, ctx: DialogueContext, ruleId: string): { place?: { text: string; mapUrl: string } } {
  const place = (ctx.universities.find(u => u.id === session.university) ?? ctx.universities[0]!).rulePlaces[ruleId];
  return place ? { place: { text: placeText(session, ctx, ruleId).trim(), mapUrl: mapUrl(place.map) } } : {};
}

/** The repeat round's label and "marked done on" line, the chat's own wording. */
function repeatView(session: Session, ctx: DialogueContext, item: PlanItem) {
  const repeat = repeatParts(session, ctx, item);
  return repeat ? { repeat: { label: repeat.label, doneOn: repeat.doneOn } } : {};
}

/** D-040 fields of an undated procedure: the button to enter the end date, and the counted dates once entered. */
function countdownView(session: Session, ctx: DialogueContext, note: ReturnType<typeof undated>[number]) {
  if (!note.countdown) return {};
  const due = procedureDue(session, ctx, note);
  const label = format(ctx.texts, session.lang, due ? "btn.endChange" : `btn.end.${note.countdown.from}`);
  return due ? { endLabel: label, end: due.end, due: due.due, ...(due.from ? { from: due.from } : {}), dueText: procedureDueText(session, ctx, note).trim() }
    : { endLabel: label };
}

/** `hint`: the MAX interface language, for the screen shown before a session exists. */
function view(session: Session | null, ctx: DialogueContext, mocked: boolean, hint?: string): AppState {
  const hinted = hint?.slice(0, 2).toLowerCase();
  const lang = session?.lang ?? (hinted !== undefined && ctx.texts.has(hinted) ? hinted : BASE_LANG);
  const localized = (value: Record<string, string>) => value[lang] ?? value[BASE_LANG]!;
  const stale = session !== null && session.ruleVersion !== ctx.version;
  return {
    session: session === null ? null : {
      revision: session.revision,
      step: session.step,
      lang: session.lang,
      university: university(session.university, ctx, lang),
      citizenships: [...(ctx.universities.find(u => u.id === session.university) ?? ctx.universities[0]!).citizenships,
        ...coverage(ctx.rules).excluded],
      ...(session.citizenship === undefined ? {} : { citizenship: session.citizenship }),
      ...(session.entryDate === undefined ? {} : { entryDate: session.entryDate }),
      ...(session.selected === undefined ? {} : { selected: session.selected }),
      reminders: session.reminders,
      stale,
      universityGone: universityLost(session, ctx),
      prompt: withoutBanner(prompt(session, ctx).text, ctx),
      ...exampleLabel(session, ctx),
      plan: profile(session) && !stale ? plan(session, ctx).map(item => ({
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
        ...repeatView(session, ctx, item),
        documents: item.documents.map(d => ({
          id: d.id,
          title: localized(d.title),
          checked: session.documents[`${item.ruleId}:${item.dueDate}:${d.id}`] === true,
        })),
        documentsNote: documentsNote(session, ctx, item),
        legal: { ...item.legal, article: localized(item.legal.article) },
        ...(item.status === "done" || !consequenceText(session, ctx, item) ? {} : { consequence: consequenceText(session, ctx, item).trim() }),
        ...(item.status === "done" || session.visits?.[item.ruleId] === undefined ? {} : { visit: session.visits[item.ruleId] }),
        ...placeView(session, ctx, item.ruleId),
        ...(targetText(session, ctx, item) ? { target: targetText(session, ctx, item).trim() } : {}),
      })) : [],
      undated: profile(session) && !stale ? undated(session, ctx).map(note => ({
        id: note.id,
        title: localized(note.title),
        action: localized(note.action),
        when: localized(note.when),
        documents: note.documents.map(d => ({
          id: d.id, title: localized(d.title), checked: session.documents[`${note.id}:${d.id}`] === true,
        })),
        sourceUrl: note.source.url,
        sourceNote: procedureSource(session, ctx, note),
        sourceLabel: pageLabel(session, ctx),
        ...countdownView(session, ctx, note),
        ...(note.place ? { mapUrl: mapUrl(note.place.map) } : {}),
      })) : [],
      share: profile(session) && !stale ? shareText(session, ctx) : "",
      beforeEntry: session.step === "entry" && !stale ? beforeEntry(session, ctx).map(card => ({
        id: card.id, title: localized(card.title), text: localized(card.text), note: beforeEntryNote(session, ctx, card).trim(), url: card.source.url,
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
export async function readState(service: Service, user: number, mocked: boolean, locale?: string): Promise<AppState> {
  return view(await service.store.get(user), service.ctx(), mocked, locale);
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
  service: Service, user: number, action: string, mocked: boolean, revision?: number, locale?: string,
): Promise<AppResult> {
  return service.store.transaction(user, async tx => {
    const before = await tx.get();
    const ctx = service.ctx();
    if (revision !== undefined && (before?.revision ?? 0) !== revision) {
      throw new RevisionConflict(before?.revision ?? 0);
    }
    // The MAX interface language picks the first screen's language on /start, as bot_started does in the chat.
    const input: Input = { text: action, callback: false, ...(locale === undefined ? {} : { locale }) };
    const outcome = transition(before, input, ctx);
    const target = funnelUniversity(outcome.session ?? before, ctx);
    await countEvents(tx, user, ctx.today, target, funnelEvents(before, outcome.session, input, ctx), service.clock());
    // A chat reply queued earlier carries buttons stamped with the previous revision. The dialogue
    // already refuses them, so drop them rather than leave the user a dead button in the chat.
    await tx.supersedeReplies();
    await tx.cancelReminders();
    if (outcome.session) await tx.save(outcome.session, service.clock());
    else await tx.remove();
    await service.scheduleUser(tx, user, outcome.session);
    const copy = outcome.reply.buttons.flat().find(b => "copy" in b);
    // A deleted session has no language of its own: the one it had (else the MAX interface's) keeps the app's texts matching the reply.
    return { state: view(outcome.session, ctx, mocked, before?.lang ?? locale), message: withoutBanner(outcome.reply.text, ctx),
      ...(copy !== undefined && "copy" in copy ? { copy: copy.copy } : {}) };
  });
}
