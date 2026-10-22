/**
 * Emphasis in interface texts (#114). The texts in src/data/i18n mark bold as **…**: the MAX chat
 * gets it as HTML (`format: "html"`), plain channels — PDF, calendar, copied and shared text — get
 * the words without the marker, and the mini app draws <strong> itself.
 */

const BOLD = /\*\*(.+?)\*\*/gs;
const ADDRESS = /https?:\/\/[^\s<>"«»]+/g;

/** The text without emphasis markers: for the PDF, the calendar, the clipboard and shared copies. */
export const plain = (text: string): string => text.replace(BOLD, "$1");

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The text as MAX HTML: everything escaped, **…** as <b>, and an address as a link named by its
 * domain, so a law page is "consultant.ru" instead of a line of path segments. Punctuation that
 * ends a sentence after an address stays outside the link.
 */
export function toHtml(text: string): string {
  return escape(text)
    .replace(ADDRESS, whole => {
      const url = whole.replace(/[.,;:!?)]+$/, "");
      if (!URL.canParse(url.replaceAll("&amp;", "&"))) return whole;
      const host = new URL(url.replaceAll("&amp;", "&")).hostname.replace(/^www\./, "");
      return `<a href="${url}">${host}</a>${whole.slice(url.length)}`;
    })
    .replace(BOLD, "<b>$1</b>");
}
