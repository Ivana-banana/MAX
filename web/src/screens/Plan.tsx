/**
 * The plan: every procedure with its calculated deadline, and the switches around it.
 *
 * This is the screen that justifies a mini app rather than one more chat message — the whole list
 * with statuses is visible at once instead of scrolling a dialogue (`docs/product/mvp.md`, step 7).
 */

import { Button, CellHeader, CellList, CellSimple, Switch, Typography } from "@maxhub/max-ui";
import type { AppPlanItem, AppSession } from "../api.js";
import { daysLeft, text, type Lang } from "../texts.js";

interface Props {
  session: AppSession;
  pending: string | null;
  onAction: (action: string) => void;
  onOpen: (ruleId: string) => void;
  onCalendar: () => void;
  calendarBusy: boolean;
}

export function statusLabel(lang: Lang, item: AppPlanItem): string {
  if (item.status === "done") return text(lang, "done");
  if (item.status === "overdue") return `${text(lang, "overdue")} · ${daysLeft(lang, item.daysLeft)}`;
  return daysLeft(lang, item.daysLeft);
}

export function Plan({ session, pending, onAction, onOpen, onCalendar, calendarBusy }: Props) {
  const lang: Lang = session.lang;
  const t = (key: Parameters<typeof text>[1]) => text(lang, key);
  const unfinished = session.plan.some(item => item.status !== "done");

  return (
    <div className="stack">
      <CellList mode="island" header={<CellHeader>{t("planTitle")}</CellHeader>}>
        {session.plan.length === 0 && <CellSimple title={t("planEmpty")} />}
        {session.plan.map(item => (
          <CellSimple
            key={item.ruleId}
            title={item.title}
            subtitle={`${item.dueDate} · ${statusLabel(lang, item)}`}
            overline={item.provisional ? t("provisional") : undefined}
            showChevron
            disabled={pending !== null}
            onClick={() => onOpen(item.ruleId)}
          />
        ))}
      </CellList>

      <CellList mode="island">
        <CellSimple
          title={t("reminders")}
          after={<Switch
            checked={session.reminders}
            disabled={pending !== null}
            onChange={() => onAction("reminders")}
          />}
        />
      </CellList>

      {unfinished && (
        <Button stretched variant="secondary" loading={calendarBusy} disabled={pending !== null} onClick={onCalendar}>
          {t("calendar")}
        </Button>
      )}

      <Typography.Text variant="note" color="tertiary" className="prose">{t("selfReported")}</Typography.Text>

      <Button stretched variant="ghost" disabled={pending !== null} onClick={() => onAction("/delete")}>
        {t("deleteTitle")}
      </Button>
    </div>
  );
}
