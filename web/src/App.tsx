/**
 * Shell of the mini app: appearance, banners, error bar and which screen the current step shows.
 *
 * Routing is derived from the session step the server reports, not from client-side history: the
 * chat and the app drive one session, so whatever the server says the step is, is the step.
 */

import { useCallback, useEffect, useState } from "react";
import { MaxUI } from "@maxhub/max-ui";
import { DateField } from "./DateField.js";
import { calendarTicket, ApiError, type ApiFailure } from "./api.js";
import { downloadFile, insideMax, onBack, platform, tap } from "./bridge.js";
import { universityPhoto } from "./photos.js";
import { Accented, Button } from "./ui.js";
import { useApp } from "./useApp.js";
import { isText, text, type Texts } from "./texts.js";
import { Onboarding } from "./screens/Onboarding.js";
import { Plan } from "./screens/Plan.js";
import { Card } from "./screens/Card.js";

/** MAX UI styles iOS and Android; a desktop or web client gets the Android look. */
const appearance = (): "ios" | "android" => (platform() === "ios" ? "ios" : "android");

/**
 * Before the first answer arrives there are no texts yet, so the loading screen and the
 * "open me from MAX" screen are the only two places with a literal string.
 */
const BOOT = "Загрузка…";
const BOOT_LAUNCH = "Приложение открывается из бота в MAX / Open this app from the bot in MAX";
const BOOT_FAILED = "Не удалось загрузить. Проверьте связь или откройте приложение из бота заново / "
  + "Could not load. Check the connection or reopen the app from the bot";

