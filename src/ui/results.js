// Results area of SQL Studio (03 §1.4, §2, §7, §7.2, §7.3, §9, §13; 02 §9 RunHandle events; 00 §3
// one run at a time): the run controller with the app-wide run lock, the result tabs
// with their toolbar and banners, Messages with codes, fixes and the Dataverse error hints (ERROR_HINTS), the Plan
// view with its properties panel, connector widths and time share and the Script pseudo-nodes, the
// FetchXML view, the Changes view with Undo and logs, quick charts (§7.3), Results as text (export.js
// createTextView), the status bar and the row details sheet. The decisions are pure exported helpers (run slicing,
// tab labels, banners, message items, status texts, plan rows, connector widths, time share, the chart model and
// layout, change summaries and logs); createResults() is the thin DOM layer over them, grid.js and export.js.
//
// Notes (extensions of 03 §1.4, §2, §7 and 02 §9):
// - createResults(host, opts) options beyond 03 §1.4's {state, shell, editor, meta}: api (mode() / caller() for
//   Review changes and the status bar, stats.requests for the request count), dialogs (the Dialogs object of
//   initDialogs; else dialogs.js's module functions of the last initialised instance, looked up per call: allowChanges,
//   openHelp, openCellViewer, saveAsView, cancelPending), changeLog (default state.changeLog, read per call), tz() (the
//   display env.tz; default settings.tz: UTC, or the browser zone), mac, io ({copyText, copyBlob, saveFile, openUrl,
//   download}; default util.js, looked up per call), and injectable now() (epoch ms), clock() (a monotonic ms clock,
//   default performance.now), frame(fn) -> cancel, later(fn, ms) -> cancel, yieldToUi() and measure(text, font) (chart
//   label widths; default dom.js measureText, else 7 px per character).
// - The returned object adds to 03 §1.4: ERROR_HINTS (also the module export, so initDialogs({results}) finds it),
//   attachRun(tabId, handle, {mode, sql, offset, fullText, maxRows, abort}) (abort() stops a handle results.js did not
//   start), setCaret({line, col, start, end}) and setTabMovesFocus(on) (the status bar's 'Ln 3, Col 14' and 'Tab moves
//   focus', which main.js feeds from the editor's onCaret and the tabFocus command), textChanged() (main.js calls it
//   from the editor's onChange: 1 s later the toolbar hint and the 'plan' markers come from session.explain, 03 §5),
//   tabResults(tabId), refresh() and destroy(). The status bar (shell.regions.status) and the toolbar hint
//   (shell.regions.tbarEnd) belong to results.js, so main.js adds no status items of their own.
// - Commands bound (03 §9): run, runStatement, stop, plan (Ctrl+L), showFetchXml, copyFetchXml, copyWebApiUrl and the
//   'convertMenu' onOpen hook (it refreshes the explain that Copy as FetchXML / Web API URL use; 'busy' while it runs);
//   Escape step 'stop' (a read only, never a write). The target of Convert ▸ and Ctrl+L is the selection when it has
//   a non-blank character, else (Convert ▸ only) the statement at the caret, else the whole text.
// - Run slicing (sliceRun): a selection that holds only white space counts as empty. fullText goes to session.run()
//   only when a selection is run (03 §7). History records the effective mode ('selection' when a selection ran).
//   A blank text runs nothing (status 'There is nothing to run.').
// - RunHandle fields read beyond 02 §9 (the session, J, may send them; without them the texts fall back as noted):
//   progress.write = {op, entity, done, total, failed, skipped, batchSize, batchMax, action} during api.write (the
//   status 'Updating account · 1,200 of 5,000 · 3 failed · Stop', ' · batches of 25' when batchSize < batchMax, the
//   pill 'Writing changes · 1,200 of 5,000' with the time left, and state.running.write); without it progress.text is
//   shown as it is (WAITFOR, preview slices, Load CSV). message.errors = [{text, pos, end, line, fix, code}] (the
//   entries of a multi-error SqlError). message.faultCode (or the first 0x8… code in the text, or a hex
//   message.code) selects the ERROR_HINTS line. plan.ms (the statement's duration; else the time between its
//   `statement` and `plan` events) is the time share's denominator, never less than the root node's ms. ChangeEntry
//   .tabId (the session's tab), .jobs (asyncoperation ids of a BulkDelete entry; its `ok` lists the submitted
//   records), .undoReason (why Undo is unavailable) and .action (the action name of an 'action' entry).
// - TabResults (03 §2) keeps, in memory only, beyond its documented fields: hiddenSets (sets past the 50 kept),
//   error (the first error line of a run that failed after a result set), lastRun ({sql, offset, fullText, mode}),
//   runText (the editor text at run start: 'run' markers and the fix buttons apply only while the text is unchanged),
//   markers, planSel (the path of the selected plan node) and fetchSel. Each set adds index, streaming, pending (grid
//   edits) and its live grid / text view / chart, which are destroyed when a run replaces the set.
// - Run lock bus events: run:start carries mode 'quiet' for runQuiet / attachQuiet / Undo and 'edits' for Review
//   changes; run:end is emitted for every run that held the lock. A handle attached while another run holds the lock
//   is followed (its messages are kept) without taking the lock.
// - Messages: the time is HH:mm:ss in the display time zone; above 500 display items the list is virtualised with one
//   line per item (the full text in its title). A fix button works only while the editor still holds the text that
//   ran (else the toast 'The query changed since it ran. Run it again to apply this fix.'). The throttle line is
//   'Dataverse was busy (service protection): the run waited 24 s in total.' (code THROTTLE).
// - Write toasts (03 §7): 'Updated 4,997 records. 3 failed.' (Deleted, Created, Associated, Disassociated, 'Ran <action>
//   on', 'Applied … changes to <table>' for grid change sets), plus ' 2 skipped.' and ' 1 with an unknown outcome.';
//   the toast's action is Show details and its text carries a Download log link.
// - Charts (§7.3): the Y item 'Count of rows' is '#count' in ChartSpec.ys (a real column of that name wins only when
//   Aggregate is not Count); 'Count of <col>' counts the group's rows whose value is not NULL (COUNT(col)); the pie
//   note is 'Showing 11 of 311 categories; the other 300 are summed into one slice.'; series colours are classes
//   .rs-c1 … .rs-c8 (fill/stroke var(--chart-n)); Save as SVG writes every colour as the literal that the token has
//   in the current theme.
// - The plan tree is a role=tree: a statement header is a level-1 item, operators follow at their depth;
//   ←/→ collapse and expand, Enter or double-click on a node with FetchXML opens it in the FetchXML view.
// - The toolbar hint scans the text lexically for the tables after FROM, JOIN, APPLY, UPDATE, INTO and DELETE (skipping
//   #temp, @table, metadata., sys. and CTE names) and calls explain only when meta.entitySync() has each of them.

import { h, append, clear, setChildren, measureText as domMeasureText } from './dom.js';
import { icon, ICON_NAMES } from './icons.js';
import * as stateModule from './state.js';
import * as dialogsModule from './dialogs.js';
import { highlightNodes, prettyXml } from './dialogs.js';
import { runLockTitle, quoteName, discardTitle, keyLabel, isMacPlatform, fmtTimeLeft } from './shell.js';
import { pickStatement } from './editor.js';
import { createGrid, isMeasure, dtOfCol, colLabel, typeOfCol, statsText } from './grid.js';
import * as exportModule from './export.js';
import { STREAMING_TITLE, createTextView, TEXT_CSS, csvField, neutralize as csvNeutralize } from './export.js';
import * as util from '../core/util.js';
import { fmtInt, fmtNumber, fmtDuration, fmtDate, formatCell, truncateText, safeFileName, recordUrl, isGuid, yieldToUi as utilYield } from '../core/util.js';
import { parseXml, xmlEsc } from '../core/xml.js';
import { statementRanges } from '../engine/parser.js';
import { tokenize } from '../engine/lexer.js';
import { keyOf } from '../engine/types.js';

// ------------------------------------------------------------------------------------------------------ constants

const MAX_SETS = 50;                 // result sets kept per run (03 §7)
const MSG_VIRTUAL = 500;             // the Messages list is virtualised above this many items (03 §13)
const MSG_LINE = 28;                 // px per line of a virtualised message item
const STATUS_TICK = 100;             // ms between running-status updates (03 §7)
const STREAM_MS = 500;               // text view re-layout while a set streams (03 §7)
const EXPLAIN_IDLE = 1000;           // the toolbar hint's explain runs 1 s after typing stops (03 §5)
const EXPLAIN_MAX_STATEMENTS = 20;   // … and not for scripts with more statements
const PLAN_INDENT = 20;              // px per plan tree level
const LONG_VALUE = 80;               // a property value longer than this wraps and gets Copy (03 §7)
const DETAILS_MAX = 500;             // records listed in a Changes entry's details
const SLICE_MS = 8;                  // long work slices (03 §13)
const CHART_SLICE_ROWS = 50000;      // chart aggregation over more rows runs in slices (03 §13)
const PROGRESS_MS = 300;             // sliced work shows progress after this long (03 §13)
const UTC = Object.freeze({ utc: true, offset: () => 0 });
const LOCAL = Object.freeze({ utc: false, offset: ms => -new Date(ms).getTimezoneOffset() });
const UI_FONT = '12px "Segoe UI","Segoe UI Web (West European)",-apple-system,BlinkMacSystemFont,Roboto,"Helvetica Neue",sans-serif';

// An icons.js name, or its fallback when icons.js lacks that name (03 §1.2: textView, properties, action).
const ic = (name, fallback) => (ICON_NAMES.includes(name) ? name : fallback);

// Every sentence the results area shows (03 §7, §7.2, §7.3).
export const TEXTS = Object.freeze({
  emptyTitle: 'Run a query to see results',
  browseTemplates: 'Browse templates',
  noRows: 'No rows',
  nothingToRun: 'There is nothing to run.',
  noSession: 'This query tab has no session. Close it and open a new one.',
  planEmpty: key => `Run the query, or press ${key} for the estimated plan.`,
  messagesEmpty: 'No messages.',
  changesEmpty: 'No data changes in this session.',
  estimated: 'Estimated',
  truncated: n => `Showing the first ${fmtInt(n)} rows. Add a filter or raise “Max rows returned” in Settings.`,
  runNoLimit: 'Run again without the row limit',
  incompleteCancelled: n => `Incomplete: the query was cancelled after ${fmtInt(n)} rows.`,
  incompleteError: n => `Incomplete: the query failed after ${fmtInt(n)} rows. See Messages.`,
  batchStopped: line => `The batch stopped with an error: ${line}`,
  showMessages: 'Show messages',
  tooManySets: n => `Only the first ${fmtInt(MAX_SETS)} result sets are shown; ${fmtInt(n)} more were returned.`,
  allowAndRun: 'Allow changes and run again',
  fixLabel: text => `Replace with ${quoteName(text)}`,
  fixStale: 'The query changed since it ran. Run it again to apply this fix.',
  help: 'Help',
  stopWrite: (done, total) => `Stop after the current batch? ${fmtInt(done)} of ${fmtInt(total)} records are done. The rest won't be changed.`,
  throttle: s => `Dataverse is busy (service protection). Retrying in ${fmtInt(s)} s…`,
  throttleLog: s => `Dataverse was busy (service protection): the run waited ${fmtInt(s)} s in total.`,
  batchesOf: n => ` · batches of ${fmtInt(n)}`,
  batchesTitle: 'Dataverse is answering slowly; SQL Studio sends smaller batches.',
  ready: 'Ready',
  cancelled: 'Query cancelled',
  userBusy: 'Not available while a query is running',
  changesAllowed: 'Changes allowed',
  tzWarn: "Your Dataverse time zone differs from this browser. FetchXML date functions such as today() use the Dataverse one.",
  tzToggle: zone => `Dates are shown in ${zone}. Select to switch between Local and UTC.`,
  tabFocus: 'Tab moves focus',
  chartIncomplete: 'Charts need the complete result. Run the query again to chart it.',
  chartNoRows: 'No rows to chart.',
  chartSmall: 'Make the results area larger to see the chart.',
  chartPieNegative: 'A pie chart needs values of 0 or more.',
  chartPieSeries: 'A pie chart shows one series.',
  chartScatterX: 'Scatter charts need a numeric X column.',
  chartStacked: 'Stacking needs a Column or Bar chart with two or more series.',
  chartOrder: 'Order applies to Column, Bar and Pie charts.',
  chartMaxSeries: 'Select at most 8 series.',
  chartOneSeries: 'At least one series stays shown.',
  imagesBlocked: "Images are blocked by this page's security policy. Use Save as SVG.",
  catCap: (n, total) => `Showing ${fmtInt(n)} of ${fmtInt(total)} categories. Aggregate or filter the results to see the rest.`,
  pointCap: (n, total) => `Showing the first ${fmtInt(n)} of ${fmtInt(total)} rows.`,
  pieCap: (n, total) => `Showing ${fmtInt(n)} of ${fmtInt(total)} categories; the other ${fmtInt(total - n)} are summed into one slice.`,
  pieOther: k => `Other (${fmtInt(k)} categories)`,
  blank: '(blank)',
  countOfRows: 'Count of rows',
  editStreaming: 'Available when all rows have loaded',
  saveViewImpersonating: 'Not available while acting as another user.',
  partlyInBrowser: 'This query runs partly in the browser; its FetchXML alone would return different results.',
  explainPending: 'Reading the plan…',
  oneStatement: 'Put the caret in one SELECT statement, or select it.',
  runsOnDataverse: 'Runs on Dataverse',
  partly: 'Partly in browser',
  bulkUndo: 'Records deleted by a BulkDelete job cannot be restored here. Use the backup, if you downloaded one.',
  noUndo: 'Undo is not available for this change.',
  unknownOutcome: 'Outcome unknown: check these records',
});

// --------------------------------------------------------------------------------------------- ERROR_HINTS

// Known Dataverse fault codes (03 §7 table): the plain-language second line of a Messages item, and the cause and fix
// columns that Help › Troubleshooting renders (03 §8.2) and links to by code.
export const ERROR_HINTS = Object.freeze([
  ['0x80048573,0x80048644', 'Dataverse rejected a LIKE pattern that starts with a wildcard. Remove the leading % or filter on another column.',
    'Dataverse rejected a LIKE pattern that starts with a wildcard.', 'Remove the leading % or filter on another column.'],
  ['0x80048575', 'Dataverse stopped the query for performance reasons. Add a more selective filter.',
    'Dataverse stopped the query for performance reasons.', 'Add a more selective filter.'],
  ['0x8004430d', 'FetchXML allows at most 15 joined tables. Join fewer tables.',
    'FetchXML allows at most 15 joined tables.', 'Join fewer tables.'],
  ['0x8004e023', 'Dataverse cannot aggregate more than 50,000 records in one query.',
    'Dataverse cannot aggregate more than 50,000 records in one query.',
    'Add a filter so that fewer records are aggregated. For a standard table with a createdon column SQL Studio splits the aggregate into createdon ranges and combines the results itself.'],
  ['0x80072322,0x80072321,0x80072326', 'Dataverse service protection limit reached. Wait a few minutes, then run again.',
    'Dataverse service protection limit reached.', 'Wait a few minutes, then run again.'],
  ['0x80040220', 'You are missing a privilege for this table or record. Ask an administrator for a security role that grants it.',
    'You are missing a privilege for this table or record.', 'Ask an administrator for a security role that grants it.'],
  ['0x80040217', 'The record does not exist (it may have been deleted) or you cannot see it.',
    'The record does not exist (it may have been deleted) or you cannot see it.', 'Check the record id, or run the query again to read the current records.'],
  ['0x80041103', 'The table has no column with that name in Dataverse. Check the logical name in the explorer.',
    'The table has no column with that name in Dataverse.', 'Check the logical name in the explorer.'],
  ['0x80041102', 'Dataverse does not know this table, or no relationship exists for this join.',
    'Dataverse does not know this table, or no relationship exists for this join.', 'Check the table name in the explorer, and join on columns that have a relationship.'],
  ['0x80040203', 'Dataverse rejected a value in the request (for example a TOP above 5,000 inside a query part it runs).',
    'Dataverse rejected a value in the request (for example a TOP above 5,000 inside a query part it runs).', 'Check the values in the statement, for example use TOP 5000 or less in a part that runs on Dataverse.'],
  ['0x8004430a', 'Dataverse stops page-number paging at 50,000 rows. Add a filter, or order by columns of the main table only.',
    'Dataverse stops page-number paging at 50,000 rows.', 'Add a filter, or order by columns of the main table only.'],
  ['0x8004023b', 'This table does not allow aggregate queries on Dataverse; SQL Studio aggregates it in the browser when it can.',
    'This table does not allow aggregate queries on Dataverse; SQL Studio aggregates it in the browser when it can.',
    'Add a filter so that the rows fit within “Max rows processed in the browser”, or raise that setting.'],
  ['0x80044151,0x80044150', "Dataverse's database reported a timeout or SQL error. Add a filter or select fewer columns, then run again.",
    "Dataverse's database reported a timeout or SQL error.", 'Add a filter or select fewer columns, then run again.'],
].map(([codes, line, cause, fix]) => Object.freeze({ codes: Object.freeze(codes.split(',')), line, cause, fix })));

const HINT_BY_CODE = new Map(ERROR_HINTS.flatMap(e => e.codes.map(c => [c.toLowerCase(), e])));
const HEX_CODE = /0x[0-9a-f]{8}/gi;

