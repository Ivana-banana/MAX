import { randomUUID } from "node:crypto";
import { buildPlan, coverage, matchesCondition, REMINDER_OFFSETS } from "../core/deadlines.js";
import { planProgress } from "../core/progress.js";
import { changeDeadline, type ChangeDeadline } from "../core/changes.js";
import { addDays, compareDates, daysBetween, isValidDate, type WorkCalendar } from "../core/dates.js";
import type { ChangeSet, ChangeSituation, Completions, DeadlineRule, Lang, PlanItem, UserProfile } from "../core/types.js";
import type { BeforeEntryCard, ProcedureCountdown, University, UniversityProcedure } from "../data/loadUniversities.js";
import { format, type Texts } from "../data/loadTexts.js";
import { CALENDAR_FILE, planToIcs } from "./calendar.js";
import type { PlanPdf } from "./pdf.js";
import { longDate, repeatText } from "./repeat.js";
import { plain } from "../core/markup.js";
import { deepLink } from "../poster.js";

// callback buttons come back to the bot; link and clipboard buttons are handled by MAX itself
export type Button = { text: string; action: string } | { text: string; url: string } | { text: string; copy: string }
  | { text: string; app: string; payload: string };
/**
 * `encoding`: binary files travel through the outbox as base64. `pdf`: the plan PDF, built when the
 * reply is sent (service.ts flush). `failed`: sent instead when the file cannot be built or delivered (#112).
 */
export interface Reply { text: string; buttons: Button[][]; ruleVersion: string; file?: { name: string; content: string; encoding?: "base64" };
  pdf?: PlanPdf; failed?: Reply }
export interface Session {
  nonce: string;
  revision: number;
  lang: Lang;
  step: "language" | "consent" | "scope" | "citizenship" | "entry" | "plan" | "completion" | "visit" | "docEnd" | "changeDate" | "delete";
  /** Step the delete confirmation was opened from, so "Cancel" returns there. */
  back?: Session["step"];
  university?: string;
  citizenship?: string;
  entryDate?: string;
  selected?: string;
  completions: Completions;
  documents: Record<string, boolean>;
  /** Day the student plans to go for a procedure (rule id → date); the evening before, the bot lists missing documents. */
  visits?: Record<string, string>;
  /** End dates of the student's documents (D-040), from which university deadlines in days are counted. */
  ends?: Partial<Record<ProcedureCountdown["from"], string>>;
  /** Changes of circumstances the student reported (situation id → day of the event, #41): the deadline is counted from it. */
  changes?: Record<string, string>;
  reminders: boolean;
  ruleVersion: string;
}
export interface DialogueContext {
  rules: DeadlineRule[]; universities: University[]; texts: Texts; version: string; today: string; demo: boolean;
  /** Bot whose mini app the plan opens (`open_app`); unset until the app URL is registered with MAX. */
  webApp?: string;
  /** Public bot link; the shared plan ends with it and the student's university code (#129). Without it the text has no link. */
  botLink?: string;
  /** "Circumstances changed" (#41, D-061); without it the bot does not offer /change. */
  changes?: Changes;
}
/** The changes of circumstances with the calendar their working days are counted over (D-060). */
export type Changes = ChangeSet & { calendar: WorkCalendar };
// locale comes only with bot_started (MAX client language); a ?start= payload arrives as "/start <payload>"
export interface Input { text: string; callback: boolean; locale?: string }
/**
 * `expired`: a stale button was refused and nothing changed.
 * `notice`: the notification on the pressed button while a file reply is on its way.
 */
export interface Transition { session: Session | null; reply: Reply; expired?: true; notice?: string }
// Every user-facing text comes from src/data/i18n/<lang>.json.
const t = (s: Session, ctx: DialogueContext, key: string, vars?: Record<string, string | number>) => format(ctx.texts, s.lang, key, vars);
// Only sessions created before university profiles existed (no id) fall back to the default one.
// An id the catalogue does not have is handled before this point: see `universityLost`.
const uni = (s: Session, ctx: DialogueContext) => ctx.universities.find(u => u.id === s.university) ?? ctx.universities[0]!;
const universityMissing = (s: Session, ctx: DialogueContext) =>
  s.university !== undefined && !ctx.universities.some(u => u.id === s.university);
/**
 * The session names a university the catalogue no longer has (profile removed or renamed): its
 * addresses and contacts are unknown, so the student must choose again. Not before consent, and not
 * on the delete confirmation: nothing is built on the university there.
 */
export const universityLost = (s: Session, ctx: DialogueContext) =>
  universityMissing(s, ctx) && s.step !== "language" && s.step !== "consent" && s.step !== "delete";
/** Dates in replies are written out in the user's language (Intl), not as ISO strings. */
const date = (s: Session, iso: string) => longDate(s.lang, iso);
const country = (s: Session, ctx: DialogueContext, code: string) =>
  code === "OTHER" ? t(s, ctx, "btn.otherCountry") : new Intl.DisplayNames([s.lang], { type: "region" }).of(code) ?? code;
/** Typed dates: ISO or the DD.MM.YYYY people write by hand. */
function typedDate(text: string): string {
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  return dotted ? `${dotted[3]}-${dotted[2]!.padStart(2, "0")}-${dotted[1]!.padStart(2, "0")}` : text;
}
/**
 * Demo only: an entry date whose earliest reminder falls on today, so a reviewer sees the
 * plan and a reminder at once. Derived from the rules, not hard-coded: the shortest term
 * minus the first reminder offset (30 days counted from the entry day − 7 = 22 days ago).
 */
export function exampleEntry(ctx: Pick<DialogueContext, "rules" | "today">): string {
  const shortest = Math.min(...ctx.rules.map(r => r.term.days - (r.term.counting === "eventDay" ? 1 : 0)));
  const entry = addDays(ctx.today, -(shortest - Math.max(...REMINDER_OFFSETS)));
  const from = coverage(ctx.rules).from;
  return entry < from ? from : entry;
}
export function countdown(s: Session, ctx: DialogueContext, item: PlanItem): string {
  if (item.status === "done") return t(s, ctx, "countdown.done");
  if (item.daysLeft < 0) return t(s, ctx, "countdown.passed", { days: t(s, ctx, "days", { n: -item.daysLeft }) });
  if (item.daysLeft === 0) return t(s, ctx, "countdown.today");
  return t(s, ctx, item.status === "dueSoon" ? "countdown.soon" : "countdown.upcoming", { left: t(s, ctx, "left", { n: item.daysLeft }) });
}
export function initialSession(version: string): Session {
  return { nonce: randomUUID().replaceAll("-", "").slice(0, 16), revision: 0, lang: "ru",
    step: "language", completions: {}, documents: {}, reminders: false, ruleVersion: version };
}
export function profile(s: Session): UserProfile | undefined {
  return s.citizenship && s.entryDate ? { citizenship: s.citizenship, entryDate: s.entryDate, purpose: "study" } : undefined;
}
export function plan(s: Session, ctx: DialogueContext): PlanItem[] {
  const p = profile(s);
  if (universityMissing(s, ctx)) return [];
  const targets = Object.fromEntries(Object.entries(uni(s, ctx).ruleTargets).map(([id, target]) => [id, target.days]));
  return p ? buildPlan(ctx.rules, p, s.completions, ctx.today, targets) : [];
}
/**
 * The university's own procedures whose deadline the bot cannot calculate (it counts from the
 * move-in date, which the bot does not know). No reminders, no calendar event: the plan lists
 * them apart, with the deadline in the source's words.
 */
