// Тесты дефектов из саморевью (F07-01): node --test plugin/scripts/test/review.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, initProject, loadPlan, createItem, moveItem, runHook, setStatus, checkPlan } from '../tasks.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('1. булевы флаги не забирают следующий аргумент', () => {
  assert.deepEqual(parseArgs(['show', '--json', 'F01-01']), { _: ['show', 'F01-01'], json: true });
  assert.deepEqual(parseArgs(['migrate', '--dry-run', '--json']), { _: ['migrate'], 'dry-run': true, json: true });
  const a = parseArgs(['set', 'F01-01', 'done', '--force', '--log', 'итог', '--who', 'qa']);
  assert.deepEqual([a._, a.force, a.log, a.who], [['set', 'F01-01', 'done'], true, 'итог', 'qa']);
  assert.equal(parseArgs(['init', '--claude-md', '--project', 'X']).project, 'X');
});

function project() {
  const p = tmp('rev-');
  initProject(p);
  const root = path.join(p, 'Docs', 'Tasks');
  createItem(loadPlan(root), 'epic', { title: 'Э1' });
  createItem(loadPlan(root), 'epic', { title: 'Э2' });
  createItem(loadPlan(root), 'feature', { title: 'Ф', parent: 'E-01' });
  createItem(loadPlan(root), 'task', { title: 'Задача', parent: 'F-01', status: 'ready' });
  return { p, root };
}

test('2. перенос фичи переносит папку целиком, с вложениями', () => {
  const { p, root } = project();
  try {
    fs.writeFileSync(path.join(root, 'E-01 Э1', 'F-01 Ф', 'схема.png'), 'PNG');
    assert.equal(moveItem(root, 'F-01', 'E-02').dir, 'E-02 Э2/F-01 Ф');
    assert.ok(fs.existsSync(path.join(root, 'E-02 Э2', 'F-01 Ф', 'схема.png')), 'вложение переехало');
    assert.ok(fs.existsSync(path.join(root, 'E-02 Э2', 'F-01 Ф', 'F01-01 Задача.md')));
    assert.ok(!fs.existsSync(path.join(root, 'E-01 Э1', 'F-01 Ф')), 'старой папки нет');
    assert.deepEqual(checkPlan(loadPlan(root)).errors, []);
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

test('3. хук не трогает план, если правится файл другого плана', () => {
  const { p, root } = project();
  const other = tmp('rev-other-'); const data = tmp('rev-data-');
  try {
    fs.writeFileSync(path.join(root, 'Board.md'), 'МАРКЕР');
    const r = runHook('post-tool-use', { cwd: p, session_id: 'S', tool_name: 'Edit', tool_input: { file_path: path.join(other, 'Docs', 'Tasks', 'F01-01 Задача.md'), new_string: 'status: in-progress' } }, { CLAUDE_PLUGIN_DATA: data });
    assert.equal(r.stdout, '');
    assert.equal(fs.readFileSync(path.join(root, 'Board.md'), 'utf8'), 'МАРКЕР', 'доска не тронута');
    setStatus(loadPlan(root), 'F01-01', 'in-progress', { log: 'взята.' });
    assert.equal(runHook('stop', { cwd: p, session_id: 'S' }, { CLAUDE_PLUGIN_DATA: data }).stdout, '', 'чужую задачу не присвоили');
  } finally { for (const d of [p, other, data]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('4. состояние хуков — отдельный файл на сессию', () => {
  const { p, root } = project();
  const data = tmp('rev-data-');
  try {
    setStatus(loadPlan(root), 'F01-01', 'in-progress', { log: 'взята.' });
    const bash = (s) => ({ cwd: p, session_id: s, tool_name: 'Bash', tool_input: { command: 'node tasks.mjs set F01-01 in-progress --log x' } });
    runHook('post-tool-use', bash('S1'), { CLAUDE_PLUGIN_DATA: data });
    runHook('post-tool-use', bash('S2'), { CLAUDE_PLUGIN_DATA: data });
    const files = fs.readdirSync(path.join(data, 'sessions')).sort();
    assert.equal(files.length, 2, files.join(', '));
    assert.ok(runHook('stop', { cwd: p, session_id: 'S1' }, { CLAUDE_PLUGIN_DATA: data }).stdout.includes('block'));
    assert.ok(runHook('stop', { cwd: p, session_id: 'S2' }, { CLAUDE_PLUGIN_DATA: data }).stdout.includes('block'));
  } finally { for (const d of [p, data]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('6. дубль имени файла в разных папках — ошибка', () => {
  const { p, root } = project();
  try {
    const src = path.join(root, 'E-01 Э1', 'F-01 Ф', 'F01-01 Задача.md');
    fs.mkdirSync(path.join(root, 'E-02 Э2', 'Копия'), { recursive: true });
    fs.copyFileSync(src, path.join(root, 'E-02 Э2', 'Копия', 'F01-01 Задача.md'));
    assert.ok(checkPlan(loadPlan(root)).errors.some((e) => e.code === 'duplicate-name'));
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});
