// FetchXML -> SQL (02 §10): turns a FetchXML query (a view's, or one pasted
// into the FetchXML → SQL box) into SQL that SQL Studio runs with the same rows. Every link type (inner, outer, exists,
// in, any, not any, all, not all, matchfirstrowusingcrossapply), filters with FetchXML's NULL semantics (ne and the
// other negative operators keep NULL rows), FetchXML condition functions (createdon = lastxdays(7)), column
// comparisons (valueof), orders (choices and lookups by their label, as Dataverse sorts), top, distinct, aggregates,
// no-lock and datasource. Synchronous; metadata only through meta's sync members. Every identifier goes through
// util.js sqlName and every value through sqlStr/sqlLit, because view FetchXML is written by other users.
import { parseXml } from '../core/xml.js';
import { sqlName, sqlStr } from '../core/util.js';
import { SqlError } from './lexer.js';
import { FETCH_CONDITIONS } from './functions.js';

const LOOKUPS = new Set(['Lookup', 'Customer', 'Owner']);
const LABELLED = new Set(['Picklist', 'State', 'Status', 'Boolean']);
const NUMERIC = new Set(['Integer', 'BigInt', 'Decimal', 'Double', 'Money', 'Picklist', 'State', 'Status', 'Boolean']);
const FILTER_LINKS = new Set(['any', 'not any', 'all', 'not all']);
const ENTITY_LINKS = new Set(['inner', 'outer', 'exists', 'in', 'matchfirstrowusingcrossapply']);
const ALL_COMMENT = '/* link-type="all": related rows exist and none of them matches the filter (FetchXML semantics) */';
const NOT_ALL_COMMENT = '/* link-type="not all" behaves like "any" in FetchXML */';
const DROPPED_COMMENT = '/* attributes of a filtering link-entity are not returned by Dataverse */';
const LABEL_COMMENT = '/* Dataverse sorts this column by its label */';

const lower = s => String(s ?? '').toLowerCase();
const fail = text => new SqlError(text);
const kids = (el, name) => (el.kids ?? []).filter(k => k && (!name || k.name === name));
const attr = (el, name) => (el.attrs?.get?.(name) ?? null);
const truthy = v => v === 'true' || v === '1';

// The condition operator -> SQL function name of the FetchXML condition functions (functions.js FETCH_CONDITIONS).
const BY_OP = new Map([...FETCH_CONDITIONS.values()].map(f => [f.op, f]));

// Converts FetchXML to SQL text (02 §10). options: {variables, dateOperators, utc, meta (null: no metadata)}.
export function fetchToSql(xml, meta, options = {}) {
  const M = Object.hasOwn(options ?? {}, 'meta') ? options.meta : meta;
  let doc;
  try { doc = parseXml(String(xml ?? '')); } catch (e) { throw fail(e.message); }
  const fetch = doc.name === 'fetch' ? doc : kids(doc, 'fetch')[0];
  if (!fetch) throw fail('Invalid FetchXML: the root element must be <fetch>.');
  const root = kids(fetch, 'entity')[0];
  if (!root) throw fail('Invalid FetchXML: <fetch> needs an <entity>.');
  const ds = lower(attr(fetch, 'datasource') ?? '');
  if (ds && !['retained', 'archive', 'bin'].includes(ds)) throw fail(`datasource '${attr(fetch, 'datasource')}' is not supported.`);
  const schema = ds === 'retained' || ds === 'archive' ? 'archive.' : ds === 'bin' ? 'bin.' : '';
  const aggregate = truthy(attr(fetch, 'aggregate'));
  const raw = truthy(attr(fetch, 'useraworderby'));
  const rootName = attr(root, 'name');
  if (!rootName) throw fail('Invalid FetchXML: <entity> needs a name.');
  const qualify = hasLinks(root);
  const used = new Set([lower(rootName)]);
  const vars = options.variables ? new Map() : null;
  const declares = [];
  const ctx = { M, schema, vars, declares, used, raw, aggregate, comments: new Set() };

  const rootRef = { alias: rootName, table: rootName, qualified: qualify };
  const select = [], from = [`${schema}${sqlName(rootName)}${truthy(attr(fetch, 'no-lock')) ? ' WITH (NOLOCK)' : ''}`], where = [], orderBy = [], groupBy = [];
  // root columns and orders, then the links (joins, filtering links, CROSS APPLY)
  columns(root, rootRef, select, groupBy, ctx);
  for (const o of kids(root, 'order')) orderBy.push(...orderOf(o, rootRef, root, ctx));
  const rootFilter = kids(root, 'filter');
  for (const f of rootFilter) { const t = filterText(f, rootRef, root, ctx, true); if (t) where.push(t); }
  const linkOrders = [];
  for (const l of kids(root, 'link-entity')) link(l, rootRef, { select, from, where, groupBy, orders: linkOrders }, ctx);
  orderBy.push(...linkOrders);

  const top = attr(fetch, 'top');
  let head = 'SELECT ';
  if (truthy(attr(fetch, 'distinct'))) head += 'DISTINCT ';
  if (top != null && /^\d+$/.test(top)) head += `TOP ${Number(top)} `;
  let sql = `${head}${select.length ? select.join(', ') : '*'} FROM ${from.join(' ')}`;
  if (where.length) sql += ` WHERE ${[...ctx.comments].join(' ')}${ctx.comments.size ? ' ' : ''}${where.join(' AND ')}`;
  else if (ctx.comments.size) sql = `${[...ctx.comments].join(' ')} ${sql}`;
  if (groupBy.length) sql += ` GROUP BY ${groupBy.join(', ')}`;
  if (orderBy.length) sql += ` ORDER BY ${orderBy.join(', ')}`;
  return declares.length ? `${declares.join(' ')} ${sql}` : sql;
}

