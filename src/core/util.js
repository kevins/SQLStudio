// Shared helpers (00 §3).

// Validated absolute URL for links the user clicks (https:, blob: or same-origin), or null when not allowed.
export function safeUrl(u) {
  let url;
  try { url = new URL(String(u), location.href); } catch { return null; }
  return url.protocol === 'https:' || url.protocol === 'blob:' || url.origin === location.origin ? url.href : null;
}

// URL for anything the browser loads by itself (img/video src, SVG href, form action): same-origin or
// blob: only, else null. SQL Studio never makes the browser contact any other host.
export function localUrl(u) {
  let url;
  try { url = new URL(String(u), location.href); } catch { return null; }
  return url.protocol === 'blob:' || url.origin === location.origin ? url.href : null;
}

// Optimal-string-alignment (Damerau-Levenshtein) distance, case-insensitive; returns lim + 1 once it exceeds lim.
function dl(a, b, lim) {
  if (Math.abs(a.length - b.length) > lim) return lim + 1;
  let p2 = null, p1 = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + cost);
      if (p2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > lim) return lim + 1;
    p2 = p1;
    p1 = cur;
  }
  return p1[b.length];
}

// Did-you-mean names for an unknown `name` (01 §2): candidates are names or [name, displayName] pairs.
// Matches: edit distance <= 2 (<= 3 for names over 10 chars) against the name or display name, or a
// prefix/contains relation (names of 3+ chars). Best first; at most `max` distinct names.
export function suggest(name, candidates, max = 3) {
  const q = String(name).toLowerCase();
  if (!q) return [];
  const lim = q.length > 10 ? 3 : 2;
  const scored = [];
  const seen = new Set();
  for (const c of candidates) {
    const [n, display] = Array.isArray(c) ? c : [c, null];
    if (n == null || seen.has(n)) continue;
    const forms = [String(n).toLowerCase()];
    if (display) forms.push(String(display).toLowerCase());
    let d = lim + 1, rel = 2;
    for (const f of forms) {
      if (f === q) continue;
      d = Math.min(d, dl(q, f, lim));
      if (q.length >= 3) {
        if (f.startsWith(q) || q.startsWith(f)) rel = Math.min(rel, 0);
        else if (f.includes(q) || q.includes(f)) rel = Math.min(rel, 1);
      }
    }
    if (d > lim && rel === 2) continue;
    seen.add(n);
    scored.push({ n: String(n), d: d > lim ? 9 : d, rel, len: Math.abs(String(n).length - q.length) });
  }
  scored.sort((a, b) => a.d - b.d || a.rel - b.rel || a.len - b.len || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
  return scored.slice(0, max).map(x => x.n);
}

// ==============================================================================================================
// Every other helper of 03 §1.1. Pure helpers first (timing, number, date and
// duration formatting, formatCell, ids and text, SQL names and literals, links), then the DOM helpers, which run
// only in Edge (openUrl, download, saveFile, openFile, copyText, copyBlob, yieldToUi; 03 §12, §13). Imports (00 §3,
// 01 §1): the pure value helpers of engine/types.js, SqlError and RESERVED from engine/lexer.js and msg from
// engine/messages.js; nothing from ui/ or data/.
//
// Notes:
// - Imports: msg from engine/messages.js (allowed by 01 §2.1); it fills the placeholders of the
//   MESSAGES texts, so no text is copied here.
// - fmtNumber(n, {dp, grouping, compact, numberFormat}) / fmtInt: numberFormat = {group, decimal} replaces the en-US
//   separators only when both are strings of at most 3 characters without digits, '+', '-' or 'e', group may be ''
//   (no grouping) and differs from decimal; anything else means en-US. Its validated form is cached with the group
//   and decimal values and redone when they change. Without dp a number shows at most 15 significant digits
//   (binary noise hidden) but never fewer than its integer digits while |n| < 2^53, so every safe integer shows all
//   its digits (fmtNumber(9007199254740991) = '9,007,199,254,740,991'; a status-bar Sum equals the cells it sums,
//   00 §1), in plain notation for 1e-6 <= |n| < 1e21 and JS exponent form outside; the largest doubles, whose 15-digit
//   rounding overflows, show their rounded digits ('1.79769313486232e+308', never 'Infinity'). A number with
//   2^53 <= |n| < 1e21 is an integer that may already be rounded (02 §5), so fmtNumber shows '≈' and the double's
//   exact digits, as formatCell's unsafe integers do (fmtNumber(2 ** 53) = '≈9,007,199,254,740,992'), never
//   zero-padded digits that look exact (a status-bar Sum over large bigint cells); with dp, dp zeros follow
//   (fmtInt(2 ** 60) = '≈1,152,921,504,606,846,976'). Otherwise dp (clamped to 0..100) gives exactly dp decimals
//   (plain digits at every magnitude, so 1e21 with dp 2 is '1,000,000,000,000,000,000,000.00'), rounded half away
//   from zero on the decimal text (types.toSqlString of decimal(·, dp), never toFixed; formatCell's Friendly decimal
//   and money cells use the same text without the '≈' form). compact applies from |n| >= 10,000 only
//   (Intl.NumberFormat('en-US', {notation: 'compact'})). BigInts are exact (with dp, dp zeros follow the point).
//   Grouping is an index loop, so a BigInt of any length costs O(n) (03 §13).
//   NaN and ±Infinity give 'NaN', '∞', '-∞'; null and undefined '—'. Strings count only when numeric
//   (/^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i, an unambiguous pattern, so a crafted string costs O(n));
//   every other value ('', 'abc', '0x10', booleans, arrays, Dates, objects) gives 'NaN', never a silent 0 or 1.
// - fmtDuration(ms, {unit}?): under 100 ms 'N ms'; under 10 s seconds with 2 significant digits ('0.82 s', '1.2 s',
//   '2 s'); under 1 min whole seconds; then '1 min 5 s' / '2 min' and '1 h 2 min' / '3 h'. {unit: 'ms'} always gives
//   whole milliseconds ('1,234 ms'). Negative values count as 0; NaN and ±Infinity give '—'.
// - fmtBytes(n): one decimal below 10 of a unit, whole numbers from 10; a value that would round to 1,024 of a unit
//   moves up ('1 MB', never '1,024 KB'); NaN and ±Infinity give '—'.
// - fmtDate(d, tz, {dateOnly, ms, date}): an invalid date, and anything that is neither a Date nor a number (null
//   included, never read as 1970-01-01), gives 'Invalid date'.
// - formatCell, beyond 03 §1.1 and §7 Cells:
//   - The inputs the cached column analysis records (03 §1.1): the column's dt, scale, dto and role, its type, attr,
//     companion and ref objects by identity and the fields of them it uses (incl. attr.isPk and attr.entity, which
//     give a primary key its ref through dtOfAttr, and ref.poly).
//   - Without a label, a choice value that is not a number or BigInt, and a bit value that is not a boolean, number
//     or BigInt, is shown by its JS type like any mismatched value: text gets ⏎ and the cut, '' the empty marker,
//     never cls 'num'. Columns with role 'name' or 'type' are plain text.
//   - A record link (icon 'link', 03 §1.1) is exactly what recordUrl accepts: the value is a GUID and the cell's
//     table, lower-cased, matches ^[a-z0-9_]+$, has at most 128 characters and is known through opts.known (a
//     per-call (logicalName) => boolean, as recordUrl takes it; formatCell's 03 §1.1 option list lacks it) or the setKnownTables check, read on every call (never cached in the column analysis). So no cell links
//     before main.js registers the check after meta.init (03 §11), and none for a table missing from metadata or a
//     name recordUrl refuses ('my table', '../x'): the grid and the XLSX links (03 §7.1) agree, and the grid never
//     draws a link icon for which recordUrl has no URL. The title '<table> · <id>' names the lower-cased table.
//   - Lookup cells (Friendly): the table is row[companion.type], else col.ref.entity, else the attr's single target.
//     With a record link: icon 'link' and the title '<table> · <id>'; without one a name cell's title is just the id
//     and a cell without a name is the plain GUID cell. When the shown name was shortened (⏎, the cut) the full name
//     and a line break come first in the title.
//   - Ref cells (03 §7: a uniqueidentifier column with `ref` lineage and no name companion; the lineage is col.ref,
//     else the ref of a Type in col.type, else the ref dtOfAttr gives a primary-key attribute, so a pass-through
//     primary key links like an entityreference): the GUID (cls 'guid'), with icon 'link' and title
//     '<table> · <id>' in both modes when it has a record link; the table is ref.entity, or row[companion.type] for
//     {poly}. An {entityFn} ref is a plain GUID cell: it reads the run's env (01 §6.1), which a result cell no longer
//     has (calling it later would read a variable's current value, not the row's). That covers every read
//     of a uniqueidentifier or entityreference variable that keeps a ref (`DECLARE @r entityreference = …; SELECT
//     @r`, `SELECT @id` after `SET @id = @@IDENTITY`; 01 §6.2), not only CREATELOOKUP(@t, id) with a dynamic table,
//     although 03 §7 lists these among the linking cells. Compile/projectSchema could resolve a
//     variable read to {entity} at statement time (its ref is the same for every row) and an entityFn per row into a
//     hidden role-'type' companion with ref {poly: true} and companion.type, both of which formatCell and the grid
//     already link.
//   - Unsafe integers (02 §5 records form (a), the FormattedValue companion): two more forms are shown exactly, a
//     JS BigInt (its exact digits, grouped in Friendly) and an int/bigint cell value that is the FormattedValue or
//     digit string itself (optional sign '-' or U+2212, or '(…)'; digits plain or in groups of three with one
//     separator from , . ' ’ space NBSP NNBSP) beyond ±(2^53 - 1): Friendly shows the string, Raw its plain digits.
//     Any other string in an int/bigint column is shown as text (by its JS type).
//   - '≈' with the warn icon marks only unsafe int/bigint cells (02 §5). Every other number cell shows fmtNumber's
//     digits without that form: Friendly float, decimal without a scale and numbers in 'any' columns or in columns
//     of another type show at most 15 significant digits (never fewer than the integer digits below 2^53), so from
//     2^53 to 1e21 the 15-digit text in plain digits, as Raw float shows it (float 123456789012345678 gives
//     '123,456,789,012,346,000' and Raw '123456789012346000'); Raw numbers in 'any' columns, and numbers in text
//     columns in both modes, show the same digits without grouping or separators. A decimal scale outside SQL
//     Server's 0..38 counts as no scale (never a padding of millions of zeros).
//   - A number cell whose text is longer than max graphemes (at the default 500 only a BigInt's digits can be) is
//     cut like long text outside full mode: truncateText(text, max), the title the full text, followed by a line
//     break and the warn text when the cell has one (03 §13: a grid cell never holds the 400,000 digits of a crafted
//     BigInt).
//   - Raw float text is types.floatText15 (01 §5), never a local copy. Its 01 §5 formula (the 15-digit text read
//     back with Number) overflows to Infinity for |x| >= 1.797693134862315e308; types.js keeps the rounded text
//     for those ('1.79769313486232e+308', SQL Server's 1.79769313486232E+308), which the Raw float cells rely on.
//   - Binary: a Uint8Array is binary in every column (no other value is one). Only the bytes that can survive
//     the cut are converted to hex, so a cell costs O(max) whatever the size; when the text is cut, `title` (the
//     full hex text) is an enumerable getter built on first read, so a grid of 30 MB images never builds it as long
//     as callers read cell.title only when they show it (the tooltip on hover). Spreading, Object.assign, JSON or
//     destructuring a cell object reads the getter and builds the full hex of every such cell, so a dialog that reads f.title for every sample
//     cell when it opens builds the hex of every Image/File value there; read it on first pointerenter or focus instead.
//   - Datetimes: a Date in a column of another type is read as datetime2(7), so ticks it carries are shown. The
//     Friendly datetimeoffset offset is the one types.isoText writes in the Raw text (no local offset formatter).
//   - dateFormat is {date, time, lcid?}: meta.user.dateFormat, timeFormat and lcid (month names and AM/PM
//     designators come from Intl for that LCID, 03 §7, through the LCID table below, 'en-US' when unknown or not
//     supported). 03 §1.1 and §1.4 name {date, time} only, so a caller coded to them (grid.js, export, dialogs) gets
//     en-US names (lcid = meta.user.lcid, the uilanguageid; usersettings.localeid, which Dataverse formats follow,
//     is not read by meta.js). A part
//     that is not a non-empty string of at most 256 characters keeps the default pattern
//     (yyyy-MM-dd, HH:mm:ss). It applies to Friendly datetime cells (date + ' ' + time; DateOnly-format attributes
//     the date only), date values (the date pattern on their UTC fields), datetimeoffset values (date + ' ' + time +
//     ' ' + their offset) and Dates in columns of another type; never to Raw, time values or sorting. Patterns:
//     runs of d, M, y, h, H, m, s and t are .NET custom tokens when 03 §7 lists them (d dd M MM MMM MMMM yy yyyy h hh
//     H HH m mm s ss t tt), any other run (ddd, y, fff, …) and any other character is written as is; '…' and "…"
//     are literals (an unclosed quote runs to the end) and `\x` writes x, as .NET does; '/' and ':' are written as
//     they are (the Dataverse format strings already hold the user's separators). Month names are Gregorian
//     (calendar 'gregory', whatever the locale's default: th-TH buddhist, fa-IR persian). MMM and MMMM use the
//     standalone name (Intl's whole month-only text, so '3月' in ja-JP and '三月' in zh-CN, never the bare '3' of its
//     month part), except that with a d or dd token in the pattern they use the genitive name, as .NET does: the
//     month part of Intl's day + month text ('marta' in ru-RU), or the standalone name when that part is only
//     digits (ja-JP, zh-CN, zh-TW: '3' of '3月15日'). t is the first character of the designator. Compiled patterns
//     are cached (64). LCID table: the same LCID → locale list as types.js's collation locales, a copy because the
//     01 §5 export list does not name lcidToLocale (types.js offers it, see its notes at the top of that file).
//   - sql_variant: formatted without the row's companions and the label hook (they belong to the outer column).
// - uid(prefix = 'u'): crypto.getRandomValues; a null prefix counts as 'u'. clamp: v may also be a BigInt or a
//   numeric string (fmtNumber's pattern). isGuid: non-strings give false.
// - safeFileName(s, fallback = 'untitled'): NFC; invisible format characters (\p{Cf}, incl. bidi overrides) are
//   removed except ZWJ and ZWNJ; control characters other than white space are removed; every white-space run
//   (incl. the runs a removed character joined) becomes one space; < > : " / \ | ? * become '_'; leading and
//   trailing dots, spaces, ZWJ and ZWNJ are removed; a Windows device name (CON, PRN, AUX, NUL, COM0-9, LPT0-9, incl.
//   ¹²³) before the first dot gets '_' appended; then at most 100 UTF-16 units, cut at a grapheme boundary; an
//   empty result gives the fallback (null counts as 'untitled'). Every step is O(n) (the edges are trimmed with
//   index loops), so a pasted 10 MB title never blocks the UI (03 §13).
// - truncateText(s, n): n counts graphemes of the result, '…' included; the kept part loses trailing white space;
//   n < 1 and null/undefined give ''. Two UTF-16 caps keep a crafted value O(n) (03 §13; 'a' followed by 200,000
//   combining marks is one grapheme). With B = 16·n + 64: a grapheme cluster longer than 64 units ends the text
//   (when it is grapheme k <= n - 2 and starts at most B - 64 units in, its first 64 units are kept, cut at a code
//   point boundary, then '…'; otherwise the text is cut before it), and any other grapheme that would end more than
//   B units in is cut before. The result is never longer than B + 1 units, only the first B + 67 units are read, and
//   every decision depends only on the text read so far.
// - sqlName(n): also brackets GO (any case), which is not a reserved word: a bare `go` alone on a line (one column
//   per line in Script as) would split the batch (01 §4.5), so it is not injection-safe. TypeError for null,
//   undefined and ''.
// - sqlLit(v, dt, {tz}), beyond 03 §1.1:
//   - int and bigint: 'Cannot write 1.5 as a SQL int literal: it is not a whole number.' With dt 'any' an integer
//     beyond ±(2^53 - 1) is a float value, written in exponent form. With dt float a BigInt of more than 38 digits
//     is the exponent form of its float value (8115 float beyond ±1.8E+308). 1007 shows the digits cut to 40
//     characters + '…'.
//   - datetime and datetimeoffset text is types.isoText of dt (tick digits for a datetime2(n) or
//     datetimeoffset(n) dt whose value carries ticks; a Date with dt missing, 'any' or 'null' is read as
//     datetime2(7)). A datetimeoffset never reads opts.tz: a value without tzo is written at +00:00, the text the
//     Raw cell shows (03 §7, 01 §5.5), and its year range is checked on those fields.
//   - xml values (strings) are written through sqlStr (an N'…' literal converts to xml); a SqlVariant is written by
//     its base value and base type; a Uint8Array with dt missing, 'any' or 'null' is binary.
//   - Mismatch texts name the JS kind of the value ('a binary value' for a Uint8Array) and the SQL type of dt
//     (nvarchar, varbinary, xml, datetime2, datetimeoffset, sql_variant for 'any').
// - Links: a table name longer than 128 characters is never known (recordUrl, listUrl, openUrl).
// - openUrl(url, {sameTab, known}): a page of this origin may also be http: (the dev build, 04 §3.3). Its 03 §12 (a)
//   branch also checks what recordUrl/listUrl check (00 §5 rule 6: GUID + known table, current appid): the table
//   must be known (setKnownTables, or opts.known, as for recordUrl) and an appid must be the host's current GUID
//   appid (a URL without appid opens too, as recordUrl builds on a host without one), so a hand-built main.aspx URL
//   cannot pass the only navigation choke point.
// - download(blob, name): TypeError for a non-Blob; an empty name becomes 'download'.
// - saveFile: Chromium creates the file the user picks in showSaveFilePicker, or empties the existing file, as soon as
//   the picker resolves, before make() runs (FileSystemAccessManagerImpl CreateAndTruncateFile). When the save then
//   ends without writing (make() cancelled with AbortError, make() failed or returned no Blob, or the write failed),
//   saveFile resolves {status: 'cancelled', emptied: true} or rejects with an error carrying emptied = true (a
//   primitive or non-extensible error is wrapped in an Error whose cause it is), so the caller can say 'The file
//   you chose was left empty.' instead of 'nothing was written'. The handle path (Ctrl+S to a kept handle) writes
//   through createWritable's swap file, so a failure there keeps the file and carries no flag (03 §12's "keeping the original file" holds only for the handle path).
// - openFile: files holds one file without multiple; file and handle are the first (handle null for the input
//   fallback); a file over maxBytes rejects the whole pick, the error also carrying fileName.
// - copyBlob resolves false when the write rejects, ClipboardItem throws or the blob promise rejects (the rejected
//   promise is never left unhandled).

import {
  dateParts, dtOfAttr, floatText15, fromWall, isoText, plainNumber, toHex, toSqlString, variantType, variantValue,
  wallMs,
} from '../engine/types.js';
import { RESERVED, SqlError } from '../engine/lexer.js';
import { msg } from '../engine/messages.js';

const NO_OPTS = Object.freeze({});

// ------------------------------------------------------------------------------------------------------- timing

// Debounced fn: runs once, ms after the last call; f.cancel() drops it, f.flush() runs it now, f.pending().
export function debounce(fn, ms) {
  let timer = null, args = null, self = null;
  const run = () => {
    timer = null;
    const a = args, s = self;
    args = self = null;
    return fn.apply(s, a);
  };
  function f(...a) {
    args = a;
    self = this;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, ms);
  }
  f.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    args = self = null;
  };
  f.flush = () => {
    if (timer === null) return undefined;
    clearTimeout(timer);
    return run();
  };
  f.pending = () => timer !== null;
  return f;
}

