// Value model, static types, coercion, comparison, collation (SQL_COLLATIONS), hashing, CAST/CONVERT, date parsing
// and formatting, time zones (WIN_ZONES, zoneTz, atTimeZone), binary values, sql_variant, xml values and FOR JSON
// value encoding. 01 §5 (value model, exports), §5.1-§5.8; 02 §4.2/§5 (DateTimeBehavior
// mapping, binary constants). Pure: no DOM. Local calendar fields come only from tz.offset(ms) (01 §5.3); the only
// Intl time-zone use is zoneTz, which names its IANA zone explicitly. Large tables (WIN_ZONES, SQL_COLLATIONS, LCID
// locales) are strings parsed on first use. Numbered errors take their text and severity from messages.js MESSAGES;
// xml text is parsed only with core/xml.js parseXml.
//
// Notes:
// - dtOf('entityreference') (any case) is {dt: 'guid', entityref: true}: the flag tells compile.js to keep the
//   assigned value's `ref`; commonType, arithType and every other derived Type drop it, and typeName,
//   dataTypeOf and msgTypeName say uniqueidentifier.
// - literalType('0x…') is {dt: 'binary', len: <bytes>} without `fixed` (varbinary(n), at least 1), as SQL Server types
//   the literal (SQL_VARIANT_PROPERTY(0x01, 'BaseType') = 'varbinary'; unlike 01 §4.4, which says binary(n)), so `0x01 UNION SELECT 0x0102` keeps 0x01 unpadded.
// - numeric (04 §2.1): Types carry `numeric: true` for numeric(p,s) declarations and
//   for decimal literals (literalType: `20.0`, an integer beyond the int range), so SQL_VARIANT_PROPERTY(CAST(20.0 AS
//   sql_variant), 'BaseType') can say 'numeric' while CONVERT(decimal(28,8), …) says 'decimal' (functions.js reads
//   the flag of variantType(v)). pickType, variant and variantType keep it (it is one of the Type fields); commonType,
//   arithType, arithOp and unaryOp give a decimal result `numeric: true` exactly when every decimal operand has it
//   (`1 + 1.5` and `1.5 UNION 2.25` stay numeric, numeric with decimal(p,s) is decimal). dtOf(DataType 'numeric')
//   sets it and dataTypeOf gives the DataType name 'numeric' for it (SELECT INTO keeps it); typeName, msgTypeName and
//   every conversion are unchanged (decimal(p,s), 'numeric' in messages as before).
// - Type names: binary(n) and varbinary(n) allow 1..8000 (1001, 131), binary(max) raises 102 near 'max'; binary(n)
//   carries `fixed: true` (padded with 0x00 like char(n) with spaces). The synonym binary varying (= varbinary) is
//   accepted with the 01 §4.1 ones.
// - Binary conversions beyond the 01 §5.4 list: date and time types ↔ binary raise 529 (explicit) / 206 (implicit)
//   (SQL Server would convert their internal byte layout; like decimal and money, a documented deviation); an implicit string → binary conversion (an assignment) raises 257, as SQL Server; binary styles are 0, 1
//   and 2 only (281 `<n> is not a valid style number when converting from varbinary to a character string.` /
//   `… converting to varbinary.`); binary → uniqueidentifier reads the first 16 bytes (a shorter value padded with
//   0x00); binary → bit is 1 when the last byte is not 0x00; int-family → binary writes 4 bytes for every int-typed
//   value (tinyint and smallint share the static type int), 8 for bigint and 1 for bit. In arithmetic a binary
//   operand converts to the other operand's int-family or bit type (`0x01 + 1` = 2, `0x0F & 1`), binary + binary
//   concatenates, string + binary concatenates the decoded text, binary with decimal, money, float or datetime raises
//   206 and binary with date, time, datetime2 or datetimeoffset 402 (`&`, `|`, `^`: 402). toServer writes bytes as
//   base64.
// - Arithmetic operand errors beyond the 01 §2.1 rows, as SQL Server: uniqueidentifier with a string or binary operand
//   raises 402 (`The data types varchar and uniqueidentifier are incompatible in the add operator.`), with itself 8117
//   and with any other type 206 (`Operand type clash: uniqueidentifier is incompatible with int`); date, time,
//   datetime2 and datetimeoffset with a string, binary or another date/time type raise 402 (`The data types date and
//   time are incompatible in the add operator.`), with their own type 8117 and with a number 206 (+, -) or 8117
//   (*, /, %).
// - coerce pads to a fixed-length target (char(n), nchar(n) with spaces, binary(n) with 0x00 on the right, an
//   int-family source on the left as CAST does), so CASE/UNION/VALUES rows of char(3) unified to char(5) are 5
//   characters (01 §5); it never cuts (an over-long value keeps its length; 2628 is the caller's check).
// - xml values: CONVERT(xml, s, style) takes styles 0-3 (1 and 3 keep whitespace-only text nodes, as style 1; others
//   raise 281 `<n> is not a valid style number when converting to xml.`); xml:space="preserve" on an element keeps the
//   whitespace-only text nodes below it, and xml:space="default" restores the conversion's rule. xmlValue and xmlDoc
//   use parseXml's mixed mode, which returns a '#document' node for any fragment (core/xml.js contract), so xmlDoc(v)
//   is that node; its kids are the top-level nodes. xmlValue prunes the document it parsed to the tree parseXml gives
//   for the serialised text (dropped whitespace-only text nodes removed, each node's `text` its kept character data)
//   and puts it in xmlDoc's cache under that text, so `CAST(s AS xml).value(…)` parses s once (01 §8.3); besides the
//   64 values the cache holds at most 4,000,000 UTF-16 units of text (the newest value always stays). 9400 uses
//   parseXml's line, col and reason fields (the `… at line L, column C.` message form when a field is missing). cmp,
//   eq, keyOf and sortKey raise 305 for xml also when a value is NULL (SQL Server rejects the comparison itself).
//   rowKey(values, types, ai, {xmlText: true}) keys xml values by their serialised text ('x' + text) instead of
//   raising 305: the grouping identity of FOR XML/JSON AUTO levels (01 §5.6, exec.js), never DISTINCT or GROUP BY.
// - sql_variant: values of static type 'any' that are not SqlVariants (older callers, a Column without attr) are
//   read with the type of their JS value: numbers float, booleans bit, strings nvarchar(4000), Uint8Array
//   varbinary(8000), Dates datetime, any other object its JSON text as nvarchar(4000) (never '[object Object]');
//   variantType(raw) returns that Type and variantValue(raw) the value itself.
//   Within the date-and-time family, cmp, eq, keyOf and sortKey compare instants (a date as its UTC midnight, a time
//   on 1900-01-01 UTC, plus ticks): they take no session tz, so this equals SQL Server's conversion to the higher type
//   when the session tz is UTC. A sql_variant converted by coerce (an assignment) follows castValue's explicit rules,
//   without truncation. `& | ^` on a sql_variant raise 8117 with the operator named 'boolean AND', 'boolean OR' or
//   'boolean XOR'. atTimeZone accepts a sql_variant whose base value is a datetime.
// - Collations: SQL_COLLATIONS lists the Windows collation bases (lcid, code page, versions, Intl locale) and the SQL
//   Server collations (sort order, code page, lcid, locale); the full fn_helpcollations list is generated from it by
//   rule (_BIN, _BIN2, the 16 _CI/_CS × _AI/_AS × [_KS] × [_WS] names, _SC for versions 90/100, _VSS for 140 and the
//   UTF-8 variants), so the descriptions follow SQL Server's templates and a few names may differ from a given SQL
//   Server build. Extra exports: `collationInfo(name) -> {name, description, codePage, lcid, comparisonStyle,
//   version, locale, ci, ai, bin} | null` (COLLATIONPROPERTY, unknown name -> null) and `sqlCollations()` (every row,
//   frozen, fn_helpcollations order; sys.fn_helpcollations() and COLLATE completion). collation(name) objects also
//   carry name, description, codePage, lcid, comparisonStyle and version. Every COLLATE name must name its case and
//   accent sensitivity (or _BIN/_BIN2), as SQL Server requires; a name the table lacks raises 448. The language part
//   changes the order only: equality stays collKey (case, accents, NFKD, trailing spaces). A locale Intl lacks falls
//   back to its language, then 'en'.
// - Sub-millisecond precision: withTicks(d, tk) requires an integer 0..9999 (RangeError otherwise); fromParts
//   honours a `tk` field; sortKey of a datetime with ticks is {m, t} (the instant otherwise). datetime →
//   datetime2/datetimeoffset/time keeps the milliseconds (SQL Server 2016+ expands datetime's 1/300 s tick instead,
//   e.g. .003 → .0033333; Dataverse datetime values are milliseconds off that grid, which the expansion would move
//   apart from the pushed FetchXML comparison; a documented deviation); datetime2(n ≤ 3) has no
//   ticks.
// - datetime → number is computed as SQL Server and SQL 4 CDS do: (100-ns ticks of the session wall-clock time
//   since 1900-01-01, the time of day on its 1/300 s grid) × (1 / 864,000,000,000), which gives 45567.500694444439
//   for 2024-10-04 12:01:00 rather than the nearest double; → int family is floor(days + 0.5), also before 1900.
// - TRY_CAST / TRY_CONVERT also return NULL for 235 (the money form of 8114) and 9400 (malformed xml text, as SQL
//   Server: `WHERE TRY_CONVERT(xml, col) IS NULL` finds invalid XML).
// - real (IEEE single precision) values are held as Math.fround(x) when that is an integer (every float32 from 2^24 up
//   is one: CAST(16777217 AS real) = 16777216, CAST(123456789 AS real) = 123456792, as SQL Server), and
//   otherwise as the shortest decimal that rounds to the same float32 (CAST(0.1 AS real) = 0.1, 1.23456789 →
//   1.2345679), because static types do not tell real from float (01 §8) and the grid shows floats with 15 digits. A
//   fractional real converted to float or decimal therefore gives that decimal (SQL Server: 0.100000001490116), a
//   deviation.
// - CONVERT style 127 writes the UTC instant with 'Z' for datetimeoffset values only (01 §5.3); datetime, datetime2 and
//   smalldatetime values give the style 126 text, as SQL Server.
// - dataTypeOf of a decimal Type without `scale` (a bare 'decimal') is a TypeError naming the missing scale: no exact
//   DataType holds it, and the engine's decimal Types always carry their scale.
// - toServer(value, attr, tz, {dateformat}): the optional fourth argument (env) gives the SET DATEFORMAT order for the
//   string fallback of a DateTime column (01 §5.3); without it numeric dates read mdy.
// - isoText(v, type, tz, {ms, offset}): time values give their prec digits; a non-Date value for a date/time type is a
//   TypeError. floatText15 writes the largest doubles, whose 15-digit rounding overflows String(Number(…)) to
//   'Infinity', as the rounded digits ('1.79769313486232e+308').
// - dtOfAttr: a ManagedProperty column (iscustomizable, ishidden, …; Dataverse's are BooleanManagedProperty) is bit,
//   as SQL 4 CDS reads its Value, and fromServer gives that Value as 1/0 (toServer sends the bit as it is, which the
//   Web API rejects: writes of these columns are not supported). CalendarRules and any attribute type 02 §2 does not
//   list are nvarchar(max), and fromServer writes an object or array value of a text column as its JSON text, so no
//   attribute is typed sql_variant (01 §5); dtOfAttr(null) stays {dt: 'any'}.
// - Extra exports for the 01 §5 list: `lcidToLocale(lcid) -> string | null` (the BCP 47 locale of the collation
//   LCID table, null for an unlisted LCID; the caller checks the Intl API it uses, so util.js formatCell can drop its
//   copy of the table) and `orgCollation() -> {lcid, ai, locale}` (frozen; the org collation setCollation set, 1033
//   before any call; SERVERPROPERTY('LCID') / 'Collation' read it instead of env.org.lcid).
// - Numeric dates: the ISO form of 01 §5.3 (1) is `yyyy-MM-dd` with a two-digit
//   month and day; `2007-4-21` is a numeric date (2) and follows DATEFORMAT as `2007/4/21` does (under ydm it raises
//   241, and `2007-21-4` is 21 April). The `yyyy-M-dTHH:mm` form (with T) stays ISO year-month-day.
// - commonType of strings and binary: a side without `len` (unknown length) gives max, so a SELECT INTO column of
//   the union holds every value; a unicode union longer than 4000 is nvarchar(max) and never fixed (nchar(max) does
//   not exist), as the 01 §5 caps say.
// - coerce raises 8115 when a decimal or money value does not fit a narrower target (decimal(10,2) -> decimal(5,2),
//   money -> smallmoney), as castValue does; it returns the value unchanged only when the target cannot overflow.
// - castValue checks the style before a NULL value returns NULL (281 for CONVERT(datetime, @nullString, 999), also
//   with TRY), as SQL Server checks a style whatever the value; a NULL sql_variant or bare NULL has no base type, so
//   only the checks of the target (xml styles) apply to it.
// - jsonValue writes a time with the digits of its Type (time(n): n, time without prec: 7), as toSqlString, also for
//   a time(3) value widened to time(7) by CASE or UNION (coerce keeps its string).
// - tinyint and smallint share the static type int (01 §5 dt list), so `~` gives the int result
//   (~CAST(5 AS tinyint) = -6, SQL Server 250, as tinyint is unsigned), arithmetic on them overflows only at the int
//   range, and an implicit conversion to a Type (coerce) checks the int range only; explicit CAST/CONVERT and every
//   DataType target check 220. A documented deviation (like SQL_VARIANT_PROPERTY's BaseType).
// - xml -> varbinary (01 §5.8) gives the UTF-16LE bytes without a byte-order mark and binary ->
//   xml reads UTF-16LE only after FF FE, so CAST(CAST(x AS varbinary(max)) AS xml) raises 9400 (U+0000). SQL Server
//   writes FF FE before the bytes, which would make the
//   round trip work (toBin's xml case).
// - roundDec and the decimal/money text (01 §8 ROUND, §5.4) round the plain decimal digits of the value as text and
//   convert once at the end, instead of 01 §8's `Math.round(Number(abs + 'e' + n))`, whose shifted double loses
//   digits once x·10^n passes 2^53 (123456789012345.67 at scale 2 printed .69). Same results wherever that formula is
//   exact.

import { SqlError } from './lexer.js';
import { msg } from './messages.js';
import { parseXml, xmlEsc } from '../core/xml.js';

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
// Conversion failures that TRY_CAST / TRY_CONVERT turn into NULL (01 §5.4; 235 is the money form of 8114, 9400 malformed
// xml text).
const SOFT = new Set([220, 232, 235, 241, 242, 245, 248, 517, 3623, 8114, 8115, 8169, 8170, 9400]);
const E241 = () => E(241);
const E8134 = () => E(8134);

// Warning text for bigint values beyond ±2^53 (01 §5: rows hold JS numbers).
export const BIGINT_LOSS = 'A bigint value beyond ±2^53 (9,007,199,254,740,991) lost precision: values are held as JavaScript numbers.';

// ------------------------------------------------------------------------------------------- type basics

// Lower-case SQL type names for editor highlighting (01 §5).
export const TYPE_NAMES = new Set(['bigint', 'binary', 'bit', 'char', 'date', 'datetime', 'datetime2', 'datetimeoffset',
  'decimal', 'entityreference', 'float', 'int', 'money', 'nchar', 'ntext', 'numeric', 'nvarchar', 'real', 'rowversion',
  'smalldatetime', 'smallint', 'smallmoney', 'sql_variant', 'text', 'time', 'timestamp', 'tinyint', 'uniqueidentifier',
  'varbinary', 'varchar', 'xml', 'dec', 'integer', 'sysname']);

// SQL Server type-name synonyms -> [canonical name, fixed args or null].
const ALIASES = new Map([['integer', ['int', null]], ['dec', ['decimal', null]], ['double precision', ['float', null]],
  ['character', ['char', null]], ['char varying', ['varchar', null]], ['character varying', ['varchar', null]],
  ['national character', ['nchar', null]], ['national char', ['nchar', null]], ['national character varying', ['nvarchar', null]],
  ['national char varying', ['nvarchar', null]], ['nchar varying', ['nvarchar', null]], ['national text', ['ntext', null]],
  ['binary varying', ['varbinary', null]], ['sysname', ['nvarchar', [128]]]]);

const F = Object.freeze;
const ANY = F({ dt: 'any' });
const INT = F({ dt: 'int' });
const BIGINT = F({ dt: 'bigint' });
const BIT = F({ dt: 'bit' });
const FLOAT = F({ dt: 'float' });
const MONEY = F({ dt: 'money', prec: 19, scale: 4 });
const NVAR = F({ dt: 'string', len: -1, unicode: true });
const XML = F({ dt: 'xml', len: -1, unicode: true });
const ANYNUM = F({ dt: 'float', anyNum: true });
const DATETIME = F({ dt: 'datetime' });
const DTS = Object.assign(Object.create(null), {
  int: INT, bigint: BIGINT, decimal: F({ dt: 'decimal' }), float: FLOAT, money: MONEY, bit: BIT,
  string: F({ dt: 'string' }), binary: F({ dt: 'binary' }), xml: XML, datetime: DATETIME, date: F({ dt: 'date' }),
  time: F({ dt: 'time' }), guid: F({ dt: 'guid' }), null: F({ dt: 'null' }), any: ANY,
});

const ty = t => (t == null ? ANY : typeof t === 'string' ? (DTS[t] || ANY) : t);
const dtn = t => (t == null ? 'any' : typeof t === 'string' ? t : (t.dt || 'any'));
const NUMS = new Set(['bit', 'int', 'bigint', 'decimal', 'money', 'float']);
const INTS = new Set(['bit', 'int', 'bigint']);
const isNum = d => NUMS.has(d);
const dtKind = t => (t.dto ? 'datetimeoffset' : t.prec != null ? 'datetime2' : t.small ? 'smalldatetime' : 'datetime');
const isPlainDt = t => t.dt === 'datetime' && t.prec == null && !t.dto;
// Fractional-second digits of a datetime2/datetimeoffset Type (a datetimeoffset without prec is datetimeoffset(7)).
const dtPrec = t => t.prec ?? (t.dto ? 7 : null);

const TYPE_FIELDS = ['prec', 'scale', 'len', 'dto', 'unicode', 'fixed', 'small', 'numeric'];

// A fresh plain Type with only the Type fields of t (never a caller's Column or a shared frozen descriptor).
function pickType(t) {
  const r = { dt: t.dt };
  for (const k of TYPE_FIELDS) if (t[k] != null && t[k] !== false) r[k] = t[k];
  return r;
}

// The SQL Server type name used in error messages (decimal reads 'numeric', as SQL Server writes it).
function msgName(t) {
  switch (t.dt) {
    case 'decimal': return 'numeric';
    case 'money': return t.prec === 10 ? 'smallmoney' : 'money';
    case 'string': return t.unicode ? 'nvarchar' : 'varchar';
    case 'binary': return t.fixed ? 'binary' : 'varbinary';
    case 'guid': return 'uniqueidentifier';
    case 'datetime': return dtKind(t);
    case 'any': return 'sql_variant';
    case 'null': return 'int';
    default: return t.dt;
  }
}

// The type name of a 206 message: msgName, with '(max)' for the max string and binary types (SQL Server writes
// `Operand type clash: nvarchar(max) is incompatible with sql_variant`).
const clashName = t => ((t.dt === 'string' || t.dt === 'binary') && t.len === -1 ? msgName(t) + '(max)' : msgName(t));

// SQL Server base type name as error messages write it (206, 8116, 8117): 'numeric', 'nvarchar', 'datetime2', ...
export function msgTypeName(type) {
  return msgName(ty(type));
}

// Display name of a static type, e.g. 'nvarchar(160)', 'decimal(19,4)', 'datetime2(7)', 'varbinary(max)'.
export function typeName(type) {
  const t = ty(type);
  switch (t.dt) {
    case 'decimal': return t.prec != null ? `decimal(${t.prec},${t.scale ?? 0})` : 'decimal';
    case 'string': {
      const b = (t.unicode ? 'n' : '') + (t.fixed ? 'char' : 'varchar');
      return t.len == null ? b : `${b}(${t.len < 0 ? 'max' : t.len})`;
    }
    case 'binary': {
      const b = t.fixed ? 'binary' : 'varbinary';
      return t.len == null ? b : `${b}(${t.len < 0 ? 'max' : t.len})`;
    }
    case 'datetime': return dtPrec(t) != null ? `${dtKind(t)}(${dtPrec(t)})` : dtKind(t);
    case 'time': return `time(${t.prec ?? 7})`;
    default: return msgName(t);
  }
}

const PREC = Object.assign(Object.create(null), {
  null: 0, binary: 1, string: 2, guid: 3, bit: 4, int: 5, bigint: 6, money: 7, decimal: 8, float: 9, time: 10, date: 11,
  datetime: 12, xml: 13, any: 14,
});

// Data-type precedence rank (higher wins; 01 §5, SQL Server's order): sql_variant > xml > datetime > date > time >
// float > decimal > money > bigint > int > bit > guid > string > binary; within datetime: datetimeoffset > datetime2 >
// datetime > smalldatetime. A bare NULL ranks lowest.
export function precedence(type) {
  const t = ty(type);
  if (t.dt === 'datetime') return t.dto ? 12.3 : t.prec != null ? 12.2 : t.small ? 12 : 12.1;
  return PREC[t.dt] ?? 0;
}

// Static Type of a literal's text (01 §5): an integer within ±2^31 is int, any other integer numeric(digits, 0);
// with '.' numeric(digits, digits after '.'); with an exponent float; `0x…` varbinary(bytes). Decimal literals
// carry `numeric: true` (SQL Server types them numeric). 1007 beyond 38 digits.
export function literalType(text) {
  const t = String(text).trim();
  const hx = /^0[xX]([0-9A-Fa-f]*)$/.exec(t);
  if (hx) return { dt: 'binary', len: Math.max(1, (hx[1].length + 1) >> 1) };
  const m = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE][+-]?\d+)?$/.exec(t);
  if (!m || (!m[1] && !m[2])) throw E(102, t);
  if (/[eE]/.test(t)) return { dt: 'float' };
  const ip = m[1].replace(/^0+/, '');
  const too = () => E(1007, t.replace(/^[+-]/, ''));
  if (m[2] === undefined) {
    const n = BigInt(t);
    if (n >= -2147483648n && n <= 2147483647n) return { dt: 'int' };
    if (ip.length > 38) throw too();
    return { dt: 'decimal', prec: Math.max(ip.length, 1), scale: 0, numeric: true };
  }
  const s = m[2].length, p = Math.max(ip.length + s, 1);
  if (p > 38) throw too();
  return { dt: 'decimal', prec: p, scale: s, numeric: true };
}

// Static Type of a DataType ({name, args}); defLen is the default string length (30 in CAST, 1 in DECLARE).
export function dtOf(dataType, defLen = 30) {
  return { ...target(dataType, defLen).type };
}

// Inverse of dtOf: a DataType that holds values of the static type (SELECT INTO, temp table columns).
export function dataTypeOf(type) {
  const t = ty(type);
  const dt = (name, args = []) => ({ name, args });
  switch (t.dt) {
    case 'bit': case 'int': case 'bigint': case 'float': case 'date': return dt(t.dt);
    case 'decimal':
      // no exact DataType holds a decimal of unknown scale (the engine's decimal Types always carry it)
      if (t.scale == null) throw new TypeError(`dataTypeOf: a decimal Type needs its scale, got ${JSON.stringify(pickType(t))}`);
      return dt(t.numeric ? 'numeric' : 'decimal', [t.prec ?? 38, t.scale]);
    case 'money': return dt(t.prec === 10 ? 'smallmoney' : 'money');
    case 'string': {
      const name = (t.unicode ? 'n' : '') + (t.fixed ? 'char' : 'varchar');
      return dt(name, [t.len == null || t.len < 0 ? (t.fixed ? (t.unicode ? 4000 : 8000) : 'max') : t.len]);
    }
    case 'time': return dt('time', [t.prec ?? 7]);
    case 'datetime': {
      const k = dtKind(t);
      return k === 'datetime2' || k === 'datetimeoffset' ? dt(k, [dtPrec(t)]) : dt(k);
    }
    case 'guid': return dt('uniqueidentifier');
    case 'binary': {
      const n = t.len == null || t.len < 0 ? (t.fixed ? 8000 : 'max') : t.len;
      return dt(t.fixed ? 'binary' : 'varbinary', [n]);
    }
    case 'xml': return dt('xml');
    case 'any': return dt('sql_variant');
    default: return dt('int');
  }
}