export function undated(s: Session, ctx: DialogueContext): UniversityProcedure[] {
  const p = profile(s);
  return p && !universityMissing(s, ctx) ? uni(s, ctx).procedures.filter(pr => pr.appliesIf.every(c => matchesCondition(c, p))) : [];
}
/**
 * What the student's university asks to prepare at home (#25): for a student who has chosen a
 * citizenship but has not entered yet. Only citizenship conditions, so no entry date is needed.
 */
export function beforeEntry(s: Session, ctx: DialogueContext): BeforeEntryCard[] {
  if (!s.citizenship || universityMissing(s, ctx)) return [];
  const p: UserProfile = { citizenship: s.citizenship, entryDate: ctx.today, purpose: "study" };
  return uni(s, ctx).beforeEntry.filter(c => c.appliesIf.every(cond => matchesCondition(cond, p)));
}
/** Under each card: the university's page it is a fact of, and what the bot assumes beyond it. */
export function beforeEntryNote(s: Session, ctx: DialogueContext, card: BeforeEntryCard): string {
  return t(s, ctx, "beforeEntry.fact", { uni: uni(s, ctx).name[s.lang]!, url: card.source.url, date: date(s, card.source.checkedAt) }) +
    (card.assumption ? t(s, ctx, "beforeEntry.assumption", { text: card.assumption[s.lang]! }) : "");
}
function beforeEntryReply(s: Session, ctx: DialogueContext): Reply {
  const cards = beforeEntry(s, ctx).map(c => `**${c.title[s.lang]}**\n${c.text[s.lang]}\n${beforeEntryNote(s, ctx, c)}`);
  // The button press made the entry prompt's buttons stale, so the demo example comes again here.
  return reply(s, ctx, t(s, ctx, "beforeEntry.title", { uni: uni(s, ctx).name[s.lang]! }) + cards.join("\n\n") +
    t(s, ctx, "beforeEntry.scope") + t(s, ctx, "beforeEntry.next"), [[link(pageLabel(s, ctx), uni(s, ctx).contactUrl)], ...exampleRow(s, ctx), ...changeRow(s, ctx)]);
}
/** The entry step's buttons: on its question and on a wrong date, so they never go stale there (#67). */
function entryRows(s: Session, ctx: DialogueContext): Button[][] {
  return [...(beforeEntry(s, ctx).length ? [[button(t(s, ctx, "btn.beforeEntry"), "before-entry")]] : []), ...exampleRow(s, ctx), ...changeRow(s, ctx)];
}
/** A mis-tapped citizenship is corrected here, before the plan exists, like the university (#69). */
function changeRow(s: Session, ctx: DialogueContext): Button[][] {
  return [[button(t(s, ctx, "btn.changeCitizenship"), "back")]];
}
function exampleRow(s: Session, ctx: DialogueContext): Button[][] {
  return ctx.demo ? [[button(t(s, ctx, "btn.example", { date: date(s, exampleEntry(ctx)) }), "example")]] : [];
}
function reply(s: Session, ctx: DialogueContext, text: string, rows: Button[][] = []): Reply {
  const banner = ctx.demo ? t(s, ctx, "banner.demo") : "";
  return { text: banner + text, ruleVersion: ctx.version, buttons: rows.map(row => row.map(b => "action" in b ? {
    text: b.text, action: `${s.nonce}.${s.revision}|${b.action}`,
  } : b)) };
}
/** #59: an update over the per-minute limit was dropped. In the session's language, or the MAX one before a session. */
export function limitedReply(s: Session | null, input: Input, ctx: DialogueContext): Reply {
  const hinted = input.locale?.slice(0, 2).toLowerCase();
  const lang = s?.lang ?? (hinted !== undefined && ctx.texts.has(hinted) ? hinted : initialSession(ctx.version).lang);
  return { text: (ctx.demo ? format(ctx.texts, lang, "banner.demo") : "") + format(ctx.texts, lang, "limited"), buttons: [], ruleVersion: ctx.version };
}
const button = (text: string, action: string): Button => ({ text, action });
/** Suffix of the reminder's "Details" button: tells a return from a reminder apart from a card opened in the plan (funnel.ts). */
export const FROM_REMINDER = ":reminder";
const rows = <T>(list: T[], size: number): T[][] => list.flatMap((_, i) => i % size ? [] : [list.slice(i, i + size)]);
const link = (text: string, url: string): Button => ({ text, url });
// Language buttons carry the language code as their action; each is named in its own language.
const languages = (ctx: DialogueContext, except?: Lang) => rows([...ctx.texts.keys()].filter(l => l !== except)
  .map(l => button(format(ctx.texts, l, "language.name"), l)), 3);
// Read-only screens: a stale button to them (e.g. in a reminder sent days ago) is still safe to follow.
const navigation = (action: string) => action === "plan" || action === "help" || action === "calendar" || action === "pdf" ||
  action.startsWith("card:") || action.startsWith("help:") || action.startsWith("changed:");
/** A repeat round's texts in the session's language (repeat.ts); empty for a first round. */
export const repeatParts = (s: Session, ctx: DialogueContext, item: PlanItem) => repeatText(ctx.texts, s.lang, item);
/** The title with "repeat (yearly)" after it for a repeat round, and the "marked done on" line to put under it; the same in the plan, the shared copy and the reminder. */
function repeatTitle(s: Session, ctx: DialogueContext, i: PlanItem): { title: string; doneOn: string } {
  const repeat = repeatParts(s, ctx, i);
  return { title: repeat?.title ?? i.title[s.lang]!, doneOn: repeat ? `\n  ${repeat.doneOn}` : "" };
}
function planLine(s: Session, ctx: DialogueContext, i: PlanItem): string {
  const { title, doneOn } = repeatTitle(s, ctx, i);
  return `• **${title}**\n  **${date(s, i.dueDate)}** — ${countdown(s, ctx, i)}${doneOn}`;
}
/** #93: "Passed 2 of 5" and the one nearest step, for the top of the plan; the app shows both too. Empty without a plan. */
export function progressParts(s: Session, ctx: DialogueContext, items: PlanItem[]): { done: number; total: number; line: string; text: string; next?: PlanItem } {
  const { done, total, next } = planProgress(items);
  if (total === 0) return { done, total, line: "", text: "" };
  const line = t(s, ctx, "progress.line", { done, total });
  const text = next
    ? t(s, ctx, "progress.home.next", { line, title: next.title[s.lang]!, due: date(s, next.dueDate), countdown: countdown(s, ctx, next) })
    : t(s, ctx, "progress.home.all", { line });
  return { done, total, line, text, ...(next ? { next } : {}) };
}
function home(s: Session, ctx: DialogueContext, prefix = ""): Reply {
  const items = plan(s, ctx);
  const progress = progressParts(s, ctx, items);
  const lines = items.map(i => planLine(s, ctx, i));
  const notes = undated(s, ctx);
  const noteLines = notes.length ? t(s, ctx, "home.undated") + notes.map(n => {
    const counted = procedureDue(s, ctx, n);
    return counted ? t(s, ctx, "home.undatedDue", { title: n.title[s.lang]!, due: date(s, counted.due) }) : `• ${n.title[s.lang]}`;
  }).join("\n") : "";
  const changes = reportedChanges(s, ctx);
  const changeLines = changes.length ? t(s, ctx, "home.changes") + changes.map(({ situation: c, deadline: d }) => changeLine(s, ctx, c, d)).join("\n") : "";
  // Reminders are the core mechanic, so while they are off the switch comes first, right under the text.
  const toggle = [button(t(s, ctx, s.reminders ? "btn.remindersOff" : "btn.remindersOn"), "reminders")];
  return reply(s, ctx, prefix + t(s, ctx, "home.title") + progress.text + lines.join("\n") + noteLines + changeLines + t(s, ctx, "home.scope") +
    t(s, ctx, s.reminders ? "home.reminders.on" : "home.reminders.off"),
    [...(s.reminders ? [] : [toggle]),
      ...(progress.next ? [[button(t(s, ctx, "btn.next", { title: progress.next.title[s.lang]! }), `card:${progress.next.ruleId}`)]] : []),
      ...items.map(i => [button(i.title[s.lang]!, `card:${i.ruleId}`)]),
      ...notes.map(n => [button(n.title[s.lang]!, `card:${n.id}`)]),
      ...changes.map(({ situation: c }) => [button(c.title[s.lang]!, `changed:${c.id}`)]),
      ...(ctx.changes ? [[button(t(s, ctx, "btn.change"), "change")]] : []),
      ...(s.reminders ? [toggle] : []),
      ...(items.some(i => i.status !== "done") || countedChanges(s, ctx).length ? [[button(t(s, ctx, "btn.calendar"), "calendar")]] : []),
      ...(items.length ? [[button(t(s, ctx, "btn.pdf"), "pdf")]] : []),
      // The same plan as a screen; the payload picks the university the way ?start= does.
      ...(ctx.webApp ? [[{ text: t(s, ctx, "btn.app"), app: ctx.webApp, payload: uni(s, ctx).id }]] : []),
      [button(t(s, ctx, "btn.help"), "help")],
      [button(t(s, ctx, "btn.delete"), "delete")]]);
}
/**
 * The plan as a message the student forwards themselves (the mini app's shareMaxContent): procedures
 * and deadlines only — no citizenship, entry date or MAX ID — with the demo banner and the caveat
 * that the rules are not reviewed, so a forwarded copy does not look more certain than the plan.
 */
