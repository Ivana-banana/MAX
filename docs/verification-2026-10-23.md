# Проверки 23.10.2026

## Выкатка актуального main (#77)

23.10.2026, ~23:25 МСК, Иван / Claude Code. Релиз —
`176144338ee4662d184368833c74de76c544bb90`, предыдущий —
`b6ed1e216a079d44dfa53b091d18a55edb2853f2`. В релиз вошли #112, #114, #115, #116, #117,
#119, #120 и правка документации #59. Ручные проверки мобильного и веб-MAX для новой
версии пока не выполнены.

| Проверка | Команда | Наблюдаемый результат |
|---|---|---|
| Локальный main | `git fetch --prune`, `git pull --ff-only` | Чистая основная копия обновлена с `7f9918d` до `1761443` |
| Зависимости и тесты (Node 24.15.0) | `npm ci --ignore-scripts`, `npm test` | 41 файл; 503 passed, 1 skipped; 33,15 с |
| Типы и сборка бота | `npm run typecheck`, `npm run build` | Оба exit 0 |
| Демо | `npm run demo:check` | exit 0; `Demo completed: progress saved, reminder delivered, completion recorded, reminders stopped.` |
| Мини-приложение | `npm run web:install`, `npm run web:typecheck`, `npm run web:build` | exit 0; JS `index-6H3LM8Tf.js`, CSS `index-C6-SBJpy.css` |
| Бэкап | `docker compose exec -T postgres pg_dump -U bot -Fc bot` в файл на ВМ | `~/backup-before-main-2026-10-23-77.dump`, 15182 байта, права 600 |
| Восстановление | `createdb`, `pg_restore`, SQL count, `dropdb` в отдельной БД `restore_check_77b` | 25 sessions / 23 outbox, как в рабочей БД; проверочная БД удалена |
| Архив релиза | `git -c core.autocrlf=false archive --format=tar 1761443`, SSH, `sha256sum --check` на ВМ | SHA256 `50fe2d3969beeb93e2c0c3eec85b70fac2c78067649150f912292ae70f0d00d2`, `OK`; `scripts/monitor.sh` без CRLF |
| Сборка и запуск на ВМ | `docker compose build bot`; записан `DEPLOYED_COMMIT`; `DEPLOYED_COMMIT=$(cat DEPLOYED_COMMIT) docker compose up -d --wait` | `real 2m18.7s`; bot и postgres healthy; ошибок в логах бота за первые минуты нет |
| Публичный health | `curl -fsS https://81-26-178-75.sslip.io/health` | HTTP 200; ответ ниже |
| Подписка MAX | `bash scripts/monitor.sh` с окружением из `.env` на ВМ | `subscriptions: https://81-26-178-75.sslip.io/webhook`, `OK` |
| Защита endpoint | `POST /webhook` без секрета; `GET /api/state` без подписи | Оба HTTP 401 |
| Мини-приложение снаружи | `curl https://81-26-178-75.sslip.io/` | Ссылки на те же JS/CSS, что в локальной сборке |
| Данные после запуска | SQL count в рабочей БД | 25 sessions / 23 outbox |

Ответ `/health` после запуска:

```json
{"status":"ok","mode":"demo","queue":{"pending":0,"sending":0,"sent":23,"cancelled":0,"failed":0},"commit":"176144338ee4662d184368833c74de76c544bb90"}
```

Сборка использовала кеш; чистая сборка без кеша не замерялась. Для отката на ВМ сохранены
`~/max-bot-before-2026-10-23-77.tgz` (права 600, содержит конфигурацию; не выносить с ВМ),
образ `max-bot-bot:before-2026-10-23-77` и каталог `~/src-before-2026-10-23-77`.
Подписка, режим demo, WEBAPP_BOT, UptimeRobot и Caddy не менялись.

Заголовка `Strict-Transport-Security` в ответе нет: HSTS из шага 6 `docs/deploy.md` (#59)
настраивается в Caddy на ВМ вручную и этой выкаткой не применялся.

Первая попытка проверки восстановления упала на ошибке кавычек в SQL; созданная ею
проверочная БД `restore_check_2410449` удалена, проверка повторена в `restore_check_77b`.
