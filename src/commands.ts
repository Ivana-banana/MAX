import { Bot } from "@maxhub/max-bot-api";
import { botCommands } from "./bot/commands.js";
import { readTexts } from "./data/loadTexts.js";

// Sets the command hints shown after "/" in MAX (PATCH /me/commands). Does not touch the
// webhook subscription. --dry-run prints the list without a token.
const commands = botCommands(readTexts(process.env.TEXTS_PATH ?? "./src/data/i18n"));
for (const c of commands) console.log(`/${c.name} — ${c.description}`);
if (!process.argv.includes("--dry-run")) {
  const token = process.env.MAX_BOT_TOKEN ?? ""; // secret-scan: allow — environment lookup, not a credential
  if (!token) throw new Error("MAX_BOT_TOKEN is required; use --dry-run to only print the list");
  const bot = new Bot(token, { clientOptions: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }) } });
  const result = await bot.api.setMyCommands(commands);
  console.log(`MAX confirmed ${result.commands?.length ?? 0} commands. Check the hints after "/" in mobile and web MAX.`);
}
