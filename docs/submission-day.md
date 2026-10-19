# День сдачи онлайн-этапа — 30.09.2026

Порядок действий до дедлайна (время по Москве; точное время отправки — от организатора,
`TBD`). Каждый шаг — с проверкой. Не менять порядок: тег ставится последним.

## 0. Что сдаём

- **Код** — тот, что работает на сервере: **`cd5ec9e`** (`main` с PR #15, #17 и D-038…D-043),
  выкачен 30.09 около 14:00 МСК по решению человека — протокол
  [`verification-2026-09-30.md`](verification-2026-09-30.md). Поле `commit` в
  `curl -s https://81-26-178-75.sslip.io/health`.
- **Сдаём `main`**; ветка `online-submission` (код `8bcb1cd`) больше не сдаётся и остаётся
  только как точка отката. Коммиты дня сдачи (PDF, протокол прогона) — в `main` обычным
  порядком `GIT.md`. Тег — на вершину `main`, когда её код совпадает с выкаченным:

  ```bash
  git fetch --prune && git diff --stat cd5ec9e origin/main -- src web Dockerfile compose.yaml package.json package-lock.json
  ```

  Вывод должен быть пустым. **До тега в `main` не вливать изменения кода** — иначе сданный
  commit разойдётся с сервером.

## 1. Прогон в MAX — тот, у кого есть аккаунт

По [`max-manual-check.md`](max-manual-check.md): шаги 1–24, 25–32 и новые функции 33–40, **в
мобильном MAX и в web.max.ru**. Дату въезда — кнопкой «Показать на примере» (или «сегодня минус
22 дня») — тогда напоминание придёт сразу.

- Скриншоты веб-версии обязательны: без них бонус +0,15 под риском. Файлы —
  `images/max-check/web-<шаг>.png`.
- Результат — таблица в конце [`verification-2026-09-30.md`](verification-2026-09-30.md)
  (кто, когда, устройство, commit с `/health`, итог).
- Что-то не так — сразу в чат команды: шаг, что видно вместо ожидаемого. Код не чинить.
  Если сломан основной сценарий (шаги 1–32) — откат на `8bcb1cd` по `docs/deploy.md`, «Откат»,
  и сдача ветки `online-submission` по прежнему порядку (см. историю этого файла).

## 2. Состав команды

`docs/presentation/manifest.json` → `"team"`: строка вида
`"Иван — деплой и материалы; …"`. Без неё на слайде 2 заглушка.

## 3. Пересобрать презентацию

PDF собирается **в Linux** (на Windows zlib сжимает иначе, и побайтовая проверка CI не
совпадёт). Из корня репозитория на машине разработчика, через Docker на ВМ:

```bash
git -c core.autocrlf=false archive HEAD docs/presentation scripts | ssh deploy@81.26.178.75 "rm -rf /tmp/deck && mkdir /tmp/deck && tar -x -C /tmp/deck && docker run --rm -u \$(id -u):\$(id -g) -e HOME=/tmp -v /tmp/deck:/w -w /w python:3.14-slim sh -c 'pip install -q --user -r docs/presentation/requirements.txt && python scripts/build-presentation.py'"
ssh deploy@81.26.178.75 'cat /tmp/deck/docs/presentation/first-90-days.pdf' > docs/presentation/first-90-days.pdf
ssh deploy@81.26.178.75 'cat /tmp/deck/docs/presentation/outline.md; rm -rf /tmp/deck' | tr -d '\r' > docs/presentation/outline.md
```

Всё — в рабочей копии ветки `online-submission`. Сначала закоммитить `manifest.json`, потом
собрать (архив берётся из `HEAD`), потом закоммитить PDF. Проверки: `python scripts/build-presentation.py --check` (в том же контейнере, как выше, с
`--check`) и `npm run demo:export:check` — обе зелёные. Посмотреть слайды 1 и 2 глазами.

## 4. Финальная проверка

- Скилл `submission-checklist` по всем пунктам; при желании — субагент `jury`.
- `curl -s https://81-26-178-75.sslip.io/health` → `status: ok`, `commit` = `8bcb1cd…`.
- CI на вершине `online-submission` зелёный.

## 5. Тег

```bash
git fetch --prune
git diff --stat 8bcb1cd origin/online-submission -- src web Dockerfile compose.yaml package.json package-lock.json  # пусто
git tag -a submit-online origin/online-submission -m "Онлайн-этап: $(git rev-parse --short origin/online-submission), сценарий пройден в MAX <дата>"
git push origin submit-online
```

Хеш тега — в форму сдачи вместе со ссылкой на бота
[max.ru/t149_hakaton_max_bot](https://max.ru/t149_hakaton_max_bot), репозиторием и PDF.

## 6. После сдачи

- **С 30.09 по 14.10 жюри проверяет живого бота — на сервере остаётся сданный код.** Не
  выкатывать PR #15 и другие изменения кода до окончания проверки; держать `/health` живым
  (баланс Yandex Cloud, `monitor.yml`).
- Код к финалу уже в `main` (PR #15, #17); выкатка — после 14.10, с прогоном в MAX (шаги 33–37
  [`max-manual-check.md`](max-manual-check.md)) и перевыгрузкой сцен презентации. До этого
  обновление сервера — только с ветки `online-submission`.