// The ERROR_HINTS entry of a message (its faultCode, a hex code, or the first known 0x8… code in its text), or null.
export function hintFor(m) {
  if (!m || typeof m !== 'object') return null;
  for (const c of [m.faultCode, m.code, m.errorCode]) {
    if (typeof c === 'string' && HINT_BY_CODE.has(c.toLowerCase())) return { code: c.toLowerCase(), hint: HINT_BY_CODE.get(c.toLowerCase()) };
  }
  const text = typeof m.text === 'string' ? m.text : '';
  for (const x of text.match(HEX_CODE) ?? []) {
    const k = x.toLowerCase();
    if (HINT_BY_CODE.has(k)) return { code: k, hint: HINT_BY_CODE.get(k) };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ small helpers

const isObj = v => v != null && typeof v === 'object';
const plural = (n, one, many = one + 's') => `${fmtInt(n)} ${n === 1 ? one : many}`;
const errText = e => (e && typeof e.message === 'string' && e.message ? e.message : String(e ?? 'Unknown error'));
const firstLine = s => { const t = String(s ?? ''); const i = t.search(/\r\n|[\n\r\u2028\u2029]/); return i < 0 ? t : t.slice(0, i); };
const lower = s => String(s ?? '').toLowerCase();
const isSetView = v => typeof v === 'string' && /^r\d+$/.test(v);
const blank = s => !/\S/.test(String(s ?? ''));

// 'a, b and c' for a list of names.
function andList(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Seconds for an announcement: '0.05 seconds', '0.8 seconds', '1 second', '12 seconds' (03 §7: '1,234 rows in 0.8
// seconds.'): two decimals under 1 s (at least 0.01), one under 10 s, else whole seconds.
export function secondsText(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  const v = s < 1 ? Math.max(0.01, Math.round(s * 100) / 100) : s < 10 ? Math.round(s * 10) / 10 : Math.round(s);
  return `${v} ${v === 1 ? 'second' : 'seconds'}`;
}

// --------------------------------------------------------------------------------------------- run slicing

// The text a run sends (03 §7 run controller): {sql, offset, fullText, mode} or null when there is nothing to run.
// mode 'statement' takes the statement at the caret (ranges = parser statementRanges of the text, 01 §1); 'all' and
// 'selection' take the selection when it holds a non-blank character, else the whole text.
export function sliceRun(text, sel, mode, statementAt) {
  const full = String(text ?? '');
  const s = sel && Number.isInteger(sel.start) ? Math.max(0, Math.min(sel.start, full.length)) : 0;
  const e = sel && Number.isInteger(sel.end) ? Math.max(s, Math.min(sel.end, full.length)) : s;
  const selected = e > s && !blank(full.slice(s, e));
  if (mode === 'statement' && !selected) {
    const r = typeof statementAt === 'function' ? statementAt(s) : null;
    if (!r) return blank(full) ? null : { sql: full, offset: 0, fullText: null, mode: 'all' };
    const sql = full.slice(r.start, r.end);
    return blank(sql) ? null : { sql, offset: r.start, fullText: null, mode: 'statement' };
  }
  if (selected) return { sql: full.slice(s, e), offset: s, fullText: full, mode: 'selection' };
  return blank(full) ? null : { sql: full, offset: 0, fullText: null, mode: 'all' };
}

// The statement at a position of a text that the editor does not hold (03 §7: caret in trailing whitespace → the
// nearest previous statement; editor.js pickStatement is the single rule).
export function statementAtText(text, pos, quotedIdentifier = true) {
  let ranges;
  try { ranges = statementRanges(String(text ?? ''), { quotedIdentifier }); } catch { ranges = []; }
  return pickStatement(ranges, pos, String(text ?? ''));
}

// --------------------------------------------------------------------------------------------- result tabs

// A result tab's label (03 §7): the set's title (its source table), else 'Results' (one set) or 'Results n'.
export function setLabel(set, i, n) {
  if (set && typeof set.title === 'string' && set.title.trim()) return set.title.trim();
  return n === 1 ? 'Results' : `Results ${fmtInt(i + 1)}`;
}

// The overflow menu row of a set: 'Results 12 · account · 37 rows'.
export function overflowLabel(set, i) {
  const t = set && typeof set.title === 'string' && set.title.trim() ? ` · ${set.title.trim()}` : '';
  return `Results ${fmtInt(i + 1)}${t} · ${plural(set?.count ?? 0, 'row')}`;
}

// The row-count badge of a result tab: {text, cls}: '12,000+' in amber for an incomplete set (03 §7).
export function setBadge(set) {
  const n = Number.isFinite(set?.count) ? set.count : 0;
  if (set && set.incomplete) return { text: `${fmtInt(n)}+`, cls: 'count amb' };
  return { text: fmtInt(n), cls: 'count' };
}

// The banners of a result set (03 §7): [{kind: 'info'|'warn', text, action?: 'noLimit'|'messages'}], in order:
// truncated, incomplete, the set's warnings (resultdone warnings and 'warn' messages with its setId, each text once),
// then the batch error of a run that failed after it.
export function setBanners(set, { messages = [], error = null } = {}) {
  const out = [];
  if (!set) return out;
  if (set.truncated) out.push({ kind: 'info', text: TEXTS.truncated(set.count ?? 0), action: 'noLimit' });
  if (set.incomplete === 'cancelled') out.push({ kind: 'warn', text: TEXTS.incompleteCancelled(set.count ?? 0) });
  else if (set.incomplete === 'error') out.push({ kind: 'warn', text: TEXTS.incompleteError(set.count ?? 0) });
  const seen = new Set();
  const add = (kind, text) => { if (typeof text === 'string' && text && !seen.has(text)) { seen.add(text); out.push({ kind, text }); } };
  for (const w of Array.isArray(set.warnings) ? set.warnings : []) add(w && w.kind === 'limit' ? 'warn' : 'info', w && w.text);
  for (const m of messages) if (m && m.kind === 'warn' && m.setId === set.id) add(m.code === 'LIMIT' ? 'warn' : 'info', m.text);
  if (error) out.push({ kind: 'warn', text: TEXTS.batchStopped(error), action: 'messages' });
  return out;
}

// The count text of the toolbar (03 §7): '1,234 rows', '12 of 1,234', '12 of 3,000 (loading…)'.
export function countText({ shown = 0, total = 0, loading = false } = {}, filtered = false) {
  const tail = loading ? ' (loading…)' : '';
  if (!filtered && shown === total) return `${plural(total, 'row')}${tail}`;
  return `${fmtInt(shown)} of ${fmtInt(total)}${tail}`;
}

// --------------------------------------------------------------------------------------------- Messages

const MSG_ICONS = Object.freeze({ error: 'error', warn: 'warn', info: 'info', print: 'text', rows: 'okc' });

// The display items of the Messages list (03 §7): one per message, an error with errors[] as a header item
// ('Statement 2: 3 errors') followed by one item per entry in source order. Each item: {m (the message), kind, text,
// pos, end, line, fix, hint, statement (1-based or null), header, sub}.
export function messageItems(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!isObj(m)) continue;
    const statement = Number.isInteger(m.index) ? m.index + 1 : null;
    const errs = m.kind === 'error' && Array.isArray(m.errors) && m.errors.length > 1 ? m.errors.filter(isObj) : null;
    if (errs && errs.length > 1) {
      const sorted = errs.slice().sort((a, b) => (Number.isFinite(a.pos) ? a.pos : Infinity) - (Number.isFinite(b.pos) ? b.pos : Infinity));
      out.push({ m, kind: 'error', header: true, text: `${statement != null ? `Statement ${fmtInt(statement)}: ` : ''}${plural(sorted.length, 'error')}`, statement, pos: null, end: null, line: null, fix: null, hint: null });
      for (const x of sorted) {
        const text = String(x.text ?? x.message ?? '');
        out.push({ m, kind: 'error', sub: true, text, statement, pos: Number.isFinite(x.pos) ? x.pos : null, end: Number.isFinite(x.end) ? x.end : null, line: Number.isFinite(x.line) ? x.line : null, fix: validFix(x.fix), hint: hintFor({ ...x, text }) });
      }
      continue;
    }
    const text = String(m.text ?? '');
    out.push({ m, kind: MSG_ICONS[m.kind] ? m.kind : 'info', text, statement, pos: Number.isFinite(m.pos) ? m.pos : null, end: Number.isFinite(m.end) ? m.end : null, line: Number.isFinite(m.line) ? m.line : null, fix: validFix(m.fix), hint: m.kind === 'error' || m.kind === 'warn' ? hintFor(m) : null });
  }
  return out;
}

// A fix {pos, end, text} that can be applied, or null.
function validFix(f) {
  return isObj(f) && Number.isInteger(f.pos) && Number.isInteger(f.end) && f.end >= f.pos && typeof f.text === 'string' ? f : null;
}

// The 'Messages' tab badge (03 §7): {text, cls}, red ('count bad') while an error is listed.
export function messagesBadge(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const errors = list.some(m => m && m.kind === 'error');
  return { text: fmtInt(list.length), cls: errors ? 'count bad' : 'count' };
}

// The secondary facts of a message line: '37 rows affected', its duration.
export function messageFacts(m) {
  const out = [];
  if (!isObj(m)) return out;
  const n = Number.isFinite(m.rows) ? m.rows : null;
  if (n != null) out.push(`${plural(n, 'row')} affected`);
  if (Number.isFinite(m.ms)) out.push(fmtDuration(m.ms));
  return out;
}

// The run markers of a run's messages (03 §5 'run' source): errors (and errors[] entries) with positions.
export function runMarkers(messages) {
  const out = [];
  for (const it of messageItems(messages)) {
    if (it.kind !== 'error' || it.header || it.pos == null) continue;
    out.push({ start: it.pos, end: it.end != null && it.end > it.pos ? it.end : it.pos, level: 'error', message: it.text });
  }
  return out;
}

// --------------------------------------------------------------------------------------------- status texts

// The running status (03 §7): 'Running… 1.2 s', 'Running… 12,000 rows · 3.2 s', 'Running statement 2 of 5 · 12,000
// rows · 3.2 s'.
export function runningText({ index = null, total = 0, rows = 0, ms = 0 } = {}) {
  const t = fmtDuration(ms);
  if (total > 1 && Number.isInteger(index)) return `Running statement ${fmtInt(index + 1)} of ${fmtInt(total)} · ${plural(rows, 'row')} · ${t}`;
  return rows ? `Running… ${plural(rows, 'row')} · ${t}` : `Running… ${t}`;
}

const WRITE_VERBS = Object.freeze({ update: 'Updating', delete: 'Deleting', insert: 'Creating', associate: 'Associating', disassociate: 'Disassociating', mixed: 'Applying changes to' });

// The write status (03 §7): 'Updating account · 1,200 of 5,000 · 3 failed'; {text, batches} where batches is the
// ' · batches of 25' suffix or ''.
export function writeText(w) {
  if (!isObj(w)) return { text: '', batches: '' };
  const verb = w.op === 'action' ? `Running ${w.action || 'the action'} on` : WRITE_VERBS[w.op] || 'Writing';
  const parts = [`${verb} ${w.entity || 'records'}`, `${fmtInt(w.done ?? 0)} of ${fmtInt(w.total ?? 0)}`];
  if (w.failed) parts.push(`${fmtInt(w.failed)} failed`);
  const batches = Number.isFinite(w.batchSize) && Number.isFinite(w.batchMax) && w.batchSize < w.batchMax ? TEXTS.batchesOf(w.batchSize) : '';
  return { text: parts.join(' · '), batches };
}

// The pill of a write (03 §3): {text: 'Writing changes · 1,200 of 5,000', sub: ' · about 2 min left'}; the time left
// is the remaining records at the measured rate.
export function writePill(w, elapsedMs) {
  const done = Math.max(0, w?.done ?? 0), total = Math.max(0, w?.total ?? 0);
  let sub = '';
  if (done > 0 && total > done && elapsedMs > 0) sub = ` · ${fmtTimeLeft((total - done) * (elapsedMs / 1000) / done)}`;
  return { text: `Writing changes · ${fmtInt(done)} of ${fmtInt(total)}`, sub, icon: 'spin' };
}

// The done status (03 §7): {kind: 'ok'|'error'|'cancelled', text}: '✓ 1,234 rows · 0.82 s', '✗ <first error line>',
// '✗ 3 errors: <first line>', 'Query cancelled'.
export function doneStatus({ ok, cancelled, rows = 0, ms = 0, error = null, summary = null } = {}) {
  if (cancelled) return { kind: 'cancelled', text: TEXTS.cancelled };
  if (!ok) {
    const n = Array.isArray(error?.errors) && error.errors.length > 1 ? error.errors.length : 0;
    const line = firstLine(error?.text ?? error?.message ?? 'The query failed.');
    return { kind: 'error', text: n ? `✗ ${fmtInt(n)} errors: ${line}` : `✗ ${line}` };
  }
  if (typeof summary === 'string' && summary) return { kind: 'ok', text: `✓ ${summary}` };
  return { kind: 'ok', text: `✓ ${plural(rows, 'row')} · ${fmtDuration(ms)}` };
}

// The announcement of a run's end (03 §7): '1,234 rows in 0.8 seconds.', 'Query failed: <first line>', 'Query cancelled.'
export function endAnnouncement({ ok, cancelled, rows = 0, ms = 0, error = null } = {}) {
  if (cancelled) return 'Query cancelled.';
  if (!ok) return `Query failed: ${firstLine(error?.text ?? error?.message ?? '')}`;
  return `${plural(rows, 'row')} in ${secondsText(ms)}.`;
}

// '+05:30' style offset text of minutes east of UTC, with a true minus sign: 'UTC−05:00'.
export function utcOffsetText(min) {
  const m = Math.round(Number(min) || 0);
  const a = Math.abs(m);
  return `UTC${m < 0 ? '−' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

// The status bar's time-zone label (03 §7): {text, warn, title}: 'UTC', 'Local (UTC−05:00)', or with a differing
// Dataverse zone 'Local (UTC−05:00) · Dataverse UTC−08:00' and its tooltip (02 §2 tzMatchesBrowser).
export function tzLabel(tz, meta, nowMs = Date.now()) {
  if (!tz || tz.utc) return { text: 'UTC', warn: false, title: TEXTS.tzToggle('UTC') };
  const local = `Local (${utcOffsetText(tz.offset(nowMs))})`;
  const u = meta && meta.user;
  if (u && meta.tzMatchesBrowser === false && Number.isFinite(u.tzBias)) {
    const dv = -((u.tzBias ?? 0) + (u.tzStandardBias ?? 0));
    return { text: `${local} · Dataverse ${utcOffsetText(dv)}`, warn: true, title: TEXTS.tzWarn };
  }
  return { text: local, warn: false, title: TEXTS.tzToggle('local time') };
}

// --------------------------------------------------------------------------------------------- change entries

const OP_LABELS = Object.freeze({ update: 'Update', delete: 'Delete', insert: 'Create', associate: 'Associate', disassociate: 'Disassociate', action: 'Action', mixed: 'Grid changes' });
const PAST = Object.freeze({ update: 'Updated', delete: 'Deleted', insert: 'Created', associate: 'Associated', disassociate: 'Disassociated' });
const len = a => (Array.isArray(a) ? a.length : 0);
const isBulk = e => isObj(e) && Array.isArray(e.jobs) && e.jobs.length > 0;

// The operation label of a change entry (03 §7 Changes): 'Update', 'Delete (BulkDelete job)', 'Grid changes', …
export function changeOpLabel(e) {
  if (isBulk(e)) return 'Delete (BulkDelete job)';
  if (e?.op === 'action' && e.action) return `Action ${e.action}`;
  return OP_LABELS[e?.op] ?? 'Change';
}

// The counts line of a change entry: '4,997 succeeded · 3 failed · 2 skipped · 1 outcome unknown · 5 not attempted'.
export function changeCounts(e) {
  if (isBulk(e)) return `${plural(len(e.ok), 'record')} submitted in ${plural(e.jobs.length, 'job')}`;
  const parts = [`${fmtInt(len(e?.ok))} succeeded`];
  if (len(e?.failed)) parts.push(`${fmtInt(len(e.failed))} failed`);
  if (len(e?.skipped)) parts.push(`${fmtInt(len(e.skipped))} skipped`);
  if (len(e?.unknown)) parts.push(`${fmtInt(len(e.unknown))} outcome unknown`);
  if (len(e?.notAttempted)) parts.push(`${fmtInt(len(e.notAttempted))} not attempted`);
  return parts.join(' · ');
}

// The toast of a finished write (03 §7): {text, kind}: 'Updated 4,997 records. 3 failed.'; a BulkDelete entry:
// 'Started a BulkDelete job for 37 audit records. Dataverse deletes them in the background.'
export function writeToast(e) {
  if (!isObj(e)) return null;
  const table = e.entity || 'records';
  if (isBulk(e)) {
    return { text: `Started ${e.jobs.length === 1 ? 'a BulkDelete job' : `${fmtInt(e.jobs.length)} BulkDelete jobs`} for ${fmtInt(len(e.ok))} ${table} ${len(e.ok) === 1 ? 'record' : 'records'}. Dataverse deletes them in the background.`, kind: 'ok', bulk: true };
  }
  const ok = len(e.ok), failed = len(e.failed), skipped = len(e.skipped), unknown = len(e.unknown);
  let head;
  if (e.op === 'mixed') head = `Applied ${plural(ok, 'change')} to ${table}.`;
  else if (e.op === 'action') head = `Ran ${e.action || 'the action'} on ${plural(ok, 'record')}.`;
  else head = `${PAST[e.op] ?? 'Changed'} ${plural(ok, 'record')}.`;
  const tail = [failed ? ` ${fmtInt(failed)} failed.` : '', skipped ? ` ${fmtInt(skipped)} skipped.` : '', unknown ? ` ${fmtInt(unknown)} with an unknown outcome.` : ''].join('');
  const kind = !ok && (failed || unknown) ? 'error' : failed || unknown || skipped ? 'warn' : 'ok';
  return { text: head + tail, kind, bulk: false };
}

// Why Undo is not available for an entry, or null when it is (03 §7 Changes).
export function undoBlocked(e) {
  if (isBulk(e)) return TEXTS.bulkUndo;
  if (!e || e.undoable !== true) return typeof e?.undoReason === 'string' && e.undoReason ? e.undoReason : TEXTS.noUndo;
  return null;
}

// Plain text of a logged value (CSV log): '' for NULL, ISO 8601 for dates, '0x…' for binary, else String().
export function logValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  if (v instanceof Uint8Array) { let s = '0x'; for (const b of v) s += b.toString(16).toUpperCase().padStart(2, '0'); return s; }
  if (isObj(v)) { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

// The CSV log of a change entry (Download log, 03 §7): a header Status, Record id, then '<col> (before)' and
// '<col> (after)' per column, then Message; one line per record (ok, failed, skipped, outcome unknown, not attempted).
// CRLF, UTF-8 BOM, formula neutralisation of text cells when `neutral` (00 §5 rule 7).
// A number or BigInt cell is written raw: only text gets the formula prefix.
const isNum = v => typeof v === 'number' || typeof v === 'bigint';

export function changeLogCsv(e, { neutral = true } = {}) {
  const cols = Array.isArray(e?.columns) ? e.columns.map(String) : [];
  const cell = (s, text = true) => csvField(neutral && text ? csvNeutralize(s) : s);
  const lines = [['Status', 'Record id', ...cols.flatMap(c => [`${c} (before)`, `${c} (after)`]), 'Message'].map(s => cell(s)).join(',')];
  const row = (status, id, before, after, message) => {
    const vals = [];
    for (let i = 0; i < cols.length; i++) {
      vals.push(cell(logValue(Array.isArray(before) ? before[i] : null), !(Array.isArray(before) && isNum(before[i]))));
      vals.push(cell(logValue(Array.isArray(after) ? after[i] : null), !(Array.isArray(after) && isNum(after[i]))));
    }
    lines.push([cell(status), cell(String(id ?? '')), ...vals, cell(message ?? '')].join(','));
  };
  for (const r of e?.ok ?? []) row('ok', r?.id, r?.before, r?.after, '');
  for (const r of e?.failed ?? []) row('failed', r?.id, null, null, [r?.code, r?.message].filter(Boolean).join(': '));
  for (const r of e?.skipped ?? []) row('skipped', r?.id, null, null, r?.reason ?? '');
  for (const id of e?.unknown ?? []) row('unknown', id, null, null, TEXTS.unknownOutcome);
  for (const id of e?.notAttempted ?? []) row('not attempted', id, null, null, '');
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

// The file name of a change log: sqlstudio-changes-<table>-<yyyyMMdd-HHmm>.csv in the display time zone.
export function changeLogName(e, nowMs, tz) {
  const d = fmtDate(nowMs, tz);
  const stamp = d.slice(0, 10).replace(/-/g, '') + '-' + d.slice(11, 16).replace(':', '');
  return `sqlstudio-changes-${safeFileName(e?.entity || 'records', 'records')}-${stamp}.csv`;
}

// --------------------------------------------------------------------------------------------- row details

// The rows of the row details sheet (03 §7): one per visible column in displayed order: {name, display, friendly,
// raw, cls}; `fmt` = formatCell options of the grid (tz, dateFormat, label, known).
export function detailRows(table, row, fmt = {}) {
  if (!table || !Array.isArray(row)) return [];
  const order = Array.isArray(table.order) ? table.order : table.columns.map((_, i) => i);
  const out = [];
  for (const i of order) {
    const col = table.columns[i];
    if (!col || col.hidden) continue;
    const f = formatCell(row[i], col, { ...fmt, friendly: true, row, full: true });
    const r = formatCell(row[i], col, { ...fmt, friendly: false, row, full: true });
    out.push({ name: colLabel(col), display: col.attr?.displayName && col.attr.displayName !== col.name ? col.attr.displayName : '', friendly: f.text, raw: r.text, cls: f.cls, rawCls: r.cls, idx: i });
  }
  return out;
}

// The record a row opens (Open record, 03 §7): {entity, id} of the set's first source table, or null.
export function rowRecord(source, row) {
  const t = source && Array.isArray(source.tables) ? source.tables[0] : null;
  if (!t || !Array.isArray(row) || !Number.isInteger(t.pkIndex)) return null;
  const id = row[t.pkIndex];
  return typeof id === 'string' && isGuid(id) && typeof t.entity === 'string' ? { entity: t.entity, id } : null;
}

// --------------------------------------------------------------------------------------------- Plan

const PLAN_ICONS = [
  [/^(FetchScan|PartitionedAggregate|MetaScan|ApiFnScan)$/, 'db'], [/Join|NestedLoop|Apply/, 'relation'], [/^Filter$/, 'filter'],
  [/^Sort$/, 'sortDown'], [/^(Top|Offset)$/, 'rows'], [/Aggregate|Window/, 'sigma'], [/^Project$/, 'column'],
  [/Spool|Seek/, 'list'], [/^(Concat|SetOp|Distinct)$/, 'table'], [/^(Write|Into)$/, 'edit'], [/Output$/, 'code'],
  [/^(ConstantScan|TempScan|TvfScan)$/, 'table'],
];

// The icon of a plan node: 'code' for the Script pseudo-nodes, else by operator.
export function nodeIcon(node) {
  if (node && node.script) return 'code';
  const op = String(node?.op ?? '');
  for (const [re, name] of PLAN_ICONS) if (re.test(op)) return name;
  return 'plan';
}

// The badge of a plan node (03 §7): Dataverse (cloud) when it runs on the server, Browser (monitor) when in the
// browser, the neutral 'Script' for the control-flow pseudo-nodes; null for other pseudo-nodes.
export function nodeBadge(node) {
  if (!node) return null;
  if (node.script) return { text: 'Script', icon: 'code', cls: 'badge' };
  if (node.server === true) return { text: 'Dataverse', icon: 'cloud', cls: 'badge rs-srv' };
  if (node.server === false) return { text: 'Browser', icon: 'monitor', cls: 'badge' };
  return null;
}

// The estimated rows of a node from its props ('Estimated rows', 02 §6), or null.
export function estRows(node) {
  const p = Array.isArray(node?.props) ? node.props.find(x => x && x.name === 'Estimated rows') : null;
  if (!p) return null;
  const n = typeof p.value === 'number' ? p.value : Number(String(p.value).replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// The rows a connector stands for: the actual rows after a run, the estimated rows in an estimated plan, else null.
export function connectorRows(node, estimated) {
  if (!estimated && node?.stats && Number.isFinite(node.stats.rows)) return node.stats.rows;
  if (estimated) return estRows(node);
  return null;
}

// The connector width in px: 1 + min(5, log10(rows + 1)), 1 px when the rows are unknown.
export function connectorWidth(rows) {
  if (!Number.isFinite(rows) || rows < 0) return 1;
  return 1 + Math.min(5, Math.log10(rows + 1));
}

// '42.0%' of a node's ms in its statement's ms (one decimal, at most 100%), or null when either is unknown.
export function timeShare(nodeMs, statementMs) {
  if (!Number.isFinite(nodeMs) || !Number.isFinite(statementMs) || statementMs <= 0) return null;
  // tenths of a percent from one division, so 3 of 2,000 ms (exactly 1.5 tenths) rounds up to 0.2%
  const tenths = Math.round(Math.min(1000, Math.max(0, (nodeMs * 1000) / statementMs)));
  return `${(tenths / 10).toFixed(1)}%`;
}

// A node's run statistics line (03 §7): '1,234 rows · 3 requests · 120 ms'; '' without stats (estimated plans).
export function nodeStatsText(node) {
  const s = node?.stats;
  if (!s) return '';
  const parts = [plural(s.rows ?? 0, 'row')];
  if (s.requests) parts.push(plural(s.requests, 'request'));
  if (Number.isFinite(s.ms)) parts.push(fmtDuration(s.ms));
  return parts.join(' · ');
}

// The denominator of a statement's time share: its own ms, never less than its root node's ms.
export function statementMs(entry) {
  const own = Number.isFinite(entry?.ms) ? entry.ms : 0;
  const root = Number.isFinite(entry?.plan?.stats?.ms) ? entry.plan.stats.ms : 0;
  return Math.max(own, root) || null;
}

// The rows of the plan tree (03 §7): a header per statement, then its nodes in pre-order, each {key (the path
// '<statement>/<child>/…'), depth, node, entry, kids, parentKey, header, width (connector px), rows}. `collapsed`
// holds the keys whose children are hidden.
export function planRows(entries, { collapsed = null, estimated = false } = {}) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isObj(entry) || (!entry.plan && !entry.error)) continue;
    const sk = `s${Number.isInteger(entry.index) ? entry.index : out.length}`;
    out.push({ key: sk, depth: 0, header: true, entry, node: null, kids: entry.plan ? 1 : 0, parentKey: null });
    if (!entry.plan || collapsed?.has(sk)) continue;
    const est = estimated || !!entry.estimated;
    const stack = [[entry.plan, `${sk}/0`, 1, sk]];
    while (stack.length) {
      const [node, key, depth, parentKey] = stack.pop();
      const kids = Array.isArray(node.kids) ? node.kids : [];
      const rows = connectorRows(node, est);
      out.push({ key, depth, header: false, entry, node, kids: kids.length, parentKey, rows, width: connectorWidth(rows) });
      if (collapsed?.has(key)) continue;
      for (let i = kids.length - 1; i >= 0; i--) if (isObj(kids[i])) stack.push([kids[i], `${key}/${i}`, depth + 1, key]);
    }
  }
  return out;
}

// The properties panel of a plan node: groups [{title, items: [{name, value, long}]}]: the operator, its
// options (explain props without 'Estimated rows'), 'Estimated' (the estimated rows when explain knows them), and
// after a run 'After the run' (actual rows, executions, requests, ms, % of statement time), then its warnings.
export function nodeProps(node, { statementMs: total = null } = {}) {
  if (!node) return [];
  const item = (name, value) => { const v = String(value ?? ''); return { name: String(name ?? ''), value: v, long: v.length > LONG_VALUE || /[\n\r]/.test(v) }; };
  const groups = [];
  const op = [item('Operator', node.op)];
  if (node.detail) op.push(item('Details', node.detail));
  const b = nodeBadge(node);
  if (b) op.push(item('Runs', b.text === 'Script' ? 'Script (control flow)' : b.text === 'Dataverse' ? 'On Dataverse' : 'In the browser'));
  groups.push({ title: 'Operator', items: op });
  const props = (Array.isArray(node.props) ? node.props : []).filter(p => isObj(p) && p.name !== 'Estimated rows').map(p => item(p.name, p.value));
  if (props.length) groups.push({ title: 'Options', items: props });
  const est = estRows(node);
  if (est != null) groups.push({ title: 'Estimated', items: [item('Estimated rows', fmtInt(est))] });
  const s = node.stats;
  if (s) {
    const after = [item('Actual rows', fmtInt(s.rows ?? 0)), item('Executions', fmtInt(s.calls ?? 0)), item('Requests', fmtInt(s.requests ?? 0)), item('Time', fmtDuration(s.ms ?? 0))];
    const share = timeShare(s.ms, total);
    if (share) after.push(item('% of statement time', share));
    groups.push({ title: 'After the run', items: after });
  }
  if (Array.isArray(node.warnings) && node.warnings.length) groups.push({ title: 'Warnings', items: node.warnings.map((w, i) => item(node.warnings.length > 1 ? `Warning ${i + 1}` : 'Warning', w)) });
  return groups;
}

// The text of Copy plan (03 §7): each statement, then its nodes indented by two spaces per level:
// 'FetchScan — account [Dataverse] · 12 rows · 1 request · 80 ms', warnings as '  ! text'.
export function planText(entries, { estimated = false } = {}) {
  const lines = [];
  if (estimated) lines.push('Estimated plan');
  for (const r of planRows(entries, { estimated })) {
    if (r.header) {
      if (lines.length) lines.push('');
      const n = Number.isInteger(r.entry.index) ? r.entry.index + 1 : null;
      lines.push(`${n != null ? `Statement ${n}` : 'Statement'}${r.entry.error ? `: ${errText(r.entry.error)}` : ''}`);
      continue;
    }
    const node = r.node;
    const pad = '  '.repeat(r.depth);
    const b = nodeBadge(node);
    const stats = nodeStatsText(node);
    lines.push(`${pad}${node.op}${node.detail ? ` — ${node.detail}` : ''}${b ? ` [${b.text}]` : ''}${stats ? ` · ${stats}` : ''}`);
    for (const w of Array.isArray(node.warnings) ? node.warnings : []) lines.push(`${pad}  ! ${w}`);
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------------------------- FetchXML

// The FetchXML items of plan entries (03 §7 FetchXML view): [{key, stmt (0-based index), i, n (per statement), xml}].
export function fetchItems(entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const list = Array.isArray(e?.fetchXml) ? e.fetchXml.filter(x => typeof x === 'string' && x) : [];
    list.forEach((xml, i) => out.push({ key: `s${e.index}/f${i}`, stmt: Number.isInteger(e.index) ? e.index : null, i, n: list.length, xml, entry: e }));
  }
  return out;
}

// The personal view of a result set (Open as view): {entity, fetchXml, live,
// note} or {error}. A plan whose rows are its one FetchXML's keeps its filter (live view; paging attributes removed);
// otherwise, or with TOP, the view lists the returned records of the root table by id (a snapshot, at most 2,000).
export function viewOfSet(set, entry, { max = 2000 } = {}) {
  if (!set || set.streaming) return { error: 'Wait for the query to finish.' };
  const fx = entry && serverRows(entry.plan) ? entry.fetchXml?.[0] ?? null : null;
  if (fx && /^<fetch\b[^>]*\baggregate="true"/.test(String(fx))) return { error: 'Open as view needs rows of records: this query groups them into totals.' };
  const top = fx != null && /^<fetch [^>]*top="/.test(String(fx));
  if (fx && !top) {
    const xml = String(fx).replace(/^<fetch\b[^>]*>/, tag => tag.replace(/\s(count|page|paging-cookie|top|returntotalrecordcount)="[^"]*"/g, ''));
    const entity = fetchEntity(xml);
    if (entity) return { entity, fetchXml: xml, live: true, note: "The view keeps this query's filter, so it shows matching records as they change." };
  }
  const t = set.source?.tables?.length === 1 ? set.source.tables[0] : null;
  if (!t || !Number.isInteger(t.pkIndex) || !t.entity) return { error: 'Open as view needs the rows of one table: this result has no record ids.' };
  const seen = new Set();
  for (const r of set.rows) { const id = r[t.pkIndex]; if (isGuid(id)) seen.add(id); }
  const ids = [...seen];
  if (ids.length > max) return { error: `Open as view lists the returned records by id, at most ${fmtInt(max)}; this result has ${fmtInt(ids.length)}. Narrow the query, or make it run entirely in Dynamics.` };
  const cols = set.columns.filter(c => !c.hidden && c.attr && c.attr.entity === t.entity && (c.qual ?? null) === (t.qual ?? null)).map(c => c.attr.logicalName);
  const pk = set.columns[t.pkIndex]?.attr?.logicalName;
  const attrs = [...new Set([...cols, pk].filter(Boolean))];
  const cond = ids.length ? `<condition attribute="${xmlEsc(pk)}" operator="in">${ids.map(id => `<value>${xmlEsc(id)}</value>`).join('')}</condition>` : `<condition attribute="${xmlEsc(pk)}" operator="null"/>`;
  const xml = `<fetch><entity name="${xmlEsc(t.entity)}">${attrs.map(a => `<attribute name="${xmlEsc(a)}"/>`).join('')}<filter>${cond}</filter></entity></fetch>`;
  const why = top ? 'This query has TOP' : 'Part of this query runs in the browser';
  return { entity: t.entity, fetchXml: xml, live: false, note: `${why}, so the view lists the ${fmtInt(ids.length)} returned record${ids.length === 1 ? '' : 's'} by id.` };
}

// The root entity name of a FetchXML text, or null.
export function fetchEntity(xml) {
  try {
    const root = parseXml(String(xml ?? ''));
    if (root?.name !== 'fetch') return null;
    const e = (root.kids ?? []).find(k => k && k.name === 'entity');
    const n = e?.attrs?.get?.('name');
    return typeof n === 'string' && /^[a-z0-9_]+$/i.test(n) ? n.toLowerCase() : null;
  } catch {
    return null;
  }
}

// The Web API URL of a FetchXML query (Copy as Web API URL, 03 §7): <origin>/api/data/v9.2/<set>?fetchXml=<encoded>,
// or null when the table or its entity set is unknown.
export function webApiUrl(xml, meta, origin) {
  const name = fetchEntity(xml);
  const info = name && meta && typeof meta.findEntity === 'function' ? meta.findEntity(name) : null;
  const set = info?.entitySetName;
  if (typeof set !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(set)) return null;
  return `${origin}/api/data/v9.2/${set}?fetchXml=${encodeURIComponent(String(xml))}`;
}

// The plan nodes that carry FetchXML (FetchScan, PartitionedAggregate).
function fetchNodes(plan) {
  const out = [];
  const stack = plan ? [plan] : [];
  while (stack.length) {
    const n = stack.pop();
    if (!isObj(n)) continue;
    if (n.fetchXml != null) out.push(n);
    for (const k of Array.isArray(n.kids) ? n.kids : []) stack.push(k);
  }
  return out;
}

// True when the rows of a plan are exactly the rows of its one FetchXML: every node runs on Dataverse, or is a
// Project, which only picks and computes columns (Open as view keeps the filter then).
function serverRows(plan) {
  if (!isObj(plan)) return false;
  const stack = [plan];
  while (stack.length) {
    const n = stack.pop();
    if (!isObj(n)) continue;
    if (n.server === false && n.op !== 'Project') return false;
    for (const k of Array.isArray(n.kids) ? n.kids : []) stack.push(k);
  }
  const f = fetchNodes(plan);
  return f.length === 1 && typeof f[0].fetchXml === 'string';
}

// True when an executed plan ran wholly on Dataverse with exactly one FetchScan (Save as personal view, 03 §7): no
// operator runs in the browser.
export function wholeServerPlan(plan) {
  if (!plan) return false;
  const stack = [plan];
  while (stack.length) {
    const n = stack.pop();
    if (!isObj(n)) continue;
    if (n.server === false) return false;
    for (const k of Array.isArray(n.kids) ? n.kids : []) stack.push(k);
  }
  const f = fetchNodes(plan);
  return f.length === 1 && typeof f[0].fetchXml === 'string';
}

// The Convert ▸ state of an explain entry (03 §7): {ok, title, xml, url}: enabled only for one serverOnly statement
// with exactly one FetchScan.
export function convertState(entries, meta, origin) {
  const list = Array.isArray(entries) ? entries.filter(isObj) : [];
  const sel = list.filter(e => e.kind !== 'other' || e.plan);
  if (sel.length !== 1) return { ok: false, title: TEXTS.oneStatement };
  const e = sel[0];
  if (e.error) return { ok: false, title: errText(e.error) };
  const nodes = fetchNodes(e.plan);
  const xml = Array.isArray(e.fetchXml) && e.fetchXml.length === 1 ? e.fetchXml[0] : null;
  if (!e.serverOnly || nodes.length !== 1 || typeof xml !== 'string') return { ok: false, title: TEXTS.partlyInBrowser };
  return { ok: true, title: null, xml, url: typeof e.webApiUrl === 'string' && e.webApiUrl ? e.webApiUrl : webApiUrl(xml, meta, origin) };
}

// Clause words that end a FROM clause at its own parenthesis depth.
const FROM_END = new Set(['WHERE', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'OPTION', 'FOR', 'SELECT', 'SET', 'VALUES',
  'INSERT', 'UPDATE', 'DELETE', 'DECLARE', 'IF', 'ELSE', 'WHILE', 'BEGIN', 'END', 'GO', 'PRINT', 'EXEC', 'EXECUTE', 'RETURN', 'OUTPUT', 'WITH']);

// The tables a text names after FROM (and the commas of its FROM list), JOIN, APPLY, UPDATE, INTO and DELETE (the
// toolbar hint's metadata check), lower case, without #temp, @table, metadata., sys. and CTE names and
// without table-valued function calls; null when the text cannot be read.
export function referencedTables(text) {
  let toks;
  try { toks = tokenize(String(text ?? ''), false); } catch { return null; }
  const out = new Set(), ctes = new Set();
  const K = t => (t && t.t === 'id' ? t.k : null);
  const isName = t => !!t && (t.t === 'id' || t.t === 'qid');
  const isOp = (t, v) => !!t && t.t === 'op' && t.v === v;
  // CTE names: `name AS (` (a derived table's alias is never followed by '(').
  for (let i = 0; i + 2 < toks.length; i++) if (isName(toks[i]) && K(toks[i + 1]) === 'AS' && isOp(toks[i + 2], '(')) ctes.add(lower(toks[i].v));
  // The table name starting at token j: a TVF call (`name(`) counts only where a table source may be a function.
  const take = (j, fnAllowed) => {
    const t = toks[j];
    if (!t || t.t === 'var' || !isName(t) || (t.t === 'id' && String(t.v).startsWith('#'))) return;
    if (t.t === 'id' && FROM_END.has(t.k)) return;
    const parts = [String(t.v)];
    let k = j;
    while (isOp(toks[k + 1], '.') && isName(toks[k + 2])) { parts.push(String(toks[k + 2].v)); k += 2; }
    if (fnAllowed && isOp(toks[k + 1], '(')) return;
    const q = parts.length > 1 ? lower(parts[0]) : null;
    const n = lower(parts[parts.length - 1]);
    if (!n.startsWith('#') && q !== 'metadata' && q !== 'sys' && !ctes.has(n)) out.add(n);
  };
  const froms = [];   // parenthesis depths of the open FROM clauses
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (isOp(t, '(')) { depth++; continue; }
    if (isOp(t, ')')) { depth--; while (froms.length && froms[froms.length - 1] > depth) froms.pop(); continue; }
    if (isOp(t, ';')) { froms.length = 0; continue; }
    const k = K(t);
    if (froms.length && froms[froms.length - 1] === depth) {
      if (isOp(t, ',')) { take(i + 1, true); continue; }
      if (k && FROM_END.has(k)) froms.pop();
    }
    if (k === 'FROM') { froms.push(depth); take(i + 1, true); continue; }
    if (k === 'JOIN' || k === 'APPLY') { take(i + 1, true); continue; }
    if (k === 'UPDATE' || k === 'INTO') { take(i + 1, false); continue; }
    if (k === 'DELETE' && K(toks[i + 1]) !== 'FROM') take(i + 1, false);
  }
  return [...out];
}

// --------------------------------------------------------------------------------------------- charts (§7.3)

export const CHART_TYPES = Object.freeze(['column', 'bar', 'line', 'pie', 'scatter']);
export const CHART_TYPE_LABELS = Object.freeze({ column: 'Column', bar: 'Bar', line: 'Line', pie: 'Pie', scatter: 'Scatter' });
const CHART_ICONS = Object.freeze({ column: 'chartColumn', bar: 'chartBar', line: 'chartLine', pie: 'chartPie', scatter: 'chartScatter' });
export const AGGS = Object.freeze(['none', 'sum', 'count', 'avg', 'min', 'max']);
export const AGG_LABELS = Object.freeze({ none: 'None', sum: 'Sum', count: 'Count', avg: 'Average', min: 'Min', max: 'Max' });
export const ORDERS = Object.freeze(['view', 'value', 'label']);
export const ORDER_LABELS = Object.freeze({ view: 'View order', value: 'Largest first', label: 'Label A–Z' });
export const COUNT_KEY = '#count';
export const ROW_KEY = '#';
const MAX_CATS = 100, MAX_SLICES = 12, MAX_POINTS = 10000, MAX_Y = 8, AUTO_Y = 4, LABEL_MAX = 16;
const CHUNK = 512;                   // rows between clock checks of the sliced chart work
const AGG_NAMES = Object.freeze({ sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max', count: 'Count' });

// The chart kind of a column (§7.3): 'number' (int, bigint, decimal, money, float that are not choice codes or
// labelled), 'date' (date, datetime, datetimeoffset) or 'category' (everything else: choice, string, lookup, bool…).
export function chartColKind(col) {
  if (isMeasure(col)) return 'number';
  const dt = dtOfCol(col);
  return dt === 'date' || dt === 'datetime' ? 'date' : 'category';
}

// The visible columns of an ExportTable in displayed order: [{i (schema index), col, name, kind}].
export function chartColumns(table) {
  const t = table || {};
  const cols = Array.isArray(t.columns) ? t.columns : [];
  const order = Array.isArray(t.order) ? t.order : cols.map((_, i) => i);
  const out = [];
  for (const i of order) {
    const col = cols[i];
    if (!col || col.hidden) continue;
    out.push({ i, col, name: colLabel(col), kind: chartColKind(col) });
  }
  return out;
}

// Whether a set can be charted (§7.3): {ok, title}: not while it streams, not for an incomplete set.
export function chartAvailability(set) {
  if (!set) return { ok: false, title: TEXTS.chartIncomplete };
  if (set.streaming) return { ok: false, title: STREAMING_TITLE };
  if (set.incomplete) return { ok: false, title: TEXTS.chartIncomplete };
  return { ok: true, title: null };
}

const keyOfValue = (v, col) => {
  try { return keyOf(v, typeOfCol(col)); } catch { return v == null ? '\u0000' : 'x' + String(v); }
};

// The columns of the automatic spec (§7.3): X the first visible non-numeric column (null: '#'), Y the visible numeric
// columns other than X, at most 4.
function autoColumns(table) {
  const cols = chartColumns(table);
  const xc = cols.find(c => c.kind !== 'number') ?? null;
  const ys = cols.filter(c => c.kind === 'number' && c !== xc).slice(0, AUTO_Y).map(c => c.name);
  return { xc, ys };
}
// The automatic spec once the uniqueness of the X values is known.
function autoSpecOf(xc, ys, unique) {
  const agg = !ys.length ? 'count' : !xc || unique ? 'none' : 'sum';
  return { type: xc && xc.kind === 'date' ? 'line' : 'column', x: xc ? xc.name : ROW_KEY, ys: ys.length ? ys : [COUNT_KEY], agg, stacked: false, order: 'view' };
}
// Scans rows [from, to) for a repeated X value (collation equality, as GROUP BY); true when one is found.
function repeatsIn(rows, xc, seen, from, to) {
  for (let p = from; p < to; p++) {
    const k = keyOfValue(rows[p][xc.i], xc.col);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

// The automatic ChartSpec of a table (§7.3): X the first visible non-numeric column (else '#'); Y the visible
// numeric columns other than X, at most 4 (none: 'Count of rows' with Aggregate Count); Aggregate None when every X
// value occurs once in the view, else Sum; Line for a date X, else Column.
export function autoChartSpec(table) {
  const { xc, ys } = autoColumns(table);
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const unique = !xc || !ys.length || !repeatsIn(rows, xc, new Set(), 0, rows.length);
  return autoSpecOf(xc, ys, unique);
}

// autoChartSpec() in slices of at most 8 ms (03 §13: more than 50,000 rows); it stops at the first repeated X value.
export async function autoChartSpecSliced(table, { yieldFn = utilYield, clock = () => performance.now(), signal = null } = {}) {
  const { xc, ys } = autoColumns(table);
  const rows = Array.isArray(table.rows) ? table.rows : [];
  if (!xc || !ys.length) return autoSpecOf(xc, ys, true);
  const seen = new Set();
  let p = 0;
  while (p < rows.length) {
    const t0 = clock();
    while (p < rows.length) {
      const to = Math.min(rows.length, p + CHUNK);
      if (repeatsIn(rows, xc, seen, p, to)) return autoSpecOf(xc, ys, false);
      p = to;
      if (clock() - t0 >= SLICE_MS) break;
    }
    if (p < rows.length) {
      await yieldFn();
      if (signal?.aborted) throw Object.assign(new Error('Chart cancelled.'), { name: 'AbortError' });
    }
  }
  return autoSpecOf(xc, ys, true);
}

// The resolved columns of a spec, or null when a named column no longer exists (§7.3: the automatic spec applies).
export function resolveChart(spec, table) {
  if (!isObj(spec) || !CHART_TYPES.includes(spec.type) || !AGGS.includes(spec.agg)) return null;
  const cols = chartColumns(table);
  const byName = name => cols.find(c => c.name === name) ?? null;
  let x;
  if (spec.x === ROW_KEY && !byName(ROW_KEY)) x = { i: -1, col: null, name: ROW_KEY, kind: 'number', row: true };
  else { x = byName(spec.x); if (!x) return null; }
  const ys = [];
  for (const name of Array.isArray(spec.ys) ? spec.ys.slice(0, MAX_Y) : []) {
    if (name === COUNT_KEY && (spec.agg === 'count' || !byName(COUNT_KEY))) { if (spec.agg === 'count') ys.push({ i: -1, col: null, name: COUNT_KEY, kind: 'number', count: true }); continue; }
    const c = byName(name);
    if (!c || c.kind !== 'number' || c === x) return null;
    ys.push(c);
  }
  if (!ys.length) return null;
  return { x, ys, cols };
}

// The checked spec of a set (§7.3): the given one when every named column exists, else the automatic one.
export function chartSpecFor(spec, table) {
  if (spec && resolveChart(spec, table)) return { type: spec.type, x: spec.x, ys: spec.ys.slice(0, MAX_Y), agg: spec.agg, stacked: !!spec.stacked, order: ORDERS.includes(spec.order) ? spec.order : 'view' };
  return autoChartSpec(table);
}

// A series label: 'revenue', 'Sum of revenue', 'Count of rows', 'Count of revenue'.
function seriesLabel(y, agg) {
  if (y.count) return TEXTS.countOfRows;
  return agg === 'none' ? y.name : `${AGG_NAMES[agg]} of ${y.name}`;
}

// A chart value: finite numbers and BigInts as numbers, anything else null.
const numOf = v => (typeof v === 'number' ? (Number.isFinite(v) ? v : null) : typeof v === 'bigint' ? Number(v) : null);

// The accumulator of a chart model; rows are fed in view order (feedChart), then finishChart() orders and caps. With
// Aggregate None in view order only the categories that can be drawn are kept (100 bars, 10,000 line points, 12 pie
// slices plus the sum of the rest); the others are only counted, so 500,000 rows never make 500,000 objects.
function chartAcc(spec, table, fmt) {
  const r = resolveChart(spec, table);
  if (!r) return null;
  const { x, ys } = r;
  const agg = spec.agg;
  const pointAxis = spec.type === 'scatter' || (spec.type === 'line' && x.kind === 'date');
  const fo = { ...(table.fmt ?? {}), ...(fmt ?? {}), full: false, max: 500, row: null };
  const label = (v, row) => {
    if (x.row) return null;
    if (v == null) return TEXTS.blank;
    fo.row = row;
    return formatCell(v, x.col, fo).text;
  };
  const viewOrder = spec.type === 'line' || spec.order === 'view' || !ORDERS.includes(spec.order);
  const keep = agg === 'none' && !pointAxis && viewOrder
    ? (spec.type === 'pie' ? MAX_SLICES : spec.type === 'line' ? MAX_POINTS : MAX_CATS) : null;
  return {
    spec, x, ys, agg, pointAxis, fo, label, keep,
    other: keep != null && spec.type === 'pie' ? { n: 0, vals: ys.map(() => 0) } : null,
    groups: new Map(), cats: [], points: ys.map(() => []), rows: 0, nullX: 0, total: 0, negative: false,
  };
}

// Feeds rows [from, to) of the view to the accumulator.
function feedChart(acc, rows, from, to) {
  const { x, ys, agg, pointAxis, label } = acc;
  for (let p = from; p < to; p++) {
    const row = rows[p];
    acc.rows++;
    const xv = x.row ? p + 1 : row[x.i];
    if (pointAxis) {
      const xn = x.row ? xv : x.kind === 'date' ? (xv instanceof Date ? xv.getTime() : null) : numOf(xv);
      if (xn == null || !Number.isFinite(xn)) { acc.nullX++; continue; }
      if (agg === 'none') {
        for (let s = 0; s < ys.length; s++) {
          const y = ys[s];
          const yv = y.count ? 1 : numOf(row[y.i]);
          if (yv == null) continue;
          acc.points[s].push({ x: xn, y: yv, row, n: 1 });
        }
        continue;
      }
    }
    if (agg === 'none') {
      acc.total++;
      if (acc.keep != null && acc.cats.length >= acc.keep) {
        // past what can be drawn: counted, and for a pie summed into the Other slice
        for (let s = 0; s < ys.length; s++) {
          const v = ys[s].count ? 1 : numOf(row[ys[s].i]);
          if (v == null) continue;
          if (v < 0) acc.negative = true;
          if (acc.other) acc.other.vals[s] += v;
        }
        if (acc.other) acc.other.n++;
        continue;
      }
      const vals = ys.map(y => (y.count ? 1 : numOf(row[y.i])));
      acc.cats.push({ label: label(xv, row) ?? fmtInt(p + 1), row, n: 1, vals });
      continue;
    }
    const k = x.row ? 'r' + p : keyOfValue(xv, x.col);
    let g = acc.groups.get(k);
    if (!g) {
      const xn = pointAxis ? (x.row ? xv : x.kind === 'date' ? xv.getTime() : numOf(xv)) : null;
      g = { label: label(xv, row) ?? fmtInt(p + 1), row, n: 0, sum: ys.map(() => 0), cnt: ys.map(() => 0), min: ys.map(() => null), max: ys.map(() => null), xn };
      acc.groups.set(k, g);
      acc.cats.push(g);
    }
    g.n++;
    for (let s = 0; s < ys.length; s++) {
      const y = ys[s];
      if (y.count) { g.cnt[s]++; continue; }
      const v = numOf(row[y.i]);
      if (v == null) continue;
      g.sum[s] += v;
      g.cnt[s]++;
      if (g.min[s] == null || v < g.min[s]) g.min[s] = v;
      if (g.max[s] == null || v > g.max[s]) g.max[s] = v;
    }
  }
}

const labelCollator = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });

// The value of an aggregated group for series s.
function groupValue(g, s, agg, y) {
  if (agg === 'none') return g.vals[s];
  if (agg === 'count' || y.count) return g.cnt[s];
  if (!g.cnt[s]) return null;
  if (agg === 'sum') return g.sum[s];
  if (agg === 'avg') return g.sum[s] / g.cnt[s];
  if (agg === 'min') return g.min[s];
  return g.max[s];
}

// Orders, caps and labels the accumulated data: the chart model (§7.3), whose fields the layout and the tooltip use.
function finishChart(acc) {
  const { spec, x, ys, agg, pointAxis } = acc;
  const type = spec.type;
  const notes = [];
  const series = ys.map((y, s) => ({ key: y.count ? COUNT_KEY : y.name, label: seriesLabel(y, agg), cls: `rs-c${(s % 8) + 1}`, y, s }));
  const model = { type, agg, x, ys, series, notes, pointAxis, stacked: false, cats: [], points: null, xKind: pointAxis ? (x.kind === 'date' ? 'time' : 'number') : 'category', rows: acc.rows, fo: acc.fo, negative: acc.negative };
  if (pointAxis) {
    let points;
    if (agg === 'none') points = acc.points;
    else points = ys.map((y, s) => acc.cats.map(g => ({ x: g.xn, y: groupValue(g, s, agg, y), row: g.row, n: g.n, label: g.label })).filter(p => p.y != null && Number.isFinite(p.x)));
    let capped = 0;
    points = points.map(list => {
      if (list.length > MAX_POINTS) { capped = Math.max(capped, list.length); list = list.slice(0, MAX_POINTS); }
      return type === 'line' ? list.slice().sort((a, b) => a.x - b.x) : list;
    });
    if (capped) notes.push(TEXTS.pointCap(MAX_POINTS, agg === 'none' ? acc.rows : capped));
    if (acc.nullX) notes.push(`${plural(acc.nullX, 'row')} with no X value ${acc.nullX === 1 ? 'is' : 'are'} not shown.`);
    model.points = points;
    for (const list of points) for (const p of list) if (p.y < 0) model.negative = true;
    return model;
  }
  let cats = agg === 'none' ? acc.cats : acc.cats.map(g => ({ label: g.label, row: g.row, n: g.n, vals: ys.map((y, s) => groupValue(g, s, agg, y)) }));
  if (type !== 'line') {
    if (spec.order === 'value') cats = cats.map((c, i) => [c, i]).sort((a, b) => ((b[0].vals[0] ?? -Infinity) - (a[0].vals[0] ?? -Infinity)) || a[1] - b[1]).map(a => a[0]);
    else if (spec.order === 'label') cats = cats.map((c, i) => [c, i]).sort((a, b) => labelCollator.compare(a[0].label, b[0].label) || a[1] - b[1]).map(a => a[0]);
  }
  const total = agg === 'none' ? acc.total : cats.length;
  if ((type === 'column' || type === 'bar') && total > MAX_CATS) {
    cats = cats.slice(0, MAX_CATS);
    notes.push(TEXTS.catCap(MAX_CATS, total));
  } else if (type === 'pie' && total > MAX_SLICES) {
    const keepN = MAX_SLICES - 1;
    const kept = cats.slice(0, keepN), rest = cats.slice(keepN);
    const extra = acc.other ?? { n: 0, vals: ys.map(() => 0) };
    const other = { label: TEXTS.pieOther(total - keepN), row: null, n: rest.reduce((a, c) => a + c.n, 0) + extra.n, vals: ys.map((_, s) => rest.reduce((a, c) => a + (c.vals[s] ?? 0), 0) + extra.vals[s]), other: true };
    cats = [...kept, other];
    notes.push(TEXTS.pieCap(keepN, total));
  } else if (type === 'line' && total > MAX_POINTS) {
    cats = cats.slice(0, MAX_POINTS);
    notes.push(TEXTS.pointCap(MAX_POINTS, agg === 'none' ? acc.rows : total));
  }
  for (const c of cats) {
    c.full = c.label;
    c.short = truncateText(c.label, LABEL_MAX);
    for (const v of c.vals) if (v != null && v < 0) model.negative = true;
  }
  model.cats = cats;
  model.stacked = !!spec.stacked && (type === 'column' || type === 'bar') && series.length >= 2;
  return model;
}

// The chart model of a spec over a table's current view (§7.3), synchronously; null when the spec does not resolve.
// fmt: formatCell options (friendly, tz, dateFormat, label, known); the table's own fmt is the default.
export function chartModel(spec, table, fmt) {
  const acc = chartAcc(spec, table, fmt);
  if (!acc) return null;
  const rows = Array.isArray(table.rows) ? table.rows : [];
  feedChart(acc, rows, 0, rows.length);
  return finishChart(acc);
}

// chartModel() in slices of at most 8 ms with a yield between them (03 §13: more than 50,000 rows); onProgress(0..1);
// rejects with an AbortError when the signal aborts.
export async function chartModelSliced(spec, table, fmt, { yieldFn = utilYield, clock = () => performance.now(), signal = null, onProgress = null } = {}) {
  const acc = chartAcc(spec, table, fmt);
  if (!acc) return null;
  const rows = Array.isArray(table.rows) ? table.rows : [];
  let p = 0;
  while (p < rows.length) {
    const t0 = clock();
    while (p < rows.length) {
      const to = Math.min(rows.length, p + CHUNK);
      feedChart(acc, rows, p, to);
      p = to;
      if (clock() - t0 >= SLICE_MS) break;
    }
    if (p < rows.length) {
      if (typeof onProgress === 'function') onProgress(p / rows.length);
      await yieldFn();
      if (signal?.aborted) throw Object.assign(new Error('Chart cancelled.'), { name: 'AbortError' });
    }
  }
  return finishChart(acc);
}

// Why a chart type is unavailable for a spec and model (§7.3), or null: Pie with several series or a negative
// value, Scatter without a numeric (or date) X.
export function chartTypeBlock(type, spec, table, model = null) {
  const r = resolveChart({ ...spec, type }, table);
  if (!r) return null;
  if (type === 'pie') {
    if (r.ys.length > 1) return TEXTS.chartPieSeries;
    if (model && model.negative) return TEXTS.chartPieNegative;
  }
  if (type === 'scatter' && r.x.kind !== 'number' && r.x.kind !== 'date') return TEXTS.chartScatterX;
  return null;
}

// The 1-2-5 × 10^n ticks of a value range (§7.3): {lo, hi, step, ticks}, 4 to 8 ticks where the range allows.
export function niceTicks(lo, hi, { min = 4, max = 8, fromZero = false } = {}) {
  let a = Number.isFinite(lo) ? lo : 0, b = Number.isFinite(hi) ? hi : 0;
  if (fromZero) { a = Math.min(0, a); b = Math.max(0, b); }
  if (b < a) [a, b] = [b, a];
  if (b === a) { const d = a === 0 ? 1 : Math.abs(a) * 0.5; if (!fromZero || a < 0) a -= d; if (!fromZero || b > 0 || b === 0) b += d; if (fromZero) { a = Math.min(0, a); b = Math.max(0, b); } }
  const range = b - a;
  const e0 = Math.floor(Math.log10(range / max)) - 1;
  let best = null;
  for (let e = e0; e <= e0 + 3 && !best; e++) {
    for (const m of [1, 2, 5]) {
      const step = m * 10 ** e;
      const nlo = Math.floor(a / step + 1e-9) * step, nhi = Math.ceil(b / step - 1e-9) * step;
      const count = Math.round((nhi - nlo) / step) + 1;
      if (count <= max) { best = { step, nlo, nhi, count, e }; break; }
    }
  }
  if (!best) { const step = range / (max - 1); best = { step, nlo: a, nhi: b, count: max, e: Math.floor(Math.log10(step)) }; }
  // fewer than `min` ticks: halve the step once when that stays within max
  if (best.count < min) {
    const step = best.step / 2;
    const count = Math.round((best.nhi - best.nlo) / step) + 1;
    if (count <= max) best = { ...best, step, count, e: best.e - 1 };
  }
  const dec = Math.max(0, -Math.floor(Math.log10(best.step) + 1e-9));
  const fix = v => Number(v.toFixed(Math.min(20, dec)));
  const ticks = [];
  for (let k = 0; k < best.count; k++) ticks.push(fix(best.nlo + k * best.step));
  return { lo: fix(best.nlo), hi: fix(best.nhi), step: best.step, ticks };
}

// An axis tick label (§7.3): fmtNumber, compact from 10,000 up ('12K', '1.2M').
export function tickLabel(v) {
  return fmtNumber(v, { compact: true });
}

const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;
const TIME_STEPS = [[1, 'minute'], [5, 'minute'], [15, 'minute'], [30, 'minute'], [1, 'hour'], [3, 'hour'], [6, 'hour'], [12, 'hour'],
  [1, 'day'], [2, 'day'], [7, 'day'], [1, 'month'], [3, 'month'], [6, 'month'], [1, 'year'], [2, 'year'], [5, 'year'], [10, 'year'],
  [25, 'year'], [50, 'year'], [100, 'year']];
const UNIT_MS = { minute: MINUTE, hour: HOUR, day: DAY, month: 30.44 * DAY, year: 365.25 * DAY };

// The instant of a wall-clock time in tz (wall ms = instant + offset).
const fromWall = (wall, tz) => {
  if (!tz || tz.utc) return wall;
  let ms = wall - tz.offset(wall) * MINUTE;
  ms = wall - tz.offset(ms) * MINUTE;
  return ms;
};
const toWall = (ms, tz) => (!tz || tz.utc ? ms : ms + tz.offset(ms) * MINUTE);

// The time-axis ticks of a range of instants in the display time zone (§7.3): minute, hour, day, month or year steps
// chosen by the range (at most 8 ticks); {unit, step, ticks: [{ms, label}]}, labels from fmtDate in tz.
export function timeTicks(lo, hi, tz, { max = 8 } = {}) {
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  const range = Math.max(b - a, MINUTE);
  let pick = TIME_STEPS[TIME_STEPS.length - 1];
  for (const s of TIME_STEPS) { if (range / (s[0] * UNIT_MS[s[1]]) <= max - 1) { pick = s; break; } }
  const [n, unit] = pick;
  const w = new Date(toWall(a, tz));
  let y = w.getUTCFullYear(), mo = w.getUTCMonth(), d = w.getUTCDate(), hh = w.getUTCHours(), mi = w.getUTCMinutes();
  if (unit === 'minute') mi = Math.floor(mi / n) * n;
  else if (unit === 'hour') { mi = 0; hh = Math.floor(hh / n) * n; } else if (unit === 'day') { mi = 0; hh = 0; } else if (unit === 'month') { mi = 0; hh = 0; d = 1; mo = Math.floor(mo / n) * n; } else { mi = 0; hh = 0; d = 1; mo = 0; y = Math.floor(y / n) * n; }
  const ticks = [];
  let prevDay = null;
  for (let k = 0; k < 500; k++) {
    let wall;
    if (unit === 'minute') wall = Date.UTC(y, mo, d, hh, mi + k * n);
    else if (unit === 'hour') wall = Date.UTC(y, mo, d, hh + k * n);
    else if (unit === 'day') wall = Date.UTC(y, mo, d + k * n);
    else if (unit === 'month') wall = Date.UTC(y, mo + k * n, 1);
    else wall = Date.UTC(y + k * n, 0, 1);
    const ms = fromWall(wall, tz);
    if (ms > b) break;
    if (ms < a) continue;
    const text = fmtDate(ms, tz);
    let label;
    if (unit === 'minute' || unit === 'hour') {
      const day = text.slice(0, 10);
      label = prevDay === day ? text.slice(11, 16) : `${day} ${text.slice(11, 16)}`;
      prevDay = day;
    } else if (unit === 'day') label = text.slice(0, 10);
    else if (unit === 'month') label = text.slice(0, 7);
    else label = text.slice(0, 4);
    ticks.push({ ms, label });
  }
  return { unit, step: n, ticks };
}

// The aria-label of a chart (§7.3): 'Column chart: Sum of revenue by industry, 12 categories, 1 series.'
export function chartSummary(model, hidden = null) {
  if (!model) return '';
  const shown = model.series.filter(s => !hidden?.has(s.key));
  const by = model.x.row ? 'row number' : model.x.name;
  const what = andList(shown.map(s => s.label));
  const count = model.pointAxis
    ? plural(Math.max(0, ...model.points.map((l, i) => (hidden?.has(model.series[i].key) ? 0 : l.length))), 'point')
    : plural(model.cats.length, model.type === 'pie' ? 'slice' : 'category', model.type === 'pie' ? 'slices' : 'categories');
  return `${CHART_TYPE_LABELS[model.type]} chart: ${what} by ${by}, ${count}, ${plural(shown.length, 'series', 'series')}.`;
}

// The chart's title line: 'Sum of revenue by industry'.
export function chartTitle(model, hidden = null) {
  if (!model) return '';
  const shown = model.series.filter(s => !hidden?.has(s.key));
  return `${andList(shown.map(s => s.label))} by ${model.x.row ? 'row number' : model.x.name}`;
}

// A value of series s as the tooltip shows it (formatCell of the Y column; averages and counts as numbers).
export function chartValueText(model, s, v) {
  if (v == null) return 'NULL';
  const y = model.ys[s];
  if (y.count || model.agg === 'count') return fmtInt(v);
  if (model.agg === 'avg') return fmtNumber(v);
  return formatCell(v, y.col, { ...model.fo, row: null }).text;
}

// The X text of a point or category for the tooltip (the full label; a time or number axis value formatted).
export function chartXText(model, item) {
  if (!item) return '';
  if (item.full != null) return item.full;
  if (item.label != null) return item.label;
  if (model.x.row) return `Row ${fmtInt(item.x)}`;
  if (model.xKind === 'time') {
    const dt = dtOfCol(model.x.col);
    return dt === 'date' ? fmtDate(item.x, null, { date: true }) : fmtDate(item.x, model.fo.tz ?? UTC);
  }
  return fmtNumber(item.x);
}

// The tooltip lines of a category or point (§7.3): [X text, 'Sum of revenue: 1,234', …, '12 rows' for aggregates].
export function tooltipLines(model, c, hidden = null, s = null) {
  if (!model) return [];
  if (model.pointAxis) {
    const p = model.points[s ?? 0]?.[c];
    if (!p) return [];
    const lines = [chartXText(model, p), `${model.series[s ?? 0].label}: ${chartValueText(model, s ?? 0, p.y)}`];
    if (model.agg !== 'none') lines.push(plural(p.n, 'row'));
    return lines;
  }
  const cat = model.cats[c];
  if (!cat) return [];
  const lines = [chartXText(model, cat)];
  model.series.forEach((ser, k) => { if (!hidden?.has(ser.key)) lines.push(`${ser.label}: ${chartValueText(model, k, cat.vals[k])}`); });
  if (model.agg !== 'none' || cat.other) lines.push(plural(cat.n, 'row'));
  return lines;
}

// ---------------------------------------------------------------------------------- chart layout (pure geometry)

const defaultMeasure = text => {
  try {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const w = domMeasureText(String(text), UI_FONT);
      if (Number.isFinite(w) && w > 0) return w;
    }
  } catch { /* no canvas */ }
  return String(text).length * 7;
};

const r1 = v => Math.round(v * 10) / 10;

// The geometry of a chart model at a size (§7.3): {ok, reason?, prims: [{t: 'rect'|'line'|'text'|'path'|'circle', …,
// cls, title?}], plot: {x, y, w, h}, bands (category hit areas), targets (focusable items [{c, s, x, y}]), rotate}.
// hidden: the series keys the legend hid; measure(text) -> px of a 12 px label.
export function chartLayout(model, { width = 0, height = 0, hidden = null, measure = defaultMeasure } = {}) {
  if (!model) return { ok: false, reason: TEXTS.chartNoRows, prims: [] };
  if (!(width >= 320 && height >= 200)) return { ok: false, reason: TEXTS.chartSmall, prims: [] };
  const hid = hidden instanceof Set ? hidden : new Set();
  const vis = model.series.map(s => !hid.has(s.key));
  const prims = [], bands = [], targets = [];
  const T = 8, R = 16;
  const text = (x, y, s, cls, extra = {}) => prims.push({ t: 'text', x: r1(x), y: r1(y), text: s, cls, ...extra });
  const line = (x1, y1, x2, y2, cls) => prims.push({ t: 'line', x1: r1(x1), y1: r1(y1), x2: r1(x2), y2: r1(y2), cls });
  if (model.type === 'pie') return pieLayout(model, { width, height, measure, prims, targets });
  if (model.pointAxis) {
    const pts = model.points.map((l, s) => (vis[s] ? l : []));
    const all = pts.flat();
    if (!all.length) return { ok: false, reason: TEXTS.chartNoRows, prims: [] };
    let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    for (const p of all) { if (p.x < xlo) xlo = p.x; if (p.x > xhi) xhi = p.x; if (p.y < ylo) ylo = p.y; if (p.y > yhi) yhi = p.y; }
    const yt = niceTicks(ylo, yhi);
    const yLabW = Math.max(...yt.ticks.map(t => measure(tickLabel(t))));
    const L = Math.min(width * 0.3, yLabW + 12), B = 24;
    const plot = { x: L, y: T, w: width - L - R, h: height - T - B };
    if (xhi === xlo) { xlo -= model.xKind === 'time' ? DAY / 2 : 0.5; xhi += model.xKind === 'time' ? DAY / 2 : 0.5; }
    let xt;
    if (model.xKind === 'time') {
      const tz = dtOfCol(model.x.col) === 'date' ? UTC : model.fo.tz ?? UTC;
      xt = timeTicks(xlo, xhi, tz).ticks.map(t => ({ v: t.ms, label: t.label }));
      if (!xt.length) xt = [{ v: xlo, label: fmtDate(xlo, tz) }];
    } else {
      const nt = niceTicks(xlo, xhi);
      xlo = nt.lo; xhi = nt.hi;
      xt = nt.ticks.map(v => ({ v, label: tickLabel(v) }));
    }
    const X = v => plot.x + ((v - xlo) / (xhi - xlo)) * plot.w;
    const Y = v => plot.y + plot.h - ((v - yt.lo) / (yt.hi - yt.lo)) * plot.h;
    for (const t of yt.ticks) { line(plot.x, Y(t), plot.x + plot.w, Y(t), 'rs-grid'); text(plot.x - 6, Y(t) + 4, tickLabel(t), 'rs-axt', { anchor: 'end' }); }
    line(plot.x, plot.y + plot.h, plot.x + plot.w, plot.y + plot.h, 'rs-axis');
    line(plot.x, plot.y, plot.x, plot.y + plot.h, 'rs-axis');
    let lastEnd = -Infinity;
    for (const t of xt) {
      const x = X(t.v);
      if (x < plot.x - 1 || x > plot.x + plot.w + 1) continue;
      line(x, plot.y + plot.h, x, plot.y + plot.h + 4, 'rs-axis');
      const w = measure(t.label);
      if (x - w / 2 <= lastEnd + 4) continue;
      text(x, plot.y + plot.h + 17, t.label, 'rs-axt', { anchor: 'middle' });
      lastEnd = x + w / 2;
    }
    model.series.forEach((ser, s) => {
      if (!vis[s]) return;
      const list = model.points[s];
      if (model.type === 'line') {
        let d = '';
        for (const p of list) d += `${d ? 'L' : 'M'}${r1(X(p.x))} ${r1(Y(p.y))}`;
        if (d) prims.push({ t: 'path', d, cls: `${ser.cls} rs-ln` });
      }
      if (model.type === 'scatter' || list.length <= 200) {
        let d = '';
        for (const p of list) { const cx = r1(X(p.x)), cy = r1(Y(p.y)); d += `M${r1(cx - 3)} ${cy}a3 3 0 1 0 6 0a3 3 0 1 0 -6 0`; }
        if (d) prims.push({ t: 'path', d, cls: `${ser.cls} rs-pt` });
      }
      list.forEach((p, c) => targets.push({ c, s, x: r1(X(p.x)), y: r1(Y(p.y)) }));
    });
    return { ok: true, prims, plot, bands, targets, rotate: false, X, Y };
  }
  // category axes: column, bar, line over categories
  const cats = model.cats;
  if (!cats.length) return { ok: false, reason: TEXTS.chartNoRows, prims: [] };
  const n = cats.length;
  const visIdx = model.series.map((_, s) => s).filter(s => vis[s]);
  let lo = Infinity, hi = -Infinity;
  for (const c of cats) {
    if (model.stacked) {
      let pos = 0, neg = 0;
      for (const s of visIdx) { const v = c.vals[s]; if (v == null) continue; if (v >= 0) pos += v; else neg += v; }
      if (pos > hi) hi = pos; if (neg < lo) lo = neg; if (pos < lo) lo = pos; if (neg > hi) hi = neg;
    } else {
      for (const s of visIdx) { const v = c.vals[s]; if (v == null) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const vt = niceTicks(lo, hi, { fromZero: model.type !== 'line' });
  const vLabW = Math.max(...vt.ticks.map(t => measure(tickLabel(t))));
  const labW = cats.map(c => measure(c.short));
  const maxLab = Math.max(...labW);
  const horizontal = model.type === 'bar';
  let plot, rotate = false;
  if (horizontal) {
    const L = Math.min(width * 0.35, maxLab + 14);
    plot = { x: L, y: T, w: width - L - R, h: height - T - 24 };
  } else {
    const L = Math.min(width * 0.3, vLabW + 12);
    const slot = (width - L - R) / n;
    rotate = maxLab > slot - 6;
    const B = rotate ? Math.min(height * 0.4, maxLab * 0.72 + 18) : 24;
    plot = { x: L, y: T, w: width - L - R, h: height - T - B };
  }
  const span = vt.hi - vt.lo || 1;
  const V = v => (horizontal ? plot.x + ((v - vt.lo) / span) * plot.w : plot.y + plot.h - ((v - vt.lo) / span) * plot.h);
  const slot = (horizontal ? plot.h : plot.w) / n;
  // value gridlines and labels
  for (const t of vt.ticks) {
    if (horizontal) { line(V(t), plot.y, V(t), plot.y + plot.h, 'rs-grid'); text(V(t), plot.y + plot.h + 17, tickLabel(t), 'rs-axt', { anchor: 'middle' }); } else { line(plot.x, V(t), plot.x + plot.w, V(t), 'rs-grid'); text(plot.x - 6, V(t) + 4, tickLabel(t), 'rs-axt', { anchor: 'end' }); }
  }
  // axes and the zero line
  if (horizontal) { line(plot.x, plot.y, plot.x, plot.y + plot.h, 'rs-axis'); line(plot.x, plot.y + plot.h, plot.x + plot.w, plot.y + plot.h, 'rs-axis'); } else { line(plot.x, plot.y + plot.h, plot.x + plot.w, plot.y + plot.h, 'rs-axis'); line(plot.x, plot.y, plot.x, plot.y + plot.h, 'rs-axis'); }
  if (vt.lo < 0 && vt.hi > 0) { if (horizontal) line(V(0), plot.y, V(0), plot.y + plot.h, 'rs-axis rs-zero'); else line(plot.x, V(0), plot.x + plot.w, V(0), 'rs-axis rs-zero'); }
  // category labels: every one that fits (at least 12 px apart)
  const every = Math.max(1, Math.ceil(12 / Math.max(slot, 0.01)));
  for (let c = 0; c < n; c++) {
    const mid = (horizontal ? plot.y : plot.x) + slot * (c + 0.5);
    const cat = cats[c];
    const extra = cat.short !== cat.full ? { title: cat.full } : {};
    if (horizontal) { if (c % every === 0) text(plot.x - 6, mid + 4, cat.short, 'rs-cat', { anchor: 'end', ...extra }); bands.push({ c, a: plot.y + slot * c, b: plot.y + slot * (c + 1) }); } else {
      if (c % every === 0) {
        if (rotate) text(mid, plot.y + plot.h + 12, cat.short, 'rs-cat', { anchor: 'end', rotate: -45, ...extra });
        else text(mid, plot.y + plot.h + 17, cat.short, 'rs-cat', { anchor: 'middle', ...extra });
      }
      bands.push({ c, a: plot.x + slot * c, b: plot.x + slot * (c + 1) });
    }
  }
  if (model.type === 'line') {
    for (const s of visIdx) {
      let d = '', pen = false;
      const ser = model.series[s];
      for (let c = 0; c < n; c++) {
        const v = cats[c].vals[s];
        const x = plot.x + slot * (c + 0.5);
        if (v == null) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${r1(x)} ${r1(V(v))}`;
        pen = true;
        targets.push({ c, s, x: r1(x), y: r1(V(v)) });
      }
      if (d) prims.push({ t: 'path', d, cls: `${ser.cls} rs-ln` });
      if (n <= 200) {
        let m = '';
        for (let c = 0; c < n; c++) { const v = cats[c].vals[s]; if (v == null) continue; const x = r1(plot.x + slot * (c + 0.5)), y = r1(V(v)); m += `M${r1(x - 3)} ${y}a3 3 0 1 0 6 0a3 3 0 1 0 -6 0`; }
        if (m) prims.push({ t: 'path', d: m, cls: `${ser.cls} rs-pt` });
      }
    }
    return { ok: true, prims, plot, bands, targets, rotate, horizontal: false };
  }
  // bars: grouped side by side, or stacked (positive up / right, negative down / left)
  const group = slot * 0.8;
  const bw = model.stacked ? group : group / Math.max(1, visIdx.length);
  const zero = V(Math.min(Math.max(0, vt.lo), vt.hi));
  for (let c = 0; c < n; c++) {
    const start = (horizontal ? plot.y : plot.x) + slot * c + (slot - group) / 2;
    let pos = 0, neg = 0;
    visIdx.forEach((s, k) => {
      const v = cats[c].vals[s];
      if (v == null) return;
      let a, b;
      if (model.stacked) { if (v >= 0) { a = V(pos); b = V(pos + v); pos += v; } else { a = V(neg); b = V(neg + v); neg += v; } } else { a = zero; b = V(v); }
      const off = model.stacked ? 0 : bw * k;
      const lo2 = Math.min(a, b), size = Math.max(Math.abs(b - a), v === 0 ? 0 : 1);
      const ser = model.series[s];
      if (horizontal) prims.push({ t: 'rect', x: r1(lo2), y: r1(start + off), w: r1(size), h: r1(Math.max(1, bw - 1)), cls: ser.cls, c, s });
      else prims.push({ t: 'rect', x: r1(start + off), y: r1(lo2), w: r1(Math.max(1, bw - 1)), h: r1(size), cls: ser.cls, c, s });
      const cx = horizontal ? (v >= 0 ? lo2 + size : lo2) : start + off + bw / 2, cy = horizontal ? start + off + bw / 2 : (v >= 0 ? lo2 : lo2 + size);
      targets.push({ c, s, x: r1(cx), y: r1(cy) });
    });
  }
  return { ok: true, prims, plot, bands, targets, rotate, horizontal };
}

// The pie geometry (slices of the first series from -90° clockwise, labels for slices of 0.3 rad or more).
function pieLayout(model, { width, height, measure, prims, targets }) {
  const vals = model.cats.map(c => Math.max(0, c.vals[0] ?? 0));
  const total = vals.reduce((a, v) => a + v, 0);
  if (!(total > 0)) return { ok: false, reason: TEXTS.chartNoRows, prims: [] };
  const plot = { x: 8, y: 8, w: width - 16, h: height - 16 };
  const cx = plot.x + plot.w / 2, cy = plot.y + plot.h / 2;
  const maxLab = Math.min(140, Math.max(0, ...model.cats.map(c => measure(c.short))));
  const r = Math.max(20, Math.min(plot.w / 2 - maxLab - 12, plot.h / 2 - 20));
  const slices = [];
  let a = -Math.PI / 2;
  model.cats.forEach((cat, c) => {
    const v = vals[c];
    const da = (v / total) * Math.PI * 2;
    const b = a + da;
    const cls = cat.other ? 'rs-cother rs-sl' : `rs-c${(c % 8) + 1} rs-sl`;
    if (da >= Math.PI * 2 - 1e-9) prims.push({ t: 'circle', cx: r1(cx), cy: r1(cy), r: r1(r), cls, c, s: 0 });
    else if (da > 0) {
      const x0 = cx + r * Math.cos(a), y0 = cy + r * Math.sin(a), x1 = cx + r * Math.cos(b), y1 = cy + r * Math.sin(b);
      prims.push({ t: 'path', d: `M${r1(cx)} ${r1(cy)}L${r1(x0)} ${r1(y0)}A${r1(r)} ${r1(r)} 0 ${da > Math.PI ? 1 : 0} 1 ${r1(x1)} ${r1(y1)}Z`, cls, c, s: 0 });
    }
    const mid = a + da / 2;
    if (da >= 0.3) {
      const lx = cx + r * 1.08 * Math.cos(mid), ly = cy + r * 1.08 * Math.sin(mid) + 4;
      prims.push({ t: 'text', x: r1(lx), y: r1(ly), text: cat.short, cls: 'rs-cat', anchor: Math.cos(mid) >= 0 ? 'start' : 'end', ...(cat.short !== cat.full ? { title: cat.full } : {}) });
    }
    slices.push({ c, a, b });
    targets.push({ c, s: 0, x: r1(cx + r * 0.6 * Math.cos(mid)), y: r1(cy + r * 0.6 * Math.sin(mid)) });
    a = b;
  });
  return { ok: true, prims, plot, bands: [], targets, rotate: false, pie: { cx, cy, r, slices } };
}

// The item under a point of the plot (§7.3 hover): {c, s} or null. Categories by band, points and slices by distance.
export function chartHit(model, layout, x, y) {
  if (!model || !layout?.ok) return null;
  if (layout.pie) {
    const { cx, cy, r, slices } = layout.pie;
    const d = Math.hypot(x - cx, y - cy);
    if (d > r) return null;
    let ang = Math.atan2(y - cy, x - cx);
    if (ang < -Math.PI / 2) ang += Math.PI * 2;
    const hit = slices.find(sl => ang >= sl.a && ang < sl.b);
    return hit ? { c: hit.c, s: 0 } : null;
  }
  const p = layout.plot;
  if (x < p.x - 8 || x > p.x + p.w + 8 || y < p.y - 8 || y > p.y + p.h + 8) return null;
  if (model.pointAxis) {
    let best = null, bd = 24 * 24;
    for (const t of layout.targets) { const d = (t.x - x) ** 2 + (t.y - y) ** 2; if (d < bd) { bd = d; best = t; } }
    return best ? { c: best.c, s: best.s } : null;
  }
  const v = layout.horizontal ? y : x;
  const band = layout.bands.find(b => v >= b.a && v < b.b);
  return band ? { c: band.c, s: null } : null;
}

// Moves the keyboard cursor of a chart (§7.3): ←/→ categories or points, ↑/↓ series, Home/End; {c, s} or null for
// other keys.
export function chartKey(model, cur, key, hidden = null) {
  if (!model) return null;
  const vis = model.series.map((s, k) => (hidden?.has(s.key) ? -1 : k)).filter(k => k >= 0);
  if (!vis.length) return null;
  let s = cur && vis.includes(cur.s) ? cur.s : vis[0];
  let c = cur && Number.isInteger(cur.c) ? cur.c : 0;
  const count = sIdx => (model.pointAxis ? model.points[sIdx].length : model.cats.length);
  const n = count(s);
  if (!n) return null;
  if (key === 'ArrowRight') c = Math.min(n - 1, c + 1);
  else if (key === 'ArrowLeft') c = Math.max(0, c - 1);
  else if (key === 'Home') c = 0;
  else if (key === 'End') c = n - 1;
  else if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (model.type === 'pie') return { c, s };
    const k = vis.indexOf(s) + (key === 'ArrowDown' ? 1 : -1);
    s = vis[Math.max(0, Math.min(vis.length - 1, k))];
    c = Math.min(c, count(s) - 1);
  } else return null;
  return { c: Math.max(0, c), s };
}

