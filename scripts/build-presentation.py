"""Build a deterministic, editable PDF deck from repository evidence."""
from __future__ import annotations
import argparse
from html import escape
from io import BytesIO
import json
from pathlib import Path
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'docs/presentation'
M = json.loads((ASSETS / 'manifest.json').read_text())
DEMO = json.loads((ASSETS / 'demo-transcript.json').read_text())
assert M['sourceTree'] == DEMO['sourceTree'], 'Update the deck evidence after code changes'
SCENES = {s['id']: s for s in DEMO['scenes']}
for name, filename in [('Body', 'NotoSans-Regular.ttf'), ('Bold', 'NotoSans-Bold.ttf'), ('Symbols', 'NotoSansSymbols2-Regular.ttf')]:
    pdfmetrics.registerFont(TTFont(name, str(ASSETS / 'fonts' / filename)))
W, H = 1280, 720
INK, PAPER, MUTED = '#142D38', '#F5F4EE', '#526873'
TEAL, LIME, AMBER, LINE = '#126C65', '#D8EEAF', '#FAE1AC', '#DCE3DF'
WHITE, NIGHT = '#FFFFFF', '#102E38'
stream = BytesIO()
c = canvas.Canvas(stream, pagesize=(W, H), invariant=1, pageCompression=1)
c.setTitle(M['title'] + ' — локальный прототип, черновик защиты')
c.setAuthor('MAX_GOATed_messenger')
c.setSubject('Синтетические данные; доставка MAX смоделирована; нормы draft')
page = 0
outline = []

def rect(x, y, w, h, color, radius=16):
    assert x >= 0 and y >= 0 and x + w <= W and y + h <= H
    c.setFillColor(HexColor(color))
    c.roundRect(x, H-y-h, w, h, radius, stroke=0, fill=1)

def text(value, x, y, w, size=22, color=INK, bold=False, max_h=None):
    safe = escape(str(value)).replace('\n', '<br/>')
    for char in '✓□':
        safe = safe.replace(char, f'<font name="Symbols">{char}</font>')
    style = ParagraphStyle('text', fontName='Bold' if bold else 'Body', fontSize=size,
        leading=size*1.32, textColor=HexColor(color), splitLongWords=True)
    p = Paragraph(safe, style)
    _, h = p.wrap(w, H)
    assert x >= 0 and x + w <= W and y + h <= H-12, f'Page {page}: text outside page: {value}'
    assert max_h is None or h <= max_h, f'Page {page}: text overflows box ({h}>{max_h}): {value}'
    p.drawOn(c, x, H-y-h)
    return h

def link(label, url, x, y, w, size=16, color=TEAL):
    h = text(label, x, y, w, size, color)
    c.linkURL(url, (x, H-y-h, x+w, H-y), relative=0, thickness=0)
    return h

def line(x1, y1, x2, y2, color=LINE, width=2):
    c.setStrokeColor(HexColor(color)); c.setLineWidth(width)
    c.line(x1, H-y1, x2, H-y2)

def start(section, title, subtitle='', dark=False):
    global page
    if page: c.showPage()
    page += 1
    bg, fg = (NIGHT, WHITE) if dark else (PAPER, INK)
    rect(0, 0, W, H, bg, 0)
    text(f'ПЕРВЫЕ 90 ДНЕЙ  /  {section.upper()}', 54, 28, 1100, 12, LIME if dark else TEAL, True)
    text(title, 54, 78, 1172, 41, fg, True, 110)
    if subtitle: text(subtitle, 56, 147, 1168, 20, '#BCD1D3' if dark else MUTED, max_h=59)
    line(54, 664, 1226, 664, '#31515A' if dark else LINE, 1)
    text('ЧЕРНОВИК ЗАЩИТЫ · ЛОКАЛЬНЫЙ ПРОТОТИП · ' + M['date'], 54, 681, 1100, 11, '#BCD1D3' if dark else MUTED)
    text(f'{page:02}', 1170, 679, 60, 13, LIME if dark else TEAL, True)
    outline.append((page, section, title, subtitle))

