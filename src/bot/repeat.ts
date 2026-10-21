import type { Lang, PlanItem } from "../core/types.js";
import { format, type Texts } from "../data/loadTexts.js";

// The one place a repeat round is worded: the plan, the shared copy, the reminder, the card, the PDF,
// the .ics file and the mini app all take their repeat texts from here (#105).

/** A date as people read it, e.g. "20 сентября 2026 г.". */
export const longDate = (lang: Lang, iso: string) =>
  new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

/**
 * A repeat round: `title` is the procedure name with "repeat (yearly)" after it, `label` and `doneOn` are the
 * two parts on their own, `card` is the sentence for the card and the PDF; the period from the rule's data.
 * Undefined for a first round.
 */
export function repeatText(texts: Texts, lang: Lang, item: PlanItem): { title: string; label: string; doneOn: string; card: string } | undefined {
  if (!item.repeat) return undefined;
  const { completedAt, months } = item.repeat;
  const period = format(texts, lang, months === 12 ? "repeat.yearly" : "repeat.everyMonths", { n: months });
  const date = longDate(lang, completedAt);
  const label = format(texts, lang, "repeat.label", { period });
  return { title: `${item.title[lang]}${format(texts, lang, "repeat.separator")}${label}`, label,
    doneOn: format(texts, lang, "repeat.doneOn", { date }), card: format(texts, lang, "card.repeat", { period, date }) };
}
