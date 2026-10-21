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

## Чек-лист сдачи 30.09 на ветке `online-submission`

Скилл `submission-checklist`, чистый клон `online-submission` на `5517eda`, 30.09.2026.

| Пункт | Итог | Доказательство |
|---|---|---|
| Код = выкаченный | ✅ | `git diff --stat 8bcb1cd origin/online-submission -- src web Dockerfile compose.yaml package.json package-lock.json` пуст |
| Сервер | ✅ | `/health` → `status: ok`, `commit` = `8bcb1cd…`, `failed: 0` |
| CI | ✅ | `checks` на `5517eda` — success ([run 36677540839](https://github.com/M1hairu/MAX_GOATed_messenger/actions/runs/36677540839)) |
| Docker | ✅ | `docker compose config -q`; `build --no-cache` — **45 с** (базовые образы загружены заранее); `up -d --wait` → `bot` и `postgres` healthy, локальный `/health` 200; `.dockerignore` исключает `.git`, `.env`, `node_modules` |
| Зависимости | ✅ | `package-lock.json`, `web/package-lock.json`; лицензии по lock-файлам — MIT, ISC, Apache-2.0, BSD-3-Clause, MPL-2.0 (`lightningcss`, сборка), OFL-1.1 (шрифты); закрытых нет |
| Секреты | ✅ | `check-secrets.sh` — пусто; в `.env.example` токен пуст, пароли — `local-demo-only-not-for-deployment` |
| README | ✅ | разделы: запуск одной командой, сценарий и проверка, окружение, реальная интеграция MAX, архитектура, данные и интеграции (`[MOCKED]`), проверки, остановка, ограничения, лицензия |
| Слайд 1 | ✅ | бот, репозиторий, commit `8bcb1cd`, HTTPS `/health`, «учётки и токены не нужны», путь проверки |
| Слайд 2, команда | ❌ | `manifest.json` → `"team": null` — нужен состав команды (человек) и пересборка PDF |
| Прогон в MAX | ❌ | таблица выше пуста — шаги 1–32 в мобильном MAX и web.max.ru (человек) |
| Тег `submit-online` | ⏳ | ставится последним, после двух пунктов выше |
