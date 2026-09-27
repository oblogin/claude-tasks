#!/usr/bin/env node
// Инструмент плана задач claude-tasks: разбор Docs/Tasks/, проверка формата и графа.
// Правила — по спецификации plugin/skills/format/SKILL.md. Без npm-зависимостей.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  const crit = (item.sections[H.criteria] || []).map((l) => l.match(/^\s*- \[( |x|X)\]/)).filter(Boolean);
  item.criteria = { total: crit.length, open: crit.filter((c) => c[1] === ' ').length };
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
  check    проверить формат и граф плана (код выхода 1, если есть ошибки)`;

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.help) { console.log(USAGE); return cmd ? 0 : 2; }
  const root = findRoot(args.root);
  if (!root || !fs.existsSync(root)) { console.error('Не найдена папка плана Docs/Tasks (укажи --root).'); return 2; }
  const plan = loadPlan(root);

  if (cmd === 'check') {
    const report = checkPlan(plan);
    if (args.json) console.log(JSON.stringify({ root, ...report }, null, 2));
    else printReport(root, report);
    return report.errors.length ? 1 : 0;
  }
  console.error(`Неизвестная команда «${cmd}».\n\n${USAGE}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
