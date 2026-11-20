// SQL Studio code editor (03 §1.4, §5, §9).
// A native <textarea> (caret, selection, IME, clipboard, drag and drop and undo stay the browser's own) sits between
// a decoration layer (current line, find matches, bracket pair) and a <pre> of highlighted spans (tokens, markers,
// invisible characters); a sticky gutter numbers the lines. Gutter, layers and textarea share one scroller, so no
// layer ever lags behind another while scrolling. Only the visible lines ± 60 are rendered, highlighting is per
// line (tokenizeLine with the state carried from line to line) with a line cache, and every edit goes through
// document.execCommand('insertText'), so native undo keeps working. The logic lives in the pure, exported helpers
// below; createEditor() is the thin DOM part.
//
// Notes (extensions of 03 §1.4 / §5 / §13):
// - Dependencies beyond 03 §1.4: the editor imports state.js itself (createEditor takes no state) and uses only its
//   03 §2 contract: state.layout.find with save('layout') for the find bar's toggles, and SETTINGS (§8.1:
//   editorFont's pattern and default); from shell.js only quoteName (03 §3, a name in a toast). It relies on
//   parser.js's extensions labelChecks: false and the result's `labels` / `gotos` (with `pos`, `end`
//   and `scopes`), and on SqlError `errors[]` / `suggestions` (01 §2).
// - The host's duty: Escape reaches the find and go-to bars only through the shell's cascade, so main.js registers
//   shell.onEscape('find', () => editor.closeFind()) (03 §9 step 10); the bars' own Escape handler covers an editor
//   mounted without a shell.
// - createEditor(host, opts) also takes `quotedIdentifier` (default true) and the editor has setQuotedIdentifier(on)
//   and quotedIdentifier(): the active tab's Session.opts.quotedIdentifier (02 §9). main.js sets it when a tab
//   becomes active and after every run of that tab (SET QUOTED_IDENTIFIER takes effect from the next batch). While
//   it is false a `"…"` token is t-str (one piece, quotes included), contextAt() says 'string' inside it, and the
//   parse diagnostics, statementAt(), Format and Add display names parse in that mode (its invisible characters are
//   not warned, as parse() reads it). The pure helpers take the mode as an option: classifyTokens(tokens, isTable,
//   ctx, range, {quotedIdentifier, line, inQuote}) (telling `"…"` from `[…]` needs the line's text and its start
//   state's quote), contextAt(tokens, col, inState, {quotedIdentifier, line}), highlightSql(text, {isTable,
//   quotedIdentifier}), diagnose(text, {quotedIdentifier}), diagnoseScript(text, cache, {quotedIdentifier}),
//   diagnoseUnits(text, batches, {…, quotedIdentifier}), invisibleMarkers(text, {quotedIdentifier}) and
//   invisibleIn(…, tokensOf, {quotedIdentifier}). Only the `"…"` token's own class depends on the mode: a FOR XML /
//   FOR JSON clause argument may be a string or a quoted-identifier token (`PATH("row"), TYPE`), so the clause words
//   after it are t-kw in both modes.
// - onFile(file, kind) (03 §1.4) is called once per dropped .sql/.txt or other file, and once per drop for all its
//   .csv/.tsv files together, with an Array of those Files as `file` and kind 'csv' (dropCalls(files), exported), so
//   main.js opens one Load CSV dialog with dialogs.loadCsv(files) (several files).
// - goToLine(n) returns a boolean: a number goes to that line (clamped to the text), a string is read as the go-to
//   bar reads it (`n`, `n:col`, `n,col`; goToTarget(n, lineCount), exported); anything else, or a string that names
//   no line, moves nothing and returns false. goToLine() opens the bar and returns true.
// - format() -> boolean: above 2,000 lines true only says that the deferred run started (or is already waiting: a
//   second call changes nothing); formatDone() -> Promise<boolean> gives the outcome of the latest format() call
//   (false when an error, the refusal, a text change or destroy() left the text unformatted; true before any call).
// - Find (03 §5): F3 / Shift+F3 with the bar closed open it with its last query and options, focus staying in the
//   editor, and select the next / previous match at once (after the sliced search above 1 MB); without a query yet
//   they open the bar for one, as Mod+F does.
// - The formatter is called as `formatter(src, {state, quotedIdentifier, displayNames?})` (03 §1.4 names only
//   {state}); format.js formatSqlReport takes both options (01 §1). keptPlaces(src, out, kept) (exported) says where
//   each kept statement is in the output, so its 'parse' markers move there at once.
// - editorFontFamily(value) (exported) validates editorFont with the SETTINGS pattern and, where the platform has it,
//   CSS.supports('font-family', …) (a list the browser would drop would leave the editor in the proportional UI
//   font), and appends `, monospace` unless the list already ends in it; an invalid value keeps the previous one. The
//   family is set as `--ed-font-family` on the editor's root, so it reaches the text layers, the mirror, the
//   cell-width probe and the gutter (`font-family: var(--ed-font-family)`), not the rest of the tool. Settings refuses
//   a font that is not monospaced (03 §5); the editor checks it too (ten i's and ten W's in its probe, once per new
//   font; while the editor is not laid out the check waits for the first exact cell measurement) and, for a stored or
//   synced value that is not, uses the default stack and says so once ('The editor font is not monospaced; the
//   editor uses the default font instead.', warn toast).
// - Hover (03 §1.4, §5): main.js creates the editor with hoverTips: false and complete.js with hoverText: true, so a
//   marked name shows one card (complete.js's, with editor.hoverText() and markersAt() in its 'Problems' group).
//   settings.hoverCards turns off the hover cards of §5 (complete.js's), not the Diagnostics tooltip, which the
//   editor shows whenever hoverTips is not false (03 §5 Diagnostics). With hoverTips false and
//   hoverCards off no mouse surface shows a marker's message (complete.js opens no mouse card then); the gutter
//   tooltips, Ctrl+K Ctrl+I and hoverText() keep the text either way. hoverText(offset)
//   gives each marker message once and also names an invisible character right after the offset (the caret of Ctrl+K
//   Ctrl+I before it), unless a message there names it already.
// - workState() is an inspection hook like diagState(): the work so far, {lexed, relexed, built, measured} in
//   lines and classified in tokens, so the work per keystroke can be checked without timing it (03 §13 gives
//   the time budgets).
// - addDisplayNames() (03 §5): it works on the statement at the caret (statementAt) or on every top-level
//   statement the selection touches, their range widened over the blanks before and after them on their lines, so
//   other statements on those lines stay as they are. A first formatter pass with a callback that returns null names
//   the tables the labels need (format.js calls it for every candidate, 01 §1); 'Loading metadata…' shows while any
//   of them is not cached (meta.entitySync); then the formatter runs with `displayNames(table, column, {schema})` ->
//   `<attribute displayName> (<table displayName, else its logical name>)` for tables written without a schema or
//   under dbo, archive or bin, else null: displayNameLabels(entities) (exported), which turns
//   `settings.format.displayNames: true` into that callback, so the rule exists once. Without a selection the caret stays at its token (mapFormatted, exported:
//   across the added `AS [label]` pairs), with one the new range is selected, as Format does. Status texts besides
//   the 03 §5 one (opts.status, else a toast): 'There is no statement here to add display names to.', "Display names
//   need the tables' metadata, which is not available.", 'Display names were not added: the statement does not
//   parse.' (displayNamesNotice, exported) and 'No display names were added: no column without an alias has one.';
//   success is announced ('Display names were added.'). A table that does not exist (208) is skipped silently; any
//   other load failure is an error toast ("Couldn't load the metadata of “contact”: …", the name through shell.js
//   quoteName, 03 §3); a text or mode change while it loads cancels it ('The text changed; Add display names was
//   cancelled.'). A second call while one runs returns the same promise. Format's own notice covers the 'case' and
//   'unformatted' pieces.
// - Diagnostics (03 §5): an error's did-you-mean (`suggestions`, e.g. 10715 for a misspelt hint) is appended to
//   its marker message (` Did you mean 'a' or 'b'?`, unless the message already says it); errorMarkers(err, {level,
//   offset, length}) (exported) does this for any SqlError, so results.js can mark a run's multi-error failure the
//   same way. The warnings kept before a syntax error inside a failing region are those of its statements before a
//   cut point (cutPoints(src, limit), exported: a statement keyword at depth 0, nearest first, at most 8 tried) whose
//   text, closed with `PRINT 1` and the ENDs of the blocks open there, parses; a warning inside the failing statement
//   itself is not kept. GOTO and labels: regions are parsed with labelChecks false and the editor resolves them
//   over the whole batch as parse() does: the second definition of a label raises 132 at it (a failing region that
//   has a ':' is parsed once more with label checks after the batch's earlier labels, so a repeated label before its
//   syntax error wins as in parse()), and once the batch parsed its first GOTO to a missing label raises 133, one
//   into a TRY or CATCH it is not in 1026; a GOTO to a label in another region is fine. The messages come from
//   engine/messages.js.
// - Highlighting additions (03 §5): the words of a FOR XML / FOR JSON clause (RAW, AUTO, EXPLICIT, PATH, BINARY
//   BASE64, TYPE, ROOT, ELEMENTS, XSINIL, ABSENT, XMLDATA, XMLSCHEMA, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER) are
//   t-kw when walking back over the clause reaches `FOR XML` / `FOR JSON`, and XML after FOR is t-kw; elsewhere
//   they follow the usual rules (`SELECT type, path FROM t`). An xml method name after '.' and before '(' (value,
//   query, exist, nodes, modify; any case, as the parser) is t-fn. The name after `FETCH [NEXT|PRIOR|FIRST|LAST|
//   ABSOLUTE n|RELATIVE n] FROM` is a cursor, never t-tbl. The words of the 'option' hint names of parser.js
//   HINTS (MAXDOP, RECOMPILE, HASH of HASH JOIN, CONCAT of CONCAT UNION, …) and the USE HINT names, which OPTION (…)
//   accepts bare (NO_DIRECT_DML, BATCH_SIZE_50, FETCHXML_PAGE_SIZE_10; 01 §4.1 Hints), are t-kw right inside
//   `OPTION (…)`, and UNKNOWN right inside its `OPTIMIZE FOR (…)`, as SSMS shows them; a misspelt hint stays t-id. The
//   cursor options that are not in KEYWORDS (DYNAMIC, KEYSET, SCROLL_LOCKS, OPTIMISTIC, TYPE_WARNING, which parse()
//   refuses) are t-kw between CURSOR and FOR. Elsewhere these words follow the usual rules. A label (`name:`)
//   and the name after GOTO are t-id even when they spell a contextual keyword, and a single ':' is t-punc. A
//   word after SET that is followed by ON or OFF is t-kw (`SET QUOTED_IDENTIFIER OFF`).
// - Geometry (03 §5 first bullet): offsetAt/coordsAt use client rects on every rendered line with a character beyond
//   tab, ASCII and Latin-1 (fallback fonts, joining marks, right-to-left runs and C0/C1 controls do not fill exactly
//   their cells; measured in Edge 155), not only on lines with emoji or CJK. U+2028, U+2029, U+0085, U+000B and U+000C
//   do not break a line in Edge 155 (textarea and div, white-space pre and pre-wrap), so they need no row of their own.
// - Keystroke work (03 §13): a render reads the selection once (each selectionStart / selectionEnd read makes
//   Chromium map the selection into the textarea's text: about 0.15 ms at 2 MB), skips the defensive value read when
//   an input event has already synced the model, writes aria-invalid only when it changes, and calls onCaret last, so
//   the host's status-bar write never forces a layout inside the render. Measured on 2026-10-15
//   (Chromium 152, shell, completion and status bar) with 20,000 lines of about 94 characters (1.9 MB): the input
//   handlers (the editor's and complete.js's) take 1-2 ms and the render about 1 ms (p90 1.7 ms; 1.7 ms with word
//   wrap), within the 8 ms of the editor's own work; Chromium's own insertText takes 6-16 ms.
// - tokenAt(offset, bias) of 03 §1.4 returns the lexer token with absolute s/e, its 0-based `line` and the line's
//   start state (complete.js).

import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { state, save, SETTINGS } from './state.js';
import { quoteName } from './shell.js';
import { tokenize, tokenizeLine, LINE0, KEYWORDS, RESERVED } from '../engine/lexer.js';
import { parse, statementRanges, HINTS } from '../engine/parser.js';
import { msg } from '../engine/messages.js';
import { formatSql, formatSqlReport } from '../engine/format.js';
import { TYPE_NAMES } from '../engine/types.js';
import { FUNCTION_NAMES } from '../engine/functions.js';
import { META_TABLES } from '../engine/metatables.js';
import { debounce, fmtInt, uid, yieldToUi } from '../core/util.js';

// ---------------------------------------------------------------------------------------------------- constants

const TAB = 4;
const INDENT = '    ';
const MARGIN = 60;              // lines rendered above and below the visible ones (03 §5)
const FIND_CAP = 10000;         // counting stops here (03 §5)
const BIG = 1024 * 1024;        // above 1 MB of text, find and wrap measurement run in slices (03 §13)
const SLICE_MS = 8;
const PROGRESS_MS = 300;
const PARSE_MS = 300;
const FIND_MS = 150;
const HOVER_MS = 500;           // pointer rest before a hover tooltip (03 §5, as the hover cards)
const LEAVE_MS = 300;           // a hover tooltip closes this long after the pointer leaves it and its place
const RESIZE_MS = 100;
const PAREN_LINES = 2000;       // bracket matching looks at most this many lines away
const PAD_T = 4, PAD_L = 8, PAD_R = 16, GUT_PAD = 30;
const WIDTH_STEP = 32;          // columns: the unwrapped content width grows in these steps
const LONG_LINE = 4000;         // longer lines are re-lexed from the edit and highlighted only around the view
const LONG_BLOCK = 2048;        // the highlighted window of a long line moves in steps of this many characters
const LOW_CHUNK = 65536;        // a literal case-insensitive search lower-cases the text in chunks of this size
const SEEK_WINDOW = 65536;      // capped Previous scans backwards in windows starting at this size
const LONG_MARKER = 1024;       // markers longer than this are kept apart when markers are assigned to lines
const CTX_TOKENS = 256;         // highlighting looks at most this many significant tokens back across lines
const CTX_LINES = 200;          // ... and at most this many lines back
const GUIDE_LEVELS = 24;        // indent guides are drawn for at most this many levels
const GUIDE_SCAN = 100;         // a blank line takes its guides from a non-blank line at most this far away
const FORMAT_BUSY_LINES = 2000; // Format above this many lines shows a busy status first and announces the result
const FORMAT_INSIDE = 'The selection starts inside a string or comment; select whole statements to format.';
const STATUS_MS = 6000;         // how long a status-bar message of a command stays (Add display names)
// U+00AD, U+061C, U+200B-200F, U+202A-202E, U+2066-2069 and U+FEFF (01 §4.5, 03 §5), written as escapes (no raw bidi
// characters here).
const INVISIBLE_RE = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const INVISIBLE_1 = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const WORD_RE = /[\p{L}\p{M}\p{Nd}_@#$]/u;
// ':' ends a label (`retry:`), the only use of a single colon in T-SQL; '::' stays an operator.
const PUNC = new Set([',', ';', '(', ')', '.', ':']);
const CLOSERS = new Map([['(', ')'], ['[', ']'], ["'", "'"], ['"', '"']]);
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);
// KEYMAP keys of the find bar's buttons when no opts.shortcut is given ([Windows, macOS]); Esc closes the bar through
// the Escape cascade (03 §9 step 10), not a KEYMAP binding, so its title always names it.
const DEFAULT_KEYS = new Map([['findNext', ['F3', 'F3']], ['findPrev', ['Shift+F3', 'Shift+F3']], ['replace', ['Ctrl+H', 'Cmd+Option+F']]]);
const CASCADE_KEYS = new Map([['closeFind', 'Esc']]);
let metaNames = null;           // lower-case metadata.* table names, built on first use

// ------------------------------------------------------------------------------------------------ text helpers

// Start offset of every line of text (split at '\n').
export function lineStarts(text) {
  const out = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(i + 1);
  return out;
}

// Index of the line containing offset `off`, given lineStarts().
export function lineIndexAt(starts, off) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const lineStartOf = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1;
const lineEndOf = (text, pos) => { const i = text.indexOf('\n', pos); return i < 0 ? text.length : i; };

// The changed region between two texts: old [start, oldEnd) became new [start, newEnd). A pure insertion or
// deletion inside repeated characters fits several places; `hint` ({start} where the edit began, or {end} where a
// backward deletion ended, in old offsets) moves it there (typing 'a' before 'ab' is an insertion at 0, not 1).
export function textDiff(a, b, hint = null) {
  const n = Math.min(a.length, b.length);
  const CH = 512;
  let p = 0;
  while (p + CH <= n && a.slice(p, p + CH) === b.slice(p, p + CH)) p += CH;
  while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  const max = n - p;
  let s = 0;
  while (s + CH <= max && a.slice(a.length - s - CH, a.length - s) === b.slice(b.length - s - CH, b.length - s)) s += CH;
  while (s < max && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  let start = p, oldEnd = a.length - s, newEnd = b.length - s;
  if (hint && (oldEnd === start || newEnd === start)) {
    const ins = oldEnd === start;
    const t = ins ? b : a;
    const further = () => (hint.start != null ? start > hint.start : oldEnd > hint.end);
    while (start > 0 && further() && t.charCodeAt(start - 1) === t.charCodeAt((ins ? newEnd : oldEnd) - 1)) { start--; oldEnd--; newEnd--; }
  }
  return { start, oldEnd, newEnd };
}

// Ranges {start, end, …} moved through an edit (old [start, oldEnd) -> new [start, newEnd)); ranges it touches are dropped.
export function shiftRanges(list, start, oldEnd, newEnd) {
  const d = newEnd - oldEnd;
  const out = [];
  for (const r of list) {
    if (r.end < start || (r.end === start && (r.start < start || start === oldEnd))) out.push(r);
    else if (r.start >= oldEnd && !(r.start === start && r.end === start && start < oldEnd)) out.push(d ? { ...r, start: r.start + d, end: r.end + d } : r);
  }
  return out;
}

// Sorted, non-overlapping, non-empty ranges (find matches) moved through an edit in place, by the rules of
// shiftRanges but without copies: the touched ones are cut out, the later ones move. Returns the same array.
export function shiftSorted(list, start, oldEnd, newEnd) {
  const d = newEnd - oldEnd;
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].end <= start) lo = mid + 1; else hi = mid; }
  let j = lo;
  while (j < list.length && list[j].start < oldEnd) j++;
  if (j > lo) list.splice(lo, j - lo);
  if (d) for (let k = lo; k < list.length; k++) { list[k].start += d; list[k].end += d; }
  return list;
}

// Offsets moved through an edit; offsets inside the replaced text are dropped.
export function shiftPoints(list, start, oldEnd, newEnd) {
  const out = [];
  for (const p of list) {
    if (p < start) out.push(p);
    else if (p >= oldEnd) out.push(p + newEnd - oldEnd);
  }
  return out;
}

// Characters that take no cell of their own: nonspacing and enclosing marks (they join the character before them:
// Thai U+0E31, Devanagari, Hebrew points, Arabic harakat, U+0300-036F, variation selectors) and format characters
// (U+200B-200F, U+202A-202E, U+2060-206F, U+FEFF, U+061C, tags), except the prepended concatenation marks, which Edge
// draws (U+0600-0605, U+06DD, U+070F, U+0890-0891, U+08E2, U+110BD, U+110CD; measured in Edge 155).
const ZERO_COLS_RE = /[\p{Mn}\p{Me}\p{Cf}]/u;
const prependedMark = cp => (cp >= 0x600 && cp <= 0x605) || cp === 0x6DD || cp === 0x70F || cp === 0x890 || cp === 0x891 || cp === 0x8E2 ||
  cp === 0x110BD || cp === 0x110CD;
let bmpCols = null;             // charCols of the BMP code points seen so far (0: not yet known, else width + 1)

// Width of one code point computed from the Unicode categories and the East Asian wide ranges (see charCols).
function colsOf(cp) {
  if (ZERO_COLS_RE.test(String.fromCodePoint(cp)) && !prependedMark(cp)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x303E) || (cp >= 0x3041 && cp <= 0x33FF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xA000 && cp <= 0xA4CF) ||
    (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) ||
    (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1F64F) ||
    (cp >= 0x1F900 && cp <= 0x1F9FF) || (cp >= 0x20000 && cp <= 0x3FFFD)) return 2;
  return 1;
}

// Display width in monospace cells of one code point: 0 for marks that join the character before them and for
// invisible format characters (\p{Mn}, \p{Me}, \p{Cf} but the prepended concatenation marks; U+00AD and U+000C, which
// Edge draws with no width), 2 for East Asian wide/fullwidth characters and emoji, else 1. Rendered lines with
// characters beyond Latin-1 are measured in the DOM instead (domLine), so this only has to be close for the others.
export function charCols(cp) {
  if (cp < 0x300) return cp === 0xAD || cp === 0x0C ? 0 : 1;
  if (cp > 0xFFFF) return colsOf(cp);
  const t = bmpCols || (bmpCols = new Uint8Array(0x10000));
  let v = t[cp];
  if (!v) v = t[cp] = colsOf(cp) + 1;
  return v - 1;
}

// Code point at i and its length in UTF-16 units (a lone surrogate counts as itself).
function cpAt(s, i) {
  const c = s.charCodeAt(i);
  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xDC00 && d <= 0xDFFF) return [(c - 0xD800) * 0x400 + d - 0xDC00 + 0x10000, 2];
  }
  return [c, 1];
}

// Column reached after text[from, to) starting at column `col` (tab stops every 4 columns).
export function advance(text, from, to, col = 0) {
  for (let i = from; i < to;) {
    const c = text.charCodeAt(i);
    if (c === 9) { col += TAB - (col % TAB); i++; continue; }
    if (c < 0x300) { if (c !== 0xAD && c !== 0x0C) col++; i++; continue; }
    const [cp, len] = cpAt(text, i);
    col += charCols(cp);
    i += len;
  }
  return col;
}

// Row start offsets of one line wrapped at `cols` columns (CSS pre-wrap + overflow-wrap:anywhere): a row breaks
// after whitespace, whitespace hangs at the row end, and a word longer than a row is broken where it overflows.
export function wrapRows(line, cols) {
  const rows = [0];
  if (!(cols >= 1) || !line) return rows;
  let col = 0, rowStart = 0, brk = -1;
  for (let i = 0; i < line.length;) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9 || c === 0x200B) {
      col = c === 9 ? col + TAB - (col % TAB) : c === 32 ? col + 1 : col;
      i++;
      brk = i;
      continue;
    }
    const [cp, len] = cpAt(line, i);
    const w = c < 0x300 ? (c === 0xAD || c === 0x0C ? 0 : 1) : charCols(cp);
    if (w && col + w > cols && i > rowStart) {
      if (brk > rowStart && brk <= i) {
        rowStart = brk;
        rows.push(brk);
        col = advance(line, brk, i);
        if (col + w > cols && i > rowStart) { rowStart = i; rows.push(i); col = 0; }
      } else {
        rowStart = i;
        rows.push(i);
        col = 0;
      }
      brk = -1;
    }
    col += w;
    i += len;
  }
  return rows;
}

// Caret offset in `b` that keeps the caret after the same number of non-whitespace characters as `pos` in `a`.
export function mapCaret(a, b, pos) {
  let n = 0;
  for (let i = 0; i < pos && i < a.length; i++) if (a.charCodeAt(i) > 32) n++;
  let i = 0;
  for (; i < b.length && n > 0; i++) if (b.charCodeAt(i) > 32) n--;
  return i;
}

// 'sql' for .sql/.txt, 'csv' for .csv/.tsv, else null (a file dropped on the editor, 03 §5).
export function fileKind(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : '';
  return ext === 'sql' || ext === 'txt' ? 'sql' : ext === 'csv' || ext === 'tsv' ? 'csv' : null;
}

// The onFile calls [file, kind] for the files of one drop, in drop order (03 §5): one per .sql/.txt or other file, and
// one for all the .csv/.tsv files together, as an array at the place of the first one, so they open one Load CSV
// dialog (several files load into one #temp table).
export function dropCalls(files) {
  const out = [];
  let csv = null;
  for (const f of files || []) {
    if (!f) continue;
    const kind = fileKind(f.name);
    if (kind !== 'csv') { out.push([f, kind]); continue; }
    if (!csv) out.push([csv = [], 'csv']);
    csv.push(f);
  }
  return out;
}

// Go-to-line input `n` or `n:col` (also `n,col`) -> {line, col} (1-based), or null when it is not a line of the text.
export function parseGoTo(input, lineCount) {
  const m = /^\s*(\d{1,9})\s*(?:[:,]\s*(\d{1,9})\s*)?$/.exec(String(input ?? ''));
  if (!m) return null;
  const line = Number(m[1]);
  if (line < 1 || line > lineCount) return null;
  return { line, col: m[2] ? Math.max(1, Number(m[2])) : 1 };
}

// Target {line, col} of editor.goToLine(n) (03 §1.4): a finite number is that line, clamped to the text; a string is
// read as the go-to bar reads it (parseGoTo: `n`, `n:col`, `n,col`); anything else, or a string that names no line of
// the text, is null.
export function goToTarget(n, lineCount) {
  if (typeof n === 'number') return Number.isFinite(n) ? { line: Math.max(1, Math.min(lineCount, Math.floor(n))), col: 1 } : null;
  return typeof n === 'string' ? parseGoTo(n, lineCount) : null;
}

// ------------------------------------------------------------------------------------------ highlighting helpers

const stEq = (a, b) => a.cmt === b.cmt && a.quote === b.quote;
const isWordCp = cp => cp != null && WORD_RE.test(String.fromCodePoint(cp));
const cpBefore = (s, i) => {
  if (i <= 0) return null;
  const c = s.charCodeAt(i - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && i >= 2) {
    const d = s.charCodeAt(i - 2);
    if (d >= 0xD800 && d <= 0xDBFF) return s.codePointAt(i - 2);
  }
  return c;
};

// True when the code point before offset i of s is an identifier character (letter, digit, _, @, # or $).
export function isWordBefore(s, i) { return isWordCp(cpBefore(s, i)); }

// GO-line kind of one line's tokens, exactly as parser.js splits batches (01 §4.5): 0 = not a GO line; 1 = `GO`
// first on its line (only whitespace before it), optionally a count (digits only) and then only comments; 2 = the
// same, but the line ends inside a block comment opened after GO, so it is a GO line only when that comment closes
// with nothing but whitespace and comments after it (goTailClean).
export function goLineKind(tokens) {
  const n = tokens.length;
  let k = 0;
  while (k < n && tokens[k].t === 'ws') k++;
  if (k >= n || tokens[k].t !== 'id' || tokens[k].k !== 'GO') return 0;
  for (k++; k < n && tokens[k].t === 'ws'; k++);
  if (k < n && tokens[k].t === 'num') {
    const c = tokens[k];
    if (c.int !== true || !/^\d+$/.test(String(c.raw ?? ''))) return 0;
    k++;
  }
  for (; k < n; k++) {
    const t = tokens[k];
    if (t.t === 'ws') continue;
    if (t.t !== 'cmt') return 0;
    if (t.open) return 2;
  }
  return 1;
}

// True when the line's tokens make it a batch separator (01 §4.5, see goLineKind); `tail` (a boolean, or a function
// asked only when needed) says whether a block comment that the line ends in closes cleanly (goTailClean).
export function isGoLine(tokens, tail = true) {
  const k = goLineKind(tokens);
  return k === 1 || (k === 2 && !!(typeof tail === 'function' ? tail() : tail));
}

// Whether the block comment a GO line ends in closes with only whitespace and comments after it on its closing line
// (the GO line is then a batch separator, as parser.js decides): getTokens(i) gives line i's tokens, `from` is the
// line after the GO line. The end of the text counts as clean; so does a comment still open after `max` lines.
export function goTailClean(getTokens, from, lineCount, max = PAREN_LINES) {
  for (let i = from, n = 0; i < lineCount && n < max; i++, n++) {
    const ts = getTokens(i);
    for (const t of ts) if (t.t !== 'ws' && t.t !== 'cmt') return false;
    const last = ts[ts.length - 1];
    if (!(last && last.t === 'cmt' && last.open)) return true;
  }
  return true;
}

// Unqualified names are known tables (t-tbl) only in table positions: after these keywords, after a ',' of a FROM
// list, or as the qualifier of a name (`account.name`).
const TABLE_KW = new Set(['FROM', 'JOIN', 'APPLY', 'INTO', 'UPDATE', 'TABLE', 'DELETE']);
const LIST_KW = new Set(['FROM', 'JOIN', 'APPLY']);
const LIST_NEUTRAL = new Set(['AS', 'ON', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'ESCAPE', 'COLLATE', 'INNER', 'LEFT',
  'RIGHT', 'FULL', 'OUTER', 'CROSS', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'EXISTS', 'SOME', 'ANY', 'ALL']);
// Keywords that, at parenthesis depth 0, end the look-back for the '(' a type name stands in: a CAST / TRY_CAST
// argument or a column-definition list never holds them outside nested parentheses.
const CAST_STOP = new Set(['SELECT', 'FROM', 'WHERE', 'HAVING', 'DECLARE', 'INSERT', 'UPDATE', 'DELETE', 'VALUES', 'SET', 'IF', 'WHILE',
  'BEGIN', 'RETURN', 'PRINT', 'EXEC', 'EXECUTE', 'UNION', 'EXCEPT', 'INTERSECT', 'INTO', 'JOIN', 'ON']);
const DEF_STOP = new Set([...CAST_STOP, 'GROUP', 'ORDER', 'END', 'CASE', 'WHEN', 'THEN', 'ELSE', 'AND', 'OR']);
// A contextual keyword (KEYWORDS, not RESERVED) is a name (01 §3: `SELECT zone FROM t`) between one of these and
// one of the next set; never these option words, which only appear inside option and hint lists.
const NAME_PREV = new Set(['SELECT', 'DISTINCT', 'WHERE', 'AND', 'OR', 'NOT', 'ON', 'BY', 'SET', 'WHEN', 'THEN', 'ELSE', 'AS', 'HAVING']);
const NAME_NEXT = new Set(['FROM', 'AS', 'AND', 'OR', 'IS', 'IN', 'LIKE', 'BETWEEN', 'THEN', 'WHEN', 'ELSE', 'END', 'WHERE', 'GROUP', 'ORDER',
  'HAVING', 'ASC', 'DESC', 'NOT', 'INTO', 'UNION', 'EXCEPT', 'INTERSECT', 'COLLATE']);
