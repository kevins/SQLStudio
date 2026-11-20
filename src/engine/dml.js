// DML pipeline (02 §8): INSERT, UPDATE and DELETE on Dataverse tables, grid change
// sets (03 §7.2), EXEC of Web API messages and Undo. Every change is built as the exact write requests before the
// confirmation dialog opens (ChangePreview, §8.2); dialogs.js mints the grant from it and api.write sends exactly
// those requests (§8.3).
// Safety (00 §5): the target records are selected through the planner in one query; every update and delete carries
// If-Match W/"<the selected versionnumber>", so a record changed since the selection is skipped, never overwritten;
// unchanged values are not sent (minimal updates); a statement without a filter on its target is refused unless
// 'Allow UPDATE/DELETE without WHERE' is on; DELETE offers a backup of the records and counts the records its
// cascades would delete (Restrict blocks it); creates carry a client-generated id so an unknown outcome is verified.
//
// Notes:
// - prepareDml(stmt, c) -> {preview, execute(grant, {stop, onProgress, backup}), plan} | {preview: null, message,
//   warnings, plan}. c = the session's dml context: {api, meta, org, user, caller, settings, tz, dateformat, plan(q,
//   {env, ctx}) -> {node, env}, collect, scalar(expr), insertRows(width), DEFAULT, statementText, text, runId,
//   execution, partial, dynamic, signal, progress(p), warn, info}. execute() resolves {entry, ok, failed, total,
//   firstMessage, firstNumber, identity, output: {columns, rows}, warnings, messages}.
// - prepareExec(stmt, c) -> {kind: 'function', name, run()} | {kind: 'action', name, preview, execute(grant, …)};
//   run()/execute() resolve {resultSets, outputs: [[var, value, type]], rowcount, warnings, entry?, failed?, message?}.
// - prepareUndo(entry, c) -> as prepareDml; previewEdits/writeEdits/editsEntry serve the grid (session.runEdits).
// - Not yet sent as messages: state changes that Dataverse accepts only through a close message (won/lost
//   opportunities, resolved cases, closed quotes and orders) are sent as a plain PATCH, which Dataverse refuses with
//   its own message; the preview says so.
import { dtOfAttr, dataTypeOf, castValue, toServer } from './types.js';
import { msg } from './messages.js';
import { SqlError } from './lexer.js';
import { sqlIdent, sqlStr, sqlLit, suggest } from '../core/util.js';
import { xmlEsc } from '../core/xml.js';

const HIGH_RISK = /^(systemuser|team|teammembership|businessunit|role|systemuserroles|roleprivileges|organization|solution|solutioncomponent|workflow|plugin.*|sdkmessage.*|savedquery|systemform|webresource|sitemap|appmodule|environmentvariable.*|connectionreference|asyncoperation|principalobjectaccess|productsubstitute|serviceendpoint|fieldsecurityprofile|fieldpermission|systemuserprofiles|teamroles|teamprofiles|customapi.*|mailbox|emailserverprofile|queue|audit)$/;
const LOOKUPS = new Set(['Lookup', 'Customer', 'Owner']);
const CLOSE_STATES = new Map([['opportunity', 'WinOpportunity/LoseOpportunity'], ['incident', 'CloseIncident'], ['quote', 'WinQuote/CloseQuote'], ['salesorder', 'FulfillSalesOrder/CancelSalesOrder']]);
const REFUSED_EXEC = new Set(['create', 'update', 'delete', 'upsert', 'createmultiple', 'updatemultiple', 'upsertmultiple', 'deletemultiple', 'executemultiple',
  'executetransaction', 'bulkdelete', 'merge', 'assign', 'setstate', 'associate', 'disassociate', 'importsolution', 'importsolutionasync', 'uninstallsolution',
  'deleteandpromote']);
const AUTOMATION_ACTIONS = new Set(['sendemail', 'sendemailfromtemplate', 'backgroundsendemail', 'sendfax', 'executeworkflow']);
const CHUNK = 250;
const BACKUP_MAX = 5000;
const SAMPLE_MAX = 500;
const BEFORE_AFTER_MIN = 100;

const lower = s => String(s ?? '').toLowerCase();
const isObj = x => !!x && typeof x === 'object';
const int = n => Number(n).toLocaleString('en-US');
const uuid = () => globalThis.crypto.randomUUID();
const isGuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const etagText = v => (v == null || v === '' ? null : `W/"${String(v).replace(/^W\/"?|"$/g, '')}"`);
// The If-Match of a write: the record's version, or * on a table without optimistic concurrency (Dataverse answers a
// version there with 412)
const ifMatchOf = (info, v) => (info?.optimisticConcurrency === false ? '*' : etagText(v) ?? '*');
const lastPart = name => (name && Array.isArray(name.parts) ? name.parts[name.parts.length - 1] : String(name ?? ''));
const err = text => Object.assign(new Error(text), { code: 'edits' });

function E(number, ...args) {
  const m = msg(number, ...args);
  const e = new SqlError(m.message);
  e.number = m.number;
  e.severity = m.severity;
  e.state = 1;
  return e;
}
function plain(text, extra = {}) {
  const e = new SqlError(text);
  e.severity = 16;
  e.state = 1;
  return Object.assign(e, extra);
}

// ---- AST builders (the selection queries) -------------------------------------------------------------------------------
const colRef = (...parts) => ({ type: 'col', parts });
const itemOf = (expr, alias = null) => ({ expr, alias });
function queryOf({ cols, from = null, where = null, top = null, withs = null }) {
  return {
    type: 'query', with: withs, xmlns: null, orderBy: null, offset: null, fetch: null,
    body: { type: 'core', distinct: false, top, cols, into: null, from, where, groupBy: null, having: null },
  };
}
// A deep copy of an AST part (a CTE or derived target's definition gets extra columns; statements can run again).
const cloneAst = x => (Array.isArray(x) ? x.map(cloneAst) : isObj(x) && Object.getPrototypeOf(x) === Object.prototype ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, cloneAst(v)])) : x);

function sourcesOf(ts, out = []) {
  if (!isObj(ts)) return out;
  if (ts.type === 'join') { sourcesOf(ts.left, out); sourcesOf(ts.right, out); } else out.push(ts);
  return out;
}

// ---- values -----------------------------------------------------------------------------------------------------------------
// Exact identity for change detection (02 §8.1 step 5): strings ===, numbers at the attribute's scale, datetimes to the
// second (DateOnly by date), GUIDs and lookups lower-cased, multi-select as a sorted set, NULL equals only NULL.
export function sameValue(a, b, attr = null) {
  if (a == null || b == null) return a == null && b == null;
  const t = attr?.type;
  if (a instanceof Date || b instanceof Date || t === 'DateTime') {
    const da = a instanceof Date ? a : new Date(a), db = b instanceof Date ? b : new Date(b);
    if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return String(a) === String(b);
    if (attr?.behavior === 'DateOnly') return da.toISOString().slice(0, 10) === db.toISOString().slice(0, 10);
    return Math.trunc(da.getTime() / 1000) === Math.trunc(db.getTime() / 1000);
  }
  if (t === 'MultiSelectPicklist') {
    const set = v => String(v).split(',').map(x => x.trim()).filter(Boolean).map(Number).sort((x, y) => x - y).join(',');
    return set(a) === set(b);
  }
  if (t === 'Money' || t === 'Decimal') {
    const s = t === 'Money' ? 4 : Number.isInteger(attr.precision) ? attr.precision : 10;
    const r = v => Math.round(Number(v) * 10 ** s) / 10 ** s;
    return r(a) === r(b);
  }
  if (typeof a === 'number' || typeof b === 'number' || typeof a === 'bigint' || typeof b === 'bigint') return Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const tv = v => v === true || v === 1 || v === '1' || lower(v) === 'true';
    return tv(a) === tv(b);
  }
  if (LOOKUPS.has(t) || t === 'Uniqueidentifier' || isGuid(a) || isGuid(b)) return lower(a) === lower(b);
  return String(a) === String(b);
}

// A value converted to an attribute's type for a write (02 §8.1 step 2): throws 2628 for a too-long string.
function writeValue(value, type, attr, c, table) {
  if (value == null) return null;
  const opts = { tz: c.tz, dateformat: c.dateformat };
  const from = type ?? { dt: 'any' };
  switch (attr.type) {
    case 'Lookup': case 'Customer': case 'Owner': case 'Uniqueidentifier':
      return lower(castValue(value, from, { name: 'uniqueidentifier', args: [] }, opts));
    case 'MultiSelectPicklist': {
      const s = typeof value === 'number' ? String(value) : String(value);
      const parts = s.split(',').map(x => x.trim()).filter(Boolean);
      if (parts.some(p => !/^-?\d+$/.test(p))) throw plain(`Column '${attr.logicalName}' takes choice values as numbers separated by commas, for example '1,3'; '${s}' is not.`);
      return parts.join(',');
    }
    case 'String': case 'Memo': case 'EntityName': {
      const s = String(castValue(value, from, { name: 'nvarchar', args: ['max'] }, opts));
      const max = Number.isInteger(attr.maxLength) && attr.maxLength > 0 ? attr.maxLength : null;
      if (max != null && s.length > max) throw E(2628, table, attr.logicalName, s.slice(0, max));
      return s;
    }
    default: {
      let dt;
      try { dt = dataTypeOf(dtOfAttr(attr)); } catch { dt = { name: 'float', args: [] }; }
      return castValue(value, from, dt, opts);
    }
  }
}

// Checks a choice value against the column's options when they are cached (02 §8.1 step 2).
async function checkChoice(meta, entity, attr, value) {
  if (value == null || !['Picklist', 'State', 'Status', 'MultiSelectPicklist'].includes(attr.type)) return;
  let opts = null;
  try { opts = await meta.options(entity, attr.logicalName); } catch { return; }
  if (!Array.isArray(opts) || !opts.length) return;
  const values = attr.type === 'MultiSelectPicklist' ? String(value).split(',').map(Number) : [Number(value)];
  for (const v of values) {
    if (!opts.some(o => o.value === v)) {
      const list = opts.slice(0, 30).map(o => `${o.value} (${o.label ?? ''})`).join(', ');
      throw plain(`${v} is not a valid value for ${entity}.${attr.logicalName}. Valid values: ${list}${opts.length > 30 ? ', …' : ''}.`);
    }
  }
}

// Adds a lookup to a body as <nav>@odata.bind (02 §8.1 step 8).
function bindLookup(body, attr, id, target, rels, meta, table) {
  const all = (rels?.n1 ?? []).filter(r => r.attr === attr.logicalName);
  const rel = target ? all.find(r => r.target === lower(target)) : all.length === 1 ? all[0] : null;
  if (!rel || !rel.nav) {
    if (!target && all.length > 1) throw plain(`Updating the polymorphic lookup '${attr.logicalName}' needs the target table: set ${attr.logicalName}type too, or use CREATELOOKUP('${all[0].target}', id).`);
    throw plain(`SQL Studio cannot find the relationship of ${table}.${attr.logicalName} to ${target ?? 'its table'}.`);
  }
  if (id == null) { body[`${rel.nav}@odata.bind`] = null; return; }
  const set = meta.findEntity(rel.target)?.entitySetName;
  if (!set) throw plain(`Unknown table ${rel.target}.`);
  body[`${rel.nav}@odata.bind`] = `/${set}(${lower(id)})`;
}

// The lookup whose xtype (or xpid) companion column a name is (01 §6.3): the name minus the suffix is a lookup, and
// no other attribute has the name (the metadata lists xtype as the lookup's own EntityName attribute).
function companionOf(attrs, name, suffix) {
  if (!name.endsWith(suffix)) return null;
  const base = attrs.get(name.slice(0, -suffix.length));
  if (!base || !LOOKUPS.has(base.type)) return null;
  const own = attrs.get(name);
  return !own || own.attributeOf === base.logicalName || own.type === 'EntityName' ? base : null;
}

