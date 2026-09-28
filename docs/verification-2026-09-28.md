# Протокол проверок 28.09.2026

Выкатка исправлений 28.09 и проверки коммита, который предлагается к сдаче. Предыдущий
протокол — [verification-2026-09-27.md](verification-2026-09-27.md).

## Выкатка на ВМ

| Проверка | Результат | Как проверено |
|---|---|---|
| Версия до выкатки | `bc649ef` | `~/max-bot/DEPLOYED_COMMIT` |
| Бэкап перед выкаткой | ✅ `~/backup-before-8bcb1cd-2026-09-28-0935.dump`, 13,5 КБ, права 600 | `pg_dump -Fc` по `docs/deploy.md`, «Бэкап» |
| Выкатка | ✅ `8bcb1cd` | `docs/deploy.md`, «Обновление»: `rm -rf src`, `git archive`, `DEPLOYED_COMMIT=… docker compose up --build -d --wait` |
| `/health` | ✅ `status: ok`, `commit` = `8bcb1cd7a92fb623dc98ccfad4655bc045f4ddbd` = `origin/main` | `curl` снаружи |
| Контейнеры | ✅ `bot` и `postgres` — healthy | `docker compose ps` |
| Данные | ✅ профилей 8 до и после выкатки | `SELECT count(*) FROM sessions` |
| Webhook | ✅ `POST /webhook` без секрета → 401; подписка — один URL `…/webhook` | `curl`, `GET /subscriptions` из контейнера |
| Мини-приложение | ✅ `/` → 200, HTML «Первые 90 дней» | `curl` |

## Код и сборка на `8bcb1cd`

| Проверка | Результат | Как проверено |
|---|---|---|
| Тесты | ✅ 226 пройдено, 1 пропущен (227) | `npm test` |
| CI | ✅ [run 36395680935](https://github.com/M1hairu/MAX_GOATed_messenger/actions/runs/36395680935) | GitHub Actions `checks` |
| Сборка без кеша | ✅ **64 с** (лимит 5 мин); базовые образы уже загружены | `git archive 8bcb1cd` в пустой каталог на ВМ (2 vCPU, 50%), `docker compose -p clean-check build --no-cache`; образ после замера удалён |
| Сцены презентации | ✅ совпадают с кодом | `npm run demo:export:check` после перевыгрузки |
| PDF | ✅ собран из исходников | `python scripts/build-presentation.py --check` в `python:3.14-slim` |

## Прогон в MAX после выкатки

**Не проведён.** Шаги 1–24 и 25–32 `docs/max-manual-check.md` — в мобильном MAX и в
web.max.ru, скриншоты веб-версии — в `images/max-check/web-*`.

| Версия | Кто | Когда (МСК) | Устройство / браузер | Commit на сервере | Итог |
|---|---|---|---|---|---|
| Мобильная | | | | `8bcb1cd` | |
| Веб | | | | `8bcb1cd` | |
