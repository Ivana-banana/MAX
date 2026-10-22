/**
 * «Изменились обстоятельства» (#91): the chat's /change (#41, D-061) on screens.
 *
 * The list of cases and the card of one case. Every sentence is the chat's: the server sends its card
 * text word for word (`AppChange.card`), so the app never words a legal deadline on its own. The date
 * question is the shared `DateStep` (App.tsx) on the session step `changeDate`.
 */

import type { AppChange, AppSession } from "../api.js";
import { openLink } from "../bridge.js";
import { isText, text, type Texts } from "../texts.js";
import { Button, Rich } from "../ui.js";

/** `openChange` value for the list of cases; any other value is the id of a case. */
export const CHANGE_LIST = "";

/** What changed: the chat's cases under the chat's question. */
export function ChangeList({ session, texts, pending, onAction, onOpen }: {
  session: AppSession; texts: Texts; pending: string | null; onAction: (action: string) => void; onOpen: (id: string) => void;
}) {
  const t = (key: string) => text(texts, key);
  return (
    <div className="stack">
      <h1 className="heading in">{t("btn.change")}</h1>
      <p className="prose in d1"><Rich text={session.changeIntro} /></p>
      <div className="in d2 stack">
        {session.changes.map(change => (
          // A counted case asks for the date first, as the chat does; a new passport has no date: its card at once.
          <Button key={change.id} tone="outline" loading={pending === `change:${change.id}`} disabled={pending !== null}
            onClick={() => (change.dated ? onAction(`change:${change.id}`) : onOpen(change.id))}>
            {change.title}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** One case: the chat's card, the university's procedure, its law and university links, and the chat's two buttons once a date is entered. */
export function ChangeCard({ session, texts, change, message, pending, onAction }: {
  session: AppSession; texts: Texts; change: AppChange; message: string; pending: string | null; onAction: (action: string) => void;
}) {
  const t = (key: string) => text(texts, key);
  // The server's reply to the last action: the date saved, or the deadline closed by the torn-off part.
  const result = ["change.saved", "change.closed"].find(key => isText(message, t(key)));
  return (
    <div className="stack">
      {result !== undefined && <p className="caps in" role="status">{t(result).trim()}</p>}
      <h1 className="heading in">{change.title}</h1>
      <p className="prose change-card in d1"><Rich text={change.card} /></p>
      {change.event !== undefined && (
        <Button className="in d2" arrow="✓" loading={pending === `change-done:${change.id}`} disabled={pending !== null}
          onClick={() => onAction(`change-done:${change.id}`)}>
          {t("btn.tornOff")}
        </Button>
      )}
      {change.dated && (
        <Button className="in d2" tone="outline" arrow="🗓" loading={pending === `change:${change.id}`} disabled={pending !== null}
          onClick={() => onAction(`change:${change.id}`)}>
          {t("btn.changeDate")}
        </Button>
      )}
      {change.procedure !== undefined && (
        <Button className="in d3" tone="outline" arrow="↗" onClick={() => openLink(change.procedure!.url)}>{change.procedure.title}</Button>
      )}
      <Button className="in d3" tone="outline" arrow="↗" onClick={() => openLink(change.lawUrl)}>{t("btn.law")}</Button>
      <button type="button" className="link in d4" onClick={() => openLink(session.university.contactUrl)}>{t("app.contact")}</button>
    </div>
  );
}
