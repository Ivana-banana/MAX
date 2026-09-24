import { afterEach, describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readUniversities } from "../src/data/loadUniversities.js";
import { readTexts } from "../src/data/loadTexts.js";
import type { Reply } from "../src/bot/dialog.js";
import { Service } from "../src/bot/service.js";
import { testSchema } from "./pg.js";

const rules = parseRuleSet(raw);
const context = { rules: rules.rules, universities: readUniversities("src/data/universities", "kfu"), texts: readTexts("src/data/i18n"),
  version: rules.version, demo: true };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function fixture(start: string) {
  const schema = await testSchema(); cleanups.push(schema.drop);
  const { store } = await schema.open();
  cleanups.push(() => store.close());
  let now = Date.parse(start);
  const sent: Reply[] = [];
  const service = new Service(store, context, { async send(_u, reply) { sent.push(reply); } }, () => now);
  let n = 0;
  const input = (text: string, callback = false) => service.receive({ id: String(++n), user: 1, input: { text, callback } });
  const click = async (action: string) => { const s = (await store.get(1))!; await input(`${s.nonce}.${s.revision}|${action}`, true); };
  const onboard = async () => { await input("/start"); for (const a of ["ru", "accept", "yes", "KZ"]) await click(a); await input("2026-09-01"); };
  const at = async (date: string) => { now = Date.parse(date); await service.maintain(); await service.flush(); };
  const reminders = () => sent.filter(r => r.text.includes("Напоминание:")).map(r => r.text);
  return { store, sent, input, click, onboard, at, reminders };
}
const texts = (r: Reply) => r.buttons.flat().map(b => b.text);

describe("reminders are offered right after the plan", () => {
  it("puts the switch first while reminders are off and explains what they do", async () => {
    const f = await fixture("2026-09-24T10:00:00+03:00"); await f.onboard(); await f.at("2026-09-24T10:00:00+03:00");
    const plan = f.sent.at(-1)!;
    expect(plan.text).toContain("Напоминания: выключены. Включите — бот напишет за 7, 3 и 1 день до срока в 09:00 МСК");
    expect(texts(plan)[0]).toBe("🔔 Включить напоминания");
    await f.click("reminders"); await f.at("2026-09-24T10:00:00+03:00");
    const on = f.sent.at(-1)!;
    expect(on.text).toContain("Напоминания: включены");
    expect(texts(on)[0]).toBe("Медицинское освидетельствование");
    expect(texts(on)).toContain("🔕 Выключить напоминания");
  });
});

describe("one follow-up the day after the calculated date", () => {
  it("comes once on the next day, opens the overdue card and stays silent afterwards", async () => {
    const f = await fixture("2026-09-29T10:00:00+03:00"); await f.onboard(); await f.click("reminders");
    await f.at("2026-09-29T10:00:00+03:00");
    expect(f.reminders()).toHaveLength(1);
    await f.at("2026-09-30T09:00:00+03:00");
    await f.at("2026-10-01T09:00:00+03:00");
    const last = f.sent.at(-1)!;
    expect(f.reminders().at(-1)).toContain("Медицинское освидетельствование — расчётный срок был до 2026-09-30. Процедуру всё равно нужно пройти");
    expect(f.reminders().at(-1)).not.toMatch(/штраф|выдвор/i);
    const details = last.buttons.flat().find(b => "action" in b && b.action.endsWith("|card:medical-examination:reminder")) as { action: string };
    expect(details).toBeDefined();
    const count = f.reminders().length;
    await f.at("2026-10-02T09:00:00+03:00"); await f.at("2026-10-05T09:00:00+03:00");
    expect(f.reminders()).toHaveLength(count);
    expect(f.reminders().filter(r => r.includes("расчётный срок был до 2026-09-30"))).toHaveLength(1);
  });
  it("is not sent late, and not at all once the procedure is marked", async () => {
    const late = await fixture("2026-09-29T10:00:00+03:00"); await late.onboard(); await late.click("reminders");
    await late.at("2026-10-02T09:00:00+03:00");
    expect(late.reminders().some(r => r.includes("расчётный срок был до"))).toBe(false);
    const done = await fixture("2026-09-29T10:00:00+03:00"); await done.onboard(); await done.click("reminders");
    await done.click("done:medical-examination"); await done.input("/today");
    expect((await done.store.get(1))!.completions["medical-examination"]).toBe("2026-09-29");
    await done.at("2026-10-01T09:00:00+03:00");
    expect(done.reminders().some(r => r.includes("расчётный срок был до 2026-09-30"))).toBe(false);
  });
});