def card(x, y, w, h, number, title, body, color=WHITE, body_size=21):
    rect(x, y, w, h, color)
    text(number, x+24, y+20, w-48, 15, TEAL, True)
    th = text(title, x+24, y+54, w-48, 25, INK, True, 90)
    text(body, x+24, y+68+th, w-48, body_size, MUTED, max_h=h-88-th)

# The first slide is intentionally a technical access sheet, per the track brief.
start('служебный слайд', 'Проверка и доступ', 'Локальное демо воспроизводится. Поля внешнего запуска ещё не заполнены.')
rect(54, 212, 564, 268, WHITE)
text('ВЕРСИЯ И ИСХОДНИКИ', 78, 233, 510, 15, TEAL, True)
link('github.com/M1hairu/MAX_GOATed_messenger', M['repository'], 78, 271, 510, 19)
text('Проверенный код: ' + M['checkedCodeCommit'], 78, 313, 510, 16, max_h=54)
link('Протокол локальных проверок', M['sources'][7]['url'], 78, 369, 510, 17)
link('Успешный GitHub Actions', M['ciUrl'], 78, 398, 510, 17)
text('Одинаковый src: 694abca и cf6c32e.\nСдаваемая версия и команда: TBD.', 78, 431, 510, 15, MUTED)
rect(638, 212, 588, 268, WHITE)
text('MAX И ПАРАМЕТРЫ', 662, 233, 530, 15, TEAL, True)
text('MAX: ' + (M['botUrl'] or 'TBD') + ' · HTTPS: ' + (M['publicBaseUrl'] or 'TBD') + '\nУчётки не нужны: учебный профиль.\nAPP_MODE=demo · TRANSPORT=console\nMAX_BOT_TOKEN пуст; внешних ключей нет.', 662, 271, 530, 18, max_h=110)
text('Локальный API: http://127.0.0.1:3000', 662, 380, 530, 16)
text('WEBHOOK_SECRET (только local demo):', 662, 416, 530, 14, MUTED)
text('local-demo-only-not-for-deployment', 662, 441, 530, 15)
rect(54, 501, 1172, 139, LIME)
text('docker compose up --build -d', 78, 518, 1116, 21, INK, True)
text('docker compose run --rm --no-deps bot node dist/demo.js --script', 78, 554, 1116, 18)
text('Путь: /start · язык · условия · KZ · 01.09.2026 · план · чек-лист · напоминание · /stop', 78, 599, 1116, 17)

start('идея и команда', 'Первые 90 дней', 'План обязательных процедур для иностранного первокурсника.', dark=True)
text('Понять шаг.\nПодготовиться.\nНе потерять срок.', 54, 234, 660, 56, WHITE, True, 250)
text('От анкеты до напоминания и вопроса сотруднику —\nв коротком диалоге.', 58, 497, 666, 25, '#BCD1D3', max_h=90)
rect(800, 218, 426, 383, LIME)
text('ПИЛОТНЫЙ СЕГМЕНТ', 826, 243, 372, 15, TEAL, True)
text('Первый въезд\nУчёба > 90 дней\nОбщежитие КФУ', 826, 287, 370, 29, INK, True, 140)
text('18+, въезд с 01.09.2026, без РВП/РВПО/ВНЖ и ранее пройденных процедур.\nКФУ — кандидат, не партнёр.', 826, 431, 370, 19, INK, max_h=147)
text('Проект MAX_GOATed_messenger · команда: ' + (M['team'] or 'состав заполнить перед сдачей'), 58, 614, 1130, 16, '#BCD1D3')

start('проблема', 'Найти памятку ещё не значит понять свой путь', 'Наблюдение по опубликованным источникам; влияние на студентов пока не измерено.')
card(54, 222, 565, 263, 'ИСТОЧНИК [1]', 'Памятка о заселении', 'КФУ публикует формулировку о 90 днях для двух процедур. Это содержание страницы, не наша рекомендация.')
card(639, 222, 587, 263, 'ИСТОЧНИК [2]', 'Профильная памятка', 'Другая страница КФУ разделяет медицинскую и дактилоскопическую процедуры: 30 и 90 дней.')
rect(54, 510, 1172, 126, AMBER)
text('Проверяем гипотезу', 78, 530, 300, 24, INK, True)
text('Проверяем, помогает ли маршрут выбрать шаг и собрать комплект.\nПричины срыва и эффект бота ещё предстоит измерить.', 390, 530, 800, 21, INK, max_h=84)

