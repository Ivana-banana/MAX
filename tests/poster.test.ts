import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readUniversities, type University } from "../src/data/loadUniversities.js";
import { readTexts, type Texts } from "../src/data/loadTexts.js";
import { deepLink, posterSvg } from "../src/poster.js";
import { parseUpdate } from "../src/bot/service.js";
import { transition } from "../src/bot/dialog.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const kfu = universities[0]!, itmo = universities.find(u => u.id === "itmo")!;
const botLink = "https://max.ru/t149_hakaton_max_bot";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
const has = (tool: string) => { try { execFileSync("which", [tool], { stdio: "ignore" }); return true; } catch { return false; } };

describe("university QR poster", () => {
  it("encodes a deep link that opens the bot in that university's scenario", () => {
    const link = deepLink(botLink, itmo);
    expect(link).toBe("https://max.ru/t149_hakaton_max_bot?start=itmo");
    // What MAX sends when the code is scanned: bot_started with the start value as payload.
    const update = parseUpdate({ update_type: "bot_started", timestamp: 1, chat_id: 1, user: { user_id: 7 },
      payload: new URL(link).searchParams.get("start") })!;
    const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };
    expect(transition(null, update.input, ctx).session!.university).toBe("itmo");
    expect(() => deepLink("http://max.ru/bot", kfu)).toThrow(/https/);
    expect(() => deepLink(`${botLink}?start=kfu`, kfu)).toThrow(/without parameters/);
  });
  it("prints the link, the university and every interface language, marked as demo", () => {
    const svg = posterSvg(kfu, texts, { botLink, demo: true });
    expect(svg).toContain(">https://max.ru/t149_hakaton_max_bot?start=kfu<");
    for (const line of ["Первые 90 дней в России", "Your first 90 days in Russia", "Rossiyadagi dastlabki 90 kun", "在俄罗斯的最初90天", ">КФУ<", "готовит вопрос в КФУ.", "drafts a question to"]) expect(svg).toContain(line);
    expect(svg).toContain("ДЕМО · учебные данные, нормы не утверждены.");
    expect(posterSvg(kfu, texts, { botLink, demo: false })).not.toContain("ДЕМО");
  });
  it("escapes names from data so a profile cannot break the SVG", () => {
    const odd: University = { ...kfu, id: "odd", name: { ru: "Вуз <&> \"А\"", en: "U <&>" } };
    const svg = posterSvg(odd, texts, { botLink, demo: true });
    expect(svg).toContain("Вуз &lt;&amp;&gt; &quot;А&quot;");
    expect(svg).not.toContain("<&>");
  });
  it("keeps room for more languages and refuses a QR code too small to scan", () => {
    const withLangs = (n: number): Texts => new Map([...texts, ...Array.from({ length: n }, (_, i) =>
      [`x${String.fromCharCode(97 + i)}`, texts.get("en")!] as const)]);
    expect(() => posterSvg(kfu, texts, { botLink, demo: true })).not.toThrow(); // ru, en, uz, zh
    expect(() => posterSvg(kfu, withLangs(4), { botLink, demo: true })).toThrow(/smaller than 6 cm/);
  });
  it.skipIf(!has("rsvg-convert") || !has("zbarimg"))("scans back to the same link with a real QR reader", () => {
    const dir = mkdtempSync(join(tmpdir(), "poster-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "p.svg"), posterSvg(itmo, texts, { botLink, demo: true }));
    execFileSync("rsvg-convert", ["-w", "1240", join(dir, "p.svg"), "-o", join(dir, "p.png")]);
    expect(execFileSync("zbarimg", ["-q", join(dir, "p.png")], { encoding: "utf8" }).trim()).toBe("QR-Code:https://max.ru/t149_hakaton_max_bot?start=itmo");
  });
});
