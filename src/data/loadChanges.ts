/**
 * Loads the changes of circumstances (src/data/rules/ru-change.json, #41, D-061): the situations, their
 * federal terms in working days and the norm in words. A malformed file fails at load time (as in loadRules).
 */

import { readFileSync } from "node:fs";
import type { ChangeSet, ChangeSituation } from "../core/types.js";
import { asDate, asId, asLegalBasis, asLocalized, asRecord, asString, RuleValidationError } from "./loadRules.js";

function asUrl(value: unknown, path: string): string {
  const url = asString(value, path);
  if (!url.startsWith("https://")) throw new RuleValidationError(path, "нужна ссылка https://");
  return url;
}

function asSituation(value: unknown, path: string): ChangeSituation {
  const record = asRecord(value, path);
  const workdays = record.workdays;
  if (workdays !== undefined && (typeof workdays !== "number" || !Number.isInteger(workdays) || workdays < 1 || workdays > 30)) {
    throw new RuleValidationError(`${path}.workdays`, "ожидается целое число рабочих дней от 1 до 30");
  }
  // A counted term needs the question for its date; a term without a number needs none.
  if ((workdays === undefined) !== (record.event === undefined)) throw new RuleValidationError(`${path}.event`, "event задаётся вместе с workdays");
  if (record.receiver !== "university" && record.receiver !== "place") throw new RuleValidationError(`${path}.receiver`, "ожидается university или place");
  const legal = asLegalBasis(record.legal, `${path}.legal`);
  asUrl(legal.url, `${path}.legal.url`);
  return {
    id: asId(record.id, `${path}.id`),
    title: asLocalized(record.title, `${path}.title`),
    ...(record.event === undefined ? {} : { event: asLocalized(record.event, `${path}.event`) }),
    norm: asLocalized(record.norm, `${path}.norm`),
    ...(workdays === undefined ? {} : { workdays }),
    receiver: record.receiver,
    ...(record.assumption === undefined ? {} : { assumption: asLocalized(record.assumption, `${path}.assumption`) }),
    legal,
  };
}

export function parseChangeSet(raw: unknown): ChangeSet {
  const record = asRecord(raw, "$");
  if (!Array.isArray(record.situations) || record.situations.length === 0) throw new RuleValidationError("$.situations", "ожидается непустой массив");
  const situations = record.situations.map((s, i) => asSituation(s, `$.situations[${i}]`));
  const twice = situations.map(s => s.id).find((id, i, all) => all.indexOf(id) !== i);
  if (twice !== undefined) throw new RuleValidationError("$.situations", `повторяющийся id «${twice}»`);
  const filing = asRecord(record.filing, "$.filing");
  return { situations, filing: { act: asString(filing.act, "$.filing.act"), article: asLocalized(filing.article, "$.filing.article"),
    url: asUrl(filing.url, "$.filing.url"), checkedAt: asDate(filing.checkedAt, "$.filing.checkedAt") } };
}

export function readChangeSet(path: string): ChangeSet {
  return parseChangeSet(JSON.parse(readFileSync(path, "utf8")));
}
