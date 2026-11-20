// Export and copy formats of the results area (03 §7, §7.1, §13; 00 §5 rules 7 and 10):
// CSV, XLSX (a zip written with CompressionStream 'deflate-raw', with record hyperlinks), JSON and XML files; the
// fixed-width text of Results as text and its virtualised view; and the TSV, CSV, JSON, Markdown, text, INSERT,
// IN-list and FetchXML in-condition clipboard formats. Every format writes an ExportTable, the current view of one
// result set (03 §7). The writers are pure and table-driven; the thin DOM part is createTextView(), exportFile() and
// copyAs(), which results.js and grid.js call from their click handlers (the save picker and the clipboard write
// start synchronously in the click).
//
// Notes (extensions of 03 §7 / §7.1):
// - ExportTable (the input of every writer; exportTable() validates and normalises it): {title, columns /* the set's
//   full Column[] schema, hidden columns included, so companions resolve */, order /* indexes of the visible columns
//   in displayed order; default every non-hidden column in schema order; hidden columns are always dropped, 01 §6.1 */,
//   rows /* the view's rows (full-schema arrays) after the quick filter, column filters and sort, in view order */,
//   total /* rows in the set before filters, for 'of 50,000 rows (filtered)' */, filtered, incomplete /* 'cancelled' |
//   'error' | null */, widths /* grid widths in px, parallel to order (XLSX <cols>) */, source /* resultset.source */}.
//   sliceTable(table, {rows, cols}) gives the selected cells (positions in rows and in order), which the cell context
//   menu's copies write. fmt = {friendly, tz /* display env.tz */, dateFormat, label, known /* formatCell options */,
//   neutralize /* settings.csvNeutralize */}.
// - Grid payloads: every function that takes an ExportTable also takes grid.js's selection payload (selectedPayload(),
//   columnPayload(): {columns /* the visible Columns in displayed order */, indexes /* their schema indexes */, rows /*
//   full-schema arrays */, selected(i, j), friendly, tz, dateFormat, incomplete, source}), so results.js passes
//   grid.js's actions.copyAs(format, payload) on as copyAs(format, payload, ctx). A table's own friendly, tz,
//   dateFormat, label, known and neutralize are the defaults of fmt (fmt's defined values win). selected(i, j)
//   (positions in rows and in the visible columns) is false for a cell outside a non-rectangular selection: the copy
//   keeps the selection's layout (the union of its rows and columns, 03 §7.1 'laid out as for Copy') and writes such a
//   cell as an empty CSV, TSV, Markdown or text cell, leaves its key out of the JSON object and its element out of the
//   XML row, writes no XLSX cell and NULL in Copy as INSERT; the IN list and the in condition skip it (it is not
//   counted as NULL). Format names are case-insensitive, so grid.js's 'inList' and 'fetchIn' work as they are.
// - copyState(format, table, {col, streaming}) gives an item's disabled state and title for grid.js's
//   actions.copyState and results.js's Export ▾: STREAMING_TITLE ('Available when all rows have loaded', 03 §7) while
//   the set streams (results.js passes streaming for whole-view items only; copies of selected cells stay available),
//   ONE_COLUMN_TITLE for an IN list or in condition without exactly one column, and FETCH_IN_DISABLED for a column that
//   fetchInState refuses.
// - Formula neutralisation (00 §5 rule 7) applies to every text cell, i.e. every non-NULL cell whose formatCell class
//   is '' or 'empty': string columns, and also Friendly labels and lookup names (text from metadata or data) and
//   strings in sql_variant columns. Numbers (class 'num'), dates, GUIDs and binary text are written raw, so a negative
//   number never gets the prefix. Header cells (column names) are text and get it too.
// - A single-cell copy (one row, one column, no header) is the cell's exact text: no quoting and no neutralisation.
//   Copy as CSV always writes a header row, so it is always a multi-cell copy and is neutralised (00 §5 rule 7).
//   TSV writes NULL as an empty field; CSV writes NULL as an empty field and '' as "" (so the two stay apart).
// - Markdown also writes `&` as `&amp;` before an entity-like `#x41;`/`name;` text and `<` as `&lt;` before a letter,
//   `/`, `!` or `?`, so cell text that looks like HTML is shown as text (GitHub would drop it). A column is
//   right-aligned (`---:`) when its type is numeric and no non-NULL cell is shown as text (a Friendly choice label);
//   the same rule aligns the Results-as-text columns.
// - JSON: bit values are true/false (as FOR JSON writes them, 01 §5.6); a non-finite float is a string; an integer
//   beyond ±(2^53 - 1) is a string of its exact digits when the FormattedValue companion has them (02 §5), else of
//   the digits it was rounded to, and the toast says how many were rounded. A datetime of a TimeZoneIndependent
//   attribute (attr.behavior) is its stored wall-clock time without 'Z' or offset (the Raw cell text, 03 §7 Cells,
//   as FOR JSON and SQL 4 CDS write it): its value is the Date whose display-tz wall clock is the stored one (02
//   §4.2), so its UTC instant would change with the browser's time zone. Every other datetime is ISO 8601 UTC.
// - XML: element names also encode ':' (no namespaces are declared) and the '_' of a literal `_xHHHH_` (as
//   `_x005F_`), as SQL Server does; numbers are written as exec.js XmlOutput writes them for FOR XML (decimals with
//   their scale, money with 4 decimals, floats in CONVERT style 2, '1.000000000000000e-001', SQL Server's FOR XML
//   form; a non-finite JS number as 'NaN' or 'Infinity'); datetimes are the wall-clock time in the display tz
//   without offset (FOR XML), the fraction only when it is not zero; a datetimeoffset value is at its own offset, and
//   one without `tzo` at +00:00 (03 §7 Cells, as the grid, JSON and XLSX show it). An xml-typed value is embedded
//   unescaped, as FOR XML embeds it (01 §5.7), when it parses on its own as a fragment under parseXml (mixed mode: every
//   element closed, every prefix declared, no DOCTYPE) and does not start with an XML declaration, else it is escaped
//   like a string, so it can never close the element around it and the file is always well-formed. A value with a
//   character XML 1.0 cannot represent stops the export with 'Row <n>, column “<c>”: the value contains U+XXXX, which
//   XML 1.0 cannot represent. Export JSON or CSV instead.' (never an invalid file).
// - XLSX: an integer with more than 15 significant digits is written as text too (Excel keeps only 15, so 2^53 - 1
//   would lose its last digit), like an integer beyond ±(2^53 - 1) and a decimal or money value with more than 15;
//   trailing zeros are not significant. A date-only value before 1900-03-01 is the text yyyy-MM-dd. A Date in a
//   sql_variant or other non-date column gets the date-time style 3 on its own cell. A link URL must be an https: (or
//   the page's own) same-origin URL; xlsx() drops any other. workbook.xml also defines each sheet's
//   _xlnm._FilterDatabase name and marks the first sheet tabSelected, as Excel writes them. Sheet names also lose
//   control characters and leading or trailing apostrophes (Excel refuses them) and are cut at 31 UTF-16 units
//   without splitting a surrogate pair; apostrophes and spaces the cut leaves at the end are stripped again. A sheet
//   with more than 1,048,575 rows or 16,384 columns is refused before the picker opens. Without grid widths a column
//   is as wide as its header and its first 200 values (8-80 characters).
// - xlsx(sheets, opts) row values (the plain-sheet input of 03 §7.1), converted by the column kind so that no value is
//   lost: null or undefined writes no cell; a number is a numeric cell (a non-finite one its text; in an 'int'
//   column an integer Excel cannot keep exactly, beyond ±(2^53 - 1) or with more than 15 significant digits, its
//   digits as text); a string an inline string cut at 32,767 characters; a boolean 1 or 0; a bigint a number when it
//   has at most 15 significant digits, else its digits as text; a Date in a 'date' column its UTC calendar date (an
//   engine date value), elsewhere its wall-clock time in opts.tz (its own offset when it carries `tzo`), as an Excel
//   serial number, or the text yyyy-MM-dd[ HH:mm:ss] before 1900-03-01, with style 3 on its own cell in a column that
//   is not 'date' or 'datetime'; a Uint8Array its '0x' hex text; {v, s} a number v (finite) with cellXfs style s
//   (0-6). Any other value is a TypeError naming its row and column (never a silently missing cell).
// - Results as text: createTextView(host, opts) (below) is the virtualised view results.js shows for the Text segment;
//   textLayout() is its pure layout. With csvNeutralize on, the view shows the neutralised text, so what is shown,
//   selected and copied is the same. Headers align like their column; a left-aligned last column is not padded.
//   export.js exports no `CSS`: 03 §1.3 gives it no class prefix
//   and lists no export.CSS in mountShell's css list. The text view is part of the results area, so its
//   rules are `TEXT_CSS`, with the results prefix (.rs-tx, .rs-tx-sc, .rs-tx-sz, .rs-tx-pre, .rs-tx-note), and
//   results.js mounts createTextView for the Text segment and appends TEXT_CSS to its own CSS string. Dev builds (__DEV__) report an Error through reportError() on the
//   first paint of a connected view whose <pre> is not absolutely positioned, i.e. when TEXT_CSS is missing.
// - Text view lines: one text node per line ('\n' and its text; line 0 without), rendered for the visible lines ± 60 and grown or
//   trimmed at the window edges, so a scroll step formats only the lines that enter the window; a line is formatted
//   again only when its row or the published widths change. The visible lines render at once; the ± 60 margins and
//   re-formatted lines run in slices of 8 ms (03 §13), continued on the next frames. Widths are published to the
//   lines at most every 500 ms (textLayout's staged mode, commit()), so lines formatted between two re-layouts align.
//   A ResizeObserver on the scroller (opts.ResizeObserver, default the global) repaints when the pane is resized.
// - Text view mouse selection (03 §7: 'mouse selection copies what is selected'): while the primary button is down
//   on the text (not on the scrollbar), or a non-collapsed selection (the shadow root's getSelection(),
//   opts.getSelection) has its anchor or focus in the text, the rendered nodes are kept: the window only
//   grows as the view scrolls (up to 3,000 lines and 2,000,000 characters, or until the visible lines jump more than
//   60 lines away from the rendered ones; then it is trimmed again), and the anchor and focus nodes keep their text
//   until the selection is let go (re-checked every 250 ms); the lines between them are re-formatted in place, so
//   the selection's boundaries are never moved or replaced.
// - Text view streaming: opts.streaming and update({streaming}) say whether the set still streams; update({table,
//   added}) implies true, and update({table}) without added, or update({incomplete}), false, unless streaming is
//   given. While it streams, copyAll() and Mod+A then Mod+C (whole-view copies, 03 §7 Streaming) copy nothing and
//   say 'Available when all rows have loaded.' (STREAMING_TITLE); a mouse selection still copies what is selected.
//   The view reads `added` after update() returns (it keeps a copy of the array, never the caller's).
// - Large copies: above 100,000 cells (03 §7.1's export threshold) a copy is built in slices behind a progress toast,
//   and the clipboard write starts in the click with util.copyBlob(Promise<Blob>, 'text/plain') (a ClipboardItem
//   with a promise value, 03 §1.5); smaller copies use copyText.
// - INSERT statements: a column whose attr belongs to the target table (and whose role is value or pk) is written as
//   the attribute's logical name, every other column by its result name; an unnamed column is [Column<n>]. An integer
//   beyond ±(2^53 - 1) whose exact digits the FormattedValue companion has is written with those digits; otherwise
//   sqlLit's error stops the copy. With a table target (not #results) the statement is one the table accepts (02 §8.1):
//   name columns (role 'name': xname virtual columns, read-only) and columns whose attribute is not valid for create
//   (attr.validForCreate === false), with the visible type column of such a lookup, are left out, and the toast says
//   'Left out 2 columns that cannot be inserted into account: owneridname, createdon.' (at most 5 names, then 'and n
//   more'); a polymorphic lookup ({poly} ref) whose type companion is not among the copied columns is written as
//   CREATELOOKUP(N'<type>', '<id>') with the row's type, so the target table is known (02 §8.1 step 8). When no column
//   is left, nothing is copied: 'Nothing copied: no column of the view can be inserted into <table>.'
// - FetchXML in condition: the root table is resultset.source.tables[0]; a column of another table (by qual or by
//   attr.entity) gets the link-entity hint. Eligible columns also need role value or pk and the static type of their
//   attribute (a computed column never has attr).
// - Copy as Power BI (M) is the shell's Convert ▸ command (shell.js powerBiM); export.js re-exports
//   powerBiM so there is a single M writer.
// - exportFile('xlsx', [tables…]) (Excel, all result sets) names the file after ctx.title, else the first set.
// - Copy toasts of an incomplete set say so, as export toasts do (03 §7): 'Copied 37 values (incomplete).', 'Copied 1
//   cell (incomplete).'.
// - The text view's Mod+A and Mod+C are the KEYMAP grid keys gridSelectAll and gridCopy (shell.js keyMatches, by
//   e.code; opts.mac, default isMacPlatform()); its keydown listener is on its own scroller, never on the document.

import * as util from '../core/util.js';
import { formatCell, fmtInt, safeFileName, truncateText, sqlIdent, sqlLit, sqlStr, yieldToUi } from '../core/util.js';
import { parseXml, xmlEsc } from '../core/xml.js';
import { dtOfAttr, isoText, jsonValue, keyOf, toSqlString, variantType, variantValue, wallMs, withTicks } from '../engine/types.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { quoteName, keyMatches, keyLabel, isMacPlatform, isModifierOnly } from './shell.js';

export { powerBiM } from './shell.js';

// --------------------------------------------------------------------------------------------- constants

const UTC_TZ = Object.freeze({ utc: true, offset: () => 0 });
const NUM_DT = new Set(['int', 'bigint', 'decimal', 'money', 'float']);
const DT_NAMES = new Set(['int', 'bigint', 'decimal', 'float', 'money', 'bit', 'string', 'binary', 'xml', 'datetime',
  'date', 'time', 'guid', 'null', 'any']);
const ANY_T = Object.freeze({ dt: 'any' });
const DT2_7 = Object.freeze({ dt: 'datetime', prec: 7 });
const DATE_T = Object.freeze({ dt: 'date' });
const BIN_T = Object.freeze({ dt: 'binary' });
const FLOAT_T = Object.freeze({ dt: 'float' });
const MAX_SAFE_BIG = 9007199254740991n;
const CRLF = '\r\n';
// Marks a table exportTable() has validated, so the writers never normalise it twice.
const NORMAL = Symbol('exportTable');

// Exports and copies of more cells than this build in slices behind a progress toast (03 §7.1).
export const BIG_CELLS = 100000;
// The slice budget of long work (03 §13).
const SLICE_MS = 8;

// The user-visible texts of 03 §7 and §7.1: the disabled in-condition title, the text-view cut note, the copy
// failure, the emptied-file note, the 4 GiB stop and the XLSX MIME type.
export const FETCH_IN_DISABLED = 'Only text, whole-number, choice and ID columns that come straight from a Dataverse '
  + 'table can become a FetchXML in condition.';
export const TEXT_CUT_NOTE = 'Values longer than 256 characters are cut in this view. Exports keep them.';
export const COPY_FAILED = 'Could not copy to the clipboard.';
export const EMPTIED = 'The file you chose was left empty.';
export const XLSX_TOO_BIG = 'This Excel file would be larger than 4 GB. Filter the results or export CSV.';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// Excel's limits: rows below the header, columns, links per sheet and characters per cell.
export const XLSX_MAX_ROWS = 1048575;
export const XLSX_MAX_COLS = 16384;
export const XLSX_MAX_LINKS = 65530;
export const XLSX_MAX_TEXT = 32767;

// File formats of Export ▾: extension, toast label, picker type and MIME type.
const FILES = Object.freeze({
  csv: { ext: 'csv', label: 'CSV', mime: 'text/csv;charset=utf-8', type: { description: 'CSV file', accept: { 'text/csv': ['.csv'] } } },
  xlsx: { ext: 'xlsx', label: 'Excel', mime: XLSX_MIME, type: { description: 'Excel workbook', accept: { [XLSX_MIME]: ['.xlsx'] } } },
  json: { ext: 'json', label: 'JSON', mime: 'application/json', type: { description: 'JSON file', accept: { 'application/json': ['.json'] } } },
  xml: { ext: 'xml', label: 'XML', mime: 'application/xml', type: { description: 'XML file', accept: { 'application/xml': ['.xml'] } } },
});

