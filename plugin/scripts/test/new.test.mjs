// Тесты new: node --test plugin/scripts/test/new.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject, loadPlan, checkPlan, createItem } from '../tasks.mjs';

function project(fn) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
  try { initProject(p); return fn(path.join(p, 'Docs', 'Tasks')); } finally { fs.rmSync(p, { recursive: true, force: true }); }
}
const load = (root) => loadPlan(root);

test('new: эпик → фича → задачи с зависимостью; структура верна, ошибок нет', () => project((root) => {
  const e = createItem(load(root), 'epic', { title: 'Прототип' });
  assert.equal(e.id, 'E-01');
  const f = createItem(load(root), 'feature', { title: 'Прыжок', parent: 'E-01', priority: 'should' });
  const t1 = createItem(load(root), 'task', { title: 'Гравитация', parent: 'F-01', role: 'programmer', size: 'S', status: 'ready' });
  const t2 = createItem(load(root), 'research', { title: 'Модель прыжка', parent: 'F-01 Прыжок', depends: ['F01-01'] });
  assert.deepEqual([f.id, t1.id, t2.id], ['F-01', 'F01-01', 'F01-02']);
  assert.ok(t2.file.endsWith(path.join('E-01 Прототип', 'F-01 Прыжок', 'F01-02 Модель прыжка.md')), t2.file);
  const text = fs.readFileSync(t2.file, 'utf8');
  assert.match(text, /^type: research$/m);
  assert.match(text, /^parent: "\[\[F-01 Прыжок\]\]"$/m);
  assert.match(text, /^depends_on:\n {2}- "\[\[F01-01 Гравитация\]\]"$/m);
  assert.doesNotMatch(text, /^role:/m, 'без role строка убрана');
  assert.match(text, /^# F01-02 Модель прыжка$/m);
  assert.doesNotMatch(text, /\{\{/, 'все метки заменены');
  const t1text = fs.readFileSync(t1.file, 'utf8');
  assert.match(t1text, /^role: programmer$/m);
  assert.match(t1text, /^status: ready$/m);
  assert.match(t1text, /^size: S$/m);
  const r = checkPlan(load(root));
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.every((w) => ['summary-empty', 'no-criteria', 'template-hints'].includes(w.code)), 'только незаполненное тело');
  assert.ok(fs.readFileSync(path.join(root, 'Board.md'), 'utf8').includes('[[F01-02 Модель прыжка]]'), 'доска обновлена');
}));

test('new: идея и ADR со ссылкой на research', () => project((root) => {
  createItem(load(root), 'epic', { title: 'Э' });
  createItem(load(root), 'feature', { title: 'Ф', parent: 'E-01' });
  createItem(load(root), 'research', { title: 'Выбор', parent: 'F-01' });
  const i = createItem(load(root), 'idea', { title: 'Кооператив' });
  const a = createItem(load(root), 'adr', { title: 'Решение', task: 'F01-01' });
  assert.equal(i.id, 'I-001');
  assert.equal(a.id, 'ADR-001');
  assert.match(fs.readFileSync(a.file, 'utf8'), /^task: "\[\[F01-01 Выбор\]\]"$/m);
  assert.deepEqual(checkPlan(load(root)).errors, []);
}));

test('new: ошибки ввода не создают файлов', () => project((root) => {
  createItem(load(root), 'epic', { title: 'Э' });
  const cases = [
    ['story', { title: 'x' }, /неизвестный тип/],
    ['task', { title: '' }, /нужно название/],
    ['task', { title: 'a/b', parent: 'F-01' }, /недопустимы символы/],
    ['task', { title: 'x' }, /нужен родитель/],
    ['task', { title: 'x', parent: 'E-01' }, /должен быть feature/],
    ['feature', { title: 'x', parent: 'E-99' }, /не найден/],
    ['feature', { title: 'x', parent: 'E-01', priority: 'high' }, /priority/],
  ];
  for (const [type, opts, re] of cases) assert.match(createItem(load(root), type, opts).error, re, JSON.stringify(opts));
  assert.equal(load(root).items.length, 1, 'создан только эпик');
}));

import { setStatus } from '../tasks.mjs';

test('идея → задача: promoted_to и статус done, проверка без предупреждений об идее', () => project((root) => {
  createItem(load(root), 'epic', { title: 'Э' });
  createItem(load(root), 'feature', { title: 'Ф', parent: 'E-01' });
  const idea = createItem(load(root), 'idea', { title: 'Кооператив' });
  const task = createItem(load(root), 'task', { title: 'Кооп-режим', parent: 'F-01' });
  assert.match(setStatus(load(root), 'I-001', 'done', { promotedTo: 'F01-99' }).error, /не найден/);
  assert.match(setStatus(load(root), 'F01-01', 'done', { promotedTo: 'F-01' }).error, /только для идей/);
  const res = setStatus(load(root), idea.id, 'done', { promotedTo: task.id, date: '2026-10-13' });
  assert.equal(res.error, undefined);
  const text = fs.readFileSync(idea.file, 'utf8');
  assert.match(text, /^status: done\npromoted_to: "\[\[F01-01 Кооп-режим\]\]"$/m);
  const w = checkPlan(load(root)).warnings.filter((x) => x.id === 'I-001').map((x) => x.code);
  assert.ok(!w.includes('no-promoted'));
}));

test('идея: перенос пишет строку «Взята в план» без журнала; повтор её заменяет', () => project((root) => {
  createItem(load(root), 'epic', { title: 'Э' });
  createItem(load(root), 'feature', { title: 'Ф', parent: 'E-01' });
  createItem(load(root), 'feature', { title: 'Г', parent: 'E-01' });
  const idea = createItem(load(root), 'idea', { title: 'Кооператив' });
  assert.equal(setStatus(load(root), idea.id, 'done', { promotedTo: 'F-01', date: '2026-10-13' }).error, undefined);
  let text = fs.readFileSync(idea.file, 'utf8');
  assert.match(text, /\n\n\*\*Взята в план:\*\* \[\[F-01 Ф\]\] \(2026-10-13\)\.\n$/);
  assert.doesNotMatch(text, /## Журнал/);
  assert.equal(setStatus(load(root), idea.id, 'done', { promotedTo: 'F-02', date: '2026-10-14' }).error, undefined);
  text = fs.readFileSync(idea.file, 'utf8');
  assert.equal(text.match(/\*\*Взята в план:\*\*/g).length, 1);
  assert.match(text, /\*\*Взята в план:\*\* \[\[F-02 Г\]\] \(2026-10-14\)\.\n$/);
  const w = checkPlan(load(root)).warnings.filter((x) => x.id === idea.id).map((x) => x.code);
  assert.ok(!w.includes('log-not-allowed') && !w.includes('no-promoted'), w.join());
}));

test('idea и adr: --log отклоняется, файл не меняется', () => project((root) => {
  createItem(load(root), 'epic', { title: 'Э' });
  createItem(load(root), 'feature', { title: 'Ф', parent: 'E-01' });
  const idea = createItem(load(root), 'idea', { title: 'Идея' });
  const adr = createItem(load(root), 'adr', { title: 'Решение' });
  for (const [it, status, opts] of [[idea, 'done', { promotedTo: 'F-01' }], [idea, 'cancelled', {}], [adr, 'accepted', {}]]) {
    const before = fs.readFileSync(it.file, 'utf8');
    const res = setStatus(load(root), it.id, status, { ...opts, log: 'текст.' });
    assert.equal(res.code, 'no-journal', it.id);
    assert.match(res.error, /нет журнала/);
    assert.equal(fs.readFileSync(it.file, 'utf8'), before, it.id);
  }
}));

test('check: журнал в идее или ADR — предупреждение log-not-allowed', () => project((root) => {
  const idea = createItem(load(root), 'idea', { title: 'Идея' });
  const adr = createItem(load(root), 'adr', { title: 'Решение' });
  for (const it of [idea, adr]) fs.appendFileSync(it.file, '\n## Журнал\n\n- **2026-10-13 · x (Claude):** запись.\n');
  const w = checkPlan(load(root)).warnings.filter((x) => x.code === 'log-not-allowed').map((x) => x.id).sort();
  assert.deepEqual(w, [adr.id, idea.id].sort());
}));
