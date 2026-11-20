// Window frame, top bar, layout and splitters, query tabs (incl. drag-reorder and Close all), toolbar with its
// menus, toasts, menus, context menus, popovers, tooltips, dialog host, sheet host, live region, mini pill, the mode
// pill (incl. the standing approval), KEYMAP with chords and the Escape cascade (03 §1.4, §1.5, §3,
// §4, §9, §11). The DOM code is kept thin: the decisions (key matching, geometry, drop slots,
// badge and pill texts, the Power BI query, the cascade order) are pure exported helpers.
//
// Notes (extensions of 03 §1.4 / §3 / §9 / §11):
// - mountShell options beyond 03 §1.4: `io = {copyText}` (default util.js copyText, looked up per call), the
//   clipboard of Copy as Power BI (M), and `editorText() -> {text, start, end} | null`, the editor's text and selection
//   (main.js: editor.getValue() and getSelection()), which Copy as Power BI reads; without it, or when it returns
//   null, the shell reads the active tab's sql and caret from state, which is current only while main.js updates them
//   synchronously from the editor's onChange / onCaret (03 §2 does not say so). The Shell member keyMatches(e, id)
//   applies the mount's platform (`mac`); announce() also takes a Node (the move announcement's name is a <bdi>).
// - Command ids beyond the 03 §9 list (none of 03 §1.4's per-module lists names them yet): closeAllTabs (the shell's:
//   the tab menu's Close all), copyPowerBi (the shell's: Convert ▾; a module may override it),
//   addDisplayNames (main.js: editor.addDisplayNames(); KEYMAP Shift+Alt+D and Format ▾), loadFileAsText and
//   saveAll (dialogs.js: Open ▾) and endStanding (dialogs.js: endStandingApprovals(reason); the mode pill
//   passes 'pill'). onOpen hooks run when a toolbar menu opens: 'formatMenu', 'openMenu', 'convertMenu'. A menu
//   row shows the first key of its command only ('Ctrl+Shift+F').
// - Format ▾: the chevron part has aria-label and title 'Format options', aria-haspopup=menu and data-cmd
//   'formatMenu', and is disabled while neither Format nor Add display names is bound.
// - Standing approval: the pill is `button.pill.amb.standing`, ' · +n' a `.cnt` span and the × an aria-hidden
//   `.end` span; its text is aria-live=off in the mode state (the minute countdown is never read out). icons.js has no
//   shieldCheck alias yet (03 §1.2: lock), so the shell draws lock until it does. Like any control of a command
//   (03 §9), the pill is disabled while its command (endStanding, else toggleChanges) is unbound or disabled by its
//   state(); a disabled state's title replaces the last title line (the approval lines stay), and an unbound
//   endStanding never falls back to toggleChanges. After a click whose command left approvals active (an asynchronous
//   binding), the announcement waits for the `standing` event that empties them. The mini pill appends ' · Approved up
//   to N' to the 'Running · n rows' text too, not only to a write (pill(info)).
// - Close all: Escape and the scrim count as Keep editing; the tab running when the question is answered stays
//   open (also one that started meanwhile); the item is disabled with the title 'Stop the query first.' when only a
//   running tab is open. Close, Close others and Close to the right check their tabs again after their 'Discard N
//   pending changes?' question too: a tab that started running meanwhile stays open with its pending edits, and when
//   nothing is left to close the info toast 'Stop the query first.' shows.
// - Copy as Power BI (M): 'no variable' covers @locals, @var assignments and the cursor globals @@FETCH_STATUS
//   and @@CURSOR_ROWS (other @@ functions are allowed); GO counts as a second statement. Each text is parsed at most
//   once, and a lexical scan that finds a `;` between two tokens or a GO line disables the item without a parse (03
//   §13: a many-MB script never stalls Convert ▾). Beyond doubling `"`, the M text literal writes `#(` as `#(#)(`,
//   because `#(` starts a Power Query character escape (`'#(lf)'` in the SQL would otherwise become a line break).
// - Isolation from the page (03 §3 states keydown/keyup/keypress): the host stops every HOST_STOPPED_EVENTS event, i.e.
//   also beforeinput, input, textInput, the IME composition events and copy/cut/paste, so the page's own input,
//   dirty-form and clipboard listeners never see typing in the tool (live-findings: the composed `input` reached
//   window).
// - Requirements of other modules, met here: every change of .ss[data-theme] after the mount goes through styles.js
//   switchTheme() (the mount sets the first theme directly), and the shell registers its error toast as state.js's
//   setListenerErrorSink at mount and removes it on destroy, so other modules' bus listener errors show inside the
//   tool too (03 §1.4 'Errors the shell catches').
// - Shell API details beyond 03 §1.4's signatures: a menu item may carry `busy` (a spinner in place of its icon,
//   disabled, aria-busy; results.js's Convert ▸ Copy as FetchXML while its explain is pending, 03 §7); menu() options
//   also take `label` (the menu's aria-label) and `trigger` (the element focus returns to when it closes; default the
//   anchor element, else the focused element); sheet() takes `pos` when it opens, as update() does.
// - Details 03 does not state: the query-tab rename input keeps its keys (Enter commits, Escape cancels through the
//   cascade); closing a dialog that is not on top leaves the top dialog's focus and trap alone; when the toast stack is
//   re-shown above another top-layer element, the toasts already shown keep their place without replaying their entry
//   animation; a pointer move without a pressed button (a release the page never saw) cancels a query-tab drag, and a
//   new pointerdown on a tab puts back a stale one; focusPane() under a dialog leaves focus where it is inside the top
//   dialog; keyAction(e, ctx) is the pure key decision of the KEYMAP listener, edgeStroke(e) the test for a key that is
//   the first stroke of an `edge` binding in any scope (swallowed wherever it cannot run), and closeTargets(tabs, id,
//   'one'|'others'|'right'|'all', runningId) the pure choice of the close commands. A query tab's marks stand before
//   its title in the order running spinner (title 'Running'), amber edits dot, dirty dot (title 'Modified').
import { h, clear, setChildren, btn, placeNear, trapFocus } from './dom.js';
import { icon, ICON_NAMES } from './icons.js';
import { TOKENS, BASE, switchTheme } from './styles.js';
import * as stateModule from './state.js';
import { fmtInt, copyText } from '../core/util.js';
import { parse } from '../engine/parser.js';

// ---------------------------------------------------------------------------------------------------- text helpers

const FSI = '⁨', PDI = '⁩';

// A user-supplied name quoted for a sentence: “name”, bidi-isolated (FSI … PDI).
export function quoteName(s) {
  return `“${FSI}${String(s ?? '')}${PDI}”`;
}

// 'Moved “Query 3” to position 1 of 4.' (index is 0-based; the exact 03 §3 text).
export function moveText(title, index, count) {
  return `Moved “${String(title ?? '')}” to position ${fmtInt(index + 1)} of ${fmtInt(count)}.`;
}

// moveText() as a node for the live region: the name in a <bdi>, so a right-to-left title never reorders the sentence.
function moveNode(title, index, count) {
  return h('span', null, 'Moved “', h('bdi', { text: String(title ?? '') }), `” to position ${fmtInt(index + 1)} of ${fmtInt(count)}.`);
}

// 'Closed “Query 3”.' for one closed tab, 'Closed 12 tabs.' for several (the exact 03 §3 texts).
export function closedText(closed) {
  const n = Array.isArray(closed) ? closed.length : 0;
  return n === 1 ? `Closed “${String(closed[0].title ?? '')}”.` : `Closed ${fmtInt(n)} tabs.`;
}

// The closed-tab toast as a node: closedText() with the name in a <bdi> (no invisible characters to copy).
function closedNode(closed) {
  if (!Array.isArray(closed) || closed.length !== 1) return closedText(closed);
  return h('span', null, 'Closed “', h('bdi', { text: String(closed[0].title ?? '') }), '”.');
}

// The run-lock title and toast text: 'A query is already running in “Query 2”.'
export function runLockTitle(title) {
  return `A query is already running in ${quoteName(title)}.`;
}

// 'Discard 5 pending changes?' (1 change, n changes).
export function discardTitle(n) {
  return `Discard ${fmtInt(n)} pending ${n === 1 ? 'change' : 'changes'}?`;
}

// Close all's question (03 §3): 'Discard pending changes in 2 tabs?' (1 tab, n tabs).
export function discardTabsTitle(n) {
  return `Discard pending changes in ${fmtInt(n)} ${n === 1 ? 'tab' : 'tabs'}?`;
}

// Close all's toast text (03 §3): closedText(), then '“Query 2” is running and stays open.' for a running tab
// that stayed open (runningTitle, or null).
export function closeAllText(closed, runningTitle = null) {
  const head = closedText(closed);
  return runningTitle == null ? head : `${head} “${String(runningTitle)}” is running and stays open.`;
}

// closeAllText() as a node: the names in <bdi> elements, like the other closed-tab toasts.
function closeAllNode(closed, runningTitle) {
  const head = closedNode(closed);
  if (runningTitle == null) return head;
  return h('span', null, head, ' “', h('bdi', { text: String(runningTitle) }), '” is running and stays open.');
}

// ---------------------------------------------------------------------------------------------------------- KEYMAP

const km = (id, keys, scope, label, extra) => Object.freeze({ id, keys, scope, label, ...extra });

// Every key binding (03 §9; editor commands of §5, grid commands of §7): [{id, keys, mac?, scope, label, edge?, doc?}].
// Help's shortcuts table and every button title come from here. Ctrl+E is not bound until the 04 §5 Edge check
// confirms it. `doc` entries are display-only (the editor handles Tab / Shift+Tab on its textarea).
export const KEYMAP = Object.freeze([
  km('run', 'F5, Ctrl+Enter', 'global', 'Run', { edge: 'Reload' }),
  km('runStatement', 'Ctrl+Shift+Enter', 'global', 'Run statement'),
  km('plan', 'Ctrl+L', 'global', 'Estimated plan', { edge: 'Address bar' }),
  km('save', 'Ctrl+S', 'global', 'Save .sql file', { edge: 'Save page' }),
  km('open', 'Ctrl+O', 'global', 'Open .sql file', { edge: 'Open file' }),
  km('newTab', 'Alt+N', 'global', 'New query tab', { mac: 'Ctrl+Option+N' }),
  km('closeTab', 'Alt+W', 'global', 'Close query tab', { mac: 'Ctrl+Option+W' }),
  km('prevTab', 'Alt+PageUp', 'global', 'Previous query tab'),
  km('nextTab', 'Alt+PageDown', 'global', 'Next query tab'),
  km('moveTabLeft', 'Alt+Shift+PageUp', 'global', 'Move query tab left'),
  km('moveTabRight', 'Alt+Shift+PageDown', 'global', 'Move query tab right'),
  km('toggleExplorer', 'F8', 'global', 'Show or hide the explorer'),
  km('toggleResults', 'Ctrl+R', 'global', 'Show or hide the results', { edge: 'Reload' }),
  km('help', 'F1', 'global', 'Help', { edge: 'Help' }),
  km('settings', 'Ctrl+,', 'global', 'Settings', { edge: 'Edge settings (macOS)' }),
  km('nextPane', 'F6', 'global', 'Next pane', { edge: 'Address bar and panes' }),
  km('prevPane', 'Shift+F6', 'global', 'Previous pane', { edge: 'Address bar and panes' }),
  km('toggleComment', 'Ctrl+/', 'editor', 'Toggle comment'),
  km('comment', 'Ctrl+K Ctrl+C', 'editor', 'Comment selection', { edge: 'Search in the address bar' }),
  km('uncomment', 'Ctrl+K Ctrl+U', 'editor', 'Uncomment selection', { edge: 'Search in the address bar' }),
  km('hover', 'Ctrl+K Ctrl+I', 'editor', 'Show the hover card at the caret', { edge: 'Search in the address bar' }),
  km('format', 'Ctrl+Shift+F, Shift+Alt+F', 'editor', 'Format'),
  km('addDisplayNames', 'Shift+Alt+D', 'editor', 'Add display names'),
  km('find', 'Ctrl+F', 'editor', 'Find', { edge: 'Find on page' }),
  km('replace', 'Ctrl+H', 'editor', 'Replace', { mac: 'Cmd+Option+F', edge: 'History' }),
  km('findNext', 'F3', 'editor', 'Find next', { edge: 'Find next' }),
  km('findPrev', 'Shift+F3', 'editor', 'Find previous', { edge: 'Find previous' }),
  km('goToLine', 'Ctrl+G', 'editor', 'Go to line', { edge: 'Find next' }),
  km('complete', 'Ctrl+Space, Ctrl+J', 'editor', 'Suggestions', { mac: 'Ctrl+Space, Cmd+J', edge: 'Downloads' }),
  km('signatureHelp', 'Ctrl+Shift+Space', 'editor', 'Parameter hints', { mac: 'Ctrl+Shift+Space' }),
  km('duplicateLine', 'Ctrl+D', 'editor', 'Duplicate line', { edge: 'Favorite this page' }),
  km('deleteLine', 'Ctrl+Shift+K', 'editor', 'Delete line', { edge: 'Duplicate tab' }),
  km('moveLineUp', 'Alt+Up', 'editor', 'Move line up'),
  km('moveLineDown', 'Alt+Down', 'editor', 'Move line down'),
  km('indent', 'Tab', 'editor', 'Indent', { doc: true }),
  km('outdent', 'Shift+Tab', 'editor', 'Outdent', { doc: true }),
  km('wordWrap', 'Alt+Z', 'editor', 'Word wrap'),
  km('tabFocus', 'Ctrl+M', 'editor', 'Tab moves focus', { mac: 'Ctrl+Shift+M', edge: 'Mute tab' }),
  km('gridCopy', 'Ctrl+C', 'grid', 'Copy'),
  km('gridCopyHeaders', 'Ctrl+Shift+C', 'grid', 'Copy with headers', { edge: 'Inspect element (DevTools)' }),
  km('gridSelectAll', 'Ctrl+A', 'grid', 'Select all cells'),
  km('gridEdit', 'F2', 'grid', 'Edit cell'),
  km('nextChange', 'Alt+F5', 'grid', 'Next pending change'),
  km('prevChange', 'Shift+Alt+F5', 'grid', 'Previous pending change'),
  km('explorerSearch', 'Ctrl+F', 'explorer', 'Search tables', { edge: 'Find on page' }),
  km('sheetPrev', 'Alt+Up', 'sheet', 'Previous record'),
  km('sheetNext', 'Alt+Down', 'sheet', 'Next record'),
]);

const KEYMAP_BY_ID = new Map(KEYMAP.map(e => [e.id, e]));

// The KEYMAP scopes in Help order with their headings (03 §8.2; 'sheet' is the row details sheet).
export const KEYMAP_GROUPS = Object.freeze([
  Object.freeze(['global', 'Global']), Object.freeze(['editor', 'Editor']), Object.freeze(['grid', 'Grid']),
  Object.freeze(['explorer', 'Explorer']), Object.freeze(['sheet', 'Row details']),
]);

// Commands that also run from a form field inside their scope: the editor's find, replace and go-to bars and the
// explorer's search box (03 §5: F3 / Shift+F3 anywhere in the editor).
export const FIELD_COMMANDS = Object.freeze(['find', 'replace', 'findNext', 'findPrev', 'goToLine', 'explorerSearch']);
const FIELD_SAFE = new Set(FIELD_COMMANDS);

// True in Edge on macOS (03 §9: navigator.userAgentData.platform === 'macOS').
export function isMacPlatform(nav = globalThis.navigator) {
  return nav?.userAgentData?.platform === 'macOS';
}

// The key text of a KEYMAP entry for the platform (macOS: `mac`, else `keys` with Ctrl -> Cmd and Alt -> Option).
export function keysFor(entry, mac = false) {
  if (!entry) return '';
  if (!mac) return entry.keys;
  return entry.mac ?? entry.keys.replace(/\bCtrl\+/g, 'Cmd+').replace(/\bAlt\+/g, 'Option+');
}

const MOD_NAMES = new Map([['ctrl', 'ctrl'], ['control', 'ctrl'], ['alt', 'alt'], ['option', 'alt'], ['shift', 'shift'], ['cmd', 'meta'], ['meta', 'meta'], ['win', 'meta']]);

// One stroke ('Ctrl+Shift+K') as {ctrl, alt, shift, meta, key, id}; key is the last part, modifiers any order.
export function parseStroke(text) {
  const s = String(text).trim();
  const parts = s.endsWith('++') ? [...s.slice(0, -2).split('+'), '+'] : s.split('+');
  const key = parts.pop();
  const out = { ctrl: false, alt: false, shift: false, meta: false, key };
  for (const p of parts) {
    const m = MOD_NAMES.get(p.toLowerCase());
    if (!m) throw new Error(`KEYMAP: unknown modifier '${p}' in '${text}'.`);
    out[m] = true;
  }
  if (!key) throw new Error(`KEYMAP: no key in '${text}'.`);
  out.id = `${+out.ctrl}${+out.alt}${+out.shift}${+out.meta}:${key.length === 1 ? key.toUpperCase() : key}`;
  return out;
}

// A keys text as alternatives of strokes: 'F5, Ctrl+Enter' -> [[F5], [Ctrl+Enter]]; 'Ctrl+K Ctrl+C' -> [[K, C]].
export function parseKeys(keys) {
  return String(keys).split(/(?<!\+),\s+/).map(alt => alt.trim().split(/\s+/).map(parseStroke));
}

// Parsed strokes per KEYMAP entry and platform, computed once (keys are matched on every keydown, 03 §13).
const parsedCache = [new WeakMap(), new WeakMap()];
const parsed = (entry, mac) => {
  const cache = parsedCache[mac ? 1 : 0];
  let p = cache.get(entry);
  if (!p) cache.set(entry, p = parseKeys(keysFor(entry, mac)));
  return p;
};

// e.code values of a KEYMAP key name (letters and digits by position, 03 §9).
const CODE_NAMES = new Map([
  ['Enter', ['Enter', 'NumpadEnter']], ['Up', ['ArrowUp']], ['Down', ['ArrowDown']], ['Left', ['ArrowLeft']], ['Right', ['ArrowRight']],
  ['/', ['Slash', 'NumpadDivide']], [',', ['Comma']], ['.', ['Period']], [';', ['Semicolon']], ['-', ['Minus', 'NumpadSubtract']],
  ['=', ['Equal']], ['[', ['BracketLeft']], [']', ['BracketRight']], ['\\', ['Backslash']], ['`', ['Backquote']], ["'", ['Quote']],
  ['Space', ['Space']], ['Esc', ['Escape']],
]);
// e.key values used when e.code is missing (synthetic or virtual-keyboard events).
const KEY_NAMES = new Map([['Up', 'ArrowUp'], ['Down', 'ArrowDown'], ['Left', 'ArrowLeft'], ['Right', 'ArrowRight'], ['Space', ' '], ['Esc', 'Escape']]);

const codeCache = new Map();
function codesOf(key) {
  let c = codeCache.get(key);
  if (c) return c;
  if (/^[A-Z]$/i.test(key)) c = ['Key' + key.toUpperCase()];
  else if (/^[0-9]$/.test(key)) c = ['Digit' + key, 'Numpad' + key];
  else c = CODE_NAMES.get(key) ?? [key];
  codeCache.set(key, c);
  return c;
}