// Static Type of a Dataverse attribute (AttrInfo, 02 §2), by AttributeType and DateTimeBehavior (never Format).
export function dtOfAttr(attr) {
  if (!attr) return { dt: 'any' };
  switch (attr.type) {
    // a String or Memo column: max(MaxLength, DatabaseLength / 2), max beyond 4000 (01 §5)
    case 'String': case 'Memo': {
      const n = Math.max(attr.maxLength || 0, Math.floor((attr.databaseLength || 0) / 2));
      return { dt: 'string', len: n > 0 && n <= 4000 ? n : -1, unicode: true };
    }
    case 'EntityName': return { dt: 'string', len: 64, unicode: true };
    case 'MultiSelectPicklist': case 'Virtual': case 'PartyList':
      return { dt: 'string', len: -1, unicode: true };
    case 'Image': return { dt: 'binary', len: -1 };
    case 'Integer': case 'Picklist': case 'State': case 'Status': return { dt: 'int' };
    case 'BigInt': return { dt: 'bigint' };
    case 'Decimal': {
      const s = Number.isInteger(attr.precision) && attr.precision >= 0 && attr.precision <= 26 ? attr.precision : 2;
      return { dt: 'decimal', prec: Math.min(38, 12 + s), scale: s };
    }
    case 'Double': return { dt: 'float' };
    case 'Money': return { dt: 'money', prec: 19, scale: 4 };
    case 'Boolean': return { dt: 'bit' };
    case 'DateTime': return attr.behavior === 'DateOnly' ? { dt: 'date' } : { dt: 'datetime' };
    case 'Lookup': case 'Customer': case 'Owner': {
      const tg = attr.targets;
      if (Array.isArray(tg) && tg.length === 1) return { dt: 'guid', ref: { entity: tg[0] } };
      if (Array.isArray(tg) && tg.length > 1) return { dt: 'guid', ref: { poly: true } };
      return { dt: 'guid' };
    }
    case 'Uniqueidentifier': return attr.isPk ? { dt: 'guid', ref: { entity: attr.entity } } : { dt: 'guid' };
    case 'File': return { dt: 'guid' };
    // a Dataverse ManagedProperty column (iscustomizable, ishidden, …) is a BooleanManagedProperty: its Value, as in
    // SQL 4 CDS (fromServer reads it); see the notes above
    case 'ManagedProperty': return { dt: 'bit' };
    // CalendarRules and any attribute type this table does not list: the Web API value as text (fromServer writes an
    // object as its JSON), never sql_variant (01 §5: only a real sql_variant is typed any; see the notes above)
    default: return { dt: 'string', len: -1, unicode: true };
  }
}

// --------------------------------------------------------------------------------------- data type targets

const TCACHE = new WeakMap();
const TNAMES = new Map();

function target(dataType, defLen) {
  const dtObj = typeof dataType === 'string' ? (TNAMES.get(dataType) || TNAMES.set(dataType, { name: dataType, args: [] }).get(dataType)) : dataType;
  if (!dtObj || typeof dtObj !== 'object') throw E(243, String(dataType));
  let c = TCACHE.get(dtObj);
  if (!c) TCACHE.set(dtObj, (c = new Map()));
  let T = c.get(defLen);
  if (!T) c.set(defLen, (T = buildTarget(dtObj, defLen)));
  return T;
}

// Integer targets: range (lo/hi, as BigInt blo/bhi), `small` (tinyint/smallint: 220 on overflow), `size` (the bytes
// of a binary conversion) and `unsigned` (tinyint).
const INT_T = {
  tinyint: { k: 'int', name: 'tinyint', lo: 0, hi: 255, blo: 0n, bhi: 255n, small: true, size: 1, unsigned: true },
  smallint: { k: 'int', name: 'smallint', lo: -32768, hi: 32767, blo: -32768n, bhi: 32767n, small: true, size: 2 },
  int: { k: 'int', name: 'int', lo: -2147483648, hi: 2147483647, blo: -2147483648n, bhi: 2147483647n, small: false, size: 4 },
  bigint: { k: 'int', name: 'bigint', lo: -9223372036854775808, hi: 9223372036854775807, blo: -9223372036854775808n, bhi: 9223372036854775807n, small: false, big: true, size: 8 },
};

function buildTarget(dataType, defLen) {
  const written = String(dataType.name);
  let name = written.toLowerCase().replace(/\s+/g, ' ');
  let args = Array.isArray(dataType.args) ? dataType.args : [];
  const alias = ALIASES.get(name);
  if (alias) {
    if (alias[1] && args.length) throw E(2716, 1, name);
    name = alias[0];
    if (alias[1]) args = alias[1];
  }
  const noArgs = () => {
    if (args.length) throw E(2716, 1, name);
  };
  const maxArgs = n => {
    if (args.length > n) throw E(102, ',');
  };
  const num = a => {
    if (a === 'max') throw E(102, 'max');
    if (!Number.isInteger(a)) throw E(102, String(a));
    return a;
  };
  // A declared length: 'max' (-1) where allowed, else 1..max (1001, 131).
  const length = (fixed, max) => {
    let len = args.length ? args[0] : defLen;
    if (len === 'max') {
      if (fixed) throw E(102, 'max');
      return -1;
    }
    num(len);
    if (len < 1) throw E(1001, len);
    if (len > max) throw E(131, len, name, max);
    return len;
  };
  switch (name) {
    case 'bit': noArgs(); return { k: 'bit', name, type: { dt: 'bit' } };
    case 'tinyint': case 'smallint': case 'int': case 'bigint':
      noArgs();
      return { ...INT_T[name], type: { dt: name === 'bigint' ? 'bigint' : 'int' } };
    case 'decimal': case 'numeric': {
      maxArgs(2);
      const p = args.length ? num(args[0]) : 18;
      const s = args.length > 1 ? num(args[1]) : 0;
      if (p < 1) throw E(1001, p);
      if (p > 38) throw E(2750, 1, p, 38);
      if (s < 0 || s > p) throw E(192);
      return { k: 'dec', name, p, s, type: name === 'numeric' ? { dt: 'decimal', prec: p, scale: s, numeric: true } : { dt: 'decimal', prec: p, scale: s } };
    }
    case 'float': {
      maxArgs(1);
      const n = args.length ? num(args[0]) : 53;
      if (n < 1) throw E(1001, n);
      if (n > 53) throw E(2750, 1, n, 53);
      return { k: 'flt', name: n <= 24 ? 'real' : 'float', real: n <= 24, type: { dt: 'float' } };
    }
    case 'real': noArgs(); return { k: 'flt', name, real: true, type: { dt: 'float' } };
    case 'money': case 'smallmoney':
      noArgs();
      return { k: 'money', name, small: name === 'smallmoney', type: { dt: 'money', prec: name === 'money' ? 19 : 10, scale: 4 } };
    case 'char': case 'varchar': case 'nchar': case 'nvarchar': {
      maxArgs(1);
      const uni = name[0] === 'n';
      const fixed = !name.endsWith('varchar');
      const len = length(fixed, uni ? 4000 : 8000);
      const type = { dt: 'string', len };
      if (uni) type.unicode = true;
      if (fixed) type.fixed = true;
      return { k: 'str', name, len, uni, fixed, type };
    }
    case 'text': case 'ntext': {
      noArgs();
      const uni = name !== 'text';
      return { k: 'str', name, len: -1, uni, fixed: false, type: uni ? { dt: 'string', len: -1, unicode: true } : { dt: 'string', len: -1 } };
    }
    case 'binary': case 'varbinary': {
      maxArgs(1);
      const fixed = name === 'binary';
      const len = length(fixed, 8000);
      const type = { dt: 'binary', len };
      if (fixed) type.fixed = true;
      return { k: 'bin', name, len, fixed, type };
    }
    case 'rowversion': case 'timestamp':
      noArgs();
      return { k: 'bin', name: 'binary', len: 8, fixed: true, type: { dt: 'binary', len: 8, fixed: true } };
    case 'xml': noArgs(); return { k: 'xml', name, type: { dt: 'xml', len: -1, unicode: true } };
    case 'date': noArgs(); return { k: 'date', name, type: { dt: 'date' } };
    case 'datetime': noArgs(); return { k: 'dt', name, type: { dt: 'datetime' } };
    case 'smalldatetime': noArgs(); return { k: 'dt', name, small: true, type: { dt: 'datetime', small: true } };
    case 'datetime2': case 'datetimeoffset': case 'time': {
      maxArgs(1);
      const n = args.length ? num(args[0]) : 7;
      if (n < 0 || n > 7) throw E(1002, n);
      if (name === 'time') return { k: 'time', name, prec: n, type: { dt: 'time', prec: n } };
      const dto = name === 'datetimeoffset';
      return { k: 'dt', name, prec: n, dto, type: dto ? { dt: 'datetime', prec: n, dto: true } : { dt: 'datetime', prec: n } };
    }
    case 'uniqueidentifier': noArgs(); return { k: 'guid', name, type: { dt: 'guid' } };
    // SQL 4 CDS's EntityReference: a uniqueidentifier whose `ref` lineage is kept per value by compile.js.
    case 'entityreference': noArgs(); return { k: 'guid', name: 'uniqueidentifier', type: { dt: 'guid', entityref: true } };
    case 'sql_variant': noArgs(); return { k: 'var', name, type: { dt: 'any' } };
    default: throw E(243, written);
  }
}

const TTCACHE = new WeakMap();

// Conversion target for an implicit conversion to a static Type (no string or binary truncation or padding; coerce
// pads a fixed-length target afterwards).
function typeTarget(type) {
  const t = ty(type);
  let T = TTCACHE.get(t);
  if (T) return T;
  switch (t.dt) {
    case 'int': T = INT_T.int; break;
    case 'bigint': T = INT_T.bigint; break;
    case 'bit': T = { k: 'bit', name: 'bit' }; break;
    case 'decimal': T = { k: 'dec', name: 'numeric', p: t.prec ?? 38, s: t.scale ?? null }; break;
    case 'float': T = { k: 'flt', name: 'float', real: false }; break;
    case 'money': T = { k: 'money', name: t.prec === 10 ? 'smallmoney' : 'money', small: t.prec === 10 }; break;
    case 'string': T = { k: 'str', name: msgName(t), len: -1, uni: !!t.unicode, fixed: false }; break;
    case 'binary': T = { k: 'bin', name: msgName(t), len: -1, fixed: false }; break;
    case 'xml': T = { k: 'xml', name: 'xml' }; break;
    case 'date': T = { k: 'date', name: 'date' }; break;
    case 'time': T = { k: 'time', name: 'time', prec: t.prec ?? 7 }; break;
    case 'datetime': T = { k: 'dt', name: dtKind(t), prec: dtPrec(t), dto: !!t.dto, small: !!t.small }; break;
    case 'guid': T = { k: 'guid', name: 'uniqueidentifier' }; break;
    case 'null': T = { k: 'null', name: 'int' }; break;
    default: T = { k: 'var', name: 'sql_variant' };
  }
  TTCACHE.set(t, T);
  return T;
}

// ---------------------------------------------------------------------------------------- common type

function clash(a, b) {
  return E(206, clashName(a), clashName(b));
}

const TEMPORAL_DTS = new Set(['date', 'time', 'datetime']);
const isMaxLob = t => ((t.dt === 'string' || t.dt === 'binary') && t.len === -1) || t.dt === 'xml';

// Whether combining static types a and b is an Operand type clash (206) in SQL Server's implicit conversion chart.
function clashes(a, b) {
  const x = a.dt, y = b.dt;
  if (x === y) return false;
  // sql_variant takes every other type except xml and the max string and binary types (01 §5).
  if (x === 'any' || y === 'any') return isMaxLob(x === 'any' ? b : a);
  // xml converts implicitly only from the string and binary types (01 §5.8).
  if (x === 'xml' || y === 'xml') {
    const o = x === 'xml' ? y : x;
    return o !== 'string' && o !== 'binary';
  }
  if (x === 'string' || y === 'string') return false;
  // binary converts to and from the integer types, bit, uniqueidentifier and the strings (01 §5.4).
  if (x === 'binary' || y === 'binary') {
    const o = x === 'binary' ? y : x;
    return !(INTS.has(o) || o === 'guid');
  }
  if (x === 'guid' || y === 'guid') return true;
  const tx = TEMPORAL_DTS.has(x), tyy = TEMPORAL_DTS.has(y);
  if (tx && tyy) return (x === 'date' && y === 'time') || (x === 'time' && y === 'date');
  if (tx) return !(isPlainDt(a) && isNum(y));
  if (tyy) return !(isPlainDt(b) && isNum(x));
  return false;
}

function decPS(t) {
  switch (t.dt) {
    case 'decimal': return [t.prec ?? 38, t.scale ?? 0];
    case 'money': return t.prec === 10 ? [10, 4] : [19, 4];
    case 'bigint': return [19, 0];
    case 'bit': return [1, 0];
    default: return [10, 0];
  }
}

function unifyDec(a, b) {
  const [p1, s1] = decPS(a), [p2, s2] = decPS(b);
  const s = Math.max(s1, s2);
  let p = Math.max(p1 - s1, p2 - s2) + s;
  let sc = s;
  if (p > 38) { sc = Math.max(Math.min(s, 6), 38 - (p - s)); p = 38; }
  return { dt: 'decimal', prec: p, scale: sc };
}

const effPrec = t => dtPrec(t) ?? (t.small ? 0 : 3);

// The length of two string or binary types unified (CASE, COALESCE, UNION; 01 §5): max wins, else the larger;
// a side of unknown length (no len) gives max, so a column built from the union holds every value. The caller skips
// the case where neither side has a length.
const unifyLen = (x, y) => (x.len == null || y.len == null || x.len === -1 || y.len === -1 ? -1 : Math.max(x.len, y.len));

// Result type of combining two static types (CASE, COALESCE, UNION, comparisons): precedence (01 §5); 206 on a clash.
// The result is always a fresh plain Type (no name, attr, ref or other Column fields of the arguments).
export function commonType(a, b) {
  const x = ty(a), y = ty(b);
  return numericOf(pickType(common(x, y)), x, y);
}

// Sets the `numeric` flag of a fresh result Type r of combining a and b (see the notes above): a decimal result is
// numeric exactly when every decimal operand is (non-decimal operands such as int do not count).
function numericOf(r, a, b) {
  const da = a.dt === 'decimal', db = b.dt === 'decimal';
  if (r.dt === 'decimal' && (da || db) && (!da || a.numeric) && (!db || b.numeric)) r.numeric = true;
  else delete r.numeric;
  return r;
}

function common(x, y) {
  if (x.dt === 'null') return y.dt === 'null' ? INT : y;
  if (y.dt === 'null') return x;
  if (clashes(x, y)) throw clash(x, y);
  if (x.dt === y.dt) {
    switch (x.dt) {
      case 'decimal': return unifyDec(x, y);
      case 'money': return x.prec === 10 && y.prec === 10 ? x : MONEY;
      case 'string': {
        const r = { dt: 'string' };
        if (x.len != null || y.len != null) r.len = unifyLen(x, y);
        if (x.unicode || y.unicode) r.unicode = true;
        // nvarchar caps at 4000 (varchar's 8000 cannot be passed by two lengths of at most 8000): beyond it the
        // result is max (01 §5), and there is no fixed-length max type
        if (r.unicode && r.len > 4000) r.len = -1;
        if (x.fixed && y.fixed && r.len !== -1) r.fixed = true;
        return r;
      }
      case 'binary': {
        const r = { dt: 'binary' };
        if (x.len != null || y.len != null) r.len = unifyLen(x, y);
        if (x.fixed && y.fixed && r.len !== -1) r.fixed = true;
        return r;
      }
      case 'datetime': {
        if (x.dto || y.dto || x.prec != null || y.prec != null) {
          const r = { dt: 'datetime', prec: Math.max(effPrec(x), effPrec(y)) };
          if (x.dto || y.dto) r.dto = true;
          return r;
        }
        return x.small && y.small ? x : DATETIME;
      }
      case 'time': return { dt: 'time', prec: Math.max(x.prec ?? 7, y.prec ?? 7) };
      case 'xml': return XML;
      default: return x;
    }
  }
  const hi = PREC[x.dt] >= PREC[y.dt] ? x : y, lo = hi === x ? y : x;
  if (hi.dt === 'decimal' && isNum(lo.dt)) return unifyDec(hi, lo);
  return hi;
}

// --------------------------------------------------------------------------------------- number helpers

function expandExp(s) {
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const digits = m[2] + (m[3] || '');
  const point = m[2].length + Number(m[4]);
  let out;
  if (point <= 0) out = '0.' + '0'.repeat(-point) + digits;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = digits.slice(0, point) + '.' + digits.slice(point);
  out = out.replace(/^0+(?=\d)/, '');
  return m[1] + out;
}

// Plain decimal text of a finite number, never in exponent notation (FetchXML values, exports).
export function plainNumber(x) {
  return plainNum(x);
}

function plainNum(x) {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return '0';
  const s = String(x);
  return s.includes('e') ? expandExp(s) : s;
}

// Decimal rounding half away from zero at digit n (n < 0 rounds left of the point) by decimal-string shifting;
// truncate = true cuts toward zero (01 §8 ROUND).
export function roundDec(x, n, truncate = false) {
  if (x == null || !Number.isFinite(x) || x === 0) return x === 0 ? 0 : x;
  n = Math.trunc(n);
  if (!Number.isFinite(n)) return x;
  const out = (x < 0 ? -1 : 1) * Number(roundText(plainNum(Math.abs(x)), n, truncate));
  return out === 0 ? 0 : out;
}

// The plain decimal text `s` (non-negative, no exponent) rounded half away from zero (or cut, truncate) at decimal
// digit n (n < 0: left of the point), as text: the digits are shifted, never the binary value, so a number whose
// x·10^n passes 2^53 keeps its digits (123456789012345.67 at n = 2 stays .67, where Math.round of the shifted double
// would give .68).
function roundText(s, n, truncate) {
  const dot = s.indexOf('.');
  const ip = dot < 0 ? s : s.slice(0, dot);
  const fp = dot < 0 ? '' : s.slice(dot + 1);
  const digits = ip + fp;
  const keep = ip.length + n;   // the number of leading digits that stay
  if (keep >= digits.length) return s;
  if (keep < 0) return '0';
  const up = !truncate && digits.charCodeAt(keep) >= 53;   // the first dropped digit is 5..9
  // one added at the last kept digit carries to the left (999 + 1 = 1000)
  const head = up ? incDigits(digits.slice(0, keep)) : digits.slice(0, keep);
  // the integer part grows by one digit when the carry passed the first digit
  const intLen = ip.length + (head.length > keep ? 1 : 0);
  if (n <= 0) return head ? head + '0'.repeat(-n) : '0';
  const out = head.slice(0, intLen) + '.' + head.slice(intLen);
  return out.startsWith('.') ? '0' + out : out;
}

function intStr(v) {
  if (Number.isSafeInteger(v)) return String(v === 0 ? 0 : v);
  if (Number.isInteger(v)) return BigInt(v).toString();
  return plainNum(Math.trunc(v));
}

// A decimal's text with exactly s digits after the point, rounded half away from zero on its decimal digits (never
// through a shifted double, so digits beyond 2^53 stay exact); a value that rounds to zero has no sign.
function decStr(x, s) {
  const str = Number.isFinite(x) ? roundText(plainNum(Math.abs(x)), s, false) : plainNum(x);
  const dot = str.indexOf('.');
  const ip = dot < 0 ? str : str.slice(0, dot);
  let fp = dot < 0 ? '' : str.slice(dot + 1);
  fp = fp.length > s ? fp.slice(0, s) : fp.padEnd(s, '0');
  const neg = x < 0 && /[1-9]/.test(ip + fp);
  return (neg ? '-' : '') + ip + (s > 0 ? '.' + fp : '');
}

function group(s) {
  const neg = s[0] === '-';
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const ip = dot < 0 ? body : body.slice(0, dot);
  const g = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + g + (dot < 0 ? '' : body.slice(dot));
}

const expStr = e => 'e' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(3, '0');
const trimFrac = s => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

// C printf %g with P significant digits and a three-digit exponent (SQL Server float style 0).
function gfmt(x, P) {
  if (x === 0) return '0';
  const ex = x.toExponential(P - 1);
  const i = ex.indexOf('e');
  const e = Number(ex.slice(i + 1));
  if (e < -4 || e >= P) return trimFrac(ex.slice(0, i)) + expStr(e);
  return trimFrac(x.toFixed(P - 1 - e));
}

function efmt(x, P) {
  const ex = x.toExponential(P - 1);
  const i = ex.indexOf('e');
  return ex.slice(0, i) + expStr(Number(ex.slice(i + 1)));
}

function fixed6(v) {
  return Math.abs(v) < 1e21 ? v.toFixed(6) : BigInt(Math.trunc(v)).toString() + '.000000';
}

function numStr(v, f, style) {
  switch (f.dt) {
    case 'bit': return v ? '1' : '0';
    case 'int': case 'bigint': return intStr(v);
    case 'decimal': return f.scale == null ? plainNum(v) : decStr(v, f.scale);
    case 'money':
      switch (style ?? 0) {
        case 0: return decStr(v, 2);
        case 1: return group(decStr(v, 2));
        case 2: case 126: return decStr(v, 4);
        default: throw E(281, style, 'from money to a character string');
      }
    case 'float':
      if (f.anyNum && style == null) return Number.isInteger(v) ? intStr(v) : plainNum(v);
      switch (style ?? 0) {
        case 0: return gfmt(v, 6);
        case 1: return efmt(v, 8);
        case 2: case 126: return efmt(v, 16);
        case 3: return efmt(v, 17);
        default: throw E(281, style, 'from float to a character string');
      }
    default: return String(v);
  }
}

// -------------------------------------------------------------------------------------- strings & syntax

const isWs = c => c === 32 || c === 9 || c === 13 || c === 10;

// s without leading/trailing spaces, tab, CR and LF (01 §5.4); an index scan, linear in the length of s.
function trimWs(s) {
  let a = 0, b = s.length;
  while (a < b && isWs(s.charCodeAt(a))) a++;
  while (b > a && isWs(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}
// The syntax regexes below are unambiguous (no digit run can be split two ways), so they fail in linear time.
const INT_RE = /^[+-]?\d+$/;
const DEC_RE = /^([+-]?)(\d*)(?:\.(\d*))?$/;
const FLT_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MONEY_RE = /^([+-]?)(\p{Sc}?)([+-]?)([\d,]*)(?:\.(\d*))?$/u;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const vname = f => (f.unicode ? 'nvarchar' : 'varchar');

function incDigits(s) {
  const a = s.split('');
  let i = a.length - 1;
  while (i >= 0) {
    if (a[i] === '9') { a[i] = '0'; i--; } else { a[i] = String.fromCharCode(a[i].charCodeAt(0) + 1); return a.join(''); }
  }
  return '1' + a.join('');
}

// Rounds a decimal digit string (integer part, fraction part) half away from zero to s fraction digits.
function roundDigits(ip, fp, s) {
  if (fp.length <= s) return { ip, fp: fp.padEnd(s, '0') };
  let keep = ip + fp.slice(0, s);
  if (fp.charCodeAt(s) >= 53) keep = incDigits(keep || '0');
  return { ip: keep.slice(0, keep.length - s), fp: keep.slice(keep.length - s) };
}

function digitsNumber(neg, ip, fp) {
  const n = Number((neg ? '-' : '') + (ip || '0') + (fp ? '.' + fp : ''));
  return n === 0 ? 0 : n;
}

// ------------------------------------------------------------------------------------------- binary

const HEX_DIGITS = '0123456789ABCDEF';
const HEX_RE = /^[0-9A-Fa-f]*$/;
let hexPairs = null;
let UTF8_ENC = null, UTF8_DEC = null;
// The Windows-1252 characters of the bytes 0x80-0x9F (the WHATWG table; 0x81, 0x8D, 0x8F, 0x90 and 0x9D map to
// themselves); every other byte is its own code point.
const W1252_HI = '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F' +
  '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178';
const isBytes = v => v instanceof Uint8Array;

// '0x' + upper-case hex digits of bytes (prefix false: the digits only), SQL Server's binary text (01 §5.4).
export function toHex(bytes, prefix = true) {
  if (!hexPairs) {
    hexPairs = new Uint16Array(512);
    for (let i = 0; i < 256; i++) {
      hexPairs[2 * i] = HEX_DIGITS.charCodeAt(i >> 4);
      hexPairs[2 * i + 1] = HEX_DIGITS.charCodeAt(i & 15);
    }
  }
  const parts = [];
  const codes = new Uint16Array(Math.min(bytes.length, 4096) * 2);
  for (let i = 0; i < bytes.length; i += 4096) {
    const n = Math.min(bytes.length - i, 4096);
    for (let j = 0; j < n; j++) {
      const b = bytes[i + j];
      codes[2 * j] = hexPairs[2 * b];
      codes[2 * j + 1] = hexPairs[2 * b + 1];
    }
    parts.push(String.fromCharCode.apply(null, n === 4096 ? codes : codes.subarray(0, 2 * n)));
  }
  return (prefix ? '0x' : '') + parts.join('');
}

const hexVal = c => (c <= 57 ? c - 48 : (c | 32) - 87);

// Bytes of hex digits (either case, without 0x); an odd count gets a leading 0, as the literal 0x123 is 0x0123.
// Anything but hex digits throws a TypeError (user text is validated by the caller first).
export function fromHex(digits) {
  const s = String(digits);
  if (!HEX_RE.test(s)) throw new TypeError(`fromHex: expected hexadecimal digits, got '${s.length > 40 ? s.slice(0, 40) + '...' : s}'`);
  const odd = s.length & 1;
  const out = new Uint8Array((s.length + odd) >> 1);
  let j = 0, i = 0;
  if (odd) { out[j++] = hexVal(s.charCodeAt(0)); i = 1; }
  for (; i < s.length; i += 2) out[j++] = (hexVal(s.charCodeAt(i)) << 4) | hexVal(s.charCodeAt(i + 1));
  return out;
}

// UTF-16LE bytes of a string (nvarchar -> varbinary, xml -> varbinary).
function utf16Bytes(s) {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 * i] = c & 255;
    out[2 * i + 1] = c >> 8;
  }
  return out;
}