// Whether an entity has any link-entity (columns are then qualified with their table alias).
function hasLinks(el) {
  return (el.kids ?? []).some(k => k?.name === 'link-entity' || (k?.name === 'filter' && hasLinks(k)));
}

// A column reference: alias.col when qualified, else col.
const colOf = (ref, name) => (ref.qualified ? `${sqlName(ref.alias)}.${sqlName(name)}` : sqlName(name));

// The attribute metadata of a column of a table, or null.
function attrInfo(ctx, table, name) {
  const e = ctx.M?.entitySync?.(table);
  return e?.attrs?.get?.(lower(name)) ?? null;
}

// The select items of an entity's attributes (aggregates, group by, aliases, all-attributes).
function columns(el, ref, select, groupBy, ctx) {
  for (const k of el.kids ?? []) {
    if (!k) continue;
    if (k.name === 'all-attributes') { select.push(ref.qualified ? `${sqlName(ref.alias)}.*` : '*'); continue; }
    if (k.name !== 'attribute') continue;
    const name = attr(k, 'name');
    if (!name) throw fail('Invalid FetchXML: <attribute> needs a name.');
    const alias = attr(k, 'alias');
    const col = colOf(ref, name);
    const agg = lower(attr(k, 'aggregate') ?? '');
    let expr = col;
    if (ctx.aggregate && truthy(attr(k, 'groupby'))) {
      const dg = lower(attr(k, 'dategrouping') ?? '');
      expr = dg ? `DATEPART(${dg === 'fiscal-period' || dg === 'fiscal-year' ? dg.replace('-', '') : dg}, ${col})` : col;
      groupBy.push(expr);
    } else if (agg) {
      const distinct = truthy(attr(k, 'distinct')) ? 'DISTINCT ' : '';
      if (agg === 'count') expr = 'COUNT(*)';
      else if (agg === 'countcolumn') expr = `COUNT(${distinct}${col})`;
      else if (['sum', 'avg', 'min', 'max'].includes(agg)) expr = `${agg.toUpperCase()}(${distinct}${col})`;
      else throw fail(`aggregate '${agg}' is not supported.`);
    }
    select.push(alias ? `${expr} AS ${sqlName(alias)}` : expr);
  }
}

// The ORDER BY items of an <order> (02 §10 Orders: choices, booleans and lookups by their name column).
function orderOf(o, ref, el, ctx) {
  const desc = truthy(attr(o, 'descending')) ? ' DESC' : '';
  const alias = attr(o, 'alias');
  if (alias) return [`${sqlName(alias)}${desc}`];
  const name = attr(o, 'attribute');
  if (!name) return [];
  const en = attr(o, 'entityname');
  const r = en ? { alias: en, table: tableOfAlias(el, en, ctx) ?? en, qualified: ref.qualified } : ref;
  const a = attrInfo(ctx, r.table, name);
  let col = name;
  if (a && (LOOKUPS.has(a.type) || (LABELLED.has(a.type) && !ctx.raw))) {
    const named = attrInfo(ctx, r.table, `${name}name`);
    if (named || ctx.M?.entitySync?.(r.table)) col = `${name}name`;
    else ctx.comments.add(LABEL_COMMENT);
  }
  return [`${colOf(r, col)}${desc}`];
}

