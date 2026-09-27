// Тесты init: node --test plugin/scripts/test/init.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initProject, loadPlan, checkPlan } from '../tasks.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('пустой проект: папки, Readme, доска; план проходит проверку', () => {
  const p = tmp();
  try {
    const res = initProject(p);
    for (const d of ['Epics', 'Features', 'Tasks', 'Backlog', 'Adr']) assert.ok(fs.existsSync(path.join(p, 'Docs', 'Tasks', d, '.gitkeep')), d);
    assert.ok(read(p, 'Docs', 'Tasks', 'Readme.md').includes('# План задач'));
    assert.ok(read(p, 'Docs', 'Tasks', 'Board.md').includes('руками не править'));
    assert.equal(res.items, 0);
    const r = checkPlan(loadPlan(path.join(p, 'Docs', 'Tasks')));
    assert.deepEqual(r.errors, []);
    assert.ok(!fs.existsSync(path.join(p, 'CLAUDE.md')), 'без флага CLAUDE.md не трогаем');
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

test('повторный init не трогает задачи и Readme, блок CLAUDE.md не дублируется', () => {
  const p = tmp();
  try {
    initProject(p, { claudeMd: true });
    const task = path.join(p, 'Docs', 'Tasks', 'Tasks', 'T-001 Моя задача.md');
    fs.writeFileSync(task, 'моё содержимое');
    fs.writeFileSync(path.join(p, 'Docs', 'Tasks', 'Readme.md'), 'мой readme');
    initProject(p, { claudeMd: true });
    assert.equal(read(task), 'моё содержимое');
    assert.equal(read(p, 'Docs', 'Tasks', 'Readme.md'), 'мой readme');
    assert.equal(read(p, 'CLAUDE.md').match(/task:begin/g).length, 1);
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

test('CLAUDE.md: блок добавляется к существующему тексту и обновляется на месте', () => {
  const p = tmp();
  try {
    fs.writeFileSync(path.join(p, 'CLAUDE.md'), '# Мой проект\n\nПравила.\n');
    initProject(p, { claudeMd: true });
    let t = read(p, 'CLAUDE.md');
    assert.ok(t.startsWith('# Мой проект\n\nПравила.\n\n<!-- task:begin'));
    fs.writeFileSync(path.join(p, 'CLAUDE.md'), t.replace('## Работа с задачами', '## Старый заголовок') + '\nХвост.\n');
    initProject(p, { claudeMd: true });
    t = read(p, 'CLAUDE.md');
    assert.ok(t.includes('## Работа с задачами') && !t.includes('Старый заголовок'));
    assert.ok(t.endsWith('Хвост.\n'), 'текст после блока сохранён');
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

test('настройки Obsidian сливаются с существующими, .gitignore не дублируется', () => {
  const p = tmp();
  try {
    const obs = path.join(p, 'Docs', 'Tasks', '.obsidian');
    fs.mkdirSync(obs, { recursive: true });
    fs.writeFileSync(path.join(obs, 'app.json'), JSON.stringify({ vimMode: true }));
    fs.writeFileSync(path.join(p, '.gitignore'), 'node_modules/\n');
    initProject(p, { obsidian: true, gitignore: true });
    initProject(p, { obsidian: true, gitignore: true });
    const app = JSON.parse(read(obs, 'app.json'));
    assert.equal(app.vimMode, true);
    assert.equal(app.propertiesInDocument, 'hidden');
    assert.equal(JSON.parse(read(obs, 'graph.json')).showArrow, true);
    const gi = read(p, '.gitignore');
    assert.ok(gi.startsWith('node_modules/\n'));
    assert.equal(gi.match(/Docs\/Tasks\/\.obsidian\//g).length, 1);
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

// ─── help (T-017) ────────────────────────────────────────────────────────────

import { readSkills, renderHelp, planState, shortDescription } from '../tasks.mjs';

test('help: команды собираются из всех скилов плагина, новая появляется сама', () => {
  const real = readSkills();
  const dirs = fs.readdirSync(path.resolve(import.meta.dirname, '..', '..', 'skills'));
  assert.equal(real.length, dirs.length, 'каждый скил в справке');
  assert.equal(real[0].name, 'init', 'порядок по сценарию');
  // Временный плагин с «новой» командой
  const p = tmp();
  try {
    for (const [n, fm] of [['alpha', 'name: alpha\ndescription: Новая команда — длинное пояснение.\nargument-hint: "<x>"\ndisable-model-invocation: true'], ['bg', 'name: bg\ndescription: Фоновый скил — пояснение.']]) {
      fs.mkdirSync(path.join(p, 'skills', n), { recursive: true });
      fs.writeFileSync(path.join(p, 'skills', n, 'SKILL.md'), `---\n${fm}\n---\n# x\n`);
    }
    const out = renderHelp(readSkills(p), { exists: false });
    assert.match(out, /\/task:alpha <x> +Новая команда\n/);
    assert.match(out, /task:bg — Фоновый скил/);
    assert.ok(!out.includes('длинное пояснение'), 'в список — только часть до « — »');
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

test('help: подсказка по состоянию плана', () => {
  const skills = readSkills();
  assert.match(renderHelp(skills, { exists: false }), /начни с \/task:init/);
  assert.match(renderHelp(skills, { exists: true, items: 0, inProgress: [], review: [], next: [] }), /План пуст/);
  const s = renderHelp(skills, { exists: true, items: 5, inProgress: ['T-002'], review: ['T-003'], next: ['T-004'] });
  assert.match(s, /В работе: T-002/);
  assert.match(s, /Ждут вашей проверки: T-003/);
  assert.match(s, /Готово к работе: T-004 — \/task:next/);
  const p = tmp();
  try { initProject(p); assert.equal(planState(path.join(p, 'Docs', 'Tasks')).items, 0); } finally { fs.rmSync(p, { recursive: true, force: true }); }
  assert.equal(shortDescription('Коротко — длинно. Ещё — и ещё.'), 'Коротко');
});

test('help: весь список помещается на экран (до 100 символов в строке, до 30 строк)', () => {
  const out = renderHelp(readSkills(), { exists: true, items: 3, inProgress: ['T-001'], review: [], next: ['T-002'] });
  const lines = out.split('\n');
  assert.ok(lines.length <= 30, `строк: ${lines.length}`);
  for (const l of lines) assert.ok(l.length <= 100, `длинная строка: ${l}`);
});
