"""Build a deterministic, editable PDF deck from repository evidence."""
from __future__ import annotations
import argparse
from html import escape
from io import BytesIO
import json
import os
from pathlib import Path
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Paragraph

ROOT = Path(__file__).resolve().parents[1]
# ReportLab names an embedded image by a hash of its path: a relative path keeps the PDF byte-identical across checkouts.
os.chdir(ROOT)
ASSETS = ROOT / 'docs/presentation'
M = json.loads((ASSETS / 'manifest.json').read_text(encoding='utf-8'))
DEMO = json.loads((ASSETS / 'demo-transcript.json').read_text(encoding='utf-8'))
assert M['sourceTree'] == DEMO['sourceTree'], 'Update the deck evidence after code changes'
for name, filename in [('Body', 'NotoSans-Regular.ttf'), ('Bold', 'NotoSans-Bold.ttf'), ('Symbols', 'NotoSansSymbols2-Regular.ttf')]:
    pdfmetrics.registerFont(TTFont(name, str(ASSETS / 'fonts' / filename)))
W, H = 1280, 720
INK, PAPER, MUTED = '#142D38', '#F5F4EE', '#526873'
TEAL, LIME, AMBER, LINE = '#126C65', '#D8EEAF', '#FAE1AC', '#DCE3DF'
WHITE, NIGHT = '#FFFFFF', '#102E38'
stream = BytesIO()
c = canvas.Canvas(stream, pagesize=(W, H), invariant=1, pageCompression=1)
c.setTitle(M['title'] + ' — демо-режим в MAX, материалы защиты')
c.setAuthor('MAX_GOATed_messenger')
c.setSubject('Бот в MAX в демо-режиме; учебные данные; нормы draft')
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
    text('ДЕМО-РЕЖИМ В MAX · НОРМЫ НЕ ВЫЧИТАНЫ ЮРИСТОМ · ' + M['date'], 54, 681, 1100, 11, '#BCD1D3' if dark else MUTED)
    text(f'{page:02}', 1170, 679, 60, 13, LIME if dark else TEAL, True)
    outline.append((page, section, title, subtitle))

def shot(name, x, y, w, h):
    # Screenshot from real MAX (docs/presentation/screens), fitted to the box and anchored to its top.
    path = (ASSETS / 'screens' / f'{name}.jpg').relative_to(ROOT)
    iw, ih = ImageReader(str(path)).getSize()
    scale = min(w / iw, h / ih)
    dw, dh = iw * scale, ih * scale
    rect(x - 4, y - 4, dw + 8, dh + 8, NIGHT, 10)
    c.drawImage(str(path), x, H - y - dh, dw, dh)

def phones(items):
    for i, (name, label, body) in enumerate(items):
        x = 54 + i * 400
        shot(name, x + 4, 216, 196, 404)
        text(label, x + 222, 220, 160, 15, TEAL, True)
        text(body, x + 222, 252, 160, 17, MUTED, max_h=360)

def arrow(x1, y1, x2, y2, color=MUTED, both=False, width=2):
    """Straight arrow in top-left coordinates; head at (x2, y2), optionally at both ends."""
    from math import atan2, cos, sin
    c.setStrokeColor(HexColor(color)); c.setFillColor(HexColor(color)); c.setLineWidth(width)
    c.line(x1, H-y1, x2, H-y2)
    ends = [(x1, y1, x2, y2)] + ([(x2, y2, x1, y1)] if both else [])
    for ax, ay, bx, by in ends:
        a = atan2(-(by - ay), bx - ax)
        p = c.beginPath()
        p.moveTo(bx, H-by)
        for d in (2.7, -2.7):
            p.lineTo(bx - 11*cos(a + d/6), H-by - 11*sin(a + d/6))
        p.close()
        c.drawPath(p, stroke=0, fill=1)

def node(x, y, w, h, title, body, color=WHITE):
    rect(x, y, w, h, color, 12)
    text(title, x+16, y+14, w-32, 17, INK, True, max_h=26)
    text(body, x+16, y+42, w-32, 14, MUTED, max_h=h-50)