const OPTION_WORDS = new Set(['GO', 'NOLOCK', 'MAXRECURSION', 'INCLUDE_NULL_VALUES', 'WITHOUT_ARRAY_WRAPPER', 'ROOT', 'JSON', 'CALLER', 'LOGIN', 'THROW']);
// The words of a FOR XML / FOR JSON clause (01 §4.2): keywords there, names elsewhere (`SELECT type FROM t`).
const FOR_WORDS = new Set(['RAW', 'AUTO', 'EXPLICIT', 'PATH', 'BINARY', 'BASE64', 'TYPE', 'ROOT', 'ELEMENTS', 'XSINIL', 'ABSENT', 'XMLDATA',
  'XMLSCHEMA', 'INCLUDE_NULL_VALUES', 'WITHOUT_ARRAY_WRAPPER']);
// xml data type methods (01 §4.4): `x.value(` is a call (t-fn), `t.value` a column.
const XML_METHODS = new Set(['VALUE', 'QUERY', 'EXIST', 'NODES', 'MODIFY']);
// FETCH directions that may stand right before FROM and a cursor name (01 §4.1 Cursors).
const FETCH_BEFORE_FROM = new Set(['FETCH', 'NEXT', 'PRIOR', 'FIRST', 'LAST']);
// The options of `DECLARE c CURSOR <options> FOR` (01 §4.1 Cursors), incl. the ones parse() refuses (DYNAMIC,
// KEYSET, SCROLL_LOCKS, OPTIMISTIC, TYPE_WARNING: keywords that are not in KEYWORDS, so a name elsewhere).
const CURSOR_OPTS = new Set(['LOCAL', 'GLOBAL', 'FORWARD_ONLY', 'SCROLL', 'STATIC', 'KEYSET', 'DYNAMIC', 'FAST_FORWARD', 'READ_ONLY',
  'SCROLL_LOCKS', 'OPTIMISTIC', 'TYPE_WARNING']);
// Keywords that, outside nested parentheses, end the look-back for the `OPTION (` a query hint stands in; the words
// of the hint names themselves (HASH JOIN, CONCAT UNION, ORDER GROUP, OPTIMIZE FOR, USE HINT, TABLE HINT) are not here.
const OPTION_STOP = new Set(['SELECT', 'FROM', 'WHERE', 'HAVING', 'DECLARE', 'INSERT', 'UPDATE', 'DELETE', 'VALUES', 'SET', 'IF', 'WHILE',
  'BEGIN', 'RETURN', 'PRINT', 'EXEC', 'EXECUTE', 'INTO', 'ON', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'OPTION']);
let hintWords = null;           // the words of the OPTION (…) hint names of parser.js HINTS, built on first use
// The USE HINT names written with a number (01 §4.1 Hints: BATCH_SIZE_n, FETCHXML_PAGE_SIZE_n), as parse() reads them.
const NUMBERED_HINT_RE = /^(?:BATCH_SIZE|FETCHXML_PAGE_SIZE)_\d+$/;
// True when an upper-case word is a word of an OPTION (…) query hint name (`MAXDOP`, `HASH` of `HASH JOIN`) or a USE
// HINT name, which OPTION (…) also accepts bare (`NO_DIRECT_DML`, `BATCH_SIZE_50`; 01 §4.1 Hints).
function isHintWord(k) {
  if (!hintWords) {
    hintWords = new Set();
    for (const h of HINTS) {
      if (h.kind === 'option') for (const w of h.name.split(' ')) hintWords.add(w);
      else if (h.kind === 'useHint' && !h.name.endsWith('_n')) hintWords.add(h.name);
    }
  }
  return hintWords.has(k) || NUMBERED_HINT_RE.test(k);
}
// Names whose identity (not only their being a name) a highlighting decision about another line can depend on: every
// word that classifyName and its look-backs compare a token of an earlier line with, unless it is a keyword, whose
// identity depSig keeps anyway. A word missing here would let the line cache keep a stale class when it is renamed.
const DEP_NAMES = new Set([...TABLE_KW, ...LIST_KW, ...LIST_NEUTRAL, ...CAST_STOP, ...DEF_STOP, ...NAME_PREV, ...FOR_WORDS,
  ...FETCH_BEFORE_FROM, ...CURSOR_OPTS, ...OPTION_STOP, 'OPTION', 'OPTIMIZE', 'FOR', 'XML', 'JSON', 'ABSOLUTE', 'RELATIVE', 'CONVERT',
  'TRY_CONVERT', 'CAST', 'TRY_CAST', 'AS', 'TABLE', 'WITH', 'CURSOR', 'GOTO', 'SET', 'AT', 'METADATA', 'ARCHIVE', 'BIN', 'DBO']
  .filter(w => !KEYWORDS.has(w)));
const isSig = t => t.t !== 'ws' && t.t !== 'cmt';
const isOp = (t, v) => !!t && t.t === 'op' && t.v === v;

// Significant tokens before index i of a line, nearest first, continuing on earlier lines through ctx.back(k) (the
// k-th significant token before the line's start, null past the start of the text or the look-back limit).
function* sigBefore(tokens, i, ctx) {
  for (let j = i - 1; j >= 0; j--) if (isSig(tokens[j])) yield tokens[j];
  if (!ctx || typeof ctx.back !== 'function') return;
  for (let k = 0; ; k++) {
    const t = ctx.back(k);
    if (!t) return;
    yield t;
  }
}

// The n-th significant token before index i (n = 1: the nearest), on this line or earlier ones; null when none.
function sigPrev(tokens, i, ctx, n = 1) {
  for (let j = i - 1; j >= 0; j--) if (isSig(tokens[j]) && --n === 0) return tokens[j];
  return ctx && typeof ctx.back === 'function' ? ctx.back(n - 1) : null;
}

// True when a ',' (at index i, or the nearest significant token of earlier lines when i < 0) separates the items of a
// FROM list: walking back over balanced parentheses, FROM / JOIN / APPLY comes before any other clause keyword, an
// unmatched '(' or ';'.
function inFromList(tokens, i, ctx) {
  let depth = 0, n = 0, skip = i < 0 ? 1 : 0;
  for (const t of sigBefore(tokens, i < 0 ? 0 : i, ctx)) {
    if (skip) { skip--; continue; }
    if (++n > CTX_TOKENS) return false;
    if (t.t === 'op') {
      if (t.v === ')') depth++;
      else if (t.v === '(') { if (!depth) return false; depth--; }
      else if (t.v === ';' && !depth) return false;
      continue;
    }
    if (depth || t.t !== 'id') continue;
    if (LIST_KW.has(t.k)) return true;
    if (RESERVED.has(t.k) && !LIST_NEUTRAL.has(t.k)) return false;
  }
  return false;
}

// True when the qid token at index i of a line is written in double quotes ("…", not […]): `line` is the line's
// text and `inQuote` its start state's quote (a token continued from the line above has no opening delimiter).
function doubleQuoted(t, i, line, inQuote) {
  if (t.t !== 'qid' || typeof line !== 'string') return false;
  if (i === 0 && t.s === 0 && inQuote && inQuote !== "'") return inQuote === '"';
  return line.charCodeAt(t.s) === 34;
}

// Class of each token of one line (03 §5): t-kw, t-fn, t-type, t-var, t-str, t-num (also `0x…` binary literals),
// t-cmt, t-op, t-punc, t-id, t-lit and t-tbl (isTable(name, qualifier) says a name is a known table; an
// unqualified one only in a table position); null for whitespace and unknown characters. `ctx` ({back(k), tail()},
// optional) reaches the tokens of earlier lines and the GO-comment tail of later ones; it is asked only when a
// decision needs it. `range` [from, to) limits the work to those token indexes (a long line highlighted around the
// view); the rest stay null. opts.quotedIdentifier false (SET QUOTED_IDENTIFIER OFF) classes a `"…"` token
// t-str; telling `"…"` from `[…]` needs opts.line (the line's text) and opts.inQuote (its start state's quote).
export function classifyTokens(tokens, isTable = null, ctx = null, range = null, opts = null) {
  const n = tokens.length;
  const out = new Array(n).fill(null);
  const from = range ? Math.max(0, range[0]) : 0, to = range ? Math.min(n, range[1]) : n;
  const qiOff = !!opts && opts.quotedIdentifier === false;
  let go = null;
  const goLine = () => (go === null ? (go = isGoLine(tokens, () => !ctx || typeof ctx.tail !== 'function' || ctx.tail())) : go);
  const tbl = (name, qual) => !!(isTable && isTable(name, qual));
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    switch (t.t) {
      case 'cmt': out[i] = 't-cmt'; break;
      case 'str': out[i] = 't-str'; break;
      case 'num': out[i] = 't-num'; break;
      case 'var': out[i] = 't-var'; break;
      case 'op': out[i] = PUNC.has(t.v) ? 't-punc' : 't-op'; break;
      case 'qid':
        out[i] = qiOff && doubleQuoted(t, i, opts.line, opts.inQuote) ? 't-str' : classifyName(tokens, i, ctx, goLine, tbl);
        break;
      case 'id': out[i] = classifyName(tokens, i, ctx, goLine, tbl); break;
      default: break;
    }
  }
  return out;
}

// True when the FOR XML / FOR JSON word at index i of a line stands in such a clause (01 §4.2): walking back over
// the clause's own tokens (its words, ',' and the `('name')` arguments) reaches XML or JSON right after FOR. The
// argument may be a quoted-identifier token: with QUOTED_IDENTIFIER OFF `PATH("row")` is `PATH('row')` (01 §4.1),
// and since only the `"…"` token's own class depends on the mode (03 §5), the words after it read the same in both.
function inForClause(tokens, i, ctx) {
  let arg = 0;   // inside a `('name')` argument, walking back: 1 after its ')', 2 after its string
  let n = 0;
  for (const t of sigBefore(tokens, i, ctx)) {
    if (++n > 64) return false;
    if (arg === 1) { if (t.t !== 'str' && t.t !== 'qid') return false; arg = 2; continue; }
    if (arg === 2) { if (!isOp(t, '(')) return false; arg = 0; continue; }
    if (isOp(t, ')')) { arg = 1; continue; }
    if (isOp(t, ',')) continue;
    if (t.t !== 'id') return false;
    if (t.k === 'XML' || t.k === 'JSON') {
      const f = sigPrev(tokens, i, ctx, n + 1);
      return !!f && f.t === 'id' && f.k === 'FOR';
    }
    if (!FOR_WORDS.has(t.k)) return false;
  }
  return false;
}

// True when the name at index i (prev: the FROM before it) is the cursor of `FETCH [NEXT|PRIOR|FIRST|LAST|ABSOLUTE n|
// RELATIVE n] FROM name` (01 §4.1 Cursors), not a table.
function fetchCursor(tokens, i, ctx) {
  const p2 = sigPrev(tokens, i, ctx, 2);
  if (!p2) return false;
  if (p2.t === 'id' && FETCH_BEFORE_FROM.has(p2.k)) {
    if (p2.k === 'FETCH') return true;
    const p3 = sigPrev(tokens, i, ctx, 3);
    return !!p3 && p3.t === 'id' && p3.k === 'FETCH';
  }
  if (p2.t !== 'num' && p2.t !== 'var') return false;
  let k = 3;
  let p = sigPrev(tokens, i, ctx, k);
  if (isOp(p, '-') || isOp(p, '+')) p = sigPrev(tokens, i, ctx, ++k);
  if (!(p && p.t === 'id' && (p.k === 'ABSOLUTE' || p.k === 'RELATIVE'))) return false;
  const f = sigPrev(tokens, i, ctx, k + 1);
  return !!f && f.t === 'id' && f.k === 'FETCH';
}

// Where the word at index i stands: 'option' right inside the parentheses of `OPTION (…)` (a query hint list, 01 §4.1
// Hints), 'optimize' right inside those of its `OPTIMIZE FOR (@p UNKNOWN)`, else null (also in another nested `(…)`
// such as USE HINT ('…')).
function optionListAt(tokens, i, ctx) {
  const op = openerBefore(tokens, i, ctx, 0, OPTION_STOP, 2);
  if (!op || !op.length || op[0].t !== 'id') return null;
  if (op[0].k === 'OPTION') return 'option';
  return op[0].k === 'FOR' && !!op[1] && op[1].t === 'id' && op[1].k === 'OPTIMIZE' ? 'optimize' : null;
}

// True when the word at index i is one of the options of `DECLARE c [INSENSITIVE] [SCROLL] CURSOR <options> FOR`:
// walking back over cursor options reaches CURSOR (01 §4.1 Cursors).
function inCursorOptions(tokens, i, ctx) {
  let n = 0;
  for (const t of sigBefore(tokens, i, ctx)) {
    if (++n > CURSOR_OPTS.size + 1 || t.t !== 'id') return false;
    if (t.k === 'CURSOR') return true;
    if (!CURSOR_OPTS.has(t.k)) return false;
  }
  return false;
}

// Next significant token after index i on the line, or null.
function sigNext(tokens, i) {
  for (let j = i + 1; j < tokens.length; j++) if (isSig(tokens[j])) return tokens[j];
  return null;
}

// Class of one identifier or quoted identifier (see classifyTokens).
function classifyName(tokens, i, ctx, goLine, tbl) {
  const t = tokens[i];
  const prev = sigPrev(tokens, i, ctx);
  const next = sigNext(tokens, i);
  if (isOp(prev, '.')) {
    if (t.t === 'id' && XML_METHODS.has(t.k) && isOp(next, '(')) return 't-fn';   // @x.value('…', 'int')
    const q = sigPrev(tokens, i, ctx, 2);
    return tbl(t.v, q && (q.t === 'id' || q.t === 'qid') ? q.v : '') ? 't-tbl' : 't-id';
  }
  const unqualified = () => (tbl(t.v, null) && tablePosition(tokens, i, prev, next, ctx) ? 't-tbl' : 't-id');
  if (t.t === 'qid') return unqualified();
  const key = t.k;
  if (key === 'GO') return goLine() ? 't-kw' : unqualified();
  const prevK = prev && prev.t === 'id' ? prev.k : null;
  // A label: `name:` defines it and `GOTO name` jumps to it; a contextual keyword there is a name.
  if (!RESERVED.has(key) && (isOp(next, ':') || prevK === 'GOTO')) return 't-id';
  if (key === 'TRUE' || key === 'FALSE') return 't-lit';
  if (FOR_WORDS.has(key) && inForClause(tokens, i, ctx)) return 't-kw';   // FOR XML PATH(''), TYPE
  if (key === 'XML' && prevK === 'FOR') return 't-kw';
  if (!RESERVED.has(key)) {
    // A query hint (`OPTION (MAXDOP 4, RECOMPILE, HASH JOIN, NO_DIRECT_DML)`, the option and USE HINT names of
    // parser.js HINTS), UNKNOWN in `OPTIMIZE FOR (@p UNKNOWN)` and a cursor option (`CURSOR DYNAMIC`, refused by
    // parse() but a keyword) are keywords there, names elsewhere.
    if (isHintWord(key)) {
      const where = optionListAt(tokens, i, ctx);
      if (where === 'option' || (where === 'optimize' && key === 'UNKNOWN')) return 't-kw';
    }
    if (CURSOR_OPTS.has(key) && !KEYWORDS.has(key) && inCursorOptions(tokens, i, ctx)) return 't-kw';
  }
  // A SET option switched ON or OFF (`SET QUOTED_IDENTIFIER OFF`, `SET XACT_ABORT ON`) is a keyword.
  if (prevK === 'SET' && next && next.t === 'id' && (next.k === 'ON' || next.k === 'OFF')) return 't-kw';
  const call = isOp(next, '(');
  if (key === 'MAX' && isOp(prev, '(') && isOp(next, ')')) {
    // The length of nvarchar(max) / varchar(max) is part of the data type.
    const ty = sigPrev(tokens, i, ctx, 2);
    if (ty && ty.t === 'id' && TYPE_NAMES.has(ty.k.toLowerCase())) return 't-type';
  }
  if (TYPE_NAMES.has(key.toLowerCase())) {
    if (key === 'TIME' && prevK === 'AT') return 't-kw';
    if (typePosition(tokens, i, prev, ctx)) return 't-type';
    if (call) return FUNCTION_NAMES.has(key) ? 't-fn' : 't-type';   // CHAR(65) is a call; varchar(10) stays a type
    if (!KEYWORDS.has(key)) return unqualified();                   // `SELECT date, text FROM t`: column names
  }
  if (FUNCTION_NAMES.has(key)) {
    if (KEYWORDS.has(key)) {
      if (key === 'ON') return call && isOp(prev, '=') ? 't-fn' : 't-kw';
      return call ? 't-fn' : 't-kw';
    }
    if (call) return 't-fn';
  } else if (KEYWORDS.has(key)) {
    return !RESERVED.has(key) && !OPTION_WORDS.has(key) && namePosition(prev, next) ? unqualified() : 't-kw';
  }
  return unqualified();
}

// True when a contextual keyword stands where a name goes (01 §3: they stay valid identifiers, `SELECT zone FROM
// t`): after SELECT, DISTINCT, WHERE, AND, OR, NOT, ON, BY, SET, WHEN, THEN, ELSE, AS, HAVING or an operator other
// than ')' ';' '.', and before FROM, AS, a comparison or clause keyword (NAME_NEXT), an operator other than '(' and
// '.', or the end of its line. `OVER (PARTITION BY`, `OFFSET 5 ROWS`, `x AT TIME ZONE` stay keywords.
function namePosition(prev, next) {
  if (!prev) return false;
  const before = prev.t === 'op' ? prev.v !== ')' && prev.v !== ';' && prev.v !== '.' : prev.t === 'id' && NAME_PREV.has(prev.k);
  if (!before) return false;
  if (!next) return true;
  if (next.t === 'op') return next.v !== '(' && next.v !== '.';
  // A data type after it: the column name of a column definition (`DECLARE @t TABLE (zone char(3))`).
  return next.t === 'id' && (NAME_NEXT.has(next.k) || TYPE_NAMES.has(next.k.toLowerCase()));
}

// The significant tokens before the '(' that encloses index i of a line (walking back over balanced parentheses,
// after skipping the `skip` nearest significant tokens), nearest first, at most `want` of them. null when there is no
// such '(' (the start of the text, a ';' or a `stops` keyword at depth 0 comes first); undefined when the look-back
// limit (CTX_TOKENS significant tokens) is reached first.
function openerBefore(tokens, i, ctx, skip, stops, want = 3) {
  let depth = 0, n = 0, found = false;
  const out = [];
  for (const t of sigBefore(tokens, i, ctx)) {
    if (skip > 0) { skip--; continue; }
    if (found) { out.push(t); if (out.length >= want) return out; continue; }
    if (++n > CTX_TOKENS) return undefined;
    if (t.t === 'op') {
      if (t.v === ')') depth++;
      else if (t.v === '(') { if (!depth) found = true; else depth--; } else if (t.v === ';' && !depth) return null;
    } else if (!depth && t.t === 'id' && stops.has(t.k)) return null;
  }
  if (found) return out;
  return n >= CTX_TOKENS ? undefined : null;
}

const isName = t => !!t && (t.t === 'qid' || (t.t === 'id' && !RESERVED.has(t.k)));

// True when a data type name stands where a data type goes (types in CAST / CONVERT / DECLARE):
// after a variable (`DECLARE @v int`) or `@v AS`, after AS inside CAST / TRY_CAST (not a column alias), as the first
// argument of CONVERT / TRY_CONVERT, or after a column name that starts an item of a column-definition list (CREATE
// TABLE x (…), DECLARE @t TABLE (…), OPENJSON(…) WITH (…)). A list too long to look back to its '(' counts as one.
// Elsewhere (`SELECT date, text FROM t`, `x AT TIME ZONE CHAR(65)`) it is not.
function typePosition(tokens, i, prev, ctx) {
  if (!prev) return false;
  if (prev.t === 'var') return true;
  if (isOp(prev, '(')) {
    const fn = sigPrev(tokens, i, ctx, 2);
    return !!fn && fn.t === 'id' && (fn.k === 'CONVERT' || fn.k === 'TRY_CONVERT');
  }
  if (prev.t === 'id' && prev.k === 'AS') {
    const p2 = sigPrev(tokens, i, ctx, 2);
    if (p2 && p2.t === 'var') return true;
    const op = openerBefore(tokens, i, ctx, 1, CAST_STOP, 1);
    return !!op && op.length > 0 && op[0].t === 'id' && (op[0].k === 'CAST' || op[0].k === 'TRY_CAST');
  }
  if (!isName(prev)) return false;
  const p2 = sigPrev(tokens, i, ctx, 2);
  if (!(isOp(p2, '(') || isOp(p2, ','))) return false;
  const op = openerBefore(tokens, i, ctx, 1, DEF_STOP, 8);
  if (op === undefined) return true;
  if (!op || !op.length) return false;
  const [a, b] = op;
  if (a.t === 'id' && a.k === 'TABLE') return true;                    // DECLARE @t TABLE (…), RETURNS @t TABLE (…)
  if (a.t === 'id' && a.k === 'WITH') return isOp(b, ')');             // OPENJSON(@j) WITH (…)
  // CREATE TABLE name (…), also schema-qualified (dbo.t, #t).
  for (let k = 0; k + 1 < op.length; k += 2) {
    if (!isName(op[k])) return false;
    const sep = op[k + 1];
    if (sep.t === 'id' && sep.k === 'TABLE') return true;
    if (!isOp(sep, '.')) return false;
  }
  return false;
}

// True when an unqualified name stands where a table goes (see TABLE_KW).
function tablePosition(tokens, i, prev, next, ctx) {
  if (isOp(next, '.')) return true;
  if (!prev) return false;
  if (prev.t === 'id' && TABLE_KW.has(prev.k)) return !(prev.k === 'FROM' && fetchCursor(tokens, i, ctx));
  if (!isOp(prev, ',')) return false;
  let p = -1;
  for (let j = i - 1; j >= 0; j--) if (tokens[j] === prev) { p = j; break; }
  return inFromList(tokens, p, ctx);
}

// Tokens of a line after an edit inside it, lexed again only around the edit (03 §13: a long line costs no full
// lexing per keystroke). oldTokens are the line's tokens before the edit (offsets in the line; the array and the
// tokens after the edit are reused and moved), newLine the edited text, [es, eOld) -> [es, eNew) the edit. The tokens
// before the last whitespace token starting before the edit and those from the first whitespace token after it stay
// (whitespace always starts a token afresh); the part between is lexed again. The end state is the old one. null when
// that part does not end cleanly (an open string or comment, a line comment, no whitespace on a side): lex it all.
export function relexLine(oldTokens, newLine, es, eOld, eNew) {
  const n = oldTokens.length;
  let lo = 0, hi = n - 1, j = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (oldTokens[mid].s < es) { j = mid; lo = mid + 1; } else hi = mid - 1; }
  let w = j;
  while (w >= 0 && oldTokens[w].t !== 'ws') w--;
  if (w < 0) return null;
  let v = n;
  lo = w + 1;
  hi = n - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (oldTokens[mid].s >= eOld) { v = mid; hi = mid - 1; } else lo = mid + 1; }
  while (v < n && oldTokens[v].t !== 'ws') v++;
  if (v >= n) return null;
  const delta = eNew - eOld;
  const a = oldTokens[w].s, b = oldTokens[v].s + delta;
  if (b <= a) return null;
  const mid = tokenize(newLine.slice(a, b), true);
  mid.pop();
  const last = mid[mid.length - 1];
  if (!last || last.open || (last.t === 'cmt' && last.v.startsWith('--'))) return null;
  for (const t of mid) { t.s += a; t.e += a; }
  for (let k = v; k < n; k++) { const t = oldTokens[k]; t.s += delta; t.e += delta; }
  let tail = v;
  if (last.t === 'ws') {
    mid.pop();
    const t = oldTokens[v];
    mid.push({ t: 'ws', v: newLine.slice(last.s, t.e), s: last.s, e: t.e });
    tail = v + 1;
  }
  const out = oldTokens.slice(0, w);
  for (const t of mid) out.push(t);
  for (let k = tail; k < n; k++) out.push(oldTokens[k]);
  return out;
}

// Painted pieces {s, e, cls} of a line's classified tokens; a quoted identifier's delimiters become t-punc pieces
// (`inQuote` is the line's start state quote, so a continued `[name` line has no opening delimiter), while a `"…"`
// classed t-str (QUOTED_IDENTIFIER OFF) is one piece, quotes included, like a string literal. Tokens without a
// class (whitespace, or outside the classified range) give no piece.
export function tokenPieces(tokens, classes, inQuote = null, range = null) {
  const out = [];
  const from = range ? Math.max(0, range[0]) : 0, to = range ? Math.min(tokens.length, range[1]) : tokens.length;
  for (let i = from; i < to; i++) {
    const t = tokens[i], c = classes[i];
    if (!c || t.e <= t.s) continue;
    if (t.t !== 'qid' || c === 't-str') { out.push({ s: t.s, e: t.e, cls: c }); continue; }
    let s = t.s;
    const e = t.e;
    if (!(i === 0 && t.s === 0 && inQuote && inQuote !== "'")) { out.push({ s, e: s + 1, cls: 't-punc' }); s++; }
    if (!t.open && e - 1 >= s) {
      if (e - 1 > s) out.push({ s, e: e - 1, cls: c });
      out.push({ s: e - 1, e, cls: 't-punc' });
    } else if (e > s) out.push({ s, e, cls: c });
  }
  return out;
}

// Elementary segments {s, e, cls, inv?} of a line: token pieces, decorations {s, e, cls} (a zero-length one covers
// the next character, or becomes an `ed-eol` segment at the line end) and, unless opts.inv is false, every invisible
// character as its own `ed-inv` segment.
// Pieces and decorations are swept in order (an active count per decoration class), so a line with thousands of
// find matches or markers costs O((pieces + decorations) log n); a segment's decoration classes follow the order in
// which the classes first appear in `decos`.
export function paintLine(text, pieces, decos = [], opts = {}) {
  const n = text.length;
  const cuts = [0, n];
  for (const p of pieces) cuts.push(p.s, p.e);
  const ds = [], eol = [];
  const rank = new Map();            // decoration class -> index in `names`
  const names = [];
  for (const d of decos) {
    const s = Math.max(0, Math.min(d.s, n));
    let e = Math.max(s, Math.min(d.e, n));
    if (e === s) {
      if (s < n) e = s + 1;
      else { if (!eol.includes(d.cls)) eol.push(d.cls); continue; }
    }
    let c = rank.get(d.cls);
    if (c === undefined) { c = names.length; rank.set(d.cls, c); names.push(d.cls); }
    ds.push({ s, e, c });
    cuts.push(s, e);
  }
  const inv = [];
  if (opts.inv !== false) {
    INVISIBLE_RE.lastIndex = 0;
    for (let m; (m = INVISIBLE_RE.exec(text));) { inv.push(m.index); cuts.push(m.index, m.index + 1); }
  }
  cuts.sort((a, b) => a - b);
  const byStart = ds.slice().sort((a, b) => a.s - b.s), byEnd = ds.sort((a, b) => a.e - b.e);
  const count = new Int32Array(names.length);
  const out = [];
  let pi = 0, si = 0, ei = 0, ii = 0;
  for (let k = 0; k + 1 < cuts.length; k++) {
    const s = cuts[k], e = cuts[k + 1];
    if (e <= s) continue;
    while (si < byStart.length && byStart[si].s <= s) count[byStart[si++].c]++;
    while (ei < byEnd.length && byEnd[ei].e <= s) count[byEnd[ei++].c]--;
    while (pi < pieces.length && pieces[pi].e <= s) pi++;
    const parts = [];
    const pc = pi < pieces.length && pieces[pi].s <= s ? pieces[pi].cls : null;
    if (pc) parts.push(pc);
    for (let c = 0; c < names.length; c++) if (count[c] > 0 && names[c] !== pc) parts.push(names[c]);
    while (ii < inv.length && inv[ii] < s) ii++;
    const isInv = ii < inv.length && inv[ii] === s;
    if (isInv) parts.push('ed-inv');
    const cls = parts.join(' ');
    const last = out[out.length - 1];
    if (last && !isInv && !last.inv && last.cls === cls && last.e === s) last.e = e;
    else out.push(isInv ? { s, e, cls, inv: true } : { s, e, cls });
  }
  for (const c of eol) out.push({ s: n, e: n, cls: 'ed-eol ' + c });
  return out;
}

const hex4 = c => 'U+' + c.toString(16).toUpperCase().padStart(4, '0');

// One rendered line (div.ed-l) from its paintLine() segments: spans per class, plain text nodes for the rest.
function lineNode(text, segs) {
  const el = h('div', { class: 'ed-l' });
  for (const g of segs) {
    const t = text.slice(g.s, g.e);
    if (!g.cls) el.appendChild(document.createTextNode(t));
    else el.appendChild(h('span', g.inv ? { class: g.cls, title: hex4(t.charCodeAt(0)), text: t } : { class: g.cls, text: t }));
  }
  return el;
}

// Highlighted SQL like the editor's (spans per token, invisible-character markers) as a DocumentFragment, for
// Help, templates and the change dialog's statement text; opts.isTable(name, qualifier) enables t-tbl, and
// opts.quotedIdentifier false highlights `"…"` as a string (the query tab's SET QUOTED_IDENTIFIER OFF).
export function highlightSql(text, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const qi = o.quotedIdentifier !== false;
  const frag = document.createDocumentFragment();
  const src = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const toks = [], states = [];
  let st = LINE0;
  for (const line of src) {
    const r = tokenizeLine(line, st);
    toks.push(r.tokens);
    states.push(st);
    st = r.state;
  }
  const recent = [];     // significant tokens of the lines before the current one, nearest last (bounded)
  src.forEach((line, i) => {
    const ctx = {
      back: k => (k < recent.length ? recent[recent.length - 1 - k] : null),
      tail: () => goTailClean(j => toks[j], i + 1, src.length),
    };
    const cls = classifyTokens(toks[i], typeof o.isTable === 'function' ? o.isTable : null, ctx, null, { quotedIdentifier: qi, line, inQuote: states[i].quote });
    const segs = paintLine(line, tokenPieces(toks[i], cls, states[i].quote));
    for (const g of segs) {
      const t = line.slice(g.s, g.e);
      if (!g.cls) frag.appendChild(document.createTextNode(t));
      else frag.appendChild(h('span', g.inv ? { class: g.cls, title: hex4(t.charCodeAt(0)), text: t } : { class: g.cls, text: t }));
    }
    if (i < src.length - 1) frag.appendChild(document.createTextNode('\n'));
    for (const t of toks[i]) if (isSig(t)) recent.push(t);
    if (recent.length > 2 * CTX_TOKENS) recent.splice(0, recent.length - CTX_TOKENS);
  });
  return frag;
}

// Where offset `col` of a line is: 'string', 'comment', 'ident' (inside [..] / "..") or 'code'; `inState` is the
// line's start state (an open string, identifier or block comment continued from the previous line). With
// opts.quotedIdentifier false a `"…"` is a string literal, so inside it is 'string'; telling `"…"` from `[…]`
// needs opts.line, the line's text.
export function contextAt(tokens, col, inState = LINE0, opts = null) {
  const st = inState || LINE0;
  const qiOff = !!opts && opts.quotedIdentifier === false;
  if (col === 0) return st.cmt ? 'comment' : st.quote === "'" || (qiOff && st.quote === '"') ? 'string' : st.quote ? 'ident' : 'code';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === 'ws' || t.s >= col) continue;
    const lineCmt = t.t === 'cmt' && t.v.startsWith('--');
    if (!(col < t.e || (col === t.e && (t.open || lineCmt)))) continue;
    if (t.t === 'qid') return qiOff && doubleQuoted(t, i, opts.line, st.quote) ? 'string' : 'ident';
    return t.t === 'str' ? 'string' : t.t === 'cmt' ? 'comment' : 'code';
  }
  return 'code';
}

