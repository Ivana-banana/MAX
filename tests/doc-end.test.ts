import { afterEach, describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { parseUniversity, readUniversities } from "../src/data/loadUniversities.js";
import { procedureDue, transition, undated, type Reply, type Session } from "../src/bot/dialog.js";
import { Service } from "../src/bot/service.js";
import { isAppAction, readState } from "../src/webapp/state.js";
import { testSchema } from "./pg.js";
import { plain } from "../src/core/markup.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };
const actions = (r: Reply) => r.buttons.flat().flatMap(b => "action" in b ? [b.action.split("|")[1]!] : []);

function planned(citizenship: string, start = "/start") {
  let s: Session = transition(null, { text: start, callback: false }, ctx).session!;
  let last!: Reply;
  const click = (action: string) => {
    const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);
    s = r.session!; last = r.reply; return r.reply;
  };
  const type = (text: string) => { const r = transition(s, { text, callback: false }, ctx); s = r.session!; last = r.reply; return r.reply; };
  for (const a of ["ru", "accept", "yes", citizenship]) click(a);
  type("2026-09-01");
  return { click, type, get session() { return s; }, get reply() { return last; } };
}

describe("a university deadline counted from the visa or registration end date", () => {
  it("asks for the visa end date from the KFU visa extension card", () => {
    const f = planned("CN");
    const card = f.click("card:visa-extension");
    expect(actions(card)).toContain("end:visa-extension");
    expect(card.buttons.flat().map(b => b.text)).toContain("📅 Указать дату окончания визы");
    const ask = f.click("end:visa-extension");
    expect(f.session.step).toBe("docEnd");
    expect(ask.text).toContain("До какого числа действует ваша виза?");
  });

  it("turns KFU's «no earlier than 90 and no later than 45 days» into a window, labelled as the university's rule", () => {
    const f = planned("CN");
    f.click("card:visa-extension"); f.click("end:visa-extension");
    const card = f.type("15.01.2027");
    expect(f.session.ends).toEqual({ "visa-end": "2027-01-15" });
    expect(f.session.step).toBe("plan");
    expect(card.text).toContain("Подать документы: с 17 октября 2026 г. по 1 декабря 2026 г.");
    expect(card.text).toContain("расчёт бота по правилу КФУ");
    expect(card.text).toContain("15 января 2027 г.");
    expect(procedureDue(f.session, ctx, undated(f.session, ctx).find(n => n.id === "visa-extension")!))
      .toEqual({ end: "2027-01-15", due: "2026-12-01", from: "2026-10-17" });
    // Once the window has opened, only the last day matters.
    f.click("card:visa-extension"); f.click("end:visa-extension");
    expect(f.type("30.11.2026").text).toContain("Подать документы до 16 октября 2026 г.");
  });

  it("lists the counted date in the plan", () => {
    const f = planned("CN");
    f.click("card:visa-extension"); f.click("end:visa-extension"); f.type("30.11.2026");
    expect(plain(f.click("plan").text)).toContain("• Продление визы — до 16 октября 2026 г.");
  });

  it("uses the registration end date for a visa-free student's stay extension", () => {
    const f = planned("KZ");
    expect(actions(f.click("card:stay-extension"))).toContain("end:stay-extension");
    expect(f.click("end:stay-extension").text).toContain("До какого числа действует регистрация?");
    expect(f.type("2026-11-29").text).toContain("Подать документы до 15 октября 2026 г.");
  });

  it("refuses an end date in the past or more than two years ahead", () => {
    const f = planned("CN");
    f.click("card:visa-extension"); f.click("end:visa-extension");
    for (const day of ["2026-09-23", "2028-09-25", "31.02.2027"]) {
      expect(f.type(day).text).toContain("Нужна дата не раньше сегодняшней");
      expect(f.session.step).toBe("docEnd");
    }
  });

  it("keeps Cancel under a refused end date, like the question (#109)", () => {
    const f = planned("CN");
    f.click("card:visa-extension"); f.click("end:visa-extension");
    expect(actions(f.type("2026-09-23"))).toEqual(["plan"]);
  });

  it("says the submission period has passed instead of showing a date in the past", () => {
    const f = planned("CN");
    f.click("card:visa-extension"); f.click("end:visa-extension");
    expect(f.type("2026-10-20").text).toContain("По правилу вуза срок подачи (5 сентября 2026 г.) прошёл");
  });

  it("offers no date for a procedure the university words without days", () => {
    const f = planned("KZ");
    expect(actions(f.click("card:registration-change")).some(a => a.startsWith("end:"))).toBe(false);
  });

  it("refuses a profile whose window does not make sense", () => {
    const base = { id: "u", name: { ru: "У" }, contactUrl: "https://u.ru", citizenships: ["KZ"], checkedAt: "2026-09-29" };
    const proc = (countdown: unknown) => ({ ...base, procedures: [{ id: "p", title: { ru: "П" }, action: { ru: "А" }, when: { ru: "К" },
      documents: [], appliesIf: [], source: { url: "https://u.ru", checkedAt: "2026-09-29" }, countdown }] });
    expect(parseUniversity(proc({ from: "visa-end", daysBefore: 45, notBeforeDays: 90 })).procedures[0]!.countdown)
      .toEqual({ from: "visa-end", daysBefore: 45, notBeforeDays: 90 });
    expect(() => parseUniversity(proc({ from: "visa-end", daysBefore: 45, notBeforeDays: 30 }))).toThrow(/notBeforeDays/);
    expect(() => parseUniversity(proc({ from: "passport-end", daysBefore: 45 }))).toThrow(/from/);
    expect(() => parseUniversity(proc({ from: "visa-end", daysBefore: 0 }))).toThrow(/daysBefore/);
  });

  it("never puts a period after a Russian date, which already ends with «г.»", () => {
    const ru = texts.get("ru")!;
    expect(Object.entries(ru).filter(([, v]) => /\{(due|date|from|end)\}\./.test(v)).map(([k]) => k)).toEqual([]);
    const f = planned("CN");
    f.click("card:visa-extension"); f.click("end:visa-extension");
    expect(f.type("15.01.2027").text).not.toContain("г..");
  });

  it("puts the counted university date into the calendar file with alarms 7, 3 and 1 days before", () => {
    const f = planned("CN");
    f.click("card:visa-extension"); f.click("end:visa-extension"); f.type("15.01.2027");
    const ics = f.click("calendar").file!.content.replace(/\r\n /g, "");
    expect(ics).toContain("UID:visa-extension-");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261201");
    expect(ics).toContain("SUMMARY:[ДЕМО] Срок вуза: Продление визы");
    for (const day of ["20261124", "20261128", "20261130"]) expect(ics).toContain(`TRIGGER;VALUE=DATE-TIME:${day}T060000Z`);
  });

  it("lets the mini app send the same actions", () => {
    expect(isAppAction("end:visa-extension")).toBe(true);
  });
});

