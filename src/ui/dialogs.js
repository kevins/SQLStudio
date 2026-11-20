// Dialogs of SQL Studio (03 §1.4, §8, §8.1-§8.4, §12, §13; 02 §8.2, §8.3, §9, §10; 00 §5): the change
// confirmation with the standing approval for later executions of a statement (the only DML callers of
// writeCaps.createGrant), Allow changes (the only caller of writeCaps.setReadOnly(false)), Execute as and the
// impersonation confirmation, Settings with About, Help with the function reference and the template gallery,
// History, the cell viewer, Save as personal view (the other createGrant caller), FetchXML → SQL, Import current
// view, Load CSV as #temp, Load file as text and Save all. The DOM code is thin: titles, notes, facts, validation,
// approval checks, generated SQL/XML, search and the Help and template data are pure exported helpers. Data reaches
// the DOM only through h()/textContent (03 §12); generated SQL is never run (00 §5 rule 10).
//
// Notes (extensions of 03 §1.4 / §8 / 02 §8.2):
// - initDialogs options beyond 03 §1.4: `measureText(text, font) -> px` (default dom.js measureText; the Editor › Font
//   monospace check) and `results.ERROR_HINTS` (read when `errorHints` is not passed). Commands bound besides the 03
//   §1.4 list (see the notes in shell.js): endStanding (the mode pill: endStandingApprovals(reason ?? 'pill')),
//   loadFileAsText (titled with the run lock while a run is active) and saveAll. endStandingApprovals(reason) returns
//   how many approvals ended; standingApprovals() returns frozen copies of the 03 §1.4 Standing records.
// - ChangePreview extension: `dynamic: true` marks a statement run by sp_executesql or EXEC (string) (03 §8 needs it,
//   02 §8.2 has no field): the subtitle adds 'Dynamic SQL' and the statement section reads 'Dynamic statement';
//   without the flag neither appears.
// - sessionUi(tabId): confirmChange(preview, o) and confirmImpersonation(user, o) keep the caller's options ({signal},
//   02 §9 ui note) and always use this tab. A signal that is already aborted opens no dialog: confirmChange resolves
//   null as a Cancel (every standing approval ends) before any standing approval could grant, and
//   confirmImpersonation resolves false.
// - Execute as / Revert (03 §8): the picker closes only when api.caller() (without an api: state.impersonating) is the
//   chosen user; otherwise it shows the error or 'The acting user did not change.' (a cancelled confirmation keeps the
//   list). revertCaller() resolves false after an error (its toast), a cancel (no toast), or a run that left a caller
//   set or did not end ok ('You still act as “X”.' / 'Revert did not finish.', warn toasts).
// - Highlighted SQL (Help examples, templates, the change dialog's statement text) is editor.js highlightSql with
//   isTable = sqlTableRule(meta.findEntity) (03 §5's t-tbl rule) and, in the change dialog, quotedIdentifier = the tab
//   session's opts.quotedIdentifier (else the quotedIdentifiers setting; an option of editor.js
//   that 03 §1.4's `highlightSql(text, {isTable}?)` does not list). In the change dialog the
//   editor's invisible-character markers become code-point chips (`.ed-inv.dg-inv`, text = the code point, 03 §8), so
//   a bidi control cannot reorder the statement. A grid change set's equivalent SQL and a statement above 20,000 characters are highlighted when first
//   opened after the dialog is shown (03 §13), plain text with the chips until then.
// - Preview cells: formatCell gets dateFormat {date, time, lcid} from meta.user while settings.localDates is on (lcid per the notes in util.js), one object per table; a title formatCell builds on demand (binary values) is
//   read on the first pointerenter only.
// - Grants of the change confirmation (00 §5 rule 2): confirmChange rejects a preview whose grantSpec carries
//   `personalView` (a personal-view grant is accepted while read-only, 02 §8.3, so only Save as personal view mints
//   one). The Confirm click grants the grantSpec the dialog was opened with; when preview.grantSpec was replaced
//   meanwhile, the dialog closes and the promise rejects with PREVIEW_CHANGED, so nothing is minted and the run ends.
// - Standing approval: dialogs.js alone holds the approvals (statement key -> record) and grants from them;
//   state.standing is only their mirror (state.setStanding / endStanding), never read back, so a record put into the
//   app state by anything else never lets an execution through. Details beyond 03 §8 / 02 §8.3:
//   - Offered only for the DML ops update, delete, insert, associate and disassociate ('DML statement', 00 §5 rule 2):
//     never for an EXEC action, a grid change set or a BulkDelete job, never while impersonating (the preview's flag,
//     any api.caller(), or a grant spec with a callerId), never when preview.standing.offered is false, and only when
//     the preview has a statementKey, a runId, a grantSpec and dangerKinds as an array of strings (fail closed); a
//     preview.standing of null leaves the decision to these guards.
//   - N is a whole number from this execution's count to settings.maxChangeRows as it is now: checked at every input,
//     on every `settings` event while the dialog is open (a lowered maxChangeRows marks N and disables Confirm) and
//     again at the click. The typed N ignores commas, spaces and apostrophes. The record's `environment` is the
//     environment name the user would type (the host name when RetrieveCurrentOrganization failed) and `usedAt` is
//     opts.now().
//   - The Confirm click checks the offer again (an acting user may have appeared): if it no longer holds the click is
//     refused and the box hidden; the box also hides on an `impersonate` event while the dialog is open. When the
//     mirror refuses a record (setStanding throws), no approval is kept and a toast says so.
//   - Later grants: besides the 02 §8.3 conditions, a later grant spec may only use the request kinds (op, table,
//     action name) and the option headers of the approving one (opKinds, headerKey); its spec and count are read once,
//     so what is checked is what is granted and counted.
//   - A later execution with the key of an approval that fails standingRefusal() ends that approval and opens the
//     normal dialog; one whose createGrant throws ends it and rejects with the error. Approvals whose runId differs
//     from the next preview's runId are ended as stale (one run at a time; their runEnded never came). Besides the bus
//     events `impersonate` and `changes:mode {allowed: false}`, dialogs.js also subscribes to api.onModeChange when it
//     is there (allowed false or a caller set end every approval), so either path alone suffices. Stop
//     (cancelPending), Cancel in any change dialog, runEnded(runId) (that run's approvals), the pill and destroy end
//     them too. 'Standing approval ended.' is announced for every reason except 'pill', for which shell.js announces
//     its own text (03 §3); ending every approval also empties a mirror that holds records dialogs.js never gave.
// - BulkDelete: 'Sent as' counts the jobs from the count (20,000 per job) when bulkDelete.jobs is missing, and
//   the facts have no Batch size (one BulkDelete request per 20,000 records, not adaptive batches).
//   Message-based writes: the 'Sent as' fact reads 'Messages, per record (below)' when a DML preview (not a
//   BulkDelete job) has any action op, and the preview table gets the 'Sent as' column when any sample row has a
//   non-empty sentAs.
// - The before/after log above 50,000 records (`beforeAfter.chunks()`): 03 §8 streams each 5,000-record slice
//   into createWritable(), but util.saveFile's make() must return a Blob (03 §1.1), so the slices are appended to one
//   Blob as they are made, with a yield between them (never one string). The progress estimate
//   is chunks done / ceil(count / 5,000).
// - FetchXML → SQL and Import current view: the names checked are the root and link-entity tables and the
//   columns of <attribute>, <order attribute>, <condition attribute> and valueof, and link-entity from/to (the table
//   of their entity, or of the link alias that entityname or 'alias.column' names); an unknown column is named
//   `<table>.<column>`. meta.entity() failing with 208 makes a table unknown; any other failure gives 'The metadata of
//   <table> could not be read (<message>); the query may not run.' Without meta.entity() nothing is checked. 'Open
//   anyway' converts again with the current options; editing the text or an option removes the warnings. A
//   converter that returns a promise is awaited. The tab title is 'FetchXML: <root table>'.
// - Load CSV: with several files previewCsv receives the array (one file: its single {bytes, name}); the files
//   are read only until their total passes 50 MiB by one byte. The `filename` column is the last preview column named
//   filename (ignoring case) when preview.files has more than one name; it is shown with its type, never edited, and
//   passed back to loadCsv unchanged. onError and maxErrors are loadCsv options and do not re-run the preview; an
//   invalid More options input is marked and Load is disabled with 'Correct the marked options under More options
//   first.'. session.temps is read as a Map keyed by #name (matched ignoring case) whose entries give the row count
//   as `rows` (an array) or `rowCount`/`count` (a number); the session's `temps` event and the bus events run:start,
//   run:end and temps re-check the name and the run lock; Replace is unticked whenever the name names another table.
// - Load file as text: the dialog suggests the #temp name itself with the 02 §9 rule (tempNameSuggestion; the
//   session gives no preview here); the file is read with file.arrayBuffer() at Load; util.openFile is called with
//   only {maxBytes}; a tab whose session has no loadFile says 'Load file as text is not available in this query tab.'
// - Save all: 'downloaded' counts as saved (dirty cleared); a write to a tab's already granted handle keeps that
//   handle as the tab's file (util.saveFile's picker fallback cannot open without a fresh gesture), and the file picked
//   in a Save… click becomes the tab's handle; a write error is counted apart and the toast adds ' n could not be
//   saved.'; Escape in the question is Skip all; with nothing to save the toast says 'Every query tab is empty; there
//   is nothing to save.'; a second call while one runs returns the running one; the active tab's text is read from
//   the editor.
// - Settings › Editor › Font: the select offers the default stack, its five families and 'Custom…'. Only a custom
//   family gets the monospace check (each preset is monospaced or falls back to monospace); when the text cannot be
//   measured here the check is skipped. A value that is not a font-family list shows FONT_INVALID.
// - Help › Query hints: the table-hint kind and `implemented` come from the parser.js HINTS row of the same name
//   (a name missing there is an implemented hint of its HINT_DOCS kind). Help › Functions: F1 on a Web API function
//   or action before meta.messages() has answered opens Functions; when the messages arrive while Help is open, that
//   entry is targeted and focused. A Functions section built again keeps its scroll position, its filter text, the
//   entry it targets and the focus (the filter, the same entry, else the section heading), so focus never leaves Help.
// - Templates: TEMPLATES holds exactly the 35 of 03 §8.3.
import { h, append, setChildren, measureText as domMeasureText } from './dom.js';
import { icon } from './icons.js';
import * as stateModule from './state.js';
import { KEYMAP, KEYMAP_GROUPS, keysFor, isMacPlatform, envBadge, runLockTitle, quoteName } from './shell.js';
import { HINT_DOCS } from './complete.js';
import { highlightSql } from './editor.js';
import { META_TABLES } from '../engine/metatables.js';
import { docList, docFor } from '../engine/functions.js';
import { tokenize } from '../engine/lexer.js';
import { HINTS } from '../engine/parser.js';
import { MESSAGES } from '../engine/messages.js';
import { xmlEsc, parseXml } from '../core/xml.js';
import {
  fmtInt, fmtDuration, fmtDate, fmtBytes, formatCell, isGuid, sqlIdent, listUrl, debounce, safeFileName, yieldToUi,
  openUrl as utilOpenUrl, saveFile as utilSaveFile, openFile as utilOpenFile, copyText as utilCopyText, download as utilDownload,
  navigateToView as utilNavigateToView,
} from '../core/util.js';

// ------------------------------------------------------------------------------------------------- text helpers

const MARKS = /\p{M}+/gu;
const INVISIBLE_RE = /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const INVISIBLE_G = /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const lower = s => String(s ?? '').toLowerCase();
const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);

