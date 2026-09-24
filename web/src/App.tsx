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
import { text, type Texts } from "./texts.js";
import { Onboarding } from "./screens/Onboarding.js";
import { Plan } from "./screens/Plan.js";
import { Card } from "./screens/Card.js";

/** MAX UI styles iOS and Android; a desktop or web client gets the Android look. */
const appearance = (): "ios" | "android" => (platform() === "ios" ? "ios" : "android");

/**
 * Before the first answer arrives there are no texts yet, so the loading screen and the
 * "open me from MAX" screen are the only two places with a literal string.
 */
const BOOT = { ru: "Загрузка…", en: "Loading…" };
const BOOT_LAUNCH = "Приложение открывается из бота в MAX / Open this app from the bot in MAX";

export function App() {
  const { status, dispatch, reload, dismiss } = useApp();
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [calendarError, setCalendarError] = useState(false);
  const session = status.state?.session ?? null;
  const texts: Texts = status.state?.texts ?? {};
  const t = (key: string) => text(texts, key);

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
          <Typography.Text variant="body" color="secondary">
            {status.state === null ? BOOT.ru : t("app.loading")}
          </Typography.Text>
        </div>
      );
    }
    if (status.error === "no_launch") {
      return <Notice title="MAX" body={BOOT_LAUNCH} />;
    }
    if (status.state === null) {
      return <Notice
        title="MAX" body={`${BOOT.ru} / ${BOOT.en}`}
        action={{ label: "↻", onClick: () => void reload() }}
      />;
    }
    if (session === null) {
      // No session yet, or it was just deleted: the same "/start" the chat uses begins one, with
      // the university a QR poster chose when MAX passed one.
      const startParam = status.launch.startParam;
      const start = startParam !== undefined && /^[a-z0-9_-]{1,32}$/.test(startParam) ? `/start ${startParam}` : "/start";
      return (
        <div className="stack">
          <Typography.Title variant="small">{t("app.start.title")}</Typography.Title>
          <Typography.Text variant="body" color="secondary" className="prose">
            {status.message === "" ? t("app.start.body") : status.message}
          </Typography.Text>
          <Button stretched loading={status.pending !== null} onClick={() => act(start)}>{t("app.start.action")}</Button>
        </div>
      );
    }
    if (session.step === "delete") {
      return (
        <div className="stack">
          <Typography.Title variant="small">{t("btn.delete")}</Typography.Title>
          <Typography.Text variant="body" color="secondary" className="prose">{status.message}</Typography.Text>
          <Button stretched variant="destructive" loading={status.pending === "confirm-delete"}
            disabled={status.pending !== null} onClick={() => act("confirm-delete")}>
            {t("btn.confirmDelete")}
          </Button>
          <Button stretched variant="ghost" disabled={status.pending !== null} onClick={() => act("cancel-delete")}>
            {t("btn.cancel")}
          </Button>
        </div>
      );
    }
    if (session.step === "completion") {
      return <Completion texts={texts} today={status.state.today} message={status.message}
        pending={status.pending} onAction={act} />;
    }
    if (session.step !== "plan") {
      return <Onboarding session={session} texts={texts} languages={status.state.languages}
        message={status.message} today={status.state.today} pending={status.pending} onAction={act} />;
    }
    const item = openCard === null ? undefined : session.plan.find(i => i.ruleId === openCard);
    if (item !== undefined) {
      return (
        <div className="stack">
          {!insideMax() && <Button variant="ghost" onClick={closeCard}>{`← ${t("app.back")}`}</Button>}
          <Card session={session} texts={texts} item={item} pending={status.pending} onAction={act} />
        </div>
      );
    }
    return (
      <Plan session={session} texts={texts} pending={status.pending} onAction={act} onOpen={setOpenCard}
        onCalendar={() => void exportCalendar()} calendarBusy={calendarBusy} />
    );
  };

  const failure = () => {
    if (status.error === "unauthorized") return t("app.error.expired");
    if (status.error === "offline") return t("app.error.offline");
    if (status.error === "conflict") return t("app.error.conflict");
    return t("app.error.server");
  };

  return (
    <MaxUI platform={appearance()}>
      <main className="page">
        {status.state?.demo === true && <Banner tone="demo">{t("banner.demo").trim()}</Banner>}
        {status.state?.mocked === true && <Banner tone="mocked">{t("app.banner.mocked")}</Banner>}
        {status.error !== null && status.error !== "no_launch" && status.state !== null && (
          <Banner tone="error" onDismiss={dismiss}>{failure()}</Banner>
        )}
        {calendarError && <Banner tone="error" onDismiss={() => setCalendarError(false)}>{t("app.error.server")}</Banner>}
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

function Completion({ texts, today, message, pending, onAction }: {
  texts: Texts; today: string; message: string; pending: string | null; onAction: (action: string) => void;
}) {
  const [value, setValue] = useState("");
  const t = (key: string) => text(texts, key);
  return (
    <div className="stack">
      <Typography.Title variant="small">{t("app.completionTitle")}</Typography.Title>
      <Typography.Text variant="body" color="secondary" className="prose">{message}</Typography.Text>
      <Input type="date" value={value} max={today} aria-label={t("app.completionTitle")}
        onChange={event => setValue(event.target.value)} />
      <Button stretched disabled={value === "" || pending !== null} loading={pending === value}
        onClick={() => onAction(value)}>
        {t("app.save")}
      </Button>
      <Button stretched variant="secondary" disabled={pending !== null} onClick={() => onAction("/today")}>
        {t("app.today")}
      </Button>
      <CellList mode="island">
        <CellSimple title={t("btn.cancel")} disabled={pending !== null} onClick={() => onAction("plan")} />
      </CellList>
    </div>
  );
}
