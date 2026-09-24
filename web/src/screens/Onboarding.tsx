/**
 * Steps before a plan exists: language, consent, scope, citizenship, entry date.
 *
 * The wording of consent and scope comes from the server (`status.message`): it is the text a
 * lawyer reads and the chat already shows, so the app must not paraphrase it. The language list
 * is data too — whatever files exist in `src/data/i18n`.
 */

import { useEffect, useState } from "react";
import { Button, CellHeader, CellList, CellSimple, Input, Typography } from "@maxhub/max-ui";
import type { AppSession, AppState } from "../api.js";
import { closingConfirmation } from "../bridge.js";
import { text, type Texts } from "../texts.js";

interface Props {
  session: AppSession;
  texts: Texts;
  languages: AppState["languages"];
  message: string;
  today: string;
  pending: string | null;
  onAction: (action: string) => void;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function Onboarding({ session, texts, languages, message, today, pending, onAction }: Props) {
  const t = (key: string) => text(texts, key);
  const busy = pending !== null;

  if (session.step === "language") {
    return (
      <CellList mode="island" header={<CellHeader>{t("language.choose")}</CellHeader>}>
        {languages.map(language => (
          <CellSimple
            key={language.code} title={language.name} showChevron disabled={busy}
            onClick={() => onAction(language.code)}
          />
        ))}
      </CellList>
    );
  }

  if (session.step === "consent") {
    const other = languages.find(language => language.code !== session.lang);
    return (
      <div className="stack">
        <Typography.Title variant="small">{t("app.consentTitle")}</Typography.Title>
        <Typography.Text variant="body" color="secondary" className="prose">{message}</Typography.Text>
        <Button stretched loading={pending === "accept"} disabled={busy} onClick={() => onAction("accept")}>
          {t("btn.continue")}
        </Button>
        {other !== undefined && (
          <Button stretched variant="ghost" disabled={busy} onClick={() => onAction(other.code)}>
            {other.name}
          </Button>
        )}
      </div>
    );
  }

  if (session.step === "scope") {
    return (
      <div className="stack">
        <Typography.Title variant="small">{t("app.scopeTitle")}</Typography.Title>
        <Typography.Text variant="body" color="secondary" className="prose">{message}</Typography.Text>
        <Button stretched loading={pending === "yes"} disabled={busy} onClick={() => onAction("yes")}>
          {t("btn.yes")}
        </Button>
        <Button stretched variant="secondary" disabled={busy} onClick={() => onAction("OTHER")}>
          {t("btn.no")}
        </Button>
      </div>
    );
  }

  if (session.step === "citizenship") {
    return (
      <CellList mode="island" header={<CellHeader>{t("app.citizenshipTitle")}</CellHeader>}>
        {session.citizenships.map(code => (
          <CellSimple key={code} title={code} showChevron disabled={busy} onClick={() => onAction(code)} />
        ))}
        <CellSimple title={t("app.citizenshipOther")} disabled={busy} onClick={() => onAction("OTHER")} />
      </CellList>
    );
  }

  return <EntryDate texts={texts} today={today} message={message} pending={pending} onAction={onAction} />;
}

function EntryDate({ texts, today, message, pending, onAction }: {
  texts: Texts; today: string; message: string; pending: string | null; onAction: (action: string) => void;
}) {
  const [value, setValue] = useState("");
  const t = (key: string) => text(texts, key);
  const valid = DATE.test(value) && value <= today;
  // A half-filled date is worth a confirmation before MAX closes the app over it.
  useEffect(() => {
    closingConfirmation(value !== "");
    return () => closingConfirmation(false);
  }, [value]);

  return (
    <div className="stack">
      <Typography.Title variant="small">{t("app.entryTitle")}</Typography.Title>
      <Typography.Text variant="body" color="secondary" className="prose">{message}</Typography.Text>
      <Input
        type="date" value={value} max={today} hint={t("app.entry.hint")} aria-label={t("app.entryTitle")}
        onChange={event => setValue(event.target.value)}
      />
      <Button stretched loading={pending !== null} disabled={!valid || pending !== null} onClick={() => onAction(value)}>
        {t("app.save")}
      </Button>
    </div>
  );
}