// True when a keyboard event is exactly this stroke: same modifiers (03 §9: Alt+F5 never triggers F5), the key by
// e.code (letters by position), or by e.key when the event has no code.
export function strokeMatches(e, s) {
  if (!!e.ctrlKey !== s.ctrl || !!e.altKey !== s.alt || !!e.shiftKey !== s.shift || !!e.metaKey !== s.meta) return false;
  const code = e.code;
  if (code && code !== 'Unidentified') return codesOf(s.key).includes(code);
  const k = String(e.key ?? '');
  const want = KEY_NAMES.get(s.key) ?? s.key;
  return k.length === 1 && want.length === 1 ? k.toLowerCase() === want.toLowerCase() : k === want;
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Fn', 'FnLock', 'Hyper', 'Super']);

// True for a key event of a modifier alone (Ctrl, Shift, Alt, Cmd …), which never cancels a pending chord.
export function isModifierOnly(e) {
  return MODIFIER_KEYS.has(e.key);
}

const CODE_LABELS = new Map([
  ['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right'], ['Slash', '/'], ['Comma', ','], ['Period', '.'],
  ['Semicolon', ';'], ['Quote', "'"], ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\'], ['Minus', '-'], ['Equal', '='],
  ['Backquote', '`'], ['NumpadEnter', 'Enter'], ['NumpadDivide', '/'], ['NumpadMultiply', '*'], ['NumpadSubtract', '-'], ['NumpadAdd', '+'],
  ['NumpadDecimal', '.'], ['IntlBackslash', '\\'],
]);

// The key name of an event for messages: 'X', '1', 'Up', 'F5', '/', 'Enter'.
export function keyName(e) {
  const c = String(e.code ?? '');
  let m;
  if ((m = /^Key([A-Z])$/.exec(c))) return m[1];
  if ((m = /^(?:Digit|Numpad)([0-9])$/.exec(c))) return m[1];
  if (CODE_LABELS.has(c)) return CODE_LABELS.get(c);
  if (/^(F\d{1,2}|Enter|Tab|Space|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown)$/.test(c)) return c;
  const k = String(e.key ?? '');
  if (k === ' ') return 'Space';
  if (k.length === 1) return k.toUpperCase();
  return k || c || 'Unknown';
}

// The stroke of an event as text for messages: 'Ctrl+X', 'Ctrl+Shift+P' ('Cmd'/'Option' on macOS).
export function strokeLabel(e, mac = false) {
  const p = [];
  if (e.ctrlKey) p.push('Ctrl');
  if (e.altKey) p.push(mac ? 'Option' : 'Alt');
  if (e.shiftKey) p.push('Shift');
  if (e.metaKey) p.push(mac ? 'Cmd' : 'Win');
  p.push(keyName(e));
  return p.join('+');
}

// The keys of a command for display ('F5, Ctrl+Enter'), or '' when it is not in KEYMAP.
export function keyLabel(id, mac = false) {
  return keysFor(KEYMAP_BY_ID.get(id), mac);
}

// A button title from KEYMAP: 'Run (F5)' (the first alternative); just the label when the id has no keys.
export function titleFor(id, { label, mac = false } = {}) {
  const e = KEYMAP_BY_ID.get(id);
  const text = label ?? e?.label ?? id;
  if (!e) return text;
  const first = keysFor(e, mac).split(/(?<!\+),\s+/)[0];
  return `${text} (${first})`;
}

const ARIA_KEY = new Map([['Ctrl', 'Control'], ['Cmd', 'Meta'], ['Option', 'Alt'], ['Up', 'ArrowUp'], ['Down', 'ArrowDown'], ['Left', 'ArrowLeft'], ['Right', 'ArrowRight']]);

// aria-keyshortcuts value of a command (single-stroke alternatives only; chords cannot be expressed there).
export function ariaKeys(id, mac = false) {
  const e = KEYMAP_BY_ID.get(id);
  if (!e) return '';
  return keysFor(e, mac).split(/(?<!\+),\s+/).filter(a => !/\s/.test(a.trim()))
    .map(a => a.trim().split('+').map((p, i, all) => (p === '' && i === all.length - 1 ? '+' : ARIA_KEY.get(p) ?? p)).filter(Boolean).join('+'))
    .join(' ');
}

// The KEYMAP binding a key event triggers: {entry, chord} (chord = the first stroke of a chord) or null. Scoped
// bindings win over global ones and never fire in a form field without its own data-scope (see the notes at the top of this file);
// display-only (`doc`) entries never match.
export function findBinding(e, { scope = 'global', field = false, mac = false, keymap = KEYMAP } = {}) {
  let global = null;
  for (const entry of keymap) {
    if (entry.doc) continue;
    const scoped = entry.scope !== 'global';
    if (scoped && (entry.scope !== scope || field)) continue;
    for (const strokes of parsed(entry, mac)) {
      if (!strokeMatches(e, strokes[0])) continue;
      const hit = { entry, chord: strokes.length > 1, stroke: strokes[0] };
      if (scoped) return hit;
      global ??= hit;
    }
  }
  return global;
}

// The `edge` binding (any scope) whose first stroke a key event is: {entry, chord, stroke}, or null.
function edgeHit(e, mac, keymap) {
  for (const entry of keymap) {
    if (entry.doc || !entry.edge) continue;
    for (const strokes of parsed(entry, mac)) if (strokeMatches(e, strokes[0])) return { entry, chord: strokes.length > 1, stroke: strokes[0] };
  }
  return null;
}

// True when a key event is the first stroke of a KEYMAP binding with `edge`, in any scope (03 §9: such a key is always
// preventDefault()ed inside the tool, also where its binding cannot run, so its Edge action never fires).
export function edgeStroke(e, { mac = false, keymap = KEYMAP } = {}) {
  return edgeHit(e, mac, keymap) != null;
}

// What the KEYMAP listener does with a key (03 §9): {entry, chord, stroke, act} or null (the key is left alone). act
// 'run' runs the command, 'chord' arms a chord and 'swallow' only preventDefault()s the key: nothing may run here (a
// dialog is open or waits, the window is not shown, no binding of this scope matches, or a scoped binding was typed
// in a form field that is not field-safe) and the key is the first stroke of an `edge` binding of any scope.
export function keyAction(e, { scope = 'global', field = false, modal = false, mac = false, keymap = KEYMAP } = {}) {
  let hit = findBinding(e, { scope, field, mac, keymap });
  let held = null;   // the scope's own binding, which a form field keeps from running
  if (field && scope !== 'global') {
    const own = findBinding(e, { scope, mac, keymap });
    if (own && own.entry.scope !== 'global') {
      if (!own.chord && FIELD_SAFE.has(own.entry.id)) hit = own;
      else if (!hit) held = own;
    }
  }
  if (hit && !modal) return { ...hit, act: hit.chord ? 'chord' : 'run' };
  const edge = [hit, held].find(x => x?.entry.edge) ?? edgeHit(e, mac, keymap);
  return edge ? { ...edge, act: 'swallow' } : null;
}

// The chord entry completed by a second stroke after `first` (a parsed stroke), or null.
export function chordEntry(first, e, { mac = false, scope = 'editor', keymap = KEYMAP } = {}) {
  for (const entry of keymap) {
    if (entry.doc || (entry.scope !== scope && entry.scope !== 'global')) continue;
    for (const strokes of parsed(entry, mac)) {
      if (strokes.length === 2 && strokes[0].id === first.id && strokeMatches(e, strokes[1])) return entry;
    }
  }
  return null;
}

// True when a key event matches any key of the KEYMAP command `id` (for modules' own element handlers).
export function keyMatches(e, id, mac = false) {
  const entry = KEYMAP_BY_ID.get(id);
  if (!entry) return false;
  return parsed(entry, mac).some(strokes => strokes.length === 1 && strokeMatches(e, strokes[0]));
}

// The chord prompt of 03 §9: '(Ctrl+K) was pressed. Waiting for the second key of the chord…'.
export const chordPrompt = first => `(${first}) was pressed. Waiting for the second key of the chord…`;
// The not-a-command message of 03 §9: 'The key combination (Ctrl+K, X) is not a command.'.
export const chordInvalid = (first, second) => `The key combination (${first}, ${second}) is not a command.`;

// ---------------------------------------------------------------------------------------------- Escape cascade

// The Escape cascade order of 03 §9 (first match wins).
export const ESC_STEPS = Object.freeze(['chord', 'drag', 'edit', 'popup', 'menu', 'popover', 'search', 'dialog', 'sheet', 'find', 'stop']);
const ESC_REGISTRABLE = new Set(['drag', 'edit', 'popup', 'find', 'stop']);
// The registrable steps whose state lives in the window's regions (inert behind a dialog or sheet, hidden when
// minimised): their handlers run only while those regions can be used.
const ESC_BACKGROUND = new Set(['drag', 'edit', 'popup']);

// Runs tries[step]() in cascade order until one returns true; returns that step's name, or null.
export function runEscape(tries) {
  for (const s of ESC_STEPS) {
    const t = tries[s];
    if (typeof t === 'function' && t()) return s;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------- geometry

// The window's minimum size (smaller only when the viewport is).
export const WIN_MIN = Object.freeze({ w: 720, h: 560 });
const TOP_H = 48;

// Window geometry kept in the viewport: at least 720 × 560 (or the viewport); strict keeps it wholly inside, the
// lenient form (while dragging) keeps 160 px on screen horizontally and the title bar reachable.
export function clampGeometry(g, vw, vh, strict = true) {
  const w = Math.round(Math.min(Math.max(g.w, Math.min(WIN_MIN.w, vw)), vw));
  const hh = Math.round(Math.min(Math.max(g.h, Math.min(WIN_MIN.h, vh)), vh));
  const x = strict ? Math.min(Math.max(g.x, 0), vw - w) : Math.min(Math.max(g.x, 160 - w), vw - 160);
  const y = strict ? Math.min(Math.max(g.y, 0), vh - hh) : Math.min(Math.max(g.y, 0), vh - TOP_H);
  return { x: Math.round(x), y: Math.round(y), w, h: hh, max: !!g.max };
}

// The default window box (03 §3: 16 px inset).
export function defaultGeometry(vw, vh) {
  return { x: 16, y: 16, w: Math.max(0, vw - 32), h: Math.max(0, vh - 32), max: false };
}

// The box after moving by (dx, dy) from `start` (lenient clamp).
export function moveGeometry(start, dx, dy, vw, vh) {
  return clampGeometry({ ...start, x: start.x + dx, y: start.y + dy, max: false }, vw, vh, false);
}

// The box after dragging edge(s) `dir` ('n', 'se', …) by (dx, dy): the opposite edges stay put, east and south stop
// at the viewport, west and north at 0, and the size never goes below the minimum.
export function resizeGeometry(s, dir, dx, dy, vw, vh) {
  const minW = Math.min(WIN_MIN.w, vw), minH = Math.min(WIN_MIN.h, vh);
  let { x, y, w, h: hh } = s;
  if (dir.includes('e')) w = Math.min(Math.max(s.w + dx, minW), Math.max(minW, vw - s.x));
  if (dir.includes('s')) hh = Math.min(Math.max(s.h + dy, minH), Math.max(minH, vh - s.y));
  if (dir.includes('w')) { const right = s.x + s.w; x = Math.min(Math.max(s.x + dx, 0), right - minW); w = right - x; }
  if (dir.includes('n')) { const bottom = s.y + s.h; y = Math.min(Math.max(s.y + dy, 0), bottom - minH); hh = bottom - y; }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh), max: false };
}

// The restored box when a maximised window is dragged: the pointer keeps its relative place along the title bar.
export function restoreUnderPointer(restored, pointerX, vw) {
  const x = vw > 0 ? pointerX - (pointerX / vw) * restored.w : 0;
  return { x: Math.round(x), y: 0, w: restored.w, h: restored.h, max: false };
}

// ------------------------------------------------------------------------------------------------- layout helpers

// The explorer width range (03 §3: 280 px by default, 200-520 resizable).
export const SIDE_MIN = 200, SIDE_MAX = 520;
const FIXED = 'var(--tab-h) - var(--tbar-h) - var(--status-h)';
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The editor height for a split ratio: the ratio of the editor + results height, the editor at least 80 px and the
// results at least 140 px (03 §3). The 2 px are the tab strip's border and the splitter line.
export function editorHeightCss(split) {
  const s = clampN(Number.isFinite(split) ? split : 0.45, 0.1, 0.9);
  return `clamp(80px, calc((100% - ${FIXED} - 2px) * ${s}), calc(100% - ${FIXED} - 142px))`;
}

// The split ratios allowed for `avail` px of editor + results (03 §3): within 0.1-0.9, the editor at least 80 px and
// the results at least 140 px ({lo, hi}; lo wins when the height cannot hold both minimums).
export function splitLimits(avail) {
  if (!(avail > 0)) return { lo: 0.1, hi: 0.9 };
  const lo = Math.max(0.1, 80 / avail);
  return { lo, hi: Math.max(lo, Math.min(0.9, (avail - 140) / avail)) };
}

// The split ratio for a pointer at clientY over an editor starting at `top` with `avail` px for editor + results.
export function splitFromPointer(y, top, avail) {
  if (!(avail > 0)) return 0.45;
  const { lo, hi } = splitLimits(avail);
  return clampN((y - top) / avail, lo, hi);
}

// The split ratio after a splitter key (↑/↓ move 16 px, Home/End go to the limits), or null for other keys. The
// ratio is first clamped to the limits of `avail`, so a key never moves inside a dead zone the user cannot see.
export function splitAfterKey(split, key, avail, step = 16) {
  if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Home' && key !== 'End') return null;
  const a = avail > 0 ? avail : 600;
  const { lo, hi } = splitLimits(a);
  if (key === 'Home') return lo;
  if (key === 'End') return hi;
  const px = Math.round(clampN(Number.isFinite(split) ? split : 0.45, lo, hi) * a);
  return clampN(px + (key === 'ArrowUp' ? -step : step), lo * a, hi * a) / a;
}

// The explorer width after a splitter key (←/→ 16 px, Home/End the limits), or null for other keys.
export function sideAfterKey(w, key, step = 16) {
  if (key === 'ArrowLeft') return clampN(w - step, SIDE_MIN, SIDE_MAX);
  if (key === 'ArrowRight') return clampN(w + step, SIDE_MIN, SIDE_MAX);
  if (key === 'Home') return SIDE_MIN;
  if (key === 'End') return SIDE_MAX;
  return null;
}

// F8: {collapsed, keep} after toggling the explorer. Below 720 px it flips only the memory-only .keep, which shows the
// explorer (collapsed or not) without changing layout.sideCollapsed (03 §3).
export function explorerToggle({ collapsed, narrow, keep }) {
  if (!narrow) return { collapsed: !collapsed, keep: false };
  return { collapsed: !!collapsed, keep: !keep };
}

// The next pane name in `panes` from `current` (wrapping); from outside every pane, the first (or last) one.
export function nextPane(panes, current, dir) {
  if (!panes.length) return null;
  const i = panes.indexOf(current);
  if (i < 0) return dir < 0 ? panes[panes.length - 1] : panes[0];
  return panes[(i + (dir < 0 ? -1 : 1) + panes.length) % panes.length];
}

// --------------------------------------------------------------------------------------------- query-tab helpers

// The drop slot of a dragged tab: how many other tabs have their centre left of the dragged tab's centre.
export function dropIndex(centers, from, center) {
  let n = 0;
  for (let i = 0; i < centers.length; i++) if (i !== from && centers[i] < center) n++;
  return n;
}

// translateX offsets that open the drop slot: tabs between `from` and `to` slide by `shift` (the dragged tab's width
// plus the gap) towards the empty place; the dragged tab itself gets 0 (it follows the pointer).
export function slideOffsets(count, from, to, shift) {
  const out = new Array(count).fill(0);
  for (let i = 0; i < count; i++) {
    if (i === from) continue;
    if (from < to && i > from && i <= to) out[i] = -shift;
    else if (to < from && i >= to && i < from) out[i] = shift;
  }
  return out;
}

// Auto-scroll speed (px per frame) while the pointer is within `zone` px of either end of the strip: negative to the
// left, faster nearer the edge, 0 elsewhere.
export function edgeScrollSpeed(x, left, right, zone = 24, max = 12) {
  if (x < left + zone) return -Math.max(1, Math.round(max * Math.min(1, (left + zone - x) / zone)));
  if (x > right - zone) return Math.max(1, Math.round(max * Math.min(1, (x - (right - zone)) / zone)));
  return 0;
}

// Tab ids a close command affects ('one', 'others', 'right', 'all'), never the running tab.
export function closeTargets(tabs, id, which, runningId = null) {
  if (which === 'all') return tabs.map(t => t.id).filter(x => x !== runningId);
  const i = tabs.findIndex(t => t.id === id);
  if (i < 0) return [];
  let ids;
  if (which === 'others') ids = tabs.filter(t => t.id !== id).map(t => t.id);
  else if (which === 'right') ids = tabs.slice(i + 1).map(t => t.id);
  else ids = [id];
  return ids.filter(x => x !== runningId);
}

// The index of the neighbouring tab (wrapping).
export function neighborIndex(count, index, dir) {
  if (count <= 0) return -1;
  return (((index + dir) % count) + count) % count;
}

// The accessible name of a query tab: its title plus its state.
export function tabLabel(tab, { running = false, edits = 0 } = {}) {
  const parts = [tab.title];
  if (running) parts.push('running');
  if (edits > 0) parts.push(`${fmtInt(edits)} pending ${edits === 1 ? 'change' : 'changes'}`);
  if (tab.dirty) parts.push('modified');
  return parts.join(', ');
}

// ------------------------------------------------------------------------------------------------ top-bar helpers

// The non-production OrganizationType names (02 §2) and their badges; every other type counts as Production.
const NON_PROD_BADGES = new Map([
  ['Sandbox', ['Sandbox', 'dev']], ['CustomerTest', ['Sandbox', 'dev']], ['CustomerFreeTest', ['Sandbox', 'dev']],
  ['Developer', ['Developer', '']], ['Trial', ['Trial', '']], ['TestDrive', ['Trial', '']],
]);
const UNKNOWN_ENV = 'Unknown (treated as Production)';
// Keys meta.toEnv() always sets (null or not): an env carrying any of them came back from RetrieveCurrentOrganization.
const ENV_RESULT_KEYS = ['name', 'url', 'orgId', 'envId', 'version', 'uniqueName'];

// True while the environment is still being checked (03 §11): an explicit `checking` flag, else the initial env shape
// {type: null, isProduction: true} without any key toEnv() sets (see the notes at the top of this file).
export function envChecking(env) {
  const e = env && typeof env === 'object' ? env : {};
  if (typeof e.checking === 'boolean') return e.checking && !e.error;
  return !e.error && e.type == null && !ENV_RESULT_KEYS.some(k => Object.hasOwn(e, k));
}

// The environment badge (03 §3, §11; 00 §5 rule 8): {text, cls: 'prod'|'dev'|'', title, checking}. Only a type that
// is clearly Sandbox, Developer or Trial with isProduction false is not red Production.
export function envBadge(env) {
  const e = env && typeof env === 'object' ? env : {};
  if (e.error) return { text: UNKNOWN_ENV, cls: 'prod', title: 'The environment type could not be read, so every Production rule applies.', checking: false };
  if (envChecking(e)) return { text: 'Checking…', cls: '', title: 'Checking the environment…', checking: true };
  if (e.type == null) return { text: UNKNOWN_ENV, cls: 'prod', title: 'The environment type is unknown, so every Production rule applies.', checking: false };
  const type = String(e.type);
  const badge = e.isProduction === false ? NON_PROD_BADGES.get(type) : null;
  if (!badge) return { text: 'Production', cls: 'prod', title: `Production environment (${type}). Changes need stricter confirmations.`, checking: false };
  const [text, cls] = badge;
  return { text, cls, title: text === type ? `${text} environment` : `${text} environment (${type})`, checking: false };
}

// The org badge: the environment's friendly name (title: its URL); before that, the host's first label.
export function orgBadge(env, loc = globalThis.location) {
  const e = env && typeof env === 'object' ? env : {};
  const hostLabel = String(loc?.hostname ?? '').split('.')[0];
  return { text: e.name || hostLabel || 'Dataverse', title: e.url || loc?.origin || '' };
}

// Whole minutes left in the changes window (at least 1 while it is open), or null.
export function minutesLeft(expiresAt, now) {
  if (!Number.isFinite(expiresAt)) return null;
  return Math.max(1, Math.ceil((expiresAt - now) / 60000));
}

// The mode pill (03 §3): {text, cls: ''|'amb', icon: 'lock'|'unlock', title, disabled}.
export function modePill({ allowed = false, expiresAt = null } = {}, now = Date.now(), checking = false) {
  if (!allowed) {
    if (checking) return { text: 'Read-only', cls: '', icon: 'lock', title: 'Checking the environment…', disabled: true };
    return { text: 'Read-only', cls: '', icon: 'lock', title: 'Read-only: queries cannot change data. Select to allow changes.', disabled: false };
  }
  const m = minutesLeft(expiresAt, now);
  return {
    text: m == null ? 'Changes allowed' : `Changes allowed · ${fmtInt(m)} min`, cls: 'amb', icon: 'unlock',
    title: m == null ? 'Changes are allowed: every write opens a preview that you confirm. Select to switch to read-only.' : 'Changes are allowed. They turn off 30 minutes after the last write. Select to turn them off now.', disabled: false,
  };
}

// The last line of the standing-approval pill's title (03 §3).
export const STANDING_HINT = 'Click to end the standing approval. Later executions will ask again.';
// What the shell announces when the pill ends the standing approvals (03 §3).
export const STANDING_ENDED = 'Standing approval ended. The next execution asks for confirmation again.';

const countOf = v => (Number.isFinite(v) ? v : 0);
// One approval as the pill reads it: 'Approved: UPDATE contact, 1,200 of 10,000' (op in upper case, table, total, N).
export function approvalText(a) {
  return `Approved: ${String(a?.op ?? '').toUpperCase()} ${String(a?.table ?? '')}, ${fmtInt(countOf(a?.total))} of ${fmtInt(countOf(a?.cap))}`;
}

// The mode pill while standing approvals are active (03 §3): {text, more, title, label, cap, approval} for the
// most recently used approval (usedAt; on a tie the later one in the list), `more` = ' · +n' for the others, the
// title lists every approval on its own line (most recent first) and ends with `hint` (STANDING_HINT; the pill passes
// its command's disabled title instead); null without any.
export function standingPill(approvals, hint = STANDING_HINT) {
  const list = Array.isArray(approvals) ? approvals.filter(a => a && typeof a === 'object') : [];
  if (!list.length) return null;
  const sorted = list.map((a, i) => [a, i]).sort(([a, i], [b, j]) => (countOf(b.usedAt) - countOf(a.usedAt)) || (j - i)).map(([a]) => a);
  const lines = sorted.map(approvalText);
  const others = sorted.length - 1;
  const last = String(hint ?? STANDING_HINT);
  return {
    text: lines[0], more: others > 0 ? ` · +${fmtInt(others)}` : '', title: [...lines, last].join('\n'),
    label: `${lines.join('. ')}. ${last}`, cap: countOf(sorted[0].cap), approval: sorted[0],
  };
}

// ------------------------------------------------------------------------------------------- Copy as Power BI (M)

// The Convert ▸ Copy as Power BI (M) toast and disabled title (03 §3).
export const POWER_BI_TOAST = 'Power BI runs this through the TDS endpoint, which supports less SQL than SQL Studio.';
export const POWER_BI_DISABLED = 'Copy as Power BI needs exactly one SELECT that uses no variables or #temp tables.';

// A Power Query M text literal: every `"` doubled, and `#(` (which starts an M character escape) written `#(#)(`.
const mText = s => `"${String(s ?? '').replace(/"/g, '""').replace(/#\(/g, '#(#)(')}"`;

// The Power BI (M) query of 03 §3 for `sql` on `host`; the SQL is copied as written.
export function powerBiM(sql, host) {
  return `let Source = CommonDataService.Database(${mText(host)}), DataverseSQL = Value.NativeQuery(Source, ${mText(sql)}, null, [EnableFolding=true]) in DataverseSQL`;
}

// @@ globals that read a cursor of the tab's session.
const CURSOR_GLOBALS = new Set(['@@fetch_status', '@@cursor_rows']);

// True when a parsed statement reads the tab's session: a variable or @var assignment, a cursor global, a #temp
// table or table variable, or SELECT … INTO (an iterative walk, so a deep expression never overflows the stack).
function usesSession(stmt) {
  const stack = [stmt];
  while (stack.length) {
    const n = stack.pop();
    if (Array.isArray(n)) { for (const x of n) if (x && typeof x === 'object') stack.push(x); continue; }
    if (n.type === 'var') {
      const v = String(n.name ?? '').toLowerCase();
      if (!v.startsWith('@@') || CURSOR_GLOBALS.has(v)) return true;
    }
    if (typeof n.assign === 'string' || (n.type === 'core' && n.into)) return true;
    if (n.type === 'table' && Array.isArray(n.name?.parts)) {
      const last = String(n.name.parts[n.name.parts.length - 1] ?? '');
      if (last.startsWith('#') || last.startsWith('@')) return true;
    }
    for (const k of Object.keys(n)) { const v = n[k]; if (v && typeof v === 'object') stack.push(v); }
  }
  return false;
}

// The lexer's white space without the line breaks, and its identifier characters (lexer.js isWs / isIdPart).
const HWS = new Set([' ', '\t', '\f', '\v', ' ', '﻿']);
const isIdChar = c => c != null && (/[A-Za-z0-9_#$@]/.test(c) || (c > '\u007f' && !HWS.has(c)));

// The index after a delimited token opened just before `i` and closed by `close` (a doubled closer is part of it, as
// in the lexer: '', "", ]]); the text's end when it never closes.
function skipDelimited(s, i, close) {
  for (const n = s.length; i < n; i++) {
    if (s[i] !== close) continue;
    if (s[i + 1] !== close) return i + 1;
    i++;
  }
  return s.length;
}

// True when a lexical scan proves, without parsing, that `sql` is not exactly one SELECT: a `;` with a token on both
// sides (two statements, or a syntax error) or a GO line (GO alone at the start of a line, optionally followed by a
// line comment; parse() returns it as a statement of its own). Strings, quoted and [bracketed] names and comments are
// skipped as lexer.js reads them, so the scan never sees a `;` or GO the parser would not; false only means "not
// proven" (parse() then decides).
export function provablyNotOneSelect(sql) {
  const s = String(sql ?? '');
  const n = s.length;
  let token = false;   // a token other than ';' since the start
  let semi = false;    // a ';' after such a token
  let lineStart = true; // only white space since the start or the last line break
  for (let i = 0; i < n;) {
    const c = s[i];
    if (c === '\n' || c === '\r') { lineStart = true; i++; continue; }
    if (HWS.has(c)) { i++; continue; }
    if (c === '-' && s[i + 1] === '-') { while (i < n && s[i] !== '\n') i++; lineStart = false; continue; }
    if (c === '/' && s[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth) {
        if (s[i] === '/' && s[i + 1] === '*') { depth++; i += 2; } else if (s[i] === '*' && s[i + 1] === '/') { depth--; i += 2; } else i++;
      }
      lineStart = false;
      continue;
    }
    if (c === ';') { if (token) semi = true; lineStart = false; i++; continue; }
    if (semi) return true;
    if (lineStart && (c === 'G' || c === 'g') && (s[i + 1] === 'O' || s[i + 1] === 'o') && !isIdChar(s[i + 2])) {
      let j = i + 2;
      while (j < n && HWS.has(s[j])) j++;
      if (j >= n || s[j] === '\n' || s[j] === '\r' || (s[j] === '-' && s[j + 1] === '-')) return true;
    }
    token = true;
    lineStart = false;
    if (c === "'" || c === '"') i = skipDelimited(s, i + 1, c);
    else if (c === '[') i = skipDelimited(s, i + 1, ']');
    else i++;
  }
  return false;
}

// True when `sql` parses to exactly one SELECT without INTO that uses no variable, #temp table, table variable or
// cursor, i.e. when Copy as Power BI (M) is enabled for it (03 §3). A text that provablyNotOneSelect() rules
// out is never parsed.
export function powerBiEligible(sql) {
  const s = String(sql ?? '');
  if (provablyNotOneSelect(s)) return false;
  let stmts;
  try { stmts = parse(s); } catch { return false; }
  return Array.isArray(stmts) && stmts.length === 1 && stmts[0]?.type === 'select' && !usesSession(stmts[0]);
}

// The text Copy as Power BI (M) converts (03 §3): the selection if it is non-empty (exactly as selected), else the
// whole text.
export function powerBiSource(sql, caret) {
  const s = String(sql ?? '');
  const [a, b] = Array.isArray(caret) ? caret : [0, 0];
  const lo = Math.min(Math.max(Math.min(Number(a) || 0, Number(b) || 0), 0), s.length);
  const hi = Math.min(Math.max(Math.max(Number(a) || 0, Number(b) || 0), 0), s.length);
  return hi > lo ? s.slice(lo, hi) : s;
}

// ----------------------------------------------------------------------------------------------- toasts and pill

// The icon of each toast kind (info uses the brand colour).
export const TOAST_ICONS = Object.freeze({ ok: 'okc', warn: 'warn', error: 'error', info: 'info' });

// Auto-dismiss delay: 5 s, 8 s with an action, null when sticky.
export function toastDuration({ action = null, sticky = false } = {}) {
  if (sticky) return null;
  return action ? 8000 : 5000;
}

// The time-left text of the pill: 'a minute or less left' under 60 s, else 'about N min left'.
export function fmtTimeLeft(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  return seconds < 60 ? 'a minute or less left' : `about ${fmtInt(Math.round(seconds / 60))} min left`;
}

const rowsText = n => `${fmtInt(n)} ${n === 1 ? 'row' : 'rows'}`;

// The status the mini pill shows after its 'SQL Studio' name: {cls: ''|'amb', icon: 'spin'|'ok'|'error'|'warn'|null,
// text, sub}; text is '' when idle (the name and sub only). While a run's text shows (the run or a write override)
// and a standing approval is active, sub ends with ' · Approved up to N' (standingCap = its N; 03 §3).
export function miniView({ attention = false, override = null, run = null, standingCap = null } = {}) {
  const cap = Number.isFinite(standingCap) && standingCap > 0 ? ` · Approved up to ${fmtInt(standingCap)}` : '';
  if (attention) return { cls: 'amb', icon: 'warn', text: 'Waiting for your confirmation', sub: ' · Select to review' };
  if (override && override.text) return { cls: '', icon: override.icon ?? null, text: String(override.text), sub: (override.sub ? String(override.sub) : '') + cap };
  if (run && run.phase === 'running') return { cls: '', icon: 'spin', text: `Running · ${rowsText(run.rows || 0)}`, sub: cap };
  if (run && run.phase === 'done') {
    if (run.cancelled) return { cls: '', icon: null, text: 'Query cancelled', sub: ' · Select to open' };
    if (!run.ok) return { cls: '', icon: 'error', text: 'Query failed', sub: ' · Select to see the messages' };
    return { cls: '', icon: 'ok', text: rowsText(run.rows || 0), sub: ' · Select to see the results' };
  }
  return { cls: '', icon: null, text: '', sub: ' · Select to open' };
}

// ------------------------------------------------------------------------------------------------- menu helpers

// The focused item after a menu key: ↓/↑ wrap, Home/End; null for other keys.
export function menuMove(count, index, key) {
  if (count <= 0) return null;
  if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count;
  if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

// Type-ahead: the next label after `from` starting with `ch` (case-insensitive, wrapping), or -1.
export function menuMatch(labels, from, ch) {
  const c = String(ch).toLowerCase();
  for (let k = 1; k <= labels.length; k++) {
    const i = (from + k + labels.length) % labels.length;
    if (String(labels[i] ?? '').toLowerCase().startsWith(c)) return i;
  }
  return -1;
}

// A submenu's viewport position: right of its item (flipping left when it does not fit), top-aligned, inside the view.
export function submenuPlace(item, size, vp) {
  let x = item.right - 4;
  if (x + size.w > vp.right - 8) x = Math.max(vp.left + 8, item.left - size.w + 4);
  let y = item.top - 4;
  if (y + size.h > vp.bottom - 8) y = Math.max(vp.top + 8, vp.bottom - 8 - size.h);
  return { x: Math.round(x), y: Math.round(y) };
}

// --------------------------------------------------------------------------------------------------- DOM helpers

const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]';
const FIELD_TYPES = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden']);

const isEl = x => !!x && x.nodeType === 1;
const isField = t => isEl(t) && ((t.localName === 'input' && !FIELD_TYPES.has(String(t.type || t.getAttribute('type') || 'text').toLowerCase()))
  || t.localName === 'textarea' || t.localName === 'select' || t.isContentEditable === true);
const inertOrHidden = (el, stop) => {
  for (let n = el; n && n !== stop; n = n.parentNode) if (n.hidden || n.inert) return true;
  return false;
};
const rendered = el => typeof el.getClientRects !== 'function' || el.getClientRects().length > 0;
const canFocus = (el, stop) => isEl(el) && !el.disabled && el.getAttribute('tabindex') !== '-1' && !inertOrHidden(el, stop) && rendered(el);
const focusables = (scope) => [...scope.querySelectorAll(FOCUSABLE)].filter(el => canFocus(el, scope));
const focusEl = el => { try { el.focus({ preventScroll: true }); } catch { /* detached */ } };

function rectOf(a) {
  if (a && typeof a.getBoundingClientRect === 'function') return a.getBoundingClientRect();
  if (a && Number.isFinite(a.left) && Number.isFinite(a.top)) {
    const right = Number.isFinite(a.right) ? a.right : a.left + (a.width || 0);
    const bottom = Number.isFinite(a.bottom) ? a.bottom : a.top + (a.height || 0);
    return { left: a.left, top: a.top, right, bottom, width: right - a.left, height: bottom - a.top };
  }
  if (a && Number.isFinite(a.x) && Number.isFinite(a.y)) return { left: a.x, top: a.y, right: a.x, bottom: a.y, width: 0, height: 0 };
  return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
}

// True in dev builds (__DEV__: dist/sql-studio.dev.js); production builds fold it to false.
const isDev = () => typeof __DEV__ !== 'undefined' && !!__DEV__;

// Dev builds only: hands a caught error to reportError() for DevTools. Production never logs or raises it on window,
// where the page's own error and telemetry handlers would read its message (03 §12, 00 §5 rule 5).
function devReport(e) {
  if (!isDev()) return;
  try { if (typeof globalThis.reportError === 'function') globalThis.reportError(e); } catch { /* a broken reporter */ }
}

// The text of a caught error for its toast.
const errText = e => String(e?.message || e || 'Something went wrong.');

let uidN = 0;
const nextId = p => `${p}-${++uidN}`;

// The composed events the host stops, so the page never sees typing inside the tool (03 §3): keys (Dynamics
// shortcuts), text input and IME composition, Chromium's textInput, and the clipboard events of editing.
export const HOST_STOPPED_EVENTS = Object.freeze(['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'textInput',
  'compositionstart', 'compositionupdate', 'compositionend', 'copy', 'cut', 'paste']);

// Creates `<sql-studio>` on documentElement and returns its open shadow root (03 §3).
export function createHost(doc = document) {
  const host = doc.createElement('sql-studio');
  doc.documentElement.appendChild(host);
  return host.attachShadow({ mode: 'open' });
}

function installCss(root, css) {
  if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in root) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      return () => { root.adoptedStyleSheets = root.adoptedStyleSheets.filter(s => s !== sheet); };
    } catch { /* fall back to a <style> element */ }
  }
  const el = h('style', { text: css });
  root.appendChild(el);
  return () => el.remove();
}