// The lookup target of a value: its lineage, a statement's xtype column, or the attribute's only target.
function targetOf(attr, ref, xtype) {
  if (xtype) return lower(xtype);
  if (ref?.entity) return lower(ref.entity);
  if (attr.targets && attr.targets.length === 1) return lower(attr.targets[0]);
  return null;
}

// The static lineage of a value from its column (01 §6.2), or null.
function refOf(type, row, env) {
  const r = type?.ref;
  if (!r) return null;
  try {
    if (r.entity) return { entity: lower(r.entity) };
    if (r.poly && type.companion && Number.isInteger(type.companion.type) && row) { const t = row[type.companion.type]; return t ? { entity: lower(t) } : null; }
    if (typeof r.entityFn === 'function') { const t = r.entityFn(row ?? [], env); return t ? { entity: lower(t), pid: r.pidFn?.(row ?? [], env) ?? null } : null; }
  } catch { /* no lineage */ }
  return null;
}

// SQL literal of a value for a generated statement text.
function sqlValue(attr, value, target) {
  if (value == null) return 'NULL';
  if (LOOKUPS.has(attr.type)) return target ? `CREATELOOKUP(${sqlStr(target)}, ${sqlStr(lower(value))})` : sqlStr(lower(value));
  try { return sqlLit(value, dtOfAttr(attr)); } catch { return sqlStr(String(value)); }
}

// ---- shared preview parts -----------------------------------------------------------------------------------------------------
const environmentOf = org => ({ type: org?.type ?? null, name: org?.name ?? null, url: org?.url ?? null, isProduction: !!org?.isProduction });

function optionsOf(hints, settings, api) {
  const use = hints?.use instanceof Set ? hints.use : new Set(hints?.use ?? []);
  const maxdop = Number.isInteger(hints?.maxdop) ? hints.maxdop : settings.maxdop > 0 ? settings.maxdop : (api.dop ?? 4);
  return {
    bypassPlugins: use.has('BYPASS_CUSTOM_PLUGIN_EXECUTION'), bypassLogic: use.has('BYPASS_BUSINESS_LOGIC_EXECUTION'), suppressFlows: use.has('SUPPRESS_FLOWS'),
    suppressDuplicateDetection: use.has('SUPPRESS_DUPLICATE_DETECTION'), ignoreDupKey: use.has('IGNORE_DUP_KEY'),
    batchSize: Math.min(1000, Math.max(1, Number.isInteger(hints?.batchSize) ? hints.batchSize : (settings.batchSize ?? 50))),
    maxdop: Math.min(32, Math.max(1, maxdop)), continueOnError: use.has('CONTINUE_ON_ERROR'), createMultiple: null,
    noMinimal: use.has('NO_MINIMAL_UPDATES'), noStates: use.has('DISABLE_STATE_TRANSITIONS'), bulkDelete: use.has('USE_BULK_DELETE'),
  };
}
const grantOptionsOf = o => ({
  bypassPlugins: o.bypassPlugins, bypassLogic: o.bypassLogic, suppressFlows: o.suppressFlows, suppressDuplicateDetection: o.suppressDuplicateDetection,
  ignoreDupKey: o.ignoreDupKey, createMultiple: o.createMultiple,
});
const bypassOf = o => o.bypassPlugins || o.bypassLogic;
const stamp = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
};

// The ChangePreview fields every statement preview shares (02 §8.2).
function basePreview(c, { op, info, count, ops, options, warnings, requireTyped, dangerKinds, columns = [], sample = [], statementKey }) {
  const caller = c.caller ?? null;
  const offered = (c.execution ?? 1) >= 2 && !caller && !options.bulkDelete;
  return {
    op, entity: info, count, skipped: 0, removed: 0, columns, sample: sample.slice(0, SAMPLE_MAX), ids: ops.filter(o => o.id && o.op !== 'create').map(o => o.id), creates: 0,
    ops, grantSpec: { ops, options: grantOptionsOf(options), callerId: caller?.id ?? null }, warnings, requireTyped,
    options: { bypassPlugins: options.bypassPlugins, bypassLogic: options.bypassLogic, suppressFlows: options.suppressFlows, suppressDuplicateDetection: options.suppressDuplicateDetection, ignoreDupKey: options.ignoreDupKey, batchSize: options.batchSize, maxdop: options.maxdop, continueOnError: options.continueOnError, createMultiple: options.createMultiple },
    statementText: c.statementText ?? '', environment: environmentOf(c.org), impersonating: caller?.name ?? null, backup: null, beforeAfter: null, recycleBin: null,
    cascade: [], automation: null, partial: c.partial ?? null, execution: c.execution ?? null, runId: c.runId ?? null, statementKey: statementKey ?? null,
    dangerKinds, dynamic: !!c.dynamic, standing: { offered, suggestedCap: Math.min(10 * Math.max(1, count), c.settings?.maxChangeRows ?? 5000) }, bulkDelete: null,
  };
}

// requireTyped and the danger notes shared by every statement (02 §8.2).
function guardsOf(c, info, count, options, warnings, dangerKinds) {
  const isProduction = !!c.org?.isProduction;
  const highRisk = HIGH_RISK.test(info.logicalName);
  if (highRisk) warnings.push({ level: 'danger', text: `${info.logicalName} is a system table: changes here can affect security, customisations or the whole environment.` });
  if (bypassOf(options)) {
    warnings.push({ level: 'danger', text: 'Custom plug-ins and business logic are bypassed: this needs the prvBypassCustomPlugins privilege, and the records can end up in states the logic would prevent.' });
    dangerKinds.push('bypass');
  }
  if (c.caller) warnings.push({ level: 'warning', text: `Runs as ${c.caller.name ?? c.caller.id}.` });
  if (c.partial) {
    warnings.push({ level: 'danger', text: `Only part of this statement is selected. Not selected: "${String(c.partial.omittedText).slice(0, 200)}". The rest is ignored.` });
    dangerKinds.push('partial');
  }
  const typed = count > BEFORE_AFTER_MIN || isProduction || highRisk || bypassOf(options) || !!c.caller || !!c.partial;
  return typed ? String(count) : null;
}

// One aggregate count of a table: its record count, or null when it cannot be counted.
async function tableCount(c, info) {
  const xml = `<fetch aggregate="true"><entity name="${xmlEsc(info.logicalName)}"><attribute name="${xmlEsc(info.primaryIdAttribute)}" alias="n" aggregate="count"/></entity></fetch>`;
  try {
    const j = await c.api.fetchXml(info.entitySetName, xml, { signal: c.signal, inBody: c.settings.queryInBody === true });
    const v = j?.value?.[0]?.n;
    return Number.isFinite(Number(v)) ? Number(v) : null;
  } catch (e) {
    if (String(e?.code ?? '').toLowerCase() === '0x8004e023' || /AggregateQueryRecordLimit/i.test(e?.message ?? '')) return Infinity;
    return null;
  }
}

// ---- isUnfiltered (02 §8.1 step 6) ---------------------------------------------------------------------------------------------
// Whether a WHERE (and the target's ON condition) leaves the target unfiltered: no WHERE, only tautological conjuncts, or
// no non-tautological conjunct that references a column of the target alias. Rule (d), the 95 % count, is checked by
// the caller after the selection.
export function isUnfiltered(where, alias, extra = null) {
  const conj = [];
  const split = x => {
    if (!isObj(x)) return;
    if (x.type === 'paren') return split(x.e);
    if (x.type === 'bin' && String(x.op).toUpperCase() === 'AND') { split(x.l); split(x.r); return; }
    conj.push(x);
  };
  split(where);
  if (extra) split(extra);
  const real = conj.filter(x => !tautology(x));
  if (!real.length) return true;
  const a = lower(alias);
  const refsTarget = x => {
    let hit = false;
    const walk = n => {
      if (hit || !isObj(n)) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.type === 'col') {
        const p = n.parts.map(lower);
        if (p.length === 1 || p[p.length - 2] === a) hit = true;
        return;
      }
      for (const [k, v] of Object.entries(n)) if (k !== 'pos' && k !== 'end' && isObj(v)) walk(v);
    };
    walk(x);
    return hit;
  };
  return !real.some(refsTarget);
}
function tautology(x) {
  if (!isObj(x)) return false;
  if (x.type === 'paren') return tautology(x.e);
  if (x.type === 'lit') return x.v === 1 || x.v === true;
  if (x.type === 'bin') {
    const op = String(x.op).toUpperCase();
    if (op === 'OR') return tautology(x.l) || tautology(x.r) || isNullPair(x.l, x.r);
    if (['=', '>=', '<='].includes(op) && sameExpr(x.l, x.r)) return true;
    if (op === '=' && x.l?.type === 'lit' && x.r?.type === 'lit' && x.l.v != null && String(x.l.v) === String(x.r.v)) return true;
  }
  if (x.type === 'distinctfrom' && x.not && sameExpr(x.l, x.r)) return true;
  if (x.type === 'like' && !x.not && x.pattern?.type === 'lit' && x.pattern.v === '%') return true;
  return false;
}
function isNullPair(a, b) {
  return a?.type === 'isnull' && b?.type === 'isnull' && a.not !== b.not && sameExpr(a.e, b.e);
}
const strip = x => JSON.stringify(x, (k, v) => (k === 'pos' || k === 'end' ? undefined : typeof v === 'string' ? v.toLowerCase() : v));
const sameExpr = (a, b) => isObj(a) && isObj(b) && strip(a) === strip(b);

// ---- target resolution (02 §8.1 step 1) --------------------------------------------------------------------------------------
// {from, alias, source, base: {name, map(col) -> attr name | null, cte|derived}} for a Dataverse UPDATE or DELETE target.
export function dmlTarget(stmt) { return resolveTarget(stmt); }
function resolveTarget(stmt) {
  const tn = lastPart(stmt.target);
  const low = lower(tn);
  const ctes = new Map((stmt.with ?? []).map(d => [lower(d.name), d]));
  let source, alias, from;
  if (!stmt.from) {
    source = { type: 'table', name: stmt.target, alias: null, hints: null };
    from = source;
    alias = low;
  } else {
    from = stmt.from;
    const srcs = sourcesOf(stmt.from);
    const byAlias = srcs.filter(s => s.alias && lower(s.alias) === low);
    if (byAlias.length > 1) throw E(8154, tn);
    if (byAlias.length === 1) { source = byAlias[0]; alias = low; } else {
      const byName = srcs.filter(s => s.type === 'table' && lower(lastPart(s.name)) === low);
      if (byName.length > 1) throw E(8154, tn);
      if (!byName.length) throw plain(`The target '${tn}' of the ${stmt.type.toUpperCase()} is not in the FROM clause. Add it to FROM and join it.`);
      source = byName[0];
      alias = lower(byName[0].alias ?? lastPart(byName[0].name));
    }
  }
  // a CTE or derived table target: its one base table
  let body = null, kind = null, defName = null, colNames = null;
  if (source.type === 'derived') { body = source.query; kind = 'derived'; defName = source.alias; colNames = Array.isArray(source.columns) ? source.columns : null; }
  else if (source.type === 'table' && source.name.parts.length === 1 && ctes.has(lower(lastPart(source.name)))) {
    const def = ctes.get(lower(lastPart(source.name)));
    body = def.query;
    kind = 'cte';
    defName = def.name;
    colNames = Array.isArray(def.columns) ? def.columns : null;
  } else if (source.type !== 'table') throw plain(`The target '${tn}' is not a table: only tables, #temp tables, table variables and CTEs or derived tables over one table can be changed.`);
  if (!body) {
    const parts = source.name.parts.map(lower);
    // the written target is exactly the table the selection reads: another database or an unknown schema is 208
    if (parts.length > 2 || (parts.length === 2 && !['dbo', 'archive', 'metadata', 'bin', 'sys'].includes(parts[0]))) throw E(208, source.name.parts.join('.'));
    if (parts.length > 1 && ['archive', 'metadata', 'sys'].includes(parts[parts.length - 2])) throw plain(`${parts.join('.')} is read-only.`);
    return { from, alias, source, table: lastPart(source.name), map: col => col, schemaPart: parts.length > 1 ? parts[parts.length - 2] : null };
  }
  if (body.body?.type !== 'core') throw E(4417, defName);
  const core = body.body;
  const aggregate = x => isObj(x) && JSON.stringify(x, (k, v) => (k === 'pos' || k === 'end' ? undefined : v)).match(/"type":"fn","name":"(COUNT|SUM|AVG|MIN|MAX|STRING_AGG|COUNT_BIG|STDEV|VAR)"/) && !JSON.stringify(x).includes('"over"');
  if (core.distinct || core.groupBy || core.having || core.cols.some(c => aggregate(c.expr))) throw E(4418, defName);
  const tables = sourcesOf(core.from).filter(s => s.type === 'table');
  if (tables.length !== 1 || sourcesOf(core.from).length !== 1) {
    if (stmt.type === 'delete' || tables.length !== 1) throw E(4405, defName);
  }
  const base = tables[0];
  const cols = new Map();
  let star = false;
  core.cols.forEach((c, i) => {
    if (!c.star && !c.alias && c.expr?.type !== 'col' && colNames?.[i] == null) throw E(8155, i + 1, defName);
  });
  core.cols.forEach((c, i) => {
    if (c.star) { star = true; return; }
    const name = lower(colNames?.[i] ?? c.alias ?? (c.expr?.type === 'col' ? lastPart({ parts: c.expr.parts }) : ''));
    cols.set(name, c.expr?.type === 'col' ? lower(c.expr.parts[c.expr.parts.length - 1]) : null);
  });
  const map = col => {
    const k = lower(col);
    if (cols.has(k)) {
      const v = cols.get(k);
      if (v == null) throw E(4406, defName);
      return v;
    }
    if (star) return k;
    throw E(207, col);
  };
  return {
    from, alias, source, table: lastPart(base.name), map, schemaPart: null, viaDef: defName,
    def: { kind, query: body, colNames, baseAlias: lower(base.alias ?? lastPart(base.name)) },
  };
}