def card(x, y, w, h, number, title, body, color=WHITE, body_size=21):
    rect(x, y, w, h, color)
    text(number, x+24, y+20, w-48, 15, TEAL, True)
    th = text(title, x+24, y+54, w-48, 25, INK, True, 90)
    text(body, x+24, y+68+th, w-48, body_size, MUTED, max_h=h-88-th)

# The first slide is intentionally a technical access sheet, per the track brief.
start('служебный слайд', 'Проверка и доступ', 'Бот работает в MAX в демо-режиме: учебные данные, нормы ещё не вычитаны юристом.')
rect(54, 212, 564, 268, WHITE)
text('БОТ В MAX', 78, 233, 510, 15, TEAL, True)
link(M['botUrl'].removeprefix('https://'), M['botUrl'], 78, 267, 510, 24)
text('Учётки, токены и ключи не нужны: бот уже запущен, откройте его в мобильном или веб-MAX.', 78, 309, 510, 16, MUTED, max_h=44)
link('HTTPS: ' + M['publicBaseUrl'].removeprefix('https://') + '/health', M['publicBaseUrl'] + '/health', 78, 363, 510, 16)
text('APP_MODE=demo · TRANSPORT=max', 78, 392, 510, 15, MUTED, max_h=22)
text('Путь: /start · Казахстан · въезд = сегодня минус 22 дня · включить напоминания. Приложение — кнопка у поля ввода', 78, 422, 510, 15, INK, True, max_h=44)
rect(638, 212, 588, 268, WHITE)
text('ВЕРСИЯ И ИСХОДНИКИ', 662, 233, 530, 15, TEAL, True)
link('github.com/M1hairu/MAX_GOATed_messenger', M['repository'], 662, 267, 530, 19)
text('Проверенный код: ' + M['checkedCodeCommit'][:12] + '\nСдаваемый commit — тег submit-online', 662, 303, 530, 16, max_h=48)
link('Протокол прогона в MAX 27.09', M['sources'][7]['url'], 662, 363, 530, 17)
link('Успешный GitHub Actions', M['ciUrl'], 662, 392, 530, 17)
text('Локально: WEBHOOK_SECRET=local-demo-only-not-for-deployment, MAX_BOT_TOKEN пуст', 662, 426, 530, 14, MUTED, max_h=44)  # secret-scan: allow — public local demo value from .env.example
rect(54, 501, 1172, 139, LIME)
text('docker compose up --build -d', 78, 518, 1116, 21, INK, True)
text('docker compose run --rm bot node dist/demo.js --script', 78, 554, 1116, 18)
text('Локальный прогон без MAX: язык · условия · KZ · 01.09.2026 · план · чек-лист · напоминание · /stop', 78, 599, 1116, 17)

start('идея и команда', 'Первые 90 дней', 'План обязательных процедур для иностранного первокурсника.', dark=True)
text('Понять шаг.\nПодготовиться.\nНе потерять срок.', 54, 234, 660, 56, WHITE, True, 250)
text('Проблема: памятки КФУ расходятся по срокам процедур.\nРешение: личный план, комплект и напоминания.\nМасштаб: 422 тыс. иностранных студентов в России (TAdviser).\nMAX: мобильный чат и приложение. Эффект не измерен.', 58, 486, 708, 18, '#BCD1D3', max_h=120)
rect(800, 218, 426, 383, LIME)
text('ПИЛОТНЫЙ СЕГМЕНТ', 826, 243, 372, 15, TEAL, True)
text('Первый въезд\nУчёба > 90 дней\nОбщежитие КФУ', 826, 287, 370, 29, INK, True, 140)
text('18+, въезд с 01.09.2026, без РВП/РВПО/ВНЖ и ранее пройденных процедур.\nКФУ — кандидат, не партнёр.', 826, 431, 370, 19, INK, max_h=147)
text('Проект MAX_GOATed_messenger · команда: ' + (M['team'] or 'состав заполнить перед сдачей'), 58, 614, 1130, 16, '#BCD1D3')

