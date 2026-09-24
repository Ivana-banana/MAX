import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRuleSet } from '../dist/data/loadRules.js';
import { readUniversities } from '../dist/data/loadUniversities.js';
import { Store } from '../dist/bot/store.js';
import { Service } from '../dist/bot/service.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const path = fileURLToPath(new URL('../docs/presentation/demo-transcript.json', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../docs/presentation/manifest.json', import.meta.url), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain', '--untracked-files=all', '--', 'src'), '', 'Commit source changes before recording source provenance');
assert.equal(git('rev-parse', `${manifest.checkedCodeCommit}:src`), manifest.sourceTree, 'Checked code does not match the declared source tree');
assert.equal(git('rev-parse', 'HEAD:src'), manifest.sourceTree, 'Update the presentation manifest after source changes');
const rules = parseRuleSet(JSON.parse(readFileSync(new URL('../src/data/rules/ru-student.json', import.meta.url), 'utf8')));
const universities = readUniversities(fileURLToPath(new URL('../src/data/universities', import.meta.url)), 'kfu');
const clock = '2026-09-24T10:00:00+03:00';
const store = new Store(':memory:');
const replies = [];
let last, serial = 0;
const service = new Service(store, { rules: rules.rules, universities, version: rules.version, demo: true }, {
  async send(_user, reply) { last = reply; replies.push(reply); },
}, () => Date.parse(clock));
const scenes = [];
async function input(text, callback = false) {
  service.receive({ id: `presentation-${++serial}`, user: 1, input: { text, callback } });
  await service.flush();
}
async function click(action) {
  // link and clipboard buttons carry no callback action
  const button = last.buttons.flat().find(b => 'action' in b && b.action.endsWith(`|${action}`));
  assert.ok(button, `Expected current screen button: ${action}`);
  await input(button.action, true);
}
function capture(id, title, reply = last) {
  scenes.push({ id, title, text: reply.text, buttons: reply.buttons.map(row => row.map(b => b.text)) });
}
try {
  await input('/start'); capture('language', 'Выбор языка');
  for (const action of ['ru', 'accept', 'yes', 'KZ']) await click(action);
  await input('2026-09-01'); capture('plan', 'Персональный план');
  await click('card:medical-examination');
  await click('doc:medical-examination:passport'); capture('checklist', 'Отметка документа');
  await click('plan'); await click('reminders');
  service.maintain(); await service.flush();
  const reminders = replies.filter(r => r.text.includes('Напоминание:'));
  assert.equal(reminders.length, 1);
  capture('reminder', 'Напоминание за семь дней', reminders[0]);
  await click('card:medical-examination'); await click('done:medical-examination');
  await input('/today'); await click('card:medical-examination');
  capture('renewal', 'Следующий цикл после самоотметки');
  assert.equal(store.get(1).completions['medical-examination'], '2026-09-24');
  assert.ok(last.text.includes('2027-10-24') && last.text.includes('2027-09-24'));
  await input('/stop'); capture('stop', 'Остановка уведомлений');
  assert.equal(store.get(1).reminders, false);
  await input('/delete'); await click('confirm-delete'); capture('delete', 'Удаление профиля');
  assert.equal(store.get(1), null);
  const artifact = {
    schemaVersion: 1,
    sourceTree: git('rev-parse', 'HEAD:src'),
    ruleVersion: rules.version, clock,
    disclosure: 'Синтетический профиль KZ, въезд 01.09.2026. Вывод локального кода, не скриншоты MAX. Доставка смоделирована; нормативные правила draft.',
    scenes,
  };
  const serialized = JSON.stringify(artifact, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    // A Windows checkout with core.autocrlf has CRLF; the committed file and the export use LF.
    assert.equal(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'), serialized, 'Demo transcript is stale; run npm run demo:export');
    console.log('Demo transcript matches the code; one reminder, completion, stop and deletion verified.');
  } else {
    writeFileSync(path, serialized);
    console.log('Exported 7 scenes from local code; MAX transport is mocked.');
  }
} finally { store.close(); }
