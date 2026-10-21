import { expect, test, type Page } from "@playwright/test";

// The student's path through the mini app: language → consent → scope → citizenship → entry date → plan.
// MAX Bridge is replaced by a stub; the server runs in APP_MODE=demo and accepts `?demo=<id>` as the launch.

/** Moscow calendar date `daysAgo` days back, as DD.MM.YYYY: the server counts "today" in Moscow time. */
function moscowDate(daysAgo: number): string {
  const day = new Date(Date.now() - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric" }).format(day);
}

test.beforeEach(async ({ page }, testInfo) => {
  // The real bridge script lives on st.max.ru; the stub says "inside MAX" with empty launch data, so the demo id is used.
  await page.route("https://st.max.ru/**", route => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.addInitScript(() => {
    const w = globalThis as unknown as { WebApp: object; closingConfirmation: boolean[] };
    w.closingConfirmation = [];
    w.WebApp = {
      initData: "", platform: "android", version: "26.0",
      enableClosingConfirmation: () => w.closingConfirmation.push(true),
      disableClosingConfirmation: () => w.closingConfirmation.push(false),
    };
  });
  // A fresh demo user per test: sessions live in the shared database.
  await page.goto(`/?demo=${testInfo.workerIndex * 1_000_000 + Math.floor(Math.random() * 1_000_000) + 1}`);
});

/** Start → Русский → consent → scope → KZ; stops on the entry date screen. */
async function toEntryDate(page: Page) {
  await page.getByRole("button", { name: "Начать" }).click();
  await page.getByRole("button", { name: /Русский/ }).click();
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByRole("button", { name: "Да, совпадает" }).click();
  await page.getByRole("button", { name: /KZ/ }).click();
  await expect(page.getByRole("heading", { name: "Дата въезда" })).toBeVisible();
}

const dateField = (page: Page) => page.getByRole("textbox", { name: "Дата въезда" });
const save = (page: Page) => page.getByRole("button", { name: "Сохранить" });
/** Alerts with text: the error banners and the date screens keep empty alert regions on the page, so a new reason is announced. */
const alert = (page: Page) => page.getByRole("alert").filter({ hasText: /\S/ });
/** The alert regions of the two error banners over the screen: the action's and the calendar's. */
const bannerAlerts = (page: Page) => page.locator(".banners").getByRole("alert");

test("entry date → plan with deadlines", async ({ page }, testInfo) => {
  await toEntryDate(page);
  await dateField(page).pressSequentially(moscowDate(7).replaceAll(".", ""));
  await expect(dateField(page)).toHaveValue(moscowDate(7)); // the mask inserted the dots
  expect(await page.evaluate(() => (globalThis as unknown as { closingConfirmation: boolean[] }).closingConfirmation.at(-1))).toBe(true);
  await save(page).click();
  await expect(page.getByRole("heading", { name: "Ваш план" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Медицинское освидетельствование/ })).toContainText(/Срок: .*осталось \d+/);
  await expect(page.getByRole("progressbar")).toHaveText("Пройдено 0 из 2");
  await expect(page.getByRole("button", { name: /^Ближайший шаг: / })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("1-plan.png"), fullPage: true, animations: "disabled" });
});

test("entry date → change the citizenship and choose again", async ({ page }, testInfo) => {
  await toEntryDate(page);
  await page.screenshot({ path: testInfo.outputPath("0-entry-date.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "← Изменить гражданство" }).click();
  await expect(page.getByRole("heading", { name: "Гражданство" })).toBeVisible();
  await page.getByRole("button", { name: /KG/ }).click();
  await expect(page.getByRole("heading", { name: "Дата въезда" })).toBeVisible();
});

test("API failure → clear message, retry works without a restart", async ({ page }, testInfo) => {
  await toEntryDate(page);
  await dateField(page).fill(moscowDate(7));
  await expect(bannerAlerts(page)).toHaveText(["", ""]); // the regions are on the page before the first failure

  await page.route("**/api/action", route => route.fulfill({ status: 500, body: "{}" }));
  await save(page).click();
  await expect(alert(page)).toContainText("Сервер не смог обработать действие");
  await expect(dateField(page)).toHaveValue(moscowDate(7)); // the screen and the input survive

  await page.unroute("**/api/action");
  await page.route("**/api/action", route => route.fulfill({ status: 429, headers: { "retry-after": "60" }, body: "{}" }));
  await save(page).click();
  await expect(alert(page)).toContainText("Слишком много действий подряд");

  await page.unroute("**/api/action");
  await page.route("**/api/action", route => route.abort("connectionrefused"));
  await save(page).click();
  await expect(bannerAlerts(page)).toHaveText([/Нет связи с сервером/, ""]); // the action's banner, the calendar's stays empty
  await page.screenshot({ path: testInfo.outputPath("2-api-error.png"), fullPage: true, animations: "disabled" });

  await page.unroute("**/api/action");
  await save(page).click();
  await expect(page.getByRole("heading", { name: "Ваш план" })).toBeVisible();
  await expect(alert(page)).toHaveCount(0);
  await expect(bannerAlerts(page)).toHaveText(["", ""]); // the failure is gone, the regions stay
});

test("empty and invalid date: Save stays off or the reason is shown", async ({ page }, testInfo) => {
  await toEntryDate(page);
  await expect(save(page)).toBeDisabled(); // empty

  await dateField(page).pressSequentially("1203");
  await expect(save(page)).toBeDisabled(); // incomplete

  await dateField(page).fill("");
  await dateField(page).pressSequentially("31022026");
  await expect(save(page)).toBeDisabled(); // 31 February is not a day
  await expect(alert(page)).toContainText("Такой даты нет"); // the reason is shown
  // Disabled looks disabled: the entrance animation must not keep opacity at 1.
  await expect(save(page)).toHaveCSS("opacity", "0.45");
  await page.screenshot({ path: testInfo.outputPath("3-nonexistent-date.png"), fullPage: true, animations: "disabled" });

  await dateField(page).fill("");
  await dateField(page).pressSequentially("01012020");
  await expect(save(page)).toBeEnabled(); // a real day; only the server knows the supported period
  await save(page).click();
  await expect(alert(page)).toContainText("Дата вне сценария");
  await expect(page.getByRole("heading", { name: "Ваш план" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("3-invalid-date.png"), fullPage: true, animations: "disabled" });

  await dateField(page).fill("");
  await dateField(page).pressSequentially(moscowDate(-3).replaceAll(".", ""));
  await expect(alert(page)).toContainText("не может быть в будущем");
  await expect(save(page)).toBeDisabled(); // the future
});

test("a server refusal shows again on a repeated Save; a network failure does not show it", async ({ page }) => {
  await toEntryDate(page);
  await expect(page.getByRole("alert")).toHaveText(["", "", ""]); // two banners and the date line, before any reason
  await dateField(page).fill("01.01.2020");
  await save(page).click();
  await expect(alert(page)).toContainText("Дата вне сценария");

  // The same date again: the old refusal hides on Save, and the server's new answer shows it again.
  const answer = page.waitForResponse("**/api/action");
  await save(page).click();
  await answer;
  await expect(alert(page)).toContainText("Дата вне сценария");

  // Another date, and the request does not reach the server: the reason is the network, not the date.
  await dateField(page).fill(moscowDate(7));
  await page.route("**/api/action", route => route.abort("connectionrefused"));
  await save(page).click();
  await expect(alert(page)).toContainText("Нет связи с сервером");
  await expect(page.getByText("Дата вне сценария")).toHaveCount(0);
});

test("an overdue tile says how long ago; app texts name buttons, not chat commands", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "Начать" }).click();
  await page.getByRole("button", { name: /Русский/ }).click();
  await expect(page.getByText("Кнопка «Удалить мои данные»")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("/delete");
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByRole("button", { name: "Да, совпадает" }).click();
  await page.getByRole("button", { name: /KZ/ }).click();
  await dateField(page).fill(moscowDate(45));
  await save(page).click();
  await expect(page.getByRole("heading", { name: "Ваш план" })).toBeVisible();
  await expect(page.getByRole("button", { name: /прошёл \d+ \S+ назад/ }).first()).toContainText(/прошёл \d+ \S+ назад/);
  await page.screenshot({ path: testInfo.outputPath("4-plan-overdue.png"), fullPage: true, animations: "disabled" });

  await page.getByRole("button", { name: "Удалить мои данные" }).click();
  await page.getByRole("button", { name: "Да, удалить" }).click();
  await expect(page.getByText("Нажмите «Начать»")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("/start");
});

test("visit and completion screens: a nonexistent date shows the reason", async ({ page }) => {
  await toEntryDate(page);
  await dateField(page).fill(moscowDate(7));
  await save(page).click();
  await page.getByRole("button", { name: /^Медицинское освидетельствование/ }).click();

  await page.getByRole("button", { name: "Запланировать визит" }).click();
  const visit = page.getByRole("textbox", { name: "Когда пойдёте?" });
  await visit.pressSequentially("31022027");
  await expect(save(page)).toBeDisabled();
  await expect(alert(page)).toContainText("Такой даты нет");

  await visit.fill("");
  await visit.pressSequentially(moscowDate(1).replaceAll(".", "")); // yesterday: «Save» is off and the reason is shown
  await expect(save(page)).toBeDisabled();
  await expect(alert(page)).toContainText("Нужна дата не раньше сегодняшней");

  await visit.fill("");
  await visit.pressSequentially("01012099"); // a real day, but over a year ahead: the server refuses
  await save(page).click();
  await expect(alert(page)).toContainText("Нужна дата не раньше сегодняшней");
  await expect(page.locator("body")).not.toContainText("/plan");
  await visit.fill("");
  await visit.pressSequentially(moscowDate(0).replaceAll(".", "")); // the field is changed: the server's refusal goes away
  await expect(alert(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Отмена" }).click();

  await page.getByRole("button", { name: /^Медицинское освидетельствование/ }).click();
  await page.getByRole("button", { name: "Процедура пройдена" }).click();
  const done = page.getByRole("textbox", { name: "Когда вы прошли процедуру?" });
  await done.pressSequentially("31022026");
  await expect(save(page)).toBeDisabled();
  await expect(alert(page)).toContainText("Такой даты нет");

  await done.fill("");
  await done.pressSequentially(moscowDate(-1).replaceAll(".", "")); // tomorrow: «Save» is off and the reason is shown
  await expect(save(page)).toBeDisabled();
  await expect(alert(page)).toContainText("Нужна дата между въездом и сегодня");

  await done.fill("");
  await done.pressSequentially("01012020"); // a real day, but before entry: the server refuses
  await save(page).click();
  await expect(alert(page)).toContainText("Нужна дата между въездом и сегодня");
  await expect(page.locator("body")).not.toContainText("/plan");
  await done.fill("");
  await done.pressSequentially(moscowDate(0).replaceAll(".", ""));
  await expect(alert(page)).toHaveCount(0);
});

test("a tap shows it is waiting for the server: the document box and the text buttons", async ({ page }, testInfo) => {
  await toEntryDate(page);
  await dateField(page).fill(moscowDate(7));
  await save(page).click();
  await page.getByRole("button", { name: /^Медицинское освидетельствование/ }).click();

  // Hold the server's answers, so the waiting state stays on the screen; answer() lets the oldest one through.
  const held: (() => void)[] = [];
  await page.route("**/api/action", async route => {
    await new Promise<void>(resolve => held.push(resolve));
    await route.continue();
  });
  const answer = async () => { await expect.poll(() => held.length).toBeGreaterThan(0); held.shift()!(); };

  const passport = page.getByRole("checkbox", { name: /Паспорт$/ });
  await passport.click();
  await expect(passport).toHaveAttribute("aria-busy", "true");
  await page.screenshot({ path: testInfo.outputPath("6-document-waiting.png"), animations: "disabled" });
  await answer();
  await expect(passport).toHaveAttribute("aria-checked", "true");
  await expect(passport).toHaveAttribute("aria-busy", "false");

  await page.getByRole("button", { name: "Процедура пройдена" }).click();
  await answer();
  const cancel = page.getByRole("button", { name: "Отмена" });
  await cancel.click();
  await expect(cancel).toHaveAttribute("aria-busy", "true");
  await answer();
  await expect(page.getByRole("heading", { name: "Ваш план" })).toBeVisible();

  const remove = page.getByRole("button", { name: "Удалить мои данные" });
  await remove.click();
  await expect(remove).toHaveAttribute("aria-busy", "true");
  await answer();
  await expect(page.getByRole("button", { name: "Да, удалить" })).toBeVisible();
});

test("a saved visit comes back to the card with a confirmation, and a warning when it is after the deadline", async ({ page }, testInfo) => {
  await toEntryDate(page);
  await dateField(page).fill(moscowDate(7)); // the medical examination is due in about three weeks
  await save(page).click();
  await page.getByRole("button", { name: /^Медицинское освидетельствование/ }).click();
  const late = "позже расчётного срока";

  await page.getByRole("button", { name: "Запланировать визит" }).click();
  await page.getByRole("textbox", { name: "Когда пойдёте?" }).fill(moscowDate(-40));
  await save(page).click();
  await expect(page.getByRole("heading", { name: "Медицинское освидетельствование" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(`Визит записан: ${moscowDate(-40)}`);
  await expect(page.getByText(late)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("5-visit-late.png"), fullPage: true, animations: "disabled" });

  await page.getByRole("button", { name: "Изменить день визита" }).click();
  await page.getByRole("textbox", { name: "Когда пойдёте?" }).fill(moscowDate(-1));
  await save(page).click();
  await expect(page.getByRole("status")).toHaveText(`Визит записан: ${moscowDate(-1)}`);
  await expect(page.getByText(late)).toHaveCount(0);
  await page.getByRole("checkbox", { name: /Паспорт$/ }).click(); // the next action: the confirmation was about the save only
  await expect(page.getByRole("checkbox", { name: /Паспорт$/ })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("status")).toHaveCount(0);

  // Cancel leaves the question for the plan, as before; the confirmation is about a save only.
  await page.getByRole("button", { name: "Изменить день визита" }).click();
  await page.getByRole("button", { name: "Отмена" }).click();
  await expect(page.getByRole("heading", { name: "Ваш план" })).toBeVisible();
});

test("a marked yearly procedure comes back labelled as a repeat, with the date it was done", async ({ page }) => {
  await toEntryDate(page);
  await dateField(page).fill(moscowDate(7));
  await save(page).click();
  await page.getByRole("button", { name: /^Медицинское освидетельствование/ }).click();
  await page.getByRole("button", { name: "Процедура пройдена" }).click();
  await page.getByRole("textbox", { name: "Когда вы прошли процедуру?" }).fill(moscowDate(2));
  await save(page).click();
  await expect(page.getByRole("heading", { name: "Ваш план" })).toBeVisible();
  const tile = page.getByRole("button", { name: /^Медицинское освидетельствование/ });
  await expect(tile).toContainText("повторно (ежегодно)");
  await expect(tile).toContainText("пройдено вами");
  await tile.click();
  await expect(page.getByText("повторно (ежегодно) · пройдено вами")).toBeVisible();
});

test("circumstances changed (#91): case → event date → the chat's card → the deadline in the plan", async ({ page }, testInfo) => {
  await page.evaluate(() => {
    const w = globalThis as unknown as { WebApp: { HapticFeedback?: object; BackButton?: object }; haptics: string[]; back?: () => void };
    w.haptics = [];
    w.WebApp.HapticFeedback = { notificationOccurred: (type: string) => w.haptics.push(type), selectionChanged: () => {} };
    // The native Back button: the test presses it by calling the handler the app registered.
    w.WebApp.BackButton = { show: () => {}, hide: () => {}, onClick: (f: () => void) => { w.back = f; }, offClick: () => { delete w.back; } };
  });
  await toEntryDate(page);
  await dateField(page).fill(moscowDate(7));
  await save(page).click();
  await page.getByRole("button", { name: "Изменились обстоятельства" }).click();
  await expect(page.getByText("Что изменилось? Выберите случай")).toBeVisible();
  await page.getByRole("button", { name: "Переезд" }).click();
  await expect(page.getByRole("heading", { name: "Дата события" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("change-date.png"), fullPage: true, animations: "disabled" });
  // Back on the date question cancels it on the server, as the chat's Cancel does, and returns to the plan.
  await page.evaluate(() => (globalThis as unknown as { back: () => void }).back());
  await expect(page.getByRole("heading", { name: "Дата события" })).toBeHidden();
  await page.getByRole("button", { name: "Изменились обстоятельства" }).click();
  await page.getByRole("button", { name: "Переезд" }).click();
  await page.getByRole("button", { name: "Вчера" }).click();
  await expect(page.getByRole("status")).toHaveText("Дата сохранена.");
  await expect(page.getByRole("heading", { name: "Переезд" })).toBeVisible();
  await expect(page.locator("body")).toContainText("Ваш шаг — сейчас: сразу после заселения или возвращения передайте паспорт и миграционную карту");
  await expect(page.locator("body")).toContainText("Допущение: если вы живёте в общежитии");
  await expect(page.locator("body")).not.toContainText("/plan");
  await expect(page.getByRole("button", { name: /^Переоформить учёт/ })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as unknown as { haptics: string[] }).haptics)).toContain("success");
  await page.screenshot({ path: testInfo.outputPath("change-card.png"), fullPage: true, animations: "disabled" });
  await page.reload();
  await expect(page.getByRole("button", { name: /^Переезд — / })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("change-plan.png"), fullPage: true, animations: "disabled" });
});
