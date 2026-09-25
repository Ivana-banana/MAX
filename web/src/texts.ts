/**
 * Text lookup for the screens.
 *
 * The app has no dictionary of its own: every string comes with the state, resolved by the server
 * from `src/data/i18n/<язык>.json` (`D-020`). A third language is a file there and nothing here.
 * Strings that depend on a number (the countdown of a plan item) are rendered by the server too,
 * because the plural forms live in that same data.
 */

import type { AppState } from "./api.js";

export type Texts = AppState["texts"];

/**
 * A missing key is a bug in the data, not in the screen: showing the key beats showing nothing,
 * so a forgotten translation is visible instead of silently blanking the interface.
 */
export const text = (texts: Texts, key: string): string => texts[key] ?? key;

/**
 * Whether a server message is the given text. Texts may carry placeholders (`{from}`) the server
 * fills in, so only the fixed part before the first one is compared.
 */
export const isText = (message: string, template: string): boolean => {
  const fixed = template.split("{")[0]!.trim();
  return fixed !== "" && message.includes(fixed);
};