export function shareText(s: Session, ctx: DialogueContext): string {
  const items = plan(s, ctx);
  if (!items.length) return "";
  const name = uni(s, ctx).name[s.lang]!;
  const lines = items.map(i => {
    const { title, doneOn } = repeatTitle(s, ctx, i);
    return t(s, ctx, i.status === "done" ? "share.done" : "share.item", { title, due: date(s, i.dueDate) }) + doneOn;
  });
  // A forwarded copy is plain text: the student's chat would show the emphasis markers as is.
  return plain((ctx.demo ? t(s, ctx, "banner.demo") : "") + t(s, ctx, "share.plan", { uni: name, lines: lines.join("\n") }) +
    (items.some(i => i.provisional && i.status !== "done") ? t(s, ctx, "share.provisional", { uni: name }) : "") +
    (ctx.botLink ? t(s, ctx, "share.link", { url: deepLink(ctx.botLink, uni(s, ctx)) }) : ""));
}
/** "How to get there": a Yandex Maps search for the address — a public link, no API and no location data (D-041). */
export const mapUrl = (address: string) => `https://yandex.ru/maps/?text=${encodeURIComponent(address)}`;
/** Where the student's university sends them for a federal procedure, with the source; empty when it does not say. */
export function placeText(s: Session, ctx: DialogueContext, ruleId: string): string {
  const place = uni(s, ctx).rulePlaces[ruleId];
  return place ? t(s, ctx, "card.place", { where: place.where[s.lang]!, uni: uni(s, ctx).name[s.lang]!, date: date(s, place.source.checkedAt) }) : "";
}
/** D-043: the university's earlier date for a federal procedure, with its source; the legal deadline stays as is. */
export function targetText(s: Session, ctx: DialogueContext, item: PlanItem): string {
  const target = uni(s, ctx).ruleTargets[item.ruleId];
  if (!target || item.isRepeat || !item.recommendedDate) return "";
  return t(s, ctx, "card.uniTarget", { uni: uni(s, ctx).name[s.lang]!, date: date(s, item.recommendedDate), checked: date(s, target.source.checkedAt) });
}
/** Where the checklist comes from, or that no official list is published (D-027); the app shows it too. */
export function documentsNote(s: Session, ctx: DialogueContext, item: PlanItem): string {
  return item.documentsSource
    ? t(s, ctx, "card.docsSource", { url: item.documentsSource.url, date: date(s, item.documentsSource.checkedAt) })
    : t(s, ctx, "card.docsNoSource", { uni: uni(s, ctx).name[s.lang]! });
}
/** What the law says happens if the procedure is skipped, with the clause (#75); the app shows it too. */
export function consequenceText(s: Session, ctx: DialogueContext, item: PlanItem): string {
  const c = item.consequence;
  return c ? t(s, ctx, "card.consequence", { text: c.text[s.lang]!, act: item.legal.act, article: c.article[s.lang]!, date: date(s, c.checkedAt) }) : "";
}
/** A visit can be planned from today up to a year ahead. */
const VISIT_HORIZON_DAYS = 365;
function card(s: Session, ctx: DialogueContext, id: string, prefix = ""): Reply {
  const item = plan(s, ctx).find(i => i.ruleId === id);
  if (!item) {
    const note = undated(s, ctx).find(n => n.id === id);
    return note ? procedureCard(s, ctx, note) : home(s, ctx);
  }
  const key = `${item.ruleId}:${item.dueDate}`;
  const docs = item.documents.map(d => `${s.documents[`${key}:${d.id}`] ? "✓" : "□"} ${d.title[s.lang]}`);
  const target = targetText(s, ctx, item) || (item.recommendedDate ? t(s, ctx, "card.recommended") + date(s, item.recommendedDate) : "");
  const u = uni(s, ctx), overdue = item.status === "overdue";
  // Only the consequence the law states directly; no fines: liability is for evasion, not lateness (docs/legal-review.md, 5).
  const late = overdue ? t(s, ctx, "card.overdue", { uni: u.name[s.lang]! }) : "";
  const visit = item.status === "done" ? undefined : s.visits?.[id];
  const repeat = repeatParts(s, ctx, item);
  return reply(s, ctx, prefix + `**${item.title[s.lang]}**\n${repeat ? repeat.card + "\n" : ""}${item.action[s.lang]}\n\n` + t(s, ctx, "card.deadline") + `**${date(s, item.dueDate)}**` +
    // Facts under the deadline first (the university's date, the visit, the place), then the warnings as paragraphs.
    (item.status === "done" ? "" : ` (${countdown(s, ctx, item)})`) + target +
    (visit ? t(s, ctx, "card.visit", { date: date(s, visit) }) : "") + placeText(s, ctx, id) + late +
    (item.status === "done" ? "" : consequenceText(s, ctx, item)) +
    "\n\n" + docs.join("\n") + "\n" + documentsNote(s, ctx, item) + "\n\n" + item.legal.act + ", " + item.legal.article[s.lang] +
    "\n" + item.legal.url + t(s, ctx, "card.checked") + date(s, item.legal.checkedAt) +
    t(s, ctx, "card.confirm", { uni: u.name[s.lang]! }) + u.contactUrl,
    [...item.documents.map(d => [button((s.documents[`${key}:${d.id}`] ? "✓ " : "□ ") + d.title[s.lang], `doc:${id}:${d.id}`)]),
      ...(item.status === "done" ? [] : [[button(t(s, ctx, "btn.done"), `done:${id}`)],
        [button(t(s, ctx, visit ? "btn.visitChange" : "btn.visit"), `visit:${id}`)]]),
      [link(t(s, ctx, "btn.law"), item.legal.url)],
      ...(u.rulePlaces[id] ? [[link(t(s, ctx, "btn.map"), mapUrl(u.rulePlaces[id].map))]] : []),
      [button(t(s, ctx, overdue ? "btn.overdueHelp" : "btn.cantComplete"), `help:${id}`), button(t(s, ctx, "btn.plan"), "plan")]]);
}
/** A university deadline counted from a document end date the student gave (D-040); undefined until then. */
export function procedureDue(s: Session, _ctx: DialogueContext, note: UniversityProcedure): { end: string; due: string; from?: string } | undefined {
  const end = note.countdown ? s.ends?.[note.countdown.from] : undefined;
  if (!note.countdown || !end) return undefined;
  const { daysBefore, notBeforeDays } = note.countdown;
  return { end, due: addDays(end, -daysBefore), ...(notBeforeDays ? { from: addDays(end, -notBeforeDays) } : {}) };
}
/** The counted window or date with its caveat, as the chat card and the app show it. */
export function procedureDueText(s: Session, ctx: DialogueContext, note: UniversityProcedure): string {
  const due = procedureDue(s, ctx, note);
  if (!due) return "";
  const name = uni(s, ctx).name[s.lang]!;
  if (due.due < ctx.today) return t(s, ctx, "card.endPassed", { due: date(s, due.due), uni: name });
  return (due.from && due.from > ctx.today ? t(s, ctx, "card.window", { from: date(s, due.from), due: date(s, due.due) })
    : t(s, ctx, "card.byDate", { due: date(s, due.due) })) + t(s, ctx, "card.endNote", { uni: name, end: date(s, due.end) });
}
/** Where the procedure comes from; the app shows the same line. */
export function procedureSource(s: Session, ctx: DialogueContext, note: UniversityProcedure): string {
  return t(s, ctx, "card.procedureSource", { uni: uni(s, ctx).name[s.lang]!, url: note.source.url, date: date(s, note.source.checkedAt) });
}
/** Label of the link to the university's page, as on the chat card. */
export function pageLabel(s: Session, ctx: DialogueContext): string {
  return t(s, ctx, "btn.page", { uni: uni(s, ctx).name[s.lang]! });
}
/** A procedure without a calculated deadline: what to do, when in the source's words, the checklist, the source. */
function procedureCard(s: Session, ctx: DialogueContext, note: UniversityProcedure): Reply {
  const checked = (doc: string) => s.documents[`${note.id}:${doc}`] === true;
  const docs = note.documents.map(d => `${checked(d.id) ? "✓" : "□"} ${d.title[s.lang]}`);
  const counted = note.countdown ? procedureDue(s, ctx, note) : undefined;
  return reply(s, ctx, `**${note.title[s.lang]}**\n${note.action[s.lang]}\n\n` + t(s, ctx, "card.when") + note.when[s.lang] +
    procedureDueText(s, ctx, note) + "\n\n" + docs.join("\n") + "\n\n" + procedureSource(s, ctx, note),
    [...note.documents.map(d => [button((checked(d.id) ? "✓ " : "□ ") + d.title[s.lang], `doc:${note.id}:${d.id}`)]),
      ...(note.countdown ? [[button(t(s, ctx, counted ? "btn.endChange" : `btn.end.${note.countdown.from}`), `end:${note.id}`)]] : []),
      ...(note.place ? [[link(t(s, ctx, "btn.map"), mapUrl(note.place.map))]] : []),
      [link(pageLabel(s, ctx), note.source.url)],
      [button(t(s, ctx, "btn.plan"), "plan")]]);
}
const situation = (ctx: DialogueContext, id: string | undefined) => ctx.changes?.situations.find(c => c.id === id);
/** The deadline after a reported change (#41, D-061); undefined until the event date is given, and for a norm without a number of days. */
export function changeDue(s: Session, ctx: DialogueContext, c: ChangeSituation): (ChangeDeadline & { event: string }) | undefined {
  const event = s.changes?.[c.id];
  if (!ctx.changes || !event || !c.workdays) return undefined;
  return { event, ...changeDeadline(event, c.workdays, uni(s, ctx).changeTerms[c.id]?.workdays, ctx.changes.calendar) };
}
/** The reported changes with their deadlines, in the order of the data file; the plan, the calendar and the reminders list them. */
export function reportedChanges(s: Session, ctx: DialogueContext): { situation: ChangeSituation; deadline: ChangeDeadline & { event: string } }[] {
  return (ctx.changes?.situations ?? []).flatMap(c => { const deadline = changeDue(s, ctx, c); return deadline ? [{ situation: c, deadline }] : []; });
}
/** Change deadlines still ahead, for the calendar file. */
export function countedChanges(s: Session, ctx: DialogueContext): { id: string; title: string; due: string }[] {
  return reportedChanges(s, ctx).flatMap(({ situation: c, deadline: d }) => d.due && d.due >= ctx.today ? [{ id: c.id, title: c.title[s.lang]!, due: d.due }] : []);
}
/** Who files the notification of arrival (109-FZ Art. 22 part 2): the university as the receiving side, or the hotel or hospital. */
const filer = (s: Session, ctx: DialogueContext, c: ChangeSituation) =>
  c.receiver === "university" ? uni(s, ctx).name[s.lang]! : t(s, ctx, "change.who.place");
