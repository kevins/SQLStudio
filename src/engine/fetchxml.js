// FetchXML pushdown at run time (02 §4-§5 and §4.5 tier 2; 00 §3): the
// serialisation of the 02 §4 FetchXML model (toXml), every paging strategy with its loop guard (pagingMode, runFetch),
// the response mapping (mapRow), the FetchScan operator and the tier-2 PartitionedAggregate. engine/ code: DOM-free,
// local calendar fields only through env.tz.offset() (types.js), XML only through core/xml.js parseXml and xmlEsc,
// and every request through the api object's fetchXml (api.js builds and checks the URL, 00 §5 rule 5).
//
// Notes:
// - Errors. engine/ cannot import data/api.js (00 §3), so the scan's own Dataverse-side errors are FetchError: an
//   Error with name 'DataverseError' and api.js's fields {code, status, requestId, details}; every check
//   (isAggregateFallback, the session's fault mapping) reads err.name. Internal codes: 'paging' (the loop guard,
//   `Paging did not advance; the query was stopped to avoid duplicate rows.`), 'fake-limit' (an aggregate response of
//   5,000 rows: `Dataverse returned 5,000 aggregate rows, the most one aggregate query can return, so the result may be
//   incomplete.`), 'partition' (tier 2 gave up, the 02 §4.5 text) and 'legacy-paging' (the 02 §4.4 50,000-row error of
//   a scan that is not top-level). A runFetch maxRequests cap raises exec.js's countRequests text (SqlError, code
//   'LIMIT'). isAggregateFallback: every DataverseError except code 'auth', status 429 and the service-protection
//   codes 0x80072321, 0x80072322 and 0x80072326; never an AbortError or a SqlError.
// - Condition values. Condition.value and the items of Condition.values are FetchXML text (strings, written as given),
//   JS values (numbers, booleans, bigints, Dates, Uint8Array; of the column's type unless the extension
//   Condition.valueType gives their static Type) or a compile.js Compiled (a run-time parameter, evaluated per
//   execution with fn([], env) after pre([[]], env)). FetchScan converts every value that is not a string at run time
//   with the 02 §4.2 Constants and Condition-values rules: a string into the column's type with types.coerce (245,
//   8114, 8169, 241 as SQL Server raises them), a number or bigint against an integer column by the `> 1.5 -> ge 2`
//   rules within the column type's range (bit 0-1, Integer/Picklist/State/Status Int32, BigInt Int64: SQL Server
//   converts the column, so `numberofemployees > 3e9` is a contradiction and `< 3e9` not-null; Dataverse parses these
//   values as Int32 / Int64 and would fail), BETWEEN bounds rounded inward and clamped to that range, Decimal and
//   Money against |v| >= 2^96 (beyond .NET Decimal) folded the same way, a datetime against a DateOnly column by the
//   time-part rules, a NULL value a contradiction (an `in` drops NULL items and the items no column value can equal,
//   a `not-in` with a NULL is a contradiction, an emptied `not-in` always holds), dates
//   written by DateTimeBehavior (UserLocal toISOString of the instant, a date value at session-tz midnight;
//   TimeZoneIndependent its session wall clock with Z; DateOnly and on/on-or-before/on-or-after yyyy-MM-dd), GUIDs
//   lower case. Operators whose values are arguments (last-x-days, in-fiscal-period-and-year, contain-values, …) get
//   their values as plain text. A contradiction in the root filter's top-level AND sends no request; one inside an OR
//   drops out of it, and a false link filter becomes `<condition attribute="<link from>" operator="null"/>` (never
//   true). toXml itself writes values generically (numbers plainNumber, bit 1/0, Date toISOString, bytes as their
//   big-endian unsigned integer, a Compiled as its text, `@outer(<text>)` when it reads outer columns): what explain
//   shows for run-time values. formatValue(value, attr, {op, type, tz, dateformat}) gives the planner the same
//   conversion for plan-time constants; it only converts: the folding rules above (integer and Decimal ranges,
//   `= 1.5`, DateOnly time parts) apply to a constant the planner leaves in the fetch as a JS value.
// - toXml's `after` (the keyset tuple) is [{entityname, attr, value, pk}] (value FetchXML text or null; pk false for
//   a distinct attribute), or the bare last values of the fetch's root <order> elements, in order (primary keys).
// - IN lists. toXml writes an `in` of more than 500 values as `<filter type="or">` of 500-value conditions and a
//   `not-in` as `<filter type="and">` of them (02 §4.2). FetchScan splits requests: an env.scanArgs `in` runs at most
//   500 values per request; and while a request would exceed 60,000 characters of encodeURIComponent(xml) plus an
//   allowance for the continuation pages (the keyset filter with every key at its longest value, else a paging cookie
//   holding the root order values and the primary key at their longest, at least 2,000; ASCII estimates from the
//   attribute MaxLength, at most 30,000), the largest top-level AND-ed `in` (a condition, or an OR of `in` conditions
//   on one attribute) is halved, its values first deduplicated by the attribute's comparison key (collKey for strings,
//   lower case for GUIDs), so the chunks are disjoint. Chunks are read through a pool: at most api.dop requests in
//   flight, and a chunk reads one batch ahead of its consumer and then waits, so a chunk that is not being read holds
//   at most one page. Without pushed orders (or with keyset paging, whose orders are its keys) rows come in chunk
//   order, the chunk being read and the next dop - 1 open; with pushed orders a k-way merge of the chunk streams
//   (which arrive sorted) yields batches as it goes, by Dataverse's order (labels for choice/bool without
//   useraworderby and for lookups, else types.cmpKeys of the value; order attributes are requested for it; ties in
//   chunk order). TOP and OFFSET apply after the concatenation or merge: no chunk sends page/count, a chunk of a
//   paged fetch is a TOP of skip + take rows, and every chunk stops after skip + take rows (TOP above 5,000 included).
//   The merge holds one batch per chunk, so it counts no rows against maxScanRows (FetchScan.rowsCounted() stays
//   false). A distinct fetch is deduplicated by rowKey across chunks. Aggregate fetches are never split (one that is
//   too long fails with api.js 'toolong', which isAggregateFallback matches, so tier 3 runs).
// - runFetch options beyond 02 §4: paging (overrides pagingMode), pageSize (the FETCHXML_PAGE_SIZE hint), keys
//   (explicit keyset keys, FetchScan keyCols: [{entityname, attr, pk?}] or 'alias.attr' strings), pk (root primary
//   key), pkOf(name) (a table's primary key; else entity and meta), entity (EntityInfo), meta, topLevel, inBody,
//   elastic, virtual, table (the name in messages), allCount(name) (attribute count of <all-attributes/>),
//   beforeRequest() (called before every request; FetchScan counts settings.maxRequests through exec.js countRequests
//   and stats.requests), warn(text, kind). onPage({xml, ms, rows, request}) runs after each response; `limit` ends the
//   scan after that many rows; maxRequests caps this call's requests.
// - Paging details: TOP above 5,000 (or a TOP with explicit cookie or keyset paging) pages and stops after n rows;
//   TOP 0 sends nothing; `count` without `page` (TOP pushed as count, virtual tables and audit with a link) is cookie
//   paging with that page size. Legacy paging (page numbers) reads exactly 50,000 rows at most: where a whole page
//   would pass the cap, the last request is page 50,000 / c with the least count c >= the rows left that divides
//   50,000 (page × count = 50,000, 0x8004430a), its rows already read skipped; with more rows left, the top-level
//   warning or the error. A continuation page whose encoded FetchXML would exceed 63,000 characters (a paging cookie
//   or a keyset filter with long values; api.js sends at most 64,000-character URLs) is requested by page number
//   instead, which is complete up to the 50,000-row cap (live-findings). Keyset paging whose next-page filter
//   (k(k+1)/2 conditions for k keys) would pass the 500 conditions + links of one fetch pages by page number over the
//   keyset orders from the start. Keyset keys are the
//   02 §4.4 primary keys unless explicit keys are given; an explicit key is a primary key when it says so (pk) or is
//   its table's primary key, and any other key is a distinct attribute: the fetch then keeps distinct="true",
//   otherwise a distinct fetch pages without distinct="true" and is deduplicated by rowKey (02 §4.4 'until then').
//   Keyset needs every inner/outer link's alias and primary key (meta.findEntity), otherwise the fetch pages by page
//   number without a cookie (complete per live-findings) up to the 50,000-row cap. Keyset terms with a NULL
//   primary-key value are omitted (02 §4.4); a NULL value of a distinct-attribute key gives the term `<key> not-null`
//   (ascending order puts NULL first). The loop guard compares cookies without their page
//   attribute, keyset tuples, and first rows by root pk (the key tuple in keyset mode, the whole first record without
//   one); page-number paging over toMany links compares whole pages instead (a root repeats across their first rows).
// - The legacy-paging stop of a top-level scan (FetchScan option topLevel: the planner sets it on a scan whose rows
//   go straight to a top-level result set) emits warn kind 'legacy-paging' with `Showing the first 50,000 rows: <table>
//   returned more than 50,000 rows without a paging cookie. Add a filter or remove the ORDER BY on joined columns.`
// - An aggregate fetch without groupby that returns no row gives one record whose count and countcolumn aliases are 0
//   (02 §4.5); so does one whose binding is a contradiction (no request), in FetchScan and in PartitionedAggregate.
// - Explain: detail and props take the paging runFetch uses (TOP above 5,000: `account (cookie paging, first 6,000
//   rows)`, props Paging mode 'cookie' and Row limit; keyset that does not fit 500 conditions: 'page-number paging',
//   Paging mode 'page numbers').
// - mapRow(json, columns, ctx): ctx {tz, meta, virtual, pk} (an env works). Each column reads srcKey (default its
//   name), then `alias_x002e_x` for `alias.x` or `_x_value` for a bare root key; role 'name' reads its
//   FormattedValue, role 'type' the lookuplogicalname annotation, or the value itself for an EntityName attribute,
//   and for audit.objectid the objecttypecode key; EntityName numbers (object type codes) become logical
//   names through meta.entities(). Values are converted by Column.dt: dates with types.fromServer and the attr's
//   behaviour (UserLocal without an attr), integers (AVG of int truncated toward zero), numbers, bit (a
//   ManagedProperty column's BooleanManagedProperty object by its Value through types.fromServer, any other object
//   with a Value by that Value), GUIDs lower case
//   without braces, Image base64 to bytes, objects as JSON text; text of another type goes through types.coerce
//   (virtual providers). srcKey '@odata.etag' gives the etag text. Virtual tables: keys match
//   case-insensitively, a missing root pk (role 'pk' or srcKey = pk) gets crypto.randomUUID(), and a column with
//   srcKey '@sqlstudio.synthetic' holds 1 on such rows, else 0 (grid.js source.tables[0].syntheticIndex).
// - FetchScan({fetch, entity /* EntityInfo or logical name */, entitySet, schema, paging, pageSize, keyCols, topLevel})
//   plus exec.js's common options; it reads env.api, env.meta, env.tz, env.signal, env.settings.queryInBody and
//   env.scanArgs (see the notes at the top of exec.js). boundFetch(env) gives the fetch of one execution (run-time values bound,
//   scanArgs conditions added; null for a contradiction; a non-aggregate, non-distinct root without attribute
//   elements gets its primary key), displayXml() the FetchXML explain shows: the first request of the most
//   recent execution without paging attributes, else the planned one. stats.requests counts every request sent.
// - archive.t (datasource 'retained'): isArchiveUnavailable on the first request gives no rows and the info message
//   `Long term retention data of <table> is not available (no retention policy has run yet), so archive.<table>
//   returned no rows.`
// - PartitionedAggregate: aggs and keyCount are optional; the layout comes from the tier-1 fetch's aliases through
//   Column.srcKey (given aggs must name aggregate aliases of it), and the hidden name/type companions of group keys
//   take the first partition row's values. A DISTINCT aggregate, or one other than count, countcolumn, sum, avg, min
//   and max, cannot be combined, and the 02 §4.5 eligibility is checked again from the metadata (a standard table, not
//   audit, archive or bin, with a readable UserLocal createdon; without metadata the planner's decision stands): the
//   0x8004e023 error then propagates unchanged (tier 3). Partitions combine in range order, the NULL partition last
//   ('order of first appearance'); the 256 limit counts createdon ranges; a range whose equal-width split has no
//   inner boundary is split at its last whole second. An AVG's partial SUM is mapped as float (int and bigint AVG) or
//   in the AVG's type, its partial COUNT as bigint, and the totals go through functions.js AGGREGATES (COUNT or
//   COUNT_BIG by the column type, SUM, AVG, MIN, MAX), so tier 2 gives tier 3's values and errors. Option dop gives
//   the explain detail before a run (default 4; a run uses env.api.dop). explain() lists the tier-1 FetchXML and the
//   first partition's (the first range's, or the NULL partition's when there is no range), and leaves fetchXml off the
//   kid FetchScan's node, so the FetchXML tab shows the tier-1 text once. Range and partition requests are aborted
//   through a child AbortController linked to env.signal (02 §4.5 give-up); the api must reject aborted reads, as
//   api.js does.

import { SqlError } from './lexer.js';
import { PlanNode, countRequests, emitInfo, emitWarn } from './exec.js';
import { AGGREGATES } from './functions.js';
import {
  fromServer, dtOfAttr, plainNumber, coerce, castValue, dateParts, sessionWallMs, fromWall, collKey, rowKey, cmp,
  sortKey, cmpKeys, variantValue, variantType,
} from './types.js';
import { parseXml, xmlEsc } from '../core/xml.js';

const FV = '@OData.Community.Display.V1.FormattedValue';
const LLN = '@Microsoft.Dynamics.CRM.lookuplogicalname';
const MORE = '@Microsoft.Dynamics.CRM.morerecords';
const COOKIE = '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie';
const ETAG = '@odata.etag';
const SYNTHETIC = '@sqlstudio.synthetic';
const MAX_PAGE = 5000;
const LEGACY_ROWS = 50000;
const IN_CHUNK = 500;
const URL_BUDGET = 60000;
// The most encoded FetchXML characters a continuation page (cookie or keyset filter) is sent with: api.js sends URLs
// of at most 64,000 characters, 1,000 of them left for the origin, the path and the entity set.
const REQUEST_LIMIT = 63000;
const COOKIE_ALLOWANCE = 2000;
const MAX_ELEMENTS = 500;
const MAX_PARTITIONS = 256;
const BATCH = 2000;
const RECORD_LIMIT = '0x8004e023';
const ARCHIVE_CODES = new Set(['0x80097528', '0x8009752b']);
const THROTTLE_CODES = new Set(['0x80072321', '0x80072322', '0x80072326']);
const MODES = ['top', 'page', 'cookie', 'keyset', 'aggregate'];
const DATE_OPS = new Set(['on', 'on-or-before', 'on-or-after']);
const COMPARE_OPS = new Set(['eq', 'ne', 'neq', 'gt', 'ge', 'lt', 'le', 'in', 'not-in', 'between', 'not-between', 'like',
  'not-like', 'begins-with', 'not-begin-with', 'ends-with', 'not-end-with', 'under', 'eq-or-under', 'not-under', 'above',
  'eq-or-above']);