// 'n things' with en-US grouping: plural(1, 'record') = '1 record', plural(3, 'record') = '3 records'.
export function plural(n, one, many = one + 's') {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

// Text folded for search: decomposed, combining marks removed, lower case (03 §8.2 'ignoring case and accents').
export function foldText(s) {
  return String(s ?? '').normalize('NFD').replace(MARKS, '').toLowerCase();
}

// foldText with a map from every folded UTF-16 unit back to the index of its source character (map has one extra
// entry, the source length), so a hit in the folded text can be highlighted in the original.
export function foldWithMap(s) {
  const str = String(s ?? '');
  let text = '';
  const map = [];
  for (let i = 0; i < str.length;) {
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const f = ch.normalize('NFD').replace(MARKS, '').toLowerCase();
    for (let k = 0; k < f.length; k++) map.push(i);
    text += f;
    i += ch.length;
  }
  map.push(str.length);
  return { text, map };
}

// The first match of `query` in `text` ignoring case and accents: {start, end} in the original text, or null.
export function findFolded(text, query) {
  const q = foldText(query).trim();
  if (!q) return null;
  const { text: f, map } = foldWithMap(text);
  const i = f.indexOf(q);
  if (i < 0) return null;
  const last = map[i + q.length - 1];
  const str = String(text);
  return { start: map[i], end: last + (str.codePointAt(last) > 0xffff ? 2 : 1) };
}

// True when every word of `query` occurs in `text`, ignoring case and accents (template and history search).
export function matchesAll(text, query) {
  const f = foldText(text);
  return foldText(query).split(/\s+/).filter(Boolean).every(w => f.includes(w));
}

// Inline pieces of a Help text: [{t: 'text'|'code'|'key', v}] from `code` spans; `key:<id>` spans are key refs.
export function splitInline(text) {
  const s = String(text ?? '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const a = s.indexOf('`', i);
    if (a < 0) break;
    const b = s.indexOf('`', a + 1);
    if (b < 0) break;
    if (a > i) out.push({ t: 'text', v: s.slice(i, a) });
    const v = s.slice(a + 1, b);
    const m = /^key:([A-Za-z][A-Za-z0-9]*)$/.exec(v);
    out.push(m ? { t: 'key', v: m[1] } : { t: 'code', v });
    i = b + 1;
  }
  if (i < s.length) out.push({ t: 'text', v: s.slice(i) });
  return out;
}

// The keys of a KEYMAP command for this platform as alternatives of strokes: [['F5'], ['Ctrl+Enter']] (a chord has
// two strokes); [] when the id is not in the keymap.
export function keyStrokes(id, { keymap = KEYMAP, mac = false } = {}) {
  const e = keymap.find(k => k.id === id);
  if (!e) return [];
  return keysFor(e, mac).split(/(?<!\+),\s+/).map(alt => alt.trim().split(/\s+/));
}

// Plain text of an inline Help text (key refs resolved), for search.
export function inlineText(text, opts = {}) {
  return splitInline(text).map(p => (p.t === 'key' ? keyStrokes(p.v, opts).map(a => a.join(' ')).join(', ') || 'no shortcut' : p.v)).join('');
}

// ------------------------------------------------------------------------------------------- invisible characters

// Pieces of a text with invisible and bidi characters split out as {inv: 'U+200B'} (03 §5: visible markers).
export function invisiblePieces(text) {
  const s = String(text ?? '');
  const out = [];
  let last = 0;
  for (const m of s.matchAll(INVISIBLE_G)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    out.push({ inv: 'U+' + m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0') });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

// -------------------------------------------------------------------------------------------------- JSON and XML

const BIG_TEXT = 500000;
// The length above which the change dialog highlights its statement only after it is on screen (03 §13).
const LAZY_HIGHLIGHT = 20000;

const isDigit = c => c >= 48 && c <= 57;
const isWordUnit = c => isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isLineEnd = c => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
const JSON_COLON = /\s*:/y;
const JSON_WORDS = ['true', 'false', 'null'];

// JSON tokens with highlight classes (keys .k, strings .s, numbers .n, true/false/null .b);
// anything else is plain text. Never throws. The pieces are exactly those of the global regex
// /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, found by a linear scan: a
// string that is never closed stops at the end of the text (or at a backslash before a line break), and every quote
// it passed is escaped in it, so a string started at such a quote stops at the same place and is not scanned again
// (the regex scans to the end once per quote, which takes minutes for a long unterminated value).
export function jsonPieces(text) {
  const s = String(text ?? '');
  const n = s.length;
  const out = [];
  let last = 0, dead = -1;
  const emit = (at, end, cls) => {
    if (at > last) out.push({ cls: '', text: s.slice(last, at) });
    out.push({ cls, text: s.slice(at, end) });
    last = end;
  };
  let p = 0;
  while (p < n) {
    const c = s.charCodeAt(p);
    if (c === 34) {
      // a string: `"` then escape pairs (a backslash and any character but a line break) or other characters
      let k = p + 1, end = -1;
      if (p >= dead) {
        while (k < n) {
          const d = s.charCodeAt(k);
          if (d === 34) { end = k + 1; break; }
          if (d === 92) { if (k + 1 < n && !isLineEnd(s.charCodeAt(k + 1))) { k += 2; continue; } break; }
          k++;
        }
        if (end < 0) dead = k;
      }
      if (end > 0) {
        JSON_COLON.lastIndex = end;
        const m = JSON_COLON.exec(s);
        emit(p, end, m ? 'k' : 's');
        if (m) emit(end, end + m[0].length, '');
        p = last;
        continue;
      }
    } else if ((c === 116 || c === 102 || c === 110) && (p === 0 || !isWordUnit(s.charCodeAt(p - 1)))) {
      const w = JSON_WORDS.find(x => s.startsWith(x, p));
      if (w && (p + w.length >= n || !isWordUnit(s.charCodeAt(p + w.length)))) { emit(p, p + w.length, 'b'); p = last; continue; }
    } else if (isDigit(c) || (c === 45 && p + 1 < n && isDigit(s.charCodeAt(p + 1)))) {
      let k = c === 45 ? p + 1 : p;
      while (k < n && isDigit(s.charCodeAt(k))) k++;
      if (s.charCodeAt(k) === 46 && k + 1 < n && isDigit(s.charCodeAt(k + 1))) { k += 2; while (k < n && isDigit(s.charCodeAt(k))) k++; }
      const e = s.charCodeAt(k);
      if (e === 101 || e === 69) {
        let r = k + 1;
        if (s.charCodeAt(r) === 43 || s.charCodeAt(r) === 45) r++;
        if (r < n && isDigit(s.charCodeAt(r))) { while (r < n && isDigit(s.charCodeAt(r))) r++; k = r; }
      }
      emit(p, k, 'n');
      p = last;
      continue;
    }
    p++;
  }
  if (last < n) out.push({ cls: '', text: s.slice(last) });
  return out;
}

// JSON re-indented with 2 spaces without changing any token (big numbers and escapes stay as written), or null when
// the text is not a single well-formed JSON value.
export function prettyJson(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > BIG_TEXT) return null;
  const tokRe = /\s+|"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\u0000-\u001f])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/y;
  const toks = [];
  let i = 0;
  while (i < s.length) {
    tokRe.lastIndex = i;
    const m = tokRe.exec(s);
    if (!m) return null;
    if (!/^\s/.test(m[0])) toks.push(m[0]);
    i = tokRe.lastIndex;
  }
  // validate the structure (recursive descent, nesting capped at 512)
  let p = 0, nest = 0;
  const value = () => {
    const t = toks[p];
    if (t === '{' || t === '[') {
      if (++nest > 512) return false;
      const obj = t === '{', close = obj ? '}' : ']';
      p++;
      if (toks[p] === close) { p++; nest--; return true; }
      for (;;) {
        if (obj) {
          if (!/^"/.test(toks[p] ?? '')) return false;
          p++;
          if (toks[p++] !== ':') return false;
        }
        if (!value()) return false;
        if (toks[p] === ',') { p++; continue; }
        if (toks[p] === close) { p++; nest--; return true; }
        return false;
      }
    }
    if (t === undefined || /^[{}[\]:,]$/.test(t)) return false;
    p++;
    return true;
  };
  if (!value() || p !== toks.length) return null;
  let out = '', depth = 0;
  const nl = () => '\n' + '  '.repeat(depth);
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t === '{' || t === '[') {
      const close = t === '{' ? '}' : ']';
      if (toks[k + 1] === close) { out += t + close; k++; continue; }
      depth++;
      out += t + nl();
    } else if (t === '}' || t === ']') { depth--; out += nl() + t; }
    else if (t === ',') out += ',' + nl();
    else if (t === ':') out += ': ';
    else out += t;
  }
  return out;
}

// XML tokens with the editor's classes (tag names t-kw, attribute names t-fn, values t-str,
// comments t-cmt, markup punctuation t-punc); text content is plain. Never throws.
export function xmlPieces(text) {
  const s = String(text ?? '');
  const out = [];
  const push = (cls, t) => { if (t) out.push({ cls, text: t }); };
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { push('', s.slice(i)); break; }
    push('', s.slice(i, lt));
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      const end = e < 0 ? s.length : e + 3;
      push('t-cmt', s.slice(lt, end));
      i = end;
      continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt);
      const end = e < 0 ? s.length : e + 3;
      push('t-str', s.slice(lt, end));
      i = end;
      continue;
    }
    const m = /^<(\/|\?|!)?([^\s/>?]*)/.exec(s.slice(lt, lt + 300));
    push('t-punc', '<' + (m[1] ?? ''));
    push('t-kw', m[2]);
    let j = lt + m[0].length;
    for (;;) {
      if (j >= s.length) { i = j; break; }
      const rest = s.slice(j, j + 4096);
      const ws = /^\s+/.exec(rest);
      if (ws) { push('', ws[0]); j += ws[0].length; continue; }
      const close = /^(\/?>|\?>)/.exec(rest);
      if (close) { push('t-punc', close[0]); i = j + close[0].length; break; }
      const attr = /^([^\s=/>"']+)(\s*=\s*)?("[^"]*"?|'[^']*'?)?/.exec(rest);
      if (attr && attr[0]) {
        push('t-fn', attr[1]);
        if (attr[2]) push('t-punc', attr[2]);
        if (attr[3]) push('t-str', attr[3]);
        j += attr[0].length;
        continue;
      }
      push('', s[j]);
      j++;
    }
  }
  return out;
}

// A text without its leading and its trailing whitespace run when that run holds a line break (a linear scan: no
// backtracking regex over a long run of spaces).
function dropBreakIndent(t) {
  const ws = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || /\s/.test(c);
  const brk = (a, b) => { for (let i = a; i < b; i++) if (t[i] === '\n' || t[i] === '\r') return true; return false; };
  let a = 0, z = t.length;
  while (a < z && ws(t[a])) a++;
  const from = brk(0, a) ? a : 0;
  while (z > a && ws(t[z - 1])) z--;
  const to = brk(z, t.length) ? z : t.length;
  return t.slice(from, to);
}

// XML re-indented with 2 spaces (03 §8 cell viewer: a token-preserving re-indent): every tag, comment, CDATA section
// and processing instruction on its own line, except an element whose only content is text, which stays on one line
// exactly as written. A tag ends at the first '>' outside a quoted attribute value. Whitespace-only text between tags
// is dropped (display only); other text keeps every character except a leading or trailing run of whitespace that
// holds a line break (the source's own indentation, which the re-indent replaces). null when the text has no tags or
// more than 500,000 characters.
export function prettyXml(text) {
  const s = String(text ?? '');
  if (s.length > BIG_TEXT || !/<[A-Za-z?!]/.test(s)) return null;
  const parts = [];
  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<(?:[^>"']|"[^"]*"|'[^']*')*>?|[^<]+/g;
  for (const m of s.matchAll(re)) parts.push(m[0]);
  const lines = [];
  let depth = 0;
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p[0] !== '<') { if (p.trim()) lines.push('  '.repeat(depth) + dropBreakIndent(p)); continue; }
    const closing = p.startsWith('</');
    const self = p.endsWith('/>') || p.startsWith('<?') || p.startsWith('<!');
    if (!closing && !self && parts[k + 1] != null && parts[k + 1][0] !== '<' && parts[k + 2]?.startsWith('</')) {
      lines.push('  '.repeat(depth) + p + parts[k + 1] + parts[k + 2]);
      k += 2;
      continue;
    }
    if (closing) depth = Math.max(0, depth - 1);
    lines.push('  '.repeat(depth) + p);
    if (!closing && !self) depth++;
  }
  return lines.join('\n');
}

// The function name under a caret (03 §8.2: F1 opens Functions there), or null: an identifier followed by '(' that
// docFor() knows, or the AT TIME ZONE entry when the caret is on AT, TIME or ZONE of that operator.
export function functionAtCaret(text, pos) {
  const s = String(text ?? '');
  let toks;
  try { toks = tokenize(s, true); } catch { return null; }
  const real = toks.filter(t => t.t !== 'ws' && t.t !== 'cmt' && t.t !== 'end');
  const i = real.findIndex(t => t.s <= pos && pos <= t.e && t.t === 'id');
  if (i < 0) return null;
  const t = real[i];
  const k = t.v.toUpperCase();
  const word = j => (real[j]?.t === 'id' ? real[j].v.toUpperCase() : null);
  for (let a = i - 2; a <= i; a++) {
    if (word(a) === 'AT' && word(a + 1) === 'TIME' && word(a + 2) === 'ZONE') return docFor('AT TIME ZONE')?.name ?? null;
  }
  if (real[i + 1]?.v !== '(') return null;
  const doc = docFor(k);
  return doc ? doc.name : null;
}

// Rows [start, end) of a virtual list that are rendered for a scroll position (overscan rows on both sides).
export function visibleRange(scrollTop, viewHeight, rowHeight, count, overscan = 4) {
  if (!(count > 0) || !(rowHeight > 0)) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(viewHeight, rowHeight) / rowHeight) + 1;
  const start = Math.max(0, Math.min(count - 1, first) - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end: Math.max(start, end) };
}

// ------------------------------------------------------------------------------------------- change confirmation

const OP_VERB = Object.freeze({ update: 'Update', delete: 'Delete', insert: 'Create', associate: 'Associate', disassociate: 'Disassociate' });
const MESSAGE_OF = Object.freeze({ update: 'Update', delete: 'Delete', insert: 'Create', associate: 'Associate', disassociate: 'Disassociate' });
const PART_LABELS = [['update', 'Updates'], ['delete', 'Deletes'], ['insert', 'Creates']];
const count0 = v => (Number.isFinite(v) && v > 0 ? v : 0);
const tableOf = p => (typeof p?.entity === 'string' ? p.entity : p?.entity?.logicalName ?? '');
const displayOf = p => (isObj(p?.entity) && p.entity.displayName) || tableOf(p) || 'table';

// The record count a change dialog shows (02 §8.2): the create count for inserts, else `count`.
export function changeCount(p) {
  if (!p) return 0;
  return count0(p.op === 'insert' ? (p.creates ?? p.count) : p.count);
}

// Records in one part of a grid change set (op 'mixed'): its ids, else its ops, else its sample.
export function partCount(part) {
  if (Array.isArray(part?.ids) && part.ids.length) return part.ids.length;
  if (Array.isArray(part?.ops) && part.ops.length) return part.ops.length;
  return Array.isArray(part?.sample) ? part.sample.length : 0;
}

// The per-part counts of a grid change set: 'Updates 9 · Deletes 2 · Creates 1' (03 §8).
export function mixedCounts(p) {
  const counts = new Map();
  for (const part of Array.isArray(p?.parts) ? p.parts : []) counts.set(part.op, (counts.get(part.op) ?? 0) + partCount(part));
  return PART_LABELS.filter(([op]) => counts.has(op)).map(([op, label]) => `${label} ${fmtInt(counts.get(op))}`).join(' · ');
}

// True when a DELETE preview runs as Dataverse BulkDelete jobs (02 §8.1 DELETE, `preview.bulkDelete = {jobs}`).
export function isBulkDelete(p) {
  return isObj(p?.bulkDelete) && p?.op === 'delete';
}

// The change dialog title (03 §8): 'Update 37 Organization records?', 'Delete 37 Audit records in the background?'
// (a BulkDelete job), 'Run action WinOpportunity?', 'Apply 12 changes to account?'.
export function changeTitle(p) {
  const n = changeCount(p);
  if (p.op === 'action') return `Run action ${p.actionName ?? ''}?`;
  if (p.op === 'mixed') return `Apply ${plural(n, 'change')} to ${tableOf(p)}?`;
  if (p.op === 'associate' || p.op === 'disassociate') return `${OP_VERB[p.op]} ${plural(n, 'pair')} of records in ${displayOf(p)}?`;
  const what = `${fmtInt(n)} ${displayOf(p)} ${n === 1 ? 'record' : 'records'}`;
  if (isBulkDelete(p)) return `Delete ${what} in the background?`;
  return `${OP_VERB[p.op] ?? 'Change'} ${what}?`;
}

// The label of the dialog's danger action, with the count: 'Update 37 records', 'Delete 37 in the background',
// 'Run WinOpportunity'.
export function changeActionLabel(p) {
  const n = changeCount(p);
  if (p.op === 'action') return `Run ${p.actionName ?? 'action'}`;
  if (p.op === 'mixed') return `Apply ${plural(n, 'change')}`;
  if (p.op === 'associate' || p.op === 'disassociate') return `${OP_VERB[p.op]} ${plural(n, 'pair')}`;
  if (isBulkDelete(p)) return `Delete ${fmtInt(n)} in the background`;
  return `${OP_VERB[p.op] ?? 'Change'} ${plural(n, 'record')}`;
}

// The text the dialog requires typed (02 §8.2 requireTyped), or null; a BulkDelete job always needs the record count
// (03 §8), also when the preview leaves requireTyped null.
export function requiredText(p) {
  if (p?.requireTyped != null && p.requireTyped !== '') return String(p.requireTyped);
  return isBulkDelete(p) ? String(changeCount(p)) : null;
}

// The write ops of a preview (its exact requests, 02 §8.2): preview.ops, else grantSpec.ops.
const opsOf = p => (Array.isArray(p?.ops) ? p.ops : Array.isArray(p?.grantSpec?.ops) ? p.grantSpec.ops : []);

// True when an INSERT, UPDATE or DELETE sends message requests per record (close states, list members, sharing,
// solution components, SetParentBusinessUnit: action ops of a DML preview, 02 §8.1); a BulkDelete job is not.
export function sendsMessages(p) {
  return p?.op !== 'action' && p?.op !== 'mixed' && !isBulkDelete(p) && opsOf(p).some(o => o?.op === 'action');
}

// True when the preview's sample names each record's requests (`sample[].sentAs`, 02 §8.2).
export function hasSentAs(sample) {
  return Array.isArray(sample) && sample.some(r => typeof r?.sentAs === 'string' && r.sentAs !== '');
}

// The automation note of 02 §8.1 step 6b, or null: 'Runs 3 custom plug-in steps and 2 flows on Update of account;
// they can change other records.' (Create/CreateMultiple for an INSERT sent with CreateMultiple).
export function automationText(p) {
  const a = p?.automation;
  if (!isObj(a)) return null;
  const steps = count0(a.pluginSteps), flows = count0(a.workflows);
  if (!steps && !flows) return null;
  const what = [];
  if (steps) what.push(plural(steps, 'custom plug-in step'));
  if (flows) what.push(plural(flows, 'flow'));
  let message;
  if (p.op === 'action') message = p.actionName ?? 'the action';
  else if (p.op === 'mixed') message = [...new Set((p.parts ?? []).map(x => MESSAGE_OF[x.op]).filter(Boolean))].join('/') || 'Update';
  else if (p.op === 'insert' && p.options?.createMultiple) message = 'Create/CreateMultiple';
  else message = MESSAGE_OF[p.op] ?? 'Update';
  return `Runs ${what.join(' and ')} on ${message} of ${tableOf(p)}; they can change other records.`;
}

// The kind of a cascaded effect: 'delete' (Cascade), 'removelink', 'assign' or 'reparent'.
const cascadeKind = c => {
  const a = lower(c?.action);
  return a === 'removelink' || a === 'assign' || a === 'reparent' ? a : 'delete';
};
// The attribute a RemoveLink clears, when the cascade entry names it (02 §8.2 gives {relationship, table, action, count}).
const cascadeAttr = c => {
  for (const k of ['attribute', 'attr', 'referencingAttribute']) if (typeof c?.[k] === 'string' && c[k]) return c[k];
  return null;
};

// The note for one cascaded effect (02 §8.1 step 6b): {level, text}. dml.js puts these texts in preview.warnings; the
// dialog builds one only for a preview.cascade entry that no warning describes (see changeNotes).
export function cascadeNote(c) {
  const n = count0(c?.count), t = c?.table ?? '', rel = c?.relationship ?? '';
  const recs = n === 1 ? 'record' : 'records';
  const kind = cascadeKind(c);
  if (kind === 'removelink') {
    const attr = cascadeAttr(c);
    return { level: 'warning', text: attr ? `Clears ${attr} on ${fmtInt(n)} ${t} ${recs}.` : `Clears the lookup on ${fmtInt(n)} ${t} ${recs} via ${rel}.` };
  }
  if (kind === 'assign') return { level: 'warning', text: `Also assigns ${fmtInt(n)} ${t} ${recs} to the new owner via ${rel}.` };
  if (kind === 'reparent') return { level: 'warning', text: `Also reparents ${fmtInt(n)} ${t} ${recs} via ${rel}.` };
  return { level: 'danger', text: `Also deletes ${fmtInt(n)} ${t} ${recs} (and their own cascaded records) via ${rel}.` };
}

const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CASCADE_VERB = Object.freeze({ delete: /\bdelet/i, removelink: /\bclear/i, assign: /\bassign/i, reparent: /\breparent/i });

// True when a warning text names this relationship: `via <relationship>` not followed by a name character, so 'via x_2'
// does not name x.
export function warningNamesRelationship(text, rel) {
  if (!rel) return false;
  return new RegExp(`\\bvia ${reEsc(rel)}(?![A-Za-z0-9_])`).test(String(text ?? ''));
}

// True when a warning text describes this cascaded effect without naming its relationship: the same record count
// (as written with or without grouping) of the same table and the verb of the effect (02 §8.1 step 6b: 'Clears
// <attr> on N <table> records.').
export function warningDescribesCascade(text, c) {
  const n = count0(c?.count);
  const t = String(c?.table ?? '');
  if (!n || !t) return false;
  const s = String(text ?? '');
  const counts = [...new Set([String(n), fmtInt(n)])].map(reEsc).join('|');
  return new RegExp(`(?<![\\d,.])(?:${counts})\\s+${reEsc(t)}\\s+records?\\b`, 'i').test(s) && CASCADE_VERB[cascadeKind(c)].test(s);
}

// The preview.cascade entries that no preview.warnings text describes, in order: dml.js writes a warning per cascaded
// effect, so these are only the ones it left out. Each warning accounts for at most one entry; a warning that names
// the relationship is matched first.
export function undescribedCascades(cascade, warnings) {
  const list = (Array.isArray(cascade) ? cascade : []).filter(c => count0(c?.count));
  const texts = (Array.isArray(warnings) ? warnings : []).filter(w => w && w.text).map(w => String(w.text));
  const used = new Set(), covered = new Set();
  list.forEach((c, i) => {
    const j = texts.findIndex((w, k) => !used.has(k) && warningNamesRelationship(w, c.relationship));
    if (j >= 0) { used.add(j); covered.add(i); }
  });
  list.forEach((c, i) => {
    if (covered.has(i)) return;
    const j = texts.findIndex((w, k) => !used.has(k) && warningDescribesCascade(w, c));
    if (j >= 0) { used.add(j); covered.add(i); }
  });
  return list.filter((_, i) => !covered.has(i));
}

const NOTE_LEVEL = new Map([['danger', 'danger'], ['error', 'danger'], ['warning', 'warning'], ['warn', 'warning'], ['info', 'info']]);
export const BYPASS_NOTE = 'Bypassing custom plug-ins or business logic needs the matching privilege (prvBypassCustomPlugins or prvBypassCustomBusinessLogic); Dataverse refuses the request without it.';
export const NO_BACKUP_NOTE = 'No backup: more than 5,000 records.';
export const CASCADE_BACKUP_NOTE = 'The backup does not include records deleted by cascade.';
// The danger note of a DELETE run as BulkDelete jobs, shown first (03 §8, 00 §5 rule 4).
export const BULK_DELETE_NOTE = 'Deletes in the background. The job does not check If-Match, so records changed after this preview are deleted too.';

// Every note of the change dialog, in order, without duplicates: [{level: 'danger'|'warning'|'info', text}].
export function changeNotes(p, { backupBeforeDelete = false } = {}) {
  const notes = [];
  const seen = new Set();
  const add = (level, text) => { if (text && !seen.has(text)) { seen.add(text); notes.push({ level, text }); } };
  if (isBulkDelete(p)) add('danger', BULK_DELETE_NOTE);
  const env = p?.environment;
  if (!env || env.isProduction !== false) {
    add('danger', env?.name ? `You are changing data in the Production environment ${quoteName(env.name)}.` : 'You are changing data in a Production environment.');
  }
  const warnings = Array.isArray(p?.warnings) ? p.warnings.filter(w => w && w.text) : [];
  for (const w of warnings) add(NOTE_LEVEL.get(lower(w.level)) ?? 'warning', String(w.text));
  const cascade = Array.isArray(p?.cascade) ? p.cascade : [];
  for (const c of undescribedCascades(cascade, warnings)) {
    const n = cascadeNote(c);
    add(n.level, n.text);
  }
  const auto = automationText(p);
  if (auto && !warnings.some(w => String(w.text).includes('they can change other records'))) add('warning', auto);
  if (p?.options?.bypassPlugins || p?.options?.bypassLogic) add('warning', BYPASS_NOTE);
  if (p?.op === 'delete') {
    if (!p.backup && backupBeforeDelete && changeCount(p) > 5000) add('danger', NO_BACKUP_NOTE);
    if (p.backup && cascade.some(c => count0(c?.count))) add('info', CASCADE_BACKUP_NOTE);
  }
  return notes;
}

const batchSizeOf = v => (Number.isInteger(v) && v >= 1 && v <= 1000 ? v : null);
// Records per BulkDelete job (02 §8.1 DELETE: one action op per 20,000 previewed ids).
const BULK_DELETE_CHUNK = 20000;

// The 'Sent as' fact (03 §8): CreateMultiple, BulkDelete jobs, messages per record, else $batch.
export function sentAsText(p) {
  const o = isObj(p?.options) ? p.options : {};
  if (isBulkDelete(p)) {
    const jobs = Number.isSafeInteger(p.bulkDelete.jobs) && p.bulkDelete.jobs > 0 ? p.bulkDelete.jobs : Math.max(1, Math.ceil(changeCount(p) / BULK_DELETE_CHUNK));
    return jobs === 1 ? 'BulkDelete job' : `BulkDelete jobs (${fmtInt(jobs)}, up to ${fmtInt(BULK_DELETE_CHUNK)} records each)`;
  }
  if (sendsMessages(p)) return 'Messages, per record (below)';
  const cm = o.createMultiple ? `CreateMultiple, up to ${fmtInt(o.createMultiple.chunk ?? 100)} records per request` : null;
  // In a grid change set only the creates go as CreateMultiple; updates and deletes are always $batch (02 §8.1).
  const others = p?.op === 'mixed' && (p.parts ?? []).some(x => x.op !== 'insert');
  return !cm ? '$batch' : others ? `$batch; creates as ${cm}` : cm;
}

// The facts row of the change dialog (03 §8): [[label, value]]. Batch size is preview.options.batchSize, else the
// batchSize setting passed in (03 §8.1, default 50): the starting and largest size of api.write's adaptive batches
// (02 §8.1 step 8).
export function changeFacts(p, { batchSize = null } = {}) {
  const f = [];
  const o = isObj(p?.options) ? p.options : {};
  const op = p?.op;
  const writes = op !== 'action';
  if (writes) f.push(['Records', fmtInt(changeCount(p))]);
  if (op === 'update' || op === 'mixed' || count0(p?.skipped)) f.push(['Unchanged (skipped)', fmtInt(count0(p?.skipped))]);
  if (op === 'update' || op === 'delete' || op === 'mixed' || count0(p?.removed)) f.push(['Removed since selection', fmtInt(count0(p?.removed))]);
  const cols = Array.isArray(p?.columns) ? p.columns : [];
  if ((op === 'update' || op === 'insert' || op === 'mixed') && cols.length) {
    const names = cols.map(c => c.displayName || c.name);
    f.push(['Columns', names.length > 6 ? `${names.slice(0, 6).join(', ')} +${fmtInt(names.length - 6)} more` : names.join(', ')]);
  }
  // A BulkDelete job is one request per 20,000 records ('Sent as' says so), not adaptive batches.
  if (writes && !isBulkDelete(p)) f.push(['Batch size', `up to ${fmtInt(batchSizeOf(o.batchSize) ?? batchSizeOf(batchSize) ?? 50)}, smaller when Dataverse is slow`]);
  if (writes) f.push(['Sent as', sentAsText(p)]);
  f.push(['Plug-ins bypassed', o.bypassPlugins && o.bypassLogic ? 'Custom plug-ins and business logic' : o.bypassPlugins ? 'Custom plug-ins' : o.bypassLogic ? 'Custom business logic' : 'No']);
  if (o.suppressFlows) f.push(['Flows', 'Not triggered']);
  const deletes = op === 'delete' || (op === 'mixed' && (p.parts ?? []).some(x => x.op === 'delete'));
  if (deletes) f.push(['Recycle bin', p.recycleBin === true ? 'On (restorable for 30 days)' : p.recycleBin === false ? 'Off' : 'Unknown']);
  return f;
}

// The preview tables of a change dialog: one per part of a grid change set, else one: [{op, title, columns, sample,
// total, sentAs}] (an action has none: its parameters are listed instead). sentAs: the table gets a 'Sent as' column
// with each record's requests, because they differ per record (03 §8).
export function previewTables(p) {
  if (p?.op === 'action') return [];
  if (p?.op === 'mixed' && Array.isArray(p.parts)) {
    return p.parts.map(part => ({
      op: part.op, title: (PART_LABELS.find(([op]) => op === part.op)?.[1] ?? 'Changes') + ' · ' + fmtInt(partCount(part)),
      columns: part.columns ?? [], sample: part.sample ?? [], total: partCount(part), sentAs: hasSentAs(part.sample),
    }));
  }
  return [{ op: p?.op, title: null, columns: p?.columns ?? [], sample: p?.sample ?? [], total: changeCount(p), sentAs: hasSentAs(p?.sample) }];
}

// True when the typed text is exactly the required confirmation text (surrounding spaces ignored).
export function typedMatches(input, required) {
  const want = String(required ?? '').trim();
  return want !== '' && String(input ?? '').trim() === want;
}

// The delete backup button: 'Download backup (37 records, 1.2 MB)'.
export function backupLabel(b) {
  return `Download backup (${plural(count0(b?.count), 'record')}, ${fmtBytes(count0(b?.bytes))})`;
}

// The before/after log as one Blob (02 §8.2): from text(), or, above 50,000 records, from chunks() (strings of at
// most 5,000 records each) without building one string, yielding between chunks so the page stays responsive;
// onProgress(pct) follows the chunks.
export async function beforeAfterBlob(b, { onProgress = () => {}, yieldFn = yieldToUi } = {}) {
  const type = 'application/json';
  if (typeof b?.chunks !== 'function') return new Blob([String(b?.text?.() ?? '')], { type });
  const total = Math.max(1, Math.ceil(count0(b.count) / 5000));
  // Each chunk is added to the Blob as it comes (a Blob made of a Blob references its data), so a chunk's string can
  // be collected before the next one is built.
  let blob = new Blob([], { type }), n = 0;
  for (const c of b.chunks()) {
    blob = new Blob([blob, String(c)], { type });
    n++;
    onProgress(Math.min(99, Math.round((n / total) * 100)));
    await yieldFn();
  }
  onProgress(100);
  return blob;
}

// Text of an action parameter value (03 §8): EntityReference values with the record's primary name.
export function paramText(v, tz) {
  if (v == null) return 'NULL';
  if (v instanceof Date) return fmtDate(v, tz, { ms: true });
  if (isObj(v) && (v.id != null || v.entity != null)) {
    return [v.name, v.entity ?? v.logicalName, v.id].filter(x => x != null && x !== '').map(String).join(' · ');
  }
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

// ------------------------------------------------------------------------------- standing approval

// The ChangePreview ops a standing approval can be given for: the DML statements of 00 §5 rule 2 (an EXEC action, a
// grid change set and a BulkDelete job never get one).
const STANDING_OPS = new Set(['update', 'delete', 'insert', 'associate', 'disassociate']);
// What a DELETE approval states next to its checkbox (03 §8, 02 §9: no dialog means no backup click).
export const STANDING_NOBACKUP = 'Later executions are not backed up.';
// The title of the disabled checkbox while 'Download a backup first' is ticked (03 §8).
export const STANDING_BACKUP_TITLE = 'Untick “Download a backup first” to approve later executions; they open no dialog to save a backup in.';
// What dialogs.js announces when approvals end (03 §8; the pill announces its own text, 03 §3).
export const STANDING_ENDED_TEXT = 'Standing approval ended.';
// The error of a Confirm click on a preview whose grant spec was replaced while its dialog was open (nothing is minted).
export const PREVIEW_CHANGED = 'The change preview changed while its dialog was open; nothing was changed. Run the statement again to preview it.';
const nonEmpty = v => typeof v === 'string' && v !== '';
// The dangerKinds of a preview (02 §9), or null when it has none to compare (not an array of strings: fail closed).
const kindsOf = p => (Array.isArray(p?.dangerKinds) && p.dangerKinds.every(k => typeof k === 'string') ? p.dangerKinds : null);

// The standing-approval checkbox label (03 §8): 'Apply to every later execution of this statement in this run, up to
// 1,200 records in total'; a DELETE adds 'Later executions are not backed up.'.
export function standingLabel(cap, op) {
  const text = `Apply to every later execution of this statement in this run, up to ${plural(count0(cap), 'record')} in total`;
  return op === 'delete' ? `${text}. ${STANDING_NOBACKUP}` : text;
}

// The default N of a standing approval (03 §8): 10 × this execution's count, at most maxChangeRows, at least the count.
export function standingDefaultCap(count, maxChangeRows) {
  const n = count0(count);
  const max = Number.isSafeInteger(maxChangeRows) && maxChangeRows >= 1 ? maxChangeRows : 5000;
  return Math.max(n, Math.min(max, n * 10));
}

// A whole number typed as a record count, grouping separators (commas, spaces, apostrophes) ignored: 1200 for '1,200'
// and '1 200'; null for anything else (03 §8: 'digits; grouping separators are ignored when comparing').
export function parseCount(text) {
  const t = String(text ?? '').trim().replace(/[\s,'’]/g, '');
  if (!/^\d{1,15}$/.test(t)) return null;
  const v = Number(t);
  return Number.isSafeInteger(v) ? v : null;
}

// Whether the change dialog offers the standing approval (03 §8, 02 §9, 00 §5 rule 2): {offered, reason}. Only from
// the second execution of a DML statement in a run, never while impersonating (the preview's flag, the acting user or
// a grant spec with a caller), never for a BulkDelete job or a grid change set, and never when the session declined it
// (preview.standing.offered false) or the preview lacks the identity and danger kinds the later checks compare.
export function standingOffer(p, { caller = null } = {}) {
  const no = reason => ({ offered: false, reason });
  if (!isObj(p)) return no('preview');
  if (!Number.isSafeInteger(p.execution) || p.execution < 2) return no('first');
  if (p.op === 'mixed') return no('mixed');
  if (isObj(p.bulkDelete)) return no('bulkdelete');
  if (!STANDING_OPS.has(p.op)) return no('op');
  if (p.impersonating || caller != null || p.grantSpec?.callerId != null) return no('impersonating');
  if (isObj(p.standing) && p.standing.offered === false) return no('session');
  if (!nonEmpty(p.statementKey) || !nonEmpty(p.runId) || !tableOf(p) || !isObj(p.grantSpec)) return no('identity');
  const kinds = kindsOf(p);
  if (!kinds) return no('danger');
  if (kinds.some(k => k.toLowerCase() === 'bulkdelete')) return no('bulkdelete');
  if (changeCount(p) < 1) return no('count');
  return { offered: true, reason: null };
}

// The request kinds of a grant spec: one 'op|entity|action name' string per op (02 §1 WriteOp), each once.
export function opKinds(spec) {
  const ops = Array.isArray(spec?.ops) ? spec.ops : [];
  return [...new Set(ops.map(o => `${String(o?.op ?? '')}|${lower(o?.entity ?? '')}|${String(o?.name ?? '')}`))];
}

// The option headers a grant spec confirms (02 §8.1 Hints, §8.3), as one comparable string.
export function headerKey(spec) {
  const o = isObj(spec?.options) ? spec.options : {};
  return ['bypassPlugins', 'bypassLogic', 'suppressFlows', 'suppressDuplicateDetection', 'ignoreDupKey', 'continueOnError'].map(k => (o[k] ? 1 : 0)).join('');
}

// Why a later execution cannot be granted from approval `a` (02 §8.3), or null when it can: the same statement key,
// run, op and table, a running total that stays within N, no danger kind the approving dialog did not show, the same
// acting user (never another one), changes allowed, and neither a BulkDelete job nor a grid change set. When the
// approval records them (dialogs.js always does), its grant spec may only use request kinds and option headers that
// the approving one had. `count` is the record count read once by the caller.
export function standingRefusal(a, p, { allowed = false, caller = null, count } = {}) {
  if (!isObj(a)) return 'none';
  if (!isObj(p)) return 'preview';
  if (!nonEmpty(p.statementKey) || p.statementKey !== a.key) return 'key';
  if (!nonEmpty(p.runId) || p.runId !== a.runId) return 'run';
  if (p.op !== a.op || tableOf(p) !== a.table) return 'statement';
  if (!Number.isSafeInteger(p.execution) || p.execution < 2) return 'first';
  if (p.op === 'mixed') return 'mixed';
  if (isObj(p.bulkDelete)) return 'bulkdelete';
  if (p.impersonating || caller != null) return 'impersonating';
  if ((p.grantSpec?.callerId ?? null) !== a.callerId || a.callerId !== null) return 'caller';
  if (allowed !== true) return 'off';
  if (!isObj(p.grantSpec)) return 'spec';
  if (Array.isArray(a.opKinds) && opKinds(p.grantSpec).some(k => !a.opKinds.includes(k))) return 'requests';
  if (typeof a.headers === 'string' && headerKey(p.grantSpec) !== a.headers) return 'headers';
  const kinds = kindsOf(p);
  if (!kinds || kinds.some(k => !a.dangerKinds.includes(k))) return 'danger';
  const n = count === undefined ? changeCount(p) : count;
  if (!Number.isSafeInteger(n) || n < 1) return 'count';
  if (a.total + n > a.cap) return 'cap';
  return null;
}

// -------------------------------------------------------------------------- environment, users and impersonation

// What to type to confirm in Production: the environment's name, else (organisation not read) the page's host name.
export function envTypedName(env, loc = globalThis.location) {
  return String(env?.name || loc?.hostname || '');
}

// A user for the impersonation dialogs from any of the shapes sessions and rows use: {id, name, domain,
// businessUnit}.
export function userSummary(u) {
  const o = isObj(u) ? u : {};
  const pick = (...ks) => { for (const k of ks) if (o[k] != null && o[k] !== '') return String(o[k]); return ''; };
  return {
    id: pick('id', 'systemuserid'),
    name: pick('fullName', 'fullname', 'name'),
    domain: pick('domainName', 'domainname', 'domain'),
    businessUnit: pick('businessUnit', 'businessUnitName', 'businessunitidname', 'businessunit', '_businessunitid_value@OData.Community.Display.V1.FormattedValue'),
  };
}

// A LIKE pattern text matching `s` literally: [, % and _ are bracketed.
export function likeEscape(s) {
  return String(s ?? '').replace(/[[%_]/g, c => `[${c}]`);
}

// The fault codes of a refused leading-wildcard LIKE (03 §7 ERROR_HINTS).
export const LEADING_WILDCARD_CODES = Object.freeze(['0x80048573', '0x80048644']);

// FetchXML of the Execute as picker: enabled users whose full name or domain name contains `q`, by full name. With
// {prefix: true} (after Dataverse refused the leading wildcard) users whose full name, first name, last name or
// domain name starts with `q`, which never needs one.
export function userSearchXml(q, top = 50, { prefix = false } = {}) {
  const text = likeEscape(String(q ?? '').trim());
  const pat = xmlEsc(prefix ? `${text}%` : `%${text}%`);
  const attrs = prefix ? ['fullname', 'firstname', 'lastname', 'domainname'] : ['fullname', 'domainname'];
  return `<fetch top="${top}"><entity name="systemuser"><attribute name="systemuserid"/><attribute name="fullname"/>` +
    '<attribute name="domainname"/><attribute name="businessunitid"/><order attribute="fullname"/><filter type="and">' +
    '<condition attribute="isdisabled" operator="eq" value="0"/><filter type="or">' +
    attrs.map(a => `<condition attribute="${a}" operator="like" value="${pat}"/>`).join('') +
    '</filter></filter></entity></fetch>';
}

// A picker row from a systemuser response row.
export function userFromRow(r) {
  return {
    id: lower(r?.systemuserid ?? ''),
    fullname: String(r?.fullname ?? ''),
    domainname: String(r?.domainname ?? ''),
    businessunitidname: String(r?.['_businessunitid_value@OData.Community.Display.V1.FormattedValue'] ?? ''),
  };
}

// ---------------------------------------------------------------------------------------- views (03 §7, §8)

const ETN_RE = /^[a-z0-9_]+$/;

// View parameters of the host page URL (03 §8 Import current view): {etn, viewId, viewType, badViewId}; etn only when
// it matches ^[a-z0-9_]+$, viewId only when it is a GUID (braces allowed). viewType is read only together with a
// view id: 1039 or 4230 (1039 when the id comes without a type; NaN for any other type); without a view id it is
// null whatever the URL says, because the default public view applies.
export function viewParams(href) {
  let u;
  try { u = new URL(String(href ?? '')); } catch { return { etn: null, viewId: null, viewType: null, badViewId: false }; }
  const q = u.searchParams;
  const etnRaw = q.get('etn');
  const etn = etnRaw && ETN_RE.test(etnRaw) ? etnRaw : null;
  const vidRaw = q.get('viewid') ?? q.get('viewId');
  const vid = vidRaw == null ? null : vidRaw.trim().replace(/^\{(.*)\}$/, '$1');
  const viewId = vid && isGuid(vid) ? lower(vid) : null;
  let viewType = null;
  if (viewId) {
    const vtRaw = q.get('viewType') ?? q.get('viewtype');
    viewType = vtRaw == null || vtRaw.trim() === '' ? 1039 : Number(vtRaw);
    if (viewType !== 1039 && viewType !== 4230) viewType = NaN;
  }
  return { etn, viewId, viewType, badViewId: vidRaw != null && !viewId };
}

// The first line of an imported view's query (03 §8): CR/LF and other line breaks in the name become spaces.
export function importHeader(name, isDefault = false) {
  const n = String(name ?? '').replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, ' ');
  return `-- Imported from view “${n}”${isDefault ? ' (default view)' : ''}. Column filters and search applied in the grid are not included.`;
}

// The FetchXML → SQL options (03 §8, 02 §10): 'Relative dates as' choices and the note under the select.
export const DATE_OPERATOR_CHOICES = Object.freeze([
  ['functions', 'Functions (exact Dataverse semantics)'], ['literals', 'Literal dates'], ['dateadd', 'DATEADD expressions'],
]);
export const FETCH_DATES_NOTE = "Literal dates are fixed when you convert; DATEADD expressions are computed when the query runs, in SQL Studio's time zone; functions keep Dataverse's own evaluation.";

// The fetchToSql options of a layout.fetchToSql value (02 §10), each field checked on its own (03 §2 defaults).
export function fetchOptions(v) {
  const o = isObj(v) ? v : {};
  return {
    variables: o.variables === true,
    dateOperators: DATE_OPERATOR_CHOICES.some(([k]) => k === o.dateOperators) ? o.dateOperators : 'functions',
    utc: o.utc === true,
  };
}

// The tables and columns a FetchXML document names (03 §8), each once in document order: {tables: [name], attrs:
// [{table, attr}]}. Columns come from <attribute>, <order attribute> and <condition attribute>/valueof (the table of
// their entity, or of the link alias that entityname or 'alias.column' names) and from link-entity from/to.
export function fetchXmlNames(doc) {
  const tables = [], attrs = [];
  const seenT = new Set(), seenA = new Set();
  const addT = t => { if (nonEmpty(t) && !seenT.has(lower(t))) { seenT.add(lower(t)); tables.push(t); } };
  const addA = (table, attr) => {
    if (!nonEmpty(table) || !nonEmpty(attr)) return;
    const k = `${lower(table)}\u0000${lower(attr)}`;
    if (!seenA.has(k)) { seenA.add(k); attrs.push({ table, attr }); }
  };
  const aliases = new Map();
  const nameOf = el => el?.attrs?.get?.('name') ?? null;
  // Aliases first, so that entityname and 'alias.column' can name a link that comes later in the document.
  const collect = el => {
    for (const k of el?.kids ?? []) {
      if (k.name === 'link-entity' && nonEmpty(nameOf(k))) aliases.set(lower(k.attrs.get('alias') ?? nameOf(k)), nameOf(k));
      collect(k);
    }
  };
  const root = doc?.name === 'fetch' ? (doc.kids ?? []).find(k => k.name === 'entity') : doc?.name === 'entity' ? doc : null;
  if (!root || !nonEmpty(nameOf(root))) return { tables, attrs };
  collect(root);
  const scoped = (table, alias) => (nonEmpty(alias) ? aliases.get(lower(alias)) ?? null : table);
  const walk = (el, table) => {
    for (const k of el.kids ?? []) {
      const a = k.attrs ?? new Map();
      if (k.name === 'attribute') addA(table, a.get('name'));
      else if (k.name === 'order') { if (a.has('attribute')) addA(scoped(table, a.get('entityname')), a.get('attribute')); }
      else if (k.name === 'condition') {
        const t = scoped(table, a.get('entityname'));
        addA(t, a.get('attribute'));
        const vo = a.get('valueof');
        if (nonEmpty(vo)) {
          const dot = vo.indexOf('.');
          if (dot > 0) addA(aliases.get(lower(vo.slice(0, dot))) ?? null, vo.slice(dot + 1)); else addA(t, vo);
        }
      } else if (k.name === 'link-entity') {
        const lt = nameOf(k);
        addT(lt);
        addA(lt, a.get('from'));
        addA(table, a.get('to'));
        walk(k, lt);
        continue;
      }
      if (k.name === 'filter') walk(k, table);
    }
  };
  addT(nameOf(root));
  walk(root, nameOf(root));
  return { tables, attrs };
}

// The warning for a table or column that metadata does not know (03 §8, 02 §10).
export function unknownNameText(name) {
  return `${name} is not a known table or column; the query may not run.`;
}

// The warning for a table whose metadata could not be read (a failure other than 208; see the notes above).
export function metadataFailedText(name, message) {
  return `The metadata of ${name} could not be read (${message}); the query may not run.`;
}

// The metadata warnings of the names of a FetchXML document (03 §8): one text per unknown table, unknown column
// of a known table or unreadable table, in document order. `infos` maps a lower-case table name to {info} or {error}.
export function fetchMetaWarnings(names, infos) {
  const out = [];
  for (const t of names?.tables ?? []) {
    const r = infos.get(lower(t));
    if (!r || r.error) out.push(r?.error && r.error.number !== 208 ? metadataFailedText(t, r.error.message || String(r.error)) : unknownNameText(t));
  }
  for (const { table, attr } of names?.attrs ?? []) {
    const r = infos.get(lower(table));
    const map = r?.info?.attrs;
    if (map && typeof map.has === 'function' && !map.has(lower(attr))) out.push(unknownNameText(`${table}.${attr}`));
  }
  return out;
}

// The comment lines Import current view puts under its header, one per warning (CR, LF and the other line breaks
// removed, so a name in a view cannot add SQL lines; 03 §8).
export function importWarningLines(warnings) {
  return (Array.isArray(warnings) ? warnings : []).map(w => `-- Warning: ${String(w).replace(/[\r\n\u0085\u{2028}\u{2029}]/gu, '')}`);
}

// The object type code of a table for an EntityName condition (returnedtypecode takes the code, not the logical
// name), or null.
export function typeCodeOf(info) {
  const c = isObj(info) ? info.objectTypeCode : info;
  return Number.isSafeInteger(c) && c >= 0 ? c : null;
}

// FetchXML that reads one view: by id (savedquery / userquery) or the table's default public view (returnedtypecode
// = the table's object type code `otc`, querytype 0, isdefault 1).
export function viewFetchXml({ otc = null, viewId = null, viewType = 1039 }) {
  if (viewId) {
    const ent = viewType === 4230 ? 'userquery' : 'savedquery';
    return `<fetch top="1"><entity name="${ent}"><attribute name="name"/><attribute name="fetchxml"/><attribute name="returnedtypecode"/>` +
      `<filter><condition attribute="${ent}id" operator="eq" value="${xmlEsc(viewId)}"/></filter></entity></fetch>`;
  }
  const code = typeCodeOf(otc);
  if (code == null) throw new TypeError('viewFetchXml(): the object type code of the table is required.');
  return '<fetch top="1"><entity name="savedquery"><attribute name="name"/><attribute name="fetchxml"/><attribute name="returnedtypecode"/>' +
    `<filter><condition attribute="returnedtypecode" operator="eq" value="${code}"/><condition attribute="querytype" operator="eq" value="0"/>` +
    '<condition attribute="isdefault" operator="eq" value="1"/></filter></entity></fetch>';
}

// The layoutxml cells of the visible result columns, in order: [{name, width}] (03 §8 Save as personal view).
export function layoutCells(columns) {
  const out = [];
  for (const c of Array.isArray(columns) ? columns : []) {
    if (!c || c.hidden) continue;
    const attr = c.attr && typeof c.attr === 'object' ? (c.attr.attributeOf || c.attr.logicalName) : null;
    const base = String(attr || c.name || '');
    const name = c.cell ? String(c.cell) : c.alias ? `${c.alias}.${base}` : base;
    if (!name) continue;
    const w = Number(c.width ?? c.widthPx);
    out.push({ name, width: Number.isFinite(w) ? Math.round(Math.min(800, Math.max(25, w))) : 150 });
  }
  return out;
}

// layoutxml of a personal view built from the select list (03 §7); every value XML-escaped with xmlEsc.
export function buildLayoutXml(entity, columns) {
  const e = isObj(entity) ? entity : {};
  const otc = Number.isInteger(e.objectTypeCode) ? ` object="${e.objectTypeCode}"` : '';
  const cells = layoutCells(columns).map(c => `<cell name="${xmlEsc(c.name)}" width="${c.width}"/>`).join('');
  return `<grid name="resultset"${otc} jump="${xmlEsc(e.primaryNameAttribute ?? '')}" select="1" icon="1" preview="1">` +
    `<row name="result" id="${xmlEsc(e.primaryIdAttribute ?? '')}">${cells}</row></grid>`;
}

// Open as view's personal view: one per table, replaced each time (openTempView).
export const TEMP_VIEW_NAME = 'SQL Studio Results';
export const TEMP_VIEW_DESCRIPTION = 'Results from SQL Studio. Open as view replaces this view each time.';

// FetchXML that finds the current user's personal view with this name for the table with object type code `otc`
// (Replace in Save as personal view: a userquery with that name, returnedtypecode and owner).
export function existingViewXml(name, otc) {
  const code = typeCodeOf(otc);
  if (code == null) throw new TypeError('existingViewXml(): the object type code of the table is required.');
  return '<fetch top="1"><entity name="userquery"><attribute name="userqueryid"/><attribute name="name"/><filter>' +
    `<condition attribute="name" operator="eq" value="${xmlEsc(name)}"/><condition attribute="returnedtypecode" operator="eq" value="${code}"/>` +
    '<condition attribute="ownerid" operator="eq-userid"/></filter></entity></fetch>';
}

// The one write op of a personal-view grant (02 §8.3): a userquery create with its client id (body exactly
// {userqueryid, name, description, returnedtypecode, fetchxml, layoutxml, querytype: 0}), or the If-Match update of
// the existing view {id, etag} (body {fetchxml, layoutxml, description}).
export function personalViewOp({ id, etn, name, description = '', fetchXml, layoutXml, existing = null }) {
  const desc = String(description ?? '');
  if (existing) {
    return { op: 'update', entity: 'userquery', entitySet: 'userqueries', id: existing.id, ifMatch: existing.etag,
      body: { fetchxml: fetchXml, layoutxml: layoutXml, description: desc } };
  }
  return { op: 'create', entity: 'userquery', entitySet: 'userqueries', id,
    body: { userqueryid: id, name, description: desc, returnedtypecode: etn, fetchxml: fetchXml, layoutxml: layoutXml, querytype: 0 } };
}

// ------------------------------------------------------------------------------------- Load CSV as #temp (§8.4)

const NVARCHAR_SIZES = [50, 100, 255, 500, 1000, 4000];
export const CSV_NAME_RE = /^#[A-Za-z_][A-Za-z0-9_]{0,114}$/;
export const CSV_NAME_MESSAGE = 'Temp table names start with # followed by a letter or _, then letters, digits or _ (at most 116 characters).';
export const CSV_EXISTS_TITLE = 'A #temp table with this name already exists in this tab.';
export const CSV_NOTE = "The data stays in this browser tab's memory and is gone after a reload. Nothing is sent to Dataverse.";
export const CSV_OPTIONS = Object.freeze({
  header: [['auto', 'Auto'], ['true', 'Yes'], ['false', 'No']],
  delimiter: [['auto', 'Auto'], [',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab'], ['|', 'Pipe']],
  decimal: [['auto', 'Auto'], ['.', '.'], [',', ',']],
  // More options: the quote and escape characters ('other' takes a one-character input) and onError.
  quote: [['"', '" (double quote)'], ["'", "' (single quote)"], ['none', 'None'], ['other', 'Other']],
  escape: [['none', 'None (a doubled quote)'], ['\\', '\\ (backslash)'], ['other', 'Other']],
  onError: [['fail', 'Stop the load'], ['skip', 'Skip the record']],
});
// The most errors a skipping load may tolerate (02 §9 maxErrors 0-1,000,000) and its default.
export const CSV_MAX_ERRORS = 1000000;

// One character typed for an 'Other' quote or escape character: the character, or null when the text is not
// exactly one character (one code point; a line break is never one).
export function oneChar(text) {
  const s = String(text ?? '');
  const cps = [...s];
  return cps.length === 1 && !/[\r\n\u{2028}\u{2029}]/u.test(s) ? s : null;
}

// The previewCsv value of a quote or escape choice (02 §9: one character or null), or undefined when 'Other' has no
// valid character.
export function csvCharValue(choice, otherText) {
  if (choice === 'none') return null;
  if (choice === 'other') return oneChar(otherText) ?? undefined;
  return choice;
}

// First record and Last record (1-based data records after the header; empty = all): {firstRow, lastRow, error,
// field} with field 'first' or 'last' naming the invalid input.
export function csvRowRange(firstText, lastText) {
  const num = t => {
    const s = String(t ?? '').trim().replace(/,/g, '');
    if (!s) return { value: null };
    if (!/^\d{1,12}$/.test(s) || Number(s) < 1) return { error: 'Enter a record number from 1.' };
    return { value: Number(s) };
  };
  const f = num(firstText), l = num(lastText);
  if (f.error) return { firstRow: 1, lastRow: null, error: f.error, field: 'first' };
  if (l.error) return { firstRow: f.value ?? 1, lastRow: null, error: l.error, field: 'last' };
  const firstRow = f.value ?? 1, lastRow = l.value;
  if (lastRow != null && lastRow < firstRow) return { firstRow, lastRow, error: 'The last record comes before the first.', field: 'last' };
  return { firstRow, lastRow, error: null, field: null };
}

// 'At most n errors' of a skipping load: {value} from 0 to 1,000,000, or {error}.
export function maxErrorsValue(text) {
  const s = String(text ?? '').trim().replace(/,/g, '');
  if (!/^\d{1,7}$/.test(s) || Number(s) > CSV_MAX_ERRORS) return { error: `Enter a whole number from 0 to ${fmtInt(CSV_MAX_ERRORS)}.` };
  return { value: Number(s) };
}

// True for the last column of a several-file preview that holds each record's file name: shown, never edited.
export function isFileNameColumn(preview, i) {
  const cols = Array.isArray(preview?.columns) ? preview.columns : [];
  return Array.isArray(preview?.files) && preview.files.length > 1 && i === cols.length - 1 && lower(cols[i]?.name) === 'filename';
}

// The title of the Load CSV dialog (03 §8.4): 'Load contacts.csv as a #temp table', 'Load 3 files as a #temp table'.
export function csvTitle(names) {
  const list = Array.isArray(names) ? names : [names];
  return list.length > 1 ? `Load ${fmtInt(list.length)} files as a #temp table` : `Load ${list[0] ?? 'the file'} as a #temp table`;
}
const TYPE_KEYS = ['nvarchar', 'nvarchar(max)', 'int', 'bigint', 'decimal', 'float', 'bit', 'date', 'datetime2', 'datetimeoffset', 'uniqueidentifier'];

// The previewCsv option value of a select value: header 'true'/'false' become booleans (02 §9).
export function csvOptionValue(kind, v) {
  if (kind === 'header') return v === 'true' ? true : v === 'false' ? false : 'auto';
  return v;
}

// The nvarchar length that holds a value of maxLength characters: 50, 100, 255, 500, 1000, 4000, else 'max' (02 §9).
export function nvarcharLength(maxLength) {
  const n = Number.isFinite(maxLength) ? maxLength : 0;
  for (const s of NVARCHAR_SIZES) if (n <= s) return s;
  return 'max';
}

// SQL text of a DataType: {name: 'decimal', args: [9, 2]} -> 'decimal(9,2)'.
export function dataTypeText(dt) {
  if (!dt || !dt.name) return '';
  const a = Array.isArray(dt.args) ? dt.args : [];
  return a.length ? `${dt.name}(${a.join(',')})` : dt.name;
}

// The type-select key of a DataType ('nvarchar', 'nvarchar(max)', 'decimal', …).
export function csvTypeKey(dt) {
  if (!dt || !dt.name) return 'nvarchar';
  if (dt.name === 'nvarchar') return dt.args?.[0] === 'max' ? 'nvarchar(max)' : 'nvarchar';
  return TYPE_KEYS.includes(dt.name) ? dt.name : 'nvarchar';
}

// The nvarchar length of a preview column: its inferred length, else the length its longest value needs.
function csvNvarcharLen(col) {
  const dt = col?.dataType;
  if (dt?.name === 'nvarchar' && Number.isInteger(dt.args?.[0])) return dt.args[0];
  return nvarcharLength(col?.maxLength);
}

// The type choices of a preview column (03 §8.4): [{value, label}]; nvarchar(L) shows the inferred length.
export function csvTypeOptions(col) {
  const len = csvNvarcharLen(col);
  return TYPE_KEYS.filter(k => !(k === 'nvarchar' && len === 'max')).map(k => ({
    value: k,
    label: k === 'nvarchar' ? `nvarchar(${len})` : k === 'decimal' ? 'decimal(p,s)' : k,
  }));
}

// The DataType for a type choice of a preview column; decimal takes {p, s}, datetime2/datetimeoffset keep the
// inferred fraction digits.
export function csvDataType(key, col, { p = 18, s = 2 } = {}) {
  const inferred = col?.dataType;
  if (key === 'nvarchar') return { name: 'nvarchar', args: [csvNvarcharLen(col)] };
  if (key === 'nvarchar(max)') return { name: 'nvarchar', args: ['max'] };
  if (key === 'decimal') return { name: 'decimal', args: [p, s] };
  if ((key === 'datetime2' || key === 'datetimeoffset') && inferred?.name === key) return { name: key, args: [...(inferred.args ?? [])] };
  return { name: TYPE_KEYS.includes(key) ? key : 'nvarchar', args: [] };
}

// null, or the message for an invalid decimal precision/scale.
export function decimalError(p, s) {
  return Number.isInteger(p) && Number.isInteger(s) && p >= 1 && p <= 38 && s >= 0 && s <= p ? null : 'Precision must be 1 to 38 and scale 0 to the precision.';
}

// null, or the 02 §9 message for an invalid #temp table name.
export function csvNameError(name) {
  return CSV_NAME_RE.test(String(name ?? '')) ? null : CSV_NAME_MESSAGE;
}

// One message (or null) per column name (03 §8.4): non-empty, unique ignoring case, at most 128 characters.
export function csvColumnErrors(names) {
  const list = Array.isArray(names) ? names.map(n => String(n ?? '')) : [];
  const counts = new Map();
  for (const n of list) counts.set(lower(n), (counts.get(lower(n)) ?? 0) + 1);
  return list.map(n => {
    if (!n.trim()) return 'Enter a column name.';
    if (n.length > 128) return 'Column names can have at most 128 characters.';
    if (counts.get(lower(n)) > 1) return 'Column names must be unique (ignoring case).';
    return null;
  });
}

const ENCODINGS = new Map([['utf-8', 'UTF-8'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE'], ['windows-1252', 'Windows-1252']]);

// The encoding name shown in the dialog: 'UTF-8', 'UTF-16 LE', 'Windows-1252'.
export function encodingLabel(e) {
  return ENCODINGS.get(lower(e)) ?? String(e ?? '');
}

// '1,234 rows · 5 columns · UTF-8', or with several files '3 files · 4,210 rows · 5 columns · UTF-8' (03 §8.4).
export function csvSummary(preview) {
  const files = Array.isArray(preview?.files) && preview.files.length > 1 ? `${plural(preview.files.length, 'file')} · ` : '';
  return `${files}${plural(count0(preview?.rowCount), 'row')} · ${plural(Array.isArray(preview?.columns) ? preview.columns.length : 0, 'column')} · ${encodingLabel(preview?.encoding)}`;
}

// The row count of a session.temps entry: its rows array's length, else a numeric rowCount / count, else null.
function tempRows(entry) {
  if (!isObj(entry)) return null;
  if (Array.isArray(entry.rows)) return entry.rows.length;
  for (const k of ['rowCount', 'count']) if (Number.isSafeInteger(entry[k]) && entry[k] >= 0) return entry[k];
  return null;
}

// Whether a #temp table of this name exists in the tab's session: {exists, rows|null}. session.temps is a Map keyed
// by name (any case); the preview's `exists` flag covers its own suggested name.
export function tempInfo(name, preview, temps) {
  const key = lower(String(name ?? '').trim());
  if (key && temps && typeof temps.get === 'function') {
    let entry = temps.get(key);
    if (entry === undefined && typeof temps.entries === 'function') {
      for (const [k, v] of temps.entries()) if (lower(k) === key) { entry = v; break; }
    }
    if (entry !== undefined && entry !== null) return { exists: true, rows: tempRows(entry) };
  }
  if (key && preview?.exists && key === lower(preview.name)) return { exists: true, rows: null };
  return { exists: false, rows: null };
}

// The Replace checkbox label: 'Replace the existing #contacts (1,234 rows)'.
export function replaceLabel(name, rows) {
  return `Replace the existing ${name}${Number.isFinite(rows) ? ` (${plural(rows, 'row')})` : ''}`;
}

// The 'Query it' SQL after a load (03 §8.4): `SELECT TOP 100 * FROM #contacts;`, or for Load file as text
// (`{file: true}`) `SELECT BulkColumn FROM #notes;`; the name bare when it matches the #temp name rule.
export function queryItSql(name, { file = false } = {}) {
  const n = String(name ?? '');
  const t = CSV_NAME_RE.test(n) ? n : sqlIdent(n);
  return file ? `SELECT BulkColumn FROM ${t};` : `SELECT TOP 100 * FROM ${t};`;
}

// The #temp name suggested for a file (02 §9 name rule): '#' + its base name lower-cased, every character outside
// [a-z0-9_] replaced by _, runs of _ collapsed, 't_' in front when it does not start with a letter or _, cut to 115
// characters; '#csv' when nothing is left.
export function tempNameSuggestion(fileName) {
  const base = String(fileName ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
  let s = base.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
  if (!s) return '#csv';
  if (!/^[a-z_]/.test(s)) s = 't_' + s;
  return '#' + s.slice(0, 115);
}

// Load file as text (03 §8.4): the size limit, its message and the note of the dialog.
export const FILE_LIMIT = 50 * 1024 * 1024;
export const FILE_TOO_LARGE = 'The file is larger than 50 MB.';
export const FILE_NOTE = "The file stays in this browser tab's memory and is gone after a reload. Nothing is sent to Dataverse.";

// Where 'Query it' puts its SQL in the text of the tab that loaded the table: {text, start, end} (the new text and
// the range of the query in it). A blank text is replaced; otherwise the query goes on its own line after the text,
// separated by one empty line.
export function appendQuery(text, sql) {
  const t = String(text ?? ''), q = String(sql ?? '');
  if (!t.trim()) return { text: q, start: 0, end: q.length };
  const tail = t.slice(-64).replace(/\r\n?/g, '\n');
  const sep = /\n[ \t]*\n$/.test(tail) ? '' : tail.endsWith('\n') ? '\n' : '\n\n';
  const start = t.length + sep.length;
  return { text: t + sep + q, start, end: start + q.length };
}

// The most bytes of a CSV file that are read: a larger file is read only up to this limit + 1 byte, enough for the
// session to refuse it with its own 'larger than 50 MB' message (02 §9: refused before decoding).
export const CSV_READ_LIMIT = 50 * 1024 * 1024;

// The bytes of a CSV file for previewCsv (02 §9: File.arrayBuffer()); a file over CSV_READ_LIMIT is cut to
// CSV_READ_LIMIT + 1 bytes, so dropping a huge file never reads gigabytes into memory.
export function readCsvBytes(file, limit = CSV_READ_LIMIT + 1) {
  const size = Number(file?.size);
  if (Number.isFinite(size) && size > limit && typeof file.slice === 'function') return file.slice(0, Math.max(0, limit)).arrayBuffer();
  return file.arrayBuffer();
}

// The previewCsv sources of one or more files (02 §9): [{bytes, name}] in order. The 50 MB limit applies to their
// total, so the files are read only until the total passes CSV_READ_LIMIT by one byte: the session then refuses them
// with its own message, and dropping many large files never reads gigabytes into memory.
export async function readCsvSources(files) {
  const out = [];
  let left = CSV_READ_LIMIT + 1;
  for (const f of files) {
    const bytes = await readCsvBytes(f, left);
    left = Math.max(0, left - bytes.byteLength);
    out.push({ bytes, name: String(f?.name ?? '') });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ settings (§8.1)

const choice = (...pairs) => pairs.map(([v, l]) => Object.freeze({ value: v, label: l }));

// The Editor › Font choices (03 §8, §5): the default stack, each monospaced font of it, then 'Custom…' (a text
// input). Values are CSS font-family lists; the editor always appends ', monospace'.
export const FONT_CHOICES = Object.freeze([
  [stateModule.EDITOR_FONT, 'Default (Cascadia Mono, Consolas, SF Mono, Menlo)'], ['"Cascadia Mono"', 'Cascadia Mono'], ['Consolas', 'Consolas'],
  ['"SF Mono"', 'SF Mono'], ['Menlo', 'Menlo'], ['ui-monospace', 'The system monospaced font'],
].map(([v, l]) => Object.freeze({ value: v, label: l })));
// The note of a font that is not monospaced (03 §5) and of a value that is not a font-family list.
export const FONT_NOT_MONO = 'This font is not monospaced; the editor needs a monospaced font.';
export const FONT_INVALID = 'Enter installed font names separated by commas, such as "JetBrains Mono", Consolas: letters, digits, spaces and , " \' _ -, at most 200 characters, with a name in quotes when one of its words starts with a digit.';

// The Font select value of an editorFont setting: one of FONT_CHOICES, else 'custom'.
export function fontChoice(value) {
  return FONT_CHOICES.some(c => c.value === value) ? value : 'custom';
}

// True when a font-family list renders monospaced (03 §5): `measure(text, font)` (dom.js measureText) gives the
// same width for 'iiiiiiiiii' and 'WWWWWWWWWW' in it (followed by monospace, as the editor writes it).
export function isMonospaced(family, measure, size = 13) {
  const font = `${size}px ${family}, monospace`;
  const a = measure('iiiiiiiiii', font), b = measure('WWWWWWWWWW', font);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.01;
}

// The Settings dialog layout (03 §8, §8.1): sections with their settings (by key) and actions.
export const SETTINGS_UI = Object.freeze([
  { id: 'appearance', title: 'Appearance', items: [
    { key: 'theme', label: 'Theme', options: choice(['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']), hint: "Auto follows your system's light or dark mode." },
    { key: 'compact', label: 'Compact rows', hint: 'Result rows 24 px high instead of 28 px.' },
    { key: 'gridFontSize', label: 'Grid font size', hint: 'The text size of the result grid, the row details and the text view, in pixels.' },
  ] },
  { id: 'results', title: 'Results', items: [
    { key: 'friendly', label: 'Friendly values by default', hint: 'New results show labels and names instead of the stored values.' },
    { key: 'localDates', label: 'Local date formats', hint: 'Friendly dates use the date and time formats of your Dataverse user settings instead of yyyy-MM-dd HH:mm:ss. Raw values, sorting and filters are unchanged.' },
    { key: 'tz', label: 'Time zone', options: choice(['local', 'Local'], ['utc', 'UTC']), hint: 'The zone dates are shown and read in. FetchXML date functions such as today() use your Dataverse time zone.' },
    { key: 'maxRows', label: 'Max rows returned', hint: 'A result set stops here, with a banner.' },
    { key: 'maxScanRows', label: 'Max rows processed in the browser', hint: 'Rows read for joins, sorting and grouping in the browser, and the row limit of Load CSV as #temp.' },
    { key: 'maxRequests', label: 'Max requests per statement', hint: 'Requests one statement may send to Dataverse.' },
    { key: 'columnOrder', label: 'Column order', options: choice(['alpha', 'Alphabetical'], ['schema', 'Schema']), hint: 'The order of the columns of SELECT *.' },
    { key: 'csvNeutralize', label: 'Protect exports against spreadsheet formulas', hint: "CSV files and copied cells get a ' before text that starts with = + - or @. Turning this off lasts for this session only." },
  ] },
  { id: 'editor', title: 'Editor', items: [
    { key: 'editorFont', label: 'Font', hint: 'A monospaced font installed on this computer; monospace is always added as the fallback, and no font is downloaded.' },
    { key: 'fontSize', label: 'Font size', hint: 'The size of the editor text in pixels.' },
    { key: 'wordWrap', label: 'Word wrap', hint: "Wrap long lines at the editor's edge.", keys: 'wordWrap' },
    { key: 'autocomplete', label: 'Autocomplete', hint: 'Suggest tables, columns and functions while you type.' },
    { key: 'hoverCards', label: 'Hover cards', hint: 'Describe functions, tables and columns when the pointer rests on them. The keyboard, F1 and signature help still show the same information.' },
    { key: 'autoClose', label: 'Auto-close brackets', hint: 'Type the closing bracket or quote for you.' },
    { key: 'showWarnings', label: 'Show warnings', hint: 'Underline the parts of a query that run in the browser.' },
    { key: 'quotedIdentifiers', label: 'Quoted identifiers', hint: 'SET QUOTED_IDENTIFIER ON by default: "text" is a name. Off makes "text" a string. Applies to query tabs opened after the change.' },
  ] },
  { id: 'changes', title: 'Data changes', items: [
    { key: 'batchSize', label: 'Batch size', hint: 'Requests per $batch when writing: the starting and largest size; batches get smaller when Dataverse is slow.' },
    { key: 'maxdop', label: 'Parallel batches', hint: 'Write batches sent at the same time; 0 is automatic (what Dataverse recommends).' },
    { key: 'maxChangeRows', label: 'Max records per statement', hint: 'Above 5,000 only for this session.' },
    { key: 'allowUnfiltered', label: 'Allow UPDATE/DELETE without WHERE', hint: 'For this session only. You still type the table name to confirm each such statement.' },
    { key: 'backupBeforeDelete', label: 'Download backup before delete', hint: 'Off by default. When on, a DELETE of up to 5,000 records waits until you have saved a backup of them.' },
  ] },
  { id: 'privacy', title: 'Privacy', items: [
    { key: 'keepHistory', label: 'Keep query history', hint: 'The SQL text of the queries you run, kept in this browser for this environment.' },
    { key: 'restoreTabs', label: 'Restore tabs after reload', hint: 'The titles and SQL of your query tabs, kept in this browser.' },
    { key: 'queryInBody', label: 'Send queries in the request body', hint: 'Every FetchXML request is wrapped in $batch, so query values stay out of request URLs.' },
    { action: 'clearHistory', label: 'Clear history', hint: 'Deletes the query history of this environment and the saved tabs from this browser.' },
  ] },
  { id: 'advanced', title: 'Advanced', items: [
    { key: 'noPushdown', label: 'Run everything in the browser (debug)', hint: 'Sends no filters, joins or aggregates to Dataverse and does them in the browser. Slow; for checking results.' },
    { action: 'clearMetadata', label: 'Clear metadata cache', hint: 'Forgets the cached tables, columns, relationships and messages and reloads the table list.' },
    { action: 'resetLayout', label: 'Reset layout', hint: 'Puts the window, the explorer, the splitter and the find options back to their defaults.' },
  ] },
  { id: 'about', title: 'About', items: [] },
]);

// A whole number typed into a number setting: {value} within the schema range, or {error}.
export function parseIntSetting(text, spec) {
  const msg = `Enter a whole number from ${fmtInt(spec.min)} to ${fmtInt(spec.max)}.`;
  const t = String(text ?? '').trim().replace(/,/g, '');
  if (!/^[+-]?\d{1,12}$/.test(t)) return { error: msg };
  const v = Number(t);
  if (v < spec.min || v > spec.max) return { error: msg };
  return { value: v };
}

export const SESSION_ONLY = 'This lasts for this session only: the safe value is back when the page reloads.';

// The confirmation of a safety-relaxing setting value (00 §5 rule 3): {title, body, ok}.
export function relaxPrompt(key, value) {
  switch (key) {
    case 'allowUnfiltered': return { title: 'Allow UPDATE and DELETE without WHERE?', ok: 'Allow for this session',
      body: 'Statements that change every record of a table are then no longer blocked. Each one still opens the preview, where you type the table name to confirm.' };
    case 'backupBeforeDelete': return { title: 'Turn off the backup before delete?', ok: 'Turn off for this session',
      body: 'DELETE previews then no longer wait until you have saved a backup of the records they delete.' };
    case 'csvNeutralize': return { title: 'Turn off formula protection?', ok: 'Turn off for this session',
      body: "CSV files and copied cells then no longer get a ' before text that starts with = + - or @, so a spreadsheet may run such text as a formula." };
    case 'maxChangeRows': return { title: `Allow up to ${fmtInt(value)} records per statement?`, ok: 'Allow for this session',
      body: `One INSERT, UPDATE or DELETE may then change up to ${fmtInt(value)} records. The limit saved in this browser does not change (it is never above 5,000).` };
    default: return { title: 'Change this safety setting?', ok: 'Change for this session', body: '' };
  }
}

// The final toast of Save all (03 §3): 'Saved 5 tabs. 2 skipped.' ('Saved 1 tab.' without skips).
export function saveAllSummary(saved, skipped) {
  const k = count0(skipped);
  return `Saved ${plural(count0(saved), 'tab')}.${k ? ` ${fmtInt(k)} skipped.` : ''}`;
}

// The file name a query tab is saved under: its title as a safe file name plus '.sql' (as Save does).
export function sqlFileName(title) {
  return `${safeFileName(String(title ?? ''), 'query')}.sql`;
}

// The first lines of a query for the History list: up to n non-empty lines, tabs as four spaces, trailing spaces cut.
export function historyLines(sql, n = 2) {
  return String(sql ?? '').split(/\r\n|\n|\r/).map(l => l.replace(/\t/g, '    ').trimEnd()).filter(l => l.trim()).slice(0, n);
}

// 'Started in 182 ms' (03 §13), or a note when the launch was not measured.
export function startupText(ms) {
  return Number.isFinite(ms) && ms >= 0 ? `Started in ${fmtDuration(ms, { unit: 'ms' })}` : 'The start-up time was not measured.';
}

// --------------------------------------------------------------------------------------- template gallery (§8.3)

// Template categories in chip order (03 §8.3): [id, label].
export const TEMPLATE_CATEGORIES = Object.freeze([
  ['all', 'All'], ['users', 'Users and security'], ['records', 'Records and data quality'],
  ['automation', 'Automation and system jobs'], ['solutions', 'Solutions and customisation'], ['metadata', 'Metadata'],
]);

const tpl = (id, category, title, description, tables, sql) => Object.freeze({ id, category, title, description, tables: Object.freeze(tables), sql });

// The SQL of the 'table-relationships' template (03 §8.3 #33): the 1:N, N:1 and N:N rows that involve @table, with the
// cascade-delete setting (`cascadedelete` of metadata.relationship_1_n and _n_1, 02 §7; NULL for N:N).
const RELATIONSHIPS_SQL = `DECLARE @table nvarchar(100) = 'account'; -- change this

SELECT '1:N' AS kind, schemaname, referencedentity AS table1, referencedattribute AS column1, referencingentity AS table2, referencingattribute AS column2, relationshiptype, iscustomrelationship, cascadedelete
FROM metadata.relationship_1_n
WHERE referencedentity = @table
UNION ALL
SELECT 'N:1', schemaname, referencedentity, referencedattribute, referencingentity, referencingattribute, relationshiptype, iscustomrelationship, cascadedelete
FROM metadata.relationship_n_1
WHERE referencingentity = @table
UNION ALL
SELECT 'N:N', schemaname, entity1logicalname, entity1intersectattribute, entity2logicalname, entity2intersectattribute, relationshiptype, iscustomrelationship, NULL
FROM metadata.relationship_n_n
WHERE entity1logicalname = @table
   OR entity2logicalname = @table
ORDER BY kind, schemaname;`;

// The template gallery (03 §8.3): read-only queries (SELECT without INTO, DECLARE and SET only); parameters are
// DECLAREs at the top with a working default and the comment `-- change this`. Plain data: nothing is built from it
// until the gallery or the completion list of an empty editor opens.
export const TEMPLATES = Object.freeze([
  tpl('who-am-i', 'users', 'Who am I', 'The user SQL Studio acts as, with domain name, business unit and organization id.', ['systemuser', 'businessunit'],
    `-- Shows the impersonated user while Execute as is on.
SELECT u.fullname, u.domainname, bu.name AS businessunit, w.OrganizationId AS organizationid
FROM WhoAmI() AS w
JOIN systemuser AS u ON u.systemuserid = w.UserId
JOIN businessunit AS bu ON bu.businessunitid = w.BusinessUnitId;`),
  tpl('my-roles', 'users', 'My security roles', 'Your security roles, assigned directly and through your teams, with their business units.', ['role', 'systemuserroles', 'teammembership', 'teamroles', 'team'],
    `SELECT r.name AS role, r.businessunitidname AS businessunit, 'Direct' AS assigned
FROM systemuserroles AS sur
JOIN role AS r ON r.roleid = sur.roleid
WHERE sur.systemuserid = CURRENT_USER
UNION ALL
SELECT r.name, r.businessunitidname, 'Team: ' + t.name
FROM teammembership AS tm
JOIN team AS t ON t.teamid = tm.teamid
JOIN teamroles AS tr ON tr.teamid = tm.teamid
JOIN role AS r ON r.roleid = tr.roleid
WHERE tm.systemuserid = CURRENT_USER
ORDER BY role;`),
  tpl('users-without-roles', 'users', 'Enabled users without security roles', 'Enabled users who have no role of their own and are in no team with a role.', ['systemuser', 'systemuserroles', 'teammembership', 'teamroles'],
    `SELECT u.fullname, u.domainname, u.businessunitidname AS businessunit, u.createdon
FROM systemuser AS u
WHERE u.isdisabled = 0
  AND NOT EXISTS (SELECT 1 FROM systemuserroles AS sur WHERE sur.systemuserid = u.systemuserid)
  AND NOT EXISTS (SELECT 1 FROM teammembership AS tm JOIN teamroles AS tr ON tr.teamid = tm.teamid WHERE tm.systemuserid = u.systemuserid)
ORDER BY u.fullname;`),
  tpl('users-by-bu', 'users', 'Enabled users per business unit', 'How many enabled users each business unit has, largest first. Chart it as a bar chart.', ['systemuser'],
    `SELECT businessunitidname AS businessunit, COUNT(*) AS users
FROM systemuser
WHERE isdisabled = 0
GROUP BY businessunitid, businessunitidname
ORDER BY users DESC;`),
  tpl('team-members', 'users', 'Members of a team', "The members of a team; by default the root business unit's default team.", ['team', 'teammembership', 'systemuser'],
    `-- By default the default team of the root business unit; write a team name instead.
DECLARE @team nvarchar(160) = (SELECT TOP 1 name FROM team WHERE isdefault = 1 ORDER BY createdon); -- change this

SELECT u.fullname, u.domainname, u.businessunitidname AS businessunit
FROM team AS t
JOIN teammembership AS tm ON tm.teamid = t.teamid
JOIN systemuser AS u ON u.systemuserid = tm.systemuserid
WHERE t.name = @team
ORDER BY u.fullname;`),
  tpl('users-with-role', 'users', 'Users with a security role', 'The enabled users who have a security role directly, with their business units.', ['role', 'systemuserroles', 'systemuser'],
    `DECLARE @role nvarchar(100) = N'System Administrator'; -- change this

SELECT u.fullname, u.domainname, u.businessunitidname AS businessunit, r.businessunitidname AS rolebusinessunit
FROM role AS r
JOIN systemuserroles AS sur ON sur.roleid = r.roleid
JOIN systemuser AS u ON u.systemuserid = sur.systemuserid
WHERE r.name = @role
  AND u.isdisabled = 0
ORDER BY u.fullname;`),
  tpl('new-users', 'users', 'Users created in the last 30 days', 'Users created in the last 30 days, newest first.', ['systemuser'],
    `SELECT fullname, domainname, businessunitidname AS businessunit, isdisabled, createdon
FROM systemuser
WHERE createdon = lastxdays(30)
ORDER BY createdon DESC;`),
  tpl('created-by-me', 'records', 'Records I created this week', 'Accounts you created this week; change the table to look at another one.', ['account'],
    `-- Change account to any table that has createdby and createdon columns.
SELECT name, createdon, modifiedon
FROM account
WHERE createdby = CURRENT_USER
  AND createdon = thisweek()
ORDER BY createdon DESC;`),
  tpl('dup-accounts', 'records', 'Duplicate accounts by name', 'Account names used more than once, with the ids of the accounts.', ['account'],
    `SELECT name, COUNT(*) AS records, STRING_AGG(CAST(accountid AS nvarchar(36)), ', ') AS ids
FROM account
WHERE name IS NOT NULL
GROUP BY name
HAVING COUNT(*) > 1
ORDER BY records DESC;`),
  tpl('dup-contacts', 'records', 'Duplicate contacts by email', 'Email addresses used by more than one contact, with their names.', ['contact'],
    `SELECT emailaddress1, COUNT(*) AS records, STRING_AGG(fullname, '; ') AS names
FROM contact
WHERE emailaddress1 IS NOT NULL
GROUP BY emailaddress1
HAVING COUNT(*) > 1
ORDER BY records DESC;`),
  tpl('contacts-without-account', 'records', 'Active contacts without an account', 'Active contacts whose company (parent customer) is empty.', ['contact'],
    `SELECT fullname, emailaddress1, telephone1, createdon
FROM contact
WHERE statecode = 0
  AND parentcustomerid IS NULL
ORDER BY fullname;`),
  tpl('accounts-without-contacts', 'records', 'Active accounts without contacts', 'Active accounts that no contact has as its company.', ['account', 'contact'],
    `SELECT a.name, a.createdon
FROM account AS a
LEFT JOIN contact AS c ON c.parentcustomerid = a.accountid
WHERE a.statecode = 0
  AND c.contactid IS NULL
ORDER BY a.name;`),
  tpl('records-per-owner', 'records', 'Records per owner', 'How many accounts each user or team owns, largest first. Chart it as a bar chart.', ['account'],
    `SELECT owneridname AS owner, COUNT(*) AS records
FROM account
GROUP BY ownerid, owneridname
ORDER BY records DESC;`),
  tpl('monthly-growth', 'records', 'New records per month', 'Accounts created per month over the last 24 months. Chart it as a line chart.', ['account'],
    `SELECT YEAR(createdon) AS [year], MONTH(createdon) AS [month], COUNT(*) AS records
FROM account
WHERE createdon = lastxmonths(24)
GROUP BY YEAR(createdon), MONTH(createdon)
ORDER BY [year], [month];`),
  tpl('status-breakdown', 'records', 'Records by status', 'How many accounts have each status. Chart it as a pie chart.', ['account'],
    `SELECT statecodename AS [state], statuscodename AS [status], COUNT(*) AS records
FROM account
GROUP BY statecode, statecodename, statuscode, statuscodename
ORDER BY records DESC;`),
  tpl('recently-modified', 'records', 'Records changed in the last 24 hours', 'Accounts changed in the last 24 hours and who changed them, newest first.', ['account'],
    `SELECT name, modifiedon, modifiedbyname AS modifiedby
FROM account
WHERE modifiedon = lastxhours(24)
ORDER BY modifiedon DESC;`),
  tpl('table-counts', 'records', 'Record counts of core tables', 'Approximate record counts of six core tables from RetrieveTotalRecordCount.', ['account', 'contact', 'systemuser', 'team', 'activitypointer', 'annotation'],
    `-- Approximate counts from a snapshot taken within the last 24 hours.
SELECT *
FROM RetrieveTotalRecordCount('account', 'contact', 'systemuser', 'team', 'activitypointer', 'annotation');`),
  tpl('recent-audit', 'records', 'Audit entries of the last 24 hours', 'What was changed in the last 24 hours, on which record and by whom.', ['audit'],
    `-- Returns no rows when auditing is off.
SELECT TOP 500 createdon, actionname AS action, operationname AS operation, objecttypecode AS [table], objectid AS record, useridname AS [user]
FROM audit
WHERE createdon = lastxhours(24)
ORDER BY createdon DESC;`),
  tpl('failed-jobs-today', 'automation', 'System jobs that failed today', 'System jobs that failed today, with their messages and the record they ran on.', ['asyncoperation'],
    `SELECT name, operationtypename AS operation, friendlymessage, message, regardingobjectidname AS regarding, regardingobjecttypecode AS regardingtable, createdon
FROM asyncoperation
WHERE statuscode = 31
  AND createdon = today()
ORDER BY createdon DESC;`),
  tpl('suspended-jobs', 'automation', 'Suspended system jobs per type', 'How many suspended system jobs each operation type has. Chart it as a column chart.', ['asyncoperation'],
    `SELECT operationtypename AS operation, COUNT(*) AS jobs
FROM asyncoperation
WHERE statecode = 1
GROUP BY operationtype, operationtypename
ORDER BY jobs DESC;`),
  tpl('plugin-trace', 'automation', 'Plug-in trace log of the last hour', 'Plug-in trace entries of the last hour, with exceptions and durations.', ['plugintracelog'],
    `SELECT typename, messagename, primaryentity, exceptiondetails, performanceexecutionduration, createdon
FROM plugintracelog
WHERE createdon = lastxhours(1)
ORDER BY createdon DESC;`),
  tpl('steps-on-table', 'automation', 'Plug-in steps on a table', 'The plug-in steps registered on a table, by message, stage and rank.', ['sdkmessageprocessingstep', 'sdkmessagefilter', 'sdkmessage'],
    `DECLARE @table nvarchar(100) = 'account'; -- change this

SELECT s.name AS step, m.name AS message, s.stagename AS stage, s.modename AS mode, s.rank, s.filteringattributes, s.statecodename AS [state]
FROM sdkmessageprocessingstep AS s
JOIN sdkmessagefilter AS f ON f.sdkmessagefilterid = s.sdkmessagefilterid
JOIN sdkmessage AS m ON m.sdkmessageid = s.sdkmessageid
WHERE f.primaryobjecttypecode = @table
ORDER BY m.name, s.stage, s.rank;`),
  tpl('cloud-flows', 'automation', 'Cloud flows', 'The cloud flows of this environment with their state and owner.', ['workflow'],
    `SELECT name, statecodename AS [state], owneridname AS owner, modifiedon
FROM workflow
WHERE category = 5
ORDER BY name;`),
  tpl('classic-processes', 'automation', 'Activated classic workflows and business rules', 'Activated classic workflows and business rules with their tables.', ['workflow'],
    `SELECT name, categoryname AS category, primaryentity AS primarytable
FROM workflow
WHERE category IN (0, 2)
  AND type = 1
  AND statecode = 1
ORDER BY categoryname, name;`),
  tpl('solution-components', 'solutions', 'Components of a solution by type', 'How many components of each type a solution has.', ['solutioncomponent', 'solution'],
    `-- The solution's unique name.
DECLARE @solution nvarchar(256) = N'Default'; -- change this

SELECT sc.componenttype, sc.componenttypename, COUNT(*) AS components
FROM solutioncomponent AS sc
JOIN solution AS s ON s.solutionid = sc.solutionid
WHERE s.uniquename = @solution
GROUP BY sc.componenttype, sc.componenttypename
ORDER BY components DESC;`),
  tpl('unmanaged-solutions', 'solutions', 'Unmanaged solutions', 'The visible unmanaged solutions with version and publisher.', ['solution'],
    `SELECT friendlyname, uniquename, version, publisheridname AS publisher, modifiedon
FROM solution
WHERE ismanaged = 0
  AND isvisible = 1
ORDER BY friendlyname;`),
  tpl('managed-solutions', 'solutions', 'Installed managed solutions', 'The visible managed solutions, most recently installed first.', ['solution'],
    `SELECT friendlyname, uniquename, version, publisheridname AS publisher, installedon
FROM solution
WHERE ismanaged = 1
  AND isvisible = 1
ORDER BY installedon DESC;`),
  tpl('web-resources', 'solutions', 'Web resources by type', 'How many web resources of each type exist. Chart it as a column chart.', ['webresource'],
    `SELECT webresourcetypename AS [type], COUNT(*) AS webresources
FROM webresource
GROUP BY webresourcetype, webresourcetypename
ORDER BY webresources DESC;`),
  tpl('env-vars', 'solutions', 'Environment variables and current values', 'Every environment variable with its default, current and effective value.', ['environmentvariabledefinition', 'environmentvariablevalue'],
    `SELECT d.schemaname, d.displayname, d.typename AS [type], d.defaultvalue, v.value AS currentvalue, COALESCE(v.value, d.defaultvalue) AS effectivevalue
FROM environmentvariabledefinition AS d
LEFT JOIN environmentvariablevalue AS v ON v.environmentvariabledefinitionid = d.environmentvariabledefinitionid
ORDER BY d.schemaname;`),
  tpl('audited-tables', 'metadata', 'Tables with auditing enabled', 'The tables whose changes are audited.', ['metadata.entity'],
    `SELECT logicalname, displayname, iscustomentity
FROM metadata.entity
WHERE isauditenabled = 1
ORDER BY logicalname;`),
  tpl('custom-columns', 'metadata', 'Custom columns of a table', 'The custom columns of a table with their types.', ['metadata.attribute'],
    `DECLARE @table nvarchar(100) = 'account'; -- change this

SELECT logicalname, displayname, attributetype, requiredlevel, description
FROM metadata.attribute
WHERE entitylogicalname = @table
  AND iscustomattribute = 1
ORDER BY logicalname;`),
  tpl('choice-values', 'metadata', 'Choice values of a column', 'The values and labels of a choice, state or status column.', ['metadata.optionsetvalue'],
    `DECLARE @table nvarchar(100) = 'account'; -- change this
DECLARE @column nvarchar(100) = 'statuscode'; -- change this

SELECT value, label, state, description
FROM metadata.optionsetvalue
WHERE entitylogicalname = @table
  AND attributelogicalname = @column
ORDER BY value;`),
  tpl('table-relationships', 'metadata', 'Relationships of a table', 'The 1:N, N:1 and N:N relationships of a table, with their cascade delete setting.',
    ['metadata.relationship_1_n', 'metadata.relationship_n_1', 'metadata.relationship_n_n'], RELATIONSHIPS_SQL),
  tpl('form-usage', 'metadata', 'Forms that use a column', 'The forms of a table that show a column.', ['systemform'],
    `DECLARE @table nvarchar(100) = 'account'; -- change this
DECLARE @column nvarchar(100) = 'name'; -- change this

SELECT name, typename AS [type], formactivationstatename AS [state]
FROM systemform
WHERE objecttypecode = @table
  AND formxml LIKE '%datafieldname="' + @column + '"%'
ORDER BY typename, name;`),
  tpl('role-privileges', 'metadata', 'Security role privileges on a table', 'Which roles have which privileges on a table, with the access level.', ['roleprivileges', 'role', 'privilege', 'privilegeobjecttypecodes'],
    `DECLARE @table nvarchar(100) = 'account'; -- change this

SELECT r.name AS role, r.businessunitidname AS businessunit, p.name AS privilege,
  CASE rp.privilegedepthmask
    WHEN 1 THEN 'User'
    WHEN 2 THEN 'Business unit'
    WHEN 4 THEN 'Parent: child business units'
    WHEN 8 THEN 'Organization'
    ELSE CAST(rp.privilegedepthmask AS nvarchar(10))
  END AS depth
FROM roleprivileges AS rp
JOIN role AS r ON r.roleid = rp.roleid
JOIN privilege AS p ON p.privilegeid = rp.privilegeid
JOIN privilegeobjecttypecodes AS potc ON potc.privilegeid = p.privilegeid
WHERE potc.objecttypecode = @table
ORDER BY r.name, p.name;`),
]);

// Templates of a category ('all' for every one) whose title, description or tables contain every word of `query`
// (ignoring case and accents).
export function filterTemplates(list, { category = 'all', query = '' } = {}) {
  return (Array.isArray(list) ? list : []).filter(t =>
    (category === 'all' || t.category === category) && matchesAll(`${t.title} ${t.description} ${t.tables.join(' ')}`, query));
}

// Where the caret goes in a new template tab (03 §8.3): the first DECLARE's value ([start, end], inside the quotes
// of a string), else the end of the text.
export function templateCaret(sql) {
  const s = String(sql ?? '');
  const end = [s.length, s.length];
  let toks;
  try { toks = tokenize(s, true); } catch { return end; }
  const d = toks.findIndex(t => t.t === 'id' && t.k === 'DECLARE');
  if (d < 0) return end;
  let i = d + 1, depth = 0;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'end' || (depth === 0 && t.t === 'op' && (t.v === ';' || t.v === ','))) return end;
    if (t.t === 'op' && t.v === '(') depth++;
    else if (t.t === 'op' && t.v === ')') depth--;
    else if (depth === 0 && t.t === 'op' && t.v === '=') break;
  }
  let j = i + 1;
  while (j < toks.length && (toks[j].t === 'ws' || toks[j].t === 'cmt')) j++;
  const v = toks[j];
  if (!v || v.t === 'end') return end;
  if (v.t === 'str') {
    const open = v.s + (s[v.s] === "'" ? 1 : 2);
    return [open, Math.max(open, v.e - 1)];
  }
  let last = v;
  depth = 0;
  for (let k = j; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === 'end' || t.t === 'cmt') break;
    if (t.t === 'op' && t.v === '(') depth++;
    else if (t.t === 'op' && t.v === ')') depth--;
    else if (depth === 0 && t.t === 'op' && (t.v === ';' || t.v === ',')) break;
    if (t.t !== 'ws') last = t;
  }
  return [v.s, last.e];
}

// ------------------------------------------------------------------------------------------------------ Help (§8.2)

// Help sections in order (03 §8.2): [{id, title, blocks, genAt?}] with blocks ['h3', text] | ['p', text] |
// ['ul', text[]] | ['table', header[], rows[][]] | ['sql', text] | ['note', text]. Inline code is written in
// backticks; `key:<id>` names a KEYMAP command, whose keys are shown (no shortcut is hand-written here). Functions,
// Keyboard shortcuts, Query hints and Troubleshooting get their generated blocks at index genAt (default: the end)
// when Help opens (helpSections). Every statement here comes from a rule of the 00-04 specs.
export const HELP = Object.freeze([
  { id: 'start', title: 'Getting started', blocks: [
    ['h3', 'Install in Microsoft Edge'],
    ['p', 'SQL Studio is a favorite (a bookmarklet) for Microsoft Edge 120 or later. The install page, `install.html`, offers three ways to add it:'],
    ['ul', [
      'Drag: show the favorites bar with `Ctrl+Shift+B`, then drag the SQL Studio button onto it.',
      'Copy: select Copy bookmarklet, add any page as a favorite with `Ctrl+D`, edit that favorite (More in that dialog, or right-click the favorite and choose Edit) and paste the copied text into its URL field. Never paste it into the address bar: Edge drops `javascript:` from pasted text.',
      "Console: where your organisation's policy blocks `javascript:` favorites, open DevTools with `F12` on the Dynamics page and paste the console snippet from the install page into the Console.",
    ]],
    ['h3', 'Open it'],
    ['p', 'Open a Dynamics 365 or Power Apps model-driven app page, for example `https://<org>.crm.dynamics.com/main.aspx`, and select the favorite. SQL Studio opens in a window over the page and works with your signed-in Dataverse session. It talks only to the Web API of this environment (`/api/data/v9.2/`) and to no other server.'],
    ['h3', 'The window'],
    ['ul', [
      'Drag the title bar to move the window and its edges to resize it. Maximize fills the browser window. Size and position are remembered.',
      'Minimize shrinks the window to a pill in the bottom-right corner. Queries and writes keep running; select the pill to open the window again.',
      'Close hides the window and keeps everything: query tabs, results, #temp tables and the change log. Select the favorite to show it again. Closing turns Allow changes off. While a statement runs, Close minimizes to the pill instead.',
      'Escape closes menus, popups and dialogs and stops a running read, but never closes, hides or minimizes the window.',
    ]],
    ['h3', 'Write and run'],
    ['ul', [
      '`key:run` runs the selection, or the whole text when nothing is selected.',
      '`key:runStatement` runs the statement at the caret.',
      'Stop cancels a running read. A write (INSERT, UPDATE, DELETE or EXEC) stops only with the Stop button, after the current batch.',
      '`key:complete` shows suggestions, `key:signatureHelp` the parameters of the function you are typing, and `key:help` with the caret on a function name opens its description in Help.',
      '`key:plan` shows the estimated plan and FetchXML without running the query.',
      '`key:format` lays out the selection or the whole text. Format › Add display names (`key:addDisplayNames`) gives each plain column of the statement at the caret its display name as an alias.',
      'Convert shows the FetchXML of a query without running it, copies it as FetchXML, as a Web API URL or for Power BI (M), turns pasted FetchXML into SQL and imports the view of the Dynamics page as SQL. Power BI runs a copied query through the TDS endpoint, which supports less SQL than SQL Studio.',
    ]],
    ['sql', 'SELECT TOP 10 fullname, internalemailaddress, createdon\nFROM systemuser\nORDER BY createdon DESC;'],
    ['h3', 'Results'],
    ['ul', [
      'Every result set gets its own tab with its row count, next to Messages, Plan, FetchXML and Changes.',
      'Friendly shows labels and names; Raw shows the stored values (option numbers, ids, ISO dates).',
      'Filter rows with the quick filter or a column filter, sort by selecting column headers, and drag headers to reorder columns.',
      'Text shows a result set as fixed-width text that you can copy, and Chart shows the current view of a complete result set as a column, bar, line, pie or scatter chart.',
      'Plan shows the steps of a query, each marked Dataverse or Browser (Script for the control flow of a script); select a step to see its properties and, after a run, its rows, requests, time and share of the statement time.',
      'Export writes Excel, CSV, JSON or XML files and copies TSV, CSV, JSON, Markdown tables, INSERT statements, IN lists and FetchXML in conditions. Exports use the rows and columns as you see them.',
    ]],
    ['h3', 'Explorer'],
    ['ul', [
      'Search tables by logical, display or entity set name.',
      'Drag a table or column into the editor to insert its name, or double-click it to insert it at the caret.',
      'Select top 100 opens a query and runs it; Count rows shows how many records a table has.',
      'Temporary tables lists the #temp tables of the active query tab. Functions and Actions list the Web API messages of this environment: Script as SELECT or Script as EXEC opens a query for one in a new tab that does not run.',
    ]],
    ['h3', 'Query tabs'],
    ['p', '`key:newTab` opens a new query tab and `key:closeTab` closes it. Drag a tab to move it. Reopen closed tab, in the menu at the end of the tab strip, brings closed tabs back. Close all, in the menu of a tab, closes every tab in one step, and Undo in its message opens them again. Save all, in the Open menu, saves every tab that has SQL: tabs opened from a file are written back to it, and for each of the others you choose a file or skip it.'],
    ['note', 'Each query tab has its own session (variables, #temp tables, cursors, @@IDENTITY, SET options); Allow changes, Execute as and the change log are shared by all tabs.'],
    ['h3', 'History and templates'],
    ['p', 'History lists the queries you ran in this environment (their SQL text only). Templates are ready-made read-only queries; they open in a new tab and never run by themselves.'],
    ['h3', 'Changing data'],
    ['p', 'SQL Studio starts read-only. To run INSERT, UPDATE, DELETE or EXEC, select Read-only in the top bar and allow changes. Every write then shows a preview that you confirm. Safety model explains the rules.'],
  ] },
  { id: 'queries', title: 'Writing queries', blocks: [
    ['h3', 'Tables and columns'],
    ['p', 'Use the logical names of tables and columns, as the explorer shows them: `account`, `contact`, `createdon`. Names are not case-sensitive. Put names that need it in brackets: `[my column]`.'],
    ['p', 'Lookup, choice and yes/no columns come with virtual columns, as in SQL 4 CDS:'],
    ['ul', [
      '`<lookup>name` is the name of the referenced record: `owneridname`, `parentcustomeridname`.',
      '`<lookup>type` is the table of the referenced record, for lookups that can point at several tables: `owneridtype`, `regardingobjectidtype`.',
      '`<choice>name` is the label of a choice, state or status value: `statecodename`.',
      '`<bool>name` is the label of a yes/no value: `donotemailname`.',
    ]],
    ['sql', 'SELECT TOP 10 name, owneridname, owneridtype, statecode, statecodename\nFROM account;'],
    ['p', 'A lookup holds the id of the referenced record. A lookup that can point at several tables (customer, owner, regarding) also needs the table when you write it: `CREATELOOKUP(\'account\', @id)` gives an id its table.'],
    ['p', 'Binary values are written as `0x…` literals, and a version number can be compared with one: `WHERE versionnumber > 0x00000000033F264D` runs on Dataverse. BASE64_ENCODE and BASE64_DECODE convert binary values to and from text.'],
    ['h3', 'FetchXML condition functions'],
    ['p', 'The conditions of FetchXML are written as functions on the right of `=`: `createdon = lastxdays(7)`, `ownerid = equserid()`, `parentaccountid = under(@id)`. Dataverse evaluates them, in your Dataverse time zone. Functions › FetchXML conditions lists them all.'],
    ['sql', 'SELECT name, createdon\nFROM account\nWHERE createdon = lastxdays(30)\n  AND ownerid = equserid();'],
    ['h3', 'Metadata tables'],
    ['p', 'Nine tables describe the schema: `metadata.entity`, `metadata.attribute`, `metadata.relationship_1_n`, `metadata.relationship_n_1`, `metadata.relationship_n_n`, `metadata.alternate_key`, `metadata.optionsetvalue`, `metadata.globaloptionset` and `metadata.globaloptionsetvalue`. Text comparisons on them ignore case and accents.'],
    ['sql', "SELECT logicalname, displayname, attributetype\nFROM metadata.attribute\nWHERE entitylogicalname = 'account'\nORDER BY logicalname;"],
    ['h3', 'Archive and recycle bin'],
    ['p', '`archive.<table>` reads the long term retention data of a table that has it, and `bin.<table>` the deleted records of a table whose recycle bin is on. Joins and aggregates on them run in the browser.'],
    ['p', 'They are read-only, except that `DELETE FROM bin.<table> WHERE …` removes records from the recycle bin, and `EXEC Restore @Target = CREATELOOKUP(\'account\', @id)` restores a deleted record; both are writes with a preview.'],
    ['h3', 'Web API functions and actions'],
    ['p', 'Web API functions are table-valued functions: `SELECT * FROM WhoAmI()`, `SELECT * FROM RetrieveTotalRecordCount(\'account\', \'contact\')`. Actions run with `EXEC`, for example `EXEC WinOpportunity @OpportunityClose = …, @Status = 3`. Actions change data, so they need Allow changes and a confirmation in which you type the action name. Every function and action of this environment can be used, and Functions lists them; a name that is neither stops with error 2812 and a did-you-mean, so a mistyped name is never sent.'],
    ['p', 'EXEC can put response properties into variables with OUTPUT, as in `EXEC WhoAmI @UserId = @u OUTPUT`; an EXEC with OUTPUT parameters returns no result set. Arguments may be any expression, such as `CREATELOOKUP(\'account\', @id)`, and `EXEC @ret = Name …` sets @ret to 0 when the call succeeds.'],
    ['sql', 'DECLARE @u uniqueidentifier;\nEXEC WhoAmI @UserId = @u OUTPUT;\nSELECT fullname FROM systemuser WHERE systemuserid = @u;'],
    ['h3', 'Dynamic SQL'],
    ['p', '`EXEC sp_executesql @stmt, @params, …` and `EXEC (@sql)` run SQL text built while the script runs. The dynamic statements see only their parameters, not the variables of the script, but they share the query tab\'s #temp tables, cursors and SET options; OUTPUT parameters are copied back at the end. Every INSERT, UPDATE, DELETE or EXEC in them gets its own preview, like any other statement.'],
    ['sql', "EXEC sp_executesql N'SELECT TOP (@n) name FROM account ORDER BY name', N'@n int', @n = 5;"],
    ['h3', 'Temporary tables and variables'],
    ['p', '`#name` tables live in the session of the query tab until you drop them, close the tab or reload the page. They support CREATE TABLE, SELECT … INTO, INSERT, UPDATE, DELETE and DROP TABLE.'],
    ['p', '`@name` table variables are declared with `DECLARE @t TABLE (…)` and last for one batch. They support INSERT, UPDATE and DELETE; `SELECT … INTO` cannot target them. `OUTPUT … INTO` writes to either kind. Neither kind touches Dataverse.'],
    ['sql', 'SELECT TOP 20 name, revenue\nINTO #big\nFROM account\nORDER BY revenue DESC;\n\nSELECT * FROM #big;\n\nDROP TABLE #big;'],
    ['p', 'Load CSV as #temp (in the Open menu, or drop a .csv file on the editor) reads a CSV or TSV file in the browser into a #temp table of the active tab. Nothing is uploaded and nothing is written to Dataverse. Its More options take a range of records, the quote and escape characters, and whether a value that cannot be converted stops the load or skips its record; several files with the same columns load into one table with a last column `filename`.'],
    ['p', 'Load file as text (Open menu) reads one file of any type, up to 50 MB, into a #temp table with one row and one column `BulkColumn`, as text or as binary, so a JSON file can be read with OPENJSON:'],
    ['sql', 'SELECT j.[key], j.value\nFROM #notes\nCROSS APPLY OPENJSON(BulkColumn) AS j;'],
    ['h3', 'Joining values and FOR XML'],
    ['p', '`STRING_AGG(name, \', \')` joins the values of a group, and so does the older form `STUFF((SELECT \', \' + name FROM account ORDER BY name FOR XML PATH(\'\')), 1, 2, \'\')`. FOR XML RAW, PATH, AUTO and EXPLICIT return rows as XML, with ELEMENTS, TYPE and ROOT.'],
    ['sql', "SELECT STUFF((SELECT ', ' + name FROM account ORDER BY name FOR XML PATH('')), 1, 2, '') AS names;"],
    ['h3', 'XML values'],
    ['p', 'The xml type has the methods `value()`, `query()`, `exist()` and `nodes()`, on xml variables, on xml columns of #temp tables and table variables, and on text cast to xml, such as the FetchXML of a view. `nodes()` is a table source: `CROSS APPLY x.nodes(\'…\') AS t(c)`.'],
    ['sql', "SELECT TOP 10 name, CAST(fetchxml AS xml).value('(/fetch/entity/@name)[1]', 'nvarchar(100)') AS entityname\nFROM savedquery;"],
    ['h3', 'Scripts'],
    ['p', 'A script can declare variables and use IF, WHILE, BEGIN…END, TRY…CATCH, GOTO with labels, PRINT and WAITFOR DELAY or WAITFOR TIME (at most 24 hours; Stop ends the wait). Cursors are static and read-only: DECLARE CURSOR runs its query at OPEN and keeps the rows, and FETCH NEXT, PRIOR, FIRST, LAST, ABSOLUTE and RELATIVE move through them, with @@FETCH_STATUS and @@CURSOR_ROWS.'],
    ['sql', 'DECLARE @name nvarchar(160);\nDECLARE c CURSOR FAST_FORWARD FOR SELECT TOP 5 name FROM account ORDER BY name;\nOPEN c;\nFETCH NEXT FROM c INTO @name;\nWHILE @@FETCH_STATUS = 0\nBEGIN\n  PRINT @name;\n  FETCH NEXT FROM c INTO @name;\nEND;\nCLOSE c;\nDEALLOCATE c;'],
    ['p', 'SET NOCOUNT, DATEFORMAT, DATEFIRST, LANGUAGE and QUOTED_IDENTIFIER apply to the query tab they run in. `SET QUOTED_IDENTIFIER OFF` takes effect from the next batch and makes `"text"` a string; Settings › Editor › Quoted identifiers sets the default of new query tabs.'],
    ['h3', 'Writing data'],
    ['p', 'INSERT, UPDATE and DELETE work on Dataverse tables, #temp tables and table variables, also through a CTE or derived table, as in `WITH c AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY name ORDER BY createdon) AS r FROM account) DELETE FROM c WHERE r > 1`. Safety model explains the confirmations.'],
    ['ul', [
      'One statement changes at most Max records per statement: 5,000, or up to 250,000 for the current session (Settings › Data changes). Write batches get smaller when Dataverse answers slowly, and an INSERT of two or more records uses CreateMultiple where the table supports it.',
      'Writes that Dataverse accepts only as messages are sent as those messages, and the preview lists the requests of each record: closing states (statecode 1 of an opportunity sends WinOpportunity; also LoseOpportunity, CloseIncident, WinQuote, CloseQuote, FulfillSalesOrder and CancelSalesOrder), list members (AddMemberList, RemoveMemberList), sharing through principalobjectaccess (GrantAccess, ModifyAccess, RevokeAccess), solution components (AddSolutionComponent, RemoveSolutionComponent) and the parent of a business unit (SetParentBusinessUnit). `OPTION (USE HINT(\'DISABLE_STATE_TRANSITIONS\'))` sends a plain update of statecode and statuscode instead, which Dataverse may reject.',
      'When you are not a System Administrator, an update of a closed quote, order or invoice re-opens it to Draft for the update and then restores its state, both in one change set.',
      'A lookup that can point at several tables needs the table of a new value, from `CREATELOOKUP(\'account\', @id)` or its `<lookup>type` column; NULL needs none. `CREATEELASTICLOOKUP` points a lookup at a record of an elastic table, and an INSERT of an activity takes one record per party column, such as `[to]`, from CREATELOOKUP.',
      '`OPTION (USE HINT(\'USE_BULK_DELETE\'))` runs a DELETE as a bulk delete job in the background, and a DELETE of audit records always runs as one.',
    ]],
    ['h3', 'From FetchXML to SQL'],
    ['p', 'Convert › FetchXML → SQL turns pasted FetchXML into a query in a new tab that does not run; Import current view does the same with the view of the Dynamics page, and pasting FetchXML into the editor offers to convert it. Tables and columns that this environment does not have are listed first. The options are remembered:'],
    ['ul', [
      'Values as variables: each condition value outside an IN list becomes a variable, declared at the top.',
      'Relative dates as functions keeps conditions such as `lastxdays(7)`, which Dataverse evaluates; literal dates are fixed when you convert, and DATEADD expressions are computed when the query runs, in SQL Studio\'s time zone.',
      'Dates in UTC writes literal dates in UTC.',
    ]],
    ['h3', 'Dataverse or browser'],
    ['p', 'SQL Studio sends everything FetchXML can do to Dataverse and runs the rest in the browser. The Plan tab marks each step Dataverse or Browser, the toolbar says Runs on Dataverse or Partly in browser, and the parts of a query that run in the browser get an amber underline.'],
    ['h3', 'Limits'],
    ['ul', [
      'Max rows returned (default 50,000) stops a result set with a banner, which offers to run the query again without the limit.',
      'Max rows processed in the browser (default 500,000) limits the rows read for joins, sorting and grouping in the browser, and for Load CSV as #temp; going over it is an error.',
      'Max requests per statement (default 500) limits the requests one statement sends to Dataverse; going over it is an error.',
    ]],
    ['p', 'Change them in Settings › Results.'],
    ['h3', 'Time zones'],
    ['p', "Dates are shown and read in this browser's time zone, or in UTC (Settings › Results › Time zone, or select the zone label in the status bar). FetchXML date functions such as `today()` use your Dataverse time zone; when it differs from the browser's, the status bar and Messages say so."],
  ] },
  { id: 'functions', title: 'Functions', blocks: [
    ['p', 'Every built-in function, by category. Optional parameters are in brackets. Type a name in the filter to find one, or press `key:help` with the caret on a function name in the editor.'],
  ] },
  { id: 'compat', title: 'Compatibility', blocks: [
    ['p', 'SQL Studio follows the SQL dialect of SQL 4 CDS, so queries from SQL 4 CDS posts and scripts run here, and it behaves like SQL Server wherever this page does not say otherwise.'],
    ['h3', 'SQL 4 CDS: what works the same'],
    ['ul', [
      'The virtual name and type columns: `owneridname`, `statecodename`, `owneridtype`.',
      'The nine `metadata.*` tables.',
      'FetchXML condition functions such as `createdon = lastxdays(7)`.',
      '`CREATELOOKUP`, `CREATEELASTICLOOKUP` and the EntityReference type.',
      'Query hints, including the `USE HINT` names; a hint name SQL Studio does not know stops the batch with error 10715 and a did-you-mean, as in SQL 4 CDS.',
      '`EXECUTE AS` and `REVERT`.',
      'The `archive.` and `bin.` schemas.',
      'Web API functions as table-valued functions and actions with `EXEC`, including OUTPUT parameters, and dynamic SQL with `sp_executesql`.',
      '`NOLOCK`, also in the older form `account a (NOLOCK)`, sent to Dataverse as `<fetch no-lock="true">`.',
      'Cursors with every FETCH direction. Each cursor is a snapshot of its rows taken at OPEN; FAST_FORWARD runs as FORWARD_ONLY READ_ONLY.',
      'GOTO and labels.',
      'FOR XML RAW, PATH, AUTO and EXPLICIT.',
      'The xml type and its methods `value()`, `query()`, `exist()` and `nodes()`.',
      'DELETE as a bulk delete job with `USE_BULK_DELETE`, and always for audit records.',
      'Close states such as a won opportunity, written through their messages (WinOpportunity and the others).',
      '`SET QUOTED_IDENTIFIER OFF`, and the Quoted identifiers setting for its default.',
      'FetchXML → SQL with the column names, label orders and valueof comparisons of SQL 4 CDS, and its options: values as variables and relative dates as literal dates.',
      'Copy as Power BI (M) in the Convert menu.',
    ]],
    ['h3', 'SQL 4 CDS: differences'],
    ['ul', [
      'There is no TDS endpoint: every query runs through FetchXML and the Web API.',
      'BEGIN TRAN, COMMIT, ROLLBACK and SAVE TRAN stop the batch before anything runs, with the error “Transactions are not supported: every INSERT, UPDATE and DELETE is written immediately and cannot be rolled back. Remove BEGIN TRAN/ROLLBACK and use the preview dialog.”',
      'Every write needs Allow changes and the preview dialog. Nothing is ever upserted, and updates and deletes are sent with If-Match, so a record changed since it was read is skipped, never overwritten. A bulk delete job is the exception: it does not check If-Match, and its dialog says so.',
      'UpdateMultiple, UpsertMultiple and DeleteMultiple are never used; INSERT uses CreateMultiple where Dataverse offers it.',
      'An INSERT, UPDATE or DELETE inside a loop asks for confirmation at every execution, unless you approve its later executions in its dialog, with the number of records typed (a standing approval).',
      'One statement changes at most Max records per statement (5,000, or up to 250,000 for the current session); SQL 4 CDS has no such limit.',
      'FetchXML → SQL has no server conversion (the TDS endpoint SQL of SQL 4 CDS): SQL Studio converts every link type itself.',
      'There is no OPENROWSET syntax: Load CSV as #temp and Load file as text take its options instead.',
      'There is no XML DML: the xml method `modify()` raises an error. SQL 4 CDS has none either.',
      'DYNAMIC and KEYSET cursors, SCROLL_LOCKS, OPTIMISTIC, FOR UPDATE and WHERE CURRENT OF raise an error: every cursor is a snapshot taken at OPEN, and a write through a cursor position would bypass the preview.',
      'There is no programmatic API or provider (SQL 4 CDS’s ADO.NET provider, Dapper, @parameters supplied by a host program, CommandBehavior, CommandTimeout) and no command line: SQL Studio is an IDE in the browser. Use DECLARE for parameters and Run statement for a single result.',
      'MAXRECURSION is applied by SQL Studio only; it is not sent to Dataverse as a FetchXML option, because Dataverse does not document one.',
      'Each query tab is its own session. Impersonation (EXECUTE AS) applies to every tab and turns Allow changes off.',
      'Results stop at Max rows returned, with a banner.',
      'SUM, AVG, MIN and MAX over no rows return NULL, as in SQL Server; SQL 4 CDS returns 0.',
      'Format keeps every token: it never adds a `;` and indents by 4 spaces, where SQL 4 CDS appends `;` and pads clause keywords to a column.',
    ]],
    ['h3', 'SQL Server: documented differences'],
    ['ul', [
      'MAXRECURSION 0 stops at 32,767 recursions.',
      'FOR JSON and FOR XML return one row that is never split into 2,033-character chunks.',
      'An xml `value()` path that matches several nodes takes the first, as SQL 4 CDS does, where SQL Server raises error 2389. The xml methods also accept a string, which SQL Server refuses with error 258; every XML parsing error has the number 9400; DATALENGTH of an xml value counts the UTF-16 bytes of its text.',
      'EXEC arguments may be any expression, where T-SQL allows only constants, variables and DEFAULT.',
      'A cursor declared without FORWARD_ONLY or FAST_FORWARD can scroll, as in SQL 4 CDS, because every cursor is static; SQL Server makes `DECLARE c CURSOR FOR …` forward-only.',
      'WAITFOR TIME waits for a time of day in the time zone of SQL Studio (Settings › Results › Time zone).',
      "AT TIME ZONE accepts SQL Server's Windows zone names and IANA names such as `Europe/Berlin`. Its offsets come from the browser's time zone data, which can differ from SQL Server's rules for historical dates.",
      'APPROX_COUNT_DISTINCT returns the exact count.',
      'An UPDATE or DELETE whose target is not in its FROM clause is an error, instead of changing every row. `UPDATE … SET @v = column = expression` is not supported.',
      'Text comparisons follow the Dataverse collation: they ignore case, ignore accents in most languages, and ignore trailing spaces for = and <>. COLLATE accepts the _KS and _WS suffixes but does not apply kana or width sensitivity.',
      "Converting nvarchar to varchar keeps every character; varbinary to varchar reads invalid UTF-8 as Windows-1252, and decimal, numeric, money and smallmoney do not convert to or from binary.",
      'bigint values beyond ±2^53 lose precision and add a warning.',
      "USER_NAME() returns the id of the user SQL Studio acts as, as SQL 4 CDS does, so `ownerid = USER_NAME()` works; SUSER_NAME() returns the name. SQL_VARIANT_PROPERTY(v, 'BaseType') reports int for tinyint and smallint, and float for real.",
      'Constraints other than NOT NULL, IDENTITY and DEFAULT are accepted on #temp tables and table variables but not enforced, with a warning. SQL Server hints that SQL Studio does not implement are ignored with a warning, and an unknown hint name raises error 10715, as in SQL Server.',
      "FORMAT formats in en-US by default (en-GB after `SET LANGUAGE British`) and matches SQL Server for en-US. Every other culture, en-GB included, uses this browser's locale data, with a warning. The U, z, zz and zzz formats use the session's time zone instead of the server's; R may print 16 digits where SQL Server prints 17; X formats smallint and tinyint values like int; real values are formatted like float.",
    ]],
    ['note', 'As in SQL Server, a datetimeoffset value made without an offset gets +00:00, and datetime2, datetimeoffset and time keep 100-ns precision.'],
  ] },
  { id: 'safety', title: 'Safety model', blocks: [
    ['h3', 'Changes and read-only mode'],
    ['p', 'SQL Studio starts with changes allowed: INSERT, UPDATE, DELETE, EXEC of actions and grid edits can write, and every write first shows its preview. Queries read whatever your security roles allow.'],
    ['ul', [
      'Select Changes allowed in the top bar to switch to read-only; select Read-only to allow changes again. Neither needs a confirmation.',
      'In read-only mode every write is refused before anything is sent. While a standing approval is active, selecting the pill ends that approval instead.',
    ]],
    ['h3', 'Preview and confirmation'],
    ['p', 'Every write first shows a preview: the records, the old and new values, cascaded deletes and the plug-ins and flows that run. Only the requests of that preview can be sent, to exactly those records, as the user who confirmed. Writes that Dataverse accepts only as messages, such as closing an opportunity as won, are listed per record with the requests they send.'],
    ['p', 'You type the record count (or the action or table name) to confirm when:'],
    ['ul', [
      'more than 100 records change, cascaded records included;',
      'the environment is Production;',
      'the table is a high-risk system table (users, teams, roles, business units, solutions, processes, plug-ins, forms, views and similar);',
      'a bypass hint is used (BYPASS_CUSTOM_PLUGIN_EXECUTION, BYPASS_BUSINESS_LOGIC_EXECUTION);',
      'you act as another user;',
      'only part of a statement is selected;',
      'secured columns are copied;',
      'records are closed or reopened through their messages;',
      'a DELETE runs as a bulk delete job;',
      'an action runs with EXEC (you type the action name).',
    ]],
    ['h3', 'Statements without WHERE'],
    ['p', 'An UPDATE or DELETE that would change every record of a table is blocked. The setting Allow UPDATE/DELETE without WHERE lets it through for the current session, and you then type the table name to confirm.'],
    ['p', 'Safety-relaxing settings (Allow UPDATE/DELETE without WHERE, Download backup before delete off, formula protection off, Max records per statement above 5,000, up to 250,000) last for the current session only and need the environment name typed in Production.'],
    ['h3', 'Statements in loops'],
    ['p', 'A statement that runs several times in a script, for example in a WHILE loop, opens its preview at every execution. From its second execution the dialog offers to apply the confirmation to every later execution of that statement in the run, up to a number of records that you type (and, in Production, the environment name). Each later execution then still builds its exact preview, sends only the requests of that preview and gets its own Changes entry and Messages line, without opening a dialog.'],
    ['ul', [
      'It is never offered while you act as another user, for a bulk delete job or for grid edits. For a DELETE it means that later executions are not backed up.',
      'A different statement, a total above the number you typed, or a warning the approving dialog did not show (a new cascade, secured columns, a partial selection) opens the dialog again.',
      'The top-bar pill shows the approval and how many records it has covered; selecting the pill ends it. It also ends with Stop, Cancel, any change of the acting user or of Allow changes, and the end of the run.',
    ]],
    ['h3', 'Records changed by someone else'],
    ['p', 'Updates and deletes are sent with the version of each record read before the preview. A record changed since then is skipped and reported as changed since selection, never overwritten. For tables without optimistic concurrency the preview warns that changes made shortly before each batch can be overwritten.'],
    ['p', 'A bulk delete job (a DELETE with `USE_BULK_DELETE`, and every DELETE of audit records) is the exception: Dataverse deletes the previewed records in the background without that check, so records changed after the preview are deleted too. Its dialog says so, and you type the record count. Messages links each system job, and Undo is not available.'],
    ['h3', 'Backups, logs and undo'],
    ['ul', [
      'Before a DELETE of up to 5,000 records, the preview asks you to save a backup (JSON) of every readable column. Records deleted by cascade are not in it.',
      'Updates of more than 100 records offer a before/after log (JSON) to save before writing.',
      'The Changes tab lists every write of this session. Undo writes the old values back (or deletes created records), through a new preview, for the records that still have the values written. Undo is not available for secured columns.',
      'Tables whose recycle bin is on keep deleted records for 30 days.',
    ]],
    ['h3', 'Stopping a write'],
    ['p', 'The Stop button stops a write after the current batch; batches already sent finish. Escape never stops a write, and Close minimizes SQL Studio while it writes. A request whose outcome is unknown (after a network error, for example) is never sent again: it is checked afterwards, and records that could not be checked are listed under “Outcome unknown: check these records”.'],
    ['h3', 'Personal views'],
    ['p', 'Save as personal view needs no Allow changes: its own dialog confirms that one view. It is not available while you act as another user.'],
    ['h3', 'Exports'],
    ['p', "CSV files and copies of several cells put a ' before text that starts with = + - or @, so that a spreadsheet does not run it as a formula. Turning this off lasts for the current session only."],
    ['h3', 'What is stored in this browser'],
    ['p', 'Settings, the window layout, the metadata cache, the query history (SQL text only; it can be turned off) and your open tabs (title and SQL) are stored in this browser. Rows, results, grid edits, CSV data and loaded files are never stored; they are gone after a reload. Standing approvals are never stored either: they end with their run.'],
    ['note', 'SQL Studio sends data only to the Web API of this environment. It loads nothing from other servers and sends no telemetry.'],
  ] },
  { id: 'keys', title: 'Keyboard shortcuts', blocks: [
    ['p', 'The shortcuts of this platform. They work while the focus is inside SQL Studio; while a dialog is open, only the dialog and Escape take keys. A chord is two keys pressed one after the other.'],
  ] },
  { id: 'hints', title: 'Query hints', blocks: [
    ['p', "Put query hints at the end of a statement, in `OPTION (…)`: `OPTION (USE HINT('RETRIEVE_TOTAL_RECORD_COUNT'))`, `OPTION (MAXRECURSION 500)`."],
    ['sql', "SELECT COUNT(*) AS [count]\nFROM account\nOPTION (USE HINT('RETRIEVE_TOTAL_RECORD_COUNT'));"],
  ] },
  { id: 'errors', title: 'Troubleshooting', genAt: 1, blocks: [
    ['p', 'Dataverse errors with a known cause. Messages shows the same explanation under the error, with a Help link to this page.'],
    ['h3', 'Blocked'],
    ['p', 'A message that starts with Blocked comes from the write safety checks; nothing was sent.'],
    ['table', ['Message', 'What it means'], [
      ['Blocked: this change was not confirmed.', 'A write was attempted without a confirmation from the preview dialog; nothing was sent.'],
      ['Blocked: request differs from the confirmed preview', 'The statement tried to send a request that the preview did not show. Run it again to see a new preview.'],
      ['Blocked: the acting user changed since the confirmation', 'Execute as or Revert ran after you confirmed. Run the statement again.'],
      ['Blocked: update/delete without If-Match', 'An update or delete had no record version. Run the statement again.'],
      ['Blocked: not available while acting as another user.', 'Save as personal view is not available while Execute as is on. Revert first.'],
      ['Blocked: the acting user cannot change while changes are being written.', 'Wait until the write has finished, then change the acting user.'],
      ['Blocked: the confirmation expired; run the statement again to preview it.', 'A confirmation is valid for ten minutes. Run the statement again to see a new preview.'],
      ['Blocked: this confirmation was already used.', 'A confirmation covers one statement, once. Run the statement again to preview it.'],
      ['Blocked: SQL Studio is read-only. Select the Read-only pill in the top bar and run the statement again.', 'Changes were switched off with the mode pill in the top bar. Select it to allow changes again, then run the statement again.'],
    ]],
    ['h3', 'SQL Studio is read-only'],
    ['p', '“SQL Studio is read-only. Select the Read-only pill in the top bar to allow INSERT, UPDATE, DELETE and EXEC again.” Changes are allowed when SQL Studio starts; the mode pill switches them off and on. Select it, or Allow changes and run again in Messages.'],
    ['h3', 'This statement would change every record'],
    ['p', 'An UPDATE or DELETE without a real filter is blocked. Add a WHERE clause, or turn on Allow UPDATE/DELETE without WHERE in Settings › Data changes for this session.'],
    ['h3', 'Your Dataverse session has expired'],
    ['p', '“Your Dataverse session has expired. Reload the page, sign in, then run the query again.” Your sign-in to Dynamics ended. Reload the page, sign in and run the query again.'],
    ['h3', 'Paging did not advance'],
    ['p', '“Paging did not advance; the query was stopped to avoid duplicate rows.” Dataverse returned a page it had already sent, so SQL Studio stopped rather than show duplicate rows. Run the query again; when it happens again, add a filter so that fewer rows are read.'],
    ['h3', 'The query is too long to send'],
    ['p', 'A request whose URL would be longer than 64,000 characters even inside $batch is never sent (error code `toolong`). Shorten long IN lists or split the query.'],
    ['h3', 'Dataverse is busy'],
    ['p', 'When Dataverse service protection limits are reached, the status bar turns amber and counts down: “Dataverse is busy (service protection). Retrying in 12 s…”. SQL Studio waits and retries on its own; Messages logs the total wait.'],
    ['h3', 'Approximate counts'],
    ['p', 'Count rows and `OPTION (USE HINT(\'RETRIEVE_TOTAL_RECORD_COUNT\'))` read RetrieveTotalRecordCount: “Approximate count from RetrieveTotalRecordCount (snapshot taken within the last 24 hours).”. Run `SELECT COUNT(*)` without the hint for the exact number.'],
    ['h3', 'Time zone warning'],
    ['p', "“today()/lastxdays() are evaluated in your Dataverse time zone (…), which differs from this browser's time zone.” FetchXML date functions such as today() use your Dataverse time zone, not this browser's. The status bar shows both zones."],
    ['h3', 'Nothing happens when I click the favorite'],
    ['ul', [
      'Open a Dynamics 365 or Power Apps model-driven app page first; elsewhere SQL Studio says so and does not start.',
      "Your organisation's policy may block `javascript:` favorites. Use the console snippet from the install page instead.",
      'The favorite may be damaged. Install it again from the install page and compare the SHA-256 shown there.',
    ]],
  ] },
  { id: 'templates', title: 'Templates', blocks: [
    ['p', 'Ready-made read-only queries. Each opens in a new query tab and never runs by itself. Values you may want to change are declared at the top and marked `-- change this`.'],
  ] },
]);

const noTicks = s => String(s ?? '').replace(/`/g, "'");

// The blocks of the generated Functions part: a heading per category, one 'fn' block per docList() entry.
export function functionBlocks(docs) {
  const out = [];
  let cat = null;
  for (const d of Array.isArray(docs) ? docs : []) {
    if (d.category !== cat) { cat = d.category; out.push(['h3', cat]); }
    out.push(['fn', d]);
  }
  return out;
}

// The blocks of meta.messages() (02 §2): Web API functions, then actions; a loading note for null, an error note for an
// Error.
export function messageBlocks(messages) {
  if (messages == null) return [['h3', 'Web API functions and actions'], ['p', 'Loading the Web API functions and actions of this environment…']];
  if (messages instanceof Error) return [['h3', 'Web API functions and actions'], ['note', `The Web API functions and actions could not be read: ${noTicks(messages.message)}`]];
  const list = [...(typeof messages.values === 'function' ? messages.values() : messages)].filter(m => m && m.name)
    .sort((a, b) => (lower(a.name) < lower(b.name) ? -1 : lower(a.name) > lower(b.name) ? 1 : 0));
  const fns = list.filter(m => m.kind === 'function'), acts = list.filter(m => m.kind !== 'function');
  return [
    ['h3', 'Web API functions'],
    ['p', 'Read them as table-valued functions, for example `SELECT * FROM WhoAmI()`; parameters go in the parentheses, in order.'],
    ...fns.map(m => ['msg', m]),
    ['h3', 'Web API actions'],
    ['p', 'Run them with `EXEC Name @Parameter = value, …`. They change data, so they need Allow changes and a confirmation in which you type the action name.'],
    ...acts.map(m => ['msg', m]),
  ];
}

// The blocks of the shortcut tables: one table per KEYMAP scope (KEYMAP_GROUPS order and headings) with one row per
// entry, [label, `key:id`].
export function keyBlocks(keymap = KEYMAP) {
  const out = [];
  const scopes = KEYMAP_GROUPS.map(g => [...g]);
  for (const e of keymap) if (!scopes.some(([s]) => s === e.scope)) scopes.push([e.scope, e.scope]);
  for (const [scope, title] of scopes) {
    const rows = keymap.filter(e => e.scope === scope);
    if (!rows.length) continue;
    out.push(['h3', title], ['table', ['Command', 'Keys'], rows.map(e => [noTicks(e.label), '`key:' + e.id + '`'])]);
  }
  return out;
}

// The generated blocks of Query hints (03 §8.2 section 7) from HINT_DOCS ([{name, syntax, text, typed?, kind:
// 'studio'|'sqlserver'}], one entry per parser.js HINTS name): SQL Studio's own hints with their effect and whether a
// typed confirmation is needed; the SQL Server names, those SQL Studio uses with their effect and the others (HINTS
// row implemented: false) as accepted and ignored; the table hints (a HINTS row of kind 'table'); and the 10715 rule
// for any other name. Any entry that is neither 'sqlserver' nor a table hint is listed with SQL Studio's own.
export function hintBlocks(hints, { rows = HINTS } = {}) {
  if (!Array.isArray(hints) || !hints.length) return [['note', 'The query hint reference is not available.']];
  const byName = new Map((Array.isArray(rows) ? rows : []).filter(r => r && r.name).map(r => [String(r.name).toUpperCase(), r]));
  const rowOf = x => byName.get(String(x.name).toUpperCase()) ?? null;
  const studio = [], server = [], table = [];
  for (const x of hints) {
    if (!x || !x.name) continue;
    if (rowOf(x)?.kind === 'table') table.push(x);
    else if (x.kind === 'sqlserver') server.push(x);
    else studio.push(x);
  }
  const code = x => '`' + noTicks(x.syntax || x.name) + '`';
  const out = [];
  if (studio.length) {
    out.push(['h3', 'SQL Studio hints'], ['table', ['Hint', 'What it does', 'Typed confirmation'], studio.map(x => [code(x), noTicks(x.text), x.typed ? 'Yes' : 'No'])]);
  }
  out.push(['h3', 'SQL Server hints'],
    ['p', "SQL Studio also accepts the documented SQL Server query hints and USE HINT names. Those that Dataverse understands are passed to it in `<fetch options>`; the others are accepted and ignored with the warning `Hint 'X' is not supported and was ignored.`"]);
  if (server.length) {
    out.push(['table', ['Hint', 'What it does'], server.map(x => [code(x), rowOf(x)?.implemented === false ? 'Accepted and ignored with a warning.' : noTicks(x.text)])]);
  }
  out.push(['h3', 'Table hints'],
    ['p', "`WITH (NOLOCK)`, or `(NOLOCK)` after the table name as in `account a (NOLOCK)`, is sent to Dataverse as `<fetch no-lock=\"true\">`. Any other table hint is an error: `Table hint '<name>' is not supported.`"]);
  if (table.length) out.push(['table', ['Hint', 'What it does'], table.map(x => [code(x), noTicks(x.text)])]);
  out.push(['h3', 'Unknown hint names'],
    ['p', `A hint name that is in none of these tables stops the batch before anything runs, with error 10715 \`${noTicks(MESSAGES[10715]?.text ?? '')}\` and a did-you-mean suggestion, so a misspelt hint never runs without its effect.`]);
  return out;
}

// The blocks of the Dataverse error table from ERROR_HINTS ([{codes, line, cause, fix}]), with an anchor per code.
export function errorBlocks(errorHints) {
  if (!Array.isArray(errorHints) || !errorHints.length) return [['note', 'The error reference is not available.']];
  const rows = errorHints.map(e => [(e.codes ?? []).map(c => '`' + noTicks(c) + '`').join(', '), noTicks(e.cause || e.line), noTicks(e.fix)]);
  return [['h3', 'Dataverse errors'], ['table', ['Code', 'What happened', 'What to do'], rows, { anchors: errorHints.map(e => [...(e.codes ?? [])].map(lower)) }]];
}

// Every Help section with its generated blocks (03 §8.2): [{id, title, blocks, text}] (text: the search index).
export function helpSections({ docs = null, messages = null, keymap = KEYMAP, mac = false, hints = HINT_DOCS, errorHints = null, templates = TEMPLATES } = {}) {
  return HELP.map(sec => {
    let gen = null;
    if (sec.id === 'functions') gen = [...functionBlocks(docs ?? docList()), ...messageBlocks(messages)];
    else if (sec.id === 'keys') gen = keyBlocks(keymap);
    else if (sec.id === 'hints') gen = hintBlocks(hints);
    else if (sec.id === 'errors') gen = errorBlocks(errorHints);
    const blocks = gen ? [...sec.blocks.slice(0, sec.genAt ?? sec.blocks.length), ...gen, ...sec.blocks.slice(sec.genAt ?? sec.blocks.length)] : [...sec.blocks];
    let text = [sec.title, ...blocks.map(b => blockText(b, { keymap, mac }))].join('\n');
    if (sec.id === 'templates') text += '\n' + templates.map(t => `${t.title}\n${t.description}\n${t.tables.join(' ')}`).join('\n');
    return { id: sec.id, title: sec.title, blocks, text };
  });
}

// Plain text of one Help block (search index; key refs resolved).
export function blockText(b, opts = {}) {
  const it = t => inlineText(t, opts);
  switch (b[0]) {
    case 'h3': case 'p': case 'note': return it(b[1]);
    case 'ul': return b[1].map(it).join('\n');
    case 'table': return [b[1].map(it).join(' '), ...b[2].map(r => r.map(it).join(' '))].join('\n');
    case 'sql': return String(b[1]);
    case 'fn': {
      const d = b[1];
      return [d.display, d.summary, ...(d.params ?? []).map(p => `${p.name}: ${p.desc}`)].join('\n');
    }
    case 'msg': {
      const m = b[1];
      return [m.name, m.kind, m.description ?? '', ...(m.params ?? []).map(p => `${p.name} ${p.type ?? ''} ${p.description ?? ''}`)].join('\n');
    }
    default: return '';
  }
}

// Help search (03 §8.2): the sections whose text contains the query, ignoring case and accents, each with a snippet
// around the first hit: [{id, title, snippet: {before, hit, after}}].
export function searchHelp(sections, query) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const out = [];
  for (const s of sections) {
    const r = findFolded(s.text, q);
    if (!r) continue;
    const text = s.text.replace(/\s+/g, ' ');
    const at = findFolded(text, q) ?? { start: 0, end: 0 };
    let a = Math.max(0, at.start - 60), z = Math.min(text.length, at.end + 80);
    if (a > 0) { const sp = text.indexOf(' ', a); a = sp >= 0 && sp < at.start ? sp + 1 : a; }
    if (z < text.length) { const sp = text.lastIndexOf(' ', z); z = sp > at.end ? sp : z; }
    out.push({ id: s.id, title: s.title, snippet: { before: (a > 0 ? '…' : '') + text.slice(a, at.start), hit: text.slice(at.start, at.end), after: text.slice(at.end, z) + (z < text.length ? '…' : '') } });
  }
  return out;
}

// The Help section id of a name, or null.
export function helpSectionId(id) {
  return HELP.some(s => s.id === id) ? id : null;
}

// The data-anchor value of an element with several anchor names (an error row lists all its codes): the names joined
// with '|', which no function, message or error-code name contains ('AT TIME ZONE' has spaces).
export function anchorList(names) {
  return (Array.isArray(names) ? names : [names]).map(n => String(n ?? '').trim()).filter(Boolean).join('|');
}

// True when a data-anchor value names `anchor` exactly (ignoring case): 'AT TIME ZONE' matches the AT TIME ZONE entry,
// 'TIME' matches nothing; '0x80048644' matches the row '0x80048573|0x80048644'.
export function anchorMatches(value, anchor) {
  const key = String(anchor ?? '').trim().toUpperCase();
  return key !== '' && String(value ?? '').split('|').some(n => n.trim().toUpperCase() === key);
}

// ------------------------------------------------------------------------------------------------------------ CSS

// Dialog styles (03 §1.3): .dg- classes only, colours only through var(--token); the shared components (.btn .input
// .sel .seg .switch .chk .field .note .err-box .code .kv .lt .badge .pill .tag .fp .empty .progress) come from BASE.
export const CSS = `.dg-stack{display:flex;flex-direction:column;gap:12px;min-width:0}
.dg-sub{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--fg3);font-size:12px;line-height:16px}
.dg-sub code{font-size:12px}
.dg-counts{margin:0;color:var(--fg1);font-weight:600}
.dg-facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px 16px;margin:0;padding:10px 12px;border:1px solid var(--s2);border-radius:4px;background:var(--bg2);flex:none}
.dg-facts div{min-width:0}
.dg-facts dt{font-size:12px;line-height:16px;color:var(--fg3)}
.dg-facts dd{margin:0;color:var(--fg1);font-weight:600;overflow-wrap:anywhere}
.dg-part{margin:4px 0 0;font-size:14px;line-height:20px;font-weight:600;color:var(--fg1)}
.dg-scroll{overflow:auto;max-height:260px;border:1px solid var(--s2);border-radius:4px;flex:none}
table.dg-tbl{border-collapse:separate;border-spacing:0;min-width:100%;font-size:12px;line-height:16px}
.dg-tbl th{position:sticky;top:0;z-index:1;background:var(--bg1);text-align:left;font-weight:600;color:var(--fg1);padding:6px 10px;border-bottom:1px solid var(--s2);white-space:nowrap}
.dg-tbl td{padding:6px 10px;border-bottom:1px solid var(--s3);color:var(--fg1);vertical-align:top;white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis}
.dg-tbl tr:last-child td{border-bottom:0}
.dg-old,.dg-new{border-radius:3px;padding:0 4px}
.dg-old{background:var(--diff-del)}
.dg-new{background:var(--diff-add)}
.dg-arrow{color:var(--fg3);padding:0 4px}
.dg-more{margin:0;font-size:12px;line-height:16px;color:var(--fg3)}
.dg-code{max-height:240px;overflow:auto;flex:none}
.dg-inv{display:inline-block;margin:0 1px;padding:0 3px;border:1px solid var(--amber-s);border-radius:3px;background:var(--amber-bg);color:var(--amber);font:10px/14px var(--mono);vertical-align:1px}
.dg-inv.ed-inv::before{content:none}
.dg-row2{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.dg-ok{display:inline-flex;align-items:center;gap:4px;color:var(--green)}
.dg-msg{font-size:12px;line-height:16px;color:var(--fg3)}
.dg-msg.bad{color:var(--red)}
.dg-field{display:flex;flex-direction:column;gap:4px}
.dg-field>label{font-weight:600;color:var(--fg1)}
.dg-field .input{max-width:420px}
.dg-err{margin:0;font-size:12px;line-height:16px;color:var(--red)}
.dg-split{display:grid;grid-template-columns:180px minmax(0,1fr);gap:24px;flex:1;min-height:0}
.dg-nav{display:flex;flex-direction:column;gap:2px;min-width:0;min-height:0;overflow:auto}
.dg-nav button{display:flex;align-items:center;gap:8px;min-height:32px;padding:6px 10px;border:0;border-radius:4px;background:none;color:var(--fg2);text-align:left;cursor:pointer;flex:none}
.dg-nav button:hover{background:var(--bg3);color:var(--fg1)}
.dg-nav button[aria-current=page]{background:var(--brand-bg);color:var(--brand);font-weight:600}
.dg-nav button:focus-visible{outline-offset:-2px}
.dg-pane{min-width:0;min-height:0;overflow:auto;display:flex;flex-direction:column}
.dg-pane>h2{margin:0 0 8px;font-size:20px;line-height:28px;font-weight:600;color:var(--fg1)}
.dg-set{min-height:min(420px,60vh)}
.dg-srow{display:flex;align-items:flex-start;gap:16px;padding:12px 0;border-bottom:1px solid var(--s3)}
.dg-srow:last-child{border-bottom:0}
.dg-srow .main{flex:1;min-width:0}
.dg-srow .lb{display:block;color:var(--fg1);font-weight:600}
.dg-srow .hint{display:block;font-size:12px;line-height:16px;color:var(--fg3);margin-top:2px}
.dg-srow .ctl{flex:none;display:flex;align-items:center;gap:8px;padding-top:2px}
.dg-num{width:132px}
.dg-about{display:flex;flex-direction:column;gap:12px}
.dg-brand{display:flex;align-items:center;gap:12px}
.dg-brand b{display:block;font-size:16px;line-height:22px;color:var(--fg1)}
.dg-links{display:flex;flex-wrap:wrap;gap:8px 16px}
.dg-licence{margin:0;padding:12px 16px;border:1px solid var(--s2);border-radius:6px;background:var(--bg2);color:var(--fg3);font:12px/18px var(--mono);white-space:pre-wrap;max-height:200px;overflow:auto}
.dg-help{display:grid;grid-template-columns:220px minmax(0,1fr);gap:24px;flex:1;min-height:0}
.dg-help-side{display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0}
.dg-help-main{min-width:0;min-height:0;overflow:auto;padding-right:8px;color:var(--fg2)}
.dg-help-main>h2{margin:0 0 12px;font-size:20px;line-height:28px;font-weight:600;color:var(--fg1);outline-offset:2px}
.dg-help-main h3{margin:20px 0 8px;font-size:16px;line-height:22px;font-weight:600;color:var(--fg1)}
.dg-help-main p{margin:0 0 10px}
.dg-help-main ul{margin:0 0 10px;padding-left:20px}
.dg-help-main li{margin:0 0 4px}
.dg-help-main .note{margin:0 0 12px}
.dg-ht{overflow:auto;margin:0 0 12px;border:1px solid var(--s2);border-radius:4px}
.dg-ht .lt th{background:var(--bg2)}
.dg-ht .lt td{vertical-align:top}
.dg-target{background:var(--brand-bg)}
.dg-ex{margin:0 0 12px}
.dg-ex .code{max-height:320px;overflow:auto}
.dg-ex-bar{display:flex;justify-content:flex-end;margin-top:4px}
.dg-fn,.dg-wapi{padding:10px 0;border-bottom:1px solid var(--s3);scroll-margin-top:8px}
.dg-fn h4,.dg-wapi h4{margin:0 0 4px;font:600 13px/18px var(--mono);color:var(--fg1);overflow-wrap:anywhere}
.dg-fn p,.dg-wapi p{margin:0 0 4px}
.dg-params{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 12px;margin:4px 0 0;font-size:12px;line-height:16px}
.dg-params dt{font-family:var(--mono);color:var(--fg1)}
.dg-params dd{margin:0;color:var(--fg3)}
.dg-keys{white-space:nowrap}
.dg-cat{min-width:0}
.dg-filter{display:flex;align-items:center;gap:12px;margin:0 0 8px;flex-wrap:wrap}
.dg-filter .input{flex:0 1 320px;min-width:180px}
.dg-results{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.dg-res{display:flex;flex-direction:column;gap:2px;width:100%;padding:8px 12px;border:0;border-radius:4px;background:none;text-align:left;cursor:pointer;color:var(--fg2)}
.dg-res:hover{background:var(--bg3)}
.dg-res b{color:var(--fg1)}
.dg-res span{font-size:12px;line-height:16px;color:var(--fg3);overflow-wrap:anywhere}
.dg-tpl{display:flex;flex-direction:column;gap:12px;min-height:0}
.dg-chips{display:flex;flex-wrap:wrap;gap:8px}
.dg-chip{padding:0 12px}
.dg-chip[aria-pressed=true]{background:var(--brand-bg);border-color:var(--brand);color:var(--brand);font-weight:600}
.dg-tpl-body{display:grid;grid-template-columns:minmax(220px,320px) minmax(0,1fr);gap:16px;min-height:0}
.dg-vlist{position:relative;height:min(440px,52vh);overflow:auto;border:1px solid var(--s2);border-radius:4px;outline:0}
.dg-vlist:focus-visible{border-color:var(--focus);box-shadow:inset 0 0 0 1px var(--focus)}
.dg-card{position:absolute;left:0;right:0;height:80px;display:flex;flex-direction:column;justify-content:center;gap:2px;padding:0 12px;border-bottom:1px solid var(--s3);cursor:pointer;min-width:0;transition:background .08s}
.dg-card:hover{background:var(--bg3)}
.dg-card[aria-selected=true]{background:var(--brand-bg);box-shadow:inset 3px 0 0 var(--brand)}
.dg-card[aria-selected=true]:hover{background:var(--brand-bg-h)}
.dg-card .nm{font-weight:600;color:var(--fg1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dg-card .un{font-size:12px;line-height:16px;color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dg-card .tags{margin-top:2px}
.dg-card .tag{margin-left:0;flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dg-tpl-view{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0}
.dg-tpl-view h3{margin:0;font-size:16px;line-height:22px;font-weight:600;color:var(--fg1)}
.dg-tpl-view p{margin:0}
.dg-tpl-view .tags{flex-wrap:wrap}
.dg-tpl-view .tag{margin-left:0}
.dg-tpl-view .code{max-height:min(340px,40vh);overflow:auto}
.dg-acts{display:flex;gap:8px;flex-wrap:wrap}
.dg-users{border:1px solid var(--s2);border-radius:4px;min-height:96px;max-height:280px;overflow:auto}
.dg-user{display:flex;flex-direction:column;padding:8px 12px;border-bottom:1px solid var(--s3);cursor:pointer;min-width:0}
.dg-user:last-child{border-bottom:0}
.dg-user:hover{background:var(--bg3)}
.dg-user[aria-selected=true]{background:var(--brand-bg);box-shadow:inset 3px 0 0 var(--brand)}
.dg-user .nm{font-weight:600;color:var(--fg1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dg-user .un{font-size:12px;line-height:16px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dg-status{padding:12px;color:var(--fg3)}
.dg-htools{display:flex;align-items:center;gap:8px;flex:1;flex-wrap:wrap}
.dg-htools .input{flex:0 1 320px;min-width:180px}
.dg-hist{position:relative;height:100%;min-height:200px;overflow:auto}
.dg-hrow{position:absolute;left:0;right:0;height:64px;display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--s3)}
.dg-hrow:hover{background:var(--bg3)}
.dg-hopen{flex:1;min-width:0;height:100%;display:flex;align-items:center;gap:12px;padding:0 12px;border:0;background:none;text-align:left;cursor:pointer;color:var(--fg1)}
.dg-hopen:focus-visible{outline-offset:-2px}
.dg-htext{flex:1;min-width:0;display:flex;flex-direction:column}
.dg-hsql{font:12px/16px var(--mono);white-space:pre;overflow:hidden;text-overflow:ellipsis;color:var(--fg1)}
.dg-hmeta{font-size:12px;line-height:16px;color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dg-st{display:grid;flex:none;width:20px;color:var(--fg3)}
.dg-st-ok{color:var(--green)}
.dg-st-err{color:var(--red)}
.dg-hdel{margin-right:8px}
.dg-cell{max-height:min(60vh,520px);overflow:auto;flex:none}
.dg-file{display:flex;align-items:center;gap:12px;min-width:0}
.dg-file .ic{display:grid;place-items:center;width:40px;height:40px;border-radius:20px;background:var(--bg3);color:var(--fg3);flex:none}
.dg-file b{display:block;color:var(--fg1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dg-file span{font-size:12px;line-height:16px;color:var(--fg3)}
.dg-opts{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
.dg-csv-scroll{overflow:auto;max-height:320px;border:1px solid var(--s2);border-radius:4px;flex:none}
table.dg-csv{border-collapse:separate;border-spacing:0;font-size:12px;line-height:16px}
.dg-csv th{position:sticky;top:0;z-index:1;vertical-align:top;text-align:left;padding:6px;min-width:168px;background:var(--bg2);border-bottom:1px solid var(--s2);font-weight:400}
.dg-csv th .input{height:28px;padding:0 8px}
.dg-csv th select.sel{width:100%;max-width:none;height:28px;margin-top:4px}
.dg-csv td{padding:4px 8px;border-bottom:1px solid var(--s3);color:var(--fg1);white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis}
.dg-ps{display:flex;align-items:center;gap:4px;margin-top:4px;color:var(--fg3)}
.dg-ps .input{width:64px}
.dg-nulls{margin-top:4px;color:var(--fg3)}
.dg-fixed{display:flex;flex-direction:column;gap:4px;padding:4px 0}
.dg-fixed b{font:600 12px/16px var(--mono);color:var(--fg1)}
.dg-fixed span{color:var(--fg3)}
.dg-tbl td.dg-sentas{white-space:normal;min-width:160px;max-width:280px;color:var(--fg2)}
.dg-standing{display:flex;flex-direction:column;gap:12px;padding:12px 16px;border:1px solid var(--s2);border-radius:4px;background:var(--bg2);flex:none}
.dg-standing .chk{white-space:normal;align-items:flex-start;color:var(--fg1);font-weight:600}
.dg-standing .chk input{margin-top:2px}
.dg-standing .chk[aria-disabled=true]{color:var(--fg3);cursor:default}
.dg-standing-fields{display:flex;flex-direction:column;gap:12px;padding-left:24px}
.dg-standing-fields .input{max-width:240px}
.dg-moreopts{flex:none}
.dg-optgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px 16px;margin-top:12px}
.dg-optgrid .dg-field .input{max-width:none}
.dg-optgrid .sel{max-width:none;width:100%}
.dg-optrow{display:flex;align-items:center;gap:8px;min-width:0}
.dg-optrow .input{width:112px;flex:none}
.dg-optrow .input.dg-char{width:48px}
.dg-font{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.dg-font .sel{width:240px;max-width:none}
.dg-font .input{width:240px}
.dg-readas{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
@container ss-panel (width < 720px){.dg-help,.dg-split{grid-template-columns:minmax(0,1fr)}.dg-help-side .dg-nav,.dg-split>.dg-nav{flex-direction:row;overflow-x:auto}.dg-tpl-body{grid-template-columns:minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){.dg-card{transition:none}}`;

// ----------------------------------------------------------------------------------------------------- the dialogs

const UTC_TZ = Object.freeze({ utc: true, offset: () => 0 });
const LOCAL_TZ = Object.freeze({ utc: false, offset: ms => -new Date(ms).getTimezoneOffset() });
const HIST_ROW = 64, CARD_ROW = 80;
const MIT = `MIT License

Copyright (c) the SQL Studio authors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const SQL4CDS_URL = 'https://markcarrington.dev/sql-4-cds/';

let idSeq = 0;
const nextId = p => `${p}-${++idSeq}`;

// A code-point chip for an invisible or bidi character (03 §8: `.ed-inv` styled as `.dg-inv`): its text is the code
// point, so the character can neither hide nor reorder the text around it.
const invChip = label => h('span', { class: 'ed-inv dg-inv', title: label, text: label });

// Highlighted nodes of a text: SQL through editor.js highlightSql (the editor's spans per token and invisible-character
// markers, 03 §1.4; opts isTable(name, qualifier) for t-tbl and quotedIdentifier false for `"…"` as a string),
// JSON (.k .s .n .b), XML or plain text ('text'); plain text above 500,000 characters. `invisible` turns invisible and
// bidi characters into code-point chips (03 §5, §8); without it SQL keeps the editor's markers.
export function highlightNodes(text, kind = 'sql', { invisible = false, isTable = null, quotedIdentifier = true } = {}) {
  const s = String(text ?? '');
  const out = [];
  const textNodes = t => {
    if (!invisible || !INVISIBLE_RE.test(t)) return [t];
    return invisiblePieces(t).map(p => (p.inv ? invChip(p.inv) : p.text));
  };
  const add = (cls, t) => {
    if (!t) return;
    const nodes = textNodes(t);
    if (cls) out.push(h('span', { class: cls }, nodes));
    else out.push(...nodes);
  };
  if (s.length > BIG_TEXT || (kind !== 'sql' && kind !== 'json' && kind !== 'xml')) { add('', s); return out; }
  if (kind === 'json') { for (const p of jsonPieces(s)) add(p.cls, p.text); return out; }
  if (kind === 'xml') { for (const p of xmlPieces(s)) add(p.cls, p.text); return out; }
  const frag = highlightSql(s, { isTable: typeof isTable === 'function' ? isTable : null, quotedIdentifier: quotedIdentifier !== false });
  for (const n of [...frag.childNodes]) {
    // The editor marks each invisible character as its own span (title = its code point).
    if (invisible && n.nodeType === 1 && n.classList?.contains('ed-inv')) out.push(invChip(n.getAttribute('title') || codePoint(n.textContent)));
    else out.push(n);
  }
  return out;
}

const codePoint = ch => 'U+' + (String(ch).codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');

const META_TABLE_NAMES = new Set(META_TABLES.map(t => t.name.toLowerCase()));

// 03 §5's t-tbl rule (as the editor applies it) as highlightSql's isTable(name, qualifier): `metadata.<name>` for the
// nine META_TABLES; any other name when findEntity() knows it by its exact logical name, unqualified or under
// archive., bin. or dbo.
export function sqlTableRule(findEntity) {
  return (name, qual) => {
    const n = String(name ?? '').toLowerCase();
    if (qual != null) {
      const q = String(qual).toLowerCase();
      if (q === 'metadata') return META_TABLE_NAMES.has(n);
      if (q !== 'archive' && q !== 'bin' && q !== 'dbo') return false;
    }
    if (typeof findEntity !== 'function') return false;
    let e = null;
    try { e = findEntity(name); } catch { e = null; }
    return !!e && lower(e.logicalName) === n;
  };
}

let current = null;
function need() {
  if (!current) throw new Error('initDialogs() has not run yet.');
  return current;
}

// Sets up the dialogs and their commands (03 §1.4; see the notes above); returns the Dialogs object.
export function initDialogs(opts = {}) {
  const { api = null, writeCaps = null, meta = null, shell, results = null, editor = null } = opts;
  if (!shell || typeof shell.dialog !== 'function') throw new TypeError('initDialogs(): a shell with dialog() is required.');
  const S = opts.state && typeof opts.state.on === 'function' ? opts.state : stateModule;
  const st = () => S.state;
  const keymap = Array.isArray(opts.keymap) ? opts.keymap : KEYMAP;
  const mac = typeof opts.mac === 'boolean' ? opts.mac : isMacPlatform();
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const later = typeof opts.later === 'function' ? opts.later : (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };
  // Each io call looks its function up when it runs, so an io double can be changed after initDialogs.
  const IO_DEFAULTS = { saveFile: utilSaveFile, openFile: utilOpenFile, copyText: utilCopyText, download: utilDownload, openUrl: utilOpenUrl, navigateToView: utilNavigateToView };
  const io = Object.freeze(Object.fromEntries(Object.keys(IO_DEFAULTS).map(k => [k, (...a) => {
    const o = isObj(opts.io) && typeof opts.io[k] === 'function' ? opts.io : IO_DEFAULTS;
    return o[k](...a);
  }])));
  const loc = () => opts.location ?? globalThis.location;
  const settings = () => S.getSettings();
  const tz = () => (typeof opts.tz === 'function' ? opts.tz() : settings().tz === 'utc' ? UTC_TZ : LOCAL_TZ);
  // ERROR_HINTS (results.js, 03 §7) and HINT_DOCS (complete.js) feed Help › Troubleshooting and Query hints; both are
  // read when Help is built (see the notes above for who passes ERROR_HINTS).
  const errorHintsOf = () => {
    for (const v of [opts.errorHints, results?.ERROR_HINTS]) if (Array.isArray(v) && v.length) return v;
    return null;
  };
  const hintDocs = Array.isArray(opts.hints) ? opts.hints : HINT_DOCS;
  const fetchToSql = typeof opts.fetchToSql === 'function' ? opts.fetchToSql : null;
  // the build id (1.0.0+mvbdt8vr) tells which favorite is installed: every build has its own
  const version = opts.version ?? (typeof __BUILD__ !== 'undefined' ? __BUILD__ : typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev');
  const uuid = typeof opts.uuid === 'function' ? opts.uuid : () => globalThis.crypto.randomUUID();
  const pending = new Set();
  const offs = [];
  const toast = (text, o) => shell.toast?.(text, o);
  const announce = text => shell.announce?.(text);
  const titleOfTab = id => S.state.tabs.find(t => t.id === id)?.title ?? '';
  const runLock = () => { const r = st().running; return r ? runLockTitle(titleOfTab(r.tabId)) : null; };
  const activeSession = () => st().sessions?.get?.(st().activeTab) ?? null;
  const known = meta && typeof meta.findEntity === 'function' ? name => !!meta.findEntity(name) : undefined;

  // ---- small DOM helpers ---------------------------------------------------------------------------------------
  const btnOf = (handle, id) => handle?.el?.querySelector?.(`[data-action="${id}"]`) ?? null;
  const setLabel = (handle, id, text) => { const l = btnOf(handle, id)?.querySelector?.('.lbl'); if (l) l.textContent = text; };
  const setTitle = (handle, id, text) => { const b = btnOf(handle, id); if (!b) return; if (text) b.setAttribute('title', text); else b.removeAttribute('title'); };
  const note = (level, text) => h('div', { class: level === 'danger' ? 'note' : level === 'info' ? 'note info' : 'note amb', role: level === 'danger' ? 'alert' : null },
    icon(level === 'info' ? 'info' : 'warn', 16), h('span', null, inline(text)));
  function inline(text) {
    return splitInline(text).map(p => {
      if (p.t === 'text') return p.v;
      if (p.t === 'code') return h('code', { text: p.v });
      const alts = keyStrokes(p.v, { keymap, mac });
      if (!alts.length) return h('span', { class: 'quiet', text: 'no shortcut' });
      const nodes = [];
      alts.forEach((strokes, i) => {
        if (i) nodes.push(' or ');
        strokes.forEach((k, j) => { if (j) nodes.push(' '); nodes.push(h('kbd', { text: k })); });
      });
      return h('span', { class: 'dg-keys' }, nodes);
    });
  }
  // Highlighted SQL marks the tables meta knows (t-tbl, 03 §5); o.quotedIdentifier false classes `"…"` as a string.
  const sqlIsTable = sqlTableRule(meta && typeof meta.findEntity === 'function' ? n => meta.findEntity(n) : null);
  const codeNodes = (text, kind, o = {}) => highlightNodes(text, kind, kind === 'sql' ? { ...o, isTable: sqlIsTable } : o);
  const codeBlock = (text, kind = 'sql', o = {}) => h('pre', { class: 'code' + (o.cls ? ' ' + o.cls : ''), tabindex: '0', 'aria-label': o.label ?? null }, codeNodes(text, kind, o));
  // The QUOTED_IDENTIFIER mode of a query tab: its session's opts, else the setting new tabs start with.
  const quotedIdOf = tabId => {
    const s = st().sessions?.get?.(tabId ?? st().activeTab);
    const v = s?.opts?.quotedIdentifier;
    return typeof v === 'boolean' ? v : settings().quotedIdentifiers !== false;
  };
  const kvList = rows => h('div', { class: 'kv' }, rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => [h('span', { class: 'lb', text: k }), h('span', { class: 'val', text: v })]));
  const badgeOf = env => { const b = envBadge(env); return h('span', { class: 'badge' + (b.cls ? ' ' + b.cls : ''), title: b.title }, h('span', { text: b.text })); };
  const textField = ({ label, value = '', maxlength, placeholder, type = 'text', describedBy, autocomplete = 'off' }) => {
    const id = nextId('dg-f');
    const input = h('input', { id, type, value, maxlength: maxlength ?? null, placeholder: placeholder ?? null, autocomplete, spellcheck: 'false', 'aria-describedby': describedBy ?? null });
    return { input, node: h('div', { class: 'dg-field' }, h('label', { for: id }, label), h('div', { class: 'input' }, input)) };
  };
  // Focus moves to the editor after a dialog or sheet opened a new query tab (the caret is where the tab put it).
  const focusEditor = () => { try { editor?.focus?.(); } catch { /* an editor without focus() */ } };
  const focusTab = tabId => { if (tabId != null && st().activeTab !== tabId && S.getTab?.(tabId)) S.setActiveTab(tabId); };
  // A confirmation (change, impersonation) is waiting: `attention {kind: 'confirm'}` while any is open, then
  // `attention {kind: null}` (03 §2; the pill and main.js's destroy() read it).
  const attention = () => { try { S.emit?.('attention', { kind: pending.size ? 'confirm' : null }); } catch { /* a listener failed; the dialog still opens */ } };
  const watch = (entry, signal) => {
    pending.add(entry);
    if (pending.size === 1) attention();
    const done = () => { if (pending.delete(entry) && !pending.size) attention(); };
    if (!signal) return done;
    const onAbort = () => entry.cancel();
    if (signal.aborted) later(onAbort, 0); else signal.addEventListener?.('abort', onAbort, { once: true });
    return () => { done(); signal.removeEventListener?.('abort', onAbort); };
  };
  // Calls fn once the dialog is on screen: at once when it is, else on its first focusin (the shell shows a dialog
  // that waited behind the minimised or hidden window by focusing it, 03 §8 'Waiting confirmations').
  const whenShown = (handle, fn) => {
    const el = handle?.el;
    if (!el || el.open !== false || typeof el.addEventListener !== 'function') { fn(); return; }
    let ran = false;
    const go = () => { if (ran) return; ran = true; el.removeEventListener('focusin', go); fn(); };
    el.addEventListener('focusin', go);
  };

  // A yes/no question as a dialog (the typed text, when given, must match): resolves true for OK. OK counts only for a
  // trusted event (a real click or key), with or without typed text: page scripts can reach the open shadow root, and
  // these questions relax safety settings (00 §5 rule 3) or delete local data.
  function ask({ title, body, ok = 'OK', danger = false, typed = null }) {
    return new Promise(resolve => {
      let yes = false;
      const parts = (Array.isArray(body) ? body : [body]).filter(Boolean).map(b => (typeof b === 'string' ? h('p', null, inline(b)) : b));
      let field = null;
      if (typed) {
        const hintId = nextId('dg-h');
        field = textField({ label: h('span', null, 'Type ', h('b', { text: typed }), ' to confirm'), describedBy: hintId });
        parts.push(field.node, h('p', { id: hintId, class: 'dg-msg', text: `${ok} turns on when the text matches.` }));
      }
      const handle = shell.dialog({
        title, body: h('div', { class: 'dg-stack' }, parts),
        actions: [{ id: 'ok', label: ok, kind: danger ? 'danger' : 'primary', disabled: !!typed, focus: !danger && !typed }, { id: 'cancel', label: 'Cancel', focus: danger && !typed }],
        onAction: (id, e) => {
          if (id !== 'ok') return true;
          if (e?.isTrusted !== true) return false;
          if (typed && !typedMatches(field.input.value, typed)) return false;
          yes = true;
          return true;
        },
        onClose: () => resolve(yes),
      });
      field?.input.addEventListener('input', () => handle.setDisabled('ok', !typedMatches(field.input.value, typed)));
    });
  }

  // Settles what session.executeAs / revert return: a RunHandle (through results.attachQuiet when present), a promise
  // or nothing: {ok, error, cancelled}.
  async function settle(r, tabId, label) {
    try {
      if (r && typeof r.on === 'function' && r.done && typeof r.done.then === 'function') {
        let doneEv = null;
        r.on('done', d => { doneEv = d; });
        const q = typeof results?.attachQuiet === 'function' ? await results.attachQuiet(tabId, r, { label }) : null;
        const d = await r.done;
        const out = isObj(d) ? d : doneEv ?? (q ? { ok: !!q.ok } : { ok: true });
        return { ok: out.ok !== false, error: out.error ?? null, cancelled: !!out.cancelled };
      }
      if (r && typeof r.then === 'function') await r;
      return { ok: true, error: null, cancelled: false };
    } catch (e) {
      return { ok: false, error: e, cancelled: false };
    }
  }

  // ---- change confirmation (03 §8; 02 §8.2, §8.3) -----------------------------------------------------------------
  function optionLabel(v, col) {
    const a = col?.attr;
    if (!a || typeof meta?.optionsSync !== 'function' || !/^(Picklist|State|Status|Boolean)$/.test(a.type ?? '')) return undefined;
    const list = meta.optionsSync(a.entity, a.logicalName);
    const o = Array.isArray(list) ? list.find(x => x.value === v || (typeof v === 'boolean' && x.value === (v ? 1 : 0))) : null;
    return o?.label;
  }
  // The user's date and time formats while Settings › Results › Local date formats is on (03 §7 Cells), as the
  // grid shows them; lcid gives the month names and AM/PM designators of the user's language.
  const dateFormatOf = () => {
    const u = settings().localDates === true ? meta?.user : null;
    return u ? { date: u.dateFormat, time: u.timeFormat, ...(Number.isInteger(u.lcid) ? { lcid: u.lcid } : {}) } : null;
  };
  // One formatted value (03 §1.1 formatCell); its icon ('warn' for an unsafe bigint, 'link' for a lookup id) is drawn
  // before the text. A title that formatCell builds on demand (the full hex of a binary value) is read only when the
  // pointer first rests on the value, so opening the dialog never builds it for every sample cell.
  const cellNode = (v, col, dateFormat = dateFormatOf()) => {
    const f = formatCell(v, col, { friendly: settings().friendly, tz: tz(), label: optionLabel, dateFormat });
    const lazyTitle = typeof Object.getOwnPropertyDescriptor(f, 'title')?.get === 'function';
    const el = h('span', { class: f.cls ? 'fc-' + f.cls : null, title: lazyTitle ? null : f.title ?? null }, f.icon ? icon(f.icon, 12) : null, f.text);
    if (lazyTitle) el.addEventListener('pointerenter', () => { const t = f.title; if (t) el.setAttribute('title', t); }, { once: true });
    return el;
  };
  // The 'before' value of a secured column is NULL or masked when read, so the preview says `(secured)` (02 §8.1 6b).
  const securedNode = () => h('span', { class: 'quiet', title: 'This column is protected by field security; its current value cannot be read.', text: '(secured)' });
  const beforeNode = (v, col, df) => (col?.attr?.isSecured === true ? securedNode() : cellNode(v, col, df));

  function previewTableNode(t) {
    const rows = (t.sample ?? []).slice(0, 500);
    const cols = Array.isArray(t.columns) ? t.columns : [];
    const showCols = t.op === 'update' || t.op === 'insert';
    const head = ['Name', 'ID', ...(showCols ? cols.map(c => c.displayName || c.name) : []), ...(t.op === 'associate' || t.op === 'disassociate' ? ['Related ID'] : []),
      ...(t.sentAs ? ['Sent as'] : [])];
    const df = dateFormatOf();   // one object per table, so formatCell compiles the user's patterns once
    const body = rows.map(r => {
      const tds = [h('td', { text: r?.name ?? '', title: r?.name ?? null }), h('td', null, r?.id ? h('span', { class: 'fc-guid', text: String(r.id) }) : h('span', { class: 'quiet', text: 'new' }))];
      if (showCols) {
        cols.forEach((c, i) => {
          const before = Array.isArray(r?.before) ? r.before : [], after = Array.isArray(r?.after) ? r.after : [];
          if (t.op === 'insert') { tds.push(h('td', null, cellNode(after[i] ?? null, c, df))); return; }
          if (i >= after.length || after[i] === undefined) { tds.push(h('td', { class: 'quiet' }, i < before.length ? beforeNode(before[i], c, df) : '')); return; }
          tds.push(h('td', null, h('span', { class: 'dg-old' }, beforeNode(before[i] ?? null, c, df)), h('span', { class: 'dg-arrow', 'aria-hidden': 'true', text: '→' }),
            h('span', { class: 'sr', text: ' changes to ' }), h('span', { class: 'dg-new' }, cellNode(after[i], c, df))));
        });
      }
      if (t.op === 'associate' || t.op === 'disassociate') tds.push(h('td', null, h('span', { class: 'fc-guid', text: String(r?.after?.[0] ?? '') })));
      // The record's requests when they differ per record (03 §8): 'PATCH + WinOpportunity', 'AddMemberList', …
      if (t.sentAs) tds.push(h('td', { class: 'dg-sentas', text: typeof r?.sentAs === 'string' ? r.sentAs : '' }));
      return h('tr', null, tds);
    });
    return [
      t.title ? h('h4', { class: 'dg-part', text: t.title }) : null,
      h('div', { class: 'dg-scroll', tabindex: '0', role: 'region', 'aria-label': t.title ?? 'Records' },
        h('table', { class: 'dg-tbl' }, h('thead', null, h('tr', null, head.map(x => h('th', { scope: 'col', text: x })))), h('tbody', null, body))),
      t.total > rows.length ? h('p', { class: 'dg-more', text: `Showing ${fmtInt(rows.length)} of ${plural(t.total, 'record')}.` }) : null,
    ];
  }

  // ---- standing approvals (03 §8, 02 §8.3, 00 §5 rule 2) ----------------------------------------------------
  // dialogs.js alone holds the approvals (statement key -> record) and grants from them; state.standing is only their
  // mirror for the pill, written through state.setStanding / endStanding and never read back here, so a record put
  // into the app state by anything else never lets an execution through.
  const approvals = new Map();
  const snapshotOf = a => Object.freeze({ key: a.key, runId: a.runId, op: a.op, table: a.table, cap: a.cap, total: a.total,
    dangerKinds: Object.freeze([...a.dangerKinds]), callerId: null, environment: a.environment, usedAt: a.usedAt });
  const mirror = () => S.setStanding([...approvals.values()].map(snapshotOf));

  // Ends the approvals `which` selects: they leave the private list first (nothing can grant from them any more), then
  // the mirror; 'Standing approval ended.' is announced unless the pill ended them (it announces its own text, 03 §3).
  // {all: true} (every approval ends) also empties a mirror that holds records this module never gave, so the pill
  // always returns to the mode state. Returns how many ended.
  function endApprovals(which, reason, { all = false } = {}) {
    const ended = [...approvals.values()].filter(which);
    for (const a of ended) approvals.delete(a.key);
    let mirrored = 0;
    try {
      if (all || (ended.length && !approvals.size)) mirrored = (typeof S.endStanding === 'function' ? S.endStanding() : []).length;
      else if (ended.length) mirror();
    } catch (e) { toast(e?.message || String(e), { kind: 'error' }); }
    const n = Math.max(ended.length, mirrored);
    if (n && reason !== 'pill') announce(STANDING_ENDED_TEXT);
    return n;
  }

  // Ends every standing approval (03 §1.4; reason 'pill', 'stop', 'cancel', 'run', 'caller', 'mode', …); returns how
  // many ended.
  function endStandingApprovals(reason = 'ended') {
    return endApprovals(() => true, String(reason ?? 'ended'), { all: true });
  }

  // The active standing approvals as frozen copies of the 03 §1.4 Standing records.
  function standingApprovals() {
    return [...approvals.values()].map(snapshotOf);
  }

  // Approvals end at every caller change and whenever changes turn off or expire; an event that only moves the expiry
  // (after each write) keeps them (02 §8.3). The bus events are main.js's mirror of api.onModeChange; the api
  // subscription itself is used too, so neither path alone has to be wired.
  offs.push(S.on('impersonate', () => { endStandingApprovals('caller'); }));
  offs.push(S.on('changes:mode', p => { if (p?.allowed !== true) endStandingApprovals('mode'); }));
  if (typeof api?.onModeChange === 'function') {
    const off = api.onModeChange(m => { if (m?.allowed !== true || (m?.caller ?? null) != null) endStandingApprovals('mode'); });
    if (typeof off === 'function') offs.push(off);
  }

  // A later execution under a standing approval (02 §8.3): its own grant for exactly its own grantSpec, without a
  // dialog, when standingRefusal finds nothing; otherwise the approval ends and the normal dialog opens (null).
  function grantFromStanding(preview) {
    const a = nonEmpty(preview.statementKey) ? approvals.get(preview.statementKey) : undefined;
    if (!a) return null;
    // The count and the spec are read once: what is checked is what is granted and counted.
    const count = changeCount(preview);
    const spec = preview.grantSpec;
    const why = standingRefusal(a, preview, { allowed: api?.mode?.()?.allowed === true, caller: api?.caller?.() ?? null, count });
    if (why != null || spec !== preview.grantSpec) { endApprovals(x => x === a, why ?? 'spec'); return null; }
    let grant;
    try {
      grant = writeCaps.createGrant(spec);
    } catch (err) {
      endApprovals(x => x === a, 'refused');
      return { error: err instanceof Error ? err : new Error(String(err)) };
    }
    a.total += count;
    a.usedAt = now();
    try { mirror(); } catch (e) { toast(e?.message || String(e), { kind: 'error' }); }
    return { result: { grant, backup: null, standing: true } };
  }

  // The approval record a confirmed dialog gives (03 §8), built before the grant is minted: null when the preview no
  // longer gives what the record needs (the click is then refused).
  function approvalRecord(preview, spec, cap, env) {
    const kinds = kindsOf(preview), count = changeCount(preview);
    // N stays within this execution's count .. settings.maxChangeRows as read at the click (03 §8).
    const maxRows = settings().maxChangeRows;
    const max = Math.max(count, Number.isSafeInteger(maxRows) ? maxRows : 5000);
    if (!kinds || !nonEmpty(preview.statementKey) || !nonEmpty(preview.runId) || !Number.isSafeInteger(cap) || count < 1 || count > cap || cap > max) return null;
    return { key: preview.statementKey, runId: preview.runId, op: preview.op, table: tableOf(preview), cap, total: count,
      dangerKinds: [...kinds], callerId: null, environment: envTypedName(env, loc()), usedAt: now(),
      // Private: the request kinds and option headers of the confirmed spec, which later executions may not exceed.
      opKinds: opKinds(spec), headers: headerKey(spec) };
  }
  // Keeps an approval; it replaces an earlier one of the same statement key. When the mirror refuses it, no approval is
  // kept (the pill must show every approval) and the user is told.
  function giveApproval(a) {
    approvals.set(a.key, a);
    try {
      mirror();
    } catch (e) {
      approvals.delete(a.key);
      try { mirror(); } catch { /* the private list is what counts */ }
      toast(`The standing approval was not given: ${e?.message || e} Later executions ask again.`, { kind: 'error' });
    }
  }

  // The standing-approval part of a change dialog (03 §8): the checkbox and, while it is ticked, 'Up to N records in
  // total', 'Type <N> to approve later executions' and, in Production, the environment name. Returns {node, ok(),
  // ticked(), cap(), refresh()}, or null when the approval is not offered.
  function standingPart(preview, onChange, backupBlocks) {
    if (!standingOffer(preview, { caller: api?.caller?.() ?? null }).offered) return null;
    const count = changeCount(preview);
    // The largest N: settings.maxChangeRows as it is now (it may be lowered while the dialog is open), at least the
    // count of this execution.
    const maxNow = () => { const m = settings().maxChangeRows; return Math.max(count, Number.isSafeInteger(m) ? m : 5000); };
    let max = maxNow();
    let cap = standingDefaultCap(count, settings().maxChangeRows), capOk = true, typedOk = false, envOk = true, ticked = false;
    const isProd = e => !e || e.isProduction !== false || e.checking === true || e.error === true;
    const prod = isProd(preview.environment) || isProd(st().env);
    const envName = envTypedName(preview.environment?.name ? preview.environment : st().env, loc());
    const chk = h('input', { type: 'checkbox' });
    const labelText = h('span', { text: standingLabel(cap, preview.op) });
    const label = h('label', { class: 'chk' }, chk, labelText);
    const capErrId = nextId('dg-ce');
    const capInput = h('input', { type: 'number', min: String(count), max: String(max), step: '1', inputmode: 'numeric', value: String(cap),
      'aria-label': 'Up to how many records in total', 'aria-describedby': capErrId });
    const capErr = h('p', { class: 'dg-err', id: capErrId, hidden: true, text: `Enter a whole number from ${fmtInt(count)} to ${fmtInt(max)}.` });
    const nText = h('b', { text: fmtInt(cap) });
    const typed = textField({ label: h('span', null, 'Type ', nText, ' to approve later executions') });
    typed.input.setAttribute('inputmode', 'numeric');
    const env = prod ? textField({ label: h('span', null, 'Type the environment name ', h('b', { text: envName }), ' to approve later executions') }) : null;
    const fields = h('div', { class: 'dg-standing-fields', hidden: true },
      h('div', { class: 'dg-optrow' }, h('span', { text: 'Up to' }), h('span', { class: 'input' }, capInput), h('span', { text: 'records in total' })), capErr,
      typed.node, env?.node ?? null);
    const node = h('div', { class: 'dg-standing', role: 'group', 'aria-label': 'Standing approval' }, label, fields);
    const check = () => {
      typedOk = capOk && parseCount(typed.input.value) === cap;
      envOk = !env || typedMatches(env.input.value, envName);
    };
    chk.addEventListener('change', () => { ticked = !!chk.checked && !chk.disabled; fields.hidden = !ticked; onChange(); });
    // Reads N from its input against the current range; an N out of range is marked and keeps Confirm disabled.
    const validateCap = () => {
      max = maxNow();
      capInput.setAttribute('max', String(max));
      capErr.textContent = `Enter a whole number from ${fmtInt(count)} to ${fmtInt(max)}.`;
      const v = parseCount(capInput.value);
      capOk = v != null && v >= count && v <= max;
      if (capOk) cap = v;
      capErr.hidden = capOk;
      if (capOk) capInput.removeAttribute('aria-invalid'); else capInput.setAttribute('aria-invalid', 'true');
      labelText.textContent = standingLabel(cap, preview.op);
      nText.textContent = fmtInt(cap);
      check();
    };
    capInput.addEventListener('input', () => { validateCap(); onChange(); });
    typed.input.addEventListener('input', () => { check(); onChange(); });
    env?.input.addEventListener('input', () => { check(); onChange(); });
    // The box goes away when the acting user changes while the dialog is open, and the checkbox is off while a delete
    // backup is to be saved first (later executions open no dialog to save theirs in); N is checked again against
    // maxChangeRows.
    const refresh = () => {
      if (!standingOffer(preview, { caller: api?.caller?.() ?? null }).offered) {
        node.hidden = true; chk.checked = false; ticked = false; fields.hidden = true;
        return;
      }
      validateCap();
      const blocked = backupBlocks();
      chk.disabled = blocked;
      if (blocked) {
        chk.checked = false; ticked = false; fields.hidden = true;
        label.setAttribute('title', STANDING_BACKUP_TITLE);
        label.setAttribute('aria-disabled', 'true');
      } else { label.removeAttribute('title'); label.removeAttribute('aria-disabled'); }
    };
    refresh();
    return {
      node, refresh, cap: () => cap,
      ticked: () => ticked && !node.hidden,
      ok: () => !ticked || node.hidden || (capOk && cap <= maxNow() && typedOk && envOk),
    };
  }

  function confirmChange(preview, opt) {
    const o = isObj(opt) ? opt : {};
    if (!isObj(preview)) return Promise.reject(new TypeError('confirmChange(): a ChangePreview is required.'));
    if (typeof writeCaps?.createGrant !== 'function') return Promise.reject(new Error('confirmChange(): writeCaps is not available.'));
    // A personal-view grant is accepted while read-only (02 §8.3), so only Save as personal view mints one; dml.js never
    // puts personalView on a ChangePreview (see the notes above).
    if (isObj(preview.grantSpec) && preview.grantSpec.personalView) {
      return Promise.reject(new TypeError('confirmChange(): a change preview cannot carry a personal-view grant spec.'));
    }
    // One run at a time app-wide: approvals of another run are stale (its runEnded never came), so they end.
    if (nonEmpty(preview.runId)) endApprovals(a => a.runId !== preview.runId, 'run');
    // An already aborted signal is a Cancel: nothing is granted, not even from a standing approval.
    if (o.signal?.aborted === true) { endStandingApprovals('cancel'); return Promise.resolve(null); }
    const fromStanding = grantFromStanding(preview);
    if (fromStanding?.error) return Promise.reject(fromStanding.error);
    if (fromStanding?.result) return Promise.resolve(fromStanding.result);
    focusTab(o.tabId);
    return new Promise((resolve, reject) => {
      let result = null, failure = null, timeOk = false, backupSaved = false, shownAt = null;
      const shownSpec = preview.grantSpec;
      const required = requiredText(preview);
      let typedOk = required == null;
      const backup = preview.op === 'delete' && isObj(preview.backup) ? preview.backup : null;
      let backupFirst = !!backup;
      const before = (preview.op === 'update' || preview.op === 'mixed') && changeCount(preview) > 100 && isObj(preview.beforeAfter) ? preview.beforeAfter : null;
      const kids = [];
      if (preview.op === 'mixed') { const mc = mixedCounts(preview); if (mc) kids.push(h('p', { class: 'dg-counts', text: mc })); }
      for (const n of changeNotes(preview, { backupBeforeDelete: settings().backupBeforeDelete === true })) kids.push(note(n.level, n.text));
      kids.push(h('dl', { class: 'dg-facts' }, changeFacts(preview, { batchSize: settings().batchSize }).map(([k, v]) => h('div', null, h('dt', { text: k }), h('dd', { text: v })))));
      for (const t of previewTables(preview)) kids.push(...previewTableNode(t).filter(Boolean));
      if (preview.op === 'action') {
        const params = Array.isArray(preview.actionParams) ? preview.actionParams : [];
        kids.push(params.length
          ? h('div', { class: 'dg-scroll' }, h('table', { class: 'dg-tbl' }, h('thead', null, h('tr', null, ['Parameter', 'Type', 'Value'].map(x => h('th', { scope: 'col', text: x })))),
            h('tbody', null, params.map(p => h('tr', null, h('td', { text: p.name ?? '' }), h('td', { text: p.type ?? '' }), h('td', { text: paramText(p.value, tz()) }))))))
          : h('p', { class: 'dg-msg', text: 'This action has no parameters.' }));
      }
      const afterShown = [];
      if (preview.statementText) {
        const mixed = preview.op === 'mixed';
        const text = String(preview.statementText);
        const codeOpts = { invisible: true, cls: 'dg-code', label: mixed ? 'Equivalent SQL' : 'Statement', quotedIdentifier: quotedIdOf(o.tabId) };
        // A grid change set's equivalent SQL (closed) and a statement above LAZY_HIGHLIGHT characters are highlighted
        // when first opened, after the dialog is on screen (03 §13); until then they are plain text with the
        // invisible characters marked.
        const lazy = mixed || text.length > LAZY_HIGHLIGHT;
        const pre = codeBlock(text, lazy ? 'text' : 'sql', codeOpts);
        const details = h('details', { open: mixed ? null : '' },
          h('summary', null, icon('chevron', 12), mixed ? 'Equivalent SQL (for information; it is not run)' : preview.dynamic === true ? 'Dynamic statement' : 'Statement'), pre);
        // The grid's generated SQL can be copied or kept in a query tab (added without switching tabs; it changes nothing).
        if (mixed) {
          details.append(h('div', { class: 'dg-ex-bar' },
            h('button', { class: 'btn subtle', type: 'button', onclick: () => Promise.resolve(io.copyText(text)).then(ok => toast(ok ? 'Copied the SQL.' : 'Could not copy to the clipboard.', { kind: ok ? 'ok' : 'error' })) },
              icon('copy', 20), h('span', { class: 'lbl', text: 'Copy SQL' })),
            h('button', { class: 'btn subtle', type: 'button', onclick: () => { S.createTab({ title: 'Grid changes', sql: text, caret: [text.length, text.length] }, { activate: false }); toast('Added the SQL as a new query tab, Grid changes.', { kind: 'ok' }); } },
              icon('open', 20), h('span', { class: 'lbl', text: 'Add as new tab' }))));
        }
        if (lazy) {
          let built = false;
          const build = () => {
            if (built || !details.hasAttribute('open')) return;
            built = true;
            setChildren(pre, codeNodes(text, 'sql', codeOpts));
          };
          details.addEventListener('toggle', build);
          afterShown.push(() => later(build, 0));
        }
        kids.push(details);
      }
      let sa = null, logWriting = false;
      let backupMsg = null;
      if (backup) {
        backupMsg = h('span', { class: 'dg-msg', role: 'status' });
        const chk = h('input', { type: 'checkbox', checked: true });
        const btn = h('button', { class: 'btn', type: 'button' }, icon('download', 20), h('span', { class: 'lbl', text: backupLabel(backup) }));
        chk.addEventListener('change', () => { backupFirst = !!chk.checked; btn.disabled = !backupFirst; sa?.refresh(); update(); });
        btn.addEventListener('click', () => {
          let p;
          try {
            p = io.saveFile(backup.fileName, () => new Blob([backup.text()], { type: 'application/json' }), { types: [{ description: 'JSON file', accept: { 'application/json': ['.json'] } }] });
          } catch (e) { backupMsg.className = 'dg-msg bad'; backupMsg.textContent = e?.message || String(e); return; }
          Promise.resolve(p).then(r => {
            const status = r?.status;
            if (status === 'saved' || status === 'downloaded') {
              backupSaved = true;
              backupMsg.className = 'dg-ok';
              setChildren(backupMsg, icon('check', 16), status === 'saved' ? 'Backup saved.' : 'Backup downloaded.');
            } else if (status === 'needsGesture') { backupMsg.className = 'dg-msg'; backupMsg.textContent = 'Select the button again to choose where to save the backup.'; }
            update();
          }, e => { backupMsg.className = 'dg-msg bad'; backupMsg.textContent = e?.message || String(e); });
        });
        kids.push(h('div', { class: 'dg-row2' }, h('label', { class: 'chk' }, chk, 'Download a backup first'), btn, backupMsg));
      }
      if (before) {
        const msg = h('span', { class: 'dg-msg', role: 'status' });
        const btn = h('button', { class: 'btn', type: 'button' }, icon('download', 20), h('span', { class: 'lbl', text: 'Download before/after log (JSON)' }));
        btn.addEventListener('click', () => {
          // The picker opens in the click; above 50,000 records the log is then built from its chunks with a yield
          // between them, and the danger action waits only while it is written (03 §8).
          const make = typeof before.chunks === 'function'
            ? () => {
              logWriting = true;
              update();
              return beforeAfterBlob(before, { onProgress: v => { msg.className = 'dg-msg'; msg.textContent = `Writing the before/after log… ${v}%`; } })
                .finally(() => { logWriting = false; update(); });
            }
            : () => new Blob([before.text()], { type: 'application/json' });
          let p;
          try {
            p = io.saveFile(before.fileName, make, { types: [{ description: 'JSON file', accept: { 'application/json': ['.json'] } }] });
          } catch (e) { msg.textContent = e?.message || String(e); return; }
          Promise.resolve(p).then(r => {
            if (r?.status === 'saved' || r?.status === 'downloaded') msg.textContent = r.status === 'saved' ? 'Log saved.' : 'Log downloaded.';
          }, e => { msg.textContent = e?.message || String(e); });
        });
        kids.push(h('div', { class: 'dg-row2' }, btn, msg, h('span', { class: 'dg-msg', text: 'Undo data is kept only until the page reloads.' })));
      }
      let typedInput = null;
      if (required != null) {
        const hintId = nextId('dg-h');
        const f = textField({ label: h('span', null, 'Type ', h('b', { text: required }), ' to confirm'), describedBy: hintId });
        typedInput = f.input;
        typedInput.addEventListener('input', () => { typedOk = typedMatches(typedInput.value, required); update(); });
        kids.push(f.node, h('p', { id: hintId, class: 'dg-msg', text: `${changeActionLabel(preview)} turns on when the text matches.` }));
      }
      // The standing approval for later executions of this statement (03 §8), after the dialog's own input.
      sa = standingPart(preview, () => update(), () => !!backup && backupFirst);
      if (sa) kids.push(sa.node);
      const env = preview.environment ?? st().env;
      const sub = h('span', { class: 'dg-sub' },
        preview.op === 'action' ? null : h('code', { text: tableOf(preview) }), badgeOf(env),
        preview.impersonating ? h('span', { class: 'pill amb' }, icon('user', 12), h('span', { text: `Acting as ${preview.impersonating}` })) : null,
        Number.isFinite(preview.execution) ? h('span', { text: `Execution ${fmtInt(preview.execution)} of this statement` }) : null,
        preview.dynamic === true ? h('span', { text: 'Dynamic SQL' }) : null);
      let closed = false;
      const handle = shell.dialog({
        title: changeTitle(preview), sub, size: 'l', body: h('div', { class: 'dg-stack' }, kids),
        actions: [{ id: 'ok', label: changeActionLabel(preview), kind: 'danger', disabled: true },
          { id: 'cancel', label: Number.isFinite(preview.execution) ? 'Cancel script' : 'Cancel', focus: true }],
        onAction(id, e) {
          if (id !== 'ok') return true;
          // One grant per dialog: nothing after it closed or after its Confirm already minted (or failed).
          if (closed || result || failure) return false;
          if (!e || e.isTrusted !== true) return false;
          if (shownAt == null || now() - shownAt < 600 || !typedOk || (backup && backupFirst && !backupSaved) || logWriting) return false;
          if (sa && !sa.ok()) return false;
          // The grant is for the spec of the preview the dialog shows: a preview whose grantSpec was replaced while the
          // dialog was open is refused (it closes and rejects, so the run ends; nothing is minted).
          const spec = shownSpec;
          if (preview.grantSpec !== spec) { failure = new Error(PREVIEW_CHANGED); return true; }
          // A standing approval is given only when it is still offered at the click (the acting user may have changed).
          let record = null;
          if (sa?.ticked()) {
            record = standingOffer(preview, { caller: api?.caller?.() ?? null }).offered ? approvalRecord(preview, spec, sa.cap(), env) : null;
            if (!record) { sa.refresh(); update(); return false; }
          }
          // A refused grant (`Blocked: …`, or a malformed spec) closes the dialog and rejects with that error, so the
          // run ends with it instead of a user cancel (00 §5 rule 9; 02 §9: TRY/CATCH never catches it).
          try {
            result = { grant: writeCaps.createGrant(spec), backup: backupSaved, standing: false };
          } catch (err) {
            failure = err instanceof Error ? err : new Error(String(err));
            return true;
          }
          if (record) giveApproval(record);
          return true;
        },
        onClose() {
          closed = true; stopTimer(); unwatch(); offImp(); offSettings();
          if (failure) { reject(failure); return; }
          // Cancel or Cancel script in any change dialog ends every standing approval (03 §8).
          if (!result) endStandingApprovals('cancel');
          resolve(result);
        },
      });
      function update() { if (!closed) handle.setDisabled('ok', !(timeOk && typedOk && (!backup || !backupFirst || backupSaved) && !logWriting && (!sa || sa.ok()))); }
      const offImp = S.on('impersonate', () => { sa?.refresh(); update(); });
      // A lowered maxChangeRows narrows N while the dialog is open (03 §8: N is at most maxChangeRows).
      const offSettings = S.on('settings', p => { if (!Array.isArray(p?.keys) || p.keys.includes('maxChangeRows')) { sa?.refresh(); update(); } });
      // The confirm button turns on 600 ms after the dialog is on screen (a dialog that waited behind the minimised
      // window counts from when it is shown).
      let stopTimer = () => {};
      whenShown(handle, () => { if (closed) return; shownAt = now(); stopTimer = later(() => { timeOk = true; update(); }, 600); for (const f of afterShown) f(); });
      const unwatch = watch({ tabId: o.tabId ?? null, cancel: () => { if (!closed) handle.close(); } }, o.signal);
    });
  }

  // ---- impersonation (03 §8; 02 §9) --------------------------------------------------------------------------------
  function confirmImpersonation(user, opt) {
    const o = isObj(opt) ? opt : {};
    // An already aborted signal is a Cancel: no dialog opens.
    if (o.signal?.aborted === true) return Promise.resolve(false);
    focusTab(o.tabId);
    const u = userSummary(user);
    return new Promise(resolve => {
      let yes = false, closed = false;
      const handle = shell.dialog({
        title: `Act as ${u.name ? quoteName(u.name) : 'another user'}?`,
        body: h('div', { class: 'dg-stack' },
          kvList([['Full name', u.name], ['Domain name', u.domain], ['Business unit', u.businessUnit], ['User id', u.id]]),
          note('warning', "Every request then runs with this user's permissions, in every query tab, until you revert. Changes are turned off whenever the acting user changes.")),
        actions: [{ id: 'ok', label: 'Act as this user', kind: 'primary' }, { id: 'cancel', label: 'Cancel', focus: true }],
        onAction(id, e) {
          if (id !== 'ok') return true;
          if (!e || e.isTrusted !== true) return false;
          yes = true;
          return true;
        },
        onClose() { closed = true; unwatch(); resolve(yes); },
      });
      const unwatch = watch({ tabId: o.tabId ?? null, cancel: () => { if (!closed) handle.close(); } }, o.signal);
    });
  }

  // ---- Read-only mode (03 §3) ------------------------------------------------------------------------------------------
  // Changes are allowed from the start (app.js) and stay allowed; the mode pill switches to read-only and back with one
  // click. Every write still opens its preview (confirmChange).
  function allowChanges() {
    if (api?.mode?.()?.allowed) return Promise.resolve(true);
    if (typeof writeCaps?.setReadOnly !== 'function') return Promise.reject(new Error('allowChanges(): writeCaps is not available.'));
    writeCaps.setReadOnly(false, { idleMs: null });
    toast('Changes are allowed again. Every write still opens a preview that you confirm.', { kind: 'info' });
    return Promise.resolve(true);
  }

  function toggleChanges() {
    if (api?.mode?.()?.allowed) {
      writeCaps?.setReadOnly?.(true);
      toast('Read-only: INSERT, UPDATE, DELETE, EXEC and grid edits are refused until you select the pill again.', { kind: 'info' });
      return Promise.resolve(false);
    }
    return allowChanges();
  }

  // ---- Execute as (03 §8) ---------------------------------------------------------------------------------------------
  function executeAs() {
    if (st().running) { toast('Not available while a query is running.', { kind: 'warn' }); return Promise.resolve(false); }
    return new Promise(resolve => {
      let picked = false, closed = false, token = 0, selected = -1, users = [], prefixOnly = false, searchCtrl = null;
      const listId = nextId('dg-users');
      const statusEl = h('div', { class: 'dg-status', role: 'status', text: 'Type at least 2 characters of a name or user name.' });
      const list = h('div', { class: 'dg-users', id: listId, role: 'listbox', 'aria-label': 'Users' }, statusEl);
      const modeNote = h('p', { class: 'dg-msg', hidden: true, text: 'Dataverse refused a search inside names, so the picker lists users whose name or user name starts with the text.' });
      const search = h('input', { type: 'search', placeholder: 'Search users by name or user name', 'aria-label': 'Search users', autocomplete: 'off', spellcheck: 'false',
        role: 'combobox', 'aria-controls': listId, 'aria-expanded': 'false', 'aria-autocomplete': 'list' });
      const imp = st().impersonating ?? api?.caller?.() ?? null;
      const body = h('div', { class: 'dg-stack' },
        note('warning', "Requests then run with the chosen user's permissions, in every query tab, until you revert. Changes are turned off whenever the acting user changes."),
        imp ? h('p', null, 'You are acting as ', h('b', { text: imp.name || imp.id }), '. Revert makes you act as yourself again.') : null,
        h('label', { class: 'input' }, icon('search', 16), search), modeNote, list);
      const actions = [{ id: 'ok', label: 'Act as this user', kind: 'primary', disabled: true }];
      if (imp) actions.push({ id: 'revert', label: 'Revert' });
      actions.push({ id: 'cancel', label: 'Cancel' });
      const handle = shell.dialog({
        title: 'Execute as', body, actions,
        onAction(id) {
          if (id === 'cancel') return true;
          if (st().running) { toast('Not available while a query is running.', { kind: 'warn' }); return false; }
          // The picker closes only when the revert worked (revertCaller resolves false after a refusal or an error).
          if (id === 'revert') return revertCaller();
          const u = users[selected];
          if (!u) return false;
          return actAs(u);
        },
        onClose() { closed = true; run.cancel(); searchCtrl?.abort(); resolve(picked); },
      });
      const render = () => {
        if (!users.length) { setChildren(list, statusEl); search.setAttribute('aria-expanded', 'false'); search.removeAttribute('aria-activedescendant'); }
        else {
          setChildren(list, users.map((u, i) => h('div', {
            class: 'dg-user', role: 'option', id: `${listId}-${i}`, 'aria-selected': String(i === selected),
            onclick: () => { selected = i; render(); },
            ondblclick: () => { selected = i; render(); btnOf(handle, 'ok')?.click(); },
          }, h('span', { class: 'nm', text: u.fullname || u.domainname || u.id }), h('span', { class: 'un', text: [u.domainname, u.businessunitidname].filter(Boolean).join(' · ') }))));
          search.setAttribute('aria-expanded', 'true');
          if (selected >= 0) search.setAttribute('aria-activedescendant', `${listId}-${selected}`); else search.removeAttribute('aria-activedescendant');
        }
        handle.setDisabled('ok', selected < 0);
      };
      // One search request: the typed text stays out of the URL when 'Send queries in the request body' is on (00 §5
      // rule 6); a newer search or closing the picker aborts it.
      const find = (q, prefix, signal) => {
        const set = meta?.findEntity?.('systemuser')?.entitySetName ?? 'systemusers';
        return api.fetchXml(set, userSearchXml(q, 50, { prefix }), { signal, inBody: settings().queryInBody === true });
      };
      const run = debounce(async () => {
        const q = search.value.trim();
        const my = ++token;
        searchCtrl?.abort();
        searchCtrl = null;
        users = []; selected = -1;
        if (q.length < 2) { statusEl.textContent = 'Type at least 2 characters of a name or user name.'; render(); return; }
        statusEl.textContent = 'Searching…';
        render();
        const ctrl = searchCtrl = new AbortController();
        try {
          let json;
          try {
            json = await find(q, prefixOnly, ctrl.signal);
          } catch (e) {
            // Dataverse may refuse the leading wildcard of the contains search: search by prefix from then on.
            if (prefixOnly || !LEADING_WILDCARD_CODES.includes(lower(e?.code)) || my !== token || closed) throw e;
            prefixOnly = true;
            modeNote.hidden = false;
            json = await find(q, true, ctrl.signal);
          }
          if (my !== token || closed) return;
          users = (Array.isArray(json?.value) ? json.value : []).map(userFromRow).filter(u => isGuid(u.id));
          selected = users.length ? 0 : -1;
          statusEl.textContent = users.length ? '' : prefixOnly ? `No enabled user's name or user name starts with ${quoteName(q)}.` : `No enabled users match ${quoteName(q)}.`;
        } catch (e) {
          if (my !== token || closed) return;
          statusEl.textContent = e?.message || String(e);
        } finally {
          if (searchCtrl === ctrl) searchCtrl = null;
        }
        render();
      }, 250);
      search.addEventListener('input', () => run());
      search.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (!users.length) return;
          e.preventDefault();
          selected = Math.max(0, Math.min(users.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)));
          render();
          list.querySelector?.(`[aria-selected="true"]`)?.scrollIntoView?.({ block: 'nearest' });
        } else if (e.key === 'Enter' && selected >= 0) {
          e.preventDefault();
          btnOf(handle, 'ok')?.click();
        }
      });
      async function actAs(u) {
        const tabId = st().activeTab;
        const session = activeSession();
        if (typeof session?.executeAs !== 'function') throw new Error('Execute as is not available in this query tab.');
        const r = await settle(session.executeAs(u.id), tabId, `Execute as ${u.fullname || u.domainname}`);
        if (closed) return true;
        // The picker closes only when the chosen user is now the acting one; a cancelled confirmation keeps the list.
        const caller = actingUser();
        if (r.ok && caller && lower(caller.id) === lower(u.id)) {
          picked = true;
          toast(`You are acting as ${quoteName(u.fullname || u.domainname)}. Changes are turned off.`, { kind: 'info' });
          return true;
        }
        if (r.cancelled && !r.error) return false;
        statusEl.textContent = r.error ? r.error.message || String(r.error) : 'The acting user did not change.';
        users = []; selected = -1; render();
        return false;
      }
    });
  }

  // The acting user: api.caller() (02 §1) when there is an api, else the app-state mirror (03 §2).
  function actingUser() {
    return api && typeof api.caller === 'function' ? api.caller() ?? null : st().impersonating ?? null;
  }

  // Revert (03 §8): runs session.revert() like Execute as runs executeAs; resolves true only when the user was
  // reverted (the run succeeded and nobody is acting any more).
  async function revertCaller() {
    const was = api?.caller?.() ?? st().impersonating;
    if (!was) return false;
    if (st().running) { toast('Not available while a query is running.', { kind: 'warn' }); return false; }
    const session = activeSession();
    if (typeof session?.revert !== 'function') { toast('Revert is not available in this query tab.', { kind: 'error' }); return false; }
    const r = await settle(session.revert(), st().activeTab, 'Revert');
    if (r.error) { toast(r.error.message || String(r.error), { kind: 'error' }); return false; }
    if (r.cancelled) return false;
    const still = actingUser();
    if (!r.ok || still) {
      toast(still ? `You still act as ${quoteName(still.name || still.id)}.` : 'Revert did not finish.', { kind: 'warn' });
      return false;
    }
    toast(`You no longer act as ${quoteName(was.name || was.id)}. Changes are turned off.`, { kind: 'info' });
    return true;
  }

  // ---- Settings and About (03 §8, §8.1, §13) ---------------------------------------------------------------------------
  let settingsOpen = null, lastSettings = 'appearance';
  function openSettings(section) {
    const want = SETTINGS_UI.some(s => s.id === section) ? section : lastSettings;
    if (settingsOpen) { settingsOpen.show(want); return settingsOpen.handle; }
    const nav = h('nav', { class: 'dg-nav', 'aria-label': 'Settings sections' });
    const pane = h('div', { class: 'dg-pane', role: 'region' });
    const body = h('div', { class: 'dg-split dg-set' }, nav, pane);
    let cur = want;
    const navBtns = new Map();
    // Controls of the shown section by setting key; a settings change updates them in place, so the control the
    // user just used keeps its focus (re-rendering it would drop focus out of the dialog).
    const syncs = new Map();
    for (const s of SETTINGS_UI) {
      const b = h('button', { type: 'button', text: s.title, onclick: () => show(s.id) });
      navBtns.set(s.id, b);
      nav.append(b);
    }
    function show(id) {
      cur = lastSettings = id;
      for (const [k, b] of navBtns) { if (k === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
      const sec = SETTINGS_UI.find(s => s.id === id);
      const titleId = nextId('dg-st');
      pane.setAttribute('aria-labelledby', titleId);
      syncs.clear();
      const rows = id === 'about' ? [aboutNode()] : sec.items.map(item => {
        const r = settingRow(item);
        if (r.sync) syncs.set(item.key, r.sync);
        return r.node;
      });
      setChildren(pane, h('h2', { id: titleId, tabindex: '-1', text: sec.title }), rows);
    }
    const sync = keys => { for (const [k, f] of syncs) if (!Array.isArray(keys) || keys.includes(k)) f(); };
    const handle = shell.dialog({
      title: 'Settings', body, size: 'l', actions: [{ id: 'cancel', label: 'Close' }],
      onClose() { off(); settingsOpen = null; },
    });
    const off = S.on('settings', p => sync(p?.keys));
    settingsOpen = { handle, sync, show: id => { show(id); pane.querySelector?.('h2')?.focus?.(); } };
    show(cur);
    return handle;
  }

  // One row of a Settings section: {node, sync?} (sync() shows the current value of its setting).
  function settingRow(item) {
    const labelId = nextId('dg-sl'), hintId = nextId('dg-sh');
    if (item.action) {
      const b = h('button', { class: 'btn' + (item.action === 'clearHistory' ? ' danger-o' : ''), type: 'button', 'aria-describedby': hintId }, h('span', { class: 'lbl', text: item.label }));
      b.addEventListener('click', () => runSettingAction(item.action, b));
      return { node: h('div', { class: 'dg-srow' }, h('div', { class: 'main' }, h('span', { class: 'lb', id: labelId, text: item.label }), h('span', { class: 'hint', id: hintId, text: item.hint })), h('div', { class: 'ctl' }, b)) };
    }
    const key = item.key;
    const spec = S.SETTINGS?.[key];
    const v = settings()[key];
    let ctl, err = null, setValue = () => {};
    if (spec?.type === 'bool') {
      ctl = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(!!v), 'aria-labelledby': labelId, 'aria-describedby': hintId,
        onclick: () => changeSetting(key, !settings()[key]) }, h('i'));
      setValue = x => ctl.setAttribute('aria-checked', String(!!x));
    } else if (spec?.type === 'enum') {
      const opts = item.options ?? spec.values.map(x => ({ value: x, label: x }));
      const btns = opts.map(o => h('button', { type: 'button', 'aria-pressed': String(v === o.value), text: o.label, onclick: () => changeSetting(key, o.value) }));
      ctl = h('div', { class: 'seg', role: 'group', 'aria-labelledby': labelId }, btns);
      setValue = x => btns.forEach((b, i) => b.setAttribute('aria-pressed', String(opts[i].value === x)));
    } else if (spec?.type === 'int') {
      err = h('p', { class: 'dg-err', role: 'alert', hidden: true });
      const input = h('input', { type: 'number', min: String(spec.min), max: String(spec.max), step: '1', inputmode: 'numeric', value: String(v), 'aria-labelledby': labelId, 'aria-describedby': hintId });
      input.addEventListener('change', () => {
        const r = parseIntSetting(input.value, spec);
        if (r.error) { input.setAttribute('aria-invalid', 'true'); err.textContent = r.error; err.hidden = false; return; }
        input.removeAttribute('aria-invalid');
        err.hidden = true;
        changeSetting(key, r.value);
      });
      ctl = h('div', { class: 'input dg-num' }, input);
      setValue = x => { input.value = String(x); input.removeAttribute('aria-invalid'); err.hidden = true; };
    } else if (key === 'editorFont' && spec?.type === 'string') {
      const f = fontControl(labelId, hintId);
      ctl = f.node; err = f.err; setValue = f.setValue;
    } else {
      ctl = h('span', { class: 'quiet', text: String(v) });
      setValue = x => { ctl.textContent = String(x); };
    }
    const range = spec?.type === 'int' ? ` From ${fmtInt(spec.min)} to ${fmtInt(spec.max)}.` : '';
    const keys = item.keys ? inline(` Shortcut: \`key:${item.keys}\`.`) : null;
    const tag = h('span', { class: 'tag', text: 'This session only' });
    const showTag = x => { tag.hidden = !(spec?.session || S.isRelaxing?.(key, x)); };
    showTag(v);
    const node = h('div', { class: 'dg-srow' },
      h('div', { class: 'main' }, h('span', { class: 'lb', id: labelId }, item.label, tag), h('span', { class: 'hint', id: hintId }, item.hint + range, keys), err),
      h('div', { class: 'ctl' }, ctl));
    return { node, sync: () => { const x = settings()[key]; setValue(x); showTag(x); } };
  }

  // Editor › Font (03 §8, §5): a select of the default stack and its monospaced fonts plus 'Custom…' with a text
  // input (committed on change). A value that is not a font-family list, or a custom family that does not render
  // monospaced, is refused with a note and the previous value stays. The preset fonts need no check: each is
  // monospaced, and a missing one falls back to monospace. {node, err, setValue}.
  const measure = typeof opts.measureText === 'function' ? opts.measureText : domMeasureText;
  function fontControl(labelId, hintId) {
    const err = h('p', { class: 'dg-err', role: 'alert', hidden: true });
    const sel = h('select', { class: 'sel', 'aria-labelledby': labelId, 'aria-describedby': hintId },
      FONT_CHOICES.map(c => h('option', { value: c.value, text: c.label })), h('option', { value: 'custom', text: 'Custom…' }));
    const input = h('input', { type: 'text', maxlength: '200', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Custom editor font', placeholder: '"JetBrains Mono", Consolas' });
    const box = h('div', { class: 'input', hidden: true }, input);
    const say = msg => {
      err.textContent = msg ?? '';
      err.hidden = !msg;
      if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    };
    // Shows the setting's value: a preset in the select, else 'Custom…' with the value in the input.
    const setValue = v => {
      const c = fontChoice(v);
      if (c === 'custom') input.value = v;
      sel.value = c;
      box.hidden = c !== 'custom';
    };
    // True when the family renders monospaced; when it cannot be measured here, the check is skipped.
    const mono = family => { try { return isMonospaced(family, measure, settings().fontSize); } catch { return true; } };
    const apply = (value, check) => {
      if (!S.SETTINGS.editorFont.pattern.test(value)) { say(FONT_INVALID); return; }
      if (check && !mono(value)) { say(FONT_NOT_MONO); return; }
      try { S.setSetting('editorFont', value); } catch { say(FONT_INVALID); return; }
      say(null);
    };
    sel.addEventListener('change', () => {
      if (sel.value === 'custom') {
        box.hidden = false;
        if (fontChoice(settings().editorFont) !== 'custom') input.value = '';
        input.focus?.();
        return;
      }
      box.hidden = true;
      say(null);
      apply(sel.value, false);
    });
    input.addEventListener('change', () => { if (input.value.trim()) apply(input.value.trim(), true); });
    setValue(settings().editorFont);
    return { node: h('div', { class: 'dg-font' }, sel, box), err, setValue };
  }

  // Sets one setting; a safety-relaxing value needs the 00 §5 rule 3 confirmation (environment name typed in
  // Production) and is then set for this session only. Resolves true when the value was set.
  async function changeSetting(key, value) {
    const restore = () => settingsOpen?.sync([key]);
    try {
      if (S.isRelaxing?.(key, value)) {
        const env = st().env;
        if (envBadge(env).checking) {
          toast('Checking the environment… Try again when its type is known.', { kind: 'warn' });
          restore();
          return false;
        }
        const p = relaxPrompt(key, value);
        const ok = await ask({ title: p.title, body: [p.body, SESSION_ONLY], ok: p.ok, danger: true, typed: env?.isProduction !== false ? envTypedName(env, loc()) : null });
        if (!ok) { restore(); return false; }
        S.setSetting(key, value, { confirmed: true });
      } else S.setSetting(key, value);
      restore();
      return true;
    } catch (e) {
      toast(e?.message || String(e), { kind: 'error' });
      restore();
      return false;
    }
  }

  async function runSettingAction(action, b) {
    if (action === 'clearHistory') {
      const ok = await ask({ title: 'Clear history?', ok: 'Clear history', danger: true,
        body: 'This deletes the query history of this environment and the saved tabs from this browser, so they are not restored after a reload. Your open tabs stay open.' });
      if (!ok) return;
      S.clearHistory();
      toast('History cleared.', { kind: 'ok' });
    } else if (action === 'clearMetadata') {
      if (typeof meta?.refresh !== 'function') { toast('The metadata cache is not available.', { kind: 'error' }); return; }
      b.disabled = true;
      const l = b.querySelector?.('.lbl');
      if (l) l.textContent = 'Clearing…';
      try {
        await meta.refresh();
        toast('Metadata cache cleared; the table list was reloaded.', { kind: 'ok' });
      } catch (e) {
        toast(e?.message || String(e), { kind: 'error' });
      } finally {
        b.disabled = false;
        if (l) l.textContent = 'Clear metadata cache';
      }
    } else if (action === 'resetLayout') {
      S.resetLayout();
      toast('Layout reset.', { kind: 'ok' });
    }
  }

  function startupMs() {
    if (typeof opts.startupMs === 'function') return opts.startupMs();
    const p = globalThis.performance;
    if (typeof p?.getEntriesByName !== 'function') return null;
    const m = p.getEntriesByName('sqlstudio:load', 'measure');
    if (m.length) return m[m.length - 1].duration;
    const a = p.getEntriesByName('sqlstudio:decompressed', 'mark'), z = p.getEntriesByName('sqlstudio:usable', 'mark');
    return a.length && z.length ? z[z.length - 1].startTime - a[a.length - 1].startTime : null;
  }

  function aboutNode() {
    const link = (label, run) => h('button', { class: 'link', type: 'button', text: label, onclick: run });
    return h('div', { class: 'dg-about' },
      h('div', { class: 'dg-brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, icon('db', 16)),
        h('div', null, h('b', { text: 'SQL Studio' }), h('span', { class: 'quiet', text: `Version ${version}` }))),
      h('p', { text: startupText(startupMs()) }),
      h('p', { text: 'A SQL editor for Dataverse and Dynamics 365 model-driven apps, running in this browser tab with your signed-in session. It sends requests only to the Web API of this environment.' }),
      h('div', { class: 'dg-links' },
        link('Getting started', () => openHelp('start')), link('Keyboard shortcuts', () => openHelp('keys')), link('Safety model', () => openHelp('safety')),
        h('button', { class: 'link', type: 'button', title: `${SQL4CDS_URL} (opens in a new tab)`, onclick: () => io.openUrl(SQL4CDS_URL), text: 'SQL 4 CDS, whose SQL dialect SQL Studio follows' })),
      h('h3', { class: 'dg-part', text: 'Licence' }),
      h('p', { text: 'SQL Studio bundles no third-party libraries. It is released under the MIT License:' }),
      h('pre', { class: 'dg-licence', tabindex: '0', text: MIT }));
  }

  // ---- Help (03 §8.2) -----------------------------------------------------------------------------------------------
  let help = null, lastHelp = 'start';

  function buildHelp() {
    // target: {sid, anchor} of the entry the shown section targets (F1, a Help link), or null.
    const state = { sections: helpSections({ messages: null, keymap, mac, hints: hintDocs, errorHints: errorHintsOf() }), built: new Map(), current: null, handle: null, messages: null, pendingAnchor: null, target: null };
    const search = h('input', { type: 'search', placeholder: 'Search help', 'aria-label': 'Search help', autocomplete: 'off', spellcheck: 'false' });
    const nav = h('nav', { class: 'dg-nav', 'aria-label': 'Help sections' });
    const main = h('div', { class: 'dg-help-main', role: 'region', 'aria-live': null });
    const navBtns = new Map();
    for (const s of state.sections) {
      const b = h('button', { type: 'button', text: s.title, onclick: () => { search.value = ''; showHelp(s.id); } });
      navBtns.set(s.id, b);
      nav.append(b);
    }
    state.root = h('div', { class: 'dg-help' }, h('div', { class: 'dg-help-side' }, h('label', { class: 'input' }, icon('search', 16), search), nav), main);
    state.main = main; state.nav = navBtns; state.search = search;
    const doSearch = debounce(() => {
      const q = search.value.trim();
      if (!q) { showHelp(state.current ?? lastHelp); return; }
      const hits = searchHelp(state.sections, q);
      const titleId = nextId('dg-ht');
      main.setAttribute('aria-labelledby', titleId);
      for (const b of navBtns.values()) b.removeAttribute('aria-current');
      setChildren(main, h('h2', { id: titleId, tabindex: '-1', text: 'Search' }),
        h('p', { role: 'status', text: hits.length ? `${plural(hits.length, 'section')} ${hits.length === 1 ? 'matches' : 'match'} ${quoteName(q)}.` : `Nothing in Help matches ${quoteName(q)}.` }),
        hits.length ? h('ul', { class: 'dg-results' }, hits.map(r => h('li', null, h('button', { class: 'dg-res', type: 'button', onclick: () => { search.value = ''; showHelp(r.id, null, q); } },
          h('b', { text: r.title }), h('span', null, r.snippet.before, h('mark', { text: r.snippet.hit }), r.snippet.after))))) : null);
    }, 120);
    search.addEventListener('input', () => doSearch());
    if (typeof meta?.messages === 'function') {
      Promise.resolve().then(() => meta.messages()).then(m => setMessages(m), e => setMessages(e instanceof Error ? e : new Error(String(e))));
    }
    // The Web API messages arrived: Functions is built again with them. Shown, it keeps its scroll position, its
    // filter text, the entry it targets (F1 on a built-in function) and the focus (the filter, an entry, or else the
    // section heading, so focus never falls out of Help); an anchor that F1 asked for while they were loading (a Web
    // API function or action, see the notes above) is targeted and focused now, while the dialog is still open.
    function setMessages(m) {
      if (!help) return;
      help.messages = m;
      help.sections = helpSections({ messages: m, keymap, mac, hints: hintDocs, errorHints: errorHintsOf() });
      const pend = help.pendingAnchor;
      help.pendingAnchor = null;
      const old = help.built.get('functions');
      if (!old) return;
      help.built.delete('functions');
      if (help.current !== 'functions' || help.search.value.trim()) return;
      const shown = help.target?.sid === 'functions' ? help.target.anchor : null;
      const filter = old.querySelector?.('input[type=search]') ?? null;
      const text = filter?.value ?? '';
      const active = focusedIn(old);
      const focusInside = active != null && active !== old && typeof old.contains === 'function' && old.contains(active);
      const focusAnchor = focusInside && active !== filter ? active.closest?.('[data-anchor]')?.getAttribute('data-anchor') ?? null : null;
      if (showHelp('functions', help.handle ? pend : null, null, { keepScroll: true })) return;
      const node = help.built.get('functions');
      const next = node?.querySelector?.('input[type=search]') ?? null;
      if (next && text) { next.value = text; next.dispatchEvent?.(new globalThis.Event('input', { bubbles: true })); }
      // The entry that was the target stays the target; nothing scrolls (the scroll position was kept).
      const find = a => (a == null ? null : [...(node?.querySelectorAll?.('[data-anchor]') ?? [])].find(el => anchorMatches(el.getAttribute('data-anchor'), a)) ?? null);
      const target = find(shown);
      if (target) { target.classList.add('dg-target'); help.target = { sid: 'functions', anchor: shown }; }
      if (!focusInside) return;
      const shownEl = el => { for (let n = el; n && n !== node; n = n.parentNode) if (n.hidden) return false; return !!el; };
      const again = active === filter ? next : focusAnchor == null ? null : [...(node?.querySelectorAll?.('[data-anchor]') ?? [])].find(el => el.getAttribute('data-anchor') === focusAnchor) ?? null;
      (shownEl(again) ? again : node?.querySelector?.('h2'))?.focus?.({ preventScroll: true });
    }
    return state;
  }

  // The focused element of the tree `el` is in (its shadow root's, else the document's).
  function focusedIn(el) {
    const r = el?.getRootNode?.();
    return (r && r.activeElement) || globalThis.document?.activeElement || null;
  }

  function sectionNode(id) {
    let node = help.built.get(id);
    if (node) return node;
    const sec = help.sections.find(s => s.id === id);
    const titleId = nextId('dg-hs');
    node = h('section', { 'aria-labelledby': titleId });
    node.append(h('h2', { id: titleId, tabindex: '-1', text: sec.title }));
    if (id === 'functions') node.append(...functionsNode(sec));
    else node.append(...sec.blocks.map(blockNode));
    if (id === 'templates') node.append(galleryNode());
    help.built.set(id, node);
    return node;
  }

  function blockNode(b) {
    switch (b[0]) {
      case 'h3': return h('h3', null, inline(b[1]));
      case 'p': return h('p', null, inline(b[1]));
      case 'note': return h('div', { class: 'note info' }, icon('info', 16), h('span', null, inline(b[1])));
      case 'ul': return h('ul', null, b[1].map(t => h('li', null, inline(t))));
      case 'table': {
        const anchors = b[3]?.anchors ?? null;
        return h('div', { class: 'dg-ht', tabindex: '0', role: 'region', 'aria-label': b[1].map(x => inlineText(x)).join(', ') },
          h('table', { class: 'lt' }, h('thead', null, h('tr', null, b[1].map(x => h('th', { scope: 'col' }, inline(x))))),
            h('tbody', null, b[2].map((r, i) => h('tr', { 'data-anchor': anchors?.[i]?.length ? anchorList(anchors[i]) : null, tabindex: anchors?.[i]?.length ? '-1' : null }, r.map(c => h('td', null, inline(c))))))));
      }
      case 'sql': return exampleNode(b[1]);
      case 'fn': return fnNode(b[1]);
      case 'msg': return msgNode(b[1]);
      default: return null;
    }
  }

  function exampleNode(sql) {
    return h('div', { class: 'dg-ex' }, codeBlock(sql, 'sql', { label: 'Example' }),
      h('div', { class: 'dg-ex-bar' }, h('button', { class: 'btn subtle', type: 'button', onclick: () => openSqlTab('Help example', sql) }, icon('open', 20), h('span', { class: 'lbl', text: 'Open in new tab' }))));
  }

  function fnNode(d) {
    return h('div', { class: 'dg-fn', 'data-anchor': d.name.toUpperCase(), 'data-key': foldText(`${d.name} ${d.summary}`), tabindex: '-1' },
      h('h4', { text: d.display }), h('p', { text: d.summary }),
      d.params?.length ? h('dl', { class: 'dg-params' }, d.params.map(p => [h('dt', { text: p.optional ? `[${p.name}]` : p.name }), h('dd', { text: p.desc })])) : null);
  }

  function msgNode(m) {
    const params = Array.isArray(m.params) ? m.params : [];
    const resp = Array.isArray(m.response) ? m.response : [];
    return h('div', { class: 'dg-wapi', 'data-anchor': String(m.name).toUpperCase(), 'data-key': foldText(`${m.name} ${m.description ?? ''}`), tabindex: '-1' },
      h('h4', { text: m.kind === 'function' ? `${m.name}(${params.map(p => (p.optional ? `[${p.name}]` : p.name)).join(', ')})` : `EXEC ${m.name}` }),
      h('p', null, m.description || 'No description.', m.boundTo ? h('span', { class: 'tag', text: `Bound to ${m.boundTo}` }) : null, m.isCustom ? h('span', { class: 'tag', text: 'Custom API' }) : null),
      params.length ? h('dl', { class: 'dg-params' }, params.map(p => [h('dt', { text: `${p.name}${p.type ? ' ' + p.type : ''}${p.optional ? ' (optional)' : ''}` }), h('dd', { text: p.description || '' })])) : null,
      resp.length ? h('p', { class: 'dg-msg', text: `Returns ${resp.map(r => `${r.name}${r.type ? ' (' + r.type + ')' : ''}`).join(', ')}.` }) : null);
  }

  function functionsNode(sec) {
    const filter = h('input', { type: 'search', placeholder: 'Filter functions', 'aria-label': 'Filter functions', autocomplete: 'off', spellcheck: 'false' });
    const count = h('span', { class: 'dg-msg', role: 'status' });
    const out = [];
    const groups = [];
    let group = null;
    for (const b of sec.blocks) {
      if (b[0] === 'h3') { group = h('div', { class: 'dg-cat' }, blockNode(b)); groups.push(group); out.push(group); continue; }
      const n = blockNode(b);
      if (group && (b[0] === 'fn' || b[0] === 'msg' || b[0] === 'p' || b[0] === 'note')) group.append(n);
      else out.push(n);
    }
    const apply = () => {
      const q = foldText(filter.value).trim();
      const words = q.split(/\s+/).filter(Boolean);
      let shown = 0, total = 0;
      for (const g of groups) {
        let any = false;
        for (const e of g.querySelectorAll('[data-key]')) {
          total++;
          const ok = words.every(w => e.getAttribute('data-key').includes(w));
          e.hidden = !ok;
          if (ok) { any = true; shown++; }
        }
        g.hidden = !!words.length && !any;
      }
      count.textContent = words.length ? `${fmtInt(shown)} of ${fmtInt(total)}` : `${plural(total, 'entry', 'entries')}`;
    };
    filter.addEventListener('input', apply);
    const bar = h('div', { class: 'dg-filter' }, h('label', { class: 'input' }, icon('filter', 16), filter), count);
    const head = out.filter(n => !groups.includes(n));
    const rest = out.filter(n => groups.includes(n));
    apply();
    return [...head, bar, ...rest];
  }

  function showHelp(id, anchor = null, query = null, { keepScroll = false } = {}) {
    const sid = helpSectionId(id) ?? 'start';
    const scroll = help.main.scrollTop;
    help.current = lastHelp = sid;
    const node = sectionNode(sid);
    for (const [k, b] of help.nav) { if (k === sid) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
    help.main.setAttribute('aria-labelledby', node.getAttribute('aria-labelledby'));
    setChildren(help.main, node);
    if (sid === 'templates') renderGallery();
    for (const t of node.querySelectorAll?.('.dg-target') ?? []) t.classList.remove('dg-target');
    let target = null;
    if (anchor != null) {
      for (const el of node.querySelectorAll('[data-anchor]')) {
        if (anchorMatches(el.getAttribute('data-anchor'), anchor)) { target = el; break; }
      }
    }
    // F1 on a Web API function or action before meta.messages() has answered: Functions targets it when they arrive.
    help.pendingAnchor = !target && anchor != null && sid === 'functions' && help.messages == null && typeof meta?.messages === 'function' ? anchor : null;
    help.target = target ? { sid, anchor } : null;
    if (target) {
      if (target.hidden) for (const f of node.querySelectorAll('input[type=search]')) { f.value = ''; f.dispatchEvent?.(new globalThis.Event('input', { bubbles: true })); }
      target.classList.add('dg-target');
      target.scrollIntoView?.({ block: 'start' });
      target.focus?.();
    } else {
      help.main.scrollTop = keepScroll ? scroll : 0;
      if (query == null) node.querySelector('h2')?.setAttribute?.('autofocus', '');
    }
    return target;
  }

  function openHelp(section, anchor) {
    if (!help) help = buildHelp();
    const id = helpSectionId(section) ?? lastHelp;
    help.search.value = '';
    const target = showHelp(id, anchor ?? null);
    if (!help.handle) {
      help.handle = shell.dialog({ title: 'Help', body: help.root, size: 'xl', actions: [{ id: 'cancel', label: 'Close' }], onClose() { if (help) help.handle = null; } });
      // After the dialog's initial focus: the target as shown then (Functions may have been built again meanwhile).
      if (target) later(() => { if (help?.handle) help.main.querySelector?.('.dg-target')?.focus?.(); }, 0);
    } else if (!target) help.main.querySelector?.('h2')?.focus?.();
    return help.handle;
  }

  function openTemplates() { return openHelp('templates'); }

  // F1 (03 §8.2): in the editor with the caret on a function name, Functions at that function; else the last section.
  // opts.helpTarget (complete.js's controller helpTarget(), 03 §1.4) also knows the Web API functions and actions of
  // meta.messages(), which Help › Functions lists by name; functionAtCaret() covers the built-in functions without it.
  function openHelpFromKey(e) {
    const t = e?.target;
    const inEditor = typeof t?.closest !== 'function' || !!t.closest('[data-scope="editor"]');
    if (e && e.type === 'keydown' && inEditor && editor && typeof editor.getValue === 'function') {
      const ht = typeof opts.helpTarget === 'function' ? opts.helpTarget() : null;
      if (ht && typeof ht.anchor === 'string' && ht.anchor) return openHelp(ht.section ?? 'functions', ht.anchor);
      const sel = editor.getSelection?.();
      const name = functionAtCaret(editor.getValue(), sel?.end ?? sel?.start ?? 0);
      if (name) return openHelp('functions', name);
    }
    return openHelp();
  }

  // ---- template gallery (03 §8.3) -------------------------------------------------------------------------------------
  const gallery = { category: 'all', query: '', selectedId: TEMPLATES[0]?.id ?? null, list: null, view: null, items: [], render: null };

  function galleryNode() {
    const listId = nextId('dg-tl');
    const chips = h('div', { class: 'dg-chips', role: 'group', 'aria-label': 'Category' },
      TEMPLATE_CATEGORIES.map(([id, label]) => h('button', { class: 'fp dg-chip', type: 'button', 'data-cat': id, 'aria-pressed': String(id === gallery.category), text: label,
        onclick: () => { gallery.category = id; for (const c of chips.children) c.setAttribute('aria-pressed', String(c.getAttribute('data-cat') === id)); renderGallery(true); } })));
    const search = h('input', { type: 'search', placeholder: 'Search templates', 'aria-label': 'Search templates', autocomplete: 'off', spellcheck: 'false' });
    search.addEventListener('input', () => { gallery.query = search.value; renderGallery(true); });
    const spacer = h('div', { style: 'height:0px' });
    const list = h('div', { class: 'dg-vlist', id: listId, role: 'listbox', tabindex: '0', 'aria-label': 'Templates' }, spacer);
    const view = h('div', { class: 'dg-tpl-view' });
    const empty = h('div', { class: 'empty', hidden: true }, h('div', { class: 'ic' }, icon('search', 22)), h('b', { text: 'No templates match' }),
      h('span', { text: 'Try another word or category.' }),
      h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', text: 'Clear search', onclick: () => { search.value = ''; gallery.query = ''; gallery.category = 'all'; for (const c of chips.children) c.setAttribute('aria-pressed', String(c.getAttribute('data-cat') === 'all')); renderGallery(true); } })));
    Object.assign(gallery, { list, view, spacer, empty, search });
    list.addEventListener('scroll', () => renderRows());
    list.addEventListener('keydown', e => {
      const n = gallery.items.length;
      if (!n) return;
      let i = Math.max(0, gallery.items.findIndex(t => t.id === gallery.selectedId));
      const page = Math.max(1, Math.floor((list.clientHeight || CARD_ROW * 6) / CARD_ROW) - 1);
      if (e.key === 'ArrowDown') i = Math.min(n - 1, i + 1);
      else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = n - 1;
      else if (e.key === 'PageDown') i = Math.min(n - 1, i + page);
      else if (e.key === 'PageUp') i = Math.max(0, i - page);
      else if (e.key === 'Enter') { e.preventDefault(); openTemplate(gallery.items[i]); return; }
      else return;
      e.preventDefault();
      selectTemplate(gallery.items[i].id, true);
    });
    if (typeof globalThis.ResizeObserver === 'function') new globalThis.ResizeObserver(() => renderRows()).observe(list);
    return h('div', { class: 'dg-tpl' }, h('div', { class: 'dg-filter' }, h('label', { class: 'input' }, icon('search', 16), search), chips), empty,
      h('div', { class: 'dg-tpl-body' }, list, view));
  }

  function renderGallery(reset = false) {
    if (!gallery.list) return;
    gallery.items = filterTemplates(TEMPLATES, gallery);
    const has = gallery.items.length > 0;
    gallery.empty.hidden = has;
    gallery.list.parentNode.hidden = !has;
    if (!has) return;
    if (!gallery.items.some(t => t.id === gallery.selectedId)) gallery.selectedId = gallery.items[0].id;
    gallery.spacer.style.height = `${gallery.items.length * CARD_ROW}px`;
    if (reset) gallery.list.scrollTop = 0;
    selectTemplate(gallery.selectedId, true);
  }

  function renderRows() {
    const { list, items, spacer } = gallery;
    if (!list) return;
    const r = visibleRange(list.scrollTop || 0, list.clientHeight || 0, CARD_ROW, items.length);
    const listId = list.id;
    const nodes = [];
    for (let i = r.start; i < r.end; i++) {
      const t = items[i];
      const sel = t.id === gallery.selectedId;
      nodes.push(h('div', { class: 'dg-card', role: 'option', id: `${listId}-${t.id}`, 'aria-selected': String(sel), 'aria-setsize': String(items.length), 'aria-posinset': String(i + 1),
        style: `top:${i * CARD_ROW}px`, onclick: () => selectTemplate(t.id), ondblclick: () => openTemplate(t) },
      h('span', { class: 'nm', text: t.title }), h('span', { class: 'un', text: t.description }),
      h('span', { class: 'tags' }, t.tables.map(x => h('span', { class: 'tag', text: x })))));
    }
    setChildren(list, spacer, nodes);
    if (items.some(t => t.id === gallery.selectedId)) list.setAttribute('aria-activedescendant', `${listId}-${gallery.selectedId}`);
    else list.removeAttribute('aria-activedescendant');
  }

  function selectTemplate(id, reveal = false) {
    const { list, items, view } = gallery;
    const i = items.findIndex(t => t.id === id);
    if (i < 0) return;
    gallery.selectedId = id;
    if (reveal && list) {
      const top = i * CARD_ROW, ch = list.clientHeight || 0;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (ch && top + CARD_ROW > list.scrollTop + ch) list.scrollTop = top + CARD_ROW - ch;
    }
    renderRows();
    const t = items[i];
    const cat = TEMPLATE_CATEGORIES.find(([c]) => c === t.category)?.[1] ?? '';
    setChildren(view, h('h3', { text: t.title }), h('p', { text: t.description }),
      h('div', { class: 'tags' }, h('span', { class: 'tag', text: cat }), t.tables.map(x => h('span', { class: 'tag', text: x }))),
      codeBlock(t.sql, 'sql', { label: `SQL of ${t.title}` }),
      h('div', { class: 'dg-acts' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => openTemplate(t) }, icon('open', 20), h('span', { class: 'lbl', text: 'Open in new tab' })),
        h('button', { class: 'btn', type: 'button', disabled: typeof editor?.insert !== 'function', title: typeof editor?.insert === 'function' ? null : 'No editor is available.', onclick: () => insertTemplate(t) },
          icon('plus', 20), h('span', { class: 'lbl', text: 'Insert at caret' }))));
  }

  function openTemplate(t) {
    if (!t) return;
    S.createTab({ title: t.title, sql: t.sql, caret: templateCaret(t.sql) });
    help?.handle?.close();
    focusEditor();
    announce(`Opened the template ${quoteName(t.title)} in a new tab. It has not run.`);
  }

  function insertTemplate(t) {
    if (!t || typeof editor?.insert !== 'function') return;
    editor.insert(t.sql);
    help?.handle?.close();
    editor.focus?.();
  }

  function openSqlTab(title, sql, caret) {
    const tab = S.createTab({ title, sql, caret: caret ?? [sql.length, sql.length] });
    help?.handle?.close();
    focusEditor();
    return tab;
  }

  // ---- History (03 §8, §10) ----------------------------------------------------------------------------------------------
  let hist = null;
  function openHistory() {
    S.reloadHistory?.();
    if (hist) { hist.render(); return hist.sheet; }
    const search = h('input', { type: 'search', placeholder: 'Search history', 'aria-label': 'Search history', autocomplete: 'off', spellcheck: 'false' });
    const clearAll = h('button', { class: 'btn danger-o', type: 'button' }, icon('trash', 20), h('span', { class: 'lbl', text: 'Clear all' }));
    const spacer = h('div', { style: 'height:0px' });
    const list = h('div', { class: 'dg-hist', role: 'list', 'aria-label': 'Query history' });
    let items = [];
    const subText = () => {
      const all = st().history ?? [];
      return search.value.trim() ? `${fmtInt(items.length)} of ${plural(all.length, 'query', 'queries')}` : `${plural(all.length, 'query', 'queries')} · this environment`;
    };
    const render = () => {
      const all = Array.isArray(st().history) ? st().history : [];
      items = all.filter(e => matchesAll(e.sql, search.value));
      clearAll.disabled = !all.length;
      sheet.update?.({ sub: subText() });
      if (!items.length) {
        setChildren(list, h('div', { class: 'empty' }, h('div', { class: 'ic' }, icon('history', 22)),
          all.length ? h('b', { text: `No queries match ${quoteName(search.value.trim())}` }) : h('b', { text: 'No queries yet.' }),
          all.length ? h('span', { text: 'Try another word.' }) : h('span', { text: 'Queries you run appear here.' })));
        return;
      }
      spacer.style.height = `${items.length * HIST_ROW}px`;
      rows();
    };
    const rows = () => {
      if (!items.length) return;
      const r = visibleRange(list.scrollTop || 0, list.clientHeight || 0, HIST_ROW, items.length);
      const nodes = [];
      for (let i = r.start; i < r.end; i++) nodes.push(historyRow(items[i], i));
      setChildren(list, spacer, nodes);
    };
    const historyRow = (e, i) => {
      const lines = historyLines(e.sql);
      const meta2 = [fmtDate(new Date(e.at), tz()).slice(0, 16), e.ms != null ? fmtDuration(e.ms) : null, e.rows != null ? plural(e.rows, 'row') : null,
        e.status === 'error' ? 'Failed' : e.status === 'cancelled' ? 'Cancelled' : null].filter(Boolean).join(' · ');
      const st2 = e.status === 'ok' ? h('span', { class: 'dg-st dg-st-ok', role: 'img', 'aria-label': 'Succeeded' }, icon('okc', 20))
        : e.status === 'error' ? h('span', { class: 'dg-st dg-st-err', role: 'img', 'aria-label': 'Failed' }, icon('error', 20))
          : e.status === 'cancelled' ? h('span', { class: 'dg-st', role: 'img', 'aria-label': 'Cancelled' }, icon('stop', 20)) : h('span', { class: 'dg-st' });
      const open = h('button', { class: 'dg-hopen', type: 'button', 'data-i': String(i), title: 'Open in a new tab',
        onclick: () => { S.createTab({ sql: e.sql, caret: [e.sql.length, e.sql.length] }); hist?.sheet?.close?.(); focusEditor(); },
        onkeydown: ev => {
          if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); focusRow(i + (ev.key === 'ArrowDown' ? 1 : -1)); }
          else if (ev.key === 'Delete') { ev.preventDefault(); removeEntry(e, i); }
        } },
      st2, h('span', { class: 'dg-htext' }, lines.map(l => h('span', { class: 'dg-hsql', text: l })), h('span', { class: 'dg-hmeta', text: meta2 })));
      const del = h('button', { class: 'btn subtle icon dg-hdel', type: 'button', title: 'Delete from history', 'aria-label': 'Delete from history', onclick: () => removeEntry(e, i) }, icon('trash', 20));
      return h('div', { class: 'dg-hrow', role: 'listitem', 'aria-setsize': String(items.length), 'aria-posinset': String(i + 1), style: `top:${i * HIST_ROW}px` }, open, del);
    };
    const focusRow = i => {
      if (i < 0 || i >= items.length) return;
      const top = i * HIST_ROW, ch = list.clientHeight || 0;
      if (top < list.scrollTop) list.scrollTop = top; else if (ch && top + HIST_ROW > list.scrollTop + ch) list.scrollTop = top + HIST_ROW - ch;
      rows();
      list.querySelector(`[data-i="${i}"]`)?.focus?.();
    };
    const removeEntry = (e, i) => {
      if (!S.deleteHistory(e.id)) return;
      const keep = settings().keepHistory;
      toast('Deleted from history.', { kind: 'info', action: keep ? { label: 'Undo', run: () => S.addHistory({ sql: e.sql, mode: e.mode, ms: e.ms, rows: e.rows, status: e.status ?? undefined, at: e.at }) } : null });
      later(() => focusRow(Math.min(i, items.length - 1)), 0);
    };
    clearAll.addEventListener('click', async () => {
      const ok = await ask({ title: 'Clear history?', ok: 'Clear history', danger: true,
        body: 'This deletes the query history of this environment and the saved tabs from this browser, so they are not restored after a reload. Your open tabs stay open.' });
      if (!ok) return;
      S.clearHistory();
      toast('History cleared.', { kind: 'ok' });
    });
    search.addEventListener('input', () => { list.scrollTop = 0; render(); });
    list.addEventListener('scroll', rows);
    const off = S.on('history', () => render());
    const sheet = shell.sheet({
      title: 'History', sub: '', tools: h('div', { class: 'dg-htools' }, h('label', { class: 'input' }, icon('search', 16), search), clearAll), body: list,
      onClose() { off(); hist = null; },
    });
    hist = { sheet, render };
    render();
    return sheet;
  }

  // ---- cell viewer (03 §8) -------------------------------------------------------------------------------------------
  function openCellViewer(text, kind = 'text') {
    const s = String(text ?? '');
    const k = kind === 'json' || kind === 'xml' ? kind : 'text';
    const title = k === 'json' ? 'JSON' : k === 'xml' ? 'XML' : 'Cell text';
    const pretty = k === 'json' ? prettyJson(s) : k === 'xml' ? prettyXml(s) : null;
    let mode = pretty != null ? 'formatted' : 'stored';
    const pre = h('pre', { class: 'code dg-cell', tabindex: '0', 'aria-label': title });
    const render = () => setChildren(pre, highlightNodes(mode === 'formatted' ? pretty : s, k));
    const seg = pretty != null ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Layout' },
      [['formatted', 'Formatted'], ['stored', 'As stored']].map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(mode === v), text: l, 'data-mode': v,
        onclick: () => { mode = v; for (const b of seg.children) b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === v)); render(); } }))) : null;
    render();
    return shell.dialog({
      title, size: 'l', sub: `${plural(s.length, 'character')}${s.length > BIG_TEXT ? ' · shown without highlighting' : ''}`,
      body: h('div', { class: 'dg-stack' }, seg, pre),
      actions: [{ id: 'copy', label: 'Copy', kind: 'primary' }, { id: 'cancel', label: 'Close' }],
      onAction(id) {
        if (id !== 'copy') return true;
        Promise.resolve(io.copyText(s)).then(ok => toast(ok ? 'Copied the cell text.' : 'Could not copy to the clipboard.', { kind: ok ? 'ok' : 'error' }));
        return false;
      },
    });
  }

  // ---- Save as personal view (03 §7; 02 §8.3; 00 §5 rule 1) ---------------------------------------------------------
  // name/open/note: Save as personal view from the results toolbar opens the saved view in a new browser tab
  // (open), so SQL Studio stays open, and explains the filter (note). Open as view needs no dialog (openTempView).
  function saveAsView({ entity, fetchXml, columns, name: defaultName = '', open = false, note = null } = {}) {
    if (api?.caller?.()) { toast('Not available while acting as another user.', { kind: 'warn' }); return Promise.resolve(null); }
    if (typeof writeCaps?.createGrant !== 'function' || typeof api?.write !== 'function') return Promise.reject(new Error('saveAsView(): the API is not available.'));
    const info = typeof entity === 'string' ? (meta?.findEntity?.(entity) ?? { logicalName: entity }) : entity;
    const etn = info?.logicalName;
    if (!etn || typeof fetchXml !== 'string' || !fetchXml.trim()) return Promise.reject(new TypeError('saveAsView(): the table and its FetchXML are required.'));
    const layoutXml = buildLayoutXml(info, columns);
    const cells = layoutCells(columns).length;
    const otc = typeCodeOf(info) ?? typeCodeOf(meta?.findEntity?.(etn));
    return new Promise(resolve => {
      let saved = null, existing = null, checking = false, token = 0, closed = false, lookupCtrl = null, saving = false;
      const name = textField({ label: 'Name', maxlength: 200, placeholder: 'For example: Active accounts in Seattle' });
      const descId = nextId('dg-d');
      const desc = h('textarea', { id: descId, class: 'ta', maxlength: '2000', rows: '3', spellcheck: 'true' });
      const replace = h('input', { type: 'checkbox', checked: !!defaultName });
      const replaceText = h('span');
      const replaceRow = h('label', { class: 'chk', hidden: true }, replace, replaceText);
      const status = h('p', { class: 'dg-msg', role: 'status' });
      const body = h('div', { class: 'dg-stack' }, name.node,
        h('div', { class: 'dg-field' }, h('label', { for: descId, text: 'Description' }), desc), replaceRow, status,
        note ? h('p', { class: 'dg-msg', text: note }) : null,
        h('p', { class: 'dg-msg', text: `A personal view of ${info.displayCollectionName || info.displayName || etn} with ${plural(cells, 'column')}. Saving it needs no Allow changes.` }));
      const refresh = () => {
        if (closed) return;
        const n = name.input.value.trim();
        replaceRow.hidden = !existing;
        replaceText.textContent = existing ? 'Replace the existing view with this name' : '';
        setLabel(handle, 'save', (existing && replace.checked ? 'Replace' : 'Save') + (open ? ' and open' : ''));
        handle.setDisabled('save', !n || checking);
      };
      const lookup = debounce(async () => {
        const n = name.input.value.trim();
        const my = ++token;
        lookupCtrl?.abort();
        lookupCtrl = null;
        existing = null;
        if (!n) { checking = false; status.textContent = ''; refresh(); return; }
        if (otc == null) {
          checking = false;
          status.textContent = `SQL Studio cannot check for an existing view with this name: the object type code of ${etn} is unknown.`;
          refresh();
          return;
        }
        const ctrl = lookupCtrl = new AbortController();
        try {
          // The view name stays out of the URL when 'Send queries in the request body' is on (00 §5 rule 6).
          const json = await api.fetchXml('userqueries', existingViewXml(n, otc), { signal: ctrl.signal, inBody: settings().queryInBody === true });
          if (my !== token || closed) return;
          const row = Array.isArray(json?.value) ? json.value[0] : null;
          existing = row && isGuid(row.userqueryid) && row['@odata.etag'] ? { id: lower(row.userqueryid), etag: row['@odata.etag'], name: row.name ?? n } : null;
          status.textContent = existing ? 'You already have a view with this name.' : '';
        } catch (e) {
          if (my !== token || closed) return;
          status.textContent = `Could not check for a view with this name: ${e?.message || e}`;
        }
        checking = false;
        refresh();
      }, 300);
      name.input.addEventListener('input', () => { checking = !!name.input.value.trim(); token++; lookupCtrl?.abort(); lookupCtrl = null; refresh(); lookup(); });
      replace.addEventListener('change', refresh);
      const handle = shell.dialog({
        title: 'Save as personal view', body,
        actions: [{ id: 'save', label: 'Save', kind: 'primary', disabled: true }, { id: 'cancel', label: 'Cancel' }],
        onAction(id, e) {
          if (id !== 'save') return true;
          // One save at a time, none after the view was saved or the dialog closed.
          if (closed || saving || saved) return false;
          if (!e || e.isTrusted !== true || checking) return false;
          const n = name.input.value.trim();
          if (!n) return false;
          if (api.caller?.()) throw new Error('Not available while acting as another user.');
          const target = existing && replace.checked ? existing : null;
          const op = personalViewOp({ id: target ? null : lower(uuid()), etn, name: n, description: desc.value.trim(), fetchXml, layoutXml, existing: target });
          const grant = writeCaps.createGrant({ ops: [op], options: {}, callerId: null, personalView: true });
          saving = true;
          return (async () => {
            try {
              const res = await api.write(grant, [op]);
              const r = Array.isArray(res) ? res[0] : null;
              if (!r || r.status !== 'ok') throw new Error(r?.message || 'The view was not saved.');
              const viewId = lower(op.op === 'create' ? (r.newId ?? op.id) : op.id);
              saved = { id: viewId, name: n, replaced: !!target };
              toast(`${target ? 'Replaced' : 'Saved'} the personal view ${quoteName(n)}.`, { kind: 'ok', action: { label: 'Open view', run: () => openView(etn, viewId) } });
              if (open) openView(etn, viewId);   // a new tab: this click's activation still allows it
              return true;
            } finally { saving = false; }
          })();
        },
        onClose() { closed = true; lookup.cancel(); lookupCtrl?.abort(); resolve(saved); },
      });
      if (defaultName) { name.input.value = defaultName; checking = true; lookup(); }
      refresh();
    });
  }

  // A personal view in a new browser tab (a saved view; the temp view's fallback): SQL Studio stays as it is.
  function openView(etn, viewId) {
    const url = listUrl(etn, { viewId, viewType: 4230, known });
    if (!url) { toast('The view cannot be opened from here.', { kind: 'error' }); return false; }
    io.openUrl(url);
    return true;
  }

  // ---- Open as view ------------------------------------------------------------------------------------------
  // One click, no dialog: the results go into the user's own personal view 'SQL Studio Results' of the table (created
  // the first time, then replaced: the lookup matches only views the user owns), which opens in place in the app with
  // Xrm.Navigation, so SQL Studio stays open (minimized); a new tab when the page cannot navigate. Dynamics shows a
  // list only from a saved view, so this is the one write; it needs no Allow changes, like Save as personal view.
  async function openTempView({ entity, fetchXml, columns } = {}) {
    if (api?.caller?.()) { toast('Not available while acting as another user.', { kind: 'warn' }); return null; }
    if (typeof writeCaps?.createGrant !== 'function' || typeof api?.write !== 'function') throw new Error('openTempView(): the API is not available.');
    const info = typeof entity === 'string' ? (meta?.findEntity?.(entity) ?? { logicalName: entity }) : entity;
    const etn = info?.logicalName;
    if (!etn || typeof fetchXml !== 'string' || !fetchXml.trim()) throw new TypeError('openTempView(): the table and its FetchXML are required.');
    const layoutXml = buildLayoutXml(info, columns);
    const otc = typeCodeOf(info) ?? typeCodeOf(meta?.findEntity?.(etn));
    let existing = null;
    if (otc != null) {
      const json = await api.fetchXml('userqueries', existingViewXml(TEMP_VIEW_NAME, otc), { inBody: settings().queryInBody === true });
      const row = Array.isArray(json?.value) ? json.value[0] : null;
      existing = row && isGuid(row.userqueryid) && row['@odata.etag'] ? { id: lower(row.userqueryid), etag: row['@odata.etag'] } : null;
    }
    const op = personalViewOp({ id: existing ? null : lower(uuid()), etn, name: TEMP_VIEW_NAME, description: TEMP_VIEW_DESCRIPTION, fetchXml, layoutXml, existing });
    const grant = writeCaps.createGrant({ ops: [op], options: {}, callerId: null, personalView: true });
    const res = await api.write(grant, [op]);
    const r = Array.isArray(res) ? res[0] : null;
    if (!r || r.status !== 'ok') throw new Error(r?.message || 'The view was not saved.');
    const viewId = lower(op.op === 'create' ? (r.newId ?? op.id) : op.id);
    if (await io.navigateToView(etn, viewId)) {
      shell.minimize?.({ focus: false });
      toast(`Opened the results in your view ${quoteName(TEMP_VIEW_NAME)}. Open as view replaces it each time; use Save as personal view to keep one.`, { kind: 'ok' });
      return { id: viewId, inPlace: true };
    }
    if (!openView(etn, viewId)) return null;
    toast(`Opened the results in a new tab, in your view ${quoteName(TEMP_VIEW_NAME)}.`, { kind: 'ok', action: { label: 'Open again', run: () => openView(etn, viewId) } });
    return { id: viewId, inPlace: false };
  }

  // ---- FetchXML → SQL and Import current view (03 §8; 02 §10) ---------------------------------------------
  // The converter options remembered in layout.fetchToSql (03 §2), each field validated on its own.
  const fetchOpts = () => fetchOptions(st().layout?.fetchToSql);
  const setFetchOpts = patch => {
    try { S.setLayout({ fetchToSql: patch }); } catch (e) { toast(e?.message || String(e), { kind: 'error' }); }
  };

  // Loads, in parallel, the metadata of every table a FetchXML document names, then returns the warnings for unknown
  // tables and columns; without meta.entity() nothing can be checked and there are none.
  async function fetchXmlWarnings(doc) {
    if (typeof meta?.entity !== 'function') return [];
    const names = fetchXmlNames(doc);
    const infos = new Map();
    await Promise.all(names.tables.map(async t => {
      try { infos.set(lower(t), { info: await meta.entity(t) }); } catch (e) { infos.set(lower(t), { error: e instanceof Error ? e : new Error(String(e)) }); }
    }));
    return fetchMetaWarnings(names, infos);
  }

  function fetchToSqlDialog(initial = '') {
    if (!fetchToSql) { toast('FetchXML → SQL is not available.', { kind: 'error' }); return null; }
    const id = nextId('dg-fx'), dsId = nextId('dg-ds'), noteId = nextId('dg-dn');
    const ta = h('textarea', { id, class: 'ta', rows: '12', spellcheck: 'false', autocomplete: 'off', placeholder: '<fetch>…</fetch>', value: typeof initial === 'string' ? initial : '' });
    const err = h('div', { class: 'err-box', role: 'alert', hidden: true });
    const warnBox = h('div', { class: 'dg-stack', role: 'status' });
    const o = fetchOpts();
    const vars = h('input', { type: 'checkbox', checked: o.variables });
    const utc = h('input', { type: 'checkbox', checked: o.utc });
    const dates = h('select', { class: 'sel', id: dsId, 'aria-describedby': noteId }, DATE_OPERATOR_CHOICES.map(([v, l]) => h('option', { value: v, text: l })));
    dates.value = o.dateOperators;
    let warned = false, converted = false;
    const handle = shell.dialog({
      title: 'FetchXML → SQL', size: 'l',
      body: h('div', { class: 'dg-stack' }, h('div', { class: 'dg-field' }, h('label', { for: id, text: 'FetchXML' }), ta), err, warnBox,
        h('label', { class: 'chk' }, vars, 'Values as variables'),
        h('div', { class: 'dg-field' }, h('label', { for: dsId, text: 'Relative dates as' }), dates, h('p', { class: 'dg-msg', id: noteId, text: FETCH_DATES_NOTE })),
        h('label', { class: 'chk' }, utc, 'Dates in UTC'),
        h('p', { class: 'dg-msg', text: 'The SQL opens in a new query tab and does not run.' })),
      actions: [{ id: 'convert', label: 'Convert', kind: 'primary', disabled: !ta.value.trim() }, { id: 'cancel', label: 'Cancel' }],
      onAction(a) {
        if (a !== 'convert') return true;
        const xml = ta.value;
        const fail = e => { err.textContent = e?.message || String(e); err.hidden = false; return false; };
        // Convert parses first and loads the metadata of every table the XML names, then converts.
        let doc;
        try { doc = parseXml(xml); } catch (e) { return fail(e); }
        const anyway = warned;
        return (async () => {
          setLabel(handle, 'convert', 'Loading metadata…');
          let warnings;
          try { warnings = await fetchXmlWarnings(doc); } finally { setLabel(handle, 'convert', anyway ? 'Open anyway' : 'Convert'); }
          let sql;
          try { sql = String(await fetchToSql(xml, meta, fetchOpts())); } catch (e) { return fail(e); }
          if (warnings.length && !anyway) {
            // The names stay listed; 'Open anyway' opens the tab, and the binder reports 208/207 when it runs.
            warned = true;
            setChildren(warnBox, warnings.map(w => note('warning', w)));
            setLabel(handle, 'convert', 'Open anyway');
            return false;
          }
          const table = fetchXmlNames(doc).tables[0] ?? '';
          S.createTab({ title: table ? `FetchXML: ${table}` : 'From FetchXML', sql, caret: [sql.length, sql.length] });
          converted = true;
          return true;
        })();
      },
      onClose() { if (converted) focusEditor(); },
    });
    // Any edit of the text or the options needs a new conversion: the warnings go and the button reads Convert again.
    const reset = () => {
      err.hidden = true;
      if (!warned) return;
      warned = false;
      setChildren(warnBox);
      setLabel(handle, 'convert', 'Convert');
    };
    ta.addEventListener('input', () => { reset(); handle.setDisabled('convert', !ta.value.trim()); });
    vars.addEventListener('change', () => { setFetchOpts({ variables: !!vars.checked }); reset(); });
    utc.addEventListener('change', () => { setFetchOpts({ utc: !!utc.checked }); reset(); });
    dates.addEventListener('change', () => { setFetchOpts({ dateOperators: dates.value }); reset(); });
    return handle;
  }

  function importViewState() {
    const p = viewParams(loc()?.href);
    if (!p.etn) return { disabled: true, title: 'Open a list of records first.' };
    if (!fetchToSql) return { disabled: true, title: 'Importing views is not available.' };
    return {};
  }

  async function importView() {
    const p = viewParams(loc()?.href);
    if (!p.etn) { toast('Open a list of records first.', { kind: 'warn' }); return null; }
    if (!fetchToSql) { toast('Importing views is not available.', { kind: 'error' }); return null; }
    const info = typeof meta?.findEntity === 'function' ? meta.findEntity(p.etn) : null;
    if (!info) { toast(`The table ${quoteName(p.etn)} of this page is not in the metadata of this environment.`, { kind: 'error' }); return null; }
    if (p.badViewId) { toast('The view id in the page address is not a valid id.', { kind: 'error' }); return null; }
    if (Number.isNaN(p.viewType)) { toast('Only system views (viewType 1039) and personal views (4230) can be imported.', { kind: 'error' }); return null; }
    const otc = typeCodeOf(info);
    if (!p.viewId && otc == null) { toast(`The default view of ${quoteName(p.etn)} cannot be found: the table has no object type code.`, { kind: 'error' }); return null; }
    let row;
    try {
      const set = p.viewId && p.viewType === 4230 ? 'userqueries' : 'savedqueries';
      const json = await api.fetchXml(set, viewFetchXml({ ...p, otc }), { inBody: settings().queryInBody === true });
      row = Array.isArray(json?.value) ? json.value[0] : null;
    } catch (e) {
      toast(`The view could not be read: ${e?.message || e}`, { kind: 'error' });
      return null;
    }
    if (!row || typeof row.fetchxml !== 'string') {
      toast(p.viewId ? 'The view was not found, or you cannot read it.' : `The table ${quoteName(p.etn)} has no default public view.`, { kind: 'error' });
      return null;
    }
    // As in FetchXML → SQL: metadata for every table of the view first, then the remembered options.
    let sql, warnings;
    try {
      const doc = parseXml(row.fetchxml);
      warnings = await fetchXmlWarnings(doc);
      sql = String(await fetchToSql(row.fetchxml, meta, fetchOpts()));
    } catch (e) {
      toast(`The view could not be converted: ${e?.message || e}`, { kind: 'error' });
      return null;
    }
    const text = [importHeader(row.name ?? '', !p.viewId), ...importWarningLines(warnings), sql].join('\n');
    const tab = S.createTab({ title: String(row.name || p.etn).replace(/[\r\n]+/g, ' '), sql: text, caret: [text.length, text.length] });
    focusEditor();
    announce(`Imported the view ${quoteName(row.name || p.etn)} into a new tab. It has not run.`);
    return tab;
  }

  // ---- Load CSV as #temp and Load file as text (03 §8.4; 02 §9) -------------------------------------------------
  // 'Query it' (03 §8.4): the #temp table lives in the session of the tab that loaded it (03 §2), so the query goes
  // into that tab, which becomes active: a blank tab gets the query as its text (caret at the end), otherwise the query
  // is added after the text and selected, so Run runs only it. Nothing runs. {file: true}: Load file as text's query.
  function queryIt(tabId, name, { file = false } = {}) {
    const tab = S.getTab?.(tabId);
    if (!tab) { toast(`The query tab that loaded ${name} was closed, and the table with it.`, { kind: 'warn' }); return false; }
    const sql = queryItSql(name, { file });
    const switched = st().activeTab !== tabId;
    if (switched) S.setActiveTab(tabId);
    const ed = ['getValue', 'setValue', 'insert', 'select'].every(k => typeof editor?.[k] === 'function') ? editor : null;
    // The editor holds the active tab's text (the state may lag behind it); right after a switch it must show the
    // tab's stored text, else the tab's state is updated and the editor shows it when it switches.
    const live = ed && st().activeTab === tabId && (!switched || ed.getValue() === tab.sql) ? ed : null;
    const text = live ? String(live.getValue() ?? '') : tab.sql;
    const r = appendQuery(text, sql);
    const sel = r.start === 0 ? [r.end, r.end] : [r.start, r.end];
    if (live) {
      if (r.start === 0) live.setValue(r.text);
      else live.insert(r.text.slice(text.length), { at: text.length });
      live.select(sel[0], sel[1], { reveal: true });
    } else S.updateTab(tabId, { sql: r.text, caret: sel });
    focusEditor();
    announce(`Added the query of ${name} to ${quoteName(tab.title)}. It has not run.`);
    return true;
  }

  // A determinate or indeterminate progress bar of a load dialog (.progress): {node, set(pct|null|false,
  // label?)}.
  function progressBar(label) {
    const node = h('div', { class: 'progress off', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-hidden': 'true' }, h('div'));
    const set = (v, text) => {
      if (v === false) { node.className = 'progress off'; node.setAttribute('aria-hidden', 'true'); node.removeAttribute('aria-valuenow'); return; }
      node.removeAttribute('aria-hidden');
      if (text) node.setAttribute('aria-label', text);
      if (v == null || !Number.isFinite(v)) { node.className = 'progress ind'; node.removeAttribute('aria-valuenow'); return; }
      const pct = Math.max(0, Math.min(100, v));
      node.className = 'progress';
      node.firstChild.style.setProperty('width', `${Math.max(2, pct)}%`);
      node.setAttribute('aria-valuenow', String(Math.round(pct)));
    };
    return { node, set };
  }

  // Runs a session load (loadCsv / loadFile, one run under the gate) through results.attachQuiet (run lock, progress,
  // Messages, 03 §1.4): {d: the done event, msgs: its messages}.
  async function runLoad(run, tabId, label, onProgress) {
    const msgs = [];
    let doneEv = null;
    run.on?.('message', m => msgs.push(m));
    run.on?.('progress', p => onProgress(Number.isFinite(p?.pct) ? p.pct : null));
    run.on?.('done', d => { doneEv = d; });
    let d;
    try {
      const q = typeof results?.attachQuiet === 'function' ? await results.attachQuiet(tabId, run, { label }) : null;
      const r = await run.done;
      d = isObj(r) ? r : doneEv ?? (q ? { ok: !!q.ok } : { ok: true });
    } catch (e) {
      d = { ok: false, error: e };
    }
    return { d, msgs };
  }

  // The files of a load: one File, an array or FileList of them, or none (the open picker then asks for them).
  const fileList = files => {
    if (files == null) return null;
    return (Array.isArray(files) || (typeof files.length === 'number' && typeof files.item === 'function') ? Array.from(files) : [files]).filter(Boolean);
  };

  async function loadCsv(files) {
    const tabId = st().activeTab;
    const session = st().sessions?.get?.(tabId);
    if (typeof session?.previewCsv !== 'function' || typeof session?.loadCsv !== 'function') {
      toast('Load CSV as #temp is not available in this query tab.', { kind: 'error' });
      return null;
    }
    let list = fileList(files);
    if (!list) {
      let r;
      try { r = await io.openFile({ accept: { 'text/csv': ['.csv', '.tsv', '.txt'] }, description: 'CSV files', multiple: true }); } catch (e) {
        toast(e?.message || String(e), { kind: 'error' });
        return null;
      }
      list = r ? (Array.isArray(r.files) && r.files.length ? r.files.filter(Boolean) : r.file ? [r.file] : []) : [];
    }
    if (!list.length) return null;
    return csvDialog(list, tabId, session);
  }

  function csvDialog(files, tabId, session) {
    return new Promise(resolve => {
      const names = files.map(f => String(f?.name ?? ''));
      const label = names.length > 1 ? `${fmtInt(names.length)} files` : names[0];
      const totalSize = files.reduce((n, f) => n + (Number.isFinite(f?.size) ? f.size : 0), 0);
      const o = { header: 'auto', delimiter: 'auto', decimal: 'auto', nullWord: true, quote: '"', escape: null, firstRow: 1, lastRow: null };
      let preview = null, error = null, parsing = false, loading = false, closed = false, ctrl = null, sources = null, sourcesRead = null;
      let tname = '', nameEdited = false, replace = false, cols = [], loaded = null;
      // 'More options': the inputs as typed, checked by moreErrors(); only valid values reach previewCsv.
      const more = { quote: '"', quoteOther: '', escape: 'none', escapeOther: '', first: '', last: '', onError: 'fail', maxErrors: '10' };
      const fileInfo = h('span');
      const progress = progressBar(`Reading ${label}`);
      const errBox = h('div', { class: 'err-box', role: 'alert', hidden: true });
      const warnBox = h('div', { class: 'dg-stack' });
      const sel = (kind, text) => {
        const s = h('select', { class: 'sel', 'aria-label': text }, CSV_OPTIONS[kind].map(([v, l]) => h('option', { value: v, text: l })));
        s.value = 'auto';
        s.addEventListener('change', () => { o[kind] = csvOptionValue(kind, s.value); parse(); });
        return h('label', { class: 'fld' }, text, s);
      };
      const nullSw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'true', 'aria-label': 'Treat the word NULL as NULL' }, h('i'));
      nullSw.addEventListener('click', () => { o.nullWord = !o.nullWord; nullSw.setAttribute('aria-checked', String(o.nullWord)); parse(); });
      const nameErrId = nextId('dg-ne');
      const name = textField({ label: 'Table name', maxlength: 116, describedBy: nameErrId });
      const nameErr = h('p', { class: 'dg-err', id: nameErrId, hidden: true });
      name.input.addEventListener('input', () => { setName(name.input.value); nameEdited = true; refresh(); });
      const replaceChk = h('input', { type: 'checkbox' });
      const replaceText = h('span');
      const replaceRow = h('label', { class: 'chk', hidden: true }, replaceChk, replaceText);
      replaceChk.addEventListener('change', () => { replace = !!replaceChk.checked; refresh(); });
      // Replace is a confirmation for one table: it is unticked whenever the name names another table (the edited
      // name, or a new preview's suggestion) and whenever the box is not shown.
      const unReplace = () => { replace = false; replaceChk.checked = false; };
      function setName(v) {
        if (lower(String(v ?? '').trim()) !== lower(tname.trim())) unReplace();
        tname = String(v ?? '');
      }
      const moreNode = moreOptions();
      const tableWrap = h('div', { class: 'dg-csv-scroll', tabindex: '0', role: 'region', 'aria-label': 'Preview of the first rows', hidden: true });
      const body = h('div', { class: 'dg-stack' },
        h('div', { class: 'dg-file' }, h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('csv', 20)),
          h('div', null, h('b', { text: names.join(', '), title: names.length > 1 ? names.join('\n') : null }), fileInfo)),
        progress.node, errBox, warnBox,
        h('div', { class: 'dg-opts' }, sel('header', 'First row has column names'), sel('delimiter', 'Delimiter'), sel('decimal', 'Decimal symbol'),
          h('span', { class: 'fld' }, nullSw, 'Treat the word NULL as NULL')),
        moreNode.node, name.node, nameErr, replaceRow, tableWrap, note('info', CSV_NOTE));
      const handle = shell.dialog({
        title: csvTitle(names), size: 'l', body,
        actions: [{ id: 'load', label: 'Load', kind: 'primary', disabled: true }, { id: 'cancel', label: 'Cancel' }],
        onAction(id) {
          if (id !== 'load') {
            if (parsing) { ctrl?.abort(); toast('Import cancelled.', { kind: 'info' }); }
            return true;
          }
          if (blockReason()) return false;
          return load();
        },
        onClose() { closed = true; ctrl?.abort(); offs2.forEach(f => f()); resolve(loaded); },
      });
      const offs2 = [S.on('run:start', () => refresh()), S.on('run:end', () => refresh()), S.on('temps', () => refresh())];
      if (typeof session.on === 'function') { const off = session.on('temps', () => refresh()); if (typeof off === 'function') offs2.push(off); }

      // The 'More options' section (03 §8.4): First and Last record, the quote and escape characters (each with an
      // 'Other' input of one character) and what a value that cannot be converted does. Changes of the previewCsv
      // options run the preview again; onError and maxErrors are passed to loadCsv.
      function moreOptions() {
        const field = (text, ctl, err) => h('div', { class: 'dg-field' }, h('label', { for: ctl.id, text }), ctl.wrap ?? ctl, err ?? null);
        const numInput = (key, placeholder) => {
          const input = h('input', { id: nextId('dg-mo'), type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', placeholder });
          input.addEventListener('input', () => { more[key] = input.value; changed(true); });
          const wrap = h('div', { class: 'input' }, input);
          return Object.assign(input, { wrap });
        };
        const choiceSel = (kind, key) => {
          const s = h('select', { id: nextId('dg-mo'), class: 'sel' }, CSV_OPTIONS[kind].map(([v, l]) => h('option', { value: v, text: l })));
          s.value = more[key];
          return s;
        };
        const charInput = (key, text) => {
          const input = h('input', { type: 'text', maxlength: '2', autocomplete: 'off', spellcheck: 'false', 'aria-label': text, hidden: true });
          input.addEventListener('input', () => { more[key] = input.value; changed(true); });
          return input;
        };
        const first = numInput('first', '1'), last = numInput('last', 'All');
        const rangeErr = h('p', { class: 'dg-err', role: 'alert', hidden: true });
        const quote = choiceSel('quote', 'quote'), quoteOther = charInput('quoteOther', 'Other quote character');
        const escape = choiceSel('escape', 'escape'), escapeOther = charInput('escapeOther', 'Other escape character');
        const charErr = h('p', { class: 'dg-err', role: 'alert', hidden: true });
        const onErr = choiceSel('onError', 'onError');
        const maxErr = h('input', { type: 'number', min: '0', max: String(CSV_MAX_ERRORS), step: '1', inputmode: 'numeric', value: more.maxErrors, 'aria-label': 'At most how many errors' });
        const maxRow = h('div', { class: 'dg-optrow', hidden: true }, h('span', { text: 'At most' }), h('span', { class: 'input' }, maxErr), h('span', { text: 'errors' }));
        const maxErrMsg = h('p', { class: 'dg-err', role: 'alert', hidden: true });
        const charBox = (s, input) => h('div', { class: 'dg-optrow' }, s, h('span', { class: 'input dg-char', hidden: true }, input));
        quote.addEventListener('change', () => { more.quote = quote.value; quoteOther.parentNode.hidden = quote.value !== 'other'; quoteOther.hidden = quote.value !== 'other'; changed(true); });
        escape.addEventListener('change', () => { more.escape = escape.value; escapeOther.parentNode.hidden = escape.value !== 'other'; escapeOther.hidden = escape.value !== 'other'; changed(true); });
        onErr.addEventListener('change', () => { more.onError = onErr.value; maxRow.hidden = onErr.value !== 'skip'; changed(false); });
        maxErr.addEventListener('input', () => { more.maxErrors = maxErr.value; changed(false); });
        const node = h('details', { class: 'dg-moreopts' }, h('summary', null, icon('chevron', 12), 'More options'),
          h('div', { class: 'dg-optgrid' },
            field('First record', first), field('Last record', last, rangeErr),
            h('div', { class: 'dg-field' }, h('label', { for: quote.id, text: 'Quote character' }), charBox(quote, quoteOther)),
            h('div', { class: 'dg-field' }, h('label', { for: escape.id, text: 'Escape character' }), charBox(escape, escapeOther), charErr),
            h('div', { class: 'dg-field' }, h('label', { for: onErr.id, text: 'When a value cannot be converted' }), onErr, maxRow, maxErrMsg)));
        // Marks the invalid inputs; a valid change of a previewCsv option runs the preview again.
        function changed(reparse) {
          const e = moreErrors();
          const mark = (el, bad) => { if (bad) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); };
          mark(first, e.range?.field === 'first'); mark(last, e.range?.field === 'last');
          rangeErr.textContent = e.range?.error ?? ''; rangeErr.hidden = !e.range;
          mark(quoteOther, !!e.quote); mark(escapeOther, !!e.escape);
          charErr.textContent = e.quote ?? e.escape ?? ''; charErr.hidden = !(e.quote || e.escape);
          mark(maxErr, !!e.maxErrors);
          maxErrMsg.textContent = e.maxErrors ?? ''; maxErrMsg.hidden = !e.maxErrors;
          if (reparse && !e.range && !e.quote && !e.escape) {
            const r = csvRowRange(more.first, more.last);
            const next = { quote: csvCharValue(more.quote, more.quoteOther), escape: csvCharValue(more.escape, more.escapeOther), firstRow: r.firstRow, lastRow: r.lastRow };
            if (next.quote !== o.quote || next.escape !== o.escape || next.firstRow !== o.firstRow || next.lastRow !== o.lastRow) { Object.assign(o, next); parse(); return; }
          }
          refresh();
        }
        return { node };
      }

      // The problems of the More options inputs: {range, quote, escape, maxErrors} (each null or a message).
      function moreErrors() {
        const r = csvRowRange(more.first, more.last);
        const q = csvCharValue(more.quote, more.quoteOther) === undefined ? 'Type one character as the quote character.' : null;
        const e = csvCharValue(more.escape, more.escapeOther) === undefined ? 'Type one character as the escape character.' : null;
        const m = more.onError === 'skip' ? maxErrorsValue(more.maxErrors).error ?? null : null;
        return { range: r.error ? r : null, quote: q, escape: e, maxErrors: m };
      }

      async function parse() {
        ctrl?.abort();
        const c = ctrl = new AbortController();
        parsing = true;
        error = null;
        progress.set(null, `Reading ${label}`);
        refresh();
        try {
          // One read of the files for every parse: a parse started while the first read runs waits for that read.
          sourcesRead ??= readCsvSources(files);
          try { sources = await sourcesRead; } catch (e) { sourcesRead = null; throw e; }
          const p = await session.previewCsv(sources.length === 1 ? sources[0] : sources, { ...o, signal: c.signal });
          if (c !== ctrl || closed) return;
          preview = p;
          cols = (p.columns ?? []).map((col, i) => ({
            name: String(col.name ?? ''), key: csvTypeKey(col.dataType), fixed: isFileNameColumn(p, i),
            p: col.dataType?.name === 'decimal' ? col.dataType.args?.[0] ?? 18 : 18, s: col.dataType?.name === 'decimal' ? col.dataType.args?.[1] ?? 2 : 2,
          }));
          if (!nameEdited) { setName(p.name ?? ''); name.input.value = tname; }
          renderPreview();
        } catch (e) {
          if (c !== ctrl || closed) return;
          if (e?.name === 'AbortError') return;
          preview = null;
          error = e?.message || String(e);
          renderPreview();
        } finally {
          if (c === ctrl && !closed) { parsing = false; progress.set(false); refresh(); }
        }
      }

      function renderPreview() {
        errBox.hidden = !error;
        errBox.textContent = error ?? '';
        setChildren(warnBox, (preview?.warnings ?? []).map(w => note('warning', String(w))));
        fileInfo.textContent = preview ? `${csvSummary(preview)} · ${fmtBytes(totalSize || (sources ?? []).reduce((n, x) => n + x.bytes.byteLength, 0))}` : fmtBytes(totalSize);
        if (!preview) { tableWrap.hidden = true; setChildren(tableWrap); return; }
        const head = (preview.columns ?? []).map((col, i) => {
          const c = cols[i];
          const tip = `Inferred ${col.typeText || dataTypeText(col.dataType)} · NULLs: ${fmtInt(col.nullCount ?? 0)}${col.samples?.length ? `\nSamples: ${col.samples.join(', ')}` : ''}`;
          // The filename column of a several-file load is the session's: shown, never renamed or retyped.
          if (c.fixed) {
            return h('th', { scope: 'col', title: `Each record's file name · ${col.typeText || dataTypeText(col.dataType) || 'nvarchar(260)'}` },
              h('div', { class: 'dg-fixed' }, h('b', { text: col.name }), h('span', { text: col.typeText || dataTypeText(col.dataType) || 'nvarchar(260)' })));
          }
          const nameInput = h('input', { type: 'text', value: c.name, maxlength: '128', 'aria-label': `Name of column ${i + 1}`, autocomplete: 'off', spellcheck: 'false', 'data-col': String(i) });
          nameInput.addEventListener('input', () => { c.name = nameInput.value; refresh(); });
          const typeSel = h('select', { class: 'sel', 'aria-label': `Type of column ${i + 1}` }, csvTypeOptions(col).map(t => h('option', { value: t.value, text: t.label })));
          typeSel.value = c.key;
          const pIn = h('input', { type: 'number', min: '1', max: '38', value: String(c.p), 'aria-label': `Precision of column ${i + 1}` });
          const sIn = h('input', { type: 'number', min: '0', max: '38', value: String(c.s), 'aria-label': `Scale of column ${i + 1}` });
          const ps = h('div', { class: 'dg-ps', hidden: c.key !== 'decimal' }, h('span', { class: 'input' }, pIn), ',', h('span', { class: 'input' }, sIn));
          typeSel.addEventListener('change', () => { c.key = typeSel.value; ps.hidden = c.key !== 'decimal'; refresh(); });
          pIn.addEventListener('input', () => { c.p = Number(pIn.value); refresh(); });
          sIn.addEventListener('input', () => { c.s = Number(sIn.value); refresh(); });
          return h('th', { scope: 'col', title: tip }, h('span', { class: 'input' }, nameInput), typeSel, ps, h('div', { class: 'dg-nulls', text: `NULLs: ${fmtInt(col.nullCount ?? 0)}` }));
        });
        const rows = (preview.sampleRows ?? []).slice(0, 20).map(r => h('tr', null, (preview.columns ?? []).map((_, i) => {
          const v = Array.isArray(r) ? r[i] : null;
          if (v == null) return h('td', null, h('span', { class: 'fc-null', text: 'NULL' }));
          if (v === '') return h('td', null, h('span', { class: 'fc-empty' }));
          return h('td', { title: String(v).length > 40 ? String(v) : null, text: String(v) });
        })));
        setChildren(tableWrap, h('table', { class: 'dg-csv' }, h('thead', null, h('tr', null, head)), h('tbody', null, rows)));
        tableWrap.hidden = false;
      }

      function blockReason() {
        if (parsing) return 'Reading the file…';
        if (loading) return 'Loading…';
        if (!preview) return error ? 'The file cannot be loaded. See the message above.' : 'Reading the file…';
        const me = moreErrors();
        if (me.range || me.quote || me.escape || me.maxErrors) return 'Correct the marked options under More options first.';
        if (csvNameError(tname.trim())) return csvNameError(tname.trim());
        const colNames = cols.map(c => c.name.trim());
        if (csvColumnErrors(colNames).some(Boolean) || cols.some(c => !c.fixed && c.key === 'decimal' && decimalError(c.p, c.s))) return 'Correct the marked column names and types first.';
        if (tempInfo(tname, preview, session.temps).exists && !replace) return CSV_EXISTS_TITLE;
        return runLock();
      }

      function refresh() {
        if (closed) return;
        const nErr = preview ? csvNameError(tname.trim()) : null;
        nameErr.hidden = !nErr;
        nameErr.textContent = nErr ?? '';
        if (nErr) name.input.setAttribute('aria-invalid', 'true'); else name.input.removeAttribute('aria-invalid');
        const ti = preview ? tempInfo(tname, preview, session.temps) : { exists: false, rows: null };
        if (!ti.exists && replace) unReplace();
        replaceRow.hidden = !ti.exists;
        replaceText.textContent = ti.exists ? replaceLabel(tname.trim(), ti.rows) : '';
        const errs = csvColumnErrors(cols.map(c => c.name.trim()));
        for (const input of tableWrap.querySelectorAll('[data-col]')) {
          const i = Number(input.getAttribute('data-col'));
          const msg = errs[i] ?? (cols[i]?.key === 'decimal' ? decimalError(cols[i].p, cols[i].s) : null);
          if (msg) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('title', msg); } else { input.removeAttribute('aria-invalid'); input.removeAttribute('title'); }
        }
        const reason = blockReason();
        handle.setDisabled('load', reason != null);
        setTitle(handle, 'load', reason && !parsing ? reason : '');
      }

      async function load() {
        loading = true;
        error = null;
        errBox.hidden = true;
        const columns = (preview.columns ?? []).map((col, i) => {
          if (cols[i].fixed) return { ...col };
          const dataType = csvDataType(cols[i].key, col, { p: cols[i].p, s: cols[i].s });
          return { ...col, name: cols[i].name.trim(), dataType, typeText: dataTypeText(dataType) };
        });
        const nm = tname.trim();
        const onError = more.onError === 'skip' ? 'skip' : 'fail';
        const maxErrors = onError === 'skip' ? maxErrorsValue(more.maxErrors).value : 10;
        let run;
        try {
          run = session.loadCsv(preview, { name: nm, columns, replace, onError, maxErrors });
        } catch (e) {
          loading = false;
          error = e?.message || String(e);
          renderPreview();
          refresh();
          return false;
        }
        progress.set(0, `Loading ${label}`);
        const { d, msgs } = await runLoad(run, tabId, `Loading ${label}`, v => progress.set(v));
        loading = false;
        progress.set(false);
        if (closed) return true;
        if (d.ok) {
          const info = msgs.find(m => m?.kind === 'info')?.text ?? `Loaded ${nm}.`;
          loaded = { name: nm };
          toast(info, { kind: 'ok', action: { label: 'Query it', run: () => queryIt(tabId, nm) } });
          return true;
        }
        error = d.error?.message ?? msgs.find(m => m?.kind === 'error')?.text ?? (d.cancelled ? 'The load was cancelled; nothing was created.' : 'The file was not loaded; nothing was created.');
        renderPreview();
        refresh();
        return false;
      }

      renderPreview();
      parse();
    });
  }

  // Load file as text (03 §8.4): one file of any type, at most 50 MB, into a #temp table with one row and one
  // column BulkColumn, as text (the CSV decoding rules) or binary. Resolves {name} after a load, else null.
  async function loadFileAsText(file) {
    const tabId = st().activeTab;
    const session = st().sessions?.get?.(tabId);
    if (typeof session?.loadFile !== 'function') {
      toast('Load file as text is not available in this query tab.', { kind: 'error' });
      return null;
    }
    let f = fileList(file)?.[0] ?? null;
    if (!f) {
      let r;
      try { r = await io.openFile({ maxBytes: FILE_LIMIT }); } catch (e) {
        toast(e?.code === 'toolarge' ? FILE_TOO_LARGE : e?.message || String(e), { kind: 'error' });
        return null;
      }
      if (!r?.file) return null;
      f = r.file;
    }
    if (Number(f.size) > FILE_LIMIT) { toast(FILE_TOO_LARGE, { kind: 'error' }); return null; }
    return fileDialog(f, tabId, session);
  }

  function fileDialog(file, tabId, session) {
    return new Promise(resolve => {
      let binary = false, loading = false, closed = false, loaded = null, replace = false, error = null;
      let tname = tempNameSuggestion(file.name);
      const nameErrId = nextId('dg-ne');
      const name = textField({ label: 'Table name', value: tname, maxlength: 116, describedBy: nameErrId });
      const nameErr = h('p', { class: 'dg-err', id: nameErrId, hidden: true });
      const replaceChk = h('input', { type: 'checkbox' });
      const replaceText = h('span');
      const replaceRow = h('label', { class: 'chk', hidden: true }, replaceChk, replaceText);
      const errBox = h('div', { class: 'err-box', role: 'alert', hidden: true });
      const progress = progressBar(`Loading ${file.name}`);
      const readLabel = nextId('dg-ra');
      const seg = h('div', { class: 'seg', role: 'group', 'aria-labelledby': readLabel },
        [['text', 'Text'], ['binary', 'Binary']].map(([v, l]) => h('button', { type: 'button', 'data-v': v, 'aria-pressed': String(v === 'text'), text: l,
          onclick: () => { binary = v === 'binary'; for (const b of seg.children) b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === v)); } })));
      name.input.addEventListener('input', () => {
        if (lower(name.input.value.trim()) !== lower(tname.trim())) { replace = false; replaceChk.checked = false; }
        tname = name.input.value;
        refresh();
      });
      replaceChk.addEventListener('change', () => { replace = !!replaceChk.checked; refresh(); });
      const body = h('div', { class: 'dg-stack' },
        h('div', { class: 'dg-file' }, h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('file', 20)), h('div', null, h('b', { text: file.name }), h('span', { text: fmtBytes(Number(file.size) || 0) }))),
        progress.node, errBox,
        h('div', { class: 'dg-readas' }, h('span', { class: 'lb', id: readLabel, text: 'Read as' }), seg,
          h('span', { class: 'dg-msg', text: 'Text: nvarchar(max), decoded as UTF-8 or Windows-1252. Binary: varbinary(max).' })),
        name.node, nameErr, replaceRow, note('info', FILE_NOTE));
      const handle = shell.dialog({
        title: `Load ${file.name} as a #temp table`, size: 'm', body,
        actions: [{ id: 'load', label: 'Load', kind: 'primary' }, { id: 'cancel', label: 'Cancel' }],
        onAction(id) {
          if (id !== 'load') return true;
          if (blockReason()) return false;
          return load();
        },
        onClose() { closed = true; offs2.forEach(f => f()); resolve(loaded); },
      });
      const offs2 = [S.on('run:start', () => refresh()), S.on('run:end', () => refresh()), S.on('temps', () => refresh())];
      if (typeof session.on === 'function') { const off = session.on('temps', () => refresh()); if (typeof off === 'function') offs2.push(off); }

      function blockReason() {
        if (loading) return 'Loading…';
        if (csvNameError(tname.trim())) return csvNameError(tname.trim());
        if (tempInfo(tname, null, session.temps).exists && !replace) return CSV_EXISTS_TITLE;
        return runLock();
      }

      function refresh() {
        if (closed) return;
        const nErr = csvNameError(tname.trim());
        nameErr.hidden = !nErr;
        nameErr.textContent = nErr ?? '';
        if (nErr) name.input.setAttribute('aria-invalid', 'true'); else name.input.removeAttribute('aria-invalid');
        const ti = tempInfo(tname, null, session.temps);
        if (!ti.exists && replace) { replace = false; replaceChk.checked = false; }
        replaceRow.hidden = !ti.exists;
        replaceText.textContent = ti.exists ? replaceLabel(tname.trim(), ti.rows) : '';
        errBox.hidden = !error;
        errBox.textContent = error ?? '';
        const reason = blockReason();
        handle.setDisabled('load', reason != null);
        setTitle(handle, 'load', reason ?? '');
      }

      async function load() {
        loading = true;
        error = null;
        refresh();
        const nm = tname.trim();
        let run;
        try {
          const bytes = await file.arrayBuffer();
          run = session.loadFile({ bytes, name: file.name }, { name: nm, binary, replace });
        } catch (e) {
          loading = false;
          error = e?.message || String(e);
          refresh();
          return false;
        }
        progress.set(0, `Loading ${file.name}`);
        const { d, msgs } = await runLoad(run, tabId, `Loading ${file.name}`, v => progress.set(v));
        loading = false;
        progress.set(false);
        if (closed) return true;
        if (d.ok) {
          const info = msgs.find(m => m?.kind === 'info')?.text ?? `Loaded ${file.name} into ${nm}.`;
          loaded = { name: nm };
          toast(info, { kind: 'ok', action: { label: 'Query it', run: () => queryIt(tabId, nm, { file: true }) } });
          return true;
        }
        error = d.error?.message ?? msgs.find(m => m?.kind === 'error')?.text ?? (d.cancelled ? 'The load was cancelled; nothing was created.' : 'The file was not loaded; nothing was created.');
        refresh();
        return false;
      }

      refresh();
    });
  }

  // ---- Save all (03 §3) --------------------------------------------------------------------------------------
  // In its click, writes every tab whose file handle already has write permission (queryPermission, no picker); then
  // offers every other tab with SQL in turn ('Save “Query 3”?': Save…, Skip, Skip all), each Save… opening the save
  // picker or Edge's permission prompt in its own click. A write error names the tab and goes on; the final toast reads
  // 'Saved 5 tabs. 2 skipped.'. Resolves {saved, skipped, failed}.
  let savingAll = null;
  const SQL_TYPES = [{ description: 'SQL files', accept: { 'text/plain': ['.sql'] } }];
  const tabText = id => {
    const t = S.getTab?.(id);
    if (!t) return null;
    return id === st().activeTab && typeof editor?.getValue === 'function' ? String(editor.getValue() ?? '') : String(t.sql ?? '');
  };
  // keepHandle: a write to the tab's own granted handle keeps that handle (the picker cannot open there without a
  // gesture, see the notes above); a Save… click takes the file the user picked.
  const writeTab = (t, done, { keepHandle = false } = {}) => {
    let p;
    try {
      p = io.saveFile(sqlFileName(t.title), () => new Blob([tabText(t.id) ?? ''], { type: 'text/plain;charset=utf-8' }), { types: SQL_TYPES, handle: t.file ?? undefined });
    } catch (e) { p = Promise.reject(e); }
    return Promise.resolve(p).then(r => {
      if (r?.status === 'saved' || r?.status === 'downloaded') {
        const file = !keepHandle && r.status === 'saved' && r.handle ? { file: r.handle } : {};
        if (S.getTab?.(t.id)) S.updateTab(t.id, { dirty: false, ...file });
        done.saved++;
      } else done.skipped++;
    }, e => {
      done.failed++;
      toast(`Could not save ${quoteName(t.title)}: ${e?.message || e}`, { kind: 'error' });
    });
  };
  function saveAll() {
    if (savingAll) return savingAll;
    const done = { saved: 0, skipped: 0, failed: 0 };
    const tabs = [...st().tabs];
    // queryPermission starts in the click and never prompts.
    const perms = tabs.map(t => (t.file && typeof t.file.queryPermission === 'function'
      ? Promise.resolve().then(() => t.file.queryPermission({ mode: 'readwrite' })).catch(() => 'prompt') : Promise.resolve('none')));
    savingAll = (async () => {
      const states = await Promise.all(perms);
      const ask = [];
      for (let i = 0; i < tabs.length; i++) {
        const t = tabs[i];
        if (!S.getTab?.(t.id)) continue;
        if (states[i] === 'granted') await writeTab(S.getTab(t.id), done, { keepHandle: true });
        else if ((tabText(t.id) ?? '').trim()) ask.push(t.id);
      }
      for (let i = 0; i < ask.length; i++) {
        const t = S.getTab?.(ask[i]);
        if (!t) continue;
        const choice = await askSave(t, done);
        if (choice === 'all') { done.skipped += ask.slice(i + 1).filter(id => S.getTab?.(id)).length; break; }
      }
      if (!done.saved && !done.skipped && !done.failed) toast('Every query tab is empty; there is nothing to save.', { kind: 'info' });
      else toast(saveAllSummary(done.saved, done.skipped) + (done.failed ? ` ${fmtInt(done.failed)} could not be saved.` : ''), { kind: done.failed ? 'warn' : 'ok' });
      return { ...done };
    })().finally(() => { savingAll = null; });
    return savingAll;
  }
  // One 'Save “Query 3”?' question: resolves 'saved' (after the save), 'skip' or 'all' (Skip all, also Escape).
  function askSave(t, done) {
    return new Promise(resolve => {
      let choice = 'all';
      const handle = shell.dialog({
        title: `Save ${quoteName(t.title)}?`,
        body: h('div', { class: 'dg-stack' }, h('p', { text: t.file ? 'SQL Studio needs your permission to write to the file of this tab again.' : 'This tab has no file yet. Choose where to save it.' })),
        actions: [{ id: 'save', label: 'Save…', kind: 'primary', focus: true }, { id: 'skip', label: 'Skip' }, { id: 'cancel', label: 'Skip all' }],
        onAction(id) {
          if (id === 'skip') { choice = 'skip'; done.skipped++; return true; }
          if (id !== 'save') { choice = 'all'; done.skipped++; return true; }
          choice = 'saved';
          // The picker (or the permission prompt) opens in this click, before anything is awaited.
          return writeTab(t, done).then(() => true);
        },
        onClose() { resolve(choice); },
      });
      return handle;
    });
  }

  // ---- session ui callbacks (02 §9) ---------------------------------------------------------------------------------
  function download(name, mime, text) {
    io.download(new Blob([String(text ?? '')], { type: mime || 'application/octet-stream' }), String(name ?? 'download'));
  }
  function notify(text, kind = 'info') {
    toast(String(text ?? ''), { kind: ['ok', 'warn', 'error', 'info'].includes(kind) ? kind : 'info' });
  }
  function sessionUi(tabId) {
    return Object.freeze({
      // A caller's {signal} (02 §9 ui note) is kept; the tab is always this one.
      confirmChange: (preview, o) => confirmChange(preview, { ...(isObj(o) ? o : {}), tabId }),
      confirmImpersonation: (user, o) => confirmImpersonation(user, { ...(isObj(o) ? o : {}), tabId }),
      download, notify,
      // The session calls it at the end of every run, before `done` (02 §9): that run's approvals end.
      runEnded: runId => { endApprovals(a => a.runId === runId, 'run'); },
    });
  }
  // Stop (03 §7: main.js wires the Stop button and results.stopRun() here) cancels every open confirmation as Cancel
  // and ends every standing approval (03 §8).
  function cancelPending() {
    const list = [...pending];
    endStandingApprovals('stop');
    for (const p of list) p.cancel();
    return list.length;
  }
  // A run that ended (Stop, an error) while one of its tab's confirmations is still open has stopped waiting for it:
  // that dialog is cancelled (as Cancel), so it never acts on a finished run.
  offs.push(S.on('run:end', p => {
    for (const e of [...pending]) if (e.tabId != null && e.tabId === p?.tabId) e.cancel();
  }));

  // ---- commands ------------------------------------------------------------------------------------------------------
  const cmd = (id, spec) => { if (typeof shell.command === 'function') offs.push(shell.command(id, spec)); };
  cmd('help', { run: e => { openHelpFromKey(e); } });
  cmd('settings', { run: () => { openSettings(); } });
  cmd('history', { run: () => { openHistory(); } });
  cmd('templates', { run: () => { openTemplates(); } });
  cmd('loadCsv', { run: () => loadCsv(), state: () => (st().running ? { title: runLock() } : {}) });
  cmd('fetchToSql', { run: () => { fetchToSqlDialog(); }, state: () => (fetchToSql ? {} : { disabled: true, title: 'FetchXML → SQL is not available.' }) });
  cmd('importView', { run: () => importView(), state: importViewState });
  cmd('toggleChanges', { run: () => toggleChanges() });
  cmd('revert', { run: () => revertCaller() });
  cmd('executeAs', { run: () => executeAs(), state: () => (st().running ? { disabled: true, title: 'Not available while a query is running' } : {}) });
  // The mode pill while standing approvals are active ends every one (03 §3; the pill passes 'pill').
  cmd('endStanding', { run: reason => { endStandingApprovals(reason ?? 'pill'); } });
  cmd('loadFileAsText', { run: () => loadFileAsText(), state: () => (st().running ? { title: runLock() } : {}) });
  cmd('saveAll', { run: () => saveAll() });

  function destroy() {
    cancelPending();
    endStandingApprovals('destroy');
    for (const off of offs.splice(0)) { try { off?.(); } catch { /* already removed */ } }
    help?.handle?.close();
    settingsOpen?.handle?.close();
    hist?.sheet?.close?.();
    if (current === dialogs) current = null;
  }

  const dialogs = Object.freeze({
    confirmChange, confirmImpersonation, allowChanges, toggleChanges, executeAs, revertCaller, openSettings,
    openAbout: () => openSettings('about'), openHelp, openTemplates, openHistory, openCellViewer, saveAsView, openTempView, fetchToSqlDialog,
    importView, loadCsv, loadFileAsText, saveAll, standingApprovals, endStandingApprovals, download, notify, sessionUi, cancelPending,
    confirming: () => pending.size > 0, destroy,
  });
  current = dialogs;
  return dialogs;
}

