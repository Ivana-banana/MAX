/**
 * One procedure: what to do, the document checklist, the legal basis and the date it was checked.
 *
 * The source is shown next to the date on purpose. A deadline without its basis is exactly the
 * kind of confident-sounding answer this product is built to replace.
 */

import type { AppPlanItem, AppSession } from "../api.js";
import { openLink, tap } from "../bridge.js";
import { text, type Texts } from "../texts.js";
import { Button, dayMonth, dotted, ordinal } from "../ui.js";

interface Props {
  session: AppSession;
  texts: Texts;
  item: AppPlanItem;
  pending: string | null;
  onAction: (action: string) => void;
}

export function Card({ session, texts, item, pending, onAction }: Props) {
  const t = (key: string) => text(texts, key);
  const checked = item.documents.filter(document => document.checked).length;
  const calm = item.status === "ok" || item.status === "done";

  return (
    <div className="stack">
      <h1 className="heading in">{item.title}</h1>

      <div className={`deadline ${calm ? "deadline-calm" : ""} in d1`}>
        <span className="big">{dayMonth(item.dueDate)}</span>
        <span className="label">{item.countdown}</span>
      </div>

      <div className="facts in d1">
        {item.recommendedDate !== undefined && <span>{`${t("app.recommended")}: ${dotted(item.recommendedDate)}`}</span>}
        {item.provisional && <span>{t("app.provisional")}</span>}
      </div>

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
      </div>

      <div className="in d4">
        <h2 className="section"><span>{t("app.source")}</span></h2>
        <p className="law">{item.legal.act}<small>{`${item.legal.article} · ${t("app.checkedAt")}: ${dotted(item.legal.checkedAt)}`}</small></p>
      </div>

      <Button className="in d5" tone="outline" arrow="↗" onClick={() => openLink(item.legal.url)}>{t("btn.law")}</Button>

      {item.status !== "done" && (
        <Button className="in d5" arrow="✓" loading={pending === `done:${item.ruleId}`} disabled={pending !== null}
          onClick={() => onAction(`done:${item.ruleId}`)}>
          {t("btn.done")}
        </Button>
      )}

      <button type="button" className="link in d6" onClick={() => openLink(session.university.contactUrl)}>
        {t("app.contact")}
      </button>
    </div>
  );
}
