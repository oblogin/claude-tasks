// Тесты дефектов из код-ревью (F08-01): node --test plugin/scripts/test/codereview.test.mjs
// Номера — пункты критериев F08-01.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as T from '../tasks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(PLUGIN, 'scripts', 'tasks.mjs');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const read = (f) => fs.readFileSync(f, 'utf8');
const codes = (list) => list.map((e) => e.code);
// Окружение для запуска скрипта: без ID сессии, если тест его не задал
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['CLAUDE_CODE_SESSION_ID', 'TASK_SESSION_ID', 'CLAUDE_PROJECT_DIR'].includes(k)));
const cli = (cwd, args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', env: { ...ENV, ...opts.env }, input: opts.input });

// Файлы плана без служебной папки .claude-tasks
function tree(dir) {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.claude-tasks') continue; const x = path.join(d, e.name); if (e.isDirectory()) walk(x); else out.push(path.relative(dir, x).split(path.sep).join('/')); } })(dir);
  return out.sort();
}

// Проект с планом: эпики E-01 «Первый», E-02 «Второй»; фичи F-01 «Раз», F-02 «Два» в E-01
function project(fn) {
  const p = tmp('cr-');
  try {
    T.initProject(p);
    const root = path.join(p, 'Docs', 'Tasks');
    const load = () => T.loadPlan(root);
    const make = (type, opts) => { const r = T.createItem(load(), type, opts); assert.equal(r.error, undefined, r.error); return r; };
    make('epic', { title: 'Первый' }); make('epic', { title: 'Второй' });
    make('feature', { title: 'Раз', parent: 'E-01' }); make('feature', { title: 'Два', parent: 'E-01' });
    return fn({ p, root, load, make });
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
}

const FEATURE = (id, title, epic) => `---\nid: ${id}\ntype: feature\nstatus: draft\npriority: must\nparent: "[[${epic}]]"\ncreated: 2026-09-27\n---\n# ${id} ${title}\n\n> **Что:** ч.\n> **Зачем:** з.\n> **Готово, когда:** г.\n\n## Журнал\n`;

// ─── 1. move фичи ───────────────────────────────────────────────────────────

test('1. move фичи, заметка которой лежит не в своей папке, — отказ; ничего не переезжает', () => project(({ root, make }) => {
  fs.writeFileSync(path.join(root, 'E-01 Первый', 'F-03 Ручная.md'), FEATURE('F-03', 'Ручная', 'E-01 Первый'));
  make('task', { title: 'Задача', parent: 'F-01' });
  const before = tree(root);
  assert.match(T.moveItem(root, 'F-03', 'E-02').error, /F-03 лежит не в своей папке.*migrate/);
  assert.match(T.moveItem(root, 'F01-01', 'F-03').error, /F-03 лежит не в своей папке/, 'задачу в такую фичу тоже не переносим');
  assert.deepEqual(tree(root), before, 'эпик E-01 остался на месте');
  // фича в своей папке по-прежнему переносится целиком
  assert.equal(T.moveItem(root, 'F-01', 'E-02').dir, 'E-02 Второй/F-01 Раз');
}));

// ─── 2. распознавание плана ─────────────────────────────────────────────────

test('2. чужая папка docs/tasks — не план: хуки молчат и ничего не пишут, init не смешивает', () => {
  const p = tmp('cr-foreign-');
  try {
    const dir = path.join(p, 'docs', 'tasks');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'deploy.md');
    fs.writeFileSync(f, '# Deploy\n\n- [ ] run migrations\n');
    assert.equal(T.findRoot(null, { cwd: p }), null);
    assert.equal(T.runHook('session-start', { cwd: p, session_id: 'S' }, {}).stdout, '');
    assert.equal(T.runHook('post-tool-use', { cwd: p, session_id: 'S', tool_name: 'Edit', tool_input: { file_path: f, old_string: 'a', new_string: 'b' } }, {}).stdout, '');
    assert.match(T.initProject(p).error, /не план плагина/);
    assert.deepEqual(fs.readdirSync(dir), ['deploy.md'], 'в чужую папку ничего не записано');
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

test('2. init при существующей docs/ кладёт план в неё; план находится по настоящему написанию', () => {
  const p = tmp('cr-case-');
  try {
    fs.mkdirSync(path.join(p, 'docs'));
    const res = T.initProject(p, { claudeMd: true, gitignore: true });
    assert.equal(path.relative(p, res.root).split(path.sep).join('/'), 'docs/Tasks');
    assert.ok(fs.readdirSync(p).includes('docs') && !fs.readdirSync(p).includes('Docs'));
    assert.equal(T.findRoot(null, { cwd: p }), res.root);
    assert.match(read(path.join(p, 'CLAUDE.md')), /`docs\/Tasks\/`/, 'блок CLAUDE.md называет настоящую папку');
    assert.match(read(path.join(p, '.gitignore')), /^docs\/Tasks\/\.obsidian\/$/m);
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

// ─── 3. журнал без искажений оболочкой ──────────────────────────────────────

test('3. журнал из stdin и из файла — Markdown как написан; многострочный текст — вложенным списком', () => project(({ p, make }) => {
  const t = make('task', { title: 'Задача', parent: 'F-01', status: 'ready' });
  const text = 'готово: `parseArgs` в `tasks.mjs`, цена $5, он сказал "да"\n- результат: `node --test`\n  - деталь';
  const r = cli(p, ['set', 'F01-01', 'in-progress', '--log', '-', '--who', 'qa (Claude)'], { input: `﻿${text}\r\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(read(t.file).includes('· qa (Claude):** готово: `parseArgs` в `tasks.mjs`, цена $5, он сказал "да"\n  - результат: `node --test`\n  - деталь\n'), read(t.file).slice(-300));
  const lf = path.join(p, 'итог.md');
  fs.writeFileSync(lf, 'из файла: `x` и $HOME');
  assert.equal(cli(p, ['set', 'F01-01', 'in-progress', '--log-file', lf]).status, 0);
  assert.match(read(t.file), /из файла: `x` и \$HOME\n$/);
  const bad = cli(p, ['set', 'F01-01', 'in-progress', '--log']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /у --log нет значения/);
}));

test('3. скилы и контекст сессии учат передавать Markdown через stdin', () => {
  for (const s of ['done', 'next', 'replan']) assert.match(read(path.join(PLUGIN, 'skills', s, 'SKILL.md')), /--log -/, s);
  assert.match(read(path.join(PLUGIN, 'skills', 'format', 'SKILL.md')), /--log -/);
});

// ─── 4. хук сообщает только ошибки своей правки ─────────────────────────────

test('4. хук после правки сообщает только ошибки, связанные с правкой', () => project(({ p, make }) => {
  const mine = make('task', { title: 'Моя', parent: 'F-01' });
  const other = make('task', { title: 'Чужая', parent: 'F-02', depends: ['F01-01'] });
  fs.appendFileSync(other.file, '\nСм. [[Удалённая заметка]]\n');
  const edit = (file) => T.runHook('post-tool-use', { cwd: p, session_id: 'S', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'x', new_string: 'y' } }, {});
  assert.equal(edit(mine.file).stdout, '', 'давняя ошибка в чужой задаче правку своей не блокирует');
  // правка своей задачи создаёт цикл с чужой — это ошибка этой правки
  fs.writeFileSync(mine.file, read(mine.file).replace('depends_on: []', 'depends_on:\n  - "[[F02-01 Чужая]]"'));
  const r = JSON.parse(edit(mine.file).stdout);
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /цикл зависимостей/);
  assert.doesNotMatch(r.reason, /Удалённая заметка/);
  assert.match(r.reason, /Другие ошибки плана \(1\) к этой правке не относятся/);
}));

// ─── 5. ложные битые ссылки ─────────────────────────────────────────────────

test('5. вложения, ссылки с .md и путём, код с отступом и в двойных кавычках — не битые ссылки', () => project(({ make, load }) => {
  const t = make('task', { title: 'Задача', parent: 'F-01' });
  fs.writeFileSync(path.join(path.dirname(t.file), 'схема.png'), 'PNG');
  fs.appendFileSync(t.file, [
    'Схема: ![[схема.png]], та же картинка ссылкой: [[схема.png|картинка]]',
    'Ссылки: [[F01-01 Задача.md]], [[E-01 Первый/F-01 Раз/F01-01 Задача]]',
    '- **2026-09-27 · qa:** пример формата:',
    '  ```markdown',
    '  depends_on:',
    '    - "[[F03-01 Нет такой]]"',
    '  ```',
    'Код: ``[[Тоже нет]] с ` внутри``',
    'А эта ссылка битая: ![[нет.png]]', ''].join('\n'));
  const broken = T.checkPlan(load()).errors.filter((e) => e.code === 'broken-link').map((e) => e.msg);
  assert.deepEqual(broken, ['битая ссылка [[нет.png]]']);
}));

// ─── 6. владение задачей ────────────────────────────────────────────────────

test('6. журнал чужой задачи в работе не «присваивает» её; --take — присваивает; порядок флагов не важен', () => project(({ p, make, load }) => {
  make('task', { title: 'Задача', parent: 'F-01', status: 'ready' });
  make('task', { title: 'Вторая', parent: 'F-01', status: 'ready' });
  const stop = (s) => T.runHook('stop', { cwd: p, session_id: s }, {}).stdout;
  T.setStatus(load(), 'F01-01', 'in-progress', { log: 'взята в работу.', session: 'A' });
  T.setStatus(load(), 'F01-01', 'in-progress', { log: 'сделал половину.', session: 'A' });
  // replan пишет журнал так, как велит скил: set <ID> <текущий статус> --log …
  T.setStatus(load(), 'F01-01', 'in-progress', { log: 'план пересмотрен после [[F-02 Два]].', session: 'R' });
  assert.equal(stop('R'), '', 'сессия replan задачу не брала');
  assert.equal(stop('A'), '', 'у взявшей сессии после взятия есть записи');
  T.setStatus(load(), 'F01-01', 'in-progress', { log: 'продолжаю в новой сессии.', take: true, session: 'N' });
  assert.match(stop('N'), /block/, '--take: новая сессия отвечает за итог');
  assert.match(T.setStatus(load(), 'F01-01', 'done', { take: true }).error, /--take/);
  // CLI: флаг перед ID, ID сессии — из окружения
  const r = cli(p, ['set', '--json', 'F01-02', 'in-progress', '--log', 'взята.'], { env: { CLAUDE_CODE_SESSION_ID: 'CLI' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(stop('CLI'), /F01-02 Вторая/);
}));

test('6. SessionStart передаёт ID сессии в окружение Bash (CLAUDE_ENV_FILE)', () => project(({ p }) => {
  const envFile = path.join(p, 'claude-env.sh');
  T.runHook('session-start', { cwd: p, session_id: 'S-42' }, { CLAUDE_ENV_FILE: envFile });
  assert.equal(read(envFile), "export TASK_SESSION_ID='S-42'\n");
}));

test('6. хук PostToolUse не запускается на каждый Bash: только правки файлов', () => {
  const hooks = JSON.parse(read(path.join(PLUGIN, 'hooks', 'hooks.json')));
  assert.deepEqual(hooks.hooks.PostToolUse.map((h) => h.matcher), ['Write|Edit|MultiEdit']);
});

// ─── 7. очередь: зависимости и родитель ─────────────────────────────────────

test('7. битая зависимость блокирует; отменённая — предупреждение и подсказка; задачи закрытой фичи не выдаются', () => project(({ make, load }) => {
  const a = make('task', { title: 'Основа', parent: 'F-01', status: 'ready' });
  make('task', { title: 'Зависимая', parent: 'F-01', status: 'ready', depends: ['F01-01'] });
  make('task', { title: 'Во второй', parent: 'F-02', status: 'ready' });
  // (1) зависимость переименовали вне Obsidian — ссылка висит
  const renamed = a.file.replace('Основа', 'Основа v2');
  fs.renameSync(a.file, renamed);
  fs.writeFileSync(renamed, read(renamed).replace('# F01-01 Основа', '# F01-01 Основа v2'));
  assert.ok(!T.nextCandidates(load()).some((c) => c.id === 'F01-02'), 'задача с неразрешённой зависимостью не выдаётся');
  assert.deepEqual(T.showItem(load(), 'F01-02').openDeps.map((d) => d.missing), [true]);
  assert.match(T.renderBoard(load()), /«F01-01 Основа» \(нет в плане\)/);
  fs.renameSync(renamed, a.file);
  fs.writeFileSync(a.file, read(a.file).replace('# F01-01 Основа v2', '# F01-01 Основа'));
  // (2) отменили зависимость
  assert.deepEqual(T.setStatus(load(), 'F01-01', 'cancelled', { log: 'не нужна.' }).waiting.map((x) => x.id), ['F01-02']);
  assert.ok(codes(T.checkPlan(load()).warnings).includes('dep-cancelled'));
  assert.match(T.renderBoard(load()), /\(отменена\)/);
  // (3) отменили фичу
  assert.deepEqual(T.setStatus(load(), 'F-02', 'cancelled', { log: 'фича отменена.' }).openChildren.map((x) => x.id), ['F02-01']);
  assert.ok(!T.nextCandidates(load()).some((c) => c.id === 'F02-01'));
  assert.ok(codes(T.checkPlan(load()).warnings).includes('parent-closed'));
  assert.equal(T.setStatus(load(), 'F02-01', 'in-progress', {}).code, 'parent-closed');
}));

// ─── 8. ID не переиспользуются ──────────────────────────────────────────────

test('8. после move прежний ID не выдаётся снова, хранится в former_ids, по нему задача находится', () => project(({ root, make, load }) => {
  for (const t of ['Раз', 'Два', 'Три']) make('task', { title: t, parent: 'F-01' });
  assert.equal(T.moveItem(root, 'F01-03', 'F-02').id, 'F02-01');
  assert.equal(make('task', { title: 'Новая', parent: 'F-01' }).id, 'F01-04', 'F01-03 не выдан повторно');
  assert.equal(T.showItem(load(), 'F01-03').id, 'F02-01', 'поиск по прежнему ID');
  // второй перенос: история в журнале не переписывается
  assert.equal(T.moveItem(root, 'F02-01', 'F-01').id, 'F01-05');
  const t = load().byId.get('F01-05');
  assert.deepEqual(t.formerIds, ['F01-03', 'F02-01']);
  const body = read(path.join(root, t.file));
  assert.match(body, /ID F01-03 → F02-01\./);
  assert.match(body, /ID F02-01 → F01-05\./);
  assert.deepEqual(T.checkPlan(load()).errors, []);
}));

// ─── 9. /task:next <ID> ─────────────────────────────────────────────────────

test('9. /task:next <ID> разбирает in-progress, review и draft', () => {
  const s = read(path.join(PLUGIN, 'skills', 'next', 'SKILL.md'));
  for (const st of ['in-progress', 'review', 'draft']) assert.match(s, new RegExp(`\`${st}\` →`), st);
  assert.match(s, /--take/);
});

// ─── 10. переименования ID ──────────────────────────────────────────────────

test('10. migrate: новый ID не совпадает с занятым, замены не сцепляются', () => {
  const root = tmp('cr-mig-');
  try {
    const E = 'E-01 Э', F1 = `${E}/F-01 Раз`, F2 = `${E}/F-02 Два`;
    const sum = '> **Что:** ч.\n> **Зачем:** з.\n> **Готово, когда:** г.\n';
    const task = (id, title, parent, deps = 'depends_on: []') => `---\nid: ${id}\ntype: task\nstatus: ready\npriority: must\nsize: S\nparent: "[[${parent}]]"\n${deps}\ncreated: 2026-09-27\n---\n# ${id} ${title}\n\n${sum}\n## Критерии готовности\n\n- [ ] к\n\n## Журнал\n`;
    const files = {
      [`${E}/${E}.md`]: `---\nid: E-01\ntype: epic\nstatus: ready\npriority: must\ncreated: 2026-09-27\n---\n# ${E}\n\n${sum}\n## Журнал\n`,
      [`${F1}/F-01 Раз.md`]: FEATURE('F-01', 'Раз', E).replace('status: draft', 'status: ready'),
      [`${F2}/F-02 Два.md`]: FEATURE('F-02', 'Два', E).replace('status: draft', 'status: ready'),
      [`${F1}/F01-01 Своя.md`]: task('F01-01', 'Своя', 'F-01 Раз'),
      [`${F2}/F01-02 Перенесённая.md`]: task('F01-02', 'Перенесённая', 'F-02 Два'), // перенесли правкой parent, без move
      ['Tasks/T-005 Старая.md']: task('T-005', 'Старая', 'F-01 Раз', 'depends_on:\n  - "[[F01-02 Перенесённая]]"'),
    };
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }
    const res = T.migratePlan(root, { date: '2026-10-01' });
    assert.deepEqual(res.renames, [{ oldId: 'T-005', newId: 'F01-03' }, { oldId: 'F01-02', newId: 'F02-01' }]);
    const plan = T.loadPlan(root);
    assert.deepEqual(T.checkPlan(plan).errors, []);
    assert.equal(plan.byId.get('F01-03').name, 'F01-03 Старая');
    assert.deepEqual(plan.byId.get('F01-03').deps.map((d) => d.name), ['F02-01 Перенесённая']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('10. move: ID в названии другой задачи не переписывается; $ в названиях не портит подстановки', () => project(({ root, make, load }) => {
  make('task', { title: 'Основа', parent: 'F-01' });
  const tail = make('task', { title: 'Хвосты после F01-01', parent: 'F-01', depends: ['F01-01'] });
  const user = make('task', { title: 'Потребитель', parent: 'F-01', depends: ['F01-02'] });
  fs.writeFileSync(user.file, read(user.file).replace('## Детали\n', '## Детали\n\nСм. F01-01.\n'));
  T.moveItem(root, 'F01-01', 'F-02');
  assert.deepEqual(T.checkPlan(load()).errors, []);
  assert.match(read(tail.file), /^# F01-02 Хвосты после F01-01$/m, 'заголовок другой задачи не тронут');
  assert.match(read(user.file), /См\. F02-01\./, 'упоминание в тексте обновлено');
  // $-шаблоны в названиях
  make('feature', { title: "Скидка $& и $' хвост", parent: 'E-02' });
  const t = make('task', { title: 'Цена $$ и $1', parent: 'F-01' });
  make('task', { title: 'Зависимая', parent: 'F-01', depends: [t.id] });
  const idea = make('idea', { title: 'Идея' });
  T.setStatus(load(), 'I-001', 'done', { promotedTo: t.id });
  assert.match(read(idea.file), /^promoted_to: "\[\[F01-04 Цена \$\$ и \$1\]\]"$/m);
  T.moveItem(root, t.id, 'F-03');
  assert.deepEqual(T.checkPlan(load()).errors, []);
}));

// ─── 11. BOM и переводы строк ───────────────────────────────────────────────

test('11. файл с BOM и CRLF читается; set и move сохраняют BOM и CRLF', () => project(({ root, make, load }) => {
  const t = make('task', { title: 'С BOM', parent: 'F-01', status: 'ready' });
  fs.writeFileSync(t.file, `﻿${read(t.file).replace(/\n/g, '\r\n')}`);
  assert.ok(!codes(T.checkPlan(load()).errors).includes('no-frontmatter'));
  assert.equal(T.setStatus(load(), 'F01-01', 'in-progress', { log: 'взята.' }).error, undefined);
  const check = (raw) => { assert.ok(raw.startsWith('﻿---\r\n')); assert.ok(!/[^\r]\n/.test(raw), 'нет одиночных LF'); };
  check(read(t.file));
  const m = T.moveItem(root, 'F01-01', 'F-02');
  check(read(path.join(root, 'E-01 Первый', 'F-02 Два', `${m.name}.md`)));
}));

// ─── 12. один план для хука и скрипта ───────────────────────────────────────

test('12. вложенный проект: хук и скрипт находят один план; владение хранится в плане', () => {
  const outer = tmp('cr-outer-');
  try {
    T.initProject(outer);
    const inner = path.join(outer, 'examples', 'game');
    const src = path.join(inner, 'src');
    fs.mkdirSync(src, { recursive: true });
    T.initProject(inner);
    const root = path.join(inner, 'Docs', 'Tasks');
    assert.equal(T.findRoot(null, { cwd: src, projectDir: outer }), root);
    for (const [type, opts] of [['epic', { title: 'Э' }], ['feature', { title: 'Ф', parent: 'E-01' }], ['task', { title: 'Игра', parent: 'F-01', status: 'ready' }]]) T.createItem(T.loadPlan(root), type, opts);
    T.setStatus(T.loadPlan(root), 'F01-01', 'in-progress', { log: 'взята в работу.', session: 'S' });
    assert.match(T.runHook('stop', { cwd: src, session_id: 'S' }, { CLAUDE_PROJECT_DIR: outer }).stdout, /F01-01 Игра/);
    assert.equal(T.runHook('stop', { cwd: outer, session_id: 'S' }, { CLAUDE_PROJECT_DIR: outer }).stdout, '', 'во внешнем плане у сессии задач нет');
  } finally { fs.rmSync(outer, { recursive: true, force: true }); }
});

// ─── 13. критерии и подсказки шаблона ───────────────────────────────────────

test('13. пустой пункт шаблона — не критерий; оставшиеся подсказки шаблона — предупреждение', () => project(({ make, load }) => {
  make('task', { title: 'Пустая', parent: 'F-01', status: 'ready' });
  make('bug', { title: 'Ошибка', parent: 'F-01', status: 'draft' });
  const plan = load();
  assert.deepEqual(plan.byId.get('F01-01').criteria, { total: 0, open: 0, waived: 0 });
  assert.deepEqual(plan.byId.get('F01-02').criteria.total, 1, 'пункт-подсказка бага не считается');
  const w = (id) => codes(T.checkPlan(plan).warnings.filter((x) => x.id === id));
  assert.ok(w('F01-01').includes('no-criteria'));
  assert.ok(w('F01-01').includes('template-hints'));
  assert.ok(!w('F01-02').includes('template-hints'), 'у черновика подсказки допустимы');
}));

// ─── 14. блокировка плана ───────────────────────────────────────────────────

const run = (cwd, args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: ENV });
  let out = ''; c.stdout.on('data', (d) => { out += d; });
  c.on('close', (code) => resolve({ code, out }));
});

test('14. параллельные new получают разные ID', async () => {
  const p = tmp('cr-lock-');
  try {
    T.initProject(p);
    const root = path.join(p, 'Docs', 'Tasks');
    T.createItem(T.loadPlan(root), 'epic', { title: 'Э' });
    T.createItem(T.loadPlan(root), 'feature', { title: 'Ф', parent: 'E-01' });
    const res = await Promise.all([1, 2, 3, 4].map((i) => run(p, ['new', 'task', '--title', `Агент ${i}`, '--parent', 'F-01', '--json'])));
    const ids = res.map((r) => JSON.parse(r.out).id).sort();
    assert.deepEqual(ids, ['F01-01', 'F01-02', 'F01-03', 'F01-04']);
    assert.ok(!codes(T.checkPlan(T.loadPlan(root)).errors).includes('duplicate-id'));
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

test('14. занятый план ждёт, зависший lock снимается', async () => {
  const p = tmp('cr-wait-');
  try {
    T.initProject(p);
    const root = path.join(p, 'Docs', 'Tasks');
    T.createItem(T.loadPlan(root), 'epic', { title: 'Э' });
    T.createItem(T.loadPlan(root), 'feature', { title: 'Ф', parent: 'E-01' });
    const dir = path.join(root, 'E-01 Э', 'F-01 Ф');
    const has = (t) => fs.readdirSync(dir).some((f) => f.includes(t));
    const lock = path.join(root, '.claude-tasks', 'lock');
    fs.writeFileSync(lock, 'other');
    const pending = run(p, ['new', 'task', '--title', 'После блокировки', '--parent', 'F-01', '--json']);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!has('После блокировки'), 'пока план занят — файла нет');
    fs.rmSync(lock);
    assert.equal((await pending).code, 0);
    assert.ok(has('После блокировки'));
    // зависший lock (старше 10 с) снимается сам
    fs.writeFileSync(lock, 'dead');
    const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
    assert.equal(T.createItem(T.loadPlan(root), 'task', { title: 'Поверх зависшего', parent: 'F-01' }).error, undefined);
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

// ─── 15. allowed-tools скилов ───────────────────────────────────────────────

test('15. скилы заранее разрешают только скрипт плагина, а не любой node', () => {
  for (const s of fs.readdirSync(path.join(PLUGIN, 'skills'))) {
    const fm = read(path.join(PLUGIN, 'skills', s, 'SKILL.md')).match(/^---\n([\s\S]*?)\n---/)[1];
    const allowed = fm.match(/^allowed-tools:(.*)$/m)?.[1] || '';
    assert.doesNotMatch(allowed, /\b(Bash|PowerShell)\(node:\*\)/, s);
  }
});

// ─── 16–22. мелкие ──────────────────────────────────────────────────────────

test('17. move пишет только изменившиеся файлы; пустые папки пользователя не удаляет', () => project(({ root, make }) => {
  for (let i = 0; i < 3; i++) make('task', { title: `Т${i}`, parent: 'F-02' });
  make('task', { title: 'Переносимая', parent: 'F-01' });
  fs.mkdirSync(path.join(root, 'Черновики'));
  const old = new Date('2020-01-01');
  for (const f of tree(root)) fs.utimesSync(path.join(root, f), old, old);
  T.moveItem(root, 'F01-01', 'F-02');
  const touched = tree(root).filter((f) => fs.statSync(path.join(root, f)).mtime > old);
  assert.deepEqual(touched, ['Board.md', 'E-01 Первый/F-02 Два/F02-04 Переносимая.md']);
  assert.ok(fs.existsSync(path.join(root, 'Черновики')), 'пустая папка пользователя осталась');
}));

test('18. set: запись — в раздел «Журнал», даже если после него есть раздел; нет строки status — добавляется; нет id — ошибка', () => project(({ p, make, load }) => {
  const t = make('task', { title: 'Раздел после журнала', parent: 'F-01', status: 'ready' });
  fs.appendFileSync(t.file, '\n## Ссылки\n\n- макет\n');
  T.setStatus(load(), 'F01-01', 'in-progress', { log: 'взята.' });
  T.setStatus(load(), 'F01-01', 'in-progress', { log: 'итог.' });
  assert.equal(load().byId.get('F01-01').logEntries, 2);
  assert.match(read(t.file), /взята\.\n- \*\*.*итог\.\n\n## Ссылки\n\n- макет\n$/);
  const u = make('task', { title: 'Без статуса', parent: 'F-01' });
  fs.writeFileSync(u.file, read(u.file).replace(/^status: .*\n/m, ''));
  assert.equal(T.setStatus(load(), 'F01-02', 'ready').item.status, 'ready');
  assert.match(read(u.file), /^type: task\nstatus: ready$/m);
  fs.writeFileSync(u.file, read(u.file).replace(/^id: .*\n/m, ''));
  const before = read(u.file);
  assert.match(T.setStatus(load(), 'F01-02 Без статуса', 'draft').error, /нет поля id/);
  assert.equal(read(u.file), before, 'файл не тронут');
  // итоговое сообщение для эпика — про фичи
  T.setStatus(load(), 'F-02', 'done');
  const out = cli(p, ['set', 'F-01', 'cancelled', '--log', 'отменена.']);
  assert.match(out.stdout, /Все фичи эпика E-01 Первый закрыты/);
}));

test('19. задача с названием на «Board» — её правки проверяются', () => project(({ p, make }) => {
  const t = make('task', { title: 'Game Board', parent: 'F-01' });
  fs.writeFileSync(t.file, read(t.file).replace('parent: "[[F-01 Раз]]"', 'parent: "[[F-09 Нет]]"'));
  const r = T.runHook('post-tool-use', { cwd: p, session_id: 'S', tool_name: 'Edit', tool_input: { file_path: t.file, old_string: 'a', new_string: 'b' } }, {});
  assert.match(r.stdout, /битая ссылка \[\[F-09 Нет\]\]/);
}));

test('20. init сохраняет CRLF и BOM в CLAUDE.md и .gitignore', () => {
  const p = tmp('cr-crlf-');
  try {
    fs.writeFileSync(path.join(p, 'CLAUDE.md'), '﻿# Проект\r\n\r\nПравила.\r\n');
    fs.writeFileSync(path.join(p, '.gitignore'), 'node_modules/\r\n');
    T.initProject(p, { claudeMd: true, gitignore: true });
    for (const f of ['CLAUDE.md', '.gitignore']) {
      const raw = read(path.join(p, f));
      assert.ok(!/[^\r]\n/.test(raw), `${f}: нет одиночных LF`);
      if (f === 'CLAUDE.md') assert.ok(raw.startsWith('﻿# Проект'));
    }
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

test('21. CLI: ошибки без стека; list --type через запятую; ID из имени файла не выдаётся снова', () => project(({ p, root, make, load }) => {
  const e = cli(p, ['new-id', 'task']);
  assert.equal(e.status, 2);
  assert.match(e.stderr, /^Ошибка: для задачи нужна фича/);
  assert.doesNotMatch(e.stderr, /\n\s+at /, 'без стека');
  assert.match(cli(p, ['list', '--root']).stderr, /у --root нет значения/);
  make('task', { title: 'Задача', parent: 'F-01' });
  make('bug', { title: 'Ошибка', parent: 'F-01' });
  assert.deepEqual(T.listItems(load(), { type: 'task, bug' }).map((x) => x.id), ['F01-01', 'F01-02']);
  fs.writeFileSync(path.join(root, 'E-01 Первый', 'F-01 Раз', 'F01-03 Сломанная.md'), 'без frontmatter\n');
  assert.equal(T.nextId(load(), 'task', 'F-01'), 'F01-04');
}));

test('22. название с точкой или пробелом в конце, с переводом строки — отказ', () => project(({ load }) => {
  for (const title of ['Версия 1.', 'Две\nстроки']) assert.ok(T.createItem(load(), 'feature', { title, parent: 'E-01' }).error, JSON.stringify(title));
}));