const LOOKUPS = new Set(['Lookup', 'Customer', 'Owner']);
const GUID_ATTRS = new Set(['Lookup', 'Customer', 'Owner', 'Uniqueidentifier']);
const LABEL_SORTED = new Set(['Picklist', 'State', 'Status', 'Boolean']);
const COMBINABLE = new Set(['count', 'countcolumn', 'sum', 'avg', 'min', 'max']);
const GUID_RE = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;
// The values an integer-type column can hold (bit; Integer, Picklist, State, Status: Int32; BigInt: Int64), which
// are also the values Dataverse parses for its conditions (live-findings: Int32 / Int64, else OverflowException).
const INT_RANGES = new Map([
  ['bit', [0n, 1n]],
  ['int', [-2147483648n, 2147483647n]],
  ['bigint', [-9223372036854775808n, 9223372036854775807n]],
]);
// Decimal and Money condition values parse as .NET Decimal: |v| < 2^96 (DEC_MAX_TEXT is its largest value).
const DEC_LIMIT = 2 ** 96;
const DEC_MAX_TEXT = '79228162514264337593543950335';
const EMPTY = Object.freeze([]);
const noop = () => {};
const ONE_ROW = Object.freeze([EMPTY]);

const STR_T = Object.freeze({ dt: 'string', len: -1, unicode: true });
const GUID_T = Object.freeze({ dt: 'guid' });
const INT_T = Object.freeze({ dt: 'int' });
const BIGINT_T = Object.freeze({ dt: 'bigint' });
const FLOAT_T = Object.freeze({ dt: 'float' });
const BIT_T = Object.freeze({ dt: 'bit' });
const DATE_T = Object.freeze({ dt: 'date' });
const DT_T = Object.freeze({ dt: 'datetime' });
const BIN_T = Object.freeze({ dt: 'binary', len: -1 });
const BIGINT_DT = Object.freeze({ name: 'bigint', args: [] });
const USER_LOCAL = Object.freeze({ type: 'DateTime', behavior: 'UserLocal' });
const DATE_ONLY = Object.freeze({ type: 'DateTime', behavior: 'DateOnly' });
const IMAGE = Object.freeze({ type: 'Image' });

// Binding results besides a condition or filter: a contradiction, a condition that always holds, and `x not-null`.
const FALSE = Symbol('false');
const TRUE = Symbol('true');
const NOT_NULL = Symbol('not-null');
// Marks an env.scanArgs `in` condition: at most 500 values per request (see the notes at the top of exec.js).
const SPLIT = Symbol('split');

// --------------------------------------------------------------------------------------------- small helpers

const digits = n => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const p2 = n => String(n).padStart(2, '0');
const p3 = n => String(n).padStart(3, '0');
const p4 = n => String(n).padStart(4, '0');
const prop = (name, value) => ({ name, value: String(value) });
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isCompiled = v => !!v && typeof v === 'object' && typeof v.fn === 'function';
const isBytes = v => v instanceof Uint8Array;
const isLink = x => !!x && typeof x === 'object' && typeof x.linkType === 'string' && typeof x.name === 'string';
const isFilter = x => !!x && typeof x === 'object' && Array.isArray(x.items);
const joined = l => l.linkType === 'inner' || l.linkType === 'outer';
const nz = x => (x === 0 ? 0 : x);
const lower = s => String(s).toLowerCase();

// The reason a scan's own abort carries (a closed generator, a finished chunk run).
const closedReason = () => new DOMException('The scan was closed.', 'AbortError');

// A child AbortController linked to `signal`; dispose() unlinks it and aborts whatever is still in flight.
function linkedController(signal) {
  const ctrl = new AbortController();
  let off = null;
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else {
      const on = () => ctrl.abort(signal.reason);
      signal.addEventListener('abort', on, { once: true });
      off = () => signal.removeEventListener('abort', on);
    }
  }
  return {
    signal: ctrl.signal,
    abort() { if (!ctrl.signal.aborted) ctrl.abort(closedReason()); },
    dispose() {
      if (off) off();
      off = null;
      if (!ctrl.signal.aborted) ctrl.abort(closedReason());
    },
  };
}

// The statement's dop (api.dop, else 4).
const dopOf = env => {
  const d = env && env.api && env.api.dop;
  return typeof d === 'number' && d >= 1 ? Math.floor(d) : 4;
};

// Rows in batches of at most BATCH.
function* batchesOf(rows) {
  for (let i = 0; i < rows.length; i += BATCH) yield i === 0 && rows.length <= BATCH ? rows : rows.slice(i, i + BATCH);
}

// ---------------------------------------------------------------------------------------------------- errors

// A Dataverse-side error raised by the scan itself (02 §1 DataverseError shape and name; see the notes above).
export class FetchError extends Error {
  constructor(message, { code = null, status = null, requestId = null, details = null } = {}) {
    super(message);
    this.name = 'DataverseError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }
}

const loopError = () => new FetchError('Paging did not advance; the query was stopped to avoid duplicate rows.', { code: 'paging' });
const fakeLimit = () => new FetchError('Dataverse returned 5,000 aggregate rows, the most one aggregate query can return, so the result may be incomplete.', { code: 'fake-limit' });
const partitionError = () => new FetchError('The aggregate could not be split into parts of fewer than 50,000 records.', { code: 'partition' });
const legacyText = t => `${t} returned more than 50,000 rows without a paging cookie; add a filter or remove the ORDER BY on joined columns.`;
const legacyWarning = t => `Showing the first 50,000 rows: ${t} returned more than 50,000 rows without a paging cookie. Add a filter or remove the ORDER BY on joined columns.`;
const archiveText = t => `Long term retention data of ${t} is not available (no retention policy has run yet), so archive.${t} returned no rows.`;

// The exec.js maxRequests error (02 §4.4) for a runFetch request cap.
function requestLimit(n) {
  const e = new SqlError(`The statement sent more than ${digits(n)} requests to Dataverse (setting Max requests per statement). Add a filter or raise the limit in Settings.`);
  e.severity = 16;
  e.state = 1;
  e.code = 'LIMIT';
  return e;
}

const isDataverseError = e => !!e && typeof e === 'object' && e.name === 'DataverseError';

// Whether a tier-1 or tier-2 aggregate error falls back to the in-browser aggregate (02 §4.5).
export function isAggregateFallback(err) {
  if (!isDataverseError(err)) return false;
  if (err.code === 'auth') return false;
  if (err.status === 429 || THROTTLE_CODES.has(err.code)) return false;
  return true;
}

// Whether a long-term-retention query failed because no archive exists yet (02 §4.2).
export function isArchiveUnavailable(err) {
  return isDataverseError(err) && ARCHIVE_CODES.has(err.code);
}

const isRecordLimit = e => isDataverseError(e) && e.code === RECORD_LIMIT;

// ------------------------------------------------------------------------------------------- FetchXML text

// The text of a run-time parameter in explain output and the displayed FetchXML.
function paramText(c) {
  const t = String(c.text != null && c.text !== '' ? c.text : c.name || '?');
  return Array.isArray(c.outer) && c.outer.length ? `@outer(${t})` : t;
}

// The big-endian unsigned integer of bytes, as decimal text (binary constants vs integer columns).
function bytesText(b) {
  let n = 0n;
  for (let i = 0; i < b.length; i++) n = (n << 8n) | BigInt(b[i]);
  return n.toString();
}

// FetchXML text of a value (see the notes above: generic forms; FetchScan formats by attribute first).
function valueText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return plainNumber(nz(v));
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (isBytes(v)) return bytesText(v);
  if (isCompiled(v)) return paramText(v);
  return v == null ? '' : String(v);
}

const optionsText = o => (Array.isArray(o) ? o.filter(Boolean).join(',') : o == null ? '' : String(o).trim());

function attr(o, name, v) {
  o.push(' ', name, '="', xmlEsc(valueText(v)), '"');
}

// FetchXML text of a Fetch (02 §4 model): element order attribute, order, link-entity, filter; every attribute value
// and value text escaped with xmlEsc. opts: page, count, cookie (paging-cookie text), after (keyset tuple
// [{entityname, attr, value, pk}]).
export function toXml(fx, opts = {}) {
  if (!fx || typeof fx.entity !== 'string' || !fx.entity) throw new TypeError('toXml: fetch.entity is required');
  const o = ['<fetch'];
  const paging = opts.count != null || opts.page != null;
  if (fx.top != null && !paging) attr(o, 'top', fx.top);
  const count = opts.count != null ? opts.count : fx.top == null ? fx.count : null;
  const page = opts.page != null ? opts.page : fx.top == null ? fx.page : null;
  if (count != null) attr(o, 'count', count);
  if (page != null) attr(o, 'page', page);
  if (opts.cookie != null && opts.cookie !== '') attr(o, 'paging-cookie', opts.cookie);
  if (fx.distinct) attr(o, 'distinct', 'true');
  if (fx.aggregate) attr(o, 'aggregate', 'true');
  if (fx.useraworderby) attr(o, 'useraworderby', 'true');
  if (fx.noLock) attr(o, 'no-lock', 'true');
  if (fx.latematerialize) attr(o, 'latematerialize', 'true');
  if (fx.datasource) attr(o, 'datasource', fx.datasource);
  const options = optionsText(fx.options);
  if (options) attr(o, 'options', options);
  o.push('><entity');
  attr(o, 'name', fx.entity);
  o.push('>');
  body(o, fx, opts.after && opts.after.length ? keysetFilter(afterKeys(opts.after, fx)) : null);
  o.push('</entity></fetch>');
  return o.join('');
}

function body(o, n, extra) {
  if (n.all) o.push('<all-attributes/>');
  else for (const a of n.attrs || EMPTY) attributeXml(o, a);
  for (const od of n.orders || EMPTY) orderXml(o, od);
  for (const l of n.links || EMPTY) linkXml(o, l);
  let f = n.filter && n.filter.items && n.filter.items.length ? n.filter : null;
  if (extra) f = { type: 'and', items: f ? (f.type === 'or' ? [f, extra] : [...f.items, extra]) : [extra] };
  if (f) filterXml(o, f);
}

function attributeXml(o, a) {
  o.push('<attribute');
  attr(o, 'name', a.name);
  if (a.alias) attr(o, 'alias', a.alias);
  if (a.aggregate) attr(o, 'aggregate', a.aggregate);
  if (a.groupby) attr(o, 'groupby', 'true');
  if (a.dategrouping) attr(o, 'dategrouping', a.dategrouping);
  if (a.distinct) attr(o, 'distinct', 'true');
  if (a.usertimezone === true || a.usertimezone === false) attr(o, 'usertimezone', a.usertimezone ? 'true' : 'false');
  o.push('/>');
}

function orderXml(o, od) {
  o.push('<order');
  if (od.alias) attr(o, 'alias', od.alias);
  else {
    if (od.entityname) attr(o, 'entityname', od.entityname);
    attr(o, 'attribute', od.attr);
  }
  if (od.desc) attr(o, 'descending', 'true');
  o.push('/>');
}

function linkXml(o, l) {
  o.push('<link-entity');
  attr(o, 'name', l.name);
  if (l.from) attr(o, 'from', l.from);
  if (l.to) attr(o, 'to', l.to);
  if (l.alias) attr(o, 'alias', l.alias);
  attr(o, 'link-type', l.linkType);
  const inner = [];
  body(inner, l, null);
  if (inner.length) o.push('>', ...inner, '</link-entity>');
  else o.push('/>');
}

function filterXml(o, f) {
  o.push('<filter type="', f.type === 'or' ? 'or' : 'and', '">');
  for (const it of f.items) {
    if (isFilter(it)) filterXml(o, it);
    else if (isLink(it)) linkXml(o, it);
    else conditionXml(o, it);
  }
  o.push('</filter>');
}

function conditionXml(o, c) {
  const vals = Array.isArray(c.values) ? c.values : null;
  if (vals && vals.length > IN_CHUNK && (c.op === 'in' || c.op === 'not-in')) {
    o.push('<filter type="', c.op === 'in' ? 'or' : 'and', '">');
    for (let i = 0; i < vals.length; i += IN_CHUNK) conditionXml(o, { ...c, values: vals.slice(i, i + IN_CHUNK) });
    o.push('</filter>');
    return;
  }
  o.push('<condition');
  if (c.entityname) attr(o, 'entityname', c.entityname);
  attr(o, 'attribute', c.attr);
  attr(o, 'operator', c.op);
  if (c.valueof != null && c.valueof !== '') attr(o, 'valueof', c.valueof);
  if (vals) {
    o.push('>');
    for (const v of vals) o.push('<value>', xmlEsc(valueText(v)), '</value>');
    o.push('</condition>');
    return;
  }
  if (c.value != null) attr(o, 'value', c.value);
  o.push('/>');
}

// The keyset tuple of toXml's `after`: [{entityname, attr, value, pk}], or the bare last values, which then belong to
// the fetch's root orders in order (the keyset orders, primary keys).
function afterKeys(after, fx) {
  if (after.every(k => k && typeof k === 'object' && typeof k.attr === 'string')) return after;
  const orders = (fx.orders || EMPTY).filter(od => !od.alias);
  if (orders.length !== after.length) throw new TypeError('toXml: the keyset tuple needs one value per root <order> of the fetch');
  return orders.map((od, i) => ({ entityname: od.entityname || null, attr: od.attr, value: after[i] == null ? null : valueText(after[i]), pk: true }));
}

const keyCond = (k, op, value) => (value == null ? { entityname: k.entityname || null, attr: k.attr, op } : { entityname: k.entityname || null, attr: k.attr, op, value });

// The keyset filter for the page after `after` (02 §4.4): an OR with one term per key whose last value is not NULL
// (k1 = v1 AND … AND ki > vi; NULL prefix values as `null`); a NULL value of a key that is no primary key gives the
// term `ki not-null` (see the notes above). null when no term remains.
function keysetFilter(after) {
  const terms = [];
  for (let i = 0; i < after.length; i++) {
    const k = after[i];
    if (k.value == null && k.pk !== false) continue;
    const items = [];
    for (let j = 0; j < i; j++) {
      const p = after[j];
      items.push(p.value == null ? keyCond(p, 'null') : keyCond(p, 'eq', p.value));
    }
    items.push(k.value == null ? keyCond(k, 'not-null') : keyCond(k, 'gt', k.value));
    terms.push({ type: 'and', items });
  }
  return terms.length ? { type: 'or', items: terms } : null;
}

// ------------------------------------------------------------------------------------------- paging modes

function hasToMany(links) {
  for (const l of links || EMPTY) {
    if (!joined(l)) continue;
    if (l.toMany || hasToMany(l.links)) return true;
  }
  return false;
}

