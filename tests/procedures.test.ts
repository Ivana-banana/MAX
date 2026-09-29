import { describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { checkProcedures, parseUniversity, readUniversities } from "../src/data/loadUniversities.js";
import { planToIcs } from "../src/bot/calendar.js";
import { plan, transition, undated, type Reply, type Session } from "../src/bot/dialog.js";
import { reminderDates } from "../src/core/deadlines.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };

/** Onboards through the chat as a student would; `start` picks the university like a QR code. */
function onboard(citizenship: string, start = "/start") {
  let s: Session = transition(null, { text: start, callback: false }, ctx).session!;
  const click = (action: string): Reply => {
    const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);
    s = r.session!; return r.reply;
  };
  for (const a of ["ru", "accept", "yes", citizenship]) click(a);
  const home = transition(s, { text: "2026-09-01", callback: false }, ctx);
  s = home.session!;
  return { home: home.reply, click, get session() { return s; } };
}
const actions = (r: Reply) => r.buttons.flat().flatMap(b => "action" in b ? [b.action.split("|")[1]!] : []);

describe("university procedures without a calculated deadline", () => {
  it("lists KFU migration registration apart from the dated plan, with its own card", () => {
    const f = onboard("KZ");
    expect(f.home.text).toContain("Без расчётного срока");
    expect(f.home.text).toContain("• Миграционный учёт (регистрация)");
    expect(f.home.text).toContain("Сроки рассчитаны только для двух процедур");
    expect(actions(f.home)).toContain("card:migration-registration");
    const card = f.click("card:migration-registration");
    expect(card.text).toContain("Когда: В течение следующего рабочего дня после заселения в общежитие");
    expect(card.text).toContain("ул. Гвардейская, 9");
    expect(card.text).toContain("kpfu.ru/international/migracionnoe-soprovozhdenie-inostrannyh-grazhdan/bezvizovyi-vjezd");
    expect(card.text).toContain("Это правило вуза, а не расчёт бота");
    expect(card.text).not.toContain("Виза");
    const checked = f.click("doc:migration-registration:passport");
    expect(f.session.documents["migration-registration:passport"]).toBe(true);
    expect(checked.text).toContain("✓ Паспорт (оригинал)");
    f.click("doc:migration-registration:passport");
    expect(f.session.documents["migration-registration:passport"]).toBe(false);
  });
  it("gives visa countries the visa-entry variant from its own page", () => {
    const f = onboard("CN");
    expect(actions(f.home)).toContain("card:migration-registration-visa");
    expect(actions(f.home)).not.toContain("card:migration-registration");
    const card = f.click("card:migration-registration-visa");
    expect(card.text).toContain("Виза (оригинал) — если въезжали по визе");
    expect(card.text).toContain("vizovyi-vjezd");
  });
  it("shows nothing for a university whose profile has no such procedures", () => {
    const f = onboard("IN", "/start itmo");
    expect(f.home.text).not.toContain("Без расчётного срока");
    expect(undated(f.session, ctx)).toEqual([]);
    expect(f.click("card:migration-registration").text).toContain("Ваш план подготовки");
  });
  it("never turns the procedure into a reminder or a calendar event", () => {
    const f = onboard("KZ");
    const items = plan(f.session, ctx);
    expect(items.map(i => i.ruleId)).toEqual(["medical-examination", "fingerprinting"]);
    expect(items.flatMap(i => reminderDates(i, ctx.today)).length).toBeGreaterThan(0);
    const ics = planToIcs(items, { lang: "ru", texts, demo: true, uid: "x", today: ctx.today, sequence: 1 });
    expect(ics).not.toContain("Миграционный учёт");
  });
  it("rejects a procedure that would show an unverified or broken card", () => {
    const good = { id: "u", name: { ru: "У" }, contactUrl: "https://example.org", citizenships: ["KZ"], checkedAt: "2026-09-29" };
    const proc = { id: "reg", title: { ru: "Т" }, action: { ru: "Д" }, when: { ru: "К" },
      documents: [{ id: "passport", title: { ru: "П" } }], appliesIf: [],
      source: { url: "https://example.org/reg", checkedAt: "2026-09-29" } };
    expect(parseUniversity({ ...good, procedures: [proc] }).procedures).toHaveLength(1);
    for (const bad of [
      { ...proc, source: { ...proc.source, url: "http://example.org/reg" } },
      { ...proc, source: { ...proc.source, checkedAt: "2026-02-30" } },
      { ...proc, when: { en: "no Russian" } },
      { ...proc, documents: [proc.documents[0], proc.documents[0]] },
      { ...proc, appliesIf: [{ field: "entryDate", op: "onOrAfter", value: "2026-09-01" }] },
    ]) expect(() => parseUniversity({ ...good, procedures: [bad] })).toThrow();
    expect(() => parseUniversity({ ...good, procedures: [proc, proc] })).toThrow(/повторяющийся id/);
    const clashing = parseUniversity({ ...good, procedures: [{ ...proc, id: "fingerprinting" }] });
    expect(() => checkProcedures([clashing], rules.rules.map(r => r.id))).toThrow(/совпадает с id нормы/);
    expect(() => checkProcedures(universities, rules.rules.map(r => r.id))).not.toThrow();
  });
});
