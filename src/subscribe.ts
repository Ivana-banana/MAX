import { Bot } from "@maxhub/max-bot-api";
import { readConfig, loadRules } from "./bot/config.js";

const config = readConfig();
loadRules(config);
if (config.transport !== "max") throw new Error("Use TRANSPORT=max");
const url = new URL(process.env.WEBHOOK_URL ?? "");
if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.pathname !== "/webhook" || url.search || url.hash || url.username || url.password) {
  throw new Error("WEBHOOK_URL must be https://your-domain/webhook on port 443");
}
const bot = new Bot(config.token, { clientOptions: {
  fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }),
} });
const subscriptions = await bot.api.getSubscriptions();
if (subscriptions.some(s => s.url !== url.href)) throw new Error("Another webhook exists; coordinate with its owner. Nothing changed.");
if (subscriptions.length) throw new Error("A subscription already exists. Inspect it manually; this script will not replace it.");
const response = await bot.api.subscribe(url.href, config.secret, ["bot_started", "message_created", "message_callback"]);
if (!response.success) throw new Error("MAX did not confirm subscription");
console.log("Webhook subscription created. Verify delivery in mobile and web MAX.");