// The table of a link alias anywhere under an entity, or null.
function tableOfAlias(el, alias, ctx) {
  for (const l of kids(el, 'link-entity')) {
    const a = ctx.aliasOf?.get(l) ?? attr(l, 'alias') ?? attr(l, 'name');
    if (lower(a) === lower(alias)) return attr(l, 'name');
    const deeper = tableOfAlias(l, alias, ctx);
    if (deeper) return deeper;
  }
  return null;
}

// The alias of a link: its own, else its table name, else <table>2, <table>3, … (02 §10 Aliases).
function aliasFor(l, ctx) {
  ctx.aliasOf ??= new Map();
  if (ctx.aliasOf.has(l)) return ctx.aliasOf.get(l);
  let a = attr(l, 'alias');
  if (!a) {
    const name = attr(l, 'name');
    a = name;
    let k = 2;
    while (ctx.used.has(lower(a))) a = `${name}${k++}`;
  }
  ctx.used.add(lower(a));
  ctx.aliasOf.set(l, a);
  return a;
}

// Handles one link-entity of an entity (02 §10 Link types).
function link(l, parent, out, ctx, inFilter = false) {
  const type = lower(attr(l, 'link-type') ?? 'inner');
  if (FILTER_LINKS.has(type) && !inFilter) throw fail(`link-type '${type}' must be inside a <filter>.`);
  if (ENTITY_LINKS.has(type) && inFilter) throw fail(`link-type '${type}' cannot be inside a <filter>.`);
  if (!FILTER_LINKS.has(type) && !ENTITY_LINKS.has(type)) throw fail(`link-type '${type}' is not supported.`);
  const table = attr(l, 'name');
  if (!table) throw fail('Invalid FetchXML: <link-entity> needs a name.');
  const alias = aliasFor(l, ctx);
  const ref = { alias, table, qualified: true };
  const fromCol = attr(l, 'from'), toCol = attr(l, 'to');
  if (!fromCol || !toCol) throw fail('Invalid FetchXML: <link-entity> needs from and to.');
  const on = `${sqlName(alias)}.${sqlName(fromCol)} = ${colOf({ ...parent, qualified: true }, toCol)}`;
  const tableSql = `${ctx.schema}${sqlName(table)} AS ${sqlName(alias)}`;
  const filters = kids(l, 'filter').map(f => filterText(f, ref, l, ctx, true)).filter(Boolean);
  if (type === 'inner' || type === 'outer') {
    out.from.push(`${type === 'inner' ? 'INNER JOIN' : 'LEFT OUTER JOIN'} ${tableSql} ON ${[on, ...filters.map(f => (needsParens(f) ? `(${f})` : f))].join(' AND ')}`);
    columns(l, ref, out.select, out.groupBy, ctx);
    for (const o of kids(l, 'order')) out.orders.push(...orderOf(o, ref, l, ctx));
    for (const k of kids(l, 'link-entity')) link(k, ref, out, ctx);
    return null;
  }
  if (type === 'matchfirstrowusingcrossapply') {
    const inner = { select: [], from: [tableSql], where: [on, ...filters], groupBy: [], orders: [] };
    columns(l, ref, inner.select, inner.groupBy, ctx);
    for (const o of kids(l, 'order')) inner.orders.push(...orderOf(o, ref, l, ctx));
    for (const k of kids(l, 'link-entity')) link(k, ref, inner, ctx);
    const sub = `SELECT TOP 1 ${inner.select.length ? inner.select.join(', ') : '*'} FROM ${inner.from.join(' ')} WHERE ${inner.where.join(' AND ')}${inner.orders.length ? ` ORDER BY ${inner.orders.join(', ')}` : ''}`;
    out.from.push(`CROSS APPLY (${sub}) AS ${sqlName(alias)}`);
    for (const k of l.kids ?? []) if (k?.name === 'attribute') { const n = attr(k, 'name'); const a2 = attr(k, 'alias'); out.select.push(`${sqlName(alias)}.${sqlName(a2 ?? n)}`); }
    return null;
  }
  // filtering links: their attributes and orders are not returned by Dataverse
  if (kids(l, 'attribute').length || kids(l, 'all-attributes').length || kids(l, 'order').length) ctx.comments.add(DROPPED_COMMENT);
  const sub = { select: [], from: [tableSql], where: [], groupBy: [], orders: [] };
  for (const k of kids(l, 'link-entity')) {
    const t = link(k, ref, sub, ctx);
    if (t) sub.where.push(t);
  }
  const fText = filters.join(' AND ');
  const tail = [...sub.where, ...(fText ? [fText] : [])];
  if (type === 'in') {
    const t = `${colOf({ ...parent, qualified: true }, toCol)} IN (SELECT ${sqlName(alias)}.${sqlName(fromCol)} FROM ${sub.from.join(' ')}${tail.length ? ` WHERE ${tail.join(' AND ')}` : ''})`;
    if (inFilter) return t;
    out.where.push(t);
    return null;
  }
  const exists = extra => `EXISTS (SELECT 1 FROM ${sub.from.join(' ')} WHERE ${[on, ...sub.where, ...extra].join(' AND ')})`;
  let t;
  switch (type) {
    case 'exists': t = exists(fText ? [fText] : []); break;
    case 'any': t = exists(fText ? [fText] : []); break;
    case 'not any': t = `NOT ${exists(fText ? [fText] : [])}`; break;
    case 'not all': ctx.comments.add(NOT_ALL_COMMENT); t = exists(fText ? [fText] : []); break;
    case 'all': {
      if (!fText) throw fail('link-type "all" needs a filter; Dataverse rejects it (0x80044150).');
      ctx.comments.add(ALL_COMMENT);
      t = `(${exists([])} AND NOT ${exists([`(${fText})`])})`;
      break;
    }
    default: break;
  }
  if (inFilter) return t;
  out.where.push(t);
  return null;
}