start('проблема', 'Сроки изменились, памятки расходятся', 'Первокурсник КФУ в первые 30 дней после въезда не знает своего срока медосвидетельствования: памятки расходятся — и рискует нарушить режим пребывания. Частота ошибок не измерена.')
card(54, 222, 377, 263, '[5] ЗАКОН С 01.09.2026', 'Два разных срока', 'Медосвидетельствование — 30 дней со дня въезда, дактилоскопия — 90. Сроки изменил 162-ФЗ к заезду первокурсников.', body_size=19)
card(451, 222, 377, 263, '[1] И [2] · КФУ', 'Вуз противоречит себе', 'Памятка общежития: 90 дней на обе процедуры. Страница процедур: 30 и 90 — как в законе.', body_size=19)
card(848, 222, 378, 263, '[7] · ИТМО', '«30 дней на всё»', 'Международный офис даёт 30 дней и на дактилоскопию, и на медосвидетельствование.', body_size=19)
rect(54, 510, 1172, 126, AMBER)
text('Цена ошибки', 78, 530, 300, 24, INK, True)
text('Пропущенный срок — нарушение режима пребывания: сокращение срока пребывания и риск попасть в реестр контролируемых лиц (ФЗ-115, ст. 31.2) [5, 7]. Размер штрафа — вопрос юристу.', 330, 530, 870, 19, INK, max_h=90)

start('путь студента', 'Где продукт меняет путь студента', 'Пять точек пути, где студент сегодня решает сам; эффект меряем метриками слайда «Проверка ценности».')
rect(54, 212, 1172, 428, WHITE)
text('ЭТАП', 78, 230, 220, 14, TEAL, True)
text('БЫЛО', 318, 230, 420, 14, TEAL, True)
text('СТАЛО', 758, 230, 444, 14, TEAL, True)
for i, (stage, before, after) in enumerate([
    ('Найти свой срок', 'Памятки расходятся; «30 или 90 дней?» решает сам', 'Дата каждой процедуры от даты въезда — с нормой и датой сверки'),
    ('Подготовиться', 'Список документов в голове; возврат за недостающим', 'Чек-лист к каждой процедуре с источником и отметками'),
    ('Пройти в срок', 'Про сроки надо помнить самому', 'Напоминания за 7, 3 и 1 день и после срока; файл для календаря'),
    ('Если не получилось', 'Непонятно, кому и что написать', 'Готовый вопрос вузу с процедурой и сроком — одной кнопкой'),
    ('Через год', 'Про повтор медосвидетельствования не напоминает никто', 'Новый срок ставится при отметке «пройдено»')]):
    y = 262 + i * 74
    if i: line(78, y - 12, 1202, y - 12)
    text(stage, 78, y, 220, 18, INK, True, max_h=50)
    text(before, 318, y, 420, 17, MUTED, max_h=66)
    text(after, 758, y, 444, 17, INK, max_h=66)

start('сценарий', 'Один путь до следующего действия', 'Четыре языка интерфейса: русский, English, узбекский и китайский (uz и zh — машинный перевод).')
for x, n, title, body in [
    (54, '01', 'Уточнить контекст', 'Границы пилота, гражданство и дата въезда. Неподходящий случай — контакт вуза.'),
    (352, '02', 'Подготовиться', 'Даты двух процедур, карточка, источник и чек-лист документов.'),
    (650, '03', 'Получить напоминание', 'За 7, 3 и 1 день. Включение добровольное; /stop отменяет ожидающие задания.'),
    (948, '04', 'Отметить результат', 'Фактическая дата со слов пользователя. При затруднении — заготовка вопроса сотруднику.')]:
    card(x, 225, 278, 332, n, title, body, body_size=19)
text('Возможности MAX в сценарии: мини-приложение с той же сессией, сроки файлом .ics в календарь, кнопка «Скопировать вопрос» для вуза, диплинк и QR-плакат вуза, подсказки команд.', 56, 580, 1165, 20, MUTED, max_h=58)

start('демонстрация / 1', 'Чат в MAX: от анкеты до плана', 'Скриншоты из MAX на Android, 25.09.2026, выкаченная версия · учебный профиль KZ · въезд 01.09.2026.')
phones([
    ('chat-consent', 'СОГЛАСИЕ', 'Что хранится и сколько; /delete удаляет профиль. Языки: русский, English, узбекский, китайский.'),
    ('chat-date-error', 'ОШИБКА ВВОДА', 'Неверная дата не сбрасывает шаг: бот повторяет формат и допустимый период.'),
    ('chat-plan', 'ПЛАН', 'Две процедуры, даты словами и дни до срока. Первая кнопка — напоминания, дальше карточки, календарь и помощь.')])