const PART_NAMES = new Map([['settings', 'settings'], ['layout', 'layout'], ['win', 'window position'], ['tabs', 'query tabs'], ['history', 'query history']]);
// The toolbar menus (03 §3): [command id, label, icon] items and '-' separators, by the menu's own command id.
const FORMAT_ITEMS = [['format', 'Format', 'format'], ['addDisplayNames', 'Add display names', 'text']];
const OPEN_ITEMS = [['open', 'Open .sql file…', 'folder'], ['loadCsv', 'Load CSV as #temp…', 'csv'], ['loadFileAsText', 'Load file as text…', 'file'],
  ['templates', 'New from template…', 'list'], '-', ['saveAll', 'Save all', 'save']];
const CONVERT_ITEMS = [['showFetchXml', 'Show FetchXML (no run)', 'code'], ['copyFetchXml', 'Copy as FetchXML', 'copy'],
  ['copyWebApiUrl', 'Copy as Web API URL', 'link'], ['copyPowerBi', 'Copy as Power BI (M)', 'copy'], '-', ['fetchToSql', 'FetchXML → SQL…', 'code'],
  ['importView', 'Import current view as SQL', 'table']];
const MENU_ITEMS = new Map([['formatMenu', FORMAT_ITEMS], ['openMenu', OPEN_ITEMS], ['convertMenu', CONVERT_ITEMS]]);
// The standing-approval pill's icon (03 §1.2: shieldCheck, an alias of lock).
const standingIcon = () => (ICON_NAMES.includes('shieldCheck') ? 'shieldCheck' : 'lock');
const TOAST_MAX = 5;
const TIP_DELAY = 500;

// --------------------------------------------------------------------------------------------------- mountShell

