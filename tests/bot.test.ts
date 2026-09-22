import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { transition, type Reply, type Session } from "../src/bot/dialog.js";
import { Store } from "../src/bot/store.js";
import { Service, parseUpdate } from "../src/bot/service.js";
import { webhookServer } from "../src/bot/server.js";
import { loadRules, readConfig } from "../src/bot/config.js";
import { createTransport } from "../src/bot/transport.js";

const rules = parseRuleSet(raw);
const ctx = { rules: rules.rules, version: rules.version, demo: true, today: "2026-09-24" };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
function fixture(path = ":memory:") {
  const store = new Store(path);
  cleanups.push(() => store.close());
  let now = Date.parse("2026-09-24T10:00:00+03:00");
  const sent: { user:number; reply:Reply }[] = [];
  let failure = false;
  const service = new Service(store, ctx, { async send(user, reply) {
    if (failure) throw new Error("network unavailable");
    sent.push({user,reply});
  } }, () => now);
  let n = 0;
  const input = (text: string, user = 1, id = String(++n), callback = false) => service.receive({ id, user, input: { text, callback } });
  const click = (action: string, user = 1) => {
    const s = store.get(user)!;
    input(`${s.nonce}.${s.revision}|${action}`, user, String(++n), true);
  };
  const onboard = (user = 1, lang = "ru") => {
    input("/start",user); click(lang,user); click("accept",user); click("yes",user); click("KZ",user); input("2026-09-01",user);
  };
  return { store, service, sent, input, click, onboard,
    time: (date:string) => {now = Date.parse(date);}, fail: (value:boolean) => {failure = value;} };
}
describe("student dialogue and durable processing", () => {
  it("completes onboarding, shows sources and saves document checkmarks", async () => {
    const f=fixture(); f.onboard(); f.click("card:medical-examination");
    f.click("doc:medical-examination:passport");
    expect(f.store.get(1)?.documents["medical-examination:2026-10-01:passport"]).toBe(true);
    await f.service.flush();
    expect(f.sent.at(-1)?.reply.text).toContain("consultant.ru");
    expect(f.sent.at(-1)?.reply.text).toContain("ДЕМО");
  });
  it("rejects invalid/future/out-of-scope dates without losing the step", () => {
    const f=fixture(); f.input("/start"); f.click("ru"); f.click("accept"); f.click("yes"); f.click("KZ");
    for(const date of ["2026-02-30","2026-08-31","2026-09-25"]) {
      f.input(date); expect(f.store.get(1)?.step).toBe("entry");
    }
    f.input("2026-09-01"); expect(f.store.get(1)?.step).toBe("plan");
  });
  it("has an English route through the same scenario", async () => {
    const f=fixture(); f.onboard(1,"en"); await f.service.flush();
    expect(f.sent.at(-1)?.reply.text).toContain("Your preparation plan");
  });
  it("does not manufacture a plan for unsupported citizenship or scope", () => {
    let state:Session|null = null;
    for(const text of ["/start","ru","accept","no","BY"]) state=transition(state,{text,callback:false},ctx).session;
    expect(state?.entryDate).toBeUndefined();
    expect(state?.step).toBe("scope");
  });
  it("deduplicates repeated webhook events", () => {
    const f=fixture(); f.input("/start",1,"same"); f.input("/start",1,"same");
    expect(f.store.get(1)?.revision).toBe(1);
    expect(f.store.counts().pending).toBe(1);
  });
  it("makes repeated and foreign-user buttons harmless", () => {
    const f=fixture(); f.onboard(); f.onboard(2);
    const s=f.store.get(1)!;
    const payload=`${s.nonce}.${s.revision}|reminders`;
    f.input(payload,2,"foreign",true); expect(f.store.get(2)?.reminders).toBe(false);
    f.input(payload,1,"once",true); f.input(payload,1,"twice",true);
    expect(f.store.get(1)?.reminders).toBe(true);
  });
  it("uses the actual completion date and prevents duplicate same-day renewal", () => {
    const f=fixture(); f.onboard(); f.click("done:medical-examination"); f.input("2026-09-20");
    expect(f.store.get(1)?.completions["medical-examination"]).toBe("2026-09-20");
    f.click("done:medical-examination"); f.input("2026-09-20");
    expect(f.store.get(1)?.step).toBe("completion");
  });
  it("sends a scheduled reminder once and cancels remaining reminders on completion", async () => {
    const f=fixture(); f.onboard(); f.click("reminders");
    await f.service.flush(); const count=f.sent.length;
    f.service.maintain(); await f.service.flush(); expect(f.sent.length).toBe(count);
    expect(f.sent.some(x=>x.reply.text.includes("Напоминание:"))).toBe(true);
    f.click("done:medical-examination"); f.input("2026-09-24"); await f.service.flush();
    f.time("2026-09-28T10:00:00+03:00"); await f.service.flush();
    expect(f.sent.filter(x=>x.reply.text.includes("Напоминание:"))).toHaveLength(1);
  });
  it("stop disables notifications without destroying the profile", () => {
    const f=fixture(); f.onboard(); f.click("reminders"); f.input("/stop");
    expect(f.store.get(1)?.reminders).toBe(false);
    expect(f.store.get(1)?.entryDate).toBe("2026-09-01");
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='reminder' AND status='pending'").get()?.n).toBe(0);
  });
  it("retains delivery receipts for reminders queued weeks before delivery", async () => {
    const f=fixture(); f.time("2026-09-01T10:00:00+03:00"); f.onboard(); f.click("reminders");
    await f.service.flush();
    f.time("2026-09-24T10:00:00+03:00"); await f.service.flush();
    expect(f.sent.filter(x=>x.reply.text.includes("Напоминание:"))).toHaveLength(1);
    f.service.maintain(); await f.service.flush();
    expect(f.sent.filter(x=>x.reply.text.includes("Напоминание:"))).toHaveLength(1);
  });
  it("deletes profile and queued messages after confirmation", async () => {
    const f=fixture(); f.onboard(); f.click("reminders"); f.input("/delete");
    expect(f.store.get(1)).not.toBeNull();
    f.click("confirm-delete"); expect(f.store.get(1)).toBeNull();
    await f.service.flush(); expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.reply.text).toContain("удалены");
  });
  it("does not reapply old buttons after deleting and recreating a profile", () => {
    const f=fixture(); f.onboard(); const s=f.store.get(1)!;
    f.input("/delete"); f.click("confirm-delete"); f.onboard();
    f.input(`${s.nonce}.${s.revision}|reminders`,1,"old",true);
    expect(f.store.get(1)?.reminders).toBe(false);
  });
  it("retries transport failures after backoff without losing state", async () => {
    const f=fixture(); f.input("/start"); f.fail(true); await f.service.flush();
    expect(f.store.counts().pending).toBe(1); expect(f.store.get(1)).not.toBeNull();
    f.fail(false); await f.service.flush(); expect(f.sent).toHaveLength(0);
    f.time("2026-09-24T10:01:00+03:00"); await f.service.flush(); expect(f.sent).toHaveLength(1);
  });
  it("supersedes an old failed screen after the dialogue advances", async () => {
    const f=fixture(); f.input("/start"); f.fail(true); await f.service.flush();
    f.fail(false); f.input("en"); await f.service.flush();
    f.time("2026-09-24T10:01:00+03:00"); await f.service.flush();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.reply.text).toContain("Continue?");
  });
  it("restores progress and outbox after reopening the database", async () => {
    const dir=mkdtempSync(join(tmpdir(),"max-bot-test-"));
    const f=fixture(join(dir,"state.sqlite")); f.onboard();
    cleanups.pop(); f.store.close();
    const g=fixture(join(dir,"state.sqlite"));
    expect(g.store.get(1)?.entryDate).toBe("2026-09-01");
    await g.service.flush(); expect(g.sent.length).toBeGreaterThan(0);
    cleanups.push(() => rmSync(dir,{recursive:true,force:true}));
  });
  it("pauses calculations and reminders after a rule version change", () => {
    const f=fixture(); f.onboard(); f.click("reminders");
    const s=f.store.get(1)!;
    const result=transition(s,{text:"/plan",callback:false},{...ctx,version:"new"});
    expect(result.session?.reminders).toBe(false); expect(result.reply.text).toContain("Правила изменились");
  });
  it("rolls back deduplication when saving the outcome fails", () => {
    const f=fixture(); f.store.db.exec("DROP TABLE sessions");
    expect(()=>f.input("/start",1,"retry-me")).toThrow();
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(0);
  });
});
describe("webhook boundary and release guards", () => {
  it("uses official SDK headers, direct recipients and callback payloads", async () => {
    const mocked = vi.fn(async () => new Response(JSON.stringify({message:{body:{mid:"fake"}}}), {status:200}));
    vi.stubGlobal("fetch",mocked);
    try {
      const transport=createTransport(readConfig({TRANSPORT:"max",MAX_BOT_TOKEN:"test-token",
        WEBHOOK_SECRET:"your-demo-secret-change-before-deploy"}));
      await transport.send(123,{text:"DEMO",ruleVersion:"test",buttons:[[{text:"Plan",action:"nonce.1|plan"}]]});
      const call=mocked.mock.calls[0] as unknown as [string,RequestInit];
      expect(call[0]).toBe("https://platform-api2.max.ru/messages?user_id=123");
      expect(call[1].headers).toMatchObject({Authorization:"test-token"});
      expect(JSON.parse(call[1].body as string).attachments[0].payload.buttons[0][0].payload).toBe("nonce.1|plan");
    } finally { vi.unstubAllGlobals(); }
  });
  it("normalizes MAX private messages and ignores group traffic", () => {
    const message={update_type:"message_created",message:{sender:{user_id:1},recipient:{chat_type:"dialog"},body:{mid:"x",text:"/start"}}};
    expect(parseUpdate(message)?.input.text).toBe("/start");
    message.message.recipient.chat_type="chat"; expect(parseUpdate(message)).toBeNull();
    expect(()=>parseUpdate({update_type:"bot_started",timestamp:1,user:{user_id:"1"}})).toThrow();
  });
  it("requires real configuration for MAX and blocks draft rules in live mode", () => {
    expect(()=>readConfig({TRANSPORT:"max"})).toThrow(/TOKEN/);
    expect(()=>readConfig({APP_MODE:"live"})).toThrow(/MAX/);
    expect(()=>loadRules({mode:"live",rulesPath:"src/data/rules/ru-student.json"})).toThrow(/review/);
  });
  it("authenticates HTTP, validates JSON and accepts repeated events once", async () => {
    const f=fixture(), server=webhookServer(f.service,"test-secret");
    server.listen(0,"127.0.0.1"); await once(server,"listening");
    const addr=server.address() as {port:number};
    const url=`http://127.0.0.1:${addr.port}`;
    try {
      const body=JSON.stringify({update_type:"bot_started",timestamp:123,user:{user_id:1}});
      expect((await fetch(url+"/webhook",{method:"POST",body})).status).toBe(401);
      const headers={"content-type":"application/json","x-max-bot-api-secret":"test-secret"};
      expect((await fetch(url+"/webhook",{method:"POST",body:"{",headers})).status).toBe(400);
      expect((await fetch(url+"/webhook",{method:"POST",body:JSON.stringify({data:"x".repeat(70000)}),headers})).status).toBe(413);
      expect((await fetch(url+"/webhook",{method:"POST",body,headers})).status).toBe(200);
      expect((await fetch(url+"/webhook",{method:"POST",body,headers})).status).toBe(200);
      expect(f.store.counts().pending).toBe(1);
      expect(await (await fetch(url+"/health")).json()).toMatchObject({mode:"demo"});
    } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });
});
