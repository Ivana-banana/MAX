/**
 * Shell of the mini app: appearance, banners, error bar and which screen the current step shows.
 *
 * Routing is derived from the session step the server reports, not from client-side history: the
 * chat and the app drive one session, so whatever the server says the step is, is the step.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, CellList, CellSimple, Input, MaxUI, Spinner, Typography } from "@maxhub/max-ui";
import { calendarTicket, ApiError } from "./api.js";
import { downloadFile, insideMax, onBack, platform, tap } from "./bridge.js";
import { useApp } from "./useApp.js";
import { text, type Lang } from "./texts.js";
import { Onboarding } from "./screens/Onboarding.js";
import { Plan } from "./screens/Plan.js";
import { Card } from "./screens/Card.js";

/** MAX UI styles iOS and Android; a desktop or web client gets the Android look. */
const appearance = (): "ios" | "android" => (platform() === "ios" ? "ios" : "android");

export function App() {
  const { status, dispatch, reload, dismiss } = useApp();
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [calendarError, setCalendarError] = useState(false);
  const session = status.state?.session ?? null;
  const lang: Lang = session?.lang ?? "ru";
  const t = (key: Parameters<typeof text>[1]) => text(lang, key);

  // The card is a nested screen, so the native back button has to leave it.
  const closeCard = useCallback(() => setOpenCard(null), []);
  useEffect(() => (openCard === null ? undefined : onBack(closeCard)), [openCard, closeCard]);
  // A step change on the server (a completed procedure, a deletion) invalidates an open card.
  useEffect(() => { if (session?.step !== "plan") setOpenCard(null); }, [session?.step]);

  const act = useCallback((action: string) => { tap(); void dispatch(action); }, [dispatch]);

  const exportCalendar = useCallback(async () => {
    setCalendarBusy(true);
    setCalendarError(false);
    try {
      const ticket = await calendarTicket();
      downloadFile(new URL(ticket.url, document.baseURI).toString(), ticket.fileName);
    } catch (e) {
      setCalendarError(e instanceof ApiError);
    } finally {
      setCalendarBusy(false);
    }
  }, []);

  const body = () => {
    if (status.loading) {
      return (
        <div className="centre">
          <Spinner />
          <Typography.Text variant="body" color="secondary">{t("loading")}</Typography.Text>
        </div>
      );
    }
    if (status.error === "no_launch") {
      return <Notice title={t("appTitle")} body={t("errorNoLaunch")} />;
    }
    if (status.state === null) {
      return <Notice title={t("appTitle")} body={t("errorServer")} action={{ label: t("retry"), onClick: () => void reload() }} />;
    }
    if (session === null) {
      // No session yet, or it was just deleted: the same "/start" the chat uses begins one, with
      // the university a QR poster chose when MAX passed one.
      const startParam = status.launch.startParam;
      const start = startParam !== undefined && /^[a-z0-9_-]{1,32}$/.test(startParam) ? `/start ${startParam}` : "/start";
      return (
        <div className="stack">
          <Typography.Title variant="small">{t("startTitle")}</Typography.Title>
          <Typography.Text variant="body" color="secondary" className="prose">
            {status.message === "" ? t("startBody") : status.message}
          </Typography.Text>
          <Button stretched loading={status.pending !== null} onClick={() => act(start)}>{t("start")}</Button>
        </div>
      );
    }
    if (session.step === "delete") {
      return (
        <div className="stack">
          <Typography.Title variant="small">{t("deleteTitle")}</Typography.Title>
          <Typography.Text variant="body" color="secondary" className="prose">{status.message}</Typography.Text>
          <Button stretched variant="destructive" loading={status.pending === "confirm-delete"}
            disabled={status.pending !== null} onClick={() => act("confirm-delete")}>
            {t("deleteConfirm")}
          </Button>
          <Button stretched variant="ghost" disabled={status.pending !== null} onClick={() => act("cancel-delete")}>
            {t("cancel")}
          </Button>
        </div>
      );
    }
    if (session.step === "completion") {
      return <Completion lang={lang} today={status.state.today} message={status.message}
        pending={status.pending} onAction={act} />;
    }
    if (session.step !== "plan") {
      return <Onboarding session={session} message={status.message} today={status.state.today}
        pending={status.pending} onAction={act} />;
    }
    const item = openCard === null ? undefined : session.plan.find(i => i.ruleId === openCard);
    if (item !== undefined) {
      return (
        <div className="stack">
          {!insideMax() && (
            <Button variant="ghost" onClick={closeCard}>{`← ${t("back")}`}</Button>
          )}
          <Card session={session} item={item} pending={status.pending} onAction={act} />
        </div>
      );
    }
    return (
      <Plan session={session} pending={status.pending} onAction={act} onOpen={setOpenCard}
        onCalendar={() => void exportCalendar()} calendarBusy={calendarBusy} />
    );
  };

  return (
    <MaxUI platform={appearance()}>
      <main className="page">
        {status.state?.demo === true && <Banner tone="demo">{t("demoBanner")}</Banner>}
        {status.state?.mocked === true && <Banner tone="mocked">{t("mockedBanner")}</Banner>}
        {status.error !== null && status.error !== "no_launch" && (
          <Banner tone="error" onDismiss={dismiss}>
            {status.error === "unauthorized" ? t("errorUnauthorized")
              : status.error === "offline" ? t("errorOffline")
                : status.error === "conflict" ? t("errorConflict") : t("errorServer")}
          </Banner>
        )}
        {calendarError && <Banner tone="error" onDismiss={() => setCalendarError(false)}>{t("errorServer")}</Banner>}
        {body()}
      </main>
    </MaxUI>
  );
}

function Banner({ tone, children, onDismiss }: {
  tone: "demo" | "mocked" | "error"; children: string; onDismiss?: () => void;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === "error" ? "alert" : "note"}>
      <Typography.Text variant="note">{children}</Typography.Text>
      {onDismiss !== undefined && <button type="button" className="banner-close" onClick={onDismiss} aria-label="×">×</button>}
    </div>
  );
}

function Notice({ title, body, action }: { title: string; body: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="stack">
      <Typography.Title variant="small">{title}</Typography.Title>
      <Typography.Text variant="body" color="secondary" className="prose">{body}</Typography.Text>
      {action !== undefined && <Button stretched onClick={action.onClick}>{action.label}</Button>}
    </div>
  );
}

function Completion({ lang, today, message, pending, onAction }: {
  lang: Lang; today: string; message: string; pending: string | null; onAction: (action: string) => void;
}) {
  const [value, setValue] = useState("");
  const t = (key: Parameters<typeof text>[1]) => text(lang, key);
  return (
    <div className="stack">
      <Typography.Title variant="small">{t("completionTitle")}</Typography.Title>
      <Typography.Text variant="body" color="secondary" className="prose">{message}</Typography.Text>
      <Input type="date" value={value} max={today} aria-label={t("completionTitle")}
        onChange={event => setValue(event.target.value)} />
      <Button stretched disabled={value === "" || pending !== null} loading={pending === value}
        onClick={() => onAction(value)}>
        {t("save")}
      </Button>
      <Button stretched variant="secondary" disabled={pending !== null} onClick={() => onAction("/today")}>
        {t("completionToday")}
      </Button>
      <CellList mode="island">
        <CellSimple title={t("cancel")} disabled={pending !== null} onClick={() => onAction("plan")} />
      </CellList>
    </div>
  );
}
