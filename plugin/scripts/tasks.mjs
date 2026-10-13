#!/usr/bin/env node
// Инструмент плана задач claude-tasks: разбор Docs/Tasks/, проверка формата и графа.
// Правила — по спецификации plugin/skills/format/SKILL.md. Без npm-зависимостей.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── Модель формата ─────────────────────────────────────────────────────────

const TASK_STATUSES = ['draft', 'ready', 'in-progress', 'review', 'done', 'cancelled'];
const GROUP_STATUSES = ['draft', 'ready', 'in-progress', 'done', 'cancelled'];
const MAIN_SUMMARY = ['Что', 'Зачем', 'Готово, когда'];

// Раскладка (иерархия): эпик — папка «E-01 …» в корне, фича — папка «F-07 …» в папке эпика,
// задачи — файлы «F07-03 …» в папке фичи. Папка эпика/фичи и её заметка называются одинаково.
// Идеи и ADR — в своих папках Backlog/ и Adr/. У эпиков, фич и задач folder нет: место задаёт родитель.
const WORK = { statuses: TASK_STATUSES, required: ['priority', 'size', 'parent', 'depends_on'], parent: 'feature', summary: MAIN_SUMMARY, journal: true, work: true, idRe: /^F\d{2,}-\d{2}$/, idHint: 'F07-03 (номер фичи и два знака)' };
export const TYPES = {
  epic:     { statuses: GROUP_STATUSES, required: ['priority'], parent: null, summary: MAIN_SUMMARY, journal: true, idRe: /^E-\d{2,}$/, idHint: 'E-01' },
  feature:  { statuses: GROUP_STATUSES, required: ['priority', 'parent'], parent: 'epic', summary: MAIN_SUMMARY, journal: true, idRe: /^F-\d{2,}$/, idHint: 'F-01' },
  task:     WORK,
  research: WORK,
  bug:      WORK,
  idea:     { folder: 'Backlog', prefix: 'I', width: 3, statuses: ['idea', 'done', 'cancelled'], required: [], parent: null, summary: ['Что', 'Зачем'], journal: false, idRe: /^I-\d{3,}$/, idHint: 'I-001' },
  adr:      { folder: 'Adr', prefix: 'ADR', width: 3, statuses: ['proposed', 'accepted', 'superseded'], required: [], parent: null, summary: ['Решение', 'Почему', 'Следствия'], journal: false, idRe: /^ADR-\d{3,}$/, idHint: 'ADR-001' },
};
export const FLAT_FOLDERS = ['Backlog', 'Adr'];

// Номер фичи для ID её задач: F-07 → «F07», F-123 → «F123».
export const featureCode = (featureId) => String(featureId).replace('-', '');

export const PRIORITIES = ['must', 'should', 'could'];
export const SIZES = ['XS', 'S', 'M', 'L'];
const SERVICE_FILES = ['Board', 'Readme'];
const H = { criteria: 'Критерии готовности', log: 'Журнал' };
const CLOSED = ['done', 'cancelled'];
// ID задачи — для former_ids (прежние ID после move/migrate, в том числе старого плоского формата T-001).
const WORK_ID = /^(F\d{2,}-\d{2}|T-\d+)$/;
// Пометка доски: по ней хуки и команды узнают план плагина — чужая папка docs/tasks планом не считается.
export const BOARD_MARK = 'Сгенерировано скриптом плагина';

// ─── Файлы: BOM и переводы строк сохраняются как были ───────────────────────

export function readText(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  return { text: body.replace(/\r\n/g, '\n'), eol: body.includes('\r\n') ? '\r\n' : '\n', bom };
}

export function writeText(file, text, { eol = '\n', bom = false } = {}) {
  fs.writeFileSync(file, (bom ? '﻿' : '') + (eol === '\n' ? text : text.replace(/\n/g, eol)));
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dirOf = (rel) => rel.split('/').slice(0, -1).join('/');
const listValue = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);

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

// Строки внутри блоков кода ``` / ~~~ — в том числе с отступом (блок во вложенном пункте списка).
function fenceMask(lines) {
  const mask = []; let fence = null;
  for (const line of lines) {
    const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      mask.push(true);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = null;
    } else if (m && !(m[1][0] === '`' && m[2].includes('`'))) { fence = m[1]; mask.push(true); }
    else mask.push(false);
  }
  return mask;
}

const stripFences = (text) => { const lines = text.split('\n'); const mask = fenceMask(lines); return lines.map((l, i) => (mask[i] ? '' : l)).join('\n'); };

// Текст без блоков кода и `инлайн-кода` (в том числе ``кода с ` внутри``) — ссылки в коде считаются примерами.
export function stripCode(text) {
  return stripFences(text).split('\n').map((l) => l.replace(/(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g, '')).join('\n');
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

// Имя заметки по цели ссылки: «Папка/Имя.md» → «Имя» (Obsidian понимает и путь, и расширение).
export const noteName = (target) => String(target).replace(/\\/g, '/').split('/').pop().replace(/\.md$/i, '').trim();

// Значение поля-ссылки `"[[F-07 Прыжок]]"` → «F-07 Прыжок»; не ссылка → null.
export function linkValue(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/);
  return m ? noteName(m[1]) : null;
}

function parseSections(body) {
  const sections = {}; let current = null;
  for (const line of stripFences(body).split('\n')) {
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
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const name = path.basename(file, '.md');
  const item = { file, name, fm: {}, problems: [], body: text };
  const m = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!m) { item.noFrontmatter = true; item.links = extractLinks(stripCode(text)); return item; }
  const { fm, problems } = parseFrontmatter(m[1]);
  item.fm = fm; item.problems = problems;
  item.frontmatterText = m[1];
  item.body = text.slice(m[0].length);
  const h1 = stripFences(item.body).match(/^# (.+?)\s*$/m);
  item.heading = h1 ? h1[1] : null;
  item.summary = parseSummary(item.body);
  item.sections = parseSections(item.body);
  // Критерий — пункт с текстом: пустой `- [ ]` и пункт из одной подсказки <!-- … --> — заготовка шаблона, не критерий.
  // Зачёркнутый неотмеченный `- [ ] ~~…~~` — снят или перенесён (причина рядом), открытым не считается.
  const boxes = (item.sections[H.criteria] || []).map((l) => l.match(/^\s*- \[( |x|X)\]\s?(.*)$/)).filter(Boolean)
    .map((b) => ({ checked: b[1] !== ' ', text: stripComments(b[2]).trim() }));
  const real = boxes.filter((b) => b.text);
  const struck = (b) => !b.checked && b.text.startsWith('~~');
  item.criteria = { total: real.length, open: real.filter((b) => !b.checked && !struck(b)).length, waived: real.filter(struck).length };
  item.placeholders = boxes.length - real.length;
  const log = item.sections[H.log];
  item.hasLog = !!log;
  item.logEntries = log ? stripComments(log.join('\n')).split('\n').filter((l) => /^- /.test(l)).length : 0;
  item.links = [...extractLinks(m[1]), ...extractLinks(stripCode(item.body))];
  return item;
}

// ─── План целиком ───────────────────────────────────────────────────────────

// Файлы плана: заметки .md и вложения (картинки, pdf…). Скрытые папки (.obsidian, .claude-tasks) не читаются.
function listFiles(root) {
  const md = []; const other = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) md.push(p);
      else other.push(p);
    }
  })(root);
  return { md: md.sort(), other };
}

