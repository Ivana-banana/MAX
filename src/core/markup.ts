/**
 * Emphasis in interface texts (#114). The texts in src/data/i18n mark bold as **…** and italics as
 * *…*: the MAX chat gets them as HTML (`format: "html"`), plain channels — PDF, calendar, poster,
 * copied and shared text — get the words without the markers, and the mini app draws them itself.
 * Underscores stay plain text: the question drafts use "___" as a blank to fill in.
 */

const BOLD = /\*\*(.+?)\*\*/gs;
const ITALIC = /\*(.+?)\*/gs;
const ADDRESS = /(https?:\/\/[^\s<>"«»*]+)/;

/** The text without emphasis markers: for the PDF, the calendar, the clipboard and shared copies. */
export const plain = (text: string): string => text.replace(BOLD, "$1").replace(ITALIC, "$1");

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** An address as a link named by its domain; punctuation that ends a sentence after it stays outside. */
function link(whole: string): string {
  const url = whole.replace(/[.,;:!?)]+$/, "");
  if (!URL.canParse(url)) return escape(whole);
  const host = new URL(url).hostname.replace(/^www\./, "");
  return `<a href="${escape(url)}">${host}</a>${escape(whole.slice(url.length))}`;
}

/**
 * The text as MAX HTML: everything escaped, **…** as <b>, *…* as <i>, and an address as a link
 * named by its domain, so a law page is "consultant.ru" instead of a line of path segments.
 * Markers are read only between addresses, so nothing inside an address is taken for one.
 */
export function toHtml(text: string): string {
  return text.split(ADDRESS).map((part, i) => i % 2 ? link(part)
    : escape(part).replace(BOLD, "<b>$1</b>").replace(ITALIC, "<i>$1</i>")).join("");
}
