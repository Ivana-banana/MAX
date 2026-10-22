# Протокол проверок 21.10.2026

Выкатка `origin/main` на ВМ перед финалом (#57): прогон в MAX ждал новой версии.
Предыдущий протокол — [verification-2026-09-30.md](verification-2026-09-30.md) (`cd5ec9e`).

## Проверки перед выкаткой, `f8d9ddd`

| Проверка | Результат | Как проверено |
|---|---|---|
| Тесты | ✅ 486 пройдено, 1 пропущен (487), файлов 39 | `npm ci --ignore-scripts && npm test` в чистом worktree от `origin/main` |
| Типы, сборка | ✅ | `npm run typecheck`, `npm run build`; мини-приложение собрано в Docker на ВМ |
| Сквозной сценарий | ✅ прогресс, напоминание, отметка, остановка | `npm run demo:check` |
| Конфигурация | ✅ `.env` на ВМ не менялся | `git diff cd5ec9e f8d9ddd -- .env.example compose.yaml Dockerfile`: новые `RATE_LIMIT_PER_MINUTE`, `SEND_TIMEOUT_MS` с дефолтами; в образ добавлены `src/data/calendar`, `src/data/fonts` |
| Схема БД | ✅ без DDL | `git diff cd5ec9e f8d9ddd -- src/db/` |
| Версия норм | ⚠️ сменилась (`2026-09-24.2-draft` → `2026-10-19.1`) | `src/data/rules/ru-student.json`: существующие профили получат «Правила изменились» и начнут с `/start` (сверка #35) |

## Выкатка на ВМ

| Проверка | Результат | Как проверено |
|---|---|---|
| Версия до выкатки | `cd5ec9e` | `~/max-bot/DEPLOYED_COMMIT`, `/health` |
| Бэкап перед выкаткой | ✅ `~/backup-before-main-2026-10-21-1944.dump`, 13 КБ, права 600 | `pg_dump -Fc` по `docs/deploy.md`, «Бэкап»; восстановлен в проверочную БД: `sessions=26 outbox=14`, как в рабочей; проверочная БД удалена |
| Выкатка | ✅ `f8d9ddd`, `up --build -d --wait` за 118 с | `docs/deploy.md`, «Обновление» |
| `/health` | ✅ `status: ok`, `failed: 0`, `commit` = `f8d9ddd264fe8a8ed9192be8253885c96b1e77df` | `curl` снаружи, `bash scripts/monitor.sh` |
| Контейнеры, лог | ✅ `bot` и `postgres` — healthy; в логе `started` (`mode: demo`, `transport: max`), ошибок нет | `docker compose ps`, `docker compose logs --since 5m bot` |
| Данные | ✅ профилей 23 из 26 | `SELECT count(*) FROM sessions`. Разница — три сессии на шагах `language`/`consent` старше 7 дней: их удаляет правило #60 при первом обслуживании. Подсчёт по бэкапу тем же условием — 3 |
| Webhook | ✅ `POST /webhook` без секрета → 401; подписка — один URL `…/webhook`, не трогалась | `curl`, `GET /subscriptions` из контейнера |
| Мини-приложение | ✅ `/` и `/app/` → 200, бандл `index-BiGeNad0.js` | `curl` |
| Режим | `APP_MODE=demo` без изменений | лог `started` |

Сборка без кеша на ВМ в этот раз не замерялась; `up --build` с загруженными базовыми образами — 118 с
(лимит 5 мин).

Откат: прежний коммит `cd5ec9e` — командой из `docs/deploy.md`, «Откат»; данные — из бэкапа выше.
Сессии, начатые в новых шагах (`/change`, «до въезда»), старый код может не прочитать.

## Прогон в MAX после выкатки

**Не проведён** — за сокомандником (#20). Шаги `docs/max-manual-check.md` — в мобильном MAX и в
web.max.ru. `WEBAPP_BOT` в `.env` не задан (#58). Прогон записывается в
[verification-2026-10-22.md](verification-2026-10-22.md).

| Версия | Кто | Когда (МСК) | Устройство / браузер | Commit на сервере | Итог |
|---|---|---|---|---|---|
| Мобильная | | | | `f8d9ddd` | |
| Веб | | | | `f8d9ddd` | |