const needsParens = t => / OR /.test(t) && !/^\(.*\)$/.test(t);

// The SQL of a <filter>: its conditions, nested filters and filtering links joined by AND or OR.
function filterText(f, ref, el, ctx, top) {
  const type = lower(attr(f, 'type') ?? 'and');
  const parts = [];
  for (const k of f.kids ?? []) {
    if (!k) continue;
    if (k.name === 'condition') parts.push(conditionText(k, ref, el, ctx));
    else if (k.name === 'filter') {
      const t = filterText(k, ref, el, ctx, false);
      if (t) parts.push(t);
    } else if (k.name === 'link-entity') {
      const t = link(k, ref, { select: [], from: [], where: [], groupBy: [], orders: [] }, ctx, true);
      if (t) parts.push(t);
    }
  }
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  const joined = parts.join(type === 'or' ? ' OR ' : ' AND ');
  return type === 'or' || !top ? `(${joined})` : joined;
}

// The SQL of one <condition> (02 §10 operators, NULL semantics, valueof, condition functions).
function conditionText(c, ref, el, ctx) {
  const name = attr(c, 'attribute');
  if (!name) throw fail('Invalid FetchXML: <condition> needs an attribute.');
  const op = lower(attr(c, 'operator') ?? 'eq');
  const en = attr(c, 'entityname');
  const r = en ? { alias: en, table: tableOfAlias(el, en, ctx) ?? en, qualified: true } : ref;
  const col = colOf(r, name);
  const a = attrInfo(ctx, r.table, name);
  const values = kids(c, 'value').map(v => v.text ?? '');
  const value = attr(c, 'value') ?? (values.length === 1 ? values[0] : null);
  const valueof = attr(c, 'valueof');
  if (valueof) {
    const sym = { eq: '=', ne: '<>', neq: '<>', gt: '>', ge: '>=', lt: '<', le: '<=' }[op];
    if (!sym) throw fail(`valueof is not supported with the operator '${op}'.`);
    const [qa, qc] = valueof.includes('.') ? valueof.split('.') : [null, valueof];
    const other = qa ? `${sqlName(qa)}.${sqlName(qc)}` : colOf(r, qc);
    return sym === '<>' ? `(${col} <> ${other} OR ${col} IS NULL)` : `${col} ${sym} ${other}`;
  }
  const lit = v => literal(v, a, name, ctx);
  const nullable = t => `(${t} OR ${col} IS NULL)`;
  switch (op) {
    case 'eq': return `${col} = ${lit(value)}`;
    case 'ne': case 'neq': return nullable(`${col} <> ${lit(value)}`);
    case 'gt': return `${col} > ${lit(value)}`;
    case 'ge': return `${col} >= ${lit(value)}`;
    case 'lt': return `${col} < ${lit(value)}`;
    case 'le': return `${col} <= ${lit(value)}`;
    case 'like': return `${col} LIKE ${lit(value)}`;
    case 'not-like': return nullable(`${col} NOT LIKE ${lit(value)}`);
    case 'in': return `${col} IN (${(values.length ? values : [value]).map(lit).join(', ')})`;
    case 'not-in': return nullable(`${col} NOT IN (${(values.length ? values : [value]).map(lit).join(', ')})`);
    case 'between': return `${col} BETWEEN ${lit(values[0])} AND ${lit(values[1])}`;
    case 'not-between': return `${col} NOT BETWEEN ${lit(values[0])} AND ${lit(values[1])}`;
    case 'null': return `${col} IS NULL`;
    case 'not-null': return `${col} IS NOT NULL`;
    default: break;
  }
  const fn = BY_OP.get(op);
  if (!fn) throw fail(`The FetchXML operator '${op}' is not supported.`);
  const args = (values.length ? values : value != null ? [value] : []).map(v => fnArg(v, fn));
  const t = `${col} = ${fn.name}(${args.join(', ')})`;
  return fn.negative ? nullable(t) : t;
}