// --------------------------------------------------------------------------------------------- tables

// Static type of a column, as formatCell resolves it: col.dt, a Type in col.type, the attribute's type or a dt name.
function typeOf(col) {
  if (!col || typeof col !== 'object') return ANY_T;
  if (typeof col.dt === 'string') return col;
  const t = col.type;
  if (t && typeof t === 'object' && typeof t.dt === 'string') return t;
  if (col.attr && typeof col.attr === 'object') return dtOfAttr(col.attr);
  if (typeof t === 'string' && DT_NAMES.has(t)) return { dt: t };
  return ANY_T;
}

const FMT_KEYS = ['friendly', 'tz', 'dateFormat', 'label', 'known', 'neutralize'];

// The schema of a grid payload ({columns /* the visible Columns */, indexes /* their schema indexes */}): a sparse
// array with each Column at its schema index, so rows (full-schema arrays) are read at the same positions.
function payloadSchema(columns, indexes) {
  if (indexes.length !== columns.length) throw new TypeError('exportTable: indexes must match columns');
  const schema = [];
  for (let k = 0; k < indexes.length; k++) {
    const i = indexes[k];
    if (!Number.isInteger(i) || i < 0 || i > 65535) throw new TypeError(`exportTable: column index ${i} is out of range`);
    if (schema[i] !== undefined) throw new TypeError(`exportTable: column index ${i} is repeated`);
    schema[i] = columns[k];
  }
  return schema;
}

// The validated ExportTable of a result set's current view or of a grid selection payload;
// TypeError for a malformed one.
export function exportTable(t) {
  if (!t || typeof t !== 'object') throw new TypeError('exportTable: a table is required');
  if (t[NORMAL] === true) return t;
  let { columns } = t;
  const { rows } = t;
  if (!Array.isArray(columns)) throw new TypeError('exportTable: columns must be an array');
  if (!Array.isArray(rows)) throw new TypeError('exportTable: rows must be an array');
  let given = t.order == null ? null : t.order;
  if (given != null && !Array.isArray(given)) throw new TypeError('exportTable: order must be an array');
  if (given == null && t.indexes != null) {
    if (!Array.isArray(t.indexes)) throw new TypeError('exportTable: indexes must be an array');
    columns = payloadSchema(columns, t.indexes);
    given = t.indexes;
  }
  const src = given ?? columns.map((_, i) => i);
  const order = [], keep = [], widths = Array.isArray(t.widths) ? [] : null;
  for (let k = 0; k < src.length; k++) {
    const i = src[k];
    if (!Number.isInteger(i) || i < 0 || i >= columns.length) throw new TypeError(`exportTable: column index ${i} is out of range`);
    const c = columns[i];
    // Hidden columns (pk, etag, companions, carried sort keys) are never exported (01 §6.1).
    if (c && c.hidden) continue;
    order.push(i);
    keep.push(k);
    if (widths) widths.push(t.widths[k]);
  }
  if (t.selected != null && typeof t.selected !== 'function') throw new TypeError('exportTable: selected must be a function');
  // selected(i, j) names positions in rows and in the given order; hidden columns that were dropped shift j.
  const sel = typeof t.selected === 'function'
    ? (keep.length === src.length ? t.selected : (i, j) => t.selected(i, keep[j]))
    : null;
  const total = Number.isInteger(t.total) && t.total >= rows.length ? t.total : rows.length;
  const fmt = Object.create(null);
  for (const k of FMT_KEYS) if (t[k] !== undefined) fmt[k] = t[k];
  return {
    [NORMAL]: true,
    title: t.title == null ? '' : String(t.title), columns, order, rows, total,
    filtered: t.filtered === true || total > rows.length,
    incomplete: t.incomplete === 'cancelled' || t.incomplete === 'error' ? t.incomplete : null,
    widths, source: t.source && typeof t.source === 'object' ? t.source : null, selected: sel, fmt,
  };
}

// The selected cells of a table: rows (positions in table.rows) × cols (positions in table.order), in that order.
export function sliceTable(table, { rows, cols } = {}) {
  const t = exportTable(table);
  const pick = (list, n, what) => {
    if (list == null) return Array.from({ length: n }, (_, i) => i);
    if (!Array.isArray(list)) throw new TypeError(`sliceTable: ${what} must be an array`);
    for (const i of list) if (!Number.isInteger(i) || i < 0 || i >= n) throw new TypeError(`sliceTable: ${what} position ${i} is out of range`);
    return list;
  };
  const rs = pick(rows, t.rows.length, 'row'), cs = pick(cols, t.order.length, 'column');
  const sel = t.selected;
  return {
    ...t, rows: rs.map(i => t.rows[i]), order: cs.map(j => t.order[j]), widths: t.widths ? cs.map(j => t.widths[j]) : null,
    total: rs.length, filtered: false, selected: sel ? (i, j) => sel(rs[i], cs[j]) : null,
  };
}

// Number of cells an export of the table writes (visible columns × rows).
export function exportCells(table) {
  const t = exportTable(table);
  return t.rows.length * t.order.length;
}

// Normalised export options: fmt's values, else the ones the table carries (a grid payload's).
function fmtOf(fmt, base) {
  const given = fmt && typeof fmt === 'object' ? fmt : null;
  let o = given ?? {};
  if (base) {
    o = Object.create(null);
    for (const k of FMT_KEYS) o[k] = given && given[k] !== undefined ? given[k] : base[k];
  }
  const tz = o.tz && typeof o.tz === 'object' && (o.tz.utc === true || typeof o.tz.offset === 'function') ? o.tz : UTC_TZ;
  return {
    friendly: o.friendly !== false, tz, dateFormat: o.dateFormat ?? null,
    label: typeof o.label === 'function' ? o.label : null, known: typeof o.known === 'function' ? o.known : null,
    neutralize: o.neutralize !== false,
  };
}

// What every writer needs about one visible column.
function colPrep(col, idx, pos, w) {
  const type = typeOf(col);
  const dt = DT_NAMES.has(type.dt) ? type.dt : 'any';
  const attr = col && col.attr && typeof col.attr === 'object' ? col.attr : null;
  return {
    col, idx, pos, name: col && col.name != null ? String(col.name) : '', type, dt, attr, numeric: NUM_DT.has(dt),
    dateOnly: dt === 'date' || (!!attr && attr.type === 'DateTime' && attr.format === 'DateOnly' && !type.dto),
    // A TimeZoneIndependent datetime: its display-tz wall clock is the stored value (02 §4.2).
    tzi: dt === 'datetime' && !type.dto && !!attr && attr.behavior === 'TimeZoneIndependent',
    widthPx: Number.isFinite(w) && w > 0 ? w : null,
  };
}

// A prepared table: the normalised table and options, the visible columns, the selection test (sel(i, j): false
// for a cell outside a non-rectangular selection, which is written as an empty cell; null when every cell counts)
// and the shared formatCell options (their `row` is set per row, so no options object is allocated per cell).
function prep(table, fmt) {
  const t = exportTable(table);
  const f = fmtOf(fmt, t.fmt);
  const fo = { friendly: f.friendly, tz: f.tz, row: null, full: true, label: f.label, dateFormat: f.dateFormat, known: f.known };
  const ro = { ...fo, friendly: false };
  return {
    t, f, fo, ro, n: t.rows.length, sel: t.selected,
    cols: t.order.map((idx, pos) => colPrep(t.columns[idx], idx, pos, t.widths ? t.widths[pos] : null)),
  };
}

// True when cell (i, j) is outside the selection (written empty).
const outside = (p, i, j) => p.sel !== null && !p.sel(i, j);

// formatCell of one visible cell, with the exact text (03 §1.1 full mode).
function cellOf(p, pc, row) {
  p.fo.row = row;
  return formatCell(row[pc.idx], pc.col, p.fo);
}

// The Raw exact text of a cell (the digits of an unsafe integer, 02 §5).
function rawText(p, pc, row) {
  p.ro.row = row;
  return formatCell(row[pc.idx], pc.col, p.ro).text;
}

// --------------------------------------------------------------------------------------------- text rules

const TRIGGERS = '=+-@\uFF1D\uFF0B\uFF0D\uFF20\t\r\n';

// The cell text with a leading ' when its first character could start a spreadsheet formula (00 §5 rule 7).
export function neutralize(text) {
  const s = text == null ? '' : String(text);
  return s !== '' && TRIGGERS.includes(s[0]) ? "'" + s : s;
}

// True for a formatCell result that shows text (strings, labels, names), the cells neutralisation applies to.
const isTextCell = r => r.cls === '' || r.cls === 'empty';

// Display text of a cell for the text formats (null for NULL), neutralised when asked.
function textOf(p, pc, row, neutral) {
  if (row[pc.idx] == null) return null;
  const r = cellOf(p, pc, row);
  return neutral && isTextCell(r) ? neutralize(r.text) : r.text;
}

const CSV_RE = /[",\r\n]/;
const TSV_RE = /[\t\r\n"]/;
const QUOTE_RE = /"/g;

// A CSV field: quoted with doubled quotes when it contains a comma, a quote, CR or LF (03 §7.1).
export function csvField(s) {
  const t = String(s);
  return CSV_RE.test(t) ? '"' + t.replace(QUOTE_RE, '""') + '"' : t;
}

// A TSV field: quoted with doubled quotes when it contains a tab, CR, LF or a quote (03 §7.1).
export function tsvField(s) {
  const t = String(s);
  return TSV_RE.test(t) ? '"' + t.replace(QUOTE_RE, '""') + '"' : t;
}

const MD_TEST = /[\\|\r\n\u2028\u2029<&]/;
const MD_NL = /\r\n|[\r\n\u2028\u2029]/g;

// A Markdown table cell: \ → \\, | → \|, line breaks → <br>, HTML-like < and & written as entities.
export function mdCell(s) {
  const t = String(s);
  if (!MD_TEST.test(t)) return t;
  return t.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/&(?=#?[A-Za-z0-9]+;)/g, '&amp;')
    .replace(/<(?=[A-Za-z/!?])/g, '&lt;').replace(MD_NL, '<br>');
}

const HEX4 = c => c.toString(16).toUpperCase().padStart(4, '0');
const isHigh = c => c >= 0xd800 && c <= 0xdbff;
const isLow = c => c >= 0xdc00 && c <= 0xdfff;

// XML 1.0 NameStartChar (without ':', which SQL Server encodes) and NameChar for one code point.
function isNameStart(c) {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || (c >= 0xc0 && c <= 0xd6)
    || (c >= 0xd8 && c <= 0xf6) || (c >= 0xf8 && c <= 0x2ff) || (c >= 0x370 && c <= 0x37d) || (c >= 0x37f && c <= 0x1fff)
    || c === 0x200c || c === 0x200d || (c >= 0x2070 && c <= 0x218f) || (c >= 0x2c00 && c <= 0x2fef)
    || (c >= 0x3001 && c <= 0xd7ff) || (c >= 0xf900 && c <= 0xfdcf) || (c >= 0xfdf0 && c <= 0xfffd)
    || (c >= 0x10000 && c <= 0xeffff);
}
const isNameChar = c => isNameStart(c) || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39) || c === 0xb7
  || (c >= 0x300 && c <= 0x36f) || c === 0x203f || c === 0x2040;
const LITERAL_X = /^x[0-9A-Fa-f]{4}_/;

// An XML element name for a column name: each UTF-16 unit not allowed at its position is `_xHHHH_` (SQL Server's
// FOR XML name encoding, 01 §5.7); '' stays '' (the caller writes col<n>).
export function xmlName(name) {
  const s = String(name ?? '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isHigh(c) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
      const cp = ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00) + 0x10000;
      out += (i === 0 ? isNameStart(cp) : isNameChar(cp)) ? s.slice(i, i + 2) : `_x${HEX4(c)}__x${HEX4(s.charCodeAt(i + 1))}_`;
      i++;
      continue;
    }
    if (c === 0x5f && LITERAL_X.test(s.slice(i + 1, i + 7))) { out += '_x005F_'; continue; }
    out += (i === 0 ? isNameStart(c) : isNameChar(c)) && !isHigh(c) && !isLow(c) ? s[i] : `_x${HEX4(c)}_`;
  }
  return out;
}

// Characters XML 1.0 forbids (C0 controls but tab, LF and CR; U+FFFE, U+FFFF; unpaired surrogates).
const XML_BAD_TEST = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const XML_BAD_RE = new RegExp(XML_BAD_TEST.source, 'g');
const XL_LITERAL_RE = /_(?=x[0-9A-Fa-f]{4}_)/g;

// Text of an XLSX inline string: a literal `_xHHHH_` keeps its '_' as `_x005F_`, characters XML 1.0 forbids become
// Excel's `_xHHHH_`, then xmlEsc (so every text round-trips exactly, 03 §7.1).
export function xlsxText(s) {
  let t = String(s);
  if (t.includes('_x')) t = t.replace(XL_LITERAL_RE, '_x005F_');
  if (XML_BAD_TEST.test(t)) t = t.replace(XML_BAD_RE, ch => `_x${HEX4(ch.charCodeAt(0))}_`);
  return xmlEsc(t, 'text');
}