// UTF-8 bytes of a string (varchar -> varbinary).
const utf8Bytes = s => (UTF8_ENC || (UTF8_ENC = new TextEncoder())).encode(s);

// UTF-16LE text of bytes from offset `from` (varbinary -> nvarchar); an odd last byte is dropped, and every code
// unit is kept as it is (no replacement of lone surrogates).
function decodeUtf16(b, from = 0) {
  const n = (b.length - from) >> 1;
  const parts = [];
  for (let i = 0; i < n; i += 8192) {
    const m = Math.min(n, i + 8192);
    const codes = new Array(m - i);
    for (let j = i; j < m; j++) codes[j - i] = b[from + 2 * j] | (b[from + 2 * j + 1] << 8);
    parts.push(String.fromCharCode.apply(null, codes));
  }
  return parts.join('');
}

// UTF-8 text of bytes (varbinary -> varchar); invalid UTF-8 is read as Windows-1252, as Load CSV does (01 §5.4, §9).
function decodeUtf8(b) {
  try {
    return (UTF8_DEC || (UTF8_DEC = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }))).decode(b);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    return decode1252(b);
  }
}

// Windows-1252 text of bytes, decoded by table (Node's TextDecoder reads the label as Latin-1).
function decode1252(b) {
  const parts = [];
  const codes = new Uint16Array(Math.min(b.length, 8192));
  for (let i = 0; i < b.length; i += 8192) {
    const n = Math.min(b.length - i, 8192);
    for (let j = 0; j < n; j++) {
      const c = b[i + j];
      codes[j] = c >= 0x80 && c <= 0x9F ? W1252_HI.charCodeAt(c - 0x80) : c;
    }
    parts.push(String.fromCharCode.apply(null, n === 8192 ? codes : codes.subarray(0, n)));
  }
  return parts.join('');
}

// Text of a binary value converted to a string type: style 1 '0x' + hex, style 2 hex, else its bytes decoded
// (UTF-16LE for a unicode target, else UTF-8).
function binText(b, style, uni) {
  if (style === 1) return toHex(b);
  if (style === 2) return toHex(b, false);
  return uni ? decodeUtf16(b) : decodeUtf8(b);
}

// Unsigned byte order with the shorter value padded with 0x00 (01 §5.1: 0x01 = 0x0100).
function bytesCmp(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  const long = a.length > b.length ? a : b;
  for (let i = n; i < long.length; i++) if (long[i] !== 0) return long === a ? 1 : -1;
  return 0;
}

// Hash key of a binary value: lower-case hex without trailing 00 pairs, so bytesCmp-equal values share it.
function bytesKey(b) {
  let e = b.length;
  while (e > 0 && b[e - 1] === 0) e--;
  return toHex(e === b.length ? b : b.subarray(0, e), false).toLowerCase();
}

// Big-endian two's complement bytes of an integer in `size` bytes (1, 2, 4 or 8).
function intBytes(v, size) {
  const out = new Uint8Array(size);
  if (size <= 4) {
    let x = v < 0 ? v + 2 ** (size * 8) : v;
    for (let i = size - 1; i >= 0; i--) { out[i] = x % 256; x = Math.floor(x / 256); }
  } else {
    let x = BigInt.asUintN(64, BigInt(Math.trunc(v)));
    for (let i = 7; i >= 0; i--) { out[i] = Number(x & 255n); x >>= 8n; }
  }
  return out;
}

// The integer in the last `size` bytes of b, big-endian two's complement (unsigned for tinyint); a shorter value is
// padded on the left with 0x00 (01 §5.4).
function bytesInt(b, size, unsigned) {
  const start = Math.max(0, b.length - size), n = b.length - start;
  if (size <= 4) {
    let x = 0;
    for (let i = start; i < b.length; i++) x = x * 256 + b[i];
    if (!unsigned && n === size && x >= 2 ** (size * 8 - 1)) x -= 2 ** (size * 8);
    return x;
  }
  let x = 0n;
  for (let i = start; i < b.length; i++) x = (x << 8n) | BigInt(b[i]);
  if (n === 8) x = BigInt.asIntN(64, x);
  const r = Number(x);
  return r === 0 ? 0 : r;
}

// Hex positions of the 16 uniqueidentifier bytes in SQL Server's byte order (01 §5.2, §5.4).
const GUID_BYTES = [6, 4, 2, 0, 11, 9, 16, 14, 19, 21, 24, 26, 28, 30, 32, 34];

function guidBytes(g) {
  const s = String(g).toLowerCase();
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = (hexVal(s.charCodeAt(GUID_BYTES[i])) << 4) | hexVal(s.charCodeAt(GUID_BYTES[i] + 1));
  return out;
}

// The uniqueidentifier of the first 16 bytes of b (padded with 0x00 on the right).
function bytesGuid(b) {
  const c = '00000000-0000-0000-0000-000000000000'.split('');
  for (let i = 0; i < 16 && i < b.length; i++) {
    const h = toHex(b.subarray(i, i + 1), false).toLowerCase();
    c[GUID_BYTES[i]] = h[0];
    c[GUID_BYTES[i] + 1] = h[1];
  }
  return c.join('');
}

// Bytes cut to a binary/varbinary(n) target on the right, binary(n) padded with 0x00 on the right (01 §5.4).
function fitBytes(b, T) {
  if (T.len < 0) return b;
  if (b.length > T.len) return b.slice(0, T.len);
  if (T.fixed && b.length < T.len) {
    const r = new Uint8Array(T.len);
    r.set(b);
    return r;
  }
  return b;
}

// Integer bytes fitted to a target: cut or (binary(n)) padded on the left, keeping the low-order bytes (01 §5.4).
function fitIntBytes(b, T) {
  if (T.len < 0 || (b.length === T.len) || (!T.fixed && b.length < T.len)) return b;
  if (b.length > T.len) return b.slice(b.length - T.len);
  const r = new Uint8Array(T.len);
  r.set(b, T.len - b.length);
  return r;
}

// Base64 text of bytes (FOR JSON, 01 §5.6).
function base64(b) {
  let out = '';
  for (let i = 0; i < b.length; i += 24576) out += btoa(String.fromCharCode.apply(null, b.subarray(i, i + 24576)));
  return out;
}

// --------------------------------------------------------------------------------------- sql_variant

// A sql_variant value: the base value v with its static Type t (frozen); made only by variant().
class SqlVariant {
  constructor(v, t) {
    this.v = v;
    this.t = t;
    Object.freeze(this);
  }
}

const DYN_STR = F({ dt: 'string', len: 4000, unicode: true });
const DYN_BIN = F({ dt: 'binary', len: 8000 });

// The base type of a raw (unwrapped) value of static type 'any', from its JS type: numbers float, booleans bit,
// strings nvarchar(4000), bytes varbinary(8000), Dates datetime (older callers and OPENJSON-style raw values).
function dyn(v) {
  switch (typeof v) {
    case 'number': return [v, ANYNUM];
    case 'boolean': return [v ? 1 : 0, BIT];
    case 'string': return [v, DYN_STR];
    case 'bigint': return [Number(v), BIGINT];
    default:
      if (v instanceof Date) return [v, DATETIME];
      if (isBytes(v)) return [v, DYN_BIN];
      return [objText(v), DYN_STR];
  }
}

// The text of a raw non-scalar value: JSON for a Web API object or array (never '[object Object]'), else String(v).
function objText(v) {
  if (v !== null && typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      if (typeof s === 'string') return s;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
    }
  }
  return String(v);
}

// [base value, base Type] of a value of static type 'any': a SqlVariant's own, else the raw value's JS type.
const unwrap = v => (v instanceof SqlVariant ? [v.v, v.t] : dyn(v));

// A sql_variant holding v with its static type (01 §5); NULL stays null and a sql_variant stays itself. xml,
// binary(max) and the max string types raise 206 (`Operand type clash: nvarchar(max) is incompatible with sql_variant`).
export function variant(v, type) {
  if (v == null) return null;
  if (v instanceof SqlVariant) return v;
  let t = ty(type);
  if (t.dt === 'any' || t.dt === 'null') t = dyn(v)[1];
  if (isMaxLob(t)) throw E(206, clashName(t), 'sql_variant');
  return new SqlVariant(typeof v === 'boolean' ? (v ? 1 : 0) : v, F(pickType(t)));
}

// The base value of a sql_variant (any other value is returned as it is), for formatting consumers (03 §1.1).
export function variantValue(x) {
  return x instanceof SqlVariant ? x.v : x;
}

// The base Type of a sql_variant (a raw value: the Type of its JS type); NULL gives null.
export function variantType(x) {
  if (x == null) return null;
  return x instanceof SqlVariant ? x.t : F(pickType(dyn(x)[1]));
}

// sql_variant data type families (01 §5), higher compares greater: date and time 5 > approximate numeric 4 >
// exact numeric 3 > character 2 > uniqueidentifier 1 > binary 0.
function family(t) {
  switch (t.dt) {
    case 'date': case 'time': case 'datetime': return 5;
    case 'float': return 4;
    case 'decimal': case 'money': case 'int': case 'bigint': case 'bit': return 3;
    case 'string': return 2;
    case 'guid': return 1;
    default: return 0;
  }
}

// [ms, tk] of a date-family base value: a date its UTC midnight, a time 1900-01-01 plus the time (UTC), a datetime
// its instant. Within the family values compare as these instants, so cmp, eq, keyOf and sortKey agree (exactly
// SQL Server's conversion to the higher type when the session tz is UTC).
function familyInstant(v, t) {
  if (t.dt === 'time') {
    const p = timeParts(v), f = +p.frac7;
    return [W1900 + p.h * 3600000 + p.mi * 60000 + p.s * 1000 + Math.floor(f / 10000), f % 10000];
  }
  return [v.getTime(), v.tk || 0];
}

// The family-first sql_variant order (01 §5).
function variantCmp(a, b, ai) {
  const [va, ta] = unwrap(a), [vb, tb] = unwrap(b);
  const fa = family(ta), fb = family(tb);
  if (fa !== fb) return fa < fb ? -1 : 1;
  switch (fa) {
    case 5: {
      const [ma, ka] = familyInstant(va, ta), [mb, kb] = familyInstant(vb, tb);
      return ma < mb ? -1 : ma > mb ? 1 : ka < kb ? -1 : ka > kb ? 1 : 0;
    }
    case 4: case 3: return va < vb ? -1 : va > vb ? 1 : 0;
    case 2: return strCmp(va, vb, collOf(ai));
    case 1: return guidCmp(String(va), String(vb));
    default: return bytesCmp(va, vb);
  }
}

// ---------------------------------------------------------------------------------------------- xml

const XML_CACHE = new Map();
const XML_CACHE_MAX = 64;
const XML_CACHE_UNITS = 4000000;
let xmlCacheUnits = 0;
const isXmlWs = s => /^[ \t\r\n]*$/.test(s);

// Parses the text of an xml value with core/xml.js parseXml in mixed mode: a #document node whose kids are the
// top-level nodes (a fragment: any sequence of elements, text, comments and PIs, or nothing; the XML declaration is
// accepted at the start). A malformed text, a DTD, an undeclared entity or prefix raises 9400 'XML parsing: line
// <l>, character <c>, <reason>' with parseXml's line, col and reason (01 §5.8).
function parseValue(text) {
  try {
    return parseXml(text, { mixed: true });
  } catch (e) {
    if (!(e instanceof SqlError) || e.number != null) throw e;
    const reason = e.reason ?? String(e.message).replace(/^Invalid [A-Za-z]+: /, '').replace(/ at line \d+, column \d+\.$/, '');
    throw E(9400, e.line ?? 1, e.col ?? 1, reason);
  }
}

// The serialised form of a parsed #document `doc` (01 §5.8): names and prefixes as written, attribute values in
// double quotes, text and attributes escaped with xmlEsc ('text' / 'attr'), empty elements as <x/>, comments and PIs
// kept. Text nodes that are only whitespace are dropped unless keepWs (CONVERT style 1) or inside an
// xml:space="preserve" scope. In the same pass doc is pruned in place to the tree parseXml gives for the serialised
// text: each node's kids become the nodes written (dropped text nodes leave, adjacent text merges into the first) and
// each element's and the document's `text` the character data written for it. The tree must be one parseValue just
// made (never a cached, shared one). Iterative (an explicit stack), so any nesting depth serialises.
function serialise(doc, keepWs) {
  const out = [];
  const stack = [{ node: doc, kids: doc.kids, i: 0, ws: keepWs, name: null, tag: -1, has: false, kept: [], text: '' }];
  // The first content of an element closes its start tag with '>'; an element without content ends with '/>'.
  const content = fr => {
    if (fr.name != null && !fr.has) { out[fr.tag] += '>'; fr.has = true; }
  };
  while (stack.length) {
    const fr = stack[stack.length - 1];
    if (fr.i >= fr.kids.length) {
      stack.pop();
      fr.node.kids = fr.kept;
      fr.node.text = fr.text;
      if (fr.name != null) {
        if (fr.has) out.push('</' + fr.name + '>');
        else out[fr.tag] += '/>';
      }
      continue;
    }
    const k = fr.kids[fr.i++];
    if (k.name === '#text') {
      let t = k.text;
      while (fr.i < fr.kids.length && fr.kids[fr.i].name === '#text') t += fr.kids[fr.i++].text;
      if (t !== '' && (fr.ws || !isXmlWs(t))) {
        content(fr);
        out.push(xmlEsc(t, 'text'));
        if (k.text !== t) k.text = t;
        fr.kept.push(k);
        fr.text += t;
      }
    } else if (k.name === '#comment') {
      content(fr);
      out.push('<!--' + k.text + '-->');
      fr.kept.push(k);
    } else if (k.name === '#pi') {
      content(fr);
      out.push('<?' + k.target + (k.text ? ' ' + k.text : '') + '?>');
      fr.kept.push(k);
    } else {
      content(fr);
      let tag = '<' + k.name, ws = fr.ws;
      for (const [n, v] of k.attrs) {
        tag += ' ' + n + '="' + xmlEsc(v, 'attr') + '"';
        if (n === 'xml:space') ws = v === 'preserve' ? true : v === 'default' ? keepWs : ws;
      }
      out.push(tag);
      fr.kept.push(k);
      stack.push({ node: k, kids: k.kids || [], i: 0, ws, name: k.name, tag: out.length - 1, has: false, kept: [], text: '' });
    }
  }
  return out.join('');
}

// Puts the parsed document d of the xml value s into the bounded cache: the last 64 values, and at most 4,000,000
// UTF-16 units of text in all (the newest value always stays), least recently used out.
function cacheDoc(s, d) {
  if (XML_CACHE.delete(s)) xmlCacheUnits -= s.length;
  while (XML_CACHE.size && (XML_CACHE.size >= XML_CACHE_MAX || xmlCacheUnits + s.length > XML_CACHE_UNITS)) {
    const old = XML_CACHE.keys().next().value;
    XML_CACHE.delete(old);
    xmlCacheUnits -= old.length;
  }
  XML_CACHE.set(s, d);
  xmlCacheUnits += s.length;
}

// The serialised xml value of a text (01 §5.8; CAST/CONVERT and implicit conversion to xml): parsed with core/xml.js
// parseXml (mixed mode) and serialised; '' is the empty value. preserveSpace (CONVERT(xml, s, 1)) keeps text nodes
// that are only whitespace. A malformed text, a DTD, an undeclared entity or prefix raises 9400. The document is
// cached for xmlDoc under the serialised text, so an xml method on the result does not parse it again (01 §8.3).
export function xmlValue(text, { preserveSpace = false } = {}) {
  const s = String(text);
  if (s === '') return '';
  const doc = parseValue(s);
  const v = serialise(doc, !!preserveSpace);
  cacheDoc(v, doc);
  return v;
}

// The parsed document of an xml value (01 §5.8, §8.3): parseXml's mixed-mode #document node, whose kids are the
// value's top-level nodes (each node with its non-enumerable `parent`), kept in a bounded cache of the last 64
// values (xmlValue puts the values it makes there). The nodes are shared: callers must not change them.
export function xmlDoc(v) {
  const s = String(v);
  let d = XML_CACHE.get(s);
  if (d) {
    XML_CACHE.delete(s);
    XML_CACHE.set(s, d);
    return d;
  }
  d = parseValue(s);
  cacheDoc(s, d);
  return d;
}

// The text of a binary value converted to xml: UTF-16LE when it starts with FF FE, otherwise UTF-8 (01 §5.8).
const xmlBytesText = b => (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE ? decodeUtf16(b, 2) : decodeUtf8(b));

// ------------------------------------------------------------------------------------------ dates & tz

const DAY = 86400000;
const W1900 = -2208988800000;
const W1753 = -6847804800000;
const W0001 = -62135596800000;
const W10000 = 253402300800000;
const W2079 = 3453321540000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const p2 = n => (n < 10 ? '0' : '') + n;
const s2 = n => (n < 10 ? ' ' : '') + n;
const p3 = n => (n < 10 ? '00' : n < 100 ? '0' : '') + n;
const p4 = y => String(y).padStart(4, '0');
const offOf = (tz, ms) => (!tz || tz.utc ? 0 : tz.offset(ms));
const offStr = off => (off < 0 ? '-' : '+') + p2(Math.floor(Math.abs(off) / 60)) + ':' + p2(Math.abs(off) % 60);
// The 100-ns ticks below the millisecond of a datetime2/datetimeoffset value (01 §5).
const tkOf = d => d.tk || 0;

// Number of days in month m (1-12) of year y (proleptic Gregorian).
export function daysInMonth(y, m) {
  return m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function wallOf(p) {
  const t = new Date(0);
  t.setUTCFullYear(p.y, (p.m ?? 1) - 1, p.d ?? 1);
  t.setUTCHours(p.h ?? 0, p.mi ?? 0, p.s ?? 0, p.ms ?? 0);
  return t.getTime();
}

// Wall-clock milliseconds of a Date: its instant plus its own tzo, or plus tz.offset at the instant (01 §5.3).
export function wallMs(d, tz) {
  const ms = d.getTime();
  return ms + (d.tzo ?? offOf(tz, ms)) * 60000;
}

// Session-tz wall-clock milliseconds of a datetime value for a FetchXML condition on a TimeZoneIndependent or DateOnly
// column (01 §5.3, 02 §4.2), which must keep the rows the client comparison (by instant) keeps: a UTC value (own
// tzo 0) and a datetimeoffset give the session fields of their instant; a DST-gap value (another own tzo on a
// non-datetimeoffset type) keeps its written wall-clock time; a date value gives its UTC midnight.
export function sessionWallMs(d, type, tz) {
  const t = ty(type), ms = d.getTime();
  if (t.dt === 'date') return ms;
  if (!t.dto && d.tzo != null && d.tzo !== 0) return ms + d.tzo * 60000;
  return ms + offOf(tz, ms) * 60000;
}

// Instant (ms) for wall-clock milliseconds W in tz: overlaps take the earlier offset, gaps move forward (01 §5.5).
export function fromWall(W, tz) {
  return wallPair(W, tz).ms;
}

// The SQL Server AT TIME ZONE rule (01 §5.5) with a = offset at W - 18 h and b = offset at W + 18 h: two probes when
// they agree; an offset o is valid when the offset at W - o is o; both valid (overlap) -> a; neither (gap) -> W - a,
// and then tzo = a keeps the wall-clock time W.
function wallPair(W, tz) {
  if (!tz || tz.utc) return { ms: W, tzo: null };
  const a = tz.offset(W - 64800000), b = tz.offset(W + 64800000);
  if (a === b || tz.offset(W - a * 60000) === a) return { ms: W - a * 60000, tzo: null };
  if (tz.offset(W - b * 60000) === b) return { ms: W - b * 60000, tzo: null };
  return { ms: W - a * 60000, tzo: a };
}

// A Date of instant ms with own offset tzo (when not null) and ticks tk (when not 0).
function mkDt(ms, tzo, tk = 0) {
  const d = new Date(ms);
  if (tzo != null) d.tzo = tzo === 0 ? 0 : tzo;
  if (tk) d.tk = tk;
  return d;
}

// A typed datetime value for session wall-clock ms W: gap wall-clock times keep W in an own tzo (01 §5).
function keepWall(W, tz, tk = 0) {
  const { ms, tzo } = wallPair(W, tz);
  return mkDt(ms, tzo, tk);
}

// Calendar fields of a Date in tz (honours d.tzo and d.tk): {y, m, d, h, mi, s, ms, tk, dow, off}.
export function dateParts(d, tz) {
  const ms = d.getTime();
  const off = d.tzo ?? offOf(tz, ms);
  const w = new Date(ms + off * 60000);
  return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate(), h: w.getUTCHours(), mi: w.getUTCMinutes(),
    s: w.getUTCSeconds(), ms: w.getUTCMilliseconds(), tk: tkOf(d), dow: w.getUTCDay(), off };
}

// Date for wall-clock fields {y, m (1-12), d, h, mi, s, ms, tk?} in tz (built with setUTCFullYear, years 1-9999).
export function fromParts(p, tz) {
  return keepWall(wallOf(p), tz, p.tk ? Math.trunc(p.tk) : 0);
}

// A new Date of the same instant with own property tzo (minutes east of UTC, 01 §5.5) and the same tk.
export function withOffset(d, tzo) {
  return mkDt(d.getTime(), tzo, tkOf(d));
}

// A new Date of the same instant with own property tk (100-ns ticks below the millisecond, 0..9999; 0 leaves it
// out) and the same tzo (01 §5).
export function withTicks(d, tk) {
  if (!Number.isInteger(tk) || tk < 0 || tk > 9999) throw new RangeError(`withTicks: tk must be an integer 0..9999, got ${String(tk)}`);
  return mkDt(d.getTime(), d.tzo ?? null, tk);
}

function utcDate(y, m, d) {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t;
}

const TIMEV_RE = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/;

// Fields of a time value: {h, mi, s, frac7} (all seven fraction digits).
function timeParts(v) {
  const m = TIMEV_RE.exec(v);
  if (m) return { h: +m[1], mi: +m[2], s: +m[3], frac7: (m[4] || '').padEnd(7, '0') };
  const p = parseFields(String(v), {});
  return { h: p.h, mi: p.mi, s: p.s, frac7: p.frac7 };
}

// A 7-digit fraction f (100-ns units of the second) fitted to the datetime target T, rounded once (01 §5.3):
// [ms (1000 carries into the next second), tk]. datetime rounds to 1/300 s (.000, .003, .007); datetime2(n) and
// datetimeoffset(n) round half up to n digits; smalldatetime keeps the milliseconds for its minute rounding (roundMs).
function fracFit(f, T) {
  if (T.small) return [Math.floor(f / 10000), 0];
  const n = T.prec ?? (T.dto ? 7 : null);
  if (n == null) return [Math.round((Math.round((f * 3) / 100000) * 10) / 3), 0];
  const u = 10 ** (7 - n);
  const r = Math.floor((f + u / 2) / u) * u;
  return [Math.floor(r / 10000), r % 10000];
}

// 'hh:mm:ss[.f…]' with prec fraction digits, rounded half up (wrapping at midnight).
function timeStr(h, mi, s, frac7, prec) {
  let keep = frac7.slice(0, prec);
  if (prec < 7 && frac7.charCodeAt(prec) >= 53) {
    const inc = incDigits(keep || '0');
    if (inc.length > prec || prec === 0) {
      keep = prec ? inc.slice(1) : '';
      s++;
      if (s === 60) { s = 0; mi++; if (mi === 60) { mi = 0; h = (h + 1) % 24; } }
    } else keep = inc.padStart(prec, '0');
  }
  return p2(h) + ':' + p2(mi) + ':' + p2(s) + (prec ? '.' + keep : '');
}

function timeNorm(v) {
  const m = TIMEV_RE.exec(v);
  return m ? `${m[1]}:${m[2]}:${m[3]}.${(m[4] || '').padEnd(7, '0')}` : v;
}

