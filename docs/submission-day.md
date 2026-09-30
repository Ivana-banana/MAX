# День сдачи онлайн-этапа — 30.09.2026

Порядок действий до дедлайна (время по Москве; точное время отправки — от организатора,
`TBD`). Каждый шаг — с проверкой. Не менять порядок: тег ставится последним.

## 0. Что сдаём

- **Код** — тот, что работает на сервере: `8bcb1cd` (поле `commit` в
  `curl -s https://81-26-178-75.sslip.io/health`).
- **30.09 PR #15 и #17 (код к финалу) влиты в `main`** — решение человека; на сервере он не
  выкачен. Поэтому сдаём **ветку `online-submission`**: она начинается с `5ce4885` — последнего
  коммита `main`, у которого код совпадает с выкаченным. Все коммиты дня сдачи (состав команды,
  PDF, протокол прогона) — **в эту ветку**, не в `main`; тег — на её вершину. Проверка:

  ```bash
  git fetch --prune && git diff --stat 8bcb1cd origin/online-submission -- src web Dockerfile compose.yaml package.json package-lock.json
  ```

  Вывод должен быть пустым.
- Работать с веткой: `git worktree add .claude/worktrees/online-submission online-submission`,
  коммит, `git push origin HEAD:online-submission`. Потом те же документы можно перенести в
  `main` через `git cherry-pick`.

## 1. Прогон в MAX — тот, у кого есть аккаунт

По [`max-manual-check.md`](max-manual-check.md): шаги 1–24 и 25–32, **в мобильном MAX и в
web.max.ru**. Дату въезда брать «сегодня минус 22 дня» — тогда напоминание придёт сразу.

- Скриншоты веб-версии обязательны: без них бонус +0,15 под риском. Файлы —
  `images/max-check/web-<шаг>.png`.
- Результат — таблица в конце [`verification-2026-09-28.md`](verification-2026-09-28.md)
  (кто, когда, устройство, commit с `/health`, итог).
- Что-то не так — сразу в чат команды: шаг, что видно вместо ожидаемого. Код не чинить.

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