// A condition function argument: numbers bare, GUIDs and dates as quoted text, strings as N'…'.
function fnArg(v, fn) {
  if (fn.arg === 'int' && /^-?\d+$/.test(String(v).trim())) return String(Number(v));
  if (fn.arg === 'guid') return `'${String(v).trim().replace(/[{}]/g, '').toLowerCase().replace(/'/g, "''")}'`;
  if (fn.arg === 'date') return `'${String(v).replace(/'/g, "''")}'`;
  return sqlStr(String(v));
}

// The SQL literal of a condition value for its attribute (variables when the option is on).
function literal(v, a, name, ctx) {
  if (v == null) return 'NULL';
  const s = String(v);
  let text;
  if (a && NUMERIC.has(a.type) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim())) text = String(s.trim());
  else if (a && (LOOKUPS.has(a.type) || a.type === 'Uniqueidentifier') && /^\{?[0-9a-f-]{36}\}?$/i.test(s.trim())) text = `'${s.trim().replace(/[{}]/g, '').toLowerCase()}'`;
  else if (a && a.type === 'DateTime') text = `'${s.replace(/'/g, "''")}'`;
  else text = sqlStr(s);
  if (!ctx.vars) return text;
  let base = lower(name).replace(/[^a-z0-9_]/g, '_');
  if (!/^[a-z_]/.test(base)) base = `_${base}`;
  let vn = `@${base}`, k = 2;
  while (ctx.vars.has(vn)) vn = `@${base}${k++}`;
  ctx.vars.set(vn, text);
  ctx.declares.push(`DECLARE ${vn} ${varType(a)} = ${text};`);
  return vn;
}

// The declared type of a variable for an attribute (02 §10 variables option).
function varType(a) {
  if (!a) return 'NVARCHAR(4000)';
  switch (a.type) {
    case 'String': case 'Memo': return `NVARCHAR(${Number.isInteger(a.maxLength) && a.maxLength > 0 && a.maxLength <= 4000 ? a.maxLength : 'MAX'})`;
    case 'Integer': case 'Picklist': case 'State': case 'Status': return 'INT';
    case 'BigInt': return 'BIGINT';
    case 'Decimal': return `DECIMAL(38, ${Number.isInteger(a.precision) ? a.precision : 10})`;
    case 'Double': return 'FLOAT';
    case 'Money': return 'MONEY';
    case 'Boolean': return 'BIT';
    case 'DateTime': return a.behavior === 'DateOnly' ? 'DATE' : 'DATETIME2';
    case 'Lookup': case 'Customer': case 'Owner': case 'Uniqueidentifier': return 'UNIQUEIDENTIFIER';
    default: return 'NVARCHAR(4000)';
  }
}
