/**
 * Loads university profiles: the part of the scenario that changes from one university
 * to the next (name, contact page, citizenship buttons). Adding a university is adding
 * a JSON file to src/data/universities, not editing the dialogue.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidDate } from "../core/dates.js";
import type { Condition, Localized, RequiredDocument } from "../core/types.js";

export interface University {
  /** Deep-link payload: https://max.ru/<bot>?start=<id> */
  id: string;
  /** Short name used inside sentences ("студент КФУ"), so an indeclinable abbreviation. */
  name: Localized;
  contactUrl: string;
  citizenships: string[];
  checkedAt: string;
  /**
   * The university's own procedures whose deadline the bot cannot calculate — e.g. migration
   * registration "the next working day after moving into the dormitory": the bot does not know
   * that date. Shown with the deadline in the source's words, without reminders or a calendar
   * event (docs/product/plan-vs-studroute.md, items 1 and 5). Empty when the profile has none.
   */
  procedures: UniversityProcedure[];
}

export interface UniversityProcedure {
  id: string;
  title: Localized;
  action: Localized;
  /** The deadline in the source's words; never turned into a date. */
  when: Localized;
  documents: RequiredDocument[];
  /** Only citizenship conditions: which students of this university it concerns. */
  appliesIf: Extract<Condition, { field: "citizenship" }>[];
  source: { url: string; checkedAt: string };
  /**
   * The source words the deadline in days before the end of a document the student holds
   * ("no later than 45 days before the visa expires"): once the student gives that date, the bot
   * counts it (D-040). Absent when the source gives no such number — then only the words are shown.
   */
  countdown?: ProcedureCountdown;
}

export interface ProcedureCountdown {
  from: "visa-end" | "registration-end";
  /** The last day to act: this many days before the end date. */
  daysBefore: number;
  /** The first day to act, when the source sets one ("no earlier than 90 days before"). */
  notBeforeDays?: number;
}

export class UniversityValidationError extends Error {
  constructor(path: string, problem: string) {
    super(`Профиль вуза невалиден (${path}): ${problem}`);
    this.name = "UniversityValidationError";
  }
}

const text = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new UniversityValidationError(path, "ожидается непустая строка");
  return value;
};
const record = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UniversityValidationError(path, "ожидается объект");
  return value as Record<string, unknown>;
};
/** Every language of the interface is checked where the texts are loaded (tests/university.test.ts). */
const localized = (value: unknown, path: string): Localized => {
  const r = record(value, path);
  text(r.ru, `${path}.ru`);
  return Object.fromEntries(Object.entries(r).filter(([lang]) => /^[a-z]{2}$/.test(lang))
    .map(([lang, v]) => [lang, text(v, `${path}.${lang}`)]));
};
const slug = (value: unknown, path: string): string => {
  const v = text(value, path);
  if (!/^[a-z0-9-]{1,64}$/.test(v)) throw new UniversityValidationError(path, "латиница в нижнем регистре, цифры и -, до 64 символов");
  return v;
};

function parseProcedure(raw: unknown, path: string): UniversityProcedure {
  const p = record(raw, path);
  if (!Array.isArray(p.documents)) throw new UniversityValidationError(`${path}.documents`, "ожидается массив");
  const documents = p.documents.map((d, i) => {
    const doc = record(d, `${path}.documents[${i}]`);
    return { id: slug(doc.id, `${path}.documents[${i}].id`), title: localized(doc.title, `${path}.documents[${i}].title`) };
  });
  const twice = documents.map(d => d.id).find((id, i, all) => all.indexOf(id) !== i);
  if (twice !== undefined) throw new UniversityValidationError(`${path}.documents`, `повторяющийся id документа «${twice}»`);
  if (!Array.isArray(p.appliesIf)) throw new UniversityValidationError(`${path}.appliesIf`, "ожидается массив (пустой — для всех)");
  const appliesIf = p.appliesIf.map((c, i) => {
    const cond = record(c, `${path}.appliesIf[${i}]`);
    if (cond.field !== "citizenship" || (cond.op !== "in" && cond.op !== "notIn") || !Array.isArray(cond.values) ||
        cond.values.length === 0 || !cond.values.every(v => typeof v === "string" && /^[A-Z]{2}$/.test(v))) {
      throw new UniversityValidationError(`${path}.appliesIf[${i}]`, "поддерживается только citizenship in/notIn со списком кодов ISO");
    }
    return { field: "citizenship" as const, op: cond.op as "in" | "notIn", values: cond.values as string[] };
  });
  const source = record(p.source, `${path}.source`);
  const url = text(source.url, `${path}.source.url`);
  if (!url.startsWith("https://")) throw new UniversityValidationError(`${path}.source.url`, "нужна ссылка https://");
  const checkedAt = text(source.checkedAt, `${path}.source.checkedAt`);
  if (!isValidDate(checkedAt)) throw new UniversityValidationError(`${path}.source.checkedAt`, "ожидается дата ГГГГ-ММ-ДД");
  const countdown = p.countdown === undefined ? undefined : parseCountdown(p.countdown, `${path}.countdown`);
  return { id: slug(p.id, `${path}.id`), title: localized(p.title, `${path}.title`), action: localized(p.action, `${path}.action`),
    when: localized(p.when, `${path}.when`), documents, appliesIf, source: { url, checkedAt }, ...(countdown ? { countdown } : {}) };
}