// ---- UPDATE and DELETE (02 §8.1) ------------------------------------------------------------------------------------------------
export async function prepareDml(stmt, c) {
  if (stmt.type === 'insert') return prepareInsert(stmt, c);
  return prepareChange(stmt, c);
}

async function entityOf(c, name) {
  const info = await c.meta.entity(name);
  if (!info?.entitySetName || !info.primaryIdAttribute) throw plain(`${name} cannot be changed through the Web API.`);
  return info;
}

async function prepareChange(stmt, c) {
  const kind = stmt.type;
  const t = resolveTarget(stmt);
  const info = await entityOf(c, t.table);
  const table = info.logicalName;
  if (t.schemaPart === 'bin') throw plain(`bin.${table} is read-only: emptying the recycle bin is not supported by SQL Studio. Use the recycle bin in the Power Platform admin center.`);
  const options = optionsOf(stmt.hints, c.settings, c.api);
  const rels = await c.meta.relationships(table).catch(() => null);
  const attrs = info.attrs;
  const pk = info.primaryIdAttribute, pn = info.primaryNameAttribute;
  // a version check only where the table supports one (IsOptimisticConcurrencyEnabled), else If-Match: *
  const hasVer = !!attrs?.get?.('versionnumber') && info.optimisticConcurrency !== false;
  const isActivity = table === 'activitypointer';
  const isElastic = info.kind === 'elastic';

  // SET columns (step 2)
  const sets = [], varSets = [];
  if (kind === 'update') {
    for (const s of stmt.sets) {
      if (s.variable) { varSets.push(s); continue; }
      const written = lastPart(s.col);
      const name = lower(t.map(written));
      let attr = attrs.get(name);
      let isType = false;
      const typeOf = companionOf(attrs, name, 'type');
      if (typeOf) { attr = typeOf; isType = true; }
      if (!attr) {
        const e = E(207, written);
        e.suggestions = suggest(written, [...attrs.keys()]);
        throw e;
      }
      if (!isType) {
        if (attr.isPk) throw plain(`Column '${written}' cannot be updated: it is the primary key.`);
        if (attr.attributeOf && !LOOKUPS.has(attrs.get(attr.attributeOf)?.type)) throw plain(`Column '${written}' cannot be updated.`);
        if (!attr.validForUpdate && attr.logicalName !== 'importsequencenumber') throw plain(`Column '${written}' cannot be updated.`);
        if (attr.type === 'PartyList') throw plain(`Column '${written}' cannot be updated; insert the activity with its parties instead.`);
      }
      sets.push({ s, written, attr, isType });
    }
    if (!sets.length && !varSets.length) throw plain('UPDATE has nothing to set.');
  }
  const dataSets = sets.filter(x => !x.isType);
  const typeOf = new Map(sets.filter(x => x.isType).map(x => [x.attr.logicalName, x]));

  // the selection (step 3)
  const a = t.alias;
  // through a CTE or derived table, the definition also returns the base columns the selection needs
  let from = t.from, withs = stmt.with ?? null, baseRef = name => colRef(a, name);
  if (t.def) {
    from = cloneAst(t.from);
    withs = cloneAst(stmt.with ?? null);
    const def = t.def.kind === 'cte'
      ? withs.find(d => lower(d.name) === lower(t.viaDef))
      : sourcesOf(from).find(s => s.type === 'derived' && lower(s.alias ?? '') === lower(t.alias));
    const added = new Set();
    baseRef = name => {
      const key = `__via_${lower(name)}`;
      if (!added.has(key)) {
        added.add(key);
        def.query.body.cols.push(itemOf(colRef(t.def.baseAlias, name), key));
        if (Array.isArray(def.columns)) def.columns.push(key);
      }
      return colRef(a, key);
    };
  }
  const cols = [itemOf(baseRef(pk), '__pk')];
  if (hasVer) cols.push(itemOf(baseRef('versionnumber'), '__ver'));
  if (pn && attrs.get(pn)) cols.push(itemOf(baseRef(pn), '__name'));
  if (isActivity) cols.push(itemOf(baseRef('activitytypecode'), '__atc'));
  if (isElastic && attrs.get('partitionid')) cols.push(itemOf(baseRef('partitionid'), '__pid'));
  const at = new Map();
  for (const x of sets) {
    const colName = x.isType ? `${x.attr.logicalName}type` : x.attr.logicalName;
    const written = x.written;
    at.set(x, cols.length);
    cols.push(itemOf(colRef(a, written), `__old_${cols.length}`));
    const expr = x.s.op && x.s.op !== '=' ? { type: 'bin', op: x.s.op.slice(0, -1), l: colRef(a, written), r: x.s.expr } : x.s.expr;
    cols.push(itemOf(expr, `__new_${cols.length}`));
    if (!x.isType && LOOKUPS.has(x.attr.type) && (x.attr.targets?.length ?? 0) !== 1) cols.push(itemOf(baseRef(`${colName}type`), `__oldt_${cols.length}`));
  }
  const varAt = varSets.map(v => { const i = cols.length; cols.push(itemOf(v.op && v.op !== '=' ? { type: 'bin', op: v.op.slice(0, -1), l: { type: 'var', name: lower(v.variable) }, r: v.expr } : v.expr, `__var_${i}`)); return i; });
  const top = stmt.top ? { expr: stmt.top.expr, percent: !!stmt.top.percent, ties: false } : null;
  // the unfiltered guard (step 6 (a)-(c)) needs no request: it refuses before anything is read
  const onOf = ts => {
    let on = null;
    const walk = x => {
      if (!isObj(x) || x.type !== 'join') return;
      const has = y => sourcesOf(y).some(s => s === t.source);
      if (has(x.left) || has(x.right)) { if (x.on && (x.right === t.source || x.left === t.source)) on = x.on; walk(x.left); walk(x.right); }
    };
    walk(ts);
    return on;
  };
  let unfiltered = stmt.truncate === true || isUnfiltered(stmt.where, a, stmt.from ? onOf(stmt.from) : null);
  if (unfiltered && !c.settings.allowUnfiltered) throw plain(`This statement would change every record in ${table}. Turn on "Allow UPDATE/DELETE without WHERE" in Settings to run it.`, { code: 'UNFILTERED' });
  const q = queryOf({ cols, from, where: stmt.where, top, withs });
  const { node, env } = await c.plan(q, { ctx: { dml: { alias: a } } });
  const limit = (c.settings.maxChangeRows ?? 5000) + 1;
  const rows = await c.collect(node, env, Math.max(limit, limit * 2));
  const schema = node.schema;
  const idx = name => schema.findIndex(col => col.name === name);
  const iPk = idx('__pk'), iVer = idx('__ver'), iName = idx('__name'), iAtc = idx('__atc'), iPid = idx('__pid');

  // variable assignments of the UPDATE (last row wins)
  if (varSets.length && rows.length) {
    const last = rows[rows.length - 1];
    varSets.forEach((v, k) => c.assignVar?.(v.variable, last[varAt[k]], schema[varAt[k]], last, env));
  }

  // distinct targets, with the duplicate check
  const byId = new Map();
  for (const r of rows) {
    const id = lower(r[iPk]);
    if (!isGuid(id)) continue;
    const prev = byId.get(id);
    if (prev) {
      if (kind === 'update' && sets.some(x => !sameValue(prev[at.get(x) + 1], r[at.get(x) + 1], x.attr))) throw plain('The UPDATE would change some records more than once with different values.');
      continue;
    }
    byId.set(id, r);
  }
  const maxChange = c.settings.maxChangeRows ?? 5000;
  if (byId.size > maxChange) throw plain(`The statement would change more than ${int(maxChange)} records (setting Max records per statement).`, { code: 'LIMIT' });
  if (!byId.size) return { preview: null, message: '(0 rows affected)', plan: node };

  // the unfiltered guard, rule (d): at least 95 % of the table
  const warnings = [], dangerKinds = [];
  if (!unfiltered && byId.size >= 20) {
    const total = await tableCount(c, info);
    if (total === Infinity) unfiltered = byId.size >= 47500;
    else if (total == null) warnings.push({ level: 'warning', text: `Could not count the records in ${table}; this statement may affect most of them.` });
    else if (total > 0 && byId.size >= 0.95 * total) unfiltered = true;
  }
  if (unfiltered) {
    if (!c.settings.allowUnfiltered) throw plain(`This statement would change every record in ${table}. Turn on "Allow UPDATE/DELETE without WHERE" in Settings to run it.`, { code: 'UNFILTERED' });
    warnings.push({ level: 'danger', text: `This statement affects every record in ${table}.` });
    dangerKinds.push('unfiltered');
  }

  const etagOf = r => (iVer >= 0 && r[iVer] != null ? etagText(r[iVer]) : '*');
  const concrete = r => (iAtc >= 0 && r[iAtc] ? lower(r[iAtc]) : table);
  const setOf = ent => (ent === table ? info.entitySetName : c.meta.findEntity(ent)?.entitySetName ?? null);
  const ops = [], sample = [], before = new Map(), unchanged = [];
  const sqlLines = [];
  if (!hasVer) warnings.push({ level: 'warning', text: `${table} doesn't support optimistic concurrency: changes others make shortly before each batch can be overwritten.` });

  if (kind === 'delete') {
    for (const [id, r] of byId) {
      const ent = concrete(r);
      const set = setOf(ent);
      if (!set) throw plain(`Unknown table ${ent}.`);
      const op = { op: 'delete', entity: ent, entitySet: set, id, ifMatch: etagOf(r) };
      if (iPid >= 0 && r[iPid] != null) { op.partitionId = String(r[iPid]); op.pk = pk; }
      ops.push(op);
      sample.push({ id, name: iName >= 0 ? r[iName] ?? null : null, before: [], after: [] });
      before.set(id, { name: iName >= 0 ? r[iName] : null, values: [] });
    }
    await deleteSideEffects(c, info, rels, [...byId.keys()], warnings, dangerKinds);
  } else {
    // per-record values, the minimal diff (step 5) and the request bodies
    const choiceChecks = [];
    for (const [id, r] of byId) {
      const body = {}, afterVals = [], beforeVals = [], setSql = [];
      let changed = false;
      const ent = concrete(r);
      for (const x of dataSets) {
        const i = at.get(x);
        const old = r[i];
        const tIdx = schema.findIndex(col => col.name === `__oldt_${i + 2}`);
        const oldType = tIdx >= 0 ? r[tIdx] : null;
        const tx = typeOf.get(x.attr.logicalName);
        const xtype = tx ? r[at.get(tx) + 1] : null;
        const nv = writeValue(r[i + 1], schema[i + 1], x.attr, c, table);
        const ref = LOOKUPS.has(x.attr.type) ? refOf(schema[i + 1], r, env) : null;
        const target = LOOKUPS.has(x.attr.type) ? targetOf(x.attr, ref, xtype) : null;
        beforeVals.push(old);
        afterVals.push(nv);
        const same = sameValue(old, nv, x.attr) && (!LOOKUPS.has(x.attr.type) || nv == null || !target || !oldType || lower(oldType) === target);
        if (same && !options.noMinimal) { afterVals[afterVals.length - 1] = undefined; continue; }
        changed = true;
        choiceChecks.push([x.attr, nv]);
        if (LOOKUPS.has(x.attr.type)) {
          bindLookup(body, x.attr, nv, nv == null ? (oldType ?? targetOf(x.attr, null, null)) : target, rels, c.meta, table);
          setSql.push(`${sqlIdent(x.attr.logicalName)} = ${sqlValue(x.attr, nv, target)}`);
        } else {
          body[x.attr.logicalName] = toServer(nv, x.attr, c.tz, { dateformat: c.dateformat });
          setSql.push(`${sqlIdent(x.attr.logicalName)} = ${sqlValue(x.attr, nv)}`);
        }
      }
      // statuscode alone also sets its statecode (02 §8.1 step 2)
      if (Object.hasOwn(body, 'statuscode') && !Object.hasOwn(body, 'statecode') && body.statuscode != null) {
        const so = await c.meta.options(table, 'statuscode').catch(() => null);
        const opt = Array.isArray(so) ? so.find(o => o.value === Number(body.statuscode)) : null;
        if (opt && opt.state != null) body.statecode = opt.state;
      }
      if (!changed) { unchanged.push(id); continue; }
      const set = setOf(ent);
      if (!set) throw plain(`Unknown table ${ent}.`);
      const op = { op: 'update', entity: ent, entitySet: set, id, ifMatch: etagOf(r), body };
      if (iPid >= 0 && r[iPid] != null) { op.partitionId = String(r[iPid]); op.pk = pk; }
      ops.push(op);
      sample.push({ id, name: iName >= 0 ? r[iName] ?? null : null, before: beforeVals, after: afterVals });
      before.set(id, { name: iName >= 0 ? r[iName] : null, values: beforeVals, after: afterVals });
      if (setSql.length) sqlLines.push(setSql);
    }
    for (const [attr, v] of choiceChecks.slice(0, 2000)) await checkChoice(c.meta, table, attr, v);
    if (CLOSE_STATES.has(table) && dataSets.some(x => x.attr.logicalName === 'statecode' || x.attr.logicalName === 'statuscode') && !options.noStates) {
      warnings.push({ level: 'warning', text: `Dataverse closes ${table} records through ${CLOSE_STATES.get(table)}; a plain update of the state may be refused. Use EXEC ${CLOSE_STATES.get(table).split('/')[0]} for those records.` });
    }
    for (const x of dataSets) if (x.attr.isSecured) warnings.push({ level: 'warning', text: `${x.attr.logicalName} is protected by field security: its current value may not be readable, so it is always sent.` });
  }
  if (!ops.length) return { preview: null, message: `(0 rows affected)`, warnings: unchanged.length ? [`${int(unchanged.length)} record${unchanged.length === 1 ? '' : 's'} already had these values.`] : [], plan: node };
  if (unchanged.length) warnings.push({ level: 'info', text: `${int(unchanged.length)} record${unchanged.length === 1 ? '' : 's'} already had these values and ${unchanged.length === 1 ? 'is' : 'are'} not sent.` });

  const count = ops.length;
  let requireTyped = guardsOf(c, info, count, options, warnings, dangerKinds);
  if (unfiltered) requireTyped = table;
  const columns = dataSets.map(x => ({ name: x.attr.logicalName, displayName: x.attr.displayName ?? x.attr.logicalName, type: dtOfAttr(x.attr), attr: x.attr }));
  const statementKey = JSON.stringify([stmt.pos, stmt.end, c.dynamic ? c.text : null, kind, [table], columns.map(x => x.name).sort(), headerNames(options)]);
  const preview = basePreview(c, { op: kind, info, count, ops, options, warnings, requireTyped, dangerKinds, columns, sample, statementKey });
  preview.skipped = unchanged.length;
  try { const rb = await c.meta.recycleBin(); preview.recycleBin = rb instanceof Set ? rb.has(table) : null; } catch { preview.recycleBin = null; }
  if (kind === 'delete') {
    preview.cascade = warnings.cascade ?? [];
    if (count <= BACKUP_MAX && c.settings.backupBeforeDelete === true) preview.backup = await backupOf(c, info, [...byId.keys()]);
    else if (count > BACKUP_MAX) { warnings.push({ level: 'danger', text: 'No backup: more than 5,000 records.' }); dangerKinds.push('nobackup'); }
  }
  if (kind === 'update' && count > BEFORE_AFTER_MIN) preview.beforeAfter = beforeAfterOf(c, info, ops, before, columns);
  return {
    preview, plan: node,
    execute: (grant, o = {}) => executeChange(c, { kind, info, ops, preview, options, before, columns, backup: !!o.backup }, grant, o),
  };
}

