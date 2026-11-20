// Session / script interpreter (02 §9). One Session per query tab runs scripts:
// batches split by GO (GO n repeats a batch), each compiled to a flat instruction list in which IF, WHILE, BREAK,
// CONTINUE, TRY/CATCH, RETURN and GOTO are jumps, every statement planned right before each execution through
// planner.js and run by exec.js. It keeps the tab's variables, table variables, #temp tables, cursors, SET options,
// @@ROWCOUNT, @@IDENTITY and @@ERROR; runs dynamic SQL (sp_executesql, EXEC (string)), EXEC of Web API messages,
// EXECUTE AS / REVERT, RAISERROR, THROW, PRINT and WAITFOR; INSERT, UPDATE and DELETE on #temp tables and table
// variables in memory and on Dataverse tables through dml.js (preview, confirmation, grant, write, change log,
// undo); and Load CSV / Load file as #temp through csv.js.
//
// Notes:
// - createSession({api, meta, ui, changeLog, gate, tabId, title, getSettings, browserTz, user?, org?, wait?}) -> Session
//   (02 §9). `user` ({id, name, domainName}) and `org` (the 02 §2 env) are read from the api when not given; `wait(ms,
//   signal)` replaces WAITFOR's timer.
// - RunHandle events and their order are 02 §9's. A statement executed several times (a loop) emits `statement`
//   with the same index each time; statements inside dynamic SQL keep the index of the EXEC that runs them.
// - TRY/CATCH never catches AbortError, a declined confirmation (`cancelled`), `Blocked:` refusals (code 'blocked')
//   or session-expired errors (code 'auth'): they end the whole run (02 §9 Errors).
// - SELECT @v = … whose expressions read a variable the same SELECT assigns (`SELECT @s = @s + name FROM t`) is
//   evaluated row by row in output order: the parts that read no assigned variable run as one query, the rest per
//   row over its result (outerScope); otherwise the last row's values are assigned (02 §9 Variables).
// - #temp and @table DML select the target rows through the planner with a hidden row-number column added to a
//   shadow copy of the table, so every SQL feature works in FROM/WHERE/SET; the table is changed only after the
//   statement's selection and conversions succeeded.
import { parse, parseParams, statementRanges } from './parser.js';
import { planQuery } from './planner.js';
import { explainPlan, explainNode, collect } from './exec.js';
import { castValue, dtOf } from './types.js';
import { formatMessage } from './functions.js';
import { msg } from './messages.js';
import { SqlError } from './lexer.js';
import { guidParam, enumParam } from '../data/api.js';
import { previewEdits, writeEdits, editsEntry, prepareDml, prepareExec, prepareUndo, dmlTarget } from './dml.js';
import { previewCsvFiles, convertCsv, loadFileRows, CSV_NAME_RE, CSV_NAME_MESSAGE } from './csv.js';

const UTC_TZ = Object.freeze({ utc: true, offset: () => 0 });
const LOCAL_TZ = Object.freeze({ utc: false, offset: ms => -new Date(ms).getTimezoneOffset() });
const MAX_LOOP = 100000;
const MAX_LOOP_MS = 10 * 60 * 1000;
const MAX_NEST = 32;
const ROWID = '__sqlstudio_rowid';
const VIA_ROW = '__sqlstudio_target_row';
const CANCELLED_TEXT = 'Update cancelled. No records were changed. The rest of the script was not run.';
const READONLY_TEXT = 'SQL Studio is read-only. Select the Read-only pill in the top bar to allow INSERT, UPDATE, DELETE and EXEC again.';
const NVARCHAR_MAX = Object.freeze({ name: 'nvarchar', args: ['max'] });
const STRINGISH = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary']);

const lower = s => String(s ?? '').toLowerCase();
const isObj = x => !!x && typeof x === 'object';
const int = n => Number(n).toLocaleString('en-US');
const abortError = () => Object.assign(new Error('Query cancelled.'), { name: 'AbortError' });
const lineOf = (text, pos) => (pos == null || typeof text !== 'string' ? null : text.slice(0, pos).split(/\r\n|\n|\r/).length);
const rowsText = n => `(${int(n)} row${n === 1 ? '' : 's'} affected)`;
const uuid = () => globalThis.crypto.randomUUID();
const lastPart = name => (name && Array.isArray(name.parts) ? name.parts[name.parts.length - 1] : String(name ?? ''));

// A numbered SqlError with the messages.js text.
function E(number, ...args) {
  const m = msg(number, ...args);
  const e = new SqlError(m.message);
  e.number = m.number;
  e.severity = m.severity;
  e.state = 1;
  return e;
}

// A SQL Studio error without a SQL Server number (severity 16, state 1).
function plain(text, extra = {}) {
  const e = new SqlError(text);
  e.severity = 16;
  e.state = 1;
  return Object.assign(e, extra);
}

// Errors that end the whole run and that TRY/CATCH never catches (02 §9 Errors).
const fatal = e => !!e && (e.name === 'AbortError' || e.cancelled === true || e.code === 'blocked' || e.code === 'auth' || e.fatal === true);

// ---- small AST builders --------------------------------------------------------------------------------------------
const colRef = (...parts) => ({ type: 'col', parts });
const litOf = v => (v == null ? { type: 'lit', v: null, dt: 'null' }
  : typeof v === 'number' ? { type: 'lit', v, dt: Number.isInteger(v) ? 'int' : 'float', raw: String(v) }
    : { type: 'lit', v: String(v), dt: 'string', unicode: true });
const itemOf = (expr, alias = null) => ({ expr, alias });
function queryOf({ cols, from = null, where = null, top = null, distinct = false, orderBy = null, withs = null }) {
  return {
    type: 'query', with: withs, xmlns: null, orderBy, offset: null, fetch: null,
    body: { type: 'core', distinct, top, cols, into: null, from, where, groupBy: null, having: null },
  };
}
const tableSrc = (name, alias = null) => ({ type: 'table', name: typeof name === 'string' ? { parts: [name] } : name, alias, hints: null });

// The expression children of an AST node mapped by f (subquery bodies are left alone).
function mapExpr(x, f) {
  if (!isObj(x)) return x;
  switch (x.type) {
    case 'bin': case 'distinctfrom': return { ...x, l: f(x.l), r: f(x.r) };
    case 'neg': case 'not': case 'paren': case 'isnull': case 'collate': return { ...x, e: f(x.e) };
    case 'between': return { ...x, e: f(x.e), lo: f(x.lo), hi: f(x.hi) };
    case 'in': return x.list ? { ...x, e: f(x.e), list: x.list.map(f) } : { ...x, e: f(x.e) };
    case 'like': return { ...x, e: f(x.e), pattern: f(x.pattern), escape: x.escape ? f(x.escape) : x.escape };
    case 'quantified': return { ...x, l: f(x.l) };
    case 'case': return { ...x, operand: x.operand ? f(x.operand) : x.operand, whens: (x.whens || []).map(([w, t]) => [f(w), f(t)]), else: x.else ? f(x.else) : x.else };
    case 'cast': return { ...x, e: f(x.e) };
    case 'fn': return x.over || x.withinGroup ? x : { ...x, args: (x.args || []).map(f) };
    case 'xmlmethod': return { ...x, e: f(x.e), args: (x.args || []).map(f) };
    default: return x;
  }
}

// Whether any node of x (subqueries included) satisfies p.
function anyNode(x, p) {
  if (Array.isArray(x)) return x.some(v => anyNode(v, p));
  if (!isObj(x)) return false;
  if (p(x)) return true;
  for (const [k, v] of Object.entries(x)) if (k !== 'pos' && k !== 'end' && isObj(v) && anyNode(v, p)) return true;
  return false;
}

// The table sources of a FROM tree, left to right.
function sourcesOf(ts, out = []) {
  if (!isObj(ts)) return out;
  if (ts.type === 'join') { sourcesOf(ts.left, out); sourcesOf(ts.right, out); } else out.push(ts);
  return out;
}

