import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { exampleEntry, transition, type Reply, type Session } from "../src/bot/dialog.js";
import { Service, parseUpdate } from "../src/bot/service.js";
import { webhookServer } from "../src/bot/server.js";
import { loadRules, readConfig } from "../src/bot/config.js";
import { createTransport } from "../src/bot/transport.js";

import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import type { ScratchSchema } from "../src/db/dev-postgres.js";
import { testSchema } from "./pg.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function fixture(schema?: ScratchSchema) {
  if (!schema) { schema = await testSchema(); cleanups.push(schema.drop); }
  const { store, pool } = await schema.open();
  cleanups.push(() => store.close());
  let now = Date.parse("2026-09-24T10:00:00+03:00");
  const sent: { user:number; reply:Reply }[] = [];
  let failure: boolean | Error = false;
  const service = new Service(store, ctx, { send(user, reply) {
    if (failure) return Promise.reject(failure instanceof Error ? failure : new Error("network unavailable"));
    sent.push({user,reply});
    return Promise.resolve();
  } }, () => now);
  let n = 0;
  const input = (text: string, user = 1, id = String(++n), callback = false) => service.receive({ id, user, input: { text, callback } });
  const click = async (action: string, user = 1) => {
    const s = (await store.get(user))!;
    await input(`${s.nonce}.${s.revision}|${action}`, user, String(++n), true);
  };
  const onboard = async (user = 1, lang = "ru") => {
    await input("/start",user); await click(lang,user); await click("accept",user); await click("yes",user); await click("KZ",user);
    await input("2026-09-01",user);
  };
  const pendingReminders = async () =>
    (await pool.query<{n:number}>("SELECT COUNT(*)::int AS n FROM outbox WHERE kind='reminder' AND status='pending'")).rows[0]?.n;
  return { store, pool, service, sent, input, click, onboard, pendingReminders,
    time: (date:string) => {now = Date.parse(date);}, fail: (value:boolean | Error) => {failure = value;} };
}
describe("student dialogue and durable processing", () => {
  it("completes onboarding, shows sources and saves document checkmarks", async () => {
    const f=await fixture(); await f.onboard(); await f.click("card:medical-examination");
    await f.click("doc:medical-examination:passport");
    expect((await f.store.get(1))?.documents["medical-examination:2026-09-30:passport"]).toBe(true);
    await f.service.flush();
    expect(f.sent.at(-1)?.reply.text).toContain("consultant.ru");
    expect(f.sent.at(-1)?.reply.text).toContain("ДЕМО");
  });
  it("card on en: the norm line has no Russian explanatory words and the check date is written in words", async () => {
    const f=await fixture(); await f.onboard(1,"en"); await f.click("card:medical-examination"); await f.service.flush();
    const text = f.sent.at(-1)!.reply.text;
    const norm = text.split("\n").find(line => line.includes("115-ФЗ"))!;
    expect(norm.replace("Федеральный закон от 25.07.2002 № 115-ФЗ", "")).not.toMatch(/[А-Яа-яЁё]/);
    expect(text).toContain("Source checked: October 19, 2026");
    expect(text).not.toContain("2026-10-19");
  });
  it("rejects invalid/future/out-of-scope dates without losing the step", async () => {
    const f=await fixture(); await f.input("/start"); await f.click("ru"); await f.click("accept"); await f.click("yes"); await f.click("KZ");
    for(const date of ["2026-02-30","2026-08-31","2026-09-25"]) {
      await f.input(date); expect((await f.store.get(1))?.step).toBe("entry");
    }
    await f.input("2026-09-01"); expect((await f.store.get(1))?.step).toBe("plan");
  });
  it("has an English route through the same scenario", async () => {
    const f=await fixture(); await f.onboard(1,"en"); await f.service.flush();
    expect(f.sent.at(-1)?.reply.text).toContain("Your preparation plan");
  });
  it("does not manufacture a plan for unsupported citizenship or scope", () => {
    let state:Session|null = null;
    for(const text of ["/start","ru","accept","no","BY"]) state=transition(state,{text,callback:false},ctx).session;
    expect(state?.entryDate).toBeUndefined();
    expect(state?.step).toBe("scope");
  });
  it("deduplicates repeated webhook events", async () => {
    const f=await fixture(); await f.input("/start",1,"same"); await f.input("/start",1,"same");
    expect((await f.store.get(1))?.revision).toBe(1);
    expect((await f.store.counts()).pending).toBe(1);
  });
  it("waits for the user's lock, so a concurrent update of the same user cannot interleave", async () => {
    const f=await fixture(), blocker=await f.pool.connect();
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT pg_advisory_xact_lock(1)");
      const update=f.input("/start");
      await new Promise(resolve=>setTimeout(resolve,100));
      expect(await f.store.get(1)).toBeNull();
      await blocker.query("COMMIT");
      await update;
      expect((await f.store.get(1))?.revision).toBe(1);
    } finally { blocker.release(); }
  });
  it("makes repeated and foreign-user buttons harmless", async () => {
    const f=await fixture(); await f.onboard(); await f.onboard(2);
    const s=(await f.store.get(1))!;
    const payload=`${s.nonce}.${s.revision}|reminders`;
    await f.input(payload,2,"foreign",true); expect((await f.store.get(2))?.reminders).toBe(false);
    await f.input(payload,1,"once",true); await f.input(payload,1,"twice",true);
    expect((await f.store.get(1))?.reminders).toBe(true);
  });
  it("uses the actual completion date and prevents duplicate same-day renewal", async () => {
    const f=await fixture(); await f.onboard(); await f.click("done:medical-examination"); await f.input("2026-09-20");
    expect((await f.store.get(1))?.completions["medical-examination"]).toBe("2026-09-20");
    await f.click("done:medical-examination"); await f.input("2026-09-20");
    expect((await f.store.get(1))?.step).toBe("completion");
  });
  it("sends a scheduled reminder once and cancels remaining reminders on completion", async () => {
    // Due 2026-09-30, first reminder 7 days earlier: the clock is set to that day.
    const f=await fixture(); f.time("2026-09-23T10:00:00+03:00"); await f.onboard(); await f.click("reminders");
    await f.service.flush(); const count=f.sent.length;
    await f.service.maintain(); await f.service.flush(); expect(f.sent.length).toBe(count);
    expect(f.sent.some(x=>x.reply.text.includes("Напоминание:"))).toBe(true);
    await f.click("done:medical-examination"); await f.input("2026-09-23"); await f.service.flush();
    f.time("2026-09-28T10:00:00+03:00"); await f.service.flush();
    expect(f.sent.filter(x=>x.reply.text.includes("Напоминание:"))).toHaveLength(1);
  });
  it("stop disables notifications without destroying the profile", async () => {
    const f=await fixture(); await f.onboard(); await f.click("reminders"); await f.input("/stop");
    expect((await f.store.get(1))?.reminders).toBe(false);
    expect((await f.store.get(1))?.entryDate).toBe("2026-09-01");
    expect(await f.pendingReminders()).toBe(0);
  });
  it("retains delivery receipts for reminders queued weeks before delivery", async () => {
    const f=await fixture(); f.time("2026-09-01T10:00:00+03:00"); await f.onboard(); await f.click("reminders");
    await f.service.flush();
    f.time("2026-09-24T10:00:00+03:00"); await f.service.flush();
    expect(f.sent.filter(x=>x.reply.text.includes("Напоминание:"))).toHaveLength(1);
    await f.service.maintain(); await f.service.flush();
    expect(f.sent.filter(x=>x.reply.text.includes("Напоминание:"))).toHaveLength(1);
  });
  it("deletes profile and queued messages after confirmation", async () => {
    const f=await fixture(); await f.onboard(); await f.click("reminders"); await f.input("/delete");
    expect(await f.store.get(1)).not.toBeNull();
    await f.click("confirm-delete"); expect(await f.store.get(1)).toBeNull();
    await f.service.flush(); expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.reply.text).toContain("удалены");
  });
  it("does not reapply old buttons after deleting and recreating a profile", async () => {
    const f=await fixture(); await f.onboard(); const s=(await f.store.get(1))!;
    await f.input("/delete"); await f.click("confirm-delete"); await f.onboard();
    await f.input(`${s.nonce}.${s.revision}|reminders`,1,"old",true);
    expect((await f.store.get(1))?.reminders).toBe(false);
  });
  it("retries transport failures after backoff without losing state", async () => {
    const f=await fixture(); await f.input("/start"); f.fail(true); await f.service.flush();
    expect((await f.store.counts()).pending).toBe(1); expect(await f.store.get(1)).not.toBeNull();
    f.fail(false); await f.service.flush(); expect(f.sent).toHaveLength(0);
    f.time("2026-09-24T10:01:00+03:00"); await f.service.flush(); expect(f.sent).toHaveLength(1);
  });
  it("logs the error code of a failed send without its message", async () => {
    const f=await fixture(); await f.input("/start");
    const log=vi.spyOn(console,"error").mockImplementation(() => {});
    try {
      f.fail(Object.assign(new Error("secret user text"),{code:"attachment.not.ready",status:400})); await f.service.flush();
      const line=String(log.mock.calls[0]?.[0]);
      expect(line).toContain("code=attachment.not.ready"); expect(line).toContain("status=400"); expect(line).not.toContain("secret user text");
    } finally { log.mockRestore(); }
  });
  it("supersedes an old failed screen after the dialogue advances", async () => {
    const f=await fixture(); await f.input("/start"); f.fail(true); await f.service.flush();
    f.fail(false); await f.input("en"); await f.service.flush();
    f.time("2026-09-24T10:01:00+03:00"); await f.service.flush();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.reply.text).toContain("Continue?");
  });
  it("restores progress and outbox after reopening the database", async () => {
    const schema=await testSchema(); cleanups.push(schema.drop);
    const f=await fixture(schema); await f.onboard(); await f.store.close();
    const g=await fixture(schema);
    expect((await g.store.get(1))?.entryDate).toBe("2026-09-01");
    await g.service.flush(); expect(g.sent.length).toBeGreaterThan(0);
  });
  it("pauses calculations and reminders after a rule version change", async () => {
    const f=await fixture(); await f.onboard(); await f.click("reminders");
    const s=(await f.store.get(1))!;
    const result=transition(s,{text:"/plan",callback:false},{...ctx,version:"new"});
    expect(result.session?.reminders).toBe(false); expect(result.reply.text).toContain("Правила изменились");
  });
  it("rolls back deduplication when saving the outcome fails", async () => {
    const f=await fixture(); await f.pool.query("DROP TABLE sessions");
    await expect(f.input("/start",1,"retry-me")).rejects.toThrow();
    expect((await f.pool.query<{n:number}>("SELECT COUNT(*)::int AS n FROM events")).rows[0]?.n).toBe(0);
  });
});
describe("webhook boundary and release guards", () => {
  it("uses official SDK headers, direct recipients and callback payloads", async () => {
    const mocked = vi.fn(() => Promise.resolve(new Response(JSON.stringify({message:{body:{mid:"fake"}}}), {status:200})));
    vi.stubGlobal("fetch",mocked);
    try {
      const transport=createTransport(readConfig({TRANSPORT:"max",MAX_BOT_TOKEN:"test-token",
        WEBHOOK_SECRET:"your-demo-secret-change-before-deploy",DATABASE_URL:"postgresql://unused"}));
      await transport.send(123,{text:"DEMO",ruleVersion:"test",buttons:[[{text:"Plan",action:"nonce.1|plan"}]]});
      const call=mocked.mock.calls[0] as unknown as [string,RequestInit];
      expect(call[0]).toBe("https://platform-api2.max.ru/messages?user_id=123");
      expect(call[1].headers).toMatchObject({Authorization:"test-token"});
      expect((JSON.parse(call[1].body as string) as {attachments:[{payload:{buttons:[[{payload:string}]]}}]}).attachments[0].payload.buttons[0][0].payload).toBe("nonce.1|plan");
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
    const draftPath=join(mkdtempSync(join(tmpdir(),"rules-")),"draft.json");
    writeFileSync(draftPath,JSON.stringify({...raw,rules:raw.rules.map(r=>({...r,legal:{...r.legal,status:"draft"}}))}));
    expect(()=>loadRules({mode:"live",rulesPath:draftPath})).toThrow(/review/);
    expect(()=>readConfig({})).toThrow(/DATABASE_URL/);
    expect(()=>readConfig({TRANSPORT:"max",MAX_BOT_TOKEN:"t",WEBHOOK_SECRET:"your-demo-secret-change-before-deploy",
      DATABASE_URL:"postgresql://bot:local-demo-only-not-for-deployment@postgres:5432/bot"})).toThrow(/POSTGRES_PASSWORD/);
  });
  it("keeps only a 7–40 character hexadecimal deployed commit and never refuses to start over it", () => {
    const env = { DATABASE_URL: "postgresql://unused" };
    expect(readConfig({ ...env, DEPLOYED_COMMIT: "a1B2c3D" }).deployedCommit).toBe("a1B2c3D");
    expect(readConfig(env).deployedCommit).toBe("");
    expect(readConfig({ ...env, DEPLOYED_COMMIT: "" }).deployedCommit).toBe("");
    for (const value of ["abc123", "a".repeat(41), "abcdefg!", " abcdefg", "abcdefg\n"]) {
      expect(readConfig({ ...env, DEPLOYED_COMMIT: value }).deployedCommit).toBe("");
    }
  });
  it("includes the deployed commit in health only when configured", async () => {
    const f=await fixture(), commit="a1b2c3d4e5f6";
    const server=webhookServer(f.service,"test-secret",undefined,readConfig({
      DATABASE_URL:"postgresql://unused",DEPLOYED_COMMIT:commit,
    }).deployedCommit);
    server.listen(0,"127.0.0.1"); await once(server,"listening");
    const addr=server.address() as {port:number};
    try {
      const response=await fetch(`http://127.0.0.1:${addr.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({status:"ok",mode:"demo",queue:await f.store.counts(),commit});
    } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });
  it("authenticates HTTP, validates JSON and accepts repeated events once", async () => {
    const f=await fixture(), server=webhookServer(f.service,"test-secret");
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
      expect((await f.store.counts()).pending).toBe(1);
      expect(await (await fetch(url+"/health")).json()).toEqual({status:"ok",mode:"demo",queue:await f.store.counts()});
      // A storage failure is not acknowledged: MAX redelivers the update later.
      await f.pool.query("DROP TABLE sessions");
      const other=JSON.stringify({update_type:"bot_started",timestamp:124,user:{user_id:2}});
      expect((await fetch(url+"/webhook",{method:"POST",body:other,headers})).status).toBe(503);
      await f.store.close();
      expect((await fetch(url+"/health")).status).toBe(503);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });
});
describe("calendar export, MAX link/clipboard buttons and reminder navigation", () => {
  const flat = (r?: Reply) => r?.buttons.flat() ?? [];
  it("sends the plan as an .ics file from the plan screen", async () => {
    const f=await fixture(); await f.onboard(); await f.click("calendar"); await f.service.flush();
    const r=f.sent.at(-1)?.reply;
    expect(r?.file?.name).toBe("first-90-days.ics");
    expect(r?.file?.content.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(r?.text).toContain("не решение МВД");
  });
  it("hides the calendar button when nothing is left to do", async () => {
    const f=await fixture(); await f.onboard(); await f.service.flush();
    expect(flat(f.sent.at(-1)?.reply).some(b=>"action" in b && b.action.endsWith("|calendar"))).toBe(true);
    await f.click("done:fingerprinting"); await f.input("2026-09-10");
    await f.store.transaction(1, async tx => tx.save({...(await tx.get())!,completions:{fingerprinting:"2026-09-10"},step:"plan"},0));
    const s=(await f.store.get(1))!;
    const alldone=transition(s,{text:`${s.nonce}.${s.revision}|plan`,callback:true},{...ctx,rules:ctx.rules.filter(r=>r.id==="fingerprinting")});
    expect(flat(alldone.reply).some(b=>"action" in b && b.action.endsWith("|calendar"))).toBe(false);
  });
  it("links the card to the law and turns 'help' into a ready question to copy", async () => {
    const f=await fixture(); await f.onboard(); await f.click("card:medical-examination"); await f.service.flush();
    expect(flat(f.sent.at(-1)?.reply)).toContainEqual({ text:"Открыть норму", url:expect.stringContaining("consultant.ru") as string });
    await f.click("help:medical-examination"); await f.service.flush();
    const copy=flat(f.sent.at(-1)?.reply).find(b=>"copy" in b) as {copy:string}|undefined;
    expect(copy?.copy).toContain("«Медицинское освидетельствование» (расчётный срок — до 30 сентября 2026 г.), но не получается");
    expect(copy?.copy).toContain("гражданство Казахстан, въезд 1 сентября 2026 г.");
    expect(flat(f.sent.at(-1)?.reply).some(b=>"url" in b && b.url.includes("kpfu.ru"))).toBe(true);
    expect(f.sent.at(-1)?.reply.text).toContain("kpfu.ru");
  });
  it("keeps the generic help reachable before onboarding, with copy and link buttons", () => {
    const r=transition(null,{text:"/help",callback:false},ctx).reply;
    expect(flat(r).map(b=>Object.keys(b).sort().join())).toEqual(["copy,text","text,url"]);
  });
  it("opens the card from an old reminder even after other actions", async () => {
    // The 7-day reminder for the 30.09 deadline falls on 23.09.
    const f=await fixture(); f.time("2026-09-23T10:00:00+03:00"); await f.onboard(); await f.click("reminders"); await f.service.flush();
    const reminder=f.sent.find(x=>x.reply.text.includes("Напоминание:"))!.reply;
    const details=flat(reminder).find(b=>"action" in b && b.action.endsWith("|card:medical-examination:reminder")) as {action:string};
    await f.click("doc:medical-examination:passport"); await f.click("done:fingerprinting");
    expect((await f.store.get(1))?.step).toBe("completion");
    await f.input(details.action,1,"old-reminder",true); await f.service.flush();
    expect((await f.store.get(1))?.step).toBe("plan");
    expect(f.sent.at(-1)?.reply.text).toContain("Расчётный предельный срок");
  });
  it("still rejects stale buttons that change state", async () => {
    const f=await fixture(); await f.onboard(); const s=(await f.store.get(1))!;
    await f.click("card:fingerprinting");
    await f.input(`${s.nonce}.${s.revision}|reminders`,1,"stale-toggle",true);
    expect((await f.store.get(1))?.reminders).toBe(false);
    await f.input(`${s.nonce}.${s.revision}|done:fingerprinting`,1,"stale-done",true);
    expect((await f.store.get(1))?.step).toBe("plan");
  });
  it("maps link and clipboard buttons for MAX and retries attachment.not.ready", async () => {
    let calls=0;
    const mocked = vi.fn(() => Promise.resolve(++calls===1
      ? new Response(JSON.stringify({code:"attachment.not.ready",message:"not ready"}),{status:400})
      : new Response(JSON.stringify({message:{body:{mid:"fake"}}}),{status:200})));
    vi.stubGlobal("fetch",mocked);
    try {
      const transport=createTransport(readConfig({TRANSPORT:"max",MAX_BOT_TOKEN:"test-token",
        WEBHOOK_SECRET:"your-demo-secret-change-before-deploy",DATABASE_URL:"postgresql://unused"}));
      await transport.send(123,{text:"DEMO",ruleVersion:"test",buttons:[[{text:"Law",url:"https://example.org/law"}],[{text:"Copy",copy:"question"}]]});
      expect(mocked).toHaveBeenCalledTimes(2);
      const body=JSON.parse((mocked.mock.calls[1] as unknown as [string,RequestInit])[1].body as string) as {attachments:[{payload:{buttons:unknown}}]};
      expect(body.attachments[0].payload.buttons).toEqual([[{type:"link",text:"Law",url:"https://example.org/law"}],[{type:"clipboard",text:"Copy",payload:"question"}]]);
    } finally { vi.unstubAllGlobals(); }
  });
});
describe("queue storage performance guards", () => {
  it("finds a user's queued jobs through an index, not a full scan of the outbox", async () => {
    const f=await fixture(), client=await f.pool.connect();
    try {
      await client.query("BEGIN");
      // An empty table is cheapest to scan; forbid that to see whether an index serves the query at all.
      await client.query("SET LOCAL enable_seqscan = off");
      for (const sql of ["DELETE FROM outbox WHERE user_id=1 AND kind='reminder' AND status='pending'",
        "DELETE FROM outbox WHERE user_id=1 AND kind='reply' AND status='pending'", "DELETE FROM outbox WHERE user_id=1"]) {
        const plan=(await client.query<{"QUERY PLAN":string}>("EXPLAIN "+sql)).rows.map(r=>r["QUERY PLAN"]).join(" ");
        expect(plan).toMatch(/outbox_user_kind_status_idx/);
      }
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});

describe("plan button for the mini app", () => {
  const planReply = (context: typeof ctx & { webApp?: string }, start: string) => {
    let session: Session | null = null, reply: Reply | undefined;
    for (const text of [start, "ru", "accept", "yes", "KZ", "2026-09-01"]) {
      const out = transition(session, { text, callback: false }, context);
      session = out.session; reply = out.reply;
    }
    return reply!;
  };
  it("opens the app for the student's university once the app is registered, and stays off before", () => {
    const off = planReply(ctx, "/start itmo");
    expect(off.buttons.flat().some(b => "app" in b)).toBe(false);
    const on = planReply({ ...ctx, webApp: "t149_hakaton_max_bot" }, "/start itmo");
    expect(on.buttons.flat().filter(b => "app" in b)).toEqual([
      { text: "📱 План в мини-приложении", app: "t149_hakaton_max_bot", payload: "itmo" },
    ]);
  });
  it("refuses a bot name that is not one", () => {
    const env = { DATABASE_URL: "postgresql://x" };
    expect(readConfig({ ...env, WEBAPP_BOT: "t149_hakaton_max_bot" }).webappBot).toBe("t149_hakaton_max_bot");
    expect(readConfig(env).webappBot).toBe("");
    expect(() => readConfig({ ...env, WEBAPP_BOT: "https://max.ru/bot" })).toThrow(/WEBAPP_BOT/);
  });
});

describe("review fixes in the dialogue", () => {
  it("keeps the next screen when a button is tapped twice", async () => {
    const f = await fixture();
    await f.input("/start"); await f.click("ru");
    const s = (await f.store.get(1))!;
    const stamp = `${s.nonce}.${s.revision}|accept`;
    await f.input(stamp, 1, "tap-1", true); await f.input(stamp, 1, "tap-2", true);
    await f.service.flush();
    expect(f.sent.some(m => m.reply.text.includes("Сценарий:"))).toBe(true);
  });
  it("returns to the step the user left when a deletion is cancelled", () => {
    let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
    const click = (action: string) => { s = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx).session!; };
    for (const a of ["ru", "accept", "yes"]) click(a);
    s = transition(s, { text: "/delete", callback: false }, ctx).session!;
    click("cancel-delete");
    expect(s.step).toBe("citizenship");
  });
  it("tells only an unsupported case that it is unsupported", () => {
    let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
    const click = (action: string) => transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);
    for (const a of ["ru", "accept", "yes", "KZ"]) s = click(a).session!;
    expect(click("OTHER").reply.text).toContain("Для неподдержанного случая");
    expect(click("BY").reply.text).toContain("Для неподдержанного случая");
    s = transition(s, { text: "2026-09-01", callback: false }, ctx).session!;
    const help = click("help").reply.text;
    expect(help).toContain("Подготовьте вопрос");
    expect(help).not.toContain("Для неподдержанного случая");
  });
  describe("unsupported case (#68)", () => {
    const start = (...path: string[]) => {
      let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
      const click = (action: string) => transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);
      for (const a of path) s = click(a).session!;
      return { click, set: (n: Session) => { s = n; }, session: () => s };
    };
    const backAction = (r: Reply) => (r.buttons.flat().find(b => b.text === "← Назад") as { action: string } | undefined)?.action.split("|")[1];
    it("'no' on the scope question: names the scope conditions, including the entry date", () => {
      const reply = start("ru", "accept").click("no").reply;
      expect(reply.text).toContain("Причина: условия сценария не совпали");
      expect(reply.text).toContain("въезд с 1 сентября 2026 г.");
    });
    it("'no': the back button returns to the scope question", () => {
      const f = start("ru", "accept"), no = f.click("no");
      expect(backAction(no.reply)).toBe("back");
      f.set(no.session!);
      const back = f.click("back");
      expect(back.reply.text).toContain("Сценарий: вам 18+");
      expect(back.reply.buttons.flat().map(b => b.text)).toContain("Да, совпадает");
    });
    it("a citizenship the rules exclude (BY): says the rules have no deadlines for it", () => {
      expect(start("ru", "accept", "yes").click("BY").reply.text).toContain("для этого гражданства в правилах бота нет сроков");
    });
    it("'Other' citizenship: does not say there are no deadlines, says to ask the university", () => {
      const text = start("ru", "accept", "yes").click("OTHER").reply.text;
      expect(text).not.toContain("нет сроков");
      expect(text).toContain("Сроки для вас могут действовать — уточните в вузе");
    });
    it("'Other': the back button returns to the citizenship question", () => {
      const f = start("ru", "accept", "yes"), other = f.click("OTHER");
      f.set(other.session!);
      const back = f.click(backAction(other.reply)!);
      expect(back.reply.text).toContain("Выберите гражданство");
      expect(back.session!.step).toBe("citizenship");
    });
    it("the draft question asks which deadlines apply, not for help with a procedure (#82)", () => {
      const copy = (r: Reply) => (r.buttons.flat().find(b => "copy" in b) as { copy: string } | undefined)?.copy ?? "";
      for (const lang of ["ru", "en", "tt", "uz", "zh"] as const) {
        const table = texts.get(lang)!, [before, after] = table["help.unsupported.draft"]!.split("{uni}");
        for (const reply of [start(lang, "accept").click("no").reply, start(lang, "accept", "yes").click("OTHER").reply, start(lang, "accept", "yes").click("BY").reply]) {
          expect(copy(reply), lang).toContain(before);
          expect(copy(reply), lang).toContain(after);
          expect(reply.text, lang).toContain(copy(reply));
          expect(reply.text, lang).not.toContain(table["help.generic"]!.split("{draft}")[0]);
        }
      }
      expect(copy(start("ru", "accept", "yes").click("OTHER").reply)).toContain("какие процедуры и сроки после въезда");
    });
    it("with a plan there is no question to go back to: no reason, no back button", () => {
      const f = start("ru", "accept", "yes");
      f.set(f.click("KZ").session!);
      const session = transition(f.session(), { text: "2026-09-01", callback: false }, ctx).session!;
      f.set(session);
      const reply = f.click("no").reply;
      expect(reply.text).not.toContain("Причина");
      expect(backAction(reply)).toBeUndefined();
    });
  });
  it("offers a Start button after /delete that begins a new session", () => {
    let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
    s = transition(s, { text: "/delete", callback: false }, ctx).session!;
    const deleted = transition(s, { text: `${s.nonce}.${s.revision}|confirm-delete`, callback: true }, ctx);
    expect(deleted.session).toBeNull();
    const start = deleted.reply.buttons.flat()[0]!;
    expect("action" in start && start.text).toBe("Начать");
    const again = transition(null, { text: "action" in start ? start.action : "", callback: true }, ctx);
    expect(again.expired).toBeUndefined();
    expect(again.session?.step).toBe("language");
    const lang = again.reply.buttons.flat().find(x => "action" in x && x.action.endsWith("|ru"))!;
    const picked = transition(again.session, { text: "action" in lang ? lang.action : "", callback: true }, ctx);
    expect(picked.session?.step).toBe("consent");
    expect(again.reply.text).toBe(transition(null, { text: "/start", callback: false }, ctx).reply.text);
  });
  it("answers /stop before the plan with a button back to the current step, without /plan (#96)", () => {
    let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
    const click = (action: string) => transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);
    for (const a of ["ru", "accept", "yes"]) s = click(a).session!;
    const step = s.step;
    const stopped = transition(s, { text: "/stop", callback: false }, ctx);
    expect(stopped.reply.text).not.toContain("/plan");
    s = stopped.session!;
    const back = stopped.reply.buttons.flat()[0];
    expect("action" in back && click(back.action.slice(back.action.indexOf("|") + 1)).reply.text).toBe(transition(s, { text: "", callback: false }, ctx).reply.text);
    expect(s.step).toBe(step);
  });
  it("offers the next step as a button after /stop and on the completion date", () => {
    let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
    const click = (action: string) => transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);
    for (const a of ["ru", "accept", "yes", "KZ"]) s = click(a).session!;
    s = transition(s, { text: "2026-09-01", callback: false }, ctx).session!;
    const actions = (r: Reply) => r.buttons.flat().flatMap(b => "action" in b ? [b.action.slice(b.action.indexOf("|") + 1)] : []);
    const stopped = transition(s, { text: "/stop", callback: false }, ctx);
    expect(actions(stopped.reply)).toContain("plan");
    s = stopped.session!;
    expect(click("plan").session!.step).toBe("plan");
    s = click("card:medical-examination").session!;
    const asked = click("done:medical-examination");
    s = asked.session!;
    expect(actions(asked.reply)).toContain("/today");
    const date = click("/today");
    expect(date.session!.step).toBe("plan");
    expect(date.session!.completions["medical-examination"]).toBe("2026-09-24");
  });
});
describe("changing the citizenship before the plan (#69)", () => {
  const atEntry = () => {
    let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
    const click = (action: string) => transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);
    for (const a of ["ru", "accept", "yes", "KZ"]) s = click(a).session!;
    return { click, set: (n: Session) => { s = n; }, session: () => s };
  };
  const change = (r: Reply) => (r.buttons.flat().find(b => b.text === "← Изменить гражданство") as { action: string } | undefined)?.action.split("|")[1];
  it("the entry step offers the button, on its question and after a wrong date", () => {
    const f = atEntry();
    expect(change(transition(f.session(), { text: "/start", callback: false }, ctx).reply)).toBe("back");
    expect(change(transition(f.session(), { text: "2026-02-30", callback: false }, ctx).reply)).toBe("back");
  });
  it("the button returns to the citizenship question", () => {
    const f = atEntry();
    const back = f.click("back");
    expect(back.session!.step).toBe("citizenship");
    expect(back.reply.text).toContain("Выберите гражданство");
    expect(back.session!.citizenship).toBeUndefined();
  });
  it("the new citizenship is saved and the entry date is asked again", () => {
    const f = atEntry();
    f.set(f.click("back").session!);
    const entry = f.click("KG");
    expect(entry.session!.citizenship).toBe("KG");
    expect(entry.session!.step).toBe("entry");
  });
  it("with a plan there is no such button", () => {
    const f = atEntry();
    f.set(transition(f.session(), { text: "2026-09-01", callback: false }, ctx).session!);
    expect(change(f.click("plan").reply)).toBeUndefined();
    expect(f.click("back").session!.step).toBe("plan");
  });
});
describe("example profile for reviewers (demo only)", () => {
  const actions = (r?: Reply) => (r?.buttons.flat() ?? []).flatMap(b => "action" in b ? [b.action.split("|")[1]] : []);
  it("offers an example entry date whose first reminder is due the same day", async () => {
    const f=await fixture(); f.time("2026-09-30T10:00:00+03:00");
    await f.input("/start"); await f.click("ru"); await f.click("accept"); await f.click("yes"); await f.click("KZ");
    await f.service.flush();
    const prompt=f.sent.at(-1)?.reply;
    expect(actions(prompt)).toContain("example");
    expect(prompt?.buttons.flat().map(b=>b.text).join()).toContain("8 сентября 2026");
    await f.click("example");
    expect(await f.store.get(1)).toMatchObject({ entryDate: "2026-09-08", step: "plan" });
    await f.click("reminders"); await f.service.flush();
    expect(f.sent.some(x=>x.reply.text.includes("Напоминание:"))).toBe(true);
  });
  it("has no example outside the demo and treats the word as an invalid date", () => {
    const live={...ctx, demo:false};
    let state:Session|null=null, reply:Reply|undefined;
    for (const text of ["/start","ru","accept","yes","KZ"]) {
      const r=transition(state,{text,callback:false},live); state=r.session; reply=r.reply;
    }
    expect(state?.step).toBe("entry");
    expect(actions(reply)).not.toContain("example");
    const r=transition(state,{text:"example",callback:false},live);
    expect(r.session?.step).toBe("entry"); expect(r.session?.entryDate).toBeUndefined();
  });
  it("derives the date from the rules and never goes before the scenario start", () => {
    expect(exampleEntry({ rules: rules.rules, today: "2026-09-30" })).toBe("2026-09-08");
    expect(exampleEntry({ rules: rules.rules, today: "2026-10-14" })).toBe("2026-09-22");
    expect(exampleEntry({ rules: rules.rules, today: "2026-09-10" })).toBe("2026-09-01");
  });
});