// ------------------------------------------------------------------------------------------ date parsing

const STYLE_ORDER = new Map([[1, 'mdy'], [101, 'mdy'], [10, 'mdy'], [110, 'mdy'], [22, 'mdy'], [3, 'dmy'], [103, 'dmy'],
  [4, 'dmy'], [104, 'dmy'], [5, 'dmy'], [105, 'dmy'], [2, 'ymd'], [102, 'ymd'], [11, 'ymd'], [111, 'ymd']]);
const ORDERS = new Set(['mdy', 'dmy', 'ymd', 'ydm', 'myd', 'dym']);
const DATE_STYLES = new Set([0, 100, 1, 101, 2, 102, 3, 103, 4, 104, 5, 105, 6, 106, 7, 107, 8, 108, 24, 9, 109, 10, 110,
  11, 111, 12, 112, 13, 113, 14, 114, 20, 120, 21, 121, 25, 22, 23, 126, 127]);
const BIN_STYLES = new Set([0, 1, 2]);
const XML_STYLES = new Set([0, 1, 2, 3]);
const TZ_TAIL = /([+-])(\d{1,2}):(\d{2})$/;
const TIME_RE = /^(\d{1,2})(?::(\d{1,2})(?::(\d{1,2})(?::(\d{1,3})|\.(\d+))?)?)?[ \t\r\n]*([AaPp][Mm])?$/;
const NUM_DATE_RE = /^(\d{1,4})([/.-])(\d{1,4})\2(\d{1,4})$/;
const ISO_T_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[Tt](.+)$/;
const COMPACT_T_RE = /^(\d{8})[Tt](.+)$/;
const ALPHA_RE = /[A-Za-z]{3}/;
const WS_RE = /[ \t\r\n]+/;
const ZERO_TIME = Object.freeze({ h: 0, mi: 0, s: 0, ms: 0, frac7: '0000000', nd: 0 });
const yy2 = n => (n < 50 ? 2000 + n : 1900 + n);
const isDig = c => c >= 48 && c <= 57;
const isLet = c => (c | 32) >= 97 && (c | 32) <= 122;
// Separators between the parts of an alphabetic date (01 §5.3 (3)): blanks, ',', '-', '/' and '.'.
const isDateSep = c => isWs(c) || c === 44 || c === 45 || c === 47 || c === 46;

// A time `h[:mm[:ss[:mmm|.f…]]][ ][AM|PM]` (01 §5.3 (4)): {h, mi, s, ms, frac7, nd (fraction digits written)} or null.
function parseTime(str) {
  const m = TIME_RE.exec(str);
  if (!m) return null;
  if (m[2] == null && !m[6]) return null;
  let h = +m[1];
  const mi = m[2] == null ? 0 : +m[2], s = m[3] == null ? 0 : +m[3];
  let frac7 = '0000000', nd = 0;
  if (m[4] != null) { frac7 = m[4].padStart(3, '0') + '0000'; nd = 3; }
  else if (m[5] != null) { if (m[5].length > 7) return null; frac7 = m[5].padEnd(7, '0'); nd = m[5].length; }
  if (m[6]) {
    if (h > 12) return null;
    const pm = m[6][0] === 'P' || m[6][0] === 'p';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) { if (h === 0) return null; h += 12; }
  }
  if (h > 23 || mi > 59 || s > 59) return null;
  return { h, mi, s, frac7, nd, ms: Math.floor(+frac7 / 10000) };
}

// The explicit offset that ends a trimmed date/time string (01 §5.3: `Z` after a digit, or `[blanks]±hh:mm`):
// {m: null for Z | the [sign, hh, mm] match, end: where the date/time text ends}, or null. Only the last six
// characters are matched and the blanks before the sign are skipped by an index scan, so this is linear.
function tzSuffix(r) {
  const n = r.length;
  const last = r.charCodeAt(n - 1);
  if ((last === 90 || last === 122) && n > 1) {
    const c = r.charCodeAt(n - 2);
    if (c >= 48 && c <= 57) return { m: null, end: n - 1 };
  }
  const tail = n > 6 ? r.slice(n - 6) : r;
  const m = TZ_TAIL.exec(tail);
  if (!m) return null;
  let end = n - tail.length + m.index;
  while (end > 0 && isWs(r.charCodeAt(end - 1))) end--;
  return { m, end };
}

function monthNum(w) {
  const x = w.toLowerCase();
  if (x.length < 3) return 0;
  if (x === 'sept') return 9;
  for (let i = 0; i < 12; i++) if (MONTHS[i] === x || (x.length === 3 && MONTHS[i].startsWith(x))) return i + 1;
  return 0;
}

// [y, m, d] of a numeric date's three parts p (01 §5.3 (2)): a 4-digit part is the year; `yyyy-MM-dd` with a
// two-digit month and day is the ISO form (1), always year-month-day; every other form, whatever its separator, is
// read in the DATEFORMAT order (a 4-digit first part under ydm is year-day-month).
function numericDate(p, sep, order) {
  const L = p.map(x => x.length);
  if (L.includes(3) || L.filter(n => n === 4).length > 1) throw E241();
  if (L[0] === 4) return (sep === '-' && L[1] === 2 && L[2] === 2) || order !== 'ydm' ? [+p[0], +p[1], +p[2]] : [+p[0], +p[2], +p[1]];
  const yi = L.indexOf(4);
  const mFirst = order.indexOf('m') < order.indexOf('d');
  if (yi >= 0) {
    const o = [0, 1, 2].filter(i => i !== yi);
    return mFirst ? [+p[yi], +p[o[0]], +p[o[1]]] : [+p[yi], +p[o[1]], +p[o[0]]];
  }
  const v = Object.create(null);
  for (let i = 0; i < 3; i++) v[order[i]] = +p[i];
  return [yy2(v.y), v.m, v.d];
}

// Whether an AM/PM designator (after optional blanks) starts at index j of r and ends a word.
function amPmAt(r, j) {
  while (j < r.length && isWs(r.charCodeAt(j))) j++;
  const a = r.charCodeAt(j) | 32, b = r.charCodeAt(j + 1) | 32;
  return (a === 97 || a === 112) && b === 109 && !isLet(r.charCodeAt(j + 2));
}

// An alphabetic date (01 §5.3 (3)): an English month name (full or 3 letters, any case) and one or two numbers, in
// any of SQL Server's orders, separated by any mix of blanks, ',', '-', '/' and '.' or by nothing between the month
// name and digits; then an optional time. With two numbers, a 4-digit first number is the year and the second the
// day, otherwise the first is the day and the second the year (2 or 4 digits); one number is a 4-digit year (day 1).
// The forms mon [dd][,] yyyy, mon dd[,] yy, mon yyyy [dd], dd mon[,] [yy]yy, dd [yy]yy mon, yyyy mon [dd] and
// yyyy [dd] mon all follow from this rule. DATEFORMAT does not apply. One linear scan.
function alphaFields(r) {
  const nums = [];
  let mon = 0, timeAt = -1, i = 0;
  const n = r.length;
  while (i < n) {
    const c = r.charCodeAt(i);
    if (isDig(c)) {
      let j = i;
      while (j < n && isDig(r.charCodeAt(j))) j++;
      if (r.charCodeAt(j) === 58 || amPmAt(r, j)) { timeAt = i; break; }
      if (nums.length === 2) throw E241();
      nums.push(r.slice(i, j));
      i = j;
    } else if (isLet(c)) {
      let j = i;
      while (j < n && isLet(r.charCodeAt(j))) j++;
      const mo = monthNum(r.slice(i, j));
      if (!mo || mon) throw E241();
      mon = mo;
      i = j;
    } else if (isDateSep(c)) i++;
    else throw E241();
  }
  if (!mon || !nums.length) throw E241();
  let y, d = 1;
  if (nums.length === 1) {
    if (nums[0].length !== 4) throw E241();
    y = +nums[0];
  } else if (nums[0].length === 4) {
    if (nums[1].length > 2) throw E241();
    y = +nums[0];
    d = +nums[1];
  } else {
    if (nums[0].length > 2 || (nums[1].length !== 2 && nums[1].length !== 4)) throw E241();
    d = +nums[0];
    y = nums[1].length === 2 ? yy2(+nums[1]) : +nums[1];
  }
  const tm = timeAt < 0 ? ZERO_TIME : parseTime(trimWs(r.slice(timeAt)));
  if (!tm) throw E241();
  return [y, mon, d, tm];
}

// Wall-clock fields of a date/time string (01 §5.3 formats): {y, m, d, h, mi, s, ms, frac7, nd, tzo}.
function parseFields(s, o) {
  const t = trimWs(s);
  if (t === '') return { y: 1900, m: 1, d: 1, h: 0, mi: 0, s: 0, ms: 0, frac7: '0000000', nd: 0, tzo: null };
  let r = t, tzo = null;
  const z = tzSuffix(r);
  if (z) {
    if (z.m) {
      const hh = +z.m[2], mm = +z.m[3];
      if (hh > 14 || mm > 59 || hh * 60 + mm > 840) throw E241();
      tzo = (z.m[1] === '-' ? -1 : 1) * (hh * 60 + mm);
      if (tzo === 0) tzo = 0;
    } else tzo = 0;
    r = r.slice(0, z.end);
    if (!r) throw E241();
  }
  const order = STYLE_ORDER.get(o.style) || (ORDERS.has(o.dateformat) ? o.dateformat : 'mdy');
  let y, m, d, rest, tm;
  let x;
  if ((x = ISO_T_RE.exec(r))) { y = +x[1]; m = +x[2]; d = +x[3]; rest = x[4]; }
  else if ((x = COMPACT_T_RE.exec(r))) { y = +x[1].slice(0, 4); m = +x[1].slice(4, 6); d = +x[1].slice(6); rest = x[2]; }
  else if (ALPHA_RE.test(r)) { [y, m, d, tm] = alphaFields(r); }
  else {
    const toks = r.split(WS_RE);
    const t0 = toks[0];
    if ((x = NUM_DATE_RE.exec(t0))) { [y, m, d] = numericDate([x[1], x[3], x[4]], x[2], order); rest = toks.slice(1).join(' '); }
    else if (/^\d+$/.test(t0) && (t0.length === 8 || t0.length === 6 || (t0.length === 4 && !/^[AaPp][Mm]$/.test(toks[1] || '')))) {
      if (t0.length === 8) { y = +t0.slice(0, 4); m = +t0.slice(4, 6); d = +t0.slice(6); }
      else if (t0.length === 6) { y = yy2(+t0.slice(0, 2)); m = +t0.slice(2, 4); d = +t0.slice(4); }
      else { y = +t0; m = 1; d = 1; }
      rest = toks.slice(1).join(' ');
    } else { y = 1900; m = 1; d = 1; rest = r; }
  }
  if (!tm) {
    tm = rest ? parseTime(trimWs(rest)) : ZERO_TIME;
    if (!tm) throw E241();
  }
  if (!(y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m))) throw E241();
  return { y, m, d, h: tm.h, mi: tm.mi, s: tm.s, ms: tm.ms, frac7: tm.frac7, nd: tm.nd, tzo };
}

// Parses a date/time string (01 §5.3) in the session tz and DATEFORMAT; 241 on failure. The result has an own tzo
// exactly when s has an explicit Z/±hh:mm, and an own tk when s has more than 3 fraction digits (all 7 kept).
// Without an offset the wall-clock time is resolved with fromWall (an overlap takes the earlier offset, a DST-gap
// time moves forward).
export function parseDate(s, opts = {}) {
  if (opts.style != null && !DATE_STYLES.has(opts.style)) throw E(281, opts.style, 'to datetime');
  const p = parseFields(String(s), opts);
  const W = wallOf(p);
  const tk = +p.frac7.slice(3);
  if (p.tzo != null) return mkDt(W - p.tzo * 60000, p.tzo, tk);
  return mkDt(fromWall(W, opts.tz), null, tk);
}

// ------------------------------------------------------------------------------------- date formatting

function tfields(v, f, tz) {
  if (f.dt === 'time') {
    const t = timeParts(v);
    const nd = f.prec ?? 7;
    return { y: 1900, m: 1, d: 1, h: t.h, mi: t.mi, s: t.s, frac: t.frac7.slice(0, nd), nd, colon: false, off: null, kind: 'time' };
  }
  if (f.dt === 'date') {
    return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate(), h: 0, mi: 0, s: 0, frac: '000', nd: 3, colon: true, off: null, kind: 'date' };
  }
  const ms = v.getTime();
  const off = v.tzo ?? offOf(tz, ms);
  const w = new Date(ms + off * 60000);
  const n = dtPrec(f);
  const nd = n ?? 3;
  return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate(), h: w.getUTCHours(), mi: w.getUTCMinutes(),
    s: w.getUTCSeconds(), frac: (p3(w.getUTCMilliseconds()) + p4(tkOf(v))).slice(0, nd), nd, colon: n == null,
    off: f.dto ? off : null, kind: 'dt' };
}

function fmtTemporal(v, f, style, tz) {
  const x = tfields(v, f, tz);
  const yy = p2(x.y % 100), yyyy = p4(x.y), mm = p2(x.m), dd = p2(x.d), mon = MON[x.m - 1];
  const HH = p2(x.h), MI = p2(x.mi), SS = p2(x.s), h12 = x.h % 12 || 12, ap = x.h < 12 ? 'AM' : 'PM';
  const dotf = x.nd > 0 ? '.' + x.frac : '';
  const msf = x.colon ? ':' + x.frac : dotf;
  const offs = x.off == null ? '' : offStr(x.off);
  const isoFrac = /^0*$/.test(x.frac) ? '' : '.' + x.frac;
  if (style == null) {
    if (x.kind === 'date') return `${yyyy}-${mm}-${dd}`;
    if (x.kind === 'time') return `${HH}:${MI}:${SS}${dotf}`;
    if (dtPrec(f) != null) return `${yyyy}-${mm}-${dd} ${HH}:${MI}:${SS}${dotf}${offs && ' ' + offs}`;
    style = 0;
  }
  switch (style) {
    case 0: case 100: return x.kind === 'time' ? `${s2(h12)}:${MI}${ap}` : `${mon} ${s2(x.d)} ${yyyy} ${s2(h12)}:${MI}${ap}`;
    case 1: return `${mm}/${dd}/${yy}`;
    case 101: return `${mm}/${dd}/${yyyy}`;
    case 2: return `${yy}.${mm}.${dd}`;
    case 102: return `${yyyy}.${mm}.${dd}`;
    case 3: return `${dd}/${mm}/${yy}`;
    case 103: return `${dd}/${mm}/${yyyy}`;
    case 4: return `${dd}.${mm}.${yy}`;
    case 104: return `${dd}.${mm}.${yyyy}`;
    case 5: return `${dd}-${mm}-${yy}`;
    case 105: return `${dd}-${mm}-${yyyy}`;
    case 6: return `${dd} ${mon} ${yy}`;
    case 106: return `${dd} ${mon} ${yyyy}`;
    case 7: return `${mon} ${dd}, ${yy}`;
    case 107: return `${mon} ${dd}, ${yyyy}`;
    case 8: case 24: case 108: return `${HH}:${MI}:${SS}`;
    case 9: case 109: return `${mon} ${s2(x.d)} ${yyyy} ${s2(h12)}:${MI}:${SS}${msf}${ap}`;
    case 10: return `${mm}-${dd}-${yy}`;
    case 110: return `${mm}-${dd}-${yyyy}`;
    case 11: return `${yy}/${mm}/${dd}`;
    case 111: return `${yyyy}/${mm}/${dd}`;
    case 12: return `${yy}${mm}${dd}`;
    case 112: return `${yyyy}${mm}${dd}`;
    case 13: case 113: return `${dd} ${mon} ${yyyy} ${HH}:${MI}:${SS}${msf}`;
    case 14: case 114: return `${HH}:${MI}:${SS}${msf}`;
    case 20: case 120: return `${yyyy}-${mm}-${dd} ${HH}:${MI}:${SS}${offs && ' ' + offs}`;
    case 21: case 25: case 121: return `${yyyy}-${mm}-${dd} ${HH}:${MI}:${SS}${dotf}${offs && ' ' + offs}`;
    case 22: return `${mm}/${dd}/${yy} ${s2(h12)}:${MI}:${SS} ${ap}`;
    case 23: return `${yyyy}-${mm}-${dd}`;
    case 126: case 127: {
      if (x.kind === 'date') return `${yyyy}-${mm}-${dd}`;
      if (x.kind === 'time') return `${HH}:${MI}:${SS}${isoFrac}`;
      // 127 writes a datetimeoffset as its UTC instant with 'Z'; every other type gets the 126 text (SQL Server)
      if (style === 126 || !f.dto) return `${yyyy}-${mm}-${dd}T${HH}:${MI}:${SS}${isoFrac}${offs}`;
      const u = tfields(mkDt(v.getTime(), null, tkOf(v)), { dt: 'datetime', prec: dtPrec(f) }, null);
      const uf = /^0*$/.test(u.frac) ? '' : '.' + u.frac;
      return `${p4(u.y)}-${p2(u.m)}-${p2(u.d)}T${p2(u.h)}:${p2(u.mi)}:${p2(u.s)}${uf}Z`;
    }
    default: throw E(281, style, `from ${msgName(f)} to a character string`);
  }
}

// Text of a value as CAST to varchar/PRINT/CONCAT/+/STRING_AGG produce it (01 §5.4, §5.5); NULL gives null. A
// sql_variant is formatted by its base type, binary by its bytes (style 1/2: hex), xml as its serialised text.
export function toSqlString(v, type, opts = {}) {
  if (v == null) return null;
  let f = ty(type);
  if (f.dt === 'any' || f.dt === 'null') [v, f] = unwrap(v);
  switch (f.dt) {
    case 'string': case 'xml': return v;
    case 'guid': return String(v).toLowerCase();
    case 'binary': return binText(v, opts.style, false);
    case 'date': case 'datetime': case 'time': return fmtTemporal(v, f, opts.style, opts.tz);
    default: return numStr(v, f, opts.style);
  }
}

// The Raw ISO text of a date/time value (03 §1.1 formatCell and sqlLit): 'yyyy-MM-ddTHH:mm:ss.fff±hh:mm' at the
// value's wall-clock time in tz (own tzo honoured); 'Z' in UTC mode for a value without own offset, a datetimeoffset
// always ±hh:mm; n fraction digits for a datetime2(n)/datetimeoffset(n) value (n > 3) that carries ticks, none
// with {ms: false}, and no offset with {offset: false} (TimeZoneIndependent). date: 'yyyy-MM-dd'; time:
// 'hh:mm:ss[.fffffff]' (its prec digits). NULL gives null.
export function isoText(v, type, tz, { ms = true, offset = true } = {}) {
  if (v == null) return null;
  let t = ty(type);
  if (t.dt === 'any' || t.dt === 'null') [v, t] = unwrap(v);
  if (t.dt === 'time') {
    const x = timeParts(v), nd = t.prec ?? 7;
    return `${p2(x.h)}:${p2(x.mi)}:${p2(x.s)}${ms && nd ? '.' + x.frac7.slice(0, nd) : ''}`;
  }
  if (!(v instanceof Date)) throw new TypeError(`isoText: expected a Date for ${typeName(t)}, got ${typeof v}`);
  if (t.dt === 'date') return `${p4(v.getUTCFullYear())}-${p2(v.getUTCMonth() + 1)}-${p2(v.getUTCDate())}`;
  const p = dateParts(v, tz);
  const n = dtPrec(t);
  // milliseconds, or n digits for a datetime2(n)/datetimeoffset(n) value (n > 3) that carries ticks (03 §7)
  const digits = p.tk && n != null && n > 3 ? n : 3;
  const frac = ms ? '.' + (p3(p.ms) + p4(p.tk)).slice(0, digits) : '';
  const off = !offset ? '' : t.dto ? offStr(p.off) : (!tz || tz.utc) && v.tzo == null ? 'Z' : offStr(p.off);
  return `${p4(p.y)}-${p2(p.m)}-${p2(p.d)}T${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}${frac}${off}`;
}

// The Raw float text (03 §1.1): at most 15 significant digits, String(Number(x.toPrecision(15))); -0 gives '0'. The
// largest doubles, whose 15-digit rounding overflows, give the rounded digits as text ('1.79769313486232e+308').
export function floatText15(x) {
  const n = Number(x);
  const r = Number(n.toPrecision(15));
  if (r === 0) return '0';
  if (Number.isFinite(r) || !Number.isFinite(n)) return String(r);
  return n.toPrecision(15).replace(/\.?0+e/, 'e');
}

// ----------------------------------------------------------------------------------------- conversions

function notAllowed(f, T, imp) {
  return imp ? E(206, clashName(f), T.name) : E(529, msgName(f), T.name);
}

function implicitDt(f, T) {
  return E(257, msgName(f), T.name);
}

const srcConv = f => (f.dt === 'string' ? vname(f) : f.dt === 'datetime' ? dtKind(f) : msgName(f));
// The days since 1900-01-01 of a datetime/smalldatetime value's session wall-clock time, computed as SQL Server
// and SQL 4 CDS do: the time of day on its 1/300 s grid as 100-ns ticks, times the double 1 / 864,000,000,000 ticks
// per day (2024-10-04 12:01:00 -> 45567.500694444439, not the nearest double 45567.500694444447).
function dtDays(v, o) {
  const x = wallMs(v, o.tz) - W1900;
  const day = Math.floor(x / DAY);
  const t300 = Math.round((x - day * DAY) * 0.3);
  return (day * 864000000000 + Math.round((t300 * 10000000) / 300)) * (1 / 864000000000);
}

function numText(v, f) {
  return f.dt === 'float' ? plainNum(v) : numStr(v, f);
}

function fin(x, T, o) {
  if (x === 0) return 0;
  if (T.big && !Number.isSafeInteger(x) && o.warn) o.warn(BIGINT_LOSS);
  return x;
}

const inRange = (x, T) => x >= T.lo && (T.big ? x < 9223372036854775808 : x <= T.hi);

function toInt(v, f, T, o, imp) {
  let x;
  switch (f.dt) {
    case 'int': case 'bigint': case 'bit': x = v; break;
    case 'decimal': x = Math.trunc(v); break;
    case 'money': x = roundDec(v, 0); break;
    case 'float':
      x = Math.trunc(v);
      if (!inRange(x, T)) throw T.small ? E(220, T.name, plainNum(v)) : E(232, T.name, fixed6(v));
      return fin(x, T, o);
    case 'string': {
      const t = trimWs(v);
      if (t === '') return 0;
      if (!INT_RE.test(t)) throw E(245, vname(f), v, T.name);
      const big = BigInt(t);
      if (big < T.blo || big > T.bhi) {
        if (T.small) throw E(220, T.name, t);
        if (T.big) throw E(8114, vname(f), 'bigint');
        throw E(248, vname(f), v);
      }
      return fin(Number(big), T, o);
    }
    case 'binary': return fin(bytesInt(v, T.size, T.unsigned), T, o);
    case 'datetime':
      if (!isPlainDt(f)) throw notAllowed(f, T, imp);
      if (imp) throw implicitDt(f, T);
      // the days since 1900, rounded to the nearest day with 12:00 or later rounding up
      x = Math.floor(dtDays(v, o) + 0.5);
      break;
    default: throw notAllowed(f, T, imp);
  }
  // 220 names the value converted: the number written, or the day count a datetime gave
  if (!inRange(x, T)) throw T.small ? E(220, T.name, f.dt === 'datetime' ? intStr(x) : numText(v, f)) : E(8115, 'expression', T.name);
  return fin(x, T, o);
}

function toBit(v, f, T, o, imp) {
  switch (f.dt) {
    case 'bit': return v;
    case 'int': case 'bigint': case 'decimal': case 'money': case 'float': return v !== 0 ? 1 : 0;
    case 'string': {
      const t = trimWs(v);
      if (t === '') return 0;
      if (/^true$/i.test(t)) return 1;
      if (/^false$/i.test(t)) return 0;
      if (INT_RE.test(t)) return /[1-9]/.test(t) ? 1 : 0;
      throw E(245, vname(f), v, 'bit');
    }
    case 'binary': return v.length && v[v.length - 1] !== 0 ? 1 : 0;
    case 'datetime':
      if (!isPlainDt(f)) throw notAllowed(f, T, imp);
      if (imp) throw implicitDt(f, T);
      return dtDays(v, o) !== 0 ? 1 : 0;
    default: throw notAllowed(f, T, imp);
  }
}

function fitDec(x, p, s, src) {
  if (s == null) return x === 0 ? 0 : x;
  const r = roundDec(x, s);
  if (Math.abs(r) >= 10 ** (p - s)) throw E(8115, src, 'numeric');
  return r;
}