// The paging strategy of a fetch: 02 §4.4.
export function pagingMode(fx) {
  if (fx.aggregate) return 'aggregate';
  if (fx.top != null) return 'top';
  if (fx.page != null) return 'page';
  if (hasToMany(fx.links)) return 'keyset';
  return 'cookie';
}

// Every attribute element of the root and its joined links, depth first.
function treeAttrs(f) {
  const out = [];
  const walk = n => {
    for (const a of n.attrs || EMPTY) out.push(a);
    for (const l of n.links || EMPTY) if (joined(l)) walk(l);
  };
  walk(f);
  return out;
}

const hasGroupBy = f => treeAttrs(f).some(a => a.groupby);

// The record of an aggregate without groupby over no rows: COUNT = 0, other aggregates NULL (02 §4.5).
function zeroRecord(f) {
  const r = {};
  for (const a of treeAttrs(f)) {
    const k = lower(a.aggregate || '');
    if (a.alias && (k === 'count' || k === 'countcolumn')) r[a.alias] = 0;
  }
  return r;
}

function attrCount(f, o) {
  let n = 0;
  const walk = (node, name) => {
    if (node.all) {
      const c = o.allCount ? o.allCount(name) : null;
      n += typeof c === 'number' ? c : 101;
    } else n += (node.attrs || EMPTY).length;
    for (const l of node.links || EMPTY) if (joined(l)) walk(l, l.name);
  };
  walk(f, f.entity);
  return n;
}

const clampSize = n => Math.min(MAX_PAGE, Math.max(1, Math.floor(n)));

// The page size (02 §4.4 cookie paging): the hint, else 5000 / 1000 above 100 attributes / 500 above 500 or elastic.
function pageSizeOf(f, o) {
  if (f.page == null && f.count != null && f.top == null) return clampSize(f.count);
  let n = typeof o.pageSize === 'number' && o.pageSize >= 1 ? o.pageSize : null;
  if (n == null) {
    const c = attrCount(f, o);
    n = c > 500 ? 500 : c > 100 ? 1000 : MAX_PAGE;
  }
  if (o.elastic) n = Math.min(n, 500);
  return clampSize(n);
}

function pkOfName(name, o) {
  if (o.pkOf) {
    const p = o.pkOf(name);
    if (p) return p;
  }
  const e = o.entity && o.entity.logicalName === lower(name) ? o.entity : null;
  if (e && e.primaryIdAttribute) return e.primaryIdAttribute;
  const m = o.meta;
  if (m) {
    const x = (typeof m.findEntity === 'function' && m.findEntity(name)) || (typeof m.entitySync === 'function' && m.entitySync(name));
    if (x && x.primaryIdAttribute) return x.primaryIdAttribute;
  }
  return null;
}

// A keyset key {entityname, attr, pk, key, alt}: key and alt are its response keys.
function keyOfSpec(entityname, attrName, pk) {
  const a = lower(attrName);
  const e = entityname ? String(entityname) : null;
  return { entityname: e, attr: a, pk, key: e ? `${e}.${a}` : a, alt: e ? `${e}_x002e_${a}` : `_${a}_value` };
}

// An explicit keyset key: {entityname, attr[, pk]} or 'alias.attr'; a key is a primary key when it says so or when
// it is the primary key of its table (then a NULL value omits its term, 02 §4.4).
function normKey(k, f, o) {
  let entityname = null, a;
  if (typeof k === 'string') {
    const dot = k.indexOf('.');
    if (dot > 0) {
      entityname = k.slice(0, dot);
      a = k.slice(dot + 1);
    } else a = k;
  } else {
    if (!k || typeof k.attr !== 'string') throw new TypeError('keyset keys are {entityname, attr} or "alias.attr"');
    entityname = k.entityname || null;
    a = k.attr;
  }
  let pk = typeof k === 'object' && typeof k.pk === 'boolean' ? k.pk : null;
  if (pk == null) {
    const table = entityname ? aliasMap(f).get(String(entityname)) : f.entity;
    const p = table ? pkOfName(table, o) : null;
    pk = !!p && lower(p) === lower(a);
  }
  return keyOfSpec(entityname, a, pk);
}

// The 02 §4.4 keyset keys: the root pk, then the pk of every inner/outer link in DFS order; null when one is unknown.
function pkKeys(f, o) {
  const root = o.pk || pkOfName(f.entity, o);
  if (!root) return null;
  const out = [keyOfSpec(null, root, true)];
  const walk = links => {
    for (const l of links || EMPTY) {
      if (!joined(l)) continue;
      const pk = pkOfName(l.name, o);
      if (!pk || !l.alias) return false;
      out.push(keyOfSpec(l.alias, pk, true));
      if (walk(l.links) === false) return false;
    }
    return true;
  };
  return walk(f.links) ? out : null;
}

function ensureAttrs(attrs, names) {
  const out = (attrs || EMPTY).slice();
  for (const nm of names) if (!out.some(a => lower(a.name) === nm && !a.alias)) out.push({ name: nm });
  return out;
}

// The fetch keyset paging sends: ascending orders on the keys only (link keys as root entityname orders), the keys
// requested, no link orders, and distinct only for explicit keys.
function keysetFetch(f, keys, keepDistinct) {
  const by = new Map();
  for (const k of keys) {
    const a = k.entityname || '';
    if (!by.has(a)) by.set(a, []);
    by.get(a).push(k.attr);
  }
  const withAttrs = (n, alias) => (n.all ? n.attrs : ensureAttrs(n.attrs, by.get(alias) || EMPTY));
  const links = ls => (ls || EMPTY).map(l => (joined(l) ? { ...l, attrs: withAttrs(l, l.alias || ''), orders: [], links: links(l.links) } : l));
  return {
    ...f,
    distinct: keepDistinct ? !!f.distinct : false,
    attrs: withAttrs(f, ''),
    orders: keys.map(k => ({ attr: k.attr, entityname: k.entityname, desc: false })),
    links: links(f.links),
  };
}

// The condition and link-entity elements toXml writes for a fetch (an `in` / `not-in` of more than 500 values is one
// condition per 500 values), semi-join links inside filters included: what Dataverse's 500 limit counts (02 §4.2).
function elementCount(f) {
  let n = 0;
  const filter = fl => {
    for (const it of (fl && fl.items) || EMPTY) {
      if (isFilter(it)) filter(it);
      else if (isLink(it)) link(it);
      else n += Array.isArray(it.values) && it.values.length > IN_CHUNK && (it.op === 'in' || it.op === 'not-in') ? Math.ceil(it.values.length / IN_CHUNK) : 1;
    }
  };
  const link = l => {
    n++;
    for (const c of l.links || EMPTY) link(c);
    filter(l.filter);
  };
  for (const l of f.links || EMPTY) link(l);
  filter(f.filter);
  return n;
}

// Whether keyset paging over k keys stays within the 500 conditions + links of one fetch: its next-page filter adds
// k(k+1)/2 conditions (02 §4.2, §4.4).
const keysetFits = (f, k) => elementCount(f) + (k * (k + 1)) / 2 <= MAX_ELEMENTS;

// The keyset keys explain assumes: the explicit keys, else the root and every inner/outer link (02 §4.4).
function keyCountOf(f, explicit) {
  if (explicit) return explicit.length;
  let n = 1;
  const walk = links => {
    for (const l of links || EMPTY) {
      if (!joined(l)) continue;
      n++;
      walk(l.links);
    }
  };
  walk(f.links);
  return n;
}

// The paging mode of a fetch before its keys are resolved, and its row limit (02 §4.4): TOP above 5,000, or a TOP with
// explicit cookie or keyset paging, pages and stops after n rows.
function pagingOf(fx, paging) {
  let mode = paging || pagingMode(fx), limit = Infinity;
  if (!MODES.includes(mode)) throw new TypeError(`runFetch: unknown paging mode '${mode}'`);
  if (mode === 'top' && fx.top == null) mode = pagingMode(fx);
  if (mode === 'page' && fx.page == null) mode = hasToMany(fx.links) ? 'keyset' : 'cookie';
  if (mode === 'top' && fx.top > MAX_PAGE) mode = hasToMany(fx.links) ? 'keyset' : 'cookie';
  if ((mode === 'cookie' || mode === 'keyset') && fx.top != null) limit = fx.top;
  return { mode, limit };
}

// The paging plan of one fetch: {fetch: the fetch as sent, mode, limit, dedupe, keys, size}. Mode 'pages' is paging
// by page number without a cookie: keyset paging without known keys, or whose next-page filter would pass the 500
// conditions + links of one fetch (then over the keyset orders, a total order of the joined rows).
function planPaging(fx, o) {
  const p = pagingOf(fx, o.paging);
  let f = fx, mode = p.mode, dedupe = false, keys = null;
  if (p.limit !== Infinity) f = { ...f, top: null };
  if (mode === 'keyset') {
    const explicit = Array.isArray(o.keys) && o.keys.length > 0;
    keys = explicit ? o.keys.map(k => normKey(k, f, o)) : pkKeys(f, o);
    if (!keys) mode = 'pages';
    else {
      // Keys that are not primary keys are the distinct attributes, paged with distinct="true"; a distinct
      // fetch paged on primary keys drops distinct="true" and is deduplicated in the browser
      const distinctKeys = explicit && keys.some(k => !k.pk);
      if (f.distinct && !distinctKeys) dedupe = true;
      f = keysetFetch(f, keys, distinctKeys);
      if (!keysetFits(f, keys.length)) {
        mode = 'pages';
        keys = null;
      }
    }
  }
  return { fetch: f, mode, limit: p.limit, dedupe, keys, size: pageSizeOf(f, o) };
}

