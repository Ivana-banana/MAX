/**
 * The plan: every procedure with its calculated deadline, and the switches around it.
 *
 * This is the screen that justifies a mini app rather than one more chat message — the whole list
 * with statuses is visible at once instead of scrolling a dialogue (`docs/product/mvp.md`, step 7).
 * A close or missed deadline is a solid red block; a calm one is an outline. Once everything is
 * marked, the plan opens with the finale poster.
 */

import type { AppPlanItem, AppSession } from "../api.js";
import { universityPhoto } from "../photos.js";
import { text, type Texts } from "../texts.js";
import { Button, Switch, dotted } from "../ui.js";

interface Props {
  session: AppSession;
  texts: Texts;
  today: string;
  pending: string | null;
  onAction: (action: string) => void;
  onOpen: (ruleId: string) => void;
  onCalendar: () => void;
  calendarBusy: boolean;
}

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

/** Five segments of the window between entry and the deadline that are still ahead. */
function remaining(item: AppPlanItem, entryDate: string | undefined, today: string): number {
  if (entryDate === undefined || item.status === "done") return 0;
  const total = days(entryDate, item.dueDate);
  if (total <= 0) return 0;
  return Math.max(0, Math.min(5, Math.ceil((days(today, item.dueDate) / total) * 5)));
}

export function Plan({ session, texts, today, pending, onAction, onOpen, onCalendar, calendarBusy }: Props) {
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
          <div className="stamp prose" aria-hidden="true">{t("app.done.stamp")}</div>
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
      {session.plan.map((item, index) => {
        const tone = item.status === "done" ? "done" : item.status === "overdue" ? "overdue" : item.status === "dueSoon" ? "hot" : "calm";
        const tag = item.status === "ok" ? undefined : t(`app.tag.${item.status}`);
        const left = remaining(item, session.entryDate, today);
        return (
          <button key={item.ruleId} type="button" className={`task task-${tone} in d${Math.min(index + 1, 6)}`}
            disabled={pending !== null} onClick={() => onOpen(item.ruleId)}>
            <span className={`n ${Math.abs(item.daysLeft) > 99 && item.status !== "done" ? "n-long" : ""}`} aria-hidden="true">
              {item.status === "done" ? "✓" : String(Math.abs(item.daysLeft)).padStart(2, "0")}
            </span>
            <span>
              <span className="t">{item.title}</span>
              <span className="d">{`${t("app.deadline")} ${dotted(item.dueDate)}`}</span>
              {/* The countdown comes from the server: plural forms live in the shared text data. */}
              <span className="c">{item.countdown}</span>
              {item.status !== "done" && (
                <span className="meter" aria-hidden="true">
                  {[0, 1, 2, 3, 4].map(i => <i key={i} className={i < left ? "on" : ""} />)}
                </span>
              )}
              {item.provisional && item.status !== "done" && <span className="p">{t("app.provisional")}</span>}
            </span>
            {tag !== undefined && <span className="tag">{tag}</span>}
          </button>
        );
      })}

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
