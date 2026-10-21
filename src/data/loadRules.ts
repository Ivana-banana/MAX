/**
 * Loads and validates rule files.
 *
 * Rules are data, so they are the thing most likely to be edited by someone who is
 * not looking at the code — a lawyer, or a colleague adding a region. A malformed
 * rule must fail loudly at load time rather than quietly produce a wrong date.
 */

import { isValidDate } from "../core/dates.js";
import type {
  Condition,
  Consequence,
  DeadlineRule,
  LegalBasis,
  Localized,
  DocumentsSource,
  RequiredDocument,
} from "../core/types.js";

export class RuleValidationError extends Error {
  constructor(path: string, problem: string) {
    super(`Правило невалидно (${path}): ${problem}`);
    this.name = "RuleValidationError";
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuleValidationError(path, "ожидается объект");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RuleValidationError(path, "ожидается непустая строка");
  }
  return value;
}

/** Ids travel in button payloads split on ":" and in the mini app's action grammar (src/webapp/state.ts). */
function asId(value: unknown, path: string): string {
  const id = asString(value, path);
  if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new RuleValidationError(path, `ожидается id из a-z, 0-9 и «-», получено «${id}»`);
  return id;
}

function asDate(value: unknown, path: string): string {
  const raw = asString(value, path);
  if (!isValidDate(raw)) {
    throw new RuleValidationError(path, `ожидается дата ГГГГ-ММ-ДД, получено «${raw}»`);
  }
  return raw;
}

function asLocalized(value: unknown, path: string): Localized {
  const record = asRecord(value, path);
  // Russian is the base language; the rest are checked against the interface languages at startup.
  asString(record.ru, `${path}.ru`);
  return Object.fromEntries(Object.entries(record).filter(([lang]) => /^[a-z]{2}$/.test(lang))
    .map(([lang, text]) => [lang, asString(text, `${path}.${lang}`)]));
}

function asCondition(value: unknown, path: string): Condition {
  const record = asRecord(value, path);
  const field = asString(record.field, `${path}.field`);
  const op = asString(record.op, `${path}.op`);

  if (field === "citizenship") {
    if (op !== "in" && op !== "notIn") {
      throw new RuleValidationError(`${path}.op`, "для citizenship допустимы in и notIn");
    }
    if (!Array.isArray(record.values) || record.values.length === 0) {
      throw new RuleValidationError(`${path}.values`, "ожидается непустой массив");
    }
    // Profiles and universities use upper-case ISO codes; "by" would silently match nobody.
    const values = record.values.map((v, i) => {
      const code = asString(v, `${path}.values[${i}]`);
      if (!/^[A-Z]{2}$/.test(code)) throw new RuleValidationError(`${path}.values[${i}]`, `ожидается код ISO 3166-1 (KZ), получено «${code}»`);
      return code;
    });
    return { field, op, values };
  }

  if (field === "purpose") {
    if (op !== "eq") throw new RuleValidationError(`${path}.op`, "для purpose допустим только eq");
    const value = asString(record.value, `${path}.value`);
    if (value !== "study" && value !== "work" && value !== "other") {
      throw new RuleValidationError(`${path}.value`, "ожидается study, work или other");
    }
    return { field, op, value };
  }

  if (field === "entryDate") {
    if (op !== "onOrAfter" && op !== "before") {
      throw new RuleValidationError(`${path}.op`, "для entryDate допустимы onOrAfter и before");
    }
    return { field, op, value: asDate(record.value, `${path}.value`) };
  }

  throw new RuleValidationError(`${path}.field`, `неизвестное поле условия «${field}»`);
}

function asLegalBasis(value: unknown, path: string): LegalBasis {
  const record = asRecord(value, path);
  const status = asString(record.status, `${path}.status`);
  if (status !== "draft" && status !== "approved") {
    throw new RuleValidationError(`${path}.status`, "ожидается draft или approved");
  }

  const reviewedBy = record.reviewedBy === undefined ? undefined : asString(record.reviewedBy, `${path}.reviewedBy`);

  // An approved norm without a named reviewer is the failure mode this product is
  // built to prevent: an unverified term presented as fact.
  if (status === "approved" && reviewedBy === undefined) {
    throw new RuleValidationError(`${path}.reviewedBy`, "у approved обязателен reviewedBy");
  }

  return {
    act: asString(record.act, `${path}.act`),
    article: asLocalized(record.article, `${path}.article`),
    url: asString(record.url, `${path}.url`),
    edition: asString(record.edition, `${path}.edition`),
    checkedAt: asDate(record.checkedAt, `${path}.checkedAt`),
    status,
    ...(reviewedBy === undefined ? {} : { reviewedBy }),
  };
}

