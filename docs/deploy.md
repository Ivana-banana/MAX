# Развёртывание бота в MAX

Как устроен работающий экземпляр и как повторить развёртывание с нуля. Кто сейчас держит
токен — таблица «Токен бота» в `HANDOFF.md`.

## Текущий экземпляр

| Что | Значение |
|---|---|
| Бот | [max.ru/t149_hakaton_max_bot](https://max.ru/t149_hakaton_max_bot), «Хакатон МАХ 149» |
| Режим | `APP_MODE=demo`, `TRANSPORT=max` — `live` заблокирован, пока нормы в статусе draft |
| Webhook | `https://81-26-178-75.sslip.io/webhook`, подписка на `bot_started`, `message_created`, `message_callback` |
| Проверка живости | https://81-26-178-75.sslip.io/health → `200 {"status":"ok",...}` |
| ВМ | Yandex Cloud, Ubuntu 24.04, 2 vCPU (50%), 4 ГБ, SSD 30 ГБ, не прерываемая, статический IP `81.26.178.75` |
| Доступ | `ssh deploy@81.26.178.75`, вход только по ключу |
| Код | `~/max-bot`, задеплоенный коммит — `~/max-bot/DEPLOYED_COMMIT` |
| Мониторинг | Основной — UptimeRobot, keyword-монитор `/health` раз в 5 минут с письмом команде (D-049; включает человек, см. «Мониторинг»). Второй слой — GitHub Actions [`monitor.yml`](../.github/workflows/monitor.yml) → [`scripts/monitor.sh`](../scripts/monitor.sh): `/health` без `failed` и, при секрете `MAX_BOT_TOKEN`, наличие webhook-подписки (D-032). Сейчас не стартует (#50) |

Имя `81-26-178-75.sslip.io` — бесплатный DNS [sslip.io](https://sslip.io): имя само
указывает на IP, в нём записанный. Поэтому IP должен оставаться статическим.

## Схема

```
MAX ──HTTPS:443──▶ Caddy (Let's Encrypt, автопродление) ──HTTP──▶ 127.0.0.1:3000 ──▶ контейнер bot
                                                                                      │
                     platform-api2.max.ru ◀──HTTPS (Russian Trusted Root CA)──────────┘
```

MAX принимает webhook только по HTTPS на 443 с сертификатом доверенного УЦ. Контейнер
слушает только `127.0.0.1`, наружу его выставляет Caddy.

## Развёртывание с нуля

1. **ВМ.** Ubuntu 24.04, публичный статический IP, входящие 22, 80, 443. Прерываемую ВМ
   не использовать: она останавливается минимум раз в сутки, а после 8 часов без
   доставки MAX снимает подписку.
2. **Docker и Caddy.**
   ```sh
   curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install -y caddy
   ```
3. **Код** в `~/max-bot`. Репозиторий приватный: либо deploy key только на чтение
   (добавляет владелец репозитория в Settings → Deploy keys), либо снимок с машины
   разработчика:
   ```sh
   git archive origin/main | ssh deploy@<IP> "mkdir -p ~/max-bot && tar -x -C ~/max-bot" && git rev-parse origin/main | ssh deploy@<IP> "cat > ~/max-bot/DEPLOYED_COMMIT"
   ```
4. **`.env`** (права 600, в Git не попадает):
   ```
   APP_MODE=demo
   TRANSPORT=max
   BOT_PORT=3000
   MAX_BOT_TOKEN=<токен от организаторов>
   WEBHOOK_SECRET=<openssl rand -hex 32>
   WEBHOOK_URL=https://<домен>/webhook
   POSTGRES_PASSWORD=<openssl rand -hex 24>
   ```
   Пароль PostgreSQL — только буквы и цифры: он же входит в `DATABASE_URL`, который
   Compose собирает для бота. С демо-паролем из `.env.example` бот при `TRANSPORT=max`
   не запускается.
   Токен вписывать так, чтобы он не попал в историю команд:
   ```sh
   read -rsp 'Токен MAX: ' T && echo && sed -i "s|^MAX_BOT_TOKEN=.*|MAX_BOT_TOKEN=$T|" ~/max-bot/.env && unset T
   ```
5. **Запуск:** `cd ~/max-bot && DEPLOYED_COMMIT=$(cat DEPLOYED_COMMIT) docker compose up --build -d --wait`. В логе
   (`docker compose logs --tail=5 bot`) должно быть
   `{"event":"started","mode":"demo","transport":"max",...}`.
6. **HTTPS.** `/etc/caddy/Caddyfile`:
   ```
   <домен> {
       reverse_proxy 127.0.0.1:3000
   }
   ```
   `sudo systemctl reload caddy`. Снаружи: `/health` → 200, `POST /webhook` без секрета → 401.
7. **Подписка** — только после записи в таблицу токена в `HANDOFF.md`:
   ```sh
   docker compose run --rm --no-deps bot node dist/subscribe.js
   ```
   Существующую подписку скрипт не заменяет. Проверить подписку:
   ```sh
   docker compose exec -T bot node -e "fetch('https://platform-api2.max.ru/subscriptions',{headers:{Authorization:process.env.MAX_BOT_TOKEN}}).then(r=>r.json()).then(j=>console.log(j.subscriptions.map(s=>s.url)))"
   ```
8. **Подсказки команд** после «/» — один раз, повторный запуск просто перезаписывает список:
   ```sh
   docker compose run --rm --no-deps bot node dist/commands.js
   ```
   Подписку webhook скрипт не трогает (`PATCH /me/commands`, `D-025`).
9. **Мини-приложение.** URL `https://<домен>/` (Caddy отдаёт весь origin на бота) подаётся
   через форму организаторов. Когда MAX его принял — в `.env` добавить
   `WEBAPP_BOT=<имя бота>` и `DEPLOYED_COMMIT=$(cat DEPLOYED_COMMIT) docker compose up -d --wait`: под планом в чате появится кнопка
   «📱 План в мини-приложении» (`open_app`). Без регистрации переменную не задавать — кнопка
   открывала бы пустоту.
10. **Прогон** сценария в мобильном и веб-MAX; записать коммит, дату и результат.

## Обновление

```sh
# с машины разработчика, пока нет deploy key
# src/ стирается перед распаковкой: tar не удаляет файлы, которых нет в новом коммите,
# а сборка компилирует весь src/ — лишний модуль без своей зависимости её роняет
git archive origin/main | ssh deploy@81.26.178.75 "rm -rf ~/max-bot/src && tar -x -C ~/max-bot" && git rev-parse origin/main | ssh deploy@81.26.178.75 "cat > ~/max-bot/DEPLOYED_COMMIT"
# на ВМ
cd ~/max-bot && DEPLOYED_COMMIT=$(cat DEPLOYED_COMMIT) docker compose up --build -d --wait
curl -s https://81-26-178-75.sslip.io/health
# поле commit должно совпасть с git rev-parse origin/main на машине разработчика
```

Подписка и данные переживают пересборку: БД PostgreSQL лежит в томе `pg-data`, старая
SQLite — в томе `bot-data` (нужна только для импорта). **Не запускать
`docker compose down -v`** — `-v` удаляет тома с профилями пользователей.

## Бэкап PostgreSQL и проверка восстановления

```sh
cd ~/max-bot
docker compose exec -T postgres pg_dump -U bot -Fc bot > ~/backup-$(date +%F).dump
# восстановление проверяется в отдельной БД, рабочая не затрагивается
docker compose exec -T postgres createdb -U bot restore_check
docker compose exec -T postgres pg_restore -U bot -d restore_check < ~/backup-$(date +%F).dump
docker compose exec -T postgres psql -U bot -d restore_check -c "SELECT (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM outbox) AS outbox"
docker compose exec -T postgres dropdb -U bot restore_check
```

Дамп содержит MAX ID и даты пользователей: хранить с правами 600, не выносить с ВМ
без решения об операторе данных (README, «Данные, надёжность и интеграции»).

## Переход с SQLite на PostgreSQL (один раз)

Версия до `D-022` хранила данные в SQLite (`/app/data/bot.sqlite` в томе `bot-data`).
Переход — короткое окно, пока бот остановлен; входящие webhook в это время не
принимаются. **Шаги ниже на ВМ ещё не выполнялись** — первый проход записать в `HANDOFF.md`.
24.09 они отрепетированы локально в Docker: `19f1a7c` (версия на ВМ) и `88b491b` с
данными трёх профилей → `main`: импорт, запуск, сценарий на перенесённых профилях, откат.

1. Записаться в `HANDOFF.md` (кто и когда переключает), сохранить прежний хеш из
   `DEPLOYED_COMMIT` для отката, добавить в `.env` `POSTGRES_PASSWORD` (шаг 4 выше),
   выкатить код без запуска:
   `git archive <коммит> | ssh deploy@81.26.178.75 "rm -rf ~/max-bot/src && tar -x -C ~/max-bot" && git rev-parse <коммит> | ssh deploy@81.26.178.75 "cat > ~/max-bot/DEPLOYED_COMMIT"`.
2. Остановить старого бота и сохранить копию SQLite вместе с WAL-файлами:
   ```sh
   cd ~/max-bot && docker compose stop bot
   docker run --rm -v max-bot_bot-data:/data:ro -v ~/:/backup busybox tar czf /backup/sqlite-before-pg-$(date +%F).tgz -C /data .
   ```
3. Поднять PostgreSQL и собрать образ: `docker compose up -d --wait postgres && docker compose build bot`.
4. Импорт. Он переносит `sessions`, `events`, `outbox` и `funnel` одной транзакцией,
   требует пустые таблицы, сверяет число строк и не печатает содержимое:
   ```sh
   docker compose run --rm bot node dist/db/import-sqlite.js /app/data/bot.sqlite
   # → sessions=N events=N outbox=N funnel=N
   ```
   Числа строк импорт сверяет со снимком SQLite сам; при расхождении он откатывается
   целиком и завершается с кодом 1. Повторный запуск на непустой БД отклоняется.
5. Запуск: `DEPLOYED_COMMIT=$(cat DEPLOYED_COMMIT) docker compose up -d --wait`, `/health` → 200, подписка на месте (шаг 7
   выше), бэкап PostgreSQL по разделу выше.
6. Пройти сценарий в мобильном и веб-MAX на уже существующем профиле. Если с прошлой
   выкатки изменилась `version` в `src/data/rules/ru-student.json` (с `19f1a7c` так и
   есть: `2026-09-23-draft` → `2026-09-24-draft`, `D-016`), старый профиль отвечает «Правила
   изменились. Расчёт остановлен…» — это ожидаемо и заодно доказывает, что профиль
   перенесён (новый начинал бы с выбора языка). Дальше `/delete` → «Да, удалить» →
   `/start` и сценарий до плана и напоминаний. Если версия не менялась, план и отметки
   должны сохраниться.

**Откат:** выкатить прежний коммит (его хеш сохранён до обновления `DEPLOYED_COMMIT`)
командой из раздела «Обновление», заменив оба `origin/main` на сохранённый хеш; оставить
`rm -rf ~/max-bot/src` (без него сборка старой версии падает на новых файлах `src/db/`).
После записи этого хеша в `~/max-bot/DEPLOYED_COMMIT` выполнить
`DEPLOYED_COMMIT=$(cat DEPLOYED_COMMIT) docker compose up --build -d --wait --remove-orphans`: контейнер PostgreSQL удаляется,
том `pg-data` остаётся.
SQLite-том импорт не меняет, но всё, что пользователи сделали после переключения,
останется только в PostgreSQL.

## Мониторинг

Бот должен отвечать весь период проверки, а MAX снимает подписку после 8 ч без доставки.
Поэтому проверка идёт снаружи ВМ. Два слоя (D-049):

| Слой | Что проверяет | Частота | Оповещение | Состояние 19.10.2026 |
|---|---|---|---|---|
| UptimeRobot, keyword-монитор | `GET /health`: код 200 и строка `"failed":0}` в ответе | 5 мин | письмо на адреса команды | **не включён**: нужен аккаунт, это делает человек |
| GitHub Actions `monitor.yml` | `scripts/monitor.sh`: `/health` (`status: ok`, `queue.failed == 0`) и webhook-подписка | cron `*/15`, фактически раз в 3–6 ч | красный запуск, письмо тому, кто менял cron | не стартует: биллинг (#50); без секрета (#21) подписка не проверяется |

Строка `"failed":0}` есть в ответе, только если `/health` ответил 200 (хранилище живо)
и в очереди нет сбойных отправок: счётчик `failed` последний в объекте `queue`
(`src/bot/server.ts`, `store.counts()`). Если порядок полей поменяется, монитор
покраснеет сразу — ложной тишины не будет.

### Включить UptimeRobot (человек, один раз, ~5 мин)

Условия проверены 19.10.2026 на [uptimerobot.com/pricing](https://uptimerobot.com/pricing/)
и [uptimerobot.com/terms](https://uptimerobot.com/terms/): бесплатный план — 50 мониторов,
интервал 5 минут, keyword-монитор входит; коммерческое использование разрешено.

1. Зарегистрироваться на [uptimerobot.com](https://uptimerobot.com) (почта команды).
2. New monitor → тип **Keyword**.
3. URL: `https://81-26-178-75.sslip.io/health`; keyword: `"failed":0}`;
   условие — оповещать, если ключевого слова **нет** (keyword not exists); интервал 5 минут.
4. Alert contacts: почта каждого участника (контакты добавить в Integrations & Team).
5. Сохранить и проверить, что монитор зелёный. Записать в #34, на чей аккаунт он заведён.

Токен бота в UptimeRobot не передаём: подписку он не проверяет. Пропажу подписки
при живом `/health` ловит только второй слой (нужны #50 и #21) или ручная проверка (шаг 7).

### Проверить руками

```bash
bash scripts/monitor.sh                       # только /health, только GET
MAX_BOT_TOKEN=... bash scripts/monitor.sh     # плюс подписка (токен из .env на ВМ)
```

Код 0 — бот жив; 1 — сбой, причина в строке `FAIL:`.

## Частые поломки

| Симптом | Причина | Что делать |
|---|---|---|
| Бот получает сообщения, но не отвечает; в `/health` растёт `failed` | нет доверия к Russian Trusted Root CA | образ из этого репозитория подключает `certs/russian_trusted_root_ca.pem` сам; при своём образе задать `NODE_EXTRA_CA_CERTS` |
| Бот молчит, `/health` не открывается | ВМ остановлена (часто — кончился баланс) или упал Caddy | запустить ВМ; `systemctl status caddy`; `docker compose ps` |
| `/health` 200, но сообщения не приходят | подписка снята после 8 ч простоя или кто-то запустил polling | проверить подписку (шаг 7), при пустом списке создать заново |
| `subscribe.js`: `WEBHOOK_URL must be https://…` | переменная не задана в `.env` | добавить `WEBHOOK_URL`; compose передаёт её в контейнер |
