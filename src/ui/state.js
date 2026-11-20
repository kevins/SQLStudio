// App state store, event bus, settings schema and persistence (03 §2, §8.1, §10; 00 §5 rules 3, 5).
// Everything persisted goes through core/store.js (prefix 'sqlstudio:'), is validated on read (unknown shapes are
// discarded) and never contains result data: tabs are stored as {id, title, sql, caret, scroll, updatedAt} only.
// Everything works with storage disabled.
//
// Notes:
// - Exports beyond the 03 §2 list: EDITOR_FONT (the 03 §5 stack, editorFont's default), validateSettings /
//   validateLayout / validateWin / validateTabs / validateHistory (the read validators, pure), mergeTabs /
//   mergeHistory (the 03 §10 merges, pure), serializeTab, resolveTheme(theme, prefersDark) (the effective theme of a
//   settings.theme value: 'light' | 'dark', where 'auto' follows prefersDark) and cycleTheme(theme) (the theme
//   button's next value: auto -> light -> dark -> auto), setLayout(patch) (below), setWin(geom), flush() (runs every
//   pending save now, 03 §10), addHistory / deleteHistory / clearHistory / reloadHistory (History sheet;
//   reloadHistory re-reads the stored list and merges this instance's unsaved changes), pendingState() (queued
//   persistence work), setStanding / endStanding (the standing-approval mirror, below) and
//   setListenerErrorSink(fn) (below). LIMITS is named by 03 §10.
// - closeTabs(ids) returns {closed /* the entries */, skipped /* ids not closed: unknown or running */, created /* the
//   empty 'Query 1' opened after the last tab, or null */}; shell.js relies on `closed`.
// - Bus listener errors (extension of 03 §2): 03 §2 reports them through reportError()
//   or a microtask rethrow, but both raise an ErrorEvent on window that the Dynamics page's own error and telemetry
//   handlers read, an error message can quote SQL text or cell values, 03 §1.4 keeps production builds away from
//   reportError() and 00 §5 rule 5 forbids telemetry. So emit() hands every listener error to the sink registered
//   with setListenerErrorSink(fn), which returns a function that removes that sink while it is still the registered
//   one (null, or initState, removes any sink). The shell registers its error toast there at mount and removes it on
//   destroy (see the notes in shell.js), so held errors only cover the time before the mount. Without a sink the
//   production bundle (__DEV__ folded to false) never calls reportError() or console and never rethrows: it holds up
//   to 20 errors (the first ones; later ones are dropped) and delivers them, oldest first, when a sink is registered.
//   Dev builds (__DEV__ true) and the unbundled source (Node: __DEV__ not defined) raise them as 03 §2 says:
//   reportError() where it exists, else a microtask rethrow. The mode is fixed at build time, so the page cannot
//   change it. An error that a listener raises while the sink runs is delivered after that call (at most 20 per
//   round). An error thrown by the sink itself goes, with the error it was given, to reportError() or a microtask
//   outside production; in production no channel inside the tool is left, so both are dropped.
// - SETTINGS.editorFont.pattern is a frozen RegExp without flags that accepts exactly the 03 §8.1 set, written with an
//   escaped hyphen (`^[A-Za-z0-9 ,"'_\-]{1,200}$`) so that its `.source` also compiles under the `v` flag that
//   Chromium uses for an HTML `pattern` attribute: under `v` the 03 §8.1 text (`…'_-]…`) is a syntax error, and Edge
//   ignores such an attribute. As an extension, editorFont must also be a well-formed CSS font-family
//   list: comma-separated names, each either quoted ("…" or '…', non-empty, without its own quote inside) or unquoted
//   words that are CSS identifiers (a word may not start with a digit), never a bare CSS-wide keyword (inherit,
//   initial, unset, revert, revert-layer, default), and never several unquoted words of which the first is a generic
//   family keyword, ignoring case (CSS Fonts 4: serif, sans-serif, cursive, fantasy, monospace, system-ui, math,
//   emoji, fangsong, ui-serif, ui-sans-serif, ui-monospace, ui-rounded; Chromium's -webkit-body and
//   -webkit-pictograph): Chromium takes that word as the generic family and drops the declaration (`Monospace Neon`,
//   `Consolas, serif Pro`; quoted, such a name is fine). A
//   value the browser would reject (`3270, monospace`, `"x`, `a,,b`, `Cursive Standard` or only spaces) would drop
//   the whole declaration and leave the editor in the proportional UI font, so it is refused like a pattern mismatch
//   (setSetting throws a TypeError, a stored one reads as the default).
// - Standing approvals: state.standing mirrors dialogs.js's approvals for the mode pill; it is memory only and
//   initState resets it to []. setStanding(approvals) validates each 03 §1.4 Standing record (non-empty string key,
//   runId and table; op one of the ChangePreview DML ops 'update' | 'delete' | 'insert' | 'associate' |
//   'disassociate' | 'action', never 'mixed', because a grid change set never gets one, 02 §8.3; whole-number cap
//   from 1 to 250,000, the largest maxChangeRows, because N is at most settings.maxChangeRows, 03 §8, §8.1; total
//   0..cap; dangerKinds an array of strings without 'bulkdelete', because a BulkDelete job is never granted from a
//   standing approval, 00 §5 rule 2; callerId null, because an approval is never given while impersonating, 00 §5
//   rule 2; environment a string; finite usedAt; at most one record per key) and throws a TypeError for a malformed
//   one, so a bug never shows a wrong pill. The cap is checked against the schema's largest value, not the current
//   setting, so lowering maxChangeRows during a run never makes dialogs.js's total updates throw. It replaces
//   state.standing with a new array of frozen copies (other fields dropped) and emits `standing {approvals:
//   state.standing}`. endStanding(runId) ends the mirrored approvals of that run (ui.runEnded(runId)), endStanding()
//   all of them (Stop, Cancel, the pill, a caller or mode change); it emits `standing` and returns the ended records
//   only when something ended. Through these two helpers state.js emits the `standing` event on dialogs.js's behalf
//   (03 §2), so the pill always receives validated records; state.js never ends approvals on its own: dialogs.js
//   does, on the events 03 §8 lists.
// - setLayout(patch) validates the fields it is given strictly, as setSetting does: sideW and split must be finite
//   numbers (rounded and clamped to 200-520, clamped to 0.1-0.9), sideCollapsed a boolean, resPane 'normal' |
//   'hidden' | 'max', find and fetchToSql objects whose given fields are booleans, and dateOperators 'functions' |
//   'literals' | 'dateadd'. Anything else throws a TypeError naming the field, and the layout is left unchanged (no
//   field of a refused patch is applied). `find` and `fetchToSql` are merged key by key; keys the 03 §2 layout does
//   not have (own or inherited, `__proto__` included) are ignored, so a patch can never add a field. Stored layouts
//   stay lenient (validateLayout): a field of the wrong type or an unknown resPane / dateOperators value takes its
//   default alone and the other fields are kept.
// - Tab titles (03 §2) are also trimmed (String.prototype.trim: spaces, NBSP, U+FEFF and the other white space) at
//   both ends, after the control characters became spaces and again after the 100-unit cut, so a title of white
//   space and controls only is empty: createTab then uses nextTitle() and updateTab ignores it (as the shell's rename
//   does).
// - The placeholder tab that closing the last tab opens counts as used ("since it opened", 03 §2) once a bus event
//   names it with its tabId: run:start or run:end, temps with any names other than an empty array, or edits with a
//   pending count other than 0 (quiet runs and Load CSV work in the active tab's session without changing its SQL).
// - reopenTabs() throws a TypeError for an entry that is not an object. Closed entries keep no reference to the
//   entries closed with them: a closeTabs call shares only {index, open} records among its entries (for the 03 §2
//   reopen index), so an entry evicted from the 10 in closedTabs is freed once its Undo toast is gone.
// - Unsaved history work stays bounded while storage fails: additions are queued only while they are among the
//   newest 200 entries, deletions until a write succeeds. With an invalid host, history is memory only.
import * as store from '../core/store.js';