const headerNames = o => ['bypassPlugins', 'bypassLogic', 'suppressFlows', 'suppressDuplicateDetection'].filter(k => o[k]).sort();

// Cascades of a DELETE (02 §8.1 step 6b): Restrict with referencing records blocks it; Cascade and RemoveLink warn.
async function deleteSideEffects(c, info, rels, ids, warnings, dangerKinds) {
  const list = (rels?.oneN ?? []).filter(r => r.source && r.attr && ['Cascade', 'RemoveLink', 'Restrict'].includes(r.cascade?.delete));
  const cascade = [];
  const jobs = list.map(r => async () => {
    const src = c.meta.findEntity(r.source);
    if (!src?.entitySetName || !src.primaryIdAttribute) return;
    let n = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      const xml = `<fetch aggregate="true"><entity name="${xmlEsc(r.source)}"><attribute name="${xmlEsc(src.primaryIdAttribute)}" alias="n" aggregate="count"/>` +
        `<filter><condition attribute="${xmlEsc(r.attr)}" operator="in">${part.map(id => `<value>${xmlEsc(id)}</value>`).join('')}</condition></filter></entity></fetch>`;
      try {
        const j = await c.api.fetchXml(src.entitySetName, xml, { signal: c.signal, inBody: true });
        n += Number(j?.value?.[0]?.n ?? 0) || 0;
      } catch { return; }
    }
    if (!n) return;
    cascade.push({ relationship: r.schemaName, table: r.source, action: r.cascade.delete, count: n });
  });
  const dop = Math.max(1, Math.min(8, c.api.dop ?? 4));
  for (let i = 0; i < jobs.length; i += dop) await Promise.all(jobs.slice(i, i + dop).map(f => f()));
  cascade.sort((x, y) => x.relationship.localeCompare(y.relationship));
  const restrict = cascade.find(x => x.action === 'Restrict');
  if (restrict) throw plain(`${int(restrict.count)} ${restrict.table} records reference these records via ${restrict.relationship}, which does not allow deleting them.`);
  for (const x of cascade) {
    if (x.action === 'Cascade') { warnings.push({ level: 'danger', text: `Also deletes ${int(x.count)} ${x.table} records (and their own cascaded records) via ${x.relationship}.` }); dangerKinds.push(`cascade:${x.relationship}`); }
    else warnings.push({ level: 'warning', text: `Clears ${x.table}.${list.find(r => r.schemaName === x.relationship)?.attr ?? ''} on ${int(x.count)} ${x.table} records.` });
  }
  warnings.cascade = cascade;
}

// The DELETE backup (02 §8.1 DELETE): every readable column of the targeted records, read before the dialog opens.
async function backupOf(c, info, ids) {
  const records = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const xml = `<fetch><entity name="${xmlEsc(info.logicalName)}"><all-attributes/><filter><condition attribute="${xmlEsc(info.primaryIdAttribute)}" operator="in">` +
      `${part.map(id => `<value>${xmlEsc(id)}</value>`).join('')}</condition></filter></entity></fetch>`;
    try {
      const j = await c.api.fetchXml(info.entitySetName, xml, { signal: c.signal, inBody: true });
      for (const r of j?.value ?? []) records.push(r);
    } catch { return null; }
  }
  const doc = { environment: c.org?.url ?? null, table: info.logicalName, time: new Date().toISOString(), count: records.length, records };
  const text = JSON.stringify(doc, null, 1);
  const org = String(c.org?.uniqueName ?? c.org?.name ?? 'org').replace(/[^A-Za-z0-9_-]+/g, '-');
  return { fileName: `sqlstudio-backup-${info.logicalName}-${org}-${stamp()}.json`, count: records.length, bytes: new Blob([text]).size, text: () => text };
}

function beforeAfterOf(c, info, ops, before, columns) {
  const org = String(c.org?.uniqueName ?? c.org?.name ?? 'org').replace(/[^A-Za-z0-9_-]+/g, '-');
  return {
    fileName: `sqlstudio-changes-${info.logicalName}-${org}-${stamp()}.json`, count: ops.length,
    text: () => JSON.stringify({
      environment: c.org?.url ?? null, table: info.logicalName, time: new Date().toISOString(),
      records: ops.map(o => ({ id: o.id, name: before.get(o.id)?.name ?? null, before: Object.fromEntries(columns.map((col, i) => [col.name, before.get(o.id)?.values?.[i] ?? null])), after: o.body })),
    }, null, 1),
  };
}

