// Virtual data grid (03 §7 Grid, Cells, Selection, Context menu, Streaming, §7.2 edit mode, §9, §13;
// 00 §5 rules 6, 7 and 10). Virtual rows and columns over positional row
// arrays, a sticky header and row-number column, widths, sort / quick filter / column filters on complete and
// streaming sets, selection with statistics, copy, Friendly/Raw cells through util.formatCell, column drag-reorder,
// and edit mode with Duplicate row and the change navigator, producing the change set dml.previewEdits takes
// (02 §8, §9 session.runEdits). The decisions are pure exported helpers (view state, sort, filters, selection,
// copy text, the edit model and every user-visible text); createGrid() is the thin DOM layer over them.
//
// Notes (extensions of 03 §1.4, §7 and §7.2):
// - createGrid(host, opts) -> Grid. opts beyond 03 §1.4's {columns, source, friendly, tz, dateFormat, view, onView,
//   onEdit}: rows (initial rows), complete (the set has ended), incomplete ('cancelled'|'error'|null), compact,
//   fontSize (settings.gridFontSize, 11-16), csvNeutralize (settings.csvNeutralize, default true), label (the grid's
//   aria-label and the title of its export tables, e.g. the result tab title), known ((logicalName) => boolean,
//   passed to formatCell, recordUrl and openUrl), mac, shell (the 03 §1.4 Shell: menu, contextMenu, popover, confirm,
//   toast, announce, status, onEscape, keyMatches; each is optional, and without it that feature is off), meta
//   (optionsSync/options for choice editors and labels, findEntity for the primary id name), io ({copyText, copyBlob,
//   openUrl}: default util.js, looked up per call, as dialogs.js takes them), editModel (an earlier grid's model, so
//   pending edits survive a re-created grid; setEditMode(true) shows them again), lookupName(entity, id) ->
//   string|null|Promise (optional: the primary name of a lookup target an edit set, so its Friendly cell shows the
//   name; without it the cell shows the GUID with its record link and the title '<table> · <id>'), and the callbacks
//   onCount({shown, total, loading}) (the toolbar's '12 of 1,234'), onSelection({cells, rows, cols, stats, text}) (the
//   status bar's statistics, statsText(); stats only for two or more cells), onEdit({pending, counts}) (the `edits`
//   event), onQuick(text) (the grid itself cleared the quick filter: its 'Clear filters', 'Show' and 'No rows match'
//   links clear view.quick too, so results.js empties its quick filter input; onView carries view.quick as well),
//   onReview(payload) -> Promise<{results}|void> (Review changes: results.js checks the run lock and Allow changes, runs
//   session.runEdits(payload) and either resolves with the `edits` event's results or calls grid.applyEditResults
//   itself; a rejection, e.g. the run lock, shows its message in an error toast and keeps every edit pending; a grid
//   destroyed while its review runs leaves the results to results.js, which applies them to the grid that replaced
//   it), and actions = {copyAs(format, table), copyState(format, table) -> {disabled, title}|null,
//   rowDetails({row, position, entry}), cellText(text, kind), newQuery(sql)} for the export.js copy
//   formats ('csv', 'json', 'markdown', 'inlist', 'fetchin': export.js copyAs names), the row details sheet, the cell
//   viewer and Create SELECT (results.js wires them; an item without its action is disabled). measure(text, font) and
//   size() -> {width, height} replace canvas text measurement and the scroller's client size.
// - Grid = {el, append(rows), setRows(rows), done({incomplete}), rows() (the grid's rows, written edits included),
//   currentView(), counts(), selection(), selectedPayload(), view(), setView(view), setQuick(text), clearFilters(),
//   showAllColumns(), setOptions({friendly, tz, dateFormat, compact, fontSize, csvNeutralize, label}),
//   editEligibility() -> {ok, reason}, editing(), setEditMode(on) -> Promise<boolean>, pendingCount(),
//   discardEdits(), editPayload(), applyEditResults(results), editModel(), nextChange(), prevChange(), review(),
//   copy(headers), focus(), idle() (resolves when sliced work is done), viewLength(), rowAtPosition(p) (the view row at
//   position p, pending edits applied, or null), recordOf(p, dc = 0) ({entity, id, pkName, url} of the record of the
//   row at view position p for displayed column dc's table, or null), destroy()}. viewLength / rowAtPosition /
//   recordOf serve the row details sheet's prev/next and Open record (03 §7) without rebuilding currentView().
// - Tables for export.js: currentView(), selectedPayload() and the Copy column payload are export.js ExportTables
//   ({title, columns /* the displayed Columns */, indexes /* their schema indexes */, rows /* full-schema arrays in
//   view order */, widths, total, filtered, selected(i, j) | null, friendly, tz, dateFormat, label /* the grid's
//   option-label hook */, known, neutralize, incomplete, source}), so export.js formats them exactly as the cells show.
//   In edit mode they hold the displayed (pending) values and the new rows.
// - View state (03 §2 `view`, per result set, memory only) keys columns by their schema index (the view resets on
//   re-run, so indexes are stable): widths (number|null)[] per schema index, measured (the automatic widths have been
//   measured), resized (schema indexes the user resized; automatic measurement never overrides them), order (every
//   visible schema column, hidden ones keeping their place), hidden, sort [{col, desc}], filters [{col, mode:
//   'in'|'out', keys, labels}] (keys are types.js keyOf texts of raw values; 'out' keeps every other value, also
//   values that stream in later), quick, display, chart (opaque here). onView receives a fresh copy after each change.
// - Widths: until the one measurement (the first batch with 200 rows, or the end of the set), a column is as wide as
//   its header (60-480 px), so early batches never make columns jump. A click on a resize edge without movement is
//   no resize. Column resize clamps to 32-2,000 px.
// - Sorting a label column in Friendly mode (lookups, choices, booleans, multi-select with a name companion) compares
//   the label it shows (else its value's text) with types.js cmp as a string; Raw mode and every other column compare
//   the value itself. xml values compare and filter as text (types.js cmp and keyOf refuse xml, 305). Ties keep the
//   result order (stable). An edit never moves its row; the next sort or filter change uses the edited values. A sort
//   or filter change keeps the active cell's position (a header stays a header) and clears the selection.
// - Quick filter: CI_AI substring (types.js collKeyAI, which ignores trailing spaces) of the displayed text of every
//   visible cell except NULL cells: Friendly or Raw as shown, but never cut at the 500-grapheme display limit (a cell
//   is searched up to 1,048,576 UTF-16 units, Dataverse's memo limit), and a line break (⏎ in the cell) reads as a
//   space, as does a ⏎ in the search text; exports and copies then use the same rows (00 §1 principle 1). Per data
//   row the grid memoises pass/fail for the current search text and displayed text (displayed columns as a set,
//   Friendly/Raw, tz, dateFormat, option labels): a longer search that contains the previous one re-tests only the rows
//   that passed, a shorter one only those that failed; an edit or a written result re-tests its row. The filter runs
//   in slices (03 §13) when over 50,000 rows or 250,000 cells still need testing.
// - Column filter checklists count each value with every other filter and the quick filter (through its memo) applied;
//   NULL is listed as '(NULL)' and '' as '(Empty)'. Order: values, then values whose text starts
//   with '(', then (NULL) and (Empty) (flags, never the label, mark those two); text values and Friendly labels in
//   natural order (Intl.Collator('en-US', {numeric: true, sensitivity: 'base'}), the same as
//   localeCompare), other values (numbers, dates, GUIDs) in their type's order, which is their natural order. Over
//   50,000 rows (or 250,000 quick filter cells) the values are counted in slices behind 'Loading values…'. A filter
//   key the faceted list lacks keeps the label its filter had. Exclude this value removes the value from an 'in'
//   filter (the filter keeps hiding what it hid) and adds it to an 'out' filter: excluding never shows a row.
// - Streaming: rows that arrive while a sliced quick filter (over 50,000 rows) or a one-frame sort (over 100,000
//   rows) runs are merged when it finishes, so none is lost. The top row keeps its place by a binary search of the
//   merged rows (never a reverse map of the whole view).
// - Layout: a column resize moves the rendered cells and headers (left/width) at most once per animation frame and
//   never reformats them (03 §13: 60 fps). The row-number column is at least 48 px, wide enough for the largest row
//   number and, in edit mode, for 'Deleted'. GUID and binary cells use the grid font size minus 1 px.
// - Copy (Mod+C, Copy, Copy with headers): one cell copies its exact text unchanged (no quotes, no neutralisation);
//   several cells copy TSV in the selection's layout (the union of its rows and columns, unselected cells empty), NULL
//   as an empty field, values quoted when they hold a tab, CR, LF or `"`. csvNeutralize applies export.js's rule:
//   every text cell (formatCell class '' or 'empty', so Friendly labels and lookup names too) and every header name;
//   numbers, GUIDs and binary text are written raw. A copy works on a snapshot taken in the gesture (view positions,
//   their rows, the columns and the formatting options), so a sort, filter, edit or streamed batch during it never
//   mixes views. Above 100,000 cells (also for Copy column ▸ Copy values) the text is built in slices into the Blob
//   promise of util.copyBlob (called in the gesture), with the sticky toast 'Copying…' (progress, Cancel) after 300 ms;
//   Cancel leaves the clipboard unchanged ('Copy cancelled. The clipboard was not changed.'). Toasts: 'Copied 1 cell.',
//   'Copied 37 rows.', with ' (incomplete result)' for an incomplete set and, while the set still streams,
//   ' (rows still loading)' for more than one cell.
// - Edit mode: a column without role, or with role 'value', counts as a value column. Lookups accept a GUID (braces
//   allowed) or `table:guid` (the table must be one of attr.targets); a polymorphic lookup without a table keeps the
//   row's current target. An empty input is NULL (in text columns only the empty input: white space stays text).
//   Numbers are checked against attr.minValue / maxValue, text against attr.maxLength, multi-select values against the
//   options (duplicates dropped). Choice and Boolean cells use a select of meta.optionsSync() options (plus '(NULL)'
//   for choices); arrow keys on the closed select only choose (Chromium fires 'change' for each), Enter, Tab or
//   leaving the editor commits, and a choice in the open list (pointer, Alt+Down, F4, Space) commits at once. Text
//   values (string, memo, xml; any value with a line break) edit in a <textarea> that grows to 8 lines: Enter commits,
//   Shift+Enter and Alt+Enter insert a line break; a value whose line breaks are all CR LF keeps CR LF. An editor whose
//   value is unchanged (compared with what the element held when it opened, so element normalisation never counts)
//   commits nothing, whatever closes it (Enter, Tab, a click elsewhere, scrolling the cell out of view, Review
//   changes). An edited lookup shows its target's name when opts.lookupName gives it, else the GUID with its record
//   link. Duplicate row copies every creatable column of the root table, including columns the user hid (03 §7.2:
//   'visible' is the schema's, not the view's). Rows created by Review changes are read-only until the query runs
//   again (they have no loaded versionnumber for If-Match); so is a record whose update
//   succeeded without an `etag` in its result ('Saved. Run the query again to edit this record again.'), while a
//   result `etag` (`W/"<versionnumber>"`, the WriteResult etag; dml.applyEdits may pass it on) becomes the row's
//   versionnumber and the record stays editable. A result without a message gets a tooltip by status ('Not written:
//   the record changed since you loaded it.' for skipped). New rows (Add row, Duplicate row) sit right below the row
//   they came from (Add row: at the end) and are never hidden by filters; an insert anchored to a row that is
//   filtered out moves to the end. Review changes first commits an open cell editor's valid value. While a review
//   runs (in any grid sharing the edit model: model.busy) every model change is locked: cell edits, Add / Delete /
//   Duplicate row, Discard all (discardEdits() returns false), Done (setEditMode(false) resolves false) and the change
//   list's Undo this change. The results apply to the change set of the last editPayload() (the review's payload),
//   whatever the model holds by then, and only once: done edits always reach the rows (the server has them), failures
//   and skips stay pending only while still pending. applyEditResults also works on a grid that is not in edit mode.
// - Change list (the counter's popover): every pending change, the ones in rows the filters hide last, marked
//   '(hidden by filters)'; their Go to clears the filters (as 'Show') and then goes to the change; Undo this change
//   works on any of them. Previous / Next change skip the hidden ones.
// - Change set (02 §8 previewEdits input): set and insert items are {col: attr logical name, value, entity?}, with
//   entity the target table of a lookup value; inserts are listed in creation order, and an `edits {results}` entry of
//   kind 'insert' keys the insert by its index in that list. A record id appears once even when two visible columns
//   show the same attribute (both cells follow the edit). An empty new row is a create with no values.
// - Synthetic primary keys (02 §4.2 virtual tables): source.tables[0].synthetic === true makes the whole set
//   ineligible; source.tables[0].syntheticIndex (a hidden column, truthy for a generated pk) makes those rows
//   read-only.
// - The header and cell tooltips are the grid's own `.tip` popover after 600 ms (03 §7: 600 ms, the shell tooltip
//   waits 500 ms), at most 2,000 graphemes; a binary cell's tooltip is its hex cut there, so its full-hex title
//   is never built for a tooltip.
// - Focus: when the focused cell scrolls out and its element is recycled, focus stays on the grid (the scroller, the
//   tab stop then) without scrolling back; the next arrow key or Tab into the grid brings the active cell into view.
// - Keys: the KEYMAP grid entries (gridCopy, gridCopyHeaders, gridSelectAll, gridEdit, nextChange, prevChange) are
//   matched by the grid's own keydown listeners through shell.keyMatches (else shell.js keyMatches with opts.mac), so
//   several grids never compete for one shell command; Shift+F10 / the context-menu key open the cell or header menu,
//   Enter or Space on a header sorts (Shift adds a key) and Alt+Down opens its menu, Shift+Space selects the rows and
//   Ctrl+Space the columns of the selection, an arrow key onto the row numbers selects that row and Shift+Up/Down
//   there extends the selected rows. In edit mode Enter or F2 edits, a printable key starts a text edit with it, and
//   in the editor Enter commits (and stays), Tab / Shift+Tab commit and move, Escape cancels; in a text (textarea)
//   editor Shift+Enter and Alt+Enter insert a line break.
import { h, clear, measureText, placeNear } from './dom.js';
import { icon } from './icons.js';
import {
  formatCell, fmtInt, fmtNumber, copyText as utilCopyText, copyBlob as utilCopyBlob, openUrl as utilOpenUrl, recordUrl,
  sqlStr, sqlIdent, isGuid, truncateText, yieldToUi,
} from '../core/util.js';
import { cmpKeys, sortKey, keyOf, typeName, coerce, dateParts, collKeyAI, dtOfAttr } from '../engine/types.js';
import { keyMatches as keymapMatches, keyLabel, titleFor, discardTitle, edgeScrollSpeed } from './shell.js';

// ------------------------------------------------------------------------------------------------------ constants

const NO_NAME = '(No column name)';
const UI_FONT = '"Segoe UI","Segoe UI Web (West European)",-apple-system,BlinkMacSystemFont,Roboto,"Helvetica Neue",sans-serif';
const MONO_FONT = '"Cascadia Mono",Consolas,"SF Mono",Menlo,ui-monospace,monospace';
const W_MIN = 60, W_MAX = 480;          // automatic widths (03 §7)
const RESIZE_MIN = 32, RESIZE_MAX = 2000;
const SAMPLE = 200;                     // rows measured for the automatic widths
const DRAG_START = 4;                   // px of movement before a header drag starts
const EDGE = 6;                         // px of the resize edge
const MAX_PX = 15000000;                // scroll height cap (Chromium's element limit is ~33.5M px)
const STREAM_MS = 500;                  // streaming re-apply interval
const SLICE_MS = 8;                     // long work slices (03 §13)
const BIG_QUICK = 50000, BIG_SORT = 100000, BIG_COPY = 100000, BIG_STATS = 200000;
const BIG_CELLS = 250000;               // quick filter and checklist cells (rows × displayed columns) done in one task
const QUICK_MAX = 1048576;              // UTF-16 units of a cell the quick filter searches (Dataverse's memo limit)
const PROGRESS_MS = 300;
const EDIT_LINES = 8;                   // lines a multi-line cell editor shows before it scrolls
const DUP_MAX = 500;
const TIP_MS = 600;
const TIP_MAX = 2000;                    // graphemes a tooltip shows
const FILTER_SHOWN = 300;
const ROWNUM_MIN = 48;
const UTC = Object.freeze({ utc: true, offset: () => 0 });

// Every sentence the grid shows (03 §7, §7.2).
export const TEXTS = Object.freeze({
  streaming: 'Available when all rows have loaded',
  incomplete: 'Editing needs the complete result. Run the query again to edit it.',
  notEditable: 'Only the results of one table with its primary key can be edited.',
  dupPk: 'Some records appear more than once in this result, so it cannot be edited.',
  synthetic: 'The rows of this virtual table have no primary key, so they cannot be edited.',
  noCreate: 'Rows of this table cannot be created here.',
  dupMax: `Select at most ${DUP_MAX} rows to duplicate.`,
  noRows: 'No rows',
  noMatch: 'No rows match the filters.',
  loading: 'Loading…',
  copyFail: 'Could not copy to the clipboard.',
  wrapFirst: 'Wrapped to the first change',
  wrapLast: 'Wrapped to the last change',
  noChanges: 'No pending changes',
  created: 'Run the query again to edit this new record.',
  unknown: 'Outcome unknown: check this record.',
  synthRow: 'This row has no primary key, so it cannot be edited.',
  readOnlyCell: 'This cell cannot be edited.',
  noRecord: 'This row has no record to open.',
  noReview: 'Reviewing changes is not available here.',
  reviewing: 'Reviewing changes…',
  saved: 'Saved. Run the query again to edit this record again.',
  oneColumn: 'Select the cells of one column.',
  loadingValues: 'Loading values…',
  hiddenByFilters: '(hidden by filters)',
  copying: 'Copying…',
  copyCancelled: 'Copy cancelled. The clipboard was not changed.',
});

// --------------------------------------------------------------------------------------------- column helpers

const isIdx = i => Number.isInteger(i) && i >= 0;
const NUM_DT = new Set(['int', 'bigint', 'decimal', 'money', 'float']);
const LABEL_TYPES = new Set(['Lookup', 'Customer', 'Owner', 'Picklist', 'State', 'Status', 'Boolean', 'MultiSelectPicklist']);
const CHOICE_TYPES = new Set(['Picklist', 'State', 'Status']);
const LOOKUP_TYPES = new Set(['Lookup', 'Customer', 'Owner']);
const BIN_TYPES = new Set(['Image', 'File']);
const CODE_FORMATS = new Set(['Language', 'Locale', 'TimeZone']);
const STR_T = Object.freeze({ dt: 'string', unicode: true });
const ANY_T = Object.freeze({ dt: 'any' });
const XML_COL = 'XML_F52E2B61-18A1-11d1-B105-00805F49916B';
const JSON_COL = 'JSON_F52E2B61-18A1-11d1-B105-00805F49916B';

// The static Type of a column as formatCell resolves it (03 §1.1): col.dt, a Type in col.type, the attribute's type,
// a dt name in col.type, else 'any'.
export function typeOfCol(col) {
  if (!col || typeof col !== 'object') return ANY_T;
  if (typeof col.dt === 'string') return col;
  if (col.type && typeof col.type === 'object' && typeof col.type.dt === 'string') return col.type;
  if (col.attr && typeof col.attr === 'object') { try { return dtOfAttr(col.attr); } catch { return ANY_T; } }
  if (typeof col.type === 'string') return { dt: col.type };
  return ANY_T;
}

// The static type name (dt) of a column.
export function dtOfCol(col) {
  return typeOfCol(col).dt;
}

// A column's header text: its name, or '(No column name)' for an unnamed expression (01 §6.1).
export function colLabel(col) {
  return col && col.name != null && col.name !== '' ? String(col.name) : NO_NAME;
}

// Index of the name companion whose label a Friendly cell shows (lookups, choices, booleans, multi-select), or -1.
export function labelIndex(col) {
  const c = col && col.companion;
  const i = c && isIdx(c.name) ? c.name : -1;
  if (i < 0) return -1;
  const t = col.attr && col.attr.type;
  if (t) return LABEL_TYPES.has(t) ? i : -1;
  const dt = dtOfCol(col);
  return dt === 'guid' || dt === 'bit' || dt === 'int' ? i : -1;
}

// True for numbers the selection statistics add up: numeric columns that are not choices or language/locale codes.
export function isMeasure(col) {
  if (!col || !NUM_DT.has(dtOfCol(col))) return false;
  const a = col.attr;
  if (a && (LABEL_TYPES.has(a.type) || CODE_FORMATS.has(a.format))) return false;
  return labelIndex(col) < 0;
}

// True when a column's cells align right (numbers that are not choice codes).
const isNumCol = col => NUM_DT.has(dtOfCol(col)) && labelIndex(col) < 0 && !(col.attr && CHOICE_TYPES.has(col.attr.type));

// The type sort keys and filter keys use: xml compares as text (types.js refuses xml, 305).
const keyType = col => (dtOfCol(col) === 'xml' ? STR_T : typeOfCol(col));

// Filter identity of a raw value (types.js keyOf: NULLs equal, collation equality, as GROUP BY).
export function filterKey(v, col) {
  if (dtOfCol(col) === 'xml') return v == null ? '\u0000' : 'x' + String(v);
  try { return keyOf(v, keyType(col), !!col.ci_ai); } catch { return 'z' + String(v); }
}

// The header tooltip (03 §7): 'name · Account Name · nvarchar(160) · account'; expressions show their SQL type only.
export function headerTitle(col) {
  let t;
  try { t = typeName(col); } catch { t = dtOfCol(col); }
  const a = col && col.attr;
  if (!a) return t;
  return [a.logicalName, a.displayName, t, a.entity].filter(x => x != null && x !== '').join(' · ');
}

// The cell viewer kind of a column (03 §7: xml values and FOR XML results open as 'xml'; FOR JSON as 'json').
export function viewerKind(col, text) {
  if (dtOfCol(col) === 'xml' || (col && col.name === XML_COL)) return 'xml';
  if (col && col.name === JSON_COL) return 'json';
  const s = typeof text === 'string' ? text.trim() : '';
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try { JSON.parse(s); return 'json'; } catch { /* plain text */ }
  }
  return 'text';
}

// ------------------------------------------------------------------------------------------------------ view state

const visibleIndexes = columns => columns.flatMap((c, i) => (c && !c.hidden ? [i] : []));

// The initial view of a result set (03 §2 `view`): every visible column in schema order.
export function defaultView(columns) {
  return { widths: [], measured: false, resized: [], order: visibleIndexes(columns), hidden: [], sort: [], filters: [], quick: '', display: 'table', chart: null };
}

// A validated copy of a view for these columns: unknown or hidden-schema indexes are dropped, missing columns join
// the order at its end, widths are finite and clamped, sort and filter entries are unique per column.
export function normalizeView(view, columns) {
  const base = defaultView(columns);
  if (!view || typeof view !== 'object') return base;
  const vis = new Set(base.order);
  const ok = i => Number.isInteger(i) && vis.has(i);
  const uniq = list => { const seen = new Set(); return (Array.isArray(list) ? list : []).filter(i => ok(i) && !seen.has(i) && seen.add(i)); };
  const order = uniq(view.order);
  for (const i of base.order) if (!order.includes(i)) order.push(i);
  const widths = new Array(columns.length).fill(null);
  if (Array.isArray(view.widths)) {
    view.widths.forEach((w, i) => { if (ok(i) && Number.isFinite(w) && w > 0) widths[i] = Math.round(Math.min(RESIZE_MAX, Math.max(RESIZE_MIN, w))); });
  }
  const seenS = new Set();
  const sort = (Array.isArray(view.sort) ? view.sort : []).filter(k => k && ok(k.col) && !seenS.has(k.col) && seenS.add(k.col)).map(k => ({ col: k.col, desc: !!k.desc }));
  const seenF = new Set();
  const filters = (Array.isArray(view.filters) ? view.filters : [])
    .filter(f => f && ok(f.col) && (f.mode === 'in' || f.mode === 'out') && Array.isArray(f.keys) && !seenF.has(f.col) && seenF.add(f.col))
    .map(f => {
      const keys = f.keys.map(String);
      const labels = keys.map((_, i) => String(Array.isArray(f.labels) && f.labels[i] != null ? f.labels[i] : ''));
      return { col: f.col, mode: f.mode, keys, labels };
    })
    .filter(f => f.mode === 'in' || f.keys.length);
  // At least one column stays displayed.
  const hidden = uniq(view.hidden);
  if (order.length && hidden.length >= order.length) hidden.pop();
  return {
    widths, measured: !!view.measured, resized: uniq(view.resized), order, hidden,
    sort, filters, quick: typeof view.quick === 'string' ? view.quick : '',
    display: view.display === 'text' || view.display === 'chart' ? view.display : 'table',
    chart: view.chart ?? null,
  };
}

// A deep copy of a view for onView (03 §2: per result set; the grid keeps its own).
export function copyView(v) {
  return {
    widths: v.widths.slice(), measured: v.measured, resized: v.resized.slice(), order: v.order.slice(), hidden: v.hidden.slice(),
    sort: v.sort.map(k => ({ ...k })), filters: v.filters.map(f => ({ col: f.col, mode: f.mode, keys: f.keys.slice(), labels: f.labels.slice() })),
    quick: v.quick, display: v.display, chart: v.chart,
  };
}

// Schema indexes of the displayed columns, in displayed order (03 §7: order minus hidden).
export function displayColumns(view) {
  const hid = new Set(view.hidden);
  return view.order.filter(i => !hid.has(i));
}

// view.order after moving the displayed column at position `from` to position `to` (both among displayed columns);
// hidden columns keep their place (03 §7 column drag-reorder).
export function moveColumn(view, from, to) {
  const disp = displayColumns(view);
  if (!Number.isInteger(from) || from < 0 || from >= disp.length) return view.order.slice();
  const t = Math.max(0, Math.min(disp.length - 1, Number.isInteger(to) ? to : from));
  if (t === from) return view.order.slice();
  const col = disp[from];
  const nd = disp.slice();
  nd.splice(from, 1);
  nd.splice(t, 0, col);
  const order = view.order.filter(i => i !== col);
  if (t === 0) {
    const at = order.indexOf(nd[1]);
    order.splice(at < 0 ? 0 : at, 0, col);
  } else {
    order.splice(order.indexOf(nd[t - 1]) + 1, 0, col);
  }
  return order;
}

