/**
 * The plan: every procedure with its calculated deadline, and the switches around it.
 *
 * This is the screen that justifies a mini app rather than one more chat message — the whole list
 * with statuses is visible at once instead of scrolling a dialogue (`docs/product/mvp.md`, step 7).
 */

import { Button, CellHeader, CellList, CellSimple, Switch, Typography } from "@maxhub/max-ui";
import type { AppSession } from "../api.js";
import { text, type Texts } from "../texts.js";

interface Props {
  session: AppSession;
  texts: Texts;
  pending: string | null;
  onAction: (action: string) => void;
  onOpen: (ruleId: string) => void;
  onCalendar: () => void;
  calendarBusy: boolean;
}

export function Plan({ session, texts, pending, onAction, onOpen, onCalendar, calendarBusy }: Props) {
  const t = (key: string) => text(texts, key);
  const unfinished = session.plan.some(item => item.status !== "done");

  return (
    <div className="stack">
      <CellList mode="island" header={<CellHeader>{t("app.planTitle")}</CellHeader>}>
        {session.plan.length === 0 && <CellSimple title={t("app.plan.empty")} />}
        {session.plan.map(item => (
          <CellSimple
            key={item.ruleId}
            title={item.title}
            // The countdown comes from the server: plural forms live in the shared text data.
            subtitle={`${item.dueDate} · ${item.countdown}`}
            overline={item.provisional ? t("app.provisional") : undefined}
            showChevron
            disabled={pending !== null}
            onClick={() => onOpen(item.ruleId)}
          />
        ))}
      </CellList>

      <CellList mode="island">
        <CellSimple
          title={t("app.reminders")}
          after={<Switch
            checked={session.reminders}
            disabled={pending !== null}
            onChange={() => onAction("reminders")}
          />}
        />
      </CellList>

      {unfinished && (
        <Button stretched variant="secondary" loading={calendarBusy} disabled={pending !== null} onClick={onCalendar}>
          {t("app.calendar")}
        </Button>
      )}

      <Typography.Text variant="note" color="tertiary" className="prose">{t("app.selfReported")}</Typography.Text>

      <Button stretched variant="ghost" disabled={pending !== null} onClick={() => onAction("/delete")}>
        {t("btn.delete")}
      </Button>
    </div>
  );
}
