# PostgreSQL Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести рабочее хранение профилей, событий и очереди бота с SQLite на PostgreSQL без потери существующих данных и без правок UI.

**Architecture:** Один PostgreSQL для профилей, дедупликации и outbox. Сервис сохраняет атомарность обработки обновлений через один клиент `pg` на транзакцию; задачи отправки получают аренду. Старую SQLite читаем только одноразовым импортёром. Подключение к `src/bot/` выполняем после слияния PR #3.

**Tech Stack:** Node.js 24, TypeScript 5.9, `pg` (версию закрепить по npm registry), PostgreSQL 16+ в Compose/CI, Vitest 3.2.

**Spec:** `docs/superpowers/specs/2026-09-23-postgres-storage-design.md`

## Global Constraints

- UI, `src/bot/dialog.ts`, `src/core/`, `src/data/rules/`, MAX webhook-подписку и токен не менять.
- PR #3 и PR #5 уже влиты в `main`; изменения PR #3 — базовый контракт для PostgreSQL, сценарии презентации PR #5 имеют отдельную информационную сверку по `src`. PR #4 пока владеет `src/demo.ts` и `tests/bot.test.ts`; эти пути не править до слияния/передачи. Ветку UI считать неизвестной и перепроверять `git branch -r` перед интеграцией.
- Все агенты работают в отдельных `.claude/worktrees/` от опубликованной ветки плана, коммитят только свои пути и запускают `bash .claude/hooks/check-upstream.sh` перед коммитом.
- Пароль PostgreSQL хранить только в `.env`; в `.env.example` оставлять плейсхолдер. Данные тестов синтетические. Исходный SQLite volume не удалять.
- Ни один шаг не переключает действующую ВМ. Крупный переход остаётся в ветке на ревью; реальный MAX mobile/web проверяется после согласованного развёртывания.

## Карта файлов и владельцы

| Этап | Файлы | Независимость |
|---|---|---|
| 1. Схема | `src/db/schema.ts`, `src/db/migrate.ts`, `tests/pg-schema.test.ts`, `package.json`, `package-lock.json` | отдельный агент A; не правит бот |
| 2. Снимок SQLite | `src/db/sqlite-snapshot.ts`, `tests/sqlite-snapshot.test.ts` | отдельный агент B; не импортирует `pg` |
| 3. Импорт | `src/db/import-sqlite.ts`, `tests/import-sqlite.test.ts` | после этапов 1–2 |
| 4. Runtime | `src/bot/store.ts`, `src/bot/service.ts`, `src/bot/server.ts`, `src/main.ts`, `src/demo.ts`, `tests/bot.test.ts` | только после PR #3; один владелец этих контрактов |
| 5. Операции | `compose.yaml`, `Dockerfile`, `.env.example`, `.github/workflows/check.yml`, `README.md`, `docs/deploy.md`, `docs/decisions.md`, `HANDOFF.md` | после runtime и сверки чужих веток |

### Task 1: Схема и миграция PostgreSQL (агент A)

**Files:** Create `src/db/schema.ts`, `src/db/migrate.ts`, `tests/pg-schema.test.ts`; modify `package.json`, `package-lock.json`.

**Interfaces:** `migrate(pool: Pool): Promise<void>`; `SCHEMA_V1: string`. `migrate` берёт один клиент, выполняет `BEGIN`, `SELECT pg_advisory_xact_lock(91824001)`, читает `schema_migrations`, применяет только отсутствующую миграцию, затем `COMMIT`; при ошибке — `ROLLBACK`, `release` в `finally`.

- [ ] Написать тест на пустой PostgreSQL: после двух вызовов `migrate(pool)` версия `1` существует ровно один раз, а `sessions`, `events`, `outbox` созданы. Тест использует `TEST_DATABASE_URL` и синтетическую отдельную БД; без переменной явно пропускается, в CI она обязательна.
- [ ] Запустить тест до реализации и зафиксировать красный результат.
- [ ] Добавить `pg` и `@types/pg` через `npm install --save-exact` / `npm install --save-dev --save-exact`; версия берётся из реестра, фиксируется lock-файлом.
- [ ] Реализовать SQL с `sessions(user_id BIGINT PRIMARY KEY, data JSONB NOT NULL, updated_at BIGINT NOT NULL)`, `events(id TEXT PRIMARY KEY, created_at BIGINT NOT NULL)` и `outbox(id TEXT PRIMARY KEY, user_id BIGINT NOT NULL, payload JSONB NOT NULL, kind TEXT CHECK(kind IN ('reply','reminder')), attempts INTEGER NOT NULL DEFAULT 0, next_attempt BIGINT NOT NULL, status TEXT CHECK(status IN ('pending','sending','sent','cancelled','failed')), created_at BIGINT NOT NULL, lease_token UUID, lease_until BIGINT)`. Добавить индексы готовой очереди, просроченной аренды и `user_id,kind,status`.
- [ ] Запустить `npm test`, `npm run typecheck`, `npm run build`; при доступном PostgreSQL — тест схемы с `TEST_DATABASE_URL`.
- [ ] `bash .claude/hooks/check-upstream.sh`, затем отдельный коммит `api: схема и миграция PostgreSQL`; push своей ветки.

