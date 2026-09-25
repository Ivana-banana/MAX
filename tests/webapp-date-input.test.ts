import { describe, expect, it } from "vitest";
import { mask, toIso } from "../web/src/dateInput.js";

describe("mini app date input", () => {
  it("inserts dots while the user types digits", () => {
    expect(mask("0")).toBe("0");
    expect(mask("0109")).toBe("01.09");
    expect(mask("01092026")).toBe("01.09.2026");
    expect(mask("01.09.2026 extra 99")).toBe("01.09.2026");
  });

  it("does not re-add a dot the user just deleted", () => {
    expect(mask("01")).toBe("01");
    expect(mask("01.09")).toBe("01.09");
  });

  it("sends ISO dates and nothing for incomplete or impossible days", () => {
    expect(toIso("01.09.2026")).toBe("2026-09-01");
    expect(toIso("29.02.2028")).toBe("2028-02-29");
    expect(toIso("31.02.2026")).toBe("");
    expect(toIso("29.02.2026")).toBe("");
    expect(toIso("01.13.2026")).toBe("");
    expect(toIso("01.09.20")).toBe("");
  });
});
