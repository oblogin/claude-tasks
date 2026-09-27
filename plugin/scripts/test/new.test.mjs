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
  const t2 = createItem(load(root), 'research', { title: 'Модель прыжка', parent: 'F-01 Прыжок', depends: ['T-001'] });
  assert.deepEqual([f.id, t1.id, t2.id], ['F-01', 'T-001', 'T-002']);
  assert.ok(t2.file.endsWith(path.join('Tasks', 'T-002 Модель прыжка.md')));
  const text = fs.readFileSync(t2.file, 'utf8');
  assert.match(text, /^type: research$/m);
  assert.match(text, /^parent: "\[\[F-01 Прыжок\]\]"$/m);
  assert.match(text, /^depends_on:\n {2}- "\[\[T-001 Гравитация\]\]"$/m);
  assert.doesNotMatch(text, /^role:/m, 'без role строка убрана');
  assert.match(text, /^# T-002 Модель прыжка$/m);
  assert.doesNotMatch(text, /\{\{/, 'все метки заменены');
  const t1text = fs.readFileSync(t1.file, 'utf8');
  assert.match(t1text, /^role: programmer$/m);
  assert.match(t1text, /^status: ready$/m);
  assert.match(t1text, /^size: S$/m);
  const r = checkPlan(load(root));
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.every((w) => ['summary-empty', 'no-criteria'].includes(w.code)), 'только незаполненное тело');
  assert.ok(fs.readFileSync(path.join(root, 'Board.md'), 'utf8').includes('[[T-002 Модель прыжка]]'), 'доска обновлена');
}));

test('new: идея и ADR со ссылкой на research', () => project((root) => {
  createItem(load(root), 'epic', { title: 'Э' });
  createItem(load(root), 'feature', { title: 'Ф', parent: 'E-01' });
  createItem(load(root), 'research', { title: 'Выбор', parent: 'F-01' });
  const i = createItem(load(root), 'idea', { title: 'Кооператив' });
  const a = createItem(load(root), 'adr', { title: 'Решение', task: 'T-001' });
  assert.equal(i.id, 'I-001');
  assert.equal(a.id, 'ADR-001');
  assert.match(fs.readFileSync(a.file, 'utf8'), /^task: "\[\[T-001 Выбор\]\]"$/m);
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
