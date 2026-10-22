/**
 * Text lookup for the screens.
 *
 * The app has no dictionary of its own: every string comes with the state, resolved by the server
 * from `src/data/i18n/<язык>.json` (`D-020`). A third language is a file there and nothing here.
 * Strings that depend on a number (the countdown of a plan item) are rendered by the server too,
 * because the plural forms live in that same data.
 */

import type { AppState } from "../../src/webapp/contract.js";

export type Texts = AppState["texts"];

/**
 * A missing key is a bug in the data, not in the screen: showing the key beats showing nothing,
 * so a forgotten translation is visible instead of silently blanking the interface.
 */
export const text = (texts: Texts, key: string): string => plain(texts[key] ?? key);

/**
 * Chat texts mark bold as **…** (#114). Headings, buttons and labels take the words only; a chat
 * message shown as is goes through `Rich` (ui.tsx), which draws the bold.
 */
export const BOLD = /\*\*(.+?)\*\*/gs;
export const plain = (value: string): string => value.replace(BOLD, "$1");

/**
 * Whether a server message is the given text. Texts may carry placeholders (`{from}`) the server
 * fills in, so only the fixed part before the first one is compared.
 */
export const isText = (message: string, template: string): boolean => {
  const fixed = plain(template).split("{")[0]!.trim();
  return fixed !== "" && plain(message).includes(fixed);
};

/** A chat text with its placeholders filled on the screen, from values the app already has (a visit day). */
export const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole).trim();
