/**
 * One procedure: what to do, the document checklist, the legal basis and the date it was checked.
 *
 * The source is shown next to the date on purpose. A deadline without its basis is exactly the
 * kind of confident-sounding answer this product is built to replace.
 */

import { useState } from "react";
import type { AppPlanItem, AppSession } from "../api.js";
import { openLink, tap } from "../bridge.js";
import { fill, text, type Texts } from "../texts.js";
import { Button, dayMonth, dotted, ordinal } from "../ui.js";

interface Props {
  session: AppSession;
  texts: Texts;
  item: AppPlanItem;
  /** The last action saved this card's visit: the card confirms it, as the chat does. */
  visitSaved: boolean;
  pending: string | null;
  /** The ready question to the university from the last reply (the chat's "Copy" button). */
  copy: string;
  onAction: (action: string) => void;
}

/** Clipboard where the webview allows it; otherwise the text stays selectable on screen. */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** The chat's ready question to the university, with its "Copy" button. */
export function Question({ texts, copy }: { texts: Texts; copy: string }) {
  const t = (key: string) => text(texts, key);
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="help in">
      <h2 className="section"><span>{t("app.question")}</span></h2>
      <p className="quote prose">{copy}</p>
      <Button tone="ink" arrow={copied ? "✓" : "⧉"} onClick={() => void copyText(copy).then(ok => { setCopied(ok); tap(ok ? "success" : "warning"); })}>
        {copied ? t("app.copied") : t("btn.copy")}
      </Button>
      {copied === false && <p className="small muted">{t("app.copyManual")}</p>}
    </div>
  );
}

export function Card({ session, texts, item, visitSaved, pending, copy, onAction }: Props) {
  const t = (key: string) => text(texts, key);
  // The help branch is the chat's: the question comes from the dialogue, not from the app.
  const [helpAsked, setHelpAsked] = useState(false);
  const overdue = item.status === "overdue";
  const checked = item.documents.filter(document => document.checked).length;
  const calm = item.status === "ok" || item.status === "done";
  // The chat warns once, on saving; the card keeps the warning while the visit stays after the deadline.
  const visitLate = item.visit !== undefined && item.status !== "done" && item.visit > item.dueDate;

  return (
    <div className="stack">
      {visitSaved && item.visit !== undefined && <p className="caps in" role="status">{fill(t("visit.saved"), { date: dotted(item.visit) })}</p>}
      <h1 className="heading in">{item.title}</h1>

      <div className={`deadline ${calm ? "deadline-calm" : ""} in d1`}>
        <span className="big">{dayMonth(item.dueDate)}</span>
        <span className="label">{item.countdown}</span>
      </div>

      <div className="facts in d1">
        {item.repeat !== undefined && <span>{`${item.repeat.label} · ${item.repeat.doneOn}`}</span>}
        {item.target !== undefined ? <span>{item.target}</span>
          : item.recommendedDate !== undefined && <span>{`${t("app.recommended")}: ${dotted(item.recommendedDate)}`}</span>}
        {item.provisional && <span>{t("app.provisional")}</span>}
        {item.visit !== undefined && <span>{`${t("app.visit")}: ${dotted(item.visit)}`}</span>}
      </div>
      {visitLate && <p className="prose in d1">{fill(t("visit.late"), { due: dotted(item.dueDate) })}</p>}

      <p className="prose in d2">{item.action}</p>

      <div className="in d3">
        <h2 className="section"><span>{t("app.documents")}</span><span>{`${checked} / ${item.documents.length}`}</span></h2>
        {item.documents.map((document, index) => (
          <button
            key={document.id}
            type="button"
            role="checkbox"
            aria-checked={document.checked}
            className="doc"
            disabled={pending !== null}
            onClick={() => { tap(); onAction(`doc:${item.ruleId}:${document.id}`); }}
          >
            <span className="num">{ordinal(index)}</span>
            <span className="txt">{document.title}</span>
            <span className="box" aria-hidden="true" />
          </button>
        ))}
        <p className="small muted">{item.documentsNote}</p>
      </div>

      <div className="in d4">
        <h2 className="section"><span>{t("app.source")}</span></h2>
        <p className="law">{item.legal.act}<small>{`${item.legal.article} · ${t("app.checkedAt")}: ${dotted(item.legal.checkedAt)}`}</small></p>
        {item.consequence !== undefined && <p className="prose">{item.consequence}</p>}
      </div>

      {item.place !== undefined && (
        <div className="in d4">
          <p className="prose">{item.place.text}</p>
          <Button tone="outline" arrow="🗺" onClick={() => openLink(item.place!.mapUrl)}>{t("app.map")}</Button>
        </div>
      )}

      <Button className="in d5" tone="outline" arrow="↗" onClick={() => openLink(item.legal.url)}>{t("btn.law")}</Button>

      {item.status !== "done" && (
        <Button className="in d5" arrow="✓" loading={pending === `done:${item.ruleId}`} disabled={pending !== null}
          onClick={() => onAction(`done:${item.ruleId}`)}>
          {t("btn.done")}
        </Button>
      )}

      {item.status !== "done" && (
        <Button className="in d5" tone="outline" arrow="🗓" loading={pending === `visit:${item.ruleId}`} disabled={pending !== null}
          onClick={() => onAction(`visit:${item.ruleId}`)}>
          {t(item.visit === undefined ? "app.visitPlan" : "app.visitChange")}
        </Button>
      )}

      {item.status !== "done" && !(helpAsked && copy !== "") && (
        <Button className="in d6" tone="outline" arrow="?" loading={pending === `help:${item.ruleId}`} disabled={pending !== null}
          onClick={() => { setHelpAsked(true); onAction(`help:${item.ruleId}`); }}>
          {t(overdue ? "btn.overdueHelp" : "btn.cantComplete")}
        </Button>
      )}

      {helpAsked && copy !== "" && <Question key={copy} texts={texts} copy={copy} />}

      <button type="button" className="link in d6" onClick={() => openLink(session.university.contactUrl)}>
        {t("app.contact")}
      </button>
    </div>
  );
}