// The announcement of a focused chart item (§7.3): 'Retail: revenue 1,234,000.'
export function chartReadout(model, cur) {
  if (!model || !cur) return '';
  const s = cur.s ?? 0;
  if (model.pointAxis) {
    const p = model.points[s]?.[cur.c];
    return p ? `${chartXText(model, p)}: ${model.series[s].label} ${chartValueText(model, s, p.y)}.` : '';
  }
  const cat = model.cats[cur.c];
  return cat ? `${cat.full}: ${model.series[s].label} ${chartValueText(model, s, cat.vals[s])}.` : '';
}

// The paint of a primitive's classes in an exported SVG: token names of fill, stroke and the stroke width.
function paintOf(cls) {
  const list = String(cls ?? '').split(/\s+/);
  const out = { fill: null, stroke: null, width: null };
  for (const c of list) {
    const m = /^rs-c([1-8])$/.exec(c);
    if (m) { out.fill = `--chart-${m[1]}`; out.stroke = `--chart-${m[1]}`; }
    if (c === 'rs-cother') out.fill = '--chart-grid';
    if (c === 'rs-grid') { out.stroke = '--chart-grid'; out.width = 1; }
    if (c === 'rs-axis') { out.stroke = '--chart-axis'; out.width = 1; }
    if (c === 'rs-axt' || c === 'rs-cat') out.fill = '--fg2';
  }
  if (list.includes('rs-ln')) { out.fill = 'none'; out.width = 2; }
  if (list.includes('rs-pt')) out.stroke = 'none';
  if (list.includes('rs-sl')) { out.stroke = '--bg1'; out.width = 1; }
  if (!list.some(c => /^rs-c[1-8]$|^rs-cother$/.test(c)) && (list.includes('rs-grid') || list.includes('rs-axis'))) out.fill = 'none';
  return out;
}