function asDocument(value: unknown, path: string): RequiredDocument {
  const record = asRecord(value, path);
  return {
    id: asId(record.id, `${path}.id`),
    title: asLocalized(record.title, `${path}.title`),
  };
}

function asDocumentsSource(value: unknown, path: string): DocumentsSource {
  const record = asRecord(value, path);
  const url = asString(record.url, `${path}.url`);
  if (!url.startsWith("https://")) throw new RuleValidationError(`${path}.url`, "нужна ссылка https://");
  return { url, checkedAt: asDate(record.checkedAt, `${path}.checkedAt`) };
}

function asConsequence(value: unknown, path: string): Consequence {
  const record = asRecord(value, path);
  return {
    text: asLocalized(record.text, `${path}.text`),
    article: asLocalized(record.article, `${path}.article`),
    checkedAt: asDate(record.checkedAt, `${path}.checkedAt`),
  };
}

function asRule(value: unknown, path: string): DeadlineRule {
  const record = asRecord(value, path);
  const term = asRecord(record.term, `${path}.term`);

  const event = asString(term.event, `${path}.term.event`);
  if (event !== "entry") {
    throw new RuleValidationError(`${path}.term.event`, "поддерживается только entry");
  }

  const days = term.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) {
    throw new RuleValidationError(`${path}.term.days`, "ожидается целое число от 1 до 3650");
  }

  const counting = asString(term.counting, `${path}.term.counting`);
  if (counting !== "eventDay" && counting !== "dayAfterEvent") {
    throw new RuleValidationError(`${path}.term.counting`, "ожидается eventDay или dayAfterEvent");
  }

  let repeat: DeadlineRule["repeat"];
  if (record.repeat !== undefined) {
    const raw = asRecord(record.repeat, `${path}.repeat`);
    const months = raw.months;
    if (typeof months !== "number" || !Number.isInteger(months) || months < 1 || months > 120) {
      throw new RuleValidationError(`${path}.repeat.months`, "ожидается целое число от 1 до 120");
    }
    const graceDays = raw.graceDays ?? 0;
    if (typeof graceDays !== "number" || !Number.isInteger(graceDays) || graceDays < 0 || graceDays > 366) {
      throw new RuleValidationError(`${path}.repeat.graceDays`, "ожидается целое число от 0 до 366");
    }
    repeat = { months, graceDays };
  }

  const appliesIfRaw = record.appliesIf;
  if (!Array.isArray(appliesIfRaw)) {
    throw new RuleValidationError(`${path}.appliesIf`, "ожидается массив (пустой — правило всегда применимо)");
  }

  const documentsRaw = record.documents;
  if (!Array.isArray(documentsRaw)) {
    throw new RuleValidationError(`${path}.documents`, "ожидается массив");
  }

  return {
    id: asId(record.id, `${path}.id`),
    title: asLocalized(record.title, `${path}.title`),
    action: asLocalized(record.action, `${path}.action`),
    term: { event, days, counting },
    ...(repeat === undefined ? {} : { repeat }),
    appliesIf: appliesIfRaw.map((c, i) => asCondition(c, `${path}.appliesIf[${i}]`)),
    documents: documentsRaw.map((d, i) => asDocument(d, `${path}.documents[${i}]`)),
    ...(record.documentsSource === undefined ? {} : { documentsSource: asDocumentsSource(record.documentsSource, `${path}.documentsSource`) }),
    ...(record.consequence === undefined ? {} : { consequence: asConsequence(record.consequence, `${path}.consequence`) }),
    legal: asLegalBasis(record.legal, `${path}.legal`),
  };
}

export interface RuleSet {
  version: string;
  rules: DeadlineRule[];
}

export function parseRuleSet(raw: unknown): RuleSet {
  const record = asRecord(raw, "$");
  const rulesRaw = record.rules;
  if (!Array.isArray(rulesRaw) || rulesRaw.length === 0) {
    throw new RuleValidationError("$.rules", "ожидается непустой массив правил");
  }

  const rules = rulesRaw.map((r, i) => asRule(r, `$.rules[${i}]`));

  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new RuleValidationError("$.rules", `повторяющийся id «${rule.id}»`);
    }
    seen.add(rule.id);
    const docs = rule.documents.map(d => d.id);
    const twice = docs.find((id, i) => docs.indexOf(id) !== i);
    if (twice !== undefined) throw new RuleValidationError(`$.rules.${rule.id}.documents`, `повторяющийся id документа «${twice}»`);
  }

  return { version: asString(record.version, "$.version"), rules };
}