/** Whose date the deadline is: the university's own term for the student, or the receiving side's filing deadline. */
const dueWhat = (s: Session, ctx: DialogueContext, c: ChangeSituation, d: ChangeDeadline) => d.stricter === "university"
  ? t(s, ctx, "change.what.university", { uni: uni(s, ctx).name[s.lang]! }) : t(s, ctx, "change.what.filing", { who: filer(s, ctx, c) });
/** A reported change in the plan: whose date it is and when, or that the card says the norm in words. The app lists the same line (#91). */
export const changeLine = (s: Session, ctx: DialogueContext, c: ChangeSituation, d: ChangeDeadline) => d.due
  ? t(s, ctx, "home.change", { title: c.title[s.lang]!, what: dueWhat(s, ctx, c, d), due: date(s, d.due), countdown: changeCountdown(s, ctx, d.due) })
  : t(s, ctx, "home.changeWords", { title: c.title[s.lang]! });
/** Days left to a change deadline, in the plan's words. */
function changeCountdown(s: Session, ctx: DialogueContext, due: string): string {
  const n = daysBetween(ctx.today, due);
  if (n < 0) return t(s, ctx, "countdown.passed", { days: t(s, ctx, "days", { n: -n }) });
  return n === 0 ? t(s, ctx, "countdown.today") : t(s, ctx, "countdown.upcoming", { left: t(s, ctx, "left", { n }) });
}
export function changeList(s: Session, ctx: DialogueContext): Reply {
  return reply(s, ctx, t(s, ctx, "change.choose", { uni: uni(s, ctx).name[s.lang]! }),
    [...ctx.changes!.situations.map(c => [button(c.title[s.lang]!, `change:${c.id}`)]), [button(t(s, ctx, "btn.plan"), "plan")]]);
}
/** Live mode with draft norms (D-061): /change is off, and the reply says where to ask instead. */
export function changeOff(s: Session, ctx: DialogueContext): Reply {
  return reply(s, ctx, t(s, ctx, "change.off", { uni: uni(s, ctx).name[s.lang]!, url: uni(s, ctx).contactUrl }),
    [[link(pageLabel(s, ctx), uni(s, ctx).contactUrl)], [button(t(s, ctx, profile(s) ? "btn.plan" : "btn.continue"), profile(s) ? "plan" : "continue")]]);
}
/** The question for the event date and, on a wrong date, the same buttons again, so they never go stale. */
const changeDateRows = (s: Session, ctx: DialogueContext): Button[][] =>
  [[button(t(s, ctx, "btn.today"), "/today"), button(t(s, ctx, "btn.yesterday"), "/yesterday")], [button(t(s, ctx, "btn.cancel"), "plan")]];