// The paging cookie text of the annotation: its pagingcookie attribute, URL-decoded twice (02 §4.4).
function cookieOf(ann) {
  if (typeof ann !== 'string' || !ann) return null;
  let raw = null;
  try {
    raw = parseXml(ann).attrs.get('pagingcookie') ?? null;
  } catch {
    const m = /pagingcookie="([^"]*)"/.exec(ann);
    raw = m ? m[1] : null;
  }
  if (raw == null || raw === '') return null;
  try {
    return decodeURIComponent(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

// A cookie without its page number, for the loop guard.
const cookieKey = c => c.replace(/\spage="[^"]*"/, '');

function firstGuard(recs, seen, idOf) {
  if (!recs.length) return;
  const id = idOf(recs[0]);
  if (seen.has(id)) throw loopError();
  seen.add(id);
}

// The keyset value text of a key in a record (raw JSON form, which is the condition form; GUIDs lower case).
function keyValue(rec, k) {
  let v = rec[k.key];
  if (v === undefined) v = rec[k.alt];
  if (v == null) return null;
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return plainNumber(nz(v));
  const s = String(v);
  return GUID_RE.test(s) ? s.replace(/[{}]/g, '').toLowerCase() : s;
}

// The raw record pages of a plan (JSON records, never empty arrays).
async function* pagesOf(plan, o) {
  const api = o.api;
  if (!api || typeof api.fetchXml !== 'function') throw new TypeError('runFetch: options.api with fetchXml(entitySet, xml, options) is required');
  if (!o.entitySet) throw new TypeError('runFetch: options.entitySet is required');
  const ctrl = linkedController(o.signal);
  const max = typeof o.maxRequests === 'number' && o.maxRequests >= 0 ? o.maxRequests : Infinity;
  let n = 0;
  const send = async xml => {
    if (o.signal) o.signal.throwIfAborted();
    if (n >= max) throw requestLimit(max);
    if (o.beforeRequest) o.beforeRequest();
    n++;
    const t0 = performance.now();
    const json = await api.fetchXml(o.entitySet, xml, { signal: ctrl.signal, inBody: !!o.inBody });
    const recs = json && Array.isArray(json.value) ? json.value : EMPTY;
    if (o.onPage) o.onPage({ xml, ms: performance.now() - t0, rows: recs.length, request: n });
    return { json: json || {}, recs };
  };
  try {
    const f = plan.fetch;
    switch (plan.mode) {
      case 'aggregate': {
        const { recs } = await send(toXml(f));
        if (recs.length >= MAX_PAGE) throw fakeLimit();
        if (recs.length) yield recs;
        else if (!hasGroupBy(f)) yield [zeroRecord(f)];
        return;
      }
      case 'top': {
        if (!(f.top > 0)) return;
        const { recs } = await send(toXml(f));
        if (recs.length) yield recs;
        return;
      }
      case 'page': {
        const { recs } = await send(toXml(f));
        if (recs.length) yield recs;
        return;
      }
      case 'keyset':
        yield* keysetPages(plan, o, send);
        return;
      default:
        yield* cookiePages(plan, o, send, plan.mode !== 'pages');
    }
  } finally {
    ctrl.dispose();
  }
}

// The page-number request after the first `read` rows (02 §4.4 legacy paging, up to 50,000 rows): page
// read / size + 1 of `size` rows; where a whole page would pass 50,000 rows, page 50,000 / c of the least count c
// >= the rows left that divides 50,000 (page × count then ends exactly at the cap, 0x8004430a), whose first `skip`
// rows were read already; null at the cap. `read` is a multiple of size below the last page.
function legacyStep(read, size) {
  if (read >= LEGACY_ROWS) return null;
  if (read + size <= LEGACY_ROWS) return { page: read / size + 1, count: size, skip: 0 };
  let c = LEGACY_ROWS - read;
  while (LEGACY_ROWS % c) c++;
  return { page: LEGACY_ROWS / c, count: c, skip: read - (LEGACY_ROWS - c) };
}

// The 50,000-row stop of legacy paging with more rows left: a warning for a top-level scan, else the error.
function legacyStop(o, f) {
  const t = o.table || f.entity;
  if (!o.topLevel) throw new FetchError(legacyText(t), { code: 'legacy-paging' });
  if (o.warn) o.warn(legacyWarning(t), 'legacy-paging');
}

const encodedLength = xml => encodeURIComponent(xml).length;

// Cookie paging, and paging by page number (useCookie false, or when no cookie comes back or it does not fit the
// request) up to 50,000 rows. `read` > 0 continues after that many rows by page number (keysetPages).
async function* cookiePages(plan, o, send, useCookie, read = 0) {
  const f = plan.fetch, size = plan.size;
  const toMany = hasToMany(f.links);
  const pk = o.pk || null;
  const seen = new Set();
  const idOf = r => (pk && !toMany && r[pk] != null ? 'k' + lower(r[pk]) : 'j' + JSON.stringify(r));
  let req = read ? legacyStep(read, size) : { page: 1, count: size, skip: 0 };
  if (!req) {
    legacyStop(o, f);
    return;
  }
  let xml = toXml(f, { count: req.count, page: req.page }), prev = null, prevPage = null;
  for (;;) {
    const { json, recs: got } = await send(xml);
    const recs = req.skip ? got.slice(req.skip) : got;
    if (toMany && !useCookie) {
      // page numbers over toMany links: one root's joined rows span pages, so whole pages are compared
      const sig = recs.length ? recs.length + JSON.stringify(recs[0]) + JSON.stringify(recs[recs.length - 1]) : '';
      if (sig && sig === prevPage) throw loopError();
      prevPage = sig;
    } else firstGuard(recs, seen, idOf);
    if (recs.length) yield recs;
    if (json[MORE] !== true) return;
    const done = req.page * req.count;
    const next = useCookie && req.count === size ? cookieOf(json[COOKIE]) : null;
    if (next != null) {
      const k = cookieKey(next);
      if (k === prev) throw loopError();
      prev = k;
      const x = toXml(f, { count: size, page: req.page + 1, cookie: next });
      if (encodedLength(x) <= REQUEST_LIMIT) {
        req = { page: req.page + 1, count: size, skip: 0 };
        xml = x;
        continue;
      }
      // a cookie that does not fit the request (long order values): this page by its number, as without a cookie
    }
    // legacy paging: page numbers without a cookie, up to 50,000 rows (02 §4.4)
    req = legacyStep(done, size);
    if (!req) {
      legacyStop(o, f);
      return;
    }
    xml = toXml(f, { count: req.count, page: req.page });
  }
}

async function* keysetPages(plan, o, send) {
  const f = plan.fetch, keys = plan.keys, size = plan.size;
  const seen = new Set();
  const idOf = r => JSON.stringify(keys.map(k => keyValue(r, k)));
  let xml = toXml(f, { count: size, page: 1 }), prev = null, read = 0;
  for (;;) {
    const { json, recs } = await send(xml);
    firstGuard(recs, seen, idOf);
    if (recs.length) yield recs;
    if (json[MORE] !== true || recs.length < size) return;
    read += recs.length;
    const last = recs[recs.length - 1];
    const tuple = keys.map(k => keyValue(last, k));
    const t = JSON.stringify(tuple);
    if (t === prev) throw loopError();
    prev = t;
    const after = keys.map((k, i) => ({ entityname: k.entityname, attr: k.attr, value: tuple[i], pk: k.pk }));
    if (!keysetFilter(after)) return;
    xml = toXml(f, { count: size, page: 1, after });
    if (encodedLength(xml) > REQUEST_LIMIT) {
      // the keyset filter does not fit the request (long key values): the rest by page number over the same
      // orders, which is complete up to 50,000 rows (live-findings Paging correctness)
      yield* cookiePages(plan, o, send, false, read);
      return;
    }
  }
}

const mapOpts = o => ({ tz: o.tz, meta: o.meta || null, virtual: !!o.virtual, pk: o.pk || null });

// Runs one fetch with its paging (02 §4.4) and yields mapped Row[] batches (02 §5); options: see the notes above.
export async function* runFetch(fx, opts = {}) {
  if (!fx || typeof fx.entity !== 'string') throw new TypeError('runFetch: fetch.entity is required');
  const columns = opts.columns || EMPTY;
  const plan = planPaging(fx, opts);
  const map = rowMapper(columns, mapOpts(opts));
  let left = Math.min(typeof opts.limit === 'number' ? opts.limit : Infinity, plan.limit);
  if (!(left > 0)) return;
  const seen = plan.dedupe ? new Set() : null;
  for await (const recs of pagesOf(plan, opts)) {
    const rows = [];
    for (let i = 0; i < recs.length && left > 0; i++) {
      const row = map(recs[i]);
      if (seen) {
        const k = rowKey(row, columns);
        if (seen.has(k)) continue;
        seen.add(k);
      }
      rows.push(row);
      left--;
    }
    if (rows.length) yield rows;
    if (left <= 0) return;
  }
}

// ------------------------------------------------------------------------------------------------ mapRow

function candidates(key) {
  const out = [key];
  if (key.startsWith('@')) return out;
  const dot = key.indexOf('.');
  if (dot > 0) out.push(key.slice(0, dot) + '_x002e_' + key.slice(dot + 1));
  else if (!key.startsWith('_')) out.push(`_${key}_value`);
  return out;
}

// A reader of the first present key of `keys` (JSON null and missing keys give null).
function reader(keys) {
  if (keys.length === 1) {
    const k = keys[0];
    if (!(k in Object.prototype)) return j => { const v = j[k]; return v === undefined ? null : v; };
    return j => (own(j, k) && j[k] !== undefined ? j[k] : null);
  }
  return j => {
    for (const k of keys) {
      const v = j[k];
      if (v !== undefined && own(j, k)) return v;
    }
    return null;
  };
}

const siblingKey = (key, name) => {
  const dot = key.indexOf('.');
  return dot > 0 ? key.slice(0, dot + 1) + name : name;
};

const OTC = new WeakMap();

// The logical name of an EntityName value: logical names as they are (lower case), object type codes through
// meta.entities().
function entityName(v, o) {
  if (v == null) return null;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
    const m = o.meta;
    if (m && typeof m.entities === 'function') {
      const list = m.entities() || EMPTY;
      let c = OTC.get(m);
      if (!c || c.list !== list) {
        c = { list, map: new Map() };
        for (const e of list) if (e && e.objectTypeCode != null) c.map.set(Number(e.objectTypeCode), e.logicalName);
        OTC.set(m, c);
      }
      const name = c.map.get(Number(v));
      if (name) return name;
    }
    return String(v);
  }
  return lower(v);
}

function toInt(v, c, o) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? nz(v) : nz(Math.trunc(v));
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  const x = coerce(String(v).trim(), STR_T, c, o);
  return typeof x === 'number' && !Number.isInteger(x) ? nz(Math.trunc(x)) : x;
}