// True when the caret at `col` sits inside an empty pair (), [], '', N'' or "" that Backspace removes (the two
// characters around the caret; the N of an empty Unicode literal N'' stays, as typed before the quotes).
export function inEmptyPair(lineText, col, tokens) {
  if (col <= 0 || col >= lineText.length) return false;
  const pair = lineText[col - 1] + lineText[col];
  if (pair === '()') {
    return tokens.some(t => t.t === 'op' && t.v === '(' && t.s === col - 1) && tokens.some(t => t.t === 'op' && t.v === ')' && t.s === col);
  }
  const type = pair === "''" ? 'str' : pair === '[]' || pair === '""' ? 'qid' : null;
  if (!type) return false;
  return tokens.some(t => t.t === type && t.e === col + 1 && !t.open &&
    (t.s === col - 1 || (type === 'str' && t.s === col - 2 && (lineText[col - 2] === 'N' || lineText[col - 2] === 'n'))));
}

// The parenthesis pair at the caret ({a: [line, col], b: [line, col]}, the one before the caret first), scanning
// at most `maxLines` lines with getTokens(line); strings and comments are single tokens, so their parentheses never
// count. null when the caret is not next to a parenthesis or its partner is not found.
export function matchParen(getTokens, lineCount, line, col, maxLines = PAREN_LINES) {
  const toks = getTokens(line);
  const at = c => toks.findIndex(t => t.t === 'op' && (t.v === '(' || t.v === ')') && t.s === c);
  let idx = at(col - 1);
  if (idx < 0) idx = at(col);
  if (idx < 0) return null;
  const open = toks[idx].v === '(';
  let depth = 0;
  for (let li = line, n = 0; li >= 0 && li < lineCount && n <= maxLines; li += open ? 1 : -1, n++) {
    const ts = li === line ? toks : getTokens(li);
    const startK = li === line ? idx : open ? 0 : ts.length - 1;
    for (let k = startK; open ? k < ts.length : k >= 0; k += open ? 1 : -1) {
      const t = ts[k];
      if (t.t !== 'op' || (t.v !== '(' && t.v !== ')')) continue;
      depth += (t.v === '(') === open ? 1 : -1;
      if (depth === 0) return { a: [line, toks[idx].s], b: [li, t.s] };
    }
  }
  return null;
}

// Statement range for "Run statement" (01 §1): the range containing pos, else the nearest previous one (a caret in
// trailing whitespace), else the first one; null when there is none. With the script `text`, a caret before the
// next statement on its own line counts for that statement: in the indentation of the line where it starts, or on a
// comment line that only whitespace and comments separate from it (the comment introduces it).
export function pickStatement(ranges, pos, text = null) {
  if (!ranges || !ranges.length) return null;
  let k = 0;
  while (k < ranges.length && ranges[k].start <= pos) k++;
  const prev = k > 0 ? ranges[k - 1] : null, next = k < ranges.length ? ranges[k] : null;
  let r = prev || next;
  if (prev && next && pos > prev.end && typeof text === 'string' && leadsTo(text, prev.end, pos, next.start)) r = next;
  return { start: r.start, end: r.end };
}

// True when the caret at `pos` (after the previous statement's end `prevEnd`) sits on a line that belongs to the
// statement starting at `start`: the text from the caret's line start to `start` holds only whitespace and comments,
// none of it is on the previous statement's line, and the caret's line is the statement's own line or has a comment.
function leadsTo(text, prevEnd, pos, start) {
  const ls = lineStartOf(text, pos);
  if (ls < prevEnd || start - prevEnd > 1 << 20) return false;
  let onComment = false, sameLine = !text.slice(pos, start).includes('\n');
  for (const t of tokenize(text.slice(prevEnd, start), true)) {
    if (t.t === 'end') break;
    const s = prevEnd + t.s, e = prevEnd + t.e;
    if (e <= ls) continue;
    if (t.t === 'cmt') { if (s <= lineEndOf(text, pos) && e >= ls) onComment = true; continue; }
    if (t.t !== 'ws') return false;
  }
  return sameLine || onComment;
}

const qiOpt = opts => !(opts && typeof opts === 'object' && opts.quotedIdentifier === false);
const invMessage = c => `Invisible or bidirectional control character ${hex4(c)} outside a string literal.`;

// Warnings for invisible and bidirectional control characters outside string literals (01 §4.5 text); with
// opts.quotedIdentifier false a `"…"` is a string literal too, as parse() reads it.
export function invisibleMarkers(text, opts = null) {
  const out = [];
  const qi = qiOpt(opts);
  for (const t of tokenize(text, true)) {
    if (t.t === 'str' || t.t === 'end' || (!qi && t.t === 'qid' && text.charCodeAt(t.s) === 34)) continue;
    INVISIBLE_RE.lastIndex = 0;
    const v = text.slice(t.s, t.e);
    for (let m; (m = INVISIBLE_RE.exec(v));) {
      const pos = t.s + m.index;
      out.push({ start: pos, end: pos + 1, level: 'warn', message: invMessage(m[0].charCodeAt(0)) });
    }
  }
  return out;
}

// The text of an error for a marker: its message, plus ` Did you mean 'a', 'b' or 'c'?` from its did-you-mean names
// (01 §2 `suggestions`, e.g. 10715 for a misspelt hint) unless the message already says it.
function errorText(e) {
  const m = String((e && e.message) || e);
  const list = e && Array.isArray(e.suggestions) ? e.suggestions.filter(s => typeof s === 'string' && s).slice(0, 3) : [];
  if (!list.length || m.includes('Did you mean ')) return m;
  const q = list.map(s => (s.startsWith("'") ? s : `'${s}'`));
  return `${m} Did you mean ${q.length === 1 ? q[0] : `${q.slice(0, -1).join(', ')} or ${q[q.length - 1]}`}?`;
}

// Error markers of an error: one per entry of a multi-error SqlError's `errors[]` (01 §2), else one, each at its
// own pos/end moved by `offset` and clamped to [0, length], with errorText(); level 'error' unless given.
export function errorMarkers(err, { level = 'error', offset = 0, length = Infinity } = {}) {
  const list = err && Array.isArray(err.errors) && err.errors.length ? err.errors : [err];
  const out = [];
  const max = Number.isFinite(length) ? Math.max(0, length) : Infinity;
  for (const e of list) {
    if (e == null) continue;
    const p = Number.isFinite(e.pos) ? e.pos + offset : Math.max(0, offset);
    const s = Math.max(0, Math.min(p, max));
    const end = Math.max(s, Math.min(Number.isFinite(e.end) ? e.end + offset : s + 1, max));
    out.push({ start: s, end, level: level === 'warn' ? 'warn' : 'error', message: errorText(e) });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

// Parse diagnostics of a script: the parse error (if any; every entry of a multi-error one) and the parse warnings,
// as markers. opts.quotedIdentifier: the query tab's mode.
export function diagnose(text, opts = null) {
  const out = [];
  const qi = qiOpt(opts);
  try {
    const sts = parse(text, { quotedIdentifier: qi });
    for (const w of sts.warnings || []) {
      const s = Math.max(0, Math.min(Number(w.pos) || 0, text.length));
      out.push({ start: s, end: Math.max(s, Math.min(w.end ?? s + 1, text.length)), level: 'warn', message: String(w.text) });
    }
  } catch (e) {
    out.push(...errorMarkers(e, { length: text.length }));
    out.push(...invisibleMarkers(text, { quotedIdentifier: qi }));
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

// ---- incremental diagnostics (03 §5 Diagnostics, §13): the editor parses a script by units, so an edit costs the
// parse of the units it changed. Units are GO batches (01 §4.5) cut into regions at lines that start a statement at
// nesting depth 0; a region is parsed on its own text after DECLAREs of the variables that earlier regions of its
// batch declared and that it names, so it gets the markers parse() gives it inside the whole script (a cut that
// splits a statement shows as an error at the region's last token, and the region is then parsed again joined with
// the next one). The first error of a batch ends that batch, as in parse().

const STMT_START = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'DECLARE', 'SET', 'IF', 'WHILE', 'BEGIN', 'PRINT', 'EXEC', 'EXECUTE',
  'RAISERROR', 'THROW', 'WITH', 'CREATE', 'DROP', 'TRUNCATE', 'RETURN', 'BREAK', 'CONTINUE']);
const NO_BLOCK = new Set(['TRAN', 'TRANSACTION', 'DISTRIBUTED']);

// What the incremental diagnostics need of one line: its start and end lexer states (`s`, `end`), the statement
// keyword it starts with outside strings and comments (`first`; 'BEGIN CATCH' for that pair), its GO-line kind (`go`,
// goLineKind), its nesting events in order (`ops`: '(' ')', 'B' a block BEGIN, 'C' CASE, 'E' END), the start of its
// last significant token (`lastSigS`, -1 for none) and whether that is ';' (`lastSemi`), the variables it names
// (`vs`, lower case, no @@ globals), whether it holds an invisible character (`inv`), the start of its first unknown
// character (`bad`, a lexer 'bad' token; -1 for none) and where the token it ends in starts when that token is left
// open (`tail`: -1 not open, -2 open since an earlier line, else its column).
export function lineSummary(tokens, s, end, line = '') {
  let first = null, ops = '', lastSigS = -1, lastSemi = false, vs = null, firstIdx = -1, bad = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!isSig(t)) continue;
    if (firstIdx < 0) {
      firstIdx = i;
      if (!s.cmt && !s.quote && t.t === 'id' && STMT_START.has(t.k)) first = t.k;
    }
    lastSigS = t.s;
    lastSemi = isOp(t, ';');
    if (t.t === 'bad' && bad < 0) bad = t.s;
    if (t.t === 'op') { if (t.v === '(' || t.v === ')') ops += t.v; } else if (t.t === 'id') {
      if (t.k === 'BEGIN') {
        const nx = sigNext(tokens, i);
        if (!(nx && nx.t === 'id' && NO_BLOCK.has(nx.k))) ops += 'B';
        if (i === firstIdx && first === 'BEGIN' && nx && nx.t === 'id' && nx.k === 'CATCH') first = 'BEGIN CATCH';
      } else if (t.k === 'CASE') ops += 'C';
      else if (t.k === 'END') ops += 'E';
    } else if (t.t === 'var' && !t.v.startsWith('@@')) (vs || (vs = [])).push(t.v);
  }
  const last = tokens[tokens.length - 1];
  const tail = !last || !last.open ? -1 : last.s === 0 && (s.cmt || s.quote) ? -2 : last.s;
  return { s, end, first, go: goLineKind(tokens), ops, sig: lastSigS >= 0, lastSigS, lastSemi, vs, inv: INVISIBLE_1.test(line), bad, tail };
}

// Diagnostic units of a script from its line summaries (lineSummary) and line starts: batches [{start, end, lex,
// lexOpen, regions: [{start, end, lastSig, vs}]}] that tile the text (lastSig: offset of the region's last significant
// token or -1; vs: the variables it names). A GO line ends its batch and belongs to its last region. A region starts
// at a line whose first token is a statement keyword at parenthesis, BEGIN and CASE depth 0, except BEGIN CATCH, and
// WITH or THROW unless the previous significant token is ';' (they would read differently after another statement).
// `lex` is the offset of the batch's first lexical error as parse() finds it before parsing the batch (an unknown
// character, or the string, quoted identifier or block comment the last batch leaves open: `lexOpen`), else -1.
export function scriptUnits(sums, starts, textLength) {
  const L = sums.length;
  const lineEnd = i => (i + 1 < L ? starts[i + 1] - 1 : textLength);
  const batches = [];
  let bStart = 0, regions = [], rStart = 0, rSig = -1, rVs = null, bBad = -1, bLine = 0;
  let par = 0, blk = 0, cas = 0, prevSemi = false;
  const close = end => { regions.push({ start: rStart, end, lastSig: rSig, vs: rVs }); rStart = end; rSig = -1; rVs = null; };
  for (let i = 0; i < L; i++) {
    const m = sums[i];
    if (m.go) {
      let j = i, go = m.go === 1;
      if (!go) {
        go = true;
        for (j = i + 1; j < L; j++) {
          if (sums[j].sig) { go = false; break; }
          if (!sums[j].end.cmt) break;
        }
        if (j >= L) j = L - 1;
      }
      if (go) {
        for (let k = i; k <= j; k++) if (sums[k].sig) rSig = starts[k] + sums[k].lastSigS;
        const end = lineEnd(j);
        close(end);
        // A GO line holds no unknown character, and a comment it leaves open is not an error (parse() skips it).
        batches.push({ start: bStart, end, lex: bBad, lexOpen: false, regions });
        bStart = end;
        regions = [];
        par = blk = cas = 0;
        prevSemi = false;
        bBad = -1;
        bLine = j + 1;
        i = j;
        continue;
      }
    }
    if (m.first && rSig >= 0 && !par && !blk && !cas && m.first !== 'BEGIN CATCH' &&
      ((m.first !== 'WITH' && m.first !== 'THROW') || prevSemi)) close(starts[i]);
    if (bBad < 0 && m.bad >= 0) bBad = starts[i] + m.bad;
    if (m.sig) { rSig = starts[i] + m.lastSigS; prevSemi = m.lastSemi; }
    if (m.vs) { if (!rVs) rVs = []; for (const v of m.vs) rVs.push(v); }
    for (let k = 0; k < m.ops.length; k++) {
      const c = m.ops[k];
      if (c === '(') par++;
      else if (c === ')') { if (par) par--; } else if (c === 'B') blk++;
      else if (c === 'C') cas++;
      else if (cas) cas--;
      else if (blk) blk--;
    }
  }
  close(textLength);
  // The last batch can end inside an open token: it starts on the last line whose tail is not a continuation.
  let lex = bBad, lexOpen = false;
  if (bLine < L && sums[L - 1].tail !== -1) {
    let j = L - 1;
    while (j > bLine && sums[j].tail === -2) j--;
    const os = starts[j] + Math.max(0, sums[j].tail);
    if (lex < 0 || os < lex) { lex = os; lexOpen = true; }
  }
  batches.push({ start: bStart, end: textLength, lex, lexOpen, regions });
  return batches;
}

// The lexical error parse() reports for a batch (see scriptUnits: `s` = lex, `open` = lexOpen) as a marker, with
// parse()'s own message from a parse of the few characters at `s` (a string or identifier is cut only after a run of
// its closing quotes, so its escaped quotes pair up as in the whole text). null if that parse does not fail there.
function lexMarker(text, s, open, qi = true) {
  let e = s + 1;
  if (open) {
    const c = text[s];
    const q = c === '[' ? ']' : c === '"' ? '"' : c === '/' ? null : "'";
    e = Math.min(text.length, s + 128);
    if (q) while (e < text.length && text[e - 1] === q && text[e] === q) e++;
  }
  try { parse(text.slice(s, e), { quotedIdentifier: qi }); } catch (err) {
    if (err && err.pos === 0 && typeof err.message === 'string') {
      return { start: s, end: open ? text.length : s + Math.max(1, Number(err.end) || 1), level: 'error', message: err.message };
    }
  }
  return null;
}

// DECLAREs (one line, ending in a newline) of the variables in `names` that `declared` (name -> 'scalar'|'table')
// holds, sorted; '' when there are none.
function varPrefix(declared, names) {
  if (!names || !declared.size) return '';
  const sc = [], tb = [];
  for (const v of new Set(names)) {
    const k = declared.get(v);
    if (v.length > 128) continue;
    if (k === 'scalar') sc.push(v); else if (k === 'table') tb.push(v);
  }
  if (!sc.length && !tb.length) return '';
  sc.sort();
  tb.sort();
  let p = sc.length ? `DECLARE ${sc.map(v => v + ' int').join(', ')};` : '';
  for (const v of tb) p += `DECLARE ${v} TABLE (c int);`;
  return p + '\n';
}

// Variables the DECLAREs of a parse result declare ([name, kind] in order), ignoring statements before `off`.
function declaredVars(sts, off) {
  const out = [];
  const walk = n => {
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (!n || typeof n !== 'object' || n instanceof Date) return;
    if (n.type === 'declare' && Array.isArray(n.vars)) {
      if (!(n.pos < off)) for (const v of n.vars) out.push([String(v.name), v.table ? 'table' : 'scalar']);
      return;
    }
    for (const k in n) { const v = n[k]; if (v && typeof v === 'object') walk(v); }
  };
  walk(sts);
  return out;
}

// Parse result of one region: {err: [{s, e, msg}]|null (one entry per error of a multi-error SqlError; the
// first is the error), warns: [{s, e, msg}], decl: [[name, kind]], labels: [{name, s, e, scopes}], gotos: [{label,
// s, e, scopes}]}, offsets (scopes too) relative to the region text `src`, which follows the prefix `pre` (DECLAREs,
// and with `labels` the earlier labels of the batch). The region is parsed with labelChecks false, so its GOTOs and
// labels are resolved over the whole batch by diagnoseUnits (01 §4.1 GOTO); `checks` parses it with
// labelChecks on instead (a failing region: an earlier label repeated before its syntax error raises 132 first).
function parseRegion(src, pre, qi = true, checks = false) {
  const off = pre.length, n = src.length;
  const rel = p => Math.max(0, Math.min(p - off, n));
  try {
    const sts = parse(pre + src, { quotedIdentifier: qi, labelChecks: checks });
    const warns = [];
    for (const w of sts.warnings || []) {
      const p = Number(w.pos) || 0;
      if (p < off) continue;
      const s = rel(p);
      warns.push({ s, e: Math.max(s, Math.min((w.end ?? p + 1) - off, n)), msg: String(w.text) });
    }
    const scopes = l => (Array.isArray(l.scopes) ? l.scopes.map(rel) : []);
    const labels = (sts.labels || []).filter(l => l.pos >= off).map(l => ({ name: String(l.name), s: rel(l.pos), e: rel(l.end), scopes: scopes(l) }));
    const gotos = (sts.gotos || []).filter(g => g.pos >= off).map(g => ({ label: String(g.label), s: rel(g.pos), e: rel(g.end), scopes: scopes(g) }));
    return { err: null, warns, decl: declaredVars(sts, off), labels, gotos };
  } catch (e) {
    const err = errorMarkers(e, { offset: -off, length: n }).map(m => ({ s: m.start, e: m.end, msg: m.message, number: null }));
    if (err.length) err[0].number = e && Number.isInteger(e.number) ? e.number : null;
    return { err, warns: [], decl: [], labels: [], gotos: [] };
  }
}

// Label definitions `[name]:` (one line) that make a region's parse see the labels earlier regions of its batch
// defined, so a repeated one raises 132 where parse() of the whole batch raises it.
function labelPrefix(names) {
  let p = '';
  for (const nm of names) p += '[' + nm.replace(/]/g, ']]') + ']:';
  return p ? p + '\n' : '';
}

// Keywords that may start a statement inside a region (cutPoints): the region starts and the statements that never
// start a region. One right after these words continues the statement before it (`UNION SELECT`, `THEN UPDATE`,
// `CURSOR FOR SELECT`).
const CUT_START = new Set([...STMT_START, 'MERGE', 'OPEN', 'FETCH', 'CLOSE', 'DEALLOCATE', 'GOTO', 'COMMIT', 'ROLLBACK', 'SAVE', 'REVERT',
  'ALTER', 'WAITFOR', 'USE']);
const CUT_AFTER = new Set(['UNION', 'EXCEPT', 'INTERSECT', 'ALL', 'THEN', 'FOR']);
const CUT_TRIES = 8;            // cut points tried, nearest first, for the warnings before a syntax error
const CLOSE_BLOCK = { B: ' END', T: ' END TRY BEGIN CATCH PRINT 1 END CATCH', K: ' END CATCH' };

// Where a region's text can be cut before offset `limit` (its first syntax error) so that the statements before the
// cut parse on their own (warningsBefore): [{at, tail}], nearest first, at most CUT_TRIES. `at` starts a token that
// may start a statement (CUT_START) at parenthesis depth 0 and outside CASE; `tail` is a filler statement and the
// closers of the blocks open there (BEGIN … END, BEGIN TRY … END TRY BEGIN CATCH … END CATCH, BEGIN CATCH … END
// CATCH), so `src.slice(0, at) + tail` is a whole script when the cut is at a statement boundary.
export function cutPoints(src, limit) {
  const sig = [];
  for (const t of tokenize(src, true)) {
    if (t.t === 'end' || t.s > limit) break;
    if (isSig(t)) sig.push(t);
  }
  const out = [];
  const stack = [];
  let depth = 0;
  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    if (t.t === 'op') {
      if (t.v === '(') depth++;
      else if (t.v === ')') { if (depth) depth--; }
      continue;
    }
    if (t.t !== 'id' || depth) continue;
    const nx = sig[k + 1];
    const nk = nx && nx.t === 'id' ? nx.k : null;
    const pv = sig[k - 1];
    if (t.s > 0 && CUT_START.has(t.k) && !stack.includes('C') && !(pv && pv.t === 'id' && CUT_AFTER.has(pv.k)) &&
      !(t.k === 'WITH' && isOp(nx, '(')) && !(t.k === 'BEGIN' && nk === 'CATCH')) {
      let tail = ' PRINT 1';
      for (let j = stack.length - 1; j >= 0; j--) tail += CLOSE_BLOCK[stack[j]];
      out.push({ at: t.s, tail });
    }
    if (t.k === 'BEGIN') {
      if (nk === 'TRY') stack.push('T');
      else if (nk === 'CATCH') stack.push('K');
      else if (!NO_BLOCK.has(nk)) stack.push('B');
    } else if (t.k === 'CASE') stack.push('C');
    else if (t.k === 'END' && stack.length) stack.pop();
  }
  return out.reverse().slice(0, CUT_TRIES);
}

// The parse warnings of a region's statements before offset `cut` (cutPoints), from a parse of the region cut there
// and closed with `tail` after the prefix `pre`; [{s, e, msg}] relative to the region, or null when that text does not
// parse. Invisible-character warnings are left out: the caller adds them from the tokens (invisibleIn).
function warningsBefore(src, pre, cut, tail, qi) {
  const off = pre.length;
  let sts;
  try { sts = parse(pre + src.slice(0, cut) + tail, { quotedIdentifier: qi, labelChecks: false }); } catch { return null; }
  const out = [];
  const full = pre + src;
  for (const w of sts.warnings || []) {
    const p = Number(w.pos) || 0;
    if (p < off || p - off >= cut) continue;
    const e = Math.max(p, Math.min(Number(w.end ?? p + 1), off + cut));
    if (e - p === 1 && INVISIBLE_1.test(full[p])) continue;
    out.push({ s: p - off, e: e - off, msg: String(w.text) });
  }
  return out;
}

// Invisible-character warnings outside string literals in text[a, b), found line by line: sums/starts as for
// scriptUnits, tokensOf(i) gives line i's tokens (asked only for lines that hold such a character); with
// opts.quotedIdentifier false a `"…"` is a string literal too.
export function invisibleIn(text, a, b, sums, starts, tokensOf, opts = null) {
  const out = [];
  if (b <= a) return out;
  const qi = qiOpt(opts);
  const la = lineIndexAt(starts, a), lb = lineIndexAt(starts, b - 1);
  for (let i = la; i <= lb; i++) {
    if (!sums[i].inv) continue;
    const ls = starts[i];
    const line = text.slice(ls, i + 1 < starts.length ? starts[i + 1] - 1 : text.length);
    const toks = tokensOf(i);
    const inQuote = sums[i].s ? sums[i].s.quote : null;
    INVISIBLE_RE.lastIndex = 0;
    for (let m, k = 0; (m = INVISIBLE_RE.exec(line));) {
      const p = ls + m.index;
      if (p < a || p >= b) continue;
      while (k < toks.length && toks[k].e <= m.index) k++;
      const t = k < toks.length && toks[k].s <= m.index ? toks[k] : null;
      if (t && (t.t === 'str' || (!qi && doubleQuoted(t, k, line, inQuote)))) continue;
      out.push({ start: p, end: p + 1, level: 'warn', message: invMessage(m[0].charCodeAt(0)) });
    }
  }
  return out;
}

// Parse markers of a script by units (scriptUnits), yielding null after every parse so a caller can slice the work.
// opts: cache (Map src -> Map prefix -> result) to reuse, used (a Map that receives every result this run needed:
// the next cache), invisibles(a, b) (invisibleIn for a range: an error hides the parse warnings after it, as in
// diagnose) and onParse() (counts real parses). A batch with a lexical error (scriptUnits `lex`) is not parsed, as in
// parse(): it gets that error and its invisible-character warnings, and the cached results are kept for when the
// error is fixed (typing a quote turns the rest of the script into a string until the closing one is typed).
// Returns the markers, sorted.
export function* diagnoseUnits(text, batches, opts = {}) {
  const { cache = null, used = null, invisibles = () => [], onParse = null } = opts || {};
  const qi = qiOpt(opts);
  const mode = qi ? '' : '\u0000';        // a region's result depends on the QUOTED_IDENTIFIER mode
  const out = [];
  let kept = false;
  const regionResult = (src, pre, checks = false) => {
    const key = mode + (checks ? '\u0001' : '') + pre;
    let r = cache && cache.get(src)?.get(key);
    if (!r) { r = parseRegion(src, pre, qi, checks); if (onParse) onParse(); }
    if (used) { let m = used.get(src); if (!m) used.set(src, m = new Map()); m.set(key, r); }
    return r;
  };
  const error = (start, end, message) => ({ start, end, level: 'error', message });
  // The parse warnings before the first syntax error of a failing region (03 §5 Diagnostics: they are kept): those of
  // its statements before the nearest cut point (cutPoints) whose cut text parses, one parse per cut point tried.
  const warnsBefore = function* (src, pre, limit) {
    const key = mode + '\u0002' + limit + '\u0003' + pre;
    let r = cache && cache.get(src)?.get(key);
    if (!r) {
      r = { warns: [] };
      for (const c of cutPoints(src, limit)) {
        const w = warningsBefore(src, pre, c.at, c.tail, qi);
        if (onParse) onParse();
        yield null;
        if (w) { r = { warns: w }; break; }
      }
    }
    if (used) { let m = used.get(src); if (!m) used.set(src, m = new Map()); m.set(key, r); }
    return r.warns;
  };
  for (const b of batches) {
    if (b.lex >= 0) {
      const m = lexMarker(text, b.lex, !!b.lexOpen, qi);
      if (m) {
        out.push(m);
        for (const w of invisibles(b.start, b.end)) out.push(w);
        if (cache && used && !kept) { kept = true; for (const [src, r] of cache) if (!used.has(src)) used.set(src, r); }
        yield null;
        continue;
      }
    }
    const declared = new Map();
    const labels = new Map();      // lower-case label name -> its TRY / CATCH scopes (absolute offsets)
    const labelNames = [];         // the batch's labels as written, in source order
    const gotos = [];
    const R = b.regions;
    let failed = false;
    for (let i = 0; i < R.length;) {
      const a = R[i].start;
      let j = i, res = null, pre = '', names = R[i].vs ? R[i].vs.slice() : [], lastSig = R[i].lastSig;
      for (;;) {
        pre = varPrefix(declared, names);
        res = regionResult(text.slice(a, R[j].end), pre);
        yield null;
        if (res.err && j + 1 < R.length && lastSig >= 0 && a + res.err[0].s >= lastSig) {
          j++;
          if (R[j].vs) for (const v of R[j].vs) names.push(v);
          if (R[j].lastSig >= 0) lastSig = R[j].lastSig;
          continue;
        }
        break;
      }
      const src = text.slice(a, R[j].end);
      if (res.err) {
        let err = res.err;
        // A label defined a second time before the syntax error raises 132 there first, as in parse(): the region is
        // parsed again with label checks after the batch's earlier labels (only a region with a ':' defines one).
        if (src.includes(':')) {
          const chk = regionResult(src, pre + labelPrefix(labelNames), true);
          yield null;
          if (chk.err && chk.err[0].number === 132 && chk.err[0].s < err[0].s) err = chk.err;
        }
        const before = yield* warnsBefore(src, pre, err[0].s);
        for (const w of before) out.push({ start: a + w.s, end: a + w.e, level: 'warn', message: w.msg });
        for (const m of err) out.push(error(a + m.s, a + m.e, m.msg));
        for (const m of invisibles(a, b.end)) out.push(m);
        failed = true;
        break;
      }
      // The second definition of a label raises 132 at it, and parse() stops there (01 §4.1 GOTO).
      let dup = null;
      for (const l of res.labels) {
        const k = l.name.toLowerCase();
        if (labels.has(k)) { dup = l; break; }
        labels.set(k, l.scopes.map(x => a + x));
        labelNames.push(l.name);
      }
      const until = dup ? a + dup.s : Infinity;
      for (const w of res.warns) if (a + w.s < until) out.push({ start: a + w.s, end: a + w.e, level: 'warn', message: w.msg });
      if (dup) {
        out.push(error(until, a + dup.e, msg(132, dup.name).message));
        for (const m of invisibles(until, b.end)) out.push(m);
        failed = true;
        break;
      }
      for (const g of res.gotos) gotos.push({ label: g.label, s: a + g.s, e: a + g.e, scopes: g.scopes.map(x => a + x) });
      for (const [nm, k] of res.decl) declared.set(nm, k);
      i = j + 1;
    }
    if (failed) continue;
    // Once the batch parsed, its first GOTO (in source order) to a label it does not define raises 133, and one into
    // a TRY or CATCH block it is not in raises 1026, as parse() checks them.
    for (const g of gotos) {
      const l = labels.get(g.label.toLowerCase());
      if (l && !l.some((id, k) => g.scopes[k] !== id)) continue;
      out.push(error(g.s, g.e, l ? msg(1026).message : msg(133, g.label).message));
      break;
    }
  }
  return out.sort((x, y) => x.start - y.start || x.end - y.end);
}