export function loadPlan(root) {
  const { md, other } = listFiles(root);
  const all = md.map((f) => parseItem(path.relative(root, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')));
  const items = all.filter((it) => !(SERVICE_FILES.includes(it.name) && !it.file.includes('/')));
  const byName = new Map(all.map((it) => [it.name, it]));
  const byId = new Map(); const byFormerId = new Map();
  for (const it of items) if (it.fm.id && !byId.has(it.fm.id)) byId.set(it.fm.id, it);
  for (const it of items) {
    it.type = TYPES[it.fm.type] ? it.fm.type : null;
    it.id = it.fm.id;
    it.status = it.fm.status;
    it.parentName = linkValue(it.fm.parent);
    it.deps = (Array.isArray(it.fm.depends_on) ? it.fm.depends_on : []).map((d) => ({ raw: d, name: linkValue(d) }));
    it.formerIds = listValue(it.fm.former_ids);
    for (const x of it.formerIds) if (!byFormerId.has(x)) byFormerId.set(x, it);
  }
  const attachments = new Set(other.map((f) => path.basename(f).toLowerCase()));
  return { root, all, items, byName, byId, byFormerId, attachments };
}

// Элемент по ID, полному имени (можно с путём и .md) или прежнему ID (former_ids).
function findItem(plan, ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  return plan.byId.get(ref) || plan.byName.get(noteName(ref)) || plan.byFormerId.get(ref) || null;
}

// Ссылка ведёт на заметку плана или на вложение (картинка, pdf…), которое лежит в плане.
function linkTargetExists(plan, target) {
  return plan.byName.has(noteName(target)) || plan.attachments.has(String(target).replace(/\\/g, '/').split('/').pop().toLowerCase());
}

// ─── Проверка ───────────────────────────────────────────────────────────────

// Сравнение ID по иерархии: префикс, затем числа по порядку (F-07 < F07-01 < F07-02 < F-08, F-99 < F-100).
const PREFIX_ORDER = ['E', 'F', 'I', 'ADR'];
const idKey = (id) => {
  const s = String(id);
  const prefix = s.match(/^[A-Z]+/)?.[0] || s;
  return { rank: PREFIX_ORDER.includes(prefix) ? PREFIX_ORDER.indexOf(prefix) : 99, prefix, nums: (s.match(/\d+/g) || []).map(Number) };
};
export const compareIds = (a, b) => {
  const ka = idKey(a), kb = idKey(b);
  if (ka.rank !== kb.rank || ka.prefix !== kb.prefix) return ka.rank - kb.rank || ka.prefix.localeCompare(kb.prefix);
  for (let i = 0; i < Math.max(ka.nums.length, kb.nums.length); i++) {
    const x = ka.nums[i] ?? -1, y = kb.nums[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
};

// Где должен лежать файл элемента (путь от корня плана) — по родителям. null — если родитель неизвестен.
export function expectedPath(plan, it) {
  const T = TYPES[it.type];
  if (!T) return null;
  if (T.folder) return `${T.folder}/${it.name}.md`;
  if (it.type === 'epic') return `${it.name}/${it.name}.md`;
  const parent = it.parentName && plan.byName.get(it.parentName);
  if (!parent) return null;
  const parentDir = dirOf(parent.file);
  return it.type === 'feature' ? `${parentDir}/${it.name}/${it.name}.md` : `${parentDir}/${it.name}.md`;
}

// Подсказки шаблонов (<!-- … -->): по ним видно, что файл не дописали после создания.
let HINTS = null;
function templateHints() {
  if (HINTS) return HINTS;
  const found = new Set();
  for (const t of Object.keys(TYPES)) {
    try { for (const h of readText(path.join(PLUGIN_ROOT, 'templates', `${t}.md`)).text.match(/<!--[\s\S]*?-->/g) || []) found.add(h); } catch { /* шаблона нет */ }
  }
  HINTS = [...found];
  return HINTS;
}

const kindOf = (it) => (it.type === 'epic' ? 'эпик' : 'фича');

// board: false — не проверять ссылки Board.md (доску как раз пересобирают по этому отчёту).
export function checkPlan(plan, { board = true } = {}) {
  const errors = []; const warnings = [];
  const err = (it, code, msg) => errors.push({ file: it.file, id: it.id || null, code, msg });
  const warn = (it, code, msg) => warnings.push({ file: it.file, id: it.id || null, code, msg });
  const checkLinks = (it) => { for (const l of new Set(it.links)) if (!linkTargetExists(plan, l)) err(it, 'broken-link', `битая ссылка [[${l}]]`); };
  analyze(plan);

  // Служебные файлы в корне: только ссылки
  for (const it of plan.all) if (!it.file.includes('/') && SERVICE_FILES.includes(it.name) && (board || it.name !== 'Board')) checkLinks(it);

  // Одинаковые имена файлов в разных папках — ссылка [[Имя]] становится неоднозначной
  const byBase = new Map();
  for (const it of plan.all) byBase.set(it.name, [...(byBase.get(it.name) || []), it.file]);
  for (const [name, files] of byBase) if (files.length > 1) for (const f of files.slice(1)) errors.push({ file: f, id: null, code: 'duplicate-name', msg: `имя «${name}» уже есть: ${files[0]} — ссылки [[${name}]] неоднозначны` });

  const seenIds = new Map();
  const hints = templateHints();
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
      if (!T.idRe.test(it.id)) err(it, 'bad-id', `ID «${it.id}» не по формату ${T.idHint}`);
      if (!it.name.startsWith(it.id + ' ')) err(it, 'id-filename', `имя файла должно начинаться с «${it.id} »`);
      // Задача нумеруется внутри своей фичи: у F-07 — F07-01, F07-02…
      const parentItem = T.work && it.parentName && plan.byName.get(it.parentName);
      if (parentItem?.type === 'feature' && T.idRe.test(it.id) && !it.id.startsWith(featureCode(parentItem.id) + '-')) {
        err(it, 'id-parent', `ID ${it.id} не от своей фичи ${parentItem.id} — ожидается ${featureCode(parentItem.id)}-NN (перенос задачи — командой move)`);
      }
    }
    const expected = expectedPath(plan, it);
    if (expected && expected !== it.file) err(it, 'wrong-folder', `файл должен лежать в ${dirOf(expected) || 'корне плана'}/ (сейчас: ${it.file})`);
    if (it.heading !== it.name) err(it, 'heading', it.heading ? `заголовок «# ${it.heading}» не совпадает с именем файла` : 'нет заголовка «# …»');

    // Поля
    if (it.status && !T.statuses.includes(it.status)) err(it, 'unknown-status', `статус «${it.status}» недопустим для ${it.type} (${T.statuses.join(', ')})`);
    for (const k of T.required) if (it.fm[k] === undefined) err(it, 'missing-field', `нет обязательного поля ${k}`);
    if (it.fm.priority !== undefined && !PRIORITIES.includes(it.fm.priority)) err(it, 'bad-value', `priority «${it.fm.priority}» — допустимо ${PRIORITIES.join(', ')}`);
    if (it.fm.size !== undefined && !SIZES.includes(it.fm.size)) err(it, 'bad-value', `size «${it.fm.size}» — допустимо ${SIZES.join(', ')}; больше L — разбей задачу`);
    if (it.fm.created && !/^\d{4}-\d{2}-\d{2}$/.test(it.fm.created)) warn(it, 'bad-date', `created «${it.fm.created}» — ожидается YYYY-MM-DD`);
    if (it.fm.role !== undefined && !/^[a-z][a-z0-9-]*$/.test(it.fm.role)) warn(it, 'bad-role', `role «${it.fm.role}» — латиница строчными, без пробелов`);
    if (it.fm.former_ids !== undefined && (!T.work || !it.formerIds.every((x) => WORK_ID.test(x)))) warn(it, 'bad-former-ids', 'former_ids — список прежних ID задачи (его ведут move и migrate)');

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
    checkLinks(it);

    // Тело
    if (!it.summary) warn(it, 'no-summary', 'нет блока «Коротко» сразу под заголовком');
    else for (const label of T.summary) {
      if (!(label in it.summary)) warn(it, 'summary-field', `в «Коротко» нет строки **${label}:**`);
      else if (!it.summary[label]) warn(it, 'summary-empty', `в «Коротко» пустая строка **${label}:**`);
    }
    if (T.journal && !it.hasLog) warn(it, 'no-log', 'нет раздела «## Журнал»');
    if (it.status !== 'draft') {
      const left = hints.filter((h) => it.body.includes(h)).length;
      if (left) warn(it, 'template-hints', `остались подсказки шаблона <!-- … --> (${left}) — допиши файл и удали их`);
    }

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

  // Открытые задачи: незакрытые зависимости у in-progress, зависимость от отменённой, закрытый родитель
  for (const it of plan.items) {
    if (!isWork(it) || CLOSED.includes(it.status)) continue;
    for (const d of it.deps) {
      const dep = d.name && plan.byName.get(d.name);
      if (!dep || !dep.type) continue; // битая ссылка — уже ошибка
      if (it.status === 'in-progress' && dep.status !== 'done') warn(it, 'in-progress-blocked', `in-progress, но зависимость [[${d.name}]] — ${dep.status}`);
      if (dep.status === 'cancelled') warn(it, 'dep-cancelled', `зависимость [[${d.name}]] отменена — задача не станет готовой: убери или замени зависимость`);
    }
    if (it.parentClosed) err(it, 'parent-closed', `${kindOf(it.parentClosed)} [[${it.parentClosed.name}]] — ${it.parentClosed.status}, а задача открыта: отмени её, перенеси (move) в открытую фичу или открой родителя`);
  }
  for (const f of plan.items) {
    if (f.type !== 'feature' || CLOSED.includes(f.status)) continue;
    const e = f.parentName && plan.byName.get(f.parentName);
    if (e?.type === 'epic' && CLOSED.includes(e.status)) err(f, 'parent-closed', `эпик [[${e.name}]] — ${e.status}, а фича открыта: закрой или перенеси фичу либо открой эпик`);
  }
  // Больше одной in-progress задачи у роли
  const byRole = new Map();
  for (const it of plan.items) if (isWork(it) && it.status === 'in-progress' && it.fm.role) byRole.set(it.fm.role, [...(byRole.get(it.fm.role) || []), it]);
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

  const order = (a, b) => compareIds(a.id || '', b.id || '') || a.file.localeCompare(b.file);
  errors.sort(order); warnings.sort(order);
  return { files: plan.all.length, errors, warnings };
}

// ─── Граф: блокировки, кандидаты, критический путь ─────────────────────────

const isWork = (it) => !!TYPES[it.type]?.work;
const sprintNum = (s) => (s && /^S-\d+$/.test(s) ? Number(s.slice(2)) : Infinity);

// Закрытый родитель задачи: фича или её эпик в done/cancelled. Такие задачи в очередь не попадают.
function closedParent(plan, it) {
  const f = it.parentName && plan.byName.get(it.parentName);
  if (!f || !f.type) return null;
  if (CLOSED.includes(f.status)) return f;
  const e = f.parentName && plan.byName.get(f.parentName);
  return e?.type === 'epic' && CLOSED.includes(e.status) ? e : null;
}

// Закрыт ли контейнер — сама фича (эпик) или эпик фичи. В закрытый контейнер новое не добавляют.
function closedContainer(plan, group) {
  if (CLOSED.includes(group.status)) return group;
  const e = group.type === 'feature' && group.parentName && plan.byName.get(group.parentName);
  return e?.type === 'epic' && CLOSED.includes(e.status) ? e : null;
}
const closedMsg = (c) => `${kindOf(c)} ${c.id} — ${c.status}: в закрытую фичу или эпик задачи не добавляют и не открывают. Выбери открытую фичу или сначала открой ${c.id} (set ${c.id} in-progress)`;

// Для каждой задачи: незакрытые зависимости, кого она блокирует (вычисляется, не хранится), закрытый родитель.
// Считается один раз на загруженный план.
export function analyze(plan) {
  if (plan.analysis) return plan.analysis;
  const work = plan.items.filter(isWork).sort((a, b) => compareIds(a.id, b.id));
  for (const it of plan.items) { it.blocks = []; it.openDeps = []; }
  for (const it of work) {
    for (const d of it.deps) {
      const dep = d.name && plan.byName.get(d.name);
      // Зависимости нет в плане (битая ссылка) — задача ждёт, пока с ней не разберутся, а не считается свободной.
      if (!dep || !dep.type) { it.openDeps.push({ id: null, name: d.name || String(d.raw), status: 'missing', missing: true }); continue; }
      if (dep.status !== 'done') it.openDeps.push(dep);
      dep.blocks.push(it);
    }
    it.openDeps.sort((a, b) => compareIds(a.id || a.name, b.id || b.name));
    it.parentClosed = closedParent(plan, it);
  }
  for (const it of work) it.blocks.sort((a, b) => compareIds(a.id, b.id));
  const open = work.filter((it) => !CLOSED.includes(it.status));
  const currentSprint = open.map((it) => it.fm.sprint).filter(Boolean).sort((a, b) => sprintNum(a) - sprintNum(b))[0] || null;
  plan.analysis = { work, open, currentSprint };
  return plan.analysis;
}

// Кандидаты next: ready, все зависимости done, родитель не закрыт. Порядок — по порядку плана: сначала текущий спринт, внутри — по ID.
// Приоритет и «сколько разблокирует» очередь не переставляют (решение пользователя: задачи идут по порядку).
export function nextCandidates(plan, { role } = {}) {
  const { work, currentSprint } = analyze(plan);
  return work
    .filter((it) => it.status === 'ready' && it.openDeps.length === 0 && !it.parentClosed && (!role || it.fm.role === role))
    .sort((a, b) =>
      (a.fm.sprint === currentSprint ? 0 : 1) - (b.fm.sprint === currentSprint ? 0 : 1) ||
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

// Все когда-либо выданные ID: текущие, прежние (former_ids) и ID из имён файлов — даже если frontmatter сломан.
function usedIds(plan) {
  const out = [];
  for (const it of plan.all) {
    if (it.fm?.id) out.push(String(it.fm.id));
    out.push(...listValue(it.fm?.former_ids));
    const m = it.name.match(/^([A-Z]+-?\d+(?:-\d+)?) /);
    if (m) out.push(m[1]);
  }
  return out;
}

// Следующий свободный ID. Для задач нужна фича: номер берётся внутри неё (F07-01, F07-02…).
// Номера не переиспользуются: учитываются все файлы (в том числе done и cancelled) и прежние ID перенесённых задач.
export function nextId(plan, type, parentRef) {
  const T = TYPES[type];
  if (!T) throw new Error(`неизвестный тип «${type}»`);
  const used = usedIds(plan);
  const max = (re) => Math.max(0, ...used.map((x) => x.match(re)).filter(Boolean).map((m) => Number(m[1])));
  if (T.work) {
    const f = parentRef && findItem(plan, parentRef);
    if (!f || f.type !== 'feature') throw new Error('для задачи нужна фича: new-id task --parent F-07');
    const code = featureCode(f.id);
    const n = max(new RegExp(`^${escapeRe(code)}-(\\d+)$`)) + 1;
    if (n > 99) throw new Error(`в фиче ${f.id} уже 99 задач — разбей фичу`);
    return `${code}-${String(n).padStart(2, '0')}`;
  }
  const prefix = { epic: 'E', feature: 'F' }[type] || T.prefix;
  const width = T.width || 2;
  return `${prefix}-${String(max(new RegExp(`^${prefix}-(\\d+)$`)) + 1).padStart(width, '0')}`;
}

// ─── Доска ──────────────────────────────────────────────────────────────────

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const link = (it) => `[[${it.name}]]`;
const short = (it, table = true) => `[[${it.name}${table ? '\\|' : '|'}${it.id}]]`;
const what = (it) => cell(it.summary?.['Что'] || '');
// Незакрытая зависимость для колонки «Ждёт»: ссылкой; отменённая — с пометкой; зависимости нет в плане — текстом (ссылка была бы битой).
const waitFor = (d) => (d.missing ? `«${cell(d.name)}» (нет в плане)` : `${short(d)}${d.status === 'cancelled' ? ' (отменена)' : ''}`);

export function renderBoard(plan, { report } = {}) {
  const { work, currentSprint } = analyze(plan);
  report ||= checkPlan(plan, { board: false });
  const sorted = (list) => [...list].sort((a, b) => compareIds(a.id, b.id));
  const L = [];
  const table = (head, rows) => {
    if (!rows.length) { L.push('—', ''); return; }
    L.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`), '');
  };
  const section = (title) => L.push(`## ${title}`, '');

  L.push('# Доска', '');
  L.push(`> ${BOARD_MARK} (\`/task:board\`) — **руками не править**, изменения перезапишутся.${plan.byName.has('Readme') ? ' Как устроен план — [[Readme]].' : ''}`);
  L.push(report.errors.length || report.warnings.length
    ? `> Проверка плана: ошибок ${report.errors.length}, предупреждений ${report.warnings.length} — подробности: \`/task:board\`.`
    : '> Проверка плана: ✓ без ошибок и предупреждений.');
  L.push('');

  const free = (it) => it.openDeps.length === 0 && !it.parentClosed;
  const ready = work.filter((it) => it.status === 'ready' && free(it));
  const blocked = work.filter((it) => ['draft', 'ready'].includes(it.status) && !free(it));
  const drafts = work.filter((it) => it.status === 'draft' && free(it));
  const role = (it) => cell(it.fm.role || '—');
  const unblocks = (it) => it.blocks.filter((b) => !CLOSED.includes(b.status)).map((b) => short(b)).join(', ') || '—';
  const waits = (it) => [...it.openDeps.map(waitFor), ...(it.parentClosed ? [`${kindOf(it.parentClosed)} ${short(it.parentClosed)} — ${it.parentClosed.status}`] : [])].join(', ');

  section('Готово к работе');
  table(['Задача', 'Роль', 'Коротко', 'Разблокирует'], sorted(ready).map((it) => [link(it), role(it), what(it), unblocks(it)]));
  section('В работе');
  table(['Задача', 'Роль', 'Коротко'], sorted(work.filter((it) => it.status === 'in-progress')).map((it) => [link(it), role(it), what(it)]));
  section('На проверке');
  table(['Задача', 'Роль', 'Коротко'], sorted(work.filter((it) => it.status === 'review')).map((it) => [link(it), role(it), what(it)]));
  section('Черновики');
  table(['Задача', 'Роль', 'Коротко'], sorted(drafts).map((it) => [link(it), role(it), what(it)]));
  section('Заблокировано');
  table(['Задача', 'Ждёт'], sorted(blocked).map((it) => [link(it), waits(it)]));
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

export function writeBoard(plan, report) {
  fs.writeFileSync(path.join(plan.root, 'Board.md'), renderBoard(plan, { report }));
}

// ─── show / set: карточка задачи и смена статуса ────────────────────────────

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const brief = (x) => ({ id: x.id, name: x.name, status: x.status });
const depLabel = (d) => (d.missing ? `«${d.name}» (нет в плане)` : `${d.id} (${d.status})`);

export function showItem(plan, ref) {
  analyze(plan);
  const it = findItem(plan, ref);
  if (!it) return null;
  return {
    id: it.id, name: it.name, type: it.type, status: it.status, role: it.fm.role || null,
    priority: it.fm.priority || null, size: it.fm.size || null, sprint: it.fm.sprint || null,
    file: path.join(plan.root, it.file), parent: it.parentName, summary: it.summary || {},
    criteria: it.criteria, logEntries: it.logEntries ?? 0, formerIds: it.formerIds || [],
    parentClosed: it.parentClosed ? brief(it.parentClosed) : null,
    openDeps: (it.openDeps || []).map((d) => ({ id: d.id, name: d.name, status: d.status, missing: !!d.missing })),
    blocks: (it.blocks || []).map(brief),
  };
}

// Поле frontmatter: заменить `key: …` (вместе со строками его списка) или добавить после поля after, иначе в конец frontmatter.
export function setField(text, key, value, { after } = {}) {
  const m = text.match(/^---\n([\s\S]*?)\n---(?=\n|$)/);
  if (!m) throw new Error('нет frontmatter');
  const lines = m[1].split('\n');
  const at = (k) => lines.findIndex((l) => l.startsWith(`${k}:`));
  const line = `${key}: ${value}`;
  const i = at(key);
  if (i >= 0) { let j = i + 1; while (j < lines.length && /^\s+-/.test(lines[j])) j++; lines.splice(i, j - i, line); }
  else { const a = after ? at(after) : -1; lines.splice(a >= 0 ? a + 1 : lines.length, 0, line); }
  return `---\n${lines.join('\n')}\n---${text.slice(m[0].length)}`;
}

// Запись журнала: `- **дата · кто:** текст`; следующие строки текста — вложенными строками под ней.
export function logEntry(date, who, text) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  if (!lines.length) return null;
  return [`- **${date} · ${who}:** ${lines[0].trim().replace(/^-\s+/, '')}`, ...lines.slice(1).map((l) => (/^\s/.test(l) ? l : `  ${l}`))].join('\n');
}

// Дописать запись в конец раздела «Журнал» (текст с LF) — даже если после него есть другие разделы.
// Нет раздела — создаётся в конце; первая запись отделена от заголовка пустой строкой.
export function appendLog(text, entry) {
  const lines = text.replace(/\s*$/, '').split('\n');
  const fence = fenceMask(lines);
  const h = lines.findIndex((l, i) => !fence[i] && /^## Журнал\s*$/.test(l));
  if (h < 0) return `${lines.join('\n')}\n\n## Журнал\n\n${entry}\n`;
  let end = lines.length;
  for (let i = h + 1; i < lines.length; i++) if (!fence[i] && /^#{1,2} /.test(lines[i])) { end = i; break; }
  let last = end - 1;
  while (last > h && !lines[last].trim()) last--;
  const tail = lines.slice(end);
  return [...lines.slice(0, last + 1), ...(last === h ? ['', entry] : [entry]), ...(tail.length ? ['', ...tail] : [])].join('\n') + '\n';
}

function childrenOf(plan, parent) {
  if (parent.type === 'feature') return plan.items.filter((x) => isWork(x) && x.parentName === parent.name);
  if (parent.type === 'epic') return plan.items.filter((x) => x.type === 'feature' && x.parentName === parent.name);
  return [];
}

// Ставит статус и дописывает запись в «Журнал». Возвращает { item, … } или { error }.
// session — ID сессии Claude Code: сессия, которая взяла задачу, получит напоминание хука Stop, если не оставит итог.
export function setStatus(plan, ref, status, { log, who = 'Claude', force = false, promotedTo, take = false, session, date = today() } = {}) {
  return withLock(plan.root, () => {
    const cur = loadPlan(plan.root);
    analyze(cur);
    const it = findItem(cur, ref);
    if (!it) return { error: `задача «${ref}» не найдена` };
    const T = TYPES[it.type];
    if (!T) return { error: `у «${it.name}» неизвестный тип` };
    if (!it.id) return { error: `у «${it.name}» нет поля id — поправь frontmatter (check покажет, что не так)` };
    if (!T.statuses.includes(status)) return { error: `статус «${status}» недопустим для ${it.type} (${T.statuses.join(', ')})` };
    if (take && (!T.work || status !== 'in-progress')) return { error: '--take — только для задачи и только со статусом in-progress' };
    const starting = status === 'in-progress' && it.status !== 'in-progress';
    if (starting && it.openDeps?.length && !force) {
      return { error: `не закрыты зависимости: ${it.openDeps.map(depLabel).join(', ')}. Взять всё равно — с --force`, code: 'open-deps' };
    }
    // Закрытый родитель: задачу или фичу внутри него не открывают (ни в работу, ни обратно в draft/ready) — даже с --force.
    if (!CLOSED.includes(status)) {
      const c = T.work ? it.parentClosed : it.type === 'feature' && it.parentName ? closedContainer(cur, cur.byName.get(it.parentName) || {}) : null;
      if (c) return { error: closedMsg(c), code: 'parent-closed' };
    }
    // Фичу или эпик не закрывают, пока внутри есть открытые задачи или фичи.
    if (CLOSED.includes(status) && !T.work && ['feature', 'epic'].includes(it.type)) {
      const open = childrenOf(cur, it).filter((x) => !CLOSED.includes(x.status));
      if (open.length) return { error: `внутри ${it.id} открыты: ${open.map((x) => `${x.id} (${x.status})`).join(', ')} — сначала закрой, отмени или перенеси их (move)`, code: 'open-children' };
    }
    let promoted = null;
    if (promotedTo) {
      if (it.type !== 'idea') return { error: '--promoted-to — только для идей' };
      promoted = findItem(cur, promotedTo);
      if (!promoted) return { error: `promoted_to: «${promotedTo}» не найден` };
    }
    const entry = log ? logEntry(date, who, log) : null;
    const file = path.join(cur.root, it.file);
    const doc = readText(file);
    let text = setField(doc.text, 'status', status, { after: 'type' });
    if (promoted) text = setField(text, 'promoted_to', `"[[${promoted.name}]]"`, { after: 'status' });
    if (entry) text = appendLog(text, entry);
    writeText(file, text, doc);
    const fresh = loadPlan(cur.root);
    writeBoard(fresh);
    analyze(fresh);
    const self = fresh.byName.get(it.name);
    if (T.work && status === 'in-progress' && (starting || take) && session) claimTask(cur.root, session, it.id, self.logEntries);
    if (T.work && status !== 'in-progress') releaseTask(cur.root, it.id);
    const openBlocked = (self.blocks || []).filter((b) => !CLOSED.includes(b.status));
    const unblocked = status === 'done' ? openBlocked.filter((b) => b.openDeps.length === 0 && !b.parentClosed).map(brief) : [];
    const waiting = status === 'cancelled' ? openBlocked.map(brief) : [];
    // Все задачи фичи (или все фичи эпика) закрыты → подсказать закрыть родителя (сам родитель не меняется).
    let parentComplete = null;
    const parent = self.parentName && fresh.byName.get(self.parentName);
    if (CLOSED.includes(status) && parent && !CLOSED.includes(parent.status)) {
      const siblings = childrenOf(fresh, parent);
      if (siblings.length && siblings.every((x) => CLOSED.includes(x.status))) parentComplete = brief(parent);
    }
    return { item: showItem(fresh, it.id), logged: !!entry, unblocked, waiting, parentComplete };
  });
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

// status и type — одно значение или несколько через запятую.
export function listItems(plan, { status, role, type } = {}) {
  analyze(plan);
  const many = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null);
  const statuses = many(status), types = many(type);
  return plan.items
    .filter((it) => it.type && (!types || types.includes(it.type)) && (!statuses || statuses.includes(it.status)) && (!role || it.fm.role === role))
    .sort((a, b) => compareIds(a.id, b.id))
    .map((it) => ({ id: it.id, name: it.name, type: it.type, status: it.status, role: it.fm.role || null, what: it.summary?.['Что'] || '', file: path.join(plan.root, it.file) }));
}

// ─── Служебная папка плана: блокировка и владение задачами ──────────────────
// <план>/.claude-tasks/ — скрытая (Obsidian её не показывает) и сама себя исключает из git (.gitignore с «*»).

const STATE_DIR = '.claude-tasks';

function stateDir(root) {
  const dir = path.join(root, STATE_DIR);
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  return dir;
}

// Команды, которые меняют план, не идут параллельно: lock создаётся атомарно (wx).
// Две сессии не получат один ID и не потеряют запись журнала. Зависший lock старше stale мс снимается.
const held = new Set();
export function withLock(root, fn, { wait = 15000, stale = 10000 } = {}) {
  const key = path.resolve(root);
  if (held.has(key)) return fn();
  const lock = path.join(stateDir(root), 'lock');
  const start = Date.now();
  for (;;) {
    try { fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if (age > stale) { fs.rmSync(lock, { force: true }); continue; }
      if (Date.now() - start > wait) throw new Error(`план занят другой командой (${lock}); если она зависла — удали этот файл`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  held.add(key);
  try { return fn(); } finally { held.delete(key); fs.rmSync(lock, { force: true }); }
}

// Владение «сессия → задача» для хука Stop: <план>/.claude-tasks/sessions/<сессия[:агент]>.json.
// Пишет его скрипт (set, когда сессия берёт задачу) и хук (правка файла, которая сама ставит in-progress).
const sessionFile = (root, key) => path.join(root, STATE_DIR, 'sessions', `${String(key).replace(/[^\w.-]/g, '_')}.json`);

export function readOwnership(root, key) {
  try { const own = JSON.parse(fs.readFileSync(sessionFile(root, key), 'utf8')); return { tasks: {}, ...own }; } catch { return { tasks: {} }; }
}

function writeOwnership(root, key, own) {
  const file = sessionFile(root, key);
  if (!Object.keys(own.tasks || {}).length) { fs.rmSync(file, { force: true }); return; }
  stateDir(root);
  fs.writeFileSync(file, JSON.stringify({ ...own, updated: Date.now() }, null, 2));
}

export function claimTask(root, key, id, baseline) {
  const own = readOwnership(root, key);
  own.tasks[id] = { baseline };
  writeOwnership(root, key, own);
  // Уборка: состояния сессий старше недели
  const dir = path.dirname(sessionFile(root, key)); const weekAgo = Date.now() - 7 * 864e5;
  for (const f of fs.readdirSync(dir)) { try { if (fs.statSync(path.join(dir, f)).mtimeMs < weekAgo) fs.rmSync(path.join(dir, f)); } catch { /* уже удалён */ } }
}

// Задача больше не in-progress — её никто не «держит».
export function releaseTask(root, id) {
  const dir = path.join(root, STATE_DIR, 'sessions');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const file = path.join(dir, f);
    try {
      const own = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!own.tasks?.[id]) continue;
      delete own.tasks[id];
      if (Object.keys(own.tasks).length) fs.writeFileSync(file, JSON.stringify(own, null, 2)); else fs.rmSync(file, { force: true });
    } catch { /* битый файл состояния — пропускаем */ }
  }
}

// ─── new: файл из шаблона ───────────────────────────────────────────────────

// Название попадает в имя файла: без символов, запрещённых в именах и ссылках, и без точки/пробела в конце
// (Windows их отрезает — имя файла разошлось бы с заголовком).
function titleProblem(title) {
  if (!title) return 'нужно название: --title "Короткое название"';
  if (/[\\/:*?"<>|#^[\]]/.test(title)) return 'в названии недопустимы символы \\ / : * ? " < > | # ^ [ ]';
  if (/[\u0000-\u001f\u007f]/.test(title)) return 'в названии недопустимы переводы строк и управляющие символы';
  if (/[.\s]$/.test(title)) return 'название не может кончаться точкой или пробелом: Windows отрезает их у имени файла, и оно разойдётся с заголовком';
  return null;
}

// Создаёт файл нужного типа из шаблона: ID, папка, имя, frontmatter. Тело (подсказки <!-- -->) заполняет агент.
export function createItem(plan, type, { title, parent, depends = [], role, priority, size, status, task, date = today() } = {}) {
  const T = TYPES[type];
  if (!T) return { error: `неизвестный тип «${type}» (${Object.keys(TYPES).join(', ')})` };
  title = String(title || '').trim();
  const bad = titleProblem(title);
  if (bad) return { error: bad };
  if (priority && !PRIORITIES.includes(priority)) return { error: `priority: ${PRIORITIES.join(', ')}` };
  if (size && !SIZES.includes(size)) return { error: `size: ${SIZES.join(', ')} (больше L — разбей задачу)` };
  if (status && !T.statuses.includes(status)) return { error: `статус «${status}» недопустим для ${type}` };
  if (role && !/^[a-z][a-z0-9-]*$/.test(role)) return { error: 'role — латиница строчными, без пробелов (например, gamedesigner)' };
  // Под блокировкой и по свежему плану: параллельная сессия не выдаст тот же ID.
  return withLock(plan.root, () => {
    const cur = loadPlan(plan.root);
    const resolve = (ref, what) => {
      const it = findItem(cur, ref);
      if (!it) throw new Error(`${what}: «${ref}» не найден`);
      return it;
    };
    let parentItem = null, taskItem = null, depItems = [];
    try {
      if (T.parent) {
        if (!parent) return { error: `для ${type} нужен родитель (${T.parent}): --parent <ID>` };
        parentItem = resolve(parent, 'parent');
        if (parentItem.type !== T.parent) return { error: `родитель ${type} должен быть ${T.parent}, а ${parentItem.id} — ${parentItem.type}` };
        const closed = closedContainer(cur, parentItem);
        if (closed) return { error: closedMsg(closed), code: 'parent-closed' };
      }
      if (T.work) depItems = depends.map((d) => resolve(d, 'depends_on'));
      for (const d of depItems) if (!isWork(d)) return { error: `зависеть можно только от задач, а ${d.id} — ${d.type}` };
      if (type === 'adr' && task) taskItem = resolve(task, 'task');
    } catch (e) { return { error: e.message }; }

    let id;
    try { id = nextId(cur, type, parentItem?.id); } catch (e) { return { error: e.message }; }
    const name = `${id} ${title}`;
    const parentDir = parentItem ? path.dirname(path.join(cur.root, parentItem.file)) : cur.root;
    const file = T.folder ? path.join(cur.root, T.folder, `${name}.md`)
      : type === 'epic' ? path.join(cur.root, name, `${name}.md`)
      : type === 'feature' ? path.join(parentDir, name, `${name}.md`)
      : path.join(parentDir, `${name}.md`);
    if (fs.existsSync(file)) return { error: `файл уже есть: ${file}` };
    let text = readText(path.join(PLUGIN_ROOT, 'templates', `${type}.md`)).text;
    const values = { id, title, date, role, priority: priority || 'must', size: size || 'M', parent: parentItem?.name, task: taskItem?.name };
    if (!role) text = text.replace(/^role: "\{\{role\}\}"\n/m, '');
    if (type === 'adr' && !taskItem) text = text.replace(/^task: "\[\[\{\{task\}\}\]\]"\n/m, '');
    // Метки — функциями: $ в названиях не превращается в шаблон замены ($&, $1…)
    text = text.replace(/"\{\{(\w+)\}\}"/g, (_, k) => values[k]).replace(/\{\{(\w+)\}\}/g, (_, k) => values[k]);
    if (depItems.length) text = text.replace(/^depends_on: \[\]$/m, () => `depends_on:\n${depItems.map((d) => `  - "[[${d.name}]]"`).join('\n')}`);
    if (status) text = text.replace(/^status: .*$/m, () => `status: ${status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { flag: 'wx' });
    writeBoard(loadPlan(cur.root));
    return { id, name, type, file };
  });
}

// ─── help: команды из скилов плагина + подсказка по состоянию ───────────────

// Порядок в справке — по сценарию работы; новые скилы без места в списке идут в конец по алфавиту.
const HELP_ORDER = ['init', 'create', 'split', 'next', 'done', 'replan', 'idea', 'board', 'help'];

export function readSkills(pluginRoot = PLUGIN_ROOT) {
  const dir = path.join(pluginRoot, 'skills');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map((e) => {
      const file = path.join(dir, e.name, 'SKILL.md');
      const m = readText(file).text.match(/^---\n([\s\S]*?)\n---/);
      const fm = m ? parseFrontmatter(m[1]).fm : {};
      const name = fm.name || e.name;
      return { name, command: `/task:${name}`, args: fm['argument-hint'] || '', description: fm.description || '', userInvoked: fm['disable-model-invocation'] === 'true', file };
    })
    .sort((a, b) => {
      const ia = HELP_ORDER.indexOf(a.name), ib = HELP_ORDER.indexOf(b.name);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
    });
}

export function planState(root) {
  if (!root || !fs.existsSync(root)) return { exists: false };
  const plan = loadPlan(root);
  const byStatus = (s) => listItems(plan, { status: s }).filter((x) => TYPES[x.type]?.work).map((x) => x.id);
  return { exists: true, root, items: plan.items.length, inProgress: byStatus('in-progress'), review: byStatus('review'), next: nextCandidates(plan).map((c) => c.id) };
}

// Соглашение для скилов: в description короткая часть идёт до « — » — она и попадает в список справки.
export const shortDescription = (d) => String(d || '').split(' — ')[0].replace(/[.]\s*$/, '');

export function renderHelp(skills, state) {
  const L = ['Плагин task — план задач проекта в Docs/Tasks/ (Markdown + Obsidian).', '', 'Команды:'];
  const cmds = skills.filter((s) => s.userInvoked);
  const width = Math.max(...cmds.map((s) => `${s.command} ${s.args}`.trim().length));
  for (const s of cmds) L.push(`  ${`${s.command} ${s.args}`.trim().padEnd(width)}  ${shortDescription(s.description)}`);
  const bg = skills.filter((s) => !s.userInvoked);
  if (bg.length) { L.push('', 'Подключаются сами:'); for (const s of bg) L.push(`  task:${s.name} — ${shortDescription(s.description)}`); }
  L.push('', 'Сейчас:');
  if (!state.exists) L.push('  Плана в проекте нет — начни с /task:init.');
  else {
    if (!state.items) L.push('  План пуст — опиши цель: /task:create, затем /task:split.');
    if (state.inProgress.length) L.push(`  В работе: ${state.inProgress.join(', ')} — не забудь обновить статус и журнал (или /task:done).`);
    if (state.review.length) L.push(`  Ждут вашей проверки: ${state.review.join(', ')} — после проверки /task:done.`);
    if (state.next.length) L.push(`  Готово к работе: ${state.next.slice(0, 5).join(', ')}${state.next.length > 5 ? ' …' : ''} — /task:next.`);
    else if (state.items) L.push('  Готовых задач нет — /task:board покажет, что блокирует.');
  }
  L.push('', 'Подробнее о команде: /task:help <команда>.');
  return L.join('\n');
}

// ─── hooks: контроль статусов ───────────────────────────────────────────────
// Выключить в проекте: "env": { "TASK_HOOKS": "off" } в .claude/settings.json.
// Хуки работают только в плане плагина (доска с пометкой BOARD_MARK) — чужие docs/tasks не трогаются.

const hookKey = (input) => `${input.session_id || 'unknown'}${input.agent_id ? ':' + input.agent_id : ''}`;

// Файл внутри плана этого проекта? (а не в Docs/Tasks другого проекта)
function insidePlan(fp, root, cwd) {
  if (!fp) return false;
  const rel = path.relative(root, path.resolve(cwd || root, fp));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Правка сама переводит задачу в in-progress: status был другим — стал in-progress (или новый файл сразу в работе).
function editTakes(ti, response) {
  const IP = /^status:\s*in-progress\s*$/m;
  const pairs = [[ti.old_string, ti.new_string], ...(Array.isArray(ti.edits) ? ti.edits.map((e) => [e.old_string, e.new_string]) : [])];
  if (pairs.some(([o, n]) => typeof n === 'string' && IP.test(n) && !(typeof o === 'string' && IP.test(o)))) return true;
  return typeof ti.content === 'string' && IP.test(ti.content) && response?.type === 'create';
}

// Ошибка касается файла: в нём самом или упоминает его имя, путь или ID.
const mentions = (msg, it) => msg.includes(`[[${it.name}]]`) || msg.includes(it.file) || (!!it.id && new RegExp(`(?<![\\w-])${escapeRe(it.id)}(?![\\w-])`).test(msg));

export function runHook(event, input, env = process.env) {
  const none = { code: 0, stdout: '' };
  if (String(env.TASK_HOOKS || '').toLowerCase() === 'off') return none;
  const cwd = input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findRoot(null, { cwd, projectDir: env.CLAUDE_PROJECT_DIR });
  if (!root) return none;
  const script = `node "${path.join(PLUGIN_ROOT, 'scripts', 'tasks.mjs')}"`;

  if (event === 'session-start') {
    // ID сессии — в окружение Bash: скрипт по нему запоминает, какая сессия взяла задачу (есть и CLAUDE_CODE_SESSION_ID)
    if (env.CLAUDE_ENV_FILE && input.session_id) { try { fs.appendFileSync(env.CLAUDE_ENV_FILE, `export TASK_SESSION_ID='${String(input.session_id).replace(/'/g, '')}'\n`); } catch { /* нет доступа — не страшно */ } }
    const plan = loadPlan(root);
    const list = (s) => listItems(plan, { status: s }).filter((x) => TYPES[x.type]?.work).map((x) => `${x.id}${x.role ? ` (${x.role})` : ''}`);
    const inProgress = list('in-progress'), review = list('review');
    const ready = nextCandidates(plan).map((c) => c.id);
    const where = path.relative(env.CLAUDE_PROJECT_DIR || cwd, root).split(path.sep).join('/') || root;
    const ctx = [
      `В проекте ведётся план задач: ${where}/ (плагин task). Формат и правила — скил task:format; загрузи его, прежде чем создавать или вести задачи.`,
      `Главное: взял задачу — сразу статус in-progress и запись в «Журнал»; закончил — отметь критерии, поставь done (или review, если проверяет человек) и запиши итог. Одной командой: ${script} set <ID> <статус> --log "…" --who "<роль> (Claude)". Продолжаешь свою задачу в новой сессии — добавь --take. Текст с Markdown (обратные кавычки, $, кавычки) передавай через stdin: --log - (bash: <<'EOF' … EOF; PowerShell: @'…'@ | node …). Чужие задачи без согласия человека не меняй.`,
      `Сейчас в работе: ${inProgress.join(', ') || '—'}. Ждут проверки человеком: ${review.join(', ') || '—'}. Готово к работе: ${ready.slice(0, 5).join(', ') || '—'}.`,
      'Команды для человека: /task:help.',
    ].join('\n');
    return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }) };
  }

  if (event === 'post-tool-use') {
    // Только правки заметок плана (Write/Edit): доска пересобирается, ошибки этой правки — агенту.
    const ti = input.tool_input || {};
    const fp = ti.file_path || ti.path || '';
    if (!insidePlan(fp, root, cwd)) return none;
    const rel = path.relative(root, path.resolve(cwd, fp)).split(path.sep).join('/');
    if (!rel.endsWith('.md') || rel.toLowerCase() === 'board.md' || rel.split('/').some((s) => s.startsWith('.'))) return none;
    const plan = loadPlan(root);
    const report = checkPlan(plan, { board: false });
    writeBoard(plan, report);
    const item = plan.items.find((x) => x.file.toLowerCase() === rel.toLowerCase());
    if (item && isWork(item) && item.id) {
      if (item.status === 'in-progress' && editTakes(ti, input.tool_response)) claimTask(root, hookKey(input), item.id, item.logEntries);
      else if (item.status !== 'in-progress') releaseTask(root, item.id);
    }
    // Только ошибки, связанные с этой правкой: давние ошибки в чужих задачах агента не касаются (format, раздел 9).
    const mine = report.errors.filter((e) => e.file.toLowerCase() === rel.toLowerCase() || (item && mentions(e.msg, item)));
    if (!mine.length) return none;
    const others = report.errors.length - mine.length;
    const lines = mine.slice(0, 10).map((e) => `- ${e.file}: ${e.msg}`);
    return { code: 0, stdout: JSON.stringify({ decision: 'block', reason:
      `В плане задач ошибки после правки ${rel} — исправь:\n${lines.join('\n')}${mine.length > 10 ? `\n…и ещё ${mine.length - 10}` : ''}` +
      `${others ? `\nДругие ошибки плана (${others}) к этой правке не относятся — не исправляй их без просьбы человека.` : ''}\nПроверка: ${script} check` }) };
  }

  if (event === 'stop') {
    if (input.stop_hook_active) return none;
    const key = hookKey(input);
    const own = readOwnership(root, key);
    const ids = Object.keys(own.tasks);
    if (!ids.length) return none;
    const plan = loadPlan(root);
    const stale = [];
    for (const id of ids) {
      const it = plan.byId.get(id);
      if (!it || it.status !== 'in-progress') { delete own.tasks[id]; continue; }
      if (it.logEntries <= own.tasks[id].baseline) stale.push(it);
    }
    writeOwnership(root, key, own);
    if (!stale.length) return none;
    const names = stale.map((it) => it.name).join(', ');
    return { code: 0, stdout: JSON.stringify({ decision: 'block', reason:
      `Задача ${names} в работе (in-progress), но после записи «взята в работу» в «Журнале» ничего нет — ни итога, ни того, на чём остановились. Следующий исполнитель (или ты в новой сессии) не узнает, что сделано. Прежде чем закончить ответ:\n` +
      `- работа закончена → отметь выполненные критерии и закрой: ${script} set <ID> done|review --log "итог…";\n` +
      `- работа продолжается или остановлена → запиши, что сделано и на чём остановился: ${script} set <ID> in-progress --log "…".\n` +
      'Текст с Markdown — через stdin: --log - (bash: <<\'EOF\' … EOF; PowerShell: @\'…\'@ | node …). Если задачу взяли по ошибке — верни: set <ID> ready --log "причина".' }) };
  }
  return none;
}

// ─── move / migrate: перенос и переход на иерархию ──────────────────────────

// Переименования в тексте — одним проходом (цепочки A→B и B→C не сцепляются):
// - ссылки [[старое имя…]] → [[новое имя…]] везде: имя сравнивается целиком (ID в названиях других задач не трогаются);
// - упоминания старых ID и алиасы ссылок — только в «прозе»: не во frontmatter, не в заголовке # и не в «Журнале»
//   (журнал — история: ID в нём остаются на момент записи; прежние ID задачи хранит её поле former_ids).
export function rewriteText(text, { names = new Map(), ids = new Map() } = {}) {
  if (!names.size && !ids.size) return text;
  const idRe = ids.size ? new RegExp(`(?<![\\w-])(?:${[...ids.keys()].map(escapeRe).join('|')})(?![\\w-])`, 'g') : null;
  const mapIds = (s) => (idRe ? s.replace(idRe, (m) => ids.get(m)) : s);
  const relink = (seg, prose) => {
    const m = seg.match(/^\[\[([^\]|#\\]*)([\s\S]*)\]\]$/);
    if (!m) return seg;
    let [, target, rest] = m;
    const renamed = names.get(noteName(target));
    if (renamed) target = renamed;
    const bar = rest.search(/\\?\|/);
    if (prose && bar >= 0) rest = rest.slice(0, bar) + rest.slice(bar).replace(/^(\\?\|)([\s\S]*)$/, (_, b, alias) => b + mapIds(alias));
    return `[[${target}${rest}]]`;
  };
  const lines = text.split('\n');
  const fence = fenceMask(lines);
  const fmEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  let journal = false;
  return lines.map((line, i) => {
    const inFm = i <= fmEnd;
    if (!inFm && !fence[i] && /^## /.test(line)) journal = /^## Журнал\s*$/.test(line);
    const prose = !inFm && !journal && !/^# /.test(line);
    return line.split(/(\[\[[^\]]*\]\])/).map((seg, k) => (k % 2 ? relink(seg, prose) : prose ? mapIds(seg) : seg)).join('');
  }).join('\n');
}

// Применить план изменений: переименования в текстах, поля, записи журнала, новые места файлов.
// Пишутся только изменившиеся файлы; удаляются только папки, опустевшие из-за переноса.
function applyChanges(plan, { renames = [], moves = new Map(), logs = new Map(), fields = new Map(), board = true }) {
  const abs = (rel) => path.join(plan.root, rel);
  const own = new Map(renames.map((r) => [r.file, r]));
  const names = new Map(renames.map((r) => [r.oldName, r.newName]));
  // Упоминание старого ID меняем, только если он однозначен: больше ничей и переименовывается один раз.
  const unique = (r) => renames.filter((x) => x.oldId === r.oldId).length === 1 && !plan.items.some((x) => x.id === r.oldId && !own.has(x.file));
  const ids = new Map(renames.filter((r) => r.oldId !== r.newId && unique(r)).map((r) => [r.oldId, r.newId]));
  const out = [];
  for (const it of plan.all) {
    const doc = readText(abs(it.file));
    let text = rewriteText(doc.text, { names, ids });
    const r = own.get(it.file);
    if (r) text = text.replace(new RegExp(`^# ${escapeRe(r.oldName)}[ \\t]*$`, 'm'), () => `# ${r.newName}`);
    for (const [k, v] of Object.entries(fields.get(it.file) || {})) text = setField(text, k, v);
    if (logs.has(it.file)) text = appendLog(text, logs.get(it.file));
    const target = moves.get(it.file) || it.file;
    if (target !== it.file && fs.existsSync(abs(target))) throw new Error(`уже есть файл ${target}`);
    if (text !== doc.text || target !== it.file) out.push({ from: it.file, target, text, doc });
  }
  const emptied = new Set();
  for (const w of out) {
    fs.mkdirSync(path.dirname(abs(w.target)), { recursive: true });
    writeText(abs(w.target), w.text, w.doc);
    if (w.target !== w.from) { fs.rmSync(abs(w.from)); emptied.add(path.dirname(abs(w.from))); }
  }
  removeEmptyDirs(plan.root, emptied);
  if (board) writeBoard(loadPlan(plan.root));
  return out.length;
}

// Удалить папки, опустевшие из-за переноса (пусто или только .gitkeep), вверх до корня; корень, Backlog/ и Adr/ остаются.
// Пустые папки, которые завёл пользователь, не трогаются.
function removeEmptyDirs(root, dirs) {
  const top = path.resolve(root);
  const keep = new Set([top, ...FLAT_FOLDERS.map((f) => path.join(top, f))]);
  for (let d of dirs) {
    d = path.resolve(d);
    while (!keep.has(d) && d.startsWith(top + path.sep) && fs.existsSync(d)) {
      if (fs.readdirSync(d).some((n) => n !== '.gitkeep')) break;
      fs.rmSync(d, { recursive: true, force: true });
      d = path.dirname(d);
    }
  }
}

const titleOf = (it) => (it.id && it.name.startsWith(`${it.id} `) ? it.name.slice(String(it.id).length + 1) : it.name);
const formerList = (it, id) => `[${[...(it.formerIds || []), id].join(', ')}]`;

// Перевод плана в иерархию: эпики и фичи — в папки, задачи — ID внутри фичи (по порядку старых ID).
// Новые ID не совпадают ни с одним занятым в плане; повторный запуск на иерархическом плане ничего не меняет.
export function migratePlan(root, { dryRun = false, date = today(), who = 'Claude' } = {}) {
  const run = () => {
    const plan = loadPlan(root);
    const moves = new Map(); const renames = []; const logs = new Map(); const fields = new Map(); const skipped = [];
    const place = (it, rel) => { if (rel !== it.file) moves.set(it.file, rel); };
    const target = new Map(); // имя → новый относительный путь
    for (const e of plan.items.filter((x) => x.type === 'epic')) target.set(e.name, `${e.name}/${e.name}.md`);
    for (const f of plan.items.filter((x) => x.type === 'feature')) {
      const e = f.parentName && target.get(f.parentName);
      if (!e) { skipped.push(`${f.name}: нет эпика — оставлен на месте`); target.set(f.name, f.file); continue; }
      target.set(f.name, `${dirOf(e)}/${f.name}/${f.name}.md`);
    }
    const used = usedIds(plan);
    for (const f of plan.items.filter((x) => x.type === 'feature')) {
      const code = featureCode(f.id);
      const own = new RegExp(`^${escapeRe(code)}-(\\d{2})$`);
      const busy = new Set(used.map((x) => x.match(own)).filter(Boolean).map((m) => Number(m[1])));
      let n = Math.max(0, ...busy);
      const kept = new Set();
      const tasks = plan.items.filter((x) => isWork(x) && x.parentName === f.name).sort((a, b) => compareIds(a.id, b.id));
      for (const t of tasks) {
        let id = t.id, name = t.name;
        if (!own.test(String(t.id)) || kept.has(t.id)) {
          if (++n > 99) throw new Error(`в фиче ${f.id} больше 99 задач — разбей фичу до перехода`);
          id = `${code}-${String(n).padStart(2, '0')}`;
          name = `${id} ${titleOf(t)}`;
          renames.push({ oldId: t.id, newId: id, oldName: t.name, newName: name, file: t.file });
          fields.set(t.file, { id, former_ids: formerList(t, t.id) });
          logs.set(t.file, `- **${date} · ${who}:** ID изменён при переходе на иерархию плана: ${t.id} → ${id}.`);
        }
        kept.add(id);
        const dir = dirOf(target.get(f.name));
        target.set(name, dir ? `${dir}/${name}.md` : `${name}.md`);
        place(t, target.get(name));
      }
    }
    for (const it of plan.items) if (['epic', 'feature'].includes(it.type)) place(it, target.get(it.name));
    for (const it of plan.items) if (isWork(it) && !plan.byName.get(it.parentName || '')) skipped.push(`${it.name}: нет фичи — оставлена на месте`);
    const result = { renames: renames.map(({ oldId, newId }) => ({ oldId, newId })), moved: moves.size, skipped };
    if (!dryRun && (moves.size || renames.length)) applyChanges(plan, { renames, moves, logs, fields });
    return result;
  };
  return dryRun ? run() : withLock(root, run);
}

// Папка, которая принадлежит самому элементу: эпик или фича лежат в папке со своим именем. Иначе null.
const ownDir = (it) => { const d = dirOf(it.file); return d && d.split('/').pop() === it.name ? d : null; };

// Перенос: задача → другая фича (новый ID в ней, прежний — в former_ids), фича → другой эпик (папкой, ID не меняются).
export function moveItem(root, ref, toRef, { date = today(), who = 'Claude' } = {}) {
  return withLock(root, () => {
    const plan = loadPlan(root);
    const it = findItem(plan, ref), to = findItem(plan, toRef);
    if (!it) return { error: `«${ref}» не найден` };
    if (!to) return { error: `«${toRef}» не найден` };
    const notOwn = (x) => `${x.id} лежит не в своей папке (${x.file}) — сначала разложи план по папкам: tasks.mjs migrate`;
    if (isWork(it)) {
      if (to.type !== 'feature') return { error: `задачу можно перенести только в фичу, а ${to.id} — ${to.type}` };
      if (it.parentName === to.name) return { error: `${it.id} уже в ${to.id}` };
      const closedTo = !CLOSED.includes(it.status) && closedContainer(plan, to);
      if (closedTo) return { error: closedMsg(closedTo), code: 'parent-closed' };
      const toDir = ownDir(to);
      if (!toDir) return { error: notOwn(to) };
      const newId = nextId(plan, it.type, to.id);
      const newName = `${newId} ${titleOf(it)}`;
      applyChanges(plan, {
        renames: [{ oldId: it.id, newId, oldName: it.name, newName, file: it.file }],
        moves: new Map([[it.file, `${toDir}/${newName}.md`]]),
        fields: new Map([[it.file, { id: newId, parent: `"[[${to.name}]]"`, former_ids: formerList(it, it.id) }]]),
        logs: new Map([[it.file, `- **${date} · ${who}:** перенесена из [[${it.parentName}]] в [[${to.name}]]: ID ${it.id} → ${newId}.`]]),
      });
      return { id: newId, oldId: it.id, name: newName };
    }
    if (it.type === 'feature') {
      if (to.type !== 'epic') return { error: `фичу можно перенести только в эпик, а ${to.id} — ${to.type}` };
      if (it.parentName === to.name) return { error: `${it.id} уже в ${to.id}` };
      if (!CLOSED.includes(it.status) && CLOSED.includes(to.status)) return { error: closedMsg(to), code: 'parent-closed' };
      // Переезжает папка самой фичи — вместе с задачами и вложениями. Если заметка лежит не в своей папке,
      // её папка — чужая (эпик, общая папка плоского плана): переносить её целиком нельзя.
      const fromDir = ownDir(it);
      if (!fromDir) return { error: notOwn(it) };
      const toDir = ownDir(to);
      if (!toDir) return { error: notOwn(to) };
      const newDir = `${toDir}/${it.name}`;
      if (fs.existsSync(path.join(root, newDir))) return { error: `уже есть папка ${newDir}` };
      applyChanges(plan, {
        fields: new Map([[it.file, { parent: `"[[${to.name}]]"` }]]),
        logs: new Map([[it.file, `- **${date} · ${who}:** перенесена из [[${it.parentName}]] в [[${to.name}]].`]]),
        board: false,
      });
      fs.renameSync(path.join(root, fromDir), path.join(root, newDir));
      writeBoard(loadPlan(root));
      return { id: it.id, name: it.name, dir: newDir };
    }
    return { error: `переносить можно задачи и фичи, а ${it.id} — ${it.type}` };
  });
}

// ─── Где план: поиск и init ─────────────────────────────────────────────────

const PROJECT_TPL = path.join(PLUGIN_ROOT, 'templates', 'project');
const BLOCK_RE = /<!-- task:begin[\s\S]*?<!-- task:end -->\n?/;

// Подпапка с именем без учёта регистра (docs, Docs…) — с настоящим написанием на диске.
function childDir(dir, lower) {
  try {
    const e = fs.readdirSync(dir, { withFileTypes: true }).find((x) => x.isDirectory() && x.name.toLowerCase() === lower);
    return e ? path.join(dir, e.name) : null;
  } catch { return null; }
}

// План плагина: есть доска Board.md с пометкой генератора.
export function isPlan(dir) {
  try { return readText(path.join(dir, 'Board.md')).text.includes(BOARD_MARK); } catch { return false; }
}

// План в каталоге: Docs/Tasks — регистр не важен (на Windows план мог лечь в существующую docs/,
// и на Linux он найдётся по тому же написанию); чужая папка без доски плагина планом не считается.
export function planDir(base) {
  if (!fs.existsSync(path.join(base, 'Docs')) && !fs.existsSync(path.join(base, 'docs'))) return null;
  const docs = childDir(base, 'docs');
  const tasks = docs && childDir(docs, 'tasks');
  return tasks && isPlan(tasks) ? tasks : null;
}

// Корень плана — одна функция для команд и хуков: явный путь; иначе ближайший план вверх от cwd; иначе план проекта.
export function findRoot(explicit, { cwd = process.cwd(), projectDir = process.env.CLAUDE_PROJECT_DIR } = {}) {
  if (explicit) return path.resolve(explicit);
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    const p = planDir(d);
    if (p) return p;
    if (path.dirname(d) === d) break;
  }
  return projectDir ? planDir(path.resolve(projectDir)) : null;
}

// Создаёт недостающее и никогда не трогает существующие задачи. Возвращает список действий или { error }.
export function initProject(project, { claudeMd = false, obsidian = false, gitignore = false, force = false } = {}) {
  // План ложится в Docs/Tasks; если в проекте уже есть docs/ (или tasks/ в ней) — в неё, с её написанием.
  const docs = childDir(project, 'docs') || path.join(project, 'Docs');
  const root = childDir(docs, 'tasks') || path.join(docs, 'Tasks');
  const relRoot = path.relative(project, root).split(path.sep).join('/');
  if (fs.existsSync(root) && !isPlan(root) && !force) {
    const found = loadPlan(root).items;
    if (found.length && !found.some((it) => TYPES[it.fm.type])) {
      return { error: `в ${relRoot}/ уже есть заметки, и это не план плагина (${found.slice(0, 3).map((x) => x.file).join(', ')}${found.length > 3 ? ', …' : ''}). init не смешивает план с чужими документами: перенеси их или запусти init --force` };
    }
  }
  const actions = [];
  const did = (what, file) => actions.push({ what, file: path.relative(project, file).split(path.sep).join('/') || '.' });

  for (const dir of ['', ...FLAT_FOLDERS]) {
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
    const block = readText(path.join(PROJECT_TPL, 'claude-md-block.md')).text.replace(/\{\{plan\}\}/g, () => relRoot);
    const cur = fs.existsSync(file) ? readText(file) : null; // переводы строк и BOM файла сохраняются
    if (!cur) { writeText(file, block); did('создан с блоком «Работа с задачами»', file); }
    else if (BLOCK_RE.test(cur.text)) {
      const next = cur.text.replace(BLOCK_RE, () => block);
      if (next !== cur.text) { writeText(file, next, cur); did('обновлён блок «Работа с задачами»', file); } else did('блок уже актуален', file);
    } else { writeText(file, cur.text.replace(/\s*$/, '\n\n') + block, cur); did('добавлен блок «Работа с задачами»', file); }
  }

  if (obsidian) {
    const settings = JSON.parse(readText(path.join(PROJECT_TPL, 'obsidian.json')).text);
    const dir = path.join(root, '.obsidian');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, values] of Object.entries(settings)) {
      const file = path.join(dir, name);
      let cur = {};
      if (fs.existsSync(file)) { try { cur = JSON.parse(readText(file).text); } catch { cur = {}; } }
      fs.writeFileSync(file, JSON.stringify({ ...cur, ...values }, null, 2));
      did('настройки Obsidian', file);
    }
  }

  if (gitignore) {
    const file = path.join(project, '.gitignore');
    const line = `${relRoot}/.obsidian/`;
    const cur = fs.existsSync(file) ? readText(file) : { text: '', eol: '\n', bom: false };
    if (cur.text.split('\n').some((l) => [line, '.obsidian/', '.obsidian'].includes(l.trim()))) did('уже игнорирует .obsidian', file);
    else { writeText(file, (cur.text ? cur.text.replace(/\s*$/, '\n\n') : '') + `# Личные настройки Obsidian\n${line}\n`, cur); did(`добавлено игнорирование ${line}`, file); }
  }

  const plan = loadPlan(root);
  writeBoard(plan);
  did('доска пересобрана', path.join(root, 'Board.md'));
  return { project, root, actions, items: plan.items.length };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

// Флаги без значения: не забирают следующий аргумент (`show --json F01-01`).
const BOOL_FLAGS = new Set(['json', 'stdout', 'force', 'dry-run', 'claude-md', 'obsidian', 'gitignore', 'help', 'take']);

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!BOOL_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) { args[key] = next; i++; } else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

// Значение флага: нет флага — undefined; флаг без значения — понятная ошибка.
function value(args, key, hint) {
  if (args[key] === undefined) return undefined;
  if (args[key] === true) throw new Error(`у --${key} нет значения${hint ? `: ${hint}` : ''}`);
  return String(args[key]);
}

// Текст записи журнала: --log "текст" | --log - (из stdin) | --log-file <файл>. Stdin и файл не проходят через оболочку.
function logText(args) {
  const file = value(args, 'log-file', '--log-file <путь к файлу с текстом>');
  if (file !== undefined) return readText(path.resolve(file)).text;
  const log = value(args, 'log', '--log "текст", --log - (из stdin) или --log-file <файл>');
  if (log === '-') return fs.readFileSync(0, 'utf8');
  return log;
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
  new-id <тип> [--parent F-ID]
                      следующий свободный ID (для task/research/bug — внутри фичи --parent)
  new <тип> --title "Название" [--parent ID] [--depends ID,ID] [--role R]
      [--priority must|should|could] [--size XS|S|M|L] [--status S] [--task ID]
                      создать файл из шаблона (ID, папка, frontmatter); тело заполнить после
  list [--status S[,S2]] [--role R] [--type T[,T2]]
                      элементы плана по фильтру (например, --status in-progress --type task,bug)
  move <ID> --to <ID> перенести задачу в другую фичу (новый ID, прежний — в former_ids) или фичу в другой эпик
  migrate [--dry-run] перевести плоский план в иерархию (эпик/фича — папки, задачи — ID внутри фичи)
  affected <ID>       незакрытые задачи, которые зависят от задачи (по цепочке) или входят в фичу/эпик
  show <ID>           карточка: статус, «Коротко», критерии, незакрытые зависимости, кого блокирует
  set <ID> <статус> [--log "текст" | --log - | --log-file F] [--who "роль (агент)"] [--force] [--take] [--promoted-to ID]
                      сменить статус, дописать запись в «Журнал», пересобрать доску;
                      --log - — текст из stdin (Markdown без искажений оболочкой);
                      in-progress при незакрытых зависимостях — только с --force;
                      --take — продолжить свою задачу в новой сессии (напоминание хука Stop)
  help [команда]      справка по командам плагина (из самих скилов) и что делать сейчас
  init [--project DIR] [--claude-md] [--obsidian] [--gitignore] [--force]
                      создать Docs/Tasks/ в проекте (существующее не трогает);
                      флаги — блок в CLAUDE.md, настройки Obsidian, .obsidian в .gitignore
  hook <session-start|post-tool-use|stop>
                      служебная: обработчик хуков плагина (JSON события — в stdin), вручную не вызывается;
                      выключить в проекте — env TASK_HOOKS=off`;

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || args.help) { console.log(USAGE); return cmd ? 0 : 2; }
  if (cmd === 'hook') {
    // Хуки не должны ломать сессию: любая ошибка — тихий выход.
    try {
      let raw = ''; try { raw = fs.readFileSync(0, 'utf8'); } catch { raw = ''; }
      const res = runHook(args._[1], raw.trim() ? JSON.parse(raw) : {});
      if (res.stdout) process.stdout.write(res.stdout);
      return res.code;
    } catch (e) { process.stderr.write(`task hook: ${e.message}\n`); return 0; }
  }
  try { return run(cmd, args); } catch (e) { console.error(`Ошибка: ${e.message}`); return 2; }
}

function run(cmd, args) {
  if (cmd === 'help') {
    const skills = readSkills();
    const one = args._[1] && String(args._[1]).replace(/^\/?(task:)?/, '');
    if (one) {
      const s = skills.find((x) => x.name === one);
      if (!s) { console.error(`Команды «${one}» нет. Есть: ${skills.map((x) => x.name).join(', ')}.`); return 2; }
      if (args.json) { console.log(JSON.stringify(s, null, 2)); return 0; }
      console.log(`${s.command} ${s.args}`.trim() + `\n${s.description}\nОписание: ${s.file}`);
      return 0;
    }
    const state = planState(findRoot(value(args, 'root', '--root <папка плана>')));
    if (args.json) { console.log(JSON.stringify({ skills, state }, null, 2)); return 0; }
    console.log(renderHelp(skills, state));
    return 0;
  }
  if (cmd === 'init') {
    const project = path.resolve(value(args, 'project', '--project <папка проекта>') || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const res = initProject(project, { claudeMd: !!args['claude-md'], obsidian: !!args.obsidian, gitignore: !!args.gitignore, force: !!args.force });
    if (args.json) { console.log(JSON.stringify(res, null, 2)); return res.error ? 2 : 0; }
    if (res.error) { console.error(`Не сделано: ${res.error}`); return 2; }
    console.log(`План: ${res.root} (элементов плана: ${res.items})`);
    for (const a of res.actions) console.log(`  ${a.what}: ${a.file}`);
    return 0;
  }
  const root = findRoot(value(args, 'root', '--root <папка плана>'));
  if (!root || !fs.existsSync(root)) { console.error('Не найден план: папка Docs/Tasks с доской Board.md плагина (создать — /task:init, или укажи --root).'); return 2; }
  const plan = loadPlan(root);

  if (cmd === 'check') {
    const report = checkPlan(plan);
    if (args.json) console.log(JSON.stringify({ root, ...report }, null, 2));
    else printReport(root, report);
    return report.errors.length ? 1 : 0;
  }
  if (cmd === 'board') {
    const report = checkPlan(plan, { board: false });
    const text = renderBoard(plan, { report });
    if (args.stdout) { console.log(text); return 0; }
    fs.writeFileSync(path.join(root, 'Board.md'), text);
    const cands = nextCandidates(plan);
    if (args.json) { console.log(JSON.stringify({ root, board: 'Board.md', errors: report.errors, warnings: report.warnings, next: cands }, null, 2)); return 0; }
    console.log(`Доска обновлена: ${path.join(root, 'Board.md')}`);
    console.log(`Готово к работе: ${cands.length ? cands.map((c) => c.id).join(', ') : 'нет'}.`);
    if (report.errors.length || report.warnings.length) { console.log(''); printReport(root, report); }
    return 0;
  }
  if (cmd === 'next') {
    const role = value(args, 'role', '--role <роль>');
    const cands = nextCandidates(plan, { role });
    if (args.json) { console.log(JSON.stringify(cands, null, 2)); return 0; }
    if (!cands.length) { console.log(role ? `Нет готовых задач для роли ${role}.` : 'Нет задач, готовых к работе.'); return 0; }
    cands.forEach((c, i) => console.log(`${i + 1}. ${c.name}  [${c.priority}${c.size ? ', ' + c.size : ''}${c.role ? ', ' + c.role : ''}${c.sprint ? ', ' + c.sprint : ''}]\n   ${c.what}${c.unblocks.length ? `\n   Разблокирует: ${c.unblocks.join(', ')}` : ''}`));
    return 0;
  }
  if (cmd === 'show') {
    const card = showItem(plan, args._[1]);
    if (!card) { console.error(`Задача «${args._[1]}» не найдена.`); return 2; }
    if (args.json) { console.log(JSON.stringify(card, null, 2)); return 0; }
    const s = card.summary;
    console.log([`${card.name}  [${card.status}${card.role ? ', ' + card.role : ''}${card.priority ? ', ' + card.priority : ''}${card.size ? ', ' + card.size : ''}]`, card.file,
      ...(card.formerIds.length ? [`Прежние ID: ${card.formerIds.join(', ')}`] : []),
      ...Object.entries(s).map(([k, v]) => `  ${k}: ${v}`),
      `Критерии: ${card.criteria ? `${card.criteria.total - card.criteria.open} из ${card.criteria.total} отмечено` : '—'}`,
      `Ждёт: ${card.openDeps.length ? card.openDeps.map(depLabel).join(', ') : '—'}${card.parentClosed ? `; родитель ${card.parentClosed.id} — ${card.parentClosed.status}` : ''}`,
      `Блокирует: ${card.blocks.length ? card.blocks.map((d) => `${d.id} (${d.status})`).join(', ') : '—'}`].join('\n'));
    return 0;
  }
  if (cmd === 'set') {
    const [, ref, status] = args._;
    if (!ref || !status) { console.error('Использование: set <ID> <статус> [--log "текст" | --log - | --log-file F] [--who "роль (агент)"] [--force] [--take]'); return 2; }
    const res = setStatus(plan, ref, status, {
      log: logText(args), who: value(args, 'who', '--who "роль (агент)"'), force: !!args.force, take: !!args.take,
      promotedTo: value(args, 'promoted-to', '--promoted-to <ID>'),
      session: process.env.TASK_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || undefined,
    });
    const code = res.error ? (['open-deps', 'parent-closed', 'open-children'].includes(res.code) ? 3 : 2) : 0;
    if (args.json) { console.log(JSON.stringify(res, null, 2)); return code; }
    if (res.error) { console.error(`Не сделано: ${res.error}`); return code; }
    const ids = (list) => list.map((u) => `${u.id || u.name} (${u.status})`).join(', ');
    console.log(`${res.item.name}: статус ${res.item.status}${res.logged ? ', запись в журнале добавлена' : ''}; доска обновлена.`);
    if (res.unblocked.length) console.log(`Разблокированы: ${ids(res.unblocked)}.`);
    if (res.waiting.length) console.log(`Ждут отменённую задачу: ${ids(res.waiting)} — поправь их depends_on (/task:replan).`);
    if (res.parentComplete) {
      const pc = res.parentComplete;
      console.log(res.item.type === 'feature' ? `Все фичи эпика ${pc.name} закрыты — его можно закрыть: set ${pc.id} done.` : `Все задачи фичи ${pc.name} закрыты — её можно закрыть: set ${pc.id} done.`);
    }
    return 0;
  }
  if (cmd === 'new') {
    const depends = value(args, 'depends', '--depends ID,ID');
    const res = createItem(plan, args._[1], {
      title: value(args, 'title', '--title "Название"'), parent: value(args, 'parent', '--parent <ID>'), role: value(args, 'role', '--role <роль>'),
      priority: value(args, 'priority'), size: value(args, 'size'), status: value(args, 'status'), task: value(args, 'task', '--task <ID research>'),
      depends: depends ? depends.split(',').map((s) => s.trim()).filter(Boolean) : [],
    });
    if (args.json) { console.log(JSON.stringify(res, null, 2)); return res.error ? 2 : 0; }
    if (res.error) { console.error(`Не создано: ${res.error}`); return 2; }
    console.log(`Создан ${res.name}: ${res.file}\nЗаполни «Коротко», критерии и остальные разделы, убери подсказки <!-- … -->, затем check.`);
    return 0;
  }
  if (cmd === 'move') {
    const to = value(args, 'to', '--to <ID фичи или эпика>');
    if (!args._[1] || !to) { console.error('Использование: move <ID задачи> --to <F-ID> | move <F-ID> --to <E-ID>'); return 2; }
    const res = moveItem(root, args._[1], to, { who: value(args, 'who') });
    if (args.json) { console.log(JSON.stringify(res, null, 2)); return res.error ? 2 : 0; }
    if (res.error) { console.error(`Не перенесено: ${res.error}`); return 2; }
    console.log(res.oldId ? `${res.oldId} → ${res.name}; ссылки обновлены, прежний ID — в former_ids, доска пересобрана.` : `${res.name} → ${res.dir}/; доска пересобрана.`);
    return 0;
  }
  if (cmd === 'migrate') {
    const res = migratePlan(root, { dryRun: !!args['dry-run'] });
    if (args.json) { console.log(JSON.stringify(res, null, 2)); return 0; }
    if (!res.moved && !res.renames.length) { console.log('План уже в иерархии — менять нечего.'); return 0; }
    console.log(`${args['dry-run'] ? 'Будет' : 'Сделано'}: перемещено файлов ${res.moved}, новых ID ${res.renames.length}.`);
    for (const r of res.renames) console.log(`  ${r.oldId} → ${r.newId}`);
    for (const s of res.skipped) console.log(`  пропущено: ${s}`);
    if (!args['dry-run']) console.log('Ссылки и упоминания ID в файлах плана обновлены (журналы — история, их ID не меняются). Проверь файлы вне плана (README, код) на старые ID.');
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
    const list = listItems(plan, { status: value(args, 'status'), role: value(args, 'role'), type: value(args, 'type') });
    if (args.json) { console.log(JSON.stringify(list, null, 2)); return 0; }
    if (!list.length) { console.log('Ничего не найдено.'); return 0; }
    for (const x of list) console.log(`${x.name}  [${x.status}${x.role ? ', ' + x.role : ''}]  ${x.what}`);
    return 0;
  }
  if (cmd === 'new-id') {
    const type = args._[1];
    if (!type) { console.error('Укажи тип: new-id task --parent F-07'); return 2; }
    console.log(nextId(plan, type, value(args, 'parent', '--parent <F-ID>')));
    return 0;
  }
  console.error(`Неизвестная команда «${cmd}».\n\n${USAGE}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
