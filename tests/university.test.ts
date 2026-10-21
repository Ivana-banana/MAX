import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { checkCitizenships, parseUniversity, readUniversities } from "../src/data/loadUniversities.js";
import { checkTranslated, readTexts } from "../src/data/loadTexts.js";
import { reminderReply, transition, plan, type DialogueContext, type Input, type Session } from "../src/bot/dialog.js";
import { parseUpdate } from "../src/bot/service.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const ctx: DialogueContext = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

function step(s: Session | null, input: Input, c = ctx) { return transition(s, input, c); }
function click(s: Session, action: string, c = ctx) { return step(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, c); }
function onboard(start = "/start", c = ctx, lang = "ru"): Session {
  let r = step(null, { text: start, callback: false }, c);
  for (const a of [lang, "accept", "yes", "KZ"]) r = click(r.session!, a, c);
  return step(r.session, { text: "2026-09-01", callback: false }, c).session!;
}
const buttons = (r: { reply: { buttons: unknown[][] } }) => r.reply.buttons.flat() as Record<string, string>[];
const copied = (r: { reply: { buttons: unknown[][] } }) => buttons(r).find(b => "copy" in b)!.copy!;

describe("university profiles are data", () => {
  it("loads every profile with the default one first", () => {
    expect(universities[0]!.id).toBe("kfu");
    expect(universities.map(u => u.id)).toEqual(expect.arrayContaining(["kfu", "itmo", "spbgeu"]));
    expect(readUniversities("src/data/universities", "itmo")[0]!.id).toBe("itmo");
  });
  it("rejects a profile that would break the dialogue or leak an unsafe link", () => {
    const good = { id: "demo-u", name: { ru: "ДУ", en: "DU" }, contactUrl: "https://example.org", citizenships: ["KZ"], checkedAt: "2026-09-23" };
    expect(parseUniversity(good).id).toBe("demo-u");
    for (const bad of [{ ...good, id: "Demo U" }, { ...good, contactUrl: "http://example.org" },
      { ...good, citizenships: [] }, { ...good, name: { en: "DU" } }, { ...good, checkedAt: "2026-02-30" }]) {
      expect(() => parseUniversity(bad)).toThrow(/Профиль вуза невалиден/);
    }
    expect(() => readUniversities("src/data/universities", "missing")).toThrow(/нет профиля по умолчанию/);
    // Citizenships the rules exclude (BY) cannot be offered as covered.
    expect(() => checkCitizenships([parseUniversity({ ...good, citizenships: ["KZ", "BY"] })], ["BY"])).toThrow(/BY исключены нормами/);
    // Other languages are checked against the interface languages at startup.
    expect(() => checkTranslated(texts, [], [parseUniversity({ ...good, name: { ru: "ДУ" } })])).toThrow(/нет перевода для demo-u.name/);
  });
  it("adds a university with one JSON file and no code changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "universities-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    copyFileSync("src/data/universities/kfu.json", join(dir, "kfu.json"));
    writeFileSync(join(dir, "kgmu.json"), JSON.stringify({ id: "kgmu", name: { ru: "КГМУ", en: "KSMU" },
      contactUrl: "https://example.org/kgmu", citizenships: ["IN", "EG"], checkedAt: "2026-09-23" }));
    const c = { ...ctx, universities: readUniversities(dir, "kfu") };
    let r = step(null, { text: "/start kgmu", callback: false }, c);
    for (const a of ["ru", "accept"]) r = click(r.session!, a, c);
    expect(r.reply.text).toContain("общежитие КГМУ");
    r = click(r.session!, "yes", c);
    expect(buttons(r).map(b => b.text)).toEqual(["Индия", "Египет", "Беларусь", "Другое"]);
    expect(buttons(r).map(b => b.action!.split("|")[1])).toEqual(["IN", "EG", "BY", "OTHER"]);
    r = click(step(click(r.session!, "IN", c).session, { text: "2026-09-01", callback: false }, c).session!, "help:medical-examination", c);
    expect(copied(r)).toContain("студент КГМУ");
    expect(buttons(r).some(b => b.url === "https://example.org/kgmu")).toBe(true);
  });
});