let segmenter = null;
const graphemeSegmenter = () => (segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' }));
const ASCII_RE = /^[\x20-\x7e]*$/;

// Number of graphemes of s (Intl.Segmenter; printable ASCII counts by length).
export function graphemes(s) {
  if (ASCII_RE.test(s)) return s.length;
  let n = 0;
  for (const _ of graphemeSegmenter().segment(s)) n++;
  return n;
}

// s cut to at most `max` UTF-16 units at a grapheme boundary (Excel's cell limit), never inside a surrogate pair.
function cutUnits(s, max) {
  if (s.length <= max) return s;
  const base = Math.max(0, max - 256);
  const win = s.slice(base, max + 64);
  const seg = graphemeSegmenter().segment(win).containing(max - base);
  let cut = max;
  if (seg && seg.index + base < max && max - (seg.index + base) <= 64) cut = seg.index + base;
  else if (isLow(s.charCodeAt(max)) && isHigh(s.charCodeAt(max - 1))) cut = max - 1;
  return s.slice(0, cut);
}

// Significant digits of a plain number text ('-0012.3400' has 4): no sign, point, leading or trailing zeros.
export function sigDigits(text) {
  let a = 0, b = text.length;
  while (a < b && (text[a] === '-' || text[a] === '+' || text[a] === '0' || text[a] === '.')) a++;
  while (b > a && (text[b - 1] === '0' || text[b - 1] === '.')) b--;
  let n = 0;
  for (let i = a; i < b; i++) if (text[i] >= '0' && text[i] <= '9') n++;
  return n;
}

// --------------------------------------------------------------------------------------------- value encodings

const isBitValue = v => typeof v === 'boolean' || typeof v === 'number' || typeof v === 'bigint';
const bitOn = v => (typeof v === 'bigint' ? v !== 0n : !!v);
const validDate = v => v instanceof Date && !Number.isNaN(v.getTime());
const numJson = x => (Number.isFinite(x) ? String(x === 0 ? 0 : x) : JSON.stringify(String(x)));
const unq = s => s.slice(1, -1);
const isUnsafeBig = v => v > MAX_SAFE_BIG || v < -MAX_SAFE_BIG;

// ISO 8601 UTC text of a datetime instant (03 §7.1 JSON): its ticks kept, its own offset not used.
function utcIso(v, type) {
  const d = v.tk ? withTicks(new Date(v.getTime()), v.tk) : new Date(v.getTime());
  return isoText(d, type, UTC_TZ);
}

// The exact digits of an unsafe integer cell (02 §5), counting the ones that were already rounded when read.
function intDigits(p, pc, row, st) {
  const s = rawText(p, pc, row);
  if (s.startsWith('≈')) {
    if (st) st.approx++;
    return s.slice(1);
  }
  return s;
}

// JSON text of a value by its JS type (sql_variant base values, 'any' columns, values that do not match their type).
function jsonAny(v) {
  switch (typeof v) {
    case 'number': return Number.isFinite(v) && Number.isInteger(v) && !Number.isSafeInteger(v) ? `"${BigInt(v)}"` : numJson(v);
    case 'bigint': return isUnsafeBig(v) ? `"${v}"` : String(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'string': return JSON.stringify(v);
    default:
      if (v instanceof Date) return validDate(v) ? `"${utcIso(v, DT2_7)}"` : '"Invalid date"';
      if (v instanceof Uint8Array) return jsonValue(v, BIN_T, null);
      return JSON.stringify(String(v));
  }
}

// JSON text of one cell with its raw value (03 §7.1 JSON).
function jsonOf(p, pc, row, st) {
  let v = row[pc.idx];
  if (v == null) return 'null';
  let t = pc.type, dt = pc.dt;
  const base = variantValue(v);
  if (base !== v) {
    t = variantType(v);
    dt = DT_NAMES.has(t.dt) ? t.dt : 'any';
    v = base;
    if (v == null) return 'null';
  }
  switch (dt) {
    case 'bit': if (isBitValue(v)) return bitOn(v) ? 'true' : 'false'; break;
    case 'int': case 'bigint':
      if (typeof v === 'number' && Number.isInteger(v)) {
        if (Number.isSafeInteger(v)) return String(v === 0 ? 0 : v);
        return base === row[pc.idx] ? JSON.stringify(intDigits(p, pc, row, st)) : `"${BigInt(v)}"`;
      }
      if (typeof v === 'string' && base === row[pc.idx]) return JSON.stringify(intDigits(p, pc, row, st));
      break;
    case 'decimal': case 'money':
      if (typeof v === 'number' && Number.isFinite(v)) {
        const s = jsonValue(v, t, null);
        return sigDigits(s) > 15 ? `"${s}"` : s;
      }
      break;
    case 'float': if (typeof v === 'number') return numJson(v); break;
    case 'guid': if (typeof v === 'string') return JSON.stringify(v.toLowerCase()); break;
    case 'date': if (validDate(v)) return `"${isoText(v, DATE_T)}"`; break;
    case 'datetime':
      if (!validDate(v)) break;
      if (t.dto) return `"${isoText(v, t, null)}"`;
      // A TimeZoneIndependent value is its stored wall-clock time, without offset.
      if (pc.tzi && base === row[pc.idx]) return `"${isoText(v, t, p.f.tz, { offset: false })}"`;
      return `"${utcIso(v, t)}"`;
    case 'binary': if (v instanceof Uint8Array) return jsonValue(v, BIN_T, null); break;
    case 'string': case 'xml': case 'time': if (typeof v === 'string') return JSON.stringify(v); break;
  }
  return jsonAny(v);
}

// An XML declaration at the start of a value (parseXml accepts it there, after an optional BOM).
const XML_DECL_START = /^﻿?<\?xml[ \t\r\n?]/;

// True when an xml value can be embedded as element content: it parses on its own as a fragment (core/xml.js
// parseXml, mixed mode: every element closed, every prefix declared, no DOCTYPE), so it cannot close the element
// around it, and it does not start with an XML declaration, which is only allowed at the start of a document.
function xmlContent(v) {
  if (XML_DECL_START.test(v)) return false;
  try {
    parseXml(v, { mixed: true });
    return true;
  } catch {
    return false;
  }
}

// XML value text of a value by its JS type (FOR XML value rules, 01 §5.7).
function xmlAny(v, tz) {
  switch (typeof v) {
    case 'number': return Number.isInteger(v) && !Number.isSafeInteger(v) && Number.isFinite(v) ? String(BigInt(v)) : String(v === 0 ? 0 : v);
    case 'bigint': return String(v);
    case 'boolean': return v ? '1' : '0';
    case 'string': return v;
    default:
      if (v instanceof Date) return validDate(v) ? unq(jsonValue(v, DT2_7, tz)) : 'Invalid date';
      if (v instanceof Uint8Array) return unq(jsonValue(v, BIN_T, null));
      return String(v);
  }
}

// XML text of one cell with its raw value (03 §7.1 XML), or null for NULL (no element).
function xmlOf(p, pc, row, st) {
  let v = row[pc.idx];
  if (v == null) return null;
  let t = pc.type, dt = pc.dt;
  const base = variantValue(v);
  if (base !== v) {
    t = variantType(v);
    dt = DT_NAMES.has(t.dt) ? t.dt : 'any';
    v = base;
    if (v == null) return null;
  }
  switch (dt) {
    case 'bit': if (isBitValue(v)) return bitOn(v) ? '1' : '0'; break;
    case 'int': case 'bigint':
      if (typeof v === 'number' && Number.isInteger(v)) {
        if (Number.isSafeInteger(v)) return String(v === 0 ? 0 : v);
        return base === row[pc.idx] ? intDigits(p, pc, row, st) : String(BigInt(v));
      }
      if (typeof v === 'string' && base === row[pc.idx]) return intDigits(p, pc, row, st);
      break;
    case 'decimal': case 'money': if (typeof v === 'number' && Number.isFinite(v)) return jsonValue(v, t, null); break;
    // SQL Server's FOR XML float form, CONVERT style 2 ('1.000000000000000e-001'), as XmlOutput writes it (exec.js).
    case 'float': if (typeof v === 'number') return Number.isFinite(v) ? toSqlString(v, FLOAT_T, { style: 2 }) : String(v); break;
    case 'guid': if (typeof v === 'string') return v.toUpperCase(); break;
    case 'date': if (validDate(v)) return isoText(v, DATE_T); break;
    // A datetimeoffset value is at its own offset, +00:00 without `tzo` (03 §7 Cells); others in the display tz.
    case 'datetime': if (validDate(v)) return unq(jsonValue(v, t, t.dto ? null : p.f.tz)); break;
    case 'binary': if (v instanceof Uint8Array) return unq(jsonValue(v, BIN_T, null)); break;
    // An xml value is embedded unescaped, as FOR XML embeds it (01 §5.7), when it is well-formed element content.
    case 'xml': if (typeof v === 'string') return xmlContent(v) ? { xml: v } : v; break;
    case 'string': case 'time': if (typeof v === 'string') return v; break;
  }
  return xmlAny(v, p.f.tz);
}

// --------------------------------------------------------------------------------------------- slicing

const defaultNow = () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now());

// The AbortError of a cancelled export (util.saveFile resolves it as 'cancelled').
function abortError() {
  return new DOMException('The export was cancelled.', 'AbortError');
}

// Cooperative slicing for long work (03 §13): tick(done) yields to the UI once a slice has run SLICE_MS, reports
// progress and checks the AbortSignal.
function slicer({ signal, yieldToUi: y, now, onProgress, total } = {}) {
  const clock = typeof now === 'function' ? now : defaultNow;
  const pause = typeof y === 'function' ? y : yieldToUi;
  let start = clock();
  const check = () => { if (signal && signal.aborted) throw abortError(); };
  return {
    check,
    async tick(done) {
      check();
      if (clock() - start < SLICE_MS) return;
      if (typeof onProgress === 'function' && total > 0) onProgress(Math.min(1, done / total));
      await pause();
      check();
      start = clock();
    },
  };
}

// Rows per writer call: about 2,048 cells.
const stepOf = cols => Math.max(1, Math.floor(2048 / Math.max(1, cols)));

// The text of a writer, built synchronously (small views and clipboard copies).
function runSync(w, n, cols) {
  const parts = [w.head()];
  const step = stepOf(cols);
  for (let a = 0; a < n; a += step) parts.push(w.rows(a, Math.min(n, a + step)));
  parts.push(w.tail());
  return (w.finish ? w.finish(parts) : parts).join('');
}

// The Blob parts of a writer, built in slices; text is flushed into a Blob about every million characters, so the
// whole file never exists as one string.
async function runSliced(w, n, cols, run, base = 0) {
  const parts = [w.head()];
  const step = stepOf(cols);
  let buf = '';
  for (let a = 0; a < n; a += step) {
    buf += w.rows(a, Math.min(n, a + step));
    if (buf.length > 1048576) { parts.push(new Blob([buf])); buf = ''; }
    await run.tick(base + a + step);
  }
  if (buf) parts.push(buf);
  parts.push(w.tail());
  return w.finish ? w.finish(parts) : parts;
}

// --------------------------------------------------------------------------------------------- text writers

// CSV writer (03 §7.1): header of the visible column names, CRLF, optional BOM, NULL empty, '' as "".
function csvWriter(p, { bom = false, neutral = false } = {}) {
  const st = { ill: 0 };
  const name = s => { if (!s.isWellFormed()) st.ill++; return csvField(neutral ? neutralize(s) : s); };
  return {
    st,
    head: () => (bom ? '\uFEFF' : '') + p.cols.map(c => name(c.name)).join(',') + CRLF,
    rows(a, b) {
      let s = '';
      for (let i = a; i < b; i++) {
        const row = p.t.rows[i];
        let line = '';
        for (let j = 0; j < p.cols.length; j++) {
          if (j) line += ',';
          const x = outside(p, i, j) ? null : textOf(p, p.cols[j], row, neutral);
          if (x == null) continue;
          if (x === '') { line += '""'; continue; }
          if (!x.isWellFormed()) st.ill++;
          line += csvField(x);
        }
        s += line + CRLF;
      }
      return s;
    },
    tail: () => '',
  };
}

// TSV writer (03 §7.1): tab-separated, CRLF, the header row only with `headers`.
function tsvWriter(p, { headers = false, neutral = false } = {}) {
  return {
    head: () => (headers ? p.cols.map(c => tsvField(neutral ? neutralize(c.name) : c.name)).join('\t') + CRLF : ''),
    rows(a, b) {
      let s = '';
      for (let i = a; i < b; i++) {
        const row = p.t.rows[i];
        let line = '';
        for (let j = 0; j < p.cols.length; j++) {
          if (j) line += '\t';
          const x = outside(p, i, j) ? null : textOf(p, p.cols[j], row, neutral);
          if (x != null) line += tsvField(x);
        }
        s += line + CRLF;
      }
      return s;
    },
    tail: () => '',
  };
}

// Markdown writer (03 §7.1): a GitHub pipe table; the header and alignment rows are known once every row is
// written, so finish() puts them first. Lines are separated by CRLF; the table ends without one.
function markdownWriter(p, { neutral = true } = {}) {
  const right = p.cols.map(c => c.numeric);
  return {
    head: () => '',
    rows(a, b) {
      let s = '';
      if (!p.cols.length) return s;
      for (let i = a; i < b; i++) {
        const row = p.t.rows[i];
        let line = '|';
        for (let j = 0; j < p.cols.length; j++) {
          const pc = p.cols[j];
          if (row[pc.idx] == null || outside(p, i, j)) { line += '  |'; continue; }
          const r = cellOf(p, pc, row);
          if (r.cls !== 'num') right[j] = false;
          line += ' ' + mdCell(neutral && isTextCell(r) ? neutralize(r.text) : r.text) + ' |';
        }
        s += CRLF + line;
      }
      return s;
    },
    tail: () => '',
    finish(parts) {
      if (!p.cols.length) return [''];
      const head = '| ' + p.cols.map(c => mdCell(neutral ? neutralize(c.name) : c.name)).join(' | ') + ' |' + CRLF
        + '| ' + p.cols.map((_, j) => (right[j] ? '---:' : '---')).join(' | ') + ' |';
      return [head, ...parts];
    },
  };
}

// JSON keys: the visible column names, a repeated one with `_2`, `_3`, … (never a name already taken).
export function jsonKeys(names) {
  const taken = new Set(names), seen = new Set(), out = [];
  for (const n of names) {
    if (!seen.has(n)) { seen.add(n); out.push(n); continue; }
    let k = 2;
    while (taken.has(`${n}_${k}`) || seen.has(`${n}_${k}`)) k++;
    const key = `${n}_${k}`;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// JSON writer (03 §7.1): an array of objects keyed by the visible column names, pretty-printed with 2 spaces.
function jsonWriter(p) {
  const keys = jsonKeys(p.cols.map(c => c.name)).map(k => JSON.stringify(k));
  const st = { approx: 0 };
  let first = true;
  return {
    st,
    head: () => '[',
    rows(a, b) {
      let s = '';
      for (let i = a; i < b; i++) {
        const row = p.t.rows[i];
        s += first ? '\n' : ',\n';
        first = false;
        // A cell outside a non-rectangular selection leaves its key out.
        let obj = '';
        for (let j = 0; j < keys.length; j++) {
          if (outside(p, i, j)) continue;
          obj += (obj ? ',\n    ' : '\n    ') + keys[j] + ': ' + jsonOf(p, p.cols[j], row, st);
        }
        s += obj ? '  {' + obj + '\n  }' : '  {}';
      }
      return s;
    },
    tail: () => (first ? ']' : '\n]'),
  };
}

// XML writer (03 §7.1): <results>, one <row> per row, one element per non-NULL visible column.
function xmlWriter(p) {
  const names = p.cols.map((c, j) => (c.name === '' ? `col${j + 1}` : xmlName(c.name)));
  const st = { approx: 0 };
  const esc = (x, i, j) => {
    try {
      return xmlEsc(x, 'text');
    } catch (e) {
      if (e && typeof e.codePoint === 'number') {
        throw new Error(`Row ${fmtInt(i + 1)}, column ${quoteName(p.cols[j].name)}: the value contains U+${HEX4(e.codePoint)}, `
          + 'which XML 1.0 cannot represent. Export JSON or CSV instead.');
      }
      throw e;
    }
  };
  return {
    st,
    head: () => '<?xml version="1.0" encoding="utf-8"?>' + CRLF + '<results>' + CRLF,
    rows(a, b) {
      let s = '';
      for (let i = a; i < b; i++) {
        const row = p.t.rows[i];
        let inner = '';
        for (let j = 0; j < names.length; j++) {
          const x = outside(p, i, j) ? null : xmlOf(p, p.cols[j], row, st);
          if (x !== null) inner += `<${names[j]}>${typeof x === 'string' ? esc(x, i, j) : x.xml}</${names[j]}>`;
        }
        s += (inner === '' ? '<row/>' : `<row>${inner}</row>`) + CRLF;
      }
      return s;
    },
    tail: () => '</results>' + CRLF,
  };
}

// The SQL literal of a cell (sqlLit with the column type; an unsafe integer with its exact companion digits).
function literalOf(p, pc, row) {
  const v = row[pc.idx];
  if ((pc.dt === 'int' || pc.dt === 'bigint') && v != null && variantValue(v) === v
    && ((typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) || typeof v === 'string')) {
    const raw = rawText(p, pc, row);
    if (/^-?\d+$/.test(raw)) return sqlLit(BigInt(raw), pc.col, { tz: p.f.tz });
  }
  return sqlLit(v, pc.col, { tz: p.f.tz });
}

// The target of Copy as INSERT statements: the source table when resultset.source names exactly one, else null.
function insertTarget(source) {
  const tabs = source && Array.isArray(source.tables) ? source.tables : null;
  if (!tabs || tabs.length !== 1) return null;
  const e = tabs[0] && tabs[0].entity;
  return typeof e === 'string' && e !== '' ? e : null;
}

// The columns of Copy as INSERT statements: [{j /* position in p.cols */, pc, name, poly /* the
// schema index of the lookup type a CREATELOOKUP value takes its table from, or -1 */}], and the result names of the
// columns a table target cannot take.
function insertPlan(p, target) {
  const t = target ? target.toLowerCase() : null;
  const cols = [], left = [];
  const ofTarget = pc => t !== null && !!pc.attr && String(pc.attr.entity ?? '').toLowerCase() === t;
  const visible = new Set(), skip = new Set();
  for (const pc of p.cols) visible.add(pc.idx);
  if (t !== null) {
    // Name columns are read-only, and so is an attribute that is not valid for create (02 §8.1).
    for (const pc of p.cols) {
      if ((pc.col && pc.col.role === 'name') || (ofTarget(pc) && pc.attr.validForCreate === false)) skip.add(pc.idx);
    }
    // The visible type column of a lookup that is left out goes with it.
    const all = p.t.columns;
    for (let i = 0; i < all.length; i++) {
      const c = all[i], comp = c && c.companion;
      if (comp && Number.isInteger(comp.type) && skip.has(i) && visible.has(comp.type)) skip.add(comp.type);
    }
  }
  p.cols.forEach((pc, j) => {
    const result = pc.name === '' ? `Column${j + 1}` : pc.name;
    if (skip.has(pc.idx)) { left.push(result); return; }
    const a = pc.attr, col = pc.col, role = col ? col.role : undefined;
    const name = ofTarget(pc) && typeof a.logicalName === 'string' && a.logicalName !== ''
      && (role == null || role === 'value' || role === 'pk') ? sqlIdent(a.logicalName) : sqlIdent(result);
    // A polymorphic lookup needs its table (02 §8.1 step 8): from its type column when that is copied too, else
    // from the row's type through CREATELOOKUP.
    const comp = col && col.companion;
    const poly = t !== null && col && col.ref && col.ref.poly === true && comp && Number.isInteger(comp.type)
      && !(visible.has(comp.type) && !skip.has(comp.type)) ? comp.type : -1;
    cols.push({ j, pc, name, poly });
  });
  return { cols, left };
}

// The SQL value of one INSERT cell: its literal, or CREATELOOKUP(N'<type>', '<id>') for a polymorphic lookup.
function insertValue(p, c, row) {
  const lit = literalOf(p, c.pc, row);
  if (c.poly < 0 || lit === 'NULL') return lit;
  const type = row[c.poly];
  return typeof type === 'string' && type !== '' ? `CREATELOOKUP(${sqlStr(type)}, ${lit})` : lit;
}

// INSERT writer (03 §7.1): at most 1,000 rows per statement, values through sqlLit, names through sqlIdent.
function insertWriter(p) {
  const target = insertTarget(p.t.source);
  const plan = insertPlan(p, target);
  const head = `INSERT INTO ${target ? sqlIdent(target) : '#results'} (${plan.cols.map(c => c.name).join(', ')}) VALUES`;
  return {
    st: { target, left: plan.left, kept: plan.cols.length },
    head: () => '',
    rows(a, b) {
      let s = '';
      for (let i = a; i < b; i++) {
        const row = p.t.rows[i];
        s += i % 1000 === 0 ? (i === 0 ? '' : ';' + CRLF) + head + CRLF : ',' + CRLF;
        let vals = '';
        for (let k = 0; k < plan.cols.length; k++) {
          const c = plan.cols[k];
          vals += (k ? ', ' : '') + (outside(p, i, c.j) ? 'NULL' : insertValue(p, c, row));
        }
        s += '(' + vals + ')';
      }
      return s;
    },
    tail: () => (p.n ? ';' : ''),
  };
}

// 'Nothing copied: no column of the view can be inserted into account.'
const noInsertText = target => `Nothing copied: no column of the view can be inserted into ${target}.`;

// The toast note of the columns Copy as INSERT left out, or ''.
function leftOutText(st) {
  const n = st.left.length;
  if (!n) return '';
  const names = st.left.length > 5 ? `${st.left.slice(0, 5).join(', ')} and ${fmtInt(n - 5)} more` : st.left.join(', ');
  return ` Left out ${plural(n, 'column', 'columns')} that cannot be inserted into ${st.target}: ${names}.`;
}

// Distinct-value key of a cell (types.js keyOf: collation equality, as GROUP BY), else its written text.
function distinctKey(v, pc, text) {
  try { return keyOf(v, pc.type); } catch { return 'x' + text; }
}

// IN-list writer (03 §7.1): `(N'a', N'b')`, distinct values in view order, NULL values skipped.
function inListWriter(p, pos) {
  const pc = p.cols[pos];
  const seen = new Set(), lits = [];
  const st = { nulls: 0, values: 0 };
  return {
    st,
    head: () => '',
    rows(a, b) {
      for (let i = a; i < b; i++) {
        if (outside(p, i, pos)) continue;
        const row = p.t.rows[i];
        const v = row[pc.idx];
        if (v == null) { st.nulls++; continue; }
        const lit = literalOf(p, pc, row);
        const k = distinctKey(v, pc, lit);
        if (seen.has(k)) continue;
        seen.add(k);
        lits.push(lit);
      }
      st.values = lits.length;
      return '';
    },
    tail: () => (lits.length ? `(${lits.join(', ')})` : ''),
  };
}

const FETCH_IN_TYPES = new Set(['Uniqueidentifier', 'Lookup', 'Owner', 'Customer', 'String', 'Memo', 'Integer', 'BigInt',
  'Picklist', 'State', 'Status']);

// Whether Copy column as FetchXML in condition is enabled for a column, with the disabled title (03 §7.1).
export function fetchInState(col) {
  const attr = col && col.attr && typeof col.attr === 'object' ? col.attr : null;
  const role = col ? col.role : undefined;
  const ok = !!attr && FETCH_IN_TYPES.has(attr.type) && typeof attr.logicalName === 'string' && attr.logicalName !== ''
    && (role == null || role === 'value' || role === 'pk') && typeOf(col).dt === dtOfAttr(attr).dt;
  return ok ? { enabled: true, title: null } : { enabled: false, title: FETCH_IN_DISABLED };
}

// The table a column comes from, when it is not the root table of the set (the link-entity hint), else null.
function joinedTable(pc, source) {
  const root = source && Array.isArray(source.tables) && source.tables[0] ? source.tables[0] : null;
  if (!root || !pc.attr) return null;
  const ent = String(pc.attr.entity ?? '').toLowerCase();
  const rootEnt = String(root.entity ?? '').toLowerCase();
  const qual = pc.col && typeof pc.col.qual === 'string' ? pc.col.qual.toLowerCase() : null;
  const rootQual = typeof root.qual === 'string' ? root.qual.toLowerCase() : null;
  if (ent && rootEnt && ent !== rootEnt) return ent;
  if (qual && rootQual && qual !== rootQual) return ent || qual;
  return null;
}

// The raw FetchXML text of a value (GUIDs lower case, integers and option values as digits, strings as stored).
function fetchValue(p, pc, row) {
  const v = row[pc.idx];
  if (typeof v === 'string') {
    if (pc.dt === 'guid') return v.toLowerCase();
    if (pc.dt === 'int' || pc.dt === 'bigint') {
      const raw = rawText(p, pc, row);
      if (/^-?\d+$/.test(raw)) return raw;
    }
    return v;
  }
  if (typeof v === 'number') {
    if (Number.isSafeInteger(v)) return String(v === 0 ? 0 : v);
    const raw = rawText(p, pc, row);
    if (/^-?\d+$/.test(raw)) return raw;
    throw new Error(`Value of ${pc.name} exceeds 2^53 and cannot be written exactly.`);
  }
  if (typeof v === 'bigint') return String(v);
  return rawText(p, pc, row);
}

// FetchXML in-condition writer (03 §7.1): one <value> per distinct non-NULL value in view order, escaped with xmlEsc.
function fetchInWriter(p, pos) {
  const pc = p.cols[pos];
  const seen = new Set(), vals = [];
  const st = { nulls: 0, values: 0 };
  return {
    st,
    head: () => '',
    rows(a, b) {
      for (let i = a; i < b; i++) {
        if (outside(p, i, pos)) continue;
        const row = p.t.rows[i];
        const v = row[pc.idx];
        if (v == null) { st.nulls++; continue; }
        const text = fetchValue(p, pc, row);
        const k = distinctKey(v, pc, text);
        if (seen.has(k)) continue;
        seen.add(k);
        vals.push(`  <value>${xmlEsc(text)}</value>`);
      }
      st.values = vals.length;
      return '';
    },
    tail: () => (vals.length ? `<condition attribute="${xmlEsc(pc.attr.logicalName)}" operator="in">${CRLF}${vals.join(CRLF)}${CRLF}</condition>` : ''),
  };
}

// --------------------------------------------------------------------------------------------- Results as text

const SPACES = ' '.repeat(300);
const pad = n => (n <= 300 ? SPACES.slice(0, n) : ' '.repeat(n));
const NL_TEST = /[\n\r\u2028\u2029]/;
const NL_ALL = /\r\n|[\n\r\u2028\u2029]/g;
// The longest cell the text view shows (graphemes, 03 §7).
export const TEXT_MAX = 256;

// Rows per measuring step of the text layout: about 2,048 cells, at most 256 rows (03 §13 slices).
const measureStep = cols => Math.max(1, Math.min(256, Math.floor(2048 / (Number.isInteger(cols) && cols > 0 ? cols : 1))));

// The fixed-width text layout of Results as text (03 §7): widths grow with measure(); line(i) builds line i
// (0 header, 1 dashes, then the rows, an empty line and the row count) from the widths measured so far. With
// {staged: true} (the text view) line() uses the widths of the last commit(), so the lines formatted between two
// re-layouts align; `version` changes whenever the widths or alignments line() uses change.
export function textLayout(table, fmt, { staged = false } = {}) {
  const p = prep(table, fmt);
  // The layout grows its own copy of the table while the set streams (setRows), never the caller's.
  p.t = { ...p.t };
  const neutral = p.f.neutralize;
  const tfo = { ...p.fo, full: false, max: TEXT_MAX + 1 };
  const nc = p.cols.length;
  // live: what measuring found so far; widths/right: what line() uses (the same arrays unless staged).
  const live = new Array(nc).fill(0);
  const liveRight = p.cols.map(c => c.numeric);
  const cell = { text: '', g: 0 };
  let measured = 0, cut = false, maxChars = 0, version = 0;
  // A display text cut to TEXT_MAX graphemes, one line (⏎ for line breaks, a space for a tab).
  const fitText = (s, isText) => {
    let t = NL_TEST.test(s) ? s.replace(NL_ALL, '⏎') : s;
    if (neutral && isText && t !== '' && (TRIGGERS.includes(t[0]) || t[0] === '⏎')) t = "'" + t;
    if (t.includes('\t')) t = t.replace(/\t/g, ' ');
    let g = graphemes(t);
    if (g > TEXT_MAX) {
      t = truncateText(t, TEXT_MAX);
      g = graphemes(t);
      cut = true;
    }
    cell.text = t;
    cell.g = g;
    return cell;
  };
  const heads = p.cols.map(c => { const x = fitText(c.name, true); return { text: x.text, g: x.g }; });
  for (let j = 0; j < nc; j++) live[j] = heads[j].g;
  const widths = staged ? live.slice() : live;
  const right = staged ? liveRight.slice() : liveRight;
  // One cell's display text (formatCell, 03 §7) into `cell`; marks the column left-aligned when it shows text.
  const disp = (j, row, i) => {
    // A cell outside a non-rectangular selection is blank.
    if (i >= 0 && outside(p, i, j)) { cell.text = ''; cell.g = 0; return cell; }
    const pc = p.cols[j];
    tfo.row = row;
    const r = formatCell(row[pc.idx], pc.col, tfo);
    if (liveRight[j] && r.cls !== 'num' && r.cls !== 'null') {
      liveRight[j] = false;
      if (!staged) version++;
    }
    // formatCell replaced line breaks with ⏎ already; the first character decides neutralisation.
    return fitText(r.text, isTextCell(r));
  };
  const measureRow = (row, i) => {
    for (let j = 0; j < nc; j++) {
      const g = disp(j, row, i).g;
      if (g > live[j]) {
        live[j] = g;
        if (!staged) version++;
      }
    }
  };
  const lineOf = texts => {
    let s = '';
    for (let j = 0; j < nc; j++) {
      const x = texts(j);
      const fill = widths[j] - x.g;
      if (j) s += ' ';
      if (fill <= 0) s += x.text;
      else if (right[j]) s += pad(fill) + x.text;
      else s += j === nc - 1 ? x.text : x.text + pad(fill);
    }
    return s;
  };
  const footer = () => {
    const n = p.n;
    return `(${fmtInt(n)} ${n === 1 ? 'row' : 'rows'}${p.t.incomplete ? ', incomplete' : ''})`;
  };
  const layout = {
    get measured() { return measured; },
    get rowCount() { return p.n; },
    get columnCount() { return nc; },
    get cut() { return cut; },
    get widths() { return widths.slice(); },
    get right() { return right.slice(); },
    get version() { return version; },
    table: p.t,
    // Widens the columns with rows [a, b) of the table (default: every row not measured yet, in order).
    measure(a = measured, b = p.n) {
      const end = Math.min(b, p.n);
      for (let i = Math.max(0, a); i < end; i++) measureRow(p.t.rows[i], i);
      if (end > measured && a <= measured) measured = end;
      return measured;
    },
    // Widens the columns with rows [a, b) of a list of rows that arrived while the set streams (any positions).
    measureRows(list, a = 0, b = list.length) {
      const end = Math.min(b, list.length);
      for (let i = Math.max(0, a); i < end; i++) measureRow(list[i], -1);
    },
    // Publishes the measured widths and alignments to line() (staged layouts); true when they changed.
    commit() {
      if (!staged) return false;
      let changed = false;
      for (let j = 0; j < nc; j++) {
        if (widths[j] !== live[j]) { widths[j] = live[j]; changed = true; }
        if (right[j] !== liveRight[j]) { right[j] = liveRight[j]; changed = true; }
      }
      if (changed) version++;
      return changed;
    },
    // Replaces the rows with a grown set (streaming): the caller measures the added rows with measureRows(). When
    // every old row was measured, the new set counts as measured; otherwise index measuring goes on from where it
    // was (rows inserted before that point are among the added ones).
    setRows(rows, incomplete) {
      const complete = measured >= p.n;
      p.t.rows = rows;
      p.n = rows.length;
      p.t.total = Math.max(p.t.total, rows.length);
      if (incomplete !== undefined) p.t.incomplete = incomplete === 'cancelled' || incomplete === 'error' ? incomplete : null;
      measured = complete ? p.n : Math.min(measured, p.n);
    },
    lineCount: () => p.n + 4,
    // Characters in the longest line (the view's scroll width).
    maxChars() {
      maxChars = nc ? widths.reduce((s, w) => s + w, 0) + nc - 1 : 0;
      return Math.max(maxChars, footer().length);
    },
    line(i) {
      if (i === 0) return lineOf(j => heads[j]);
      if (i === 1) return widths.map(w => '-'.repeat(w)).join(' ');
      const r = i - 2;
      if (r >= 0 && r < p.n) { const row = p.t.rows[r]; return lineOf(j => disp(j, row, r)); }
      if (r === p.n) return '';
      if (r === p.n + 1) return footer();
      return '';
    },
  };
  return layout;
}

// Text writer of a measured layout (Copy as text): every line, CRLF between them, with the final widths (a staged
// layout publishes them first).
function textWriter(layout) {
  return {
    head: () => {
      layout.commit();
      return layout.line(0) + CRLF + layout.line(1);
    },
    rows(a, b) {
      let s = '';
      for (let i = a; i < b; i++) s += CRLF + layout.line(i + 2);
      return s;
    },
    tail: () => CRLF + CRLF + layout.line(layout.rowCount + 3),
  };
}

// The whole text of Results as text for a table (synchronous; Copy as text uses copyAs for large sets).
export function textView(table, fmt) {
  const layout = textLayout(table, fmt);
  layout.measure();
  return runSync(textWriter(layout), layout.rowCount, 1);
}

// --------------------------------------------------------------------------------------------- pure text API

// Text of a copy or export format for a table (synchronous): 'csv' (Copy as CSV, no BOM; {bom} for files), 'tsv'
// ({headers}), 'markdown', 'json', 'xml', 'text', 'insert', 'inlist' / 'fetchin' ({col}: a position in the view).
export function formatText(format, table, fmt, opts = {}) {
  const job = textJob(format, table, fmt, opts);
  if (job.text != null) return job.text;
  // An INSERT without a column the target table takes is no statement.
  if (job.w.st && job.w.st.kept === 0 && job.p.cols.length) throw new Error(noInsertText(job.w.st.target));
  if (job.measure) job.layout.measure();
  return runSync(job.w, job.n, job.cols);
}

// The copy format name: case-insensitive, so grid.js's 'inList' and 'fetchIn' name 'inlist' and 'fetchin'.
const formatName = f => (typeof f === 'string' ? f.toLowerCase() : '');

// A text job: the writer and its size, or the exact text of a single-cell copy.
function textJob(format, table, fmt, opts) {
  const p = prep(table, fmt);
  const nc = p.cols.length;
  const multi = p.n * nc > 1 || opts.headers === true;
  const neutral = p.f.neutralize;
  const col = () => {
    const pos = opts.col ?? 0;
    if (!Number.isInteger(pos) || pos < 0 || pos >= nc) throw new TypeError(`formatText: column position ${pos} is out of range`);
    return pos;
  };
  switch (formatName(format)) {
    case 'tsv':
      // A single-cell copy is the cell's exact text (00 §5 rule 7).
      if (!multi && p.n === 1 && nc === 1) return { p, text: textOf(p, p.cols[0], p.t.rows[0], false) ?? '', single: true };
      return { p, w: tsvWriter(p, { headers: opts.headers === true, neutral }), n: p.n, cols: nc };
    case 'csv': return { p, w: csvWriter(p, { bom: opts.bom === true, neutral }), n: p.n, cols: nc };
    case 'markdown': return { p, w: markdownWriter(p, { neutral }), n: p.n, cols: nc };
    case 'json': return { p, w: jsonWriter(p), n: p.n, cols: nc };
    case 'xml': return { p, w: xmlWriter(p), n: p.n, cols: nc };
    case 'insert': return { p, w: insertWriter(p), n: p.n, cols: nc };
    case 'inlist': return { p, w: inListWriter(p, col()), n: p.n, cols: 1, pos: opts.col ?? 0 };
    case 'fetchin': {
      const pos = col();
      const s = fetchInState(p.cols[pos].col);
      if (!s.enabled) throw new Error(s.title);
      return { p, w: fetchInWriter(p, pos), n: p.n, cols: 1, pos };
    }
    case 'text': {
      // A text view's own layout (its widths are what the view shows), measured to the end; else a new one.
      const layout = opts.layout && typeof opts.layout.line === 'function' ? opts.layout : textLayout(table, fmt);
      return { p, layout, w: textWriter(layout), n: layout.rowCount, cols: nc, measure: layout.measured < layout.rowCount };
    }
    default: throw new TypeError(`formatText: unknown format '${format}'`);
  }
}

// --------------------------------------------------------------------------------------------- XLSX

// The column letters of a 0-based column index (A, …, Z, AA, …, XFD).
export function colLetter(i) {
  let n = i + 1, s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const SHEET_BAD_RE = /[\\/?*[\]:\x00-\x1F\x7F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// s cut to at most n UTF-16 units, never inside a surrogate pair.
function cut16(s, n) {
  if (s.length <= n) return s;
  return isHigh(s.charCodeAt(n - 1)) ? s.slice(0, n - 1) : s.slice(0, n);
}

// s without leading and trailing whitespace and apostrophes (Excel refuses a sheet name that starts or ends with one).
function tidySheetName(s) {
  let t = s;
  for (let prev = null; prev !== t;) { prev = t; t = t.trim().replace(/^'+|'+$/g, ''); }
  return t;
}

// Excel sheet names for result set titles (03 §7.1): `\ / ? * [ ] :` removed, trimmed, at most 31 characters,
// 'Results' when empty, unique ignoring case with ' (2)', ' (3)', and never 'History'.
export function sheetNames(titles) {
  const used = new Set(), out = [];
  for (const title of titles) {
    // The cut can leave an apostrophe or a space at the end again, so the ends are tidied after it too.
    let base = tidySheetName(cut16(tidySheetName(String(title ?? '').replace(SHEET_BAD_RE, '')), 31));
    if (!base) base = 'Results';
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()) || name.toLowerCase() === 'history'; k++) {
      const suffix = ` (${k})`;
      name = (tidySheetName(cut16(base, 31 - suffix.length)) || 'Results') + suffix;
    }
    used.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const KIND_STYLE = Object.freeze({ number: 0, money: 4, int: 5, date: 2, datetime: 3, text: 0 });
const KINDS = new Set(Object.keys(KIND_STYLE));
// Marks the sheets writeXlsx builds itself (tableSheet, plainSheet); anything else is a plain xlsx() sheet.
const SHEET = Symbol('sheet');
const STYLE_LINK = 6, STYLE_HEAD = 1, STYLE_DATETIME = 3, STYLE_DATE = 2;
const EXCEL_MIN_WALL = Date.UTC(1900, 2, 1);
const EXCEL_MAX_WALL = Date.UTC(10000, 0, 1);

const STYLES_XML = XML_DECL + `<styleSheet xmlns="${NS_MAIN}">`
  + '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>'
  + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
  + '<font><u/><sz val="11"/><color theme="10"/><name val="Calibri"/><family val="2"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

// <v> text of a numeric cell: the shortest round-trip text.
const numText = x => String(x === 0 ? 0 : x);

// The XLSX column kind of a visible column (03 §7.1: the style of its numeric cells).
function xlsxKind(pc) {
  switch (pc.dt) {
    case 'bit': case 'int': case 'bigint': return 'int';
    case 'decimal': case 'float': return 'number';
    case 'money': return 'money';
    case 'date': return 'date';
    case 'datetime': return pc.dateOnly ? 'date' : 'datetime';
    default: return 'text';
  }
}

// True when a link URL may go into the file: https: (or the page's own http: origin), same-origin with the page.
function linkOk(url) {
  if (typeof url !== 'string' || url.length > 2079) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  const here = globalThis.location && typeof globalThis.location.origin === 'string' ? globalThis.location.origin : null;
  if (here) return u.origin === here && (u.protocol === 'https:' || u.protocol === 'http:');
  return u.protocol === 'https:';
}

// The record URL of a formatCell result with a record link: its title's last line is '<table> · <id>' (03 §1.1).
function linkOf(r, known) {
  if (r.icon !== 'link' || typeof r.title !== 'string') return null;
  const nl = r.title.lastIndexOf('\n');
  const m = /^([a-z0-9_]+) · ([0-9A-Fa-f-]{36})$/.exec(nl < 0 ? r.title : r.title.slice(nl + 1));
  return m ? util.recordUrl(m[1], m[2], known ? { known } : undefined) : null;
}

// A text cell value, cut at Excel's 32,767-character limit.
function xlText(st, s) {
  if (s.length <= XLSX_MAX_TEXT) return s;
  st.cut++;
  return cutUnits(s, XLSX_MAX_TEXT);
}

// Wall-clock text 'yyyy-MM-dd HH:mm:ss' (date-only: 'yyyy-MM-dd') of wall milliseconds, for dates Excel cannot show.
function wallText(w, dateOnly) {
  const d = new Date(w);
  const p2 = x => String(x).padStart(2, '0');
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const day = `${y}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  return dateOnly ? day : `${day} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

// The XLSX cell of a date/time value: an Excel serial number in the display tz (date: its UTC date; datetimeoffset:
// its own wall-clock time), or text before 1900-03-01 (03 §7.1).
function xlDate(p, pc, v, dt, t, st, own) {
  if (!validDate(v)) return xlText(st, 'Invalid date');
  const wall = dt === 'date' ? v.getTime() : t.dto ? wallMs(v, null) : wallMs(v, p.f.tz);
  const dateOnly = dt === 'date' || pc.dateOnly;
  if (wall < EXCEL_MIN_WALL || wall >= EXCEL_MAX_WALL) return xlText(st, wallText(wall, dateOnly));
  const serial = wall / 86400000 + 25569;
  // A date in a column of another kind carries its own style.
  return own ? { v: serial, s: dateOnly ? STYLE_DATE : STYLE_DATETIME } : serial;
}

// The XLSX cell of a number (03 §7.1): numeric, or text when Excel would drop digits (more than 15 significant).
function xlNumber(p, pc, row, v, dt, t, st, direct) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return xlText(st, String(v));
    if ((dt === 'int' || dt === 'bigint') && Number.isInteger(v)) {
      if (Number.isSafeInteger(v) && sigDigits(String(v)) <= 15) return v;
      st.big++;
      return xlText(st, direct ? intDigits(p, pc, row, st) : String(BigInt(v)));
    }
    if (dt === 'decimal' || dt === 'money') {
      const s = jsonValue(v, t, null);
      if (sigDigits(s) > 15) { st.big++; return xlText(st, s); }
    }
    return v;
  }
  if (typeof v === 'bigint') {
    const s = v.toString();
    if (sigDigits(s) > 15) { st.big++; return xlText(st, s); }
    return Number(v);
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && direct && (dt === 'int' || dt === 'bigint')) {
    const s = intDigits(p, pc, row, st);
    if (/^-?\d+$/.test(s)) { st.big++; return xlText(st, s); }
  }
  return xlText(st, cellOf(p, pc, row).text);
}

// The XLSX cell of one visible cell: null (no <c>), a number (the column's style), a string (inline string) or
// {v, s} (a number with its own style); a record link of a Friendly lookup or ref cell goes to urls[j].
function xlCell(p, pc, row, st, urls, j) {
  urls[j] = null;
  const raw = row[pc.idx];
  if (raw == null) return null;
  let v = raw, dt = pc.dt, t = pc.type;
  const base = variantValue(raw);
  if (base !== raw) {
    t = variantType(raw);
    dt = DT_NAMES.has(t.dt) ? t.dt : 'any';
    v = base;
    if (v == null) return null;
  }
  const direct = base === raw;
  const fr = p.f.friendly;
  switch (dt) {
    case 'bit': {
      if (fr && direct) {
        const r = cellOf(p, pc, row);
        if (r.text !== '1' && r.text !== '0') return xlText(st, r.text);
      }
      if (isBitValue(v)) { const b = bitOn(v) ? 1 : 0; return direct ? b : { v: b, s: 0 }; }
      break;
    }
    case 'int': case 'bigint': case 'decimal': case 'money': case 'float': {
      if (fr && direct && dt === 'int') {
        // Friendly choices are their label text (03 §7.1); option values without a label stay numbers.
        const r = cellOf(p, pc, row);
        if (r.cls !== 'num') return xlText(st, r.text);
      }
      const x = xlNumber(p, pc, row, v, dt, t, st, direct);
      return direct || typeof x !== 'number' ? x : { v: x, s: 0 };
    }
    case 'date': case 'datetime':
      if (v instanceof Date) return xlDate(p, pc, v, dt, t, st, !direct || (pc.dt !== 'date' && pc.dt !== 'datetime'));
      break;
    case 'guid': {
      if (typeof v !== 'string' || !direct) break;
      if (!fr) return xlText(st, v);
      const r = cellOf(p, pc, row);
      urls[j] = linkOf(r, p.f.known);
      return xlText(st, r.text);
    }
    case 'any':
      if (typeof v === 'number' && Number.isFinite(v)) return xlNumber(p, pc, row, v, 'float', ANY_T, st, false);
      if (typeof v === 'bigint') return xlNumber(p, pc, row, v, 'bigint', ANY_T, st, false);
      if (v instanceof Date) return xlDate(p, pc, v, 'datetime', DT2_7, st, true);
      break;
  }
  return xlText(st, cellOf(p, pc, row).text);
}

// The estimated width (px) of a column without a grid width: its header and its first 200 values (8-80 characters).
function estWidth(p, pc) {
  let n = pc.name.length;
  const m = Math.min(p.n, 200);
  for (let i = 0; i < m && n < 80; i++) {
    const row = p.t.rows[i];
    if (row[pc.idx] != null) n = Math.max(n, cellOf(p, pc, row).text.length);
  }
  return (n + 2) * 7;
}

// The XLSX sheet of an ExportTable (03 §7.1): typed cells, Friendly record links, notes counters.
function tableSheet(p, name) {
  const st = { big: 0, cut: 0, approx: 0 };
  const columns = p.cols.map(pc => ({ name: pc.name, kind: xlsxKind(pc), widthPx: pc.widthPx ?? estWidth(p, pc) }));
  const cells = new Array(p.cols.length), urls = new Array(p.cols.length).fill(null);
  return {
    [SHEET]: true, name, columns, count: p.n, st,
    rowAt(i) {
      const row = p.t.rows[i];
      for (let j = 0; j < cells.length; j++) {
        if (outside(p, i, j)) { cells[j] = null; urls[j] = null; } else cells[j] = xlCell(p, p.cols[j], row, st, urls, j);
      }
      return cells;
    },
    // Valid for the row rowAt() returned last.
    linkAt: (i, j) => urls[j],
  };
}

const HEX2 = Array.from({ length: 256 }, (_, b) => b.toString(16).toUpperCase().padStart(2, '0'));
// Bytes of a binary value shown in a cell: '0x' and 16,383 bytes are one unit more than Excel's 32,767 characters.
const XLSX_MAX_BYTES = (XLSX_MAX_TEXT - 1) / 2;

// The '0x' hex text of bytes, at most one character beyond Excel's cell limit (xlText cuts and counts it).
function hexText(b) {
  const n = Math.min(b.length, XLSX_MAX_BYTES);
  let s = '0x';
  for (let i = 0; i < n; i++) s += HEX2[b[i]];
  return s;
}

const PLAIN_STYLES = new Set([0, 1, 2, 3, 4, 5, 6]);

// The XLSX cell of a Date in a plain sheet: a 'date' column takes its UTC calendar date (an engine
// date value), any other its wall-clock time in tz (its own offset when it has `tzo`); before 1900-03-01 it is text.
function plainDate(v, kind, tz, st) {
  if (!validDate(v)) return xlText(st, 'Invalid date');
  const dateOnly = kind === 'date';
  const wall = dateOnly ? Math.floor(v.getTime() / 86400000) * 86400000 : wallMs(v, tz);
  if (wall < EXCEL_MIN_WALL || wall >= EXCEL_MAX_WALL) return xlText(st, wallText(wall, dateOnly));
  const serial = wall / 86400000 + 25569;
  return dateOnly || kind === 'datetime' ? serial : { v: serial, s: STYLE_DATETIME };
}

// The XLSX cell of one value of a plain sheet, by its JS type and the column kind; TypeError for a
// value that has no cell form, so nothing is dropped without a trace.
function plainCell(v, kind, tz, st, i, j) {
  if (v == null) return null;
  switch (typeof v) {
    case 'number':
      if (!Number.isFinite(v)) return xlText(st, String(v));
      // Excel keeps 15 significant digits: an integer it cannot hold exactly is its digits (03 §7.1).
      if (kind === 'int' && Number.isInteger(v) && (!Number.isSafeInteger(v) || sigDigits(String(v)) > 15)) {
        st.big++;
        return xlText(st, BigInt(v).toString());
      }
      return v;
    case 'bigint': {
      const s = v.toString();
      if (sigDigits(s) > 15) { st.big++; return xlText(st, s); }
      return Number(v);
    }
    case 'boolean': return v ? 1 : 0;
    case 'string': return xlText(st, v);
    case 'object':
      if (v instanceof Date) return plainDate(v, kind, tz, st);
      if (v instanceof Uint8Array) return xlText(st, hexText(v));
      if (!Array.isArray(v) && typeof v.v === 'number' && Number.isFinite(v.v) && (v.s === undefined || PLAIN_STYLES.has(v.s))) return v;
      break;
  }
  const what = Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;
  throw new TypeError(`xlsx: row ${fmtInt(i + 1)}, column ${fmtInt(j + 1)} holds ${what}; a cell takes null, a number, a string, a boolean, `
    + 'a bigint, a Date, a Uint8Array or {v, s} (a finite number and a style 0-6).');
}

// The internal sheet of a plain xlsx() sheet ({name, columns, rows, links: [{row, col, url}]}); its values are
// converted by plainCell as the sheet is written (dates in tz).
function plainSheet(s, tz) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.columns) || !Array.isArray(s.rows)) {
    throw new TypeError('xlsx: every sheet needs columns and rows arrays');
  }
  const { rows } = s;
  for (let i = 0; i < rows.length; i++) if (!Array.isArray(rows[i])) throw new TypeError(`xlsx: row ${fmtInt(i + 1)} must be an array`);
  const nc = s.columns.length;
  const links = new Map();
  if (Array.isArray(s.links)) for (const l of s.links) if (l && Number.isInteger(l.row) && Number.isInteger(l.col)) links.set(l.row * nc + l.col, l.url);
  const columns = s.columns.map(c => ({ name: String(c && c.name != null ? c.name : ''), kind: KINDS.has(c && c.kind) ? c.kind : 'text', widthPx: c && c.widthPx }));
  const st = { big: 0, cut: 0, approx: 0 };
  const cells = new Array(nc);
  return {
    [SHEET]: true, name: s.name, count: rows.length, st, columns,
    rowAt(i) {
      const row = rows[i];
      for (let j = 0; j < nc; j++) cells[j] = plainCell(row[j], columns[j].kind, tz, st, i, j);
      return cells;
    },
    linkAt: (i, j) => links.get(i * nc + j) ?? null,
  };
}

// Throws when a sheet exceeds Excel's row or column limit (before anything is written).
function checkSheet(rows, cols) {
  if (rows > XLSX_MAX_ROWS) {
    throw new Error(`This result has ${fmtInt(rows)} rows; an Excel sheet holds at most ${fmtInt(XLSX_MAX_ROWS)} rows below its header. Filter the results or export CSV.`);
  }
  if (cols > XLSX_MAX_COLS) {
    throw new Error(`This result has ${fmtInt(cols)} columns; an Excel sheet holds at most ${fmtInt(XLSX_MAX_COLS)}. Hide columns or export CSV.`);
  }
}

// The width attribute of a column: grid px / 7, clamped to 8-80 characters (03 §7.1).
const colWidth = px => {
  const w = Number.isFinite(px) && px > 0 ? px / 7 : 8;
  return Math.round(Math.min(80, Math.max(8, w)) * 100) / 100;
};

// The parts of one worksheet, generated in chunks of 2,000 rows (03 §7.1); links are collected as they are written.
async function* sheetXml(sh, index, run, done, out) {
  const nc = sh.columns.length, nr = sh.count;
  const letters = sh.columns.map((_, j) => colLetter(j));
  const styles = sh.columns.map(c => { const s = KIND_STYLE[c.kind] ?? 0; return s ? ` s="${s}"` : ''; });
  const last = nc ? `${letters[nc - 1]}${nr + 1}` : null;
  let s = XML_DECL + `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + `<dimension ref="${last ? 'A1:' + last : 'A1'}"/>`
    + `<sheetViews><sheetView workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ''}>`
    + (nc ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : '')
    + '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>';
  if (nc) s += '<cols>' + sh.columns.map((c, j) => `<col min="${j + 1}" max="${j + 1}" width="${colWidth(c.widthPx)}" customWidth="1"/>`).join('') + '</cols>';
  s += '<sheetData>';
  if (nc) s += '<row r="1">' + sh.columns.map((c, j) => `<c r="${letters[j]}1" s="${STYLE_HEAD}" t="inlineStr"><is><t xml:space="preserve">${xlsxText(cutUnits(c.name, XLSX_MAX_TEXT))}</t></is></c>`).join('') + '</row>';
  yield s;
  const links = out.links;
  for (let a = 0; a < nr; a += 2000) {
    const b = Math.min(nr, a + 2000);
    let chunk = '';
    for (let i = a; i < b; i++) {
      const cells = sh.rowAt(i);
      const r = i + 2;
      let line = `<row r="${r}">`;
      for (let j = 0; j < nc; j++) {
        const v = cells[j];
        if (v == null) continue;
        const ref = letters[j] + r;
        if (typeof v === 'number' && Number.isFinite(v)) line += `<c r="${ref}"${styles[j]}><v>${numText(v)}</v></c>`;
        else if (typeof v === 'string') {
          const url = sh.linkAt(i, j);
          let st = '';
          if (url != null && linkOk(url)) {
            if (links.length < XLSX_MAX_LINKS) { links.push({ ref, url }); st = ` s="${STYLE_LINK}"`; }
            else out.dropped++;
          }
          line += `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xlsxText(v)}</t></is></c>`;
        } else if (typeof v === 'object' && typeof v.v === 'number' && Number.isFinite(v.v)) {
          line += `<c r="${ref}"${v.s ? ` s="${v.s}"` : ''}><v>${numText(v.v)}</v></c>`;
        } else {
          // Only NULL writes no cell (03 §7.1); the sheet builders never hand anything else over.
          throw new TypeError(`xlsx: cell ${ref} has no cell form`);
        }
      }
      chunk += line + '</row>';
      if ((i & 63) === 63) await run.tick(done.rows + i + 1);
    }
    yield chunk;
  }
  done.rows += nr;
  s = '</sheetData>';
  if (nc) s += `<autoFilter ref="A1:${last}"/>`;
  if (links.length) s += '<hyperlinks>' + links.map((l, k) => `<hyperlink ref="${l.ref}" r:id="rId${k + 1}"/>`).join('') + '</hyperlinks>';
  yield s + '</worksheet>';
}

// The relationships part of a sheet with links (targets are the record URLs, External).
function sheetRels(links) {
  return XML_DECL + `<Relationships xmlns="${NS_PKG}">`
    + links.map((l, k) => `<Relationship Id="rId${k + 1}" Type="${NS_REL}/hyperlink" Target="${xmlEsc(l.url, 'attr')}" TargetMode="External"/>`).join('')
    + '</Relationships>';
}

// The workbook part: one <sheet> per sheet and the autoFilter names Excel writes.
function workbookXml(names, sheets) {
  let s = XML_DECL + `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>`;
  names.forEach((n, i) => { s += `<sheet name="${xmlEsc(n, 'attr')}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`; });
  s += '</sheets>';
  let dn = '';
  sheets.forEach((sh, i) => {
    const nc = sh.columns.length;
    if (!nc) return;
    const ref = `'${names[i].replace(/'/g, "''")}'!$A$1:$${colLetter(nc - 1)}$${sh.count + 1}`;
    dn += `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlEsc(ref, 'text')}</definedName>`;
  });
  if (dn) s += `<definedNames>${dn}</definedNames>`;
  return s + '</workbook>';
}