// Mounts the window into `root` (the <sql-studio> shadow root) and returns the Shell API (03 §1.4).
export function mountShell(root, opts = {}) {
  const S = opts.state && typeof opts.state.on === 'function' ? opts.state : stateModule;
  const st = S.state;
  const host = root.host;
  const mac = typeof opts.mac === 'boolean' ? opts.mac : isMacPlatform();
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  // io.copyText (default util.js copyText, looked up per call): the clipboard of Copy as Power BI (M).
  const io = opts.io && typeof opts.io === 'object' ? opts.io : null;
  // editorText() -> {text, start, end} | null: the editor's text and selection for Copy as Power BI (M).
  const editorText = typeof opts.editorText === 'function' ? opts.editorText : null;
  const doc = host?.ownerDocument ?? globalThis.document;
  const offs = [];
  const timers = new Set();
  let destroyed = false;

  const listen = (t, type, fn, o) => { t.addEventListener(type, fn, o); offs.push(() => t.removeEventListener(type, fn, o)); };
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); if (!destroyed) fn(); }, ms);
    timers.add(id);
    return id;
  };
  const cancel = id => { if (id != null) { clearTimeout(id); timers.delete(id); } };
  const frame = fn => (typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame(fn) : later(fn, 16));
  const unframe = id => { if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(id); else cancel(id); };
  const vp = () => {
    const d = doc.documentElement;
    const w = d?.clientWidth || globalThis.innerWidth || 0, hh = d?.clientHeight || globalThis.innerHeight || 0;
    return { left: 0, top: 0, right: w, bottom: hh, width: w, height: hh };
  };
  const tabById = id => st.tabs.find(t => t.id === id) || null;
  const titleOf = id => tabById(id)?.title ?? '';
  const uninstallCss = installCss(root, [TOKENS, BASE, ...(Array.isArray(opts.css) ? opts.css : [])].join(''));
  const inRoot = el => isEl(el) && root.contains(el);
  const active = () => { const a = root.activeElement; return inRoot(a) ? a : null; };

  // ---- command registry ------------------------------------------------------------------------------------------
  const commands = new Map();
  const topCmd = id => { const l = commands.get(id); return l && l.length ? l[l.length - 1] : null; };

  function command(id, spec) {
    if (typeof id !== 'string' || !id) throw new TypeError('shell.command(): an id is required.');
    if (KEYMAP_BY_ID.get(id)?.doc) throw new TypeError(`shell.command('${id}'): display-only KEYMAP entry; editor.js handles that key itself.`);
    const s = typeof spec === 'function' ? { run: spec } : spec;
    if (!s || (typeof s.run !== 'function' && typeof s.onOpen !== 'function')) throw new TypeError(`shell.command('${id}'): a run or onOpen function is required.`);
    const entry = { run: typeof s.run === 'function' ? s.run : null, state: typeof s.state === 'function' ? s.state : null, onOpen: typeof s.onOpen === 'function' ? s.onOpen : null };
    let list = commands.get(id);
    if (!list) commands.set(id, list = []);
    list.push(entry);
    refresh();
    return () => {
      const l = commands.get(id);
      const i = l ? l.indexOf(entry) : -1;
      if (i >= 0) { l.splice(i, 1); refresh(); }
    };
  }

  function builtinState(id) {
    const r = st.running;
    if (id === 'run' || id === 'runStatement') return r ? { disabled: true, title: runLockTitle(titleOf(r.tabId)), busy: id === 'run' && r.tabId === st.activeTab } : {};
    if (id === 'stop') return { hidden: !(r && r.tabId === st.activeTab) };
    return {};
  }

  function cmdState(id) {
    const out = { ...builtinState(id) };
    const c = topCmd(id);
    if (!c || !c.run) { out.disabled = true; out.unbound = true; return out; }
    let s = null;
    if (c.state) { try { s = c.state(); } catch (e) { fail(e); } }
    if (s && typeof s === 'object') {
      if (s.disabled) out.disabled = true;
      if (s.title && !out.title) out.title = String(s.title);
      if (s.hidden) out.hidden = true;
      if (s.busy) out.busy = true;
      if (s.label) out.label = String(s.label);
      if (s.checked !== undefined) out.checked = !!s.checked;
      out.own = s;
    }
    return out;
  }

  // Runs command `id`; returns false when it is unbound, disabled by its own state or declined (returned false).
  function exec(id, ...args) {
    const c = topCmd(id);
    if (!c || !c.run) return false;
    if (c.state) { let s = null; try { s = c.state(); } catch (e) { fail(e); } if (s && s.disabled) return false; }
    let r;
    try { r = c.run(...args); } catch (e) { fail(e); return true; }
    if (r && typeof r.then === 'function') r.then(null, fail);
    return r !== false;
  }

  // A caught error: an error toast inside the tool, never the console or the page (dev builds also
  // report it for DevTools); an identical error toast that is still shown is not repeated.
  function fail(e) {
    devReport(e);
    if (destroyed) return;
    const text = errText(e);
    if (toastItems.some(t => !t.done && t.errText === text)) return;
    toast(text, { kind: 'error' });
  }

  const escHandlers = new Map();   // step -> [{fn, el}], oldest first
  // Registers an Escape cascade handler for a step another module owns; `el` is the element its state belongs to
  // (see the notes at the top of this file). Returns the unregister function.
  function onEscape(step, fn, o = {}) {
    if (!ESC_REGISTRABLE.has(step)) throw new TypeError(`shell.onEscape(): unknown step '${step}'.`);
    if (typeof fn !== 'function') throw new TypeError('shell.onEscape(): a function is required.');
    if (o?.el != null && !isEl(o.el)) throw new TypeError('shell.onEscape(): `el` must be an element.');
    let l = escHandlers.get(step);
    if (!l) escHandlers.set(step, l = []);
    const reg = { fn, el: o?.el ?? null };
    l.push(reg);
    return () => { const i = l.indexOf(reg); if (i >= 0) l.splice(i, 1); };
  }
  // Whether a registered handler may run now: steps 2-4 (drag, edit, popup) only while their region can be used.
  const escUsable = (step, reg) => {
    if (!ESC_BACKGROUND.has(step)) return true;
    if (vis !== 'shown') return false;
    return reg.el ? reg.el.isConnected !== false && !inertOrHidden(reg.el, root) : !body.inert;
  };
  // Runs the registered handlers of a step, newest first, until one returns true.
  const runEsc = (step, e) => {
    const l = escHandlers.get(step);
    if (!l) return false;
    for (const reg of [...l].reverse()) {
      if (!escUsable(step, reg)) continue;
      try { if (reg.fn(e)) return true; } catch (err) { fail(err); }
    }
    return false;
  };

  // ---- DOM ---------------------------------------------------------------------------------------------------------
  const ids = { title: nextId('ss-title'), side: nextId('ss-side'), ed: nextId('ss-ed'), res: nextId('ss-res'), status: nextId('ss-status'), tip: nextId('ss-tip') };
  const iconBtn = (name, id, label, extra) => btn(name, null, {
    class: 'subtle', title: id ? titleFor(id, { label, mac }) : label, 'aria-label': label,
    'aria-keyshortcuts': id ? ariaKeys(id, mac) || undefined : undefined, ...extra,
  });

  // Top bar.
  const orgText = h('span');
  const orgEl = h('span', { class: 'badge org' }, orgText);
  const envText = h('span');
  const envEl = h('span', { class: 'badge' }, envText);
  const whoText = h('span');
  const whoX = h('button', { class: 'x', type: 'button' }, icon('close', 12));
  const whoEl = h('span', { class: 'pill amb who', hidden: true }, icon('user', 16), whoText, whoX);
  const modeIcon = h('span', { style: 'display:grid' });
  const modeText = h('span', { 'aria-atomic': 'true' });
  // Standing approvals: ' · +1' for the others (never shrinks) and the trailing × (the whole pill is the button).
  const modeCnt = h('span', { class: 'cnt', hidden: true });
  const modeEnd = h('span', { class: 'end', 'aria-hidden': 'true', hidden: true }, icon('close', 12));
  const modeEl = h('button', { class: 'pill', type: 'button' }, modeIcon, modeText, modeCnt, modeEnd);
  const topEnd = h('div', { style: 'display:flex;align-items:center;gap:8px;min-width:0;flex:none' });
  const historyBtn = iconBtn('history', null, 'History');
  const themeBtn = iconBtn('sun', null, 'Theme');
  const settingsBtn = iconBtn('settings', 'settings', 'Settings');
  const helpBtn = iconBtn('help', 'help', 'Help');
  const minBtn = iconBtn('minimize', null, 'Minimize');
  const maxBtn = iconBtn('maximize', null, 'Maximize');
  const closeBtn = iconBtn('close', null, 'Close');
  const top = h('div', { class: 'top', title: 'Drag to move. Double-click to maximize or restore.' },
    h('div', { class: 'logo', 'aria-hidden': 'true' }, icon('db', 18)),
    h('h1', { id: ids.title, text: 'SQL Studio' }),
    orgEl, envEl, whoEl, h('span', { class: 'spacer' }), modeEl, topEnd,
    h('div', { class: 'tbtns' }, historyBtn, themeBtn, settingsBtn, helpBtn, minBtn, maxBtn, closeBtn));

  // Query tabs.
  const qlist = h('div', { class: 'qt-list', role: 'tablist', 'aria-label': 'Query tabs' });
  const plusBtn = iconBtn('plus', 'newTab', 'New query');
  const moreBtn = iconBtn('chevron', null, 'All tabs', { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  const qtabs = h('div', { class: 'qtabs' }, qlist, plusBtn, moreBtn);

  // Toolbar.
  const tbBtn = (name, id, label, cls, menu) => {
    const b = btn(name, label, { class: cls || undefined, title: titleFor(id, { label, mac }), 'aria-label': label, 'aria-keyshortcuts': ariaKeys(id, mac) || undefined, 'data-cmd': id });
    if (menu) { b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); b.append(icon('chevron', 16)); }
    return b;
  };
  const runBtn = tbBtn('play', 'run', 'Run', 'primary');
  const stmtBtn = tbBtn('right', 'runStatement', 'Run statement');
  const stopBtn = tbBtn('stop', 'stop', 'Stop');
  const fmtBtn = tbBtn('format', 'format', 'Format');
  // Format ▾ (03 §3): a split button; the main part formats, the chevron part opens Format / Add display names.
  const fmtMenuBtn = h('button', {
    class: 'btn icon', type: 'button', title: 'Format options', 'aria-label': 'Format options', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-cmd': 'formatMenu',
  }, icon('chevron', 16));
  const fmtSplit = h('span', { class: 'split', role: 'group', 'aria-label': 'Format' }, fmtBtn, fmtMenuBtn);
  const cmtBtn = tbBtn('comment', 'toggleComment', 'Comment');
  const openBtn = tbBtn('folder', 'openMenu', 'Open', '', true);
  const saveBtn = tbBtn('save', 'save', 'Save');
  const convBtn = tbBtn('code', 'convertMenu', 'Convert', '', true);
  const tbarEnd = h('div', { style: 'display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden' });
  const sep = () => h('span', { class: 'sep', 'aria-hidden': 'true' });
  const tbar = h('div', { class: 'tbar' }, runBtn, stmtBtn, stopBtn, sep(), fmtSplit, cmtBtn, sep(), openBtn, saveBtn, sep(), convBtn, h('span', { class: 'spacer' }), tbarEnd);
  const progBar = h('div');
  const prog = h('div', { class: 'progress off', role: 'progressbar', 'aria-label': 'Progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-hidden': 'true' }, progBar);

  // Body.
  const side = h('div', { class: 'side', id: ids.side, role: 'region', 'aria-label': 'Explorer', 'data-scope': 'explorer' });
  const vsplit = h('div', { class: 'vsplit', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': 'Explorer width', 'aria-controls': ids.side, 'aria-valuemin': String(SIDE_MIN), 'aria-valuemax': String(SIDE_MAX) });
  const ed = h('div', { class: 'ed', id: ids.ed, role: 'tabpanel', 'data-scope': 'editor' });
  const hsplit = h('div', { class: 'hsplit', role: 'separator', tabindex: '0', 'aria-orientation': 'horizontal', 'aria-label': 'Editor height', 'aria-controls': ids.ed, 'aria-valuemin': '10', 'aria-valuemax': '90' });
  const res = h('div', { class: 'res', id: ids.res, role: 'region', 'aria-label': 'Results' });
  const statusRegion = h('div', { style: 'display:flex;align-items:center;gap:12px;flex:1;min-width:0;height:100%' });
  const statusTr = h('span', { class: 'st', role: 'status', hidden: true, style: 'position:absolute;left:0;top:0;bottom:0;z-index:1;max-width:100%;padding:0 12px;background:var(--bg1)' });
  const statusBar = h('div', { class: 'status', id: ids.status, role: 'region', 'aria-label': 'Status bar', style: 'position:relative' }, statusRegion, statusTr);
  const main = h('div', { class: 'main' }, qtabs, tbar, prog, ed, hsplit, res, statusBar);
  const body = h('div', { class: 'body' }, side, vsplit, main);
  const scrim = h('div', { class: 'scrim', hidden: true });
  const panel = h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': ids.title }, top, body, scrim);
  const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(d => h('div', { class: 'rz ' + d, 'data-d': d, 'aria-hidden': 'true' }));
  const win = h('div', { class: 'win' }, panel, handles);
  const toasts = h('div', { class: 'toasts', popover: 'manual', role: 'region', 'aria-label': 'Notifications' });
  const tip = h('div', { class: 'tip', popover: 'manual', role: 'tooltip', id: ids.tip });
  const live = h('div', { class: 'sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const app = h('div', { class: 'app' }, win, toasts, tip, live);
  const mini = h('button', { class: 'mini', type: 'button', hidden: true, title: 'Open the SQL Studio window' });
  const ss = h('div', { class: 'ss', 'data-theme': 'light' }, app, mini);
  root.appendChild(ss);

  for (const t of HOST_STOPPED_EVENTS) listen(host, t, e => e.stopPropagation());

  // ---- theme -------------------------------------------------------------------------------------------------------
  const media = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia('(prefers-color-scheme: dark)') : null;
  let themed = false;   // the mount set the first theme; later changes go through switchTheme (no colour fades)
  function applyTheme() {
    const pref = S.getSettings().theme;
    const t = S.resolveTheme(pref, !!media?.matches);
    if (themed) switchTheme(ss, t);
    else { ss.setAttribute('data-theme', t); themed = true; }
    S.setResolvedTheme(t);
    const name = pref === 'light' ? 'Light' : pref === 'dark' ? 'Dark' : 'Auto';
    const next = S.cycleTheme(pref);
    setChildren(themeBtn, icon(t === 'dark' ? 'moon' : 'sun', 20));
    themeBtn.title = `Theme: ${name}${pref === 'auto' ? ` (${t})` : ''}. Select for ${next === 'auto' ? 'Auto' : next === 'light' ? 'Light' : 'Dark'}.`;
    themeBtn.setAttribute('aria-label', `Theme: ${name}`);
  }
  if (media) listen(media, 'change', () => { if (S.getSettings().theme === 'auto') applyTheme(); });
  listen(themeBtn, 'click', () => { S.setSetting('theme', S.cycleTheme(S.getSettings().theme)); });

  // ---- layout ------------------------------------------------------------------------------------------------------
  // Below 720 px, F8's .keep shows the explorer whether or not layout.sideCollapsed is set (03 §3); it lives only in
  // memory and is dropped when the panel is 720 px or wider again (or the layout is reset).
  let keep = false;
  function applyLayout() {
    const L = st.layout;
    const off = !!L.sideCollapsed && !keep;
    side.style.setProperty('width', L.sideW + 'px');
    side.hidden = off;
    vsplit.hidden = off;
    side.classList.toggle('keep', keep);
    vsplit.classList.toggle('keep', keep);
    vsplit.setAttribute('aria-valuenow', String(L.sideW));
    vsplit.setAttribute('aria-valuetext', `${L.sideW} pixels`);
    ed.style.setProperty('height', editorHeightCss(L.split));
    const pct = Math.round(L.split * 100);
    hsplit.setAttribute('aria-valuenow', String(pct));
    hsplit.setAttribute('aria-valuetext', `Editor ${pct}%`);
    main.setAttribute('data-res', L.resPane);
  }
  const panelWidth = () => panel.getBoundingClientRect().width || 0;
  const isNarrow = () => { const w = panelWidth(); return w > 0 && w < 720; };
  const inSide = a => !!a && (side.contains(a) || a === vsplit);
  // Drops the narrow-mode .keep (the panel is wide again, or the layout was reset): a collapsed explorer hides again,
  // and focus inside it moves to the editor instead of falling to the page.
  function dropKeep() {
    if (!keep) return;
    const wasIn = inSide(active());
    keep = false;
    applyLayout();
    if (wasIn && side.hidden) focusPane('editor');
  }

  function availHeight() {
    const a = (main.clientHeight || 0) - (qtabs.offsetHeight || 0) - (tbar.offsetHeight || 0) - (statusBar.offsetHeight || 0) - (hsplit.offsetHeight || 0);
    return a > 0 ? a : 0;
  }

  // Explorer splitter.
  splitterDrag(vsplit, () => {
    const w0 = st.layout.sideW;
    let w = w0;
    return {
      move: (dx) => { w = clampN(Math.round(w0 + dx), SIDE_MIN, SIDE_MAX); side.style.setProperty('width', w + 'px'); vsplit.setAttribute('aria-valuenow', String(w)); },
      end: moved => { if (moved && w !== w0) S.setLayout({ sideW: w }); applyLayout(); },
    };
  }, 'x');
  listen(vsplit, 'keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); exec('toggleExplorer'); return; }
    const w = sideAfterKey(st.layout.sideW, e.key);
    if (w == null || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    S.setLayout({ sideW: w });
    applyLayout();
  });

  // Editor / results splitter.
  splitterDrag(hsplit, () => {
    const s0 = st.layout.split;
    const top0 = ed.getBoundingClientRect().top;
    const avail = availHeight();
    let s = s0;
    syncSplitAria(avail);
    return {
      move: (dx, dy, ev) => { s = splitFromPointer(ev.clientY, top0, avail); ed.style.setProperty('height', editorHeightCss(s)); hsplit.setAttribute('aria-valuenow', String(Math.round(s * 100))); },
      end: moved => { if (moved && s !== s0) S.setLayout({ split: s }); applyLayout(); syncSplitAria(avail); },
    };
  }, 'y');
  // The separator's value range follows the pixel minimums of the current height (measured only on focus and use).
  function syncSplitAria(avail) {
    if (!(avail > 0)) return;
    const { lo, hi } = splitLimits(avail);
    const pct = Math.round(clampN(st.layout.split, lo, hi) * 100);
    hsplit.setAttribute('aria-valuemin', String(Math.round(lo * 100)));
    hsplit.setAttribute('aria-valuemax', String(Math.round(hi * 100)));
    hsplit.setAttribute('aria-valuenow', String(pct));
    hsplit.setAttribute('aria-valuetext', `Editor ${pct}%`);
  }
  listen(hsplit, 'focus', () => syncSplitAria(availHeight()));
  listen(hsplit, 'dblclick', () => toggleMaxResults());
  listen(hsplit, 'keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); toggleMaxResults(); return; }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const avail = availHeight();
    const s = splitAfterKey(st.layout.split, e.key, avail);
    if (s == null) return;
    e.preventDefault();
    S.setLayout({ split: s });
    applyLayout();
    syncSplitAria(avail);
  });
  function toggleMaxResults() {
    S.setLayout({ resPane: st.layout.resPane === 'max' ? 'normal' : 'max' });
    applyLayout();
    const a = active();
    if (st.layout.resPane === 'max' && (ed.contains(a) || a === hsplit)) focusPane('results');
  }

  // Follows one pointer during a drag: pointer capture on the element plus document listeners, so the drag still ends
  // when capture is refused or the release happens outside the window. Each event is handled once; a move without a
  // pressed button means the release was missed and ends the drag as a cancel. Returns the stop function.
  function track(el, pid, { move, up, cancel: onCancel }) {
    const seen = new WeakSet();
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      for (const [t, f] of pairs) { el.removeEventListener(t, f); doc.removeEventListener(t, f, true); }
      el.removeEventListener('lostpointercapture', lost);
      if (el.hasPointerCapture?.(pid)) { try { el.releasePointerCapture(pid); } catch { /* already released */ } }
    };
    const wrap = fn => e => {
      if (done || e.pointerId !== pid || seen.has(e)) return;
      seen.add(e);
      fn(e);
    };
    const onMove = wrap(e => { if (e.buttons === 0) { stop(); onCancel(e); } else move(e); });
    const onUp = wrap(e => { stop(); up(e); });
    const onCancelEv = wrap(e => { stop(); onCancel(e); });
    const lost = e => { if (!done && e.pointerId === pid) { stop(); onCancel(e); } };
    const pairs = [['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onCancelEv]];
    for (const [t, f] of pairs) { el.addEventListener(t, f); doc.addEventListener(t, f, true); }
    el.addEventListener('lostpointercapture', lost);
    try { el.setPointerCapture?.(pid); } catch { /* the document listeners still follow the pointer */ }
    return stop;
  }

  function splitterDrag(el, begin, axis) {
    listen(el, 'pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const x0 = e.clientX, y0 = e.clientY, pid = e.pointerId;
      let moved = false, ctl = null;
      const move = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        if (!moved) {
          if (Math.abs(axis === 'x' ? dx : dy) < 4) return;
          moved = true;
          ctl = begin();
          el.classList.add('drag');
          app.classList.add('sizing');
          app.style.setProperty('cursor', axis === 'x' ? 'ew-resize' : 'ns-resize');
        }
        ctl.move(dx, dy, ev);
      };
      const end = () => {
        el.classList.remove('drag');
        app.classList.remove('sizing');
        app.style.removeProperty('cursor');
        if (ctl) ctl.end(moved);
      };
      track(el, pid, { move, up: end, cancel: end });
    });
  }

  // The panel's width changed: .keep is dropped at 720 px or wider, and focus inside an explorer that the container
  // query has just hidden (below 720 px without .keep) moves to the editor instead of falling to the page.
  function fitExplorer() {
    const narrow = isNarrow();
    if (keep && !narrow) dropKeep();
    else if (narrow && !keep && inSide(active())) focusPane('editor');
  }
  // Panel width: fitExplorer(); refit the toolbar labels.
  if (typeof globalThis.ResizeObserver === 'function') {
    const ro = new globalThis.ResizeObserver(() => fitExplorer());
    ro.observe(panel);
    const rt = new globalThis.ResizeObserver(() => fitToolbar());
    rt.observe(tbar);
    offs.push(() => { ro.disconnect(); rt.disconnect(); });
  }

  // ---- window geometry ---------------------------------------------------------------------------------------------
  let shown = null;   // the box shown (clamped), or null for the CSS default inset
  function setBox(g) {
    for (const [k, v] of [['left', g.x], ['top', g.y], ['width', g.w], ['height', g.h]]) win.style.setProperty(k, v + 'px');
    win.style.setProperty('right', 'auto');
    win.style.setProperty('bottom', 'auto');
  }
  function clearBox() { for (const k of ['left', 'top', 'width', 'height', 'right', 'bottom']) win.style.removeProperty(k); }
  function applyGeometry() {
    const g = st.win, v = vp();
    win.classList.toggle('max', !!g.max);
    if (g.x != null && v.width > 0 && v.height > 0) { shown = clampGeometry(g, v.width, v.height, true); setBox(shown); }
    else { shown = null; clearBox(); }
    syncMaxBtn();
    positionToasts();
  }
  function syncMaxBtn() {
    const max = !!st.win.max;
    setChildren(maxBtn, icon(max ? 'restore' : 'maximize', 20));
    maxBtn.title = max ? 'Restore down' : 'Maximize';
    maxBtn.setAttribute('aria-label', maxBtn.title);
  }
  function currentBox() {
    if (shown) return { ...shown };
    const v = vp();
    const r = win.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top, w: r.width, h: r.height, max: false };
    return defaultGeometry(v.width, v.height);
  }
  function restoredBox() {
    const g = st.win, v = vp();
    return g.x != null ? clampGeometry({ ...g, max: false }, v.width, v.height, true) : defaultGeometry(v.width, v.height);
  }
  function toggleMax() {
    closeTransient();
    S.setWin({ max: !st.win.max });
    applyGeometry();
  }
  const NO_DRAG = 'button, a, input, select, textarea, [role=button]';
  listen(top, 'pointerdown', e => { if (e.button === 0 && !e.target.closest?.(NO_DRAG)) windowDrag(e, 'move', top); });
  listen(top, 'dblclick', e => { if (!e.target.closest?.(NO_DRAG)) toggleMax(); });
  for (const r of handles) listen(r, 'pointerdown', e => { if (e.button === 0) windowDrag(e, r.getAttribute('data-d'), r); });

  function windowDrag(e, mode, el) {
    e.preventDefault();
    const v = vp();
    const x0 = e.clientX, y0 = e.clientY, pid = e.pointerId;
    const wasMax = !!st.win.max;
    if (wasMax && mode !== 'move') return;
    let g0 = wasMax ? null : currentBox();
    let moved = false, last = null;
    const move = ev => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        moved = true;
        closeTransient();
        app.classList.add(mode === 'move' ? 'moving' : 'sizing');
        app.style.setProperty('cursor', mode === 'move' ? 'move' : (globalThis.getComputedStyle?.(el).cursor || 'default'));
        if (wasMax) { g0 = restoreUnderPointer(restoredBox(), x0, v.width); win.classList.remove('max'); }
      }
      last = mode === 'move' ? moveGeometry(g0, dx, dy, v.width, v.height) : resizeGeometry(g0, mode, dx, dy, v.width, v.height);
      shown = last;
      setBox(last);
      positionToasts();
    };
    const end = () => {
      app.classList.remove('moving', 'sizing');
      app.style.removeProperty('cursor');
      // The drop position is kept as dragged (the lenient clamp); the strict clamp applies again on show and resize.
      if (moved && last) { S.setWin({ ...last, max: false }); syncMaxBtn(); positionToasts(); }
    };
    track(el, pid, { move, up: end, cancel: end });
  }
  listen(globalThis, 'resize', () => {
    applyGeometry();
    closeMenus();
    hideTip();
    for (const p of pops) p.reposition();
    if (keep || inSide(active())) fitExplorer();   // measures only when it can matter (the ResizeObserver also runs it)
  });

  listen(minBtn, 'click', () => minimize());
  listen(maxBtn, 'click', () => toggleMax());
  listen(closeBtn, 'click', () => close());
  listen(mini, 'click', () => show());

  // ---- top bar state -----------------------------------------------------------------------------------------------
  // Writes that skip unchanged values, so a refresh never dirties the DOM (or style) for nothing (03 §13).
  const setText = (el, v) => { if (el.textContent !== v) el.textContent = v; };
  const setAttr = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
  // setFlag() returns true when it wrote (the value changed).
  const setFlag = (el, k, v) => { if (el[k] === v) return false; el[k] = v; return true; };
  // setFlag() of `disabled` / `hidden` that reports whether this write took focus away from `prev` (it disabled or hid
  // `prev` or an ancestor of it): a render pass rescues focus only then, so it never reads layout otherwise (03 §13).
  const dropsFocus = (el, k, v, prev) => setFlag(el, k, v) && !!v && !!prev && (el === prev || el.contains(prev));
  let modeTimer = null, modeIconName = null, topBound = '';
  // The commands of the top bar's controls: Revert (the impersonation pill's ×) and the mode pill's toggleChanges or,
  // while standing approvals are active, endStanding. Their states as one key: refresh() re-renders the top bar when
  // a binding or a state changed (03 §1.4: refresh() re-reads every command state; §9: unbound or disabled → disabled).
  const TOP_CMDS = ['revert', 'toggleChanges', 'endStanding'];
  const topStates = () => new Map(TOP_CMDS.map(id => [id, cmdState(id)]));
  const topKey = states => TOP_CMDS.map(id => { const s = states.get(id); return `${!!s.disabled}:${!!s.unbound}:${s.title ?? ''}`; }).join('\n');
  // The active standing approvals mirrored by dialogs.js (03 §2), and whether the pill shows them.
  const standingList = () => (Array.isArray(st.standing) ? st.standing : []);
  const standingShown = () => standingList().some(a => a && typeof a === 'object');
  // The top bar: org and env badges, the impersonation pill and the mode pill (env, impersonate, run events).
  function renderTop(states = topStates()) {
    const prev = active();
    let lost = false;
    topBound = topKey(states);
    const env = st.env;
    const ob = orgBadge(env, globalThis.location);
    setText(orgText, ob.text);
    setAttr(orgEl, 'title', ob.title);
    const eb = envBadge(env);
    setText(envText, eb.text);
    setAttr(envEl, 'class', 'badge' + (eb.cls ? ' ' + eb.cls : ''));
    setAttr(envEl, 'title', eb.title);
    const who = st.impersonating;
    lost = dropsFocus(whoEl, 'hidden', !who, prev) || lost;
    if (who) {
      const whoName = String(who.name || who.id || '');
      if (whoText.textContent !== `Acting as ${whoName}`) setChildren(whoText, 'Acting as ', h('bdi', { text: whoName }));
      setAttr(whoEl, 'title', `Requests run as ${who.name || who.id}, with that user's permissions.`);
      const rv = states.get('revert');
      setAttr(whoX, 'title', st.running ? 'Not available while a query is running' : rv.disabled && rv.title ? rv.title : 'Stop acting as this user (Revert)');
      setAttr(whoX, 'aria-label', `Stop acting as ${who.name || who.id}`);
      lost = dropsFocus(whoX, 'disabled', !!rv.disabled || !!st.running, prev) || lost;
    }
    renderMode(eb.checking, states);
    // The × of a pill that has just gone (Revert) or been disabled hands focus to the mode pill next to it.
    if (lost) rescueFocus(prev, modeEl, 'editor');
  }
  // The mode pill (03 §3): the mode ('Read-only', 'Changes allowed · 28 min'), or while standing approvals are active
  // the most recently used one ('Approved: UPDATE contact, 1,200 of 10,000', ' · +1', ×), whose text is a polite
  // live region so a growing total is read out; a click then ends every approval (endStanding) instead of the mode.
  // The pill is disabled while its command is unbound or disabled (03 §9), so it is never an enabled control whose
  // click does nothing; a disabled state's title replaces the hint (states: from renderTop, else read here).
  function renderMode(checking = envBadge(st.env).checking, states = null) {
    cancel(modeTimer);
    modeTimer = null;
    const t = now();
    const standing = standingShown();
    const cs = states?.get(standing ? 'endStanding' : 'toggleChanges') ?? cmdState(standing ? 'endStanding' : 'toggleChanges');
    const own = cs.disabled && cs.title ? String(cs.title) : null;
    const sp = standing ? standingPill(standingList(), own ?? STANDING_HINT) : null;
    const mp = sp ? null : modePill({ allowed: st.allowChanges, expiresAt: st.changesExpireAt }, t, checking);
    const m = sp ? { text: sp.text, cls: 'amb standing', icon: standingIcon(), title: sp.title, label: sp.label, disabled: false }
      : { ...mp, title: !mp.disabled && own ? own : mp.title };
    if (m.icon !== modeIconName) { setChildren(modeIcon, icon(m.icon, 16)); modeIconName = m.icon; }
    setAttr(modeText, 'aria-live', sp ? 'polite' : 'off');
    setText(modeText, m.text);
    setText(modeCnt, sp ? sp.more : '');
    setFlag(modeCnt, 'hidden', !sp?.more);
    setFlag(modeEnd, 'hidden', !sp);
    setAttr(modeEl, 'class', 'pill' + (m.cls ? ' ' + m.cls : ''));
    if (dropsFocus(modeEl, 'disabled', !!m.disabled || !!cs.disabled, active() === modeEl ? modeEl : null)) rescueFocus(modeEl, 'editor');
    setAttr(modeEl, 'title', m.title);
    setAttr(modeEl, 'aria-label', sp ? m.label : m.text + '. ' + m.title);
    if (!sp && st.allowChanges && Number.isFinite(st.changesExpireAt)) {
      const left = st.changesExpireAt - t;
      if (left > 0) modeTimer = later(() => renderMode(), (left % 60000 || 60000) + 50);
    }
  }
  // A click (or Enter / Space) on the pill while approvals are active ends every one at once, without a dialog
  // (dialogs.endStandingApprovals('pill') behind the endStanding command), and says so; the pill returns to the mode.
  // The announcement is made only when the approvals really ended: at once, or (an asynchronous binding) on the
  // `standing` event that empties them; a binding that throws, rejects or declines (false) announces nothing.
  let endAnnounce = false;
  function endStandingFromPill() {
    const c = topCmd('endStanding');
    if (!c?.run) return;
    if (c.state) { let s = null; try { s = c.state(); } catch (e) { fail(e); } if (s?.disabled) { renderMode(); return; } }
    endAnnounce = false;
    let r;
    try { r = c.run('pill'); } catch (e) { fail(e); renderMode(); return; }
    if (r === false) return;
    if (r && typeof r.then === 'function') r.then(() => { if (standingShown()) endAnnounce = false; }, e => { endAnnounce = false; fail(e); });
    if (standingShown()) endAnnounce = true;
    else announce(STANDING_ENDED);
    renderMode();
    renderMini();
  }
  listen(modeEl, 'click', () => { if (standingShown()) endStandingFromPill(); else exec('toggleChanges'); });
  listen(whoX, 'click', e => { e.stopPropagation(); exec('revert'); });
  listen(historyBtn, 'click', () => exec('history'));
  listen(settingsBtn, 'click', () => exec('settings'));
  listen(helpBtn, 'click', () => exec('help'));

  // ---- toolbar -----------------------------------------------------------------------------------------------------
  const cmdButtons = [[runBtn, 'run', 'Run'], [stmtBtn, 'runStatement', 'Run statement'], [stopBtn, 'stop', 'Stop'], [fmtBtn, 'format', 'Format'],
    [cmtBtn, 'toggleComment', 'Comment'], [saveBtn, 'save', 'Save'], [historyBtn, 'history', 'History'], [settingsBtn, 'settings', 'Settings'], [helpBtn, 'help', 'Help']];
  for (const [b, id] of cmdButtons) if (b.getAttribute('data-cmd')) listen(b, 'click', e => exec(id, e));
  listen(fmtMenuBtn, 'click', () => toolbarMenu(fmtMenuBtn, 'formatMenu', FORMAT_ITEMS, 'Format'));
  listen(openBtn, 'click', () => toolbarMenu(openBtn, 'openMenu', OPEN_ITEMS, 'Open'));
  listen(convBtn, 'click', () => toolbarMenu(convBtn, 'convertMenu', CONVERT_ITEMS, 'Convert'));

  // Busy: a spinner before the button's icon, which stays in the DOM hidden (styles.js hides toolbar labels below
  // 900 px with `.btn:has(>svg)`, so 'Running…' must keep matching it).
  function setBtnBusy(b, busy) {
    const svg = [...b.children].find(c => c.localName === 'svg') ?? null;
    const spin = [...b.children].find(c => c.classList?.contains('spin')) ?? null;
    if (busy) {
      if (!spin) b.insertBefore(h('span', { class: 'spin', 'aria-hidden': 'true' }), b.firstChild);
      svg?.setAttribute('hidden', '');
    } else {
      spin?.remove();
      svg?.removeAttribute('hidden');
    }
  }
  const baseTitles = new Map(cmdButtons.map(([, id, label]) => [id, id === 'history' ? 'History' : titleFor(id, { label, mac })]));
  const lblOf = new Map(cmdButtons.map(([b]) => [b, b.querySelector('.lbl')]));
  // Re-reads every button's command state and rewrites only what changed; a changed label or a shown/hidden toolbar
  // button refits the labels in the next frame.
  function refreshButtons() {
    let reflow = false, lost = false;
    const prev = active();
    for (const [b, id, label] of cmdButtons) {
      const s = cmdState(id);
      const inBar = !!lblOf.get(b);
      if (b.hidden !== !!s.hidden) reflow ||= inBar;
      lost = dropsFocus(b, 'hidden', !!s.hidden, prev) || lost;
      lost = dropsFocus(b, 'disabled', !!s.disabled, prev) || lost;
      setAttr(b, 'title', s.title || baseTitles.get(id));
      const lbl = lblOf.get(b);
      if (b === runBtn) {
        const busy = !!s.busy;
        if (busy !== (runBtn.getAttribute('aria-busy') === 'true')) {
          setBtnBusy(runBtn, busy);
          lbl.textContent = busy ? 'Running…' : 'Run';
          runBtn.setAttribute('aria-label', busy ? 'Running…' : 'Run');
          runBtn.setAttribute('aria-busy', String(busy));
          reflow = true;
        }
      } else if (lbl) {
        const text = s.label || label;
        if (lbl.textContent !== text) { lbl.textContent = text; reflow = true; }
        setAttr(b, 'aria-label', text);
      }
    }
    for (const [b, id] of [[fmtMenuBtn, 'formatMenu'], [openBtn, 'openMenu'], [convBtn, 'convertMenu']]) {
      lost = dropsFocus(b, 'disabled', !MENU_ITEMS.get(id).some(x => x !== '-' && topCmd(x[0])?.run), prev) || lost;
    }
    lost = dropsFocus(plusBtn, 'disabled', !topCmd('newTab')?.run, prev) || lost;
    if (reflow && started) fitSoon();
    // A focused button that this pass disabled or hid hands focus on: Run / Run statement to the editor (so Escape
    // still stops the read and typing goes on; never to Stop, where a held Enter would stop the run it started),
    // Stop at the end of the run to Run. Any other pass leaves focus alone without measuring.
    if (lost) rescueFocus(prev, ...(prev === stopBtn ? [runBtn, 'editor'] : ['editor']));
  }

  // Toolbar labels hide below 900 px of panel width (styles.js container query); with a wide explorer the buttons can
  // still overflow above that, so the labels also hide whenever the toolbar does not fit (the buttons keep their
  // aria-label and title). It measures, so it runs from the toolbar's ResizeObserver (layout is fresh there) or in
  // the next frame after a label change, never on a refresh.
  function fitToolbar() {
    if (destroyed) return;
    const labels = tbar.querySelectorAll('.lbl');
    for (const l of labels) if (l.hidden) l.hidden = false;
    const over = tbar.scrollWidth > tbar.clientWidth + 1;
    if (over) for (const l of labels) l.hidden = true;
  }
  let fitFrame = null, started = false;   // started: mounted (the first fit is the ResizeObserver's)
  function fitSoon() {
    if (fitFrame != null) return;
    fitFrame = frame(() => { fitFrame = null; fitToolbar(); });
  }

  // A toolbar menu's rows from its commands' states (03 §1.4): `hidden` leaves the row out (renderMenu drops the
  // separators it orphans), `checked` makes it a menuitemcheckbox, `busy` shows a spinner and disables it.
  function cmdItems(list) {
    const out = [];
    for (const x of list) {
      if (x === '-') { out.push('-'); continue; }
      const [id, label, ic] = x;
      const s = cmdState(id);
      if (s.hidden) continue;
      // A menu row shows the first key of its command ('Ctrl+Shift+F', not both alternatives).
      const kbd = keyLabel(id, mac).split(/(?<!\+),\s+/)[0];
      const item = { label: s.label || label, icon: ic, kbd: kbd || undefined, disabled: !!s.disabled, busy: !!s.busy, title: s.title, run: () => exec(id) };
      if (s.checked !== undefined) item.checked = s.checked;
      out.push(item);
    }
    return out;
  }
  function toolbarMenu(anchor, menuId, list, label) {
    if (menus.length && menus[0].anchor === anchor) { closeMenus({ focusTrigger: true }); return; }
    const c = topCmd(menuId);
    if (c?.onOpen) { try { c.onOpen(); } catch (e) { fail(e); } }
    menu(anchor, () => cmdItems(list), { label });
  }

  // Re-reads every command state (03 §13: cheap, no layout read): the buttons, the top bar only when the binding of
  // its commands changed, and the open menus built from functions.
  function refresh() {
    if (destroyed) return;
    refreshButtons();
    const states = topStates();
    if (topKey(states) !== topBound) renderTop(states);
    for (const l of menus) if (typeof l.items === 'function') renderMenu(l, true);
  }

  // ---- query tabs --------------------------------------------------------------------------------------------------
  const tabEls = new Map();      // id -> {el, tt, x, marks}
  const pendingEdits = new Map(); // tabId -> Map(setId -> pending)
  let renaming = null;
  const editsOf = id => { let n = 0; for (const v of pendingEdits.get(id)?.values() ?? []) n += v; return n; };

  function makeTab(id) {
    const tt = h('span', { class: 'tt' });
    const x = h('button', { class: 'x', type: 'button', tabindex: '-1' }, icon('close', 16));
    const el = h('div', { class: 'tab', role: 'tab', id: 'ss-qt-' + id, 'aria-controls': ids.ed, 'data-id': id }, tt, x);
    return { el, tt, x, marks: { spin: null, edits: null, dirty: null } };
  }
  // A query tab's marks before its title, each shown on its own (03 §3): the running spinner, the amber dot of pending
  // grid edits and the dirty dot, in that order (aria-hidden: the tab's aria-label names every state).
  const TAB_MARKS = ['spin', 'edits', 'dirty'];
  const makeMark = k => (k === 'spin' ? h('span', { class: 'spin', title: 'Running', 'aria-hidden': 'true' })
    : k === 'edits' ? h('span', { class: 'dot edits', 'aria-hidden': 'true' })
      : h('span', { class: 'dot dirty', title: 'Modified', 'aria-hidden': 'true' }));
  function syncMarks(r, want) {
    let next = r.tt;
    for (let i = TAB_MARKS.length - 1; i >= 0; i--) {
      const k = TAB_MARKS[i];
      if (want[k]) {
        if (!r.marks[k]) r.el.insertBefore(r.marks[k] = makeMark(k), next);
        next = r.marks[k];
      } else if (r.marks[k]) { r.marks[k].remove(); r.marks[k] = null; }
    }
  }
  // Rewrites only what changed (an `edits` event per grid cell edit renders the whole strip; 03 §13).
  function updateTabEl(r, t) {
    const isActive = t.id === st.activeTab;
    const running = st.running?.tabId === t.id;
    const edits = editsOf(t.id);
    setAttr(r.el, 'aria-selected', String(isActive));
    setAttr(r.el, 'tabindex', isActive ? '0' : '-1');
    setAttr(r.el, 'aria-label', tabLabel(t, { running, edits }));
    setAttr(r.el, 'title', String(t.title));
    setText(r.tt, String(t.title));
    syncMarks(r, { spin: running, edits: edits > 0, dirty: !!t.dirty });
    if (r.marks.edits) setAttr(r.marks.edits, 'title', `${fmtInt(edits)} pending grid ${edits === 1 ? 'change' : 'changes'}`);
    setFlag(r.x, 'disabled', running);
    setAttr(r.x, 'title', running ? 'Stop the query first.' : titleFor('closeTab', { label: 'Close', mac }));
    setAttr(r.x, 'aria-label', `Close ${t.title}`);
  }
  let stripOrder = null, stripActive = null;   // the tab order and active tab the strip last scrolled for
  function renderTabs() {
    if (renaming || drag?.active) return;   // finishRename / dragEnd render again
    const prev = active();
    const focusedId = prev?.closest?.('.tab')?.getAttribute('data-id') ?? null;
    const seen = new Set();
    st.tabs.forEach((t, i) => {
      let r = tabEls.get(t.id);
      if (!r) { r = makeTab(t.id); tabEls.set(t.id, r); }
      updateTabEl(r, t);
      if (qlist.children[i] !== r.el) qlist.insertBefore(r.el, qlist.children[i] ?? null);
      seen.add(t.id);
    });
    for (const [id, r] of tabEls) if (!seen.has(id)) { r.el.remove(); tabEls.delete(id); pendingEdits.delete(id); }
    const order = st.tabs.map(t => t.id).join(' ');
    const act = tabEls.get(st.activeTab);
    if (act) {
      setAttr(ed, 'aria-labelledby', act.el.id);
      // Only a new active tab or a changed list scrolls the strip: a field or edits update never snaps back a strip
      // the user scrolled with the wheel, and never forces a layout.
      if (st.activeTab !== stripActive || order !== stripOrder) act.el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    stripOrder = order;
    stripActive = st.activeTab;
    // Focus in the strip stays there: a reorder (insertBefore blurs the moved tab) gets it back, and a × this pass
    // disabled (its tab started running) hands it to its own tab.
    if (focusedId && tabEls.has(focusedId)) {
      const target = holdsFocus(prev) ? prev : tabEls.get(focusedId).el;
      if (active() !== target) focusEl(target);
    }
  }
  const tabIdOf = t => t?.closest?.('.tab')?.getAttribute('data-id') ?? null;

  listen(qlist, 'click', e => {
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
    const id = tabIdOf(e.target);
    if (!id || (renaming && renaming.id === id && e.target === renaming.input)) return;
    if (e.target.closest?.('.x')) { closeTabsUi([id]); return; }
    S.setActiveTab(id);
    focusEl(tabEls.get(id)?.el);
  }, true);
  listen(qlist, 'dblclick', e => {
    const id = tabIdOf(e.target);
    if (id && !e.target.closest?.('.x') && !(renaming && e.target === renaming.input)) startRename(id);
  });
  listen(qlist, 'pointerdown', e => { if (e.button === 1 && tabIdOf(e.target)) e.preventDefault(); });
  listen(qlist, 'auxclick', e => {
    const id = tabIdOf(e.target);
    if (e.button === 1 && id) { e.preventDefault(); closeTabsUi([id]); }
  });
  listen(qlist, 'contextmenu', e => {
    const id = tabIdOf(e.target);
    if (!id || (renaming && e.target === renaming.input)) return;
    contextMenu(e, tabMenuItems(id));
  });
  listen(qlist, 'keydown', e => {
    const id = tabIdOf(e.target);
    if (!id || !e.target.classList?.contains('tab') || e.ctrlKey || e.metaKey || e.altKey) return;
    const i = st.tabs.findIndex(t => t.id === id), n = st.tabs.length;
    let to = -1;
    if (e.key === 'ArrowRight') to = neighborIndex(n, i, 1);
    else if (e.key === 'ArrowLeft') to = neighborIndex(n, i, -1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = n - 1;
    else if (e.key === 'F2') { e.preventDefault(); startRename(id); return; }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.setActiveTab(id); return; }
    if (to < 0 || e.shiftKey) return;
    e.preventDefault();
    const t = st.tabs[to];
    S.setActiveTab(t.id);
    focusEl(tabEls.get(t.id)?.el);
  });
  listen(qlist, 'wheel', e => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && qlist.scrollWidth > qlist.clientWidth) { qlist.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
  listen(plusBtn, 'click', () => exec('newTab'));
  listen(moreBtn, 'click', () => menu(moreBtn, tabsMenuItems, { label: 'All tabs' }));

  function tabsMenuItems() {
    return [
      { label: 'New query', icon: 'plus', kbd: keyLabel('newTab', mac), run: () => exec('newTab') },
      { label: 'New from template…', icon: 'list', disabled: !topCmd('templates')?.run, run: () => exec('templates') },
      { label: 'Reopen closed tab', icon: 'undo', disabled: !st.closedTabs.length, run: () => reopenLast() },
      '-',
      ...st.tabs.map(t => ({
        label: t.title, checked: t.id === st.activeTab,
        hint: st.running?.tabId === t.id ? 'Running' : editsOf(t.id) ? 'Pending grid changes' : t.dirty ? 'Modified' : undefined,
        run: () => { S.setActiveTab(t.id); focusEl(tabEls.get(t.id)?.el); },
      })),
    ];
  }
  function tabMenuItems(id) {
    const i = st.tabs.findIndex(t => t.id === id), n = st.tabs.length;
    const running = st.running?.tabId === id;
    const runId = st.running?.tabId ?? null;
    const others = closeTargets(st.tabs, id, 'others', runId), right = closeTargets(st.tabs, id, 'right', runId);
    const all = closeTargets(st.tabs, id, 'all', runId);
    return [
      { label: 'Rename', icon: 'edit', kbd: 'F2', run: () => startRename(id) },
      { label: 'Duplicate', icon: 'copy', run: () => duplicateTab(id) },
      '-',
      { label: 'Move left', icon: 'left', kbd: keyLabel('moveTabLeft', mac), disabled: i <= 0, run: () => moveBy(id, -1) },
      { label: 'Move right', icon: 'right', kbd: keyLabel('moveTabRight', mac), disabled: i >= n - 1, run: () => moveBy(id, 1) },
      '-',
      { label: 'Close', icon: 'close', kbd: keyLabel('closeTab', mac), disabled: running, title: running ? 'Stop the query first.' : undefined, run: () => closeTabsUi([id]) },
      { label: 'Close others', disabled: !others.length, run: () => closeTabsUi(others) },
      { label: 'Close to the right', disabled: !right.length, run: () => closeTabsUi(right) },
      { label: 'Close all', disabled: !all.length, title: all.length ? undefined : 'Stop the query first.', run: () => exec('closeAllTabs') },
    ];
  }
  function reopenLast() {
    const opened = S.reopenTabs();
    if (opened.length) focusEl(tabEls.get(opened[0].id)?.el);
  }
  function duplicateTab(id) {
    const t = tabById(id);
    if (!t) return;
    const i = st.tabs.indexOf(t);
    S.createTab({ title: `${t.title} (copy)`, sql: t.sql, caret: [...t.caret], scroll: t.scroll }, { index: i + 1 });
  }
  function moveBy(id, d) {
    const t = tabById(id);
    if (!t) return false;
    const to = S.moveTabBy(id, d);
    if (to < 0) return false;
    announce(moveNode(t.title, to, st.tabs.length));
    focusEl(tabEls.get(id)?.el);
    return true;
  }
  // Close, Close others, Close to the right (03 §3): never the running tab; tabs with pending grid edits ask once
  // 'Discard 5 pending changes?' first. The question can stay open while things change (a toast's action is not
  // inert), so the list is checked again after it: a tab that started running meanwhile or no longer exists is left
  // out, and only the pending edits of tabs that really closed are dropped (03 §7.2: never discarded otherwise).
  async function closeTabsUi(idList) {
    const runId = st.running?.tabId ?? null;
    const list = idList.filter(id => id !== runId && tabById(id));
    if (!list.length) {
      if (idList.includes(runId)) toast('Stop the query first.', { kind: 'info' });
      return [];
    }
    const pending = list.reduce((n, id) => n + editsOf(id), 0);
    let ids = list;
    if (pending > 0) {
      if (!(await confirm({ title: discardTitle(pending), body: 'Grid edits that have not been written to Dataverse are lost when the tab closes.', ok: 'Discard', cancel: 'Keep editing', danger: true }))) return [];
      if (destroyed) return [];
      const runNow = st.running?.tabId ?? null;
      ids = list.filter(id => id !== runNow && tabById(id));
      if (!ids.length) {
        if (list.includes(runNow)) toast('Stop the query first.', { kind: 'info' });
        return [];
      }
    }
    settleStrip();
    const focusWasInTabs = qlist.contains(active());
    const { closed } = S.closeTabs(ids);
    dropClosedEdits(ids);
    if (closed.length) toast(closedNode(closed), { action: { label: 'Undo', run: () => undoClose(closed) } });
    if (focusWasInTabs) focusEl(tabEls.get(st.activeTab)?.el);
    return closed;
  }
  // The pending-edit counts of the listed tabs that are gone now (renderTabs drops them too, unless a rename or drag
  // kept it from rendering); a tab that stayed open keeps its amber dot and count.
  function dropClosedEdits(ids) {
    for (const id of ids) if (!tabById(id)) pendingEdits.delete(id);
  }
  // A rename or a drag of the strip ends before tabs close, so the strip renders the new list at once.
  function settleStrip() {
    if (renaming) finishRename(true);
    if (drag) dragEnd(false);
  }
  // The closed-tab toast's Undo: the tabs come back in their old order, with fresh sessions (03 §3).
  function undoClose(closed) {
    const o = S.reopenTabs(closed);
    if (o.length) focusEl(tabEls.get(o[0].id)?.el);
  }
  // Close all (03 §3): every query tab in one step except a running one, which stays open (the toast says so);
  // tabs with pending grid edits ask once first, and Keep editing (or Escape) keeps those tabs and closes the others.
  // One toast with Undo; when no tab stays open, state.js opens an empty 'Query 1'.
  let closingAll = false;   // a Close all question is open: a second Close all waits for it, never stacks another
  async function closeAllTabsUi() {
    if (closingAll) return [];
    const snapshot = st.tabs.map(t => t.id);
    if (!closeTargets(st.tabs, null, 'all', st.running?.tabId ?? null).length) {
      if (st.running && tabById(st.running.tabId)) toast('Stop the query first.', { kind: 'info' });
      return [];
    }
    let kept = new Set();
    const withEdits = closeTargets(st.tabs, null, 'all', st.running?.tabId ?? null).filter(id => editsOf(id) > 0);
    if (withEdits.length) {
      const one = withEdits.length === 1;
      closingAll = true;
      let discard = false;
      try {
        discard = await confirm({
          title: discardTabsTitle(withEdits.length),
          body: one ? 'Grid edits that have not been written to Dataverse are lost when the tab closes. Keep editing leaves it open and closes the other tabs.'
            : 'Grid edits that have not been written to Dataverse are lost when these tabs close. Keep editing leaves them open and closes the other tabs.',
          ok: 'Discard', cancel: 'Keep editing', danger: true,
        });
      } finally { closingAll = false; }
      if (destroyed) return [];
      if (!discard) kept = new Set(withEdits);
    }
    // The tabs of the click that still exist, except kept ones and the tab running now (it may have changed meanwhile).
    const runId = st.running?.tabId ?? null;
    const list = snapshot.filter(id => id !== runId && !kept.has(id) && tabById(id));
    if (!list.length) return [];
    settleStrip();
    const focusWasInTabs = qlist.contains(active());
    const { closed } = S.closeTabs(list);
    dropClosedEdits(list);
    const stayed = runId && snapshot.includes(runId) && tabById(runId) ? titleOf(runId) : null;
    if (closed.length) toast(closeAllNode(closed, stayed), { action: { label: 'Undo', run: () => undoClose(closed) } });
    if (focusWasInTabs) focusEl(tabEls.get(st.activeTab)?.el);
    return closed;
  }

  // Rename (double-click / F2): Enter or blur commits, Escape (cascade step 3) cancels.
  function startRename(id) {
    const r = tabEls.get(id), t = tabById(id);
    if (!r || !t || renaming || drag?.active) return;
    const input = h('input', { class: 'rn', type: 'text', value: t.title, maxlength: '100', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Query tab name' });
    r.tt.hidden = true;
    r.el.insertBefore(input, r.tt);
    renaming = { id, input, r };
    // The inline editor keeps its keys (no shortcut runs while renaming), but a key Edge also uses (F5 Reload, Ctrl+S
    // Save page, Ctrl+D Favorite, Ctrl+K search, … of any scope) is still swallowed (03 §9); Escape reaches the cascade
    // through the root's capture listener.
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); finishRename(true); return; }
      if (e.key !== 'Escape' && !isModifierOnly(e) && edgeStroke(e, { mac })) e.preventDefault();
    });
    input.addEventListener('blur', () => finishRename(true));
    for (const t2 of ['pointerdown', 'dblclick', 'contextmenu']) input.addEventListener(t2, e => e.stopPropagation());
    focusEl(input);
    input.select?.();
  }
  function finishRename(commit) {
    const rn = renaming;
    if (!rn) return false;
    renaming = null;
    const v = String(rn.input.value ?? '').trim();
    rn.input.remove();
    rn.r.tt.hidden = false;
    if (commit && v && v !== tabById(rn.id)?.title) S.updateTab(rn.id, { title: v });
    renderTabs();
    focusEl(tabEls.get(rn.id)?.el);
    return true;
  }

  // Drag-reorder (03 §3).
  let drag = null;
  let suppressClick = false;
  listen(qlist, 'pointerdown', e => {
    if (e.button !== 0 || renaming) return;
    const id = tabIdOf(e.target);
    if (!id || e.target.closest?.('.x')) return;
    if (drag) dragEnd(false);
    const el = tabEls.get(id).el;
    drag = { id, el, pid: e.pointerId, x0: e.clientX, active: false, from: st.tabs.findIndex(t => t.id === id), to: -1, lastX: e.clientX, raf: null, stop: null };
    drag.stop = track(el, e.pointerId, { move: dragMove, up: dragUp, cancel: () => dragEnd(false) });
  });
  function dragStart() {
    const d = drag;
    d.active = true;
    closeTransient();
    const els = st.tabs.map(t => tabEls.get(t.id)?.el);
    d.els = els;
    d.scroll0 = qlist.scrollLeft || 0;
    const rects = els.map(x => x.getBoundingClientRect());
    d.centers = rects.map(r => r.left + r.width / 2 + d.scroll0);
    d.shift = (rects[d.from]?.width || 0) + 2;
    d.lo = rects.length ? rects[0].left + d.scroll0 : 0;
    d.hi = rects.length ? rects[rects.length - 1].right + d.scroll0 : 0;
    d.width = rects[d.from]?.width || 0;
    qtabs.classList.add('reorder');
    d.el.classList.add('drag');
  }
  function dragLayout() {
    const d = drag;
    if (!d?.active) return;
    const scroll = qlist.scrollLeft || 0;
    let off = d.lastX - d.x0 + (scroll - d.scroll0);
    const c0 = d.centers[d.from];
    off = clampN(off, d.lo - c0, d.hi - c0);
    d.el.style.setProperty('transform', `translateX(${Math.round(off)}px)`);
    d.to = dropIndex(d.centers, d.from, c0 + off);
    const offsets = slideOffsets(d.els.length, d.from, d.to, d.shift);
    d.els.forEach((x, i) => { if (i !== d.from) { if (offsets[i]) x.style.setProperty('transform', `translateX(${offsets[i]}px)`); else x.style.removeProperty('transform'); } });
  }
  function dragTick() {
    const d = drag;
    if (!d?.active) return;
    d.raf = null;
    const r = qlist.getBoundingClientRect();
    const speed = edgeScrollSpeed(d.lastX, r.left, r.right);
    if (speed) {
      const before = qlist.scrollLeft;
      qlist.scrollLeft = before + speed;
      if (qlist.scrollLeft !== before) { dragLayout(); d.raf = frame(dragTick); }
    }
  }
  function dragMove(e) {
    const d = drag;
    if (!d) return;
    d.lastX = e.clientX;
    if (!d.active) { if (Math.abs(e.clientX - d.x0) < 4) return; dragStart(); }
    dragLayout();
    if (d.raf == null) d.raf = frame(dragTick);
  }
  function dragUp(e) {
    const d = drag;
    if (!d) return;
    if (!d.active) { dragEnd(); return; }
    const r = qtabs.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    suppressClick = true;
    later(() => { suppressClick = false; }, 0);
    dragEnd(inside);
  }
  function dragEnd(commit = false) {
    const d = drag;
    if (!d) return false;
    drag = null;
    d.stop?.();
    if (d.raf != null) unframe(d.raf);
    if (!d.active) return false;
    qtabs.classList.remove('reorder');
    d.el.classList.remove('drag');
    for (const x of d.els) x?.style.removeProperty('transform');
    if (commit && d.to >= 0 && d.to !== d.from) {
      const title = titleOf(d.id);
      const to = S.moveTab(d.id, d.to);
      if (to >= 0) announce(moveNode(title, to, st.tabs.length));
    }
    renderTabs();
    focusEl(tabEls.get(d.id)?.el);
    return true;
  }

  // ---- shell commands ----------------------------------------------------------------------------------------------
  // F8 (03 §3): wide, it collapses or expands the explorer and saves layout.sideCollapsed; below 720 px it only flips
  // the memory-only .keep, so the stored choice survives looking at the explorer in a narrow window.
  function toggleExplorer() {
    const r = explorerToggle({ collapsed: st.layout.sideCollapsed, narrow: isNarrow(), keep });
    const wasIn = inSide(active());
    keep = r.keep;
    if (r.collapsed !== st.layout.sideCollapsed) S.setLayout({ sideCollapsed: r.collapsed });
    applyLayout();
    if (wasIn && (side.hidden || !rendered(side))) focusPane('editor');
  }
  function toggleResults() {
    const wasIn = res.contains(active());
    S.setLayout({ resPane: st.layout.resPane === 'hidden' ? 'normal' : 'hidden' });
    applyLayout();
    if (wasIn && st.layout.resPane === 'hidden') focusPane('editor');
  }
  const PANES = [['side', side], ['editor', ed], ['results', res], ['status', statusBar]];
  const lastFocus = new Map();
  let lastWindowFocus = null;
  listen(root, 'focusin', e => {
    const t = e.target;
    for (const [n, el] of PANES) if (el.contains(t)) lastFocus.set(n, t);
    if (win.contains(t)) lastWindowFocus = t;
    // Chords work only in the editor (03 §9): focus moving elsewhere cancels a pending one silently.
    if (chord && !(isEl(t) && ed.contains(t))) cancelChord();
  });
  // Focus leaving the editor for the page or the browser (no focusin inside the tool follows) and the window losing
  // focus (Alt+Tab, the browser's own UI) cancel a pending chord too, so a key typed on return acts as usual.
  listen(ed, 'focusout', e => { const to = e.relatedTarget; if (chord && !(isEl(to) && ed.contains(to))) cancelChord(); });
  listen(globalThis, 'blur', () => { cancelChord(); });
  function visiblePanes() {
    const L = st.layout;
    return PANES.filter(([n, el]) => !el.hidden && rendered(el) && !(n === 'results' && L.resPane === 'hidden') && !(n === 'editor' && L.resPane === 'max')).map(([n]) => n);
  }
  // Moves focus into a pane: its last focused element, else its first focusable one, else the pane itself. While a
  // dialog or the sheet makes the body inert, focus goes to the top dialog (staying where it is inside it), else to
  // the sheet's title (03 §3 Focus). False when the window is not shown or the pane is unknown, hidden or not rendered.
  function focusPane(name) {
    const el = PANES.find(([n]) => n === name)?.[1];
    if (!el || vis !== 'shown') return false;
    if (body.inert) {
      const d = topShownDialog();
      if (d) { if (!d.el.contains(active())) focusInitial(d); return true; }
      if (sheet && !sheet.closed) { focusEl(sheet.h2); return true; }
    }
    if (inertOrHidden(el, root) || !rendered(el)) return false;
    const last = lastFocus.get(name);
    let target = last && el.contains(last) && canFocusAny(last, root) ? last : focusables(el)[0];
    if (!target) { if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1'); target = el; }
    focusEl(target);
    return true;
  }
  const canFocusAny = (el, stop) => isEl(el) && !el.disabled && !inertOrHidden(el, stop) && rendered(el);
  // True when `el` can still hold focus, decided from flags only (no layout read, 03 §13): connected, not disabled, and
  // neither it nor an ancestor up to the root is hidden or inert.
  const holdsFocus = el => isEl(el) && !!el.isConnected && !el.disabled && !inertOrHidden(el, root);
  // A sensible focus target when the element focus should return to is gone: the top dialog,
  // else the open sheet's title, else the preferred pane, else any visible pane.
  function focusDefault(pref = 'editor') {
    if (vis !== 'shown') return false;
    const d = topShownDialog();
    if (d) { focusInitial(d); return true; }
    if (sheet && !sheet.closed) { focusEl(sheet.h2); return true; }
    for (const n of [pref, ...visiblePanes()]) if (focusPane(n)) return true;
    return false;
  }
  // Keeps keyboard focus in the tool when the focused control has just been disabled or hidden (Chromium's focus
  // fixup would move it to the page's <body>, where neither KEYMAP nor the Escape cascade sees a key): focus goes to
  // the first of `prefs` that can take it, else to the default target. False when `prev` can
  // still hold focus (holdsFocus: flags only) or focus has already moved elsewhere; only a real move measures.
  function rescueFocus(prev, ...prefs) {
    if (!isEl(prev) || vis !== 'shown') return false;
    const a = active();
    if (a && a !== prev) return false;
    if (!a && doc.activeElement && doc.activeElement !== doc.body && doc.activeElement !== host) return false;
    if (holdsFocus(prev)) return false;
    for (const p of prefs) {
      if (p === 'editor') { if (focusPane('editor')) return true; continue; }
      if (isEl(p) && p !== prev && canFocusAny(p, root) && p.isConnected) { focusEl(p); return true; }
    }
    return focusDefault('editor');
  }
  function cyclePane(dir) {
    const a = active();
    const cur = PANES.find(([, el]) => el.contains(a))?.[0] ?? null;
    const next = nextPane(visiblePanes(), cur, dir);
    return next ? focusPane(next) : false;
  }
  function stepTab(dir) {
    const n = st.tabs.length;
    if (n < 2) return;
    const i = st.tabs.findIndex(t => t.id === st.activeTab);
    const t = st.tabs[neighborIndex(n, i < 0 ? 0 : i, dir)];
    S.setActiveTab(t.id);
    if (qlist.contains(active())) focusEl(tabEls.get(t.id)?.el);
  }
  // A module callback the shell runs from its own controls (sheet Previous / Next): a throw or a rejection shows in an
  // error toast inside the tool, never on the page's window (03 §1.4 'Errors the shell catches').
  function callSafe(fn) {
    try {
      const r = fn();
      if (r && typeof r.then === 'function') r.then(null, fail);
    } catch (e) { fail(e); }
  }
  function sheetNav(dir) {
    const fn = dir < 0 ? sheet?.o.onPrev : sheet?.o.onNext;
    if (typeof fn !== 'function') return false;
    callSafe(fn);
    return true;
  }
  const OWN = {
    newTab: () => { S.createTab({}); focusPane('editor'); },
    closeTab: () => { if (st.activeTab) closeTabsUi([st.activeTab]); },
    closeAllTabs: () => closeAllTabsUi(),
    prevTab: () => stepTab(-1),
    nextTab: () => stepTab(1),
    moveTabLeft: () => { if (st.activeTab) moveBy(st.activeTab, -1); },
    moveTabRight: () => { if (st.activeTab) moveBy(st.activeTab, 1); },
    toggleExplorer,
    toggleResults,
    nextPane: () => cyclePane(1),
    prevPane: () => cyclePane(-1),
    sheetPrev: () => sheetNav(-1),
    sheetNext: () => sheetNav(1),
  };

  // Convert ▸ Copy as Power BI (M) (03 §3): the editor's selection if non-empty, else its whole text (through
  // opts.editorText; without it the active tab's sql and caret in state); enabled for exactly one SELECT without
  // session state (each text checked once). The copy starts in the click (util.copyText before any await).
  let pbiText = null, pbiOk = false;
  const pbiSource = () => {
    const v = editorText ? editorText() : null;
    if (v && typeof v === 'object' && typeof v.text === 'string') return powerBiSource(v.text, [v.start, v.end]);
    const t = tabById(st.activeTab);
    return t ? powerBiSource(t.sql, t.caret) : '';
  };
  const pbiEligible = sql => { if (sql !== pbiText) { pbiText = sql; pbiOk = powerBiEligible(sql); } return pbiOk; };
  const copyPowerBi = {
    state: () => (pbiEligible(pbiSource()) ? {} : { disabled: true, title: POWER_BI_DISABLED }),
    run: () => {
      const sql = pbiSource();
      if (!pbiEligible(sql)) { toast(POWER_BI_DISABLED, { kind: 'info' }); return false; }
      const copy = typeof io?.copyText === 'function' ? io.copyText : copyText;
      let p;
      try { p = copy(powerBiM(sql, globalThis.location?.host ?? '')); } catch (e) { p = Promise.reject(e); }
      return Promise.resolve(p).then(ok => {
        if (ok) toast(POWER_BI_TOAST, { kind: 'info' });
        else toast('Could not copy to the clipboard.', { kind: 'error' });
      });
    },
  };

  // ---- keyboard ----------------------------------------------------------------------------------------------------
  let chord = null;
  function cancelChord() {
    if (!chord) return false;
    cancel(chord.timer);
    chord.clear();
    chord = null;
    return true;
  }
  function armChord(stroke, label) {
    cancelChord();
    chord = { stroke, label, clear: status(chordPrompt(label), { ms: 3000 }), timer: later(() => cancelChord(), 3000) };
  }
  function keyContext(e) {
    const t = isEl(e.target) ? e.target : null;
    if (!t) return { scope: 'global', field: false };
    const s = t.closest?.('[data-scope]');
    return { scope: s ? s.getAttribute('data-scope') : 'global', field: isField(t) && !t.hasAttribute('data-scope') };
  }
  const modalShown = () => dialogs.some(d => d.shown);
  // No shortcut runs (03 §9) while a dialog is open or waits behind the pill (isModalOpen()) or while the window is
  // not shown (focus on the minimised pill: global shortcuts work only inside the tool's window).
  const keysBlocked = () => dialogs.length > 0 || vis !== 'shown';

  // 'Esc then Tab leaves the editor' (03 §5, §9): focus moves to the next (back: previous) pane in the F6 order
  // explorer -> editor -> results -> status bar, skipping panes that are hidden and wrapping; false when no other
  // pane can take focus (the browser's Tab then applies).
  function leaveEditor(back) {
    const shownPanes = new Set(visiblePanes());
    const order = PANES.map(([n]) => n);
    const at = order.indexOf('editor');
    for (let k = 1; k < order.length; k++) {
      const n = order[(at + (back ? -k : k) + order.length) % order.length];
      if (shownPanes.has(n) && focusPane(n)) return true;
    }
    return false;
  }
  let escTab = false;   // the last key was an Escape in the editor region

  // Capture phase: the Escape cascade, 'Esc then Tab' and the second stroke of a pending chord.
  listen(root, 'keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      escTab = vis === 'shown' && !modalShown() && isEl(e.target) && ed.contains(e.target);
      escape(e);
      return;
    }
    if (e.key === 'Tab' && escTab && !e.ctrlKey && !e.altKey && !e.metaKey) {
      escTab = false;
      if (!chord && vis === 'shown' && !modalShown() && isEl(e.target) && ed.contains(e.target)) {
        e.stopPropagation();
        if (leaveEditor(e.shiftKey)) e.preventDefault();
        return;
      }
    } else if (!isModifierOnly(e)) escTab = false;
    if (!chord || isModifierOnly(e)) return;
    const { stroke, label } = chord;
    cancelChord();
    // A chord completes only in the editor (03 §9): a key typed elsewhere, in a field without its own scope or while
    // keys are blocked only cancels it (silently) and then acts as usual, so a typed character is never lost.
    const ctx = keyContext(e);
    if (keysBlocked() || ctx.scope !== 'editor' || ctx.field) return;
    e.preventDefault();
    e.stopPropagation();
    const entry = chordEntry(stroke, e, { mac });
    if (entry) { exec(entry.id, e); return; }
    status(chordInvalid(label, strokeLabel(e, mac)), { ms: 3000 });
  }, true);
  listen(root, 'pointerdown', () => { escTab = false; cancelChord(); }, true);

  // Bubbling phase: KEYMAP bindings (keyAction decides; element handlers that took a key already preventDefault()ed it).
  listen(root, 'keydown', e => {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.key === 'Escape' || isModifierOnly(e)) return;
    const ctx = keyContext(e);
    const a = keyAction(e, { scope: ctx.scope, field: ctx.field, modal: keysBlocked(), mac });
    if (!a) return;
    if (a.act === 'swallow') { e.preventDefault(); return; }
    if (a.act === 'chord') {
      e.preventDefault();
      armChord(a.stroke, keysFor(a.entry, mac).split(/\s+/)[0]);
      return;
    }
    // An unbound, disabled or declining command leaves the key to the browser unless it is an Edge key (03 §9), its own
    // or another scope's binding's.
    const edge = () => !!a.entry.edge || edgeStroke(e, { mac });
    const c = topCmd(a.entry.id);
    let blocked = !c?.run;
    if (!blocked && c.state) { let s = null; try { s = c.state(); } catch (err) { fail(err); } blocked = !!s?.disabled; }
    if (blocked) { if (edge()) e.preventDefault(); return; }
    let r;
    try { r = c.run(e); } catch (err) { e.preventDefault(); fail(err); return; }
    if (r && typeof r.then === 'function') r.then(null, fail);
    if (r !== false || edge()) e.preventDefault();
  });

  // Tab wraps inside the window and the toast stack; dialogs trap their own Tab.
  listen(root, 'keydown', e => {
    if (e.key !== 'Tab' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || modalShown() || vis !== 'shown') return;
    const a = active();
    if (!a || !(win.contains(a) || toasts.contains(a))) return;
    const items = [...focusables(panel), ...focusables(toasts)];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && a === first) { e.preventDefault(); focusEl(last); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); focusEl(first); }
  });

  function clearSearch(t) {
    const el = active() ?? (isEl(t) ? t : null);
    if (!el || el.localName !== 'input' || String(el.type || el.getAttribute('type')).toLowerCase() !== 'search' || !el.value) return false;
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    return true;
  }
  // The Escape cascade (03 §9). Steps 2-4 of other modules run only while their region can be used (escUsable), so
  // an Escape in a dialog cancels the dialog; steps 8-11 act only while the window is shown (never on the pill).
  function escape(e) {
    e.preventDefault();
    const shownNow = vis === 'shown';
    return runEscape({
      chord: cancelChord,
      drag: () => dragEnd(false) || runEsc('drag', e),
      edit: () => finishRename(false) || runEsc('edit', e),
      popup: () => runEsc('popup', e) || closeTopPop(p => p.role === 'tooltip', false),
      menu: closeTopMenuLevel,
      popover: () => closeTopPop(p => p.role === 'dialog', true) || hideTip(),
      search: () => clearSearch(e.target),
      dialog: () => { const d = shownNow && topShownDialog(); if (!d) return false; cancelDialog(d); return true; },
      sheet: () => (shownNow && sheet ? (closeSheet('escape'), true) : false),
      find: () => shownNow && runEsc('find', e),
      stop: () => shownNow && !st.running?.write && runEsc('stop', e),
    });
  }

  // ---- menus -------------------------------------------------------------------------------------------------------
  const menus = [];   // open levels, root first
  // Opens a menu at an element, rect or {x, y} (03 §1.4); returns close(). The same anchor again closes it.
  function menu(anchor, items, o = {}) {
    const isAnchorEl = isEl(anchor);
    if (menus.length && isAnchorEl && menus[0].anchor === anchor) { closeMenus({ focusTrigger: true }); return () => {}; }
    closeMenus();
    hideTip();
    const trigger = o.trigger ?? (isAnchorEl ? anchor : active());
    const scrollAnchor = isAnchorEl ? anchor : isEl(o.scrollAnchor) ? o.scrollAnchor : null;
    const level = openLevel(anchor, items, { align: o.align === 'end' ? 'end' : 'start', label: o.label, trigger, parent: null, scrollAnchor });
    return () => closeLevel(level, false);
  }
  // A context menu at the pointer (or at the focused element for the keyboard's context-menu key). The event's target
  // is its scroll anchor: scrolling the grid or list it belongs to closes it (03 §1.5).
  function contextMenu(ev, items) {
    ev?.preventDefault?.();
    const t = isEl(ev?.target) ? ev.target : null;
    const keyboard = !ev || (!ev.clientX && !ev.clientY) || ev.button === -1;
    const anchor = keyboard && t ? rectOf(t) : { x: ev.clientX, y: ev.clientY };
    const trigger = active() ?? t;
    if (menus.length) closeMenus();
    return menu(anchor, items, { trigger, scrollAnchor: t });
  }
  function openLevel(anchor, items, { align, label, trigger, parent, parentIndex, scrollAnchor = null }) {
    const level = { anchor, items, trigger, parent, parentIndex, scrollAnchor, el: null, buttons: [], child: null, index: -1, closed: false, prevExpanded: null };
    level.el = h('div', { class: 'menu', popover: 'manual', role: 'menu', tabindex: '-1', 'aria-label': label || undefined });
    renderMenu(level, false);
    app.appendChild(level.el);
    level.el.showPopover();
    placeLevel(level, align);
    if (isEl(anchor)) { level.prevExpanded = anchor.getAttribute('aria-expanded'); anchor.setAttribute('aria-expanded', 'true'); }
    level.el.addEventListener('keydown', e => menuKey(level, e));
    level.el.addEventListener('click', e => { const i = level.buttons.findIndex(x => x.b.contains(e.target)); if (i >= 0) activateItem(level, i); });
    level.el.addEventListener('pointermove', e => {
      const i = level.buttons.findIndex(x => x.b.contains(e.target));
      if (i < 0) return;
      if (i !== level.index) focusItem(level, i);
      if (level.buttons[i].sub) openSub(level, i, false); else if (level.child) closeLevel(level.child, false);
    });
    menus.push(level);
    focusItem(level, firstEnabled(level));
    return level;
  }
  function placeLevel(level, align = 'start') {
    const v = vp();
    if (level.parent) {
      const r = rectOf(level.anchor);
      const p = submenuPlace(r, { w: level.el.offsetWidth, h: level.el.offsetHeight }, v);
      level.el.style.setProperty('left', p.x + 'px');
      level.el.style.setProperty('top', p.y + 'px');
    } else placeNear(level.el, rectOf(level.anchor), v, { align, gap: isEl(level.anchor) ? 4 : 2 });
  }
  // A menu level's items: an array, or a function a module passed (called on open and on every refresh); a throwing
  // builder shows an error toast and the level reads 'Nothing here.', so it never escapes to whoever called refresh().
  function renderMenu(level, keepFocus) {
    let list;
    try { list = typeof level.items === 'function' ? level.items() : level.items; } catch (e) { fail(e); list = null; }
    if (!Array.isArray(list)) list = [];
    const focusIdx = keepFocus ? level.index : -1;
    clear(level.el);
    level.buttons = [];
    const real = list.filter(it => it && it !== '-');
    const hasCheck = real.some(it => it.checked !== undefined);
    const hasIcon = real.some(it => it.icon || it.busy);
    for (const it of list) {
      if (!it || it === '-') { if (level.el.lastChild && level.el.lastChild.classList?.contains('mi')) level.el.append(h('div', { class: 'sep', role: 'separator' })); continue; }
      const sub = Array.isArray(it.items) || typeof it.items === 'function';
      const disabled = !!it.disabled || !!it.busy;
      const b = h('button', {
        class: 'mi' + (it.danger ? ' danger' : ''), type: 'button', tabindex: '-1',
        role: it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem', title: it.title || undefined,
        'aria-checked': it.checked !== undefined ? String(!!it.checked) : undefined, 'aria-disabled': disabled ? 'true' : undefined,
        'aria-busy': it.busy ? 'true' : undefined, 'aria-haspopup': sub ? 'menu' : undefined, 'aria-expanded': sub ? 'false' : undefined,
        'aria-keyshortcuts': undefined,
      });
      if (hasCheck) b.append(h('span', { class: 'ck', 'aria-hidden': 'true' }, it.checked ? icon('check', 16) : null));
      if (hasIcon) b.append(it.busy ? h('span', { class: 'spin', 'aria-hidden': 'true' }) : it.icon ? icon(it.icon, 16) : h('span', { style: 'width:16px;flex:none', 'aria-hidden': 'true' }));
      b.append(h('span', { class: 'tx' }, h('span', { text: String(it.label ?? '') }), it.hint ? h('small', { text: String(it.hint) }) : null));
      if (it.kbd) b.append(h('kbd', { text: String(it.kbd) }));
      if (sub) b.append(icon('chevron', 16, 'chev'));
      level.el.append(b);
      level.buttons.push({ b, it, sub, disabled });
    }
    if (level.el.lastChild?.classList?.contains('sep')) level.el.lastChild.remove();
    if (!level.buttons.length) level.el.append(h('div', { class: 'm-empty', text: 'Nothing here.' }));
    if (keepFocus && focusIdx >= 0 && level.buttons.length) focusItem(level, Math.min(focusIdx, level.buttons.length - 1));
  }
  const firstEnabled = level => { const i = level.buttons.findIndex(x => !x.disabled); return i >= 0 ? i : (level.buttons.length ? 0 : -1); };
  function focusItem(level, i) {
    if (i == null || i < 0 || i >= level.buttons.length) return;
    level.index = i;
    focusEl(level.buttons[i].b);
  }
  function activateItem(level, i) {
    const x = level.buttons[i];
    if (!x || x.disabled) return;
    if (x.sub) { openSub(level, i, true); return; }
    closeMenus({ focusTrigger: true });
    try {
      const r = x.it.run?.();
      if (r && typeof r.then === 'function') r.then(null, fail);
    } catch (e) { fail(e); }
  }
  function openSub(level, i, focus) {
    const x = level.buttons[i];
    if (!x || x.disabled || !x.sub) return;
    if (level.child && level.child.parentIndex === i) { if (focus) focusItem(level.child, firstEnabled(level.child)); return; }
    if (level.child) closeLevel(level.child, false);
    const child = openLevel(x.b, x.it.items, { align: 'start', label: x.it.label, trigger: x.b, parent: level, parentIndex: i });
    level.child = child;
    if (!focus) focusItem(level, i);
  }
  function closeLevel(level, focusTrigger) {
    if (!level || level.closed) return false;
    if (level.child) closeLevel(level.child, false);
    level.closed = true;
    const i = menus.indexOf(level);
    if (i >= 0) menus.splice(i, 1);
    if (level.parent && level.parent.child === level) level.parent.child = null;
    try { level.el.hidePopover(); } catch { /* already hidden */ }
    level.el.remove();
    if (isEl(level.anchor)) {
      if (level.prevExpanded == null && !level.anchor.hasAttribute('aria-haspopup')) level.anchor.removeAttribute('aria-expanded');
      else level.anchor.setAttribute('aria-expanded', 'false');
    }
    if (focusTrigger) {
      const t = level.parent ? level.anchor : level.trigger;
      if (isEl(t) && (inRoot(t) || t.isConnected)) focusEl(t);
    }
    return true;
  }
  function closeMenus({ focusTrigger = false } = {}) {
    if (!menus.length) return false;
    const rootLevel = menus[0];
    closeLevel(rootLevel, focusTrigger);
    menus.length = 0;
    return true;
  }
  const closeTopMenuLevel = () => (menus.length ? closeLevel(menus[menus.length - 1], true) : false);
  function menuKey(level, e) {
    const n = level.buttons.length;
    const k = e.key;
    const to = menuMove(n, level.index, k);
    if (to != null) { e.preventDefault(); focusItem(level, to); return; }
    if (k === 'Enter' || k === ' ') { e.preventDefault(); if (level.index >= 0) activateItem(level, level.index); return; }
    if (k === 'ArrowRight') { const x = level.buttons[level.index]; if (x?.sub) { e.preventDefault(); openSub(level, level.index, true); } return; }
    if (k === 'ArrowLeft') { if (level.parent) { e.preventDefault(); closeLevel(level, true); } return; }
    if (k === 'Tab') { e.preventDefault(); closeMenus({ focusTrigger: true }); return; }
    if (k.length === 1 && k !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const i = menuMatch(level.buttons.map(x => x.it.label), level.index, k);
      if (i >= 0) { e.preventDefault(); focusItem(level, i); }
    }
  }

  // ---- popovers and tooltips ---------------------------------------------------------------------------------------
  const pops = [];
  // Shows `node` in a top-layer popover near an element or rect (03 §1.4, §1.5).
  function popover(anchor, node, o = {}) {
    const role = o.role === 'tooltip' ? 'tooltip' : 'dialog';
    if (role === 'dialog') closePopsWhere(p => p.role === 'dialog', 'replaced');
    hideTip();
    const el = h('div', { class: 'pop', popover: 'manual', role, id: nextId('ss-pop'), 'aria-label': o.label || undefined }, node ?? null);
    app.appendChild(el);
    el.showPopover();
    const p = { el, anchor, role, onClose: typeof o.onClose === 'function' ? o.onClose : null, closed: false, prevExpanded: null, reposition: null };
    p.reposition = () => { if (!p.closed) placeNear(el, rectOf(p.anchor), vp(), { gap: 4 }); };
    p.reposition();
    if (role === 'dialog') {
      if (isEl(anchor)) { p.prevExpanded = anchor.getAttribute('aria-expanded'); anchor.setAttribute('aria-expanded', 'true'); }
      el.addEventListener('focusout', e => {
        const to = e.relatedTarget;
        if (to && !el.contains(to) && !(isEl(anchor) && anchor.contains(to))) closePop(p, 'blur', false);
      });
      const f = el.querySelector('input') ?? focusables(el)[0];
      if (f) focusEl(f);
    }
    pops.push(p);
    return { el, close: () => { closePop(p, 'close', false); }, reposition: () => p.reposition() };
  }
  function closePop(p, reason, focusAnchor) {
    if (p.closed) return false;
    p.closed = true;
    const i = pops.indexOf(p);
    if (i >= 0) pops.splice(i, 1);
    try { p.el.hidePopover(); } catch { /* already hidden */ }
    p.el.remove();
    if (p.role === 'dialog' && isEl(p.anchor)) {
      if (p.prevExpanded == null && !p.anchor.hasAttribute('aria-haspopup')) p.anchor.removeAttribute('aria-expanded');
      else p.anchor.setAttribute('aria-expanded', 'false');
    }
    if (focusAnchor && isEl(p.anchor) && inRoot(p.anchor)) focusEl(p.anchor);
    if (p.onClose) { try { p.onClose(reason); } catch (e) { fail(e); } }
    return true;
  }
  function closeTopPop(pred, focusAnchor) {
    for (let i = pops.length - 1; i >= 0; i--) if (pred(pops[i])) return closePop(pops[i], 'escape', focusAnchor);
    return false;
  }
  function closePopsWhere(pred, reason) {
    let any = false;
    for (const p of [...pops]) if (pred(p)) any = closePop(p, reason, false) || any;
    return any;
  }

  let tipOpen = false, tipFor = null, tipTimer = null;
  // Shows textOrFn (a string or a function returning one) as a tooltip for `el`; returns the unbind function.
  function tooltip(el, textOrFn) {
    if (!isEl(el)) throw new TypeError('shell.tooltip(): an element is required.');
    const text = () => { try { return typeof textOrFn === 'function' ? textOrFn() : textOrFn; } catch (e) { fail(e); return ''; } };
    const schedule = () => { cancel(tipTimer); tipTimer = later(() => showTip(el, text()), TIP_DELAY); };
    const hideFor = () => { cancel(tipTimer); tipTimer = null; if (tipFor === el) hideTip(); };
    const onFocus = () => { let fv = false; try { fv = el.matches(':focus-visible'); } catch { fv = false; } if (fv) schedule(); };
    const pairs = [['pointerenter', schedule], ['pointerleave', hideFor], ['focus', onFocus], ['blur', hideFor], ['pointerdown', hideFor]];
    for (const [t, f] of pairs) el.addEventListener(t, f);
    return () => { for (const [t, f] of pairs) el.removeEventListener(t, f); if (tipFor === el) hideTip(); };
  }
  function showTip(el, s) {
    const text = s == null ? '' : String(s);
    if (!text || !inRoot(el) || vis !== 'shown') return;
    if (tipFor && tipFor !== el) hideTip();
    tip.textContent = text;
    if (!tipOpen) { tip.showPopover(); tipOpen = true; }
    placeNear(tip, el.getBoundingClientRect(), vp(), { gap: 6 });
    tipFor = el;
    const d = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (!d.includes(ids.tip)) el.setAttribute('aria-describedby', [...d, ids.tip].join(' '));
  }
  function hideTip() {
    cancel(tipTimer);
    tipTimer = null;
    if (!tipOpen) return false;
    try { tip.hidePopover(); } catch { /* already hidden */ }
    tipOpen = false;
    if (tipFor) {
      const d = (tipFor.getAttribute('aria-describedby') || '').split(/\s+/).filter(x => x && x !== ids.tip);
      if (d.length) tipFor.setAttribute('aria-describedby', d.join(' ')); else tipFor.removeAttribute('aria-describedby');
    }
    tipFor = null;
    return true;
  }
  function closeTransient() {
    closeMenus();
    closePopsWhere(() => true, 'dismiss');
    hideTip();
  }

  // Outside pointerdown and scrolls close menus and popovers (03 §1.5).
  listen(doc, 'pointerdown', e => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (!path.includes(host)) { closeTransient(); cancelChord(); }
  }, true);
  listen(root, 'pointerdown', e => {
    const t = e.target;
    if (menus.length && !menus.some(l => l.el.contains(t)) && !(isEl(menus[0].anchor) && menus[0].anchor.contains(t))) closeMenus();
    for (const p of [...pops]) if (!p.el.contains(t) && !(isEl(p.anchor) && p.anchor.contains(t))) closePop(p, 'outside', false);
    if (tipOpen && !(tipFor && tipFor.contains(t))) hideTip();
  }, true);
  listen(root, 'scroll', e => {
    const t = e.target;
    if (!isEl(t)) return;
    if (menus.length && !menus.some(l => l.el.contains(t)) && isEl(menus[0].scrollAnchor) && t.contains(menus[0].scrollAnchor)) closeMenus();
    for (const p of [...pops]) if (!p.el.contains(t) && isEl(p.anchor) && t.contains(p.anchor)) closePop(p, 'scroll', false);
    if (tipFor && t.contains(tipFor)) hideTip();
  }, true);

  // ---- toasts ------------------------------------------------------------------------------------------------------
  const toastItems = [];
  let toastsOpen = false;
  // True while another top-layer element is open (03 §1.5): the shell's own menus, popovers and tooltip, or any
  // popover another module showed in the shadow root (completion, signature help, a drag ghost).
  function otherTopLayerOpen() {
    if (menus.length || pops.length || tipOpen) return true;
    try { return !!root.querySelector(':popover-open:not(.toasts)'); } catch { return false; }
  }
  // Re-shows the toast stack so it is the newest top-layer element; the toasts already shown neither replay their
  // entry animation nor restart an exit (those go at once).
  function keepToastsOnTop(fresh) {
    if (!toastsOpen) return;
    for (const t of [...toastItems]) {
      if (t === fresh) continue;
      if (t.done) t.remove?.();
      else t.el.style.setProperty('animation', 'none');
    }
    try { toasts.hidePopover(); toasts.showPopover(); } catch { /* not shown */ }
  }
  function positionToasts() {
    let dx = 0, dy = 0;
    if (vis === 'minimized') dy = 32;
    else if (vis === 'shown' && !st.win.max) {
      const v = vp();
      const r = win.getBoundingClientRect();
      if (r.width > 0 && v.width > 0) { dx = Math.max(0, Math.round(v.width - r.right)); dy = Math.max(0, Math.round(v.height - r.bottom)); }
    }
    toasts.style.setProperty('--toast-dx', dx + 'px');
    toasts.style.setProperty('--toast-dy', dy + 'px');
  }
  // Shows a toast; returns {dismiss, update}.
  function toast(text, o = {}) {
    const kind = Object.hasOwn(TOAST_ICONS, o.kind) ? o.kind : 'info';
    const msg = h('span');
    setChildren(msg, text ?? '');
    const txt = h('div', { class: 'txt' }, msg);
    const item = {
      el: null, timer: null, left: toastDuration(o), started: 0, sticky: !!o.sticky, done: false, poll: null, remove: null,
      hovered: false, focused: false, paused: false, errText: kind === 'error' && typeof text === 'string' ? text : null,
    };
    const dismiss = () => dismissToast(item);
    if (o.action && typeof o.action.run === 'function') {
      const act = o.action.run;
      // Running the action dismisses the toast first; a dismissed toast never runs it again.
      txt.append(h('button', {
        class: 'link act', type: 'button', text: String(o.action.label ?? 'Undo'),
        onclick: () => {
          if (item.done) return;
          dismiss();
          try { const r = act(); if (r && typeof r.then === 'function') r.then(null, fail); } catch (e) { fail(e); }
        },
      }));
    }
    let bar = null;
    if (typeof o.progress === 'function') {
      bar = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Progress' }, h('div'));
      txt.append(bar);
    }
    item.el = h('div', { class: `toast ${kind}`, role: kind === 'warn' || kind === 'error' ? 'alert' : 'status' },
      h('span', { class: 'ic', 'aria-hidden': 'true' }, icon(TOAST_ICONS[kind], 20)), txt,
      h('button', { class: 'x', type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: dismiss }, icon('close', 16)));
    // The timer pauses while the pointer is over the toast or focus is inside it (two flags, so
    // moving focus between its own buttons neither pauses twice nor resumes) and restarts with the time left.
    const arm = () => { if (item.left == null || item.done) return; item.started = now(); item.timer = later(dismiss, item.left); };
    const sync = () => {
      const want = item.hovered || item.focused;
      if (item.done || want === item.paused) return;
      item.paused = want;
      if (!want) { arm(); return; }
      if (item.timer != null) { cancel(item.timer); item.timer = null; item.left = Math.max(1000, item.left - (now() - item.started)); }
    };
    const outside = t => !(isEl(t) && item.el.contains(t));
    item.el.addEventListener('mouseenter', () => { item.hovered = true; sync(); });
    item.el.addEventListener('mouseleave', () => { item.hovered = false; sync(); });
    item.el.addEventListener('focusin', () => { item.focused = true; sync(); });
    item.el.addEventListener('focusout', e => { if (outside(e.relatedTarget)) { item.focused = false; sync(); } });
    toasts.appendChild(item.el);
    toastItems.push(item);
    if (!toastsOpen) { toasts.showPopover(); toastsOpen = true; positionToasts(); }
    else if (otherTopLayerOpen()) keepToastsOnTop(item);
    while (toastItems.filter(t => !t.done).length > TOAST_MAX) {
      const old = toastItems.find(t => !t.done && !t.sticky) ?? toastItems.find(t => !t.done);
      dismissToast(old);
    }
    // A burst of toasts never piles up exiting ones: beyond TOAST_MAX the oldest exiting toast goes at once, so the
    // stack (and every top-layer check) stays small however many toasts arrive in one frame.
    for (let exiting = toastItems.filter(t => t.done); exiting.length > TOAST_MAX;) exiting.shift().remove?.();
    arm();
    if (bar) {
      const tick = () => {
        if (item.done) return;
        let v = null;
        try { v = o.progress(); } catch (e) { fail(e); }
        const fill = bar.firstChild;
        if (v == null || !Number.isFinite(v)) { bar.classList.add('ind'); bar.removeAttribute('aria-valuenow'); }
        else { bar.classList.remove('ind'); fill.style.setProperty('width', clampN(v, 0, 100) + '%'); bar.setAttribute('aria-valuenow', String(Math.round(clampN(v, 0, 100)))); }
        item.poll = later(tick, 250);
      };
      tick();
    }
    return { dismiss, update: t => { if (!item.done) setChildren(msg, t ?? ''); } };
  }
  // Dismisses a toast: it turns inert at once (no second click on its action or ×), plays its exit animation and is
  // removed after it (at once when no animation runs, e.g. prefers-reduced-motion); focus inside it goes back to
  // the window.
  function dismissToast(item) {
    if (!item || item.done) return;
    const wasIn = item.el.contains(active());
    item.done = true;
    cancel(item.timer);
    cancel(item.poll);
    item.el.inert = true;
    item.el.style.removeProperty('animation');
    item.el.classList.add('out');
    let removed = false;
    const remove = item.remove = () => {
      if (removed) return;
      removed = true;
      item.el.remove();
      const i = toastItems.indexOf(item);
      if (i >= 0) toastItems.splice(i, 1);
      if (!toastItems.length && toastsOpen) { try { toasts.hidePopover(); } catch { /* hidden */ } toastsOpen = false; }
    };
    if (wasIn) restoreAfterToast();
    let anim = '';
    try { anim = globalThis.getComputedStyle?.(item.el)?.animationName ?? ''; } catch { anim = ''; }
    if (anim === 'none') { remove(); return; }
    item.el.addEventListener('animationend', e => { if (e.target === item.el) remove(); });
    later(remove, 400);
  }
  function restoreAfterToast() {
    if (lastWindowFocus && win.contains(lastWindowFocus) && canFocusAny(lastWindowFocus, root)) focusEl(lastWindowFocus);
    else focusDefault('editor');
  }

  // ---- live region and status --------------------------------------------------------------------------------------
  let liveTimer = null;
  // Reads `text` (a string, or a Node such as a sentence with a <bdi> name) to screen readers (it is
  // cleared, then set 50 ms later so repeats are read again).
  function announce(text) {
    cancel(liveTimer);
    live.textContent = '';
    const node = text != null && typeof text === 'object' && typeof text.nodeType === 'number' ? text : null;
    liveTimer = later(() => { if (node) setChildren(live, node); else live.textContent = String(text ?? ''); }, 50);
  }
  let statusTimer = null, statusToken = 0;
  // Transient status-bar text (chord prompts, 03 §9) for `ms` (default 3 s); returns a function that clears it.
  function status(text, { ms = 3000 } = {}) {
    const token = ++statusToken;
    cancel(statusTimer);
    statusTr.textContent = String(text ?? '');
    statusTr.hidden = !text;
    const clearIt = () => { if (token !== statusToken) return; cancel(statusTimer); statusTr.hidden = true; statusTr.textContent = ''; };
    if (Number.isFinite(ms) && ms > 0) statusTimer = later(clearIt, ms);
    return clearIt;
  }

  // ---- progress bar ------------------------------------------------------------------------------------------------
  let progTimer = null;
  // The 2 px progress bar under the toolbar: pct 0-100, null = indeterminate, false = done (03 §7).
  function progress(v) {
    cancel(progTimer);
    if (v === false || v === undefined) {
      if (prog.classList.contains('off')) return;
      if (!prog.classList.contains('ind')) progBar.style.setProperty('width', '100%');
      prog.classList.remove('ind');
      progTimer = later(() => {
        prog.classList.add('off');
        prog.setAttribute('aria-hidden', 'true');
        prog.removeAttribute('aria-valuenow');
        progBar.style.setProperty('transition', 'none');
        progBar.style.setProperty('width', '0');
        void progBar.offsetWidth;
        progBar.style.removeProperty('transition');
      }, 300);
      return;
    }
    const wasOff = prog.classList.contains('off');
    prog.classList.remove('off');
    prog.removeAttribute('aria-hidden');
    if (v === null || !Number.isFinite(v)) { prog.classList.add('ind'); prog.removeAttribute('aria-valuenow'); return; }
    prog.classList.remove('ind');
    if (wasOff) { progBar.style.setProperty('transition', 'none'); progBar.style.setProperty('width', '2%'); void progBar.offsetWidth; progBar.style.removeProperty('transition'); }
    progBar.style.setProperty('width', clampN(v, 2, 100) + '%');
    prog.setAttribute('aria-valuenow', String(Math.round(clampN(v, 0, 100))));
  }

  // ---- mini pill ---------------------------------------------------------------------------------------------------
  let pillOverride = null, busAttention = false;
  const run = { phase: null, rows: 0, sets: new Map(), ok: true, cancelled: false };
  function renderMini() {
    const attention = busAttention || dialogs.some(d => !d.shown) || (dialogs.length > 0 && vis !== 'shown');
    const v = miniView({ attention, override: pillOverride, run, standingCap: standingPill(standingList())?.cap ?? null });
    mini.className = 'mini' + (v.cls ? ' ' + v.cls : '');
    const ic = v.icon === 'spin' ? h('span', { class: 'spin', 'aria-hidden': 'true', style: 'flex:none' })
      : v.icon === 'ok' ? h('span', { class: 'ok', 'aria-hidden': 'true', style: 'flex:none' }, icon('okc', 20))
        : v.icon === 'error' ? h('span', { style: 'display:grid;flex:none;color:var(--red)', 'aria-hidden': 'true' }, icon('error', 20))
          : v.icon === 'warn' ? h('span', { style: 'display:grid;flex:none', 'aria-hidden': 'true' }, icon('warn', 20)) : null;
    // Logo and name always; the status follows and is the part that truncates (.mini>span). The spaces between the
    // flex items are whitespace-only text (not laid out; the flex gap spaces them) so the text reads as a sentence.
    const name = h('b', { class: 'nm', style: 'flex:none;font-weight:inherit' }, 'SQL Studio');
    const sub = v.sub ? h('small', { text: v.sub }) : null;
    setChildren(mini, h('span', { class: 'logo', 'aria-hidden': 'true', style: 'width:24px;height:24px;flex:none' }, icon('db', 16)), name,
      v.text ? [' ', h('span', { 'aria-hidden': 'true', style: 'flex:none;font-weight:400' }, '·'), ' ', ic, h('span', null, v.text, sub)] : sub);
    mini.setAttribute('aria-label', v.text ? `SQL Studio: ${v.text}${v.sub}` : `SQL Studio${v.sub}`);
  }
  // Overrides the pill text ({text, sub?, icon?}) until pill(null).
  function pill(info) {
    pillOverride = info && typeof info === 'object' && info.text ? { text: String(info.text), sub: info.sub ? String(info.sub) : '', icon: info.icon ?? null } : null;
    renderMini();
  }

  // ---- dialogs -----------------------------------------------------------------------------------------------------
  const dialogs = [];
  const topShownDialog = () => { for (let i = dialogs.length - 1; i >= 0; i--) if (dialogs[i].shown) return dialogs[i]; return null; };
  // Opens a dialog in the window's scrim (03 §1.4, §1.5); returns {el, close, setBusy, setDisabled}.
  function dialog(o = {}) {
    const titleId = nextId('ss-dlg-t'), bodyId = nextId('ss-dlg-b');
    const d = { o, el: null, btns: new Map(), actions: Array.isArray(o.actions) ? o.actions : [], shown: false, closed: false, busy: false, saved: null, release: null, prev: null, bodyEl: null, actionsEl: null };
    const actionsEl = h('div', { class: 'dlg-actions' });
    for (const a of d.actions) {
      const b = h('button', { class: 'btn' + (a.kind ? ' ' + a.kind : ''), type: 'button', 'data-action': String(a.id), disabled: !!a.disabled }, h('span', { class: 'lbl', text: String(a.label ?? a.id) }));
      b.addEventListener('click', e => runAction(d, a.id, e));
      d.btns.set(a.id, b);
      actionsEl.append(b);
    }
    const sub = o.sub == null ? null : h('div', { class: 'sub' }, o.sub);
    d.bodyEl = h('div', { class: 'dlg-body', id: bodyId }, o.body ?? null);
    d.actionsEl = actionsEl;
    const size = o.size === 'l' ? ' wide' : o.size === 'xl' ? ' xl' : '';
    d.el = h('dialog', { class: 'dialog' + size, 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': bodyId },
      h('div', { class: 'dlg-head' }, h('h3', { id: titleId, text: String(o.title ?? '') }), sub), d.bodyEl, actionsEl);
    // Enter in a single-line text field runs the first enabled primary action (03 §1.4); never a
    // danger action: a typed confirmation still needs its explicit click (03 §8).
    d.el.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const t = e.target;
      if (!isEl(t) || t.localName !== 'input' || !isField(t) || !d.bodyEl.contains(t)) return;
      const primary = d.actions.find(a => a.kind === 'primary' && d.btns.get(a.id) && !d.btns.get(a.id).disabled);
      const b = primary && d.btns.get(primary.id);
      if (!b || b.disabled || d.busy) return;
      e.preventDefault();
      runAction(d, primary.id, e);
    });
    dialogs.push(d);
    if (vis === 'shown') showDialog(d);
    else { if (vis === 'hidden') minimize({ focus: false }); renderMini(); }
    return {
      el: d.el,
      close: () => closeDialog(d),
      setBusy: v => setBusy(d, !!v),
      setDisabled: (id, v) => {
        const b = d.btns.get(id);
        if (!b) return;
        if (d.busy) { d.prev.set(id, !!v); return; }
        const had = !!v && active() === b;
        b.disabled = !!v;
        if (had && d.shown && vis === 'shown') focusInitial(d);
      },
    };
  }
  function setInert(on) {
    top.inert = on;
    body.inert = on || !!sheet;
    if (sheet) sheet.el.inert = on;
  }
  function showDialog(d) {
    const prevTop = topShownDialog();
    if (prevTop && prevTop !== d) { prevTop.el.hidden = true; prevTop.release?.(); prevTop.release = null; }
    // The regions behind the dialog turn inert: a query-tab drag and a pending chord there end first.
    dragEnd(false);
    cancelChord();
    closeTransient();
    d.saved = active();
    scrim.hidden = false;
    scrim.appendChild(d.el);
    d.el.hidden = false;
    d.el.show();
    d.shown = true;
    setInert(true);
    d.release = trapFocus(d.el);
    focusInitial(d);
    renderMini();
  }
  function focusInitial(d) {
    const a = d.actions.find(x => x.focus && !d.btns.get(x.id)?.disabled);
    let t = a ? d.btns.get(a.id) : null;
    t ??= d.bodyEl.querySelector('[autofocus]');
    t ??= [...d.bodyEl.querySelectorAll('input, select, textarea')].find(x => !x.disabled && String(x.type || x.getAttribute('type') || '').toLowerCase() !== 'hidden') ?? null;
    t ??= [...d.btns.values()].find(b => !b.disabled) ?? null;
    if (t) focusEl(t);
    else { d.el.setAttribute('tabindex', '-1'); focusEl(d.el); }
  }
  function setBusy(d, v) {
    if (d.closed || d.busy === v) return;
    d.busy = v;
    d.el.setAttribute('aria-busy', String(v));
    if (v) {
      // The action button that was pressed is disabled while busy: focus waits on the dialog itself (so Tab and
      // Escape stay inside the window) and returns to that button afterwards.
      const a = active();
      d.busyFocus = a && [...d.btns.values()].includes(a) ? a : null;
      d.prev = new Map();
      for (const [id, b] of d.btns) { d.prev.set(id, b.disabled); b.disabled = true; }
      const lead = d.actions.find(a => a.kind === 'primary' || a.kind === 'danger');
      const b = lead && d.btns.get(lead.id);
      if (b) b.insertBefore(h('span', { class: 'spin', 'aria-hidden': 'true' }), b.firstChild);
      if (d.busyFocus) { d.el.setAttribute('tabindex', '-1'); focusEl(d.el); }
    } else {
      for (const [id, b] of d.btns) { b.disabled = !!d.prev?.get(id); b.querySelector('.spin')?.remove(); }
      d.prev = null;
      const f = d.busyFocus;
      d.busyFocus = null;
      const a = active();
      const lost = !a && (!doc.activeElement || doc.activeElement === doc.body);
      if (f && d.shown && vis === 'shown' && (a === d.el || lost)) { if (!f.disabled) focusEl(f); else focusInitial(d); }
    }
  }
  function runAction(d, id, e) {
    if (d.closed || d.busy) return;
    const b = d.btns.get(id);
    if (b && b.disabled) return;
    if (typeof d.o.onAction !== 'function') { closeDialog(d); return; }
    let r;
    try { r = d.o.onAction(id, e ?? null); } catch (err) { fail(err); return; }
    if (r && typeof r.then === 'function') {
      setBusy(d, true);
      r.then(v => { if (d.closed) return; setBusy(d, false); if (v === true) closeDialog(d); },
        err => { if (!d.closed) setBusy(d, false); fail(err); });
      return;
    }
    if (r === true) closeDialog(d);
  }
  function cancelDialog(d) {
    if (d.busy || d.closed) return;
    if (d.btns.has('cancel')) runAction(d, 'cancel', null);
    else closeDialog(d);
  }
  // Closes a dialog. Only closing the top one brings the next one forward (its trap and focus); closing one waiting
  // behind it (a timeout, its own close()) leaves the top dialog alone.
  function closeDialog(d) {
    if (d.closed) return;
    const wasTop = topShownDialog() === d;
    d.closed = true;
    d.release?.();
    d.release = null;
    if (d.shown) { try { d.el.close(); } catch { /* not open */ } }
    d.el.remove();
    d.shown = false;
    const i = dialogs.indexOf(d);
    if (i >= 0) dialogs.splice(i, 1);
    // A dialog opened from this one returns focus to where this one would have.
    for (const x of dialogs) if (x.saved && d.el.contains(x.saved)) x.saved = d.saved;
    if (wasTop) {
      let next = topShownDialog();
      let focused = false;
      if (next) { next.el.hidden = false; next.release?.(); next.release = trapFocus(next.el); }
      else if (vis === 'shown' && dialogs.length) { next = dialogs[dialogs.length - 1]; showDialog(next); focused = true; }
      if (!dialogs.some(x => x.shown)) { scrim.hidden = true; setInert(false); }
      if (vis === 'shown' && !focused) {
        const s = d.saved;
        if (s && inRoot(s) && canFocusAny(s, root) && (!next || next.el.contains(s))) focusEl(s);
        else if (next) focusInitial(next);
        else focusDefault('editor');
      }
    }
    renderMini();
    if (typeof d.o.onClose === 'function') { try { d.o.onClose(); } catch (e) { fail(e); } }
  }
  let scrimDown = false;
  listen(scrim, 'pointerdown', e => { scrimDown = e.target === scrim; });
  listen(scrim, 'click', e => {
    const was = scrimDown;
    scrimDown = false;
    if (was && e.target === scrim) { const d = topShownDialog(); if (d) cancelDialog(d); }
  });
  // A yes/no question as a dialog; resolves true for the OK action (Escape, the scrim and Cancel give false).
  function confirm({ title, body = null, ok = 'OK', cancel: cancelLabel = 'Cancel', danger = false } = {}) {
    return new Promise(resolve => {
      let result = false;
      const node = typeof body === 'string' ? h('p', { text: body }) : body;
      dialog({
        title, body: node,
        actions: [{ id: 'ok', label: ok, kind: danger ? 'danger' : 'primary', focus: !danger }, { id: 'cancel', label: cancelLabel, focus: !!danger }],
        onAction: id => { result = id === 'ok'; return true; },
        onClose: () => resolve(result),
      });
    });
  }

  // ---- sheet -------------------------------------------------------------------------------------------------------
  let sheet = null;
  const subText = s => (Array.isArray(s) ? s.filter(x => x != null && x !== '').join(' · ') : s ?? '');
  // Opens the side sheet below the title bar (03 §1.4); returns {close, update}.
  function openSheet(o = {}) {
    if (sheet) closeSheet('replaced');
    const titleId = nextId('ss-sh');
    const h2 = h('h2', { id: titleId, tabindex: '-1' });
    const subEl = h('div', { class: 'sub' });
    const prevBtn = btn('up', null, { class: 'subtle', title: titleFor('sheetPrev', { label: 'Previous', mac }), 'aria-label': 'Previous' });
    const nextBtn = btn('down', null, { class: 'subtle', title: titleFor('sheetNext', { label: 'Next', mac }), 'aria-label': 'Next' });
    const posEl = h('span', { class: 'sh-pos' });
    const backBtn = btn('back', null, { class: 'subtle', title: 'Back (Esc)', 'aria-label': 'Back' });
    const toolsEl = h('div', { class: 'sh-tools' });
    const bodyEl = h('div', { class: 'sh-body' });
    const el = h('section', { class: 'sheet', 'aria-labelledby': titleId, 'data-scope': 'sheet' },
      h('div', { class: 'sh-head' }, backBtn, h('div', { class: 'sh-title' }, h2, subEl), prevBtn, posEl, nextBtn), toolsEl, bodyEl);
    const s = { el, h2, subEl, prevBtn, nextBtn, posEl, toolsEl, bodyEl, o: {}, saved: active(), closed: false };
    backBtn.addEventListener('click', () => closeSheetObj(s, 'back'));
    prevBtn.addEventListener('click', () => { if (typeof s.o.onPrev === 'function') callSafe(s.o.onPrev); });
    nextBtn.addEventListener('click', () => { if (typeof s.o.onNext === 'function') callSafe(s.o.onNext); });
    updateSheet(s, o);
    closeTransient();
    panel.insertBefore(el, scrim);
    sheet = s;
    body.inert = true;
    if (modalShown()) el.inert = true;
    focusEl(h2);
    return { close: () => closeSheetObj(s, 'close'), update: partial => { if (!s.closed) updateSheet(s, partial ?? {}); } };
  }
  function updateSheet(s, p) {
    const has = k => Object.hasOwn(p, k);
    for (const k of ['title', 'sub', 'tools', 'body', 'pos', 'onPrev', 'onNext', 'onClose']) if (has(k)) s.o[k] = p[k];
    if (has('title')) s.h2.textContent = String(p.title ?? '');
    if (has('sub')) setChildren(s.subEl, isEl(p.sub) ? p.sub : subText(p.sub));
    if (has('tools')) setChildren(s.toolsEl, p.tools ?? null);
    if (has('body')) setChildren(s.bodyEl, p.body ?? null);
    if (has('pos')) s.posEl.textContent = String(p.pos ?? '');
    const prev = active();
    s.prevBtn.hidden = typeof s.o.onPrev !== 'function';
    s.nextBtn.hidden = typeof s.o.onNext !== 'function';
    s.posEl.hidden = !s.o.pos;
    // At the first or last record the focused Previous / Next button goes: focus moves to the other one, else the title.
    if (prev && (prev === s.prevBtn || prev === s.nextBtn)) rescueFocus(prev, prev === s.prevBtn ? s.nextBtn : s.prevBtn, s.h2);
  }
  function closeSheetObj(s, reason) {
    if (!s || s.closed) return false;
    s.closed = true;
    const wasIn = s.el.contains(active());
    s.el.remove();
    if (sheet === s) sheet = null;
    body.inert = modalShown();
    if (wasIn || reason === 'escape' || reason === 'back') {
      if (s.saved && inRoot(s.saved) && canFocusAny(s.saved, root)) focusEl(s.saved); else focusDefault('results');
    }
    if (typeof s.o.onClose === 'function') { try { s.o.onClose(reason); } catch (e) { fail(e); } }
    return true;
  }
  const closeSheet = reason => closeSheetObj(sheet, reason);

  // ---- visibility --------------------------------------------------------------------------------------------------
  let vis = 'shown';
  let pageFocus = null, innerFocus = null;
  const rememberPageFocus = () => { const a = doc.activeElement; if (a && a !== host && a !== doc.body) pageFocus = a; };
  const saveInnerFocus = () => { const a = active(); if (a && win.contains(a)) innerFocus = a; };
  const focusInTool = () => !!active() || doc.activeElement === host;
  // The page element focused last, kept current while the window is open (03 §11: restored on close).
  listen(doc, 'focusin', e => {
    const t = e.target;
    if (vis !== 'hidden' && isEl(t) && t !== host && t !== doc.body && !host.contains(t)) pageFocus = t;
  }, true);
  // Gives focus back to the page element saved at open, only when focus is in the tool (else the user has already
  // moved on in the page and a stale element must not steal it).
  function restorePageFocus(inside) {
    const p = pageFocus;
    pageFocus = null;
    if (!inside) return;
    if (p && p.isConnected && typeof p.focus === 'function') { try { p.focus({ preventScroll: true }); } catch { /* gone */ } }
  }
  // Shows the window (from hidden or minimised), opening dialogs that waited (03 §8, §11).
  function show() {
    if (destroyed) return false;
    const was = vis;
    if (was === 'hidden') { rememberPageFocus(); host.hidden = false; }
    win.hidden = false;
    mini.hidden = true;
    vis = 'shown';
    applyGeometry();
    const waiting = dialogs.filter(d => !d.shown);
    for (const d of waiting) showDialog(d);
    if (!waiting.length && was !== 'shown') {
      if (modalShown()) focusInitial(topShownDialog());
      else if (innerFocus && inRoot(innerFocus) && canFocusAny(innerFocus, root)) focusEl(innerFocus);
      else focusDefault('editor');
    }
    renderMini();
    return true;
  }
  // Minimises the window to the pill; everything keeps running (03 §11).
  function minimize({ focus = true } = {}) {
    if (destroyed || vis === 'minimized') return;
    if (vis === 'shown') saveInnerFocus();
    dragEnd(false);
    cancelChord();
    closeTransient();
    if (vis === 'hidden') host.hidden = false;
    win.hidden = true;
    mini.hidden = false;
    vis = 'minimized';
    positionToasts();
    renderMini();
    if (focus) focusEl(mini);
  }
  function hideWindow() {
    if (vis === 'shown') saveInnerFocus();
    const inside = focusInTool();
    dragEnd(false);
    cancelChord();
    closeTransient();
    vis = 'hidden';
    host.hidden = true;
    mini.hidden = true;
    restorePageFocus(inside);
    if (typeof opts.onHide === 'function') { try { opts.onHide(); } catch (e) { fail(e); } }
  }
  // The × button: minimises while a statement runs, else hides the window (Escape never closes, 03 §11).
  function close() {
    if (destroyed) return 'hidden';
    if (st.running) { minimize(); return 'minimized'; }
    hideWindow();
    return 'hidden';
  }
  function toggle() {
    if (vis === 'shown') return close();
    show();
    return 'shown';
  }
  // Removes the window and every listener; always returns true (main.js decides whether destroy may run).
  function destroy() {
    if (destroyed) return true;
    const inside = focusInTool();
    closeTransient();
    for (const d of [...dialogs]) closeDialog(d);
    if (sheet) closeSheet('destroy');
    cancelChord();
    dragEnd(false);
    destroyed = true;
    for (const off of offs.splice(0)) { try { off(); } catch { /* already gone */ } }
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const u of busOffs.splice(0)) u();
    offSink?.();
    ss.remove();
    uninstallCss();
    restorePageFocus(inside);
    host?.remove?.();
    return true;
  }

  // ---- bus ---------------------------------------------------------------------------------------------------------
  const busOffs = [];
  // The shell's bus listeners handle their own errors (an error toast), so nothing of theirs reaches
  // state.js's listener-error reporter.
  const sub = (type, fn) => busOffs.push(S.on(type, p => { try { fn(p); } catch (e) { fail(e); } }));
  sub('tab:list', () => { renderTabs(); refreshButtons(); });
  sub('tab:changed', () => { renderTabs(); refreshButtons(); });
  sub('run:start', p => {
    run.phase = 'running'; run.rows = 0; run.sets = new Map(); run.ok = true; run.cancelled = false; run.tabId = p?.tabId ?? null;
    renderTabs(); refreshButtons(); renderTop(); renderMini();
  });
  sub('run:rows', p => {
    if (run.phase !== 'running') return;
    if (p && p.setId != null && Number.isFinite(p.count)) run.sets.set(p.setId, p.count);
    let n = 0;
    for (const v of run.sets.values()) n += v;
    run.rows = n;
    if (vis !== 'shown') renderMini();
  });
  sub('run:end', p => {
    run.phase = 'done';
    run.ok = !!p?.ok;
    run.cancelled = !!p?.cancelled;
    if (Number.isFinite(p?.rows)) run.rows = p.rows;
    renderTabs(); refreshButtons(); renderTop(); renderMini();
  });
  sub('env', () => renderTop());
  sub('changes:mode', () => renderMode());
  sub('standing', () => {
    renderMode();
    renderMini();
    if (endAnnounce && !standingShown()) { endAnnounce = false; announce(STANDING_ENDED); }
  });
  sub('impersonate', () => renderTop());
  sub('settings', p => { if (!p?.keys || p.keys.includes('theme')) applyTheme(); });
  sub('layout', () => { dropKeep(); applyLayout(); applyGeometry(); });
  sub('edits', p => {
    if (!p || p.tabId == null) return;
    let m = pendingEdits.get(p.tabId);
    if (!m) pendingEdits.set(p.tabId, m = new Map());
    if (Number.isFinite(p.pending) && p.pending > 0) m.set(p.setId ?? null, p.pending); else m.delete(p.setId ?? null);
    if (!m.size) pendingEdits.delete(p.tabId);
    renderTabs();
  });
  sub('attention', p => { busAttention = p?.kind === 'confirm'; renderMini(); });
  sub('tabs:unsaved', p => {
    if (p?.reason === 'size') toast(`This query is too large to be restored after a reload. Save it as a file (${keyLabel('save', mac)}).`, { kind: 'warn' });
  });
  sub('save:failed', p => {
    const noun = PART_NAMES.get(p?.part) ?? 'settings';
    toast(`Your browser did not allow saving your ${noun}. Everything works, but it will not be kept after a reload.`, { kind: 'warn' });
  });

  // ---- start -------------------------------------------------------------------------------------------------------
  rememberPageFocus();
  for (const [id, fn] of Object.entries(OWN)) command(id, fn);
  command('copyPowerBi', copyPowerBi);
  // Bus listener errors of every module go to the error toast from now on (state.js setListenerErrorSink; 03 §1.4).
  const offSink = typeof S.setListenerErrorSink === 'function' ? S.setListenerErrorSink(e => fail(e)) : null;
  applyTheme();
  applyLayout();
  applyGeometry();
  renderTabs();
  refresh();
  renderMini();
  started = true;
  if (typeof globalThis.ResizeObserver !== 'function') fitSoon();

  return {
    regions: { side, editor: ed, results: res, status: statusRegion, tbarEnd, topEnd },
    el: ss,
    toast,
    menu,
    contextMenu,
    popover,
    tooltip,
    dialog,
    sheet: openSheet,
    announce,
    status,
    isModalOpen: () => dialogs.length > 0,
    // = command(id, {run: fn}) (03 §1.4), also for an id the 04 §5 Edge check left out of KEYMAP: the command then has
    // no key but still runs from its button, its menu row and exec(id) (03 §9).
    shortcut: (id, fn) => {
      if (typeof fn !== 'function') throw new TypeError('shell.shortcut(): a function is required.');
      return command(id, { run: fn });
    },
    keyMatches: (e, id) => keyMatches(e, id, mac),
    command,
    exec,
    refresh,
    onEscape,
    confirm,
    progress,
    pill,
    show,
    close,
    minimize,
    toggle,
    // false once destroyed or when the page removed the host element (main.js then starts a new copy)
    alive: () => !destroyed && !!host?.isConnected,
    visibility: () => vis,
    focusPane,
    destroy,
  };
}
