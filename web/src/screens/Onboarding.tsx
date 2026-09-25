/**
 * Steps before a plan exists: language, consent, scope, citizenship, entry date.
 *
 * The wording of consent and scope comes from the server (`status.message`): it is the text a
 * lawyer reads and the chat already shows, so the app must not paraphrase it. The language list
 * is data too — whatever files exist in `src/data/i18n`.
 */

import { useEffect, useState } from "react";
import type { AppSession, AppState } from "../api.js";
import { closingConfirmation } from "../bridge.js";
import { DateField } from "../DateField.js";
import { text, type Texts } from "../texts.js";
import { Button, ordinal } from "../ui.js";

interface Props {
  session: AppSession;
  texts: Texts;
  languages: AppState["languages"];
  message: string;
  today: string;
  pending: string | null;
  onAction: (action: string) => void;
}

export function Onboarding({ session, texts, languages, message, today, pending, onAction }: Props) {
  const t = (key: string) => text(texts, key);
  const busy = pending !== null;

  if (session.step === "language") {
    return (
      <div className="stack">
        <h1 className="display title in">{t("language.choose")}</h1>
        <div className="rows in d1">
          {languages.map((language, index) => (
            <button key={language.code} type="button" className="row" disabled={busy} onClick={() => onAction(language.code)}>
              <span className="num">{ordinal(index)}</span>
              <span>{language.name}</span>
              <span className="go" aria-hidden="true">{pending === language.code ? "…" : "→"}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (session.step === "consent") {
    const other = languages.find(language => language.code !== session.lang);
    return (
      <div className="stack">
        <h1 className="display title in">{t("app.consentTitle")}</h1>
        <p className="prose in d1">{message}</p>
        <Button className="in d2" loading={pending === "accept"} disabled={busy} onClick={() => onAction("accept")}>
          {t("btn.continue")}
        </Button>
        {other !== undefined && (
          <button type="button" className="link in d3" disabled={busy} onClick={() => onAction(other.code)}>
            {other.name}
          </button>
        )}
      </div>
    );
  }

  if (session.step === "scope") {
    return (
      <div className="stack">
        <h1 className="heading in">{t("app.scopeTitle")}</h1>
        <p className="prose in d1">{message}</p>
        <Button className="in d2" loading={pending === "yes"} disabled={busy} onClick={() => onAction("yes")}>
          {t("btn.yes")}
        </Button>
        <Button className="in d3" tone="outline" arrow="×" loading={pending === "OTHER"} disabled={busy} onClick={() => onAction("OTHER")}>
          {t("btn.no")}
        </Button>
      </div>
    );
  }

  if (session.step === "citizenship") {
    return (
      <div className="stack">
        <h1 className="display title in">{t("app.citizenshipTitle")}</h1>
        <div className="tiles in d1">
          {session.citizenships.map((code, index) => (
            <button key={code} type="button" className="tile" disabled={busy} onClick={() => onAction(code)}>
              <span className="code">{code}</span>
              <span className="name">{pending === code ? "…" : ordinal(index)}</span>
            </button>
          ))}
          <button type="button" className="tile tile-wide" disabled={busy} onClick={() => onAction("OTHER")}>
            <span className="name">{t("app.citizenshipOther")}</span>
          </button>
        </div>
      </div>
    );
  }

  return <EntryDate texts={texts} today={today} message={message} pending={pending} onAction={onAction} />;
}

function EntryDate({ texts, today, message, pending, onAction }: {
  texts: Texts; today: string; message: string; pending: string | null; onAction: (action: string) => void;
}) {
  const [value, setValue] = useState("");
  const [edited, setEdited] = useState(false);
  const t = (key: string) => text(texts, key);
  const valid = value !== "" && value <= today;
  // Say why Save is off right away, and drop the server's error once the user changes the date.
  const prompt = value > today ? t("app.entry.future")
    : !edited && message.includes(t("entry.invalid")) ? t("app.entry.invalid") : t("app.entry.body");
  const warning = value > today || (!edited && message.includes(t("entry.invalid")));
  // A half-filled date is worth a confirmation before MAX closes the app over it.
  useEffect(() => {
    closingConfirmation(value !== "");
    return () => closingConfirmation(false);
  }, [value]);

  return (
    <div className="stack">
      <h1 className="display title in">{t("app.entryTitle")}</h1>
      {/* The dialogue's prompt asks for YYYY-MM-DD, which this field does not take. */}
      <p className={`prose in d1 ${warning ? "banner banner-error" : ""}`} role={warning ? "alert" : undefined}>{prompt}</p>
      <div className="in d2">
        <DateField label={t("app.entryTitle")} hint={t("app.entry.hint")}
          onChange={iso => { setValue(iso); setEdited(true); }} />
      </div>
      <Button className="in d3" loading={pending !== null} disabled={!valid || pending !== null}
        onClick={() => { setEdited(false); onAction(value); }}>
        {t("app.save")}
      </Button>
    </div>
  );
}
