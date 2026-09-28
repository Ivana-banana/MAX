/**
 * Steps before a plan exists: language, consent, scope, citizenship, entry date.
 *
 * The wording of consent and scope comes from the server (`session.prompt`): it is the text a
 * lawyer reads and the chat already shows, so the app must not paraphrase it. The language list
 * is data too — whatever files exist in `src/data/i18n`.
 */

import { useEffect, useState } from "react";
import type { AppSession, AppState } from "../api.js";
import { closingConfirmation, openLink } from "../bridge.js";
import { DateField } from "../DateField.js";
import { isText, text, type Texts } from "../texts.js";
import { Button } from "../ui.js";
import { Question } from "./Card.js";

interface Props {
  session: AppSession;
  texts: Texts;
  languages: AppState["languages"];
  message: string;
  /** The ready question to the university when the last answer led out of the scenario. */
  copy: string;
  today: string;
  pending: string | null;
  onAction: (action: string) => void;
}

/** "No" and "Other" lead out of the scenario, as in the chat: say so and hand over the question to the university. */
function Unsupported({ session, texts, copy }: { session: AppSession; texts: Texts; copy: string }) {
  const t = (key: string) => text(texts, key);
  return (
    <>
      <p className="prose in" role="status">{t("help.unsupported")}</p>
      <Question key={copy} texts={texts} copy={copy} />
      <button type="button" className="link in" onClick={() => openLink(session.university.contactUrl)}>{t("app.contact")}</button>
    </>
  );
}

export function Onboarding({ session, texts, languages, message, copy, today, pending, onAction }: Props) {
  const t = (key: string) => text(texts, key);
  const busy = pending !== null;

  if (session.step === "language") {
    return (
      <div className="stack">
        <h1 className="display title in">{t("language.choose")}</h1>
        <div className="rows in d1">
          {languages.map(language => (
            <button key={language.code} type="button" className="row" disabled={busy} onClick={() => onAction(language.code)}>
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
        <p className="prose in d1">{session.prompt}</p>
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
        <p className="prose in d1">{session.prompt}</p>
        <Button className="in d2" loading={pending === "yes"} disabled={busy} onClick={() => onAction("yes")}>
          {t("btn.yes")}
        </Button>
        <Button className="in d3" tone="outline" arrow="×" loading={pending === "OTHER"} disabled={busy} onClick={() => onAction("OTHER")}>
          {t("btn.no")}
        </Button>
        {copy !== "" && <Unsupported session={session} texts={texts} copy={copy} />}
      </div>
    );
  }

  if (session.step === "citizenship") {
    // Country names in the user's language, as the chat shows them (Intl knows every language).
    const names = new Intl.DisplayNames([session.lang], { type: "region" });
    return (
      <div className="stack">
        <h1 className="display title in">{t("app.citizenshipTitle")}</h1>
        <div className="tiles in d1">
          {session.citizenships.map(code => (
            <button key={code} type="button" className="tile" disabled={busy} onClick={() => onAction(code)}>
              <span className="code">{code}</span>
              <span className="name">{pending === code ? "…" : names.of(code) ?? code}</span>
            </button>
          ))}
          <button type="button" className="tile tile-wide" disabled={busy} onClick={() => onAction("OTHER")}>
            <span className="name">{t("app.citizenshipOther")}</span>
          </button>
        </div>
        {copy !== "" && <Unsupported session={session} texts={texts} copy={copy} />}
      </div>
    );
  }

  return <EntryDate texts={texts} today={today} message={message} pending={pending} onAction={onAction} />;
}

function EntryDate({ texts, today, message, pending, onAction }: {
  texts: Texts; today: string; message: string; pending: string | null; onAction: (action: string) => void;
}) {
  const [value, setValue] = useState("");
  const [typed, setTyped] = useState("");
  const [edited, setEdited] = useState(false);
  const t = (key: string) => text(texts, key);
  const valid = value !== "" && value <= today;
  // Say why Save is off right away, and drop the server's error once the user changes the date.
  const prompt = value > today ? t("app.entry.future")
    : !edited && isText(message, t("entry.invalid")) ? t("app.entry.invalid") : t("app.entry.body");
  const warning = value > today || (!edited && isText(message, t("entry.invalid")));
  // A half-filled date is worth a confirmation before MAX closes the app over it.
  useEffect(() => {
    closingConfirmation(typed !== "");
    return () => closingConfirmation(false);
  }, [typed]);

  return (
    <div className="stack">
      <h1 className="display title in">{t("app.entryTitle")}</h1>
      {/* The dialogue's prompt asks for YYYY-MM-DD, which this field does not take. */}
      <p className={`prose in d1 ${warning ? "banner banner-error" : ""}`} role={warning ? "alert" : undefined}>{prompt}</p>
      <div className="in d2">
        <DateField label={t("app.entryTitle")} hint={t("app.entry.hint")}
          onChange={(iso, display) => { setValue(iso); setTyped(display); setEdited(true); }} />
      </div>
      <Button className="in d3" loading={pending !== null} disabled={!valid || pending !== null}
        onClick={() => { setEdited(false); onAction(value); }}>
        {t("app.save")}
      </Button>
    </div>
  );
}