// Writes an XLSX workbook; returns {blob, sheets: [{name, links, dropped, st}]} (the notes of 03 §7.1).
async function writeXlsx(input, opts = {}) {
  const tz = opts.tz && typeof opts.tz === 'object' && (opts.tz.utc === true || typeof opts.tz.offset === 'function') ? opts.tz : UTC_TZ;
  const sheets = input.map(s => (s && s[SHEET] === true ? s : plainSheet(s, tz)));
  if (!sheets.length) throw new TypeError('xlsx: at least one sheet is required');
  for (const sh of sheets) checkSheet(sh.count, sh.columns.length);
  const names = sheetNames(sheets.map(s => s.name));
  const total = sheets.reduce((n, s) => n + s.count, 0);
  const run = opts.run ?? slicer({ ...opts, total });
  const done = { rows: 0 };
  const outs = sheets.map(() => ({ links: [], dropped: 0 }));
  const n = sheets.length;
  const ct = XML_DECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>';
  const rels = XML_DECL + `<Relationships xmlns="${NS_PKG}">`
    + `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>`
    + `<Relationship Id="rId2" Type="${NS_REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const app = XML_DECL + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
    + '<Application>SQL Studio</Application></Properties>';
  const wbRels = XML_DECL + `<Relationships xmlns="${NS_PKG}">`
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${n + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`;
  const entries = [
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: rels },
    { name: 'docProps/app.xml', data: app },
    { name: 'xl/workbook.xml', data: workbookXml(names, sheets) },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
  ];
  sheets.forEach((sh, i) => {
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: () => sheetXml(sh, i, run, done, outs[i]) });
    // The rels part exists only for a sheet with links; it is known once the sheet is written.
    entries.push({ name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: () => sheetRels(outs[i].links), skip: () => !outs[i].links.length });
  });
  const blob = await zip(entries, { ...opts, run, type: XLSX_MIME });
  return { blob, sheets: sheets.map((sh, i) => ({ name: names[i], links: outs[i].links.length, dropped: outs[i].dropped, st: sh.st })) };
}

