// Тесты скрипта плана: node --test plugin/scripts/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlan, checkPlan, parseFrontmatter, extractLinks, stripCode } from '../tasks.mjs';

// ─── Конструктор тестовых планов ────────────────────────────────────────────

// Иерархия: эпик «E-01 Эпик/», фича «E-01 Эпик/F-01 Фича/», задачи — в папке фичи; идеи и ADR — Backlog/, Adr/.
const E = 'E-01 Эпик', F = `${E}/F-01 Фича`;
const place = (type, name) => ({ epic: `${name}/${name}.md`, feature: `${E}/${name}/${name}.md`, idea: `Backlog/${name}.md`, adr: `Adr/${name}.md` }[type] || `${F}/${name}.md`);
const SUMMARY = {
  idea: '> **Что:** идея.\n> **Зачем:** польза.',
  adr: '> **Решение:** выбор.\n> **Почему:** довод.\n> **Следствия:** влияние.',
  default: '> **Что:** что делаем.\n> **Зачем:** зачем.\n> **Готово, когда:** условие.',
};

function file({ id, title, type, fm = {}, body, summary, sections }) {
  const name = `${id} ${title}`;
  const front = { id, type, status: 'draft', created: '2026-09-27', ...fm };
  const yaml = Object.entries(front).map(([k, v]) => {
    if (v === undefined) return null;
    if (Array.isArray(v)) return v.length ? `${k}:\n${v.map((x) => `  - "${x}"`).join('\n')}` : `${k}: []`;
    return `${k}: ${v}`;
  }).filter(Boolean).join('\n');
  const sum = summary ?? SUMMARY[type] ?? SUMMARY.default;
  const secs = sections ?? (['idea', 'adr'].includes(type) ? '' : '## Критерии готовности\n\n- [ ] критерий\n\n## Журнал\n');
  return { rel: place(type, name), text: `---\n${yaml}\n---\n# ${name}\n\n${sum}\n\n${body ?? ''}${secs}` };
}

// Минимальный корректный план: эпик → фича → две задачи (F01-02 зависит от F01-01)
function basePlan() {
  return {
    E1: file({ id: 'E-01', title: 'Эпик', type: 'epic', fm: { priority: 'must' } }),
    F1: file({ id: 'F-01', title: 'Фича', type: 'feature', fm: { priority: 'must', parent: '"[[E-01 Эпик]]"' } }),
    T1: file({ id: 'F01-01', title: 'Первая', type: 'task', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } }),
    T2: file({ id: 'F01-02', title: 'Вторая', type: 'task', fm: { priority: 'must', size: 'M', parent: '"[[F-01 Фича]]"', depends_on: ['[[F01-01 Первая]]'] } }),
  };
}

