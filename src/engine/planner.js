// Planner (02 §3-§4; 01 §6-§7): binds a Query AST into a logical tree, rewrites it
// (view merging, decorrelation, scalar-subquery joins, equality closure, LEFT->INNER conversion), pushes everything
// FetchXML can do into FetchScans (joins as link-entities, filters, orders, TOP/OFFSET/paging, DISTINCT, aggregates,
// semi-join links, hierarchy operators) and returns the physical operator tree of exec.js / fetchxml.js /
// metatables.js. Pure: no DOM; metadata only through meta's sync members after prefetch(); numbered errors from
// messages.js msg(); expressions through compile.js.

import { SqlError } from './lexer.js';
import { msg } from './messages.js';
import { exprKey } from './parser.js';
import {
  commonType, coerce, castValue, precedence, dtOfAttr, dtOf, collKeyAI, likeMatcher, fromParts, dateParts,
} from './types.js';
import { AGGREGATES, WINDOWS, TVFS, XML_NODES, FETCH_CONDITIONS, lookupFunction } from './functions.js';
import {
  compileExpr, compilePredicate, projectSchema, shiftSchema, resolveColumn, groupKey, combineErrors,
} from './compile.js';
import {
  PlanNode, Filter, Project, HashJoin, NestedLoop, Sort, Top, Offset, Distinct, HashAggregate, Window, Concat, SetOp,
  Spool, IndexSpool, IndexSeek, RecursiveCte, Into, Pivot, Unpivot, JsonOutput, XmlOutput, TryCatch, ConstantScan,
  TempScan, TvfScan, ApiFnScan, TotalCount, stateOf, emitInfo,
} from './exec.js';
import { FetchScan, PartitionedAggregate, isAggregateFallback, mapRow, formatValue } from './fetchxml.js';
import { MetaScan, findMetaTable, metaColumns, isPushable, sysFunction, META_TABLES, SYS_TABLES } from './metatables.js';
import { suggest } from '../core/util.js';

// ================================================================================================ errors

// A numbered SqlError with the messages.js text, severity and state 1, at node's source range when given.
function E(number, ...args) {
  const m = msg(number, ...args);
  const e = new SqlError(m.message);
  e.number = m.number;
  e.severity = m.severity;
  e.state = 1;
  return e;
}

// A SQL Studio error without a SQL Server number (severity 16, state 1).
function plain(text) {
  const e = new SqlError(text);
  e.severity = 16;
  e.state = 1;
  return e;
}

// Gives an error without a position the source range of node.
function at(e, node) {
  if (e instanceof SqlError && e.pos == null && node && typeof node.pos === 'number') {
    e.pos = node.pos;
    e.end = typeof node.end === 'number' ? node.end : node.pos + 1;
  }
  return e;
}

const BIND_NUMBERS = new Set([207, 208, 209, 4104, 107, 8120, 8121, 8127]);
const isBindError = e => e instanceof SqlError && BIND_NUMBERS.has(e.number);

// ================================================================================================ small helpers

const EMPTY = Object.freeze([]);
const lower = s => String(s ?? '').toLowerCase();
const isObj = x => !!x && typeof x === 'object';
const has = (m, k) => m.has(k);
const IDENT = /^[a-z_][a-z0-9_]*$/;
const MAX_IN = 5000;
const FETCH_TOP_MAX = 5000;
const PAGE_CAP = 50000;
const PK_ROLE = 'pk';

// Node types whose children are expressions (never descends into subquery bodies).
function exprKids(x) {
  switch (x.type) {
    case 'bin': case 'distinctfrom': return [x.l, x.r];
    case 'neg': case 'not': case 'paren': case 'isnull': case 'collate': return [x.e];
    case 'between': return [x.e, x.lo, x.hi];
    case 'in': return x.list ? [x.e, ...x.list] : [x.e];
    case 'like': return x.escape ? [x.e, x.pattern, x.escape] : [x.e, x.pattern];
    case 'quantified': return [x.l];
    case 'case': {
      const o = x.operand ? [x.operand] : [];
      for (const [w, t] of x.whens || EMPTY) o.push(w, t);
      if (x.else) o.push(x.else);
      return o;
    }
    case 'cast': return x.style ? [x.e, x.style] : [x.e];
    case 'fn': {
      const o = (x.args || EMPTY).slice();
      if (x.over) {
        for (const p of x.over.partitionBy || EMPTY) o.push(p);
        for (const it of x.over.orderBy || EMPTY) o.push(it.expr);
      }
      for (const it of x.withinGroup || EMPTY) o.push(it.expr);
      return o;
    }
    case 'xmlmethod': return [x.e, ...(x.args || EMPTY)];
    default: return EMPTY;
  }
}

// Calls f on every expression node of x (pre-order), not inside subqueries; f returning false skips the kids.
function walkExpr(x, f) {
  if (!isObj(x)) return;
  if (f(x) === false) return;
  for (const k of exprKids(x)) walkExpr(k, f);
}

// Whether an expression (not looking into subqueries) satisfies p somewhere.
function someExpr(x, p) {
  let hit = false;
  walkExpr(x, n => {
    if (hit) return false;
    if (p(n)) { hit = true; return false; }
    return true;
  });
  return hit;
}

const isSubqNode = n => n.type === 'subq' || n.type === 'exists' || (n.type === 'in' && !!n.query) || n.type === 'quantified';
const hasSubquery = x => someExpr(x, isSubqNode);
const upName = n => String(n.name || '').toUpperCase();
const isAggCall = n => n.type === 'fn' && !n.over && AGGREGATES.has(upName(n));
const isWinCall = n => n.type === 'fn' && !!n.over;
const hasAggregate = x => someExpr(x, isAggCall);
const hasWindow = x => someExpr(x, isWinCall);
const isNewid = n => n.type === 'fn' && (upName(n) === 'NEWID' || (upName(n) === 'RAND' && !(n.args || EMPTY).length));

// Calls f on every node of a whole AST (statements, queries, expressions, subqueries included).
function walkAll(x, f, seen = new Set()) {
  if (!isObj(x) || seen.has(x)) return;
  seen.add(x);
  if (Array.isArray(x)) { for (const y of x) walkAll(y, f, seen); return; }
  f(x);
  for (const k of Object.keys(x)) {
    if (k === 'pos' || k === 'end' || k.charCodeAt(0) === 95) continue;
    const v = x[k];
    if (isObj(v)) walkAll(v, f, seen);
  }
}

// Whether a whole query AST contains NEWID() or an unseeded RAND().
function queryHasNewid(q) {
  let hit = false;
  walkAll(q, n => { if (!hit && n.type === 'fn' && isNewid(n)) hit = true; });
  return hit;
}

// The AND conjuncts of an expression (parentheses stripped).
function conjuncts(x, out = []) {
  if (!x) return out;
  if (x.type === 'paren') return conjuncts(x.e, out);
  if (x.type === 'bin' && x.op === 'AND') {
    conjuncts(x.l, out);
    conjuncts(x.r, out);
    return out;
  }
  out.push(x);
  return out;
}

// The OR branches of an expression (parentheses stripped).
function disjuncts(x, out = []) {
  if (x.type === 'paren') return disjuncts(x.e, out);
  if (x.type === 'bin' && x.op === 'OR') {
    disjuncts(x.l, out);
    disjuncts(x.r, out);
    return out;
  }
  out.push(x);
  return out;
}

const strip = x => (x && x.type === 'paren' ? strip(x.e) : x);

// An AND of expressions (null for none).
function andOf(list) {
  let r = null;
  for (const x of list) r = r ? { type: 'bin', op: 'AND', l: r, r: x, pos: r.pos, end: x.end } : x;
  return r;
}

const lit = (v, dt = 'int', node) => ({ type: 'lit', v, dt, raw: v == null ? undefined : String(v), pos: node?.pos, end: node?.end });
const col = (parts, node) => ({ type: 'col', parts, pos: node?.pos, end: node?.end });

// A deep copy of an AST subtree (annotations kept, functions shared).
function cloneAst(x, map = new Map()) {
  if (!isObj(x)) return x;
  if (map.has(x)) return map.get(x);
  if (Array.isArray(x)) {
    const out = [];
    map.set(x, out);
    for (const y of x) out.push(cloneAst(y, map));
    return out;
  }
  if (x instanceof Set || x instanceof Map) return x;
  const out = {};
  map.set(x, out);
  for (const k of Object.keys(x)) out[k] = cloneAst(x[k], map);
  return out;
}

// Replaces nodes of an expression tree (not inside subqueries unless deep) by f(node) when f returns a node.
function mapExpr(x, f) {
  if (!isObj(x)) return x;
  const r = f(x);
  if (r !== undefined) return r;
  let out = null;
  const set = (k, v) => {
    if (v === x[k]) return;
    if (!out) out = { ...x };
    out[k] = v;
  };
  switch (x.type) {
    case 'bin': case 'distinctfrom': set('l', mapExpr(x.l, f)); set('r', mapExpr(x.r, f)); break;
    case 'neg': case 'not': case 'paren': case 'isnull': case 'collate': set('e', mapExpr(x.e, f)); break;
    case 'between': set('e', mapExpr(x.e, f)); set('lo', mapExpr(x.lo, f)); set('hi', mapExpr(x.hi, f)); break;
    case 'in': set('e', mapExpr(x.e, f)); if (x.list) set('list', mapList(x.list, f)); break;
    case 'like': set('e', mapExpr(x.e, f)); set('pattern', mapExpr(x.pattern, f)); if (x.escape) set('escape', mapExpr(x.escape, f)); break;
    case 'quantified': set('l', mapExpr(x.l, f)); break;
    case 'case': {
      if (x.operand) set('operand', mapExpr(x.operand, f));
      const ws = x.whens.map(([w, t]) => [mapExpr(w, f), mapExpr(t, f)]);
      if (ws.some((p, i) => p[0] !== x.whens[i][0] || p[1] !== x.whens[i][1])) set('whens', ws);
      if (x.else) set('else', mapExpr(x.else, f));
      break;
    }
    case 'cast': set('e', mapExpr(x.e, f)); if (x.style) set('style', mapExpr(x.style, f)); break;
    case 'fn': {
      if (x.args) set('args', mapList(x.args, f));
      if (x.over) {
        const pb = mapList(x.over.partitionBy || EMPTY, f);
        const ob = (x.over.orderBy || EMPTY).map(it => { const e = mapExpr(it.expr, f); return e === it.expr ? it : { ...it, expr: e }; });
        if (pb !== (x.over.partitionBy || EMPTY) || ob.some((it, i) => it !== x.over.orderBy[i])) set('over', { ...x.over, partitionBy: pb, orderBy: ob });
      }
      if (x.withinGroup) {
        const wg = x.withinGroup.map(it => { const e = mapExpr(it.expr, f); return e === it.expr ? it : { ...it, expr: e }; });
        if (wg.some((it, i) => it !== x.withinGroup[i])) set('withinGroup', wg);
      }
      break;
    }
    case 'xmlmethod': set('e', mapExpr(x.e, f)); if (x.args) set('args', mapList(x.args, f)); break;
    default: break;
  }
  return out || x;
}

function mapList(list, f) {
  let out = null;
  for (let i = 0; i < list.length; i++) {
    const v = mapExpr(list[i], f);
    if (v !== list[i]) {
      if (!out) out = list.slice();
      out[i] = v;
    }
  }
  return out || list;
}

// The written name of an ObjectName's last part (lower case) and its schema ('dbo' by default).
function objName(name) {
  const parts = name.parts.map(String);
  return { parts, last: parts[parts.length - 1], lastLower: lower(parts[parts.length - 1]), schema: parts.length >= 2 ? lower(parts[parts.length - 2]) : null };
}

const digits = n => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// The org-collation key of a label, case-, accent- and trailing-space-insensitive (02 §4.2 labels).
const collKeyAIOf = s => collKeyAI(String(s));
// A LIKE matcher over labels in the org collation, accent-insensitive (02 §4.2 labels).
const likeMatcherAI = pattern => likeMatcher(pattern, null, true);

// ================================================================================================ prefetch (phase 1)

const PREFETCH = Symbol('sqlstudio.planner.prefetch');
const AGG_MONEY = new Set(['SUM', 'AVG', 'MIN', 'MAX']);

// The prefetch results of a ctx (created on first use): table load errors, alternate keys, the recycle-bin tables
// and the currency count, read synchronously by the binder.
function pf(ctx) {
  let s = ctx[PREFETCH];
  if (!s) {
    s = { errors: new Map(), keys: new Map(), recycle: null, currency: null, messages: null, messagesError: null };
    try {
      Object.defineProperty(ctx, PREFETCH, { value: s, enumerable: false, configurable: true });
    } catch {
      return s;
    }
  }
  return s;
}

