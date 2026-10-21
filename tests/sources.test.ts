import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readUniversities } from "../src/data/loadUniversities.js";
import { readCalendar } from "../src/data/loadCalendar.js";
import { readChangeSet } from "../src/data/loadChanges.js";
import { checkPage, dataUrls, pageText, parseSources, type Source } from "../src/sources.js";

const rules = parseRuleSet(raw).rules;
const universities = readUniversities("src/data/universities", "kfu");
const calendarUrls = readCalendar("src/data/calendar/ru.json").urls;
const changes = readChangeSet("src/data/rules/ru-change.json");
const sources = parseSources(JSON.parse(readFileSync("src/data/sources.json", "utf8")));

describe("official sources are watched", () => {
  it("registers every link the rules and university profiles rely on", () => {
    const watched = new Set(sources.map(s => s.url));
    const missing = dataUrls(rules, universities, calendarUrls, changes).filter(url => !watched.has(url));
    expect(missing).toEqual([]);
  });

  it("keeps no source nobody uses any more", () => {
    const used = new Set(dataUrls(rules, universities, calendarUrls, changes));
    expect(sources.map(s => s.url).filter(url => !used.has(url))).toEqual([]);
  });

  it("refuses a source without quotes or with a non-https link", () => {
    expect(() => parseSources({ sources: [{ url: "https://a.ru", about: "x", quotes: [] }] })).toThrow(/quotes/);
    expect(() => parseSources({ sources: [{ url: "http://a.ru", about: "x", quotes: ["q"] }] })).toThrow(/https/);
  });
});

describe("a quote is found regardless of markup, case, ё and dashes", () => {
  const source: Source = { url: "https://kpfu.ru/x", about: "", quotes: ["в течение следующего рабочего дня", "45 дней до срока истечения регистрации", "Гвардейская, 9"] };

  it("finds quotes split by tags, line breaks and entities, in a windows-1251 page", () => {
    const html = '<html><head><meta charset="windows-1251"></head><body><b>В течение\n следующего</b>&nbsp;рабочего <i>дня</i> &ndash; не позднее чем за 45 дней до срока истечения регистрации. ул. Гвардейская,&nbsp;9</body></html>';
    // windows-1251 by hand: А–я are 0xC0–0xFF, Ё/ё are 0xA8/0xB8 (kpfu.ru serves this encoding).
    const cp1251 = Buffer.from([...html].map(ch => {
      const code = ch.codePointAt(0)!;
      if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
      if (code === 0x401) return 0xa8;
      if (code === 0x451) return 0xb8;
      return code < 0x80 ? code : 0x3f;
    }));
    const text = pageText(cp1251, "text/html");
    expect(checkPage(source, text)).toEqual([]);
  });

  it("reports exactly the quotes that disappeared", () => {
    const text = pageText(Buffer.from("<p>В течение следующего рабочего дня. Адрес: ул. Кремлёвская, 18</p>"), "text/html; charset=utf-8");
    expect(checkPage(source, text)).toEqual(["45 дней до срока истечения регистрации", "Гвардейская, 9"]);
  });

  it("treats ё as е and different dashes and quotes as the same", () => {
    const text = pageText(Buffer.from("<p>обязан пройти «медицинское» освидетельствование — ещё</p>"), "text/html; charset=utf-8");
    const s: Source = { url: "https://a.ru", about: "", quotes: ['пройти "медицинское" освидетельствование - еще'] };
    expect(checkPage(s, text)).toEqual([]);
  });
});