start('сценарий', 'Один путь до следующего действия', 'В локальном прототипе работают обе языковые ветки: русский и English.')
for x, n, title, body in [
    (54, '01', 'Уточнить контекст', 'Границы пилота, гражданство и дата въезда. Неподходящий случай — контакт вуза.'),
    (352, '02', 'Подготовиться', 'Даты двух процедур, карточка, источник и чек-лист документов.'),
    (650, '03', 'Получить напоминание', 'За 7, 3 и 1 день. Включение добровольное; /stop отменяет ожидающие задания.'),
    (948, '04', 'Отметить результат', 'Фактическая дата со слов пользователя. При затруднении — заготовка вопроса сотруднику.')]:
    card(x, 225, 278, 332, n, title, body, body_size=19)
text('«Не получилось» готовит вопрос. Пользователь отправляет его сам; очереди сотрудников пока нет.', 56, 593, 1165, 22, MUTED, max_h=58)

start('демонстрация / 1', 'План берётся из работающего кода', 'Синтетический профиль KZ · въезд 01.09.2026 · учебные часы 24.09.2026.')
rect(54, 218, 736, 424, WHITE)
text('ВЫВОД ЛОКАЛЬНОГО БОТА · НЕ СКРИНШОТ MAX', 78, 239, 686, 14, TEAL, True)
text(SCENES['plan']['text'], 78, 279, 682, 21, max_h=330)
card(814, 218, 412, 224, 'РЕЗУЛЬТАТ', 'Две процедуры', 'Видно, что сделать и к какой расчётной дате. Самоотметка не подтверждает прохождение.', color=LIME, body_size=20)
text('Все правила — draft. Миграционный учёт через вуз оформляется отдельно. Доставка MAX в этом прогоне смоделирована.', 834, 478, 369, 23, MUTED, max_h=155)

start('демонстрация / 2', 'Подготовка связана с напоминанием', 'Точные фрагменты вывода; полные сообщения — в demo-transcript.json.')
rect(54, 218, 565, 425, WHITE)
text('ОТМЕТКА ДОКУМЕНТА', 78, 240, 510, 15, TEAL, True)
checklist = '\n'.join(line for line in SCENES['checklist']['text'].splitlines() if line.startswith(('ДЕМО', 'Расчётный', '✓', '□', 'Сверка')))
text(checklist, 78, 282, 510, 21, max_h=265)
text('В карточке доступны ссылка на норму и контакт КФУ. Отметки документов сохраняются.', 78, 557, 510, 19, MUTED, max_h=72)
rect(639, 218, 587, 174, LIME)
text(SCENES['reminder']['text'], 663, 243, 537, 23, max_h=132)
rect(639, 413, 587, 230, WHITE)
text('ПОСЛЕ САМООТМЕТКИ 24.09.2026', 663, 435, 536, 15, TEAL, True)
renewal = '\n'.join(line for line in SCENES['renewal']['text'].splitlines() if line.startswith(('Расчётный', 'Рекомендуемая')))
text(renewal, 663, 475, 537, 23, max_h=97)
text('Рекомендуемая дата и конец расчётного окна показаны отдельно. Нормы не утверждены.', 663, 571, 537, 18, MUTED, max_h=66)