start('демонстрация / 2', 'Мини-приложение: план, документы, вопрос вузу', 'Открывается кнопкой MAX слева от поля ввода; кнопка под планом — опция WEBAPP_BOT. Сессия общая. Скриншоты MAX, 27.09.2026.')
phones([
    ('app-card', 'КАРТОЧКА', 'Срок с пометкой «норма не вычитана юристом», чек-лист документов и основание — ФЗ-115, ст. 5.'),
    ('app-question', 'ВОПРОС ВУЗУ', 'При затруднении — готовый текст с процедурой, сроком, гражданством и датой въезда. Отправляет студент сам.'),
    ('app-ics', 'КАЛЕНДАРЬ', 'План целиком и сроки файлом .ics: MAX сохраняет его на устройство (downloadFile).')])

start('возможности max', 'Возможности MAX в основном сценарии', 'Главное — путь «не успеваю к сроку»: сроки файлом .ics и готовый вопрос вузу, скриншоты из MAX — на слайде 7.')
rect(54, 212, 1172, 428, WHITE)
text('ВОЗМОЖНОСТЬ MAX', 78, 230, 330, 14, TEAL, True)
text('ГДЕ В СЦЕНАРИИ', 428, 230, 300, 14, TEAL, True)
text('ЗАЧЕМ СТУДЕНТУ', 748, 230, 454, 14, TEAL, True)
for i, (feature, where, why) in enumerate([
    ('Файл через загрузку MAX (.ics)', '«Добавить сроки в календарь»', 'Напоминания календаря работают, даже если бот замьючен'),
    ('Кнопки «скопировать» и «ссылка»', '«Не получилось», карточка', 'Вопрос вузу и текст закона — в одно касание'),
    ('Диплинк ?start=<вуз> и QR-плакат', 'Первый экран', 'Сразу сценарий, контакты и вопрос своего вуза'),
    ('Язык клиента (user_locale)', 'Первый экран', 'Бот сразу на русском, английском, узбекском или китайском'),
    ('Подсказки команд', 'Поле ввода, «/»', '/plan, /stop, /delete видны без инструкции'),
    ('Мини-приложение и MAX Bridge', 'Кнопка у поля ввода', 'План целиком в той же сессии; «Назад» и скачивание файла')]):
    y = 258 + i * 64
    if i: line(78, y - 10, 1202, y - 10)
    text(feature, 78, y, 330, 17, INK, True, max_h=48)
    text(where, 428, y, 300, 17, MUTED, max_h=48)
    text(why, 748, y, 454, 17, INK, max_h=48)

start('альтернативы', 'Что уже есть и чего в нём не хватает', 'Отличие — личный отсчёт от даты въезда; востребованность ещё проверяем на пользователях.')
rect(54, 216, 748, 420, WHITE)
text('ЧТО УЖЕ ЕСТЬ · ЧЕГО НЕ ХВАТАЕТ', 78, 236, 700, 15, TEAL, True)
for y, name, gap in [
    (276, 'Памятки вузов [1, 2, 7]', 'одни на всех и расходятся по срокам; дату не считают и не напоминают'),
    (366, 'Бот КФУ, публикация 2021 [3]', 'статусы документов; работает ли сегодня и что покрывает — не проверено'),
    (456, 'HSE App X, ВШЭ, 2025 [4]', 'документы, статусы и напоминания — базовый набор не уникален; внутри одного вуза')]:
    text(name, 78, y, 700, 19, INK, True)
    text(gap, 78, y + 30, 700, 17, MUTED, max_h=50)
text('Госуслуги, «Амина», RuID и «РосМигрант» закрывают учёт, СНИЛС и инструкции, но не сроки обязанностей студента (обзор — docs/product/problem.md).', 78, 552, 700, 15, MUTED, max_h=66)
rect(822, 216, 404, 420, LIME)
text('ЧЕМ ОТЛИЧАЕМСЯ', 846, 236, 356, 15, TEAL, True)
text('• Своя дата каждой процедуры от даты въезда — по норме с датой сверки [5]\n• Повтор медосвидетельствования через год\n• Комплект документов к каждой процедуре\n• Напоминания и файл для календаря\n• Готовый вопрос вузу\n• Четыре языка, в MAX без установки', 846, 272, 356, 17, INK, max_h=350)