// Throttled fn: the first call runs at once, later calls in the window collapse into one trailing call.
export function throttle(fn, ms) {
  let timer = null, args = null, self = null, queued = false;
  const tick = () => {
    if (!queued) { timer = null; return; }
    const a = args, s = self;
    queued = false;
    args = self = null;
    timer = setTimeout(tick, ms);
    fn.apply(s, a);
  };
  function t(...a) {
    if (timer === null) {
      timer = setTimeout(tick, ms);
      fn.apply(this, a);
      return;
    }
    queued = true;
    args = a;
    self = this;
  }
  t.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    queued = false;
    args = self = null;
  };
  t.flush = () => {
    if (!queued) return;
    clearTimeout(timer);
    tick();
  };
  return t;
}

// ------------------------------------------------------------------------------------------ number formatting

const SEP_RE = /[,.]/g;
// Unambiguous (one way to match any digit run), so a long string that fails costs O(n), never O(n²) (03 §13).
const NUM_STR_RE = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i;
const NF_BAD_RE = /[\d+\-eE]/;
const INT_OPTS = Object.freeze({ dp: 0 });
const nfCache = new WeakMap();

// '-1234567.5' -> '-1,234,567.5' (exponent forms are left alone). An index loop, so the digits of a BigInt of any
// length are grouped in O(n) (a lookahead regex would rescan the rest of the digits at every position).
function groupText(s) {
  if (s.includes('e')) return s;
  const start = s[0] === '-' ? 1 : 0;
  const dot = s.indexOf('.');
  const end = dot < 0 ? s.length : dot;
  if (end - start <= 3) return s;
  const first = start + ((end - start) % 3 || 3);
  let out = s.slice(0, first);
  for (let i = first; i < end; i += 3) out += ',' + s.slice(i, i + 3);
  return end === s.length ? out : out + s.slice(end);
}

const TWO_53 = 9007199254740992;

// fmtNumber's digits without dp: 15 significant digits like types.floatText15 (the Raw float text), but never fewer
// than the integer digits below 2^53, so a safe integer keeps all its digits (only |x| in 1e15 .. 2^53 has 16 of
// them). The largest doubles, whose rounding overflows to Infinity, keep the rounded text ('1.79769313486232e+308').
function numDigits(x) {
  const a = Math.abs(x);
  const s = x.toPrecision(a >= 1e15 && a < TWO_53 ? 16 : 15);
  const r = Number(s);
  if (r === 0) return '0';
  return Number.isFinite(r) || !Number.isFinite(x) ? String(r) : s;
}

// True for a number of 2^53 <= |x| < 1e21: an integer (every double there is one) that may already be rounded and
// that String() would write as zero-padded plain digits.
function isRoundedInt(x) {
  const a = Math.abs(x);
  return a >= TWO_53 && a < 1e21;
}

// fmtNumber's text of such a number: '≈' and the double's exact digits (dp zeros after the point), as formatCell
// shows unsafe integers.
function roundedIntText(x, dp, grouping, nf) {
  const s = BigInt(x).toString();
  return '≈' + localize((grouping ? groupText(s) : s) + (dp ? '.' + '0'.repeat(dp) : ''), nf);
}

// decimal(·, dp) Types, so exact-dp text comes from types.toSqlString (roundDec, half away from zero).
const DEC_DP = [];
const decType = dp => (DEC_DP[dp] ??= Object.freeze({ dt: 'decimal', scale: dp }));
const clampDp = dp => Math.min(100, Math.max(0, Math.trunc(dp) || 0));