let natColl = null;
// The checklist's natural order (localeCompare with numeric, sensitivity base), made on first use.
const natural = () => (natColl ??= new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' }));

// The drop position of a dragged column: the displayed position it lands at when released over boundary `slot`
// (0..n, the gap left of displayed column `slot`).
export function dropTarget(from, slot) {
  return slot > from ? slot - 1 : slot;
}

// The next sort after a header click (03 §7: asc → desc → none; Shift adds a key; stable).
export function cycleSort(sort, col, add) {
  const i = sort.findIndex(k => k.col === col);
  const cur = i < 0 ? null : sort[i];
  const next = !cur ? { col, desc: false } : !cur.desc ? { col, desc: true } : null;
  if (!add) {
    if (cur && sort.length === 1) return next ? [next] : [];
    return [{ col, desc: false }];
  }
  const out = sort.map(k => ({ ...k }));
  if (i < 0) out.push(next);
  else if (next) out[i] = next;
  else out.splice(i, 1);
  return out;
}

// The text of a filter pill's value: 'Active, Inactive', '3 selected', 'not Active', 'None'.
export function filterPillText(f) {
  const n = f.keys.length;
  if (f.mode === 'in') return n === 0 ? 'None' : n <= 2 ? f.labels.join(', ') : `${fmtInt(n)} selected`;
  return n <= 2 ? `not ${f.labels.join(', ')}` : `${fmtInt(n)} excluded`;
}

// 'Show 3 hidden columns' (03 §7).
export const hiddenText = n => `Show ${fmtInt(n)} hidden ${n === 1 ? 'column' : 'columns'}`;

// 'Moved “revenue” to column 3 of 12.' (03 §7; position 0-based).
export const movedText = (label, pos, count) => `Moved “${label}” to column ${fmtInt(pos + 1)} of ${fmtInt(count)}.`;

// ----------------------------------------------------------------------------------------------- sort and filter

// The value a column sorts by and its type: a Friendly label column sorts by its label text.
export function sortSpec(columns, c, friendly) {
  const col = columns[c];
  const li = friendly ? labelIndex(col) : -1;
  if (li >= 0) {
    return { type: STR_T, ai: !!col.ci_ai, get: row => { const l = row[li]; if (l != null && l !== '') return String(l); const v = row[c]; return v == null ? null : String(v); } };
  }
  return { type: keyType(col), ai: !!col.ci_ai, get: row => row[c] };
}

// Sort keys of every row for one sort column (types.js sortKey: decorate once, compare with cmpKeys).
export function sortKeys(n, rowAt, spec, from = 0, into = null) {
  const keys = into ?? new Array(n);
  for (let i = from; i < n; i++) {
    const r = rowAt(i);
    keys[i] = r ? sortKey(spec.get(r), spec.type, spec.ai) : null;
  }
  return keys;
}

// A comparator of data indexes over decorated keys: [{keys, type, ai, desc}]; ties keep index order (stable).
export function indexComparator(keyCols) {
  return (a, b) => {
    for (const k of keyCols) {
      const r = cmpKeys(k.keys[a], k.keys[b], k.type, k.ai);
      if (r) return k.desc ? -r : r;
    }
    return a - b;
  };
}

// Two index lists sorted by cmp merged into one (the streaming insertion of 03 §7).
export function mergeSorted(a, b, cmp) {
  const out = new Array(a.length + b.length);
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) out[k++] = cmp(a[i], b[j]) <= 0 ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

// Column filters compiled for testing rows: [{c, out, set, col}].
export function compileFilters(filters, columns) {
  return filters.map(f => ({ c: f.col, out: f.mode === 'out', set: new Set(f.keys), col: columns[f.col] }));
}

// True when a row passes every compiled filter except the one on column `skip`.
export function passesFilters(row, compiled, skip = -1) {
  for (const f of compiled) {
    if (f.c === skip) continue;
    const has = f.set.has(filterKey(row[f.c], f.col));
    if (f.out ? has : !has) return false;
  }
  return true;
}

const NL_ANY = /\r\n?|\n/g;

// True when formatCell shows a string value of the column as that text (its text cells: string and xml columns other
// than Friendly multi-select labels), so the quick filter can read the value without formatting it.
export function plainTextCol(col) {
  const dt = dtOfCol(col);
  if (dt !== 'string' && dt !== 'xml') return false;
  return !(col.attr && col.attr.type === 'MultiSelectPicklist' && col.role !== 'name' && col.role !== 'type');
}

// True when the displayed text of some visible, non-NULL cell contains the folded needle (CI_AI).
// fo are formatCell options; the grid passes max QUICK_MAX, so text beyond the 500-grapheme display cut is searched,
// and a line break (⏎ in the cell) reads as a space. plain (optional, aligned with cols) caches plainTextCol.
export function quickMatches(row, cols, columns, fo, needle, plain = null) {
  fo.row = row;
  for (let j = 0; j < cols.length; j++) {
    const c = cols[j];
    const v = row[c];
    if (v == null) continue;
    let t;
    if (typeof v === 'string' && (plain ? plain[j] : plainTextCol(columns[c]))) {
      if (v === '') continue;
      t = v.length > QUICK_MAX ? v.slice(0, QUICK_MAX) : v;
      if (t.includes('\n') || t.includes('\r')) t = t.replace(NL_ANY, ' ');
    } else {
      const f = formatCell(v, columns[c], fo);
      if (f.cls === 'null' || f.text === '') continue;
      t = f.text.includes('⏎') ? f.text.replaceAll('⏎', ' ') : f.text;
    }
    if (collKeyAI(t).includes(needle)) return true;
  }
  return false;
}

// The folded needle of a quick filter text ('' when there is nothing to search); ⏎ (a pasted cell text) is a space.
export function quickNeedle(q) {
  if (typeof q !== 'string' || q.trim() === '') return '';
  return collKeyAI(q.includes('⏎') ? q.replaceAll('⏎', ' ') : q);
}

// The quick filter memo after the needle changes from `from` to `to` (0 unknown, 1 passes, 2 fails): a longer needle
// that contains the old one keeps the failures, a shorter one contained in it keeps the passes, any other resets.
export function narrowQuick(states, n, from, to) {
  if (from === to) return;
  if (from && to.includes(from)) { for (let i = 0; i < n; i++) if (states[i] === 1) states[i] = 0; }
  else if (from && to && from.includes(to)) { for (let i = 0; i < n; i++) if (states[i] === 2) states[i] = 0; }
  else states.fill(0, 0, n);
}

// The automatic width of a column from its header width and its cells' text widths (03 §7: 60-480 px).
export function autoWidth(headerW, cellWs) {
  let w = headerW;
  for (const x of cellWs) if (x > w) w = x;
  return Math.round(Math.max(W_MIN, Math.min(W_MAX, w)));
}

// Scroll mapping for content taller than the browser's element limit: {phys, toVirtual(scrollTop), toPhys(v)}.
export function scrollMap(total, viewport, max = MAX_PX) {
  const phys = Math.min(total, max);
  const ratio = total > phys && phys > viewport ? (total - viewport) / (phys - viewport) : 1;
  return { phys, ratio, toVirtual: s => s * ratio, toPhys: v => v / ratio };
}

// The displayed columns [c0, c1] (inclusive) that intersect [left, left + width) over prefix sums xs (n + 1 values).
export function colRange(xs, left, width) {
  const n = xs.length - 1;
  if (n <= 0 || width <= 0) return [0, -1];
  let lo = 0, hi = n - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (xs[m] <= left) lo = m; else hi = m - 1; }
  const c0 = lo;
  const right = left + width;
  let c1 = c0;
  while (c1 < n - 1 && xs[c1 + 1] < right) c1++;
  return [c0, c1];
}

// The displayed column at data-area x (0 = the left edge of the first column), clamped to the columns.
export function colAt(xs, x) {
  const n = xs.length - 1;
  if (n <= 0) return -1;
  if (x <= 0) return 0;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (xs[m] <= x) lo = m; else hi = m - 1; }
  return lo;
}

// The boundary slot (0..n) nearest to data-area x: the gap a dragged column is dropped into.
export function slotAt(xs, x) {
  const n = xs.length - 1;
  if (n <= 0) return 0;
  const c = colAt(xs, x);
  return x < (xs[c] + xs[c + 1]) / 2 ? c : c + 1;
}

// ------------------------------------------------------------------------------------------------------- selection

// A normalised rectangle {r0, r1, c0, c1} (inclusive) from two corners.
export function normRange(a, b) {
  return { r0: Math.min(a.row, b.row), r1: Math.max(a.row, b.row), c0: Math.min(a.col, b.col), c1: Math.max(a.col, b.col) };
}

// True when (r, c) is in one of the ranges.
export function inRanges(ranges, r, c) {
  for (const g of ranges) if (r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1) return true;
  return false;
}

// Merged [a, b] intervals of a list of intervals.
function mergeSpans(spans) {
  const s = spans.slice().sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// The selected rows as merged spans [[r0, r1], …] and the selected columns (positions, ascending).
export function selectionLayout(ranges) {
  const rows = mergeSpans(ranges.map(g => [g.r0, g.r1]));
  const cols = [];
  for (const [a, b] of mergeSpans(ranges.map(g => [g.c0, g.c1]))) for (let c = a; c <= b; c++) cols.push(c);
  let nRows = 0;
  for (const [a, b] of rows) nRows += b - a + 1;
  return { rows, cols, nRows };
}

// The number of selected cells (overlapping ranges counted once).
export function selectionCount(ranges) {
  if (!ranges.length) return 0;
  if (ranges.length === 1) { const g = ranges[0]; return (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1); }
  // Split the rows at every range edge; within a band the same ranges apply.
  const edges = [...new Set(ranges.flatMap(g => [g.r0, g.r1 + 1]))].sort((a, b) => a - b);
  let n = 0;
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i], b = edges[i + 1];
    const spans = ranges.filter(g => g.r0 <= a && g.r1 >= b - 1).map(g => [g.c0, g.c1]);
    let w = 0;
    for (const [x, y] of mergeSpans(spans)) w += y - x + 1;
    n += w * (b - a);
  }
  return n;
}

// Running selection statistics (03 §7: Count / Sum / Avg / Min / Max of the numeric selected cells, Excel-like).
export function newStats() {
  return { count: 0, num: 0, sum: 0, comp: 0, min: Infinity, max: -Infinity };
}

// Adds one cell value to the statistics (count: non-NULL cells; the rest: numbers of measure columns; Neumaier sum).
export function addStat(st, v, measure) {
  if (v == null) return;
  st.count++;
  if (!measure) return;
  const x = typeof v === 'bigint' ? Number(v) : v;
  if (typeof x !== 'number' || !Number.isFinite(x)) return;
  st.num++;
  const t = st.sum + x;
  st.comp += Math.abs(st.sum) >= Math.abs(x) ? st.sum - t + x : x - t + st.sum;
  st.sum = t;
  if (x < st.min) st.min = x;
  if (x > st.max) st.max = x;
}

// The finished statistics: {count, num, sum, avg, min, max} (numbers null without numeric cells).
export function finishStats(st) {
  const sum = st.num ? st.sum + st.comp : null;
  return { count: st.count, num: st.num, sum, avg: st.num ? sum / st.num : null, min: st.num ? st.min : null, max: st.num ? st.max : null };
}

// The status-bar text of selection statistics: 'Count 12 · Sum 1,234 · Avg 102.83 · Min 1 · Max 400'.
export function statsText(s) {
  if (!s) return '';
  const head = `Count ${fmtInt(s.count)}`;
  if (!s.num) return head;
  return `${head} · Sum ${fmtNumber(s.sum)} · Avg ${fmtNumber(s.avg)} · Min ${fmtNumber(s.min)} · Max ${fmtNumber(s.max)}`;
}

// ------------------------------------------------------------------------------------------------------ copy text

const NEUTRAL_RE = /^[=+\-@\t\r\n＝＋－＠]/;

// 00 §5 rule 7: text that a spreadsheet would read as a formula gets a leading `'`.
export function neutralize(s) {
  return NEUTRAL_RE.test(s) ? "'" + s : s;
}

