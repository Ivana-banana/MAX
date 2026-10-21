/**
 * The few controls every screen shares, in the poster style of app.css.
 *
 * Native buttons with ARIA roles rather than MAX UI components: MAX UI styles its parts through
 * hashed class names, so restyling them would break on its next release. Behaviour stays plain —
 * a button is a <button>, a switch announces its state, a checkbox says whether it is checked.
 */

import type { ReactNode } from "react";

export function Button({ children, onClick, tone = "red", loading = false, disabled = false, arrow = "→", className = "" }: {
  children: ReactNode;
  onClick: () => void;
  tone?: "red" | "ink" | "outline";
  loading?: boolean;
  disabled?: boolean;
  arrow?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`btn ${tone === "red" ? "" : `btn-${tone}`} ${loading ? "btn-loading" : ""} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading}
      onClick={onClick}
    >
      <span>{children}</span>
      <span className="arrow" aria-hidden="true">{loading ? "…" : arrow}</span>
    </button>
  );
}

export function Switch({ checked, label, disabled, onChange }: {
  checked: boolean; label: string; disabled?: boolean; onChange: () => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      className="switch" disabled={disabled} onClick={onChange}>
      <i />
    </button>
  );
}

/** Two digits, the numbering of a poster list: 01, 02, … */
export const ordinal = (index: number): string => String(index + 1).padStart(2, "0");

/** `YYYY-MM-DD` → `DD.MM.YYYY`, the same order the date field asks for. */
export const dotted = (iso: string): string => iso.split("-").reverse().join(".");

/** `YYYY-MM-DD` → `DD.MM`, for large deadline figures. */
export const dayMonth = (iso: string): string => dotted(iso).slice(0, 5);

/** Wraps every run of digits, so a title like "Первые 90 дней" gets its number in red. */
export function Accented({ text }: { text: string }) {
  return <>{text.split(/(\d+)/).map((part, i) => (/^\d+$/.test(part) ? <span key={i} className="r">{part}</span> : part))}</>;
}

/**
 * The line above a date field: the prompt, or the reason the date is refused, in the error style.
 * The alert region stays on the page and only its text changes, so a screen reader announces every new reason.
 */
export function DateNote({ prompt, error, className }: { prompt: string; error: string; className: string }) {
  return (
    <p className={`prose ${className} ${error === "" ? "" : "banner banner-error"}`}>
      <span role="alert">{error}</span>
      {error === "" && prompt}
    </p>
  );
}