// The validated separators {g, d} of a numberFormat option ({group, decimal}), or null for en-US. The result is
// cached with the group and decimal values it was made from, and redone when the object was changed since.
function numFormat(nf) {
  if (nf == null || typeof nf !== 'object') return null;
  const group = nf.group, decimal = nf.decimal;
  let c = nfCache.get(nf);
  if (c === undefined || c.group !== group || c.decimal !== decimal) {
    const g = typeof group === 'string' ? group : ',';
    const d = typeof decimal === 'string' && decimal !== '' ? decimal : '.';
    const ok = g.length <= 3 && d.length <= 3 && !NF_BAD_RE.test(g) && !NF_BAD_RE.test(d) && g !== d;
    c = { group, decimal, r: ok && !(g === ',' && d === '.') ? Object.freeze({ g, d }) : null };
    nfCache.set(nf, c);
  }
  return c.r;
}

// en-US number text with the separators of nf (',' -> group, '.' -> decimal, in one pass).
function localize(s, nf) {
  return nf ? s.replace(SEP_RE, c => (c === ',' ? nf.g : nf.d)) : s;
}

let compactNf = null;
const compactFmt = () => (compactNf ??= new Intl.NumberFormat('en-US', { notation: 'compact' }));

// Text of a JS number: dp fixed decimals (null: numDigits), grouping, compact, separators. approx (fmtNumber): '≈' and
// the exact digits for an integer that may be rounded (isRoundedInt); formatCell's non-integer kinds pass false and
// show the plain digits (02 §5 defines '≈' for integer cells only).
function numText(x, dp, grouping, compact, nf, approx) {
  if (Number.isNaN(x)) return 'NaN';
  if (!Number.isFinite(x)) return x > 0 ? '∞' : '-∞';
  if (compact && Math.abs(x) >= 10000) return localize(compactFmt().format(x), nf);
  if (approx && isRoundedInt(x)) return roundedIntText(x, dp, grouping, nf);
  const s = dp == null ? numDigits(x) : toSqlString(x, decType(dp));
  return localize(grouping ? groupText(s) : s, nf);
}

// Number text with en-US grouping: {dp} fixed decimals (else up to 15 significant digits), {compact} 12K / 1.2M.
export function fmtNumber(n, opts) {
  const o = opts || NO_OPTS;
  const nf = numFormat(o.numberFormat);
  const dp = o.dp == null ? null : clampDp(o.dp);
  const grouping = o.grouping !== false;
  if (typeof n === 'bigint') {
    if (o.compact && (n >= 10000n || n <= -10000n)) return localize(compactFmt().format(n), nf);
    const s = n.toString();
    return localize((grouping ? groupText(s) : s) + (dp ? '.' + '0'.repeat(dp) : ''), nf);
  }
  if (n == null) return '—';
  if (typeof n === 'number') return numText(n, dp, grouping, o.compact, nf, true);
  return typeof n === 'string' && NUM_STR_RE.test(n) ? numText(Number(n), dp, grouping, o.compact, nf, true) : 'NaN';
}

// Whole number with grouping ('1,234'), rounded half away from zero.
export function fmtInt(n) {
  return fmtNumber(n, INT_OPTS);
}

// Duration text: '45 ms', '0.82 s', '1.2 s', '12 s', '1 min 5 s', '1 h 2 min'; {unit: 'ms'} always '182 ms'.
export function fmtDuration(ms, opts) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const v = Math.max(0, ms);
  if ((opts || NO_OPTS).unit === 'ms') return fmtInt(v) + ' ms';
  const r = Math.round(v);
  if (r < 100) return r + ' ms';
  if (r < 1000) return String(Math.round(r / 10) / 100) + ' s';
  if (r < 10000) return String(Math.round(r / 100) / 10) + ' s';
  const sec = Math.round(r / 1000);
  if (sec < 60) return sec + ' s';
  if (sec < 3600) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? `${m} min ${s} s` : `${m} min`;
  }
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return m ? `${fmtInt(h)} h ${m} min` : `${fmtInt(h)} h`;
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'];

// Byte size text: '512 bytes', '1.2 KB', '37 KB', '1.2 MB', '5 MB' (base 1024).
export function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const b = Math.max(0, Math.round(n));
  if (b < 1024) return b === 1 ? '1 byte' : b + ' bytes';
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; }
  if (v >= 10 && Math.round(v) >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; }
  const t = v < 10 ? String(Math.round(v * 10) / 10) : fmtInt(v);
  return `${t} ${BYTE_UNITS[i]}`;
}

// -------------------------------------------------------------------------------------------- date formatting

const p2 = n => (n < 10 ? '0' : '') + n;
const p3 = n => (n < 10 ? '00' : n < 100 ? '0' : '') + n;
const p4 = y => (y < 0 ? '-' + String(-y).padStart(4, '0') : String(y).padStart(4, '0'));
const ymd = p => `${p4(p.y)}-${p2(p.m)}-${p2(p.d)}`;
const hms = p => `${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}`;

// 'yyyy-MM-dd HH:mm:ss' (with {ms} '.fff'; {dateOnly} 'yyyy-MM-dd') of a Date or epoch ms in tz (default UTC);
// {date: true}: a `date` value's own calendar date (its UTC fields, tz ignored).
export function fmtDate(d, tz, opts) {
  const o = opts || NO_OPTS;
  const date = d instanceof Date ? d : typeof d === 'number' ? new Date(d) : null;
  if (!date || Number.isNaN(date.getTime())) return 'Invalid date';
  if (o.date) return ymd(utcParts(date));
  const p = dateParts(date, tz);
  if (o.dateOnly) return ymd(p);
  return `${ymd(p)} ${hms(p)}` + (o.ms ? '.' + p3(p.ms) : '');
}

// UTC calendar fields of a Date (a `date` value, 01 §5), ignoring any own tzo.
function utcParts(d) {
  return dateParts(d.tzo == null ? d : new Date(d.getTime()));
}

// ------------------------------------------------------------------------------- user date formats

// LCID -> locale for month names and AM/PM designators (the list of types.js's collation locales).
const LCID_LOCALES = '1025=ar-SA,1026=bg-BG,1027=ca-ES,1028=zh-TW,1029=cs-CZ,1030=da-DK,1031=de-DE,1032=el-GR,1033=en-US,' +
  '1035=fi-FI,1036=fr-FR,1037=he-IL,1038=hu-HU,1040=it-IT,1041=ja-JP,1042=ko-KR,1043=nl-NL,1044=nb-NO,1045=pl-PL,' +
  '1046=pt-BR,1048=ro-RO,1049=ru-RU,1050=hr-HR,1051=sk-SK,1053=sv-SE,1054=th-TH,1055=tr-TR,1057=id-ID,1058=uk-UA,' +
  '1060=sl-SI,1061=et-EE,1062=lv-LV,1063=lt-LT,1066=vi-VN,1069=eu-ES,1081=hi-IN,1086=ms-MY,1087=kk-KZ,1110=gl-ES,' +
  '2052=zh-CN,2057=en-GB,2070=pt-PT,2074=sr-Latn-RS,3076=zh-HK,3081=en-AU,3082=es-ES,3084=fr-CA,3098=sr-Cyrl-RS,' +
  '4105=en-CA,5129=en-NZ,2068=nn-NO,2058=es-MX,2055=de-CH,3079=de-AT,2060=fr-BE,4108=fr-CH,2067=nl-BE';
let lcidMap = null;

// The Intl locale of a Windows LCID ('en-US' when unknown or not supported by this browser).
function lcidLocale(lcid) {
  if (!lcidMap) {
    lcidMap = new Map();
    for (const pair of LCID_LOCALES.split(',')) {
      const i = pair.indexOf('=');
      lcidMap.set(Number(pair.slice(0, i)), pair.slice(i + 1));
    }
  }
  const loc = lcidMap.get(lcid);
  return loc && Intl.DateTimeFormat.supportedLocalesOf([loc]).length ? loc : 'en-US';
}

// .NET custom date and time tokens that 03 §7 lists, as field codes (fmtPattern); any other run is literal text.
const DT_TOKENS = new Map([['d', 1], ['dd', 2], ['M', 3], ['MM', 4], ['MMM', 5], ['MMMM', 6], ['yy', 7], ['yyyy', 8],
  ['h', 9], ['hh', 10], ['H', 11], ['HH', 12], ['m', 13], ['mm', 14], ['s', 15], ['ss', 16], ['t', 17], ['tt', 18]]);
const TOKEN_CHARS = 'dMyhHmst';
const PATTERN_MAX = 256;
const patterns = new Map();

// A compiled pattern: {parts: (string | field code)[], gen /* has a d or dd token: genitive month names */}.
function compilePattern(src) {
  let c = patterns.get(src);
  if (c) return c;
  const parts = [];
  let lit = '', gen = false;
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const end = src.indexOf(ch, i + 1);
      lit += end < 0 ? src.slice(i + 1) : src.slice(i + 1, end);
      i = end < 0 ? src.length : end + 1;
    } else if (ch === '\\') {
      lit += i + 1 < src.length ? src[i + 1] : ch;
      i += 2;
    } else if (TOKEN_CHARS.includes(ch)) {
      let j = i + 1;
      while (j < src.length && src[j] === ch) j++;
      const run = src.slice(i, j);
      const code = DT_TOKENS.get(run);
      if (code === undefined) lit += run;
      else {
        if (lit) parts.push(lit);
        lit = '';
        parts.push(code);
        if (code <= 2) gen = true;
      }
      i = j;
    } else {
      lit += ch;
      i++;
    }
  }
  if (lit) parts.push(lit);
  if (patterns.size >= 64) patterns.clear();
  c = Object.freeze({ parts: Object.freeze(parts), gen });
  patterns.set(src, c);
  return c;
}

const localeNames = new Map();

const DIGITS_RE = /^\p{Nd}+$/u;

// Month names (standalone and genitive, short and long) and AM/PM designators of a locale, from Intl (03 §7). Every
// format names timeZone 'UTC' and reads fixed instants, so no browser time zone is involved, and the Gregorian
// calendar, so the names belong to the Gregorian fields they are shown with (th-TH defaults to buddhist).
function namesOf(loc) {
  let n = localeNames.get(loc);
  if (n) return n;
  const fmt = o => new Intl.DateTimeFormat(loc, { ...o, calendar: 'gregory', timeZone: 'UTC' });
  // The genitive name: the month part of a day + month text, unless that part is only digits ('3' of ja-JP's
  // '3月15日'), where the standalone name ('3月') is the name .NET shows.
  const genOf = (f, d, standalone) => {
    const p = f.formatToParts(d).find(x => x.type === 'month');
    return p && p.value !== '' && !DIGITS_RE.test(p.value) ? p.value : standalone;
  };
  const sShort = fmt({ month: 'short' }), sLong = fmt({ month: 'long' });
  const gShort = fmt({ day: 'numeric', month: 'short' }), gLong = fmt({ day: 'numeric', month: 'long' });
  const names = { short: [], long: [], genShort: [], genLong: [] };
  for (let m = 0; m < 12; m++) {
    const d = Date.UTC(2001, m, 15);
    // The standalone names are the whole month-only text: its month part can lack the suffix that belongs to the
    // name ('3' + literal '月' in ja-JP).
    const short = sShort.format(d), long = sLong.format(d);
    names.short.push(short);
    names.long.push(long);
    names.genShort.push(genOf(gShort, d, short));
    names.genLong.push(genOf(gLong, d, long));
  }
  const hours = fmt({ hour: 'numeric', hour12: true });
  const period = (h, fb) => {
    const p = hours.formatToParts(Date.UTC(2001, 0, 1, h)).find(x => x.type === 'dayPeriod');
    return p && p.value ? p.value : fb;
  };
  n = Object.freeze({ ...names, am: period(9, 'AM'), pm: period(21, 'PM') });
  localeNames.set(loc, n);
  return n;
}

