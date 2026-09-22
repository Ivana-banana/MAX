import { Bot, Keyboard } from "@maxhub/max-bot-api";
import type { Transport } from "./service.js";
import type { Config } from "./config.js";
export function createTransport(config: Config): Transport {
  if (config.transport === "console") return {
    async send(_user, reply) { console.log("[MOCKED: MAX delivery; synthetic demo only]", JSON.stringify(reply)); },
  };
  const bot = new Bot(config.token, { clientOptions: {
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }),
  } });
  let lastRequest = 0;
  async function pace(): Promise<void> {
    const delay = Math.max(0, lastRequest + 100 - Date.now());
    lastRequest = Date.now() + delay;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  }
  return {
    async send(user, reply) {
      await pace();
      await bot.api.sendMessageToUser(user, reply.text, reply.buttons.length ? {
        attachments: [Keyboard.inlineKeyboard(reply.buttons.map(row => row.map(b => Keyboard.button.callback(b.text, b.action))))],
      } : {});
    },
    async answer(id) { await pace(); await bot.api.answerOnCallback(id); },
  };
}
