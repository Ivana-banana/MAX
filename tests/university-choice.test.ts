import { describe, expect, it } from "vitest";
import { parseRuleSet } from "../src/data/loadRules.js";
import raw from "../src/data/rules/ru-student.json" with { type: "json" };
import { readTexts } from "../src/data/loadTexts.js";
import { readUniversities } from "../src/data/loadUniversities.js";
import { plan, transition, type Reply, type Session } from "../src/bot/dialog.js";
import { isAppAction } from "../src/webapp/state.js";

const rules = parseRuleSet(raw);
const universities = readUniversities("src/data/universities", "kfu");
const texts = readTexts("src/data/i18n");
const ctx = { rules: rules.rules, universities, texts, version: rules.version, demo: true, today: "2026-09-24" };
const actions = (r: Reply) => r.buttons.flat().flatMap(b => "action" in b ? [b.action.split("|")[1]!] : []);

/** A chat that has reached the scope question without a deep link, as after a plain /start. */
function atScope() {
  let s: Session = transition(null, { text: "/start", callback: false }, ctx).session!;
  let last!: Reply;
  const click = (action: string): Reply => {
    const r = transition(s, { text: `${s.nonce}.${s.revision}|${action}`, callback: true }, ctx);
    s = r.session!; last = r.reply; return r.reply;
  };
  click("ru"); click("accept");
  return { click, get session() { return s; }, get reply() { return last; } };
}

describe("choosing a university without a deep link", () => {
  it("offers the other universities of the catalogue on the scope question", () => {
    const f = atScope();
    expect(f.reply.text).toContain("общежитие КФУ");
    expect(actions(f.reply)).toContain("universities");
    const list = f.click("universities");
    expect(f.session.step).toBe("scope");
    // Every other profile is a button; the current one is not offered again.
    expect(actions(list)).toEqual(expect.arrayContaining(universities.slice(1).map(u => `uni:${u.id}`)));
    expect(actions(list)).not.toContain("uni:kfu");
    expect(actions(list)).toContain("uni-missing");
  });

  it("switches the scope question to the chosen university and keeps the scenario", () => {
    const f = atScope();
    f.click("universities");
    const scope = f.click("uni:itmo");
    expect(f.session.university).toBe("itmo");
    expect(f.session.step).toBe("scope");
    expect(scope.text).toContain("общежитие ИТМО");
    f.click("yes");
    expect(f.session.step).toBe("citizenship");
  });

  it("sends a student whose university is not listed to their own international office, without a calculation", () => {
    const f = atScope();
    f.click("universities");
    const missing = f.click("uni-missing");
    expect(missing.text).toContain("международный отдел своего вуза");
    expect(missing.text).not.toContain("КФУ");
    expect(f.session.step).toBe("scope");
    expect(actions(missing)).toContain("universities");
  });

  it("does not change the university once the plan exists", () => {
    const f = atScope();
    for (const a of ["yes", "KZ"]) f.click(a);
    const s = transition(f.session, { text: "2026-09-01", callback: false }, ctx).session!;
    const after = transition(s, { text: "uni:itmo", callback: false }, ctx).session!;
    expect(after.university).toBeUndefined();
  });

  it("ignores an unknown university id", () => {
    const f = atScope();
    f.click("uni:nowhere");
    expect(f.session.university).toBeUndefined();
    expect(f.session.step).toBe("scope");
  });

  it("lets the mini app send the same actions", () => {
    for (const action of ["universities", "uni:itmo", "uni-missing"]) expect(isAppAction(action)).toBe(true);
    expect(isAppAction("uni:ITMO")).toBe(false);
  });
});

describe("a session whose university is no longer in the catalogue", () => {
  const without = { ...ctx, universities: universities.filter(u => u.id !== "itmo") };
  /** A finished ITMO plan, as it was stored before the profile was removed. */
  function itmoPlan(): Session {
    const f = atScope();
    f.click("universities"); f.click("uni:itmo");
    for (const a of ["yes", "KZ"]) f.click(a);
    return transition(f.session, { text: "2026-09-01", callback: false }, ctx).session!;
  }

  it("asks to choose the university again instead of showing the default one's addresses", () => {
    const stored = itmoPlan();
    expect(stored.step).toBe("plan");
    expect(plan(stored, without)).toEqual([]);
    const r = transition(stored, { text: "plan", callback: false }, without);
    expect(r.reply.text).toContain("больше нет в списке");
    expect(r.reply.text).not.toContain("КФУ");
    expect(actions(r.reply)).toEqual(expect.arrayContaining(without.universities.map(u => `uni:${u.id}`)));
    expect(actions(r.reply).some(a => a.startsWith("card:") || a === "reminders")).toBe(false);
    expect(r.session!.university).toBe("itmo");
  });

  it("starts the scenario over with the university the student picks", () => {
    const stored = itmoPlan();
    const asked = transition(stored, { text: "/plan", callback: false }, without).session!;
    const r = transition(asked, { text: `${asked.nonce}.${asked.revision}|uni:kfu`, callback: true }, without);
    expect(r.session).toMatchObject({ university: "kfu", step: "scope", reminders: false, completions: {} });
    expect(r.session!.citizenship).toBeUndefined();
    expect(r.session!.entryDate).toBeUndefined();
    expect(r.reply.text).toContain("общежитие КФУ");
  });

  it("keeps the old behaviour for a session saved before universities had ids", () => {
    const old = itmoPlan();
    delete old.university;
    expect(plan(old, without).length).toBeGreaterThan(0);
    const home = transition(old, { text: "plan", callback: false }, without).reply;
    expect(actions(home).some(a => a.startsWith("card:"))).toBe(true);
  });
});
