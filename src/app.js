// The SQL Studio app (03 §1, §11): mounts the shell, editor, completion, dialogs, results and
// explorer on an api/meta pair and keeps one Session per query tab. main.js starts it on the Dynamics page with the
// real api.
import * as S from './ui/state.js';
import { createHost, mountShell, keyLabel, keyMatches, isMacPlatform, quoteName } from './ui/shell.js';
import { createEditor, CSS as editorCss } from './ui/editor.js';
import { createCompletion, CSS as completeCss, HINT_DOCS } from './ui/complete.js';
import { initDialogs, TEMPLATES, CSS as dialogsCss } from './ui/dialogs.js';
import { createResults, CSS as resultsCss } from './ui/results.js';
import { CSS as gridCss } from './ui/grid.js';
import { createExplorer, CSS as explorerCss } from './ui/explorer.js';
import { createSession } from './engine/session.js';
import { fetchToSql } from './engine/fetch2sql.js';
import { setCollation } from './engine/types.js';
import { toEnv } from './data/meta.js';
import { saveFile, openFile, safeFileName, setKnownTables } from './core/util.js';

const MAX_SQL_FILE = 5 * 1024 * 1024;
const WELCOME = 'SELECT TOP 50 fullname, internalemailaddress, createdon\nFROM systemuser\nORDER BY createdon DESC';

// Starts the app; returns {shell, editor, results, explorer, dialogs, destroy}.
// The app-wide change log (02 §9): every session adds its ChangeEntries; the Changes view lists them and any session
// can undo one.
function createChangeLog() {
  const list = [];
  const ls = new Set();
  return {
    entries: () => list.slice(),
    get: id => list.find(e => e.id === id) ?? null,
    add(entry) { list.push(entry); for (const cb of [...ls]) { try { cb({ entry }); } catch { /* the listener's */ } } return entry; },
    on(type, cb) { if (type !== 'change') return () => {}; ls.add(cb); return () => ls.delete(cb); },
  };
}

