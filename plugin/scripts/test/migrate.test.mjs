// Тесты migrate и move: node --test plugin/scripts/test/migrate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlan, checkPlan, migratePlan, moveItem, createItem } from '../tasks.mjs';

const note = (fm, body) => `---\n${fm}\n---\n${body}`;
const sum = '> **Что:** ч.\n> **Зачем:** з.\n> **Готово, когда:** г.\n';
const task = (id, title, parent, extra = '', body = '') => note(
  `id: ${id}\ntype: task\nstatus: ready\npriority: must\nsize: S\nparent: "[[${parent}]]"\n${extra || 'depends_on: []'}\ncreated: 2026-09-27`,
  `# ${id} ${title}\n\n${sum}\n## Критерии готовности\n\n- [ ] к\n\n${body}## Журнал\n`);

// Плоский план старого формата: Epics/, Features/, Tasks/ и сквозные T-ID
function flatPlan() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-'));
  const files = {
    'Epics/E-01 Эпик.md': note('id: E-01\ntype: epic\nstatus: in-progress\npriority: must\ncreated: 2026-09-27', `# E-01 Эпик\n\n${sum}\n## Журнал\n`),
    'Features/F-01 Фича.md': note('id: F-01\ntype: feature\nstatus: ready\npriority: must\nparent: "[[E-01 Эпик]]"\ncreated: 2026-09-27', `# F-01 Фича\n\n${sum}\n## Журнал\n`),
    'Features/F-02 Вторая фича.md': note('id: F-02\ntype: feature\nstatus: ready\npriority: must\nparent: "[[E-01 Эпик]]"\ncreated: 2026-09-27', `# F-02 Вторая фича\n\n${sum}\n## Журнал\n`),
    'Tasks/T-001 Первая.md': task('T-001', 'Первая', 'F-01 Фича'),
    'Tasks/T-002 Вторая.md': task('T-002', 'Вторая', 'F-02 Вторая фича', 'depends_on:\n  - "[[T-001 Первая]]"', 'См. T-001 и [[T-001 Первая|T-001]]; T-0010 — не ID.\n\n'),
    'Tasks/T-003 Третья.md': task('T-003', 'Третья', 'F-01 Фича'),
    'Tasks/.gitkeep': '',
    'Backlog/I-001 Идея.md': note('id: I-001\ntype: idea\nstatus: done\npromoted_to: "[[T-003 Третья]]"\ncreated: 2026-09-27', '# I-001 Идея\n\n> **Что:** и.\n> **Зачем:** и.\n'),
    'Adr/ADR-001 Решение.md': note('id: ADR-001\ntype: adr\nstatus: accepted\ntask: "[[T-001 Первая]]"\ncreated: 2026-09-27', '# ADR-001 Решение\n\n> **Решение:** р.\n> **Почему:** п.\n> **Следствия:** с.\n'),
    'Board.md': '# Доска\n\n[[T-002 Вторая]]\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

test('migrate: папки, ID внутри фич по порядку, ссылки и упоминания, журнал; повтор — без изменений', () => {
  const root = flatPlan();
  try {
    const res = migratePlan(root, { date: '2026-10-01' });
    assert.deepEqual(res.renames, [{ oldId: 'T-001', newId: 'F01-01' }, { oldId: 'T-003', newId: 'F01-02' }, { oldId: 'T-002', newId: 'F02-01' }]);
    const E = 'E-01 Эпик', F1 = `${E}/F-01 Фича`, F2 = `${E}/F-02 Вторая фича`;
    for (const rel of [`${E}/${'E-01 Эпик'}.md`, `${F1}/F-01 Фича.md`, `${F1}/F01-01 Первая.md`, `${F1}/F01-02 Третья.md`, `${F2}/F02-01 Вторая.md`]) assert.ok(exists(root, rel), rel);
    for (const d of ['Epics', 'Features', 'Tasks']) assert.ok(!exists(root, d), `пустая ${d}/ удалена`);
    const t2 = read(root, `${F2}/F02-01 Вторая.md`);
    assert.match(t2, /^id: F02-01$/m);
    assert.match(t2, /^# F02-01 Вторая$/m);
    assert.match(t2, /- "\[\[F01-01 Первая\]\]"/);
    assert.ok(t2.includes('См. F01-01 и [[F01-01 Первая|F01-01]]; T-0010 — не ID.'), 'упоминания и алиасы; T-0010 не тронут');
    assert.ok(t2.endsWith('ID изменён при переходе на иерархию плана: T-002 → F02-01.\n'));
    assert.match(read(root, 'Backlog/I-001 Идея.md'), /promoted_to: "\[\[F01-02 Третья\]\]"/);
    assert.match(read(root, 'Adr/ADR-001 Решение.md'), /task: "\[\[F01-01 Первая\]\]"/);
    const r = checkPlan(loadPlan(root));
    assert.deepEqual(r.errors, []);
    const again = migratePlan(root);
    assert.deepEqual([again.moved, again.renames.length], [0, 0]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('migrate --dry-run ничего не меняет', () => {
  const root = flatPlan();
  try {
    const res = migratePlan(root, { dryRun: true });
    assert.equal(res.renames.length, 3);
    assert.ok(exists(root, 'Tasks/T-001 Первая.md'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('move: задача в другую фичу — новый ID, ссылки у зависимых, журнал', () => {
  const root = flatPlan();
  try {
    migratePlan(root);
    const res = moveItem(root, 'F01-01', 'F-02', { date: '2026-10-02' });
    assert.deepEqual([res.oldId, res.id], ['F01-01', 'F02-02']);
    const F2 = 'E-01 Эпик/F-02 Вторая фича';
    assert.ok(!exists(root, 'E-01 Эпик/F-01 Фича/F01-01 Первая.md'));
    const moved = read(root, `${F2}/F02-02 Первая.md`);
    assert.match(moved, /^parent: "\[\[F-02 Вторая фича\]\]"$/m);
    assert.ok(moved.endsWith('перенесена из [[F-01 Фича]] в [[F-02 Вторая фича]]: ID F01-01 → F02-02.\n'));
    assert.match(read(root, `${F2}/F02-01 Вторая.md`), /- "\[\[F02-02 Первая\]\]"/);
    assert.deepEqual(checkPlan(loadPlan(root)).errors, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('move: фича в другой эпик — папка целиком, ID не меняются', () => {
  const root = flatPlan();
  try {
    migratePlan(root);
    createItem(loadPlan(root), 'epic', { title: 'Второй эпик' });
    const res = moveItem(root, 'F-02', 'E-02');
    assert.equal(res.dir, 'E-02 Второй эпик/F-02 Вторая фича');
    assert.ok(exists(root, 'E-02 Второй эпик/F-02 Вторая фича/F02-01 Вторая.md'));
    assert.ok(!exists(root, 'E-01 Эпик/F-02 Вторая фича'));
    assert.match(read(root, 'E-02 Второй эпик/F-02 Вторая фича/F-02 Вторая фича.md'), /^parent: "\[\[E-02 Второй эпик\]\]"$/m);
    assert.deepEqual(checkPlan(loadPlan(root)).errors, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('move: ошибки', () => {
  const root = flatPlan();
  try {
    migratePlan(root);
    assert.match(moveItem(root, 'F01-01', 'E-01').error, /только в фичу/);
    assert.match(moveItem(root, 'F01-01', 'F-01').error, /уже в/);
    assert.match(moveItem(root, 'F-01', 'F-02').error, /только в эпик/);
    assert.match(moveItem(root, 'E-01', 'F-01').error, /переносить можно/);
    assert.match(moveItem(root, 'F09-09', 'F-01').error, /не найден/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