/** The same for the completion, visit and document end dates (#109): a refusal repeats the question's buttons. */
const completionRows = (s: Session, ctx: DialogueContext): Button[][] =>
  [[button(t(s, ctx, "btn.today"), "/today")], [button(t(s, ctx, "btn.cancel"), "plan")]];
const visitRows = (s: Session, ctx: DialogueContext): Button[][] =>
  [[button(t(s, ctx, "btn.today"), "/today"), button(t(s, ctx, "btn.tomorrow"), "/tomorrow")], [button(t(s, ctx, "btn.cancel"), "plan")]];
const docEndRows = (s: Session, ctx: DialogueContext): Button[][] => [[button(t(s, ctx, "btn.cancel"), "plan")]];
/** The university's own procedure for a case (re-registration), when it names one for this student. */
export function changeProcedure(s: Session, ctx: DialogueContext, c: ChangeSituation): UniversityProcedure | undefined {
  const id = uni(s, ctx).changeTerms[c.id]?.procedure;
  return id ? undated(s, ctx).find(n => n.id === id) : undefined;
}
/**
 * A change of circumstances: the norm (fact), the university's own term with its source or that none is
 * confirmed, the stricter date (calculation) with how it is counted (assumption), what to hand over and where.
 */
export function changeCard(s: Session, ctx: DialogueContext, c: ChangeSituation, prefix = ""): Reply {
  const u = uni(s, ctx), name = u.name[s.lang]!, filing = ctx.changes!.filing, norm = c.norm[s.lang]!;
  const d = changeDue(s, ctx, c), term = u.changeTerms[c.id];
  const law = t(s, ctx, "change.law", { act: c.legal.act, article: c.legal.article[s.lang]!, url: c.legal.url, date: date(s, c.legal.checkedAt) });
  const federal = !d ? t(s, ctx, "change.norm", { norm }) : t(s, ctx, "change.event", { date: date(s, d.event) }) +
    (d.federal ? t(s, ctx, "change.federal", { date: date(s, d.federal), norm, who: filer(s, ctx, c) }) : t(s, ctx, "change.federalWords", { norm, who: filer(s, ctx, c) }));
  const assumption = c.assumption ? t(s, ctx, "change.situationAssumption", { text: c.assumption[s.lang]! }) : "";
  const source = term ? { uni: name, words: term.words[s.lang]!, url: term.source.url, checked: date(s, term.source.checkedAt) } : undefined;
  const own = !d ? "" : source ? (d.university ? t(s, ctx, "change.university", { ...source, date: date(s, d.university) }) : t(s, ctx, "change.universityWords", source))
    : c.receiver === "university" ? t(s, ctx, "change.universityTbd", { uni: name }) : "";
  const due = !d ? "" : (d.due ? t(s, ctx, d.stricter === "university" ? "change.due.both" : "change.due.one",
    { date: date(s, d.due), countdown: changeCountdown(s, ctx, d.due), uni: name, who: filer(s, ctx, c) }) +
    t(s, ctx, "change.assumption") + (d.due >= ctx.today ? t(s, ctx, s.reminders ? "change.remindOn" : "change.remindOff") : "") + t(s, ctx, "change.now")
    : t(s, ctx, "change.dueWords") + t(s, ctx, "change.now"));
  const handover = !c.workdays ? t(s, ctx, "change.handover.passport", { uni: name, url: u.contactUrl })
    : t(s, ctx, `change.handover.${c.receiver}`, { uni: name, url: u.contactUrl, act: filing.act, article: filing.article[s.lang]!, law: filing.url }) + t(s, ctx, "change.tornOff");
  const procedure = changeProcedure(s, ctx, c);
  return reply(s, ctx, prefix + `**${c.title[s.lang]!}**` + federal + assumption + law + own + due + handover +
    t(s, ctx, "change.notDecision") + (c.legal.status === "approved" ? "" : t(s, ctx, "change.provisional")),
    [...(d ? [[button(t(s, ctx, "btn.tornOff"), `change-done:${c.id}`)], [button(t(s, ctx, "btn.changeDate"), `change:${c.id}`)]] : []),
      ...(procedure ? [[button(procedure.title[s.lang]!, `card:${procedure.id}`)]] : []),
      [link(t(s, ctx, "btn.law"), c.legal.url)], [link(pageLabel(s, ctx), u.contactUrl)],
      [button(t(s, ctx, "btn.change"), "change"), button(t(s, ctx, "btn.plan"), "plan")]]);
}
/**
 * The catalogue of university profiles, offered on the scope question; the current one is not
 * repeated. `lost`: the student's own is gone, so every profile is offered and the reason is said.
 */
function universityList(s: Session, ctx: DialogueContext, lost = false): Reply {
  const others = ctx.universities.filter(u => lost || u.id !== uni(s, ctx).id);
  return reply(s, ctx, (lost ? t(s, ctx, "university.gone") : "") + t(s, ctx, "university.choose"),
    [...rows(others.map(u => button(u.name[s.lang] ?? u.name.ru!, `uni:${u.id}`)), 2),
      [button(t(s, ctx, "btn.noUniversity"), "uni-missing")]]);
}
function calendar(s: Session, ctx: DialogueContext): Transition {
  const items = plan(s, ctx);
  if (!items.some(i => i.status !== "done") && !countedChanges(s, ctx).length) return { session: s, reply: home(s, ctx) };
  const back = [button(t(s, ctx, "btn.plan"), "plan")];
  return { session: s, notice: t(s, ctx, "calendar.loading"), reply: { ...reply(s, ctx, t(s, ctx, "calendar.intro"), [back]),
    failed: reply(s, ctx, t(s, ctx, "calendar.failed"), [[button(t(s, ctx, "btn.retry"), "calendar")], back]),
    file: { name: CALENDAR_FILE, content: planToIcs(items,
      { lang: s.lang, texts: ctx.texts, demo: ctx.demo, uid: s.nonce, today: ctx.today, sequence: s.revision, ...(s.visits ? { visits: s.visits } : {}),
        procedures: countedProcedures(s, ctx), changes: countedChanges(s, ctx) }) } } };
}
/**
 * The plan as a PDF for a curator or the university (#92, D-056): deadlines, marks, legal basis and
 * the university contact. Like shareText, no citizenship, entry date or MAX ID.
 */