const bool = (dflt, extra) => Object.freeze({ type: 'bool', default: dflt, ...extra });
const int = (dflt, min, max, extra) => Object.freeze({ type: 'int', default: dflt, min, max, ...extra });
const choice = (dflt, values) => Object.freeze({ type: 'enum', default: dflt, values: Object.freeze(values) });
const text = (dflt, pattern) => Object.freeze({ type: 'string', default: dflt, pattern: Object.freeze(pattern) });

// The editor font stack of 03 §5 (settings.editorFont's default); the editor always appends ', monospace'.
export const EDITOR_FONT = '"Cascadia Mono",Consolas,"SF Mono",Menlo,ui-monospace';

// Settings schema (03 §8.1): key -> {type, default, min?, max?, values?, pattern?, session?, safe?, safeMax?}.
export const SETTINGS = Object.freeze({
  theme: choice('auto', ['auto', 'light', 'dark']),
  compact: bool(false),
  friendly: bool(true),
  tz: choice('local', ['local', 'utc']),
  maxRows: int(50000, 1, 500000),
  maxScanRows: int(500000, 1000, 5000000),
  maxRequests: int(500, 1, 10000),
  columnOrder: choice('alpha', ['alpha', 'schema']),
  fontSize: int(13, 11, 18),
  editorFont: text(EDITOR_FONT, /^[A-Za-z0-9 ,"'_\-]{1,200}$/),
  gridFontSize: int(13, 11, 16),
  hoverCards: bool(true),
  localDates: bool(false),
  quotedIdentifiers: bool(true),
  wordWrap: bool(false),
  autocomplete: bool(true),
  autoClose: bool(true),
  showWarnings: bool(true),
  batchSize: int(50, 1, 1000),
  maxdop: int(0, 0, 32),
  maxChangeRows: int(5000, 1, 250000, { safeMax: 5000 }),
  backupBeforeDelete: bool(false),
  csvNeutralize: bool(true, { safe: true }),
  keepHistory: bool(true),
  restoreTabs: bool(true),
  queryInBody: bool(false),
  noPushdown: bool(false),
  allowUnfiltered: bool(false, { session: true, safe: false }),
});

const KEYS = Object.keys(SETTINGS);
const STORED_KEYS = KEYS.filter(k => !SETTINGS[k].session);
const K_SETTINGS = 'v1:settings', K_LAYOUT = 'v1:layout', K_WIN = 'v1:win';
const SAVE_MS = 500, SAVE_MAX_MS = 2000;
// Storage limits of 03 §10 (sizes in characters: SQL text for tabSql/historySql, stored JSON for the totals) and the
// closed-tab and history caps.
export const LIMITS = Object.freeze({ tabs: 50, tabSql: 100 * 1024, tabsTotal: 200 * 1024, closed: 10, history: 200, historySql: 100 * 1024, historyTotal: 1024 * 1024 });
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STATUS = new Set(['ok', 'error', 'cancelled']);
const MODES = new Set(['all', 'selection', 'statement']);
const TITLE_MAX = 100;
const RES_PANE = new Set(['normal', 'hidden', 'max']);
const FIND_KEYS = ['matchCase', 'wholeWord', 'regex'];
const DATE_OPERATORS = new Set(['functions', 'literals', 'dateadd']);
const TAB_PATCH = new Set(['title', 'sql', 'caret', 'scroll', 'dirty', 'file']);

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---- settings ---------------------------------------------------------------------------------------------------

function defaults() {
  const o = {};
  for (const k of KEYS) o[k] = SETTINGS[k].default;
  return o;
}

// CSS-wide keywords (and the reserved 'default') that are never a font family when unquoted (CSS Fonts 4 §2.1).
const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default']);
// Generic family keywords (CSS Fonts 4 §2.1.1, plus Chromium's -webkit-body and -webkit-pictograph): Chromium reads
// such a first word as the generic family, so an unquoted name of several words may not start with one.
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'cursive', 'fantasy', 'monospace', 'system-ui', 'math', 'emoji', 'fangsong',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-webkit-body', '-webkit-pictograph']);
const FONT_WORD = /^(?:-?[A-Za-z_]|--)[A-Za-z0-9_-]*$/;

// True when s is a well-formed CSS font-family list: comma-separated names, each quoted or made of CSS identifier
// words, never empty, never a bare CSS-wide keyword and never words that start with a generic family (see the notes
// above).
function isFontList(s) {
  const items = [];
  let cur = '', quote = null;
  for (const c of s) {
    if (quote) { if (c === quote) quote = null; cur += c; continue; }
    if (c === '"' || c === "'") quote = c;
    if (c === ',') { items.push(cur); cur = ''; } else cur += c;
  }
  if (quote) return false;
  items.push(cur);
  return items.every(item => {
    const t = item.trim();
    if (t[0] === '"' || t[0] === "'") return t.length > 2 && t.endsWith(t[0]) && !t.slice(1, -1).includes(t[0]) && t.slice(1, -1).trim() !== '';
    const words = t.split(/ +/);
    if (t === '' || !words.every(w => FONT_WORD.test(w))) return false;
    const first = words[0].toLowerCase();
    return words.length === 1 ? !CSS_WIDE.has(first) : !GENERIC_FAMILIES.has(first);
  });
}

// Extra checks of string settings beyond their pattern, with the message setSetting throws.
const STRING_RULES = Object.freeze({
  editorFont: {
    ok: isFontList,
    message: `Setting 'editorFont' must be font names separated by commas (at most 200 characters: letters, digits, spaces and , " ' _ -); put a name in quotes when one of its words starts with a digit or its first word is a generic family such as monospace or serif.`,
  },
});

// True when v is a valid value of the string setting `key`: a string matching its pattern and its extra rule.
function validString(key, v) {
  const rule = own(STRING_RULES, key) ? STRING_RULES[key] : null;
  return typeof v === 'string' && SETTINGS[key].pattern.test(v) && (!rule || rule.ok(v));
}

// One stored setting value, validated leniently: wrong type -> default, numbers rounded and clamped, unsafe -> safe.
function readValue(key, v) {
  const s = SETTINGS[key];
  if (s.session) return s.default;
  let out = s.default;
  if (s.type === 'bool') out = typeof v === 'boolean' ? v : s.default;
  else if (s.type === 'enum') out = s.values.includes(v) ? v : s.default;
  else if (s.type === 'string') out = validString(key, v) ? v : s.default;
  else if (isNum(v)) out = clampN(Math.round(v), s.min, s.max);
  if (s.safe !== undefined && out !== s.safe) out = s.safe;
  if (s.safeMax !== undefined && out > s.safeMax) out = s.safeMax;
  return out;
}

// Validated settings object from a stored value (03 §8.1): every key present; session-only keys at their default.
export function validateSettings(raw) {
  const o = defaults();
  if (!isObj(raw)) return o;
  for (const k of STORED_KEYS) if (own(raw, k)) o[k] = readValue(k, raw[k]);
  return o;
}

// True when `value` relaxes a safety rule (00 §5 rule 3): it is then session-only and needs a confirmation.
export function isRelaxing(key, value) {
  const s = own(SETTINGS, key) ? SETTINGS[key] : null;
  if (!s) return false;
  if (s.type === 'bool' && s.safe !== undefined) return value !== s.safe;
  if (s.type === 'int' && s.safeMax !== undefined) return isNum(value) && Math.round(value) > s.safeMax;
  return false;
}

// Strictly validated value for setSetting: throws on an unknown key, a wrong type, an unknown enum value or a string
// that does not match its pattern.
function checkValue(key, v) {
  const s = own(SETTINGS, key) ? SETTINGS[key] : null;
  if (!s) throw new Error(`Unknown setting '${key}'.`);
  if (s.type === 'bool') { if (typeof v !== 'boolean') throw new TypeError(`Setting '${key}' must be true or false.`); return v; }
  if (s.type === 'enum') { if (!s.values.includes(v)) throw new TypeError(`Setting '${key}' must be one of ${s.values.join(', ')}.`); return v; }
  if (s.type === 'string') {
    if (typeof v !== 'string') throw new TypeError(`Setting '${key}' must be a string.`);
    if (!validString(key, v)) throw new TypeError(own(STRING_RULES, key) ? STRING_RULES[key].message : `Setting '${key}' must match ${s.pattern.source}.`);
    return v;
  }
  if (!isNum(v)) throw new TypeError(`Setting '${key}' must be a number from ${s.min} to ${s.max}.`);
  return clampN(Math.round(v), s.min, s.max);
}

let current = defaults();       // the live values, session-only ones included
let persisted = defaults();     // the last safe values, i.e. what may be stored
let snapshot = null;            // frozen copy of `current`, rebuilt after a change
const dirtySettings = new Set();

// Frozen, validated snapshot of every setting (03 §8.1); the same object until a setting changes.
export function getSettings() {
  if (!snapshot) snapshot = Object.freeze({ ...current });
  return snapshot;
}

// Change one setting (validated strictly, 03 §8.1; editorFont also as a font-family list, see the notes above): emits
// `settings {keys}` and returns true when it changed.
export function setSetting(key, value, opts) {
  const v = checkValue(key, value);
  const s = SETTINGS[key];
  // Only the boolean true is a confirmation: 'false', 1 or {} are not (00 §5 rule 3).
  const confirmed = opts != null && typeof opts === 'object' && opts.confirmed === true;
  if (isRelaxing(key, v) && !confirmed) throw new Error(`Setting '${key}' to ${v} relaxes a safety rule and needs the user's confirmation.`);
  if (current[key] === v) return false;
  current[key] = v;
  snapshot = null;
  state.settings = getSettings();
  // Every change to a storable value is written (03 §10 "per changed key"), also one back to the last safe value
  // after a session-only one: another browser tab may have stored a different value meanwhile.
  if (!s.session && !isRelaxing(key, v)) {
    persisted[key] = v;
    dirtySettings.add(key);
    save('settings');
  }
  if (key === 'restoreTabs') {
    if (v) { clearedTabs.clear(); save('tabs'); }
    else { cancelSave('tabs'); unsaved.clear(); closedIds.clear(); if (host) store.del(tabsKey()); }
  }
  if (key === 'keepHistory' && !v) dropUnsavedHistory();
  emit('settings', { keys: [key] });
  return true;
}

// Effective theme for a settings.theme value: 'auto' follows prefers-color-scheme (03 §4).
export function resolveTheme(theme, prefersDark) {
  return theme === 'dark' || (theme !== 'light' && !!prefersDark) ? 'dark' : 'light';
}

// Next value of the top-bar theme button: auto -> light -> dark -> auto.
export function cycleTheme(theme) {
  return theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
}

let appliedTheme = null;        // the effective theme the shell last applied to .ss[data-theme], or null

// Record the effective theme the shell applied ('light' | 'dark'); emits `theme {theme}` and returns true when it
// changed (03 §2 theme and mode mirrors, §4).
export function setResolvedTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') throw new TypeError(`setResolvedTheme(): expected 'light' or 'dark', got ${typeof theme === 'string' ? `'${theme}'` : typeof theme}.`);
  if (appliedTheme === theme) return false;
  appliedTheme = theme;
  emit('theme', { theme });
  return true;
}

// The effective theme last passed to setResolvedTheme ('light' | 'dark'), or null before the shell applied one.
export function getResolvedTheme() { return appliedTheme; }

// ---- state and event bus ------------------------------------------------------------------------------------------

const LAYOUT_DEFAULT = Object.freeze({
  sideW: 280, sideCollapsed: false, split: 0.45, resPane: 'normal', find: Object.freeze({ matchCase: false, wholeWord: false, regex: false }),
  fetchToSql: Object.freeze({ variables: false, dateOperators: 'functions', utc: false }),
});
const freshLayout = () => ({ ...LAYOUT_DEFAULT, find: { ...LAYOUT_DEFAULT.find }, fetchToSql: { ...LAYOUT_DEFAULT.fetchToSql } });
const freshWin = () => ({ x: null, y: null, w: null, h: null, max: false });
// Until RetrieveCurrentOrganization returns, the environment counts as Production and is still being checked (03 §11).
const freshEnv = () => ({ type: null, isProduction: true, checking: true });

// The app state (03 §2). Results, sessions, the change log and file handles are memory only.
export const state = {
  env: freshEnv(),
  user: null,
  settings: getSettings(),
  tabs: [],
  activeTab: null,
  results: new Map(),
  sessions: new Map(),
  changeLog: null,
  closedTabs: [],
  running: null,
  allowChanges: false,
  changesExpireAt: null,
  impersonating: null,
  standing: [],
  history: [],
  layout: freshLayout(),
  win: freshWin(),
};

const listeners = new Map();

// Subscribe to a bus event; returns the unsubscribe function (idempotent).
export function on(type, cb) {
  if (typeof cb !== 'function') throw new TypeError('on(): the listener must be a function.');
  let set = listeners.get(type);
  if (!set) listeners.set(type, set = new Set());
  const entry = { cb };
  set.add(entry);
  return () => { set.delete(entry); };
}

const HELD_MAX = 20;            // listener errors held for the sink at a time, and delivered per round
let errorSink = null;           // where listener errors go (setListenerErrorSink), or null
const heldErrors = [];          // listener errors waiting for the sink (see the notes above)
let sinking = false;            // true while the sink runs

// True in the production bundle, where build.mjs folds __DEV__ to false: listener errors never reach the page there.
// Dev builds (__DEV__ true) and the unbundled source (Node, __DEV__ not defined) are not production.
const isProduction = () => typeof __DEV__ !== 'undefined' && !__DEV__;

// Outside production: hand an error to reportError() where it exists, else rethrow it from a microtask (03 §2).
function raise(e) {
  try {
    if (typeof globalThis.reportError === 'function') { globalThis.reportError(e); return; }
  } catch { /* a broken reportError: fall back to the microtask below, so `e` still surfaces */ }
  queueMicrotask(() => { throw e; });
}

// Deliver the held errors to the sink, oldest first, at most HELD_MAX per round, so a sink whose own work keeps
// raising listener errors cannot loop forever. Outside production, errors with no sink to take them are raised.
function drainErrors() {
  if (sinking) return;
  sinking = true;
  try {
    for (let n = 0; n < HELD_MAX && heldErrors.length; n++) {
      if (!errorSink) {
        if (isProduction()) break;
        raise(heldErrors.shift());
        continue;
      }
      const e = heldErrors.shift();
      try { errorSink(e); } catch (sinkError) { if (!isProduction()) { raise(e); raise(sinkError); } }
    }
  } finally { sinking = false; }
}

// Report a listener error without throwing to the emitter: to the sink, else held (production) or raised (see
// the notes above).
function reportListenerError(e) {
  if (heldErrors.length < HELD_MAX) heldErrors.push(e);
  drainErrors();
}

// Register where bus listener errors go (the shell's error toast), or null for none; held errors are delivered at
// once. Returns a function that removes this sink while it is still the registered one.
export function setListenerErrorSink(fn) {
  if (fn !== null && typeof fn !== 'function') throw new TypeError('setListenerErrorSink(): expected a function or null.');
  errorSink = fn;
  drainErrors();
  return () => { if (fn !== null && errorSink === fn) errorSink = null; };
}

// True when a bus event shows the tab it names in use: a run, #temp tables or pending grid edits (03 §2). The
// placeholder tab such an event names is no longer removable (see the notes above).
function usesTab(type, p) {
  if (type === 'run:start' || type === 'run:end') return true;
  if (type === 'temps') return !(Array.isArray(p.names) && p.names.length === 0);
  if (type === 'edits') return p.pending !== 0;
  return false;
}

// Call every listener of `type` with payload (a snapshot of the listeners); never throws (errors are reported).
export function emit(type, payload = {}) {
  if (placeholderId !== null && isObj(payload) && payload.tabId === placeholderId && usesTab(type, payload)) placeholderId = null;
  const set = listeners.get(type);
  if (!set || !set.size) return;
  for (const { cb } of [...set]) {
    try { cb(payload); } catch (e) { reportListenerError(e); }
  }
}

// Mirror api mode and caller changes into state and onto the bus (api.onModeChange listener, 03 §2).
export function mirrorMode({ allowed, expiresAt = null, caller = null } = {}) {
  const user = caller && caller.id ? { id: String(caller.id), name: String(caller.name ?? '') } : null;
  const changedUser = (state.impersonating?.id ?? null) !== (user?.id ?? null) || (user && state.impersonating?.name !== user.name);
  state.allowChanges = !!allowed;
  state.changesExpireAt = allowed && isNum(expiresAt) ? expiresAt : null;
  state.impersonating = user;
  emit('changes:mode', { allowed: state.allowChanges, expiresAt: state.changesExpireAt });
  if (changedUser) emit('impersonate', { user });
}

// ---- standing approvals ------------------------------------------------------------------------------------

// The ChangePreview ops (02 §8.2) a standing approval can be for: every DML op except 'mixed' (a grid change set).
const STANDING_OPS = new Set(['update', 'delete', 'insert', 'associate', 'disassociate', 'action']);
// The largest cap N: N is at most settings.maxChangeRows (03 §8), whose largest value is 250,000 (§8.1).
const CAP_MAX = SETTINGS.maxChangeRows.max;

// A validated, frozen copy of one 03 §1.4 Standing record (only its fields, each read once, so a getter cannot pass
// the check with one value and be copied with another); throws a TypeError naming the problem.
function cleanStanding(r, n) {
  const bad = what => new TypeError(`setStanding(): approval ${n} ${what}.`);
  if (!isObj(r)) throw bad('is not an object');
  const { key, runId, op, table, cap, total, dangerKinds, callerId, environment, usedAt } = r;
  for (const [name, v] of [['key', key], ['runId', runId], ['op', op], ['table', table]]) if (typeof v !== 'string' || v === '') throw bad(`needs a non-empty string ${name}`);
  if (op === 'mixed') throw bad("has op 'mixed': a grid change set never gets a standing approval");
  if (!STANDING_OPS.has(op)) throw bad(`needs op ${[...STANDING_OPS].join(', ')}`);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > CAP_MAX) throw bad(`needs a whole-number cap from 1 to ${CAP_MAX}, the largest maxChangeRows`);
  if (!Number.isSafeInteger(total) || total < 0 || total > cap) throw bad('needs a whole-number total from 0 to its cap');
  const kinds = Array.isArray(dangerKinds) ? [...dangerKinds] : null;
  if (!kinds || !kinds.every(d => typeof d === 'string')) throw bad('needs dangerKinds as an array of strings');
  if (kinds.some(d => d.toLowerCase() === 'bulkdelete')) throw bad("has 'bulkdelete' in dangerKinds: a BulkDelete job is never granted from a standing approval");
  if (callerId !== null) throw bad('needs callerId null: a standing approval is never given while impersonating');
  if (typeof environment !== 'string') throw bad('needs a string environment');
  if (!isNum(usedAt)) throw bad('needs a finite usedAt');
  return Object.freeze({ key, runId, op, table, cap, total, dangerKinds: Object.freeze(kinds), callerId: null, environment, usedAt });
}