// Text of wall-clock fields p ({y, m, d, h, mi, s}) in a compiled pattern with a locale's names.
function fmtPattern(p, pat, names) {
  let s = '';
  for (const x of pat.parts) {
    if (typeof x === 'string') { s += x; continue; }
    const h12 = p.h % 12 || 12;
    switch (x) {
      case 1: s += p.d; break;
      case 2: s += p2(p.d); break;
      case 3: s += p.m; break;
      case 4: s += p2(p.m); break;
      case 5: s += (pat.gen ? names.genShort : names.short)[p.m - 1]; break;
      case 6: s += (pat.gen ? names.genLong : names.long)[p.m - 1]; break;
      case 7: s += p2(((p.y % 100) + 100) % 100); break;
      case 8: s += p4(p.y); break;
      case 9: s += h12; break;
      case 10: s += p2(h12); break;
      case 11: s += p.h; break;
      case 12: s += p2(p.h); break;
      case 13: s += p.mi; break;
      case 14: s += p2(p.mi); break;
      case 15: s += p.s; break;
      case 16: s += p2(p.s); break;
      default: {
        const t = p.h < 12 ? names.am : names.pm;
        s += x === 17 ? String.fromCodePoint(t.codePointAt(0)) : t;
      }
    }
  }
  return s;
}

const validPattern = s => (typeof s === 'string' && s !== '' && s.length <= PATTERN_MAX ? s : null);
const dfCache = new WeakMap();

// The user date and time formats of a dateFormat option ({date, time, lcid}), or null for the default text. The
// result is cached with the values it was made from, and redone when the object was changed since.
function userFormat(df) {
  if (df == null || typeof df !== 'object') return null;
  const { date, time, lcid } = df;
  let c = dfCache.get(df);
  if (c === undefined || c.date !== date || c.time !== time || c.lcid !== lcid) {
    const dp = validPattern(date), tp = validPattern(time);
    const r = dp || tp ? Object.freeze({
      date: compilePattern(dp ?? 'yyyy-MM-dd'), time: compilePattern(tp ?? 'HH:mm:ss'),
      names: namesOf(lcidLocale(Number.isInteger(lcid) ? lcid : 1033)),
    }) : null;
    c = { date, time, lcid, r };
    dfCache.set(df, c);
  }
  return c.r;
}

// ------------------------------------------------------------------------------------------------- formatCell

const CHOICE_ATTRS = new Set(['Picklist', 'State', 'Status']);
const LOOKUP_ATTRS = new Set(['Lookup', 'Customer', 'Owner']);
const CODE_FORMATS = new Set(['Language', 'Locale', 'TimeZone']);
const DT_NAMES = new Set(['int', 'bigint', 'decimal', 'float', 'money', 'bit', 'string', 'binary', 'xml', 'datetime',
  'date', 'time', 'guid', 'null', 'any']);
const DT_TYPE = new Map([...DT_NAMES].map(n => [n, Object.freeze({ dt: n })]));
const ANY_T = DT_TYPE.get('any');
// A Date whose column type is not datetime is read as datetime2(7), so ticks it carries are shown.
const DT2_7 = Object.freeze({ dt: 'datetime', prec: 7 });
const NO_OFFSET = Object.freeze({ offset: false });
const MONEY_T = Object.freeze({ dt: 'money', prec: 19, scale: 4 });
const MONEY_RAW = Object.freeze({ style: 2 });
const MAX_SAFE_BIG = 9007199254740991n;
const NL_TEST = /[\n\r\p{Zl}\p{Zp}]/u;
const NL_RE = /\r\n|[\n\r\p{Zl}\p{Zp}]/gu;
const BIG_EXACT = 'This number is beyond ±2^53 (9,007,199,254,740,991). The digits shown are exact, but calculations '
  + 'with it lose precision.';
const BIG_APPROX = 'This number is beyond ±2^53 (9,007,199,254,740,991), so SQL Studio holds it rounded: the last '
  + 'digits shown may differ from the stored value, calculations with it lose precision and it cannot be written back.';