export function planPdf(s: Session, ctx: DialogueContext): PlanPdf {
  const u = uni(s, ctx), name = u.name[s.lang]!;
  const items = plan(s, ctx).map(item => ({ heading: item.title[s.lang]!, body: [
    repeatParts(s, ctx, item)?.card ?? "",
    t(s, ctx, "card.deadline") + date(s, item.dueDate),
    item.status === "done" ? t(s, ctx, "pdf.done", { date: date(s, s.completions[item.ruleId]!) }) : countdown(s, ctx, item),
    ...(item.status === "done" ? [] : [(targetText(s, ctx, item) || (item.recommendedDate ? t(s, ctx, "card.recommended") + date(s, item.recommendedDate) : "")).trim()]),
    ...(item.provisional && item.status !== "done" ? [t(s, ctx, "ics.provisional")] : []),
    `${item.legal.act}, ${item.legal.article[s.lang]}`, item.legal.url, (t(s, ctx, "card.checked") + date(s, item.legal.checkedAt)).trim(),
  ].filter(Boolean).join("\n") }));
  const notes = undated(s, ctx).map(n => ({ heading: n.title[s.lang]!,
    body: (procedureDueText(s, ctx, n).trim() || t(s, ctx, "card.when") + n.when[s.lang]) + "\n" + procedureSource(s, ctx, n) }));
  return { lang: s.lang, title: t(s, ctx, "pdf.title", { uni: name }),
    notes: [...(ctx.demo ? [t(s, ctx, "pdf.demo")] : []), t(s, ctx, "pdf.date", { date: date(s, ctx.today) })],
    sections: [...items, ...notes], footer: t(s, ctx, "pdf.contact", { uni: name, url: u.contactUrl }) };
}
function pdf(s: Session, ctx: DialogueContext): Transition {
  if (!plan(s, ctx).length) return { session: s, reply: home(s, ctx) };
  const back = [button(t(s, ctx, "btn.plan"), "plan")];
  return { session: s, notice: t(s, ctx, "pdf.loading"), reply: { ...reply(s, ctx, t(s, ctx, "pdf.intro"), [back]), pdf: planPdf(s, ctx),
    failed: reply(s, ctx, t(s, ctx, "pdf.failed"), [[button(t(s, ctx, "btn.retry"), "pdf")], back]) } };
}
/** University deadlines already counted from an entered end date, for the calendar file (D-040). */
export function countedProcedures(s: Session, ctx: DialogueContext): { id: string; title: string; due: string }[] {
  return undated(s, ctx).flatMap(n => {
    const counted = procedureDue(s, ctx, n);
    return counted && counted.due >= ctx.today ? [{ id: n.id, title: n.title[s.lang]!, due: counted.due }] : [];
  });
}
/** `unsupported`: the answer that ended the scenario — the scope question ("no"), a citizenship the rules exclude, or "other" (not in the university's list). */
// The reason is for a student still at the questions: with a plan there is no question to go back to.
const unsupportedReason = (s: Session, ctx: DialogueContext, why: "scope" | "citizenship" | "other") =>
  t(s, ctx, `help.unsupported.${why}`, { uni: uni(s, ctx).name[s.lang]!, from: date(s, coverage(ctx.rules).from) });
