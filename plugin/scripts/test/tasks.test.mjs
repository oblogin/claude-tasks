// Тесты скрипта плана: node --test plugin/scripts/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlan, checkPlan, parseFrontmatter, extractLinks, stripCode } from '../tasks.mjs';

// ─── Конструктор тестовых планов ────────────────────────────────────────────

const FOLDER = { epic: 'Epics', feature: 'Features', task: 'Tasks', research: 'Tasks', bug: 'Tasks', idea: 'Backlog', adr: 'Adr' };
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
  return { rel: `${FOLDER[type]}/${name}.md`, text: `---\n${yaml}\n---\n# ${name}\n\n${sum}\n\n${body ?? ''}${secs}` };
}

// Минимальный корректный план: эпик → фича → две задачи (T-002 зависит от T-001)
function basePlan() {
  return {
    E1: file({ id: 'E-01', title: 'Эпик', type: 'epic', fm: { priority: 'must' } }),
    F1: file({ id: 'F-01', title: 'Фича', type: 'feature', fm: { priority: 'must', parent: '"[[E-01 Эпик]]"' } }),
    T1: file({ id: 'T-001', title: 'Первая', type: 'task', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } }),
    T2: file({ id: 'T-002', title: 'Вторая', type: 'task', fm: { priority: 'must', size: 'M', parent: '"[[F-01 Фича]]"', depends_on: ['[[T-001 Первая]]'] } }),
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
  const { fm, problems } = parseFrontmatter('id: T-001\nparent: "[[F-01 Фича]]"\na: []\nb: ["[[X, y]]", z]\nc:\n  - "[[T-002 Два]]"\n  - q');
  assert.deepEqual(problems, []);
  assert.equal(fm.id, 'T-001');
  assert.equal(fm.parent, '[[F-01 Фича]]');
  assert.deepEqual(fm.a, []);
  assert.deepEqual(fm.b, ['[[X, y]]', 'z']);
  assert.deepEqual(fm.c, ['[[T-002 Два]]', 'q']);
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
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: ['[[T-002 Вторая]]'] } });
  const r = check(p);
  assert.ok(codes(r.errors).includes('cycle'));
  assert.equal(r.errors.filter((e) => e.code === 'cycle').length, 1, 'цикл сообщается один раз');
});

test('битая ссылка — в теле и в depends_on', () => {
  const p = basePlan();
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', body: 'См. [[Нет такого]].\n\n', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: ['[[T-999 Нет]]'] } });
  const r = check(p);
  assert.equal(r.errors.filter((e) => e.code === 'broken-link').length, 2);
});

test('ссылка в коде — не битая', () => {
  const p = basePlan();
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', body: 'Пример: `[[T-005 …\\|T-005]]`\n\n```\n[[Нет]]\n```\n\n', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.deepEqual(check(p).errors, []);
});