// An XLSX workbook (03 §7.1): sheets = [{name, columns: [{name, kind, widthPx}], rows, links: [{row, col, url}]}],
// rows holding null (no cell), numbers, strings, booleans, bigints, Dates, Uint8Arrays or {v, s};
// opts {now, tz /* dates and the zip time */, signal, onProgress, yieldToUi}.
export async function xlsx(sheets, opts) {
  if (!Array.isArray(sheets)) throw new TypeError('xlsx: sheets must be an array');
  return (await writeXlsx(sheets, opts)).blob;
}

// --------------------------------------------------------------------------------------------- zip

let crcTable = null;

// CRC-32 (IEEE 802.3, table-driven) of bytes, continuing from crc.
export function crc32(bytes, crc = 0) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = ~crc;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// DOS date and time of an instant in a time zone (zip headers; 1980-01-01 00:00 at the earliest).
export function dosDateTime(ms, tz) {
  const off = tz && !tz.utc && typeof tz.offset === 'function' ? tz.offset(ms) : 0;
  const d = new Date(ms + off * 60000);
  const y = d.getUTCFullYear();
  if (!(y >= 1980)) return { date: (1 << 5) | 1, time: 0 };
  if (y > 2107) return { date: (127 << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 };
  return {
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

const MAX32 = 0xffffffff;
const tooBig = () => new Error(XLSX_TOO_BIG);

// Chunks of an entry's data: a string or bytes, an (async) iterable of them, or a function returning either.
async function* chunksOf(data) {
  const d = typeof data === 'function' ? data() : data;
  if (typeof d === 'string' || d instanceof Uint8Array) { yield d; return; }
  if (d && (typeof d[Symbol.asyncIterator] === 'function' || typeof d[Symbol.iterator] === 'function')) {
    for await (const c of d) yield c;
    return;
  }
  throw new TypeError('zip: entry data must be a string, bytes or an iterable of them');
}

// The deflate-raw stream of one entry: compressed chunks, CRC-32 and sizes of the uncompressed bytes.
async function deflateEntry(data, run, enc, max) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter(), reader = cs.readable.getReader();
  const out = [];
  let csize = 0, crc = 0, usize = 0;
  // Read while writing, so the compressor never stalls on a full queue (ReadableStream iteration is Chromium 124+).
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      out.push(value);
      csize += value.length;
    }
  })();
  pump.catch(() => {});
  try {
    for await (const chunk of chunksOf(data)) {
      const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
      if (!(bytes instanceof Uint8Array)) throw new TypeError('zip: entry data must be a string, bytes or an iterable of them');
      if (!bytes.length) continue;
      crc = crc32(bytes, crc);
      usize += bytes.length;
      if (usize > max) throw tooBig();
      await writer.write(bytes);
      run.check();
    }
    await writer.close();
    await pump;
  } catch (e) {
    try { await writer.abort(e); } catch { /* the stream already failed; e is reported */ }
    try { await reader.cancel(e); } catch { /* idem */ }
    throw e;
  }
  if (csize > max) throw tooBig();
  return { out, csize, crc, usize };
}

