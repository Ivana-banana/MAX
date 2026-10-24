// Renders mini app screens for the HTML deck drafts: the built bot in demo mode, Pixel 7, training data.
// These are renders from code, not MAX screenshots; the deck marks them for replacement (#38, #33).
// Run from the repo root after `npm run build && npm run web:build`: node docs/presentation/html/screens.mjs
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium, devices } from "@playwright/test";

const port = 3190;
const out = new URL("./screens/", import.meta.url).pathname;

const server = spawn("node", ["e2e/server.mjs"], { env: { ...process.env, PORT: String(port) }, stdio: "inherit" });
const stop = () => server.kill("SIGTERM");

async function waitHealth() {
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}

/** Moscow calendar date `daysAgo` days back, as DD.MM.YYYY. */
function moscowDate(daysAgo) {
  const day = new Date(Date.now() - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", year: "numeric" }).format(day);
}

try {
  await waitHealth();
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch();
  // Scale 2 instead of Pixel 7's 2.625: sharp at slide size, lighter once inlined into the deck.
  const context = await browser.newContext({ ...devices["Pixel 7"], deviceScaleFactor: 2, locale: "ru-RU", colorScheme: "light" });
  const page = await context.newPage();
  await page.route("https://st.max.ru/**", route => route.fulfill({ contentType: "text/javascript", body: "" }));
  await page.addInitScript(() => {
    globalThis.WebApp = { initData: "", platform: "android", version: "26.0", enableClosingConfirmation() {}, disableClosingConfirmation() {} };
  });
  const shot = async name => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}${name}.jpg`, type: "jpeg", quality: 82, animations: "disabled" });
  };

  await page.goto(`http://127.0.0.1:${port}/?demo=${Math.floor(Math.random() * 1_000_000) + 1}`);
  await shot("01-start");
  await page.getByRole("button", { name: "Начать" }).click();
  await shot("02-language");
  await page.getByRole("button", { name: /Русский/ }).click();
  await shot("03-consent");
  await page.getByRole("button", { name: "Продолжить" }).click();
  await shot("04-scope");
  await page.getByRole("button", { name: "Да, совпадает" }).click();
  await shot("05-citizenship");
  await page.getByRole("button", { name: /KZ/ }).click();
  await page.getByRole("textbox", { name: "Дата въезда" }).pressSequentially(moscowDate(7).replaceAll(".", ""));
  await shot("06-entry-date");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.getByRole("heading", { name: "Ваш план" }).waitFor();
  await shot("07-plan");
  await page.getByRole("button", { name: /^Медицинское освидетельствование/ }).click();
  await shot("08-card");
  // The tick goes through the server, so wait for the state instead of Playwright's instant check().
  const passport = page.getByRole("checkbox", { name: /Паспорт$/ });
  await passport.click();
  await page.waitForFunction(() => document.querySelector('[role="checkbox"][aria-checked="true"]'));
  await page.mouse.wheel(0, 500);
  await shot("09-card-documents");

  // A second training user for the pre-arrival branch: it leaves the entry date screen.
  await page.goto(`http://127.0.0.1:${port}/?demo=${Math.floor(Math.random() * 1_000_000) + 1_000_001}`);
  await page.getByRole("button", { name: "Начать" }).click();
  await page.getByRole("button", { name: /Русский/ }).click();
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByRole("button", { name: "Да, совпадает" }).click();
  await page.getByRole("button", { name: /KZ/ }).click();
  await page.getByRole("button", { name: /Ещё не в России/ }).click();
  await shot("10-pre-arrival");
  await browser.close();
} finally {
  stop();
}
