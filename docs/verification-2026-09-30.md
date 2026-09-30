# Протокол проверок 30.09.2026

Выкатка кода к финалу (PR #15, #17, D-038…D-043) на ВМ в день сдачи — решение человека.
Предыдущий протокол — [verification-2026-09-28.md](verification-2026-09-28.md) (`8bcb1cd`).

## Проверки перед выкаткой, `cd5ec9e`

| Проверка | Результат | Как проверено |
|---|---|---|
| Тесты | ✅ 358 пройдено, 1 пропущен (359) | `npm test` в чистом worktree от `origin/main` |
| Типы, сборка | ✅ | `npm run typecheck`, `npx tsc --noEmit` в `web/`, `npm run build`, `npm run web:build` |
| Сквозной сценарий | ✅ прогресс, напоминание, отметка, остановка | `npm run demo:check` |
| Профили вузов, источники | ✅ каталог принят; источников 8, изменились 0 | `npm run university:check`, `npm run sources:check` |
| CI | ✅ [run 36702192549](https://github.com/M1hairu/MAX_GOATed_messenger/actions/runs/36702192549) | GitHub Actions `checks` |
| Совместимость с данными на сервере | ✅ | ревью `git diff 8bcb1cd cd5ec9e -- src web`: версия норм не менялась (профили не становятся «правила изменились»); новые поля сессии `visits`, `ends` и шаги `visit`, `docEnd` необязательны; старые задания очереди без новых полей идут прежней веткой; инфраструктура не менялась (Dockerfile, compose, зависимости — только скрипты `office`, `university:check`, `sources:check`) |

Ограничение отката: код `8bcb1cd` не читает сессию на шаге `visit` или `docEnd` (его проверка
шагов строже). Откатывать — пока такие сессии не появились или предупредив, что эти
пользователи начнут с `/start`.

## Выкатка на ВМ

| Проверка | Результат | Как проверено |
|---|---|---|
| Версия до выкатки | `8bcb1cd` | `~/max-bot/DEPLOYED_COMMIT` |
| Бэкап перед выкаткой | ✅ `~/backup-before-main-2026-09-30-1401.dump`, 14 КБ, права 600 | `pg_dump -Fc` по `docs/deploy.md`, «Бэкап» |
| Выкатка | ✅ `cd5ec9e`, `up --build --wait` за 70 с | `docs/deploy.md`, «Обновление» |
| `/health` | ✅ `status: ok`, `commit` = `cd5ec9ef2a7f5ebd703ba0ed4281b31ab99340d2` | `curl` снаружи |
| Контейнеры, лог | ✅ `bot` и `postgres` — healthy; в логе `started`, ошибок нет | `docker compose ps`, `docker compose logs --since 5m bot` |
| Данные | ✅ профилей 11 после выкатки (счёт до выкатки не снят) | `SELECT count(*) FROM sessions` |
| Webhook | ✅ `POST /webhook` без секрета → 401; подписка — один URL `…/webhook` | `curl`, `GET /subscriptions` из контейнера |
| Мини-приложение | ✅ `/` → 200; `/app/` отдаёт бандл `index-DeX5Ql52.js` = локальная сборка `cd5ec9e` | `curl` |
| Сборка без кеша | ✅ **63 с** (лимит 5 мин); базовые образы уже загружены | `docker compose build --no-cache bot` на ВМ (2 vCPU, 50%), без перезапуска контейнера |
| Сцены презентации | ✅ совпадают с кодом | `npm run demo:export` → `npm run demo:export:check` |

## Прогон в MAX после выкатки

**Не проведён** — вечером 30.09. Шаги 1–40 `docs/max-manual-check.md` — в мобильном MAX и в
web.max.ru, скриншоты веб-версии — в `images/max-check/web-*`.

| Версия | Кто | Когда (МСК) | Устройство / браузер | Commit на сервере | Итог |
|---|---|---|---|---|---|
| Мобильная | | | | `cd5ec9e` | |
| Веб | | | | `cd5ec9e` | |
