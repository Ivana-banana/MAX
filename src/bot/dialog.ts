import { randomUUID } from "node:crypto";
import { buildPlan, coverage, matchesCondition, REMINDER_OFFSETS } from "../core/deadlines.js";
import { addDays, compareDates, daysBetween, isValidDate } from "../core/dates.js";
import type { Completions, DeadlineRule, Lang, PlanItem, UserProfile } from "../core/types.js";
import type { ProcedureCountdown, University, UniversityProcedure } from "../data/loadUniversities.js";
import { format, type Texts } from "../data/loadTexts.js";
import { CALENDAR_FILE, planToIcs } from "./calendar.js";

// callback buttons come back to the bot; link and clipboard buttons are handled by MAX itself
export type Button = { text: string; action: string } | { text: string; url: string } | { text: string; copy: string }
  | { text: string; app: string; payload: string };
export interface Reply { text: string; buttons: Button[][]; ruleVersion: string; file?: { name: string; content: string } }
export interface Session {
  nonce: string;
  revision: number;
  lang: Lang;
  step: "language" | "consent" | "scope" | "citizenship" | "entry" | "plan" | "completion" | "visit" | "docEnd" | "delete";
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
  reminders: boolean;
  ruleVersion: string;
}
export interface DialogueContext {
  rules: DeadlineRule[]; universities: University[]; texts: Texts; version: string; today: string; demo: boolean;
  /** Bot whose mini app the plan opens (`open_app`); unset until the app URL is registered with MAX. */
  webApp?: string;
}
// locale comes only with bot_started (MAX client language); a ?start= payload arrives as "/start <payload>"
export interface Input { text: string; callback: boolean; locale?: string }
/** `expired`: a stale button was refused and nothing changed. */
export interface Transition { session: Session | null; reply: Reply; expired?: true }
// Every user-facing text comes from src/data/i18n/<lang>.json.
const t = (s: Session, ctx: DialogueContext, key: string, vars?: Record<string, string | number>) => format(ctx.texts, s.lang, key, vars);
// Sessions created before university profiles existed have no id and fall back to the default one.
const uni = (s: Session, ctx: DialogueContext) => ctx.universities.find(u => u.id === s.university) ?? ctx.universities[0]!;
/** Dates in replies are written out in the user's language (Intl), not as ISO strings. */
const date = (s: Session, iso: string) => new Intl.DateTimeFormat(s.lang, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
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
  return p ? buildPlan(ctx.rules, p, s.completions, ctx.today) : [];
}
/**
 * The university's own procedures whose deadline the bot cannot calculate (it counts from the
 * move-in date, which the bot does not know). No reminders, no calendar event: the plan lists
 * them apart, with the deadline in the source's words.
 */
