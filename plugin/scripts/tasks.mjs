#!/usr/bin/env node
// Инструмент плана задач claude-tasks: разбор Docs/Tasks/, проверка формата и графа.
// Правила — по спецификации plugin/skills/format/SKILL.md. Без npm-зависимостей.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// ─── Модель формата ─────────────────────────────────────────────────────────

const TASK_STATUSES = ['draft', 'ready', 'in-progress', 'review', 'done', 'cancelled'];
const GROUP_STATUSES = ['draft', 'ready', 'in-progress', 'done', 'cancelled'];
const MAIN_SUMMARY = ['Что', 'Зачем', 'Готово, когда'];

export const TYPES = {
  epic:     { folder: 'Epics',    prefix: 'E',   width: 2, statuses: GROUP_STATUSES, required: ['priority'], parent: null, summary: MAIN_SUMMARY, journal: true },
  feature:  { folder: 'Features', prefix: 'F',   width: 2, statuses: GROUP_STATUSES, required: ['priority', 'parent'], parent: 'epic', summary: MAIN_SUMMARY, journal: true },
  task:     { folder: 'Tasks',    prefix: 'T',   width: 3, statuses: TASK_STATUSES, required: ['priority', 'size', 'parent', 'depends_on'], parent: 'feature', summary: MAIN_SUMMARY, journal: true, work: true },
  research: { folder: 'Tasks',    prefix: 'T',   width: 3, statuses: TASK_STATUSES, required: ['priority', 'size', 'parent', 'depends_on'], parent: 'feature', summary: MAIN_SUMMARY, journal: true, work: true },
  bug:      { folder: 'Tasks',    prefix: 'T',   width: 3, statuses: TASK_STATUSES, required: ['priority', 'size', 'parent', 'depends_on'], parent: 'feature', summary: MAIN_SUMMARY, journal: true, work: true },
  idea:     { folder: 'Backlog',  prefix: 'I',   width: 3, statuses: ['idea', 'done', 'cancelled'], required: [], parent: null, summary: ['Что', 'Зачем'], journal: false },
  adr:      { folder: 'Adr',      prefix: 'ADR', width: 3, statuses: ['proposed', 'accepted', 'superseded'], required: [], parent: null, summary: ['Решение', 'Почему', 'Следствия'], journal: false },
};

export const PRIORITIES = ['must', 'should', 'could'];
export const SIZES = ['XS', 'S', 'M', 'L'];
const SERVICE_FILES = ['Board', 'Readme'];
const H = { criteria: 'Критерии готовности', log: 'Журнал' };

// ─── Разбор файлов ──────────────────────────────────────────────────────────

const unquote = (s) => {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) return t.slice(1, -1);
  return t;
};

// Элементы inline-списка `[a, "b, c", [[x]]]` — запятые внутри кавычек и [[ ]] не делят.
function splitInlineList(inner) {
  const out = []; let cur = ''; let quote = null; let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map(unquote).filter((s) => s !== '');
}

// Подмножество YAML, которое использует формат: `key: value`, `key: []`, `key: [a, b]`, `key:` + строки `  - item`.
export function parseFrontmatter(src) {
  const fm = {}; const problems = []; let listKey = null;
  for (const raw of src.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const item = raw.match(/^\s+-\s*(.*)$/);
    if (item) {
      if (listKey) fm[listKey].push(unquote(item[1]));
      else problems.push(`строка списка без поля: «${raw.trim()}»`);
      continue;
    }
    const kv = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) { problems.push(`не разобрана строка: «${raw.trim()}»`); continue; }
    const [, key, value] = kv;
    listKey = null;
    if (value === '') { fm[key] = []; listKey = key; }
    else if (/^\[.*\]$/.test(value.trim()) && !/^\[\[.*\]\]$/.test(value.trim())) fm[key] = splitInlineList(value.trim().slice(1, -1));
    else fm[key] = unquote(value);
  }
  return { fm, problems };
}

// Текст без блоков кода и `инлайн-кода` — ссылки в коде считаются примерами, а не связями.
export function stripCode(text) {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
}

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

// Цель вики-ссылки: `[[Имя#Раздел|Алиас]]` → «Имя»; `\|` в таблицах тоже поддерживается.
export function extractLinks(text) {
  const links = [];
  for (const m of text.matchAll(/\[\[([^\]]+?)\]\]/g)) {
    const target = m[1].split('|')[0].split('#')[0].replace(/\\$/, '').trim();
    if (target) links.push(target);
  }
  return links;
}

// Значение поля-ссылки `"[[F-07 Прыжок]]"` → «F-07 Прыжок»; не ссылка → null.
export function linkValue(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/);
  return m ? m[1].trim() : null;
}

function parseSections(body) {
  const sections = {}; let current = null;
  for (const line of stripCode(body).split('\n')) {
    const h = line.match(/^## (.+?)\s*$/);
    if (h) { current = h[1]; sections[current] = []; continue; }
    if (/^# /.test(line)) { current = null; continue; }
    if (current) sections[current].push(line);
  }
  return sections;
}

function parseSummary(body) {
  const lines = body.split('\n');
  const h1 = lines.findIndex((l) => /^# /.test(l));
  if (h1 < 0) return null;
  let i = h1 + 1;
  while (i < lines.length && !lines[i].trim()) i++;
  const quote = [];
  while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++]);
  if (!quote.length) return null;
  const fields = {};
  for (const l of quote) {
    const m = l.match(/^>\s*\*\*([^*]+?):\*\*\s*(.*)$/);
    if (m) fields[m[1].trim()] = stripComments(m[2]).trim();
  }
  return fields;
}

export function parseItem(file, text) {
  text = text.replace(/\r\n/g, '\n');
  const name = path.basename(file, '.md');
  const item = { file, name, fm: {}, problems: [], body: text };
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) { item.noFrontmatter = true; item.links = extractLinks(stripCode(text)); return item; }
  const { fm, problems } = parseFrontmatter(m[1]);
  item.fm = fm; item.problems = problems;
  item.frontmatterText = m[1];
  item.body = text.slice(m[0].length);
  const h1 = item.body.match(/^# (.+?)\s*$/m);
  item.heading = h1 ? h1[1] : null;
  item.summary = parseSummary(item.body);
  item.sections = parseSections(item.body);
  // Зачёркнутый неотмеченный критерий `- [ ] ~~…~~` — снят или перенесён (причина рядом), открытым не считается.
  const crit = (item.sections[H.criteria] || []).map((l) => l.match(/^\s*- \[( |x|X)\]\s*(~~)?/)).filter(Boolean);
  item.criteria = { total: crit.length, open: crit.filter((c) => c[1] === ' ' && !c[2]).length, waived: crit.filter((c) => c[1] === ' ' && c[2]).length };
  const log = item.sections[H.log];
  item.hasLog = !!log;
  item.logEntries = log ? stripComments(log.join('\n')).split('\n').filter((l) => /^- /.test(l)).length : 0;
  item.links = [...extractLinks(m[1]), ...extractLinks(stripCode(item.body))];
  return item;
}

// ─── План целиком ───────────────────────────────────────────────────────────

function listMarkdown(root) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  })(root);
  return out.sort();
}

