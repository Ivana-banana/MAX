import { afterEach, describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import type { Reply } from "../src/bot/dialog.js";
import { Service } from "../src/bot/service.js";
import { testSchema } from "./pg.js";

// #134: offline taps on one button are queued by MAX and delivered together once the network is back.
// The first one acts; its exact repeats must not each answer "the button is outdated".

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function service() {
  const schema = await testSchema(); cleanups.push(schema.drop);
  const { store } = await schema.open(); cleanups.push(() => store.close());
  const sent: Reply[] = [];
  const svc = new Service(store, ctx, { send(_user: number, reply: Reply) { sent.push(reply); return Promise.resolve(); } },
    () => Date.parse("2026-09-24T10:00:00+03:00"));
  let n = 0;
  const input = (text: string, callback = false) => svc.receive({ id: String(++n), user: 1, input: { text, callback } });
  const stamp = async () => { const s = (await store.get(1))!; return `${s.nonce}.${s.revision}`; };
  await input("/start");
  for (const a of ["ru", "accept", "yes", "KZ"]) await input(`${await stamp()}|${a}`, true);
  await input("2026-09-01");
  await svc.flush();
  return { svc, sent, input, stamp, store };
}

describe("a burst of the same tap (#134)", () => {
  it("acts on the first tap and drops its exact repeats without a reply", async () => {
    const f = await service();
    const card = await f.stamp();
    await f.input(`${card}|card:medical-examination`, true);
    const tap = `${await f.stamp()}|done:medical-examination`;
    const before = f.sent.length;
    for (let i = 0; i < 4; i++) await f.input(tap, true);
    await f.svc.flush();
    const replies = f.sent.slice(before).map(r => r.text);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Когда вы прошли процедуру?");
    expect((await f.store.get(1))!.step).toBe("completion");
  });

  it("still says outdated for an older button, not the one just pressed", async () => {
    const f = await service();
    const old = await f.stamp();
    await f.input(`${old}|card:medical-examination`, true);
    await f.input(`${await f.stamp()}|done:medical-examination`, true);
    const before = f.sent.length;
    await f.input(`${old}|done:fingerprinting`, true);
    await f.svc.flush();
    expect(f.sent.slice(before).map(r => r.text).join("")).toContain("Кнопка устарела");
  });
});
