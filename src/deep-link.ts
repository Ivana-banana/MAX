/**
 * The bot link that opens one university's scenario: https://max.ru/<bot>?start=<university id> (D-018).
 * Kept apart from poster.ts: the bot uses it at run time (#129), the QR library behind the poster is a
 * dev-only tool and is not in the production image (#133).
 */

import type { University } from "./data/loadUniversities.js";

/** The deep link the QR code encodes; MAX passes `start` to the bot as the bot_started payload. */
export function deepLink(botLink: string, university: University): string {
  const url = new URL(botLink);
  if (url.protocol !== "https:" || url.search || url.hash) throw new Error("BOT_LINK must be https://max.ru/<bot> without parameters");
  url.searchParams.set("start", university.id);
  return url.href;
}
