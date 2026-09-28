/**
 * Date entry as DD.MM.YYYY, the order students and university staff write dates in.
 *
 * Not `<input type="date">`: its format follows the browser locale (MM/DD/YYYY on an English
 * system), so the hint beside it could never match what the field shows. The server keeps
 * receiving `YYYY-MM-DD`.
 */

import { useId, useState } from "react";
import { mask, toIso } from "./dateInput.js";

export function DateField({ label, hint, onChange }: {
  /** `iso` is "" until the date is complete and real; `display` is what the field shows. */
  label: string; hint: string; onChange: (iso: string, display: string) => void;
}) {
  const [display, setDisplay] = useState("");
  const hintId = useId();
  return (
    <label className="datefield">
      <input
        type="text" inputMode="numeric" autoComplete="off" maxLength={10}
        placeholder={hint} aria-label={label} aria-describedby={hintId} value={display}
        onChange={event => {
          const next = mask(event.target.value);
          setDisplay(next);
          onChange(toIso(next), next);
        }}
      />
      <span className="hint" id={hintId}>{hint}</span>
    </label>
  );
}
