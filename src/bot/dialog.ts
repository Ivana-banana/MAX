import { randomUUID } from "node:crypto";
import { buildPlan } from "../core/deadlines.js";
import { compareDates, isValidDate } from "../core/dates.js";
import type { Completions, DeadlineRule, Lang, PlanItem, UserProfile } from "../core/types.js";
import type { University } from "../data/loadUniversities.js";
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
export interface DialogueContext { rules: DeadlineRule[]; universities: University[]; version: string; today: string; demo: boolean }
// locale comes only with bot_started (MAX client language); a ?start= payload arrives as "/start <payload>"
export interface Input { text: string; callback: boolean; locale?: string }
export interface Transition { session: Session | null; reply: Reply }
const t = (s: Session, ru: string, en: string) => s.lang === "ru" ? ru : en;
// Sessions created before university profiles existed have no id and fall back to the default one.
const uni = (s: Session, ctx: DialogueContext) => ctx.universities.find(u => u.id === s.university) ?? ctx.universities[0]!;
function days(s: Session, n: number): string {
  if (s.lang === "en") return `${n} day${n === 1 ? "" : "s"}`;
  const d = n % 10, h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? "день" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "дня" : "дней"}`;
}
function countdown(s: Session, item: PlanItem): string {
  if (item.status === "done") return t(s, "отмечено вами", "marked by you");
  if (item.daysLeft < 0) return t(s, `расчётный срок прошёл ${days(s, -item.daysLeft)} назад`, `calculated date passed ${days(s, -item.daysLeft)} ago`);
  if (item.daysLeft === 0) return t(s, "сегодня последний день", "last day today");
  const left = days(s, item.daysLeft);
  return (item.status === "dueSoon" ? t(s, "скоро", "due soon") : t(s, "есть время", "upcoming")) + ", " +
    t(s, (left.endsWith(" день") ? "остался " : "осталось ") + left, left + " left");
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
  const banner = ctx.demo ? t(s, "ДЕМО · учебные данные, нормы не утверждены.\n", "DEMO · practice data, rules not approved.\n") : "";
  return { text: banner + text, ruleVersion: ctx.version, buttons: rows.map(row => row.map(b => "action" in b ? {
    text: b.text, action: `${s.nonce}.${s.revision}|${b.action}`,
  } : b)) };
}
const button = (text: string, action: string): Button => ({ text, action });
/** Suffix of the reminder's "Details" button: tells a return from a reminder apart from a card opened in the plan (funnel.ts). */
export const FROM_REMINDER = ":reminder";
const rows = <T>(list: T[], size: number): T[][] => list.flatMap((_, i) => i % size ? [] : [list.slice(i, i + size)]);
const link = (text: string, url: string): Button => ({ text, url });
// Read-only screens: a stale button to them (e.g. in a reminder sent days ago) is still safe to follow.
const navigation = (action: string) => action === "plan" || action === "help" || action === "calendar" ||
  action.startsWith("card:") || action.startsWith("help:");
function home(s: Session, ctx: DialogueContext, prefix = ""): Reply {
  const items = plan(s, ctx);
  const lines = items.map(i => `• ${i.title[s.lang]}: ${i.dueDate} — ${countdown(s, i)}`);
  return reply(s, ctx, prefix + t(s, "Ваш план подготовки\n", "Your preparation plan\n") + lines.join("\n") +
    t(s, "\n\nПокрыты только две процедуры. Миграционный учёт оформляется отдельно через вуз. Отметки — с ваших слов, не решение МВД.",
      "\n\nOnly two procedures are covered. Arrange migration registration separately with your university. Marks are self-reported, not an official decision.") +
    t(s, "\nНапоминания: ", "\nReminders: ") + (s.reminders ? t(s, "включены", "on") : t(s, "выключены", "off")),
    [...items.map(i => [button(i.title[s.lang], `card:${i.ruleId}`)]),
      [button(t(s, "Напоминания вкл/выкл", "Toggle reminders"), "reminders")],
      ...(items.some(i => i.status !== "done") ? [[button(t(s, "📅 Добавить сроки в календарь", "📅 Add dates to calendar"), "calendar")]] : []),
      [button(t(s, "Не получилось / помощь", "I need help"), "help")],
      [button(t(s, "Удалить мои данные", "Delete my data"), "delete")]]);
}
function card(s: Session, ctx: DialogueContext, id: string): Reply {
  const item = plan(s, ctx).find(i => i.ruleId === id);
  if (!item) return home(s, ctx);
  const key = `${item.ruleId}:${item.dueDate}`;
  const docs = item.documents.map(d => `${s.documents[`${key}:${d.id}`] ? "✓" : "□"} ${d.title[s.lang]}`);
  const target = item.recommendedDate ? t(s, "\nРекомендуемая дата: ", "\nRecommended date: ") + item.recommendedDate : "";
  const u = uni(s, ctx), overdue = item.status === "overdue";
  // No consequences or fines here: the law text on liability is not reviewed (docs/legal-review.md).
  const late = overdue ? t(s,
    `\n\nРасчётный срок прошёл. Процедуру всё равно нужно пройти — не откладывайте. Последствия пропуска бот не оценивает: напишите в ${u.name.ru}, как поступить, — готовый вопрос по кнопке ниже.`,
    `\n\nThe calculated date has passed. You still need to complete the procedure — do not put it off. The bot does not assess the consequences: ask ${u.name.en} what to do — a ready question is behind the button below.`) : "";
  return reply(s, ctx, `${item.title[s.lang]}\n${item.action[s.lang]}\n` +
    t(s, "Расчётный предельный срок: ", "Calculated deadline: ") + item.dueDate +
    (item.status === "done" ? "" : ` (${countdown(s, item)})`) + target + late +
    "\n\n" + docs.join("\n") + "\n\n" + item.legal.act + ", " + item.legal.article +
    "\n" + item.legal.url + t(s, "\nСверка источника: ", "\nSource checked: ") + item.legal.checkedAt +
    t(s, `\nМесто и комплект уточните у ${u.name.ru}: `, `\nConfirm location and checklist with ${u.name.en}: `) + u.contactUrl,
    [...item.documents.map(d => [button((s.documents[`${key}:${d.id}`] ? "✓ " : "□ ") + d.title[s.lang], `doc:${id}:${d.id}`)]),
      ...(item.status === "done" ? [] : [[button(t(s, "Процедура пройдена", "Completed the procedure"), `done:${id}`)]]),
      [link(t(s, "Открыть норму", "Open the law"), item.legal.url)],
      [button(overdue ? t(s, "Срок прошёл — что делать", "Date passed — what now") : t(s, "Не получилось", "I couldn't complete it"), `help:${id}`),
        button(t(s, "К плану", "Back to plan"), "plan")]]);
}
function calendar(s: Session, ctx: DialogueContext): Reply {
  const items = plan(s, ctx).filter(i => i.status !== "done");
  if (!items.length) return home(s, ctx);
  return { ...reply(s, ctx, t(s,
    "Файл с вашими сроками: откройте его, и события появятся в календаре телефона. Календарь напомнит за 7, 3 и 1 день в 09:00 МСК — даже если уведомления бота выключены. Это расчётные даты, не решение МВД. Изменили отметки — выгрузите файл заново: события обновятся, а не задвоятся.",
    "Your dates as a file: open it to add the events to your phone calendar. The calendar will remind you 7, 3 and 1 day before at 09:00 Moscow time, even with bot notifications off. These are calculated dates, not an official decision. After changing your marks, export again: events update instead of duplicating."),
    [[button(t(s, "К плану", "Back to plan"), "plan")]]),
    file: { name: CALENDAR_FILE, content: planToIcs(items, { lang: s.lang, demo: ctx.demo, uid: s.nonce, today: ctx.today }) } };
}
function help(s: Session, ctx: DialogueContext, ruleId?: string): Reply {
  const item = ruleId ? plan(s, ctx).find(i => i.ruleId === ruleId) : undefined;
  const back = profile(s) ? [[button(t(s, "К плану", "Back to plan"), "plan")]] : [];
  const u = uni(s, ctx);
  const actions = (draft: string): Button[][] => [[{ text: t(s, "Скопировать вопрос", "Copy the question"), copy: draft }],
    [link(t(s, `Открыть страницу ${u.name.ru}`, `Open the ${u.name.en} page`), u.contactUrl)], ...back];
  if (!item) {
    const draft = t(s, `Я учусь в ${u.name.ru}, нужна помощь с процедурой __. Сейчас препятствие __. Подскажите следующий шаг и комплект документов.`,
      `I study at ${u.name.en} and need help with __. My obstacle is __. Please explain the next step and required documents.`);
    return reply(s, ctx, t(s,
      "Для неподдержанного случая расчёт не выполняем. Что мешает: нет документа, нет записи или непонятен следующий шаг? Подготовьте вопрос: «" + draft + `» Отправьте его сами в подразделение ${u.name.ru}:\n`,
      "We do not calculate unsupported cases. Is a document missing, is booking unavailable, or is the next step unclear? Draft: “" + draft + `” Send it yourself to the ${u.name.en} office:\n`) + u.contactUrl +
      t(s, "\n/start — продолжить; /delete — удалить данные.", "\n/start to continue; /delete to remove data."), actions(draft));
  }
  const who = t(s, `гражданство ${s.citizenship}, въезд ${s.entryDate}`, `citizenship ${s.citizenship}, entry ${s.entryDate}`);
  const overdue = item.status === "overdue";
  const draft = overdue ? t(s,
    `Здравствуйте! Я иностранный студент ${u.name.ru} (${who}). Мне нужно пройти процедуру «${item.title.ru}», расчётный срок был до ${item.dueDate} и уже прошёл. Причина: ___. Подскажите, пожалуйста, как пройти процедуру сейчас и какие документы нужны.`,
    `Hello! I am an international ${u.name.en} student (${who}). I need to complete “${item.title.en}”; the calculated deadline was ${item.dueDate} and has passed. The reason: ___. Could you tell me how to complete it now and which documents I need?`) : t(s,
    `Здравствуйте! Я иностранный студент ${u.name.ru} (${who}). Мне нужно пройти процедуру «${item.title.ru}», расчётный срок — до ${item.dueDate}. Не получается: ___. Подскажите, пожалуйста, следующий шаг и комплект документов.`,
    `Hello! I am an international ${u.name.en} student (${who}). I need to complete “${item.title.en}”, calculated deadline ${item.dueDate}. The problem: ___. Could you tell me the next step and the documents I need?`);
  return reply(s, ctx, (overdue ? t(s,
    `Расчётный срок прошёл. Не откладывайте: сообщите в ${u.name.ru} и спросите, как пройти процедуру сейчас. Бот не оценивает последствия пропуска и не заменяет консультацию. Готовый вопрос — скопируйте кнопкой, впишите вместо ___ причину и отправьте сами:\n\n`,
    `The calculated date has passed. Do not put it off: tell ${u.name.en} and ask how to complete the procedure now. The bot does not assess the consequences and is not legal advice. A ready question: copy it, replace ___ with the reason and send it yourself:\n\n`) : t(s,
    `Что мешает: нет документа, нет записи или непонятен следующий шаг? Готовый вопрос для ${u.name.ru} — скопируйте кнопкой, впишите вместо ___ своё препятствие и отправьте сами:\n\n`,
    `What is in the way: a missing document, no booking, or an unclear next step? Here is a ready question for ${u.name.en}: copy it, replace ___ with your obstacle and send it yourself:\n\n`)) + draft +
    t(s, `\n\nКонтакты ${u.name.ru}: `, `\n\n${u.name.en} contacts: `) + u.contactUrl,
    actions(draft));
}
function prompt(s: Session, ctx: DialogueContext): Reply {
  switch (s.step) {
    case "language": return reply(s, ctx, "Выберите язык / Choose your language", [[button("Русский", "ru"), button("English", "en")]]);
    case "consent": return reply(s, ctx, t(s,
      "Бот хранит MAX ID, язык, даты и ваши отметки в локальной базе сервиса до удаления или 400 дней без действий. Для оценки пользы считаются только суммы действий по дням, без MAX ID. Паспорт и меддокументы не присылайте. /delete удаляет профиль и задания; технические отпечатки событий хранятся до 7 дней. Это помощь в подготовке, не юридическое заключение. Продолжить?",
      "The bot stores your MAX ID, language, dates and checkmarks in its database until deletion or 400 days of inactivity. To measure usefulness it only counts daily totals of actions, without your MAX ID. Do not send passports or medical files. /delete removes your profile and queued jobs; event fingerprints expire within 7 days. This is preparation support, not legal advice. Continue?"),
      [[button(t(s, "Продолжить", "Continue"), "accept")], [button(t(s, "English", "Русский"), t(s, "en", "ru"))],
        [button(t(s, "Удалить / выйти", "Delete / leave"), "delete")]]);
    case "scope": return reply(s, ctx, t(s,
      `Сценарий: вам 18+, первый въезд для учёбы более чем на 90 дней, общежитие ${uni(s, ctx).name.ru}, нет РВП/РВПО/ВНЖ и ранее пройденных процедур. Въезд с 01.09.2026. Всё совпадает? В демо отвечайте за учебного персонажа.`,
      `Scope: age 18+, first entry for study longer than 90 days, ${uni(s, ctx).name.en} dormitory, no residence permit and no previously completed procedures. Entry from 2026-09-01. Does everything match? In demo, answer for a fictional student.`),
      [[button(t(s, "Да, совпадает", "Yes"), "yes"), button(t(s, "Нет / не уверен", "No / unsure"), "no")]]);
    case "citizenship": return reply(s, ctx, t(s, "Выберите гражданство учебного профиля.", "Choose the profile's citizenship."),
      [...rows(uni(s, ctx).citizenships, 4), ["BY", "OTHER"]].map(row => row.map(x => button(x, x))));
    case "entry": return reply(s, ctx, t(s, "Дата въезда в формате ГГГГ-ММ-ДД (с 2026-09-01 по сегодня).", "Entry date YYYY-MM-DD (from 2026-09-01 through today)."));
    case "completion": return reply(s, ctx, t(s,
      "Введите фактическую дату прохождения ГГГГ-ММ-ДД или /today. Это самоотметка, не подтверждение МВД.",
      "Enter the actual completion date YYYY-MM-DD or /today. This is self-reported, not confirmation from the authorities."),
      [[button(t(s, "Отмена", "Cancel"), "plan")]]);
    case "delete": return reply(s, ctx, t(s, "Удалить профиль, отметки и все ожидающие сообщения?", "Delete your profile, checkmarks and all pending messages?"),
      [[button(t(s, "Да, удалить", "Yes, delete"), "confirm-delete"), button(t(s, "Отмена", "Cancel"), "cancel-delete")]]);
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
      return { session: previous, reply: reply(s, ctx, t(s, "Кнопка устарела. Откройте /plan или /start.", "This button expired. Open /plan or /start.")) };
    }
    if (!current) { s.step = "plan"; delete s.selected; }
  }
  s.revision++;
  if (action === "/delete" || action === "delete") { s.step = "delete"; return { session: s, reply: prompt(s, ctx) }; }
  if (s.step === "delete" && action === "confirm-delete") {
    return { session: null, reply: reply(s, ctx, t(s, "Данные и ожидающие сообщения удалены. /start — начать заново.", "Your data and pending messages were deleted. /start to begin again.")) };
  }
  if (s.step === "delete" && action === "cancel-delete") { s.step = profile(s) ? "plan" : "language"; }
  if (action === "/stop") { s.reminders = false; return { session: s, reply: reply(s, ctx, t(s, "Напоминания выключены. /plan — вернуться.", "Reminders are off. /plan to return.")) }; }
  if (s.ruleVersion !== ctx.version) {
    s.reminders = false;
    return { session: s, reply: reply(s, ctx, t(s, "Правила изменились. Расчёт остановлен. Удалите старый профиль через /delete и начните снова.", "Rules changed. Calculations are paused. Use /delete and start again.")) };
  }
  const start = /^\/start(?:\s+(\S+))?$/.exec(action);
  if (start) {
    // A university's QR code opens max.ru/<bot>?start=<id>; the choice is fixed once the plan exists.
    const id = start[1]?.toLowerCase();
    if (id && !profile(s) && ctx.universities.some(u => u.id === id)) s.university = id;
    const lang = input.locale?.slice(0, 2).toLowerCase();
    if (s.step === "language" && (lang === "ru" || lang === "en")) { s.lang = lang; s.step = "consent"; }
    return { session: s, reply: prompt(s, ctx) };
  }
  if (action === "/help" || action === "help" || action === "no" || action === "OTHER" || action === "BY") return { session: s, reply: help(s, ctx) };
  if (action.startsWith("help:")) return { session: s, reply: help(s, ctx, action.slice(5)) };
  if (s.step === "language" && ["ru", "en"].includes(action)) { s.lang = action as Lang; s.step = "consent"; }
  else if (s.step === "consent" && ["ru", "en"].includes(action)) s.lang = action as Lang;
  else if (s.step === "consent" && action === "accept") s.step = "scope";
  else if (s.step === "scope" && action === "yes") s.step = "citizenship";
  else if (s.step === "citizenship" && uni(s, ctx).citizenships.includes(action)) { s.citizenship = action; s.step = "entry"; }
  else if (s.step === "entry") {
    if (!isValidDate(action) || action < "2026-09-01" || action > ctx.today) {
      return { session: s, reply: reply(s, ctx, t(s, "Дата вне сценария или неверный формат. Введите ГГГГ-ММ-ДД с 2026-09-01 по сегодня; /help — помощь.", "Invalid or unsupported date. Enter YYYY-MM-DD from 2026-09-01 through today; /help for support.")) };
    }
    s.entryDate = action; s.step = "plan";
  } else if (profile(s) && (action === "plan" || action === "/plan")) { s.step = "plan"; delete s.selected; }
  else if (s.step === "completion") {
    const date = action === "/today" ? ctx.today : action;
    const last = s.selected ? s.completions[s.selected] : undefined;
    if (!s.selected || !isValidDate(date) || date > ctx.today || date < s.entryDate! || (last && compareDates(date, last) <= 0)) {
      return { session: s, reply: reply(s, ctx, t(s, "Нужна дата между въездом и сегодня, позже предыдущей отметки. /plan — отмена.", "Use a date between entry and today, later than the previous completion. /plan to cancel.")) };
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
  return reply(s, ctx, t(s, "Напоминание: ", "Reminder: ") + item.title[s.lang] + " — " + item.dueDate + ` (${countdown(s, item)})`,
    [[button(t(s, "Подробнее", "Details"), `card:${item.ruleId}${FROM_REMINDER}`)], [button(t(s, "К плану", "Plan"), "plan")]]);
}
