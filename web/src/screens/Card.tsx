/**
 * One procedure: what to do, the document checklist, the legal basis and the date it was checked.
 *
 * The source is shown next to the date on purpose. A deadline without its basis is exactly the
 * kind of confident-sounding answer this product is built to replace.
 */

import { Button, CellHeader, CellList, CellSimple, Typography } from "@maxhub/max-ui";
import type { AppPlanItem, AppSession } from "../api.js";
import { openLink, tap } from "../bridge.js";
import { text, type Lang } from "../texts.js";
import { statusLabel } from "./Plan.js";

interface Props {
  session: AppSession;
  item: AppPlanItem;
  pending: string | null;
  onAction: (action: string) => void;
}

export function Card({ session, item, pending, onAction }: Props) {
  const lang: Lang = session.lang;
  const t = (key: Parameters<typeof text>[1]) => text(lang, key);

  return (
    <div className="stack">
      <div>
        <Typography.Title variant="small">{item.title}</Typography.Title>
        <Typography.Text variant="body" color="secondary" className="prose">{item.action}</Typography.Text>
      </div>

      <CellList mode="island">
        <CellSimple title={item.dueDate} subtitle={statusLabel(lang, item)} />
        {item.recommendedDate !== undefined && (
          <CellSimple title={item.recommendedDate} subtitle={lang === "ru" ? "рекомендуемая дата" : "recommended date"} />
        )}
        {item.provisional && <CellSimple title={t("provisional")} subtitleMode="tertiary" />}
      </CellList>

      <CellList mode="island" header={<CellHeader>{t("documents")}</CellHeader>}>
        {item.documents.map(document => (
          <CellSimple
            key={document.id}
            title={document.title}
            before={<span aria-hidden="true">{document.checked ? "✓" : "□"}</span>}
            aria-pressed={document.checked}
            disabled={pending !== null}
            onClick={() => { tap(); onAction(`doc:${item.ruleId}:${document.id}`); }}
          />
        ))}
      </CellList>

      <CellList mode="island" header={<CellHeader>{t("source")}</CellHeader>}>
        <CellSimple title={item.legal.act} subtitle={item.legal.article} />
        <CellSimple title={`${t("checkedAt")}: ${item.legal.checkedAt}`} subtitleMode="tertiary" />
      </CellList>

      <Button stretched variant="secondary" onClick={() => openLink(item.legal.url)}>{t("openLaw")}</Button>

      {item.status !== "done" && (
        <Button
          stretched loading={pending === `done:${item.ruleId}`} disabled={pending !== null}
          onClick={() => onAction(`done:${item.ruleId}`)}
        >
          {t("markDone")}
        </Button>
      )}

      <Button stretched variant="ghost" onClick={() => openLink(session.university.contactUrl)}>
        {t("contactUniversity")}
      </Button>
    </div>
  );
}
