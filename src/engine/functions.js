// Function library (01 §8): scalar, aggregate, window, table-valued and FetchXML-condition
// function tables, FUNCTION_NAMES, the FORMAT entry (§8.1, formatValue), formatMessage (§8), the JSON scanner
// and path parser (§8), the xml methods and their XPath evaluator (§8.3) and the function documentation
// (§8.2). Pure: no DOM. Local calendar fields come only from env.tz.offset() through types.js (01 §5.3); numbered
// errors take their text and severity from messages.js MESSAGES; xml values are parsed only with core/xml.js
// parseXml (through types.js xmlDoc / xmlValue), never DOMParser.
//
// Notes (extensions of 01 §8 that the spec does not state):
// - Errors without a SQL Server number (the scan limit with code 'LIMIT', the 100,000,000-character limit, the
//   GENERATE_SERIES and FORMAT size limits below, a FetchXML condition left in a client expression, FORMATMESSAGE
//   with a message number, the CREATELOOKUP/CREATEELASTICLOOKUP table kind, every `XQuery [m()]: …` text, XML DML and
//   value()'s invalid type) are SqlErrors with severity 16 and state 1 and no `number` (as parser.js raises its own),
//   so ERROR_NUMBER() and @@ERROR take whatever 01 §2 assigns to unnumbered errors (50000 would
//   keep @@ERROR non-zero, 01 §7).
// - JSON paths: an unquoted key may also contain '_' (as its first character too) and any Unicode letter or
//   digit (SQL Server accepts `$.first_name`); `append` is lower case and followed by exactly one space.
// - STRING_SPLIT: `columns(argTypes, consts, withSchema, nodes)` takes the argument AST nodes as an optional fourth
//   parameter. With them, enable_ordinal must be a literal (parenthesised or not): a variable or an expression raises
//   8748 even when the planner folded it to a constant; without them, a constant slot decides, so the
//   planner must pass them. A NULL enable_ordinal means 0 (as SQL Server documents); a constant NULL
//   separator raises 214 at bind time. value has the string argument's length and is nvarchar when the string or the
//   separator is (01 §5 applied to the TVF, as SQL Server documents STRING_SPLIT).
// - DATETIME2FROMPARTS and TIMEFROMPARTS: bind(argTypes, consts, cx, node) also raises 10760 when the precision
//   argument's expression in node.args refers to a variable (@@ globals included), a column or a subquery, as SQL
//   Server accepts only integer constants and integer constant expressions there (`1 + 2`, `CAST(3 AS int)`), also
//   when compile.js folded the variable's value into consts (01 §7 isConst). dt(argTypes, consts) and a bind call
//   without the node check the consts slot only (01 §8: non-constant or NULL raises 10760).
// - xml methods. compile.js calls `bindXmlMethod(node, operandType, {xmlns, resolve})` once per xmlmethod node:
//   node {e, method, args} with literal path and type arguments (8172 otherwise), operandType the static Type of
//   node.e (xml, a nodes() column with xmlNode: true, or a string type; 258 for any other, sql_variant included);
//   xmlns the WITH XMLNAMESPACES declarations in scope (XmlNs[]); resolve(ref) -> {fn: (row, env) => value, type} for
//   each sql:column("name") ref {kind: 'column', name, parts: name split at '.'} and sql:variable("@v") ref {kind:
//   'variable', name (lower case)}, where compile.js raises 207/209/4104/137. It returns {type, fn: (x, row, env) =>
//   value} for value/query/exist and {type: xml with xmlNode, nodes: (x, row, env) => Node[]} for nodes; row is
//   passed to the ref getters. Without resolve, sql:variable reads env.vars at run time (137 when undeclared) and a
//   sql:column ref is a TypeError (a caller bug). XML_NODES: `columns(argTypes, consts, opts)` names its column
//   opts.column; `rows([x, path], env, limit, argTypes, opts)` uses opts.bound (bindXmlMethod's result for the
//   nodes() call, so sql:column refs are bound in the enclosing scope and read env.outer; the getters get row null)
//   when given, else binds the path with opts.xmlns (this `opts` is the third columns() and fifth rows() argument,
//   where the other TVFs take withSchema). Column values are the nodes themselves (elements, attributes as XAttr
//   objects with parent/name/value/local/uri, text nodes, the document node).
// - XPath subset details: besides 01 §8.3, `p:*` name tests, an optional `fn:` prefix on the functions and the
//   predefined prefixes xml, xs, xsi, fn and sql; an unprefixed element name uses the default element namespace (the
//   prolog's or WITH XMLNAMESPACES DEFAULT), an unprefixed attribute none; xmlns declarations are not attributes.
//   Node names are resolved here, as 00 §3 assigns it: from the xmlns / xmlns:p attributes of the 01 §1 node shape
//   through each node's `parent` chain (cached per element); no namespace field of core/xml.js (its Notes'
//   prefix/local/uri/attrUris) is read. A prefix no ancestor declares (parseXml's mixed mode refuses it) matches no
//   name test and is not re-declared by query().
//   String literals take doubled quotes and the predefined and numeric entity references; XQuery comments are not
//   supported. Numbers are XPath 1.0 numbers: count(), position(), last() and string-length() are integers, string()
//   of a number never uses an exponent. data(x) is the sequence of the string values of x (query() joins them with
//   spaces). value(): a node set gives its first node's string value, a boolean 'true'/'false' to a string type and
//   1/0 otherwise, a number its XPath text to a string type and the number otherwise (NaN and ±Infinity raise 3623);
//   the type text defaults string lengths to 30 (as CAST) and raises 243 when it is not a type name. query() of an
//   atomic value gives its escaped text, and every serialised element gets the namespace declarations its subtree
//   uses from outside it (a well-formed fragment). exist(): 1 for any number, a non-empty string or binary value; a
//   false boolean, '' and an empty binary give 0 as 01 §8.3 words it ("a true or non-empty atomic value"), where SQL
//   Server returns 1 for every non-empty result, false() included (or 1 for any
//   atomic value). FUNCTION_DOCS states it in the xml.exist summary.
//   nodes() of an expression that gives no nodes raises the not-supported error. A string operand converts with
//   types.js xmlValue and is then parsed by xmlDoc; the conversions are cached like types.js's xml cache (64 entries
//   and 4,000,000 UTF-16 units of source plus value in all, least recently used first out; `xmlTextCacheSize()`
//   reports the size). sql:column/sql:variable values: strings and uniqueidentifier as strings, numbers,
//   bit as a boolean, binary, xml as its document node, date and time values as their style-126 text, NULL as the
//   empty sequence.
//   xs:base64Binary strips XML whitespace and decodes with BASE64_DECODE's decoder (9803). The unsupported-construct
//   text is 01 §8.3's `XQuery [value()]: the expression '…' is not supported.` (04 §2.1 omits the method name).
// - sql_variant: string, JSON, date, FORMAT and FORMATMESSAGE arguments of static type 'any' are read as their
//   base value with its base type (JSON_MODIFY's new value raises 8116 for a base type it does not take); AT TIME
//   ZONE is not one of them: its operand raises 8116 for sql_variant at bind time (01 §5.5, as SQL Server). Date
//   functions check the datepart against the base type at run time (9810 naming it; at bind time only the parts no
//   type takes, named for sql_variant); DATEADD computes in the base type and converts the result to datetime, the
//   call's static type (01 §5.5); DATETRUNC converts the base value to datetime2(7); DATEADD, DATETRUNC and EOMONTH
//   raise 8116 for a base type their typed argument rejects. SQL_VARIANT_PROPERTY's BaseType also names char, nchar,
//   binary and smallmoney (the Types tell them apart) and numeric for a decimal Type with types.js's `numeric` marker
//   (04 §2.1: CAST(20.0 AS sql_variant) is numeric, CONVERT(decimal(28,8), 20.0) decimal; 01 §8's BaseType list
//   lacks numeric).
//   Result Types keep the marker where a function returns the type of an argument (ISNULL, MIN, ROUND, …); the
//   decimal types a function builds (SUM, AVG, ABS, POWER, CEILING and FLOOR) are decimal. Precision is the digit
//   count of numeric types and the character length of date/time types (datetime 23, smalldatetime 16, date 10,
//   time(n) 8 + n + 1, datetime2(n) 19 + n + 1, datetimeoffset(n) 26 + n + 1, without the + 1 for n = 0); Scale the
//   decimal scale, money 4 and the fractional-second digits; MaxLength the declared byte length of strings and
//   binary, else the storage size; TotalBytes the value's bytes plus 2 (decimal +2, strings +6, binary +2,
//   time/datetime2/datetimeoffset +1), NULL above 8,000; Collation the org collation for string base types. Its first
//   argument raises 206 for xml and the max types at bind time.
// - SERVERPROPERTY reads the organization's LCID from env.org.lcid (or env.org.localeid) when the env carries one, a
//   field 01 §7's env.org does not list, else from types.js orgCollation() (the org collation that
//   setCollation(organization.localeid) set; 1033 before any call), so in the app the LCID and the accent sensitivity
//   come from one place (orgCollation is not among the 01 §5 exports, and env.org has no lcid). Collation is
//   the SQL_COLLATIONS Windows base of that LCID (the unversioned one first; Swedish 1053 and 2077 Finnish_Swedish,
//   Bulgarian 1026 Cyrillic_General, as SQL Server's Windows locales; Latin1_General when none) with _CI_AI, or
//   _CI_AS when the org collation in effect (types.js setCollation) is accent-sensitive; CollationID and LCID are the
//   LCID (01 §8); ComparisonStyle comes from collationInfo. Values are sql_variants of nvarchar(128), int or bigint
//   (EditionID). An argument that is not a string type raises 8116.
// - CREATELOOKUP and CREATEELASTICLOOKUP check the table kind against cx.meta.entities() (bind's cx): at bind time
//   for a constant table, per row otherwise (the list is indexed by logical name once per metadata generation and
//   read once per statement, so a row costs one Map lookup); a table the metadata does not list is not checked.
//   CREATEELASTICLOOKUP's ref is {entity | entityFn, pid | pidFn} (pidFn: (row, env) => partition id for a
//   non-constant one). ISNULL, COALESCE, IIF and CHOOSE pass a ref through when the refs are one object or name the
//   same table with the same partition id; a ref with entityFn or pidFn equals only itself (01 §6.2).
// - BASE64_ENCODE takes binary values only (8116 otherwise; a sql_variant by its base type); a NULL url_safe gives
//   NULL. BASE64_DECODE takes a string type; it reads the standard and the URL-safe alphabet, '=' padding optional;
//   whitespace is an invalid character (9803 state 20).
// - SUBSTRING also takes binary values (varbinary with the byte positions), as SQL Server does; LEN of a binary value
//   is its byte count without trailing 0x00; DATALENGTH of xml is 2 bytes per UTF-16 unit of the serialised text.
// - Every string function but DATALENGTH (not only the 01 §5.8 list: ASCII, CHAR, QUOTENAME, SOUNDEX, … too) raises
//   8116 for an xml argument; MIN, MAX and APPROX_COUNT_DISTINCT raise 305 for xml and STRING_AGG 8116.
// - Argument types beyond the 01 §8 rows, as SQL Server: MIN and MAX of bit or a bare NULL raise 8117 (`Operand data
//   type bit is invalid for max operator.`); ISDATE of date, time, datetime2 or datetimeoffset and EOMONTH of time or
//   a number raise 8116 (`Argument data type time is invalid for argument 1 of eomonth function.`).
// - STUFF's static length is len(s) + len(replacement) (max when either is max, capped at 4,000 / 8,000), as SQL
//   Server types it: 01 §5's "STUFF keeps len(s)" would be shorter than the values STUFF returns when the
//   replacement is longer than what it deletes, so SELECT INTO would create a column that raises 2628 for them. STRING_AGG is max when its value or its separator
//   is max (01 §5: "unless an argument is max"; SQL Server documents the value argument only).
// - ISNULL(a, b) has the type and length of a and converts (truncates) b to it, as 01 §5.1 and SQL Server specify
//   (ISNULL(varchar(2) column, 'abcd') = 'ab'); 01 §5's "CASE, COALESCE, ISNULL and IIF take the largest
//   branch" contradicts §5.1 for ISNULL.
// - LEN, DATALENGTH, CHARINDEX and PATINDEX return bigint when the measured (CHARINDEX, PATINDEX: the searched)
//   argument is varchar(max) or nvarchar(max), or varbinary(max) for LEN, DATALENGTH and CHARINDEX, else int, as SQL
//   Server documents (xml and sql_variant: int); 01 §8 does not state their types.
// - POWER and SIGN follow SQL Server's result tables where the static types differ from 01 §8's "the type of x":
//   POWER of decimal(p, s) gives decimal(38, s); smallmoney gives money and bit float for both (as ABS; SIGN of bit
//   no longer raises 8117).
// - DATEADD and DATETRUNC round a datetime2(n) or datetimeoffset(n) result with n < 7 to n fraction digits (half up),
//   as a conversion to the type does; microsecond and nanosecond ticks carry into the milliseconds. DATEADD of a
//   string literal is datetime (01 §5.5), so its microsecond and nanosecond raise 9810 as for a typed datetime (01
//   §5.3's "a string literal is not checked" holds where the string's type takes every part).
// - DATETRUNC raises 517 naming the type when the truncated value is before the type's first value (week of
//   0001-01-01, of datetime's 1753-01-01 or of smalldatetime's 1900-01-01), as DATEADD does.
// - FORMAT raises `The result of FORMAT would be longer than 4,000 characters.` instead of returning more than its
//   nvarchar(4000) type holds.
// - GENERATE_SERIES without a row limit (Infinity) raises `GENERATE_SERIES would return <n> rows, more than the browser
//   can hold (100,000,000).` above 100,000,000 rows.
// - FORMATMESSAGE / RAISERROR integer specifications take the int family, bit, bigint and decimal or money values
//   without a fraction (an integer literal beyond int is decimal); %s takes strings and uniqueidentifier; the size h
//   is 16 bits, l 32 bits, ll and I64 64 bits; an argument passed without a static type is read by its JS type.
// - FN_HELPCOLLATIONS is the TVFS name of `sys.fn_helpcollations()` (the planner resolves the schema-qualified name).
// - FUNCTION_DOCS: SYSDATETIME, SYSDATETIMEOFFSET and SYSUTCDATETIME state their millisecond resolution (env.now is a
//   Date; SQL Server: 100 ns). This deviation is stated only here and in the
//   summaries; the Help compatibility section (built from 01 §9) does not list it.

import { SqlError } from './lexer.js';
import {
  castValue, coerce, commonType, cmp, eq, keyOf, collKey, foldCh, foldIn, likeMatcher, roundDec, toSqlString, dateParts,
  fromParts, withOffset, withTicks, atTimeZone, msgTypeName, dtOf, dataTypeOf, daysInMonth, wallMs, fromWall,
  jsonEscape, plainNumber, parseDate, variant, variantValue, variantType, xmlValue, xmlDoc, collationInfo,
  sqlCollations, orgCollation as typesOrgCollation, BIGINT_LOSS,
} from './types.js';
import { MESSAGES, msg } from './messages.js';
import { xmlEsc } from '../core/xml.js';
import { suggest } from '../core/util.js';

// ------------------------------------------------------------------------------------------------- errors

// SqlError for SQL Server error `number` with its MESSAGES text (placeholders filled from args) and severity.
function E(number, ...args) {
  const m = msg(number, ...args);
  const e = new SqlError(m.message);
  e.number = number;
  e.severity = m.severity;
  e.state = 1;
  return e;
}

// SqlError for a SQL Studio message without a SQL Server number: `number` stays unset (as parser.js leaves it),
// severity 16, state 1.
function plainErr(message) {
  const e = new SqlError(message);
  e.severity = 16;
  e.state = 1;
  return e;
}

const tname = t => (t && t.dt === 'null' ? 'NULL' : msgTypeName(t || 'any'));
const badArg = (t, i, fn) => E(8116, tname(t), i, fn);
const badOp = (t, op) => E(8117, tname(t), op);
const overflow = name => E(8115, 'expression', name);
const fpErr = () => E(3623);
const E289 = name => E(289, name);
const E517 = name => E(517, name);
function scanLimit(limit) {
  const e = plainErr(`The query read more than ${groupDigits(limit)} rows to process in the browser. Add a filter or raise the limit in Settings.`);
  e.code = 'LIMIT';
  return e;
}

// Integer (a number or a BigInt) with ',' thousands separators (en-US), without Intl.
const groupDigits = n => (typeof n === 'bigint' ? String(n) : String(Math.trunc(Number(n)))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ---------------------------------------------------------------------------------------------- type helpers

const INT = Object.freeze({ dt: 'int' });
const BIGINT = Object.freeze({ dt: 'bigint' });
const FLOAT = Object.freeze({ dt: 'float' });
const GUID = Object.freeze({ dt: 'guid' });
const NV = Object.freeze({ dt: 'string', len: -1, unicode: true });
const ANY = Object.freeze({ dt: 'any' });
const DATETIME = Object.freeze({ dt: 'datetime' });
const NUMS = new Set(['int', 'bigint', 'decimal', 'money', 'float']);
const ty = t => t || ANY;
const isNull = t => ty(t).dt === 'null';
const strLike = t => { const d = ty(t).dt; return d === 'string' || d === 'any' || d === 'null'; };
const anyNull = a => { for (let i = 0; i < a.length; i++) if (a[i] == null) return true; return false; };
const nz = x => (x === 0 ? 0 : x);
const int32 = x => x >= -2147483648 && x <= 2147483647;
const isMax = t => { const x = ty(t); return x.dt === 'any' || (x.dt === 'string' && x.len === -1); };
const isUni = t => { const x = ty(t); return x.dt === 'any' || (x.dt === 'string' && !!x.unicode); };
const strCap = t => (isMax(t) ? Infinity : isUni(t) ? 4000 : 8000);

// Text of a value as an implicit conversion to varchar gives it (CAST, 01 §5.4).
function sv(v, t, env) {
  return typeof v === 'string' ? v : toSqlString(v, ty(t), { tz: env && env.tz });
}

// Integer argument (CAST to int semantics: decimal/float truncate, money rounds, strings parse; 245/8115).
function toInt(v, t, env) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isInteger(v) && int32(v)) return v;
  return coerce(v, ty(t), INT, env);
}

function toBig(v, t, env) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  return coerce(v, ty(t), BIGINT, env);
}

function toFloat(v, t, env) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  return coerce(v, ty(t), FLOAT, env);
}

// The string Type a string function returns for an argument of type t (lengths: len -1 = max).
function sType(t, len) {
  const x = ty(t);
  const r = { dt: 'string' };
  if (x.dt === 'string') {
    if (x.len != null) r.len = x.len;
    if (x.unicode) r.unicode = true;
  } else if (x.dt === 'any') {
    r.len = -1;
    r.unicode = true;
  } else r.len = convLen(x);
  if (len !== undefined) r.len = len;
  return r;
}

// Characters of a value of type t converted to varchar (an upper bound used for result lengths).
function convLen(t) {
  switch (t.dt) {
    case 'string': return t.len == null ? null : t.len;
    case 'int': return 11;
    case 'bigint': return 20;
    case 'bit': return 1;
    case 'decimal': return (t.prec ?? 38) + 2;
    case 'money': return 22;
    case 'float': return 23;
    case 'date': return 10;
    case 'time': return 16;
    case 'datetime': return 34;
    case 'guid': return 36;
    case 'binary': return t.len == null ? null : t.len;
    case 'null': return 0;
    default: return -1;
  }
}

// Highest-precedence type of the types (01 §5.1), ignoring bare NULLs (all NULL: int); prec/scale/len unified by
// commonType.
function unify(types) {
  let r = null;
  for (const t of types) {
    if (isNull(t)) continue;
    r = r ? commonType(r, ty(t)) : ty(t);
  }
  return r ? clean(r) : { dt: 'int' };
}

// A clean static Type with only the Type fields of t (argTypes may be compile results carrying fn, src, ref, json, ...);
// types.js's `numeric` marker of a decimal type is one of them.
const TYPE_FLAGS = ['prec', 'scale', 'len', 'dto', 'unicode', 'fixed', 'small', 'numeric'];

function clean(t) {
  const x = ty(t);
  const r = { dt: x.dt };
  for (const k of TYPE_FLAGS) if (x[k] != null && x[k] !== false) r[k] = x[k];
  return r;
}

const conv = (v, from, to, env) => (v == null ? null : coerce(v, ty(from), to, env));
const aiOf = ts => ts.some(t => t && t.ci_ai);
// The comparison flavour of a call's string arguments, as a = b compares them: an explicit COLLATE of an argument
// (01 §5.2), else true when one is ci_ai.
const collFlavour = ts => {
  for (const t of ts) if (t && t.coll && typeof t.coll === 'object') return t.coll;
  return aiOf(ts);
};
// The matching fold of a call (CHARINDEX, REPLACE): the org fold, or the explicit COLLATE's.
const foldFor = ts => {
  const fl = collFlavour(ts);
  return fl && typeof fl === 'object' ? s => foldIn(s, fl) : fold;
};

// Whether two refs name the same lineage (01 §6.2): one object, or the same table (any case) with the same partition
// id of an elastic lookup; a per-row table or partition function (entityFn, pidFn) is equal only to itself.
function refEq(a, b) {
  if (a === b) return true;
  if (!a.entity || !b.entity || a.entity.toLowerCase() !== b.entity.toLowerCase()) return false;
  if (a.entityFn || b.entityFn || a.pidFn || b.pidFn || !!a.poly !== !!b.poly) return false;
  return (a.pid ?? null) === (b.pid ?? null);
}

// §6.2 pass-through: the ref of the value arguments when all are equal, else undefined.
function sameRef(refs) {
  if (!refs || !refs.length) return undefined;
  const r0 = refs[0];
  if (!r0) return undefined;
  for (let i = 1; i < refs.length; i++) {
    const r = refs[i];
    if (!r || !refEq(r0, r)) return undefined;
  }
  return r0;
}

// Compile-time check that an argument of static type t converts implicitly to the numeric type `to` (int, bigint or
// float), as the run-time conversion (types.js coerce) would raise: 257 for datetime and smalldatetime, 206 for
// datetime2, datetimeoffset, date, time and uniqueidentifier (01 §5.4: they never convert to or from numbers).
function numArg(t, to) {
  const x = ty(t);
  if (x.dt === 'null' || x.dt === 'any' || x.dt === to) return;
  if (x.dt === 'datetime' && x.prec == null && !x.dto) throw E(257, tname(x), to);
  commonType(x, to === 'float' ? FLOAT : to === 'bigint' ? BIGINT : INT);
}

// 8116 for an xml argument of a string function (01 §5.8: convert with CAST(x AS nvarchar(max)) first).
function noXml(ts, fname) {
  for (let i = 0; i < ts.length; i++) if (ty(ts[i]).dt === 'xml') throw badArg(ts[i], i + 1, fname);
}

// A scalar entry; o.numArgs = {argIndex: 'int'|'bigint'|'float'} adds the numArg checks to dt, o.noXml the 8116 check
// of xml arguments (string functions).
function fnDef(name, min, max, o) {
  const e = Object.assign({ name, min, max, nulls: 'propagate' }, o);
  const na = o.numArgs, nx = o.noXml;
  delete e.numArgs;
  delete e.noXml;
  if (na || nx) {
    const dt0 = e.dt, lname = name.toLowerCase();
    e.dt = (ts, cs) => {
      if (nx) noXml(ts, lname);
      if (na) for (const k in na) if (ts[k] !== undefined) numArg(ts[k], na[k]);
      return dt0(ts, cs);
    };
  }
  return e;
}

// A string function entry: fnDef with the xml argument check (01 §5.8).
const strDef = (name, min, max, o) => fnDef(name, min, max, { noXml: true, ...o });

// The result type of LEN, DATALENGTH, CHARINDEX and PATINDEX for the measured (searched) argument of type t: bigint
// for varchar(max) and nvarchar(max) (and varbinary(max) when `bin`), else int, as SQL Server documents; xml and
// sql_variant give int.
function countType(t, bin) {
  const x = ty(t);
  return x.len === -1 && (x.dt === 'string' || (bin && x.dt === 'binary')) ? { dt: 'bigint' } : { dt: 'int' };
}

const NUM = (kind, ...idx) => Object.fromEntries(idx.map(i => [i, kind]));

// --------------------------------------------------------------------------------------------------- strings

const ASCII_RE = /^[\x00-\x7f]*$/;

// Per-unit fold of a whole string (foldCh, 01 §5.2): positions are unchanged.
function fold(s) {
  if (ASCII_RE.test(s)) return s.toLowerCase();
  let o = '';
  for (let i = 0; i < s.length; i++) o += foldCh(s[i]);
  return o;
}

const fold1 = ch => (ch.length === 1 ? foldCh(ch) : ch);

// Windows-1252 characters 0x80-0x9F (the five undefined bytes map to the C1 controls, as SQL Server does).
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f' +
  '\u0090‘’“”•–—˜™š›œ\u009džŸ';

// Code-page 1252 byte of a code point (ASCII): best fit to the unaccented letter, else '?' (63).
function cp1252Code(cp) {
  if (cp < 128 || (cp >= 160 && cp <= 255)) return cp;
  const i = cp <= 0xffff ? CP1252.indexOf(String.fromCharCode(cp)) : -1;
  if (i >= 0) return 128 + i;
  const base = String.fromCodePoint(cp).normalize('NFKD')[0];
  return base && base.charCodeAt(0) < 128 && base.charCodeAt(0) >= 32 ? base.charCodeAt(0) : 63;
}

function cp1252Char(n) {
  if (!(n >= 0 && n <= 255)) return null;
  return n >= 128 && n < 160 ? CP1252[n - 128] : String.fromCharCode(n);
}

function caseMap(s, up) {
  if (ASCII_RE.test(s)) return up ? s.toUpperCase() : s.toLowerCase();
  let out = '';
  for (const ch of s) {
    const m = up ? ch.toUpperCase() : ch.toLowerCase();
    out += m.length === ch.length ? m : ch;
  }
  return out;
}

// Removes U+0020 only (chars null) or any character of chars (foldCh matching) from the chosen ends.
function trimChars(s, chars, lead, trail) {
  let a = 0, b = s.length;
  if (chars == null) {
    if (lead) while (a < b && s.charCodeAt(a) === 32) a++;
    if (trail) while (b > a && s.charCodeAt(b - 1) === 32) b--;
  } else {
    const set = new Set();
    for (let i = 0; i < chars.length; i++) set.add(foldCh(chars[i]));
    if (lead) while (a < b && set.has(foldCh(s[a]))) a++;
    if (trail) while (b > a && set.has(foldCh(s[b - 1]))) b--;
  }
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

const rtrimSpaces = s => {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === 32) e--;
  return e === s.length ? s : s.slice(0, e);
};

// American Soundex as SQL Server computes it at compatibility level 160 (01 §8).
const SDX = '0123012-02245501262301-202';

function soundex(s) {
  const n = s.length;
  const isL = c => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  const up = c => (c >= 97 ? c - 32 : c);
  let i = 0;
  while (i < n && !isL(s.charCodeAt(i))) i++;
  if (i >= n) return '0000';
  const first = up(s.charCodeAt(i));
  let out = String.fromCharCode(first);
  let prev = SDX[first - 65];
  for (i++; i < n && out.length < 4; i++) {
    const c = s.charCodeAt(i);
    if (!isL(c)) break;
    const d = SDX[up(c) - 65];
    if (d === '-') continue;
    if (d === '0') { prev = '0'; continue; }
    if (d !== prev) out += d;
    prev = d;
  }
  return out.padEnd(4, '0');
}

const E9828 = () => E(9828);

// TRANSLATE's character map (folded `from` code point -> `to` code point; the first occurrence wins), or null when
// from and to differ in length (9828, raised when a row is translated).
function translator(from, to) {
  const F = Array.from(from), T = Array.from(to);
  if (F.length !== T.length) return null;
  const map = new Map();
  for (let i = F.length - 1; i >= 0; i--) map.set(fold1(F[i]), T[i]);
  return map;
}

function translate(s, map) {
  if (!map) throw E9828();
  let out = '';
  for (const ch of s) {
    const r = map.get(fold1(ch));
    out += r === undefined ? ch : r;
  }
  return out;
}

const QUOTES = new Map([['[', '[]'], [']', '[]'], ['"', '""'], ["'", "''"], ['(', '()'], [')', '()'], ['<', '<>'], ['>', '<>'],
  ['{', '{}'], ['}', '{}'], ['`', '``']]);

function quotename(s, q) {
  if (s.length > 128) return null;
  const p = QUOTES.get(q.length ? q[0] : '');
  if (!p) return null;
  return p[0] + s.split(p[1]).join(p[1] + p[1]) + p[1];
}

// The longest string result built here: SQL Server allows 2 GB in a max type, a browser tab cannot hold that.
const MAX_STRING = 100000000;
const tooLong = fn => plainErr(`The result of ${fn} would be longer than 100,000,000 characters.`);

// REPLACE with foldCh matching (01 §5.2); the result stops at cap characters (non-max types), and a max result
// longer than MAX_STRING raises before it is built.
function replaceFold(s, f, r, cap, fd = fold) {
  if (f === '') return s;
  const fs = fd(s), ff = fd(f);
  let i = fs.indexOf(ff);
  if (i < 0) return s;
  if (cap > MAX_STRING && r.length > f.length) {
    let count = 0;
    for (let k = i; k >= 0; k = fs.indexOf(ff, k + f.length)) count++;
    if (s.length + count * (r.length - f.length) > MAX_STRING) throw tooLong('REPLACE');
  }
  let out = '', last = 0;
  while (i >= 0) {
    out += s.slice(last, i) + r;
    last = i + f.length;
    if (out.length >= cap) return out.slice(0, cap);
    i = fs.indexOf(ff, last);
  }
  out += s.slice(last);
  return out.length > cap ? out.slice(0, cap) : out;
}

function replicate(s, n, cap) {
  if (n < 0) return null;
  if (n === 0 || s === '') return '';
  const total = s.length * n;
  if (total > cap) {
    if (cap > MAX_STRING) throw tooLong('REPLICATE');
    return s.repeat(Math.ceil(cap / s.length)).slice(0, cap);
  }
  if (total > MAX_STRING) throw tooLong('REPLICATE');
  return s.repeat(n);
}

// CONCAT / CONCAT_WS (sep null for CONCAT) of the non-NULL values a[from..]: the result stops at cap characters
// (non-max types); a max result longer than MAX_STRING raises before it is built.
function concatValues(a, ts, from, sep, cap, fn, env) {
  const lim = Math.min(cap, MAX_STRING);
  let s = '', first = true;
  for (let i = from; i < a.length; i++) {
    if (a[i] == null) continue;
    const p = first || !sep ? sv(a[i], ts[i], env) : sep + sv(a[i], ts[i], env);
    first = false;
    if (s.length + p.length > lim) {
      if (cap > MAX_STRING) throw tooLong(fn);
      return (s + p).slice(0, cap);
    }
    s += p;
  }
  return s;
}

// The segments of a PATINDEX pattern q that follows its leading '%' run: the parts between the runs of '%' outside
// [...] classes, each {src, w} with w the number of UTF-16 units it matches ('_' and each class are one), and
// whether a '%' run ends q. The first character of a class (after an optional '^') is literal, so '[%]', '[^%]' and
// '[]]' are classes, as in LIKE (01 §5.2). null when a '[' is not closed: such a pattern never matches.
function patSegments(q) {
  const segs = [];
  const n = q.length;
  let start = 0, w = 0, i = 0;
  while (i < n) {
    const c = q[i];
    if (c === '%') {
      segs.push({ src: q.slice(start, i), w });
      while (i < n && q[i] === '%') i++;
      start = i;
      w = 0;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      if (q[j] === '^') j++;
      j++;
      while (j < n && q[j] !== ']') j++;
      if (j >= n) return null;
      i = j + 1;
    } else i++;
    w++;
  }
  const trailing = start === n;
  if (!trailing) segs.push({ src: q.slice(start), w });
  return { segs, trailing };
}

// Whether segment x matches s at pos (exactly x.w units).
function segAt(x, s, pos) {
  return pos >= 0 && pos + x.w <= s.length && x.m(s.substr(pos, x.w));
}

// The leftmost position >= from where segment x matches s, or -1; fs is the folded s when x starts with a literal.
function segFind(x, s, fs, from) {
  const n = s.length;
  if (x.lit != null) {
    for (let k = fs.indexOf(x.lit, from); k >= 0 && k + x.w <= n; k = fs.indexOf(x.lit, k + 1)) if (segAt(x, s, k)) return k;
    return -1;
  }
  for (let k = from; k + x.w <= n; k++) if (segAt(x, s, k)) return k;
  return -1;
}

const PAT_NONE = () => 0;
const PAT_ONE = () => 1;

// A compiled PATINDEX pattern (01 §5.2): s -> the 1-based start of the first match of the LIKE pattern p (a leading
// % = anywhere), 0 when none. A pattern '%' seg1 '%' seg2 … is split at its '%' runs into fixed-width segments: the
// answer is the first position where seg1 matches, provided the remaining segments can then be matched
// leftmost-first after it (if they cannot, no later position can either), so a search is linear in the length of s.
function patindexFn(p, ai) {
  let i = 0;
  while (p[i] === '%') i++;
  if (i === 0) {
    const m = likeMatcher(p, null, ai);
    return s => (m(s) ? 1 : 0);
  }
  const q = p.slice(i);
  if (q === '') return PAT_ONE;
  const sg = patSegments(q);
  if (!sg) return PAT_NONE;
  const { trailing } = sg;
  const parts = sg.segs.map(seg => ({
    w: seg.w, m: likeMatcher(seg.src, null, ai), lit: !ai && seg.src[0] !== '_' && seg.src[0] !== '[' ? foldCh(seg.src[0]) : null,
  }));
  const last = parts.length - 1;
  const first = parts[0];
  const needFold = parts.some(x => x.lit != null);
  if (last === 0 && !trailing) return s => (segAt(first, s, s.length - first.w) ? s.length - first.w + 1 : 0);
  return s => {
    const n = s.length;
    const fs = needFold ? fold(s) : null;
    const k = segFind(first, s, fs, 0);
    if (k < 0) return 0;
    let pos = k + first.w;
    for (let j = 1; j <= last; j++) {
      const x = parts[j];
      if (j === last && !trailing) return n - x.w >= pos && segAt(x, s, n - x.w) ? k + 1 : 0;
      const f = segFind(x, s, fs, pos);
      if (f < 0) return 0;
      pos = f + x.w;
    }
    return k + 1;
  };
}

// STR(x, len, dec): right-aligned fixed-point text; fewer decimals when needed; asterisks when it cannot fit.
function strFn(x, len, dec) {
  if (len < 1 || len > 8000 || dec < 0) return null;
  if (dec > 16) dec = 16;
  const abs = Math.abs(x);
  const fixed = d => {
    const r = roundDec(abs, d);
    const t = plainNumber(r);
    const dot = t.indexOf('.');
    const ip = dot < 0 ? t : t.slice(0, dot);
    const fp = dot < 0 ? '' : t.slice(dot + 1);
    const body = d > 0 ? ip + '.' + fp.padEnd(d, '0').slice(0, d) : ip;
    return (x < 0 && r !== 0 ? '-' : '') + body;
  };
  let s = fixed(dec);
  if (s.length <= len) return s.padStart(len, ' ');
  const intLen = s.indexOf('.') < 0 ? s.length : s.indexOf('.');
  if (intLen > len) return '*'.repeat(len);
  const d2 = len - intLen - 1;
  s = fixed(d2 > 0 ? Math.min(d2, dec) : 0);
  if (s.length > len) s = fixed(0);
  return s.length <= len ? s.padStart(len, ' ') : '*'.repeat(len);
}

// Base64 (RFC 4648) for BASE64_ENCODE, BASE64_DECODE and xs:base64Binary (01 §8, §8.3).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let b64Index = null;

// The base64 text of bytes; urlSafe: the URL-safe alphabet (- and _) without '=' padding.
function base64Encode(bytes, urlSafe) {
  let out = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0, c = i + 2 < n ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < n ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < n ? B64[c & 63] : '=');
  }
  return urlSafe ? out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : out;
}

// 9803 'Invalid data for type "Base64Decode".' with SQL Server 2025's state: 20 for a character outside both RFC 4648
// alphabets, 21 for a length that is not a whole number of bytes, 23 for more than two '=' or data after them.
function base64Error(state) {
  const e = E(9803);
  e.state = state;
  return e;
}

// The bytes of a base64 text in the standard or the URL-safe alphabet, with or without '=' padding (01 §8).
function base64Decode(text) {
  if (!b64Index) {
    b64Index = new Int8Array(128).fill(-1);
    for (let i = 0; i < 64; i++) b64Index[B64.charCodeAt(i)] = i;
    b64Index[45] = 62; // '-'
    b64Index[95] = 63; // '_'
  }
  let len = text.length, pad = 0;
  while (len > 0 && text.charCodeAt(len - 1) === 61) { len--; pad++; }
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c === 61) throw base64Error(23);
    if (c >= 128 || b64Index[c] < 0) throw base64Error(20);
  }
  if (pad > 2) throw base64Error(23);
  const rem = len % 4;
  if (rem === 1 || (pad && (len + pad) % 4 !== 0)) throw base64Error(21);
  const out = new Uint8Array(Math.floor(len * 3 / 4));
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = b64Index[text.charCodeAt(i)], b = b64Index[text.charCodeAt(i + 1)];
    const c = i + 2 < len ? b64Index[text.charCodeAt(i + 2)] : 0, d = i + 3 < len ? b64Index[text.charCodeAt(i + 3)] : 0;
    out[o++] = (a << 2) | (b >> 4);
    if (i + 2 < len) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < len) out[o++] = ((c & 3) << 6) | d;
  }
  return out;
}

// Byte length of a value of static type t (DATALENGTH): binary its bytes, xml 2 bytes per UTF-16 unit of its
// serialised text (01 §5.8), a sql_variant its base value's.
function dataLength(v, t) {
  if (t.dt === 'any' || t.dt === 'null') {
    const base = variantValue(v);
    if (base !== v) return dataLength(base, variantType(v));
  }
  switch (t.dt) {
    case 'binary': return v.length;
    case 'xml': return 2 * String(v).length;
    case 'string': return t.unicode ? 2 * v.length : v.length;
    case 'int': return 4;
    case 'bigint': return 8;
    case 'bit': return 1;
    case 'float': return 8;
    case 'money': return t.prec === 10 ? 4 : 8;
    case 'decimal': { const p = t.prec ?? 38; return p <= 9 ? 5 : p <= 19 ? 9 : p <= 28 ? 13 : 17; }
    case 'guid': return 16;
    case 'date': return 3;
    case 'time': { const p = t.prec ?? 7; return p <= 2 ? 3 : p <= 4 ? 4 : 5; }
    case 'datetime': {
      if (t.prec == null && !t.dto) return t.small ? 4 : 8;
      const p = t.prec ?? 7;
      return (p <= 2 ? 6 : p <= 4 ? 7 : 8) + (t.dto ? 2 : 0);
    }
    default:
      if (typeof v === 'string') return 2 * v.length;
      if (v instanceof Uint8Array) return v.length;
      return 8;
  }
}

// CONCAT / CONCAT_WS result type: the summed lengths (sepTimes copies of argument 0 for CONCAT_WS), max when any
// argument is max, capped at 8,000 (4,000 for nvarchar).
function concatType(ts, from, sepTimes = 0) {
  let uni = false, max = false, len = 0, known = true;
  if (sepTimes > 0) {
    const l = convLen(ty(ts[0]));
    if (l == null || l < 0) known = false;
    else len += l * sepTimes;
  }
  for (let i = from; i < ts.length; i++) {
    const t = ty(ts[i]);
    if (isUni(t)) uni = true;
    if (isMax(t)) max = true;
    const l = convLen(t);
    if (l == null || l < 0) known = false;
    else len += l;
  }
  const r = { dt: 'string' };
  if (uni) r.unicode = true;
  if (max) r.len = -1;
  else if (known) r.len = Math.max(1, Math.min(len, uni ? 4000 : 8000));
  return r;
}

const STRINGS = [
  strDef('ASCII', 1, 1, {
    dt: () => ({ dt: 'int' }),
    eval: ([v], env, [t]) => {
      if (v == null) return null;
      const s = sv(v, t, env);
      return s === '' ? null : cp1252Code(s.codePointAt(0));
    },
  }),
  fnDef('BASE64_DECODE', 1, 1, {
    // A character expression (8116 otherwise) -> varbinary(max); 9803 for text that is not base64.
    dt(ts) {
      if (!strLike(ts[0])) throw badArg(ty(ts[0]), 1, 'base64_decode');
      return { dt: 'binary', len: -1 };
    },
    eval: ([v], env, [t]) => (v == null ? null : base64Decode(sv(v, t, env))),
  }),
  fnDef('BASE64_ENCODE', 1, 2, {
    numArgs: NUM('int', 1),
    // A binary expression (8116 otherwise) -> varchar(max); url_safe other than 0 writes the URL-safe alphabet.
    dt(ts) {
      const t = ty(ts[0]);
      if (!(t.dt === 'binary' || t.dt === 'null' || t.dt === 'any')) throw badArg(t, 1, 'base64_encode');
      return { dt: 'string', len: -1 };
    },
    eval: (a, env, ts) => {
      if (anyNull(a)) return null;
      const b = variantValue(a[0]);
      const bytes = b instanceof Uint8Array ? b : castValue(a[0], ts[0], { name: 'varbinary', args: ['max'] }, env);
      return base64Encode(bytes, a.length > 1 && toInt(a[1], ts[1], env) !== 0);
    },
  }),
  strDef('CHAR', 1, 1, {
    numArgs: NUM('int', 0),
    dt: () => ({ dt: 'string', len: 1, fixed: true }),
    eval: ([n], env, [t]) => (n == null ? null : cp1252Char(toInt(n, t, env))),
  }),
  strDef('CHARINDEX', 2, 3, {
    numArgs: NUM('bigint', 2),
    dt: ts => countType(ts[1], true),
    bind(ts, cs = []) {
      const fd = foldFor(ts);
      const cf = typeof cs[0] === 'string' ? fd(cs[0]) : null;
      return (a, env) => {
        if (a[0] == null || a[1] == null) return null;
        let start = 0;
        if (a.length > 2) {
          if (a[2] == null) return null;
          const st = toBig(a[2], ts[2], env);
          start = st > 1 ? st - 1 : 0;
        }
        const f = sv(a[0], ts[0], env), s = sv(a[1], ts[1], env);
        if (f === '' || start >= s.length) return 0;
        return fd(s).indexOf(cf ?? fd(f), start) + 1;
      };
    },
  }),
  strDef('CONCAT', 2, 254, {
    nulls: 'handled',
    dt: ts => concatType(ts, 0),
    bind(ts) {
      const cap = ts.some(isMax) ? Infinity : ts.some(isUni) ? 4000 : 8000;
      return (a, env) => concatValues(a, ts, 0, null, cap, 'CONCAT', env);
    },
  }),
  strDef('CONCAT_WS', 3, 254, {
    nulls: 'handled',
    dt: ts => concatType(ts, 0, ts.length - 3),
    bind(ts) {
      const cap = ts.some(isMax) ? Infinity : ts.some(isUni) ? 4000 : 8000;
      return (a, env) => {
        const sep = a[0] == null ? '' : sv(a[0], ts[0], env);
        return concatValues(a, ts, 1, sep, cap, 'CONCAT_WS', env);
      };
    },
  }),
  fnDef('DATALENGTH', 1, 1, {
    dt: ts => countType(ts[0], true),
    eval: ([v], env, [t]) => (v == null ? null : dataLength(v, ty(t))),
  }),
  strDef('DIFFERENCE', 2, 2, {
    dt: () => ({ dt: 'int' }),
    eval: (a, env, ts) => {
      if (anyNull(a)) return null;
      const x = soundex(sv(a[0], ts[0], env)), y = soundex(sv(a[1], ts[1], env));
      let n = 0;
      for (let i = 0; i < 4; i++) if (x[i] === y[i]) n++;
      return n;
    },
  }),
  fnDef('FORMAT', 2, 3, {
    nulls: 'handled',
    dt: (ts, cs) => formatType(ts, cs),
    bind: (ts, cs) => formatBind(ts, cs),
  }),
  strDef('LEFT', 2, 2, {
    numArgs: NUM('bigint', 1),
    dt: (ts, cs = []) => sType(ts[0], leftLen(ts[0], cs[1])),
    eval: (a, env, ts) => {
      if (anyNull(a)) return null;
      const n = toBig(a[1], ts[1], env);
      if (n < 0) throw E(537);
      return sv(a[0], ts[0], env).slice(0, n);
    },
  }),
  strDef('LEN', 1, 1, {
    dt: ts => countType(ts[0], true),
    // Characters without trailing spaces; a binary value: its bytes without trailing 0x00 (01 §5.4).
    eval: ([v], env, [t]) => {
      if (v == null) return null;
      const b = variantValue(v);
      if (b instanceof Uint8Array) {
        let n = b.length;
        while (n > 0 && b[n - 1] === 0) n--;
        return n;
      }
      return rtrimSpaces(sv(v, t, env)).length;
    },
  }),
  strDef('LOWER', 1, 1, {
    dt: ts => sType(ts[0]),
    eval: ([v], env, [t]) => (v == null ? null : caseMap(sv(v, t, env), false)),
  }),
  strDef('LTRIM', 1, 2, {
    dt: ts => sType(ts[0]),
    eval: (a, env, ts) => (anyNull(a) ? null : trimChars(sv(a[0], ts[0], env), a.length > 1 ? sv(a[1], ts[1], env) : null, true, false)),
  }),
  strDef('NCHAR', 1, 1, {
    numArgs: NUM('int', 0),
    dt: () => ({ dt: 'string', len: 1, unicode: true, fixed: true }),
    eval: ([n], env, [t]) => {
      if (n == null) return null;
      const c = toInt(n, t, env);
      if (!(c >= 0 && c <= 0x10ffff)) return null;
      return c >= 0xd800 && c <= 0xdfff ? String.fromCharCode(c) : String.fromCodePoint(c);
    },
  }),
  strDef('PATINDEX', 2, 2, {
    dt: ts => countType(ts[1], false),
    // A constant pattern is compiled once; per-row patterns go through a cache of 64 compiled patterns.
    bind(ts, cs = []) {
      const ai = collFlavour(ts);
      const fixed = typeof cs[0] === 'string' ? patindexFn(cs[0], ai) : null;
      const cache = new Map();
      let lastP = null, lastF = null;
      return (a, env) => {
        if (anyNull(a)) return null;
        let fn = fixed;
        if (!fn) {
          const p = sv(a[0], ts[0], env);
          if (p !== lastP) {
            lastF = cache.get(p);
            if (!lastF) {
              if (cache.size >= 64) cache.clear();
              cache.set(p, (lastF = patindexFn(p, ai)));
            }
            lastP = p;
          }
          fn = lastF;
        }
        return fn(sv(a[1], ts[1], env));
      };
    },
  }),
  strDef('QUOTENAME', 1, 2, {
    dt: () => ({ dt: 'string', len: 258, unicode: true }),
    eval: (a, env, ts) => (anyNull(a) ? null : quotename(sv(a[0], ts[0], env), a.length > 1 ? sv(a[1], ts[1], env) : '[')),
  }),
  strDef('REPLACE', 3, 3, {
    // nvarchar(max) / varchar(max) (01 §5); a value of a non-max s still stops at 8,000 (4,000) characters.
    dt(ts) {
      const r = { dt: 'string', len: -1 };
      if (ts.some(isUni)) r.unicode = true;
      return r;
    },
    bind(ts) {
      const cap = isMax(ts[0]) ? Infinity : ts.some(isUni) ? 4000 : 8000;
      const fd = foldFor(ts);
      return (a, env) => (anyNull(a) ? null : replaceFold(sv(a[0], ts[0], env), sv(a[1], ts[1], env), sv(a[2], ts[2], env), cap, fd));
    },
  }),
  strDef('REPLICATE', 2, 2, {
    numArgs: NUM('bigint', 1),
    dt: ts => sType(ts[0], -1),
    eval: (a, env, ts) => (anyNull(a) ? null : replicate(sv(a[0], ts[0], env), toBig(a[1], ts[1], env), strCap(ts[0]))),
  }),
  strDef('REVERSE', 1, 1, {
    dt: ts => sType(ts[0]),
    eval: ([v], env, [t]) => (v == null ? null : Array.from(sv(v, t, env)).reverse().join('')),
  }),
  strDef('RIGHT', 2, 2, {
    numArgs: NUM('bigint', 1),
    dt: (ts, cs = []) => sType(ts[0], leftLen(ts[0], cs[1])),
    eval: (a, env, ts) => {
      if (anyNull(a)) return null;
      const n = toBig(a[1], ts[1], env);
      if (n < 0) throw E(536);
      const s = sv(a[0], ts[0], env);
      return n === 0 ? '' : n >= s.length ? s : s.slice(s.length - n);
    },
  }),
  strDef('RTRIM', 1, 2, {
    dt: ts => sType(ts[0]),
    eval: (a, env, ts) => (anyNull(a) ? null : trimChars(sv(a[0], ts[0], env), a.length > 1 ? sv(a[1], ts[1], env) : null, false, true)),
  }),
  strDef('SOUNDEX', 1, 1, {
    dt: () => ({ dt: 'string', len: 4 }),
    eval: ([v], env, [t]) => (v == null ? null : soundex(sv(v, t, env))),
  }),
  strDef('SPACE', 1, 1, {
    numArgs: NUM('int', 0),
    dt: () => ({ dt: 'string', len: 8000 }),
    eval: ([n], env, [t]) => {
      if (n == null) return null;
      const k = toInt(n, t, env);
      return k < 0 ? null : ' '.repeat(Math.min(k, 8000));
    },
  }),
  strDef('STR', 1, 3, {
    numArgs: { 0: 'float', 1: 'int', 2: 'int' },
    dt: (ts, cs = []) => ({ dt: 'string', len: Number.isInteger(cs[1]) && cs[1] > 0 && cs[1] <= 8000 ? cs[1] : 10 }),
    eval: (a, env, ts) => {
      if (anyNull(a)) return null;
      const x = toFloat(a[0], ts[0], env);
      const len = a.length > 1 ? toInt(a[1], ts[1], env) : 10;
      const dec = a.length > 2 ? toInt(a[2], ts[2], env) : 0;
      return strFn(x, len, dec);
    },
  }),
  strDef('STRING_ESCAPE', 2, 2, {
    consts: [1],
    dt(ts, cs = []) {
      if (typeof cs[1] === 'string') escapeType(cs[1]);
      return { dt: 'string', len: -1, unicode: true };
    },
    eval: (a, env, ts) => {
      if (a[1] != null) escapeType(sv(a[1], ts[1], env));
      if (anyNull(a)) return null;
      return jsonEscape(sv(a[0], ts[0], env));
    },
  }),
  strDef('STUFF', 4, 4, {
    numArgs: NUM('bigint', 1, 2),
    nulls: 'handled',
    dt: stuffType,
    eval: (a, env, ts) => {
      if (a[0] == null || a[1] == null || a[2] == null) return null;
      const s = sv(a[0], ts[0], env);
      const start = toBig(a[1], ts[1], env), len = toBig(a[2], ts[2], env);
      if (start <= 0 || start > s.length || len < 0) return null;
      const r = a[3] == null ? '' : sv(a[3], ts[3], env);
      const keep = Math.max(0, s.length - (start - 1 + len));
      if (start - 1 + r.length + keep > MAX_STRING) throw tooLong('STUFF');
      return s.slice(0, start - 1) + r + s.slice(start - 1 + len);
    },
  }),
  strDef('SUBSTRING', 3, 3, {
    numArgs: NUM('bigint', 1, 2),
    // A character or binary expression (8116 otherwise); a constant length n gives min(n, len(s)) (01 §5).
    dt(ts, cs = []) {
      const t = ty(ts[0]);
      if (t.dt === 'binary') {
        const r = { dt: 'binary', len: leftLen(t, cs[2]) ?? (t.len ?? -1) };
        return r;
      }
      if (!strLike(t)) throw badArg(t, 1, 'substring');
      return sType(t, leftLen(t, cs[2]));
    },
    eval: (a, env, ts) => {
      if (anyNull(a)) return null;
      const start = toBig(a[1], ts[1], env), len = toBig(a[2], ts[2], env);
      if (len < 0) throw E(537);
      const from = Math.max(start, 1), to = start + len - 1;
      const b = variantValue(a[0]);
      if (b instanceof Uint8Array) return to < from ? new Uint8Array(0) : b.slice(from - 1, to);
      const s = sv(a[0], ts[0], env);
      return to < from ? '' : s.slice(from - 1, to);
    },
  }),
  strDef('TRANSLATE', 3, 3, {
    dt: ts => sType(ts[0]),
    // Constant from/to lists are compiled once; per-row lists go through a cache of 64 compiled maps.
    bind(ts, cs = []) {
      const fixed = typeof cs[1] === 'string' && typeof cs[2] === 'string';
      const map0 = fixed ? translator(cs[1], cs[2]) : null;
      const cache = new Map();
      let lastF = null, lastT = null, lastM = null;
      return (a, env) => {
        if (anyNull(a)) return null;
        let map = map0;
        if (!fixed) {
          const f = sv(a[1], ts[1], env), t = sv(a[2], ts[2], env);
          if (f !== lastF || t !== lastT) {
            const key = `${f.length}:${f}${t}`;
            lastM = cache.get(key);
            if (lastM === undefined) {
              if (cache.size >= 64) cache.clear();
              cache.set(key, (lastM = translator(f, t)));
            }
            lastF = f;
            lastT = t;
          }
          map = lastM;
        }
        return translate(sv(a[0], ts[0], env), map);
      };
    },
  }),
  strDef('TRIM', 1, 2, {
    dt: ts => sType(ts[ts.length - 1]),
    bind(ts, cs, cx, node) {
      const mode = node && node.trimMode ? String(node.trimMode).toUpperCase() : 'BOTH';
      const lead = mode !== 'TRAILING', trail = mode !== 'LEADING';
      const si = ts.length - 1;
      return (a, env) => {
        if (anyNull(a)) return null;
        return trimChars(sv(a[si], ts[si], env), si > 0 ? sv(a[0], ts[0], env) : null, lead, trail);
      };
    },
  }),
  strDef('UNICODE', 1, 1, {
    dt: () => ({ dt: 'int' }),
    eval: ([v], env, [t]) => {
      if (v == null) return null;
      const s = sv(v, t, env);
      return s === '' ? null : s.codePointAt(0);
    },
  }),
  strDef('UPPER', 1, 1, {
    dt: ts => sType(ts[0]),
    eval: ([v], env, [t]) => (v == null ? null : caseMap(sv(v, t, env), true)),
  }),
];

// STUFF's type: at least len(s) (01 §5), with room for the replacement: len(s) + len(replacement), max when
// either is max, capped at 4,000 (nvarchar) / 8,000; nvarchar when either is.
function stuffType(ts) {
  const s = ty(ts[0]), r = ty(ts[3]);
  const uni = isUni(s) || isUni(r);
  const out = { dt: 'string' };
  if (uni) out.unicode = true;
  if (isMax(s) || isMax(r)) {
    out.len = -1;
    return out;
  }
  const a = convLen(s), b = convLen(r);
  if (a != null && a >= 0 && b != null && b >= 0) out.len = Math.max(1, Math.min(a + b, uni ? 4000 : 8000));
  return out;
}

function leftLen(t, n) {
  const x = ty(t);
  if (Number.isInteger(n) && n >= 0 && (x.len == null || (x.len >= 0 && n < x.len))) return Math.max(n, 1);
  return undefined;
}

function escapeType(s) {
  if (String(s).toLowerCase() !== 'json') throw E(4199, `'${s}'`, 2, 'string_escape');
}

// ------------------------------------------------------------------------------------------- date helpers

const DAY = 86400000;
const W1900 = -2208988800000;
const W1753 = -6847804800000;
const W0001 = -62135596800000;
const W10000 = 253402300800000;
const W2079 = 3453321540000;
const TICKS_DAY = 864e9;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const p2 = n => (n < 10 ? '0' : '') + n;

const PART_GROUPS = [['year', 'yy', 'yyyy'], ['quarter', 'qq', 'q'], ['month', 'mm', 'm'], ['dayofyear', 'dy', 'y'],
  ['day', 'dd', 'd'], ['week', 'wk', 'ww'], ['iso_week', 'isowk', 'isoww'], ['weekday', 'dw', 'w'], ['hour', 'hh'],
  ['minute', 'mi', 'n'], ['second', 'ss', 's'], ['millisecond', 'ms'], ['microsecond', 'mcs'], ['nanosecond', 'ns'],
  ['tzoffset', 'tz']];
let PARTS = null;

function partOf(name) {
  if (!PARTS) {
    PARTS = new Map();
    for (const g of PART_GROUPS) for (const a of g) PARTS.set(a, g[0]);
  }
  return PARTS.get(String(name).toLowerCase());
}

const TIME_PARTS = new Set(['hour', 'minute', 'second', 'millisecond', 'microsecond', 'nanosecond']);
const DATE_PARTS = new Set(['year', 'quarter', 'month', 'dayofyear', 'day', 'week', 'iso_week', 'weekday']);

// Argument 1 of a date function (01 §8): [canonical part, the part as written in lower case (9810 names it, 01
// §5.3)]. A datepart node with an unknown name raises 155; a constant string must name a part, and any other first
// argument (a string that names none included) raises 1023.
function datePart(fname, ts, cs = []) {
  const t = ts && ts[0];
  const v = cs[0];
  if (typeof v !== 'string' || (t && t.dt !== 'datepart' && t.dt !== 'string')) throw E(1023, fname);
  const p = partOf(v);
  if (!p) throw t && t.dt === 'string' ? E(1023, fname) : E(155, v, fname);
  return [p, v.toLowerCase()];
}

// Static temporal kind of a type: date, time, dt (datetime), sdt, dt2, dto; str/num/null are converted at run time.
function tkind(t) {
  switch (ty(t).dt) {
    case 'date': return 'date';
    case 'time': return 'time';
    case 'datetime': return t.dto ? 'dto' : t.prec != null ? 'dt2' : t.small ? 'sdt' : 'dt';
    case 'string': case 'any': return 'str';
    case 'null': return 'null';
    case 'int': case 'bigint': case 'decimal': case 'money': case 'float': case 'bit': return 'num';
    default: return 'bad';
  }
}

const KIND_NAME = { date: 'date', time: 'time', dt: 'datetime', sdt: 'smalldatetime', dt2: 'datetime2', dto: 'datetimeoffset', any: 'sql_variant' };
const kindName = k => KIND_NAME[k] || 'datetime';
const kindPrec = (k, t) => (k === 'dt' ? 3 : k === 'sdt' ? 0 : k === 'date' ? -1 : (ty(t).prec ?? 7));
// 9810 for the part as written (`as`) on the kind k (01 §5.3).
const E9810 = (as, fname, k) => E(9810, as, fname, kindName(k));

// A date-function argument converted for its static kind: [value, kind] ('str'/'num' values are converted here). A
// string with an offset is datetimeoffset(7), any other string datetime2(7) (01 §5.5; asDatetime: datetime, as
// DATEADD reads it); a sql_variant is read as its base value with its base type (01 §5.5).
function temporal(v, k, t, env, asDatetime) {
  if (k === 'str') {
    const base = variantValue(v);
    if (base !== v) {
      const bt = variantType(v), bk = tkind(bt);
      if (bk === 'str' || bk === 'num') return temporal(base, bk, bt, env, asDatetime);
      if (asDatetime || bk === 'bad') return [castValue(base, bt, 'datetime', env), 'dt'];
      return [base, bk];
    }
    if (v instanceof Date) return [v, 'dt'];
    if (typeof v !== 'string' || asDatetime) return [castValue(v, ty(t).dt === 'string' ? t : (typeof v === 'string' ? NV : ty(t)), 'datetime', env), 'dt'];
    const d = parseDate(v, env);
    return [d, d.tzo != null ? 'dto' : 'dt2'];
  }
  if (k === 'num' || k === 'null') return [castValue(v, t, 'datetime', env), 'dt'];
  return [v, k];
}

const TIMEV = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/;

// 100 ns ticks since midnight of a time value.
function timeTicks(v) {
  let m = TIMEV.exec(v);
  if (!m) m = TIMEV.exec(castValue(String(v), NV, 'time'));
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1e7 + +(m[4] || '').padEnd(7, '0');
}

// 'hh:mm:ss[.f…]' with prec fraction digits (rounded half up), wrapping at midnight.
function ticksStr(t, prec) {
  if (prec < 7) {
    const u = 10 ** (7 - prec);
    t = Math.floor((t + u / 2) / u) * u;
  }
  t = ((t % TICKS_DAY) + TICKS_DAY) % TICKS_DAY;
  const s = Math.floor(t / 1e7), f = t % 1e7;
  return p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60) +
    (prec > 0 ? '.' + String(f).padStart(7, '0').slice(0, prec) : '');
}

function utcMs(y, m, d) {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getTime();
}

// Calendar and clock fields of a temporal value: {y, m, d, h, mi, s, f7 (100 ns ticks of the second), dow, off}.
function fieldsOf(v, k, env) {
  if (k === 'time') {
    const t = timeTicks(v);
    const s = Math.floor(t / 1e7);
    return { y: 1900, m: 1, d: 1, h: Math.floor(s / 3600), mi: Math.floor(s / 60) % 60, s: s % 60, f7: t % 1e7, dow: 1, off: 0 };
  }
  if (k === 'date') {
    return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate(), h: 0, mi: 0, s: 0, f7: 0, dow: v.getUTCDay(), off: 0 };
  }
  const p = dateParts(v, env.tz);
  return { y: p.y, m: p.m, d: p.d, h: p.h, mi: p.mi, s: p.s, f7: p.ms * 10000 + p.tk, dow: p.dow, off: p.off };
}

const isoDowOf = dow => (dow === 0 ? 7 : dow);
const weekdayOf = (dow, datefirst) => ((isoDowOf(dow) - datefirst + 7) % 7) + 1;
const dayOfYear = (y, m, d) => Math.round((utcMs(y, m, d) - utcMs(y, 1, 1)) / DAY) + 1;

function isoWeek(y, m, d) {
  const days = Math.round(utcMs(y, m, d) / DAY);
  const isoDow = isoDowOf((((days + 4) % 7) + 7) % 7);
  const thu = days + 4 - isoDow;
  const ty0 = new Date(thu * DAY).getUTCFullYear();
  return Math.floor((thu - Math.round(utcMs(ty0, 1, 1) / DAY)) / 7) + 1;
}

function weekNo(f, datefirst) {
  const jan1 = new Date(utcMs(f.y, 1, 1)).getUTCDay();
  return Math.floor((dayOfYear(f.y, f.m, f.d) - 1 + weekdayOf(jan1, datefirst) - 1) / 7) + 1;
}

const dfirst = env => { const n = env && env.datefirst; return n >= 1 && n <= 7 ? n : 7; };

function partValue(part, f, k, env) {
  switch (part) {
    case 'year': return f.y;
    case 'quarter': return Math.floor((f.m - 1) / 3) + 1;
    case 'month': return f.m;
    case 'dayofyear': return dayOfYear(f.y, f.m, f.d);
    case 'day': return f.d;
    case 'week': return weekNo(f, dfirst(env));
    case 'iso_week': return isoWeek(f.y, f.m, f.d);
    case 'weekday': return weekdayOf(f.dow, dfirst(env));
    case 'hour': return f.h;
    case 'minute': return f.mi;
    case 'second': return f.s;
    case 'millisecond': return Math.floor(f.f7 / 1e4);
    case 'microsecond': return Math.floor(f.f7 / 10);
    case 'nanosecond': return f.f7 * 100;
    default: return k === 'dto' ? f.off : 0;
  }
}

const offStr = off => (off < 0 ? '-' : '+') + p2(Math.floor(Math.abs(off) / 60)) + ':' + p2(Math.abs(off) % 60);

function partName(part, f, k, env) {
  switch (part) {
    case 'month': return MONTH_NAMES[f.m - 1];
    case 'weekday': return DAY_NAMES[f.dow];
    case 'tzoffset': return offStr(k === 'dto' ? f.off : 0);
    default: return String(partValue(part, f, k, env));
  }
}

// DATEPART/DATENAME part checks (01 §5.3): 9810 for parts the kind k does not have (as: the part as written).
function checkFieldPart(fname, part, as, k) {
  if (k === 'date' && (TIME_PARTS.has(part) || part === 'tzoffset')) throw E9810(as, fname, k);
  if (k === 'time' && (DATE_PARTS.has(part) || part === 'tzoffset')) throw E9810(as, fname, k);
  if (part === 'tzoffset' && (k === 'dt' || k === 'sdt')) throw E9810(as, fname, k);
}

function staticKind(k) {
  return k === 'str' ? 'dt2' : k === 'num' || k === 'null' ? 'dt' : k;
}

// DATEPART/DATENAME compile-time checks (1023, 155, 8116, 9810): {part, as, t, k0}.
function fieldStatic(fname, ts, cs) {
  const [part, as] = datePart(fname, ts, cs);
  const t = ty(ts[1]);
  const k0 = tkind(t);
  if (k0 === 'bad') throw badArg(t, 2, fname);
  checkFieldPart(fname, part, as, staticKind(k0));
  return { part, as, t, k0 };
}

// The wall-clock Date of a value of static kind k, read with the getUTC* getters (no tuple or field object): a date
// is its own UTC fields; datetime kinds use their own tzo, else the session tz (as dateParts); null for the kinds
// that are converted at run time (strings, numbers, NULL) and for time.
function wallDateFn(k) {
  if (k === 'date') return v => v;
  if (k === 'dt' || k === 'sdt' || k === 'dt2' || k === 'dto') return (v, env) => new Date(wallMs(v, env.tz));
  return null;
}

// Day of the year of a wall-clock Date w (1-366).
function dayOfYearW(w) {
  const y = w.getUTCFullYear();
  return Math.floor((w.getTime() - (y >= 100 ? Date.UTC(y, 0, 1) : utcMs(y, 1, 1))) / DAY) + 1;
}

// DATEPART parts read straight from the wall-clock Date (the fast path of fieldBind).
const FAST_PARTS = new Map([
  ['year', w => w.getUTCFullYear()], ['quarter', w => Math.floor(w.getUTCMonth() / 3) + 1], ['month', w => w.getUTCMonth() + 1],
  ['dayofyear', dayOfYearW], ['day', w => w.getUTCDate()], ['weekday', (w, env) => weekdayOf(w.getUTCDay(), dfirst(env))],
  ['hour', w => w.getUTCHours()], ['minute', w => w.getUTCMinutes()], ['second', w => w.getUTCSeconds()],
  ['millisecond', w => w.getUTCMilliseconds()],
]);

function fieldBind(fname, ts, cs, ret) {
  const { part, as, t, k0 } = fieldStatic(fname, ts, cs);
  const wall = ret === 'value' ? wallDateFn(k0) : null;
  const get = wall && FAST_PARTS.get(part);
  if (get) return (a, env) => (a[1] == null ? null : get(wall(a[1], env), env));
  const k1 = staticKind(k0);
  return (a, env) => {
    if (a[1] == null) return null;
    const [v, k] = temporal(a[1], k0, t, env, false);
    // A value read with another kind than the static check assumed (a sql_variant's base type, a number as
    // datetime) is checked against that kind; a string reads as datetime2 or datetimeoffset, which take every part.
    if (k !== k1) checkFieldPart(fname, part, as, k);
    const f = fieldsOf(v, k, env);
    return ret === 'name' ? partName(part, f, k, env) : partValue(part, f, k, env);
  };
}

// YEAR/MONTH/DAY argument check (8116): the static kind of the argument.
function ymdStatic(which, ts) {
  const t = ty(ts[0]);
  const k0 = tkind(t);
  if (k0 === 'bad') throw badArg(t, 1, which.toLowerCase());
  return k0;
}

function ymdBind(which) {
  return ts => {
    const t = ty(ts[0]);
    const k0 = ymdStatic(which, ts);
    const wall = wallDateFn(k0);
    if (wall) {
      const get = FAST_PARTS.get(which === 'YEAR' ? 'year' : which === 'MONTH' ? 'month' : 'day');
      return (a, env) => (a[0] == null ? null : get(wall(a[0], env)));
    }
    return (a, env) => {
      if (a[0] == null) return null;
      const [v, k] = temporal(a[0], k0, t, env, false);
      const f = fieldsOf(v, k, env);
      return which === 'YEAR' ? f.y : which === 'MONTH' ? f.m : f.d;
    };
  };
}

// Rounds an instant to datetime's 1/300 s or smalldatetime's minute (29.998 s or less down, 29.999 s or more up).
function roundMs(ms, k) {
  if (k === 'sdt') {
    const base = Math.floor(ms / 60000) * 60000;
    return ms - base >= 29999 ? base + 60000 : base;
  }
  const base = Math.floor(ms / 1000) * 1000;
  const ticks = Math.round(((ms - base) * 3) / 10);
  return base + Math.round((ticks * 10) / 3);
}

// Rounds an instant ms with tk 100-ns ticks below the millisecond to the result type's precision: datetime
// 1/300 s and smalldatetime the minute (no ticks), datetime2(n) and datetimeoffset(n) n fraction digits, half up in
// exact integer arithmetic. -> [ms, tk].
function roundTicks(ms, tk, k, prec) {
  if (k === 'sdt' || k === 'dt') return [roundMs(ms, k), 0];
  if (prec == null || prec >= 7) return [ms, tk];
  if (prec >= 4) {
    const u = 10 ** (7 - prec);
    const t = Math.floor((tk + u / 2) / u) * u;
    return t >= 10000 ? [ms + 1, 0] : [ms, t];
  }
  const u = 10 ** (3 - prec);
  const r = ((ms % u) + u) % u;
  return [(r * 10000 + tk) * 2 >= u * 10000 ? ms - r + u : ms - r, 0];
}

// A datetime value of instant ms with own offset tzo (when not null) and tk ticks below the millisecond (when not 0).
function mkDate(ms, tzo, tk) {
  let d = new Date(ms);
  if (tzo != null) d = withOffset(d, tzo);
  return tk ? withTicks(d, tk) : d;
}

function inRangeW(W, k) {
  if (k === 'dt') return W >= W1753 && W < W10000;
  if (k === 'sdt') return W >= W1900 && W <= W2079;
  return W >= W0001 && W < W10000;
}

// The datetime value for wall-clock ms W of the result kind with tk ticks below the millisecond; keep = an own offset
// to keep (or null).
function fromWallKind(W, k, keep, env, tk = 0) {
  if (keep != null) return mkDate(W - keep * 60000, keep, tk);
  if (k === 'dto') return mkDate(fromWall(W, env.tz), null, tk);
  const w = new Date(W);
  return fromParts({ y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate(), h: w.getUTCHours(), mi: w.getUTCMinutes(),
    s: w.getUTCSeconds(), ms: w.getUTCMilliseconds(), tk }, env.tz);
}

// Rounds a datetime result to its type's precision and checks its range (517); d may carry an own tzo and ticks.
function finishDt(d, k, prec, env) {
  const ms = d.getTime(), tk = d.tk || 0;
  const [r, t] = roundTicks(ms, tk, k, prec);
  const out = r === ms && t === tk ? d : mkDate(r, d.tzo ?? null, t);
  if (!inRangeW(wallMs(out, env.tz), k)) throw E517(kindName(k));
  return out;
}

const keptOffset = (v, k) => (k === 'dto' ? (v.tzo ?? null) : v.tzo === 0 ? 0 : null);

function addMonths(y, m, d, n) {
  const total = y * 12 + (m - 1) + n;
  const y2 = Math.floor(total / 12), m2 = total - y2 * 12 + 1;
  return [y2, m2, Math.min(d, y2 >= 1 && y2 <= 9999 ? daysInMonth(y2, m2) : d)];
}

const MS_UNIT = { hour: 3600000, minute: 60000, second: 1000, millisecond: 1 };
const TICK_UNIT = { hour: 36e9, minute: 6e8, second: 1e7, millisecond: 1e4, microsecond: 10 };

function dateAdd(part, n, v, k, prec, env) {
  if (k === 'time') {
    let delta;
    if (part === 'nanosecond') delta = Math.sign(n) * Math.round(Math.abs(n) / 100);
    else {
      const u = TICK_UNIT[part];
      delta = (n % (TICKS_DAY / u)) * u;
    }
    return ticksStr(timeTicks(v) + (delta % TICKS_DAY), prec);
  }
  const months = part === 'year' ? n * 12 : part === 'quarter' ? n * 3 : part === 'month' ? n : 0;
  const days = part === 'day' || part === 'dayofyear' || part === 'weekday' ? n : part === 'week' ? n * 7 : 0;
  const calendar = months !== 0 || days !== 0 || part === 'year' || part === 'quarter' || part === 'month' ||
    part === 'day' || part === 'dayofyear' || part === 'weekday' || part === 'week';
  if (k === 'date') {
    let W;
    if (months) {
      const [y, m, d] = addMonths(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate(), months);
      if (y < 1 || y > 9999) throw E517('date');
      W = utcMs(y, m, d);
    } else W = v.getTime() + days * DAY;
    if (!inRangeW(W, 'date')) throw E517('date');
    return new Date(W);
  }
  const keep = keptOffset(v, k);
  let out;
  if (calendar) {
    const W = wallMs(v, env.tz);
    let W2;
    if (months) {
      const w = new Date(W);
      const [y, m, d] = addMonths(w.getUTCFullYear(), w.getUTCMonth() + 1, w.getUTCDate(), months);
      if (y < 1 || y > 9999) throw E517(kindName(k));
      W2 = utcMs(y, m, d) + (W - Math.floor(W / DAY) * DAY);
    } else W2 = W + days * DAY;
    if (!inRangeW(W2, k)) throw E517(kindName(k));
    out = fromWallKind(W2, k, keep, env, v.tk || 0);
  } else {
    // hour .. millisecond add whole milliseconds; microsecond adds 10 ticks per unit and nanosecond n / 100 ticks
    // rounded half away from zero; the ticks carry into the milliseconds.
    let dms = 0, dtk = 0;
    if (part === 'microsecond') {
      dms = Math.trunc(n / 1000);
      dtk = (n % 1000) * 10;
    } else if (part === 'nanosecond') {
      const t = Math.sign(n) * Math.round(Math.abs(n) / 100);
      dms = Math.trunc(t / 10000);
      dtk = t % 10000;
    } else dms = n * MS_UNIT[part];
    let inst = v.getTime() + dms, tk = (v.tk || 0) + dtk;
    if (tk < 0 || tk >= 10000) {
      const c = Math.floor(tk / 10000);
      inst += c;
      tk -= c * 10000;
    }
    if (!Number.isFinite(inst) || Math.abs(inst) > 8.64e15) throw E517(kindName(k));
    out = mkDate(inst, keep, tk);
  }
  return finishDt(out, k, prec, env);
}

// DATEADD part checks (01 §5.3) for the kind k: 9810 naming the part as written.
function checkAddPart(part, as, k) {
  if (part === 'iso_week' || part === 'tzoffset' || (k === 'date' && TIME_PARTS.has(part)) || (k === 'time' && DATE_PARTS.has(part)) ||
    ((k === 'dt' || k === 'sdt') && (part === 'microsecond' || part === 'nanosecond'))) throw E9810(as, 'dateadd', k);
}

// DATEADD compile-time checks (1023, 155, 8116, 9810): {part, as, t, k0, k (result kind), prec}. A string, number or
// NULL argument is datetime (01 §5.5); a sql_variant's parts are checked against its base type at run time.
function dateAddStatic(ts, cs) {
  const [part, as] = datePart('dateadd', ts, cs);
  const t = ty(ts[2]);
  const k0 = tkind(t);
  if (k0 === 'bad') throw badArg(t, 3, 'dateadd');
  const k = k0 === 'str' || k0 === 'num' || k0 === 'null' ? 'dt' : k0;
  checkAddPart(part, as, t.dt === 'any' ? 'any' : k);
  return { part, as, t, k0, k, prec: kindPrec(k, t) };
}

// DATEADD of a sql_variant (01 §5.5): the base value with its base type (parts checked against it, 9810), the
// result converted to datetime, the call's static type; a string or number base converts to datetime first, and a
// base type a typed argument could not have raises 8116.
function variantAdd(part, as, n, x, env) {
  const bt = variantType(x);
  let v = variantValue(x), k = tkind(bt);
  if (k === 'bad') throw badArg(bt, 3, 'dateadd');
  if (k === 'str' || k === 'num' || k === 'null') {
    v = temporal(v, k, bt, env, true)[0];
    k = 'dt';
  }
  checkAddPart(part, as, k);
  const r = dateAdd(part, n, v, k, kindPrec(k, bt), env);
  return k === 'dt' ? r : castValue(r, bt, 'datetime', env);
}

function dateAddBind(ts, cs) {
  const { part, as, t, k0, k, prec } = dateAddStatic(ts, cs);
  const nT = ty(ts[1]);
  const isVariant = t.dt === 'any';
  return (a, env) => {
    if (a[1] == null || a[2] == null) return null;
    // n is truncated toward zero (01 §5.3), money included (an implicit money -> int conversion would round);
    // the integer then converts with the type's own range error (8115, 232 for float); strings convert like CAST.
    const n = nz(toInt(typeof a[1] === 'number' ? Math.trunc(a[1]) : a[1], nT, env));
    if (isVariant) return variantAdd(part, as, n, a[2], env);
    const v = k0 === k ? a[2] : temporal(a[2], k0, t, env, true)[0];
    return dateAdd(part, n, v, k, prec, env);
  };
}

function dateAddType(ts, cs) {
  const { t, k0 } = dateAddStatic(ts, cs);
  return k0 === 'str' || k0 === 'num' || k0 === 'null' ? { dt: 'datetime' } : clean(t);
}

// Wall-clock ms used for boundary counting (01 §5.3): date UTC fields, datetimeoffset the instant, else the tz wall.
function lms(v, k, env) {
  switch (k) {
    case 'date': case 'dto': return v.getTime();
    case 'time': return W1900 + Math.floor(timeTicks(v) / 1e4);
    default: return wallMs(v, env.tz);
  }
}

// The 100-ns ticks below the millisecond of a value: a time's own digits, a datetime2/datetimeoffset's tk.
const lsub = (v, k) => (k === 'time' ? timeTicks(v) % 1e4 : k === 'date' ? 0 : (v.tk || 0));
const fdiv = (a, b) => { const q = a / b; return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q; };
const yOf = L => new Date(L).getUTCFullYear();
const mOf = L => new Date(L).getUTCMonth();
const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

function diffOverflow(big) {
  const f = big ? 'datediff_big' : 'datediff';
  return E(535, f);
}

function dateDiff(part, va, ka, vb, kb, env, big) {
  if (part === 'microsecond' || part === 'nanosecond') {
    const A = BigInt(lms(va, ka, env)) * 10000n + BigInt(lsub(va, ka));
    const B = BigInt(lms(vb, kb, env)) * 10000n + BigInt(lsub(vb, kb));
    const d = part === 'nanosecond' ? (B - A) * 100n : fdiv(B, 10n) - fdiv(A, 10n);
    if (big) {
      if (d < I64_MIN || d > I64_MAX) throw diffOverflow(true);
      const r = Number(d);
      if (!Number.isSafeInteger(r) && env && env.warn) env.warn(BIGINT_LOSS);
      return nz(r);
    }
    if (d < -2147483648n || d > 2147483647n) throw diffOverflow(false);
    return nz(Number(d));
  }
  const La = lms(va, ka, env), Lb = lms(vb, kb, env);
  let r;
  switch (part) {
    case 'year': r = yOf(Lb) - yOf(La); break;
    case 'quarter': r = (4 * yOf(Lb) + Math.floor(mOf(Lb) / 3)) - (4 * yOf(La) + Math.floor(mOf(La) / 3)); break;
    case 'month': r = (12 * yOf(Lb) + mOf(Lb)) - (12 * yOf(La) + mOf(La)); break;
    case 'week': r = Math.floor((Math.floor(Lb / DAY) + 4) / 7) - Math.floor((Math.floor(La / DAY) + 4) / 7); break;
    case 'hour': r = Math.floor(Lb / 3600000) - Math.floor(La / 3600000); break;
    case 'minute': r = Math.floor(Lb / 60000) - Math.floor(La / 60000); break;
    case 'second': r = Math.floor(Lb / 1000) - Math.floor(La / 1000); break;
    case 'millisecond': r = Lb - La; break;
    default: r = Math.floor(Lb / DAY) - Math.floor(La / DAY);
  }
  if (!big && !int32(r)) throw diffOverflow(false);
  return nz(r);
}

// DATEDIFF/DATEDIFF_BIG compile-time checks (1023, 155, 8116, 9810): {part, ta, tb, ka, kb}.
function diffStatic(fname, ts, cs) {
  const [part, as] = datePart(fname, ts, cs);
  const ta = ty(ts[1]), tb = ty(ts[2]);
  const ka = tkind(ta), kb = tkind(tb);
  if (ka === 'bad') throw badArg(ta, 2, fname);
  if (kb === 'bad') throw badArg(tb, 3, fname);
  if (part === 'tzoffset' || part === 'iso_week') throw E9810(as, fname, ta.dt === 'any' ? 'any' : staticKind(ka));
  return { part, ta, tb, ka, kb };
}

function dateDiffBind(fname, big) {
  return (ts, cs) => {
    const { part, ta, tb, ka, kb } = diffStatic(fname, ts, cs);
    return (a, env) => {
      if (a[1] == null || a[2] == null) return null;
      const [va, xa] = temporal(a[1], ka, ta, env, false);
      const [vb, xb] = temporal(a[2], kb, tb, env, false);
      return dateDiff(part, va, xa, vb, xb, env, big);
    };
  };
}

const TRUNC_PARTS = new Set(['year', 'quarter', 'month', 'dayofyear', 'day', 'week', 'iso_week', 'hour', 'minute', 'second',
  'millisecond', 'microsecond']);

// DATETRUNC part checks (01 §5.3) for the kind k of fractional-second scale prec: 9810 naming the part as written.
function checkTruncPart(part, as, k, prec) {
  if (!TRUNC_PARTS.has(part) || (k === 'date' && TIME_PARTS.has(part)) || (k === 'time' && DATE_PARTS.has(part)) ||
    (part === 'millisecond' && prec < 3) || (part === 'microsecond' && prec < 6)) throw E9810(as, 'datetrunc', k);
}

// DATETRUNC compile-time checks (1023, 155, 8116, 9810): {part, as, t, k0, k, prec}; strings are datetime2(7), and a
// sql_variant's parts are checked against its base type at run time (01 §5.5).
function truncStatic(ts, cs) {
  const [part, as] = datePart('datetrunc', ts, cs);
  const t = ty(ts[1]);
  const k0 = tkind(t);
  if (k0 === 'bad' || k0 === 'num') throw badArg(t, 2, 'datetrunc');
  const k = k0 === 'str' || k0 === 'null' ? 'dt2' : k0;
  const prec = k0 === 'str' || k0 === 'null' ? 7 : kindPrec(k, t);
  checkTruncPart(part, as, t.dt === 'any' ? 'any' : k, prec);
  return { part, as, t, k0, k, prec };
}

function truncType(ts, cs) {
  const { t, k0 } = truncStatic(ts, cs);
  return k0 === 'str' || k0 === 'null' ? { dt: 'datetime', prec: 7 } : clean(t);
}

// CAST target of a DATETRUNC string argument: one frozen object, so types.js caches the compiled target.
const DT2_7 = Object.freeze({ name: 'datetime2', args: [7] });

// The datetime2(7) value of a sql_variant DATETRUNC argument, after the part check against its base type (01 §5.5):
// a date, time or datetime base keeps the rules of its own type (8116 for a number base, as for a typed number).
function variantTruncArg(part, as, x, env) {
  const bt = variantType(x), bk = tkind(bt);
  if (bk === 'num' || bk === 'bad') throw badArg(bt, 2, 'datetrunc');
  if (bk !== 'str') checkTruncPart(part, as, bk, kindPrec(bk, bt));
  const v = variantValue(x);
  return castValue(v, bk === 'str' && typeof v === 'string' ? NV : bt, DT2_7, env);
}

function truncBind(ts, cs) {
  const { part, as, t, k0, k, prec } = truncStatic(ts, cs);
  const isVariant = t.dt === 'any';
  return (a, env) => {
    if (a[1] == null) return null;
    let v = a[1];
    if (isVariant) v = variantTruncArg(part, as, v, env);
    else if (k0 === 'str' || k0 === 'null') v = castValue(v, typeof v === 'string' ? NV : t, DT2_7, env);
    return dateTrunc(part, v, k, prec, env);
  };
}

// DATETRUNC of v (kind k, scale prec). A result before the type's first value (week and iso_week of the first days of
// 0001-01-01, of datetime's 1753-01-01 or of smalldatetime's 1900-01-01) raises 517 naming the type, as DATEADD does.
function dateTrunc(part, v, k, prec, env) {
  if (k === 'time') {
    let t = timeTicks(v);
    const u = part === 'hour' ? 36e9 : part === 'minute' ? 6e8 : part === 'second' ? 1e7 : part === 'millisecond' ? 1e4 : 10;
    t = Math.floor(t / u) * u;
    return ticksStr(t, prec);
  }
  const df = dfirst(env);
  if (k === 'date') {
    const W = truncWall(part, v.getTime(), df);
    if (!inRangeW(W, 'date')) throw E517('date');
    return new Date(W);
  }
  const W2 = truncWall(part, wallMs(v, env.tz), df);
  if (!inRangeW(W2, k)) throw E517(kindName(k));
  // microsecond keeps the ticks of whole microseconds; every other part drops the ticks.
  const tk = part === 'microsecond' ? (v.tk || 0) - ((v.tk || 0) % 10) : 0;
  return fromWallKind(W2, k, keptOffset(v, k), env, tk);
}

function truncWall(part, W, datefirst) {
  const w = new Date(W);
  const y = w.getUTCFullYear(), m = w.getUTCMonth() + 1;
  const day0 = Math.floor(W / DAY) * DAY;
  switch (part) {
    case 'year': return utcMs(y, 1, 1);
    case 'quarter': return utcMs(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
    case 'month': return utcMs(y, m, 1);
    case 'week': return day0 - (weekdayOf(w.getUTCDay(), datefirst) - 1) * DAY;
    case 'iso_week': return day0 - (isoDowOf(w.getUTCDay()) - 1) * DAY;
    case 'hour': return Math.floor(W / 3600000) * 3600000;
    case 'minute': return Math.floor(W / 60000) * 60000;
    case 'second': return Math.floor(W / 1000) * 1000;
    case 'millisecond': case 'microsecond': return W;
    default: return day0;
  }
}

function eomonthBind(ts) {
  const t = ty(ts[0]);
  const k0 = tkind(t);
  if (k0 === 'bad' || k0 === 'time' || k0 === 'num') throw badArg(t, 1, 'eomonth');
  return (a, env) => {
    if (a[0] == null || (a.length > 1 && a[1] == null)) return null;
    const n = a.length > 1 ? toInt(a[1], ts[1], env) : 0;
    let y, m;
    if (k0 === 'date') { y = a[0].getUTCFullYear(); m = a[0].getUTCMonth() + 1; }
    else if (k0 === 'str' || k0 === 'null') {
      // A sql_variant is read with its base type (01 §5.5): a time or number base raises 8116 as the typed value does.
      if (t.dt === 'any') {
        const bt = variantType(a[0]), bk = tkind(bt);
        if (bk === 'time' || bk === 'num' || bk === 'bad') throw badArg(bt, 1, 'eomonth');
      }
      const d = castValue(a[0], typeof a[0] === 'string' ? NV : t, 'date', env);
      y = d.getUTCFullYear(); m = d.getUTCMonth() + 1;
    } else {
      const p = dateParts(a[0], env.tz);
      y = p.y; m = p.m;
    }
    const total = y * 12 + (m - 1) + n;
    const y2 = Math.floor(total / 12), m2 = total - y2 * 12 + 1;
    if (y2 < 1 || y2 > 9999) throw E517('date');
    return new Date(utcMs(y2, m2, daysInMonth(y2, m2)));
  };
}

// The integer value arguments 0..n-1 of a *FROMPARTS call, or null when one is NULL.
function intParts(a, ts, n, env) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (a[i] == null) return null;
    out[i] = toInt(a[i], ts[i], env);
  }
  return out;
}

const validYmd = (y, m, d, lo, hi) => y >= lo && y <= hi && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
const validHms = (h, mi, s) => h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59;

// AST node types that make an expression depend on the row or the batch (a variable, a column or a subquery), so it
// is not one of SQL Server's "integer constant expressions" even when compile.js folded its value into consts.
const ROW_NODE_TYPES = new Set(['var', 'col', 'subq', 'exists', 'quantified']);

// Whether the argument expression n refers to a variable (@@ globals included), a column or a subquery.
function refersToRow(n) {
  const stack = [n];
  while (stack.length) {
    const x = stack.pop();
    if (!x || typeof x !== 'object') continue;
    if (Array.isArray(x)) {
      for (const y of x) stack.push(y);
      continue;
    }
    if (ROW_NODE_TYPES.has(x.type) || (x.type === 'in' && x.query)) return true;
    for (const k in x) if (k !== 'pos' && k !== 'end' && Object.hasOwn(x, k)) stack.push(x[k]);
  }
  return false;
}

// The precision argument of DATETIME2FROMPARTS/TIMEFROMPARTS: an integer constant 0..7 (10760, 1002). With the fn
// node (bind's fourth argument), an argument that refers to a variable, column or subquery raises 10760 too, as in
// SQL Server, also when its value was folded into consts.
function precArg(cs, i, tn, node) {
  const p = cs && cs[i];
  const n = typeof p === 'number' ? p : typeof p === 'string' && /^\s*\d+\s*$/.test(p) ? Number(p) : NaN;
  if (p == null || !Number.isInteger(n) || (node && Array.isArray(node.args) && refersToRow(node.args[i]))) {
    throw E(10760, tn);
  }
  if (n < 0 || n > 7) throw E(1002, n);
  return n;
}

const fracOk = (f, p) => f >= 0 && f < 10 ** p;

const DATES = [
  fnDef('AT_TIME_ZONE', 2, 2, {
    nulls: 'handled',
    // 01 §5.5: datetime, smalldatetime, datetime2 or datetimeoffset only (a bare NULL gives NULL); sql_variant and
    // every other static type raise 8116 at bind time, as SQL Server. The result is datetimeoffset(3) for datetime,
    // (0) for smalldatetime and (n) for datetime2(n) / datetimeoffset(n), a datetimeoffset without prec being (7).
    dt(ts) {
      const t = ty(ts[0]), z = ty(ts[1]);
      if (!(t.dt === 'datetime' || t.dt === 'null')) throw badArg(t, 1, 'AT TIME ZONE');
      if (!strLike(z)) throw badArg(z, 2, 'AT TIME ZONE');
      const prec = t.dt !== 'datetime' ? 7 : t.prec != null ? t.prec : t.dto ? 7 : t.small ? 0 : 3;
      return { dt: 'datetime', prec, dto: true };
    },
    eval: (a, env, ts) => atTimeZone(a[0], ty(ts[0]), a[1], env.tz),
  }),
  fnDef('DATEADD', 3, 3, { consts: [0], numArgs: NUM('int', 1), dt: dateAddType, bind: dateAddBind }),
  fnDef('DATEDIFF', 3, 3, { consts: [0], dt: (ts, cs) => (diffStatic('datediff', ts, cs), { dt: 'int' }), bind: dateDiffBind('datediff', false) }),
  fnDef('DATEDIFF_BIG', 3, 3, {
    consts: [0],
    dt: (ts, cs) => (diffStatic('datediff_big', ts, cs), { dt: 'bigint' }),
    bind: dateDiffBind('datediff_big', true),
  }),
  fnDef('DATEFROMPARTS', 3, 3, {
    numArgs: NUM('int', 0, 1, 2),
    dt: () => ({ dt: 'date' }),
    eval: (a, env, ts) => {
      const p = intParts(a, ts, 3, env);
      if (!p) return null;
      if (!validYmd(p[0], p[1], p[2], 1, 9999)) throw E289('date');
      return new Date(utcMs(p[0], p[1], p[2]));
    },
  }),
  fnDef('DATENAME', 2, 2, {
    consts: [0],
    dt: (ts, cs) => { fieldStatic('datename', ts, cs); return { dt: 'string', len: 30, unicode: true }; },
    bind: (ts, cs) => fieldBind('datename', ts, cs, 'name'),
  }),
  fnDef('DATEPART', 2, 2, {
    consts: [0],
    dt: (ts, cs) => { fieldStatic('datepart', ts, cs); return { dt: 'int' }; },
    bind: (ts, cs) => fieldBind('datepart', ts, cs, 'value'),
  }),
  fnDef('DATETIME2FROMPARTS', 8, 8, {
    numArgs: NUM('int', 0, 1, 2, 3, 4, 5, 6),
    consts: [7],
    dt: (ts, cs) => ({ dt: 'datetime', prec: precArg(cs, 7, 'datetime2') }),
    bind(ts, cs, cx, node) {
      const prec = precArg(cs, 7, 'datetime2', node);
      return (a, env) => {
        const p = intParts(a, ts, 7, env);
        if (!p) return null;
        const [y, m, d, h, mi, s, f] = p;
        if (!validYmd(y, m, d, 1, 9999) || !validHms(h, mi, s) || !fracOk(f, prec)) throw E289('datetime2');
        // fractions / 10^precision seconds as 100-ns ticks: the milliseconds and the ticks below them.
        const ticks = f * 10 ** (7 - prec);
        return fromParts({ y, m, d, h, mi, s, ms: Math.floor(ticks / 10000), tk: ticks % 10000 }, env.tz);
      };
    },
  }),
  fnDef('DATETIMEFROMPARTS', 7, 7, {
    numArgs: NUM('int', 0, 1, 2, 3, 4, 5, 6),
    dt: () => ({ dt: 'datetime' }),
    eval: (a, env, ts) => {
      const p = intParts(a, ts, 7, env);
      if (!p) return null;
      const [y, m, d, h, mi, s, ms] = p;
      if (!validYmd(y, m, d, 1753, 9999) || !validHms(h, mi, s) || !(ms >= 0 && ms <= 999)) throw E289('datetime');
      const v = fromParts({ y, m, d, h, mi, s, ms }, env.tz);
      const r = roundMs(v.getTime(), 'dt');
      const out = r === v.getTime() ? v : v.tzo != null ? withOffset(new Date(r), v.tzo) : new Date(r);
      if (!inRangeW(wallMs(out, env.tz), 'dt')) throw E289('datetime');
      return out;
    },
  }),
  fnDef('DATETRUNC', 2, 2, { consts: [0], dt: truncType, bind: truncBind }),
  fnDef('DAY', 1, 1, { dt: ts => (ymdStatic('DAY', ts), { dt: 'int' }), bind: ymdBind('DAY') }),
  fnDef('EOMONTH', 1, 2, {
    numArgs: NUM('int', 1),
    dt(ts) {
      const k = tkind(ts[0]);
      if (k === 'bad' || k === 'time' || k === 'num') throw badArg(ty(ts[0]), 1, 'eomonth');
      return { dt: 'date' };
    },
    bind: eomonthBind,
  }),
  fnDef('GETDATE', 0, 0, { dt: () => ({ dt: 'datetime' }), eval: (a, env) => new Date(roundMs(now(env).getTime(), 'dt')) }),
  fnDef('GETUTCDATE', 0, 0, { dt: () => ({ dt: 'datetime' }), eval: (a, env) => withOffset(new Date(roundMs(now(env).getTime(), 'dt')), 0) }),
  fnDef('ISDATE', 1, 1, {
    nulls: 'handled',
    dt(ts) {
      const k = tkind(ts[0]);
      if (k === 'date' || k === 'time' || k === 'dt2' || k === 'dto' || k === 'bad') throw badArg(ty(ts[0]), 1, 'isdate');
      return { dt: 'int' };
    },
    eval: ([v], env, [t]) => {
      if (v == null) return 0;
      if (v instanceof Date) return 1;
      const s = sv(v, t, env);
      // '' converts to 1900-01-01 in CAST, but ISDATE('') is 0 in SQL Server.
      if (/^[ \t\r\n]*$/.test(s)) return 0;
      try {
        return castValue(s, NV, 'datetime', { tz: env.tz, dateformat: env.dateformat, try: true }) == null ? 0 : 1;
      } catch (e) {
        if (e instanceof SqlError) return 0;
        throw e;
      }
    },
  }),
  fnDef('MONTH', 1, 1, { dt: ts => (ymdStatic('MONTH', ts), { dt: 'int' }), bind: ymdBind('MONTH') }),
  fnDef('SMALLDATETIMEFROMPARTS', 5, 5, {
    numArgs: NUM('int', 0, 1, 2, 3, 4),
    dt: () => ({ dt: 'datetime', small: true }),
    eval: (a, env, ts) => {
      const p = intParts(a, ts, 5, env);
      if (!p) return null;
      const [y, m, d, h, mi] = p;
      if (!validYmd(y, m, d, 1900, 2079) || !validHms(h, mi, 0) || utcMs(y, m, d) > utcMs(2079, 6, 6)) throw E289('smalldatetime');
      return fromParts({ y, m, d, h, mi, s: 0, ms: 0 }, env.tz);
    },
  }),
  fnDef('SYSDATETIME', 0, 0, { dt: () => ({ dt: 'datetime', prec: 7 }), eval: (a, env) => now(env) }),
  fnDef('SYSDATETIMEOFFSET', 0, 0, {
    dt: () => ({ dt: 'datetime', prec: 7, dto: true }),
    eval: (a, env) => {
      const d = now(env);
      return withOffset(d, env.tz && !env.tz.utc ? env.tz.offset(d.getTime()) : 0);
    },
  }),
  fnDef('SYSUTCDATETIME', 0, 0, { dt: () => ({ dt: 'datetime', prec: 7 }), eval: (a, env) => withOffset(now(env), 0) }),
  fnDef('TIMEFROMPARTS', 5, 5, {
    numArgs: NUM('int', 0, 1, 2, 3),
    consts: [4],
    dt: (ts, cs) => ({ dt: 'time', prec: precArg(cs, 4, 'time') }),
    bind(ts, cs, cx, node) {
      const prec = precArg(cs, 4, 'time', node);
      return (a, env) => {
        const p = intParts(a, ts, 4, env);
        if (!p) return null;
        const [h, mi, s, f] = p;
        if (!validHms(h, mi, s) || !fracOk(f, prec)) throw E289('time');
        return p2(h) + ':' + p2(mi) + ':' + p2(s) + (prec > 0 ? '.' + String(f).padStart(prec, '0') : '');
      };
    },
  }),
  fnDef('YEAR', 1, 1, { dt: ts => (ymdStatic('YEAR', ts), { dt: 'int' }), bind: ymdBind('YEAR') }),
];

const now = env => (env && env.now instanceof Date ? env.now : new Date());

// ------------------------------------------------------------------------------------------------------ math

// Result type of ABS/CEILING/FLOOR/SIGN/ROUND/POWER-like functions for an argument type (8117 for bit and others).
function mathType(t, op) {
  switch (t.dt) {
    case 'int': case 'bigint': case 'decimal': case 'money': case 'float': return clean(t);
    case 'string': case 'any': return { dt: 'float' };
    case 'null': return { dt: 'int' };
    default: throw badOp(t, op);
  }
}

const numIn = (v, t, rt, env) => (rt.dt === 'float' && typeof v !== 'number' ? coerce(v, t, FLOAT, env) : v);

function checkInt(r, rt) {
  if (rt.dt === 'int' && !int32(r)) throw overflow('int');
  if (rt.dt === 'bigint' && !(r >= -9223372036854775808 && r < 9223372036854775808)) throw overflow('bigint');
  if (rt.dt === 'money' && !(r >= -922337203685477.5808 && r <= 922337203685477.5807)) throw overflow('money');
  return r;
}

function fitScale(r, rt) {
  if (rt.dt !== 'decimal') return r;
  const s = rt.scale ?? 0, p = rt.prec ?? 38;
  const x = roundDec(r, s);
  if (Math.abs(x) >= 10 ** (p - s)) throw overflow('numeric');
  return x;
}

// Float functions: argument converted to float (206/257/8114), NaN/Infinity raise 3623.
function floatFn(name, f, min = 1, max = 1) {
  return fnDef(name, min, max, {
    dt(ts) {
      for (const t of ts) numArg(t, 'float');
      return { dt: 'float' };
    },
    eval: (a, env, ts) => {
      if (anyNull(a)) return null;
      const x = toFloat(a[0], ts[0], env);
      const r = a.length > 1 ? f(x, toFloat(a[1], ts[1], env)) : f(x);
      if (!Number.isFinite(r)) throw fpErr();
      return nz(r);
    },
  });
}

function angleType(t, op) {
  const x = ty(t);
  switch (x.dt) {
    case 'int': case 'bigint': case 'money': case 'float': return clean(x);
    case 'decimal': return { dt: 'decimal', prec: 38, scale: Math.max(x.scale ?? 0, 18) };
    case 'string': case 'any': case 'bit': return { dt: 'float' };
    case 'null': return { dt: 'int' };
    default: throw badOp(x, op);
  }
}

function angleFn(name, factor) {
  return fnDef(name, 1, 1, {
    dt: ts => angleType(ts[0], name.toLowerCase()),
    bind(ts) {
      const t = ty(ts[0]);
      const rt = angleType(t, name.toLowerCase());
      return (a, env) => {
        if (a[0] == null) return null;
        const x = toFloat(a[0], t, env);
        let r = x * factor;
        if (!Number.isFinite(r)) throw fpErr();
        if (rt.dt === 'int' || rt.dt === 'bigint') r = Math.trunc(r);
        else if (rt.dt === 'money') r = roundDec(r, 4);
        return nz(checkInt(fitScale(r, rt), rt));
      };
    },
  });
}

let fallbackRand = null;

// A seedable pseudo-random generator for RAND (mulberry32): {seed(n), next() -> [0, 1)}.
export function createRand(seed) {
  const r = {
    s: 0,
    seed(n) { this.s = Number(n) >>> 0; },
    next() {
      let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
  r.seed(seed == null ? Math.floor(Math.random() * 4294967296) : seed);
  return r;
}

const randOf = env => (env && env.rand && typeof env.rand.next === 'function' ? env.rand : (fallbackRand || (fallbackRand = createRand())));

// POWER(x, y) has the type of x (decimal: decimal(38, s)); y must convert to float.
// POWER's result type (01 §8 "the type of x", with SQL Server's POWER table where the static types differ): the int
// family int, bigint bigint, decimal(p, s) decimal(38, s), money and smallmoney money, float, bit and strings float.
function powerType(ts) {
  const t = ty(ts[0]);
  if (t.dt === 'bit') return { dt: 'float' };
  const rt = mathType(t, 'power');
  if (ts[1]) numArg(ts[1], 'float');
  if (rt.dt === 'money') return { dt: 'money', prec: 19, scale: 4 };
  return rt.dt === 'decimal' ? { dt: 'decimal', prec: 38, scale: rt.scale ?? 0 } : rt;
}

// ABS's result type (01 §8): the int family int, bigint bigint, decimal(p, s) decimal(38, s), money and
// smallmoney money, float, real and bit float (strings convert to float); 8117 for the other types.
function absType(t) {
  switch (t.dt) {
    case 'decimal': return { dt: 'decimal', prec: 38, scale: t.scale ?? 0 };
    case 'money': return { dt: 'money', prec: 19, scale: 4 };
    case 'bit': return { dt: 'float' };
    default: return mathType(t, 'abs');
  }
}

// SIGN's result type (01 §8: "the type of x", decimal scale included), with SQL Server's return-type table
// where a static type has no SIGN of its own: bit → float (as ABS), smallmoney → money.
function signType(t) {
  if (t.dt === 'bit') return { dt: 'float' };
  if (t.dt === 'money') return { dt: 'money', prec: 19, scale: 4 };
  return mathType(t, 'sign');
}

const MATH = [
  fnDef('ABS', 1, 1, {
    dt: ts => absType(ty(ts[0])),
    bind(ts) {
      const t = ty(ts[0]), rt = absType(t);
      return (a, env) => {
        if (a[0] == null) return null;
        const x = numIn(a[0], t, rt, env);
        if (rt.dt === 'int' && x === -2147483648) throw overflow('int');
        if (rt.dt === 'bigint' && x <= -9223372036854775808) throw overflow('bigint');
        return nz(Math.abs(x));
      };
    },
  }),
  floatFn('ACOS', Math.acos),
  floatFn('ASIN', Math.asin),
  floatFn('ATAN', Math.atan),
  floatFn('ATN2', Math.atan2, 2, 2),
  ...['CEILING', 'FLOOR'].map(name => fnDef(name, 1, 1, {
    dt(ts) {
      const rt = mathType(ty(ts[0]), name.toLowerCase());
      return rt.dt === 'decimal' ? { dt: 'decimal', prec: rt.prec ?? 38, scale: 0 } : rt;
    },
    bind(ts) {
      const t = ty(ts[0]), rt = mathType(t, name.toLowerCase());
      const f = name === 'CEILING' ? Math.ceil : Math.floor;
      return (a, env) => (a[0] == null ? null : nz(f(numIn(a[0], t, rt, env))));
    },
  })),
  floatFn('COS', Math.cos),
  floatFn('COT', x => 1 / Math.tan(x)),
  angleFn('DEGREES', 180 / Math.PI),
  floatFn('EXP', Math.exp),
  floatFn('LOG', (x, b) => (b === undefined ? Math.log(x) : Math.log(x) / Math.log(b)), 1, 2),
  floatFn('LOG10', Math.log10),
  fnDef('PI', 0, 0, { dt: () => ({ dt: 'float' }), eval: () => Math.PI }),
  fnDef('POWER', 2, 2, {
    dt: powerType,
    bind(ts) {
      const t = ty(ts[0]);
      const rt = powerType(ts);
      return (a, env) => {
        if (anyNull(a)) return null;
        const x = toFloat(a[0], t, env), y = toFloat(a[1], ts[1], env);
        let r = Math.pow(x, y);
        if (!Number.isFinite(r)) throw fpErr();
        if (rt.dt === 'int' || rt.dt === 'bigint') r = Math.trunc(r);
        else if (rt.dt === 'money') r = roundDec(r, 4);
        return nz(checkInt(fitScale(r, rt), rt));
      };
    },
  }),
  angleFn('RADIANS', Math.PI / 180),
  fnDef('RAND', 0, 1, {
    numArgs: NUM('int', 0),
    nulls: 'handled',
    dt: () => ({ dt: 'float' }),
    bind(ts) {
      if (ts.length) {
        return (a, env) => {
          if (a[0] == null) return null;
          const g = randOf(env);
          g.seed(toInt(a[0], ts[0], env));
          return g.next();
        };
      }
      let key = null, now0 = null, value = 0;
      return (a, env) => {
        if (key !== env || now0 !== (env && env.now)) {
          key = env;
          now0 = env && env.now;
          value = randOf(env).next();
        }
        return value;
      };
    },
  }),
  fnDef('ROUND', 2, 3, {
    numArgs: NUM('int', 1, 2),
    dt: ts => mathType(ty(ts[0]), 'round'),
    bind(ts) {
      const t = ty(ts[0]), rt = mathType(t, 'round');
      return (a, env) => {
        if (anyNull(a)) return null;
        const x = numIn(a[0], t, rt, env);
        const n = toInt(a[1], ts[1], env);
        const trunc = a.length > 2 && toInt(a[2], ts[2], env) !== 0;
        if ((rt.dt === 'int' || rt.dt === 'bigint') && n >= 0) return x;
        const r = roundDec(x, n, trunc);
        if (rt.dt === 'decimal') {
          const s = rt.scale ?? 0, p = rt.prec ?? 38;
          if (Math.abs(r) >= 10 ** (p - s)) throw overflow('numeric');
          return nz(r);
        }
        return nz(checkInt(r, rt));
      };
    },
  }),
  fnDef('SIGN', 1, 1, {
    dt: ts => signType(ty(ts[0])),
    bind(ts) {
      const t = ty(ts[0]), rt = signType(t);
      return (a, env) => (a[0] == null ? null : nz(Math.sign(numIn(a[0], t, rt, env))));
    },
  }),
  floatFn('SIN', Math.sin),
  floatFn('SQRT', Math.sqrt),
  floatFn('SQUARE', x => x * x),
  floatFn('TAN', Math.tan),
];

// ------------------------------------------------------------------------------------------ logical / null

const E8133 = () => E(8133);

function chooseType(ts) {
  const vs = ts.slice(1);
  if (vs.every(isNull)) throw E8133();
  return unify(vs);
}

function coalesceType(ts) {
  if (ts.every(isNull)) throw E(4127);
  return unify(ts);
}

function iifType(ts) {
  if (isNull(ts[1]) && isNull(ts[2])) throw E8133();
  return unify([ts[1], ts[2]]);
}

function isnullType(ts) {
  const a = ty(ts[0]), b = ty(ts[1]);
  if (a.dt === 'null') return b.dt === 'null' ? { dt: 'int' } : clean(b);
  return clean(a);
}

function nullifType(ts) {
  const a = ty(ts[0]);
  if (a.dt === 'null') throw E(4151);
  return clean(a);
}

// ISNULL's second argument converted to the result type (the type of the first; strings truncate to its length).
function isnullSecond(ts) {
  const rt = isnullType(ts);
  const b = ty(ts[1]);
  const dtype = rt.dt === 'string' && rt.len > 0 ? dataTypeOf(rt) : null;
  return (w, env) => (w == null ? null : dtype ? castValue(w, b, dtype, env) : coerce(w, b, rt, env));
}

const LOGICAL = [
  fnDef('CHOOSE', 2, Infinity, {
    numArgs: NUM('int', 0),
    nulls: 'handled',
    dt: chooseType,
    ref: refs => sameRef(refs && refs.slice(1)),
    bind(ts) {
      const rt = chooseType(ts);
      return (a, env) => {
        if (a[0] == null) return null;
        const i = toInt(a[0], ts[0], env);
        return i >= 1 && i < a.length ? conv(a[i], ts[i], rt, env) : null;
      };
    },
    bindLazy(ts) {
      const rt = chooseType(ts);
      return (fns, env, row) => {
        const i0 = fns[0](row, env);
        if (i0 == null) return null;
        const i = toInt(i0, ts[0], env);
        if (!(i >= 1 && i < fns.length)) return null;
        return conv(fns[i](row, env), ts[i], rt, env);
      };
    },
  }),
  fnDef('COALESCE', 2, Infinity, {
    nulls: 'handled',
    dt: coalesceType,
    ref: refs => sameRef(refs),
    bind(ts) {
      const rt = coalesceType(ts);
      return (a, env) => {
        for (let i = 0; i < a.length; i++) if (a[i] != null) return conv(a[i], ts[i], rt, env);
        return null;
      };
    },
    bindLazy(ts) {
      const rt = coalesceType(ts);
      return (fns, env, row) => {
        for (let i = 0; i < fns.length; i++) {
          const v = fns[i](row, env);
          if (v != null) return conv(v, ts[i], rt, env);
        }
        return null;
      };
    },
  }),
  fnDef('GREATEST', 1, 254, { nulls: 'handled', dt: ts => unify(ts), bind: ts => extremeFn(ts, 1) }),
  fnDef('IIF', 3, 3, {
    nulls: 'handled',
    preds: [0],
    dt: iifType,
    ref: refs => sameRef(refs && [refs[1], refs[2]]),
    bind(ts) {
      const rt = iifType(ts);
      return (a, env) => (a[0] === true ? conv(a[1], ts[1], rt, env) : conv(a[2], ts[2], rt, env));
    },
    bindLazy(ts) {
      const rt = iifType(ts);
      return (fns, env, row) => (fns[0](row, env) === true ? conv(fns[1](row, env), ts[1], rt, env) : conv(fns[2](row, env), ts[2], rt, env));
    },
  }),
  fnDef('ISNULL', 2, 2, {
    nulls: 'handled',
    dt: isnullType,
    ref: refs => sameRef(refs),
    bind(ts) {
      const second = isnullSecond(ts);
      return (a, env) => (a[0] != null ? a[0] : second(a[1], env));
    },
    bindLazy(ts) {
      const second = isnullSecond(ts);
      return (fns, env, row) => {
        const v = fns[0](row, env);
        return v != null ? v : second(fns[1](row, env), env);
      };
    },
  }),
  fnDef('LEAST', 1, 254, { nulls: 'handled', dt: ts => unify(ts), bind: ts => extremeFn(ts, -1) }),
  fnDef('NULLIF', 2, 2, {
    nulls: 'handled',
    dt: nullifType,
    ref: refs => (refs ? refs[0] : undefined),
    bind(ts) {
      nullifType(ts);
      const a = ty(ts[0]), b = ty(ts[1]);
      const ct = commonType(a, b);
      const ai = collFlavour(ts);
      return (args, env) => {
        const x = args[0];
        if (x == null) return null;
        const y = args[1];
        if (y == null) return x;
        return eq(conv(x, a, ct, env), conv(y, b, ct, env), ct, ai) === true ? null : x;
      };
    },
  }),
];

function extremeFn(ts, sign) {
  const rt = unify(ts);
  const ai = collFlavour(ts);
  return (a, env) => {
    let best = null;
    for (let i = 0; i < a.length; i++) {
      if (a[i] == null) continue;
      const v = conv(a[i], ts[i], rt, env);
      if (best == null || cmp(v, best, rt, ai) * sign > 0) best = v;
    }
    return best;
  };
}

// ISNUMERIC: 1 when the text converts to any numeric type (int, decimal, float, money), SQL Server's lenient rule.
const NUMERIC_TEXT = /^([+-]?)(\p{Sc}?)([+-]?)([\d,]*)(\.\d*)?([eEdD][+-]?\d+)?$/u;
const isBlankUnit = c => c === 32 || c === 9 || c === 10 || c === 13;

function isNumericText(s) {
  // Spaces, tabs, CR and LF at both ends are ignored (01 §5.4). Index loops, not a regex: an end-anchored regex
  // alternative backtracks quadratically over a long whitespace run inside a large memo value.
  let a = 0, b = s.length;
  while (a < b && isBlankUnit(s.charCodeAt(a))) a++;
  while (b > a && isBlankUnit(s.charCodeAt(b - 1))) b--;
  if (a === b) return 0;
  const t = a === 0 && b === s.length ? s : s.slice(a, b);
  const m = NUMERIC_TEXT.exec(t);
  if (!m) return 0;
  if (m[1] && m[3]) return 0;
  const digits = /\d/.test(m[4]) || /\d/.test(m[5] || '');
  if (m[6]) {
    if (m[2] || m[4].includes(',') || !digits) return 0;
    const x = Number(((m[1] || m[3]) + (m[4] || '0') + (m[5] || '') + 'e' + m[6].slice(1)).replace(/^\+/, ''));
    return Number.isFinite(x) ? 1 : 0;
  }
  return 1;
}

// --------------------------------------------------------------------------------------------------------- JSON

function jsonTextErr(text, i) {
  return E(13609, i < text.length ? text[i] : '', i);
}

const MAX_JSON_DEPTH = 2000;

// JSON scanner with value offsets: node = {t: 'o'|'a'|'s'|'n'|'t'|'f'|'z', s, e, kids}; object kids {ks, ke, k, v}.
function parseJson(text) {
  const n = text.length;
  let i = 0;
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };
  const str = () => {
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) { i++; return; }
      if (c === 92) {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) throw jsonTextErr(text, Math.min(i + 2, n));
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else throw jsonTextErr(text, i + 1);
        continue;
      }
      if (c < 32) throw jsonTextErr(text, i);
      i++;
    }
    throw jsonTextErr(text, n);
  };
  const digits = () => {
    const s = i;
    while (i < n && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
    if (i === s) throw jsonTextErr(text, i);
  };
  const num = () => {
    const s = i;
    if (text[i] === '-') i++;
    if (text[i] === '0') i++;
    else digits();
    if (text[i] === '.') { i++; digits(); }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      digits();
    }
    return { t: 'n', s, e: i };
  };
  const value = depth => {
    if (depth > MAX_JSON_DEPTH) throw jsonTextErr(text, i);
    ws();
    if (i >= n) throw jsonTextErr(text, i);
    const c = text.charCodeAt(i);
    const s = i;
    if (c === 123) {
      i++;
      const kids = [];
      ws();
      if (text.charCodeAt(i) === 125) { i++; return { t: 'o', s, e: i, kids }; }
      for (;;) {
        ws();
        if (text.charCodeAt(i) !== 34) throw jsonTextErr(text, i);
        const ks = i;
        str();
        const ke = i;
        ws();
        if (text.charCodeAt(i) !== 58) throw jsonTextErr(text, i);
        i++;
        const v = value(depth + 1);
        kids.push({ ks, ke, k: null, v });
        ws();
        const d = text.charCodeAt(i);
        if (d === 44) { i++; continue; }
        if (d === 125) { i++; return { t: 'o', s, e: i, kids }; }
        throw jsonTextErr(text, i);
      }
    }
    if (c === 91) {
      i++;
      const kids = [];
      ws();
      if (text.charCodeAt(i) === 93) { i++; return { t: 'a', s, e: i, kids }; }
      for (;;) {
        kids.push(value(depth + 1));
        ws();
        const d = text.charCodeAt(i);
        if (d === 44) { i++; continue; }
        if (d === 93) { i++; return { t: 'a', s, e: i, kids }; }
        throw jsonTextErr(text, i);
      }
    }
    if (c === 34) { str(); return { t: 's', s, e: i }; }
    if (c === 45 || (c >= 48 && c <= 57)) return num();
    if (text.startsWith('true', i)) { i += 4; return { t: 't', s, e: i }; }
    if (text.startsWith('false', i)) { i += 5; return { t: 'f', s, e: i }; }
    if (text.startsWith('null', i)) { i += 4; return { t: 'z', s, e: i }; }
    throw jsonTextErr(text, i);
  };
  const root = value(0);
  ws();
  if (i < n) throw jsonTextErr(text, i);
  return root;
}

// Decoded text of a JSON string token text[s..e) (with its quotes).
function decodeStr(text, s, e) {
  const body = text.slice(s + 1, e - 1);
  if (!body.includes('\\')) return body;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const x = body[++i];
    switch (x) {
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'u': out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4; break;
      default: out += x;
    }
  }
  return out;
}

const keyText = (text, kid) => (kid.k == null ? (kid.k = decodeStr(text, kid.ks, kid.ke)) : kid.k);

function findKey(text, obj, key) {
  for (let i = 0; i < obj.kids.length; i++) if (keyText(text, obj.kids[i]) === key) return i;
  return -1;
}

function pathErr(p, i) {
  return E(13607, i < p.length ? p[i] : '', i);
}

// A letter of an unquoted JSON path key: a Unicode letter or '_' starts a key; letters, digits and '_' continue it.
const KEY_START = /^[\p{L}_]$/u;
const KEY_PART = /^[\p{L}\p{N}_]$/u;

// JSON path (01 §8): [append ][lax |strict ]$<steps> -> {append, strict, steps: [{k} | {i}], dollar}. The
// keywords are lower case, each followed by exactly one space; append only when allowAppend (JSON_MODIFY). Steps:
// .key (an unquoted key: a letter or '_', then letters, digits and '_'), ."quoted key" (escapes \" and \) and [n]
// (n a non-negative integer). Anything else raises 13607 at its 0-based position.
function parsePath(p, allowAppend) {
  const n = p.length;
  let i = 0, append = false, mode = null;
  while (i < n && p[i] !== '$') {
    const w = p.startsWith('append', i) ? 'append' : p.startsWith('strict', i) ? 'strict' : p.startsWith('lax', i) ? 'lax' : null;
    if (!w || (w === 'append' ? !allowAppend || append || mode != null : mode != null)) throw pathErr(p, i);
    if (w === 'append') append = true;
    else mode = w;
    i += w.length;
    if (p[i] !== ' ') throw pathErr(p, i);
    i++;
  }
  if (p[i] !== '$') throw pathErr(p, i);
  const dollar = i;
  i++;
  const steps = [];
  while (i < n) {
    const c = p[i];
    if (c === '.') {
      i++;
      if (p[i] === '"') {
        let k = '';
        i++;
        for (;;) {
          if (i >= n) throw pathErr(p, n);
          const ch = p[i];
          if (ch === '\\') {
            const nx = p[i + 1];
            if (nx !== '"' && nx !== '\\') throw pathErr(p, i + 1);
            k += nx;
            i += 2;
            continue;
          }
          if (ch === '"') { i++; break; }
          k += ch;
          i++;
        }
        steps.push({ k });
      } else {
        const s = i;
        for (let first = true; i < n; first = false) {
          const ch = String.fromCodePoint(p.codePointAt(i));
          if (!(first ? KEY_START : KEY_PART).test(ch)) break;
          i += ch.length;
        }
        if (i === s) throw pathErr(p, i);
        steps.push({ k: p.slice(s, i) });
      }
    } else if (c === '[') {
      i++;
      const s = i;
      while (i < n && p[i] >= '0' && p[i] <= '9') i++;
      if (i === s || p[i] !== ']') throw pathErr(p, i);
      steps.push({ i: Number(p.slice(s, i)) });
      i++;
    } else throw pathErr(p, i);
  }
  return { append, strict: mode === 'strict', steps, dollar };
}

// The node at steps[0..upto) or null.
function walk(text, node, steps, upto = steps.length) {
  for (let k = 0; k < upto && node; k++) {
    const st = steps[k];
    if (st.k !== undefined) {
      if (node.t !== 'o') return null;
      const i = findKey(text, node, st.k);
      node = i < 0 ? null : node.kids[i].v;
    } else {
      if (node.t !== 'a') return null;
      node = node.kids[st.i] || null;
    }
  }
  return node || null;
}

function scalarText(text, node) {
  switch (node.t) {
    case 's': return decodeStr(text, node.s, node.e);
    case 'n': return text.slice(node.s, node.e);
    case 't': return 'true';
    case 'f': return 'false';
    default: return null;
  }
}

const E13608 = () => E(13608);

// Parsed JSON text and paths, cached per call site for the last input (constant documents and paths are parsed once).
function jsonCache() {
  let lt = null, lr = null;
  const paths = new Map();
  return {
    doc(text) {
      if (text !== lt) { lr = parseJson(text); lt = text; }
      return lr;
    },
    path(p, allowAppend = false) {
      let r = paths.get(p);
      if (!r) {
        r = parsePath(p, allowAppend);
        if (paths.size > 64) paths.clear();
        paths.set(p, r);
      }
      return r;
    },
  };
}

function jsonArgCheck(ts, fname) {
  if (!strLike(ts[0])) throw badArg(ty(ts[0]), 1, fname);
  if (ts.length > 1 && !strLike(ts[1])) throw badArg(ty(ts[1]), 2, fname);
}

// JSON text of a JSON_MODIFY new value (01 §8): strings quoted, numbers as toSqlString digits, bit true/false, json raw.
function jsonText(v, t, env) {
  if (t && t.json) return String(v);
  const base = variantValue(v);
  if (base !== v) {
    // A sql_variant is written by its base type, which must be one JSON_MODIFY takes (8116 otherwise).
    const bt = variantType(v);
    if (!JSON_NEW_TYPES.has(bt.dt)) throw badArg(bt, 3, 'json_modify');
    return jsonText(base, bt, env);
  }
  switch (ty(t).dt) {
    case 'string': return '"' + jsonEscape(v) + '"';
    case 'bit': return v ? 'true' : 'false';
    case 'int': case 'bigint': case 'decimal': case 'money': case 'float': return toSqlString(v, t, { tz: env.tz });
    default:
      if (typeof v === 'number') return plainNumber(v);
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      return '"' + jsonEscape(String(v)) + '"';
  }
}

const JSON_NEW_TYPES = new Set(['string', 'int', 'bigint', 'decimal', 'money', 'float', 'bit', 'null', 'any']);

// JSON_MODIFY(expression, path, newValue): nvarchar(max) with json: true; 8116 for argument types it does not accept.
function jsonModifyType(ts) {
  if (!strLike(ts[0])) throw badArg(ty(ts[0]), 1, 'json_modify');
  if (!strLike(ts[1])) throw badArg(ty(ts[1]), 2, 'json_modify');
  const t = ty(ts[2]);
  if (!t.json && !JSON_NEW_TYPES.has(t.dt)) throw badArg(t, 3, 'json_modify');
  return { dt: 'string', len: -1, unicode: true, json: true };
}

function splice(text, s, e, ins) {
  return text.slice(0, s) + ins + text.slice(e);
}

function addMember(text, container, ins) {
  if (container.kids.length) {
    const last = container.kids[container.kids.length - 1];
    const end = container.t === 'o' ? last.v.e : last.e;
    return splice(text, end, end, ',' + ins);
  }
  return splice(text, container.s + 1, container.s + 1, ins);
}

function deleteMember(text, obj, idx) {
  const kids = obj.kids, kid = kids[idx];
  if (kids.length === 1) return text.slice(0, kid.ks) + text.slice(kid.v.e);
  if (idx < kids.length - 1) return text.slice(0, kid.ks) + text.slice(kids[idx + 1].ks);
  return text.slice(0, kids[idx - 1].v.e) + text.slice(kid.v.e);
}

function appendTo(text, arr, P, vt) {
  if (arr.t !== 'a') {
    if (P.strict) throw E(13613);
    return text;
  }
  if (vt == null) {
    if (!P.strict) return text;
    vt = 'null';
  }
  return addMember(text, arr, vt);
}

// The JSON_MODIFY splice for path P (at least one step) and the JSON text vt of the new value (null for NULL).
function jsonModify(text, root, P, vt) {
  const steps = P.steps;
  const parent = walk(text, root, steps, steps.length - 1);
  const last = steps[steps.length - 1];
  if (!parent || (last.k !== undefined ? parent.t !== 'o' : parent.t !== 'a')) {
    if (P.strict) throw E13608();
    return text;
  }
  if (last.k !== undefined) {
    const idx = findKey(text, parent, last.k);
    if (idx < 0) {
      if (P.strict) throw E13608();
      if (vt == null) return text;
      return addMember(text, parent, '"' + jsonEscape(last.k) + '":' + (P.append ? '[' + vt + ']' : vt));
    }
    const v = parent.kids[idx].v;
    if (P.append) return appendTo(text, v, P, vt);
    if (vt == null) return P.strict ? splice(text, v.s, v.e, 'null') : deleteMember(text, parent, idx);
    return splice(text, v.s, v.e, vt);
  }
  const v = parent.kids[last.i];
  if (!v) {
    if (P.strict) throw E13608();
    return text;
  }
  if (P.append) return appendTo(text, v, P, vt);
  return splice(text, v.s, v.e, vt ?? 'null');
}

const ISJSON_TYPES = new Set(['VALUE', 'ARRAY', 'OBJECT', 'SCALAR']);

// The ISJSON type keyword of a constant second argument (undefined: not a constant): 102 near the constant, or SQL
// Studio's own wording under 102 for a non-constant argument (01 §8).
function isjsonType(v) {
  if (v === undefined) {
    const e = plainErr('The second argument of ISJSON must be one of the keywords VALUE, ARRAY, OBJECT or SCALAR.');
    e.number = 102;
    e.severity = MESSAGES[102].severity;
    throw e;
  }
  if (v === null) throw E(102, 'NULL');
  const k = typeof v === 'string' ? v.toUpperCase() : '';
  if (!ISJSON_TYPES.has(k)) throw E(102, typeof v === 'string' ? v : String(v));
  return k;
}

// ISJSON of a text with a type keyword (null: the default, an object or array); NULL text gives NULL.
function isjson(text, type) {
  if (text == null) return null;
  let root;
  try {
    root = parseJson(text);
  } catch (e) {
    if (e instanceof SqlError && e.number === 13609) return 0;
    throw e;
  }
  switch (type) {
    case 'VALUE': return 1;
    case 'ARRAY': return root.t === 'a' ? 1 : 0;
    case 'OBJECT': return root.t === 'o' ? 1 : 0;
    case 'SCALAR': return root.t === 's' || root.t === 'n' ? 1 : 0;
    default: return root.t === 'o' || root.t === 'a' ? 1 : 0;
  }
}

const JSONS = [
  fnDef('ISJSON', 1, 2, {
    consts: [1],
    keywords: { 1: ISJSON_TYPES },
    dt(ts, cs = []) {
      if (!strLike(ts[0])) throw badArg(ty(ts[0]), 1, 'isjson');
      if (ts.length > 1) isjsonType(cs[1]);
      return { dt: 'int' };
    },
    bind(ts, cs = []) {
      const type = ts.length > 1 ? isjsonType(cs[1]) : null;
      return (a, env) => isjson(a[0] == null ? null : sv(a[0], ts[0], env), type);
    },
  }),
  fnDef('JSON_MODIFY', 3, 3, {
    nulls: 'handled',
    dt: jsonModifyType,
    bind(ts) {
      jsonModifyType(ts);
      const c = jsonCache();
      const t = ty(ts[2]);
      return (a, env) => {
        if (a[0] == null || a[1] == null) return null;
        const text = sv(a[0], ts[0], env);
        const path = sv(a[1], ts[1], env);
        const P = c.path(path, true);
        // `$` alone raises 13607, with or without append (01 §8 JSON_MODIFY).
        if (!P.steps.length) throw pathErr(path, P.dollar);
        const root = c.doc(text);
        if (a[2] != null && !t.json && !JSON_NEW_TYPES.has(t.dt)) throw badArg(t, 3, 'json_modify');
        return jsonModify(text, root, P, a[2] == null ? null : jsonText(a[2], t, env));
      };
    },
  }),
  fnDef('JSON_PATH_EXISTS', 2, 2, {
    // int 1/0 (NULL for a NULL argument); it never raises: JSON text or a path that is not properly formatted gives 0,
    // as SQL Server documents.
    dt: ts => (jsonArgCheck(ts, 'json_path_exists'), { dt: 'int' }),
    bind(ts) {
      const c = jsonCache();
      return (a, env) => {
        if (anyNull(a)) return null;
        const text = sv(a[0], ts[0], env);
        let root, P;
        try {
          root = c.doc(text);
          P = c.path(sv(a[1], ts[1], env));
        } catch (e) {
          if (e instanceof SqlError && (e.number === 13609 || e.number === 13607)) return 0;
          throw e;
        }
        return walk(text, root, P.steps) ? 1 : 0;
      };
    },
  }),
  fnDef('JSON_QUERY', 1, 2, {
    dt: ts => (jsonArgCheck(ts, 'json_query'), { dt: 'string', len: -1, unicode: true, json: true }),
    bind(ts) {
      const c = jsonCache();
      return (a, env) => {
        if (anyNull(a)) return null;
        const text = sv(a[0], ts[0], env);
        const root = c.doc(text);
        const P = c.path(a.length > 1 ? sv(a[1], ts[1], env) : '$');
        const node = walk(text, root, P.steps);
        if (!node) {
          if (P.strict) throw E13608();
          return null;
        }
        if (node.t !== 'o' && node.t !== 'a') {
          if (P.strict) throw E(13624);
          return null;
        }
        return text.slice(node.s, node.e);
      };
    },
  }),
  fnDef('JSON_VALUE', 2, 2, {
    dt: ts => (jsonArgCheck(ts, 'json_value'), { dt: 'string', len: 4000, unicode: true }),
    bind(ts) {
      const c = jsonCache();
      return (a, env) => {
        if (anyNull(a)) return null;
        const text = sv(a[0], ts[0], env);
        const root = c.doc(text);
        const P = c.path(sv(a[1], ts[1], env));
        const node = walk(text, root, P.steps);
        if (!node) {
          if (P.strict) throw E13608();
          return null;
        }
        if (node.t === 'o' || node.t === 'a') {
          if (P.strict) throw E(13623);
          return null;
        }
        const v = scalarText(text, node);
        if (v != null && v.length > 4000) {
          if (P.strict) throw E(13625);
          return null;
        }
        return v;
      };
    },
  }),
];

// ----------------------------------------------------------------------------------------- printf (RAISERROR)

// %[flags][width][.precision][size]type (01 §8): flags - + 0 space #, width and precision a number or *, size
// h, l, ll or I64, type d i o s u x X.
const SPEC_RE = /%([-+0# ]*)(\*|\d+)?(?:\.(\*|\d+))?(ll|l|h|I64)?([diosuxX])?/y;
const MAX_MESSAGE = 2047;

// The integer of a substitution argument for an integer specification, or undefined when its type does not match
// (2786): the int family, bit, bigint and decimal values without a fraction (an integer literal beyond int).
function intArg(v, t) {
  if (t.dt === 'int' || t.dt === 'bigint' || t.dt === 'bit') return typeof v === 'number' ? v : Number(v);
  if (t.dt === 'decimal' || t.dt === 'money') return Number.isInteger(v) ? v : undefined;
  return undefined;
}

// FORMATMESSAGE/RAISERROR substitution (01 §8; 02 §9): every placeholder of fmt is replaced by the next
// argument; a placeholder without an argument, or with NULL, prints (null). Widths and precisions (also from '*')
// are capped at 2,047, the length of the whole result. 2786 for an argument of the wrong type, 2787 for an invalid
// specification. A sql_variant argument is formatted by its base value and type.
export function formatMessage(fmt, args = [], argTypes = []) {
  let out = '', ai = 0, i = 0;
  // The next argument for a 's' or integer ('d') specification: undefined when there is none, null for NULL.
  const next = kind => {
    const idx = ai++;
    if (idx >= args.length) return undefined;
    let v = args[idx], t = ty(argTypes[idx]);
    if (v == null) return null;
    if (t.dt === 'any' || t.dt === 'null') {
      // A sql_variant by its base type; a value whose type the caller did not give by its JS type.
      const base = variantValue(v);
      if (base !== v) [v, t] = [base, variantType(v)];
      else if (typeof v === 'number') t = Number.isInteger(v) ? (int32(v) ? INT : BIGINT) : FLOAT;
      else if (typeof v === 'string') t = NV;
    }
    if (kind === 's') {
      if (typeof v === 'string' && (t.dt === 'string' || t.dt === 'guid' || t.dt === 'any' || t.dt === 'null')) return v;
      throw E(2786, idx + 1);
    }
    const n = intArg(v, t);
    if (n === undefined || !Number.isFinite(n)) throw E(2786, idx + 1);
    return { n, big: t.dt === 'bigint' };
  };
  while (i < fmt.length) {
    const c = fmt[i];
    if (c !== '%') { out += c; i++; continue; }
    if (fmt[i + 1] === '%') { out += '%'; i += 2; continue; }
    SPEC_RE.lastIndex = i;
    const m = SPEC_RE.exec(fmt);
    if (!m || !m[5]) {
      const end = m ? SPEC_RE.lastIndex + 1 : i + 2;
      throw E(2787, fmt.slice(i, Math.min(end, fmt.length)));
    }
    i = SPEC_RE.lastIndex;
    const flags = m[1], size = m[4] || '';
    const star = () => { const x = next('d'); return x == null ? null : x.n; };
    let width = m[2] === '*' ? star() : m[2] ? Number(m[2]) : 0;
    let prec = m[3] === '*' ? star() : m[3] != null ? Number(m[3]) : null;
    // The output never exceeds 2,047 characters, so larger widths and precisions are capped before any padding.
    width = width == null || width < 0 ? 0 : Math.min(width, MAX_MESSAGE);
    if (prec != null) prec = prec < 0 ? null : Math.min(prec, MAX_MESSAGE);
    const type = m[5];
    const v = next(type === 's' ? 's' : 'd');
    let body;
    if (v == null) body = '(null)';
    else if (type === 's') {
      body = v;
      if (prec != null) body = body.slice(0, prec);
    } else {
      let n = BigInt(Math.trunc(v.n));
      // h is a 16-bit value, I64 and ll 64-bit; otherwise 32 bits, unless the value needs 64 (a bigint argument).
      const bits = size === 'h' ? 16 : size === 'I64' || size === 'll' || v.big || n > 2147483647n || n < -2147483648n ? 64 : 32;
      if (bits === 16) n = BigInt.asIntN(16, n);
      let digits, sign = '';
      if (type === 'd' || type === 'i') {
        digits = (n < 0n ? -n : n).toString();
        sign = n < 0n ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
      } else {
        const u = BigInt.asUintN(bits, n);
        digits = type === 'u' ? u.toString() : type === 'o' ? u.toString(8) : u.toString(16);
        if (type === 'X') digits = digits.toUpperCase();
        if (flags.includes('#') && u !== 0n) sign = type === 'o' ? '0' : type === 'x' ? '0x' : type === 'X' ? '0X' : '';
      }
      if (prec != null) digits = digits.padStart(prec, '0');
      body = flags.includes('0') && !flags.includes('-') && prec == null ? sign + digits.padStart(Math.max(width - sign.length, 0), '0') : sign + digits;
    }
    if (body.length < width) body = flags.includes('-') ? body.padEnd(width, ' ') : body.padStart(width, ' ');
    out += body;
  }
  return out.length > MAX_MESSAGE ? out.slice(0, MAX_MESSAGE) : out;
}

// ------------------------------------------------------------------------------------- CONTAINS (full text)

function ftErr(near, cond) {
  return E(7630, near, cond);
}

// Words of a text for full-text matching: runs of letters and digits, compared with collKey.
function ftWords(s) {
  const out = [];
  const re = /[\p{L}\p{N}_]+/gu;
  let m;
  while ((m = re.exec(s))) out.push(collKey(m[0]));
  return out;
}

// Compiles a CONTAINS search condition ('a OR b', '"phrase"', '"pre*"', AND, AND NOT, &, |, &!, parentheses)
// to a matcher over the word list of a value.
function compileContains(cond) {
  if (cond == null || /^\s*$/.test(cond)) throw E(7645);
  const toks = [];
  const re = /\s*(?:("(?:[^"]|"")*")|(\()|(\))|(&!|&|\||!)|([^\s()"&|!]+))/gy;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < cond.length && (m = re.exec(cond))) {
    if (m[1]) toks.push({ t: 'term', v: m[1].slice(1, -1).replace(/""/g, '"'), quoted: true });
    else if (m[2]) toks.push({ t: '(' });
    else if (m[3]) toks.push({ t: ')' });
    else if (m[4]) toks.push({ t: m[4] === '&' ? 'AND' : m[4] === '|' ? 'OR' : m[4] === '&!' ? 'ANDNOT' : 'NOT' });
    else {
      const u = m[5].toUpperCase();
      toks.push(u === 'AND' || u === 'OR' || u === 'NOT' ? { t: u } : { t: 'term', v: m[5], quoted: false });
    }
    if (/^\s*$/.test(cond.slice(re.lastIndex))) break;
  }
  if (re.lastIndex < cond.length && !/^\s*$/.test(cond.slice(re.lastIndex))) throw ftErr(cond.slice(re.lastIndex).trim(), cond);
  let p = 0;
  const peek = () => toks[p];
  const nearText = () => (toks[p] ? (toks[p].v ?? toks[p].t) : cond.trim().split(/\s+/).pop());
  const term = () => {
    const tk = toks[p];
    if (!tk) throw ftErr(nearText(), cond);
    if (tk.t === '(') {
      p++;
      const e = orExpr();
      if (!toks[p] || toks[p].t !== ')') throw ftErr(nearText(), cond);
      p++;
      return e;
    }
    if (tk.t !== 'term') throw ftErr(nearText(), cond);
    p++;
    let text = tk.v;
    let prefix = false;
    if (tk.quoted && text.endsWith('*')) { prefix = true; text = text.slice(0, -1); }
    const words = ftWords(text);
    if (!words.length) return () => false;
    return ws => {
      for (let i = 0; i + words.length <= ws.length; i++) {
        let ok = true;
        for (let j = 0; j < words.length && ok; j++) {
          const last = j === words.length - 1;
          ok = prefix && last ? ws[i + j].startsWith(words[j]) : ws[i + j] === words[j];
        }
        if (ok) return true;
      }
      return false;
    };
  };
  const andExpr = () => {
    let l = term();
    for (;;) {
      const tk = peek();
      if (!tk) break;
      if (tk.t === 'AND' || tk.t === 'ANDNOT') {
        p++;
        let neg = tk.t === 'ANDNOT';
        if (!neg && peek() && peek().t === 'NOT') { p++; neg = true; }
        const r = term(), a = l;
        l = neg ? ws => a(ws) && !r(ws) : ws => a(ws) && r(ws);
      } else break;
    }
    return l;
  };
  const orExpr = () => {
    let l = andExpr();
    while (peek() && peek().t === 'OR') {
      p++;
      const r = andExpr(), a = l;
      l = ws => a(ws) || r(ws);
    }
    return l;
  };
  const e = orExpr();
  if (p < toks.length) throw ftErr(nearText(), cond);
  return e;
}

// ------------------------------------------------------------------------------------------- system / errors

const errField = (name, key, dt) => fnDef(name, 0, 0, {
  nulls: 'handled',
  dt: () => ({ ...dt }),
  eval: (a, env) => (env && env.error && env.error[key] != null ? env.error[key] : null),
});

const NVS = Object.freeze({ dt: 'string', len: 128, unicode: true });

// logicalName -> EntityInfo of one meta.entities() list (the first entry wins), built once per list: meta.js returns
// the same array until the metadata is reloaded, so each metadata generation is indexed once (00 §4 Performance).
const ENTITY_INDEX = new WeakMap();

function entityIndex(list) {
  let ix = ENTITY_INDEX.get(list);
  if (!ix) {
    ix = new Map();
    for (const e of list) if (e && typeof e.logicalName === 'string' && !ix.has(e.logicalName)) ix.set(e.logicalName, e);
    ENTITY_INDEX.set(list, ix);
  }
  return ix;
}

// The index of the app's metadata entities (meta.entities(), synchronous; 02 §2), or null without metadata.
function metaIndex(meta) {
  if (!meta || typeof meta.entities !== 'function') return null;
  const list = meta.entities();
  return Array.isArray(list) ? entityIndex(list) : null;
}

// CREATELOOKUP needs a table that is not elastic and CREATEELASTICLOOKUP an elastic one (01 §8), when the
// metadata knows the table (by logical name; an unknown one is not checked, DML then raises its own 208).
function lookupKind(ix, table, elastic) {
  const e = ix && ix.get(String(table).toLowerCase());
  if (!e) return;
  if (elastic && e.kind !== 'elastic') throw plainErr(`'${table}' is not an elastic table; use CREATELOOKUP.`);
  if (!elastic && e.kind === 'elastic') throw plainErr(`'${table}' is an elastic table; use CREATEELASTICLOOKUP.`);
}

// The per-row table check of a lookup function whose table argument is not a constant: the metadata index is taken
// on the first row and kept for the statement, so every row costs one Map lookup, however many names it meets.
function lookupChecker(meta, elastic) {
  let ix;
  return table => {
    if (ix === undefined) ix = metaIndex(meta);
    lookupKind(ix, table, elastic);
  };
}

// The organization's LCID: env.org.lcid or env.org.localeid when the env carries one, else the LCID of the org
// collation that setCollation(organization.localeid) set (types.js orgCollation(); 1033 before any call), which is
// what the app's env gives, since 01 §7's env.org lists no LCID.
function orgLcid(env) {
  const org = (env && env.org) || {};
  const n = Number(org.lcid ?? org.localeid);
  return Number.isInteger(n) && n > 0 ? n : typesOrgCollation().lcid;
}

let lcidBases = null;

// LCIDs whose SQL Server Windows collation is the base of another LCID: Swedish (Sweden, Finland) uses
// Finnish_Swedish (1035) and Bulgarian Cyrillic_General (1049).
const LCID_ALIAS = new Map([[1053, 1035], [2077, 1035], [1026, 1049]]);

// The Windows collation base of an LCID in SQL_COLLATIONS (the unversioned one first), e.g. 1033 -> Latin1_General;
// Latin1_General for an LCID without a base of its own (German, Italian, Dutch, Portuguese, …), as SQL Server.
function collationBase(lcid) {
  if (!lcidBases) {
    lcidBases = new Map();
    for (const r of sqlCollations()) {
      if (r.name.startsWith('SQL_') || !r.name.endsWith('_BIN')) continue;
      const prev = lcidBases.get(r.lcid);
      if (!prev || r.version < prev.version) lcidBases.set(r.lcid, { base: r.name.slice(0, -4), version: r.version });
    }
  }
  const b = lcidBases.get(LCID_ALIAS.get(lcid) ?? lcid);
  return b ? b.base : 'Latin1_General';
}

// The org collation name (SERVERPROPERTY('Collation'), SQL_VARIANT_PROPERTY(…, 'Collation')): the base of the org
// LCID, always case-insensitive, accent-insensitive when the org collation in effect is (01 §5.2).
function orgCollation(env) {
  const ai = collKey('é') === collKey('e');
  return `${collationBase(orgLcid(env))}_CI_${ai ? 'AI' : 'AS'}`;
}

// SERVERPROPERTY(name) (01 §8): [value, base Type], [null, null] for an unknown name (case-insensitive).
function serverProperty(name, env) {
  const org = (env && env.org) || {};
  switch (name.toLowerCase()) {
    case 'collation': return [orgCollation(env), NVS];
    case 'collationid': case 'lcid': return [orgLcid(env), INT];
    case 'comparisonstyle': {
      const info = collationInfo(orgCollation(env));
      return [info ? info.comparisonStyle : null, INT];
    }
    case 'edition': return ['Enterprise Edition', NVS];
    case 'editionid': return [1804890536, BIGINT];
    case 'engineedition': return [3, INT];
    case 'issingleuser': return [0, INT];
    case 'machinename': case 'servername': return [org.host ?? null, NVS];
    case 'pathseparator': return ['\\', NVS];
    case 'processid': return [0, INT];
    case 'productversion': return [org.version ?? null, NVS];
    default: return [null, null];
  }
}

// The base type name of a static type, as SQL_VARIANT_PROPERTY(v, 'BaseType') gives it (01 §8; 04 §2.1: numeric
// for a type with types.js's numeric marker, such as the literal 20.0).
function baseTypeName(t) {
  switch (t.dt) {
    case 'decimal': return t.numeric ? 'numeric' : 'decimal';
    case 'money': return t.prec === 10 ? 'smallmoney' : 'money';
    case 'string': return (t.unicode ? 'n' : '') + (t.fixed ? 'char' : 'varchar');
    case 'binary': return t.fixed ? 'binary' : 'varbinary';
    case 'guid': return 'uniqueidentifier';
    case 'datetime': return t.small ? 'smalldatetime' : t.dto ? 'datetimeoffset' : t.prec != null ? 'datetime2' : 'datetime';
    default: return t.dt;
  }
}

// Fractional-second digits of a date/time type (datetime 3, smalldatetime 0, datetime2/datetimeoffset/time n).
const fracDigits = t => (t.dt === 'time' ? (t.prec ?? 7) : t.small ? 0 : t.prec == null && !t.dto ? 3 : (t.prec ?? 7));

// SQL_VARIANT_PROPERTY Precision: the digits of a numeric type, the characters of a date/time type, else 0.
function precisionOf(t) {
  const n = fracDigits(t);
  switch (t.dt) {
    case 'int': return 10;
    case 'bigint': return 19;
    case 'bit': return 1;
    case 'float': return 53;
    case 'decimal': return t.prec ?? 18;
    case 'money': return t.prec === 10 ? 10 : 19;
    case 'date': return 10;
    case 'time': return n ? 9 + n : 8;
    case 'datetime':
      if (t.small) return 16;
      if (t.prec == null && !t.dto) return 23;
      return (t.dto ? 26 : 19) + (n ? n + 1 : 0);
    default: return 0;
  }
}

// SQL_VARIANT_PROPERTY Scale: decimal scale, money 4, the fractional-second digits of date/time types, else 0.
function scaleOf(t) {
  switch (t.dt) {
    case 'decimal': return t.scale ?? 0;
    case 'money': return 4;
    case 'time': case 'datetime': return fracDigits(t);
    default: return 0;
  }
}

// SQL_VARIANT_PROPERTY MaxLength: the type's maximum length in bytes (the declared length of strings and binary).
function maxLengthOf(v, t) {
  if (t.dt === 'string' && t.len != null && t.len >= 0) return t.len * (t.unicode ? 2 : 1);
  if (t.dt === 'binary' && t.len != null && t.len >= 0) return t.len;
  return dataLength(v, t);
}

// SQL_VARIANT_PROPERTY TotalBytes: the value's bytes plus the sql_variant metadata (2 bytes; decimal +2 for
// precision and scale, strings +6 for collation and length, binary +2 for length, time/datetime2/datetimeoffset +1).
function totalBytesOf(v, t) {
  const extra = t.dt === 'decimal' ? 2 : t.dt === 'string' ? 6 : t.dt === 'binary' ? 2
    : t.dt === 'time' || (t.dt === 'datetime' && (t.prec != null || t.dto)) ? 1 : 0;
  return dataLength(v, t) + 2 + extra;
}

// SQL_VARIANT_PROPERTY(v, property) (01 §8): [value, Type], [null, null] for NULL v or an unknown property.
function variantProperty(x, xt, prop, env) {
  if (x == null) return [null, null];
  let [v, t] = baseOf(x, xt);
  if (t.dt === 'any' || t.dt === 'null') [v, t] = [x, variantType(x)];
  switch (prop.toLowerCase()) {
    case 'basetype': return [baseTypeName(t), NVS];
    case 'precision': return [precisionOf(t), INT];
    case 'scale': return [scaleOf(t), INT];
    case 'totalbytes': {
      const n = totalBytesOf(v, t);
      return [n > 8000 ? null : n, INT];
    }
    case 'collation': return [t.dt === 'string' ? orgCollation(env) : null, NVS];
    case 'maxlength': return [maxLengthOf(v, t), INT];
    default: return [null, null];
  }
}

// COLLATIONPROPERTY(name, property) (01 §8): the SQL_COLLATIONS value, NULL for an unknown name or property.
function collationProperty(name, prop) {
  const info = collationInfo(name);
  if (!info) return null;
  switch (prop.toLowerCase()) {
    case 'codepage': return info.codePage;
    case 'lcid': return info.lcid;
    case 'comparisonstyle': return info.comparisonStyle;
    case 'version': return info.version;
    default: return null;
  }
}

// 206 for a type a sql_variant cannot hold (01 §5: xml and the max string and binary types).
function variantArg(t) {
  const x = ty(t);
  if (x.dt === 'xml' || ((x.dt === 'string' || x.dt === 'binary') && x.len === -1)) {
    throw E(206, x.dt === 'xml' ? 'xml' : msgTypeName(x) + '(max)', 'sql_variant');
  }
}

const FORMATMESSAGE_NUMBER = 'FORMATMESSAGE with a message number is not supported. Pass the message text.';
const isNumberType = t => NUMS.has(t.dt) || t.dt === 'bit';

// [value, Type] of an argument read through a sql_variant: a sql_variant's base value and type, else as given.
const baseOf = (v, t) => (variantValue(v) !== v ? [variantValue(v), variantType(v)] : [v, ty(t)]);

const SYSTEM = [
  fnDef('APP_NAME', 0, 0, { dt: () => ({ dt: 'string', len: 128, unicode: true }), eval: () => 'SQL Studio' }),
  fnDef('COLLATIONPROPERTY', 2, 2, {
    dt(ts) {
      for (let i = 0; i < 2; i++) if (!strLike(ts[i])) throw badArg(ty(ts[i]), i + 1, 'collationproperty');
      return { dt: 'any' };
    },
    eval: (a, env, ts) => (anyNull(a) ? null : variant(collationProperty(sv(a[0], ts[0], env), sv(a[1], ts[1], env)), INT)),
  }),
  fnDef('CONTAINS', 2, 2, {
    predicate: true,
    consts: [1],
    dt(ts, cs = []) {
      if (typeof cs[1] === 'string' || cs[1] === null) compileContains(cs[1]);
      return { dt: 'bit' };
    },
    bind(ts, cs = []) {
      const fixed = typeof cs[1] === 'string' ? compileContains(cs[1]) : null;
      const cache = new Map();
      return (a, env) => {
        let m = fixed;
        if (!m) {
          const c = a[1] == null ? null : sv(a[1], ts[1], env);
          m = cache.get(c);
          if (!m) {
            m = compileContains(c);
            if (cache.size > 64) cache.clear();
            cache.set(c, m);
          }
        }
        if (a[0] == null) return null;
        return m(ftWords(sv(a[0], ts[0], env)));
      };
    },
  }),
  fnDef('CREATEELASTICLOOKUP', 3, 3, {
    dt(ts) {
      if (!strLike(ts[0])) throw badArg(ty(ts[0]), 1, 'createelasticlookup');
      const t = ty(ts[1]);
      if (!(t.dt === 'guid' || strLike(t))) throw badArg(t, 2, 'createelasticlookup');
      if (!strLike(ts[2])) throw badArg(ty(ts[2]), 3, 'createelasticlookup');
      return { dt: 'guid' };
    },
    // {entity, pid}: the table (entityFn for a non-constant one) and the partition id (pidFn for a non-constant one).
    ref(refs, cs = [], fns) {
      const r = {};
      if (typeof cs[0] === 'string') r.entity = cs[0].toLowerCase();
      else if (cs[0] === null || !fns || !fns[0]) return undefined;
      else {
        const f0 = fns[0];
        r.entityFn = (row, env) => { const v = f0(row, env); return v == null ? null : String(v).toLowerCase(); };
      }
      if (cs[2] !== undefined) r.pid = cs[2] == null ? null : String(cs[2]);
      else if (fns && fns[2]) {
        const f2 = fns[2];
        r.pidFn = (row, env) => { const v = f2(row, env); return v == null ? null : String(v); };
      }
      return r;
    },
    bind(ts, cs = [], cx) {
      const meta = cx && cx.meta;
      if (typeof cs[0] === 'string') lookupKind(metaIndex(meta), cs[0], true);
      const check = typeof cs[0] === 'string' ? null : lookupChecker(meta, true);
      return (a, env) => {
        if (anyNull(a)) return null;
        if (check) check(sv(a[0], ts[0], env));
        return coerce(a[1], ty(ts[1]), GUID, env);
      };
    },
  }),
  fnDef('CREATELOOKUP', 2, 2, {
    dt(ts) {
      if (!strLike(ts[0])) throw badArg(ty(ts[0]), 1, 'createlookup');
      const t = ty(ts[1]);
      if (!(t.dt === 'guid' || strLike(t))) throw badArg(t, 2, 'createlookup');
      return { dt: 'guid' };
    },
    ref(refs, cs = [], fns) {
      if (typeof cs[0] === 'string') return { entity: cs[0].toLowerCase() };
      if (cs[0] === null || !fns || !fns[0]) return undefined;
      const f = fns[0];
      return { entityFn: (row, env) => { const v = f(row, env); return v == null ? null : String(v).toLowerCase(); } };
    },
    bind(ts, cs = [], cx) {
      const meta = cx && cx.meta;
      if (typeof cs[0] === 'string') lookupKind(metaIndex(meta), cs[0], false);
      const check = typeof cs[0] === 'string' ? null : lookupChecker(meta, false);
      return (a, env) => {
        if (anyNull(a)) return null;
        if (check) check(sv(a[0], ts[0], env));
        return coerce(a[1], ty(ts[1]), GUID, env);
      };
    },
  }),
  fnDef('CURRENT_USER', 0, 0, {
    dt: () => ({ dt: 'guid' }),
    ref: () => ({ entity: 'systemuser' }),
    eval: (a, env) => (env && env.user && env.user.id ? String(env.user.id).toLowerCase() : null),
  }),
  fnDef('DB_NAME', 0, 0, { dt: () => ({ dt: 'string', len: 128, unicode: true }), eval: (a, env) => (env && env.org && env.org.uniqueName) || null }),
  errField('ERROR_LINE', 'line', { dt: 'int' }),
  errField('ERROR_MESSAGE', 'message', { dt: 'string', len: 4000, unicode: true }),
  errField('ERROR_NUMBER', 'number', { dt: 'int' }),
  errField('ERROR_PROCEDURE', 'procedure', { dt: 'string', len: 128, unicode: true }),
  errField('ERROR_SEVERITY', 'severity', { dt: 'int' }),
  errField('ERROR_STATE', 'state', { dt: 'int' }),
  fnDef('FORMATMESSAGE', 1, 21, {
    nulls: 'handled',
    // nvarchar(max) (01 §5); a message number as the first argument is not supported (pass the message text).
    dt(ts) {
      if (isNumberType(ty(ts[0]))) throw plainErr(FORMATMESSAGE_NUMBER);
      return { dt: 'string', len: -1, unicode: true };
    },
    eval: (a, env, ts) => {
      if (a[0] == null) return null;
      const [m, mt] = baseOf(a[0], ts[0]);
      if (isNumberType(mt)) throw plainErr(FORMATMESSAGE_NUMBER);
      return formatMessage(sv(m, mt, env), a.slice(1), ts.slice(1));
    },
  }),
  fnDef('HOST_NAME', 0, 0, { dt: () => ({ dt: 'string', len: 128, unicode: true }), eval: (a, env) => (env && env.org && env.org.host) || null }),
  fnDef('ISNUMERIC', 1, 1, {
    nulls: 'handled',
    dt: () => ({ dt: 'int' }),
    eval: ([x], env, [xt]) => {
      if (x == null) return 0;
      const [v, t] = baseOf(x, xt);
      const d = t.dt;
      if (NUMS.has(d) || d === 'bit') return 1;
      if (d === 'string' || (d === 'any' && typeof v === 'string')) return isNumericText(String(v));
      if (d === 'any' && typeof v === 'number') return 1;
      return 0;
    },
  }),
  fnDef('NEWID', 0, 0, { nondet: true, dt: () => ({ dt: 'guid' }), eval: () => globalThis.crypto.randomUUID() }),
  fnDef('SERVERPROPERTY', 1, 1, {
    dt(ts) {
      if (!strLike(ts[0])) throw badArg(ty(ts[0]), 1, 'serverproperty');
      return { dt: 'any' };
    },
    eval: ([v], env, [t]) => {
      if (v == null) return null;
      const [value, type] = serverProperty(sv(v, t, env), env);
      return variant(value, type);
    },
  }),
  fnDef('SQL_VARIANT_PROPERTY', 2, 2, {
    dt(ts) {
      variantArg(ts[0]);
      if (!strLike(ts[1])) throw badArg(ty(ts[1]), 2, 'sql_variant_property');
      return { dt: 'any' };
    },
    eval: (a, env, ts) => {
      if (anyNull(a)) return null;
      const [value, type] = variantProperty(a[0], ts[0], sv(a[1], ts[1], env), env);
      return variant(value, type);
    },
  }),
  fnDef('SUSER_NAME', 0, 0, {
    dt: () => ({ dt: 'string', len: 128, unicode: true }),
    eval: (a, env) => (env && env.user && env.user.name) || null,
  }),
  fnDef('USER_NAME', 0, 0, {
    // The effective user's systemuserid as a lookup to systemuser, as SQL 4 CDS returns it (01 §8).
    dt: () => ({ dt: 'guid' }),
    ref: () => ({ entity: 'systemuser' }),
    eval: (a, env) => (env && env.user && env.user.id ? String(env.user.id).toLowerCase() : null),
  }),
];

// ------------------------------------------------------------------------------------------- FORMAT (§8.1)
//
// FORMAT reproduces the .NET Framework formatting that SQL Server runs: Number.NumberToString / NumberToStringFormat
// for numbers, DateTimeFormat.FormatCustomized for date and time values and TimeSpanFormat for time. A program is
// compiled once per (value kind, format, culture) and is a function (value, staticType, env) -> string | null.

// Pattern placeholders of currency and percent patterns: the number, the symbol and the negative sign.
const NUM_T = '\u0001', SYM_T = '\u0002', NEG_T = '\u0003';
const NULL_PROG = () => null;
const MONEY4 = Object.freeze({ dt: 'decimal', prec: 19, scale: 4 });

// en-US names (.NET Framework values): days | abbreviated days | months | abbreviated months, split on first use.
const EN_US_NAMES = 'Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday|Sun,Mon,Tue,Wed,Thu,Fri,Sat|' +
  'January,February,March,April,May,June,July,August,September,October,November,December|' +
  'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec';

// en-US standard date and time patterns (.NET Framework) and the culture-invariant ones (o, r, s, u).
const EN_US_DATE = 'd=M/d/yyyy;D=dddd, MMMM d, yyyy;f=dddd, MMMM d, yyyy h:mm tt;F=dddd, MMMM d, yyyy h:mm:ss tt;' +
  'g=M/d/yyyy h:mm tt;G=M/d/yyyy h:mm:ss tt;m=MMMM d;M=MMMM d;t=h:mm tt;T=h:mm:ss tt;y=MMMM yyyy;Y=MMMM yyyy;' +
  'U=dddd, MMMM d, yyyy h:mm:ss tt';
const INVARIANT_DATE = "o=yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fffffffK;O=yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fffffffK;" +
  "r=ddd, dd MMM yyyy HH':'mm':'ss 'GMT';R=ddd, dd MMM yyyy HH':'mm':'ss 'GMT';s=yyyy'-'MM'-'dd'T'HH':'mm':'ss;" +
  "u=yyyy'-'MM'-'dd HH':'mm':'ss'Z'";

// ISO 4217 currency of each ISO 3166 region (CLDR current tender), grouped by currency; parsed on first use.
const REGION_CURRENCY = 'EUR:AD AT AX BE BG BL CY DE EA EE ES FI FR GF GP GR HR IC IE IT LT LU LV MC ME MF MQ MT NL PM ' +
  'PT RE SI SK SM TF VA XK YT;USD:AS BQ DG EC FM GU IO MH MP PR PW SV TC TL UM US VG VI;XOF:BF BJ CI GW ML NE SN TG;' +
  'XAF:CF CG CM GA GQ TD;XPF:NC PF WF;XCD:AG AI DM GD KN LC MS VC;AUD:AU CC CX HM KI NF NR TV;NZD:CK NU NZ PN TK;' +
  'GBP:GB GG GS IM JE TA;NOK:BV NO SJ;DKK:DK FO GL;CHF:CH LI;ILS:IL PS;SHP:AC SH;MAD:EH MA;XCG:CW SX;' +
  'AED:AE;AFN:AF;ALL:AL;AMD:AM;AOA:AO;ARS:AR;AWG:AW;AZN:AZ;BAM:BA;BBD:BB;BDT:BD;BHD:BH;BIF:BI;BMD:BM;BND:BN;BOB:BO;' +
  'BRL:BR;BSD:BS;BTN:BT;BWP:BW;BYN:BY;BZD:BZ;CAD:CA;CDF:CD;CLP:CL;CNY:CN;COP:CO;CRC:CR;CUP:CU;CVE:CV;CZK:CZ;DJF:DJ;' +
  'DOP:DO;DZD:DZ;EGP:EG;ERN:ER;ETB:ET;FJD:FJ;FKP:FK;GEL:GE;GHS:GH;GIP:GI;GMD:GM;GNF:GN;GTQ:GT;GYD:GY;HKD:HK;HNL:HN;' +
  'HTG:HT;HUF:HU;IDR:ID;INR:IN;IQD:IQ;IRR:IR;ISK:IS;JMD:JM;JOD:JO;JPY:JP;KES:KE;KGS:KG;KHR:KH;KMF:KM;KPW:KP;KRW:KR;' +
  'KWD:KW;KYD:KY;KZT:KZ;LAK:LA;LBP:LB;LKR:LK;LRD:LR;LSL:LS;LYD:LY;MDL:MD;MGA:MG;MKD:MK;MMK:MM;MNT:MN;MOP:MO;MRU:MR;' +
  'MUR:MU;MVR:MV;MWK:MW;MXN:MX;MYR:MY;MZN:MZ;NAD:NA;NGN:NG;NIO:NI;NPR:NP;OMR:OM;PAB:PA;PEN:PE;PGK:PG;PHP:PH;PKR:PK;' +
  'PLN:PL;PYG:PY;QAR:QA;RON:RO;RSD:RS;RUB:RU;RWF:RW;SAR:SA;SBD:SB;SCR:SC;SDG:SD;SEK:SE;SGD:SG;SLE:SL;SOS:SO;SRD:SR;' +
  'SSP:SS;STN:ST;SYP:SY;SZL:SZ;THB:TH;TJS:TJ;TMT:TM;TND:TN;TOP:TO;TRY:TR;TTD:TT;TWD:TW;TZS:TZ;UAH:UA;UGX:UG;UYU:UY;' +
  'UZS:UZ;VES:VE;VND:VN;VUV:VU;WST:WS;YER:YE;ZAR:ZA;ZMW:ZM;ZWG:ZW';

let regionCurrencyMap = null;

// REGION_CURRENCY as a Map region -> currency code (parsed on first use).
function regionCurrency() {
  if (!regionCurrencyMap) {
    regionCurrencyMap = new Map();
    for (const group of REGION_CURRENCY.split(';')) {
      const [code, regions] = group.split(':');
      for (const r of regions.split(' ')) regionCurrencyMap.set(r, code);
    }
  }
  return regionCurrencyMap;
}

// "a=b;c=d" pattern tables as Maps (parsed on first use).
const patternMap = text => new Map(text.split(';').map(kv => [kv[0], kv.slice(2)]));
let enUsDateMap = null, invariantDateMap = null;
const enUsDate = () => enUsDateMap || (enUsDateMap = patternMap(EN_US_DATE));
const invariantDate = () => invariantDateMap || (invariantDateMap = patternMap(INVARIANT_DATE));

// ------------------------------------------------------------------------------------------ culture data

let enUsData = null;

// The bundled en-US culture (.NET Framework values).
function enUs() {
  if (enUsData) return enUsData;
  const [days, daysAbbr, months, monthsAbbr] = EN_US_NAMES.split('|').map(s => s.split(','));
  enUsData = Object.freeze({
    name: 'en-US', intl: false, dec: '.', grp: ',', sizes: [3], neg: '-',
    cur: { sym: '$', digits: 2, dec: '.', grp: ',', pos: SYM_T + NUM_T, neg: '(' + SYM_T + NUM_T + ')' },
    pct: { sym: '%', pos: NUM_T + ' ' + SYM_T, neg: NEG_T + NUM_T + ' ' + SYM_T },
    perMille: '‰', days, daysAbbr, months, monthsAbbr, monthsGen: months, monthsAbbrGen: monthsAbbr, am: 'AM', pm: 'PM', dateSep: '/',
    timeSep: ':', era: 'A.D.', intlDate: null,
  });
  return enUsData;
}

const intlPart = (parts, type, dflt) => {
  const p = parts.find(x => x.type === type);
  return p ? p.value : dflt;
};

// A currency/percent pattern from Intl parts: the number, the symbol and the minus sign become placeholders.
function partsPattern(parts) {
  let out = '', inNum = false;
  for (const p of parts) {
    switch (p.type) {
      case 'integer': case 'group': case 'decimal': case 'fraction':
        if (!inNum) out += NUM_T;
        inNum = true;
        continue;
      case 'currency': case 'percentSign': out += SYM_T; break;
      case 'minusSign': out += NEG_T; break;
      default: out += p.value;
    }
    inNum = false;
  }
  return out;
}

// .NET group sizes from the integer group lengths, rightmost first, without the leftmost (partial) group: a
// repeated last size is implied ([3, 3, 3] -> [3]; hi-IN [3, 2, 2, 2] -> [3, 2]).
function groupSizes(lens) {
  const s = lens.slice();
  while (s.length > 1 && s[s.length - 1] === s[s.length - 2]) s.pop();
  return s;
}

// The separator between the two parts of types a and b (adjacent, either order), else the first literal.
function literalBetween(parts, a, b, dflt) {
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i].type !== 'literal') continue;
    const l = parts[i - 1].type, r = parts[i + 1].type;
    if ((l === a && r === b) || (l === b && r === a)) return parts[i].value;
  }
  return intlPart(parts, 'literal', dflt);
}

// Culture data of a culture other than en-US, from Intl (01 §8.1 table). Every Intl call uses the Latin digits
// and the Gregorian calendar, the digits and the calendar FORMAT's own engine writes.
function intlCulture(c) {
  const N = o => new Intl.NumberFormat(c, Object.assign({ numberingSystem: 'latn' }, o));
  const D = o => new Intl.DateTimeFormat(c, Object.assign({ timeZone: 'UTC', calendar: 'gregory', numberingSystem: 'latn' }, o));
  const np = N().formatToParts(1234567890.5);
  const dec = intlPart(np, 'decimal', '.');
  const grp = intlPart(np, 'group', '');
  const lens = np.filter(p => p.type === 'integer').map(p => p.value.length).reverse();
  const sizes = grp ? groupSizes(lens.slice(0, -1)) : [];
  const neg = intlPart(N().formatToParts(-1), 'minusSign', '-');
  const region = new Intl.Locale(c).maximize().region;
  const code = region ? regionCurrency().get(region) : undefined;
  let cur;
  if (code) {
    const cf = N({ style: 'currency', currency: code });
    const pp = cf.formatToParts(1234.5), pn = cf.formatToParts(-1234.5);
    cur = { sym: intlPart(pp, 'currency', '¤'), digits: cf.resolvedOptions().maximumFractionDigits,
      dec: intlPart(pp, 'decimal', dec), grp: intlPart(pp, 'group', grp), pos: partsPattern(pp), neg: partsPattern(pn) };
  } else {
    const en = enUs().cur;
    cur = { sym: '¤', digits: 2, dec, grp, pos: en.pos, neg: en.neg };
  }
  const pf = N({ style: 'percent' });
  const qp = pf.formatToParts(0.5);
  const pct = { sym: intlPart(qp, 'percentSign', '%'), pos: partsPattern(qp), neg: partsPattern(pf.formatToParts(-0.5)) };
  const day0 = Date.UTC(2023, 0, 1);
  const names = (o, n, at) => { const f = D(o); return Array.from({ length: n }, (x, i) => f.format(at(i))); };
  const dayAt = i => day0 + i * 86400000, monthAt = i => Date.UTC(2023, i, 1);
  const genitive = o => { const f = D(o); return Array.from({ length: 12 }, (x, i) => intlPart(f.formatToParts(monthAt(i)), 'month', '')); };
  const hp = D({ hour: 'numeric', hour12: true });
  return Object.freeze({
    name: c, intl: true, dec, grp, sizes, neg, cur, pct, perMille: '‰',
    days: names({ weekday: 'long' }, 7, dayAt), daysAbbr: names({ weekday: 'short' }, 7, dayAt),
    months: names({ month: 'long' }, 12, monthAt), monthsAbbr: names({ month: 'short' }, 12, monthAt),
    monthsGen: genitive({ day: 'numeric', month: 'long' }), monthsAbbrGen: genitive({ day: 'numeric', month: 'short' }),
    am: intlPart(hp.formatToParts(Date.UTC(2023, 0, 1, 9)), 'dayPeriod', ''),
    pm: intlPart(hp.formatToParts(Date.UTC(2023, 0, 1, 21)), 'dayPeriod', ''),
    dateSep: literalBetween(D({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(day0), 'month', 'day', '/'),
    timeSep: literalBetween(D({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(day0), 'hour', 'minute', ':'),
    era: intlPart(D({ era: 'short' }).formatToParts(Date.UTC(2024, 0, 5)), 'era', ''),
    intlDate: new Map(), D,
  });
}

const CULTURES = new Map();       // canonical culture name -> culture data (page lifetime)
const CULTURE_NAMES = new Map();  // culture name as written -> canonical name, or null when unsupported

// Culture data by canonical name, computed once per culture.
function cultureData(name) {
  if (name === 'en-US') return enUs();
  let cd = CULTURES.get(name);
  if (!cd) CULTURES.set(name, (cd = intlCulture(name)));
  return cd;
}

// Whether the locale r that Intl resolved names the requested locale c: equal, or equal after likely-subtag
// expansion with c's own script and region kept (nb-NO -> nb is nb-Latn-NO; en-ZZ -> en is en-Latn-US, not ZZ).
function sameLocale(r, c) {
  if (r === c) return true;
  const a = new Intl.Locale(r).maximize(), b = new Intl.Locale(c), m = b.maximize();
  return a.language === m.language && a.script === (b.script || m.script) && a.region === (b.region || m.region);
}

// Canonical name of a supported culture, or null (01 §8.1): canonicalised with Intl.getCanonicalLocales and listed
// by both NumberFormat and DateTimeFormat without falling back to a parent locale.
function canonicalCulture(s) {
  let c;
  try {
    [c] = Intl.getCanonicalLocales(s);
  } catch {
    return null;
  }
  if (!c || c.split('-').some(p => p.length === 1)) return null;
  if (c === 'en-US') return c;
  try {
    for (const F of [Intl.NumberFormat, Intl.DateTimeFormat]) {
      const resolved = new F(c, F === Intl.DateTimeFormat ? { timeZone: 'UTC' } : undefined).resolvedOptions().locale;
      if (!F.supportedLocalesOf([c]).includes(c) || !sameLocale(resolved, c)) return null;
    }
  } catch {
    return null;
  }
  return c;
}

// Culture data for a culture name as written; 9818 when it is not supported.
function resolveCulture(written) {
  let c = CULTURE_NAMES.get(written);
  if (c === undefined) {
    c = canonicalCulture(written);
    if (CULTURE_NAMES.size >= 256) CULTURE_NAMES.clear();
    CULTURE_NAMES.set(written, c);
  }
  if (c === null) throw E(9818, written);
  return cultureData(c);
}

// The session's default culture: en-US, or en-GB after SET LANGUAGE British (§4.1).
const defaultCulture = env => cultureData(env && String(env.language).toLowerCase() === 'british' ? 'en-GB' : 'en-US');

const warnedCultures = new WeakMap();  // env -> {now, names}: one culture warning per statement and culture

function cultureWarning(env, cd) {
  if (!cd.intl || !env || typeof env.warn !== 'function') return;
  let w = warnedCultures.get(env);
  if (!w || w.now !== env.now) warnedCultures.set(env, (w = { now: env.now, names: new Set() }));
  if (w.names.has(cd.name)) return;
  w.names.add(cd.name);
  env.warn(`FORMAT culture '${cd.name}' uses this browser's locale data, which can differ from SQL Server in separators, names and patterns.`);
}

// ------------------------------------------------------------------------------------- numbers (.NET NUMBER)

// A decimal number as .NET's NUMBER: digits D (no leading or trailing zeros; '' is zero) and scale P, the number of
// digits before the decimal point: value = 0.D × 10^P.
function digitsOf(text) {
  let i = 0, neg = false;
  if (text[0] === '-') { neg = true; i = 1; } else if (text[0] === '+') i = 1;
  const e = text.search(/[eE]/);
  const m = e < 0 ? text.slice(i) : text.slice(i, e);
  const dot = m.indexOf('.');
  const ip = dot < 0 ? m : m.slice(0, dot);
  let D = dot < 0 ? ip : ip + m.slice(dot + 1);
  let P = ip.length + (e < 0 ? 0 : Number(text.slice(e + 1)));
  let z = 0;
  while (z < D.length && D.charCodeAt(z) === 48) z++;
  D = D.slice(z);
  P -= z;
  let t = D.length;
  while (t > 0 && D.charCodeAt(t - 1) === 48) t--;
  D = D.slice(0, t);
  return D ? { neg, D, P } : { neg: false, D: '', P: 0 };
}

const intText = v => (Number.isSafeInteger(v) ? String(v === 0 ? 0 : v) : BigInt(Math.trunc(v)).toString());

// The NUMBER of a value: integers and decimals exactly (decimal/money at their static scale), floats with
// `prec` significant digits (.NET DoubleToNumber).
function numberOf(v, t, kind, prec) {
  switch (kind) {
    case 'int': case 'bigint': return digitsOf(intText(v));
    case 'decimal': return digitsOf(toSqlString(v, t && t.dt === 'decimal' ? t : { dt: 'decimal' }));
    case 'money': return digitsOf(toSqlString(v, MONEY4));
    default: return digitsOf(v.toPrecision(prec));
  }
}

// .NET RoundNumber: rounds half away from zero to `pos` digits of D; a zero result has no sign.
function roundAt(n, pos) {
  const D = n.D;
  let i = pos > 0 ? Math.min(pos, D.length) : 0;
  let out;
  if (i === pos && i < D.length && D.charCodeAt(i) >= 53) {
    while (i > 0 && D.charCodeAt(i - 1) === 57) i--;
    if (i > 0) out = D.slice(0, i - 1) + String.fromCharCode(D.charCodeAt(i - 1) + 1);
    else {
      n.P++;
      out = '1';
    }
  } else {
    while (i > 0 && D.charCodeAt(i - 1) === 48) i--;
    out = D.slice(0, i);
  }
  n.D = out;
  if (!out) {
    n.P = 0;
    n.neg = false;
  }
  return n;
}

// Digits after the decimal point (exact, unpadded).
const fracOf = n => (n.P >= n.D.length ? '' : n.P < 0 ? '0'.repeat(-n.P) + n.D : n.D.slice(n.P));

// Inserts sep into the integer digits s by the group sizes (the last size repeats; 0 stops grouping).
function groupInt(s, sizes, sep) {
  if (!sizes.length || !sep) return s;
  let end = s.length, i = 0, out = '';
  for (;;) {
    const g = sizes[Math.min(i, sizes.length - 1)];
    if (g <= 0 || end <= g) return s.slice(0, end) + out;
    out = sep + s.slice(end - g, end) + out;
    end -= g;
    i++;
  }
}

// .NET FormatFixed: integer digits (grouped when sizes is given), then `digits` fraction digits.
function fixedText(n, digits, sizes, grp, dec) {
  let ip = '0';
  if (n.P > 0) {
    ip = n.D.slice(0, n.P).padEnd(n.P, '0');
    if (sizes) ip = groupInt(ip, sizes, grp);
  }
  return digits > 0 ? ip + dec + fracOf(n).slice(0, digits).padEnd(digits, '0') : ip;
}

// .NET FormatExponent: expChar, the sign (always when positive is true) and at least minDigits digits.
const expText = (e, ch, minDigits, positive, neg) =>
  ch + (e < 0 ? neg : positive ? '+' : '') + String(Math.abs(e)).padStart(minDigits, '0');

// .NET FormatGeneral (G): fixed notation, or exponent notation when the scale is above `digits` or below -3.
function generalText(n, digits, dec, ch, neg, suppressExp) {
  const D = n.D;
  let pos = n.P, sci = false, k = 0, out = '';
  if (!suppressExp && (pos > digits || pos < -3)) {
    pos = 1;
    sci = true;
  }
  if (pos > 0) {
    do out += k < D.length ? D[k++] : '0'; while (--pos > 0);
  } else out = '0';
  if (k < D.length || pos < 0) {
    out += dec;
    while (pos < 0) { out += '0'; pos++; }
    out += D.slice(k);
  }
  return sci ? out + expText(n.P - 1, ch, 2, true, neg) : out;
}

// .NET FormatScientific (E): one digit, `digits - 1` fraction digits, then a three-digit exponent.
function scientificText(n, digits, dec, ch, neg) {
  const D = n.D;
  let out = D ? D[0] : '0';
  if (digits !== 1) out += dec;
  for (let i = 1; i < digits; i++) out += i < D.length ? D[i] : '0';
  return out + expText(D ? n.P - 1 : 0, ch, 3, true, neg);
}

const applyPattern = (pat, body, sym, neg) => {
  let out = '';
  for (const ch of pat) out += ch === NUM_T ? body : ch === SYM_T ? sym : ch === NEG_T ? neg : ch;
  return out;
};

// .NET FindSection: start of section 1 (negative) or 2 (zero) of a custom format, 0 when it is missing or empty.
function findSection(f, section) {
  if (section === 0) return 0;
  let src = 0;
  while (src < f.length) {
    const ch = f[src++];
    if (ch === "'" || ch === '"') {
      while (src < f.length && f[src++] !== ch);
    } else if (ch === '\\') {
      if (src < f.length) src++;
    } else if (ch === ';' && --section === 0) {
      return src < f.length && f[src] !== ';' ? src : 0;
    }
  }
  return 0;
}

// .NET NumberToStringFormat: a custom numeric format (sections, 0 and # placeholders, grouping and scaling commas,
// % and ‰, exponents, quoted and escaped literals) applied to the NUMBER n.
function customNumber(n, f, cd) {
  let section = findSection(f, n.D === '' ? 2 : n.neg ? 1 : 0);
  let digitCount, decimalPos, firstDigit, lastDigit, scientific, thousandPos, thousandCount = 0, thousandSeps, scaleAdjust;
  let src, ch;
  for (;;) {
    digitCount = 0;
    decimalPos = -1;
    firstDigit = 0x7fffffff;
    lastDigit = 0;
    scientific = false;
    thousandPos = -1;
    thousandSeps = false;
    scaleAdjust = 0;
    src = section;
    while (src < f.length && (ch = f[src++]) !== ';') {
      switch (ch) {
        case '#': digitCount++; break;
        case '0':
          if (firstDigit === 0x7fffffff) firstDigit = digitCount;
          digitCount++;
          lastDigit = digitCount;
          break;
        case '.': if (decimalPos < 0) decimalPos = digitCount; break;
        case ',':
          if (digitCount > 0 && decimalPos < 0) {
            if (thousandPos >= 0) {
              if (thousandPos === digitCount) {
                thousandCount++;
                break;
              }
              thousandSeps = true;
            }
            thousandPos = digitCount;
            thousandCount = 1;
          }
          break;
        case '%': scaleAdjust += 2; break;
        case '‰': scaleAdjust += 3; break;
        case "'": case '"': while (src < f.length && f[src++] !== ch); break;
        case '\\': if (src < f.length) src++; break;
        case 'E': case 'e':
          if (f[src] === '0' || ((f[src] === '+' || f[src] === '-') && f[src + 1] === '0')) {
            while (++src < f.length && f[src] === '0');
            scientific = true;
          }
          break;
      }
    }
    if (decimalPos < 0) decimalPos = digitCount;
    if (thousandPos >= 0) {
      if (thousandPos === decimalPos) scaleAdjust -= thousandCount * 3;
      else thousandSeps = true;
    }
    if (n.D !== '') {
      n.P += scaleAdjust;
      roundAt(n, scientific ? digitCount : n.P + digitCount - decimalPos);
      if (n.D === '') {
        const zero = findSection(f, 2);
        if (zero !== section) {
          section = zero;
          continue;
        }
      }
    } else {
      n.neg = false;
      n.P = 0;
    }
    break;
  }
  firstDigit = firstDigit < decimalPos ? decimalPos - firstDigit : 0;
  lastDigit = lastDigit > decimalPos ? decimalPos - lastDigit : 0;
  let digPos, adjust;
  if (scientific) {
    digPos = decimalPos;
    adjust = 0;
  } else {
    digPos = n.P > decimalPos ? n.P : decimalPos;
    adjust = n.P - decimalPos;
  }
  const sepPos = [];
  if (thousandSeps && cd.grp.length > 0 && cd.sizes.length > 0) {
    const g = cd.sizes;
    let gi = 0, total = g[0], size = total;
    const totalDigits = digPos + (adjust < 0 ? adjust : 0);
    const numDigits = firstDigit > totalDigits ? firstDigit : totalDigits;
    while (numDigits > total && size !== 0) {
      sepPos.push(total);
      if (gi < g.length - 1) size = g[++gi];
      total += size;
    }
  }
  let ctr = sepPos.length - 1;
  const D = n.D;
  let cur = 0, out = '', decimalWritten = false;
  const sepAfter = () => {
    if (thousandSeps && digPos > 1 && ctr >= 0 && digPos === sepPos[ctr] + 1) {
      out += cd.grp;
      ctr--;
    }
  };
  if (n.neg && section === 0 && n.P !== 0) out += cd.neg;
  src = section;
  while (src < f.length && (ch = f[src++]) !== ';') {
    if (adjust > 0 && (ch === '#' || ch === '0' || ch === '.')) {
      while (adjust > 0) {
        out += cur < D.length ? D[cur++] : '0';
        sepAfter();
        digPos--;
        adjust--;
      }
    }
    switch (ch) {
      case '#': case '0': {
        let c;
        if (adjust < 0) {
          adjust++;
          c = digPos <= firstDigit ? '0' : '';
        } else c = cur < D.length ? D[cur++] : digPos > lastDigit ? '0' : '';
        if (c) {
          out += c;
          sepAfter();
        }
        digPos--;
        break;
      }
      case '.':
        if (digPos !== 0 || decimalWritten) break;
        if (lastDigit < 0 || (decimalPos < digitCount && cur < D.length)) {
          out += cd.dec;
          decimalWritten = true;
        }
        break;
      case '‰': out += cd.perMille; break;
      case '%': out += cd.pct.sym; break;
      case ',': break;
      case "'": case '"':
        while (src < f.length && f[src] !== ch) out += f[src++];
        if (src < f.length) src++;
        break;
      case '\\': if (src < f.length) out += f[src++]; break;
      case 'E': case 'e': {
        if (!scientific) {
          out += ch;
          if (src < f.length) {
            if (f[src] === '+' || f[src] === '-') out += f[src++];
            while (src < f.length && f[src] === '0') out += f[src++];
          }
          break;
        }
        let positive = false, digits = 0;
        if (f[src] === '0') digits++;
        else if (f[src] === '+' && f[src + 1] === '0') positive = true;
        else if (!(f[src] === '-' && f[src + 1] === '0')) {
          out += ch;
          break;
        }
        while (++src < f.length && f[src] === '0') digits++;
        out += expText(D === '' ? 0 : n.P - decimalPos, ch, Math.min(digits, 10), positive, cd.neg);
        scientific = false;
        break;
      }
      default: out += ch;
    }
  }
  if (n.neg && section === 0 && n.P === 0 && out.length > 0) out = cd.neg + out;
  return out;
}

const STANDARD_NUM = /^([A-Za-z])(\d{0,2})$/;

// A numeric FORMAT program (.NET NumberToString for standard formats, NumberToStringFormat for custom ones).
function numberProgram(kind, format, cd) {
  const nul = format.indexOf('\0');
  const f = nul < 0 ? format : format.slice(0, nul);
  const m = f === '' ? ['', 'G', ''] : STANDARD_NUM.exec(f);
  const isInt = kind === 'int' || kind === 'bigint', isFloat = kind === 'float', isDec = kind === 'decimal' || kind === 'money';
  if (!m) return (v, t) => customNumber(numberOf(v, t, kind, 15), f, cd);
  const L = m[1], up = L.toUpperCase();
  const p = m[2] === '' ? -1 : Number(m[2]);
  const sign = n => (n.neg ? cd.neg : '');
  switch (up) {
    case 'C': {
      const digits = p < 0 ? cd.cur.digits : p;
      return (v, t) => {
        const n = numberOf(v, t, kind, 15);
        roundAt(n, n.P + digits);
        return applyPattern(n.neg ? cd.cur.neg : cd.cur.pos, fixedText(n, digits, cd.sizes, cd.cur.grp, cd.cur.dec), cd.cur.sym, cd.neg);
      };
    }
    case 'D':
      if (!isInt) return NULL_PROG;
      return v => (v < 0 ? cd.neg : '') + intText(Math.abs(v)).padStart(p, '0');
    case 'E': {
      const digits = (p < 0 ? 6 : p) + 1;
      const prec = isFloat && p > 14 ? 17 : 15;
      const ch = L === 'E' ? 'E' : 'e';
      return (v, t) => {
        const n = roundAt(numberOf(v, t, kind, prec), digits);
        return sign(n) + scientificText(n, digits, cd.dec, ch, cd.neg);
      };
    }
    case 'F': case 'N': {
      const digits = p < 0 ? 2 : p;
      const sizes = up === 'N' ? cd.sizes : null;
      return (v, t) => {
        const n = numberOf(v, t, kind, 15);
        roundAt(n, n.P + digits);
        return sign(n) + fixedText(n, digits, sizes, cd.grp, cd.dec);
      };
    }
    case 'G': case 'R': {
      const ch = L === 'G' || L === 'R' ? 'E' : 'e';
      if (up === 'R') {
        if (!isFloat) return NULL_PROG;
        // The shortest round-trip digits (String(x)), fixed or exponent form by the G rule with limit 15 (01 §8.1).
        return v => {
          const n = digitsOf(String(v));
          return sign(n) + generalText(n, 15, cd.dec, ch, cd.neg, false);
        };
      }
      // G and G0 on decimal and money: every digit at the static scale, never exponent form (01 §8.1).
      if (isDec && p <= 0) {
        return (v, t) => {
          const s = toSqlString(v, kind === 'money' ? MONEY4 : t && t.dt === 'decimal' ? t : { dt: 'decimal' });
          return (s[0] === '-' ? cd.neg + s.slice(1) : s).replace('.', cd.dec);
        };
      }
      const digits = p >= 1 ? p : isDec ? 29 : isFloat ? 15 : kind === 'int' ? 10 : 19;
      const prec = isFloat && p > 15 ? 17 : 15;
      return (v, t) => {
        const n = roundAt(numberOf(v, t, kind, prec), digits);
        return sign(n) + generalText(n, digits, cd.dec, ch, cd.neg, false);
      };
    }
    case 'P': {
      const digits = p < 0 ? 2 : p;
      return (v, t) => {
        const n = numberOf(v, t, kind, 15);
        if (n.D) n.P += 2;
        roundAt(n, n.P + digits);
        return applyPattern(n.neg ? cd.pct.neg : cd.pct.pos, fixedText(n, digits, cd.sizes, cd.grp, cd.dec), cd.pct.sym, cd.neg);
      };
    }
    case 'X': {
      if (!isInt) return NULL_PROG;
      return v => {
        let s = kind === 'int' ? (v >>> 0).toString(16) : BigInt.asUintN(64, BigInt(Math.trunc(v))).toString(16);
        if (L === 'X') s = s.toUpperCase();
        return s.padStart(p, '0');
      };
    }
    default: return NULL_PROG;
  }
}

// ---------------------------------------------------------------------------------------- date and time

const pad2 = n => (n < 10 ? '0' : '') + n;
const twoDigits = (v, n) => (n >= 2 ? pad2(v) : String(v));
const offsetText = off => (off < 0 ? '-' : '+') + pad2(Math.floor(Math.abs(off) / 60)) + ':' + pad2(Math.abs(off) % 60);
const tzOffset = (tz, ms) => (!tz || tz.utc ? 0 : tz.offset(ms));

// .NET ParseRepeatPattern: the length of the run of ch at i.
function runLength(f, i, ch) {
  let j = i + 1;
  while (j < f.length && f[j] === ch) j++;
  return j - i;
}

// .NET ParseQuoteString: {text, len} of the quoted literal at i (backslash escapes inside), or null when unclosed.
function quotedText(f, i) {
  const q = f[i];
  let j = i + 1, text = '';
  while (j < f.length) {
    const c = f[j++];
    if (c === q) return { text, len: j - i };
    if (c === '\\') {
      if (j >= f.length) return null;
      text += f[j++];
    } else text += c;
  }
  return null;
}

// Whether date ops contain a day-number token (d or dd, also as '%d'), which selects genitive month names.
const hasDayNumber = ops => ops.some(op => (op.k === 'd' && op.n <= 2) || (op.k === 'sub' && hasDayNumber(op.ops)));

// Tokenises a custom date/time format (.NET DateTimeFormat.FormatCustomized) into ops; null for a format .NET
// rejects (an f/F run over 7, an unclosed quote, a trailing backslash, '%' at the end or '%%'). MMM and MMMM (or
// longer) use the genitive month names when the format also contains a d or dd token (01 §8.1).
function dateOps(f) {
  const ops = dateTokens(f);
  if (ops && hasDayNumber(ops)) for (const op of ops) if (op.k === 'M' && op.n >= 3) op.gen = true;
  return ops;
}

function dateTokens(f) {
  const ops = [];
  const lit = s => {
    const last = ops[ops.length - 1];
    if (last && last.k === 'lit') last.s += s;
    else ops.push({ k: 'lit', s });
  };
  for (let i = 0; i < f.length;) {
    const ch = f[i];
    let len = 1;
    switch (ch) {
      case 'g': case 'h': case 'H': case 'm': case 's': case 't': case 'd': case 'y': case 'z':
        len = runLength(f, i, ch);
        ops.push({ k: ch, n: len });
        break;
      case 'f': case 'F':
        len = runLength(f, i, ch);
        if (len > 7) return null;
        ops.push({ k: ch, n: len });
        break;
      case 'M':
        len = runLength(f, i, ch);
        ops.push({ k: 'M', n: len, gen: false });
        break;
      case 'K': case ':': case '/': ops.push({ k: ch }); break;
      case "'": case '"': {
        const q = quotedText(f, i);
        if (!q) return null;
        lit(q.text);
        len = q.len;
        break;
      }
      case '%': {
        const next = f[i + 1];
        if (next === undefined || next === '%') return null;
        const sub = dateTokens(next);
        if (!sub) return null;
        ops.push({ k: 'sub', ops: sub });
        len = 2;
        break;
      }
      case '\\':
        if (i + 1 >= f.length) return null;
        lit(f[i + 1]);
        len = 2;
        break;
      default: lit(ch);
    }
    i += len;
  }
  return ops;
}

// Fields of a date/time value (§8.1): date -> its UTC fields; datetime -> the session-tz wall-clock fields;
// datetimeoffset -> its own wall-clock fields and offset. frac is the fraction of a second in 100 ns ticks.
function dateFields(v, kind, env) {
  const tz = env && env.tz;
  const p = dateParts(v, kind === 'date' ? null : tz);
  p.frac = p.ms * 10000 + p.tk;
  p.kind = kind;
  p.v = v;
  p.tz = tz;
  return p;
}

// Wall-clock ms of the fields (the time the grid shows, read as UTC).
const wallOfFields = p => (p.kind === 'date' ? p.v.getTime() : wallMs(p.v, p.tz));

// The instant a non-datetimeoffset value denotes in the session tz (a datetime is one; date and own-offset values are
// wall-clock times read as session-local time, as .NET reads a DateTime of unspecified kind).
const instantOf = p => (p.kind === 'datetime' && p.v.tzo == null ? p.v.getTime() : fromWall(wallOfFields(p), p.tz));

// UTC fields of the value (r and u of a datetimeoffset, U of the other types).
function utcFields(p) {
  const ms = p.kind === 'dto' ? p.v.getTime() : instantOf(p);
  const u = dateParts(new Date(ms), null);
  u.frac = p.frac;
  u.kind = 'utc';
  return u;
}

// Runs date ops (§8.1 custom date and time tokens) on fields p with culture data cd.
function runDate(ops, p, cd) {
  let out = '';
  for (const op of ops) {
    switch (op.k) {
      case 'lit': out += op.s; break;
      case 'g': out += cd.era; break;
      case 'h': out += twoDigits(p.h % 12 || 12, op.n); break;
      case 'H': out += twoDigits(p.h, op.n); break;
      case 'm': out += twoDigits(p.mi, op.n); break;
      case 's': out += twoDigits(p.s, op.n); break;
      case 'f': out += String(Math.floor(p.frac / 10 ** (7 - op.n))).padStart(op.n, '0'); break;
      case 'F': {
        let x = Math.floor(p.frac / 10 ** (7 - op.n)), n = op.n;
        while (n > 0 && x % 10 === 0) { x /= 10; n--; }
        if (n > 0) out += String(x).padStart(n, '0');
        else if (out.endsWith('.')) out = out.slice(0, -1);
        break;
      }
      case 't': {
        const d = p.h < 12 ? cd.am : cd.pm;
        out += op.n === 1 ? d.slice(0, 1) : d;
        break;
      }
      case 'd': out += op.n <= 2 ? twoDigits(p.d, op.n) : (op.n === 3 ? cd.daysAbbr : cd.days)[p.dow]; break;
      case 'M':
        out += op.n <= 2 ? twoDigits(p.m, op.n) : (op.n === 3 ? (op.gen ? cd.monthsAbbrGen : cd.monthsAbbr) : op.gen ? cd.monthsGen : cd.months)[p.m - 1];
        break;
      case 'y': out += op.n <= 2 ? twoDigits(p.y % 100, op.n) : String(p.y).padStart(op.n, '0'); break;
      case 'z': {
        const off = p.kind === 'dto' ? p.off : p.kind === 'utc' ? 0 : tzOffset(p.tz, instantOf(p));
        const a = Math.abs(off);
        out += (off < 0 ? '-' : '+') + twoDigits(Math.floor(a / 60), op.n) + (op.n >= 3 ? ':' + pad2(a % 60) : '');
        break;
      }
      case 'K': if (p.kind === 'dto') out += offsetText(p.off); break;
      case ':': out += cd.timeSep; break;
      case '/': out += cd.dateSep; break;
      case 'sub': out += runDate(op.ops, p, cd); break;
    }
  }
  return out;
}

// Intl options of the standard date formats in cultures other than en-US (§8.1).
const INTL_D = { year: 'numeric', month: '2-digit', day: '2-digit' };
const INTL_LONG = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
const INTL_T = { hour: 'numeric', minute: '2-digit' };
const INTL_TT = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
const INTL_DATE_OPTS = new Map([['d', INTL_D], ['D', INTL_LONG], ['f', { ...INTL_LONG, ...INTL_T }], ['F', { ...INTL_LONG, ...INTL_TT }],
  ['g', { ...INTL_D, ...INTL_T }], ['G', { ...INTL_D, ...INTL_TT }], ['m', { month: 'long', day: 'numeric' }],
  ['M', { month: 'long', day: 'numeric' }], ['t', INTL_T], ['T', INTL_TT], ['y', { year: 'numeric', month: 'long' }],
  ['Y', { year: 'numeric', month: 'long' }], ['U', { ...INTL_LONG, ...INTL_TT }]]);

// A FORMAT program for date, datetime and datetimeoffset values (kind 'date' | 'datetime' | 'dto').
function dateProgram(kind, format, cd) {
  const f = format === '' ? 'G' : format;
  if (f.length > 1) {
    const ops = dateOps(f);
    return ops ? (v, t, env) => runDate(ops, dateFields(v, kind, env), cd) : NULL_PROG;
  }
  const inv = invariantDate().get(f);
  if (inv !== undefined) {
    const ops = dateOps(inv);
    const toUtc = kind === 'dto' && (f === 'r' || f === 'R' || f === 'u');
    return (v, t, env) => {
      const p = dateFields(v, kind, env);
      return runDate(ops, toUtc ? utcFields(p) : p, enUs());
    };
  }
  if (!INTL_DATE_OPTS.has(f) || (f === 'U' && kind === 'dto')) return NULL_PROG;
  if (!cd.intl) {
    const ops = dateOps(enUsDate().get(f));
    return (v, t, env) => {
      const p = dateFields(v, kind, env);
      return runDate(ops, f === 'U' ? utcFields(p) : p, cd);
    };
  }
  let dtf = cd.intlDate.get(f);
  if (!dtf) cd.intlDate.set(f, (dtf = cd.D(INTL_DATE_OPTS.get(f))));
  return (v, t, env) => {
    const p = dateFields(v, kind, env);
    return dtf.format(new Date(f === 'U' ? instantOf(p) : wallOfFields(p)));
  };
}

const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?$/;
const TIME7 = Object.freeze({ dt: 'time', prec: 7 });

// Fields of a time value (a .NET TimeSpan below one day): {h, mi, s, frac (100 ns ticks)}.
function spanFields(v) {
  let m = TIME_RE.exec(v);
  if (!m) m = TIME_RE.exec(coerce(v, NV, TIME7));
  return { h: +m[1], mi: +m[2], s: m[3] ? +m[3] : 0, frac: m[4] ? Number(m[4].padEnd(7, '0')) : 0 };
}

const frac7 = x => String(x).padStart(7, '0');

// Tokenises a custom TimeSpan format (.NET TimeSpanFormat.FormatCustomized); null when .NET rejects it (any
// unescaped character other than d, h, m, s, f, F, quotes, '%' and '\', or a run that is too long).
function spanOps(f) {
  const ops = [];
  const MAX = { h: 2, m: 2, s: 2, f: 7, F: 7, d: 8 };
  for (let i = 0; i < f.length;) {
    const ch = f[i];
    let len = 1;
    switch (ch) {
      case 'h': case 'm': case 's': case 'f': case 'F': case 'd':
        len = runLength(f, i, ch);
        if (len > MAX[ch]) return null;
        ops.push({ k: ch, n: len });
        break;
      case "'": case '"': {
        const q = quotedText(f, i);
        if (!q) return null;
        ops.push({ k: 'lit', s: q.text });
        len = q.len;
        break;
      }
      case '%': {
        const next = f[i + 1];
        if (next === undefined || next === '%') return null;
        const sub = spanOps(next);
        if (!sub) return null;
        ops.push(...sub);
        len = 2;
        break;
      }
      case '\\':
        if (i + 1 >= f.length) return null;
        ops.push({ k: 'lit', s: f[i + 1] });
        len = 2;
        break;
      default: return null;
    }
    i += len;
  }
  return ops;
}

function runSpan(ops, p) {
  let out = '';
  for (const op of ops) {
    switch (op.k) {
      case 'lit': out += op.s; break;
      case 'h': out += twoDigits(p.h, op.n); break;
      case 'm': out += twoDigits(p.mi, op.n); break;
      case 's': out += twoDigits(p.s, op.n); break;
      case 'd': out += '0'.repeat(op.n); break;
      case 'f': out += String(Math.floor(p.frac / 10 ** (7 - op.n))).padStart(op.n, '0'); break;
      case 'F': {
        let x = Math.floor(p.frac / 10 ** (7 - op.n)), n = op.n;
        while (n > 0 && x % 10 === 0) { x /= 10; n--; }
        if (n > 0) out += String(x).padStart(n, '0');
        break;
      }
    }
  }
  return out;
}

// A FORMAT program for time values (.NET TimeSpan standard formats c, t, T, g, G and custom formats).
function timeProgram(format, cd) {
  const f = format === '' ? 'c' : format;
  if (f.length > 1) {
    const ops = spanOps(f);
    return ops ? v => runSpan(ops, spanFields(v)) : NULL_PROG;
  }
  switch (f) {
    case 'c': case 't': case 'T':
      return v => {
        const p = spanFields(v);
        return pad2(p.h) + ':' + pad2(p.mi) + ':' + pad2(p.s) + (p.frac ? '.' + frac7(p.frac) : '');
      };
    case 'g':
      return v => {
        const p = spanFields(v);
        return p.h + ':' + pad2(p.mi) + ':' + pad2(p.s) + (p.frac ? cd.dec + frac7(p.frac).replace(/0+$/, '') : '');
      };
    case 'G':
      return v => {
        const p = spanFields(v);
        return '0:' + pad2(p.h) + ':' + pad2(p.mi) + ':' + pad2(p.s) + cd.dec + frac7(p.frac);
      };
    default: return NULL_PROG;
  }
}

// --------------------------------------------------------------------------------------------- the entry

// The value kind FORMAT formats argument 1 as; 8116 for a type it does not accept (01 §8.1).
function formatKind(t) {
  const x = ty(t);
  switch (x.dt) {
    case 'int': case 'bigint': case 'decimal': case 'money': case 'float': case 'date': case 'time': case 'any': case 'null':
      return x.dt;
    case 'datetime': return x.dto ? 'dto' : 'datetime';
    default: throw badArg(x, 1, 'format');
  }
}

// [kind, value, Type] of a run-time value of static type 'any' (01 §8.1): a sql_variant formats its base value by its
// base type (8116 with the base type's name for a type FORMAT does not take); a raw number formats as float and
// a raw Date as datetime; anything else raises 8116.
function dynamicValue(v) {
  const base = variantValue(v);
  if (base !== v) {
    const bt = variantType(v);
    return [formatKind(bt), base, bt];
  }
  if (typeof v === 'number') return ['float', v, FLOAT];
  if (v instanceof Date) return ['datetime', v, DATETIME];
  throw badArg(typeof v === 'boolean' ? { dt: 'bit' } : NV, 1, 'format');
}

// Compiles a FORMAT program for a value kind, a format string and culture data.
function formatProgram(kind, format, cd) {
  switch (kind) {
    case 'date': case 'datetime': case 'dto': return dateProgram(kind, format, cd);
    case 'time': return timeProgram(format, cd);
    default: return numberProgram(kind, format, cd);
  }
}

// FORMAT's compile-time checks: 8116 for argument 1 (and for a non-string format or culture), 9818 for a constant
// culture that is not supported.
function formatType(ts, cs = []) {
  formatKind(ts[0]);
  for (let i = 1; i < ts.length; i++) if (!strLike(ts[i])) throw badArg(ty(ts[i]), i + 1, 'format');
  if (ts.length > 2 && typeof cs[2] === 'string') resolveCulture(cs[2]);
  return { dt: 'string', len: 4000, unicode: true };
}

// FORMAT's result within its nvarchar(4000) type (01 §5): a longer text (a long literal format, a long 'yyyy…' run
// or custom numeric pattern) raises instead of producing a value its column cannot hold (2628 in SELECT INTO).
function formatCap(s) {
  if (s != null && s.length > 4000) throw plainErr('The result of FORMAT would be longer than 4,000 characters.');
  return s;
}

const PROGRAM_CACHE_SIZE = 64;

// A cache of compiled FORMAT programs: up to 64 (kind, format, culture) programs, least recently used first out,
// with the last program kept at hand so a run of equal arguments skips the key.
function programCache() {
  const cache = new Map();
  let lastKind = null, lastFormat = null, lastCd = null, lastProg = null;
  return (kind, format, cd) => {
    if (kind === lastKind && format === lastFormat && cd === lastCd) return lastProg;
    const key = kind + '\u0000' + cd.name + '\u0000' + format;
    let prog = cache.get(key);
    if (prog) cache.delete(key);
    else prog = formatProgram(kind, format, cd);
    cache.set(key, prog);
    if (cache.size > PROGRAM_CACHE_SIZE) cache.delete(cache.keys().next().value);
    lastKind = kind;
    lastFormat = format;
    lastCd = cd;
    lastProg = prog;
    return prog;
  };
}

// FORMAT's bind: programs are cached per call site, so constant arguments compile once (here, at bind time) and
// per-row formats and cultures compile once per distinct (kind, format, culture).
function formatBind(ts, cs = []) {
  formatType(ts, cs);
  const kind0 = formatKind(ts[0]);
  const hasCulture = ts.length > 2;
  const constFormat = typeof cs[1] === 'string' ? cs[1] : undefined;
  const constCulture = hasCulture && typeof cs[2] === 'string' ? resolveCulture(cs[2]) : undefined;
  const program = programCache();
  if (constFormat !== undefined && constCulture && kind0 !== 'any' && kind0 !== 'null') program(kind0, constFormat, constCulture);
  return (a, env) => {
    if (a[1] == null || (hasCulture && a[2] == null) || kind0 === 'null') return null;
    const cd = hasCulture ? constCulture || resolveCulture(sv(a[2], ts[2], env)) : defaultCulture(env);
    if (a[0] == null) return null;
    const [kind, v, vt] = kind0 === 'any' ? dynamicValue(a[0]) : [kind0, a[0], ts[0]];
    const format = constFormat !== undefined ? constFormat : sv(a[1], ts[1], env);
    cultureWarning(env, cd);
    return formatCap(program(kind, format, cd)(v, vt, env));
  };
}

let valuePrograms = null;  // formatValue's program cache (created on first use)

// FORMAT(value, format[, culture]) for one value of static type `type` (01 §8.1), outside a compiled expression:
// the text, or null for a NULL value, format or culture and for a format .NET rejects. culture undefined means the
// session default (en-US, en-GB after SET LANGUAGE British); 8116 and 9818 are raised as FORMAT raises them.
export function formatValue(value, type, format, culture, env) {
  const kind0 = formatKind(type);
  if (format == null || culture === null || kind0 === 'null') return null;
  const cd = culture === undefined ? defaultCulture(env) : resolveCulture(String(culture));
  if (value == null) return null;
  const [kind, v, vt] = kind0 === 'any' ? dynamicValue(value) : [kind0, value, type];
  cultureWarning(env, cd);
  if (!valuePrograms) valuePrograms = programCache();
  return formatCap(valuePrograms(kind, String(format), cd)(v, vt, env));
}

// ------------------------------------------------------------------------------------------ xml methods (§8.3)
//
// x.value(path, type), x.query(path), x.exist(path) and x.nodes(path) (01 §8.3) over an XPath 1.0 / XQuery path
// subset, evaluated on the mixed-mode nodes of core/xml.js parseXml (through types.js xmlDoc; never DOMParser). A path
// is parsed once per (method, text, namespaces) and cached; values follow XPath 1.0: node sets in document order,
// strings, numbers and booleans, plus binary values from xs:base64Binary().

const XML_TYPE = Object.freeze({ dt: 'xml', len: -1, unicode: true });
const XML_NODE_TYPE = Object.freeze({ dt: 'xml', len: -1, unicode: true, xmlNode: true });
const BINMAX = Object.freeze({ dt: 'binary', len: -1 });
const NS = Object.freeze({
  xml: 'http://www.w3.org/XML/1998/namespace', xmlns: 'http://www.w3.org/2000/xmlns/', xs: 'http://www.w3.org/2001/XMLSchema',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance', fn: 'http://www.w3.org/2005/xpath-functions', sql: 'urn:schemas-microsoft-com:xml-sql',
});
const XML_DML = 'XML DML (modify) is not supported.';

// XQuery errors without a SQL Server number name the method: `XQuery [value()]: …`.
const xqErr = (method, text) => plainErr(`XQuery [${method}()]: ${text}`);
const xqUnsupported = (method, path) => xqErr(method, `the expression '${path.trim()}' is not supported.`);

// An attribute as an XPath node: its element is its parent; prefix and local name as written, the namespace URI
// resolved here from the element's in-scope declarations (an unprefixed attribute has none; xmlns and xmlns:p
// declarations get the xmlns URI, so attrsOf leaves them out).
class XAttr {
  constructor(el, name, value) {
    this.parent = el;
    this.name = name;
    this.value = value;
    const c = name.indexOf(':');
    this.prefix = c < 0 ? '' : name.slice(0, c);
    this.local = c < 0 ? name : name.slice(c + 1);
    this.uri = isNsDecl(name) ? NS.xmlns : this.prefix ? prefixUri(scopeOf(el), this.prefix) : '';
  }
}

const isText = n => n.name === '#text';
const isDoc = n => n.name === '#document';
const isElem = n => !(n instanceof XAttr) && n.name !== '#text' && n.name !== '#comment' && n.name !== '#pi' && n.name !== '#document';

// ---- namespaces of the parsed nodes
//
// 00 §3 / 01 §1 / §8.3: parseXml keeps every name with its prefix as written and leaves xmlns / xmlns:p as ordinary
// attributes; the evaluator resolves prefixes itself from those attributes through each node's `parent` chain (it
// reads no namespace field of the parser). An element's in-scope bindings are a Map prefix -> URI ('' = the default
// element namespace, an empty URI = none; xml is predefined), computed once per element, iteratively, and shared with
// the descendants that declare nothing of their own.

const ROOT_SCOPE = new Map([['xml', NS.xml]]);
const SCOPES = new WeakMap();  // element -> in-scope bindings
const QNAMES = new WeakMap();  // element -> {prefix, local, uri}

const isNsDecl = name => name === 'xmlns' || name.startsWith('xmlns:');

// The URI a prefix is bound to in a scope; null for an undeclared prefix (parseXml's mixed mode refuses those, so
// such a name only matches no name test).
const prefixUri = (scope, prefix) => scope.get(prefix) || null;

// The in-scope bindings of an element: the nearest cached ancestor's, extended down the chain by each element's own
// declarations.
function scopeOf(el) {
  let s = SCOPES.get(el);
  if (s) return s;
  const chain = [];
  for (let p = el; p && isElem(p); p = p.parent) {
    if ((s = SCOPES.get(p))) break;
    chain.push(p);
  }
  let cur = s || ROOT_SCOPE;
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = chain[i];
    let own = null;
    if (e.attrs) {
      for (const [name, value] of e.attrs) {
        if (!isNsDecl(name)) continue;
        const prefix = name === 'xmlns' ? '' : name.slice(6);
        if (prefix === 'xml' || prefix === 'xmlns') continue;
        if (!own) own = new Map(cur);
        own.set(prefix, String(value));
      }
    }
    if (own) cur = own;
    SCOPES.set(e, cur);
  }
  return cur;
}

// An element's prefix and local name as written and its namespace URI ('' for none; null for an undeclared prefix).
function qnameOf(el) {
  let q = QNAMES.get(el);
  if (!q) {
    const name = String(el.name), c = name.indexOf(':');
    const prefix = c < 0 ? '' : name.slice(0, c), scope = scopeOf(el);
    q = { prefix, local: c < 0 ? name : name.slice(c + 1), uri: prefix ? prefixUri(scope, prefix) : scope.get('') || '' };
    QNAMES.set(el, q);
  }
  return q;
}

// The {prefix, local, uri} of an element or attribute node.
const nameOf = n => (n instanceof XAttr ? n : qnameOf(n));

const ATTRS = new WeakMap();  // element -> XAttr[] (namespace declarations are not attributes in XPath)

function attrsOf(el) {
  let list = ATTRS.get(el);
  if (!list) {
    list = [];
    for (const [name, value] of el.attrs) {
      const a = new XAttr(el, name, value);
      if (a.uri !== NS.xmlns) list.push(a);
    }
    ATTRS.set(el, list);
  }
  return list;
}

const ORDERS = new WeakMap();  // document node -> Map<node, document order index>

// The document-order index of every node of the document that contains n (built once per document).
function orderOf(n) {
  let root = n;
  while (root.parent) root = root.parent;
  let map = ORDERS.get(root);
  if (!map) {
    map = new Map();
    let i = 0;
    const stack = [root];
    while (stack.length) {
      const x = stack.pop();
      map.set(x, i++);
      if (isElem(x)) for (const a of attrsOf(x)) map.set(a, i++);
      const kids = x.kids;
      if (kids) for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
    }
    ORDERS.set(root, map);
  }
  return map;
}

// Nodes in document order without duplicates.
function docOrder(nodes) {
  if (nodes.length < 2) return nodes;
  const map = orderOf(nodes[0]);
  const seen = new Set(), out = [];
  for (const n of nodes) if (!seen.has(n)) { seen.add(n); out.push(n); }
  return out.sort((a, b) => (map.get(a) ?? 0) - (map.get(b) ?? 0));
}

// The XPath string value of a node: the concatenated descendant text of an element or the document, else its text.
function stringValue(n) {
  if (n instanceof XAttr) return n.value;
  if (isText(n) || n.name === '#comment' || n.name === '#pi') return n.text;
  let out = '';
  const stack = [n];
  while (stack.length) {
    const x = stack.pop();
    if (isText(x)) { out += x.text; continue; }
    const kids = x.kids;
    if (kids) for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
  }
  return out;
}

// The descendants of n in document order (attributes excluded).
function descendants(n, out) {
  const stack = [];
  const kids = n.kids;
  if (kids) for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
  while (stack.length) {
    const x = stack.pop();
    out.push(x);
    const xk = x.kids;
    if (xk) for (let k = xk.length - 1; k >= 0; k--) stack.push(xk[k]);
  }
  return out;
}

// ---- lexer

const XQ_WS = /[ \t\r\n]/;
const NAME_START = /[\p{L}_]/u;
const NAME_PART = /[\p{L}\p{N}_.\-·\p{Mn}\p{Mc}]/u;
const ENTITIES = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"]]);
const XQ_NUM = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
// The deepest nesting of predicates and parentheses a path may have (the parser and the evaluator recurse on it).
const XQ_MAX_DEPTH = 256;

// The tokens of an XQuery path text: {t: 'name' (QName as written) | 'str' | 'num' | 'op', v, s}; null when the text
// holds a character the subset does not use.
function xqTokens(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  const nameAt = j => {
    if (j >= n) return j;
    const c = String.fromCodePoint(src.codePointAt(j));
    if (!NAME_START.test(c)) return j;
    j += c.length;
    while (j < n) {
      const d = String.fromCodePoint(src.codePointAt(j));
      if (!NAME_PART.test(d)) break;
      j += d.length;
    }
    return j;
  };
  while (i < n) {
    const c = src[i];
    if (XQ_WS.test(c)) { i++; continue; }
    const s = i;
    if (c === '"' || c === "'") {
      let v = '';
      i++;
      for (;;) {
        if (i >= n) return null;
        const d = src[i];
        if (d === c) {
          if (src[i + 1] === c) { v += c; i += 2; continue; }
          i++;
          break;
        }
        if (d === '&') {
          const semi = src.indexOf(';', i);
          if (semi < 0) return null;
          const ref = src.slice(i + 1, semi);
          let ch = ENTITIES.get(ref);
          if (ch === undefined) {
            const m = /^#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}))$/.exec(ref);
            const cp = m ? (m[1] ? parseInt(m[1], 16) : Number(m[2])) : NaN;
            if (!(cp >= 0 && cp <= 0x10ffff)) return null;
            ch = String.fromCodePoint(cp);
          }
          v += ch;
          i = semi + 1;
          continue;
        }
        v += d;
        i++;
      }
      toks.push({ t: 'str', v, s });
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      XQ_NUM.lastIndex = i;
      const m = XQ_NUM.exec(src);
      toks.push({ t: 'num', v: Number(m[0]), s, int: /^\d+$/.test(m[0]) });
      i += m[0].length;
      continue;
    }
    const e = nameAt(i);
    if (e > i) {
      let end = e;
      // A QName p:local or p:* (never p::, the axis separator).
      if (src[end] === ':' && src[end + 1] !== ':') {
        if (src[end + 1] === '*') end += 2;
        else {
          const e2 = nameAt(end + 1);
          if (e2 > end + 1) end = e2;
        }
      }
      toks.push({ t: 'name', v: src.slice(i, end), s });
      i = end;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '//' || two === '::' || two === '..' || two === '!=' || two === '<=' || two === '>=') {
      toks.push({ t: 'op', v: two, s });
      i += 2;
      continue;
    }
    if ('/.@[](),=<>*;-$|+:{}'.includes(c)) {
      toks.push({ t: 'op', v: c, s });
      i++;
      continue;
    }
    return null;
  }
  return toks;
}

// ---- parser

const AXES = new Set(['child', 'descendant', 'descendant-or-self', 'attribute', 'self', 'parent']);
const CMP_OPS = new Set(['=', '!=', '<', '<=', '>', '>=']);
// Function name (as written without fn:) -> [min, max] arguments.
const XQ_FUNCS = new Map([['string', [0, 1]], ['data', [1, 1]], ['count', [1, 1]], ['local-name', [0, 1]], ['name', [0, 1]],
  ['contains', [2, 2]], ['starts-with', [2, 2]], ['concat', [2, Infinity]], ['string-length', [0, 1]], ['normalize-space', [0, 1]],
  ['number', [0, 1]], ['sum', [1, 1]], ['position', [0, 0]], ['last', [0, 0]], ['not', [1, 1]]]);

// Parses an XQuery path of the 01 §8.3 subset: {expr, refs: [{kind: 'column'|'variable', name, parts?}]}.
function parseXQuery(method, path, xmlns) {
  const toks = xqTokens(path);
  if (!toks) throw xqUnsupported(method, path);
  let p = 0;
  const refs = [];
  const prefixes = new Map([['xml', NS.xml], ['xs', NS.xs], ['xsi', NS.xsi], ['fn', NS.fn], ['sql', NS.sql]]);
  let defaultNs = '';
  for (const d of xmlns || []) {
    if (d.prefix == null) defaultNs = d.uri;
    else prefixes.set(d.prefix, d.uri);
  }
  const bad = () => xqUnsupported(method, path);
  const peek = (k = 0) => toks[p + k];
  const isOp = (t, v) => !!t && t.t === 'op' && t.v === v;
  const isName = (t, v) => !!t && t.t === 'name' && t.v === v;
  const expectOp = v => { if (!isOp(peek(), v)) throw bad(); p++; };
  // Prolog: declare namespace p = "uri"; and declare default element namespace "uri";
  while (isName(peek(), 'declare') && (isName(peek(1), 'namespace') || isName(peek(1), 'default'))) {
    p++;
    if (isName(peek(), 'namespace')) {
      p++;
      const name = peek();
      if (!name || name.t !== 'name' || name.v.includes(':')) throw bad();
      p++;
      expectOp('=');
      const uri = peek();
      if (!uri || uri.t !== 'str') throw bad();
      p++;
      if (name.v !== 'xml' && name.v !== 'xmlns') prefixes.set(name.v, uri.v);
    } else {
      p++;
      if (!isName(peek(), 'element') || !isName(peek(1), 'namespace')) throw bad();
      p += 2;
      const uri = peek();
      if (!uri || uri.t !== 'str') throw bad();
      p++;
      defaultNs = uri.v;
    }
    expectOp(';');
  }
  const nsOf = prefix => {
    const uri = prefixes.get(prefix);
    if (uri === undefined) throw xqErr(method, `The name "${prefix}" does not denote a namespace.`);
    return uri;
  };
  // A name test: {kind: 'name', uri, local} (local '*' for p:*) or {kind: 'any'} for *.
  const nameTest = (qn, attr) => {
    const c = qn.indexOf(':');
    if (c < 0) return { kind: 'name', uri: attr ? '' : defaultNs, local: qn };
    return { kind: 'name', uri: nsOf(qn.slice(0, c)), local: qn.slice(c + 1) };
  };
  const step = () => {
    const t = peek();
    if (isOp(t, '.')) { p++; return { axis: 'self', test: { kind: 'node' }, preds: [] }; }
    if (isOp(t, '..')) { p++; return { axis: 'parent', test: { kind: 'node' }, preds: [] }; }
    let axis = 'child';
    if (isOp(t, '@')) { p++; axis = 'attribute'; }
    else if (t && t.t === 'name' && isOp(peek(1), '::')) {
      if (!AXES.has(t.v)) throw bad();
      axis = t.v;
      p += 2;
    }
    const nt = peek();
    let test;
    if (isOp(nt, '*')) { p++; test = { kind: 'any' }; }
    else if (nt && nt.t === 'name') {
      if ((nt.v === 'text' || nt.v === 'node') && isOp(peek(1), '(')) {
        p += 2;
        expectOp(')');
        test = { kind: nt.v };
      } else if (isOp(peek(1), '(')) throw bad();
      else {
        p++;
        test = nt.v.endsWith(':*') ? { kind: 'name', uri: nsOf(nt.v.slice(0, -2)), local: '*' } : nameTest(nt.v, axis === 'attribute');
      }
    } else throw bad();
    return { axis, test, preds: preds() };
  };
  const preds = () => {
    const out = [];
    while (isOp(peek(), '[')) {
      p++;
      out.push(orExpr());
      expectOp(']');
    }
    return out;
  };
  // Steps after the first one: ('/' | '//') step ... ('//' is /descendant-or-self::node()/).
  const moreSteps = steps => {
    for (;;) {
      if (isOp(peek(), '/')) { p++; steps.push(step()); }
      else if (isOp(peek(), '//')) {
        p++;
        steps.push({ axis: 'descendant-or-self', test: { kind: 'node' }, preds: [] }, step());
      } else return steps;
    }
  };
  const startsStep = t => !!t && (t.t === 'name' || isOp(t, '.') || isOp(t, '..') || isOp(t, '@') || isOp(t, '*'));
  const call = () => {
    const nameTok = toks[p];
    const qn = nameTok.v;
    p += 2;
    const args = [];
    if (!isOp(peek(), ')')) {
      for (;;) {
        args.push(qn === 'sql:column' || qn === 'sql:variable' ? sqlArg(qn) : orExpr());
        if (isOp(peek(), ',')) { p++; continue; }
        break;
      }
    }
    expectOp(')');
    if (qn === 'sql:column' || qn === 'sql:variable') {
      if (args.length !== 1) throw bad();
      return args[0];
    }
    if (qn === 'xs:base64Binary') {
      if (args.length !== 1) throw bad();
      return { k: 'b64', arg: args[0] };
    }
    const fn = qn.startsWith('fn:') ? qn.slice(3) : qn;
    const ar = XQ_FUNCS.get(fn);
    if (!ar || args.length < ar[0] || args.length > ar[1]) throw bad();
    return { k: 'call', fn, args };
  };
  // The string literal argument of sql:column / sql:variable (2225 otherwise).
  const sqlArg = qn => {
    const t = peek();
    if (!t || t.t !== 'str' || !(isOp(peek(1), ')') || isOp(peek(1), ','))) throw E(2225, method);
    p++;
    const i = refs.length;
    if (qn === 'sql:column') {
      refs.push({ kind: 'column', name: t.v, parts: t.v.split('.') });
      return { k: 'ref', i };
    }
    refs.push({ kind: 'variable', name: t.v.toLowerCase() });
    return { k: 'ref', i };
  };
  const primary = () => {
    const t = peek();
    if (!t) throw bad();
    if (t.t === 'str') { p++; return { k: 'str', v: t.v }; }
    if (t.t === 'num') { p++; return { k: 'num', v: t.v, int: t.int }; }
    if (isOp(t, '(')) {
      p++;
      const e = orExpr();
      expectOp(')');
      return e;
    }
    if (t.t === 'name' && isOp(peek(1), '(') && t.v !== 'text' && t.v !== 'node') return call();
    return null;
  };
  const pathExpr = () => {
    const t = peek();
    if (isOp(t, '/')) {
      p++;
      const steps = startsStep(peek()) ? moreSteps([step()]) : [];
      return { k: 'path', abs: true, steps };
    }
    if (isOp(t, '//')) {
      p++;
      return { k: 'path', abs: true, steps: moreSteps([{ axis: 'descendant-or-self', test: { kind: 'node' }, preds: [] }, step()]) };
    }
    if (isOp(t, '-')) {
      p++;
      const n = peek();
      if (!n || n.t !== 'num') throw bad();
      p++;
      return { k: 'num', v: -n.v, int: n.int };
    }
    const prim = primary();
    if (prim) {
      const ps = preds();
      const steps = moreSteps([]);
      return ps.length || steps.length ? { k: 'filter', e: prim, preds: ps, steps } : prim;
    }
    if (!startsStep(t)) throw bad();
    return { k: 'path', abs: false, steps: moreSteps([step()]) };
  };
  // Chains are flat lists (evaluated in a loop), so a long chain of comparisons, ands or ors never recurses deeply.
  const cmpExpr = () => {
    const first = pathExpr();
    const rest = [];
    while (peek() && peek().t === 'op' && CMP_OPS.has(peek().v)) {
      const op = peek().v;
      p++;
      rest.push({ op, e: pathExpr() });
    }
    return rest.length ? { k: 'cmp', first, rest } : first;
  };
  const andExpr = () => {
    const items = [cmpExpr()];
    while (isName(peek(), 'and')) { p++; items.push(cmpExpr()); }
    return items.length > 1 ? { k: 'and', items } : items[0];
  };
  let depth = 0;
  const orExpr = () => {
    if (++depth > XQ_MAX_DEPTH) throw bad();
    const items = [andExpr()];
    while (isName(peek(), 'or')) { p++; items.push(andExpr()); }
    depth--;
    return items.length > 1 ? { k: 'or', items } : items[0];
  };
  const expr = orExpr();
  if (p < toks.length) throw bad();
  return { expr, refs };
}

const XQ_CACHE = new Map();  // method \0 namespaces \0 path -> parsed path (bounded)

function xqParse(method, path, xmlns) {
  const key = method + '\u0000' + (xmlns && xmlns.length ? xmlns.map(d => `${d.prefix ?? ''}=${d.uri}`).join('\u0001') : '') + '\u0000' + path;
  let r = XQ_CACHE.get(key);
  if (!r) {
    r = parseXQuery(method, path, xmlns);
    if (XQ_CACHE.size >= 256) XQ_CACHE.delete(XQ_CACHE.keys().next().value);
    XQ_CACHE.set(key, r);
  }
  return r;
}

// ---- values: {t: 'n', v: Node[]} | {t: 'q', v: string[]} (data()) | {t: 's', v} | {t: 'd', v, int} | {t: 'b', v} |
// {t: 'x', v: Uint8Array}

const EMPTY = Object.freeze({ t: 'n', v: [] });
const XWS = /^[ \t\r\n]*$/;
const XNUM = /^[ \t\r\n]*-?(?:\d+(?:\.\d*)?|\.\d+)[ \t\r\n]*$/;

// XPath 1.0 string of a number: no exponent, integers without a fraction.
function xNumStr(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  return x === 0 ? '0' : plainNumber(x);
}

const strItems = a => (a.t === 'n' ? a.v.map(stringValue) : a.v);

function xStr(a) {
  switch (a.t) {
    case 'n': return a.v.length ? stringValue(a.v[0]) : '';
    case 'q': return a.v.length ? a.v[0] : '';
    case 's': return a.v;
    case 'd': return xNumStr(a.v);
    case 'b': return a.v ? 'true' : 'false';
    default: return base64Encode(a.v, false);
  }
}

const strNum = s => (XNUM.test(s) ? Number(s) : NaN);

function xNum(a) {
  switch (a.t) {
    case 'd': return a.v;
    case 'b': return a.v ? 1 : 0;
    case 'x': return NaN;
    default: return strNum(xStr(a));
  }
}

function xBool(a) {
  switch (a.t) {
    case 'n': case 'q': case 'x': return a.v.length > 0;
    case 's': return a.v.length > 0;
    case 'd': return a.v !== 0 && !Number.isNaN(a.v);
    default: return a.v;
  }
}

// One XPath 1.0 comparison of two atomic values given as JS values (a string, a number or a boolean).
function cmpAtom(op, x, y) {
  if (op === '=' || op === '!=') {
    let eqv;
    if (typeof x === 'boolean' || typeof y === 'boolean') eqv = Boolean(typeof x === 'boolean' ? x : xBool(atom(x))) === Boolean(typeof y === 'boolean' ? y : xBool(atom(y)));
    else if (typeof x === 'number' || typeof y === 'number') eqv = (typeof x === 'number' ? x : strNum(x)) === (typeof y === 'number' ? y : strNum(y));
    else eqv = x === y;
    return op === '=' ? eqv : !eqv;
  }
  const a = typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : strNum(x);
  const b = typeof y === 'number' ? y : typeof y === 'boolean' ? (y ? 1 : 0) : strNum(y);
  return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
}

const atom = x => (typeof x === 'number' ? { t: 'd', v: x } : { t: 's', v: x });
const FLIP = { '=': '=', '!=': '!=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };

// The JS value of an atomic XPath value for comparisons.
const jsAtom = a => (a.t === 'd' ? a.v : a.t === 'b' ? a.v : xStr(a));

// XPath 1.0 comparison (§3.4): node sets compare existentially by their string values (numbers and booleans by the
// other operand's rules).
function xCompare(op, l, r) {
  const ls = l.t === 'n' || l.t === 'q', rs = r.t === 'n' || r.t === 'q';
  if (ls && rs) {
    const a = strItems(l), b = strItems(r);
    return a.some(x => b.some(y => cmpAtom(op, x, y)));
  }
  if (ls || rs) {
    const set = ls ? l : r, other = ls ? r : l, o = ls ? op : FLIP[op];
    if (other.t === 'b') return cmpAtom(o, xBool(set), other.v);
    const y = jsAtom(other);
    return strItems(set).some(x => cmpAtom(o, typeof y === 'number' ? strNum(x) : x, y));
  }
  return cmpAtom(op, jsAtom(l), jsAtom(r));
}

// The nodes of one step from context node n (axis order = document order), before predicates.
function axisNodes(n, step) {
  const out = [];
  switch (step.axis) {
    case 'child': if (n.kids) for (const k of n.kids) out.push(k); break;
    case 'descendant': descendants(n, out); break;
    case 'descendant-or-self': out.push(n); descendants(n, out); break;
    case 'attribute': if (isElem(n)) for (const a of attrsOf(n)) out.push(a); break;
    case 'self': out.push(n); break;
    default: if (n.parent) out.push(n.parent);
  }
  const t = step.test;
  if (t.kind === 'node') return out;
  if (t.kind === 'text') return out.filter(isText);
  const principal = step.axis === 'attribute' ? x => x instanceof XAttr : isElem;
  if (t.kind === 'any') return out.filter(principal);
  return out.filter(x => {
    if (!principal(x)) return false;
    const q = nameOf(x);
    return q.uri === t.uri && (t.local === '*' || q.local === t.local);
  });
}

// Applies predicates to a node list (positions 1..size in the list's order).
function applyPreds(list, preds, cx) {
  for (const pr of preds) {
    const size = list.length;
    const next = [];
    for (let i = 0; i < size; i++) {
      const v = xEval(pr, { node: list[i], pos: i + 1, size, g: cx.g });
      if (v.t === 'd' ? v.v === i + 1 : xBool(v)) next.push(list[i]);
    }
    list = next;
  }
  return list;
}

// Evaluates location steps from a list of context nodes.
function runSteps(nodes, steps, cx) {
  for (const st of steps) {
    let out = [];
    for (const n of nodes) {
      const cand = applyPreds(axisNodes(n, st), st.preds, cx);
      for (const c of cand) out.push(c);
    }
    if (nodes.length > 1 || st.axis === 'parent') out = docOrder(out);
    nodes = out;
  }
  return nodes;
}

// The root (#document) node of a node.
function rootNode(n) {
  while (n.parent) n = n.parent;
  return n;
}

// The XPath value of a sql:column / sql:variable value of static type t (01 §8.3): strings, numbers, bit (boolean),
// binary, xml (its document node), date/time values as their ISO text; NULL is the empty sequence.
function sqlXValue(v, t, env) {
  if (v == null) return EMPTY;
  const base = variantValue(v);
  if (base !== v) return sqlXValue(base, variantType(v), env);
  switch (ty(t).dt) {
    case 'int': case 'bigint': return { t: 'd', v, int: true };
    case 'decimal': case 'money': case 'float': return { t: 'd', v };
    case 'bit': return { t: 'b', v: v === 1 || v === true };
    case 'binary': return { t: 'x', v };
    case 'xml': return { t: 'n', v: [xmlDoc(v)] };
    case 'date': case 'datetime': return { t: 's', v: toSqlString(v, t, { style: 126, tz: env && env.tz }) };
    default:
      if (typeof v === 'number') return { t: 'd', v };
      if (v instanceof Uint8Array) return { t: 'x', v };
      return { t: 's', v: String(v) };
  }
}

// Evaluates an XQuery expression with context cx = {node, pos, size, g: {row, env, refs, method, path}}.
function xEval(e, cx) {
  switch (e.k) {
    case 'str': return { t: 's', v: e.v };
    case 'num': return { t: 'd', v: e.v, int: e.int };
    case 'or': return { t: 'b', v: e.items.some(x => xBool(xEval(x, cx))) };
    case 'and': return { t: 'b', v: e.items.every(x => xBool(xEval(x, cx))) };
    case 'cmp': {
      // a op b op c compares left to right: (a op b) op c, as XPath 1.0 associates them.
      let l = xEval(e.first, cx);
      for (const { op, e: re } of e.rest) l = { t: 'b', v: xCompare(op, l, xEval(re, cx)) };
      return l;
    }
    case 'path': {
      const start = e.abs ? [rootNode(cx.node)] : [cx.node];
      return { t: 'n', v: runSteps(start, e.steps, cx) };
    }
    case 'filter': {
      const v = xEval(e.e, cx);
      if (v.t !== 'n') {
        if (e.steps.length) throw xqUnsupported(cx.g.method, cx.g.path);
        let items = v.t === 'q' ? v.v.map(s => ({ t: 's', v: s })) : [v];
        for (const pr of e.preds) {
          const size = items.length;
          items = items.filter((it, i) => {
            const r = xEval(pr, { node: cx.node, pos: i + 1, size, g: cx.g });
            return r.t === 'd' ? r.v === i + 1 : xBool(r);
          });
        }
        return items.length === 1 ? items[0] : { t: 'q', v: items.map(xStr) };
      }
      const list = applyPreds(docOrder(v.v), e.preds, cx);
      return { t: 'n', v: e.steps.length ? runSteps(list, e.steps, cx) : list };
    }
    case 'ref': {
      const { refs, row, env } = cx.g;
      const r = refs[e.i];
      return sqlXValue(r.fn(row, env), r.typeOf ? r.typeOf(env) : r.type, env);
    }
    case 'b64': {
      const a = xEval(e.arg, cx);
      if (a.t === 'x') return a;
      if ((a.t === 'n' || a.t === 'q') && !a.v.length) return EMPTY;
      return { t: 'x', v: base64Decode(xStr(a).replace(/[ \t\r\n]+/g, '')) };
    }
    default: return xCall(e, cx);
  }
}

// The node an optional node-set argument names (the context node without one), or null for an empty set.
function argNode(e, cx) {
  if (!e.args.length) return cx.node;
  const a = xEval(e.args[0], cx);
  return a.t === 'n' && a.v.length ? docOrder(a.v)[0] : null;
}

// The string an optional argument gives (the context node's string value without one).
const argStr = (e, cx, i = 0) => (e.args.length > i ? xStr(xEval(e.args[i], cx)) : stringValue(cx.node));

function xCall(e, cx) {
  switch (e.fn) {
    case 'position': return { t: 'd', v: cx.pos, int: true };
    case 'last': return { t: 'd', v: cx.size, int: true };
    case 'count': {
      const a = xEval(e.args[0], cx);
      return { t: 'd', v: a.t === 'n' || a.t === 'q' ? a.v.length : 1, int: true };
    }
    case 'sum': {
      const a = xEval(e.args[0], cx);
      if (a.t !== 'n' && a.t !== 'q') return { t: 'd', v: xNum(a) };
      let s = 0;
      for (const x of strItems(a)) s += strNum(x);
      return { t: 'd', v: s };
    }
    case 'string': return { t: 's', v: argStr(e, cx) };
    case 'data': {
      const a = xEval(e.args[0], cx);
      return a.t === 'n' ? { t: 'q', v: docOrder(a.v).map(stringValue) } : a;
    }
    case 'local-name': case 'name': {
      const n = argNode(e, cx);
      if (!n || isDoc(n) || isText(n) || n.name === '#comment') return { t: 's', v: '' };
      if (n.name === '#pi') return { t: 's', v: n.target };
      return { t: 's', v: e.fn === 'name' ? n.name : nameOf(n).local };
    }
    case 'contains': return { t: 'b', v: argStr(e, cx, 0).includes(argStr(e, cx, 1)) };
    case 'starts-with': return { t: 'b', v: argStr(e, cx, 0).startsWith(argStr(e, cx, 1)) };
    case 'concat': return { t: 's', v: e.args.map(a => xStr(xEval(a, cx))).join('') };
    case 'string-length': return { t: 'd', v: Array.from(argStr(e, cx)).length, int: true };
    case 'normalize-space': return { t: 's', v: argStr(e, cx).replace(/[ \t\r\n]+/g, ' ').trim() };
    case 'number': return { t: 'd', v: e.args.length ? xNum(xEval(e.args[0], cx)) : strNum(stringValue(cx.node)) };
    default: return { t: 'b', v: !xBool(xEval(e.args[0], cx)) }; // not
  }
}

// ---- serialisation (query())

// The namespace declarations a subtree uses that are declared outside it (so the fragment stays well-formed).
// One pass over the subtree that carries the prefixes declared inside it ('' for the default namespace).
function outerNamespaces(top) {
  const need = new Map();
  const stack = [{ e: top, declared: null }];
  while (stack.length) {
    const { e, declared: inherited } = stack.pop();
    let declared = inherited;
    for (const name of e.attrs.keys()) {
      if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
      if (declared === inherited) declared = new Set(inherited || []);
      declared.add(name === 'xmlns' ? '' : name.slice(6));
    }
    const check = (prefix, uri) => {
      if (uri == null || prefix === 'xml' || prefix === 'xmlns' || need.has(prefix) || (!prefix && !uri)) return;
      if (!declared || !declared.has(prefix)) need.set(prefix, uri);
    };
    const q = qnameOf(e);
    check(q.prefix, q.uri);
    for (const name of e.attrs.keys()) {
      const c = name.indexOf(':');
      if (c > 0 && name.slice(0, c) !== 'xmlns') check(name.slice(0, c), prefixUri(scopeOf(e), name.slice(0, c)));
    }
    for (const k of e.kids) if (isElem(k)) stack.push({ e: k, declared });
  }
  return need;
}

// Serialises one node (types.js serialised form, 01 §5.8): names as written, attribute values in double quotes,
// xmlEsc text and attributes, empty elements as <x/>, comments and processing instructions kept. Iterative.
function serialiseNode(node, out) {
  const stack = [{ n: node, open: false, extra: isElem(node) ? outerNamespaces(node) : null }];
  while (stack.length) {
    const fr = stack[stack.length - 1];
    const n = fr.n;
    if (fr.open) {
      if (fr.i < n.kids.length) {
        stack.push({ n: n.kids[fr.i++], open: false, extra: null });
        continue;
      }
      out.push('</' + n.name + '>');
      stack.pop();
      continue;
    }
    if (isText(n)) { out.push(xmlEsc(n.text, 'text')); stack.pop(); continue; }
    if (n.name === '#comment') { out.push('<!--' + n.text + '-->'); stack.pop(); continue; }
    if (n.name === '#pi') { out.push('<?' + n.target + (n.text ? ' ' + n.text : '') + '?>'); stack.pop(); continue; }
    if (isDoc(n)) {
      stack.pop();
      for (let k = n.kids.length - 1; k >= 0; k--) {
        const kid = n.kids[k];
        stack.push({ n: kid, open: false, extra: isElem(kid) ? outerNamespaces(kid) : null });
      }
      continue;
    }
    let tag = '<' + n.name;
    for (const [name, value] of n.attrs) tag += ' ' + name + '="' + xmlEsc(value, 'attr') + '"';
    if (fr.extra) for (const [prefix, uri] of fr.extra) tag += ' ' + (prefix ? 'xmlns:' + prefix : 'xmlns') + '="' + xmlEsc(uri, 'attr') + '"';
    if (!n.kids.length) {
      out.push(tag + '/>');
      stack.pop();
      continue;
    }
    out.push(tag + '>');
    fr.open = true;
    fr.i = 0;
  }
}

// query()'s result for an XPath value: nodes serialised in document order, atomic values as escaped text.
function xmlQueryText(v, method) {
  if (v.t !== 'n') return xmlEsc(v.t === 'q' ? v.v.join(' ') : xStr(v), 'text');
  const out = [];
  for (const n of docOrder(v.v)) {
    if (n instanceof XAttr) throw xqErr(method, 'Attribute may not appear outside of an element');
    serialiseNode(n, out);
  }
  return out.join('');
}

// ---- binding

// Data types value() cannot return (01 §8.3).
const VALUE_BAD_TYPES = new Set(['xml', 'text', 'ntext', 'image', 'rowversion', 'timestamp', 'sql_variant']);
const TYPE_TEXT = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:\(\s*(max|\d+)\s*(?:,\s*(\d+)\s*)?\))?\s*$/i;

// The DataType ({name, args}) and Type of value()'s second argument, a SQL type name such as 'nvarchar(100)'.
function xmlValueTypeOf(text) {
  const m = TYPE_TEXT.exec(text);
  if (!m) throw E(243, text.trim());
  const name = m[1].toLowerCase().replace(/\s+/g, ' ');
  if (VALUE_BAD_TYPES.has(name)) throw plainErr(`The data type '${name}' used in the VALUE method is invalid.`);
  const args = [];
  if (m[2] !== undefined) args.push(m[2].toLowerCase() === 'max' ? 'max' : Number(m[2]));
  if (m[3] !== undefined) args.push(Number(m[3]));
  const dataType = { name, args };
  return { dataType, type: dtOf(dataType, 30) };
}

// The string value of a literal argument node, or undefined when it is not a string literal.
const strLiteral = n => (n && n.type === 'paren' ? strLiteral(n.e) : n && n.type === 'lit' && typeof n.v === 'string' && n.dt === 'string' ? n.v : undefined);

// String operand -> its xml value, so a string converts to xml once, also for several methods on one value of a row
// (01 §8.3). Least recently used first out, bounded like types.js's xml cache: at most 64 entries and XML_TEXT_UNITS
// UTF-16 units of source plus value text in all; an entry larger than that is never kept.
const XML_TEXTS = new Map();
const XML_TEXT_ENTRIES = 64;
const XML_TEXT_UNITS = 4000000;
let xmlTextUnits = 0;

// The xml value of a string operand, through the XML_TEXTS cache.
function cachedXmlValue(s) {
  const hit = XML_TEXTS.get(s);
  if (hit !== undefined) {
    XML_TEXTS.delete(s);
    XML_TEXTS.set(s, hit);
    return hit;
  }
  const xv = xmlValue(s);
  const units = s.length + xv.length;
  if (units > XML_TEXT_UNITS) return xv;
  while (XML_TEXTS.size && (XML_TEXTS.size >= XML_TEXT_ENTRIES || xmlTextUnits + units > XML_TEXT_UNITS)) {
    const [old, ov] = XML_TEXTS.entries().next().value;
    XML_TEXTS.delete(old);
    xmlTextUnits -= old.length + ov.length;
  }
  XML_TEXTS.set(s, xv);
  xmlTextUnits += units;
  return xv;
}

// The size of the string-to-xml cache of the xml methods: {entries, units}.
export const xmlTextCacheSize = () => ({ entries: XML_TEXTS.size, units: xmlTextUnits });

// The context node of an xml method operand x (not NULL) of static type t: a node reference from nodes() is itself,
// an xml value its parsed document, a string the document of its xml conversion (01 §5.8, §8.3).
function contextNode(x, t) {
  if (t.xmlNode) return x;
  const base = variantValue(x);
  if (t.dt === 'xml') return xmlDoc(base);
  return xmlDoc(cachedXmlValue(typeof base === 'string' ? base : String(base)));
}

// A sql:variable reference read from env.vars at run time (when compile.js passes no resolver): 137 when undeclared.
function varRef(name) {
  const get = env => {
    const e = env && env.vars && env.vars.get(name);
    if (!e) throw E(137, name);
    return e;
  };
  return { fn: (row, env) => get(env).value, typeOf: env => get(env) };
}

// Binds a path for one method: the parsed expression and its sql:column / sql:variable references.
function bindXmlPath(method, path, xmlns, resolve) {
  const parsed = xqParse(method, path, xmlns);
  const refs = parsed.refs.map(r => {
    if (resolve) {
      const b = resolve(r);
      if (!b || typeof b.fn !== 'function') throw new TypeError(`functions.js: resolve(${r.kind} '${r.name}') must return {fn, type}.`);
      return b;
    }
    if (r.kind === 'variable') return varRef(r.name);
    throw new TypeError(`functions.js: sql:column("${r.name}") needs opts.resolve to bind the column.`);
  });
  return { expr: parsed.expr, refs, method, path };
}

// Evaluates a bound path on operand x (not NULL).
function runXmlPath(b, x, t, row, env) {
  const node = contextNode(x, t);
  return xEval(b.expr, { node, pos: 1, size: 1, g: { row, env, refs: b.refs, method: b.method, path: b.path } });
}

// value()'s result: the first node's string value or the atomic value, converted with castValue (01 §8.3).
function xmlValueResult(v, vt, env) {
  const opts = { tz: env && env.tz, dateformat: env && env.dateformat };
  switch (v.t) {
    case 'n': return v.v.length ? castValue(stringValue(docOrder(v.v)[0]), NV, vt.dataType, opts) : null;
    case 'q': return v.v.length ? castValue(v.v[0], NV, vt.dataType, opts) : null;
    case 's': return castValue(v.v, NV, vt.dataType, opts);
    case 'b':
      return vt.type.dt === 'string' ? castValue(v.v ? 'true' : 'false', NV, vt.dataType, opts) : castValue(v.v ? 1 : 0, { dt: 'bit' }, vt.dataType, opts);
    case 'x': return castValue(v.v, BINMAX, vt.dataType, opts);
    default:
      if (vt.type.dt === 'string') return castValue(xNumStr(v.v), NV, vt.dataType, opts);
      if (Number.isNaN(v.v) || !Number.isFinite(v.v)) throw E(3623);
      return castValue(v.v, v.int && Number.isSafeInteger(v.v) ? (int32(v.v) ? INT : BIGINT) : FLOAT, vt.dataType, opts);
  }
}

// exist()'s bit: a node set or data() sequence that is not empty, a true boolean, a non-empty string or binary, any
// number (01 §8.3).
const xmlExists = v => (v.t === 'd' ? 1 : xBool(v) ? 1 : 0);

// Binds an xml method call (01 §8.3) at compile time. node is the xmlmethod AST node ({e, method, args}; the
// path and value()'s type are string literals, else 8172), operandType the static Type of node.e (xml, a nodes()
// column with xmlNode, or a string type; any other raises 258). opts.xmlns: the WITH XMLNAMESPACES declarations in
// scope (XmlNs[]); opts.resolve(ref) -> {fn: (row, env) => value, type}: binds a sql:column("name") reference
// ({kind: 'column', name, parts}; 207/209/4104 are compile.js's) or a sql:variable("@v") one ({kind: 'variable',
// name}; 137). Returns {type, fn: (x, row, env) => value} for value, query and exist and {type, nodes: (x, row, env)
// -> Node[]} for nodes; x is the operand's value (NULL gives NULL, or no nodes). modify() raises XML DML's error.
export function bindXmlMethod(node, operandType, opts = {}) {
  const method = String(node && node.method).toLowerCase();
  const t = ty(operandType);
  if (method === 'modify') throw plainErr(XML_DML);
  if (!['value', 'query', 'exist', 'nodes'].includes(method)) throw new TypeError(`functions.js: unknown xml method '${method}'.`);
  if (!(t.dt === 'xml' || t.dt === 'string' || t.dt === 'null')) throw E(258, msgTypeName(t));
  const args = (node && node.args) || [];
  const want = method === 'value' ? 2 : 1;
  if (args.length !== want) throw E(174, method, want);
  const path = strLiteral(args[0]);
  if (path === undefined) throw E(8172, 1, method);
  let vt = null;
  if (method === 'value') {
    const typeText = strLiteral(args[1]);
    if (typeText === undefined) throw E(8172, 2, method);
    vt = xmlValueTypeOf(typeText);
  }
  const b = bindXmlPath(method, path, opts.xmlns, opts.resolve);
  switch (method) {
    case 'value': return { type: clean(vt.type), fn: (x, row, env) => (x == null ? null : xmlValueResult(runXmlPath(b, x, t, row, env), vt, env)) };
    case 'query': return { type: { ...XML_TYPE }, fn: (x, row, env) => (x == null ? null : xmlQueryText(runXmlPath(b, x, t, row, env), method)) };
    case 'exist': return { type: { dt: 'bit' }, fn: (x, row, env) => (x == null ? null : xmlExists(runXmlPath(b, x, t, row, env))) };
    default: return {
      type: { ...XML_NODE_TYPE },
      nodes: (x, row, env) => {
        if (x == null) return [];
        const v = runXmlPath(b, x, t, row, env);
        if (v.t !== 'n') throw xqUnsupported(method, path);
        return docOrder(v.v);
      },
    };
  }
}

// The internal TVF behind `x.nodes(path) AS t(c)` (01 §8 Table-valued, §8.3; 02 §3 phase 2): not callable by name and
// not in TVFS. columns(argTypes, consts, opts) gives one column named opts.column (the alias list's name), xml with
// xmlNode: true; rows([x, path], env, limit, argTypes, opts) gives one row [node] per matching node in document order.
// opts: {column, xmlns, bound} where bound is bindXmlMethod's result for the nodes() call (so sql:column references
// were bound in the scope that encloses the call); without it the path is bound here with opts.xmlns (sql:variable
// reads env.vars).
export const XML_NODES = Object.freeze({
  name: 'XML_NODES', tvf: true, min: 2, max: 2,
  columns: (argTypes, consts, opts) => [{ name: (opts && opts.column) || 'c', ...XML_NODE_TYPE }],
  rows(args, env, limit, argTypes = [], opts = null) {
    limit = scanRows(limit, env);
    const x = args[0], path = args[1];
    if (x == null || path == null) return [];
    const t = ty(argTypes[0]);
    let nodesOf;
    if (opts && opts.bound) nodesOf = opts.bound.nodes;
    else {
      if (!(t.dt === 'xml' || t.dt === 'string' || t.dt === 'null' || t.dt === 'any')) throw E(258, msgTypeName(t));
      const b = bindXmlPath('nodes', String(path), opts && opts.xmlns, null);
      const ot = t.dt === 'any' ? XML_TYPE : t;
      nodesOf = (v, row, e) => {
        const r = runXmlPath(b, v, ot, row, e);
        if (r.t !== 'n') throw xqUnsupported('nodes', String(path));
        return docOrder(r.v);
      };
    }
    const list = nodesOf(x, null, env);
    checkLimit(list.length, limit);
    return list.map(n => [n]);
  },
});

// ------------------------------------------------------------------------------------------------ registries

const toMap = list => new Map(list.map(e => [e.name, e]));

// Scalar functions by upper-case name (01 §8).
export const SCALARS = toMap([...STRINGS, ...DATES, ...MATH, ...LOGICAL, ...JSONS, ...SYSTEM]);

// [SQL name, FetchXML operator, min, max, kind, arg]; negative operators add not-null (01 §8, 02 §4.2).
const FETCH_LIST = [
  ['yesterday', 'yesterday', 0, 0, 'date'], ['today', 'today', 0, 0, 'date'], ['tomorrow', 'tomorrow', 0, 0, 'date'],
  ['lastsevendays', 'last-seven-days', 0, 0, 'date'], ['nextsevendays', 'next-seven-days', 0, 0, 'date'],
  ['lastweek', 'last-week', 0, 0, 'date'], ['thisweek', 'this-week', 0, 0, 'date'], ['nextweek', 'next-week', 0, 0, 'date'],
  ['lastmonth', 'last-month', 0, 0, 'date'], ['thismonth', 'this-month', 0, 0, 'date'], ['nextmonth', 'next-month', 0, 0, 'date'],
  ['lastyear', 'last-year', 0, 0, 'date'], ['thisyear', 'this-year', 0, 0, 'date'], ['nextyear', 'next-year', 0, 0, 'date'],
  ['lastxhours', 'last-x-hours', 1, 1, 'date', 'int'], ['nextxhours', 'next-x-hours', 1, 1, 'date', 'int'],
  ['lastxdays', 'last-x-days', 1, 1, 'date', 'int'], ['nextxdays', 'next-x-days', 1, 1, 'date', 'int'],
  ['lastxweeks', 'last-x-weeks', 1, 1, 'date', 'int'], ['nextxweeks', 'next-x-weeks', 1, 1, 'date', 'int'],
  ['lastxmonths', 'last-x-months', 1, 1, 'date', 'int'], ['nextxmonths', 'next-x-months', 1, 1, 'date', 'int'],
  ['lastxyears', 'last-x-years', 1, 1, 'date', 'int'], ['nextxyears', 'next-x-years', 1, 1, 'date', 'int'],
  ['olderthanxminutes', 'olderthan-x-minutes', 1, 1, 'date', 'int'], ['olderthanxhours', 'olderthan-x-hours', 1, 1, 'date', 'int'],
  ['olderthanxdays', 'olderthan-x-days', 1, 1, 'date', 'int'], ['olderthanxweeks', 'olderthan-x-weeks', 1, 1, 'date', 'int'],
  ['olderthanxmonths', 'olderthan-x-months', 1, 1, 'date', 'int'], ['olderthanxyears', 'olderthan-x-years', 1, 1, 'date', 'int'],
  ['on', 'on', 1, 1, 'date', 'date'], ['onorbefore', 'on-or-before', 1, 1, 'date', 'date'], ['onorafter', 'on-or-after', 1, 1, 'date', 'date'],
  ['thisfiscalyear', 'this-fiscal-year', 0, 0, 'fiscal'], ['thisfiscalperiod', 'this-fiscal-period', 0, 0, 'fiscal'],
  ['nextfiscalyear', 'next-fiscal-year', 0, 0, 'fiscal'], ['nextfiscalperiod', 'next-fiscal-period', 0, 0, 'fiscal'],
  ['lastfiscalyear', 'last-fiscal-year', 0, 0, 'fiscal'], ['lastfiscalperiod', 'last-fiscal-period', 0, 0, 'fiscal'],
  ['lastxfiscalyears', 'last-x-fiscal-years', 1, 1, 'fiscal', 'int'], ['lastxfiscalperiods', 'last-x-fiscal-periods', 1, 1, 'fiscal', 'int'],
  ['nextxfiscalyears', 'next-x-fiscal-years', 1, 1, 'fiscal', 'int'], ['nextxfiscalperiods', 'next-x-fiscal-periods', 1, 1, 'fiscal', 'int'],
  ['infiscalyear', 'in-fiscal-year', 1, 1, 'fiscal', 'int'], ['infiscalperiod', 'in-fiscal-period', 1, 1, 'fiscal', 'int'],
  ['infiscalperiodandyear', 'in-fiscal-period-and-year', 2, 2, 'fiscal', 'int'],
  ['inorbeforefiscalperiodandyear', 'in-or-before-fiscal-period-and-year', 2, 2, 'fiscal', 'int'],
  ['inorafterfiscalperiodandyear', 'in-or-after-fiscal-period-and-year', 2, 2, 'fiscal', 'int'],
  ['equserid', 'eq-userid', 0, 0, 'user'], ['neuserid', 'ne-userid', 0, 0, 'user', null, true],
  ['equserteams', 'eq-userteams', 0, 0, 'user'], ['equseroruserteams', 'eq-useroruserteams', 0, 0, 'user'],
  ['equseroruserhierarchy', 'eq-useroruserhierarchy', 0, 0, 'user'],
  ['equseroruserhierarchyandteams', 'eq-useroruserhierarchyandteams', 0, 0, 'user'],
  ['eqbusinessid', 'eq-businessid', 0, 0, 'business'], ['nebusinessid', 'ne-businessid', 0, 0, 'business', null, true],
  ['equserlanguage', 'eq-userlanguage', 0, 0, 'language'],
  ['beginswith', 'begins-with', 1, 1, 'string', 'string'], ['notbeginwith', 'not-begin-with', 1, 1, 'string', 'string', true],
  ['endswith', 'ends-with', 1, 1, 'string', 'string'], ['notendwith', 'not-end-with', 1, 1, 'string', 'string', true],
  ['under', 'under', 1, 1, 'hierarchy', 'guid'], ['eqorunder', 'eq-or-under', 1, 1, 'hierarchy', 'guid'],
  ['notunder', 'not-under', 1, 1, 'hierarchy', 'guid', true], ['above', 'above', 1, 1, 'hierarchy', 'guid'],
  ['eqorabove', 'eq-or-above', 1, 1, 'hierarchy', 'guid'],
  ['containvalues', 'contain-values', 1, Infinity, 'multi', 'int'], ['notcontainvalues', 'not-contain-values', 1, Infinity, 'multi', 'int', true],
];

// FetchXML condition functions by upper-case SQL name: {name, op, min, max, negative, kind, arg} (01 §8).
export const FETCH_CONDITIONS = new Map(FETCH_LIST.map(([name, op, min, max, kind, arg = null, negative = false]) =>
  [name.toUpperCase(), Object.freeze({ name, op, min, max, negative, kind, arg })]));

// The error for a FetchXML condition function left in a client expression (01 §8).
export function fetchConditionError(name) {
  const e = FETCH_CONDITIONS.get(String(name).toUpperCase());
  return plainErr(`'${e ? e.name : String(name).toLowerCase()}' can only be used as a condition on a Dataverse column that runs on the server.`);
}

// -------------------------------------------------------------------------------------------- aggregates

function sumType(t, op, avg) {
  switch (t.dt) {
    case 'int': return { dt: 'int' };
    case 'bigint': return { dt: 'bigint' };
    case 'decimal': return { dt: 'decimal', prec: 38, scale: avg ? Math.max(t.scale ?? 0, 6) : (t.scale ?? 0) };
    case 'money': return { dt: 'money', prec: 19, scale: 4 };
    case 'float': return { dt: 'float' };
    default: throw badOp(t, op);
  }
}

// Neumaier-compensated running sum plus a plain sum (integers and floats use the plain one).
function addSum(st, v) {
  st.n++;
  st.p += v;
  const t = st.s + v;
  st.c += Math.abs(st.s) >= Math.abs(v) ? (st.s - t) + v : (v - t) + st.s;
  st.s = t;
}

function mergeSum(a, b) {
  a.n += b.n;
  a.p += b.p;
  const t = a.s + b.s;
  a.c += (Math.abs(a.s) >= Math.abs(b.s) ? (a.s - t) + b.s : (b.s - t) + a.s) + b.c;
  a.s = t;
}

function sumResult(st, type, env, divide) {
  if (!st.n) return null;
  switch (type.dt) {
    case 'int': {
      if (!int32(st.p)) throw overflow('int');
      return nz(divide ? Math.trunc(st.p / st.n) : st.p);
    }
    case 'bigint': {
      if (!(st.p >= -9223372036854775808 && st.p < 9223372036854775808)) throw overflow('bigint');
      const r = divide ? Math.trunc(st.p / st.n) : st.p;
      if (!Number.isSafeInteger(r) && env && env.warn) env.warn(BIGINT_LOSS);
      return nz(r);
    }
    case 'float': {
      if (!Number.isFinite(st.p)) throw overflow('float');
      return nz(divide ? st.p / st.n : st.p);
    }
    case 'money': {
      const r = roundDec(divide ? (st.s + st.c) / st.n : st.s + st.c, 4);
      return nz(checkInt(r, type));
    }
    default: {
      const total = st.s + st.c;
      if (!Number.isFinite(total)) throw overflow('numeric');
      return nz(fitScale(divide ? total / st.n : total, type));
    }
  }
}

const sumState = () => ({ n: 0, p: 0, s: 0, c: 0 });
const anyType = ts => ty(ts && ts[0]);

// The argument types an aggregate's init needs (comparison or conversion type): a caller that omits them is a
// programming error, raised instead of comparing by the JS type (see the notes at the top of this file).
function aggTypes(name, ts) {
  if (!Array.isArray(ts) || !ts.length) throw new TypeError(`functions.js: ${name} init(consts, argTypes) needs the argument types.`);
  return ts;
}

// SUM/AVG result: the type is normalised with sumType, so the result type (decimal(38, s)) and the argument type
// (decimal(p, s)) give the same result; a missing type is a programming error.
function sumOut(name, st, type, env, divide) {
  if (!type || !type.dt) throw new TypeError(`functions.js: ${name} result(state, type) needs the type.`);
  return sumResult(st, sumType(type, name.toLowerCase(), divide), env, divide);
}

function minMax(name, sign) {
  return {
    name, agg: true, min: 1, max: 1, distinctable: true, orderable: false,
    // The argument type; 8117 for bit and NULL, 305 for xml (it cannot be compared, 01 §5.8).
    dt(ts) {
      const t = anyType(ts);
      if (t.dt === 'xml') throw E(305);
      if (t.dt === 'bit' || t.dt === 'null') throw badOp(t, name.toLowerCase());
      return clean(t);
    },
    init: (cs, ts) => ({ v: null, t: anyType(aggTypes(name, ts)), ai: aiOf(ts) }),
    step(st, args) {
      const x = args[0];
      if (x == null) return;
      if (st.v == null || cmp(x, st.v, st.t, st.ai) * sign > 0) st.v = x;
    },
    result: st => st.v,
    merge(a, b) {
      if (b.v != null && (a.v == null || cmp(b.v, a.v, a.t, a.ai) * sign > 0)) a.v = b.v;
    },
  };
}

function statAgg(name, kind) {
  return {
    name, agg: true, min: 1, max: 1, distinctable: true, orderable: false,
    dt(ts) {
      const t = anyType(ts);
      if (!NUMS.has(t.dt)) throw badOp(t, name.toLowerCase());
      return { dt: 'float' };
    },
    init: () => ({ n: 0, mean: 0, m2: 0 }),
    step(st, args) {
      const x = args[0];
      if (x == null) return;
      st.n++;
      const d = x - st.mean;
      st.mean += d / st.n;
      st.m2 += d * (x - st.mean);
    },
    result(st) {
      const pop = kind === 'VARP' || kind === 'STDEVP';
      if (st.n === 0 || (!pop && st.n === 1)) return null;
      const v = Math.max(st.m2, 0) / (pop ? st.n : st.n - 1);
      const r = kind.startsWith('STDEV') ? Math.sqrt(v) : v;
      if (!Number.isFinite(r)) throw overflow('float');
      return nz(r);
    },
    merge(a, b) {
      if (!b.n) return;
      if (!a.n) { a.n = b.n; a.mean = b.mean; a.m2 = b.m2; return; }
      const n = a.n + b.n, d = b.mean - a.mean;
      a.m2 += b.m2 + (d * d * a.n * b.n) / n;
      a.mean += (d * b.n) / n;
      a.n = n;
    },
  };
}

function countAgg(name, big) {
  return {
    name, agg: true, min: 1, max: 1, star: true, distinctable: true, orderable: false,
    dt: () => ({ dt: big ? 'bigint' : 'int' }),
    init: () => ({ n: 0 }),
    step(st) { st.n++; },
    result(st) {
      if (!big && st.n > 2147483647) throw overflow('int');
      return st.n;
    },
    merge(a, b) { a.n += b.n; },
  };
}

// STRING_AGG's type (01 §5): nvarchar(4000) / varchar(8000), max when either argument is max; nvarchar for a
// value that is not a string, or when either argument is nvarchar.
function stringAggType(ts) {
  const t = anyType(ts), s = ty(ts && ts[1]);
  if (t.dt === 'xml') throw badArg(t, 1, 'string_agg');
  if (!strLike(s)) throw badArg(s, 2, 'string_agg');
  const max = isMax(t) || (s.dt === 'string' && s.len === -1);
  if (t.dt !== 'string' && t.dt !== 'null') return { dt: 'string', len: max ? -1 : 4000, unicode: true };
  const uni = isUni(t) || isUni(s);
  const r = { dt: 'string', len: max ? -1 : uni ? 4000 : 8000 };
  if (uni) r.unicode = true;
  return r;
}

// STRING_AGG length limits: 9829 for a non-max result over 8,000 bytes; a max result over MAX_STRING characters.
function stringAggCheck(st) {
  if (st.len <= st.cap && st.len <= MAX_STRING) return;
  if (st.cap > MAX_STRING) throw tooLong('STRING_AGG');
  throw E(9829);
}

// Aggregate functions by upper-case name (01 §8).
export const AGGREGATES = toMap([
  {
    name: 'APPROX_COUNT_DISTINCT', agg: true, min: 1, max: 1, distinctable: false, orderable: false, noOver: true,
    // bigint; 305 for xml, which cannot be compared or hashed (01 §5.8).
    dt(ts) {
      if (anyType(ts).dt === 'xml') throw E(305);
      return { dt: 'bigint' };
    },
    init: (cs, ts) => ({ set: new Set(), t: anyType(aggTypes('APPROX_COUNT_DISTINCT', ts)), ai: aiOf(ts) }),
    step(st, args) { if (args[0] != null) st.set.add(keyOf(args[0], st.t, st.ai)); },
    result: st => st.set.size,
    merge(a, b) { for (const k of b.set) a.set.add(k); },
  },
  {
    name: 'AVG', agg: true, min: 1, max: 1, distinctable: true, orderable: false,
    dt: ts => sumType(anyType(ts), 'avg', true),
    init: sumState,
    step(st, args) { if (args[0] != null) addSum(st, args[0]); },
    result: (st, type, env) => sumOut('AVG', st, type, env, true),
    merge: mergeSum,
  },
  countAgg('COUNT', false),
  countAgg('COUNT_BIG', true),
  minMax('MAX', 1),
  minMax('MIN', -1),
  statAgg('STDEV', 'STDEV'),
  statAgg('STDEVP', 'STDEVP'),
  {
    // A constant separator is kept once (sep); a per-row one is recorded for every value, the first included
    // (seps[i] belongs to parts[i] and precedes it from the second value on), so merge keeps each row's own separator.
    name: 'STRING_AGG', agg: true, min: 2, max: 2, consts: [1], distinctable: false, orderable: true,
    dt: stringAggType,
    init(cs = [], ts) {
      const r = stringAggType(aggTypes('STRING_AGG', ts));
      const sep = cs[1] === undefined ? undefined : (cs[1] == null ? '' : String(cs[1]));
      return { parts: [], seps: sep === undefined ? [] : null, len: 0, sep, t: anyType(ts),
        st: ty(ts[1]), cap: r.len === -1 ? Infinity : r.unicode ? 4000 : 8000 };
    },
    step(st, args, env) {
      const x = args[0];
      if (x == null) return;
      const s = sv(x, st.t, env);
      let sepLen;
      if (st.sep === undefined) {
        const sp = args[1] == null ? '' : sv(args[1], st.st, env);
        st.seps.push(sp);
        sepLen = sp.length;
      } else sepLen = st.sep.length;
      st.len += (st.parts.length ? sepLen : 0) + s.length;
      st.parts.push(s);
      stringAggCheck(st);
    },
    result(st) {
      if (!st.parts.length) return null;
      if (st.sep !== undefined) return st.parts.join(st.sep);
      let out = st.parts[0];
      for (let i = 1; i < st.parts.length; i++) out += st.seps[i] + st.parts[i];
      return out;
    },
    merge(a, b) {
      if (!b.parts.length) return;
      if (a.parts.length) a.len += a.sep !== undefined ? a.sep.length : b.seps[0].length;
      for (let i = 0; i < b.parts.length; i++) {
        a.parts.push(b.parts[i]);
        if (a.sep === undefined) a.seps.push(b.seps[i]);
      }
      a.len += b.len;
      stringAggCheck(a);
    },
  },
  {
    name: 'SUM', agg: true, min: 1, max: 1, distinctable: true, orderable: false,
    dt: ts => sumType(anyType(ts), 'sum', false),
    init: sumState,
    step(st, args) { if (args[0] != null) addSum(st, args[0]); },
    result: (st, type, env) => sumOut('SUM', st, type, env, false),
    merge: mergeSum,
  },
  statAgg('VAR', 'VAR'),
  statAgg('VARP', 'VARP'),
]);

// --------------------------------------------------------------------------------------------------- windows

function lagLead(name, dir) {
  return {
    name, window: true, min: 1, max: 3, needsOrder: true, allowsFrame: false,
    dt: ts => clean(anyType(ts)),
    eval: (part, args, ctx) => {
      const env = ctx && ctx.env;
      const N = part.length, out = new Array(N);
      const x = args[0], off = args[1], def = args[2];
      for (let i = 0; i < N; i++) {
        let o = 1;
        if (off) {
          const ov = off.fn(part[i], env);
          if (ov == null) { out[i] = null; continue; }
          o = toBig(ov, off, env);
          if (o < 0) throw E(8730);
        }
        const j = i + dir * o;
        if (j >= 0 && j < N) out[i] = x.fn(part[j], env);
        else out[i] = def ? conv(def.fn(part[i], env), def, x, env) : null;
      }
      return out;
    },
  };
}

const windowDef = (name, dt, evalFn, o = {}) => Object.assign({ name, window: true, min: 0, max: 0, needsOrder: true, allowsFrame: false, dt, eval: evalFn }, o);

// Window functions by upper-case name (01 §8).
export const WINDOWS = toMap([
  windowDef('CUME_DIST', () => ({ dt: 'float' }), (part, args, { peerEnd }) => Array.from(part, (r, i) => peerEnd[i] / part.length)),
  windowDef('DENSE_RANK', () => ({ dt: 'bigint' }), (part, args, { peerStart }) => {
    const out = new Array(part.length);
    let r = 0;
    for (let i = 0; i < part.length; i++) {
      if (i === 0 || peerStart[i] === i) r++;
      out[i] = r;
    }
    return out;
  }),
  windowDef('FIRST_VALUE', ts => clean(anyType(ts)), (part, args, { frameStart, frameEnd, env }) =>
    Array.from(part, (r, i) => (frameStart[i] < frameEnd[i] ? args[0].fn(part[frameStart[i]], env) : null)), { min: 1, max: 1, allowsFrame: true }),
  lagLead('LAG', -1),
  windowDef('LAST_VALUE', ts => clean(anyType(ts)), (part, args, { frameStart, frameEnd, env }) =>
    Array.from(part, (r, i) => (frameStart[i] < frameEnd[i] ? args[0].fn(part[frameEnd[i] - 1], env) : null)), { min: 1, max: 1, allowsFrame: true }),
  lagLead('LEAD', 1),
  windowDef('NTILE', () => ({ dt: 'bigint' }), (part, args, { env }) => {
    const N = part.length, out = new Array(N);
    if (!N) return out;
    const nv = args[0].fn(part[0], env);
    const n = nv == null ? null : toBig(nv, args[0], env);
    if (n == null || !(n > 0)) throw E(4110);
    const size = Math.floor(N / n), extra = N % n, cut = extra * (size + 1);
    for (let i = 0; i < N; i++) out[i] = i < cut ? Math.floor(i / (size + 1)) + 1 : extra + Math.floor((i - cut) / size) + 1;
    return out;
  }, { min: 1, max: 1 }),
  windowDef('PERCENT_RANK', () => ({ dt: 'float' }), (part, args, { peerStart }) =>
    Array.from(part, (r, i) => (part.length === 1 ? 0 : peerStart[i] / (part.length - 1)))),
  windowDef('RANK', () => ({ dt: 'bigint' }), (part, args, { peerStart }) => Array.from(part, (r, i) => peerStart[i] + 1)),
  windowDef('ROW_NUMBER', () => ({ dt: 'bigint' }), part => Array.from(part, (r, i) => i + 1)),
]);

// ------------------------------------------------------------------------------------------------------ TVFs

const DEFAULT_SCAN_ROWS = 500000;

// The row limit of a TVF call: the caller's limit (Infinity = none), else settings.maxScanRows of the statement
// (env.settings or env.session.settings, 02 §4.4), else its default 500,000; never unlimited by omission.
function scanRows(limit, env) {
  if (limit != null) return limit;
  const s = env && (env.settings || (env.session && env.session.settings));
  const n = s && s.maxScanRows;
  return typeof n === 'number' && n > 0 ? n : DEFAULT_SCAN_ROWS;
}

function checkLimit(n, limit) {
  if (n > limit) throw scanLimit(limit);
}

const E214 = () => E(214, 'separator', 'nchar(1)/nvarchar(1)');

// Whether an argument AST node is a literal (also inside parentheses).
const isLiteral = n => (n && n.type === 'paren' ? isLiteral(n.e) : !!n && n.type === 'lit');

// STRING_SPLIT's columns and compile-time checks (01 §8): a NULL separator raises 214; enable_ordinal must be
// the integer literal 0 or 1 (NULL: 0). Not a constant (or, when the planner passes the argument nodes, not a
// literal: a variable or an expression) raises 8748, a literal of another type 8116, another integer 4199. value has
// the length of the string argument and is nvarchar when either string argument is (01 §5, as SQL Server).
function splitColumns(ts, cs = [], withSchema = null, nodes = null) {
  const t = ty(ts[0]);
  if (!strLike(t)) throw badArg(t, 1, 'string_split');
  if (ts.length > 1 && cs[1] === null) throw E214();
  const value = { name: 'value', ...sType(t) };
  if (ts.length > 1 && ty(ts[1]).dt === 'string' && ty(ts[1]).unicode) value.unicode = true;
  if (ts.length < 3) return [value];
  if (cs[2] === undefined || (nodes && nodes[2] && !isLiteral(nodes[2]))) throw E(8748);
  const ot = ty(ts[2]);
  if (cs[2] !== null && !(ot.dt === 'int' || ot.dt === 'bigint' || ot.dt === 'bit' || ot.dt === 'null')) throw badArg(ot, 3, 'string_split');
  const o = cs[2] == null ? 0 : Number(cs[2]);
  if (o !== 0 && o !== 1) throw E(4199, cs[2], 3, 'string_split');
  return o === 1 ? [value, { name: 'ordinal', dt: 'bigint' }] : [value];
}

function seriesType(ts) {
  for (let i = 0; i < ts.length; i++) {
    const t = ty(ts[i]);
    if (!(t.dt === 'int' || t.dt === 'bigint' || t.dt === 'decimal' || t.dt === 'null')) throw badArg(t, i + 1, 'generate_series');
  }
  return unify(ts);
}

// The static type of a value whose argument type the caller did not pass, by the 01 §5 literal rules: an integer
// within int is int, any other integer decimal(digits, 0), a fraction decimal(digits, fraction digits); strings
// and dates keep their own type (seriesType then raises 8116).
function valueType(v) {
  if (v == null) return { dt: 'null' };
  if (typeof v === 'string') return { dt: 'string', len: Math.max(v.length, 1), unicode: true };
  if (v instanceof Date) return { dt: 'datetime' };
  if (typeof v !== 'number' || !Number.isFinite(v)) return ANY;
  if (Number.isInteger(v) && int32(v)) return INT;
  const str = plainNumber(Math.abs(v));
  const dot = str.indexOf('.');
  const ip = dot < 0 ? str : str.slice(0, dot);
  const scale = Math.min(dot < 0 ? 0 : str.length - dot - 1, 38);
  const prec = Math.min(Math.max((ip === '0' ? 0 : ip.length) + scale, 1), 38);
  return { dt: 'decimal', prec, scale };
}

// v · 10^s as an exact BigInt: int and bigint values are exact integers (their binary value, as toSqlString prints
// them); decimals use the decimal digits of v rounded to scale s, never binary arithmetic.
function scaledInt(v, s, dec) {
  if (!dec) return BigInt(Math.trunc(v));
  const str = plainNumber(Math.abs(roundDec(v, s)));
  const dot = str.indexOf('.');
  const ip = dot < 0 ? str : str.slice(0, dot);
  const fp = dot < 0 ? '' : str.slice(dot + 1, dot + 1 + s);
  const n = BigInt(ip + fp.padEnd(s, '0'));
  return v < 0 ? -n : n;
}

// The count values A + k·S (k = 0 … count - 1) at scale s as rows. When every value and the whole span are safe
// integers, doubles are exact (an exact integer divided by an exact power of ten is the nearest double of the
// decimal); otherwise BigInt gives each exact value and its nearest double, which never passes stop. bigint values
// beyond ±2^53 add the BIGINT_LOSS warning once (01 §5).
function seriesRows(A, S, count, s, big, env) {
  const out = new Array(count);
  const last = A + BigInt(count - 1) * S;
  const safe = s <= 22 && isSafeBig(A) && isSafeBig(last) && isSafeBig(last - A);
  if (safe) {
    const a = Number(A), st = Number(S), p = 10 ** s;
    for (let k = 0; k < count; k++) {
      const v = a + k * st;
      out[k] = [nz(s === 0 ? v : v / p)];
    }
    return out;
  }
  let lossy = false, V = A;
  for (let k = 0; k < count; k++, V += S) {
    const v = s === 0 ? Number(V) : Number(`${V}e-${s}`);
    if (big && !Number.isSafeInteger(v)) lossy = true;
    out[k] = [nz(v)];
  }
  if (lossy && env && env.warn) env.warn(BIGINT_LOSS);
  return out;
}

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const isSafeBig = n => n <= MAX_SAFE_BIG && n >= -MAX_SAFE_BIG;
// The most rows GENERATE_SERIES builds when no row limit applies (as the 100,000,000-character string limit).
const MAX_SERIES = 100000000n;

// OPENJSON's columns (01 §8): key nvarchar(4000), value nvarchar(max) and type int, or the WITH columns
// (declared types; AS JSON columns nvarchar(max) with json: true).
function openjsonColumns(ts, cs, withSchema) {
  jsonArgCheck(ts, 'openjson');
  if (!withSchema) {
    return [{ name: 'key', dt: 'string', len: 4000, unicode: true }, { name: 'value', dt: 'string', len: -1, unicode: true }, { name: 'type', dt: 'int' }];
  }
  return withSchema.map(c => (c.asJson ? { name: c.name, dt: 'string', len: -1, unicode: true, json: true } : { name: c.name, ...dtOf(c.dataType, 1) }));
}

function jsonCell(text, node) {
  switch (node.t) {
    case 'o': case 'a': case 'n': return text.slice(node.s, node.e);
    case 's': return decodeStr(text, node.s, node.e);
    case 't': return 'true';
    case 'f': return 'false';
    default: return null;
  }
}

const JSON_TYPE = { z: 0, s: 1, n: 2, t: 3, f: 3, a: 4, o: 5 };

// Column paths of an OPENJSON WITH schema: the written path, or lax $."<column name>".
function withPaths(withSchema) {
  return withSchema.map(c => (c.path == null ? { append: false, strict: false, steps: [{ k: c.name }] } : parsePath(c.path, false)));
}

// Table-valued functions by upper-case name (01 §8).
export const TVFS = toMap([
  {
    name: 'GENERATE_SERIES', tvf: true, min: 2, max: 3,
    columns: ts => [{ name: 'value', ...seriesType(ts) }],
    rows(args, env, limit, ts = []) {
      limit = scanRows(limit, env);
      const types = args.map((v, i) => (ts[i] ? ty(ts[i]) : valueType(v)));
      const rt = seriesType(types);
      if (anyNull(args)) return [];
      // Exact arithmetic on integers scaled by 10^scale: the series holds start + k*step only while it does not
      // pass stop, also for decimals just below a step boundary and for bigint values beyond 2^53.
      const dec = rt.dt === 'decimal', s = dec ? (rt.scale ?? 0) : 0;
      const exact = i => scaledInt(coerce(args[i], types[i], rt, env), s, dec);
      const A = exact(0), B = exact(1);
      const S = args.length > 2 ? exact(2) : (A <= B ? 1n : -1n) * 10n ** BigInt(s);
      if (S === 0n) throw E(4199, 0, 3, 'generate_series');
      if ((S > 0n && A > B) || (S < 0n && A < B)) return [];
      const count = (B - A) / S + 1n;
      checkLimit(Number(count), limit);
      // Without a row limit, a series the browser cannot hold is a clear error, never a RangeError or a lost count.
      if (count > MAX_SERIES) throw plainErr(`GENERATE_SERIES would return ${groupDigits(count)} rows, more than the browser can hold (${groupDigits(MAX_SERIES)}).`);
      return seriesRows(A, S, Number(count), s, rt.dt === 'bigint', env);
    },
  },
  {
    name: 'OPENJSON', tvf: true, min: 1, max: 2,
    columns: openjsonColumns,
    rows(args, env, limit, ts = [], withSchema = null) {
      limit = scanRows(limit, env);
      if (args[0] == null || (args.length > 1 && args[1] == null)) return [];
      const text = sv(args[0], ts[0], env);
      const root = parseJson(text);
      const P = parsePath(args.length > 1 ? sv(args[1], ts[1], env) : '$', false);
      const node = walk(text, root, P.steps);
      if (!node) {
        if (P.strict) throw E13608();
        return [];
      }
      // A scalar: 13611 in strict mode, no rows in lax mode (01 §8).
      if (node.t !== 'o' && node.t !== 'a') {
        if (P.strict) throw E(13611);
        return [];
      }
      if (!withSchema) {
        checkLimit(node.kids.length, limit);
        return node.kids.map((kid, i) => {
          const v = node.t === 'o' ? kid.v : kid;
          return [node.t === 'o' ? keyText(text, kid) : String(i), jsonCell(text, v), JSON_TYPE[v.t]];
        });
      }
      const elems = node.t === 'a' ? node.kids : [node];
      checkLimit(elems.length, limit);
      const paths = withPaths(withSchema);
      const opts = { tz: env.tz, dateformat: env.dateformat, defLen: 1 };
      return elems.map(el => withSchema.map((c, ci) => {
        const p = paths[ci];
        const n = walk(text, el, p.steps);
        if (!n) {
          if (p.strict) throw E13608();
          return null;
        }
        if (c.asJson) {
          if (n.t === 'o' || n.t === 'a') return text.slice(n.s, n.e);
          if (p.strict) throw E(13624);
          return null;
        }
        if (n.t === 'o' || n.t === 'a') {
          if (p.strict) throw E(13623);
          return null;
        }
        const s = scalarText(text, n);
        return s == null ? null : castValue(s, NV, c.dataType, opts);
      }));
    },
  },
  {
    // sys.fn_helpcollations(): every collation of SQL_COLLATIONS (01 §8), no Dataverse request.
    name: 'FN_HELPCOLLATIONS', tvf: true, min: 0, max: 0,
    columns: () => [{ name: 'name', dt: 'string', len: 128, unicode: true }, { name: 'description', dt: 'string', len: 1000, unicode: true }],
    rows(args, env, limit) {
      limit = scanRows(limit, env);
      const all = sqlCollations();
      checkLimit(all.length, limit);
      return all.map(r => [r.name, r.description]);
    },
  },
  {
    name: 'STRING_SPLIT', tvf: true, min: 2, max: 3, consts: [2],
    columns: splitColumns,
    rows(args, env, limit, ts = []) {
      limit = scanRows(limit, env);
      if (args[1] == null) throw E214();
      const sep = sv(args[1], ts[1], env);
      if (sep.length !== 1) throw E214();
      const ord = args.length > 2 && args[2] != null && Number(args[2]) === 1;
      if (args.length > 2 && args[2] != null && Number(args[2]) !== 0 && !ord) throw E(4199, args[2], 3, 'string_split');
      if (args[0] == null) return [];
      const s = sv(args[0], ts[0], env);
      const fs = fold(s), f = foldCh(sep);
      const out = [];
      let start = 0;
      for (let i = 0; i <= s.length; i++) {
        if (i === s.length || fs[i] === f) {
          checkLimit(out.length + 1, limit);
          const v = s.slice(start, i);
          out.push(ord ? [v, out.length + 1] : [v]);
          start = i + 1;
        }
      }
      return out;
    },
  },
]);

// ------------------------------------------------------------------------------------------------- names

const SPECIAL_NAMES = ['GROUPING', 'GROUPING_ID', 'CAST', 'TRY_CAST', 'CONVERT', 'TRY_CONVERT'];

// Every built-in function name in upper case (editor highlighting and completion, 01 §8).
export const FUNCTION_NAMES = new Set([...SCALARS.keys(), ...AGGREGATES.keys(), ...WINDOWS.keys(), ...TVFS.keys(),
  ...FETCH_CONDITIONS.keys(), ...SPECIAL_NAMES]);

// The names of FUNCTION_NAMES that are written as a call NAME(...): all but AT_TIME_ZONE, which is the operator
// `x AT TIME ZONE zone` (a call written AT_TIME_ZONE(...) raises 195); for completion.
export const CALLABLE_NAMES = new Set([...FUNCTION_NAMES].filter(n => n !== 'AT_TIME_ZONE'));

// The per-row function of a scalar entry as compile.js uses it (01 §7, §8): entry.bind once when present, else the
// entry's eval with the static argument types. Callers use this (or entry.bindLazy) and never write the eval
// property in a call, which the bundle check rejects (04 §1.2).
export function bindScalar(entry, argTypes, consts, cx, node) {
  if (entry.bind) return entry.bind(argTypes, consts, cx, node);
  const f = entry.eval;
  return (args, env) => f(args, env, argTypes);
}

// Runs a window entry over one partition sorted by the window ORDER BY (01 §8 Window eval), for the same reason.
export function runWindow(entry, part, args, ctx) {
  const f = entry.eval;
  return f(part, args, ctx);
}

// Resolves a function call: {kind, entry}; 195 for unknown names (with did-you-mean), 174/189 for argument counts.
// AT_TIME_ZONE resolves only for the `x AT TIME ZONE zone` form (opts.atTimeZone); a call written AT_TIME_ZONE(…)
// raises 195, as SQL Server does.
export function lookupFunction(name, nargs, opts = {}) {
  const up = String(name).toUpperCase();
  let kind = 'scalar', entry = up === 'AT_TIME_ZONE' && !opts.atTimeZone ? undefined : SCALARS.get(up);
  if (!entry && (entry = AGGREGATES.get(up))) kind = 'aggregate';
  if (!entry && (entry = WINDOWS.get(up))) kind = 'window';
  if (!entry && (entry = TVFS.get(up))) kind = 'tvf';
  if (!entry && (entry = FETCH_CONDITIONS.get(up))) kind = 'fetch';
  if (!entry) {
    const written = opts.written != null ? String(opts.written) : String(name).toLowerCase();
    // Every name a call may be written with: the special forms (CAST, CONVERT, GROUPING, …, compiled by compile.js and
    // never resolved here) are did-you-mean candidates too, so CONVRT(int, x) is offered CONVERT (01 §2, §8).
    const names = [];
    for (const n of FUNCTION_NAMES) {
      if (n !== 'AT_TIME_ZONE') names.push(FETCH_CONDITIONS.has(n) ? FETCH_CONDITIONS.get(n).name : n);
    }
    // AT_TIME_ZONE is a real entry under another syntax: no did-you-mean for it.
    const sugg = up === 'AT_TIME_ZONE' ? [] : suggest(written, names);
    const e = E(195, written);
    if (sugg.length) e.message += ` Did you mean '${sugg[0]}'?`;
    e.suggestions = sugg;
    throw e;
  }
  let n = nargs;
  if (opts.star) {
    if (!entry.star) throw E(102, '*');
    n = 1;
  }
  if (n < entry.min || n > entry.max) {
    const lname = (kind === 'fetch' ? entry.name : up).toLowerCase();
    // A table-valued function: 313 for too few arguments, 8144 for too many (01 §8).
    if (kind === 'tvf') throw n < entry.min ? E(313, lname) : E(8144, lname);
    if (entry.min === entry.max) throw E(174, lname, entry.min);
    throw E(189, lname, entry.max === Infinity ? `at least ${entry.min}` : `${entry.min} to ${entry.max}`);
  }
  return { kind, entry };
}

// ------------------------------------------------------------------------------- function documentation (§8.2)
//
// One line per function: NAME|signature|summary|description of parameter 1|description of parameter 2|…, grouped
// under '# <Category>' lines. Parsed on the first docFor/docList call (never at module load).

const FUNCTION_DOCS = String.raw`
# String
ASCII|s|Returns the code page 1252 code (0-255) of the first character of s, or NULL when s is empty.|The text whose first character is converted.
BASE64_DECODE|expression|Returns the bytes that the base64 text expression encodes, as varbinary(max); the standard and the URL-safe alphabet are read.|The base64 text, with or without = padding; any other character raises an error.
BASE64_ENCODE|expression[, url_safe]|Returns the base64 text of the bytes of expression, as varchar(max).|A binary or varbinary value.|1 writes the URL-safe alphabet (- and _) without = padding; 0, the default, the standard alphabet.
CHAR|code|Returns the code page 1252 character with the given code, or NULL when code is outside 0-255.|An integer from 0 to 255.
CHARINDEX|find, s[, start]|Returns the 1-based position of find in s, or 0 when find does not occur.|The text to look for.|The text to search.|The position to start searching from; 0 or less means 1.
CONCAT|value1, value2[, ...]|Returns the values joined into one string; NULL values count as empty strings.|The first value; numbers and dates are converted to text.|The next value; up to 254 values in all.
CONCAT_WS|separator, value1, value2[, ...]|Returns the non-NULL values joined into one string with separator between them.|The text placed between values; NULL means no separator.|The first value; NULL values are skipped.|The next value; up to 253 values in all.
CONTAINS|column, search_condition|Returns true when the text contains the words or phrases of the search condition, or a multi-select column holds the values.|A text column or a multi-select choice column.|Words, "phrases" and "prefix*" terms combined with AND, OR, AND NOT and parentheses, e.g. 'red OR blue'.
DATALENGTH|expression|Returns the bytes expression uses, trailing spaces included and 2 per nvarchar character; xml: the UTF-16 bytes of its text (SQL Server: its binary size).|The value to measure.
DIFFERENCE|a, b|Returns 0 to 4: the number of the four SOUNDEX code positions at which a and b agree (4 means they sound alike).|The first text.|The second text.
FORMAT|value, format[, culture]|Returns value as text in a .NET format; non-en-US cultures use browser locale data, U and z use the session time zone, and R, X and real differ (see Help).|A number, date, datetime, datetime2, datetimeoffset or time value; real formats as float, and X formats smallint and tinyint as int.|A .NET format such as 'N2', 'C', 'yyyy-MM-dd' or 'hh\:mm'; an invalid one gives NULL; R may print 16 digits where SQL Server prints 17.|A culture name such as 'de-DE'; en-US by default (en-GB after SET LANGUAGE British).
LEFT|s, length|Returns the first length characters of s.|The text to take characters from.|How many characters to return; a negative length raises an error.
LEN|s|Returns the number of characters in s, not counting trailing spaces.|The text to measure.
LOWER|s|Returns s in lower case.|The text to convert.
LTRIM|s[, chars]|Returns s without leading spaces, or without the leading characters listed in chars.|The text to trim.|The characters to remove; without it only the space character is removed.
NCHAR|code|Returns the Unicode character with the given code point, or NULL when code is not a valid code point.|An integer from 0 to 1114111 (0x10FFFF).
PATINDEX|pattern, s|Returns the 1-based position of the first match of the LIKE pattern in s, or 0 when there is none.|A LIKE pattern, usually between % signs, e.g. '%[0-9]%'.|The text to search.
QUOTENAME|s[, quote]|Returns s as a delimited identifier, doubling the closing delimiter inside it.|The name to quote; more than 128 characters give NULL.|The delimiter: [ (the default), ', ", (, <, {, their closing forms or a backtick.
REPLACE|s, find, replacement|Returns s with every occurrence of find replaced by replacement, matching case-insensitively.|The text to change.|The text to look for.|The text to put in its place.
REPLICATE|s, count|Returns s repeated count times, or NULL when count is negative.|The text to repeat.|How many times to repeat it.
REVERSE|s|Returns the characters of s in reverse order.|The text to reverse.
RIGHT|s, length|Returns the last length characters of s.|The text to take characters from.|How many characters to return; a negative length raises an error.
RTRIM|s[, chars]|Returns s without trailing spaces, or without the trailing characters listed in chars.|The text to trim.|The characters to remove; without it only the space character is removed.
SOUNDEX|s|Returns the four-character American Soundex code of s, to find names that sound alike.|The text to encode; the code is built from its first run of letters.
SPACE|count|Returns a string of count spaces, or NULL when count is negative.|How many spaces to return.
STR|number[, length[, decimals]]|Returns number as right-aligned text of the given length, or asterisks when it does not fit.|The number to convert.|The total length of the result; 10 by default.|The number of digits after the decimal point; 0 by default, at most 16.
STRING_ESCAPE|s, type|Returns s with its special characters escaped for the given type.|The text to escape.|The escaping rules; only 'json' is supported.
STUFF|s, start, length, replacement|Returns s with length characters starting at start replaced by replacement.|The text to change.|The 1-based position of the first character to replace.|How many characters to delete; 0 inserts without deleting.|The text to insert.
SUBSTRING|s, start, length|Returns length characters of s starting at position start.|The text to take characters from.|The 1-based position of the first character; values below 1 shorten the result.|How many characters to return; a negative length raises an error.
TRANSLATE|s, characters, translations|Returns s with each character listed in characters replaced by the character at the same position in translations.|The text to change.|The characters to replace.|The replacement characters, exactly as many as in characters.
TRIM|[LEADING/TRAILING/BOTH] [chars FROM] s|Returns s without leading and/or trailing spaces, or without any of the characters in chars.|The characters to remove; without it only the space character is removed.|The text to trim.
UNICODE|s|Returns the Unicode code point of the first character of s.|The text whose first character is converted.
UPPER|s|Returns s in upper case.|The text to convert.

# Date and time
AT TIME ZONE|expression AT TIME ZONE zone|Returns expression as a datetimeoffset in zone; besides SQL Server's Windows zone names, IANA ids such as 'Europe/Berlin' work.|A datetime, datetime2, smalldatetime or datetimeoffset value; datetime values are read as the time the grid shows.|A time zone name such as 'UTC', 'Pacific Standard Time' or 'W. Europe Standard Time'.
DATEADD|datepart, number, date|Returns date with number dateparts added, in the type of date.|The unit to add: year, quarter, month, dayofyear, day, week, hour, minute, second, millisecond and smaller, or yy, mm, dd...|How many units to add; truncated toward zero; negative values subtract.|The date, datetime, datetime2, datetimeoffset or time value to change.
DATEDIFF|datepart, startdate, enddate|Returns the number of datepart boundaries crossed from startdate to enddate, as an int.|The unit to count: year, quarter, month, dayofyear, day, week, hour, minute, second, millisecond and smaller, or yy, mm, dd...|The start value.|The end value; the result is negative when it lies before startdate.
DATEDIFF_BIG|datepart, startdate, enddate|Returns the number of datepart boundaries crossed from startdate to enddate, as a bigint; results beyond ±2^53 lose precision.|The unit to count: year, quarter, month, dayofyear, day, week, hour, minute, second, millisecond, microsecond or nanosecond.|The start value.|The end value; the result is negative when it lies before startdate.
DATEFROMPARTS|year, month, day|Returns the date with the given year, month and day.|The year, 1 to 9999.|The month, 1 to 12.|The day of the month.
DATENAME|datepart, date|Returns the given part of date as text, e.g. 'January' for month or 'Friday' for weekday (always English).|The part to return: year, quarter, month, dayofyear, day, week, weekday, hour, minute, second, millisecond, iso_week, tzoffset...|The date or time value.
DATEPART|datepart, date|Returns the given part of date as an integer; weekday and week follow SET DATEFIRST.|The part to return: year, quarter, month, dayofyear, day, week, iso_week, weekday, hour, minute, second, millisecond, tzoffset...|The date or time value.
DATETIME2FROMPARTS|year, month, day, hour, minute, seconds, fractions, precision|Returns a datetime2(precision) built from its parts, digits below a millisecond included (100-ns ticks).|The year, 1 to 9999.|The month, 1 to 12.|The day of the month.|The hour, 0 to 23.|The minute, 0 to 59.|The seconds, 0 to 59.|The fraction of a second in units of 10 to the power -precision; below 10 to the power precision.|The number of fractional-second digits: an integer constant from 0 to 7.
DATETIMEFROMPARTS|year, month, day, hour, minute, seconds, milliseconds|Returns a datetime built from its parts.|The year, 1753 to 9999.|The month, 1 to 12.|The day of the month.|The hour, 0 to 23.|The minute, 0 to 59.|The seconds, 0 to 59.|The milliseconds, 0 to 999.
DATETRUNC|datepart, date|Returns date truncated to the start of the datepart that contains it, e.g. the first day of its month for month.|The unit: year, quarter, month, dayofyear, day, week, iso_week, hour, minute, second, millisecond or microsecond.|The date or time value.
DAY|date|Returns the day of the month of date (1 to 31).|The date value.
EOMONTH|date[, months]|Returns the last day of the month that contains date, optionally months later, as a date.|The date value.|The number of months to add first; negative values go back.
GETDATE||Returns the current date and time as a datetime; it is the same for every row of a statement.
GETUTCDATE||Returns the current UTC date and time as a datetime; it is the same for every row of a statement.
ISDATE|expression|Returns 1 when expression converts to a datetime, otherwise 0.|The text to test.
MONTH|date|Returns the month of date (1 to 12).|The date value.
SMALLDATETIMEFROMPARTS|year, month, day, hour, minute|Returns a smalldatetime built from its parts, with seconds 0.|The year, 1900 to 2079.|The month, 1 to 12.|The day of the month.|The hour, 0 to 23.|The minute, 0 to 59.
SYSDATETIME||Returns the current date and time as a datetime2(7) with milliseconds only (SQL Server: 100 ns); the same for every row of a statement.
SYSDATETIMEOFFSET||Returns the current date and time with the session's UTC offset, as a datetimeoffset(7) with milliseconds only (SQL Server: 100 ns).
SYSUTCDATETIME||Returns the current UTC date and time as a datetime2(7) with milliseconds only (SQL Server: 100 ns); the same for every row of a statement.
TIMEFROMPARTS|hour, minute, seconds, fractions, precision|Returns a time(precision) built from its parts.|The hour, 0 to 23.|The minute, 0 to 59.|The seconds, 0 to 59.|The fraction of a second in units of 10 to the power -precision; below 10 to the power precision.|The number of fractional-second digits: an integer constant from 0 to 7.
YEAR|date|Returns the year of date.|The date value.

# Math
ABS|number|Returns the absolute value of number: int or bigint as given, decimal(38, s) for decimals, money for money and smallmoney, float otherwise.|A numeric value.
ACOS|number|Returns the angle in radians whose cosine is number.|A value from -1 to 1.
ASIN|number|Returns the angle in radians whose sine is number.|A value from -1 to 1.
ATAN|number|Returns the angle in radians whose tangent is number.|A numeric value.
ATN2|y, x|Returns the angle in radians between the positive x-axis and the line to the point (x, y).|The y coordinate.|The x coordinate.
CEILING|number|Returns the smallest integer greater than or equal to number, in the type of number.|A numeric value.
COS|angle|Returns the cosine of angle.|An angle in radians.
COT|angle|Returns the cotangent of angle.|An angle in radians, not 0.
DEGREES|angle|Returns angle converted from radians to degrees.|An angle in radians.
EXP|number|Returns e raised to the power number.|The exponent.
FLOOR|number|Returns the largest integer less than or equal to number, in the type of number.|A numeric value.
LOG|number[, base]|Returns the natural logarithm of number, or its logarithm to base.|A positive number.|The base of the logarithm; e by default.
LOG10|number|Returns the base-10 logarithm of number.|A positive number.
PI||Returns the constant pi, 3.14159265358979.
POWER|number, exponent|Returns number raised to exponent: int or bigint as given, decimal(38, s) for decimals, money for money and smallmoney, float otherwise.|The base.|The exponent.
RADIANS|angle|Returns angle converted from degrees to radians.|An angle in degrees.
RAND|[seed]|Returns a pseudo-random float from 0 up to 1, the same for every row of a statement.|An integer that restarts the sequence; the same seed gives the same values.
ROUND|number, length[, function]|Returns number rounded half away from zero to length decimal places, in the type of number.|The value to round.|The number of decimal places; negative values round to the left of the decimal point.|Any value other than 0 truncates instead of rounding.
SIGN|number|Returns -1, 0 or 1 for a negative, zero or positive number, in the type of number.|A numeric value.
SIN|angle|Returns the sine of angle.|An angle in radians.
SQRT|number|Returns the square root of number as a float.|A number that is not negative.
SQUARE|number|Returns number multiplied by itself, as a float.|A numeric value.
TAN|angle|Returns the tangent of angle.|An angle in radians.

# Logical and null
CHOOSE|index, value1[, ...]|Returns the value at position index in the list, or NULL when index is out of range.|The 1-based position of the value to return.|A value to choose from; add as many as you need.
COALESCE|value1, value2[, ...]|Returns the first of the values that is not NULL.|The first value to test.|The next value to test; add as many as you need.
GREATEST|value1[, ...]|Returns the largest of the values, ignoring NULLs.|A value to compare; up to 254 values.
IIF|condition, true_value, false_value|Returns true_value when condition is true, otherwise false_value.|A condition such as a > b.|The value when condition is true.|The value when condition is false or NULL.
ISNULL|expression, replacement|Returns expression, or replacement when expression is NULL, in the type of expression.|The value to test.|The value to use instead of NULL.
LEAST|value1[, ...]|Returns the smallest of the values, ignoring NULLs.|A value to compare; up to 254 values.
NULLIF|expression1, expression2|Returns NULL when the two values are equal, otherwise expression1.|The value to return.|The value that turns the result into NULL.

# Conversion
CAST|expression AS data_type|Returns expression converted to data_type; raises an error when it cannot be converted.|The value to convert.|The target type, e.g. int, decimal(10,2), nvarchar(100), date or datetime2.
CONVERT|data_type, expression[, style]|Returns expression converted to data_type, using style for the text form of dates, times, money and float.|The target type, e.g. int, varchar(30) or date.|The value to convert.|A style number: 101, 103, 112, 120 or 126 for dates, for example, and 0, 1 or 2 for money and float.
CREATEELASTICLOOKUP|table, id, partitionid|Returns id as a lookup to a record of the elastic table with its partition id, for writing elastic lookup columns (as in SQL 4 CDS).|The logical name of the elastic target table.|The id (a GUID) of the record.|The partition id of the record.
CREATELOOKUP|table, id|Returns id as a lookup to a record of table, for writing polymorphic lookup columns (as in SQL 4 CDS); not for elastic tables.|The logical name of the target table, e.g. 'account'.|The id (a GUID) of the record.
ISNUMERIC|expression|Returns 1 when expression is a number or text that converts to a numeric type, otherwise 0.|The value to test.
TRY_CAST|expression AS data_type|Returns expression converted to data_type, or NULL when it cannot be converted.|The value to convert.|The target type, e.g. int, decimal(10,2), nvarchar(100), date or datetime2.
TRY_CONVERT|data_type, expression[, style]|Returns expression converted to data_type with style, or NULL when it cannot be converted.|The target type, e.g. int, varchar(30) or date.|The value to convert.|A style number: 101, 103, 112, 120 or 126 for dates, for example, and 0, 1 or 2 for money and float.

# JSON
ISJSON|expression[, json_type]|Returns 1 when expression is valid JSON of the given type, 0 when it is not, and NULL for NULL.|The text to test.|VALUE (any JSON value), ARRAY, OBJECT or SCALAR (a string or number); without it only an object or array gives 1.
JSON_MODIFY|expression, path, new_value|Returns the JSON text with the value at path replaced, added, appended or, for NULL, removed.|The JSON text to change.|A JSON path such as '$.name', optionally starting with append and lax or strict.|The new value; text is stored as a JSON string, JSON_QUERY results as JSON.
JSON_PATH_EXISTS|expression, path|Returns 1 when path exists in the JSON text, otherwise 0, also when the text or the path is not valid; NULL for a NULL argument.|The JSON text.|A JSON path such as '$.address.city'.
JSON_QUERY|expression[, path]|Returns the object or array at path in the JSON text, as JSON.|The JSON text.|A JSON path; '$', the whole text, by default.
JSON_VALUE|expression, path|Returns the scalar value at path in the JSON text, as text.|The JSON text.|A JSON path such as '$.name' or '$.items[0].price'.

# XML
xml.value|path, type|Returns the value of the first node path matches, converted to type, or NULL; SQL Server raises an error when path may match several nodes or for a string.|An XQuery path literal such as '(/fetch/entity/@name)[1]'; sql:column("c") and sql:variable("@v") read SQL values.|The SQL type of the result as a literal, e.g. 'nvarchar(100)' or 'int'; xml, text and sql_variant are invalid.
xml.query|path|Returns the nodes path matches as an xml fragment in document order; text values become text nodes; a string works too, unlike SQL Server.|An XQuery path literal such as '/fetch/entity/attribute'; an attribute alone raises an error.
xml.exist|path|Returns 1 when path matches a node or gives a value other than false or an empty string or binary, else 0 (SQL Server: 1 for any value, on xml only).|An XQuery path literal such as '/fetch/entity[@name = "account"]'.
xml.nodes|path|Returns one row per node path matches, as in CROSS APPLY x.nodes(path) AS t(c); c.value() and c.query() read each node; a string works too, unlike SQL Server.|An XQuery path literal such as '/fetch/entity/attribute'.
xml.modify|dml|Returns nothing: XML DML is not supported, as in SQL 4 CDS; build the new text with string functions and CAST it to xml.|The XML DML statement; every call raises an error.

# System and errors
APP_NAME||Returns the name of this application, 'SQL Studio'.
COLLATIONPROPERTY|collation_name, property|Returns a property of a collation as a sql_variant, or NULL for an unknown collation or property.|A collation name such as 'Latin1_General_CI_AI'.|The property: 'CodePage', 'LCID', 'ComparisonStyle' or 'Version'.
CURRENT_USER||Returns the systemuserid of the effective user (the impersonated user after EXECUTE AS).
DB_NAME||Returns the unique name of the Dataverse organization.
ERROR_LINE||Returns the line number of the error that started the CATCH block, or NULL outside a CATCH block.
ERROR_MESSAGE||Returns the message of the error that started the CATCH block, or NULL outside a CATCH block.
ERROR_NUMBER||Returns the number of the error that started the CATCH block; Dataverse faults get SQL 4 CDS's numbers such as 2627 or 547.
ERROR_PROCEDURE||Returns the procedure name of the error that started the CATCH block; NULL in a script.
ERROR_SEVERITY||Returns the severity of the error that started the CATCH block, or NULL outside a CATCH block.
ERROR_STATE||Returns the state of the error that started the CATCH block, or NULL outside a CATCH block.
FORMATMESSAGE|message[, argument[, ...]]|Returns message with its %s, %d and other placeholders replaced by the arguments, as RAISERROR does.|The message text with printf-style placeholders; a message number is not supported.|The value for the next placeholder; up to 20 arguments.
HOST_NAME||Returns the host name of the Dataverse environment.
NEWID||Returns a new random uniqueidentifier, a different one for every row.
SERVERPROPERTY|property|Returns information about the environment as a sql_variant, e.g. its Collation, Edition or ProductVersion; NULL for an unknown name.|A property such as 'Collation', 'LCID', 'Edition', 'EditionID', 'EngineEdition', 'ProductVersion', 'ServerName' or 'MachineName'.
SQL_VARIANT_PROPERTY|expression, property|Returns a property of the base type of a sql_variant value; tinyint and smallint report int and real reports float.|The sql_variant value (any other value is converted to sql_variant).|'BaseType', 'Precision', 'Scale', 'TotalBytes', 'Collation' or 'MaxLength'.
SUSER_NAME||Returns the full name of the effective user.
USER_NAME||Returns the systemuserid of the effective user as a lookup to systemuser, as SQL 4 CDS does (SQL Server returns a name).

# Aggregate
APPROX_COUNT_DISTINCT|expression|Returns the exact number of distinct non-NULL values (SQL Server returns an estimate).|The values to count.
AVG|[ALL/DISTINCT] expression|Returns the average of the non-NULL values, or NULL when there are none; integer input gives an integer.|The numeric values; DISTINCT averages each distinct value once.
COUNT|[ALL/DISTINCT] expression|Returns the number of rows as an int: COUNT(*) counts every row, COUNT(expression) the non-NULL values.|The values to count, or * for every row; DISTINCT counts each distinct value once.
COUNT_BIG|[ALL/DISTINCT] expression|Returns the number of rows as a bigint: COUNT_BIG(*) counts every row, COUNT_BIG(expression) the non-NULL values.|The values to count, or * for every row; DISTINCT counts each distinct value once.
GROUPING|column|Returns 1 when column is aggregated in the row (a ROLLUP, CUBE or GROUPING SETS total), otherwise 0.|A GROUP BY column.
GROUPING_ID|column1[, ...]|Returns the GROUPING bits of the columns as one integer, with the first column as the highest bit.|A GROUP BY column; add as many as you need.
MAX|[ALL/DISTINCT] expression|Returns the largest non-NULL value, or NULL when there is none.|The values to compare.
MIN|[ALL/DISTINCT] expression|Returns the smallest non-NULL value, or NULL when there is none.|The values to compare.
STDEV|[ALL/DISTINCT] expression|Returns the sample standard deviation of the non-NULL values, or NULL for fewer than two values.|The numeric values.
STDEVP|[ALL/DISTINCT] expression|Returns the population standard deviation of the non-NULL values.|The numeric values.
STRING_AGG|(expression, separator) [WITHIN GROUP (ORDER BY order_list)]|Returns the non-NULL values joined with separator, in the WITHIN GROUP order when it is given.|The values to join, converted to text.|The text placed between values.|The sort order of the values, e.g. name or createdon DESC.
SUM|[ALL/DISTINCT] expression|Returns the sum of the non-NULL values, or NULL when there are none; bigint sums beyond ±2^53 lose precision.|The numeric values; DISTINCT adds each distinct value once.
VAR|[ALL/DISTINCT] expression|Returns the sample variance of the non-NULL values, or NULL for fewer than two values.|The numeric values.
VARP|[ALL/DISTINCT] expression|Returns the population variance of the non-NULL values.|The numeric values.

# Window
CUME_DIST|() OVER ([PARTITION BY partition_list] ORDER BY order_list)|Returns the cumulative distribution of the row: the share of the rows of its partition ordered at or before it.|The columns that split the rows into partitions; without it all rows form one partition.|The order of the rows within each partition.
DENSE_RANK|() OVER ([PARTITION BY partition_list] ORDER BY order_list)|Returns the rank of the row in its partition without gaps: ties share a rank and the next rank follows directly.|The columns that split the rows into partitions; without it all rows form one partition.|The order that decides the rank.
FIRST_VALUE|(expression) OVER ([PARTITION BY partition_list] ORDER BY order_list [frame])|Returns expression from the first row of the window frame.|The value to return.|The columns that split the rows into partitions; without it all rows form one partition.|The order of the rows within each partition.|ROWS or RANGE and the frame bounds, e.g. ROWS BETWEEN 2 PRECEDING AND CURRENT ROW.
LAG|(expression[, offset[, default]]) OVER ([PARTITION BY partition_list] ORDER BY order_list)|Returns expression from the row offset rows before the current row in its partition, or default when there is none.|The value to return.|How many rows back to look; 1 by default.|The value when there is no such row; NULL by default.|The columns that split the rows into partitions; without it all rows form one partition.|The order of the rows within each partition.
LAST_VALUE|(expression) OVER ([PARTITION BY partition_list] ORDER BY order_list [frame])|Returns expression from the last row of the window frame, by default the last peer of the current row.|The value to return.|The columns that split the rows into partitions; without it all rows form one partition.|The order of the rows within each partition.|ROWS or RANGE and the frame bounds, e.g. ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING.
LEAD|(expression[, offset[, default]]) OVER ([PARTITION BY partition_list] ORDER BY order_list)|Returns expression from the row offset rows after the current row in its partition, or default when there is none.|The value to return.|How many rows ahead to look; 1 by default.|The value when there is no such row; NULL by default.|The columns that split the rows into partitions; without it all rows form one partition.|The order of the rows within each partition.
NTILE|(n) OVER ([PARTITION BY partition_list] ORDER BY order_list)|Returns the number (1 to n) of the group the row falls in when its partition is split into n groups of nearly equal size.|The number of groups, a positive integer.|The columns that split the rows into partitions; without it all rows form one partition.|The order that fills the groups.
PERCENT_RANK|() OVER ([PARTITION BY partition_list] ORDER BY order_list)|Returns the relative rank of the row in its partition from 0 to 1: (rank - 1) / (rows - 1).|The columns that split the rows into partitions; without it all rows form one partition.|The order that decides the rank.
RANK|() OVER ([PARTITION BY partition_list] ORDER BY order_list)|Returns the rank of the row in its partition: ties share a rank and leave a gap after them.|The columns that split the rows into partitions; without it all rows form one partition.|The order that decides the rank.
ROW_NUMBER|() OVER ([PARTITION BY partition_list] ORDER BY order_list)|Returns the sequential number of the row in its partition, starting at 1.|The columns that split the rows into partitions; numbering restarts in each one.|The order in which the rows are numbered.

# Table-valued
FN_HELPCOLLATIONS|()|Returns every collation name with its description, as SELECT * FROM sys.fn_helpcollations() reads them.
GENERATE_SERIES|start, stop[, step]|Returns a table with one column, value, holding the numbers from start to stop in increments of step.|The first value.|The last value; included when a step lands on it.|The increment; 1 or -1 by default, never 0.
OPENJSON|(json[, path]) [WITH (schema)]|Returns the properties or elements of a JSON object or array as rows of key, value and type, or of the WITH columns.|The JSON text.|A JSON path to the object or array to open; '$' by default.|Column definitions separated by commas: name type ['path'] [AS JSON].
STRING_SPLIT|string, separator[, enable_ordinal]|Returns a table with one row per piece of string between separators, in the column value.|The text to split.|The single character that separates the pieces.|1 adds the column ordinal with each piece's position; a constant 0 or 1.

# FetchXML conditions
yesterday||Condition for column = yesterday(): the date is yesterday, in your Dataverse time zone.
today||Condition for column = today(): the date is today, in your Dataverse time zone.
tomorrow||Condition for column = tomorrow(): the date is tomorrow, in your Dataverse time zone.
lastsevendays||Condition for column = lastsevendays(): the date lies in the last seven days up to now, in your Dataverse time zone.
nextsevendays||Condition for column = nextsevendays(): the date lies in the next seven days from now, in your Dataverse time zone.
lastweek||Condition for column = lastweek(): the date lies in the previous week, in your Dataverse time zone.
thisweek||Condition for column = thisweek(): the date lies in the current week, in your Dataverse time zone.
nextweek||Condition for column = nextweek(): the date lies in the next week, in your Dataverse time zone.
lastmonth||Condition for column = lastmonth(): the date lies in the previous month, in your Dataverse time zone.
thismonth||Condition for column = thismonth(): the date lies in the current month, in your Dataverse time zone.
nextmonth||Condition for column = nextmonth(): the date lies in the next month, in your Dataverse time zone.
lastyear||Condition for column = lastyear(): the date lies in the previous year, in your Dataverse time zone.
thisyear||Condition for column = thisyear(): the date lies in the current year, in your Dataverse time zone.
nextyear||Condition for column = nextyear(): the date lies in the next year, in your Dataverse time zone.
lastxhours|n|Condition for column = lastxhours(n): the date lies in the last n hours up to now.|The number of hours, a positive integer.
nextxhours|n|Condition for column = nextxhours(n): the date lies in the next n hours from now.|The number of hours, a positive integer.
lastxdays|n|Condition for column = lastxdays(n): the date lies in the last n days up to now, in your Dataverse time zone.|The number of days, a positive integer.
nextxdays|n|Condition for column = nextxdays(n): the date lies in the next n days from now, in your Dataverse time zone.|The number of days, a positive integer.
lastxweeks|n|Condition for column = lastxweeks(n): the date lies in the last n weeks up to now, in your Dataverse time zone.|The number of weeks, a positive integer.
nextxweeks|n|Condition for column = nextxweeks(n): the date lies in the next n weeks from now, in your Dataverse time zone.|The number of weeks, a positive integer.
lastxmonths|n|Condition for column = lastxmonths(n): the date lies in the last n months up to now, in your Dataverse time zone.|The number of months, a positive integer.
nextxmonths|n|Condition for column = nextxmonths(n): the date lies in the next n months from now, in your Dataverse time zone.|The number of months, a positive integer.
lastxyears|n|Condition for column = lastxyears(n): the date lies in the last n years up to now, in your Dataverse time zone.|The number of years, a positive integer.
nextxyears|n|Condition for column = nextxyears(n): the date lies in the next n years from now, in your Dataverse time zone.|The number of years, a positive integer.
olderthanxminutes|n|Condition for column = olderthanxminutes(n): the date lies more than n minutes before now.|The number of minutes, a positive integer.
olderthanxhours|n|Condition for column = olderthanxhours(n): the date lies more than n hours before now.|The number of hours, a positive integer.
olderthanxdays|n|Condition for column = olderthanxdays(n): the date lies more than n days before now, in your Dataverse time zone.|The number of days, a positive integer.
olderthanxweeks|n|Condition for column = olderthanxweeks(n): the date lies more than n weeks before now, in your Dataverse time zone.|The number of weeks, a positive integer.
olderthanxmonths|n|Condition for column = olderthanxmonths(n): the date lies more than n months before now, in your Dataverse time zone.|The number of months, a positive integer.
olderthanxyears|n|Condition for column = olderthanxyears(n): the date lies more than n years before now, in your Dataverse time zone.|The number of years, a positive integer.
on|date|Condition for column = on(date): the date falls on that calendar day, in your Dataverse time zone.|The day to match, e.g. '2024-01-05'; a time part is ignored.
onorbefore|date|Condition for column = onorbefore(date): the date falls on or before that calendar day, in your Dataverse time zone.|The last day to match, e.g. '2024-01-05'; a time part is ignored.
onorafter|date|Condition for column = onorafter(date): the date falls on or after that calendar day, in your Dataverse time zone.|The first day to match, e.g. '2024-01-05'; a time part is ignored.
thisfiscalyear||Condition for column = thisfiscalyear(): the date lies in the current fiscal year of your organization.
thisfiscalperiod||Condition for column = thisfiscalperiod(): the date lies in the current fiscal period of your organization.
nextfiscalyear||Condition for column = nextfiscalyear(): the date lies in the next fiscal year of your organization.
nextfiscalperiod||Condition for column = nextfiscalperiod(): the date lies in the next fiscal period of your organization.
lastfiscalyear||Condition for column = lastfiscalyear(): the date lies in the previous fiscal year of your organization.
lastfiscalperiod||Condition for column = lastfiscalperiod(): the date lies in the previous fiscal period of your organization.
lastxfiscalyears|n|Condition for column = lastxfiscalyears(n): the date lies in the last n fiscal years.|The number of fiscal years, a positive integer.
lastxfiscalperiods|n|Condition for column = lastxfiscalperiods(n): the date lies in the last n fiscal periods.|The number of fiscal periods, a positive integer.
nextxfiscalyears|n|Condition for column = nextxfiscalyears(n): the date lies in the next n fiscal years.|The number of fiscal years, a positive integer.
nextxfiscalperiods|n|Condition for column = nextxfiscalperiods(n): the date lies in the next n fiscal periods.|The number of fiscal periods, a positive integer.
infiscalyear|year|Condition for column = infiscalyear(year): the date lies in the given fiscal year.|The fiscal year, e.g. 2024.
infiscalperiod|period|Condition for column = infiscalperiod(period): the date lies in the given fiscal period of any fiscal year.|The fiscal period number, e.g. 1 for the first month or quarter of the fiscal year.
infiscalperiodandyear|period, year|Condition for column = infiscalperiodandyear(period, year): the date lies in that fiscal period of that fiscal year.|The fiscal period number.|The fiscal year.
inorbeforefiscalperiodandyear|period, year|Condition for column = inorbeforefiscalperiodandyear(period, year): the date lies in or before that fiscal period.|The fiscal period number.|The fiscal year.
inorafterfiscalperiodandyear|period, year|Condition for column = inorafterfiscalperiodandyear(period, year): the date lies in or after that fiscal period.|The fiscal period number.|The fiscal year.
equserid||Condition for column = equserid(): the lookup is the current user.
neuserid||Condition for column = neuserid(): the lookup is set and is not the current user.
equserteams||Condition for column = equserteams(): the lookup is a team the current user belongs to.
equseroruserteams||Condition for column = equseroruserteams(): the lookup is the current user or a team they belong to.
equseroruserhierarchy||Condition for column = equseroruserhierarchy(): the lookup is the current user or a user below them in the hierarchy.
equseroruserhierarchyandteams||Condition for column = equseroruserhierarchyandteams(): the current user, a user below them, or a team of those users.
eqbusinessid||Condition for column = eqbusinessid(): the lookup is the business unit of the current user.
nebusinessid||Condition for column = nebusinessid(): the lookup is set and is not the business unit of the current user.
equserlanguage||Condition for column = equserlanguage(): the language column equals the current user's language.
beginswith|value|Condition for column = beginswith(value): the text starts with value.|The text the column starts with.
notbeginwith|value|Condition for column = notbeginwith(value): the text is set and does not start with value.|The text the column must not start with.
endswith|value|Condition for column = endswith(value): the text ends with value.|The text the column ends with.
notendwith|value|Condition for column = notendwith(value): the text is set and does not end with value.|The text the column must not end with.
under|id|Condition for column = under(id): the record lies below the record id in the table's hierarchy.|The id of the ancestor record.
eqorunder|id|Condition for column = eqorunder(id): the record is the record id or lies below it in the table's hierarchy.|The id of the ancestor record.
notunder|id|Condition for column = notunder(id): the record is set and does not lie below the record id in the table's hierarchy.|The id of the ancestor record.
above|id|Condition for column = above(id): the record lies above the record id (is one of its ancestors) in the table's hierarchy.|The id of the descendant record.
eqorabove|id|Condition for column = eqorabove(id): the record is the record id or one of its ancestors in the table's hierarchy.|The id of the descendant record.
containvalues|value1[, ...]|Condition for column = containvalues(...): the multi-select choice column holds at least one of the values.|A choice value (an integer); add as many as you need.
notcontainvalues|value1[, ...]|Condition for column = notcontainvalues(...): the multi-select choice column is set and holds none of the values.|A choice value (an integer); add as many as you need.
`;

let docsCache = null;

// Parameters of a signature (§8.2 grammar): lower-case identifiers, optional inside [ ], `...` repeating the one
// before it. In a signature that starts with '(' only the first parenthesised group lists the call's arguments;
// the parameters after it belong to clauses (OVER, WITHIN GROUP, WITH) and are marked clause: true.
function parseSignature(sig) {
  const params = [];
  const seen = new Set();
  let argEnd = sig.length;
  if (sig[0] === '(') {
    let depth = 0;
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] === '(') depth++;
      else if (sig[i] === ')' && --depth === 0) { argEnd = i; break; }
    }
  }
  let depth = 0;
  const re = /\.\.\.|[A-Za-z_][A-Za-z0-9_]*|[[\]]/g;
  let m;
  while ((m = re.exec(sig))) {
    const tok = m[0];
    if (tok === '[') depth++;
    else if (tok === ']') depth--;
    else if (tok === '...') {
      if (params.length) params[params.length - 1].repeat = true;
    } else if (/^[a-z_][a-z0-9_]*$/.test(tok) && !seen.has(tok)) {
      seen.add(tok);
      params.push({ name: tok, desc: '', optional: depth > 0, repeat: false, clause: m.index > argEnd });
    }
  }
  return params;
}

// How a doc entry is shown: NAME(signature), NAME + a signature that starts with '(', or a spaced name's signature
// alone; '/' between upper-case words shows as ' | '.
function docDisplay(name, sig) {
  const s = sig.replace(/([A-Z])\/(?=[A-Z])/g, '$1 | ');
  return name.includes(' ') ? s : sig[0] === '(' ? name + s : `${name}(${s})`;
}

function functionDocs() {
  if (docsCache) return docsCache;
  const list = [];
  const byName = new Map();
  let category = '';
  for (const raw of FUNCTION_DOCS.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '#') {
      category = line.slice(1).trim();
      continue;
    }
    const [name, sig, summary, ...descs] = line.split('|');
    const params = parseSignature(sig);
    params.forEach((p, i) => { p.desc = descs[i] ?? ''; Object.freeze(p); });
    const doc = Object.freeze({ name, category, sig, display: docDisplay(name, sig), summary, params: Object.freeze(params) });
    list.push(doc);
    byName.set(name.toUpperCase(), doc);
  }
  const atz = byName.get('AT TIME ZONE');
  if (atz) byName.set('AT_TIME_ZONE', atz);
  docsCache = { list: Object.freeze(list), byName };
  return docsCache;
}

// Documentation of a built-in function, case-insensitive (FetchXML condition names and 'AT TIME ZONE' / AT_TIME_ZONE
// too): {name, category, sig, display, summary, params: [{name, desc, optional, repeat, clause}]}, or null.
export function docFor(name) {
  if (typeof name !== 'string') return null;
  return functionDocs().byName.get(name.trim().replace(/\s+/g, ' ').toUpperCase()) || null;
}

// Every function's documentation in table order (by category, as the Help function reference lists them).
export function docList() {
  return functionDocs().list;
}

// The parameter documented for the argIndex-th argument (0-based) of a call; past the end, the repeatable one.
// With opts ({keyword, keywordAfter}, see the notes at the top of this file) argIndex counts comma-separated arguments and the
// keywords written at the call's depth pick the parameter inside one: CAST(x AS |) -> data_type, TRIM(s) -> s.
export function paramAt(doc, argIndex, opts) {
  if (!doc || !Array.isArray(doc.params) || !Number.isInteger(argIndex) || argIndex < 0) return null;
  if (opts != null && typeof opts === 'object' && typeof doc.sig === 'string') return keywordParamAt(doc, argIndex, opts);
  let i = 0, repeat = null;
  for (const p of doc.params) {
    if (p.clause) continue;
    if (i++ === argIndex) return p;
    if (p.repeat) repeat = p;
  }
  return repeat;
}

const kwCache = new WeakMap();

// The argument parameters of a doc with their comma segment, the upper-case keywords written directly before them
// (`after`, a Set; '/' alternatives and multi-word keywords add every word) and the keyword directly after them
// (`before`). Brackets do not separate: in '[chars FROM] s', chars is before FROM and s after it.
function keywordParams(doc) {
  let list = kwCache.get(doc);
  if (list) return list;
  list = [];
  const sig = doc.sig;
  let from = 0, to = sig.length;
  if (sig[0] === '(') {
    from = 1;
    for (let i = 0, depth = 0; i < sig.length; i++) {
      if (sig[i] === '(') depth++;
      else if (sig[i] === ')' && --depth === 0) { to = i; break; }
    }
  }
  const byName = new Map();
  for (const p of doc.params) if (!p.clause) byName.set(p.name, p);
  const re = /\.\.\.|[A-Za-z_][A-Za-z0-9_]*|,/g;
  re.lastIndex = from;
  let seg = 0, kws = [], last = null, m;
  while ((m = re.exec(sig)) && m.index < to) {
    const tok = m[0];
    if (tok === ',') {
      seg++;
      kws = [];
      last = null;
    } else if (/^[A-Z][A-Z0-9_]*$/.test(tok)) {
      if (last && last.before == null) last.before = tok;
      last = null;
      kws.push(tok);
    } else if (byName.has(tok) && !list.some(x => x.p.name === tok)) {
      last = { p: byName.get(tok), seg, after: kws.length ? new Set(kws) : null, before: null };
      list.push(last);
      kws = [];
    }
  }
  kwCache.set(doc, list);
  return list;
}

// paramAt with opts: the comma segment argIndex, then the keyword rules of the notes at the top of this file.
function keywordParamAt(doc, argIndex, opts) {
  const list = keywordParams(doc);
  const norm = k => (typeof k === 'string' ? k.trim().toUpperCase().split(/\s+/) : ['']);
  const inSeg = list.filter(x => x.seg === argIndex);
  if (!inSeg.length) {
    for (let i = list.length - 1; i >= 0; i--) if (list[i].p.repeat) return list[i].p;
    return null;
  }
  const kw = norm(opts.keyword).pop();
  if (kw) {
    const hit = inSeg.find(x => x.after && x.after.has(kw));
    if (hit) return hit.p;
  }
  const ka = norm(opts.keywordAfter)[0];
  if (ka) {
    const hit = inSeg.find(x => x.before === ka);
    if (hit) return hit.p;
  }
  return (inSeg.find(x => !x.p.optional) || inSeg[0]).p;
}