function toDec(v, f, T, o, imp) {
  let x;
  switch (f.dt) {
    case 'int': case 'bigint': case 'bit': case 'decimal': case 'money': case 'float': x = v; break;
    case 'string': {
      const t = trimWs(v);
      const m = DEC_RE.exec(t);
      if (!m || (m[2] === '' && !m[3])) throw E(8114, vname(f), 'numeric');
      const fp0 = m[3] || '';
      if (T.s == null) return digitsNumber(m[1] === '-', m[2], fp0);
      const { ip, fp } = roundDigits(m[2], fp0, T.s);
      if (ip.replace(/^0+/, '').length > T.p - T.s) throw E(8115, vname(f), 'numeric');
      return digitsNumber(m[1] === '-', ip, fp);
    }
    case 'datetime':
      if (!isPlainDt(f)) throw notAllowed(f, T, imp);
      if (imp) throw implicitDt(f, T);
      x = dtDays(v, o);
      break;
    default: throw notAllowed(f, T, imp);
  }
  return fitDec(x, T.p, T.s, srcConv(f));
}

function toFlt(v, f, T, o, imp) {
  let x;
  switch (f.dt) {
    case 'int': case 'bigint': case 'bit': case 'decimal': case 'money': case 'float': x = v; break;
    case 'string': {
      const t = trimWs(v);
      if (t === '') return 0;
      x = FLT_RE.test(t) ? Number(t) : NaN;
      if (!Number.isFinite(x)) throw E(8114, vname(f), T.real ? 'real' : 'float');
      break;
    }
    case 'datetime':
      if (!isPlainDt(f)) throw notAllowed(f, T, imp);
      if (imp) throw implicitDt(f, T);
      x = dtDays(v, o);
      break;
    default: throw notAllowed(f, T, imp);
  }
  if (T.real) {
    if (Math.abs(x) > 3.4028234663852886e38) throw E(8115, srcConv(f), 'real');
    x = realValue(x);
  }
  return x === 0 ? 0 : x;
}

// The value a real (IEEE single precision) holds for x (see the notes above): the float32 Math.fround(x) when it is an
// integer (every float32 from 2^24 up is one, and a double holds it exactly), otherwise the shortest decimal that
// rounds to the same float32 (at most 9 significant digits always do), so 0.1 stays 0.1 while 16777217 becomes 16777216.
function realValue(x) {
  const f = Math.fround(x);
  if (f === 0 || Number.isInteger(f) || !Number.isFinite(f)) return f === 0 ? 0 : f;
  for (let p = 1; p < 9; p++) {
    const r = Number(f.toPrecision(p));
    if (Math.fround(r) === f) return r;
  }
  return Number(f.toPrecision(9));
}

function toMoney(v, f, T, o, imp) {
  let x;
  switch (f.dt) {
    case 'int': case 'bigint': case 'bit': case 'decimal': case 'money': case 'float': x = roundDec(v, 4); break;
    case 'string': {
      const t = trimWs(v);
      if (t === '') return 0;
      const m = MONEY_RE.exec(t);
      const ipc = m ? m[4] : '';
      // 235: the money syntax (an optional currency symbol and thousands commas) is not met
      if (!m || (m[1] && m[3]) || ipc[0] === ',' || (!/\d/.test(ipc) && !/\d/.test(m[5] || ''))) throw E(235);
      const { ip, fp } = roundDigits(ipc.replace(/,/g, ''), m[5] || '', 4);
      x = digitsNumber((m[1] || m[3]) === '-', ip, fp);
      break;
    }
    case 'datetime':
      if (!isPlainDt(f)) throw notAllowed(f, T, imp);
      if (imp) throw implicitDt(f, T);
      x = roundDec(dtDays(v, o), 4);
      break;
    default: throw notAllowed(f, T, imp);
  }
  const lo = T.small ? -214748.3648 : -922337203685477.5808, hi = T.small ? 214748.3647 : 922337203685477.5807;
  if (x < lo || x > hi) throw E(8115, srcConv(f), T.name);
  return x === 0 ? 0 : x;
}

function padStr(s, T, imp) {
  return !imp && T.fixed && s.length < T.len ? s.padEnd(T.len, ' ') : s;
}

function toStr(v, f, T, o, imp) {
  const lim = !imp && T.len > 0 ? T.len : 0;
  let s;
  switch (f.dt) {
    case 'string': case 'xml': s = v; break;
    case 'int': case 'bigint': case 'bit':
      s = numStr(v, f);
      // An int-family number too long for char/varchar(n) gives '*', for nchar/nvarchar(n) 8115 naming nvarchar
      if (lim && s.length > lim) {
        if (T.uni) throw E(8115, 'expression', 'nvarchar');
        s = '*';
      }
      return padStr(s, T, imp);
    case 'decimal': case 'money': case 'float':
      s = numStr(v, f, o.style);
      // The message names varchar or nvarchar, also for a char(n) or nchar(n) target
      if (lim && s.length > lim) throw E(8115, 'numeric', T.uni ? 'nvarchar' : 'varchar');
      return padStr(s, T, imp);
    case 'guid':
      if (lim && lim < 36) throw E(8170);
      s = String(v).toLowerCase();
      break;
    case 'binary': s = binText(v, o.style, T.uni); break;
    case 'date': case 'datetime': case 'time':
      s = fmtTemporal(v, f, o.style, o.tz);
      break;
    default: s = String(v);
  }
  if (lim && s.length > lim) s = s.slice(0, lim);
  return padStr(s, T, imp);
}

function toBin(v, f, T, o, imp) {
  let b;
  switch (f.dt) {
    case 'binary': b = v; break;
    case 'string': {
      // SQL Server converts a string to binary only explicitly (257 for an assignment or other implicit conversion)
      if (imp) throw implicitDt(f, T);
      const st = o.style ?? 0;
      if (st === 1 || st === 2) {
        let h = v;
        if (st === 1 && h !== '') {
          if (h[0] !== '0' || (h[1] !== 'x' && h[1] !== 'X')) throw E(8114, vname(f), T.name);
          h = h.slice(2);
        }
        if ((h.length & 1) || !HEX_RE.test(h)) throw E(8114, vname(f), T.name);
        b = fromHex(h);
      } else b = f.unicode ? utf16Bytes(v) : utf8Bytes(v);
      break;
    }
    case 'int': case 'bigint': case 'bit': {
      // the value's own size: 4 bytes for int, 8 for bigint, 1 for bit, cut or padded on the left (01 §5.4)
      const ib = intBytes(v, f.dt === 'bigint' ? 8 : f.dt === 'bit' ? 1 : 4);
      return imp ? ib : fitIntBytes(ib, T);
    }
    case 'guid': b = guidBytes(v); break;
    case 'xml': b = utf16Bytes(v); break;
    default: throw notAllowed(f, T, imp);
  }
  return imp ? b : fitBytes(b, T);
}

function toXml(v, f, T, o, imp) {
  switch (f.dt) {
    case 'xml': return v;
    case 'string': return xmlValue(v, { preserveSpace: o.style === 1 || o.style === 3 });
    case 'binary': return xmlValue(xmlBytesText(v), { preserveSpace: o.style === 1 || o.style === 3 });
    default: throw notAllowed(f, T, imp);
  }
}

function toDate(v, f, T, o, imp) {
  switch (f.dt) {
    case 'date': return v;
    case 'datetime': return new Date(Math.floor(wallMs(v, o.tz) / DAY) * DAY);
    case 'string': {
      const p = parseFields(v, o);
      return utcDate(p.y, p.m, p.d);
    }
    default: throw notAllowed(f, T, imp);
  }
}

// Rounds instant or wall-clock milliseconds to the resolution of datetime target T: smalldatetime to the minute
// (29.999 s rounds up), datetime to 1/300 s, datetime2(n < 3) to n digits. Offsets are whole minutes, so rounding the
// instant and rounding the wall-clock time agree. Idempotent for values fracFit has rounded.
function roundMs(ms, T) {
  if (T.small) {
    const base = Math.floor(ms / 60000) * 60000;
    return ms - base >= 29999 ? base + 60000 : base;
  }
  if (T.prec == null && !T.dto) {
    const base = Math.floor(ms / 1000) * 1000;
    const ticks = Math.round(((ms - base) * 3) / 10);
    return base + Math.round((ticks * 10) / 3);
  }
  if (T.prec < 3) {
    const u = 10 ** (3 - T.prec);
    return Math.round(ms / u) * u;
  }
  return ms;
}

// Whether wall-clock ms W lies in the range of the (non-datetimeoffset) datetime target T.
function wallInRange(W, T) {
  if (T.small) return W >= W1900 && W <= W2079;
  if (T.prec == null) return W >= W1753 && W < W10000;
  return W >= W0001 && W < W10000;
}

// Whether instant ms with own offset tzo (or the session offset) lies in the range of the datetime target T.
function dtInRange(ms, tzo, T, tz) {
  if (T.dto) { const y = new Date(ms).getUTCFullYear(); return y >= 1 && y <= 9999 && ms < W10000; }
  return wallInRange(ms + (tzo ?? offOf(tz, ms)) * 60000, T);
}

const E242 = (f, T) => E(242, srcConv(f), T.name);

// A number of days since 1900-01-01 as a datetime/smalldatetime target T (01 §5.4): the whole days plus the
// fraction of the day in 1/300 s (smalldatetime: the minute), as session wall-clock time; 8115 outside the range.
function daysToDt(v, f, T, tz) {
  if (Number.isFinite(v)) {
    const days = Math.floor(v), frac = v - days;
    const fracMs = T.small ? Math.round(frac * DAY) : Math.round((Math.round(frac * 25920000) * 10) / 3);
    const W = roundMs(W1900 + days * DAY + fracMs, T);
    if (Number.isFinite(W) && wallInRange(W, T)) return keepWall(W, tz);
  }
  throw E(8115, 'expression', T.name);
}

function toDt(v, f, T, o, imp) {
  const tz = o.tz;
  // whole: milliseconds of the whole second (a wall-clock time in modes 'wall' and 'utc', an instant in 'inst');
  // f7: the 7-digit fraction; mode 'wall' resolves in the session tz, 'utc' keeps the wall clock as an instant with
  // offset +00:00 (a datetimeoffset made without an offset), 'inst' keeps the instant and its offset tzo.
  let whole, f7 = 0, mode, tzo = null;
  switch (f.dt) {
    case 'datetime': {
      const ms = v.getTime(), r = ((ms % 1000) + 1000) % 1000, own = v.tzo;
      f7 = r * 10000 + tkOf(v);
      if (f.dto) {
        // a datetimeoffset keeps instant and offset for datetimeoffset targets and gives its own wall-clock time to
        // the other datetime types (§5.5)
        if (T.dto) { whole = ms - r; mode = 'inst'; tzo = own ?? null; }
        else { whole = wallMs(v, tz) - r; mode = 'wall'; }
      } else if (own === 0) {
        // a UTC value (GETUTCDATE, SYSUTCDATETIME) keeps its instant, and +00:00 for datetimeoffset targets
        whole = ms - r; mode = 'inst'; tzo = 0;
      } else if (own != null) {
        // a DST-gap value is re-resolved from its wall-clock time
        whole = ms + own * 60000 - r; mode = T.dto ? 'utc' : 'wall';
      } else if (T.dto) {
        whole = wallMs(v, tz) - r; mode = 'utc';
      } else { whole = ms - r; mode = 'inst'; }
      break;
    }
    case 'date':
      whole = v.getTime(); mode = T.dto ? 'utc' : 'wall';
      break;
    case 'time': {
      const t = timeParts(v);
      whole = W1900 + t.h * 3600000 + t.mi * 60000 + t.s * 1000; f7 = +t.frac7; mode = T.dto ? 'utc' : 'wall';
      break;
    }
    case 'string': {
      const p = parseFields(v, o);
      // more than 3 fraction digits do not convert to datetime or smalldatetime (SQL Server)
      if (p.nd > 3 && T.prec == null) throw E241();
      whole = wallOf(p) - p.ms; f7 = +p.frac7;
      // an explicit offset is kept only by datetimeoffset; the others keep the literal's own wall clock
      if (p.tzo != null && T.dto) { whole -= p.tzo * 60000; mode = 'inst'; tzo = p.tzo; }
      else mode = T.dto ? 'utc' : 'wall';
      break;
    }
    case 'int': case 'bigint': case 'bit': case 'decimal': case 'money': case 'float':
      if (T.prec != null || T.dto) throw notAllowed(f, T, imp);
      return daysToDt(v, f, T, tz);
    default: throw notAllowed(f, T, imp);
  }
  const [fms, tk] = fracFit(f7, T);
  if (mode === 'wall') {
    const W = roundMs(whole + fms, T);
    if (!wallInRange(W, T)) throw E242(f, T);
    return keepWall(W, tz, tk);
  }
  if (mode === 'utc') tzo = 0;
  const ms = roundMs(whole + fms, T);
  if (!dtInRange(ms, tzo, T, tz)) throw E242(f, T);
  return mkDt(ms, tzo, tk);
}

function toTime(v, f, T, o, imp) {
  switch (f.dt) {
    case 'time': {
      const t = timeParts(v);
      return timeStr(t.h, t.mi, t.s, t.frac7, T.prec);
    }
    case 'datetime': {
      const r = ((wallMs(v, o.tz) % DAY) + DAY) % DAY;
      return timeStr(Math.floor(r / 3600000), Math.floor(r / 60000) % 60, Math.floor(r / 1000) % 60, p3(r % 1000) + p4(tkOf(v)), T.prec);
    }
    case 'string': {
      const p = parseFields(v, o);
      return timeStr(p.h, p.mi, p.s, p.frac7, T.prec);
    }
    default: throw notAllowed(f, T, imp);
  }
}

function toGuid(v, f, T, o, imp) {
  if (f.dt === 'guid') return String(v).toLowerCase();
  if (f.dt === 'binary') return bytesGuid(v);
  if (f.dt !== 'string') throw notAllowed(f, T, imp);
  // An optional enclosing { } is removed; characters after the 36th are ignored; anything else raises 8169
  let t = trimWs(v);
  if (t[0] === '{' && t[37] === '}') t = t.slice(1, 37);
  else if (t.length > 36) t = t.slice(0, 36);
  if (!GUID_RE.test(t)) throw E(8169);
  return t.toLowerCase();
}

function conv(v, f, T, o, imp) {
  if (f.dt === 'any' || f.dt === 'null') {
    // CAST(x AS sql_variant) keeps a sql_variant and wraps a raw value; converting a sql_variant converts its base
    // value from its base type with castValue's (explicit) rules (01 §5)
    if (T.k === 'var') return variant(v, f);
    if (v instanceof SqlVariant) imp = false;
    [v, f] = unwrap(v);
  }
  switch (T.k) {
    case 'int': return toInt(v, f, T, o, imp);
    case 'bit': return toBit(v, f, T, o, imp);
    case 'dec': return toDec(v, f, T, o, imp);
    case 'flt': return toFlt(v, f, T, o, imp);
    case 'money': return toMoney(v, f, T, o, imp);
    case 'str': return toStr(v, f, T, o, imp);
    case 'bin': return toBin(v, f, T, o, imp);
    case 'xml': return toXml(v, f, T, o, imp);
    case 'date': return toDate(v, f, T, o, imp);
    case 'dt': return toDt(v, f, T, o, imp);
    case 'time': return toTime(v, f, T, o, imp);
    case 'guid': return toGuid(v, f, T, o, imp);
    case 'var': return variant(v, f);
    default: return v;
  }
}

const TEMPORAL = new Set(['date', 'datetime', 'time']);
const NO_OPTS = Object.freeze({});

// 281 for a style the conversion does not have (01 §5.3, §5.4; money and float styles are checked by numStr).
function checkStyle(style, f, T) {
  if (style == null) return;
  const toTemporal = T.k === 'date' || T.k === 'dt' || T.k === 'time';
  if (TEMPORAL.has(f.dt) && T.k === 'str' && !DATE_STYLES.has(style)) throw E(281, style, `from ${msgName(f)} to a character string`);
  if (f.dt === 'string' && toTemporal && !DATE_STYLES.has(style)) throw E(281, style, `to ${T.name}`);
  if (f.dt === 'binary' && T.k === 'str' && !BIN_STYLES.has(style)) throw E(281, style, `from ${msgName(f)} to a character string`);
  if (f.dt === 'string' && T.k === 'bin' && !BIN_STYLES.has(style)) throw E(281, style, `to ${T.name}`);
  if (T.k === 'xml' && f.dt !== 'xml' && !XML_STYLES.has(style)) throw E(281, style, 'to xml');
}

// CAST/CONVERT of v (static fromType) to a DataType {name, args}, with {style, tz, dateformat, try} (01 §5.4).
// The style is checked before a NULL value returns NULL, as SQL Server checks it whatever the value (281); a NULL
// sql_variant or bare NULL has no base type, so only the checks that do not depend on the source apply to it.
export function castValue(v, fromType, dataType, opts = NO_OPTS) {
  const T = target(dataType, opts.defLen ?? 30);
  const f = ty(fromType);
  if (opts.style != null) {
    if (typeof opts.style !== 'number') opts = { ...opts, style: Number(opts.style) };
    checkStyle(opts.style, v != null && (f.dt === 'any' || f.dt === 'null') ? unwrap(v)[1] : f, T);
  }
  if (v == null) return null;
  try {
    return conv(v, f, T, opts, false);
  } catch (e) {
    if (opts.try && e instanceof SqlError && SOFT.has(e.number)) return null;
    throw e;
  }
}

// T.k values whose implicit conversions never read the session time zone (a datetime source raises 257 for them).
const TZ_FREE = new Set(['int', 'bit', 'dec', 'flt', 'money', 'guid', 'null', 'bin', 'xml']);

// A stand-in for an absent session tz: reading it throws a TypeError naming the operation, so a conversion that
// needs the tz fails loudly, while one that does not (or that raises its own SQL error first) is unaffected.
function missingTz(what) {
  const fail = () => { throw new TypeError(`${what} reads the session time zone; pass env (with env.tz).`); };
  return Object.freeze({ get utc() { return fail(); }, offset: fail });
}

// Implicit conversion of v from fromType to the static toType (01 §5.1): 245/241/8114/8169, 206 when not allowed.
// opts = {tz, dateformat} (env): a conversion that reads the session time zone throws a TypeError without opts.tz.
// A fixed-length target (char(n), nchar(n), binary(n)) gets the value padded to n, never cut (01 §5, §5.4).
export function coerce(v, fromType, toType, opts = NO_OPTS) {
  if (v == null) return null;
  const f = ty(fromType), t = ty(toType);
  const r = implicit(v, f, t, opts);
  return t.fixed && t.len > 0 && (t.dt === 'string' || t.dt === 'binary') ? padFixed(r, f, v, t) : r;
}

// The value r converted to the fixed-length Type t padded to t.len: strings with spaces, bytes with 0x00 on the
// right, or on the left for an int-family source (01 §5.4, as fitIntBytes); a longer value is kept as it is.
function padFixed(r, f, v, t) {
  if (typeof r === 'string') return t.dt === 'string' && r.length < t.len ? r.padEnd(t.len, ' ') : r;
  if (!isBytes(r) || t.dt !== 'binary' || r.length >= t.len) return r;
  const src = f.dt === 'any' || f.dt === 'null' ? variantType(v) : f;
  const out = new Uint8Array(t.len);
  out.set(r, src && INTS.has(src.dt) ? t.len - r.length : 0);
  return out;
}

// coerce without the fixed-length padding.
function implicit(v, f, t, opts) {
  if (f === t) return v;
  if (f.dt === t.dt) {
    switch (f.dt) {
      case 'int': case 'bigint': case 'bit': case 'float': case 'guid': case 'date': case 'string': case 'binary': case 'xml':
      case 'any': return v;
      case 'time': if ((f.prec ?? 7) <= (t.prec ?? 7)) return v; break;
      // unchanged only when no value of f can overflow t or need rounding: decimal(p,s) needs s <= t.scale and
      // p - s <= t.prec - t.scale; money fits smallmoney only when it is smallmoney (01 §5.1, §5.4: 8115)
      case 'decimal':
        if (t.scale == null || (f.scale != null && f.scale <= t.scale
          && (t.prec == null || (f.prec != null && f.prec - f.scale <= t.prec - t.scale)))) return v;
        break;
      case 'money': if (t.prec !== 10 || f.prec === 10) return v; break;
      case 'datetime':
        if (!!f.dto === !!t.dto && dtPrec(f) === dtPrec(t) && !!f.small === !!t.small) return v;
        break;
      default: break;
    }
  }
  const T = typeTarget(t);
  const base = f.dt === 'any' || f.dt === 'null' ? variantValue(v) : v;
  const dated = T.k === 'dt' || f.dt === 'datetime' || ((f.dt === 'any' || f.dt === 'null') && base instanceof Date);
  const o = opts.tz == null && dated && !TZ_FREE.has(T.k) ? { ...opts, tz: missingTz(`coerce from ${msgName(f)} to ${T.name}`) } : opts;
  return conv(v, f, T, o, true);
}

// ------------------------------------------------------------------------------------------- collation

const AS_LCIDS = new Set([1035, 1048, 1050, 1051, 1053, 1054, 1057, 1058, 1061, 1062, 1063, 1066, 1069, 1081, 1086, 1087, 1110, 2074]);
const LCID_LOCALES = '1025=ar-SA,1026=bg-BG,1027=ca-ES,1028=zh-TW,1029=cs-CZ,1030=da-DK,1031=de-DE,1032=el-GR,1033=en-US,' +
  '1035=fi-FI,1036=fr-FR,1037=he-IL,1038=hu-HU,1040=it-IT,1041=ja-JP,1042=ko-KR,1043=nl-NL,1044=nb-NO,1045=pl-PL,' +
  '1046=pt-BR,1048=ro-RO,1049=ru-RU,1050=hr-HR,1051=sk-SK,1053=sv-SE,1054=th-TH,1055=tr-TR,1057=id-ID,1058=uk-UA,' +
  '1060=sl-SI,1061=et-EE,1062=lv-LV,1063=lt-LT,1066=vi-VN,1069=eu-ES,1081=hi-IN,1086=ms-MY,1087=kk-KZ,1110=gl-ES,' +
  '2052=zh-CN,2057=en-GB,2070=pt-PT,2074=sr-Latn-RS,3076=zh-HK,3081=en-AU,3082=es-ES,3084=fr-CA,3098=sr-Cyrl-RS,' +
  '4105=en-CA,5129=en-NZ,2068=nn-NO,2058=es-MX,2055=de-CH,3079=de-AT,2060=fr-BE,4108=fr-CH,2067=nl-BE';
let lcidMap = null;

// The BCP 47 locale of a Windows LCID from the collation locale table (1033 -> 'en-US'), or null for an LCID the table
// does not list; the caller checks that the Intl API it uses supports it (01 §5.2; util.js formatCell, see the notes above).
export function lcidToLocale(lcid) {
  if (!lcidMap) {
    lcidMap = new Map();
    for (const pair of LCID_LOCALES.split(',')) {
      const i = pair.indexOf('=');
      lcidMap.set(Number(pair.slice(0, i)), pair.slice(i + 1));
    }
  }
  return lcidMap.get(Number(lcid)) ?? null;
}

// The Intl.Collator locale of an org LCID: its table locale when Intl supports it, else 'en' (01 §5.2).
function orgLocale(lcid) {
  const loc = lcidToLocale(lcid);
  return loc && Intl.Collator.supportedLocalesOf([loc]).length ? loc : 'en';
}

let ORG_C = null, AI_C = null;
const COLLATIONS = new Map();

// keys: a bounded cache of the collation keys of non-ASCII strings (NFKD and mark stripping are the costly part);
// like: the compiled LIKE matchers of this collation object (likeMatcher), keyed by escape and pattern.
function mkColl(id, ci, ai, bin, locale) {
  return { id, ci, ai, bin, locale, col: null, fold: new Map(), keys: new Map(), keyUnits: 0, like: new Map() };
}

// Sets the org collation from organization.localeid (01 §5.2): always case-insensitive, accent-sensitive LCIDs listed.
export function setCollation(lcid) {
  const n = Number(lcid);
  const id = Number.isInteger(n) && n > 0 ? n : 1033;
  ORG_C = mkColl('org', true, !AS_LCIDS.has(id), false, orgLocale(id));
  ORG_C.lcid = id;
  AI_C = mkColl('ai', true, true, false, 'en');
  COLLATIONS.clear();
}

// The org collation setCollation set (1033 before any call): {lcid, ai (accent-insensitive), locale (the
// Intl.Collator locale)}, a fresh frozen object (SERVERPROPERTY('LCID'), 'Collation', see the notes above).
export function orgCollation() {
  const c = orgColl();
  return F({ lcid: c.lcid, ai: c.ai, locale: c.locale });
}

const orgColl = () => ORG_C || (setCollation(1033), ORG_C);
const aiColl = () => AI_C || (setCollation(1033), AI_C);
const collOf = ai => (ai === true ? aiColl() : ai && typeof ai === 'object' ? ai : orgColl());