function parseCountdown(raw: unknown, path: string): ProcedureCountdown {
  const c = record(raw, path);
  if (c.from !== "visa-end" && c.from !== "registration-end") throw new UniversityValidationError(`${path}.from`, "visa-end или registration-end");
  const days = (v: unknown, field: string) => {
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 365) throw new UniversityValidationError(`${path}.${field}`, "целое число дней от 1 до 365");
    return v as number;
  };
  const daysBefore = days(c.daysBefore, "daysBefore");
  if (c.notBeforeDays === undefined) return { from: c.from, daysBefore };
  const notBeforeDays = days(c.notBeforeDays, "notBeforeDays");
  if (notBeforeDays <= daysBefore) throw new UniversityValidationError(`${path}.notBeforeDays`, "должно быть больше daysBefore");
  return { from: c.from, daysBefore, notBeforeDays };
}

export function parseUniversity(raw: unknown, path = "university"): University {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new UniversityValidationError(path, "ожидается объект");
  const u = raw as Record<string, unknown>;
  const id = text(u.id, `${path}.id`);
  // MAX delivers ?start= payloads up to 128 characters; keep ids safe for a URL as is.
  if (!/^[a-z0-9_-]{1,32}$/.test(id)) throw new UniversityValidationError(`${path}.id`, "латиница в нижнем регистре, цифры, _ и -, до 32 символов");
  const name = u.name as Record<string, unknown> | undefined;
  const contactUrl = text(u.contactUrl, `${path}.contactUrl`);
  if (!contactUrl.startsWith("https://")) throw new UniversityValidationError(`${path}.contactUrl`, "нужна ссылка https://");
  if (!Array.isArray(u.citizenships) || u.citizenships.length === 0 ||
      !u.citizenships.every(c => typeof c === "string" && /^[A-Z]{2}$/.test(c))) {
    throw new UniversityValidationError(`${path}.citizenships`, "ожидается непустой список кодов ISO из двух букв");
  }
  const checkedAt = text(u.checkedAt, `${path}.checkedAt`);
  if (!isValidDate(checkedAt)) throw new UniversityValidationError(`${path}.checkedAt`, "ожидается дата ГГГГ-ММ-ДД");
  text(name?.ru, `${path}.name.ru`);
  const names = Object.fromEntries(Object.entries(name ?? {}).filter(([lang]) => /^[a-z]{2}$/.test(lang))
    .map(([lang, value]) => [lang, text(value, `${path}.name.${lang}`)]));
  if (u.procedures !== undefined && !Array.isArray(u.procedures)) throw new UniversityValidationError(`${path}.procedures`, "ожидается массив");
  const procedures = ((u.procedures ?? []) as unknown[]).map((p, i) => parseProcedure(p, `${path}.procedures[${i}]`));
  const repeated = procedures.map(p => p.id).find((id, i, all) => all.indexOf(id) !== i);
  if (repeated !== undefined) throw new UniversityValidationError(`${path}.procedures`, `повторяющийся id «${repeated}»`);
  return { id, name: names,
    contactUrl, citizenships: [...new Set(u.citizenships as string[])], checkedAt, procedures };
}

/** All profiles from a directory; the default university comes first. */
export function readUniversities(dir: string, defaultId: string): University[] {
  const list = readdirSync(dir).filter(f => f.endsWith(".json")).sort()
    .map(f => parseUniversity(JSON.parse(readFileSync(join(dir, f), "utf8")), f));
  const ids = new Set(list.map(u => u.id));
  if (ids.size !== list.length) throw new UniversityValidationError(dir, "повторяющийся id");
  const first = list.find(u => u.id === defaultId);
  if (!first) throw new UniversityValidationError(dir, `нет профиля по умолчанию «${defaultId}»`);
  return [first, ...list.filter(u => u !== first)];
}

/** A university procedure shares the card namespace with the rules (`card:<id>`), so ids must not clash. */
export function checkProcedures(universities: University[], ruleIds: string[]): void {
  for (const u of universities) {
    const clash = u.procedures.find(p => ruleIds.includes(p.id));
    if (clash) throw new UniversityValidationError(`${u.id}.procedures`, `id «${clash.id}» совпадает с id нормы`);
  }
}

/** A citizenship the rules exclude must not look covered: it is offered separately and leads to help. */
export function checkCitizenships(universities: University[], excluded: string[]): void {
  for (const u of universities) {
    const clash = u.citizenships.filter(c => excluded.includes(c));
    if (clash.length) throw new UniversityValidationError(u.id, `гражданства ${clash.join(", ")} исключены нормами — уберите их из профиля`);
  }
}
