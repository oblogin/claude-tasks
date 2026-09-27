// Тесты хуков контроля статусов: node --test plugin/scripts/test/hooks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject, loadPlan, createItem, setStatus, runHook } from '../tasks.mjs';

function setup(fn) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
  try {
    initProject(p);
    const root = path.join(p, 'Docs', 'Tasks');
    createItem(loadPlan(root), 'epic', { title: 'Э' });
    createItem(loadPlan(root), 'feature', { title: 'Ф', parent: 'E-01' });
    const t = createItem(loadPlan(root), 'task', { title: 'Первая', parent: 'F-01', role: 'qa', status: 'ready' });
    const env = {};
    const hook = (event, extra = {}) => runHook(event, { cwd: p, session_id: 'S1', ...extra }, env);
    const out = (r) => (r.stdout ? JSON.parse(r.stdout) : null);
    // Сессия берёт задачу скриптом: ID сессии скрипт получает из окружения (CLAUDE_CODE_SESSION_ID)
    const set = (status, log, opts = {}) => setStatus(loadPlan(root), 'F01-01', status, { log, ...opts });
    return fn({ p, root, env, hook, out, set, file: t.file });
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
}

test('session-start: правила и что в работе; без плана и с TASK_HOOKS=off — молчит', () => setup(({ p, hook, out, env, set }) => {
  set('in-progress', 'взята.');
  const ctx = out(hook('session-start')).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Docs\/Tasks/);
  assert.match(ctx, /Сейчас в работе: F01-01 \(qa\)/);
  assert.match(ctx, /tasks\.mjs" set <ID>/);
  assert.match(ctx, /--log -/, 'подсказка про безопасную передачу журнала');
  assert.equal(runHook('session-start', { cwd: os.tmpdir() }, env).stdout, '');
  assert.equal(runHook('session-start', { cwd: p }, { ...env, TASK_HOOKS: 'off' }).stdout, '');
}));

test('stop: напоминает только сессии, взявшей задачу, пока в журнале нет новых записей', () => setup(({ hook, out, set }) => {
  set('in-progress', 'взята в работу.', { session: 'S1' });
  const r = out(hook('stop'));
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /F01-01 Первая/);
  assert.equal(hook('stop', { session_id: 'S2' }).stdout, '', 'чужая сессия');
  assert.equal(hook('stop', { stop_hook_active: true }).stdout, '', 'повторный стоп не блокируется');
  // Агент записал прогресс — напоминание снимается
  set('in-progress', 'сделал половину, остановился на X.', { session: 'S1' });
  assert.equal(hook('stop').stdout, '');
}));

test('stop: закрытая задача отпускается', () => setup(({ hook, out, set, file }) => {
  set('in-progress', 'взята.', { session: 'S1' });
  assert.equal(out(hook('stop')).decision, 'block', 'пока задача в работе без итога — напоминание');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('- [ ] ', '- [x] готово'));
  set('done', 'готово.', { session: 'S1' });
  assert.equal(hook('stop').stdout, '');
}));

test('правка файла без смены статуса задачу не «берёт»; правка, ставящая status: in-progress, — берёт', () => setup(({ hook, out, file, set }) => {
  set('in-progress', 'взята кем-то другим.');
  hook('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'опечатка исправлена' } });
  assert.equal(hook('stop').stdout, '', 'чужую задачу не присвоили');
  hook('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'status: ready', new_string: 'status: in-progress' } });
  assert.equal(out(hook('stop')).decision, 'block');
}));

test('субагент: своё владение по agent_id', () => setup(({ hook, file, set }) => {
  set('in-progress', 'взята.');
  hook('post-tool-use', { tool_name: 'Edit', agent_id: 'A1', tool_input: { file_path: file, old_string: 'status: ready', new_string: 'status: in-progress' } });
  assert.equal(hook('stop').stdout, '', 'главная сессия задачу не брала');
  assert.ok(hook('stop', { agent_id: 'A1' }).stdout.includes('block'));
}));

test('post-tool-use: правка плана пересобирает доску и сообщает об ошибках этой правки', () => setup(({ root, hook, out, file }) => {
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('parent: "[[F-01 Ф]]"', 'parent: "[[F-99 Нет]]"'));
  const r = out(hook('post-tool-use', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'x', new_string: 'y' } }));
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /битая ссылка \[\[F-99 Нет\]\]/);
  assert.match(fs.readFileSync(path.join(root, 'Board.md'), 'utf8'), /ошибок 1/);
  assert.equal(hook('post-tool-use', { tool_name: 'Bash', tool_input: { command: 'npm test' } }).stdout, '', 'посторонние команды не трогаем');
}));
