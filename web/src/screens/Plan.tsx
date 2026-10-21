/**
 * The plan: every procedure with its calculated deadline, and the switches around it.
 *
 * This is the screen that justifies a mini app rather than one more chat message — the whole list
 * with statuses is visible at once instead of scrolling a dialogue (`docs/product/mvp.md`, step 7).
 * A close or missed deadline is a solid red block; a calm one is an outline. Once everything is
 * marked, the plan opens with the finale poster.
 */

import type { AppPlanItem, AppSession } from "../api.js";
import { useState } from "react";
import { openLink, shareInMax, tap } from "../bridge.js";
import { universityPhoto } from "../photos.js";
import { text, type Texts } from "../texts.js";
import { Button, Switch, dotted, ordinal } from "../ui.js";
import { copyText } from "./Card.js";

interface Props {
  session: AppSession;
  texts: Texts;
  pending: string | null;
  onAction: (action: string) => void;
  onOpen: (ruleId: string) => void;
  onCalendar: () => void;
  calendarBusy: boolean;
}

/**
 * One procedure: the number of days, its name and one line under it. The line always carries the
 * chat's words ("68 days left", "17 days ago"), since a bare number would not say which way it counts. The whole countdown is read out to screen readers either way.
 */
function Task({ item, index, deadline, disabled, onOpen }: {
  item: AppPlanItem; index: number; deadline: string; disabled: boolean; onOpen: (ruleId: string) => void;
}) {
  const tone = item.status === "done" ? "done" : item.status === "ok" ? "calm" : "hot";
  const days = String(Math.abs(item.daysLeft)).padStart(2, "0");
  return (
    <button type="button" className={`task task-${tone} in d${Math.min(index + 1, 6)}`} disabled={disabled}
      aria-label={`${item.title}. ${item.repeat === undefined ? "" : `${item.repeat.label}, ${item.repeat.doneOn}. `}${item.countdown}`} onClick={() => onOpen(item.ruleId)}>
      <span className={`n ${days.length > 2 && item.status !== "done" ? "n-long" : ""}`} aria-hidden="true">
        {item.status === "done" ? "✓" : days}
      </span>
      <span aria-hidden="true">
        <span className="t">{item.title}</span>
        {item.repeat !== undefined && <span className="d">{`${item.repeat.label} · ${item.repeat.doneOn}`}</span>}
        {/* The countdown comes from the server: plural forms live in the shared text data. */}
        <span className="d">{item.status === "ok" || item.status === "dueSoon" ? `${deadline}: ${dotted(item.dueDate)} · ${item.countdown}` : item.countdown}</span>
      </span>
    </button>
  );
}

export function Plan({ session, texts, pending, onAction, onOpen, onCalendar, calendarBusy }: Props) {
  const t = (key: string) => text(texts, key);
  const unfinished = session.plan.some(item => item.status !== "done");
  // A marked first-round procedure is replaced by its repeat a year later, so "everything done"
  // means every first-round procedure is marked; repeats stay listed below the finale.
  const firstRound = session.plan.filter(item => !item.isRepeat);
  const finished = session.plan.length > 0 && firstRound.every(item => item.status === "done");
  const photo = universityPhoto(session.university.id);
  // Outside MAX the plan text goes to the clipboard; null until the first press.
  const [copied, setCopied] = useState<boolean | null>(null);
  const share = async () => {
    // The bridge's promise settles when the chat picker closes, whether or not a chat was chosen
    // (the docs give no result to tell them apart), so no "success" here — MAX shows its own outcome.
    if (await shareInMax(session.share).catch(() => false)) return;
    const ok = await copyText(session.share);
    setCopied(ok); tap(ok ? "success" : "warning");
  };

  return (
    <div className="stack">
      {finished && (
        <div className="finale">
          <div className="photo">{photo !== undefined && <img src={photo} alt="" />}</div>
          <h1 className="display in d1">{t("app.done.title")}</h1>
          <p className="in d2 finale-body">{t("app.done.body")}</p>
        </div>
      )}

      {!finished && (
        <div className="plan-head in">
          <h1 className="display">{t("app.planTitle")}</h1>
          <span className="vertical">{session.university.name}{session.entryDate !== undefined && ` · ${dotted(session.entryDate).slice(0, 5)}`}</span>
        </div>
      )}

      {session.plan.length === 0 && <p className="prose">{t("app.plan.empty")}</p>}
      {session.plan.map((item, index) => (
        <Task key={item.ruleId} item={item} index={index} deadline={t("app.deadline")} disabled={pending !== null} onOpen={onOpen} />
      ))}
      {/* Said once for the whole list rather than on every card. */}
      {session.plan.some(item => item.provisional && item.status !== "done") && (
        <p className="small muted prose">{t("app.provisional")}</p>
      )}

      {/* The university's own procedures: no countdown, since the deadline counts from the move-in date. */}
      {session.undated.length > 0 && (
        <div className="in d4">
          <h2 className="section"><span>{t("app.undated")}</span></h2>
          {session.undated.map(item => (
            <details key={item.id} className="undated">
              <summary className="t">{item.title}{item.due !== undefined && ` — ${dotted(item.due)}`}</summary>
              <p className="prose">{item.action}</p>
              <p className="prose small">{item.when}</p>
              {item.dueText !== undefined && <p className="prose">{item.dueText}</p>}
              {item.endLabel !== undefined && (
                <Button tone="outline" arrow="📅" loading={pending === `end:${item.id}`} disabled={pending !== null}
                  onClick={() => onAction(`end:${item.id}`)}>
                  {item.endLabel}
                </Button>
              )}
              {item.documents.map((document, index) => (
                <button key={document.id} type="button" role="checkbox" aria-checked={document.checked} className="doc"
                  disabled={pending !== null} onClick={() => { tap(); onAction(`doc:${item.id}:${document.id}`); }}>
                  <span className="num">{ordinal(index)}</span>
                  <span className="txt">{document.title}</span>
                  <span className="box" aria-hidden="true" />
                </button>
              ))}
              <p className="small muted">{item.sourceNote}</p>
              {item.mapUrl !== undefined && (
                <button type="button" className="link" onClick={() => openLink(item.mapUrl!)}>{t("app.map")}</button>
              )}
              <button type="button" className="link" onClick={() => openLink(item.sourceUrl)}>{item.sourceLabel}</button>
            </details>
          ))}
        </div>
      )}

      <div className="toggle in d4">
        <span>{t("app.reminders")}</span>
        <Switch checked={session.reminders} label={t("app.reminders")} disabled={pending !== null}
          onChange={() => onAction("reminders")} />
      </div>

      {unfinished && (
        <Button className="in d5" tone="ink" arrow="＋" loading={calendarBusy} disabled={pending !== null} onClick={onCalendar}>
          {t("app.calendar")}
        </Button>
      )}

      {session.share !== "" && (
        <Button className="in d5" tone="outline" arrow={copied ? "✓" : "↗"} disabled={pending !== null} onClick={() => void share()}>
          {copied ? t("app.copied") : t("app.share")}
        </Button>
      )}
      {copied === false && <pre className="small prose share-text">{session.share}</pre>}

      <p className="small muted prose in d6">{t("app.selfReported")}</p>

      <button type="button" className="link" disabled={pending !== null} onClick={() => onAction("/delete")}>
        {t("btn.delete")}
      </button>
    </div>
  );
}
