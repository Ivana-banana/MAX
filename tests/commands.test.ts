import { describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readUniversities } from "../src/data/loadUniversities.js";
import { readTexts } from "../src/data/loadTexts.js";
import { botCommands, COMMANDS } from "../src/bot/commands.js";
import { transition, type Session } from "../src/bot/dialog.js";

const rules = parseRuleSet(raw);
const texts = readTexts("src/data/i18n");
const ctx = { rules: rules.rules, universities: readUniversities("src/data/universities", "kfu"), texts, version: rules.version, demo: true, today: "2026-09-24" };

describe("bot command hints (PATCH /me/commands)", () => {
  it("lists the commands with Russian and English descriptions within MAX limits", () => {
    const commands = botCommands(texts);
    expect(commands.map(c => c.name)).toEqual(["start", "plan", "change", "help", "stop", "delete"]);
    expect(commands[1]!.description).toBe("мой план и сроки / my plan and dates");
    expect(commands.length).toBeLessThanOrEqual(32);
    for (const c of commands) expect(c.name).toMatch(/^[a-z]+$/);
  });
  it("every hinted command is understood by the dialogue as typed text", () => {
    let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
    const click = (action: string) => { s = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx).session!; };
    for (const a of ["ru", "accept", "yes", "KZ"]) click(a);
    s = transition(s, { text: "2026-09-01", callback: false }, ctx).session!;
    click("reminders");
    const typed = (name: string) => transition(s, { text: `/${name}`, callback: false }, ctx);
    const replies = Object.fromEntries(COMMANDS.map(name => [name, typed(name)]));
    expect(replies.plan!.reply.text).toContain("Ваш план подготовки");
    expect(replies.help!.reply.text).toContain("Подготовьте вопрос");
    expect(replies.stop!.session!.reminders).toBe(false);
    expect(replies.delete!.reply.text).toContain("Удалить профиль");
    expect(replies.start!.session!.step).toBe("plan");
  });
});