// The table names, TVF names and column names a query AST references (CTE names and #/@ names left out).
function scanAst(query, ctx) {
  const ctes = new Set(), tables = new Set(), tvfs = new Set(), names = new Set(), subTables = new Set(), recTables = new Set();
  let aggMoney = false, bin = false;
  if (ctx.ctes instanceof Map) for (const k of ctx.ctes.keys()) ctes.add(lower(k));
  walkAll(query, n => {
    if (Array.isArray(n.with)) for (const c of n.with) if (c && c.name) ctes.add(lower(c.name));
  });
  const meta = ctx.meta;
  const visit = (n, inSub) => {
    walkAll(n, x => {
      if (x.type === 'table' && x.name && Array.isArray(x.name.parts)) {
        const o = objName(x.name);
        if (/^[#@]/.test(o.last) || o.parts.length > 2) return;
        if (o.parts.length === 2 && !['dbo', 'archive', 'bin'].includes(o.schema)) return;
        if (o.parts.length === 1 && ctes.has(o.lastLower) && !(meta && meta.findEntity && meta.findEntity(o.lastLower))) return;
        if (o.schema === 'bin') bin = true;
        tables.add(o.lastLower);
        if (inSub) subTables.add(o.lastLower);
      } else if (x.type === 'tvf' && x.name && Array.isArray(x.name.parts)) {
        const up = String(x.name.parts[x.name.parts.length - 1]).toUpperCase();
        if (!TVFS.has(up) && !(x.name.parts.length === 2 && lower(x.name.parts[0]) === 'sys')) tvfs.add(up);
      } else if (x.type === 'col' && Array.isArray(x.parts)) {
        names.add(lower(x.parts[x.parts.length - 1]));
      } else if (x.type === 'fn' && AGG_MONEY.has(upName(x)) && !x.over) aggMoney = true;
    });
  };
  visit(query, false);
  walkAll(query, x => { if (x.type === 'subq' && x.query) visit(x.query, true); });
  // the tables of recursive CTEs (the hierarchy pushdown reads their relationships, 02 §3 phase 6)
  walkAll(query, n => {
    if (!Array.isArray(n.with)) return;
    for (const c of n.with) {
      if (!c || !c.query) continue;
      const nm = lower(c.name);
      let self = false;
      walkAll(c.query, x => { if (x.type === 'table' && x.name && x.name.parts.length === 1 && lower(x.name.parts[0]) === nm) self = true; });
      if (self) walkAll(c.query, x => { if (x.type === 'table' && x.name && x.name.parts.length === 1 && lower(x.name.parts[0]) !== nm) recTables.add(lower(x.name.parts[0])); });
    }
  });
  return { tables, tvfs, names, subTables, recTables, aggMoney, bin };
}

// Phase 1 (02 §3): loads the metadata of every referenced Dataverse table (subqueries and CTEs included) in parallel,
// the option sets of label comparisons, the alternate keys of subquery tables, the relationships of recursive CTE
// tables, the Web API messages of function TVFs, the recycle-bin tables and the currency count of Money aggregates.
// A table that fails to load keeps its error, which the binder raises at the table's position.
export async function prefetch(query, ctx) {
  const st = pf(ctx);
  const meta = ctx.meta;
  if (!meta) return;
  const s = scanAst(query, ctx);
  const loadTable = async name => {
    if (meta.entitySync && meta.entitySync(name)) return;
    try {
      await meta.entity(name);
      st.errors.delete(name);
    } catch (e) {
      st.errors.set(name, e);
    }
  };
  const jobs = [...s.tables].map(loadTable);
  if (s.tvfs.size && typeof meta.messages === 'function') {
    jobs.push((async () => {
      try {
        const m = await meta.messages();
        st.messages = m;
        // the response tables of function TVFs (02 §9 shapes (a) and (b)) need their attributes
        const more = [];
        for (const up of s.tvfs) {
          const e = m && typeof m.get === 'function' ? m.get(lower(up)) : null;
          if (!e) continue;
          if (e.responseEntity && e.responseEntity !== 'Entity' && e.responseEntity !== 'expando') more.push(loadTable(lower(e.responseEntity)));
          for (const p of e.response || EMPTY) {
            const t = lower(String(p.type || '').replace(/\[\]$/, ''));
            if (t === 'auditdetail' || t === 'auditdetailcollection') more.push(loadTable('audit'));
            else if (t && meta.findEntity && meta.findEntity(t)) more.push(loadTable(t));
          }
        }
        await Promise.all(more);
      } catch (e) {
        st.messagesError = e;
      }
    })());
  }
  if (s.bin && typeof meta.recycleBin === 'function') jobs.push(meta.recycleBin().then(set => { st.recycle = set; }, () => { st.recycle = null; }));
  if (s.aggMoney && typeof meta.currencyCount === 'function') jobs.push(meta.currencyCount().then(n => { st.currency = n; }, () => { st.currency = null; }));
  await Promise.all(jobs);
  const more = [];
  for (const name of s.tables) {
    const ent = meta.entitySync ? meta.entitySync(name) : null;
    if (!ent || !ent.attrList) continue;
    // option sets of the choice and bool columns whose labels the query may compare (02 §4.2)
    const cat = catalogue(ent);
    for (const a of ent.attrList) {
      if (!OPTION_TYPES.has(a.type)) continue;
      const nameDef = cat.byBase.get(a.logicalName)?.name;
      if (!nameDef || !s.names.has(lower(nameDef.name))) continue;
      if (meta.options && !(meta.optionsSync && meta.optionsSync(ent.logicalName, a.logicalName))) more.push(meta.options(ent.logicalName, a.logicalName).catch(() => null));
    }
    // alternate keys of subquery tables (02 §3 phase 3c (a)) and relationships of recursive CTE tables
    if (s.subTables.has(name) && typeof meta.keys === 'function' && !st.keys.has(ent.logicalName)) {
      more.push(meta.keys(ent.logicalName).then(k => { st.keys.set(ent.logicalName, k); }, () => { st.keys.set(ent.logicalName, EMPTY); }));
    }
    if (s.recTables.has(name) && typeof meta.relationships === 'function' && !(meta.relationshipsSync && meta.relationshipsSync(ent.logicalName))) {
      more.push(meta.relationships(ent.logicalName).catch(() => null));
    }
  }
  await Promise.all(more);
}

// ================================================================================================ column catalogue

const OPTION_TYPES = new Set(['Picklist', 'State', 'Status', 'Boolean', 'MultiSelectPicklist']);
const CHOICE_TYPES = new Set(['Picklist', 'State', 'Status', 'Boolean']);
const LOOKUP_TYPES = new Set(['Lookup', 'Customer', 'Owner']);
const GUID_TYPES = new Set(['Lookup', 'Customer', 'Owner', 'Uniqueidentifier']);
const NO_STAR = new Set(['Virtual', 'Image', 'File', 'PartyList', 'CalendarRules', 'ManagedProperty']);
const NEVER_PUSH = new Set(['PartyList', 'Image', 'File', 'CalendarRules', 'ManagedProperty']);
const NOT_JOINABLE = new Set(['File', 'Image', 'MultiSelectPicklist', 'PartyList', 'Memo', 'Virtual', 'CalendarRules', 'ManagedProperty']);
const CATALOGUES = new WeakMap();
const NAME_T = Object.freeze({ dt: 'string', len: -1, unicode: true });
const TYPE_T = Object.freeze({ dt: 'string', len: 64, unicode: true });

// The column catalogue of a Dataverse table (01 §6.3): every readable attribute, the lookup name/type and the
// choice/bool name columns (real AttributeOf attributes or virtual ones), and the star list in the setting's order.
// Def = {name, kind: 'attr'|'name'|'type', attr (the attribute read; the base attribute of a name/type column), real
// (the metadata attribute of the column, null for a virtual one), type, ref, star}.
function catalogue(ent, order = 'alpha') {
  let byOrder = CATALOGUES.get(ent);
  if (!byOrder) CATALOGUES.set(ent, (byOrder = new Map()));
  let c = byOrder.get(order);
  if (c) return c;
  const byName = new Map(), byBase = new Map(), star = [];
  const attrs = (ent.attrList || EMPTY).filter(a => a.validForRead !== false);
  const pkName = lower(ent.primaryIdAttribute);
  const slot = base => {
    let x = byBase.get(base);
    if (!x) byBase.set(base, (x = { name: null, type: null }));
    return x;
  };
  for (const a of attrs) {
    const def = { name: a.logicalName, kind: 'attr', attr: a, real: a, type: { ...dtOfAttr(a) }, ref: undefined, star: false };
    const baseAttr = a.attributeOf && ent.attrs ? ent.attrs.get(a.attributeOf) : null;
    if (baseAttr && LOOKUP_TYPES.has(baseAttr.type) && a.type === 'String' && !a.yomiOf) {
      Object.assign(def, { kind: 'name', attr: baseAttr, type: { dt: 'string', len: dtOfAttr(a).len ?? -1, unicode: true } });
      slot(baseAttr.logicalName).name = def;
    } else if (baseAttr && OPTION_TYPES.has(baseAttr.type) && a.type === 'Virtual') {
      Object.assign(def, { kind: 'name', attr: baseAttr, type: { ...NAME_T } });
      slot(baseAttr.logicalName).name = def;
    } else if (baseAttr && LOOKUP_TYPES.has(baseAttr.type) && a.type === 'EntityName') {
      Object.assign(def, { kind: 'type', attr: baseAttr, type: { ...TYPE_T } });
      slot(baseAttr.logicalName).type = def;
    } else if (!a.attributeOf) {
      if (lower(a.logicalName) === pkName || a.isPk) def.ref = { entity: ent.logicalName };
      else if (LOOKUP_TYPES.has(a.type)) def.ref = a.targets && a.targets.length === 1 ? { entity: a.targets[0] } : { poly: true };
      def.star = !NO_STAR.has(a.type);
    }
    byName.set(lower(a.logicalName), def);
  }
  // the xname / xtype columns (01 §6.3): the attribute of that name when it is the companion, else a virtual column
  // when the name is free; a real companion of another name (audit objecttypecode for objectid) stays selectable
  const starName = new Map();
  for (const a of attrs) {
    if (a.attributeOf) continue;
    const isLookup = LOOKUP_TYPES.has(a.type);
    if (!isLookup && !OPTION_TYPES.has(a.type)) continue;
    if (isLookup && ent.logicalName === 'solutioncomponent') continue;
    const e = slot(a.logicalName);
    const nm = a.logicalName + 'name';
    const named = byName.get(nm);
    if (named && named.kind === 'name' && named.attr === a) { e.name = named; starName.set(a.logicalName, { name: named }); }
    else if (!named) {
      const v = { name: nm, kind: 'name', attr: a, real: null, type: { ...NAME_T }, ref: undefined, star: false, virtual: true };
      byName.set(nm, v);
      if (!e.name) e.name = v;
      starName.set(a.logicalName, { name: v });
    }
    if (isLookup && a.type !== 'PartyList' && !(a.targets && a.targets.length === 1)) {
      const tn = a.logicalName + 'type';
      const typed = byName.get(tn);
      const s = starName.get(a.logicalName) || {};
      if (typed && typed.kind === 'type' && typed.attr === a) { e.type = typed; s.type = typed; }
      else if (!typed) {
        const v = { name: tn, kind: 'type', attr: a, real: e.type ? e.type.real : null, type: { ...TYPE_T }, ref: undefined, star: false, virtual: true };
        byName.set(tn, v);
        if (!e.type) e.type = v;
        s.type = v;
      }
      starName.set(a.logicalName, s);
    }
  }
  const bases = attrs.filter(a => !a.attributeOf && !NO_STAR.has(a.type));
  if (order === 'schema') bases.sort((x, y) => (x.columnNumber ?? 0) - (y.columnNumber ?? 0) || (x.logicalName < y.logicalName ? -1 : 1));
  else bases.sort((x, y) => (x.logicalName < y.logicalName ? -1 : x.logicalName > y.logicalName ? 1 : 0));
  for (const a of bases) {
    star.push(byName.get(lower(a.logicalName)));
    const e = starName.get(a.logicalName);
    if (e && e.name) { e.name.star = true; star.push(e.name); }
    if (e && e.type) { e.type.star = true; star.push(e.type); }
  }
  c = { byName, byBase, star, pk: byName.get(pkName) || null, ent };
  byOrder.set(order, c);
  return c;
}

// The companion slots of a base attribute in a catalogue: {name, type} defs (either may be null).
const companionsOf = (cat, attrName) => cat.byBase.get(attrName) || { name: null, type: null };

// ================================================================================================ the planner

const KIND_KEY = '_sqk';
let leafSeq = 0;

// The distance from scope `from` up to scope `to` (parent steps), or -1.
function scopeDistance(from, to) {
  let k = 0;
  for (let s = from; s; s = s.parent, k++) if (s === to) return k;
  return -1;
}

// The ancestor of a scope `depth` parent steps up.
function ancestor(scope, depth) {
  let s = scope;
  for (let i = 0; i < depth && s; i++) s = s.parent;
  return s;
}

// Marks every subquery node of a statement with its kind (scalar, exists, in, quantified), so that planSubquery,
// which compile.js calls with the query alone, applies the row goals of 02 §3 phase 3.
function annotateKinds(root) {
  walkAll(root, n => {
    if (n.type === 'subq' && n.query) setKind(n.query, 'scalar');
    else if (n.type === 'exists' && n.query) setKind(n.query, 'exists');
    else if (n.type === 'in' && n.query) setKind(n.query, 'in');
    else if (n.type === 'quantified' && n.query) setKind(n.query, 'quantified');
  });
}

function setKind(q, k) {
  try {
    Object.defineProperty(q, KIND_KEY, { value: k, enumerable: false, configurable: true, writable: true });
  } catch {
    // a frozen AST keeps no kind: the subquery is then planned without its row goal
  }
}

// The statement-level planning state (02 §3): settings, hints, collected binding errors, the CTE and XML
// namespace scopes, the correlation trackers and the spools shared by identical CTE references.
class Planner {
  constructor(ctx) {
    this.ctx = ctx;
    this.meta = ctx.meta || null;
    this.rt = ctx.rt || {};
    this.settings = ctx.settings || this.rt.settings || {};
    this.hints = ctx.hints || { use: new Set(), fetchOptions: [] };
    if (!(this.hints.use instanceof Set)) this.hints = { ...this.hints, use: new Set(this.hints.use || EMPTY) };
    this.noPushdown = !!ctx.noPushdown || !!this.settings.noPushdown || this.hints.use.has('DEBUG_BYPASS_OPTIMIZATION');
    this.explainOnly = !!ctx.explainOnly;
    this.source = typeof ctx.source === 'string' ? ctx.source : null;
    this.errors = [];
    this.warned = new Set();
    this.pf = pf(ctx);
    this.cteScopes = [];
    this.xmlnsStack = [];
    this.trackers = [];
    this.aliasSeq = 0;
    this.spools = new Map();
    this.columnOrder = this.settings.columnOrder === 'schema' ? 'schema' : 'alpha';
    this.fetchOptions = (this.hints.fetchOptions || EMPTY).join(',');
    this.dml = ctx.dml || null;
    this.depth = 0;
    this.missingAliases = new Set();
  }

  // ------------------------------------------------------------------------------------------- messages

  // Adds a Messages warning once per statement (ctx.warn) and returns its text.
  warn(text, node) {
    if (!this.warned.has(text)) {
      this.warned.add(text);
      const w = this.ctx.warn || this.rt.warn;
      if (typeof w === 'function') {
        try { w.call(this.ctx, text, null, node && typeof node.pos === 'number' ? { pos: node.pos, end: node.end } : undefined); } catch { /* a reporting failure never fails planning */ }
      }
    }
    return text;
  }

  // The collected binding errors, without those a missing table causes: its alias's columns cannot be bound, so
  // SQL Server reports only the 208 (and no 207 for a name the missing table may have).
  bindErrors() {
    if (!this.missingAliases.size) return this.errors;
    const out = this.errors.filter(e => {
      if (e.number === 207) return false;
      if (e.number === 4104) {
        const m = /"([^"]*)"/.exec(e.message);
        const parts = m ? m[1].split('.') : [];
        const q = parts.length >= 2 ? lower(parts[parts.length - 2]) : null;
        if (q && this.missingAliases.has(q)) return false;
      }
      return true;
    });
    return out.length ? out : this.errors;
  }

  // An error to collect (207, 208, 209, 4104, 107) or throw at once.
  fail(e, node) {
    at(e, node);
    if (isBindError(e)) {
      this.errors.push(e);
      return null;
    }
    throw e;
  }

  // ------------------------------------------------------------------------------------------- compiling

  // The compile.js cx of a clause (01 §7), with the planner's subquery planning and error collection.
  cx(opts = {}) {
    return {
      planSubquery: (q, scope) => this.planSubquery(q, scope),
      aggregates: opts.aggregates,
      windows: opts.windows,
      settings: this.settings,
      meta: this.meta,
      rt: this.rt,
      clause: opts.clause || 'other',
      xmlns: this.xmlns(),
      source: this.source,
      errors: opts.errors === undefined ? this.errors : opts.errors,
      explainOnly: this.explainOnly,
    };
  }

  // Compiles an expression (or a predicate) against a scope and reports its outer references to the trackers.
  compile(expr, scope, opts = {}) {
    const cx = this.cx(opts);
    const c = opts.pred ? compilePredicate(expr, scope, cx) : compileExpr(expr, scope, cx);
    this.track(scope, c);
    return c;
  }

  // Marks the block columns a compiled expression reads (column pruning, 02 §3 phase 8) and reports its references
  // to the active correlation trackers.
  track(scope, c) {
    const use = (s, i) => {
      const b = s && s.block;
      if (!b) return;
      const at = s.base + i;
      if (at >= 0 && at < b.layoutSize()) b.used.add(at);
    };
    for (const i of c.cols || EMPTY) use(scope, i);
    for (const o of c.outer || EMPTY) use(ancestor(scope, o.depth), o.index);
    if (!this.trackers.length) return;
    const report = (target, index) => {
      for (const t of this.trackers) {
        const k = scopeDistance(t.scope, target);
        if (k >= 0) t.refs.set(k + ':' + index, { k, index });
      }
    };
    for (const i of c.cols || EMPTY) report(scope, i);
    for (const o of c.outer || EMPTY) {
      const target = ancestor(scope, o.depth);
      if (target) report(target, o.index);
    }
  }

  // Runs fn while recording the references into scope (and its ancestors) of everything compiled in it.
  tracked(scope, fn) {
    const t = { scope, refs: new Map() };
    this.trackers.push(t);
    try {
      const r = fn();
      return { result: r, refs: [...t.refs.values()].sort((a, b) => a.k - b.k || a.index - b.index) };
    } finally {
      const i = this.trackers.lastIndexOf(t);
      if (i >= 0) this.trackers.splice(i, 1);
    }
  }

  // Folds a constant compiled expression at plan time with ctx.rt (01 §7); {ok, value} ({ok: false} when it raises
  // or reads anything but constants and variables).
  fold(c) {
    if (!c || !c.isConst || (c.plans && c.plans.length)) return { ok: false };
    try {
      if (c.pre) return { ok: false };
      const v = c.fn(EMPTY, this.rt);
      return { ok: true, value: v === undefined ? null : v };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  // The XML namespace declarations in scope (WITH XMLNAMESPACES of the statement and enclosing queries).
  xmlns() {
    const out = [];
    for (const x of this.xmlnsStack) if (x) out.push(...x);
    if (this.ctx.xmlns) out.push(...this.ctx.xmlns);
    return out.length ? out : null;
  }

  // A generated alias (FetchXML link aliases use their own sequence, §4.1).
  genAlias(prefix = 'expr') {
    return `${prefix}${++this.aliasSeq}`;
  }

  // ------------------------------------------------------------------------------------------- CTEs

  // The CTE definition visible under a name, or null (innermost WITH first, then ctx.ctes).
  cte(name) {
    const n = lower(name);
    for (let i = this.cteScopes.length - 1; i >= 0; i--) {
      const d = this.cteScopes[i].get(n);
      if (d) return d;
    }
    if (this.ctx.ctes instanceof Map) {
      const d = this.ctx.ctes.get(n) || this.ctx.ctes.get(name);
      if (d) return d.query ? { name: d.name || name, columns: d.columns || null, query: d.query, pos: d.pos, scopeIndex: -1, refs: 0 } : null;
    }
    return null;
  }

  // Runs fn with the CTEs of a WITH clause in scope (01 §4.2; 239 is the parser's).
  withCtes(list, fn) {
    if (!list || !list.length) return fn();
    const m = new Map();
    this.cteScopes.push(m);
    try {
      for (const c of list) {
        const def = { name: c.name, columns: c.columns || null, query: c.query, pos: c.pos, node: c, scopeIndex: this.cteScopes.length - 1, refs: 0, recursive: cteIsRecursive(c) };
        m.set(lower(c.name), def);
      }
      return fn();
    } finally {
      this.cteScopes.pop();
    }
  }

  // ------------------------------------------------------------------------------------------- subqueries

  // cx.planSubquery (01 §7): plans a subquery of an expression synchronously against the scope of that expression,
  // with the row goals of its kind (EXISTS: TOP 1 of the primary key, scalar: TOP 2).
  planSubquery(query, scope) {
    const kind = query[KIND_KEY] || 'scalar';
    if (this.explainOnly) {
      // ctx.explainOnly: subqueries are shown, never evaluated at plan time (02 §3 phase 3)
    }
    let q = query;
    if (kind === 'exists') {
      q = normalizeExists(query);
      if (q === FALSE_EXISTS) return new ConstantScan({ schema: [{ name: '', qual: null, dt: 'int' }], rows: [], detail: 'EXISTS over TOP 0' });
    }
    const r = this.planQuery(q, scope, { kind, rowGoal: kind === 'exists' ? 1 : kind === 'scalar' ? 2 : 0 });
    return r.node;
  }

  // ------------------------------------------------------------------------------------------- queries

  // Plans a Query AST (WITH, set operations, ORDER BY, OFFSET/FETCH, FOR JSON / FOR XML) against an outer scope.
  // Returns {node, levels?, info} where node.schema is the output schema.
  planQuery(query, outer, opts = {}) {
    if (++this.depth > 64) {
      this.depth--;
      throw E(191);
    }
    try {
      if (query.xmlns) this.xmlnsStack.push(query.xmlns);
      try {
        return this.withCtes(query.with, () => this.planQueryBody(query, outer, opts));
      } finally {
        if (query.xmlns) this.xmlnsStack.pop();
      }
    } finally {
      this.depth--;
    }
  }

  planQueryBody(query, outer, opts) {
    const body = query.body;
    const forJson = query.forJson || null, forXml = query.forXml || null;
    let r;
    if (body.type === 'core') {
      r = new Block(this, body, outer, { ...opts, query, forJson, forXml }).plan();
    } else {
      r = this.planSetQuery(query, outer, opts);
    }
    if (forJson || forXml) r = this.forOutput(r, query, opts);
    return r;
  }

  // A set operation with the query's ORDER BY / OFFSET (02 §3 phase 6).
  planSetQuery(query, outer, opts) {
    const sop = this.planSetBody(query.body, outer, opts);
    let node = sop.node;
    const vis = visibleCols(node.schema);
    // ORDER BY: result names, ordinals, or an expression identical to a first-branch select item
    if (query.orderBy && query.orderBy.length) {
      const keys = [];
      for (const it of query.orderBy) {
        const idx = this.setOrderIndex(it.expr, node.schema, sop.first, vis);
        if (idx == null) throw at(E(104), it.expr);
        keys.push(keyOn(node.schema, idx, it.desc, `${node.schema[idx].name || '(No column name)'}`));
      }
      node = new Sort({ kid: node, keys });
      if (query.offset) node = this.offsetNode(node, query, outer);
    }
    return { node, info: { setop: true } };
  }

  // The result column an ORDER BY item of a set operation names, or null.
  setOrderIndex(expr, schema, first, vis) {
    const x = strip(expr);
    if (x.type === 'lit' && x.dt === 'int' && typeof x.v === 'number') {
      const n = x.v;
      if (!(n >= 1 && n <= vis.length)) throw at(E(108, n), expr);
      return vis[n - 1];
    }
    if (x.type === 'col' && x.parts.length === 1) {
      const nm = lower(x.parts[0]);
      const hits = vis.filter(i => lower(schema[i].name) === nm);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw at(E(209, x.parts[0]), expr);
    }
    if (first && first.items) {
      const k = exprKey(x);
      const j = first.items.findIndex(it => it && it.expr && exprKey(strip(it.expr)) === k);
      if (j >= 0 && j < vis.length) return vis[j];
    }
    return null;
  }

  // Plans the body of a set operation: {node, first: {items}} (the first branch's select items).
  planSetBody(body, outer, opts, dedupe = false) {
    const bopts = { kind: 'branch', branch: true, branchDistinct: dedupe && !this.noPushdown };
    if (body.type === 'core') {
      const b = new Block(this, body, outer, { ...bopts, query: null });
      const r = b.plan();
      return { node: r.node, first: { items: body.cols } };
    }
    if (body.type === 'query') {
      const r = this.planQuery(body, outer, bopts);
      return { node: r.node, first: { items: firstItems(body.body) } };
    }
    if (body.type !== 'setop') throw new TypeError(`planner: unknown query body ${body.type}`);
    // UNION, INTERSECT and EXCEPT push DISTINCT into the branches that qualify
    const own = !(body.op === 'UNION' && body.all);
    const left = this.planSetBody(body.left, outer, opts, own);
    const right = this.planSetBody(body.right, outer, opts, own);
    const lv = visibleCols(left.node.schema), rv = visibleCols(right.node.schema);
    if (lv.length !== rv.length) throw at(E(205), body);
    const node = body.op === 'UNION' && body.all ? this.concat([left.node, right.node]) : new SetOp({ op: body.op, all: false, left: left.node, right: right.node });
    return { node, first: left.first };
  }

  // UNION ALL of several inputs into one Concat (nested UNION ALLs are flattened).
  concat(kids) {
    const flat = [];
    for (const k of kids) {
      if (k.op === 'Concat' && !k._typed) flat.push(...k.kids);
      else flat.push(k);
    }
    const schema = setSchema(flat);
    const node = new Concat({ kids: flat, schema });
    return node;
  }

  // TOP/OFFSET helpers shared by blocks and set operations.
  offsetNode(node, query, outer) {
    const scope = { schema: [], parent: outer };
    const skip = this.countExpr(query.offset, scope);
    const take = query.fetch ? this.countExpr(query.fetch, scope) : null;
    return new Offset({ kid: node, skip, take });
  }

  // A TOP / OFFSET / FETCH count: a number when it folds, else the compiled expression (evaluated at run time).
  countExpr(expr, scope) {
    const c = this.compile(expr, scope, { clause: 'other' });
    if (c.isConst && !(c.plans && c.plans.length) && !c.pre) {
      const f = this.fold(c);
      if (f.ok && typeof f.value === 'number' && Number.isFinite(f.value) && (c.dt === 'int' || c.dt === 'bigint') && f.value >= 0) return f.value;
    }
    return c;
  }

  // FOR JSON / FOR XML (02 §3 phase 5, §6).
  forOutput(r, query, opts) {
    const fj = query.forJson, fx = query.forXml;
    const levels = fj && fj.mode === 'auto' ? r.levels : fx && fx.mode === 'auto' ? r.levels : null;
    if (fj) {
      if (fj.mode === 'auto' && (!levels || !levels.length)) throw at(E(13600), query);
      const node = new JsonOutput({ kid: r.node, mode: fj.mode, root: fj.root ?? null, includeNulls: !!fj.includeNulls, noArray: !!fj.withoutArrayWrapper, levels: levels || undefined });
      return { node, info: { forJson: true } };
    }
    if (fx.mode === 'auto' && (!levels || !levels.length)) throw at(E(6800), query);
    const node = new XmlOutput({ kid: r.node, mode: fx.mode, row: fx.row ?? null, root: fx.root ?? null, elements: fx.elements || null, type: !!fx.type, levels: levels || undefined, xmlns: this.xmlns() });
    if (node.planError) throw at(node.planError, query);
    return { node, info: { forXml: true } };
  }
}

// The visible column indexes of a schema.
function visibleCols(schema) {
  const out = [];
  for (let i = 0; i < schema.length; i++) if (!schema[i].hidden) out.push(i);
  return out;
}

// The select items of the first core of a query body.
function firstItems(body) {
  if (!body) return EMPTY;
  if (body.type === 'core') return body.cols;
  if (body.type === 'query') return firstItems(body.body);
  return firstItems(body.left);
}

// The schema of a UNION ALL: first branch names, common types, refs kept when identical (02 §3 phase 6).
function setSchema(kids) {
  const vis = kids.map(k => visibleCols(k.schema).map(i => k.schema[i]));
  const n = vis[0].length;
  for (const v of vis) if (v.length !== n) throw E(205);
  const out = [];
  for (let i = 0; i < n; i++) {
    let t = null, ref = vis[0][i].ref, attr = vis[0][i].attr, ci = false, coll = null;
    for (const v of vis) {
      const c = v[i];
      t = t ? commonType(t, c) : commonType(c, c.dt === 'null' ? { dt: 'int' } : c);
      if (!sameRef(ref, c.ref)) ref = undefined;
      if (attr !== c.attr) attr = undefined;
      if (c.ci_ai) ci = true;
      if (!coll && c.coll) coll = c.coll;
    }
    if (vis.every(v => v[i].dt === 'null')) t = { dt: 'int' };
    const colOut = { name: vis[0][i].name, qual: null, ...t };
    if (ref) colOut.ref = ref;
    if (attr) colOut.attr = attr;
    if (ci) colOut.ci_ai = true;
    if (coll && colOut.dt === 'string') colOut.coll = coll;
    out.push(colOut);
  }
  return out;
}

function sameRef(a, b) {
  if (!a || !b) return !a && !b;
  if (a.poly || b.poly) return !!a.poly && !!b.poly;
  return !!a.entity && a.entity === b.entity && !a.entityFn && !b.entityFn;
}

// A Sort key that reads one column of a schema (exec.js Key: Compiled & {desc}).
function keyOn(schema, idx, desc, text) {
  const c = schema[idx];
  const k = { fn: row => row[idx], pre: null, dt: c.dt, ref: c.ref, src: idx, isConst: false, name: c.name || '', text: text || c.name || '', plans: [], cols: [idx], outer: [], desc: !!desc };
  for (const f of ['prec', 'scale', 'len', 'dto', 'unicode', 'fixed', 'small', 'numeric']) if (c[f] != null) k[f] = c[f];
  if (c.coll) k.coll = c.coll;
  if (c.ci_ai) k.ci_ai = true;
  return k;
}

// A compiled read of one column (a Compiled for operators that take expressions).
function readCol(schema, idx, text) {
  const k = keyOn(schema, idx, false, text);
  delete k.desc;
  return k;
}

// EXISTS normalisation (02 §3 phase 3): the select list becomes a constant and ORDER BY / DISTINCT / a constant
// TOP n > 0 are dropped; TOP 0 makes it FALSE_EXISTS.
const FALSE_EXISTS = Object.freeze({ type: 'false-exists' });

function normalizeExists(query) {
  if (query.body.type !== 'core' || query.with || query.forJson || query.forXml) return query;
  const core = query.body;
  let top = core.top;
  if (top && !top.percent && !top.ties && top.expr && strip(top.expr).type === 'lit' && typeof strip(top.expr).v === 'number') {
    if (strip(top.expr).v === 0) return FALSE_EXISTS;
    top = null;
  } else if (top && top.percent && strip(top.expr).type === 'lit' && strip(top.expr).v === 0) return FALSE_EXISTS;
  if (core.groupBy || core.having || core.cols.some(it => it.expr && (hasAggregate(it.expr) || hasWindow(it.expr)))) {
    return { ...query, orderBy: top ? query.orderBy : null };
  }
  const out = {
    ...query,
    orderBy: top ? query.orderBy : null,
    offset: top ? query.offset : null,
    fetch: top ? query.fetch : null,
    body: { ...core, distinct: false, top, cols: core.cols, _exists: true },
  };
  if (query[KIND_KEY]) setKind(out, query[KIND_KEY]);
  return out;
}

// Whether a CTE references itself (a recursive CTE, 02 §3 phase 6).
function cteIsRecursive(c) {
  const nm = lower(c.name);
  let hit = false;
  walkAll(c.query, x => {
    if (!hit && x.type === 'table' && x.name && x.name.parts.length === 1 && lower(x.name.parts[0]) === nm) hit = true;
  });
  return hit;
}

// ================================================================================================ references

// The column names a statement references (column pruning, 02 §3 phase 8): unqualified names, qualified
// 'qualifier.name' pairs, select-list and column-list aliases (never pruning hints) and the star qualifiers.
function referencedNames(root) {
  const any = new Set(), qual = new Set(), aliases = new Set();
  const SQLCOL = /sql:column\(\s*["']([^"']+)["']\s*\)/g;
  walkAll(root, n => {
    if (n.type === 'col' && Array.isArray(n.parts) && n.parts.length) {
      const name = lower(n.parts[n.parts.length - 1]);
      if (n.parts.length >= 2) qual.add(lower(n.parts[n.parts.length - 2]) + '.' + name);
      else any.add(name);
    } else if (n.type === 'xmlmethod') {
      for (const a of n.args || EMPTY) {
        if (a && a.type === 'lit' && typeof a.v === 'string') {
          for (const m of a.v.matchAll(SQLCOL)) {
            const parts = m[1].split('.');
            const name = lower(parts[parts.length - 1]);
            if (parts.length >= 2) qual.add(lower(parts[parts.length - 2]) + '.' + name);
            else any.add(name);
          }
        }
      }
    }
    if (n.alias && typeof n.alias === 'string' && n.expr) aliases.add(lower(n.alias));
    if (Array.isArray(n.columns)) for (const c of n.columns) if (typeof c === 'string') aliases.add(lower(c));
  });
  return { any, qual, aliases };
}

// ================================================================================================ blocks

// One query block (02 §3): FROM binding, WHERE, GROUP BY, HAVING, windows, SELECT, DISTINCT, ORDER BY, TOP/OFFSET,
// INTO, with the pushdown of §4 into its FetchScans.
class Block {
  constructor(P, core, outer, opts = {}) {
    this.P = P;
    this.core = core;
    this.outer = outer || null;
    this.opts = opts;
    this.query = opts.query || null;
    this.leaves = [];
    this.exposed = [];
    this.warnings = [];
  }

  get meta() { return this.P.meta; }

  // ----------------------------------------------------------------------------------------- FROM binding

  // Binds the FROM clause into the rel tree and the block layout (02 §3 phase 2); the scope of the block's
  // expressions is {schema: layout, parent: outer}.
  bind(from) {
    this.leaves = [];
    this.exposed = [];
    this.layout = null;
    this.used = new Set();
    this.rel = from ? this.bindSource(from, null) : null;
    this.checkExposed();
    this.layout = [];
    for (const leaf of this.leaves) {
      leaf.start = this.layout.length;
      for (const c of shiftSchema(leaf.cols, leaf.start)) this.layout.push(c);
    }
    this.leafAt = new Array(this.layout.length);
    for (const leaf of this.leaves) for (let i = 0; i < leaf.cols.length; i++) this.leafAt[leaf.start + i] = leaf;
    this.scope = this.blockScope(this.layout, 0);
    // the analysis scope: the same columns, but its compiles mark nothing as read (a conjunct that becomes a
    // FetchXML condition needs no attribute)
    this.aScope = { schema: this.layout, parent: this.outer };
  }

  // A scope over block columns from `base` on (its compiles mark the columns they read, 02 §3 phase 8).
  blockScope(schema, base, parent = this.outer) {
    const s = { schema, parent };
    Object.defineProperty(s, 'block', { value: this, enumerable: false });
    if (typeof base === 'function') Object.defineProperty(s, 'base', { get: base, enumerable: false });
    else Object.defineProperty(s, 'base', { value: base, enumerable: false });
    return s;
  }

  // The number of layout columns (before binding: every leaf bound so far).
  layoutSize() {
    if (this.layout) return this.layout.length;
    let n = 0;
    for (const l of this.leaves) n += l.cols.length;
    return n;
  }

  // Marks layout columns as read (star items, hidden outputs).
  markUsed(index) {
    if (index >= 0) this.used.add(index);
  }

  // 1011 / 1012 / 1013 for duplicate exposed names in one FROM (02 §3 phase 2).
  checkExposed() {
    const seen = new Map();
    for (const x of this.exposed) {
      const prev = seen.get(x.name);
      if (!prev) { seen.set(x.name, x); continue; }
      if (prev.aliased && x.aliased) throw at(E(1011, x.written), x.node);
      if (prev.aliased !== x.aliased) {
        const a = prev.aliased ? prev : x, t = prev.aliased ? x : prev;
        throw at(E(1012, a.written, t.written), a.node);
      }
      throw at(E(1013, prev.written, x.written), x.node);
    }
  }

  // Registers a source's exposed name (alias, else its last name part).
  expose(alias, written, aliased, node) {
    this.exposed.push({ name: lower(alias), written, aliased, node });
  }

  // Binds one table source; leftScope is the scope of an APPLY's left input (null elsewhere).
  bindSource(ts, leftScope) {
    switch (ts.type) {
      case 'table': return this.bindTable(ts, leftScope);
      case 'derived': return this.bindDerived(ts, leftScope);
      case 'values': return this.bindValues(ts, leftScope);
      case 'tvf': return this.bindTvf(ts, leftScope);
      case 'xmlnodes': return this.bindXmlNodes(ts, leftScope);
      case 'pivot': return this.bindPivot(ts, leftScope);
      case 'unpivot': return this.bindUnpivot(ts, leftScope);
      case 'join': return this.bindJoin(ts, leftScope);
      default: throw new TypeError(`planner: unknown table source ${ts.type}`);
    }
  }

  bindJoin(ts, leftScope) {
    if (ts.kind === 'cross apply' || ts.kind === 'outer apply') {
      const left = this.bindSource(ts.left, leftScope);
      // the right side sees the left input's columns (its local layout) as its outer scope
      const lcols = [];
      for (const l of left.leaves) for (const c of shiftSchema(l.cols, lcols.length)) lcols.push(c);
      const first = left.leaves[0];
      const scope = this.blockScope(lcols, () => (first ? first.start : 0), leftScope || this.outer);
      const t = this.P.tracked(scope, () => this.bindSource(ts.right, scope));
      const right = t.result;
      // the left columns the right side reads: NestedLoop's memo key (null when the body has NEWID())
      const nondet = right.leaves.some(l => l.ast && (l.ast.query ? queryHasNewid(l.ast.query) : someExpr(l.ast.e || {}, isNewid)));
      const memo = nondet ? null : t.refs.filter(r => r.k === 0).map(r => r.index);
      return { type: 'apply', kind: ts.kind === 'cross apply' ? 'cross' : 'outer', left, right, node: ts, leaves: [...left.leaves, ...right.leaves], leftScope: scope, memo };
    }
    const left = this.bindSource(ts.left, leftScope);
    const right = this.bindSource(ts.right, leftScope);
    return { type: 'join', kind: ts.kind, left, right, on: ts.on || null, node: ts, comma: !!ts.comma, leaves: [...left.leaves, ...right.leaves] };
  }

  // A rel leaf for a bound source.
  addLeaf(leaf) {
    leaf.id = ++leafSeq;
    if (!leaf.nonNull) leaf.nonNull = new Set();
    leaf.start = this.layoutSize();
    this.leaves.push(leaf);
    return { type: 'leaf', leaf, leaves: [leaf] };
  }

  // A table name: Dataverse table (dbo., archive., bin.), metadata.* / sys.*, #temp, @table or a CTE.
  bindTable(ts, leftScope) {
    const o = objName(ts.name);
    const written = ts.alias || o.last;
    const alias = lower(written);
    this.expose(alias, written, !!ts.alias, ts);
    const hints = (ts.hints || EMPTY).map(h => String(h).toUpperCase());
    const noLock = hints.includes('NOLOCK');
    if (o.parts.length > 2) return this.missing(ts, alias, written, E(208, o.parts.join('.')));
    if (o.last.startsWith('#')) return this.bindTemp(ts, o, alias, written);
    if (o.last.startsWith('@')) return this.bindTableVar(ts, o, alias, written);
    if (o.parts.length === 1) {
      const def = this.P.cte(o.last);
      if (def) return this.bindCte(ts, def, alias, written, leftScope, hints);
    }
    const schema = o.schema;
    if (schema === 'metadata' || schema === 'sys') {
      const d = findMetaTable(schema, o.last);
      if (!d) return this.missing(ts, alias, written, E(208, o.parts.join('.')));
      return this.bindMeta(ts, d, alias, written);
    }
    if (schema && !['dbo', 'archive', 'bin'].includes(schema)) return this.missing(ts, alias, written, E(208, o.parts.join('.')));
    const ent = this.entity(o.lastLower, ts, o);
    if (!ent) return this.missing(ts, alias, written, null);
    const dsrc = schema === 'archive' ? 'retained' : schema === 'bin' ? 'bin' : null;
    if (dsrc === 'retained' && !ent.isRetentionEnabled && !ent.isArchivalEnabled) throw at(plain(`Table ${ent.logicalName} has no long term retention data.`), ts);
    if (dsrc === 'bin') {
      const set = this.P.pf.recycle;
      if (set && !set.has(ent.logicalName)) throw at(plain(`Table ${ent.logicalName} has no recycle bin data: the recycle bin is not enabled for it.`), ts);
    }
    return this.addLeaf(this.dvLeaf(ent, alias, written, ts, dsrc, noLock));
  }

  // The loaded EntityInfo of a table name, or null after collecting its 208 (prefetch kept the error).
  entity(name, ts, o) {
    const meta = this.meta;
    const ent = meta && meta.entitySync ? meta.entitySync(name) : null;
    if (ent && ent.attrs) return ent;
    const err = this.P.pf.errors.get(name);
    if (err) {
      if (err instanceof SqlError) {
        const e = new SqlError(err.message);
        for (const k of ['number', 'severity', 'state', 'suggestions', 'code']) if (err[k] !== undefined) e[k] = err[k];
        if (e.number === 208 || /Invalid object name/.test(e.message)) {
          e.number = 208;
          const m = msg(208, o.parts.join('.'));
          e.message = err.message.startsWith(m.message) ? err.message : m.message + (err.message.replace(/^Invalid object name '[^']*'\./, '') || '');
          e.severity = m.severity;
        }
        this.P.fail(e, ts.name || ts);
        return null;
      }
      throw err;
    }
    const known = meta && meta.findEntity ? meta.findEntity(name) : null;
    if (known) throw new Error(`Internal error: the metadata of '${known.logicalName}' was not loaded before planning (call planQuery, which prefetches it).`);
    const e = E(208, o.parts.join('.'));
    const names = meta && meta.entities ? meta.entities().map(x => x.logicalName) : [];
    const sugg = suggest(o.last, names);
    if (sugg.length) e.suggestions = sugg;
    this.P.fail(e, ts.name || ts);
    return null;
  }

  // A placeholder leaf for a source that failed to bind (its error is collected): no columns.
  missing(ts, alias, written, err) {
    if (err) this.P.fail(err, ts.name || ts);
    this.P.missingAliases.add(alias);
    return this.addLeaf({ kind: 'node', alias, written, ast: ts, cols: [], node: new ConstantScan({ schema: [], rows: [] }), missing: true });
  }

  // ------------------------------------------------------------------------------------- Dataverse leaves

  // A Dataverse table leaf (01 §6.3, 02 §3 phase 8): the referenced columns, the star columns, the hidden primary
  // key, the companions of lookup, choice, bool and BigInt columns, and the DML selection columns of ctx.dml.
  dvLeaf(ent, alias, written, ts, dsrc, noLock) {
    const P = this.P;
    const cat = catalogue(ent, P.columnOrder);
    const R = P.refs;
    const picks = new Map();
    const order = [];
    const pick = (def, visible, role) => {
      if (!def) return;
      let p = picks.get(def);
      if (!p) {
        picks.set(def, (p = { def, visible: false, role: null }));
        order.push(p);
      }
      if (visible) p.visible = true;
      if (role) p.role = role;
    };
    const star = this.starFor(alias);
    if (star) for (const d of cat.star) pick(d, true);
    for (const [n, d] of cat.byName) if (R.any.has(n) || R.qual.has(alias + '.' + n)) pick(d, true);
    // did-you-mean: a name no table of the statement has gets its closest columns (suggestions)
    for (const n of R.any) {
      if (cat.byName.has(n) || R.aliases.has(n)) continue;
      for (const s of suggest(n, [...cat.byName.keys()]).slice(0, 3)) pick(cat.byName.get(lower(s)), true);
    }
    pick(cat.pk, false);
    const dml = P.dml && lower(P.dml.alias) === alias ? P.dml : null;
    if (dml) {
      for (const n of ['versionnumber', 'partitionid', 'activitytypecode', 'statecode', 'statuscode']) {
        const d = cat.byName.get(n);
        if (d) pick(d, false, n === 'versionnumber' ? 'etag' : null);
      }
    }
    if (this.opts.outermost && !this.grouped && !this.core.distinct && !this.leaves.length) pick(cat.byName.get('versionnumber'), false);
    // companions of the picked base columns (names, types; BigInt digits)
    for (const p of [...order]) {
      const d = p.def;
      if (d.kind !== 'attr') continue;
      const a = d.attr;
      if (LOOKUP_TYPES.has(a.type) || OPTION_TYPES.has(a.type)) {
        const comp = companionsOf(cat, a.logicalName);
        pick(comp.name, false);
        if (LOOKUP_TYPES.has(a.type) && comp.type) pick(comp.type, false);
      }
    }
    const cols = [], defs = [];
    const indexOf = new Map();
    for (const p of order) {
      const d = p.def;
      const c = { name: d.name, qual: alias, ...d.type, attr: d.attr };
      if (d.kind === 'name') c.role = 'name';
      else if (d.kind === 'type') c.role = 'type';
      if (d.ref) c.ref = d.ref;
      if (!p.visible) c.hidden = true;
      if (p.role) c.role = p.role;
      if (d === cat.pk && dml) c.role = PK_ROLE;
      indexOf.set(d, cols.length);
      cols.push(c);
      defs.push(d);
    }
    // BigInt columns: a hidden role-'name' companion with the FormattedValue digits (02 §5)
    for (let i = 0, n = cols.length; i < n; i++) {
      const d = defs[i];
      if (d.kind === 'attr' && d.attr.type === 'BigInt') {
        indexOf.set({ big: d }, cols.length);
        cols.push({ name: d.name + 'name', qual: alias, ...NAME_T, attr: d.attr, role: 'name', hidden: true });
        defs.push({ name: d.name + 'name', kind: 'name', attr: d.attr, real: null, type: NAME_T, bigName: true });
        cols[i] = { ...cols[i], companion: { name: cols.length - 1 } };
      }
    }
    for (let i = 0; i < cols.length; i++) {
      const d = defs[i];
      if (d.kind !== 'attr' || !(LOOKUP_TYPES.has(d.attr.type) || OPTION_TYPES.has(d.attr.type))) continue;
      const comp = companionsOf(cat, d.attr.logicalName);
      const companion = {};
      if (comp.name && indexOf.has(comp.name)) companion.name = indexOf.get(comp.name);
      if (comp.type && indexOf.has(comp.type)) companion.type = indexOf.get(comp.type);
      if (Object.keys(companion).length) cols[i] = { ...cols[i], companion };
    }
    const pkIdx = indexOf.get(cat.pk);
    const leaf = { kind: 'dv', alias, written, ast: ts, cols, defs, entity: ent, cat, dsrc, noLock, pkIdx: pkIdx ?? -1 };
    leaf.starIdx = star ? cat.star.map(d => indexOf.get(d)) : null;
    leaf.nonNull = new Set(pkIdx != null ? [pkIdx] : []);
    return leaf;
  }

  // Whether a `*` or `alias.*` of this block (or a star the planner expands for this alias) covers the source.
  starFor(alias) {
    const cols = this.core && this.core.cols;
    if (!cols) return false;
    for (const it of cols) {
      if (!it.star) continue;
      if (!it.qualifier || lower(it.qualifier) === alias) return true;
    }
    return !!(this.opts.starAll);
  }

  // ------------------------------------------------------------------------------------- other leaves

  // A leaf over a planned node: its visible and hidden columns, qualified by the alias.
  nodeLeaf(node, alias, written, ts, extra = {}) {
    const cols = node.schema.map(c => {
      const { srcKey, ...rest } = c;
      return { ...rest, qual: alias };
    });
    return { kind: 'node', alias, written, ast: ts, cols, node, nonNull: new Set(), ...extra };
  }

  bindTemp(ts, o, alias, written) {
    const temps = this.P.ctx.temps || (this.P.ctx.session && this.P.ctx.session.temps) || null;
    const t = temps && typeof temps.get === 'function' ? temps.get(o.lastLower) : null;
    if (!t) return this.missing(ts, alias, written, E(208, o.last));
    const schema = (t.columns || EMPTY).map(c => tableColumn(c));
    const node = new TempScan({ name: t.name || o.last, schema });
    return this.addLeaf({ ...this.nodeLeaf(node, alias, written, ts), materialized: true });
  }

  bindTableVar(ts, o, alias, written) {
    const vars = this.P.rt.vars;
    const v = vars && typeof vars.get === 'function' ? vars.get(o.lastLower) : null;
    if (!v || !v.table) throw at(E(1087, o.last), ts.name || ts);
    const schema = (v.table.columns || EMPTY).map(c => tableColumn(c));
    const node = new TempScan({ name: o.lastLower, schema });
    return this.addLeaf({ ...this.nodeLeaf(node, alias, written, ts), materialized: true });
  }

  bindMeta(ts, d, alias, written) {
    const cols = metaColumns(d.full, alias);
    const R = this.P.refs;
    const star = this.starFor(alias);
    // column pruning: MetaScan requests only the properties of its schema columns
    let keep = cols.filter(c => star || R.any.has(lower(c.name)) || R.qual.has(alias + '.' + lower(c.name)));
    if (!keep.length) keep = cols.slice(0, 1);
    const node = new MetaScan({ table: d.full, schema: keep.map(c => ({ ...c, qual: null })), meta: this.meta, api: this.P.ctx.api });
    const leaf = { ...this.nodeLeaf(node, alias, written, ts), materialized: true, metaTable: d };
    leaf.starIdx = star ? cols.map(c => keep.indexOf(c)).filter(i => i >= 0) : null;
    const mid = keep.findIndex(c => lower(c.name) === 'metadataid');
    if (mid >= 0 && d.schema === 'metadata') leaf.nonNull.add(mid);
    return this.addLeaf(leaf);
  }

  // A CTE reference: recursive (RecursiveCte) or a derived table of its own (02 §3 phase 6).
  bindCte(ts, def, alias, written, leftScope, hints) {
    const P = this.P;
    if (def.working) {
      // the recursive reference inside the CTE's own recursive member: the working table (env.work)
      if (hints.length) throw at(E(4150, def.name), ts);
      def.workRefs = (def.workRefs || 0) + 1;
      const schema = def.workSchema.map(c => ({ ...c }));
      const node = new TempScan({ name: lower(def.name), schema });
      return this.addLeaf({ ...this.nodeLeaf(node, alias, written, ts), work: def });
    }
    def.refs++;
    const r = def.recursive ? P.planRecursiveCte(def, this.outer, ts) : P.withCteScope(def, () => P.planQuery(def.query, leftScope || this.outer, { kind: 'cte', derived: true, dmlAlias: alias }));
    const node = this.namedNode(r.node, def.columns, def.name, ts);
    const leaf = this.nodeLeaf(node, alias, written, ts, { cte: def, levels: r.levels, nonNull: r.nonNull || new Set(), info: r.info });
    leaf.correlated = !!leftScope;
    return this.addLeaf(leaf);
  }

  bindDerived(ts, leftScope) {
    const written = ts.alias;
    const alias = lower(written);
    this.expose(alias, written, true, ts);
    const scope = leftScope || this.outer;
    const r = this.P.planQuery(ts.query, scope, { kind: leftScope ? 'apply' : 'derived', derived: true, dmlAlias: alias });
    const node = this.namedNode(r.node, ts.columns, written, ts);
    const leaf = this.nodeLeaf(node, alias, written, ts, { derived: true, nonNull: r.nonNull || new Set(), info: r.info });
    leaf.correlated = !!leftScope;
    return this.addLeaf(leaf);
  }

  // Names the visible columns of a derived table, CTE or VALUES source (01 §6.1: 8155, 8156, 8158, 8159).
  namedNode(node, columns, name, ts) {
    const vis = visibleCols(node.schema);
    if (columns) {
      if (columns.length < vis.length) throw at(E(8158, name), ts);
      if (columns.length > vis.length) throw at(E(8159, name), ts);
    }
    const names = vis.map((i, j) => (columns ? columns[j] : node.schema[i].name));
    const seen = new Set();
    names.forEach((n, j) => {
      if (!n) throw at(E(8155, j + 1, name), ts);
      const k = lower(n);
      if (seen.has(k)) throw at(E(8156, n, name), ts);
      seen.add(k);
    });
    if (!columns || !(node instanceof PlanNode)) return node;
    if (vis.every((i, j) => node.schema[i].name === columns[j])) return node;
    const schema = node.schema.slice();
    vis.forEach((i, j) => { schema[i] = { ...schema[i], name: columns[j] }; });
    return renamed(node, schema);
  }

  bindValues(ts, leftScope) {
    const written = ts.alias;
    const alias = lower(written);
    this.expose(alias, written, true, ts);
    const scope = { schema: [], parent: leftScope || this.outer };
    const rows = ts.rows.map(r => r.map(x => this.P.compile(x, scope, { clause: 'other' })));
    const n = rows[0] ? rows[0].length : 0;
    const types = [];
    for (let j = 0; j < n; j++) {
      let t = null;
      for (const r of rows) t = t ? commonType(t, r[j]) : (r[j].dt === 'null' ? { dt: 'null' } : commonType(r[j], r[j]));
      if (!t || t.dt === 'null') t = { dt: 'int' };
      types.push(t);
    }
    const names = ts.columns || new Array(n).fill('');
    if (ts.columns && ts.columns.length !== n) throw at(E(ts.columns.length < n ? 8158 : 8159, written), ts);
    const schema = types.map((t, j) => {
      const c = { name: names[j] || '', qual: null, ...t };
      const refs = rows.map(r => r[j].ref);
      if (refs.every(x => sameRef(refs[0], x)) && refs[0] && refs[0].entity) c.ref = refs[0];
      return c;
    });
    this.namedNode({ schema }, ts.columns, written, ts);
    let node;
    const allConst = rows.every(r => r.every(c => c.isConst && !(c.plans && c.plans.length) && !c.pre));
    if (allConst) {
      const folded = [];
      let ok = true;
      for (const r of rows) {
        const out = [];
        for (let j = 0; j < n; j++) {
          const f = this.P.fold(r[j]);
          if (!f.ok) {
            if (f.error && f.error instanceof SqlError) throw f.error;
            ok = false;
            break;
          }
          out.push(f.value == null ? null : coerceTo(f.value, r[j], types[j], this.P.rt));
        }
        if (!ok) break;
        folded.push(out);
      }
      if (ok) node = new ConstantScan({ schema, rows: folded, detail: `VALUES (${digits(rows.length)} rows)` });
    }
    if (!node) {
      const one = new ConstantScan({ schema: [], rows: [[]] });
      const kids = rows.map(r => {
        const ps = projectSchema([], r, r.map(() => ''));
        return new Project({ kid: one, exprs: r, schema: ps.schema.map((c, j) => ({ ...c, name: names[j] || '' })), extra: ps.extra });
      });
      node = new Concat({ kids, schema });
    }
    const leaf = this.nodeLeaf(node, alias, written, ts, { materialized: allConst });
    leaf.correlated = !!leftScope;
    return this.addLeaf(leaf);
  }

  // A table-valued function: STRING_SPLIT, OPENJSON, GENERATE_SERIES, sys.fn_helpcollations(), or a Web API
  // function (ApiFnScan, 02 §9 response shapes).
  bindTvf(ts, leftScope) {
    const parts = ts.name.parts.map(String);
    const nameUp = parts[parts.length - 1].toUpperCase();
    const written = ts.alias || parts[parts.length - 1];
    const alias = lower(written);
    this.expose(alias, written, !!ts.alias, ts);
    const scope = { schema: [], parent: leftScope || this.outer };
    let def = null;
    if (parts.length === 2 && lower(parts[0]) === 'sys') {
      def = sysFunction(parts[1]);
      if (!def) throw at(E(208, parts.join('.')), ts.name);
    } else if (parts.length === 1 || (parts.length === 2 && lower(parts[0]) === 'dbo')) def = TVFS.get(nameUp) || null;
    if (!def) return this.bindApiFn(ts, parts, alias, written, scope, leftScope);
    lookupFunction(def.name, ts.args.length, { written: lower(parts[parts.length - 1]) });
    const args = ts.args.map(a => this.P.compile(a, scope, { clause: 'other' }));
    const consts = [];
    for (const i of def.consts || EMPTY) {
      if (args[i] && args[i].isConst) {
        const f = this.P.fold(args[i]);
        if (f.ok) consts[i] = f.value;
      }
    }
    const withSchema = ts.withSchema || null;
    const colsT = def.columns(args, consts, withSchema, ts.args);
    const names = ts.columns && ts.columns.length ? ts.columns : null;
    if (names && names.length !== colsT.length) throw at(E(names.length < colsT.length ? 8158 : 8159, written), ts);
    const schema = colsT.map((c, j) => ({ ...c, name: names ? names[j] : c.name, qual: null }));
    const node = new TvfScan({ def, args, schema, consts, withSchema });
    const leaf = this.nodeLeaf(node, alias, written, ts, { tvf: true });
    leaf.correlated = !!leftScope;
    return this.addLeaf(leaf);
  }

  // `x.nodes('path') [AS] t(c)`: a TvfScan over XML_NODES, as a FROM item or an APPLY right side.
  bindXmlNodes(ts, leftScope) {
    const written = ts.alias;
    const alias = lower(written);
    this.expose(alias, written, true, ts);
    const scope = { schema: [], parent: leftScope || this.outer };
    const c = this.P.compile(ts.e, scope, { clause: 'other' });
    if (!c.bound) throw at(plain('nodes() needs an xml or string operand.'), ts.e);
    const path = this.P.compile(ts.e.args[0], scope, { clause: 'other' });
    const column = ts.columns[0];
    const schema = XML_NODES.columns([c.operand, path], [], { column }).map(x => ({ ...x, qual: null }));
    const node = new TvfScan({ def: XML_NODES, args: [c.operand, path], schema, opts: { column, bound: c.bound, xmlns: this.P.xmlns() } });
    const leaf = this.nodeLeaf(node, alias, written, ts, { tvf: true });
    leaf.correlated = !!leftScope;
    return this.addLeaf(leaf);
  }

  // A Web API function as a TVF (02 §9): kind 'function' required; its response shape decides the columns.
  bindApiFn(ts, parts, alias, written, scope, leftScope) {
    const P = this.P;
    const name = parts[parts.length - 1];
    const meta = this.meta;
    const msgs = (meta && meta.messagesSync && meta.messagesSync()) || P.pf.messages;
    const m = msgs && typeof msgs.get === 'function' ? msgs.get(lower(name)) : null;
    if (!m) {
      if (P.pf.messagesError) throw P.pf.messagesError;
      const e = E(208, parts.join('.'));
      const names = [];
      if (msgs) for (const v of msgs.values()) if (v.kind === 'function') names.push(v.name);
      const sugg = suggest(name, names);
      if (sugg.length) e.suggestions = sugg;
      throw at(e, ts.name);
    }
    if (m.kind !== 'function') throw at(plain(`'${m.name}' is an action; run it with EXEC.`), ts.name);
    const params = m.params || EMPTY;
    let args = ts.args.map(a => P.compile(a, scope, { clause: 'other' }));
    let bound = null;
    if (m.binding === 'entity' || (m.boundTo && m.binding !== 'collection')) {
      // a record-bound function takes the record as its first argument (a lookup or CREATELOOKUP)
      const ent = meta.findEntity ? meta.findEntity(m.boundTo) : null;
      if (!args.length) throw at(E(313, lower(m.name)), ts);
      bound = { entitySet: ent ? ent.entitySetName : `${m.boundTo}s`, id: args[0] };
      args = args.slice(1);
    } else if (m.binding === 'collection') {
      const ent = meta.findEntity ? meta.findEntity(m.boundTo) : null;
      bound = { entitySet: ent ? ent.entitySetName : `${m.boundTo}s`, id: null };
    }
    const required = params.filter(p => !p.optional).length;
    const last = params[params.length - 1];
    const variadic = !!last && (last.type === 'StringArray' || String(last.type || '').endsWith('[]'));
    if (args.length < required) throw at(E(313, lower(m.name)), ts);
    if (args.length > params.length && !variadic) throw at(E(8144, lower(m.name)), ts);
    const shape = apiShape(m, meta);
    const names = ts.columns && ts.columns.length ? ts.columns : null;
    if (names && names.length !== shape.schema.length) throw at(E(names.length < shape.schema.length ? 8158 : 8159, written), ts);
    const schema = shape.schema.map((c, j) => ({ ...c, name: names ? names[j] : c.name }));
    const node = new ApiFnScan({ name: m.name, args, schema, msg: m, bound, shape: shape.shape, prop: shape.prop, mapRow, api: P.ctx.api || null });
    const leaf = this.nodeLeaf(node, alias, written, ts, { tvf: true, api: true });
    leaf.correlated = !!leftScope;
    return this.addLeaf(leaf);
  }

  // PIVOT (01 §4.3): the source's visible columns grouped by every column except the aggregate's argument and the
  // FOR column, one output column per IN value.
  bindPivot(ts, leftScope) {
    const P = this.P;
    const written = ts.alias;
    const alias = lower(written);
    this.expose(alias, written, true, ts);
    const src = P.planQuery(starQuery(ts.source), leftScope || this.outer, { kind: 'derived', derived: true, starAll: true });
    const kid = src.node;
    const vis = visibleCols(kid.schema);
    const sscope = { schema: kid.schema, parent: leftScope || this.outer };
    const agg = ts.agg;
    const up = upName(agg);
    const entry = AGGREGATES.get(up);
    if (!entry || agg.star) throw at(E(102, '*'), agg);
    const aggArgs = (agg.args || EMPTY).map(a => P.compile(a, sscope, { clause: 'other' }));
    const forC = P.compile(ts.forCol, sscope, { clause: 'other' });
    if (forC.src == null) throw at(plain('The FOR column of PIVOT must be a column of the source.'), ts.forCol);
    const used = new Set([forC.src]);
    for (const a of aggArgs) if (a.src != null) used.add(a.src);
    const keys = vis.filter(i => !used.has(i));
    const forT = { dt: forC.dt, len: forC.len, unicode: forC.unicode, prec: forC.prec, scale: forC.scale };
    const values = ts.values.map(v => {
      try {
        return coerceTo(v.v, { dt: 'string', len: String(v.v).length, unicode: true }, forT, P.rt);
      } catch (e) {
        throw at(e, ts);
      }
    });
    const consts = [];
    for (const i of entry.consts || EMPTY) if (aggArgs[i] && aggArgs[i].isConst) { const f = P.fold(aggArgs[i]); if (f.ok) consts[i] = f.value; }
    const outT = entry.dt(aggArgs, consts);
    const schema = [...keys.map(i => ({ ...kid.schema[i], hidden: false, companion: undefined })), ...ts.values.map(v => ({ name: v.name, qual: null, ...outT }))]
      .map(c => { const { companion, srcKey, ...rest } = c; return rest; });
    const node = new Pivot({ kid, keys, pivot: forC.src, values, agg: { def: entry, args: aggArgs, consts, distinct: !!agg.distinct }, schema });
    return this.addLeaf(this.nodeLeaf(node, alias, written, ts, { pivot: true }));
  }

  // UNPIVOT (01 §4.3): the kept columns, then the value column, then the FOR column (nvarchar), one row per non-NULL
  // value; the unpivoted columns must share a type (8167).
  bindUnpivot(ts, leftScope) {
    const P = this.P;
    const written = ts.alias;
    const alias = lower(written);
    this.expose(alias, written, true, ts);
    const src = P.planQuery(starQuery(ts.source), leftScope || this.outer, { kind: 'derived', derived: true, starAll: true });
    const kid = src.node;
    const vis = visibleCols(kid.schema);
    const byName = name => {
      const n = lower(name);
      const i = vis.find(j => lower(kid.schema[j].name) === n);
      if (i === undefined) throw at(E(207, name), ts);
      return i;
    };
    const cols = ts.cols.map(byName);
    const t0 = kid.schema[cols[0]];
    for (const i of cols) {
      const t = kid.schema[i];
      if (t.dt !== t0.dt || (t.dt === 'string' && !!t.unicode !== !!t0.unicode)) throw at(plain(`The type of column "${t.name}" conflicts with the type of other columns specified in the UNPIVOT list.`), ts);
    }
    const colSet = new Set(cols);
    const keep = vis.filter(i => !colSet.has(i));
    let vt = null;
    for (const i of cols) vt = vt ? commonType(vt, kid.schema[i]) : commonType(kid.schema[i], kid.schema[i]);
    const strip2 = c => { const { companion, srcKey, ...rest } = c; return rest; };
    const schema = [...keep.map(i => strip2({ ...kid.schema[i] })), { name: ts.valueCol, qual: null, ...vt }, { name: ts.forCol, qual: null, dt: 'string', len: 128, unicode: true }];
    const node = new Unpivot({ kid, keep, cols, names: ts.cols.map(String), schema });
    return this.addLeaf(this.nodeLeaf(node, alias, written, ts, { unpivot: true }));
  }
}

// A Column of a #temp table or table variable (01 §4.1: its declared type), for a TempScan schema.
function tableColumn(c) {
  const out = { name: c.name, qual: null };
  if (c.dt) {
    for (const k of ['dt', 'prec', 'scale', 'len', 'dto', 'unicode', 'fixed', 'small', 'numeric', 'coll']) if (c[k] != null) out[k] = c[k];
  } else if (c.dataType) Object.assign(out, dtOf(c.dataType, 1));
  else out.dt = 'any';
  if (c.ref) out.ref = c.ref;
  return out;
}

// A node with another schema (same rows): a Project of every column when the names differ.
function renamed(node, schema) {
  const exprs = schema.map((c, i) => readCol(node.schema, i, c.name));
  return new Project({ kid: node, exprs, schema: schema.map(c => ({ ...c })), extra: [], detail: 'rename columns' });
}

// `SELECT * FROM <source>` for PIVOT / UNPIVOT sources.
function starQuery(source) {
  return {
    type: 'query', with: null, xmlns: null, orderBy: null, offset: null, fetch: null,
    body: { type: 'core', distinct: false, top: null, cols: [{ star: true, pos: source.pos, end: source.end }], into: null, from: source, where: null, groupBy: null, having: null, pos: source.pos, end: source.end },
  };
}

// Converts a value of static type `from` into type `to` with types.coerce (env: tz and dateformat).
function coerceTo(v, from, to, env) {
  if (v == null) return null;
  if (from.dt === to.dt && from.dt !== 'string' && from.dt !== 'decimal' && from.dt !== 'datetime') return v;
  return coerce(v, from, to, env || {});
}

// The response shape and schema of a Web API function TVF (02 §9 shapes (a)-(e)).
function apiShape(m, meta) {
  const resp = m.response || EMPTY;
  const isEntityType = t => !!t && !!(meta && meta.entitySync && meta.entitySync(lower(t)));
  const fieldType = t => {
    switch (t) {
      case 'Guid': return { dt: 'guid' };
      case 'Boolean': return { dt: 'bit' };
      case 'Integer': case 'Picklist': return { dt: 'int' };
      case 'BigInt': return { dt: 'bigint' };
      case 'Decimal': case 'Money': return { dt: 'decimal', prec: 38, scale: 10 };
      case 'Float': return { dt: 'float' };
      case 'DateTime': return { dt: 'datetime' };
      case 'Date': return { dt: 'date' };
      case 'String': default: return { dt: 'string', len: -1, unicode: true };
    }
  };
  const entityCols = ent => {
    const cat = catalogue(ent);
    const cols = [], idx = new Map();
    for (const d of cat.star) {
      idx.set(d, cols.length);
      const c = { name: d.name, qual: null, ...d.type, attr: d.attr };
      if (d.kind === 'name') c.role = 'name';
      if (d.kind === 'type') c.role = 'type';
      if (d.ref) c.ref = d.ref;
      cols.push(c);
    }
    for (let i = 0; i < cols.length; i++) {
      const d = cat.star[i];
      if (d.kind !== 'attr') continue;
      const comp = companionsOf(cat, d.attr.logicalName);
      const companion = {};
      if (comp.name && idx.has(comp.name)) companion.name = idx.get(comp.name);
      if (comp.type && idx.has(comp.type)) companion.type = idx.get(comp.type);
      if (Object.keys(companion).length) cols[i] = { ...cols[i], companion };
    }
    return cols;
  };
  // (a) the whole answer is an entity (responseEntity), or one property holds an entity / an entity collection
  if (m.responseEntity && m.responseEntity !== 'expando' && m.responseEntity !== 'Entity' && isEntityType(m.responseEntity)) {
    return { shape: 'entity', prop: '', schema: entityCols(meta.entitySync(lower(m.responseEntity))) };
  }
  for (const p of resp) {
    const t = String(p.type || '');
    const base = t.replace(/\[\]$/, '');
    if (/^AuditDetail(Collection)?$/.test(t)) {
      const ent = meta && meta.entitySync ? meta.entitySync('audit') : null;
      const cols = ent ? entityCols(ent) : [];
      cols.push({ name: 'oldvalues', qual: null, dt: 'string', len: -1, unicode: true }, { name: 'newvalues', qual: null, dt: 'string', len: -1, unicode: true });
      return { shape: 'audit', prop: p.name, schema: cols };
    }
    if (isEntityType(base)) return { shape: 'entity', prop: p.name, schema: entityCols(meta.entitySync(lower(base))) };
  }
  // (d) an array of scalars; (c) an object of an unknown type
  for (const p of resp) {
    const t = String(p.type || '');
    if (t === 'StringArray' || (t.endsWith('[]') && SCALAR_TYPES.has(t.slice(0, -2)))) {
      return { shape: 'array', prop: p.name, schema: [{ name: p.name, qual: null, ...fieldType(t === 'StringArray' ? 'String' : t.slice(0, -2)), srcKey: p.name }] };
    }
    if (!SCALAR_TYPES.has(t)) {
      return { shape: 'object', prop: p.name, schema: [{ name: p.name, qual: null, dt: 'string', len: -1, unicode: true, json: true }] };
    }
  }
  // (e) scalar properties only: one row
  return { shape: 'scalar', prop: null, schema: resp.map(p => ({ name: p.name, qual: null, ...fieldType(p.type), srcKey: p.name })) };
}

const SCALAR_TYPES = new Set(['Guid', 'Boolean', 'Integer', 'Picklist', 'BigInt', 'Decimal', 'Money', 'Float', 'DateTime', 'Date', 'String', 'Time', 'Duration', 'Binary']);

// ================================================================================================ FetchXML builder

const T_FALSE = Object.freeze({ t: 'false' });
const T_TRUE = Object.freeze({ t: 'true' });
const NEG_OP = new Map([['eq', 'ne'], ['ne', 'eq'], ['lt', 'ge'], ['ge', 'lt'], ['gt', 'le'], ['le', 'gt'], ['like', 'not-like'], ['not-like', 'like'],
  ['in', 'not-in'], ['not-in', 'in'], ['null', 'not-null'], ['not-null', 'null'], ['begins-with', 'not-begin-with'], ['not-begin-with', 'begins-with'],
  ['ends-with', 'not-end-with'], ['not-end-with', 'ends-with'], ['under', 'not-under'], ['not-under', 'under'], ['contain-values', 'not-contain-values'],
  ['not-contain-values', 'contain-values'], ['eq-userid', 'ne-userid'], ['ne-userid', 'eq-userid'], ['eq-businessid', 'ne-businessid'], ['ne-businessid', 'eq-businessid']]);
const CMP_OPS = new Map([['=', 'eq'], ['<>', 'ne'], ['<', 'lt'], ['<=', 'le'], ['>', 'gt'], ['>=', 'ge']]);
const MIRROR = new Map([['eq', 'eq'], ['ne', 'ne'], ['lt', 'gt'], ['le', 'ge'], ['gt', 'lt'], ['ge', 'le']]);
const NEEDS_NOT_NULL = new Set(['ne', 'not-like', 'not-in', 'not-begin-with', 'not-end-with', 'not-under', 'not-contain-values', 'ne-userid', 'ne-businessid']);
const MAX_LINKS = 15;
const MAX_CONDS = 500;
const RELATIVE_KINDS = new Set(['date', 'fiscal']);

// A simplified AND / OR item list (TRUE and FALSE folded).
function mkFilter(type, items) {
  const out = [];
  for (const it of items) {
    if (!it) return null;
    if (it.t === 'false') { if (type === 'and') return T_FALSE; continue; }
    if (it.t === 'true') { if (type === 'or') return T_TRUE; continue; }
    if (it.t === 'f' && it.type === type) out.push(...it.items);
    else out.push(it);
  }
  if (!out.length) return type === 'and' ? T_TRUE : T_FALSE;
  if (out.length === 1) return out[0];
  return { t: 'f', type, items: out };
}

// Counts the conditions and links of an item tree (the 500 condition+link limit, 02 §4.2).
function countItems(it) {
  if (!it) return 0;
  if (it.t === 'f') return it.items.reduce((n, x) => n + countItems(x), 0);
  if (it.t === 'link') return 1 + (it.items || EMPTY).reduce((n, x) => n + countItems(x), 0);
  if (it.t === 'c') return 1;
  return 0;
}

// The pushdown model of one FetchScan (02 §4): the folded leaves, the join edges between them, the root conditions,
// the orders and the pushed TOP / page / DISTINCT / aggregate, built into a Fetch when the plan is materialised.
class FB {
  constructor(B, leaf) {
    this.B = B;
    this.P = B.P;
    this.leaves = [leaf];
    this.edges = [];
    this.items = [];
    this.linkItems = new Map();
    this.nullable = new Set();
    this.orders = null;
    this.top = null;
    this.page = null;
    this.count = null;
    this.distinct = false;
    this.rawOrder = false;
    this.agg = null;
    this.residual = [];
    this.warnings = [];
    this.client = [];
    this.virtualKeep = [];
    this.root = leaf;
    this.semis = [];
    this.keyCols = null;
    this.valueofConjs = [];
  }

  get first() { return this.leaves[0]; }
  get kind() { return this.first.entity.kind; }
  has(leaf) { return this.leaves.includes(leaf); }
  isAudit() { return this.leaves.some(l => l.entity.logicalName === 'audit'); }
  linkCount() { return this.leaves.length - 1 + this.semis.length; }

  // Whether another plain Dataverse leaf may fold into this fetch (02 §4.1 never-fold rules).
  // eq: {mine, theirs} attribute names of the join equality (the new leaf's and this fetch's).
  canFoldWith(leaf, eq) {
    const a = this.first, b = leaf;
    if (this.P.noPushdown) return false;
    if (this.agg || this.top != null || this.distinct) return false;
    if (a.entity.kind === 'elastic' || b.entity.kind === 'elastic') return false;
    if (a.dsrc || b.dsrc) return false;
    if (a.entity.kind === 'virtual' || b.entity.kind === 'virtual') {
      if (a.entity.kind !== b.entity.kind || a.entity.dataProviderId !== b.entity.dataProviderId) return false;
    }
    if (this.linkCount() + 1 > MAX_LINKS) return false;
    // audit (02 §4.6): one link at most, from audit.userid or audit.callinguserid to systemuser.systemuserid
    const audit = this.leaves.find(l => l.entity.logicalName === 'audit') || (b.entity.logicalName === 'audit' ? b : null);
    if (audit) {
      if (this.leaves.length > 1) return false;
      const other = audit === b ? a : b;
      if (other.entity.logicalName !== 'systemuser' || !eq) return false;
      const auditAttr = audit === b ? eq.mine : eq.theirs, userAttr = audit === b ? eq.theirs : eq.mine;
      if (!['userid', 'callinguserid'].includes(auditAttr) || userAttr !== 'systemuserid') return false;
    }
    return true;
  }

  // Folds a leaf joined by the equality a.aAttr = b.bAttr (type 'inner' or 'outer'; for outer, b is the NULL-supplying
  // side); linkItems are the ON conjuncts on b alone (its link filter).
  fold(a, aAttr, b, bAttr, type, linkItems) {
    this.leaves.push(b);
    this.leaves.sort((x, y) => x.start - y.start);
    this.edges.push({ a, aAttr, b, bAttr, type });
    if (type === 'outer') this.nullable.add(b);
    if (linkItems && linkItems.length) this.linkItems.set(b, linkItems);
  }

  // Chooses the FetchXML root: the leaf that leaves the fewest toMany links, ties to the first table written;
  // an outer edge keeps its preserved side as the parent, and no inner link nests under an outer one.
  chooseRoot() {
    if (!this.edges.length) {
      this.treeOf = { parent: new Map(), toMany: 0 };
      return (this.root = this.first);
    }
    let best = null;
    for (const r of this.leaves) {
      const t = this.tree(r);
      if (!t) continue;
      if (!best || t.toMany < best.toMany) best = { r, ...t };
    }
    this.root = best ? best.r : this.first;
    this.treeOf = best || this.tree(this.first);
    return this.root;
  }

  // The link tree rooted at r: {parent: Map<leaf, {leaf, edge}>, toMany} or null when r breaks a nesting rule.
  tree(r) {
    const parent = new Map();
    const seen = new Set([r]);
    const queue = [r];
    const outerBelow = new Set();
    let toMany = 0;
    while (queue.length) {
      const x = queue.shift();
      for (const e of this.edges) {
        let child = null, from = null, to = null;
        if (e.a === x && !seen.has(e.b)) { child = e.b; from = e.bAttr; to = e.aAttr; }
        else if (e.b === x && !seen.has(e.a)) {
          if (e.type === 'outer') return null;
          child = e.a; from = e.aAttr; to = e.bAttr;
        }
        if (!child) continue;
        if (e.type === 'inner' && outerBelow.has(x)) return null;
        seen.add(child);
        const pk = lower(child.entity.primaryIdAttribute);
        const many = lower(from) !== pk;
        if (many) toMany++;
        parent.set(child, { from, to, type: e.type, parent: x, toMany: many });
        if (e.type === 'outer' || outerBelow.has(x)) outerBelow.add(child);
        queue.push(child);
      }
    }
    if (seen.size !== this.leaves.length) return null;
    return { parent, toMany };
  }

  // Whether the folded links multiply rows (a toMany inner/outer link exists).
  hasToMany() {
    if (!this.treeOf) this.chooseRoot();
    return !!this.treeOf && this.treeOf.toMany > 0;
  }

  // Whether a leaf is reached from the root through INNER links only.
  innerChain(leaf) {
    if (!this.treeOf) this.chooseRoot();
    for (let x = leaf; x !== this.root;) {
      const p = this.treeOf.parent.get(x);
      if (!p || p.type !== 'inner') return false;
      x = p.parent;
    }
    return true;
  }

  // Whether a leaf is the root or an N:1 link (its `from` is the linked table's primary key) reached through N:1 links.
  manyToOne(leaf) {
    if (!this.treeOf) this.chooseRoot();
    for (let x = leaf; x !== this.root;) {
      const p = this.treeOf.parent.get(x);
      if (!p || p.toMany) return false;
      x = p.parent;
    }
    return true;
  }

  // ------------------------------------------------------------------------------------------- the Fetch

  // The FetchXML link alias of every non-root leaf (02 §4.1: the lower-cased SQL alias when it is a plain
  // identifier of at most 30 characters and unique, else l1, l2, …).
  aliases() {
    if (this.aliasMap) return this.aliasMap;
    if (!this.treeOf) this.chooseRoot();
    const m = new Map(), used = new Set();
    let n = 0;
    const next = () => { let a; do a = `l${++n}`; while (used.has(a)); return a; };
    const order = this.leaves.filter(l => l !== this.root);
    for (const l of order) {
      const a = l.alias;
      const name = IDENT.test(a) && a.length <= 30 && !used.has(a) && a !== this.root.entity.logicalName ? a : null;
      const pick = name || next();
      used.add(pick);
      m.set(l, pick);
    }
    for (const s of this.semis) {
      const pick = next();
      used.add(pick);
      s.alias = pick;
    }
    this.aliasMap = m;
    return m;
  }

  // The FetchXML entityname of a leaf's condition (null for the root).
  entityName(leaf) {
    return leaf === this.root ? null : this.aliases().get(leaf) || null;
  }

  // An item tree in FetchXML model form (02 §4 Filter / Condition / Link).
  itemXml(it, at) {
    switch (it.t) {
      case 'f': return { type: it.type, items: it.items.map(x => this.itemXml(x, at)) };
      case 'c': {
        let leaf = it.leaf, attr = it.attr, op = it.op, vo = it.valueof || null;
        // a column comparison is written on the node its filter belongs to, the other column as alias.attr
        if (vo && vo.leaf !== leaf && leaf !== at && vo.leaf === at) {
          [leaf, attr, vo] = [vo.leaf, vo.attr, { leaf: it.leaf, attr: it.attr }];
          op = MIRROR.get(op) || op;
        }
        const c = { entityname: leaf === at ? null : this.entityName(leaf), attr, op };
        if (it.values !== undefined) c.values = it.values;
        else if (it.value !== undefined) c.value = it.value;
        if (it.valueType) c.valueType = it.valueType;
        if (vo) c.valueof = vo.leaf === leaf ? vo.attr : `${this.entityName(vo.leaf)}.${vo.attr}`;
        return c;
      }
      case 'link': return this.semiXml(it);
      default: throw new TypeError(`planner: unknown filter item ${it.t}`);
    }
  }

  // Whether every column comparison (valueof) of an item tree can be written in the filter of node `at` (root:
  // the root filter): the attribute on `at` (or both on one link) and the other column on `at` or a link alias.
  valueofOk(it, at = this.root) {
    if (!it) return true;
    if (it.t === 'f') return it.items.every(x => this.valueofOk(x, at));
    if (it.t !== 'c' || !it.valueof) return true;
    const a = it.leaf, b = it.valueof.leaf;
    if (a === b) return true;
    if (a === at) return b !== this.root || b === at;
    if (b === at) return a !== this.root;
    return false;
  }

  semiXml(s) {
    const link = { name: s.entity, from: s.from, to: s.to, alias: s.alias || null, linkType: s.linkType, attrs: [], all: false, filter: null, orders: [], links: [], toMany: false };
    if (s.items && s.items.length) link.filter = { type: 'and', items: s.items.map(x => this.innerXml(x)) };
    return link;
  }

  // A condition of a semi-join link's own filter (its table's attributes, no entityname).
  innerXml(it) {
    if (it.t === 'f') return { type: it.type, items: it.items.map(x => this.innerXml(x)) };
    if (it.t === 'link') return this.semiXml(it);
    const c = { entityname: null, attr: it.attr, op: it.op };
    if (it.values !== undefined) c.values = it.values;
    else if (it.value !== undefined) c.value = it.value;
    if (it.valueType) c.valueType = it.valueType;
    if (it.valueof) c.valueof = it.valueof.attr;
    return c;
  }

  // The requested attributes of a leaf: the base attributes of its columns (name/type companions read
  // annotations; BigInt digits come with the value); audit objectid also requests objecttypecode.
  attrsOf(leaf) {
    const names = this.attrNames(leaf);
    return [...names].map(name => ({ name }));
  }

  // The attribute names a leaf needs: the base attributes of the columns the plan reads (name/type companions read
  // annotations of their base); the primary key without pushdown (04 §4); audit objectid also requests
  // objecttypecode; a pushed DISTINCT exactly its distinct attributes.
  attrNames(leaf) {
    if (this.attrOnly) return new Set(this.attrOnly.get(leaf) || EMPTY);
    const used = this.B.used;
    const names = new Set();
    leaf.defs.forEach((d, i) => {
      if (!d || !d.attr) return;
      if (used && !used.has(leaf.start + i)) return;
      names.add(d.attr.logicalName);
    });
    if (this.P.noPushdown && leaf.entity.primaryIdAttribute) names.add(lower(leaf.entity.primaryIdAttribute));
    if (leaf.entity.logicalName === 'audit' && (names.has('objectid'))) names.add('objecttypecode');
    return names;
  }

  // Whether every readable attribute of the leaf is requested (then <all-attributes/>, 02 §3 phase 8).
  needsAll(leaf) {
    if (!leaf.starIdx || this.attrOnly) return false;
    const want = this.attrNames(leaf);
    const readable = leaf.entity.attrList.filter(a => a.validForRead !== false && !a.attributeOf && !NO_STAR.has(a.type));
    return readable.length > 0 && readable.every(a => want.has(a.logicalName));
  }

  // The Fetch model (02 §4) of this builder.
  toFetch() {
    if (!this.treeOf) this.chooseRoot();
    const root = this.root;
    const al = this.aliases();
    const P = this.P;
    const fx = {
      entity: root.entity.logicalName, top: this.top, count: this.count, page: this.page, distinct: !!this.distinct,
      aggregate: !!this.agg, useraworderby: !!this.rawOrder, options: P.fetchOptions || undefined,
      noLock: this.leaves.some(l => l.noLock) || undefined, datasource: root.dsrc || undefined,
      attrs: [], all: false, filter: null, orders: [], links: [],
    };
    if (!fx.options) delete fx.options;
    if (!fx.noLock) delete fx.noLock;
    if (!fx.datasource) delete fx.datasource;
    const nodeOf = new Map();
    const fill = (leaf, node) => {
      nodeOf.set(leaf, node);
      if (this.agg) node.attrs = this.agg.attrs.filter(a => a.leaf === leaf).map(({ leaf: _l, ...a }) => a);
      else if (this.needsAll(leaf)) node.all = true;
      else node.attrs = this.attrsOf(leaf, false);
    };
    fill(root, fx);
    // links in layout order of their parents (breadth-first)
    const kids = new Map();
    for (const [child, p] of this.treeOf.parent) {
      if (!kids.has(p.parent)) kids.set(p.parent, []);
      kids.get(p.parent).push(child);
    }
    const build = parent => {
      const node = nodeOf.get(parent);
      for (const child of (kids.get(parent) || EMPTY).sort((x, y) => x.start - y.start)) {
        const p = this.treeOf.parent.get(child);
        const link = { name: child.entity.logicalName, from: p.from, to: p.to, alias: al.get(child), linkType: p.type, attrs: [], all: false, filter: null, orders: [], links: [], toMany: p.toMany };
        fill(child, link);
        const li = this.linkItems.get(child);
        if (li && li.length) {
          const f = mkFilter('and', li);
          if (f.t === 'false') link.filter = { type: 'and', items: [{ entityname: null, attr: p.from, op: 'null' }] };
          else if (f.t !== 'true') link.filter = { type: 'and', items: (f.t === 'f' && f.type === 'and' ? f.items : [f]).map(x => this.itemXml(x, child)) };
        }
        node.links.push(link);
        build(child);
      }
    };
    build(root);
    // semi-join links: inside the link of their correlation leaf when it is an inner chain, else at the root
    const rootItems = [];
    for (const it of this.items) rootItems.push(it);
    for (const s of this.semis) {
      const at = s.outerLeaf;
      const home = at !== root && this.innerChain(at) ? nodeOf.get(at) : fx;
      if (home === fx) rootItems.push(s);
      else if (s.linkType === 'in' || s.linkType === 'exists') home.links.push(this.semiXml(s));
      else home.filter = { type: 'and', items: [...(home.filter ? home.filter.items : EMPTY), { type: 'and', items: [this.semiXml(s)] }] };
    }
    const exists = rootItems.filter(it => it.t === 'link' && (it.linkType === 'in' || it.linkType === 'exists'));
    const conds = rootItems.filter(it => !(it.t === 'link' && (it.linkType === 'in' || it.linkType === 'exists')));
    for (const s of exists) fx.links.push(this.semiXml(s));
    const f = mkFilter('and', conds);
    if (f && f.t !== 'true' && f.t !== 'false') {
      const items = f.t === 'f' && f.type === 'and' ? f.items : [f];
      fx.filter = { type: 'and', items: items.map(x => this.itemXml(x, root)) };
    }
    if (this.orders) {
      for (const o of this.orders) {
        if (o.alias) fx.orders.push({ alias: o.alias, desc: !!o.desc });
        else fx.orders.push({ attr: o.attr, entityname: o.leaf === root ? null : al.get(o.leaf), desc: !!o.desc });
      }
    }
    return fx;
  }

  // The FetchScan schema: the leaves' columns in layout order with their response keys (02 §5).
  scanSchema() {
    const al = this.aliases();
    const out = [];
    const offset = this.leaves[0].start;
    for (const leaf of this.leaves) {
      const prefix = leaf === this.root ? '' : al.get(leaf) + '.';
      const shifted = shiftSchema(leaf.cols, leaf.start - offset);
      shifted.forEach((c, i) => {
        const d = leaf.defs[i];
        const key = d && d.attr ? d.attr.logicalName : c.name;
        out.push({ ...c, srcKey: prefix + key });
      });
    }
    return out;
  }
}

// ================================================================================================ condition translation

// Translates WHERE / ON conjuncts into FetchXML conditions of a builder (02 §4.2). A translation returns an item
// (condition, filter, TRUE or FALSE) or null when the conjunct stays client side.
class Translator {
  constructor(B, fb, scope) {
    this.B = B;
    this.P = B.P;
    this.fb = fb;
    this.scope = scope || B.scope;
    this.meta = B.P.meta;
  }

  // The FB column a column reference names: {leaf, def, col} (null when it is not a column of a folded leaf, or an
  // outer reference).
  column(node) {
    const x = strip(node);
    if (!x || x.type !== 'col') return null;
    let r;
    try {
      r = resolveColumn(x.parts, this.scope, null, x);
    } catch {
      return null;
    }
    if (!r || r.depth !== 0) return null;
    const leaf = this.B.leafAt[r.index];
    if (!leaf || leaf.kind !== 'dv' || !this.fb.has(leaf)) return null;
    const def = leaf.defs[r.index - leaf.start];
    if (!def) return null;
    return { leaf, def, col: r.column, index: r.index };
  }

  // A value operand (no column of this block): {v, t} for a plan-time constant, {c, t} for a run-time parameter
  // (outer references, uncorrelated subqueries), null otherwise.
  value(node) {
    const x = strip(node);
    if (!x) return null;
    if (x.type === 'lit' && x.dt === 'null') return { v: null, t: { dt: 'null' }, isNull: true };
    let c;
    try {
      c = this.P.compile(x, this.scope, { clause: 'where', errors: [] });
    } catch {
      return null;
    }
    if (c.dt === 'any' && c.fn && c.cols && c.cols.length) return null;
    if (c.cols && c.cols.length) return null;
    if (c.isConst && !c.pre && !(c.plans && c.plans.length)) {
      const f = this.P.fold(c);
      if (f.ok) return { v: f.value, t: c, isNull: f.value == null };
      return null;
    }
    if (this.P.explainOnly && c.plans && c.plans.length) return null;
    return { c, t: c };
  }

  // The FetchXML attribute a condition on a column reads, with its static type: base attributes and real name
  // attributes of lookups; null when the column cannot be pushed (02 §4.2 Constants, never-pushed types).
  target(colRef, op) {
    const { leaf, def } = colRef;
    const ent = leaf.entity;
    if (def.bigName) return null;
    const audit = ent.logicalName === 'audit';
    if (def.kind === 'attr') {
      const a = def.attr;
      if (NEVER_PUSH.has(a.type) || a.type === 'Virtual') return null;
      if (a.type === 'MultiSelectPicklist' && !['null', 'not-null', 'contain-values', 'not-contain-values'].includes(op)) return null;
      if (audit && (a.logicalName === 'changedata' || a.logicalName === 'objectidname')) return null;
      if (audit && a.logicalName === 'attributemask' && !['like', 'not-like'].includes(op)) return null;
      return { attr: a.logicalName, a, type: def.type, kind: 'attr' };
    }
    if (def.kind === 'name') {
      const base = def.attr;
      if (LOOKUP_TYPES.has(base.type)) {
        if (!def.real || def.real === base) return null;
        if (audit && def.real.logicalName === 'objectidname') return null;
        return { attr: def.real.logicalName, a: def.real, type: { dt: 'string', len: -1, unicode: true }, kind: 'lookupname' };
      }
      if (CHOICE_TYPES.has(base.type)) return { attr: base.logicalName, a: base, type: { dt: 'string', len: -1, unicode: true }, kind: 'label', real: def.real };
      return null;
    }
    if (def.kind === 'type') {
      const slot = companionsOf(leaf.cat, def.attr.logicalName);
      const real = slot.type && slot.type.real && slot.type.real.type === 'EntityName' ? slot.type.real : null;
      if (!real) return null;
      return { attr: real.logicalName, a: real, type: { dt: 'string', len: 64, unicode: true }, kind: 'otc' };
    }
    return null;
  }

  // Whether SQL Server converts the value (not the column) when comparing them (02 §4.2 Constants).
  convertible(val, colType) {
    const vt = val.t;
    if (!vt || vt.dt === 'null' || vt.dt === 'any') return vt && vt.dt !== 'any';
    if (colType.dt === 'string' && vt.dt !== 'string') return false;
    if (colType.dt === 'guid' && !(vt.dt === 'string' || vt.dt === 'guid')) return false;
    if (vt.dt === 'binary' && (colType.dt === 'int' || colType.dt === 'bigint')) return true;
    // bit = 0 / 1: SQL Server converts the column to int, which matches the same rows as comparing the bit, so the
    // condition is still sent to Dataverse (isdisabled = 0); any other number stays in the browser (never equal).
    if (colType.dt === 'bit' && (vt.dt === 'int' || vt.dt === 'bigint') && val.v != null && (Number(val.v) === 0 || Number(val.v) === 1)) return true;
    return precedence(vt) <= precedence(colType);
  }

  // A plan-time constant converted into the column's type (raises the conversion error at plan time, 02 §4.2);
  // the value as given for run-time parameters.
  convert(val, tgt, colRef) {
    if (val.c) return { value: val.c, valueType: null };
    if (val.v == null) return { value: null };
    const T = tgt.type;
    let v = val.v;
    try {
      if (val.t.dt === 'binary' && (T.dt === 'int' || T.dt === 'bigint')) {
        v = castValue(v, val.t, { name: 'bigint', args: [] }, { tz: this.P.rt.tz });
        return { value: v, valueType: { dt: 'bigint' } };
      }
      if (T.dt === 'int' || T.dt === 'bigint' || T.dt === 'bit' || T.dt === 'decimal' || T.dt === 'money' || T.dt === 'float') {
        if (typeof v === 'number') return { value: v, valueType: { dt: Number.isInteger(v) ? 'int' : 'float' } };
        if (typeof v === 'boolean') return { value: v ? 1 : 0, valueType: { dt: 'int' } };
        if (val.t.dt === 'string') {
          // a string compared with a number converts to the column's type (245 / 8114 at plan time)
          const conv = coerce(v, val.t, T.dt === 'bit' ? { dt: 'bit' } : T, this.P.rt);
          return { value: conv, valueType: T.dt === 'bit' ? { dt: 'int' } : T };
        }
        return { value: v, valueType: val.t };
      }
      if (T.dt === 'guid') {
        const conv = val.t.dt === 'guid' ? v : coerce(v, val.t, { dt: 'guid' }, this.P.rt);
        return { value: String(conv).toLowerCase(), valueType: { dt: 'guid' } };
      }
      if (T.dt === 'datetime' || T.dt === 'date') {
        if (v instanceof Date) return { value: v, valueType: val.t.dt === 'date' ? { dt: 'date' } : { dt: 'datetime' } };
        const conv = coerce(v, val.t, T.dt === 'date' ? { dt: 'date' } : { dt: 'datetime' }, this.P.rt);
        return { value: conv, valueType: T.dt === 'date' ? { dt: 'date' } : { dt: 'datetime' } };
      }
      if (T.dt === 'string') return { value: typeof v === 'string' ? v : String(v), valueType: { dt: 'string' } };
    } catch (e) {
      if (e instanceof SqlError && colRef && OPTION_TYPES.has(colRef.def.attr?.type) && colRef.def.kind === 'attr' && val.t.dt === 'string') {
        e.message += ` Use ${colRef.def.name}name to compare with labels.`;
      }
      throw e;
    }
    return { value: v, valueType: val.t };
  }

  // One condition item on a target with an operator and a value.
  cond(colRef, tgt, op, val) {
    const item = { t: 'c', leaf: colRef.leaf, attr: tgt.attr, op };
    if (val !== undefined) {
      const cv = this.convert(val, tgt, colRef);
      if (cv.value == null) return T_FALSE;
      if (typeof cv.value === 'string' && cv.value.length > 850) return null;
      item.value = cv.value;
      if (cv.valueType) item.valueType = cv.valueType;
    }
    return item;
  }

  notNull(colRef, tgt) {
    return { t: 'c', leaf: colRef.leaf, attr: tgt.attr, op: 'not-null' };
  }

  // The option values of a choice/bool column whose label satisfies test (02 §4.2 labels); null when the options
  // were not loaded.
  labelValues(colRef, test) {
    const base = colRef.def.attr;
    const opts = this.meta && this.meta.optionsSync ? this.meta.optionsSync(colRef.leaf.entity.logicalName, base.logicalName) : null;
    if (!opts) return null;
    const out = [];
    for (const o of opts) if (o.label != null && test(String(o.label))) out.push(o.value);
    return { values: out, labels: opts.map(o => o.label) };
  }

  // Translates one conjunct (or a sub-expression of an OR) to an item, or null.
  translate(x) {
    x = strip(x);
    if (!x) return null;
    switch (x.type) {
      case 'bin':
        if (x.op === 'AND') return mkFilter('and', [this.translate(x.l), this.translate(x.r)]);
        if (x.op === 'OR') {
          const parts = disjuncts(x).map(d => this.translate(d));
          if (parts.some(p => !p)) return null;
          return mkFilter('or', parts);
        }
        if (CMP_OPS.has(x.op)) return this.comparison(x.l, CMP_OPS.get(x.op), x.r, x);
        return null;
      case 'not': return this.negate(x.e);
      case 'isnull': {
        const c = this.column(x.e);
        if (!c) return null;
        const tgt = this.target(c, x.not ? 'not-null' : 'null');
        if (!tgt) return null;
        if (tgt.kind === 'label' || tgt.kind === 'otc') return { t: 'c', leaf: c.leaf, attr: c.def.attr.logicalName, op: x.not ? 'not-null' : 'null' };
        return { t: 'c', leaf: c.leaf, attr: tgt.attr, op: x.not ? 'not-null' : 'null' };
      }
      case 'between': return this.between(x);
      case 'in': return x.query ? this.semiItem(x, false) : this.inList(x);
      case 'like': return this.like(x);
      case 'distinctfrom': return this.distinctFrom(x);
      case 'fn':
        if (upName(x) === 'CONTAINS') return this.contains(x, false);
        return null;
      case 'exists': case 'quantified':
        return this.semiItem(x, false);
      case 'lit':
        return null;
      default:
        return null;
    }
  }

  // EXISTS / IN under OR or NOT: an `any` / `not any` link inside the filter (02 §4.2), when the subquery folds as a
  // semi-join link correlated on the FetchXML root.
  semiItem(node, neg) {
    const B = this.B;
    const ast = neg ? { type: 'not', e: node, pos: node.pos, end: node.end } : node;
    const d = B.decorrelate({ ast });
    if (!d) return null;
    if (d.constant !== undefined) return d.constant ? T_TRUE : T_FALSE;
    for (const l of d.outerLeaves) if (!this.fb.has(l)) return null;
    const it = B.semiLink(this.fb, d);
    if (!it || it.t === 'true' || it.t === 'false') return it || null;
    if (it.outerLeaf !== this.fb.root) return null;
    return { ...it, linkType: d.kind === 'semi' ? 'any' : 'not any' };
  }

  // NOT x: an inverted comparison (with the NULL rule) or De Morgan (02 §4.2).
  negate(e) {
    e = strip(e);
    if (e.type === 'not') return this.translate(e.e);
    if (e.type === 'bin' && e.op === 'AND') return mkFilter('or', [this.negate(e.l), this.negate(e.r)].map(p => p || null).some(p => !p) ? [null] : [this.negate(e.l), this.negate(e.r)]);
    if (e.type === 'bin' && e.op === 'OR') {
      const parts = disjuncts(e).map(d => this.negate(d));
      if (parts.some(p => !p)) return null;
      return mkFilter('and', parts);
    }
    if (e.type === 'bin' && CMP_OPS.has(e.op)) {
      const inv = { '=': '<>', '<>': '=', '<': '>=', '>=': '<', '>': '<=', '<=': '>' }[e.op];
      return this.translate({ ...e, op: inv });
    }
    if (e.type === 'isnull') return this.translate({ ...e, not: !e.not });
    if (e.type === 'between' || e.type === 'like' || (e.type === 'in' && !e.query) || e.type === 'distinctfrom') return this.translate({ ...e, not: !e.not });
    if (e.type === 'fn' && upName(e) === 'CONTAINS') return this.contains(e, true);
    if (e.type === 'exists' || (e.type === 'in' && e.query) || e.type === 'quantified') return this.semiItem(e, true);
    return null;
  }

  // col op value, value op col, col op col, and the date forms (YEAR(d) = y, CAST(d AS date) = c, DATETRUNC).
  comparison(l, op, r, node) {
    let lc = this.column(l), rc = this.column(r);
    if (lc && rc) return this.columnCompare(lc, op, rc);
    if (!lc && !rc) {
      const lf = this.dateForm(l), rf = lf ? null : this.dateForm(r);
      if (lf) return this.dateRange(lf, op, r);
      if (rf) return this.dateRange(rf, MIRROR.get(op), l);
      // col = fn(args): FetchXML condition functions and CURRENT_USER
      return null;
    }
    if (!lc) { [l, r] = [r, l]; lc = rc; op = MIRROR.get(op); }
    const rx = strip(r);
    if (rx.type === 'fn' && FETCH_CONDITIONS.has(upName(rx)) && op === 'eq') return this.conditionFn(lc, rx);
    if (rx.type === 'fn' && upName(rx) === 'CURRENT_USER' && (op === 'eq' || op === 'ne')) return this.currentUser(lc, op);
    const val = this.value(r);
    if (!val) return null;
    const tgt = this.target(lc, op);
    if (!tgt) return null;
    if (tgt.kind === 'label') return this.labelCompare(lc, tgt, op, val);
    if (tgt.kind === 'otc') return this.otcCompare(lc, tgt, op, [val]);
    if (val.isNull) return T_FALSE;
    if (!this.convertible(val, tgt.type)) return null;
    if (tgt.kind === 'lookupname' && val.t.dt !== 'string') return null;
    const item = this.cond(lc, tgt, op, val);
    if (!item || item.t === 'false') return item;
    return op === 'ne' ? mkFilter('and', [item, this.notNull(lc, tgt)]) : item;
  }

  // col1 op col2 on two folded columns: a valueof condition (02 §4.2; `<>` adds not-null on both).
  columnCompare(a, op, b) {
    const ta = this.target(a, op), tb = this.target(b, op);
    if (!ta || !tb || ta.kind !== 'attr' || tb.kind !== 'attr') return null;
    if (ta.type.dt !== tb.type.dt) return null;
    if (ta.type.dt === 'datetime' && (ta.a.behavior || 'UserLocal') !== (tb.a.behavior || 'UserLocal')) return null;
    if (a.leaf === b.leaf && ta.attr === tb.attr) return null;
    if (this.fb.isAudit() || this.fb.kind === 'virtual' || this.fb.kind === 'elastic') return null;
    const item = { t: 'c', leaf: a.leaf, attr: ta.attr, op, valueof: { leaf: b.leaf, attr: tb.attr } };
    if (op === 'ne') return mkFilter('and', [item, this.notNull(a, ta), this.notNull(b, tb)]);
    return item;
  }

  // xname compared with labels (02 §4.2): matching option values, or the name attribute without options.
  labelCompare(c, tgt, op, val) {
    if (val.c) return null;
    if (val.isNull) return T_FALSE;
    if (val.t.dt !== 'string') return null;
    if (op !== 'eq' && op !== 'ne') return null;
    const key = collKeyAIOf(String(val.v));
    const r = this.labelValues(c, s => collKeyAIOf(s) === key);
    return this.labelItems(c, tgt, op === 'eq' ? 'in' : 'not-in', r, [String(val.v)]);
  }

  // The items of a label comparison: `in` / `not-in` of the matching values (with base not-null for the negative
  // forms), a contradiction and a warning when nothing matches, the name attribute when options are not loaded.
  labelItems(c, tgt, op, r, written) {
    const base = c.def.attr;
    if (!r) {
      if (!tgt.real || op === 'like' || op === 'not-like') return null;
      const vals = written.map(v => ({ v, t: { dt: 'string' } }));
      if (op === 'in' || op === 'not-in') {
        if (vals.length === 1) {
          const item = { t: 'c', leaf: c.leaf, attr: tgt.real.logicalName, op: op === 'in' ? 'eq' : 'ne', value: written[0] };
          return op === 'in' ? item : mkFilter('and', [item, { t: 'c', leaf: c.leaf, attr: base.logicalName, op: 'not-null' }]);
        }
        const item = { t: 'c', leaf: c.leaf, attr: tgt.real.logicalName, op, values: written };
        return op === 'in' ? item : mkFilter('and', [item, { t: 'c', leaf: c.leaf, attr: base.logicalName, op: 'not-null' }]);
      }
      return null;
    }
    const nn = { t: 'c', leaf: c.leaf, attr: base.logicalName, op: 'not-null' };
    if (!r.values.length) {
      if (op === 'in' || op === 'like') {
        this.P.warn(`No ${c.def.name} label matches ${written.map(w => `'${w}'`).join(', ')}; the valid labels are ${r.labels.map(l => `'${l}'`).join(', ')}.`);
        return T_FALSE;
      }
      return nn;
    }
    const values = r.values.map(v => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
    if (op === 'in' || op === 'like') return { t: 'c', leaf: c.leaf, attr: base.logicalName, op: 'in', values };
    return mkFilter('and', [{ t: 'c', leaf: c.leaf, attr: base.logicalName, op: 'not-in', values }, nn]);
  }

  // xtype = 'account' (EntityName columns): object type codes from the metadata (Q26).
  otcCompare(c, tgt, op, vals) {
    if (vals.some(v => v.c)) return null;
    const codes = [];
    for (const v of vals) {
      if (v.isNull) continue;
      if (v.t.dt !== 'string') return null;
      const e = this.meta && this.meta.findEntity ? this.meta.findEntity(String(v.v)) : null;
      if (e && e.objectTypeCode != null) codes.push(e.objectTypeCode);
    }
    const neg = op === 'ne' || op === 'not-in';
    if (vals.some(v => v.isNull)) {
      if (neg) return T_FALSE;
      if (!codes.length) return T_FALSE;
    }
    if (!codes.length) return neg ? { t: 'c', leaf: c.leaf, attr: tgt.attr, op: 'not-null' } : T_FALSE;
    const item = codes.length === 1 ? { t: 'c', leaf: c.leaf, attr: tgt.attr, op: neg ? 'ne' : 'eq', value: codes[0] } : { t: 'c', leaf: c.leaf, attr: tgt.attr, op: neg ? 'not-in' : 'in', values: codes };
    return neg ? mkFilter('and', [item, { t: 'c', leaf: c.leaf, attr: tgt.attr, op: 'not-null' }]) : item;
  }

  // col = lastxdays(7) and the other FetchXML condition functions (01 §8, 02 §4.2).
  conditionFn(c, fnNode) {
    const fc = FETCH_CONDITIONS.get(upName(fnNode));
    const tgt = this.target(c, fc.op);
    if (!tgt || tgt.kind !== 'attr') return null;
    const args = fnNode.args || EMPTY;
    if (args.length < fc.min || args.length > fc.max) return null;
    const vals = [];
    for (const a of args) {
      const v = this.value(a);
      if (!v || v.c) return null;
      if (v.isNull) return T_FALSE;
      vals.push(v.v);
    }
    if (fc.kind === 'user' && this.fb.isAudit() && (tgt.attr === 'userid' || tgt.attr === 'callinguserid')) return null;
    if (RELATIVE_KINDS.has(fc.kind) && this.meta && this.meta.tzMatchesBrowser === false) {
      this.P.warn(`today()/lastxdays() are evaluated in your Dataverse time zone (${this.tzName()}), which differs from this browser's time zone.`);
    }
    if (this.fb.kind === 'virtual') this.P.warn(`The data provider for ${c.leaf.entity.logicalName} may ignore this filter.`);
    const item = { t: 'c', leaf: c.leaf, attr: tgt.attr, op: fc.op };
    if (fc.max === Infinity || vals.length > 1) item.values = vals.map(v => (v instanceof Date ? v : v));
    else if (vals.length === 1) {
      item.value = vals[0];
      if (vals[0] instanceof Date) item.valueType = { dt: 'date' };
    }
    if (vals.length > 1 || fc.max === Infinity) {
      item.values = vals;
      delete item.value;
    }
    return fc.negative ? mkFilter('and', [item, this.notNull(c, tgt)]) : item;
  }

  tzName() {
    const u = this.meta && this.meta.user;
    return (u && (u.tzName || (u.tzCode != null ? `time zone code ${u.tzCode}` : null))) || 'unknown';
  }

  // lookupOrPk = CURRENT_USER (02 §4.2): eq-userid / ne-userid + not-null.
  currentUser(c, op) {
    const tgt = this.target(c, op);
    if (!tgt || tgt.kind !== 'attr') return null;
    const a = tgt.a;
    const isUser = (LOOKUP_TYPES.has(a.type) && (a.targets || EMPTY).includes('systemuser')) || (a.isPk && c.leaf.entity.logicalName === 'systemuser');
    if (!isUser) return null;
    if (this.fb.isAudit() && (a.logicalName === 'userid' || a.logicalName === 'callinguserid')) return null;
    const item = { t: 'c', leaf: c.leaf, attr: a.logicalName, op: op === 'eq' ? 'eq-userid' : 'ne-userid' };
    return op === 'ne' ? mkFilter('and', [item, this.notNull(c, tgt)]) : item;
  }

  between(x) {
    const c = this.column(x.e);
    if (!c) {
      const f = this.dateForm(x.e);
      if (!f || x.not) return null;
      return mkFilter('and', [this.dateRange(f, 'ge', x.lo), this.dateRange(f, 'le', x.hi)]);
    }
    const lo = this.value(x.lo), hi = this.value(x.hi);
    if (!lo || !hi) return null;
    const tgt = this.target(c, 'ge');
    if (!tgt || tgt.kind !== 'attr') return null;
    if (lo.isNull || hi.isNull) {
      // x BETWEEN NULL AND b is unknown or false: a NOT BETWEEN with a NULL bound keeps the other bound's rows
      if (!x.not) return T_FALSE;
      if (lo.isNull && hi.isNull) return T_FALSE;
      return lo.isNull ? this.cond(c, tgt, 'gt', hi) : this.cond(c, tgt, 'lt', lo);
    }
    if (!this.convertible(lo, tgt.type) || !this.convertible(hi, tgt.type)) return null;
    if (x.not) return mkFilter('or', [this.cond(c, tgt, 'lt', lo), this.cond(c, tgt, 'gt', hi)]);
    return mkFilter('and', [this.cond(c, tgt, 'ge', lo), this.cond(c, tgt, 'le', hi)]);
  }

  // col [NOT] IN (list): `in` / `not-in` with NULL handling (02 §4.2), labels and type names too.
  inList(x) {
    const c = this.column(x.e);
    if (!c) {
      const f = this.dateForm(x.e);
      if (!f || x.not || f.fn !== 'YEAR') return null;
      return mkFilter('or', x.list.map(v => this.dateRange(f, 'eq', v)));
    }
    const vals = x.list.map(v => this.value(v));
    if (vals.some(v => !v)) return null;
    const tgt = this.target(c, x.not ? 'not-in' : 'in');
    if (!tgt) return null;
    if (tgt.kind === 'otc') return this.otcCompare(c, tgt, x.not ? 'not-in' : 'in', vals);
    if (tgt.kind === 'label') {
      if (vals.some(v => v.c || (!v.isNull && v.t.dt !== 'string'))) return null;
      const written = vals.filter(v => !v.isNull).map(v => String(v.v));
      if (x.not && vals.some(v => v.isNull)) return T_FALSE;
      if (!written.length) return x.not ? T_TRUE : T_FALSE;
      const keys = new Set(written.map(collKeyAIOf));
      const r = this.labelValues(c, s => keys.has(collKeyAIOf(s)));
      return this.labelItems(c, tgt, x.not ? 'not-in' : 'in', r, written);
    }
    if (vals.some(v => v.c)) return null;
    const nonNull = vals.filter(v => !v.isNull);
    if (x.not && nonNull.length !== vals.length) return T_FALSE;
    if (!nonNull.length) return x.not ? T_TRUE : T_FALSE;
    if (!nonNull.every(v => this.convertible(v, tgt.type))) return null;
    if (tgt.kind === 'lookupname' && nonNull.some(v => v.t.dt !== 'string')) return null;
    const values = [];
    let vt = null;
    for (const v of nonNull) {
      const cv = this.convert(v, tgt, c);
      if (cv.value == null) continue;
      if (typeof cv.value === 'string' && cv.value.length > 850) return null;
      values.push(cv.value);
      vt = vt || cv.valueType;
    }
    if (!values.length) return x.not ? T_TRUE : T_FALSE;
    const item = { t: 'c', leaf: c.leaf, attr: tgt.attr, op: x.not ? 'not-in' : 'in', values };
    if (vt) item.valueType = vt;
    if (values.length === 1) {
      item.op = x.not ? 'ne' : 'eq';
      item.value = values[0];
      delete item.values;
    }
    return x.not ? mkFilter('and', [item, this.notNull(c, tgt)]) : item;
  }

  // col [NOT] LIKE 'p' (no ESCAPE): String/Memo and lookup name attributes; choice/bool labels by pattern.
  like(x) {
    if (x.escape) return null;
    const c = this.column(x.e);
    if (!c) return null;
    const pv = this.value(x.pattern);
    if (!pv || pv.c) return null;
    if (pv.isNull) return T_FALSE;
    if (pv.t.dt !== 'string') return null;
    const tgt = this.target(c, x.not ? 'not-like' : 'like');
    if (!tgt) return null;
    const pattern = String(pv.v);
    if (tgt.kind === 'label') {
      const m = likeMatcherAI(pattern);
      const r = this.labelValues(c, s => m(s));
      return this.labelItems(c, tgt, x.not ? 'not-like' : 'like', r, [pattern]);
    }
    if (tgt.kind === 'otc') return null;
    const a = tgt.a;
    if (!(a.type === 'String' || a.type === 'Memo')) return null;
    if (pattern.length > 850) return null;
    if (/^[%_[]/.test(pattern)) this.P.warn(`The pattern '${pattern}' on ${c.def.name} starts with a wildcard, which Dataverse cannot index; the query may be slow or throttled.`);
    const item = { t: 'c', leaf: c.leaf, attr: tgt.attr, op: x.not ? 'not-like' : 'like', value: pattern };
    return x.not ? mkFilter('and', [item, this.notNull(c, tgt)]) : item;
  }

  // col IS [NOT] DISTINCT FROM value: eq / ne with the NULL fix-ups (02 §4.2).
  distinctFrom(x) {
    let c = this.column(x.l), other = x.r;
    if (!c) { c = this.column(x.r); other = x.l; }
    if (!c) return null;
    const v = this.value(other);
    if (!v || v.c) return null;
    const tgt = this.target(c, 'eq');
    if (!tgt || tgt.kind !== 'attr') return null;
    if (v.isNull) return { t: 'c', leaf: c.leaf, attr: tgt.attr, op: x.not ? 'null' : 'not-null' };
    if (!this.convertible(v, tgt.type)) return null;
    // IS NOT DISTINCT FROM c = (col = c); IS DISTINCT FROM c = (col <> c OR col IS NULL) = FetchXML ne
    return this.cond(c, tgt, x.not ? 'eq' : 'ne', v);
  }

  // CONTAINS(multiselect, '1 OR 2') / NOT CONTAINS (02 §4.2).
  contains(x, not) {
    const args = x.args || EMPTY;
    if (args.length !== 2) return null;
    const c = this.column(args[0]);
    if (!c || c.def.kind !== 'attr' || c.def.attr.type !== 'MultiSelectPicklist') return null;
    const v = this.value(args[1]);
    if (!v || v.c || v.isNull || v.t.dt !== 'string') return null;
    const parts = String(v.v).split(/\s+OR\s+/i).map(s => s.trim().replace(/^"(.*)"$/, '$1'));
    if (!parts.length || !parts.every(p => /^-?\d+$/.test(p))) return null;
    const item = { t: 'c', leaf: c.leaf, attr: c.def.attr.logicalName, op: not ? 'not-contain-values' : 'contain-values', values: parts.map(Number) };
    return not ? mkFilter('and', [item, { t: 'c', leaf: c.leaf, attr: c.def.attr.logicalName, op: 'not-null' }]) : item;
  }

  // YEAR(d) / MONTH(d) / DAY(d) / CAST(d AS date) / CONVERT(date, d) / DATETRUNC(unit, d) on a folded DateTime
  // column: {fn, c, unit} (null otherwise).
  dateForm(node) {
    const x = strip(node);
    if (!x) return null;
    if (x.type === 'fn' && ['YEAR', 'MONTH', 'DAY'].includes(upName(x)) && (x.args || EMPTY).length === 1) {
      const c = this.column(x.args[0]);
      if (c && this.isDateCol(c)) return { fn: upName(x), c };
      return null;
    }
    if (x.type === 'cast' && x.dataType && lower(x.dataType.name) === 'date' && !x.style) {
      const c = this.column(x.e);
      if (c && this.isDateCol(c)) return { fn: 'DATE', c };
      return null;
    }
    if (x.type === 'fn' && upName(x) === 'DATETRUNC' && (x.args || EMPTY).length === 2 && strip(x.args[0]).type === 'datepart') {
      const c = this.column(x.args[1]);
      const unit = DATETRUNC_UNITS.get(strip(x.args[0]).v);
      if (c && unit && this.isDateCol(c)) return { fn: 'TRUNC', c, unit };
    }
    return null;
  }

  isDateCol(c) {
    return c.def.kind === 'attr' && c.def.attr.type === 'DateTime';
  }

  // The half-open range condition of a date form compared with a value (02 §4.2): eq -> ge start AND lt end; the
  // one-bound forms for <, <=, >, >=.
  dateRange(form, op, valueNode) {
    const v = this.value(valueNode);
    if (!v || v.c) return null;
    if (v.isNull) return T_FALSE;
    const c = form.c;
    const tgt = this.target(c, 'ge');
    if (!tgt || tgt.kind !== 'attr') return null;
    const range = this.rangeOf(form, v);
    if (range === null) return null;
    if (range === T_FALSE) return op === 'ne' ? null : op === 'eq' ? T_FALSE : null;
    const [start, end] = range;
    const ge = b => ({ t: 'c', leaf: c.leaf, attr: tgt.attr, op: 'ge', value: b, valueType: this.boundType(c) });
    const lt = b => ({ t: 'c', leaf: c.leaf, attr: tgt.attr, op: 'lt', value: b, valueType: this.boundType(c) });
    switch (op) {
      case 'eq': return mkFilter('and', [ge(start), lt(end)]);
      case 'lt': return lt(start);
      case 'le': return lt(end);
      case 'gt': return ge(end);
      case 'ge': return ge(start);
      default: return null;
    }
  }

  boundType(c) {
    return c.def.attr.behavior === 'DateOnly' ? { dt: 'date' } : { dt: 'datetime' };
  }

  // [start, end) of a date form's value; T_FALSE when no date can match (DATETRUNC off a boundary); null when the
  // value does not convert.
  rangeOf(form, v) {
    const P = this.P, tz = P.rt.tz || UTC_TZ;
    const dateOnly = form.c.def.attr.behavior === 'DateOnly';
    const mk = (y, m, d) => (dateOnly ? utcDate(y, m, d) : fromParts({ y, m, d, h: 0, mi: 0, s: 0, ms: 0 }, tz));
    if (form.fn === 'YEAR' || form.fn === 'MONTH' || form.fn === 'DAY') {
      if (!['int', 'bigint', 'decimal', 'float', 'money', 'bit'].includes(v.t.dt) && v.t.dt !== 'string') return null;
      let n;
      try {
        n = typeof v.v === 'number' ? v.v : Number(coerce(v.v, v.t, { dt: 'int' }, P.rt));
      } catch (e) {
        throw e;
      }
      if (!Number.isInteger(n)) return T_FALSE;
      const parts = form.parts || null;
      if (form.fn === 'YEAR') {
        if (parts) return null;
        if (n < 1 || n > 9999) return T_FALSE;
        return [mk(n, 1, 1), n === 9999 ? null : mk(n + 1, 1, 1)].some(x => x === null) ? null : [mk(n, 1, 1), mk(n + 1, 1, 1)];
      }
      return null;
    }
    // CAST(d AS date) = c and DATETRUNC(unit, d) = c
    let d;
    try {
      d = v.v instanceof Date ? v.v : coerce(v.v, v.t, { dt: 'datetime' }, P.rt);
    } catch (e) {
      throw e;
    }
    const p = v.t.dt === 'date' ? { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: 0, mi: 0, s: 0, ms: 0 } : dateParts(d, tz);
    if (form.fn === 'DATE') {
      if (v.t.dt !== 'date' && (p.h || p.mi || p.s || p.ms)) {
        // CAST(d AS date) = <datetime with a time part>: the date converts to datetime at midnight, so nothing matches
        return T_FALSE;
      }
      const start = mk(p.y, p.m, p.d);
      const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
      return [start, mk(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())];
    }
    const u = form.unit;
    const aligned = u === 'year' ? p.m === 1 && p.d === 1 && !(p.h || p.mi || p.s || p.ms)
      : u === 'quarter' ? (p.m - 1) % 3 === 0 && p.d === 1 && !(p.h || p.mi || p.s || p.ms)
        : u === 'month' ? p.d === 1 && !(p.h || p.mi || p.s || p.ms)
          : u === 'day' ? !(p.h || p.mi || p.s || p.ms)
            : u === 'hour' ? !(p.mi || p.s || p.ms) : u === 'minute' ? !(p.s || p.ms) : !p.ms;
    if (!aligned) return T_FALSE;
    if (dateOnly && !['year', 'quarter', 'month', 'day'].includes(u)) return null;
    const start = dateOnly ? utcDate(p.y, p.m, p.d) : fromParts({ ...p, ms: 0, tk: 0 }, tz);
    let end;
    if (u === 'year') end = mk(p.y + 1, 1, 1);
    else if (u === 'quarter' || u === 'month') {
      const step = u === 'quarter' ? 3 : 1;
      const nm = p.m + step;
      end = mk(p.y + Math.floor((nm - 1) / 12), ((nm - 1) % 12) + 1, 1);
    } else if (u === 'day') {
      const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
      end = mk(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
    } else {
      const step = u === 'hour' ? 3600000 : u === 'minute' ? 60000 : 1000;
      end = new Date(start.getTime() + step);
    }
    return [start, end];
  }
}

const DATETRUNC_UNITS = new Map([['year', 'year'], ['yy', 'year'], ['yyyy', 'year'], ['quarter', 'quarter'], ['qq', 'quarter'], ['q', 'quarter'],
  ['month', 'month'], ['mm', 'month'], ['m', 'month'], ['day', 'day'], ['dd', 'day'], ['d', 'day'], ['hour', 'hour'], ['hh', 'hour'],
  ['minute', 'minute'], ['mi', 'minute'], ['n', 'minute'], ['second', 'second'], ['ss', 'second'], ['s', 'second']]);
const UTC_TZ = Object.freeze({ utc: true, offset: () => 0 });

// A date value (UTC midnight of y-m-d), as types.js holds `date` values.
function utcDate(y, m, d) {
  const x = new Date(0);
  x.setUTCFullYear(y, m - 1, d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

// ================================================================================================ block planning

// DATEPART(year|month|day …, x) -> YEAR(x) / MONTH(x) / DAY(x) (02 §4.2), in every expression of a block. Only
// a column argument is rewritten: the column pushdown and the dategrouping keys need it, and any other argument
// keeps DATEPART's own errors (9810 for a time value names datepart).
const DATEPART_FN = new Map([['year', 'YEAR'], ['yy', 'YEAR'], ['yyyy', 'YEAR'], ['month', 'MONTH'], ['mm', 'MONTH'], ['m', 'MONTH'],
  ['day', 'DAY'], ['dd', 'DAY'], ['d', 'DAY']]);

function rewriteDatepart(x) {
  return mapExpr(x, n => {
    if (n.type === 'fn' && upName(n) === 'DATEPART' && (n.args || EMPTY).length === 2 && strip(n.args[0]).type === 'datepart' && strip(n.args[1]).type === 'col') {
      const fn = DATEPART_FN.get(lower(strip(n.args[0]).v));
      if (fn) return { type: 'fn', name: fn, args: [n.args[1]], pos: n.pos, end: n.end };
    }
    return undefined;
  });
}

// The comparison operators that reject NULLs (02 §3 phase 4).
const REJECT_OPS = new Set(['=', '<>', '<', '>', '<=', '>=']);

// The leaves whose bare columns a conjunct rejects NULLs of (02 §3 phase 4): a comparison, LIKE, IN list, BETWEEN or
// IS NOT NULL with a bare column (optionally inside CAST) as an operand.
function rejectedColumns(x) {
  x = strip(x);
  const bare = e => {
    let y = strip(e);
    while (y && y.type === 'cast') y = strip(y.e);
    return y && y.type === 'col' ? y : null;
  };
  const out = [];
  const add = e => { const c = bare(e); if (c) out.push(c); };
  if (!x) return out;
  if (x.type === 'bin' && REJECT_OPS.has(x.op)) { add(x.l); add(x.r); }
  else if (x.type === 'like' && !x.not) add(x.e);
  else if (x.type === 'like') add(x.e);
  else if (x.type === 'in' && x.list) add(x.e);
  else if (x.type === 'between') { add(x.e); }
  else if (x.type === 'isnull' && x.not) add(x.e);
  return out;
}

Object.assign(Block.prototype, {
  // Plans the block: {node, levels, nonNull, info, distinctable}.
  plan() {
    const P = this.P;
    const core = this.prepare(this.rowGoalCore(this.core));
    this.ast = core;
    this.grouped = !!core.groupBy || core.cols.some(it => it.expr && hasAggregate(it.expr)) || (!!core.having) ||
      !!(this.orderBy && this.orderBy.some(it => hasAggregate(it.expr)));
    this.bind(core.from);
    // phase 3c (a): scalar subqueries over a unique key become LEFT JOINs (the FROM is bound again)
    const uk = this.uniqueKeyRewrite(core);
    if (uk) {
      this.ast = uk;
      this.bind(uk.from);
    }
    // WHERE: aggregates and window functions are not allowed there (147, 4108; compile.js raises them)
    let conjs = this.analyze(conjuncts(this.ast.where), 'where');
    // a correlated subquery or APPLY body with an equality correlation reads its source through an index spool
    const split = this.splitCorrelated(conjs);
    conjs = split.conjs;
    let root = null;
    if (this.rel) {
      this.joinConditions(this.rel);
      this.convertOuterJoins(conjs);
      this.nullability();
      for (const c of conjs) if (c.kind === 'normal' || c.kind === 'semi') this.place(this.rel, c);
      root = this.finalize(this.build(this.rel));
    }
    const startup = conjs.filter(c => c.kind === 'startup');
    if (conjs.some(c => c.kind === 'false')) root = { k: 'empty', leaves: this.leaves, filters: [] };
    // the spool is built when the input is materialised, after every expression over it has been compiled (pruning)
    if (split.spool && root && root.k !== 'empty') root = { k: 'spool', piece: root, spool: split.spool, leaves: this.leaves, filters: [] };
    this.root = root;
    this.startup = startup;
    const r = this.grouped ? this.planGrouped() : this.planPlain();
    return r;
  },

  // The row goals of a subquery block (02 §3 phase 3): an EXISTS reads TOP 1 of a constant (the primary key is
  // all its FetchScan requests); a scalar subquery without TOP reads TOP 2 (only 0, 1 or more rows matter).
  rowGoalCore(core) {
    const kind = this.opts.kind, q = this.query;
    const one = node => ({ expr: lit(1, 'int', node), percent: false, ties: false, pos: node.pos, end: node.end });
    if (kind === 'exists' && core._exists) {
      return { ...core, cols: [{ expr: lit(1, 'int', core), alias: null, pos: core.pos, end: core.end }], top: one(core) };
    }
    if (kind === 'scalar' && !core.top && !(q && (q.offset || q.forJson || q.forXml)) && !core.into) {
      return { ...core, top: { expr: lit(2, 'int', core), percent: false, ties: false, pos: core.pos, end: core.end } };
    }
    return core;
  },

  // A copy of the core with DATEPART rewritten and the query's ORDER BY attached.
  prepare(core) {
    const out = { ...core };
    out.cols = core.cols.map(it => (it.expr ? { ...it, expr: rewriteDatepart(it.expr) } : it));
    if (core.where) out.where = rewriteDatepart(core.where);
    if (core.having) out.having = rewriteDatepart(core.having);
    if (core.groupBy) out.groupBy = { ...core.groupBy, items: core.groupBy.items.map(g => (g.type === 'rollup' || g.type === 'cube' ? { ...g, exprs: g.exprs.map(l => l.map(rewriteDatepart)) } : g.type === 'sets' ? { ...g, sets: g.sets.map(l => l.map(rewriteDatepart)) } : rewriteDatepart(g))) };
    if (core.from) out.from = rewriteFromDatepart(core.from);
    this.orderBy = this.query && this.query.orderBy ? this.query.orderBy.map(it => ({ ...it, expr: rewriteDatepart(it.expr) })) : null;
    return out;
  },

  // ------------------------------------------------------------------------------------------- conjuncts

  // Compiles and classifies WHERE (or ON) conjuncts: constants folded (false: a contradiction), startup filters
  // (no column of the block), normal conjuncts with the leaves they read.
  analyze(list, clause) {
    const out = [];
    for (const ast of list) {
      const c = this.conj(ast, clause);
      if (c) out.push(c);
    }
    return out;
  },

  // One conjunct: {ast, comp, leaves: Set, kind: 'normal'|'startup'|'false'|'true'}.
  conj(ast, clause) {
    const P = this.P;
    // a FetchXML condition function (today(), lastxdays(), under(), …) compiles only when it is pushed: its leaves
    // come from its column references, and a conjunct that cannot be pushed raises the compile.js error later
    if (someExpr(ast, n => n.type === 'fn' && FETCH_CONDITIONS.has(upName(n))) && !hasSubquery(ast)) {
      const leaves = new Set();
      walkExpr(ast, n => {
        if (n.type !== 'col') return true;
        try {
          const r = resolveColumn(n.parts, this.aScope, null, n);
          if (r && r.depth === 0 && this.leafAt[r.index]) leaves.add(this.leafAt[r.index]);
        } catch (e) {
          P.fail(e, n);
        }
        return true;
      });
      return { ast, comp: null, leaves, kind: leaves.size ? 'normal' : 'startup', clause, condFn: true };
    }
    const comp = P.compile(ast, this.aScope, { pred: true, clause });
    const leaves = new Set();
    for (const i of comp.cols || EMPTY) if (this.leafAt[i]) leaves.add(this.leafAt[i]);
    const c = { ast, comp, leaves, kind: 'normal', clause };
    // a top-level IN / EXISTS / NOT IN / NOT EXISTS / = ANY / <> ALL subquery becomes a semi, anti or antiNullAware
    // join when it is decorrelatable (02 §3 phase 3)
    if (leaves.size && (clause === 'where' || clause === 'on') && !this.opts.scratch && hasSubquery(ast)) {
      const d = this.decorrelate(c);
      if (d && d.constant !== undefined) {
        if (d.constant) return null;
        c.kind = 'false';
        return c;
      }
      if (d) {
        c.kind = 'semi';
        c.semi = d;
        c.leaves = d.outerLeaves;
      }
    }
    if (!leaves.size) {
      if (comp.isConst && !comp.pre && !(comp.plans && comp.plans.length)) {
        const f = P.fold(comp);
        if (f.ok) {
          if (f.value === true) return null;
          c.kind = 'false';
          return c;
        }
      }
      c.kind = 'startup';
      return c;
    }
    // x IS NULL on a non-nullable column is a contradiction, x IS NOT NULL and x = x tautologies (02 §3 phase 4)
    return c;
  },

  // The ON conditions of every join: conjuncts of inner joins go down like WHERE conjuncts; of an outer join, those
  // on the NULL-supplying side alone filter that side; the rest stay join conditions.
  joinConditions(rel) {
    if (rel.type === 'leaf') return;
    this.joinConditions(rel.left);
    if (rel.type === 'apply') { this.joinConditions(rel.right); return; }
    this.joinConditions(rel.right);
    rel.cond = [];
    rel.placed = rel.placed || [];
    const list = rel.on ? this.analyze(conjuncts(rel.on), 'on') : [];
    rel.onConjs = list;
    rel.onFalse = list.some(c => c.kind === 'false');
    // An ON clause that relates at most one input
    if (rel.on && ['inner', 'left', 'right', 'full'].includes(rel.kind)) {
      const touched = new Set();
      for (const c of list) for (const l of c.leaves) touched.add(rel.left.leaves.includes(l) ? 'l' : 'r');
      if (touched.size < 2) {
        const al = rel.right.leaves[0]?.written || '?', ol = rel.left.leaves[0]?.written || '?';
        rel.warning = this.P.warn(`The ON clause of the join to ${al} does not compare it with ${ol}: every row of ${ol} is combined with every matching row of ${al}. Check the join columns.`, rel.on);
      }
    }
    rel.condAll = list.filter(c => c.kind !== 'false');
  },

  // LEFT/RIGHT/FULL -> INNER (or LEFT/RIGHT) when a WHERE conjunct, or the ON of an enclosing inner join, rejects
  // NULLs of the NULL-supplying side (02 §3 phase 4).
  convertOuterJoins(conjs) {
    const rejected = new Set();
    const addRej = c => {
      for (const colNode of rejectedColumns(c.ast)) {
        try {
          const r = resolveColumn(colNode.parts, this.scope, null, colNode);
          if (r && r.depth === 0 && this.leafAt[r.index]) rejected.add(this.leafAt[r.index]);
        } catch { /* binding errors are reported by the conjunct's compile */ }
      }
    };
    for (const c of conjs) if (c.kind === 'normal') addRej(c);
    let changed = true;
    const visit = rel => {
      if (rel.type === 'leaf') return;
      visit(rel.left);
      if (rel.type === 'apply') { visit(rel.right); return; }
      visit(rel.right);
      const lRej = rel.left.leaves.some(l => rejected.has(l)), rRej = rel.right.leaves.some(l => rejected.has(l));
      let k = rel.kind;
      if (k === 'left' && rRej) k = 'inner';
      else if (k === 'right' && lRej) k = 'inner';
      else if (k === 'full') k = lRej && rRej ? 'inner' : lRej ? 'left' : rRej ? 'right' : 'full';
      if (k !== rel.kind) { rel.kind = k; changed = true; }
      if (rel.kind === 'inner') for (const c of rel.condAll || EMPTY) if (c.kind === 'normal') addRej(c);
    };
    while (changed) { changed = false; visit(this.rel); }
    // after the conversion, the ON conjuncts go to their places
    const route = rel => {
      if (rel.type === 'leaf') return;
      route(rel.left);
      if (rel.type === 'apply') { route(rel.right); return; }
      route(rel.right);
      for (const c of rel.condAll || EMPTY) {
        if (c.kind === 'startup') { rel.cond.push(c); continue; }
        const inL = [...c.leaves].every(l => rel.left.leaves.includes(l));
        const inR = [...c.leaves].every(l => rel.right.leaves.includes(l));
        if (rel.kind === 'inner' || rel.kind === 'cross') {
          if (inL && c.leaves.size) this.place(rel.left, c);
          else if (inR && c.leaves.size) this.place(rel.right, c);
          else rel.cond.push(c);
        } else if (rel.kind === 'left' && inR && c.leaves.size) this.place(rel.right, c);
        else if (rel.kind === 'right' && inL && c.leaves.size) this.place(rel.left, c);
        else rel.cond.push(c);
      }
    };
    route(this.rel);
  },

  // Scoped nullability (02 §3 phase 4): a leaf on the NULL-supplying side of an outer join or OUTER APPLY.
  nullability() {
    const nullSide = new Set();
    const mark = rel => { for (const l of rel.leaves) nullSide.add(l); };
    const visit = rel => {
      if (rel.type === 'leaf') return;
      visit(rel.left);
      visit(rel.right);
      if (rel.type === 'apply') { if (rel.kind === 'outer') mark(rel.right); return; }
      if (rel.kind === 'left') mark(rel.right);
      else if (rel.kind === 'right') mark(rel.left);
      else if (rel.kind === 'full') { mark(rel.left); mark(rel.right); }
    };
    visit(this.rel);
    this.nullSide = nullSide;
  },

  // Whether a layout column is non-nullable in this block (02 §3 phase 4).
  nonNullable(index) {
    const leaf = this.leafAt[index];
    if (!leaf || this.nullSide.has(leaf)) return false;
    return leaf.nonNull.has(index - leaf.start);
  },

  // Places a conjunct at the deepest rel node that covers its leaves within the pushdown boundaries (02 §3 phase 3b).
  place(rel, c) {
    if (rel.type === 'leaf') { (rel.placed = rel.placed || []).push(c); return; }
    rel.placed = rel.placed || [];
    const inL = [...c.leaves].every(l => rel.left.leaves.includes(l));
    const inR = [...c.leaves].every(l => rel.right.leaves.includes(l));
    if (rel.type === 'apply') {
      if (inL) this.place(rel.left, c);
      else rel.placed.push(c);
      return;
    }
    switch (rel.kind) {
      case 'inner': case 'cross':
        if (inL) this.place(rel.left, c);
        else if (inR) this.place(rel.right, c);
        else rel.placed.push(c);
        return;
      case 'left':
        if (inL) this.place(rel.left, c);
        else rel.placed.push(c);
        return;
      case 'right':
        if (inR) this.place(rel.right, c);
        else rel.placed.push(c);
        return;
      default:
        rel.placed.push(c);
    }
  },

  // ------------------------------------------------------------------------------------------- pieces

  // Builds the piece tree of a rel: FetchXML builders for Dataverse leaves, folded joins, client joins (02 §4.1).
  build(rel) {
    let p;
    if (rel.type === 'leaf') {
      const leaf = rel.leaf;
      p = leaf.kind === 'dv' ? { k: 'fb', fb: new FB(this, leaf), leaves: [leaf], filters: [], pending: [] } : { k: 'node', leaf, leaves: [leaf], filters: [] };
      for (const c of semisLast(rel.placed)) p = this.attach(p, c);
      return p;
    }
    const L = this.build(rel.left), R = this.build(rel.right);
    let after = rel.placed || EMPTY;
    if (rel.type === 'apply') {
      p = { k: 'apply', kind: rel.kind, left: this.finalize(L), right: this.finalize(R), leaves: rel.leaves, filters: [], rel };
    } else {
      // an INNER or CROSS join takes the WHERE conjuncts placed at it as join conditions (02 §3 phase 3: a comma
      // join with a WHERE equality becomes an INNER JOIN on it)
      if ((rel.kind === 'inner' || rel.kind === 'cross') && after.length) {
        rel.cond = [...rel.cond, ...after];
        after = EMPTY;
      }
      p = this.tryFold(rel, L, R) || { k: 'join', kind: rel.kind, left: this.finalize(L), right: this.finalize(R), cond: rel.cond.slice(), leaves: rel.leaves, filters: [], rel, onFalse: rel.onFalse };
    }
    for (const c of semisLast(after)) p = this.attach(p, c);
    return p;
  },

  // Attaches a conjunct to a piece: a FetchXML condition when the piece is a builder and it translates, else a client
  // filter right above the piece.
  attach(p, c) {
    // subquery conjuncts wait until no join folds into the builder any more (its FetchXML root is then final)
    if (p.k === 'fb' && !p.final && !this.P.noPushdown && (c.kind === 'semi' || hasSubquery(c.ast))) {
      p.pending.push(c);
      return p;
    }
    if (c.kind === 'semi' && c.semi) {
      const q = this.attachSemi(p, c);
      if (q) return q;
    }
    if (p.k === 'fb' && !this.P.noPushdown) {
      const it = this.translateFor(p.fb, c);
      if (it) {
        if (it.t === 'false') { p.fb.items.push(T_FALSE); return p; }
        if (it.t !== 'true') {
          p.fb.items.push(it);
          if (hasValueof(it)) p.fb.valueofConjs.push({ c, item: it, piece: p });
        }
        if (p.fb.kind === 'virtual') p.filters.push(c);
        return p;
      }
    }
    p.filters.push(c);
    return p;
  },

  // Finalises a builder piece once no join folds into it: its root is chosen and its pending subquery conjuncts are
  // attached (semi-join links where §4.1 allows, else client semi joins or filters). Returns the piece to use.
  finalize(p) {
    if (!p || p.k !== 'fb' || p.final) return p;
    p.final = true;
    p.fb.chooseRoot();
    let q = p;
    for (const c of p.pending) q = this.attach(q, c);
    p.pending = [];
    return q;
  },

  // Column comparisons that the chosen FetchXML root cannot write (02 §4.2 valueof) go back to client filters.
  settleValueof(p) {
    const fb = p.fb;
    if (!fb.valueofConjs.length) return;
    fb.chooseRoot();
    for (const v of fb.valueofConjs) {
      if (fb.valueofOk(v.item)) continue;
      const i = fb.items.indexOf(v.item);
      if (i >= 0) fb.items.splice(i, 1);
      if (!p.filters.includes(v.c)) p.filters.push(v.c);
    }
    fb.valueofConjs = [];
  },

  // A conjunct's FetchXML item for a builder, or null (02 §4.2 boundaries: AT TIME ZONE, COLLATE and xml methods
  // never; conditions on a non-inner link to solution stay client side, Q39).
  translateFor(fb, c) {
    if (someExpr(c.ast, n => (n.type === 'fn' && (upName(n) === 'AT_TIME_ZONE' || n.postfix)) || n.type === 'collate' || n.type === 'xmlmethod')) return null;
    for (const l of c.leaves) if (!fb.has(l)) return null;
    let it;
    try {
      it = new Translator(this, fb, this.aScope).translate(c.ast);
    } catch (e) {
      if (e instanceof SqlError && (e.number === 245 || e.number === 8114 || e.number === 8169 || e.number === 241 || e.number === 235 || e.number === 242 || e.number === 8115)) throw at(e, c.ast);
      return null;
    }
    if (!it) return null;
    if (countItems(it) + fb.items.reduce((n, x) => n + countItems(x), 0) > MAX_CONDS) return null;
    if (fb.isAudit() && auditOuterRef(it, fb)) return null;
    return it;
  },

  // Folds a join of two builder pieces into one fetch when 02 §4.1 allows it; null otherwise.
  tryFold(rel, L, R) {
    const P = this.P;
    if (P.noPushdown || L.k !== 'fb' || R.k !== 'fb') return null;
    let kind = rel.kind;
    if (kind === 'cross') kind = 'inner';
    if (kind !== 'inner' && kind !== 'left' && kind !== 'right') return null;
    if (rel.onFalse) return null;
    // the plain table side (one leaf) and the folded side
    const cands = [];
    const conds = [...rel.cond, ...(rel.placed || EMPTY).filter(() => false)];
    for (const c of conds) {
      const eq = this.joinEquality(c, L, R);
      if (eq) cands.push({ c, ...eq });
    }
    if (!cands.length) return null;
    const tryOne = (single, other, eq, nullSide) => {
      if (single.leaves.length !== 1) return null;
      const leaf = single.leaves[0];
      const mine0 = eq.l.leaf === leaf ? eq.l : eq.r, theirs0 = eq.l.leaf === leaf ? eq.r : eq.l;
      if (!other.fb.canFoldWith(leaf, { mine: mine0.attr, theirs: theirs0.attr })) return null;
      if (single.fb.items.length && nullSide) {
        // the NULL-supplying table's own conditions become its link filter
      }
      if ((single.filters.length || single.pending.length) && nullSide) return null;
      const mine = eq.l.leaf === leaf ? eq.l : eq.r, theirs = eq.l.leaf === leaf ? eq.r : eq.l;
      const rest = conds.filter(x => x !== eq.c);
      const linkItems = [];
      const rootItems = [];
      const tr = new Translator(this, other.fb, this.aScope);
      for (const x of rest) {
        const onlySingle = x.leaves.size === 1 && x.leaves.has(leaf);
        if (nullSide) {
          if (!onlySingle) return null;
          const it = this.translateLink(x, leaf, other.fb);
          if (!it) return null;
          linkItems.push(it);
        } else rootItems.push(x);
      }
      if (nullSide) linkItems.unshift(...single.fb.items);
      const fb = other.fb;
      fb.fold(theirs.leaf, theirs.attr, leaf, mine.attr, nullSide ? 'outer' : 'inner', nullSide ? linkItems : null);
      if (!nullSide) for (const it of single.fb.items) fb.items.push(it);
      let piece = { k: 'fb', fb, leaves: fb.leaves, filters: [...other.filters, ...(nullSide ? [] : single.filters)], pending: [...other.pending, ...(nullSide ? [] : single.pending)] };
      for (const x of semisLast(rootItems)) piece = this.attach(piece, x);
      if (rel.warning) fb.warnings.push(rel.warning);
      void tr;
      return piece;
    };
    for (const eq of cands) {
      let p = null;
      if (kind === 'inner') p = tryOne(R, L, eq, false) || tryOne(L, R, eq, false);
      else if (kind === 'left') p = tryOne(R, L, eq, true);
      else p = tryOne(L, R, eq, true);
      if (p) return p;
    }
    return null;
  },

  // A conjunct `x = y` between a bare column of a leaf of L and one of R whose attributes may join (02 §4.1):
  // {l: {leaf, attr}, r: {leaf, attr}} or null.
  joinEquality(c, L, R) {
    const x = strip(c.ast);
    if (!x || x.type !== 'bin' || x.op !== '=') return null;
    const side = node => {
      const y = strip(node);
      if (!y || y.type !== 'col') return null;
      let r;
      try { r = resolveColumn(y.parts, this.scope, null, y); } catch { return null; }
      if (!r || r.depth !== 0) return null;
      const leaf = this.leafAt[r.index];
      if (!leaf || leaf.kind !== 'dv') return null;
      const def = leaf.defs[r.index - leaf.start];
      if (!def || def.kind !== 'attr' || NOT_JOINABLE.has(def.attr.type)) return null;
      return { leaf, attr: def.attr.logicalName, a: def.attr };
    };
    const a = side(x.l), b = side(x.r);
    if (!a || !b) return null;
    const inL = l => L.leaves.includes(l), inR = l => R.leaves.includes(l);
    let l, r;
    if (inL(a.leaf) && inR(b.leaf)) { l = a; r = b; } else if (inL(b.leaf) && inR(a.leaf)) { l = b; r = a; } else return null;
    if (!joinable(l.a, r.a)) return null;
    return { l, r, c };
  },

  // An ON conjunct on the NULL-supplying table alone as an item of its link filter, or null.
  translateLink(c, leaf, fb) {
    const tmp = new FB(this, leaf);
    const it = this.translateFor(tmp, c);
    void fb;
    return it && it.t !== 'true' ? it : it && it.t === 'true' ? T_TRUE : null;
  },

  // ------------------------------------------------------------------------------------------- materialisation

  // The layout of a piece (its leaves' columns, companions shifted) and its scope.
  pieceScope(p) {
    if (p._scope) return p._scope;
    const schema = [];
    for (const l of p.leaves) for (const c of shiftSchema(l.cols, schema.length)) schema.push(c);
    p._scope = this.blockScope(schema, p.leaves.length ? p.leaves[0].start : 0);
    return p._scope;
  },

  // The offset of a leaf in a piece's layout.
  pieceOffset(p, leaf) {
    let n = 0;
    for (const l of p.leaves) {
      if (l === leaf) return n;
      n += l.cols.length;
    }
    return -1;
  },

  // Turns a piece into a PlanNode (FetchScan, client joins, filters).
  materialize(p, opts = {}) {
    let node;
    if (p.k === 'fb') this.settleValueof(p);
    const pred = p.filters.length ? this.andPred(p.filters, this.pieceScope(p)) : null;
    switch (p.k) {
      case 'empty': {
        const sc = this.pieceScope(p);
        node = new ConstantScan({ schema: sc.schema.map(c => ({ ...c })), rows: [], detail: 'contradiction: no rows, no request' });
        return node;
      }
      case 'fb': node = this.scanNode(p.fb, opts); break;
      case 'node': node = p.leaf.node; break;
      case 'join': node = this.joinNode(p); break;
      case 'apply': node = this.applyNode(p); break;
      case 'semi': node = this.semiNode(p); break;
      case 'spool': node = this.spoolInput(p.piece, p.spool); break;
      default: throw new TypeError(`planner: unknown piece ${p.k}`);
    }
    if (pred) node = new Filter({ kid: node, pred });
    return node;
  },

  // The AND of conjuncts compiled against a scope (null for none).
  andPred(list, scope) {
    if (!list.length) return null;
    const ast = andOf(list.map(c => c.ast));
    return this.P.compile(ast, scope, { pred: true, clause: list[0].clause || 'where', errors: [] });
  },

  // A FetchScan for a builder (02 §4, §5).
  scanNode(fb, opts = {}) {
    const P = this.P;
    if (fb.items.some(it => it.t === 'false')) {
      const sc = this.pieceScope({ leaves: fb.leaves });
      return new ConstantScan({ schema: sc.schema.map(c => ({ ...c })), rows: [], detail: 'contradiction: no rows, no request' });
    }
    fb.chooseRoot();
    const fetch = fb.toFetch();
    const schema = fb.scanSchema();
    const root = fb.root;
    const o = {
      fetch, entity: root.entity, entitySet: root.entity.entitySetName, schema, topLevel: !!opts.topLevel,
      warnings: fb.warnings.length ? fb.warnings.slice() : undefined,
    };
    if (P.hints.pageSize) o.pageSize = P.hints.pageSize;
    if (fb.keyCols) o.keyCols = fb.keyCols;
    const node = new FetchScan(o);
    node._fb = fb;
    return node;
  },

  // A client join of two pieces: HashJoin on its equality keys, else NestedLoop (02 §4.1, §6).
  joinNode(p) {
    const ls = this.pieceScope(p.left), rs = this.pieceScope(p.right), js = this.pieceScope(p);
    let kind = p.kind;
    if (kind === 'cross' && p.cond.length) kind = 'inner';
    const warnings = p.rel && p.rel.warning ? [p.rel.warning] : undefined;
    if (p.onFalse && (kind === 'inner' || kind === 'cross')) {
      return new ConstantScan({ schema: js.schema.map(c => ({ ...c })), rows: [], detail: 'the ON condition is false: no rows, no request', warnings });
    }
    const lkeys = [], rkeys = [], residual = [];
    for (const c of p.cond) {
      const x = strip(c.ast);
      if (!p.onFalse && x.type === 'bin' && x.op === '=' && !hasSubquery(x) && kind !== 'cross') {
        const lc = this.sideOf(x.l, p.left, p.right), rc = this.sideOf(x.r, p.left, p.right);
        if (lc === 'l' && rc === 'r') { lkeys.push(x.l); rkeys.push(x.r); continue; }
        if (lc === 'r' && rc === 'l') { lkeys.push(x.r); rkeys.push(x.l); continue; }
      }
      residual.push(c);
    }
    const falsePred = () => this.P.compile({ type: 'bin', op: '=', l: lit(1), r: lit(0) }, js, { pred: true });
    if (lkeys.length) {
      const lk = lkeys.map(e => this.P.compile(e, ls, { clause: 'on', errors: [] }));
      const rk = rkeys.map(e => this.P.compile(e, rs, { clause: 'on', errors: [] }));
      for (let i = 0; i < lk.length; i++) commonType(lk[i], rk[i]);
      const res = residual.length ? this.andPred(residual, js) : null;
      this.notNullKeys(p.left, lkeys, kind, 'left');
      this.notNullKeys(p.right, rkeys, kind, 'right');
      const left = this.materialize(p.left), right = this.materialize(p.right);
      return new HashJoin({ kind, left, right, lkeys: lk, rkeys: rk, residual: res, warnings });
    }
    const pred = p.onFalse ? falsePred() : residual.length ? this.andPred(residual, js) : null;
    const left = this.materialize(p.left), right = this.materialize(p.right);
    const nk = pred ? (kind === 'cross' ? 'inner' : kind) : (kind === 'inner' ? 'cross' : kind);
    return new NestedLoop({ kind: nk, left, right, pred, warnings });
  },

  // `<key> not-null` on the Dataverse side of a client INNER or semi HashJoin whose key is a bare column; never
  // on the preserved side of an outer, anti or antiNullAware join (02 §4.1).
  notNullKeys(piece, keyAsts, kind, side) {
    if (this.P.noPushdown || piece.k !== 'fb') return;
    const allowed = kind === 'inner' || kind === 'semi' || (kind === 'left' && side === 'right') || (kind === 'right' && side === 'left') || (kind === 'anti' && side === 'right');
    if (!allowed) return;
    const fb = piece.fb;
    for (const e of keyAsts) {
      const x = strip(e);
      if (!x || x.type !== 'col') continue;
      const col = new Translator(this, fb, this.aScope).column(x);
      if (!col || col.def.kind !== 'attr' || col.def.bigName) continue;
      const a = col.def.attr;
      if (NEVER_PUSH.has(a.type) || a.type === 'Virtual') continue;
      if (fb.items.some(it => it.t === 'c' && it.leaf === col.leaf && it.attr === a.logicalName && it.op === 'not-null')) continue;
      fb.items.push({ t: 'c', leaf: col.leaf, attr: a.logicalName, op: 'not-null' });
    }
  },

  // Which side of a join an expression reads: 'l', 'r', 'both' or 'none'.
  sideOf(expr, L, R) {
    let l = false, r = false;
    let c;
    try {
      c = this.P.compile(expr, this.aScope, { errors: [] });
    } catch {
      return 'both';
    }
    for (const i of c.cols || EMPTY) {
      const leaf = this.leafAt[i];
      if (L.leaves.includes(leaf)) l = true;
      else if (R.leaves.includes(leaf)) r = true;
    }
    if (l && r) return 'both';
    return l ? 'l' : r ? 'r' : 'none';
  },

  // CROSS / OUTER APPLY that phase 2b did not merge: a NestedLoop whose right side runs per left row (02 §6).
  applyNode(p) {
    const left = this.materialize(p.left);
    const right = this.materialize(p.right);
    const rel = p.rel;
    // memo: the left columns the right side reads (compile-time references into the APPLY's left scope)
    const memo = rel && rel.memo ? rel.memo : null;
    return new NestedLoop({ kind: p.kind === 'outer' ? 'left' : 'cross', left, right, apply: true, pred: null, memo });
  },
});

// Every join's ON with DATEPART rewritten.
function rewriteFromDatepart(ts) {
  if (!ts) return ts;
  if (ts.type === 'join') return { ...ts, left: rewriteFromDatepart(ts.left), right: rewriteFromDatepart(ts.right), on: ts.on ? rewriteDatepart(ts.on) : ts.on };
  return ts;
}

// Whether two attributes may be the equality of a link-entity (02 §4.1): lookups, uniqueidentifiers and primary
// keys with each other, String with String, otherwise the identical AttributeType.
function joinable(a, b) {
  if (GUID_TYPES.has(a.type) && GUID_TYPES.has(b.type)) return true;
  if (a.type === 'String' && b.type === 'String') return true;
  return a.type === b.type && !NOT_JOINABLE.has(a.type);
}

// Conjuncts with the decorrelated subqueries last (FetchXML conditions first, then the semi joins over them).
function semisLast(list) {
  if (!list || !list.length) return EMPTY;
  const a = [], b = [];
  for (const c of list) (c.kind === 'semi' ? b : a).push(c);
  return b.length ? [...a, ...b] : list;
}

// Whether an item tree holds a column comparison between two leaves (valueof).
function hasValueof(it) {
  if (!it) return false;
  if (it.t === 'f') return it.items.some(hasValueof);
  return it.t === 'c' && !!it.valueof && it.valueof.leaf !== it.leaf;
}

// Whether an item tree of an audit fetch names its outer systemuser link (an entityname condition through an outer
// link, which the audit provider refuses, 02 §4.6).
function auditOuterRef(it, fb) {
  if (!it) return false;
  if (it.t === 'f') return it.items.some(x => auditOuterRef(x, fb));
  if (it.t !== 'c') return false;
  const out = l => l && l.entity.logicalName !== 'audit' && fb.nullable.has(l);
  return out(it.leaf) || (it.valueof && out(it.valueof.leaf));
}

// Whether an item tree names a link alias (an entityname condition).
function hasEntityName(it, fb) {
  if (!it) return false;
  if (it.t === 'f') return it.items.some(x => hasEntityName(x, fb));
  if (it.t === 'c') return it.leaf !== fb.first || (it.valueof && it.valueof.leaf !== fb.first);
  return false;
}

// ================================================================================================ SELECT, ORDER BY, TOP

const OUT_ROLES = new Set(['pk', 'etag']);

Object.assign(Block.prototype, {
  // The expressions of the SELECT list and ORDER BY that hold window calls, for the window pre-collection.
  windowSources() {
    const out = [];
    for (const it of this.ast.cols) if (it.expr) out.push(it.expr);
    if (this.orderBy) for (const it of this.orderBy) out.push(it.expr);
    return out;
  },

  // The window functions of the block grouped by PARTITION BY / ORDER BY spec (02 §3 phase 5): [{key, nodes}].
  collectWindows() {
    const specs = new Map(), funcs = new Map();
    for (const e of this.windowSources()) {
      walkExpr(e, n => {
        if (isWinCall(n)) {
          const k = exprKey(n);
          if (!funcs.has(k)) {
            const sk = exprKey({ type: 'spec', p: n.over.partitionBy || [], o: (n.over.orderBy || []).map(o => ({ e: o.expr, d: !!o.desc })) });
            if (!specs.has(sk)) specs.set(sk, { key: sk, over: n.over, nodes: [] });
            const s = specs.get(sk);
            funcs.set(k, { node: n, spec: s });
            s.nodes.push(n);
          }
          return false;
        }
        return true;
      });
    }
    return { specs: [...specs.values()], funcs };
  },

  // Compiles the window functions over an input scope (02 §6): one Window node per spec, the function columns
  // appended in spec order; returns apply(node), which stacks the Window nodes over the input.
  compileWindows(inScope, wins) {
    if (!wins.specs.length) return node => node;
    const P = this.P;
    const base = inScope.schema.length;
    const index = new Map();
    let n = base;
    for (const s of wins.specs) for (const f of s.nodes) index.set(exprKey(f), n++);
    const outSchema = inScope.schema.slice();
    const scope = { ...inScope, schema: outSchema };
    const windows = fnNode => {
      const i = index.get(exprKey(fnNode));
      if (i === undefined) throw at(E(4108), fnNode);
      return i;
    };
    // the function columns (types from the entries)
    const built = [];
    for (const s of wins.specs) {
      const partition = (s.over.partitionBy || EMPTY).map(e => P.compile(e, inScope, { clause: 'select' }));
      const order = (s.over.orderBy || EMPTY).map(o => ({ ...P.compile(o.expr, inScope, { clause: 'order' }), desc: !!o.desc }));
      const funcs = [];
      for (const f of s.nodes) {
        const up = upName(f);
        const def = WINDOWS.get(up) || AGGREGATES.get(up);
        const args = f.star ? [] : (f.args || EMPTY).map(a => P.compile(a, inScope, { clause: 'select', aggregates: inScope.group ? this.aggCollector : undefined }));
        const consts = [];
        for (const i of def.consts || EMPTY) if (args[i] && args[i].isConst) { const fo = P.fold(args[i]); if (fo.ok) consts[i] = fo.value; }
        const t = def.dt(args, consts) || { dt: 'any' };
        outSchema.push({ name: '', qual: null, ...t });
        funcs.push({ def, args, consts, frame: f.over.frame || null, text: textOfNode(f, P) });
      }
      built.push({ partition, order, funcs });
    }
    void scope;
    void windows;
    return node => {
      let kid = node;
      let width = base;
      for (const w of built) {
        const schema = [...kid.schema, ...outSchema.slice(width, width + w.funcs.length)];
        kid = new Window({ kid, partition: w.partition, order: w.order, funcs: w.funcs, schema });
        width += w.funcs.length;
      }
      return kid;
    };
  },

  // Validates window function placement and compiles the select list against a scope; the items with their output
  // names, hidden flags and FOR JSON/XML AUTO sources.
  selectItems(scope, cxOpts, grouped) {
    const P = this.P, out = [];
    for (const it of this.ast.cols) {
      if (it.star) {
        out.push(...this.starItems(it, scope, cxOpts, grouped));
        continue;
      }
      if (it.assign) {
        const c = P.compile(it.expr, scope, { ...cxOpts, clause: 'select' });
        out.push({ c, name: it.assign, assign: { name: it.assign, op: it.op }, src: null, item: it });
        continue;
      }
      const c = P.compile(it.expr, scope, { ...cxOpts, clause: 'select' });
      const name = it.alias != null ? it.alias : c.name || '';
      out.push({ c, name, src: this.sourceOf(c, scope, it.expr), item: it });
    }
    return out;
  },

  // The source (leaf) of a bare column item for the FOR JSON / FOR XML AUTO levels, or null.
  sourceOf(c, scope, expr) {
    if (expr && expr._level) return expr._level;
    if (c.src == null || scope !== this.selScope) return null;
    const x = strip(expr);
    if (!x || x.type !== 'col') return null;
    const idx = this.selInput ? this.selInput[c.src] : c.src;
    return idx != null ? this.leafAt[idx] || null : null;
  },

  // The items of `*` / `q.*` (01 §6.3; 107 for an unknown qualifier).
  starItems(it, scope, cxOpts, grouped) {
    const P = this.P;
    let leaves = this.leaves;
    if (it.qualifier) {
      const q = lower(it.qualifier);
      leaves = this.leaves.filter(l => l.alias === q);
      if (!leaves.length) {
        P.fail(at(E(107, (it.qualParts || [it.qualifier]).join('.')), it), it);
        return [];
      }
    }
    const out = [];
    for (const leaf of leaves) {
      const idxs = leaf.starIdx ? leaf.starIdx : leaf.cols.map((c, i) => (c.hidden ? -1 : i)).filter(i => i >= 0);
      for (const i of idxs) {
        const col = leaf.cols[i];
        if (grouped || this.selInput) {
          const node = { type: 'col', parts: [leaf.alias === lower(leaf.written) ? leaf.written : leaf.alias, col.name], pos: it.pos, end: it.end, _star: true };
          const c = P.compile(node, scope, { ...cxOpts, clause: 'select' });
          out.push({ c, name: col.name, src: grouped ? null : leaf, item: it });
        } else {
          const idx = leaf.start + i;
          this.markUsed(idx);
          out.push({ c: readCol(scope.schema, idx, `${leaf.written}.${col.name}`), name: col.name, src: leaf, item: it });
        }
      }
    }
    return out;
  },

  // ORDER BY items of the block: {item index | null, c (compiled against the scope) | null, desc}.
  orderItems(items, scope, cxOpts, distinct) {
    const P = this.P;
    if (!this.orderBy || !this.orderBy.length) return [];
    const vis = items.map((x, i) => i);
    const out = [];
    for (const ob of this.orderBy) {
      const x = strip(ob.expr);
      if (x.type === 'lit' && x.dt === 'int' && typeof x.v === 'number') {
        const n = x.v;
        if (!(n >= 1 && n <= vis.length)) throw at(E(108, n), ob.expr);
        out.push({ item: vis[n - 1], desc: !!ob.desc, node: ob.expr });
        continue;
      }
      if (x.type === 'col' && x.parts.length === 1) {
        const nm = lower(x.parts[0]);
        const hits = items.map((it, i) => (it.item && it.item.alias != null && lower(it.item.alias) === nm ? i : -1)).filter(i => i >= 0);
        if (hits.length) {
          const keys = new Set(hits.map(i => exprKey(items[i].item.expr)));
          if (keys.size > 1) throw at(E(209, x.parts[0]), ob.expr);
          out.push({ item: hits[0], desc: !!ob.desc, node: ob.expr });
          continue;
        }
      }
      // an expression identical to a select item binds to it; with DISTINCT nothing else may be sorted (145)
      let k = null;
      try { k = groupKey(x, this.groupInput || scope); } catch { k = null; }
      let hit = -1;
      if (k != null) {
        hit = items.findIndex(it => {
          if (!it.item || !it.item.expr || it.assign) return false;
          try { return groupKey(strip(it.item.expr), this.groupInput || scope) === k; } catch { return false; }
        });
      }
      if (hit < 0 && x.type === 'col') {
        // a bare column that a star item selects
        hit = items.findIndex(it => it.item && it.item.star && it.c.src != null && (() => { try { const r = resolveColumn(x.parts, scope, null, x); return r && r.depth === 0 && r.index === it.c.src; } catch { return false; } })());
      }
      if (hit >= 0) { out.push({ item: hit, desc: !!ob.desc, node: ob.expr }); continue; }
      if (distinct) throw at(E(145), ob.expr);
      const c = P.compile(ob.expr, scope, { ...cxOpts, clause: 'order' });
      out.push({ item: null, c, desc: !!ob.desc, node: ob.expr });
    }
    return out;
  },

  // Plans a block without GROUP BY or aggregates.
  planPlain() {
    const P = this.P, core = this.ast, q = this.query;
    const wins = this.collectWindows();
    const inScope = this.scope;
    this.selScope = null;
    const winInfo = this.windowedScope(inScope, wins);
    const scope = winInfo.scope;
    this.selScope = scope;
    const cxOpts = { windows: winInfo.windows };
    const items = this.selectItems(scope, cxOpts, false);
    const order = this.orderItems(items, scope, cxOpts, !!core.distinct);
    this.checkWindowsUsed(wins);
    const distinct = !!core.distinct || (!!this.opts.branchDistinct && this.branchQualifies(items, order, wins));
    const applyWindows = this.compileWindows(inScope, wins);
    const hidden = this.hiddenOutputs(distinct);
    // the input: pushdown of ORDER BY, TOP / OFFSET and DISTINCT into one FetchScan (02 §4.3, §4.4)
    const plan = this.pushPlain(items, order, distinct, wins);
    let node = plan.input;
    node = this.startupFilter(node);
    node = applyWindows(node);
    // Project: the select items, hidden ORDER BY keys and the hidden root pk / etag (02 §3 phase 8)
    const exprs = items.map(it => it.c);
    const names = items.map(it => it.name);
    const orderCols = [];
    for (const o of order) {
      if (o.item != null) { orderCols.push({ idx: o.item, desc: o.desc }); continue; }
      orderCols.push({ idx: exprs.length, desc: o.desc });
      exprs.push(o.c);
      names.push({ name: o.c.name || '', hidden: true });
    }
    const nOrderHidden = exprs.length - items.length;
    for (const h of hidden) {
      if (h.role === 'etag' && !plan.single) continue;
      exprs.push(h.c);
      names.push({ name: h.name, hidden: true, role: h.role });
    }
    const ps = projectSchema(node.schema, exprs, names, { outermost: !!this.opts.outermost });
    node = new Project({ kid: node, exprs: ps.exprs, schema: ps.schema, extra: ps.extra });
    const levelSrc = items.map(it => it.src || null);
    // DISTINCT, ORDER BY, TOP / OFFSET (client side unless pushed)
    if (distinct && !plan.dropDistinct) {
      node = new Distinct({ kid: node });
      if (plan.distinctPushed) node._pushedDistinct = true;
    }
    const keys = orderCols.map(o => keyOn(node.schema, o.idx, o.desc));
    const top = core.top;
    let topN = null;
    if (top) topN = P.countExpr(top.expr, { schema: [], parent: this.outer });
    if (order.length && !plan.orderPushed) {
      node = new Sort({ kid: node, keys, top: top && !top.percent && !top.ties && typeof topN === 'number' && !(q && q.offset) ? topN : null });
    } else if (order.length && wins.specs.length && plan.orderPushed) {
      node = new Sort({ kid: node, keys });
    }
    if (top && !plan.topPushed) node = new Top({ kid: node, n: topN, percent: !!top.percent, ties: !!top.ties, keys: top.ties ? keys : undefined });
    if (q && q.offset && !plan.offsetPushed) node = P.offsetNode(node, q, this.outer);
    if (nOrderHidden) node = this.stripHidden(node, items.length, nOrderHidden);
    if (core.into) node = this.intoNode(node, core.into);
    const levels = this.levels(levelSrc, node);
    return { node, levels, nonNull: this.outNonNull(items), info: { distinct, plan } };
  },

  // The scope of the select list: the input scope plus the window function columns.
  windowedScope(inScope, wins) {
    if (!wins.specs.length) return { scope: inScope, windows: undefined };
    const index = new Map();
    let n = inScope.schema.length;
    const extra = [];
    for (const s of wins.specs) {
      for (const f of s.nodes) {
        index.set(exprKey(f), n++);
        const up = upName(f);
        const def = WINDOWS.get(up) || AGGREGATES.get(up);
        let t = { dt: 'any' };
        if (def) {
          try {
            const args = f.star ? [] : (f.args || EMPTY).map(a => this.P.compile(a, inScope, { clause: 'select', errors: [], aggregates: inScope.group ? this.aggCollector : undefined }));
            t = def.dt(args, []) || t;
          } catch { /* the select list's compile reports the error */ }
        }
        extra.push({ name: '', qual: null, ...t });
      }
    }
    const schema = [...inScope.schema, ...extra];
    const scope = inScope.block ? this.blockScope(schema, 0, inScope.parent) : { ...inScope, schema };
    const windows = fnNode => {
      const i = index.get(exprKey(fnNode));
      if (i === undefined) throw at(E(4108), fnNode);
      return i;
    };
    return { scope, windows };
  },

  // A window function that is not in the SELECT list or ORDER BY is an error the compile raised; nothing to do.
  checkWindowsUsed() {},

  // Startup filters: conjuncts that read no column of the block run once before its input (02 §3 phase 3).
  startupFilter(node) {
    if (!this.startup || !this.startup.length) return node;
    const pred = this.andPred(this.startup, { schema: [], parent: this.outer });
    return new StartupFilter({ kid: node, pred });
  },

  // A Project that drops the hidden ORDER BY key columns (01 §6.1).
  stripHidden(node, nItems, nHidden) {
    const keep = [];
    for (let i = 0; i < node.schema.length; i++) if (i < nItems || i >= nItems + nHidden) keep.push(i);
    const exprs = keep.map(i => readCol(node.schema, i));
    const schema = keep.map(i => node.schema[i]);
    // companion indexes move with the dropped columns
    const remap = new Map(keep.map((i, j) => [i, j]));
    const fixed = schema.map(c => {
      if (!c.companion) return c;
      const comp = {};
      for (const k of Object.keys(c.companion)) if (remap.has(c.companion[k])) comp[k] = remap.get(c.companion[k]);
      return { ...c, companion: comp };
    });
    return new Project({ kid: node, exprs, schema: fixed, extra: [], detail: 'remove the ORDER BY columns' });
  },

  // SELECT … INTO #t (02 §3 phase 5; 1038 / 2705 checked by the binder).
  intoNode(node, into) {
    const name = String(into.parts[into.parts.length - 1]);
    if (!name.startsWith('#')) throw at(plain('INTO can only target #temp tables and table variables. Use INSERT INTO <table> SELECT ... (it has its own preview).'), into);
    const seen = new Set();
    for (const c of node.schema) {
      if (c.hidden) continue;
      if (!c.name) throw at(E(1038), into);
      const k = lower(c.name);
      if (seen.has(k)) throw at(E(2705, c.name, name), into);
      seen.add(k);
    }
    return new Into({ kid: node, name });
  },

  // The hidden root pk and etag of the outermost Project (02 §3 phase 8).
  hiddenOutputs(distinct) {
    const out = [];
    if (!this.opts.outermost || distinct || this.grouped || this.opts.branch || !this.leaves.length) return out;
    const first = this.leaves[0];
    if (first.kind !== 'dv' || first.pkIdx < 0 || this.leaves.some(l => l.pivot || l.unpivot)) return out;
    const pkCol = first.cols[first.pkIdx];
    out.push({ c: readCol(this.selScope.schema, first.start + first.pkIdx, `${first.written}.${pkCol.name}`), name: pkCol.name, role: 'pk' });
    this.markUsed(first.start + first.pkIdx);
    const vIdx = first.defs.findIndex(d => d && d.kind === 'attr' && d.attr.logicalName === 'versionnumber');
    if (vIdx >= 0 && this.root && this.root.k === 'fb' && !this.root.filters.length) {
      out.push({ c: readCol(this.selScope.schema, first.start + vIdx, `${first.written}.versionnumber`), name: 'versionnumber', role: 'etag' });
      this.markUsed(first.start + vIdx);
    }
    return out;
  },

  // The non-nullable output columns (pk pass-through, not NULL-supplied) for an enclosing block (02 §3 phase 4).
  outNonNull(items) {
    const out = new Set();
    items.forEach((it, i) => {
      if (it.c.src != null && this.selScope && this.selScope.schema === this.layout && this.nonNullable(it.c.src)) out.add(i);
    });
    return out;
  },

  // FOR JSON / FOR XML AUTO levels (01 §5.6) of the final node's visible columns.
  levels(srcs, node) {
    const vis = visibleCols(node.schema);
    const levels = [];
    const at = new Map();
    let pending = [];
    vis.forEach((idx, i) => {
      const s = srcs[i];
      if (s) {
        const key = s.id != null ? s : s.name;
        if (!at.has(key)) {
          at.set(key, levels.length);
          levels.push({ name: s.written || s.name, cols: [] });
          if (levels.length === 1 && pending.length) { levels[0].cols.push(...pending); pending = []; }
        }
        levels[at.get(key)].cols.push(idx);
      } else if (levels.length) levels[levels.length - 1].cols.push(idx);
      else pending.push(idx);
    });
    if (!levels.length && this.leaves.length && pending.length) levels.push({ name: this.leaves[0].written, cols: pending });
    else if (pending.length && levels.length) levels[0].cols.unshift(...pending);
    return levels;
  },
});

// A rendering of an AST node's source text for explain().
function textOfNode(n, P) {
  if (P.source && typeof n.pos === 'number' && typeof n.end === 'number') return P.source.slice(n.pos, n.end);
  return upName(n) + '(…)';
}

// A filter that evaluates a predicate without columns once per execution before its input runs (a startup
// expression filter): when it is not true, the input is never read (02 §3 phase 3). op 'Filter'.
class StartupFilter extends PlanNode {
  constructor(o) {
    super({ op: 'Filter', kids: [o.kid], schema: o.kid.schema, server: false, detail: o.detail, props: o.props, warnings: o.warnings, est: o.est });
    this.kid = o.kid;
    this.pred = o.pred;
    this.plans = Array.isArray(o.pred.plans) ? o.pred.plans.slice() : [];
  }

  detail() { return `startup: ${this.pred.text || ''}`; }
  props() { return [{ name: 'Startup predicate', value: String(this.pred.text || '') }]; }
  rowsCounted() { return this.kid.rowsCounted(); }
  markGoalKids(n) {
    const k = this.kid;
    if (!(n > 0) || (k.rowGoal > 0 && k.rowGoal <= n)) return;
    k.rowGoal = n;
    k.markGoalKids(n);
  }

  async *execute(env) {
    if (this.pred.pre) await this.pred.pre([[]], env);
    if (this.pred.fn(EMPTY_ROW, env) !== true) return;
    yield* this.kid.run(env);
  }
}
const EMPTY_ROW = Object.freeze([]);

// ================================================================================================ ORDER BY / TOP / DISTINCT pushdown

const TIER3_TEXT = 'Aggregate computed in the browser: Dataverse limits server side aggregates to 50,000 records.';

// FetchXML orders without repeated attributes (Dataverse refuses an attribute ordered twice; a repeated SQL key
// changes nothing, the first one decides).
function uniqOrders(list) {
  const seen = new Set(), out = [];
  for (const o of list) {
    const k = (o.alias ? 'a:' + o.alias : (o.leaf ? o.leaf.id : '') + ':' + o.attr);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}
const NUMERIC_DT = new Set(['int', 'bigint', 'decimal', 'float', 'money']);
const DISTINCT_TYPES = new Set(['String', 'Integer', 'BigInt', 'Decimal', 'Double', 'Money', 'DateTime', 'Uniqueidentifier']);

Object.assign(Block.prototype, {
  // The layout column a compiled select-list or ORDER BY expression passes through (a bare column), or null.
  bareIndex(c, expr) {
    if (!c || c.src == null) return null;
    const x = expr ? strip(expr) : null;
    if (x && x.type !== 'col') return null;
    if (this.selScope && this.selScope.schema !== this.layout && c.src >= this.layout.length) return null;
    return c.src;
  },

  // The ORDER BY keys of the block as layout columns: [{index, desc}] or null when one is not a bare column.
  orderColumns(items, order) {
    const out = [];
    for (const o of order) {
      let c, expr;
      if (o.item != null) { c = items[o.item].c; expr = items[o.item].item && !items[o.item].item.star ? items[o.item].item.expr : null; }
      else { c = o.c; expr = o.node; }
      const idx = this.bareIndex(c, expr && !(items[o.item] && items[o.item].item && items[o.item].item.star) ? expr : null);
      if (idx == null) return null;
      out.push({ index: idx, desc: o.desc });
    }
    return out;
  },

  // The FetchXML orders of ORDER BY keys on a builder (02 §4.3), or null when one cannot be pushed. topN is the
  // pushed TOP (null: paging).
  fetchOrders(fb, cols, topN) {
    const P = this.P;
    const kind = fb.kind, audit = fb.isAudit();
    const single = topN != null && topN <= FETCH_TOP_MAX;
    if (!single && fb.hasToMany()) return null;
    const orders = [];
    let raw = false, label = false;
    for (const k of cols) {
      const leaf = this.leafAt[k.index];
      if (!leaf || leaf.kind !== 'dv' || !fb.has(leaf)) return null;
      const d = leaf.defs[k.index - leaf.start];
      if (!d || d.bigName) return null;
      if (leaf !== fb.root && (!single || !fb.manyToOne(leaf))) return null;
      let attr;
      if (d.kind === 'attr') {
        const a = d.attr;
        if (LOOKUP_TYPES.has(a.type) || a.type === 'EntityName' || a.type === 'MultiSelectPicklist' || a.type === 'Memo' || NEVER_PUSH.has(a.type) || a.type === 'Virtual') return null;
        if ((kind === 'elastic' || audit) && GUID_TYPES.has(a.type)) return null;
        if (audit && a.validForAdvancedFind === false) return null;
        if (CHOICE_TYPES.has(a.type)) {
          if (!single) return null;
          raw = true;
        }
        attr = a.logicalName;
      } else if (d.kind === 'name') {
        const base = d.attr;
        if (!d.real || d.real === base) return null;
        if (kind === 'elastic' || audit) return null;
        if (CHOICE_TYPES.has(base.type)) label = true;
        else if (!LOOKUP_TYPES.has(base.type)) return null;
        attr = base.logicalName;
      } else return null;
      orders.push({ leaf, attr, desc: !!k.desc });
    }
    if (raw && label) return null;
    orders.splice(0, orders.length, ...uniqOrders(orders));
    if (kind === 'elastic' && orders.length !== 1) return null;
    if (audit && orders.length > 1) return null;
    return { orders, raw };
  },

  // Pushes ORDER BY, TOP / OFFSET and DISTINCT of a block without GROUP BY into its single FetchScan (02 §4.3, §4.4)
  // and materialises the input.
  pushPlain(items, order, distinct, wins) {
    const P = this.P, q = this.query, core = this.ast;
    const out = { orderPushed: false, topPushed: false, offsetPushed: false, distinctPushed: false, dropDistinct: false, single: false };
    const root = this.root;
    if (!root) {
      out.input = new ConstantScan({ schema: [], rows: [[]] });
      return out;
    }
    const fb = root.k === 'fb' && !root.filters.length ? root.fb : null;
    out.single = root.k === 'fb';
    if (fb && !P.noPushdown && !wins.specs.length) {
      fb.chooseRoot();
      const top = core.top;
      let topN = null;
      if (top && !top.percent && !top.ties) {
        const n = P.countExpr(top.expr, { schema: [], parent: this.outer });
        if (typeof n === 'number') topN = n;
      }
      const offset = q && q.offset ? P.countExpr(q.offset, { schema: [], parent: this.outer }) : null;
      const fetchN = q && q.fetch ? P.countExpr(q.fetch, { schema: [], parent: this.outer }) : null;
      const virtual = fb.kind === 'virtual';
      // DISTINCT: dropped when the visible projection holds every row-multiplying source's primary key (02 §4.4)
      if (distinct && this.distinctRedundant(items, fb)) out.dropDistinct = true;
      const distinctCols = distinct && !out.dropDistinct ? this.distinctColumns(items, fb) : null;
      // ORDER BY
      let cols = order.length ? this.orderColumns(items, order) : [];
      const pushTop = topN != null && topN <= FETCH_TOP_MAX && offset == null && !(virtual && order.length) && !fb.isAudit();
      let fo = cols ? this.fetchOrders(fb, cols, pushTop ? topN : null) : null;
      if (order.length && fo) {
        fb.orders = fo.orders.slice();
        if (fo.raw) fb.rawOrder = true;
        out.orderPushed = !virtual;
      } else if (order.length) fo = null;
      const ordersOk = !order.length || !!fo;
      // DISTINCT pushdown (02 §4.4): (a) with a pushed TOP, (b) with ascending orders on the distinct attributes
      if (distinctCols && !fb.hasToMany() && ordersOk) {
        if (pushTop) {
          fb.distinct = true;
          fb.attrOnly = distinctCols.set;
          out.distinctPushed = true;
        } else {
          const ok = distinctCols.list.every(x => DISTINCT_TYPES.has(x.def.attr.type) || (CHOICE_TYPES.has(x.def.attr.type)));
          const anyChoice = distinctCols.list.some(x => CHOICE_TYPES.has(x.def.attr.type));
          if (ok && !(anyChoice && !pushTop) && !order.length && fb.kind !== 'elastic') {
            fb.distinct = true;
            fb.attrOnly = distinctCols.set;
            fb.orders = uniqOrders(distinctCols.list.map(x => ({ leaf: x.leaf, attr: x.def.attr.logicalName, desc: false })));
            out.distinctPushed = true;
          }
        }
      }
      // TOP / OFFSET (02 §4.4): only with every ORDER BY key pushed
      if (ordersOk && (!distinct || out.distinctPushed || out.dropDistinct)) {
        if (pushTop) {
          fb.top = topN;
          out.topPushed = !virtual;
          if (fb.isAudit() && fb.leaves.length > 1) { fb.top = null; fb.count = topN; out.topPushed = false; }
        } else if (topN != null && virtual && !order.length && topN <= FETCH_TOP_MAX) {
          fb.count = topN;
        } else if (topN != null && fb.isAudit() && fb.leaves.length > 1 && topN <= FETCH_TOP_MAX) {
          fb.count = topN;
        }
        if (typeof offset === 'number' && typeof fetchN === 'number' && fetchN > 0 && offset % fetchN === 0 && fetchN <= FETCH_TOP_MAX &&
            offset + fetchN <= PAGE_CAP && !fb.hasToMany() && fb.kind === 'standard' && !fb.isAudit() && !fb.first.dsrc && order.length && out.orderPushed && !distinct) {
          fb.page = offset / fetchN + 1;
          fb.count = fetchN;
          out.offsetPushed = true;
        }
      }
      // the root primary key keeps cookie paging stable (02 §4.3)
      if (fb.orders && fb.orders.length && !fb.distinct && fb.kind !== 'elastic' && !fb.hasToMany() && fb.top == null) {
        const pk = lower(fb.root.entity.primaryIdAttribute);
        if (!fb.orders.some(o => o.leaf === fb.root && o.attr === pk) && !fb.isAudit()) fb.orders.push({ leaf: fb.root, attr: pk, desc: false });
      }
      out.topLevel = !!this.opts.outermost && !distinct && (!order.length || out.orderPushed);
    }
    out.input = this.materialize(root, { topLevel: !!out.topLevel });
    return out;
  },

  // Whether DISTINCT changes nothing: the visible select items hold the primary key of the root and of every
  // toMany link of the fetch (02 §4.4; a hidden pk never counts).
  distinctRedundant(items, fb) {
    const pks = new Set();
    for (const it of items) {
      const idx = this.bareIndex(it.c, it.item && !it.item.star ? it.item.expr : null) ?? (it.item && it.item.star ? it.c.src : null);
      if (idx == null) continue;
      const leaf = this.leafAt[idx];
      if (leaf && leaf.kind === 'dv' && idx - leaf.start === leaf.pkIdx) pks.add(leaf);
    }
    if (!fb.treeOf) fb.chooseRoot();
    if (!pks.has(fb.root)) return false;
    for (const [leaf, p] of fb.treeOf.parent) if (p.toMany && !pks.has(leaf)) return false;
    return true;
  },

  // Whether a set-operation branch qualifies for the DISTINCT pushdown of 02 §4.4: one FetchScan, no TOP,
  // ORDER BY or window, every select item a distinct-pushable attribute with an ascending order.
  branchQualifies(items, order, wins) {
    const root = this.root;
    if (!root || root.k !== 'fb' || root.filters.length || this.P.noPushdown || order.length || wins.specs.length || this.ast.top) return false;
    const fb = root.fb;
    if (fb.kind === 'elastic' || fb.isAudit() || fb.first.dsrc) return false;
    fb.chooseRoot();
    if (fb.hasToMany()) return false;
    const cols = this.distinctColumns(items, fb);
    return !!cols && cols.list.every(x => DISTINCT_TYPES.has(x.def.attr.type));
  },

  // The distinct attributes of a DISTINCT select list over one fetch: {list: [{leaf, def}], set: Map<leaf, Set>} or
  // null when one item is not a real pushable attribute (02 §4.4).
  distinctColumns(items, fb) {
    const list = [];
    const set = new Map();
    for (const it of items) {
      const idx = it.item && it.item.star ? it.c.src : this.bareIndex(it.c, it.item ? it.item.expr : null);
      if (idx == null) return null;
      const leaf = this.leafAt[idx];
      if (!leaf || leaf.kind !== 'dv' || !fb.has(leaf)) return null;
      const d = leaf.defs[idx - leaf.start];
      if (!d || d.kind !== 'attr') return null;
      const a = d.attr;
      if (['PartyList', 'Image', 'File', 'MultiSelectPicklist', 'Memo', 'EntityName', 'Virtual', 'CalendarRules', 'ManagedProperty'].includes(a.type) || LOOKUP_TYPES.has(a.type)) return null;
      list.push({ leaf, def: d });
      if (!set.has(leaf)) set.set(leaf, new Set());
      set.get(leaf).add(a.logicalName);
    }
    return list.length ? { list, set } : null;
  },
});

// ================================================================================================ GROUP BY and aggregates

// The GROUP BY of a block normalised to key expressions and grouping sets (02 §3 phase 5).
function groupSets(groupBy) {
  const keyNodes = [];
  const factors = [];
  for (const g of groupBy.items) {
    if (g.type === 'rollup') {
      const n = g.exprs.length;
      const sets = [];
      for (let i = n; i >= 0; i--) sets.push(g.exprs.slice(0, i).flat());
      factors.push(sets);
    } else if (g.type === 'cube') {
      const n = g.exprs.length;
      const sets = [];
      for (let m = (1 << n) - 1; m >= 0; m--) {
        const s = [];
        for (let i = 0; i < n; i++) if (m & (1 << (n - 1 - i))) s.push(...g.exprs[i]);
        sets.push(s);
      }
      factors.push(sets);
    } else if (g.type === 'sets') factors.push(g.sets.map(s => s.slice()));
    else factors.push([[g]]);
  }
  let sets = [[]];
  for (const f of factors) {
    const next = [];
    for (const a of sets) for (const b of f) next.push([...a, ...b]);
    sets = next;
  }
  for (const s of sets) for (const e of s) keyNodes.push(e);
  return { keyNodes, sets };
}

Object.assign(Block.prototype, {
  // Plans a grouped block (02 §3 phase 5, §4.5).
  planGrouped() {
    const P = this.P, core = this.ast, q = this.query;
    const input = this.scope;
    this.groupInput = input;
    // keys (deduplicated by the 01 §7.1 group key) and grouping sets
    const gs = core.groupBy ? groupSets(core.groupBy) : { keyNodes: [], sets: [[]] };
    const keyMap = new Map(), keyList = [];
    const keyIdx = node => {
      let k;
      try { k = groupKey(node, input); } catch (e) { P.fail(e, node); k = exprKey(node); }
      if (!keyMap.has(k)) { keyMap.set(k, keyList.length); keyList.push(node); }
      return keyMap.get(k);
    };
    for (const n of gs.keyNodes) keyIdx(n);
    const sets = gs.sets.map(s => [...new Set(s.map(keyIdx))].sort((a, b) => a - b));
    if (core.groupBy) for (const n of keyList) if (hasAggregate(n)) throw at(E(147), n);
    const keys = keyList.map(n => P.compile(n, input, { clause: 'group' }));
    // aggregates of SELECT, HAVING and ORDER BY (pre-collected; outer aggregates of subqueries are added on demand)
    const usesGrouping = this.usesGrouping();
    const aggList = [];
    const aggByKey = new Map();
    const preAggs = this.collectAggregates();
    const nk = keys.length;
    const hasGid = sets.length > 1 || usesGrouping;
    const post = [];
    keys.forEach((c, i) => {
      const x = strip(keyList[i]);
      const name = x.type === 'col' ? c.name : '';
      const col = { name, qual: c.src != null && input.schema[c.src] ? input.schema[c.src].qual : null };
      for (const f of ['dt', 'prec', 'scale', 'len', 'dto', 'unicode', 'fixed', 'small', 'numeric', 'coll', 'ci_ai']) if (c[f] != null && c[f] !== false) col[f] = c[f];
      if (c.src != null && input.schema[c.src]) {
        const s = input.schema[c.src];
        if (s.attr) col.attr = s.attr;
        if (s.role) col.role = s.role;
        if (s.ref) col.ref = s.ref;
        if (s.ci_ai) col.ci_ai = true;
      }
      if (sets.length > 1 || sets.some(s => !s.includes(i))) col.nullable = true;
      post.push(col);
    });
    const aggSpecs = [];
    const addAgg = node => {
      const k = this.aggKey(node, input);
      if (aggByKey.has(k)) return aggByKey.get(k);
      const spec = this.aggSpec(node, input);
      const idx = nk + aggSpecs.length;
      aggSpecs.push(spec);
      aggByKey.set(k, idx);
      aggList.push(node);
      return idx;
    };
    for (const n of preAggs) addAgg(n);
    const gidIdx = hasGid ? nk + aggSpecs.length : -1;
    const finishSchema = () => {
      const s = post.slice(0, nk);
      for (const a of aggSpecs) s.push({ name: '', qual: null, ...a.type });
      if (hasGid) s.push({ name: 'gid', qual: null, dt: 'int', hidden: true, role: 'gid' });
      return s;
    };
    let schema = finishSchema();
    const keysMap = new Map();
    keyList.forEach((n, i) => {
      try { keysMap.set(groupKey(n, input), i); } catch { /* reported above */ }
    });
    const gscope = { schema, parent: this.outer, group: { input, keys: keysMap, count: nk, gid: gidIdx } };
    let dynamic = false;
    this.aggCollector = node => {
      const k = this.aggKey(node, input);
      if (aggByKey.has(k)) return aggByKey.get(k);
      if (hasGid) throw at(plain('An aggregate of an outer query inside a subquery cannot be combined with GROUPING SETS, ROLLUP, CUBE or GROUPING() here.'), node);
      dynamic = true;
      const idx = addAgg(node);
      const t = aggSpecs[idx - nk].type;
      gscope.schema.push({ name: '', qual: null, ...t });
      return idx;
    };
    const wins = this.collectWindows();
    const winInfo = this.windowedScope(gscope, wins);
    const sel = winInfo.scope;
    this.selScope = sel;
    const cxOpts = { aggregates: this.aggCollector, windows: winInfo.windows };
    const items = this.selectItems(sel, cxOpts, true);
    const having = core.having ? P.compile(core.having, gscope, { pred: true, clause: 'having', aggregates: this.aggCollector }) : null;
    const order = this.orderItems(items, sel, cxOpts, !!core.distinct);
    if (dynamic && wins.specs.length) throw at(plain('An aggregate of an outer query inside a subquery cannot be combined with window functions here.'), core);
    const applyWindows = this.compileWindows(gscope, wins);
    schema = gscope.schema;
    // the aggregate input: FetchXML aggregate (tiers 1 and 2) with the in-memory fallback, or in memory (tier 3)
    let node = this.aggregateInput(keys, keyList, sets, aggSpecs, aggList, schema, hasGid);
    node = this.startupFilter(node);
    if (having) node = new Filter({ kid: node, pred: having });
    node = applyWindows(node);
    const exprs = items.map(it => it.c);
    const names = items.map(it => it.name);
    const orderCols = [];
    for (const o of order) {
      if (o.item != null) { orderCols.push({ idx: o.item, desc: o.desc }); continue; }
      orderCols.push({ idx: exprs.length, desc: o.desc });
      exprs.push(o.c);
      names.push({ name: o.c.name || '', hidden: true });
    }
    const nHidden = exprs.length - items.length;
    const ps = projectSchema(node.schema, exprs, names, { outermost: !!this.opts.outermost });
    node = new Project({ kid: node, exprs: ps.exprs, schema: ps.schema, extra: ps.extra });
    if (core.distinct) node = new Distinct({ kid: node });
    const keysS = orderCols.map(o => keyOn(node.schema, o.idx, o.desc));
    const top = core.top;
    const topN = top ? P.countExpr(top.expr, { schema: [], parent: this.outer }) : null;
    if (order.length) node = new Sort({ kid: node, keys: keysS, top: top && !top.percent && !top.ties && typeof topN === 'number' && !(q && q.offset) ? topN : null });
    if (top) node = new Top({ kid: node, n: topN, percent: !!top.percent, ties: !!top.ties, keys: top.ties ? keysS : undefined });
    if (q && q.offset) node = P.offsetNode(node, q, this.outer);
    if (nHidden) node = this.stripHidden(node, items.length, nHidden);
    if (core.into) node = this.intoNode(node, core.into);
    const levels = this.levels(items.map(() => null), node);
    return { node, levels, nonNull: new Set(), info: { grouped: true } };
  },

  // Whether GROUPING() / GROUPING_ID() appear in the block's SELECT, HAVING or ORDER BY.
  usesGrouping() {
    const exprs = [...this.ast.cols.filter(it => it.expr).map(it => it.expr), this.ast.having, ...(this.orderBy || EMPTY).map(o => o.expr)];
    return exprs.some(e => e && someExpr(e, n => n.type === 'fn' && (upName(n) === 'GROUPING' || upName(n) === 'GROUPING_ID')));
  },

  // The aggregate calls of SELECT, HAVING and ORDER BY (not inside subqueries or OVER), in order of appearance.
  collectAggregates() {
    const out = [];
    const exprs = [...this.ast.cols.filter(it => it.expr).map(it => it.expr), this.ast.having, ...(this.orderBy || EMPTY).map(o => o.expr)];
    for (const e of exprs) {
      if (!e) continue;
      walkExpr(e, n => {
        if (isAggCall(n)) { out.push(n); return false; }
        return true;
      });
    }
    return out;
  },

  // The dedupe key of an aggregate call (01 §7.1: exprKey after name resolution; COUNT(1) is COUNT(*)).
  aggKey(node, input) {
    const n = this.countStar(node);
    try {
      return groupKey(n, input);
    } catch {
      return exprKey(n);
    }
  },

  // COUNT(c) / COUNT_BIG(c) with c constant and not NULL at plan time is COUNT(*) / COUNT_BIG(*).
  countStar(node) {
    const up = upName(node);
    if ((up !== 'COUNT' && up !== 'COUNT_BIG') || node.star || node.distinct || (node.args || EMPTY).length !== 1) return node;
    const a = node.args[0];
    if (hasSubquery(a) || someExpr(a, n => n.type === 'col')) return node;
    let c;
    try { c = this.P.compile(a, { schema: [], parent: null }, { errors: [] }); } catch { return node; }
    if (!c.isConst) return node;
    const f = this.P.fold(c);
    if (!f.ok || f.value == null) return node;
    return { ...node, args: [], star: true, _countOf: node };
  },

  // The HashAggregate spec of an aggregate call: {def, args, distinct, consts, order, text, type, node}.
  aggSpec(node, input) {
    const P = this.P;
    const n = this.countStar(node);
    const up = upName(n);
    const def = AGGREGATES.get(up);
    const args = n.star ? [] : (n.args || EMPTY).map(a => P.compile(a, input, { clause: 'select' }));
    const consts = [];
    for (const i of def.consts || EMPTY) if (args[i] && args[i].isConst) { const f = P.fold(args[i]); if (f.ok) consts[i] = f.value; }
    const order = n.withinGroup && n.withinGroup.length ? n.withinGroup.map(o => ({ ...P.compile(o.expr, input, { clause: 'order' }), desc: !!o.desc })) : null;
    let type;
    try { type = def.dt(args, consts) || { dt: 'any' }; } catch (e) { throw at(e, node); }
    return { def, args, distinct: !!n.distinct, consts, order, text: textOfNode(node, P), type: { ...type }, node: n };
  },

  // The aggregate's input node: tier 1/2 FetchXML aggregates in a TryCatch with the tier-3 fallback, or the
  // HashAggregate over the materialised input (02 §4.5).
  aggregateInput(keys, keyList, sets, aggs, aggNodes, schema, hasGid) {
    const normal = this.aggregatePlan(keys, keyList, sets, aggs, aggNodes, schema, hasGid);
    // COUNT(*) of one whole standard table with the RETRIEVE_TOTAL_RECORD_COUNT hint: RetrieveTotalRecordCount, with
    // the plan above as its fallback (02 §4.5)
    const root = this.root, P = this.P;
    const fb = root && root.k === 'fb' ? root.fb : null;
    const agg = aggs.length === 1 ? aggs[0] : null;
    if (P.hints.use.has('RETRIEVE_TOTAL_RECORD_COUNT') && fb && !root.filters.length && !P.noPushdown && !keys.length && !hasGid && sets.length === 1 &&
      agg && agg.node && agg.node.star && !agg.distinct && ['COUNT', 'COUNT_BIG'].includes(upName(agg.node)) && schema.length === 1 &&
      fb.leaves.length === 1 && !fb.items.length && !fb.semis.length && !fb.residual.length && !fb.first.dsrc && fb.kind === 'standard' && !fb.isAudit() &&
      fb.top == null && !fb.distinct) {
      return new TryCatch({
        body: new TotalCount({ entity: fb.first.entity.logicalName, schema: schema.map(c => ({ ...c })) }),
        fallback: normal, match: e => !(e && e.code === 'auth'),
        message: 'RetrieveTotalRecordCount gave no count; the records were counted exactly instead.',
      });
    }
    return normal;
  },

  aggregatePlan(keys, keyList, sets, aggs, aggNodes, schema, hasGid) {
    const P = this.P;
    const root = this.root;
    const memory = () => {
      const kid = root ? this.materialize(root) : new ConstantScan({ schema: [], rows: [[]] });
      return new HashAggregate({ kid, keys, aggs, sets, schema: schema.map(c => ({ ...c })) });
    };
    if (!root || root.k !== 'fb' || root.filters.length || P.noPushdown || hasGid || sets.length !== 1 || P.hints.use.has('HASH GROUP')) return memory();
    const fb = root.fb;
    const plan = this.aggregateFetch(fb, keys, keyList, aggs, schema);
    if (!plan) return memory();
    const fallback = memory();
    const tier1 = plan.node;
    let body = tier1;
    if (plan.partition) {
      body = new PartitionedAggregate({ scan: tier1, entity: fb.root.entity, entitySet: fb.root.entity.entitySetName, schema: tier1.schema });
    }
    const box = { err: null };
    return new TryCatch({
      body, fallback: new FallbackNote({ kid: fallback, box }), match: isAggregateFallback,
      message: err => { box.err = err; return TIER3_TEXT; },
    });
  },

  // The tier-1 aggregate FetchScan of a grouped block over one builder, or null when §4.5 tier 1 does not apply.
  aggregateFetch(fb, keys, keyList, aggs, schema) {
    const P = this.P;
    const ent = fb.root.entity;
    if (fb.kind === 'virtual' || fb.first.dsrc || fb.distinct || fb.top != null) return null;
    if (fb.isAudit() && (fb.leaves.length > 1 || fb.items.some(it => hasEntityName(it, fb)))) return null;
    if (fb.items.some(it => it.t === 'false')) return null;
    fb.chooseRoot();
    const attrs = [];
    let g = 0, a = 0;
    const tzLocal = !!(P.rt.tz && !P.rt.tz.utc);
    const keyCols = [];
    // group keys: real attributes, YEAR/MONTH/DAY of DateTime columns; name/type columns of a grouped base
    const baseKeys = new Map();
    for (let i = 0; i < keys.length; i++) {
      const x = strip(keyList[i]);
      if (x.type !== 'col') continue;
      const idx = this.bareIndex(keys[i], x);
      if (idx == null) continue;
      const leaf = this.leafAt[idx];
      const d = leaf && leaf.defs ? leaf.defs[idx - leaf.start] : null;
      if (d && d.kind === 'attr') baseKeys.set(leaf.id + ':' + d.attr.logicalName, i);
    }
    let elasticProduct = 1;
    for (let i = 0; i < keys.length; i++) {
      const x = strip(keyList[i]);
      let leaf, d, dategrouping = null;
      if (x.type === 'fn' && ['YEAR', 'MONTH', 'DAY'].includes(upName(x)) && (x.args || EMPTY).length === 1 && strip(x.args[0]).type === 'col') {
        const c = P.compile(x.args[0], this.scope, { errors: [] });
        const idx = this.bareIndex(c, x.args[0]);
        if (idx == null) return null;
        leaf = this.leafAt[idx];
        d = leaf && leaf.defs ? leaf.defs[idx - leaf.start] : null;
        if (!d || d.kind !== 'attr' || d.attr.type !== 'DateTime') return null;
        dategrouping = upName(x).toLowerCase();
      } else if (x.type === 'col') {
        const idx = this.bareIndex(keys[i], x);
        if (idx == null) return null;
        leaf = this.leafAt[idx];
        d = leaf && leaf.defs ? leaf.defs[idx - leaf.start] : null;
      } else return null;
      if (!leaf || leaf.kind !== 'dv' || !fb.has(leaf) || !d) return null;
      if (d.kind === 'name' || d.kind === 'type') {
        const bi = baseKeys.get(leaf.id + ':' + d.attr.logicalName);
        if (bi === undefined || bi > i) {
          if (bi === undefined) return null;
        }
        keyCols.push({ i, dependent: bi, role: d.kind });
        continue;
      }
      if (d.bigName) return null;
      const at = d.attr;
      if (at.type === 'MultiSelectPicklist' || NEVER_PUSH.has(at.type) || at.type === 'Virtual' || at.type === 'Memo') return null;
      if (at.type === 'DateTime' && !dategrouping) return null;
      if (fb.kind === 'elastic') {
        if (!CHOICE_TYPES.has(at.type)) return null;
        const opts = this.meta && this.meta.optionsSync ? this.meta.optionsSync(leaf.entity.logicalName, at.logicalName) : null;
        elasticProduct *= opts ? Math.max(1, opts.length) : 1000;
      }
      const alias = `g${g++}`;
      const spec = { leaf, name: at.logicalName, alias, groupby: true };
      if (dategrouping) {
        spec.dategrouping = dategrouping;
        const beh = at.behavior || 'UserLocal';
        if (beh === 'DateOnly' || beh === 'TimeZoneIndependent' || !tzLocal) spec.usertimezone = false;
        else if (this.meta && this.meta.tzMatchesBrowser) spec.usertimezone = true;
        else return null;
      }
      attrs.push(spec);
      keyCols.push({ i, alias, role: null });
    }
    if (fb.kind === 'elastic' && elasticProduct > 500) return null;
    const aggCols = [];
    let partition = fb.kind === 'standard' && !fb.isAudit() && !fb.first.dsrc && this.partitionable(ent);
    for (const s of aggs) {
      const up = s.def.name;
      const alias = `a${a++}`;
      if (s.order) return null;
      if (up === 'COUNT' || up === 'COUNT_BIG') {
        if (!s.args.length) {
          attrs.push({ leaf: fb.root, name: lower(fb.root.entity.primaryIdAttribute), alias, aggregate: 'count' });
          aggCols.push(alias);
          continue;
        }
      }
      if (s.args.length !== 1) return null;
      const argNode = s.node.args[0];
      const c = s.args[0];
      const idx = this.bareIndex(c, argNode);
      if (idx == null) return null;
      const leaf = this.leafAt[idx];
      const d = leaf && leaf.defs ? leaf.defs[idx - leaf.start] : null;
      if (!leaf || leaf.kind !== 'dv' || !fb.has(leaf) || !d || d.kind !== 'attr') return null;
      const at = d.attr;
      let aggregate = null, distinct = false;
      switch (up) {
        case 'COUNT': case 'COUNT_BIG':
          aggregate = 'countcolumn';
          distinct = s.distinct;
          if (NEVER_PUSH.has(at.type) || at.type === 'Virtual' || at.type === 'MultiSelectPicklist' || at.type === 'Memo') return null;
          break;
        case 'APPROX_COUNT_DISTINCT':
          aggregate = 'countcolumn';
          distinct = true;
          if (NEVER_PUSH.has(at.type) || at.type === 'Virtual' || at.type === 'MultiSelectPicklist' || at.type === 'Memo') return null;
          break;
        case 'SUM': case 'AVG':
          if (s.distinct) return null;
          if (!['Integer', 'BigInt', 'Decimal', 'Double', 'Money'].includes(at.type)) return null;
          aggregate = up.toLowerCase();
          break;
        case 'MIN': case 'MAX':
          if (s.distinct && false) return null;
          if (!['Integer', 'BigInt', 'Decimal', 'Double', 'Money', 'DateTime'].includes(at.type)) return null;
          aggregate = up.toLowerCase();
          break;
        default:
          return null;
      }
      if (at.type === 'Money' && !/_base$/.test(at.logicalName) && (up === 'SUM' || up === 'AVG' || up === 'MIN' || up === 'MAX')) {
        if (this.P.pf.currency !== 1) {
          if (this.P.pf.currency != null) this.P.warn(`Amounts in different currencies were added together; use ${at.logicalName}_base for base-currency totals.`);
          return null;
        }
      }
      if (distinct || s.distinct) partition = false;
      const spec = { leaf, name: at.logicalName, alias, aggregate };
      if (distinct) spec.distinct = true;
      attrs.push(spec);
      aggCols.push(alias);
    }
    if (fb.isAudit()) partition = false;
    // the aggregate fetch: same links and filters, no orders, aggregate attributes only
    const saved = { orders: fb.orders, agg: fb.agg };
    fb.agg = { attrs };
    fb.orders = null;
    // orders on group keys / aggregates are applied by the client Sort above
    const fetch = fb.toFetch();
    fb.agg = saved.agg;
    fb.orders = saved.orders;
    const scanSchema = schema.map((col, j) => {
      const c = { ...col };
      delete c.companion;
      if (j < keys.length) {
        const kc = keyCols.find(k => k.i === j);
        if (kc.dependent !== undefined) {
          const base = keyCols.find(k => k.i === kc.dependent);
          c.srcKey = base.alias;
          c.role = kc.role;
        } else c.srcKey = kc.alias;
      } else c.srcKey = aggCols[j - keys.length];
      return c;
    });
    const node = new FetchScan({ fetch, entity: fb.root.entity, entitySet: fb.root.entity.entitySetName, schema: scanSchema });
    return { node, partition };
  },

  // Whether tier 2 can split the table on createdon (02 §4.5): a readable UserLocal createdon DateTime attribute.
  partitionable(ent) {
    const a = ent.attrs && ent.attrs.get('createdon');
    return !!a && a.type === 'DateTime' && (a.behavior || 'UserLocal') === 'UserLocal' && a.validForRead !== false;
  },
});

// Emits the server message of a tier-1/2 aggregate failure as a Messages line before the in-memory fallback streams.
class FallbackNote extends PlanNode {
  constructor(o) {
    super({ op: 'HashAggregate', kids: [o.kid], schema: o.kid.schema, server: false });
    this.kid = o.kid;
    this.box = o.box;
  }

  explain() { return this.kid.explain(); }
  rowsCounted() { return this.kid.rowsCounted(); }

  async *execute(env) {
    if (this.box.err && this.box.err.message) emitInfo(env, `Dataverse: ${this.box.err.message}`);
    yield* this.kid.run(env);
  }
}

// ================================================================================================ CTE scopes, recursion

Object.assign(Planner.prototype, {
  // Runs fn with the CTE scopes visible at a CTE's definition: the enclosing WITH clauses and the CTEs written before
  // it in its own WITH (a non-recursive CTE never sees itself or later ones).
  withCteScope(def, fn) {
    if (def.scopeIndex == null || def.scopeIndex < 0) return fn();
    const saved = this.cteScopes;
    const own = saved[def.scopeIndex];
    const prior = new Map();
    if (own) for (const [k, v] of own) { if (v === def) break; prior.set(k, v); }
    this.cteScopes = [...saved.slice(0, def.scopeIndex), prior];
    try {
      return fn();
    } finally {
      this.cteScopes = saved;
    }
  },
});

// ================================================================================================ decorrelation (phase 3)

Object.assign(Block.prototype, {
  // The subquery predicate of a top-level conjunct: {kind: 'exists'|'in'|'quantified', not, query, x (outer
  // operand), op} or null.
  subPredicate(ast) {
    let x = strip(ast), not = false;
    while (x.type === 'not') { not = !not; x = strip(x.e); }
    if (x.type === 'exists') return { kind: 'exists', not, query: x.query, node: x };
    if (x.type === 'in' && x.query) return { kind: 'in', not: not !== !!x.not, query: x.query, x: x.e, node: x };
    if (x.type === 'quantified') {
      if (x.op === '=' && x.quant === 'ANY' && !not) return { kind: 'in', not: false, query: x.query, x: x.l, node: x };
      if (x.op === '<>' && x.quant === 'ALL' && !not) return { kind: 'in', not: true, query: x.query, x: x.l, node: x };
    }
    return null;
  },

  // Analyses a subquery for decorrelation (02 §3 phase 3): its FROM bound in a scratch block whose outer scope is
  // this block, its WHERE conjuncts split into inner-only ones and equality correlations `inner = outer`
  // (references of this block only). null when it does not qualify (TOP, aggregates, DISTINCT kept for IN …).
  analyzeSub(query, kind) {
    const P = this.P;
    if (!query || query.with || query.forJson || query.forXml || query.xmlns) return null;
    let q = query;
    if (kind === 'exists') {
      q = normalizeExists(query);
      if (q === FALSE_EXISTS) return { falseExists: true };
    }
    if (q.body.type !== 'core' || q.offset || q.fetch) return null;
    const core = q.body;
    if (core.top || core.groupBy || core.having || core.into || !core.from) return null;
    if (core.cols.some(it => it.assign || (it.expr && (hasAggregate(it.expr) || hasWindow(it.expr))))) return null;
    if (kind === 'in' && (core.cols.length !== 1 || core.cols[0].star)) return null;
    if (queryHasNewid(q)) return null;
    const sub = new Block(P, core, this.aScope, { kind: 'semi', scratch: true });
    sub.ast = sub.prepare(core);
    try {
      sub.bind(sub.ast.from);
    } catch {
      return null;
    }
    if (P.errors.length) return null;
    const inner = [], corr = [];
    for (const ast of conjuncts(sub.ast.where)) {
      if (hasSubquery(ast)) {
        // a subquery inside the subquery: kept as an inner conjunct when it does not read this block
        const refs = this.subRefs(ast, sub);
        if (refs === null || refs.outer) return null;
        inner.push(ast);
        continue;
      }
      const condFn = someExpr(ast, n => n.type === 'fn' && FETCH_CONDITIONS.has(upName(n)));
      const refs = condFn ? this.condRefs(ast, sub) : this.subRefs(ast, sub);
      if (refs === null) return null;
      if (!refs.outer) { inner.push(ast); continue; }
      if (condFn) return null;
      const eq = this.correlationEquality(ast, sub);
      if (!eq) return null;
      corr.push(eq);
    }
    return { q, core, sub, inner, corr };
  },

  // Which scopes a FetchXML condition-function conjunct of a subquery block reads (it compiles only when it is
  // pushed, so its column references decide): {inner, outer, deep: false} or null when one does not bind.
  condRefs(ast, sub) {
    const out = { inner: false, outer: false, deep: false };
    let ok = true;
    walkExpr(ast, n => {
      if (n.type !== 'col') return true;
      let r = null;
      try { r = resolveColumn(n.parts, sub.aScope, null, n); } catch { r = null; }
      if (!r) ok = false;
      else if (r.depth === 0) out.inner = true;
      else if (r.depth === 1) out.outer = true;
      else ok = false;
      return true;
    });
    return ok ? out : null;
  },

  // Which scopes an expression of a subquery block reads: {inner, outer (this block), deep} or null when it does
  // not bind.
  subRefs(ast, sub) {
    let c;
    try {
      c = this.P.compile(ast, sub.aScope, { errors: [], pred: false });
    } catch {
      try {
        c = this.P.compile(ast, sub.aScope, { errors: [], pred: true });
      } catch {
        return null;
      }
    }
    const out = { inner: !!(c.cols && c.cols.length), outer: false, deep: false };
    for (const o of c.outer || EMPTY) {
      if (o.depth === 1) out.outer = true;
      else out.deep = true;
    }
    if (out.deep) return null;
    return out;
  },

  // An equality correlation `inner = outer` (inner reads only the subquery's columns, outer only this block's):
  // {inner, outer} ASTs, or null.
  correlationEquality(ast, sub) {
    const x = strip(ast);
    if (!x || x.type !== 'bin' || x.op !== '=') return null;
    const l = this.subRefs(x.l, sub), r = this.subRefs(x.r, sub);
    if (!l || !r) return null;
    if (l.inner && !l.outer && r.outer && !r.inner) return { inner: x.l, outer: x.r, ast };
    if (r.inner && !r.outer && l.outer && !l.inner) return { inner: x.r, outer: x.l, ast };
    return null;
  },

  // Rewrites a top-level subquery conjunct into a semi / anti / antiNullAware join description (02 §3 phase 3,
  //), or returns null to leave it to per-row evaluation (compile.js, phase 3c).
  decorrelate(c) {
    const sp = this.subPredicate(c.ast);
    if (!sp) return null;
    const a = this.analyzeSub(sp.query, sp.kind === 'exists' ? 'exists' : 'in');
    if (!a) return null;
    if (a.falseExists) return { constant: sp.not };
    let x = null, s = null;
    if (sp.kind === 'in') {
      // the IN operand must read this block only; the selected column the subquery only
      const xr = this.exprRefs(sp.x);
      if (!xr || xr.outer) return null;
      s = a.core.cols[0].expr;
      const sr = this.subRefs(s, a.sub);
      if (!sr || sr.outer) return null;
      x = sp.x;
    }
    if (sp.kind === 'exists' && !a.corr.length) return null;
    const kind = sp.kind === 'exists' ? (sp.not ? 'anti' : 'semi') : (sp.not ? 'antiNullAware' : 'semi');
    // the outer leaves the join reads
    const outerLeaves = new Set();
    const addLeaves = e => {
      const r = this.exprRefs(e);
      if (r) for (const l of r.leaves) outerLeaves.add(l);
    };
    for (const k of a.corr) addLeaves(k.outer);
    if (x) addLeaves(x);
    if (!outerLeaves.size) return null;
    return { kind, sp, a, x, s, outerLeaves };
  },

  // The leaves of this block an expression reads, and whether it reads outer scopes: {leaves, outer} or null.
  exprRefs(e) {
    let c;
    try {
      c = this.P.compile(e, this.aScope, { errors: [] });
    } catch {
      return null;
    }
    const leaves = new Set();
    for (const i of c.cols || EMPTY) if (this.leafAt[i]) leaves.add(this.leafAt[i]);
    return { leaves, outer: !!(c.outer && c.outer.length), c };
  },

  // A FetchXML semi-join link for a decorrelated subquery on a builder (02 §4.1, §4.2), or null.
  semiLink(fb, d) {
    const P = this.P;
    if (P.noPushdown || P.explainOnly && false) return null;
    const { a, kind } = d;
    if (a.sub.leaves.length !== 1) return null;
    const inner = a.sub.leaves[0];
    if (inner.kind !== 'dv' || inner.dsrc || inner.entity.kind !== 'standard' || inner.entity.logicalName === 'audit') return null;
    if (fb.kind !== 'standard' || fb.isAudit() || fb.first.dsrc) return null;
    if (fb.linkCount() + 1 > MAX_LINKS) return null;
    // exactly one correlation: EXISTS by one equality, IN by its operand (no other correlation)
    let innerCol, outerCol;
    if (d.sp.kind === 'exists') {
      if (a.corr.length !== 1) return null;
      innerCol = this.subColumn(a.corr[0].inner, a.sub);
      outerCol = new Translator(this, fb, this.aScope).column(a.corr[0].outer);
    } else {
      if (a.corr.length) return null;
      innerCol = this.subColumn(d.s, a.sub);
      outerCol = new Translator(this, fb, this.aScope).column(d.x);
    }
    if (!innerCol || !outerCol || outerCol.def.kind !== 'attr' || NOT_JOINABLE.has(outerCol.def.attr.type)) return null;
    if (!joinable(innerCol.attr, outerCol.def.attr)) return null;
    // NOT IN folds only when the subquery column is its primary key and the outer column is non-nullable (§4.2)
    if (kind === 'antiNullAware') {
      const pk = lower(inner.entity.primaryIdAttribute);
      if (innerCol.attr.logicalName !== pk || !this.nonNullable(outerCol.index)) return null;
    }
    // the inner conjuncts become the link's filter (no entityname)
    const tmp = new FB(a.sub, inner);
    const items = [];
    for (const ast of a.inner) {
      if (hasSubquery(ast)) return null;
      const it = a.sub.translateFor(tmp, { ast, leaves: new Set([inner]), clause: 'where' });
      if (!it) return null;
      if (it.t === 'false') return kind === 'semi' ? T_FALSE : T_TRUE;
      if (it.t !== 'true') items.push(it);
    }
    if (outerCol.leaf !== fb.root && fb.edges.length) {
      // a correlation on a link alias folds only when that link and its ancestors are INNER (§4.1)
      fb.chooseRoot();
      if (!fb.innerChain(outerCol.leaf)) return null;
    }
    const linkType = kind === 'semi' ? (d.sp.kind === 'exists' ? 'exists' : 'in') : 'not any';
    return { t: 'link', linkType, entity: inner.entity.logicalName, from: innerCol.attr.logicalName, to: outerCol.def.attr.logicalName, outerLeaf: outerCol.leaf, items };
  },

  // A bare column of a scratch subquery block: {leaf, attr} or null.
  subColumn(ast, sub) {
    const x = strip(ast);
    if (!x || x.type !== 'col') return null;
    let r;
    try { r = resolveColumn(x.parts, sub.aScope, null, x); } catch { return null; }
    if (!r || r.depth !== 0) return null;
    const leaf = sub.leafAt[r.index];
    if (!leaf || leaf.kind !== 'dv') return null;
    const d = leaf.defs[r.index - leaf.start];
    if (!d || d.kind !== 'attr') return null;
    return { leaf, attr: d.attr };
  },

  // Attaches a decorrelated subquery to a piece: a semi-join link on a builder, else a client semi / anti /
  // antiNullAware HashJoin over the piece (02 §3 phase 3, §6). Returns the piece to use from now on.
  attachSemi(p, c) {
    const d = c.semi;
    if (p.k === 'fb') {
      const it = this.semiLink(p.fb, d);
      if (it) {
        if (it.t === 'false') { p.fb.items.push(T_FALSE); return p; }
        if (it.t === 'true') return p;
        p.fb.semis.push(it);
        return p;
      }
    }
    return this.clientSemi(p, c);
  },

  // A client semi / anti / antiNullAware join of a piece with a decorrelated subquery's rows.
  clientSemi(p, c) {
    const P = this.P;
    const d = c.semi;
    const { a } = d;
    // the subquery's rows: its FROM and inner conjuncts, projecting the inner key expressions
    const keyInner = [], keyOuter = [];
    if (d.sp.kind === 'in') { keyInner.push(d.s); keyOuter.push(d.x); }
    const corrInner = a.corr.map(k => k.inner), corrOuter = a.corr.map(k => k.outer);
    const cols = [...keyInner, ...corrInner].map((e, i) => ({ expr: e, alias: `_k${i}`, pos: e.pos, end: e.end }));
    if (!cols.length) return null;
    const core = { ...a.core, cols, where: andOf(a.inner), distinct: false, top: null };
    const q = { type: 'query', with: null, xmlns: null, body: core, orderBy: null, offset: null, fetch: null };
    const right = P.planQuery(q, this.outer, { kind: 'derived', derived: true }).node;
    const piece = { k: 'semi', kind: d.kind, left: p, rightNode: right, keyOuter, corrOuter, nKey: keyInner.length, leaves: p.leaves, filters: [] };
    return piece;
  },

  // Materialises a client semi join piece.
  semiNode(p) {
    const ls = this.pieceScope(p.left);
    const outer = [...p.keyOuter, ...p.corrOuter].map(e => this.P.compile(e, ls, { clause: 'where', errors: [] }));
    const right = p.rightNode;
    const vis = visibleCols(right.schema);
    const inner = vis.map(i => readCol(right.schema, i));
    for (let i = 0; i < outer.length; i++) commonType(outer[i], inner[i]);
    // Not-null on the Dataverse key columns of a semi join (never for anti / antiNullAware on the left)
    if (p.kind === 'semi') this.notNullKeys(p.left, [...p.keyOuter, ...p.corrOuter], 'semi', 'left');
    const left = this.materialize(p.left);
    if (p.kind === 'antiNullAware') {
      const n = p.nKey;
      const o = { kind: 'antiNullAware', left, right, lkeys: outer.slice(0, n), rkeys: inner.slice(0, n) };
      if (outer.length > n) { o.lcorr = outer.slice(n); o.rcorr = inner.slice(n); }
      return new HashJoin(o);
    }
    return new HashJoin({ kind: p.kind, left, right, lkeys: outer, rkeys: inner });
  },
});

// ================================================================================================ correlated blocks (phase 3c)

const CORRELATED_KINDS = new Set(['scalar', 'exists', 'in', 'quantified', 'apply']);

Object.assign(Block.prototype, {
  // Whether a conjunct reads the enclosing query (a correlation conjunct, 02 §3 phase 3c).
  isCorrelation(c) {
    if (!c.comp) return false;
    return (c.comp.outer || EMPTY).some(o => o.depth >= 1);
  },

  // An equality correlation `b.c = e` of a correlation conjunct: b.c a bare column of a FROM source of this block,
  // e reading only the enclosing query, variables and constants (02 §3 phase 3c): {inner, outer} or null.
  spoolEquality(c) {
    const x = strip(c.ast);
    if (!x || x.type !== 'bin' || x.op !== '=' || hasSubquery(x)) return null;
    const side = e => {
      const y = strip(e);
      let r;
      try { r = this.P.compile(y, this.aScope, { errors: [] }); } catch { return null; }
      return { c: r, inner: !!(r.cols && r.cols.length), outer: (r.outer || EMPTY).length > 0, bare: y.type === 'col' && r.src != null };
    };
    const l = side(x.l), r = side(x.r);
    if (!l || !r) return null;
    if (l.bare && !l.outer && !r.inner) return { inner: x.l, outer: x.r, innerC: l.c };
    if (r.bare && !r.outer && !l.inner) return { inner: x.r, outer: x.l, innerC: r.c };
    return null;
  },

  // Splits the WHERE conjuncts of a correlated subquery or APPLY body for the index spool (02 §3 phase 3c (b)):
  // returns {source conjuncts, spool: {eqs, rest} | null}.
  splitCorrelated(conjs) {
    if (!CORRELATED_KINDS.has(this.opts.kind) || !this.rel || this.opts.scratch) return { conjs, spool: null };
    const corr = conjs.filter(c => (c.kind === 'normal' || c.kind === 'semi') && this.isCorrelation(c));
    if (!corr.length) return { conjs, spool: null };
    const eqs = [], rest = [];
    for (const c of corr) {
      const eq = c.kind === 'normal' ? this.spoolEquality(c) : null;
      if (eq) eqs.push({ ...eq, c });
      else rest.push(c);
    }
    if (!eqs.length) return { conjs, spool: null };
    const set = new Set(corr);
    return { conjs: conjs.filter(c => !set.has(c)), spool: { eqs, rest } };
  },

  // The IndexSpool / IndexSeek input of a correlated block (02 §3 phase 3c (b)): S is the FROM tree with the
  // conjuncts that read no outer column; the seek returns S's rows whose keys equal the outer values.
  spoolInput(root, spool) {
    const P = this.P;
    const keys = spool.eqs.map(e => P.compile(e.inner, this.scope, { clause: 'where', errors: [] }));
    const keyExprs = spool.eqs.map(e => P.compile(e.outer, this.scope, { clause: 'where', errors: [] }));
    // keyed mode: the first key is a bare column of a Dataverse FetchScan of S, not through an OUTER link
    let seek = null;
    let scanPiece = null;
    if (!P.noPushdown) {
      for (let i = 0; i < spool.eqs.length && !seek; i++) {
        const idx = keys[i].src;
        const leaf = idx != null ? this.leafAt[idx] : null;
        if (!leaf || leaf.kind !== 'dv') continue;
        const piece = findFbPiece(root, leaf);
        if (!piece) continue;
        const fb = piece.fb;
        fb.chooseRoot();
        if (leaf !== fb.root && !fb.innerChain(leaf)) continue;
        const d = leaf.defs[idx - leaf.start];
        if (!d || d.kind !== 'attr' || NEVER_PUSH.has(d.attr.type) || d.attr.type === 'Virtual' || d.attr.type === 'MultiSelectPicklist') continue;
        seek = { leaf, column: d.attr.logicalName, key: i };
        scanPiece = piece;
      }
    }
    // The spool keys are never NULL in a match: not-null on the Dataverse key columns of S
    for (const e of spool.eqs) {
      const idx = e.innerC.src;
      const leaf = idx != null ? this.leafAt[idx] : null;
      const piece = leaf ? findFbPiece(root, leaf) : null;
      if (piece && !P.noPushdown) this.notNullKeys(piece, [e.inner], 'inner', 'left');
    }
    const S = this.materialize(root);
    let mode = 'full', seekOpt;
    if (seek) {
      const scan = findScan(S, scanPiece.fb);
      if (scan) {
        mode = 'keyed';
        seekOpt = { scan, column: seek.column, entityname: seek.leaf === scanPiece.fb.root ? null : scanPiece.fb.aliases().get(seek.leaf) || null, key: seek.key };
      }
    }
    const spoolNode = new IndexSpool({ kid: S, keys, mode, seek: seekOpt });
    let node = new IndexSeek({ spool: spoolNode, keyExprs });
    if (spool.rest.length) {
      const pred = this.andPred(spool.rest, this.scope);
      node = new Filter({ kid: node, pred });
    }
    return node;
  },
});

// The builder piece of a piece tree that holds a leaf (through joins, semi joins and filters), or null.
function findFbPiece(p, leaf) {
  if (!p) return null;
  if (p.k === 'fb') return p.fb.has(leaf) ? p : null;
  if (p.k === 'join' || p.k === 'apply') return findFbPiece(p.left, leaf) || findFbPiece(p.right, leaf);
  if (p.k === 'semi') return findFbPiece(p.left, leaf);
  return null;
}

// The FetchScan node of a builder inside a materialised plan, or null.
function findScan(node, fb) {
  if (!node) return null;
  if (node instanceof FetchScan && node._fb === fb) return node;
  for (const k of node.kids || EMPTY) {
    const r = findScan(k, fb);
    if (r) return r;
  }
  return null;
}

// ================================================================================================ unique-key joins (phase 3c a)

Object.assign(Block.prototype, {
  // Phase 3c (a): a scalar subquery `(SELECT e FROM b WHERE <equality correlations> [AND p(b)])` whose correlations
  // cover a unique column set of b becomes `LEFT JOIN b AS <generated> ON <correlations> AND p(b)` with the subquery
  // replaced by e over that alias (at most one row can match, so 512 cannot occur). Returns the rewritten core, or
  // null when no subquery qualifies.
  uniqueKeyRewrite(core) {
    if (!core.from || this.P.noPushdown || this.opts.scratch) return null;
    const joins = [];
    const done = new Map();
    const rewrite = x => mapExpr(x, n => {
      if (n.type !== 'subq') return undefined;
      const k = exprKey(n.query);
      if (done.has(k)) return cloneAst(done.get(k));
      const r = this.uniqueKeyJoin(n);
      if (!r) return undefined;
      joins.push(r.join);
      done.set(k, r.expr);
      return r.expr;
    });
    const out = { ...core };
    let changed = false;
    const where = core.where ? rewrite(core.where) : null;
    if (where !== core.where) { out.where = where; changed = true; }
    if (!this.grouped) {
      out.cols = core.cols.map(it => {
        if (!it.expr) return it;
        const e = rewrite(it.expr);
        if (e === it.expr) return it;
        changed = true;
        // a subquery column stays unnamed, as before the rewrite
        const alias = it.alias != null ? it.alias : strip(it.expr).type === 'subq' ? '' : it.alias;
        return { ...it, expr: e, alias };
      });
      if (this.orderBy) {
        const ob = this.orderBy.map(o => {
          const e = rewrite(o.expr);
          if (e !== o.expr) changed = true;
          return e === o.expr ? o : { ...o, expr: e };
        });
        if (changed) this.orderBy = ob;
      }
    }
    if (!changed || !joins.length) return null;
    // the joined table must not make a bare outer column ambiguous (`name` of account next to a joined
    // globaloptionset.name): bare names that resolve in this block are qualified first
    const qualify = x => mapExpr(x, n => {
      if (n.type !== 'col' || n.parts.length !== 1) return undefined;
      let r;
      try { r = resolveColumn(n.parts, this.aScope, null, n); } catch { return n; }
      return r && r.depth === 0 && r.column.qual ? { ...n, parts: [r.column.qual, n.parts[0]] } : n;
    });
    out.cols = out.cols.map(it => (it.expr ? { ...it, expr: qualify(it.expr) } : it));
    if (out.where) out.where = qualify(out.where);
    // an ORDER BY name binds a select-list alias first: such a name stays as written
    const aliases = new Set(out.cols.filter(it => it.alias).map(it => lower(it.alias)));
    if (this.orderBy) {
      this.orderBy = this.orderBy.map(o => {
        const x = strip(o.expr);
        return x && x.type === 'col' && x.parts.length === 1 && aliases.has(lower(x.parts[0])) ? o : { ...o, expr: qualify(o.expr) };
      });
    }
    let from = core.from;
    for (const j of joins) from = { type: 'join', kind: 'left', left: from, right: j.right, on: j.on, pos: from.pos, end: from.end, _generated: true };
    out.from = from;
    return out;
  },

  // The LEFT JOIN of one eligible scalar subquery: {join: {right, on}, expr} or null.
  uniqueKeyJoin(node) {
    const q = node.query;
    if (!q || q.with || q.forJson || q.forXml || q.xmlns || q.offset || q.fetch || q.body.type !== 'core') return null;
    const core = q.body;
    if (!core.from || core.from.type !== 'table' || core.groupBy || core.having || core.distinct || core.into) return null;
    if (core.top) {
      const t = strip(core.top.expr);
      if (core.top.percent || core.top.ties || t.type !== 'lit' || t.v !== 1) return null;
    }
    if (core.cols.length !== 1 || core.cols[0].star || core.cols[0].assign) return null;
    const e = core.cols[0].expr;
    if (hasAggregate(e) || hasWindow(e) || hasSubquery(e) || queryHasNewid(q)) return null;
    const a = this.analyzeSub({ ...q, orderBy: null, body: { ...core, top: null } }, 'scalar');
    if (!a || a.falseExists || a.sub.leaves.length !== 1 || !a.corr.length) return null;
    const leaf = a.sub.leaves[0];
    if (leaf.missing || (leaf.kind !== 'dv' && !leaf.metaTable)) return null;
    // the correlated inner columns must cover the primary key, a metadata id or an alternate key
    const innerCols = new Set();
    for (const k of a.corr) {
      const x = strip(k.inner);
      if (x.type !== 'col') return null;
      let r;
      try { r = resolveColumn(x.parts, a.sub.aScope, null, x); } catch { return null; }
      if (!r || r.depth !== 0) return null;
      innerCols.add(lower(r.column.name));
    }
    if (!this.uniqueSet(leaf, innerCols)) return null;
    for (const ast of a.inner) if (hasSubquery(ast)) return null;
    if (this.subRefs(e, a.sub) === null) return null;
    // requalify: inner columns to the generated alias, outer columns to their own qualifier
    const gen = this.P.genAlias('sq');
    const re = x => this.requalify(x, a.sub, gen);
    const corr = a.corr.map(k => re(k.ast));
    const inner = a.inner.map(re);
    const expr = re(e);
    if ([...corr, ...inner, expr].some(x => x === null)) return null;
    // the generated alias's columns count as referenced (leaves bind only the referenced columns, 02 §3 phase 8)
    for (const x of [...corr, ...inner, expr]) {
      walkAll(x, n => {
        if (n.type === 'col' && n.parts.length === 2 && lower(n.parts[0]) === lower(gen)) this.P.refs.qual.add(lower(gen) + '.' + lower(n.parts[1]));
      });
    }
    const right = { type: 'table', name: core.from.name, alias: gen, hints: core.from.hints || null, pos: core.from.pos, end: core.from.end, _generated: true };
    return { join: { right, on: andOf([...corr, ...inner]) }, expr: { type: 'paren', e: expr, pos: node.pos, end: node.end, _subq: true } };
  },

  // Whether a column set covers a unique key of a leaf: its primary key, metadataid, or an alternate key (meta.keys).
  uniqueSet(leaf, cols) {
    if (leaf.metaTable) return cols.has('metadataid');
    const pk = lower(leaf.entity.primaryIdAttribute);
    if (cols.has(pk)) return true;
    const keys = this.P.pf.keys.get(leaf.entity.logicalName) || EMPTY;
    return keys.some(k => k.attrs && k.attrs.length && k.attrs.every(a => cols.has(lower(a))));
  },

  // An expression of a scratch subquery block with its inner columns qualified by `gen` and its outer columns by
  // their own qualifier (null when one does not bind or has no qualifier).
  requalify(x, sub, gen) {
    let ok = true;
    const out = mapExpr(x, n => {
      if (n.type !== 'col') return undefined;
      let r;
      try { r = resolveColumn(n.parts, sub.aScope, null, n); } catch { ok = false; return n; }
      if (!r) { ok = false; return n; }
      if (r.depth === 0) return { type: 'col', parts: [gen, r.column.name], pos: n.pos, end: n.end };
      if (r.depth === 1 && r.column.qual) return { type: 'col', parts: [r.column.qual, r.column.name], pos: n.pos, end: n.end };
      ok = false;
      return n;
    });
    return ok ? out : null;
  },
});

// ================================================================================================ recursive CTEs

// The top-level UNION ALL members of a recursive CTE body (02 §3 phase 6), or null when another set operator joins
// them (252 is the caller's).
function cteMembers(body) {
  if (body.type === 'setop') {
    if (body.op !== 'UNION' || !body.all) return null;
    const l = cteMembers(body.left), r = cteMembers(body.right);
    return l && r ? [...l, ...r] : null;
  }
  return [body];
}

// The references of a CTE name in a query body: {count, inSub, hinted, outerNull}.
function cteRefs(x, name) {
  const out = { count: 0, inSub: false, hinted: false, outerNull: false };
  const isRef = ts => ts.name.parts.length === 1 && lower(ts.name.parts[0]) === name;
  const subs = e => walkAll(e, n => {
    if (n.type === 'table' && n.name && isRef(n)) { out.count++; out.inSub = true; }
  });
  const visitFrom = (ts, nullSide) => {
    if (!ts) return;
    switch (ts.type) {
      case 'table':
        if (isRef(ts)) {
          out.count++;
          if (ts.hints && ts.hints.length) out.hinted = true;
          if (nullSide) out.outerNull = true;
        }
        return;
      case 'join': {
        const k = ts.kind;
        visitFrom(ts.left, nullSide || k === 'right' || k === 'full');
        visitFrom(ts.right, nullSide || k === 'left' || k === 'full' || k === 'outer apply');
        if (ts.on) subs(ts.on);
        return;
      }
      case 'derived': visitBody(ts.query.body, nullSide); return;
      case 'pivot': case 'unpivot': visitFrom(ts.source, nullSide); return;
      default: return;
    }
  };
  const visitBody = (b, nullSide) => {
    if (b.type === 'core') {
      visitFrom(b.from, nullSide);
      for (const it of b.cols) if (it.expr) subs(it.expr);
      if (b.where) subs(b.where);
      if (b.having) subs(b.having);
    } else if (b.type === 'setop') { visitBody(b.left, nullSide); visitBody(b.right, nullSide); } else if (b.type === 'query') visitBody(b.body, nullSide);
  };
  visitBody(x.type === 'query' ? x.body : x, false);
  return out;
}

Object.assign(Planner.prototype, {
  // A recursive CTE (02 §3 phase 6): anchor members UNION ALL recursive members, iterated by RecursiveCte over the
  // previous level's rows (env.work); the errors 252, 246, 253, 465, 467, 460, 461, 462, 4150 and 240.
  planRecursiveCte(def, outer, ts) {
    const name = lower(def.name);
    const q = def.query;
    const node0 = def.node || ts;
    const members = q.body.type === 'core' ? null : cteMembers(q.body);
    if (!members) throw at(E(252, def.name), node0);
    const info = members.map(m => ({ m, refs: cteRefs(m, name) }));
    const firstRec = info.findIndex(x => x.refs.count);
    if (firstRec < 0) throw at(E(252, def.name), node0);
    if (firstRec === 0) throw at(E(246, def.name), node0);
    if (info.slice(firstRec).some(x => !x.refs.count)) throw at(E(246, def.name), node0);
    const anchors = info.slice(0, firstRec), recs = info.slice(firstRec);
    for (const r of recs) {
      const m = r.m;
      if (r.refs.inSub) throw at(E(465), m);
      if (r.refs.count > 1) throw at(E(253, def.name), m);
      if (r.refs.hinted) throw at(E(4150, def.name), m);
      if (r.refs.outerNull) throw at(E(462, def.name), m);
      const core = m.type === 'core' ? m : m.type === 'query' ? m.body : null;
      if (core && core.type === 'core') {
        if (core.groupBy || core.having || core.cols.some(it => it.expr && hasAggregate(it.expr))) throw at(E(467, def.name), m);
        if (core.distinct) throw at(E(460, def.name), m);
        if (core.top) throw at(E(461, def.name), m);
      }
      if (m.type === 'query' && (m.offset || m.fetch)) throw at(E(461, def.name), m);
    }
    return this.withCteScope(def, () => {
      const anchorNodes = anchors.map(a => this.planSetBody(a.m, outer, {}, false).node);
      let anchor = anchorNodes.length === 1 ? anchorNodes[0] : this.concat(anchorNodes);
      anchor = new Block(this, { cols: [], from: null }, outer, {}).namedNode(anchor, def.columns, def.name, node0);
      const vis = visibleCols(anchor.schema);
      const workSchema = vis.map(i => {
        const { companion, srcKey, hidden, ...rest } = anchor.schema[i];
        return { ...rest, qual: null };
      });
      if (vis.length !== anchor.schema.length) {
        anchor = new Project({ kid: anchor, exprs: vis.map(i => readCol(anchor.schema, i)), schema: workSchema.map(c => ({ ...c })), extra: [] });
      }
      // the recursive members over the working table (the previous level's rows, env.work)
      const own = this.cteScopes[this.cteScopes.length - 1];
      own.set(name, def);
      def.working = true;
      def.workSchema = workSchema;
      let step;
      try {
        const stepNodes = recs.map(r => this.planSetBody(r.m, outer, {}, false).node);
        step = stepNodes.length === 1 ? stepNodes[0] : this.concat(stepNodes);
      } finally {
        def.working = false;
      }
      const sv = visibleCols(step.schema);
      if (sv.length !== workSchema.length) throw at(E(205), node0);
      sv.forEach((i, j) => {
        try {
          commonType(workSchema[j], step.schema[i]);
        } catch {
          throw at(E(240, workSchema[j].name, def.name), node0);
        }
      });
      const max = this.hints.maxrecursion != null ? this.hints.maxrecursion : 100;
      const node = new RecursiveCte({ anchor, step, name, max, schema: workSchema.map(c => ({ ...c })) });
      return { node, info: { recursive: true } };
    });
  },
});

// ================================================================================================ exports

// Plans a query synchronously after prefetch() (01 §7 planSync): the physical operator tree (02 §3 phases 2-9).
// Binding errors (207, 208, 209, 4104, 107) of the whole statement are raised together (combineErrors).
export function planSync(query, ctx) {
  if (!query || query.type !== 'query') throw new TypeError('planSync(query, ctx): query must be a Query AST');
  if (!ctx || typeof ctx !== 'object') throw new TypeError('planSync(query, ctx): ctx is required');
  const P = new Planner(ctx);
  P.refs = referencedNames(query);
  annotateKinds(query);
  const r = P.planQuery(query, ctx.outerScope || null, { kind: 'top', outermost: true });
  if (P.errors.length) throw combineErrors(P.bindErrors());
  const node = r.node;
  if (P.dmlAlias !== undefined && ctx.dml) ctx.dml.alias = P.dmlAlias;
  return node;
}

// Plans a query (02 §3): prefetch() then planSync().
export async function planQuery(query, ctx) {
  await prefetch(query, ctx);
  return planSync(query, ctx);
}


