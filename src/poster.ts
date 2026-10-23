/**
 * Printable A4 poster with a QR code that opens the bot for one university:
 * https://max.ru/<bot>?start=<university id> (D-018). A university hangs it in the dormitory,
 * the student scans it and lands in their own university's scenario without choosing anything.
 * Texts come from src/data/i18n; the poster carries the profile's posterLanguages or every interface language.
 */

import qrcode from "qrcode-generator";
import { format, type Texts } from "./data/loadTexts.js";
import type { University } from "./data/loadUniversities.js";
import { plain } from "./core/markup.js";

export interface PosterOptions { botLink: string; demo: boolean }

/** The deep link the QR code encodes; MAX passes `start` to the bot as the bot_started payload. */
export function deepLink(botLink: string, university: University): string {
  const url = new URL(botLink);
  if (url.protocol !== "https:" || url.search || url.hash) throw new Error("BOT_LINK must be https://max.ru/<bot> without parameters");
  url.searchParams.set("start", university.id);
  return url.href;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// SVG has no line wrapping. Width is counted roughly in Latin characters; a CJK character
// is about two of them and can break anywhere, since Chinese has no spaces between words.
const wide = (ch: string) => /[\u2e80-\u9fff\uff00-\uffef]/.test(ch);
function wrap(text: string, max: number): string[] {
  const tokens = text.split(" ").flatMap((word, i) => [...(i ? [" "] : []),
    ...(wide(word) ? word.match(/[\u2e80-\u9fff\uff00-\uffef]|[^\u2e80-\u9fff\uff00-\uffef]+/g)! : [word])]);
  const width = (s: string) => [...s].reduce((n, ch) => n + (wide(ch) ? 2 : 1), 0);
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    if (line.trim() && width(line + token) > max) { lines.push(line.trim()); line = token === " " ? "" : token; }
    else line += token;
  }
  return line.trim() ? [...lines, line.trim()] : lines;
}

/** QR modules as one path: crisp at any print size, no raster. */
export function qrPath(data: string): { path: string; size: number } {
  const qr = qrcode(0, "Q"); // Q: survives a crease, a scratch or a glare on a printed sheet
  qr.addData(data, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  let path = "";
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
  return { path, size };
}

export function posterSvg(university: University, texts: Texts, o: PosterOptions): string {
  const link = deepLink(o.botLink, university);
  const langs = university.posterLanguages ?? [...texts.keys()];
  const unknown = langs.filter(lang => !texts.has(lang));
  if (unknown.length) throw new Error(`posterLanguages of ${university.id}: no interface texts for ${unknown.join(", ")}`);
  // The poster is printed plain: chat emphasis markers (#114) are dropped.
  const tr = (lang: string, key: string) => plain(format(texts, lang, key, { uni: university.name[lang] ?? university.name.ru! }));
  const out: string[] = [];
  const text = (y: number, size: number, value: string, weight = 400, fill = "#1b1f24") =>
    out.push(`<text x="105" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="middle">${escape(value)}</text>`);
  // Header: title and one-line promise in every language, the base language first and larger.
  const header = out.push("") - 1;
  let y = 16;
  langs.forEach((lang, i) => { text(y, i ? 7 : 10, tr(lang, "poster.title"), 700, "#ffffff"); y += i ? 9 : 12; });
  for (const [i, lang] of langs.entries()) for (const line of wrap(tr(lang, "poster.lead"), i ? 64 : 52)) { text(y, i ? 4.2 : 5, line, 400, "#e8f1fb"); y += i ? 5 : 6; }
  out[header] = `<rect width="210" height="${y}" fill="#0b5cad"/>`;
  text(y + 14, 9, university.name[langs[0]!] ?? university.id, 700);
  // Everything under the code is laid out first, so the code takes exactly the room left.
  const below: [number, number, string, number, string][] = []; // [gap before, size, text, weight, fill]
  langs.forEach((lang, i) => below.push([i ? 6 : 12, i ? 4.2 : 5.2, tr(lang, "poster.scan"), i ? 400 : 700, "#1b1f24"]));
  below.push([8, 4.2, link, 400, "#0b5cad"]);
  langs.forEach((lang, i) => wrap(tr(lang, "poster.note"), 88).forEach((line, j) =>
    below.push([j ? (i ? 4.2 : 4.8) : (i ? 5 : 12), i ? 3.2 : 3.6, line, 400, "#555d66"])));
  const demo = o.demo ? langs.map(lang => tr(lang, "banner.demo").trim()) : [];
  const belowHeight = below.reduce((n, [gap]) => n + gap, 0) + demo.length * 4.5 + 6;
  // QR code with its quiet zone, up to 110 mm wide in the middle of the sheet.
  const { path, size } = qrPath(link);
  const top = y + 22, side = Math.min(110, 297 - top - belowHeight);
  if (side < 60) throw new Error(`Too many languages for one poster of ${university.id}: the QR code would be smaller than 6 cm; set posterLanguages in the profile`);
  const scale = side / (size + 8), left = 105 - side / 2;
  out.push(`<rect x="${left}" y="${top}" width="${side}" height="${side}" fill="#ffffff" stroke="#0b5cad" stroke-width="0.6"/>`,
    `<path transform="translate(${left + 4 * scale} ${top + 4 * scale}) scale(${scale})" d="${path}" fill="#000000" shape-rendering="crispEdges"/>`);
  y = top + side;
  for (const [gap, fontSize, value, weight, fill] of below) { y += gap; text(y, fontSize, value, weight, fill); }
  demo.forEach((line, i) => text(292 - 4.5 * (demo.length - 1 - i), 3.6, line, 700, "#b3261e"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297" font-family="Arial, Helvetica, sans-serif">
<title>${escape(`${university.name[langs[0]!]} — ${link}`)}</title>
<rect width="210" height="297" fill="#ffffff"/>
${out.join("\n")}
</svg>
`;
}