// Mirror dialogs.js's active standing approvals into state.standing (validated frozen copies) and emit
// `standing {approvals}` (03 §2, §3; see the notes above). Returns state.standing.
export function setStanding(approvals) {
  if (!Array.isArray(approvals)) throw new TypeError('setStanding(): expected an array of standing approvals.');
  const list = Array.from(approvals, (r, i) => cleanStanding(r, i + 1)); // holes count as missing records
  const keys = new Set();
  for (const r of list) {
    if (keys.has(r.key)) throw new TypeError(`setStanding(): two approvals have the statement key ${r.key}; there is at most one per statement.`);
    keys.add(r.key);
  }
  state.standing = list;
  emit('standing', { approvals: state.standing });
  return state.standing;
}

// End the mirrored standing approvals of one run (ui.runEnded(runId)), or every one without a runId; emits
// `standing` when any ended and returns the ended records.
export function endStanding(runId) {
  if (runId !== undefined && (typeof runId !== 'string' || runId === '')) throw new TypeError('endStanding(): expected a run id or nothing.');
  if (!Array.isArray(state.standing)) { state.standing = []; emit('standing', { approvals: state.standing }); return []; }
  const list = state.standing;
  const ended = runId === undefined ? list : list.filter(a => a?.runId === runId);
  if (!ended.length) return [];
  state.standing = runId === undefined ? [] : list.filter(a => a?.runId !== runId);
  emit('standing', { approvals: state.standing });
  return ended;
}

