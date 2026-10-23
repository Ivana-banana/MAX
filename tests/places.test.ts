import { describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { checkProcedures, parseUniversity, readUniversities } from "../src/data/loadUniversities.js";
import { mapUrl, transition, type Reply, type Session } from "../src/bot/dialog.js";
import { plain } from "../src/core/markup.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };
const links = (r: Reply) => r.buttons.flat().flatMap(b => "url" in b ? [{ text: b.text, url: b.url }] : []);

function planned(citizenship: string, start = "/start") {
  let s: Session = transition(null, { text: start, callback: false }, ctx).session!;
  const click = (action: string) => {
    const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);
    s = r.session!; return r.reply;
  };
  for (const a of ["ru", "accept", "yes", citizenship]) click(a);
  s = transition(s, { text: "2026-09-01", callback: false }, ctx).session!;
  return { click };
}

describe("where to go", () => {
  it("builds a Yandex Maps search link from the address", () => {
    expect(mapUrl("Казань, ул. Гвардейская, 9")).toBe("https://yandex.ru/maps/?text=%D0%9A%D0%B0%D0%B7%D0%B0%D0%BD%D1%8C%2C%20%D1%83%D0%BB.%20%D0%93%D0%B2%D0%B0%D1%80%D0%B4%D0%B5%D0%B9%D1%81%D0%BA%D0%B0%D1%8F%2C%209");
  });

  it("adds «How to get there» to a university procedure with an address", () => {
    const card = planned("KZ").click("card:migration-registration");
    expect(links(card)).toContainEqual({ text: "🗺 Как добраться", url: mapUrl("Казань, ул. Гвардейская, 9") });
  });

  it("says where KFU sends students for the medical examination, with the source and a map", () => {
    const card = planned("KZ").click("card:medical-examination");
    expect(plain(card.text)).toContain("Где: Медико-санитарная часть КФУ, ул. Вишневского, 2а, 4 этаж");
    expect(card.text).toContain("по странице КФУ");
    expect(links(card)).toContainEqual({ text: "🗺 Как добраться", url: mapUrl("Казань, ул. Вишневского, 2а") });
  });

  it("does not invent a place the university does not publish", () => {
    const card = planned("KZ").click("card:fingerprinting");
    expect(card.text).not.toContain("Где:");
    expect(links(card).some(l => l.text === "🗺 Как добраться")).toBe(false);
  });

  it("sends ITMO and UNECON students to the same PVS branch for both procedures, as their pages say", () => {
    for (const start of ["/start itmo", "/start spbgeu"]) {
      const f = planned("KZ", start);
      for (const id of ["medical-examination", "fingerprinting"]) {
        expect(links(f.click(`card:${id}`))).toContainEqual({ text: "🗺 Как добраться", url: mapUrl("Санкт-Петербург, ул. Красного Текстильщика, 10-12") });
      }
    }
  });

  it("refuses a place for a rule that does not exist or without a source", () => {
    const base = { id: "u", name: { ru: "У" }, contactUrl: "https://u.ru", citizenships: ["KZ"], checkedAt: "2026-09-29" };
    const place = { where: { ru: "Где-то" }, map: "Город, ул. Такая, 1", source: { url: "https://u.ru", checkedAt: "2026-09-29" } };
    expect(parseUniversity({ ...base, rulePlaces: { "medical-examination": place } }).rulePlaces["medical-examination"]?.map).toBe("Город, ул. Такая, 1");
    expect(() => parseUniversity({ ...base, rulePlaces: { "medical-examination": { ...place, source: undefined } } })).toThrow(/source/);
    expect(() => parseUniversity({ ...base, rulePlaces: { x: { ...place, map: "" } } })).toThrow(/map/);
    expect(() => checkProcedures([parseUniversity({ ...base, rulePlaces: { nope: place } })], rules.rules.map(r => r.id))).toThrow(/nope/);
  });
});