// Sends a confirmed UPDATE or DELETE and builds its ChangeEntry (02 §8.1 steps 8-9).
async function executeChange(c, x, grant, { stop, onProgress } = {}) {
  const { kind, info, ops, options } = x;
  const res = await c.api.write(grant, ops, {
    batchSize: options.batchSize, maxdop: options.maxdop, continueOnError: options.continueOnError, ignoreDupKey: options.ignoreDupKey,
    stop: () => !!stop?.(), onProgress: p => { try { onProgress?.({ op: kind, entity: info.logicalName, ...p }); } catch { /* the UI's */ } },
  });
  const entry = newEntry(c, kind, info.logicalName, x.columns.map(col => col.name));
  entry.backup = !!x.backup;
  let failed = 0, firstMessage = null, firstNumber = null;
  const outRows = [];
  res.forEach((r, i) => {
    const op = ops[i];
    const b = x.before.get(op.id);
    if (r.status === 'ok') {
      entry.ok.push({ id: op.id, before: b?.values ?? [], after: (b?.after ?? []).map((v, k) => (v === undefined ? b.values[k] : v)), etag: r.etag ?? null, entity: op.entity });
      outRows.push({ inserted: kind === 'update' ? [op.id, ...((b?.after ?? []).map((v, k) => (v === undefined ? b.values[k] : v)))] : null, deleted: [op.id, ...(b?.values ?? [])] });
    } else if (r.status === 'failed') {
      failed++;
      entry.failed.push({ id: op.id, code: r.code ?? null, message: r.message ?? '' });
      if (firstMessage == null) { firstMessage = r.message ?? 'failed'; firstNumber = numberOf(r); }
    } else if (r.status === 'skipped') entry.skipped.push({ id: op.id, reason: r.reason ?? null });
    else if (r.status === 'unknown') entry.unknown.push(op.id);
    else entry.notAttempted.push(op.id);
  });
  entry.undoable = kind === 'update' && entry.ok.length > 0 && !x.columns.some(col => col.attr?.isSecured);
  if (kind === 'update' && x.columns.some(col => col.attr?.isSecured)) entry.undoReason = `Undo not available: ${x.columns.find(col => col.attr?.isSecured).name} is protected by field security.`;
  if (kind === 'delete') entry.undoReason = x.preview.recycleBin ? 'Deleted records can be restored from the recycle bin for 30 days.' : 'Deleted records cannot be undone.';
  const warnings = [];
  const skipEtag = entry.skipped.filter(s => s.reason === 'etag').length, skipGone = entry.skipped.filter(s => s.reason === 'missing').length;
  if (skipEtag) warnings.push(`${int(skipEtag)} record${skipEtag === 1 ? ' was' : 's were'} changed by someone else since the preview and skipped.`);
  if (skipGone) warnings.push(`${int(skipGone)} record${skipGone === 1 ? '' : 's'} no longer exist${skipGone === 1 ? 's' : ''} and ${skipGone === 1 ? 'was' : 'were'} skipped.`);
  if (entry.unknown.length) warnings.push(`Outcome unknown: check these records: ${entry.unknown.slice(0, 10).join(', ')}${entry.unknown.length > 10 ? ', …' : ''}.`);
  if (entry.notAttempted.length) warnings.push(`${int(entry.notAttempted.length)} record${entry.notAttempted.length === 1 ? ' was' : 's were'} not attempted.`);
  const outCols = [{ name: info.primaryIdAttribute, dt: 'guid', ref: { entity: info.logicalName } }, ...x.columns.map(col => ({ name: col.name, ...col.type, attr: col.attr }))];
  return {
    entry, ok: entry.ok.length, failed, total: ops.length, firstMessage, firstNumber, identity: null, warnings,
    output: { columns: outCols, rows: outRows },
  };
}

const numberOf = r => {
  const code = lower(r.code ?? '');
  if (code === '0x80040237') return 2627;
  if (code === '0x80040220') return 229;
  return 50000;
};

function newEntry(c, op, entity, columns) {
  return {
    id: uuid(), at: Date.now(), op, entity, statement: c.statementText ?? '', columns, ok: [], failed: [], skipped: [], unknown: [], notAttempted: [],
    undoable: false, backup: false, callerId: c.caller?.id ?? null,
  };
}

// ---- INSERT (02 §8.1 INSERT) ---------------------------------------------------------------------------------------------------
async function prepareInsert(stmt, c) {
  const tn = lastPart(stmt.target);
  const parts = stmt.target.parts.map(lower);
  // another database (a three-part name) or an unknown schema is no table of this org, as in SELECT (208)
  if (parts.length > 2 || (parts.length === 2 && !['dbo', 'archive', 'metadata', 'bin', 'sys'].includes(parts[0]))) throw E(208, stmt.target.parts.join('.'));
  if (parts.length > 1 && ['archive', 'metadata', 'bin', 'sys'].includes(parts[parts.length - 2])) throw plain(`${parts.join('.')} is read-only.`);
  let tableName = tn, map = col => col;
  const cte = (stmt.with ?? []).find(d => lower(d.name) === lower(tn));
  if (cte) {
    const r = resolveTarget({ ...stmt, type: 'insert', from: null, target: stmt.target });
    tableName = r.table;
    map = r.map;
  }
  const info = await entityOf(c, tableName);
  const table = info.logicalName;
  if (!stmt.cols?.length && !stmt.defaultValues) throw plain(`INSERT into ${table} needs a column list, for example INSERT INTO ${table} (${info.primaryNameAttribute ?? 'name'}) VALUES ('…').`);
  const options = optionsOf(stmt.hints, c.settings, c.api);
  const rels = await c.meta.relationships(table).catch(() => null);
  const attrs = info.attrs;
  const pk = info.primaryIdAttribute;
  // the target columns: attributes, and the xtype companions of polymorphic lookups
  const cols = (stmt.cols ?? []).map(col => {
    const name = lower(map(col.name));
    let attr = attrs.get(name), isType = false, isPid = false;
    const typeOf = companionOf(attrs, name, 'type');
    if (typeOf) { attr = typeOf; isType = true; }
    if (!attr && name.endsWith('pid') && attrs.get(name.slice(0, -3))) { attr = attrs.get(name.slice(0, -3)); isPid = true; }
    if (!attr) {
      const e = E(207, col.name);
      e.suggestions = suggest(col.name, [...attrs.keys()]);
      throw e;
    }
    if (!isType && !isPid && !attr.isPk && !attr.validForCreate) throw plain(`Column '${col.name}' cannot be set when a record is created.`);
    return { name: col.name, attr, isType, isPid };
  });
  const { rows } = await c.insertRows(stmt.defaultValues ? null : cols.length);
  if (info.isIntersect) return prepareAssociate(stmt, c, { info, cols, rows, options, rels });
  const ops = [], sample = [], warnings = [], dangerKinds = [], sqlRows = [];
  const dataCols = cols.filter(x => !x.isType && !x.isPid);
  const created = [];
  for (const src of rows) {
    const body = {};
    let id = null;
    const vals = new Map(), typed = new Map();
    cols.forEach((x, k) => {
      if (src[k] === c.DEFAULT) return;
      if (x.isType) { if (src[k] != null) typed.set(x.attr.logicalName, lower(src[k])); return; }
      vals.set(x, k);
    });
    const afterVals = [];
    for (const x of dataCols) {
      const k = vals.get(x);
      if (k == null) { afterVals.push(null); continue; }
      const type = src.types?.[k];
      const v = writeValue(src[k], type, x.attr, c, table);
      afterVals.push(v);
      if (x.attr.isPk) { if (v != null) id = lower(v); continue; }
      if (v == null) continue;
      if (LOOKUPS.has(x.attr.type)) {
        const ref = refOf(src.schema?.[k] ?? type, src.full ?? src, src.env);
        const target = targetOf(x.attr, ref, typed.get(x.attr.logicalName));
        bindLookup(body, x.attr, v, target, rels, c.meta, table);
      } else if (x.attr.type === 'PartyList') {
        throw plain(`Column '${x.name}' needs a record reference: use CREATELOOKUP('<table>', id).`);
      } else {
        body[x.attr.logicalName] = toServer(v, x.attr, c.tz, { dateformat: c.dateformat });
      }
      if (x.attr.isSecured) warnings.push({ level: 'warning', text: `Copies secured column ${x.attr.logicalName}; masked values would be written as text.` });
    }
    for (const x of dataCols) { const k = vals.get(x); if (k != null) await checkChoice(c.meta, table, x.attr, afterVals[dataCols.indexOf(x)]); }
    if (id == null) id = uuid();
    if (!isGuid(id)) throw plain(`The value given for ${pk} is not a GUID.`);
    body[pk] = id;
    const op = { op: 'create', entity: table, entitySet: info.entitySetName, id, body, pk };
    const pidCol = cols.find(x => x.isPid);
    if (pidCol && vals.get(pidCol) != null && src[vals.get(pidCol)] != null) op.partitionId = String(src[vals.get(pidCol)]);
    ops.push(op);
    created.push({ id, values: afterVals });
    sample.push({ id: null, name: null, before: [], after: afterVals });
    sqlRows.push(afterVals);
  }
  if (!ops.length) return { preview: null, message: '(0 rows affected)' };
  // required columns the statement does not set (warning; the server decides)
  const given = new Set(dataCols.map(x => x.attr.logicalName));
  const missing = (info.attrList ?? []).filter(x => x.requiredLevel === 'ApplicationRequired' && x.validForCreate && !x.isPk && !given.has(x.logicalName) && !x.attributeOf &&
    !['ownerid', 'statecode', 'statuscode', 'transactioncurrencyid', 'owningbusinessunit'].includes(x.logicalName));
  if (missing.length) warnings.push({ level: 'warning', text: `Required column${missing.length === 1 ? '' : 's'} ${missing.slice(0, 5).map(x => x.logicalName).join(', ')}${missing.length > 5 ? ', …' : ''} ${missing.length === 1 ? 'is' : 'are'} not set; Dataverse may refuse the records.` });
  // CreateMultiple (02 §8.1 INSERT, D5)
  if (ops.length >= 2) {
    let eligible = info.kind === 'elastic';
    if (!eligible && info.kind === 'standard') {
      try { const s = await c.meta.createMultipleTables(); eligible = s instanceof Set && s.has(table); } catch { eligible = false; }
    }
    if (eligible) {
      const chunk = Number.isInteger(stmt.hints?.batchSize) ? stmt.hints.batchSize : 100;
      options.createMultiple = { chunk, elastic: info.kind === 'elastic' };
      warnings.push({ level: 'info', text: info.kind === 'elastic' ? `Creates are sent as CreateMultiple requests of ${chunk} records; failed records are reported one by one.` : `Creates are sent as CreateMultiple requests of ${chunk} records. If a request fails, its records are re-sent in smaller requests so that only the failing records are left out.` });
    }
  }
  const count = ops.length;
  const requireTyped = guardsOf(c, info, count, options, warnings, dangerKinds) ?? (warnings.some(w => /secured column/.test(w.text)) ? String(count) : null);
  if (warnings.some(w => /secured column/.test(w.text))) dangerKinds.push(...dataCols.filter(x => x.attr.isSecured).map(x => `secured:${x.attr.logicalName}`));
  const columns = dataCols.map(x => ({ name: x.attr.logicalName, displayName: x.attr.displayName ?? x.attr.logicalName, type: dtOfAttr(x.attr), attr: x.attr }));
  const statementKey = JSON.stringify([stmt.pos, stmt.end, c.dynamic ? c.text : null, 'insert', [table], columns.map(x => x.name).sort(), headerNames(options)]);
  const preview = basePreview(c, { op: 'insert', info, count, ops, options, warnings, requireTyped, dangerKinds, columns, sample, statementKey });
  preview.creates = count;
  return {
    preview,
    execute: async (grant, { stop, onProgress } = {}) => {
      const res = await c.api.write(grant, ops, {
        batchSize: options.batchSize, maxdop: options.maxdop, continueOnError: options.continueOnError, ignoreDupKey: options.ignoreDupKey,
        createMultiple: options.createMultiple ?? undefined, stop: () => !!stop?.(),
        onProgress: p => { try { onProgress?.({ op: 'insert', entity: table, ...p }); } catch { /* the UI's */ } },
      });
      const entry = newEntry(c, 'insert', table, columns.map(x => x.name));
      let failed = 0, firstMessage = null, firstNumber = null, identity = null;
      const outRows = [];
      const messages = [];
      res.forEach((r, i) => {
        const op = ops[i];
        if (r.status === 'ok') {
          const id = lower(r.newId ?? op.id);
          if (id !== op.id && !messages.length) messages.push({ kind: 'warn', text: 'Dataverse assigned record ids other than the requested ones; OUTPUT and @@IDENTITY show the assigned ids.' });
          entry.ok.push({ id, before: [], after: created[i].values, etag: r.etag ?? null, entity: table });
          identity = { value: id, ref: { entity: table } };
          outRows.push({ inserted: [id, ...created[i].values], deleted: null });
        } else if (r.status === 'failed') {
          failed++;
          entry.failed.push({ id: op.id, code: r.code ?? null, message: r.message ?? '' });
          if (firstMessage == null) { firstMessage = r.message ?? 'failed'; firstNumber = numberOf(r); }
        } else if (r.status === 'skipped') entry.skipped.push({ id: op.id, reason: r.reason ?? null });
        else if (r.status === 'unknown') entry.unknown.push(op.id);
        else entry.notAttempted.push(op.id);
      });
      if (res.createMultipleFallback) messages.push({ kind: 'info', text: `CreateMultiple failed for ${table} (${res.createMultipleFallback.message ?? ''}); the remaining records were sent one by one.` });
      // records with an unknown outcome are verified with their client ids (step 9)
      if (entry.unknown.length) {
        const found = await verifyCreated(c, info, entry.unknown);
        for (const id of found) {
          entry.unknown.splice(entry.unknown.indexOf(id), 1);
          const k = ops.findIndex(o => o.id === id);
          entry.ok.push({ id, before: [], after: created[k]?.values ?? [], etag: null, entity: table, verified: true });
        }
      }
      entry.undoable = entry.ok.length > 0;
      const warnings2 = [];
      const dup = entry.skipped.filter(s => s.reason === 'duplicate').length;
      if (dup) warnings2.push(`${int(dup)} duplicate record${dup === 1 ? ' was' : 's were'} skipped (IGNORE_DUP_KEY).`);
      if (entry.unknown.length) warnings2.push(`Outcome unknown: check these records: ${entry.unknown.slice(0, 10).join(', ')}.`);
      const outCols = [{ name: info.primaryIdAttribute, dt: 'guid', ref: { entity: table } }, ...columns.map(x => ({ name: x.name, ...x.type, attr: x.attr }))];
      return { entry, ok: entry.ok.length, failed, total: ops.length, firstMessage, firstNumber, identity, warnings: warnings2, messages, output: { columns: outCols, rows: outRows } };
    },
  };
}

