/**
 * A ready block for the university's admission email and web page (#120): the student gets the
 * invitation by email before entry, so the block leads to "what to prepare before arrival" and
 * carries a clickable deep link https://max.ru/<bot>?start=<university id> (D-018) plus a QR code
 * for those reading the email on a computer. Student texts come from src/data/i18n (invite.*),
 * languages from the profile's posterLanguages, like the poster (D-023).
 */

import { format, type Texts } from "./data/loadTexts.js";
import type { University } from "./data/loadUniversities.js";
import { plain } from "./core/markup.js";
import { deepLink, qrPath, type PosterOptions } from "./poster.js";

// Official MAX help on registering with a non-Russian number; the list of countries lives there, not here.
// The page exists at this address (the old /help/about/kak-... one returns 404); the block shows the check date,
// so a university pasting it months later can see how fresh the claim is.
export const FOREIGN_NUMBER_HELP = "https://help.max.ru/help/about/ustanovka_i_registraciya_v_max/kak_zaregistrirovatsya_v_max_po_inostrannomu_nomeru";
export const FOREIGN_NUMBER_HELP_CHECKED = "23.10.2026";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function invitationHtml(university: University, texts: Texts, o: PosterOptions): string {
  const link = deepLink(o.botLink, university);
  const langs = university.posterLanguages ?? [...texts.keys()];
  const unknown = langs.filter(lang => !texts.has(lang));
  if (unknown.length) throw new Error(`posterLanguages of ${university.id}: no interface texts for ${unknown.join(", ")}`);
  const tr = (lang: string, key: string) => escape(plain(format(texts, lang, key, { uni: university.name[lang] ?? university.name.ru!, checked: FOREIGN_NUMBER_HELP_CHECKED })).trim());
  const { path, size } = qrPath(link);
  const qr = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 ${size + 8} ${size + 8}">` +
    `<rect width="${size + 8}" height="${size + 8}" fill="#ffffff"/><path transform="translate(4 4)" d="${path}" fill="#000000" shape-rendering="crispEdges"/></svg>`;
  const languageName = new Intl.DisplayNames(["ru"], { type: "language" });
  const name = escape(university.name.ru ?? university.id);
  const sections = langs.map(lang => `<section lang="${lang}">
<h2>${escape(languageName.of(lang) ?? lang)}</h2>
<div class="block">
<p>${tr(lang, "invite.lead")}</p>
<p><a href="${escape(link)}"><b>${tr(lang, "invite.open")}</b></a><br><a href="${escape(link)}">${escape(link)}</a></p>
<figure>${qr}<figcaption>${tr(lang, "invite.scan")}</figcaption></figure>
<p class="small">${tr(lang, "invite.foreign")} <a href="${FOREIGN_NUMBER_HELP}">${tr(lang, "invite.help")}</a></p>
<p class="small">${tr(lang, "poster.note")}</p>${o.demo ? `\n<p class="demo">${tr(lang, "banner.demo")}</p>` : ""}
</div>
</section>`);
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Приглашение в бот MAX — ${name}</title>
<style>
body { font-family: Arial, Helvetica, sans-serif; max-width: 720px; margin: 24px auto; color: #1b1f24; line-height: 1.45; }
.staff { background: #f2f5f8; padding: 12px 16px; border-radius: 8px; }
.block { border: 1px solid #c9d3de; border-radius: 8px; padding: 4px 16px; }
figure { margin: 12px 0; } figcaption { font-size: 14px; }
.small { font-size: 14px; color: #555d66; } .demo { color: #b3261e; font-weight: 700; }
a { color: #0b5cad; }
</style>
</head>
<body>
<h1>Блок для письма о зачислении — ${name}</h1>
<div class="staff">
<p>Скопируйте рамку нужного языка в письмо о зачислении или на страницу сайта: ссылка останется кликабельной и откроет бот сразу в профиле вуза.</p>
<p>QR-код нужен тем, кто читает письмо с компьютера. Почтовые клиенты часто не показывают SVG — если код пропал после вставки, в письме достаточно ссылки, а код оставьте для сайта и плаката (<code>npm run qr ${escape(university.id)}</code>).</p>
<p>Регистрация в MAX по иностранному номеру доступна не для всех стран — список ведёт MAX в <a href="${FOREIGN_NUMBER_HELP}">справке</a>. Поэтому в блоке есть запасной путь: открыть ссылку после получения российского номера.</p>
</div>${o.demo ? `\n<p class="demo">${escape(plain(format(texts, "ru", "banner.demo")).trim())} Бот работает в демо-режиме: перед рассылкой студентам согласуйте запуск.</p>` : ""}
${sections.join("\n")}
</body>
</html>
`;
}
