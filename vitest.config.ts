import { configDefaults, defineConfig } from "vitest/config";

// Worktrees live inside the main checkout: their tests belong to other branches and dependencies.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, ".claude/**"], globalSetup: ["tests/setup-postgres.ts"] } });
