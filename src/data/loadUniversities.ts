/**
 * Loads university profiles: the part of the scenario that changes from one university
 * to the next (name, contact page, citizenship buttons). Adding a university is adding
 * a JSON file to src/data/universities, not editing the dialogue.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidDate } from "../core/dates.js";
import type { Localized } from "../core/types.js";

export interface University {
  /** Deep-link payload: https://max.ru/<bot>?start=<id> */
  id: string;
  /** Short name used inside sentences ("студент КФУ"), so an indeclinable abbreviation. */
  name: Localized;
  contactUrl: string;
  citizenships: string[];
  checkedAt: string;
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
      !u.citizenships.every(c => typeof c === "string" && /^[A-Z]{2}$/.test(c) && c !== "BY")) {
    // BY is excluded by the rules themselves and always leads to the help branch.
    throw new UniversityValidationError(`${path}.citizenships`, "ожидается непустой список кодов ISO из двух букв, кроме BY");
  }
  const checkedAt = text(u.checkedAt, `${path}.checkedAt`);
  if (!isValidDate(checkedAt)) throw new UniversityValidationError(`${path}.checkedAt`, "ожидается дата ГГГГ-ММ-ДД");
  text(name?.ru, `${path}.name.ru`);
  const names = Object.fromEntries(Object.entries(name ?? {}).filter(([lang]) => /^[a-z]{2}$/.test(lang))
    .map(([lang, value]) => [lang, text(value, `${path}.name.${lang}`)]));
  return { id, name: names,
    contactUrl, citizenships: [...new Set(u.citizenships as string[])], checkedAt };
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