describe("deep link ?start= and client language", () => {
  const started = (extra: Record<string, unknown>) => parseUpdate({ update_type: "bot_started", timestamp: 1, chat_id: 5, user: { user_id: 7 }, ...extra })!;
  it("turns the bot_started payload and locale into input", () => {
    expect(started({ payload: "itmo", user_locale: "en" }).input).toEqual({ text: "/start itmo", callback: false, locale: "en" });
    expect(started({ payload: null }).input).toEqual({ text: "/start", callback: false });
    expect(started({ payload: "bad payload" }).input.text).toBe("/start");
    expect(started({ payload: "x".repeat(129) }).input.text).toBe("/start");
  });
  it("opens the scenario of the university from the QR code", () => {
    const s = onboard("/start itmo");
    expect(s.university).toBe("itmo");
    const card = click(s, "card:medical-examination");
    expect(card.reply.text).toContain("уточните у ИТМО: https://int.itmo.ru/ru/important_documents");
    const help = click(card.session!, "help:medical-examination");
    expect(copied(help)).toContain("иностранный студент ИТМО");
    expect(buttons(help).find(b => "url" in b)).toEqual({ text: "Открыть страницу ИТМО", url: "https://int.itmo.ru/ru/important_documents" });
  });
  it("falls back to the default university for unknown links and keeps the choice once the plan exists", () => {
    const s = onboard("/start unknown");
    expect(s.university).toBeUndefined();
    expect(click(s, "card:fingerprinting").reply.text).toContain("kpfu.ru/international/migracionnoe-soprovozhdenie-inostrannyh-grazhdan");
    expect(step(s, { text: "/start itmo", callback: false }).session!.university).toBeUndefined();
  });
  it("skips the language question when MAX reports ru or en, and still lets the user switch", () => {
    const r = step(null, { text: "/start", callback: false, locale: "en" });
    expect(r.session!.step).toBe("consent");
    expect(r.reply.text).toContain("The bot stores your MAX ID");
    const switched = click(r.session!, "ru");
    expect(switched.session!.lang).toBe("ru");
    expect(switched.reply.text).toContain("Бот хранит MAX ID");
    expect(step(null, { text: "/start", callback: false, locale: "de" }).session!.step).toBe("language");
  });
});

describe("days left and a missed date", () => {
  const s = onboard();
  const home = (today: string, lang = s) => step(lang, { text: "/plan", callback: false }, { ...ctx, today }).reply.text;
  it("shows how many days are left, with Russian plural forms", () => {
    expect(home("2026-09-24")).toContain("Медицинское освидетельствование: 30 сентября 2026 г. — скоро, осталось 6 дней");
    expect(home("2026-09-24")).toContain("29 ноября 2026 г. — есть время, осталось 66 дней");
    expect(home("2026-09-29")).toContain("остался 1 день");
    expect(home("2026-09-28")).toContain("осталось 2 дня");
    expect(home("2026-09-30")).toContain("30 сентября 2026 г. — сегодня последний день");
    expect(home("2026-11-18")).toContain("осталось 11 дней");
    expect(home("2026-11-08")).toContain("остался 21 день");
    expect(home("2026-09-24", onboard("/start", ctx, "en"))).toContain("due soon, 6 days left");
  });
  it("adds the countdown to the card and to the reminder", () => {
    expect(click(s, "card:medical-examination").reply.text).toContain("Расчётный предельный срок: 30 сентября 2026 г. (скоро, осталось 6 дней)");
    const c = { ...ctx, today: "2026-09-23" };
    const item = plan(s, c).find(i => i.ruleId === "medical-examination")!;
    expect(reminderReply(s, c, item).text).toContain("Напоминание: Медицинское освидетельствование — 30 сентября 2026 г. (скоро, осталось 7 дней)");
  });
  it("after the date: says so, points to the university and prepares a question, without legal consequences", () => {
    const c = { ...ctx, today: "2026-10-02" };
    expect(home("2026-10-02")).toContain("30 сентября 2026 г. — расчётный срок прошёл 2 дня назад");
    const card = click(s, "card:medical-examination", c);
    expect(card.reply.text).toContain("Расчётный срок прошёл. Процедуру всё равно нужно пройти");
    expect(buttons(card).find(b => b.action?.endsWith("|help:medical-examination"))!.text).toBe("Срок прошёл — что делать");
    const help = click(card.session!, "help:medical-examination", c);
    expect(help.reply.text).toContain("Бот не оценивает последствия пропуска");
    expect(copied(help)).toContain("расчётный срок был до 30 сентября 2026 г. и уже прошёл");
    expect(help.reply.text + card.reply.text).not.toMatch(/штраф|выдвор/i);
    expect(click(s, "card:fingerprinting", c).reply.text).not.toContain("Расчётный срок прошёл");
  });
});