// The collation table of SQL Server's sys.fn_helpcollations() (01 §5.2), parsed on first use. Before '|': the
// Windows collation bases as `name,lcid,code page,versions,Intl locale`, where versions lists the collation versions
// the base has (80 = no version in the name, 90, 100, 140); each base × version gives _BIN, _BIN2 and the 16
// _CI/_CS × _AI/_AS × [_KS] × [_WS] names, plus _SC (90, 100), _VSS (140) and the UTF-8 variants (_SC_UTF8 and
// _BIN2_UTF8 for 90 and 100, _UTF8 for 140). After '|': the SQL Server collations as `name,sort order,code page,
// lcid,locale`. Code page 0 marks a Unicode-only collation.
export const SQL_COLLATIONS = 'Albanian,1052,1250,80.100,sq;Arabic,1025,1256,80.100,ar;Assamese,1101,0,100,as;' +
  'Azeri_Cyrillic,2092,1251,90.100,az-Cyrl;Azeri_Latin,1068,1254,90.100,az;Bashkir,1133,1251,100,ba;Bengali,1093,0,100,bn;' +
  'Bosnian_Cyrillic,8218,1251,100,bs-Cyrl;Bosnian_Latin,5146,1250,100,bs;Breton,1150,1252,100,br;' +
  'Chinese_Hong_Kong_Stroke,3076,950,90,zh-HK-u-co-stroke;Chinese_PRC,2052,936,80.90,zh;' +
  'Chinese_PRC_Stroke,133124,936,80.90,zh-u-co-stroke;Chinese_Simplified_Pinyin,2052,936,100,zh;' +
  'Chinese_Simplified_Stroke_Order,133124,936,100,zh-u-co-stroke;Chinese_Taiwan_Bopomofo,197636,950,80.90,zh-Hant-u-co-zhuyin;' +
  'Chinese_Taiwan_Stroke,1028,950,80.90,zh-Hant-u-co-stroke;Chinese_Traditional_Bopomofo,197636,950,100,zh-Hant-u-co-zhuyin;' +
  'Chinese_Traditional_Pinyin,5124,950,100,zh-Hant-u-co-pinyin;Chinese_Traditional_Stroke_Count,3076,950,100,zh-HK-u-co-stroke;' +
  'Chinese_Traditional_Stroke_Order,1028,950,100,zh-Hant-u-co-stroke;Corsican,1155,1252,100,co;Croatian,1050,1250,80.100,hr;' +
  'Cyrillic_General,1049,1251,80.100,ru;Czech,1029,1250,80.100,cs;Danish_Greenlandic,1030,1252,100,da;' +
  'Danish_Norwegian,1030,1252,80,da;Dari,1164,1256,100,fa-AF;Divehi,1125,0,90.100,dv;Estonian,1061,1257,80.100,et;' +
  'Finnish_Swedish,1035,1252,80.100,sv;French,1036,1252,80.100,fr;Frisian,1122,1252,100,fy;' +
  'Georgian_Modern_Sort,66615,0,80.100,ka;German_PhoneBook,66567,1252,80.100,de-u-co-phonebk;Greek,1032,1253,80.100,el;' +
  'Hebrew,1037,1255,80.100,he;Hindi,1081,0,80,hi;Hungarian,1038,1250,80.100,hu;Hungarian_Technical,66574,1250,80.100,hu;' +
  'Icelandic,1039,1252,80.100,is;Indic_General,1081,0,90.100,hi;Japanese,1041,932,80.90,ja;' +
  'Japanese_Bushu_Kakusu,263185,932,100.140,ja;Japanese_Unicode,1041,932,80,ja;Japanese_XJIS,1041,932,100.140,ja;' +
  'Kazakh,1087,1251,90.100,kk;Khmer,1107,0,100,km;Korean,1042,949,90.100,ko;Korean_Wansung,1042,949,80,ko;Lao,1108,0,100,lo;' +
  'Latin1_General,1033,1252,80.100,en;Latvian,1062,1257,80.100,lv;Lithuanian,1063,1257,80.100,lt;' +
  'Lithuanian_Classic,66599,1257,80,lt;Macedonian_FYROM,1071,1251,90.100,mk;Maltese,1082,0,100,mt;Maori,1153,0,100,mi;' +
  'Mapudungan,1146,1252,100,arn;Mexican_Trad_Spanish,2058,1252,80,es-u-co-trad;Modern_Spanish,3082,1252,80.100,es;' +
  'Mohawk,1148,1252,100,moh;Nepali,1121,0,100,ne;Norwegian,1044,1252,100,nb;Pashto,1123,0,100,ps;Persian,1065,1256,100,fa;' +
  'Polish,1045,1250,80.100,pl;Romanian,1048,1250,80.100,ro;Romansh,1047,1252,100,rm;Sami_Norway,1083,1252,100,se;' +
  'Sami_Sweden_Finland,2107,1252,100,se-SE;Serbian_Cyrillic,3098,1251,100,sr-Cyrl;Serbian_Latin,2074,1250,100,sr-Latn;' +
  'Slovak,1051,1250,80.100,sk;Slovenian,1060,1250,80.100,sl;Syriac,1114,0,90.100,syr;Tamazight,2143,1252,100,tzm;' +
  'Tatar,1092,1251,90.100,tt;Thai,1054,874,80.100,th;Tibetan,1105,0,100,bo;Traditional_Spanish,1034,1252,80.100,es-u-co-trad;' +
  'Turkish,1055,1254,80.100,tr;Turkmen,1090,1250,100,tk;Uighur,1152,1256,100,ug;Ukrainian,1058,1251,80.100,uk;' +
  'Upper_Sorbian,1070,1252,100,hsb;Urdu,1056,1256,100,ur;Uzbek_Latin,1091,1254,90.100,uz;Vietnamese,1066,1258,80.100,vi;' +
  'Welsh,1106,1252,100,cy;Yakut,1157,1251,100,sah|' +
  'SQL_1xCompat_CP850_CI_AS,49,850,1033,en;SQL_AltDiction_CP1253_CS_AS,121,1253,1033,en;' +
  'SQL_AltDiction_CP850_CI_AI,57,850,1033,en;SQL_AltDiction_CP850_CI_AS,61,850,1033,en;SQL_AltDiction_CP850_CS_AS,55,850,1033,en;' +
  'SQL_AltDiction_Pref_CP850_CI_AS,56,850,1033,en;SQL_AltDiction2_CP1253_CS_AS,122,1253,1033,en;' +
  'SQL_Croatian_CP1250_CI_AS,92,1250,1050,hr;SQL_Croatian_CP1250_CS_AS,91,1250,1050,hr;SQL_Czech_CP1250_CI_AS,84,1250,1029,cs;' +
  'SQL_Czech_CP1250_CS_AS,83,1250,1029,cs;SQL_Danish_Pref_CP1_CI_AS,183,1252,1030,da;SQL_EBCDIC037_CP1_CS_AS,210,37,1033,en;' +
  'SQL_EBCDIC273_CP1_CS_AS,211,273,1033,en;SQL_EBCDIC277_2_CP1_CS_AS,218,277,1033,en;SQL_EBCDIC277_CP1_CS_AS,212,277,1033,en;' +
  'SQL_EBCDIC278_CP1_CS_AS,213,278,1033,en;SQL_EBCDIC280_CP1_CS_AS,214,280,1033,en;SQL_EBCDIC284_CP1_CS_AS,215,284,1033,en;' +
  'SQL_EBCDIC285_CP1_CS_AS,216,285,1033,en;SQL_EBCDIC297_CP1_CS_AS,217,297,1033,en;' +
  'SQL_Estonian_CP1257_CI_AS,156,1257,1061,et;SQL_Estonian_CP1257_CS_AS,155,1257,1061,et;' +
  'SQL_Hungarian_CP1250_CI_AS,86,1250,1038,hu;SQL_Hungarian_CP1250_CS_AS,85,1250,1038,hu;' +
  'SQL_Icelandic_Pref_CP1_CI_AS,186,1252,1039,is;SQL_Latin1_General_CP1_CI_AI,54,1252,1033,en;' +
  'SQL_Latin1_General_CP1_CI_AS,52,1252,1033,en;SQL_Latin1_General_CP1_CS_AS,51,1252,1033,en;' +
  'SQL_Latin1_General_CP1250_CI_AS,82,1250,1033,en;SQL_Latin1_General_CP1250_CS_AS,81,1250,1033,en;' +
  'SQL_Latin1_General_CP1251_CI_AS,106,1251,1033,en;SQL_Latin1_General_CP1251_CS_AS,105,1251,1033,en;' +
  'SQL_Latin1_General_CP1253_CI_AI,124,1253,1033,en;SQL_Latin1_General_CP1253_CI_AS,114,1253,1033,en;' +
  'SQL_Latin1_General_CP1253_CS_AS,113,1253,1033,en;SQL_Latin1_General_CP1254_CI_AS,130,1254,1033,en;' +
  'SQL_Latin1_General_CP1254_CS_AS,129,1254,1033,en;SQL_Latin1_General_CP1255_CI_AS,138,1255,1033,en;' +
  'SQL_Latin1_General_CP1255_CS_AS,137,1255,1033,en;SQL_Latin1_General_CP1256_CI_AS,146,1256,1033,en;' +
  'SQL_Latin1_General_CP1256_CS_AS,145,1256,1033,en;SQL_Latin1_General_CP1257_CI_AS,154,1257,1033,en;' +
  'SQL_Latin1_General_CP1257_CS_AS,153,1257,1033,en;SQL_Latin1_General_CP437_BIN,30,437,1033,en;' +
  'SQL_Latin1_General_CP437_BIN2,30,437,1033,en;SQL_Latin1_General_CP437_CI_AI,34,437,1033,en;' +
  'SQL_Latin1_General_CP437_CI_AS,32,437,1033,en;SQL_Latin1_General_CP437_CS_AS,31,437,1033,en;' +
  'SQL_Latin1_General_CP850_BIN,40,850,1033,en;SQL_Latin1_General_CP850_BIN2,40,850,1033,en;' +
  'SQL_Latin1_General_CP850_CI_AI,44,850,1033,en;SQL_Latin1_General_CP850_CI_AS,42,850,1033,en;' +
  'SQL_Latin1_General_CP850_CS_AS,41,850,1033,en;SQL_Latin1_General_Pref_CP1_CI_AS,53,1252,1033,en;' +
  'SQL_Latin1_General_Pref_CP437_CI_AS,33,437,1033,en;SQL_Latin1_General_Pref_CP850_CI_AS,43,850,1033,en;' +
  'SQL_Latvian_CP1257_CI_AS,158,1257,1062,lv;SQL_Latvian_CP1257_CS_AS,157,1257,1062,lv;' +
  'SQL_Lithuanian_CP1257_CI_AS,160,1257,1063,lt;SQL_Lithuanian_CP1257_CS_AS,159,1257,1063,lt;' +
  'SQL_MixDiction_CP1253_CS_AS,120,1253,1033,en;SQL_Polish_CP1250_CI_AS,88,1250,1045,pl;SQL_Polish_CP1250_CS_AS,87,1250,1045,pl;' +
  'SQL_Romanian_CP1250_CI_AS,90,1250,1048,ro;SQL_Romanian_CP1250_CS_AS,89,1250,1048,ro;' +
  'SQL_Scandinavian_CP850_CI_AS,60,850,1035,sv;SQL_Scandinavian_CP850_CS_AS,59,850,1035,sv;' +
  'SQL_Scandinavian_Pref_CP850_CI_AS,58,850,1035,sv;SQL_Slovak_CP1250_CI_AS,94,1250,1051,sk;' +
  'SQL_Slovak_CP1250_CS_AS,93,1250,1051,sk;SQL_Slovenian_CP1250_CI_AS,96,1250,1060,sl;SQL_Slovenian_CP1250_CS_AS,95,1250,1060,sl;' +
  'SQL_SwedishPhone_Pref_CP1_CI_AS,184,1252,1053,sv;SQL_SwedishStd_Pref_CP1_CI_AS,185,1252,1053,sv;' +
  'SQL_Ukrainian_CP1251_CI_AS,108,1251,1058,uk;SQL_Ukrainian_CP1251_CS_AS,107,1251,1058,uk';

let collBases = null, sqlColls = null, collList = null;
const COLL_VERSION = new Map([[80, 0], [90, 1], [100, 2], [140, 3]]);
// The Unicode sort named in a SQL collation's description, by its locale.
const SQL_UNICODE = new Map([['cs', 'Czech'], ['hu', 'Hungarian'], ['pl', 'Polish'], ['ro', 'Romanian'], ['hr', 'Croatian'],
  ['sk', 'Slovak'], ['sl', 'Slovenian'], ['uk', 'Ukrainian'], ['et', 'Estonian'], ['lv', 'Latvian'], ['lt', 'Lithuanian'],
  ['da', 'Danish-Norwegian'], ['sv', 'Finnish-Swedish'], ['is', 'Icelandic']]);
const COLL_FLAGS = ['CI_AI', 'CI_AI_WS', 'CI_AI_KS', 'CI_AI_KS_WS', 'CI_AS', 'CI_AS_WS', 'CI_AS_KS', 'CI_AS_KS_WS',
  'CS_AI', 'CS_AI_WS', 'CS_AI_KS', 'CS_AI_KS_WS', 'CS_AS', 'CS_AS_WS', 'CS_AS_KS', 'CS_AS_KS_WS'];

function collTables() {
  if (collBases) return;
  collBases = new Map();
  sqlColls = new Map();
  const [win, sql] = SQL_COLLATIONS.split('|');
  for (const e of win.split(';')) {
    const [name, lcid, cp, vers, locale] = e.split(',');
    collBases.set(name.toLowerCase(), { name, lcid: +lcid, cp: +cp, versions: vers.split('.').map(Number), locale });
  }
  for (const e of sql.split(';')) {
    const [name, so, cp, lcid, locale] = e.split(',');
    sqlColls.set(name.toLowerCase(), { name, so: +so, cp: +cp, lcid: +lcid, locale });
  }
}

// The flags of a Windows collation name after its base (lower-case tokens), or null when SQL Server has no such name.
function winFlags(t, base) {
  let i = 0, version = 80;
  if (t[0] === '90' || t[0] === '100' || t[0] === '140') { version = +t[0]; i = 1; }
  if (!base.versions.includes(version)) return null;
  const r = { version, bin: 0, ci: false, ai: false, ks: false, ws: false, vss: false, sc: false, utf8: false };
  const rest = t.slice(i);
  if (rest[0] === 'bin' || rest[0] === 'bin2') {
    r.bin = rest[0] === 'bin' ? 1 : 2;
    if (rest.length === 1) return r;
    if (r.bin === 2 && rest.length === 2 && rest[1] === 'utf8' && version >= 90) { r.utf8 = true; return r; }
    return null;
  }
  if ((rest[0] !== 'ci' && rest[0] !== 'cs') || (rest[1] !== 'ai' && rest[1] !== 'as')) return null;
  r.ci = rest[0] === 'ci';
  r.ai = rest[1] === 'ai';
  let j = 2;
  if (rest[j] === 'ks') { r.ks = true; j++; }
  if (rest[j] === 'ws') { r.ws = true; j++; }
  if (version === 140 && rest[j] === 'vss') { r.vss = true; j++; }
  if (version >= 90 && version < 140 && rest[j] === 'sc') { r.sc = true; j++; }
  if (rest[j] === 'utf8' && (version === 140 || r.sc)) { r.utf8 = true; j++; }
  return j === rest.length ? r : null;
}

const sens = (on, what) => `${what}-${on ? '' : 'in'}sensitive`;

// The fn_helpcollations row and COLLATIONPROPERTY values of a collation name (any case), or null when unknown:
// {name (canonical case), description, codePage, lcid, comparisonStyle, version, locale, ci, ai, bin}.
export function collationInfo(name) {
  const lower = String(name).toLowerCase();
  if (!/^[a-z0-9_]{1,128}$/.test(lower)) return null;
  collTables();
  const sq = sqlColls.get(lower);
  if (sq) {
    const bin = /_bin2?$/.test(lower) ? (lower.endsWith('2') ? 2 : 1) : 0;
    const ci = /_ci_a[is]$/.test(lower), ai = /_ai$/.test(lower);
    const uni = (SQL_UNICODE.get(sq.locale) || 'Latin1-General') + (lower.includes('_pref_') ? '-Pref' : '');
    const sort = bin ? (bin === 2 ? 'binary code point comparison sort' : 'binary sort')
      : `${sens(!ci, 'case')}, ${sens(!ai, 'accent')}, kanatype-insensitive, width-insensitive`;
    return {
      name: sq.name, description: `${uni}, ${sort} for Unicode Data, SQL Server Sort Order ${sq.so} on Code Page ${sq.cp} for non-Unicode Data`,
      codePage: sq.cp, lcid: sq.lcid, comparisonStyle: bin ? 0 : (ci ? 1 : 0) + (ai ? 2 : 0) + 65536 + 131072, version: 0,
      locale: sq.locale, ci, ai, bin,
    };
  }
  const toks = lower.split('_');
  for (let k = toks.length - 1; k >= 1; k--) {
    const base = collBases.get(toks.slice(0, k).join('_'));
    const r = base && winFlags(toks.slice(k), base);
    if (!r) continue;
    const vname = base.name + (r.version === 80 ? '' : '_' + r.version);
    const disp = vname.replace(/_/g, '-');
    let flags, desc;
    if (r.bin) {
      flags = r.bin === 2 ? '_BIN2' : '_BIN';
      desc = r.bin === 2 ? 'binary code point comparison sort' : 'binary sort';
    } else {
      flags = `_${r.ci ? 'CI' : 'CS'}_${r.ai ? 'AI' : 'AS'}${r.ks ? '_KS' : ''}${r.ws ? '_WS' : ''}${r.vss ? '_VSS' : ''}${r.sc ? '_SC' : ''}`;
      desc = `${sens(!r.ci, 'case')}, ${sens(!r.ai, 'accent')}, ${sens(r.ks, 'kanatype')}, ${sens(r.ws, 'width')}` +
        (r.version === 140 ? `, ${sens(r.vss, 'variation selector')}` : '') + (r.sc || r.version === 140 ? ', supplementary characters' : '');
    }
    if (r.utf8) { flags += '_UTF8'; desc += ', UTF8'; }
    return {
      name: vname + flags, description: `${disp}, ${desc}`, codePage: r.utf8 ? 65001 : base.cp, lcid: base.lcid,
      comparisonStyle: r.bin ? 0 : (r.ci ? 1 : 0) + (r.ai ? 2 : 0) + (r.ks ? 0 : 65536) + (r.ws ? 0 : 131072),
      version: COLL_VERSION.get(r.version), locale: base.locale, ci: r.ci, ai: r.ai, bin: r.bin,
    };
  }
  return null;
}

// Every collation of SQL_COLLATIONS in fn_helpcollations order (frozen {name, description, codePage, lcid,
// comparisonStyle, version, locale, ci, ai, bin} rows), built on first use (sys.fn_helpcollations(), COLLATE
// completion; 01 §5.2, §8).
export function sqlCollations() {
  if (collList) return collList;
  collTables();
  const out = [];
  for (const b of collBases.values()) {
    for (const v of b.versions) {
      const p = b.name + (v === 80 ? '' : '_' + v);
      const names = [p + '_BIN', p + '_BIN2'];
      for (const f of COLL_FLAGS) names.push(`${p}_${f}`);
      if (v === 140) for (const f of COLL_FLAGS) names.push(`${p}_${f}_VSS`);
      else if (v >= 90) for (const f of COLL_FLAGS) names.push(`${p}_${f}_SC`);
      if (v >= 90) {
        names.push(p + '_BIN2_UTF8');
        if (v === 140) for (const f of COLL_FLAGS) names.push(`${p}_${f}_UTF8`, `${p}_${f}_VSS_UTF8`);
        else for (const f of COLL_FLAGS) names.push(`${p}_${f}_SC_UTF8`);
      }
      for (const n of names) out.push(F(collationInfo(n)));
    }
  }
  for (const q of sqlColls.values()) out.push(F(collationInfo(q.name)));
  return (collList = F(out));
}

// The Intl.Collator locale of a collation: the table's locale when Intl supports it, else its language, else 'en'.
function collLocale(loc) {
  if (Intl.Collator.supportedLocalesOf([loc]).length) return loc;
  const lang = loc.split('-')[0];
  return Intl.Collator.supportedLocalesOf([lang]).length ? lang : 'en';
}

// Collation for a COLLATE name (01 §5.2), any case: the language part of the name selects the Intl.Collator
// locale (SQL_COLLATIONS), _CS case-sensitive, _AS accent-sensitive, _BIN/_BIN2 code units; _KS, _WS, _VSS, _SC and
// _UTF8 are accepted (kana and width sensitivity are not applied, 01 §9). The object also carries collationInfo's
// fields. An unknown name raises 448.
export function collation(name) {
  const s = String(name);
  const k = s.toLowerCase();
  let c = COLLATIONS.get(k);
  if (c) return c;
  const info = collationInfo(s);
  if (!info) throw E(448, s);
  c = mkColl('c:' + info.name.toLowerCase(), info.ci, info.ai, info.bin > 0, collLocale(info.locale));
  c.name = info.name;
  c.description = info.description;
  c.codePage = info.codePage;
  c.lcid = info.lcid;
  c.comparisonStyle = info.comparisonStyle;
  c.version = info.version;
  COLLATIONS.set(k, c);
  return c;
}

const ASCII_RE = /^[\x00-\x7f]*$/;
const MARKS_RE = /\p{M}/gu;

function trimR(s) {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === 32) e--;
  return e === s.length ? s : s.slice(0, e);
}

const KEY_CACHE_MAX = 65536;
const KEY_CACHE_LEN = 256;
const KEY_CACHE_UNITS = 2000000;

function key(s, c) {
  return keyT(trimR(typeof s === 'string' ? s : String(s)), c);
}

// Collation key of t, which has no trailing U+0020 (01 §5.2). Keys of non-ASCII strings of up to 256 units are
// memoised per collation, so comparison sorts normalise each distinct value once; the memo is cleared when it holds
// 65,536 entries or 2,000,000 UTF-16 units (about 4 MB).
function keyT(t, c) {
  if (c.bin) return t;
  if (ASCII_RE.test(t)) return c.ci ? t.toLowerCase() : t;
  const memo = t.length <= KEY_CACHE_LEN;
  if (memo) {
    const k = c.keys.get(t);
    if (k !== undefined) return k;
  }
  let k = t.normalize('NFKD');
  if (c.ai) k = k.replace(MARKS_RE, '');
  if (c.ci) {
    k = k.toLowerCase();
    if (k.includes('ß')) k = k.replaceAll('ß', 'ss');
  }
  if (memo) {
    if (c.keys.size >= KEY_CACHE_MAX || c.keyUnits > KEY_CACHE_UNITS) {
      c.keys.clear();
      c.keyUnits = 0;
    }
    c.keys.set(t, k);
    c.keyUnits += t.length + k.length;
  }
  return k;
}

// Equality key of a string under the org collation (01 §5.2): trailing spaces, NFKD, accents (AI), case, ß.
export function collKey(s) { return key(s, orgColl()); }

// Equality key under CI_AI (metadata columns, 01 §5.2).
export function collKeyAI(s) { return key(s, aiColl()); }

function collatorOf(c) {
  if (!c.col) {
    const sensitivity = c.ci ? (c.ai ? 'base' : 'accent') : (c.ai ? 'case' : 'variant');
    c.col = new Intl.Collator(c.locale, { sensitivity, usage: 'sort' });
  }
  return c.col;
}

// The 01 §5.2 string order from trimmed texts ta/tb and their keys ka/kb: 0 exactly when the keys are equal.
function keyedCmp(ta, ka, tb, kb, c) {
  if (ka === kb) return 0;
  if (!c.bin) {
    const r = collatorOf(c).compare(ta, tb);
    if (r) return r < 0 ? -1 : 1;
  }
  return ka < kb ? -1 : 1;
}

function strCmp(a, b, c) {
  if (a === b) return 0;
  const ta = trimR(typeof a === 'string' ? a : String(a)), tb = trimR(typeof b === 'string' ? b : String(b));
  if (ta === tb) return 0;
  return keyedCmp(ta, keyT(ta, c), tb, keyT(tb, c), c);
}

// String order under the org collation; 0 exactly when collKey is equal (01 §5.2).
export function collCompare(a, b) { return strCmp(a, b, orgColl()); }

// String order under CI_AI.
export function collCompareAI(a, b) { return strCmp(a, b, aiColl()); }

function foldUnit(ch, c) {
  if (c.bin || (!c.ci && !c.ai)) return ch;
  const code = ch.charCodeAt(0);
  if (code < 128) return c.ci && code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : ch;
  let f = c.fold.get(ch);
  if (f === undefined) {
    let t = ch;
    if (c.ai) t = t.normalize('NFKD').replace(MARKS_RE, '');
    if (c.ci) t = t.toLowerCase();
    f = t.length === 1 ? t : ch;
    if (c.fold.size > 4096) c.fold.clear();
    c.fold.set(ch, f);
  }
  return f;
}