function toNum(v, c, o) {
  if (v == null) return null;
  if (typeof v === 'number') return nz(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  return coerce(String(v).trim(), STR_T, c, o);
}

// A bit value: booleans and numbers, text through types.coerce (245), and an object with a Value (a
// BooleanManagedProperty that reached a bit column without its ManagedProperty attr) by that Value.
function toBit(v, o) {
  if (v == null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v ? 1 : 0;
  if (typeof v === 'object') return own(v, 'Value') ? toBit(v.Value, o) : coerce(JSON.stringify(v), STR_T, BIT_T, o);
  return coerce(String(v).trim(), STR_T, BIT_T, o);
}

function toGuid(v) {
  if (v == null) return null;
  const s = String(v);
  const m = GUID_RE.exec(s.trim());
  return m ? m[1].toLowerCase() : s.toLowerCase();
}

function toBytes(v) {
  if (v == null) return null;
  if (isBytes(v)) return v;
  return fromServer(String(v), IMAGE);
}

function toText(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function converter(c, o) {
  const a = c.attr || null;
  switch (c.dt) {
    case 'datetime': case 'date': {
      const da = a && a.type === 'DateTime' ? a : c.dt === 'date' ? DATE_ONLY : USER_LOCAL;
      return v => (v == null ? null : v instanceof Date ? v : fromServer(String(v), da, o.tz));
    }
    case 'int': case 'bigint': return v => toInt(v, c, o);
    case 'decimal': case 'money': case 'float': return v => toNum(v, c, o);
    // a ManagedProperty column (iscustomizable, ishidden, …) is a BooleanManagedProperty object: its Value (types.js)
    case 'bit': return a && a.type === 'ManagedProperty' ? v => (v == null ? null : fromServer(v, a, o.tz)) : v => toBit(v, o);
    case 'guid': return toGuid;
    case 'binary': return toBytes;
    case 'string': return a && a.type === 'EntityName' ? v => entityName(v, o) : toText;
    default: return v => (v === undefined ? null : v);
  }
}

function getterOf(c, o) {
  const key = String(c.srcKey != null ? c.srcKey : c.name || '');
  if (key === ETAG) return j => { const v = j[ETAG]; return typeof v === 'string' ? v : null; };
  const keys = candidates(key);
  const a = c.attr || null;
  if (c.role === 'name') {
    const r = reader(keys.map(k => k + FV));
    return j => { const v = r(j); return v == null ? null : String(v); };
  }
  if (c.role === 'type') {
    if (a && a.entity === 'audit' && a.logicalName === 'objectid') {
      const r = reader(candidates(siblingKey(key.replace(/^_objectid_value$/, 'objectid'), 'objecttypecode')));
      return j => entityName(r(j), o);
    }
    if (a && a.type === 'EntityName') {
      const r = reader(keys);
      return j => entityName(r(j), o);
    }
    const r = reader(keys.map(k => k + LLN));
    return j => { const v = r(j); return v == null ? null : lower(v); };
  }
  const r = reader(keys), conv = converter(c, o);
  return j => conv(r(j));
}

const isRootPk = (c, pk) => c.role === 'pk' || String(c.srcKey != null ? c.srcKey : c.name || '') === pk;

// A record with every attribute part of its keys also in lower case (virtual providers).
function foldKeys(json) {
  const out = Object.create(null);
  for (const k of Object.keys(json)) {
    const at = k.indexOf('@');
    const nk = at < 0 ? k.toLowerCase() : at === 0 ? k : k.slice(0, at).toLowerCase() + k.slice(at);
    if (!(k in out)) out[k] = json[k];
    if (!(nk in out)) out[nk] = json[k];
  }
  return out;
}

// A function from a response record to its row over `columns` (02 §5; see the notes above).
function rowMapper(columns, o) {
  const n = columns.length;
  const get = new Array(n);
  const pks = [];
  let synth = -1;
  for (let i = 0; i < n; i++) {
    const c = columns[i] || {};
    if (c.srcKey === SYNTHETIC) {
      synth = i;
      get[i] = () => 0;
      continue;
    }
    get[i] = getterOf(c, o);
    if (o.virtual && o.pk && isRootPk(c, o.pk)) pks.push(i);
  }
  if (!o.virtual) {
    return json => {
      const row = new Array(n);
      for (let i = 0; i < n; i++) row[i] = get[i](json);
      return row;
    };
  }
  return json => {
    const j = foldKeys(json);
    const row = new Array(n);
    for (let i = 0; i < n; i++) row[i] = get[i](j);
    if (pks.length && row[pks[0]] == null) {
      const id = crypto.randomUUID();
      for (const i of pks) row[i] = id;
      if (synth >= 0) row[synth] = 1;
    }
    return row;
  };
}

const MAPPERS = new WeakMap();

// Maps one Web API record to a row over `columns` (02 §5); ctx {tz, meta, virtual, pk}, e.g. the env.
export function mapRow(json, columns, ctx) {
  const o = mapOpts(ctx || {});
  let m = MAPPERS.get(columns);
  if (!m || m.tz !== o.tz || m.meta !== o.meta || m.virtual !== o.virtual || m.pk !== o.pk) {
    m = { ...o, fn: rowMapper(columns, o) };
    MAPPERS.set(columns, m);
  }
  return m.fn(json && typeof json === 'object' ? json : {});
}

// ---------------------------------------------------------------------------------- condition binding

const ymd = p => `${p4(p.y)}-${p2(p.m)}-${p2(p.d)}`;

function utcDay(y, m, d) {
  const x = new Date(0);
  x.setUTCFullYear(y, m - 1, d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function utcFields(d) {
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function wallIso(W) {
  const w = new Date(W);
  const ms = w.getUTCMilliseconds();
  return `${p4(w.getUTCFullYear())}-${p2(w.getUTCMonth() + 1)}-${p2(w.getUTCDate())}T${p2(w.getUTCHours())}:${p2(w.getUTCMinutes())}:${p2(w.getUTCSeconds())}${ms ? '.' + p3(ms) : ''}Z`;
}

// The FetchXML text of a date value t (static type tt) for attribute attr and operator op (02 §4.2).
function dateText(d, tt, attr, op, tz) {
  const isDate = !!tt && tt.dt === 'date';
  if (DATE_OPS.has(op) || (attr && attr.behavior === 'DateOnly')) return ymd(isDate ? utcFields(d) : dateParts(d, tz));
  if (attr && attr.behavior === 'TimeZoneIndependent') return wallIso(sessionWallMs(d, tt || DT_T, tz));
  if (isDate) return new Date(fromWall(d.getTime(), tz)).toISOString();
  return new Date(d.getTime()).toISOString();
}

// The static type of a JS value without one: a Date is of the column's date type (a DateOnly column holds dates at
// UTC midnight), other values by their JS type (see the notes above: JS values are of the column's type).
function inferType(v, T) {
  if (typeof v === 'string') return STR_T;
  if (typeof v === 'number') return Number.isInteger(v) ? INT_T : FLOAT_T;
  if (typeof v === 'boolean') return BIT_T;
  if (typeof v === 'bigint') return BIGINT_T;
  if (v instanceof Date) return T && T.dt === 'date' ? DATE_T : DT_T;
  if (isBytes(v)) return BIN_T;
  return STR_T;
}

// A value converted into the column type T (02 §4.2 Constants): {v, t} with t the value's static type.
function prep(v, vt, T, env) {
  const from = vt || inferType(v, T);
  if (!T) return { v, t: from };
  switch (T.dt) {
    case 'string':
      return { v: typeof v === 'string' ? v : coerce(v, from, STR_T, env), t: STR_T };
    case 'guid': {
      if (typeof v === 'string') {
        const m = GUID_RE.exec(v.trim());
        if (m) return { v: m[1].toLowerCase(), t: GUID_T };
      }
      return { v: coerce(v, from, GUID_T, env), t: GUID_T };
    }
    case 'int': case 'bigint': case 'decimal': case 'float': case 'money': case 'bit':
      if (typeof v === 'number') return { v, t: from };
      if (typeof v === 'boolean') return { v: v ? 1 : 0, t: BIT_T };
      if (typeof v === 'bigint') return { v, t: BIGINT_T };
      if (isBytes(v)) return { v: castValue(v, BIN_T, BIGINT_DT, env), t: BIGINT_T };
      return { v: coerce(v, from, T.dt === 'bit' ? BIT_T : T, env), t: T };
    case 'datetime': case 'date': {
      const tt = T.dt === 'date' ? DATE_T : DT_T;
      if (v instanceof Date) return { v, t: from.dt === 'date' || from.dt === 'datetime' ? from : tt };
      return { v: coerce(v, from, tt, env), t: tt };
    }
    default:
      return { v, t: from };
  }
}

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

// An integer as a condition value: a number while it is exact, else the bigint.
const intValue = g => ({ v: g <= MAX_SAFE_BIG && g >= -MAX_SAFE_BIG ? Number(g) : g, t: INT_T });

// The exact integer of v rounded toward +Infinity (up) or -Infinity, as a bigint; ±Infinity just outside [lo, hi];
// null for NaN.
function exactInt(v, up, lo, hi) {
  if (typeof v === 'bigint') return v;
  if (Number.isNaN(v)) return null;
  if (v === Infinity) return hi + 1n;
  if (v === -Infinity) return lo - 1n;
  return BigInt(up ? Math.ceil(v) : Math.floor(v));
}

// The integer-column rules of 02 §4.2 (`> 1.5` -> `ge 2`, `= 1.5` a contradiction, …) within the values the column
// type holds (INT_RANGES): SQL Server converts the column to the constant's type, so a value no column value can
// reach folds (`numberofemployees > 3e9` a contradiction, `< 3e9` not-null) and is never sent (Dataverse parses
// integer condition values as Int32 / Int64).
function intRule(op, p, dt) {
  const [lo, hi] = INT_RANGES.get(dt);
  const v = p.v;
  if (typeof v === 'number' && Number.isNaN(v)) return FALSE;
  const int = typeof v === 'bigint' || Number.isInteger(v) || !Number.isFinite(v);
  const x = int ? exactInt(v, true, lo, hi) : null;
  const inRange = int && x >= lo && x <= hi;
  // bit keeps its 0/1 form (`> 0` -> `ge 1`); other integer columns keep an integral value as written
  const keep = int && dt !== 'bit';
  switch (op) {
    case 'eq': return inRange ? { op, p } : FALSE;
    case 'ne': case 'neq': return inRange ? { op, p } : NOT_NULL;
    case 'gt': case 'ge': {
      // the least integer the condition holds for
      const g = int ? (op === 'gt' ? x + 1n : x) : exactInt(op === 'gt' ? Math.floor(v) + 1 : Math.ceil(v), true, lo, hi);
      if (g <= lo) return NOT_NULL;
      if (g > hi) return FALSE;
      return keep ? { op, p } : { op: 'ge', p: intValue(g) };
    }
    case 'lt': case 'le': {
      // the greatest integer the condition holds for
      const g = int ? (op === 'lt' ? x - 1n : x) : exactInt(op === 'lt' ? Math.ceil(v) - 1 : Math.floor(v), false, lo, hi);
      if (g >= hi) return NOT_NULL;
      if (g < lo) return FALSE;
      return keep ? { op, p } : { op: 'le', p: intValue(g) };
    }
    default: return { op, p };
  }
}

// Decimal and Money columns vs a number no .NET Decimal reaches (|v| >= 2^96): SQL Server compares exactly (the
// column is converted), Dataverse would refuse the value, so the comparison folds like intRule's.
function decRule(op, p) {
  const v = p.v;
  if (Number.isNaN(v)) return FALSE;
  if (Math.abs(v) < DEC_LIMIT) return { op, p };
  const above = v > 0;
  switch (op) {
    case 'eq': return FALSE;
    case 'ne': case 'neq': return NOT_NULL;
    case 'gt': case 'ge': return above ? FALSE : NOT_NULL;
    case 'lt': case 'le': return above ? NOT_NULL : FALSE;
    default: return { op, p };
  }
}

function dayOf(p, tz) {
  if (p.t && p.t.dt === 'date') return { day: p, time: false };
  const d = dateParts(p.v, tz);
  return { day: { v: utcDay(d.y, d.m, d.d), t: DATE_T }, time: !!(d.h || d.mi || d.s || d.ms || d.tk) };
}

// The DateOnly rules of 02 §4.2 for a datetime value t: `= t` a contradiction, `> t` -> `gt date(t)`, …
function dateRule(op, p, tz) {
  const { day, time } = dayOf(p, tz);
  if (!time) return { op, p: day };
  switch (op) {
    case 'eq': return FALSE;
    case 'ne': case 'neq': return NOT_NULL;
    case 'gt': case 'ge': return { op: 'gt', p: day };
    case 'lt': case 'le': return { op: 'le', p: day };
    default: return { op, p: day };
  }
}

function adjust(op, p, T, tz) {
  if (!T) return { op, p };
  if (INT_RANGES.has(T.dt) && (typeof p.v === 'number' || typeof p.v === 'bigint')) return intRule(op, p, T.dt);
  if ((T.dt === 'decimal' || T.dt === 'money') && typeof p.v === 'number') return decRule(op, p);
  if (T.dt === 'date' && p.v instanceof Date && !DATE_OPS.has(op)) return dateRule(op, p, tz);
  return { op, p };
}

function fmt(p, attr, op, tz) {
  const v = p.v;
  if (v instanceof Date) return dateText(v, p.t, attr, op, tz);
  if (typeof v === 'string') return attr && GUID_ATTRS.has(attr.type) ? v.toLowerCase() : v;
  return valueText(v);
}

function strip(c) {
  const { value: _v, values: _vs, valueType: _t, ...rest } = c;
  return rest;
}

function bindSingle(c, x, attr, env) {
  const op = c.op;
  if (x.v == null) return FALSE;
  if (!COMPARE_OPS.has(op) && !DATE_OPS.has(op)) return { ...strip(c), value: valueText(x.v) };
  const T = attr ? dtOfAttr(attr) : null;
  const r = adjust(op, prep(x.v, x.t, T, env), T, env.tz);
  if (r === FALSE || r === TRUE || r === NOT_NULL) return r;
  return { ...strip(c), op: r.op, value: fmt(r.p, attr, r.op, env.tz) };
}

const isNumeric = v => typeof v === 'number' || typeof v === 'bigint';

// BETWEEN / NOT BETWEEN bounds (02 §4.2): integer columns round the bounds inward and clamp them to the type's range,
// Decimal and Money clamp them to the .NET Decimal range, DateOnly takes whole days; an empty range is a
// contradiction (BETWEEN) or not-null (NOT BETWEEN). Clamping is exact for both: no column value lies outside.
function bindRange(c, vals, attr, T, env) {
  if (vals.length !== 2 || vals.some(x => x.v == null)) return FALSE;
  const empty = c.op === 'between' ? FALSE : NOT_NULL;
  let a = prep(vals[0].v, vals[0].t, T, env), b = prep(vals[1].v, vals[1].t, T, env);
  if (T && INT_RANGES.has(T.dt) && isNumeric(a.v) && isNumeric(b.v)) {
    const [lo, hi] = INT_RANGES.get(T.dt);
    const x = exactInt(a.v, true, lo, hi), y = exactInt(b.v, false, lo, hi);
    if (x == null || y == null) return FALSE;
    const from = x < lo ? lo : x, to = y > hi ? hi : y;
    if (from > to) return empty;
    return { ...strip(c), values: [valueText(intValue(from).v), valueText(intValue(to).v)] };
  }
  if (T && (T.dt === 'decimal' || T.dt === 'money') && typeof a.v === 'number' && typeof b.v === 'number') {
    if (Number.isNaN(a.v) || Number.isNaN(b.v)) return FALSE;
    if (a.v > b.v || a.v >= DEC_LIMIT || b.v <= -DEC_LIMIT) return empty;
    const from = a.v <= -DEC_LIMIT ? '-' + DEC_MAX_TEXT : fmt(a, attr, c.op, env.tz);
    const to = b.v >= DEC_LIMIT ? DEC_MAX_TEXT : fmt(b, attr, c.op, env.tz);
    return { ...strip(c), values: [from, to] };
  }
  if (T && T.dt === 'date' && a.v instanceof Date && b.v instanceof Date) {
    const da = dayOf(a, env.tz);
    a = da.time ? { v: new Date(da.day.v.getTime() + 86400000), t: DATE_T } : da.day;
    b = dayOf(b, env.tz).day;
  }
  const av = a.v instanceof Date ? a.v.getTime() : a.v, bv = b.v instanceof Date ? b.v.getTime() : b.v;
  if (isNumeric(av) && isNumeric(bv) && av > bv) return empty;
  return { ...strip(c), values: [fmt(a, attr, c.op, env.tz), fmt(b, attr, c.op, env.tz)] };
}

function bindMulti(c, vals, attr, env) {
  const op = c.op;
  if (!COMPARE_OPS.has(op) && !DATE_OPS.has(op)) {
    if (op === 'contain-values' || op === 'not-contain-values') {
      const out = vals.filter(x => x.v != null).map(x => valueText(x.v));
      return out.length ? { ...strip(c), values: out } : FALSE;
    }
    if (vals.some(x => x.v == null)) return FALSE;
    return { ...strip(c), values: vals.map(x => valueText(x.v)) };
  }
  const T = attr ? dtOfAttr(attr) : null;
  if (op === 'between' || op === 'not-between') return bindRange(c, vals, attr, T, env);
  const neg = op === 'not-in';
  const out = [];
  for (const x of vals) {
    if (x.v == null) {
      if (neg) return FALSE;
      continue;
    }
    // a value no row can equal (1.5 for an integer column, a time part for a DateOnly column) is left out
    const r = adjust('eq', prep(x.v, x.t, T, env), T, env.tz);
    if (r === FALSE || r === TRUE || r === NOT_NULL) continue;
    out.push(fmt(r.p, attr, op, env.tz));
  }
  if (!out.length) return neg ? TRUE : FALSE;
  return { ...strip(c), values: out };
}

function needsBinding(c) {
  if (c[SPLIT]) return true;
  if (Array.isArray(c.values)) {
    for (const v of c.values) if (typeof v !== 'string') return true;
    return false;
  }
  return c.value != null && typeof c.value !== 'string';
}

// Binds the values of one execution into a fetch's filters (see the notes above: Condition values).
class Binder {
  constructor(cx, env) {
    this.cx = cx;
    this.env = env || {};
  }

  async filter(f, ent) {
    const and = f.type !== 'or';
    const src = f.items || EMPTY;
    const items = [];
    for (const it of src) {
      const r = isFilter(it) ? await this.filter(it, ent) : isLink(it) ? await this.link(it) : await this.cond(it, ent);
      if (r === FALSE) {
        if (and) return FALSE;
        continue;
      }
      if (r === TRUE) {
        if (!and) return TRUE;
        continue;
      }
      items.push(r);
    }
    if (!items.length) return and || !src.length ? TRUE : FALSE;
    return { ...f, type: and ? 'and' : 'or', items };
  }

  async link(l) {
    const out = { ...l };
    if (l.filter && (l.filter.items || EMPTY).length) {
      const r = await this.filter(l.filter, l.name);
      out.filter = r === FALSE ? { type: 'and', items: [{ entityname: null, attr: l.from, op: 'null' }] } : r === TRUE ? null : r;
    }
    if (Array.isArray(l.links) && l.links.length) out.links = await this.links(l.links);
    return out;
  }

  async links(ls) {
    const out = new Array(ls.length);
    for (let i = 0; i < ls.length; i++) out[i] = await this.link(ls[i]);
    return out;
  }

  async cond(c, ent) {
    if (!c || typeof c !== 'object' || !needsBinding(c)) return c;
    const en = c.entityname ? this.cx.aliases.get(String(c.entityname)) || this.cx.aliases.get(lower(c.entityname)) || null : ent;
    const a = en ? this.cx.attrOf(en, c.attr) : null;
    let r;
    if (Array.isArray(c.values)) {
      const vals = [];
      for (const v of c.values) vals.push(await this.value(v, c));
      r = bindMulti(c, vals, a, this.env);
    } else r = bindSingle(c, await this.value(c.value, c), a, this.env);
    return r === NOT_NULL ? { ...strip(c), op: 'not-null' } : r;
  }

  async value(v, c) {
    if (isCompiled(v)) {
      if (v.pre) await v.pre(ONE_ROW, this.env);
      let x = v.fn(EMPTY, this.env), t = v;
      if (x != null && (t.dt === 'any' || t.dt === 'null')) {
        t = variantType(x);
        x = variantValue(x);
      }
      return { v: x === undefined ? null : x, t };
    }
    return { v: v === undefined ? null : v, t: c.valueType || null };
  }
}

// Converts a value into the FetchXML text of a condition on `attr` (02 §4.2 Constants and Condition values); the
// planner's plan-time constants (see the notes above). null for a NULL value.
export function formatValue(value, attr, opts = {}) {
  if (value == null) return null;
  const env = { tz: opts.tz, dateformat: opts.dateformat };
  const T = attr ? dtOfAttr(attr) : null;
  const op = opts.op || 'eq';
  return fmt(prep(value, opts.type || null, T, env), attr || null, op, opts.tz);
}

// ------------------------------------------------------------------------------------ request splitting

// alias -> link-entity name, over joined links and the semi-join links inside filters.
function aliasMap(fx) {
  const m = new Map();
  const walkFilter = f => {
    for (const it of (f && f.items) || EMPTY) {
      if (isFilter(it)) walkFilter(it);
      else if (isLink(it)) walkLink(it);
    }
  };
  const walkLink = l => {
    if (l.alias) m.set(String(l.alias), lower(l.name));
    for (const c of l.links || EMPTY) walkLink(c);
    walkFilter(l.filter);
  };
  for (const l of fx.links || EMPTY) walkLink(l);
  walkFilter(fx.filter);
  return m;
}

const rootItems = f => (f.filter ? (f.filter.type === 'or' ? [f.filter] : f.filter.items) : EMPTY);

function replaceItem(f, i, item) {
  const items = rootItems(f).slice();
  items[i] = item;
  return { ...f, filter: { type: 'and', items } };
}

// The IN group at a top-level AND position: an `in` condition, or an OR of `in` conditions on one attribute.
function groupAt(item, i) {
  if (!item || typeof item !== 'object') return null;
  if (!isFilter(item) && !isLink(item) && item.op === 'in' && Array.isArray(item.values)) {
    return { i, entityname: item.entityname || null, attr: item.attr, values: item.values, split: !!item[SPLIT] };
  }
  if (isFilter(item) && item.type === 'or' && item.items.length) {
    const first = item.items[0];
    if (!item.items.every(c => !isFilter(c) && !isLink(c) && c.op === 'in' && Array.isArray(c.values) && c.attr === first.attr && (c.entityname || null) === (first.entityname || null))) return null;
    return { i, entityname: first.entityname || null, attr: first.attr, values: item.items.flatMap(c => c.values), split: item.items.some(c => !!c[SPLIT]) };
  }
  return null;
}

// A placeholder of the longest value text of an attribute (ASCII, one encoded character each) in a keyset condition,
// or in a paging cookie (`cookie`: GUIDs in braces): strings at their MaxLength (at most 4,000), GUIDs 36
// characters, dates 24, numbers 40; an unknown attribute as a GUID.
function sampleValue(a, cookie) {
  const dt = a ? dtOfAttr(a).dt : 'guid';
  let n;
  switch (dt) {
    case 'string': n = Math.min(4000, Math.max(1, a.maxLength || 100)); break;
    case 'guid': n = cookie ? 38 : 36; break;
    case 'date': case 'datetime': n = 24; break;
    case 'bit': n = 1; break;
    case 'int': case 'bigint': case 'decimal': case 'money': case 'float': n = 40; break;
    default: n = 36;
  }
  return '0'.repeat(n);
}

// The characters a paging cookie adds to a request: the cookie holds the first and last values of the root orders
// and the primary key, and goes XML-escaped into the paging-cookie attribute of the URI-encoded FetchXML.
function cookieAllowance(f, cx) {
  const names = [];
  for (const od of f.orders || EMPTY) if (!od.alias && !od.entityname && !names.includes(lower(od.attr))) names.push(lower(od.attr));
  if (cx.pk && !names.includes(cx.pk)) names.push(cx.pk);
  const parts = ['<cookie page="99999">'];
  for (const nm of names) {
    const v = sampleValue(cx.attrOf(cx.name, nm), true);
    parts.push(`<${nm} last="${v}" first="${v}" />`);
  }
  parts.push('</cookie>');
  return Math.max(COOKIE_ALLOWANCE, encodedLength(` paging-cookie="${xmlEsc(parts.join(''))}"`));
}

function withGroup(f, g, values) {
  const c = { entityname: g.entityname, attr: g.attr, op: 'in', values };
  if (g.split) c[SPLIT] = true;
  return replaceItem(f, g.i, c);
}

// ------------------------------------------------------------------------------------- chunk execution

// The chunk streams of one execution (02 §4.2 IN rule): makers[i](signal) gives chunk i's AsyncIterable of
// batches. An opened chunk reads one batch ahead of its consumer and then waits for take(), so a chunk that is not
// being read holds at most one page; at most `dop` reads (one request each) are in flight. The first failure of any
// chunk fails the next take() at once; close() aborts the reads in flight and closes every chunk generator.
class ChunkPool {
  constructor(makers, dop, signal) {
    this.makers = makers;
    this.dop = Math.max(1, dop);
    this.ctrl = linkedController(signal);
    this.busy = 0;
    this.waiting = [];
    this.opened = [];
    this.closed = false;
    // the first chunk failure, and the reject of the take() waiting for a batch (one consumer reads the pool)
    this.error = null;
    this.onError = null;
  }

  // Opens chunk i: its generator, with the read of its first batch started.
  open(i) {
    const s = { it: this.makers[i](this.ctrl.signal)[Symbol.asyncIterator](), pending: null, done: false };
    this.opened.push(s);
    this.pull(s);
    return s;
  }

  pull(s) {
    s.pending = this.read(s);
    s.pending.catch(noop);
  }

  async read(s) {
    while (this.busy >= this.dop && !this.closed) await new Promise(r => this.waiting.push(r));
    this.busy++;
    try {
      this.ctrl.signal.throwIfAborted();
      return await s.it.next();
    } catch (e) {
      if (!this.closed && !this.error) {
        this.error = e;
        if (this.onError) this.onError(e);
      }
      throw e;
    } finally {
      this.busy--;
      const w = this.waiting.shift();
      if (w) w();
    }
  }

  // The next batch of chunk s, or null when it is done; starts the read of the batch after it.
  async take(s) {
    if (s.done) return null;
    if (this.error) throw this.error;
    let r;
    try {
      r = await new Promise((resolve, reject) => {
        this.onError = reject;
        s.pending.then(resolve, reject);
      });
    } finally {
      this.onError = null;
    }
    if (r.done) {
      s.done = true;
      return null;
    }
    this.pull(s);
    return r.value;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ctrl.dispose();
    for (const w of this.waiting.splice(0)) w();
    for (const s of this.opened) {
      s.done = true;
      s.it.return().catch(noop);
    }
  }
}

// Dataverse's sort order for merging the chunks of an ordered fetch (see the notes above): per order, desc, the static
// type (null when the attribute is unknown: then the value's own) and the order value of a response record.
function orderSpecs(f, cx) {
  const specs = [];
  const add = (od, entity, alias) => {
    const a = cx.attrOf(entity, od.attr);
    const at = lower(od.attr);
    const label = !!a && (LOOKUPS.has(a.type) || (!f.useraworderby && LABEL_SORTED.has(a.type)));
    const key = alias ? `${alias}.${at}` : a && LOOKUPS.has(a.type) ? `_${at}_value` : at;
    const read = reader(candidates(key).map(k => (label ? k + FV : k)));
    let type, conv;
    if (label || !a) {
      type = STR_T;
      conv = v => (v == null ? null : typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : String(v));
      if (!a) type = null;
    } else {
      type = dtOfAttr(a);
      conv = converter({ dt: type.dt, attr: a }, { tz: cx.tz, meta: cx.meta });
    }
    specs.push({ desc: !!od.desc, type, val: r => conv(read(r)) });
  };
  for (const od of f.orders || EMPTY) {
    if (od.alias) continue;
    const al = od.entityname ? String(od.entityname) : null;
    add(od, al ? cx.aliases.get(al) || al : f.entity, al);
  }
  const walk = links => {
    for (const l of links || EMPTY) {
      if (!joined(l)) continue;
      for (const od of l.orders || EMPTY) if (!od.alias) add(od, l.name, l.alias);
      walk(l.links);
    }
  };
  walk(f.links);
  return specs;
}

// The sort keys of a merge head's current record into its k / t arrays (reused for every record of the chunk).
function headKeys(m, specs) {
  const rec = m.recs[m.pos];
  for (let j = 0; j < specs.length; j++) {
    const s = specs[j];
    const v = s.val(rec);
    const t = s.type || (typeof v === 'number' ? FLOAT_T : STR_T);
    m.t[j] = t;
    m.k[j] = sortKey(v, t);
  }
}

// Merge order of two heads: the order keys (types.cmpKeys, NULL lowest), then the chunk order.
function headCmp(a, b, specs) {
  for (let j = 0; j < specs.length; j++) {
    const x = a.k[j], y = b.k[j];
    const c = cmpKeys(x, y, x == null ? b.t[j] : a.t[j]);
    if (c) return specs[j].desc ? -c : c;
  }
  return a.idx - b.idx;
}

// Binary min-heap of merge heads.
function heapDown(h, i, specs) {
  const n = h.length, x = h[i];
  for (;;) {
    let c = 2 * i + 1;
    if (c >= n) break;
    if (c + 1 < n && headCmp(h[c + 1], h[c], specs) < 0) c++;
    if (headCmp(h[c], x, specs) >= 0) break;
    h[i] = h[c];
    i = c;
  }
  h[i] = x;
}

function heapUp(h, i, specs) {
  const x = h[i];
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (headCmp(x, h[p], specs) >= 0) break;
    h[i] = h[p];
    i = p;
  }
  h[i] = x;
}

// The raw record pages of one chunk of an ordered fetch: at most `limit` records (and the plan's own TOP limit).
async function* chunkRecords(f, o, limit) {
  const plan = planPaging(f, o);
  let left = Math.min(limit, plan.limit);
  if (!(left > 0)) return;
  for await (const recs of pagesOf(plan, o)) {
    if (recs.length < left) {
      left -= recs.length;
      yield recs;
      continue;
    }
    yield recs.length === left ? recs : recs.slice(0, left);
    return;
  }
}

// The fetch with every order attribute requested (on its own node), so the chunks can be merged.
function withOrderAttrs(f) {
  if (f.aggregate) return f;
  const need = new Map();
  const add = (alias, name) => {
    const k = alias || '';
    if (!need.has(k)) need.set(k, []);
    need.get(k).push(lower(name));
  };
  for (const od of f.orders || EMPTY) if (!od.alias) add(od.entityname || null, od.attr);
  const collect = links => {
    for (const l of links || EMPTY) {
      if (!joined(l)) continue;
      for (const od of l.orders || EMPTY) if (!od.alias) add(l.alias, od.attr);
      collect(l.links);
    }
  };
  collect(f.links);
  const links = ls => (ls || EMPTY).map(l => (joined(l) ? { ...l, attrs: l.all ? l.attrs : ensureAttrs(l.attrs, need.get(l.alias || '') || EMPTY), links: links(l.links) } : l));
  return { ...f, attrs: f.all ? f.attrs : ensureAttrs(f.attrs, need.get('') || EMPTY), links: links(f.links) };
}

const hasOrders = f => {
  if ((f.orders || EMPTY).some(o => !o.alias)) return true;
  const walk = links => (links || EMPTY).some(l => joined(l) && ((l.orders || EMPTY).length > 0 || walk(l.links)));
  return walk(f.links);
};

// ------------------------------------------------------------------------------------------- explain text

function condText(c) {
  const name = (c.entityname ? c.entityname + '.' : '') + c.attr + ' ' + c.op;
  if (c.valueof) return `${name} ${c.valueof}`;
  if (Array.isArray(c.values)) {
    const vs = c.values.length > 10 ? [...c.values.slice(0, 10).map(valueText), `… ${digits(c.values.length)} values`] : c.values.map(valueText);
    return `${name} (${vs.join(', ')})`;
  }
  return c.value != null ? `${name} ${valueText(c.value)}` : name;
}

function filterText(f, top = true) {
  const parts = (f.items || EMPTY).map(it => (isFilter(it) ? filterText(it, false) : isLink(it) ? `${it.linkType} ${it.name}${it.alias ? ' AS ' + it.alias : ''}` : condText(it)));
  const s = parts.join(f.type === 'or' ? ' or ' : ' and ');
  return top || parts.length < 2 ? s : `(${s})`;
}

function linksText(links, out = []) {
  for (const l of links || EMPTY) {
    out.push(`${l.linkType} ${l.name}${l.alias ? ' AS ' + l.alias : ''} (${l.from} = ${l.to})`);
    linksText(l.links, out);
  }
  return out;
}

function ordersText(f) {
  const out = [];
  const add = (od, alias) => out.push((od.alias ? od.alias : (od.entityname || alias ? (od.entityname || alias) + '.' : '') + od.attr) + (od.desc ? ' DESC' : ''));
  for (const od of f.orders || EMPTY) add(od, null);
  const walk = links => {
    for (const l of links || EMPTY) {
      for (const od of l.orders || EMPTY) add(od, l.alias);
      walk(l.links);
    }
  };
  walk(f.links);
  return out.join(', ');
}

function modeText(mode, f, limit) {
  const first = limit !== Infinity ? `, first ${digits(limit)} rows` : '';
  switch (mode) {
    case 'aggregate': return 'aggregate';
    case 'top': return `top ${f.top}`;
    case 'page': return `page ${f.page}, ${f.count} rows`;
    case 'keyset': return 'keyset paging' + first;
    case 'pages': return 'page-number paging' + first;
    default: return 'cookie paging' + first;
  }
}

const sourceName = f => (f.datasource === 'retained' ? 'archive.' : f.datasource === 'bin' ? 'bin.' : '') + f.entity;

function safeXml(f, opts) {
  try {
    return toXml(f, opts);
  } catch (e) {
    return `<!-- ${String(e && e.message).replace(/--/g, '- -')} -->`;
  }
}

// ---------------------------------------------------------------------------------------------- FetchScan

// A Dataverse source read through FetchXML (02 §4, §5): binds the execution's values, splits long IN lists, pages
// and maps the rows (see the notes above).
export class FetchScan extends PlanNode {
  constructor(o = {}) {
    const f = o.fetch;
    if (!f || typeof f !== 'object' || typeof f.entity !== 'string' || !f.entity) {
      throw new TypeError('FetchScan({fetch, entity, entitySet, schema, paging, pageSize, keyCols}): fetch.entity is required');
    }
    if (o.schema != null && !Array.isArray(o.schema)) throw new TypeError('FetchScan: schema must be a Column[]');
    if (o.paging != null && !MODES.includes(o.paging)) throw new TypeError(`FetchScan: paging must be one of ${MODES.join(', ')}`);
    if (o.pageSize != null && !(Number.isInteger(o.pageSize) && o.pageSize >= 1 && o.pageSize <= MAX_PAGE)) {
      throw new TypeError('FetchScan: pageSize must be an integer from 1 to 5000');
    }
    if (o.keyCols != null && !Array.isArray(o.keyCols)) throw new TypeError('FetchScan: keyCols must be an array');
    super({ op: 'FetchScan', schema: o.schema || [], server: true, detail: o.detail, props: o.props, warnings: o.warnings, est: o.est });
    this.fetch = f;
    this.entity = o.entity != null ? o.entity : f.entity;
    this.entitySet = o.entitySet || null;
    this.paging = o.paging || null;
    this.pageSize = o.pageSize != null ? o.pageSize : null;
    this.keyCols = o.keyCols && o.keyCols.length ? o.keyCols : null;
    this.topLevel = !!o.topLevel;
    this.lastXml = null;
  }

  // How runFetch pages the planned fetch (02 §6 explain): {mode, limit}, as planPaging decides it (keyset over the
  // primary keys or keyCols, page numbers when its filter would pass the 500 conditions + links).
  pagingPlan() {
    const f = this.fetch;
    const p = pagingOf(f, this.paging);
    if (p.mode === 'keyset' && !keysetFits(f, keyCountOf(f, this.keyCols))) return { mode: 'pages', limit: p.limit };
    return p;
  }

  detail() {
    const { mode, limit } = this.pagingPlan();
    return `${sourceName(this.fetch)} (${modeText(mode, this.fetch, limit)})`;
  }

  props() {
    const f = this.fetch, { mode, limit } = this.pagingPlan();
    const out = [prop('Table', sourceName(f))];
    const cols = this.schema.filter(c => !c.hidden).map(c => (c.name ? (c.qual ? c.qual + '.' + c.name : c.name) : '(No column name)'));
    out.push(prop('Columns', cols.join(', ')));
    out.push(prop('Paging mode', mode === 'pages' ? 'page numbers' : mode));
    if (mode === 'cookie' || mode === 'keyset' || mode === 'pages') {
      const info = this.entity && typeof this.entity === 'object' ? this.entity : null;
      const size = pageSizeOf({ ...f, top: null }, { pageSize: this.pageSize, elastic: !!info && info.kind === 'elastic', allCount: () => (info && info.attrList ? info.attrList.length : null) });
      out.push(prop('Page size', digits(size)));
    }
    if (limit !== Infinity) out.push(prop('Row limit', digits(limit)));
    if (this.keyCols) out.push(prop('Keyset keys', this.keyCols.map(k => (typeof k === 'string' ? k : (k.entityname ? k.entityname + '.' : '') + k.attr)).join(', ')));
    if (f.top != null) out.push(prop('Top', f.top));
    if (f.page != null) out.push(prop('Page', f.page));
    if (f.count != null) out.push(prop('Count', f.count));
    if (f.distinct) out.push(prop('Distinct', 'true'));
    if (f.aggregate) out.push(prop('Aggregate', 'true'));
    if (f.filter && (f.filter.items || EMPTY).length) out.push(prop('Conditions', filterText(f.filter)));
    const links = linksText(f.links);
    if (links.length) out.push(prop('Links', links.join('; ')));
    const orders = ordersText(f);
    if (orders) out.push(prop('Order', orders));
    if (f.useraworderby) out.push(prop('Raw order', 'true'));
    const options = optionsText(f.options);
    if (options) out.push(prop('Options', options));
    if (f.noLock) out.push(prop('No lock', 'true'));
    if (f.datasource) out.push(prop('Data source', f.datasource));
    return out;
  }

  // The FetchXML explain shows: the most recent execution's first request without paging attributes, else the plan.
  displayXml() {
    return this.lastXml != null ? this.lastXml : safeXml(this.fetch);
  }

  explain() {
    const node = super.explain();
    node.fetchXml = this.displayXml();
    return node;
  }

  // The run-time context of an execution: metadata, entity set, primary key, kind and attribute lookup.
  context(env) {
    const meta = (env && env.meta) || null;
    const name = lower(this.fetch.entity);
    let info = this.entity && typeof this.entity === 'object' ? this.entity : null;
    if (!info && meta) info = (typeof meta.entitySync === 'function' && meta.entitySync(name)) || (typeof meta.findEntity === 'function' && meta.findEntity(name)) || null;
    const entitySet = this.entitySet || (info && info.entitySetName) || null;
    if (!entitySet) throw new TypeError(`FetchScan: the entity set of '${name}' is unknown (pass entitySet or the EntityInfo).`);
    const cx = {
      env, meta, name, info, entitySet, tz: env ? env.tz : undefined,
      pk: (info && info.primaryIdAttribute) || null,
      kind: (info && info.kind) || 'standard',
      aliases: aliasMap(this.fetch),
      attrOf: (ent, a) => this.attrOf(ent, a, info, meta),
    };
    return cx;
  }

  // The AttrInfo of entity.attr: the EntityInfo given, meta.entitySync, else a schema column's attr.
  attrOf(ent, a, info, meta) {
    if (!ent || !a) return null;
    const el = lower(ent), al = lower(a);
    let e = info && info.logicalName === el ? info : null;
    if ((!e || !e.attrs) && meta && typeof meta.entitySync === 'function') e = meta.entitySync(el) || e;
    const hit = e && e.attrs && typeof e.attrs.get === 'function' ? e.attrs.get(al) : null;
    if (hit) return hit;
    for (const c of this.schema) if (c.attr && c.attr.entity === el && c.attr.logicalName === al) return c.attr;
    return null;
  }

  // The fetch of one execution: env.scanArgs conditions added and every run-time value bound; null for a
  // contradiction (no request is sent).
  async boundFetch(env, cx, args) {
    cx = cx || this.context(env);
    if (args === undefined) args = env && env.scanArgs ? env.scanArgs.get(this) || null : null;
    const f = this.fetch;
    const conds = args && Array.isArray(args.conds) && args.conds.length
      ? args.conds.map(c => (c.op === 'in' ? { ...c, [SPLIT]: true } : c))
      : null;
    let filter = f.filter && (f.filter.items || EMPTY).length ? f.filter : null;
    if (conds) filter = { type: 'and', items: [...(filter ? (filter.type === 'or' ? [filter] : filter.items) : []), ...conds] };
    const b = new Binder(cx, env);
    let root = null;
    if (filter) {
      const r = await b.filter(filter, cx.name);
      if (r === FALSE) return null;
      root = r === TRUE ? null : r;
    }
    const links = f.links && f.links.length ? await b.links(f.links) : f.links || [];
    const out = { ...f, filter: root, links };
    // A fetch without attribute elements returns every column; ask for the primary key instead (not for a
    // distinct fetch, whose attributes are its distinct tuple: the planner always gives it one)
    if (!out.aggregate && !out.distinct && !out.all && !(out.attrs || EMPTY).length && cx.pk) out.attrs = [{ name: cx.pk }];
    return out;
  }

  // The options of runFetch for an execution.
  runOptions(env, cx) {
    const settings = (env && (env.settings || (env.session && env.session.settings))) || {};
    const info = cx.info;
    return {
      api: env && env.api, entitySet: cx.entitySet, columns: this.schema, signal: env && env.signal, tz: cx.tz,
      meta: cx.meta, paging: this.paging, pageSize: this.pageSize, keys: this.keyCols, pk: cx.pk, entity: info,
      topLevel: this.topLevel, inBody: settings.queryInBody === true, elastic: cx.kind === 'elastic',
      virtual: cx.kind === 'virtual', table: cx.name,
      allCount: name => {
        const e = info && info.logicalName === lower(name) ? info : cx.meta && typeof cx.meta.entitySync === 'function' ? cx.meta.entitySync(name) : null;
        return e && Array.isArray(e.attrList) ? e.attrList.filter(a => a.validForRead !== false).length : null;
      },
      warn: (text, kind) => emitWarn(env, text, kind),
      beforeRequest: () => {
        countRequests(env);
        this.stats.requests++;
      },
    };
  }

  // The request characters a continuation page adds to the fetch (see the notes above: IN lists): the keyset filter with
  // every key at its longest value, else a paging cookie holding the root order values at their longest (at least
  // COOKIE_ALLOWANCE); at most half the budget, since a continuation that does not fit pages by page number.
  allowance(f, opts, cx) {
    const { mode } = pagingOf(f, this.paging);
    let n = null;
    if (mode === 'keyset') {
      const keys = this.keyCols ? this.keyCols.map(k => normKey(k, f, opts)) : pkKeys(f, opts);
      if (keys && keysetFits(f, keys.length)) {
        const attrOf = k => cx.attrOf(k.entityname ? cx.aliases.get(String(k.entityname)) || null : cx.name, k.attr);
        const o = [];
        filterXml(o, keysetFilter(keys.map(k => ({ ...k, value: sampleValue(attrOf(k), false) }))));
        n = encodedLength(o.join('')) + COOKIE_ALLOWANCE;
      }
    }
    if (n == null) n = cookieAllowance(f, cx);
    return Math.min(n, URL_BUDGET / 2);
  }

  // The values of an IN group without duplicates under the attribute's comparison (the chunks must be disjoint).
  uniqueValues(g, cx) {
    const ent = g.entityname ? cx.aliases.get(g.entityname) || null : cx.name;
    const a = ent ? cx.attrOf(ent, g.attr) : null;
    const t = a ? dtOfAttr(a) : null;
    const keyFn = !t ? v => valueText(v) : t.dt === 'string' ? v => collKey(valueText(v)) : t.dt === 'guid' ? v => lower(valueText(v)) : v => valueText(v);
    const seen = new Set(), out = [];
    for (const v of g.values) {
      const k = keyFn(v);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    return out;
  }

  // The requests of an execution (see the notes above: IN lists): scanArgs `in` lists in 500-value chunks, then halving of
  // the largest top-level IN list while a request exceeds the URL budget.
  variants(bound, cx, opts) {
    if (bound.aggregate) return [bound];
    let list = [bound];
    const items = rootItems(bound);
    for (let i = 0; i < items.length; i++) {
      const g = groupAt(items[i], i);
      if (!g || !g.split || g.values.length <= IN_CHUNK) continue;
      const vals = this.uniqueValues(g, cx);
      const parts = [];
      for (let j = 0; j < vals.length; j += IN_CHUNK) parts.push(vals.slice(j, j + IN_CHUNK));
      list = list.flatMap(v => parts.map(p => withGroup(v, g, p)));
    }
    const allowance = this.allowance(bound, opts, cx);
    const out = [];
    const queue = list.slice();
    while (queue.length) {
      const v = queue.shift();
      if (encodeURIComponent(toXml(v)).length + allowance <= URL_BUDGET) {
        out.push(v);
        continue;
      }
      let best = null;
      rootItems(v).forEach((it, i) => {
        const g = groupAt(it, i);
        if (g && g.values.length > 1 && (!best || g.values.length > best.values.length)) best = g;
      });
      if (!best) {
        out.push(v);
        continue;
      }
      const vals = this.uniqueValues(best, cx);
      if (vals.length < 2) {
        out.push(withGroup(v, best, vals));
        continue;
      }
      const h = Math.ceil(vals.length / 2);
      queue.unshift(withGroup(v, best, vals.slice(0, h)), withGroup(v, best, vals.slice(h)));
    }
    return out;
  }

  async *execute(env) {
    const args = env && env.scanArgs ? env.scanArgs.get(this) || null : null;
    if (args && Array.isArray(args.rows)) {
      yield* batchesOf(args.rows);
      return;
    }
    const cx = this.context(env);
    const bound = await this.boundFetch(env, cx, args);
    const opts = this.runOptions(env, cx);
    if (!bound) {
      // a contradiction sends no request; an aggregate without GROUP BY still gives its one row (02 §4.5: COUNT 0,
      // the other aggregates NULL), as SQL Server's aggregate over no rows does
      if (this.fetch.aggregate && !hasGroupBy(this.fetch)) yield [rowMapper(this.schema, mapOpts(opts))(zeroRecord(this.fetch))];
      return;
    }
    const variants = this.variants(bound, cx, opts);
    this.lastXml = safeXml(planPaging(variants[0], opts).fetch);
    let any = false;
    try {
      const gen = variants.length === 1 ? runFetch(variants[0], opts) : this.runChunks(variants, bound, opts, cx, env);
      for await (const b of gen) {
        any = true;
        yield b;
      }
    } catch (e) {
      if (!any && bound.datasource === 'retained' && isArchiveUnavailable(e)) {
        emitInfo(env, archiveText(cx.name));
        return;
      }
      throw e;
    }
  }

  // The rows of several requests of one execution (see the notes above: IN lists): concatenated in chunk order, or merged
  // by the pushed order; TOP and OFFSET (page/count, sent by no chunk) apply after that, and every chunk reads at
  // most the rows they need.
  async *runChunks(variants, bound, opts, cx, env) {
    const paged = bound.top == null && bound.page != null && bound.count != null;
    const span = {
      skip: paged ? (bound.page - 1) * bound.count : 0,
      take: bound.top != null ? bound.top : paged ? bound.count : Infinity,
    };
    span.want = span.skip + span.take;
    // a chunk of a paged fetch is a TOP of skip + take rows (OFFSET is pushed only on standard tables, 02 §4.4)
    const chunkOf = v => (paged ? { ...v, page: null, count: null, top: span.want } : v);
    const o = paged && (opts.paging === 'page' || opts.paging === 'top') ? { ...opts, paging: null } : opts;
    const keyed = pagingOf(bound, this.paging).mode === 'keyset';
    if (!hasOrders(bound) || keyed) yield* this.concatChunks(variants.map(chunkOf), bound, o, env, span);
    else yield* this.mergeChunks(variants.map(v => withOrderAttrs(chunkOf(v))), bound, o, cx, env, span);
  }

  // Chunks in chunk order: the one being read and the next dop - 1 are open, each one batch ahead.
  async *concatChunks(fetches, bound, opts, env, { skip, take, want }) {
    const columns = this.schema;
    const seen = bound.distinct ? new Set() : null;
    const makers = fetches.map(f => signal => runFetch(f, { ...opts, signal, limit: want }));
    const dop = dopOf(env);
    const pool = new ChunkPool(makers, dop, opts.signal);
    try {
      const open = [];
      let next = 0, skipped = 0, taken = 0;
      while (taken < take) {
        while (next < makers.length && open.length < dop) open.push(pool.open(next++));
        if (!open.length) return;
        const b = await pool.take(open[0]);
        if (b == null) {
          open.shift();
          continue;
        }
        const rows = [];
        for (let i = 0; i < b.length && taken < take; i++) {
          const r = b[i];
          if (seen) {
            const k = rowKey(r, columns);
            if (seen.has(k)) continue;
            seen.add(k);
          }
          if (skipped < skip) {
            skipped++;
            continue;
          }
          rows.push(r);
          taken++;
        }
        if (rows.length) yield rows;
      }
    } finally {
      pool.close();
    }
  }

  // Chunks merged by Dataverse's order (see the notes above): a k-way merge of the chunk streams, which arrive in that
  // order, yielding batches as they merge. It holds one batch per chunk (plus the one read ahead), so it streams like
  // the scan itself and counts no rows.
  async *mergeChunks(fetches, bound, opts, cx, env, { skip, take, want }) {
    const columns = this.schema;
    const specs = orderSpecs(bound, cx);
    const seen = bound.distinct ? new Set() : null;
    const map = rowMapper(columns, mapOpts(opts));
    const signal = opts.signal;
    const makers = fetches.map(f => sig => chunkRecords(f, { ...opts, signal: sig }, want));
    const pool = new ChunkPool(makers, dopOf(env), signal);
    try {
      const heads = makers.map((_, i) => ({ src: pool.open(i), idx: i, recs: null, pos: 0, k: new Array(specs.length), t: new Array(specs.length) }));
      const heap = [];
      for (const m of heads) {
        m.recs = await pool.take(m.src);
        if (!m.recs) continue;
        headKeys(m, specs);
        heap.push(m);
        heapUp(heap, heap.length - 1, specs);
      }
      let out = [], skipped = 0, taken = 0, n = 0;
      while (heap.length && taken < take) {
        const m = heap[0];
        const rec = m.recs[m.pos++];
        if (!seen && skipped < skip) skipped++;
        else {
          const row = map(rec);
          let keep = true;
          if (seen) {
            const k = rowKey(row, columns);
            if (seen.has(k)) keep = false;
            else seen.add(k);
          }
          if (keep && skipped < skip) skipped++;
          else if (keep) {
            out.push(row);
            taken++;
          }
        }
        if (out.length >= BATCH) {
          yield out;
          out = [];
        }
        if (++n % 10000 === 0 && signal) signal.throwIfAborted();
        if (m.pos < m.recs.length) {
          headKeys(m, specs);
          heapDown(heap, 0, specs);
          continue;
        }
        // the head's batch is used up: its next one decides the order; the rows merged so far go out first
        if (out.length && taken < take) {
          yield out;
          out = [];
        }
        if (taken >= take) break;
        m.recs = await pool.take(m.src);
        m.pos = 0;
        if (m.recs) headKeys(m, specs);
        else {
          // m is heap[0]: the last head takes its place
          const last = heap.pop();
          if (!heap.length) break;
          heap[0] = last;
        }
        heapDown(heap, 0, specs);
      }
      if (out.length) yield out;
    } finally {
      pool.close();
    }
  }
}

// ---------------------------------------------------------------------------------- PartitionedAggregate

function aliasAttr(f, alias) {
  if (alias == null) return null;
  const al = lower(alias);
  return treeAttrs(f).find(a => a.alias != null && lower(a.alias) === al) || null;
}

// (lo, hi] split into k equal-width ranges with whole-second inner boundaries, empty ranges dropped (02 §4.5).
function splitRange(lo, hi, k) {
  const out = [];
  let prev = lo;
  for (let i = 1; i <= k; i++) {
    let b = i === k ? hi : Math.floor((lo + ((hi - lo) * i) / k) / 1000) * 1000;
    if (b < prev) b = prev;
    if (b > hi) b = hi;
    if (b > prev) out.push({ lo: prev, hi: b });
    prev = b;
  }
  if (out.length < 2 && hi - lo > 1000) {
    const m = Math.floor((hi - 1) / 1000) * 1000;
    if (m > lo && m < hi) return [{ lo, hi: m }, { lo: m, hi }];
  }
  return out;
}

const andFilter = (f, conds) => ({ type: 'and', items: [...(f ? (f.type === 'or' ? [f] : f.items) : []), ...conds] });

function stripLinks(links) {
  return (links || EMPTY).map(l => (joined(l) ? { ...l, attrs: [], all: false, orders: [], links: stripLinks(l.links) } : l));
}

function aggState(a) {
  switch (a.kind) {
    case 'count': case 'countcolumn': return { n: 0 };
    case 'sum': return AGGREGATES.get('SUM').init([], [a.col]);
    case 'avg': return { st: AGGREGATES.get('AVG').init([], [a.col]), n: 0 };
    default: return AGGREGATES.get(a.kind.toUpperCase()).init([], [a.col]);
  }
}

function aggStep(a, st, row, env) {
  switch (a.kind) {
    case 'count': case 'countcolumn': {
      const v = row[a.i];
      if (v != null) st.n += Number(v);
      return;
    }
    case 'sum': {
      const v = row[a.i];
      if (v != null) AGGREGATES.get('SUM').step(st, [v], env);
      return;
    }
    case 'avg': {
      const s = row[a.s], c = row[a.c];
      if (s != null) AGGREGATES.get('AVG').step(st.st, [s], env);
      if (c != null) st.n += Number(c);
      return;
    }
    default: {
      const v = row[a.i];
      if (v != null) AGGREGATES.get(a.kind.toUpperCase()).step(st, [v], env);
    }
  }
}

function aggResult(a, st, env) {
  switch (a.kind) {
    case 'count': case 'countcolumn': return AGGREGATES.get(a.col.dt === 'bigint' ? 'COUNT_BIG' : 'COUNT').result(st);
    case 'sum': return AGGREGATES.get('SUM').result(st, a.col, env);
    case 'avg': {
      if (!st.n) return null;
      st.st.n = st.n;
      return AGGREGATES.get('AVG').result(st.st, a.col, env);
    }
    default: return AGGREGATES.get(a.kind.toUpperCase()).result(st);
  }
}

// Tier 2 of the aggregates (02 §4.5): the tier-1 aggregate FetchScan, re-run per createdon range when Dataverse
// reports more than 50,000 records, the partial results combined exactly (see the notes above).
export class PartitionedAggregate extends PlanNode {
  constructor(o = {}) {
    const scan = o.scan;
    if (!(scan instanceof FetchScan)) throw new TypeError('PartitionedAggregate({scan, entity, entitySet, aggs, keyCount, schema}): scan must be the tier-1 FetchScan');
    if (!scan.fetch.aggregate) throw new TypeError('PartitionedAggregate: scan must be an aggregate FetchScan (02 §4.5 tier 1)');
    const schema = o.schema || scan.schema;
    if (!Array.isArray(schema)) throw new TypeError('PartitionedAggregate: schema must be a Column[]');
    if (o.aggs != null) {
      if (!Array.isArray(o.aggs)) throw new TypeError('PartitionedAggregate: aggs must be an array');
      for (const a of o.aggs) {
        const alias = typeof a === 'string' ? a : a && a.alias;
        const at = aliasAttr(scan.fetch, alias);
        if (!at || !at.aggregate) throw new TypeError(`PartitionedAggregate: '${alias}' is no aggregate alias of the tier-1 fetch`);
      }
    }
    if (o.keyCount != null && !(Number.isInteger(o.keyCount) && o.keyCount >= 0 && o.keyCount <= schema.length)) {
      throw new TypeError('PartitionedAggregate: keyCount must be a column count');
    }
    super({ op: 'PartitionedAggregate', kids: [scan], schema, server: true, detail: o.detail, props: o.props, warnings: o.warnings, est: o.est });
    this.scan = scan;
    this.entity = o.entity != null ? o.entity : scan.entity;
    this.entitySet = o.entitySet || scan.entitySet || null;
    this.aggs = o.aggs || null;
    this.keyCount = o.keyCount != null ? o.keyCount : null;
    this.dop = Number.isInteger(o.dop) && o.dop > 0 ? o.dop : 4;
    this.partitionXml = null;
    this.combined = 0;
  }

  detail() {
    return `Splits on createdon ranges (up to ${this.dop} in parallel) if Dataverse reports more than 50,000 records`;
  }

  props() {
    const out = [prop('Partition column', 'createdon'), prop('Parallel requests', this.dop)];
    if (this.combined) out.push(prop('Aggregate queries combined', this.combined));
    return out;
  }

  explain() {
    const node = super.explain();
    node.fetchXml = [this.scan.displayXml(), ...(this.partitionXml ? [this.partitionXml] : [])];
    node.kids = node.kids.map((k, i) => {
      if (i !== 0 || k.fetchXml == null) return k;
      const { fetchXml: _x, ...rest } = k;
      return rest;
    });
    return node;
  }

  async *execute(env) {
    let any = false, failure = null;
    try {
      for await (const b of this.scan.run(env)) {
        any = true;
        yield b;
      }
      return;
    } catch (e) {
      if (any || !isRecordLimit(e)) throw e;
      failure = e;
    }
    const layout = this.layout();
    if (!layout || !this.eligible(env)) throw failure;
    const rows = await this.partitioned(env, layout);
    yield* batchesOf(rows);
  }

  // The 02 §4.5 tier-2 eligibility, checked again at run time from what the metadata says (the planner decides it;
  // a table that does not qualify keeps the record-limit error, so the TryCatch runs tier 3).
  eligible(env) {
    const cx = this.scan.context(env);
    const f = this.scan.fetch;
    if (f.datasource || cx.kind !== 'standard' || cx.name === 'audit') return false;
    const a = cx.attrOf(cx.name, 'createdon');
    if (!a) {
      // loaded metadata without createdon: no tier 2; no metadata at all: the planner's decision stands
      const e = (cx.info && cx.info.attrs ? cx.info : null) || (cx.meta && typeof cx.meta.entitySync === 'function' ? cx.meta.entitySync(cx.name) : null);
      return !(e && e.attrs);
    }
    return a.type === 'DateTime' && (a.behavior == null || a.behavior === 'UserLocal') && a.validForRead !== false;
  }

  // Group-key and aggregate columns of the schema, by the tier-1 aliases; null when partial results cannot be added.
  layout() {
    const keys = [], aggs = [];
    this.schema.forEach((c, i) => {
      if (c.srcKey == null || c.role === 'name' || c.role === 'type') return;
      const at = aliasAttr(this.scan.fetch, c.srcKey);
      if (!at) return;
      if (at.groupby) keys.push(i);
      else if (at.aggregate) aggs.push({ i, alias: String(at.alias), kind: lower(at.aggregate), distinct: !!at.distinct, col: c });
    });
    if (aggs.some(a => a.distinct || !COMBINABLE.has(a.kind))) return null;
    return { keys, aggs };
  }

  // The columns a partition response maps to: the schema, then the SUM and COUNT parts of every AVG.
  partitionColumns(layout) {
    const cols = this.schema.slice();
    for (const a of layout.aggs) {
      if (a.kind !== 'avg') continue;
      a.s = cols.length;
      cols.push({ name: a.alias + '_s', srcKey: a.alias + '_s', dt: a.col.dt === 'int' || a.col.dt === 'bigint' ? 'float' : a.col.dt, prec: a.col.prec, scale: a.col.scale, hidden: true });
      a.c = cols.length;
      cols.push({ name: a.alias + '_c', srcKey: a.alias + '_c', dt: 'bigint', hidden: true });
    }
    return cols;
  }

  partitionFetch(bound, conds) {
    const swap = attrs => (attrs || EMPTY).flatMap(at => (lower(at.aggregate || '') === 'avg'
      ? [{ ...at, aggregate: 'sum', alias: at.alias + '_s' }, { ...at, aggregate: 'countcolumn', alias: at.alias + '_c', distinct: false }]
      : [at]));
    const links = ls => (ls || EMPTY).map(l => (joined(l) ? { ...l, attrs: swap(l.attrs), orders: [], links: links(l.links) } : l));
    return { ...bound, orders: [], attrs: swap(bound.attrs), links: links(bound.links), filter: andFilter(bound.filter, conds) };
  }

  rangeFetch(bound, desc) {
    return {
      entity: bound.entity, alias: bound.alias, top: 1, options: bound.options, noLock: bound.noLock,
      latematerialize: bound.latematerialize, datasource: bound.datasource || null,
      attrs: [{ name: 'createdon' }], all: false,
      filter: andFilter(bound.filter, [{ entityname: null, attr: 'createdon', op: 'not-null' }]),
      orders: [{ attr: 'createdon', entityname: null, desc }],
      links: stripLinks(bound.links),
    };
  }

  // Runs the partitions and combines them (02 §4.5 tier 2); throws the 'partition' error when it gives up.
  async partitioned(env, layout) {
    const cx = this.scan.context(env);
    const bound = await this.scan.boundFetch(env, cx);
    // a contradiction: no partition runs; without GROUP BY the one row of an aggregate over no rows (02 §4.5)
    if (!bound) return layout.keys.length ? [] : this.combine([], layout, env);
    const base = this.scan.runOptions(env, cx);
    const dop = dopOf(env);
    this.dop = dop;
    this.partitionXml = null;
    this.combined = 0;
    const ctrl = linkedController(env && env.signal);
    const created = cx.attrOf(cx.name, 'createdon') || USER_LOCAL;
    // every range and partition request counts on this node and against maxRequests (02 §4.5)
    const counted = o => ({
      ...base, ...o, signal: ctrl.signal,
      beforeRequest: () => {
        countRequests(env);
        this.stats.requests++;
      },
    });
    const collectRows = async (fx, o) => {
      const out = [];
      for await (const b of runFetch(fx, counted(o))) for (const r of b) out.push(r);
      return out;
    };
    try {
      const col = [{ name: 'createdon', srcKey: 'createdon', dt: 'datetime', attr: created.type === 'DateTime' ? created : USER_LOCAL }];
      const [first, last] = await Promise.all([
        collectRows(this.rangeFetch(bound, false), { columns: col, paging: 'top' }),
        collectRows(this.rangeFetch(bound, true), { columns: col, paging: 'top' }),
      ]);
      const m = first.length && first[0][0] instanceof Date ? first[0][0].getTime() : null;
      const M = last.length && last[0][0] instanceof Date ? last[0][0].getTime() : m;
      const queue = m == null ? [] : splitRange(m - 1000, M == null ? m : Math.max(M, m), Math.min(8, Math.max(2, dop)));
      if (queue.length > MAX_PARTITIONS) throw partitionError();
      queue.push({ nil: true });
      const cols = this.partitionColumns(layout);
      const condsOf = part => (part.nil
        ? [{ entityname: null, attr: 'createdon', op: 'null' }]
        : [{ entityname: null, attr: 'createdon', op: 'gt', value: new Date(part.lo).toISOString() },
          { entityname: null, attr: 'createdon', op: 'le', value: new Date(part.hi).toISOString() }]);
      this.partitionXml = safeXml(this.partitionFetch(bound, condsOf(queue[0])));
      const results = [];
      const running = new Set();
      let ranges = queue.length - 1, fatal = null, giveUp = false;
      const start = part => {
        const p = (async () => {
          try {
            const rows = await collectRows(this.partitionFetch(bound, condsOf(part)), { columns: cols, paging: 'aggregate' });
            if (!fatal) results.push({ part, rows });
          } catch (e) {
            if (fatal || giveUp) return;
            // a range that still exceeds the record limit is split in 4 (whole seconds), down to 1 s
            if (isRecordLimit(e) && !part.nil && part.hi - part.lo > 1000) {
              const subs = splitRange(part.lo, part.hi, 4);
              ranges += subs.length - 1;
              if (ranges > MAX_PARTITIONS) giveUp = true;
              else queue.push(...subs);
              return;
            }
            // the record limit on a 1 s range or the NULL partition, 'fake-limit' (>= 5000 groups) and every other
            // fallback error give up; 'auth', throttling, aborts and the request limit propagate
            if (isAggregateFallback(e)) {
              giveUp = true;
              return;
            }
            fatal = e;
          }
        })();
        running.add(p);
        p.finally(() => running.delete(p));
      };
      while (!fatal && !giveUp && (queue.length || running.size)) {
        while (!fatal && !giveUp && running.size < dop && queue.length) start(queue.shift());
        if (running.size) await Promise.race(running);
      }
      if (fatal || giveUp) {
        ctrl.abort();
        await Promise.allSettled([...running]);
        throw fatal || partitionError();
      }
      results.sort((a, b) => (a.part.nil ? 1 : 0) - (b.part.nil ? 1 : 0) || (a.part.lo ?? 0) - (b.part.lo ?? 0));
      const rows = this.combine(results, layout, env);
      this.combined = results.length;
      emitInfo(env, `Dataverse limits server side aggregates to 50,000 records; the result was combined from ${results.length} aggregate queries on createdon ranges.`);
      return this.sortRows(rows, bound);
    } finally {
      ctrl.dispose();
    }
  }

  combine(results, layout, env) {
    const n = this.schema.length;
    const keyTypes = layout.keys.map(i => this.schema[i]);
    const groups = new Map(), order = [];
    for (const { rows } of results) {
      for (const r of rows) {
        const k = rowKey(layout.keys.map(i => r[i]), keyTypes);
        let g = groups.get(k);
        if (!g) {
          g = { row: r.slice(0, n), st: layout.aggs.map(aggState) };
          groups.set(k, g);
          order.push(g);
        }
        for (let j = 0; j < layout.aggs.length; j++) aggStep(layout.aggs[j], g.st[j], r, env);
      }
    }
    if (!layout.keys.length && !order.length) order.push({ row: new Array(n).fill(null), st: layout.aggs.map(aggState) });
    return order.map(g => {
      const row = g.row;
      for (let j = 0; j < layout.aggs.length; j++) row[layout.aggs[j].i] = aggResult(layout.aggs[j], g.st[j], env);
      return row;
    });
  }

  // The combined rows in the order the tier-1 fetch's <order alias> elements give (types.cmp), else as they came.
  sortRows(rows, f) {
    const orders = [];
    const collect = nd => {
      for (const od of nd.orders || EMPTY) if (od.alias) orders.push(od);
      for (const l of nd.links || EMPTY) if (joined(l)) collect(l);
    };
    collect(f);
    const specs = [];
    for (const od of orders) {
      const i = this.schema.findIndex(c => c.srcKey != null && lower(c.srcKey) === lower(od.alias) && c.role !== 'name' && c.role !== 'type');
      if (i >= 0) specs.push({ i, desc: !!od.desc, col: this.schema[i] });
    }
    if (!specs.length) return rows;
    const dec = rows.map((r, k) => ({ r, k }));
    dec.sort((a, b) => {
      for (const s of specs) {
        const c = cmp(a.r[s.i], b.r[s.i], s.col);
        if (c) return s.desc ? -c : c;
      }
      return a.k - b.k;
    });
    return dec.map(d => d.r);
  }
}