async function verifyCreated(c, info, ids) {
  const found = [];
  try {
    const res = await c.api.batchGet(ids.map(id => `${info.entitySetName}(${id})?$select=${info.primaryIdAttribute}`), { signal: c.signal });
    res.forEach((r, i) => { if (r) found.push(ids[i]); });
  } catch { /* stays unknown */ }
  return found;
}

// INSERT into an N:N intersect table: associate requests (02 §8.1 INSERT).
async function prepareAssociate(stmt, c, { info, cols, rows, options }) {
  const table = info.logicalName;
  const rels = [];
  for (const e of c.meta.entities?.() ?? []) {
    if (!e?.logicalName) continue;
    const r = c.meta.relationshipsSync?.(e.logicalName);
    for (const nn of r?.nn ?? []) if (nn.intersect === table && !rels.some(x => x.schemaName === nn.schemaName)) rels.push(nn);
  }
  let nn = rels[0];
  if (!nn) {
    // load the relationships of the tables the intersect columns reference: their lookup targets, or the table whose
    // primary key the column is named after (teammembership.teamid -> team)
    for (const x of cols) {
      const byPk = (c.meta.entities?.() ?? []).filter(e => e?.primaryIdAttribute === x.attr.logicalName && e.logicalName !== table).map(e => e.logicalName);
      for (const t of [...(x.attr.targets ?? []), ...byPk]) {
        const r = await c.meta.relationships(t).catch(() => null);
        nn = (r?.nn ?? []).find(n => n.intersect === table);
        if (nn) break;
      }
      if (nn) break;
    }
  }
  if (!nn) throw plain(`SQL Studio cannot find the many-to-many relationship of ${table}.`);
  const i1 = cols.findIndex(x => x.attr.logicalName === nn.entity1Attr), i2 = cols.findIndex(x => x.attr.logicalName === nn.entity2Attr);
  if (i1 < 0 || i2 < 0) throw plain(`INSERT into ${table} needs both ${nn.entity1Attr} and ${nn.entity2Attr}.`);
  const set1 = c.meta.findEntity(nn.entity1)?.entitySetName, set2 = c.meta.findEntity(nn.entity2)?.entitySetName;
  if (!set1 || !set2 || !nn.entity1Nav) throw plain(`SQL Studio cannot write ${table}: its tables are not available.`);
  const ops = [], sample = [];
  for (const r of rows) {
    const id1 = lower(r[i1]), id2 = lower(r[i2]);
    if (!isGuid(id1) || !isGuid(id2)) throw plain(`INSERT into ${table} needs record ids in ${nn.entity1Attr} and ${nn.entity2Attr}.`);
    ops.push({ op: 'associate', entity: nn.entity1, entitySet: set1, id: id1, nav: nn.entity1Nav, relatedSet: set2, relatedId: id2 });
    sample.push({ id: id1, name: null, before: [], after: [id2] });
  }
  const warnings = [], dangerKinds = [];
  const requireTyped = guardsOf(c, info, ops.length, options, warnings, dangerKinds);
  const preview = basePreview(c, { op: 'associate', info, count: ops.length, ops, options, warnings, requireTyped, dangerKinds, sample });
  return {
    preview,
    execute: async (grant, { stop, onProgress } = {}) => {
      const res = await c.api.write(grant, ops, { batchSize: options.batchSize, maxdop: options.maxdop, continueOnError: options.continueOnError, stop: () => !!stop?.(), onProgress: p => { try { onProgress?.({ op: 'associate', entity: table, ...p }); } catch { /* idem */ } } });
      const entry = newEntry(c, 'associate', table, []);
      let failed = 0, firstMessage = null;
      res.forEach((r, i) => {
        if (r.status === 'ok') entry.ok.push({ id: ops[i].id, before: [], after: [ops[i].relatedId], etag: null });
        else if (r.status === 'failed') { failed++; entry.failed.push({ id: ops[i].id, code: r.code ?? null, message: r.message ?? '' }); firstMessage ??= r.message; }
        else if (r.status === 'skipped') entry.skipped.push({ id: ops[i].id, reason: r.reason ?? null });
        else if (r.status === 'unknown') entry.unknown.push(ops[i].id);
        else entry.notAttempted.push(ops[i].id);
      });
      return { entry, ok: entry.ok.length, failed, total: ops.length, firstMessage, firstNumber: 50000, identity: null, warnings: [] };
    },
  };
}

// ---- EXEC (02 §8.1 EXEC, §9 Web API functions) --------------------------------------------------------------------------------
export async function prepareExec(stmt, c) {
  const written = lastPart(stmt.name);
  if (REFUSED_EXEC.has(lower(written))) throw plain(`Use INSERT/UPDATE/DELETE instead: EXEC ${written} would change records the preview cannot show.`);
  let msgs;
  try { msgs = await c.meta.messages(); } catch (e) { throw plain(`The Web API messages could not be read: ${e.message}`); }
  let m = null;
  for (const [k, v] of msgs) if (lower(k) === lower(written)) { m = v; break; }
  if (!m) {
    const e = E(2812, written);
    e.suggestions = suggest(written, [...msgs.keys()]);
    throw e;
  }
  const name = m.name ?? written;
  const params = m.params ?? [];
  const response = m.response ?? [];
  // arguments: named or positional, request parameters then response properties (OUTPUT)
  const values = new Map(), outputs = [];
  let position = 0;
  for (const p of stmt.params ?? []) {
    let target = null, isResponse = false;
    if (p.name) {
      const n = lower(p.name.replace(/^@/, ''));
      target = params.find(x => lower(x.name) === n) ?? null;
      if (!target) { target = response.find(x => lower(x.name) === n) ?? null; isResponse = !!target; }
      if (!target) throw E(8145, p.name, name);
    } else {
      if (position < params.length) target = params[position];
      else { target = response[position - params.length] ?? null; isResponse = !!target; }
      position++;
      if (!target) throw E(8144, name);
    }
    if (p.output) {
      if (p.expr?.type !== 'var') throw E(179);
      outputs.push({ varName: p.expr.name, prop: isResponse ? target.name : target.name });
      if (isResponse) continue;
    }
    if (isResponse) continue;
    const v = await c.scalar(p.expr);
    values.set(target.name, { param: target, value: v.value, type: v.type, ref: refOf(v.type, v.row, v.env) });
  }
  for (const p of params) if (!p.optional && !values.has(p.name) && lower(p.name) !== 'target') throw plain(`EXEC ${name} needs the parameter @${p.name}.`);
  // a bound message: the record or table it is bound to
  let bound = null, boundEntity = null;
  if (m.boundTo) {
    const tv = [...values.values()].find(v => lower(v.param.name) === 'target') ?? null;
    if (m.binding === 'collection') {
      boundEntity = await c.meta.entity(m.boundTo).catch(() => null);
      bound = { entitySet: boundEntity?.entitySetName ?? null, id: null };
    } else {
      const id = tv?.value != null ? lower(tv.value) : null;
      const ent = tv?.ref?.entity ?? m.boundTo;
      boundEntity = await c.meta.entity(ent).catch(() => null);
      if (!id || !isGuid(id) || !boundEntity) throw plain(`EXEC ${name} is bound to a ${m.boundTo} record: pass @Target = CREATELOOKUP('${m.boundTo}', id).`);
      bound = { entitySet: boundEntity.entitySetName, id };
      if (tv) values.delete(tv.param.name);
    }
  }
  if (m.kind === 'function') {
    return {
      kind: 'function', name,
      run: async () => {
        const args = new Map();
        for (const [k, v] of values) args.set(k, fnLiteral(v, c));
        const json = await c.api.fn(name, args, { signal: c.signal, bound: bound ? { entitySet: bound.entitySet, id: bound.id } : undefined });
        return resultOf(json, m, outputs, c);
      },
    };
  }
  // an action: a confirmed write (02 §8.1 EXEC)
  const body = {};
  for (const [k, v] of values) body[k] = actionValue(v, c);
  const op = { op: 'action', name };
  if (bound) {
    op.bound = bound.id ? true : 'collection';
    op.entity = boundEntity.logicalName;
    op.entitySet = bound.entitySet;
    if (bound.id) op.id = bound.id;
  }
  op.body = body;
  const options = optionsOf(stmt.hints, c.settings, c.api);
  const warnings = [], dangerKinds = [];
  if (AUTOMATION_ACTIONS.has(lower(name)) || m.isCustom) warnings.push({ level: 'danger', text: 'This action may send data outside Dataverse or run automation.' });
  if (c.caller) warnings.push({ level: 'warning', text: `Runs as ${c.caller.name ?? c.caller.id}.` });
  const info = boundEntity ?? { logicalName: name, displayName: name };
  const preview = basePreview(c, { op: 'action', info, count: 1, ops: [op], options: { ...options, bulkDelete: false }, warnings, requireTyped: name, dangerKinds, statementKey: JSON.stringify([stmt.pos, stmt.end, c.dynamic ? c.text : null, 'action', [name], [], []]) });
  preview.actionName = name;
  preview.actionParams = [...values.values()].map(v => ({ name: v.param.name, value: v.value, type: v.param.type }));
  preview.grantSpec = { ops: [op], options: {}, callerId: c.caller?.id ?? null };
  return {
    kind: 'action', name, preview,
    execute: async (grant, { stop, onProgress } = {}) => {
      const res = await c.api.write(grant, [op], { stop: () => !!stop?.(), onProgress: p => { try { onProgress?.({ op: 'action', entity: info.logicalName, action: name, ...p }); } catch { /* idem */ } } });
      const r = res[0];
      const entry = newEntry(c, 'action', bound ? info.logicalName : null, []);
      entry.action = name;
      if (r?.status === 'ok') entry.ok.push({ id: op.id ?? null, before: [], after: [], etag: null });
      else if (r?.status === 'failed') entry.failed.push({ id: op.id ?? null, code: r.code ?? null, message: r.message ?? '' });
      else if (r?.status === 'unknown') entry.unknown.push(op.id ?? name);
      else entry.notAttempted.push(op.id ?? name);
      if (r?.status !== 'ok') return { entry, failed: true, message: r?.message ?? `${name} was not run.`, number: numberOf(r ?? {}), resultSets: [] };
      return { ...resultOf(r.json ?? {}, m, outputs, c), entry, rowcount: 1 };
    },
  };
}

