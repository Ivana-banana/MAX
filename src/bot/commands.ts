import { format, type Texts } from "../data/loadTexts.js";

/** Commands the dialogue understands as typed text; MAX shows them as hints after "/". */
export const COMMANDS = ["start", "plan", "change", "help", "stop", "delete"] as const;

// PATCH /me/commands has one description per command, not one per language: Russian and
// English together cover the interface's base language and the common one.
export function botCommands(texts: Texts): { name: string; description: string }[] {
  const langs = ["ru", "en"].filter(lang => texts.has(lang));
  return COMMANDS.map(name => ({ name, description: langs.map(lang => format(texts, lang, `command.${name}`)).join(" / ") }));
}