export function undated(s: Session, ctx: DialogueContext): UniversityProcedure[] {
  const p = profile(s);
  return p ? uni(s, ctx).procedures.filter(pr => pr.appliesIf.every(c => matchesCondition(c, p))) : [];
}
function reply(s: Session, ctx: DialogueContext, text: string, rows: Button[][] = []): Reply {
  const banner = ctx.demo ? t(s, ctx, "banner.demo") : "";
  return { text: banner + text, ruleVersion: ctx.version, buttons: rows.map(row => row.map(b => "action" in b ? {
    text: b.text, action: `${s.nonce}.${s.revision}|${b.action}`,
  } : b)) };
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
const navigation = (action: string) => action === "plan" || action === "help" || action === "calendar" ||
  action.startsWith("card:") || action.startsWith("help:");
function home(s: Session, ctx: DialogueContext, prefix = ""): Reply {
  const items = plan(s, ctx);
  const lines = items.map(i => `• ${i.title[s.lang]}: ${date(s, i.dueDate)} — ${countdown(s, ctx, i)}`);
  const notes = undated(s, ctx);
  const noteLines = notes.length ? t(s, ctx, "home.undated") + notes.map(n => {
    const counted = procedureDue(s, ctx, n);
    return counted ? t(s, ctx, "home.undatedDue", { title: n.title[s.lang]!, due: date(s, counted.due) }) : `• ${n.title[s.lang]}`;
  }).join("\n") : "";
  // Reminders are the core mechanic, so while they are off the switch comes first, right under the text.
  const toggle = [button(t(s, ctx, s.reminders ? "btn.remindersOff" : "btn.remindersOn"), "reminders")];
  return reply(s, ctx, prefix + t(s, ctx, "home.title") + lines.join("\n") + noteLines + t(s, ctx, "home.scope") +
    t(s, ctx, s.reminders ? "home.reminders.on" : "home.reminders.off"),
    [...(s.reminders ? [] : [toggle]), ...items.map(i => [button(i.title[s.lang]!, `card:${i.ruleId}`)]),
      ...notes.map(n => [button(n.title[s.lang]!, `card:${n.id}`)]),
      ...(s.reminders ? [toggle] : []),
      ...(items.some(i => i.status !== "done") ? [[button(t(s, ctx, "btn.calendar"), "calendar")]] : []),
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
  const lines = items.map(i => t(s, ctx, i.status === "done" ? "share.done" : "share.item", { title: i.title[s.lang]!, due: date(s, i.dueDate) }));
  return (ctx.demo ? t(s, ctx, "banner.demo") : "") + t(s, ctx, "share.plan", { uni: name, lines: lines.join("\n") }) +
    (items.some(i => i.provisional && i.status !== "done") ? t(s, ctx, "share.provisional", { uni: name }) : "");
}
/** "How to get there": a Yandex Maps search for the address — a public link, no API and no location data (D-041). */
export const mapUrl = (address: string) => `https://yandex.ru/maps/?text=${encodeURIComponent(address)}`;
/** Where the student's university sends them for a federal procedure, with the source; empty when it does not say. */
export function placeText(s: Session, ctx: DialogueContext, ruleId: string): string {
  const place = uni(s, ctx).rulePlaces[ruleId];
  return place ? t(s, ctx, "card.place", { where: place.where[s.lang]!, uni: uni(s, ctx).name[s.lang]!, date: date(s, place.source.checkedAt) }) : "";
}
/** Where the checklist comes from, or that no official list is published (D-027); the app shows it too. */
export function documentsNote(s: Session, ctx: DialogueContext, item: PlanItem): string {
  return item.documentsSource
    ? t(s, ctx, "card.docsSource", { url: item.documentsSource.url, date: date(s, item.documentsSource.checkedAt) })
    : t(s, ctx, "card.docsNoSource", { uni: uni(s, ctx).name[s.lang]! });
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
  const target = item.recommendedDate ? t(s, ctx, "card.recommended") + date(s, item.recommendedDate) : "";
  const u = uni(s, ctx), overdue = item.status === "overdue";
  // No consequences or fines here: the law text on liability is not reviewed (docs/legal-review.md).
  const late = overdue ? t(s, ctx, "card.overdue", { uni: u.name[s.lang]! }) : "";
  const visit = item.status === "done" ? undefined : s.visits?.[id];
  return reply(s, ctx, prefix + `${item.title[s.lang]}\n${item.action[s.lang]}\n` + t(s, ctx, "card.deadline") + date(s, item.dueDate) +
    (item.status === "done" ? "" : ` (${countdown(s, ctx, item)})`) + target + late +
    (visit ? t(s, ctx, "card.visit", { date: date(s, visit) }) : "") + placeText(s, ctx, id) +
    "\n\n" + docs.join("\n") + "\n" + documentsNote(s, ctx, item) + "\n\n" + item.legal.act + ", " + item.legal.article +
    "\n" + item.legal.url + t(s, ctx, "card.checked") + item.legal.checkedAt +
    t(s, ctx, "card.confirm", { uni: u.name[s.lang]! }) + u.contactUrl,
    [...item.documents.map(d => [button((s.documents[`${key}:${d.id}`] ? "✓ " : "□ ") + d.title[s.lang], `doc:${id}:${d.id}`)]),
      ...(item.status === "done" ? [] : [[button(t(s, ctx, "btn.done"), `done:${id}`)],
        [button(t(s, ctx, visit ? "btn.visitChange" : "btn.visit"), `visit:${id}`)]]),
      [link(t(s, ctx, "btn.law"), item.legal.url)],
      ...(u.rulePlaces[id] ? [[link(t(s, ctx, "btn.map"), mapUrl(u.rulePlaces[id]!.map))]] : []),
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
  return reply(s, ctx, `${note.title[s.lang]}\n${note.action[s.lang]}\n` + t(s, ctx, "card.when") + note.when[s.lang] +
    procedureDueText(s, ctx, note) + "\n\n" + docs.join("\n") + "\n\n" + procedureSource(s, ctx, note),
    [...note.documents.map(d => [button((checked(d.id) ? "✓ " : "□ ") + d.title[s.lang], `doc:${note.id}:${d.id}`)]),
      ...(note.countdown ? [[button(t(s, ctx, counted ? "btn.endChange" : `btn.end.${note.countdown.from}`), `end:${note.id}`)]] : []),
      ...(note.place ? [[link(t(s, ctx, "btn.map"), mapUrl(note.place.map))]] : []),
      [link(pageLabel(s, ctx), note.source.url)],
      [button(t(s, ctx, "btn.plan"), "plan")]]);
}
/** The catalogue of university profiles, offered on the scope question; the current one is not repeated. */
function universityList(s: Session, ctx: DialogueContext): Reply {
  const others = ctx.universities.filter(u => u.id !== uni(s, ctx).id);
  return reply(s, ctx, t(s, ctx, "university.choose"),
    [...rows(others.map(u => button(u.name[s.lang] ?? u.name.ru!, `uni:${u.id}`)), 2),
      [button(t(s, ctx, "btn.noUniversity"), "uni-missing")]]);
}
function calendar(s: Session, ctx: DialogueContext): Reply {
  const items = plan(s, ctx);
  if (!items.some(i => i.status !== "done")) return home(s, ctx);
  return { ...reply(s, ctx, t(s, ctx, "calendar.intro"), [[button(t(s, ctx, "btn.plan"), "plan")]]),
    file: { name: CALENDAR_FILE, content: planToIcs(items,
      { lang: s.lang, texts: ctx.texts, demo: ctx.demo, uid: s.nonce, today: ctx.today, sequence: s.revision, ...(s.visits ? { visits: s.visits } : {}),
        procedures: countedProcedures(s, ctx) }) } };
}
/** University deadlines already counted from an entered end date, for the calendar file (D-040). */
export function countedProcedures(s: Session, ctx: DialogueContext): { id: string; title: string; due: string }[] {
  return undated(s, ctx).flatMap(n => {
    const counted = procedureDue(s, ctx, n);
    return counted && counted.due >= ctx.today ? [{ id: n.id, title: n.title[s.lang]!, due: counted.due }] : [];
  });
}
function help(s: Session, ctx: DialogueContext, ruleId?: string, unsupported = false): Reply {
  const item = ruleId ? plan(s, ctx).find(i => i.ruleId === ruleId) : undefined;
  const back = profile(s) ? [[button(t(s, ctx, "btn.plan"), "plan")]] : [];
  const u = uni(s, ctx), name = u.name[s.lang]!;
  const actions = (draft: string): Button[][] => [[{ text: t(s, ctx, "btn.copy"), copy: draft }],
    [link(t(s, ctx, "btn.page", { uni: name }), u.contactUrl)], ...back];
  if (!item) {
    const draft = t(s, ctx, "help.generic.draft", { uni: name });
    return reply(s, ctx, (unsupported ? t(s, ctx, "help.unsupported") : "") +
      t(s, ctx, "help.generic", { draft, uni: name, url: u.contactUrl }), actions(draft));
  }
  const who = t(s, ctx, "help.who", { citizenship: country(s, ctx, s.citizenship!), entry: date(s, s.entryDate!) });
  const overdue = item.status === "overdue";
  const draft = t(s, ctx, overdue ? "help.draft.overdue" : "help.draft", { uni: name, who, title: item.title[s.lang]!, due: date(s, item.dueDate) });
  return reply(s, ctx, t(s, ctx, overdue ? "help.intro.overdue" : "help.intro", { uni: name }) + draft +
    t(s, ctx, "help.contacts", { uni: name, url: u.contactUrl }), actions(draft));
}
export function prompt(s: Session, ctx: DialogueContext): Reply {
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
    case "entry": return reply(s, ctx, t(s, ctx, "entry", { from: date(s, coverage(ctx.rules).from) }),
      ctx.demo ? [[button(t(s, ctx, "btn.example", { date: date(s, exampleEntry(ctx)) }), "example")]] : []);
    case "completion": return reply(s, ctx, t(s, ctx, "completion"), [[button(t(s, ctx, "btn.cancel"), "plan")]]);
    case "docEnd": {
      const note = undated(s, ctx).find(n => n.id === s.selected);
      return reply(s, ctx, t(s, ctx, `docEnd.${note?.countdown?.from ?? "visa-end"}`), [[button(t(s, ctx, "btn.cancel"), "plan")]]);
    }
    case "visit": {
      const item = plan(s, ctx).find(i => i.ruleId === s.selected);
      return reply(s, ctx, t(s, ctx, "visit", { title: item?.title[s.lang] ?? "" }),
        [[button(t(s, ctx, "btn.today"), ctx.today), button(t(s, ctx, "btn.tomorrow"), addDays(ctx.today, 1))],
          [button(t(s, ctx, "btn.cancel"), "plan")]]);
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
    return { session: null, reply: reply(s, ctx, t(s, ctx, "deleted")) };
  }
  if (s.step === "delete" && action === "cancel-delete") { s.step = s.back ?? (profile(s) ? "plan" : "language"); delete s.back; }
  if (action === "/stop") { s.reminders = false; return { session: s, reply: reply(s, ctx, t(s, ctx, "stopped")) }; }
  if (s.ruleVersion !== ctx.version) {
    s.reminders = false;
    return { session: s, reply: reply(s, ctx, t(s, ctx, "rulesChanged")) };
  }
  // Back on the step the deletion was cancelled from: its question again, not an answer to it.
  if (action === "cancel-delete") return { session: s, reply: prompt(s, ctx) };
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
  if (action === "no" || action === "OTHER" || coverage(ctx.rules).excluded.includes(action)) return { session: s, reply: help(s, ctx, undefined, true) };
  if (action.startsWith("help:")) return { session: s, reply: help(s, ctx, action.slice(5)) };
  if (s.step === "language" && ctx.texts.has(action)) { s.lang = action; s.step = "consent"; }
  else if (s.step === "consent" && ctx.texts.has(action)) s.lang = action;
  else if (s.step === "consent" && action === "accept") s.step = "scope";
  else if (s.step === "scope" && action === "yes") s.step = "citizenship";
  else if (s.step === "citizenship" && uni(s, ctx).citizenships.includes(action)) { s.citizenship = action; s.step = "entry"; }
  else if (s.step === "entry") {
    const entry = ctx.demo && action === "example" ? exampleEntry(ctx) : typedDate(action), from = coverage(ctx.rules).from;
    if (!isValidDate(entry) || entry < from || entry > ctx.today) {
      return { session: s, reply: reply(s, ctx, t(s, ctx, "entry.invalid", { from: date(s, from) })) };
    }
    s.entryDate = entry; s.step = "plan";
  } else if (profile(s) && (action === "plan" || action === "/plan")) { s.step = "plan"; delete s.selected; }
  else if (s.step === "completion") {
    const done = action === "/today" ? ctx.today : typedDate(action);
    const last = s.selected ? s.completions[s.selected] : undefined;
    if (!s.selected || !isValidDate(done) || done > ctx.today || done < s.entryDate! || (last && compareDates(done, last) <= 0)) {
      return { session: s, reply: reply(s, ctx, t(s, ctx, "completion.invalid")) };
    }
    s.completions[s.selected] = done;
    // A marked procedure needs no visit any more; a repeat a year later gets a new one.
    if (s.visits?.[s.selected]) { const { [s.selected]: _, ...rest } = s.visits; s.visits = rest; }
    s.step = "plan"; delete s.selected;
  } else if (s.step === "docEnd") {
    const end = typedDate(action);
    const note = undated(s, ctx).find(n => n.id === s.selected && n.countdown);
    if (!note?.countdown || !isValidDate(end) || end < ctx.today || end > addDays(ctx.today, 2 * VISIT_HORIZON_DAYS)) {
      return { session: s, reply: reply(s, ctx, t(s, ctx, "docEnd.invalid")) };
    }
    s.ends = { ...s.ends, [note.countdown.from]: end }; s.step = "plan"; delete s.selected;
    return { session: s, reply: procedureCard(s, ctx, note) };
  } else if (s.step === "visit") {
    const day = typedDate(action);
    const item = plan(s, ctx).find(i => i.ruleId === s.selected && i.status !== "done");
    if (!item || !isValidDate(day) || day < ctx.today || day > addDays(ctx.today, VISIT_HORIZON_DAYS)) {
      return { session: s, reply: reply(s, ctx, t(s, ctx, "visit.invalid")) };
    }
    s.visits = { ...s.visits, [item.ruleId]: day }; s.step = "plan"; delete s.selected;
    const note = t(s, ctx, "visit.saved", { date: date(s, day) }) +
      (day > item.dueDate ? t(s, ctx, "visit.late", { due: date(s, item.dueDate) }) : "") +
      t(s, ctx, s.reminders ? "visit.remindOn" : "visit.remindOff");
    return { session: s, reply: card(s, ctx, item.ruleId, note) };
  } else if (s.step === "plan") {
    if (action === "reminders") { s.reminders = !s.reminders; }
    else if (action.startsWith("card:")) return { session: s, reply: card(s, ctx, action.slice(5).replace(FROM_REMINDER, "")) };
    else if (action === "calendar") return { session: s, reply: calendar(s, ctx) };
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
/** The evening before a planned visit: which documents of the checklist are still unchecked. */
export function visitReply(s: Session, ctx: DialogueContext, item: PlanItem): Reply {
  const missing = item.documents.filter(d => !s.documents[`${item.ruleId}:${item.dueDate}:${d.id}`]);
  return reply(s, ctx, t(s, ctx, "visit.reminder", { title: item.title[s.lang]!, due: date(s, item.dueDate) }) +
    (missing.length ? t(s, ctx, "visit.missing", { docs: missing.map(d => `□ ${d.title[s.lang]}`).join("\n") }) : t(s, ctx, "visit.ready")),
    [[button(t(s, ctx, "btn.details"), `card:${item.ruleId}`)], [button(t(s, ctx, "btn.planShort"), "plan")]]);
}
export function reminderReply(s: Session, ctx: DialogueContext, item: PlanItem): Reply {
  return reply(s, ctx, t(s, ctx, item.status === "overdue" ? "reminder.overdue" : "reminder", { title: item.title[s.lang]!, due: date(s, item.dueDate), countdown: countdown(s, ctx, item) }),
    [[button(t(s, ctx, "btn.details"), `card:${item.ruleId}${FROM_REMINDER}`)], [button(t(s, ctx, "btn.planShort"), "plan")]]);
}