// The status line of a written grid change set: 'Updated 2 records in account', 'Deleted 1 record from userquery',
// 'Saved 3 changes to account (1 updated, 2 created)'.
function editsSummary(preview, writes) {
  const n = { update: 0, delete: 0, create: 0 };
  writes.forEach((w, i) => { if (w.status === 'ok') { const k = preview.ops[i]?.op; if (k in n) n[k]++; } });
  const table = preview.entity?.logicalName ?? 'the table';
  const rec = k => `${int(k)} record${k === 1 ? '' : 's'}`;
  const kinds = Object.entries(n).filter(([, k]) => k > 0);
  if (kinds.length === 1) {
    const [k, c] = kinds[0];
    return k === 'update' ? `Updated ${rec(c)} in ${table}` : k === 'delete' ? `Deleted ${rec(c)} from ${table}` : `Created ${rec(c)} in ${table}`;
  }
  const total = n.update + n.delete + n.create;
  const parts = [n.update ? `${int(n.update)} updated` : '', n.create ? `${int(n.create)} created` : '', n.delete ? `${int(n.delete)} deleted` : ''].filter(Boolean);
  return `Saved ${int(total)} change${total === 1 ? '' : 's'} to ${table}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

// A Session for one query tab (02 §9).
export function createSession(o = {}) {
  const { api, meta } = o;
  const gate = o.gate ?? { running: null };
  const ui = o.ui ?? null;
  const changeLog = o.changeLog ?? null;
  const getSettings = typeof o.getSettings === 'function' ? o.getSettings : () => ({});
  const listeners = new Map();
  const startQi = getSettings()?.quotedIdentifiers !== false;
  const session = {
    tabId: o.tabId ?? null, title: o.title ?? null,
    temps: new Map(), vars: new Map(), cursors: new Map(), fetchStatus: -1, cursorRows: 0,
    identity: { value: null, ref: null }, rowcount: 0, error: 0, settings: null,
    opts: { dateformat: 'mdy', datefirst: 7, nocount: false, language: 'us_english', quotedIdentifier: startQi },
    run, explain, on, executeAs, revert, dispose, undo, runEdits, previewCsv, loadCsv, loadFile,
  };
  let orgEnv = o.org ?? null, user = o.user ?? null, lastOpened = null;

  function on(type, cb) {
    let s = listeners.get(type);
    if (!s) listeners.set(type, s = new Set());
    s.add(cb);
    return () => s.delete(cb);
  }
  function dispose() { listeners.clear(); }
  function emitSession(type, payload) {
    for (const cb of [...(listeners.get(type) ?? [])]) { try { cb(payload); } catch (e) { queueMicrotask(() => { throw e; }); } }
  }
  const emitTemps = () => emitSession('temps', { names: [...session.temps.values()].map(t => t.name) });

  // The settings snapshot of a statement (02 §9: read at the start of every statement).
  function settingsNow(maxRows) {
    const s = {
      maxRows: 50000, maxScanRows: 500000, maxRequests: 500, maxChangeRows: 5000, batchSize: 50, maxdop: 0, allowUnfiltered: false,
      backupBeforeDelete: false, queryInBody: false, tz: 'local', ...getSettings(),
    };
    if (Number.isFinite(maxRows)) s.maxRows = maxRows;
    session.settings = s;
    return s;
  }
  const tzOf = s => (s.tz === 'utc' ? UTC_TZ : isObj(s.tz) ? s.tz : (o.browserTz ?? LOCAL_TZ));

  async function context() {
    if (!orgEnv) {
      try { orgEnv = meta.toEnv ? meta.toEnv(await api.org()) : null; } catch { orgEnv = null; }
    }
    if (!user) {
      try {
        const w = await api.whoAmI();
        user = { id: w.UserId, name: null, domainName: null };
      } catch { user = { id: null, name: null, domainName: null }; }
    }
  }
  const rtOrg = () => ({
    uniqueName: orgEnv?.uniqueName ?? null, friendlyName: orgEnv?.name ?? null,
    host: api.origin ? new URL(api.origin).host : null, version: orgEnv?.version ?? null, lcid: meta.org?.lcid ?? 1033,
  });

  // ---- run handles ----------------------------------------------------------------------------------------------------
  function handleOf() {
    const ls = new Map();
    let resolve;
    const done = new Promise(r => { resolve = r; });
    const emit = (type, p) => { for (const cb of [...(ls.get(type) ?? [])]) { try { cb(p); } catch (e) { queueMicrotask(() => { throw e; }); } } };
    const handle = { on(type, cb) { let s = ls.get(type); if (!s) ls.set(type, s = new Set()); s.add(cb); return () => s.delete(cb); }, done };
    return { handle, emit, resolve };
  }

  // A run under the gate (one run app-wide, 02 §9): body(R) runs after the current macrotask; every run ends with
  // ui.runEnded(runId) and then `done`.
  function startRun(body, { signal = null, text = '', offset = 0, fullText = null, maxRows } = {}) {
    const { handle, emit, resolve } = handleOf();
    if (gate.running && gate.running !== session) {
      const busy = gate.running.title ?? '';
      setTimeout(() => {
        const e = new Error(`A query is already running in “${busy}”.`);
        emit('message', { kind: 'error', text: e.message, pos: null, end: null, line: null, index: null, setId: null });
        const d = { ok: false, error: e, ms: 0, rows: 0, cancelled: false };
        emit('done', d);
        resolve(d);
      }, 0);
      return handle;
    }
    gate.running = session;
    const t0 = performance.now();
    const R = {
      emit, signal, runId: uuid(), setN: 0, rows: 0, index: 0, total: 0, text, offset, base: fullText ?? text, fullText, maxRows,
      executions: new Map(), summary: null, qiChanged: false,
    };
    setTimeout(async () => {
      let d;
      try {
        await context();
        await body(R);
        d = { ok: true, error: null, ms: Math.round(performance.now() - t0), rows: R.rows, cancelled: false };
        if (typeof R.summary === 'string') d.summary = R.summary;
      } catch (e) {
        const aborted = e?.name === 'AbortError' || !!signal?.aborted;
        const cancelled = aborted || e?.cancelled === true;
        if (aborted) emit('message', { kind: 'info', text: 'Query cancelled.', pos: null, end: null, line: null, index: R.index, setId: null });
        else if (e?.cancelled) emit('message', { kind: 'info', text: e.message, pos: null, end: null, line: null, index: R.index, setId: null });
        else if (!e?.reported) emit('message', { kind: 'error', text: e?.message ?? String(e), pos: null, end: null, line: null, index: R.index, setId: null, code: e?.code ?? null, number: e?.number });
        d = { ok: false, error: aborted ? abortError() : e, ms: Math.round(performance.now() - t0), rows: R.rows, cancelled };
      } finally {
        if (gate.running === session) gate.running = null;
      }
      try { ui?.runEnded?.(R.runId); } catch { /* the UI's */ }
      emit('done', d);
      resolve(d);
    }, 0);
    return handle;
  }

  // ---- run(sql) --------------------------------------------------------------------------------------------------------
  function run(sql, { signal = null, offset = 0, fullText = null, maxRows } = {}) {
    const text = String(sql ?? '');
    return startRun(R => runScript(R), { signal, text, offset, fullText, maxRows });
  }

  // Numbers every statement of a script in source order (statement.index) and returns the count.
  function numberStatements(stmts) {
    let n = 0;
    const walk = s => {
      if (!isObj(s)) return;
      if (s.type === 'go' || s.type === 'label') return;
      if (s.type === 'block') { for (const x of s.body) walk(x); return; }
      if (s.type === 'try') { for (const x of s.body) walk(x); for (const x of s.catch) walk(x); return; }
      Object.defineProperty(s, '__i', { value: n++, configurable: true, writable: true });
      if (s.type === 'if') { walk(s.then); walk(s.else); }
      if (s.type === 'while') walk(s.body);
    };
    for (const s of stmts) walk(s);
    return n;
  }

  // The batches of a parsed script: [{stmts, count, start}] (a `go` node ends a batch).
  function splitBatches(stmts) {
    const out = [];
    let cur = [];
    for (const s of stmts) {
      if (s.type === 'go') { out.push({ stmts: cur, count: s.count ?? 1, start: cur[0]?.pos ?? s.pos, goEnd: s.end }); cur = []; continue; }
      cur.push(s);
    }
    if (cur.length) out.push({ stmts: cur, count: 1, start: cur[0].pos, goEnd: null });
    return out;
  }

  async function runScript(R) {
    let stmts;
    try {
      stmts = parse(R.text, { quotedIdentifier: session.opts.quotedIdentifier });
    } catch (e) {
      reportError(R, e, null, { dynamic: false, shift: 0, text: R.text });
      e.reported = true;
      throw e;
    }
    for (const w of stmts.warnings ?? []) R.emit('message', { kind: 'warn', text: w.text ?? String(w), ...posOf(R, { shift: 0 }, w.pos), index: 0, setId: null });
    let batches = splitBatches(stmts);
    let failed = null;
    R.total = numberStatements(stmts);
    for (let b = 0; b < batches.length; b++) {
      let shift = 0;
      if (R.qiChanged && b > 0) {
        // SET QUOTED_IDENTIFIER takes effect from the next batch: the rest of the script is read again
        R.qiChanged = false;
        const from = batches[b].start;
        let rest;
        try {
          rest = parse(R.text.slice(from), { quotedIdentifier: session.opts.quotedIdentifier });
        } catch (e) {
          reportError(R, e, null, { dynamic: false, shift: from, text: R.text });
          e.reported = true;
          throw e;
        }
        const more = splitBatches(rest);
        numberStatements(rest);
        batches = batches.slice(0, b).concat(more);
        shift = from;
        for (let k = b; k < batches.length; k++) batches[k].shift = from;
      } else shift = batches[b].shift ?? 0;
      const batch = batches[b];
      for (let n = 0; n < batch.count; n++) {
        const scope = { vars: new Map(), localCursors: new Map(), text: R.text, shift, dynamic: false, depth: 0, catchError: null };
        session.vars = scope.vars;
        try {
          await runStatements(batch.stmts, scope, R);
        } catch (e) {
          // a runtime error stops its batch; the next batch still runs, as in SSMS (02 §9 Errors)
          if (fatal(e) || R.signal?.aborted) throw e;
          failed ??= e;
        } finally {
          scope.localCursors.clear();
        }
      }
    }
    if (failed) throw failed;
  }

  // Absolute editor position fields of a source position (none inside dynamic SQL).
  function posOf(R, scope, pos, end) {
    if (pos == null || scope.dynamic) return { pos: null, end: null, line: null };
    const p = R.offset + (scope.shift || 0) + pos;
    return { pos: p, end: end != null ? R.offset + (scope.shift || 0) + end : null, line: lineOf(R.base, p) };
  }

  function reportError(R, e, stmt, scope) {
    const p = posOf(R, scope, e?.pos ?? stmt?.pos ?? null, e?.end ?? (e?.pos == null ? stmt?.end : null) ?? null);
    if (isObj(e) && e.line == null && p.line != null) { try { e.line = p.line; } catch { /* frozen */ } }
    R.emit('message', {
      kind: 'error', text: e?.message ?? String(e), ...p, index: R.index, setId: null, number: e?.number, code: e?.code ?? null,
      fix: e?.fix, errors: Array.isArray(e?.errors) ? e.errors : undefined,
    });
  }

  // ---- control flow: the flattened instruction list (02 §9) -------------------------------------------------------------
  function compileBatch(stmts) {
    const code = [], labels = new Map(), gotos = [], loops = [];
    const add = ins => { code.push(ins); return ins; };
    const comp = s => {
      if (!isObj(s)) return;
      switch (s.type) {
        case 'block': for (const x of s.body) comp(x); return;
        case 'if': {
          const jf = add({ op: 'if', stmt: s, cond: s.cond, target: -1 });
          comp(s.then);
          if (s.else) {
            const j = add({ op: 'jmp', target: -1 });
            jf.target = code.length;
            comp(s.else);
            j.target = code.length;
          } else jf.target = code.length;
          return;
        }
        case 'while': {
          const start = code.length;
          const jf = add({ op: 'while', stmt: s, cond: s.cond, target: -1 });
          const loop = { start, breaks: [] };
          loops.push(loop);
          comp(s.body);
          loops.pop();
          add({ op: 'jmp', target: start });
          jf.target = code.length;
          for (const b of loop.breaks) b.target = code.length;
          return;
        }
        case 'break': {
          const j = add({ op: 'jmp', target: -1 });
          if (loops.length) loops[loops.length - 1].breaks.push(j);
          return;
        }
        case 'continue': add({ op: 'jmp', target: loops.length ? loops[loops.length - 1].start : -1 }); return;
        case 'try': {
          const t = add({ op: 'try', stmt: s, from: -1, to: -1, catchAt: -1, catchEnd: -1 });
          t.from = code.length;
          for (const x of s.body) comp(x);
          const j = add({ op: 'jmp', target: -1 });
          t.to = code.length;
          t.catchAt = code.length;
          for (const x of s.catch) comp(x);
          t.catchEnd = code.length;
          j.target = code.length;
          return;
        }
        case 'label': labels.set(lower(s.name), code.length); return;
        case 'goto': gotos.push(add({ op: 'goto', stmt: s, label: lower(s.label), target: -1 })); return;
        case 'return': add({ op: 'return', stmt: s }); return;
        default: add({ op: 'stmt', stmt: s });
      }
    };
    for (const s of stmts) comp(s);
    for (const g of gotos) g.target = labels.has(g.label) ? labels.get(g.label) : -1;
    return code;
  }

  // Runs a batch's statements; resolves 'return' after RETURN.
  async function runStatements(stmts, scope, R) {
    const code = compileBatch(stmts);
    const frames = [];
    let pc = 0, loops = 0;
    const t0 = Date.now();
    while (pc >= 0 && pc < code.length) {
      if (R.signal?.aborted) throw abortError();
      // a jump out of a TRY or CATCH block ends it (02 §9 GOTO)
      while (frames.length) {
        const f = frames[frames.length - 1];
        if (pc >= f.from && pc < f.to) break;
        frames.pop();
      }
      scope.catchError = null;
      for (let k = frames.length - 1; k >= 0; k--) if (frames[k].kind === 'catch') { scope.catchError = frames[k].error; break; }
      const ins = code[pc];
      try {
        switch (ins.op) {
          case 'stmt': await execStatement(ins.stmt, scope, R); pc++; break;
          case 'if': case 'while': pc = (await condition(ins.stmt, ins.cond, scope, R)) ? pc + 1 : ins.target; break;
          case 'jmp': case 'goto': {
            if (ins.target < 0) throw plain('Internal error: a jump has no target.');
            if (ins.target <= pc) {
              loops++;
              if (loops > MAX_LOOP || Date.now() - t0 > MAX_LOOP_MS) {
                throw plain(`The loop was stopped after ${loops > MAX_LOOP ? `${int(MAX_LOOP)} iterations` : '10 minutes'}. Check its exit condition.`);
              }
              await tick(R);
            }
            pc = ins.target;
            break;
          }
          case 'try': frames.push({ kind: 'try', from: ins.from, to: ins.to, catchAt: ins.catchAt, catchEnd: ins.catchEnd }); pc++; break;
          case 'return': return 'return';
          default: pc++;
        }
      } catch (e) {
        if (fatal(e) || R.signal?.aborted) throw R.signal?.aborted ? abortError() : e;
        session.error = errNumber(e);
        let k = frames.length - 1;
        while (k >= 0 && frames[k].kind !== 'try') k--;
        if (k < 0) {
          if (!e.reported) { reportError(R, e, ins.stmt, scope); e.reported = true; }
          throw e;
        }
        const f = frames[k];
        frames.length = k;
        frames.push({ kind: 'catch', from: f.catchAt, to: f.catchEnd, error: errorInfo(e, ins.stmt, scope) });
        pc = f.catchAt;
      }
    }
    return null;
  }

  // Lets the page breathe inside tight loops.
  async function tick(R) {
    R.ticks = (R.ticks || 0) + 1;
    if (R.ticks % 200 === 0) await new Promise(r => setTimeout(r, 0));
  }

  const errNumber = e => (Number.isInteger(e?.number) ? e.number : 50000);
  function errorInfo(e, stmt, scope) {
    return {
      number: errNumber(e), message: String(e?.message ?? e), severity: Number.isInteger(e?.severity) ? e.severity : 16,
      state: Number.isInteger(e?.state) ? e.state : 1, procedure: null,
      line: lineOf(scope.text, (e?.pos ?? stmt?.pos) != null ? (e?.pos ?? stmt.pos) + (scope.shift || 0) : null) ?? 1,
      pos: e?.pos ?? stmt?.pos ?? null, end: e?.pos != null ? e?.end ?? null : stmt?.end ?? null,
    };
  }

  // ---- statement context, env and planning --------------------------------------------------------------------------------
  function stmtCtx(stmt, scope, R) {
    const settings = settingsNow(R.maxRows);
    const warnings = [];
    const seen = new Set();
    const warn = (t, kind) => {
      const k = `${kind ?? ''}|${t}`;
      if (seen.has(k)) return;
      seen.add(k);
      warnings.push({ text: String(t), kind: kind ?? null });
    };
    const info = t => R.emit('message', { kind: 'info', text: String(t), pos: null, end: null, line: null, index: R.index, setId: null });
    return { stmt, scope, R, settings, warnings, warn, info, tz: tzOf(settings), setIds: [] };
  }

  function envOf(S, extra = {}) {
    return {
      vars: S.scope.vars, outer: [], now: new Date(), tz: S.tz, dateformat: session.opts.dateformat, datefirst: session.opts.datefirst,
      language: session.opts.language, nocount: session.opts.nocount, user, session, signal: S.R.signal, subq: new Map(),
      error: S.scope.catchError ?? null, rowcount: session.rowcount, identity: session.identity, lastError: session.error,
      org: rtOrg(), settings: S.settings, warn: S.warn, info: S.info, api, meta, literals: { guidParam, enumParam }, ...extra,
    };
  }
  function ctxOf(S, env, extra = {}) {
    return {
      meta, api, settings: S.settings, org: orgEnv, rt: env, session: env.session, temps: env.session?.temps ?? session.temps, ctes: new Map(),
      hints: S.stmt?.hints ?? null, noPushdown: !!S.settings.noPushdown, explainOnly: false, outerScope: null, source: S.scope.text, warn: S.warn,
      ...extra,
    };
  }
  async function plan(S, query, { env: envExtra = {}, ctx: ctxExtra = {} } = {}) {
    const env = envOf(S, envExtra);
    const node = await planQuery(query, ctxOf(S, env, ctxExtra));
    return { node, env };
  }

  // Evaluates one expression (no FROM): {value, type, row, env}.
  async function scalar(S, expr) {
    const { node, env } = await plan(S, queryOf({ cols: [itemOf(expr)] }));
    const rows = await collect(node, env, 1);
    const row = rows[0] ?? [null];
    return { value: row[0] ?? null, type: node.schema[0] ?? { dt: 'any' }, row, env, node };
  }

  // An IF or WHILE condition (compiled like a WHERE predicate, 01 §7).
  async function condition(stmt, cond, scope, R) {
    const S = stmtCtx(stmt, scope, R);
    try {
      const { value } = await scalar(S, { type: 'case', operand: null, whens: [[cond, litOf(1)]], else: litOf(0) });
      return value === 1;
    } finally { flushWarnings(S); }
  }

  function flushWarnings(S, setId = null) {
    for (const w of S.warnings) S.R.emit('message', { kind: 'warn', text: w.text, pos: null, end: null, line: null, index: S.R.index, setId, code: w.kind === 'limit' ? 'LIMIT' : null });
    S.warnings.length = 0;
  }

  // The static lineage {entity, pid?} of a uniqueidentifier value from its column (01 §6.2), or null.
  function refOf(type, row, env) {
    const r = type?.ref;
    if (!r) return null;
    try {
      if (r.entity) return { entity: lower(r.entity) };
      if (r.poly && type.companion && Number.isInteger(type.companion.type) && row) { const t = row[type.companion.type]; return t ? { entity: lower(t) } : null; }
      if (typeof r.entityFn === 'function') { const t = r.entityFn(row ?? [], env); return t ? { entity: lower(t), pid: r.pidFn?.(row ?? [], env) ?? null } : null; }
    } catch { /* no lineage */ }
    return null;
  }

  // Stores a value in a declared scalar variable, converted to its declared type (02 §9 Variables).
  function assignVar(S, name, value, type, row = null, env = null) {
    const key = lower(name);
    const e = S.scope.vars.get(key);
    if (!e || e.table) throw E(137, name);
    let v = value;
    if (v != null && e.dataType) {
      v = castValue(v, type ?? { dt: 'any' }, e.dataType, { tz: S.tz, dateformat: session.opts.dateformat, defLen: 1 });
      if (typeof value === 'string' && typeof v === 'string' && v.length < value.length) S.warn(`Value truncated to ${int(v.length)} characters when assigned to ${e.name ?? name}.`);
    }
    e.value = v;
    e.ref = v == null ? null : refOf(type, row, env);
  }

  // The text of a value as PRINT and string conversion show it.
  function textOf(S, value, type) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try { return String(castValue(value, type ?? { dt: 'any' }, NVARCHAR_MAX, { tz: S.tz, dateformat: session.opts.dateformat })); } catch { return String(value); }
  }

  // ---- statements -------------------------------------------------------------------------------------------------------
  async function execStatement(stmt, scope, R) {
    if (!scope.dynamic) {
      R.index = Number.isInteger(stmt.__i) ? stmt.__i : R.index;
      const p = posOf(R, scope, stmt.pos, stmt.end);
      R.emit('statement', { index: R.index, total: R.total, pos: p.pos, end: p.end });
    }
    const S = stmtCtx(stmt, scope, R);
    try {
      await runOne(S);
      session.error = 0;
    } finally {
      flushWarnings(S);
    }
  }

  async function runOne(S) {
    const stmt = S.stmt;
    switch (stmt.type) {
      case 'select': return runSelect(S);
      case 'print': {
        const r = await scalar(S, stmt.expr);
        S.R.emit('message', { kind: 'print', text: textOf(S, r.value, r.type), pos: null, end: null, line: null, index: S.R.index, setId: null });
        session.rowcount = 0;
        return;
      }
      case 'declare': return runDeclare(S);
      case 'setvar': {
        const expr = stmt.op && stmt.op !== '=' ? { type: 'bin', op: stmt.op.slice(0, -1), l: { type: 'var', name: lower(stmt.name) }, r: stmt.expr } : stmt.expr;
        const r = await scalar(S, expr);
        assignVar(S, stmt.name, r.value, r.type, r.row, r.env);
        session.rowcount = 1;
        return;
      }
      case 'setopt': return runSetOpt(S);
      case 'noop': return;
      case 'raiserror': return runRaiserror(S);
      case 'throw': return runThrow(S);
      case 'waitfor': return runWaitfor(S);
      case 'create': return runCreate(S);
      case 'drop': return runDrop(S);
      case 'insert': case 'update': case 'delete': return runDml(S);
      case 'exec': return runExec(S);
      case 'execsql': return runDynamic(S);
      case 'executeas': return runExecuteAs(S);
      case 'revert': await revert(); session.rowcount = 0; return;
      case 'declarecursor': case 'open': case 'fetch': case 'close': case 'deallocate': return runCursor(S);
      default: throw plain(`This statement (${String(stmt.type).toUpperCase()}) is not supported.`);
    }
  }

  // ---- SELECT ----------------------------------------------------------------------------------------------------------------
  async function runSelect(S) {
    const { stmt, R, settings } = S;
    const q = stmt.query;
    const core = q?.body?.type === 'core' ? q.body : null;
    if (core?.cols?.some(c => c.assign)) return selectAssign(S, core);
    const t0 = performance.now();
    const { node, env } = await plan(S, q);
    const index = R.index;
    if (node.op === 'Into') {
      await collect(node, env);
      emitPlan(S, node);
      const n = Number.isInteger(node.rowcount) ? node.rowcount : 0;
      session.rowcount = n;
      emitTemps();
      if (!session.opts.nocount) R.emit('message', { kind: 'rows', text: rowsText(n), pos: null, end: null, line: null, index, setId: null, rows: n, ms: Math.round(performance.now() - t0) });
      return;
    }
    const schema = node.schema ?? [];
    const id = `r${R.setN++}`;
    const title = schema.find(c => c.attr)?.attr?.entity ?? null;
    R.emit('resultset', { id, index, title, columns: schema, source: sourceOf(schema) });
    let count = 0, truncated = false, incomplete = null;
    try {
      for await (const batch of node.run(env)) {
        if (R.signal?.aborted) throw abortError();
        if (!batch.length) continue;
        let rows = batch;
        if (count + rows.length > settings.maxRows) { rows = rows.slice(0, settings.maxRows - count); truncated = true; }
        count += rows.length;
        if (rows.length) R.emit('rows', { id, rows });
        if (truncated) break;
      }
    } catch (e) {
      incomplete = e?.name === 'AbortError' || R.signal?.aborted ? 'cancelled' : 'error';
      R.emit('resultdone', { id, count, truncated, ms: Math.round(performance.now() - t0), incomplete, warnings: S.warnings.slice() });
      throw e;
    }
    const ms = Math.round(performance.now() - t0);
    if (truncated) S.warn(`Showing the first ${int(settings.maxRows)} rows (Settings › Max rows returned).`, 'limit');
    R.emit('resultdone', { id, count, truncated, ms, incomplete, warnings: S.warnings.slice() });
    flushWarnings(S, id);
    session.rowcount = count;
    R.rows += count;
    emitPlan(S, node);
    if (!session.opts.nocount) R.emit('message', { kind: 'rows', text: rowsText(count), pos: null, end: null, line: null, index, setId: id, rows: count, ms });
  }

  function emitPlan(S, node) {
    try {
      const ex = explainPlan(node);
      S.R.emit('plan', { index: S.R.index, plan: ex.plan, fetchXml: ex.fetchXml ?? [] });
    } catch { /* a node without explain() */ }
  }

  // The result source of 02 §9 from a plan schema (hidden pk/etag columns per table alias).
  function sourceOf(schema) {
    const byQual = new Map();
    schema.forEach((c, i) => {
      if (!c.hidden || !c.attr || (c.role !== 'pk' && c.role !== 'etag')) return;
      const k = c.qual ?? '';
      const t = byQual.get(k) ?? { qual: c.qual ?? null, entity: c.attr.entity, pkIndex: null, etagIndex: null };
      if (c.role === 'pk') t.pkIndex = i; else t.etagIndex = i;
      byQual.set(k, t);
    });
    const tables = [...byQual.values()].filter(t => t.pkIndex != null);
    return { tables, editable: tables.length === 1 };
  }

  // Emits a complete result set (OUTPUT, EXEC, FETCH): rows in batches of 2,000.
  function emitSet(S, { title = null, columns, rows, warnings = [] }) {
    const R = S.R;
    const id = `r${R.setN++}`;
    R.emit('resultset', { id, index: R.index, title, columns, source: null });
    for (let i = 0; i < rows.length; i += 2000) R.emit('rows', { id, rows: rows.slice(i, i + 2000) });
    R.emit('resultdone', { id, count: rows.length, truncated: false, ms: 0, incomplete: null, warnings });
    R.rows += rows.length;
    return id;
  }

  // SELECT @v = … (02 §9 Variables): the last row's values, or row by row when an expression reads a variable the
  // statement assigns (see the notes at the top of this file).
  async function selectAssign(S, core) {
    const q = S.stmt.query;
    const items = core.cols;
    const assigned = new Set(items.map(c => lower(c.assign)));
    const exprOf = c => (c.op && c.op !== '=' ? { type: 'bin', op: c.op.slice(0, -1), l: { type: 'var', name: lower(c.assign) }, r: c.expr } : c.expr);
    const exprs = items.map(exprOf);
    const reads = x => anyNode(x, n => n.type === 'var' && assigned.has(lower(n.name)));
    if (!exprs.some(reads)) {
      const plainQ = { ...q, body: { ...core, cols: items.map((c, i) => itemOf(exprs[i])) } };
      const { node, env } = await plan(S, plainQ);
      let n = 0, last = null;
      for await (const batch of node.run(env)) { for (const row of batch) { last = row; n++; } }
      if (last) items.forEach((c, i) => assignVar(S, c.assign, last[i], node.schema[i], last, env));
      emitPlan(S, node);
      session.rowcount = n;
      return;
    }
    // row by row: lift every part that reads no assigned variable into one query, evaluate the rest per row
    const lifted = [];
    const lift = x => {
      if (!isObj(x)) return x;
      if (!reads(x)) {
        if (x.type === 'lit' || x.type === 'var') return x;
        const alias = `__lift${lifted.length}`;
        lifted.push(itemOf(x, alias));
        return colRef(alias);
      }
      return mapExpr(x, lift);
    };
    const outer = exprs.map(lift);
    if (!lifted.length) lifted.push(itemOf(litOf(1), '__lift_row'));
    const innerQ = { ...q, body: { ...core, cols: lifted } };
    const { node: inner, env } = await plan(S, innerQ);
    const scopeSchema = inner.schema.filter(c => !c.hidden);
    const outerPlans = [];
    for (const x of outer) {
      const ctxEnv = envOf(S);
      const p = await planQuery(queryOf({ cols: [itemOf(x)] }), ctxOf(S, ctxEnv, { outerScope: { schema: scopeSchema, parent: null } }));
      outerPlans.push(p);
    }
    let n = 0;
    for await (const batch of inner.run(env)) {
      for (const row of batch) {
        n++;
        const vis = [];
        inner.schema.forEach((c, i) => { if (!c.hidden) vis.push(row[i]); });
        for (let i = 0; i < items.length; i++) {
          const e = envOf(S, { outer: [vis], subq: env.subq });
          const got = await collect(outerPlans[i], e, 1);
          const r = got[0] ?? [null];
          assignVar(S, items[i].assign, r[0] ?? null, outerPlans[i].schema[0], r, e);
        }
        if (n % 500 === 0) await tick(S.R);
      }
    }
    emitPlan(S, inner);
    session.rowcount = n;
  }

  // ---- DECLARE ---------------------------------------------------------------------------------------------------------------
  async function runDeclare(S) {
    for (const v of S.stmt.vars) {
      const key = lower(v.name);
      if (v.table) { S.scope.vars.set(key, { name: v.name, table: newTable(v.name, v.table) }); continue; }
      S.scope.vars.set(key, { name: v.name, dataType: v.dataType, value: null, ref: null });
      if (v.init) {
        const r = await scalar(S, v.init);
        assignVar(S, v.name, r.value, r.type, r.row, r.env);
      }
    }
    session.rowcount = 0;
  }

  // A #temp table or table variable from its column definitions (01 §4.1).
  function newTable(name, defs) {
    const columns = defs.map(d => ({
      name: d.name, ...dtOf(d.dataType, 1), dataType: d.dataType, nullable: d.nullable !== false, identity: d.identity ?? null,
      default: d.default ?? null, pk: !!d.pk,
    }));
    const ident = columns.findIndex(c => c.identity);
    return {
      name, columns, rows: [],
      identity: ident >= 0 ? { index: ident, next: Number(columns[ident].identity.seed ?? 1), step: Number(columns[ident].identity.step ?? 1), last: null } : null,
    };
  }

  // ---- SET options -------------------------------------------------------------------------------------------------------
  function runSetOpt(S) {
    const { name, value } = S.stmt;
    switch (name) {
      case 'DATEFORMAT': session.opts.dateformat = value; break;
      case 'DATEFIRST': session.opts.datefirst = value; break;
      case 'NOCOUNT': session.opts.nocount = !!value; break;
      case 'LANGUAGE':
        if (value === 'British') Object.assign(session.opts, { language: 'British', dateformat: 'dmy', datefirst: 1 });
        else Object.assign(session.opts, { language: 'us_english', dateformat: 'mdy', datefirst: 7 });
        break;
      case 'QUOTED_IDENTIFIER':
        if (session.opts.quotedIdentifier !== !!value) S.R.qiChanged = true;
        session.opts.quotedIdentifier = !!value;
        break;
      default: throw plain(`SET ${name} is not supported.`);
    }
    session.rowcount = 0;
  }

  // ---- RAISERROR, THROW, WAITFOR ---------------------------------------------------------------------------------------------
  async function runRaiserror(S) {
    const vals = [];
    for (const a of S.stmt.args) vals.push(await scalar(S, a));
    const [m, sev, st, ...rest] = vals;
    const severity = sev?.value == null ? 16 : Number(sev.value);
    const state = st?.value == null ? 1 : Number(st.value);
    let text, number = 50000;
    if (typeof m?.value === 'number') {
      number = m.value;
      text = `Error ${m.value}, severity ${severity}, state ${state} was raised, but no message with that error number was found in sys.messages. If error is larger than 50000, make sure the user-defined message is added using sp_addmessage.`;
    } else {
      text = formatMessage(String(m?.value ?? ''), rest.map(r => r.value), rest.map(r => r.type));
    }
    if ((S.stmt.options ?? []).includes('SETERROR')) session.error = number;
    session.rowcount = 0;
    if (severity <= 10) {
      S.R.emit('message', { kind: 'print', text, pos: null, end: null, line: null, index: S.R.index, setId: null });
      return;
    }
    const e = new SqlError(text);
    e.number = number;
    e.severity = Math.min(Math.max(severity, 11), 25);
    e.state = state;
    e.pos = S.stmt.pos;
    throw e;
  }

  async function runThrow(S) {
    const args = S.stmt.args ?? [];
    if (!args.length) {
      const c = S.scope.catchError;
      if (!c) throw plain('THROW without arguments can only be used inside a CATCH block.');
      const e = new SqlError(c.message);
      Object.assign(e, { number: c.number, severity: c.severity, state: c.state, pos: c.pos, end: c.end });
      throw e;
    }
    const [n, m, st] = [await scalar(S, args[0]), await scalar(S, args[1]), await scalar(S, args[2])];
    const num = Number(n.value);
    if (!Number.isInteger(num) || num < 50000 || num > 2147483647) throw E(35100, String(n.value));
    const state = Number(st.value);
    if (!Number.isInteger(state) || state < 0 || state > 255) throw plain(`State ${st.value} in the THROW statement is outside the valid range. Specify a state in the valid range of 0 to 255.`);
    const e = new SqlError(textOf(S, m.value, m.type));
    Object.assign(e, { number: num, severity: 16, state, pos: S.stmt.pos });
    throw e;
  }

  async function runWaitfor(S) {
    const r = await scalar(S, S.stmt.expr);
    const raw = r.value;
    let h, mi, s, ms;
    if (raw instanceof Date) {
      h = raw.getUTCHours(); mi = raw.getUTCMinutes(); s = raw.getUTCSeconds(); ms = raw.getUTCMilliseconds();
    } else {
      const m = /^\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?\s*$/.exec(String(raw ?? ''));
      if (!m) throw E(148, String(raw ?? ''));
      [h, mi, s, ms] = [+m[1], +m[2], +(m[3] ?? 0), +(String(m[4] ?? '0').padEnd(3, '0'))];
      if (h > 23 || mi > 59 || s > 59) throw E(148, String(raw));
    }
    const spanMs = ((h * 60 + mi) * 60 + s) * 1000 + ms;
    let wait = spanMs, until = null;
    if (S.stmt.kind === 'time') {
      const now = Date.now();
      const wall = now + S.tz.offset(now) * 60000;
      const day = Math.floor(wall / 86400000) * 86400000;
      let target = day + spanMs;
      if (target <= wall) target += 86400000;
      wait = target - wall;
      until = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    if (wait > 86400000) throw plain('WAITFOR can wait at most 24 hours.');
    // an injected wait replaces the timer; the countdown below is the browser's
    if (typeof o.wait === 'function') { await o.wait(wait, S.R.signal); if (S.R.signal?.aborted) throw abortError(); session.rowcount = 0; return; }
    const end = Date.now() + wait;
    const clock = left => { const t = Math.ceil(left / 1000); return `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
    while (Date.now() < end) {
      if (S.R.signal?.aborted) throw abortError();
      const left = end - Date.now();
      S.R.emit('progress', { text: until ? `Waiting until ${until} · ${clock(left)} left` : `Waiting · ${clock(left)} left`, pct: wait ? Math.round((1 - left / wait) * 100) : 100 });
      await new Promise(res => {
        const t = setTimeout(res, Math.min(1000, Math.max(0, left)));
        S.R.signal?.addEventListener?.('abort', () => { clearTimeout(t); res(); }, { once: true });
      });
    }
    session.rowcount = 0;
  }

  // ---- CREATE TABLE, DROP TABLE ---------------------------------------------------------------------------------------------
  function runCreate(S) {
    const name = lastPart(S.stmt.name);
    if (!name.startsWith('#')) throw plain(`CREATE TABLE can only create #temp tables; ${name} is not one. Create Dataverse tables in the maker portal.`);
    if (session.temps.has(lower(name))) throw E(2714, name);
    session.temps.set(lower(name), newTable(name, S.stmt.cols));
    emitTemps();
    session.rowcount = 0;
  }

  function runDrop(S) {
    let changed = false;
    for (const n of S.stmt.names) {
      const name = lastPart(n);
      if (!name.startsWith('#')) throw plain(`DROP TABLE can only drop #temp tables; ${name} is not one.`);
      if (session.temps.delete(lower(name))) changed = true;
      else if (!S.stmt.ifExists) throw E(3701, name);
    }
    if (changed) emitTemps();
    session.rowcount = 0;
  }

  // ---- INSERT, UPDATE, DELETE -------------------------------------------------------------------------------------------------
  // The #temp table or table variable a name refers to: {kind, key, table}, or null for any other name.
  function tempOf(S, name) {
    const n = String(name ?? '');
    if (n.startsWith('#')) {
      const t = session.temps.get(lower(n));
      if (!t) throw E(208, n);
      return { kind: 'temp', key: lower(n), table: t };
    }
    if (n.startsWith('@')) {
      const v = S.scope.vars.get(lower(n));
      if (!v || !v.table) throw E(1087, n);
      return { kind: 'var', key: lower(n), table: v.table };
    }
    return null;
  }

  // The DML target's source in FROM (02 §8.1 step 1): {source, alias} for a table source, else null.
  function targetSource(stmt) {
    const name = lower(lastPart(stmt.target));
    if (!stmt.from) return null;
    const srcs = sourcesOf(stmt.from);
    const byAlias = srcs.filter(s => s.alias && lower(s.alias) === name);
    if (byAlias.length === 1) return { source: byAlias[0], alias: name };
    if (byAlias.length > 1) throw E(8154, lastPart(stmt.target));
    const byName = srcs.filter(s => s.type === 'table' && lower(lastPart(s.name)) === name);
    if (byName.length === 1) return { source: byName[0], alias: lower(byName[0].alias ?? lastPart(byName[0].name)) };
    if (byName.length > 1) throw E(8154, lastPart(stmt.target));
    return null;
  }

  async function runDml(S) {
    const stmt = S.stmt;
    const name = lastPart(stmt.target);
    if (name.startsWith('#') || name.startsWith('@')) return tempDml(S, name, null);
    if (stmt.type !== 'insert' && stmt.from) {
      const t = targetSource(stmt);
      if (t && t.source.type === 'table') {
        const tn = lastPart(t.source.name);
        if (tn.startsWith('#') || tn.startsWith('@')) return tempDml(S, tn, t.alias);
      }
    }
    const via = viaTarget(stmt);
    if (via) return tempDml(S, via.table, via.alias, via);
    return dataverseDml(S);
  }

  // A CTE or derived-table target over one #temp table or table variable, else null (dml.js resolves and checks
  // it again for a Dataverse table, with the same errors).
  function viaTarget(stmt) {
    const isCte = (stmt.with ?? []).some(d => lower(d.name) === lower(lastPart(stmt.target)));
    if (!isCte && (stmt.type === 'insert' || !stmt.from)) return null;
    let r;
    try { r = dmlTarget(stmt.type === 'insert' ? { ...stmt, from: null } : stmt); } catch { return null; }
    if (!r?.viaDef || !r.def || !/^[#@]/.test(r.table)) return null;
    return r;
  }

  // The output columns of a CTE or derived target over a temp table: [{name, base: the temp column it reads | null}].
  function viaColumns(via, t) {
    const out = [];
    for (const c of via.def.query.body.cols) {
      if (c.star) { for (const col of t.columns) out.push({ name: col.name, base: col.name }); continue; }
      const col = c.expr?.type === 'col' ? c.expr.parts[c.expr.parts.length - 1] : null;
      out.push({ name: c.alias ?? col, base: col });
    }
    (via.def.colNames ?? []).forEach((n, i) => { if (out[i]) out[i] = { ...out[i], name: typeof n === 'string' ? n : n?.name ?? String(n) }; });
    return out;
  }

  // A deep copy of an AST part (the target's definition gets an extra column, and statements can run again).
  const cloneAst = x => (Array.isArray(x) ? x.map(cloneAst) : isObj(x) && Object.getPrototypeOf(x) === Object.prototype ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, cloneAst(v)])) : x);

  // Converts a value for a column of a #temp table or table variable (01 §4.1: 2628 for a too-long string, 515 for NULL
  // in a NOT NULL column).
  function convertCell(S, value, fromType, col, tableName, verb) {
    if (value == null) {
      if (col.nullable === false) throw E(515, col.name, tableName, verb);
      return null;
    }
    const opts = { tz: S.tz, dateformat: session.opts.dateformat };
    const dt = col.dataType;
    if (dt && STRINGISH.has(dt.name) && dt.args?.[0] != null && dt.args[0] !== 'max') {
      const wide = castValue(value, fromType ?? { dt: 'any' }, { name: dt.name, args: ['max'] }, opts);
      const len = Number(dt.args[0]);
      const size = typeof wide === 'string' ? wide.length : wide?.length ?? 0;
      if (size > len) {
        const shown = typeof wide === 'string' ? wide.slice(0, len) : '';
        throw E(2628, tableName, col.name, shown);
      }
      return castValue(wide, { dt: 'string', len: -1, unicode: true }, dt, opts);
    }
    return dt ? castValue(value, fromType ?? { dt: 'any' }, dt, opts) : value;
  }

  // A shadow copy of a temp target with a row-number column (see the notes at the top of this file) and the env/ctx that read it.
  function shadowOf(S, target) {
    const t = target.table;
    const shadow = { ...t, columns: [...t.columns, { name: ROWID, dt: 'int', nullable: false }], rows: t.rows.map((r, i) => [...r, i]) };
    if (target.kind === 'temp') {
      const temps = new Map(session.temps);
      temps.set(target.key, shadow);
      const sess = Object.assign(Object.create(session), { temps });
      return { env: { session: sess }, ctx: { temps, session: sess } };
    }
    const vars = new Map(S.scope.vars);
    vars.set(target.key, { ...vars.get(target.key), table: shadow });
    return { env: { vars }, ctx: {} };
  }

  // Evaluates INSERT source rows: {rows, types} (VALUES row by row, DEFAULT kept as a marker; or the query's rows).
  const DEFAULT_MARK = Symbol('default');
  async function insertRows(S, width) {
    const stmt = S.stmt;
    if (stmt.defaultValues) return { rows: [[]], types: [] };
    if (stmt.values) {
      const rows = [];
      let types = null;
      for (const vals of stmt.values) {
        if (width != null && vals.length !== width) throw E(vals.length > width ? 110 : 109);
        const marks = vals.map(v => v?.type === 'default');
        const cols = vals.map((v, i) => itemOf(marks[i] ? litOf(null) : v, `c${i}`));
        const { node, env } = await plan(S, queryOf({ cols }));
        const got = await collect(node, env, 1);
        const row = (got[0] ?? []).slice(0, vals.length).map((v, i) => (marks[i] ? DEFAULT_MARK : v));
        const rowTypes = node.schema.slice(0, vals.length);
        rows.push(row);
        if (!types) types = rowTypes;
        rows[rows.length - 1].types = rowTypes;
        rows[rows.length - 1].env = env;
        rows[rows.length - 1].full = got[0] ?? [];
        rows[rows.length - 1].schema = node.schema;
      }
      return { rows, types: types ?? [] };
    }
    const { node, env } = await plan(S, stmt.query);
    const all = await collect(node, env);
    const vis = [];
    node.schema.forEach((c, i) => { if (!c.hidden) vis.push(i); });
    if (width != null && vis.length !== width) {
      const more = vis.length > width;
      throw E(more ? 121 : 120);
    }
    emitPlan(S, node);
    const types = vis.map(i => node.schema[i]);
    const rows = all.map(r => {
      const out = vis.map(i => r[i]);
      out.types = types;
      out.env = env;
      out.full = r;
      out.schema = node.schema;
      return out;
    });
    return { rows, types };
  }

  async function tempDml(S, name, alias, via = null) {
    const stmt = S.stmt;
    const target = tempOf(S, name);
    const t = target.table;
    const verb = stmt.type.toUpperCase();
    const tableName = t.name ?? name;
    const t0 = performance.now();
    let changed = 0;
    const outRows = [];
    const baseIndex = c => {
      const i = t.columns.findIndex(x => lower(x.name) === lower(c));
      if (i < 0) throw E(207, c);
      return i;
    };
    // through a CTE or derived table: its column names map to the temp table's columns (4406 for a computed one)
    const viaCols = via ? viaColumns(via, t) : null;
    const colIndex = !viaCols ? baseIndex : c => {
      const hit = viaCols.find(x => lower(x.name) === lower(c));
      if (!hit) throw E(207, c);
      if (!hit.base) throw E(4406, via.viaDef);
      return baseIndex(hit.base);
    };
    if (stmt.type === 'insert') {
      const cols = stmt.cols ? stmt.cols.map(c => colIndex(c.name))
        : viaCols ? viaCols.map(x => colIndex(x.name))
          : t.columns.map((c, i) => i).filter(i => !t.columns[i].identity);
      if (t.identity && cols.includes(t.identity.index)) throw E(544, tableName);
      const { rows } = await insertRows(S, stmt.defaultValues ? null : cols.length);
      const added = [];
      for (const src of rows) {
        const row = new Array(t.columns.length).fill(null);
        const given = new Set();
        cols.forEach((ci, k) => {
          if (stmt.defaultValues || src[k] === DEFAULT_MARK) return;
          row[ci] = convertCell(S, src[k], src.types?.[k], t.columns[ci], tableName, verb);
          given.add(ci);
        });
        for (let ci = 0; ci < t.columns.length; ci++) {
          if (given.has(ci)) continue;
          const c = t.columns[ci];
          if (t.identity && ci === t.identity.index) { row[ci] = t.identity.next; t.identity.last = t.identity.next; t.identity.next += t.identity.step; continue; }
          if (c.default) { const d = await scalar(S, c.default); row[ci] = convertCell(S, d.value, d.type, c, tableName, verb); continue; }
          if (c.nullable === false) throw E(515, c.name, tableName, verb);
        }
        added.push(row);
      }
      for (const r of added) t.rows.push(r);
      changed = added.length;
      if (stmt.output) outRows.push(...added.map(r => ({ inserted: r, deleted: null })));
    } else {
      const src = shadowOf(S, target);
      const al = alias ?? lower(name);
      let from = stmt.from ?? tableSrc(stmt.target, al);
      let withs = stmt.with ?? null;
      if (via) {
        // the definition also returns the temp row it reads
        from = cloneAst(stmt.from ?? tableSrc(stmt.target, null));
        withs = cloneAst(stmt.with ?? null);
        const def = via.def.kind === 'cte'
          ? withs.find(d => lower(d.name) === lower(via.viaDef))
          : sourcesOf(from).find(s => s.type === 'derived' && lower(s.alias) === lower(via.alias));
        const q = via.def.kind === 'cte' ? def.query : def.query;
        q.body.cols.push(itemOf(colRef(via.def.baseAlias, ROWID), VIA_ROW));
        if (Array.isArray(def.columns)) def.columns.push(typeof def.columns[0] === 'string' || !def.columns.length ? VIA_ROW : { ...def.columns[0], name: VIA_ROW });
      }
      const top = stmt.top ? { expr: stmt.top.expr, percent: !!stmt.top.percent, ties: false } : null;
      const sets = stmt.type === 'update' ? stmt.sets : [];
      const cols = [itemOf(colRef(via ? via.alias : al, via ? VIA_ROW : ROWID), ROWID)];
      sets.forEach((s, i) => {
        const expr = s.op && s.op !== '=' ? { type: 'bin', op: s.op.slice(0, -1), l: s.variable ? { type: 'var', name: lower(s.variable) } : colRef(al, lastPart(s.col)), r: s.expr } : s.expr;
        cols.push(itemOf(expr, `__set${i}`));
      });
      const q = queryOf({ cols, from, where: stmt.where, top, withs });
      const { node, env } = await plan(S, q, { env: src.env, ctx: src.ctx });
      const got = await collect(node, env);
      emitPlan(S, node);
      const seen = new Set();
      if (stmt.type === 'delete') {
        for (const r of got) seen.add(r[0]);
        if (stmt.truncate) { for (let i = 0; i < t.rows.length; i++) seen.add(i); }
        if (stmt.output) for (const i of [...seen].sort((a, b) => a - b)) outRows.push({ inserted: null, deleted: t.rows[i] });
        t.rows = t.rows.filter((r, i) => !seen.has(i));
        if (stmt.truncate && t.identity) { t.identity.next = Number(t.columns[t.identity.index].identity?.seed ?? 1); t.identity.last = null; }
        changed = seen.size;
      } else {
        const plans = [];
        for (const r of got) {
          const i = r[0];
          if (seen.has(i)) continue;
          seen.add(i);
          const before = t.rows[i];
          const next = before.slice();
          sets.forEach((s, k) => {
            const v = r[1 + k];
            const type = node.schema[1 + k];
            if (s.variable) { assignVar(S, s.variable, v, type, r, env); return; }
            const ci = colIndex(lastPart(s.col));
            if (t.identity && ci === t.identity.index) throw E(8102, t.columns[ci].name);
            next[ci] = convertCell(S, v, type, t.columns[ci], tableName, verb);
          });
          plans.push([i, next, before]);
        }
        for (const [i, next, before] of plans) {
          t.rows[i] = next;
          if (stmt.output) outRows.push({ inserted: next, deleted: before });
        }
        changed = plans.length;
      }
    }
    session.rowcount = changed;
    if (target.kind === 'temp') emitTemps();
    if (stmt.output) await emitOutput(S, outRows, t.columns.map(c => ({ ...c, qual: null })), null);
    if (!session.opts.nocount) S.R.emit('message', { kind: 'rows', text: rowsText(changed), pos: null, end: null, line: null, index: S.R.index, setId: null, rows: changed, ms: Math.round(performance.now() - t0) });
  }

  // OUTPUT inserted.*/deleted.* (02 §8.1 OUTPUT): a result set of the written rows, or INTO a #temp/@table.
  async function emitOutput(S, outRows, columns, entityName) {
    const out = S.stmt.output;
    if (!out) return;
    const schema = [
      ...columns.map(c => ({ ...c, qual: 'inserted', hidden: false })),
      ...columns.map(c => ({ ...c, qual: 'deleted', hidden: false })),
    ];
    const items = [];
    for (const c of out.cols) {
      if (c.star) {
        const q = lower(c.qualifier ?? '');
        const which = q === 'deleted' ? ['deleted'] : q === 'inserted' ? ['inserted'] : S.stmt.type === 'delete' ? ['deleted'] : ['inserted'];
        for (const w of which) for (const col of columns) items.push(itemOf(colRef(w, col.name), col.name));
      } else items.push(itemOf(c.expr, c.alias ?? null));
    }
    const env0 = envOf(S);
    const p = await planQuery(queryOf({ cols: items }), ctxOf(S, env0, { outerScope: { schema, parent: null } }));
    const rows = [];
    for (const r of outRows) {
      const row = [...(r.inserted ?? columns.map(() => null)), ...(r.deleted ?? columns.map(() => null))];
      const got = await collect(p, envOf(S, { outer: [row], subq: env0.subq }), 1);
      rows.push(got[0] ?? []);
    }
    const vis = [];
    p.schema.forEach((c, i) => { if (!c.hidden) vis.push(i); });
    const visRows = rows.map(r => vis.map(i => r[i] ?? null));
    const visCols = vis.map(i => p.schema[i]);
    if (out.into) {
      const target = tempOf(S, lastPart(out.into));
      if (!target) throw plain('INTO can only target #temp tables and table variables. Use INSERT INTO <table> SELECT ... (it has its own preview).');
      const t = target.table;
      const intoCols = out.intoCols ? out.intoCols.map(n => { const i = t.columns.findIndex(c => lower(c.name) === lower(n)); if (i < 0) throw E(207, n); return i; }) : t.columns.map((c, i) => i).filter(i => !t.columns[i].identity);
      if (intoCols.length !== visCols.length) throw E(visCols.length > intoCols.length ? 110 : 109);
      for (const r of visRows) {
        const row = new Array(t.columns.length).fill(null);
        intoCols.forEach((ci, k) => { row[ci] = convertCell(S, r[k], visCols[k], t.columns[ci], t.name, 'INSERT'); });
        if (t.identity) { row[t.identity.index] = t.identity.next; t.identity.next += t.identity.step; }
        t.rows.push(row);
      }
      if (target.kind === 'temp') emitTemps();
      return;
    }
    emitSet(S, { title: entityName, columns: visCols, rows: visRows });
  }

  // ---- Dataverse INSERT, UPDATE, DELETE through dml.js (02 §8) ---------------------------------------------------------------
  function readonlyError() {
    return plain(READONLY_TEXT, { code: 'READONLY' });
  }
  function cancelledError() {
    return Object.assign(new Error(CANCELLED_TEXT), { cancelled: true });
  }

  // The partial-selection note of a DML statement (02 §9 Partial selection), or null.
  function partialOf(S) {
    const R = S.R;
    if (S.scope.dynamic || R.fullText == null || R.fullText === R.text) return null;
    try {
      const at = R.offset + (S.scope.shift || 0) + S.stmt.pos;
      const end = R.offset + (S.scope.shift || 0) + S.stmt.end;
      const ranges = statementRanges(R.fullText, { quotedIdentifier: session.opts.quotedIdentifier });
      const r = ranges.find(x => x.start <= at && x.end >= end);
      if (r && r.end > end) {
        const omitted = R.fullText.slice(end, r.end).trim();
        if (omitted && !/^;?$/.test(omitted)) return { omittedText: omitted };
      }
    } catch { /* no ranges */ }
    return null;
  }

  // The context dml.js plans and runs a statement with.
  function dmlCtx(S, extra = {}) {
    const R = S.R;
    const key = `${S.scope.dynamic ? `dyn:${S.scope.text}|` : ''}${S.stmt.pos}|${S.stmt.end}`;
    const execution = (R.executions.get(key) ?? 0) + 1;
    R.executions.set(key, execution);
    return {
      api, meta, org: orgEnv, user, caller: api.caller?.() ?? null, settings: S.settings, tz: S.tz, dateformat: session.opts.dateformat,
      plan: (q, opts) => plan(S, q, opts), collect, scalar: e => scalar(S, e), warn: S.warn, info: S.info,
      text: S.scope.text, statementText: S.scope.text.slice(S.stmt.pos, S.stmt.end), runId: R.runId, execution,
      partial: partialOf(S), dynamic: !!S.scope.dynamic, signal: R.signal, temps: session.temps, vars: S.scope.vars,
      progress: p => R.emit('progress', p), envOf: x => envOf(S, x), ctxOf: (env, x) => ctxOf(S, env, x),
      assignVar: (name, value, type, row, env) => assignVar(S, name, value, type, row, env), insertRows: width => insertRows(S, width), DEFAULT: DEFAULT_MARK,
      literals: { guidParam, enumParam },
      ...extra,
    };
  }

  async function dataverseDml(S) {
    if (!api.mode().allowed) throw readonlyError();
    const R = S.R;
    const t0 = performance.now();
    const prep = await prepareDml(S.stmt, dmlCtx(S));
    if (prep.plan) emitPlan(S, prep.plan);
    if (!prep.preview) {
      for (const w of prep.warnings ?? []) S.warn(w);
      session.rowcount = 0;
      if (!session.opts.nocount) R.emit('message', { kind: 'rows', text: prep.message ?? rowsText(0), pos: null, end: null, line: null, index: R.index, setId: null, rows: 0 });
      return;
    }
    await confirmAndWrite(S, prep, t0);
  }

  // Confirms a prepared change (ui.confirmChange), writes it and reports its outcome (02 §9 DML outcomes).
  async function confirmAndWrite(S, prep, t0 = performance.now()) {
    const R = S.R;
    if (!api.mode().allowed) throw readonlyError();
    const c = ui?.confirmChange ? await ui.confirmChange(prep.preview) : null;
    if (!c || !c.grant) throw cancelledError();
    const out = await prep.execute(c.grant, {
      stop: () => !!R.signal?.aborted, backup: !!c.backup,
      onProgress: p => R.emit('progress', { write: p }),
    });
    if (out.entry) {
      try { changeLog?.add?.(out.entry); } catch { /* the log's */ }
      R.emit('change', { entry: out.entry });
    }
    if (c.standing) R.emit('message', { kind: 'info', text: `Execution ${prep.preview.execution ?? 1} of this statement: ${int(prep.preview.count)} records (standing approval).`, pos: null, end: null, line: null, index: R.index, setId: null });
    session.rowcount = out.ok;
    if (out.identity) session.identity = out.identity;
    for (const m of out.messages ?? []) R.emit('message', { kind: m.kind ?? 'info', text: m.text, pos: null, end: null, line: null, index: R.index, setId: null, link: m.link });
    for (const w of out.warnings ?? []) S.warn(w);
    if (out.output && S.stmt.output) await emitOutput(S, out.output.rows, out.output.columns, prep.preview.entity?.logicalName ?? null);
    if (out.resultSets) for (const set of out.resultSets) emitSet(S, set);
    if (!session.opts.nocount) R.emit('message', { kind: 'rows', text: rowsText(out.ok), pos: null, end: null, line: null, index: R.index, setId: null, rows: out.ok, ms: Math.round(performance.now() - t0) });
    if (out.failed) {
      const e = plain(`${int(out.failed)} of ${int(out.total)} records failed: ${out.firstMessage ?? 'see the change log'}`);
      if (Number.isInteger(out.firstNumber)) e.number = out.firstNumber;
      throw e;
    }
  }

  // ---- EXEC of Web API messages (02 §8.1 EXEC, §9 Web API functions) ----------------------------------------------------------
  async function runExec(S) {
    const R = S.R;
    const prep = await prepareExec(S.stmt, dmlCtx(S));
    if (prep.kind === 'function') {
      const out = await prep.run();
      await finishExec(S, prep, out);
      return;
    }
    if (!api.mode().allowed) throw readonlyError();
    const c = ui?.confirmChange ? await ui.confirmChange(prep.preview) : null;
    if (!c || !c.grant) throw cancelledError();
    const out = await prep.execute(c.grant, { stop: () => !!R.signal?.aborted, onProgress: p => R.emit('progress', { write: p }) });
    if (out.entry) {
      try { changeLog?.add?.(out.entry); } catch { /* the log's */ }
      R.emit('change', { entry: out.entry });
    }
    await finishExec(S, prep, out);
  }

  // Result sets, OUTPUT parameters and @ret of an EXEC (02 §8.1 EXEC OUTPUT parameters).
  async function finishExec(S, prep, out) {
    for (const [varName, value, type] of out.outputs ?? []) assignVar(S, varName, value, type);
    if (S.stmt.assignTo) assignVar(S, S.stmt.assignTo, 0, { dt: 'int' });
    if (!(out.outputs ?? []).length) for (const set of out.resultSets ?? []) emitSet(S, set);
    for (const w of out.warnings ?? []) S.warn(w);
    if (out.failed) throw plain(out.message ?? `${prep.name} failed.`, { number: out.number });
    session.rowcount = out.rowcount ?? 0;
  }

  // ---- dynamic SQL (02 §9 sp_executesql) -------------------------------------------------------------------------------
  const isNString = t => !t || t.dt === 'any' || t.dt === 'null' || (t.dt === 'string' && t.unicode === true);
  async function runDynamic(S) {
    const st = S.stmt;
    if (S.scope.depth >= MAX_NEST) throw E(217);
    const sv = await scalar(S, st.stmt);
    if (!st.dynamic && !isNString(sv.type)) throw E(214, '@statement', 'ntext/nchar/nvarchar');
    if (sv.value == null) return;
    let params = [];
    if (st.params) {
      const pv = await scalar(S, st.params);
      if (!isNString(pv.type)) throw E(214, '@params', 'ntext/nchar/nvarchar');
      if (pv.value != null && String(pv.value).trim()) params = parseParams(String(pv.value), { quotedIdentifier: session.opts.quotedIdentifier });
    }
    const vars = new Map();
    for (const p of params) vars.set(lower(p.name), { name: p.name, dataType: p.dataType, value: null, ref: null, output: !!p.output });
    const args = st.args ?? [];
    if (args.length > params.length) throw E(8144, 'sp_executesql');
    const supplied = new Set();
    const inner = { vars, localCursors: new Map(), text: String(sv.value), shift: 0, dynamic: true, depth: S.scope.depth + 1, catchError: null };
    const innerS = { ...S, scope: inner };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const p = a.name ? params.find(x => lower(x.name) === lower(a.name)) : params[i];
      if (!p) throw a.name ? E(8145, a.name, 'sp_executesql') : E(8144, 'sp_executesql');
      const v = await scalar(S, a.expr);
      assignVar(innerS, p.name, v.value, v.type, v.row, v.env);
      supplied.add(lower(p.name));
    }
    for (const p of params) {
      if (supplied.has(lower(p.name))) continue;
      if (p.default) { const d = await scalar(S, p.default); assignVar(innerS, p.name, d.value, d.type); continue; }
      throw E(8178, `(${params.map(x => x.raw ?? x.name).join(',')})${String(sv.value).slice(0, 4000)}`, p.name);
    }
    const text = String(sv.value);
    let stmts;
    try {
      stmts = parse(text, { quotedIdentifier: session.opts.quotedIdentifier, dynamic: true, vars: params.map(p => p.name) });
    } catch (e) { throw dynError(e, text); }
    try {
      await runStatements(stmts, inner, S.R);
    } catch (e) {
      if (fatal(e)) throw e;
      throw dynError(e, text);
    }
    for (const a of args) {
      if (!a.output) continue;
      const p = a.name ? params.find(x => lower(x.name) === lower(a.name)) : params[args.indexOf(a)];
      if (!p || a.expr?.type !== 'var') continue;
      const v = vars.get(lower(p.name));
      assignVar(S, a.expr.name, v?.value ?? null, dtOf(p.dataType, 1), null, null);
    }
  }

  // An error raised inside dynamic SQL, as the caller sees it (02 §9 (4): 'Dynamic SQL line n:').
  function dynError(e, text) {
    if (!e || e.dynamicDone || fatal(e)) return e;
    const line = lineOf(text, e.pos) ?? 1;
    e.message = `Dynamic SQL line ${line}: ${e.message}`;
    e.pos = null;
    e.end = null;
    e.dynamicDone = true;
    e.reported = false;
    return e;
  }

  // ---- cursors (02 §9 Cursors) -----------------------------------------------------------------------------------------
  function cursorOf(S, name, global) {
    const key = lower(name);
    if (!global && S.scope.localCursors.has(key)) return S.scope.localCursors.get(key);
    if (session.cursors.has(key)) return session.cursors.get(key);
    throw E(16916, name);
  }

  async function runCursor(S) {
    const st = S.stmt;
    switch (st.type) {
      case 'declarecursor': {
        const opts = (st.options ?? []).map(x => String(x).toUpperCase());
        const local = opts.includes('LOCAL');
        const map = local ? S.scope.localCursors : session.cursors;
        if (map.has(lower(st.name))) throw E(16915, st.name);
        map.set(lower(st.name), { name: st.name, query: st.query, hints: st.hints ?? null, scroll: !(opts.includes('FORWARD_ONLY') || opts.includes('FAST_FORWARD')), open: false, rows: null, columns: null, pos: 0 });
        session.rowcount = 1;
        return;
      }
      case 'open': {
        const c = cursorOf(S, st.name, st.global);
        if (c.open) throw E(16905);
        const { node, env } = await plan({ ...S, stmt: { ...S.stmt, hints: c.hints } }, c.query);
        const rows = await collect(node, env);
        emitPlan(S, node);
        const vis = [];
        node.schema.forEach((col, i) => { if (!col.hidden) vis.push(i); });
        c.columns = vis.map(i => node.schema[i]);
        c.rows = rows.map(r => vis.map(i => r[i]));
        c.full = rows;
        c.schema = node.schema;
        c.open = true;
        c.pos = 0;
        session.cursorRows = c.rows.length;
        lastOpened = c;
        session.rowcount = 0;
        return;
      }
      case 'fetch': {
        const c = cursorOf(S, st.name, st.global);
        if (!c.open) throw E(16917);
        const dir = st.dir ?? 'next';
        if (!c.scroll && dir !== 'next') throw E(16911, dir.toUpperCase());
        const n = c.rows.length;
        let k = 0;
        if (st.n) { const v = await scalar(S, st.n); k = Number(castValue(v.value, v.type, { name: 'int', args: [] })); }
        let pos = c.pos;
        switch (dir) {
          case 'next': pos = Math.min(pos + 1, n + 1); break;
          case 'prior': pos = Math.max(pos - 1, 0); break;
          case 'first': pos = n ? 1 : 0; break;
          case 'last': pos = n; break;
          case 'absolute': pos = k > 0 ? (k > n ? n + 1 : k) : k < 0 ? (n + 1 + k < 1 ? 0 : n + 1 + k) : 0; break;
          case 'relative': pos = pos + k < 1 ? 0 : pos + k > n ? n + 1 : pos + k; break;
          default: break;
        }
        c.pos = pos;
        const hit = pos >= 1 && pos <= n;
        session.fetchStatus = hit ? 0 : -1;
        session.rowcount = 1;
        if (st.into) {
          if (st.into.length !== c.columns.length) throw E(16924);
          if (hit) st.into.forEach((v, i) => assignVar(S, v, c.rows[pos - 1][i], c.columns[i], c.full[pos - 1], null));
          return;
        }
        emitSet(S, { title: null, columns: c.columns, rows: hit ? [c.rows[pos - 1]] : [] });
        return;
      }
      case 'close': {
        const c = cursorOf(S, st.name, st.global);
        if (!c.open) throw E(16917);
        c.open = false;
        c.rows = null;
        c.full = null;
        if (lastOpened === c) session.cursorRows = 0;
        session.rowcount = 0;
        return;
      }
      case 'deallocate': {
        const key = lower(st.name);
        const local = !st.global && S.scope.localCursors.has(key);
        const map = local ? S.scope.localCursors : session.cursors;
        const c = map.get(key);
        if (!c) throw E(16916, st.name);
        if (lastOpened === c) session.cursorRows = 0;
        map.delete(key);
        session.rowcount = 0;
        return;
      }
      default: return;
    }
  }

  // ---- EXECUTE AS / REVERT (02 §9) --------------------------------------------------------------------------------------------
  async function runExecuteAs(S) {
    const r = await scalar(S, S.stmt.expr);
    const value = String(r.value ?? '').trim();
    let id = null;
    if (S.stmt.kind === 'user') {
      if (!/^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(value)) throw plain(`EXECUTE AS USER needs the user's systemuserid (a GUID); '${value}' is not one.`);
      id = value.replace(/[{}]/g, '').toLowerCase();
    } else {
      const xml = `<fetch top="2"><entity name="systemuser"><attribute name="systemuserid"/><attribute name="isdisabled"/><filter><condition attribute="domainname" operator="eq" value="${value.replace(/[<>&"]/g, c => `&#${c.charCodeAt(0)};`)}"/></filter></entity></fetch>`;
      const j = await api.fetchXml('systemusers', xml, { signal: S.R.signal, inBody: S.settings.queryInBody === true });
      const rows = (j?.value ?? []).filter(u => !u.isdisabled);
      if (rows.length !== 1) throw plain(rows.length ? `More than one user has the login '${value}'.` : `No enabled user has the login '${value}'.`);
      id = lower(rows[0].systemuserid);
    }
    const ok = await executeAs(id, { throwOnCancel: true });
    if (!ok) throw Object.assign(new Error('Impersonation cancelled. The rest of the script was not run.'), { cancelled: true });
    session.rowcount = 0;
  }

  // ---- explain(sql) -------------------------------------------------------------------------------------------------------------
  async function explain(sql, { offset = 0 } = {}) {
    await context();
    const text = String(sql ?? '');
    const out = [];
    let stmts;
    try { stmts = parse(text, { quotedIdentifier: session.opts.quotedIdentifier }); } catch (e) { return [{ index: 0, plan: null, fetchXml: [], error: e, kind: 'other' }]; }
    const R = { emit: () => {}, signal: null, runId: null, setN: 0, rows: 0, index: 0, total: 0, text, offset, base: text, fullText: null, maxRows: undefined, executions: new Map() };
    const scope = { vars: new Map(), localCursors: new Map(), text, shift: 0, dynamic: false, depth: 0, catchError: null };
    numberStatements(stmts);
    const planOf = async (stmt, query) => {
      const S = stmtCtx(stmt, scope, R);
      const env = envOf(S);
      const node = await planQuery(query, { ...ctxOf(S, env), explainOnly: true });
      return { ex: explainPlan(node), warnings: S.warnings };
    };
    const explainStmt = async stmt => {
      switch (stmt.type) {
        case 'select': {
          const { ex } = await planOf(stmt, stmt.query);
          return { plan: ex.plan, fetchXml: ex.fetchXml ?? [], kind: 'select' };
        }
        case 'insert': case 'update': case 'delete': {
          const name = lastPart(stmt.target);
          const kids = [];
          let fetchXml = [];
          if (stmt.type === 'insert' && stmt.query) {
            const { ex } = await planOf(stmt, stmt.query);
            kids.push(ex.plan);
            fetchXml = ex.fetchXml ?? [];
          } else if (stmt.type !== 'insert') {
            const from = stmt.from ?? tableSrc(stmt.target, null);
            const q = queryOf({ cols: [itemOf(litOf(1))], from, where: stmt.where, withs: stmt.with ?? null });
            try {
              const { ex } = await planOf(stmt, q);
              kids.push(ex.plan);
              fetchXml = ex.fetchXml ?? [];
            } catch { /* temp tables that do not exist yet */ }
          }
          return { plan: explainNode('Write', `${stmt.type.toUpperCase()} ${name}`, kids, { script: true }), fetchXml, kind: 'dml' };
        }
        case 'if': {
          const then = await explainList([stmt.then]);
          const els = stmt.else ? await explainList([stmt.else]) : [];
          return { plan: explainNode('Conditional', text.slice(stmt.cond.pos, stmt.cond.end), [explainNode('Then', '', then, { script: true }), ...(stmt.else ? [explainNode('Else', '', els, { script: true })] : [])], { script: true }), fetchXml: [], kind: 'other' };
        }
        case 'while': {
          const body = await explainList([stmt.body]);
          return { plan: explainNode('Loop', text.slice(stmt.cond.pos, stmt.cond.end), [explainNode('Body', '', body, { script: true })], { script: true }), fetchXml: [], kind: 'other' };
        }
        case 'block': return { plan: explainNode('Block', '', await explainList(stmt.body), { script: true }), fetchXml: [], kind: 'other' };
        case 'try': return { plan: explainNode('Try', '', [...await explainList(stmt.body), explainNode('Catch', '', await explainList(stmt.catch), { script: true })], { script: true }), fetchXml: [], kind: 'other' };
        default: return { plan: null, fetchXml: [], kind: 'other' };
      }
    };
    const explainList = async list => {
      const nodes = [];
      for (const s of list) {
        try { const r = await explainStmt(s); if (r.plan) nodes.push(r.plan); } catch { /* a statement that cannot be planned yet */ }
      }
      return nodes;
    };
    for (let index = 0; index < stmts.length; index++) {
      const stmt = stmts[index];
      if (stmt.type === 'go' || stmt.type === 'label') continue;
      if (stmt.type === 'declare') {
        // a DECLARE with a constant initializer is folded into later plans (02 §9 explain)
        for (const v of stmt.vars) {
          if (v.table) scope.vars.set(lower(v.name), { name: v.name, table: newTable(v.name, v.table) });
          else scope.vars.set(lower(v.name), { name: v.name, dataType: v.dataType, value: v.init?.type === 'lit' ? v.init.v : null, ref: null });
        }
        continue;
      }
      try {
        const r = await explainStmt(stmt);
        if (r.plan) out.push({ index, pos: offset + stmt.pos, end: offset + stmt.end, error: null, ...r });
      } catch (e) {
        out.push({ index, plan: null, fetchXml: [], error: e, kind: 'other', pos: offset + stmt.pos, end: offset + stmt.end });
      }
    }
    return out;
  }

  // ---- impersonation (02 §9 EXECUTE AS; the dialog confirms) --------------------------------------------------------------
  async function executeAs(userId, { throwOnCancel = false } = {}) {
    const u = await api.get(`systemusers(${userId})?$select=fullname,domainname,isdisabled,_businessunitid_value`);
    if (u.isdisabled) throw plain(`${u.fullname} is disabled.`);
    const bu = u._businessunitid_value ? await api.get(`businessunits(${u._businessunitid_value})?$select=name`).catch(() => null) : null;
    const ok = ui?.confirmImpersonation ? await ui.confirmImpersonation({ id: userId, fullname: u.fullname, domainname: u.domainname, businessunit: bu?.name ?? '' }) : false;
    if (!ok) return throwOnCancel ? false : undefined;
    api.setCaller(userId, u.fullname || u.domainname);
    const w = await api.whoAmI();
    if (String(w.UserId).toLowerCase() !== String(userId).toLowerCase()) {
      api.setCaller(null);
      throw plain('Dataverse did not confirm the acting user, so impersonation was turned off.');
    }
    return true;
  }
  async function revert() { api.setCaller(null); }

  // ---- runEdits (grid change sets) and undo -----------------------------------------------------------------------------------
  function runEdits(payload) {
    return startRun(async R => {
      const msgOut = (kind, text, code = null) => R.emit('message', { kind, text, pos: null, end: null, line: null, index: 0, setId: null, code });
      if (!api.mode().allowed) throw plain('SQL Studio is read-only. Select the Read-only pill in the top bar to save grid edits.', { code: 'READONLY' });
      const settings = settingsNow();
      const preview = await previewEdits(payload, { api, meta, org: orgEnv, caller: api.caller(), settings });
      preview.runId = R.runId;
      if (!preview.count) {
        R.emit('edits', { results: preview.preSkipped.map(s => ({ kind: s.kind, key: s.key, status: s.done ? 'done' : 'skipped', message: s.message })) });
        msgOut('info', preview.preSkipped.length ? 'Nothing was written: the records already had these values or changed since you loaded them.' : 'There are no changes to save.');
        return;
      }
      const r = ui?.confirmChange ? await ui.confirmChange(preview) : null;
      if (!r || !r.grant) throw Object.assign(new Error('Update cancelled. No records were changed.'), { cancelled: true });
      const { results, writes } = await writeEdits(preview, r.grant, { api, onProgress: p => R.emit('progress', { write: { op: 'mixed', entity: preview.entity.logicalName, ...p } }) });
      const entry = editsEntry(preview, writes, { caller: api.caller() });
      try { changeLog?.add?.(entry); } catch { /* the log's */ }
      R.emit('change', { entry });
      R.emit('edits', { results });
      const ok = writes.filter(w => w.status === 'ok').length;
      const bad = writes.length - ok;
      R.summary = `${editsSummary(preview, writes)}${bad ? `; ${int(bad)} not saved (see the grid)` : ''}`;
      msgOut(bad ? 'warn' : 'info', `${R.summary}.`);
    });
  }

  function undo(entryId) {
    return startRun(async R => {
      const entry = changeLog?.get?.(entryId);
      if (!entry) throw plain('That change is no longer in the change log.');
      if (!api.mode().allowed) throw plain(READONLY_TEXT, { code: 'READONLY' });
      const scope = { vars: new Map(), localCursors: new Map(), text: '', shift: 0, dynamic: false, depth: 0, catchError: null };
      const S = stmtCtx({ type: 'undo', pos: 0, end: 0, hints: null }, scope, R);
      const prep = await prepareUndo(entry, dmlCtx(S));
      if (!prep.preview) {
        R.emit('message', { kind: 'info', text: prep.message ?? 'Nothing to undo: the records changed since.', pos: null, end: null, line: null, index: 0, setId: null });
        return;
      }
      await confirmAndWrite(S, prep);
      R.summary = `Undid ${int(session.rowcount)} change${session.rowcount === 1 ? '' : 's'}`;
    });
  }

  // ---- Load CSV as #temp and Load file as text (02 §9) ------------------------------------------------------------------
  async function previewCsv(files, opts = {}) {
    const p = await previewCsvFiles(files, { ...opts, maxScanRows: settingsNow().maxScanRows, decimalSymbol: meta.user?.decimalSymbol ?? null });
    p.exists = session.temps.has(lower(p.name));
    return p;
  }

  function loadCsv(preview, { name, columns, replace = false, onError = 'fail', maxErrors = 10 } = {}) {
    return startRun(async R => {
      const n = String(name ?? preview?.name ?? '');
      if (!CSV_NAME_RE.test(n)) throw plain(CSV_NAME_MESSAGE);
      if (session.temps.has(lower(n)) && !replace) throw E(2714, n);
      const settings = settingsNow();
      const out = await convertCsv(preview, {
        columns, onError, maxErrors, dateformat: session.opts.dateformat, tz: tzOf(settings), signal: R.signal, name: n,
        progress: pct => R.emit('progress', { text: `Loading ${preview.fileName}`, pct }),
      });
      const table = newTable(n, out.columns.map(c => ({ name: c.name, dataType: c.dataType, nullable: true, identity: null, default: null, pk: false })));
      table.rows = out.rows;
      session.temps.set(lower(n), table);
      emitTemps();
      for (const m of out.messages) R.emit('message', { kind: 'warn', text: m, pos: null, end: null, line: null, index: 0, setId: null });
      R.emit('message', { kind: 'info', text: `Loaded ${int(out.rows.length)} rows into ${n} (${out.columns.length} columns) from ${preview.files?.length > 1 ? `${preview.files.length} files` : preview.fileName}.`, pos: null, end: null, line: null, index: 0, setId: null });
      R.emit('message', { kind: 'print', text: out.createText(n), pos: null, end: null, line: null, index: 0, setId: null });
      R.rows = out.rows.length;
    });
  }

  function loadFile(file, { name, binary = false, replace = false } = {}) {
    return startRun(async R => {
      const n = String(name ?? '');
      if (!CSV_NAME_RE.test(n)) throw plain(CSV_NAME_MESSAGE);
      if (session.temps.has(lower(n)) && !replace) throw E(2714, n);
      const out = loadFileRows(file, { binary });
      const table = newTable(n, [{ name: 'BulkColumn', dataType: binary ? { name: 'varbinary', args: ['max'] } : NVARCHAR_MAX, nullable: true, identity: null, default: null, pk: false }]);
      table.rows = [[out.value]];
      session.temps.set(lower(n), table);
      emitTemps();
      R.emit('message', { kind: 'info', text: `Loaded ${file.name} into ${n} (${int(out.size)} ${binary ? 'bytes' : 'characters'}).`, pos: null, end: null, line: null, index: 0, setId: null });
      R.rows = 1;
    });
  }

  return session;
}
