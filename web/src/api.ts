/**
 * Client for the mini app API.
 *
 * Every request carries the raw launch data; the server verifies the signature and derives the
 * user from it. The app never sends a user id — it does not know one it could be trusted about.
 */

import type { AppResult, AppStateResponse, AppTicket } from "../../src/webapp/contract.js";
import { initData } from "./bridge.js";

export type {
  AppDocument, AppLaunch, AppPlanItem, AppResult, AppSession, AppState, AppStep, AppUniversity,
} from "../../src/webapp/contract.js";

/** Why a request could not be made or was refused. The UI shows a sentence per case. */
export type ApiFailure = "no_launch" | "unauthorized" | "conflict" | "offline" | "server";

export class ApiError extends Error {
  constructor(readonly failure: ApiFailure, readonly revision?: number) {
    super(failure);
    this.name = "ApiError";
  }
}

/**
 * Local development only: a plain browser has no launch data, so `?demo=<id>` stands in. The
 * server accepts it solely with `APP_MODE=demo` and `TRANSPORT=console`, and marks the state
 * `mocked` so the screens can say the data is synthetic.
 */
function authorization(): string {
  const real = initData();
  if (real !== undefined && real !== "") return `MaxWebApp ${real}`;
  const demo = new URLSearchParams(window.location.search).get("demo");
  if (demo !== null && /^[0-9]{1,15}$/.test(demo)) return `MaxWebApp demo:${demo}`;
  throw new ApiError("no_launch");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", authorization());
  let response: Response;
  try {
    response = await fetch(new URL(path, document.baseURI), { ...init, headers, cache: "no-store" });
  } catch {
    throw new ApiError("offline");
  }
  if (response.status === 401 || response.status === 403) throw new ApiError("unauthorized");
  if (response.status === 409) {
    const body = await response.json().catch(() => ({})) as { revision?: number };
    throw new ApiError("conflict", body.revision);
  }
  if (!response.ok) throw new ApiError("server");
  return await response.json() as T;
}

export const getState = () => request<AppStateResponse>("api/state");

export const sendAction = (action: string, revision?: number) => request<AppResult>("api/action", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(revision === undefined ? { action } : { action, revision }),
});

/** A ticket, because a download cannot carry the Authorization header. */
export const calendarTicket = () => request<AppTicket>("api/calendar-ticket", { method: "POST" });