// A ZIP archive (03 §7.1): every entry deflated with CompressionStream('deflate-raw') (method 8), its local header
// written after its data with the real CRC and sizes (no data descriptor), UTF-8 names (flag bit 11), the export time
// as DOS date/time, no ZIP64 (over 4 GiB stops with XLSX_TOO_BIG). entries = [{name, data, skip?}]; opts = {now, tz,
// signal, onProgress, yieldToUi, type, limit /* a lower byte limit than 4 GiB */}.
export async function zip(entries, opts = {}) {
  const run = opts.run ?? slicer(opts);
  const max = Number.isInteger(opts.limit) && opts.limit > 0 && opts.limit < MAX32 ? opts.limit : MAX32;
  const enc = new TextEncoder();
  const { date, time } = dosDateTime(Number.isFinite(opts.now) ? opts.now : Date.now(), opts.tz);
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    run.check();
    if (typeof e.skip === 'function' && e.skip()) continue;
    const name = enc.encode(String(e.name));
    if (name.length > 0xffff) throw new TypeError('zip: entry name too long');
    const { out, csize, crc, usize } = await deflateEntry(e.data, run, enc, max);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 8, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, csize, true);
    lv.setUint32(22, usize, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    if (offset + local.length + csize > max) throw tooBig();
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, csize, true);
    cv.setUint32(24, usize, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, ...out);
    central.push(cd);
    offset += local.length + csize;
  }
  if (central.length > 0xffff) throw new TypeError('zip: too many entries');
  let cdSize = 0;
  for (const c of central) { parts.push(c); cdSize += c.length; }
  if (offset + cdSize > max) throw tooBig();
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  parts.push(end);
  return new Blob(parts, { type: opts.type ?? 'application/zip' });
}

// --------------------------------------------------------------------------------------------- toasts

const plural = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;

// 'Exported 1,234 of 50,000 rows (filtered) as CSV.' and its incomplete forms (03 §7, §7.1).
export function exportedText(tables, label) {
  const list = (Array.isArray(tables) ? tables : [tables]).map(exportTable);
  if (list.length === 1) {
    const t = list[0];
    const n = t.rows.length, inc = !!t.incomplete;
    if (t.filtered) return `Exported ${fmtInt(n)} of ${plural(t.total, 'row', 'rows')} (filtered${inc ? ', incomplete' : ''}) as ${label}.`;
    return `Exported ${plural(n, 'row', 'rows')}${inc ? ' (incomplete)' : ''} as ${label}.`;
  }
  const rows = list.reduce((s, t) => s + t.rows.length, 0);
  const inc = list.filter(t => t.incomplete).length;
  return `Exported ${fmtInt(list.length)} result sets (${plural(rows, 'row', 'rows')}) as ${label}.`
    + (inc ? ` ${inc === 1 ? '1 result set is' : `${fmtInt(inc)} result sets are`} incomplete.` : '');
}

// The notes an export or copy adds to its toast, and whether one of them means data was cut or replaced.
function notesOf({ big = 0, cut = 0, approx = 0, dropped = 0, ill = 0 } = {}) {
  const notes = [];
  if (big) notes.push(big === 1 ? '1 number with more than 15 digits was written as text so Excel keeps every digit.'
    : `${fmtInt(big)} numbers with more than 15 digits were written as text so Excel keeps every digit.`);
  if (cut) notes.push(cut === 1 ? '1 cell was cut to Excel\'s limit of 32,767 characters.'
    : `${fmtInt(cut)} cells were cut to Excel's limit of 32,767 characters.`);
  if (dropped) notes.push(`Only the first ${fmtInt(XLSX_MAX_LINKS)} lookups of a sheet are links (Excel's limit).`);
  if (approx) notes.push(approx === 1 ? '1 number beyond ±2^53 was rounded when it was read; its last digits may differ from the stored value.'
    : `${fmtInt(approx)} numbers beyond ±2^53 were rounded when they were read; their last digits may differ from the stored values.`);
  if (ill) notes.push(ill === 1 ? '1 value held an unpaired surrogate character, written as U+FFFD.'
    : `${fmtInt(ill)} values held unpaired surrogate characters, written as U+FFFD.`);
  return { notes, warn: !!(cut || ill || approx) };
}

const COPY_LABEL = Object.freeze({ csv: 'CSV', json: 'JSON', tsv: 'TSV', text: 'text' });

// The toast of a finished copy (03 §7.1).
function copiedText(job, t) {
  const n = t.rows.length, inc = t.incomplete ? ' (incomplete)' : '';
  switch (job.format) {
    case 'markdown': return `Copied ${plural(n, 'row', 'rows')}${inc} as a Markdown table.`;
    case 'insert': {
      const k = Math.ceil(n / 1000);
      return `Copied ${plural(k, 'INSERT statement', 'INSERT statements')} for ${plural(n, 'row', 'rows')}${inc}.${leftOutText(job.w.st)}`;
    }
    case 'inlist': {
      const { values, nulls } = job.w.st;
      return `Copied ${plural(values, 'value', 'values')}${inc}.`
        + (nulls ? ` ${nulls === 1 ? '1 NULL value was' : `${fmtInt(nulls)} NULL values were`} skipped (IN cannot match NULL).` : '');
    }
    case 'fetchin': {
      const { values, nulls } = job.w.st;
      const joined = joinedTable(job.p.cols[job.pos], t.source);
      return `Copied an in condition with ${plural(values, 'value', 'values')}${inc}.`
        + (nulls ? ` ${nulls === 1 ? '1 NULL value was' : `${fmtInt(nulls)} NULL values were`} skipped (FetchXML in cannot match NULL).` : '')
        + (joined ? ` Paste it inside the link-entity for ${joined}.` : '');
    }
    default:
      if (job.single) return `Copied 1 cell${inc}.`;
      return `Copied ${plural(n, 'row', 'rows')}${inc} as ${COPY_LABEL[job.format]}.`;
  }
}

// True for the per-column copies (IN list, FetchXML in condition), which count values instead of rows.
const columnJob = job => job.format === 'inlist' || job.format === 'fetchin';

// The title of export and copy-all items while a set streams (03 §7 Streaming).
export const STREAMING_TITLE = 'Available when all rows have loaded';
// The title of a per-column copy of cells in several columns.
export const ONE_COLUMN_TITLE = 'Select the cells of one column.';
const COPY_FORMATS = new Set(['tsv', 'csv', 'markdown', 'json', 'xml', 'text', 'insert', 'inlist', 'fetchin']);