// ---- lifecycle ---------------------------------------------------------------------------------------------------

let host = null;
let nowFn = () => Date.now();
let detach = null;
const pending = new Map();      // part -> {first, timer}
const failed = new Set();       // parts whose last write failed
const closedIds = new Set();    // tab ids this instance closed since its last successful tabs write
const unsaved = new Map();      // tab id -> reason it was last left out of storage
const historyAdds = new Map();  // history entries added since the last successful history write (id -> entry)
const historyDeletes = new Set();
const clearedTabs = new Map();  // tab id -> updatedAt when Clear history ran: not written again until it changes
const closedBatch = new WeakMap(); // closed-tab entry -> {mark, batch}: its {index, open} record and its closeTabs call's records
const reopened = new WeakSet(); // closed-tab entries already reopened
let placeholderId = null;       // the empty tab opened when the last tab was closed

const tabsKey = () => 'v1:tabs:' + host;
const historyKey = () => 'v1:history:' + host;

// Reset the store and load the persisted parts (03 §2 Lifecycle); returns dispose().
export function initState({ host: h, now } = {}) {
  if (detach) detach();
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear(); failed.clear(); closedIds.clear(); unsaved.clear(); historyAdds.clear(); historyDeletes.clear(); dirtySettings.clear();
  clearedTabs.clear();
  placeholderId = null;
  appliedTheme = null;
  errorSink = null;
  heldErrors.length = 0;
  nowFn = typeof now === 'function' ? now : () => Date.now();
  const raw = h ?? globalThis.location?.hostname ?? '';
  host = /^(?:[a-z0-9.-]{1,253}|\[[0-9a-f:.]{2,45}\])$/i.test(String(raw)) ? String(raw).toLowerCase() : null;
  current = validateSettings(store.get(K_SETTINGS));
  persisted = { ...current };
  snapshot = null;
  state.tabs.length = 0;
  state.closedTabs.length = 0;
  Object.assign(state, {
    env: freshEnv(), user: null, settings: getSettings(), activeTab: null, results: new Map(), sessions: new Map(),
    changeLog: null, running: null, allowChanges: false, changesExpireAt: null, impersonating: null, standing: [],
    history: host ? validateHistory(store.get(historyKey())) : [],
    layout: validateLayout(store.get(K_LAYOUT)), win: validateWin(store.get(K_WIN)),
  });
  const win = globalThis.window, doc = globalThis.document;
  const onHide = () => flush();
  const onVis = () => { if (doc.visibilityState === 'hidden') flush(); };
  win?.addEventListener?.('pagehide', onHide);
  doc?.addEventListener?.('visibilitychange', onVis);
  let done = false;
  detach = () => {
    if (done) return;
    done = true;
    win?.removeEventListener?.('pagehide', onHide);
    doc?.removeEventListener?.('visibilitychange', onVis);
    detach = null;
  };
  const d = detach;
  return () => { flush(); d(); };
}

