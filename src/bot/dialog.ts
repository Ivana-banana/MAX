import { randomUUID } from "node:crypto";
import { buildPlan } from "../core/deadlines.js";
import { compareDates, isValidDate } from "../core/dates.js";
import type { Completions, DeadlineRule, Lang, PlanItem, UserProfile } from "../core/types.js";
import type { University } from "../data/loadUniversities.js";
import { format, type Texts } from "../data/loadTexts.js";
import { CALENDAR_FILE, planToIcs } from "./calendar.js";

// callback buttons come back to the bot; link and clipboard buttons are handled by MAX itself
export type Button = { text: string; action: string } | { text: string; url: string } | { text: string; copy: string };
export interface Reply { text: string; buttons: Button[][]; ruleVersion: string; file?: { name: string; content: string } }
export interface Session {
  nonce: string;
  revision: number;
  lang: Lang;
  step: "language" | "consent" | "scope" | "citizenship" | "entry" | "plan" | "completion" | "delete";
  university?: string;
  citizenship?: string;
  entryDate?: string;
  selected?: string;
  completions: Completions;
  documents: Record<string, boolean>;
  reminders: boolean;
  ruleVersion: string;
}
export interface DialogueContext { rules: DeadlineRule[]; universities: University[]; texts: Texts; version: string; today: string; demo: boolean }
// locale comes only with bot_started (MAX client language); a ?start= payload arrives as "/start <payload>"
export interface Input { text: string; callback: boolean; locale?: string }
export interface Transition { session: Session | null; reply: Reply }
// Every user-facing text comes from src/data/i18n/<lang>.json.
const t = (s: Session, ctx: DialogueContext, key: string, vars?: Record<string, string | number>) => format(ctx.texts, s.lang, key, vars);
// Sessions created before university profiles existed have no id and fall back to the default one.
const uni = (s: Session, ctx: DialogueContext) => ctx.universities.find(u => u.id === s.university) ?? ctx.universities[0]!;
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
  const lines = items.map(i => `• ${i.title[s.lang]}: ${i.dueDate} — ${countdown(s, ctx, i)}`);
  // Reminders are the core mechanic, so while they are off the switch comes first, right under the text.
  const toggle = [button(t(s, ctx, s.reminders ? "btn.remindersOff" : "btn.remindersOn"), "reminders")];
  return reply(s, ctx, prefix + t(s, ctx, "home.title") + lines.join("\n") + t(s, ctx, "home.scope") +
    t(s, ctx, s.reminders ? "home.reminders.on" : "home.reminders.off"),
    [...(s.reminders ? [] : [toggle]), ...items.map(i => [button(i.title[s.lang]!, `card:${i.ruleId}`)]),
      ...(s.reminders ? [toggle] : []),
      ...(items.some(i => i.status !== "done") ? [[button(t(s, ctx, "btn.calendar"), "calendar")]] : []),
      [button(t(s, ctx, "btn.help"), "help")],
      [button(t(s, ctx, "btn.delete"), "delete")]]);
}
function card(s: Session, ctx: DialogueContext, id: string): Reply {
  const item = plan(s, ctx).find(i => i.ruleId === id);
  if (!item) return home(s, ctx);
  const key = `${item.ruleId}:${item.dueDate}`;
  const docs = item.documents.map(d => `${s.documents[`${key}:${d.id}`] ? "✓" : "□"} ${d.title[s.lang]}`);
  const target = item.recommendedDate ? t(s, ctx, "card.recommended") + item.recommendedDate : "";
  const u = uni(s, ctx), overdue = item.status === "overdue";
  // No consequences or fines here: the law text on liability is not reviewed (docs/legal-review.md).
  const late = overdue ? t(s, ctx, "card.overdue", { uni: u.name[s.lang]! }) : "";
  return reply(s, ctx, `${item.title[s.lang]}\n${item.action[s.lang]}\n` + t(s, ctx, "card.deadline") + item.dueDate +
    (item.status === "done" ? "" : ` (${countdown(s, ctx, item)})`) + target + late +
    "\n\n" + docs.join("\n") + "\n\n" + item.legal.act + ", " + item.legal.article +
    "\n" + item.legal.url + t(s, ctx, "card.checked") + item.legal.checkedAt +
    t(s, ctx, "card.confirm", { uni: u.name[s.lang]! }) + u.contactUrl,
    [...item.documents.map(d => [button((s.documents[`${key}:${d.id}`] ? "✓ " : "□ ") + d.title[s.lang], `doc:${id}:${d.id}`)]),
      ...(item.status === "done" ? [] : [[button(t(s, ctx, "btn.done"), `done:${id}`)]]),
      [link(t(s, ctx, "btn.law"), item.legal.url)],
      [button(t(s, ctx, overdue ? "btn.overdueHelp" : "btn.cantComplete"), `help:${id}`), button(t(s, ctx, "btn.plan"), "plan")]]);
}
function calendar(s: Session, ctx: DialogueContext): Reply {
  const items = plan(s, ctx).filter(i => i.status !== "done");
  if (!items.length) return home(s, ctx);
  return { ...reply(s, ctx, t(s, ctx, "calendar.intro"), [[button(t(s, ctx, "btn.plan"), "plan")]]),
    file: { name: CALENDAR_FILE, content: planToIcs(items, { lang: s.lang, texts: ctx.texts, demo: ctx.demo, uid: s.nonce, today: ctx.today }) } };
}
function help(s: Session, ctx: DialogueContext, ruleId?: string): Reply {
  const item = ruleId ? plan(s, ctx).find(i => i.ruleId === ruleId) : undefined;
  const back = profile(s) ? [[button(t(s, ctx, "btn.plan"), "plan")]] : [];
  const u = uni(s, ctx), name = u.name[s.lang]!;
  const actions = (draft: string): Button[][] => [[{ text: t(s, ctx, "btn.copy"), copy: draft }],
    [link(t(s, ctx, "btn.page", { uni: name }), u.contactUrl)], ...back];
  if (!item) {
    const draft = t(s, ctx, "help.generic.draft", { uni: name });
    return reply(s, ctx, t(s, ctx, "help.generic", { draft, uni: name, url: u.contactUrl }), actions(draft));
  }
  const who = t(s, ctx, "help.who", { citizenship: s.citizenship!, entry: s.entryDate! });
  const overdue = item.status === "overdue";
  const draft = t(s, ctx, overdue ? "help.draft.overdue" : "help.draft", { uni: name, who, title: item.title[s.lang]!, due: item.dueDate });
  return reply(s, ctx, t(s, ctx, overdue ? "help.intro.overdue" : "help.intro", { uni: name }) + draft +
    t(s, ctx, "help.contacts", { uni: name, url: u.contactUrl }), actions(draft));
}
function prompt(s: Session, ctx: DialogueContext): Reply {
  switch (s.step) {
    case "language": return reply(s, ctx, [...ctx.texts.keys()].map(l => format(ctx.texts, l, "language.choose")).join(" / "), languages(ctx));
    case "consent": return reply(s, ctx, t(s, ctx, "consent"),
      [[button(t(s, ctx, "btn.continue"), "accept")], ...languages(ctx, s.lang), [button(t(s, ctx, "btn.leave"), "delete")]]);
    case "scope": return reply(s, ctx, t(s, ctx, "scope", { uni: uni(s, ctx).name[s.lang]! }),
      [[button(t(s, ctx, "btn.yes"), "yes"), button(t(s, ctx, "btn.no"), "no")]]);
    case "citizenship": return reply(s, ctx, t(s, ctx, "citizenship"),
      [...rows(uni(s, ctx).citizenships, 4), ["BY", "OTHER"]].map(row => row.map(x => button(x, x))));
    case "entry": return reply(s, ctx, t(s, ctx, "entry"));
    case "completion": return reply(s, ctx, t(s, ctx, "completion"), [[button(t(s, ctx, "btn.cancel"), "plan")]]);
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
      return { session: previous, reply: reply(s, ctx, t(s, ctx, "expired")) };
    }
    if (!current) { s.step = "plan"; delete s.selected; }
  }
  s.revision++;
  if (action === "/delete" || action === "delete") { s.step = "delete"; return { session: s, reply: prompt(s, ctx) }; }
  if (s.step === "delete" && action === "confirm-delete") {
    return { session: null, reply: reply(s, ctx, t(s, ctx, "deleted")) };
  }
  if (s.step === "delete" && action === "cancel-delete") { s.step = profile(s) ? "plan" : "language"; }
  if (action === "/stop") { s.reminders = false; return { session: s, reply: reply(s, ctx, t(s, ctx, "stopped")) }; }
  if (s.ruleVersion !== ctx.version) {
    s.reminders = false;
    return { session: s, reply: reply(s, ctx, t(s, ctx, "rulesChanged")) };
  }
  const start = /^\/start(?:\s+(\S+))?$/.exec(action);
  if (start) {
    // A university's QR code opens max.ru/<bot>?start=<id>; the choice is fixed once the plan exists.
    const id = start[1]?.toLowerCase();
    if (id && !profile(s) && ctx.universities.some(u => u.id === id)) s.university = id;
    const lang = input.locale?.slice(0, 2).toLowerCase();
    if (s.step === "language" && lang && ctx.texts.has(lang)) { s.lang = lang; s.step = "consent"; }
    return { session: s, reply: prompt(s, ctx) };
  }
  if (action === "/help" || action === "help" || action === "no" || action === "OTHER" || action === "BY") return { session: s, reply: help(s, ctx) };
  if (action.startsWith("help:")) return { session: s, reply: help(s, ctx, action.slice(5)) };
  if (s.step === "language" && ctx.texts.has(action)) { s.lang = action; s.step = "consent"; }
  else if (s.step === "consent" && ctx.texts.has(action)) s.lang = action;
  else if (s.step === "consent" && action === "accept") s.step = "scope";
  else if (s.step === "scope" && action === "yes") s.step = "citizenship";
  else if (s.step === "citizenship" && uni(s, ctx).citizenships.includes(action)) { s.citizenship = action; s.step = "entry"; }
  else if (s.step === "entry") {
    if (!isValidDate(action) || action < "2026-09-01" || action > ctx.today) {
      return { session: s, reply: reply(s, ctx, t(s, ctx, "entry.invalid")) };
    }
    s.entryDate = action; s.step = "plan";
  } else if (profile(s) && (action === "plan" || action === "/plan")) { s.step = "plan"; delete s.selected; }
  else if (s.step === "completion") {
    const date = action === "/today" ? ctx.today : action;
    const last = s.selected ? s.completions[s.selected] : undefined;
    if (!s.selected || !isValidDate(date) || date > ctx.today || date < s.entryDate! || (last && compareDates(date, last) <= 0)) {
      return { session: s, reply: reply(s, ctx, t(s, ctx, "completion.invalid")) };
    }
    s.completions[s.selected] = date; s.step = "plan"; delete s.selected;
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
    } else if (action.startsWith("done:")) {
      const id = action.slice(5);
      if (plan(s, ctx).some(i => i.ruleId === id && i.status !== "done")) { s.selected = id; s.step = "completion"; }
    }
  }
  return { session: s, reply: prompt(s, ctx) };
}
export function reminderReply(s: Session, ctx: DialogueContext, item: PlanItem): Reply {
  return reply(s, ctx, t(s, ctx, item.status === "overdue" ? "reminder.overdue" : "reminder", { title: item.title[s.lang]!, due: item.dueDate, countdown: countdown(s, ctx, item) }),
    [[button(t(s, ctx, "btn.details"), `card:${item.ruleId}${FROM_REMINDER}`)], [button(t(s, ctx, "btn.planShort"), "plan")]]);
}
