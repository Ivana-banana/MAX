/**
 * Validation of MAX mini app startup data.
 *
 * The client cannot be trusted: `initDataUnsafe` is convenient to read but forgeable, so every
 * request from the mini app carries the raw `initData` string and the server recomputes the
 * signature itself. Algorithm, field names and the `WebAppData` key follow the official
 * instruction (https://dev.max.ru/docs/webapps/validation, checked 24.09.2026); the recommended
 * lifetime of `auth_date` is one hour (https://dev.max.ru/docs/webapps/bridge).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Recommended by MAX: startup data older than an hour is not accepted. */
export const LAUNCH_MAX_AGE = 3600;
/** A launch is a few hundred bytes; anything larger was not issued by MAX. */
export const LAUNCH_LIMIT = 4096;
/** Server and client clocks differ; a launch slightly "in the future" is still genuine. */
export const LAUNCH_SKEW = 300;

export type LaunchFailure =
  | "too_large" | "malformed" | "duplicate_key" | "no_hash" | "bad_signature" | "no_user" | "expired" | "future";

export class LaunchError extends Error {
  constructor(readonly reason: LaunchFailure) {
    super(`initData rejected: ${reason}`);
    this.name = "LaunchError";
  }
}

export interface Launch {
  /** MAX user id, taken from the signed payload and never from a request body. */
  userId: number;
  /** Unix seconds the startup data was issued at. */
  authDate: number;
  /** MAX interface language ("ru" from "ru-RU"); a hint only, the user can change it. */
  languageCode?: string;
  /** `?startapp=<payload>`, e.g. the university a QR poster points at. */
  startParam?: string;
}

const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8"), right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verifies the signature and returns only the fields the product needs.
 * Throws {@link LaunchError}; the caller answers 401 without explaining which check failed.
 */
export function verifyLaunch(initData: string, botToken: string, now: number): Launch {
  if (initData.length === 0 || initData.length > LAUNCH_LIMIT) throw new LaunchError("too_large");
  const fields: [string, string][] = [];
  const seen = new Set<string>();
  let hash: string | undefined;
  for (const pair of initData.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new LaunchError("malformed");
    const key = pair.slice(0, eq);
    if (seen.has(key)) throw new LaunchError("duplicate_key");
    seen.add(key);
    let value: string;
    try { value = decodeURIComponent(pair.slice(eq + 1)); } catch { throw new LaunchError("malformed"); }
    if (key === "hash") hash = value; else fields.push([key, value]);
  }
  if (hash === undefined) throw new LaunchError("no_hash");
  // Code-point order, not localeCompare: validation must not depend on the server's ICU locale.
  // For the documented key set (auth_date, chat, ip, query_id, start_param, user) both agree.
  fields.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const launchParams = fields.map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(launchParams).digest("hex");
  if (!sameString(expected, hash)) throw new LaunchError("bad_signature");

  const values = new Map(fields);
  const authDate = Number(values.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) throw new LaunchError("malformed");
  const age = Math.floor(now / 1000) - authDate;
  if (age > LAUNCH_MAX_AGE) throw new LaunchError("expired");
  if (age < -LAUNCH_SKEW) throw new LaunchError("future");

  let user: unknown;
  try { user = JSON.parse(values.get("user") ?? "null"); } catch { throw new LaunchError("no_user"); }
  const id = object(user)?.id;
  if (!Number.isSafeInteger(id) || Number(id) <= 0) throw new LaunchError("no_user");

  const locale = object(user)?.language_code;
  const startParam = values.get("start_param");
  return {
    userId: Number(id),
    authDate,
    ...(typeof locale === "string" && /^[A-Za-z_-]{2,16}$/.test(locale) ? { languageCode: locale } : {}),
    // MAX drops a payload longer than 512 characters or with other characters; re-check anyway.
    ...(startParam && /^[A-Za-z0-9_-]{1,512}$/.test(startParam) ? { startParam } : {}),
  };
}
