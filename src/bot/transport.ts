import { Bot, Keyboard, MaxError } from "@maxhub/max-bot-api";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "./service.js";
import type { Config } from "./config.js";
import type { Button, Reply } from "./dialog.js";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const toButton = (b: Button) => "url" in b ? Keyboard.button.link(b.text, b.url)
  : "copy" in b ? Keyboard.button.clipboard(b.text, b.copy)
  : "app" in b ? Keyboard.button.openApp(b.text, b.app, undefined, b.payload) : Keyboard.button.callback(b.text, b.action);
export function createTransport(config: Config): Transport {
  if (config.transport === "console") return {
    send(_user, reply) {
      const { file, ...rest } = reply;
      console.log("[MOCKED: MAX delivery; synthetic demo only]", JSON.stringify(file ? { ...rest, file: file.name } : rest));
      return Promise.resolve();
    },
  };
  const bot = new Bot(config.token, { clientOptions: {
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }),
  } });
  let lastRequest = 0;
  async function pace(): Promise<void> {
    const delay = Math.max(0, lastRequest + 100 - Date.now());
    lastRequest = Date.now() + delay;
    if (delay) await sleep(delay);
  }
  // The SDK names a Buffer upload with a random UUID; a path keeps the .ics and .pdf extensions phones need.
  async function upload(file: NonNullable<Reply["file"]>) {
    const dir = await mkdtemp(join(tmpdir(), "max-file-"));
    try {
      await writeFile(join(dir, file.name), Buffer.from(file.content, file.encoding ?? "utf8"));
      await pace();
      return (await bot.api.uploadFile({ source: join(dir, file.name) })).toJson();
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  return {
    async send(user, reply) {
      const attachments = [
        ...(reply.file ? [await upload(reply.file)] : []),
        ...(reply.buttons.length ? [Keyboard.inlineKeyboard(reply.buttons.map(row => row.map(toButton)))] : []),
      ];
      // MAX processes uploads asynchronously and rejects early sends with attachment.not.ready.
      for (let attempt = 1; ; attempt++) {
        await pace();
        try { await bot.api.sendMessageToUser(user, reply.text, attachments.length ? { attachments } : {}); return; }
        catch (e) {
          if (!(e instanceof MaxError && e.code === "attachment.not.ready") || attempt >= 5) throw e;
          await sleep(500 * attempt);
        }
      }
    },
    // `notification` is in the body of POST /answers in the official SDK source (max-bot-api-client-ts) and
    // the Go client, but not yet in the 0.3.1 types; the SDK passes the body through as is (D-055).
    async answer(id, notification) {
      await pace();
      const extra: Parameters<typeof bot.api.answerOnCallback>[1] & { notification?: string } = notification ? { notification } : {};
      await bot.api.answerOnCallback(id, extra);
    },
  };
}