// A text with every character XML 1.0 cannot represent (controls other than tab, LF and CR, U+FFFE, U+FFFF and
// unpaired surrogates; a data label may hold them) replaced by U+FFFD, so an exported SVG is always well-formed.
export function xmlSafeText(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    out += (c < 0x20 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffe || c === 0xffff || (c >= 0xd800 && c <= 0xdfff) ? String.fromCharCode(0xfffd) : ch;
  }
  return out;
}

// A self-contained SVG document of a chart (§7.3 Save as SVG): every token colour written as its literal (colors:
// Map/object token -> colour, from getComputedStyle), the --bg1 background, the title, notes and legend on top, no
// external references; all text escaped with xmlEsc.
export function chartSvgText(layout, { width, height, title = '', notes = [], legend = [], colors = {} } = {}) {
  const col = t => (t == null ? null : t === 'none' ? 'none' : String((colors instanceof Map ? colors.get(t) : colors[t]) ?? '').trim() || null);
  const esc = s => xmlEsc(xmlSafeText(s), 'attr');
  const head = 14 + 20 + notes.length * 16 + (legend.length ? 20 : 0);
  const H = height + head;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" font-family="Segoe UI, -apple-system, Roboto, Helvetica Neue, sans-serif" font-size="12">`];
  const bg = col('--bg1');
  if (bg) out.push(`<rect x="0" y="0" width="${width}" height="${H}" fill="${esc(bg)}"/>`);
  let y = 22;
  out.push(`<text x="8" y="${y}" font-size="14" font-weight="600"${col('--fg1') ? ` fill="${esc(col('--fg1'))}"` : ''}>${esc(title)}</text>`);
  for (const n of notes) { y += 16; out.push(`<text x="8" y="${y}"${col('--fg3') ? ` fill="${esc(col('--fg3'))}"` : ''}>${esc(n)}</text>`); }
  if (legend.length) {
    y += 20;
    let x = 8;
    for (const l of legend) {
      const p = paintOf(l.cls);
      out.push(`<rect x="${x}" y="${y - 10}" width="10" height="10" rx="2"${col(p.fill) ? ` fill="${esc(col(p.fill))}"` : ''}/>`);
      out.push(`<text x="${x + 14}" y="${y}"${col('--fg2') ? ` fill="${esc(col('--fg2'))}"` : ''}>${esc(l.label)}</text>`);
      x += 14 + Math.ceil(String(l.label).length * 7) + 16;
    }
  }
  out.push(`<g transform="translate(0 ${head})">`);
  for (const p of layout?.prims ?? []) {
    const paint = paintOf(p.cls);
    let attrs = '';
    const fill = col(paint.fill), stroke = col(paint.stroke);
    if (fill) attrs += ` fill="${esc(fill)}"`;
    if (stroke) attrs += ` stroke="${esc(stroke)}"`;
    if (paint.width) attrs += ` stroke-width="${paint.width}"`;
    if (p.t === 'rect') out.push(`<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"${attrs}/>`);
    else if (p.t === 'line') out.push(`<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}"${attrs}/>`);
    else if (p.t === 'circle') out.push(`<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}"${attrs}/>`);
    else if (p.t === 'path') out.push(`<path d="${esc(p.d)}"${attrs}/>`);
    else if (p.t === 'text') {
      const anchor = p.anchor && p.anchor !== 'start' ? ` text-anchor="${p.anchor}"` : '';
      const rot = p.rotate ? ` transform="rotate(${p.rotate} ${p.x} ${p.y})"` : '';
      out.push(`<text x="${p.x}" y="${p.y}"${anchor}${rot}${fill ? ` fill="${esc(fill)}"` : ''}>${esc(p.text)}</text>`);
    }
  }
  out.push('</g></svg>');
  return out.join('');
}

// ------------------------------------------------------------------------------------------------------------ CSS

const SERIES_CSS = [1, 2, 3, 4, 5, 6, 7, 8].map(n => `.rs-c${n}{fill:var(--chart-${n});stroke:var(--chart-${n});background:var(--chart-${n})}`).join('\n');

// The results area's rules (03 §1.3: prefix .rs-, colours only var(--token); export.js TEXT_CSS appended).
export const CSS = `.rs-root{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;position:relative;background:var(--bg1);color:var(--fg1);container:rs-root/inline-size}
@container rs-root (width < 1100px){.rs-bar .btn:has(>svg)>.lbl,.rs-bar .seg button:has(>svg)>.lbl{display:none}.rs-bar .btn:has(>svg):not(.icon,.split>.btn+.btn){padding:0 8px}.rs-bar .input{width:160px;flex-basis:160px;min-width:120px}}
@container rs-root (width < 640px){.rs-bar{padding:8px 16px}}
.rs-head{display:flex;align-items:center;flex:none;min-width:0;border-bottom:1px solid var(--s2)}
.rs-tabs{flex:1;min-width:0;overflow:hidden;border-bottom:0;scrollbar-width:none}
.rs-tabs .tab .lb{max-width:240px;overflow:hidden;text-overflow:ellipsis}
.rs-tabs .tab .count{margin-left:2px}
.rs-more,.rs-max{flex:none;margin-right:8px}
.rs-bar{display:flex;align-items:center;gap:8px;padding:8px 24px;flex:none;min-width:0;flex-wrap:wrap;border-bottom:1px solid var(--s3)}
.rs-bar[hidden],.rs-grp[hidden]{display:none}
.rs-grp{display:contents}
.rs-bar .input{width:220px;flex:0 1 220px;min-width:140px;height:28px}
.rs-bar .btn,.rs-bar .seg button{height:28px}
.rs-cnt{font-size:12px;line-height:16px;color:var(--fg3);white-space:nowrap}
.rs-bar .sep{width:1px;height:20px;background:var(--s2);flex:none}
.rs-banners{display:flex;flex-direction:column;flex:none;padding-top:8px}
.rs-banners:empty{display:none}
.rs-banners .banner{margin:0 24px 8px}
.rs-banners .banner .btn{height:28px}
.rs-body{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;position:relative;transition:opacity .15s ease-out}
.rs-body.stale{opacity:.55}
.rs-body>.empty{flex:1}
.rs-pane{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}
.rs-hist{display:flex;flex-direction:column;align-items:center;gap:4px;margin-top:4px;max-width:100%}
.rs-hist .link{max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/18px var(--mono)}
.rs-msgs{flex:1;min-height:0;overflow:auto;position:relative}
.rs-msgs>.rs-sz{position:relative}
.rs-m{display:flex;align-items:flex-start;gap:8px;padding:5px 24px;min-height:28px;border-bottom:1px solid var(--s3);font-size:13px;line-height:18px;box-sizing:border-box}
.rs-m>.ic{display:grid;flex:none;margin-top:1px;color:var(--fg3)}
.rs-m.error>.ic{color:var(--red)}
.rs-m.warn>.ic{color:var(--amber)}
.rs-m.rows>.ic{color:var(--green)}
.rs-m .tm{flex:none;color:var(--fg3);font-size:12px;font-variant-numeric:tabular-nums;min-width:56px}
.rs-m .sn{flex:none;color:var(--fg3);font-size:12px;white-space:nowrap}
.rs-m .bd{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.rs-m .tx{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--fg1)}
.rs-m.error .tx{color:var(--red)}
.rs-m button.tx{border:0;background:none;padding:0;text-align:left;font:inherit;cursor:pointer;border-radius:2px}
.rs-m button.tx:hover{text-decoration:underline}
.rs-m button.tx:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
.rs-m .hn{font-size:12px;line-height:16px;color:var(--fg2)}
.rs-m .acts{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}
.rs-m .acts .btn{height:26px}
.rs-m .fx{flex:none;color:var(--fg3);font-size:12px;white-space:nowrap}
.rs-m.sub{padding-left:56px}
.rs-m.head .tx{font-weight:600}
.rs-msgs.virt .rs-m{position:absolute;left:0;right:0;border-bottom:0;padding-top:5px;padding-bottom:0;min-height:0;overflow:hidden}
.rs-msgs.virt .rs-m .tx,.rs-msgs.virt .rs-m .hn{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rs-msgs.virt .rs-m .acts{flex-wrap:nowrap;overflow:hidden}
.rs-plan{flex:1;min-height:0;display:flex;min-width:0}
.rs-ptree{flex:1;min-width:0;overflow:auto;outline:none}
.rs-pin{position:relative;padding:8px 0 16px;min-width:max-content}
.rs-pn{position:relative;display:flex;align-items:center;gap:6px;height:28px;padding-right:16px;white-space:nowrap;cursor:default;font-size:13px;box-sizing:border-box}
.rs-pn:hover{background:var(--bg2)}
.rs-pn[aria-selected=true]{background:var(--brand-bg)}
.rs-pn:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.rs-pn.hd{height:32px;font-weight:600;color:var(--fg1);margin-top:4px}
.rs-pn .cv{width:16px;height:16px;display:grid;place-items:center;flex:none;color:var(--fg3);transition:transform .1s}
.rs-pn[aria-expanded=false] .cv{transform:rotate(-90deg)}
.rs-pn .cv.no{visibility:hidden}
.rs-pn .gl{display:grid;flex:none;color:var(--fg2)}
.rs-pn .op{font-weight:600}
.rs-pn .dt{color:var(--fg3);overflow:hidden;text-overflow:ellipsis;min-width:0;max-width:520px}
.rs-pn .st{color:var(--fg3);font-size:12px}
.rs-pn .badge{height:18px;font-size:11px}
.rs-pn .badge.rs-srv{background:var(--brand-bg);color:var(--brand);border-color:var(--brand-s)}
.rs-pn .err{color:var(--red);font-weight:400;white-space:normal}
.rs-pw{position:relative;display:flex;align-items:center;gap:6px;height:22px;font-size:12px;line-height:16px;color:var(--amber);padding-right:16px;white-space:nowrap;box-sizing:border-box}
.rs-pc{position:absolute;border:0 solid var(--s1);border-left-style:solid;border-bottom-style:solid;border-bottom-left-radius:4px;pointer-events:none;box-sizing:border-box}
.rs-pprops{flex:0 0 320px;min-width:0;border-left:1px solid var(--s2);overflow:auto;background:var(--bg1)}
.rs-pprops h3{margin:0;padding:12px 12px 0;font-size:14px;line-height:20px;overflow-wrap:anywhere}
.rs-pprops .kv{grid-template-columns:minmax(100px,max-content) minmax(0,1fr)}
.rs-pprops .link{font-size:12px;margin:0 12px 12px}
@container ss-panel (max-width: 900px){.rs-plan{flex-direction:column}.rs-pprops{flex:0 0 auto;max-height:45%;border-left:0;border-top:1px solid var(--s2)}}
.rs-fx,.rs-ch{flex:1;min-height:0;overflow:auto;padding:12px 24px 24px;display:flex;flex-direction:column;gap:16px}
.rs-fxi{display:flex;flex-direction:column;gap:8px;outline:none}
.rs-fxi.hl>.code{border-color:var(--brand);box-shadow:0 0 0 1px var(--brand)}
.rs-fxh,.rs-ceh{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rs-fxh b,.rs-ceh b{font-size:13px;margin-right:auto}
.rs-fxh .btn,.rs-ce .acts .btn{height:28px}
.rs-ce{border:1px solid var(--s2);border-radius:6px;padding:12px 16px;display:flex;flex-direction:column;gap:8px;background:var(--bg1)}
.rs-ce .meta{font-size:12px;line-height:16px;color:var(--fg3)}
.rs-ce .cnts{font-size:13px;color:var(--fg2)}
.rs-ce .acts{display:flex;gap:8px;flex-wrap:wrap}
.rs-ce .code{max-height:120px;overflow:auto}
.rs-ce details{font-size:13px}
.rs-dt{border-collapse:collapse;width:100%;font-size:12px;margin-top:8px}
.rs-dt th{text-align:left;font-weight:600;padding:6px 10px;border-bottom:1px solid var(--s2);white-space:nowrap;color:var(--fg1)}
.rs-dt td{padding:6px 10px;border-bottom:1px solid var(--s3);vertical-align:top;overflow-wrap:anywhere;color:var(--fg2)}
.rs-dt td.old{background:var(--diff-del)}
.rs-dt td.new{background:var(--diff-add)}
.rs-dt .mono,.rs-rd .v{font:12px/18px var(--mono)}
.rs-dt .more{color:var(--fg3)}
.rs-rd{border-collapse:collapse;width:100%}
.rs-rd th{text-align:left;font-weight:600;padding:8px 12px;border-bottom:1px solid var(--s2);white-space:nowrap;color:var(--fg1);font-size:12px}
.rs-rd td{padding:8px 12px;border-bottom:1px solid var(--s3);vertical-align:top;font-size:var(--gr-font-size,13px)}
.rs-rd .nm{font-weight:600;white-space:nowrap}
.rs-rd .dn{display:block;font-size:12px;line-height:16px;color:var(--fg3);font-weight:400}
.rs-rd .v{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--fg1)}
.rs-rd .fc-null{font-style:italic;color:var(--fg3)}
.rs-rd .fc-empty::after{content:'';display:inline-block;width:12px;border-bottom:1px dotted var(--fg4)}
.rs-chart{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}
.rs-cbar{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;padding:8px 24px;flex:none;border-bottom:1px solid var(--s3)}
.rs-cbar .fld{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--fg2);white-space:nowrap}
.rs-cbar select.sel{height:28px;max-width:200px}
.rs-cbar .seg button{height:28px;padding:0 8px}
.rs-cbar .btn{height:28px}
.rs-chd{padding:8px 24px 0;flex:none}
.rs-chd h3{margin:0;font-size:14px;line-height:20px;font-weight:600;color:var(--fg1);overflow-wrap:anywhere}
.rs-chd .nt{font-size:12px;line-height:16px;color:var(--fg3)}
.rs-lg{display:flex;flex-wrap:wrap;gap:4px 12px;padding:6px 24px 0;flex:none}
.rs-lg button{display:inline-flex;align-items:center;gap:6px;border:0;background:none;padding:2px 4px;border-radius:4px;font-size:12px;color:var(--fg2);cursor:pointer}
.rs-lg button:hover{background:var(--bg3)}
.rs-lg button:focus-visible{outline:2px solid var(--focus);outline-offset:0}
.rs-lg button[aria-pressed=false]{color:var(--fg4);text-decoration:line-through}
.rs-lg button[aria-pressed=false] i{opacity:.35}
.rs-lg i{width:10px;height:10px;border-radius:2px;display:inline-block;flex:none}
.rs-cv{flex:1;min-height:0;position:relative;overflow:hidden;margin:4px 16px 8px}
.rs-cv>svg{position:absolute;inset:0;display:block;width:100%;height:100%;overflow:visible}
.rs-cv>svg:focus{outline:none}
.rs-cv>svg:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:2px}
.rs-cv>.empty{position:absolute;inset:0}
${SERIES_CSS}
.rs-cother{fill:var(--chart-grid);background:var(--chart-grid)}
.rs-cv rect{stroke:none}
.rs-grid{stroke:var(--chart-grid);stroke-width:1;fill:none;shape-rendering:crispEdges}
.rs-axis{stroke:var(--chart-axis);stroke-width:1;fill:none;shape-rendering:crispEdges}
.rs-axt{fill:var(--chart-axis);font-size:11px}
.rs-cat{fill:var(--fg2);font-size:11px}
.rs-ln{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.rs-pt{stroke:none}
.rs-sl{stroke:var(--bg1);stroke-width:1}
.rs-cur{fill:none;stroke:var(--fg1);stroke-width:2;pointer-events:none}
.rs-band{fill:var(--fg1);opacity:.06;pointer-events:none}
.rs-hit{fill:transparent;stroke:none}
.rs-cbusy{position:absolute;inset:0;display:grid;place-items:center;color:var(--fg3);font-size:12px}
.pop.rs-tipp{width:auto;max-width:320px;padding:6px 10px;pointer-events:none}
.rs-tip{display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:16px;color:var(--fg1)}
.rs-tip b{font-weight:600}
.rs-tip span{color:var(--fg2)}
.rs-sr{margin-left:auto;display:inline-flex;align-items:center;gap:12px;min-width:0;flex:none}
.rs-sr>span{white-space:nowrap}
.rs-sr .warn{display:inline-flex;align-items:center;gap:4px}
.rs-st button.rs-err{color:var(--red);max-width:100%;overflow:hidden;text-overflow:ellipsis;justify-content:flex-start}
.rs-st .spin{width:12px;height:12px}
.rs-st .rs-stop{color:var(--link)}
@media (prefers-reduced-motion:reduce){.rs-body,.rs-pn .cv{transition:none}}
@media (forced-colors:active){.rs-pn[aria-selected=true]{outline:1px solid Highlight}.rs-pc{border-color:CanvasText}.rs-cur{stroke:Highlight}}
` + TEXT_CSS;

// ------------------------------------------------------------------------------------------------ createResults

let current = null;

// A fresh TabResults (03 §2) with the memory-only extensions (see the notes at the top of this file).
export function newTabResults() {
  return {
    sets: [], messages: [], plans: [], fetchXml: [], estimated: false, activeView: null, textMode: false,
    status: { kind: 'ready', text: TEXTS.ready }, hiddenSets: 0, error: null, lastRun: null, runText: null, markers: [],
    planSel: null, fetchSel: null, collapsed: new Set(), ran: false, ver: 0, ui: null,
  };
}