export function startApp({ api, writeCaps, meta, browserTz = null }) {
  const mac = isMacPlatform();
  S.initState({ host: location.hostname });
  const gate = { running: null };
  const changeLog = createChangeLog();
  S.state.changeLog = changeLog;
  const root = createHost();
  let editorRef = null, shownTab = null, dlg = null;
  const shell = mountShell(root, {
    css: [editorCss, completeCss, dialogsCss, gridCss, resultsCss, explorerCss],
    editorText: () => {
      if (!editorRef || shownTab !== S.state.activeTab) return null;
      const sel = editorRef.getSelection();
      return { text: editorRef.getValue(), start: sel.start, end: sel.end };
    },
  });
  api.onModeChange(S.mirrorMode);
  // changes are allowed from the start, without a timeout: every write still opens its preview; the mode pill
  // switches to read-only and back with one click
  writeCaps.setReadOnly(false, { idleMs: null });
  S.mirrorMode({ ...api.mode(), caller: api.caller() });
  if (!S.restoreSavedTabs().length) S.createTab({ sql: WELCOME });

  api.org().then(d => { S.state.env = toEnv(d, api.origin); S.emit('env', { env: S.state.env }); },
    () => { S.state.env = { type: null, isProduction: true, error: true }; S.emit('env', { env: S.state.env }); });
  api.whoAmI().then(async w => {
    const u = await api.get(`systemusers(${w.UserId})?$select=fullname`).catch(() => null);
    S.state.user = { id: w.UserId, name: u?.fullname || 'Signed-in user' };
    S.emit('user', { user: S.state.user });
  }, () => {});

  // ---- editor -------------------------------------------------------------------------------------------------------
  const activeTab = () => S.getTab(S.state.activeTab);
  const editor = createEditor(shell.regions.editor, {
    meta, settings: S.getSettings(), hoverTips: false,
    toast: (text, o) => shell.toast(text, o), announce: text => shell.announce(text), status: (text, o) => shell.status(text, o),
    popover: (rect, node, o) => shell.popover(rect, node, o), tooltip: (el, text) => shell.tooltip(el, text),
    shortcut: id => keyLabel(id, mac) || null, keyMatches: (e, id) => keyMatches(e, id, mac),
    onChange: sql => { if (shownTab && S.getTab(shownTab)) S.updateTab(shownTab, { sql }); },
    onCaret: ({ start, end }) => { if (shownTab && S.getTab(shownTab)) S.updateTab(shownTab, { caret: [start, end] }); },
    onFile: (file, kind) => openDropped(file, kind),
    onPasteFetchXml: () => {},
  });
  function loadTab() {
    const t = activeTab();
    if (!t || t.id === shownTab) return;
    if (shownTab && S.getTab(shownTab)) S.updateTab(shownTab, { scroll: editor.getScroll() });
    shownTab = t.id;
    editor.setValue(t.sql, { undo: false });
    editor.select(t.caret[0], t.caret[1], { reveal: false });
    editor.setScroll(t.scroll);
  }
  S.on('tab:changed', loadTab);
  S.on('tab:list', loadTab);
  S.on('settings', () => editor.applySettings(S.getSettings()));
  loadTab();
  editorRef = editor;
  async function openDropped(file, kind) {
    if (kind === 'csv') { dlg?.loadCsv?.([file]); return; }
    if (kind !== 'sql') { shell.toast(`${quoteName(file.name)} is not a .sql or .txt file.`, { kind: 'warn' }); return; }
    if (file.size > MAX_SQL_FILE) { shell.toast('This file is larger than 5 MB.', { kind: 'error' }); return; }
    S.createTab({ title: file.name.replace(/\.(sql|txt)$/i, '') || file.name, sql: await file.text() });
  }
  for (const [id, fn] of [
    ['format', () => editor.format()], ['toggleComment', () => editor.toggleComment()], ['comment', () => editor.comment()],
    ['uncomment', () => editor.uncomment()], ['find', () => editor.openFind({ replace: false })], ['replace', () => editor.openFind({ replace: true })],
    ['findNext', () => editor.findNext()], ['findPrev', () => editor.findPrev()], ['goToLine', () => editor.goToLine()],
    ['duplicateLine', () => editor.duplicateLines()], ['deleteLine', () => editor.deleteLines()], ['moveLineUp', () => editor.moveLines(-1)],
    ['moveLineDown', () => editor.moveLines(1)], ['addDisplayNames', () => editor.addDisplayNames?.()],
  ]) shell.shortcut(id, fn);
  shell.shortcut('wordWrap', () => S.setSetting('wordWrap', !S.getSettings().wordWrap));
  shell.onEscape('find', () => editor.closeFind());
  shell.shortcut('open', async () => {
    const r = await openFile({ accept: { 'text/plain': ['.sql', '.txt'] }, description: 'SQL files', maxBytes: MAX_SQL_FILE }).catch(e => { shell.toast(e.message, { kind: 'error' }); return null; });
    if (r) S.createTab({ title: r.file.name.replace(/\.(sql|txt)$/i, '') || r.file.name, sql: await r.file.text(), file: r.handle ?? null });
  });
  shell.shortcut('save', () => {
    const t = activeTab();
    if (!t) return;
    const name = `${safeFileName(t.title, 'query')}.sql`;
    saveFile(name, () => new Blob([editor.getValue()], { type: 'text/plain;charset=utf-8' }), { types: [{ description: 'SQL files', accept: { 'text/plain': ['.sql'] } }], handle: t.file ?? undefined })
      .then(r => { if (r.status === 'saved' || r.status === 'downloaded') S.updateTab(t.id, { file: r.handle ?? t.file, dirty: false }); }, e => shell.toast(`The file could not be saved: ${e.message}`, { kind: 'error' }));
  });

  // ---- sessions (one per query tab) ---------------------------------------------------------------------------------
  function syncSessions() {
    const ids = new Set(S.state.tabs.map(t => t.id));
    for (const [id, s] of [...S.state.sessions]) if (!ids.has(id)) { s.dispose?.(); S.state.sessions.delete(id); }
    for (const t of S.state.tabs) {
      if (S.state.sessions.has(t.id)) continue;
      S.state.sessions.set(t.id, createSession({
        api, meta, gate, changeLog, tabId: t.id, title: t.title, getSettings: () => S.getSettings(), browserTz,
        ui: dlg ? dlg.sessionUi(t.id) : null,
      }));
    }
  }

  // ---- completion, dialogs, results, explorer ---------------------------------------------------------------------
  const completion = createCompletion(editor, {
    meta, shell, session: () => S.state.sessions.get(S.state.activeTab) ?? null,
    settings: () => S.getSettings(), templates: () => TEMPLATES, hoverText: true,
  });
  const results = createResults(shell.regions.results, { state: S, shell, editor, meta, api, mac });
  dlg = initDialogs({ api, writeCaps, meta, state: S, shell, results, editor, hints: HINT_DOCS, mac, helpTarget: () => completion.helpTarget(), fetchToSql });
  S.on('tab:list', syncSessions);
  syncSessions();
  const explorer = createExplorer(shell.regions.side, { meta, state: S, shell, editor, results });

  meta.init().then(() => {
    if (meta.org?.lcid != null) setCollation(meta.org.lcid);
    setKnownTables(name => !!meta.findEntity(name));
    S.emit('meta:loaded', {});
  }, e => shell.toast(`Metadata did not load: ${e.message}`, { kind: 'error' }));

  editor.focus();
  const destroy = () => {
    if (S.state.running?.write || dlg?.confirming?.()) return false;
    dlg?.destroy?.();
    return shell.destroy();
  };
  return { shell, editor, completion, results, explorer, dialogs: dlg, state: S, destroy };
}