// A TSV field (03 §7.1): quoted with doubled quotes when it holds a tab, CR, LF or `"`.
export function tsvField(s) {
  return /[\t\r\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// True when a cell's text is neutralised in multi-cell copies: a text cell (formatCell class '' or 'empty'), the
// export.js rule, so Friendly labels and lookup names are covered too; numbers, GUIDs, binary and NULL never are.
export function needsNeutral(cls) {
  return cls === '' || cls === 'empty';
}

// One TSV line from cells [{text|null, col, cls}] (null = an empty field), with neutralisation when `neutral`.
export function tsvLine(cells, neutral) {
  let out = '';
  for (let i = 0; i < cells.length; i++) {
    if (i) out += '\t';
    const c = cells[i];
    if (!c || c.text == null) continue;
    out += tsvField(neutral && needsNeutral(c.cls) ? neutralize(c.text) : c.text);
  }
  return out;
}

// The header line of a multi-cell copy (names neutralised like text cells).
export function tsvHeader(cols, neutral) {
  return cols.map(col => tsvField(neutral ? neutralize(colLabel(col)) : colLabel(col))).join('\t');
}

// The copy toast: 'Copied 1 cell.', 'Copied 37 rows.' (+ ' (incomplete result)', or while the set
// still streams ' (rows still loading)' for more than one cell).
export function copiedText(nRows, nCells, incomplete, loading = false) {
  const t = nCells === 1 ? 'Copied 1 cell' : `Copied ${fmtInt(nRows)} ${nRows === 1 ? 'row' : 'rows'}`;
  return t + (incomplete ? ' (incomplete result).' : loading && nCells !== 1 ? ' (rows still loading).' : '.');
}

// ------------------------------------------------------------------------------------------------------ edit model

// Why a column cannot be edited in loaded rows of the root table (03 §7.2), or null when it can.
export function readOnlyReason(col, root) {
  const a = col && col.attr;
  if (!a) return 'Read-only: the query computes this column.';
  if (!root || a.entity !== root.entity || (col.qual ?? null) !== (root.qual ?? null)) return 'Read-only: this column comes from another table.';
  if (col.role != null && col.role !== 'value') return 'Read-only: name and type columns follow their lookup or choice.';
  if (a.isPk) return 'Read-only: the primary key cannot be changed.';
  if (BIN_TYPES.has(a.type) || dtOfCol(col) === 'binary') return 'Read-only: images and files cannot be edited here.';
  if (!a.validForUpdate) return 'Read-only: Dataverse does not allow updating this column.';
  return null;
}

// True when new rows (Add row, Duplicate row) may set the column: a visible value column of the root table that is
// valid for create, never the primary key or a binary column (03 §7.2).
export function canCreate(col, root) {
  const a = col && col.attr;
  if (!a || col.hidden || !root || a.entity !== root.entity || (col.qual ?? null) !== (root.qual ?? null)) return false;
  if (col.role != null && col.role !== 'value') return false;
  return !!a.validForCreate && !a.isPk && !BIN_TYPES.has(a.type) && dtOfCol(col) !== 'binary';
}

// Exact value identity of 02 §8.1 step 5 (never collation): NULL equals only NULL, dates by instant and ticks, GUIDs
// ignoring case, bytes by content, numbers exactly.
export function sameValue(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime() && (a.tk || 0) === (b.tk || 0);
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (typeof a === 'string' && typeof b === 'string') return a === b || (isGuid(a) && isGuid(b) && a.toLowerCase() === b.toLowerCase());
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    try { return BigInt(a) === BigInt(b); } catch { return false; }
  }
  return a === b;
}

const normId = id => (typeof id === 'string' ? id.toLowerCase() : id == null ? null : String(id).toLowerCase());

// The pending edits of one result set, keyed by primary key (03 §7.2): updates, deletes and new rows, their failure
// notes, and the change set and result handling of 02 §8 previewEdits / §9 runEdits. Pure: no DOM.
export function createEditModel(columns, source) {
  const root = source && Array.isArray(source.tables) && source.tables.length ? source.tables[0] : null;
  const pkIndex = root && isIdx(root.pkIndex) ? root.pkIndex : -1;
  const etagIndex = root && isIdx(root.etagIndex) ? root.etagIndex : -1;
  const synthIndex = root && isIdx(root.syntheticIndex) ? root.syntheticIndex : -1;
  const entity = root ? root.entity ?? null : null;
  const attrOf = new Map();      // schema index -> attr logical name (root value columns)
  const colsOf = new Map();      // attr logical name -> schema indexes showing it
  const reasons = new Map();     // visible schema index -> read-only reason
  const updatable = new Set(), creatable = new Set();
  columns.forEach((col, i) => {
    if (!col) return;
    const a = col.attr;
    if (a && root && a.entity === root.entity && (col.qual ?? null) === (root.qual ?? null) && (col.role == null || col.role === 'value')) {
      attrOf.set(i, a.logicalName);
      const list = colsOf.get(a.logicalName);
      if (list) list.push(i); else colsOf.set(a.logicalName, [i]);
    }
    if (col.hidden) return;
    const r = readOnlyReason(col, root);
    if (r) reasons.set(i, r); else updatable.add(i);
    if (canCreate(col, root)) creatable.add(i);
  });
  const updates = new Map();     // id -> {cells: Map<attr, value>, targets: Map<attr, entity>}
  const deletes = new Set();     // ids
  const inserts = [];            // {key, anchor: 'd:<id>'|'i:<key>'|'', cells, targets}
  const notes = new Map();       // 'u:<id>'|'d:<id>'|'i:<key>' -> {status, message}
  const fixed = new Map();       // id -> why the row is read-only (created by a review, unknown outcome)
  let seq = 0;
  let sent = null;               // the change set of the last payload(): {updates: Map, deletes: Set, inserts: []}
  const byKey = k => inserts.find(it => it.key === k) ?? null;
  const etagOf = row => (row && etagIndex >= 0 ? row[etagIndex] ?? null : null);
  const item = (col, value, targets) => (targets.has(col) ? { col, value, entity: targets.get(col) } : { col, value });

  const m = {
    root, pkIndex, etagIndex, entity,
    // True while a grid's Review changes runs: every grid sharing this model locks its edits.
    busy: false,
    updatable: i => updatable.has(i),
    creatable: i => creatable.has(i),
    reason: i => reasons.get(i) ?? null,
    attrOf: i => attrOf.get(i) ?? null,
    colsOf: n => colsOf.get(n) ?? [],
    canCreateAny: () => creatable.size > 0,
    rowId: row => (row && pkIndex >= 0 ? normId(row[pkIndex]) : null),
    isSynthetic: row => synthIndex >= 0 && !!(row && row[synthIndex]),
    update: id => updates.get(id) ?? null,
    isDeleted: id => deletes.has(id),
    insert: byKey,
    inserts: () => inserts,
    note: key => notes.get(key) ?? null,
    fixed: id => fixed.get(id) ?? null,
    fixRow(id, reason) { fixed.set(id, reason); },
    hasUpdates: () => updates.size > 0,
    // Ids of the loaded records with a pending update or delete.
    ids() { const s = new Set(updates.keys()); for (const id of deletes) s.add(id); return s; },

    // Sets one attribute of a loaded record ({id}) or a new row ({ins: key}); an update back to the loaded value
    // (and lookup target) drops that cell. original = {value, entity} as loaded.
    setCell(target, attr, value, original = { value: null, entity: null }, ent = null) {
      if (target.ins != null) {
        const it = byKey(target.ins);
        if (!it) return false;
        if (value == null) { it.cells.delete(attr); it.targets.delete(attr); }
        else { it.cells.set(attr, value); if (ent) it.targets.set(attr, ent); else it.targets.delete(attr); }
        notes.delete('i:' + it.key);
        return true;
      }
      const id = normId(target.id);
      if (id == null) return false;
      let rec = updates.get(id);
      notes.delete('u:' + id);
      const same = sameValue(value, original.value) && (value == null || ent == null || original.entity == null || ent === original.entity);
      if (same) {
        if (rec) { rec.cells.delete(attr); rec.targets.delete(attr); if (!rec.cells.size) updates.delete(id); }
        return true;
      }
      if (!rec) updates.set(id, rec = { cells: new Map(), targets: new Map() });
      rec.cells.set(attr, value);
      if (ent) rec.targets.set(attr, ent); else rec.targets.delete(attr);
      return true;
    },

    // Toggles the delete mark of a loaded record; returns true when it is now deleted.
    toggleDelete(id) {
      const k = normId(id);
      notes.delete('d:' + k);
      if (deletes.has(k)) { deletes.delete(k); return false; }
      deletes.add(k);
      return true;
    },

    // Adds a new row below `anchor` ('d:<id>', 'i:<key>' or '' for the end); returns its key.
    addInsert(anchor = '', cells = new Map(), targets = new Map()) {
      const key = seq++;
      inserts.push({ key, anchor: anchor || '', cells: new Map(cells), targets: new Map(targets) });
      return key;
    },

    // Removes a new row; rows anchored to it move to its own anchor.
    removeInsert(key) {
      const i = inserts.findIndex(it => it.key === key);
      if (i < 0) return false;
      const [it] = inserts.splice(i, 1);
      for (const o of inserts) if (o.anchor === 'i:' + key) o.anchor = it.anchor;
      notes.delete('i:' + key);
      return true;
    },

    // Undoes one change of the navigator: {kind: 'update'|'delete', id} or {kind: 'insert', key}; never while busy.
    undo(ch) {
      if (m.busy) return false;
      if (ch.kind === 'insert') return m.removeInsert(ch.key);
      const id = normId(ch.id);
      if (ch.kind === 'delete') { notes.delete('d:' + id); return deletes.delete(id); }
      notes.delete('u:' + id);
      return updates.delete(id);
    },

    // Drops every pending edit.
    discardAll() { updates.clear(); deletes.clear(); inserts.length = 0; notes.clear(); },

    // Pending changes by kind; total = changed rows (03 §7.2: updated rows + deleted + new).
    counts() {
      let updated = 0;
      for (const id of updates.keys()) if (!deletes.has(id)) updated++;
      return { updated, deleted: deletes.size, created: inserts.length, total: updated + deletes.size + inserts.length };
    },

    // The 02 §8 previewEdits input; rowOf(id) gives the loaded row (its versionnumber is the etag). The change set is
    // kept: applyResults applies the results of this payload to it, whatever the model holds by then.
    payload(rowOf) {
      const ups = [], dels = [], ins = [];
      const snap = { updates: new Map(), deletes: new Set(), inserts: [] };
      for (const [id, rec] of updates) {
        if (deletes.has(id) || !rec.cells.size) continue;
        ups.push({ id, etag: etagOf(rowOf(id)), set: [...rec.cells].map(([col, value]) => item(col, value, rec.targets)) });
        snap.updates.set(id, { cells: new Map(rec.cells), targets: new Map(rec.targets) });
      }
      for (const id of deletes) { dels.push({ id, etag: etagOf(rowOf(id)) }); snap.deletes.add(id); }
      for (const it of inserts) {
        ins.push([...it.cells].map(([col, value]) => item(col, value, it.targets)));
        snap.inserts.push({ key: it.key, cells: new Map(it.cells), targets: new Map(it.targets), anchor: it.anchor });
      }
      sent = snap;
      return { entity, updates: ups, deletes: dels, inserts: ins };
    },

    // Applies the `edits {results}` of runEdits (02 §9) to the change set of the last payload(): done edits are
    // cleared (and reach the rows even when they were undone meanwhile), unknown ones are not kept pending, the rest
    // stay with their message. The change set is then forgotten, so results never apply twice. Returns what the grid
    // must change in its rows.
    applyResults(results) {
      const out = { updated: [], deleted: [], created: [], unknown: { updates: [], deletes: [], inserts: [] }, kept: 0, remap: new Map() };
      const isDone = r => r.status === 'done' || (r.status == null && r.ok === true);
      const noteOf = r => ({ status: r.status ?? 'failed', message: r.message != null && String(r.message) !== '' ? String(r.message) : FAIL_TEXT[r.status] ?? FAIL_TEXT.failed });
      const snap = sent ?? { updates: new Map(), deletes: new Set(), inserts: [] };
      for (const r of Array.isArray(results) ? results : []) {
        if (!r || typeof r !== 'object') continue;
        if (r.kind === 'update' || r.kind === 'delete') {
          const id = normId(r.key);
          const upd = r.kind === 'update';
          const wrote = upd ? snap.updates.get(id) ?? null : snap.deletes.has(id);
          const pending = upd ? updates.has(id) : deletes.has(id);
          if (!wrote && !pending) continue;
          const nk = (upd ? 'u:' : 'd:') + id;
          if (isDone(r)) {
            notes.delete(nk);
            if (upd) {
              const w = wrote || updates.get(id);
              const cur = updates.get(id);
              // Cells changed again after the payload stay pending against the written value.
              if (cur) {
                for (const [attr, v] of w.cells) {
                  if (cur.cells.has(attr) && sameValue(cur.cells.get(attr), v) && (cur.targets.get(attr) ?? null) === (w.targets.get(attr) ?? null)) { cur.cells.delete(attr); cur.targets.delete(attr); }
                }
                if (!cur.cells.size) updates.delete(id);
              }
              out.updated.push({ id, cells: w.cells, targets: w.targets, etag: typeof r.etag === 'string' ? r.etag : null });
            } else { deletes.delete(id); updates.delete(id); out.deleted.push(id); }
          } else if (r.status === 'unknown') {
            if (upd) updates.delete(id); else deletes.delete(id);
            notes.set(nk, { status: 'unknown', message: TEXTS.unknown });
            fixed.set(id, TEXTS.unknown);
            out.unknown[upd ? 'updates' : 'deletes'].push(id);
          } else if (pending) {
            notes.set(nk, noteOf(r));
            out.kept++;
          }
        } else if (r.kind === 'insert') {
          const s = Number.isInteger(r.key) ? snap.inserts[r.key] : undefined;
          if (!s) continue;
          const key = s.key;
          const it = byKey(key);
          if (isDone(r) || r.status === 'unknown') {
            if (it) inserts.splice(inserts.indexOf(it), 1);
            notes.delete('i:' + key);
            const newId = isDone(r) && r.newId != null ? normId(r.newId) : null;
            const anchorOf = it ? it.anchor : s.anchor;
            const rec = { key, newId, cells: s.cells, targets: s.targets, anchor: anchorOf };
            // Rows below this one (new rows and rows created in this review) now follow its record, or its anchor.
            const to = newId ? 'd:' + newId : anchorOf;
            out.remap.set('i:' + key, to);
            for (const o of inserts) if (o.anchor === 'i:' + key) o.anchor = to;
            if (isDone(r)) out.created.push(rec); else out.unknown.inserts.push(rec);
          } else if (it) {
            notes.set('i:' + key, noteOf(r));
            out.kept++;
          }
        }
      }
      sent = null;
      // A chain of created rows (a duplicate of a duplicate) resolves to the final anchor.
      for (const [k, v] of out.remap) { let t = v, n = 0; while (out.remap.has(t) && n++ < out.remap.size) t = out.remap.get(t); out.remap.set(k, t); }
      return out;
    },
  };
  return m;
}

// The versionnumber after a successful update from its write's etag (`W/"<n>"`), in the JS type of the loaded value,
// or undefined when the result carries none.
export function nextVersion(old, etag) {
  const m = typeof etag === 'string' ? /^(?:W\/)?"(\d{1,20})"$/.exec(etag.trim()) : null;
  if (!m) return undefined;
  const d = m[1].replace(/^0+(?=\d)/, '');
  if (typeof old === 'bigint') return BigInt(d);
  if (typeof old === 'string') return d;
  const n = Number(d);
  return Number.isSafeInteger(n) ? n : undefined;
}

// The tooltip of a change that was not written and has no message of its own (03 §7.2: it stays pending).
const FAIL_TEXT = Object.freeze({
  failed: 'This change failed.',
  skipped: 'Not written: the record changed since you loaded it.',
  notAttempted: 'Not written: the change set stopped before this change.',
});

// The edit toolbar counter (03 §7.2): {main: '5 pending changes', sub: '2 updated rows · 1 deleted · 2 new'}.
export function pendingText(c) {
  if (!c || !c.total) return { main: TEXTS.noChanges, sub: '' };
  const parts = [];
  if (c.updated) parts.push(`${fmtInt(c.updated)} updated ${c.updated === 1 ? 'row' : 'rows'}`);
  if (c.deleted) parts.push(`${fmtInt(c.deleted)} deleted`);
  if (c.created) parts.push(`${fmtInt(c.created)} new`);
  return { main: `${fmtInt(c.total)} pending ${c.total === 1 ? 'change' : 'changes'}`, sub: parts.join(' · ') };
}

// The announcement of Delete row (03 §7.2): 'Marked 2 rows for deletion.', 'Removed 1 new row.', 'Restored 3 rows.'.
export function deleteText(restore, n, removed = 0) {
  const rows = k => `${fmtInt(k)} ${k === 1 ? 'row' : 'rows'}`;
  if (restore) return `Restored ${rows(n)}.`;
  const parts = [];
  if (n || !removed) parts.push(`Marked ${rows(n)} for deletion.`);
  if (removed) parts.push(`Removed ${fmtInt(removed)} new ${removed === 1 ? 'row' : 'rows'}.`);
  return parts.join(' ');
}

// '(2 hidden by filters)' (03 §7.2).
export const hiddenChangesText = n => `(${fmtInt(n)} hidden by filters)`;

// A change navigator list item (03 §7.2): 'Updated name, telephone1 on “Contoso”', 'Deleted “Fabrikam”', 'New row 3'.
export function changeText(ch) {
  if (ch.kind === 'update') return `Updated ${ch.cols.join(', ')} on “${ch.name}”`;
  if (ch.kind === 'delete') return `Deleted “${ch.name}”`;
  return `New row ${fmtInt(ch.n)}`;
}

// The navigator announcement (03 §7.2): 'Change 3 of 5: name on “Contoso”'.
export function changeAnnouncement(i, n, ch) {
  const what = ch.kind === 'update' ? `${ch.cols.join(', ')} on “${ch.name}”` : ch.kind === 'delete' ? `deleted “${ch.name}”` : `new row ${fmtInt(ch.n)}`;
  return `Change ${fmtInt(i)} of ${fmtInt(n)}: ${what}`;
}

// ---------------------------------------------------------------------------------------------- value editing

const pad2 = n => String(n).padStart(2, '0');

// The text an editor starts with for a value (03 §7.2): exact Raw text; dates in the input formats of their editor.
export function editText(v, col, tz, target) {
  if (v == null) return '';
  const dt = dtOfCol(col);
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    const p = dateParts(v, dt === 'date' ? UTC : tz);
    const d = `${String(p.y).padStart(4, '0')}-${pad2(p.m)}-${pad2(p.d)}`;
    return dt === 'date' ? d : `${d}T${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;
  }
  if (dt === 'guid' && col.attr && LOOKUP_TYPES.has(col.attr.type) && target && Array.isArray(col.attr.targets) && col.attr.targets.length > 1) {
    return `${target}:${v}`;
  }
  const f = formatCell(v, col, { friendly: false, tz, full: true });
  return f.cls === 'null' ? '' : f.text;
}

// The editor kind of a column: 'select' (choices, booleans), 'date', 'datetime' or 'text' (03 §7.2).
export function editorKind(col) {
  const a = col.attr;
  if (a && (CHOICE_TYPES.has(a.type) || a.type === 'Boolean')) return 'select';
  const dt = dtOfCol(col);
  if (dt === 'bit') return 'select';
  if (dt === 'date') return 'date';
  if (dt === 'datetime') return 'datetime';
  return 'text';
}

// True when a text value is edited in a multi-line <textarea>: string, xml and untyped columns other
// than lookups and multi-select values, and any value whose editor text holds a line break.
export function usesTextarea(col, text) {
  if (editorKind(col) !== 'text') return false;
  if (typeof text === 'string' && (text.includes('\n') || text.includes('\r'))) return true;
  const a = col.attr;
  if (a && (LOOKUP_TYPES.has(a.type) || a.type === 'MultiSelectPicklist')) return false;
  const dt = dtOfCol(col);
  return dt === 'string' || dt === 'xml' || dt === 'any';
}

// Parses an editor's text into a value of the column's type (03 §7.2): {value, entity?} or {error}. An empty text is
// NULL (for text columns only the empty text: '  ' stays text); lookups take a GUID or table:guid; numbers, dates
// and GUIDs convert as T-SQL converts a string (types.js).
export function parseEdit(text, col, { tz = UTC, target = null, options = null } = {}) {
  const s = text == null ? '' : String(text);
  const a = col.attr || {};
  const dt = dtOfCol(col);
  const textual = (dt === 'string' || dt === 'xml' || dt === 'any') && !LOOKUP_TYPES.has(a.type) && a.type !== 'MultiSelectPicklist';
  if (textual ? s === '' : s.trim() === '') return { value: null };
  if (LOOKUP_TYPES.has(a.type)) {
    const m = /^\s*(?:([A-Za-z0-9_]+)\s*:\s*)?\{?([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\}?\s*$/.exec(s);
    const targets = Array.isArray(a.targets) ? a.targets.map(t => String(t).toLowerCase()) : [];
    const list = targets.length ? targets.join(', ') : 'its table';
    if (!m) return { error: targets.length > 1 ? `Enter table:GUID, for example ${targets[0]}:<id> (tables: ${list}).` : 'Enter a GUID.' };
    const id = m[2].toLowerCase();
    let ent = m[1] ? m[1].toLowerCase() : null;
    if (ent && targets.length && !targets.includes(ent)) return { error: `This lookup cannot point to ${ent}. Tables: ${list}.` };
    if (!ent) ent = targets.length === 1 ? targets[0] : target ? String(target).toLowerCase() : null;
    if (!ent) return { error: `Enter table:GUID, for example ${targets[0] ?? 'account'}:<id> (tables: ${list}).` };
    return { value: id, entity: ent };
  }
  if (a.type === 'MultiSelectPicklist') {
    const parts = s.split(',').map(x => x.trim()).filter(x => x !== '');
    if (!parts.every(x => /^-?\d+$/.test(x))) return { error: 'Enter option values separated by commas, for example 1,3.' };
    if (Array.isArray(options) && options.length) {
      const bad = parts.find(x => !options.some(o => String(o.value) === String(Number(x))));
      if (bad != null) return { error: `${bad} is not an option of this column.` };
    }
    return { value: [...new Set(parts.map(x => String(Number(x))))].join(',') };
  }
  if ((dt === 'string') && Number.isInteger(a.maxLength) && a.maxLength > 0 && s.length > a.maxLength) {
    return { error: `Enter at most ${fmtInt(a.maxLength)} characters (${fmtInt(s.length)} now).` };
  }
  if (dt === 'string' || dt === 'xml' || dt === 'any') return { value: s };
  let value;
  try {
    value = coerce(s.trim(), STR_T, typeOfCol(col), { tz, dateformat: 'ymd' });
  } catch (e) {
    return { error: e && e.message ? String(e.message) : 'This value cannot be converted.' };
  }
  // The attribute's own range (Integer, Decimal, Double and Money MinValue / MaxValue, 02 §2).
  if (typeof value === 'number' && NUM_DT.has(dt)) {
    const lo = Number.isFinite(a.minValue) ? a.minValue : null, hi = Number.isFinite(a.maxValue) ? a.maxValue : null;
    if ((lo != null && value < lo) || (hi != null && value > hi)) {
      return { error: lo != null && hi != null ? `Enter a number from ${fmtNumber(lo)} to ${fmtNumber(hi)}.` : lo != null ? `Enter a number of at least ${fmtNumber(lo)}.` : `Enter a number of at most ${fmtNumber(hi)}.` };
    }
  }
  return { value };
}

// ----------------------------------------------------------------------------------------------------------- CSS

// Module CSS (03 §1.3): .gr- classes only, token colours only.
export const CSS = `.gr-grid{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;position:relative;color:var(--fg1);font-size:var(--gr-font-size,13px);container:gr-grid/inline-size}
@container gr-grid (width < 900px){.gr-ebar .btn:not(.primary):has(>svg)>.lbl{display:none}.gr-ebar .btn:not(.primary):not(.icon):has(>svg){padding:0 8px}.gr-ebar{padding:6px 16px}}
.gr-grid[hidden]{display:none}
.gr-ebar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:44px;padding:6px 24px;background:var(--bg2);border-top:1px solid var(--s2);flex:none}
.gr-ebar .gr-sep{width:1px;height:20px;background:var(--s2);flex:none}
.gr-cnt{display:inline-flex;flex-direction:column;align-items:flex-start;justify-content:center;min-height:32px;border:0;background:none;padding:2px 8px;border-radius:4px;cursor:pointer;color:var(--fg1);font-weight:600;text-align:left;white-space:nowrap}
.gr-cnt:hover{background:var(--bg3)}
.gr-cnt:disabled{cursor:default;background:none;color:var(--fg3)}
.gr-cnt small{font-weight:400;font-size:12px;line-height:16px;color:var(--fg3)}
.gr-hidn{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--fg3)}
.gr-fbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 24px;flex:none}
.gr-scroll{flex:1;min-height:0;overflow:auto;position:relative;border-top:1px solid var(--s2);outline:none;overscroll-behavior:contain;background:var(--bg1)}
.gr-scroll:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.gr-canvas{position:relative}
.gr-view{position:sticky;left:0;top:0;overflow:hidden}
.gr-head{position:absolute;left:0;top:0;right:0;height:var(--head-h);background:var(--bg1);border-bottom:1px solid var(--s2);z-index:2}
.gr-hcs,.gr-cs{position:absolute;left:0;top:0;bottom:0}
.gr-h{position:absolute;top:0;bottom:0;display:flex;align-items:center;gap:2px;padding:0 4px 0 12px;font-weight:600;color:var(--fg1);white-space:nowrap;cursor:pointer;user-select:none;outline:none}
.gr-h:hover{background:var(--bg3)}
.gr-h:focus-visible{box-shadow:inset 0 0 0 2px var(--focus)}
.gr-h.gr-num{flex-direction:row}
.gr-h.gr-num .gr-hl{text-align:right}
.gr-h.gr-drag{opacity:.4}
.gr-hl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.gr-hi{display:flex;align-items:center;gap:1px;flex:none;color:var(--brand)}
.gr-hi .gr-pr{font-size:10px;line-height:12px;font-weight:600}
.gr-hi .gr-lock{display:grid;color:var(--fg3)}
.gr-hi .gr-spin{width:12px;height:12px;border:2px solid var(--s2);border-top-color:var(--brand);border-radius:50%;animation:gr-spin .7s linear infinite}
.gr-hm{display:grid;place-items:center;width:20px;height:20px;border:0;border-radius:4px;background:none;color:var(--fg3);cursor:pointer;flex:none;padding:0}
.gr-hm:hover,.gr-hm[aria-expanded=true]{background:var(--bg4);color:var(--fg1)}
.gr-rz{position:absolute;right:-3px;top:0;bottom:0;width:6px;cursor:col-resize;z-index:1}
.gr-rz::after{content:'';position:absolute;left:2px;top:6px;bottom:6px;width:2px;border-radius:1px;background:transparent}
.gr-rz:hover::after,.gr-rz.gr-on::after{background:var(--brand)}
.gr-corner{position:absolute;left:0;top:0;bottom:0;background:var(--bg1);border-right:1px solid var(--s2);z-index:1;cursor:pointer}
.gr-corner:hover{background:var(--bg3)}
.gr-body{position:absolute;left:0;right:0;top:var(--head-h);bottom:0;overflow:hidden}
.gr-r{position:absolute;left:0;top:0;right:0;height:var(--gr-row-h)}
.gr-rh{position:absolute;left:0;top:0;bottom:0;z-index:1;padding:0 8px;text-align:right;font-size:12px;color:var(--fg3);background:var(--bg1);border-right:1px solid var(--s2);border-bottom:1px solid var(--s3);font-variant-numeric:tabular-nums;line-height:calc(var(--gr-row-h) - 1px);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer;user-select:none;outline:none}
.gr-rh:focus-visible{box-shadow:inset 0 0 0 2px var(--focus)}
.gr-c{position:absolute;top:0;bottom:0;padding:0 12px;border-bottom:1px solid var(--s3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:calc(var(--gr-row-h) - 1px);outline:none;cursor:default}
.gr-c>svg{vertical-align:-3px;margin-right:4px;color:var(--fg3)}
.gr-c>.gr-lk{cursor:pointer}
.gr-c>.gr-lk:hover{color:var(--brand)}
.gr-c>.gr-wn{color:var(--amber)}
.gr-r:hover>.gr-cs>.gr-c,.gr-r:hover>.gr-rh{background:var(--bg3)}
.gr-c.gr-sel,.gr-rh.gr-sel{background:var(--brand-bg)}
.gr-rh.gr-sel{color:var(--brand)}
.gr-r:hover>.gr-cs>.gr-c.gr-sel,.gr-r:hover>.gr-rh.gr-sel{background:var(--brand-bg-h)}
.gr-scroll:focus-within .gr-c.gr-act{box-shadow:inset 0 0 0 2px var(--brand)}
.gr-c:focus-visible,.gr-scroll:focus-within .gr-c.gr-act:focus-visible{box-shadow:inset 0 0 0 2px var(--focus)}
.gr-c.gr-chg,.gr-r:hover>.gr-cs>.gr-c.gr-chg{background:var(--diff-add);box-shadow:inset 2px 0 0 var(--diff-new)}
.gr-c.gr-chg.gr-sel{background:color-mix(in srgb,var(--diff-add) 60%,var(--brand-bg))}
.gr-r.gr-del>.gr-cs>.gr-c{text-decoration:line-through;color:var(--fg4)}
.gr-rh.gr-new{color:var(--green);font-weight:600}
.gr-rh.gr-delh{color:var(--red);font-weight:600}
.gr-rh.gr-err{box-shadow:inset 3px 0 0 var(--red);color:var(--red)}
.gr-rh.gr-unk{box-shadow:inset 3px 0 0 var(--amber)}
.gr-c.gr-ro{color:var(--fg3)}
.gr-ed{position:absolute;z-index:3;margin:0;border:0;border-radius:0;padding:0 11px;background:var(--bg1);color:var(--fg1);font:inherit;box-shadow:inset 0 0 0 2px var(--brand);outline:none}
.gr-ed.gr-bad{box-shadow:inset 0 0 0 2px var(--red)}
select.gr-ed{padding:0 8px}
textarea.gr-ed{resize:none;overflow-x:hidden;overflow-y:auto;white-space:pre;overflow-wrap:normal;line-height:var(--gr-ed-lh,20px);padding-top:calc((var(--gr-row-h) - var(--gr-ed-lh,20px)) / 2);padding-bottom:0}
.gr-c.fc-guid{font-size:calc(var(--gr-font-size,13px) - 1px)}
.gr-ins{position:absolute;top:0;width:2px;height:var(--head-h);margin-left:-1px;background:var(--brand);z-index:4;pointer-events:none}
.gr-ghost{position:absolute;top:0;height:var(--head-h);z-index:4;display:flex;align-items:center;padding:0 12px;background:var(--bg1);box-shadow:var(--sh16);border-radius:4px;opacity:.85;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
.gr-none{position:absolute;left:0;right:0;top:calc(var(--head-h) + 24px);display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--fg3);text-align:center;pointer-events:auto}
.gr-busy{position:absolute;left:0;right:0;top:var(--head-h);height:2px;background:var(--s3);z-index:3;overflow:hidden}
.gr-busy>i{display:block;height:100%;width:0;background:var(--brand);transition:width .25s ease-out}
.gr-list{max-height:320px;overflow:auto;position:relative;padding:0 4px}
.gr-li{position:absolute;left:4px;right:4px;display:flex;align-items:center;gap:8px;height:36px;padding:0 8px;border-radius:4px}
.gr-li:hover{background:var(--bg3)}
.gr-li>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gr-li.gr-bad>span{color:var(--red)}
.gr-li.gr-hid>span{color:var(--fg3)}
.gr-li>span>small{font-size:12px;color:var(--fg3)}
.gr-pophead{padding:8px 12px 4px;font-weight:600}
@keyframes gr-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.gr-busy>i{transition:none}.gr-hi .gr-spin{animation-duration:1.4s}}
@media (forced-colors:active){.gr-c.gr-sel,.gr-rh.gr-sel{forced-color-adjust:none;background:Highlight;color:HighlightText}.gr-ins{background:Highlight}.gr-c.gr-chg{outline:1px dashed CanvasText;outline-offset:-3px}}
`;

// ------------------------------------------------------------------------------------------------------- the grid

const raf = fn => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
const caf = id => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const frame = () => new Promise(r => raf(() => raf(() => r())));

// Creates the virtual grid of one result set in `host` (03 §1.4, §7, §7.2).
export function createGrid(host, o = {}) {
  const columns = Array.isArray(o.columns) ? o.columns : [];
  const source = o.source ?? null;
  const shell = o.shell ?? null;
  const meta = o.meta ?? null;
  const actions = o.actions ?? {};
  const mac = !!o.mac;
  const ioFn = name => (o.io && typeof o.io[name] === 'function' ? o.io[name] : name === 'copyText' ? utilCopyText : name === 'copyBlob' ? utilCopyBlob : utilOpenUrl);
  let friendly = o.friendly !== false;
  let tz = o.tz ?? UTC;
  let dateFormat = o.dateFormat ?? null;
  let compact = !!o.compact;
  let fontSize = Math.max(11, Math.min(16, Math.round(Number.isFinite(o.fontSize) ? o.fontSize : 13)));
  let neutral = o.csvNeutralize !== false;
  let label = o.label ?? 'Results';
  let view = normalizeView(o.view, columns);
  let complete = !!o.complete;
  let incomplete = o.incomplete ?? null;
  let destroyed = false;

  // Data: the grid's own list of row arrays (rows are never mutated; a committed edit replaces its entry).
  const data = [];
  const gone = new Set();      // data indexes deleted by a review
  const pinned = new Map();    // data index of a row created by a review -> its anchor ('d:<id>'|'i:<key>'|'')
  const overlays = new Map();  // data index -> the row with pending edits applied
  const unknownRows = new Set(); // data indexes of new rows whose creation has an unknown outcome
  let pkIdx = null;            // Map<id, data index>, built for edit mode

  // Edit state.
  let model = o.editModel ?? null;
  let editMode = false, reviewing = false, editing = null;
  // True while a review of this grid, or of another grid sharing its edit model, runs: every edit is locked.
  const isBusy = () => reviewing || !!(model && model.busy);
  const insRows = new Map();   // insert key -> row array (cache)

  // View state over data.
  let vBase = null;            // null: identity over data; else data indexes after filters and sort
  let vAll = null;             // with new rows or pinned rows: the full list (negative entries are new rows)
  let vLen = 0;
  let revMap = null;
  let vtok = 0, work = Promise.resolve();
  let asyncTok = 0;            // the token of a sliced recompute in progress (0: none)
  let streamed = 0, lastStream = 0, streamTimer = null;
  let sortCache = null;        // {sig, keys: [{keys, type, ai, desc}], n}
  let quickTimer = null;
  // Quick filter memo per data index (0 unknown, 1 passes, 2 fails) for the needle qNeedle and the displayed-text
  // signature qSig; textGen counts changes of what cells display (options, option labels, replaced rows).
  let qs = new Uint8Array(0), qNeedle = '', qSig = '';
  let textGen = 0, dataGen = 0;

  // Layout.
  let disp = [], wd = [], xs = new Float64Array(1);
  let rowH = 28, headH = 32, rnW = ROWNUM_MIN, rnKey = '';
  let vw = 0, vh = 0, vTop = 0, sMap = scrollMap(0, 0);
  // ver: cell content; hver: header content; lver: positions and widths (a resize moves cells, never reformats them).
  let ver = 0, hver = 0, lver = 0, selVer = 0;

  // Selection: ranges of view positions × displayed columns; the active cell (row -1 = header, col -1 = row header).
  let ranges = [];
  let active = { row: 0, col: 0 };
  let anchor = { row: 0, col: 0 };
  let statsTok = 0;

  // ---- DOM ---------------------------------------------------------------------------------------------------
  const scroller = h('div', { class: 'gr-scroll', role: 'grid', 'aria-label': label, 'aria-multiselectable': 'true', 'aria-readonly': 'true', tabindex: '0', 'data-scope': 'grid' });
  const canvas = h('div', { class: 'gr-canvas', role: 'presentation' });
  const viewEl = h('div', { class: 'gr-view', role: 'presentation' });
  const head = h('div', { class: 'gr-head', role: 'row', 'aria-rowindex': '1' });
  const corner = h('div', { class: 'gr-corner', role: 'columnheader', 'aria-colindex': '1', 'aria-label': 'Row number', title: 'Select all' });
  const hcs = h('div', { class: 'gr-hcs', role: 'presentation' });
  const body = h('div', { class: 'gr-body', role: 'presentation' });
  const none = h('div', { class: 'gr-none', hidden: true });
  const busy = h('div', { class: 'gr-busy', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Filtering', hidden: true }, h('i'));
  head.append(corner, hcs);
  viewEl.append(head, body, none, busy);
  canvas.append(viewEl);
  scroller.append(canvas);
  const ebar = h('div', { class: 'gr-ebar', role: 'toolbar', 'aria-label': 'Edit rows', hidden: true });
  const fbar = h('div', { class: 'gr-fbar', role: 'group', 'aria-label': 'Filters', hidden: true });
  const tip = h('div', { class: 'tip gr-tip', popover: 'manual', role: 'tooltip' });
  const root = h('div', { class: 'gr-grid', 'data-scope': 'grid' }, ebar, fbar, scroller, tip);
  if (host) host.append(root);

  const offs = [];
  const listen = (el, type, fn, opt) => { el.addEventListener(type, fn, opt); offs.push(() => el.removeEventListener(type, fn, opt)); };
  const announce = t => { try { shell?.announce?.(t); } catch { /* the shell reports its own errors */ } };
  const status = (t, ms = 3000) => { try { shell?.status?.(t, { ms }); } catch { /* idem */ } };
  const toast = (t, opts) => { try { return shell?.toast?.(t, opts) ?? null; } catch { return null; } };
  const km = (e, id) => (shell && typeof shell.keyMatches === 'function' ? shell.keyMatches(e, id) : keymapMatches(e, id, mac));
  const activeEl = () => { const r = root.getRootNode?.(); return (r && r.activeElement) || (typeof document !== 'undefined' ? document.activeElement : null); };
  const focusEl = el => { try { el.focus({ preventScroll: true }); } catch { el.focus(); } };
  // Keeps focus in the grid when the focused cell is recycled by scrolling; this focus never moves the view back.
  let parking = false;
  const park = () => { parking = true; try { focusEl(scroller); } finally { parking = false; } };

  // ---- formatting ----------------------------------------------------------------------------------------------
  const optCache = new Map();
  const optMissing = new Set();
  // Option label of a choice or Boolean value from meta.optionsSync (the label hook of formatCell, and companion
  // names of edited cells). Options that arrive or change later change what cells display (textGen).
  function optionLabel(col, v) {
    const a = col && col.attr;
    if (!a || !meta || typeof meta.optionsSync !== 'function' || v == null) return null;
    let entry = optCache.get(col);
    let opts;
    try { opts = meta.optionsSync(a.entity, a.logicalName); } catch { opts = null; }
    if (!Array.isArray(opts)) { optMissing.add(col); return null; }
    if (!entry || entry.opts !== opts) {
      if (entry || optMissing.has(col)) textGen++;
      optMissing.delete(col);
      entry = { opts, map: new Map(opts.map(x => [Number(x.value), x.label])) };
      optCache.set(col, entry);
    }
    if (a.type === 'MultiSelectPicklist') {
      const parts = String(v).split(',').map(x => entry.map.get(Number(x.trim())));
      return parts.every(x => typeof x === 'string') ? parts.join('; ') : null;
    }
    const l = entry.map.get(typeof v === 'boolean' ? (v ? 1 : 0) : Number(v));
    return typeof l === 'string' ? l : null;
  }
  // formatCell's label hook (03 §1.1: (value, col) => label) for choices and booleans without a name companion.
  const labelHook = (v, col) => optionLabel(col, v);
  const fo = { friendly, tz, row: null, full: false, max: 500, label: labelHook, dateFormat, known: o.known };
  const foFull = { friendly, tz, row: null, full: true, label: labelHook, dateFormat, known: o.known };
  // The quick filter's options: the displayed text (Friendly or Raw, ⏎) without the 500-grapheme display cut.
  const fq = { friendly, tz, row: null, full: false, max: QUICK_MAX, label: labelHook, dateFormat, known: o.known };
  const syncFo = () => { for (const x of [fo, foFull, fq]) { x.friendly = friendly; x.tz = tz; x.dateFormat = dateFormat; } };
  const fmt = (row, c) => { fo.row = row; return formatCell(row[c], columns[c], fo); };
  const fmtFull = (row, c) => { foFull.row = row; return formatCell(row[c], columns[c], foFull); };

  // ---- rows of the view ------------------------------------------------------------------------------------------
  // The row array of a view entry (>= 0: a data index, with pending edits applied; < 0: a new row).
  function rowAt(e) {
    if (e >= 0) return overlays.size ? overlays.get(e) ?? data[e] : data[e];
    return insRow(-1 - e);
  }
  const dataRow = i => (overlays.size ? overlays.get(i) ?? data[i] : data[i]);
  const viewAt = p => (vAll ? vAll[p] : vBase ? vBase[p] : p);

  // The target table of a lookup value: the edit's table, the row's type companion, else the attribute's one target.
  function lookupEntity(col, row, ent) {
    if (typeof ent === 'string' && ent) return ent;
    const comp = col.companion;
    if (comp && isIdx(comp.type) && typeof row[comp.type] === 'string' && row[comp.type]) return row[comp.type];
    const t = col.attr && Array.isArray(col.attr.targets) && col.attr.targets.length === 1 ? col.attr.targets[0] : null;
    return typeof t === 'string' && t ? t.toLowerCase() : null;
  }

  // Names of lookup targets set by edits: opts.lookupName(entity, id) resolves them when given;
  // until then (or without it) the cell shows the GUID with its record link.
  const names = new Map();          // 'entity:id' -> the name, or null while unknown
  const nameRows = new Map();       // 'entity:id' -> data indexes of written rows that wait for the name
  const writtenAttrs = new Map();   // data index -> attributes a review wrote into the row
  function lookupName(ent, id) {
    if (!ent || typeof id !== 'string') return null;
    const k = ent + ':' + id.toLowerCase();
    if (names.has(k)) return names.get(k);
    names.set(k, null);
    if (typeof o.lookupName === 'function') {
      let r;
      try { r = o.lookupName(ent, id.toLowerCase()); } catch { r = null; }
      Promise.resolve(r).then(n => { if (typeof n === 'string' && n !== '' && !destroyed) { names.set(k, n); renamed(k); } }, () => {});
    }
    return null;
  }
  // A resolved name reaches the pending, new and written rows that show its record.
  function renamed(k) {
    if (model && editMode) for (const id of model.ids()) refreshOverlay(id);
    insRows.clear();
    const list = nameRows.get(k);
    if (list) {
      nameRows.delete(k);
      for (const i of list) {
        if (i >= data.length || gone.has(i)) continue;
        const r = data[i].slice();
        for (let c = 0; c < columns.length; c++) {
          const col = columns[c], comp = col && col.companion;
          if (!comp || !isIdx(comp.name) || !col.attr || !LOOKUP_TYPES.has(col.attr.type) || r[comp.name] != null || typeof r[c] !== 'string') continue;
          const ent = lookupEntity(col, r, null);
          if (ent && ent + ':' + r[c].toLowerCase() === k) r[comp.name] = names.get(k);
        }
        data[i] = r;
        if (i < qs.length) qs[i] = 0;
      }
    }
    ver++;
    render();
  }

  // Companion values of an edited cell: the name is the option label (choices) or the target's name when known
  // (lookups), the type the lookup's target table. written: the data index of a row a review wrote, else -1.
  function applyCells(row, cells, targets, written = -1) {
    for (const [attr, v] of cells) {
      for (const c of model.colsOf(attr)) {
        row[c] = v;
        const col = columns[c], comp = col.companion;
        if (!comp) continue;
        const isLookup = !!(col.attr && LOOKUP_TYPES.has(col.attr.type));
        const ent = isLookup && v != null ? lookupEntity(col, row, targets.get(attr)) : null;
        if (isIdx(comp.name)) {
          row[comp.name] = v == null ? null : isLookup ? lookupName(ent, v) : optionLabel(col, v);
          if (written >= 0 && isLookup && row[comp.name] == null && ent && typeof v === 'string') {
            const k = ent + ':' + v.toLowerCase();
            const l = nameRows.get(k);
            if (l) l.add(written); else nameRows.set(k, new Set([written]));
          }
        }
        if (isIdx(comp.type)) row[comp.type] = v == null ? null : targets.get(attr) ?? row[comp.type];
      }
      if (written >= 0) { const s = writtenAttrs.get(written); if (s) s.add(attr); else writtenAttrs.set(written, new Set([attr])); }
    }
    return row;
  }

  // True when cell (e, c) shows an edited lookup whose target's name is not known: it keeps its record link.
  function unnamedEdit(e, c, row) {
    const col = columns[c];
    if (!friendly || !model || !col.attr || !LOOKUP_TYPES.has(col.attr.type) || labelIndex(col) < 0) return false;
    if (row[c] == null || row[labelIndex(col)] != null) return false;
    const attr = model.attrOf(c);
    if (!attr) return false;
    if (e < 0) { const it = model.insert(-1 - e); return !!(it && it.cells.has(attr)); }
    if (overlays.has(e)) { const rec = model.update(model.rowId(data[e])); if (rec && rec.cells.has(attr)) return true; }
    const w = writtenAttrs.get(e);
    return !!(w && w.has(attr));
  }

  // The row of a new (insert) row: NULL everywhere except its values (cached until it changes).
  function insRow(key) {
    let r = insRows.get(key);
    if (r) return r;
    const it = model && model.insert(key);
    r = new Array(columns.length).fill(null);
    if (it) applyCells(r, it.cells, it.targets);
    insRows.set(key, r);
    return r;
  }

  // Rebuilds the overlay of one loaded record after its edits changed.
  function refreshOverlay(id) {
    const i = pkIdx ? pkIdx.get(id) : undefined;
    if (i == null) return;
    const rec = model.update(id);
    if (rec && rec.cells.size) overlays.set(i, applyCells(data[i].slice(), rec.cells, rec.targets));
    else overlays.delete(i);
    if (i < qs.length) qs[i] = 0;
  }

  const pkOf = e => (e >= 0 && model ? model.rowId(data[e]) : null);

  // The full view list with new rows and pinned rows below their anchors.
  function buildAll() {
    const ins = model && editMode ? model.inserts() : [];
    revMap = null;
    if (!ins.length && !pinned.size) { vAll = null; vLen = vBase ? vBase.length : data.length; return; }
    const kids = new Map();
    const add = (k, x) => { const l = kids.get(k); if (l) l.push(x); else kids.set(k, [x]); };
    for (const [i, a] of pinned) add(a, i);
    for (const it of ins) add(it.anchor, -1 - it.key);
    const out = [];
    const emitted = new Set();
    const emit = k => {
      const l = kids.get(k);
      if (!l) return;
      for (const x of l) {
        if (emitted.has(x)) continue;
        emitted.add(x);
        out.push(x);
        if (x >= 0) { const id = model ? model.rowId(data[x]) : null; if (id) emit('d:' + id); }
        else emit('i:' + (-1 - x));
      }
    };
    const n = vBase ? vBase.length : data.length;
    for (let p = 0; p < n; p++) {
      const e = vBase ? vBase[p] : p;
      if (!vBase && (pinned.has(e) || gone.has(e))) continue;
      out.push(e);
      if (kids.size) { const id = pkOf(e); if (id) emit('d:' + id); }
    }
    emit('');
    for (const [, l] of kids) for (const x of l) if (!emitted.has(x)) { emitted.add(x); out.push(x); const id = x >= 0 ? pkOf(x) : null; if (id) emit('d:' + id); else if (x < 0) emit('i:' + (-1 - x)); }
    vAll = out;
    vLen = out.length;
  }

  // The view position of an entry, or -1 when it is not displayed.
  function posOf(e) {
    if (!vAll && !vBase) return e >= 0 && e < data.length ? e : -1;
    if (!revMap) {
      revMap = new Map();
      for (let p = 0; p < vLen; p++) revMap.set(viewAt(p), p);
    }
    const p = revMap.get(e);
    return p == null ? -1 : p;
  }

  // ---- view computation ------------------------------------------------------------------------------------------
  const sortSig = () => JSON.stringify([view.sort, friendly]);

  // Decorated sort keys for every data row (extended for appended rows, rebuilt when the sort or edits change).
  function keyCols() {
    const n = data.length;
    const sig = sortSig();
    if (sortCache && sortCache.sig === sig && sortCache.n === n) return sortCache.keys;
    if (sortCache && sortCache.sig === sig && sortCache.n < n) {
      for (const k of sortCache.keys) sortKeys(n, dataRow, k.spec, sortCache.n, k.keys);
      sortCache.n = n;
      return sortCache.keys;
    }
    const keys = view.sort.map(s => {
      const spec = sortSpec(columns, s.col, friendly);
      return { spec, keys: sortKeys(n, dataRow, spec), type: spec.type, ai: spec.ai, desc: s.desc };
    });
    sortCache = { sig, keys, n };
    return keys;
  }

  // Data indexes that pass the column filters (and are not deleted or pinned), from index `from`.
  function filteredFrom(from, compiled) {
    const out = [];
    for (let i = from; i < data.length; i++) {
      if (gone.has(i) || pinned.has(i)) continue;
      if (compiled.length && !passesFilters(dataRow(i), compiled)) continue;
      out.push(i);
    }
    return out;
  }

  // ---- the quick filter memo ----
  // What the displayed cells' text depends on besides the row: the displayed columns (as a set) and textGen.
  const quickSig = () => textGen + '|' + displayColumns(view).slice().sort((a, b) => a - b).join(',');
  // Makes the memo cover every data row and fit the needle: kept across keystrokes that narrow or widen the needle.
  function quickPrep(needle) {
    if (qs.length < data.length) { const n = new Uint8Array(Math.max(data.length, qs.length * 2, 1024)); n.set(qs); qs = n; }
    const sig = quickSig();
    if (sig !== qSig) { qs.fill(0); qSig = sig; qNeedle = needle; return; }
    narrowQuick(qs, data.length, qNeedle, needle);
    qNeedle = needle;
  }
  // The displayed columns and their plain-text flags for quickMatches (computed once per pass).
  const quickCols = () => { const cols = disp.slice(); return { cols, plain: cols.map(c => plainTextCol(columns[c])) }; };
  // True when data row i passes the quick filter (memoised).
  function quickPass(i, qc, opts, needle) {
    const s = qs[i];
    if (s) return s === 1;
    const ok = quickMatches(dataRow(i), qc.cols, columns, opts, needle, qc.plain);
    qs[i] = ok ? 1 : 2;
    return ok;
  }
  // The number of data indexes of idx whose quick filter state is not known yet.
  function quickUnknown(idx) {
    let n = 0;
    for (let k = 0; k < idx.length; k++) if (!qs[idx[k]]) n++;
    return n;
  }
  // True when testing `unknown` rows is long work for slices (03 §13: over 50,000 rows, or BIG_CELLS cells).
  const quickBig = unknown => unknown > BIG_QUICK || unknown * Math.max(1, disp.length) > BIG_CELLS;

  function quickSync(idx, needle) {
    quickPrep(needle);
    const qc = quickCols();
    return idx.filter(i => quickPass(i, qc, fq, needle));
  }

  // The quick filter over a large set in slices of SLICE_MS, with a progress bar after PROGRESS_MS (03 §13).
  async function quickAsync(idx, needle, token) {
    const out = [];
    const qc = quickCols();
    const opts = { ...fq };
    const sig0 = qSig;
    const t0 = now();
    let i = 0;
    while (i < idx.length) {
      const end = now() + SLICE_MS;
      do { if (quickPass(idx[i], qc, opts, needle)) out.push(idx[i]); i++; } while (i < idx.length && ((i & 63) || now() < end));
      if (now() - t0 > PROGRESS_MS) showBusy(Math.round((i / idx.length) * 100));
      if (i >= idx.length) break;
      await yieldToUi();
      // A newer recompute, or the memo prepared for a newer search text (whose recompute follows): stop writing.
      if (token !== vtok || destroyed || qNeedle !== needle || qSig !== sig0) { if (asyncTok === token) showBusy(null); return null; }
    }
    showBusy(null);
    return out;
  }

  function showBusy(pct) {
    if (pct == null) { busy.hidden = true; return; }
    busy.hidden = false;
    busy.setAttribute('aria-valuenow', String(pct));
    busy.firstChild.style.width = pct + '%';
  }

  // The top visible entry and its offset, so a re-applied view keeps it in place (03 §7 Streaming).
  function topAnchor() {
    if (!vLen) return null;
    const p = Math.min(vLen - 1, Math.max(0, Math.floor(vTop / rowH)));
    return { e: viewAt(p), off: p * rowH - vTop, p };
  }
  // p: the anchor's new position when the caller knows it (else it is looked up).
  function restoreTop(a, p = null) {
    if (!a) return;
    if (p == null) p = posOf(a.e);
    if (p < 0 || p === a.p) return;
    const target = Math.min(p * rowH - a.off, maxTop());
    scroller.scrollTop = Math.max(0, sMap.toPhys(target));
  }
  // The largest virtual scroll position: the last row at the bottom of the viewport.
  const maxTop = () => Math.max(0, headH + vLen * rowH - vh);

  // Recomputes the view from all rows: filters, quick filter, sort (03 §7). Returns a promise for sliced work.
  function recompute({ keepTop = false } = {}) {
    const token = ++vtok;
    asyncTok = 0;
    const anchorTop = keepTop ? topAnchor() : null;
    const compiled = compileFilters(view.filters, columns);
    const needle = quickNeedle(view.quick);
    streamed = data.length;
    if (!compiled.length && !needle && !view.sort.length && !gone.size && !pinned.size) {
      vBase = null;
      finish(token, anchorTop);
      return Promise.resolve();
    }
    let idx = filteredFrom(0, compiled);
    if (needle) {
      quickPrep(needle);
      if (quickBig(quickUnknown(idx))) {
        asyncTok = token;
        const p = quickAsync(idx, needle, token).then(r => (r ? afterQuick(r, token, anchorTop) : undefined));
        work = p.catch(() => {});
        return p;
      }
      idx = quickSync(idx, needle);
    }
    const r = afterQuick(idx, token, anchorTop);
    if (r && typeof r.then === 'function') { work = r.catch(() => {}); return r; }
    return Promise.resolve();
  }

  function afterQuick(idx, token, anchorTop) {
    if (token !== vtok) return undefined;
    if (!view.sort.length) { vBase = idx; finish(token, anchorTop); return undefined; }
    if (idx.length > BIG_SORT) {
      asyncTok = token;
      sortingCol = view.sort[0].col;
      hver++;
      renderHeader();
      return frame().then(() => {
        sortingCol = -1;
        hver++;
        if (token !== vtok || destroyed) return;
        vBase = idx.toSorted(indexComparator(keyCols()));
        finish(token, anchorTop);
      });
    }
    vBase = idx.toSorted(indexComparator(keyCols()));
    finish(token, anchorTop);
    return undefined;
  }
  let sortingCol = -1;

  function finish(token, anchorTop) {
    if (token !== vtok || destroyed) return;
    if (asyncTok === token) asyncTok = 0;
    buildAll();
    ver++;
    measureLayout();
    clampSelection();
    if (anchorTop) restoreTop(anchorTop);
    render();
    emitCount();
    renderFbar();
    renderEbar();
    repositionPop();
    // Rows that streamed in while a sliced recompute ran are merged now.
    if (streamed < data.length) scheduleStream();
  }

  // Streaming (03 §7): new rows are filtered and merged into the sorted view at most every STREAM_MS. While a sliced
  // recompute runs (its row list was taken when it started), the merge waits for it.
  function streamUpdate() {
    streamTimer = null;
    if (asyncTok) { streamTimer = setTimeout(streamUpdate, STREAM_MS); return; }
    lastStream = now();
    if (streamed >= data.length) return;
    const compiled = compileFilters(view.filters, columns);
    const needle = quickNeedle(view.quick);
    const plain = !compiled.length && !needle && !view.sort.length;
    if (vBase === null && plain) {
      // Appended rows only add positions at the end: the rendered rows keep their content.
      streamed = data.length;
      buildAll();
      render();
      emitCount();
      return;
    }
    // A view that was the identity before a filter or sort arrived is recomputed whole.
    if (vBase === null) { recompute({ keepTop: true }); return; }
    const anchorTop = topAnchor();
    let fresh = filteredFrom(streamed, compiled);
    if (needle) fresh = quickSync(fresh, needle);
    streamed = data.length;
    if (!fresh.length) { emitCount(); return; }
    // The top row's new position: unchanged when rows join the end; in a sorted view, moved down by the new rows
    // that sort before it (a binary search, never a reverse map of the whole view).
    let pos = anchorTop ? anchorTop.p : null;
    if (view.sort.length) {
      const cmp = indexComparator(keyCols());
      const sorted = fresh.toSorted(cmp);
      if (anchorTop && !vAll && anchorTop.e >= 0) {
        let lo = 0, hi = sorted.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (cmp(sorted[m], anchorTop.e) < 0) lo = m + 1; else hi = m; }
        pos = anchorTop.p + lo;
      } else pos = null;
      vBase = mergeSorted(vBase, sorted, cmp);
    } else {
      vBase = vBase.concat(fresh);
      if (vAll) pos = null;
    }
    buildAll();
    ver++;
    measureLayout();
    restoreTop(anchorTop, pos);
    render();
    emitCount();
  }

  function scheduleStream() {
    if (streamTimer) return;
    const wait = STREAM_MS - (now() - lastStream);
    if (wait <= 0) { streamUpdate(); return; }
    streamTimer = setTimeout(streamUpdate, wait);
  }

  const totalRows = () => data.length - gone.size + (model && editMode ? model.inserts().length : 0);
  const emitCount = () => { try { o.onCount?.({ shown: vLen, total: totalRows(), loading: !complete }); } catch { /* caller's */ } };
  const emitView = () => { try { o.onView?.(copyView(view)); } catch { /* caller's */ } };

  // ---- layout ----------------------------------------------------------------------------------------------------
  // GUID and binary cells are monospace one pixel smaller than the grid font (the .gr-c.fc-guid rule).
  const cellFont = cls => (cls === 'guid' ? `${fontSize - 1}px ${MONO_FONT}` : `${fontSize}px ${UI_FONT}`);
  function textW(text, font) {
    const s = text.length > 120 ? text.slice(0, 120) : text;
    if (typeof o.measure === 'function') return o.measure(s, font);
    try { const w = measureText(s, font); if (Number.isFinite(w)) return w; } catch { /* no canvas */ }
    return s.length * fontSize * 0.55;
  }

  // The automatic widths (03 §7: 60-480 px from the header and the first SAMPLE rows, measured once, at the first
  // batch with SAMPLE rows or at the end of the set; never for a column the user resized). Until then (final false)
  // a column without a width gets its header's width, so early batches never make the columns jump.
  // Returns true when a width changed.
  function measureWidths(final) {
    if (view.measured) return false;
    const n = final ? Math.min(SAMPLE, data.length) : 0;
    const resized = new Set(view.resized);
    let changed = false;
    for (const c of view.order) {
      if (resized.has(c) || (!final && view.widths[c] != null)) continue;
      const w = columnWidth(c, n, i => data[i]);
      if (view.widths[c] !== w) { view.widths[c] = w; changed = true; }
    }
    if (final) { view.measured = true; emitView(); }
    if (changed) lver++;
    return changed;
  }

  // The automatic width of schema column c over its header and the rows rowOf(0..n-1).
  function columnWidth(c, n, rowOf) {
    const col = columns[c];
    const hw = textW(colLabel(col), `600 ${fontSize}px ${UI_FONT}`) + 24 + 20 + 18;
    const cw = [];
    for (let i = 0; i < n; i++) {
      const f = fmt(rowOf(i), c);
      cw.push(textW(f.text, cellFont(f.cls)) + 25 + (f.icon ? 18 : 0));
    }
    return autoWidth(hw, cw);
  }

  function metrics() {
    rowH = fontSize >= 14 ? fontSize + (compact ? 11 : 15) : compact ? 24 : 28;
    headH = 32;
    root.style.setProperty('--gr-font-size', fontSize + 'px');
    root.style.setProperty('--gr-row-h', rowH + 'px');
  }

  function measureLayout() {
    disp = displayColumns(view);
    wd = disp.map(c => view.widths[c] ?? W_MIN * 2);
    xs = new Float64Array(disp.length + 1);
    for (let i = 0; i < disp.length; i++) xs[i + 1] = xs[i] + wd[i];
    // The row-number column fits the largest row number (at least 48 px), and in edit mode the
    // 'Deleted' marker of a deleted row (03 §7.2).
    const digits = String(Math.max(1, vLen)).length;
    const key = digits + (editMode ? 'e' : '');
    if (key !== rnKey) {
      rnKey = key;
      let w = Math.max(ROWNUM_MIN, Math.ceil(textW(fmtInt(10 ** digits - 1), `12px ${UI_FONT}`) + 17));
      if (editMode) w = Math.max(w, Math.ceil(textW('Deleted', `600 12px ${UI_FONT}`) + 17));
      // Every cell and header is placed after the row-number column.
      if (w !== rnW) { rnW = w; lver++; }
    }
    const s = typeof o.size === 'function' ? o.size() : { width: scroller.clientWidth || 0, height: scroller.clientHeight || 0 };
    vw = Math.max(0, s.width || 0);
    vh = Math.max(0, s.height || 0);
    sMap = scrollMap(headH + vLen * rowH, vh);
  }

  // ---- rendering -------------------------------------------------------------------------------------------------
  const rowMap = new Map(), freeRows = [];
  const headMap = new Map(), freeHeads = [];
  let lastC0 = 0, lastC1 = -1;

  const owner = new WeakMap();   // row header and cell elements -> {R, C?}
  function newRow() {
    const rh = h('div', { class: 'gr-rh', role: 'rowheader', 'aria-colindex': '1', tabindex: '-1' });
    const cs = h('div', { class: 'gr-cs', role: 'presentation' });
    const el = h('div', { class: 'gr-r', role: 'row' }, rh, cs);
    body.append(el);
    const R = { el, rh, cs, cells: new Map(), free: [], p: -1, e: null, ver: -1, lv: -1, sv: -1, rhBase: 'gr-rh', rhTitle: '' };
    owner.set(rh, { R, C: null });
    return R;
  }
  function newCell(R) {
    const t = document.createTextNode('');
    const el = h('div', { class: 'gr-c', role: 'gridcell', tabindex: '-1' }, t);
    const C = { el, t, ic: null, icName: null, dc: -1, f: null, base: '' };
    owner.set(el, { R, C });
    return C;
  }
  function releaseRow(R) {
    if (R.el.contains(activeEl())) park();
    R.el.hidden = true;
    R.p = -1;
    freeRows.push(R);
  }

  // Writes a style or attribute only when it changes (no style invalidation per scroll frame).
  const putCache = new WeakMap();
  function put(el, key, v) {
    let m = putCache.get(el);
    if (!m) putCache.set(el, m = new Map());
    if (m.get(key) === v) return;
    m.set(key, v);
    if (key[0] === '@') el.setAttribute(key.slice(1), v); else el.style[key] = v;
  }

  // Renders the visible rows and columns (03 §7, §13): rows and cells that stay visible keep their element and text.
  function render() {
    if (destroyed) return;
    const st = scroller.scrollTop || 0, sl = scroller.scrollLeft || 0;   // reads before any write
    measureLayout();
    put(canvas, 'height', sMap.phys + 'px');
    put(canvas, 'width', Math.max(rnW + xs[disp.length], 1) + 'px');
    put(viewEl, 'width', vw + 'px');
    put(viewEl, 'height', vh + 'px');
    put(corner, 'width', rnW + 'px');
    put(scroller, '@aria-rowcount', String(vLen + 1));
    put(scroller, '@aria-colcount', String(disp.length + 1));
    put(scroller, '@aria-busy', complete ? 'false' : 'true');
    // A view that shrank is shown from its end before the browser clamps scrollTop (its scroll event follows).
    vTop = Math.max(0, Math.min(sMap.toVirtual(st), maxTop()));
    const bodyH = Math.max(0, vh - headH);
    const first = vLen ? Math.min(vLen - 1, Math.max(0, Math.floor(vTop / rowH))) : 0;
    const last = vLen ? Math.min(vLen - 1, Math.floor((vTop + Math.max(bodyH, 1) - 1) / rowH)) : -1;
    const [c0, c1] = colRange(xs, sl, Math.max(0, vw - rnW));
    lastC0 = c0; lastC1 = c1;
    renderHeader(c0, c1, sl);
    renderRows(first, last, c0, c1, sl);
    renderEmpty();
    placeEditor();
    syncTabStop();
  }

  function renderHeader(c0 = lastC0, c1 = lastC1, sl = scroller.scrollLeft || 0) {
    put(hcs, 'transform', `translateX(${-sl}px)`);
    const keep = new Map();
    for (let dc = c0; dc <= c1 && dc < disp.length; dc++) {
      let H = headMap.get(dc);
      if (H) headMap.delete(dc);
      else { H = freeHeads.pop() ?? newHead(); H.ver = -1; }
      keep.set(dc, H);
    }
    for (const H of headMap.values()) { if (H.el.contains(activeEl())) park(); H.el.hidden = true; freeHeads.push(H); }
    headMap.clear();
    for (const [dc, H] of keep) {
      headMap.set(dc, H);
      H.el.hidden = false;
      if (H.ver !== hver || H.dc !== dc) fillHead(H, dc);
      else if (H.lv !== lver) placeHead(H, dc);
      decorateHead(H, dc);
    }
  }

  // A header's position and width (a resize or a new row-number width moves it without refilling it).
  function placeHead(H, dc) {
    H.lv = lver;
    put(H.el, 'left', (rnW + xs[dc]) + 'px');
    put(H.el, 'width', wd[dc] + 'px');
  }

  function newHead() {
    const lab = h('span', { class: 'gr-hl' });
    const ind = h('span', { class: 'gr-hi' });
    const mb = h('button', { type: 'button', class: 'gr-hm', tabindex: '-1', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('chevron', 12));
    const rz = h('div', { class: 'gr-rz', 'aria-hidden': 'true' });
    const el = h('div', { class: 'gr-h', role: 'columnheader', tabindex: '-1' }, lab, ind, mb, rz);
    hcs.append(el);
    const H = { el, lab, ind, mb, rz, dc: -1, ver: -1, lv: -1 };
    hOwner.set(el, H);
    return H;
  }
  const hOwner = new WeakMap();

  function fillHead(H, dc) {
    H.dc = dc;
    H.ver = hver;
    const c = disp[dc], col = columns[c];
    const name = colLabel(col);
    placeHead(H, dc);
    H.el.setAttribute('aria-colindex', String(dc + 2));
    H.el.classList.toggle('gr-num', isNumCol(col));
    H.lab.textContent = name;
    H.mb.setAttribute('aria-label', `Column options for ${name}`);
    clear(H.ind);
    const si = view.sort.findIndex(k => k.col === c);
    if (sortingCol === c) H.ind.append(h('span', { class: 'gr-spin', role: 'img', 'aria-label': 'Sorting' }));
    else if (si >= 0) {
      H.ind.append(icon(view.sort[si].desc ? 'sortDown' : 'sortUp', 14));
      if (view.sort.length > 1) H.ind.append(h('span', { class: 'gr-pr', text: String(si + 1) }));
    }
    H.el.setAttribute('aria-sort', si < 0 ? 'none' : view.sort[si].desc ? 'descending' : 'ascending');
    if (view.filters.some(f => f.col === c)) H.ind.append(icon('filter', 14));
    if (editMode && model && !model.updatable(c)) H.ind.append(h('span', { class: 'gr-lock', role: 'img', 'aria-label': 'Read-only' }, icon('lock', 14)));
  }

  function decorateHead(H, dc) {
    const act = active.row === -1 && active.col === dc;
    H.el.tabIndex = act ? 0 : -1;
    H.el.classList.toggle('gr-drag', !!(drag && drag.started && drag.from === dc));
  }

  function rowHeadState(R, e) {
    let text, cls = 'gr-rh';
    let title = '';
    if (e < 0) {
      text = 'New';
      cls += ' gr-new';
      const n = model && model.note('i:' + (-1 - e));
      if (n) { cls += n.status === 'unknown' ? ' gr-unk' : ' gr-err'; title = n.message; }
    } else {
      const id = editMode ? pkOf(e) : null;
      const del = id && model.isDeleted(id);
      text = del ? 'Deleted' : fmtInt(R.p + 1);
      if (del) cls += ' gr-delh';
      if (unknownRows.has(e)) { cls += ' gr-unk'; title = TEXTS.unknown; }
      else if (pinned.has(e)) { cls += ' gr-new'; title = TEXTS.created; }
      if (id) {
        const n = model.note('d:' + id) ?? model.note('u:' + id);
        if (n) { cls += n.status === 'unknown' ? ' gr-unk' : ' gr-err'; title = n.message; }
        else if (model.fixed(id) === TEXTS.unknown) { cls += ' gr-unk'; title = TEXTS.unknown; }
        else if (model.fixed(id) && !pinned.has(e)) title = model.fixed(id);
      }
    }
    return { text, cls, title };
  }

  function renderRows(first, last, c0, c1, sl) {
    const keep = new Map();
    for (const [p, R] of rowMap) if (p >= first && p <= last) keep.set(p, R); else releaseRow(R);
    rowMap.clear();
    for (let p = first; p <= last; p++) {
      let R = keep.get(p);
      if (!R) { R = freeRows.pop() ?? newRow(); R.ver = -1; }
      rowMap.set(p, R);
      fillRow(R, p, c0, c1, sl);
    }
  }

  function fillRow(R, p, c0, c1, sl) {
    const e = viewAt(p);
    R.el.hidden = false;
    put(R.el, 'transform', `translateY(${p * rowH - vTop}px)`);
    put(R.cs, 'transform', `translateX(${-sl}px)`);
    const fresh = R.e !== e || R.ver !== ver || R.p !== p;
    if (fresh) {
      for (const [, C] of R.cells) { C.el.hidden = true; R.free.push(C); }
      R.cells.clear();
      R.e = e; R.p = p; R.ver = ver; R.sv = -1;
      R.el.setAttribute('aria-rowindex', String(p + 2));
      const s = rowHeadState(R, e);
      R.rh.className = s.cls;
      R.rh.textContent = s.text;
      R.rhBase = s.cls;
      R.rhTitle = s.title;
      const del = e >= 0 && editMode && model && model.isDeleted(pkOf(e) ?? '');
      R.el.className = del ? 'gr-r gr-del' : 'gr-r';
    }
    if (R.lv !== lver) {
      // A new layout (column resize, row-number width) moves the cells; their text stays.
      R.lv = lver;
      put(R.rh, 'width', rnW + 'px');
      for (const [dc, C] of R.cells) placeCell(C, dc);
    }
    const row = rowAt(e);
    for (const [dc, C] of R.cells) if (dc < c0 || dc > c1) { if (C.el.contains(activeEl())) park(); C.el.hidden = true; R.cells.delete(dc); R.free.push(C); }
    let added = false;
    for (let dc = c0; dc <= c1 && dc < disp.length; dc++) {
      if (R.cells.has(dc)) continue;
      const C = R.free.pop() ?? newCell(R);
      if (!C.el.parentNode) R.cs.append(C.el);
      C.el.hidden = false;
      fillCell(C, row, e, dc);
      R.cells.set(dc, C);
      added = true;
    }
    if (added || R.sv !== selVer) decorateRow(R, p);
  }

  function placeCell(C, dc) {
    put(C.el, 'left', (rnW + xs[dc]) + 'px');
    put(C.el, 'width', wd[dc] + 'px');
  }

  function fillCell(C, row, e, dc) {
    const c = disp[dc];
    let f = fmt(row, c);
    // An edited lookup whose target's name is not known yet keeps its record link.
    if (f.cls === 'guid' && !f.icon && model && unnamedEdit(e, c, row)) {
      const lk = lookupOf(row, c);
      if (lk && recordUrl(lk.entity, lk.id, { known: o.known })) f = { text: f.text, cls: f.cls, icon: 'link', title: `${lk.entity} · ${lk.id}` };
    }
    C.dc = dc;
    C.f = f;
    placeCell(C, dc);
    C.el.setAttribute('aria-colindex', String(dc + 2));
    if (C.t.data !== f.text) C.t.data = f.text;
    const want = f.icon === 'link' ? 'link' : f.icon === 'warn' ? 'warn' : null;
    if (C.icName !== want) {
      if (C.ic) { C.ic.remove(); C.ic = null; }
      if (want) {
        C.ic = icon(want, 14, want === 'link' ? 'gr-lk' : 'gr-wn');
        C.el.insertBefore(C.ic, C.t);
      }
      C.icName = want;
    }
    let base = 'gr-c';
    if (f.cls) base += ' fc-' + f.cls;
    if (editMode && model) {
      if (e < 0) {
        const it = model.insert(-1 - e);
        const attr = model.attrOf(c);
        if (it && attr && it.cells.has(attr)) base += ' gr-chg';
        if (!model.creatable(c)) base += ' gr-ro';
      } else {
        const id = pkOf(e);
        const rec = id ? model.update(id) : null;
        const attr = model.attrOf(c);
        if (rec && attr && rec.cells.has(attr)) base += ' gr-chg';
      }
    }
    C.base = base;
    if (base.includes('gr-chg')) C.el.setAttribute('aria-description', 'Changed'); else C.el.removeAttribute('aria-description');
  }

  function decorateRow(R, p) {
    R.sv = selVer;
    const rowSel = ranges.some(g => p >= g.r0 && p <= g.r1 && g.c0 <= 0 && g.c1 >= disp.length - 1);
    const rhAct = active.row === p && active.col === -1;
    R.rh.className = R.rhBase + (rowSel ? ' gr-sel' : '');
    R.rh.tabIndex = rhAct ? 0 : -1;
    R.rh.setAttribute('aria-selected', rowSel ? 'true' : 'false');
    for (const [dc, C] of R.cells) {
      const sel = inRanges(ranges, p, dc);
      const act = active.row === p && active.col === dc;
      C.el.className = C.base + (sel ? ' gr-sel' : '') + (act ? ' gr-act' : '');
      C.el.setAttribute('aria-selected', sel ? 'true' : 'false');
      C.el.tabIndex = act ? 0 : -1;
    }
  }

  function renderEmpty() {
    let text = null, link = false;
    if (!vLen) {
      if (!complete && !data.length) text = TEXTS.loading;
      else if (view.filters.length || quickNeedle(view.quick)) { text = TEXTS.noMatch; link = true; }
      else text = TEXTS.noRows;
    }
    none.hidden = text == null;
    if (text == null) return;
    clear(none);
    none.append(h('span', { text }));
    if (link) none.append(h('button', { type: 'button', class: 'link', text: 'Clear filters', onclick: () => clearFilters() }));
  }

  // The roving tab stop (03 §7 ARIA): the active cell when it is rendered, else the grid itself.
  function syncTabStop() {
    const t = activeCellEl() ? -1 : 0;
    if (scroller.tabIndex !== t) scroller.tabIndex = t;
  }

  function activeCellEl() {
    if (active.row === -1) return active.col >= 0 ? headMap.get(active.col)?.el ?? null : null;
    const R = rowMap.get(active.row);
    if (!R) return null;
    if (active.col === -1) return R.rh;
    return R.cells.get(active.col)?.el ?? null;
  }

  // Scrolls the active cell into view (vertically and horizontally).
  function reveal(r, c) {
    measureLayout();
    const bodyH = Math.max(rowH, vh - headH);
    if (r >= 0) {
      const top = r * rowH;
      if (top < vTop) scroller.scrollTop = sMap.toPhys(top);
      else if (top + rowH > vTop + bodyH) scroller.scrollTop = sMap.toPhys(top + rowH - bodyH);
    }
    if (c >= 0 && c < disp.length) {
      const sl = scroller.scrollLeft || 0;
      const dataW = Math.max(0, vw - rnW);
      if (xs[c] < sl) scroller.scrollLeft = xs[c];
      else if (xs[c + 1] > sl + dataW) scroller.scrollLeft = Math.max(0, Math.min(xs[c], xs[c + 1] - dataW));
    }
    render();
  }

  // Makes (r, c) the active cell, scrolls it into view and focuses it.
  function setActive(r, c, { focus = true } = {}) {
    active = { row: r, col: c };
    selVer++;
    reveal(r, c);
    if (focus) { const el = activeCellEl(); if (el) focusEl(el); else park(); }
  }

  // ---- selection -------------------------------------------------------------------------------------------------
  function clampSelection() {
    const maxR = vLen - 1, maxC = disp.length - 1;
    active = { row: Math.max(-1, Math.min(active.row, maxR)), col: Math.max(-1, Math.min(active.col, maxC)) };
    anchor = { row: Math.max(0, Math.min(anchor.row, Math.max(0, maxR))), col: Math.max(0, Math.min(anchor.col, Math.max(0, maxC))) };
    ranges = maxR < 0 || maxC < 0 ? [] : ranges.filter(g => g.r0 <= maxR && g.c0 <= maxC).map(g => ({ r0: g.r0, r1: Math.min(g.r1, maxR), c0: g.c0, c1: Math.min(g.c1, maxC) }));
    selVer++;
    selectionChanged();
  }

  // Clears the selection after a view change; the active cell keeps its position (a header stays a header), clamped
  // to the view, as a spreadsheet keeps it after a sort.
  function resetSelection() {
    ranges = [];
    const maxR = vLen - 1, maxC = disp.length - 1;
    active = { row: Math.max(-1, Math.min(active.row, maxR)), col: Math.max(-1, Math.min(active.col, maxC)) };
    if (active.row === -1 && active.col === -1) active.col = maxC >= 0 ? 0 : -1;
    anchor = { row: Math.max(0, active.row), col: Math.max(0, active.col) };
    selVer++;
    selectionChanged();
  }

  function select(newRanges, act) {
    ranges = newRanges;
    if (act) active = act;
    selVer++;
    render();
    selectionChanged();
  }

  const allRange = () => ({ r0: 0, r1: vLen - 1, c0: 0, c1: disp.length - 1 });
  function selectAll() {
    if (!vLen || !disp.length) return;
    anchor = { row: 0, col: 0 };
    select([allRange()]);
    if (editMode) renderEbar();
  }

  // Statistics of the selection, in slices for large selections (03 §7 status bar; 03 §13).
  let selTimer = null;
  function selectionChanged() {
    if (selTimer) return;
    selTimer = setTimeout(() => { selTimer = null; computeStats(); }, 0);
  }
  async function computeStats() {
    const token = ++statsTok;
    const cells = selectionCount(ranges);
    const lay = selectionLayout(ranges);
    const info = { cells, rows: lay.nRows, cols: lay.cols.length, stats: null, text: '' };
    if (cells < 2 || typeof o.onSelection !== 'function') { try { o.onSelection?.(info); } catch { /* caller's */ } if (editMode) renderEbar(); return; }
    const st = newStats();
    const measures = lay.cols.map(dc => isMeasure(columns[disp[dc]]));
    let n = 0, deadline = now() + SLICE_MS;
    for (const [a, b] of lay.rows) {
      for (let p = a; p <= b; p++) {
        const row = rowAt(viewAt(p));
        for (let j = 0; j < lay.cols.length; j++) {
          const dc = lay.cols[j];
          if (ranges.length > 1 && !inRanges(ranges, p, dc)) continue;
          addStat(st, row[disp[dc]], measures[j]);
        }
        if (cells > BIG_STATS && (++n & 255) === 0 && now() > deadline) {
          await yieldToUi();
          if (token !== statsTok || destroyed) return;
          deadline = now() + SLICE_MS;
        }
      }
    }
    if (token !== statsTok) return;
    info.stats = finishStats(st);
    info.text = statsText(info.stats);
    try { o.onSelection(info); } catch { /* caller's */ }
    if (editMode) renderEbar();
  }

  // The selected view positions (sorted) and displayed columns; without a selection the active cell.
  function selectedLayout() {
    const rs = ranges.length ? ranges : active.row >= 0 && active.col >= 0 ? [{ r0: active.row, r1: active.row, c0: active.col, c1: active.col }] : [];
    return { rs, ...selectionLayout(rs) };
  }
  function selectedRows() {
    const { rows } = selectedLayout();
    const out = [];
    for (const [a, b] of rows) for (let p = a; p <= b; p++) out.push(p);
    if (!out.length && active.row >= 0) out.push(active.row);
    return out;
  }

  // ---- copy --------------------------------------------------------------------------------------------------------
  // Copies the selection as TSV (03 §7, §7.1); returns the copy promise.
  function copy(headers = false) {
    const { rs, rows, cols, nRows } = selectedLayout();
    if (!rs.length || !cols.length) return Promise.resolve(false);
    const cells = selectionCount(rs);
    const inc = !!incomplete, loading = !complete;
    const report = ok => {
      if (ok) { const t = copiedText(nRows, headers ? 2 : cells, inc, loading); toast(t, { kind: 'ok' }); announce(t); }
      else toast(TEXTS.copyFail, { kind: 'error' });
      return ok;
    };
    if (cells === 1 && !headers) {
      const row = rowAt(viewAt(rs[0].r0));
      const f = fmtFull(row, disp[rs[0].c0]);
      return Promise.resolve(ioFn('copyText')(f.cls === 'null' ? '' : f.text)).then(report, () => report(false));
    }
    // The snapshot of the gesture: positions, their rows, the columns and the options, so a sort, filter, edit or
    // streamed batch during a sliced copy never mixes views.
    const positions = [];
    for (const [a, b] of rows) for (let p = a; p <= b; p++) positions.push(p);
    const snap = positions.map(p => rowAt(viewAt(p)));
    const cs = cols.map(dc => disp[dc]);
    const colObjs = cs.map(c => columns[c]);
    const multi = rs.length > 1;
    const opt = { ...foFull };
    const neu = neutral;
    // One TSV line (tsvLine's rules, built without an array of cells per row).
    const lineAt = i => {
      const row = snap[i], p = positions[i];
      opt.row = row;
      let line = '';
      for (let j = 0; j < cs.length; j++) {
        if (j) line += '\t';
        if (multi && !inRanges(rs, p, cols[j])) continue;
        const f = formatCell(row[cs[j]], colObjs[j], opt);
        if (f.cls !== 'null') line += tsvField(neu && needsNeutral(f.cls) ? neutralize(f.text) : f.text);
      }
      return line;
    };
    return copyLines(positions.length, cells, headers ? tsvHeader(colObjs, neu) : null, lineAt, report);
  }

  // Copies n lines (lineAt(i)) and an optional header line as text: up to BIG_COPY cells at once; above that the Blob
  // promise of util.copyBlob (called in the gesture) is built in slices, behind a 'Copying…' toast with progress and
  // Cancel after PROGRESS_MS (03 §13; Cancel leaves the clipboard unchanged).
  function copyLines(n, cells, header, lineAt, report) {
    if (cells <= BIG_COPY) {
      const lines = header != null ? [header] : [];
      for (let i = 0; i < n; i++) lines.push(lineAt(i));
      return Promise.resolve(ioFn('copyText')(lines.join('\r\n'))).then(report, () => report(false));
    }
    let made = 0, cancelled = false, prog = null;
    const t0 = now();
    const blob = (async () => {
      const parts = header != null ? [header] : [];
      let deadline = now() + SLICE_MS;
      try {
        for (let i = 0; i < n; i++) {
          parts.push(lineAt(i));
          made = i + 1;
          if ((i & 127) === 0 && now() > deadline) {
            if (!prog && now() - t0 > PROGRESS_MS) {
              prog = toast(TEXTS.copying, { kind: 'info', sticky: true, progress: () => Math.round((made / n) * 100), action: { label: 'Cancel', run: () => { cancelled = true; } } });
            }
            await yieldToUi();
            if (cancelled || destroyed) throw new Error(TEXTS.copyCancelled);
            deadline = now() + SLICE_MS;
          }
        }
      } finally {
        try { prog?.dismiss?.(); } catch { /* the shell's */ }
      }
      return new Blob([parts.join('\r\n')], { type: 'text/plain' });
    })();
    const end = ok => {
      if (destroyed) return false;
      if (!cancelled) return report(ok);
      toast(TEXTS.copyCancelled, { kind: 'info' });
      return false;
    };
    return Promise.resolve(ioFn('copyBlob')(blob, 'text/plain')).then(end, () => end(false));
  }

  // The payload of the selection for actions.copyAs (export.js formats).
  // An export.js ExportTable of view rows and displayed columns (export.js exportTable reads `indexes`; its formatCell
  // options are the grid's own, so copies show exactly what the cells show).
  function tableOf(dcs, rows, selected, total = rows.length) {
    return {
      title: label, columns: dcs.map(dc => columns[disp[dc]]), indexes: dcs.map(dc => disp[dc]), rows,
      widths: dcs.map(dc => wd[dc]), total, filtered: total > rows.length, selected,
      friendly, tz, dateFormat, label: labelHook, known: o.known, neutralize: neutral, incomplete, source,
    };
  }

  // The selected cells for actions.copyAs: the selection's rows and columns, selected(i, j) telling
  // the cells of a multi-range selection apart.
  function selectedPayload() {
    const { rs, rows, cols } = selectedLayout();
    const positions = [];
    for (const [a, b] of rows) for (let p = a; p <= b; p++) positions.push(p);
    const multi = rs.length > 1;
    return tableOf(cols, positions.map(p => rowAt(viewAt(p))), (i, j) => !multi || inRanges(rs, positions[i], cols[j]));
  }

  // Every row of the view (rows after the quick filter, column filters and sort, in view order).
  function viewRows() {
    const rows = new Array(vLen);
    for (let p = 0; p < vLen; p++) rows[p] = rowAt(viewAt(p));
    return rows;
  }

  // The whole view of one column (header menu Copy column ▸, 03 §7.1).
  function columnPayload(dc) {
    return tableOf([dc], viewRows(), null, totalRows());
  }

  // Copy column ▸ Copy values: the column's displayed values in the whole view, from a snapshot (as copy()).
  function copyColumnValues(dc) {
    const c = disp[dc], col = columns[c];
    const snap = viewRows();
    const n = snap.length;
    const opt = { ...foFull };
    const neu = neutral, inc = !!incomplete, loading = !complete;
    const lineAt = i => {
      opt.row = snap[i];
      const f = formatCell(snap[i][c], col, opt);
      return f.cls === 'null' ? '' : tsvField(neu && needsNeutral(f.cls) ? neutralize(f.text) : f.text);
    };
    const report = ok => {
      if (ok) { const t = copiedText(n, 2, inc, loading); toast(t, { kind: 'ok' }); announce(t); }
      else toast(TEXTS.copyFail, { kind: 'error' });
      return ok;
    };
    return copyLines(n, n, null, lineAt, report);
  }

  // ---- records -------------------------------------------------------------------------------------------------
  // The record a cell's row belongs to (03 §7 Open record): {entity, id} from the source table of the cell's alias;
  // activitypointer rows take their activitytypecode (hidden column) as the table.
  function recordOf(row, c) {
    const tables = source && Array.isArray(source.tables) ? source.tables : [];
    if (!tables.length || !row) return null;
    const qual = columns[c] ? columns[c].qual ?? null : null;
    const t = tables.find(x => (x.qual ?? null) === qual) ?? tables[0];
    if (!isIdx(t.pkIndex)) return null;
    const id = row[t.pkIndex];
    if (!isGuid(id)) return null;
    let entity = t.entity;
    if (entity === 'activitypointer') {
      const ai = columns.findIndex(x => x && x.name === 'activitytypecode' && (x.qual ?? null) === (t.qual ?? null));
      if (ai >= 0 && typeof row[ai] === 'string' && row[ai]) entity = row[ai];
    }
    if (model && model.isSynthetic(row)) return null;
    return { entity, id: String(id).toLowerCase(), pkName: columns[t.pkIndex]?.attr?.logicalName ?? null };
  }

  // The lookup target of a cell (03 §7 Open <lookup> record): ref.entity, the type companion or the single target.
  function lookupOf(row, c) {
    const col = columns[c];
    const v = row[c];
    if (!col || !isGuid(v)) return null;
    const a = col.attr;
    const isLookup = (a && LOOKUP_TYPES.has(a.type)) || col.ref;
    if (!isLookup || (a && a.isPk)) return null;
    const comp = col.companion;
    let ent = comp && isIdx(comp.type) && typeof row[comp.type] === 'string' && row[comp.type] ? row[comp.type] : null;
    if (!ent && col.ref && typeof col.ref.entity === 'string') ent = col.ref.entity;
    if (!ent && a && Array.isArray(a.targets) && a.targets.length === 1) ent = a.targets[0];
    return ent ? { entity: ent, id: v.toLowerCase() } : null;
  }

  function openLink(rec) {
    const url = rec ? recordUrl(rec.entity, rec.id, { known: o.known }) : null;
    if (!url) { toast(TEXTS.noRecord, { kind: 'info' }); return; }
    try { ioFn('openUrl')(url, { known: o.known }); } catch (e) { toast(e.message, { kind: 'error' }); }
  }

  // ---- context menus ---------------------------------------------------------------------------------------------
  // A menu row of an export.js copy format; `payload` is a table or a function (light) -> table, called with true for
  // the enabled state (columns only) and with false when the item runs, so a menu never copies a whole view to open.
  const copyItem = (format, labelText, payload) => {
    const get = typeof payload === 'function' ? payload : () => payload;
    const st = (() => { try { return actions.copyState?.(format, get(true)) ?? null; } catch { return null; } })();
    return {
      label: labelText, disabled: typeof actions.copyAs !== 'function' || !!(st && st.disabled), title: st && st.title ? st.title : undefined,
      run: () => actions.copyAs(format, get(false)),
    };
  };

  function cellMenuItems(p, dc) {
    const e = viewAt(p);
    const row = rowAt(e);
    const c = disp[dc], col = columns[c];
    const payload = selectedPayload();
    const oneCol = payload.indexes.length === 1;
    const v = row[c];
    const items = [
      { label: 'Copy', kbd: titleKey('gridCopy'), run: () => copy(false) },
      { label: 'Copy with headers', kbd: titleKey('gridCopyHeaders'), run: () => copy(true) },
      copyItem('csv', 'Copy as CSV', payload),
      copyItem('json', 'Copy as JSON', payload),
      copyItem('markdown', 'Copy as Markdown', payload),
      oneCol ? copyItem('inlist', 'Copy as IN list', payload) : { label: 'Copy as IN list', disabled: true, title: TEXTS.oneColumn },
      oneCol ? copyItem('fetchin', 'Copy as FetchXML in condition', payload) : { label: 'Copy as FetchXML in condition', disabled: true, title: TEXTS.oneColumn },
      '-',
      { label: 'Filter to this value', run: () => filterToValue(c, v, row, false) },
      { label: 'Exclude this value', run: () => filterToValue(c, v, row, true) },
      '-',
    ];
    const rec = e >= 0 ? recordOf(row, c) : null;
    const recUrl = rec ? recordUrl(rec.entity, rec.id, { known: o.known }) : null;
    items.push({ label: 'Open record', icon: 'open', disabled: !recUrl, title: recUrl ? undefined : TEXTS.noRecord, run: () => openLink(rec) });
    const lk = lookupOf(row, c);
    if (lk) {
      const lu = recordUrl(lk.entity, lk.id, { known: o.known });
      items.push({ label: `Open ${colLabel(col)} record`, icon: 'link', disabled: !lu, title: lu ? undefined : TEXTS.noRecord, run: () => openLink(lk) });
    }
    items.push({ label: 'Copy record URL', disabled: !recUrl, title: recUrl ? undefined : TEXTS.noRecord, run: () => Promise.resolve(ioFn('copyText')(recUrl)).then(ok => toast(ok ? 'Copied the record URL.' : TEXTS.copyFail, { kind: ok ? 'ok' : 'error' })) });
    items.push({
      label: 'Create SELECT for this record', disabled: !rec || typeof actions.newQuery !== 'function',
      title: !rec ? TEXTS.noRecord : undefined,
      run: () => actions.newQuery(selectFor(rec)),
    });
    items.push('-');
    items.push({ label: 'Show row details', disabled: typeof actions.rowDetails !== 'function', run: () => actions.rowDetails({ row, position: p, entry: e }) });
    items.push({
      label: 'Show cell text', disabled: typeof actions.cellText !== 'function',
      run: () => { const f = fmtFull(row, c); const t = f.cls === 'null' ? '' : f.text; actions.cellText(t, viewerKind(col, t)); },
    });
    if (editMode && model) {
      items.push('-');
      const dup = duplicateState();
      items.push({ label: 'Duplicate row', icon: 'copy', disabled: dup.disabled, title: dup.title, run: () => duplicateRows() });
      const del = deleteState();
      items.push({ label: del.label, icon: 'trash', disabled: del.disabled, title: del.title, run: () => toggleDeleteRows() });
    }
    return items;
  }

  // The first key of a KEYMAP command for a menu row ('Ctrl+C').
  const titleKey = id => keyLabel(id, mac).split(/(?<!\+),\s+/)[0] || undefined;

  // `SELECT * FROM [table] WHERE [pk] = N'<id>'` (03 §7 Create SELECT for this record; sqlStr/sqlIdent only).
  function selectFor(rec) {
    let pk = rec.pkName;
    try { const ei = meta?.findEntity?.(rec.entity); if (ei && ei.primaryIdAttribute) pk = ei.primaryIdAttribute; } catch { /* metadata not loaded */ }
    if (!pk) pk = rec.entity + 'id';
    return `SELECT * FROM ${sqlIdent(rec.entity)} WHERE ${sqlIdent(pk)} = ${sqlStr(rec.id)}`;
  }

  function filterToValue(c, v, row, exclude) {
    const col = columns[c];
    const key = filterKey(v, col);
    const lab = valueLabel(row, c);
    const rest = view.filters.filter(f => f.col !== c);
    const cur = view.filters.find(f => f.col === c);
    if (exclude) {
      // Excluding only ever hides rows: an 'in' filter loses the value (and keeps hiding what it hid), an 'out'
      // filter gains it.
      if (cur && cur.mode === 'in') {
        const keep = cur.keys.map((k, i) => [k, cur.labels[i] ?? '']).filter(([k]) => k !== key);
        view.filters = [...rest, { col: c, mode: 'in', keys: keep.map(x => x[0]), labels: keep.map(x => x[1]) }];
      } else if (cur && cur.mode === 'out') {
        view.filters = [...rest, cur.keys.includes(key) ? cur : { col: c, mode: 'out', keys: [...cur.keys, key], labels: [...cur.labels, lab] }];
      } else view.filters = [...rest, { col: c, mode: 'out', keys: [key], labels: [lab] }];
    } else {
      view.filters = [...rest, { col: c, mode: 'in', keys: [key], labels: [lab] }];
    }
    filtersChanged();
  }

  // A value's label in filter lists and pills: the displayed text, '(NULL)' or '(Empty)'.
  function valueLabel(row, c) { return valueEntry(row, c).label; }
  // The label and checklist rank of a value: 0 a value, 1 one whose text starts with '(', 2 NULL, 3 empty (these
  // flags, never the label, tell NULL and empty apart from real values that read '(NULL)').
  function valueEntry(row, c) {
    if (row[c] == null) return { label: '(NULL)', rank: 2 };
    const f = fmt(row, c);
    if (f.cls === 'empty' || f.text === '') return { label: '(Empty)', rank: 3 };
    const label = truncateText(f.text, 80);
    return { label, rank: label.startsWith('(') ? 1 : 0 };
  }

  function headerMenuItems(dc) {
    const c = disp[dc];
    const si = view.sort.find(k => k.col === c);
    const n = disp.length;
    const payload = light => (light ? tableOf([dc], [], null, 0) : columnPayload(dc));
    return [
      {
        label: 'Sort', icon: 'sortUp', items: [
          { label: 'Sort ascending', checked: !!(si && !si.desc), run: () => setSort(si && !si.desc && view.sort.length === 1 ? [] : [{ col: c, desc: false }]) },
          { label: 'Sort descending', checked: !!(si && si.desc), run: () => setSort(si && si.desc && view.sort.length === 1 ? [] : [{ col: c, desc: true }]) },
          { label: 'Clear sort', disabled: !view.sort.length, run: () => setSort([]) },
        ],
      },
      { label: 'Filter by value…', icon: 'filter', run: () => openFilter(c, headMap.get(dc)?.el ?? scroller) },
      '-',
      { label: 'Move left', icon: 'left', disabled: dc === 0, run: () => moveDisplayed(dc, dc - 1) },
      { label: 'Move right', icon: 'right', disabled: dc >= n - 1, run: () => moveDisplayed(dc, dc + 1) },
      { label: 'Move to start', disabled: dc === 0, run: () => moveDisplayed(dc, 0) },
      { label: 'Move to end', disabled: dc >= n - 1, run: () => moveDisplayed(dc, n - 1) },
      '-',
      { label: 'Hide', icon: 'eye', disabled: n <= 1, title: n <= 1 ? 'The last column cannot be hidden.' : undefined, run: () => hideColumn(c) },
      { label: 'Show all columns', disabled: !view.hidden.length, run: () => showAllColumns() },
      '-',
      {
        label: 'Copy column', icon: 'copy', items: [
          { label: 'Copy values', run: () => copyColumnValues(dc) },
          copyItem('inlist', 'Copy as IN list', payload),
          copyItem('fetchin', 'Copy as FetchXML in condition', payload),
        ],
      },
    ];
  }

  function openHeaderMenu(dc, at) {
    if (!shell || typeof shell.menu !== 'function') return;
    const H = headMap.get(dc);
    const trigger = H ? H.mb : scroller;
    shell.menu(at ?? trigger, headerMenuItems(dc), { align: 'start', label: `Options for ${colLabel(columns[disp[dc]])}`, trigger: H ? H.el : scroller });
  }

  function openCellMenu(p, dc, e) {
    if (!shell) return;
    const items = cellMenuItems(p, dc);
    if (e && typeof shell.contextMenu === 'function') shell.contextMenu(e, items);
    else if (typeof shell.menu === 'function') {
      const el = activeCellEl();
      const r = el ? el.getBoundingClientRect() : scroller.getBoundingClientRect();
      shell.menu({ x: r.left + 8, y: r.bottom }, items, { label: 'Cell options', trigger: el ?? scroller, scrollAnchor: scroller });
    }
  }

  // ---- view changes ----------------------------------------------------------------------------------------------
  function setSort(sort) {
    view.sort = sort;
    sortCache = null;
    hver++;
    emitView();
    resetSelection();
    return recompute();
  }

  function filtersChanged() {
    hver++;
    emitView();
    renderFbar();
    resetSelection();
    return recompute();
  }

  function moveDisplayed(from, to) {
    const n = disp.length;
    if (from === to || to < 0 || to >= n) return;
    const c = disp[from];
    const row = active.row;
    const focused = root.contains(activeEl());
    view.order = moveColumn(view, from, to);
    hver++; ver++;
    emitView();
    measureLayout();
    resetSelection();
    const pos = displayColumns(view).indexOf(c);
    if (focused) setActive(row, pos);
    else { active = { row, col: pos }; render(); }
    announce(movedText(colLabel(columns[c]), pos, n));
  }

  function hideColumn(c) {
    if (displayColumns(view).length <= 1) return;
    view.hidden = [...view.hidden, c];
    hver++; ver++;
    emitView();
    measureLayout();
    resetSelection();
    renderFbar();
    if (quickNeedle(view.quick)) recompute(); else render();
  }

  function showAllColumns() {
    if (!view.hidden.length) return;
    view.hidden = [];
    hver++; ver++;
    measureWidths(false);
    emitView();
    measureLayout();
    resetSelection();
    renderFbar();
    if (quickNeedle(view.quick)) recompute(); else render();
  }

  // Clears the column filters and the quick filter (the grid's 'Clear filters', 'Show' and 'No rows match' links);
  // a cleared quick filter is reported through opts.onQuick('') and onView.
  function clearFilters() {
    if (!view.filters.length && !view.quick) return Promise.resolve();
    const hadQuick = view.quick !== '';
    view.filters = [];
    view.quick = '';
    if (quickTimer) { clearTimeout(quickTimer); quickTimer = null; }
    if (hadQuick) { try { o.onQuick?.(''); } catch { /* caller's */ } }
    return filtersChanged();
  }

  function setQuick(text) {
    const q = typeof text === 'string' ? text : '';
    if (q === view.quick) return;
    view.quick = q;
    if (quickTimer) clearTimeout(quickTimer);
    quickTimer = setTimeout(() => { quickTimer = null; emitView(); resetSelection(); recompute(); }, 150);
  }

  // ---- filter bar (03 §7 toolbar pills) ------------------------------------------------------
  // Pills are kept per column, so an open checklist stays anchored to its pill while the filter changes.
  const pillOf = new Map();
  const clearBtn = h('button', { type: 'button', class: 'link', text: 'Clear filters', onclick: () => clearFilters() });
  const hiddenBtn = h('button', { type: 'button', class: 'link', onclick: () => showAllColumns() });
  function renderFbar() {
    const want = new Set(view.filters.map(f => f.col));
    for (const [c, el] of pillOf) if (!want.has(c)) { el.remove(); pillOf.delete(c); }
    const order = [];
    for (const f of view.filters) {
      let el = pillOf.get(f.col);
      if (!el) {
        const c = f.col;
        el = h('button', { type: 'button', class: 'fp on', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: e => openFilter(c, e.currentTarget) },
          h('span', { class: 'k' }), h('span', { class: 'v' }), icon('chevron', 12));
        pillOf.set(c, el);
      }
      const name = colLabel(columns[f.col]);
      const v = filterPillText(f);
      const all = f.labels.slice(0, 20).join(', ') + (f.labels.length > 20 ? ', …' : '');
      el.setAttribute('title', `${name}: ${f.mode === 'out' ? 'not ' : ''}${all || 'None'}`);
      el.setAttribute('aria-label', `Filter on ${name}: ${v}`);
      el.children[0].textContent = name + ':';
      el.children[1].textContent = v;
      order.push(el);
    }
    if (view.filters.length) order.push(clearBtn); else clearBtn.remove();
    if (view.hidden.length) { hiddenBtn.textContent = hiddenText(view.hidden.length); order.push(hiddenBtn); } else hiddenBtn.remove();
    const cur = [...fbar.children];
    if (cur.length !== order.length || cur.some((el, i) => el !== order[i])) for (const el of order) fbar.appendChild(el);
    fbar.hidden = !order.length;
  }

  // ---- filter checklist popover -----------------------------------------------------------
  // Distinct values of column c with faceted counts (every other filter and the quick filter applied, the quick filter
  // through its memo), in checklist order. Over BIG_QUICK rows, or BIG_CELLS cells of quick filter work, the scan runs
  // in slices (03 §13) and a promise is returned (of null when alive() turns false or the rows are replaced); else the
  // list itself.
  function distinctValues(c, alive = () => true) {
    const compiled = compileFilters(view.filters, columns);
    const needle = quickNeedle(view.quick);
    const col = columns[c];
    const map = new Map();
    let qc = null, opts = null;
    if (needle) { quickPrep(needle); qc = quickCols(); opts = { ...fq }; }
    const n = data.length, gen = dataGen, sig0 = qSig;
    const scan = i => {
      if (gone.has(i)) return;
      const row = dataRow(i);
      if (compiled.length && !passesFilters(row, compiled, c)) return;
      if (needle && !quickPass(i, qc, opts, needle)) return;
      const k = filterKey(row[c], col);
      const ent = map.get(k);
      if (ent) ent.count++;
      else { const v = valueEntry(row, c); map.set(k, { key: k, label: v.label, rank: v.rank, count: 1, row, sk: null }); }
    };
    let unknown = 0;
    if (needle) for (let i = 0; i < n; i++) if (!qs[i]) unknown++;
    if (n <= BIG_QUICK && !(needle && quickBig(unknown))) {
      for (let i = 0; i < n; i++) scan(i);
      return facetOrder([...map.values()], c);
    }
    return (async () => {
      let i = 0;
      while (i < n) {
        const end = now() + SLICE_MS;
        do { scan(i); i++; } while (i < n && ((i & 255) || now() < end));
        if (i >= n) break;
        await yieldToUi();
        // Rows replaced, or the quick filter memo prepared for another needle or other displayed text meanwhile: the
        // scan's states would not fit it, so the scan stops (the checklist closes).
        if (!alive() || destroyed || gen !== dataGen || (needle && (qNeedle !== needle || qSig !== sig0))) return null;
      }
      return facetOrder([...map.values()], c);
    })();
  }

  // The checklist order: values, then values whose text starts with '(', then (NULL) and
  // (Empty); text values and Friendly labels in natural order (numeric runs as numbers, case and accents ignored),
  // other values (numbers, dates, GUIDs) in their type's order (01 §5.2).
  function facetOrder(list, c) {
    const spec = sortSpec(columns, c, friendly);
    const text = spec.type.dt === 'string';
    for (const v of list) if (v.rank < 2) v.sk = sortKey(spec.get(v.row), spec.type, spec.ai);
    const nat = natural();
    return list.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.rank >= 2) return 0;
      const r = (text ? nat.compare(a.label, b.label) : 0) || cmpKeys(a.sk, b.sk, spec.type, spec.ai);
      return r || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
    });
  }

  // The next filter of column c after the checklist changed `keys` of its current filter `f` (null: no filter):
  // 'out' with nothing excluded and 'in' with every known value are no filter.
  function nextFilter(f, values) {
    if (!f) return null;
    if (f.mode === 'out' && !f.keys.length) return null;
    if (f.mode === 'in' && values.length) {
      const set = new Set(f.keys);
      if (values.every(v => set.has(v.key))) return null;
    }
    return f;
  }

  let filterPop = null;
  // The open checklist follows its anchor after each re-render.
  function repositionPop() {
    if (!filterPop || typeof filterPop.reposition !== 'function') return;
    try { filterPop.reposition(); } catch { /* closed meanwhile */ }
  }

  // The sort and filter checklist popover of column c (03 §7 Filter by value).
  function openFilter(c, anchorEl) {
    if (!shell || typeof shell.popover !== 'function') return null;
    const col = columns[c];
    const name = colLabel(col);
    // The values come at once, or for a large set after a sliced scan behind a 'Loading values…' row (03 §13).
    let values = [], loading = false, popClosed = false;
    const labelOfKey = new Map();
    const setValues = list => { values = list; labelOfKey.clear(); for (const v of list) labelOfKey.set(v.key, v.label); };
    const got = distinctValues(c, () => !popClosed);
    if (Array.isArray(got)) setValues(got); else loading = true;
    let search = '';
    let shown = [];
    const cur = () => view.filters.find(f => f.col === c) ?? null;
    const isChecked = key => { const f = cur(); return !f ? true : f.mode === 'in' ? f.keys.includes(key) : !f.keys.includes(key); };
    const setFilter = f => {
      const rest = view.filters.filter(x => x.col !== c);
      const nf = nextFilter(f, values);
      // A key the faceted list lacks (hidden by another filter) keeps the label its filter had.
      const old = cur();
      const oldLabel = k => { const i = old ? old.keys.indexOf(k) : -1; return i >= 0 ? old.labels[i] ?? '' : ''; };
      view.filters = nf ? [...rest, { col: c, mode: nf.mode, keys: nf.keys, labels: nf.keys.map(k => labelOfKey.get(k) ?? oldLabel(k)) }] : rest;
      filtersChanged();
      refresh();
    };
    const toggle = key => {
      const f = cur();
      if (!f) return setFilter({ mode: 'out', keys: [key] });
      const keys = f.keys.includes(key) ? f.keys.filter(k => k !== key) : [...f.keys, key];
      return setFilter({ mode: f.mode, keys });
    };
    const matching = () => { const q = quickNeedle(search); return q ? values.filter(v => collKeyAI(v.label).includes(q)) : values; };
    // Checks (on) or unchecks every key of `keys`.
    const setMany = (keys, on) => {
      const f = cur() ?? { mode: 'out', keys: [] };
      const set = new Set(f.keys);
      for (const k of keys) { if ((f.mode === 'in') === on) set.add(k); else set.delete(k); }
      setFilter({ mode: f.mode, keys: [...set] });
    };
    const sortBtns = [false, true].map(desc => {
      const ck = h('span', { class: 'ck' });
      const b = h('button', {
        type: 'button', class: 'mi', 'aria-pressed': 'false',
        onclick: () => { const k = view.sort.find(x => x.col === c); const on = !!(k && k.desc === desc && view.sort.length === 1); setSort(on ? [] : [{ col: c, desc }]); refresh(); },
      }, ck, h('span', { class: 'si' }, icon(desc ? 'sortDown' : 'sortUp', 16)), desc ? 'Sort descending' : 'Sort ascending');
      return { desc, b, ck };
    });
    const input = h('input', { type: 'search', placeholder: `Search ${name}`, 'aria-label': `Search ${name}`, autocomplete: 'off', spellcheck: 'false' });
    const list = h('div', { class: 'pop-list', role: 'group', 'aria-label': `Values of ${name}` });
    const all = h('input', { type: 'checkbox', onchange: () => { if (loading) return; const m = matching(); setMany(m.map(v => v.key), !(m.length > 0 && m.every(v => isChecked(v.key)))); } });
    const allText = h('span', { class: 'v' });
    const node = h('div', { style: 'display:contents' },
      ...sortBtns.map(s => s.b),
      h('div', { class: 'sep' }),
      h('label', { class: 'input' }, icon('search', 16), input),
      list,
      h('div', { class: 'pop-foot' },
        h('button', { type: 'button', class: 'btn subtle', text: 'Clear filter', onclick: () => setFilter(null) }),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn primary', text: 'Done', onclick: () => close(true) })));
    // The value rows for the current search (at most FILTER_SHOWN, then a note).
    function drawList() {
      clear(list);
      const m = matching();
      allText.textContent = search.trim() ? 'Select all search results' : 'Select all';
      all.disabled = loading;
      list.append(h('label', { class: 'pv all' }, all, allText));
      if (loading) { list.append(h('div', { class: 'pop-more', role: 'status', text: TEXTS.loadingValues })); shown = []; refresh(); return; }
      shown = m.slice(0, FILTER_SHOWN).map(v => {
        const cb = h('input', { type: 'checkbox', onchange: () => toggle(v.key) });
        list.append(h('label', { class: 'pv' }, cb, h('span', { class: 'v', title: v.label, text: v.label }), h('span', { class: 'n', text: fmtInt(v.count) })));
        return { v, cb };
      });
      if (m.length > shown.length) list.append(h('div', { class: 'pop-more', text: `${fmtInt(m.length - shown.length)} more values. Search to find them.` }));
      if (!m.length) list.append(h('div', { class: 'pop-more', text: 'No values match.' }));
      refresh();
    }
    // Check marks, the tri-state Select all and the sort toggles, updated in place (focus stays where it is).
    function refresh() {
      const m = matching();
      for (const { v, cb } of shown) cb.checked = isChecked(v.key);
      const allOn = m.length > 0 && m.every(v => isChecked(v.key));
      all.checked = allOn;
      all.indeterminate = !allOn && m.some(v => isChecked(v.key));
      for (const s of sortBtns) {
        const k = view.sort.find(x => x.col === c);
        const on = !!(k && k.desc === s.desc && view.sort.length === 1);
        clear(s.ck);
        if (on) s.ck.append(icon('check', 16));
        s.b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    input.addEventListener('input', () => { search = input.value; drawList(); });
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (loading) return;
      setFilter({ mode: 'in', keys: matching().filter(v => isChecked(v.key)).map(v => v.key) });
      close(true);
    });
    drawList();
    if (filterPop) { try { filterPop.close(); } catch { /* closed */ } }
    const pop = shell.popover(anchorEl, node, { label: `Sort and filter ${name}`, onClose: () => { popClosed = true; if (filterPop === pop) filterPop = null; } });
    filterPop = pop;
    if (loading) {
      got.then(list => {
        if (popClosed) return;
        if (!list) { close(false); return; }
        setValues(list);
        loading = false;
        drawList();
        repositionPop();
      }, () => { if (!popClosed) close(false); });
    }
    function close(focusAnchor) {
      pop.close();
      if (focusAnchor && anchorEl && typeof anchorEl.focus === 'function' && anchorEl.parentNode) focusEl(anchorEl);
    }
    return pop;
  }

  // ---- edit mode -------------------------------------------------------------------------------------------------
  // Whether this set can enter edit mode (03 §7.2 Eligibility) and why not.
  function editEligibility() {
    if (!complete) return { ok: false, reason: TEXTS.streaming };
    if (incomplete) return { ok: false, reason: TEXTS.incomplete };
    const t = source && Array.isArray(source.tables) ? source.tables[0] : null;
    if (!source || !source.editable || !t || !isIdx(t.pkIndex) || !t.entity) return { ok: false, reason: TEXTS.notEditable };
    if (t.synthetic === true) return { ok: false, reason: TEXTS.synthetic };
    const seen = new Set();
    for (let i = 0; i < data.length; i++) {
      if (gone.has(i)) continue;
      const id = normId(data[i][t.pkIndex]);
      if (id == null) continue;
      if (seen.has(id)) return { ok: false, reason: TEXTS.dupPk };
      seen.add(id);
    }
    return { ok: true, reason: null };
  }

  function buildPkIdx() {
    pkIdx = new Map();
    for (let i = 0; i < data.length; i++) { const id = model.rowId(data[i]); if (id != null && !gone.has(i)) pkIdx.set(id, i); }
  }

  // Enters or leaves edit mode; leaving with pending edits asks 'Discard N pending changes?' (03 §7.2).
  async function setEditMode(on) {
    if (on === editMode) return true;
    if (on) {
      const el = editEligibility();
      if (!el.ok) { toast(el.reason, { kind: 'info' }); return false; }
      if (!model) model = createEditModel(columns, source);
      buildPkIdx();
      for (const id of model.ids()) refreshOverlay(id);
      editMode = true;
      ebar.hidden = false;
      scroller.setAttribute('aria-readonly', 'false');
      hver++; ver++;
      insRows.clear();
      buildAll();
      render();
      emitCount();
      renderEbar();
      notifyEdits();
      return true;
    }
    // A review that is writing keeps edit mode, so its results reach the rows it changed.
    if (isBusy()) { status(TEXTS.reviewing); return false; }
    cancelEdit();
    const n = model ? model.counts().total : 0;
    if (n > 0) {
      const ok = shell && typeof shell.confirm === 'function' ? await shell.confirm({ title: discardTitle(n), ok: 'Discard', cancel: 'Keep editing', danger: true }) : false;
      if (!ok || isBusy()) return false;
    }
    discardEdits();
    editMode = false;
    ebar.hidden = true;
    scroller.setAttribute('aria-readonly', 'true');
    hver++; ver++;
    buildAll();
    render();
    emitCount();
    notifyEdits();
    return true;
  }

  // Discard all (03 §7.2); refused while a review runs (returns false), as every other change of the model is.
  function discardEdits() {
    if (isBusy()) { status(TEXTS.reviewing); return false; }
    cancelEdit();
    if (!model) return true;
    model.discardAll();
    overlays.clear();
    insRows.clear();
    sortCache = null;
    ver++;
    buildAll();
    clampSelection();
    render();
    emitCount();
    renderEbar();
    notifyEdits();
    return true;
  }

  const pendingCount = () => (model ? model.counts().total : 0);
  function notifyEdits() {
    try { o.onEdit?.({ pending: pendingCount(), counts: model ? model.counts() : { updated: 0, deleted: 0, created: 0, total: 0 } }); } catch { /* caller's */ }
  }

  // Applies a change of the edit model to the display. rows: new rows were added or removed (the view list is rebuilt;
  // a changed cell never moves its row, so the list and its reverse map stay).
  function editsChanged(ids = [], rows = false) {
    for (const id of ids) refreshOverlay(id);
    sortCache = null;
    ver++;
    if (rows) buildAll();
    render();
    emitCount();
    renderEbar();
    notifyEdits();
  }

  // The editable state of one cell: null when editable, else the reason.
  function cellLock(e, c) {
    if (!editMode || !model) return TEXTS.readOnlyCell;
    if (isBusy()) return TEXTS.reviewing;
    if (e < 0) return model.creatable(c) ? null : model.reason(c) ?? TEXTS.readOnlyCell;
    if (unknownRows.has(e)) return TEXTS.unknown;
    if (pinned.has(e)) return TEXTS.created;
    const row = data[e];
    if (model.isSynthetic(row)) return TEXTS.synthRow;
    const id = model.rowId(row);
    if (!id) return TEXTS.synthRow;
    if (model.fixed(id)) return model.fixed(id);
    if (model.isDeleted(id)) return 'Restore the row to edit it.';
    return model.updatable(c) ? null : model.reason(c) ?? TEXTS.readOnlyCell;
  }

  function optionsOf(col) {
    const a = col.attr;
    if (!a || !meta) return null;
    try {
      const s = typeof meta.optionsSync === 'function' ? meta.optionsSync(a.entity, a.logicalName) : null;
      if (Array.isArray(s)) return s;
      if (typeof meta.options === 'function') meta.options(a.entity, a.logicalName).then(() => { if (editing && editing.col === col) refillSelect(); }, () => {});
    } catch { /* no options */ }
    return null;
  }

  function refillSelect() {
    if (!editing || editing.kind !== 'select') return;
    fillSelect(editing.el, editing.col, editing.el.value);
  }

  // The options of a choice or Boolean editor: '(NULL)' (choices, or a Boolean that is NULL now), then every option
  // as 'Label (value)'; while options load, a disabled 'Loading options…' row.
  function fillSelect(sel, col, value) {
    clear(sel);
    const a = col.attr || {};
    const opts = optionsOf(col);
    const isBool = a.type === 'Boolean' || dtOfCol(col) === 'bit';
    if (!isBool || value === '') sel.append(h('option', { value: '', text: '(NULL)' }));
    const list = Array.isArray(opts) ? opts : isBool ? [{ value: 0, label: '0' }, { value: 1, label: '1' }] : [];
    if (!Array.isArray(opts) && !isBool) sel.append(h('option', { value: '#loading', text: 'Loading options…', disabled: true }));
    for (const x of list) sel.append(h('option', { value: String(x.value), text: x.label === String(x.value) ? x.label : `${x.label} (${x.value})` }));
    if (value !== '' && !list.some(x => String(x.value) === value)) sel.append(h('option', { value, text: value }));
    sel.value = value;
  }

  // Opens the cell editor on the active cell (03 §7.2: double-click, F2 or typing).
  function beginEdit(initial = null) {
    if (editing) return false;
    const p = active.row, dc = active.col;
    if (p < 0 || dc < 0 || p >= vLen || dc >= disp.length) return false;
    const e = viewAt(p), c = disp[dc], col = columns[c];
    const lock = cellLock(e, c);
    if (lock) { status(lock); return false; }
    const row = rowAt(e);
    const kind = editorKind(col);
    const target = col.companion && isIdx(col.companion.type) ? row[col.companion.type] : null;
    let el, text0 = '', multi = false;
    const pick = { on: false };   // a select's 'change' commits only after a pointer or a list-opening key
    if (kind === 'select') {
      el = h('select', { class: 'sel gr-ed', 'aria-label': `Edit ${colLabel(col)}` });
      const v = row[c];
      fillSelect(el, col, v == null ? '' : String(typeof v === 'boolean' ? (v ? 1 : 0) : v));
      // Chromium fires 'change' for every arrow key on a closed select: those only choose, and Enter, Tab or leaving
      // the editor commits; a choice made in the open list (pointer, Alt+Down, F4, Space) commits at once.
      el.addEventListener('pointerdown', () => { pick.on = true; });
      el.addEventListener('change', () => { if (pick.on) { pick.on = false; commitEdit(); } });
    } else {
      text0 = editText(row[c], col, tz, target);
      multi = usesTextarea(col, text0);
      if (multi) {
        el = h('textarea', { class: 'gr-ed', rows: '1', wrap: 'off', 'aria-label': `Edit ${colLabel(col)}`, spellcheck: 'false', autocomplete: 'off' });
        el.addEventListener('input', () => { if (editing && editing.el === el) placeEditor(); });
      } else {
        const type = kind === 'date' ? 'date' : kind === 'datetime' ? 'datetime-local' : 'text';
        el = h('input', { class: 'gr-ed', type, 'aria-label': `Edit ${colLabel(col)}`, spellcheck: 'false', autocomplete: 'off' });
        if (kind === 'datetime') el.setAttribute('step', '1');
        if (col.attr && LOOKUP_TYPES.has(col.attr.type)) el.setAttribute('placeholder', Array.isArray(col.attr.targets) && col.attr.targets.length > 1 ? 'table:GUID' : 'GUID');
      }
      el.value = text0;
    }
    // What the untouched editor holds, as the element reads it back (a textarea keeps LF for CR LF, a datetime-local
    // input may drop zero seconds): committing it unchanged changes nothing (02 §8.1 step 5: only real changes).
    const base = el.value;
    if (initial != null && kind === 'text') el.value = initial;
    el.addEventListener('keydown', ev => {
      if (kind === 'select') {
        if ((ev.altKey && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) || ev.key === 'F4' || ev.key === ' ') pick.on = true;
        else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') pick.on = false;
      }
      onEditorKey(ev);
    });
    el.addEventListener('blur', () => { if (editing && editing.el === el) commitEdit({ blur: true }); });
    // A text whose line breaks are all CR LF gets them back after the textarea's LF-only editing.
    const crlf = multi && text0.includes('\r\n') && !/(^|[^\r])\n|\r(?!\n)/.test(text0);
    editing = { p, dc, e, c, col, el, kind, target, base, multi, crlf };
    viewEl.append(el);
    placeEditor();
    focusEl(el);
    if (kind === 'text' && initial == null && typeof el.select === 'function') el.select();
    return true;
  }

  // Inserts a line break at the caret of a textarea editor (Alt+Enter; Shift+Enter is the textarea's own), keeping
  // the native undo where the browser offers insertText.
  function insertNewline(el) {
    let done = false;
    try { done = typeof document !== 'undefined' && typeof document.execCommand === 'function' && document.execCommand('insertText', false, '\n') === true; } catch { done = false; }
    if (!done) {
      const v = el.value;
      const a = Number.isInteger(el.selectionStart) ? el.selectionStart : v.length;
      const b = Number.isInteger(el.selectionEnd) ? el.selectionEnd : a;
      if (typeof el.setRangeText === 'function') el.setRangeText('\n', a, b, 'end');
      else { el.value = v.slice(0, a) + '\n' + v.slice(b); try { el.selectionStart = el.selectionEnd = a + 1; } catch { /* no caret */ } }
    }
    placeEditor();
  }

  function placeEditor() {
    if (!editing) return;
    const { p, dc, el } = editing;
    const pos = posOf(editing.e);
    if (pos !== p || dc >= disp.length || disp[dc] !== editing.c) { cancelEdit(); return; }
    const y = headH + p * rowH - vTop;
    const x = rnW + xs[dc] - (scroller.scrollLeft || 0);
    // A cell scrolled out of view commits its edit (after this render).
    if (y < headH - rowH / 2 || y > vh || x + wd[dc] < rnW || x > vw) {
      el.hidden = true;
      queueMicrotask(() => { if (editing && editing.el === el) commitEdit({ blur: true }); });
      return;
    }
    el.hidden = false;
    let w = wd[dc], ht = rowH;
    if (editing.multi) {
      // A multi-line text grows downwards to EDIT_LINES lines (then scrolls), within the grid's view.
      const lineH = Math.round(fontSize * 1.5);
      const lines = Math.min(EDIT_LINES, 1 + countBreaks(el.value));
      if (lines > 1) { ht = rowH + (lines - 1) * lineH; w = Math.max(w, 240); }
      ht = Math.max(rowH, Math.min(ht, vh - y));
      w = Math.max(wd[dc], Math.min(w, vw - x));
      el.style.setProperty('--gr-ed-lh', lineH + 'px');
    }
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = w + 'px';
    el.style.height = ht + 'px';
  }

  // The number of line breaks in a text (CR LF counts once).
  function countBreaks(t) {
    let n = 0;
    for (let i = 0; i < t.length; i++) {
      const ch = t.charCodeAt(i);
      if (ch === 10) n++;
      else if (ch === 13) { n++; if (t.charCodeAt(i + 1) === 10) i++; }
    }
    return n;
  }

  // The editor's own keys; Escape normally arrives through the shell's cascade (step 3) first, which cancels it.
  function onEditorKey(e) {
    if (!editing) return;
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(true); return; }
    if (e.key === 'Enter') {
      if (editing.multi && (e.shiftKey || e.altKey)) {
        // Shift+Enter is the textarea's own line break; Alt+Enter inserts one too (as in a spreadsheet cell).
        e.stopPropagation();
        if (e.altKey) { e.preventDefault(); insertNewline(editing.el); }
        return;
      }
      e.preventDefault(); e.stopPropagation(); commitEdit({ move: 0 }); return;
    }
    if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); commitEdit({ move: e.shiftKey ? -1 : 1 }); }
  }

  function cancelEdit(focus = false) {
    if (!editing) return false;
    const el = editing.el;
    editing = null;
    el.remove();
    if (focus) { const a = activeCellEl(); if (a) focusEl(a); else park(); }
    return true;
  }

  // Validates and stores the editor's value; Tab moves to the next cell (03 §7.2: Enter commits, Escape cancels).
  function commitEdit({ move = null, blur = false } = {}) {
    if (!editing) return true;
    const ed = editing;
    let text = ed.el.value;
    // An untouched editor changes nothing: no line break is lost, no whitespace becomes NULL, no float is rounded.
    if (text === ed.base) {
      editing = null;
      ed.el.remove();
      if (!blur) moveAfterEdit(ed, move);
      return true;
    }
    if (ed.crlf) text = text.replace(/\r?\n/g, '\r\n');
    const opts = ed.kind === 'select' || (ed.col.attr && ed.col.attr.type === 'MultiSelectPicklist') ? optionsOf(ed.col) : null;
    let r;
    if (ed.kind === 'select' && text === '#loading') { cancelEdit(!blur); return true; }
    if (ed.kind === 'select') {
      r = text === '' ? { value: null } : { value: dtOfCol(ed.col) === 'bit' || (ed.col.attr && ed.col.attr.type === 'Boolean') ? (Number(text) ? 1 : 0) : Number(text) };
    } else {
      r = parseEdit(text, ed.col, { tz, target: ed.target, options: opts });
    }
    if (r.error) {
      if (blur) { cancelEdit(); toast(`Not changed: ${r.error}`, { kind: 'warn' }); return false; }
      ed.el.classList.add('gr-bad');
      ed.el.setAttribute('aria-invalid', 'true');
      ed.el.title = r.error;
      status(r.error, 5000);
      return false;
    }
    editing = null;
    ed.el.remove();
    const attr = model.attrOf(ed.c);
    if (attr) {
      if (ed.e < 0) {
        model.setCell({ ins: -1 - ed.e }, attr, r.value, undefined, r.entity ?? null);
        insRows.delete(-1 - ed.e);
        editsChanged([], false);
      } else {
        const id = pkOf(ed.e);
        const orig = data[ed.e];
        const comp = ed.col.companion;
        const origEnt = comp && isIdx(comp.type) ? orig[comp.type] ?? null : null;
        model.setCell({ id }, attr, r.value, { value: orig[ed.c], entity: origEnt }, r.entity ?? null);
        editsChanged([id]);
      }
    }
    if (!blur) moveAfterEdit(ed, move);
    return true;
  }

  // After a commit: Enter stays on the cell, Tab / Shift+Tab move to the next / previous column.
  function moveAfterEdit(ed, move) {
    let dc = ed.dc;
    if (move) dc = Math.max(0, Math.min(disp.length - 1, dc + move));
    setActive(ed.p, dc);
    if (move && dc !== ed.dc) { anchor = { row: ed.p, col: dc }; select([{ r0: ed.p, r1: ed.p, c0: dc, c1: dc }]); }
  }

  // The view positions of the selected rows for row actions (Delete, Duplicate).
  function rowTargets() {
    return selectedRows().filter(p => p >= 0 && p < vLen);
  }

  function deleteState() {
    if (!editMode || !model) return { disabled: true, label: 'Delete row' };
    const ps = rowTargets();
    const es = ps.map(viewAt);
    const loaded = es.filter(e => e >= 0 && !pinned.has(e) && !model.isSynthetic(data[e]) && model.rowId(data[e]) && !model.fixed(model.rowId(data[e])));
    const any = loaded.length + es.filter(e => e < 0).length;
    const allDel = loaded.length > 0 && loaded.every(e => model.isDeleted(model.rowId(data[e]))) && es.every(e => e >= 0);
    return { disabled: isBusy() || any === 0, label: allDel ? 'Restore row' : 'Delete row', title: any === 0 ? 'Select rows of this table to delete them.' : undefined };
  }

  // Delete row (toggle, 03 §7.2): loaded rows are marked or restored, new rows are removed.
  function toggleDeleteRows() {
    const st = deleteState();
    if (st.disabled) return;
    const ps = rowTargets();
    const restore = st.label === 'Restore row';
    const ids = [];
    let removed = 0;
    for (const p of ps) {
      const e = viewAt(p);
      if (e < 0) { model.removeInsert(-1 - e); insRows.delete(-1 - e); removed++; continue; }
      if (pinned.has(e) || model.isSynthetic(data[e])) continue;
      const id = model.rowId(data[e]);
      if (!id || model.fixed(id)) continue;
      if (model.isDeleted(id) === restore) { model.toggleDelete(id); ids.push(id); }
    }
    cancelEdit();
    editsChanged(ids, removed > 0);
    announce(deleteText(restore, ids.length, removed));
  }

  function duplicateState() {
    if (!editMode || !model) return { disabled: true };
    if (!model.canCreateAny()) return { disabled: true, title: TEXTS.noCreate };
    const ps = rowTargets();
    if (!ps.length) return { disabled: true, title: 'Select the rows to duplicate.' };
    if (ps.length > DUP_MAX) return { disabled: true, title: TEXTS.dupMax };
    const synth = ps.some(p => { const e = viewAt(p); return e >= 0 && (model.isSynthetic(data[e]) || !model.rowId(data[e])); });
    if (synth) return { disabled: true, title: TEXTS.noCreate };
    return { disabled: isBusy(), title: isBusy() ? TEXTS.reviewing : undefined };
  }

  // Duplicate row (03 §7.2): a new row below each selected row with the values of every column of the root table that is
  // valid for create (the columns the user hid included: 'visible' means not a hidden companion; lookups with their
  // target table), at most DUP_MAX at a time.
  function duplicateRows() {
    const st = duplicateState();
    if (st.disabled) { if (st.title) status(st.title); return; }
    const ps = rowTargets();
    const creatable = [];
    for (let c = 0; c < columns.length; c++) if (model.creatable(c)) creatable.push(c);
    for (const p of ps) {
      const e = viewAt(p);
      const row = rowAt(e);
      const cells = new Map(), targets = new Map();
      for (const c of creatable) {
        const attr = model.attrOf(c);
        const v = row[c];
        if (!attr || v == null) continue;
        cells.set(attr, v);
        const col = columns[c];
        if (col.attr && LOOKUP_TYPES.has(col.attr.type)) {
          const lk = lookupOf(row, c);
          if (lk) {
            targets.set(attr, lk.entity);
            // The copy shows the name its source row shows (no lookupName request for it).
            const li = labelIndex(col);
            const k = lk.entity + ':' + lk.id;
            if (li >= 0 && typeof row[li] === 'string' && row[li] !== '' && names.get(k) == null) names.set(k, row[li]);
          }
        }
      }
      const anchorKey = e < 0 ? 'i:' + (-1 - e) : pinned.has(e) ? 'd:' + model.rowId(data[e]) : 'd:' + model.rowId(data[e]);
      model.addInsert(anchorKey, cells, targets);
    }
    cancelEdit();
    editsChanged([], true);
    announce(`Duplicated ${fmtInt(ps.length)} ${ps.length === 1 ? 'row' : 'rows'}.`);
  }

  // Add row (03 §7.2): an empty new row at the end, with its first creatable cell active.
  function addRow() {
    if (!editMode || !model || isBusy()) return;
    if (!model.canCreateAny()) { status(TEXTS.noCreate); return; }
    const key = model.addInsert('');
    editsChanged([], true);
    const p = posOf(-1 - key);
    const dc = disp.findIndex(c => model.creatable(c));
    anchor = { row: p, col: Math.max(0, dc) };
    select([{ r0: p, r1: p, c0: Math.max(0, dc), c1: Math.max(0, dc) }], { row: p, col: Math.max(0, dc) });
    setActive(p, Math.max(0, dc));
  }

  // Pending changes (03 §7.2 navigator): list = the displayed ones in displayed order [{kind, pos, id|key, cols, dc, n,
  // e}], hiddenList = the ones in rows the filters hide (pos -1, hidden: true, in result order), hidden = their number.
  // Names are filled by named() when a text needs them.
  function changes() {
    if (!model || !editMode) return { list: [], hidden: 0, hiddenList: [] };
    const out = [], off = [];
    const consider = id => {
      const i = pkIdx ? pkIdx.get(id) : undefined;
      if (i == null) return;
      let ch;
      if (model.isDeleted(id)) ch = { kind: 'delete', id, e: i };
      else {
        const rec = model.update(id);
        if (!rec || !rec.cells.size) return;
        const dcs = [];
        disp.forEach((c, dc) => { const a = model.attrOf(c); if (a && rec.cells.has(a)) dcs.push(dc); });
        const cols = dcs.length ? dcs.map(dc => colLabel(columns[disp[dc]])) : [...rec.cells.keys()];
        ch = { kind: 'update', id, cols, dc: dcs.length ? dcs[0] : -1, e: i };
      }
      const p = posOf(i);
      if (p < 0) { ch.pos = -1; ch.hidden = true; off.push(ch); } else { ch.pos = p; out.push(ch); }
    };
    for (const id of model.ids()) consider(id);
    let n = 0;
    for (const it of model.inserts()) {
      n++;
      const p = posOf(-1 - it.key);
      const ch = { kind: 'insert', pos: p, key: it.key, n, e: -1 - it.key };
      if (p >= 0) out.push(ch); else { ch.hidden = true; off.push(ch); }
    }
    out.sort((a, b) => a.pos - b.pos);
    off.sort((a, b) => (a.kind === 'insert') - (b.kind === 'insert') || (a.kind === 'insert' ? a.n - b.n : a.e - b.e));
    return { list: out, hidden: off.length, hiddenList: off };
  }

  // A change with the name of its record: the primary name column's displayed text, else the id.
  function named(ch) {
    if (ch.name !== undefined || ch.kind === 'insert') return ch;
    const nameCol = disp.find(c => columns[c].attr && columns[c].attr.isPrimaryName) ?? null;
    if (nameCol == null) { ch.name = ch.id; return ch; }
    const f = fmt(rowAt(ch.e), nameCol);
    ch.name = f.cls === 'null' || f.text === '' ? ch.id : f.text;
    return ch;
  }

  // Moves to the next (dir 1) or previous (dir -1) pending change, wrapping (03 §7.2).
  function goChange(dir) {
    if (editing) commitEdit({ blur: true });
    const { list } = changes();
    if (!list.length) { status(TEXTS.noChanges); return false; }
    const cur = active.row;
    let i = dir > 0 ? list.findIndex(ch => ch.pos > cur) : list.findLastIndex(ch => ch.pos < cur);
    if (i < 0) { i = dir > 0 ? 0 : list.length - 1; status(dir > 0 ? TEXTS.wrapFirst : TEXTS.wrapLast); }
    goTo(list[i]);
    announce(changeAnnouncement(i + 1, list.length, named(list[i])));
    return true;
  }

  // Go to a change the filters hide: the filters are cleared first (as the counter's 'Show' link does).
  function goToHidden(ch) {
    return Promise.resolve(clearFilters()).then(() => {
      if (destroyed) return;
      const same = changes().list.find(x => x.kind === ch.kind && (ch.kind === 'insert' ? x.key === ch.key : x.id === ch.id));
      if (same) goTo(same);
    });
  }

  function goTo(ch) {
    const col = ch.kind === 'update' && ch.dc >= 0 ? ch.dc : -1;
    anchor = { row: ch.pos, col: Math.max(0, col) };
    ranges = col >= 0 ? [{ r0: ch.pos, r1: ch.pos, c0: col, c1: col }] : [{ r0: ch.pos, r1: ch.pos, c0: 0, c1: disp.length - 1 }];
    selVer++;
    setActive(ch.pos, col);
    selectionChanged();
  }

  // The change navigator list popover (03 §7.2: every pending change with Go to and Undo this change).
  function openChangeList(anchorEl) {
    if (!shell || typeof shell.popover !== 'function') return;
    const ITEM = 36;
    const box = h('div', { class: 'gr-list', role: 'list', 'aria-label': 'Pending changes' });
    const sizer = h('div', { role: 'presentation' });
    box.append(sizer);
    let list = [];
    const drawList = () => {
      const c = changes();
      list = c.hiddenList.length ? [...c.list, ...c.hiddenList] : c.list;
      sizer.style.height = list.length * ITEM + 'px';
      box.style.height = Math.min(320, Math.max(ITEM, list.length * ITEM)) + 'px';
      drawItems();
    };
    const drawItems = () => {
      for (const el of [...box.children]) if (el !== sizer) el.remove();
      const top = box.scrollTop || 0;
      const from = Math.max(0, Math.floor(top / ITEM) - 2);
      const to = Math.min(list.length, from + Math.ceil(320 / ITEM) + 4);
      const busyNow = isBusy();
      for (let i = from; i < to; i++) {
        const ch = named(list[i]);
        const note = model.note(ch.kind === 'insert' ? 'i:' + ch.key : (ch.kind === 'delete' ? 'd:' : 'u:') + ch.id);
        const text = ch.hidden ? h('span', {}, changeText(ch), ' ', h('small', { text: TEXTS.hiddenByFilters })) : h('span', { text: changeText(ch) });
        box.append(h('div', { class: 'gr-li' + (note && note.status !== 'unknown' ? ' gr-bad' : '') + (ch.hidden ? ' gr-hid' : ''), role: 'listitem', style: `top:${i * ITEM}px`, title: note ? note.message : undefined },
          text,
          h('button', { type: 'button', class: 'link', text: 'Go to', onclick: () => { pop.close(); if (ch.hidden) goToHidden(ch); else goTo(ch); } }),
          h('button', {
            type: 'button', class: 'link', text: 'Undo this change', disabled: busyNow, title: busyNow ? TEXTS.reviewing : undefined,
            onclick: () => { if (!undoChange(ch)) return; drawList(); if (!list.length) pop.close(); },
          })));
      }
    };
    box.addEventListener('scroll', drawItems);
    const node = h('div', { style: 'display:contents' }, h('div', { class: 'gr-pophead', text: pendingText(model.counts()).main }), box);
    const pop = shell.popover(anchorEl, node, { label: 'Pending changes' });
    drawList();
    return pop;
  }

  // Undo this change (03 §7.2); never while a review runs (its results must find what it sent).
  function undoChange(ch) {
    if (!model) return false;
    if (isBusy()) { status(TEXTS.reviewing); return false; }
    if (!model.undo(ch)) return false;
    if (ch.kind === 'insert') insRows.delete(ch.key);
    editsChanged(ch.id ? [ch.id] : [], ch.kind === 'insert');
    return true;
  }

  // The 02 §8 previewEdits input of the pending edits (each record's loaded versionnumber as etag).
  function editPayload() {
    if (!model) return null;
    return model.payload(id => { const i = pkIdx ? pkIdx.get(id) : undefined; return i == null ? null : data[i]; });
  }

  // Review changes (03 §7.2): hands the change set to results.js, which runs session.runEdits. Every edit is locked
  // until it ends (in every grid sharing the model); a refusal or failure keeps the edits pending and says why.
  async function review() {
    if (!editMode || !model || isBusy() || typeof o.onReview !== 'function') return null;
    // An open editor's valid value is part of the change set; an invalid one is dropped with its toast.
    if (editing) commitEdit({ blur: true });
    if (!pendingCount()) return null;
    const payload = editPayload();
    const mdl = model;
    reviewing = true;
    mdl.busy = true;
    renderEbar();
    let r;
    try {
      r = await o.onReview(payload);
    } catch (e) {
      toast(e && e.message ? String(e.message) : 'Review changes failed.', { kind: 'error' });
      return null;
    } finally {
      reviewing = false;
      mdl.busy = false;
      if (!destroyed) renderEbar();
    }
    // A grid destroyed meanwhile leaves the results to the grid that replaced it (results.js applies them there).
    if (!destroyed && r && Array.isArray(r.results)) {
      try { applyEditResults(r.results); } catch (e) { toast(e && e.message ? String(e.message) : 'The results could not be shown.', { kind: 'error' }); }
    }
    return r ?? null;
  }

  // Applies the `edits {results}` of a review (03 §7.2): written values replace the loaded ones, deleted rows go,
  // created rows get their new id; failed edits stay pending with their message. Works in and out of edit mode (a
  // grid re-created with opts.editModel while the review ran).
  function applyEditResults(results) {
    if (!model || destroyed) return null;
    if (!pkIdx) buildPkIdx();
    const out = model.applyResults(results);
    for (const u of out.updated) {
      const i = pkIdx.get(u.id);
      if (i == null) continue;
      const row = applyCells(data[i].slice(), u.cells, u.targets, i);
      // The record's new versionnumber keeps it editable (00 §5 rule 4: the etag that goes with the values shown);
      // without one a further edit would only be skipped as changed, so the row waits for the next run.
      const vn = model.etagIndex >= 0 ? nextVersion(row[model.etagIndex], u.etag) : undefined;
      if (vn !== undefined) row[model.etagIndex] = vn;
      else model.fixRow(u.id, TEXTS.saved);
      data[i] = row;
      if (i < qs.length) qs[i] = 0;
      // Cells changed again after the payload stay pending on top of the written values.
      if (editMode) refreshOverlay(u.id); else overlays.delete(i);
    }
    for (const id of out.deleted) {
      const i = pkIdx.get(id);
      if (i == null) continue;
      gone.add(i);
      overlays.delete(i);
      pkIdx.delete(id);
    }
    for (const id of out.unknown.updates) refreshOverlay(id);
    const addRowOf = (rec, newId) => {
      const i = data.length;
      const r = applyCells(new Array(columns.length).fill(null), rec.cells, rec.targets, i);
      if (newId && model.pkIndex >= 0) r[model.pkIndex] = newId;
      data.push(r);
      pinned.set(i, rec.anchor);
      if (newId) { pkIdx.set(newId, i); model.fixRow(newId, TEXTS.created); }
      insRows.delete(rec.key);
      return i;
    };
    const remapped = a => out.remap.get(a) ?? a;
    for (const [i, a] of pinned) if (out.remap.has(a)) pinned.set(i, remapped(a));
    for (const rec of out.created) addRowOf({ ...rec, anchor: remapped(rec.anchor) }, rec.newId);
    for (const rec of out.unknown.inserts) {
      const i = addRowOf({ ...rec, anchor: remapped(rec.anchor) }, null);
      unknownRows.add(i);
    }
    streamed = data.length;
    sortCache = null;
    ver++;
    recompute({ keepTop: true });
    renderEbar();
    notifyEdits();
    return out;
  }

  // ---- edit toolbar (03 §7.2) ----------------------------------------------------------------------------------
  const eb = {};
  function buildEbar() {
    const mk = (ic, text, cls, onclick, title) => {
      const b = h('button', { type: 'button', class: 'btn' + (cls ? ' ' + cls : '') + (text ? '' : ' icon'), onclick, title, 'aria-label': text ? (ic ? text : undefined) : title }, ic ? icon(ic, 20) : null, text ? h('span', { class: 'lbl', text }) : null);
      return b;
    };
    eb.add = mk('plus', 'Add row', 'subtle', () => addRow());
    eb.del = mk('trash', 'Delete row', 'subtle', () => toggleDeleteRows());
    eb.dup = mk('copy', 'Duplicate row', 'subtle', () => duplicateRows());
    eb.cntMain = h('span');
    eb.cntSub = h('small');
    eb.cnt = h('button', { type: 'button', class: 'gr-cnt', 'aria-haspopup': 'dialog', onclick: e => openChangeList(e.currentTarget) }, eb.cntMain, eb.cntSub);
    eb.hidText = h('span');
    eb.hid = h('span', { class: 'gr-hidn', hidden: true }, eb.hidText, h('button', { type: 'button', class: 'link', text: 'Show', onclick: () => clearFilters() }));
    eb.prev = mk('up', null, 'subtle', () => goChange(-1), titleFor('prevChange', { label: 'Previous change', mac }));
    eb.next = mk('down', null, 'subtle', () => goChange(1), titleFor('nextChange', { label: 'Next change', mac }));
    eb.discard = mk(null, 'Discard all', 'subtle', () => discardAsk());
    eb.review = mk('check', 'Review changes', 'primary', () => review());
    eb.done = mk(null, 'Done', '', () => setEditMode(false), 'Leave edit mode');
    ebar.append(eb.add, eb.del, eb.dup, h('span', { class: 'gr-sep', role: 'separator' }), eb.cnt, eb.hid, eb.prev, eb.next, h('span', { class: 'spacer' }), eb.discard, eb.review, eb.done);
  }

  async function discardAsk() {
    const n = pendingCount();
    if (!n) return;
    const ok = shell && typeof shell.confirm === 'function' ? await shell.confirm({ title: discardTitle(n), ok: 'Discard', cancel: 'Keep editing', danger: true }) : true;
    if (ok) discardEdits();
  }

  function renderEbar() {
    if (!editMode || !model) return;
    if (!eb.add) buildEbar();
    const c = model.counts();
    const t = pendingText(c);
    eb.cntMain.textContent = t.main;
    eb.cntSub.textContent = t.sub;
    eb.cntSub.hidden = !t.sub;
    eb.cnt.disabled = !c.total;
    const { hidden } = c.total ? changes() : { hidden: 0 };
    eb.hid.hidden = !hidden;
    eb.hidText.textContent = hidden ? hiddenChangesText(hidden) : '';
    eb.prev.disabled = eb.next.disabled = !c.total;
    const busyNow = isBusy();
    eb.discard.disabled = !c.total || busyNow;
    const canReview = typeof o.onReview === 'function';
    eb.review.disabled = !c.total || busyNow || !canReview;
    eb.review.title = busyNow ? TEXTS.reviewing : !canReview ? TEXTS.noReview : '';
    eb.review.setAttribute('aria-busy', busyNow ? 'true' : 'false');
    eb.add.disabled = busyNow || !model.canCreateAny();
    eb.add.title = model.canCreateAny() ? '' : TEXTS.noCreate;
    const del = deleteState();
    eb.del.disabled = del.disabled;
    eb.del.querySelector('.lbl').textContent = del.label;
    const dup = duplicateState();
    eb.dup.disabled = dup.disabled;
    eb.dup.title = dup.title ?? '';
    eb.done.disabled = busyNow;
  }

  // ---- pointer: cells, row headers, corner -----------------------------------------------------------------------
  let selDrag = null;
  function cellAtPoint(x, y) {
    const r = viewEl.getBoundingClientRect();
    const lx = x - r.left, ly = y - r.top - headH;
    const dc = lx < rnW ? -1 : colAt(xs, lx - rnW + (scroller.scrollLeft || 0));
    const row = vLen ? Math.max(0, Math.min(vLen - 1, Math.floor((ly + vTop) / rowH))) : -1;
    return { row, col: dc };
  }

  // The rendered cell or row header an event target is in: {row, col (-1: row header), C}, or null.
  function cellFromTarget(t) {
    for (let n = t; n && n !== body && n !== root; n = n.parentNode) {
      const w = owner.get(n);
      if (!w) continue;
      if (w.R.p < 0 || (w.C && (w.C.el.hidden || !w.R.cells.has(w.C.dc) || w.R.cells.get(w.C.dc) !== w.C))) return null;
      return { row: w.R.p, col: w.C ? w.C.dc : -1, C: w.C };
    }
    return null;
  }

  function onBodyDown(e) {
    if (e.button !== 0 && e.button !== undefined) return;
    const hit = cellFromTarget(e.target);
    if (!hit) return;
    if (editing && !(editing.el === e.target)) commitEdit({ blur: true });
    const mod = e.ctrlKey || e.metaKey;
    if (hit.col === -1) {
      const full = { c0: 0, c1: disp.length - 1 };
      const a = e.shiftKey ? anchor.row : hit.row;
      if (!e.shiftKey) anchor = { row: hit.row, col: 0 };
      const g = { r0: Math.min(a, hit.row), r1: Math.max(a, hit.row), ...full };
      select(mod ? [...ranges, g] : [g], { row: hit.row, col: -1 });
      selDrag = { rows: true, base: mod ? ranges.slice(0, -1) : [], a };
    } else {
      if (e.target && typeof e.target.closest === 'function' && e.target.closest('.gr-lk')) return;
      if (e.shiftKey) {
        const g = normRange(anchor, hit);
        select(mod ? [...ranges.slice(0, -1), g] : [g], { row: hit.row, col: hit.col });
        selDrag = { rows: false, base: mod ? ranges.slice(0, -1) : [] };
      } else {
        anchor = { row: hit.row, col: hit.col };
        const g = { r0: hit.row, r1: hit.row, c0: hit.col, c1: hit.col };
        select(mod ? [...ranges, g] : [g], { row: hit.row, col: hit.col });
        selDrag = { rows: false, base: mod ? ranges.slice(0, -1) : [] };
      }
    }
    if (editMode) renderEbar();
    hideTip();
    const el = activeCellEl();
    if (el) focusEl(el);
    if (scroller.setPointerCapture && e.pointerId != null) { try { scroller.setPointerCapture(e.pointerId); } catch { /* not capturable */ } }
  }

  function onBodyMove(e) {
    if (!selDrag || (e.buttons !== undefined && e.buttons === 0)) { selDrag = null; return; }
    const at = cellAtPoint(e.clientX, e.clientY);
    if (at.row < 0) return;
    if (selDrag.rows) {
      const g = { r0: Math.min(selDrag.a, at.row), r1: Math.max(selDrag.a, at.row), c0: 0, c1: disp.length - 1 };
      select([...selDrag.base, g], { row: at.row, col: -1 });
    } else {
      if (at.col < 0) return;
      const g = normRange(anchor, at);
      select([...selDrag.base, g], { row: at.row, col: at.col });
    }
    edgeScroll(e, true);
  }

  function onBodyUp() { selDrag = null; stopAuto(); }

  // Auto-scroll while a selection or column drag is within 24 px of an edge (faster nearer it; 03 §7).
  let autoId = null, autoV = 0, autoH = 0;
  function edgeScroll(e, vertical) {
    const r = scroller.getBoundingClientRect();
    autoV = vertical ? edgeScrollSpeed(e.clientY, r.top + headH, r.bottom, 24, 24) : 0;
    autoH = edgeScrollSpeed(e.clientX, r.left + rnW, r.right, 24, 24);
    if ((autoV || autoH) && autoId == null) {
      const step = () => {
        autoId = null;
        if (!autoV && !autoH) return;
        scroller.scrollTop = (scroller.scrollTop || 0) + autoV;
        scroller.scrollLeft = (scroller.scrollLeft || 0) + autoH;
        render();
        if (drag && drag.started) dragMoveAt(drag.lastX);
        autoId = raf(step);
      };
      autoId = raf(step);
    }
  }
  function stopAuto() { autoV = autoH = 0; if (autoId != null) { caf(autoId); autoId = null; } }

  function onBodyDbl(e) {
    let hit = cellFromTarget(e.target);
    // The pointerdown re-renders the selected cell, so Chromium can send the dblclick to the scroller instead: take the
    // cell under the pointer when it is the one that pointerdown made active.
    if (!hit && Number.isFinite(e.clientX)) {
      const ly = e.clientY - viewEl.getBoundingClientRect().top - headH;
      const p = cellAtPoint(e.clientX, e.clientY);
      if (ly >= 0 && ly + vTop < vLen * rowH && p.row === active.row && p.col === active.col) hit = p;
    }
    if (!hit || hit.col < 0) return;
    active = { row: hit.row, col: hit.col };
    if (editMode) { beginEdit(); return; }
    if (typeof actions.cellText === 'function') {
      const row = rowAt(viewAt(hit.row)), c = disp[hit.col];
      const f = fmt(row, c);
      if (f.title || viewerKind(columns[c], f.text) !== 'text') {
        const full = fmtFull(row, c);
        actions.cellText(full.cls === 'null' ? '' : full.text, viewerKind(columns[c], full.text));
      }
    }
  }

  function onBodyClick(e) {
    const t = e.target;
    const lk = t && t.closest ? t.closest('.gr-lk') : null;
    if (!lk) return;
    const hit = cellFromTarget(lk.parentNode);
    if (!hit || hit.col < 0) return;
    const row = rowAt(viewAt(hit.row)), c = disp[hit.col];
    const rec = lookupOf(row, c) ?? (columns[c].attr && columns[c].attr.isPk ? recordOf(row, c) : null) ?? refOf(row, c);
    openLink(rec);
  }

  // A ref cell's record (03 §7: a uniqueidentifier with ref lineage): ref.entity, or the type companion of {poly}.
  function refOf(row, c) {
    const col = columns[c];
    const v = row[c];
    if (!col || !col.ref || !isGuid(v)) return null;
    let ent = typeof col.ref.entity === 'string' ? col.ref.entity : null;
    if (!ent && col.companion && isIdx(col.companion.type)) ent = row[col.companion.type];
    return ent ? { entity: ent, id: v.toLowerCase() } : null;
  }

  function onBodyContext(e) {
    const hit = cellFromTarget(e.target);
    if (!hit || !shell) return;
    e.preventDefault();
    const col = hit.col < 0 ? 0 : hit.col;
    if (!inRanges(ranges, hit.row, col)) {
      anchor = { row: hit.row, col };
      select(hit.col < 0 ? [{ r0: hit.row, r1: hit.row, c0: 0, c1: disp.length - 1 }] : [{ r0: hit.row, r1: hit.row, c0: col, c1: col }], { row: hit.row, col: hit.col });
    }
    openCellMenu(hit.row, col, e);
  }

  // ---- pointer: header (sort click, resize, drag-reorder; 03 §7) ------------------------------------------------
  let drag = null;
  // The rendered header cell an event target is in: {dc, H}, or null.
  function headFromTarget(t) {
    for (let n = t; n && n !== hcs && n !== root; n = n.parentNode) {
      const H = hOwner.get(n);
      if (H) return headMap.get(H.dc) === H ? { dc: H.dc, H } : null;
    }
    return null;
  }

  function onHeadDown(e) {
    if (e.button !== 0 && e.button !== undefined) return;
    const hit = headFromTarget(e.target);
    if (!hit) return;
    hideTip();
    if (hit.H.mb.contains(e.target)) return;
    const r = hit.H.el.getBoundingClientRect();
    const nearEdge = hit.H.rz.contains(e.target) || (r.width > 0 && e.clientX >= r.right - EDGE);
    if (editing) commitEdit({ blur: true });
    if (nearEdge) {
      drag = { kind: 'resize', dc: hit.dc, c: disp[hit.dc], x0: e.clientX, w0: wd[hit.dc], wOld: view.widths[disp[hit.dc]] ?? null, started: true };
      hit.H.rz.classList.add('gr-on');
    } else {
      drag = { kind: 'move', from: hit.dc, x0: e.clientX, lastX: e.clientX, started: false, shift: e.shiftKey, slot: hit.dc };
    }
    if (hit.H.el.setPointerCapture && e.pointerId != null) { try { hit.H.el.setPointerCapture(e.pointerId); } catch { /* not capturable */ } }
  }

  function onHeadMove(e) {
    if (!drag) return;
    if (e.buttons !== undefined && e.buttons === 0 && drag.started) { endDrag(false); return; }
    if (drag.kind === 'resize') {
      // 03 §13 60 fps: the widths change at once, the cells only move (no reformatting), once per animation frame.
      const w = Math.round(Math.max(RESIZE_MIN, Math.min(RESIZE_MAX, drag.w0 + (e.clientX - drag.x0))));
      if (view.widths[drag.c] === w) return;
      view.widths[drag.c] = w;
      lver++;
      measureLayout();
      scheduleLayout();
      return;
    }
    drag.lastX = e.clientX;
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.x0) < DRAG_START) return;
      startMove();
    }
    dragMoveAt(e.clientX);
    edgeScroll(e, false);
  }

  function startMove() {
    drag.started = true;
    const c = disp[drag.from];
    drag.ghost = h('div', { class: 'gr-ghost', 'aria-hidden': 'true', text: colLabel(columns[c]) });
    drag.ghost.style.width = Math.min(wd[drag.from], 240) + 'px';
    drag.bar = h('div', { class: 'gr-ins', 'aria-hidden': 'true' });
    viewEl.append(drag.ghost, drag.bar);
    hver++;
    renderHeader();
  }

  function dragMoveAt(clientX) {
    if (!drag || drag.kind !== 'move' || !drag.started) return;
    const r = viewEl.getBoundingClientRect();
    const lx = clientX - r.left;
    const sl = scroller.scrollLeft || 0;
    drag.slot = slotAt(xs, Math.max(0, lx - rnW + sl));
    drag.ghost.style.left = Math.max(0, lx - Math.min(wd[drag.from], 240) / 2) + 'px';
    drag.bar.style.left = Math.max(rnW, rnW + xs[drag.slot] - sl) + 'px';
  }

  function onHeadUp(e) {
    if (!drag) return;
    if (drag.kind === 'resize') { endDrag(true); return; }
    if (!drag.started) {
      const hit = { dc: drag.from };
      drag = null;
      const c = disp[hit.dc];
      active = { row: -1, col: hit.dc };
      setSort(cycleSort(view.sort, c, !!(e && e.shiftKey)));
      return;
    }
    endDrag(true);
  }

  // Ends a header drag: commit (resize width, or move to the drop slot) or put it back (Escape, pointercancel).
  function endDrag(commit) {
    const d = drag;
    if (!d) return false;
    drag = null;
    stopAuto();
    if (d.kind === 'resize') {
      for (const H of headMap.values()) H.rz.classList.remove('gr-on');
      // A click on the edge without movement is no resize (automatic measurement still applies).
      if (commit && view.widths[d.c] != null && view.widths[d.c] !== d.w0) { if (!view.resized.includes(d.c)) view.resized.push(d.c); emitView(); }
      else if (!commit) view.widths[d.c] = d.wOld;
      flushLayout();
      lver++;
      render();
      return true;
    }
    if (d.ghost) d.ghost.remove();
    if (d.bar) d.bar.remove();
    hver++;
    if (commit && d.started) {
      const to = dropTarget(d.from, d.slot);
      if (to !== d.from) { moveDisplayed(d.from, to); return true; }
    }
    renderHeader();
    return true;
  }

  function onHeadDbl(e) {
    const hit = headFromTarget(e.target);
    if (!hit || !hit.H.rz.contains(e.target)) return;
    autoFit(hit.dc);
  }

  // Double-click on a resize edge: the automatic width over the header and the first rows of the current view.
  function autoFit(dc) {
    const c = disp[dc];
    view.widths[c] = columnWidth(c, Math.min(SAMPLE, vLen), p => rowAt(viewAt(p)));
    if (!view.resized.includes(c)) view.resized.push(c);
    lver++;
    emitView();
    render();
  }

  // One render per animation frame for layout-only changes (column resize).
  let layoutRaf = null;
  function scheduleLayout() {
    if (layoutRaf != null) return;
    layoutRaf = raf(() => { layoutRaf = null; if (!destroyed) render(); });
  }
  function flushLayout() { if (layoutRaf != null) { caf(layoutRaf); layoutRaf = null; } }

  function onHeadClick(e) {
    const hit = headFromTarget(e.target);
    if (!hit) return;
    if (hit.H.mb.contains(e.target)) { active = { row: -1, col: hit.dc }; openHeaderMenu(hit.dc, hit.H.mb); }
  }

  function onHeadContext(e) {
    const hit = headFromTarget(e.target);
    if (!hit || !shell) return;
    e.preventDefault();
    if (typeof shell.contextMenu === 'function') shell.contextMenu(e, headerMenuItems(hit.dc));
    else openHeaderMenu(hit.dc);
  }

  // ---- tooltips (600 ms) ---------------------------------------------------------------------------
  let tipTimer = null, tipFor = null;
  const canPop = typeof tip.showPopover === 'function';
  function onOver(e) {
    const t = e.target;
    const hc = headFromTarget(t);
    let text = null, el = null;
    if (hc) {
      el = hc.H.el;
      const c = disp[hc.dc];
      text = () => {
        let s = headerTitle(columns[c]);
        if (editMode && model && !model.updatable(c)) s += '\n' + (model.reason(c) ?? '');
        return s;
      };
    } else {
      const hit = cellFromTarget(t);
      if (!hit) return;
      if (hit.col === -1) { const R = rowMap.get(hit.row); el = R ? R.rh : null; text = () => (R ? R.rhTitle || '' : ''); }
      else {
        el = hit.C.el;
        const C = hit.C, p = hit.row;
        text = () => {
          const e2 = viewAt(p);
          const parts = [];
          const row = rowAt(e2), c = disp[C.dc];
          // A binary value's title would build the hex of every byte: the tooltip shows
          // the hex cut where the tooltip cuts its text anyway.
          if (row && row[c] instanceof Uint8Array) {
            const t = formatCell(row[c], columns[c], { ...fo, row, max: TIP_MAX });
            if (t.text.length > C.f.text.length || t.cls !== C.f.cls) parts.push(t.text);
          } else if (C.f && C.f.title) parts.push(C.f.title);
          if (editMode && model) {
            const id = e2 >= 0 ? pkOf(e2) : null;
            const n = e2 < 0 ? model.note('i:' + (-1 - e2)) : id ? model.note('u:' + id) ?? model.note('d:' + id) : null;
            if (n && n.message) parts.push(n.message);
          }
          return parts.join('\n');
        };
      }
    }
    if (!el || el === tipFor) return;
    hideTip();
    tipFor = el;
    tipTimer = setTimeout(() => {
      tipTimer = null;
      const s = text();
      if (!s || !canPop || tipFor !== el || destroyed) return;
      tip.textContent = truncateText(s, TIP_MAX);
      try { tip.showPopover(); } catch { return; }
      const vp = typeof window !== 'undefined' ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } : el.getBoundingClientRect();
      placeNear(tip, el.getBoundingClientRect(), vp, { gap: 6 });
    }, TIP_MS);
  }
  function hideTip() {
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    tipFor = null;
    if (canPop) { try { tip.hidePopover(); } catch { /* not shown */ } }
  }

  // ---- keyboard (03 §7 Selection, §9 grid scope) ----------------------------------------------------------------
  const inField = t => !!(t && t.localName && (t.localName === 'input' || t.localName === 'select' || t.localName === 'textarea'));

  function onRootKey(e) {
    if (e.defaultPrevented) return;
    if (km(e, 'nextChange') && editMode) { e.preventDefault(); goChange(1); return; }
    if (km(e, 'prevChange') && editMode) { e.preventDefault(); goChange(-1); }
  }

  function onKey(e) {
    if (e.defaultPrevented || e.isComposing) return;
    if (editing && editing.el.contains(e.target)) return;
    if (inField(e.target)) return;
    hideTip();
    const mod = e.ctrlKey || e.metaKey;
    if (km(e, 'gridCopy')) { e.preventDefault(); copy(false); return; }
    if (km(e, 'gridCopyHeaders')) { e.preventDefault(); copy(true); return; }
    if (km(e, 'gridSelectAll')) { e.preventDefault(); selectAll(); return; }
    if (km(e, 'gridEdit')) { if (editMode) { e.preventDefault(); beginEdit(); } return; }
    const { row: r, col: c } = active;
    const page = Math.max(1, Math.floor((vh - headH) / rowH) - 1);
    let nr = r, nc = c, handled = true;
    switch (e.key) {
      case 'ArrowDown': nr = mod ? vLen - 1 : r + 1; if (e.altKey && r === -1) { openHeaderMenu(c); e.preventDefault(); return; } break;
      case 'ArrowUp': nr = mod ? 0 : r - 1; break;
      case 'ArrowRight': nc = mod ? disp.length - 1 : c + 1; break;
      case 'ArrowLeft': nc = mod ? 0 : c - 1; break;
      case 'Home': nc = 0; if (mod) nr = 0; break;
      case 'End': nc = disp.length - 1; if (mod) nr = vLen - 1; break;
      case 'PageDown': nr = r + page; break;
      case 'PageUp': nr = r - page; break;
      case 'Enter':
        if (r === -1 && c >= 0) { e.preventDefault(); setSort(cycleSort(view.sort, disp[c], e.shiftKey)); return; }
        if (editMode && r >= 0 && c >= 0) { e.preventDefault(); beginEdit(); return; }
        handled = false;
        break;
      case ' ':
        if (r === -1 && c >= 0) { e.preventDefault(); setSort(cycleSort(view.sort, disp[c], e.shiftKey)); return; }
        if (e.shiftKey && r >= 0) { e.preventDefault(); const g = ranges.length ? ranges[ranges.length - 1] : { r0: r, r1: r }; select([{ r0: g.r0, r1: g.r1, c0: 0, c1: disp.length - 1 }]); return; }
        if (mod && c >= 0) { e.preventDefault(); const g = ranges.length ? ranges[ranges.length - 1] : { c0: c, c1: c }; select([{ r0: 0, r1: vLen - 1, c0: g.c0, c1: g.c1 }]); return; }
        handled = false;
        break;
      case 'ContextMenu': e.preventDefault(); keyMenu(); return;
      case 'F10': if (e.shiftKey) { e.preventDefault(); keyMenu(); return; } handled = false; break;
      default: handled = false;
    }
    if (!handled) {
      if (editMode && r >= 0 && c >= 0 && e.key && e.key.length === 1 && !mod && !e.altKey) {
        const col = columns[disp[c]];
        if (editorKind(col) === 'text' && !cellLock(viewAt(r), disp[c])) { e.preventDefault(); beginEdit(e.key); }
      }
      return;
    }
    e.preventDefault();
    nr = Math.max(-1, Math.min(vLen - 1, nr));
    nc = Math.max(-1, Math.min(disp.length - 1, nc));
    if (nr === -1 && nc === -1) nc = 0;
    if (e.shiftKey && nr >= 0 && nc === -1 && r >= 0 && c === -1) {
      // Shift+arrows on the row numbers extend the selected rows.
      setActive(nr, -1);
      select([...ranges.slice(0, -1), { r0: Math.min(anchor.row, nr), r1: Math.max(anchor.row, nr), c0: 0, c1: disp.length - 1 }]);
    } else if (e.shiftKey && nr >= 0 && nc >= 0 && r >= 0) {
      setActive(nr, nc);
      select([...ranges.slice(0, -1), normRange(anchor, { row: nr, col: nc })]);
    } else {
      if (nr >= 0 && nc >= 0) { anchor = { row: nr, col: nc }; ranges = [{ r0: nr, r1: nr, c0: nc, c1: nc }]; }
      else if (nr >= 0 && nc === -1) { anchor = { row: nr, col: 0 }; ranges = [{ r0: nr, r1: nr, c0: 0, c1: disp.length - 1 }]; }
      selVer++;
      setActive(nr, nc);
      selectionChanged();
    }
    if (editMode) renderEbar();
  }

  function keyMenu() {
    const { row: r, col: c } = active;
    if (r === -1 && c >= 0) openHeaderMenu(c);
    else if (r >= 0) openCellMenu(r, Math.max(0, c), null);
  }

  // Focus arriving on the grid from outside (Tab) goes to the active cell, scrolled into view.
  function onScrollerFocus(e) {
    if (e.target !== scroller || parking || (e.relatedTarget && scroller.contains(e.relatedTarget))) return;
    if (!ranges.length && vLen && disp.length && active.row >= 0 && active.col >= 0) {
      ranges = [{ r0: active.row, r1: active.row, c0: active.col, c1: active.col }];
      selVer++;
      selectionChanged();
    }
    const el = activeCellEl();
    if (el) focusEl(el);
    else if (vLen && active.row >= 0) setActive(active.row, active.col);
  }

  // Text that arrives without a printable keydown (an IME, dictation, the emoji panel, automation) on a cell. A cell
  // (user-select: none) never takes the frame selection, which often stays in the SQL editor's textarea, so Chromium
  // would insert that text into the query: it is cancelled here, and in edit mode it starts a text edit of the active
  // cell instead, as a typed key does (checked 2026-10-16).
  function cellTextAllowed() {
    const { row: r, col: c } = active;
    return editMode && r >= 0 && c >= 0 && c < disp.length && editorKind(columns[disp[c]]) === 'text' && !cellLock(viewAt(r), disp[c]);
  }
  function onStrayInput(e) {
    if (inField(e.target) || (editing && editing.el.contains(e.target))) return;
    if (e.cancelable) e.preventDefault();
    if (!editing && e.inputType === 'insertText' && typeof e.data === 'string' && e.data && cellTextAllowed()) beginEdit(e.data);
  }
  // An IME starts with keydown 'Process' (229): the editor opens empty first so the composition goes into it.
  function onImeKey(e) {
    if (e.defaultPrevented || editing || inField(e.target) || !(e.key === 'Process' || e.keyCode === 229)) return;
    if (cellTextAllowed()) beginEdit('');
  }
  function clearStraySelection(e) {
    if (inField(e.target)) return;
    try {
      const s = typeof document !== 'undefined' && typeof document.getSelection === 'function' ? document.getSelection() : null;
      if (s && s.rangeCount) s.removeAllRanges();
    } catch { /* no selection API */ }
  }

  // ---- wiring ----------------------------------------------------------------------------------------------------
  listen(scroller, 'scroll', () => { hideTip(); render(); });
  listen(scroller, 'keydown', onImeKey);
  listen(scroller, 'beforeinput', onStrayInput);
  listen(scroller, 'focusin', clearStraySelection);
  listen(scroller, 'keydown', onKey);
  listen(root, 'keydown', onRootKey);
  listen(scroller, 'focus', onScrollerFocus);
  listen(body, 'pointerdown', onBodyDown);
  listen(scroller, 'pointermove', onBodyMove);
  listen(scroller, 'pointerup', onBodyUp);
  listen(scroller, 'pointercancel', onBodyUp);
  listen(scroller, 'dblclick', onBodyDbl);   // the scroller: a dblclick after a re-render targets it (onBodyDbl)
  listen(body, 'click', onBodyClick);
  listen(body, 'contextmenu', onBodyContext);
  listen(hcs, 'pointerdown', onHeadDown);
  listen(hcs, 'pointermove', onHeadMove);
  listen(hcs, 'pointerup', onHeadUp);
  listen(hcs, 'pointercancel', () => endDrag(false));
  listen(hcs, 'dblclick', onHeadDbl);
  listen(hcs, 'click', onHeadClick);
  listen(hcs, 'contextmenu', onHeadContext);
  listen(corner, 'click', () => selectAll());
  listen(viewEl, 'pointerover', onOver);
  listen(viewEl, 'pointerleave', hideTip);
  listen(viewEl, 'pointerdown', hideTip);
  const escOffs = [];
  if (shell && typeof shell.onEscape === 'function') {
    try {
      escOffs.push(shell.onEscape('drag', () => endDrag(false), { el: root }));
      escOffs.push(shell.onEscape('edit', () => cancelEdit(true), { el: root }));
    } catch { /* an older shell */ }
  }
  let ro = null;
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => { if (!destroyed) render(); }); ro.observe(scroller); }

  // ---- data in -----------------------------------------------------------------------------------------------------
  function pushRows(rows) {
    if (!Array.isArray(rows)) return;
    for (let i = 0; i < rows.length; i++) data.push(rows[i]);
  }

  // Rows that streamed in (02 §9 `rows`).
  function append(rows) {
    if (destroyed || !Array.isArray(rows) || !rows.length) return;
    pushRows(rows);
    if (!view.measured && data.length >= SAMPLE) measureWidths(true);
    scheduleStream();
  }

  // The end of the set (02 §9 `resultdone`): the final widths and the complete view.
  function done({ incomplete: inc = null } = {}) {
    if (destroyed) return;
    complete = true;
    incomplete = inc ?? null;
    if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
    measureWidths(true);
    hver++; ver++;
    if (streamed < data.length) streamUpdate();
    else { buildAll(); render(); emitCount(); }
  }

  // Replaces every row (the view state is kept and re-applied).
  function setRows(rows) {
    data.length = 0;
    gone.clear(); pinned.clear(); overlays.clear(); insRows.clear(); unknownRows.clear();
    writtenAttrs.clear(); nameRows.clear();
    dataGen++; textGen++;
    pushRows(rows);
    sortCache = null;
    streamed = 0;
    if (!view.measured) measureWidths(complete || data.length >= SAMPLE);
    if (model && editMode) { buildPkIdx(); for (const id of model.ids()) refreshOverlay(id); }
    hver++; ver++;
    return recompute();
  }

  // ---- options -----------------------------------------------------------------------------------------------------
  function setOptions(p = {}) {
    let re = false, again = false;
    if (p.friendly !== undefined && !!p.friendly !== friendly) { friendly = !!p.friendly; re = true; if (view.sort.length) again = true; }
    if (p.tz !== undefined && p.tz !== tz) { tz = p.tz ?? UTC; re = true; }
    if (p.dateFormat !== undefined && p.dateFormat !== dateFormat) { dateFormat = p.dateFormat ?? null; re = true; }
    if (p.compact !== undefined && !!p.compact !== compact) { compact = !!p.compact; re = true; }
    if (p.fontSize !== undefined && Number.isFinite(p.fontSize)) { const f = Math.max(11, Math.min(16, Math.round(p.fontSize))); if (f !== fontSize) { fontSize = f; re = true; } }
    if (p.csvNeutralize !== undefined) neutral = p.csvNeutralize !== false;
    if (p.label !== undefined) { label = String(p.label); scroller.setAttribute('aria-label', label); }
    if (!re) return;
    if (p.friendly !== undefined || p.tz !== undefined || p.dateFormat !== undefined) textGen++;
    syncFo();
    metrics();
    sortCache = null;
    hver++; ver++;
    if (again || quickNeedle(view.quick) || view.filters.length) recompute({ keepTop: true }); else render();
  }

  // ---- init --------------------------------------------------------------------------------------------------------
  metrics();
  syncFo();
  pushRows(o.rows);
  if (!view.measured) measureWidths(complete || data.length >= SAMPLE);
  recompute();

  // ---- the instance ----------------------------------------------------------------------------------------------
  const api = {
    el: root,
    append, setRows, done,
    rows: () => data.filter((_, i) => !gone.has(i)),
    currentView: () => tableOf(disp.map((_, dc) => dc), viewRows(), null, totalRows()),
    counts: () => ({ shown: vLen, total: totalRows(), loading: !complete }),
    selection: () => {
      const lay = selectionLayout(ranges);
      return { active: { ...active }, ranges: ranges.map(g => ({ ...g })), rows: lay.nRows, cols: lay.cols.length, cells: selectionCount(ranges) };
    },
    selectedPayload,
    view: () => copyView(view),
    setView(v) {
      const keepDisplay = { display: view.display, chart: view.chart };
      view = normalizeView({ ...keepDisplay, ...v }, columns);
      sortCache = null;
      hver++; ver++;
      renderFbar();
      resetSelection();
      return recompute();
    },
    setQuick, clearFilters, showAllColumns, setOptions,
    // The row details sheet's paging (03 §7: prev/next, Open record): the view's length, the row at a view position
    // (pending edits applied) and its record ({entity, id, pkName, url} of the cell's table, or of the root table).
    viewLength: () => vLen,
    rowAtPosition: p => (Number.isInteger(p) && p >= 0 && p < vLen ? rowAt(viewAt(p)) : null),
    recordOf(p, dc = 0) {
      if (!Number.isInteger(p) || p < 0 || p >= vLen) return null;
      const e = viewAt(p);
      if (e < 0) return null;
      const c = Number.isInteger(dc) && dc >= 0 && dc < disp.length ? disp[dc] : -1;
      const rec = recordOf(rowAt(e), c);
      return rec ? { ...rec, url: recordUrl(rec.entity, rec.id, { known: o.known }) } : null;
    },
    editEligibility, editing: () => editMode, setEditMode, pendingCount, discardEdits, editPayload, applyEditResults,
    editModel: () => model,
    nextChange: () => goChange(1), prevChange: () => goChange(-1), review,
    copy, focus: () => { const el = activeCellEl(); focusEl(el ?? scroller); },
    idle() {
      if (quickTimer) { clearTimeout(quickTimer); quickTimer = null; emitView(); resetSelection(); recompute(); }
      if (streamTimer) { clearTimeout(streamTimer); streamUpdate(); }
      return work.then(() => new Promise(r => setTimeout(r, 0)));
    },
    // Inspection hooks: the rendered state.
    _state: () => ({ vLen, disp: disp.slice(), widths: wd.slice(), rowH, headH, rnW, vTop, active: { ...active }, editing: editing ? { p: editing.p, dc: editing.dc, kind: editing.kind, el: editing.el } : null, rows: rowMap, heads: headMap, sMap }),
    _render: render,
    _cellAt: cellAtPoint,
    _actions: { duplicateRows, toggleDeleteRows, addRow, beginEdit, commitEdit, cancelEdit, openFilter, openHeaderMenu, openCellMenu, openChangeList, selectAll, moveDisplayed, hideColumn, changes, filterToValue, autoFit, setSort, cellMenuItems, headerMenuItems, endDrag },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      vtok++; statsTok++;
      if (streamTimer) clearTimeout(streamTimer);
      if (quickTimer) clearTimeout(quickTimer);
      if (selTimer) clearTimeout(selTimer);
      flushLayout();
      stopAuto();
      hideTip();
      cancelEdit();
      if (filterPop) { try { filterPop.close(); } catch { /* closed */ } }
      for (const f of offs) f();
      for (const f of escOffs) { try { f(); } catch { /* shell gone */ } }
      if (ro) ro.disconnect();
      root.remove();
    },
  };
  return api;
}