export function App() {
  const { status, dispatch, reload, dismiss } = useApp();
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [calendarError, setCalendarError] = useState<ApiFailure | "download" | null>(null);
  const session = status.state?.session ?? null;
  const texts: Texts = status.state?.texts ?? {};
  const t = (key: string) => text(texts, key);

  // The card is a nested screen, so the native back button has to leave it.
  const closeCard = useCallback(() => setOpenCard(null), []);
  useEffect(() => (openCard === null ? undefined : onBack(closeCard)), [openCard, closeCard]);
  // A step change on the server (a completed procedure, a deletion) invalidates an open card.
  // Adjusted during render, not in an effect: https://react.dev/learn/you-might-not-need-an-effect
  const [shownStep, setShownStep] = useState(session?.step);
  if (shownStep !== session?.step) {
    setShownStep(session?.step);
    if (session?.step !== "plan") setOpenCard(null);
  }

  const act = useCallback((action: string) => { tap(); void dispatch(action); }, [dispatch]);

  const exportCalendar = useCallback(async () => {
    setCalendarBusy(true);
    setCalendarError(null);
    try {
      const ticket = await calendarTicket();
      // Not awaited: the spinner is about the ticket; MAX may settle the download much later.
      downloadFile(new URL(ticket.url, document.baseURI).toString(), ticket.fileName).catch(() => setCalendarError("download"));
    } catch (e) {
      setCalendarError(e instanceof ApiError ? e.failure : "server");
    } finally {
      setCalendarBusy(false);
    }
  }, []);

  const body = () => {
    if (status.loading) {
      return (
        <div className="centre" role="status">
          <div className="loader" aria-hidden="true" />
          <p className="caps">{status.state === null ? BOOT : t("app.loading")}</p>
        </div>
      );
    }
    if (status.error === "no_launch") {
      return <Notice title="MAX" body={BOOT_LAUNCH} />;
    }
    if (status.state === null) {
      // Loading is over and nothing arrived: the first request failed.
      return <Notice
        title="MAX" body={BOOT_FAILED}
        action={{ label: "↻", onClick: () => void reload() }}
      />;
    }
    if (session === null) {
      // No session yet, or it was just deleted: the same "/start" the chat uses begins one, with
      // the university a QR poster chose when MAX passed one.
      const startParam = status.launch.startParam;
      const start = startParam !== undefined && /^[a-z0-9_-]{1,32}$/.test(startParam) ? `/start ${startParam}` : "/start";
      // The poster shows the university the QR code pointed at; without one, the default profile.
      const university = status.state.universities.find(u => u.id === startParam) ?? status.state.universities[0];
      const photo = university === undefined ? undefined : universityPhoto(university.id);
      return (
        <section className="hero">
          <div className="photo">{photo !== undefined && <img src={photo} alt="" />}</div>
          <div className="circle" />
          {university !== undefined && <div className="vert" aria-hidden="true">{university.name}</div>}
          <div className="content">
            <h1 className="display word in"><Accented text={t("app.title")} /></h1>
            <p className="caps uni in d1">{t("app.start.title")}</p>
            <div className="spacer" />
            <p className="lead prose in d2">{status.message === "" ? t("app.start.body") : isText(status.message, t("deleted")) ? t("app.deleted") : status.message}</p>
            <Button className="in d3" loading={status.pending !== null} onClick={() => act(start)}>{t("app.start.action")}</Button>
          </div>
        </section>
      );
    }
    if (session.step === "delete") {
      return (
        <div className="stack">
          <h1 className="heading in">{t("btn.delete")}</h1>
          <p className="prose in d1">{session.prompt}</p>
          <Button className="in d2" arrow="×" loading={status.pending === "confirm-delete"}
            disabled={status.pending !== null} onClick={() => act("confirm-delete")}>
            {t("btn.confirmDelete")}
          </Button>
          <button type="button" className="link in d3" disabled={status.pending !== null} onClick={() => act("cancel-delete")}>
            {t("btn.cancel")}
          </button>
        </div>
      );
    }
    if (session.stale) {
      // The chat has stopped this plan (rulesChanged): the app must not keep showing its dates.
      return (
        <div className="stack">
          <p className="prose in">{t("app.rulesChanged")}</p>
          <Button className="in d1" arrow="×" loading={status.pending === "/delete"} disabled={status.pending !== null}
            onClick={() => act("/delete")}>
            {t("btn.delete")}
          </Button>
        </div>
      );
    }
    if (session.universityGone) {
      // The profile was removed from the catalogue: no plan, and no other university's contacts in its place.
      return (
        <div className="stack">
          <h1 className="heading in">{t("app.scopeTitle")}</h1>
          <p className="prose in d1" role="status">{session.prompt}</p>
          <div className="tiles in d2">
            {status.state.universities.map(u => (
              <button key={u.id} type="button" className="tile tile-wide" disabled={status.pending !== null}
                onClick={() => act(`uni:${u.id}`)}>
                <span className="name">{u.name}</span>
              </button>
            ))}
          </div>
        </div>
      );
    }
    if (session.step === "visit" || session.step === "docEnd") {
      const [title, invalid] = session.step === "visit" ? ["app.visitTitle", "visit.invalid"] : ["app.endTitle", "docEnd.invalid"];
      return <DateStep texts={texts} today={status.state.today} prompt={session.prompt} message={status.message}
        title={title} invalid={invalid} pending={status.pending} onAction={act} />;
    }
    if (session.step === "completion") {
      return <Completion texts={texts} today={status.state.today} message={status.message}
        pending={status.pending} onAction={act} />;
    }
    if (session.step !== "plan") {
      return <Onboarding session={session} texts={texts} languages={status.state.languages}
        universities={status.state.universities} message={status.message} copy={status.copy} today={status.state.today} pending={status.pending} onAction={act} />;
    }
    const item = openCard === null ? undefined : session.plan.find(i => i.ruleId === openCard);
    if (item !== undefined) {
      return (
        <div className="stack">
          {!insideMax() && <button type="button" className="link back" onClick={closeCard}>{`← ${t("app.back")}`}</button>}
          <Card key={item.ruleId} session={session} texts={texts} item={item} pending={status.pending} copy={status.copy} onAction={act} />
        </div>
      );
    }
    return (
      <Plan session={session} texts={texts} pending={status.pending} onAction={act} onOpen={setOpenCard}
        onCalendar={() => void exportCalendar()} calendarBusy={calendarBusy} />
    );
  };

  const failure = (kind: ApiFailure | "download" | null) => {
    if (kind === "unauthorized") return t("app.error.expired");
    if (kind === "offline") return t("app.error.offline");
    if (kind === "conflict") return t("app.error.conflict");
    if (kind === "busy") return t("app.error.busy");
    if (kind === "download") return t("app.error.download");
    return t("app.error.server");
  };

  return (
    <MaxUI platform={appearance()} className="app">
      <main className="page">
        <div className="banners">
          {status.state?.demo === true && <Banner tone="demo">{t("banner.demo").trim()}</Banner>}
          {status.state?.mocked === true && <Banner tone="mocked">{t("app.banner.mocked")}</Banner>}
          {status.error !== null && status.error !== "no_launch" && status.state !== null && (
            <Banner tone="error" onDismiss={dismiss}>{failure(status.error)}</Banner>
          )}
          {calendarError !== null && <Banner tone="error" onDismiss={() => setCalendarError(null)}>{failure(calendarError)}</Banner>}
        </div>
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
      <span>{children}</span>
      {onDismiss !== undefined && <button type="button" className="banner-close" onClick={onDismiss} aria-label="×">×</button>}
    </div>
  );
}