// The state of an Export ▾, header-menu or context-menu item for a table (03 §7, §7.1): null when it is enabled,
// else {disabled: true, title}. format: a copyAs or exportFile format; opts = {col /* the column position for
// 'inlist' / 'fetchin'; without it the table must have exactly one visible column */, streaming /* true while the
// set streams: whole-view exports and copies wait for every row */}.
export function copyState(format, table, opts = {}) {
  const name = formatName(format);
  if (!COPY_FORMATS.has(name) && !FILES[name]) return { disabled: true, title: `Unknown format '${String(format)}'.` };
  if (opts.streaming === true) return { disabled: true, title: STREAMING_TITLE };
  if (name !== 'inlist' && name !== 'fetchin') return null;
  const t = exportTable(table);
  const pos = opts.col ?? (t.order.length === 1 ? 0 : -1);
  if (!Number.isInteger(pos) || pos < 0 || pos >= t.order.length) return { disabled: true, title: ONE_COLUMN_TITLE };
  if (name === 'fetchin') {
    const s = fetchInState(t.columns[t.order[pos]]);
    if (!s.enabled) return { disabled: true, title: s.title };
  }
  return null;
}

// Why a copy has nothing to copy, or null.
function emptyText(job) {
  const t = job.p.t;
  if (columnJob(job)) {
    if (!t.rows.length) return 'Nothing copied: the view has no rows.';
    return null;
  }
  if (!job.p.cols.length) return 'Nothing copied: the view has no columns.';
  if (!t.rows.length && (job.format === 'insert' || (job.format === 'tsv' && !job.headers))) return 'Nothing copied: the view has no rows.';
  if (job.format === 'insert' && !job.w.st.kept) return noInsertText(job.w.st.target);
  return null;
}

const errText = e => (e && typeof e.message === 'string' && e.message ? e.message : String(e));

// --------------------------------------------------------------------------------------------- orchestrators

// A file of one format for the tables (03 §7.1): {blob, notes, warn}.
async function buildFile(format, tables, fmt, run) {
  if (format === 'xlsx') {
    const preps = tables.map(t => prep(t, fmt));
    const names = preps.map(p => p.t.title);
    const res = await writeXlsx(preps.map((p, i) => tableSheet(p, names[i])), { run, now: run.nowMs, tz: preps[0].f.tz });
    const tot = { big: 0, cut: 0, approx: 0, dropped: 0 };
    for (const s of res.sheets) { tot.big += s.st.big; tot.cut += s.st.cut; tot.approx += s.st.approx; tot.dropped += s.dropped; }
    return { blob: res.blob, ...notesOf(tot) };
  }
  const p = prep(tables[0], fmt);
  let w;
  if (format === 'csv') w = csvWriter(p, { bom: true, neutral: p.f.neutralize });
  else if (format === 'json') w = jsonWriter(p);
  else w = xmlWriter(p);
  const parts = await runSliced(w, p.n, p.cols.length, run);
  return { blob: new Blob(parts, { type: FILES[format].mime }), ...notesOf(w.st) };
}

