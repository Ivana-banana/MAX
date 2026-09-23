# Материалы защиты

[Открыть PDF](first-90-days.pdf) — 14 слайдов, 16:9, кликабельные ссылки,
встроенные шрифты с кириллицей. [Содержание](outline.md),
[заметки докладчика](speaker-notes.md), [протокол](verification.md).

Первый слайд — служебный: [бот в MAX](https://max.ru/t149_hakaton_max_bot), публичный
HTTPS, развёрнутый commit и путь проверки (обновлено 23.09.2026). Не заполнены состав
команды и сдаваемый commit (тег `submit-online`); нет записи прогона MAX mobile/web и
интервью. Сцены диалога — вывод локального кода на синтетических данных с часами
24.09.2026, не скриншоты MAX. Нормы остаются draft.

После изменения `src/` (например, слияния PR #3) нужно перевыгрузить сцены
(`npm run demo:export`), обновить `sourceTree` и `checkedCodeCommit` в `manifest.json`
и пересобрать PDF. PDF должен собираться в Linux, как в CI: zlib на Windows сжимает
иначе, и побайтовая проверка там не совпадает.

## Повторить сборку

Из корня обычного полного клона репозитория; Node.js 24+ и Python 3.14 (как в CI).
Python нужен только для материалов, не для работы бота или его Docker-образа.

```sh
npm ci --ignore-scripts
npm run demo:export:check
python3 -m venv .venv
.venv/bin/pip install -r docs/presentation/requirements.txt
.venv/bin/python scripts/build-presentation.py --check
```

Экспорт сам выполняет свежую TypeScript-сборку. Для проверки происхождения нужны
Git-объекты проверенного commit: при shallow clone сначала `git fetch --unshallow`.
Изменения в src должны быть закоммичены до записи материалов. Экспорт проверяет,
что `manifest.checkedCodeCommit:src`, `manifest.sourceTree` и `HEAD:src` совпадают.

`demo-transcript.json` содержит семь сообщений настоящего локального диалога без
идентификаторов сессии и callback-секретов. Экспорт нажимает доступные кнопки,
проверяет одно напоминание, фактическую дату, /stop и удаление. Работа идёт в БД
в памяти; ни сеть MAX, ни база запущенного сервиса не используются.

## Обновить материалы

Текст и вёрстка: `scripts/build-presentation.py`. Версия, команда, адреса, источники:
`manifest.json`. Реплики бота не редактировать в JSON руками.

```sh
npm run demo:export
.venv/bin/python scripts/build-presentation.py
.venv/bin/python scripts/build-presentation.py --check
```

При изменении реализации сначала провести проверки нового кода и зафиксировать
его commit. Затем указать проверенный commit и его `git rev-parse <commit>:src`
в manifest, повторить экспорт и обновить протокол доказательств. Числа на слайде
проверок менять только по реальным результатам, а не вслед за ожиданием.
Сам manifest не превращает коммит в сдаваемую версию: тег сдачи ставится отдельно
после полного репозиторного чек-листа. Сейчас PDF ссылается на проверенный 694abca;
замер 16,45 с сделан на cf6c32e. Их дерево src одинаково.

PDF детерминирован при зафиксированных зависимостях и шрифтах: `--check` сравнивает
байты с пересборкой. Дата PDF metadata установлена ReportLab в фиксированное значение
для воспроизводимости; содержательная дата указана на слайдах и в manifest.
Генератор останавливается при переполнении объявленных текстовых блоков. Это не
заменяет визуальный просмотр всех страниц после изменения вёрстки.

Для просмотра рендера (нужны утилиты Poppler):

```sh
mkdir -p /tmp/max-presentation-preview
pdftoppm -png -scale-to 1280 docs/presentation/first-90-days.pdf /tmp/max-presentation-preview/page
pdftotext -layout docs/presentation/first-90-days.pdf /tmp/max-presentation.txt
pdfinfo docs/presentation/first-90-days.pdf
```

## Зависимости и лицензии

requirements.txt фиксирует ReportLab и все его Python-зависимости. ReportLab —
BSD; Pillow — MIT-CMU; charset-normalizer — MIT. Python-tooling изолирован в
venv, не добавляется в контейнер бота. Точные лицензионные тексты идут в установленных
пакетах. Это сведения из их метаданных, не аудит зависимостей на уязвимости.

В fonts/ находятся неизменённые Noto Sans Regular/Bold и Noto Sans Symbols 2.
Их встроенные метаданные указывают SIL Open Font License 1.1;
полный текст и уведомления об авторах — [fonts/LICENSE](fonts/LICENSE).
Копии исходных TTF нужны для одинакового вывода на разных машинах; PDF содержит
только использованные подмножества. Внешние картинки и логотипы не используются.
