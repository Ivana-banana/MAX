import { defineConfig, devices } from "@playwright/test";

// Mini app e2e: the built bot serves web/dist and /api in demo mode (`npm run e2e` builds both first).
const port = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "e2e",
  use: { ...devices["Pixel 7"], baseURL: `http://127.0.0.1:${port}`, locale: "ru-RU" },
  webServer: {
    command: "node e2e/server.mjs",
    url: `http://127.0.0.1:${port}/health`,
    env: { PORT: String(port) },
    timeout: 120_000,
  },
});