// Parse markers of a whole script through the units (scriptUnits / diagnoseUnits), synchronously: what the editor's
// sliced diagnostics produce. Equal to diagnose(text) except that every GO batch reports its own first error and
// the warnings before a syntax error in a batch are kept. opts.quotedIdentifier: the query tab's mode.
export function diagnoseScript(text, cache = null, opts = null) {
  const src = String(text ?? '');
  const qi = qiOpt(opts);
  const lines = src.split('\n');
  const starts = lineStarts(src);
  const sums = [];
  const toks = [];
  let st = LINE0;
  for (const line of lines) {
    const r = tokenizeLine(line, st);
    sums.push(lineSummary(r.tokens, st, r.state, line));
    toks.push(r.tokens);
    st = r.state;
  }
  const it = diagnoseUnits(src, scriptUnits(sums, starts, src.length), {
    cache, quotedIdentifier: qi, invisibles: (a, b) => invisibleIn(src, a, b, sums, starts, i => toks[i], { quotedIdentifier: qi }),
  });
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

// ----------------------------------------------------------------------------------------------------- find

// For a text whose toLowerCase() is longer (U+0130 lower-cases to two characters): the offset in `src` of the
// character each lower-case offset comes from.
function lowerMap(src, lowLen) {
  const map = new Int32Array(lowLen + 1);
  let j = 0;
  for (let i = 0; i < src.length;) {
    const [cp, len] = cpAt(src, i);
    const l = String.fromCodePoint(cp).toLowerCase().length;
    for (let k = 0; k < l && j < lowLen; k++) map[j++] = i;
    i += len;
  }
  while (j <= lowLen) map[j++] = src.length;
  return map;
}

const isHigh = c => c >= 0xD800 && c <= 0xDBFF;
const isLow = c => c >= 0xDC00 && c <= 0xDFFF;
const CASE_IGNORABLE = /^\p{Case_Ignorable}$/u;
const SIGMA = '\u{3a3}';
// Characters whose glyphs may not fill exactly the cells charCols() gives them: everything but tab, printable ASCII and
// Latin-1, which every editor font has. Thai, Devanagari, Arabic, Hebrew, CJK and emoji come from proportional
// fallback fonts, marks join their base, right-to-left runs are reordered and C0/C1 controls vary (measured in Edge
// 155), so a rendered line with one is measured in the DOM (domLine), and so is its width (checkWidth).
const MEASURE_RE = /[^\t\x20-\x7e\xa0-\xff]/;
// Characters that start or force a right-to-left run (Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, their
// presentation forms, the RTL scripts beyond the BMP, and RLM, RLE, RLO, RLI): where the caret is in such a run, the
// character after it is on its left (domX).
const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻾‏‫‮⁧]|[\ud802\ud803\ud83a\ud83b][\udc00-\udfff]/;

// What text.toLowerCase() makes of the capital sigma at offset i: 'ς' (final) or 'σ'. Final_Sigma is the only
// context-dependent mapping of the locale-independent toLowerCase() (Unicode SpecialCasing): it looks back and ahead
// over case-ignorable characters to the first other character, so lower-casing exactly that span gives the answer
// the whole text would.
function sigmaLower(text, i) {
  let a = i;
  while (a > 0) {
    const cp = cpBefore(text, a);
    a -= cp > 0xFFFF ? 2 : 1;
    if (!CASE_IGNORABLE.test(String.fromCodePoint(cp))) break;
  }
  let b = i + 1;
  while (b < text.length) {
    const [cp, len] = cpAt(text, b);
    b += len;
    if (!CASE_IGNORABLE.test(String.fromCodePoint(cp))) break;
  }
  return text.slice(a, b).toLowerCase()[text.slice(a, i).toLowerCase().length];
}

// text.slice(s, e).toLowerCase() as it reads inside text.toLowerCase(): a capital sigma near a cut gets the form its
// neighbours in the whole text give it (sigmaLower); every other character lower-cases on its own.
function lowerSlice(text, s, e) {
  const src = text.slice(s, e);
  let p = src.indexOf(SIGMA);
  if (p < 0) return src.toLowerCase();
  let out = '', last = 0;
  for (; p >= 0; p = src.indexOf(SIGMA, p + 1)) {
    out += src.slice(last, p).toLowerCase() + sigmaLower(text, s + p);
    last = p + 1;
  }
  return out + src.slice(last).toLowerCase();
}