const FV_RE = /^[\d\s.,'’−()-]+$/u;
const FV_NEG_RE = /[-−(]/;
const NON_DIGIT_RE = /\D/g;
const LEAD_ZEROS_RE = /^0+(?=\d)/;
// A whole number written as text: optional sign ('-', U+2212) or parentheses, digits plain or in groups of three
// with one separator (, . ' ’ space NBSP NNBSP) used throughout (see the notes above, unsafe integers).
const INT_TEXT_RE = /^(?:([-−]?)(\d{1,3}(?:([,.'’   ])\d{3}(?:\3\d{3})*)?|\d+)|\((\d{1,3}(?:([,.'’   ])\d{3}(?:\5\d{3})*)?|\d+)\))$/u;
const DEC_NOSCALE = Object.freeze({ dt: 'decimal', scale: null });
const colCache = new WeakMap();
const isObj = x => x !== null && typeof x === 'object';
const isBytes = v => v instanceof Uint8Array;

// Static type of a column: Column fields, a Type in col.type, the attribute's type or a dt name in col.type; else null.
function colType(col) {
  if (typeof col.dt === 'string') return col;
  const t = col.type;
  if (t && typeof t === 'object' && typeof t.dt === 'string') return t;
  if (col.attr && typeof col.attr === 'object') return dtOfAttr(col.attr);
  if (typeof t === 'string') return DT_TYPE.get(t) || null;
  return null;
}

// How formatCell shows a column's values (kind, companion indexes, scale, …); colInfo caches it.
function analyse(col) {
  const t = colType(col) || ANY_T;
  const attr = isObj(col.attr) ? col.attr : null;
  const at = attr ? attr.type : null;
  const comp = isObj(col.companion) ? col.companion : null;
  const nameIdx = comp && Number.isInteger(comp.name) && comp.name >= 0 ? comp.name : -1;
  const typeIdx = comp && Number.isInteger(comp.type) && comp.type >= 0 ? comp.type : -1;
  const labelled = col.role !== 'name' && col.role !== 'type';
  // Integer attributes that hold language, locale or time-zone codes are codes, like choices (never grouped).
  const code = CHOICE_ATTRS.has(at) || (at === 'Integer' && CODE_FORMATS.has(attr.format));
  // Ref lineage (01 §6.2): the Column's own, else its Type's, else the one dtOfAttr gives a primary key attribute.
  const aref = attr ? dtOfAttr(attr).ref : null;
  const ref = isObj(col.ref) ? col.ref : t !== col && isObj(t.ref) ? t.ref : isObj(aref) ? aref : null;
  const refEntity = ref && typeof ref.entity === 'string' && ref.entity !== '' ? ref.entity : null;
  const refPoly = !refEntity && !!ref && ref.poly === true && typeIdx >= 0;
  let kind;
  switch (t.dt) {
    case 'int': kind = labelled && (code || nameIdx >= 0) ? 'choice' : 'int'; break;
    case 'bigint': kind = 'int'; break;
    case 'bit': kind = 'bool'; break;
    case 'guid':
      if (labelled && (LOOKUP_ATTRS.has(at) || nameIdx >= 0)) kind = 'lookup';
      else kind = labelled && (refEntity || refPoly) ? 'ref' : 'guid';
      break;
    case 'string': kind = labelled && at === 'MultiSelectPicklist' ? 'multi' : 'string'; break;
    case 'xml': kind = 'string'; break;
    case 'datetime': kind = t.dto ? 'dto' : 'datetime'; break;
    case 'decimal': case 'money': case 'float': case 'date': case 'time': case 'binary': kind = t.dt; break;
    default: kind = 'any';
  }
  const prec = attr ? attr.precision : null;
  const target = attr && Array.isArray(attr.targets) && attr.targets.length === 1 ? attr.targets[0] : null;
  // SQL Server scales are 0..38; anything else is no scale (never a padding of millions of zeros).
  const scale = Number.isInteger(t.scale) && t.scale >= 0 && t.scale <= 38 ? t.scale : null;
  return {
    kind, type: t, nameIdx, typeIdx, scale,
    rawDec: scale == null ? DEC_NOSCALE : decType(scale),
    moneyDp: Number.isInteger(prec) && prec >= 0 && prec <= 10 ? prec : 2,
    dateOnly: at === 'DateTime' && attr.format === 'DateOnly',
    zoneless: at === 'DateTime' && attr.behavior === 'TimeZoneIndependent',
    entity: kind === 'ref' ? refEntity : isObj(col.ref) && typeof col.ref.entity === 'string' ? col.ref.entity : target,
  };
}

const ANY_INFO = Object.freeze(analyse(ANY_T));
const STAMP_LEN = 27;
const scratch = new Array(STAMP_LEN);

// Writes into s every column input analyse() reads (directly or through dtOfAttr): the column's own fields, its
// type, attr, companion and ref objects by identity, and the fields of those objects it uses.
function stampInto(col, s) {
  const t = col.type, a = col.attr, c = col.companion, r = col.ref;
  const to = isObj(t), ao = isObj(a), co = isObj(c), ro = isObj(r);
  const tg = ao ? a.targets : undefined, ta = Array.isArray(tg);
  const tr = to ? t.ref : undefined, tro = isObj(tr);
  s[0] = col.dt; s[1] = col.scale; s[2] = col.dto; s[3] = col.role;
  s[4] = t; s[5] = to ? t.dt : undefined; s[6] = to ? t.scale : undefined; s[7] = to ? t.dto : undefined;
  s[8] = a; s[9] = ao ? a.type : undefined; s[10] = ao ? a.format : undefined; s[11] = ao ? a.behavior : undefined;
  s[12] = ao ? a.precision : undefined; s[13] = tg; s[14] = ta ? tg.length : undefined; s[15] = ta ? tg[0] : undefined;
  s[16] = c; s[17] = co ? c.name : undefined; s[18] = co ? c.type : undefined;
  s[19] = r; s[20] = ro ? r.entity : undefined; s[21] = ro ? r.poly : undefined;
  s[22] = ao ? a.isPk : undefined; s[23] = ao ? a.entity : undefined;
  s[24] = tr; s[25] = tro ? tr.entity : undefined; s[26] = tro ? tr.poly : undefined;
  return s;
}

// The analysis of a column, cached per Column object and redone when any input it was made from has changed.
function colInfo(col) {
  if (!isObj(col)) return ANY_INFO;
  const now = stampInto(col, scratch);
  let c = colCache.get(col);
  if (c !== undefined) {
    let i = 0;
    while (i < STAMP_LEN && Object.is(c.stamp[i], now[i])) i++;
    if (i === STAMP_LEN) return c.inf;
  }
  c = { stamp: now.slice(), inf: analyse(col) };
  colCache.set(col, c);
  return c.inf;
}

// The grapheme limit of a cell (opts.max, default 500; below 1 counts as 1).
function cellMax(o) {
  const m = o.max ?? 500;
  return m >= 1 ? Math.floor(m) : 1;
}

// A text cell: '' is 'empty'; otherwise newlines become ⏎ and long text is cut (title = the full text). Only the
// prefix that can survive the cut is scanned (a window grown like truncateText's), so huge texts cost O(max): once
// the replaced window is longer than truncateText reads, truncateText always cuts it.
function textCell(s, o, cls = '') {
  if (s === '') return { text: '', cls: 'empty' };
  if (o.full) return { text: s, cls };
  const max = cellMax(o);
  let t;
  for (let w = max * 4 + 16; ; w *= 2) {
    // ⏎-replacing a prefix gives a prefix of the replaced whole text (a CR LF cut in two still becomes one ⏎), and
    // grapheme boundaries inside a prefix are boundaries of the whole (see prefixWindow).
    const head = prefixWindow(s, w);
    const r = NL_TEST.test(head) ? head.replace(NL_RE, '⏎') : head;
    t = r.length > max ? truncateText(r, max) : r;
    if (head === s || t !== r) break;
  }
  const res = { text: t, cls };
  if (t !== s) res.title = s;
  return res;
}

// A number cell r, cut like long text when its text exceeds the cell limit outside full mode (only the digits of a
// BigInt can), with the full text first in the title (then a line break and any title r had; 03 §13).
function fit(r, o) {
  if (o.full) return r;
  const max = cellMax(o);
  if (r.text.length <= max) return r;
  r.title = r.title ? `${r.text}\n${r.title}` : r.text;
  r.text = truncateText(r.text, max);
  return r;
}

// A binary cell: '0x' + upper-case hex, monospace, cut like long text. Only the bytes that can survive the cut
// are converted, and the title (the full hex text) is built when it is first read (see the notes above).
function binCell(b, o) {
  const max = cellMax(o);
  if (o.full || 2 + 2 * b.length <= max) return { text: toHex(b), cls: 'guid' };
  // ceil(max / 2) bytes give 2 + 2·ceil(max / 2) > max characters, so truncateText cuts them as it cuts the whole.
  const res = { text: truncateText(toHex(b.subarray(0, Math.ceil(max / 2))), max), cls: 'guid' };
  let full = null;
  Object.defineProperty(res, 'title', { enumerable: true, configurable: true, get: () => (full ??= toHex(b)) });
  return res;
}

// Companion label (row[companion.name]) or the opts.label hook; null when neither gives a non-empty string.
function labelOf(v, inf, o, col) {
  const c = inf.nameIdx >= 0 && o.row ? o.row[inf.nameIdx] : null;
  if (typeof c === 'string' && c !== '') return c;
  if (typeof o.label === 'function') {
    const l = o.label(v, col);
    if (typeof l === 'string' && l !== '') return l;
  }
  return null;
}

const isUnsafe = v => (typeof v === 'bigint' ? v > MAX_SAFE_BIG || v < -MAX_SAFE_BIG : Number.isInteger(v) && !Number.isSafeInteger(v));

// Plain digits ('-123…') of a FormattedValue that names the integer v (a number or a BigInt) exactly, else null.
function fvDigits(fv, v) {
  if (!FV_RE.test(fv)) return null;
  const digits = fv.replace(NON_DIGIT_RE, '').replace(LEAD_ZEROS_RE, '');
  if (digits === '' || digits.length > 40) return null;
  const s = (digits !== '0' && FV_NEG_RE.test(fv) ? '-' : '') + digits;
  const b = BigInt(s);
  return (typeof v === 'bigint' ? b === v : Number(b) === v) ? s : null;
}

// An integer beyond ±(2^53 - 1) (02 §5): exact digits when known (FormattedValue or JS BigInt), else '≈' digits.
function bigCell(v, inf, o, friendly, nf) {
  const fv = inf.nameIdx >= 0 && o.row ? o.row[inf.nameIdx] : null;
  const exact = typeof fv === 'string' && fv !== '' ? fvDigits(fv, v) : null;
  if (exact != null) return fit({ text: friendly ? fv : exact, cls: 'num', icon: 'warn', title: BIG_EXACT }, o);
  const s = (typeof v === 'bigint' ? v : BigInt(v)).toString();
  const text = friendly ? localize(groupText(s), nf) : s;
  if (typeof v === 'bigint') return fit({ text, cls: 'num', icon: 'warn', title: BIG_EXACT }, o);
  return fit({ text: '≈' + text, cls: 'num', icon: 'warn', title: BIG_APPROX }, o);
}

// Plain digits ('-123…') of a whole number written as text (INT_TEXT_RE) beyond ±(2^53 - 1), else null.
function unsafeIntText(s) {
  if (s.length > 64) return null;
  const m = INT_TEXT_RE.exec(s);
  if (!m) return null;
  const neg = m[4] !== undefined || m[1] !== '';
  const digits = (m[4] !== undefined ? m[4] : m[2]).replace(NON_DIGIT_RE, '').replace(LEAD_ZEROS_RE, '');
  const b = BigInt(digits);
  return b > MAX_SAFE_BIG ? (neg ? '-' : '') + digits : null;
}

// A JS BigInt in a decimal or money column: its exact digits and dp zero decimals (never Number(v), which rounds).
function bigFixedCell(v, dp, o, friendly, nf) {
  const s = v.toString() + (dp > 0 ? '.' + '0'.repeat(dp) : '');
  const r = { text: friendly ? localize(groupText(s), nf) : s, cls: 'num' };
  if (isUnsafe(v)) {
    r.icon = 'warn';
    r.title = BIG_EXACT;
  }
  return fit(r, o);
}

// Option values of choices (numbers and BigInts), never grouped.
function codeText(v) {
  if (typeof v === 'bigint') return v.toString();
  return Number.isInteger(v) ? String(v === 0 ? 0 : v) : numDigits(v);
}

// Friendly 'yyyy-MM-dd HH:mm:ss' of wall-clock fields p, or the user's formats; dateOnly: the date part.
function friendlyDate(p, uf, dateOnly) {
  if (!uf) return dateOnly ? ymd(p) : `${ymd(p)} ${hms(p)}`;
  const d = fmtPattern(p, uf.date, uf.names);
  return dateOnly ? d : `${d} ${fmtPattern(p, uf.time, uf.names)}`;
}

// A datetime cell: Friendly in the display tz (or the user's formats), Raw types.isoText of the column's Type.
function dateTimeCell(d, inf, o, friendly, type) {
  if (Number.isNaN(d.getTime())) return { text: 'Invalid date', cls: '' };
  if (friendly) return { text: friendlyDate(dateParts(d, o.tz), userFormat(o.dateFormat), inf.dateOnly), cls: '' };
  return { text: isoText(d, type, o.tz, inf.zoneless ? NO_OFFSET : undefined), cls: '' };
}

// Cells of static type 'any' (raw values) or of values that do not match the column type. Numbers show fmtNumber's
// digits without the '≈' form (02 §5 defines it for integer cells only), Raw without grouping or separators.
function anyCell(v, o, friendly, nf) {
  switch (typeof v) {
    case 'number': return fit({ text: friendly ? numText(v, null, true, false, nf, false) : numDigits(v), cls: 'num' }, o);
    case 'bigint': return fit({ text: friendly ? localize(groupText(v.toString()), nf) : v.toString(), cls: 'num' }, o);
    case 'boolean': return { text: v ? '1' : '0', cls: '' };
    case 'string': return textCell(v, o);
    default: return v instanceof Date ? dateTimeCell(v, ANY_INFO, o, friendly, DT2_7) : textCell(String(v), o);
  }
}

// Plain text of a value in a text-like column whose type it does not match (never String(Date): local getters).
function plainText(v, o, friendly) {
  switch (typeof v) {
    case 'string': return v;
    case 'number': return numDigits(v);
    case 'bigint': return v.toString();
    case 'boolean': return v ? '1' : '0';
    default: return v instanceof Date ? dateTimeCell(v, ANY_INFO, o, friendly, DT2_7).text : String(v);
  }
}

const isNum = v => typeof v === 'number' || typeof v === 'bigint';

// The lower-cased table of a cell's record link, or null: the value is a GUID and the table is known (opts.known or
// setKnownTables) with a valid name, exactly what recordUrl checks, so no link icon stands for a URL it refuses.
const linkEtn = (ent, v, o) => (isGuid(v) ? knownEtn(ent, o.known) : null);

// Display text of one cell (03 §7 cell rules): {text, cls: 'null'|'empty'|'num'|'guid'|'', title?, icon?}.
export function formatCell(value, col, opts) {
  if (value === null || value === undefined) return { text: 'NULL', cls: 'null' };
  const o = opts || NO_OPTS;
  const base = variantValue(value);
  // sql_variant: the base value by its base type, without the outer column's companions and label hook.
  if (base !== value) {
    const t = variantType(value);
    return cellOf(base, t, colInfo(t), { ...o, row: null, label: null });
  }
  return cellOf(value, col, colInfo(col), o);
}

// formatCell for a value that is not a sql_variant, with the column's analysis.
function cellOf(v, col, inf, o) {
  if (isBytes(v)) return binCell(v, o);
  const friendly = o.friendly !== false;
  const nf = friendly ? numFormat(o.numberFormat) : null;
  switch (inf.kind) {
    case 'string': return textCell(typeof v === 'string' ? v : plainText(v, o, friendly), o);
    case 'int': {
      if (typeof v === 'string') {
        // The FormattedValue or digit string of a flagged BigInt as the cell value (see the notes above).
        const digits = unsafeIntText(v);
        if (digits != null) return fit({ text: friendly ? v : digits, cls: 'num', icon: 'warn', title: BIG_EXACT }, o);
      }
      if (!isNum(v)) return anyCell(v, o, friendly, nf);
      if (isUnsafe(v)) return bigCell(v, inf, o, friendly, nf);
      const x = Number(v);
      if (!Number.isInteger(x)) return anyCell(x, o, friendly, nf);
      // A safe integer prints as plain digits, so grouping its String() equals fmtNumber(x, {dp: 0}).
      return fit({ text: friendly ? localize(groupText(String(x === 0 ? 0 : x)), nf) : toSqlString(x, 'int'), cls: 'num' }, o);
    }
    case 'decimal': {
      if (typeof v === 'bigint') return bigFixedCell(v, inf.scale ?? 0, o, friendly, nf);
      if (typeof v !== 'number') return anyCell(v, o, friendly, nf);
      const text = friendly ? numText(v, inf.scale, true, false, nf, false) : toSqlString(v, inf.rawDec);
      return fit({ text, cls: 'num' }, o);
    }
    case 'money': {
      if (typeof v === 'bigint') return bigFixedCell(v, friendly ? inf.moneyDp : 4, o, friendly, nf);
      if (typeof v !== 'number') return anyCell(v, o, friendly, nf);
      const text = friendly ? numText(v, inf.moneyDp, true, false, nf, false) : toSqlString(v, MONEY_T, MONEY_RAW);
      return fit({ text, cls: 'num' }, o);
    }
    case 'float': {
      if (!isNum(v)) return anyCell(v, o, friendly, nf);
      const x = Number(v);
      // Friendly: fmtNumber's digits without '≈' (from 2^53 the 15-digit text that Raw shows, 01 §5).
      return fit({ text: friendly ? numText(x, null, true, false, nf, false) : floatText15(x), cls: 'num' }, o);
    }
    case 'choice': {
      if (friendly) {
        const l = labelOf(v, inf, o, col);
        if (l != null) return textCell(l, o);
      }
      if (!isNum(v)) return anyCell(v, o, friendly, nf);
      if (isUnsafe(v)) return bigCell(v, inf, o, friendly, nf);
      return fit({ text: codeText(v), cls: 'num' }, o);
    }
    case 'bool': {
      if (friendly) {
        const l = labelOf(v, inf, o, col);
        if (l != null) return textCell(l, o);
      }
      if (v === true || v === 1 || v === 1n) return { text: '1', cls: '' };
      if (v === false || v === 0 || v === 0n) return { text: '0', cls: '' };
      return isNum(v) ? fit({ text: codeText(v), cls: '' }, o) : anyCell(v, o, friendly, nf);
    }
    case 'multi': {
      if (friendly) {
        const l = labelOf(v, inf, o, col);
        if (l != null) return textCell(l, o);
      }
      return textCell(plainText(v, o, friendly), o);
    }
    case 'lookup': {
      if (typeof v !== 'string') return anyCell(v, o, friendly, nf);
      if (!friendly) return { text: v, cls: 'guid' };
      const row = o.row;
      const name = labelOf(v, inf, o, col);
      const tn = inf.typeIdx >= 0 && row ? row[inf.typeIdx] : null;
      // The link icon and '<table> · <id>' only for a cell with a record link (03 §1.1): recordUrl's test.
      const etn = linkEtn(typeof tn === 'string' && tn !== '' ? tn : inf.entity, v, o);
      if (name == null) return etn ? { text: v, cls: 'guid', icon: 'link', title: `${etn} · ${v}` } : { text: v, cls: 'guid' };
      const r = textCell(name, o);
      const ref = etn ? `${etn} · ${v}` : v;
      if (etn) r.icon = 'link';
      if (ref !== '') r.title = r.title ? `${r.title}\n${ref}` : ref;
      return r;
    }
    case 'ref': {
      // A GUID with ref lineage and no name companion (03 §7): the link icon in both modes, when it has a record link.
      if (typeof v !== 'string') return anyCell(v, o, friendly, nf);
      const tn = inf.entity == null && inf.typeIdx >= 0 && o.row ? o.row[inf.typeIdx] : null;
      const etn = linkEtn(inf.entity ?? tn, v, o);
      return etn ? { text: v, cls: 'guid', icon: 'link', title: `${etn} · ${v}` } : { text: v, cls: 'guid' };
    }
    case 'guid': return typeof v === 'string' ? { text: v, cls: 'guid' } : anyCell(v, o, friendly, nf);
    case 'datetime': return v instanceof Date ? dateTimeCell(v, inf, o, friendly, inf.type) : anyCell(v, o, friendly, nf);
    case 'dto': {
      if (!(v instanceof Date)) return anyCell(v, o, friendly, nf);
      if (Number.isNaN(v.getTime())) return { text: 'Invalid date', cls: '' };
      // Its own wall-clock time and offset; without tzo +00:00 (03 §7), so the display tz is never read. Both modes
      // take the offset from the types.isoText text, so they always show the same one.
      const iso = isoText(v, inf.type, null);
      if (!friendly) return { text: iso, cls: '' };
      const off = iso.slice(Math.max(iso.lastIndexOf('+'), iso.lastIndexOf('-')));
      return { text: `${friendlyDate(dateParts(v, null), userFormat(o.dateFormat), false)} ${off}`, cls: '' };
    }
    case 'date': {
      if (!(v instanceof Date)) return anyCell(v, o, friendly, nf);
      if (Number.isNaN(v.getTime())) return { text: 'Invalid date', cls: '' };
      // Raw text from types.js (01 §5); the Friendly text is the default or the user's date pattern on the UTC fields.
      if (!friendly) return { text: isoText(v, inf.type), cls: '' };
      const uf = userFormat(o.dateFormat);
      const p = utcParts(v);
      return { text: uf ? fmtPattern(p, uf.date, uf.names) : ymd(p), cls: '' };
    }
    case 'time': return typeof v === 'string' ? textCell(v, o) : anyCell(v, o, friendly, nf);
    default: return anyCell(v, o, friendly, nf);
  }
}

// --------------------------------------------------------------------------------------------- ids and text

// Random id: prefix + 16 hex digits (unique across browser tabs; a valid DOM id with a letter prefix).
export function uid(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const x of b) s += (x < 16 ? '0' : '') + x.toString(16);
  return (prefix ?? 'u') + s;
}

