/**
 * Single source of screen state: what the server says, what is in flight, what failed.
 *
 * Every user action goes through `dispatch`, so each one has a loading, a result and an error
 * state — a direct requirement of the UX criterion. A failed action never silently looks like a
 * success and never discards the screen: the previous state stays, so the user continues instead
 * of restarting the app.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getState, sendAction, type ApiFailure } from "./api.js";
import type { AppLaunch, AppState } from "../../src/webapp/contract.js";

export interface AppStatus {
  state: AppState | null;
  launch: AppLaunch;
  /** First load, before there is anything to render. */
  loading: boolean;
  /** Action currently in flight, so the pressed control can show a spinner. */
  pending: string | null;
  error: ApiFailure | null;
  /** Wording from the dialogue for the last action: the app shows it instead of inventing text. */
  message: string;
  /** The ready question to the university from the last reply, when it offered one to copy. */
  copy: string;
}

const initial: AppStatus = { state: null, launch: {}, loading: true, pending: null, error: null, message: "", copy: "" };

export function useApp() {
  const [status, setStatus] = useState<AppStatus>(initial);
  // Guards against a late response from an action the user has already replaced.
  const sequence = useRef(0);

  /** True when the server's state is on screen now. */
  const load = useCallback(async (): Promise<boolean> => {
    const ticket = ++sequence.current;
    setStatus(previous => ({ ...previous, loading: previous.state === null, error: null }));
    try {
      const { state, launch } = await getState();
      if (ticket !== sequence.current) return false;
      setStatus({ state, launch, loading: false, pending: null, error: null, message: "", copy: "" });
      return true;
    } catch (e) {
      if (ticket !== sequence.current) return false;
      setStatus(previous => ({
        ...previous, loading: false, pending: null,
        error: e instanceof ApiError ? e.failure : "server",
      }));
      return false;
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const dispatch = useCallback(async (action: string) => {
    const ticket = ++sequence.current;
    setStatus(previous => ({ ...previous, pending: action, error: null }));
    try {
      const result = await sendAction(action, status.state?.session?.revision);
      if (ticket !== sequence.current) return;
      setStatus(previous => ({
        ...previous, state: result.state, pending: null, error: null, loading: false, message: result.message,
        copy: result.copy ?? "",
      }));
    } catch (e) {
      if (ticket !== sequence.current) return;
      const failure = e instanceof ApiError ? e.failure : "server";
      setStatus(previous => ({ ...previous, pending: null, error: failure }));
      // Somebody else moved the session on: show the server's version rather than guess, then say why it changed.
      if (failure === "conflict" && await load()) setStatus(previous => ({ ...previous, error: "conflict" }));
    }
  }, [load, status.state?.session?.revision]);

  const dismiss = useCallback(() => setStatus(previous => ({ ...previous, error: null, message: "", copy: "" })), []);

  return { status, dispatch, reload: load, dismiss };
}
