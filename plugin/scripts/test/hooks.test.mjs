// Тесты хуков контроля статусов: node --test plugin/scripts/test/hooks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject, loadPlan, createItem, setStatus, runHook } from '../tasks.mjs';

function setup(fn) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-data-'));
  try {
    initProject(p);
    const root = path.join(p, 'Docs', 'Tasks');
    createItem(loadPlan(root), 'epic', { title: 'Э' });
    createItem(loadPlan(root), 'feature', { title: 'Ф', parent: 'E-01' });
    const t = createItem(loadPlan(root), 'task', { title: 'Первая', parent: 'F-01', role: 'qa', status: 'ready' });
    const env = { CLAUDE_PLUGIN_DATA: data };
    const hook = (event, extra = {}) => runHook(event, { cwd: p, session_id: 'S1', ...extra }, env);
    const out = (r) => (r.stdout ? JSON.parse(r.stdout) : null);
    return fn({ p, root, env, hook, out, file: t.file });
  } finally { fs.rmSync(p, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true }); }
}
const bashSet = (id, status) => ({ tool_name: 'Bash', tool_input: { command: `node "C:/x/plugin/scripts/tasks.mjs" set ${id} ${status} --log "..."` } });

test('session-start: правила и что в работе; без плана и с TASK_HOOKS=off — молчит', () => setup(({ p, root, hook, out, env }) => {
  setStatus(loadPlan(root), 'T-001', 'in-progress', { log: 'взята.' });
  const ctx = out(hook('session-start')).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Docs\/Tasks/);
  assert.match(ctx, /Сейчас в работе: T-001 \(qa\)/);
  assert.match(ctx, /tasks\.mjs" set <ID>/);
  assert.equal(runHook('session-start', { cwd: os.tmpdir() }, env).stdout, '');
  assert.equal(runHook('session-start', { cwd: p }, { ...env, TASK_HOOKS: 'off' }).stdout, '');
}));

test('stop: напоминает только сессии, взявшей задачу, пока в журнале нет новых записей', () => setup(({ root, hook, out }) => {
  setStatus(loadPlan(root), 'T-001', 'in-progress', { log: 'взята в работу.' });
  hook('post-tool-use', bashSet('T-001', 'in-progress'));
  const r = out(hook('stop'));
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /T-001 Первая/);
  assert.equal(hook('stop', { session_id: 'S2' }).stdout, '', 'чужая сессия');
  assert.equal(hook('stop', { stop_hook_active: true }).stdout, '', 'повторный стоп не блокируется');
  // Агент записал прогресс — напоминание снимается
  setStatus(loadPlan(root), 'T-001', 'in-progress', { log: 'сделал половину, остановился на X.' });
  hook('post-tool-use', bashSet('T-001', 'in-progress'));
  assert.equal(hook('stop').stdout, '');
}));

test('stop: закрытая задача отпускается', () => setup(({ root, hook }) => {
  setStatus(loadPlan(root), 'T-001', 'in-progress', { log: 'взята.' });
  hook('post-tool-use', bashSet('T-001', 'in-progress'));
  fs.writeFileSync(path.join(root, 'Tasks', 'T-001 Первая.md'), fs.readFileSync(path.join(root, 'Tasks', 'T-001 Первая.md'), 'utf8').replace('- [ ] ', '- [x] '));
  setStatus(loadPlan(root), 'T-001', 'done', { log: 'готово.' });
  hook('post-tool-use', bashSet('T-001', 'done'));
  assert.equal(hook('stop').stdout, '');
}));

test('правка файла без смены статуса задачу не «берёт»; правка со status: in-progress — берёт', () => setup(({ root, hook, out, file }) => {
  setStatus(loadPlan(root), 'T-001', 'in-progress', { log: 'взята кем-то другим.' });
  hook('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'опечатка исправлена' } });
  assert.equal(hook('stop').stdout, '', 'чужую задачу не присвоили');
  hook('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'status: ready', new_string: 'status: in-progress' } });
  assert.equal(out(hook('stop')).decision, 'block');
}));

test('субагент: своё владение по agent_id', () => setup(({ root, hook }) => {
  setStatus(loadPlan(root), 'T-001', 'in-progress', { log: 'взята.' });
  hook('post-tool-use', { ...bashSet('T-001', 'in-progress'), agent_id: 'A1' });
  assert.equal(hook('stop').stdout, '', 'главная сессия задачу не брала');
  assert.ok(hook('stop', { agent_id: 'A1' }).stdout.includes('block'));
}));

test('post-tool-use: правка плана пересобирает доску и сообщает об ошибках', () => setup(({ root, hook, out, file }) => {
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('parent: "[[F-01 Ф]]"', 'parent: "[[F-99 Нет]]"'));
  const r = out(hook('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'x', new_string: 'y' } }));
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /битая ссылка \[\[F-99 Нет\]\]/);
  assert.match(fs.readFileSync(path.join(root, 'Board.md'), 'utf8'), /ошибок 1/);
  assert.equal(hook('post-tool-use', { tool_name: 'Bash', tool_input: { command: 'npm test' } }).stdout, '', 'посторонние команды не трогаем');
}));