Пример проверки после миграции:

```ts
await migrate(pool);
await migrate(pool);
const result = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM schema_migrations WHERE version = 1");
expect(result.rows[0]?.n).toBe("1");
```

### Task 2: Безопасное чтение исходной SQLite (агент B)

**Files:** Create `src/db/sqlite-snapshot.ts`, `tests/sqlite-snapshot.test.ts`.

**Interfaces:** `readSqliteSnapshot(path: string): SqliteSnapshot`. Тип содержит `sessions: {userId:number; data:unknown; updatedAt:number}[]`, `events: {id:string; createdAt:number}[]`, `outbox: {id:string; userId:number; payload:unknown; kind:'reply'|'reminder'; attempts:number; nextAttempt:number; status:'pending'|'sent'|'cancelled'|'failed'; createdAt:number}[]`. Экспорт не пишет файл и не меняет SQLite.

- [ ] Тестом создать синтетическую SQLite базу старой схемы с профилем, event и pending/sent заданиями; проверить точное сохранение JSON, миллисекунд и числа строк.
- [ ] Добавить тест: отсутствующая таблица, повреждённый JSON, небезопасный `user_id` и неизвестный статус приводят к ошибке без частичного результата.
- [ ] Запустить тест до реализации, затем реализовать чтение через `DatabaseSync(path, { readOnly: true })`, явные `SELECT` и строгую проверку значений. Не печатать данные профиля.
- [ ] Запустить `npm test`, `npm run typecheck`, `npm run build`.
- [ ] `bash .claude/hooks/check-upstream.sh`, затем коммит `api: безопасный снимок данных SQLite`; push своей ветки.

Пример контракта теста:

```ts
const snapshot = readSqliteSnapshot(path);
expect(snapshot.sessions).toHaveLength(1);
expect(snapshot.sessions[0]?.data).toEqual({ step: "plan", reminders: true });
expect(snapshot.outbox.map(job => job.status)).toEqual(["pending", "sent"]);
```

### Task 3: Одноразовый импорт без потери данных

**Files:** Create `src/db/import-sqlite.ts`, `tests/import-sqlite.test.ts`; modify `package.json` для команды `db:import-sqlite`.

**Interfaces:** `importSqlite(pool: Pool, snapshot: SqliteSnapshot): Promise<{sessions:number; events:number; outbox:number}>`. Использует `migrate(pool)` до транзакции, требует все три целевые таблицы пустыми, вставляет строки параметризованно одним клиентом и сверяет counts перед `COMMIT`.

- [ ] Интеграционный тест на реальном PostgreSQL: импорт синтетического снимка сохраняет все JSON и timestamps; повторный импорт отвергается, не меняя данные.
- [ ] Тест с намеренно неверной строкой доказывает полный `ROLLBACK` всех трёх таблиц.
- [ ] Реализовать CLI: путь к SQLite берётся из аргумента; `PG*` из окружения; stdout содержит только числа строк, без MAX ID и содержимого JSON. Проверить, что команда не удаляет исходный файл.
- [ ] Запустить `npm test`, `npm run typecheck`, `npm run build` и интеграционные тесты на PostgreSQL.
- [ ] `bash .claude/hooks/check-upstream.sh`, коммит `api: одноразовый импорт SQLite в PostgreSQL`.

### Task 4: Перевести бот на асинхронное PostgreSQL хранилище

**Предусловие:** PR #3 влита; актуальный `origin/main` уже интегрирован в ветку плана. Сначала создать отдельный PostgreSQL-модуль и тесты без файлов PR #4. После слияния PR #4 либо явной передачи этих файлов интегрировать модуль с ботом, `src/demo.ts` и `tests/bot.test.ts`; каждый раз перед этим `git fetch --prune`, diff PR и `git merge origin/main`.

