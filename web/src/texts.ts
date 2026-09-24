/**
 * Chrome of the mini app: labels, button captions and error sentences.
 *
 * Everything with legal weight — procedure names, deadlines, the source of a rule, the wording of
 * a warning — comes from the server, which takes it from the reviewed rule data. Only the frame
 * around it lives here, as data keyed by language, so a third language is a new column and not a
 * new branch in a component. The bot is moving its texts to `src/data/i18n/` (PR #8); these keys
 * join that file once it lands.
 */

export type Lang = "ru" | "en";

const dictionary = {
  appTitle: { ru: "Первые 90 дней", en: "First 90 days" },
  loading: { ru: "Загружаем ваш план…", en: "Loading your plan…" },
  retry: { ru: "Повторить", en: "Try again" },
  back: { ru: "Назад", en: "Back" },

  demoBanner: {
    ru: "ДЕМО · учебные данные, нормы не утверждены юристом.",
    en: "DEMO · practice data, the rules are not legally approved.",
  },
  mockedBanner: {
    ru: "Запуск без подписи MAX: локальная отладка, не рабочий режим.",
    en: "Launched without a MAX signature: local debugging, not production.",
  },
  provisional: {
    ru: "Норма ещё не вычитана юристом — срок предварительный.",
    en: "The rule has not been reviewed by a lawyer yet — the date is provisional.",
  },

  errorNoLaunch: {
    ru: "Приложение открывается из бота в MAX. Откройте его кнопкой в чате.",
    en: "This app opens from the bot in MAX. Use the button in the chat.",
  },
  errorUnauthorized: {
    ru: "Данные запуска устарели. Закройте приложение и откройте его из чата заново.",
    en: "The launch data expired. Close the app and open it from the chat again.",
  },
  errorOffline: {
    ru: "Нет связи с сервером. Проверьте интернет и повторите.",
    en: "No connection to the server. Check the network and try again.",
  },
  errorServer: {
    ru: "Сервер не смог обработать действие. Ваши данные не изменились.",
    en: "The server could not process the action. Nothing was changed.",
  },
  errorConflict: {
    ru: "Данные изменились в другом окне — экран обновлён.",
    en: "The data changed in another window — the screen has been refreshed.",
  },

  startTitle: { ru: "План обязательных процедур", en: "Your mandatory procedures" },
  startBody: {
    ru: "Посчитаем ваши сроки после въезда и покажем, какие документы собрать.",
    en: "We calculate your deadlines after entry and list the documents to collect.",
  },
  start: { ru: "Начать", en: "Start" },

  language: { ru: "Язык", en: "Language" },
  consentTitle: { ru: "Согласие", en: "Consent" },
  consentAccept: { ru: "Продолжить", en: "Continue" },
  scopeTitle: { ru: "Проверим, подходит ли сценарий", en: "Let us check the scenario fits" },
  scopeYes: { ru: "Да, совпадает", en: "Yes, it matches" },
  scopeNo: { ru: "Нет / не уверен", en: "No / not sure" },
  citizenshipTitle: { ru: "Гражданство", en: "Citizenship" },
  citizenshipOther: { ru: "Другое", en: "Other" },
  entryTitle: { ru: "Дата въезда", en: "Entry date" },
  entryHint: { ru: "ГГГГ-ММ-ДД", en: "YYYY-MM-DD" },
  save: { ru: "Сохранить", en: "Save" },

  planTitle: { ru: "Ваш план", en: "Your plan" },
  planEmpty: { ru: "Процедур для вашего случая не нашлось.", en: "No procedures matched your case." },
  reminders: { ru: "Напоминания в чате", en: "Reminders in the chat" },
  calendar: { ru: "Добавить сроки в календарь", en: "Add the dates to my calendar" },
  documents: { ru: "Документы", en: "Documents" },
  markDone: { ru: "Процедура пройдена", en: "I completed it" },
  done: { ru: "Пройдено", en: "Completed" },
  overdue: { ru: "Срок прошёл", en: "Date passed" },
  dueSoon: { ru: "Скоро срок", en: "Due soon" },
  source: { ru: "Основание", en: "Legal basis" },
  openLaw: { ru: "Открыть норму", en: "Open the law" },
  checkedAt: { ru: "Сверка источника", en: "Source checked" },
  contactUniversity: { ru: "Написать в вуз", en: "Contact the university" },
  completionTitle: { ru: "Когда вы прошли процедуру?", en: "When did you complete it?" },
  completionToday: { ru: "Сегодня", en: "Today" },
  cancel: { ru: "Отмена", en: "Cancel" },
  deleteTitle: { ru: "Удалить мои данные", en: "Delete my data" },
  deleteConfirm: { ru: "Да, удалить", en: "Yes, delete" },
  deleted: { ru: "Данные удалены.", en: "Your data was deleted." },
  outOfScope: { ru: "Случай вне сценария", en: "Case outside the scenario" },
  outOfScopeBody: {
    ru: "Расчёт для вашего случая мы не делаем, чтобы не назвать неверный срок. Напишите в вуз — там подскажут следующий шаг.",
    en: "We do not calculate this case, so as not to name a wrong deadline. Contact your university for the next step.",
  },
  selfReported: {
    ru: "Отметки — с ваших слов, это не решение МВД.",
    en: "Marks are self-reported, not an official decision.",
  },
} as const;

export type TextKey = keyof typeof dictionary;

export const text = (lang: Lang, key: TextKey): string => dictionary[key][lang];

/** Plural forms the screens need; `Intl` knows the rules, so the app does not hardcode them. */
export function daysLeft(lang: Lang, n: number): string {
  const absolute = Math.abs(n);
  if (lang === "en") return n < 0 ? `${absolute} day${absolute === 1 ? "" : "s"} ago` : `${absolute} day${absolute === 1 ? "" : "s"} left`;
  const form = new Intl.PluralRules("ru").select(absolute);
  const word = form === "one" ? "день" : form === "few" ? "дня" : "дней";
  return n < 0 ? `просрочено на ${absolute} ${word}` : `осталось ${absolute} ${word}`;
}