// A function parameter's URL literal (02 §8.1: Guid unquoted, EntityReference as @odata.id, dates ISO).
function fnLiteral(v, c) {
  const t = v.param.type;
  if (v.value == null) return null;
  if (t === 'Guid') return c.literals?.guidParam ? c.literals.guidParam(lower(v.value)) : lower(v.value);
  if (t === 'EntityReference' || (v.ref?.entity && isGuid(String(v.value)))) {
    const ent = v.ref?.entity;
    const set = ent ? c.meta.findEntity(ent)?.entitySetName : null;
    if (!set) throw plain(`@${v.param.name} needs a record: use CREATELOOKUP('<table>', id).`);
    return { '@odata.id': `${set}(${lower(v.value)})` };
  }
  if (t === 'StringArray' || /\[\]$/.test(String(t))) {
    const list = Array.isArray(v.value) ? v.value : String(v.value).split(',').map(s => s.trim()).filter(Boolean);
    return list;
  }
  if (t === 'Boolean') return v.value === true || v.value === 1 || lower(v.value) === 'true';
  if (t === 'Integer' || t === 'Decimal' || t === 'Float' || t === 'BigInt' || t === 'Money') return Number(v.value);
  if (v.value instanceof Date) return v.value.toISOString();
  return v.value;
}

// An action body value (02 §8.1 EXEC: EntityReference -> {@odata.type, <pk>}, dates ISO, bit -> boolean).
function actionValue(v, c) {
  const t = v.param.type;
  if (v.value == null) return null;
  if (t === 'EntityReference' || (v.ref?.entity && isGuid(String(v.value)) && t !== 'Guid')) {
    const ent = v.ref?.entity ?? (c.meta.findEntity(lower(t)) ? lower(t) : null);
    const info = ent ? c.meta.findEntity(ent) : null;
    if (!info) throw plain(`@${v.param.name} needs a record: use CREATELOOKUP('<table>', id).`);
    return { '@odata.type': `Microsoft.Dynamics.CRM.${info.logicalName}`, [info.primaryIdAttribute]: lower(v.value) };
  }
  if (t === 'Boolean') return v.value === true || v.value === 1 || lower(v.value) === 'true';
  if (t === 'Integer' || t === 'Decimal' || t === 'Float' || t === 'BigInt' || t === 'Money' || t === 'Picklist') return Number(v.value);
  if (t === 'Guid') return lower(v.value);
  if (v.value instanceof Date) return v.value.toISOString();
  if (typeof v.value === 'string' && /^\s*[[{]/.test(v.value) && !['String', 'Guid'].includes(t)) { try { return JSON.parse(v.value); } catch { /* text */ } }
  return v.value;
}

// The result sets and OUTPUT values of a message response (02 §9 response shapes (a)-(e), simplified).
function resultOf(json, entry, outputs, c) {
  const outVals = outputs.map(o => {
    const key = Object.keys(json ?? {}).find(k => lower(k) === lower(o.prop));
    let v = key != null ? json[key] : null;
    if (v && typeof v === 'object') v = JSON.stringify(v);
    return [o.varName, v ?? null, typeOfValue(v)];
  });
  const sets = [];
  const props = Array.isArray(entry.response) && entry.response.length ? entry.response.map(p => p.name) : Object.keys(json ?? {}).filter(k => !k.startsWith('@'));
  const scalars = [];
  if (entry.responseEntity && json && typeof json === 'object') {
    sets.push(rowsOfObjects(entry.name ?? 'result', [json]));
  } else {
    for (const p of props) {
      const key = Object.keys(json ?? {}).find(k => lower(k) === lower(p));
      const v = key != null ? json[key] : undefined;
      if (v === undefined) { scalars.push([p, null]); continue; }
      if (Array.isArray(v)) {
        if (v.every(x => x == null || typeof x !== 'object')) sets.push({ title: p, columns: [colOf(p, v.find(x => x != null))], rows: v.map(x => [x]) });
        else sets.push(rowsOfObjects(p, v));
      } else if (v && typeof v === 'object') {
        if (Array.isArray(v.Entities)) sets.push(rowsOfObjects(p, v.Entities));
        else if (Array.isArray(v.value)) sets.push(rowsOfObjects(p, v.value));
        else sets.push(rowsOfObjects(p, [v]));
      } else scalars.push([p, v]);
    }
    if (scalars.length) sets.unshift({ title: entry.name ?? null, columns: scalars.map(([n, v]) => colOf(n, v)), rows: [scalars.map(([, v]) => v)] });
  }
  return { resultSets: sets, outputs: outVals, rowcount: sets.reduce((n, s) => n + s.rows.length, 0) };
}
function typeOfValue(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? { dt: 'int' } : { dt: 'float' };
  if (typeof v === 'boolean') return { dt: 'bit' };
  if (typeof v === 'string' && isGuid(v)) return { dt: 'guid' };
  return { dt: 'string', len: -1, unicode: true };
}
function colOf(name, v) { return { name, qual: null, ...typeOfValue(v) }; }
function rowsOfObjects(title, list) {
  const names = [];
  for (const o of list) for (const k of Object.keys(o ?? {})) if (!k.startsWith('@') && !k.includes('@') && !names.includes(k)) names.push(k);
  const rows = list.map(o => names.map(k => {
    const v = o?.[k];
    return v && typeof v === 'object' ? JSON.stringify(v) : v ?? null;
  }));
  return { title, columns: names.map(n => colOf(n, rows.find(r => r[names.indexOf(n)] != null)?.[names.indexOf(n)])), rows };
}

// ---- Undo (02 §8.1 step 9) -------------------------------------------------------------------------------------------------------
export async function prepareUndo(entry, c) {
  if (!entry || entry.undoable !== true) throw plain(entry?.undoReason ?? 'This change cannot be undone.');
  const table = entry.entity;
  const info = await entityOf(c, table);
  const options = optionsOf(null, c.settings, c.api);
  const warnings = [], dangerKinds = [];
  if (entry.op === 'insert' || (entry.op === 'mixed' && entry.parts?.insert)) {
    const ids = (entry.op === 'insert' ? entry.ok : entry.parts.insert).map(x => x.id);
    const snap = await snapshot(c.api, info, ids, []);
    const ops = [], sample = [];
    for (const id of ids) {
      const cur = snap.get(lower(id));
      if (!cur) continue;
      ops.push({ op: 'delete', entity: table, entitySet: info.entitySetName, id: lower(id), ifMatch: ifMatchOf(info, cur.versionnumber) });
      sample.push({ id: lower(id), name: cur[info.primaryNameAttribute] ?? null, before: [], after: [] });
    }
    if (!ops.length) return { preview: null, message: 'Nothing to undo: the created records no longer exist.' };
    const requireTyped = guardsOf(c, info, ops.length, options, warnings, dangerKinds);
    const preview = basePreview({ ...c, statementText: `-- Undo: delete the ${ops.length} records the INSERT created` }, { op: 'delete', info, count: ops.length, ops, options, warnings, requireTyped, dangerKinds, sample });
    const before = new Map(ops.map(o => [o.id, { name: null, values: [] }]));
    return { preview, execute: (grant, o = {}) => executeChange(c, { kind: 'delete', info, ops, preview, options, before, columns: [], backup: false }, grant, o) };
  }
  if (entry.op !== 'update' && entry.op !== 'mixed') throw plain('This change cannot be undone.');
  const okList = entry.op === 'update' ? entry.ok : entry.parts?.update ?? [];
  const cols = entry.columns.map(n => info.attrs.get(lower(n))).filter(Boolean);
  if (!cols.length) throw plain('This change cannot be undone.');
  const snap = await snapshot(c.api, info, okList.map(x => x.id), cols.map(a => a.logicalName));
  const rels = await c.meta.relationships(table).catch(() => null);
  const ops = [], sample = [], before = new Map();
  let changedSince = 0;
  for (const x of okList) {
    const cur = snap.get(lower(x.id));
    if (!cur) continue;
    const body = {};
    let still = true;
    cols.forEach((a, i) => {
      if (x.after?.[i] === undefined) return;
      const now = LOOKUPS.has(a.type) ? cur[`_${a.logicalName}_value`] ?? null : cur[a.logicalName] ?? null;
      if (!sameValue(now, x.after[i], a)) still = false;
    });
    if (!still) { changedSince++; continue; }
    cols.forEach((a, i) => {
      if (x.after?.[i] === undefined) return;
      const v = x.before[i];
      if (LOOKUPS.has(a.type)) bindLookup(body, a, v, v == null ? null : (a.targets?.length === 1 ? a.targets[0] : null), rels, c.meta, table);
      else body[a.logicalName] = toServer(v, a, c.tz, { dateformat: c.dateformat });
    });
    if (!Object.keys(body).length) continue;
    ops.push({ op: 'update', entity: table, entitySet: info.entitySetName, id: lower(x.id), ifMatch: ifMatchOf(info, cur.versionnumber), body });
    sample.push({ id: lower(x.id), name: cur[info.primaryNameAttribute] ?? null, before: x.after, after: x.before });
    before.set(lower(x.id), { name: cur[info.primaryNameAttribute] ?? null, values: x.after, after: x.before });
  }
  if (changedSince) warnings.push({ level: 'warning', text: `${int(changedSince)} record${changedSince === 1 ? ' has' : 's have'} changed since and ${changedSince === 1 ? 'is' : 'are'} not undone.` });
  if (!ops.length) return { preview: null, message: 'Nothing to undo: the records changed since.' };
  const requireTyped = guardsOf(c, info, ops.length, options, warnings, dangerKinds);
  const columns = cols.map(a => ({ name: a.logicalName, displayName: a.displayName ?? a.logicalName, type: dtOfAttr(a), attr: a }));
  const preview = basePreview({ ...c, statementText: `-- Undo: restore the previous values of ${ops.length} records` }, { op: 'update', info, count: ops.length, ops, options, warnings, requireTyped, dangerKinds, columns, sample });
  return { preview, execute: (grant, o = {}) => executeChange(c, { kind: 'update', info, ops, preview, options, before, columns, backup: false }, grant, o) };
}

// ---- grid change sets (03 §7.2) -----------------------------------------------------------------------------------------------
// The current versionnumber and values of `ids` in one table (chunked FetchXML reads).
async function snapshot(api, info, ids, attrs) {
  const pk = info.primaryIdAttribute, pn = info.primaryNameAttribute;
  const names = [...new Set([pk, 'versionnumber', pn, ...attrs].filter(Boolean))].filter(n => n === pk || info.attrs?.get?.(n));
  const out = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const xml = `<fetch><entity name="${xmlEsc(info.logicalName)}">${names.map(n => `<attribute name="${xmlEsc(n)}"/>`).join('')}` +
      `<filter><condition attribute="${xmlEsc(pk)}" operator="in">${part.map(id => `<value>${xmlEsc(id)}</value>`).join('')}</condition></filter></entity></fetch>`;
    const j = await api.fetchXml(info.entitySetName, xml, { inBody: true });
    for (const r of j.value ?? []) out.set(lower(r[pk]), r);
  }
  return out;
}

// The raw value of attribute a in a Web API record (lookups as their id).
const recValue = (rec, a) => (LOOKUPS.has(a.type) ? rec[`_${a.logicalName}_value`] ?? null : rec[a.logicalName] ?? null);

// Adds attribute `col` = value to a create/update body of a grid edit (lookups as @odata.bind).
function setBody(body, attr, value, target, rels, meta) {
  if (LOOKUPS.has(attr.type)) {
    const ent = lower(target || (attr.targets && attr.targets.length === 1 ? attr.targets[0] : ''));
    const rel = (rels?.n1 ?? []).find(r => r.attr === attr.logicalName && (!ent || r.target === ent)) ?? null;
    if (!rel || !rel.nav) throw err(`${attr.logicalName}: SQL Studio cannot find the relationship to set this lookup.`);
    if (value == null) { body[`${rel.nav}@odata.bind`] = null; return; }
    const set = meta.findEntity(rel.target)?.entitySetName;
    if (!set) throw err(`${attr.logicalName}: unknown table ${rel.target}.`);
    body[`${rel.nav}@odata.bind`] = `/${set}(${lower(value)})`;
    return;
  }
  body[attr.logicalName] = gridValue(attr, value);
}

// The value of one grid cell in Web API form.
function gridValue(attr, value) {
  if (value == null) return null;
  const t = attr.type;
  if (t === 'Boolean') return value === true || value === 1 || value === '1' || lower(value) === 'true';
  if (t === 'Picklist' || t === 'State' || t === 'Status' || t === 'Integer') return Number(value);
  if (t === 'BigInt' || t === 'Decimal' || t === 'Double' || t === 'Money') return Number(value);
  if (t === 'MultiSelectPicklist') return String(value);
  if (t === 'DateTime') {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) throw err(`${attr.logicalName}: '${value}' is not a date.`);
    return attr.behavior === 'DateOnly' ? d.toISOString().slice(0, 10) : d.toISOString();
  }
  return typeof value === 'string' ? value : String(value);
}