export function loadPlan(root) {
  const files = listMarkdown(root);
  const all = files.map((f) => parseItem(path.relative(root, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')));
  const items = all.filter((it) => !(SERVICE_FILES.includes(it.name) && !it.file.includes('/')));
  const byName = new Map(all.map((it) => [it.name, it]));
  const byId = new Map();
  for (const it of items) if (it.fm.id && !byId.has(it.fm.id)) byId.set(it.fm.id, it);
  for (const it of items) {
    it.type = TYPES[it.fm.type] ? it.fm.type : null;
    it.id = it.fm.id;
    it.status = it.fm.status;
    it.parentName = linkValue(it.fm.parent);
    it.deps = (Array.isArray(it.fm.depends_on) ? it.fm.depends_on : []).map((d) => ({ raw: d, name: linkValue(d) }));
  }
  return { root, all, items, byName, byId };
}

// ─── Проверка ───────────────────────────────────────────────────────────────

const idNum = (id) => Number(String(id).split('-').pop());
export const compareIds = (a, b) => {
  const pa = String(a).split('-')[0], pb = String(b).split('-')[0];
  return pa === pb ? idNum(a) - idNum(b) : pa.localeCompare(pb);
};

export function checkPlan(plan) {
  const errors = []; const warnings = [];
  const err = (it, code, msg) => errors.push({ file: it.file, id: it.id || null, code, msg });
  const warn = (it, code, msg) => warnings.push({ file: it.file, id: it.id || null, code, msg });

  // Файлы вне структуры и служебные
  for (const it of plan.all) {
    if (!it.file.includes('/') && SERVICE_FILES.includes(it.name)) {
      for (const l of new Set(it.links)) if (!plan.byName.has(l)) err(it, 'broken-link', `битая ссылка [[${l}]]`);
    }
  }

  const seenIds = new Map();
  for (const it of plan.items) {
    if (it.noFrontmatter) { err(it, 'no-frontmatter', 'нет frontmatter (блока --- в начале файла)'); continue; }
    for (const p of it.problems) err(it, 'bad-frontmatter', `frontmatter: ${p}`);
    for (const k of ['id', 'type', 'status', 'created']) if (it.fm[k] === undefined || it.fm[k] === '') err(it, 'missing-field', `нет обязательного поля ${k}`);
    if (!it.type) { if (it.fm.type) err(it, 'unknown-type', `неизвестный тип «${it.fm.type}»`); continue; }
    const T = TYPES[it.type];

    // ID, имя файла, папка, заголовок
    if (it.id) {
      if (seenIds.has(it.id)) err(it, 'duplicate-id', `ID ${it.id} уже занят файлом ${seenIds.get(it.id)}`);
      else seenIds.set(it.id, it.file);
      const re = new RegExp(`^${T.prefix}-\\d{${T.width}}$`);
      if (!re.test(it.id)) err(it, 'bad-id', `ID «${it.id}» не по формату ${T.prefix}-${'0'.repeat(T.width)}`);
      if (!it.name.startsWith(it.id + ' ')) err(it, 'id-filename', `имя файла должно начинаться с «${it.id} »`);
    }
    const folder = it.file.split('/').slice(-2, -1)[0];
    if (folder !== T.folder || it.file.split('/').length !== 2) err(it, 'wrong-folder', `тип ${it.type} должен лежать в ${T.folder}/`);
    if (it.heading !== it.name) err(it, 'heading', it.heading ? `заголовок «# ${it.heading}» не совпадает с именем файла` : 'нет заголовка «# …»');

    // Поля
    if (it.status && !T.statuses.includes(it.status)) err(it, 'unknown-status', `статус «${it.status}» недопустим для ${it.type} (${T.statuses.join(', ')})`);
    for (const k of T.required) if (it.fm[k] === undefined) err(it, 'missing-field', `нет обязательного поля ${k}`);
    if (it.fm.priority !== undefined && !PRIORITIES.includes(it.fm.priority)) err(it, 'bad-value', `priority «${it.fm.priority}» — допустимо ${PRIORITIES.join(', ')}`);
    if (it.fm.size !== undefined && !SIZES.includes(it.fm.size)) err(it, 'bad-value', `size «${it.fm.size}» — допустимо ${SIZES.join(', ')}; больше L — разбей задачу`);
    if (it.fm.created && !/^\d{4}-\d{2}-\d{2}$/.test(it.fm.created)) warn(it, 'bad-date', `created «${it.fm.created}» — ожидается YYYY-MM-DD`);
    if (it.fm.role !== undefined && !/^[a-z][a-z0-9-]*$/.test(it.fm.role)) warn(it, 'bad-role', `role «${it.fm.role}» — латиница строчными, без пробелов`);

    // parent
    if (it.fm.parent !== undefined) {
      if (!it.parentName) err(it, 'bad-link-field', 'parent должен быть ссылкой вида "[[F-07 Название]]"');
      else {
        const p = plan.byName.get(it.parentName);
        if (p && T.parent && p.fm.type !== T.parent) err(it, 'parent-type', `parent должен быть ${T.parent}, а [[${it.parentName}]] — ${p.fm.type}`);
      }
    }
    // depends_on
    if (it.fm.depends_on !== undefined && !Array.isArray(it.fm.depends_on)) err(it, 'bad-link-field', 'depends_on должен быть списком ссылок');
    for (const d of it.deps) {
      if (!d.name) { err(it, 'bad-link-field', `depends_on: «${d.raw}» — не ссылка [[...]]`); continue; }
      const dep = plan.byName.get(d.name);
      if (dep && !TYPES[dep.fm.type]?.work) err(it, 'dep-type', `depends_on: [[${d.name}]] — ${dep.fm.type}, а зависеть можно только от задач`);
    }
    for (const k of ['promoted_to', 'task', 'superseded_by']) {
      if (it.fm[k] !== undefined && !linkValue(it.fm[k])) err(it, 'bad-link-field', `${k} должен быть ссылкой [[...]]`);
    }

    // Ссылки
    for (const l of new Set(it.links)) if (!plan.byName.has(l)) err(it, 'broken-link', `битая ссылка [[${l}]]`);

    // Тело
    if (!it.summary) warn(it, 'no-summary', 'нет блока «Коротко» сразу под заголовком');
    else for (const label of T.summary) {
      if (!(label in it.summary)) warn(it, 'summary-field', `в «Коротко» нет строки **${label}:**`);
      else if (!it.summary[label]) warn(it, 'summary-empty', `в «Коротко» пустая строка **${label}:**`);
    }
    if (T.journal && !it.hasLog) warn(it, 'no-log', 'нет раздела «## Журнал»');

    // Статусы работы
    if (T.work) {
      if (['ready', 'in-progress', 'review', 'done'].includes(it.status) && it.criteria.total === 0) warn(it, 'no-criteria', `${it.status} без критериев готовности`);
      if (it.status === 'done' && it.criteria.open > 0) warn(it, 'open-criteria', `done, но не отмечено критериев: ${it.criteria.open} — в журнале должно быть объяснение`);
      if (['done', 'review'].includes(it.status) && it.logEntries === 0) warn(it, 'empty-log', `${it.status} без записи в журнале`);
    }
    if (it.type === 'idea' && it.status === 'done' && !it.fm.promoted_to) warn(it, 'no-promoted', 'идея done, но нет promoted_to');
    if (it.type === 'adr' && it.status === 'superseded' && !it.fm.superseded_by) warn(it, 'no-superseded-by', 'ADR superseded, но нет superseded_by');
  }

  // Закрытый research без ADR (ADR ссылается на задачу полем task)
  const adrTasks = new Set(plan.items.filter((x) => x.type === 'adr').map((x) => linkValue(x.fm.task)).filter(Boolean));
  for (const it of plan.items) {
    if (it.type === 'research' && it.status === 'done' && !adrTasks.has(it.name)) warn(it, 'research-no-adr', 'research закрыт, но нет ADR с task: [[этой задачи]] — решение записано только в журнале?');
  }

  // Зависимости: незакрытые у in-progress
  for (const it of plan.items) {
    if (!it.type || it.status !== 'in-progress') continue;
    for (const d of it.deps) {
      const dep = d.name && plan.byName.get(d.name);
      if (dep && dep.status !== 'done') warn(it, 'in-progress-blocked', `in-progress, но зависимость [[${d.name}]] — ${dep.status}`);
    }
  }
  // Больше одной in-progress задачи у роли
  const byRole = new Map();
  for (const it of plan.items) if (TYPES[it.type]?.work && it.status === 'in-progress' && it.fm.role) byRole.set(it.fm.role, [...(byRole.get(it.fm.role) || []), it]);
  for (const [role, list] of byRole) if (list.length > 1) for (const it of list) warn(it, 'role-busy', `у роли ${role} несколько задач in-progress: ${list.map((x) => x.id).join(', ')}`);

  // Циклы в depends_on
  const state = new Map(); const reported = new Set();
  const visit = (it, stack) => {
    state.set(it.name, 1); stack.push(it);
    for (const d of it.deps) {
      const dep = d.name && plan.byName.get(d.name);
      if (!dep || !plan.items.includes(dep)) continue;
      if (state.get(dep.name) === 1) {
        const cycle = stack.slice(stack.indexOf(dep)).map((x) => x.id);
        const key = [...cycle].sort().join(',');
        if (!reported.has(key)) { reported.add(key); err(dep, 'cycle', `цикл зависимостей: ${[...cycle, dep.id].join(' → ')}`); }
      } else if (!state.get(dep.name)) visit(dep, stack);
    }
    stack.pop(); state.set(it.name, 2);
  };
  for (const it of plan.items) if (!state.get(it.name)) visit(it, []);

  const order = (a, b) => (a.id && b.id ? compareIds(a.id, b.id) : a.file.localeCompare(b.file));
  errors.sort(order); warnings.sort(order);
  return { files: plan.all.length, errors, warnings };
}

// ─── Граф: блокировки, кандидаты, критический путь ─────────────────────────

const isWork = (it) => !!TYPES[it.type]?.work;
const CLOSED = ['done', 'cancelled'];
const PRIORITY_RANK = { must: 0, should: 1, could: 2 };
const sprintNum = (s) => (s && /^S-\d+$/.test(s) ? Number(s.slice(2)) : Infinity);

// Для каждой задачи: незакрытые зависимости, кого она блокирует (вычисляется, не хранится).
export function analyze(plan) {
  const work = plan.items.filter(isWork).sort((a, b) => compareIds(a.id, b.id));
  const byName = plan.byName;
  for (const it of work) { it.blocks = []; it.openDeps = []; }
  for (const it of work) {
    for (const d of it.deps) {
      const dep = d.name && byName.get(d.name);
      if (!dep || !isWork(dep)) continue;
      if (dep.status !== 'done') it.openDeps.push(dep);
      dep.blocks.push(it);
    }
    it.openDeps.sort((a, b) => compareIds(a.id, b.id));
  }
  for (const it of work) it.blocks.sort((a, b) => compareIds(a.id, b.id));
  const open = work.filter((it) => !CLOSED.includes(it.status));
  const currentSprint = open.map((it) => it.fm.sprint).filter(Boolean).sort((a, b) => sprintNum(a) - sprintNum(b))[0] || null;
  return { work, open, currentSprint };
}

// Кандидаты next: ready + все зависимости done. Порядок: текущий спринт → приоритет → сколько разблокирует → ID.
export function nextCandidates(plan, { role } = {}) {
  const { work, currentSprint } = analyze(plan);
  const unblocks = (it) => it.blocks.filter((b) => !CLOSED.includes(b.status)).length;
  return work
    .filter((it) => it.status === 'ready' && it.openDeps.length === 0 && (!role || it.fm.role === role))
    .sort((a, b) =>
      (a.fm.sprint === currentSprint ? 0 : 1) - (b.fm.sprint === currentSprint ? 0 : 1) ||
      (PRIORITY_RANK[a.fm.priority] ?? 9) - (PRIORITY_RANK[b.fm.priority] ?? 9) ||
      unblocks(b) - unblocks(a) ||
      compareIds(a.id, b.id))
    .map((it) => ({ id: it.id, name: it.name, file: it.file, role: it.fm.role || null, priority: it.fm.priority, size: it.fm.size, sprint: it.fm.sprint || null, what: it.summary?.['Что'] || '', unblocks: it.blocks.filter((b) => !CLOSED.includes(b.status)).map((b) => b.id) }));
}

// Самая длинная цепочка незакрытых задач по зависимостям.
export function criticalPath(plan) {
  const { open } = analyze(plan);
  const memo = new Map();
  const longest = (it, seen = new Set()) => {
    if (memo.has(it.name)) return memo.get(it.name);
    if (seen.has(it.name)) return [it];
    seen.add(it.name);
    let best = [];
    for (const b of it.blocks) if (!CLOSED.includes(b.status)) { const p = longest(b, seen); if (p.length > best.length) best = p; }
    const res = [it, ...best]; memo.set(it.name, res); return res;
  };
  let best = [];
  for (const it of open) if (it.openDeps.length === 0) { const p = longest(it); if (p.length > best.length) best = p; }
  return best;
}

export function nextId(plan, type) {
  const T = TYPES[type];
  if (!T) throw new Error(`неизвестный тип «${type}»`);
  const nums = plan.items.filter((it) => it.id && String(it.id).startsWith(T.prefix + '-')).map((it) => idNum(it.id)).filter(Number.isFinite);
  return `${T.prefix}-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(T.width, '0')}`;
}

// ─── Доска ──────────────────────────────────────────────────────────────────

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const link = (it) => `[[${it.name}]]`;
const short = (it, table = true) => `[[${it.name}${table ? '\\|' : '|'}${it.id}]]`;
const what = (it) => cell(it.summary?.['Что'] || '');

export function renderBoard(plan) {
  const { work, currentSprint } = analyze(plan);
  const report = checkPlan(plan);
  const sorted = (list) => [...list].sort((a, b) => compareIds(a.id, b.id));
  const L = [];
  const table = (head, rows) => {
    if (!rows.length) { L.push('—', ''); return; }
    L.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`), '');
  };
  const section = (title) => L.push(`## ${title}`, '');

  L.push('# Доска', '');
  L.push(`> Сгенерировано скриптом плагина (\`/task:board\`) — **руками не править**, изменения перезапишутся.${plan.byName.has('Readme') ? ' Как устроен план — [[Readme]].' : ''}`);
  L.push(report.errors.length || report.warnings.length
    ? `> Проверка плана: ошибок ${report.errors.length}, предупреждений ${report.warnings.length} — подробности: \`/task:board\`.`
    : '> Проверка плана: ✓ без ошибок и предупреждений.');
  L.push('');

  const ready = work.filter((it) => it.status === 'ready' && it.openDeps.length === 0);
  const blocked = work.filter((it) => ['draft', 'ready'].includes(it.status) && it.openDeps.length > 0);
  const drafts = work.filter((it) => it.status === 'draft' && it.openDeps.length === 0);
  const role = (it) => cell(it.fm.role || '—');
  const unblocks = (it) => it.blocks.filter((b) => !CLOSED.includes(b.status)).map((b) => short(b)).join(', ') || '—';

  section('Готово к работе');
  table(['Задача', 'Роль', 'Коротко', 'Разблокирует'], sorted(ready).map((it) => [link(it), role(it), what(it), unblocks(it)]));
  section('В работе');
  table(['Задача', 'Роль', 'Коротко'], sorted(work.filter((it) => it.status === 'in-progress')).map((it) => [link(it), role(it), what(it)]));
  section('На проверке');
  table(['Задача', 'Роль', 'Коротко'], sorted(work.filter((it) => it.status === 'review')).map((it) => [link(it), role(it), what(it)]));
  section('Черновики');
  table(['Задача', 'Роль', 'Коротко'], sorted(drafts).map((it) => [link(it), role(it), what(it)]));
  section('Заблокировано');
  table(['Задача', 'Ждёт'], sorted(blocked).map((it) => [link(it), it.openDeps.map((d) => short(d)).join(', ')]));
  section('Готово');
  table(['Задача', 'Коротко'], sorted(work.filter((it) => it.status === 'done')).map((it) => [link(it), what(it)]));
  const cancelled = sorted(work.filter((it) => it.status === 'cancelled'));
  if (cancelled.length) { section('Отменено'); table(['Задача', 'Коротко'], cancelled.map((it) => [link(it), what(it)])); }

  // Дерево плана
  section('План');
  const kids = (parent, type) => sorted(plan.items.filter((it) => it.type === type && it.parentName === parent.name));
  const mark = (it) => (CLOSED.includes(it.status) ? `~~${short(it, false)}~~` : short(it, false));
  const taskLine = (list) => list.map(mark).join(' · ');
  const epics = sorted(plan.items.filter((it) => it.type === 'epic'));
  for (const e of epics) {
    L.push(`- ${link(e)} — ${e.status}`);
    for (const f of kids(e, 'feature')) {
      L.push(`  - ${link(f)} — ${f.status}`);
      const ts = sorted(work.filter((it) => it.parentName === f.name));
      if (ts.length) L.push(`    - ${taskLine(ts)}`);
    }
  }
  const orphanF = sorted(plan.items.filter((it) => it.type === 'feature' && !epics.some((e) => e.name === it.parentName)));
  const orphanT = sorted(work.filter((it) => !plan.items.some((f) => f.type === 'feature' && f.name === it.parentName)));
  if (orphanF.length || orphanT.length) {
    L.push('- Без родителя');
    for (const f of orphanF) L.push(`  - ${link(f)} — ${f.status}`);
    if (orphanT.length) L.push(`  - ${taskLine(orphanT)}`);
  }
  L.push('');

  // Спринты и критический путь
  const sprints = [...new Set(work.map((it) => it.fm.sprint).filter(Boolean))].sort((a, b) => sprintNum(a) - sprintNum(b));
  for (const s of sprints) {
    const ts = work.filter((it) => it.fm.sprint === s);
    const closed = ts.filter((it) => CLOSED.includes(it.status)).length;
    L.push(`**Спринт ${s}${s === currentSprint ? ' (текущий)' : ''}:** закрыто ${closed} из ${ts.length} — ${taskLine(sorted(ts))}`, '');
  }
  const cp = criticalPath(plan);
  if (cp.length > 1) L.push(`**Критический путь:** ${cp.map((it) => short(it, false)).join(' → ')}`, '');

  // ADR и бэклог
  const adrs = sorted(plan.items.filter((it) => it.type === 'adr'));
  if (adrs.length) { section('Решения (ADR)'); for (const a of adrs) L.push(`- ${link(a)} — ${a.status}`); L.push(''); }
  section('Бэклог');
  const ideas = sorted(plan.items.filter((it) => it.type === 'idea' && it.status === 'idea'));
  if (ideas.length) for (const i of ideas) L.push(`- ${link(i)}`); else L.push('—');
  L.push('');
  return L.join('\n');
}

// ─── show / set: карточка задачи и смена статуса ────────────────────────────

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const findItem = (plan, ref) => plan.byId.get(ref) || plan.byName.get(ref) || null;

export function showItem(plan, ref) {
  analyze(plan);
  const it = findItem(plan, ref);
  if (!it) return null;
  return {
    id: it.id, name: it.name, type: it.type, status: it.status, role: it.fm.role || null,
    priority: it.fm.priority || null, size: it.fm.size || null, sprint: it.fm.sprint || null,
    file: path.join(plan.root, it.file), parent: it.parentName, summary: it.summary || {},
    criteria: it.criteria, logEntries: it.logEntries ?? 0,
    openDeps: (it.openDeps || []).map((d) => ({ id: d.id, name: d.name, status: d.status })),
    blocks: (it.blocks || []).map((b) => ({ id: b.id, name: b.name, status: b.status })),
  };
}

// Ставит статус и дописывает запись в «Журнал». Возвращает { item, unblocked } или { error }.
export function setStatus(plan, ref, status, { log, who = 'Claude', force = false, date = today() } = {}) {
  analyze(plan);
  const it = findItem(plan, ref);
  if (!it) return { error: `задача «${ref}» не найдена` };
  const T = TYPES[it.type];
  if (!T) return { error: `у «${it.name}» неизвестный тип` };
  if (!T.statuses.includes(status)) return { error: `статус «${status}» недопустим для ${it.type} (${T.statuses.join(', ')})` };
  if (status === 'in-progress' && it.openDeps?.length && !force) {
    return { error: `не закрыты зависимости: ${it.openDeps.map((d) => `${d.id} (${d.status})`).join(', ')}. Взять всё равно — с --force`, code: 'open-deps' };
  }
  const file = path.join(plan.root, it.file);
  let text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  text = text.replace(/\r\n/g, '\n');
  const fmEnd = text.indexOf('\n---', 4);
  const head = text.slice(0, fmEnd).replace(/^status:.*$/m, `status: ${status}`);
  text = head + text.slice(fmEnd);
  if (log) {
    const entry = `- **${date} · ${who}:** ${log}`;
    if (!/^## Журнал\s*$/m.test(text)) text = text.replace(/\s*$/, '\n\n## Журнал\n');
    text = text.replace(/\s*$/, '\n') + (/## Журнал\s*$/.test(text.trimEnd()) ? '\n' : '') + entry + '\n';
  }
  fs.writeFileSync(file, text.replace(/\n/g, eol));
  const fresh = loadPlan(plan.root);
  fs.writeFileSync(path.join(plan.root, 'Board.md'), renderBoard(fresh));
  analyze(fresh);
  const self = fresh.byId.get(it.id);
  const unblocked = status === 'done'
    ? (self.blocks || []).filter((b) => !CLOSED.includes(b.status) && b.openDeps.length === 0).map((b) => ({ id: b.id, name: b.name, status: b.status }))
    : [];
  // Все задачи фичи закрыты → подсказать закрыть фичу (сама фича не меняется).
  let parentComplete = null;
  const parent = self.parentName && fresh.byName.get(self.parentName);
  if (CLOSED.includes(status) && parent && !CLOSED.includes(parent.status)) {
    const siblings = fresh.items.filter((x) => isWork(x) && x.parentName === parent.name);
    if (siblings.every((x) => CLOSED.includes(x.status))) parentComplete = { id: parent.id, name: parent.name, status: parent.status };
  }
  return { item: showItem(fresh, it.id), unblocked, parentComplete };
}

// Область пересмотра: незакрытые задачи, которые зависят от ref напрямую или по цепочке (с глубиной),
// а для фичи/эпика — все незакрытые задачи внутри.
export function affectedBy(plan, ref) {
  analyze(plan);
  const root = findItem(plan, ref);
  if (!root) return null;
  const out = new Map();
  const add = (it, depth, via) => { if (!CLOSED.includes(it.status) && !out.has(it.name)) out.set(it.name, { id: it.id, name: it.name, status: it.status, depth, via }); };
  if (isWork(root)) {
    const queue = [[root, 0]];
    const seen = new Set([root.name]);
    while (queue.length) {
      const [it, d] = queue.shift();
      for (const b of it.blocks || []) {
        if (seen.has(b.name)) continue;
        seen.add(b.name); add(b, d + 1, it.id); queue.push([b, d + 1]);
      }
    }
  } else {
    const features = root.type === 'epic' ? plan.items.filter((f) => f.type === 'feature' && f.parentName === root.name) : [root];
    for (const f of features) for (const t of plan.items.filter((x) => isWork(x) && x.parentName === f.name)) add(t, 0, f.id);
  }
  return { root: { id: root.id, name: root.name, type: root.type, status: root.status }, affected: [...out.values()].sort((a, b) => a.depth - b.depth || compareIds(a.id, b.id)) };
}

export function listItems(plan, { status, role, type } = {}) {
  analyze(plan);
  const statuses = status ? String(status).split(',') : null;
  return plan.items
    .filter((it) => it.type && (!type || it.type === type) && (!statuses || statuses.includes(it.status)) && (!role || it.fm.role === role))
    .sort((a, b) => compareIds(a.id, b.id))
    .map((it) => ({ id: it.id, name: it.name, type: it.type, status: it.status, role: it.fm.role || null, what: it.summary?.['Что'] || '', file: path.join(plan.root, it.file) }));
}

// ─── new: файл из шаблона ───────────────────────────────────────────────────

// Создаёт файл нужного типа из шаблона: ID, папка, имя, frontmatter. Тело (подсказки <!-- -->) заполняет агент.
export function createItem(plan, type, { title, parent, depends = [], role, priority, size, status, task, date = today() } = {}) {
  const T = TYPES[type];
  if (!T) return { error: `неизвестный тип «${type}» (${Object.keys(TYPES).join(', ')})` };
  title = String(title || '').trim();
  if (!title) return { error: 'нужно название: --title "Короткое название"' };
  if (/[\\/:*?"<>|#^[\]]/.test(title)) return { error: 'в названии недопустимы символы \\ / : * ? " < > | # ^ [ ]' };
  const resolve = (ref, what) => {
    const it = findItem(plan, ref);
    if (!it) throw new Error(`${what}: «${ref}» не найден`);
    return it;
  };
  let parentItem = null, taskItem = null, depItems = [];
  try {
    if (T.parent) {
      if (!parent) return { error: `для ${type} нужен родитель (${T.parent}): --parent <ID>` };
      parentItem = resolve(parent, 'parent');
      if (parentItem.type !== T.parent) return { error: `родитель ${type} должен быть ${T.parent}, а ${parentItem.id} — ${parentItem.type}` };
    }
    if (T.work) depItems = depends.map((d) => resolve(d, 'depends_on'));
    for (const d of depItems) if (!isWork(d)) return { error: `зависеть можно только от задач, а ${d.id} — ${d.type}` };
    if (type === 'adr' && task) taskItem = resolve(task, 'task');
  } catch (e) { return { error: e.message }; }
  if (priority && !PRIORITIES.includes(priority)) return { error: `priority: ${PRIORITIES.join(', ')}` };
  if (size && !SIZES.includes(size)) return { error: `size: ${SIZES.join(', ')} (больше L — разбей задачу)` };
  if (status && !T.statuses.includes(status)) return { error: `статус «${status}» недопустим для ${type}` };
  if (role && !/^[a-z][a-z0-9-]*$/.test(role)) return { error: 'role — латиница строчными, без пробелов (например, gamedesigner)' };

  const id = nextId(plan, type);
  const name = `${id} ${title}`;
  const file = path.join(plan.root, T.folder, `${name}.md`);
  if (fs.existsSync(file)) return { error: `файл уже есть: ${file}` };
  let text = fs.readFileSync(path.join(PLUGIN_ROOT, 'templates', `${type}.md`), 'utf8').replace(/\r\n/g, '\n');
  const values = { id, title, date, role, priority: priority || 'must', size: size || 'M', parent: parentItem?.name, task: taskItem?.name };
  if (!role) text = text.replace(/^role: "\{\{role\}\}"\n/m, '');
  if (type === 'adr' && !taskItem) text = text.replace(/^task: "\[\[\{\{task\}\}\]\]"\n/m, '');
  if (depItems.length) text = text.replace(/^depends_on: \[\]$/m, `depends_on:\n${depItems.map((d) => `  - "[[${d.name}]]"`).join('\n')}`);
  if (status) text = text.replace(/^status: .*$/m, `status: ${status}`);
  text = text.replace(/"\{\{(\w+)\}\}"/g, (_, k) => values[k]).replace(/\{\{(\w+)\}\}/g, (_, k) => values[k]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(plan.root, 'Board.md'), renderBoard(loadPlan(plan.root)));
  return { id, name, type, file };
}

// ─── init: структура плана в проекте ────────────────────────────────────────

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_TPL = path.join(PLUGIN_ROOT, 'templates', 'project');
const BLOCK_RE = /<!-- task:begin[\s\S]*?<!-- task:end -->\n?/;

// Создаёт недостающее и никогда не трогает существующие задачи. Возвращает список действий.
export function initProject(project, { claudeMd = false, obsidian = false, gitignore = false } = {}) {
  const root = path.join(project, 'Docs', 'Tasks');
  const actions = [];
  const did = (what, file) => actions.push({ what, file: path.relative(project, file).split(path.sep).join('/') || '.' });

  for (const dir of ['', ...new Set(Object.values(TYPES).map((t) => t.folder))]) {
    const d = path.join(root, dir);
    if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); did('создана папка', d); }
    // .gitkeep — чтобы пустые папки попали в git; Obsidian скрытые файлы не показывает
    if (dir && fs.readdirSync(d).length === 0) fs.writeFileSync(path.join(d, '.gitkeep'), '');
  }
  const readme = path.join(root, 'Readme.md');
  if (!fs.existsSync(readme)) { fs.copyFileSync(path.join(PROJECT_TPL, 'Readme.md'), readme); did('создан', readme); }
  else did('уже есть', readme);

  if (claudeMd) {
    const file = path.join(project, 'CLAUDE.md');
    const block = fs.readFileSync(path.join(PROJECT_TPL, 'claude-md-block.md'), 'utf8').replace(/\r\n/g, '\n');
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
    if (cur === null) { fs.writeFileSync(file, block); did('создан с блоком «Работа с задачами»', file); }
    else if (BLOCK_RE.test(cur)) {
      const next = cur.replace(BLOCK_RE, block);
      if (next !== cur) { fs.writeFileSync(file, next); did('обновлён блок «Работа с задачами»', file); } else did('блок уже актуален', file);
    } else { fs.writeFileSync(file, cur.replace(/\s*$/, '\n\n') + block); did('добавлен блок «Работа с задачами»', file); }
  }

  if (obsidian) {
    const settings = JSON.parse(fs.readFileSync(path.join(PROJECT_TPL, 'obsidian.json'), 'utf8'));
    const dir = path.join(root, '.obsidian');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, values] of Object.entries(settings)) {
      const file = path.join(dir, name);
      let cur = {};
      if (fs.existsSync(file)) { try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cur = {}; } }
      fs.writeFileSync(file, JSON.stringify({ ...cur, ...values }, null, 2));
      did('настройки Obsidian', file);
    }
  }

  if (gitignore) {
    const file = path.join(project, '.gitignore');
    const line = 'Docs/Tasks/.obsidian/';
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (cur.split(/\r?\n/).some((l) => l.trim() === line || l.trim() === '.obsidian/')) did('уже игнорирует .obsidian', file);
    else { fs.writeFileSync(file, cur.replace(/\s*$/, cur ? '\n\n' : '') + `# Личные настройки Obsidian\n${line}\n`); did('добавлено игнорирование Docs/Tasks/.obsidian/', file); }
  }

  const plan = loadPlan(root);
  fs.writeFileSync(path.join(root, 'Board.md'), renderBoard(plan));
  did('доска пересобрана', path.join(root, 'Board.md'));
  return { project, root, actions, items: plan.items.length };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

export function findRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  const candidates = [];
  if (process.env.CLAUDE_PROJECT_DIR) candidates.push(path.join(process.env.CLAUDE_PROJECT_DIR, 'Docs', 'Tasks'));
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    candidates.push(path.join(d, 'Docs', 'Tasks'));
    if (path.dirname(d) === d) break;
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; } else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

const label = (e) => (e.id ? `${e.file.split('/').pop().replace(/\.md$/, '')}` : e.file);

function printReport(root, report) {
  const out = [`План: ${root} — файлов: ${report.files}`];
  const block = (title, list) => {
    if (!list.length) return;
    out.push('', `${title} (${list.length}):`);
    for (const e of list) out.push(`  ${label(e)}: ${e.msg}`);
  };
  block('Ошибки', report.errors);
  block('Предупреждения', report.warnings);
  out.push('', `Итог: ошибок ${report.errors.length}, предупреждений ${report.warnings.length}.`);
  console.log(out.join('\n'));
}

const USAGE = `Использование: node tasks.mjs <команда> [--root Docs/Tasks] [--json]

Команды:
  check               проверить формат и граф плана (код выхода 1, если есть ошибки)
  board [--stdout]    пересобрать Board.md (или вывести доску без записи)
  next [--role R]     задачи, готовые к работе, в порядке очереди
  new-id <тип>        следующий свободный ID для типа (epic, feature, task, research, bug, idea, adr)
  new <тип> --title "Название" [--parent ID] [--depends ID,ID] [--role R]
      [--priority must|should|could] [--size XS|S|M|L] [--status S] [--task ID]
                      создать файл из шаблона (ID, папка, frontmatter); тело заполнить после
  list [--status S[,S2]] [--role R] [--type T]
                      элементы плана по фильтру (например, --status in-progress)
  affected <ID>       незакрытые задачи, которые зависят от задачи (по цепочке) или входят в фичу/эпик
  show <ID>           карточка: статус, «Коротко», критерии, незакрытые зависимости, кого блокирует
  set <ID> <статус> [--log "текст"] [--who "роль (агент)"] [--force]
                      сменить статус, дописать запись в «Журнал», пересобрать доску;
                      in-progress при незакрытых зависимостях — только с --force
  init [--project DIR] [--claude-md] [--obsidian] [--gitignore]
                      создать Docs/Tasks/ в проекте (существующее не трогает);
                      флаги — блок в CLAUDE.md, настройки Obsidian, .obsidian в .gitignore`;

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.help) { console.log(USAGE); return cmd ? 0 : 2; }
  if (cmd === 'init') {
    const project = path.resolve(args.project && args.project !== true ? args.project : process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const res = initProject(project, { claudeMd: !!args['claude-md'], obsidian: !!args.obsidian, gitignore: !!args.gitignore });
    if (args.json) { console.log(JSON.stringify(res, null, 2)); return 0; }
    console.log(`План: ${res.root} (элементов плана: ${res.items})`);
    for (const a of res.actions) console.log(`  ${a.what}: ${a.file}`);
    return 0;
  }
  const root = findRoot(args.root);
  if (!root || !fs.existsSync(root)) { console.error('Не найдена папка плана Docs/Tasks (укажи --root).'); return 2; }
  const plan = loadPlan(root);

  if (cmd === 'check') {
    const report = checkPlan(plan);
    if (args.json) console.log(JSON.stringify({ root, ...report }, null, 2));
    else printReport(root, report);
    return report.errors.length ? 1 : 0;
  }
  if (cmd === 'board') {
    const text = renderBoard(plan);
    if (args.stdout) { console.log(text); return 0; }
    fs.writeFileSync(path.join(root, 'Board.md'), text);
    const report = checkPlan(loadPlan(root));
    const cands = nextCandidates(loadPlan(root));
    if (args.json) { console.log(JSON.stringify({ root, board: 'Board.md', errors: report.errors, warnings: report.warnings, next: cands }, null, 2)); return 0; }
    console.log(`Доска обновлена: ${path.join(root, 'Board.md')}`);
    console.log(`Готово к работе: ${cands.length ? cands.map((c) => c.id).join(', ') : 'нет'}.`);
    if (report.errors.length || report.warnings.length) { console.log(''); printReport(root, report); }
    return 0;
  }
  if (cmd === 'next') {
    const cands = nextCandidates(plan, { role: args.role === true ? undefined : args.role });
    if (args.json) { console.log(JSON.stringify(cands, null, 2)); return 0; }
    if (!cands.length) { console.log(args.role ? `Нет готовых задач для роли ${args.role}.` : 'Нет задач, готовых к работе.'); return 0; }
    cands.forEach((c, i) => console.log(`${i + 1}. ${c.name}  [${c.priority}${c.size ? ', ' + c.size : ''}${c.role ? ', ' + c.role : ''}${c.sprint ? ', ' + c.sprint : ''}]\n   ${c.what}${c.unblocks.length ? `\n   Разблокирует: ${c.unblocks.join(', ')}` : ''}`));
    return 0;
  }
  if (cmd === 'show') {
    const card = showItem(plan, args._[1]);
    if (!card) { console.error(`Задача «${args._[1]}» не найдена.`); return 2; }
    if (args.json) { console.log(JSON.stringify(card, null, 2)); return 0; }
    const s = card.summary;
    console.log([`${card.name}  [${card.status}${card.role ? ', ' + card.role : ''}${card.priority ? ', ' + card.priority : ''}${card.size ? ', ' + card.size : ''}]`, card.file,
      ...Object.entries(s).map(([k, v]) => `  ${k}: ${v}`),
      `Критерии: ${card.criteria.total - card.criteria.open} из ${card.criteria.total} отмечено`,
      `Ждёт: ${card.openDeps.length ? card.openDeps.map((d) => `${d.id} (${d.status})`).join(', ') : '—'}`,
      `Блокирует: ${card.blocks.length ? card.blocks.map((d) => `${d.id} (${d.status})`).join(', ') : '—'}`].join('\n'));
    return 0;
  }
  if (cmd === 'set') {
    const [, ref, status] = args._;
    if (!ref || !status) { console.error('Использование: set <ID> <статус> [--log "текст"] [--who "роль (агент)"] [--force]'); return 2; }
    const res = setStatus(plan, ref, status, { log: args.log === true ? undefined : args.log, who: args.who === true ? undefined : args.who, force: !!args.force });
    if (args.json) { console.log(JSON.stringify(res, null, 2)); return res.error ? (res.code === 'open-deps' ? 3 : 2) : 0; }
    if (res.error) { console.error(`Не сделано: ${res.error}`); return res.code === 'open-deps' ? 3 : 2; }
    console.log(`${res.item.name}: статус ${res.item.status}${args.log ? ', запись в журнале добавлена' : ''}; доска обновлена.`);
    if (res.unblocked.length) console.log(`Разблокированы: ${res.unblocked.map((u) => `${u.id} (${u.status})`).join(', ')}.`);
    if (res.parentComplete) console.log(`Все задачи ${res.parentComplete.name} закрыты — её можно закрыть: set ${res.parentComplete.id} done.`);
    return 0;
  }
  if (cmd === 'new') {
    const opt = (k) => (args[k] === true || args[k] === undefined ? undefined : String(args[k]));
    const res = createItem(plan, args._[1], {
      title: opt('title'), parent: opt('parent'), role: opt('role'), priority: opt('priority'), size: opt('size'), status: opt('status'), task: opt('task'),
      depends: opt('depends') ? opt('depends').split(',').map((s) => s.trim()).filter(Boolean) : [],
    });
    if (args.json) { console.log(JSON.stringify(res, null, 2)); return res.error ? 2 : 0; }
    if (res.error) { console.error(`Не создано: ${res.error}`); return 2; }
    console.log(`Создан ${res.name}: ${res.file}\nЗаполни «Коротко», критерии и остальные разделы, убери подсказки <!-- … -->, затем check.`);
    return 0;
  }
  if (cmd === 'affected') {
    const res = affectedBy(plan, args._[1]);
    if (!res) { console.error(`«${args._[1]}» не найден.`); return 2; }
    if (args.json) { console.log(JSON.stringify(res, null, 2)); return 0; }
    console.log(`Затронуто изменениями в ${res.root.name}: ${res.affected.length ? '' : 'ничего (незакрытых зависимых задач нет)'}`);
    for (const a of res.affected) console.log(`  ${a.name}  [${a.status}]  ← через ${a.via}`);
    return 0;
  }
  if (cmd === 'list') {
    const list = listItems(plan, { status: args.status === true ? undefined : args.status, role: args.role === true ? undefined : args.role, type: args.type === true ? undefined : args.type });
    if (args.json) { console.log(JSON.stringify(list, null, 2)); return 0; }
    if (!list.length) { console.log('Ничего не найдено.'); return 0; }
    for (const x of list) console.log(`${x.name}  [${x.status}${x.role ? ', ' + x.role : ''}]  ${x.what}`);
    return 0;
  }
  if (cmd === 'new-id') {
    const type = args._[1];
    if (!type) { console.error('Укажи тип: new-id task'); return 2; }
    try { console.log(nextId(plan, type)); return 0; } catch (e) { console.error(e.message); return 2; }
  }
  console.error(`Неизвестная команда «${cmd}».\n\n${USAGE}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
