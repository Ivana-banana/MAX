import { describe, expect, it } from "vitest";
import { isText } from "../web/src/texts.js";

describe("mini app text match", () => {
  const template = "Дата вне сценария или неверный формат. Введите ДД.ММ.ГГГГ или ГГГГ-ММ-ДД, с {from} по сегодня; /help — помощь.";

  it("recognises a server message whose placeholder was filled in", () => {
    const message = "ДЕМО · учебные данные\nДата вне сценария или неверный формат. Введите ДД.ММ.ГГГГ или ГГГГ-ММ-ДД, с 1 сентября 2026 г. по сегодня; /help — помощь.";
    expect(isText(message, template)).toBe(true);
  });

  it("does not match other messages or an empty template", () => {
    expect(isText("Дата въезда: ДД.ММ.ГГГГ или ГГГГ-ММ-ДД", template)).toBe(false);
    expect(isText("anything", "{from}")).toBe(false);
  });
});