// Builds the ChangePreview of a grid change set (02 §8.2, op 'mixed').
export async function previewEdits(payload, { api, meta, org = null, caller = null, settings = {} } = {}) {
  const info = await meta.entity(payload.entity);
  if (!info?.entitySetName || !info.primaryIdAttribute) throw err(`SQL Studio cannot write to ${payload.entity}.`);
  const attrsOf = name => {
    const a = info.attrs?.get?.(name);
    if (!a) throw Object.assign(E(207, name), { code: 'edits' });
    return a;
  };
  const rels = await meta.relationships(info.logicalName).catch(() => null);
  const tbl = sqlIdent(info.logicalName), pkId = sqlIdent(info.primaryIdAttribute);
  const edited = [...new Set(payload.updates.flatMap(u => u.set.map(s => s.col)))];
  const ids = [...payload.updates.map(u => lower(u.id)), ...payload.deletes.map(d => lower(d.id))];
  const snap = ids.length ? await snapshot(api, info, ids, edited) : new Map();
  const ops = [], sql = [], skipped = [], warnings = [];
  const parts = [];

  // deletes -> updates -> creates (§8.2 order)
  const delPart = { op: 'delete', entity: info.logicalName, ids: [], columns: [], sample: [], ops: [] };
  for (const d of payload.deletes) {
    const id = lower(d.id), cur = snap.get(id);
    if (!cur) { skipped.push({ kind: 'delete', key: id, reason: 'missing', message: 'No longer exists.' }); continue; }
    const v = d.etag ?? cur.versionnumber;
    if (d.etag != null && String(cur.versionnumber) !== String(d.etag)) { skipped.push({ kind: 'delete', key: id, reason: 'etag', message: 'Changed since you loaded it; run the query again.' }); continue; }
    const op = { op: 'delete', entity: info.logicalName, entitySet: info.entitySetName, id, ifMatch: ifMatchOf(info, v) };
    delPart.ops.push(op); delPart.ids.push(id);
    delPart.sample.push({ id, name: cur[info.primaryNameAttribute] ?? null, before: [], after: [] });
    sql.push(`DELETE FROM ${tbl} WHERE ${pkId} = ${sqlStr(id)};`);
  }
  const updCols = edited.map(attrsOf);
  const updPart = { op: 'update', entity: info.logicalName, ids: [], columns: updCols.map(a => ({ name: a.logicalName, displayName: a.displayName ?? a.logicalName, type: dtOfAttr(a), attr: a })), sample: [], ops: [], before: new Map() };
  for (const u of payload.updates) {
    const id = lower(u.id), cur = snap.get(id);
    if (!cur) { skipped.push({ kind: 'update', key: id, reason: 'missing', message: 'No longer exists.' }); continue; }
    if (u.etag != null && String(cur.versionnumber) !== String(u.etag)) { skipped.push({ kind: 'update', key: id, reason: 'etag', message: 'Changed since you loaded it; run the query again.' }); continue; }
    const body = {}, setSql = [], sent = new Map();
    for (const s of u.set) {
      const a = attrsOf(s.col);
      if (sameValue(recValue(cur, a), s.value, a) && (!LOOKUPS.has(a.type) || s.value == null)) continue;
      setBody(body, a, s.value, s.entity, rels, meta);
      setSql.push(`${sqlIdent(a.logicalName)} = ${sqlValue(a, s.value, s.entity)}`);
      sent.set(a.logicalName, s.value);
    }
    if (!setSql.length) { skipped.push({ kind: 'update', key: id, reason: 'same', message: 'Already had these values.', done: true }); continue; }
    const op = { op: 'update', entity: info.logicalName, entitySet: info.entitySetName, id, ifMatch: ifMatchOf(info, u.etag ?? cur.versionnumber), body };
    updPart.ops.push(op); updPart.ids.push(id);
    // A column this record does not change has no after value, so the dialog shows it plainly (no "a → a").
    const beforeVals = updCols.map(a => recValue(cur, a));
    const afterVals = updCols.map(a => (sent.has(a.logicalName) ? sent.get(a.logicalName) : undefined));
    updPart.sample.push({ id, name: cur[info.primaryNameAttribute] ?? null, before: beforeVals, after: afterVals });
    updPart.before.set(id, { values: beforeVals, after: afterVals });
    sql.push(`UPDATE ${tbl} SET ${setSql.join(', ')} WHERE ${pkId} = ${sqlStr(id)};`);
  }
  const insCols = [...new Set(payload.inserts.flatMap(ins => ins.map(s => s.col)))].map(attrsOf);
  const insPart = { op: 'insert', entity: info.logicalName, ids: [], columns: insCols.map(a => ({ name: a.logicalName, displayName: a.displayName ?? a.logicalName, type: dtOfAttr(a), attr: a })), sample: [], ops: [] };
  payload.inserts.forEach((ins, index) => {
    const id = uuid();
    const body = { [info.primaryIdAttribute]: id };
    const cols = [], vals = [];
    for (const s of ins) {
      const a = attrsOf(s.col);
      if (s.value == null) continue;
      setBody(body, a, s.value, s.entity, rels, meta);
      cols.push(sqlIdent(a.logicalName));
      vals.push(sqlValue(a, s.value, s.entity));
      if (a.isSecured) warnings.push({ level: 'warning', text: `Copies secured column ${a.logicalName}; masked values would be written as text.` });
    }
    const op = { op: 'create', entity: info.logicalName, entitySet: info.entitySetName, id, body, insertIndex: index };
    insPart.ops.push(op);
    insPart.sample.push({ id: null, name: null, before: [], after: insCols.map(a => ins.find(s => s.col === a.logicalName)?.value ?? null) });
    sql.push(cols.length ? `INSERT INTO ${tbl} (${cols.join(', ')}) VALUES (${vals.join(', ')});` : `INSERT INTO ${tbl} DEFAULT VALUES;`);
  });
  for (const p of [delPart, updPart, insPart]) if (p.ops.length) { parts.push(p); ops.push(...p.ops); }

  const count = ops.length;
  const isProduction = !!org?.isProduction;
  const highRisk = HIGH_RISK.test(info.logicalName);
  if (highRisk) warnings.push({ level: 'danger', text: `${info.logicalName} is a system table: changes here can affect security, customisations or the whole environment.` });
  if (skipped.some(s => s.reason === 'etag')) warnings.push({ level: 'warning', text: `${skipped.filter(s => s.reason === 'etag').length} record(s) changed since you loaded them and are skipped.` });
  return {
    op: 'mixed', entity: info, count, skipped: skipped.filter(s => !s.done).length, removed: skipped.filter(s => s.reason === 'missing').length,
    columns: updPart.columns, sample: updPart.sample.slice(0, SAMPLE_MAX), parts: parts.map(p => ({ ...p, sample: p.sample.slice(0, SAMPLE_MAX) })),
    ids: ops.filter(o => o.id && o.op !== 'create').map(o => o.id), creates: insPart.ops.length,
    ops: ops.map(({ insertIndex, ...o }) => o), opIndex: ops.map(o => o.insertIndex ?? null), updBefore: updPart.before, insCols: insCols.map(a => a.logicalName),
    grantSpec: { ops: ops.map(({ insertIndex, ...o }) => o), options: {}, callerId: caller?.id ?? null },
    warnings, requireTyped: count > 100 || isProduction || highRisk ? String(count) : null,
    options: { bypassPlugins: false, bypassLogic: false, suppressFlows: false, suppressDuplicateDetection: false, ignoreDupKey: false, batchSize: Math.min(100, settings.batchSize ?? 50), maxdop: settings.maxdop || 4, continueOnError: true, createMultiple: null },
    statementText: sql.join('\n'), environment: { type: org?.type ?? null, name: org?.name ?? null, url: org?.url ?? null, isProduction },
    impersonating: caller?.name ?? null, backup: null, beforeAfter: null, recycleBin: null, cascade: [], automation: null, partial: null,
    execution: null, runId: null, statementKey: null, dangerKinds: [], dynamic: false, standing: null, bulkDelete: null,
    preSkipped: skipped,
  };
}

// Sends the confirmed change set and returns the grid's per-row results (02 §9 `edits {results}`).
export async function writeEdits(preview, grant, { api, onProgress } = {}) {
  const res = await api.write(grant, preview.ops, {
    batchSize: preview.options.batchSize, maxdop: preview.options.maxdop, continueOnError: true, stop: () => false,
    onProgress: p => { try { onProgress?.(p); } catch { /* the UI's */ } },
  });
  const out = preview.preSkipped.map(s => ({ kind: s.kind, key: s.key, status: s.done ? 'done' : 'skipped', message: s.message }));
  res.forEach((r, i) => {
    const op = preview.ops[i];
    const kind = op.op === 'create' ? 'insert' : op.op;
    const key = kind === 'insert' ? preview.opIndex[i] : op.id;
    const status = r.status === 'ok' ? 'done' : r.status === 'notAttempted' ? 'failed' : r.status;
    const message = r.status === 'ok' ? null : r.reason === 'etag' ? 'Changed since you loaded it; run the query again.' : r.reason === 'missing' ? 'No longer exists.' : r.message ?? null;
    out.push({ kind, key, status, message, etag: r.etag ?? null, newId: kind === 'insert' && r.status === 'ok' ? (r.newId ?? op.id) : undefined });
  });
  return { results: out, writes: res };
}

// The ChangeEntry of a written grid change set (02 §8.2: op 'mixed'; Undo restores its updates and deletes its creates).
export function editsEntry(preview, writes, { caller = null } = {}) {
  const entry = {
    id: uuid(), at: Date.now(), op: 'mixed', entity: preview.entity.logicalName, statement: preview.statementText ?? '', columns: (preview.columns ?? []).map(c => c.name),
    ok: [], failed: [], skipped: [], unknown: [], notAttempted: [], undoable: false, backup: false, callerId: caller?.id ?? null, parts: { update: [], insert: [] },
  };
  writes.forEach((r, i) => {
    const op = preview.ops[i];
    if (r.status === 'ok') {
      const b = op.op === 'update' ? preview.updBefore?.get(op.id) : null;
      const item = { id: op.op === 'create' ? lower(r.newId ?? op.id) : op.id, before: b?.values ?? [], after: b?.after ?? [], etag: r.etag ?? null, kind: op.op };
      entry.ok.push(item);
      if (op.op === 'update') entry.parts.update.push(item);
      if (op.op === 'create') entry.parts.insert.push(item);
    } else if (r.status === 'failed') entry.failed.push({ id: op.id, code: r.code ?? null, message: r.message ?? '' });
    else if (r.status === 'skipped') entry.skipped.push({ id: op.id, reason: r.reason ?? null });
    else if (r.status === 'unknown') entry.unknown.push(op.id);
    else entry.notAttempted.push(op.id);
  });
  entry.undoable = entry.parts.update.length + entry.parts.insert.length > 0 && !entry.ok.some(x => x.kind === 'delete');
  if (entry.ok.some(x => x.kind === 'delete')) entry.undoReason = 'Undo is not available for a change set that deleted records.';
  return entry;
}