// v limited to [lo, hi] like CSS clamp() (lo wins when lo > hi); NaN and non-numeric values give lo.
export function clamp(v, lo, hi) {
  const x = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : typeof v === 'string' && NUM_STR_RE.test(v) ? Number(v) : NaN;
  if (Number.isNaN(x)) return lo;
  return Math.max(lo, Math.min(x, hi));
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// True for a GUID string 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' (any case, no braces).
export function isGuid(s) {
  return typeof s === 'string' && GUID_RE.test(s);
}

let segmenter = null;
const graphemes = s => (segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' })).segment(s);
const isHigh = c => c >= 0xd800 && c <= 0xdbff;

// Grapheme boundaries depend only on the code points up to and including the one after the boundary (UAX #29),
// so a boundary found inside a prefix that does not split a surrogate pair is a boundary of the whole string.
// The segmenter copies the whole input, so huge texts are segmented through a growing prefix window.
function prefixWindow(s, w) {
  if (w >= s.length) return s;
  return s.slice(0, isHigh(s.charCodeAt(w - 1)) ? w + 1 : w);
}

// The longest prefix of s of at most max UTF-16 units that ends at a grapheme boundary.
function cutUnits(s, max) {
  const part = prefixWindow(s, max + 2);
  let end = 0;
  for (const { index, segment } of graphemes(part)) {
    if (index + segment.length > max) break;
    end = index + segment.length;
  }
  return s.slice(0, end);
}

const DEVICE_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const ZWNJ = String.fromCharCode(0x200c), ZWJ = String.fromCharCode(0x200d);
// Control characters that JS \s does not count as white space (all but tab, LF, VT, FF and CR).
const CC_NOT_WS_RE = /(?![\t\n\v\f\r])\p{Cc}/gu;

// Characters a file name must not start or end with: dots, spaces, and the joiners (invisible there).
const isEdgeChar = c => c === 0x20 || c === 0x2e || c === 0x200c || c === 0x200d;

// t without leading (when lead) and trailing edge characters. Index loops, so a long run of them inside the name
// costs O(n) (an end-anchored regex would rescan the run from every position in it: O(n²)).
function trimEdges(t, lead) {
  let a = 0, b = t.length;
  if (lead) while (a < b && isEdgeChar(t.charCodeAt(a))) a++;
  while (b > a && isEdgeChar(t.charCodeAt(b - 1))) b--;
  return a === 0 && b === t.length ? t : t.slice(a, b);
}

// A file-name part that is safe on Windows and macOS (see the notes above); fallback when nothing is left.
export function safeFileName(s, fallback) {
  const fb = fallback ?? 'untitled';
  // Control characters go before white space is collapsed, so the runs on both sides of one become one space.
  let t = trimEdges(String(s ?? '').normalize('NFC')
    .replace(/\p{Cf}/gu, c => (c === ZWJ || c === ZWNJ ? c : ''))
    .replace(CC_NOT_WS_RE, '')
    .replace(/\s+/gu, ' ')
    .replace(/[<>:"/\\|?*]/g, '_'), true);
  // A name made only of dots, spaces, ZWJ and ZWNJ is empty after the edge trim: nothing visible is left.
  if (!t) return fb;
  // The device-name suffix comes before the length cut, so the result never exceeds 100 units.
  const dot = t.indexOf('.');
  const head = (dot < 0 ? t : t.slice(0, dot)).trimEnd();
  if (DEVICE_RE.test(head)) t = head + '_' + t.slice(head.length);
  if (t.length > 100) t = trimEdges(cutUnits(t, 100), false);
  return t || fb;
}

const CLUSTER_MAX = 64;

// The first CLUSTER_MAX units of the grapheme cluster at i, never ending inside a surrogate pair.
function clusterHead(s, i) {
  const end = i + CLUSTER_MAX;
  return s.slice(i, isHigh(s.charCodeAt(end - 1)) ? end - 1 : end);
}

// s cut to at most n graphemes at a grapheme boundary (Intl.Segmenter), ending in '…' when cut; a cluster over 64
// UTF-16 units, or a kept text over 16·n + 64 units, also ends it (see the notes above), so the cost stays O(n).
export function truncateText(s, n) {
  const str = s == null ? '' : String(s);
  const max = Math.floor(n);
  if (!(max >= 1)) return '';
  if (str.length <= max) return str;
  const budget = 16 * max + CLUSTER_MAX;
  // Within this window a cut is always found (the last segment starts at most `budget` units in, so it is longer
  // than CLUSTER_MAX), so no more of s is ever read.
  const limit = budget + CLUSTER_MAX + 2;
  for (let w = Math.min(str.length, max * 4 + 16); ; w = Math.min(str.length, w * 2, limit)) {
    const part = prefixWindow(str, w);
    let count = 0, cut = 0, last = 0;
    for (const { index, segment } of graphemes(part)) {
      if (count === max) return str.slice(0, cut).trimEnd() + '…';
      if (count === max - 1) cut = index;
      last = index;
      if (segment.length > CLUSTER_MAX) {
        if (count <= max - 2 && index <= budget - CLUSTER_MAX) return str.slice(0, index) + clusterHead(str, index) + '…';
        return str.slice(0, index).trimEnd() + '…';
      }
      if (index + segment.length > budget) return str.slice(0, index).trimEnd() + '…';
      count++;
    }
    if (part.length >= str.length) return str;
    // Unreachable by the window argument above; a guard so that no input can ever make this loop spin.
    if (w >= limit) return str.slice(0, last).trimEnd() + '…';
  }
}

// ------------------------------------------------------------------------------------------------ SQL literals

// N'…' string literal with quotes doubled (the only way generated SQL quotes text, 00 §5 rule 10).
export function sqlStr(s) {
  if (s == null) throw new TypeError('sqlStr: a string is required');
  return `N'${String(s).replace(/'/g, "''")}'`;
}

// [name] identifier with ']' doubled (the only way generated SQL quotes names).
export function sqlIdent(n) {
  if (n == null) throw new TypeError('sqlIdent: a name is required');
  const s = String(n);
  if (s === '') throw new TypeError('sqlIdent: the name is empty');
  return '[' + s.replace(/]/g, ']]') + ']';
}

const BARE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A name bare when it is a plain identifier that is no reserved word (lexer.js RESERVED) and not GO, else sqlIdent(n).
export function sqlName(n) {
  if (n == null) throw new TypeError('sqlName: a name is required');
  const s = String(n);
  if (s === '') throw new TypeError('sqlName: the name is empty');
  if (!BARE_RE.test(s)) return sqlIdent(s);
  const u = s.toUpperCase();
  // A bare GO alone on a line would end the batch (01 §4.5), so GO is quoted although it is not reserved.
  return RESERVED.has(u) || u === 'GO' ? sqlIdent(s) : s;
}

const I32_MIN = -2147483648, I32_MAX = 2147483647;
const I32_MIN_BIG = -2147483648n, I32_MAX_BIG = 2147483647n;
const I64_MIN = -9223372036854775808n, I64_MAX = 9223372036854775807n;
const MONEY_MAX_INT = 922337203685477n;
// money's range in units of 0.0001: -922,337,203,685,477.5808 .. 922,337,203,685,477.5807 (a 64-bit integer).
const MONEY_MAX_UNITS = 9223372036854775807n, MONEY_MIN_UNITS_ABS = 9223372036854775808n;
const PLAIN_NUM_RE = /^-?(\d+)(?:\.(\d+))?$/;
const ALL_LEAD_ZEROS_RE = /^0+/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?$/;

// A SqlError of SQL Studio's own (no SQL Server number).
function litErr(message) {
  return new SqlError(message);
}

// A numbered SQL Server error with its MESSAGES text and severity (01 §2.1).
function numErr(number, ...args) {
  const m = msg(number, ...args);
  const e = new SqlError(m.message);
  e.number = m.number;
  e.severity = m.severity;
  return e;
}

const jsType = v => (v instanceof Date ? 'a date' : isBytes(v) ? 'a binary'
  : typeof v === 'object' ? 'an object' : 'a ' + typeof v);
const mismatch = (v, type) => litErr(`Cannot write ${jsType(v)} value as a SQL ${type === 'any' ? 'sql_variant' : type} `
  + 'literal.');
const overflow = type => numErr(8115, 'expression', type);
const expLit = x => x.toExponential().toUpperCase();

// The Type sqlLit writes: a dt name, a Type, or a column resolved like formatCell's; TypeError when there is none.
function litType(dt) {
  if (dt == null) return ANY_T;
  if (typeof dt === 'string') {
    const t = DT_TYPE.get(dt);
    if (t) return t;
    throw new TypeError(`sqlLit: '${dt}' is not a type name`);
  }
  if (typeof dt === 'object') {
    // Resolved on every call (never cached), so a column or AttrInfo updated in place is read as it is now.
    const t = colType(dt);
    if (t && DT_NAMES.has(t.dt)) return t;
  }
  throw new TypeError('sqlLit: dt must be a type name, a Type or a column with a type');
}

// 02 §5: a number beyond ±(2^53 - 1) was rounded when it was read, so its digits are not the stored value.
function unsafeErr(dt) {
  const name = dt && typeof dt === 'object' && typeof dt.name === 'string' && dt.name !== '' ? dt.name : null;
  return litErr(`Value ${name ? `of ${name} ` : ''}exceeds 2^53 and cannot be written exactly.`);
}

function bigLit(v, type) {
  const s = v.toString();
  const digits = v < 0n ? s.length - 1 : s.length;
  switch (type) {
    case 'int': if (v < I32_MIN_BIG || v > I32_MAX_BIG) throw overflow('int'); return s;
    case 'bigint': if (v < I64_MIN || v > I64_MAX) throw overflow('bigint'); return s;
    case 'money': if (v < -MONEY_MAX_INT || v > MONEY_MAX_INT) throw overflow('money'); return s;
    case 'decimal': if (digits > 38) throw overflow('numeric'); return s;
    case 'float': {
      if (digits <= 38) return s;
      const x = Number(v);
      if (!Number.isFinite(x)) throw overflow('float');
      return expLit(x);
    }
    default: {
      if (digits <= 38) return s;
      const abs = s.replace(/^-/, '');
      const shown = abs.length > 40 ? abs.slice(0, 40) + '…' : abs;
      throw numErr(1007, shown);
    }
  }
}

function numLit(v, type, dt) {
  if (typeof v === 'bigint') return bigLit(v, type);
  if (typeof v !== 'number') throw mismatch(v, type);
  if (!Number.isFinite(v)) throw litErr(`Cannot write ${v} as a SQL literal.`);
  if (type === 'int' || type === 'bigint') {
    if (!Number.isInteger(v)) throw litErr(`Cannot write ${v} as a SQL ${type} literal: it is not a whole number.`);
    if (!Number.isSafeInteger(v)) throw unsafeErr(dt);
    if (type === 'int' && (v < I32_MIN || v > I32_MAX)) throw overflow('int');
    return String(v === 0 ? 0 : v);
  }
  if (type === 'any' && Number.isInteger(v) && !Number.isSafeInteger(v)) return expLit(v);
  const s = plainNumber(v);
  const m = PLAIN_NUM_RE.exec(s);
  if (type === 'money' && !moneyFits(v, m)) throw overflow('money');
  // T-SQL precision of the literal: integer digits without leading zeros ('0.5' has 1) plus every fraction digit.
  const digits = m[1].replace(ALL_LEAD_ZEROS_RE, '').length + (m[2] ? m[2].length : 0);
  return digits > 38 ? expLit(v) : s;
}

// True when the literal text of v (m: its PLAIN_NUM_RE match), converted to money as SQL Server does (rounded half
// away from zero to 4 decimals), lies in money's range. Exact on the decimal text, never on doubles: the double
// nearest 922337203685477.5807 is 922337203685477.625, and its text '922337203685477.6' overflows money.
function moneyFits(v, m) {
  if (v > -922337203685477 && v < 922337203685477) return true;
  const f = m[2] || '';
  let units = BigInt(m[1] + f.slice(0, 4).padEnd(4, '0'));
  if (f.length > 4 && f.charCodeAt(4) >= 53) units += 1n; // the fifth decimal is 5..9: round the magnitude up
  return units <= (v < 0 ? MONEY_MIN_UNITS_ABS : MONEY_MAX_UNITS);
}

function bitLit(v) {
  if (v === true || v === false) return v ? '1' : '0';
  if (typeof v === 'number' && Number.isFinite(v)) return v !== 0 ? '1' : '0';
  if (typeof v === 'bigint') return v !== 0n ? '1' : '0';
  throw mismatch(v, 'bit');
}

const DATE_T = DT_TYPE.get('date');

// Checks that v is a valid Date whose calendar fields (parts(v)) lie in years 1..9999; else throws the sqlLit error.
function checkDate(v, type, parts) {
  if (!(v instanceof Date)) throw mismatch(v, type);
  if (Number.isNaN(v.getTime())) throw litErr('Cannot write an invalid date as a SQL literal.');
  const y = parts(v).y;
  if (y < 1 || y > 9999) throw litErr('Cannot write a date outside 0001-01-01 .. 9999-12-31 as a SQL literal.');
}

// SQL literal of a value of static type dt (NULL, numbers, bit, N'…', 0x…, CONVERT(datetime2,'<ISO>',127), …);
// {tz} is the session env.tz, required for datetime values.
export function sqlLit(v, dt, opts) {
  const t = litType(dt);
  if (v === null || v === undefined) return 'NULL';
  const tz = opts ? opts.tz : undefined;
  switch (t.dt) {
    case 'string':
      if (typeof v !== 'string') throw mismatch(v, 'nvarchar');
      return sqlStr(v);
    case 'int': case 'bigint': case 'decimal': case 'money': case 'float': return numLit(v, t.dt, dt);
    case 'bit': return bitLit(v);
    case 'guid':
      if (!isGuid(v)) throw numErr(8169);
      return `'${v.toLowerCase()}'`;
    case 'date':
      // A date value's calendar date is its UTC fields (01 §5), whatever the tz.
      checkDate(v, 'date', utcParts);
      return `'${isoText(v, DATE_T)}'`;
    case 'time':
      if (typeof v !== 'string') throw mismatch(v, 'time');
      if (!TIME_RE.test(v)) throw numErr(241);
      return `'${v}'`;
    case 'binary':
      if (!isBytes(v)) throw mismatch(v, 'varbinary');
      return toHex(v);
    case 'xml':
      if (typeof v !== 'string') throw mismatch(v, 'xml');
      return sqlStr(v);
    case 'datetime': {
      if (t.dto) {
        // Its own wall-clock time and offset, +00:00 without tzo (01 §5.5): the text formatCell's Raw cell shows,
        // whatever the session tz.
        checkDate(v, 'datetimeoffset', d => dateParts(d, null));
        return `CONVERT(datetimeoffset,'${isoText(v, t, null)}',127)`;
      }
      return datetimeLit(v, t, tz);
    }
    default: {
      // sql_variant: the base value by its base type.
      const base = variantValue(v);
      if (base !== v) return sqlLit(base, variantType(v), opts);
      switch (typeof v) {
        case 'number': case 'bigint': return numLit(v, 'any', dt);
        case 'boolean': return bitLit(v);
        case 'string': return sqlStr(v);
        default:
          if (v instanceof Date) return datetimeLit(v, DT2_7, tz);
          if (isBytes(v)) return toHex(v);
          throw mismatch(v, 'any');
      }
    }
  }
}

// CONVERT(datetime2,'<wall-clock time in tz><offset>',127), wrapped in DATEADD when the engine would read that wall
// time back as another instant (the hour a DST change repeats; see the notes above). tz is required: the engine
// reads the wall-clock time in the session tz, so a literal written for an assumed zone would be off by its offset.
function datetimeLit(v, type, tz) {
  if (!(v instanceof Date)) throw mismatch(v, 'datetime2');
  if (!isObj(tz) || (tz.utc !== true && typeof tz.offset !== 'function')) {
    throw new TypeError('sqlLit: opts.tz (the session env.tz) is required for datetime values');
  }
  checkDate(v, 'datetime2', d => dateParts(d, tz));
  // The Raw text of the value (types.isoText: 'Z' in UTC mode, else the offset; tick digits for datetime2(n)).
  const lit = `CONVERT(datetime2,'${isoText(v, type, tz)}',127)`;
  const delta = v.getTime() - fromWall(wallMs(v, tz), tz);
  if (delta === 0) return lit;
  return delta % 60000 === 0 ? `DATEADD(minute,${delta / 60000},${lit})` : `DATEADD(millisecond,${delta},${lit})`;
}

// ------------------------------------------------------------------------------------------------------ links

let knownTables = null;

// Registers the "is this a known table" check for recordUrl/listUrl (main.js: n => !!meta.findEntity(n)).
export function setKnownTables(check) {
  knownTables = typeof check === 'function' ? check : null;
}

const ETN_RE = /^[a-z0-9_]+$/;
// Longer than any Dataverse logical name; a longer etn is never known (see the notes above).
const ETN_MAX = 128;

// The lower-cased logical name when it is a known table: the per-call `known` or the registered check says so
// (03 §1.1: either one); else null. Fails closed while neither exists.
function knownEtn(entity, known) {
  if (typeof entity !== 'string' || entity.length > ETN_MAX) return null;
  const e = entity.toLowerCase();
  if (!ETN_RE.test(e)) return null;
  return (typeof known === 'function' && known(e)) || (knownTables !== null && knownTables(e)) ? e : null;
}

// 'appid=<guid>&' from the host URL, or '' when it has no GUID appid.
function appPart() {
  const id = new URL(location.href).searchParams.get('appid');
  return isGuid(id) ? `appid=${id.toLowerCase()}&` : '';
}

// Absolute main.aspx URL of a record (GUID id, known table, current appid), or null.
export function recordUrl(entity, id, opts) {
  const etn = knownEtn(entity, (opts || NO_OPTS).known);
  if (!etn || !isGuid(id)) return null;
  return `${location.origin}/main.aspx?${appPart()}pagetype=entityrecord&etn=${etn}&id=${id.toLowerCase()}`;
}

// Absolute main.aspx URL of a table's list, optionally at a view (viewType 1039 savedquery / 4230 userquery), or null.
export function listUrl(entity, opts) {
  const { viewId, viewType, known } = opts || NO_OPTS;
  const etn = knownEtn(entity, known);
  if (!etn) return null;
  let view = '';
  if (viewId != null || viewType != null) {
    const vt = Number(viewType);
    if (!isGuid(viewId) || (vt !== 1039 && vt !== 4230)) return null;
    view = `&viewid=${viewId.toLowerCase()}&viewType=${vt}`;
  }
  return `${location.origin}/main.aspx?${appPart()}pagetype=entitylist&etn=${etn}${view}`;
}

const ENV_RE = /^(?:default-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Maker portal URL of a table (only on *.dynamics.com hosts), or null.
export function makerUrl(envId, metadataId) {
  if (!/\.dynamics\.com$/i.test(location.hostname)) return null;
  if (typeof envId !== 'string' || !ENV_RE.test(envId) || !isGuid(metadataId)) return null;
  const env = /^default-/i.test(envId) ? 'Default-' + envId.slice(8).toLowerCase() : envId.toLowerCase();
  return `https://make.powerapps.com/environments/${env}/entities/${metadataId.toLowerCase()}`;
}

// ---------------------------------------------------------------------------------- DOM helpers (Edge only)

const GUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// The query strings recordUrl and listUrl build (00 §5 rule 6: no data except validated ids): 1 the appid, 2 the
// etn of a record, 3 the etn of a list.
const APP_LINK_RE = new RegExp(`^\\?(?:appid=(${GUID_SRC})&)?pagetype=(?:entityrecord&etn=([a-z0-9_]{1,${ETN_MAX}})`
  + `&id=${GUID_SRC}|entitylist&etn=([a-z0-9_]{1,${ETN_MAX}})(?:&viewid=${GUID_SRC}&viewType=(?:1039|4230))?)$`);

// True for a main.aspx page of this origin in a shape recordUrl/listUrl build (http: only for the dev build), of a
// known table (registered or `known`) and with the host's current appid or none: what recordUrl/listUrl check.
function isAppLink(p, known) {
  if (p.origin !== location.origin || (p.protocol !== 'https:' && p.protocol !== 'http:') || p.username
    || p.password || p.pathname !== '/main.aspx' || p.hash !== '') return false;
  const m = APP_LINK_RE.exec(p.search);
  if (!m) return false;
  if (m[1] !== undefined && `appid=${m[1]}&` !== appPart()) return false;
  return knownEtn(m[2] ?? m[3], known) !== null;
}

// Opens a link the user clicked: a new tab (noopener, noreferrer), or {sameTab} this tab (same origin only); a
// page of this origin needs a known table ({known} as for recordUrl).
export function openUrl(url, opts) {
  const o = opts || NO_OPTS;
  const u = typeof url === 'string' && url.trim() !== '' ? safeUrl(url) : null;
  const p = u == null ? null : new URL(u);
  const app = p != null && isAppLink(p, o.known);
  // Another site: https only, no credentials (makerUrl, About links); never blob:, data: or other schemes, and
  // never another page of this origin (it would run with the user's session).
  if (!app && (p == null || p.origin === location.origin || p.protocol !== 'https:' || p.username || p.password)) {
    throw new Error('openUrl: this URL is not allowed.');
  }
  if (o.sameTab) {
    if (!app) throw new Error('openUrl: only pages of this site can open in the same tab.');
    location.assign(p.href);
    return;
  }
  window.open(p.href, '_blank', 'noopener,noreferrer');
}

// Opens a personal view in this app in place with the page's own client API, Xrm.Navigation.navigateTo: no
// reload, so SQL Studio and its results stay open. Resolves true once Dynamics took the
// navigation, false when the page has no such API or it refused (the Power Apps start page, an old client), so the
// caller opens the view another way. Only a GUID view of a valid table name is passed on.
export function navigateToView(etn, viewId, { timeoutMs = 8000 } = NO_OPTS) {
  if (typeof etn !== 'string' || !/^[a-z0-9_]{1,64}$/i.test(etn) || !isGuid(viewId)) return Promise.resolve(false);
  let nav = null;
  try { nav = globalThis.Xrm && globalThis.Xrm.Navigation; } catch { nav = null; }
  if (!nav || typeof nav.navigateTo !== 'function') return Promise.resolve(false);
  let p;
  try {
    p = nav.navigateTo({ pageType: 'entitylist', entityName: etn.toLowerCase(), viewId: viewId.toLowerCase(), viewType: 'userquery' });
  } catch { return Promise.resolve(false); }
  // A navigation that started but never settles its promise still counts: the list is on its way.
  return Promise.race([Promise.resolve(p).then(() => true, () => false), new Promise(r => setTimeout(() => r(true), timeoutMs))]);
}

// Downloads a Blob as a file named `name` (Blob URL + a[download]; the URL is revoked after 60 s).
export function download(blob, name) {
  if (!(blob instanceof Blob)) throw new TypeError('download: a Blob is required');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = String(name || '') || 'download';
  a.rel = 'noopener';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const isAbort = e => !!e && e.name === 'AbortError';
const isBlocked = e => !!e && (e.name === 'SecurityError' || e.name === 'NotAllowedError');

// True only when the browser reports that the page has no transient user activation (navigator.userActivation,
// Chromium 72+); without that API nothing is known and the caller goes ahead.
function activationLost() {
  const nav = globalThis.navigator;
  const ua = nav ? nav.userActivation : null;
  return !!ua && ua.isActive === false;
}

// e marked emptied = true (the save picker's file was left empty); a primitive or non-extensible e is wrapped in an
// Error whose cause it is, so the flag is never lost.
function emptiedError(e) {
  if ((typeof e === 'object' && e !== null) || typeof e === 'function') {
    try {
      e.emptied = true;
      if (e.emptied === true) return e;
    } catch { /* frozen, or a throwing setter or getter: wrapped below */ }
  }
  let text;
  try { text = e instanceof Error ? String(e.message) : String(e); } catch { text = 'The file could not be saved.'; }
  const w = new Error(text, { cause: e });
  w.emptied = true;
  return w;
}

async function writeTo(handle, blob) {
  const w = await handle.createWritable();
  try {
    await w.write(blob);
    await w.close();
  } catch (e) {
    // Abort discards the partial write so the original file stays; the write error is the one reported.
    try { await w.abort(); } catch { /* reported through e below */ }
    throw e;
  }
}

// Saves a file: the save picker opens first (in the click), then make() builds it; download fallback (03 §12);
// emptied marks a save that ended without writing after the picker had created or emptied the file.
export async function saveFile(name, make, opts) {
  const { types, handle } = opts || NO_OPTS;
  let blob = null;
  // make() runs at most once; null means its AbortError cancelled the save, any other error rejects.
  const getBlob = async () => {
    if (blob) return blob;
    let b;
    try { b = await make(); } catch (e) { if (isAbort(e)) return null; throw e; }
    if (!(b instanceof Blob)) throw new TypeError('saveFile: make() must return a Blob');
    return (blob = b);
  };
  const cancelled = () => ({ status: 'cancelled' });
  if (handle) {
    let perm = 'granted';
    if (typeof handle.requestPermission === 'function') {
      try { perm = await handle.requestPermission({ mode: 'readwrite' }); } catch (e) { if (!isBlocked(e)) throw e; perm = 'denied'; }
    }
    if (perm === 'granted') {
      const b = await getBlob();
      if (!b) return cancelled();
      try {
        await writeTo(handle, b);
        return { status: 'saved', handle };
      } catch (e) {
        if (isAbort(e)) return cancelled();
        // A refused write or a moved file falls back to the picker below.
        if (!e || (e.name !== 'NotAllowedError' && e.name !== 'NotFoundError')) throw e;
      }
    }
  }
  if (typeof globalThis.showSaveFilePicker === 'function') {
    // After the awaits above (the handle's permission) the click's activation may be used up; the picker then throws
    // SecurityError and, like any blocked picker, the content is downloaded below (03 §12), never dropped.
    let picked = null;
    try {
      picked = await globalThis.showSaveFilePicker(types ? { suggestedName: name, types } : { suggestedName: name });
    } catch (e) {
      if (isAbort(e)) return cancelled();
      if (!isBlocked(e)) throw e;
    }
    if (picked) {
      // Chromium has now created the chosen file, or emptied it (see the notes above): a save that ends without writing
      // says so, never 'nothing was written'.
      try {
        const b = await getBlob();
        if (!b) return { status: 'cancelled', emptied: true };
        await writeTo(picked, b);
      } catch (e) {
        if (isAbort(e)) return { status: 'cancelled', emptied: true };
        throw emptiedError(e);
      }
      return { status: 'saved', handle: picked };
    }
  }
  const b = await getBlob();
  if (!b) return cancelled();
  download(b, name);
  return { status: 'downloaded' };
}

// The <input type=file> accept attribute for a picker accept map ({'text/csv': ['.csv']} -> 'text/csv,.csv').
function acceptAttr(accept) {
  if (!accept || typeof accept !== 'object') return '';
  const out = new Set();
  for (const [mime, exts] of Object.entries(accept)) {
    out.add(mime);
    for (const x of [].concat(exts ?? [])) out.add(String(x));
  }
  return [...out].join(',');
}

// The chosen files of a hidden <input type=file> (several with `many`), [] when cancelled.
function pickWithInput(accept, many) {
  // Without transient activation input.click() is ignored and neither 'change' nor 'cancel' ever fires.
  if (activationLost()) {
    const e = new Error('Click the button again to choose a file.');
    e.code = 'nogesture';
    return Promise.reject(e);
  }
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    if (many) input.multiple = true;
    const list = acceptAttr(accept);
    if (list) input.accept = list;
    input.addEventListener('change', () => {
      const fl = input.files ? Array.from(input.files) : [];
      resolve(many ? fl : fl.slice(0, 1));
    }, { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}

// Lets the user pick a file ({multiple}: one or more): the open picker, else a hidden <input type=file>;
// {file, handle, files}, or null when cancelled (03 §12).
export async function openFile(opts) {
  const { accept, description, maxBytes, multiple } = opts || NO_OPTS;
  const many = multiple === true;
  let handles = null;
  if (typeof globalThis.showOpenFilePicker === 'function') {
    const o = { multiple: many };
    if (accept) o.types = [description ? { description, accept } : { accept }];
    try {
      const hs = await globalThis.showOpenFilePicker(o);
      handles = hs ? Array.from(hs).filter(Boolean) : [];
      if (!many) handles = handles.slice(0, 1);
    } catch (e) {
      if (isAbort(e)) return null;
      if (!isBlocked(e)) throw e;
    }
  }
  const picked = handles ? await Promise.all(handles.map(h => h.getFile())) : await pickWithInput(accept, many);
  const files = picked.filter(Boolean);
  if (!files.length) return null;
  if (typeof maxBytes === 'number' && Number.isFinite(maxBytes)) {
    const big = files.find(f => f.size > maxBytes);
    if (big) {
      const e = new Error(`This file is larger than ${fmtBytes(maxBytes)}.`);
      e.code = 'toolarge';
      e.fileName = big.name;
      throw e;
    }
  }
  return { file: files[0], handle: handles ? handles[0] : null, files };
}

// The focused element, looking inside open shadow roots (SQL Studio's UI lives in one).
function deepActive() {
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

function execCopy(s) {
  const prev = deepActive();
  // The shadow root holding the focused element (SQL Studio's own), so focus never leaves the tool and the host
  // page's focus listeners and MutationObservers never see the textarea; document.body otherwise.
  const root = prev && typeof prev.getRootNode === 'function' ? prev.getRootNode() : null;
  const parent = root && root !== document && root.nodeType === 11 && root.host ? root : document.body;
  let ta = null;
  try {
    ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.setAttribute('aria-hidden', 'true');
    ta.setAttribute('tabindex', '-1');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none';
    parent.appendChild(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    return document.execCommand('copy') === true;
  } catch {
    return false; // the caller reports false as 'Could not copy to the clipboard.' (03 §12)
  } finally {
    if (ta) ta.remove();
    if (prev && prev !== document.body && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
  }
}

// Copies text: navigator.clipboard.writeText in the gesture, else a textarea + execCommand('copy'); true when copied.
export function copyText(text) {
  const s = text == null ? '' : String(text);
  let p;
  try { p = navigator.clipboard.writeText(s); } catch (e) { p = Promise.reject(e); }
  return Promise.resolve(p).then(() => true, () => execCopy(s));
}

// Copies a Blob (or a Promise of one, e.g. an image/png) with navigator.clipboard.write in the gesture.
export function copyBlob(blobOrPromise, type) {
  let p;
  try {
    const rec = Object.create(null);
    rec[String(type)] = blobOrPromise;
    p = navigator.clipboard.write([new ClipboardItem(rec)]);
  } catch (e) {
    p = Promise.reject(e);
  }
  // A rejected blob promise is reported as false below; this keeps it from also being an unhandled rejection.
  if (blobOrPromise && typeof blobOrPromise.then === 'function') blobOrPromise.then(null, () => {});
  return Promise.resolve(p).then(() => true, () => false);
}

// Lets the browser paint and handle input between work slices (scheduler.yield, else postTask; 03 §13).
export function yieldToUi() {
  const s = globalThis.scheduler;
  if (s && typeof s.yield === 'function') return s.yield().then(() => undefined);
  if (s && typeof s.postTask === 'function') return s.postTask(() => undefined, { priority: 'user-visible' });
  return new Promise(resolve => setTimeout(resolve, 0));
}
