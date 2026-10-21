import { describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import { format } from "../src/data/loadTexts.js";
import { plan, reminderReply, shareText, transition, type DialogueContext, type Session } from "../src/bot/dialog.js";

const rules = parseRuleSet(raw);
const texts = readTexts("src/data/i18n");
const ctx: DialogueContext = { rules: rules.rules, universities: readUniversities("src/data/universities", "kfu"),
  texts, version: rules.version, demo: true, today: "2026-09-24" };

/** A chat that entered on 03.09.2026 and marked the medical examination done on 24.09.2026. */
function afterDone(lang = "ru") {
  let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
  const click = (action: string) => { const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx); s = r.session!; return r.reply; };
  const type = (text: string) => { const r = transition(s, { text, callback: false }, ctx); s = r.session!; return r.reply; };
  for (const a of [lang, "accept", "yes", "KZ"]) click(a);
  type("03.09.2026");
  click("card:medical-examination"); click("done:medical-examination"); type("24.09.2026");
  return { click, type, session: () => s };
}

describe("a marked yearly procedure is shown as a repeat", () => {
  it("plan: the label with the period from the data and the date it was done", () => {
    const plan = afterDone().click("plan").text;
    expect(plan).toContain("• Медицинское освидетельствование, повторно (ежегодно): 24 октября 2027 г.");
    expect(plan).toContain("пройдено вами 24 сентября 2026 г.");
  });

  it("card: the same two facts, once", () => {
    const card = afterDone().click("card:medical-examination").text;
    expect(card).toContain("Повторно (ежегодно). Пройдено вами 24 сентября 2026 г.");
  });

  it("a first round has neither", () => {
    const f = afterDone();
    const line = f.click("plan").text.split("\n").find(l => l.startsWith("• Дактилоскопия"))!;
    expect(line).not.toContain("овторно");
    expect(f.click("card:fingerprinting").text).not.toContain("овторно");
  });

  it("every language words it from its own texts", () => {
    for (const lang of texts.keys()) {
      const reply = afterDone(lang).click("plan").text;
      const t = texts.get(lang)!;
      expect(reply, lang).toContain(t["repeat.label"]!.replace("{period}", t["repeat.yearly"]!));
    }
  });

  it("shared plan: the same label and the date it was done, a first round has neither", () => {
    const text = shareText(afterDone().session(), ctx);
    expect(text).toContain("• Медицинское освидетельствование, повторно (ежегодно) — до 24 октября 2027 г.\n  пройдено вами 24 сентября 2026 г.");
    expect(text.split("\n").find(l => l.startsWith("• Дактилоскопия"))).not.toContain("овторно");
  });

  it("reminder a year later: says it is a repeat and when the previous round was done", () => {
    const f = afterDone(), c = { ...ctx, today: "2027-10-17" };
    const item = plan(f.session(), c).find(i => i.ruleId === "medical-examination")!;
    expect(reminderReply(f.session(), c, item).text)
      .toContain("Напоминание: Медицинское освидетельствование, повторно (ежегодно) — 24 октября 2027 г. (скоро, осталось 7 дней)\n  пройдено вами 24 сентября 2026 г.");
    const first = plan(f.session(), c).find(i => i.ruleId === "fingerprinting")!;
    expect(reminderReply(f.session(), c, first).text).not.toContain("овторно");
  });

  it("overdue reminder of a repeat: keeps the label and the previous round's date", () => {
    const f = afterDone(), c = { ...ctx, today: "2027-11-30" };
    const item = plan(f.session(), c).find(i => i.ruleId === "medical-examination")!;
    const text = reminderReply(f.session(), c, item).text;
    expect(text).toContain("повторно (ежегодно)");
    expect(text).toContain("пройдено вами 24 сентября 2026 г.");
  });

  it("every language: the shared plan and the reminder carry the repeat label", () => {
    for (const lang of texts.keys()) {
      const f = afterDone(lang), t = texts.get(lang)!, label = t["repeat.label"]!.replace("{period}", t["repeat.yearly"]!);
      const item = plan(f.session(), ctx).find(i => i.ruleId === "medical-examination")!;
      expect(shareText(f.session(), ctx), lang).toContain(label);
      expect(reminderReply(f.session(), ctx, item).text, lang).toContain(label);
    }
  });

  it("Chinese joins the title and the label with its own comma, in the plan", () => {
    const title = rules.rules.find(r => r.id === "medical-examination")!.title.zh!;
    expect(afterDone("zh").click("plan").text).toContain(`• ${title}，再次办理（每年）`);
  });

  it("a period other than a year is worded from repeat.everyMonths", () => {
    const six = { ...ctx, rules: rules.rules.map(r => r.id === "medical-examination" ? { ...r, repeat: { months: 6 } } : r) };
    expect(shareText(afterDone().session(), six)).toContain("• Медицинское освидетельствование, повторно (раз в 6 мес.) — до ");
  });

  it("English says 'every month' for one month, not 'every 1 months'", () => {
    expect(format(texts, "en", "repeat.everyMonths", { n: 1 })).toBe("every month");
    expect(format(texts, "en", "repeat.everyMonths", { n: 6 })).toBe("every 6 months");
  });
});