describe("reminders before the university deadline", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

  it("reminds 7, 3 and 1 days before the counted date at 09:00, and the app shows the same date", async () => {
    const schema = await testSchema(); cleanups.push(schema.drop);
    const { store } = await schema.open(); cleanups.push(() => store.close());
    let now = Date.parse("2026-09-24T10:00:00+03:00");
    const sent: Reply[] = [];
    const service = new Service(store, ctx, { send(_u, reply) { sent.push(reply); return Promise.resolve(); } }, () => now);
    let n = 0;
    const input = (text: string, callback = false) => service.receive({ id: String(++n), user: 1, input: { text, callback } });
    const click = async (a: string) => { const s = (await store.get(1))!; await input(`${s.nonce}.${s.revision}|${a}`, true); };
    await input("/start");
    for (const a of ["ru", "accept", "yes", "CN"]) await click(a);
    await input("2026-09-01");
    await click("reminders");
    await click("card:visa-extension"); await click("end:visa-extension"); await input("30.11.2026");
    const app = (await readState(service, 1, false)).session?.undated.find(i => i.id === "visa-extension");
    expect(app).toMatchObject({ due: "2026-10-16", from: "2026-09-01", end: "2026-11-30" });
    const university = (sent: Reply[]) => sent.filter(r => plain(r.text).includes("подать документы до 16 октября"));
    for (const [day, count] of [["2026-10-08", 0], ["2026-10-09", 1], ["2026-10-13", 2], ["2026-10-15", 3]] as const) {
      now = Date.parse(`${day}T09:00:00+03:00`); await service.flush();
      expect(university(sent), day).toHaveLength(count);
    }
    expect(university(sent)[0]!.text).toContain("Продление визы");
  });
});
