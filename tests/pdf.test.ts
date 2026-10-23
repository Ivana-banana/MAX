import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import { planPdf, transition, type Reply, type Session } from "../src/bot/dialog.js";
import { renderPlanPdf } from "../src/bot/pdf.js";
import { Service } from "../src/bot/service.js";
import { testSchema } from "./pg.js";

// The real renderer, replaceable in one test to see the failure path.
vi.mock("../src/bot/pdf.js", async original => {
  const real = await original<typeof import("../src/bot/pdf.js")>();
  return { ...real, renderPlanPdf: vi.fn(real.renderPlanPdf) };
});

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };
const press = (s: Session, action: string) => transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);

function planned(lang = "ru"): Session {
  let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
  for (const a of [lang, "accept", "yes", "KZ"]) s = press(s, a).session!;
  return transition(s, { text: "2026-09-01", callback: false }, ctx).session!;
}
/**
 * The text a PDF reader shows: glyph ids of the content streams mapped back through the ToUnicode
 * table pdfkit writes. A glyph the font lacks has no Unicode there, so a missing character is lost.
 * Whitespace is dropped: lines wrap at spaces.
 */
function pdfText(pdf: Buffer): string {
  const streams = [...pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
    .map(m => { try { return inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1"); } catch { return ""; } });
  const unicode = new Map<number, string>();
  for (const s of streams) {
    for (const [, from, list] of s.matchAll(/<([0-9a-f]{4})>\s*<[0-9a-f]{4}>\s*\[([^\]]*)\]/gi)) {
      // A ligature maps to several characters: "<0066 0069>" is "fi".
      [...list!.matchAll(/<([0-9a-f\s]*)>/gi)].forEach(([, hex], i) => {
        const units = hex!.replace(/\s/g, "").match(/.{4}/g)?.map(u => parseInt(u, 16)) ?? [];
        unicode.set(parseInt(from!, 16) + i, String.fromCharCode(...units));
      });
    }
  }
  return streams.flatMap(s => [...s.matchAll(/\[([^\]]*)\]\s*TJ/g)])
    .flatMap(([, run]) => [...run!.matchAll(/<([0-9a-f]+)>/gi)].flatMap(([, hex]) => hex!.match(/.{4}/g) ?? []))
    .map(id => unicode.get(parseInt(id, 16)) ?? "").join("").replace(/\s+/g, "");
}
const squeeze = (text: string) => text.replace(/\s+/g, "");

describe("plan as a PDF (#92)", () => {
  it("contains the deadlines of the plan, the marks, the legal basis and the university contact", async () => {
    let s = planned();
    s = press(s, "done:fingerprinting").session!;
    s = transition(s, { text: "2026-09-20", callback: false }, ctx).session!;
    const pdf = await renderPlanPdf(planPdf(s, ctx));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const text = pdfText(pdf);
    expect(text).toContain(squeeze("Медицинское освидетельствование"));
    expect(text).toContain(squeeze("Расчётный предельный срок: 30 сентября 2026 г."));
    expect(text).toContain(squeeze("Пройдено 20 сентября 2026 г. (отметка студента)"));
    expect(text).toContain(squeeze("Федеральный закон"));
    expect(text).toContain(squeeze(universities.find(u => u.id === "kfu")!.contactUrl));
    expect(text).toContain(squeeze("ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ"));
    expect(text).not.toContain("Казахстан");
  });

  it("has no demo mark outside the demo profile", async () => {
    const text = pdfText(await renderPlanPdf(planPdf(planned(), { ...ctx, demo: false })));
    expect(text).toContain(squeeze("30 сентября 2026 г."));
    expect(text).not.toContain(squeeze("ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ"));
  });

  it("renders every character of the plan in each language, Chinese included", async () => {
    for (const lang of texts.keys()) {
      const plan = planPdf(planned(lang), ctx);
      const text = pdfText(await renderPlanPdf(plan));
      expect(text, lang).toBe(squeeze([plan.title, ...plan.notes, ...plan.sections.flatMap(x => [x.heading, x.body]), plan.footer].join("")));
    }
  });

  it("shows a marked yearly procedure as a repeat round, as the plan does, in each language", async () => {
    for (const lang of texts.keys()) {
      let s = press(planned(lang), "done:medical-examination").session!;
      s = transition(s, { text: "2026-09-24", callback: false }, ctx).session!;
      const plan = planPdf(s, ctx);
      const text = pdfText(await renderPlanPdf(plan));
      expect(text, lang).toBe(squeeze([plan.title, ...plan.notes, ...plan.sections.flatMap(x => [x.heading, x.body]), plan.footer].join("")));
      if (lang === "ru") expect(text).toContain(squeeze("Повторно (ежегодно). Пройдено вами 24 сентября 2026 г."));
    }
  });

  it("answers the button with a loading notice and offers a retry when the file cannot be built", () => {
    const outcome = press(planned(), "pdf");
    expect(outcome.reply.text).toContain("PDF с вашим планом");
    expect(outcome.notice).toBe("Готовлю PDF…");
    expect(outcome.reply.failed?.text).toContain("Не удалось отправить PDF");
    expect(outcome.reply.failed?.buttons.flat().map(b => b.text)).toEqual(["Повторить", "К плану"]);
  });

  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
  async function service() {
    const schema = await testSchema(); cleanups.push(schema.drop);
    const { store } = await schema.open(); cleanups.push(() => store.close());
    const sent: Reply[] = [];
    // `refuseFiles`: MAX does not take the upload, as with a network failure or attachment.not.ready to the end.
    const transport = { refuseFiles: false, send(_user: number, reply: Reply) {
      if (transport.refuseFiles && reply.file) return Promise.reject(new Error("upload failed"));
      sent.push(reply); return Promise.resolve();
    } };
    const svc = new Service(store, ctx, transport, () => Date.parse("2026-09-24T10:00:00+03:00"));
    let n = 0;
    const input = (text: string, callback = false) => svc.receive({ id: String(++n), user: 1, input: { text, callback } });
    const click = async (action: string) => { const s = (await store.get(1))!; return input(`${s.nonce}.${s.revision}|${action}`, true); };
    await input("/start");
    for (const a of ["ru", "accept", "yes", "KZ"]) await click(a);
    await input("2026-09-01");
    return { svc, sent, click, transport };
  }

  it("sends the file through the outbox as base64 and returns the loading notice for the button", async () => {
    const f = await service();
    expect(await f.click("pdf")).toBe("Готовлю PDF…");
    await f.svc.flush();
    const file = f.sent.at(-1)?.file;
    expect(file?.name).toBe("first-90-days-plan.pdf");
    expect(file?.encoding).toBe("base64");
    expect(Buffer.from(file!.content, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("says in the chat that the file failed and keeps the plan, with a retry", async () => {
    const f = await service();
    vi.mocked(renderPlanPdf).mockRejectedValueOnce(new Error("font missing"));
    await f.click("pdf"); await f.svc.flush();
    expect(f.sent.at(-1)?.file).toBeUndefined();
    expect(f.sent.at(-1)?.text).toContain("Не удалось отправить PDF");
    expect(await f.click("pdf")).toBe("Готовлю PDF…");
    await f.svc.flush();
    expect(f.sent.at(-1)?.file?.name).toBe("first-90-days-plan.pdf");
  });

  // #112: a file MAX does not take is said in the chat with a retry, not left in the queue in silence.
  it.each([["pdf", "Не удалось отправить PDF"], ["calendar", "Не удалось отправить файл календаря"]])(
    "says in the chat that the %s file was not delivered, with a retry", async (action, text) => {
      const f = await service();
      f.transport.refuseFiles = true;
      await f.click(action); await f.svc.flush();
      expect(f.sent.at(-1)?.file).toBeUndefined();
      expect(f.sent.at(-1)?.text).toContain(text);
      expect(f.sent.at(-1)?.buttons.flat().map(b => b.text)).toEqual(["Повторить", "К плану"]);
      f.transport.refuseFiles = false;
      await f.click(action); await f.svc.flush();
      expect(f.sent.at(-1)?.file).toBeDefined();
    });

  it("answers the calendar button with a loading notice", async () => {
    const f = await service();
    expect(await f.click("calendar")).toBe("Готовлю файл календаря…");
  });
});
