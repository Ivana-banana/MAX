import { readFileSync } from "node:fs";
import { parseRuleSet, type RuleSet } from "../data/loadRules.js";
import { readUniversities, type University } from "../data/loadUniversities.js";
export interface Config {
  mode: "demo" | "live"; transport: "console" | "max"; token: string; secret: string;
  dbPath: string; port: number; host: string; rulesPath: string; universitiesPath: string; defaultUniversity: string;
  /** Built mini app bundle; served by the same process, because MAX needs one public HTTPS origin. */
  webappDir: string;
  /** Origin of the Vite dev server, allowed through CORS. Local demo only. */
  webappDevOrigin: string;
}

/**
 * Whether the mini app may be opened without a verified MAX signature. True only for the local
 * synthetic demo, where there is no bot token and therefore nothing to verify against.
 */
export const webappDevLaunch = (config: Pick<Config, "mode" | "transport">) =>
  config.mode === "demo" && config.transport === "console";
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.APP_MODE ?? "demo", transport = env.TRANSPORT ?? "console";
  if (mode !== "demo" && mode !== "live") throw new Error("APP_MODE must be demo or live");
  if (transport !== "console" && transport !== "max") throw new Error("TRANSPORT must be console or max");
  const token = env.MAX_BOT_TOKEN ?? ""; // secret-scan: allow — environment lookup, not a credential
  if (transport === "max" && !token) throw new Error("MAX_BOT_TOKEN is required");
  if (mode === "live" && transport !== "max") throw new Error("Live mode requires MAX transport");
  const secret = env.WEBHOOK_SECRET ?? (mode === "demo" && transport === "console" ? "local-demo-only-not-for-deployment" : ""); // secret-scan: allow — public local demo fallback
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(secret)) throw new Error("WEBHOOK_SECRET must have 32–256 safe characters");
  if (transport === "max" && secret === "local-demo-only-not-for-deployment") throw new Error("Set your own WEBHOOK_SECRET for MAX");
  if (transport === "max" && env.DEBUG) throw new Error("Disable DEBUG: SDK diagnostics may contain personal data");
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  const webappDevOrigin = env.WEBAPP_DEV_ORIGIN ?? "";
  if (webappDevOrigin && !webappDevLaunch({ mode, transport })) {
    throw new Error("WEBAPP_DEV_ORIGIN belongs to the local demo only: remove it for MAX");
  }
  if (webappDevOrigin && !/^https?:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(webappDevOrigin)) {
    throw new Error("WEBAPP_DEV_ORIGIN must be a bare origin, e.g. http://localhost:5173");
  }
  return { mode, transport, token, secret, port, host: env.HOST ?? "127.0.0.1",
    webappDir: env.WEBAPP_DIR ?? "./web/dist", webappDevOrigin,
    dbPath: env.DB_PATH ?? "./data/bot.sqlite",
    rulesPath: env.RULES_PATH ?? "./src/data/rules/ru-student.json",
    universitiesPath: env.UNIVERSITIES_PATH ?? "./src/data/universities", defaultUniversity: env.DEFAULT_UNIVERSITY ?? "kfu" };
}
export function loadRules(config: Pick<Config, "rulesPath" | "mode">): RuleSet {
  const set = parseRuleSet(JSON.parse(readFileSync(config.rulesPath, "utf8")));
  if (config.mode === "live" && set.rules.some(r => r.legal.status !== "approved")) {
    throw new Error("Live mode blocked: rules require independent review. Do not approve rules just to bypass this guard.");
  }
  return set;
}
export function loadUniversities(config: Pick<Config, "universitiesPath" | "defaultUniversity">): University[] {
  return readUniversities(config.universitiesPath, config.defaultUniversity);
}
