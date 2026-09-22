import { randomUUID } from "node:crypto";
import { buildPlan } from "../core/deadlines.js";
import { compareDates, isValidDate } from "../core/dates.js";
import type { Completions, DeadlineRule, Lang, PlanItem, UserProfile } from "../core/types.js";

export interface Button { text: string; action: string }
export interface Reply { text: string; buttons: Button[][]; ruleVersion: string }
export interface Session {
  nonce: string;
  revision: number;
  lang: Lang;
  step: "language" | "consent" | "scope" | "citizenship" | "entry" | "plan" | "completion" | "delete";
  citizenship?: string;
  entryDate?: string;
  selected?: string;
  completions: Completions;
  documents: Record<string, boolean>;
  reminders: boolean;
  ruleVersion: string;
}
export interface DialogueContext { rules: DeadlineRule[]; version: string; today: string; demo: boolean }
export interface Input { text: string; callback: boolean }
export interface Transition { session: Session | null; reply: Reply }
const CONTACT = "https://admissions.kpfu.ru/adaptacziya-inostrannyh-grazhdan/viza-i-migraczionnyj-uchyot/";
const t = (s: Session, ru: string, en: string) => s.lang === "ru" ? ru : en;
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
  return { text: banner + text, ruleVersion: ctx.version, buttons: rows.map(row => row.map(b => ({
    text: b.text, action: `${s.nonce}.${s.revision}|${b.action}`,
  }))) };
}
const button = (text: string, action: string): Button => ({ text, action });
function home(s: Session, ctx: DialogueContext, prefix = ""): Reply {
  const items = plan(s, ctx);
  const status = { done: t(s, "отмечено вами", "marked by you"), overdue: t(s, "расчётный срок прошёл", "calculated date passed"),
    dueSoon: t(s, "скоро", "due soon"), ok: t(s, "есть время", "upcoming") };
  const lines = items.map(i => `• ${i.title[s.lang]}: ${i.dueDate} — ${status[i.status]}`);
  return reply(s, ctx, prefix + t(s, "Ваш план подготовки\n", "Your preparation plan\n") + lines.join("\n") +
    t(s, "\n\nПокрыты только две процедуры. Миграционный учёт оформляется отдельно через вуз. Отметки — с ваших слов, не решение МВД.",
      "\n\nOnly two procedures are covered. Arrange migration registration separately with your university. Marks are self-reported, not an official decision.") +
    t(s, "\nНапоминания: ", "\nReminders: ") + (s.reminders ? t(s, "включены", "on") : t(s, "выключены", "off")),
    [...items.map(i => [button(i.title[s.lang], `card:${i.ruleId}`)]),
      [button(t(s, "Напоминания вкл/выкл", "Toggle reminders"), "reminders")],
      [button(t(s, "Не получилось / помощь", "I need help"), "help")],
      [button(t(s, "Удалить мои данные", "Delete my data"), "delete")]]);
}
function card(s: Session, ctx: DialogueContext, id: string): Reply {
  const item = plan(s, ctx).find(i => i.ruleId === id);
  if (!item) return home(s, ctx);
  const key = `${item.ruleId}:${item.dueDate}`;
  const docs = item.documents.map(d => `${s.documents[`${key}:${d.id}`] ? "✓" : "□"} ${d.title[s.lang]}`);
  const target = item.recommendedDate ? t(s, "\nРекомендуемая дата: ", "\nRecommended date: ") + item.recommendedDate : "";
  return reply(s, ctx, `${item.title[s.lang]}\n${item.action[s.lang]}\n` +
    t(s, "Расчётный предельный срок: ", "Calculated deadline: ") + item.dueDate + target +
    "\n\n" + docs.join("\n") + "\n\n" + item.legal.act + ", " + item.legal.article +
    "\n" + item.legal.url + t(s, "\nСверка источника: ", "\nSource checked: ") + item.legal.checkedAt +
    t(s, "\nМесто и комплект уточните у КФУ: ", "\nConfirm location and checklist with KFU: ") + CONTACT,
    [...item.documents.map(d => [button((s.documents[`${key}:${d.id}`] ? "✓ " : "□ ") + d.title[s.lang], `doc:${id}:${d.id}`)]),
      ...(item.status === "done" ? [] : [[button(t(s, "Процедура пройдена", "Completed the procedure"), `done:${id}`)]]),
      [button(t(s, "Не получилось", "I couldn't complete it"), "help"), button(t(s, "К плану", "Back to plan"), "plan")]]);
}
function prompt(s: Session, ctx: DialogueContext): Reply {
  switch (s.step) {
    case "language": return reply(s, ctx, "Выберите язык / Choose your language", [[button("Русский", "ru"), button("English", "en")]]);
    case "consent": return reply(s, ctx, t(s,
      "Бот хранит MAX ID, язык, даты и ваши отметки в локальной базе сервиса до удаления или 400 дней без действий. Паспорт и меддокументы не присылайте. /delete удаляет профиль и задания; технические отпечатки событий хранятся до 7 дней. Это помощь в подготовке, не юридическое заключение. Продолжить?",
      "The bot stores your MAX ID, language, dates and checkmarks in its database until deletion or 400 days of inactivity. Do not send passports or medical files. /delete removes your profile and queued jobs; event fingerprints expire within 7 days. This is preparation support, not legal advice. Continue?"),
      [[button(t(s, "Продолжить", "Continue"), "accept")], [button(t(s, "Удалить / выйти", "Delete / leave"), "delete")]]);
    case "scope": return reply(s, ctx, t(s,
      "Сценарий: вам 18+, первый въезд для учёбы более чем на 90 дней, общежитие КФУ, нет РВП/РВПО/ВНЖ и ранее пройденных процедур. Въезд с 01.09.2026. Всё совпадает? В демо отвечайте за учебного персонажа.",
      "Scope: age 18+, first entry for study longer than 90 days, KFU dormitory, no residence permit and no previously completed procedures. Entry from 2026-09-01. Does everything match? In demo, answer for a fictional student."),
      [[button(t(s, "Да, совпадает", "Yes"), "yes"), button(t(s, "Нет / не уверен", "No / unsure"), "no")]]);
    case "citizenship": return reply(s, ctx, t(s, "Выберите гражданство учебного профиля.", "Choose the profile's citizenship."),
      [["KZ", "UZ", "TJ", "KG"], ["CN", "IN", "EG", "TR"], ["BY", "OTHER"]].map(row => row.map(x => button(x, x))));
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
    const separator = action.indexOf("|");
    if (!previous || action.slice(0, separator) !== `${s.nonce}.${s.revision}`) {
      return { session: previous, reply: reply(s, ctx, t(s, "Кнопка устарела. Откройте /plan или /start.", "This button expired. Open /plan or /start.")) };
    }
    action = action.slice(separator + 1);
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
  if (action === "/start") return { session: s, reply: prompt(s, ctx) };
  if (action === "/help" || action === "help" || action === "no" || action === "OTHER" || action === "BY") {
    return { session: s, reply: reply(s, ctx, t(s,
      "Для неподдержанного случая расчёт не выполняем. Что мешает: нет документа, нет записи или непонятен следующий шаг? Подготовьте вопрос: «Я учусь в КФУ, нужна помощь с процедурой __. Сейчас препятствие __. Подскажите следующий шаг и комплект документов». Отправьте его сами в подразделение КФУ:\n",
      "We do not calculate unsupported cases. Is a document missing, is booking unavailable, or is the next step unclear? Draft: “I study at KFU and need help with __. My obstacle is __. Please explain the next step and required documents.” Send it yourself to the KFU office:\n") + CONTACT +
      t(s, "\n/start — продолжить; /delete — удалить данные.", "\n/start to continue; /delete to remove data.")) };
  }
  if (s.step === "language" && ["ru", "en"].includes(action)) { s.lang = action as Lang; s.step = "consent"; }
  else if (s.step === "consent" && action === "accept") s.step = "scope";
  else if (s.step === "scope" && action === "yes") s.step = "citizenship";
  else if (s.step === "citizenship" && ["KZ", "UZ", "TJ", "KG", "CN", "IN", "EG", "TR"].includes(action)) { s.citizenship = action; s.step = "entry"; }
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
    else if (action.startsWith("card:")) return { session: s, reply: card(s, ctx, action.slice(5)) };
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
  return reply(s, ctx, t(s, "Напоминание: ", "Reminder: ") + item.title[s.lang] + " — " + item.dueDate,
    [[button(t(s, "Подробнее", "Details"), `card:${item.ruleId}`)], [button(t(s, "К плану", "Plan"), "plan")]]);
}
