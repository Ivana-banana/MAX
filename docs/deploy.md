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
| Мониторинг | внешнего нет (решение 23.09); живость смотреть по `/health` вручную |

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
   git archive origin/main | ssh deploy@<IP> "mkdir -p ~/max-bot && tar -x -C ~/max-bot"
   ```
4. **`.env`** (права 600, в Git не попадает):
   ```
   APP_MODE=demo
   TRANSPORT=max
   BOT_PORT=3000
   MAX_BOT_TOKEN=<токен от организаторов>
   WEBHOOK_SECRET=<openssl rand -hex 32>
   WEBHOOK_URL=https://<домен>/webhook
   ```
   Токен вписывать так, чтобы он не попал в историю команд:
   ```sh
   read -rsp 'Токен MAX: ' T && echo && sed -i "s|^MAX_BOT_TOKEN=.*|MAX_BOT_TOKEN=$T|" ~/max-bot/.env && unset T
   ```
5. **Запуск:** `cd ~/max-bot && docker compose up --build -d --wait`. В логе
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
8. **Прогон** сценария в мобильном и веб-MAX; записать коммит, дату и результат.

## Обновление

```sh
# с машины разработчика, пока нет deploy key
git archive origin/main | ssh deploy@81.26.178.75 "tar -x -C ~/max-bot" && git rev-parse origin/main | ssh deploy@81.26.178.75 "cat > ~/max-bot/DEPLOYED_COMMIT"
# на ВМ
cd ~/max-bot && docker compose up --build -d --wait
```

Подписка и данные переживают пересборку: БД лежит в томе `bot-data`. **Не запускать
`docker compose down -v`** — `-v` удаляет том с профилями пользователей.

## Частые поломки

| Симптом | Причина | Что делать |
|---|---|---|
| Бот получает сообщения, но не отвечает; в `/health` растёт `failed` | нет доверия к Russian Trusted Root CA | образ из этого репозитория подключает `certs/russian_trusted_root_ca.pem` сам; при своём образе задать `NODE_EXTRA_CA_CERTS` |
| Бот молчит, `/health` не открывается | ВМ остановлена (часто — кончился баланс) или упал Caddy | запустить ВМ; `systemctl status caddy`; `docker compose ps` |
| `/health` 200, но сообщения не приходят | подписка снята после 8 ч простоя или кто-то запустил polling | проверить подписку (шаг 7), при пустом списке создать заново |
| `subscribe.js`: `WEBHOOK_URL must be https://…` | переменная не задана в `.env` | добавить `WEBHOOK_URL`; compose передаёт её в контейнер |