start('архитектура', 'Состояние и ответ сохраняются вместе', 'Один Node.js-процесс · PostgreSQL 16 · официальный SDK MAX 0.3.1 · мини-приложение на React. [6, 8]')
node(54, 262, 190, 104, 'Студент', 'MAX: мобильная и веб-версия')
node(294, 262, 190, 104, 'Платформа MAX', 'webhook, SDK, загрузка файлов')
node(534, 262, 170, 104, 'Caddy', 'HTTPS :443, Let\'s Encrypt')
rect(754, 216, 472, 206, WHITE, 12)
text('Node.js-процесс · Docker на ВМ', 770, 230, 440, 17, INK, True)
for i, (name, what) in enumerate([
    ('/webhook', 'секрет, дедупликация, ответ после COMMIT'),
    ('/api', 'мини-приложение, подпись initData'),
    ('очередь', 'ответы и напоминания, повтор до 8 раз')]):
    y = 266 + i * 50
    rect(770, y, 440, 42, PAPER, 8)
    text(name, 784, y + 11, 110, 15, TEAL, True)
    text(what, 890, y + 12, 310, 14, INK, max_h=22)
node(754, 440, 226, 90, 'PostgreSQL 16', 'профили, события, очередь')
node(1000, 440, 226, 90, 'Данные в JSON', 'нормы, вузы, тексты 4 языков')
arrow(244, 314, 294, 314, both=True)
arrow(484, 314, 534, 314, both=True)
arrow(704, 314, 754, 314, both=True)
arrow(867, 422, 867, 440, both=True)
arrow(1113, 440, 1113, 422)
text('сообщения и кнопки', 54, 380, 430, 13, MUTED)
text('webhook внутрь, ответы через SDK наружу', 294, 380, 420, 13, MUTED)
rect(54, 547, 1172, 96, LIME)
text('Границы', 78, 568, 360, 24, INK, True)
text('APP_MODE=live запрещает draft-нормы; сейчас — демо-режим.\nПодключений к МВД, Госуслугам и ИС КФУ нет: отметки — со слов студента.', 453, 566, 741, 19, INK, max_h=65)

start('доказательства', 'Работоспособность проверена', 'Это инженерные результаты, не измеренный эффект для студентов. [8]', dark=True)
for x, value, label in [(54, '359', 'автотестов; один — при наличии rsvg и zbarimg'), (451, '63 с', 'Docker build без кеша · cd5ec9e на ВМ'), (848, '2 / 2', 'версии MAX: мобильная (скриншоты), веб (со слов)')]:
    rect(x, 231, 378, 174, '#1E424D')
    text(value, x+24, 253, 328, 56, LIME, True)
    text(label, x+24, 339, 328, 20, WHITE)
text('Проверено', 58, 444, 520, 27, WHITE, True)
text('Повтор webhook, неверный ввод и чужие кнопки;\nочередь после перезапуска, подпись мини-приложения;\nотмена уведомлений и удаление профиля.', 58, 490, 686, 23, '#BCD1D3', max_h=134)
text('Границы проверки', 838, 444, 370, 27, WHITE, True)
text('Прогон в MAX 25–27.09 записан в протоколе со скриншотами. Эффект для студентов не измерен.', 838, 491, 371, 21, '#BCD1D3', max_h=127)

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
card(54, 220, 565, 266, 'УЖЕ ОТДЕЛЕНО', 'Расчётное ядро и правила', 'Формулы — в ядре; нормы, профили вузов и тексты на 4 языках — в JSON. Новый вуз — файл профиля и QR-плакат без правок кода. Перенос пока не проверен.', body_size=21)
card(639, 220, 587, 266, 'ПРОВЕРКА ПЕРЕНОСА', 'Люди и измеримый результат', 'Нужны владелец данных, проверяющий и переводчик. Записать часы адаптации и изменённые файлы; пройти контрольные профили.', body_size=21)
rect(54, 519, 1172, 122, LIME)
text('Кто платит', 78, 539, 362, 24, INK, True, 71)
text('Гипотеза: международное подразделение вуза — меньше повторных вопросов и просроченных сроков. Студенту бесплатно. Узкое место — сопровождение данных; готовность платить не исследована.', 464, 539, 729, 19, INK, max_h=87)

