// Тесты show/set: node --test plugin/scripts/test/status.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlan, checkPlan, setStatus, showItem } from '../tasks.mjs';

const note = (fm, body) => `---\n${fm}\n---\n${body}`;
const TASK = (id, title, status, deps = '[]', log = '') => note(
  `id: ${id}\ntype: task\nstatus: ${status}\npriority: must\nsize: S\nparent: "[[F-01 Фича]]"\ndepends_on: ${deps}\ncreated: 2026-09-27`,
  `# ${id} ${title}\n\n> **Что:** ${title}.\n> **Зачем:** надо.\n> **Готово, когда:** сделано.\n\n## Критерии готовности\n\n- [ ] к\n\n## Журнал\n${log}`);

function plan(eol = '\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  const files = {
    'Epics/E-01 Эпик.md': note('id: E-01\ntype: epic\nstatus: in-progress\npriority: must\ncreated: 2026-09-27', '# E-01 Эпик\n\n> **Что:** э.\n> **Зачем:** э.\n> **Готово, когда:** э.\n\n## Журнал\n'),
    'Features/F-01 Фича.md': note('id: F-01\ntype: feature\nstatus: in-progress\npriority: must\nparent: "[[E-01 Эпик]]"\ncreated: 2026-09-27', '# F-01 Фича\n\n> **Что:** ф.\n> **Зачем:** ф.\n> **Готово, когда:** ф.\n\n## Журнал\n'),
    'Tasks/T-001 Первая.md': TASK('T-001', 'Первая', 'ready', '[]', '\n- **2026-09-27 · qa:** старая запись.\n'),
    'Tasks/T-002 Вторая.md': TASK('T-002', 'Вторая', 'ready', '\n  - "[[T-001 Первая]]"'),
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text.replace(/\n/g, eol));
  }
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('set: статус и запись журнала; доска пересобрана; план валиден', () => {
  const root = plan();
  try {
    const res = setStatus(loadPlan(root), 'T-001', 'in-progress', { log: 'взята в работу.', who: 'qa (Claude)', date: '2026-10-01' });
    assert.equal(res.error, undefined);
    const t = read(root, 'Tasks/T-001 Первая.md');
    assert.match(t, /^status: in-progress$/m);
    assert.ok(t.endsWith('- **2026-09-27 · qa:** старая запись.\n- **2026-10-01 · qa (Claude):** взята в работу.\n'));
    assert.ok(read(root, 'Board.md').includes('## В работе'));
    assert.deepEqual(checkPlan(loadPlan(root)).errors, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('set: первая запись в пустом журнале отделена пустой строкой', () => {
  const root = plan();
  try {
    setStatus(loadPlan(root), 'T-002', 'cancelled', { log: 'не нужна.', date: '2026-10-01' });
    assert.ok(read(root, 'Tasks/T-002 Вторая.md').endsWith('## Журнал\n\n- **2026-10-01 · Claude:** не нужна.\n'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('set: in-progress при открытых зависимостях — только с force', () => {
  const root = plan();
  try {
    const res = setStatus(loadPlan(root), 'T-002', 'in-progress', { log: 'x' });
    assert.equal(res.code, 'open-deps');
    assert.match(read(root, 'Tasks/T-002 Вторая.md'), /^status: ready$/m, 'файл не изменён');
    assert.equal(setStatus(loadPlan(root), 'T-002', 'in-progress', { force: true }).error, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('set done: возвращает разблокированные задачи', () => {
  const root = plan();
  try {
    const res = setStatus(loadPlan(root), 'T-001', 'done', { log: 'готово.' });
    assert.deepEqual(res.unblocked.map((u) => u.id), ['T-002']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('set: недопустимый статус и неизвестная задача', () => {
  const root = plan();
  try {
    assert.match(setStatus(loadPlan(root), 'T-001', 'blocked').error, /недопустим/);
    assert.match(setStatus(loadPlan(root), 'T-404', 'done').error, /не найдена/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('set: CRLF-файл остаётся CRLF', () => {
  const root = plan('\r\n');
  try {
    setStatus(loadPlan(root), 'T-001', 'in-progress', { log: 'взята.' });
    const t = read(root, 'Tasks/T-001 Первая.md');
    assert.ok(!/[^\r]\n/.test(t), 'нет одиночных LF');
    assert.match(t, /status: in-progress\r\n/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('show: карточка с зависимостями и обратными связями', () => {
  const root = plan();
  try {
    const p = loadPlan(root);
    const c1 = showItem(p, 'T-001');
    assert.deepEqual(c1.blocks.map((b) => b.id), ['T-002']);
    assert.equal(c1.summary['Что'], 'Первая.');
    assert.deepEqual(c1.criteria, { total: 1, open: 1, waived: 0 });
    assert.deepEqual(showItem(p, 'T-002 Вторая').openDeps.map((d) => d.id), ['T-001']);
    assert.equal(showItem(p, 'T-404'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

import { listItems } from '../tasks.mjs';

test('set: закрыта последняя задача фичи → parentComplete', () => {
  const root = plan();
  try {
    assert.equal(setStatus(loadPlan(root), 'T-001', 'done', { log: 'готово.' }).parentComplete, null);
    assert.deepEqual(setStatus(loadPlan(root), 'T-002', 'cancelled', { log: 'не нужна.' }).parentComplete?.id, 'F-01');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('list: фильтр по статусам и типу', () => {
  const root = plan();
  try {
    setStatus(loadPlan(root), 'T-001', 'in-progress', { log: 'взята.' });
    const p = loadPlan(root);
    assert.deepEqual(listItems(p, { status: 'in-progress' }).map((x) => x.id), ['E-01', 'F-01', 'T-001']);
    assert.deepEqual(listItems(p, { status: 'in-progress', type: 'task' }).map((x) => x.id), ['T-001']);
    assert.deepEqual(listItems(p, { status: 'ready,in-progress', type: 'task' }).map((x) => x.id), ['T-001', 'T-002']);
    assert.deepEqual(listItems(p, { type: 'feature' }).map((x) => x.id), ['F-01']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
