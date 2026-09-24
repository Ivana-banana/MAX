/**
 * Steps before a plan exists: language, consent, scope, citizenship, entry date.
 *
 * The wording of consent and scope comes from the server (`status.message`): it is the text a
 * lawyer reads and the chat already shows, so the app must not paraphrase it.
 */

import { useEffect, useState } from "react";
import { Button, CellHeader, CellList, CellSimple, Input, Typography } from "@maxhub/max-ui";
import type { AppSession } from "../api.js";
import { closingConfirmation } from "../bridge.js";
import { text, type Lang } from "../texts.js";

interface Props {
  session: AppSession;
  message: string;
  today: string;
  pending: string | null;
  onAction: (action: string) => void;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function Onboarding({ session, message, today, pending, onAction }: Props) {
  const lang: Lang = session.lang;
  const t = (key: Parameters<typeof text>[1]) => text(lang, key);
  const busy = (action: string) => pending === action;

  if (session.step === "language") {
    return (
      <CellList mode="island" header={<CellHeader>Язык / Language</CellHeader>}>
        <CellSimple title="Русский" showChevron onClick={() => onAction("ru")} disabled={pending !== null} />
        <CellSimple title="English" showChevron onClick={() => onAction("en")} disabled={pending !== null} />
      </CellList>
    );
  }

  if (session.step === "consent") {
    return (
      <div className="stack">
        <Typography.Title variant="small">{t("consentTitle")}</Typography.Title>
        <Typography.Text variant="body" color="secondary" className="prose">{message}</Typography.Text>
        <Button stretched loading={busy("accept")} disabled={pending !== null} onClick={() => onAction("accept")}>
          {t("consentAccept")}
        </Button>
        <Button stretched variant="ghost" disabled={pending !== null} onClick={() => onAction(lang === "ru" ? "en" : "ru")}>
          {lang === "ru" ? "English" : "Русский"}
        </Button>
      </div>
    );
  }

  if (session.step === "scope") {
    return (
      <div className="stack">
        <Typography.Title variant="small">{t("scopeTitle")}</Typography.Title>
        <Typography.Text variant="body" color="secondary" className="prose">{message}</Typography.Text>
        <Button stretched loading={busy("yes")} disabled={pending !== null} onClick={() => onAction("yes")}>
          {t("scopeYes")}
        </Button>
        <Button stretched variant="secondary" disabled={pending !== null} onClick={() => onAction("OTHER")}>
          {t("scopeNo")}
        </Button>
      </div>
    );
  }

  if (session.step === "citizenship") {
    return (
      <CellList mode="island" header={<CellHeader>{t("citizenshipTitle")}</CellHeader>}>
        {session.citizenships.map(code => (
          <CellSimple key={code} title={code} showChevron disabled={pending !== null} onClick={() => onAction(code)} />
        ))}
        <CellSimple
          title={t("citizenshipOther")} subtitle={t("outOfScopeBody")} subtitleMode="tertiary"
          disabled={pending !== null} onClick={() => onAction("OTHER")}
        />
      </CellList>
    );
  }

  return <EntryDate lang={lang} today={today} message={message} pending={pending} onAction={onAction} />;
}

function EntryDate({ lang, today, message, pending, onAction }: {
  lang: Lang; today: string; message: string; pending: string | null; onAction: (action: string) => void;
}) {
  const [value, setValue] = useState("");
  const t = (key: Parameters<typeof text>[1]) => text(lang, key);
  const valid = DATE.test(value) && value <= today;
  // A half-filled date is worth a confirmation before MAX closes the app over it.
  useEffect(() => {
    closingConfirmation(value !== "");
    return () => closingConfirmation(false);
  }, [value]);

  return (
    <div className="stack">
      <Typography.Title variant="small">{t("entryTitle")}</Typography.Title>
      <Typography.Text variant="body" color="secondary" className="prose">{message}</Typography.Text>
      <Input
        type="date" value={value} max={today} hint={t("entryHint")} aria-label={t("entryTitle")}
        onChange={event => setValue(event.target.value)}
      />
      <Button
        stretched loading={pending !== null} disabled={!valid || pending !== null}
        onClick={() => onAction(value)}
      >
        {t("save")}
      </Button>
    </div>
  );
}