function Notice({ title, body, action }: { title: string; body: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="stack">
      <h1 className="display title">{title}</h1>
      <p className="prose">{body}</p>
      {action !== undefined && <Button arrow="↻" onClick={action.onClick}>{action.label}</Button>}
    </div>
  );
}

/**
 * The chat's steps that ask for a day from today on — a visit (D-039) or a document end date (D-040).
 * The client shows why a day before today is refused; the server checks the full range and answers
 * with the card. The wording of the question is the chat's.
 */
function DateStep({ texts, today, prompt, message, title, invalid: invalidKey, pending, onAction }: {
  texts: Texts; today: string; prompt: string; message: string; title: string; invalid: string;
  pending: string | null; onAction: (action: string) => void;
}) {
  const [value, setValue] = useState("");
  const [nonexistent, setNonexistent] = useState(false);
  const [edited, setEdited] = useState(false);
  const t = (key: string) => text(texts, key);
  const outOfRange = value !== "" && value < today;
  const invalid = outOfRange || (!edited && isText(message, t(invalidKey)));
  return (
    <div className="stack">
      <h1 className="heading in">{t(title)}</h1>
      <p className={`prose in d1 ${nonexistent || invalid ? "banner banner-error" : ""}`} role={nonexistent || invalid ? "alert" : undefined}>
        {nonexistent ? t("app.entry.nodate") : invalid ? t(`app.${invalidKey}`) : prompt}
      </p>
      <div className="in d2">
        <DateField label={t(title)} hint={t("app.entry.hint")}
          onChange={(iso, display) => { setValue(iso); setEdited(true); setNonexistent(iso === "" && display.length === 10); }} />
      </div>
      <Button className="in d3" disabled={value === "" || value < today || pending !== null} loading={pending === value}
        onClick={() => { setEdited(false); onAction(value); }}>
        {t("app.save")}
      </Button>
      <button type="button" className="link in d5" disabled={pending !== null} onClick={() => onAction("plan")}>
        {t("btn.cancel")}
      </button>
    </div>
  );
}

function Completion({ texts, today, message, pending, onAction }: {
  texts: Texts; today: string; message: string; pending: string | null; onAction: (action: string) => void;
}) {
  const [value, setValue] = useState("");
  const [nonexistent, setNonexistent] = useState(false);
  const [edited, setEdited] = useState(false);
  const t = (key: string) => text(texts, key);
  const outOfRange = value !== "" && value > today;
  const invalid = outOfRange || (!edited && isText(message, t("completion.invalid")));
  return (
    <div className="stack">
      <h1 className="heading in">{t("app.completionTitle")}</h1>
      <p className={`prose in d1 ${nonexistent || invalid ? "banner banner-error" : ""}`} role={nonexistent || invalid ? "alert" : undefined}>
        {nonexistent ? t("app.entry.nodate") : invalid ? t("app.completion.invalid") : t("app.completion.body")}
      </p>
      <div className="in d2">
        <DateField label={t("app.completionTitle")} hint={t("app.entry.hint")}
          onChange={(iso, display) => { setValue(iso); setEdited(true); setNonexistent(iso === "" && display.length === 10); }} />
      </div>
      <Button className="in d3" disabled={value === "" || value > today || pending !== null} loading={pending === value}
        onClick={() => { setEdited(false); onAction(value); }}>
        {t("app.save")}
      </Button>
      <Button className="in d4" tone="outline" disabled={pending !== null} loading={pending === "/today"} onClick={() => onAction("/today")}>
        {t("app.today")}
      </Button>
      <button type="button" className="link in d5" disabled={pending !== null} onClick={() => onAction("plan")}>
        {t("btn.cancel")}
      </button>
    </div>
  );
}