start('масштабирование', 'Как тиражировать сценарий', 'Измерено: второй вуз (ИТМО) — один JSON на 8 строк, без правок кода. Перенос в другой регион и категорию ещё не проверен.')
rect(54, 216, 565, 164, WHITE)
text('ЯДРО · БЕЗ ПРАВОК ПРИ ПЕРЕНОСЕ', 78, 234, 510, 15, TEAL, True)
text('src/core/deadlines.ts — расчёт сроков\nsrc/bot/ — диалог и напоминания', 78, 270, 510, 18, INK, max_h=91)
rect(639, 216, 587, 164, WHITE)
text('ПЕРЕМЕННАЯ ЧАСТЬ · ФАЙЛЫ ДАННЫХ', 663, 234, 535, 15, TEAL, True)
text('src/data/rules/ru-student.json — нормы\nsrc/data/universities/itmo.json — вуз\nsrc/data/i18n/ru.json — тексты\nНовый вуз — один JSON, код не меняется (ИТМО; тест university)', 663, 262, 535, 16, INK, max_h=112)
rect(54, 400, 748, 242, WHITE)
text('ЭТАП / УСЛОВИЕ ПЕРЕХОДА', 78, 417, 700, 16, TEAL, True)
for y, item in [
    (450, '1  КФУ: инструкция подтверждена; студенты проходят подготовку; известны исключения.'),
    (480, '2  КНИТУ-КАИ: новый вуз добавлен данными, без релиза кода.'),
    (510, '3  Другой регион (ТГУ, Томск): местные источники, ответственный.'),
    (540, '4  Новый язык: перевод прошёл проверку при запуске.'),
    (570, '5  Новая категория: нормы вычитаны юристом.'),
    (600, '6  Другой процесс: ядро не менялось на этапах 1–5.')]:
    text(item, 78, y, 700, 15, INK, max_h=38)
rect(822, 400, 404, 242, LIME)
text('РЕСУРСЫ НА ВУЗ', 846, 417, 356, 16, TEAL, True)
text('Владелец данных, юрист, переводчик, поддержка и канал привлечения.', 846, 447, 356, 16, INK, max_h=65)
text('РИСКИ', 846, 523, 356, 16, TEAL, True)
text('Нормы устаревают.\nБез сверки данные протухают.\nБез партнёра нет канала привлечения.', 846, 551, 356, 15, INK, max_h=85)

start('следующая веха', 'Что требуется для настоящего запуска', 'Бот уже в MAX в демо-режиме. До реальных пользователей — три шага.')
for x, n, title, body in [
    (54, '01 · НОРМЫ', 'Независимая вычитка', 'Применимость, сроки, комплект и место. До этого — только явно обозначенный учебный показ.'),
    (451, '02 · ПЛАТФОРМА', 'Прогон и мониторинг', 'Прогон MAX записан 27.09. GitHub Actions: /health по расписанию 15 минут (фактически реже); подписка — только с MAX_BOT_TOKEN.'),
    (848, '03 · ПОЛЬЗОВАТЕЛИ', 'Проверка барьера', 'Сотрудник и студенты; наблюдение обычного пути; решение о пилоте по заранее заданным порогам.')]:
    card(x, 229, 378, 306, n, title, body, body_size=21)
text('При сдаче версия помечается тегом submit-online; PDF пересобирается из исходников этого коммита.', 57, 575, 1160, 24, MUTED, max_h=69)

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
    (ASSETS / 'outline.md').write_text('# Содержание презентации\n\n' + '\n\n'.join(f'{n}. **{title}** ({section})\n\n   {subtitle}' for n, section, title, subtitle in outline) + '\n', encoding='utf-8')
    print(f'Built {output.relative_to(ROOT)}: {page} pages, {len(result)} bytes; text fits all declared boxes.')