// ---- persistence --------------------------------------------------------------------------------------------------

const WRITERS = { settings: writeSettings, layout: writeLayout, win: writeWin, tabs: writeTabs, history: writeHistory };

// Schedule a debounced write of one persisted part: 'settings' | 'layout' | 'win' | 'tabs' | 'history'.
export function save(part) {
  if (!own(WRITERS, part)) throw new Error(`Unknown state part '${part}'.`);
  const t = nowFn();
  const p = pending.get(part);
  if (p) clearTimeout(p.timer);
  const first = p ? p.first : t;
  const delay = Math.max(0, Math.min(SAVE_MS, first + SAVE_MAX_MS - t));
  pending.set(part, { first, timer: setTimeout(() => runSave(part), delay) });
}

// Run every pending save now (pagehide, visibilitychange to hidden, destroy).
export function flush() {
  for (const part of [...pending.keys()]) runSave(part);
}

// Sizes of this instance's unsaved persistence work: pending parts and queued items.
export function pendingState() {
  return { parts: [...pending.keys()], historyAdds: historyAdds.size, historyDeletes: historyDeletes.size, closedIds: closedIds.size, unsaved: unsaved.size, clearedTabs: clearedTabs.size };
}

function cancelSave(part) {
  const p = pending.get(part);
  if (p) { clearTimeout(p.timer); pending.delete(part); }
}

function runSave(part) {
  cancelSave(part);
  const ok = WRITERS[part]();
  if (ok === false) {
    if (!failed.has(part)) { failed.add(part); emit('save:failed', { part }); }
  } else failed.delete(part);
}

function writeSettings() {
  if (!dirtySettings.size) return true;
  const stored = validateSettings(store.get(K_SETTINGS));
  const out = {};
  for (const k of STORED_KEYS) out[k] = dirtySettings.has(k) ? persisted[k] : stored[k];
  const ok = store.set(K_SETTINGS, out);
  if (ok) dirtySettings.clear();
  return ok;
}

function writeLayout() { return store.set(K_LAYOUT, validateLayout(state.layout)); }
function writeWin() { return store.set(K_WIN, validateWin(state.win)); }

// ---- layout and window --------------------------------------------------------------------------------------------

// Validated layout (03 §2, §10): defaults for anything missing or of the wrong type, numbers clamped.
export function validateLayout(raw) {
  const o = freshLayout();
  if (!isObj(raw)) return o;
  if (isNum(raw.sideW)) o.sideW = clampN(Math.round(raw.sideW), 200, 520);
  if (typeof raw.sideCollapsed === 'boolean') o.sideCollapsed = raw.sideCollapsed;
  if (isNum(raw.split)) o.split = clampN(raw.split, 0.1, 0.9);
  if (RES_PANE.has(raw.resPane)) o.resPane = raw.resPane;
  if (isObj(raw.find)) for (const k of FIND_KEYS) if (typeof raw.find[k] === 'boolean') o.find[k] = raw.find[k];
  const f = raw.fetchToSql;
  if (isObj(f)) {
    if (typeof f.variables === 'boolean') o.fetchToSql.variables = f.variables;
    if (DATE_OPERATORS.has(f.dateOperators)) o.fetchToSql.dateOperators = f.dateOperators;
    if (typeof f.utc === 'boolean') o.fetchToSql.utc = f.utc;
  }
  return o;
}