start('альтернативы', 'Напоминания уже есть у других сервисов', 'Преимущество нашего маршрута — гипотеза, которую ещё предстоит проверить.')
card(54, 224, 377, 332, '[3] КФУ · ПУБЛИКАЦИЯ 2021', 'Бот миграционного учёта', 'Университет сообщал о цифровом канале и статусах документов. Текущее покрытие требует проверки.', body_size=21)
card(451, 224, 377, 332, '[4] ВШЭ · ПУБЛИКАЦИЯ 2025', 'HSE App X', 'Документы, статусы, замечания и автоматические напоминания. Базовый набор функций не уникален.', body_size=21)
card(848, 224, 378, 332, 'НАША ГИПОТЕЗА', 'Подготовка и помощь', 'Проверяем понятность следующего шага и комплекта. Полезность выхода к сотруднику пока не измерена.', color=LIME, body_size=21)
text('Первый шаг исследования — пройти существующий путь пользователя вместе со студентом и сотрудником.', 56, 592, 1140, 23, MUTED, max_h=64)

start('архитектура', 'Состояние и ответ сохраняются вместе', 'Один Node.js-процесс · SQLite · официальный SDK MAX 0.3.1. [6, 8]')
for x, n, title, body in [
    (54, 'ВХОД', 'Webhook', 'Секрет, формат, предел размера; личный диалог. Повтор события не применяет действие заново.'),
    (451, 'ТРАНЗАКЦИЯ', 'SQLite', 'Профиль + отпечаток события + ответ в очереди. Квитанция webhook после сохранения.'),
    (848, 'ВЫХОД', 'Очередь', 'Напоминания и ответы, повторные попытки. В демо — консоль, для MAX подготовлен SDK-транспорт.')]:
    card(x, 227, 378, 296, n, title, body, body_size=21)
rect(54, 547, 1172, 96, LIME)
text('Правила отдельно в JSON', 78, 568, 360, 24, INK, True)
text('Смена версии останавливает старые планы. Live запрещает draft.\nПодключений к МВД, Госуслугам и ИС КФУ нет.', 453, 566, 741, 19, INK, max_h=65)

start('доказательства', 'Локальная работоспособность проверена', 'Это инженерные результаты, не измеренный эффект для студентов. [8]', dark=True)
for x, value, label in [(54, '80', 'автоматических тестов'), (451, '16,45 с', 'Docker build без кеша'), (848, '7', 'сцен вывода из кода')]:
    rect(x, 231, 378, 174, '#1E424D')
    text(value, x+24, 253, 328, 56, LIME, True)
    text(label, x+24, 339, 328, 20, WHITE)
text('Проверено', 58, 444, 520, 27, WHITE, True)
text('Повтор webhook, неверный ввод и чужие кнопки;\nсохранение профиля и 6 заданий после restart;\nотмена уведомлений и удаление профиля.', 58, 490, 686, 23, '#BCD1D3', max_h=134)
text('Границы проверки', 838, 444, 370, 27, WHITE, True)
text('MAX mobile/web не проверены.\nБазовый Docker-образ уже загружен.\nСборка — чистый клон cf6c32e.', 838, 491, 371, 21, '#BCD1D3', max_h=127)

start('данные и надёжность', 'Пользователь управляет своим профилем', 'Сегодня используются только синтетические данные.')
card(54, 225, 565, 307, 'ЧТО СОХРАНЯЕМ', 'Минимум для сценария', 'MAX ID, язык, даты и самоотметки, версия правил и очередь. Паспорта, сканы и медицинские файлы не запрашиваются.', body_size=22)
card(639, 225, 587, 307, 'ЧТО МОЖНО ОСТАНОВИТЬ', '/stop и /delete', 'Уведомления выключаются; профиль и ожидающие сообщения удаляются после подтверждения. В MAX переписка остаётся.', color=LIME, body_size=22)
text('До пилота: определить оператора данных, основание обработки и резервное копирование.\nОдин процесс на БД. Неопределённый сетевой ответ может дать дубль; failed требует оператора.', 57, 563, 1140, 21, MUTED, max_h=81)