// Mounts the results area into `host` (the shell's results region) and binds the run controller (03 §1.4, §7); returns the Results object.
export function createResults(host, opts = {}) {
  const S = opts.state && typeof opts.state.on === 'function' ? opts.state : stateModule;
  const st = () => S.state;
  const shell = opts.shell ?? null;
  const editor = opts.editor ?? null;
  const meta = opts.meta ?? null;
  const api = opts.api ?? null;
  const mac = typeof opts.mac === 'boolean' ? opts.mac : isMacPlatform();
  const nowMs = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const clock = typeof opts.clock === 'function' ? opts.clock : () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const frame = typeof opts.frame === 'function' ? opts.frame : fn => {
    if (typeof globalThis.requestAnimationFrame === 'function') { const id = globalThis.requestAnimationFrame(fn); return () => globalThis.cancelAnimationFrame(id); }
    const id = setTimeout(fn, 16);
    return () => clearTimeout(id);
  };
  const later = typeof opts.later === 'function' ? opts.later : (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); };
  const yieldFn = typeof opts.yieldToUi === 'function' ? opts.yieldToUi : utilYield;
  const measure = typeof opts.measure === 'function' ? opts.measure : defaultMeasure;
  const io = name => (opts.io && typeof opts.io[name] === 'function' ? opts.io[name] : util[name]);
  const ioObj = () => ({ saveFile: io('saveFile'), copyText: io('copyText'), copyBlob: io('copyBlob') });
  const dlg = name => (...a) => {
    const d = opts.dialogs;
    if (d && typeof d[name] === 'function') return d[name](...a);
    return dialogsModule[name](...a);
  };
  const logOf = () => opts.changeLog ?? st().changeLog ?? null;
  const settings = () => S.getSettings();
  const tzNow = () => (typeof opts.tz === 'function' ? (opts.tz() ?? UTC) : settings().tz === 'utc' ? UTC : LOCAL);
  const dateFormatNow = () => {
    const u = meta?.user;
    return settings().localDates && u && typeof u.dateFormat === 'string' ? { date: u.dateFormat, time: u.timeFormat ?? '', lcid: u.lcid ?? null } : null;
  };
  const known = meta && typeof meta.findEntity === 'function' ? name => { try { return !!meta.findEntity(name); } catch { return false; } } : undefined;
  const fail = e => toast(errText(e), { kind: 'error' });
  function toast(text, o) { try { return shell?.toast?.(text, o) ?? null; } catch { return null; } }
  const announce = text => { try { shell?.announce?.(text); } catch { /* the shell reports its own errors */ } };
  const status = (text, ms = 3000) => { try { shell?.status?.(text, { ms }); } catch { /* idem */ } };
  const tabTitle = id => st().tabs.find(t => t.id === id)?.title ?? '';
  const sessionOf = id => st().sessions?.get?.(id) ?? null;
  const offs = [];
  const timers = new Set();
  let destroyed = false;

  const keep = fn => { offs.push(fn); return fn; };
  const timer = (fn, ms) => { const c = later(() => { timers.delete(c); if (!destroyed) fn(); }, ms); timers.add(c); return () => { timers.delete(c); c(); }; };

  // ---- TabResults -------------------------------------------------------------------------------------------------
  function trOf(tabId) {
    const map = st().results;
    let tr = map.get(tabId);
    if (!tr) { tr = newTabResults(); map.set(tabId, tr); }
    if (!tr.ui) tr.ui = { msgs: null, plan: null, fetch: null, changesVer: -1 };
    return tr;
  }
  const activeId = () => st().activeTab;
  const isActive = tabId => tabId != null && tabId === activeId();
  const setOf = (tr, v) => (isSetView(v) ? tr.sets.find(s => s.id === v) ?? null : null);

  // ---- DOM skeleton -----------------------------------------------------------------------------------------------
  const ids = { body: util.uid('rs-b') };
  const tabsEl = h('div', { class: 'tabs rs-tabs', role: 'tablist', 'aria-label': 'Results' });
  const moreBtn = h('button', { class: 'btn subtle icon rs-more', type: 'button', title: 'All result tabs', 'aria-label': 'All result tabs', 'aria-haspopup': 'menu', 'aria-expanded': 'false', hidden: true }, icon('chevron', 20));
  const maxBtn = h('button', { class: 'btn subtle icon rs-max', type: 'button' }, icon('maximize', 20));
  const head = h('div', { class: 'rs-head' }, tabsEl, moreBtn, maxBtn);
  // toolbar of a result set
  const qInput = h('input', { type: 'search', placeholder: 'Filter rows', 'aria-label': 'Filter rows', autocomplete: 'off', spellcheck: 'false' });
  const qBox = h('label', { class: 'input' }, icon('search', 16), qInput);
  const countEl = h('span', { class: 'rs-cnt', 'aria-live': 'off' });
  const segBtn = (label, extra = {}) => h('button', { type: 'button', 'aria-pressed': 'false', ...(extra.ic ? { 'aria-label': label } : {}), ...extra }, extra.ic ? icon(extra.ic, 16) : null, extra.ic ? h('span', { class: 'lbl', text: label }) : label);
  const friendlyBtn = segBtn('Friendly', { title: 'Show labels, names and formatted values' });
  const rawBtn = segBtn('Raw', { title: 'Show the stored values' });
  const valSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Values' }, friendlyBtn, rawBtn);
  const tableBtn = segBtn('Table', { ic: 'table' });
  const textBtn = segBtn('Text', { ic: ic('textView', 'text'), title: 'Results as text' });
  const chartBtn = segBtn('Chart', { ic: 'chartColumn' });
  const dispSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Display' }, tableBtn, textBtn, chartBtn);
  const editBtn = h('button', { class: 'btn', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Edit' }, icon('edit', 20), h('span', { class: 'lbl', text: 'Edit' }));
  const exportBtn = h('button', { class: 'btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Export' }, icon('download', 20), h('span', { class: 'lbl', text: 'Export' }), icon('chevron', 16));
  // Open as view ▾: the main part opens the results in the temp personal view in place (one click); the chevron also
  // offers Save as personal view… (a named view, opened in a new tab).
  const viewLbl = h('span', { class: 'lbl', text: 'Open as view' });
  const viewBtn = h('button', { class: 'btn', type: 'button', 'aria-label': 'Open as view' }, icon('open', 20), viewLbl);
  const viewMenuBtn = h('button', { class: 'btn icon', type: 'button', title: 'View options', 'aria-label': 'View options', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('chevron', 16));
  const viewSplit = h('span', { class: 'split', role: 'group', 'aria-label': 'Open as view' }, viewBtn, viewMenuBtn);
  let viewBusy = false;
  const sep = () => h('span', { class: 'sep', 'aria-hidden': 'true' });
  const setTools = h('div', { class: 'rs-grp' }, qBox, countEl, sep(), valSeg, dispSeg, editBtn, viewSplit, exportBtn);
  const estBadge = h('span', { class: 'badge', text: TEXTS.estimated, title: 'An estimated plan: nothing has run, so there are no statistics.' });
  const copyPlanBtn = h('button', { class: 'btn', type: 'button', 'aria-label': 'Copy plan' }, icon('copy', 20), h('span', { class: 'lbl', text: 'Copy plan' }));
  const planTools = h('div', { class: 'rs-grp' }, estBadge, copyPlanBtn);
  const fetchBadge = h('span', { class: 'badge', text: TEXTS.estimated, title: 'FetchXML of an estimated plan: nothing has run.' });
  const fetchTools = h('div', { class: 'rs-grp' }, fetchBadge);
  const bar = h('div', { class: 'rs-bar', role: 'toolbar', 'aria-label': 'Result tools' }, setTools, planTools, fetchTools);
  const bannersEl = h('div', { class: 'rs-banners' });
  const bodyEl = h('div', { class: 'rs-body', id: ids.body, role: 'tabpanel' });
  const root = h('div', { class: 'rs-root', 'aria-busy': 'false' }, head, bar, bannersEl, bodyEl);
  if (host) host.append(root);

  // ---- status bar ----------------------------------------------------------------------------------------------------
  const stLeft = h('span', { class: 'st rs-st' });
  const statsEl = h('span', { hidden: true });
  const tabFocusEl = h('span', { hidden: true, text: TEXTS.tabFocus });
  const allowEl = h('span', { class: 'warn', hidden: true }, icon('warn', 16), TEXTS.changesAllowed);
  const userText = h('span');
  const userBtn = h('button', { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('user', 16), userText);
  const caretEl = h('span', { hidden: true });
  const reqEl = h('span', { title: 'Requests sent to Dataverse in this session' });
  const tzText = h('span');
  const tzBtn = h('button', { type: 'button' }, tzText);
  const stRight = h('span', { class: 'rs-sr' }, statsEl, tabFocusEl, allowEl, userBtn, caretEl, reqEl, tzBtn);
  const statusHost = shell?.regions?.status ?? null;
  if (statusHost) statusHost.append(stLeft, stRight);
  const hintEl = h('span', { class: 'tbar-hint', hidden: true });
  if (shell?.regions?.tbarEnd) shell.regions.tbarEnd.append(hintEl);

  // ---- run lock -----------------------------------------------------------------------------------------------------
  let active = null;   // the run this instance drives under the lock: {tabId, ctl, abort, write, …}

  // The run-lock toast of 03 §7 when a run is active; true when a new run may start.
  function lockFree() {
    const r = st().running;
    if (!r) return true;
    const other = r.tabId;
    toast(runLockTitle(tabTitle(other)), { kind: 'warn', action: { label: 'Go to tab', run: () => { if (st().tabs.some(t => t.id === other)) S.setActiveTab(other); } } });
    return false;
  }
  function takeLock(tabId, handle, quiet, mode) {
    st().running = { tabId, handle, startedAt: nowMs(), write: false, quiet: !!quiet };
    S.emit('run:start', { tabId, mode });
    try { shell?.refresh?.(); } catch { /* shell errors are its own */ }
  }
  function releaseLock(tabId, payload) {
    if (st().running && st().running.tabId === tabId) st().running = null;
    S.emit('run:end', { tabId, ...payload });
    try { shell?.refresh?.(); } catch { /* idem */ }
  }

  // ---- the RunHandle driver (02 §9 events -> TabResults, 03 §7) ---------------------------------------------------
  // kind 'run' replaces the tab's result sets; 'quiet' (runQuiet, attachQuiet, Undo) and 'edits' (Review changes) only
  // append messages. Resolves {ok, cancelled, error, rows, ms, sets (quiet), messages (this run's), edits}.
  function drive(tabId, handle, o = {}) {
    const kind = o.kind ?? 'run';
    const tr = trOf(tabId);
    const holds = !st().running;
    const run = {
      tabId, kind, handle, ctl: o.ctl ?? null, abort: typeof o.abort === 'function' ? o.abort : null, t0: clock(), wall0: nowMs(),
      stmt: null, stmtT0: new Map(), rows: 0, replaced: false, prevSets: null, prevView: tr.activeView, hidden: new Set(), byId: new Map(),
      quietSets: [], messages: [], errors: [], editResults: null, write: null, writeT0: 0, throttle: null, done: false,
      progress: null, label: o.label ?? null, mode: o.mode ?? null, sql: o.sql ?? '', sawSet: false, cancelled: false,
    };
    run.holds = holds;
    if (holds) { takeLock(tabId, handle, kind !== 'run', kind === 'run' ? run.mode ?? 'all' : kind); active = run; }
    if (kind === 'run') {
      tr.messages = [];
      tr.plans = [];
      tr.fetchXml = [];
      tr.estimated = false;
      tr.error = null;
      tr.hiddenSets = 0;
      tr.ran = true;
      tr.ver++;
      tr.lastRun = { sql: run.sql, offset: o.offset ?? 0, fullText: o.fullText ?? null, mode: run.mode, maxRows: o.maxRows ?? null };
      tr.runText = o.runText ?? null;
      tr.fixed = false;
      tr.markers = [];
      if (editor && isActive(tabId) && typeof editor.setMarkers === 'function') { try { editor.setMarkers([], 'run'); } catch { /* editor errors are its own */ } }
    }
    tr.status = { kind: 'running', text: runningText({ ms: 0 }) };
    if (holds) { try { shell?.progress?.(null); } catch { /* idem */ } }
    if (isActive(tabId)) { bodyEl.classList.toggle('stale', kind === 'run'); renderAll(); }
    const tick = () => {
      if (run.done || destroyed) return;
      if (!run.write && !run.throttle && !run.progress) tr.status = { kind: 'running', text: runningText({ index: run.stmt?.index, total: run.stmt?.total ?? 0, rows: run.rows, ms: clock() - run.t0 }) };
      if (isActive(tabId)) renderStatus();
      run.tickOff = timer(tick, STATUS_TICK);
    };
    run.tickOff = timer(tick, STATUS_TICK);

    return new Promise(resolve => {
      run.resolve = resolve;
      const on = (type, fn) => { try { handle.on(type, p => { if (run.done || destroyed) return; try { fn(p ?? {}); } catch (e) { fail(e); } }); } catch { /* a handle without on() */ } };
      on('statement', ev => { run.stmt = ev; run.stmtT0.set(ev.index, clock()); run.progress = null; });
      on('resultset', ev => onResultSet(run, tr, ev));
      on('rows', ev => onRows(run, tr, ev));
      on('resultdone', ev => onResultDone(run, tr, ev));
      on('message', ev => onMessage(run, tr, ev));
      on('plan', ev => onPlan(run, tr, ev));
      on('progress', ev => onProgress(run, tr, ev));
      on('throttle', ev => onThrottle(run, tr, ev));
      on('change', ev => onChange(run, tr, ev));
      on('edits', ev => { run.editResults = Array.isArray(ev.results) ? ev.results : []; });
      on('done', ev => finish(run, tr, ev));
      Promise.resolve(handle.done).then(d => { if (!run.done) finish(run, tr, isObj(d) ? d : { ok: true }); }, e => { if (!run.done) finish(run, tr, { ok: false, error: e, cancelled: e?.name === 'AbortError' }); });
    });
  }

  // The first result set of a run replaces the previous ones (03 §7), keeping their chart choice by index.
  function replaceSets(run, tr) {
    if (run.replaced) return;
    run.replaced = true;
    run.prevSets = tr.sets;
    for (const s of tr.sets) dropSet(tr, s);
    tr.sets = [];
    tr.ver++;
  }
  function dropSet(tr, s) {
    if (s.pending) S.emit('edits', { tabId: s.tabId, setId: s.id, pending: 0 });
    destroySetUi(s);
  }

  function onResultSet(run, tr, ev) {
    const id = typeof ev.id === 'string' ? ev.id : `r${run.byId.size}`;
    const columns = Array.isArray(ev.columns) ? ev.columns : [];
    if (run.kind !== 'run') {
      const q = { id, index: ev.index ?? null, title: ev.title ?? null, columns, source: ev.source ?? null, rows: [], count: 0, truncated: false, incomplete: null, warnings: [], ms: null, streaming: true };
      run.quietSets.push(q);
      run.byId.set(id, q);
      return;
    }
    replaceSets(run, tr);
    run.sawSet = true;
    if (tr.sets.length >= MAX_SETS) { run.hidden.add(id); tr.hiddenSets++; return; }
    const set = {
      id, index: Number.isInteger(ev.index) ? ev.index : null, title: typeof ev.title === 'string' ? ev.title : null, columns, source: isObj(ev.source) ? ev.source : null,
      rows: [], count: 0, truncated: false, incomplete: null, warnings: [], ms: null, sql: run.sql, streaming: true, pending: 0,
      view: { display: tr.textMode ? 'text' : 'table', chart: null }, ui: null, tabId: run.tabId,
    };
    // the chart choice of the set at the same index in the previous run, when its columns still exist (§7.3)
    const prev = run.prevSets?.[tr.sets.length];
    if (prev && prev.view?.display === 'chart' && prev.view.chart) {
      const t = { columns, rows: [], order: null };
      if (resolveChart(prev.view.chart, t)) set.view = { display: 'chart', chart: prev.view.chart };
    }
    tr.sets.push(set);
    run.byId.set(id, set);
    tr.ver++;
    if (tr.sets.length === 1) {
      const pv = run.prevView;
      if (pv == null || pv === 'empty' || isSetView(pv) || pv === 'messages') tr.activeView = set.id;
    }
    if (isActive(run.tabId)) { bodyEl.classList.remove('stale'); renderAll(); }
  }

  function onRows(run, tr, ev) {
    const rows = Array.isArray(ev.rows) ? ev.rows : [];
    if (!rows.length) return;
    run.rows += rows.length;
    const set = run.byId.get(ev.id);
    if (!set) return;
    const target = set.rows;
    for (let i = 0; i < rows.length; i++) target.push(rows[i]);
    set.count += rows.length;
    if (run.kind === 'run') {
      if (set.ui?.grid) set.ui.grid.append(rows);
      set.ui && (set.ui.added = (set.ui.added ?? 0) + rows.length);
      S.emit('run:rows', { tabId: run.tabId, setId: set.id, count: set.count });
      if (isActive(run.tabId)) scheduleStream(set);
    }
  }

  function onResultDone(run, tr, ev) {
    const set = run.byId.get(ev.id);
    if (!set) return;
    if (Number.isFinite(ev.count)) set.count = ev.count;
    set.truncated = !!ev.truncated;
    set.ms = Number.isFinite(ev.ms) ? ev.ms : null;
    set.incomplete = ev.incomplete === 'cancelled' || ev.incomplete === 'error' ? ev.incomplete : null;
    set.warnings = Array.isArray(ev.warnings) ? ev.warnings.filter(isObj) : [];
    set.streaming = false;
    if (run.kind !== 'run') return;
    if (set.incomplete && set.view.display === 'chart') set.view = { ...set.view, display: tr.textMode ? 'text' : 'table' };
    if (set.ui?.grid) { set.ui.grid.done({ incomplete: set.incomplete }); set.ui.elig = null; }
    if (set.ui?.text) syncText(set, true);
    tr.ver++;
    if (isActive(run.tabId)) renderAll();
  }

  function onMessage(run, tr, ev) {
    const m = { ...ev, at: Number.isFinite(ev.at) ? ev.at : nowMs() };
    run.messages.push(m);
    if (m.kind === 'error') run.errors.push(m);
    tr.messages.push(m);
    tr.ver++;
    // coalesced to one render per frame, so a flood of PRINT messages never re-renders per message
    if (isActive(run.tabId)) soon('tabs', tr.activeView === 'messages' ? 'body' : null, m.setId && tr.activeView === m.setId ? 'banners' : null);
  }

  function onPlan(run, tr, ev) {
    if (run.kind !== 'run') return;
    if (tr.estimated) { tr.plans = []; tr.fetchXml = []; tr.estimated = false; }
    const t0 = run.stmtT0.get(ev.index);
    const entry = { index: Number.isInteger(ev.index) ? ev.index : tr.plans.length, plan: isObj(ev.plan) ? ev.plan : null, fetchXml: Array.isArray(ev.fetchXml) ? ev.fetchXml.filter(x => typeof x === 'string') : [], ms: Number.isFinite(ev.ms) ? ev.ms : t0 != null ? clock() - t0 : null, estimated: false };
    tr.plans.push(entry);
    tr.fetchXml.push(...entry.fetchXml.map(xml => ({ index: entry.index, xml })));
    tr.ver++;
    if (isActive(run.tabId) && (tr.activeView === 'plan' || tr.activeView === 'fetchxml')) soon('body');
  }

  function onProgress(run, tr, ev) {
    const pct = Number.isFinite(ev.pct) ? Math.max(0, Math.min(100, ev.pct)) : null;
    if (active === run) { try { shell?.progress?.(pct); } catch { /* idem */ } }
    if (isObj(ev.write)) {
      if (!run.write) run.writeT0 = clock();
      run.write = ev.write;
      if (st().running && st().running.tabId === run.tabId) st().running.write = true;
      const w = writeText(ev.write);
      tr.status = { kind: 'write', text: w.text, batches: w.batches };
      if (active === run) { try { shell?.pill?.(writePill(ev.write, clock() - run.writeT0)); } catch { /* idem */ } }
    } else if (typeof ev.text === 'string' && ev.text) {
      run.progress = ev;
      tr.status = { kind: 'progress', text: ev.text };
    }
    if (isActive(run.tabId)) renderStatus();
  }

  function onThrottle(run, tr, ev) {
    const s = Number.isFinite(ev.seconds) ? Math.max(0, Math.ceil(ev.seconds)) : 0;
    const t = run.throttle ?? { total: 0, until: 0, off: null };
    t.total += s;
    t.until = clock() + s * 1000;
    run.throttle = t;
    if (t.off) t.off();
    const step = () => {
      t.off = null;
      if (run.done) return;
      const left = Math.ceil((t.until - clock()) / 1000);
      if (left <= 0) { endThrottle(run, tr); return; }
      tr.status = { kind: 'throttle', text: TEXTS.throttle(left) };
      if (isActive(run.tabId)) renderStatus();
      t.off = timer(step, 1000);
    };
    tr.status = { kind: 'throttle', text: TEXTS.throttle(s) };
    if (isActive(run.tabId)) renderStatus();
    t.off = timer(step, 1000);
  }
  // The end of a throttle episode: one Messages line with the total wait (03 §7).
  function endThrottle(run, tr) {
    const t = run.throttle;
    if (!t) return;
    run.throttle = null;
    if (t.off) t.off();
    onMessage(run, tr, { kind: 'warn', code: 'THROTTLE', text: TEXTS.throttleLog(t.total), index: run.stmt?.index ?? null, setId: null });
    tr.status = run.write ? { kind: 'write', ...writeText(run.write) } : { kind: 'running', text: runningText({ index: run.stmt?.index, total: run.stmt?.total ?? 0, rows: run.rows, ms: clock() - run.t0 }) };
    if (isActive(run.tabId)) renderStatus();
  }

  // A finished write (02 §9 `change`): its toast with Show details and Download log (03 §7).
  function onChange(run, tr, ev) {
    const e = ev.entry;
    if (st().running && st().running.tabId === run.tabId) st().running.write = false;
    run.write = null;
    if (active === run) { try { shell?.pill?.(null); } catch { /* idem */ } }
    const t = writeToast(e);
    if (t) {
      const text = h('span', null, t.text, ' ', h('button', { class: 'link', type: 'button', onclick: () => downloadLog(e) }, 'Download log'));
      if (t.bulk) {
        const url = isObj(e) && Array.isArray(e.jobs) ? recordUrl('asyncoperation', e.jobs[0], { known: () => true }) : null;
        toast(text, { kind: 'ok', action: url ? { label: 'Open system job', run: () => io('openUrl')(url) } : { label: 'Show details', run: () => showChanges(run.tabId) } });
      } else toast(text, { kind: t.kind, action: { label: 'Show details', run: () => showChanges(run.tabId) } });
      announce(t.text);
    }
    tr.ver++;
    if (isActive(run.tabId)) renderTabs();
  }

  function finish(run, tr, d) {
    if (run.done) return;
    run.done = true;
    if (run.tickOff) run.tickOff();
    if (run.throttle) endThrottle(run, tr);
    const ok = d.ok !== false;
    const cancelled = !!d.cancelled || d.error?.name === 'AbortError';
    const ms = Number.isFinite(d.ms) ? d.ms : clock() - run.t0;
    const rows = Number.isFinite(d.rows) ? d.rows : run.rows;
    // every set still streaming ends here (the session sends resultdone before done; this is a safety net)
    for (const s of run.byId.values()) {
      if (!s.streaming) continue;
      s.streaming = false;
      if (!ok) s.incomplete = cancelled ? 'cancelled' : 'error';
      if (run.kind === 'run') { if (s.ui?.grid) s.ui.grid.done({ incomplete: s.incomplete }); if (s.incomplete && s.view.display === 'chart') s.view = { ...s.view, display: tr.textMode ? 'text' : 'table' }; }
    }
    // a failure without its own error message (an exception of the handle) gets one
    if (!ok && !cancelled && !run.errors.length && d.error) {
      const e = d.error;
      onMessage(run, tr, { kind: 'error', text: errText(e), pos: Number.isFinite(e.pos) ? e.pos : null, end: Number.isFinite(e.end) ? e.end : null, line: Number.isFinite(e.line) ? e.line : null, index: run.stmt?.index ?? null, setId: null, code: e.code ?? null, errors: Array.isArray(e.errors) ? e.errors : undefined, faultCode: e.faultCode });
    }
    const firstErr = run.errors[0] ?? null;
    if (run.kind === 'run') {
      replaceSets(run, tr);
      if (run.hidden.size) onMessage(run, tr, { kind: 'info', text: TEXTS.tooManySets(run.hidden.size), index: null, setId: null });
      if (!ok && !cancelled && firstErr && tr.sets.length) tr.error = firstLine(firstErr.text);
      // the view at the end (03 §7): Messages when the run produced no result set (or failed before one); otherwise the
      // view type the user had is kept
      if (!tr.sets.length) tr.activeView = 'messages';
      else if (isSetView(tr.activeView) && !setOf(tr, tr.activeView)) tr.activeView = tr.sets[0].id;
      tr.markers = runMarkers(run.messages);
      applyMarkers(run.tabId);
      try { S.addHistory?.({ sql: run.sql, mode: run.mode, ms, rows, status: cancelled ? 'cancelled' : ok ? 'ok' : 'error' }); } catch { /* history is best effort */ }
    }
    const errInfo = firstErr ? { text: firstErr.text, errors: firstErr.errors } : d.error ? { text: errText(d.error), errors: d.error.errors } : null;
    tr.status = doneStatus({ ok, cancelled, rows, ms, error: errInfo, summary: typeof d.summary === 'string' ? d.summary : null });
    tr.status.err = firstErr && (firstErr.pos != null || Array.isArray(firstErr.errors)) ? firstErr : null;
    tr.ver++;
    if (active === run) {
      active = null;
      try { shell?.progress?.(false); } catch { /* idem */ }
      if (run.write) { try { shell?.pill?.(null); } catch { /* idem */ } }
    }
    if (run.holds && st().running && st().running.handle === run.handle && st().running.tabId === run.tabId) releaseLock(run.tabId, { ok: ok && !cancelled, cancelled, ms, rows });
    if (run.kind === 'run') announce(endAnnouncement({ ok, cancelled, rows, ms, error: errInfo }));
    if (isActive(run.tabId)) { root.setAttribute('aria-busy', 'false'); bodyEl.classList.remove('stale'); renderAll(); }
    const sets = run.quietSets.map(s => ({ ...s }));
    run.resolve({ ok: ok && !cancelled, cancelled, error: d.error ?? (firstErr ? new Error(firstErr.text) : null), rows, ms, sets, messages: run.messages.slice(), edits: run.editResults });
  }

  // ---- markers ------------------------------------------------------------------------------------------------------
  // The 'run' markers of a tab apply while the editor holds the text that ran (03 §5: any text change clears them).
  function applyMarkers(tabId) {
    if (!editor || typeof editor.setMarkers !== 'function' || !isActive(tabId)) return;
    const tr = trOf(tabId);
    if (tr.runText != null && typeof editor.getValue === 'function' && editor.getValue() !== tr.runText) return;
    try { editor.setMarkers(tr.markers ?? [], 'run'); } catch { /* editor errors are its own */ }
  }

  // ---- views and tabs -----------------------------------------------------------------------------------------------
  const activeTR = () => (activeId() != null ? trOf(activeId()) : null);
  const hasChanges = () => { const log = logOf(); try { return !!log && typeof log.entries === 'function' && log.entries().length > 0; } catch { return false; } };

  // The views of a tab in tab order: result sets (or the 'Results' placeholder before the first run), Messages, Plan,
  // FetchXML and Changes while the change log has entries (03 §7).
  function viewsOf(tr) {
    const out = [];
    const n = tr.sets.length;
    tr.sets.forEach((s, i) => out.push({ id: s.id, label: setLabel(s, i, n), badge: setBadge(s), set: s, i }));
    if (!n && !tr.ran) out.push({ id: 'empty', label: 'Results', badge: null });
    out.push({ id: 'messages', label: 'Messages', badge: tr.messages.length ? messagesBadge(tr.messages) : null });
    out.push({ id: 'plan', label: 'Plan', badge: null });
    out.push({ id: 'fetchxml', label: 'FetchXML', badge: null });
    if (hasChanges()) out.push({ id: 'changes', label: 'Changes', badge: null });
    return out;
  }
  function currentView(tr) {
    const views = viewsOf(tr);
    if (views.some(v => v.id === tr.activeView)) return tr.activeView;
    tr.activeView = views[0].id;
    return tr.activeView;
  }
  // Shows a view of the active tab (03 §7 tabs).
  function setView(v, { focus = false } = {}) {
    const tr = activeTR();
    if (!tr) return;
    if (!viewsOf(tr).some(x => x.id === v)) return;
    tr.activeView = v;
    renderAll();
    if (focus) tabsEl.querySelector(`[data-view="${v}"]`)?.focus();
  }
  function showChanges(tabId) {
    if (tabId != null && st().tabs.some(t => t.id === tabId) && !isActive(tabId)) S.setActiveTab(tabId);
    setView('changes');
  }

  let tabEls = new Map();
  function renderTabs() {
    const tr = activeTR();
    clear(tabsEl);
    tabEls = new Map();
    if (!tr) return;
    const v = currentView(tr);
    for (const x of viewsOf(tr)) {
      const sel = x.id === v;
      const lb = h('span', { class: 'lb', text: x.label });
      const badge = x.badge ? h('span', { class: x.badge.cls, text: x.badge.text, 'aria-hidden': 'true' }) : null;
      const aria = x.badge ? `${x.label}, ${x.id === 'messages' ? plural(tr.messages.length, 'message') : x.set?.incomplete ? `${x.badge.text} rows, incomplete` : plural(x.set?.count ?? 0, 'row')}` : x.label;
      const el = h('button', {
        class: 'tab', role: 'tab', type: 'button', 'data-view': x.id, 'aria-selected': sel ? 'true' : 'false', tabindex: sel ? '0' : '-1',
        'aria-controls': ids.body, 'aria-label': aria, title: x.set && x.set.title ? overflowLabel(x.set, x.i) : undefined,
        onclick: () => setView(x.id),
      }, lb, badge);
      tabEls.set(x.id, el);
      tabsEl.append(el);
      // a set's grid is labelled like its tab ('Results' becomes 'Results 1' when a second set arrives)
      if (x.set?.ui?.grid && x.set.ui.label !== x.label) { x.set.ui.label = x.label; x.set.ui.grid.setOptions({ label: x.label }); }
    }
    const a = tabEls.get(v);
    bodyEl.setAttribute('aria-labelledby', '');
    if (a) {
      if (!a.id) a.id = util.uid('rs-t');
      bodyEl.setAttribute('aria-labelledby', a.id);
      try { a.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch { /* not laid out */ }
    }
    frame(() => { moreBtn.hidden = !(tabsEl.scrollWidth > tabsEl.clientWidth + 1); });
    const L = st().layout;
    const max = L?.resPane === 'max';
    setChildren(maxBtn, icon(max ? 'restore' : 'maximize', 20));
    maxBtn.title = max ? 'Restore the results' : 'Maximize the results';
    maxBtn.setAttribute('aria-label', maxBtn.title);
  }
  tabsEl.addEventListener('keydown', e => {
    const list = [...tabEls.values()];
    const i = list.indexOf(e.target);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    if (j == null) return;
    e.preventDefault();
    setView(list[j].getAttribute('data-view'), { focus: true });
  });
  moreBtn.addEventListener('click', () => {
    const tr = activeTR();
    if (!tr || !shell?.menu) return;
    const v = currentView(tr);
    const items = tr.sets.map((s, i) => ({ label: overflowLabel(s, i), checked: s.id === v, run: () => setView(s.id, { focus: true }) }));
    if (items.length) items.push('-');
    for (const x of viewsOf(tr).filter(x => !x.set)) items.push({ label: x.label, checked: x.id === v, run: () => setView(x.id, { focus: true }) });
    shell.menu(moreBtn, items, { align: 'end', label: 'Result tabs' });
  });
  maxBtn.addEventListener('click', () => {
    const L = st().layout;
    try { S.setLayout({ resPane: L?.resPane === 'max' ? 'normal' : 'max' }); S.emit('layout', {}); } catch (e) { fail(e); }
    renderTabs();
  });

  // ---- toolbar -------------------------------------------------------------------------------------------------------
  function renderBar() {
    const tr = activeTR();
    const v = tr ? currentView(tr) : null;
    const set = tr ? setOf(tr, v) : null;
    setTools.hidden = !set;
    planTools.hidden = v !== 'plan' || !tr.plans.length;
    estBadge.hidden = !tr?.estimated;
    fetchTools.hidden = v !== 'fetchxml' || !tr.estimated || !tr.plans.length;
    bar.hidden = setTools.hidden && planTools.hidden && fetchTools.hidden;
    if (!set) return;
    ensureSetUi(set);
    const g = set.ui.grid;
    const view = set.view;
    if (qInput.value !== (view.quick ?? '')) qInput.value = view.quick ?? '';
    const c = set.ui.counts ?? (g ? g.counts() : { shown: set.count, total: set.count, loading: set.streaming });
    countEl.textContent = countText(c, !!(view.quick || (view.filters && view.filters.length)));
    const friendly = settings().friendly !== false;
    friendlyBtn.setAttribute('aria-pressed', friendly ? 'true' : 'false');
    rawBtn.setAttribute('aria-pressed', friendly ? 'false' : 'true');
    const d = view.display ?? 'table';
    tableBtn.setAttribute('aria-pressed', d === 'table' ? 'true' : 'false');
    textBtn.setAttribute('aria-pressed', d === 'text' ? 'true' : 'false');
    chartBtn.setAttribute('aria-pressed', d === 'chart' ? 'true' : 'false');
    const ca = chartAvailability(set);
    chartBtn.disabled = !ca.ok;
    chartBtn.title = ca.ok ? 'Quick chart of this result' : ca.title;
    const editing = !!g?.editing();
    let et = null;
    if (set.streaming) et = TEXTS.editStreaming;
    else if (!editing && g) {
      // computed once per complete set: the unique-pk check reads every row
      if (!set.ui.elig) set.ui.elig = g.editEligibility();
      if (!set.ui.elig.ok) et = set.ui.elig.reason;
    }
    editBtn.disabled = !!et && !editing;
    editBtn.title = et ?? (editing ? 'Leave edit mode' : 'Edit the rows of this table');
    editBtn.setAttribute('aria-pressed', editing ? 'true' : 'false');
    exportBtn.disabled = !!set.streaming;
    exportBtn.title = set.streaming ? STREAMING_TITLE : 'Export or copy the current view';
    const imp = !!st().impersonating;
    const vo = imp ? { error: TEXTS.saveViewImpersonating } : set.streaming ? { error: STREAMING_TITLE } : null;
    viewBtn.disabled = viewMenuBtn.disabled = !!vo || editing || viewBusy;
    viewBtn.title = vo?.error ?? (viewBusy ? 'Opening the view…' : 'Open these results in Dynamics, in your view SQL Studio Results (replaced each time)');
    viewLbl.textContent = viewBusy ? 'Opening…' : 'Open as view';
    viewBtn.setAttribute('aria-label', viewLbl.textContent);
  }
  qInput.addEventListener('input', () => {
    const set = activeSet();
    if (!set?.ui?.grid) return;
    set.view = { ...set.view, quick: qInput.value };
    set.ui.grid.setQuick(qInput.value);
  });
  friendlyBtn.addEventListener('click', () => setFriendly(true));
  rawBtn.addEventListener('click', () => setFriendly(false));
  function setFriendly(on) {
    if (settings().friendly === on) return;
    try { S.setSetting('friendly', on); } catch (e) { fail(e); }
  }
  tableBtn.addEventListener('click', () => setDisplay('table'));
  textBtn.addEventListener('click', () => setDisplay('text'));
  chartBtn.addEventListener('click', () => setDisplay('chart'));
  // Table / Text set TabResults.textMode, the initial display of the tab's later sets; Chart is per set (§7.3).
  function setDisplay(d) {
    const tr = activeTR();
    const set = activeSet();
    if (!tr || !set) return;
    if (d === 'chart' && !chartAvailability(set).ok) return;
    if (d !== 'table' && set.ui?.grid?.editing()) return;
    if (d === 'table' || d === 'text') tr.textMode = d === 'text';
    set.view = { ...set.view, display: d };
    renderAll();
  }
  editBtn.addEventListener('click', async () => {
    const set = activeSet();
    const g = set?.ui?.grid;
    if (!g) return;
    if (g.editing()) { await g.setEditMode(false); renderBar(); return; }
    set.view = { ...set.view, display: 'table' };
    activeTR().textMode = false;
    renderAll();
    if (await g.setEditMode(true)) g.focus();
    renderBar();
  });
  // The personal view of the active set: {set, v} or null after a warning (viewOfSet's error).
  function activeView() {
    const tr = activeTR();
    const set = activeSet();
    if (!tr || !set) return null;
    const entry = tr.plans.find(p => p.index === set.index) ?? null;
    const v = viewOfSet(set, entry);
    if (v.error) { toast(v.error, { kind: 'warn' }); return null; }
    return { set, v, columns: set.columns.filter(c => !c.hidden && c.attr && c.attr.entity === v.entity) };
  }
  async function openAsView() {
    if (viewBusy) return;
    const a = activeView();
    if (!a) return;
    viewBusy = true;
    renderBar();
    try { await dlg('openTempView')({ entity: a.v.entity, fetchXml: a.v.fetchXml, columns: a.columns }); } catch (e) { fail(e); } finally { viewBusy = false; renderBar(); }
  }
  function saveAsNamedView() {
    const a = activeView();
    if (!a) return;
    try { dlg('saveAsView')({ entity: a.v.entity, fetchXml: a.v.fetchXml, columns: a.columns, open: true, note: a.v.note }); } catch (e) { fail(e); }
  }
  viewBtn.addEventListener('click', () => { openAsView(); });
  viewMenuBtn.addEventListener('click', () => {
    if (!shell?.menu) return;
    shell.menu(viewMenuBtn, [
      { label: 'Open as view', icon: 'open', title: 'Open the results in your view SQL Studio Results, replaced each time', run: () => { openAsView(); } },
      { label: 'Save as personal view…', icon: 'save', title: 'Save the results as a named personal view and open it in a new tab', run: () => saveAsNamedView() },
    ], { label: 'View options' });
  });
  exportBtn.addEventListener('click', () => {
    const set = activeSet();
    if (!set?.ui?.grid || !shell?.menu) return;
    shell.menu(exportBtn, () => exportItems(set), { label: 'Export' });
  });
  copyPlanBtn.addEventListener('click', () => {
    const tr = activeTR();
    if (!tr) return;
    const text = planText(tr.plans, { estimated: tr.estimated });
    Promise.resolve(io('copyText')(text)).then(ok => { toast(ok ? 'Copied the plan.' : exportModule.COPY_FAILED, { kind: ok ? 'ok' : 'error' }); if (ok) announce('Copied the plan.'); });
  });
  const activeSet = () => { const tr = activeTR(); return tr ? setOf(tr, currentView(tr)) : null; };

  // ---- banners -------------------------------------------------------------------------------------------------------
  function renderBanners() {
    clear(bannersEl);
    const tr = activeTR();
    const set = tr ? activeSet() : null;
    if (!set) return;
    for (const b of setBanners(set, { messages: tr.messages, error: tr.error })) {
      const acts = [];
      if (b.action === 'noLimit') acts.push(h('button', { class: 'btn', type: 'button', onclick: () => runAgainNoLimit() }, TEXTS.runNoLimit));
      if (b.action === 'messages') acts.push(h('button', { class: 'link', type: 'button', onclick: () => setView('messages') }, TEXTS.showMessages));
      bannersEl.append(h('div', { class: 'banner' + (b.kind === 'warn' ? ' warn' : '') },
        h('span', { class: 'ic' }, icon(b.kind === 'warn' ? 'warn' : 'info', 20)),
        h('div', { class: 'txt' }, b.action === 'messages' ? [b.text, ' · '] : b.text, b.action === 'messages' ? acts : null),
        b.action === 'messages' ? null : acts));
    }
  }
  // 'Run again without the row limit' (03 §7): one run whose settings use maxRows = maxScanRows.
  function runAgainNoLimit() {
    const tabId = activeId();
    const tr = activeTR();
    return runTab(tabId, tr?.lastRun?.mode ?? 'all', { maxRows: settings().maxScanRows });
  }

  // ---- the body ------------------------------------------------------------------------------------------------------
  function renderAll() {
    if (destroyed) return;
    ensureLogSub();
    const r = st().running;
    root.setAttribute('aria-busy', r && r.tabId === activeId() && !r.quiet ? 'true' : 'false');
    renderTabs();
    renderBar();
    renderBanners();
    renderBody();
    renderStatus();
  }
  // Renders parts of the active tab at most once per frame: 'tabs', 'body', 'banners', 'status' (null entries skipped).
  let soonParts = new Set(), soonOff = null;
  function soon(...parts) {
    for (const p of parts) if (p) soonParts.add(p);
    if (soonOff || !soonParts.size) return;
    soonOff = frame(() => {
      soonOff = null;
      const ps = soonParts;
      soonParts = new Set();
      if (destroyed) return;
      if (ps.has('tabs')) renderTabs();
      if (ps.has('banners')) renderBanners();
      if (ps.has('body')) renderBody();
      if (ps.has('status')) renderStatus();
    });
  }
  let shownEl = null;
  function show(el) {
    if (el && shownEl === el && el.parentNode === bodyEl) return;
    for (const c of [...bodyEl.childNodes]) bodyEl.removeChild(c);
    if (el) bodyEl.append(el);
    shownEl = el;
  }
  function renderBody() {
    const tr = activeTR();
    if (!tr) { show(null); return; }
    const v = currentView(tr);
    const set = setOf(tr, v);
    if (set) { show(setPane(tr, set)); return; }
    if (v === 'empty') { show(emptyState()); return; }
    if (v === 'messages') { show(messagesPane(tr)); return; }
    if (v === 'plan') { show(planPane(tr)); return; }
    if (v === 'fetchxml') { show(fetchPane(tr)); return; }
    if (v === 'changes') { show(changesPane()); return; }
    show(null);
  }

  // Before the first run (03 §7 States).
  function emptyState() {
    const k = id => (keyLabel(id, mac) || '').split(/(?<!\+),\s+/)[0];
    const hints = [`${k('run') || 'F5'} run`, `${k('complete') || 'Ctrl+Space'} suggestions`, 'drag tables from the explorer', `${k('help') || 'F1'} help`].join(' · ');
    const hist = (st().history ?? []).slice(0, 3).map(e => h('button', {
      class: 'link', type: 'button', title: e.sql.length > 2000 ? e.sql.slice(0, 2000) + '…' : e.sql,
      onclick: () => { try { S.createTab({ sql: e.sql }); } catch (err) { fail(err); } },
    }, firstLine(e.sql).slice(0, 200)));
    return h('div', { class: 'empty' },
      h('span', { class: 'ic' }, icon('table', 22)),
      h('b', null, TEXTS.emptyTitle),
      h('span', null, hints),
      hist.length ? h('div', { class: 'rs-hist', role: 'list', 'aria-label': 'Recent queries' }, hist) : null,
      h('div', { class: 'acts' }, h('button', { class: 'link', type: 'button', onclick: () => { if (!shell?.exec?.('templates')) dlg('openTemplates')(); } }, TEXTS.browseTemplates)));
  }

  // ---- result sets: grid, text view, chart ---------------------------------------------------------------------------
  function gridOptions() {
    const s = settings();
    return { friendly: s.friendly !== false, tz: tzNow(), dateFormat: dateFormatNow(), compact: !!s.compact, fontSize: s.gridFontSize, csvNeutralize: s.csvNeutralize !== false };
  }
  function ensureSetUi(set) {
    if (set.ui) return set.ui;
    const ui = set.ui = { el: h('div', { class: 'rs-pane' }), grid: null, text: null, textHost: h('div', { class: 'rs-pane' }), chart: null, counts: null, sel: null, added: 0 };
    const tr = trOfSet(set);
    const label = setLabel(set, tr ? tr.sets.indexOf(set) : 0, tr ? tr.sets.length : 1);
    ui.grid = createGrid(ui.el, {
      columns: set.columns, source: set.source, rows: set.rows, complete: !set.streaming, incomplete: set.incomplete, ...gridOptions(),
      label, known, mac, shell, meta, io: opts.io, view: set.view, editModel: null,
      onView: v => { set.view = { ...v, display: set.view.display, chart: set.view.chart }; viewChanged(set); },
      // onCount comes after the grid recomputes its view, so the text view and chart redrawn here see the filtered rows
      // (onView comes before the recompute)
      onCount: c => { ui.counts = c; if (!set.streaming) { if (ui.text) syncText(set, true); if (ui.chart) chartDirty(set); } if (set === activeSet()) { countEl.textContent = countText(c, !!(set.view.quick || set.view.filters?.length)); } },
      onSelection: info => { ui.sel = info; if (set === activeSet()) renderStats(); },
      onEdit: e => { set.pending = e.pending; S.emit('edits', { tabId: set.tabId, setId: set.id, pending: e.pending }); if (set === activeSet()) renderBar(); },
      onReview: payload => reviewEdits(set, payload),
      actions: {
        copyAs: (format, payload) => exportModule.copyAs(format, payload, copyCtx(set)),
        copyState: (format, table) => exportModule.copyState(format, table),
        rowDetails: info => openRowDetails(set, info),
        cellText: (text, kind) => { try { dlg('openCellViewer')(text, kind); } catch (e) { fail(e); } },
        newQuery: sql => { try { S.createTab({ sql }); } catch (e) { fail(e); } },
      },
    });
    ui.counts = ui.grid.counts();
    ui.label = label;
    return ui;
  }
  const trOfSet = set => (set.tabId != null ? st().results.get(set.tabId) ?? null : null);
  function destroySetUi(set) {
    const ui = set.ui;
    if (!ui) return;
    set.ui = null;
    try { ui.grid?.destroy(); } catch { /* gone */ }
    try { ui.text?.destroy(); } catch { /* gone */ }
    destroyChart(ui);
  }
  // The pane of a set for its display (03 §7: Table, Text, Chart §7.3).
  function setPane(tr, set) {
    const ui = ensureSetUi(set);
    const d = set.view.display ?? 'table';
    if (d === 'chart' && chartAvailability(set).ok) return chartPane(set);
    if (d === 'text') {
      const fresh = !ui.text;
      ensureText(set);
      // rows that streamed in while another display was shown
      if (!fresh && ui.textSynced !== set.rows.length) syncText(set, true);
      return ui.textHost;
    }
    return ui.el;
  }
  const copyCtx = set => ({ toast: (t, o) => toast(t, o), announce, io: opts.io ? ioObj() : undefined, title: set.title || 'Results', yieldToUi: yieldFn });
  function ensureText(set) {
    const ui = set.ui;
    if (ui.text) return ui.text;
    ui.text = createTextView(ui.textHost, { table: ui.grid.currentView(), fontSize: settings().gridFontSize, mac, ctx: copyCtx(set), now: clock, later, frame, yieldToUi: yieldFn });
    ui.textSynced = set.count;
    return ui.text;
  }
  // The text view follows the grid's view (03 §7: widths recomputed at most every 500 ms while the set streams).
  function syncText(set, force = false) {
    const ui = set.ui;
    if (!ui?.text) return;
    const v = set.view;
    const plain = !(v.sort && v.sort.length) && !(v.filters && v.filters.length) && !v.quick;
    const table = ui.grid.currentView();
    if (!force && plain && set.streaming && ui.textSynced != null && ui.textSynced <= table.rows.length) {
      ui.text.update({ table, added: table.rows.slice(ui.textSynced) });
    } else ui.text.update({ table, incomplete: set.incomplete });
    ui.textSynced = table.rows.length;
  }
  function viewChanged(set) {
    if (set.ui?.text) syncText(set, true);
    if (set.ui?.chart) chartDirty(set);
    if (set === activeSet()) { renderBar(); renderBanners(); }
  }
  // Streaming updates of the active set (03 §7: re-applied at most every 500 ms; the grid throttles itself).
  let streamOff = null;
  function scheduleStream(set) {
    if (streamOff) return;
    streamOff = timer(() => {
      streamOff = null;
      const a = activeSet();
      if (a?.ui?.text && a.view.display === 'text') syncText(a);
      renderTabs();
      if (a) renderBar();
    }, STREAM_MS);
  }

  // ---- Messages --------------------------------------------------------------------------------------------------------
  function messagesPane(tr) {
    const cache = tr.ui.msgs;
    if (cache && cache.ver === tr.ver) return cache.el;
    const items = messageItems(tr.messages);
    if (!items.length) {
      const el = h('div', { class: 'empty' }, h('span', { class: 'ic' }, icon('info', 22)), h('b', null, TEXTS.messagesEmpty));
      tr.ui.msgs = { ver: tr.ver, el, n: 0 };
      return el;
    }
    const tabId = activeId();
    if (items.length <= MSG_VIRTUAL) {
      // incremental: the messages already rendered stay, new ones are appended
      if (cache && cache.list && !cache.virt && cache.mCount <= tr.messages.length && cache.mRef === tr.messages) {
        const fresh = messageItems(tr.messages.slice(cache.mCount));
        for (const it of fresh) cache.list.append(msgEl(it, tr, tabId));
        cache.mCount = tr.messages.length;
        cache.ver = tr.ver;
        return cache.el;
      }
      const list = h('div', { role: 'list', 'aria-label': 'Messages' }, items.map(it => msgEl(it, tr, tabId)));
      const el = h('div', { class: 'rs-msgs' }, list);
      tr.ui.msgs = { ver: tr.ver, el, list, mCount: tr.messages.length, mRef: tr.messages, virt: false };
      return el;
    }
    // virtualised above 500 items (03 §13): one line per item (two with a hint), rendered ± 60 around the view
    const heights = items.map(it => (it.hint ? 2 : 1) * MSG_LINE + (it.fix || it.m.code === 'READONLY' || it.m.link ? MSG_LINE : 0));
    const tops = new Float64Array(items.length + 1);
    for (let i = 0; i < items.length; i++) tops[i + 1] = tops[i] + heights[i];
    const sizer = h('div', { class: 'rs-sz', role: 'list', 'aria-label': 'Messages', style: `height:${tops[items.length]}px` });
    const el = h('div', { class: 'rs-msgs virt' }, sizer);
    const paint = () => {
      const top = el.scrollTop || 0, vh = el.clientHeight || 600;
      let a = 0;
      while (a < items.length && tops[a + 1] < top) a++;
      let b = a;
      while (b < items.length && tops[b] < top + vh) b++;
      a = Math.max(0, a - 60); b = Math.min(items.length, b + 60);
      clear(sizer);
      for (let i = a; i < b; i++) {
        const n = msgEl(items[i], tr, tabId);
        n.style.top = tops[i] + 'px';
        n.style.height = heights[i] + 'px';
        n.setAttribute('aria-posinset', String(i + 1));
        n.setAttribute('aria-setsize', String(items.length));
        sizer.append(n);
      }
    };
    let pf = null;
    el.addEventListener('scroll', () => { if (!pf) pf = frame(() => { pf = null; paint(); }); });
    paint();
    tr.ui.msgs = { ver: tr.ver, el, virt: true, paint };
    return el;
  }
  // One Messages item (03 §7): icon, time, statement, text (clickable at its position), rows affected, duration, the
  // READONLY / fix / link actions and the ERROR_HINTS line with its Help link.
  function msgEl(it, tr, tabId) {
    const m = it.m;
    const iconName = it.header ? 'error' : MSG_ICONS[it.kind] ?? 'info';
    const at = Number.isFinite(m.at) ? m.at : nowMs();
    const time = fmtDate(at, tzNow()).slice(11, 19);
    const lineInfo = it.line != null ? ` (line ${fmtInt(it.line)})` : '';
    const textEl = it.pos != null
      ? h('button', { class: 'tx', type: 'button', title: `Select it in the editor${lineInfo}`, onclick: () => goToPos(tabId, it.pos, it.end ?? it.pos) }, it.text)
      : h('span', { class: 'tx', title: tr.ui?.msgs?.virt ? it.text : undefined }, it.text);
    const acts = [];
    if (!it.header && m.code === 'READONLY') acts.push(h('button', { class: 'btn', type: 'button', onclick: () => allowAndRerun(tabId) }, icon('unlock', 16), TEXTS.allowAndRun));
    if (it.fix) acts.push(h('button', { class: 'btn', type: 'button', onclick: () => applyFix(tabId, it.fix) }, TEXTS.fixLabel(it.fix.text)));
    if (!it.header && !it.sub && isObj(m.link) && typeof m.link.label === 'string') {
      const url = recordUrl(m.link.entity, m.link.id, { known });   // only a table this org has (00 §5 rule 6)
      if (url) acts.push(h('button', { class: 'link', type: 'button', onclick: () => { try { io('openUrl')(url); } catch (e) { fail(e); } } }, icon('open', 16), m.link.label));
    }
    const hint = it.hint ? h('span', { class: 'hn' }, it.hint.hint.line, ' ', h('button', { class: 'link', type: 'button', style: 'font-size:12px', onclick: () => { try { dlg('openHelp')('errors', it.hint.code); } catch (e) { fail(e); } } }, TEXTS.help)) : null;
    const facts = messageFacts(m);
    return h('div', { class: `rs-m ${it.kind}${it.header ? ' head' : ''}${it.sub ? ' sub' : ''}`, role: 'listitem' },
      h('span', { class: 'ic' }, icon(iconName, 16)),
      h('span', { class: 'tm', text: time }),
      it.statement != null && !it.sub ? h('span', { class: 'sn', text: `Statement ${fmtInt(it.statement)}` }) : null,
      h('div', { class: 'bd' }, textEl, hint, acts.length ? h('div', { class: 'acts' }, acts) : null),
      facts.length ? h('span', { class: 'fx', text: facts.join(' · ') }) : null);
  }
  // Selects a position in the editor (03 §7: error items jump to their range), after switching to the tab.
  function goToPos(tabId, pos, end) {
    if (!editor) return;
    const go = () => { try { editor.focus(); editor.select(pos, Math.max(pos, end), { reveal: true }); } catch (e) { fail(e); } };
    if (!isActive(tabId) && st().tabs.some(t => t.id === tabId)) { S.setActiveTab(tabId); timer(go, 0); } else go();
  }
  // A message fix (03 §7): replaces its range in one undoable edit, only while the editor holds the text that ran.
  function applyFix(tabId, fix) {
    const tr = trOf(tabId);
    if (!editor || !isActive(tabId) || tr.fixed || (tr.runText != null && editor.getValue() !== tr.runText)) { toast(TEXTS.fixStale, { kind: 'info' }); return; }
    try {
      editor.focus();
      editor.select(fix.pos, fix.end, { reveal: true });
      editor.insert(fix.text);
      tr.fixed = true;
      announce(`Replaced with ${fix.text}.`);
    } catch (e) { fail(e); }
  }
  // 'Allow changes and run again' (03 §7): the Allow changes dialog, then the same text again.
  async function allowAndRerun(tabId) {
    let ok = false;
    try { ok = await dlg('allowChanges')(); } catch (e) { fail(e); return; }
    if (!ok) return;
    const last = trOf(tabId).lastRun;
    if (!last) return;
    await runText(tabId, { sql: last.sql, offset: last.offset, fullText: last.fullText, mode: last.mode }, { maxRows: last.maxRows ?? undefined });
  }

  // ---- Plan (03 §7) -------------------------------------------------------------------------------------
  const NODE_H = 28, HEAD_H = 32, WARN_H = 22, PAD_L = 12;
  function planPane(tr) {
    const cache = tr.ui.plan;
    if (cache && cache.ver === tr.ver && cache.sel === tr.planSel && cache.coll === tr.collapsed.size) return cache.el;
    if (!tr.plans.length) {
      const el = h('div', { class: 'empty' }, h('span', { class: 'ic' }, icon('plan', 22)), h('b', null, 'No plan yet'), h('span', null, TEXTS.planEmpty(keyLabel('plan', mac) || 'Ctrl+L')));
      tr.ui.plan = { ver: tr.ver, el, sel: tr.planSel, coll: tr.collapsed.size };
      return el;
    }
    const rows = planRows(tr.plans, { collapsed: tr.collapsed, estimated: tr.estimated });
    if (!rows.some(r => r.key === tr.planSel)) tr.planSel = rows.find(r => !r.header)?.key ?? rows[0]?.key ?? null;
    const inner = h('div', { class: 'rs-pin' });
    const tree = h('div', { class: 'rs-ptree', role: 'tree', 'aria-label': tr.estimated ? 'Estimated plan' : 'Plan', tabindex: '-1' }, inner);
    const props = h('div', { class: 'rs-pprops', role: 'region' });
    const el = h('div', { class: 'rs-plan' }, tree, props);
    const rowEls = new Map();
    const tops = new Map();
    let y = 8;
    const connectors = [];
    for (const r of rows) {
      const depth = r.header ? 0 : r.depth;
      const expanded = r.kids ? !tr.collapsed.has(r.key) : null;
      const left = PAD_L + depth * PLAN_INDENT;
      let rowEl;
      if (r.header) {
        const n = Number.isInteger(r.entry.index) ? r.entry.index + 1 : null;
        const ms = !tr.estimated && Number.isFinite(r.entry.ms) ? ` · ${fmtDuration(r.entry.ms)}` : '';
        rowEl = h('div', { class: 'rs-pn hd', role: 'treeitem', 'aria-level': '1', 'data-key': r.key, tabindex: '-1', style: `padding-left:${left}px`, 'aria-expanded': r.kids ? String(expanded) : undefined },
          h('span', { class: 'cv' + (r.kids ? '' : ' no'), 'aria-hidden': 'true' }, icon('chevron', 12)),
          h('span', null, `${n != null ? `Statement ${fmtInt(n)}` : 'Statement'}${ms}`),
          r.entry.error ? h('span', { class: 'err', text: errText(r.entry.error) }) : null);
        tops.set(r.key, { y, h: HEAD_H, x: left + 8 });
        y += HEAD_H;
      } else {
        const node = r.node;
        const b = nodeBadge(node);
        const stats = nodeStatsText(node);
        rowEl = h('div', {
          class: 'rs-pn', role: 'treeitem', 'aria-level': String(depth + 1), 'data-key': r.key, tabindex: '-1', style: `padding-left:${left}px`,
          'aria-expanded': r.kids ? String(expanded) : undefined, 'aria-selected': r.key === tr.planSel ? 'true' : 'false',
          title: node.detail ? `${node.op}: ${node.detail}` : node.op,
        },
        h('span', { class: 'cv' + (r.kids ? '' : ' no'), 'aria-hidden': 'true' }, icon('chevron', 12)),
        h('span', { class: 'gl', 'aria-hidden': 'true' }, icon(nodeIcon(node), 16)),
        h('span', { class: 'op', text: node.op }),
        node.detail ? h('span', { class: 'dt', text: node.detail }) : null,
        b ? h('span', { class: b.cls }, icon(b.icon, 12), b.text) : null,
        stats ? h('span', { class: 'st', text: stats }) : null,
        node.warnings?.length ? h('span', { style: 'display:grid;color:var(--amber)', title: node.warnings.join('\n') }, icon('warn', 16)) : null);
        tops.set(r.key, { y, h: NODE_H, x: left + 8 });
        const parent = tops.get(r.parentKey);
        if (parent) connectors.push({ from: parent, to: { y, h: NODE_H, x: left + 8 }, w: r.width, rows: r.rows });
        y += NODE_H;
      }
      rowEls.set(r.key, rowEl);
      inner.append(rowEl);
      if (!r.header) {
        for (const w of r.node.warnings ?? []) {
          inner.append(h('div', { class: 'rs-pw', style: `padding-left:${left + 30}px`, title: w }, icon('warn', 12), w));
          y += WARN_H;
        }
      }
    }
    inner.style.height = (y + 16) + 'px';
    // the connector from each node to its parent, wider as the node's rows grow
    for (const c of connectors) {
      const x = c.from.x;
      const top = c.from.y + c.from.h - 6;
      const bottom = c.to.y + c.to.h / 2;
      const w = Math.round(c.w * 10) / 10;
      inner.append(h('span', {
        class: 'rs-pc', 'aria-hidden': 'true',
        title: c.rows == null ? 'Rows unknown' : plural(Math.round(c.rows), 'row'),
        style: `left:${x - w / 2}px;top:${top}px;height:${Math.max(4, bottom - top + w / 2)}px;width:${Math.max(6, c.to.x - x - 6)}px;border-left-width:${w}px;border-bottom-width:${w}px`,
      }));
    }
    const select = (key, focus) => {
      tr.planSel = key;
      for (const [k, e] of rowEls) { e.setAttribute('aria-selected', k === key ? 'true' : 'false'); e.tabIndex = k === key ? 0 : -1; }
      renderProps(tr, rows.find(r => r.key === key), props);
      if (focus) { const e = rowEls.get(key); e?.focus(); try { e?.scrollIntoView?.({ block: 'nearest' }); } catch { /* not laid out */ } }
      tr.ui.plan.sel = key;
    };
    const toggle = key => { if (tr.collapsed.has(key)) tr.collapsed.delete(key); else tr.collapsed.add(key); tr.ui.plan = null; renderBody(); rowElsNow().get(key)?.focus(); };
    const rowElsNow = () => tr.ui.plan?.rowEls ?? new Map();
    inner.addEventListener('click', e => {
      const t = e.target?.closest?.('[data-key]');
      if (!t) return;
      const key = t.getAttribute('data-key');
      if (e.target.closest?.('.cv') && t.hasAttribute('aria-expanded')) { toggle(key); return; }
      select(key, true);
    });
    inner.addEventListener('dblclick', e => {
      const t = e.target?.closest?.('[data-key]');
      const r = t ? rows.find(x => x.key === t.getAttribute('data-key')) : null;
      if (r?.node?.fetchXml != null) openFetchOf(tr, r);
    });
    tree.addEventListener('keydown', e => {
      const i = rows.findIndex(r => r.key === tr.planSel);
      if (i < 0) return;
      const r = rows[i];
      let k = null;
      if (e.key === 'ArrowDown') k = rows[Math.min(rows.length - 1, i + 1)].key;
      else if (e.key === 'ArrowUp') k = rows[Math.max(0, i - 1)].key;
      else if (e.key === 'Home') k = rows[0].key;
      else if (e.key === 'End') k = rows[rows.length - 1].key;
      else if (e.key === 'ArrowRight' && r.kids) { e.preventDefault(); if (tr.collapsed.has(r.key)) toggle(r.key); else k = rows[i + 1]?.key ?? null; } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (r.kids && !tr.collapsed.has(r.key)) { toggle(r.key); return; }
        k = r.parentKey;
      } else if (e.key === 'Enter' && r.node?.fetchXml != null) { e.preventDefault(); openFetchOf(tr, r); return; }
      if (k == null) return;
      e.preventDefault();
      select(k, true);
    });
    tr.ui.plan = { ver: tr.ver, el, sel: tr.planSel, coll: tr.collapsed.size, rowEls };
    select(tr.planSel, false);
    return el;
  }
  // The properties panel of the selected node: role=region 'Properties of FetchScan', a .kv list.
  function renderProps(tr, r, el) {
    clear(el);
    if (!r) return;
    if (r.header) {
      el.setAttribute('aria-label', 'Properties of the statement');
      const e = r.entry;
      const items = [['Statement', Number.isInteger(e.index) ? fmtInt(e.index + 1) : '—']];
      if (!tr.estimated && Number.isFinite(e.ms)) items.push(['Time', fmtDuration(e.ms)]);
      items.push(['FetchXML queries', fmtInt(Array.isArray(e.fetchXml) ? e.fetchXml.length : 0)]);
      if (e.error) items.push(['Error', errText(e.error)]);
      el.append(h('h3', { text: 'Statement' }), h('div', { class: 'kv' }, items.flatMap(([n, v]) => [h('span', { class: 'lb', text: n }), h('span', { class: 'val', text: v })])));
      return;
    }
    const node = r.node;
    el.setAttribute('aria-label', `Properties of ${node.op}`);
    const kv = h('div', { class: 'kv' });
    for (const g of nodeProps(node, { statementMs: statementMs(r.entry) })) {
      kv.append(h('span', { class: 'kh', text: g.title }));
      for (const it of g.items) {
        kv.append(h('span', { class: 'lb', text: it.name, title: it.name }));
        if (!it.long) { kv.append(h('span', { class: 'val', text: it.value })); continue; }
        kv.append(h('span', { class: 'vc' }, h('span', { class: 'val', text: it.value }),
          h('button', { class: 'x', type: 'button', title: `Copy ${it.name}`, 'aria-label': `Copy ${it.name}`, onclick: () => copyValue(it.value) }, icon('copy', 16))));
      }
    }
    el.append(h('h3', { text: node.op }), kv);
    if (node.fetchXml != null) el.append(h('button', { class: 'link', type: 'button', onclick: () => openFetchOf(tr, r) }, 'Show FetchXML'));
  }
  function copyValue(text) {
    Promise.resolve(io('copyText')(text)).then(ok => toast(ok ? 'Copied 1 value.' : exportModule.COPY_FAILED, { kind: ok ? 'ok' : 'error' }));
  }
  // Opens the FetchXML of a plan node (03 §7: double-click or Enter on a FetchScan; a PartitionedAggregate opens its
  // tier-1 FetchXML, the first of its texts).
  function openFetchOf(tr, r) {
    const items = fetchItems(tr.plans);
    const node = r.node;
    const xml = Array.isArray(node.fetchXml) ? node.fetchXml[0] : node.fetchXml;
    const same = items.filter(x => x.entry === r.entry);
    let it = Number.isInteger(node.fetchIndex) ? same[node.fetchIndex] : null;
    if (!it || it.xml !== xml) it = same.find(x => x.xml === xml) ?? items.find(x => x.xml === xml) ?? null;
    tr.fetchSel = it?.key ?? null;
    // every text of the node is highlighted: a PartitionedAggregate's tier-1 FetchXML and its first partition's
    const texts = Array.isArray(node.fetchXml) ? node.fetchXml : [node.fetchXml];
    const list = it ? (same.includes(it) ? same : items) : [];
    const at = it ? list.indexOf(it) : -1;
    tr.fetchHl = new Set(at >= 0 ? list.slice(at, at + texts.length).filter((x, k) => x.xml === texts[k]).map(x => x.key) : []);
    tr.ui.fetch = null;
    setView('fetchxml');
  }

  // ---- FetchXML (03 §7) -------------------------------------------------------------------------------------------
  function fetchPane(tr) {
    const cache = tr.ui.fetch;
    if (cache && cache.ver === tr.ver && cache.sel === tr.fetchSel) return cache.el;
    const items = fetchItems(tr.plans);
    let el;
    if (!items.length) {
      el = h('div', { class: 'empty' }, h('span', { class: 'ic' }, icon('code', 22)), h('b', null, tr.plans.length ? 'No FetchXML was sent' : 'No FetchXML yet'),
        h('span', null, tr.plans.length ? 'Every part of this query ran in the browser or used other Dataverse requests.' : TEXTS.planEmpty(keyLabel('plan', mac) || 'Ctrl+L')));
    } else {
      el = h('div', { class: 'rs-fx' }, items.map(it => fetchBlock(tr, it)));
      if (tr.fetchSel) {
        const t = el.querySelector?.(`[data-key="${tr.fetchSel}"]`);
        if (t) frame(() => { try { t.scrollIntoView?.({ block: 'start' }); t.focus?.(); } catch { /* not laid out */ } });
      }
    }
    tr.ui.fetch = { ver: tr.ver, el, sel: tr.fetchSel };
    return el;
  }
  function fetchBlock(tr, it) {
    const head = `${it.stmt != null ? `Statement ${fmtInt(it.stmt + 1)} · ` : ''}FetchXML ${fmtInt(it.i + 1)}${it.n > 1 ? ` of ${fmtInt(it.n)}` : ''}`;
    const pretty = prettyXml(it.xml) ?? it.xml;
    const url = webApiUrl(it.xml, meta, location.origin);
    const acts = [
      h('button', { class: 'btn', type: 'button', onclick: () => copyText(it.xml, 'Copied the FetchXML.') }, icon('copy', 20), h('span', { class: 'lbl', text: 'Copy' })),
      h('button', { class: 'btn', type: 'button', disabled: !url, title: url ? undefined : 'The table of this FetchXML is not known, so it has no Web API URL.', onclick: () => copyText(url, 'Copied the Web API URL.') }, icon('link', 20), h('span', { class: 'lbl', text: 'Copy as Web API URL' })),
    ];
    // Save as personal view: a fully server-side SELECT with one FetchScan and its result set (03 §7)
    const entry = it.entry;
    const set = !tr.estimated && entry && Number.isInteger(entry.index) ? tr.sets.find(s => s.index === entry.index) : null;
    if (set && it.n === 1 && wholeServerPlan(entry.plan)) {
      const imp = !!st().impersonating;
      acts.push(h('button', {
        class: 'btn', type: 'button', disabled: imp, title: imp ? TEXTS.saveViewImpersonating : 'Save this query as a personal view in Dataverse',
        onclick: () => { try { dlg('saveAsView')({ entity: fetchEntity(it.xml), fetchXml: it.xml, columns: set.columns.filter(c => !c.hidden) }); } catch (e) { fail(e); } },
      }, icon('save', 20), h('span', { class: 'lbl', text: 'Save as personal view' })));
    }
    return h('section', { class: 'rs-fxi' + (it.key === tr.fetchSel || tr.fetchHl?.has(it.key) ? ' hl' : ''), 'data-key': it.key, tabindex: '-1', 'aria-label': head },
      h('div', { class: 'rs-fxh' }, h('b', null, head), acts),
      h('pre', { class: 'code' }, highlightNodes(pretty, 'xml')));
  }
  function copyText(text, done) {
    if (typeof text !== 'string') return;
    let p;
    try { p = io('copyText')(text); } catch { p = Promise.resolve(false); }
    Promise.resolve(p).then(ok => { toast(ok ? done : exportModule.COPY_FAILED, { kind: ok ? 'ok' : 'error' }); if (ok) announce(done); });
  }

  // ---- Changes (03 §7) ---------------------------------------------------------------------------------------------
  let changesEl = null, changesVer = -1, logVer = 0;
  function changesPane() {
    if (changesEl && changesVer === logVer) return changesEl;
    const log = logOf();
    let list = [];
    try { list = log && typeof log.entries === 'function' ? [...log.entries()] : []; } catch { list = []; }
    if (!list.length) changesEl = h('div', { class: 'empty' }, h('span', { class: 'ic' }, icon('history', 22)), h('b', null, TEXTS.changesEmpty));
    else changesEl = h('div', { class: 'rs-ch', role: 'list', 'aria-label': 'Data changes' }, list.slice().reverse().map(e => changeCard(e)));
    changesVer = logVer;
    return changesEl;
  }
  function changeCard(e) {
    const at = Number.isFinite(e.at) ? e.at : e.at instanceof Date ? e.at.getTime() : null;
    const tabName = e.tabId != null ? tabTitle(e.tabId) : '';
    const meta1 = [at != null ? fmtDate(at, tzNow()) : null, tabName ? `in ${quoteName(tabName)}` : null, e.entity ?? null,
      isBulk(e) || e.op === 'delete' ? (e.backup ? 'Backup downloaded' : 'No backup downloaded') : e.backup ? 'Backup downloaded' : null].filter(Boolean).join(' · ');
    const blocked = undoBlocked(e);
    const running = st().running;
    const undo = h('button', {
      class: 'btn', type: 'button', disabled: !!blocked || !!running,
      title: blocked ?? (running ? runLockTitle(tabTitle(running.tabId)) : 'Undo this change (opens a preview first)'),
      onclick: () => undoEntry(e),
    }, icon('undo', 20), h('span', { class: 'lbl', text: 'Undo' }));
    const dl = h('button', { class: 'btn', type: 'button', onclick: () => downloadLog(e) }, icon('download', 20), h('span', { class: 'lbl', text: 'Download log' }));
    const details = h('details', null, h('summary', null, icon('chevron', 12), 'Details'));
    details.addEventListener('toggle', () => { if (details.open && details.childNodes.length === 1) details.append(changeDetails(e)); });
    return h('section', { class: 'rs-ce', role: 'listitem', 'aria-label': `${changeOpLabel(e)} ${e.entity ?? ''}` },
      h('div', { class: 'rs-ceh' }, h('b', null, `${changeOpLabel(e)}${e.entity ? ` · ${e.entity}` : ''}`)),
      h('div', { class: 'meta', text: meta1 }),
      h('div', { class: 'cnts', text: changeCounts(e) }),
      isBulk(e) ? h('div', { class: 'meta' }, `System ${e.jobs.length === 1 ? 'job' : 'jobs'}: `, e.jobs.map((id, i) => {
        const url = recordUrl('asyncoperation', id, { known: () => true });
        return [i ? ', ' : '', url ? h('button', { class: 'link', type: 'button', style: 'font-size:12px', onclick: () => { try { io('openUrl')(url); } catch (err) { fail(err); } } }, id) : id];
      })) : null,
      blocked && isBulk(e) ? h('div', { class: 'meta', text: blocked }) : null,
      typeof e.statement === 'string' && e.statement ? h('pre', { class: 'code' }, highlightNodes(e.statement, 'sql')) : null,
      h('div', { class: 'acts' }, undo, dl),
      details);
  }
  // The details of a change entry: records with before/after, failed ones with their messages, unknown outcomes.
  function changeDetails(e) {
    const cols = Array.isArray(e.columns) ? e.columns.map(String) : [];
    const rows = [];
    const add = (status, id, before, after, msgText) => rows.push({ status, id, before, after, msg: msgText });
    for (const r of e.ok ?? []) add('ok', r.id, r.before, r.after, '');
    for (const r of e.failed ?? []) add('failed', r.id, null, null, [r.code, r.message].filter(Boolean).join(': '));
    for (const r of e.skipped ?? []) add('skipped', r.id, null, null, r.reason ?? '');
    for (const id of e.unknown ?? []) add('unknown', id, null, null, TEXTS.unknownOutcome);
    for (const id of e.notAttempted ?? []) add('not attempted', id, null, null, '');
    const shown = rows.slice(0, DETAILS_MAX);
    const table = h('table', { class: 'rs-dt' },
      h('thead', null, h('tr', null, h('th', null, 'Status'), h('th', null, 'Record'), cols.map(c => h('th', null, c)), h('th', null, 'Message'))),
      h('tbody', null, shown.map(r => h('tr', null,
        h('td', null, r.status),
        h('td', { class: 'mono' }, String(r.id ?? '')),
        cols.map((_, i) => {
          const b = Array.isArray(r.before) ? logValue(r.before[i]) : null, a = Array.isArray(r.after) ? logValue(r.after[i]) : null;
          if (b == null && a == null) return h('td', null);
          if (b === a) return h('td', { class: 'mono' }, a ?? '');
          return h('td', { class: 'mono' }, h('span', { class: 'old' }, b ?? ''), ' → ', h('span', { class: 'new' }, a ?? ''));
        }),
        h('td', null, r.msg)))));
    return h('div', null, table, rows.length > DETAILS_MAX ? h('div', { class: 'more', text: `The first ${fmtInt(DETAILS_MAX)} of ${fmtInt(rows.length)} records are shown; Download log has all of them.` }) : null);
  }
  function downloadLog(e) {
    const name = changeLogName(e, nowMs(), tzNow());
    const make = () => new Blob([changeLogCsv(e, { neutral: settings().csvNeutralize !== false })], { type: 'text/csv;charset=utf-8' });
    let p;
    try { p = io('saveFile')(name, make, { types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }] }); } catch (err) { fail(err); return; }
    Promise.resolve(p).then(r => {
      if (r?.status === 'saved' || r?.status === 'downloaded') { toast(`Saved the change log ${quoteName(name)}.`, { kind: 'ok' }); return; }
      if (r?.emptied) toast(exportModule.EMPTIED, { kind: 'warn' });
    }, err => fail(err));
  }
  // Undo of a change entry (03 §7): a run of the active tab's session (run lock), with its own preview.
  function undoEntry(e) {
    const tabId = activeId();
    if (!lockFree()) return null;
    const s = sessionOf(tabId);
    if (!s || typeof s.undo !== 'function') { toast(TEXTS.noSession, { kind: 'error' }); return null; }
    let handle;
    try { handle = s.undo(e.id); } catch (err) { fail(err); return null; }
    return drive(tabId, handle, { kind: 'quiet', label: 'Undo' });
  }

  // ---- quick charts (§7.3) ------------------------------------------------------------------------------------------
  const chartSize = el => (typeof opts.chartSize === 'function' ? opts.chartSize(el) : { width: el.clientWidth || 0, height: el.clientHeight || 0 });
  function chartPane(set) {
    const ui = set.ui;
    if (!ui.chart) ui.chart = buildChartUi(set);
    if (ui.chart.dirty) refreshChart(set);
    return ui.chart.el;
  }
  function chartDirty(set) {
    const c = set.ui?.chart;
    if (!c) return;
    c.dirty = true;
    if (set === activeSet() && set.view.display === 'chart') refreshChart(set);
  }
  function destroyChart(ui) {
    const c = ui?.chart;
    if (!c) return;
    ui.chart = null;
    c.token++;
    try { c.ro?.disconnect(); } catch { /* gone */ }
    if (c.drawOff) c.drawOff();
    hideTip(c);
  }
  function buildChartUi(set) {
    const c = { el: null, set, model: null, layout: null, spec: null, hidden: new Set(), cur: null, dirty: true, token: 0, tip: null, tipAnchor: { left: 0, top: 0, width: 1, height: 1 }, svg: null, ro: null, drawOff: null, busy: null };
    // icon-only type buttons (§7.3: icons §1.2), named by aria-label and title, so the chart bar stays on one line
    const typeBtns = new Map(CHART_TYPES.map(t => [t, h('button', { type: 'button', 'aria-pressed': 'false', 'aria-label': CHART_TYPE_LABELS[t], title: `${CHART_TYPE_LABELS[t]} chart`, onclick: () => setSpec(set, { type: t }) }, icon(ic(CHART_ICONS[t], 'chartColumn'), 16))]));
    const typeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Chart type' }, [...typeBtns.values()]);
    const xSel = h('select', { class: 'sel', 'aria-label': 'X', onchange: () => setSpec(set, { x: xSel.value }) });
    const yBtn = h('button', { class: 'btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, h('span', { class: 'lbl', text: 'Y' }), icon('chevron', 16));
    const aggSel = h('select', { class: 'sel', 'aria-label': 'Aggregate', onchange: () => setSpec(set, { agg: aggSel.value }) }, AGGS.map(a => h('option', { value: a }, AGG_LABELS[a])));
    const stackChk = h('input', { type: 'checkbox', onchange: () => setSpec(set, { stacked: stackChk.checked }) });
    const stackLbl = h('label', { class: 'fld' }, stackChk, 'Stacked');
    const orderSel = h('select', { class: 'sel', 'aria-label': 'Order', onchange: () => setSpec(set, { order: orderSel.value }) }, ORDERS.map(o => h('option', { value: o }, ORDER_LABELS[o])));
    const moreBtn2 = h('button', { class: 'btn subtle icon', type: 'button', title: 'Chart image', 'aria-label': 'Chart image', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more', 20));
    const cbar = h('div', { class: 'rs-cbar', role: 'toolbar', 'aria-label': 'Chart settings' },
      typeSeg, h('label', { class: 'fld' }, 'X', xSel), yBtn, h('label', { class: 'fld' }, 'Aggregate', aggSel), stackLbl, h('label', { class: 'fld' }, 'Order', orderSel), moreBtn2);
    const titleEl = h('h3');
    const notesEl = h('div', { class: 'nt', 'aria-live': 'polite' });
    const legendEl = h('div', { class: 'rs-lg', role: 'group', 'aria-label': 'Series' });
    const cv = h('div', { class: 'rs-cv' });
    c.el = h('div', { class: 'rs-chart' }, cbar, h('div', { class: 'rs-chd' }, titleEl, notesEl), legendEl, cv);
    Object.assign(c, { typeBtns, xSel, yBtn, aggSel, stackChk, stackLbl, orderSel, titleEl, notesEl, legendEl, cv });
    yBtn.addEventListener('click', () => {
      if (!shell?.menu || !c.table) return;
      shell.menu(yBtn, () => yItems(set), { label: 'Y' });
    });
    moreBtn2.addEventListener('click', () => {
      if (!shell?.menu) return;
      shell.menu(moreBtn2, [
        { label: 'Copy as image', icon: 'copy', run: () => copyChartImage(set) },
        { label: 'Save as PNG', icon: 'download', run: () => saveChartPng(set) },
        { label: 'Save as SVG', icon: 'download', run: () => saveChartSvg(set) },
      ], { label: 'Chart image', align: 'end' });
    });
    if (typeof globalThis.ResizeObserver === 'function') {
      c.ro = new globalThis.ResizeObserver(() => { if (!c.drawOff) c.drawOff = frame(() => { c.drawOff = null; drawChart(set); }); });
      c.ro.observe(cv);
    }
    return c;
  }
  function yItems(set) {
    const c = set.ui.chart;
    const spec = set.view.chart;
    if (!spec || !c.table) return [];
    const cols = chartColumns(c.table).filter(x => x.kind === 'number' && x.name !== spec.x);
    const items = cols.map(x => {
      const on = spec.ys.includes(x.name);
      const full = !on && spec.ys.length >= MAX_Y;
      return { label: x.name, checked: on, disabled: full, title: full ? TEXTS.chartMaxSeries : undefined, run: () => toggleY(set, x.name) };
    });
    if (spec.agg === 'count') items.push({ label: TEXTS.countOfRows, checked: spec.ys.includes(COUNT_KEY), run: () => toggleY(set, COUNT_KEY) });
    return items.length ? items : [{ label: 'No numeric columns', disabled: true, run: () => {} }];
  }
  function toggleY(set, name) {
    const spec = set.view.chart;
    if (!spec) return;
    let ys = spec.ys.includes(name) ? spec.ys.filter(y => y !== name) : [...spec.ys, name].slice(0, MAX_Y);
    if (!ys.length) { toast(TEXTS.chartOneSeries, { kind: 'info' }); return; }
    if (spec.agg !== 'count') ys = ys.filter(y => y !== COUNT_KEY);
    setSpec(set, { ys });
  }
  // Changes the chart spec (§7.3): an aggregate change keeps the series valid ('Count of rows' only with Count).
  function setSpec(set, patch) {
    if (!set.view.chart || !set.ui?.chart?.table || set.ui.chart.pending) return;
    const spec = { ...set.view.chart, ...patch };
    if (patch.agg) {
      if (patch.agg === 'count' && !spec.ys.length) spec.ys = [COUNT_KEY];
      if (patch.agg !== 'count') { spec.ys = spec.ys.filter(y => y !== COUNT_KEY); if (!spec.ys.length) { const auto = autoChartSpec(set.ui.chart.table); spec.ys = auto.ys.filter(y => y !== COUNT_KEY); if (!spec.ys.length) { spec.agg = 'count'; spec.ys = [COUNT_KEY]; } } }
    }
    if (patch.x && spec.ys.includes(patch.x)) spec.ys = spec.ys.filter(y => y !== patch.x);
    if (!spec.ys.length) { spec.agg = 'count'; spec.ys = [COUNT_KEY]; }
    if (!resolveChart(spec, set.ui.chart.table)) return;
    set.view = { ...set.view, chart: spec };
    set.ui.chart.hidden.clear();
    set.ui.chart.cur = null;
    chartDirty(set);
  }
  // Rebuilds the model from the grid's current view (sliced above 50,000 rows, 03 §13) and redraws.
  function refreshChart(set) {
    const c = set.ui.chart;
    c.dirty = false;
    const table = exportModule.exportTable(set.ui.grid.currentView());
    c.table = table;
    // a stored spec whose columns still exist, else the automatic one (§7.3)
    const stored = set.view.chart && resolveChart(set.view.chart, table) ? chartSpecFor(set.view.chart, table) : null;
    const fmt = { friendly: settings().friendly !== false, tz: tzNow(), dateFormat: dateFormatNow() };
    const my = ++c.token;
    if (table.rows.length > CHART_SLICE_ROWS) {
      // more than 50,000 rows: the automatic spec and the aggregation run in slices with progress (03 §13)
      const t0 = clock();
      let pct = 0;
      const busyOff = timer(() => { if (my === c.token) { c.busy = h('div', { class: 'rs-cbusy', role: 'status' }, h('span', { class: 'spin', style: 'color:var(--brand)' }), ` Preparing the chart… ${pct}%`); setChildren(c.cv, c.busy); } }, PROGRESS_MS);
      c.pending = true;
      (async () => {
        const spec = stored ?? await autoChartSpecSliced(table, { yieldFn, clock });
        if (my !== c.token) return null;
        set.view = { ...set.view, chart: spec };
        return chartModelSliced(spec, table, fmt, { yieldFn, clock, onProgress: x => { pct = Math.floor(x * 100); if (c.busy) c.busy.lastChild.textContent = ` Preparing the chart… ${pct}%`; } });
      })().then(model => {
        busyOff();
        if (my !== c.token) return;
        c.pending = false;
        c.busy = null;
        c.model = model;
        c.ms = clock() - t0;
        renderChartControls(set);
        drawChart(set);
      }, e => { busyOff(); if (my === c.token) { c.pending = false; fail(e); } });
      return;
    }
    c.pending = false;
    const spec = stored ?? autoChartSpec(table);
    set.view = { ...set.view, chart: spec };
    c.model = chartModel(spec, table, fmt);
    renderChartControls(set);
    drawChart(set);
  }
  function renderChartControls(set) {
    const c = set.ui.chart;
    const spec = set.view.chart;
    for (const [t, b] of c.typeBtns) {
      const why = chartTypeBlock(t, spec, c.table, c.model);
      b.disabled = !!why && spec.type !== t;
      b.title = why ?? `${CHART_TYPE_LABELS[t]} chart`;
      b.setAttribute('aria-pressed', spec.type === t ? 'true' : 'false');
    }
    const cols = chartColumns(c.table);
    setChildren(c.xSel, h('option', { value: ROW_KEY }, '# (row number)'), cols.map(x => h('option', { value: x.name }, x.name)));
    c.xSel.value = spec.x;
    c.aggSel.value = spec.agg;
    const canStack = (spec.type === 'column' || spec.type === 'bar') && spec.ys.length >= 2;
    c.stackChk.checked = !!spec.stacked;
    c.stackChk.disabled = !canStack;
    c.stackLbl.title = canStack ? '' : TEXTS.chartStacked;
    const canOrder = spec.type === 'column' || spec.type === 'bar' || spec.type === 'pie';
    c.orderSel.value = spec.order;
    c.orderSel.disabled = !canOrder;
    c.orderSel.title = canOrder ? '' : TEXTS.chartOrder;
    c.yBtn.title = c.model ? c.model.series.map(s => s.label).join(', ') : '';
    c.yBtn.firstChild.textContent = `Y: ${spec.ys.length === 1 ? (spec.ys[0] === COUNT_KEY ? TEXTS.countOfRows : spec.ys[0]) : `${fmtInt(spec.ys.length)} series`}`;
  }
  function drawChart(set) {
    const c = set.ui?.chart;
    if (!c || (!c.model && !c.table) || c.pending) return;
    hideTip(c);
    const model = c.model;
    const notes = model ? model.notes : [];
    c.titleEl.textContent = model ? chartTitle(model, c.hidden) : '';
    setChildren(c.notesEl, notes.map(n => h('div', { text: n })));
    clear(c.legendEl);
    if (model && model.type !== 'pie') {
      for (const s of model.series) {
        const shown = !c.hidden.has(s.key);
        c.legendEl.append(h('button', { type: 'button', 'aria-pressed': shown ? 'true' : 'false', title: shown ? `Hide ${s.label}` : `Show ${s.label}`, onclick: () => toggleSeries(set, s.key) }, h('i', { class: s.cls }), s.label));
      }
    }
    if (!model || !c.table.rows.length) { setChildren(c.cv, h('div', { class: 'empty' }, h('b', null, TEXTS.chartNoRows))); c.svg = null; return; }
    const { width, height } = chartSize(c.cv);
    const lay = chartLayout(model, { width, height, hidden: c.hidden, measure });
    c.layout = lay;
    c.size = { width, height };
    if (!lay.ok) { setChildren(c.cv, h('div', { class: 'empty' }, h('span', null, lay.reason))); c.svg = null; return; }
    const svg = h('svg:svg', { class: 'rs-svg', role: 'img', 'aria-label': chartSummary(model, c.hidden), tabindex: '0', viewBox: `0 0 ${width} ${height}`, width: String(width), height: String(height), focusable: 'true' });
    const plotLayer = h('svg:g');
    for (const p of lay.prims) plotLayer.append(primEl(p));
    const band = h('svg:rect', { class: 'rs-band', x: '0', y: '0', width: '0', height: '0', visibility: 'hidden' });
    const cur = h('svg:circle', { class: 'rs-cur', cx: '0', cy: '0', r: '5', visibility: 'hidden' });
    svg.append(band, plotLayer, cur);
    c.svg = svg; c.band = band; c.curEl = cur;
    svg.addEventListener('pointermove', e => onChartPointer(set, e));
    svg.addEventListener('pointerleave', () => { hideTip(c); band.setAttribute('visibility', 'hidden'); cur.setAttribute('visibility', 'hidden'); });
    svg.addEventListener('keydown', e => onChartKey(set, e));
    svg.addEventListener('blur', () => hideTip(c));
    setChildren(c.cv, svg);
  }
  function primEl(p) {
    if (p.t === 'rect') return h('svg:rect', { x: String(p.x), y: String(p.y), width: String(p.w), height: String(p.h), class: p.cls });
    if (p.t === 'line') return h('svg:line', { x1: String(p.x1), y1: String(p.y1), x2: String(p.x2), y2: String(p.y2), class: p.cls });
    if (p.t === 'circle') return h('svg:circle', { cx: String(p.cx), cy: String(p.cy), r: String(p.r), class: p.cls });
    if (p.t === 'path') return h('svg:path', { d: p.d, class: p.cls });
    const t = h('svg:text', { x: String(p.x), y: String(p.y), class: p.cls, 'text-anchor': p.anchor && p.anchor !== 'start' ? p.anchor : undefined, transform: p.rotate ? `rotate(${p.rotate} ${p.x} ${p.y})` : undefined }, p.text);
    if (p.title) t.append(h('svg:title', null, p.title));
    return t;
  }
  function toggleSeries(set, key) {
    const c = set.ui.chart;
    if (c.hidden.has(key)) c.hidden.delete(key);
    else {
      if (c.model.series.filter(s => !c.hidden.has(s.key)).length <= 1) { toast(TEXTS.chartOneSeries, { kind: 'info' }); return; }
      c.hidden.add(key);
    }
    c.cur = null;
    drawChart(set);
  }
  function hideTip(c) {
    if (c?.tip) { try { c.tip.close(); } catch { /* closed */ } c.tip = null; }
  }
  // The tooltip popover of a chart item (§7.3), near a viewport point.
  function showTip(c, lines, x, y) {
    if (!shell?.popover || !lines.length) { hideTip(c); return; }
    const node = h('div', { class: 'rs-tip' }, h('b', null, lines[0]), lines.slice(1).map(l => h('span', null, l)));
    Object.assign(c.tipAnchor, { left: x + 12, top: y + 12, width: 1, height: 1 });
    if (c.tip && c.tip.el?.isConnected !== false) { setChildren(c.tip.el, node); try { c.tip.reposition(); } catch { /* closed */ } return; }
    try {
      c.tip = shell.popover(c.tipAnchor, node, { role: 'tooltip', label: 'Chart value', onClose: () => { c.tip = null; } });
      c.tip?.el?.classList?.add('rs-tipp');
    } catch { c.tip = null; }
  }
  function svgPoint(svg, e) {
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, r };
  }
  function onChartPointer(set, e) {
    const c = set.ui.chart;
    if (!c?.svg || !c.layout?.ok) return;
    const { x, y } = svgPoint(c.svg, e);
    const hit = chartHit(c.model, c.layout, x, y);
    if (!hit) { hideTip(c); c.band.setAttribute('visibility', 'hidden'); c.curEl.setAttribute('visibility', 'hidden'); return; }
    markChart(c, hit);
    showTip(c, tooltipLines(c.model, hit.c, c.hidden, hit.s), e.clientX, e.clientY);
  }
  // Highlights a category band or a point (hover and keyboard focus).
  function markChart(c, cur) {
    const lay = c.layout;
    const b = lay.bands?.find(x => x.c === cur.c);
    if (b && !c.model.pointAxis && c.model.type !== 'pie') {
      const p = lay.plot;
      if (lay.horizontal) { c.band.setAttribute('x', String(p.x)); c.band.setAttribute('y', String(b.a)); c.band.setAttribute('width', String(p.w)); c.band.setAttribute('height', String(b.b - b.a)); } else { c.band.setAttribute('x', String(b.a)); c.band.setAttribute('y', String(p.y)); c.band.setAttribute('width', String(b.b - b.a)); c.band.setAttribute('height', String(p.h)); }
      c.band.setAttribute('visibility', 'visible');
    } else c.band.setAttribute('visibility', 'hidden');
    const t = lay.targets.find(x => x.c === cur.c && (cur.s == null || x.s === cur.s));
    if (t && (c.model.pointAxis || c.model.type === 'line' || cur.s != null)) { c.curEl.setAttribute('cx', String(t.x)); c.curEl.setAttribute('cy', String(t.y)); c.curEl.setAttribute('visibility', 'visible'); } else c.curEl.setAttribute('visibility', 'hidden');
    return t;
  }
  function onChartKey(set, e) {
    const c = set.ui.chart;
    if (!c?.model || !c.layout?.ok) return;
    const next = chartKey(c.model, c.cur, e.key, c.hidden);
    if (!next) return;
    e.preventDefault();
    c.cur = next;
    const t = markChart(c, next);
    const r = c.svg.getBoundingClientRect();
    showTip(c, tooltipLines(c.model, next.c, c.hidden, next.s), r.left + (t?.x ?? 0), r.top + (t?.y ?? 0));
    announce(chartReadout(c.model, next));
  }
  // The literal colours of the chart tokens in the current theme (Save as SVG / PNG, §7.3).
  function chartColors(c) {
    const out = new Map();
    let cs = null;
    try { cs = globalThis.getComputedStyle ? globalThis.getComputedStyle(c.el) : null; } catch { cs = null; }
    for (const t of ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8', '--chart-grid', '--chart-axis', '--fg1', '--fg2', '--fg3', '--bg1']) {
      const v = cs ? String(cs.getPropertyValue(t) ?? '').trim() : '';
      if (v) out.set(t, v);
    }
    return out;
  }
  function chartExport(set) {
    const c = set.ui?.chart;
    if (!c?.layout?.ok) { toast(c?.layout?.reason ?? TEXTS.chartNoRows, { kind: 'info' }); return null; }
    const colors = chartColors(c);
    const legend = c.model.type === 'pie' ? [] : c.model.series.filter(s => !c.hidden.has(s.key)).map(s => ({ label: s.label, cls: s.cls }));
    const text = chartSvgText(c.layout, { width: c.size.width, height: c.size.height, title: chartTitle(c.model, c.hidden), notes: c.model.notes, legend, colors });
    const head = 14 + 20 + c.model.notes.length * 16 + (legend.length ? 20 : 0);
    return { text, width: c.size.width, height: c.size.height + head, bg: colors.get('--bg1') ?? null, name: safeFileName(set.title || 'Results', 'Results') + '-chart' };
  }
  function saveChartSvg(set) {
    const x = chartExport(set);
    if (!x) return;
    Promise.resolve(io('saveFile')(`${x.name}.svg`, () => new Blob([x.text], { type: 'image/svg+xml' }), { types: [{ description: 'SVG image', accept: { 'image/svg+xml': ['.svg'] } }] }))
      .then(r => { if (r?.status === 'saved' || r?.status === 'downloaded') toast('Saved the chart as SVG.', { kind: 'ok' }); else if (r?.emptied) toast(exportModule.EMPTIED, { kind: 'warn' }); }, fail);
  }
  // PNG of an exported chart: the SVG in an <img> from a Blob URL, drawn at twice its size on the --bg1 background.
  function pngBlob(x) {
    return new Promise((resolve, reject) => {
      let url = null;
      try { url = URL.createObjectURL(new Blob([x.text], { type: 'image/svg+xml' })); } catch (e) { reject(e); return; }
      const done = () => { try { URL.revokeObjectURL(url); } catch { /* gone */ } };
      const blocked = () => { done(); reject(Object.assign(new Error(TEXTS.imagesBlocked), { blocked: true })); };
      let img;
      try {
        img = h('img', {
          src: url, alt: '',
          onload: () => {
            try {
              const canvas = h('canvas', { width: String(x.width * 2), height: String(x.height * 2) });
              const ctx = canvas.getContext('2d');
              ctx.scale(2, 2);
              if (x.bg) { ctx.fillStyle = x.bg; ctx.fillRect(0, 0, x.width, x.height); }
              ctx.drawImage(img, 0, 0, x.width, x.height);
              canvas.toBlob(b => { done(); if (b) resolve(b); else reject(Object.assign(new Error(TEXTS.imagesBlocked), { blocked: true })); }, 'image/png');
            } catch { blocked(); }
          },
          onerror: blocked,
        });
      } catch { blocked(); }
    });
  }
  function saveChartPng(set) {
    const x = chartExport(set);
    if (!x) return;
    Promise.resolve(io('saveFile')(`${x.name}.png`, () => pngBlob(x), { types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }] }))
      .then(r => { if (r?.status === 'saved' || r?.status === 'downloaded') toast('Saved the chart as PNG.', { kind: 'ok' }); else if (r?.emptied) toast(exportModule.EMPTIED, { kind: 'warn' }); },
        e => toast(e?.blocked ? TEXTS.imagesBlocked : errText(e), { kind: 'error' }));
  }
  function copyChartImage(set) {
    const x = chartExport(set);
    if (!x) return;
    let blocked = false;
    const p = pngBlob(x).catch(e => { blocked = !!e?.blocked; throw e; });
    let w;
    try { w = io('copyBlob')(p, 'image/png'); } catch { w = Promise.resolve(false); }
    Promise.resolve(w).then(ok => {
      if (ok) { toast('Copied the chart as an image.', { kind: 'ok' }); announce('Copied the chart as an image.'); } else toast(blocked ? TEXTS.imagesBlocked : exportModule.COPY_FAILED, { kind: 'error' });
    });
  }

  // ---- Export ▾ (03 §7, §7.1) --------------------------------------------------------------------------------------
  function exportItems(set) {
    const tr = trOfSet(set);
    const g = set.ui.grid;
    const view = () => g.currentView();
    const stream = !!set.streaming;
    const st0 = (format, o = {}) => { try { return exportModule.copyState(format, view(), { ...o, streaming: stream }); } catch (e) { return { disabled: true, title: errText(e) }; } };
    const item = (label, iconName, format, run, o) => { const s = st0(format, o); return { label, icon: iconName, disabled: !!s?.disabled, title: s?.title, run }; };
    const ctx = copyCtx(set);
    const file = format => () => exportModule.exportFile(format, view(), { ...ctx, title: set.title || 'Results' });
    const copy = (format, o = {}) => () => exportModule.copyAs(format, view(), ctx, o);
    const active = g.selection()?.active ?? { col: -1 };
    const col = Number.isInteger(active.col) && active.col >= 0 ? active.col : -1;
    const items = [item('Excel (.xlsx)', 'table', 'xlsx', file('xlsx'))];
    if (tr && tr.sets.length >= 2) {
      const any = tr.sets.some(s => s.streaming);
      items.push({ label: 'Excel, all result sets (.xlsx)', icon: 'table', disabled: any, title: any ? STREAMING_TITLE : undefined, run: () => exportModule.exportFile('xlsx', tr.sets.map(s => ensureSetUi(s).grid.currentView()), { ...ctx, title: tabTitle(set.tabId) || 'Results' }) });
    }
    items.push(item('CSV', 'download', 'csv', file('csv')), item('JSON', 'code', 'json', file('json')), item('XML', 'code', 'xml', file('xml')), '-',
      item('Copy as TSV', 'copy', 'tsv', copy('tsv')), item('Copy as text', ic('textView', 'text'), 'text', copy('text')),
      item('Copy as Markdown', 'copy', 'markdown', copy('markdown')), item('Copy as INSERT statements', 'copy', 'insert', copy('insert')),
      item('Copy column as IN list', 'copy', 'inlist', copy('inlist', { col }), { col: col >= 0 ? col : -1 }),
      item('Copy column as FetchXML in condition', 'code', 'fetchin', copy('fetchin', { col }), { col: col >= 0 ? col : -1 }));
    return items;
  }

  // ---- row details sheet (03 §7) --------------------------------------------------------------------------------------
  function openRowDetails(set, info) {
    if (!shell?.sheet || !set.ui?.grid) return;
    const table = exportModule.exportTable(set.ui.grid.currentView());
    const n = table.rows.length;
    if (!n) return;
    let p = Number.isInteger(info?.position) && info.position >= 0 && info.position < n ? info.position : Math.max(0, table.rows.indexOf(info?.row));
    const fmt = { tz: table.fmt.tz ?? tzNow(), dateFormat: table.fmt.dateFormat ?? null, label: table.fmt.label, known: table.fmt.known ?? known };
    const tr = trOfSet(set);
    const label = setLabel(set, tr ? tr.sets.indexOf(set) : 0, tr ? tr.sets.length : 1);
    const pnIdx = (() => {
      const t = set.source?.tables?.[0];
      return set.columns.findIndex(c => !c.hidden && c.attr?.isPrimaryName && (!t || c.attr.entity === t.entity));
    })();
    const parts = () => {
      const row = table.rows[p];
      const list = detailRows(table, row, fmt);
      const body = h('table', { class: 'rs-rd' },
        h('thead', null, h('tr', null, h('th', null, 'Column'), h('th', null, 'Value'), h('th', null, 'Raw value'), h('th', null, h('span', { class: 'sr' }, 'Copy')))),
        h('tbody', null, list.map(r => h('tr', null,
          h('td', { class: 'nm' }, r.name, r.display ? h('span', { class: 'dn', text: r.display }) : null),
          h('td', { class: 'v' }, h('span', { class: 'fc-' + (r.cls || 'text') }, r.cls === 'null' ? 'NULL' : r.friendly)),
          h('td', { class: 'v' }, h('span', { class: 'fc-' + (r.rawCls || 'text') }, r.rawCls === 'null' ? 'NULL' : r.raw)),
          h('td', null, h('button', { class: 'x', type: 'button', title: `Copy ${r.name}`, 'aria-label': `Copy ${r.name}`, onclick: () => copyValue(r.rawCls === 'null' ? '' : r.raw) }, icon('copy', 16)))))));
      const rec = rowRecord(set.source, row);
      const url = rec ? recordUrl(rec.entity, rec.id, { known }) : null;
      const tools = h('div', { style: 'display:flex;gap:8px;align-items:center' }, h('button', {
        class: 'btn', type: 'button', disabled: !url, title: url ? 'Open this record in a new tab' : 'This row has no record to open.', onclick: () => { try { io('openUrl')(url); } catch (e) { fail(e); } },
      }, icon('open', 20), h('span', { class: 'lbl', text: 'Open record' })));
      const name = pnIdx >= 0 ? formatCell(row[pnIdx], set.columns[pnIdx], { ...fmt, friendly: true, row }).text : null;
      return { title: `Row ${fmtInt(p + 1)}`, sub: [label, name].filter(Boolean), pos: `${fmtInt(p + 1)} of ${fmtInt(n)}`, tools, body };
    };
    let sheet = null;
    const move = d => { const q = Math.max(0, Math.min(n - 1, p + d)); if (q === p) return; p = q; sheet?.update(parts()); announce(`Row ${fmtInt(p + 1)} of ${fmtInt(n)}.`); };
    sheet = shell.sheet({ ...parts(), onPrev: () => move(-1), onNext: () => move(1), onClose: () => { sheet = null; } });
  }

  // ---- status bar (03 §7) -------------------------------------------------------------------------------------------
  let caret = null, tabMoves = false;
  function renderStatus() {
    if (!statusHost || destroyed) return;
    const tr = activeTR();
    const s = tr?.status ?? { kind: 'ready', text: TEXTS.ready };
    clear(stLeft);
    statusHost.parentNode?.classList?.toggle?.('amb', s.kind === 'throttle');
    const running = st().running;
    const here = running && running.tabId === activeId();
    const stop = () => h('button', { class: 'rs-stop', type: 'button', onclick: () => { stopRun(); } }, 'Stop');
    if (s.kind === 'running') append(stLeft, [h('span', { class: 'spin', 'aria-hidden': 'true' }), s.text]);
    else if (s.kind === 'progress') append(stLeft, [h('span', { class: 'spin', 'aria-hidden': 'true' }), s.text, here ? [' · ', stop()] : null]);
    else if (s.kind === 'write') append(stLeft, [h('span', { class: 'spin', 'aria-hidden': 'true' }), s.text, s.batches ? h('span', { title: TEXTS.batchesTitle, text: s.batches }) : null, here ? [' · ', stop()] : null]);
    else if (s.kind === 'throttle') append(stLeft, [h('span', { class: 'warn', style: 'display:inline-flex' }, icon('warn', 16)), s.text]);
    else if (s.kind === 'ok') append(stLeft, [h('span', { class: 'ok', text: s.text })]);
    else if (s.kind === 'error') {
      const err = s.err;
      if (err && (Number.isFinite(err.pos) || Array.isArray(err.errors))) {
        const first = Number.isFinite(err.pos) ? err : (err.errors ?? []).find(x => Number.isFinite(x?.pos));
        append(stLeft, [h('button', { class: 'rs-err', type: 'button', title: 'Select the error in the editor', onclick: () => { if (first) goToPos(activeId(), first.pos, first.end ?? first.pos); } }, s.text)]);
      } else append(stLeft, [h('span', { class: 'bad', text: s.text })]);
    } else append(stLeft, [s.text ?? TEXTS.ready]);
    renderStats();
    tabFocusEl.hidden = !tabMoves;
    allowEl.hidden = !st().allowChanges;
    const who = st().impersonating;
    userText.textContent = who ? `Acting as ${who.name || who.id}` : st().user?.name ?? 'Signed-in user';
    userBtn.disabled = !!running;
    userBtn.title = running ? TEXTS.userBusy : 'Act as another user (Execute as) or revert';
    caretEl.hidden = !caret;
    if (caret) caretEl.textContent = `Ln ${fmtInt(caret.line)}, Col ${fmtInt(caret.col)}`;
    renderRequests();
    const tz = tzLabel(tzNow(), meta, nowMs());
    setChildren(tzText, tz.warn ? h('span', { class: 'warn', style: 'display:inline-flex;margin-right:4px' }, icon('warn', 16)) : null, tz.text);
    tzBtn.title = tz.title;
  }
  function renderStats() {
    const set = activeSet();
    const info = set?.ui?.sel;
    const text = info && info.stats ? statsText(info.stats) : '';
    statsEl.hidden = !text;
    statsEl.textContent = text;
  }
  function renderRequests() {
    const n = api?.stats?.requests;
    reqEl.hidden = !Number.isFinite(n);
    if (Number.isFinite(n)) reqEl.textContent = `${fmtInt(n)} ${n === 1 ? 'request' : 'requests'}`;
  }
  let reqOff = null;
  const reqTick = () => { reqOff = timer(() => { renderRequests(); reqTick(); }, 1000); };
  if (statusHost) reqTick();
  userBtn.addEventListener('click', () => {
    if (!shell?.menu) return;
    shell.menu(userBtn, [
      { label: 'Execute as…', icon: 'user', run: () => shell.exec?.('executeAs') },
      { label: 'Revert', icon: 'undo', disabled: !st().impersonating, title: st().impersonating ? undefined : 'You are not acting as another user.', run: () => shell.exec?.('revert') },
    ], { label: 'Acting user' });
  });
  tzBtn.addEventListener('click', () => {
    try { S.setSetting('tz', settings().tz === 'utc' ? 'local' : 'utc'); } catch (e) { fail(e); }
  });

  // ---- Review changes (03 §7.2) -------------------------------------------------------------------------------------
  async function reviewEdits(set, payload) {
    const tabId = set.tabId;
    if (!lockFree()) return undefined;
    const allowed = api && typeof api.mode === 'function' ? !!api.mode()?.allowed : !!st().allowChanges;
    if (!allowed) {
      let ok = false;
      try { ok = await dlg('allowChanges')(); } catch (e) { fail(e); return undefined; }
      if (!ok || !lockFree()) return undefined;
    }
    const s = sessionOf(tabId);
    if (!s || typeof s.runEdits !== 'function') { toast(TEXTS.noSession, { kind: 'error' }); return undefined; }
    let handle;
    try { handle = s.runEdits(payload); } catch (e) { fail(e); return undefined; }
    const r = await drive(tabId, handle, { kind: 'edits', label: 'Review changes' });
    return Array.isArray(r.edits) ? { results: r.edits } : undefined;
  }

  // ---- the run controller (03 §7) -------------------------------------------------------------------------------------
  // Runs the active (or given) tab's text: the selection, the statement at the caret or everything (sliceRun).
  async function runTab(tabId, mode = 'all', o = {}) {
    if (destroyed) return;
    const id = tabId ?? activeId();
    const tab = st().tabs.find(t => t.id === id);
    if (!tab || !lockFree()) return;
    const tr = trOf(id);
    const pending = tr.sets.reduce((n, s) => n + (s.pending || 0), 0);
    if (pending > 0) {
      const ok = shell?.confirm ? await shell.confirm({ title: discardTitle(pending), body: 'Grid edits that have not been written to Dataverse are lost when the query runs again.', ok: 'Discard', cancel: 'Keep editing', danger: true }) : false;
      if (!ok || !lockFree()) return;
      for (const s of tr.sets) if (s.pending && s.ui?.grid) s.ui.grid.discardEdits();
    }
    const useEditor = !!editor && isActive(id);
    const text = useEditor ? editor.getValue() : String(tab.sql ?? '');
    const sel = useEditor ? editor.getSelection() : { start: tab.caret?.[0] ?? 0, end: tab.caret?.[1] ?? 0 };
    const qi = sessionOf(id)?.opts?.quotedIdentifier !== false;
    const slice = sliceRun(text, sel, mode === 'statement' ? 'statement' : 'all', pos => (useEditor && typeof editor.statementAt === 'function' ? editor.statementAt(pos) : statementAtText(text, pos, qi)));
    if (!slice) { status(TEXTS.nothingToRun); return; }
    return runText(id, slice, { ...o, runText: text });
  }
  // Runs a sliced text in a tab's session (one run under the lock).
  async function runText(tabId, slice, o = {}) {
    if (!lockFree()) return;
    const s = sessionOf(tabId);
    if (!s || typeof s.run !== 'function') { toast(TEXTS.noSession, { kind: 'error' }); return; }
    const ctl = new AbortController();
    const runOpts = { signal: ctl.signal, offset: slice.offset ?? 0 };
    if (slice.fullText != null) runOpts.fullText = slice.fullText;
    if (Number.isFinite(o.maxRows)) runOpts.maxRows = o.maxRows;
    let handle;
    try { handle = s.run(slice.sql, runOpts); } catch (e) { fail(e); return; }
    await drive(tabId, handle, { kind: 'run', ctl, mode: slice.mode, sql: slice.sql, offset: slice.offset ?? 0, fullText: slice.fullText ?? null, maxRows: o.maxRows, runText: o.runText ?? (editor && isActive(tabId) ? editor.getValue() : null) });
  }
  // A run of SQL in the active tab's session that does not replace its results (03 §1.4: Count rows, Drop table).
  async function runQuiet(sql) {
    const tabId = activeId();
    if (st().running) throw new Error(runLockTitle(tabTitle(st().running.tabId)));
    const s = sessionOf(tabId);
    if (!s || typeof s.run !== 'function') throw new Error(TEXTS.noSession);
    const ctl = new AbortController();
    const handle = s.run(String(sql ?? ''), { signal: ctl.signal, offset: 0 });
    const r = await drive(tabId, handle, { kind: 'quiet', ctl });
    return { sets: r.sets, messages: r.messages, ok: r.ok };
  }
  // A RunHandle that is not a query run (03 §1.4: Load CSV, Load file as text, Execute as): run lock, progress, status
  // and pill; its messages go to the tab's Messages; the result sets and the active view stay.
  async function attachQuiet(tabId, handle, o = {}) {
    const r = await drive(tabId ?? activeId(), handle, { kind: 'quiet', label: o.label ?? null, abort: o.abort });
    return { ok: r.ok, messages: r.messages };
  }
  // Maps a RunHandle's events into the tab's TabResults (02 §9, 03 §7).
  function attachRun(tabId, handle, o = {}) {
    return drive(tabId ?? activeId(), handle, { kind: 'run', mode: o.mode ?? 'all', sql: o.sql ?? '', offset: o.offset ?? 0, fullText: o.fullText ?? null, maxRows: o.maxRows, abort: o.abort, runText: o.runText ?? null });
  }
  // Stop (03 §7): a read stops at once; a write asks first and stops after its current batch. Every open or waiting
  // confirmation is cancelled as Cancel (dialogs.cancelPending).
  async function stopRun() {
    const r = st().running;
    const run = active && r && active.tabId === r.tabId ? active : null;
    if (r?.write) {
      const w = run?.write;
      const ok = shell?.confirm ? await shell.confirm({ title: TEXTS.stopWrite(w?.done ?? 0, w?.total ?? 0), ok: 'Stop', cancel: 'Keep writing', danger: true }) : true;
      if (!ok) return false;
    }
    try { dlg('cancelPending')(); } catch { /* dialogs not initialised */ }
    if (!r) return false;
    if (run?.ctl) run.ctl.abort();
    else if (run?.abort) { try { run.abort(); } catch (e) { fail(e); } }
    return true;
  }

  // ---- estimated plan, Convert ▸ and the toolbar hint (03 §5, §7) -------------------------------------------------------
  // Ctrl+L and Convert ▸ Show FetchXML (03 §5): explain of the selection or everything into the Plan / FetchXML view.
  async function estimatedPlan(view) {
    const tabId = activeId();
    if (!tabId || !editor) return;
    const text = editor.getValue();
    const sel = editor.getSelection();
    const selected = sel.end > sel.start && !blank(text.slice(sel.start, sel.end));
    const sql = selected ? text.slice(sel.start, sel.end) : text;
    if (blank(sql)) { status(TEXTS.nothingToRun); return; }
    const s = sessionOf(tabId);
    if (!s || typeof s.explain !== 'function') { toast(TEXTS.noSession, { kind: 'error' }); return; }
    const clearStatus = (() => { try { return shell?.status?.('Reading the estimated plan…', { ms: 0 }) ?? null; } catch { return null; } })();
    let res;
    try { res = await s.explain(sql, { offset: selected ? sel.start : 0 }); } catch (e) { if (typeof clearStatus === 'function') clearStatus(); fail(e); return; } finally { if (typeof clearStatus === 'function') clearStatus(); }
    const tr = trOf(tabId);
    tr.plans = (Array.isArray(res) ? res : []).filter(e => isObj(e) && (e.plan || e.error)).map(e => ({ ...e, estimated: true, ms: null }));
    tr.fetchXml = tr.plans.flatMap(e => (Array.isArray(e.fetchXml) ? e.fetchXml : []).map(xml => ({ index: e.index, xml })));
    tr.estimated = true;
    tr.fetchSel = null;
    tr.ver++;
    tr.activeView = view;
    if (isActive(tabId)) renderAll();
    announce(tr.plans.length ? `Estimated plan of ${plural(tr.plans.length, 'statement')}.` : 'There is no plan for this text.');
  }
  let explainCache = null;
  // The text Convert ▸ works on: the selection, else the statement at the caret, else everything.
  function convertTarget() {
    const tabId = activeId();
    if (!editor || !tabId) return null;
    const text = editor.getValue();
    const sel = editor.getSelection();
    if (sel.end > sel.start && !blank(text.slice(sel.start, sel.end))) return { tabId, sql: text.slice(sel.start, sel.end), offset: sel.start };
    const r = typeof editor.statementAt === 'function' ? editor.statementAt(sel.start) : null;
    if (r && !blank(text.slice(r.start, r.end))) return { tabId, sql: text.slice(r.start, r.end), offset: r.start };
    return blank(text) ? null : { tabId, sql: text, offset: 0 };
  }
  // Refreshes the explain behind Copy as FetchXML / Web API URL when the Convert menu opens (busy while pending).
  function refreshConvert() {
    const t = convertTarget();
    if (!t) { explainCache = { key: null, result: { ok: false, title: TEXTS.nothingToRun } }; return; }
    const key = `${t.tabId}\u0000${t.offset}\u0000${t.sql}`;
    if (explainCache?.key === key && !explainCache.failed) return;
    const s = sessionOf(t.tabId);
    if (!s || typeof s.explain !== 'function') { explainCache = { key, result: { ok: false, title: TEXTS.noSession } }; return; }
    const c = explainCache = { key, pending: true, result: null };
    Promise.resolve().then(() => s.explain(t.sql, { offset: t.offset })).then(res => {
      if (explainCache !== c) return;
      c.pending = false;
      c.result = convertState(res, meta, location.origin);
      try { shell?.refresh?.(); } catch { /* idem */ }
    }, e => {
      if (explainCache !== c) return;
      c.pending = false;
      c.failed = true;
      c.result = { ok: false, title: errText(e) };
      try { shell?.refresh?.(); } catch { /* idem */ }
    });
  }
  const convertCmdState = () => {
    if (!explainCache) return { disabled: true, title: 'Open the Convert menu to read the plan of this query.' };
    if (explainCache.pending) return { disabled: true, busy: true, title: TEXTS.explainPending };
    const r = explainCache.result;
    return r?.ok ? {} : { disabled: true, title: r?.title ?? TEXTS.partlyInBrowser };
  };
  const stillCurrent = () => { const t = convertTarget(); return !!t && explainCache?.key === `${t.tabId}\u0000${t.offset}\u0000${t.sql}`; };
  function copyConverted(kind) {
    const r = explainCache?.result;
    if (!r?.ok || !stillCurrent()) { toast('The query changed. Open the Convert menu again.', { kind: 'info' }); return false; }
    if (kind === 'url' && !r.url) { toast('The table of this query has no Web API entity set.', { kind: 'error' }); return false; }
    copyText(kind === 'url' ? r.url : r.xml, kind === 'url' ? 'Copied the Web API URL.' : 'Copied the FetchXML.');
    return true;
  }
  let hintOff = null, hintToken = 0;
  // The editor's text changed (main.js: editor onChange): the explain-driven hint and 'plan' markers follow 1 s later.
  function textChanged() {
    explainCache = null;
    if (hintOff) hintOff();
    hintOff = timer(() => { hintOff = null; updateHint(); }, EXPLAIN_IDLE);
  }
  function setHint(kind) {
    if (!kind) { hintEl.hidden = true; clear(hintEl); return; }
    hintEl.hidden = false;
    setChildren(hintEl, icon(kind === 'all' ? 'bolt' : 'monitor', 16), kind === 'all' ? TEXTS.runsOnDataverse : TEXTS.partly);
    hintEl.title = kind === 'all' ? 'Every statement runs on Dataverse (estimated plan).' : 'Some work runs in the browser (estimated plan). See the amber underlines and Ctrl+L.';
  }
  function planMarkers(list) {
    if (!editor || typeof editor.setMarkers !== 'function') return;
    try { editor.setMarkers(list, 'plan'); } catch { /* editor errors are its own */ }
  }
  async function updateHint() {
    const tabId = activeId();
    if (!editor || !tabId) return;
    const text = editor.getValue();
    const my = ++hintToken;
    if (blank(text)) { setHint(null); planMarkers([]); return; }
    let ranges = [];
    try { ranges = statementRanges(text, { quotedIdentifier: sessionOf(tabId)?.opts?.quotedIdentifier !== false }); } catch { ranges = []; }
    if (ranges.length > EXPLAIN_MAX_STATEMENTS) { setHint(null); planMarkers([]); return; }
    const tables = referencedTables(text);
    if (!tables || !meta || typeof meta.entitySync !== 'function' || tables.some(t => { try { return !meta.entitySync(t); } catch { return true; } })) { setHint(null); return; }
    const s = sessionOf(tabId);
    if (!s || typeof s.explain !== 'function') return;
    let res;
    try { res = await s.explain(text, { offset: 0 }); } catch { if (my === hintToken) setHint(null); return; }
    if (my !== hintToken || destroyed || !isActive(tabId) || editor.getValue() !== text) return;
    const list = (Array.isArray(res) ? res : []).filter(e => isObj(e) && e.plan && (e.kind === 'select' || e.kind === 'dml'));
    setHint(list.length ? (list.every(e => e.server === 'all') ? 'all' : 'partial') : null);
    const marks = [];
    for (const e of Array.isArray(res) ? res : []) for (const w of Array.isArray(e?.warnings) ? e.warnings : []) {
      if (isObj(w) && Number.isFinite(w.pos)) marks.push({ start: w.pos, end: Number.isFinite(w.end) ? w.end : w.pos, level: 'warn', message: String(w.text ?? '') });
    }
    planMarkers(marks);
  }

  // ---- commands, Escape, bus ------------------------------------------------------------------------------------------
  if (shell && typeof shell.command === 'function') {
    keep(shell.command('run', { run: () => runTab(activeId(), 'all') }));
    keep(shell.command('runStatement', { run: () => runTab(activeId(), 'statement') }));
    keep(shell.command('stop', { run: () => { stopRun(); }, state: () => ({ hidden: !st().running || st().running.tabId !== activeId() }) }));
    keep(shell.command('plan', { run: () => estimatedPlan('plan') }));
    keep(shell.command('showFetchXml', { run: () => estimatedPlan('fetchxml') }));
    keep(shell.command('copyFetchXml', { run: () => copyConverted('xml'), state: convertCmdState }));
    keep(shell.command('copyWebApiUrl', { run: () => copyConverted('url'), state: convertCmdState }));
    keep(shell.command('convertMenu', { onOpen: refreshConvert }));
  }
  if (shell && typeof shell.onEscape === 'function') {
    keep(shell.onEscape('stop', () => {
      const r = st().running;
      if (!r || r.write) return false;
      stopRun();
      return true;
    }));
  }
  const onBus = (type, fn) => keep(S.on(type, p => { if (!destroyed) fn(p ?? {}); }));
  onBus('tab:changed', () => {
    explainCache = null;
    renderAll();
    timer(() => applyMarkers(activeId()), 0);
    textChanged();
  });
  onBus('tab:list', () => {
    const ids2 = new Set(st().tabs.map(t => t.id));
    for (const [id, tr] of [...st().results]) {
      if (ids2.has(id)) continue;
      for (const s of tr.sets) destroySetUi(s);
      st().results.delete(id);
    }
    renderAll();
  });
  onBus('settings', p => {
    const keys = Array.isArray(p.keys) ? p.keys : null;
    const touches = k => !keys || keys.includes(k);
    if (['friendly', 'tz', 'compact', 'gridFontSize', 'localDates', 'csvNeutralize'].some(touches)) {
      const o = gridOptions();
      for (const tr of st().results.values()) {
        for (const s of tr.sets) {
          if (!s.ui) continue;
          s.ui.grid.setOptions(o);
          if (s.ui.text) { s.ui.text.update({ fontSize: o.fontSize }); syncText(s, true); }
          if (s.ui.chart) s.ui.chart.dirty = true;
        }
      }
      const a = activeSet();
      if (a?.ui?.chart && a.view.display === 'chart') refreshChart(a);
    }
    renderAll();
  });
  onBus('theme', () => { const a = activeSet(); if (a?.ui?.chart && a.view.display === 'chart') drawChart(a); });
  onBus('changes:mode', () => { logVer++; renderAll(); });
  onBus('impersonate', () => { logVer++; renderAll(); });
  onBus('meta:loaded', () => renderStatus());
  onBus('run:start', () => { logVer++; renderStatus(); if (activeTR()?.activeView === 'changes') renderBody(); });
  onBus('run:end', () => { logVer++; renderStatus(); if (activeTR()?.activeView === 'changes') renderBody(); });
  onBus('layout', () => renderTabs());
  onBus('history', () => { if (activeTR() && currentView(activeTR()) === 'empty') renderBody(); });
  let logSub = null, logSubOff = null;
  function ensureLogSub() {
    const log = logOf();
    if (log === logSub) return;
    if (logSubOff) { try { logSubOff(); } catch { /* gone */ } }
    logSub = log;
    logSubOff = null;
    if (log && typeof log.on === 'function') {
      try { logSubOff = log.on('change', () => { if (destroyed) return; logVer++; renderTabs(); if (activeTR()?.activeView === 'changes') renderBody(); }); } catch { logSubOff = null; }
    }
  }
  keep(() => { if (logSubOff) logSubOff(); });

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const f of offs.splice(0)) { try { f(); } catch { /* gone */ } }
    if (soonOff) soonOff();
    for (const t of [...timers]) t();
    timers.clear();
    if (reqOff) reqOff();
    for (const tr of st().results.values()) for (const s of tr.sets) destroySetUi(s);
    root.remove();
    stLeft.remove();
    stRight.remove();
    hintEl.remove();
    if (current === results) current = null;
  }

  const results = {
    el: root,
    ERROR_HINTS,
    runTab, runQuiet, attachQuiet, attachRun, stopRun,
    // Shows a tab's results (the active tab's; another tab is activated first).
    show(tabId) { if (tabId != null && !isActive(tabId) && st().tabs.some(t => t.id === tabId)) S.setActiveTab(tabId); else renderAll(); },
    // The editor caret for the status bar (main.js from the editor's onCaret).
    setCaret(c) { caret = isObj(c) && Number.isFinite(c.line) && Number.isFinite(c.col) ? { line: c.line, col: c.col } : null; renderStatus(); },
    // 'Tab moves focus' in the status bar (main.js from the tabFocus command).
    setTabMovesFocus(on) { tabMoves = !!on; renderStatus(); },
    textChanged,
    tabResults: tabId => st().results.get(tabId) ?? null,
    refresh: () => renderAll(),
    destroy,
    // inspection hooks
    _hint: () => updateHint(),
    _convert: () => explainCache,
    _set: () => activeSet(),
    _review: (set, payload) => reviewEdits(set, payload),
    _plan: view => estimatedPlan(view),
    _rowDetails: (set, info) => openRowDetails(set, info),
    _export: set => exportItems(set),
  };
  current = results;
  renderAll();
  return results;
}

// The results area of the last createResults() (dialogs.js and explorer.js look up ERROR_HINTS and runQuiet on the
// instance they are given; this is for inspection).
export const lastResults = () => current;