describe("a student who has not entered yet (#25)", () => {
  function toEntry(start: string, citizenship: string): Session {
    let r = step(null, { text: start, callback: false });
    for (const a of ["ru", "accept", "yes", citizenship]) r = click(r.session!, a);
    return r.session!;
  }
  it("sees what the university asks to prepare, marked as a university fact or an assumption, and can still enter the date", () => {
    const s = toEntry("/start kfu", "KZ");
    expect(s.step).toBe("entry");
    const r = click(s, "before-entry");
    expect(r.session!.step).toBe("entry");
    expect(r.reply.text).toContain("«Госуслуги RuID»");
    expect(r.reply.text).toContain("Нотариальный перевод паспорта");
    // A card for visa countries is not shown to a citizen of Kazakhstan.
    expect(r.reply.text).not.toContain("Приглашение на учебную визу");
    expect(r.reply.text).toContain("Факт вуза — страница КФУ: https://kpfu.ru/international/dokumenty/shablony-perevodov");
    expect(r.reply.text).toContain("Допущение бота: ваше гражданство отнесено к безвизовым странам");
    const planned = step(r.session, { text: "2026-09-01", callback: false });
    expect(planned.session!.step).toBe("plan");
    expect(plan(planned.session!, ctx).length).toBeGreaterThan(0);
  });
  it("tells a citizen of a country with suspended invitations so, instead of how to get one (KFU page)", () => {
    const r = click(toEntry("/start kfu", "EG"), "before-entry");
    expect(r.reply.text).toContain("оформление приглашений для граждан Египта временно приостановлено");
    expect(r.reply.text).not.toContain("не менее 45 календарных дней");
  });
  it("keeps the demo example working after the cards: the reply with the cards carries the step's button again", () => {
    const r = click(toEntry("/start kfu", "KZ"), "before-entry");
    const example = buttons(r).find(b => b.action?.endsWith("|example"));
    expect(example).toBeDefined();
    const planned = step(r.session, { text: example!.action!, callback: true });
    expect(planned.expired).toBeUndefined();
    expect(planned.session!.step).toBe("plan");
  });
  it("keeps the step's buttons working after a wrong entry date (#67)", () => {
    const wrong = step(toEntry("/start kfu", "KZ"), { text: "15.11.2026", callback: false });
    expect(buttons(wrong).map(b => b.action?.split("|")[1])).toEqual(["before-entry", "example", "back"]);
    const before = buttons(wrong).find(b => b.action?.endsWith("|before-entry"))!;
    const r = step(wrong.session, { text: before.action!, callback: true });
    expect(r.expired).toBeUndefined();
    expect(r.reply.text).toContain("«Госуслуги RuID»");
  });
  it("says a future entry date is not counted yet and points to the branch (#67)", () => {
    const r = step(toEntry("/start kfu", "KZ"), { text: "15.11.2026", callback: false });
    expect(r.reply.text).toContain("Дата въезда не может быть в будущем");
    expect(r.reply.text).toContain("Ещё не въехали");
  });
  it("says a date before the period is outside the scenario (#67)", () => {
    const r = step(toEntry("/start kfu", "KZ"), { text: "31.08.2026", callback: false });
    expect(r.reply.text).toContain("раньше 1 сентября 2026 г.");
  });
  it("says a date it cannot read has a wrong format (#67)", () => {
    for (const text of ["30.02.2026", "вчера", "03.09.26"]) {
      expect(step(toEntry("/start kfu", "KZ"), { text, callback: false }).reply.text).toContain("Не удалось прочитать дату");
    }
  });
  it("does not offer the branch when the profile has no cards for the student", () => {
    const c = { ...ctx, universities: universities.map(u => ({ ...u, beforeEntry: [] })) };
    let r = step(null, { text: "/start kfu", callback: false }, c);
    for (const a of ["ru", "accept", "yes", "KZ"]) r = click(r.session!, a, c);
    expect(buttons(r).map(b => b.action?.split("|")[1])).not.toContain("before-entry");
  });
  it("offers the branch to every listed citizenship, as the scope question promises (#62)", () => {
    for (const u of universities) for (const c of u.citizenships) {
      let r = step(null, { text: `/start ${u.id}`, callback: false });
      for (const a of ["ru", "accept", "yes", c]) r = click(r.session!, a);
      expect(buttons(r).map(b => b.action?.split("|")[1]), `${u.id} ${c}`).toContain("before-entry");
    }
  });
});