// Per-unit fold of one UTF-16 unit for REPLACE/CHARINDEX/PATINDEX/LIKE (01 §5.2): lower case, accents when AI.
export function foldCh(c) { return foldUnit(c, orgColl()); }

// Per-unit fold of a whole string in a collation (01 §5.2; ai as cmp's: true = ci_ai, a collation object, else the
// org collation): positions are unchanged, so CHARINDEX and REPLACE can match on the folded text.
export function foldIn(s, ai) {
  const c = collOf(ai);
  if (c.bin || (!c.ci && !c.ai)) return s;
  let o = '';
  for (let i = 0; i < s.length; i++) o += foldUnit(s[i], c);
  return o;
}

function foldStr(s, c) {
  if (c.bin || (!c.ci && !c.ai)) return s;
  if (ASCII_RE.test(s)) return c.ci ? s.toLowerCase() : s;
  let out = '';
  for (let i = 0; i < s.length; i++) out += foldUnit(s[i], c);
  return out;
}

const hex4 = ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
const reLit = ch => (ch.charCodeAt(0) > 126 || ch.charCodeAt(0) < 32 ? hex4(ch) : /[\\^$.*+?()[\]{}|/-]/.test(ch) ? '\\' + ch : ch);
const reCls = ch => (ch.charCodeAt(0) > 126 || ch.charCodeAt(0) < 32 ? hex4(ch) : /[\\\]^[-]/.test(ch) ? '\\' + ch : ch);

// One '%'-free run of a LIKE pattern: `len` units, each matching exactly one UTF-16 unit of the folded value. `lit`
// is the folded text when every unit is a literal (matched with startsWith/indexOf), else null and the run is a
// quantifier-free RegExp (dotAll) used sticky (`y`, at a position) and global (`g`, leftmost search).
function likeSeg(units, lit) {
  if (lit != null) return { len: units.length, lit };
  const src = units.join('');
  return { len: units.length, lit: null, y: new RegExp(src, 'sy'), g: new RegExp(src, 'sg') };
}

// Whether run g matches folded text t at position i (the caller guarantees i + g.len <= t.length).
function segAt(g, t, i) {
  if (g.lit != null) return t.startsWith(g.lit, i);
  g.y.lastIndex = i;
  return g.y.test(t);
}

// The leftmost position >= from where run g matches t and ends at or before limit, or -1.
function segFind(g, t, from, limit) {
  let i;
  if (g.lit != null) i = t.indexOf(g.lit, from);
  else {
    g.g.lastIndex = from;
    const m = g.g.exec(t);
    i = m ? m.index : -1;
  }
  return i >= 0 && i + g.len <= limit ? i : -1;
}

// Splits a LIKE pattern at its '%' runs into fixed-width runs (01 §5.2): % _ [abc] [a-f] [^x] and ESCAPE, each unit
// folded with foldUnit. null when the pattern never matches (an unclosed '[' or an escape character at the end).
function likeRuns(p, esc, c) {
  const runs = [];
  let units = [], lit = '';
  const unit = (src, ch) => {
    units.push(src);
    if (lit != null) lit = ch == null ? null : lit + ch;
  };
  const n = p.length;
  let i = 0;
  while (i < n) {
    const ch = p[i];
    if (esc != null && ch === esc) {
      if (i + 1 >= n) return null;
      const f = foldUnit(p[i + 1], c);
      unit(reLit(f), f);
      i += 2;
    } else if (ch === '%') {
      runs.push(likeSeg(units, lit));
      units = [];
      lit = '';
      while (p[i] === '%') i++;
    } else if (ch === '_') {
      unit('.', null);
      i++;
    } else if (ch === '[') {
      let j = i + 1, neg = false, closed = false, first = true;
      if (p[j] === '^') { neg = true; j++; }
      const items = [];
      while (j < n) {
        if (p[j] === ']' && !first) { closed = true; break; }
        first = false;
        let lo;
        if (esc != null && p[j] === esc && j + 1 < n) { lo = p[j + 1]; j += 2; } else { lo = p[j]; j++; }
        lo = foldUnit(lo, c);
        if (p[j] === '-' && j + 1 < n && p[j + 1] !== ']') {
          let hi = p[j + 1], k = j + 2;
          if (esc != null && hi === esc && j + 2 < n) { hi = p[j + 2]; k = j + 3; }
          hi = foldUnit(hi, c);
          if (lo <= hi) items.push(reCls(lo) + '-' + reCls(hi));
          j = k;
        } else items.push(reCls(lo));
      }
      if (!closed) return null;
      i = j + 1;
      unit(!items.length ? (neg ? '.' : '(?!)') : (neg ? '[^' : '[') + items.join('') + ']', null);
    } else {
      const f = foldUnit(ch, c);
      unit(reLit(f), f);
      i++;
    }
  }
  runs.push(likeSeg(units, lit));
  return runs;
}

// Matcher over the runs: without '%' the value must be the single run; otherwise the first run is anchored at the
// start, the last at the end, and each middle run is found leftmost-first after the previous one. Leftmost placement
// is exact for runs of fixed width and makes every match O(length of value × length of pattern), never exponential.
function likeFn(runs, c) {
  if (runs.length === 1) {
    const g = runs[0];
    return s => {
      if (s == null) return null;
      const t = foldStr(String(s), c);
      return t.length === g.len && (g.len === 0 || segAt(g, t, 0));
    };
  }
  const first = runs[0], last = runs[runs.length - 1], mids = runs.slice(1, -1);
  let min = 0;
  for (const g of runs) min += g.len;
  return s => {
    if (s == null) return null;
    const t = foldStr(String(s), c);
    const n = t.length;
    if (n < min) return false;
    if (first.len && !segAt(first, t, 0)) return false;
    let pos = first.len;
    const end = n - last.len;
    for (const g of mids) {
      const i = segFind(g, t, pos, end);
      if (i < 0) return false;
      pos = i + g.len;
    }
    return pos <= end && (last.len === 0 || segAt(last, t, end));
  };
}

const LIKE_NULL = () => null;
const LIKE_NEVER = s => (s == null ? null : false);

// Compiled LIKE matcher (01 §5.2): % _ [abc] [a-f] [^x] and ESCAPE over foldCh-folded text; s => true|false|null.
// escapeClause = true says the predicate has an ESCAPE clause, so an escape value of NULL makes every result NULL
// (UNKNOWN, as SQL Server); without it a null/undefined escape means no escape character.
export function likeMatcher(pattern, escape = null, ai, escapeClause = false) {
  const c = collOf(ai);
  if (pattern == null || (escape == null && escapeClause)) return LIKE_NULL;
  if (escape != null && String(escape).length !== 1) throw E(506, String(escape));
  // One cache per collation object (never shared through a name or id, so a COLLATE object made before
  // setCollation keeps its own matchers); the key is unambiguous: 'N' (no escape) or 'E' plus the one escape unit,
  // then the pattern.
  const k = (escape == null ? 'N' : 'E' + String(escape)) + pattern;
  let fn = c.like.get(k);
  if (fn) return fn;
  const runs = likeRuns(String(pattern), escape == null ? null : String(escape), c);
  fn = runs ? likeFn(runs, c) : LIKE_NEVER;
  if (c.like.size >= 512) c.like.clear();
  c.like.set(k, fn);
  return fn;
}

// --------------------------------------------------------------------------- comparison and hashing

const GUID_POS = [24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 19, 20, 21, 22, 16, 17, 14, 15, 11, 12, 9, 10, 6, 7, 4, 5, 2, 3, 0, 1];

// SQL Server sort key of a uniqueidentifier (SqlGuid byte order 10-15, 8-9, 6-7, 4-5, 0-3; 01 §5.2).
export function guidKey(g) {
  const s = String(g).toLowerCase();
  return s.slice(24, 36) + s.slice(19, 23) + s.slice(16, 18) + s.slice(14, 16) + s.slice(11, 13) + s.slice(9, 11) +
    s.slice(6, 8) + s.slice(4, 6) + s.slice(2, 4) + s.slice(0, 2);
}

