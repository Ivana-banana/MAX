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

  await page.route("**/api/action", route => route.fulfill({ status: 500, body: "{}" }));
  await save(page).click();
  await expect(page.getByRole("alert")).toContainText("Сервер не смог обработать действие");
  await expect(dateField(page)).toHaveValue(moscowDate(7)); // the screen and the input survive

  await page.unroute("**/api/action");
  await page.route("**/api/action", route => route.fulfill({ status: 429, headers: { "retry-after": "60" }, body: "{}" }));
  await save(page).click();
  await expect(page.getByRole("alert")).toContainText("Слишком много действий подряд");

  await page.unroute("**/api/action");
  await page.route("**/api/action", route => route.abort("connectionrefused"));
  await save(page).click();
  await expect(page.getByRole("alert")).toContainText("Нет связи с сервером");
  await page.screenshot({ path: testInfo.outputPath("2-api-error.png"), fullPage: true, animations: "disabled" });

  await page.unroute("**/api/action");
  await save(page).click();
  await expect(page.getByRole("heading", { name: "Ваш план" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("empty and invalid date: Save stays off or the reason is shown", async ({ page }, testInfo) => {
  await toEntryDate(page);
  await expect(save(page)).toBeDisabled(); // empty

  await dateField(page).pressSequentially("1203");
  await expect(save(page)).toBeDisabled(); // incomplete

  await dateField(page).fill("");
  await dateField(page).pressSequentially("31022026");
  await expect(save(page)).toBeDisabled(); // 31 February is not a day
  await expect(page.getByRole("alert")).toContainText("Такой даты нет"); // the reason is shown
  // Disabled looks disabled: the entrance animation must not keep opacity at 1.
  await expect(save(page)).toHaveCSS("opacity", "0.45");
  await page.screenshot({ path: testInfo.outputPath("3-nonexistent-date.png"), fullPage: true, animations: "disabled" });

  await dateField(page).fill("");
  await dateField(page).pressSequentially("01012020");
  await expect(save(page)).toBeEnabled(); // a real day; only the server knows the supported period
  await save(page).click();
  await expect(page.getByRole("alert")).toContainText("Дата вне сценария");
  await expect(page.getByRole("heading", { name: "Ваш план" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("3-invalid-date.png"), fullPage: true, animations: "disabled" });

  await dateField(page).fill("");
  await dateField(page).pressSequentially(moscowDate(-3).replaceAll(".", ""));
  await expect(page.getByRole("alert")).toContainText("не может быть в будущем");
  await expect(save(page)).toBeDisabled(); // the future
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
  await expect(page.getByRole("alert")).toContainText("Такой даты нет");

  await visit.fill("");
  await visit.pressSequentially(moscowDate(1).replaceAll(".", "")); // yesterday: «Save» is off and the reason is shown
  await expect(save(page)).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("Нужна дата не раньше сегодняшней");

  await visit.fill("");
  await visit.pressSequentially("01012099"); // a real day, but over a year ahead: the server refuses
  await save(page).click();
  await expect(page.getByRole("alert")).toContainText("Нужна дата не раньше сегодняшней");
  await expect(page.locator("body")).not.toContainText("/plan");
  await visit.fill("");
  await visit.pressSequentially(moscowDate(0).replaceAll(".", "")); // the field is changed: the server's refusal goes away
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Отмена" }).click();

  await page.getByRole("button", { name: /^Медицинское освидетельствование/ }).click();
  await page.getByRole("button", { name: "Процедура пройдена" }).click();
  const done = page.getByRole("textbox", { name: "Когда вы прошли процедуру?" });
  await done.pressSequentially("31022026");
  await expect(save(page)).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("Такой даты нет");

  await done.fill("");
  await done.pressSequentially(moscowDate(-1).replaceAll(".", "")); // tomorrow: «Save» is off and the reason is shown
  await expect(save(page)).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("Нужна дата между въездом и сегодня");

  await done.fill("");
  await done.pressSequentially("01012020"); // a real day, but before entry: the server refuses
  await save(page).click();
  await expect(page.getByRole("alert")).toContainText("Нужна дата между въездом и сегодня");
  await expect(page.locator("body")).not.toContainText("/plan");
  await done.fill("");
  await done.pressSequentially(moscowDate(0).replaceAll(".", ""));
  await expect(page.getByRole("alert")).toHaveCount(0);
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
