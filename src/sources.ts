/**
 * Watch over the official pages the data stands on (src/data/sources.json, D-038).
 *
 * A page is compared by quotes, not by hash: menus, counters and dates change every day, while
 * the sentence the bot relies on ("within thirty calendar days of entry") changes only when the
 * rule does. A missing quote means the data must be checked against the page again.
 */

import type { DeadlineRule } from "./core/types.js";
import type { University } from "./data/loadUniversities.js";

export interface Source { url: string; about: string; quotes: string[] }

export function parseSources(raw: unknown): Source[] {
  const list = (raw as { sources?: unknown })?.sources;
  if (!Array.isArray(list)) throw new Error("sources.json: ожидается массив sources");
  return list.map((s: Record<string, unknown>, i) => {
    const where = `sources[${i}]`;
    if (typeof s.url !== "string" || !s.url.startsWith("https://")) throw new Error(`${where}.url: нужна ссылка https://`);
    if (!Array.isArray(s.quotes) || s.quotes.length === 0 || !s.quotes.every(q => typeof q === "string" && q.trim().length >= 5)) {
      throw new Error(`${where}.quotes: нужна хотя бы одна цитата со страницы`);
    }
    return { url: s.url, about: typeof s.about === "string" ? s.about : "", quotes: s.quotes as string[] };
  });
}

/** Every link the rules, university profiles and the production calendar stand on. */
export function dataUrls(rules: DeadlineRule[], universities: University[], calendarUrls: string[]): string[] {
  const urls = [
    ...calendarUrls,
    ...rules.flatMap(r => [r.legal.url, ...(r.documentsSource ? [r.documentsSource.url] : [])]),
    ...universities.flatMap(u => [u.contactUrl, ...u.procedures.map(p => p.source.url), ...u.beforeEntry.map(c => c.source.url)]),
  ];
  return [...new Set(urls)];
}

const ENTITIES: Record<string, string> = { nbsp: " ", ndash: "–", mdash: "—", laquo: "«", raquo: "»", quot: "\"", amp: "&", lt: "<", gt: ">", shy: "" };

/** Visible text of an HTML page, decoded with the charset from the header or the page itself. */
export function pageText(body: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(body.subarray(0, 4096));
  const charset = (/charset=([\w-]+)/i.exec(contentType) ?? /charset=["']?([\w-]+)/i.exec(head))?.[1] ?? "utf-8";
  return new TextDecoder(charset.toLowerCase()).decode(body)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Case, ё/е, dash and quote kinds and whitespace do not matter when looking for a quote. */
export const normalize = (text: string): string => text.toLowerCase()
  .replace(/ё/g, "е").replace(/[\u00AD\u200B]/g, "")
  .replace(/[–—‑−]/g, "-").replace(/[«»“”„"]/g, "\"")
  .replace(/\s+/g, " ").trim();

/** Quotes of the source that the page no longer contains. */
export function checkPage(source: Source, text: string): string[] {
  const page = normalize(text);
  return source.quotes.filter(q => !page.includes(normalize(q)));
}
