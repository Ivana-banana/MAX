import { configDefaults, defineConfig } from "vitest/config";

// Worktrees live inside the main checkout: their tests belong to other branches and dependencies.
// e2e/ belongs to Playwright (npm run e2e).
export default defineConfig({ test: { exclude: [...configDefaults.exclude, ".claude/**", "e2e/**"], globalSetup: ["tests/setup-postgres.ts"] } });
