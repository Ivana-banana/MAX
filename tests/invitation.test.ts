import { describe, expect, it } from "vitest";
import { readUniversities, type University } from "../src/data/loadUniversities.js";
import { readTexts } from "../src/data/loadTexts.js";
import { FOREIGN_NUMBER_HELP, invitationHtml } from "../src/invitation.js";

const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const itmo = universities.find(u => u.id === "itmo")!;
const botLink = "https://max.ru/t149_hakaton_max_bot";

describe("invitation block for the admission email", () => {
  it("links to the university's own scenario in every poster language, before entry", () => {
    const html = invitationHtml(itmo, texts, { botLink, demo: true });
    expect(html).toContain(`<a href="https://max.ru/t149_hakaton_max_bot?start=itmo">`);
    for (const lang of itmo.posterLanguages!) expect(html).toContain(`<section lang="${lang}">`);
    expect(html).not.toContain(`<section lang="tt">`); // Tatar is not in the ITMO profile languages
    for (const line of ["До приезда в Россию", "Before you arrive in Russia", "Rossiyaga kelishingizdan oldin", "来俄罗斯之前"]) expect(html).toContain(line);
    expect(html).toContain("<svg"); // QR code for those reading on a computer
  });
  it("points to the MAX help for foreign numbers and gives a way in without one", () => {
    const html = invitationHtml(itmo, texts, { botLink, demo: true });
    expect(html.split(`href="${FOREIGN_NUMBER_HELP}"`).length - 1).toBe(itmo.posterLanguages!.length + 1);
    expect(html).toContain("когда получите российский номер");
  });
  it("is marked as demo only in demo mode and carries no chat markers", () => {
    expect(invitationHtml(itmo, texts, { botLink, demo: true })).toContain("ДЕМО · учебные данные.");
    const live = invitationHtml(itmo, texts, { botLink, demo: false });
    expect(live).not.toContain("ДЕМО");
    expect(live).not.toMatch(/\*/);
  });
  it("escapes names from data so a profile cannot break the page", () => {
    const odd: University = { ...itmo, id: "odd", name: { ru: "Вуз <&> \"А\"", en: "U <&>", uz: "U", zh: "U" } };
    const html = invitationHtml(odd, texts, { botLink, demo: true });
    expect(html).toContain("Вуз &lt;&amp;&gt; &quot;А&quot;");
    expect(html).not.toContain("<&>");
  });
});