// Validated window geometry: {x, y, w, h} all finite (w, h > 0, rounded) or all null; max boolean.
export function validateWin(raw) {
  const o = freshWin();
  if (!isObj(raw)) return o;
  const { x, y, w, h } = raw;
  if ([x, y, w, h].every(isNum) && w > 0 && h > 0) Object.assign(o, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  o.max = raw.max === true;
  return o;
}

// The boolean fields of a `find` or `fetchToSql` patch, checked strictly into `into` (own fields only).
function patchBools(name, p, keys, into) {
  for (const k of keys) {
    if (!own(p, k)) continue;
    const v = p[k];
    if (typeof v !== 'boolean') throw new TypeError(`setLayout(): ${name}.${k} must be true or false.`);
    into[k] = v;
  }
}

// Merge a partial layout (the find and FetchXML → SQL options key by key), validated strictly: a field of the wrong
// type or an unknown value throws a TypeError and changes nothing (see the notes above). Saves and returns the layout.
export function setLayout(patch) {
  if (!isObj(patch)) throw new TypeError('setLayout(): expected an object.');
  const cur = validateLayout(state.layout);
  const next = { ...cur, find: { ...cur.find }, fetchToSql: { ...cur.fetchToSql } };
  if (own(patch, 'sideW')) {
    const v = patch.sideW;
    if (!isNum(v)) throw new TypeError('setLayout(): sideW must be a number from 200 to 520.');
    next.sideW = clampN(Math.round(v), 200, 520);
  }
  if (own(patch, 'sideCollapsed')) {
    const v = patch.sideCollapsed;
    if (typeof v !== 'boolean') throw new TypeError('setLayout(): sideCollapsed must be true or false.');
    next.sideCollapsed = v;
  }
  if (own(patch, 'split')) {
    const v = patch.split;
    if (!isNum(v)) throw new TypeError('setLayout(): split must be a number from 0.1 to 0.9.');
    next.split = clampN(v, 0.1, 0.9);
  }
  if (own(patch, 'resPane')) {
    const v = patch.resPane;
    if (!RES_PANE.has(v)) throw new TypeError(`setLayout(): resPane must be one of ${[...RES_PANE].join(', ')}.`);
    next.resPane = v;
  }
  if (own(patch, 'find')) {
    const f = patch.find;
    if (!isObj(f)) throw new TypeError('setLayout(): find must be an object.');
    patchBools('find', f, FIND_KEYS, next.find);
  }
  if (own(patch, 'fetchToSql')) {
    const f = patch.fetchToSql;
    if (!isObj(f)) throw new TypeError('setLayout(): fetchToSql must be an object.');
    patchBools('fetchToSql', f, ['variables', 'utc'], next.fetchToSql);
    if (own(f, 'dateOperators')) {
      const v = f.dateOperators;
      if (!DATE_OPERATORS.has(v)) throw new TypeError(`setLayout(): fetchToSql.dateOperators must be one of ${[...DATE_OPERATORS].join(', ')}.`);
      next.fetchToSql.dateOperators = v;
    }
  }
  state.layout = next;
  save('layout');
  return state.layout;
}

// Set the window geometry (validated) and save it.
export function setWin(geom) {
  if (!isObj(geom)) throw new TypeError('setWin(): expected an object.');
  state.win = validateWin({ ...state.win, ...geom });
  save('win');
  return state.win;
}

// Advanced › Reset layout: the default layout (all of 03 §2's, the find and FetchXML → SQL options included) and
// window geometry, stored copies removed; emits `layout {}`.
export function resetLayout() {
  cancelSave('layout'); cancelSave('win');
  state.layout = freshLayout();
  state.win = freshWin();
  store.del(K_LAYOUT);
  store.del(K_WIN);
  emit('layout', {});
}

// ---- tabs ---------------------------------------------------------------------------------------------------------

function newId(prefix) {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  let s = prefix;
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

let graphemes = null;           // Intl.Segmenter, created on the first title that needs cutting

// The longest prefix of `s` of at most `max` UTF-16 code units that ends at a grapheme boundary. A single cluster
// longer than `max` (e.g. hundreds of combining marks) is cut at the last code point boundary instead.
function cutAtGrapheme(s, max) {
  if (s.length <= max) return s;
  graphemes ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  let end = 0;
  for (const { index, segment } of graphemes.segment(s)) {
    if (index + segment.length > max) break;
    end = index + segment.length;
  }
  if (!end) {
    end = max;
    const c = s.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--;
  }
  return s.slice(0, end);
}

// A displayable tab title (03 §2): well-formed, bidi formatting characters removed, each control character (C0,
// DEL, C1, U+2028, U+2029) a space of its own, trimmed (see the notes above), at most 100 code units.
function cleanTitle(t) {
  if (typeof t !== 'string') return '';
  const s = t.toWellFormed().replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  return cutAtGrapheme(s.trim(), TITLE_MAX).trim();
}

// The next free 'Query <n>' title for a list of tabs: 1 + the highest n in use.
export function nextTitle(tabs = state.tabs) {
  let n = 0;
  for (const t of tabs) {
    const m = /^Query (\d{1,9})$/.exec(t.title);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return 'Query ' + (n + 1);
}

function cleanCaret(c, len) {
  if (!Array.isArray(c) || c.length !== 2 || !c.every(isNum)) return [len, len];
  return [clampN(Math.round(c[0]), 0, len), clampN(Math.round(c[1]), 0, len)];
}

const cleanScroll = s => (isNum(s) && s > 0 ? Math.round(s) : 0);

// The persisted form of a tab: exactly {id, title, sql, caret, scroll, updatedAt} (00 §5 rule 5).
export function serializeTab(tab) {
  const sql = String(tab.sql ?? '');
  return { id: String(tab.id), title: String(tab.title), sql, caret: cleanCaret(tab.caret, sql.length), scroll: cleanScroll(tab.scroll), updatedAt: isNum(tab.updatedAt) ? tab.updatedAt : 0 };
}

// Characters a serialized tab adds to the stored list (its JSON plus the separating comma), or Infinity when it
// cannot fit in `room`. The JSON of {id, title, sql, caret, scroll, updatedAt} has at least 64 characters besides
// the id, title and SQL text, so a tab that cannot fit is rejected without stringifying its SQL.
function storedSize(tab, room) {
  if (tab.id.length + tab.title.length + tab.sql.length + 64 > room) return Infinity;
  const n = JSON.stringify(tab).length + 1;
  return n > room ? Infinity : n;
}

// Validated stored tab list: valid entries only (ids unique, SQL <= 100 KB), at most 50 and 200 KB of JSON in all.
export function validateTabs(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set();
  let total = 2;
  for (const t of raw) {
    if (out.length >= LIMITS.tabs) break;
    if (!isObj(t) || typeof t.id !== 'string' || !ID_RE.test(t.id) || seen.has(t.id) || typeof t.sql !== 'string') continue;
    if (t.sql.length > LIMITS.tabSql) continue;
    const tab = serializeTab({ id: t.id, title: cleanTitle(t.title), sql: t.sql, caret: t.caret, scroll: t.scroll, updatedAt: t.updatedAt });
    const size = storedSize(tab, LIMITS.tabsTotal - total);
    if (size === Infinity) continue;
    seen.add(t.id);
    total += size;
    out.push(tab);
  }
  for (const t of out) if (!t.title) t.title = nextTitle(out);
  return out;
}

// Per-tab merge (03 §10): this instance's tabs (newer wins on updatedAt) in display order, then the other stored
// tabs in stored order, minus the closed ids; then the 50 most recent and the size limits. Returns {list, skipped}.
export function mergeTabs(stored, local, closed = new Set()) {
  const byId = new Map(stored.map(t => [t.id, t]));
  const mine = new Set(local.map(t => t.id));
  const skipped = [];
  const merged = [];
  for (const t of local) {
    const s = byId.get(t.id);
    const tab = s && s.updatedAt > t.updatedAt ? s : t;
    if (tab.sql.length > LIMITS.tabSql) skipped.push({ id: t.id, reason: 'size' });
    else merged.push({ tab, mine: true });
  }
  for (const s of stored) if (!mine.has(s.id) && !closed.has(s.id)) merged.push({ tab: s, mine: false });
  let keep = merged;
  if (merged.length > LIMITS.tabs) {
    const cut = new Set(merged.map((m, i) => [m, i]).sort((a, b) => b[0].tab.updatedAt - a[0].tab.updatedAt || a[1] - b[1]).slice(LIMITS.tabs).map(([m]) => m));
    keep = merged.filter(m => !cut.has(m));
    for (const m of cut) if (m.mine) skipped.push({ id: m.tab.id, reason: 'count' });
  }
  const list = [];
  let total = 2;
  for (const m of keep) {
    const size = storedSize(m.tab, LIMITS.tabsTotal - total);
    if (size === Infinity) { if (m.mine) skipped.push({ id: m.tab.id, reason: 'size' }); continue; }
    total += size;
    list.push(m.tab);
  }
  return { list, skipped };
}

// This instance's tabs as written: serialized, without the tabs left unchanged since Clear history.
function localTabs() {
  const out = [];
  for (const t of state.tabs) {
    if (clearedTabs.has(t.id)) {
      if (clearedTabs.get(t.id) === t.updatedAt) continue;
      clearedTabs.delete(t.id);
    }
    out.push(serializeTab(t));
  }
  return out;
}

function writeTabs() {
  if (!host || !current.restoreTabs) { closedIds.clear(); return true; }
  const stored = validateTabs(store.get(tabsKey()));
  const { list, skipped } = mergeTabs(stored, localTabs(), closedIds);
  if (list.length) { if (!store.set(tabsKey(), list)) return false; } else store.del(tabsKey());
  closedIds.clear();
  const fresh = { size: [], count: [] };
  const skippedIds = new Set();
  for (const { id, reason } of skipped) {
    skippedIds.add(id);
    if (unsaved.get(id) !== reason) { unsaved.set(id, reason); fresh[reason].push(id); }
  }
  for (const id of [...unsaved.keys()]) if (!skippedIds.has(id)) unsaved.delete(id);
  for (const reason of ['size', 'count']) if (fresh[reason].length) emit('tabs:unsaved', { tabIds: fresh[reason], reason });
  return true;
}

const findTab = id => state.tabs.find(t => t.id === id) || null;

// The tab with this id, or null.
export function getTab(id) { return findTab(id); }

function makeTab(init, id) {
  const sql = typeof init.sql === 'string' ? init.sql : '';
  return {
    id, title: cleanTitle(init.title) || nextTitle(), sql, caret: cleanCaret(init.caret, sql.length), scroll: cleanScroll(init.scroll),
    dirty: init.dirty === true, updatedAt: nowFn(), file: init.file ?? null,
  };
}

function activate(id) {
  if (state.activeTab === id) return false;
  state.activeTab = id;
  return true;
}

// Open a new query tab ({title?, sql?, caret?, scroll?, dirty?, file?}) at `index` (default: the end).
export function createTab(init = {}, { index, activate: act = true } = {}) {
  const tab = makeTab(isObj(init) ? init : {}, newId('t'));
  const at = isNum(index) ? clampN(Math.round(index), 0, state.tabs.length) : state.tabs.length;
  state.tabs.splice(at, 0, tab);
  const changed = act || !state.activeTab ? activate(tab.id) : false;
  save('tabs');
  emit('tab:list', {});
  if (changed) emit('tab:changed', { tabId: tab.id });
  return tab;
}

// Open the stored tabs (when restoreTabs is on; ids already open are skipped); the most recently updated becomes
// active. Returns the tabs.
export function restoreSavedTabs() {
  if (!host || !current.restoreTabs) return [];
  const open = new Set(state.tabs.map(t => t.id));
  const list = validateTabs(store.get(tabsKey())).filter(t => !open.has(t.id));
  if (!list.length) return [];
  const tabs = list.map(t => ({ ...t, dirty: false, file: null }));
  state.tabs.push(...tabs);
  let latest = tabs[0];
  for (const t of tabs) if (t.updatedAt > latest.updatedAt) latest = t;
  const changed = activate(latest.id);
  emit('tab:list', {});
  if (changed) emit('tab:changed', { tabId: latest.id });
  return tabs;
}

// Close tabs (03 §3): returns {closed: [{title, sql, caret, scroll, index}], skipped: ids, created: tab|null}.
export function closeTabs(ids) {
  const want = new Set(Array.isArray(ids) ? ids : [ids]);
  const runId = state.running?.tabId ?? null;
  const closed = [], skipped = [];
  for (const id of want) if (!findTab(id) || id === runId) skipped.push(id);
  const activeIndex = state.tabs.findIndex(t => t.id === state.activeTab);
  const keep = [];
  state.tabs.forEach((t, i) => {
    if (want.has(t.id) && t.id !== runId) {
      closed.push({ title: t.title, sql: t.sql, caret: [...t.caret], scroll: t.scroll, index: i });
      closedIds.add(t.id);
      unsaved.delete(t.id);
      clearedTabs.delete(t.id);
      if (t.id === placeholderId) placeholderId = null;
    } else keep.push(t);
  });
  if (!closed.length) return { closed, skipped, created: null };
  // The entries of one call share light {index, open} records only, never each other (see the notes above).
  const batch = closed.map(c => ({ index: c.index, open: false }));
  closed.forEach((c, i) => closedBatch.set(c, { mark: batch[i], batch }));
  state.tabs.splice(0, state.tabs.length, ...keep);
  state.closedTabs.push(...closed);
  if (state.closedTabs.length > LIMITS.closed) state.closedTabs.splice(0, state.closedTabs.length - LIMITS.closed);
  let created = null, changed = false;
  if (!keep.length) {
    state.activeTab = null;
    created = makeTab({}, newId('t'));
    state.tabs.push(created);
    placeholderId = created.id;
    changed = activate(created.id);
  } else if (!findTab(state.activeTab)) {
    const from = Math.max(activeIndex, 0);
    const removedBefore = closed.filter(c => c.index < from).length;
    changed = activate(keep[clampN(from - removedBefore, 0, keep.length - 1)].id);
  }
  save('tabs');
  emit('tab:list', {});
  if (changed) emit('tab:changed', { tabId: state.activeTab });
  return { closed, skipped, created };
}

// Display index for reopening a closed entry: its recorded index less its batch-mates at lower indexes still closed.
function reopenIndex(e) {
  if (!isNum(e.index)) return state.tabs.length;
  let at = Math.round(e.index);
  const rec = closedBatch.get(e);
  if (rec) for (const m of rec.batch) if (m !== rec.mark && !m.open && m.index < e.index) at--;
  return clampN(at, 0, state.tabs.length);
}

// True when a TabResults (03 §2) holds nothing: no result sets, messages, plans or FetchXML. Any other shape counts
// as content, so an unexpected value never lets the placeholder go.
function emptyResults(r) {
  if (!isObj(r)) return false;
  return ['sets', 'messages', 'plans', 'fetchXml'].every(k => r[k] == null || (Array.isArray(r[k]) && r[k].length === 0));
}

// True while the placeholder tab is the only tab and wholly unused (see the notes above), so reopening may drop it.
function placeholderUnused(tab) {
  if (!tab || tab.id !== placeholderId || state.tabs.length !== 1 || tab.sql !== '' || tab.dirty || tab.file != null) return false;
  if (state.running?.tabId === tab.id) return false;
  if (state.results.has(tab.id) && !emptyResults(state.results.get(tab.id))) return false;
  const temps = state.sessions.get(tab.id)?.temps;
  return temps == null || (typeof temps.size === 'number' && temps.size === 0);
}

// Reopen closed tabs (Undo, Reopen closed tab; default: the most recently closed) in fresh tabs at their old places.
export function reopenTabs(entries, { activate: act = true } = {}) {
  const given = entries == null ? state.closedTabs.slice(-1) : (Array.isArray(entries) ? entries : [entries]);
  if (given.some(e => !isObj(e))) throw new TypeError('reopenTabs(): expected closed-tab entries.');
  const list = [...new Set(given)].filter(e => !reopened.has(e));
  if (!list.length) return [];
  const ph = placeholderId && findTab(placeholderId);
  if (placeholderUnused(ph)) {
    state.tabs.length = 0;
    closedIds.add(ph.id);
    if (state.activeTab === ph.id) state.activeTab = null;
  }
  placeholderId = null;
  const opened = [];
  const order = e => (isNum(e.index) ? e.index : Number.MAX_SAFE_INTEGER);
  for (const e of list.sort((a, b) => order(a) - order(b))) {
    const i = state.closedTabs.indexOf(e);
    if (i >= 0) state.closedTabs.splice(i, 1);
    const tab = makeTab(e, newId('t'));
    state.tabs.splice(reopenIndex(e), 0, tab);
    reopened.add(e);
    const rec = closedBatch.get(e);
    if (rec) rec.mark.open = true;
    opened.push(tab);
  }
  const changed = act || !findTab(state.activeTab) ? activate(opened[0].id) : false;
  save('tabs');
  emit('tab:list', {});
  if (changed) emit('tab:changed', { tabId: state.activeTab });
  return opened;
}

// Move a tab to a display position (query-tab drag-reorder, 03 §3); returns its new index, or -1 if unknown.
export function moveTab(id, toIndex) {
  const from = state.tabs.findIndex(t => t.id === id);
  if (from < 0 || !isNum(toIndex)) return -1;
  const to = clampN(Math.round(toIndex), 0, state.tabs.length - 1);
  if (to === from) return from;
  const [tab] = state.tabs.splice(from, 1);
  state.tabs.splice(to, 0, tab);
  save('tabs');
  emit('tab:list', {});
  return to;
}

// Move a tab by one place (Move left / right, Alt+Shift+PageUp/PageDown); returns the new index or -1 at an end.
export function moveTabBy(id, delta) {
  const from = state.tabs.findIndex(t => t.id === id);
  const to = from + Math.sign(delta);
  if (from < 0 || !delta || to < 0 || to >= state.tabs.length) return -1;
  return moveTab(id, to);
}

// Patch a tab ({title, sql, caret, scroll, dirty, file}); an SQL change marks it dirty unless `dirty` is given.
// Title, dirty and file changes emit `tab:list {tabId, fields}` (never tab:changed: the active tab is unchanged).
export function updateTab(id, patch) {
  const tab = findTab(id);
  if (!tab) return false;
  if (!isObj(patch)) throw new TypeError('updateTab(): expected an object.');
  for (const k of Object.keys(patch)) if (!TAB_PATCH.has(k)) throw new TypeError(`updateTab(): unknown field '${k}'.`);
  let content = false, persist = false;
  const fields = [];
  if (own(patch, 'title')) {
    const t = cleanTitle(patch.title);
    if (t && t !== tab.title) { tab.title = t; content = true; fields.push('title'); }
  }
  let dirty = tab.dirty;
  if (own(patch, 'sql') && typeof patch.sql === 'string' && patch.sql !== tab.sql) {
    tab.sql = patch.sql;
    content = true;
    if (!own(patch, 'dirty')) dirty = true;
    tab.caret = cleanCaret(tab.caret, tab.sql.length);
  }
  if (own(patch, 'caret')) {
    const c = cleanCaret(patch.caret, tab.sql.length);
    if (c[0] !== tab.caret[0] || c[1] !== tab.caret[1]) { tab.caret = c; persist = true; }
  }
  if (own(patch, 'scroll')) {
    const s = cleanScroll(patch.scroll);
    if (s !== tab.scroll) { tab.scroll = s; persist = true; }
  }
  if (own(patch, 'dirty')) dirty = !!patch.dirty;
  if (dirty !== tab.dirty) { tab.dirty = dirty; fields.push('dirty'); }
  if (own(patch, 'file') && (patch.file ?? null) !== tab.file) { tab.file = patch.file ?? null; fields.push('file'); }
  if (content) { tab.updatedAt = Math.max(nowFn(), tab.updatedAt + 1); if (tab.id === placeholderId) placeholderId = null; }
  if (content || persist) save('tabs');
  if (fields.length) emit('tab:list', { tabId: id, fields });
  return content || persist || fields.length > 0;
}

// Make a tab the active one; emits `tab:changed {tabId}` and returns true when it changed.
export function setActiveTab(id) {
  if (!findTab(id) || !activate(id)) return false;
  emit('tab:changed', { tabId: id });
  return true;
}

// ---- history ------------------------------------------------------------------------------------------------------

function cleanEntry(e) {
  if (!isObj(e) || typeof e.id !== 'string' || !ID_RE.test(e.id) || typeof e.sql !== 'string' || !e.sql.trim() || !isNum(e.at)) return null;
  return {
    id: e.id, at: e.at, sql: e.sql,
    mode: MODES.has(e.mode) ? e.mode : null,
    ms: isNum(e.ms) && e.ms >= 0 ? e.ms : null,
    rows: isNum(e.rows) && e.rows >= 0 ? Math.round(e.rows) : null,
    status: STATUS.has(e.status) ? e.status : null,
  };
}

// Newest first, consecutive identical SQL collapsed to the newest entry, at most 200 entries.
function normalizeHistory(list) {
  const sorted = list.map((e, i) => [e, i]).sort((a, b) => b[0].at - a[0].at || a[1] - b[1]).map(([e]) => e);
  const out = [];
  const seen = new Set();
  for (const e of sorted) {
    if (seen.has(e.id) || (out.length && out[out.length - 1].sql === e.sql)) continue;
    seen.add(e.id);
    out.push(e);
    if (out.length >= LIMITS.history) break;
  }
  return out;
}

// Validated stored history: valid entries only, newest first, deduplicated, at most 200.
export function validateHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return normalizeHistory(raw.map(cleanEntry).filter(Boolean));
}

// History merge: stored entries plus this instance's additions minus its deletions (03 §10).
export function mergeHistory(stored, adds = [], deletes = new Set()) {
  const byId = new Map();
  for (const e of [...adds, ...stored]) if (!deletes.has(e.id) && !byId.has(e.id)) byId.set(e.id, e);
  return normalizeHistory([...byId.values()]);
}

const memoryOnlyEntry = e => e.sql.length > LIMITS.historySql;

// The subset of a merged history that is written: SQL <= 100 KB each, under 1 MB of JSON in all (oldest dropped).
function storableHistory(list) {
  const out = [];
  let total = 2;
  for (const e of list) {
    if (memoryOnlyEntry(e)) continue;
    const room = LIMITS.historyTotal - total;
    if (e.sql.length + 1 > room) break;
    const size = JSON.stringify(e).length + 1;
    if (size > room) break;
    total += size;
    out.push(e);
  }
  return out;
}

// This instance's unsaved history entries, newest first (so a newer entry wins a tie on `at`).
const pendingAdds = () => [...historyAdds.values()].reverse();

// Keep only the queued additions that are still among the newest 200 entries (they could never be written else).
function pruneHistoryAdds() {
  const keep = new Set(state.history.map(e => e.id));
  for (const id of [...historyAdds.keys()]) if (!keep.has(id)) historyAdds.delete(id);
}

function writeHistory() {
  if (!host) { historyAdds.clear(); historyDeletes.clear(); return true; }
  if (!current.keepHistory) historyAdds.clear();
  if (!historyAdds.size && !historyDeletes.size) return true;
  const adds = pendingAdds();
  const stored = validateHistory(store.get(historyKey()));
  const merged = mergeHistory(stored, adds, historyDeletes);
  const ok = store.set(historyKey(), storableHistory(merged));
  const memoryOnly = adds.filter(memoryOnlyEntry);
  state.history = mergeHistory(merged, memoryOnly, historyDeletes);
  if (ok) {
    historyAdds.clear();
    const kept = new Set(state.history);
    for (const e of memoryOnly.reverse()) if (kept.has(e)) historyAdds.set(e.id, e);
    historyDeletes.clear();
  } else pruneHistoryAdds();
  emit('history', {});
  return ok;
}

// keepHistory turned off: forget the entries not yet written (memory too) and cancel their pending write.
function dropUnsavedHistory() {
  if (!historyAdds.size) return;
  const drop = new Set(historyAdds.keys());
  historyAdds.clear();
  if (!historyDeletes.size) cancelSave('history');
  state.history = state.history.filter(e => !drop.has(e.id));
  emit('history', {});
}

// Record a finished run ({sql, mode, ms, rows, status}) when keepHistory is on; returns the entry or null.
export function addHistory({ sql, mode = null, ms = null, rows = null, status = 'ok', at } = {}) {
  if (!current.keepHistory || typeof sql !== 'string' || !sql.trim()) return null;
  const entry = cleanEntry({ id: newId('h'), at: isNum(at) ? at : nowFn(), sql, mode, ms, rows, status });
  state.history = mergeHistory(state.history, [entry]);
  if (host) {
    historyAdds.set(entry.id, entry);
    if (historyAdds.size > LIMITS.history) pruneHistoryAdds();
    save('history');
  }
  emit('history', {});
  return entry;
}

// Delete one history entry (History sheet); returns true when it existed.
export function deleteHistory(id) {
  if (!state.history.some(e => e.id === id) && !historyAdds.has(id)) return false;
  historyAdds.delete(id);
  state.history = state.history.filter(e => e.id !== id);
  if (host) {
    historyDeletes.add(id);
    save('history');
  }
  emit('history', {});
  return true;
}

// Clear history (Settings › Privacy, History sheet): removes the stored history and the stored tabs; the open tabs
// are not written again until their title or SQL changes or Restore tabs is turned on again (03 §10).
export function clearHistory() {
  cancelSave('history');
  cancelSave('tabs');
  historyAdds.clear();
  historyDeletes.clear();
  state.history = [];
  if (host) { store.del(historyKey()); store.del(tabsKey()); }
  closedIds.clear();
  for (const t of state.tabs) clearedTabs.set(t.id, t.updatedAt);
  emit('history', {});
}

// Re-read the stored history and merge this instance's pending changes (History sheet open).
export function reloadHistory() {
  if (host) state.history = mergeHistory(validateHistory(store.get(historyKey())), pendingAdds(), historyDeletes);
  emit('history', {});
  return state.history;
}