// Compiles a find query (03 §5): {empty} | {error} | {regex, re, unicode, wholeWord} | {needle, matchCase, wholeWord}.
export function compileFind(query, { matchCase = false, wholeWord = false, regex = false } = {}) {
  const q = String(query ?? '');
  if (!q) return { empty: true };
  if (regex) {
    const unicode = /\\[pP]\{|\\u\{/.test(q);
    const flags = 'gm' + (matchCase ? '' : 'i') + (unicode ? 'u' : '');
    try {
      return { regex: true, re: new RegExp(q, flags), unicode, wholeWord };
    } catch (e) {
      const msg = String(e && e.message || e);
      return { error: 'Invalid regular expression: ' + msg.slice(msg.lastIndexOf(':') + 1).trim() };
    }
  }
  return { regex: false, needle: matchCase ? q : q.toLowerCase(), matchCase, wholeWord };
}

// True when text[s, e) has no identifier character on either side (Whole word, 03 §5).
export function wordBounded(text, s, e) {
  return !isWordCp(cpBefore(text, s)) && !(e < text.length && isWordCp(text.codePointAt(e)));
}

// Matches {start, end, m} (m: the RegExp match in regex mode) of a compiled find starting in text[from, to] (a match
// starting exactly at `to` only when `to` is the end of the text); empty matches only with includeEmpty. Yields null
// now and then (every 256 matches, and after every chunk of a case-insensitive literal search), so a caller can yield
// to the UI. Literal search without Match case lower-cases only the chunks it searches (03 §5: both sides compared
// after toLowerCase()), each exactly as it reads inside text.toLowerCase() (lowerSlice: a capital sigma at a cut keeps
// its final or non-final form); a match covers the whole characters its lower-case form came from, so it is never empty.
export function* scanMatches(text, f, { from = 0, to = text.length, includeEmpty = false } = {}) {
  if (!f || f.empty || f.error) return;
  const N = text.length;
  from = Math.max(0, Math.min(Number(from) || 0, N));
  let n = 0;
  const past = s => s > to || (s === to && to < N);
  if (!f.regex) {
    const nd = f.needle, L = nd.length;
    if (!L) return;
    if (f.matchCase) {
      for (let i = from; ;) {
        const s = text.indexOf(nd, i);
        if (s < 0 || past(s)) return;
        if (!f.wholeWord || wordBounded(text, s, s + L)) { yield { start: s, end: s + L, m: null }; i = s + L; } else i = s + 1;
        if ((++n & 255) === 0) yield null;
      }
    }
    let lastEnd = from;
    for (let cs = from; cs < N;) {
      if (past(cs)) return;
      let ce = Math.min(N, cs + LOW_CHUNK);
      if (ce < N && isHigh(text.charCodeAt(ce - 1))) ce++;
      let se = Math.min(N, ce + L);
      if (se < N && isHigh(text.charCodeAt(se - 1))) se++;
      const src = text.slice(cs, se);
      const low = lowerSlice(text, cs, se);
      const map = low.length !== src.length ? lowerMap(src, low.length) : null;
      for (let i = 0; ;) {
        const k = low.indexOf(nd, i);
        if (k < 0) break;
        const s = cs + (map ? map[k] : k);
        if (past(s)) return;
        if (s >= ce) break;
        const j = k + L - 1;
        const e = cs + (map ? map[j] + cpAt(src, map[j])[1] : j + 1);
        if (s >= lastEnd && (!f.wholeWord || wordBounded(text, s, e))) { yield { start: s, end: e, m: null }; lastEnd = e; i = k + L; } else i = k + 1;
        if ((++n & 255) === 0) yield null;
      }
      cs = ce;
      yield null;
    }
    return;
  }
  const re = new RegExp(f.re.source, f.re.flags);
  re.lastIndex = from;
  for (;;) {
    const m = re.exec(text);
    if (!m) return;
    const s = m.index, e = s + m[0].length;
    if (past(s)) return;
    if (e === s) re.lastIndex = s + (f.unicode && s < text.length ? cpAt(text, s)[1] : 1);
    if ((e > s || includeEmpty) && (!f.wholeWord || wordBounded(text, s, e))) yield { start: s, end: e, m };
    if ((++n & 255) === 0) yield null;
    if (re.lastIndex > text.length) return;
  }
}

// All matches of a compiled find ({matches, capped}); capped when more than `limit` were found.
export function findAll(text, f, { from = 0, to = text.length, includeEmpty = false, limit = Infinity } = {}) {
  const matches = [];
  let capped = false;
  for (const x of scanMatches(text, f, { from, to, includeEmpty })) {
    if (!x) continue;
    if (matches.length >= limit) { capped = true; break; }
    matches.push(x);
  }
  return { matches, capped };
}

// Regex replacement text (03 §5, as VS Code): $1-$99, $<name>, $&, $$ and the escapes \n, \t, \\; anything else as typed.
export function expandReplacement(tpl, m) {
  const t = String(tpl ?? '');
  const groups = m.length - 1;
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    const n = t[i + 1];
    if (c === '\\' && n !== undefined) {
      if (n === 'n') { out += '\n'; i++; continue; }
      if (n === 't') { out += '\t'; i++; continue; }
      if (n === '\\') { out += '\\'; i++; continue; }
    } else if (c === '$' && n !== undefined) {
      if (n === '$') { out += '$'; i++; continue; }
      if (n === '&') { out += m[0]; i++; continue; }
      if (n === '<') {
        const close = t.indexOf('>', i + 2);
        const name = close > 0 ? t.slice(i + 2, close) : null;
        if (name !== null && m.groups && Object.hasOwn(m.groups, name)) { out += m.groups[name] ?? ''; i = close; continue; }
      } else if (n >= '0' && n <= '9') {
        const d2 = t[i + 2];
        if (d2 !== undefined && d2 >= '0' && d2 <= '9') {
          const k2 = Number(n + d2);
          if (k2 >= 1 && k2 <= groups) { out += m[k2] ?? ''; i += 2; continue; }
        }
        const k1 = Number(n);
        if (k1 >= 1 && k1 <= groups) { out += m[k1] ?? ''; i++; continue; }
      }
    }
    out += c;
  }
  return out;
}

// Replacement for one match: the template as typed (literal mode) or expanded (regex mode, re-matched at
// match.start when the match carries no RegExp result); null when the regex no longer matches there.
export function replacementFor(f, text, match, tpl) {
  if (!f.regex) return String(tpl ?? '');
  let m = match.m;
  if (!m) {
    const re = new RegExp(f.re.source, f.re.flags.replace('g', '') + 'y');
    re.lastIndex = match.start;
    m = re.exec(text);
    if (!m || m.index !== match.start || m.index + m[0].length !== match.end) return null;
  }
  return expandReplacement(tpl, m);
}

// Replace all built while the matches are found (03 §13: a pattern such as `.` over 5 MB gives millions of matches):
// add(match) for each match in text order (empty ones included), then edit() -> the one edit {from, to, text, sel,
// count}, or null without matches. Only the output is kept, in blocks joined as they fill, never the matches or their
// RegExp results, so memory follows the size of the result, not the number of matches.
export function replaceAllBuilder(text, f, tpl) {
  const lit = String(tpl ?? '');
  const BLOCK = 4096;
  let from = -1, pos = 0, count = 0, parts = [], blocks = [];
  return {
    add(x) {
      if (from < 0) from = pos = x.start;
      parts.push(text.slice(pos, x.start), f.regex ? expandReplacement(lit, x.m) : lit);
      pos = x.end;
      count++;
      if (parts.length >= BLOCK) { blocks.push(parts.join('')); parts = []; }
    },
    count: () => count,
    edit() {
      if (!count) return null;
      if (parts.length) { blocks.push(parts.join('')); parts = []; }
      const out = blocks.length === 1 ? blocks[0] : blocks.join('');
      blocks = [out];
      return { from, to: pos, text: out, sel: [from + out.length, from + out.length], count };
    },
  };
}

// One edit replacing every match, empty matches included (`^` -> `-- ` comments every line); null without matches.
// `found`: the matches (any iterable, in text order; null entries are skipped), else the text is searched here.
export function replaceAllEdit(text, f, tpl, found = null) {
  const b = replaceAllBuilder(text, f, tpl);
  for (const x of found || scanMatches(text, f, { includeEmpty: true })) if (x) b.add(x);
  return b.edit();
}

// Count line of the find bar: '' (no query), the regex error, '10,000+ matches', 'No results' or '3 of 12'.
export function findCountText({ query = '', error = null, total = 0, index = 0, capped = false } = {}) {
  if (error) return error;
  if (!query) return '';
  if (capped) return `${fmtInt(FIND_CAP)}+ matches`;
  if (!total) return 'No results';
  return `${fmtInt(index + 1)} of ${fmtInt(total)}`;
}

// 'Replaced 12 occurrences.' (03 §5).
export function replacedText(n) {
  return `Replaced ${fmtInt(n)} ${n === 1 ? 'occurrence' : 'occurrences'}.`;
}

// What Format left unchanged, from format.js formatSqlReport's `kept` ([{start, end, reason}]), as one message; ''
// when everything was formatted. `cut`: the selection ends inside a string, quoted identifier or comment that goes on
// after it (so an 'unterminated' piece is the selection's cut, not an unclosed literal).
export function formatNotice(kept, { cut = false } = {}) {
  const n = { error: 0, unterminated: 0, unformatted: 0, case: 0 };
  for (const k of Array.isArray(kept) ? kept : []) if (k && Object.hasOwn(n, k.reason)) n[k.reason]++;
  const out = [];
  const st = (c, one, many) => (c === 1 ? `1 statement ${one}` : `${fmtInt(c)} statements ${many}`);
  if (n.error) out.push(st(n.error, 'was left unchanged: it does not parse.', 'were left unchanged: they do not parse.'));
  if (n.unformatted) out.push(st(n.unformatted, 'was left unchanged: it could not be formatted safely.', 'were left unchanged: they could not be formatted safely.'));
  if (n.case) out.push(st(n.case, 'was formatted with its letter case kept.', 'were formatted with their letter case kept.'));
  if (n.unterminated) {
    out.push(cut ? 'The text from a string, quoted identifier or comment that goes on after the selection was left unchanged.'
      : 'The text from an unclosed string, quoted identifier or comment to the end was left unchanged.');
  }
  return out.join(' ');
}

// Where the pieces the formatter kept byte for byte (formatSqlReport `kept`, offsets in src) are in its output `out`:
// [{start, end, to}] in source order (`to`: the piece's offset in out); a piece not found is left out. Format changes
// only white space and letter case before a piece, and Add display names only adds text, so the offset in out after
// as many non-white-space characters as src has before the piece is a lower bound for it: one pass over both texts.
export function keptPlaces(src, out, kept) {
  const res = [];
  const list = (Array.isArray(kept) ? kept : []).filter(k => k && k.end > k.start && k.start >= 0 && k.end <= src.length)
    .slice().sort((a, b) => a.start - b.start);
  let i = 0, n = 0, j = 0, m = 0, from = 0;
  for (const k of list) {
    if (k.start < i) continue;   // overlaps the previous piece
    for (; i < k.start; i++) if (src.charCodeAt(i) > 32) n++;
    while (j < out.length && m < n) { if (out.charCodeAt(j) > 32) m++; j++; }
    const piece = src.slice(k.start, k.end);
    const p = out.indexOf(piece, Math.max(from, j));
    if (p < 0) continue;
    res.push({ start: k.start, end: k.end, to: p });
    from = p + piece.length;
  }
  return res;
}

// The status-bar text after Format › Add display names (03 §5) when statements did not parse: 'Display names
// were added to 2 of 3 statements; 1 does not parse.'; '' when every statement parsed.
export function displayNamesNotice({ total = 0, failing = 0 } = {}) {
  if (!(failing > 0)) return '';
  const all = Math.max(total, failing);
  const does = failing === 1 ? 'does' : 'do';
  if (all === failing) return all === 1 ? 'Display names were not added: the statement does not parse.' : `Display names were not added: the ${fmtInt(all)} statements do not parse.`;
  return `Display names were added to ${fmtInt(all - failing)} of ${fmtInt(all)} statements; ${fmtInt(failing)} ${does} not parse.`;
}

// The labels of Format › Add display names (03 §5) as format.js's `displayNames(table, column, {schema})` callback
// (01 §1): `<attribute displayName> (<table displayName, else its logical name>)` for a column of a table written
// without a schema or under dbo, archive or bin, else null (no display name, an unknown table or column, another
// schema). `entities`: lower-case table name -> meta.js EntityInfo ({logicalName, displayName, attrs: Map lower-case
// column -> {displayName}}), the tables loaded for the statement. The callback of settings.format.displayNames is built with it.
export function displayNameLabels(entities) {
  return (table, column, info) => {
    const schema = info && typeof info.schema === 'string' ? info.schema.toLowerCase() : null;
    if (schema !== null && schema !== 'dbo' && schema !== 'archive' && schema !== 'bin') return null;
    const ent = typeof table === 'string' && entities && typeof entities.get === 'function' ? entities.get(table.toLowerCase()) : null;
    if (!ent || typeof ent !== 'object') return null;
    const a = ent.attrs && typeof ent.attrs.get === 'function' && typeof column === 'string' ? ent.attrs.get(column.toLowerCase()) : null;
    const an = a && typeof a.displayName === 'string' ? a.displayName.trim() : '';
    if (!an) return null;
    const tn = typeof ent.displayName === 'string' && ent.displayName.trim() ? ent.displayName.trim() : String(ent.logicalName || table);
    return `${an} (${tn})`;
  };
}

// Caret offset in `out` (src formatted, with display names added) for offset `pos` of src: the same place in the
// same token, skipping the `AS [label]` pairs the names added; right after a token stays right after it, and white
// space or a comment before a token maps to the start of that token. mapCaret() when the tokens do not align.
export function mapFormatted(src, out, pos) {
  const sig = s => tokenize(s, true).filter(t => t.t !== 'ws' && t.t !== 'cmt' && t.t !== 'end');
  const a = sig(src), b = sig(out);
  const p = Math.max(0, Math.min(Number(pos) || 0, src.length));
  const same = (x, y) => x.t === y.t && (x.t === 'id' ? x.k === y.k : x.v === y.v);
  let k = 0;
  while (k < a.length && a[k].e <= p) k++;   // the first token that ends after the caret
  const prev = k - 1;
  const need = k < a.length ? k : prev;
  const at = new Array(a.length).fill(-1);
  for (let i = 0, j = 0; i <= need;) {
    if (j < b.length && same(a[i], b[j])) { at[i++] = j++; continue; }
    if (j + 1 < b.length && b[j].t === 'id' && b[j].k === 'AS' && b[j + 1].t === 'qid') { j += 2; continue; }
    return mapCaret(src, out, p);
  }
  if (prev >= 0 && a[prev].e === p) return b[at[prev]].e;
  if (k < a.length) return a[k].s < p ? b[at[k]].s + Math.min(p - a[k].s, b[at[k]].e - b[at[k]].s) : b[at[k]].s;
  if (prev < 0) return Math.min(p, out.length);
  return Math.min(out.length, b[at[prev]].e + (p - a[prev].e));
}

// Regex source matching `s` literally (a find query seeded from the selection in regex mode).
export function escapeRegex(s) {
  return String(s).replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

// ------------------------------------------------------------------------------------------------- edit helpers
// Every command is an edit {from, to, text, sel: [start, end]}: text replaces [from, to) of the old text in one
// insertText step (one undo step), then the new selection is set.

// First and last offsets of the whole lines covered by a selection (a selection ending at the start of a line does
// not include that line).
export function lineBlock(text, s, e) {
  const start = lineStartOf(text, s);
  let end = e;
  if (e > s && e === lineStartOf(text, e) && e > start) end = e - 1;
  return { start, end: lineEndOf(text, Math.max(end, s)) };
}

// New position of offset x after per-line operations [{at, del, ins}] (sorted); `lead` keeps x at an insertion point.
function mapThrough(x, ops, lead) {
  let d = 0;
  for (const o of ops) {
    if (o.del) {
      if (x >= o.at + o.del) d -= o.del;
      else if (x > o.at) d -= x - o.at;
    } else if (x > o.at || (x === o.at && !lead)) d += o.ins;
  }
  return x + d;
}

// Edit of a block of lines by per-line operations, mapping the selection through them.
function blockEdit(text, s, e, start, end, ops, newText) {
  return { from: start, to: end, text: newText, sel: s === e ? [mapThrough(s, ops, false), mapThrough(s, ops, false)] : [mapThrough(s, ops, true), mapThrough(e, ops, false)] };
}

// Comment commands (03 §5): mode 'toggle' (Mod+/), 'add' (Ctrl+K Ctrl+C) or 'remove' (Ctrl+K Ctrl+U); null when
// nothing changes. Adding puts `-- ` on every line of the block (blank lines too, as SSMS), at the smallest
// indentation of its non-blank lines (a shorter blank line gets it at its end); toggle removes one level when every
// non-blank line is commented (a blank line has nothing to uncomment), else adds.
export function commentEdit(text, s, e, mode = 'toggle') {
  const { start, end } = lineBlock(text, s, e);
  const lines = text.slice(start, end).split('\n');
  const blank = lines.map(l => l.trim() === '');
  const allBlank = blank.every(Boolean);
  const commented = l => /^\s*--/.test(l);
  const add = mode === 'add' || (mode === 'toggle' && (allBlank || lines.some((l, i) => !blank[i] && !commented(l))));
  if (mode === 'remove' || !add) {
    const ops = [];
    let off = start;
    const out = lines.map(l => {
      const m = /^(\s*)--( ?)/.exec(l);
      const lineAt = off;
      off += l.length + 1;
      if (!m) return l;
      ops.push({ at: lineAt + m[1].length, del: 2 + m[2].length });
      return m[1] + l.slice(m[0].length);
    });
    return ops.length ? blockEdit(text, s, e, start, end, ops, out.join('\n')) : null;
  }
  let indent = Infinity;
  lines.forEach((l, i) => { if (allBlank || !blank[i]) indent = Math.min(indent, /^\s*/.exec(l)[0].length); });
  const ops = [];
  let off = start;
  const out = lines.map(l => {
    const lineAt = off;
    off += l.length + 1;
    const at = Math.min(indent, l.length);
    ops.push({ at: lineAt + at, ins: 3 });
    return l.slice(0, at) + '-- ' + l.slice(at);
  });
  return blockEdit(text, s, e, start, end, ops, out.join('\n'));
}

// Tab (03 §5): a selection over several lines indents every non-empty line by 4 spaces; otherwise spaces up to the
// next 4-column tab stop replace the selection.
export function tabEdit(text, s, e) {
  if (s !== e && text.slice(s, e).includes('\n')) {
    const { start, end } = lineBlock(text, s, e);
    const lines = text.slice(start, end).split('\n');
    const ops = [];
    let off = start;
    const out = lines.map(l => {
      const at = off;
      off += l.length + 1;
      if (!l.length) return l;
      ops.push({ at, ins: TAB });
      return INDENT + l;
    });
    return blockEdit(text, s, e, start, end, ops, out.join('\n'));
  }
  const ls = lineStartOf(text, s);
  const n = TAB - (advance(text, ls, s) % TAB);
  return { from: s, to: e, text: ' '.repeat(n), sel: [s + n, s + n] };
}

// Shift+Tab (03 §5): removes up to 4 leading spaces, or one leading tab, from every line of the block; null when
// nothing changes.
export function outdentEdit(text, s, e) {
  const { start, end } = lineBlock(text, s, e);
  const lines = text.slice(start, end).split('\n');
  const ops = [];
  let off = start;
  const out = lines.map(l => {
    const at = off;
    off += l.length + 1;
    const n = l[0] === '\t' ? 1 : /^ {0,4}/.exec(l)[0].length;
    if (!n) return l;
    ops.push({ at, del: n });
    return l.slice(n);
  });
  return ops.length ? blockEdit(text, s, e, start, end, ops, out.join('\n')) : null;
}

// Enter (03 §5): the new line keeps the indentation, plus one level after `(`, BEGIN, CASE, BEGIN TRY or BEGIN
// CATCH (tokensBefore: the line's tokens before the caret); `(|)` opens an indented line between the parentheses;
// inside a string or a quoted identifier (ctx 'string' / 'ident') a bare newline: indentation there would become part
// of the value or of the name.
export function enterEdit(text, s, e, tokensBefore = [], ctx = 'code') {
  if (ctx === 'string' || ctx === 'ident') return { from: s, to: e, text: '\n', sel: [s + 1, s + 1] };
  const ls = lineStartOf(text, s);
  const indent = /^[ \t]*/.exec(text.slice(ls, s))[0];
  const sig = tokensBefore.filter(t => t.t !== 'ws' && t.t !== 'cmt');
  const last = sig[sig.length - 1], prev = sig[sig.length - 2];
  const paren = !!last && last.t === 'op' && last.v === '(';
  const open = paren || (!!last && last.t === 'id' && (last.k === 'BEGIN' || last.k === 'CASE' ||
    ((last.k === 'TRY' || last.k === 'CATCH') && !!prev && prev.t === 'id' && prev.k === 'BEGIN')));
  const inner = indent + (open ? INDENT : '');
  if (paren && text[s - 1] === '(' && text[e] === ')') {
    const ins = '\n' + inner + '\n' + indent;
    return { from: s, to: e, text: ins, sel: [s + 1 + inner.length, s + 1 + inner.length] };
  }
  const ins = '\n' + inner;
  return { from: s, to: e, text: ins, sel: [s + ins.length, s + ins.length] };
}

// Duplicate line(s) (Mod+D): the block is copied below itself and the selection moves to the copy.
export function duplicateEdit(text, s, e) {
  const { start, end } = lineBlock(text, s, e);
  const block = text.slice(start, end);
  const d = block.length + 1;
  return { from: end, to: end, text: '\n' + block, sel: [s + d, e + d] };
}

// Move line(s) up (dir -1) or down (dir 1) (Alt+↑/↓); null at the first/last line.
export function moveLinesEdit(text, s, e, dir) {
  const { start, end } = lineBlock(text, s, e);
  const block = text.slice(start, end);
  if (dir < 0) {
    if (start === 0) return null;
    const ps = lineStartOf(text, start - 1);
    const prev = text.slice(ps, start - 1);
    const d = -(prev.length + 1);
    return { from: ps, to: end, text: block + '\n' + prev, sel: [s + d, e + d] };
  }
  if (end >= text.length) return null;
  const ne = lineEndOf(text, end + 1);
  const next = text.slice(end + 1, ne);
  const d = next.length + 1;
  return { from: start, to: ne, text: next + '\n' + block, sel: [s + d, e + d] };
}

// Delete line(s) (Mod+Shift+K); the caret keeps its column on the line that takes their place.
export function deleteLinesEdit(text, s, e) {
  if (!text) return null;
  const { start, end } = lineBlock(text, s, e);
  const col = s - lineStartOf(text, s);
  if (end < text.length) {
    const next = text.slice(end + 1, lineEndOf(text, end + 1));
    const c = start + Math.min(col, next.length);
    return { from: start, to: end + 1, text: '', sel: [c, c] };
  }
  if (start > 0) {
    const ps = lineStartOf(text, start - 1);
    const c = ps + Math.min(col, start - 1 - ps);
    return { from: start - 1, to: end, text: '', sel: [c, c] };
  }
  return { from: 0, to: end, text: '', sel: [0, 0] };
}

// Typing an auto-close character (03 §5): overtype a closer the editor inserted (`pending` offsets), or insert the
// pair when the next character is whitespace, the end or `)`, outside strings and comments (ctx), and not `'` after
// an identifier character. null leaves the key to the browser.
export function autoCloseEdit(text, s, e, ch, { ctx = 'code', pending = [], autoClose = true } = {}) {
  if (s !== e) return null;
  if ((ch === ')' || ch === ']' || ch === "'" || ch === '"') && text[s] === ch && pending.includes(s)) {
    return { from: s, to: s, text: '', sel: [s + 1, s + 1], overtype: true };
  }
  const close = CLOSERS.get(ch);
  if (!autoClose || !close || ctx !== 'code') return null;
  const next = text[s];
  if (!(next === undefined || next === ' ' || next === '\t' || next === '\n' || next === ')')) return null;
  if (ch === "'" && isWordBefore(text, s)) return null;
  return { from: s, to: s, text: ch + close, sel: [s + 1, s + 1], closer: s + 1 };
}

// ----------------------------------------------------------------------------------------------------- CSS

// Editor CSS (03 §1.3: .ed- classes only, token colours only).
export const CSS = `.ed-root{position:relative;flex:1 1 auto;align-self:stretch;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--ed-bg);color:var(--ed-fg);--ed-fs:13px;--ed-lh:20px}
.ed-sc{position:absolute;inset:0;overflow:auto;scrollbar-gutter:stable;overscroll-behavior:contain}
.ed-in{position:relative;display:flex;align-items:flex-start;min-width:100%;min-height:100%}
.ed-root::after{content:'';position:absolute;inset:0;z-index:4;pointer-events:none;transition:box-shadow .1s}
.ed-root:has(.ed-ta:focus)::after{box-shadow:inset 0 -2px 0 var(--brand)}
.ed-gut{position:sticky;left:0;z-index:3;flex:none;box-sizing:border-box;background:var(--ed-gutter-bg);border-right:1px solid var(--ed-gutter-s);color:var(--ed-gutter-fg);font-family:var(--ed-font-family,var(--mono));font-size:var(--ed-fs);line-height:var(--ed-lh);user-select:none;cursor:default;transition:border-color .1s}
.ed-root:has(.ed-ta:focus) .ed-gut{border-right-color:var(--brand)}
.ed-gi{position:absolute;left:0;right:0;top:0}
.ed-gn{position:relative;box-sizing:border-box;min-height:var(--ed-lh);padding:0 12px 0 18px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;cursor:pointer}
.ed-gn.ed-on{color:var(--ed-gutter-fg-active)}
.ed-gm{position:absolute;left:6px;top:calc(var(--ed-lh) / 2 - 3px);width:6px;height:6px;border-radius:50%;background:var(--red)}
.ed-gm.ed-w{background:var(--sx-warn)}
.ed-ct{position:relative;flex:1 0 auto;min-width:0}
.ed-deco{position:absolute;inset:0;z-index:0;pointer-events:none;overflow:hidden}
.ed-cl{position:absolute;left:0;right:0;background:var(--ed-line)}
.ed-gd{position:absolute;inset:0}
.ed-ig{position:absolute;top:0;left:0;width:1px;background:var(--ed-indent)}
.ed-dk{position:absolute;inset:0}
.ed-dl{position:absolute;left:0;right:0;box-sizing:border-box;padding:0 ${PAD_R}px 0 ${PAD_L}px;color:transparent}
.ed-ta{position:absolute;left:0;top:0;z-index:1;display:block;box-sizing:border-box;margin:0;border:0;border-radius:0;outline:0;resize:none;overflow:hidden;padding:${PAD_T}px ${PAD_R}px 0 ${PAD_L}px;background:transparent;color:transparent;-webkit-text-fill-color:transparent;caret-color:var(--ed-caret);box-shadow:none;appearance:none}
.ed-ta::selection{background:var(--ed-sel);color:transparent}
.ed-ta:not(:focus)::selection{background:var(--ed-sel-blur)}
.ed-root.ed-finding .ed-ta::selection{background:transparent}
.ed-pre{position:absolute;left:0;right:0;top:0;z-index:2;box-sizing:border-box;margin:0;border:0;padding:0 ${PAD_R}px 0 ${PAD_L}px;background:none;color:var(--ed-fg);pointer-events:none;contain:layout style}
.ed-l{min-height:var(--ed-lh)}
.ed-mir{position:absolute;left:${PAD_L}px;top:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;contain:strict}
.ed-mir>div{min-height:var(--ed-lh)}
.ed-mw{position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none}
.ed-ms{position:absolute;left:0;top:0;white-space:pre}
.ed-ta,.ed-pre,.ed-dl,.ed-mir,.ed-ms{font-family:var(--ed-font-family,var(--mono));font-size:var(--ed-fs);line-height:var(--ed-lh);font-weight:400;font-style:normal;letter-spacing:0;word-spacing:0;tab-size:${TAB};text-indent:0;text-transform:none;text-align:left;direction:ltr;font-variant-ligatures:none;font-kerning:none;font-feature-settings:normal}
.ed-ta,.ed-pre,.ed-dl,.ed-mir{white-space:pre;overflow-wrap:normal;word-break:normal}
.ed-root.ed-wrap :is(.ed-ta,.ed-pre,.ed-dl,.ed-mir){white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal}
.ed-match{background:var(--ed-find);border-radius:2px}
.ed-match.cur{background:var(--ed-find-cur);outline:1px solid var(--ed-find-cur-s)}
.ed-br{background:var(--ed-bracket);outline:1px solid var(--ed-bracket-s);border-radius:2px}
.ed-inv{position:relative}
.ed-inv::before{content:'';position:absolute;left:-1px;top:2px;bottom:2px;width:2px;border-radius:1px;background:var(--red)}
.ed-eol{position:relative}
.ed-tip{max-width:480px;padding:6px 8px;font-size:12px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.ed-eol::after{content:'\\00a0\\00a0';position:absolute;left:1px;top:0;text-decoration:inherit;text-underline-offset:3px}
.ed-find{position:absolute;top:0;right:20px;z-index:5;display:flex;align-items:flex-start;gap:2px;box-sizing:border-box;width:380px;max-width:calc(100% - 28px);padding:4px;background:var(--bg1);color:var(--fg1);border:1px solid var(--s2);border-top:0;border-radius:0 0 6px 6px;box-shadow:var(--sh16);font-size:13px;line-height:20px;animation:ed-drop .12s ease-out}
.ed-find.ed-goto{width:300px}
.ed-fx{align-self:stretch;width:20px;height:auto;min-height:28px}
.ed-fx svg{transform:rotate(-90deg);transition:transform .1s}
.ed-fx[aria-expanded=true] svg{transform:none}
.ed-fcol{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.ed-frow{display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-width:0}
.ed-fin{flex:1 1 0;min-width:0;height:28px;gap:2px;padding:0 2px 0 8px;font-size:13px}
.ed-tg{flex:none;display:inline-grid;place-items:center;min-width:24px;height:22px;padding:0 3px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--fg2);font:600 12px/1 var(--mono);cursor:pointer}
.ed-tg:hover{background:var(--bg3);color:var(--fg1)}
.ed-tg[aria-pressed=true]{background:var(--brand-bg);color:var(--brand);border-color:var(--brand)}
.ed-tg:focus-visible{outline:2px solid var(--focus);outline-offset:-1px}
.ed-tg.ed-ww{text-decoration:underline;text-underline-offset:2px}
.ed-fc{flex:none;min-width:64px;padding:0 4px;font-size:12px;line-height:16px;color:var(--fg3);white-space:nowrap}
.ed-fc.ed-bad{flex-basis:100%;order:9;white-space:normal;color:var(--red)}
.ed-find .ed-fb{width:24px;height:24px}
.ed-find .ed-rb{height:28px;padding:0 8px;font-size:13px}
@keyframes ed-drop{from{opacity:0;transform:translateY(-8px)}}
@media (prefers-reduced-motion:reduce){.ed-find{animation:none}.ed-fx svg,.ed-gut,.ed-root::after{transition:none}}
@media (forced-colors:active){.ed-ta{forced-color-adjust:none;caret-color:CanvasText}.ed-ta::selection,.ed-ta:not(:focus)::selection{background:Highlight}.ed-match,.ed-br{outline:1px solid CanvasText}.ed-root:has(.ed-ta:focus)::after{outline:2px solid Highlight;outline-offset:-2px}.ed-ig{display:none}}
`;

// ------------------------------------------------------------------------------------------------- the editor

const px = n => n + 'px';
const raf = fn => (typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame(fn) : setTimeout(fn, 0));
const cancelRaf = id => (typeof globalThis.cancelAnimationFrame === 'function' ? globalThis.cancelAnimationFrame(id) : clearTimeout(id));
const isMac = () => globalThis.navigator?.userAgentData?.platform === 'macOS';
const norm = s => String(s ?? '').replace(/\r\n?/g, '\n');
const lineHeightFor = fs => Math.round(fs * 20 / 13);

// debounce(fn, ms) (util.js, 03 §1.1) that also tells whether a call is waiting: f.pending().
function tracked(fn, ms) {
  let waiting = false;
  const d = debounce(() => { waiting = false; fn(); }, ms);
  const f = () => { waiting = true; d(); };
  f.cancel = () => { waiting = false; d.cancel(); };
  f.pending = () => waiting;
  return f;
}

// Large arrays are rebuilt instead of spliced with spread arguments (a spread of 100,000 items overflows the stack).
function splice(arr, at, del, items) {
  if (items.length < 2000) { arr.splice(at, del, ...items); return arr; }
  return arr.slice(0, at).concat(items, arr.slice(at + del));
}

// Puts exactly `els` as the children of `parent`, in order, reusing the nodes already there.
function reconcile(parent, els) {
  const kids = parent.childNodes;
  if (kids.length === els.length) {
    let same = true;
    for (let k = 0; k < els.length; k++) if (kids[k] !== els[k]) { same = false; break; }
    if (same) return;
  }
  const keep = new Set(els);
  for (const c of [...kids]) if (!keep.has(c)) parent.removeChild(c);
  for (let k = 0; k < els.length; k++) {
    const cur = parent.childNodes[k];
    if (cur !== els[k]) parent.insertBefore(els[k], cur || null);
  }
}

function setStyle(el, prop, v) { if (el.style[prop] !== v) el.style[prop] = v; }

// The CSS font-family value for settings.editorFont (03 §5): the list with `, monospace` appended (unless it
// already ends in monospace), or null when the value is not a valid editorFont (03 §8.1 pattern, and a list the
// browser accepts as font-family, through CSS.supports where the platform has it).
export function editorFontFamily(value) {
  if (typeof value !== 'string' || !SETTINGS.editorFont.pattern.test(value)) return null;
  const items = value.split(',');
  const last = items[items.length - 1].trim().toLowerCase();
  const family = last === 'monospace' ? value : value + ', monospace';
  const css = globalThis.CSS;
  if (css && typeof css.supports === 'function') {
    try { if (!css.supports('font-family', family)) return null; } catch { return null; }
  }
  return family;
}

// Settings the editor reads (03 §8.1), validated: fontSize 11..18, editorFont (editorFontFamily) and the booleans
// wordWrap, autoClose and showWarnings; anything else keeps the value in `base`. hoverCards is complete.js's:
// it turns off the hover cards, not the editor's Diagnostics tooltip (03 §5).
function editorSettings(s, base) {
  const o = { ...base };
  if (s && typeof s === 'object') {
    if (Number.isFinite(s.fontSize)) o.fontSize = Math.min(18, Math.max(11, Math.round(s.fontSize)));
    if (editorFontFamily(s.editorFont) !== null) o.editorFont = s.editorFont;
    for (const k of ['wordWrap', 'autoClose', 'showWarnings']) if (typeof s[k] === 'boolean') o[k] = s[k];
  }
  return o;
}

// Creates the SQL editor in `host` (03 §1.4, §5). See the notes at the top of this file for the options and members beyond 03 §1.4.
export function createEditor(host, opts = {}) {
  const o = opts || {};
  let settings = editorSettings(o.settings, { fontSize: 13, editorFont: SETTINGS.editorFont.default, wordWrap: false, autoClose: true, showWarnings: true });
  const meta = o.meta || null;
  let qi = o.quotedIdentifier !== false;   // the query tab's Session.opts.quotedIdentifier

  // ---- DOM
  const ta = h('textarea', {
    class: 'ed-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', wrap: 'off',
    'aria-label': 'SQL editor', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-haspopup': 'listbox',
    'data-scope': 'editor',
  });
  const gi = h('div', { class: 'ed-gi' });
  const gut = h('div', { class: 'ed-gut', 'aria-hidden': 'true' }, gi);
  const curLine = h('div', { class: 'ed-cl', hidden: true });
  const gd = h('div', { class: 'ed-gd' });
  const dk = h('div', { class: 'ed-dk' });
  const deco = h('div', { class: 'ed-deco', 'aria-hidden': 'true' }, curLine, gd, dk);
  const pre = h('pre', { class: 'ed-pre', 'aria-hidden': 'true' });
  const mir = h('div', { class: 'ed-mir', 'aria-hidden': 'true' });
  // The cell-width probe sits in a zero-size clipping box, so its 64 columns never widen the scrollable area.
  const meas = h('span', { class: 'ed-ms' });
  const ct = h('div', { class: 'ed-ct' }, deco, ta, pre, mir, h('div', { class: 'ed-mw', 'aria-hidden': 'true' }, meas));
  const inner = h('div', { class: 'ed-in' }, gut, ct);
  const sc = h('div', { class: 'ed-sc' }, inner);
  const root = h('div', { class: 'ed-root' }, sc);
  host.appendChild(root);

  // ---- text model and caches (arrays aligned with `lines`)
  let text = '';
  let version = 0;
  let lines = [''];
  let starts = null;                 // line start offsets (lazy)
  let st = [LINE0];                  // start state of each line; valid below validTo
  let tk = [null];                   // token cache {tokens, s, end, cls, cv, rg, deps, dv, dsig}
  let sm = [null];                   // line summaries for the diagnostics (lineSummary), valid for st[i]
  let validTo = 1, convFrom = 0, convTo = 0;
  let rows = [1];                    // visual rows per line (word wrap)
  let need = [0];                    // 1 = row count still to be measured in the mirror
  let needCount = 0;
  let cw = [0];                      // display columns per line (width without word wrap)
  let maxCols = 0;
  let lc = [null];                   // rendered line cache {key, el, text, rs?, other}
  let cached = 0;
  let tops = null;                   // prefix sums of row heights (word wrap)
  let classVersion = 0;
  let stmtCache = null;

  // ---- view state
  let fs = settings.fontSize, lh = lineHeightFor(fs), charW = 0, charExact = false, gutW = 0, wrapCols = Infinity;
  let wrap = false;
  let mcur = 0;                      // where the sliced measurement continues
  const lastSize = { w: -1, h: -1, cw: -1, ch: -1 };   // viewport and content box sizes last applied
  let rendered = { first: 0, last: -1 };
  let gsig = [];
  const decoCache = new Map();
  const wrapCache = new Map();       // line -> {text, cols, rs}: wrapRows of long rendered lines
  let longShown = false;             // a rendered line is highlighted around the view only (longRange)
  let domW = 0;                      // px: the widest rendered line as measured (checkWidth), 0 until one overflows
  let otherShown = false;            // a rendered line has characters beyond Latin-1 (MEASURE_RE)
  let guideSig = '';
  let frame = 0;
  let revealCaret = false;
  let pendingReveal = null;          // {pos, center}
  let keepLine = null;               // {line, dy}: keep this line at this viewport offset (word-wrap toggle)
  let lastSel = [-1, -1, ''];
  let bracket = null;                // [offset, offset]
  let pending = [];                  // closers the editor inserted (offsets)
  const markers = new Map();         // source -> markers
  let shown = [];                    // visible markers, sorted
  let shortMarkers = [], longMarkers = [], shortSpan = 0;   // `shown` split by length (lineMarkers)
  let tabFocus = false, tabEscape = false;
  let invalid = false;               // aria-invalid is set (an error marker is shown)
  let inputSynced = false;           // an input event synced the model since the last render
  let inExec = false;
  let editHint = null;               // where the next text change happens (textDiff hint)
  let silentSync = false;
  let destroyed = false;
  let measureGen = 0;
  const hooks = new Set();
  let hoverPt = null, hoverFrame = 0;
  let tip = null, tipTimer = 0, leaveTimer = 0;   // the open hover tooltip {off, msg, handle} and its timers
  // The work done so far (workState(), an inspection hook): lines tokenized whole, long lines re-lexed around an
  // edit (relexLine), tokens classified, lines built as DOM and lines measured in the mirror (03 §13: a keystroke costs
  // a few lines of each, whatever the size of the script).
  const work = { lexed: 0, relexed: 0, classified: 0, built: 0, measured: 0 };
  const gutTips = new Map();         // gutter row element -> its markers' messages (opts.tooltip)
  const gutUnbind = new Map();       // gutter row element -> unbind function of its tooltip
  let gutDrag = null;

  // ---- line model ------------------------------------------------------------------------------------------

  function getStarts() {
    if (!starts) {
      starts = new Array(lines.length);
      let p = 0;
      for (let i = 0; i < lines.length; i++) { starts[i] = p; p += lines[i].length + 1; }
    }
    return starts;
  }
  const lineOf = off => lineIndexAt(getStarts(), off);
  const rowsOf = i => (wrap ? rows[i] : 1);

  function ensureTops() {
    if (!tops) {
      tops = new Float64Array(lines.length + 1);
      for (let i = 0; i < lines.length; i++) tops[i + 1] = tops[i] + rows[i] * lh;
    }
    return tops;
  }
  const topOf = i => (wrap ? ensureTops()[i] : i * lh);
  const totalHeight = () => (wrap ? ensureTops()[lines.length] : lines.length * lh);

  // Line whose rows contain y (px below the first line's top), clamped to the text.
  function lineAtY(y) {
    const n = lines.length;
    if (!wrap) return Math.max(0, Math.min(n - 1, Math.floor(y / lh)));
    const t = ensureTops();
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid] <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function estimateRows(i) { return wrapRows(lines[i], wrapCols).length; }

  // Replaces old lines a..b with newLines in every aligned cache and moves the highlighting frontier. `edit` ({s, oe,
  // ne}, offsets in line a) is given for an edit inside one line: a long line is then re-lexed only around it.
  function spliceLines(a, b, newLines, edit = null) {
    const m = newLines.length, removed = b - a + 1, delta = m - removed;
    const oldValid = validTo;
    const old = a === b && m === 1 && edit && a < oldValid ? tk[a] : null;
    for (let i = a; i <= b; i++) if (lc[i]) cached--;
    const lostMax = cw.slice(a, b + 1).some(c => c >= maxCols);
    lines = splice(lines, a, removed, newLines);
    st = splice(st, a + 1, removed - 1, new Array(m - 1).fill(null));
    tk = splice(tk, a, removed, new Array(m).fill(null));
    sm = splice(sm, a, removed, new Array(m).fill(null));
    lc = splice(lc, a, removed, new Array(m).fill(null));
    if (old && newLines[0].length > LONG_LINE && stEq(old.s, st[a])) {
      const toks = relexLine(old.tokens, newLines[0], edit.s, edit.oe, edit.ne);
      work.relexed++;
      if (toks) tk[a] = { tokens: toks, s: old.s, end: old.end, cls: null, cv: -1 };
    }
    const ncw = newLines.map(l => advance(l, 0, l.length));
    cw = splice(cw, a, removed, ncw);
    if (lostMax) maxCols = cw.reduce((x, y) => Math.max(x, y), 0);
    else for (const c of ncw) if (c > maxCols) maxCols = c;
    for (let i = a; i <= b; i++) if (need[i]) needCount--;
    rows = splice(rows, a, removed, new Array(m).fill(1));
    need = splice(need, a, removed, new Array(m).fill(wrap ? 1 : 0));
    if (wrap) { for (let i = a; i < a + m; i++) rows[i] = estimateRows(i); needCount += m; }
    starts = null;
    tops = null;
    if (oldValid > b + 1) { convFrom = a + m; convTo = oldValid + delta; }
    else if (convTo > a + 1) {
      if (convFrom > b + 1) { convFrom += delta; convTo += delta; }
      else if (convFrom <= a) convTo = a + 1;
      else convFrom = convTo = 0;
    }
    validTo = Math.min(validTo, a + 1);
  }

  // Token cache of line i (its start state must be valid).
  function tokensOf(i) {
    let c = tk[i];
    const s0 = st[i];
    if (!c || !stEq(c.s, s0)) {
      const r = tokenizeLine(lines[i], s0);
      work.lexed++;
      c = tk[i] = { tokens: r.tokens, s: s0, end: r.state, cls: null, cv: -1 };
    }
    return c;
  }

  // End state of line i (its start state must be valid) from the token cache or the summary; else the line is lexed
  // and only its summary is kept (lines far from the view keep no tokens).
  function endStateOf(i) {
    const c = tk[i];
    if (c && stEq(c.s, st[i])) return c.end;
    const m = sm[i];
    if (m && stEq(m.s, st[i])) return m.end;
    const r = tokenizeLine(lines[i], st[i]);
    work.lexed++;
    sm[i] = lineSummary(r.tokens, st[i], r.state, lines[i]);
    return r.state;
  }

  // Makes the start states of lines 0..upTo valid, stopping early when they converge with the old ones.
  function ensureStates(upTo) {
    upTo = Math.min(upTo, lines.length - 1);
    while (validTo <= upTo) {
      const next = endStateOf(validTo - 1);
      if (validTo >= convFrom && validTo < convTo && st[validTo] && stEq(st[validTo], next)) {
        validTo = convTo;
        convFrom = convTo = 0;
        continue;
      }
      st[validTo] = next;
      validTo++;
    }
  }

  function lineTokens(i) { ensureStates(i); return tokensOf(i).tokens; }

  // Diagnostics summary of line i (lineSummary; ensureStates(i) first).
  function summaryAt(i) {
    const m = sm[i];
    if (m && stEq(m.s, st[i])) return m;
    const c = tk[i];
    if (c && stEq(c.s, st[i])) return (sm[i] = lineSummary(c.tokens, st[i], c.end, lines[i]));
    endStateOf(i);
    return sm[i];
  }

  // back(k) for line i: the k-th significant token before the line's start (k = 0: the nearest), looking at most
  // CTX_LINES lines and CTX_TOKENS tokens back; null past that or the start of the text. Walks lazily, once.
  function backWalker(i) {
    const got = [];
    let j = i, ts = null, x = -1, n = 0;
    return k => {
      if (k >= CTX_TOKENS) return null;
      while (got.length <= k) {
        if (x < 0) {
          if (--j < 0 || n++ >= CTX_LINES) return null;
          ts = lineTokens(j);
          x = ts.length - 1;
          continue;
        }
        const t = ts[x--];
        if (isSig(t)) got.push(t);
      }
      return got[k];
    };
  }

  // What a decision about another line can see of a token (classifyName): its type, an operator's text, a keyword, a
  // data type name and the few names that matter by identity (DEP_NAMES); any other name is just a name, so renaming
  // a column on one line does not re-render the lines below it.
  const depSig = t => {
    if (!t) return '-';
    if (t.t === 'op') return 'op:' + t.v;
    if (t.t === 'id') return 'id:' + (KEYWORDS.has(t.k) || DEP_NAMES.has(t.k) || TYPE_NAMES.has(t.k.toLowerCase()) ? t.k : '');
    if (t.t === 'qid') { const u = String(t.v).toUpperCase(); return 'qid:' + (DEP_NAMES.has(u) ? u : ''); }
    return t.t;
  };

  // Highlighting context of line i (classifyTokens ctx) that records what it was asked into `deps`.
  function hlCtx(i, deps) {
    const walk = backWalker(i);
    const asked = new Set();
    return {
      back(k) {
        const t = walk(k);
        if (!asked.has(k)) { asked.add(k); deps.push({ k, sig: depSig(t) }); }
        return t;
      },
      tail() {
        const v = goTailClean(lineTokens, i + 1, lines.length);
        deps.push({ tail: v });
        return v;
      },
    };
  }

  // True while what line i's classes were computed from (other lines' tokens) is unchanged.
  function depsHold(i, deps) {
    const walk = backWalker(i);
    for (const d of deps) {
      if ('tail' in d) { if (goTailClean(lineTokens, i + 1, lines.length) !== d.tail) return false; }
      else if (depSig(walk(d.k)) !== d.sig) return false;
    }
    return true;
  }

  function isTable(name, qual) {
    if (qual !== null) {
      const q = String(qual).toLowerCase();
      if (q === 'metadata') {
        metaNames = metaNames || new Set(META_TABLES.map(t => t.name.toLowerCase()));
        return metaNames.has(String(name).toLowerCase());
      }
      if (q !== 'archive' && q !== 'bin' && q !== 'dbo') return false;
    }
    if (!meta || typeof meta.findEntity !== 'function') return false;
    let e = null;
    try { e = meta.findEntity(name); } catch { e = null; }
    return !!e && e.logicalName === String(name).toLowerCase();
  }

  // Token classes of line i (cached with the line's tokens): for all tokens, or for the token range `rg` of a long
  // line. A line whose classes depended on other lines (hlCtx) is classified again when those answers change.
  function classesOf(i, rg = null) {
    const c = tokensOf(i);
    const sameRange = rg ? !!c.rg && c.rg[0] === rg[0] && c.rg[1] === rg[1] : !c.rg;
    if (c.cls && c.cv === classVersion && sameRange) {
      if (!c.deps || c.dv === version) return c.cls;
      if (depsHold(i, c.deps)) { c.dv = version; return c.cls; }
    }
    const deps = [];
    work.classified += rg ? Math.max(0, Math.min(rg[1], c.tokens.length) - rg[0]) : c.tokens.length;
    c.cls = classifyTokens(c.tokens, isTable, hlCtx(i, deps), rg, qi ? null : { quotedIdentifier: false, line: lines[i], inQuote: st[i].quote });
    c.cv = classVersion;
    c.rg = rg;
    c.deps = deps.length ? deps : null;
    c.dv = version;
    c.dsig = deps.map(d => ('tail' in d ? 't' + (d.tail ? 1 : 0) : d.k + '=' + d.sig)).join(',');
    return c.cls;
  }

  // ---- text sync ---------------------------------------------------------------------------------------------

  // Brings the model up to date with the textarea's value; true when the text changed.
  function sync() {
    const v = ta.value;
    const hint = editHint;
    editHint = null;
    if (v === text) return false;
    const d = textDiff(text, v, hint);
    const ss = getStarts();
    const a = lineIndexAt(ss, d.start);
    const b = lineIndexAt(ss, d.oldEnd);
    const delta = d.newEnd - d.oldEnd;
    const oldEndB = ss[b] + lines[b].length;
    const edit = a === b ? { s: d.start - ss[a], oe: d.oldEnd - ss[a], ne: d.newEnd - ss[a] } : null;
    spliceLines(a, b, v.slice(ss[a], oldEndB + delta).split('\n'), edit);
    text = v;
    version++;
    stmtCache = null;
    dropTip();
    for (const [src, list] of markers) markers.set(src, src === 'run' ? [] : shiftRanges(list, d.start, d.oldEnd, d.newEnd));
    mergeMarkers();
    F.onText(d);
    pending = shiftPoints(pending, d.start, d.oldEnd, d.newEnd);
    bracket = null;
    lastSel = [-1, -1, ''];
    if (!silentSync) {
      parseSoon();
      if (typeof o.onChange === 'function') o.onChange(text);
    }
    schedule();
    return true;
  }

  // ---- markers -----------------------------------------------------------------------------------------------

  function mergeMarkers() {
    const all = [];
    for (const list of markers.values()) for (const m of list) if (m.level === 'error' || settings.showWarnings) all.push(m);
    all.sort((x, y) => x.start - y.start || x.end - y.end);
    shown = all;
    shortMarkers = [];
    longMarkers = [];
    shortSpan = 0;
    for (const m of all) {
      const span = m.end - m.start;
      if (span > LONG_MARKER) longMarkers.push(m);
      else { shortMarkers.push(m); if (span > shortSpan) shortSpan = span; }
    }
    const err = all.some(m => m.level === 'error');
    // Written only when it changes: every attribute write on the textarea costs a style pass over its text.
    if (err !== invalid) { invalid = err; if (err) ta.setAttribute('aria-invalid', 'true'); else ta.removeAttribute('aria-invalid'); }
  }

  function cleanMarkers(list) {
    const n = text.length;
    const out = [];
    for (const m of Array.isArray(list) ? list : []) {
      if (!m || typeof m !== 'object') continue;
      const s = Math.max(0, Math.min(Number.isFinite(m.start) ? Math.floor(m.start) : 0, n));
      const e = Math.max(s, Math.min(Number.isFinite(m.end) ? Math.floor(m.end) : s, n));
      out.push({ start: s, end: e, level: m.level === 'warn' ? 'warn' : 'error', message: String(m.message ?? '') });
    }
    return out.sort((x, y) => x.start - y.start || x.end - y.end);
  }

  function setMarkers(list, source = 'parse') {
    markers.set(String(source), cleanMarkers(list));
    mergeMarkers();
    schedule();
  }

  // Markers of the lines first..last (Map line -> markers, in marker order; a marker covers every line it touches, a
  // zero-length one the line it sits on): a binary search finds the first short marker that can reach the lines,
  // so a render never walks the markers above the view.
  function lineMarkers(first, last) {
    const out = new Map();
    if (!shown.length) return out;
    const ss = getStarts();
    const a = ss[first], b = ss[last] + lines[last].length;
    const add = m => {
      if (m.start > b || (m.end <= a && !(m.start === m.end && m.start >= a))) return;
      const l0 = Math.max(first, lineIndexAt(ss, m.start));
      const l1 = Math.min(last, m.end > m.start ? lineIndexAt(ss, m.end - 1) : l0);
      for (let i = l0; i <= l1; i++) { const list = out.get(i); if (list) list.push(m); else out.set(i, [m]); }
    };
    let lo = 0, hi = shortMarkers.length;
    const from = a - shortSpan;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (shortMarkers[mid].start < from) lo = mid + 1; else hi = mid; }
    const list = [];
    for (let k = lo; k < shortMarkers.length && shortMarkers[k].start <= b; k++) list.push(shortMarkers[k]);
    if (longMarkers.length) {
      for (const m of longMarkers) list.push(m);
      list.sort((x, y) => x.start - y.start || x.end - y.end);
    }
    for (const m of list) add(m);
    return out;
  }

  function markersAt(off) {
    return shown.filter(m => (m.start <= off && off < m.end) || (m.start === m.end && m.start === off));
  }

  // ---- diagnostics (03 §5, §13): 300 ms after typing stops the script is parsed by units (scriptUnits), reusing the
  // results of every unit whose text is unchanged, in slices of at most 8 ms; a run the text has changed under is
  // dropped (the edit has scheduled the next one).
  let diagCache = new Map(), diagGen = 0;
  const diagStats = { runs: 0, parses: 0, running: false };

  function* diagSteps(onParse) {
    const n = lines.length;
    for (let i = 0; i < n; i++) {
      ensureStates(i);
      summaryAt(i);
      if ((i & 1023) === 1023) yield null;
    }
    const ss = getStarts();
    const batches = scriptUnits(sm, ss, text.length);
    yield null;
    const used = new Map();
    const tokensFor = i => {
      if (tk[i] && stEq(tk[i].s, st[i])) return tk[i].tokens;
      work.lexed++;
      return tokenizeLine(lines[i], st[i]).tokens;
    };
    const mode = { quotedIdentifier: qi };
    const out = yield* diagnoseUnits(text, batches, { cache: diagCache, used, onParse, quotedIdentifier: qi, invisibles: (a, b) => invisibleIn(text, a, b, sm, ss, tokensFor, mode) });
    diagCache = used;
    return out;
  }

  function runDiagnostics() {
    const g = ++diagGen, ver = version;
    let parses = 0;
    const it = diagSteps(() => { parses++; });
    diagStats.running = true;
    let t = performance.now();
    const step = () => {
      for (;;) {
        const r = it.next();
        if (r.done) {
          diagStats.running = false;
          diagStats.runs++;
          diagStats.parses = parses;
          markers.set('parse', cleanMarkers(r.value));
          mergeMarkers();
          schedule();
          return;
        }
        if (performance.now() - t > SLICE_MS) {
          yieldToUi().then(() => {
            if (g !== diagGen || ver !== version || destroyed) { if (g === diagGen) diagStats.running = false; return; }
            t = performance.now();
            step();
          });
          return;
        }
      }
    };
    step();
  }

  const parseSoon = debounce(() => { if (!destroyed) runDiagnostics(); }, PARSE_MS);

  // ---- edits -------------------------------------------------------------------------------------------------

  function activeEl() {
    const r = root.getRootNode && root.getRootNode();
    return (r && r.activeElement) || document.activeElement;
  }
  function focusTa() { if (activeEl() !== ta) ta.focus({ preventScroll: true }); }
  // The selection: a snapshot taken once per render (each read of selectionStart / selectionEnd makes Chromium map
  // the selection into the textarea's text, about 0.15 ms at 2 MB), else the textarea's own.
  let selSnap = null;
  const caretOf = () => (selSnap ? (selSnap[2] === 'backward' ? selSnap[0] : selSnap[1]) : ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd);

  // Applies an edit as one insertText step (native undo), then sets its selection; `restore` puts focus back.
  // execCommand acts on the focused element, so it runs only while the textarea really has focus. When it cannot
  // take focus (the editor is inert behind an open dialog, or hidden), the edit is set directly: the text, the view
  // and onChange are right at once, but Chromium drops the textarea's undo history on such a change.
  function applyEdit(ed, { restore = false, reveal = true } = {}) {
    if (!ed) return false;
    const back = restore ? activeEl() : null;
    if (ed.from !== ed.to || ed.text) {
      if (ta.value !== text) sync();
      focusTa();
      const expected = text.slice(0, ed.from) + ed.text + text.slice(ed.to);
      editHint = { start: ed.from };
      if (activeEl() === ta) {
        ta.setSelectionRange(ed.from, ed.to);
        inExec = true;
        try {
          if (typeof document.execCommand === 'function') {
            if (ed.text) document.execCommand('insertText', false, ed.text); else document.execCommand('delete', false);
          }
        } catch { /* set directly below */ } finally { inExec = false; }
      }
      if (ta.value !== expected) { editHint = { start: ed.from }; ta.value = expected; }
      sync();
    }
    const n = text.length;
    ta.setSelectionRange(Math.min(ed.sel[0], n), Math.min(ed.sel[1], n));
    if (reveal) revealCaret = true;
    schedule();
    if (back && back !== ta && typeof back.focus === 'function') back.focus({ preventScroll: true });
    return true;
  }

  const sel = () => (selSnap ? [selSnap[0], selSnap[1]] : [ta.selectionStart, ta.selectionEnd]);

  function lineCtx(pos) {
    const i = lineOf(pos);
    ensureStates(i);
    return contextAt(tokensOf(i).tokens, pos - getStarts()[i], st[i], qi ? null : { quotedIdentifier: false, line: lines[i] });
  }

  function tokensBefore(pos) {
    const i = lineOf(pos);
    const col = pos - getStarts()[i];
    return lineTokens(i).filter(t => t.e <= col);
  }

  // ---- rendering ---------------------------------------------------------------------------------------------

  function schedule() { if (!frame && !destroyed) frame = raf(render); }

  // Width of one cell of the probe's font, from a 64-character run; 0 while the editor is not laid out.
  function cellWidth() {
    meas.textContent = '0'.repeat(64);
    const r = meas.getBoundingClientRect();
    return r && r.width > 0 ? r.width / 64 : 0;
  }

  // Monospace cell width; until the editor is laid out (0 px) an estimate stands in and render() measures again. The
  // first exact measurement also runs a monospace check that applyFont() could not run yet (fontCheck): a font that
  // fails it gives way to the default stack, as in applyFont().
  function measureChar() {
    let w = cellWidth(), refusedNow = false;
    if (w > 0 && fontCheck) {
      const f = fontCheck;
      fontCheck = '';
      if (f === family && monospaced() === false) {
        refuseFont(f);
        refusedNow = true;
        domW = 0;
        tops = null;
        w = cellWidth();
      }
    }
    const prev = charW;
    charExact = w > 0;
    charW = charExact ? w : Math.round(fs * 0.6 * 100) / 100;
    if ((prev && prev !== charW) || refusedNow) {
      gutW = 0;
      lastSize.cw = -1;
      if (wrap) { reestimate(); remeasure(); }
    }
  }

  function viewSize() { return { w: sc.clientWidth || 0, h: sc.clientHeight || 0 }; }

  function contentWidth(view) { return Math.max(0, view.w - gutW); }

  function computeWrapCols(view) {
    const inner = contentWidth(view) - PAD_L - PAD_R;
    return inner > 0 && charW > 0 ? Math.max(1, Math.floor((inner + 0.01) / charW)) : Infinity;
  }

  // Estimated rows of every line for the current width, until the mirror measures them: wrapRows() for every line,
  // or, above 1 MB (a resize must not cost a pass over every character), for the lines around the view only and the
  // line's column count divided by the row width for the rest.
  function reestimate() {
    wrapCols = computeWrapCols(viewSize());
    if (text.length > BIG && Number.isFinite(wrapCols)) {
      const a = rendered.first - MARGIN, b = rendered.last + MARGIN;
      for (let i = 0; i < lines.length; i++) rows[i] = i >= a && i <= b ? estimateRows(i) : Math.max(1, Math.ceil(cw[i] / wrapCols));
    } else for (let i = 0; i < lines.length; i++) rows[i] = estimateRows(i);
    for (const c of lc) if (c) c.rs = null;
    wrapCache.clear();
    tops = null;
  }

  // Queues every line for measurement in the mirror (word wrap turned on; 100 ms after a width or font change).
  function measureAll() {
    need = new Array(lines.length).fill(1);
    needCount = lines.length;
    mcur = 0;
    measureGen++;
  }

  const remeasure = debounce(() => { if (wrap && !destroyed) { measureAll(); schedule(); } }, RESIZE_MS);

  // Measures the given lines' row counts in the hidden mirror (an element of 0 px height reads as unmeasurable).
  function measureLines(list) {
    if (!list.length) return false;
    let changed = false;
    work.measured += list.length;
    setStyle(mir, 'width', px(Math.max(0, contentWidth(viewSize()) - PAD_L - PAD_R)));
    const CH = 2000;
    for (let k = 0; k < list.length; k += CH) {
      const part = list.slice(k, k + CH);
      while (mir.childNodes.length < part.length) mir.appendChild(h('div'));
      while (mir.childNodes.length > part.length) mir.removeChild(mir.lastChild);
      part.forEach((i, j) => { mir.childNodes[j].textContent = lines[i]; });
      part.forEach((i, j) => {
        const hgt = mir.childNodes[j].offsetHeight;
        if (need[i]) { need[i] = 0; needCount--; }
        if (hgt > 0) {
          const r = Math.max(1, Math.round(hgt / lh));
          if (r !== rows[i]) { rows[i] = r; changed = true; }
        }
      });
    }
    clear(mir);
    if (changed) tops = null;
    return changed;
  }

  function neededLines(limit = Infinity, from = 0, to = lines.length - 1) {
    const out = [];
    for (let i = Math.max(0, from); i <= to && out.length < limit; i++) if (need[i]) out.push(i);
    return out;
  }

  // The next `limit` lines still to measure, scanning on from the last batch (wrapping around once).
  function nextNeeded(limit) {
    const out = [];
    const n = lines.length;
    if (mcur >= n) mcur = 0;
    for (let k = 0; k < n && out.length < limit; k++, mcur = (mcur + 1) % n) if (need[mcur]) out.push(mcur);
    return out;
  }

  let measuring = false;
  async function measureSliced(gen) {
    measuring = true;
    const t0 = performance.now();
    let clearStatus = null;
    const total = Math.max(1, needCount);
    try {
      while (needCount > 0 && gen === measureGen && !destroyed && wrap) {
        const t = performance.now();
        while (needCount > 0 && performance.now() - t < SLICE_MS) {
          const batch = nextNeeded(200);
          if (!batch.length) { needCount = 0; break; }
          if (measureLines(batch)) schedule();
        }
        if (typeof o.status === 'function' && performance.now() - t0 > PROGRESS_MS && needCount > 0) {
          const r = o.status(`Wrapping lines… ${Math.floor(100 * (1 - needCount / total))}%`, { ms: 2000 });
          clearStatus = typeof r === 'function' ? r : null;
        }
        await yieldToUi();
      }
    } finally {
      measuring = false;
      // Only the editor's own progress text is cleared (shell.status returns its clear function), never what another
      // module shows by then.
      if (clearStatus) clearStatus();
    }
  }

  function measureIfNeeded() {
    if (!wrap || needCount <= 0) return;
    if (text.length <= BIG) { measureLines(neededLines()); return; }
    const near = neededLines(Infinity, rendered.first - MARGIN, rendered.last + MARGIN);
    if (near.length) measureLines(near);
    if (!measuring && needCount > 0) measureSliced(measureGen);
  }

  function layoutSizes() {
    const view = viewSize();
    const digits = Math.max(2, String(lines.length).length);
    const gw = Math.ceil(digits * charW) + GUT_PAD;
    if (gw !== gutW) {
      gutW = gw;
      setStyle(gut, 'width', px(gw));
    }
    if (wrap && computeWrapCols(view) !== wrapCols) { reestimate(); remeasure(); }
    const cWidth = contentWidth(view);
    // Without word wrap the width follows the longest line in steps of 32 columns: a width change re-lays out the
    // whole textarea, which must not happen on every keystroke at the end of the longest line. While every line
    // (plus the caret's two columns) fits, the content is exactly as wide as the view: no horizontal scrollbar.
    // domW: rendered lines measured wider than their cells (checkWidth) widen the content too.
    const step = WIDTH_STEP * charW;
    const fits = PAD_L + (maxCols + 2) * charW + PAD_R <= cWidth && domW <= cWidth;
    const w = wrap || fits ? cWidth : Math.max(cWidth, Math.ceil(PAD_L + Math.ceil((maxCols + 2) / WIDTH_STEP) * step + PAD_R),
      domW > 0 && step > 0 ? Math.ceil(Math.ceil(domW / step) * step) : 0);
    const textH = PAD_T + totalHeight();
    const H = Math.max(view.h, textH + lh);
    if (w !== lastSize.cw) { setStyle(ct, 'width', px(w)); setStyle(ta, 'width', px(w)); lastSize.cw = w; }
    if (H !== lastSize.ch) { setStyle(ct, 'height', px(H)); setStyle(ta, 'height', px(H)); setStyle(gut, 'height', px(H)); lastSize.ch = H; }
    lastSize.w = view.w;
    lastSize.h = view.h;
  }

  function render() {
    frame = 0;
    if (destroyed) return;
    // An 'input' event has already synced the model (sync); otherwise the value is checked (a defensive read).
    if (!inputSynced && ta.value !== text) sync();
    inputSynced = false;
    selSnap = [ta.selectionStart, ta.selectionEnd, ta.selectionDirection || 'none'];
    let caretNote = null;
    try {
      if (!charExact) measureChar();
      measureIfNeeded();
      layoutSizes();
      caretNote = checkCaret();
      applyReveal();
      const view = viewSize();
      const y0 = (sc.scrollTop || 0) - PAD_T;
      const vh = view.h > 0 ? view.h : lh * MARGIN;
      const first = Math.max(0, lineAtY(Math.max(0, y0)) - MARGIN);
      const last = Math.min(lines.length - 1, lineAtY(Math.max(0, y0 + vh)) + MARGIN);
      ensureStates(last);
      rendered = { first, last };
      const lineMs = lineMarkers(first, last);
      renderText(first, last, lineMs);
      renderGutter(first, last, lineMs);
      renderGuides(first, last);
      renderDeco(first, last);
      sweep(first, last);
      if (!wrap && otherShown) checkWidth();
    } finally {
      selSnap = null;
    }
    // The host hears of a caret move last, after every read of the frame: its own DOM writes (the status bar) never
    // force a layout inside the editor's render (03 §13).
    if (caretNote && typeof o.onCaret === 'function') o.onCaret(caretNote);
  }

  // Glyphs from fallback fonts (emoji, CJK, Thai, …) can be wider than the cells charCols() gives them: when a rendered
  // line overflows the content width, the content grows to it (the textarea never scrolls itself, so the end of that
  // line, and the caret there, would be clipped). Checked only while a rendered line has characters beyond Latin-1
  // (MEASURE_RE; ASCII and Latin-1 text is exactly as wide as its cells), and read after every write of the frame,
  // so it adds no layout pass. The width only grows (in WIDTH_STEP steps), until another text is loaded or the font
  // size changes.
  function checkWidth() {
    const inner = pre.clientWidth || 0, sw = pre.scrollWidth || 0;
    if (!(inner > 0) || sw <= inner + 1) return;
    const need = Math.ceil(sw + PAD_R + 2 * charW);
    if (need > domW) { domW = need; lastSize.cw = -1; schedule(); }
  }

  // What a rendered line shows: its start state, classes, highlighted range, text and its markers, these by where they
  // fall on the line (clamped as paintLine draws them), so an edit above a marked line that only moves its markers
  // with the text never rebuilds it.
  function lineKey(i, ms, c, rg) {
    const s = st[i];
    let k = (s.cmt || '') + (s.quote || '') + '\u0001' + classVersion + '\u0001' + (c.dsig || '') + '\u0001' + (rg ? rg[0] + '-' + rg[1] : '') + '\u0001';
    if (ms) {
      const ls = getStarts()[i], n = lines[i].length;
      for (const m of ms) {
        const a = Math.max(0, Math.min(m.start - ls, n));
        k += a + ':' + Math.max(a, Math.min(m.end - ls, n)) + m.level[0] + ',';
      }
    }
    return k + '\u0001' + lines[i];
  }

  // Offset in `line` where display column `col` starts (tab stops of 4, wide characters 2 columns).
  function offsetOfCol(line, col) {
    let c = 0;
    for (let i = 0; i < line.length;) {
      if (c >= col) return i;
      const ch = line.charCodeAt(i);
      if (ch === 9) { c += TAB - (c % TAB); i++; continue; }
      const [cp, len] = cpAt(line, i);
      c += charCols(cp);
      i += len;
    }
    return line.length;
  }

  // Row starts of a long line for the current wrap width (wrapRows), cached while the line and the width stay.
  function wrappedRows(i) {
    const e = wrapCache.get(i);
    if (e && e.text === lines[i] && e.cols === wrapCols) return e.rs;
    const rs = wrapRows(lines[i], wrapCols);
    wrapCache.set(i, { text: lines[i], cols: wrapCols, rs });
    return rs;
  }

  // Token range [k0, k1) of a long line to highlight (03 §13): the characters around the visible columns (word wrap
  // off) or rows (word wrap on), widened to whole blocks of LONG_BLOCK characters on each side, so a short scroll
  // keeps the rendered line. The rest of the line is plain text (it still sits there, so the layers stay aligned).
  function longRange(i, toks) {
    const [a, b] = longWindow(i);
    let lo = 0, hi = toks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (toks[mid].e <= a) lo = mid + 1; else hi = mid; }
    const k0 = lo;
    hi = toks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (toks[mid].s < b) lo = mid + 1; else hi = mid; }
    return [k0, lo];
  }

  // Character window [a, b) of a long line around the view (see longRange); decorations are drawn only inside it.
  function longWindow(i) {
    const line = lines[i], n = line.length;
    const view = viewSize();
    let o0, o1;
    if (!wrap) {
      const left = sc.scrollLeft || 0, vw = view.w > 0 ? view.w : 2000;
      const c0 = Math.max(0, Math.floor((left - PAD_L) / charW)), c1 = Math.ceil((left + vw) / charW);
      if (cw[i] === n) { o0 = c0; o1 = c1; } else { o0 = offsetOfCol(line, c0); o1 = offsetOfCol(line, c1); }
    } else {
      const rs = wrappedRows(i);
      const top = PAD_T + topOf(i), y = sc.scrollTop || 0, vh = view.h > 0 ? view.h : lh * 40;
      const r0 = Math.min(rs.length - 1, Math.max(0, Math.floor((y - top) / lh)));
      const r1 = Math.min(rs.length - 1, Math.max(0, Math.ceil((y + vh - top) / lh)));
      o0 = rs[r0];
      o1 = r1 + 1 < rs.length ? rs[r1 + 1] : n;
    }
    return [Math.max(0, (Math.floor(o0 / LONG_BLOCK) - 1) * LONG_BLOCK), Math.min(n, (Math.ceil(o1 / LONG_BLOCK) + 1) * LONG_BLOCK)];
  }

  function buildLine(i, ms, rg) {
    work.built++;
    const c = tokensOf(i);
    const t = lines[i];
    const ls = getStarts()[i];
    const decos = ms ? ms.map(m => ({ s: m.start - ls, e: m.end - ls, cls: m.level === 'error' ? 't-err' : 't-warn' })) : [];
    return lineNode(t, paintLine(t, tokenPieces(c.tokens, classesOf(i, rg), st[i].quote, rg), decos));
  }

  function renderText(first, last, lineMs) {
    setStyle(pre, 'top', px(PAD_T + topOf(first)));
    const want = [];
    longShown = false;
    otherShown = false;
    for (let i = first; i <= last; i++) {
      const ms = lineMs.get(i) || null;
      const tc = tokensOf(i);
      const rg = lines[i].length > LONG_LINE ? longRange(i, tc.tokens) : null;
      if (rg) longShown = true;
      classesOf(i, rg);
      const key = lineKey(i, ms, tc, rg);
      let c = lc[i];
      if (!c || c.key !== key) {
        if (!c) cached++;
        c = lc[i] = { key, el: buildLine(i, ms, rg), text: lines[i], rs: null, other: MEASURE_RE.test(lines[i]) };
      }
      if (c.other) otherShown = true;
      want.push(c.el);
    }
    reconcile(pre, want);
  }

  function sweep(first, last) {
    if (cached <= (last - first + 1) * 3 + 400) return;
    cached = 0;
    for (let i = 0; i < lc.length; i++) {
      if (!lc[i]) continue;
      if (i < first - 200 || i > last + 200) lc[i] = null; else cached++;
    }
  }

  function renderGutter(first, last, lineMs) {
    setStyle(gi, 'top', px(PAD_T + topOf(first)));
    const cl = lineOf(caretOf());
    const count = last - first + 1;
    for (let k = 0; k < count; k++) {
      const i = first + k;
      let el = gi.childNodes[k];
      if (!el) {
        el = h('div', { class: 'ed-gn' });
        gi.appendChild(el);
        gsig[k] = null;
        // The messages of the row's markers in the shell's top-layer tooltip (03 §1.5), bound once per row element.
        if (typeof o.tooltip === 'function') {
          const row = el;
          try { const off = o.tooltip(row, () => gutTips.get(row) || ''); if (typeof off === 'function') gutUnbind.set(row, off); } catch { /* no tooltip */ }
        }
      }
      const ms = lineMs.get(i);
      const level = ms ? (ms.some(m => m.level === 'error') ? 'error' : 'warn') : '';
      const title = ms ? ms.map(m => m.message).join('\n') : '';
      const hgt = wrap ? rows[i] * lh : 0;
      const sig = i + '|' + (i === cl ? 1 : 0) + '|' + hgt + '|' + level + '|' + title;
      if (gsig[k] === sig) continue;
      gsig[k] = sig;
      el.className = i === cl ? 'ed-gn ed-on' : 'ed-gn';
      setStyle(el, 'height', hgt ? px(hgt) : '');
      clear(el);
      el.appendChild(document.createTextNode(String(i + 1)));
      if (level) {
        el.appendChild(h('span', { class: level === 'error' ? 'ed-gm' : 'ed-gm ed-w' }));
      }
      if (typeof o.tooltip === 'function') gutTips.set(el, title);
      else if (title) el.setAttribute('title', title);
      else el.removeAttribute('title');
    }
    while (gi.childNodes.length > count) {
      const el = gi.lastChild;
      const off = gutUnbind.get(el);
      if (off) { gutUnbind.delete(el); off(); }
      gutTips.delete(el);
      gi.removeChild(el);
    }
    gsig.length = count;
  }

  // Leading-whitespace columns of line i, or -1 for a blank line.
  function indentOf(i) {
    const l = lines[i];
    let c = 0, k = 0;
    for (; k < l.length; k++) {
      const ch = l.charCodeAt(k);
      if (ch === 32) c++;
      else if (ch === 9) c += TAB - (c % TAB);
      else break;
    }
    return k === l.length ? -1 : c;
  }

  // Indent guides (--ed-indent): a 1px line at every 4-column level inside a line's indentation; a
  // blank line takes the smaller indentation of the nearest non-blank lines above and below. One element per run of
  // lines, so a render adds a handful of nodes.
  function renderGuides(first, last) {
    const n = last - first + 1;
    if (n <= 0) return;
    const lv = new Array(n);
    for (let k = 0; k < n; k++) lv[k] = indentOf(first + k);
    const outside = (i, dir) => {
      for (let j = i, c = 0; j >= 0 && j < lines.length && c < GUIDE_SCAN; j += dir, c++) { const v = indentOf(j); if (v >= 0) return v; }
      return 0;
    };
    const above = new Array(n), below = new Array(n);
    let gap = 0, prev = outside(first - 1, -1);
    for (let k = 0; k < n; k++) {
      if (lv[k] >= 0) { prev = lv[k]; gap = 0; } else if (++gap > GUIDE_SCAN) prev = 0;
      above[k] = prev;
    }
    gap = 0;
    let next = outside(last + 1, 1);
    for (let k = n - 1; k >= 0; k--) {
      if (lv[k] >= 0) { next = lv[k]; gap = 0; } else if (++gap > GUIDE_SCAN) next = 0;
      below[k] = next;
    }
    const cols = k => (lv[k] >= 0 ? lv[k] : Math.min(above[k], below[k]));
    const runs = [];
    for (let level = 0; level < GUIDE_LEVELS; level++) {
      const c = level * TAB;
      let any = false;
      for (let k = 0; k <= n; k++) {
        const on = k < n && cols(k) > c;
        if (on) any = true;
        if (on && (k === 0 || !(cols(k - 1) > c))) runs.push([c, first + k, 0]);
        if (!on && k > 0 && cols(k - 1) > c) runs[runs.length - 1][2] = first + k - 1;
      }
      if (!any) break;
    }
    const sig = charW + '|' + lh + '|' + runs.map(r => r[0] + ':' + topOf(r[1]) + ':' + topOf(r[2] + 1)).join(',');
    if (sig === guideSig) return;
    guideSig = sig;
    while (gd.childNodes.length > runs.length) gd.removeChild(gd.lastChild);
    runs.forEach((r, k) => {
      let el = gd.childNodes[k];
      if (!el) { el = h('div', { class: 'ed-ig' }); gd.appendChild(el); }
      const top = PAD_T + topOf(r[1]);
      setStyle(el, 'left', px(Math.round(PAD_L + r[0] * charW)));
      setStyle(el, 'top', px(top));
      setStyle(el, 'height', px(PAD_T + topOf(r[2] + 1) - top));
    });
  }

  function renderDeco(first, last) {
    const [s, e] = sel();
    const cl = lineOf(caretOf());
    if (curLine.hidden !== (s !== e)) curLine.hidden = s !== e;
    if (s === e) {
      setStyle(curLine, 'top', px(PAD_T + topOf(cl)));
      setStyle(curLine, 'height', px(rowsOf(cl) * lh));
    }
    const ss = getStarts();
    const from = ss[first], to = ss[last] + lines[last].length;
    const vis = F.visible(from, to);
    const want = [];
    const seen = new Set();
    let mi = 0;
    for (let i = first; i <= last; i++) {
      const ls = ss[i], le = ls + lines[i].length;
      // A long line gets its decorations only around the view, like its highlighting (longRange).
      const [wa, wb] = lines[i].length > LONG_LINE ? longWindow(i).map(x => x + ls) : [ls, le];
      const decos = [];
      while (mi < vis.length && vis[mi].end <= ls) mi++;
      let k = mi;
      if (wa > ls) { let lo = mi, hi = vis.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (vis[mid].start < wa) lo = mid + 1; else hi = mid; } k = Math.max(mi, lo - 1); }
      for (; k < vis.length && vis[k].start <= Math.min(le, wb); k++) {
        const m = vis[k];
        if (m.end > Math.max(ls, wa) && m.end > m.start) decos.push({ s: m.start - ls, e: m.end - ls, cls: F.isCur(m) ? 'ed-match cur' : 'ed-match' });
      }
      if (bracket) for (const b of bracket) if (b >= ls && b < le && b >= wa && b < wb) decos.push({ s: b - ls, e: b - ls + 1, cls: 'ed-br' });
      if (!decos.length) continue;
      const top = px(PAD_T + topOf(i));
      const sig = top + '|' + decos.map(d => d.s + ':' + d.e + d.cls).join(',') + '|' + lines[i];
      let c = decoCache.get(i);
      if (!c || c.sig !== sig) {
        const el = lineNode(lines[i], paintLine(lines[i], [], decos, { inv: false }));
        el.className = 'ed-dl';
        el.style.top = top;
        c = { sig, el };
        decoCache.set(i, c);
      }
      seen.add(i);
      want.push(c.el);
    }
    for (const i of [...decoCache.keys()]) if (!seen.has(i)) decoCache.delete(i);
    reconcile(dk, want);
  }

  // ---- caret, geometry and scrolling -------------------------------------------------------------------------

  function checkCaret() {
    const [s, e, dir] = selSnap || [ta.selectionStart, ta.selectionEnd, ta.selectionDirection || 'none'];
    if (s === lastSel[0] && e === lastSel[1] && dir === lastSel[2]) return null;
    lastSel = [s, e, dir];
    const caret = dir === 'backward' ? s : e;
    const ss = getStarts();
    const line = lineIndexAt(ss, caret);
    pending = pending.filter(p => p >= caret && p <= ss[line] + lines[line].length);
    bracket = null;
    if (s === e) {
      const m = matchParen(lineTokens, lines.length, line, caret - ss[line]);
      if (m) { const s2 = getStarts(); bracket = [s2[m.a[0]] + m.a[1], s2[m.b[0]] + m.b[1]]; }
    }
    return { line: line + 1, col: caret - ss[line] + 1, start: s, end: e };
  }

  // The line cache entry of line i while its element shows the line as it is now, in the document (a Range can
  // measure it); null otherwise (not rendered, or an edit is waiting for the next frame).
  function renderedLine(i) {
    const c = lc[i];
    return c && c.el && c.text === lines[i] && c.el.isConnected && typeof document.createRange === 'function' ? c : null;
  }

  // Row start offsets (relative to the line) of line i: one row without word wrap; with it, the rendered line's
  // own row breaks when it is in the DOM (Range rects), else wrapRows().
  function rowStartsOf(i) {
    if (!wrap) return [0];
    const c = renderedLine(i);
    if (c) {
      const key = wrapCols + '|' + charW;
      if (c.rs && c.rsKey === key) return c.rs;
      try {
        const rs = domRowStarts(c.el, lines[i]);
        if (rs) { c.rs = rs; c.rsKey = key; return rs; }
      } catch { /* fall back to the computed breaks */ }
    }
    return wrapRows(lines[i], wrapCols);
  }

  // Text nodes of a rendered line element with their start offsets in the line (for Range measurements).
  function textNodesOf(el) {
    const nodes = [];
    let off = 0;
    const walk = n => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { nodes.push({ node: c, s: off }); off += c.data.length; } else walk(c);
      }
    };
    walk(el);
    return nodes;
  }

  // The text node (textNodesOf) holding offset k of its line.
  function nodeAt(nodes, k) {
    let lo = 0, hi = nodes.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nodes[mid].s <= k) lo = mid; else hi = mid - 1; }
    return nodes[lo];
  }

  // Bounding client rect of the characters [p, q) (q > p) of a rendered line through `range`, which may span several
  // of its text nodes: the union of their glyphs, wherever a right-to-left run has put them.
  function rangeRect(nodes, range, p, q) {
    const a = nodeAt(nodes, p), b = nodeAt(nodes, q - 1);
    range.setStart(a.node, p - a.s);
    range.setEnd(b.node, Math.min(q - b.s, b.node.data.length));
    return range.getBoundingClientRect();
  }

  // Client rect of the character at offset k of a rendered line (both halves of a surrogate pair), through `range`.
  function charRect(nodes, range, k, line) {
    return rangeRect(nodes, range, k, k + (k + 1 < line.length && isHigh(line.charCodeAt(k)) && isLow(line.charCodeAt(k + 1)) ? 2 : 1));
  }

  // A rendered line whose glyphs may not fill exactly their cells (MEASURE_RE: fallback fonts for Thai, Devanagari,
  // Arabic, Hebrew, CJK and emoji, joining marks, reordered right-to-left runs): its text nodes and a Range, so its
  // geometry is measured instead of computed; null otherwise.
  function domLine(i) {
    const lt = lines[i];
    if (!MEASURE_RE.test(lt)) return null;
    const c = renderedLine(i);
    if (!c) return null;
    const nodes = textNodesOf(c.el);
    return nodes.length ? { nodes, range: document.createRange(), lt, rtl: RTL_RE.test(lt) } : null;
  }

  // Offset of the code point before offset k of `s` (a surrogate pair counts as one).
  const prevCp = (s, k) => (k >= 2 && isLow(s.charCodeAt(k - 1)) && isHigh(s.charCodeAt(k - 2)) ? k - 2 : k - 1);

  // True when the caret before the character at k (client rect r) of a line with right-to-left text stands in a
  // right-to-left run: the nearest character after it on its row that takes room of its own is on its left, or the
  // nearest one before it is on its right (a mark that joins its base shares the base's rect and is skipped).
  function rtlBefore(d, k, r) {
    const lt = d.lt;
    const sameRow = x => Math.abs(x.top - r.top) < lh / 2;
    const apart = x => x.right > x.left && (x.left !== r.left || x.right !== r.right);
    for (let j = k + cpAt(lt, k)[1], n = 0; j < lt.length && n < 8; j += cpAt(lt, j)[1], n++) {
      const x = charRect(d.nodes, d.range, j, lt);
      if (!sameRow(x)) break;
      if (apart(x)) { if (x.right <= r.left + 0.5) return true; break; }
    }
    for (let j = prevCp(lt, k), n = 0; j >= 0 && n < 8; j = prevCp(lt, j), n++) {
      const x = charRect(d.nodes, d.range, j, lt);
      if (!sameRow(x)) break;
      if (apart(x)) return x.left >= r.right - 0.5;
    }
    return false;
  }

  // x (px from the content box's left edge) of the caret at column `col` of line i (whose visual row starts at `a`),
  // measured in the DOM (domLine), or null. Before a character the caret is at its left edge, or at its right edge in
  // a right-to-left run (rtlBefore); at the end of the line it is at the right edge of the line's last row.
  function domX(i, col, a = 0) {
    const d = domLine(i);
    if (!d) return null;
    try {
      const len = d.lt.length, left = ct.getBoundingClientRect().left;
      if (col >= len) {
        if (len <= a) return null;
        return (d.rtl ? rangeRect(d.nodes, d.range, a, len) : charRect(d.nodes, d.range, prevCp(d.lt, len), d.lt)).right - left;
      }
      const r = charRect(d.nodes, d.range, col, d.lt);
      return (d.rtl && r.right > r.left && rtlBefore(d, col, r) ? r.right : r.left) - left;
    } catch { return null; }
  }

  // Offset in line i of the character under clientX among the characters [a, b) of one visual row, measured in the
  // DOM (domLine): undefined when the line is not measured that way, null past the row's text. A bisection over the
  // bounding rects of halves of the row: in left-to-right text one half holds clientX at each step; in a reordered
  // right-to-left run both halves may, and the first in the text that has a character under it wins.
  function domOffset(i, a, b, clientX) {
    const d = domLine(i);
    if (!d || b <= a) return d ? null : undefined;
    try {
      const lt = d.lt;
      const holds = (p, q) => { const r = rangeRect(d.nodes, d.range, p, q); return clientX >= r.left && clientX < r.right; };
      const find = (p, q) => {   // [p, q) holds clientX
        const n = cpAt(lt, p)[1];
        if (p + n >= q) return p;
        let m = (p + q) >> 1;
        if (isLow(lt.charCodeAt(m)) && isHigh(lt.charCodeAt(m - 1))) m--;
        if (m <= p) m = p + n;
        if (holds(p, m)) { const x = find(p, m); if (x !== null) return x; }
        return holds(m, q) ? find(m, q) : null;
      };
      return holds(a, b) ? find(a, b) : null;
    } catch { return undefined; }
  }

  // Row breaks of a rendered line (text `lt`) from the client rects of its characters (binary search per row; a row
  // never starts between the halves of a surrogate pair).
  function domRowStarts(el, lt) {
    const len = lt.length;
    if (len === 0) return [0];
    const nodes = textNodesOf(el);
    const range = document.createRange();
    const topAt = k => charRect(nodes, range, k, lt).top;
    const out = [0];
    let rowTop = topAt(0);
    let k = 0;
    while (k < len - 1) {
      if (topAt(len - 1) <= rowTop + lh / 2) break;
      let lo = k + 1, hi = len - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (topAt(mid) > rowTop + lh / 2) hi = mid; else lo = mid + 1; }
      if (lo > k + 1 && isLow(lt.charCodeAt(lo)) && isHigh(lt.charCodeAt(lo - 1))) lo--;
      out.push(lo);
      k = lo;
      rowTop = topAt(lo);
    }
    return out;
  }

  // Line, visual row and x (px from the content box's left edge) of a caret position.
  function posGeom(pos) {
    const ss = getStarts();
    const line = lineIndexAt(ss, pos);
    const col = pos - ss[line];
    const rs = rowStartsOf(line);
    let row = 0;
    for (let r = 1; r < rs.length; r++) { if (rs[r] <= col) row = r; else break; }
    const dx = domX(line, col, rs[row]);
    const x = dx !== null ? dx : PAD_L + advance(lines[line], rs[row], col) * charW;
    return { line, row, x, y: PAD_T + topOf(line) + row * lh };
  }

  function applyReveal() {
    const view = viewSize();
    if (keepLine) {
      const k = keepLine;
      keepLine = null;
      if (view.h > 0) sc.scrollTop = Math.max(0, PAD_T + topOf(Math.min(k.line, lines.length - 1)) - k.dy);
    }
    if (pendingReveal) {
      const r = pendingReveal;
      pendingReveal = null;
      revealCaret = false;
      reveal(Math.min(r.pos, text.length), r.center);
    } else if (revealCaret) {
      revealCaret = false;
      reveal(caretOf(), false);
    }
  }

  function reveal(pos, center) {
    const view = viewSize();
    if (!(view.h > 0)) return;
    const g = posGeom(pos);
    const top = sc.scrollTop || 0;
    if (g.y < top || g.y + lh > top + view.h) {
      sc.scrollTop = center ? Math.max(0, Math.round(g.y - (view.h - lh) / 2)) : g.y < top ? Math.max(0, g.y - PAD_T) : g.y + lh - view.h + PAD_T;
    }
    if (!wrap && view.w > 0) {
      const left = sc.scrollLeft || 0;
      const visW = view.w - gutW;
      if (g.x < left + PAD_L) sc.scrollLeft = Math.max(0, Math.floor(g.x - PAD_L - 4 * charW));
      else if (g.x + charW > left + visW - PAD_R) sc.scrollLeft = Math.ceil(g.x + charW - visW + PAD_R + 4 * charW);
    }
  }

  function offsetAt(clientX, clientY) {
    if (!charW) measureChar();
    const r = ct.getBoundingClientRect();
    const x = clientX - r.left - PAD_L, y = clientY - r.top - PAD_T;
    if (!(x >= 0) || !(y >= 0) || y >= totalHeight()) return null;
    const line = lineAtY(y);
    const rs = rowStartsOf(line);
    const row = Math.floor((y - topOf(line)) / lh);
    if (row >= rs.length) return null;
    const lt = lines[line];
    const a = rs[row], b = row + 1 < rs.length ? rs[row + 1] : lt.length;
    const measured = domOffset(line, a, b, clientX);
    if (measured !== undefined) return measured === null ? null : getStarts()[line] + measured;
    const target = x / charW;
    let col = 0;
    for (let i = a; i < b;) {
      const c = lt.charCodeAt(i);
      const [cp, len] = cpAt(lt, i);
      const w = c === 9 ? TAB - (col % TAB) : charCols(cp);
      if (w && target < col + w) return getStarts()[line] + i;
      col += w;
      i += len;
    }
    return null;
  }

  function coordsAt(off) {
    if (!charW) measureChar();
    const g = posGeom(Math.max(0, Math.min(off, text.length)));
    const r = ct.getBoundingClientRect();
    return { left: r.left + g.x, top: r.top + g.y, bottom: r.top + g.y + lh, height: lh };
  }

  // PageUp / PageDown by the visible height (dir -1 / 1); `extend` keeps the selection anchor (Shift).
  function page(dir, extend) {
    const view = viewSize();
    const n = Math.max(1, Math.floor((view.h > 0 ? view.h : lh * 20) / lh) - 1);
    const caret = caretOf();
    const anchor = ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart;
    const g = posGeom(caret);
    const vr = Math.round((g.y - PAD_T) / lh) + dir * n;
    let target;
    if (vr < 0) target = 0;
    else if (vr * lh >= totalHeight()) target = text.length;
    else {
      const line = lineAtY(vr * lh);
      const rs = rowStartsOf(line);
      const row = Math.min(rs.length - 1, Math.max(0, vr - Math.round(topOf(line) / lh)));
      const lt = lines[line];
      const a = rs[row], b = row + 1 < rs.length ? rs[row + 1] : lt.length;
      const want = (g.x - PAD_L) / charW;
      let col = 0, i = a;
      while (i < b) {
        const [cp, len] = cpAt(lt, i);
        const w = lt.charCodeAt(i) === 9 ? TAB - (col % TAB) : charCols(cp);
        if (col + w / 2 > want) break;
        col += w;
        i += len;
      }
      target = getStarts()[line] + i;
    }
    const a = extend ? anchor : target;
    ta.setSelectionRange(Math.min(a, target), Math.max(a, target), target < a ? 'backward' : 'forward');
    if (view.h > 0) sc.scrollTop = Math.max(0, (sc.scrollTop || 0) + dir * n * lh);
    revealCaret = true;
    schedule();
  }

  function selectLines(a, b) {
    const ss = getStarts();
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const from = ss[lo], to = hi + 1 < lines.length ? ss[hi + 1] : text.length;
    ta.setSelectionRange(from, to, a <= b ? 'forward' : 'backward');
    schedule();
  }

  function lineAtClientY(cy) {
    const r = ct.getBoundingClientRect();
    const y = cy - r.top - PAD_T;
    return y < 0 ? 0 : y >= totalHeight() ? lines.length - 1 : lineAtY(y);
  }

  // ---- word wrap and settings ---------------------------------------------------------------------------------

  function setWrap(on) {
    if (on === wrap) return;
    const view = viewSize();
    const cl = lineOf(caretOf());
    const y = PAD_T + topOf(cl) - (sc.scrollTop || 0);
    keepLine = view.h > 0 && y >= 0 && y < view.h ? { line: cl, dy: y } : null;
    if (!keepLine) pendingReveal = { pos: caretOf(), center: true };
    wrap = on;
    root.classList.toggle('ed-wrap', on);
    ta.setAttribute('wrap', on ? 'soft' : 'off');
    tops = null;
    remeasure.cancel();
    if (on) { sc.scrollLeft = 0; reestimate(); measureAll(); } else { measureGen++; needCount = 0; need = new Array(lines.length).fill(0); }
    lastSize.cw = lastSize.ch = -1;
    schedule();
  }

  // Whether the editor font is monospaced: ten i's and ten W's measure the same in the probe (03 §5); null when
  // the probe cannot be measured (the editor is not laid out yet: created hidden or detached, or the window hidden).
  function monospaced() {
    meas.textContent = 'i'.repeat(10);
    const a = meas.getBoundingClientRect().width;
    meas.textContent = 'W'.repeat(10);
    const b = meas.getBoundingClientRect().width;
    if (!(a > 0 && b > 0)) return null;
    return Math.abs(a - b) < 0.5;
  }

  // Sets --ed-font-family on the editor from settings.editorFont (03 §5); true when it changed. Settings refuses
  // a font that is not monospaced; should one arrive anyway (a value stored by another tab), the editor keeps its
  // offsets right by using the default stack and says so. A font that cannot be checked yet is checked by
  // measureChar() once the editor is laid out (fontCheck).
  let family = '', refused = '', fontCheck = '';
  const defaultFamily = () => editorFontFamily(SETTINGS.editorFont.default);
  function refuseFont(f) {
    refused = f;   // said once; every later settings change keeps the default silently
    family = defaultFamily();
    root.style.setProperty('--ed-font-family', family);
    notify('The editor font is not monospaced; the editor uses the default font instead.', 'warn');
  }
  function applyFont() {
    const dflt = defaultFamily();
    let f = editorFontFamily(settings.editorFont) || dflt;
    if (f === refused) f = dflt;
    if (f === family) return false;
    const was = family;
    fontCheck = '';
    family = f;
    root.style.setProperty('--ed-font-family', f);
    if (f !== dflt) {
      const mono = monospaced();
      if (mono === false) refuseFont(f);
      else if (mono === null) fontCheck = f;
    }
    return family !== was;
  }

  function applySettings(next) {
    const prev = settings;
    settings = editorSettings(next, settings);
    const fontChanged = applyFont();
    if (settings.fontSize !== prev.fontSize || fontChanged || !charW) {
      fs = settings.fontSize;
      lh = lineHeightFor(fs);
      root.style.setProperty('--ed-fs', px(fs));
      root.style.setProperty('--ed-lh', px(lh));
      charW = 0;
      measureChar();
      gutW = 0;
      domW = 0;
      tops = null;
      lastSize.cw = lastSize.ch = -1;
      if (wrap) { reestimate(); remeasure(); }
    }
    if (settings.wordWrap !== wrap) setWrap(settings.wordWrap);
    if (settings.showWarnings !== prev.showWarnings) mergeMarkers();
    schedule();
  }

  // The query tab's QUOTED_IDENTIFIER mode (Session.opts.quotedIdentifier): with it off `"…"` is a string
  // literal for the highlighting, contextAt, the diagnostics, statementAt and Format.
  function setQuotedIdentifier(on) {
    const v = on !== false;
    if (v === qi) return;
    qi = v;
    classVersion++;
    stmtCache = null;
    diagGen++;
    diagStats.running = false;
    parseSoon();
    schedule();
  }

  // ---- find and replace (03 §5) ------------------------------------------------------------------------------

  const F = (() => {
    const lay = () => (state.layout && state.layout.find) || { matchCase: false, wholeWord: false, regex: false };
    let ui = null, gotoUi = null;
    let open = false, gotoOpen = false;
    let finder = { empty: true };
    let matches = [], capped = false, cur = null, msg = null, gen = 0, from = 0, ranVersion = -1, searching = false;
    let win = null;          // capped results: {a, b, gen, list}, the highlighted matches around the view (moved with edits)
    let queued = null;       // Next / Previous / Replace pressed while a sliced search runs: done() runs it
    let seekId = 0;          // the latest Next / Previous searching the text itself (capped results)
    const runSoon = tracked(() => run(), FIND_MS);
    // A sliced search the text changed under is run again once typing pauses; it never moves the selection.
    const rerunSoon = debounce(() => run(true, false), FIND_MS);

    // 'Next match (F3)': the key from opts.shortcut (KEYMAP, 03 §9), where no key (null or '') means the binding was
    // removed (04 §5 Edge check) and the title is the bare label; the built-in keys only without opts.shortcut.
    const title = (label, id) => {
      let key;
      if (CASCADE_KEYS.has(id)) key = CASCADE_KEYS.get(id);
      else if (typeof o.shortcut === 'function') key = o.shortcut(id);
      else { const d = DEFAULT_KEYS.get(id); key = d ? d[isMac() ? 1 : 0] : ''; }
      return typeof key === 'string' && key ? `${label} (${key})` : label;
    };
    const opts = () => ({ ...lay() });

    function build() {
      const rid = uid('edr');
      const q = h('input', { type: 'text', 'aria-label': 'Find', placeholder: 'Find', spellcheck: 'false', autocomplete: 'off' });
      const r = h('input', { type: 'text', 'aria-label': 'Replace', placeholder: 'Replace', spellcheck: 'false', autocomplete: 'off' });
      const tg = (label, text, key, cls) => h('button', { type: 'button', class: 'ed-tg' + (cls ? ' ' + cls : ''), title: label, 'aria-label': label, 'aria-pressed': 'false', text, onclick: () => toggle(key) });
      const mc = tg('Match case', 'Aa', 'matchCase');
      const ww = tg('Match whole word', 'ab', 'wholeWord', 'ed-ww');
      const rx = tg('Use regular expression', '.*', 'regex');
      const count = h('span', { class: 'ed-fc', role: 'status', 'aria-live': 'polite' });
      const ib = (name, label, id, onclick) => h('button', { type: 'button', class: 'btn subtle icon ed-fb', title: title(label, id), 'aria-label': label, onclick }, icon(name, 16));
      const prev = ib('up', 'Previous match', 'findPrev', () => step(-1));
      const next = ib('down', 'Next match', 'findNext', () => step(1));
      const close = ib('close', 'Close', 'closeFind', () => closeFind());
      const rep = h('button', { type: 'button', class: 'btn ed-rb', text: 'Replace', title: 'Replace (Enter)', onclick: () => replaceOne() });
      const repAll = h('button', { type: 'button', class: 'btn ed-rb', text: 'Replace all', onclick: () => replaceAll() });
      const rrow = h('div', { class: 'ed-frow', id: rid, hidden: true }, h('div', { class: 'input ed-fin' }, r), rep, repAll);
      const fx = h('button', { type: 'button', class: 'btn subtle icon ed-fx', title: title('Toggle replace', 'replace'), 'aria-label': 'Toggle replace', 'aria-expanded': 'false', 'aria-controls': rid, onclick: () => showReplace(rrow.hidden, true) }, icon('chevron', 16));
      const bar = h('div', { class: 'ed-find', role: 'search', 'aria-label': 'Find and replace', hidden: true },
        fx, h('div', { class: 'ed-fcol' }, h('div', { class: 'ed-frow' }, h('div', { class: 'input ed-fin' }, q, mc, ww, rx), count, prev, next, close), rrow));
      q.addEventListener('input', () => {
        msg = null;
        if (!lay().regex && text.length <= BIG) { runSoon.cancel(); run(); } else { invalidate(); runSoon(); }
      });
      q.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      });
      r.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) { e.preventDefault(); replaceOne(); }
      });
      bar.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeFind(); return; }
        barKey(e);
      });
      bar.addEventListener('focusin', () => root.classList.add('ed-finding'));
      bar.addEventListener('focusout', () => root.classList.remove('ed-finding'));
      root.appendChild(bar);
      return { bar, q, r, mc, ww, rx, count, prev, next, rep, repAll, rrow, fx };
    }

    function syncToggles() {
      const f = lay();
      ui.mc.setAttribute('aria-pressed', String(!!f.matchCase));
      ui.ww.setAttribute('aria-pressed', String(!!f.wholeWord));
      ui.rx.setAttribute('aria-pressed', String(!!f.regex));
    }

    // A toggle button: the three options are remembered in state.layout.find (03 §2, §10), the query never is.
    function toggle(key) {
      const f = lay();
      const next = { matchCase: f.matchCase === true, wholeWord: f.wholeWord === true, regex: f.regex === true };
      next[key] = !next[key];
      state.layout.find = next;
      save('layout');
      syncToggles();
      msg = null;
      runSoon.cancel();
      run();
    }

    function showReplace(on, focus) {
      if (!ui) return;
      ui.rrow.hidden = !on;
      ui.fx.setAttribute('aria-expanded', String(on));
      if (on && focus) { ui.r.focus(); ui.r.select(); }
    }

    function invalidate() { gen++; seekId++; }

    function setButtons() {
      const bad = !!finder.error;
      const none = !!finder.empty;
      ui.prev.disabled = bad || none;
      ui.next.disabled = bad || none;
      ui.rep.disabled = bad || none;
      ui.repAll.disabled = bad || none;
      ui.q.setAttribute('aria-invalid', String(bad));
    }

    function index(m) {
      let lo = 0, hi = matches.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (matches[mid].start < m.start) lo = mid + 1; else hi = mid; }
      return lo;
    }

    function setCount(txt) {
      if (ui.count.textContent !== txt) ui.count.textContent = txt;
      ui.count.title = txt;
    }

    function updateCount() {
      if (!ui) return;
      setButtons();
      let txt;
      if (msg) txt = msg;
      else if (searching) txt = 'Searching…';
      else {
        let idx = 0;
        if (matches.length) {
          const caret = Math.min(ta.selectionStart, ta.selectionEnd);
          idx = cur ? index(cur) : Math.min(index({ start: caret }), matches.length - 1);
        }
        txt = findCountText({ query: ui.q.value, error: finder.error || null, total: matches.length, index: idx, capped });
      }
      setCount(txt);
      ui.count.classList.toggle('ed-bad', !!finder.error);
    }

    // Runs the search for the current query and options over the whole text (sliced above 1 MB). `keepCur` keeps
    // the current match when it is still a match; otherwise, with `pick`, the first match at or after the search
    // start becomes current and is selected (typing a query), and without it nothing moves (opening the bar). While a
    // sliced search runs nothing old is highlighted or selected, Next / Previous / Replace wait for it, and an edit in
    // the editor makes it start again once typing pauses (never moving the selection).
    function run(keepCur = false, pick = true) {
      if (!ui) return;
      runSoon.cancel();
      rerunSoon.cancel();
      const g = ++gen;
      seekId++;
      finder = compileFind(ui.q.value, opts());
      win = null;
      ranVersion = version;
      if (finder.empty || finder.error) { matches = []; capped = false; cur = null; searching = false; queued = null; updateCount(); schedule(); return; }
      if (text.length <= BIG) {
        searching = false;
        done(findAll(text, finder, { limit: FIND_CAP }), keepCur, pick);
        return;
      }
      matches = [];
      capped = false;
      if (!keepCur) cur = null;
      searching = true;
      updateCount();
      schedule();
      const ver = version;
      (async () => {
        const out = [];
        let cap = false;
        let t = performance.now();
        const t0 = t;
        for (const x of scanMatches(text, finder)) {
          if (x) { if (out.length >= FIND_CAP) { cap = true; break; } out.push(x); }
          if (performance.now() - t > SLICE_MS) {
            if (performance.now() - t0 > PROGRESS_MS && ui) setCount(`Searching… ${fmtInt(out.length)}`);
            await yieldToUi();
            if (g !== gen || destroyed) return;
            if (ver !== version) { rerunSoon(); return; }
            t = performance.now();
          }
        }
        if (g !== gen || destroyed) return;
        if (ver !== version) { rerunSoon(); return; }
        searching = false;
        done({ matches: out, capped: cap }, keepCur, pick);
      })();
    }

    function done(r, keepCur, pick) {
      matches = r.matches;
      capped = r.capped;
      const after = () => {
        updateCount();
        schedule();
        if (queued) { const q = queued; queued = null; q(); }
      };
      if (keepCur || !pick) {
        const i = cur ? index(cur) : -1;
        cur = i >= 0 && i < matches.length && matches[i].start === cur.start && matches[i].end === cur.end ? matches[i] : null;
      } else if (matches.length) {
        const i = index({ start: from });
        if (i < matches.length || !capped) {
          cur = matches[i < matches.length ? i : 0];
          selectMatch(cur, true);
        } else {
          // Counting stopped before the caret: the first match after it is searched for in the text itself.
          cur = null;
          seek(1, from, from, m => { cur = m || matches[0]; selectMatch(cur, true); after(); });
          return;
        }
      } else cur = null;
      after();
    }

    function selectMatch(m, center) {
      ta.setSelectionRange(m.start, m.end);
      pendingReveal = { pos: m.start, center };
      schedule();
    }

    // Brings the matches up to date with an edited text before Next / Previous / Replace (03 §5: they re-run
    // matching). Up to 1 MB at once (false: go on); above it the sliced search starts and runs `cmd` when it is done
    // (true: the caller stops here).
    function fresh(cmd) {
      if (ranVersion === version || finder.empty || finder.error) return false;
      if (text.length <= BIG) { run(true); return false; }
      queued = cmd;
      run(true);
      return true;
    }

    // True when [s, e) is a match where it stands (regex: a sticky match at s; literal: the first match from s).
    function isMatchAt(s, e) {
      if (!(s < e)) return false;
      if (finder.regex) {
        const re = new RegExp(finder.re.source, finder.re.flags.replace('g', '') + 'y');
        re.lastIndex = s;
        const m = re.exec(text);
        return !!m && m.index === s && s + m[0].length === e && (!finder.wholeWord || wordBounded(text, s, e));
      }
      for (const x of scanMatches(text, finder, { from: s, to: s + 1 })) if (x) return x.start === s && x.end === e;
      return false;
    }

    // The next match in the text itself (capped results): from the selection's end when it is a match, else from
    // its start, wrapping around to the start of the text. Yields between chunks.
    function* seekNext(s, e) {
      const at = s !== e && isMatchAt(s, e) ? e : s;
      for (const x of scanMatches(text, finder, { from: at })) { if (x) return x; yield null; }
      for (const x of scanMatches(text, finder, { from: 0, to: at })) { if (x) { if (x.start < at) return x; } else yield null; }
      return null;
    }

    // The previous match in the text itself (capped results): the last one starting before s, searched backwards
    // in growing windows (keeping only the last match of a window), else the last one of the text. Yields often.
    function* seekPrev(s) {
      let last = null;
      for (let hi = s, w = SEEK_WINDOW; hi > 0; w *= 2) {
        const lo = Math.max(0, hi - w);
        for (const x of scanMatches(text, finder, { from: lo, to: hi })) { if (!x) { yield null; continue; } if (x.start < hi) last = x; }
        if (last) return last;
        hi = lo;
        yield null;
      }
      const n = text.length;
      for (let top = n, w = SEEK_WINDOW; ; w *= 2) {
        const lo = Math.max(s, top - w);
        for (const x of scanMatches(text, finder, { from: lo, to: top })) { if (!x) { yield null; continue; } if (x.start < top || top === n) last = x; }
        if (last) return last;
        if (lo <= s) return null;
        top = lo;
        yield null;
      }
    }

    // Next (dir 1) or previous (dir -1) match from the selection [s, e) in the text itself; above 1 MB in slices of
    // at most 8 ms (03 §13). cb(match | null); a newer search, an edit or closing the bar drops it.
    function seek(dir, s, e, cb) {
      const id = ++seekId, g = gen, ver = version;
      const it = dir > 0 ? seekNext(s, e) : seekPrev(s);
      let t = performance.now();
      const go = () => {
        for (;;) {
          const r = it.next();
          if (r.done) { cb(r.value); return; }
          if (text.length > BIG && performance.now() - t > SLICE_MS) {
            yieldToUi().then(() => {
              if (id !== seekId || g !== gen || ver !== version || destroyed || !open) return;
              t = performance.now();
              go();
            });
            return;
          }
        }
      };
      go();
    }

    function goTo(m) {
      cur = m;
      from = m.start;
      selectMatch(m, true);
      updateCount();
    }

    // Next (dir 1) or previous (dir -1) match from the selection; wraps around. With the bar closed (F3 / Shift+F3 in
    // the editor) the bar opens with its last query and the match is selected at once, focus staying in the editor;
    // without a query yet the bar opens for one (focused, as Mod+F).
    function step(dir) {
      if (!open) {
        if (!ui || !ui.q.value) { openFind({}); return; }
        reopen();
      }
      if (runSoon.pending()) { msg = null; run(false, true); return; }
      if (finder.empty || finder.error) return;
      if (searching) { queued = () => step(dir); return; }
      if (fresh(() => step(dir))) return;
      msg = null;
      const [s, e] = sel();
      if (!capped) {
        if (!matches.length) { updateCount(); return; }
        let m;
        if (dir > 0) {
          const i = index({ start: s });
          m = matches[i < matches.length ? i : 0];
          if (s !== e && m.start === s && m.end === e) m = matches[(i + 1) % matches.length];
        } else {
          const i = index({ start: s }) - 1;
          m = matches[i >= 0 ? i : matches.length - 1];
        }
        goTo(m);
        return;
      }
      seek(dir, s, e, m => { if (m) goTo(m); else updateCount(); });
    }

    function replaceOne() {
      if (!open) return;
      if (runSoon.pending()) { msg = null; run(false, true); return; }
      if (finder.empty || finder.error) return;
      if (searching) { queued = () => replaceOne(); return; }
      if (fresh(() => replaceOne())) return;
      msg = null;
      const [s, e] = sel();
      let m = null;
      if (s !== e) {
        const i = index({ start: s });
        if (i < matches.length && matches[i].start === s && matches[i].end === e) m = matches[i];
        else if (capped && isMatchAt(s, e)) m = { start: s, end: e, m: null };
      }
      if (!m) { step(1); return; }
      const rep = replacementFor(finder, text, m, ui.r.value);
      if (rep === null) { step(1); return; }
      applyEdit({ from: s, to: e, text: rep, sel: [s + rep.length, s + rep.length] }, { restore: true });
      from = s + rep.length;
      cur = null;
      run();
    }

    function replaceAll() {
      if (!open) return;
      if (runSoon.pending()) run(false, false);
      if (finder.empty || finder.error) return;
      msg = null;
      const tpl = ui.r.value;
      // The edit is built while the matches are found (replaceAllBuilder: the output only, never every match).
      const finish = ed => {
        if (!ed) { matches = []; cur = null; updateCount(); return; }
        applyEdit(ed, { restore: true, reveal: false });
        from = ed.from;
        cur = null;
        run(true);
        msg = replacedText(ed.count);
        updateCount();
        if (typeof o.announce === 'function') o.announce(msg);
      };
      if (text.length <= BIG) { finish(replaceAllEdit(text, finder, tpl)); return; }
      const g = ++gen, ver = version;
      seekId++;
      queued = null;
      rerunSoon.cancel();
      searching = true;
      updateCount();
      (async () => {
        const src = text, b = replaceAllBuilder(src, finder, tpl);
        let t = performance.now();
        for (const x of scanMatches(src, finder, { includeEmpty: true })) {
          if (x) b.add(x);
          if (performance.now() - t > SLICE_MS) {
            await yieldToUi();
            if (g !== gen || destroyed) return;
            if (ver !== version) {
              // The text the matches were collected from is gone: nothing is replaced, and the user is told.
              searching = false;
              msg = 'The text changed; Replace all was cancelled.';
              updateCount();
              if (typeof o.announce === 'function') o.announce(msg);
              return;
            }
            t = performance.now();
          }
        }
        if (g !== gen || destroyed) return;
        searching = false;
        finish(b.edit());
      })();
    }

    // Editor commands while focus is in the find or go-to bar: its inputs are form fields, where the shell's
    // editor-scoped KEYMAP bindings do not fire (so Edge's Find next, Find on page, History, ... would run instead).
    // opts.keyMatches(e, id) (shell.keyMatches) keeps KEYMAP the single source; built-in defaults otherwise.
    function barCommand(e) {
      if (typeof o.keyMatches === 'function') {
        for (const id of ['findNext', 'findPrev', 'find', 'replace', 'goToLine']) if (o.keyMatches(e, id)) return id;
        return null;
      }
      const mac = isMac();
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (e.key === 'F3' && !e.ctrlKey && !e.metaKey && !e.altKey) return e.shiftKey ? 'findPrev' : 'findNext';
      if (e.shiftKey) return null;
      if (mod && !e.altKey && e.code === 'KeyF') return 'find';
      if (mac ? e.metaKey && e.altKey && !e.ctrlKey && e.code === 'KeyF' : mod && !e.altKey && e.code === 'KeyH') return 'replace';
      if (mod && !e.altKey && e.code === 'KeyG') return 'goToLine';
      return null;
    }

    function barKey(e) {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      const id = barCommand(e);
      if (!id) return;
      e.preventDefault();
      if (id === 'findNext') step(1);
      else if (id === 'findPrev') step(-1);
      else if (id === 'find') { if (open) { ui.q.focus(); ui.q.select(); } else openFind({}); }
      else if (id === 'replace') { if (open) showReplace(true, true); else openFind({ replace: true }); }
      else openGoto();
    }

    function openFind({ replace = false } = {}) {
      closeGoto(false);
      if (!ui) ui = build();
      const wasOpen = open;
      open = true;
      ui.bar.hidden = false;
      syncToggles();
      const [s, e] = sel();
      const seed = s !== e && !text.slice(s, e).includes('\n') ? text.slice(s, e) : null;
      if (seed !== null) ui.q.value = lay().regex ? escapeRegex(seed) : seed;
      from = s;
      if (replace) showReplace(true, false);
      if (replace && ui.q.value) { ui.r.focus(); ui.r.select(); } else { ui.q.focus(); ui.q.select(); }
      if (seed !== null) { msg = null; cur = { start: s, end: e }; run(false, false); }
      else if (!wasOpen) { msg = null; cur = null; run(false, false); }
      else updateCount();
    }

    // Shows the closed bar again with its last query and options and searches without moving the selection or the
    // focus (step() then goes to the match); the go-to bar it replaces gives the focus back to the editor.
    function reopen() {
      if (gotoOpen) closeGoto(true);
      open = true;
      ui.bar.hidden = false;
      syncToggles();
      from = sel()[0];
      msg = null;
      cur = null;
      run(false, false);
    }

    // Hides the find bar and drops its search state (a sliced search, a pending Next).
    function hideFind() {
      open = false;
      runSoon.cancel();
      rerunSoon.cancel();
      gen++;
      seekId++;
      ui.bar.hidden = true;
      root.classList.remove('ed-finding');
      matches = [];
      cur = null;
      capped = false;
      searching = false;
      queued = null;
      win = null;
      schedule();
    }

    function closeFind() {
      if (gotoOpen) { closeGoto(true); return true; }
      if (!open) return false;
      hideFind();
      ta.focus({ preventScroll: true });
      return true;
    }

    // ---- go to line
    function buildGoto() {
      const input = h('input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Go to line', spellcheck: 'false', autocomplete: 'off' });
      const hint = h('span', { class: 'ed-fc', role: 'status', 'aria-live': 'polite' });
      const close = h('button', { type: 'button', class: 'btn subtle icon ed-fb', title: title('Close', 'closeFind'), 'aria-label': 'Close', onclick: () => closeGoto(true) }, icon('close', 16));
      const bar = h('div', { class: 'ed-find ed-goto', role: 'group', 'aria-label': 'Go to line', hidden: true },
        h('div', { class: 'ed-fcol' }, h('div', { class: 'ed-frow' }, h('div', { class: 'input ed-fin' }, input), hint, close)));
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          const r = parseGoTo(input.value, lines.length);
          if (!r) { input.setAttribute('aria-invalid', 'true'); hint.textContent = `Type a line number between 1 and ${fmtInt(lines.length)}.`; hint.classList.add('ed-bad'); return; }
          closeGoto(false);
          go(r.line, r.col);
        }
      });
      input.addEventListener('input', () => { input.setAttribute('aria-invalid', 'false'); hint.classList.remove('ed-bad'); hint.textContent = ''; });
      bar.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeGoto(true); return; }
        barKey(e);
      });
      root.appendChild(bar);
      return { bar, input, hint };
    }

    function openGoto() {
      if (open) hideFind();
      if (!gotoUi) gotoUi = buildGoto();
      gotoOpen = true;
      gotoUi.bar.hidden = false;
      gotoUi.input.value = '';
      gotoUi.input.setAttribute('aria-invalid', 'false');
      gotoUi.input.placeholder = `Line number (1–${fmtInt(lines.length)})`;
      gotoUi.hint.textContent = '';
      gotoUi.hint.classList.remove('ed-bad');
      gotoUi.input.focus();
    }

    function closeGoto(focus) {
      if (!gotoOpen) return;
      gotoOpen = false;
      gotoUi.bar.hidden = true;
      if (focus) ta.focus({ preventScroll: true });
    }

    function go(line, col = 1) {
      const n = Math.max(1, Math.min(lines.length, Math.floor(line)));
      const ss = getStarts();
      const pos = ss[n - 1] + Math.min(lines[n - 1].length, Math.max(0, Math.floor(col) - 1));
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(pos, pos);
      pendingReveal = { pos, center: true };
      schedule();
    }

    return {
      openFind, closeFind, step, replaceOne, replaceAll, openGoto, go,
      isOpen: () => open || gotoOpen,
      isCur: m => !!cur && m.start === cur.start && m.end === cur.end,
      // Matches to highlight in [a, b] (03 §5: the rendered lines); never the empty ones.
      visible(a, b) {
        if (!open || finder.empty || finder.error) return [];
        if (!capped) {
          let i = index({ start: a });
          while (i > 0 && matches[i - 1].end > a) i--;
          const out = [];
          for (; i < matches.length && matches[i].start <= b; i++) out.push(matches[i]);
          return out;
        }
        // Capped results: the rendered lines plus a margin are searched once, then the window moves with the edits
        // (03 §5: typing never runs matching); scrolling past it, a query or option change, Next and Replace search
        // it again.
        if (win && win.gen === gen && win.a <= a && b <= win.b) return win.list;
        const pad = Math.max(4096, b - a);
        const wa = Math.max(0, a - pad), wb = Math.min(text.length, b + pad);
        win = { a: wa, b: wb, gen, list: findAll(text, finder, { from: wa, to: wb }).matches };
        return win.list;
      },
      onText(d) {
        if (!open) return;
        const c0 = cur ? { start: cur.start, end: cur.end } : null;
        shiftSorted(matches, d.start, d.oldEnd, d.newEnd);
        const nc = c0 ? shiftRanges([c0], d.start, d.oldEnd, d.newEnd)[0] || null : null;
        if (nc) { const i = index(nc); cur = matches[i] && matches[i].start === nc.start && matches[i].end === nc.end ? matches[i] : nc; } else cur = null;
        if (win) {
          const mv = p => (p < d.start ? p : p >= d.oldEnd ? p + d.newEnd - d.oldEnd : d.start);
          win.list = shiftRanges(win.list, d.start, d.oldEnd, d.newEnd);
          win.a = mv(win.a);
          win.b = Math.max(win.a, mv(win.b));
        }
        from = shiftPoints([from], d.start, d.oldEnd, d.newEnd)[0] ?? d.newEnd;
        msg = null;
        updateCount();
      },
      // A text loaded with setValue(…, {undo: false}) is searched again (it is not an edit, 03 §5).
      reload() { if (open) { cur = null; from = 0; run(false, false); } },
      dispose() { runSoon.cancel(); rerunSoon.cancel(); gen++; seekId++; queued = null; },
      state: () => ({ open, matches, capped, cur, msg, finder, ui, searching }),
    };
  })();

  // ---- commands ----------------------------------------------------------------------------------------------

  function runEdit(fn) {
    if (ta.value !== text) sync();
    const [s, e] = sel();
    return applyEdit(fn(text, s, e));
  }

  // A message for the user (a toast, else the live region).
  function notify(msg, kind) {
    if (typeof o.toast === 'function') o.toast(msg, { kind });
    else if (typeof o.announce === 'function') o.announce(msg);
  }

  // Format (03 §5): the selection extended to whole lines (format.js: a cut inside a line could join it with the text
  // around it), or everything without a selection. A selection that starts inside a multi-line string, quoted
  // identifier or comment is not SQL and is not formatted (formatting it would rewrite data). What the formatter left
  // unchanged is said (formatNotice); above FORMAT_BUSY_LINES lines the status shows 'Formatting n lines…' for a frame
  // before the synchronous run, and the result is announced. False when nothing was formatted because of an error or
  // the refusal; on that deferred path true only says the run is under way (a second call meanwhile changes nothing),
  // and formatDone() gives its outcome.
  let formatJob = null;                    // the deferred run's Promise<boolean> while it waits
  let formatLast = Promise.resolve(true);  // formatDone(): the outcome of the latest format() call
  function format() {
    if (formatJob) return true;
    const r = formatNow();
    if (typeof r === 'boolean') formatLast = Promise.resolve(r);
    return r !== false;
  }

  // format() without its bookkeeping: a boolean, or for a deferred run the Promise of its outcome (formatJob).
  function formatNow() {
    if (ta.value !== text) sync();
    const [s, e] = sel();
    const whole = s === e;
    const { start: from, end: to } = whole ? { start: 0, end: text.length } : lineBlock(text, s, e);
    const a = lineOf(from), b = lineOf(to);
    ensureStates(b);
    const st0 = st[a];
    if (st0.cmt || st0.quote) { notify(FORMAT_INSIDE, 'warn'); return false; }
    const endSt = endStateOf(b);
    const cut = !whole && to < text.length && !!(endSt.cmt || endSt.quote);
    const n = b - a + 1;
    if (n <= FORMAT_BUSY_LINES) return formatRange(from, to, whole, s, cut, 0);
    const ver = version;
    const clearStatus = typeof o.status === 'function' ? o.status(`Formatting ${fmtInt(n)} lines…`, { ms: 60000 }) : null;
    // One frame lets the status paint before the synchronous run (format.js: 0.2-0.7 s for 20,000 lines).
    formatLast = formatJob = new Promise(resolve => raf(() => setTimeout(() => {
      formatJob = null;
      let ok = false;
      try {
        if (typeof clearStatus === 'function') clearStatus();
        if (destroyed) return;
        if (version !== ver) { notify('The text changed; Format was cancelled.', 'warn'); return; }
        ok = formatRange(from, to, whole, s, cut, n);
      } finally { resolve(ok); }
    }, 0)));
    return formatJob;
  }

  // Formats text[from, to) with the formatter: opts.formatter(src, {state}) -> string | {text, kept} (format.js
  // formatSqlReport by default; formatSql itself is replaced by formatSqlReport, the same formatter with its report).
  // `big` (the line count, or 0) announces the result.
  function formatRange(from, to, whole, caretAt, cut, big) {
    const src = text.slice(from, to);
    const r = runFormatter(src, null);
    if (!r) return false;
    const { out, kept } = r;
    const note = formatNotice(kept, { cut });
    let changed = false;
    if (out !== src) {
      const caret = whole ? mapCaret(src, out, caretAt) : null;
      changed = replaceFormatted(from, to, out, kept, whole ? [caret, caret] : [from, from + out.length]);
    }
    if (note) notify(note, 'warn');
    else if (big && typeof o.announce === 'function') o.announce(changed ? `Formatted ${fmtInt(big)} lines.` : 'The SQL was already formatted.');
    return true;
  }

  // The formatter: opts.formatter(src, {state, quotedIdentifier, displayNames?}) -> string | {text, kept} (format.js
  // formatSqlReport by default; formatSql itself is replaced by formatSqlReport, the same formatter with its report),
  // in the tab's QUOTED_IDENTIFIER mode. {out (LF line breaks, a final line break kept), kept} or null after an
  // error, which is said.
  function runFormatter(src, displayNames) {
    const fmt = typeof o.formatter === 'function' && o.formatter !== formatSql ? o.formatter : formatSqlReport;
    const fo = { state: LINE0, quotedIdentifier: qi };
    if (displayNames) fo.displayNames = displayNames;
    let r;
    try { r = fmt(src, fo); } catch (err) {
      notify(`Couldn't format the SQL. ${err && err.message ? err.message : err}`, 'error');
      return null;
    }
    let out = typeof r === 'string' ? r : r && typeof r === 'object' && typeof r.text === 'string' ? r.text : null;
    if (out === null) { notify("Couldn't format the SQL. The formatter returned no text.", 'error'); return null; }
    out = norm(out);
    if (src.endsWith('\n') && !out.endsWith('\n')) out += '\n';
    const kept = r && typeof r === 'object' && Array.isArray(r.kept) ? r.kept.filter(k => k && Number.isFinite(k.start) && Number.isFinite(k.end)) : [];
    return { out, kept };
  }

  // Replaces text[from, to) with the formatter's output as one undo step; the 'parse' markers of the statements it
  // kept byte for byte (keptPlaces) stay on them (03 §5 Format) instead of waiting for the next parse.
  function replaceFormatted(from, to, out, kept, selection) {
    const src = text.slice(from, to);
    const moved = [];
    const places = kept.length ? keptPlaces(src, out, kept) : [];
    if (places.length) {
      for (const m of markers.get('parse') || []) {
        if (m.end <= from || m.start >= to) continue;
        const p = places.find(x => from + x.start <= m.start && m.end <= from + x.end);
        if (p) { const d = p.to - p.start; moved.push({ ...m, start: m.start + d, end: m.end + d }); }
      }
    }
    const changed = applyEdit({ from, to, text: out, sel: selection });
    if (changed && moved.length) {
      const list = markers.get('parse') || [];
      const have = new Set(list.map(m => m.start + ':' + m.end + ':' + m.level + ':' + m.message));
      const add = moved.filter(m => !have.has(m.start + ':' + m.end + ':' + m.level + ':' + m.message));
      if (add.length) {
        markers.set('parse', cleanMarkers(list.concat(add)));
        mergeMarkers();
        schedule();
      }
    }
    return changed;
  }

  // A transient status-bar text (opts.status, the shell's), else a toast or the live region.
  function say(textOut, kind = 'info', ms = STATUS_MS) {
    if (typeof o.status === 'function') {
      try { const c = o.status(textOut, { ms }); return typeof c === 'function' ? c : null; } catch { /* fall back below */ }
    }
    notify(textOut, kind);
    return null;
  }

  // The statements Add display names works on: the one at the caret, or every statement the selection touches
  // ({from, to, stmts}: their range widened over the blanks before them and after them on their lines), or null.
  function namesRange(s, e) {
    const rs = ranges();
    let list;
    if (s === e) { const r = pickStatement(rs, s, text); list = r ? rs.filter(x => x.start === r.start && x.end === r.end) : []; } else list = rs.filter(x => x.start < e && x.end > s);
    if (!list.length) return null;
    let from = list[0].start, to = list[list.length - 1].end;
    const ls = lineStartOf(text, from), le = lineEndOf(text, to);
    if (/^[ \t]*$/.test(text.slice(ls, from))) from = ls;
    if (/^[ \t]*$/.test(text.slice(to, le))) to = le;
    return { from, to, stmts: list };
  }

  // Format › Add display names (03 §5): see the notes at the top of this file. Resolves when it is done (or refused).
  let namesJob = null;
  function addDisplayNames() {
    if (!namesJob) namesJob = runDisplayNames().finally(() => { namesJob = null; });
    return namesJob;
  }

  async function runDisplayNames() {
    if (formatJob || destroyed) return;
    if (ta.value !== text) sync();
    const [s, e] = sel();
    const range = namesRange(s, e);
    if (!range) { say('There is no statement here to add display names to.'); return; }
    const { from, to, stmts } = range;
    const src = text.slice(from, to);
    // 1. The tables whose metadata the labels need (format.js names them through the callback, 01 §1).
    const wanted = new Map();
    const first = runFormatter(src, table => { if (typeof table === 'string' && table) wanted.set(table.toLowerCase(), table); return null; });
    if (!first) return;
    // 2. Their metadata, in parallel (an explicit action, as hover: 03 §5).
    const entities = new Map();
    if (wanted.size) {
      if (!meta || typeof meta.entity !== 'function') { say("Display names need the tables' metadata, which is not available.", 'warn'); return; }
      const ver = version, mode = qi;
      const names = [...wanted.values()];
      const cached = typeof meta.entitySync === 'function' && names.every(n => { try { return !!meta.entitySync(n); } catch { return false; } });
      const clear = cached ? null : say('Loading metadata…', 'info', 60000);
      const got = await Promise.allSettled(names.map(n => Promise.resolve().then(() => meta.entity(n))));
      if (typeof clear === 'function') clear();
      if (destroyed) return;
      if (version !== ver || qi !== mode) { notify('The text changed; Add display names was cancelled.', 'warn'); return; }
      const failed = [];
      got.forEach((r, k) => {
        if (r.status === 'fulfilled' && r.value && typeof r.value === 'object') entities.set(names[k].toLowerCase(), r.value);
        else if (!(r.reason && r.reason.number === 208)) failed.push([names[k], r.reason]);
      });
      if (failed.length) {
        // The name comes from the SQL text: quoted with isolates, a right-to-left name never reorders the sentence (03 §3).
        const [nm, why] = failed[0];
        notify(`Couldn't load the metadata of ${quoteName(nm)}${failed.length > 1 ? ` and ${fmtInt(failed.length - 1)} more` : ''}: ${why && why.message ? why.message : why}`, 'error');
      }
    }
    // 3. Format with the labels: `<attribute display name> (<table display name>)` (labels in the user language).
    const r = entities.size ? runFormatter(src, displayNameLabels(entities)) : first;
    if (!r) return;
    const { out, kept } = r;
    // Statements that do not parse are left unchanged (format.js `kept`, reason 'error' or 'unterminated').
    const failing = stmts.filter(x => kept.some(k => (k.reason === 'error' || k.reason === 'unterminated') && k.start <= x.start - from && x.start - from < k.end)).length;
    const added = entities.size > 0 && first.out !== out;
    if (out !== src) {
      const caret = s === e ? from + mapFormatted(src, out, s - from) : null;
      replaceFormatted(from, to, out, kept, s === e ? [caret, caret] : [from, from + out.length]);
    }
    const others = formatNotice(kept.filter(k => k.reason === 'case' || k.reason === 'unformatted'));
    if (others) notify(others, 'warn');
    const notice = displayNamesNotice({ total: stmts.length, failing });
    if (notice) say(notice, 'warn');
    else if (!added) say('No display names were added: no column without an alias has one.');
    else if (typeof o.announce === 'function') o.announce('Display names were added.');
  }

  function setValue(v, { undo = true } = {}) {
    const nv = norm(v);
    if (undo) {
      if (nv !== text) applyEdit({ from: 0, to: text.length, text: nv, sel: [nv.length, nv.length] });
      return;
    }
    // Another text (a query-tab switch): nothing shown for the old one stays, even with the same text and while the
    // pointer rests where it was (no 'input' event comes, 03 §5).
    hoverPt = null;
    closeTip();
    ta.removeAttribute('title');
    markers.clear();
    pending = [];
    editHint = null;
    domW = 0;
    silentSync = true;
    try {
      ta.value = nv;
      sync();
    } finally { silentSync = false; }
    mergeMarkers();
    ta.setSelectionRange(0, 0);
    F.reload();
    parseSoon();
    schedule();
  }

  function select(start, end = start, { reveal: rv = true } = {}) {
    const n = text.length;
    const a = Math.max(0, Math.min(Number(start) || 0, n)), b = Math.max(0, Math.min(Number(end) || 0, n));
    ta.setSelectionRange(Math.min(a, b), Math.max(a, b), a > b ? 'backward' : 'forward');
    if (rv) pendingReveal = { pos: Math.min(a, b), center: true };
    schedule();
  }

  function insert(t, { at } = {}) {
    if (ta.value !== text) sync();
    const v = norm(t);
    const [s, e] = at == null ? sel() : [Math.max(0, Math.min(at, text.length)), Math.max(0, Math.min(at, text.length))];
    return applyEdit({ from: s, to: e, text: v, sel: [s + v.length, s + v.length] });
  }

  // Top-level statement ranges of the text in the tab's QUOTED_IDENTIFIER mode (parser.statementRanges), cached.
  function ranges() {
    if (ta.value !== text) sync();
    if (!stmtCache || stmtCache.version !== version || stmtCache.qi !== qi) stmtCache = { version, qi, ranges: statementRanges(text, { quotedIdentifier: qi }) };
    return stmtCache.ranges;
  }

  function statementAt(pos) {
    return pickStatement(ranges(), Math.max(0, Math.min(Number(pos) || 0, text.length)), text);
  }

  function tokenAt(off, bias = 'after') {
    const n = text.length;
    const p = Math.max(0, Math.min(Number(off) || 0, n));
    const line = lineOf(p);
    const ls = getStarts()[line];
    const col = p - ls;
    const toks = lineTokens(line);
    let hit = null;
    if (bias === 'before') hit = toks.find(t => t.s < col && col <= t.e) || null;
    else hit = toks.find(t => t.s <= col && col < t.e) || toks.find(t => t.e === col && t.e > t.s) || null;
    return hit ? { ...hit, s: hit.s + ls, e: hit.e + ls, line, state: st[line] } : null;
  }

  function lineAt(off) {
    const p = Math.max(0, Math.min(Number(off) || 0, text.length));
    const line = lineOf(p);
    const ls = getStarts()[line];
    return { line: line + 1, col: p - ls + 1, start: ls, end: ls + lines[line].length };
  }

  // ---- events ------------------------------------------------------------------------------------------------

  ta.addEventListener('input', () => { if (sync()) revealCaret = true; inputSynced = true; });

  ta.addEventListener('beforeinput', e => {
    if (inExec) return;
    const s0 = ta.selectionStart, e0 = ta.selectionEnd;
    editHint = s0 === e0 && /^delete.*Backward$/.test(e.inputType || '') ? { end: s0 } : { start: Math.min(s0, e0) };
    if (e.isComposing || e.inputType !== 'insertText' || typeof e.data !== 'string' || e.data.length !== 1) return;
    const ch = e.data;
    if (!CLOSERS.has(ch) && ch !== ')' && ch !== ']') return;
    const [s, en] = sel();
    const ed = autoCloseEdit(text, s, en, ch, { ctx: lineCtx(s), pending, autoClose: settings.autoClose });
    if (!ed) return;
    e.preventDefault();
    if (ed.overtype) pending = pending.filter(p => p !== s);
    applyEdit(ed);
    if (ed.closer != null) pending.push(ed.closer);
  });

  ta.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    // Esc arms 'Esc then Tab leaves the editor' whatever else it does (03 §9): the shell's cascade preventDefault()s
    // every Escape, and closing the completion popup takes it in an onKey hook.
    if (e.key === 'Escape') tabEscape = true;
    for (const fn of [...hooks]) if (fn(e) === true) return;
    if (e.defaultPrevented) return;
    const k = e.key;
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (k === 'Escape') return;
    if (k === 'Tab' && plain) {
      if (tabFocus || tabEscape) { tabEscape = false; return; }
      e.preventDefault();
      const [s, en] = sel();
      applyEdit(e.shiftKey ? outdentEdit(text, s, en) : tabEdit(text, s, en));
      return;
    }
    if (!MODIFIER_KEYS.has(k)) tabEscape = false;
    if (k === 'Enter' && plain) {
      e.preventDefault();
      const [s, en] = sel();
      applyEdit(enterEdit(text, s, en, tokensBefore(s), lineCtx(s)));
      return;
    }
    if (k === 'Backspace' && plain && !e.shiftKey) {
      const [s, en] = sel();
      if (s === en && s > 0) {
        const i = lineOf(s);
        const col = s - getStarts()[i];
        if (inEmptyPair(lines[i], col, lineTokens(i))) {
          e.preventDefault();
          applyEdit({ from: s - 1, to: s + 1, text: '', sel: [s - 1, s - 1] });
          return;
        }
      }
    }
    if ((k === 'PageUp' || k === 'PageDown') && plain) {
      e.preventDefault();
      page(k === 'PageUp' ? -1 : 1, e.shiftKey);
      return;
    }
    revealCaret = true;
    schedule();
  });

  ta.addEventListener('keyup', () => schedule());
  ta.addEventListener('select', () => schedule());
  ta.addEventListener('focus', () => schedule());
  ta.addEventListener('blur', () => { tabEscape = false; schedule(); });
  ta.addEventListener('mousedown', () => { tabEscape = false; schedule(); });
  ta.addEventListener('mouseup', () => schedule());
  // ---- hover tooltips (03 §5 Diagnostics, §1.5): the messages of the markers under the pointer and the code points of
  // the invisible characters next to it, after the pointer rests HOVER_MS, in a top-layer role=tooltip popover through
  // opts.popover (shell.popover: Escape closes it in cascade step 4). It stays while the pointer is over it (WCAG
  // 1.4.13), closes LEAVE_MS after the pointer leaves both, and on typing, clicking, scrolling and a text loaded with
  // setValue(). Without opts.popover the textarea's title carries the text; with opts.hoverTips === false the editor
  // shows none (03 §1.4: complete.js's hover card shows hoverText() then). settings.hoverCards turns off the
  // hover cards of §5 (complete.js), not this Diagnostics tooltip.
  const tipsOn = () => o.hoverTips !== false;
  const usePopover = () => typeof o.popover === 'function';

  function closeTip() {
    clearTimeout(tipTimer);
    clearTimeout(leaveTimer);
    tipTimer = leaveTimer = 0;
    const t = tip;
    tip = null;
    if (t && t.handle && typeof t.handle.close === 'function') { try { t.handle.close(); } catch { /* already closed */ } }
  }

  // A text change (typing, an edit command, setValue) closes the tooltip and drops the waiting one, and the textarea
  // title that stands in for it without a popover: the text under it is not what it described.
  function dropTip() {
    if (tip || tipTimer || leaveTimer) closeTip();
    if (ta.getAttribute('title') !== null) ta.removeAttribute('title');
  }

  function showTip(off, msg) {
    closeTip();
    if (destroyed || !msg) return;
    const c = coordsAt(off);
    const w = Math.max(1, charW);
    const rect = { left: c.left, right: c.left + w, top: c.top, bottom: c.bottom, width: w, height: c.height, x: c.left, y: c.top };
    const node = h('div', { class: 'ed-tip' }, ...msg.split('\n').map(line => h('div', { text: line })));
    const t = { off, msg, handle: null };
    let handle = null;
    try { handle = o.popover(rect, node, { label: 'Problems', role: 'tooltip', onClose: () => { if (tip === t) tip = null; } }); } catch { handle = null; }
    if (!handle) return;
    t.handle = handle;
    tip = t;
    const el = handle.el;
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener('pointerenter', () => { if (tip === t) { clearTimeout(leaveTimer); leaveTimer = 0; } });
      el.addEventListener('pointerleave', () => { if (tip === t) leaveSoon(); });
    }
  }

  function leaveSoon() {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => { leaveTimer = 0; closeTip(); }, LEAVE_MS);
  }

  function onHover(off) {
    const msg = off == null ? '' : hoverText(off);
    if (!usePopover()) {
      if (msg) { if (ta.getAttribute('title') !== msg) ta.setAttribute('title', msg); } else ta.removeAttribute('title');
      return;
    }
    if (tip && msg && tip.msg === msg) { clearTimeout(leaveTimer); leaveTimer = 0; return; }
    clearTimeout(tipTimer);
    tipTimer = 0;
    if (tip) leaveSoon();
    if (msg) tipTimer = setTimeout(() => { tipTimer = 0; if (hoverPt && !destroyed) showTip(off, msg); }, HOVER_MS);
  }

  ta.addEventListener('mousemove', e => {
    if (e.buttons) { schedule(); return; }
    if (!tipsOn()) return;
    hoverPt = [e.clientX, e.clientY];
    if (!hoverFrame) hoverFrame = raf(() => {
      hoverFrame = 0;
      if (!hoverPt || destroyed) return;
      onHover(offsetAt(hoverPt[0], hoverPt[1]));
    });
  });
  ta.addEventListener('mouseleave', () => {
    hoverPt = null;
    ta.removeAttribute('title');
    clearTimeout(tipTimer);
    tipTimer = 0;
    if (tip) leaveSoon();
  });
  ta.addEventListener('input', () => closeTip());
  ta.addEventListener('mousedown', () => closeTip());
  sc.addEventListener('scroll', () => closeTip(), { passive: true });

  // The hover text at an offset (also for complete.js's hover card): the messages of the markers there, then the code
  // points of the invisible characters on either side of the character at it (03 §5: they take no width, and the
  // overlay that marks them takes no pointer), that character included when it is one itself (Ctrl+K Ctrl+I with the
  // caret before it), each once and not when a message there already names it (the parse warning of that character);
  // '' when there is none.
  function hoverText(off) {
    const out = [...new Set(markersAt(off).map(m => m.message))];   // one line per message (sources can repeat one)
    const ls = lineStartOf(text, off), le = lineEndOf(text, off);
    const end = off < text.length && !INVISIBLE_1.test(text[off]) ? off + cpAt(text, off)[1] : off;
    let a = off;
    while (a > ls && INVISIBLE_1.test(text[a - 1])) a--;
    const cps = [];
    for (let j = a; j < off; j++) cps.push(hex4(text.charCodeAt(j)));
    for (let j = end; j < le && INVISIBLE_1.test(text[j]); j++) cps.push(hex4(text.charCodeAt(j)));
    for (const c of cps) if (!out.some(m => m === c || m.includes(c + ' '))) out.push(c);
    return out.join('\n');
  }
  ta.addEventListener('scroll', () => {
    if (ta.scrollTop || ta.scrollLeft) { ta.scrollTop = 0; ta.scrollLeft = 0; lastSize.cw = lastSize.ch = -1; schedule(); }
  });

  // Files dropped anywhere on the editor (text, gutter, find bar) are taken here, so Edge never opens a dropped file
  // in the tab (which would leave the page); a dragged text is left to the textarea, which inserts it at the caret.
  const hasFiles = dt => !!dt && !!dt.types && [...dt.types].includes('Files');
  for (const type of ['dragenter', 'dragover']) {
    root.addEventListener(type, e => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = typeof o.onFile === 'function' ? 'copy' : 'none';
    });
  }
  root.addEventListener('drop', e => {
    const dt = e.dataTransfer;
    const files = dt && dt.files;
    if (!(files && files.length) && !hasFiles(dt)) return;
    e.preventDefault();
    if (typeof o.onFile === 'function' && files) for (const [f, kind] of dropCalls(files)) o.onFile(f, kind);
  });
  ta.addEventListener('paste', e => {
    const t = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!t || typeof o.onPasteFetchXml !== 'function' || !/^\s*<fetch[\s>/]/.test(t)) return;
    const at = Math.min(ta.selectionStart, ta.selectionEnd);
    const len = norm(t).length;
    setTimeout(() => { if (!destroyed) o.onPasteFetchXml(t, { start: at, end: at + len }); }, 0);
  });

  sc.addEventListener('scroll', () => {
    const view = viewSize();
    const y0 = (sc.scrollTop || 0) - PAD_T;
    const a = lineAtY(Math.max(0, y0)), b = lineAtY(Math.max(0, y0 + view.h));
    if (a - rendered.first < MARGIN / 3 && rendered.first > 0) schedule();
    else if (rendered.last - b < MARGIN / 3 && rendered.last < lines.length - 1) schedule();
    else if (longShown) schedule();   // a long line is highlighted around the view only (longRange)
  }, { passive: true });

  gut.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const line = lineAtClientY(e.clientY);
    const anchor = e.shiftKey ? lineOf(ta.selectionDirection === 'backward' ? ta.selectionEnd : ta.selectionStart) : line;
    gutDrag = anchor;
    focusTa();
    selectLines(anchor, line);
    if (typeof gut.setPointerCapture === 'function' && e.pointerId != null) try { gut.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });
  gut.addEventListener('pointermove', e => { if (gutDrag !== null) selectLines(gutDrag, lineAtClientY(e.clientY)); });
  const endDrag = () => { gutDrag = null; };
  gut.addEventListener('pointerup', endDrag);
  gut.addEventListener('pointercancel', endDrag);

  // A size change re-renders; with word wrap, layoutSizes() re-estimates the rows at once and remeasure() measures
  // them exactly 100 ms after the last change (03 §5).
  let ro = null;
  if (typeof globalThis.ResizeObserver === 'function') {
    ro = new globalThis.ResizeObserver(() => {
      const v = viewSize();
      if (v.w !== lastSize.w || v.h !== lastSize.h) schedule();
    });
    ro.observe(sc);
  }

  const offMeta = meta && typeof meta.onChange === 'function'
    ? meta.onChange(ev => { if (ev && (ev.kind === 'entities' || ev.kind === 'refresh')) { classVersion++; schedule(); } })
    : null;

  // ---- start
  applySettings(settings);
  if (o.value) setValue(o.value, { undo: false });
  schedule();

  const editor = {
    el: root,
    textarea: ta,
    scroller: sc,
    getValue() { if (ta.value !== text) sync(); return text; },
    setValue,
    getSelection() { const [s, e] = sel(); return { start: s, end: e, text: text.slice(s, e) }; },
    select,
    insert,
    focus() { focusTa(); revealCaret = true; schedule(); },
    statementAt,
    setMarkers,
    markersAt,
    hoverText: off => hoverText(Math.max(0, Math.min(Number(off) || 0, text.length))),
    format,
    formatDone: () => formatLast,
    addDisplayNames,
    setQuotedIdentifier,
    quotedIdentifier: () => qi,
    toggleComment: () => runEdit((t, s, e) => commentEdit(t, s, e, 'toggle')),
    comment: () => runEdit((t, s, e) => commentEdit(t, s, e, 'add')),
    uncomment: () => runEdit((t, s, e) => commentEdit(t, s, e, 'remove')),
    duplicateLines: () => runEdit(duplicateEdit),
    moveLines: dir => runEdit((t, s, e) => moveLinesEdit(t, s, e, dir < 0 ? -1 : 1)),
    deleteLines: () => runEdit(deleteLinesEdit),
    openFind: (p = {}) => F.openFind(p),
    findNext: () => F.step(1),
    findPrev: () => F.step(-1),
    closeFind: () => F.closeFind(),
    isFindOpen: () => F.isOpen(),
    goToLine(n) {
      if (n == null) { F.openGoto(); return true; }
      const r = goToTarget(n, lines.length);
      if (!r) return false;
      F.go(r.line, r.col);
      return true;
    },
    applySettings,
    offsetAt,
    coordsAt,
    tokenAt,
    contextAt: off => lineCtx(Math.max(0, Math.min(Number(off) || 0, text.length))),
    lineAt,
    metrics: () => ({ charWidth: charW, lineHeight: lh, fontSize: fs, wrap, wrapCols: wrap ? wrapCols : null }),
    setTabMovesFocus(on) { tabFocus = !!on; },
    tabMovesFocus: () => tabFocus,
    getScroll: () => sc.scrollTop || 0,
    setScroll(top) {
      if (frame) { cancelRaf(frame); frame = 0; }
      render();
      sc.scrollTop = Math.max(0, Number(top) || 0);
      schedule();
    },
    onKey(fn) {
      if (typeof fn !== 'function') throw new TypeError('onKey: a function is required.');
      hooks.add(fn);
      return () => { hooks.delete(fn); };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) cancelRaf(frame);
      if (hoverFrame) cancelRaf(hoverFrame);
      frame = hoverFrame = 0;
      parseSoon.cancel();
      remeasure.cancel();
      closeTip();
      for (const off of gutUnbind.values()) { try { off(); } catch { /* already unbound */ } }
      gutUnbind.clear();
      gutTips.clear();
      F.dispose();
      measureGen++;
      if (ro) ro.disconnect();
      if (offMeta) offMeta();
      hooks.clear();
      root.remove();
    },
    // Inspection hook: runs a pending render now.
    flush() { if (frame) { cancelRaf(frame); frame = 0; } render(); },
    findState: () => F.state(),
    // Inspection hook: {runs, parses (region parses of the last completed run), running}.
    diagState: () => ({ ...diagStats }),
    // Inspection hook: {lexed, relexed, classified (tokens), built, measured} so far (03 §13: work per keystroke).
    workState: () => ({ ...work }),
  };
  return editor;
}