function help(s: Session, ctx: DialogueContext, ruleId?: string, unsupported?: "scope" | "citizenship" | "other"): Reply {
  const item = ruleId ? plan(s, ctx).find(i => i.ruleId === ruleId) : undefined;
  // Before the plan exists the way out is the question that was being answered (#68), not a retyped /start.
  const back = profile(s) ? [[button(t(s, ctx, "btn.plan"), "plan")]] : unsupported ? [[button(t(s, ctx, "btn.back"), "back")]] : [];
  const u = uni(s, ctx), name = u.name[s.lang]!;
  const actions = (draft: string): Button[][] => [[{ text: t(s, ctx, "btn.copy"), copy: draft }],
    [link(t(s, ctx, "btn.page", { uni: name }), u.contactUrl)], ...back];
  if (!item) {
    // An unsupported case has no procedure to ask about: the question is which deadlines apply at all (#82).
    const draft = t(s, ctx, unsupported ? "help.unsupported.draft" : "help.generic.draft", { uni: name });
    return reply(s, ctx, (unsupported ? t(s, ctx, "help.unsupported") + (profile(s) ? "" : unsupportedReason(s, ctx, unsupported)) : "") +
      t(s, ctx, unsupported ? "help.unsupported.ask" : "help.generic", { draft, uni: name, url: u.contactUrl }), actions(draft));
  }
  const who = t(s, ctx, "help.who", { citizenship: country(s, ctx, s.citizenship!), entry: date(s, s.entryDate!) });
  const overdue = item.status === "overdue";
  const draft = t(s, ctx, overdue ? "help.draft.overdue" : "help.draft", { uni: name, who, title: item.title[s.lang]!, due: date(s, item.dueDate) });
  return reply(s, ctx, t(s, ctx, overdue ? "help.intro.overdue" : "help.intro", { uni: name }) + draft +
    t(s, ctx, "help.contacts", { uni: name, url: u.contactUrl }), actions(draft));
}
export function prompt(s: Session, ctx: DialogueContext): Reply {
  if (universityLost(s, ctx)) return universityList(s, ctx, true);
  switch (s.step) {
    case "language": return reply(s, ctx, [...ctx.texts.keys()].map(l => format(ctx.texts, l, "language.choose")).join(" / "), languages(ctx));
    case "consent": return reply(s, ctx, t(s, ctx, "consent"),
      [[button(t(s, ctx, "btn.continue"), "accept")], ...languages(ctx, s.lang), [button(t(s, ctx, "btn.leave"), "delete")]]);
    case "scope": return reply(s, ctx, t(s, ctx, "scope", { uni: uni(s, ctx).name[s.lang]!, from: date(s, coverage(ctx.rules).from) }),
      [[button(t(s, ctx, "btn.yes"), "yes"), button(t(s, ctx, "btn.no"), "no")],
        // Without a deep link the default university is assumed; a student of another one says so here.
        ...(ctx.universities.length > 1 ? [[button(t(s, ctx, "btn.otherUniversity"), "universities")]] : [])]);
    case "citizenship": return reply(s, ctx, t(s, ctx, "citizenship"),
      // Citizenships the rules exclude stay as buttons: they lead to the help branch, not to a dead end.
      [...rows(uni(s, ctx).citizenships, 2), ...rows([...coverage(ctx.rules).excluded, "OTHER"], 2)]
        .map(row => row.map(code => button(country(s, ctx, code), code))));
    case "entry": return reply(s, ctx, t(s, ctx, "entry", { from: date(s, coverage(ctx.rules).from) }), entryRows(s, ctx));
    case "completion": return reply(s, ctx, t(s, ctx, "completion"), completionRows(s, ctx));
    case "docEnd": {
      const note = undated(s, ctx).find(n => n.id === s.selected);
      return reply(s, ctx, t(s, ctx, `docEnd.${note?.countdown?.from ?? "visa-end"}`), docEndRows(s, ctx));
    }
    case "visit": {
      const item = plan(s, ctx).find(i => i.ruleId === s.selected);
      return reply(s, ctx, t(s, ctx, "visit", { title: item?.title[s.lang] ?? "" }), visitRows(s, ctx));
    }
    case "changeDate": {
      const c = situation(ctx, s.selected);
      return reply(s, ctx, t(s, ctx, "change.date", { title: c?.title[s.lang] ?? "", event: c?.event?.[s.lang] ?? "" }), changeDateRows(s, ctx));
    }
    case "delete": return reply(s, ctx, t(s, ctx, "delete"),
      [[button(t(s, ctx, "btn.confirmDelete"), "confirm-delete"), button(t(s, ctx, "btn.cancel"), "cancel-delete")]]);
    case "plan": return home(s, ctx);
  }
}
export function transition(previous: Session | null, input: Input, ctx: DialogueContext): Transition {
  const s = previous ? structuredClone(previous) : initialSession(ctx.version);
  let action = input.text.trim();
  if (input.callback) {
    const separator = action.indexOf("|"), stamp = action.slice(0, separator);
    action = action.slice(separator + 1);
    const current = stamp === `${s.nonce}.${s.revision}`;
    // After /delete there is no session: the "Start" button of the last reply still begins a new one.
    if (!previous && action === "/start") return transition(null, { ...input, text: action, callback: false }, ctx);
    if (!previous || !(current || (stamp.startsWith(`${s.nonce}.`) && navigation(action) && profile(s)))) {
      return { session: previous, reply: reply(s, ctx, t(s, ctx, "expired")), expired: true };
    }
    if (!current) { s.step = "plan"; delete s.selected; }
  }
  s.revision++;
  if (action === "/delete" || action === "delete") {
    if (s.step !== "delete") s.back = s.step;
    s.step = "delete"; return { session: s, reply: prompt(s, ctx) };
  }
  if (s.step === "delete" && action === "confirm-delete") {
    return { session: null, reply: reply(s, ctx, t(s, ctx, "deleted"), [[button(t(s, ctx, "btn.start"), s.university ? `/start ${s.university}` : "/start")]]) };
  }
  if (s.step === "delete" && action === "cancel-delete") { s.step = s.back ?? (profile(s) ? "plan" : "language"); delete s.back; }
  if (action === "/stop") { s.reminders = false; return { session: s, reply: profile(s)
    ? reply(s, ctx, t(s, ctx, "stopped"), [[button(t(s, ctx, "btn.plan"), "plan")]])
    : reply(s, ctx, t(s, ctx, "stoppedNoPlan"), [[button(t(s, ctx, "btn.continue"), "continue")]]) }; }
  if (s.ruleVersion !== ctx.version) {
    s.reminders = false;
    return { session: s, reply: reply(s, ctx, t(s, ctx, "rulesChanged")) };
  }
  // Back on the step the deletion was cancelled from: its question again, not an answer to it.
  if (action === "cancel-delete") return { session: s, reply: prompt(s, ctx) };
  if (universityLost(s, ctx)) {
    // Until the student picks a university again nothing else is answered; the pick starts the scenario over.
    const chosen = /^uni:([a-z0-9_-]{1,32})$/.exec(action)?.[1];
    if (action !== "uni-missing" && !(chosen !== undefined && ctx.universities.some(u => u.id === chosen))) {
      return { session: s, reply: universityList(s, ctx, true) };
    }
    delete s.university; delete s.citizenship; delete s.entryDate; delete s.selected; delete s.back; delete s.visits; delete s.ends; delete s.changes;
    s.completions = {}; s.documents = {}; s.reminders = false; s.step = "scope";
  }
  // After /stop before the plan: the current step's question again, not an answer to it.
  if (action === "continue") return { session: s, reply: prompt(s, ctx) };
  const start = /^\/start(?:\s+(\S+))?$/.exec(action);
  if (start) {
    // A university's QR code opens max.ru/<bot>?start=<id>; the choice is fixed once the plan exists.
    const id = start[1]?.toLowerCase();
    if (id && !profile(s) && ctx.universities.some(u => u.id === id)) s.university = id;
    const lang = input.locale?.slice(0, 2).toLowerCase();
    if (s.step === "language" && lang && ctx.texts.has(lang)) { s.lang = lang; s.step = "consent"; }
    return { session: s, reply: prompt(s, ctx) };
  }
  // The university can be changed only before the plan exists, like the ?start= choice.
  if (s.step === "scope" && !profile(s)) {
    if (action === "universities") return { session: s, reply: universityList(s, ctx) };
    if (action === "uni-missing") {
      return { session: s, reply: reply(s, ctx, t(s, ctx, "university.missing"), [[button(t(s, ctx, "btn.universities"), "universities")]]) };
    }
    const chosen = /^uni:([a-z0-9_-]{1,32})$/.exec(action)?.[1];
    if (chosen !== undefined && ctx.universities.some(u => u.id === chosen)) s.university = chosen;
  }
  if (action === "/help" || action === "help") return { session: s, reply: help(s, ctx) };
  if (action === "back" && !profile(s)) {
    if (s.step === "entry") { s.step = "citizenship"; delete s.citizenship; }
    return { session: s, reply: prompt(s, ctx) };
  }
  if (action === "no") return { session: s, reply: help(s, ctx, undefined, "scope") };
  if (action === "OTHER") return { session: s, reply: help(s, ctx, undefined, "other") };
  if (coverage(ctx.rules).excluded.includes(action)) return { session: s, reply: help(s, ctx, undefined, "citizenship") };
  if (action.startsWith("help:")) return { session: s, reply: help(s, ctx, action.slice(5)) };
  // #41: from any step once the plan exists; before it the student answers the current question first.
  if (action === "/change" || action === "change") {
    // Live mode with draft norms: say so instead of showing the plan silently.
    if (!ctx.changes) return { session: s, reply: changeOff(s, ctx) };
    if (!profile(s)) return { session: s, reply: reply(s, ctx, t(s, ctx, "change.noPlan"), [[button(t(s, ctx, "btn.continue"), "continue")]]) };
    s.step = "plan"; delete s.selected;
    return { session: s, reply: changeList(s, ctx) };
  }
  if (s.step === "language" && ctx.texts.has(action)) { s.lang = action; s.step = "consent"; }
  else if (s.step === "consent" && ctx.texts.has(action)) s.lang = action;
  else if (s.step === "consent" && action === "accept") s.step = "scope";
  else if (s.step === "scope" && action === "yes") s.step = "citizenship";
  else if (s.step === "citizenship" && uni(s, ctx).citizenships.includes(action)) { s.citizenship = action; s.step = "entry"; }
  // Not entered yet: what to prepare at home; the step stays, so the entry date can still be sent.
  else if (s.step === "entry" && action === "before-entry" && beforeEntry(s, ctx).length) return { session: s, reply: beforeEntryReply(s, ctx) };
  else if (s.step === "entry") {
    const entry = ctx.demo && action === "example" ? exampleEntry(ctx) : typedDate(action), from = coverage(ctx.rules).from;
    if (!isValidDate(entry) || entry < from || entry > ctx.today) {
      // "entry.invalid" stays the key of a date before the period: the mini app matches it (Onboarding.tsx).
      const text = !isValidDate(entry) ? t(s, ctx, "entry.format")
        : entry > ctx.today ? t(s, ctx, "entry.future") + (beforeEntry(s, ctx).length ? t(s, ctx, "entry.future.beforeEntry") : "")
        : t(s, ctx, "entry.invalid", { from: date(s, from) });
      return { session: s, reply: reply(s, ctx, text, entryRows(s, ctx)) };
    }
    s.entryDate = entry; s.step = "plan";
  } else if (profile(s) && (action === "plan" || action === "/plan")) { s.step = "plan"; delete s.selected; }
  else if (s.step === "completion") {
    const done = action === "/today" ? ctx.today : typedDate(action);
    const last = s.selected ? s.completions[s.selected] : undefined;
    if (!s.selected || !isValidDate(done) || done > ctx.today || done < s.entryDate! || (last && compareDates(done, last) <= 0)) {
      return { session: s, reply: reply(s, ctx, t(s, ctx, "completion.invalid"), completionRows(s, ctx)) };
    }
    s.completions[s.selected] = done;
    // A marked procedure needs no visit any more; a repeat a year later gets a new one.
    if (s.visits?.[s.selected]) { const rest = { ...s.visits }; delete rest[s.selected]; s.visits = rest; }
    s.step = "plan"; delete s.selected;
  } else if (s.step === "docEnd") {
    const end = typedDate(action);
    const note = undated(s, ctx).find(n => n.id === s.selected && n.countdown);
    if (!note?.countdown || !isValidDate(end) || end < ctx.today || end > addDays(ctx.today, 2 * VISIT_HORIZON_DAYS)) {
      return { session: s, reply: reply(s, ctx, t(s, ctx, "docEnd.invalid"), docEndRows(s, ctx)) };
    }
    s.ends = { ...s.ends, [note.countdown.from]: end }; s.step = "plan"; delete s.selected;
    return { session: s, reply: procedureCard(s, ctx, note) };
  } else if (s.step === "visit") {
    // The buttons carry the action, not a date: a button shown yesterday must still mean today.
    const day = action === "/today" ? ctx.today : action === "/tomorrow" ? addDays(ctx.today, 1) : typedDate(action);
    const item = plan(s, ctx).find(i => i.ruleId === s.selected && i.status !== "done");
    if (!item || !isValidDate(day) || day < ctx.today || day > addDays(ctx.today, VISIT_HORIZON_DAYS)) {
      return { session: s, reply: reply(s, ctx, t(s, ctx, "visit.invalid"), visitRows(s, ctx)) };
    }
    s.visits = { ...s.visits, [item.ruleId]: day }; s.step = "plan"; delete s.selected;
    const note = t(s, ctx, "visit.saved", { date: date(s, day) }) +
      (day > item.dueDate ? t(s, ctx, "visit.late", { due: date(s, item.dueDate) }) : "") +
      t(s, ctx, s.reminders ? "visit.remindOn" : "visit.remindOff");
    return { session: s, reply: card(s, ctx, item.ruleId, note) };
  } else if (s.step === "changeDate") {
    const day = action === "/today" ? ctx.today : action === "/yesterday" ? addDays(ctx.today, -1) : typedDate(action);
    const c = situation(ctx, s.selected);
    if (!c?.workdays || !isValidDate(day) || day < s.entryDate! || day > addDays(ctx.today, VISIT_HORIZON_DAYS)) {
      return { session: s, reply: reply(s, ctx, t(s, ctx, "change.invalid"), changeDateRows(s, ctx)) };
    }
    s.changes = { ...s.changes, [c.id]: day }; s.step = "plan"; delete s.selected;
    return { session: s, reply: changeCard(s, ctx, c, t(s, ctx, "change.saved")) };
  } else if (s.step === "plan") {
    if (action === "reminders") { s.reminders = !s.reminders; }
    else if (action.startsWith("card:")) return { session: s, reply: card(s, ctx, action.slice(5).replace(FROM_REMINDER, "")) };
    else if (action === "calendar") return calendar(s, ctx);
    else if (action === "pdf") return pdf(s, ctx);
    else if (action.startsWith("doc:")) {
      const [, id, doc] = action.split(":");
      const item = plan(s, ctx).find(i => i.ruleId === id);
      if (item && item.documents.some(d => d.id === doc)) {
        const key = `${id}:${item.dueDate}:${doc}`; s.documents[key] = !s.documents[key];
        return { session: s, reply: card(s, ctx, id!) };
      }
      const note = item ? undefined : undated(s, ctx).find(n => n.id === id);
      if (note && note.documents.some(d => d.id === doc)) {
        const key = `${id}:${doc}`; s.documents[key] = !s.documents[key];
        return { session: s, reply: procedureCard(s, ctx, note) };
      }
    } else if (action.startsWith("end:")) {
      const id = action.slice(4);
      if (undated(s, ctx).some(n => n.id === id && n.countdown)) { s.selected = id; s.step = "docEnd"; }
    } else if (action.startsWith("visit:")) {
      const id = action.slice(6);
      if (plan(s, ctx).some(i => i.ruleId === id && i.status !== "done")) { s.selected = id; s.step = "visit"; }
    } else if (action.startsWith("change:")) {
      const c = situation(ctx, action.slice(7));
      // A norm without a number of days asks for no date: the card says what to do.
      if (c && !c.workdays) return { session: s, reply: changeCard(s, ctx, c) };
      if (c) { s.selected = c.id; s.step = "changeDate"; }
    } else if (action.startsWith("changed:")) {
      const c = situation(ctx, action.slice(8));
      if (c) return { session: s, reply: changeCard(s, ctx, c) };
    } else if (action.startsWith("change-done:")) {
      // The torn-off part is the proof of registration: the deadline and its reminders are no longer needed.
      const id = action.slice(12);
      if (Object.hasOwn(s.changes ?? {}, id)) {
        const rest = { ...s.changes }; delete rest[id]; s.changes = rest;
        return { session: s, reply: home(s, ctx, t(s, ctx, "change.closed")) };
      }
    } else if (action.startsWith("done:")) {
      const id = action.slice(5);
      if (plan(s, ctx).some(i => i.ruleId === id && i.status !== "done")) { s.selected = id; s.step = "completion"; }
    }
  }
  return { session: s, reply: prompt(s, ctx) };
}
/** A reminder before a university deadline counted from a document end date (D-040). */
export function procedureReminderReply(s: Session, ctx: DialogueContext, note: UniversityProcedure, due: string): Reply {
  return reply(s, ctx, t(s, ctx, "procedure.reminder", { title: note.title[s.lang]!, due: date(s, due), left: t(s, ctx, "left", { n: daysBetween(ctx.today, due) }) }),
    [[button(t(s, ctx, "btn.details"), `card:${note.id}`)], [button(t(s, ctx, "btn.planShort"), "plan")]]);
}
/** A reminder before a change deadline (#41): 3 days and 1 day before, and on the day. */
export function changeReminderReply(s: Session, ctx: DialogueContext, c: ChangeSituation, due: string): Reply {
  const d = changeDue(s, ctx, c);
  return reply(s, ctx, t(s, ctx, "change.reminder", { title: c.title[s.lang]!, what: d ? dueWhat(s, ctx, c, d) : t(s, ctx, "change.what.filing", { who: filer(s, ctx, c) }),
    due: date(s, due), countdown: changeCountdown(s, ctx, due) }),
    [[button(t(s, ctx, "btn.details"), `changed:${c.id}`)], [button(t(s, ctx, "btn.planShort"), "plan")]]);
}
/** The evening before a planned visit: which documents of the checklist are still unchecked. */
export function visitReply(s: Session, ctx: DialogueContext, item: PlanItem): Reply {
  const missing = item.documents.filter(d => !s.documents[`${item.ruleId}:${item.dueDate}:${d.id}`]);
  return reply(s, ctx, t(s, ctx, "visit.reminder", { title: item.title[s.lang]!, due: date(s, item.dueDate) }) +
    (missing.length ? t(s, ctx, "visit.missing", { docs: missing.map(d => `□ ${d.title[s.lang]}`).join("\n") }) : t(s, ctx, "visit.ready")),
    [[button(t(s, ctx, "btn.details"), `card:${item.ruleId}`)], [button(t(s, ctx, "btn.planShort"), "plan")]]);
}
export function reminderReply(s: Session, ctx: DialogueContext, item: PlanItem): Reply {
  const { title, doneOn } = repeatTitle(s, ctx, item);
  return reply(s, ctx, t(s, ctx, item.status === "overdue" ? "reminder.overdue" : "reminder", { title, due: date(s, item.dueDate), countdown: countdown(s, ctx, item) }) + doneOn,
    [[button(t(s, ctx, "btn.details"), `card:${item.ruleId}${FROM_REMINDER}`)], [button(t(s, ctx, "btn.planShort"), "plan")]]);
}