function check(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  for (const f of Object.values(files)) {
    const p = path.join(root, f.rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.text);
  }
  try { return checkPlan(loadPlan(root)); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const codes = (list) => list.map((e) => e.code);

// ─── Разбор ─────────────────────────────────────────────────────────────────

test('frontmatter: скаляры, кавычки, пустой и inline-список, блочный список', () => {
  const { fm, problems } = parseFrontmatter('id: F01-01\nparent: "[[F-01 Фича]]"\na: []\nb: ["[[X, y]]", z]\nc:\n  - "[[F01-02 Два]]"\n  - q');
  assert.deepEqual(problems, []);
  assert.equal(fm.id, 'F01-01');
  assert.equal(fm.parent, '[[F-01 Фича]]');
  assert.deepEqual(fm.a, []);
  assert.deepEqual(fm.b, ['[[X, y]]', 'z']);
  assert.deepEqual(fm.c, ['[[F01-02 Два]]', 'q']);
});

test('ссылки: алиас, раздел, \\| в таблице; код не считается', () => {
  assert.deepEqual(extractLinks('[[A|a]] [[B#Раздел|b]] [[C\\|c]]'), ['A', 'B', 'C']);
  assert.deepEqual(extractLinks(stripCode('`[[X]]`\n```\n[[Y]]\n```\n[[Z]]')), ['Z']);
});

// ─── Корректный план ────────────────────────────────────────────────────────

test('корректный план — без ошибок и предупреждений', () => {
  const r = check(basePlan());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('CRLF в файлах не мешает разбору', () => {
  const p = basePlan();
  for (const k of Object.keys(p)) p[k].text = p[k].text.replace(/\n/g, '\r\n');
  assert.deepEqual(check(p).errors, []);
});

// ─── Ошибки ─────────────────────────────────────────────────────────────────

test('цикл зависимостей', () => {
  const p = basePlan();
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: ['[[F01-02 Вторая]]'] } });
  const r = check(p);
  assert.ok(codes(r.errors).includes('cycle'));
  assert.equal(r.errors.filter((e) => e.code === 'cycle').length, 1, 'цикл сообщается один раз');
});

test('битая ссылка — в теле и в depends_on', () => {
  const p = basePlan();
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', body: 'См. [[Нет такого]].\n\n', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: ['[[F01-99 Нет]]'] } });
  const r = check(p);
  assert.equal(r.errors.filter((e) => e.code === 'broken-link').length, 2);
});

test('ссылка в коде — не битая', () => {
  const p = basePlan();
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', body: 'Пример: `[[F01-05 …\\|F01-05]]`\n\n```\n[[Нет]]\n```\n\n', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.deepEqual(check(p).errors, []);
});

test('дубль ID', () => {
  const p = basePlan();
  p.T3 = file({ id: 'F01-01', title: 'Дубль', type: 'task', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.ok(codes(check(p).errors).includes('duplicate-id'));
});

test('неизвестные тип и статус', () => {
  const p = basePlan();
  p.X = { rel: `${F}/F01-03 Странная.md`, text: '---\nid: F01-03\ntype: story\nstatus: draft\ncreated: 2026-09-27\n---\n# F01-03 Странная\n' };
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', fm: { status: 'blocked', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  const c = codes(check(p).errors);
  assert.ok(c.includes('unknown-type'));
  assert.ok(c.includes('unknown-status'));
});

test('нет parent у задачи и у фичи', () => {
  const p = basePlan();
  p.F1 = file({ id: 'F-01', title: 'Фича', type: 'feature', fm: { priority: 'must' } });
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', fm: { priority: 'must', size: 'S', depends_on: [] } });
  const missing = check(p).errors.filter((e) => e.code === 'missing-field').map((e) => e.id);
  assert.deepEqual(missing.sort(), ['F-01', 'F01-01']);
});

test('parent не той категории и зависимость не от задачи', () => {
  const p = basePlan();
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', fm: { priority: 'must', size: 'S', parent: '"[[E-01 Эпик]]"', depends_on: ['[[F-01 Фича]]'] } });
  const c = codes(check(p).errors);
  assert.ok(c.includes('parent-type'));
  assert.ok(c.includes('dep-type'));
});

test('ID, имя файла, заголовок, папка', () => {
  const p = basePlan();
  p.T1 = { ...p.T1, rel: 'Features/T-01 Первая.md', text: p.T1.text.replace('id: F01-01', 'id: T-01').replace('# F01-01 Первая', '# Другое') };
  const c = codes(check(p).errors);
  for (const code of ['bad-id', 'wrong-folder', 'heading']) assert.ok(c.includes(code), code);
});

test('задача с ID чужой фичи', () => {
  const p = basePlan();
  p.T1 = file({ id: 'F02-01', title: 'Первая', type: 'task', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.ok(codes(check(p).errors).includes('id-parent'));
});

test('задача лежит не в папке своей фичи', () => {
  const p = basePlan();
  p.T1 = { ...p.T1, rel: `${E}/F01-01 Первая.md` };
  assert.ok(codes(check(p).errors).includes('wrong-folder'));
});

test('недопустимые priority и size', () => {
  const p = basePlan();
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', fm: { priority: 'high', size: 'XL', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.equal(check(p).errors.filter((e) => e.code === 'bad-value').length, 2);
});

test('parent — не ссылка', () => {
  const p = basePlan();
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', fm: { priority: 'must', size: 'S', parent: 'F-01', depends_on: [] } });
  assert.ok(codes(check(p).errors).includes('bad-link-field'));
});

// ─── Предупреждения ─────────────────────────────────────────────────────────

test('пустой и отсутствующий «Коротко»', () => {
  const p = basePlan();
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', summary: '> **Что:** <!-- подсказка -->\n> **Зачем:** есть.', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  p.T2 = file({ id: 'F01-02', title: 'Вторая', type: 'task', summary: 'Просто текст.', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  const c = codes(check(p).warnings);
  for (const code of ['summary-empty', 'summary-field', 'no-summary']) assert.ok(c.includes(code), code);
});

test('ready без критериев', () => {
  const p = basePlan();
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', sections: '## Журнал\n', fm: { status: 'ready', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.ok(codes(check(p).warnings).includes('no-criteria'));
});

test('done с неотмеченными критериями и без журнала', () => {
  const p = basePlan();
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', fm: { status: 'done', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  const c = codes(check(p).warnings);
  assert.ok(c.includes('open-criteria'));
  assert.ok(c.includes('empty-log'));
});

test('зачёркнутый критерий снят — done без предупреждения', () => {
  const p = basePlan();
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', sections: '## Критерии готовности\n\n- [x] сделано\n- [ ] ~~снято~~ → перенесено в [[F01-02 Вторая]]\n\n## Журнал\n\n- **2026-09-27 · qa:** готово.\n', fm: { status: 'done', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.ok(!codes(check(p).warnings).includes('open-criteria'));
});

test('in-progress при незакрытой зависимости', () => {
  const p = basePlan();
  p.T2 = file({ id: 'F01-02', title: 'Вторая', type: 'task', fm: { status: 'in-progress', priority: 'must', size: 'M', parent: '"[[F-01 Фича]]"', depends_on: ['[[F01-01 Первая]]'] } });
  assert.ok(codes(check(p).warnings).includes('in-progress-blocked'));
});

test('несколько in-progress у одной роли', () => {
  const p = basePlan();
  const log = '## Критерии готовности\n\n- [ ] к\n\n## Журнал\n\n- **2026-09-27 · qa:** взята.\n';
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', sections: log, fm: { status: 'in-progress', role: 'qa', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  p.T3 = file({ id: 'F01-03', title: 'Третья', type: 'task', sections: log, fm: { status: 'in-progress', role: 'qa', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.equal(check(p).warnings.filter((w) => w.code === 'role-busy').length, 2);
});

test('нет журнала у задачи; идея done без promoted_to', () => {
  const p = basePlan();
  p.T1 = file({ id: 'F01-01', title: 'Первая', type: 'task', sections: '## Критерии готовности\n\n- [ ] к\n', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  p.I1 = file({ id: 'I-001', title: 'Идея', type: 'idea', fm: { status: 'done' } });
  const c = codes(check(p).warnings);
  assert.ok(c.includes('no-log'));
  assert.ok(c.includes('no-promoted'));
});

test('research done без ADR — предупреждение; с ADR — нет', () => {
  const p = basePlan();
  const done = '## Критерии готовности\n\n- [x] к\n\n## Журнал\n\n- **2026-09-27 · architect:** готово.\n';
  p.R = file({ id: 'F01-03', title: 'Выбор', type: 'research', sections: done, fm: { status: 'done', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.ok(codes(check(p).warnings).includes('research-no-adr'));
  p.A = file({ id: 'ADR-001', title: 'Решение', type: 'adr', fm: { status: 'accepted', task: '"[[F01-03 Выбор]]"' } });
  assert.ok(!codes(check(p).warnings).includes('research-no-adr'));
});

test('битая ссылка на доске', () => {
  const p = basePlan();
  p.B = { rel: 'Board.md', text: '# Доска\n\n[[F01-04 Нет]]\n' };
  assert.ok(codes(check(p).errors).includes('broken-link'));
});

// ─── Доска, next, new-id (F01-07) ────────────────────────────────────────────

import { nextCandidates, renderBoard, nextId } from '../tasks.mjs';

function withPlan(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  for (const f of Object.values(files)) {
    const p = path.join(root, f.rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.text);
  }
  try { return fn(loadPlan(root), root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const task = (id, title, fm) => file({ id, title, type: 'task', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [], ...fm } });

test('next: только ready без открытых зависимостей; порядок — текущий спринт, затем по ID', () => {
  const p = basePlan();
  p.T1 = task('F01-01', 'Первая', { status: 'ready', priority: 'should' });
  p.T2 = task('F01-02', 'Вторая', { status: 'ready', depends_on: ['[[F01-01 Первая]]'] });          // заблокирована
  p.T3 = task('F01-03', 'Третья', { status: 'ready', priority: 'should', sprint: 'S-02' });
  p.T4 = task('F01-04', 'Четвёртая', { status: 'ready', priority: 'must' });
  p.T5 = task('F01-05', 'Пятая', { status: 'ready', priority: 'must', sprint: 'S-01' });
  p.T6 = task('F01-06', 'Шестая', { status: 'draft' });
  // F01-01 разблокирует F01-02 → при равном приоритете выше F01-07
  p.T7 = task('F01-07', 'Седьмая', { status: 'ready', priority: 'should' });
  const ids = withPlan(p, (plan) => nextCandidates(plan).map((c) => c.id));
  // S-01 — текущий спринт (наименьший среди открытых задач); дальше строго по ID — приоритет не переставляет
  assert.deepEqual(ids, ['F01-05', 'F01-01', 'F01-03', 'F01-04', 'F01-07']);
});

test('next --role фильтрует по свободной метке', () => {
  const p = basePlan();
  p.T1 = task('F01-01', 'Первая', { status: 'ready', role: 'artist' });
  p.T2 = task('F01-02', 'Вторая', { status: 'ready', role: 'qa' });
  assert.deepEqual(withPlan(p, (plan) => nextCandidates(plan, { role: 'qa' }).map((c) => c.id)), ['F01-02']);
});

test('доска: разделы, порядок по ID, «Ждёт» — только открытые зависимости, ссылки валидны', () => {
  const p = basePlan();
  p.T1 = task('F01-01', 'Первая', { status: 'done' });
  p.T3 = task('F01-03', 'Третья', { status: 'in-progress' });
  p.T2 = task('F01-02', 'Вторая', { status: 'ready', depends_on: ['[[F01-01 Первая]]', '[[F01-03 Третья]]'] });
  p.T10 = task('F01-10', 'Десятая', { status: 'ready' });
  p.T9 = task('F01-09', 'Девятая', { status: 'ready' });
  p.I1 = file({ id: 'I-001', title: 'Идея', type: 'idea', fm: { status: 'idea' } });
  withPlan(p, (plan, root) => {
    const board = renderBoard(plan);
    for (const s of ['## Готово к работе', '## В работе', '## Заблокировано', '## Готово', '## План', '## Бэклог']) assert.ok(board.includes(s), s);
    assert.ok(board.indexOf('[[F01-09 Девятая]]') < board.indexOf('[[F01-10 Десятая]]'), 'F01-09 раньше F01-10');
    const blockedRow = board.split('\n').find((l) => l.startsWith('| [[F01-02 Вторая]]'));
    assert.equal(blockedRow, '| [[F01-02 Вторая]] | [[F01-03 Третья\\|F01-03]] |');
    assert.ok(board.includes('руками не править'));
    fs.writeFileSync(path.join(root, 'Board.md'), board);
    assert.deepEqual(checkPlan(loadPlan(root)).errors, [], 'ссылки доски валидны');
  });
});

test('new-id: номер задачи внутри фичи, с учётом всех файлов', () => {
  const p = basePlan();
  p.T9 = task('F01-09', 'Девятая', { status: 'cancelled' });
  withPlan(p, (plan) => {
    assert.equal(nextId(plan, 'task', 'F-01'), 'F01-10');
    assert.equal(nextId(plan, 'bug', 'F-01 Фича'), 'F01-10');
    assert.throws(() => nextId(plan, 'task'), /нужна фича/);
    assert.equal(nextId(plan, 'epic'), 'E-02');
    assert.equal(nextId(plan, 'feature'), 'F-02');
    assert.equal(nextId(plan, 'idea'), 'I-001');
    assert.equal(nextId(plan, 'adr'), 'ADR-001');
  });
});