**Files:** Create `src/db/postgres-store.ts`, `tests/pg-store.test.ts`; then modify `src/bot/store.ts`, `src/bot/service.ts`, `src/bot/server.ts`, `src/bot/config.ts`, `src/main.ts`, `src/demo.ts`, `tests/bot.test.ts` after clearing ownership.

**Interfaces:** `Store.open(pool: Pool): Promise<Store>`, `store.transaction<T>(userId:number, fn:(tx:StoreTx)=>Promise<T>):Promise<T>`, `store.claim(now:number, leaseToken:string):Promise<Job|undefined>`, `store.finish(id:string, leaseToken:string):Promise<boolean>`, `store.retry(job:Job, now:number):Promise<void>`, `store.close():Promise<void>`. `Service.receive`, `Service.maintain`, `Service.scheduleUser` становятся `async`; HTTP ждёт `receive` перед `200`.

- [ ] Переписать существующие тесты на `await receive()`; добавить реальный PostgreSQL тест двух одновременных обновлений одного пользователя, отката ID события при ошибке записи, повторной доставки, аренды задания и рестарта сервиса.
- [ ] Реализовать транзакцию на одном `PoolClient`, блокировку пользователя `SELECT pg_advisory_xact_lock($1::bigint)`, параметризованные `INSERT ... ON CONFLICT`, проверку безопасного `user_id` при чтении. Сохранить семантику PR #3, включая оптимизацию `maintain` и календарь.
- [ ] Реализовать атомарный `claim` через `FOR UPDATE SKIP LOCKED` + `UPDATE ... RETURNING`; `finish/retry/cancel` обновляют запись только при совпадении `lease_token`. Повтор просроченной аренды допускает дубликат исходящего сообщения и это фиксируется в документации.
- [ ] `Service.receive` и сервер отвечают `200` только после commit; при ошибке БД возвращают `503`. Старт сервера — после `migrate` и проверки подключения; shutdown закрывает pool после активной работы.
- [ ] Прогнать все тесты, typecheck, build и `demo:check` с PostgreSQL; проверить, что тесты PR #3 не потеряны.
- [ ] `bash .claude/hooks/check-upstream.sh`, коммит `api: бот использует PostgreSQL`.

Пример конкурентного критерия:

```ts
await Promise.all([service.receive(updateA), service.receive(updateB)]);
const state = await store.get(userId);
expect(state?.revision).toBe(2);
```

### Task 5: Compose, CI, документация и приёмка ветки

**Files:** Modify `compose.yaml`, `Dockerfile`, `.env.example`, `.github/workflows/check.yml`, `README.md`, `docs/deploy.md`, `docs/decisions.md`, `HANDOFF.md`.

- [ ] Добавить PostgreSQL 16+ с отдельным volume и healthcheck; `bot` ждёт healthy DB. Пароль обязателен через `.env`, никаких рабочих значений в Git. Образ включает только runtime-зависимости и нужные миграции.
- [ ] CI запускает реальный PostgreSQL service и все интеграционные тесты; `demo:check` работает на тестовой БД. Ветка UI и PR #4 сверены по новым коммитам до правок общих документов и CI; изменения CI из влитой PR #5 сохранить.
- [ ] README и deploy runbook описывают backup (`pg_dump`), проверку восстановления в отдельной БД, остановку старого бота, snapshot SQLite с WAL, импорт, сверку counts, запуск и сценарий отказа. Не запускать `docker compose down -v`.
- [ ] Записать решение о PostgreSQL отдельной строкой в `docs/decisions.md`, обновить `HANDOFF.md` с commit, проверками и ограничениями. При необходимости обновить `docs/tz-compliance.md` в том же коммите, что и артефакт.
- [ ] Запустить `npm test`, `npm run typecheck`, `npm run build`, `npm run demo:check`, `docker compose build`; проверить GitHub Actions и отсутствие секретов. Крупная ветка идёт на ревью до слияния в `main`.

## Порядок передачи

После публикации плана агенты A и B сделали схему и чтение SQLite в отдельных worktree; Task 3 с импортом также прошёл ревью и реальный PostgreSQL. PR #3 и PR #5 влиты, поэтому Task 4 начинается с изолированного PostgreSQL-модуля, а подключение к demo/общим тестам ждёт PR #4. Task 5 — после работающего runtime с сохранением проверок CI из PR #5. Переключение рабочей ВМ и проверка в MAX остаются отдельным этапом после ревью.