test('дубль ID', () => {
  const p = basePlan();
  p.T3 = file({ id: 'T-001', title: 'Дубль', type: 'task', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.ok(codes(check(p).errors).includes('duplicate-id'));
});

test('неизвестные тип и статус', () => {
  const p = basePlan();
  p.X = { rel: 'Tasks/T-003 Странная.md', text: '---\nid: T-003\ntype: story\nstatus: draft\ncreated: 2026-09-27\n---\n# T-003 Странная\n' };
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', fm: { status: 'blocked', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  const c = codes(check(p).errors);
  assert.ok(c.includes('unknown-type'));
  assert.ok(c.includes('unknown-status'));
});

test('нет parent у задачи и у фичи', () => {
  const p = basePlan();
  p.F1 = file({ id: 'F-01', title: 'Фича', type: 'feature', fm: { priority: 'must' } });
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', fm: { priority: 'must', size: 'S', depends_on: [] } });
  const missing = check(p).errors.filter((e) => e.code === 'missing-field').map((e) => e.id);
  assert.deepEqual(missing.sort(), ['F-01', 'T-001']);
});

test('parent не той категории и зависимость не от задачи', () => {
  const p = basePlan();
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', fm: { priority: 'must', size: 'S', parent: '"[[E-01 Эпик]]"', depends_on: ['[[F-01 Фича]]'] } });
  const c = codes(check(p).errors);
  assert.ok(c.includes('parent-type'));
  assert.ok(c.includes('dep-type'));
});

test('ID, имя файла, заголовок, папка', () => {
  const p = basePlan();
  p.T1 = { ...p.T1, rel: 'Features/T-01 Первая.md', text: p.T1.text.replace('id: T-001', 'id: T-01').replace('# T-001 Первая', '# Другое') };
  const c = codes(check(p).errors);
  for (const code of ['bad-id', 'wrong-folder', 'heading']) assert.ok(c.includes(code), code);
});

test('недопустимые priority и size', () => {
  const p = basePlan();
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', fm: { priority: 'high', size: 'XL', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.equal(check(p).errors.filter((e) => e.code === 'bad-value').length, 2);
});

test('parent — не ссылка', () => {
  const p = basePlan();
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', fm: { priority: 'must', size: 'S', parent: 'F-01', depends_on: [] } });
  assert.ok(codes(check(p).errors).includes('bad-link-field'));
});

// ─── Предупреждения ─────────────────────────────────────────────────────────

test('пустой и отсутствующий «Коротко»', () => {
  const p = basePlan();
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', summary: '> **Что:** <!-- подсказка -->\n> **Зачем:** есть.', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  p.T2 = file({ id: 'T-002', title: 'Вторая', type: 'task', summary: 'Просто текст.', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  const c = codes(check(p).warnings);
  for (const code of ['summary-empty', 'summary-field', 'no-summary']) assert.ok(c.includes(code), code);
});

test('ready без критериев', () => {
  const p = basePlan();
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', sections: '## Журнал\n', fm: { status: 'ready', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.ok(codes(check(p).warnings).includes('no-criteria'));
});

test('done с неотмеченными критериями и без журнала', () => {
  const p = basePlan();
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', fm: { status: 'done', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  const c = codes(check(p).warnings);
  assert.ok(c.includes('open-criteria'));
  assert.ok(c.includes('empty-log'));
});

test('зачёркнутый критерий снят — done без предупреждения', () => {
  const p = basePlan();
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', sections: '## Критерии готовности\n\n- [x] сделано\n- [ ] ~~снято~~ → перенесено в [[T-002 Вторая]]\n\n## Журнал\n\n- **2026-09-27 · qa:** готово.\n', fm: { status: 'done', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.ok(!codes(check(p).warnings).includes('open-criteria'));
});

test('in-progress при незакрытой зависимости', () => {
  const p = basePlan();
  p.T2 = file({ id: 'T-002', title: 'Вторая', type: 'task', fm: { status: 'in-progress', priority: 'must', size: 'M', parent: '"[[F-01 Фича]]"', depends_on: ['[[T-001 Первая]]'] } });
  assert.ok(codes(check(p).warnings).includes('in-progress-blocked'));
});

test('несколько in-progress у одной роли', () => {
  const p = basePlan();
  const log = '## Критерии готовности\n\n- [ ] к\n\n## Журнал\n\n- **2026-09-27 · qa:** взята.\n';
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', sections: log, fm: { status: 'in-progress', role: 'qa', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  p.T3 = file({ id: 'T-003', title: 'Третья', type: 'task', sections: log, fm: { status: 'in-progress', role: 'qa', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.equal(check(p).warnings.filter((w) => w.code === 'role-busy').length, 2);
});

test('нет журнала у задачи; идея done без promoted_to', () => {
  const p = basePlan();
  p.T1 = file({ id: 'T-001', title: 'Первая', type: 'task', sections: '## Критерии готовности\n\n- [ ] к\n', fm: { priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  p.I1 = file({ id: 'I-001', title: 'Идея', type: 'idea', fm: { status: 'done' } });
  const c = codes(check(p).warnings);
  assert.ok(c.includes('no-log'));
  assert.ok(c.includes('no-promoted'));
});

test('research done без ADR — предупреждение; с ADR — нет', () => {
  const p = basePlan();
  const done = '## Критерии готовности\n\n- [x] к\n\n## Журнал\n\n- **2026-09-27 · architect:** готово.\n';
  p.R = file({ id: 'T-003', title: 'Выбор', type: 'research', sections: done, fm: { status: 'done', priority: 'must', size: 'S', parent: '"[[F-01 Фича]]"', depends_on: [] } });
  assert.ok(codes(check(p).warnings).includes('research-no-adr'));
  p.A = file({ id: 'ADR-001', title: 'Решение', type: 'adr', fm: { status: 'accepted', task: '"[[T-003 Выбор]]"' } });
  assert.ok(!codes(check(p).warnings).includes('research-no-adr'));
});

test('битая ссылка на доске', () => {
  const p = basePlan();
  p.B = { rel: 'Board.md', text: '# Доска\n\n[[T-404 Нет]]\n' };
  assert.ok(codes(check(p).errors).includes('broken-link'));
});

// ─── Доска, next, new-id (T-007) ────────────────────────────────────────────

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

test('next: только ready без открытых зависимостей; порядок спринт → приоритет → разблокирует → ID', () => {
  const p = basePlan();
  p.T1 = task('T-001', 'Первая', { status: 'ready', priority: 'should' });
  p.T2 = task('T-002', 'Вторая', { status: 'ready', depends_on: ['[[T-001 Первая]]'] });          // заблокирована
  p.T3 = task('T-003', 'Третья', { status: 'ready', priority: 'should', sprint: 'S-02' });
  p.T4 = task('T-004', 'Четвёртая', { status: 'ready', priority: 'must' });
  p.T5 = task('T-005', 'Пятая', { status: 'ready', priority: 'must', sprint: 'S-01' });
  p.T6 = task('T-006', 'Шестая', { status: 'draft' });
  // T-001 разблокирует T-002 → при равном приоритете выше T-007
  p.T7 = task('T-007', 'Седьмая', { status: 'ready', priority: 'should' });
  const ids = withPlan(p, (plan) => nextCandidates(plan).map((c) => c.id));
  // S-01 — текущий спринт (наименьший среди открытых задач)
  assert.deepEqual(ids, ['T-005', 'T-004', 'T-001', 'T-003', 'T-007']);
});

test('next --role фильтрует по свободной метке', () => {
  const p = basePlan();
  p.T1 = task('T-001', 'Первая', { status: 'ready', role: 'artist' });
  p.T2 = task('T-002', 'Вторая', { status: 'ready', role: 'qa' });
  assert.deepEqual(withPlan(p, (plan) => nextCandidates(plan, { role: 'qa' }).map((c) => c.id)), ['T-002']);
});

test('доска: разделы, порядок по ID, «Ждёт» — только открытые зависимости, ссылки валидны', () => {
  const p = basePlan();
  p.T1 = task('T-001', 'Первая', { status: 'done' });
  p.T3 = task('T-003', 'Третья', { status: 'in-progress' });
  p.T2 = task('T-002', 'Вторая', { status: 'ready', depends_on: ['[[T-001 Первая]]', '[[T-003 Третья]]'] });
  p.T10 = task('T-010', 'Десятая', { status: 'ready' });
  p.T9 = task('T-009', 'Девятая', { status: 'ready' });
  p.I1 = file({ id: 'I-001', title: 'Идея', type: 'idea', fm: { status: 'idea' } });
  withPlan(p, (plan, root) => {
    const board = renderBoard(plan);
    for (const s of ['## Готово к работе', '## В работе', '## Заблокировано', '## Готово', '## План', '## Бэклог']) assert.ok(board.includes(s), s);
    assert.ok(board.indexOf('[[T-009 Девятая]]') < board.indexOf('[[T-010 Десятая]]'), 'T-009 раньше T-010');
    const blockedRow = board.split('\n').find((l) => l.startsWith('| [[T-002 Вторая]]'));
    assert.equal(blockedRow, '| [[T-002 Вторая]] | [[T-003 Третья\\|T-003]] |');
    assert.ok(board.includes('руками не править'));
    fs.writeFileSync(path.join(root, 'Board.md'), board);
    assert.deepEqual(checkPlan(loadPlan(root)).errors, [], 'ссылки доски валидны');
  });
});

test('new-id: следующий номер с учётом всех файлов, ширина по типу', () => {
  const p = basePlan();
  p.T9 = task('T-009', 'Девятая', { status: 'cancelled' });
  withPlan(p, (plan) => {
    assert.equal(nextId(plan, 'task'), 'T-010');
    assert.equal(nextId(plan, 'bug'), 'T-010');
    assert.equal(nextId(plan, 'feature'), 'F-02');
    assert.equal(nextId(plan, 'idea'), 'I-001');
    assert.equal(nextId(plan, 'adr'), 'ADR-001');
  });
});