// File name of an export: <safeFileName(title)>-<yyyyMMdd-HHmm>.<ext> in the display time zone (03 §7.1).
export function exportFileName(title, ext, now, tz) {
  const ms = Number.isFinite(now) ? now : Date.now();
  const off = tz && !tz.utc && typeof tz.offset === 'function' ? tz.offset(ms) : 0;
  const d = new Date(ms + off * 60000);
  const p2 = x => String(x).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}`;
  return `${safeFileName(title, 'Results')}-${stamp}.${ext}`;
}

// The toast and announcement helper of an orchestrator context.
function sayer(ctx) {
  return (text, kind, extra) => {
    let t = null;
    if (typeof ctx.toast === 'function') t = ctx.toast(text, { kind, ...extra });
    if (typeof ctx.announce === 'function' && !(extra && extra.sticky)) ctx.announce(text);
    return t;
  };
}

// Exports tables as a file (Export ▾ Excel, Excel all result sets, CSV, JSON, XML; 03 §7.1), called in the click:
// the save picker opens first (util.saveFile), then the file is built, in slices behind a progress toast with Cancel
// above 100,000 cells. ctx = {fmt, toast, announce, io /* {saveFile}, default util.js */, now, yieldToUi, title}.
// Resolves {status: 'saved'|'downloaded'|'cancelled'|'failed', name, emptied?, error?}.
export function exportFile(format, input, ctx = {}) {
  const spec = FILES[format];
  if (!spec) throw new TypeError(`exportFile: unknown format '${format}'`);
  const say = sayer(ctx);
  const io = ctx.io || util;
  const fmt = ctx.fmt;
  let tables;
  try {
    tables = (Array.isArray(input) ? input : [input]).map(exportTable);
    if (!tables.length) throw new TypeError('exportFile: no result set to export');
    if (format !== 'xlsx' && tables.length !== 1) throw new TypeError(`exportFile: ${spec.label} exports one result set`);
    if (format === 'xlsx') for (const t of tables) checkSheet(t.rows.length, t.order.length);
  } catch (e) {
    say(errText(e), 'error');
    return Promise.resolve({ status: 'failed', error: e });
  }
  const f = fmtOf(fmt, tables[0].fmt);
  const nowMs = typeof ctx.now === 'function' ? ctx.now() : Date.now();
  const name = exportFileName(ctx.title ?? tables[0].title, spec.ext, nowMs, f.tz);
  const cells = tables.reduce((s, t) => s + t.rows.length * t.order.length, 0);
  let result = null, byToast = false;
  const make = async () => {
    const ac = new AbortController();
    let pct = 0, pt = null;
    const label = `Preparing ${spec.label} file…`;
    if (cells > BIG_CELLS) {
      pt = say(`${label} 0%`, 'info', { sticky: true, progress: () => pct, action: { label: 'Cancel', run: () => { byToast = true; ac.abort(); } } });
    }
    const total = tables.reduce((s, t) => s + t.rows.length, 0);
    const run = slicer({
      signal: ac.signal, yieldToUi: ctx.yieldToUi, now: ctx.clock, total,
      onProgress: x => { const v = Math.floor(x * 100); if (v !== pct) { pct = v; if (pt) pt.update(`${label} ${v}%`); } },
    });
    run.nowMs = nowMs;
    try {
      result = await buildFile(format, tables, fmt, run);
      return result.blob;
    } finally {
      if (pt) pt.dismiss();
    }
  };
  let saving;
  try { saving = io.saveFile(name, make, { types: [spec.type] }); } catch (e) { saving = Promise.reject(e); }
  return Promise.resolve(saving).then(res => {
    const status = res && res.status;
    if (status === 'saved' || status === 'downloaded') {
      const text = [exportedText(tables, spec.label), ...(result ? result.notes : [])].join(' ');
      say(text, result && result.warn ? 'warn' : 'ok');
      return { status, name, handle: res.handle };
    }
    if (byToast || res.emptied) say(`Export cancelled.${res.emptied ? ' ' + EMPTIED : ''}`, res.emptied ? 'warn' : 'info');
    return { status: 'cancelled', name, emptied: !!res.emptied };
  }, e => {
    say(errText(e) + (e && e.emptied ? ' ' + EMPTIED : ''), 'error');
    return { status: 'failed', name, error: e, emptied: !!(e && e.emptied) };
  });
}

// Copies a table in a clipboard format (03 §7.1), called in the click: 'tsv' ({headers}), 'csv', 'json', 'markdown',
// 'text' ({layout}: a measured text-view layout), 'insert', 'inlist' and 'fetchin' ({col}). Above 100,000 cells the
// text is built in slices and written with copyBlob(Promise<Blob>); otherwise with copyText. ctx as for exportFile
// (io = {copyText, copyBlob}); opts.quiet announces without a toast. Resolves {ok, text?, empty?, error?}.
export function copyAs(format, input, ctx = {}, opts = {}) {
  const sayAll = sayer(ctx);
  const say = (text, kind, extra) => (opts.quiet && kind !== 'error'
    ? (typeof ctx.announce === 'function' ? ctx.announce(text) : null) : sayAll(text, kind, extra));
  const io = ctx.io || util;
  let job;
  try {
    job = textJob(format, input, ctx.fmt, opts);
    job.format = formatName(format);
    job.headers = opts.headers === true;
    const empty = emptyText(job);
    if (empty) { say(empty, 'info'); return Promise.resolve({ ok: false, empty: true }); }
  } catch (e) {
    say(errText(e), 'error');
    return Promise.resolve({ ok: false, error: e });
  }
  const t = job.p.t;
  const finish = (ok, text) => {
    if (!ok) { say(COPY_FAILED, 'error'); return { ok: false }; }
    if (columnJob(job) && !job.w.st.values) {
      say('Nothing copied: the column has only NULL values.', 'info');
      return { ok: false, empty: true };
    }
    say(copiedText(job, t), 'ok');
    return { ok: true, text };
  };
  const cells = columnJob(job) ? t.rows.length : t.rows.length * job.p.cols.length;
  if (job.text == null && cells > BIG_CELLS) {
    const ac = new AbortController();
    let pct = 0;
    const label = `Copying ${plural(t.rows.length, 'row', 'rows')}…`;
    const pt = say(`${label} 0%`, 'info', { sticky: true, progress: () => pct, action: { label: 'Cancel', run: () => ac.abort() } });
    const run = slicer({
      signal: ac.signal, yieldToUi: ctx.yieldToUi, now: ctx.clock, total: job.n,
      onProgress: x => { const v = Math.floor(x * 100); if (v !== pct) { pct = v; if (pt) pt.update(`${label} ${v}%`); } },
    });
    const built = (async () => {
      if (job.measure) {
        const step = measureStep(job.layout.columnCount);
        for (let a = job.layout.measured; a < job.layout.rowCount; a = job.layout.measure(a, a + step)) await run.tick(a);
      }
      const parts = await runSliced(job.w, job.n, job.cols, run);
      if (columnJob(job) && !job.w.st.values) throw Object.assign(new Error('empty'), { emptyCopy: true });
      return new Blob(parts, { type: 'text/plain' });
    })();
    built.catch(() => {});
    let writing;
    try { writing = io.copyBlob(built, 'text/plain'); } catch { writing = Promise.resolve(false); }
    return Promise.all([Promise.resolve(writing), built.then(() => null, e => e)]).then(([ok, err]) => {
      if (pt) pt.dismiss();
      if (err) {
        if (err.emptyCopy) { say('Nothing copied: the column has only NULL values.', 'info'); return { ok: false, empty: true }; }
        if (err.name === 'AbortError') { say('Copy cancelled.', 'info'); return { ok: false, cancelled: true }; }
        say(errText(err), 'error');
        return { ok: false, error: err };
      }
      return finish(ok);
    });
  }
  let text;
  try {
    if (job.measure) job.layout.measure();
    text = job.text != null ? job.text : runSync(job.w, job.n, job.cols);
  } catch (e) {
    say(errText(e), 'error');
    return Promise.resolve({ ok: false, error: e });
  }
  if (columnJob(job) && !job.w.st.values) {
    say('Nothing copied: the column has only NULL values.', 'info');
    return Promise.resolve({ ok: false, empty: true });
  }
  let writing;
  try { writing = io.copyText(text); } catch { writing = Promise.resolve(false); }
  return Promise.resolve(writing).then(ok => finish(ok, text), () => finish(false));
}

// --------------------------------------------------------------------------------------------- text view (DOM)

// The text view's rules (results prefix .rs-tx; results.js appends them to its CSS).
export const TEXT_CSS = `.rs-tx{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;background:var(--bg1)}
.rs-tx>.rs-tx-note{margin:8px 12px 0;flex:none}
.rs-tx-sc{position:relative;flex:1;min-width:0;min-height:0;overflow:auto;background:var(--bg1);color:var(--fg1);font-family:var(--ed-font-family);font-size:var(--rs-tx-fs,13px);line-height:var(--rs-tx-lh,20px);font-variant-ligatures:none;font-kerning:none}
.rs-tx-sc:focus{outline:none}
.rs-tx-sc:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.rs-tx-sz{position:relative;min-width:100%}
.rs-tx-pre{position:absolute;left:0;top:0;margin:0;padding:0 12px;border:0;background:none;color:inherit;font:inherit;white-space:pre;tab-size:1;cursor:text;user-select:text}
.rs-tx-pre::selection{background:var(--ed-sel);color:inherit}
.rs-tx-sc:not(:focus-within) .rs-tx-pre::selection{background:var(--ed-sel-blur)}
.rs-tx-sc.all .rs-tx-pre{background:var(--ed-sel)}
@media (forced-colors:active){.rs-tx-sc:focus-visible{outline-color:Highlight}.rs-tx-sc.all .rs-tx-pre{background:Highlight;color:HighlightText}}
`;

const LINE_PAD = 8;           // px above the first line and below the last
const WINDOW = 60;            // lines rendered above and below the visible ones (03 §13)
const MAX_PX = 15000000;      // tallest scroll height used (Chromium layout sizes saturate near 2^25 px)
const RELAYOUT_MS = 500;      // re-layout interval while measuring or streaming (03 §7)
const PROGRESS_MS = 300;      // measuring longer than this shows progress (03 §13)
const HOLD_MS = 250;          // re-check interval of a held selection that postpones re-formatted lines
const HOLD_LINES = 3000;      // lines kept around a held mouse selection before the window trims again
const HOLD_CHARS = 2000000;   // characters kept around a held mouse selection before the window trims again
// Keys of the rendered lines that show no row: the header and dash lines, the empty line, the row count.
const HEAD_KEY = Symbol('head'), BLANK_KEY = Symbol('blank'), FOOT_KEY = Symbol('foot');

// Font size (px) of the text view: settings.gridFontSize, 11-16, default 13 (03 §8.1).
const fontPx = v => (Number.isInteger(v) && v >= 11 && v <= 16 ? v : 13);

// True in dev builds (__DEV__: dist/sql-studio.dev.js); production builds fold it to false.
const isDev = () => typeof __DEV__ !== 'undefined' && !!__DEV__;

// The Results-as-text view (03 §7): a monospaced, virtualised view of a table that renders the visible lines
// ± 60, measures widths in slices and copies every line on Mod+A then Mod+C. opts = {table, fmt,
// fontSize, mac, streaming, ctx /* copyAs context: toast, announce, io */, now, later(fn, ms) -> cancel, frame(fn) ->
// cancel, yieldToUi, getSelection, ResizeObserver}.
export function createTextView(host, opts = {}) {
  const env = {
    now: typeof opts.now === 'function' ? opts.now : defaultNow,
    later: typeof opts.later === 'function' ? opts.later : (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); },
    frame: typeof opts.frame === 'function' ? opts.frame
      : typeof globalThis.requestAnimationFrame === 'function'
        ? fn => { const id = requestAnimationFrame(fn); return () => cancelAnimationFrame(id); }
        : fn => { const id = setTimeout(fn, 16); return () => clearTimeout(id); },
    yieldToUi: typeof opts.yieldToUi === 'function' ? opts.yieldToUi : yieldToUi,
  };
  const ctx = opts.ctx || {};
  const say = sayer(ctx);
  const mac = typeof opts.mac === 'boolean' ? opts.mac : isMacPlatform();
  const copyKey = keyLabel('gridCopy', mac).split(', ')[0] || 'Ctrl+C';
  const doc = globalThis.document;
  let fmt = opts.fmt;
  let layout = textLayout(opts.table, fmt, { staged: true });
  let streaming = opts.streaming === true;
  let fontSize = fontPx(opts.fontSize), lineH = fontSize + 7;
  // Rows that arrived while streaming and are not measured yet: the update batches, read from pendAt / pendOff.
  let pending = [], pendAt = 0, pendOff = 0;
  // The rendered lines [rFirst, rLast) of rLayout: one text node per line, with the row (or line kind) and the layout
  // version it was formatted from, and the characters they hold.
  let nodes = [], keys = [], vers = [], rFirst = 0, rLast = 0, rChars = 0, rLayout = null;
  let sizeH = '', sizeW = '', shift = '';
  let token = 0, idle = Promise.resolve(), relayoutCancel = null, frameCancel = null, holdCancel = null, lastLayout = -Infinity;
  let allSelected = false, destroyed = false, pointerHeld = false, docListening = false, cssChecked = false;

  const note = h('div', { class: 'note info rs-tx-note', hidden: true }, icon('info', 16), h('span', { text: TEXT_CUT_NOTE }));
  const fill = h('div');
  const bar = h('div', { class: 'progress off', role: 'progressbar', 'aria-label': 'Laying out the text', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-hidden': 'true' }, fill);
  const pre = h('pre', { class: 'rs-tx-pre' });
  const sizer = h('div', { class: 'rs-tx-sz' }, pre);
  const sc = h('div', {
    class: 'rs-tx-sc', tabIndex: 0, role: 'region', 'aria-label': 'Results as text',
    onscroll: () => schedulePaint(), onkeydown: onKey, onpointerdown: onPointerDown, onpointerup: release, onpointercancel: release,
  }, sizer);
  const root = h('div', { class: 'rs-tx' }, note, bar, sc);
  applyFont();
  host.appendChild(root);
  // A resized pane (maximised results, splitter, window) shows more lines: paint them (03 §13).
  const RO = typeof opts.ResizeObserver === 'function' ? opts.ResizeObserver
    : typeof globalThis.ResizeObserver === 'function' ? globalThis.ResizeObserver : null;
  const ro = RO ? new RO(() => schedulePaint()) : null;
  if (ro) ro.observe(sc);

  function applyFont() {
    sc.style.setProperty('--rs-tx-fs', fontSize + 'px');
    sc.style.setProperty('--rs-tx-lh', lineH + 'px');
  }
  function setProgress(fr) {
    if (fr == null) {
      bar.classList.add('off');
      bar.setAttribute('aria-hidden', 'true');
      bar.removeAttribute('aria-valuenow');
      fill.style.setProperty('width', '0');
      return;
    }
    const v = Math.max(2, Math.min(100, Math.round(fr * 100)));
    bar.classList.remove('off');
    bar.removeAttribute('aria-hidden');
    bar.setAttribute('aria-valuenow', String(v));
    fill.style.setProperty('width', v + '%');
  }

  // ------------------------------------------------------------------- mouse selection

  // The selection of the view's tree: the shadow root's getSelection() (Chromium), else the document's.
  function selectionOf() {
    if (typeof opts.getSelection === 'function') return opts.getSelection();
    const r = typeof sc.getRootNode === 'function' ? sc.getRootNode() : null;
    if (r && typeof r.getSelection === 'function') return r.getSelection();
    return typeof globalThis.getSelection === 'function' ? globalThis.getSelection() : null;
  }
  const inPre = n => !!n && (n === pre || pre.contains(n));
  // While the primary button is down on the text, or a non-collapsed selection starts or ends in it: the
  // selection's anchor and focus nodes in the text ({a, f}, null when outside it), whose text must not change;
  // otherwise null.
  function holdState() {
    let sel = null;
    try { sel = selectionOf(); } catch { sel = null; }
    const has = !!sel && sel.rangeCount > 0;
    const a = has && inPre(sel.anchorNode) ? sel.anchorNode : null;
    const f = has && inPre(sel.focusNode) ? sel.focusNode : null;
    if (pointerHeld) return { a, f };
    return has && !sel.isCollapsed && (a || f) ? { a, f } : null;
  }
  function listenDoc(on) {
    if (!doc || typeof doc.addEventListener !== 'function' || docListening === on) return;
    docListening = on;
    const f = on ? 'addEventListener' : 'removeEventListener';
    doc[f]('pointerup', release, true);
    doc[f]('pointercancel', release, true);
  }
  function onPointerDown(e) {
    selectAll(false);
    // Only the primary button on the text starts a text selection (not the scrollbar, which belongs to sc).
    if (!e || (typeof e.button === 'number' && e.button !== 0) || !inPre(e.target)) return;
    pointerHeld = true;
    // The button may be let go outside the view (a drag that selects past its edge).
    listenDoc(true);
  }
  function release() {
    listenDoc(false);
    if (!pointerHeld) return;
    pointerHeld = false;
    schedulePaint();
  }

  // ------------------------------------------------------------------- rendered lines

  // The row (or line kind) line i shows.
  function keyAt(i) {
    if (i < 2) return HEAD_KEY;
    const r = i - 2, n = layout.rowCount;
    return r < n ? layout.table.rows[r] : r === n ? BLANK_KEY : FOOT_KEY;
  }
  // The text of line i: every line but the first starts with its line break, so a line's text never depends on
  // which line is the last (the set grows while it streams) and the rendered lines never run together.
  const textAt = i => (i > 0 ? '\n' + layout.line(i) : layout.line(i));
  // True when node k shows line i as the layout has it now (the row count is compared by its text).
  function current(k, i) {
    const key = keyAt(i);
    if (keys[k] !== key) return false;
    if (key === BLANK_KEY) return true;
    if (key === FOOT_KEY) return nodes[k].data === textAt(i);
    return vers[k] === layout.version;
  }
  function lineNode(i) {
    const s = textAt(i);
    rChars += s.length;
    return doc.createTextNode(s);
  }
  function append() {
    const i = rLast++;
    const node = lineNode(i);
    pre.appendChild(node);
    nodes.push(node);
    keys.push(keyAt(i));
    vers.push(layout.version);
  }
  function prepend() {
    const i = --rFirst;
    const node = lineNode(i);
    pre.insertBefore(node, pre.firstChild);
    nodes.unshift(node);
    keys.unshift(keyAt(i));
    vers.unshift(layout.version);
  }
  function dropFront() {
    const node = nodes.shift();
    keys.shift();
    vers.shift();
    rChars -= node.data.length;
    node.remove();
    rFirst++;
  }
  function dropBack() {
    const node = nodes.pop();
    keys.pop();
    vers.pop();
    rChars -= node.data.length;
    node.remove();
    rLast--;
  }
  // Formats node k again for line i; the node itself stays (03 §7 mouse selection).
  function refresh(k, i) {
    const s = textAt(i), node = nodes[k];
    if (node.data !== s) {
      rChars += s.length - node.data.length;
      node.data = s;
    }
    keys[k] = keyAt(i);
    vers[k] = layout.version;
  }
  // Starts over with no rendered line, at line `at`.
  function clear(at) {
    pre.textContent = '';
    nodes = [];
    keys = [];
    vers = [];
    rFirst = rLast = at;
    rChars = 0;
    rLayout = layout;
  }
  // Dev builds: the view's layout rules come from TEXT_CSS, which results.js must add.
  function checkCss() {
    if (cssChecked || !isDev() || sc.isConnected !== true || typeof globalThis.getComputedStyle !== 'function') return;
    cssChecked = true;
    if (globalThis.getComputedStyle(pre).position === 'absolute') return;
    const err = new Error('export.js createTextView: TEXT_CSS is not in the page\'s styles (results.js appends export.TEXT_CSS to its CSS); the text view cannot lay out its lines.');
    if (typeof globalThis.reportError === 'function') globalThis.reportError(err);
    else queueMicrotask(() => { throw err; });
  }

  // Renders the visible lines ± WINDOW: the visible lines at once, then the margins and the lines whose row or widths
  // changed within the slice budget, continued on the next frame (03 §13). A held mouse selection keeps every
  // rendered node and the text of its anchor and focus nodes.
  function paint() {
    frameCancel = null;
    if (destroyed) return;
    checkCss();
    const t0 = env.now();
    const n = layout.lineCount();
    const vh = sc.clientHeight > 0 ? sc.clientHeight : 600;
    const top = Math.max(0, sc.scrollTop || 0);
    const full = n * lineH;
    const usable = Math.min(full, MAX_PX);
    // Above MAX_PX a scroll offset maps proportionally onto the lines (compressed scrolling).
    const scale = full > usable && usable > vh ? (full - vh) / (usable - vh) : 1;
    const at = top * scale;
    const vFirst = Math.min(n, Math.max(0, Math.floor(at / lineH)));
    const vLast = Math.min(n, Math.max(vFirst, Math.ceil((at + vh) / lineH)));
    const wFirst = Math.max(0, vFirst - WINDOW), wLast = Math.min(n, vLast + WINDOW);
    const same = rLayout === layout && rLast <= n;
    // A held selection keeps every rendered line (the window only grows, as a drag scrolls it) unless that would
    // hold too much text, or the visible lines jumped away from the rendered ones.
    const hold = same && rLast > rFirst ? holdState() : null;
    const keep = hold !== null && vLast >= rFirst - WINDOW && vFirst <= rLast + WINDOW
      && Math.max(rLast, vLast) - Math.min(rFirst, vFirst) <= HOLD_LINES && rChars <= HOLD_CHARS;
    if (!same || (!keep && (vLast <= rFirst || vFirst >= rLast))) clear(vFirst);
    if (!keep) {
      while (rFirst < wFirst) dropFront();
      while (rLast > wLast) dropBack();
    }
    while (rFirst > vFirst) prepend();
    while (rLast < vLast) append();
    let more = false, stale = false;
    // The selection's own nodes keep their text until it is let go; the lines between them follow the layout.
    const pinned = k => keep && (nodes[k] === hold.a || nodes[k] === hold.f);
    for (let i = vFirst; i < vLast; i++) {
      const k = i - rFirst;
      if (current(k, i)) continue;
      if (pinned(k)) stale = true;
      else refresh(k, i);
    }
    const spent = () => env.now() - t0 >= SLICE_MS;
    while (rLast < wLast || rFirst > wFirst) {
      if (spent()) { more = true; break; }
      if (rLast < wLast) append();
      if (rFirst > wFirst) prepend();
    }
    for (let k = 0; k < nodes.length; k++) {
      const i = rFirst + k;
      if ((i >= vFirst && i < vLast) || current(k, i)) continue;
      if (pinned(k)) { stale = true; continue; }
      if (spent()) { more = true; break; }
      refresh(k, i);
    }
    if (stale && !holdCancel) holdCancel = env.later(() => { holdCancel = null; schedulePaint(); }, HOLD_MS);
    const hh = (usable + 2 * LINE_PAD) + 'px';
    if (hh !== sizeH) { sizeH = hh; sizer.style.setProperty('height', hh); }
    const ww = `calc(${layout.maxChars()}ch + 24px)`;
    if (ww !== sizeW) { sizeW = ww; sizer.style.setProperty('width', ww); }
    // A first rendered line after line 0 starts with its line break, i.e. one empty line above it.
    const tr = `translateY(${LINE_PAD + top - at + (rFirst > 0 ? rFirst - 1 : 0) * lineH}px)`;
    if (tr !== shift) { shift = tr; pre.style.setProperty('transform', tr); }
    if (more) schedulePaint();
  }
  function schedulePaint() {
    if (frameCancel || destroyed) return;
    frameCancel = env.frame(paint);
  }
  // The layout changed: publish its widths and re-render now (force), or at most every RELAYOUT_MS while measuring
  // or streaming (03 §7), painting on the next frame so a measuring slice stays within its budget.
  function relayout(force) {
    if (destroyed) return;
    const now = env.now();
    if (force || now - lastLayout >= RELAYOUT_MS) {
      if (relayoutCancel) { relayoutCancel(); relayoutCancel = null; }
      lastLayout = now;
      layout.commit();
      note.hidden = !layout.cut;
      if (!force) { schedulePaint(); return; }
      if (frameCancel) { frameCancel(); frameCancel = null; }
      paint();
      return;
    }
    if (!relayoutCancel) relayoutCancel = env.later(() => { relayoutCancel = null; relayout(true); }, RELAYOUT_MS - (now - lastLayout));
  }

  // ------------------------------------------------------------------- measuring

  const hasPending = () => pendAt < pending.length;
  // Measures up to `step` rows of the oldest streamed batch.
  function measurePending(step) {
    const list = pending[pendAt];
    const b = Math.min(list.length, pendOff + step);
    layout.measureRows(list, pendOff, b);
    pendOff = b;
    if (pendOff < list.length) return;
    pendAt++;
    pendOff = 0;
    if (pendAt >= pending.length) { pending = []; pendAt = 0; }
  }
  function dropPending() {
    pending = [];
    pendAt = 0;
    pendOff = 0;
  }
  // Measures every row not measured yet in slices of SLICE_MS (steps of about 2,048 cells), with progress after
  // PROGRESS_MS.
  function measureAll() {
    const my = ++token;
    const t0 = env.now();
    idle = (async () => {
      let shown = false;
      for (;;) {
        if (my !== token || destroyed) return;
        const s = env.now();
        const step = measureStep(layout.columnCount);
        // At least one step per slice, so measuring always advances whatever the clock does.
        while (hasPending() || layout.measured < layout.rowCount) {
          if (hasPending()) measurePending(step);
          else layout.measure(layout.measured, layout.measured + step);
          if (env.now() - s >= SLICE_MS) break;
        }
        const left = hasPending() || layout.measured < layout.rowCount;
        if (!left) break;
        if (env.now() - t0 > PROGRESS_MS) { shown = true; setProgress(layout.measured / Math.max(1, layout.rowCount)); }
        relayout(false);
        await env.yieldToUi();
      }
      if (shown) setProgress(null);
      relayout(false);
    })();
    return idle;
  }

  // ------------------------------------------------------------------- copy and keys

  function selectAll(on) {
    if (allSelected === on) return;
    allSelected = on;
    sc.classList.toggle('all', on);
  }
  // Copies every line (Copy as text): nothing while the set streams (03 §7 Streaming); the view's own layout, with
  // its final widths published, once every row is measured.
  function copyAll() {
    selectAll(false);
    if (streaming) {
      say(`${STREAMING_TITLE}.`, 'info');
      return Promise.resolve({ ok: false, streaming: true });
    }
    const ready = !hasPending() && layout.measured >= layout.rowCount;
    if (ready) relayout(true);
    return copyAs('text', layout.table, { ...ctx, fmt }, ready ? { layout } : {});
  }
  // Mod+A and Mod+C are the KEYMAP grid keys (gridSelectAll, gridCopy; matched by e.code, 03 §9), so every
  // keyboard layout and macOS's Cmd work as in the grid.
  function onKey(e) {
    if (keyMatches(e, 'gridSelectAll', mac)) {
      e.preventDefault();
      selectAll(true);
      if (typeof ctx.announce === 'function') ctx.announce(`All lines selected. Press ${copyKey} to copy them.`);
      return;
    }
    if (allSelected && keyMatches(e, 'gridCopy', mac)) {
      e.preventDefault();
      copyAll();
      return;
    }
    if (!isModifierOnly(e)) selectAll(false);
  }

  measureAll();
  relayout(true);

  return {
    el: root,
    scroller: sc,
    // Changes the table, options or font: {table, fmt, fontSize, added /* rows that arrived while streaming; with
    // them the table keeps its columns and order and only grows */, incomplete, streaming}.
    update(next = {}) {
      if (destroyed) return idle;
      let force = false;
      if (next.fontSize !== undefined && fontPx(next.fontSize) !== fontSize) {
        fontSize = fontPx(next.fontSize);
        lineH = fontSize + 7;
        applyFont();
        force = true;
      }
      if (next.fmt !== undefined) fmt = next.fmt;
      const added = next.table && Array.isArray(next.added) && next.fmt === undefined ? next.added : null;
      if (next.table) {
        const t = exportTable(next.table);
        if (added) {
          // A copy of the batch, appended without spreading it (a batch can hold any number of rows).
          if (added.length) pending.push(added.slice());
          layout.setRows(t.rows, t.incomplete);
        } else {
          dropPending();
          layout = textLayout(t, fmt, { staged: true });
          force = true;
        }
      } else if (next.fmt !== undefined) {
        dropPending();
        layout = textLayout(layout.table, fmt, { staged: true });
        force = true;
      } else if (next.incomplete !== undefined) {
        layout.setRows(layout.table.rows, next.incomplete);
        force = true;
      }
      if (typeof next.streaming === 'boolean') streaming = next.streaming;
      else if (added) streaming = true;
      else if (next.table || next.incomplete !== undefined) streaming = false;
      const p = measureAll();
      // Anything but rows that arrived while streaming re-lays out at once.
      relayout(force || !added);
      return p;
    },
    // Copies every line (Copy as text, 03 §7).
    copyAll,
    focus: () => sc.focus(),
    // Resolves when the current measuring is done.
    whenIdle: () => idle,
    layout: () => layout,
    state: () => ({
      measured: layout.measured, rows: layout.rowCount, rendered: [rFirst, rLast], cut: layout.cut, allSelected, lineH,
      streaming, held: holdState() !== null,
    }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      token++;
      if (relayoutCancel) relayoutCancel();
      if (frameCancel) frameCancel();
      if (holdCancel) holdCancel();
      if (ro) ro.disconnect();
      listenDoc(false);
      root.remove();
    },
  };
}