start('проверка ценности', 'Сначала измеряем правильность действия', 'Предложенные пороги до эксперимента. Результатов пока нет.')
for x, n, title, body in [
    (54, 'КАЧЕСТВО', '0 критичных ошибок', 'Независимые эталоны применимости, даты и комплекта утверждаются до сессий.'),
    (451, 'САМОСТОЯТЕЛЬНОСТЬ', 'Не менее 80%', 'Участники завершают подготовку без подсказок автора. План: 10–15 наблюдаемых сессий.'),
    (848, 'ВРЕМЯ', 'Медиана ниже на 30%', 'Сравнение с памяткой и обычным каналом помощи. Сложность заданий одинакова, порядок чередуется.')]:
    card(x, 227, 378, 291, n, title, body, body_size=20)
rect(54, 544, 1172, 99, AMBER)
text('Условие продолжения', 78, 565, 340, 23, INK, True)
text('Трудность повторяется; есть участники и проверяющий.\nИнтервью впереди, партнёрство не подтверждено.', 441, 565, 753, 20, INK, max_h=70)

start('развитие', 'Второй контекст — КНИТУ-КАИ', 'Кандидат для проверки переноса, не подтверждённый партнёр. Альтернатива — другой вуз.')
card(54, 220, 565, 266, 'УЖЕ ОТДЕЛЕНО', 'Расчётное ядро и правила', 'Формулы — в ядре; нормы и комплекты — в JSON. Контакты и тексты диалога ещё нужно отделить. Перенос пока не доказан.', body_size=21)
card(639, 220, 587, 266, 'ПРОВЕРКА ПЕРЕНОСА', 'Люди и измеримый результат', 'Нужны владелец данных, проверяющий и переводчик. Записать часы адаптации и изменённые файлы; пройти контрольные профили.', body_size=21)
rect(54, 519, 1172, 122, LIME)
text('Если спрос не подтвердится', 78, 539, 362, 24, INK, True, 71)
text('Проверить другой вуз или переход «соцпомощь назначена — документы переданы на соцстипендию» [7].\nЭто альтернативная гипотеза, а не принятое решение о смене продукта.', 464, 539, 729, 20, INK, max_h=87)

start('следующая веха', 'Что требуется для настоящего запуска', 'PDF и локальный прототип готовят проверку, но сами по себе не закрывают допуск.')
for x, n, title, body in [
    (54, '01 · НОРМЫ', 'Независимая вычитка', 'Применимость, сроки, комплект и место. До этого — только явно обозначенный учебный показ.'),
    (451, '02 · ПЛАТФОРМА', 'Токен и HTTPS', 'Один владелец токена. Прогон mobile/web на фиксированном commit; видео и ссылка на бота.'),
    (848, '03 · ПОЛЬЗОВАТЕЛИ', 'Проверка барьера', 'Сотрудник и студенты; наблюдение обычного пути; решение о пилоте по заранее заданным порогам.')]:
    card(x, 229, 378, 306, n, title, body, body_size=21)
text('Перед сдачей: заполнить служебный слайд, проверить весь сценарий, зафиксировать версию и обновить PDF.', 57, 575, 1160, 24, MUTED, max_h=69)

start('источники', 'Основания и пределы выводов', 'Внешние источники сверены в аудите 22.09.2026. Ссылки в PDF кликабельны.')
for i, source in enumerate(M['sources']):
    col, row = i % 2, i // 2
    x, y = 54 + col*596, 214 + row*108
    link(f"[{source['id']}] {source['title']}", source['url'], x, y, 565, 18)
    text(source['claim'], x, y+39, 565, 15, MUTED, max_h=60)

c.save()
result = stream.getvalue()
parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true', help='Fail if the committed PDF differs from a fresh build')
args = parser.parse_args()
output = ASSETS / 'first-90-days.pdf'
if args.check:
    assert output.read_bytes() == result, 'PDF is stale: run scripts/build-presentation.py'
    print(f'PDF matches its sources: {page} pages, {len(result)} bytes; text fits all declared boxes.')
else:
    output.write_bytes(result)
    (ASSETS / 'outline.md').write_text('# Содержание презентации\n\n' + '\n\n'.join(f'{n}. **{title}** ({section})\n\n   {subtitle}' for n, section, title, subtitle in outline) + '\n')
    print(f'Built {output.relative_to(ROOT)}: {page} pages, {len(result)} bytes; text fits all declared boxes.')
