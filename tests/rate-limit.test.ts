import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { format, readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import type { Reply } from "../src/bot/dialog.js";
import { RateLimit } from "../src/bot/rate.js";
import { Service } from "../src/bot/service.js";
import { webhookServer } from "../src/bot/server.js";
import { webappRouter } from "../src/webapp/router.js";
import { testSchema } from "./pg.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const context = { rules: rules.rules, universities, texts, version: rules.version, demo: false };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

// Two requests a minute per user, so the third one is over the limit.
async function fixture() {
  const schema = await testSchema(); cleanups.push(schema.drop);
  const { store } = await schema.open();
  cleanups.push(() => store.close());
  let now = Date.parse("2026-09-24T10:00:00+03:00");
  const sent: Reply[] = [];
  const service = new Service(store, context, { send(_u, reply) { sent.push(reply); return Promise.resolve(); } },
    () => now, new RateLimit(2));
  return { store, service, sent, later: (ms: number) => { now += ms; } };
}

describe("per-user limit on actions (#59)", () => {
  it("chat: drops updates over the limit, says so once in the user's language, lets the next minute through", async () => {
    const f = await fixture();
    let n = 0;
    const input = (text: string, callback = false, locale?: string) =>
      f.service.receive({ id: String(++n), user: 1, input: { text, callback, ...(locale ? { locale } : {}) } });
    const click = async (action: string) => { const s = (await f.store.get(1))!; await input(`${s.nonce}.${s.revision}|${action}`, true); };
    await input("/start", false, "en-US");
    await input("/delete");
    await click("confirm-delete");
    await input("/start");
    await f.service.flush();
    // The /start → /delete loop that inflates the funnel stops at the limit: nothing deleted, nothing counted.
    expect(await f.store.get(1)).not.toBeNull();
    expect((await f.store.funnel()).map(r => r.event)).not.toContain("deleted");
    expect(f.sent.filter(r => r.text === format(texts, "en", "limited"))).toHaveLength(1);
    f.later(60_000);
    await click("confirm-delete");
    expect(await f.store.get(1)).toBeNull();
  });

  it("mini app: answers 429 with retry-after over the limit, another user still passes", async () => {
    const f = await fixture();
    const router = webappRouter(f.service, { token: "", dir: "./web/dist", devLaunch: true, devOrigin: "" });
    const server = webhookServer(f.service, "test-secret-that-is-long-enough-32", router);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const act = (user: number) => fetch(`${url}/api/action`, { method: "POST",
      headers: { authorization: `MaxWebApp demo:${user}`, "content-type": "application/json" }, body: JSON.stringify({ action: "/start" }) });
    expect((await act(7)).status).toBe(200);
    expect((await act(7)).status).toBe(200);
    const refused = await act(7);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toEqual({ error: "rate_limited" });
    expect((await act(8)).status).toBe(200);
  });
});
