import { describe, expect, it, vi } from "vitest";
import { MaxError } from "@maxhub/max-bot-api";
import { plain, toHtml } from "../src/core/markup.js";
import { parseTexts, readTexts } from "../src/data/loadTexts.js";
import { createTransport } from "../src/bot/transport.js";
import type { Config } from "../src/bot/config.js";

const sent = vi.hoisted(() => [] as { text: string; extra: Record<string, unknown> }[]);
const failures = vi.hoisted(() => [] as Error[]);
vi.mock("@maxhub/max-bot-api", async original => {
  const real = await original<typeof import("@maxhub/max-bot-api")>();
  class Bot {
    api = {
      sendMessageToUser: (_user: number, text: string, extra: Record<string, unknown>) => {
        sent.push({ text, extra });
        const failure = failures.shift();
        return failure ? Promise.reject(failure) : Promise.resolve({});
      },
    };
  }
  return { ...real, Bot };
});

describe("emphasis in interface texts (#114)", () => {
  it("MAX gets bold as <b> and the rest escaped", () => {
    expect(toHtml("**Ваш план** <скоро> & сразу")).toBe("<b>Ваш план</b> &lt;скоро&gt; &amp; сразу");
    expect(toHtml("**Сценарий**\n• вам 18+\n\n**Всё совпадает?** Да")).toBe("<b>Сценарий</b>\n• вам 18+\n\n<b>Всё совпадает?</b> Да");
  });

  it("italics go as <i>; the demo banner is italic in every language", () => {
    expect(toHtml("*ДЕМО · учебные данные.*\n\n**Ваш план**")).toBe("<i>ДЕМО · учебные данные.</i>\n\n<b>Ваш план</b>");
    for (const [lang, table] of readTexts("src/data/i18n")) expect(toHtml(table["banner.demo"]!), lang).toMatch(/^<i>[^<]+<\/i>\n\n$/);
  });

  it("an address becomes a link named by its domain; the sentence's punctuation stays outside", () => {
    const law = "https://www.consultant.ru/document/cons_doc_LAW_37868/e9d581e7e11d7901295efd89c869ae044dd3d20f/";
    expect(toHtml(`Основание:\n${law}\nСверка`)).toBe(`Основание:\n<a href="${law}">consultant.ru</a>\nСверка`);
    expect(toHtml("Контакты: https://kpfu.ru/international.")).toBe('Контакты: <a href="https://kpfu.ru/international">kpfu.ru</a>.');
    expect(toHtml("(https://kpfu.ru/a)")).toBe('(<a href="https://kpfu.ru/a">kpfu.ru</a>)');
    expect(toHtml("https://yandex.ru/maps/?text=a&b=c")).toBe('<a href="https://yandex.ru/maps/?text=a&amp;b=c">yandex.ru</a>');
  });

  it("underscores stay text: in an address and in the drafts' blanks", () => {
    expect(toHtml("**cons_doc_LAW_37868** https://x.ru/cons_doc_LAW_1")).toBe('<b>cons_doc_LAW_37868</b> <a href="https://x.ru/cons_doc_LAW_1">x.ru</a>');
    expect(toHtml("Проблема: ___. Ответ: __")).toBe("Проблема: ___. Ответ: __");
  });

  it("plain channels keep the words and the full address", () => {
    expect(plain("*ДЕМО*\n\n**Ваш план**\n• **Медосвидетельствование**\n  **30 сентября** — https://kpfu.ru/a"))
      .toBe("ДЕМО\n\nВаш план\n• Медосвидетельствование\n  30 сентября — https://kpfu.ru/a");
  });

  it("refuses a text with an unclosed marker", () => {
    expect(() => parseTexts("ru", { scope: "**Сценарий: вам 18+" })).toThrow(/незакрытое выделение/);
    expect(() => parseTexts("ru", { "banner.demo": "*ДЕМО · учебные данные.\n" })).toThrow(/незакрытый курсив/);
    expect(() => parseTexts("ru", { scope: "**Сценарий** вам 18+", "banner.demo": "*ДЕМО*\n" })).not.toThrow();
  });
});

describe("sending to MAX (#114)", () => {
  const transport = () => createTransport({ transport: "max", token: "test-token" } as Config);
  const reply = { text: "**План**\nhttps://kpfu.ru/a", buttons: [[{ text: "Скопировать", copy: "**Вопрос** вузу" }]], ruleVersion: "v" };

  it("sends HTML with format html; a copied text goes without markers", async () => {
    sent.length = 0;
    await transport().send(1, reply);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe('<b>План</b>\n<a href="https://kpfu.ru/a">kpfu.ru</a>');
    expect(sent[0]!.extra.format).toBe("html");
    expect(JSON.stringify(sent[0]!.extra.attachments)).toContain('"Вопрос вузу"');
  });

  it("when MAX refuses the markup, sends the same words once without it", async () => {
    sent.length = 0;
    failures.push(new MaxError(400, { code: "proto.payload", message: "bad markup" }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await transport().send(1, reply);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toBe("План\nhttps://kpfu.ru/a");
    expect(sent[1]!.extra.format).toBeUndefined();
    expect(errors.mock.calls[0]![0]).toContain("MAX refused the HTML markup");
    errors.mockRestore();
  });

  it("when MAX refuses the mini-app button too, the message goes once more without it (#127)", async () => {
    sent.length = 0;
    const app = { ...reply, buttons: [[{ text: "Открыть план", app: "bot_name", payload: "plan" }, { text: "Скопировать", copy: "Вопрос" }]] };
    failures.push(new MaxError(400, { code: "proto.payload", message: "bad web_app" }), new MaxError(400, { code: "proto.payload", message: "bad web_app" }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await transport().send(1, app);
    expect(sent).toHaveLength(3);
    expect(JSON.stringify(sent[1]!.extra.attachments)).toContain("open_app");
    expect(JSON.stringify(sent[2]!.extra.attachments)).not.toContain("open_app");
    expect(JSON.stringify(sent[2]!.extra.attachments)).toContain("Скопировать");
    expect(errors.mock.calls[1]![0]).toContain("MAX refused the mini-app button");
    errors.mockRestore();
  });

  it("another failure is not retried without markup: the outbox retries it", async () => {
    sent.length = 0;
    failures.push(new MaxError(500, { code: "internal", message: "down" }));
    await expect(transport().send(1, reply)).rejects.toBeInstanceOf(MaxError);
    expect(sent).toHaveLength(1);
  });
});