// The change confirmation of the initialised dialogs (03 §1.4): resolves {grant, backup, standing} or null.
export const confirmChange = (preview, o) => need().confirmChange(preview, o);
// The active standing approvals of the initialised dialogs (03 §1.4 Standing).
export const standingApprovals = () => need().standingApprovals();
// Ends every standing approval of the initialised dialogs; returns how many ended.
export const endStandingApprovals = reason => need().endStandingApprovals(reason);
// Opens Load file as text (picks a file when none is given).
export const loadFileAsText = file => need().loadFileAsText(file);
// Save all: writes the tabs that have a file and asks for the others in turn.
export const saveAll = () => need().saveAll();
// The impersonation confirmation of the initialised dialogs: resolves true or false.
export const confirmImpersonation = (user, o) => need().confirmImpersonation(user, o);
// Opens Allow changes; resolves true when changes are (now) allowed.
export const allowChanges = () => need().allowChanges();
// Opens the Execute as user picker.
export const executeAs = () => need().executeAs();
// Ends impersonation through the active tab's session.
export const revertCaller = () => need().revertCaller();
// Opens Settings at a section ('appearance' … 'about').
export const openSettings = section => need().openSettings(section);
// Opens Settings › About.
export const openAbout = () => need().openAbout();
// Opens Help at a section and anchor (a function name or an error code).
export const openHelp = (section, anchor) => need().openHelp(section, anchor);
// Opens the template gallery (Help › Templates).
export const openTemplates = () => need().openTemplates();
// Opens the History sheet.
export const openHistory = () => need().openHistory();
// Opens the cell viewer for a text, JSON or XML value.
export const openCellViewer = (text, kind) => need().openCellViewer(text, kind);
// Opens Save as personal view; resolves {id, name, replaced} or null.
export const saveAsView = o => need().saveAsView(o);
// Opens the results in the temp personal view SQL Studio Results, in place; resolves {id, inPlace} or null.
export const openTempView = o => need().openTempView(o);
// Opens the FetchXML → SQL dialog (optionally prefilled).
export const fetchToSqlDialog = text => need().fetchToSqlDialog(text);
// Imports the view of the host page into a new query tab.
export const importView = () => need().importView();
// Opens Load CSV as #temp for one or more files (picks them when none are given).
export const loadCsv = files => need().loadCsv(files);
// The session `ui` callbacks for one query tab (02 §9).
export const sessionUi = tabId => need().sessionUi(tabId);
// Cancels every open confirmation (Stop); returns how many there were.
export const cancelPending = () => need().cancelPending();
// True while a change or impersonation confirmation is open or waiting (main.js destroy(), 03 §11).
export const confirming = () => need().confirming();
// Downloads a text as a file (the session ui callback, 02 §9).
export const download = (name, mime, text) => need().download(name, mime, text);
// Shows a toast for a session message (the session ui callback, 02 §9).
export const notify = (text, kind) => need().notify(text, kind);
// Tears the initialised dialogs down: confirmations cancelled, approvals ended, commands unbound.
export const destroy = () => need().destroy();