function guidCmp(a, b) {
  if (a === b) return 0;
  for (const i of GUID_POS) {
    const x = a.charCodeAt(i) | 0x20, y = b.charCodeAt(i) | 0x20;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function timeCmp(a, b) {
  if (a === b) return 0;
  const x = timeNorm(a), y = timeNorm(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

// Instant order, then the 100-ns ticks below the millisecond (01 §5.3).
function dtCmp(a, b) {
  const d = a.getTime() - b.getTime();
  if (d) return d < 0 ? -1 : 1;
  const x = tkOf(a), y = tkOf(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

const E305 = () => E(305);

// The one comparator (01 §5.2): NULL lowest, collation-aware strings, SQL Server GUID order, instants and ticks for
// dates, unsigned bytes for binary (the shorter padded with 0x00), the family-first sql_variant order; xml
// cannot be compared (305, also for NULLs: SQL Server rejects the comparison itself).
export function cmp(a, b, type, ai) {
  const d = dtn(type);
  if (d === 'xml') throw E305();
  if (a == null) return b == null ? 0 : -1;
  if (b == null) return 1;
  switch (d) {
    case 'string': return strCmp(a, b, collOf(ai));
    case 'guid': return guidCmp(String(a), String(b));
    case 'date': case 'datetime': return dtCmp(a, b);
    case 'time': return timeCmp(a, b);
    case 'binary': return bytesCmp(a, b);
    case 'any': case 'null': return variantCmp(a, b, ai);
    default: return a < b ? -1 : a > b ? 1 : 0;
  }
}

// Three-valued equality with the cmp rules (01 §5.2): null when either side is NULL; xml raises 305.
export function eq(a, b, type, ai) {
  const d = dtn(type);
  if (d === 'xml') throw E305();
  if (a == null || b == null) return null;
  switch (d) {
    case 'string': { if (a === b) return true; const c = collOf(ai); return key(a, c) === key(b, c); }
    case 'guid': return a === b || String(a).toLowerCase() === String(b).toLowerCase();
    case 'date': case 'datetime': return a.getTime() === b.getTime() && tkOf(a) === tkOf(b);
    case 'time': return timeCmp(a, b) === 0;
    case 'binary': return bytesCmp(a, b) === 0;
    case 'any': case 'null': return variantCmp(a, b, ai) === 0;
    default: return a === b;
  }
}

// String sort key: the trimmed text (for the collator) and its collation key.
function strSortKey(v, c) {
  const s = trimR(typeof v === 'string' ? v : String(v));
  return { s, k: keyT(s, c) };
}

// GUID sort key: the units in guidCmp's SqlGuid order and case folding, so plain string order equals guidCmp.
function guidSortKey(v) {
  const s = String(v);
  let out = '';
  for (const i of GUID_POS) out += String.fromCharCode(s.charCodeAt(i) | 0x20);
  return out;
}

// Sort key of a datetime value: its instant, or {m: instant, t: ticks} when it carries ticks.
const dtSortKey = v => (v.tk ? { m: v.getTime(), t: v.tk } : v.getTime());

function dtKeyCmp(a, b) {
  const am = typeof a === 'number' ? a : a.m, bm = typeof b === 'number' ? b : b.m;
  if (am !== bm) return am < bm ? -1 : 1;
  const at = typeof a === 'number' ? 0 : a.t, bt = typeof b === 'number' ? 0 : b.t;
  return at === bt ? 0 : at < bt ? -1 : 1;
}

// Sort key of a sql_variant: {f: family} plus the base value's key within the family.
function variantSortKey(x, ai) {
  const [v, t] = unwrap(x);
  const f = family(t);
  switch (f) {
    case 5: { const [m, k] = familyInstant(v, t); return { f, m, t: k }; }
    case 4: case 3: return { f, n: v };
    case 2: { const r = strSortKey(v, collOf(ai)); r.f = f; return r; }
    case 1: return { f, g: guidSortKey(v) };
    default: return { f, b: v };
  }
}

// Precomputed sort key of v for cmpKeys (01 §5.2): Sort, window ORDER BY, TOP WITH TIES and MIN/MAX can compute it
// once per row (decorate-sort) instead of recomputing collation keys in every comparison. NULL gives null; xml 305.
export function sortKey(v, type, ai) {
  const d = dtn(type);
  if (d === 'xml') throw E305();
  if (v == null) return null;
  switch (d) {
    case 'string': return strSortKey(v, collOf(ai));
    case 'guid': return guidSortKey(v);
    case 'date': case 'datetime': return dtSortKey(v);
    case 'time': return timeNorm(v);
    case 'any': case 'null': return variantSortKey(v, ai);
    default: return v;
  }
}

// Compares two sortKey results (same type and ai) exactly as cmp compares the values: -1|0|1, NULL lowest.
export function cmpKeys(a, b, type, ai) {
  if (a == null) return b == null ? 0 : -1;
  if (b == null) return 1;
  switch (dtn(type)) {
    case 'string': return keyedCmp(a.s, a.k, b.s, b.k, collOf(ai));
    case 'date': case 'datetime': return dtKeyCmp(a, b);
    case 'binary': return bytesCmp(a, b);
    case 'any': case 'null': {
      if (a.f !== b.f) return a.f < b.f ? -1 : 1;
      switch (a.f) {
        case 5: return a.m !== b.m ? (a.m < b.m ? -1 : 1) : a.t === b.t ? 0 : a.t < b.t ? -1 : 1;
        case 4: case 3: return a.n < b.n ? -1 : a.n > b.n ? 1 : 0;
        case 2: return a.s === b.s ? 0 : keyedCmp(a.s, a.k, b.s, b.k, collOf(ai));
        case 1: return a.g === b.g ? 0 : a.g < b.g ? -1 : 1;
        default: return bytesCmp(a.b, b.b);
      }
    }
    default: return a < b ? -1 : a > b ? 1 : 0;
  }
}

// Hash key of a value (01 §5.2): NULL '\u0000', 's'+collKey, 'n'+number (decimals at their scale), 'd'+ms (+'.'+tk),
// 'g'+guid, 'b'+hex without trailing 00 pairs, 'v'+family+base key for a sql_variant; xml raises 305.
export function keyOf(v, type, ai) {
  const t = ty(type);
  if (t.dt === 'xml') throw E305();
  if (v == null) return '\u0000';
  switch (t.dt) {
    case 'string': return 's' + key(v, collOf(ai));
    case 'guid': return 'g' + String(v).toLowerCase();
    case 'date': case 'datetime': return 'd' + v.getTime() + (v.tk ? '.' + v.tk : '');
    case 'time': return 't' + timeNorm(v);
    case 'binary': return 'b' + bytesKey(v);
    case 'decimal': case 'money': {
      const x = t.scale == null ? v : roundDec(v, t.scale);
      return 'n' + (x === 0 ? 0 : x);
    }
    case 'any': case 'null': {
      const [bv, bt] = unwrap(v);
      const f = family(bt);
      if (f === 5) {
        const [m, k] = familyInstant(bv, bt);
        return 'v5d' + m + (k ? '.' + k : '');
      }
      return 'v' + f + keyOf(bv, bt, ai);
    }
    default: return 'n' + (v === 0 ? 0 : v);
  }
}

// Row hash key: JSON of keyOf per value; ai is one flag/collation or one per column. {xmlText: true} keys xml values by
// their serialised text instead of raising 305 (the FOR XML/JSON AUTO level identity, 01 §5.6; see the notes above).
export function rowKey(values, types, ai, opts) {
  const xmlText = !!(opts && opts.xmlText);
  const out = new Array(values.length);
  const per = Array.isArray(ai);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out[i] = xmlText && dtn(types[i]) === 'xml' ? (v == null ? '\u0000' : 'x' + v) : keyOf(v, types[i], per ? ai[i] : ai);
  }
  return JSON.stringify(out);
}

// -------------------------------------------------------------------------------------- arithmetic

// Operator names of 8117 and 402 (01 §5.1): & | ^ are 'boolean AND', 'boolean OR' and 'boolean XOR'.
const OPN = { '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide', '%': 'modulo', '&': 'boolean AND', '|': 'boolean OR', '^': 'boolean XOR' };
const BITOPS = new Set(['&', '|', '^']);

function decResult(op, a, b) {
  const [p1, s1] = decPS(a), [p2, s2] = decPS(b);
  let p, s;
  switch (op) {
    case '+': case '-': s = Math.max(s1, s2); p = Math.max(p1 - s1, p2 - s2) + s + 1; break;
    case '*': p = p1 + p2 + 1; s = s1 + s2; break;
    case '/': s = Math.max(6, s1 + p2 + 1); p = p1 - s1 + s2 + s; break;
    default: s = Math.max(s1, s2); p = Math.min(p1 - s1, p2 - s2) + s; break;
  }
  if (p > 38) { s = Math.max(Math.min(s, 6), 38 - (p - s)); p = 38; }
  return { dt: 'decimal', prec: p, scale: s };
}

const bad8117 = (t, op) => E(8117, msgName(t), OPN[op]);
const bad402 = (a, b, op) => E(402, msgName(a), msgName(b), OPN[op]);
const isStrBin = t => t.dt === 'string' || t.dt === 'binary';
// Whether two date/time Types are the same kind (date, time, or one of datetime, smalldatetime, datetime2 and
// datetimeoffset whatever their precision).
const sameTemporal = (x, y) => x.dt === y.dt && (x.dt !== 'datetime' || dtKind(x) === dtKind(y));

// The length of a + b over strings or binary (01 §5): the sum, max beyond 4000 (nvarchar) / 8000 units or bytes.
function catLen(a, b, cap) {
  if (a.len == null || b.len == null) return undefined;
  return a.len < 0 || b.len < 0 || a.len + b.len > cap ? -1 : a.len + b.len;
}

function arithPlan(op, a0, b0) {
  if (!OPN[op]) throw E(102, op);
  // sql_variant has no arithmetic or string operators (8117); xml none at all (402, 01 §5.8)
  if (a0.dt === 'any' || b0.dt === 'any') throw bad8117(a0.dt === 'any' ? a0 : b0, op);
  if (a0.dt === 'xml' || b0.dt === 'xml') throw bad402(a0, b0, op);
  let a = a0, b = b0;
  // A bare NULL takes the other operand's type, except next to bit: NULL is int, so NULL + bit is int + bit.
  if (a.dt === 'null' && b.dt === 'null') a = b = INT;
  else if (a.dt === 'null') a = b.dt === 'bit' ? INT : b;
  else if (b.dt === 'null') b = a.dt === 'bit' ? INT : a;
  const bits = BITOPS.has(op);
  // uniqueidentifier has no operators: 402 with a string or binary operand and for & | ^ (`The data types varchar and
  // uniqueidentifier are incompatible in the add operator.`), 8117 with itself, 206 with any other type (SQL Server)
  if (a.dt === 'guid' || b.dt === 'guid') {
    const o = a.dt === 'guid' ? b : a;
    if (bits || isStrBin(o)) throw bad402(a, b, op);
    throw o.dt === 'guid' ? bad8117(a, op) : clash(a, b);
  }
  // date, time, datetime2 and datetimeoffset have no arithmetic: with a string, binary or another date/time type 402
  // (`The data types date and time are incompatible in the add operator.`); with their own type (8117) and with a
  // number (206) below
  const npa = TEMPORAL.has(a.dt) && !isPlainDt(a), npb = TEMPORAL.has(b.dt) && !isPlainDt(b);
  if (npa || npb) {
    const x = npa ? a : b, y = npa ? b : a;
    if (bits || isStrBin(y) || (TEMPORAL.has(y.dt) && !sameTemporal(x, y))) throw bad402(a, b, op);
  }
  if (isStrBin(a) && isStrBin(b)) {
    if (op === '+') {
      if (a.dt === 'binary' && b.dt === 'binary') {
        const r = { dt: 'binary' };
        const len = catLen(a, b, 8000);
        if (len !== undefined) r.len = len;
        return { kind: 'bincat', type: r, a, b };
      }
      // string + binary converts the binary to the string type (precedence, 01 §5.1)
      const uni = (a.dt === 'string' && a.unicode) || (b.dt === 'string' && b.unicode);
      const r = { dt: 'string' };
      const len = catLen(a, b, uni ? 4000 : 8000);
      if (len !== undefined) r.len = len;
      if (uni) r.unicode = true;
      return { kind: 'concat', type: r, a, b };
    }
    throw bits ? bad402(a, b, op) : bad8117(a.dt === 'string' ? a : b.dt === 'string' ? b : a, op);
  }
  // a string or binary operand converts to the other operand's type
  const ca = isStrBin(a) ? b : a, cb = isStrBin(b) ? a : b;
  // binary converts only to the integer types and bit (01 §5.4)
  if ((a.dt === 'binary' && !INTS.has(b.dt)) || (b.dt === 'binary' && !INTS.has(a.dt))) throw bits ? bad402(a, b, op) : clash(a, b);
  const ta = TEMPORAL.has(ca.dt), tb = TEMPORAL.has(cb.dt);
  if (ta || tb) {
    if (bits) throw bad402(a, b, op);
    if (op !== '+' && op !== '-') throw bad8117(ta ? ca : cb, op);
    for (const [x, y] of [[ca, cb], [cb, ca]]) {
      if (TEMPORAL.has(x.dt) && !isPlainDt(x)) throw isNum(y.dt) ? clash(x, y) : bad8117(x, op);
    }
    const small = (!ta || ca.small) && (!tb || cb.small);
    return { kind: 'dt', type: small ? { dt: 'datetime', small: true } : DATETIME, a, b, ca, cb };
  }
  if (bits) {
    for (const t of [ca, cb]) if (!INTS.has(t.dt)) throw bad402(a, b, op);
    const type = ca.dt === 'bigint' || cb.dt === 'bigint' ? BIGINT : ca.dt === 'bit' && cb.dt === 'bit' ? BIT : INT;
    return { kind: 'bits', type, a, b, ca, cb };
  }
  // bit with bit has no arithmetic in SQL Server: 8117 `Operand data type bit is invalid for add operator.`
  if (ca.dt === 'bit' && cb.dt === 'bit') throw bad8117(ca, op);
  if (op === '%' && (ca.dt === 'float' || cb.dt === 'float')) throw bad402(ca, cb, op);
  let type;
  if (ca.dt === 'float' || cb.dt === 'float') type = FLOAT;
  else if (ca.dt === 'decimal' || cb.dt === 'decimal') type = decResult(op, ca, cb);
  else if (ca.dt === 'money' || cb.dt === 'money') type = MONEY;
  else if (ca.dt === 'bigint' || cb.dt === 'bigint') type = BIGINT;
  else type = INT;
  return { kind: 'num', type, a, b, ca, cb };
}

// Static result type of `a op b` for + - * / % & | ^ (01 §5, §5.1): decimal p/s rules, concatenation, datetime ± days.
export function arithType(op, a, b) {
  return planType(arithPlan(op, ty(a), ty(b)));
}

// The fresh result Type of an arithmetic plan, numeric when every decimal operand is (see the notes above).
const planType = P => numericOf(pickType(P.type), P.ca || P.a, P.cb || P.b);

function intResult(op, x, y, big) {
  let r;
  switch (op) {
    case '+': r = x + y; break;
    case '-': r = x - y; break;
    case '*': r = x * y; break;
    case '/': if (y === 0) throw E8134(); r = Math.trunc(x / y); break;
    default: if (y === 0) throw E8134(); r = x % y; break;
  }
  if (big) {
    if (!Number.isSafeInteger(r) || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
      const bx = BigInt(Math.trunc(x)), by = BigInt(Math.trunc(y));
      const br = op === '+' ? bx + by : op === '-' ? bx - by : op === '*' ? bx * by : op === '/' ? bx / by : bx % by;
      if (br < -9223372036854775808n || br > 9223372036854775807n) throw E(8115, 'expression', 'bigint');
      r = Number(br);
    }
  } else if (r < -2147483648 || r > 2147483647) throw E(8115, 'expression', 'int');
  return r === 0 ? 0 : r;
}

// A bigint result r: beyond ±2^53 it adds the BIGINT_LOSS warning through env.warn (01 §5: never silent).
function bigWarn(r, o) {
  if (!Number.isSafeInteger(r) && o && o.warn) o.warn(BIGINT_LOSS);
  return r;
}

// An operand of static type `from` converted to the operation type `to` when it is a string or binary value.
const operand = (x, from, to, o) => ((typeof x === 'string' && from.dt === 'string') || (isBytes(x) && from.dt === 'binary') ? coerce(x, from, to, o) : x);

function numFn(op, P) {
  const t = P.type;
  return (x, y, o) => {
    if (x == null || y == null) return null;
    o = o || NO_OPTS;
    x = operand(x, P.a, P.ca, o);
    y = operand(y, P.b, P.cb, o);
    if (typeof x === 'boolean') x = +x;
    if (typeof y === 'boolean') y = +y;
    switch (t.dt) {
      case 'int': return intResult(op, x, y, false);
      case 'bigint': return bigWarn(intResult(op, x, y, true), o);
      case 'float': {
        if ((op === '/' || op === '%') && y === 0) throw E8134();
        const r = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? x / y : x % y;
        if (!Number.isFinite(r)) throw E(3623);
        return r === 0 ? 0 : r;
      }
      default: {
        if ((op === '/' || op === '%') && y === 0) throw E8134();
        const r = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? x / y : x % y;
        if (t.dt === 'money') {
          const m = roundDec(r, 4);
          if (!(m >= -922337203685477.5808 && m <= 922337203685477.5807)) throw E(8115, 'expression', 'money');
          return m;
        }
        if (!Number.isFinite(r)) throw E(8115, 'expression', 'numeric');
        return fitDec(r, t.prec, t.scale, 'expression');
      }
    }
  };
}

function bitsFn(op, P) {
  const big = P.type.dt === 'bigint';
  return (x, y, o) => {
    if (x == null || y == null) return null;
    o = o || NO_OPTS;
    x = operand(x, P.a, P.ca, o);
    y = operand(y, P.b, P.cb, o);
    if (typeof x === 'boolean') x = +x;
    if (typeof y === 'boolean') y = +y;
    if (big) {
      const bx = BigInt(x), by = BigInt(y);
      const r = BigInt.asIntN(64, op === '&' ? bx & by : op === '|' ? bx | by : bx ^ by);
      return bigWarn(Number(r), o);
    }
    const r = op === '&' ? x & y : op === '|' ? x | y : x ^ y;
    return r === 0 ? 0 : r;
  };
}

// datetime ± number and datetime ± datetime on wall-clock time (01 §5.1, §5.5). The result is resolved in the session
// tz, except that it stays UTC (own tzo 0, as functions.js DATEADD keeps it) when its base is a UTC value
// (GETUTCDATE): the datetime operand of datetime ± number, the minuend of datetime - datetime, and either operand of
// datetime + datetime (the other one is a duration since 1900, as in `GETUTCDATE() - '00:30'`). The arithmetic is on
// milliseconds, rounded to 1/300 s (smalldatetime: the minute), so it never creates ticks.
function dtFn(op, P) {
  const T = { k: 'dt', name: P.type.small ? 'smalldatetime' : 'datetime', small: !!P.type.small, prec: null, dto: false };
  return (x, y, o) => {
    if (x == null || y == null) return null;
    if (!o || o.tz == null) o = { ...o, tz: missingTz(`datetime '${op}'`) };
    const tz = o.tz;
    if (typeof x === 'string') x = coerce(x, P.a, P.ca, o);
    if (typeof y === 'string') y = coerce(y, P.b, P.cb, o);
    if (typeof x === 'boolean') x = +x;
    if (typeof y === 'boolean') y = +y;
    const xd = x instanceof Date, yd = y instanceof Date;
    const wx = xd ? wallMs(x, tz) : 0, wy = yd ? wallMs(y, tz) : 0;
    let W;
    if (op === '+') W = xd && yd ? wx + wy - W1900 : xd ? wx + y * DAY : wy + x * DAY;
    else W = xd && yd ? W1900 + wx - wy : xd ? wx - y * DAY : W1900 + x * DAY - (wy - W1900);
    const base = xd && yd ? (op === '-' || x.tzo === 0 ? x : y) : xd ? x : y;
    const utc = base.tzo === 0;
    if (Number.isFinite(W)) {
      W = roundMs(Math.round(W), T);
      if (wallInRange(W, T)) return utc ? mkDt(W, 0) : keepWall(W, tz);
    }
    throw E(517, T.name);
  };
}

// string + string and string + binary (the binary converted to the result's string type, 01 §5.1).
function concatFn(P) {
  const uni = !!P.type.unicode;
  const s = (v, t) => (typeof v === 'string' ? v : t.dt === 'binary' ? binText(v, null, uni) : toSqlString(v, t.dt === 'string' ? ANY : t));
  return (x, y) => (x == null || y == null ? null : s(x, P.a) + s(y, P.b));
}

// binary + binary: the bytes of both (01 §5.1).
function binCatFn() {
  return (x, y) => {
    if (x == null || y == null) return null;
    const r = new Uint8Array(x.length + y.length);
    r.set(x);
    r.set(y, x.length);
    return r;
  };
}

// Compiled `a op b` (01 §5.1): {type, fn(x, y, env)} with SQL semantics; env supplies tz and dateformat.
// datetime arithmetic needs env.tz (TypeError without it); bigint results beyond ±2^53 call env.warn(BIGINT_LOSS).
export function arithOp(op, a, b) {
  const P = arithPlan(op, ty(a), ty(b));
  const fn = P.kind === 'concat' ? concatFn(P) : P.kind === 'bincat' ? binCatFn() : P.kind === 'dt' ? dtFn(op, P)
    : P.kind === 'bits' ? bitsFn(op, P) : numFn(op, P);
  return { type: planType(P), fn };
}

// Compiled unary `-x`, `~x` or `+x` (01 §5.1): {type, fn(x, env)}; 8115 on int/bigint overflow, 8117 for other types
// (`Operand data type nvarchar is invalid for ~ operator.`); a bigint result beyond ±2^53 calls env.warn(BIGINT_LOSS).
export function unaryOp(op, type) {
  const t = ty(type);
  if (t.dt === 'null') return { type: { dt: 'int' }, fn: () => null };
  const rt = pickType(t);
  const opName = op === '-' ? 'minus' : op === '+' ? 'plus' : '~';
  const bad = () => E(8117, msgName(t), opName);
  if (op === '~') {
    if (t.dt === 'bit') return { type: rt, fn: x => (x == null ? null : x ? 0 : 1) };
    if (t.dt === 'int') return { type: rt, fn: x => (x == null ? null : ~x) };
    if (t.dt === 'bigint') return { type: rt, fn: (x, o) => (x == null ? null : bigWarn(Number(BigInt.asIntN(64, ~BigInt(x))), o)) };
    throw bad();
  }
  if (op !== '-' && op !== '+') throw E(102, op);
  if (!isNum(t.dt) || t.dt === 'bit') throw bad();
  if (op === '+') return { type: rt, fn: x => x };
  if (t.dt === 'int') {
    return { type: rt, fn: x => { if (x == null) return null; if (x === -2147483648) throw E(8115, 'expression', 'int'); return x === 0 ? 0 : -x; } };
  }
  if (t.dt === 'bigint') {
    return { type: rt, fn: (x, o) => { if (x == null) return null; if (x <= -9223372036854775808) throw E(8115, 'expression', 'bigint'); return x === 0 ? 0 : bigWarn(-x, o); } };
  }
  return { type: rt, fn: x => (x == null ? null : x === 0 ? 0 : -x) };
}

// ----------------------------------------------------------------------------------- server mapping

const SERVER_DT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?[ ]?(Z|[+-]\d{2}:?\d{2})?$/i;

function serverFields(s) {
  const m = SERVER_DT.exec(String(s).trim());
  if (!m) throw E241();
  const frac = (m[7] || '').padEnd(7, '0');
  let off = 0;
  if (m[8] && m[8].toUpperCase() !== 'Z') {
    const z = m[8].replace(':', '');
    off = (z[0] === '-' ? -1 : 1) * (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5)));
  }
  return { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0), ms: Math.floor(+frac / 10000), off };
}

const NUMERIC_TYPES = new Set(['Integer', 'BigInt', 'Decimal', 'Double', 'Money', 'Picklist', 'State', 'Status']);
const GUID_TYPES = new Set(['Lookup', 'Customer', 'Owner', 'Uniqueidentifier']);

// Web API value -> engine value by attribute type and DateTimeBehavior (01 §5.3, 02 §5).
export function fromServer(value, attr, tz) {
  if (value == null) return null;
  const t = attr && attr.type;
  if (t === 'DateTime') {
    const p = serverFields(value);
    if (attr.behavior === 'DateOnly') return utcDate(p.y, p.m, p.d);
    const W = wallOf(p);
    if (attr.behavior === 'TimeZoneIndependent') return keepWall(W, tz);
    return new Date(W - p.off * 60000);
  }
  // a BooleanManagedProperty {Value, CanBeChanged, ManagedPropertyLogicalName} is its Value, a bit (dtOfAttr)
  if (t === 'ManagedProperty') {
    const x = typeof value === 'object' ? value.Value : value;
    return x == null ? null : x === true || x === 'true' || x === 1 || x === '1' ? 1 : 0;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (t === 'Boolean') return value === 'true' || value === 1 || value === '1' ? 1 : 0;
  if (GUID_TYPES.has(t) && typeof value === 'string') return value.toLowerCase();
  if (NUMERIC_TYPES.has(t) && typeof value === 'string' && FLT_RE.test(value.trim())) return Number(value);
  // Image columns are varbinary(max): the bytes of the Web API base64 value (02 §5)
  if (t === 'Image' && typeof value === 'string') return base64Bytes(value);
  // an object or array where dtOfAttr gives text (CalendarRules, an attribute type it does not list) is its JSON
  // text, never '[object Object]'
  if (typeof value === 'object' && attr && dtOfAttr(attr).dt === 'string') return JSON.stringify(value);
  return value;
}

// The bytes of base64 text (atob; a malformed value throws).
function base64Bytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isoWall(p, ms) {
  return `${p4(p.y)}-${p2(p.m)}-${p2(p.d)}T${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}${ms ? '.' + p3(ms) : ''}`;
}

// Engine value -> Web API value for writes (02 §8.1): DateOnly 'yyyy-MM-dd', TimeZoneIndependent wall-clock + Z,
// UserLocal toISOString(); booleans true/false; GUIDs lower case; bytes base64. opts (env) gives the DATEFORMAT of
// the string fallback (see the notes above).
export function toServer(value, attr, tz, opts) {
  if (value == null) return null;
  const t = attr && attr.type;
  if (t === 'DateTime') {
    let d = value;
    if (!(d instanceof Date)) {
      const dateformat = opts && opts.dateformat;
      // A TimeZoneIndependent column takes the written wall-clock fields as they are (an offset is dropped, as a
      // CAST to datetime drops it), so a DST-gap time of the session tz is sent unchanged.
      if (attr.behavior === 'TimeZoneIndependent') { const p = parseFields(String(d), { dateformat }); return isoWall(p, p.ms) + 'Z'; }
      d = attr.behavior === 'DateOnly' ? castValue(String(d), NVAR, 'date', { tz, dateformat }) : parseDate(String(d), { tz, dateformat });
    }
    if (attr.behavior === 'DateOnly') return `${p4(d.getUTCFullYear())}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
    if (attr.behavior === 'TimeZoneIndependent') { const p = dateParts(d, tz); return isoWall(p, p.ms) + 'Z'; }
    return d.toISOString();
  }
  if (t === 'Boolean') return value === true || (typeof value === 'number' && value !== 0);
  if (GUID_TYPES.has(t)) return String(value).toLowerCase();
  if (isBytes(value)) return base64(value);
  return value;
}

// ------------------------------------------------------------------------------------------ time zones

// Windows time zone names of sys.time_zone_info -> IANA ids (CLDR windowsZones, territory 001). Parsed on first use.
export const WIN_ZONES = 'Dateline Standard Time=Etc/GMT+12;UTC-11=Etc/GMT+11;Aleutian Standard Time=America/Adak;' +
  'Hawaiian Standard Time=Pacific/Honolulu;Marquesas Standard Time=Pacific/Marquesas;Alaskan Standard Time=America/Anchorage;' +
  'UTC-09=Etc/GMT+9;Pacific Standard Time (Mexico)=America/Tijuana;UTC-08=Etc/GMT+8;Pacific Standard Time=America/Los_Angeles;' +
  'US Mountain Standard Time=America/Phoenix;Mountain Standard Time (Mexico)=America/Mazatlan;Mountain Standard Time=America/Denver;' +
  'Yukon Standard Time=America/Whitehorse;Central America Standard Time=America/Guatemala;Central Standard Time=America/Chicago;' +
  'Easter Island Standard Time=Pacific/Easter;Central Standard Time (Mexico)=America/Mexico_City;' +
  'Canada Central Standard Time=America/Regina;SA Pacific Standard Time=America/Bogota;' +
  'Eastern Standard Time (Mexico)=America/Cancun;Eastern Standard Time=America/New_York;Haiti Standard Time=America/Port-au-Prince;' +
  'Cuba Standard Time=America/Havana;US Eastern Standard Time=America/Indianapolis;' +
  'Turks And Caicos Standard Time=America/Grand_Turk;Paraguay Standard Time=America/Asuncion;' +
  'Atlantic Standard Time=America/Halifax;Venezuela Standard Time=America/Caracas;Central Brazilian Standard Time=America/Cuiaba;' +
  'SA Western Standard Time=America/La_Paz;Pacific SA Standard Time=America/Santiago;Newfoundland Standard Time=America/St_Johns;' +
  'Tocantins Standard Time=America/Araguaina;E. South America Standard Time=America/Sao_Paulo;' +
  'SA Eastern Standard Time=America/Cayenne;Argentina Standard Time=America/Buenos_Aires;Greenland Standard Time=America/Godthab;' +
  'Montevideo Standard Time=America/Montevideo;Magallanes Standard Time=America/Punta_Arenas;' +
  'Saint Pierre Standard Time=America/Miquelon;Bahia Standard Time=America/Bahia;UTC-02=Etc/GMT+2;' +
  'Mid-Atlantic Standard Time=Etc/GMT+2;Azores Standard Time=Atlantic/Azores;Cape Verde Standard Time=Atlantic/Cape_Verde;' +
  'UTC=Etc/UTC;GMT Standard Time=Europe/London;Greenwich Standard Time=Atlantic/Reykjavik;Sao Tome Standard Time=Africa/Sao_Tome;' +
  'Morocco Standard Time=Africa/Casablanca;W. Europe Standard Time=Europe/Berlin;Central Europe Standard Time=Europe/Budapest;' +
  'Romance Standard Time=Europe/Paris;Central European Standard Time=Europe/Warsaw;W. Central Africa Standard Time=Africa/Lagos;' +
  'Jordan Standard Time=Asia/Amman;GTB Standard Time=Europe/Bucharest;Middle East Standard Time=Asia/Beirut;' +
  'Egypt Standard Time=Africa/Cairo;E. Europe Standard Time=Europe/Chisinau;Syria Standard Time=Asia/Damascus;' +
  'West Bank Standard Time=Asia/Hebron;South Africa Standard Time=Africa/Johannesburg;FLE Standard Time=Europe/Kiev;' +
  'Israel Standard Time=Asia/Jerusalem;South Sudan Standard Time=Africa/Juba;Kaliningrad Standard Time=Europe/Kaliningrad;' +
  'Sudan Standard Time=Africa/Khartoum;Libya Standard Time=Africa/Tripoli;Namibia Standard Time=Africa/Windhoek;' +
  'Arabic Standard Time=Asia/Baghdad;Turkey Standard Time=Europe/Istanbul;Arab Standard Time=Asia/Riyadh;' +
  'Belarus Standard Time=Europe/Minsk;Russian Standard Time=Europe/Moscow;E. Africa Standard Time=Africa/Nairobi;' +
  'Volgograd Standard Time=Europe/Volgograd;Iran Standard Time=Asia/Tehran;Arabian Standard Time=Asia/Dubai;' +
  'Astrakhan Standard Time=Europe/Astrakhan;Azerbaijan Standard Time=Asia/Baku;Russia Time Zone 3=Europe/Samara;' +
  'Mauritius Standard Time=Indian/Mauritius;Saratov Standard Time=Europe/Saratov;Georgian Standard Time=Asia/Tbilisi;' +
  'Caucasus Standard Time=Asia/Yerevan;Afghanistan Standard Time=Asia/Kabul;West Asia Standard Time=Asia/Tashkent;' +
  'Ekaterinburg Standard Time=Asia/Yekaterinburg;Pakistan Standard Time=Asia/Karachi;Qyzylorda Standard Time=Asia/Qyzylorda;' +
  'India Standard Time=Asia/Calcutta;Sri Lanka Standard Time=Asia/Colombo;Nepal Standard Time=Asia/Katmandu;' +
  'Central Asia Standard Time=Asia/Bishkek;Bangladesh Standard Time=Asia/Dhaka;Omsk Standard Time=Asia/Omsk;' +
  'Myanmar Standard Time=Asia/Rangoon;SE Asia Standard Time=Asia/Bangkok;Altai Standard Time=Asia/Barnaul;' +
  'W. Mongolia Standard Time=Asia/Hovd;North Asia Standard Time=Asia/Krasnoyarsk;N. Central Asia Standard Time=Asia/Novosibirsk;' +
  'Tomsk Standard Time=Asia/Tomsk;China Standard Time=Asia/Shanghai;North Asia East Standard Time=Asia/Irkutsk;' +
  'Singapore Standard Time=Asia/Singapore;W. Australia Standard Time=Australia/Perth;Taipei Standard Time=Asia/Taipei;' +
  'Ulaanbaatar Standard Time=Asia/Ulaanbaatar;Aus Central W. Standard Time=Australia/Eucla;Transbaikal Standard Time=Asia/Chita;' +
  'Tokyo Standard Time=Asia/Tokyo;North Korea Standard Time=Asia/Pyongyang;Korea Standard Time=Asia/Seoul;' +
  'Yakutsk Standard Time=Asia/Yakutsk;Cen. Australia Standard Time=Australia/Adelaide;AUS Central Standard Time=Australia/Darwin;' +
  'E. Australia Standard Time=Australia/Brisbane;AUS Eastern Standard Time=Australia/Sydney;' +
  'West Pacific Standard Time=Pacific/Port_Moresby;Tasmania Standard Time=Australia/Hobart;' +
  'Vladivostok Standard Time=Asia/Vladivostok;Lord Howe Standard Time=Australia/Lord_Howe;' +
  'Bougainville Standard Time=Pacific/Bougainville;Russia Time Zone 10=Asia/Srednekolymsk;Magadan Standard Time=Asia/Magadan;' +
  'Norfolk Standard Time=Pacific/Norfolk;Sakhalin Standard Time=Asia/Sakhalin;Central Pacific Standard Time=Pacific/Guadalcanal;' +
  'Russia Time Zone 11=Asia/Kamchatka;New Zealand Standard Time=Pacific/Auckland;UTC+12=Etc/GMT-12;' +
  'Fiji Standard Time=Pacific/Fiji;Kamchatka Standard Time=Asia/Kamchatka;Chatham Islands Standard Time=Pacific/Chatham;' +
  'UTC+13=Etc/GMT-13;Tonga Standard Time=Pacific/Tongatapu;Samoa Standard Time=Pacific/Apia;' +
  'Line Islands Standard Time=Pacific/Kiritimati';

let winMap = null;

// Parsed WIN_ZONES: Map<lower-case Windows name, {name, iana}> in sys.time_zone_info order.
export function winZones() {
  if (!winMap) {
    winMap = new Map();
    for (const e of WIN_ZONES.split(';')) {
      const i = e.indexOf('=');
      winMap.set(e.slice(0, i).toLowerCase(), { name: e.slice(0, i), iana: e.slice(i + 1) });
    }
  }
  return winMap;
}

const IANA_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const UTC_IDS = new Set(['UTC', 'Etc/UTC', 'Etc/UCT', 'UCT', 'Etc/GMT', 'GMT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu',
  'Etc/GMT0', 'GMT0', 'Etc/GMT+0', 'Etc/GMT-0', 'GMT+0', 'GMT-0', 'Etc/Greenwich', 'Greenwich']);
const ZONES = new Map();
const LONG_OFF = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?)?$/;

function makeZone(iana, name) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: iana, timeZoneName: 'longOffset', year: 'numeric' });
  const canonical = fmt.resolvedOptions().timeZone;
  if (UTC_IDS.has(canonical) || UTC_IDS.has(iana)) return { utc: true, offset: () => 0, name };
  const exact = ms => {
    const part = fmt.formatToParts(ms).find(x => x.type === 'timeZoneName');
    const m = part && LONG_OFF.exec(part.value);
    if (!m) throw E(9820, name);
    if (!m[1]) return 0;
    const sec = Number(m[2]) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
    const r = Math.round(sec / 60) * (m[1] === '-' ? -1 : 1);
    return r === 0 ? 0 : r;
  };
  const days = new Map();
  const offset = ms => {
    const day = Math.floor(ms / DAY);
    let v = days.get(day);
    if (v === undefined) {
      const a = exact(day * DAY), b = exact(day * DAY + DAY - 1);
      v = a === b ? a : NaN;
      if (days.size > 20000) days.clear();
      days.set(day, v);
    }
    return Number.isNaN(v) ? exact(ms) : v;
  };
  return { utc: false, offset, name };
}

// Time zone for a Windows zone name (WIN_ZONES, case-insensitive) or an IANA id: {utc, offset(ms), name} | null.
export function zoneTz(name) {
  if (typeof name !== 'string') return null;
  const n = trimR(name);
  const k = n.toLowerCase();
  if (ZONES.has(k)) return ZONES.get(k);
  let z = null;
  const win = winZones().get(k);
  try {
    if (win) z = makeZone(win.iana, win.name);
    else if (IANA_RE.test(n)) {
      const canonical = new Intl.DateTimeFormat('en-US', { timeZone: n }).resolvedOptions().timeZone;
      z = makeZone(canonical, canonical);
    }
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    z = null;
  }
  if (ZONES.size > 1000) ZONES.clear();
  ZONES.set(k, z);
  return z;
}

// `v AT TIME ZONE zone` (01 §5.5): a datetimeoffset with the zone's offset (tzo) and v's ticks; NULL in, NULL out.
export function atTimeZone(v, type, zone, tz) {
  let t = ty(type);
  if (t.dt === 'any' && v != null) [v, t] = unwrap(v);
  if (t.dt !== 'datetime' && t.dt !== 'null' && t.dt !== 'any') throw E(8116, msgName(t), 1, 'AT TIME ZONE');
  if (v == null || zone == null) return null;
  if (typeof zone !== 'string') {
    throw E(8116, typeof zone === 'number' ? 'int' : zone instanceof Date ? 'datetime' : 'sql_variant', 2, 'AT TIME ZONE');
  }
  const z = zoneTz(zone);
  if (!z) throw E(9820, zone);
  if (t.dto) return withOffset(v, z.offset(v.getTime()));
  const inst = fromWall(wallMs(v, tz), z);
  return mkDt(inst, z.offset(inst), tkOf(v));
}

// --------------------------------------------------------------------------------------------- FOR JSON

const JSON_ESC = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r', 34: '\\"', 47: '\\/', 92: '\\\\' };

// STRING_ESCAPE(s, 'json') (01 §5.6): " \ / and control characters escaped (\uXXXX for the others below 0x20).
export function jsonEscape(s) {
  let out = '', last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 34 || c === 47 || c === 92) {
      out += s.slice(last, i) + (JSON_ESC[c] || '\\u' + c.toString(16).padStart(4, '0'));
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

const jsonNum = x => (Number.isFinite(x) ? String(x === 0 ? 0 : x) : 'null');

// JSON text of one value for FOR JSON (01 §5.6), or null for NULL (the caller omits it or writes null): binary as
// base64, xml as its serialised text, a sql_variant by its base type.
export function jsonValue(v, type, tz) {
  if (v == null) return null;
  let t = ty(type);
  if (t.dt === 'any' || t.dt === 'null') {
    if (typeof v === 'number') return jsonNum(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    [v, t] = unwrap(v);
  }
  switch (t.dt) {
    case 'bit': return v ? 'true' : 'false';
    case 'int': case 'bigint': return intStr(v);
    case 'decimal': return t.scale == null ? plainNum(v) : decStr(v, t.scale);
    case 'money': return decStr(v, 4);
    case 'float': return jsonNum(v);
    case 'guid': return '"' + String(v).toLowerCase() + '"';
    case 'date': return `"${p4(v.getUTCFullYear())}-${p2(v.getUTCMonth() + 1)}-${p2(v.getUTCDate())}"`;
    case 'time': {
      // its type's digits (time(n): n, a time widened by CASE or UNION keeps fewer in its string), as toSqlString
      const x = timeParts(v), nd = t.prec ?? 7;
      return '"' + p2(x.h) + ':' + p2(x.mi) + ':' + p2(x.s) + (nd ? '.' + x.frac7.slice(0, nd) : '') + '"';
    }
    case 'binary': return '"' + base64(v) + '"';
    case 'datetime': {
      const x = tfields(v, t, tz);
      const frac = /^0*$/.test(x.frac) ? '' : '.' + x.frac;
      return `"${p4(x.y)}-${p2(x.m)}-${p2(x.d)}T${p2(x.h)}:${p2(x.mi)}:${p2(x.s)}${frac}${x.off == null ? '' : offStr(x.off)}"`;
    }
    default: return '"' + jsonEscape(String(v)) + '"';
  }
}
