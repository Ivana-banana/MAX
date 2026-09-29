/**
 * The plan: every procedure with its calculated deadline, and the switches around it.
 *
 * This is the screen that justifies a mini app rather than one more chat message — the whole list
 * with statuses is visible at once instead of scrolling a dialogue (`docs/product/mvp.md`, step 7).
 * A close or missed deadline is a solid red block; a calm one is an outline. Once everything is
 * marked, the plan opens with the finale poster.
 */

import type { AppPlanItem, AppSession } from "../api.js";
import { openLink, tap } from "../bridge.js";
import { universityPhoto } from "../photos.js";
import { text, type Texts } from "../texts.js";
import { Button, Switch, dotted } from "../ui.js";

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
 * One procedure: the number of days, its name and one line under it. The date is enough when a
 * deadline is ahead; a missed or marked one needs the chat's words, since a bare number would not
 * say which way it counts. The whole countdown is read out to screen readers either way.
 */
function Task({ item, index, deadline, disabled, onOpen }: {
  item: AppPlanItem; index: number; deadline: string; disabled: boolean; onOpen: (ruleId: string) => void;
}) {
  const tone = item.status === "done" ? "done" : item.status === "ok" ? "calm" : "hot";
  const days = String(Math.abs(item.daysLeft)).padStart(2, "0");
  return (
    <button type="button" className={`task task-${tone} in d${Math.min(index + 1, 6)}`} disabled={disabled}
      aria-label={`${item.title}. ${item.countdown}`} onClick={() => onOpen(item.ruleId)}>
      <span className={`n ${days.length > 2 && item.status !== "done" ? "n-long" : ""}`} aria-hidden="true">
        {item.status === "done" ? "✓" : days}
      </span>
      <span aria-hidden="true">
        <span className="t">{item.title}</span>
        {/* The countdown comes from the server: plural forms live in the shared text data. */}
        <span className="d">{item.status === "ok" || item.status === "dueSoon" ? `${deadline}: ${dotted(item.dueDate)}` : item.countdown}</span>
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
              <summary className="t">{item.title}</summary>
              <p className="prose">{item.action}</p>
              <p className="prose small">{item.when}</p>
              {item.documents.map(document => (
                <button key={document.id} type="button" role="checkbox" aria-checked={document.checked} className="doc"
                  disabled={pending !== null} onClick={() => { tap(); onAction(`doc:${item.id}:${document.id}`); }}>
                  <span className="txt">{document.title}</span>
                  <span className="box" aria-hidden="true" />
                </button>
              ))}
              <p className="small muted">{item.sourceNote}</p>
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

      <p className="small muted prose in d6">{t("app.selfReported")}</p>

      <button type="button" className="link" disabled={pending !== null} onClick={() => onAction("/delete")}>
        {t("btn.delete")}
      </button>
    </div>
  );
}
