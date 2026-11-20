// SQL Studio formatter: formatSql(src, opts) -> string; formatSqlReport(src, opts) -> {text, kept}; FORMAT_DEFAULTS.
// Contracts: 01 §1 (formatSql, formatSqlReport and their rules), §3 (tokens), §4 (AST,
// incl. WITH before DML, FOR XML, sp_executesql and EXEC (…), WITH XMLNAMESPACES,
// xml methods and nodes(), cursors, GOTO and labels); 03 §5 (Format, Format › Add display names).
//
// Notes:
// - opts.quotedIdentifier (boolean, default true; any other value is the default): the QUOTED_IDENTIFIER mode of the
//   text's first batch (parse() and statementRanges() options), so a tab whose Session.opts.quotedIdentifier is
//   false formats `"text"` strings the way its markers parse them (`SELECT ""` or a "…" string over 128 characters does
//   not parse with ON). A `SET QUOTED_IDENTIFIER` in the text applies from the next batch, as in parse() (00 §2, 01
//   §4.1), also while the statements around a failing one are isolated. The editor's formatter (03 §1, §5) then takes
//   (src, {state, quotedIdentifier}) for Format and Add display names.
// - Options are read once each, before anything else: a read that throws (a getter, a revoked Proxy as opts, a
//   throwing `state` or `state.cmt` / `state.quote`) counts as a missing value, so neither function ever throws. A
//   `state` is valid only as a tokenizeLine state: {cmt: a non-negative integer, quote: null (or missing)} or {cmt: 0,
//   quote: "'" | ']' | '"'}; any other value (`cmt: 1.5`, `Infinity`, `'1'`, a depth together with a quote) is invalid
//   and uses the default.
// - Batch context (00 §2; 03 §5 formats a selection or the statement at the caret): the batch checks 137 and
//   1087 (a variable used without a DECLARE in its batch), 133 (a GOTO to a label its batch does not define), 10704 (a
//   bare THROW outside a CATCH block) and 135/136 (BREAK/CONTINUE outside a WHILE body) are about the script around a
//   piece of it, not about the piece's syntax. In the text's first batch (all of it when it has no GO line) they are
//   taken as answered by that context: the batch is parsed after a prelude that declares the variables it uses and
//   never declares (a table variable where its first use is a table source or target, else a scalar; a parse error
//   that says otherwise switches the kind once) and defines the labels it jumps to and never defines, and inside a
//   CATCH block and a WHILE body when a THROW, BREAK or CONTINUE needs them (only when its BEGIN/CASE and END words
//   pair up). So `select name from account where accountid = @id`, `set @x = 1`, `if @@fetch_status <> 0 goto done`
//   or a bare `throw` selected inside a CATCH block are formatted, and Add display names works on them; in the script
//   they come from they mean what they meant. A batch that starts inside the text (after a GO line) holds its whole
//   context, so there these checks keep their statement as an error ('error' in kept), and in the first batch so do
//   the checks no context can answer: a second DECLARE (134), a use before the batch's own DECLARE (137), a duplicate
//   label (132) and a jump into a TRY or CATCH block (1026). The editor's parse markers are those of the whole
//   document, so a piece formatted this way has none.
// - opts.displayNames (01 §1 writes `(qual, column)`) is called as `displayNames(table, column, {schema,
//   alias})`: `table` is the table name as written in FROM (without brackets or schema; never an alias), `column` the
//   column name as written, `schema` the table's schema as written or null, `alias` its alias or null. It returns the
//   whole label (`Account Name (Account)`) or null; a value that is not a string, is blank, is over 128 characters (an
//   identifier's limit, 103) or contains a control, line-separator or invisible character (01 §4.5), or a call that
//   throws, counts as null. Which items get `AS [label]` (sqlIdent; AS in keywordCase, with 'preserve' in the case of
//   the SELECT keyword): in every SELECT statement and every cursor declaration (its columns are the result set of a
//   FETCH without INTO, and INTO assigns them by position), also inside BEGIN…END, IF, WHILE and TRY…CATCH bodies, the
//   items of the result select list (the first query of a set operation; not subqueries, derived tables or CTE
//   bodies, whose column names other clauses use) that are a column reference without an alias. INSERT … SELECT is
//   not changed (its select list has no headers). A qualified reference binds to the FROM source it names (alias,
//   else table name; `schema.table.column` only to a table written without an alias, schema dbo when none is
//   written); an unqualified one, as in SQL Server, binds to the one source that has such a column: it is offered to
//   every Dataverse table of the FROM clause and gets the label only when exactly one of them gives one, and only
//   when no other source may have a column of that name. The other sources' columns are known for derived tables,
//   CTEs, VALUES, nodes(), alias column lists, OPENJSON … WITH, the built-in table-valued functions (STRING_SPLIT:
//   value, and ordinal with a third argument; GENERATE_SERIES: value; OPENJSON: key, value, type;
//   sys.fn_helpcollations(): name, description) and table variables declared earlier in the batch. The columns of
//   #temp tables, other functions, PIVOT and UNPIVOT, and of the metadata and sys tables, are unknown (any name may be
//   theirs): their lists live in metatables.js, which the 00 §3 DAG (lexer ← parser ← format) keeps out of format.js,
//   so `select accountnumber from account, metadata.entity` stays unchanged (never wrong, only conservative; adding
//   `metatables (META_TABLES) ← format` to the DAG would let it bind). #temp tables, table variables, CTE references
//   and the metadata and sys schemas are not Dataverse tables. ORDER BY binds a whole item that is a bare unqualified
//   column (`ORDER BY name`, also in parentheses) to the select list by name (01 §7.1), so an item keeps its
//   name when such an ORDER BY item (of its query or of a query on the way to its select list) names its label, or
//   names its column while the column is qualified (`a.name`: the ORDER BY name would bind to the FROM sources, or on
//   a set operation raise 104) or another item of the list is aliased with that name. Not changed: queries with FOR
//   JSON or FOR XML (the names become keys and elements) and SELECT … INTO (the names become the #temp table's
//   columns), since there the alias would change the data, not only the result headers. The aliases are added to the
//   text before the layout (the one exception to 'no token is added'), and the text with them must analyse to the same
//   failing pieces and to the same statements with exactly those aliases set; a statement that does not loses its
//   aliases (one retry), and if that fails too no alias is added. `kept` offsets are always offsets of the caller's
//   text. A statement kept 'case' keeps its aliases (it is formatted); one kept 'unformatted' is kept unchanged, so it
//   is laid out again without its aliases (and a text that cannot be laid out at all is returned as the caller wrote
//   it). The calls name every table whose metadata the labels need, synchronously and in text order, so a caller (03
//   §5) can collect them with a callback that returns null, load their metadata (meta.entity) and format again with
//   the real callback.
// - Every other token keeps its exact text: identifiers, contextual keywords used as names (`SELECT path, zone`), a
//   FETCH direction word that is a cursor name (`FETCH next`), datepart names, xml method names (`.value(`, which
//   SQL Server matches case-sensitively), ISJSON's VALUE/ARRAY/OBJECT/SCALAR argument (a column node in the AST),
//   strings, numbers (`0x…` as written), variables and operators such as != or !<. A run of ';' is written together,
//   with its comments after it.
// - Statement isolation: the text is formatted one top-level statement at a time (statementRanges, 01 §1). A cursor
//   variable assignment `SET @c = CURSOR [options] FOR <query> [FOR UPDATE …]` is one statement (01 §4.1 Cursors) even
//   where statementRanges ends a range at its FOR: format.js joins those ranges again. `kept` has one 'error' entry
//   per statement that does not parse (04 §2.1); failing statements next to each other are written as one piece with
//   the text between them, unchanged. One statement for `kept`: a failing piece and the failing piece it continues on
//   its line without ';' (the tolerant splitter starts a range at every statement keyword, so the DELETE of `MERGE …
//   THEN DELETE` is a range of its own), and a failing piece that cannot start a statement (a statement keyword, '(',
//   ';' or a label `name:`) together with the statement it continues on its line without ';' (`select 1 ? 2`), which
//   then fails too. From an unterminated string, quoted identifier or block comment the text is kept unchanged to its
//   end, and the kept 'unterminated' range starts at the start of the statement that holds the unterminated token (or
//   of a statement that ends on its line right before it without ';', `select a, /* b`), on the line where that
//   statement starts when it continues a line. A text that parses as a whole is parsed once. Otherwise the statements
//   before the first error are accepted as the whole parse read them (their DECLAREs from their tokens; they are parsed
//   once more only when one of them may set QUOTED_IDENTIFIER, for the mode of the batches after them), and from there
//   the failing statements are found window by window, each window in its batch's mode and its first batch in its
//   context; a window's prelude declares the variables it uses that accepted statements of its batch declared, and
//   defines the labels its GOTOs jump to that the batch defines outside the window, so a GOTO is never blamed for a
//   label that is merely elsewhere. Then one pass checks every GOTO against the labels of its batch that are left
//   (133; 1026 from the TRY and CATCH blocks around the label and the GOTO; 132 for a second definition in another
//   statement), so a GOTO that fails only because its label is inside a failing statement is kept with it, and the
//   whole filled text is parsed once more. All of this is linear in the size of the script: about 6-12 parses with
//   failing statements too (01 §1).
// - A kept piece never changes which lines are GO separators (01 §4.5): a piece that starts with the word GO on the
//   line of what comes before it stays on that line (a ';' run before it is then written as it was, its comments in
//   place), and when the last line of a piece starts with GO, what followed it on that line stays there. An identifier
//   GO in a statement (a column, alias or table named go) is never left alone on a line: when it would start a line
//   with only comments after it, it stays on the line before (`a, go` + newline + `FROM t`), or, after a line
//   comment, the token after it joins its line (`go FROM t`); between two line comments it cannot, and its statement
//   is kept 'unformatted'.
// - Depth: operator chains (AND/OR, + - & | ^, * / %), postfix chains (COLLATE, AT TIME ZONE, xml methods), joins, set
//   operations, CASE branches, lists and statement lists are laid out by loops; recursion follows only nesting the
//   parser bounds (expressions and queries 128 levels, statements 256), so every statement the parser accepts formats,
//   with one exception: right-nested joins (`a JOIN b JOIN c ON … ON …`), which the parser accepts at any depth. Past
//   about 1,000 levels (where their indented text would already take megabytes) such a statement can exceed the call
//   stack: it is then kept with its letter case or unchanged ('case' / 'unformatted' in kept), never changed.
// - Layout details (T-SQL, indentation based; 01 §1 gives the rules): the clauses that start a line are SELECT, INTO,
//   FROM, WHERE, GROUP BY, HAVING, ORDER BY, OFFSET, FETCH, FOR JSON, FOR XML, OPTION, SET, VALUES, OUTPUT and the set
//   operators of a statement's own query; the lists are the select list, GROUP BY, ORDER BY, SET, VALUES rows, DECLARE,
//   EXEC and sp_executesql arguments, FETCH … INTO variables, column definitions, WITH XMLNAMESPACES declarations and
//   function arguments. AND/OR chains break before the operator (an AND chain that starts an OR chain one level
//   deeper); + - & | ^ and * / % chains break before the operator when they do not fit; CASE breaks into WHEN/ELSE
//   lines (THEN on the next line when a WHEN does not fit); a chain of several postfix operators (xml methods, COLLATE,
//   AT TIME ZONE) that does not fit puts every operator after the first on an indented line (`@x.query('/a')` +
//   newline + `.value('.', 'int')`). Two narrower readings of 'each clause starts a line' and 'one item per line':
//   nested queries (subqueries, derived tables and CTE bodies)
//   stay inline, clauses included, when they fit, else open an indented block whose clauses start a line each and that
//   ends with ')' on its own line; IN lists of literals, variables and columns are filled (packed into full lines),
//   other IN lists break one item per line. BEGIN/END, TRY/CATCH, IF/ELSE and WHILE indent their bodies (BEGIN on its
//   own line under IF/WHILE/ELSE; ELSE IF stays on one line). A WITH clause puts each CTE (and the XMLNAMESPACES list)
//   on a line of its own and the statement on the next line. DECLARE … CURSOR … FOR stays on one line and the
//   cursor's query, its OPTION clause and FOR READ_ONLY follow, indented one level; OPEN, CLOSE, DEALLOCATE, FETCH,
//   GOTO and EXEC ( … ) are one line (FETCH's INTO list breaks like any list); a label is a line of its own (`retry:`,
//   no space before ':') and the statement after it starts the next line. Function names, xml methods, ROLLUP( and
//   CUBE( and the option words that are not reserved (FOR XML / FOR JSON `RAW('r')`, `PATH('')`, `ROOT('x')`; hints
//   such as `HINT('…')` and `BATCH_SIZE(10)`) have no space before '('; reserved keywords, GROUPING SETS and
//   XMLNAMESPACES have one (IN (, OVER (, VALUES (, EXEC (, OPTION (, WITH (NOLOCK), …). ROLLUP and CUBE are keywords
//   before '(' and after WITH (`GROUP BY a WITH ROLLUP`). A ';' run before a GO line (an empty batch) keeps a line of
//   its own, and one after a GO line starts the next line.
// - Comments, beyond the three rules of 01 §1 (which apply to line and block comments alike): a comment on the same
//   line gets a space before the next token (`CAST /* c */ (a AS INT)`); a comment on its own line is written before
//   the expression, parenthesis or CASE it precedes (which still stays on one line when it fits), and one before a
//   closing ')', END, END TRY, END CATCH or CASE's END is indented like that closer (rule 2), also when it is all a
//   CATCH block holds. When a comment puts the body of FROM, WHERE, HAVING, JOIN or ON on a line of its own (a comment
//   that ends the line of the keyword, or a comment on its own line before the body), the body and that comment are
//   indented one level under the keyword; an IF or WHILE condition is not (that is where the body goes). Rule 1: a
//   comment followed by a line break in the source ends its output line too (not before an identifier GO, see above).
//   Rule 3: the comments before a ',' or ';' move after it when it ends its line in the source (and they are on its
//   line), when it starts a later line (one of them is a line comment or ends its line), or when it ends its output
//   line (the same characters in another order, so the layout stays and a second pass agrees); the last of them then
//   ends the line. A comment on a line of its own before a ',' or ';' that ends its line stays there (rule 2). Where
//   rules 1 and 3 conflict with 'every comment is kept, in order', the order wins (`m -- c0` + newline + `, -- c1`
//   gives `m, -- c0` with `-- c1` on a line of its own after it). Block comments count towards the width wherever they
//   are, line comments do not; a list that starts right after a block comment ending its line breaks (so a second pass,
//   where the comment ends its line because the list broke, lays it out the same). Line comments lose trailing
//   spaces/tabs; block comments are kept verbatim. Up to one blank line between statements (and before comments between
//   them) is kept; blank lines inside a statement are removed.
// - Selection edges, beyond 01 §1: a text without a final line break keeps the comments before a final ';' run before
//   it; a lone CR is a line break too. A selection that starts or ends inside a line can still change that line
//   together with the text around it, which is why 03 §5 extends a selection to whole lines.

import { tokenize, RESERVED, SqlError } from './lexer.js';
import { parse, statementRanges } from './parser.js';
import { sqlIdent } from '../core/util.js';

// Default options (functionCase and typeCase follow keywordCase unless given).
export const FORMAT_DEFAULTS = Object.freeze({ indent: 4, width: 100, keywordCase: 'upper' });

const CASES = new Set(['upper', 'lower', 'preserve']);
// FETCH directions (01 §4.1 Cursors): keywords only before FROM (or, for ABSOLUTE and RELATIVE, before their n).
const FETCH_DIRS = new Set(['NEXT', 'PRIOR', 'FIRST', 'LAST', 'ABSOLUTE', 'RELATIVE']);
// Reserved words that are function names when '(' follows (no space before the parenthesis).
const CALLABLE = new Set(['LEFT', 'RIGHT', 'COALESCE', 'NULLIF', 'CONVERT', 'TRY_CONVERT', 'CONTAINS']);
// Reserved words after which '+', '-' and '~' are binary operators (the word ends an operand).
const OPERAND_KW = new Set(['END', 'NULL', 'CURRENT_TIMESTAMP', 'CURRENT_USER', 'SESSION_USER', 'SYSTEM_USER', 'USER',
  'CURRENT_DATE', 'CURRENT_TIME']);
const ADDITIVE = new Set(['+', '-', '&', '|', '^']);
const MULTIPLICATIVE = new Set(['*', '/', '%']);
// Non-reserved words that are keywords inside column definitions and table constraints.
const CONSTRAINT_KW = new Set(['NO', 'ACTION']);
const GROUPING_KW = new Set(['ROLLUP', 'CUBE', 'GROUPING', 'SETS']); // see Builder.genKind
// Identifier characters (letters, digits, _ @ # $, any non-ASCII except the lexer's white space NBSP and U+FEFF).
const WORD = /[\w@#$]|[^\x00-\x7f ﻿]/;
const GO_MAX = 100000; // GO counts outside 1..GO_MAX are errors (01 §4.1, the `go` row)

const isOpTok = (t, v) => !!t && t.t === 'op' && t.v === v;
const isKwTok = (t, k) => !!t && t.t === 'id' && t.k === k;
// An identifier token: a quoted identifier or a word that is not reserved (labels, cursor names).
const isIdentTok = t => !!t && (t.t === 'qid' || (t.t === 'id' && !RESERVED.has(t.k)));
// A postfix operator node (01 §4.4): COLLATE, `x AT TIME ZONE z` (fn AT_TIME_ZONE with postfix: true) or an xml
// method call.
const isPostfix = x => !!x && (x.type === 'collate' || x.type === 'xmlmethod' ||
  (x.type === 'fn' && x.name === 'AT_TIME_ZONE' && x.postfix === true));
// Line breaks: LF, CRLF, or a CR alone (the parser's GO rule also treats CR as a line end).
const isBreak = (s, k) => { const c = s.charCodeAt(k); return c === 10 || (c === 13 && s.charCodeAt(k + 1) !== 10); };

// ---------------------------------------------------------------------------------------------------------------
// Options

const OPTION_KEYS = ['indent', 'width', 'keywordCase', 'functionCase', 'typeCase', 'quotedIdentifier', 'displayNames'];

// The options as a plain object, each read once: a read that throws (a getter, a revoked Proxy) gives undefined, a
// missing value. `state` becomes {cmt, quote} or null.
function readOptions(opts) {
  const out = Object.create(null);
  if (!opts || typeof opts !== 'object') return out;
  const get = (x, k) => { try { return x[k]; } catch { return undefined; } };
  for (const k of OPTION_KEYS) out[k] = get(opts, k);
  const st = get(opts, 'state');
  out.state = st && typeof st === 'object' ? { cmt: get(st, 'cmt'), quote: get(st, 'quote') } : null;
  return out;
}

// The layout options of a readOptions() copy for src.
function options(o, src) {
  let unit = '    ';
  if (Number.isInteger(o.indent) && o.indent >= 1 && o.indent <= 8) unit = ' '.repeat(o.indent);
  else if (typeof o.indent === 'string' && /^[ \t]{1,8}$/.test(o.indent)) unit = o.indent;
  const width = Number.isInteger(o.width) && o.width >= 40 && o.width <= 400 ? o.width : 100;
  const kw = CASES.has(o.keywordCase) ? o.keywordCase : 'upper';
  // The indentation of the first line that is not blank (line breaks are LF, CRLF or a lone CR, as in isBreak).
  const first = /^(?:[ \t\f\v ]*(?:\r\n?|\n))*([ \t]*)/.exec(src);
  return {
    unit,
    width,
    kw,
    fn: CASES.has(o.functionCase) ? o.functionCase : kw,
    type: CASES.has(o.typeCase) ? o.typeCase : kw,
    base: first ? first[1] : '',
    eol: src.includes('\r\n') ? '\r\n' : '\n',
    // parse() and statementRanges() options: the query tab's QUOTED_IDENTIFIER mode (default ON).
    po: Object.freeze({ quotedIdentifier: typeof o.quotedIdentifier === 'boolean' ? o.quotedIdentifier : true }),
    names: typeof o.displayNames === 'function' ? o.displayNames : null,
  };
}

// True when the state (readOptions' copy of opts.state, the lexer.js tokenizeLine state where the text starts) says
// the text starts inside a block comment, a string or a quoted identifier. A tokenizeLine state is {cmt: a block
// comment nesting depth (a non-negative integer), quote: null} or {cmt: 0, quote: "'" | ']' | '"'}; anything else is
// invalid and uses the default, LINE0 (01 §1: nothing is clamped).
function startsInside(st) {
  if (!st) return false;
  const { cmt, quote } = st;
  if (!Number.isSafeInteger(cmt) || cmt < 0) return false;
  if (quote === null || quote === undefined) return cmt > 0;
  return cmt === 0 && (quote === "'" || quote === ']' || quote === '"');
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens and trivia: every significant token carries the comments before it (`pre`) and the number of line breaks
// between the last comment (or the previous token) and itself (`nl`). A run of U+FEFF in white space is kept as a
// comment entry with `ws: true` (written without spaces around it).

function prepare(src) {
  const all = tokenize(src, true);
  const T = [];
  let pre = [];
  let nl = 0;
  let ws = false; // white space since the last comment or token
  let open = Infinity;
  let leadNl = false;
  let endNl = 0;
  let endWs = false;
  let gos = 0;
  const comment = c => {
    if (pre.length) pre[pre.length - 1].nlAfter = nl > 0;
    pre.push(c);
    nl = 0;
    ws = false;
  };
  for (let n = 0; n < all.length; n++) {
    const t = all[n];
    if (t.open && open === Infinity) open = t.s;
    if (t.t === 'ws') {
      const v = t.v;
      for (let k = 0; k < v.length; k++) {
        if (v.charCodeAt(k) === 0xfeff) {
          let e = k + 1;
          while (e < v.length && v.charCodeAt(e) === 0xfeff) e++;
          comment({ text: v.slice(k, e), line: false, ws: true, nlBefore: nl, nlAfter: false, s: t.s + k });
          k = e - 1;
          continue;
        }
        ws = true;
        if (isBreak(v, k)) {
          nl++;
          if (n === 0 && !pre.length) leadNl = true;
        }
      }
      continue;
    }
    if (t.t === 'cmt') {
      comment({ text: t.v, line: t.v.startsWith('--'), nlBefore: nl, nlAfter: false, s: t.s });
      continue;
    }
    if (pre.length) pre[pre.length - 1].nlAfter = nl > 0;
    if (t.t === 'end') { endNl = nl; endWs = ws; }
    if (t.t === 'id' && t.k === 'GO') gos++;
    t.pre = pre;
    t.nl = nl;
    T.push(t);
    pre = [];
    nl = 0;
    ws = false;
  }
  const match = new Int32Array(T.length).fill(-1);
  const stack = [];
  for (let k = 0; k < T.length; k++) {
    const t = T[k];
    if (t.t !== 'op') continue;
    if (t.v === '(') stack.push(k);
    else if (t.v === ')' && stack.length) {
      const o = stack.pop();
      match[o] = k;
      match[k] = o;
    }
  }
  // The index of the token that starts at pos, else -1 (a binary search: T is in text order).
  const at = pos => {
    let lo = 0;
    let hi = T.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = T[mid].s;
      if (s === pos) return mid;
      if (s < pos) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  };
  return { all, T, match, at, open, leadNl, endNl, endWs, gos };
}

// GO separator lines (01 §4.5) of a keepAll token list: [{pos, count}] for each GO alone on its line, optionally
// followed by an integer count (`count` is its token) and comments. The same rule as the parser's batch split.
function goLinesOf(all) {
  const out = [];
  const hasBreak = t => t.t === 'ws' && /[\r\n]/.test(t.v);
  for (let k = 0; k < all.length; k++) {
    const t = all[k];
    if (t.t !== 'id' || t.k !== 'GO') continue;
    const prev = all[k - 1];
    if (prev && !(prev.t === 'ws' && (k === 1 || hasBreak(prev)))) continue;
    let j = k + 1;
    const skipWs = () => { while (all[j].t === 'ws' && !hasBreak(all[j])) j++; };
    skipWs();
    let count = null;
    if (all[j].t === 'num') {
      if (all[j].int !== true || !/^\d+$/.test(all[j].raw)) continue;
      count = all[j];
      j++;
      skipWs();
    }
    while (all[j].t === 'cmt') { j++; skipWs(); }
    if (all[j].t !== 'end' && !hasBreak(all[j])) continue;
    out.push({ pos: t.s, count });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Statement isolation helpers: fill text, statement ranges, declarations and labels.

// A failing statement's fill text: ';' first on each of its lines, then spaces (line breaks kept, so positions and GO
// lines stay valid).
const fillText = s => s.replace(/[^\r\n]+/g, m => ';' + ' '.repeat(m.length - 1));

// Words that can start a statement (the parser's tolerant splitter starts ranges at these, at '(' and after ';').
const STARTERS = new Set(('SELECT INSERT UPDATE DELETE DECLARE SET IF WHILE BEGIN END ELSE PRINT EXEC EXECUTE WITH CREATE ' +
  'DROP TRUNCATE RAISERROR WAITFOR RETURN BREAK CONTINUE MERGE REVERT USE COMMIT ROLLBACK SAVE GOTO THROW OPEN CLOSE ' +
  'FETCH DEALLOCATE ALTER GRANT DENY REVOKE DBCC BACKUP RESTORE').split(' '));

const WIN_MIN = 1024; // window size in characters after a failure; it doubles after each window that parses
const WIN_MAX = 65536;

// Variables declared by a statement (also inside blocks, IF/WHILE bodies and TRY/CATCH): [[name, kind]].
function declsOf(s, out) {
  const st = [s];
  while (st.length) {
    const x = st.pop();
    if (!x || typeof x !== 'object') continue;
    if (Array.isArray(x)) { for (let k = x.length - 1; k >= 0; k--) st.push(x[k]); continue; }
    switch (x.type) {
      case 'declare': for (const v of x.vars) out.push([v.name, v.table ? 'table' : 'scalar']); break;
      case 'block': st.push(x.body); break;
      case 'if': st.push(x.else, x.then); break;
      case 'while': st.push(x.body); break;
      case 'try': st.push(x.catch, x.body); break;
      default: break;
    }
  }
  return out;
}

// The values the SET QUOTED_IDENTIFIER statements of a statement set, in order: the statement itself and those of its
// BEGIN … END blocks (not of IF, WHILE, TRY or CATCH bodies), which parse() counts for the next batch (01 §4.1).
function modeSets(s, out) {
  if (s.type === 'setopt' && s.name === 'QUOTED_IDENTIFIER') out.push(s.value);
  else if (s.type === 'block') for (const x of s.body) modeSets(x, out);
  return out;
}

// The QUOTED_IDENTIFIER mode parse() reads the batch after `stmts` (a batch read in mode qi) with.
function modeAfter(stmts, qi) {
  let m = qi;
  for (const s of stmts) for (const v of modeSets(s, [])) m = v;
  return m;
}

// Label definitions (`name:`) and GOTO targets of a token list: {defs: Map lower-case name -> [{s, text, name}] in
// text order, list: every definition in text order, gotos: [{s, name, text}] in text order (s: the target's offset)}.
function labelsOf(src, T) {
  const defs = new Map();
  const list = [];
  const gotos = [];
  for (let k = 0; k + 1 < T.length; k++) {
    const t = T[k];
    const n = T[k + 1];
    if (isIdentTok(t) && isOpTok(n, ':')) {
      const name = t.v.toLowerCase();
      const d = { s: t.s, text: src.slice(t.s, t.e), name };
      if (!defs.has(name)) defs.set(name, []);
      defs.get(name).push(d);
      list.push(d);
    } else if (isKwTok(t, 'GOTO') && isIdentTok(n)) {
      gotos.push({ s: n.s, name: n.v.toLowerCase(), text: src.slice(n.s, n.e) });
    }
  }
  return { defs, list, gotos };
}

// Index of the last token of T (in text order) that starts before pos, else -1.
function lastBefore(T, pos) {
  let lo = 0;
  let hi = T.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (T[mid].s < pos) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// Index of the last range of `list` (sorted by start) that starts at or before p, else -1.
function rangeAtOrBefore(list, p) {
  let lo = 0;
  let hi = list.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= p) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// The offset where the line holding offset p starts (after LF, CRLF or a lone CR).
function lineStart(s, p) {
  let k = p;
  while (k > 0 && s.charCodeAt(k - 1) !== 10 && s.charCodeAt(k - 1) !== 13) k--;
  return k;
}

// statementRanges(src, po), with a cursor variable assignment `SET @c = CURSOR [options] FOR <query> [FOR UPDATE
// [OF …]]` as one range: it is one statement (01 §4.1 Cursors, refused at parse time), but the tolerant splitter can
// end a range at the cursor's FOR when the query starts with SELECT or WITH, and at the FOR of its FOR UPDATE. A
// range that ends with the cursor's FOR (only option words between CURSOR and FOR) takes the next range of its batch
// when that starts with SELECT or WITH, and the joined range takes one that starts with UPDATE after a final FOR.
function rangesOf(src, prep, po) {
  const T = prep.T;
  const out = [];
  let cursorQuery = false; // the last range of out is a cursor's FOR joined with its query
  for (const r of statementRanges(src, po)) {
    const last = out[out.length - 1];
    if (last && last.batch === r.batch) {
      const z = lastBefore(T, last.end);
      const first = T[prep.at(r.start)];
      if (z >= 0 && isKwTok(T[z], 'FOR') && first) {
        let k = z - 1;
        while (k >= 0 && T[k].s >= last.start && T[k].t === 'id' && T[k].k !== 'CURSOR') k--;
        const query = k >= 0 && T[k].s >= last.start && isKwTok(T[k], 'CURSOR') &&
          (isKwTok(first, 'SELECT') || isKwTok(first, 'WITH'));
        if (query || (cursorQuery && isKwTok(first, 'UPDATE'))) {
          out[out.length - 1] = { start: last.start, end: r.end, batch: r.batch };
          cursorQuery = query;
          continue;
        }
      }
    }
    out.push(r);
    cursorQuery = false;
  }
  return out;
}

// Index of the first entry of a list sorted by s whose s is at least p (list.length when none).
function firstAtOrAfter(list, p) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].s < p) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------------------------------
// Batch context. A text formatted on its own (a selection, or the statement at the caret: 03 §5) is a piece of a
// script whose earlier lines may declare its variables, define the labels its GOTOs jump to, and hold it inside a
// CATCH block (a bare THROW) or a WHILE body (BREAK, CONTINUE). parse() checks these per batch (137, 1087, 133, 10704,
// 135, 136; 00 §2): they are about that context, not about the text's syntax. So the first batch of the
// text is parsed in the context it lacks: a prelude declares the variables it uses and never declares and defines the
// labels it jumps to and never defines, and when a THROW, BREAK or CONTINUE needs them, a CATCH block and a WHILE body
// go around it. The batches after a GO line start inside the text, which then holds their whole context.

// Statement keywords that never occur in a DECLARE list (END and ELSE also end CASE expressions and IF branches).
const HARD_STARTERS = new Set([...STARTERS].filter(k => k !== 'END' && k !== 'ELSE'));
// Words after which a variable is a table source or target (after INTO, unless the statement is a FETCH … INTO).
const TABLE_BEFORE = new Set(['FROM', 'JOIN', 'APPLY', 'UPDATE', 'DELETE', 'INSERT', 'INTO']);
// Words that end a FROM list at its depth (after them a ',' no longer separates table sources; after a join's ON
// condition it still does).
const FROM_ENDS = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'UNION', 'EXCEPT', 'INTERSECT', 'OPTION', 'FOR', 'OUTPUT',
  'WINDOW']);
// The CATCH block and WHILE body around a first batch. An empty TRY or block body does not parse, hence the PRINTs;
// the tail starts a line of its own, so a line comment at the end of the batch never takes it in.
const WRAP_HEAD = 'BEGIN TRY PRINT 0 END TRY BEGIN CATCH WHILE 1 = 1 BEGIN PRINT 0;';
const WRAP_TAIL = '\nEND END CATCH';

// The context of a first batch, the tokens of T before `stop` (its GO line, or the end of what is analysed): {vars:
// Map lower-case name -> {text, kind: 'scalar' | 'table', fixed}, the variables it uses and never declares, with the
// kind of their first use; declared: the names it may declare; labels: Map lower-case name -> text, the labels its
// GOTOs jump to and it never defines; wrapOk: its BEGIN/CASE and END words pair up, so the CATCH block and WHILE body
// stay around all of it; wrap: false until a THROW, BREAK or CONTINUE needs them; cut: where the batch ends (the
// start of its GO line's line)}. The scan errs towards 'declared' (a variable right after DECLARE, or after a ',' of a
// DECLARE list): the prelude never declares such a name, so a variable used before its DECLARE stays an error (137)
// and no DECLARE becomes a second one (134).
function contextOf(src, T, labels, stop, cut) {
  const vars = new Map();
  const declared = new Set();
  let depth = 0;
  let top = null; // the statement keyword the tokens at depth 0 belong to
  let from = -1; // the depth of the FROM list being read (its ',' separate table sources), else -1
  let open = 0;
  let paired = true;
  for (let k = 0; k < T.length && T[k].s < stop; k++) {
    const t = T[k];
    if (t.t === 'op') {
      if (t.v === '(') depth++;
      else if (t.v === ')') { if (depth > 0) depth--; if (from > depth) from = -1; }
      else if (t.v === ';') { depth = 0; top = null; from = -1; } // a ';' never occurs inside parentheses
      continue;
    }
    if (t.t === 'id') {
      if (t.k === 'BEGIN' || t.k === 'CASE') open++;
      else if (t.k === 'END' && --open < 0) paired = false;
      if (t.k === 'DECLARE') { depth = 0; top = 'DECLARE'; from = -1; } // nor does DECLARE
      else if (depth === 0 && HARD_STARTERS.has(t.k)) top = t.k;
      if (t.k === 'FROM') from = depth;
      else if (from === depth && (FROM_ENDS.has(t.k) || HARD_STARTERS.has(t.k))) from = -1;
      continue;
    }
    if (t.t !== 'var' || t.v.length < 2 || t.v.length > 128 || t.v.startsWith('@@')) continue;
    const p = k > 0 ? T[k - 1] : null;
    if (isKwTok(p, 'DECLARE') || (isOpTok(p, ',') && depth === 0 && top === 'DECLARE')) { declared.add(t.v); continue; }
    if (vars.has(t.v)) continue;
    const table = !!p && ((p.t === 'id' && TABLE_BEFORE.has(p.k) && !(p.k === 'INTO' && top === 'FETCH')) || (isOpTok(p, ',') && from === depth));
    vars.set(t.v, { text: src.slice(t.s, t.e), kind: table ? 'table' : 'scalar', fixed: false });
  }
  for (const v of declared) vars.delete(v);
  const defined = new Set();
  for (const d of labels.list) {
    if (d.s >= stop) break;
    defined.add(d.name);
  }
  const lbl = new Map();
  for (const g of labels.gotos) {
    if (g.s >= stop) break;
    // A label in double quotes is a string while QUOTED_IDENTIFIER is OFF: such a GOTO keeps its own error.
    if (!defined.has(g.name) && !lbl.has(g.name) && g.text[0] !== '"') lbl.set(g.name, g.text);
  }
  return { vars, declared, labels: lbl, wrapOk: paired && open === 0, wrap: false, cut };
}

// A DECLARE entry for a context variable.
const varDecl = (text, kind) => text + (kind === 'table' ? ' TABLE (x INT)' : ' INT');

// The prelude of a first batch read in context ctx: its labels defined and its variables declared ('' when none).
function ctxPrelude(ctx) {
  let out = '';
  for (const text of ctx.labels.values()) out += text + ': ';
  const decls = [];
  for (const v of ctx.vars.values()) decls.push(varDecl(v.text, v.kind));
  if (decls.length) out += 'DECLARE ' + decls.join(', ');
  return out ? out + ';' : '';
}

// Adjusts ctx after error e of a parse of `text` in that context (its first batch ends at `cut`): a variable used with
// the other kind than its first use suggested is declared with that kind (once); one the text declares itself after
// all (134) is no longer declared by the prelude; a THROW, BREAK or CONTINUE outside a CATCH block or WHILE body puts
// the batch inside both. False when e is not about the context: the text itself does not parse.
function learn(ctx, e, text, cut) {
  const p = e.pos;
  if (p == null || p >= cut) return false;
  const n = e.number;
  if (n === 137 || n === 1087 || n === 134) {
    const name = text.slice(p, e.end ?? p).toLowerCase();
    const v = ctx.vars.get(name);
    if (!v) return false;
    if (n === 134) {
      ctx.vars.delete(name);
      ctx.declared.add(name);
      return true;
    }
    const kind = n === 1087 ? 'table' : 'scalar';
    if (v.kind === kind || v.fixed) return false;
    v.kind = kind;
    v.fixed = true;
    return true;
  }
  if ((n === 10704 || n === 135 || n === 136) && ctx.wrapOk && !ctx.wrap) {
    ctx.wrap = true;
    return true;
  }
  return false;
}

// Moves the numeric pos and end of every object reachable from roots by `by` (each object once).
function shiftAll(roots, by) {
  const seen = new WeakSet();
  const st = [roots];
  while (st.length) {
    const x = st.pop();
    if (seen.has(x) || Object.isFrozen(x) || x instanceof Set || x instanceof Map) continue;
    seen.add(x);
    if (Array.isArray(x)) {
      for (const y of x) if (y !== null && typeof y === 'object') st.push(y);
      continue;
    }
    for (const k of Object.keys(x)) {
      const v = x[k];
      if (typeof v === 'number') { if (k === 'pos' || k === 'end') x[k] = v + by; }
      else if (v !== null && typeof v === 'object') st.push(v);
    }
  }
}

// The statements of a parse that start at or after `from`, their positions moved by `by` (deep: every node; else the
// statements' own, which is all the windows and the verification read), with the parse warnings at or after `from`.
function moved(stmts, warnings, from, by, deep) {
  const out = stmts.filter(s => s.pos >= from);
  if (deep) shiftAll(out, by);
  else for (const s of out) { s.pos += by; s.end += by; }
  out.warnings = [];
  for (const w of warnings) if (w.pos >= from) out.warnings.push({ ...w, pos: w.pos + by, end: w.end + by });
  return out;
}

// Maps the position of SqlError e with f (null: in text that was added) and returns e.
function shifted(e, f) {
  if (e instanceof SqlError && e.pos != null) {
    const p = f(e.pos);
    const q = e.end == null ? null : f(e.end);
    e.pos = p;
    e.end = p == null ? null : Math.max(p, q ?? p);
  }
  return e;
}

// parse() of `text` with `pre` in front of it and, with `wrap`, its first batch (the text before `cut`) inside the
// CATCH block and WHILE body of WRAP_HEAD … WRAP_TAIL; the later batches are then parsed apart, at their own offsets
// (the first batch blanked out, its line breaks kept) and in the QUOTED_IDENTIFIER mode the first batch leaves.
// Positions in the result and in a thrown SqlError are offsets of text: an error in the added text has pos null, and
// one in WRAP_TAIL (where the first batch did not end) is at cut.
function parseWith(text, po, pre, wrap, cut, deep) {
  if (!wrap) {
    if (!pre) return parse(text, po);
    const n = pre.length;
    let out;
    try {
      out = parse(pre + text, po);
    } catch (e) {
      throw shifted(e, p => (p < n ? null : p - n));
    }
    return moved(out, out.warnings, n, -n, deep);
  }
  const head = WRAP_HEAD + pre;
  const n = head.length;
  const c = Math.min(cut, text.length);
  let a;
  try {
    a = parse(head + text.slice(0, c) + WRAP_TAIL, po);
  } catch (e) {
    throw shifted(e, p => (p < n ? null : Math.min(p - n, c)));
  }
  const t = a.length === 1 && a[0].type === 'try' ? a[0] : null;
  const w = t && t.catch.length === 1 && t.catch[0].type === 'while' ? t.catch[0] : null;
  const b = w && w.body.type === 'block' ? w.body : null;
  if (!b || b.end !== n + c + 4 || t.end !== n + c + WRAP_TAIL.length) throw new SqlError('Incorrect syntax near the end of the batch.', c, c);
  const out = moved(b.body, a.warnings, n, -n, deep); // PRINT 0 and the prelude start before n
  if (c < text.length) {
    const r = parse(text.slice(0, c).replace(/[^\r\n]/g, ' ') + text.slice(c), { quotedIdentifier: modeAfter(out, po.quotedIdentifier) });
    for (const s of r) out.push(s);
    for (const x of r.warnings) out.warnings.push(x);
  }
  return out;
}

// parseWith() of text whose first batch is read in context ctx (null: none) with the prelude mkPre() gives, learning
// from the errors that are about the context (learn) and parsing again; throws the first error that is not.
function parseIn(text, po, ctx, cut, mkPre, deep) {
  const max = ctx ? 2 * ctx.vars.size + 2 : 0;
  for (let k = 0; ; k++) {
    try {
      return parseWith(text, po, mkPre(), !!ctx && ctx.wrap, cut, deep);
    } catch (e) {
      if (!(e instanceof SqlError) || !ctx || k >= max || !learn(ctx, e, text, cut)) throw e;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Statement isolation: a statement that fails is replaced by its fill text until the rest parses. From an
// unterminated token on, the text is cut off.

// Finds the statements that do not parse: {stmts (parse of the filled text in its batch context, every position an
// offset of src), failing ([{start, end}], one per failing statement), goFails, tail, text (the filled text), ctx}.
// A text that parses as a whole is parsed once. Otherwise the statements before the range of the first error are
// accepted from one parse of that prefix, and from there each GO batch is parsed in windows of consecutive statement
// ranges, one text per window: a prelude defines the labels that GOTOs of the window jump to and the batch defines
// outside the window (parse() resolves GOTO targets per batch, 01 §4.1) and declares the variables the window uses
// that accepted statements of the batch declared (00 §2: variables are checked per batch), then come the window's
// source text and ' ;' (so truncation never makes a GO line), all read in the QUOTED_IDENTIFIER mode the accepted
// statements of the batches before give the batch, and the first batch in its context. A window that does not
// end its segment (the batch end, or a failing statement, which the fill ends with ';') treats its last range as a
// lookahead: only the statements before it are accepted, and only when a statement starts exactly there; an error
// inside the lookahead grows the window. An error elsewhere marks its range as failing (the range that contains it,
// else the last one before it), and the ranges before it are parsed again up to it. Then the GOTOs that windows could
// not check are checked in one pass (labelPass), and the filled text is parsed once; when that still fails, the
// remaining errors are filled one at a time.
function analyze(src, prep, po) {
  let ranges = null;
  let tail = prep.open;
  if (tail < Infinity) {
    // The unterminated token and the statement it belongs to: the one that contains it, or the one that ends on its
    // line right before it without ';' (`select a, /* b`).
    ranges = rangesOf(src, prep, po);
    const r = ranges.findLast(x => x.start < tail);
    if (r && (tail < r.end || !/[\r\n;]/.test(src.slice(r.end, tail)))) tail = r.start;
  }
  const end = tail < Infinity ? tail : src.length;
  const goLines = goLinesOf(prep.all).filter(g => g.pos < end);
  const goFails = [];
  for (const g of goLines) {
    const c = g.count;
    if (c && (c.v < 1 || c.v > GO_MAX)) goFails.push({ pos: g.pos, end: c.e, cs: c.s });
  }
  // The text with bad GO counts replaced by a valid count of the same length, and the failing ranges filled.
  const build = (failing = []) => {
    const edits = failing.map(r => ({ s: r.start, e: r.end, rep: null }));
    for (const g of goFails) edits.push({ s: g.cs, e: g.end, rep: '0'.repeat(g.end - g.cs - 1) + '1' });
    edits.sort((a, b) => a.s - b.s);
    const parts = [];
    let at = 0;
    for (const x of edits) {
      parts.push(src.slice(at, x.s), x.rep ?? fillText(src.slice(x.s, x.e)));
      at = x.e;
    }
    parts.push(src.slice(at, end));
    return parts.join('');
  };
  const T = prep.T;
  const labels = labelsOf(src, T);
  const goAt = goLines.length ? goLines[0].pos : Infinity;
  const ctx = contextOf(src, T, labels, Math.min(goAt, end), goAt < Infinity ? lineStart(src, goAt) : Infinity);
  const ctxPre = () => ctxPrelude(ctx);
  const parseText = (text, deep) => parseIn(text, po, ctx, ctx.cut, ctxPre, deep);
  const whole = build();
  let first;
  try {
    return { stmts: parseText(whole, true), failing: [], goFails, tail, text: whole, ctx };
  } catch (e) {
    if (!(e instanceof SqlError)) return null;
    first = e;
  }
  const live = (ranges ?? rangesOf(src, prep, po)).filter(r => r.start < tail);
  const failed = new Uint8Array(live.length);
  const glue = new Uint8Array(live.length); // range k fails as one statement with range k - 1
  // A failing piece that cannot start a statement and continues the line of the statement before it, with no ';'
  // between them (`select 1 ? 2` splits into `select 1` and `? 2`), belongs to that statement: it fails too. A label
  // (`name:`) starts a statement.
  const joinPrev = k => {
    const r = live[k];
    const prev = k > 0 ? live[k - 1] : null;
    if (!prev || prev.batch !== r.batch || failed[k - 1]) return false;
    const x = prep.at(r.start);
    const t = T[x];
    const starts = t && ((t.t === 'id' && STARTERS.has(t.k)) || isOpTok(t, '(') || isOpTok(t, ';') ||
      (isIdentTok(t) && isOpTok(T[x + 1], ':')));
    return !starts && !/[\r\n;]/.test(src.slice(prev.end, r.start));
  };

  const vars = new Map(); // variable -> 'scalar' | 'table', declared by the accepted statements of the batch
  const declBy = new Map(); // range index -> the variables its statement declared
  const setsBy = new Map(); // range index -> the QUOTED_IDENTIFIER values its statement sets for the next batch
  let batchLo = 0; // the ranges of the batch being scanned, and its QUOTED_IDENTIFIER mode
  let batchHi = 0;
  let batchQi = true;

  // `name:` for each label that a GOTO between a and z jumps to and that the batch defines outside a..z only, or (in
  // the first batch) never defines (the label pass and the final parse of the whole text check every GOTO: 133,
  // 1026, 132).
  const labelPrelude = (a, z) => {
    const g0 = firstAtOrAfter(labels.gotos, a);
    if (g0 >= labels.gotos.length || labels.gotos[g0].s >= z) return '';
    const bs = live[batchLo].start;
    const be = live[batchHi - 1].end;
    const b0 = live[batchLo].batch === 0;
    const out = [];
    const seen = new Set();
    for (let g = g0; g < labels.gotos.length && labels.gotos[g].s < z; g++) {
      const name = labels.gotos[g].name;
      if (seen.has(name)) continue;
      seen.add(name);
      if (b0 && ctx.labels.has(name)) { out.push(ctx.labels.get(name) + ': '); continue; }
      const defs = labels.defs.get(name);
      if (!defs) continue;
      const d0 = firstAtOrAfter(defs, bs);
      let inside = false;
      let outside = null;
      for (let d = d0; d < defs.length && defs[d].s < be; d++) {
        if (defs[d].s >= a && defs[d].s < z) inside = true;
        else outside ??= defs[d];
      }
      if (outside && !inside) out.push(outside.text + ': ');
    }
    return out.join('');
  };

  // Parses ranges i..j: {ok, stmts (statement positions relative to `off`), off} or {ok: false, m (failing range, -1
  // when the error has no usable position)}; null for an error that is not a SqlError.
  const parseWin = (i, j) => {
    const a = live[i].start;
    const z = live[j].end;
    const b0 = live[i].batch === 0;
    const used = new Map(); // lower-case name -> spelling
    for (let k = Math.max(0, prep.at(a)); k < T.length && T[k].s < z; k++) {
      const t = T[k];
      if (t.t === 'var' && !used.has(t.v) && (vars.has(t.v) || (b0 && ctx.vars.has(t.v)))) used.set(t.v, src.slice(t.s, t.e));
    }
    const mkPre = () => {
      const decls = [];
      for (const [v, text] of used) {
        const kind = vars.get(v) ?? (b0 && ctx.vars.has(v) ? ctx.vars.get(v).kind : null);
        if (kind) decls.push(varDecl(text, kind));
      }
      return labelPrelude(a, z) + (decls.length ? 'DECLARE ' + decls.join(', ') + ';' : ';');
    };
    const text = src.slice(a, z) + ' ;';
    try {
      return { ok: true, stmts: parseIn(text, { quotedIdentifier: batchQi }, b0 ? ctx : null, text.length, mkPre, false), off: a };
    } catch (e) {
      if (!(e instanceof SqlError)) return null;
      if (e.pos == null) return { ok: false, m: -1 };
      const p = e.pos + a;
      let m = i;
      while (m < j && live[m + 1].start <= p) m++;
      return { ok: false, m };
    }
  };

  // Accepts the statements (positions relative to off) that start from range i on and before `limit`: their DECLAREs
  // declare variables of the batch, their SET QUOTED_IDENTIFIER statements set the next batch's mode.
  const accept = (i, stmts, off, limit) => {
    let k = i;
    for (const s of stmts) {
      const p = s.pos + off;
      if (p < live[i].start) continue;
      if (p >= limit) break;
      while (k + 1 < live.length && live[k + 1].start <= p) k++;
      for (const [v, kind] of declsOf(s, [])) {
        vars.set(v, kind);
        if (!declBy.has(k)) declBy.set(k, []);
        declBy.get(k).push(v);
      }
      const sets = modeSets(s, []);
      if (sets.length) {
        if (!setsBy.has(k)) setsBy.set(k, []);
        for (const v of sets) setsBy.get(k).push(v);
      }
    }
  };

  // Scans the batch batchLo..batchHi from range `from` on (the ranges before it are accepted).
  const scanBatch = from => {
    const lo = batchLo;
    const hi = batchHi;
    const ends = []; // failing range indices ahead of i, nearest on top: each ends a segment
    let i = from;
    let budget = WIN_MIN;
    let minJ = 0; // the window must reach this range (it grows after a lookahead error)
    let single = -1; // ranges up to this one are parsed one at a time (an error without a usable position)
    while (i < hi) {
      const seg = ends.length ? ends[ends.length - 1] : hi;
      if (i >= seg) { ends.pop(); i = seg + 1; minJ = 0; continue; }
      let j = i;
      if (i > single) while (j + 1 < seg && (j === i || j < minJ || live[j].end - live[i].start < budget)) j++;
      const last = j + 1 === seg || i <= single;
      const res = parseWin(i, j);
      if (!res) return false;
      if (res.ok) {
        if (!last && !res.stmts.some(s => s.pos + res.off === live[j].start)) {
          minJ = j + 1;
          budget = 2 * (live[j].end - live[i].start);
          continue;
        }
        const upto = last ? j + 1 : j;
        accept(i, res.stmts, res.off, upto < seg ? live[upto].start : Infinity);
        i = upto;
        minJ = 0;
        budget = Math.min(2 * budget, WIN_MAX);
        continue;
      }
      let m = res.m;
      if (m < 0) {
        if (i > single) { single = j; continue; }
        m = i;
      }
      if (m === j && !last) {
        minJ = j + 1;
        budget = 2 * (live[j].end - live[i].start);
        continue;
      }
      failed[m] = 1;
      ends.push(m);
      if (m > lo && joinPrev(m)) {
        failed[m - 1] = 1;
        glue[m] = 1;
        for (const v of declBy.get(m - 1) ?? []) vars.delete(v);
        if (m - 1 >= i) ends.push(m - 1);
      }
      budget = WIN_MIN;
      minJ = 0;
    }
    return true;
  };

  // The mode of the batch after lo..hi (read in mode qi): the last value its accepted statements set.
  const modeEnd = (lo, hi, qi) => {
    let m = qi;
    for (let k = lo; k < hi; k++) if (!failed[k]) for (const v of setsBy.get(k) ?? []) m = v;
    return m;
  };

  // The statements before range m0, from one parse of that prefix (the whole parse got past them): Map batch index ->
  // statements, or null when the prefix does not parse on its own. The labels that GOTOs before the cut jump to and
  // that the cut batch defines only after it are defined at the end of the prefix.
  const prefixOf = m0 => {
    const cutAt = live[m0].start;
    const bm = live[m0].batch;
    let lo = m0;
    while (lo > 0 && live[lo - 1].batch === bm) lo--;
    let hi = m0;
    while (hi < live.length && live[hi].batch === bm) hi++;
    const bs = live[lo].start;
    const be = live[hi - 1].end;
    const extra = [];
    const seen = new Set();
    for (let g = firstAtOrAfter(labels.gotos, bs); g < labels.gotos.length && labels.gotos[g].s < cutAt; g++) {
      const name = labels.gotos[g].name;
      if (seen.has(name)) continue;
      seen.add(name);
      const defs = labels.defs.get(name) ?? [];
      let before = false;
      let after = null;
      for (let d = firstAtOrAfter(defs, bs); d < defs.length && defs[d].s < be; d++) {
        if (defs[d].s < cutAt) before = true;
        else after ??= defs[d];
      }
      if (after && !before) extra.push(after.text + ': ');
    }
    const text = whole.slice(0, cutAt) + ' ;' + extra.join('');
    let stmts;
    try {
      stmts = parseIn(text, po, ctx, Math.min(ctx.cut, text.length), ctxPre, false);
    } catch {
      return null;
    }
    const out = new Map();
    let b = 0;
    for (const s of stmts) {
      if (s.pos >= cutAt) break;
      if (s.type === 'go') { b++; continue; }
      if (!out.has(b)) out.set(b, []);
      out.get(b).push(s);
    }
    return out;
  };

  // The variables the DECLAREs of ranges lo..hi-1 declare, from their tokens (as declsOf() finds them in the AST: a
  // variable right after DECLARE or after a ',' of a DECLARE list; a table variable when TABLE follows it).
  const declare = (lo, hi) => {
    let k = lo;
    let depth = 0;
    let top = null;
    for (let x = Math.max(0, prep.at(live[lo].start)); x < T.length && T[x].s < live[hi - 1].end; x++) {
      const t = T[x];
      if (t.t === 'op') {
        if (t.v === '(') depth++;
        else if (t.v === ')') { if (depth > 0) depth--; }
        else if (t.v === ';') { depth = 0; top = null; }
        continue;
      }
      if (t.t === 'id') {
        if (t.k === 'DECLARE') { depth = 0; top = 'DECLARE'; }
        else if (depth === 0 && HARD_STARTERS.has(t.k)) top = t.k;
        continue;
      }
      if (t.t !== 'var' || t.v.startsWith('@@')) continue;
      const p = T[x - 1];
      if (!(isKwTok(p, 'DECLARE') || (isOpTok(p, ',') && depth === 0 && top === 'DECLARE'))) continue;
      while (k + 1 < hi && live[k + 1].start <= t.s) k++;
      const n = isKwTok(T[x + 1], 'AS') ? T[x + 2] : T[x + 1];
      vars.set(t.v, isKwTok(n, 'TABLE') ? 'table' : 'scalar');
      if (!declBy.has(k)) declBy.set(k, []);
      declBy.get(k).push(t.v);
    }
  };

  // The statements before the range of the first error parse as they are (the whole parse got past them): they are
  // accepted as they are, their variables from their tokens. Only when one of them may set QUOTED_IDENTIFIER are
  // they parsed (prefixOf), for the mode of the batches after them; when that fails, every batch is scanned from its
  // start.
  const m0 = first.pos == null ? 0 : Math.max(0, rangeAtOrBefore(live, first.pos));
  let modes = false;
  for (let x = 0; m0 > 0 && x < T.length && T[x].s < live[m0].start; x++) if (T[x].t === 'id' && T[x].k === 'QUOTED_IDENTIFIER') { modes = true; break; }
  const pre = m0 > 0 && modes ? prefixOf(m0) : null;
  const skip = m0 > 0 && (!modes || pre !== null);
  let qi = po.quotedIdentifier;
  for (let lo = 0; lo < live.length;) {
    let hi = lo + 1;
    while (hi < live.length && live[hi].batch === live[lo].batch) hi++;
    vars.clear();
    batchLo = lo;
    batchHi = hi;
    batchQi = qi;
    let from = lo;
    if (skip && live[lo].batch <= live[m0].batch) {
      const last = live[lo].batch === live[m0].batch;
      if (pre) accept(lo, pre.get(live[lo].batch) ?? [], 0, live[m0].start);
      else if (last && m0 > lo) declare(lo, m0);
      from = last ? m0 : hi;
    }
    if (!scanBatch(from)) return null;
    qi = modeEnd(lo, hi, qi);
    lo = hi;
  }

  // The GOTO checks the windows and the whole parse left (parse() resolves labels after the whole batch, 01 §4.1): a
  // GOTO whose label is defined only in failing statements (133) or inside a TRY or CATCH block that does not hold the
  // GOTO (1026) fails, and so does each later definition of a label in another statement (132); a statement that fails
  // takes its definitions with it. A worklist keeps this linear (01 §1) however many GOTOs depend on failing
  // statements.
  const labelPass = () => {
    if (!labels.list.length && !labels.gotos.length) return;
    const at = p => {
      const k = rangeAtOrBefore(live, p);
      return k >= 0 && p < live[k].end ? k : -1;
    };
    // Definitions and GOTO targets in text order, each with its range and the TRY/CATCH blocks around it inside its
    // statement: a chain of nodes {up} (null at its top level).
    const ev = [];
    for (const d of labels.list) ev.push({ s: d.s, name: d.name, def: true, r: -1, scope: null });
    for (const g of labels.gotos) ev.push({ s: g.s, name: g.name, def: false, r: -1, scope: null });
    ev.sort((a, b) => a.s - b.s);
    let r0 = -1;
    let x = 0;
    let scope = null;
    for (const e of ev) {
      e.r = at(e.s);
      if (e.r < 0) continue;
      if (e.r !== r0) { r0 = e.r; scope = null; x = Math.max(0, prep.at(live[e.r].start)); }
      for (; x < T.length && T[x].s < e.s; x++) {
        if (!(isKwTok(T[x + 1], 'TRY') || isKwTok(T[x + 1], 'CATCH'))) continue;
        if (isKwTok(T[x], 'BEGIN')) scope = { up: scope };
        else if (isKwTok(T[x], 'END') && scope) scope = scope.up;
      }
      e.scope = scope;
    }
    // True when the blocks around a definition (ds) also hold the GOTO (gs).
    const holds = (ds, gs) => {
      if (!ds) return true;
      for (let s = gs; s; s = s.up) if (s === ds) return true;
      return false;
    };
    const entries = new Map(); // batch and name -> {defs: [{r, scope}], gotos: [{r, scope}], first}
    const byRange = new Map(); // range index -> the entries it defines labels of
    for (const e of ev) {
      if (e.r < 0 || (!e.def && live[e.r].batch === 0 && ctx.labels.has(e.name))) continue;
      const key = live[e.r].batch + ':' + e.name;
      let en = entries.get(key);
      if (!en) { en = { defs: [], gotos: [], first: 0 }; entries.set(key, en); }
      if (e.def) {
        en.defs.push(e);
        if (!byRange.has(e.r)) byRange.set(e.r, []);
        byRange.get(e.r).push(en);
      } else {
        en.gotos.push(e);
      }
    }
    const work = [];
    const failRange = r => { if (!failed[r]) { failed[r] = 1; work.push(r); } };
    // The GOTOs to a label against its first definition in a statement that does not fail.
    const check = en => {
      while (en.first < en.defs.length && failed[en.defs[en.first].r]) en.first++;
      const d = en.defs[en.first];
      for (const g of en.gotos) if (!failed[g.r] && (!d || !holds(d.scope, g.scope))) failRange(g.r);
    };
    const drain = () => {
      while (work.length) {
        const r = work.pop();
        for (const en of byRange.get(r) ?? []) if (en.first < en.defs.length && en.defs[en.first].r === r) check(en);
      }
    };
    for (const en of entries.values()) check(en);
    drain();
    // A second definition in the same statement fails in its window or in the whole parse already (132 is raised
    // where it is read).
    for (const en of entries.values()) {
      if (en.first >= en.defs.length) continue;
      const r1 = en.defs[en.first].r;
      for (let k = en.first + 1; k < en.defs.length; k++) if (en.defs[k].r !== r1) failRange(en.defs[k].r);
    }
    drain();
  };
  labelPass();

  const failingNow = () => live.filter((r, k) => failed[k]);
  // The range an error at p belongs to (not yet failing): the one containing p, else the last one starting before p,
  // else the first.
  const blame = p => {
    const k = rangeAtOrBefore(live, p);
    for (let j = k; j >= 0; j--) if (!failed[j]) return j;
    for (let j = Math.max(k, 0); j < live.length; j++) if (!failed[j]) return j;
    return -1;
  };
  // A statement that spans a failing range (an IF whose ELSE comes after it) fails with every range it covers, as one
  // statement.
  const spanning = stmts => {
    let changed = false;
    let k = 0;
    for (const s of stmts) {
      while (k < live.length && live[k].end <= s.pos) k++;
      let j = k;
      let any = false;
      while (j < live.length && live[j].start < s.end) { if (failed[j]) any = true; j++; }
      if (any) {
        for (let y = k; y < j; y++) {
          if (!failed[y]) { failed[y] = 1; changed = true; }
          if (y > k && !glue[y]) { glue[y] = 1; changed = true; }
        }
      }
      k = j;
    }
    return changed;
  };
  // The failing statements: runs of failing ranges joined by glue, or continuing the line of a failing range of
  // their batch without ';' between them (the tolerant splitter starts a range at every statement keyword, so the
  // DELETE of `MERGE … THEN DELETE` is a range of its own).
  const groups = () => {
    const out = [];
    let last = -2;
    for (let k = 0; k < live.length; k++) {
      if (!failed[k]) continue;
      const join = last === k - 1 && (glue[k] || (live[k - 1].batch === live[k].batch && !/[\r\n;]/.test(src.slice(live[k - 1].end, live[k].start))));
      if (join) out[out.length - 1].end = live[k].end;
      else out.push({ start: live[k].start, end: live[k].end });
      last = k;
    }
    return out;
  };
  for (let round = 0; round <= live.length + 1; round++) {
    const text = build(failingNow());
    let stmts;
    try {
      stmts = parseText(text, true);
    } catch (e) {
      if (!(e instanceof SqlError)) return null;
      const k = blame(e.pos ?? 0);
      if (k < 0) return null;
      failed[k] = 1;
      if (joinPrev(k)) { failed[k - 1] = 1; glue[k] = 1; }
      continue;
    }
    if (spanning(stmts)) continue;
    return { stmts, failing: groups(), goFails, tail, text, ctx };
  }
  return null;
}

// Top-level items in text order: statements (several AST statements of one `SET A, B ON` share one item), GO lines
// ('gofail' when the count is out of range), failing statements (consecutive ones form one item, so the text between
// them is kept too; `parts` lists the statements, each one kept entry). `stmts` are the indexes of the item's
// statements in an.stmts.
function itemsOf(an) {
  const items = [];
  const goFail = new Map(an.goFails.map(g => [g.pos, g]));
  an.stmts.forEach((s, x) => {
    const last = items[items.length - 1];
    if (s.type === 'go') {
      const g = goFail.get(s.pos);
      items.push({ kind: g ? 'gofail' : 'go', node: s, pos: s.pos, end: g ? g.end : s.end, stmts: [x] });
      return;
    }
    if (last && last.kind === 'stmt' && last.pos === s.pos) {
      last.end = Math.max(last.end, s.end);
      last.stmts.push(x);
      return;
    }
    items.push({ kind: 'stmt', node: s, pos: s.pos, end: s.end, stmts: [x] });
  });
  const merged = [];
  let f = 0;
  const push = it => {
    const last = merged[merged.length - 1];
    if (last && last.kind === 'fail' && it.kind === 'fail') {
      last.end = Math.max(last.end, it.end);
      for (const p of it.parts) last.parts.push(p);
    } else {
      merged.push(it);
    }
  };
  const failItem = r => ({ kind: 'fail', node: null, pos: r.start, end: r.end, stmts: [], parts: [{ start: r.start, end: r.end }] });
  for (const it of items) {
    while (f < an.failing.length && an.failing[f].start < it.pos) push(failItem(an.failing[f++]));
    push(it);
  }
  while (f < an.failing.length) push(failItem(an.failing[f++]));
  merged.forEach((it, k) => { it.id = k; it.mark = { start: -1, end: -1 }; it.asts = null; });
  return merged;
}


// ---------------------------------------------------------------------------------------------------------------
// Documents: strings, arrays (concatenation) and the nodes below, printed by render() within opts.width.

const FLAT = 0;
const BREAK = 1;
const LINE = Object.freeze({ k: 'line' }); // a space, or a line break when its group breaks
const SOFT = Object.freeze({ k: 'soft' }); // nothing, or a line break when its group breaks
const HARD = Object.freeze({ k: 'hard' }); // always a line break (breaks every enclosing group)
const BLANK = Object.freeze({ k: 'blank' }); // a blank line
const SP = Object.freeze({ k: 'sp' }); // a space (never at the start of a line)
const U0 = Object.freeze({ k: 'u0' }); // comments that a ',' or ';' follows on their line start here (render())
const POP = Object.freeze({ k: 'pop' });
const FSEP = Object.freeze({ k: 'fsep' }); // between the items of a fill: a space, or a line break before an item that does not fit
const group = c => ({ k: 'group', c, brk: false });
const indent = c => ({ k: 'indent', c });

// True when a document starts with a LINE or SOFT, before any text.
function leadingBreak(doc) {
  const st = [doc];
  while (st.length) {
    const x = st.pop();
    if (typeof x === 'string') { if (x) return false; continue; }
    if (Array.isArray(x)) {
      for (let k = x.length - 1; k >= 0; k--) st.push(x[k]);
      continue;
    }
    switch (x.k) {
      case 'line': case 'soft': return true;
      case 'indent': case 'group': st.push(x.c); break;
      case 'mark': case 'u0': case 'u1': case 'sp': break;
      default: return false;
    }
  }
  return false;
}

// Marks every group that cannot be flat: it contains a hard line break, or a line comment followed by more text, or
// it starts with a line break right after a block comment that ends its line. That block comment ended its line
// either in the source or because this group broke in an earlier pass (the comment is at the end of the output line
// then); laid out broken in both cases, a second pass gives the same text.
function propagate(doc) {
  const open = [];
  let lcOpen = null;
  let afterBlock = false;
  const breakCommon = () => {
    for (let k = 0; k < open.length && k < lcOpen.length && open[k] === lcOpen[k]; k++) open[k].brk = true;
  };
  const st = [doc];
  while (st.length) {
    const d = st.pop();
    if (typeof d === 'string') {
      if (lcOpen) { breakCommon(); lcOpen = null; }
      if (d) afterBlock = false;
      continue;
    }
    if (Array.isArray(d)) {
      for (let k = d.length - 1; k >= 0; k--) st.push(d[k]);
      continue;
    }
    switch (d.k) {
      case 'pop': open.pop(); break;
      case 'hard': case 'blank':
        for (let k = open.length - 1; k >= 0 && !open[k].brk; k--) open[k].brk = true;
        afterBlock = false;
        break;
      case 'lc':
        if (lcOpen) breakCommon();
        lcOpen = open.slice();
        afterBlock = d.block === true;
        break;
      case 'alt': case 'goid':
        if (lcOpen) { breakCommon(); lcOpen = null; }
        afterBlock = false;
        break;
      case 'group':
        if (afterBlock && leadingBreak(d.c)) d.brk = true;
        afterBlock = false;
        open.push(d);
        st.push(POP, d.c);
        break;
      case 'indent': st.push(d.c); break;
      case 'fill': for (let k = d.items.length - 1; k >= 0; k--) st.push(d.items[k]); break;
      default: break;
    }
  }
}

// A stack of (indentation, mode, document) entries in parallel arrays, so pushing allocates nothing.
class DocStack {
  constructor() { this.ind = []; this.mode = []; this.doc = []; this.n = 0; }
  push(ind, mode, d) { const n = this.n++; this.ind[n] = ind; this.mode[n] = mode; this.doc[n] = d; }
}

// True when the text fits in `rem` columns up to the first possible line break: `d0` (in `mode0`; none when null)
// first, then the entries of the render stack `rest` from its top. `c` is a scratch stack. Indentation does not
// matter here: the scan ends at the first line break.
function fits(rem, d0, mode0, rest, c) {
  c.n = 0;
  if (d0 !== null) c.push(0, mode0, d0);
  let r = rest.n;
  let sp = false;
  while (rem >= 0) {
    let mode;
    let d;
    if (c.n) { const k = --c.n; mode = c.mode[k]; d = c.doc[k]; }
    else if (r > 0) { r--; mode = rest.mode[r]; d = rest.doc[r]; }
    else return true;
    if (typeof d === 'string') {
      const n = d.indexOf('\n');
      rem -= (n < 0 ? d.length : n) + (sp ? 1 : 0);
      sp = false;
      if (n >= 0) return rem >= 0;
      continue;
    }
    if (Array.isArray(d)) {
      for (let k = d.length - 1; k >= 0; k--) c.push(0, mode, d[k]);
      continue;
    }
    switch (d.k) {
      case 'line': if (mode === BREAK) return true; sp = true; break;
      case 'soft': if (mode === BREAK) return true; break;
      case 'sp': sp = true; break;
      case 'hard': case 'blank': case 'fsep': return true;
      case 'lc': {
        // A line comment never counts towards the width; a block comment does, wherever it is, so moving one after a
        // ',' or ';' (rule 3) never changes the layout.
        if (!d.block) return true;
        const n = d.text.indexOf('\n');
        rem -= (n < 0 ? d.text.length : n) + (sp ? 1 : 0);
        return rem >= 0;
      }
      case 'indent': c.push(0, mode, d.c); break;
      case 'group': c.push(0, d.brk ? BREAK : mode, d.c); break;
      case 'fill':
        for (let k = d.items.length - 1; k >= 0; k--) { c.push(0, mode, d.items[k]); if (k) c.push(0, mode, SP); }
        break;
      case 'alt': c.push(0, mode, d.a); break;
      case 'goid': rem -= d.text.length + (sp ? 1 : 0); sp = false; break;
      default: break;
    }
  }
  return false;
}

// True when a token (not a comment, not a GO count) is printed before the next line break, from the top of the
// render stack `rest` (`c` is a scratch stack). A group that is not laid out yet counts as broken, so the answer errs
// towards false.
function tokenFollows(rest, c) {
  c.n = 0;
  let r = rest.n;
  for (;;) {
    let mode;
    let d;
    if (c.n) { const k = --c.n; mode = c.mode[k]; d = c.doc[k]; }
    else if (r > 0) { r--; mode = rest.mode[r]; d = rest.doc[r]; }
    else return false;
    if (typeof d === 'string') {
      if (!d) continue;
      // A block comment (no token text starts with /*), U+FEFF or a count: nothing that stops a GO line.
      if (d.startsWith('/*') || /^\d+$/.test(d) || d.charCodeAt(0) === 0xfeff) { if (/[\r\n]/.test(d)) return false; continue; }
      return true;
    }
    if (Array.isArray(d)) {
      for (let k = d.length - 1; k >= 0; k--) c.push(0, mode, d[k]);
      continue;
    }
    switch (d.k) {
      case 'line': case 'soft': if (mode === BREAK) return false; break;
      case 'hard': case 'blank': case 'lc': case 'fsep': return false;
      case 'indent': c.push(0, mode, d.c); break;
      case 'group': c.push(0, BREAK, d.c); break;
      case 'fill':
        for (let k = d.items.length - 1; k >= 0; k--) { c.push(0, FLAT, d.items[k]); if (k) c.push(0, mode, FSEP); }
        break;
      case 'alt': return !(d.a.startsWith('--') || d.a.startsWith('/*'));
      case 'goid': return true;
      default: break;
    }
  }
}

// Two texts written without a space between them would lex differently ('-' '-', '/' '*', N + '…', two words).
function glued(a, b) {
  const c = b[0];
  return (a === '-' && c === '-') || (a === '/' && c === '*') || (a === '*' && c === '/') ||
    (WORD.test(a) && (WORD.test(c) || c === "'")) || (a === "'" && c === "'") || (a === '"' && c === '"');
}

// Prints a document. With `alts` (an array), each 'alt' node printed is listed as {s, e, b}: its text's range in the
// output and its alternative text (a failing statement's fill text), which has the same length and line breaks, so
// the check text is the output with those ranges replaced (spliced) and every mark stays valid in it. Comments that a
// ',' or ';' follows on their line ('u0' … 'u1') move after it when the output line ends after it (01 §1 rule 3):
// the same characters in another order, so no width, mark or alt range changes, and a second pass, which sees the
// ',' or ';' end its line, writes them the same way.
function render(doc, o, alts = null) {
  const out = [];
  let len = 0;
  let col = 0;
  let pend = 0; // 0 nothing, 1 space, 2 line break, 3 blank line
  let pendInd = 0;
  let force = false; // a comment that ends its line was printed: the next text starts a new line
  let forceLine = false; // that comment is a line comment (nothing can follow it on its line)
  let started = false;
  let bol = true;
  let last = '';
  const marks = [];
  let unit = null; // the comments ('u0') before a ',' or ';' not printed yet: {s, e, n}
  const ready = []; // units whose ',' or ';' was printed since the last token
  const swaps = [];
  // At the next token (or the end): the units it follows on the same line stay, the others move.
  const settle = brk => {
    if (brk) for (const u of ready) swaps.push(u);
    ready.length = 0;
  };
  const isCmt = s => s.startsWith('/*') || s.charCodeAt(0) === 0xfeff;
  let goLine = false; // the line holds only an identifier GO (and comments) so far: the next token joins it
  // Before a token is printed: a line that holds only an identifier GO takes it (01 §4.5: never a separator), unless a
  // line comment ends that line; then the comment units before it settle.
  const beforeToken = () => {
    if (goLine && (pend >= 2 || force) && !(force && forceLine)) { pend = 1; force = false; }
    goLine = false;
    if (ready.length) settle(pend >= 2 || force);
  };
  const pads = [];
  const pad = n => pads[n] ??= o.base + o.unit.repeat(n);
  const put = s => { out.push(s); len += s.length; };
  const newline = ind => { if (pend < 2) pend = 2; pendInd = ind; };
  const text = (s, ind, g = s) => {
    if (!s) return;
    if (force && pend < 2) { pend = 2; pendInd = ind; }
    if (!started) {
      const p = pad(pend >= 2 ? pendInd : 0);
      put(p);
      col = p.length;
      started = true;
      bol = true;
    } else if (pend >= 2) {
      put(pend === 3 ? o.eol + o.eol : o.eol);
      const p = pad(pendInd);
      put(p);
      col = p.length;
      bol = true;
    } else if (!bol && (pend === 1 || glued(last, g))) {
      put(' ');
      col++;
    }
    for (const m of marks) m.start = len;
    marks.length = 0;
    put(s);
    const n = s.lastIndexOf('\n');
    col = n < 0 ? col + s.length : s.length - n - 1;
    last = g[g.length - 1];
    pend = 0;
    force = false;
    bol = false;
  };
  const startCol = ind => {
    if (!started) return pad(0).length;
    if (pend >= 2) return pad(pendInd).length;
    if (force) return pad(ind).length;
    return bol ? col : col + (pend === 1 ? 1 : 0);
  };
  const stack = new DocStack();
  const scratch = new DocStack();
  stack.push(0, BREAK, doc);
  while (stack.n) {
    const top = --stack.n;
    const ind = stack.ind[top];
    const mode = stack.mode[top];
    const d = stack.doc[top];
    stack.doc[top] = null;
    if (typeof d === 'string') {
      if (d && !isCmt(d)) {
        beforeToken();
        if (unit) unit.sig += d.length;
      }
      text(d, ind);
      continue;
    }
    if (Array.isArray(d)) {
      for (let k = d.length - 1; k >= 0; k--) stack.push(ind, mode, d[k]);
      continue;
    }
    switch (d.k) {
      case 'line': if (mode === BREAK) newline(ind); else if (pend < 1) pend = 1; break;
      case 'soft': if (mode === BREAK) newline(ind); break;
      case 'hard': newline(ind); break;
      case 'blank': newline(ind); pend = 3; break;
      case 'sp': if (pend < 1) pend = 1; break;
      case 'indent': stack.push(ind + 1, mode, d.c); break;
      case 'group': {
        const flat = mode === FLAT || (!d.brk && fits(o.width - startCol(ind), d.c, FLAT, stack, scratch));
        stack.push(ind, flat ? FLAT : BREAK, d.c);
        break;
      }
      case 'fill':
        for (let k = d.items.length - 1; k >= 0; k--) {
          stack.push(ind, FLAT, d.items[k]);
          if (k) stack.push(ind, mode, mode === FLAT ? SP : FSEP);
        }
        break;
      case 'fsep':
        // The next item is on top of the stack: a space when it fits on this line, else a line break.
        if (fits(o.width - col - 1, null, FLAT, stack, scratch)) { if (pend < 1) pend = 1; } else newline(ind);
        break;
      case 'lc': text(d.text, ind); force = true; forceLine = !d.block; break;
      case 'alt':
        unit = null;
        beforeToken();
        text(d.a, ind);
        if (alts && d.a) alts.push({ s: len - d.a.length, e: len, b: d.b });
        break;
      case 'goid': {
        // An identifier GO that would start a line with nothing but comments after it on that line would be a batch
        // separator (01 §4.5): it stays on the line before instead, after a space; after a line comment (or as the
        // first text) the next token joins its line instead (beforeToken). When a line comment follows it too, the
        // statement fails verification (goCulprits) and is kept.
        const atStart = !started || pend >= 2 || force;
        const alone = atStart && !tokenFollows(stack, scratch);
        if (alone && started && !(force && forceLine)) {
          force = false;
          pend = 1;
        }
        beforeToken();
        const still = alone && (!started || pend >= 2 || force);
        if (unit) unit.sig += d.text.length;
        text(d.text, ind);
        goLine = still;
        break;
      }
      case 'mark': if (d.end) d.m.end = len; else marks.push(d.m); break;
      case 'u0': unit = { s: len, e: -1, n: 0, sig: 0 }; break;
      case 'u1':
        // d.n: the length of the ',' or ';' run just printed, the only token text since 'u0' (0: the comments stay).
        if (unit && d.n > 0 && unit.sig === d.n && len - unit.s > d.n) { unit.e = len; unit.n = d.n; ready.push(unit); }
        unit = null;
        break;
      default: break;
    }
  }
  settle(true);
  const res = out.join('');
  if (!swaps.length) return res;
  const parts = [];
  let at = 0;
  for (const u of swaps) {
    parts.push(res.slice(at, u.s), res.slice(u.e - u.n, u.e), res.slice(u.s, u.e - u.n));
    at = u.e;
  }
  parts.push(res.slice(at));
  return parts.join('');
}

// ---------------------------------------------------------------------------------------------------------------
// Builder: walks the AST of each statement and emits its tokens (all of them, in order, through `tok`), placing the
// line breaks and indentation. Tokens that no AST node accounts for are emitted in place with default spacing.

// Space before or after a comment entry on its line (none around U+FEFF, which is white space itself).
const cmtSp = c => (c.ws ? [] : SP);

// A line comment without its trailing spaces, tabs and CR (a backwards scan: a regex anchored at $ is quadratic on
// long runs of white space).
function trimLine(s) {
  let e = s.length;
  for (; e > 0; e--) {
    const c = s.charCodeAt(e - 1);
    if (c !== 32 && c !== 9 && c !== 13) break;
  }
  return e === s.length ? s : s.slice(0, e);
}

class Builder {
  constructor(src, prep, o, items, levels, tail) {
    this.src = src;
    this.T = prep.T;
    this.match = prep.match;
    this.at = prep.at;
    this.o = o;
    this.items = items;
    this.levels = levels;
    this.tail = tail;
    this.done = new Int32Array(this.T.length);
    this.i = 0;
    this.prev = null;
    this.prevUnary = false;
    this.cmtAfter = false;
    this.sep = false;
    this.caseOn = true;
    this.stmtLevel = false;
    this.noBlank = false;
    this.closes = [];
    this.item = null;
    this.tailMark = { start: -1, end: -1 };
    this.endNl = prep.endNl > 0;
    this.keptAt = new Set();
    for (const it of items) if (it.kind === 'fail') this.keptAt.add(it.pos);
  }

  get cur() { return this.T[this.i]; }
  isOp(v, n = 0) { return isOpTok(this.T[this.i + n], v); }
  isKw(k, n = 0) { return isKwTok(this.T[this.i + n], k); }
  idx(pos) { return this.at(pos); }

  // ----- separators (they also suppress the default space before the next token)
  sp() { this.sep = true; return this.prevUnary ? [] : SP; }
  line() { this.sep = true; return LINE; }
  soft() { this.sep = true; return SOFT; }
  hard() { this.sep = true; return HARD; }
  none() { this.sep = true; return []; }

  // ----- tokens
  textOf(t, kind) {
    let s = this.src.slice(t.s, t.e);
    if (t.t !== 'id' || !this.caseOn) return s;
    if (kind === 'auto') kind = RESERVED.has(t.k) ? 'kw' : 'id';
    const mode = kind === 'kw' ? this.o.kw : kind === 'fn' ? this.o.fn : kind === 'type' ? this.o.type : 'preserve';
    if (mode === 'upper') s = s.toUpperCase();
    else if (mode === 'lower') s = s.toLowerCase();
    return s;
  }

  // Default spacing between the previous token and t when no separator was placed.
  space(p, t) {
    if (t.t === 'op' && (t.v === ',' || t.v === ';' || t.v === ')' || t.v === '.' || t.v === '::')) return false;
    // After ';' only a statement written right after leading semicolons (`;WITH …`) can follow on the same line.
    if (p.t === 'op' && (p.v === '(' || p.v === '.' || p.v === '::' || p.v === ';')) return false;
    if (this.prevUnary) return false;
    if (t.t === 'op' && t.v === '(') {
      if (p.t === 'qid') return false;
      if (p.t === 'id') return RESERVED.has(p.k) && !CALLABLE.has(p.k);
    }
    return true;
  }

  unaryOp(t) {
    if (t.t !== 'op' || !(t.v === '-' || t.v === '+' || t.v === '~')) return false;
    const p = this.prev;
    return !p || (p.t === 'op' && p.v !== ')') || (p.t === 'id' && RESERVED.has(p.k) && !OPERAND_KW.has(p.k));
  }

  // A ',' or ';' whose comments move after it (01 §1 rule 3): one of its comments is a line comment or ends its line
  // (the ',' or ';' starts a later line), or it ends its line in the source and its comments are on its line (a
  // comment on a line of its own before it stays there, rule 2). Comments on its line before one that does not end
  // its line in the source move when it ends its output line (render(), 'u0' … 'u1').
  hoistable(k) {
    const t = this.T[k];
    if (!t || t.t !== 'op' || (t.v !== ',' && t.v !== ';')) return false;
    let cmt = false;
    let own = false;
    for (let j = this.done[k]; j < t.pre.length; j++) {
      const c = t.pre[j];
      if (c.s >= this.tail) break;
      if (c.line || c.nlAfter) return true;
      if (c.nlBefore > 0) own = true;
      if (!c.ws) cmt = true;
    }
    return cmt && !own && this.endsLine(k);
  }

  // True when token k ends its line in the source: a line break comes before the next token, comments aside.
  endsLine(k) {
    const n = this.T[k + 1];
    if (!n) return false;
    if (n.nl > 0) return true;
    for (const c of n.pre) if (c.nlBefore > 0) return true;
    return false;
  }

  // True when a comment follows token k on its line and is not printed yet (trailing() prints it).
  cmtFollows(k) {
    const n = this.T[k + 1];
    if (!n) return false;
    const j = this.done[k + 1];
    return j < n.pre.length && n.pre[j].nlBefore === 0 && n.pre[j].s < this.tail;
  }

  // A comment as a document. A line comment, and a block comment that ends its line (`ends`: 01 §1 rule 1, a comment
  // on the same line as the token before it stays at the end of that line), make the next text start a line; other
  // block comments (and U+FEFF) are text, kept verbatim.
  cmtDoc(c, ends = false) {
    if (c.line) return { k: 'lc', text: trimLine(c.text) };
    return ends && !c.ws ? { k: 'lc', text: c.text, block: true } : c.text;
  }

  // The comments of ',' or ';' token k moved after it (rule 3): each keeps its line break before it, and the last one
  // ends the line when it did, or when the ',' or ';' did and no comment of its own follows it there (unless a GO
  // follows it: see trailing()).
  hoisted(k, parts) {
    const t = this.T[k];
    let last = this.done[k] - 1;
    for (let j = this.done[k]; j < t.pre.length && t.pre[j].s < this.tail; j++) last = j;
    const ends = this.endsLine(k) && !this.cmtFollows(k);
    const go = isKwTok(this.T[k + 1], 'GO');
    let broke = false;
    for (let j = this.done[k]; j <= last; j++) {
      const c = t.pre[j];
      const end = j < last ? c.nlAfter : (c.nlAfter || ends) && !go;
      parts.push(c.nlBefore === 0 ? cmtSp(c) : HARD, this.cmtDoc(c, end));
      this.cmtAfter = !c.ws;
      broke = c.line || (end && !c.ws);
    }
    this.done[k] = t.pre.length;
    return broke;
  }

  // Comments on their own lines before token k (not yet printed). The gap between two comments is decided by the
  // second one (a line break, or on the same line a space, none before U+FEFF), the gap after the last one by it.
  leading(k, parts) {
    const t = this.T[k];
    let last = null;
    for (let j = this.done[k]; j < t.pre.length; j++) {
      const c = t.pre[j];
      if (c.s >= this.tail) break;
      // On the same line as what was printed before it (an earlier comment, or the start of the text).
      if (c.nlBefore === 0 && (last || this.prev)) parts.push(cmtSp(c));
      else parts.push(this.stmtLevel && !this.noBlank && c.nlBefore >= 2 ? BLANK : HARD);
      this.noBlank = false;
      parts.push(this.cmtDoc(c));
      last = c;
    }
    if (last && !last.line) parts.push(last.nlAfter ? HARD : cmtSp(last));
    this.done[k] = t.pre.length;
    if (last && this.stmtLevel && t.nl >= 2) parts.push(BLANK);
    return !!last;
  }

  // Comments on the same line after token k (a ',' or ';' that hoists its comments prints them itself, unless it
  // starts a piece kept as written, or `force`: the end of a GO line); the last one ends the line when it did (rule
  // 1), unless the next token is a GO: an identifier GO that starts a line may be all of it (01 §4.5), so render()
  // joins it to the line before, and a forced break there would change the layout of a second pass. After U+FEFF the
  // default spacing applies.
  trailing(k, parts, force = false) {
    const n = this.T[k + 1];
    if (!n || (!force && this.hoistable(k + 1) && !this.keptAt.has(n.s))) return;
    let j = this.done[k + 1];
    // Comments before a ',' or ';' on its line: render() moves them after it when its output line ends there.
    const unit = !force && n.t === 'op' && (n.v === ',' || n.v === ';') && !this.keptAt.has(n.s);
    const go = isKwTok(n, 'GO');
    while (j < n.pre.length && n.pre[j].nlBefore === 0 && n.pre[j].s < this.tail) {
      const c = n.pre[j];
      if (unit && j === this.done[k + 1]) parts.push(U0);
      parts.push(cmtSp(c), this.cmtDoc(c, c.nlAfter && !go));
      this.cmtAfter = !c.ws;
      j++;
    }
    this.done[k + 1] = j;
  }

  // Emits the current token (kind: 'kw' keyword, 'fn' function name, 'type' data type, 'id' as written, 'auto'
  // reserved words as keywords) with its comments. An identifier GO in a statement is a 'goid' node, which render()
  // never leaves alone on a line (01 §4.5).
  tok(kind = 'auto') {
    const k = this.i;
    const t = this.T[k];
    if (t.t === 'end') return [];
    const parts = [];
    // A comment printed after the previous token gets a space before the next one (except , ; and )).
    // A separator only replaces the default space: `CAST /* c */ (`, not `CAST /* c */(`.
    const closer = t.t === 'op' && (t.v === ',' || t.v === ';' || t.v === ')');
    if (this.prev && ((this.cmtAfter && !closer) || (!this.sep && this.space(this.prev, t)))) parts.push(SP);
    this.cmtAfter = false;
    const hoist = this.hoistable(k);
    if (!hoist) this.leading(k, parts);
    this.stmtLevel = false;
    const s = this.textOf(t, kind);
    parts.push(t.t === 'id' && t.k === 'GO' && this.item && this.item.kind === 'stmt' ? { k: 'goid', text: s } : s);
    if (t.t === 'op' && (t.v === ',' || t.v === ';')) parts.push({ k: 'u1', n: s.length });
    if (hoist) this.hoisted(k, parts);
    this.trailing(k, parts);
    this.prevUnary = this.unaryOp(t);
    this.prev = t;
    this.i++;
    this.sep = false;
    return parts;
  }

  kw() { return this.tok('kw'); }
  ident() { return this.tok('id'); }

  // The current token as a keyword when it is the word k, else nothing.
  kwIf(k) { return this.isKw(k) ? this.kw() : []; }

  // True when the current token starts a line because of a comment: a comment that ends its line printed after the
  // previous token, or a comment on its own line before it (not printed yet).
  breaksBefore() {
    const t = this.cur;
    const k = this.done[this.i];
    if (k > 0 && (t.pre[k - 1].line || (t.pre[k - 1].nlAfter && !t.pre[k - 1].ws))) return true;
    return k < t.pre.length && t.pre[k].s < this.tail;
  }

  // The body of a clause after its keyword (FROM, WHERE, HAVING, JOIN, ON): indented one level when a comment puts it
  // on a line of its own, so it never starts at the column of its keyword (`WHERE` + newline + `    -- c` + newline +
  // `    a = 1`). IF and WHILE conditions are not indented: that is where their body goes.
  clause(fn) {
    return this.breaksBefore() ? indent(fn()) : fn();
  }

  // Leading comments of the current token, printed now (inside the caller's indentation).
  leadingOnly() {
    const parts = [];
    if (this.cur.t === 'end' && this.cur.pre.length === this.done[this.i]) return parts;
    if (this.leading(this.i, parts)) this.sep = true;
    return parts;
  }

  // True when every token from the cursor up to pos is '(' (parentheses that wrap the node at pos).
  wrapRun(pos) {
    for (let j = this.i; this.T[j].t !== 'end' && this.T[j].s < pos; j++) if (!isOpTok(this.T[j], '(')) return false;
    return true;
  }

  // Tokens before pos (keywords and punctuation between AST nodes), except '(' that wrap the node at pos.
  glue(pos, kind = 'auto') {
    const parts = [];
    while (this.cur.t !== 'end' && this.cur.s < pos && !this.wrapRun(pos)) parts.push(this.tok(kind));
    return parts;
  }

  // Tokens before pos, letter case kept (object names, aliases).
  glueId(pos) { return this.glue(pos, 'id'); }

  // Tokens until the next '(' (keywords), e.g. `NOT IN` before its list.
  untilParen(kind = 'kw') {
    const parts = [];
    while (this.cur.t !== 'end' && !this.isOp('(')) parts.push(this.tok(kind));
    return parts;
  }

  // ';' tokens before limit, written right after the statement. A run of them is written together (`;;`) and the
  // comments between them follow the run; with `keep` (the run is followed on its line by a kept piece that starts
  // with GO) every comment stays where it was written, so no line comment moves between the run and the piece. With
  // `tail` (an array; the run ends a block body before its END), the comments that follow the run from the first one
  // that starts a line (on a line of its own, or after a line comment) go to `tail`, which the caller writes at the
  // level of that END (01 §1 rule 2), so a second pass leaves them there.
  semis(limit, keep = false, tail = null) {
    const parts = [];
    if (!(this.isOp(';') && this.cur.s < limit)) return parts;
    let end = this.i;
    while (isOpTok(this.T[end], ';') && this.T[end].s < limit) end++;
    const first = this.i;
    const later = [];
    for (let k = first; k < end; k++) {
      const t = this.T[k];
      if (keep) {
        this.leading(k, parts);
      } else {
        if (k === first && !this.hoistable(k)) this.leading(k, parts);
        for (let j = this.done[k]; j < t.pre.length && t.pre[j].s < this.tail; j++) later.push(t.pre[j]);
        this.done[k] = t.pre.length;
      }
      parts.push(this.textOf(t, 'auto'));
      // The next ';' follows this one (leading() places its same-line comments after it, not on a new line).
      this.prev = t;
      this.prevUnary = false;
    }
    // With keep every comment stays where it was written.
    parts.push({ k: 'u1', n: keep ? 0 : end - first });
    this.cmtAfter = false;
    let out = parts;
    let broke = false; // the last comment written ends its line: whatever follows starts a line
    // The last comment moved after the run ends the line when the run did and no comment of its own follows it there.
    const ends = later.length > 0 && this.endsLine(end - 1) && !this.cmtFollows(end - 1);
    for (let x = 0; x < later.length; x++) {
      const c = later[x];
      if (tail && (c.nlBefore > 0 || broke)) out = tail;
      const e = c.nlAfter || (x === later.length - 1 && ends);
      out.push(c.nlBefore === 0 ? cmtSp(c) : HARD, this.cmtDoc(c, e));
      this.cmtAfter = !c.ws;
      broke = c.line || (e && !c.ws);
    }
    this.i = end;
    if (tail && broke) out = tail;
    this.trailing(end - 1, out);
    this.prev = this.T[end - 1];
    this.prevUnary = false;
    this.stmtLevel = false;
    this.sep = false;
    return parts;
  }

  // Index of the ')' that closes the innermost parenthesis being printed.
  close() { return this.closes.length ? this.closes[this.closes.length - 1] : this.T.length - 1; }

  // Tokens before the closing ')' of the innermost parenthesis.
  toClose(kind = 'auto') {
    const parts = [];
    const c = this.close();
    while (this.i < c && this.cur.t !== 'end') parts.push(this.tok(kind));
    return parts;
  }

  // ( inner ) as a group: inline when it fits, else the content indented and ')' on its own line.
  // Comments on their own lines before the '(' are written before the group, so they do not force it open; those
  // before the ')' are indented like it (01 §1 comment rule 2).
  paren(inner) {
    if (!this.isOp('(')) return inner();
    const c = this.match[this.i];
    const lead = this.leadingOnly();
    const open = this.tok();
    if (c < 0) return [lead, open, inner()];
    this.closes.push(c);
    let body;
    let rest;
    try {
      const s1 = this.soft();
      body = [s1, inner()];
      rest = this.genTo(c);
    } finally {
      this.closes.pop();
    }
    const lc = this.i === c ? this.leadingOnly() : [];
    const s2 = this.soft();
    const cl = this.i === c ? this.tok() : [];
    return [lead, group([open, indent([body, rest]), lc, s2, cl])];
  }

  // Generic layout of the tokens before token index c: parentheses as groups, ',' followed by a line.
  genTo(c, kws = null) {
    const parts = [];
    while (this.i < c && this.cur.t !== 'end') {
      const t = this.cur;
      if (isOpTok(t, '(') && this.match[this.i] >= 0 && this.match[this.i] < c) {
        const p = this.prev && this.prev.t === 'id' ? this.prev.k : '';
        const pre = p === 'IDENTITY' ? this.none() : p === 'SETS' ? this.sp() : [];
        parts.push(pre, this.paren(() => this.genTo(this.close(), kws)));
        continue;
      }
      if (isOpTok(t, ',')) { parts.push(this.tok(), this.line()); continue; }
      parts.push(this.tok(this.genKind(t, kws)));
    }
    return parts;
  }

  // Letter case of a word in generic layout: reserved words and `kws` (true: every word; a Set; or GROUPING_KW,
  // where ROLLUP/CUBE are keywords only before '(' or after WITH, and GROUPING/SETS only together) are keywords; with
  // GROUPING_KW a word before '(' is a function name; other words keep their case.
  genKind(t, kws) {
    if (t.t !== 'id') return 'id';
    if (RESERVED.has(t.k) || kws === true) return 'kw';
    if (kws === GROUPING_KW) {
      const n = this.T[this.i + 1];
      const p = this.prev;
      if ((t.k === 'ROLLUP' || t.k === 'CUBE') && (isOpTok(n, '(') || isKwTok(p, 'WITH'))) return 'kw';
      if ((t.k === 'GROUPING' && isKwTok(n, 'SETS')) || (t.k === 'SETS' && isKwTok(p, 'GROUPING'))) return 'kw';
      return isOpTok(n, '(') && !(p && isOpTok(p, '.')) ? 'fn' : 'id';
    }
    return kws && kws.has(t.k) ? 'kw' : 'id';
  }

  // ( … ) on one line: the tokens up to the matching ')', words as written unless reserved, ', ' between items.
  flatParen() {
    const c = this.match[this.i];
    const parts = [];
    const last = c < 0 ? this.i : c;
    while (this.i <= last && this.cur.t !== 'end') {
      const t = this.cur;
      if (isOpTok(t, ',')) parts.push(this.tok(), this.sp());
      else parts.push(this.tok(t.t === 'id' && (RESERVED.has(t.k) || CONSTRAINT_KW.has(t.k)) ? 'kw' : 'id'));
    }
    return parts;
  }

  // Generic layout of the tokens before pos, as one group.
  gen(pos, kws = null) {
    let c = this.i;
    while (this.T[c].t !== 'end' && this.T[c].s < pos) c++;
    return group(this.genTo(c, kws));
  }

  // The source text of tokens up to end, unchanged (failing statements). `alt`: null (the text is checked as it is) or
  // the text verify() reads in its place (an 'alt' node).
  verbatim(start, end, alt) {
    const parts = [];
    const first = this.i;
    if (this.prev && (this.cmtAfter || (!this.sep && this.space(this.prev, this.cur)))) parts.push(SP);
    this.leading(first, parts);
    this.stmtLevel = false;
    const text = this.src.slice(start, end);
    while (this.cur.t !== 'end' && this.cur.s < end) this.i++;
    parts.push(alt == null ? text : { k: 'alt', a: text, b: alt });
    this.cmtAfter = false;
    if (this.i > first) {
      this.trailing(this.i - 1, parts);
      this.prev = this.T[this.i - 1];
    }
    this.prevUnary = false;
    this.sep = false;
    return parts;
  }

  // ----- AST helpers

  // Emits node n through fn, inside the parentheses that wrap it (only '(' whose ')' comes after n.end). With `lead`,
  // comments on their own lines before the node are written first, outside the groups fn builds.
  node(n, fn, lead = false) {
    const pre = [this.glue(n.pos), lead ? this.leadingOnly() : []];
    let k = 0;
    while (isOpTok(this.T[this.i + k], '(') && this.T[this.i + k].s < n.pos) {
      const m = this.match[this.i + k];
      if (m < 0 || this.T[m].s < n.end) break;
      k++;
    }
    const wrap = j => (j === 0 ? fn(n, k > 0) : this.paren(() => [this.glue(n.pos), wrap(j - 1)]));
    return [pre, wrap(k)];
  }

  // True when n, the left operand of `parent` (a set operation or join starting where n starts), is wrapped in
  // parentheses that no AST node accounts for: a '(' right before n that closes after n but before parent ends.
  wrapped(n, parent) {
    const k = this.idx(n.pos);
    if (k <= 0 || !isOpTok(this.T[k - 1], '(')) return false;
    const m = this.match[k - 1];
    return m >= 0 && this.T[m].s >= n.end && this.T[m].s < parent.end;
  }

  // Items with pos/end separated by ',': inline when they fit, else one per indented line. With `hug`, a single item
  // stays on the keyword's line and breaks inside itself (DECLARE @t TABLE (…), EXEC name @p = …).
  list(items, fn, hug = false) {
    if (items.length === 1 && hug) return [this.sp(), fn(items[0])];
    const inner = [];
    items.forEach((it, k) => {
      if (k) inner.push(this.glue(it.pos));
      inner.push(this.line(), fn(it));
    });
    return group(indent(inner));
  }

  // ( name, name, … ) of identifiers.
  identParen() {
    return this.paren(() => {
      const parts = [];
      const c = this.close();
      while (this.i < c && this.cur.t !== 'end') parts.push(this.isOp(',') ? [this.tok(), this.line()] : this.ident());
      return parts;
    });
  }

  // ----- statements

  // A statement list (block bodies): one statement per line, up to one blank line kept between them. `tail`: see
  // semis() (the list ends before an END).
  stmtList(nodes, tail = null) {
    const parts = [];
    let k = 0;
    while (k < nodes.length) {
      const n = nodes[k];
      let j = k + 1;
      while (j < nodes.length && nodes[j].pos === n.pos) j++;
      const end = Math.max(...nodes.slice(k, j).map(x => x.end));
      const next = j < nodes.length ? nodes[j].pos : Infinity;
      if (k) parts.push(this.stmtSep());
      else { this.stmtLevel = true; this.noBlank = true; }
      parts.push(this.semis(n.pos), this.statement(n, end), this.semis(next, false, j < nodes.length ? null : tail));
      k = j;
    }
    return parts;
  }

  // Line break before a statement: a blank line when the original had one; a space with `glue` (the statement
  // continues the line, see script()).
  stmtSep(glue = false) {
    const t = this.cur;
    let j = this.done[this.i];
    while (j < t.pre.length && t.pre[j].nlBefore === 0) j++;
    const c = j < t.pre.length && t.pre[j].s < this.tail ? t.pre[j] : null;
    const nl = c ? c.nlBefore : t.nl;
    this.sep = true;
    this.stmtLevel = true;
    this.noBlank = false;
    if (glue) return SP;
    return nl >= 2 ? BLANK : HARD;
  }

  statement(n, end = n.end) {
    let d;
    switch (n.type) {
      case 'select': d = this.selectStmt(n); break;
      case 'insert': d = this.insertStmt(n); break;
      case 'update': d = this.updateStmt(n); break;
      case 'delete': d = n.truncate ? [this.glue(n.target.pos, 'kw'), this.sp(), this.glueId(n.target.end)] : this.deleteStmt(n); break;
      case 'declare': d = [this.kw(), this.list(n.vars, v => this.declVar(v), true)]; break;
      case 'setvar': d = [this.kw(), this.sp(), this.tok(), this.sp(), this.glue(n.expr.pos), this.sp(), this.expr(n.expr)]; break;
      case 'setopt': case 'noop': d = this.setOption(end); break;
      case 'print': d = [this.kw(), this.sp(), this.expr(n.expr)]; break;
      case 'if': d = this.ifStmt(n); break;
      case 'while': d = [this.kw(), this.sp(), this.expr(n.cond), this.bodyOf(n.body)]; break;
      case 'block': d = this.isKw('BEGIN') ? this.block(n) : this.stmtList(n.body); break;
      case 'try': d = this.tryStmt(n); break;
      case 'create': d = [this.glue(n.name.pos, 'kw'), this.sp(), this.glueId(n.name.end), this.sp(), this.colDefs(n.cols)]; break;
      case 'drop': d = this.dropStmt(n); break;
      case 'throw': d = this.throwStmt(n); break;
      case 'raiserror': d = this.raiserror(n); break;
      case 'waitfor': case 'executeas': d = [this.glue(n.expr.pos, 'kw'), this.sp(), this.expr(n.expr)]; break;
      case 'exec': d = this.execStmt(n); break;
      case 'execsql': d = this.execSqlStmt(n); break;
      case 'declarecursor': d = this.declareCursor(n); break;
      case 'open': case 'close': case 'deallocate': d = [this.kw(), n.global ? [this.sp(), this.kw()] : [], this.sp(), this.ident()]; break;
      case 'fetch': d = this.fetchStmt(n); break;
      case 'label': d = [this.ident(), this.none(), this.tok()]; break;
      case 'goto': d = [this.kw(), this.sp(), this.ident()]; break;
      default: d = this.gen(end, true); break;
    }
    return [d, this.gen(end)];
  }

  // A body of IF / ELSE / WHILE: BEGIN…END and BEGIN TRY on their own line at the same level, else indented.
  bodyOf(s) {
    const blockLike = (s.type === 'block' && isKwTok(this.T[this.idx(s.pos)], 'BEGIN')) || s.type === 'try';
    this.stmtLevel = true;
    this.noBlank = true;
    if (blockLike) return [this.hard(), this.statement(s)];
    return indent([this.hard(), this.statement(s)]);
  }

  ifStmt(n) {
    const parts = [this.kw(), this.sp(), this.expr(n.cond), this.bodyOf(n.then)];
    if (n.else) {
      parts.push(this.semis(n.else.pos), this.hard(), this.glue(n.else.pos, 'kw'));
      if (n.else.type === 'if' && this.isKw('IF')) parts.push(this.sp(), this.statement(n.else));
      else parts.push(this.bodyOf(n.else));
    }
    return parts;
  }

  // BEGIN … END: the body indented; comments on their own lines before END are indented like END (01 §1 rule 2).
  block(n) {
    const begin = this.kw();
    const tail = [];
    const body = this.stmtList(n.body, tail);
    const semis = this.semis(n.end, false, tail);
    const lc = this.closerComments(n.body.length > 0);
    return [begin, indent([this.hard(), body, semis]), tail, lc, this.hard(), this.glue(n.end, 'kw')];
  }

  // The comments on their own lines before END, END TRY or END CATCH, written at the level of that END. They are at
  // statement level: a blank line before them is kept after a statement of the body (`body`), not right after BEGIN.
  closerComments(body) {
    this.stmtLevel = true;
    this.noBlank = !body;
    return this.leadingOnly();
  }

  tryStmt(n) {
    const parts = [this.kw(), this.kw()];
    const t1 = [];
    parts.push(indent([this.hard(), this.stmtList(n.body, t1), this.semis(Infinity, false, t1)]), t1,
      this.closerComments(n.body.length > 0));
    parts.push(this.hard(), this.kw(), this.kw(), this.semis(Infinity));
    parts.push(this.hard(), this.kw(), this.kw());
    const t2 = [];
    const inner = n.catch.length ? [this.hard(), this.stmtList(n.catch, t2)] : [];
    parts.push(indent([inner, this.semis(Infinity, false, t2)]), t2, this.closerComments(n.catch.length > 0));
    parts.push(this.hard(), this.glue(n.end, 'kw'));
    return parts;
  }

  dropStmt(n) {
    const parts = [this.glue(n.names[0].pos, 'kw')];
    n.names.forEach((x, k) => {
      if (k) parts.push(this.glue(x.pos));
      parts.push(this.sp(), this.glueId(x.end));
    });
    return parts;
  }

  throwStmt(n) {
    const parts = [this.kw()];
    n.args.forEach((a, k) => {
      if (k) parts.push(this.glue(a.pos));
      parts.push(this.sp(), this.expr(a));
    });
    return parts;
  }

  raiserror(n) {
    const name = [this.kw(), this.sp()];
    const args = this.paren(() => {
      const parts = [];
      n.args.forEach((a, k) => {
        if (k) parts.push(this.glue(a.pos), this.line());
        parts.push(this.expr(a));
      });
      return parts;
    });
    return [name, args, this.glue(n.end, 'kw')];
  }

  execStmt(n) {
    const parts = [this.kw()];
    if (n.assignTo) parts.push(this.sp(), this.tok(), this.sp(), this.tok());
    parts.push(this.sp(), this.glueId(n.name.end));
    if (n.params.length) parts.push(this.list(n.params, p => this.execParam(p), true));
    return parts;
  }

  execParam(p) {
    const parts = [];
    if (p.name) parts.push(this.tok(), this.sp(), this.glue(p.expr.pos), this.sp());
    parts.push(this.expr(p.expr), this.glue(p.end, 'kw'));
    return parts;
  }

  // EXEC [@r =] [sys.|dbo.]sp_executesql stmt [, params [, args]] like any EXEC (the procedure name keeps its case),
  // and EXEC ( string [+ …] ).
  execSqlStmt(n) {
    const parts = [this.kw()];
    if (n.dynamic) return [parts, this.sp(), this.paren(() => this.expr(n.stmt))];
    if (n.assignTo) parts.push(this.sp(), this.tok(), this.sp(), this.tok());
    const args = [this.fixedArg(n.stmt)];
    if (n.params) args.push(this.fixedArg(n.params));
    args.push(...n.args);
    parts.push(this.sp(), this.glueId(args[0].pos), this.list(args, p => this.execParam(p), true));
    return parts;
  }

  // The statement or parameter-list argument of sp_executesql as an EXEC parameter, named when `@stmt =` or
  // `@params =` precedes its expression.
  fixedArg(e) {
    const k = this.idx(e.pos);
    const v = k >= 2 && isOpTok(this.T[k - 1], '=') && this.T[k - 2].t === 'var' ? this.T[k - 2] : null;
    return { name: v ? v.v : null, expr: e, output: false, pos: v ? v.s : e.pos, end: e.end };
  }

  // ----- cursors and labels

  // DECLARE c [INSENSITIVE] [SCROLL] CURSOR [options] FOR, then the cursor's query, its OPTION clause and FOR
  // READ_ONLY indented under the declaration, each clause starting a line.
  declareCursor(n) {
    const parts = [this.kw(), this.sp(), this.ident()];
    while (this.cur.t !== 'end' && this.cur.s < n.end && !this.isKw('FOR')) parts.push(this.sp(), this.kw());
    parts.push(this.sp(), this.kw());
    const q = n.query;
    const body = [];
    if (q.with || q.xmlns) body.push(this.withClause(q.with, q.xmlns));
    body.push(this.query(q, true));
    if (this.isKw('OPTION') && this.cur.s < n.end) {
      body.push(this.hard(), this.kw(), this.sp(), this.paren(() => this.genTo(this.close(), true)));
    }
    if (this.isKw('FOR') && this.cur.s < n.end) body.push(this.hard(), this.gen(n.end, true));
    return [parts, indent([this.hard(), body])];
  }

  // FETCH [[NEXT | PRIOR | FIRST | LAST | ABSOLUTE n | RELATIVE n] FROM] [GLOBAL] c [INTO @a, …]: one line, the INTO
  // list one variable per indented line when it does not fit. A direction word is a keyword only before FROM (else it
  // is the cursor's name, `FETCH next`).
  fetchStmt(n) {
    const parts = [this.kw()];
    if (n.n) parts.push(this.sp(), this.kw(), this.sp(), this.expr(n.n));
    else if (this.cur.t === 'id' && FETCH_DIRS.has(this.cur.k) && this.isKw('FROM', 1)) parts.push(this.sp(), this.kw());
    if (this.isKw('FROM')) parts.push(this.sp(), this.kw());
    if (n.global) parts.push(this.sp(), this.kw());
    parts.push(this.sp(), this.ident());
    if (this.isKw('INTO') && this.cur.s < n.end) {
      const inner = [];
      parts.push(this.sp(), this.kw());
      while (this.cur.t !== 'end' && this.cur.s < n.end) inner.push(this.isOp(',') ? this.tok() : [this.line(), this.tok()]);
      parts.push(group(indent(inner)));
    }
    return parts;
  }

  // SET options: every word is a keyword except the value of DATEFORMAT and LANGUAGE.
  setOption(end) {
    const parts = [];
    while (this.cur.t !== 'end' && this.cur.s < end) {
      const p = this.prev;
      const valueOf = p && p.t === 'id' && (p.k === 'DATEFORMAT' || p.k === 'LANGUAGE');
      parts.push(this.isOp(',') ? [this.tok(), this.sp()] : this.tok(valueOf ? 'id' : 'kw'));
    }
    return parts;
  }

  declVar(v) {
    const parts = [this.tok()];
    if (this.isKw('AS')) parts.push(this.sp(), this.kw());
    if (v.table) {
      parts.push(this.sp(), this.kw(), this.sp(), this.colDefs(v.table));
    } else {
      parts.push(this.sp(), this.typeDoc(v.dataType));
      if (v.init) parts.push(this.sp(), this.glue(v.init.pos), this.sp(), this.expr(v.init));
    }
    return parts;
  }

  // ( column definitions and table constraints ) of CREATE TABLE / DECLARE @t TABLE.
  colDefs(cols) {
    let ci = 0;
    return this.paren(() => {
      const parts = [];
      const c = this.close();
      while (this.i < c && this.cur.t !== 'end') {
        if (this.isOp(',')) { parts.push(this.tok(), this.line()); continue; }
        let e = this.i;
        let depth = 0;
        for (; e < c; e++) {
          const t = this.T[e];
          if (isOpTok(t, '(')) depth++;
          else if (isOpTok(t, ')')) depth--;
          else if (isOpTok(t, ',') && depth === 0) break;
        }
        const t = this.cur;
        const constraint = t.t === 'id' && ['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(t.k);
        const col = constraint ? null : cols[ci++] ?? null;
        const seg = [];
        if (!constraint) {
          seg.push(this.ident());
          if (col && this.cur.s === col.dataType.pos) seg.push(this.sp(), this.typeDoc(col.dataType));
        }
        seg.push(this.constraintTail(e, col));
        parts.push(seg);
      }
      return parts;
    });
  }

  // Column constraints / table constraints up to token index e: keywords, DEFAULT expressions, names as written.
  constraintTail(e, col) {
    const parts = [];
    let name = false; // the next words are a constraint or table name (after CONSTRAINT / REFERENCES)
    while (this.i < e && this.cur.t !== 'end') {
      const t = this.cur;
      if (col && col.default && t.s === col.default.pos) { parts.push(this.expr(col.default)); continue; }
      if (isOpTok(t, '(')) {
        // Constraint parentheses (IDENTITY(1, 1), KEY (a, b), CHECK (…)) stay on the line of their constraint.
        const ident = this.prev && this.prev.t === 'id' && this.prev.k === 'IDENTITY';
        parts.push(ident ? this.none() : this.sp(), this.flatParen());
        name = false;
        continue;
      }
      if (t.t === 'id' && !name && (RESERVED.has(t.k) || CONSTRAINT_KW.has(t.k))) {
        parts.push(this.kw());
        name = t.k === 'CONSTRAINT' || t.k === 'REFERENCES';
        continue;
      }
      parts.push(this.ident());
      // A multi-part name continues through '.'; anything else ends it.
      name = name && (isOpTok(t, '.') || this.isOp('.'));
    }
    return parts;
  }

  typeDoc(dt) {
    const parts = [];
    while (this.cur.t !== 'end' && this.cur.s < dt.end) {
      if (this.isOp('(')) parts.push(this.none(), this.tok());
      else if (this.isOp(',')) parts.push(this.tok(), this.sp());
      else parts.push(this.tok('type'));
    }
    return parts;
  }

  // ----- SELECT, INSERT, UPDATE, DELETE

  // WITH [XMLNAMESPACES (…)[,]] [cte AS (…), …]: one declaration per line, the statement on the next line.
  withClause(ctes, xmlns = null) {
    const parts = [this.kw()];
    if (xmlns) parts.push(this.sp(), this.kw(), this.sp(), this.paren(() => this.genTo(this.close())));
    (ctes ?? []).forEach((c, k) => {
      if (k || xmlns) parts.push(this.glue(c.pos), this.hard());
      else parts.push(this.sp());
      const name = this.ident();
      const cols = this.isOp('(') ? [this.sp(), this.identParen()] : [];
      parts.push(name, cols, this.sp(), this.glue(c.query.pos, 'kw'), this.sp(), this.paren(() => this.query(c.query, false)));
    });
    parts.push(this.hard());
    return parts;
  }

  // OPTION ( hints ): every word is a hint keyword.
  optionDoc(end) {
    if (!this.isKw('OPTION')) return this.gen(end);
    return [this.kw(), this.sp(), this.paren(() => this.genTo(this.close(), true)), this.gen(end, true)];
  }

  selectStmt(n) {
    const parts = [];
    if (n.query.with || n.query.xmlns) parts.push(this.withClause(n.query.with, n.query.xmlns));
    parts.push(this.query(n.query, true));
    if (this.cur.s < n.end) parts.push(this.hard(), this.optionDoc(n.end));
    return parts;
  }

  insertStmt(n) {
    const parts = [];
    if (n.with || n.xmlns) parts.push(this.withClause(n.with, n.xmlns));
    parts.push(this.kw(), this.glue(n.target.pos, 'kw'), this.sp(), this.glueId(n.target.end));
    if (n.cols) parts.push(this.sp(), this.identParen());
    if (n.output) parts.push(this.hard(), this.outputDoc(n.output));
    if (n.defaultValues) parts.push(this.hard(), this.kwIf('DEFAULT'), this.kwIf('VALUES'));
    else if (n.values) parts.push(this.hard(), this.kw(), this.rows(n.values));
    else if (n.query) parts.push(this.hard(), this.query(n.query, true));
    if (this.cur.s < n.end) parts.push(this.hard(), this.optionDoc(n.end));
    return parts;
  }

  updateStmt(n) {
    const parts = [];
    if (n.with || n.xmlns) parts.push(this.withClause(n.with, n.xmlns));
    parts.push(this.kw());
    if (n.top) parts.push(this.sp(), this.topDoc(n.top));
    parts.push(this.sp(), this.glueId(n.target.end));
    parts.push(this.hard(), this.glue(n.sets[0].pos, 'kw'), this.list(n.sets, s => this.setItem(s)));
    this.dmlTail(n, parts);
    return parts;
  }

  deleteStmt(n) {
    const parts = [];
    if (n.with || n.xmlns) parts.push(this.withClause(n.with, n.xmlns));
    parts.push(this.kw());
    if (n.top) parts.push(this.sp(), this.topDoc(n.top));
    parts.push(this.glue(n.target.pos, 'kw'), this.sp(), this.glueId(n.target.end));
    this.dmlTail(n, parts);
    return parts;
  }

  // OUTPUT, FROM, WHERE and OPTION of UPDATE / DELETE.
  dmlTail(n, parts) {
    if (n.output) parts.push(this.hard(), this.outputDoc(n.output));
    if (n.from) parts.push(this.hard(), this.glue(n.from.pos, 'kw'), this.sp(), this.clause(() => this.source(n.from, true)));
    if (n.where) parts.push(this.hard(), this.glue(n.where.pos, 'kw'), this.sp(), this.clause(() => this.expr(n.where)));
    if (this.cur.s < n.end) parts.push(this.hard(), this.optionDoc(n.end));
  }

  setItem(s) {
    return [s.col ? this.glueId(s.col.end) : this.tok(), this.sp(), this.glue(s.expr.pos), this.sp(), this.expr(s.expr)];
  }

  outputDoc(o) {
    const parts = [this.kw(), this.list(o.cols, it => this.selectItem(it))];
    if (o.into) {
      parts.push(this.sp(), this.glue(o.into.pos, 'kw'), this.sp(), this.glueId(o.into.end));
      if (o.intoCols) parts.push(this.sp(), this.identParen());
    }
    return parts;
  }

  // VALUES rows: one row on the line, several inline when they fit, else one per indented line.
  rows(rows) {
    if (rows.length === 1) return [this.sp(), this.row(rows[0])];
    const inner = [];
    rows.forEach((r, k) => {
      if (k) inner.push(this.glue(r.length ? r[0].pos : Infinity));
      inner.push(this.line(), this.row(r));
    });
    return group(indent(inner));
  }

  row(r) {
    return this.paren(() => {
      const parts = [];
      r.forEach((x, k) => {
        if (k) parts.push(this.glue(x.pos), this.line());
        parts.push(this.expr(x));
      });
      return parts;
    });
  }

  topDoc(top) {
    const parts = [this.kw()];
    if (this.isOp('(')) parts.push(this.sp(), this.paren(() => this.expr(top.expr)));
    else parts.push(this.sp(), this.expr(top.expr));
    parts.push(this.glue(top.end, 'kw'));
    return parts;
  }

  // Query: body, ORDER BY, OFFSET, FETCH, FOR JSON. Top-level clauses always start a line; nested ones (subqueries)
  // break together with their parentheses.
  query(q, top) {
    const sep = () => (top ? this.hard() : this.line());
    const parts = [this.node(q.body, (b, w) => this.body(b, top && !w))];
    if (q.orderBy) parts.push(sep(), this.glue(q.orderBy[0].pos, 'kw'), this.list(q.orderBy, it => this.orderItem(it)));
    if (q.offset) parts.push(sep(), this.glue(q.offset.pos, 'kw'), this.sp(), this.expr(q.offset), this.kwIf('ROWS'), this.kwIf('ROW'));
    if (q.fetch) {
      parts.push(sep(), this.glue(q.fetch.pos, 'kw'), this.sp(), this.expr(q.fetch));
      parts.push(this.kwIf('ROWS'), this.kwIf('ROW'), this.kwIf('ONLY'));
    }
    // FOR JSON / FOR XML: every word is a keyword (RAW, PATH, AUTO, EXPLICIT, ELEMENTS, XSINIL, ROOT, TYPE, …), names
    // in parentheses are strings.
    if (q.forJson || q.forXml) parts.push(sep(), this.gen(q.end, true));
    parts.push(this.gen(q.end));
    return parts;
  }

  // Query body: a core, a parenthesized query, or a chain of UNION / EXCEPT / INTERSECT (flattened, left to right).
  body(b, top) {
    if (b.type === 'query') return this.query(b, top);
    if (b.type !== 'setop') return b.type === 'core' ? this.core(b, top) : this.gen(b.end);
    const steps = [];
    let x = b;
    for (;;) {
      steps.push(x);
      const l = x.left;
      if (l.type !== 'setop' || this.wrapped(l, x)) { x = l; break; }
      x = l;
    }
    const sep = () => (top ? this.hard() : this.line());
    const parts = [this.node(x, (y, w) => this.body(y, top && !w))];
    for (let k = steps.length - 1; k >= 0; k--) {
      const s = steps[k];
      parts.push(sep(), this.glue(s.right.pos, 'kw'), sep(), this.node(s.right, (y, w) => this.body(y, top && !w)));
    }
    return parts;
  }

  core(c, top) {
    const sep = () => (top ? this.hard() : this.line());
    const parts = [this.kw()];
    if (c.top) parts.push(this.glue(c.top.pos, 'kw'), this.sp(), this.topDoc(c.top));
    parts.push(this.glue(c.cols[0].pos, 'kw'), this.list(c.cols, it => this.selectItem(it)));
    if (c.into) parts.push(sep(), this.glue(c.into.pos, 'kw'), this.sp(), this.glueId(c.into.end));
    if (c.from) parts.push(sep(), this.glue(c.from.pos, 'kw'), this.sp(), this.clause(() => this.source(c.from, top)));
    if (c.where) parts.push(sep(), this.glue(c.where.pos, 'kw'), this.sp(), this.clause(() => this.expr(c.where)));
    if (c.groupBy) {
      const items = c.groupBy.items;
      parts.push(sep(), this.glue(items[0].pos, 'kw'), this.list(items, g => this.groupItem(g)));
    }
    if (c.having) parts.push(sep(), this.glue(c.having.pos, 'kw'), this.sp(), this.clause(() => this.expr(c.having)));
    return parts;
  }

  selectItem(it) {
    if (it.star) return this.glueId(it.end);
    if (it.assign) return [this.tok(), this.sp(), this.glue(it.expr.pos), this.sp(), this.expr(it.expr)];
    const parts = [];
    const t = this.cur;
    if (t.s < it.expr.pos && (t.t === 'id' || t.t === 'qid' || t.t === 'str') && this.isOp('=', 1)) {
      parts.push(this.ident(), this.sp(), this.glue(it.expr.pos), this.sp());
    } else if (t.s < it.expr.pos) {
      parts.push(this.glue(it.expr.pos));
    }
    parts.push(this.expr(it.expr));
    while (this.cur.t !== 'end' && this.cur.s < it.end) parts.push(this.isKw('AS') ? this.kw() : this.ident());
    return parts;
  }

  orderItem(it) {
    return [this.expr(it.expr), this.glue(it.end, 'kw')];
  }

  groupItem(g) {
    if ((g.type === 'rollup' || g.type === 'cube') && (this.isKw('ROLLUP') || this.isKw('CUBE')) && this.isOp('(', 1)) {
      const flat = g.exprs.flat();
      const monotonic = flat.every((e, k) => k === 0 || e.pos > flat[k - 1].pos);
      if (monotonic) {
        return [this.kw(), this.none(), this.paren(() => {
          const parts = [];
          g.exprs.forEach((elem, k) => {
            if (k) parts.push(this.glue(elem[0].pos), this.line());
            // `(a, b)` is a composite element: its parenthesis comes before its first expression.
            if (this.isOp('(') && this.cur.s < elem[0].pos) {
              parts.push(this.paren(() => elem.map((x, j) => [j ? [this.glue(x.pos), this.line()] : [], this.expr(x)])));
            } else {
              parts.push(this.expr(elem[0]));
            }
          });
          return parts;
        })];
      }
    }
    if (g.type === 'rollup' || g.type === 'cube' || g.type === 'sets') return this.gen(g.end, GROUPING_KW);
    return this.expr(g);
  }

  // ----- table sources

  // A table source: joins, PIVOT and UNPIVOT flattened into steps indented under the first source. Top-level joins
  // start a line each; nested ones break with their group; comma-only lists stay inline when they fit.
  source(n, top) {
    return this.node(n, (x, w) => this.sourceInner(x, top && !w));
  }

  sourceInner(n, top) {
    if (n.type !== 'join' && n.type !== 'pivot' && n.type !== 'unpivot') return this.primary(n);
    const steps = [];
    let x = n;
    for (;;) {
      steps.push(x);
      const l = x.type === 'join' ? x.left : x.source;
      if ((l.type === 'join' || l.type === 'pivot' || l.type === 'unpivot') && !this.wrapped(l, x)) x = l;
      else { x = l; break; }
    }
    steps.reverse();
    const commas = steps.every(s => s.type === 'join' && s.comma);
    const sep = () => (top && !commas ? this.hard() : this.line());
    const first = this.source(x, top);
    const rest = [];
    for (const s of steps) {
      if (s.type === 'pivot') { rest.push(sep(), this.pivot(s)); continue; }
      if (s.type === 'unpivot') { rest.push(sep(), this.unpivot(s)); continue; }
      if (s.comma) { rest.push(this.glue(s.right.pos), sep(), this.source(s.right, top)); continue; }
      rest.push(sep(), this.glue(s.right.pos, 'kw'), this.sp(), this.clause(() => this.source(s.right, top)));
      if (s.on) rest.push(group(indent([this.line(), this.glue(s.on.pos, 'kw'), this.sp(), this.clause(() => this.expr(s.on))])));
    }
    const doc = [first, indent(rest)];
    return commas ? group(doc) : doc;
  }

  primary(n) {
    switch (n.type) {
      case 'table': {
        const parts = [this.glueId(n.name.end)];
        while (this.cur.t !== 'end' && this.cur.s < n.end) {
          if (this.isOp('(')) parts.push(this.sp(), this.paren(() => this.toClose('kw')));
          else parts.push(this.isKw('AS') || this.isKw('WITH') ? this.kw() : this.ident());
        }
        return parts;
      }
      case 'derived': return [this.paren(() => this.query(n.query, false)), this.aliasTail(n.end)];
      case 'values': return [this.paren(() => [this.kw(), this.rows(n.rows)]), this.aliasTail(n.end)];
      case 'tvf': {
        const parts = [this.glueId(n.name.end), this.none(), this.args(n.args)];
        if (n.withSchema) parts.push(this.sp(), this.kw(), this.sp(), this.jsonSchema(n.withSchema));
        parts.push(this.aliasTail(n.end));
        return parts;
      }
      // x.nodes('path') AS t (c).
      case 'xmlnodes': return [this.expr(n.e), this.aliasTail(n.end)];
      default: return this.gen(n.end);
    }
  }

  // [AS] alias [(columns)] up to end.
  aliasTail(end) {
    const parts = [];
    while (this.cur.t !== 'end' && this.cur.s < end) {
      if (this.isOp('(')) parts.push(this.sp(), this.identParen());
      else parts.push(this.isKw('AS') ? this.kw() : this.ident());
    }
    return parts;
  }

  // OPENJSON … WITH ( name type ['path'] [AS JSON], … )
  jsonSchema(cols) {
    return this.paren(() => {
      const parts = [];
      const c = this.close();
      let k = 0;
      while (this.i < c && this.cur.t !== 'end') {
        if (this.isOp(',')) { parts.push(this.tok(), this.line()); continue; }
        const col = cols[k++];
        const seg = [this.ident()];
        if (col && this.cur.s === col.dataType.pos) seg.push(this.sp(), this.typeDoc(col.dataType));
        while (this.i < c && this.cur.t !== 'end' && !this.isOp(',')) seg.push(this.tok('kw'));
        parts.push(seg);
      }
      return parts;
    });
  }

  pivot(p) {
    const head = [this.kw(), this.sp()];
    const body = this.paren(() => {
      const parts = [this.expr(p.agg), this.sp(), this.glue(p.forCol.pos, 'kw'), this.sp(), this.expr(p.forCol), this.sp()];
      parts.push(this.untilParen(), this.sp(), this.identParen());
      return parts;
    });
    return [head, body, this.aliasTail(p.end)];
  }

  unpivot(u) {
    const head = [this.kw(), this.sp()];
    const body = this.paren(() => [this.ident(), this.sp(), this.kw(), this.sp(), this.ident(), this.sp(), this.kw(), this.sp(), this.identParen()]);
    return [head, body, this.aliasTail(u.end)];
  }

  // ----- expressions

  expr(e) {
    return this.node(e, x => this.exprInner(x), true);
  }

  exprInner(e) {
    switch (e.type) {
      case 'lit':
        if (this.cur.t === 'op' && (this.isOp('-') || this.isOp('+'))) return [this.tok(), this.none(), this.tok()];
        return this.glue(e.end);
      case 'col': return this.glueId(e.end);
      case 'var': return this.tok();
      case 'datepart': return this.ident();
      case 'default': return this.kw();
      case 'bin':
        if (e.op === 'AND' || e.op === 'OR') return group(this.chain(e));
        if (ADDITIVE.has(e.op)) return this.opChain(e, ADDITIVE);
        if (MULTIPLICATIVE.has(e.op)) return this.opChain(e, MULTIPLICATIVE);
        // A comparison: the parser never chains them (`a = b = c` does not parse), so this recursion is shallow.
        return [this.expr(e.l), this.sp(), this.glue(e.r.pos), this.sp(), this.expr(e.r)];
      case 'neg': return [this.tok(), this.none(), this.expr(e.e)];
      case 'not': return [this.kw(), this.sp(), this.expr(e.e)];
      case 'paren':
        if (e.e.type === 'bin' && (e.e.op === 'AND' || e.e.op === 'OR')) return this.paren(() => this.node(e.e, x => this.chain(x, true)));
        // ((x)): the outer parenthesis hugs the inner one instead of opening a block of its own.
        if (e.e.type === 'paren' || e.e.type === 'subq') {
          const close = this.match[this.i];
          const inner = [this.tok(), this.none(), this.expr(e.e)];
          return [inner, close >= 0 ? this.genTo(close) : [], close >= 0 && this.i === close ? this.tok() : []];
        }
        return this.paren(() => this.expr(e.e));
      case 'subq': return this.paren(() => this.query(e.query, false));
      case 'exists': return [this.kw(), this.sp(), this.paren(() => this.query(e.query, false))];
      case 'isnull': return [this.expr(e.e), this.sp(), this.glue(e.end, 'kw')];
      case 'between':
        return [this.expr(e.e), this.sp(), this.glue(e.lo.pos, 'kw'), this.sp(), this.expr(e.lo), this.sp(), this.glue(e.hi.pos, 'kw'), this.sp(), this.expr(e.hi)];
      case 'like': {
        const parts = [this.expr(e.e), this.sp(), this.glue(e.pattern.pos, 'kw'), this.sp(), this.expr(e.pattern)];
        if (e.escape) parts.push(this.sp(), this.glue(e.escape.pos, 'kw'), this.sp(), this.expr(e.escape));
        return parts;
      }
      case 'in': {
        const parts = [this.expr(e.e), this.sp(), this.untilParen(), this.sp()];
        parts.push(e.list ? this.inList(e.list) : this.paren(() => this.query(e.query, false)));
        return parts;
      }
      case 'quantified': return [this.expr(e.l), this.sp(), this.untilParen(), this.sp(), this.paren(() => this.query(e.query, false))];
      case 'distinctfrom': return [this.expr(e.l), this.sp(), this.glue(e.r.pos, 'kw'), this.sp(), this.expr(e.r)];
      case 'case': return this.caseExpr(e);
      case 'cast': return this.cast(e);
      case 'collate': case 'xmlmethod': return this.postfixChain(e);
      case 'fn': return isPostfix(e) ? this.postfixChain(e) : this.fn(e);
      default: return this.gen(e.end);
    }
  }

  // A chain of postfix operators (COLLATE name, AT TIME ZONE zone and the xml methods .value(…), .query(…),
  // .exist(…), .nodes(…)), flattened along its operand: the parser builds such chains in a loop without a depth
  // limit, so they are laid out by a loop too. A chain of several operators stays on one line when it fits, else
  // every operator after the first starts an indented line (`@x.query('/a')` + newline + `.value('.', 'int')`). A
  // method name keeps its letter case; its arguments break like a function's.
  postfixChain(e) {
    const steps = [];
    let x = e;
    while (isPostfix(x)) {
      steps.push(x);
      x = x.type === 'fn' ? x.args[0] : x.e;
    }
    const base = this.expr(x);
    const docs = [];
    for (let k = steps.length - 1; k >= 0; k--) {
      const s = steps[k];
      const first = k === steps.length - 1;
      if (s.type === 'collate') docs.push([first ? this.sp() : this.line(), this.kw(), this.sp(), this.ident()]);
      else if (s.type === 'fn') docs.push([first ? this.sp() : this.line(), this.glue(s.args[1].pos, 'kw'), this.sp(), this.expr(s.args[1])]);
      else docs.push([first ? [] : this.soft(), this.tok(), this.ident(), this.none(), this.args(s.args)]);
    }
    if (docs.length === 1) return [base, docs[0]];
    return group([base, docs[0], indent(docs.slice(1))]);
  }

  // AND / OR chain (same operator, flattened): breaks before each operator. Inside parentheses it shares their group.
  // An AND chain that starts an OR chain (`deep`) indents its own continuation lines deeper than the OR lines, so the
  // precedence shows (`a AND b OR c`: AND lines under the first operand, OR lines at the chain's level).
  chain(e, inParen = false, deep = false) {
    // (Parentheses always make a 'paren' node, so the left spine of the chain is never wrapped.)
    const ops = [];
    let x = e;
    while (x.type === 'bin' && x.op === e.op) { ops.push(x.r); x = x.l; }
    ops.push(x);
    ops.reverse();
    // The AND chain that starts an OR chain: only its continuation lines go deeper; its first token stays at the
    // chain's level (where a comment on its own line before it is written).
    const first = e.op === 'OR' && ops[0].type === 'bin' && ops[0].op === 'AND'
      ? this.node(ops[0], y => group(this.chain(y, false, true)), true)
      : this.expr(ops[0]);
    const rest = [];
    for (let k = 1; k < ops.length; k++) rest.push(this.line(), this.glue(ops[k].pos, 'kw'), this.sp(), this.expr(ops[k]));
    if (inParen) return [first, rest];
    return [first, deep ? indent(indent(rest)) : indent(rest)];
  }

  // A chain of operators of one precedence level (`set`: ADDITIVE + - & | ^ or MULTIPLICATIVE * / %), flattened along
  // its left spine (no recursion per operator): breaks before the operators when it does not fit.
  opChain(e, set) {
    const ops = [];
    let x = e;
    while (x.type === 'bin' && set.has(x.op)) { ops.push(x.r); x = x.l; }
    ops.push(x);
    ops.reverse();
    const first = this.expr(ops[0]);
    const rest = [];
    for (let k = 1; k < ops.length; k++) rest.push(this.line(), this.glue(ops[k].pos), this.sp(), this.expr(ops[k]));
    return group([first, indent(rest)]);
  }

  // IN ( list ): plain values are packed into full lines, other items one per line when the list breaks.
  inList(list) {
    const simple = list.every(x => x.type === 'lit' || x.type === 'var' || x.type === 'col');
    return this.paren(() => {
      if (!simple) {
        const parts = [];
        list.forEach((x, k) => {
          if (k) parts.push(this.glue(x.pos), this.line());
          parts.push(this.expr(x));
        });
        return parts;
      }
      const items = list.map((x, k) => [this.expr(x), k + 1 < list.length ? this.glue(list[k + 1].pos) : []]);
      return { k: 'fill', items };
    });
  }

  caseExpr(e) {
    const head = [this.kw()];
    if (e.operand) head.push(this.sp(), this.expr(e.operand));
    const body = [];
    for (const [w, t] of e.whens) {
      body.push(this.line(), group([this.glue(w.pos, 'kw'), this.sp(), this.expr(w), indent([this.line(), this.glue(t.pos, 'kw'), this.sp(), this.expr(t)])]));
    }
    if (e.else) body.push(this.line(), this.glue(e.else.pos, 'kw'), this.sp(), this.expr(e.else));
    // Comments on their own lines before END are indented like END (01 §1 rule 2).
    const lc = this.leadingOnly();
    return group([head, indent(body), lc, this.line(), this.glue(e.end, 'kw')]);
  }

  cast(e) {
    const name = this.tok('fn');
    const isCast = e.dataType.pos > e.e.pos;
    const inner = () => (isCast
      ? [this.expr(e.e), this.sp(), this.glue(e.dataType.pos, 'kw'), this.sp(), this.typeDoc(e.dataType)]
      : [this.typeDoc(e.dataType), this.glue(e.e.pos), this.line(), this.expr(e.e),
        e.style ? [this.glue(e.style.pos), this.line(), this.expr(e.style)] : []]);
    return [name, this.none(), this.paren(inner), this.gen(e.end)];
  }

  // Arguments ( a, b ) of a function or table-valued function; other words between arguments (DISTINCT, FROM of TRIM,
  // LEADING …) are keywords on the line.
  args(list, star = false) {
    return this.paren(() => {
      if (star) return this.toClose();
      const parts = [];
      list.forEach((a, k) => {
        if (k) parts.push(this.isOp(',') ? [this.glue(a.pos), this.line()] : [this.sp(), this.glue(a.pos, 'kw'), this.sp()]);
        else if (this.cur.s < a.pos && !this.wrapRun(a.pos)) parts.push(this.glue(a.pos, 'kw'), this.sp());
        parts.push(this.expr(a));
      });
      return parts;
    });
  }

  fn(e) {
    const call = this.isOp('(', 1) || (e.schema && this.isOp('(', 3));
    if (!call) return [this.kw(), this.gen(e.end)];
    const parts = [];
    // schema.name(…) is a user function: its name keeps its letter case like any other object name.
    if (e.schema) parts.push(this.ident(), this.tok(), this.ident());
    else parts.push(this.tok('fn'));
    parts.push(this.none(), this.args(e.args, e.star));
    if (e.withinGroup) {
      parts.push(this.sp(), this.untilParen(), this.sp(), this.paren(() => [this.glue(e.withinGroup[0].pos, 'kw'), this.list(e.withinGroup, it => this.orderItem(it))]));
    }
    if (e.over) parts.push(this.sp(), this.kw(), this.sp(), this.over(e.over));
    parts.push(this.gen(e.end));
    return parts;
  }

  // OVER ( PARTITION BY … ORDER BY … frame ): inline when it fits, else one clause per line.
  over(o) {
    return this.paren(() => {
      const parts = [];
      if (o.partitionBy.length) parts.push(this.glue(o.partitionBy[0].pos, 'kw'), this.list(o.partitionBy, x => this.expr(x)));
      if (o.orderBy.length) {
        if (parts.length) parts.push(this.line());
        parts.push(this.glue(o.orderBy[0].pos, 'kw'), this.list(o.orderBy, it => this.orderItem(it)));
      }
      if (o.frame) {
        if (parts.length) parts.push(this.line());
        parts.push(this.toClose('kw'));
      }
      return parts;
    });
  }

  // ----- script

  goLine(n) {
    const parts = [this.kw()];
    if (this.cur.t === 'num' && this.cur.s < n.end) parts.push(this.sp(), this.tok());
    parts.push(this.gen(n.end));
    return parts;
  }

  // True when the token at pos (the start of a kept piece or of the tail) is the word GO on the line of what comes
  // before it: on a line of its own it could become a batch separator (01 §4.5).
  goOnLine(pos) {
    const t = this.T[this.idx(pos)];
    return isKwTok(t, 'GO') && t.nl === 0;
  }

  // Whether the ';' run before pos keeps its comments in place (semis): before a kept piece or tail that starts with
  // GO on the run's line, and at the end of a text without a final line break (a line comment moved after the run
  // would end the text, so text after a formatted selection would join that comment).
  keepAt(pos) {
    return pos < Infinity ? this.goOnLine(pos) : !this.endNl;
  }

  // True when the current token, with no comment before it, continues the line of what was printed last.
  sameLine() {
    const t = this.cur;
    return t.t !== 'end' && t.nl === 0 && this.done[this.i] === t.pre.length;
  }

  // True when the last line of an item kept as written starts with the word GO (the item's last token is the one
  // before the cursor): moving what follows it on that line to a new line could make it a batch separator.
  goLast(it) {
    const first = this.idx(it.pos);
    for (let k = this.i - 1; k >= first && k >= 0; k--) {
      const t = this.T[k];
      if (k === first || t.nl > 0) return isKwTok(t, 'GO');
      if (t.pre.some(c => c.nlBefore > 0 || /[\r\n]/.test(c.text))) return false;
    }
    return false;
  }

  // Whether item it (k > 0) continues the line of the item before it: a kept piece that starts with GO on that line
  // in the source, or anything that followed, on its line, a kept item whose last line starts with GO.
  glueBefore(it, prev) {
    if (it.kind === 'fail' && this.cur.s === it.pos && this.goOnLine(it.pos) && this.sameLine()) return true;
    const kept = prev.kind === 'fail' || (prev.kind === 'stmt' && (this.levels.get(prev.id) ?? 0) >= 2);
    return kept && !!this.prev && this.prev.e === prev.end && this.sameLine() && this.goLast(prev);
  }

  // Separator before the unterminated tail: the white space before it in the source (a space when it continues a
  // line, else a line break or a blank line), scanned backwards to the last character that was printed; always a
  // space after a comment that was moved before it (after a ';' run).
  tailSep() {
    const src = this.src;
    let k = this.tail;
    for (; k > 0; k--) {
      const c = src.charCodeAt(k - 1);
      if (!(c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 0xa0)) break;
    }
    let nl = 0;
    for (let j = k; j < this.tail; j++) if (isBreak(src, j)) nl++;
    if (nl >= 2) return BLANK;
    if (nl) return HARD;
    return k < this.tail || this.cmtAfter ? SP : [];
  }

  script() {
    const parts = [];
    const items = this.items;
    let lastGo = false;
    items.forEach((it, k) => {
      this.item = it;
      const level = this.levels.get(it.id) ?? 0;
      this.caseOn = level === 0;
      if (k) parts.push(this.stmtSep(this.glueBefore(it, items[k - 1])));
      else { this.stmtLevel = true; this.sep = true; }
      const lead = this.semis(it.pos);
      parts.push(lead);
      // A ';' run before a GO line (an empty batch) keeps a line of its own, so the GO line stays a separator.
      if (lead.length && (it.kind === 'go' || it.kind === 'gofail')) parts.push(this.stmtSep());
      parts.push({ k: 'mark', m: it.mark, end: false });
      if (it.kind === 'go') parts.push(this.goLine(it.node));
      else if (it.kind === 'gofail') parts.push(this.verbatim(it.pos, it.end, it.check));
      else if (it.kind === 'fail') parts.push(this.verbatim(it.pos, it.end, it.check));
      else if (level >= 2) parts.push(this.verbatim(it.pos, it.end, null));
      else parts.push(this.statement(it.node, it.end));
      parts.push(this.gen(it.end));
      // ';' after a GO line start the next line (written with the next statement), so the GO line stays alone; the
      // comments on the GO line stay on it.
      lastGo = it.kind === 'go' || it.kind === 'gofail';
      if (lastGo) this.trailing(this.i - 1, parts, true);
      parts.push({ k: 'mark', m: it.mark, end: true });
      if (!lastGo) {
        const next = k + 1 < items.length ? items[k + 1].pos : this.tail;
        parts.push(this.semis(next, this.keepAt(next)));
      }
    });
    this.item = null;
    this.caseOn = true;
    if (this.isOp(';') && this.cur.s < this.tail) {
      if (lastGo) parts.push(this.hard());
      parts.push(this.semis(this.tail, this.keepAt(this.tail)));
    }
    while (this.cur.t !== 'end' && this.cur.s < this.tail) parts.push(this.tok());
    this.stmtLevel = true;
    this.noBlank = false;
    if (this.tail < Infinity) {
      if (this.leading(this.i, parts)) {
        this.sep = true;
        this.cmtAfter = false;
      }
      parts.push(this.tailSep(), { k: 'mark', m: this.tailMark, end: false }, { k: 'alt', a: this.src.slice(this.tail), b: '' });
    } else {
      parts.push(this.leadingOnly());
    }
    return parts;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Verification

const SKIP = new Set(['pos', 'end']);

// The next key of object o at index k or after that is not a position (a numeric pos or end), else keys.length.
function nextKey(o, keys, k) {
  while (k < keys.length && SKIP.has(keys[k]) && typeof o[keys[k]] === 'number') k++;
  return k;
}

// True when two AST values are equal apart from their positions: the same types and values (-0 is not 0; NaN equals
// NaN), objects with the same keys in the same order, arrays element by element, Sets with the same members (as
// text). Iterative: chains of thousands of operators are deep.
function sameAst(x, y) {
  const st = [x, y];
  while (st.length) {
    const b = st.pop();
    const a = st.pop();
    const t = typeof a;
    if (t !== typeof b) return false;
    if (t === 'number') {
      if (a === b ? a === 0 && 1 / a !== 1 / b : !(a !== a && b !== b)) return false;
      continue;
    }
    if (a === b) continue;
    if (t !== 'object' || a === null || b === null) return false;
    if (a instanceof Set || b instanceof Set) {
      if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
      const sa = [...a].map(String).sort();
      const sb = [...b].map(String).sort();
      if (sa.some((v, k) => v !== sb[k])) return false;
      continue;
    }
    const arr = Array.isArray(a);
    if (arr !== Array.isArray(b)) return false;
    if (arr) {
      if (a.length !== b.length) return false;
      for (let k = 0; k < a.length; k++) st.push(a[k], b[k]);
      continue;
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    let i = nextKey(a, ka, 0);
    let j = nextKey(b, kb, 0);
    while (i < ka.length && j < kb.length) {
      if (ka[i] !== kb[j]) return false;
      st.push(a[ka[i]], b[kb[j]]);
      i = nextKey(a, ka, i + 1);
      j = nextKey(b, kb, j + 1);
    }
    if (i < ka.length || j < kb.length) return false;
  }
  return true;
}

// Index of the last item whose key (mark.start in the output, or pos in the source) is at most q, else 0. Items are
// in text order, so both keys increase.
function lastAtOrBefore(items, q, key) {
  let lo = 0;
  let hi = items.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]) <= q) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

const outKey = it => it.mark.start;
const srcKey = it => it.pos;

// The item printed at output offset q, or the last one starting before it (else the first).
function itemNear(items, q) {
  return items.length ? items[lastAtOrBefore(items, q, outKey)] : null;
}

// Every item gets an output start (one that printed nothing gets the start of the one before it).
function fixMarks(items) {
  let last = 0;
  for (const it of items) {
    if (it.mark.start < 0) it.mark.start = last;
    if (it.mark.end < it.mark.start) it.mark.end = it.mark.start;
    last = it.mark.start;
  }
}

// GO separator lines of the formatted text that are not original GO lines: the statements to retry, or null when one
// lies in a piece kept as written, in the tail or outside every item (formatting would change the batches).
function goCulprits(items, tailMark, text) {
  const bad = new Set();
  const seen = new Set();
  for (const g of goLinesOf(tokenize(text, true))) {
    if (tailMark.start >= 0 && g.pos >= tailMark.start) return null;
    const it = items.length ? items[lastAtOrBefore(items, g.pos, outKey)] : null;
    if (!it || g.pos < it.mark.start || g.pos >= it.mark.end) return null;
    if (it.kind === 'go' || it.kind === 'gofail') {
      if (seen.has(it)) return null;
      seen.add(it);
    } else if (it.kind === 'stmt') {
      bad.add(it);
    } else {
      return null;
    }
  }
  return [...bad];
}

// The check text spliced from the output and the 'alt' ranges render() listed.
function spliced(text, alts) {
  if (!alts.length) return text;
  const parts = [];
  let at = 0;
  for (const x of alts) {
    parts.push(text.slice(at, x.s), x.b);
    at = x.e;
  }
  parts.push(text.slice(at));
  return parts.join('');
}

// Where the first batch of an output ends: the start of the line of its first GO line (an item's mark, 01 §4.5).
function firstCut(items, text) {
  for (const it of items) if (it.kind === 'go' || it.kind === 'gofail') return lineStart(text, it.mark.start);
  return Infinity;
}

// [] when the check text parses (its first batch in the analysis' context ctx) to the same statements and warnings
// as the original, else the items to retry. Each output statement belongs to the item printed where it starts, and
// every item must parse to exactly its own statements, so all the mismatching items are found in one round.
function verify(items, origWarnings, checkText, po, ctx) {
  let out;
  try {
    out = parseIn(checkText, po, ctx, firstCut(items, checkText), () => ctxPrelude(ctx), false);
  } catch (e) {
    return [itemNear(items, e instanceof SqlError ? e.pos ?? 0 : 0)];
  }
  if (!items.length) return out.length ? [null] : [];
  const got = new Array(items.length);
  let p = 0;
  for (const s of out) {
    while (p + 1 < items.length && items[p + 1].mark.start <= s.pos) p++;
    (got[p] ??= []).push(s);
  }
  const bad = [];
  items.forEach((it, k) => {
    const a = it.asts;
    const b = got[k] ?? [];
    if (a.length !== b.length || a.some((x, j) => !sameAst(x, b[j]))) bad.push(it);
  });
  if (bad.length) return bad;
  const a = origWarnings;
  const b = out.warnings ?? [];
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    if (a[k] && b[k] && a[k].text === b[k].text) continue;
    // Both places a missing or extra warning may come from.
    const res = [];
    if (b[k]) res.push(itemNear(items, b[k].pos));
    if (a[k]) res.push(items[lastAtOrBefore(items, a[k].pos, srcKey)]);
    return res.length ? res : [null];
  }
  return [];
}

// ---------------------------------------------------------------------------------------------------------------
// Entry point

// Formats SQL text: layout and keyword case only; comments kept; statements that do not parse kept unchanged.
export function formatSql(src, opts) {
  return formatSqlReport(src, opts).text;
}

// formatSql with a report of what was not fully formatted: `kept` lists source ranges [{start, end, reason}] with
// reason 'error' (the statement or GO line does not parse: kept byte for byte), 'unterminated' (from an
// unterminated string, quoted identifier or comment to the end), 'case' (formatted with its letter case kept) or
// 'unformatted' (kept unchanged because its formatted text did not parse to the same statement).
export function formatSqlReport(src, opts) {
  if (typeof src !== 'string') return { text: '', kept: [] };
  try {
    const given = readOptions(opts);
    // A text that starts inside a comment, string or quoted identifier (a selection, opts.state) is not SQL text.
    if (src && startsInside(given.state)) return { text: src, kept: [{ start: 0, end: src.length, reason: 'unterminated' }] };
    if (!/\S/.test(src)) return { text: src, kept: [] };
    return formatText(src, given);
  } catch {
    return { text: src, kept: [{ start: 0, end: src.length, reason: 'unformatted' }] };
  }
}

// formatSqlReport for a string with something besides white space and readOptions' copy of the options (may throw
// only on an internal error, e.g. a stack overflow). With display names, a statement that ends up kept 'unformatted'
// (kept unchanged, 01 §1) is laid out again without its aliases, and when the text with the aliases cannot be laid
// out at all, the caller's text is laid out without any.
function formatText(src, given) {
  const o = options(given, src);
  const prep = prepare(src);
  const an = analyze(src, prep, o.po);
  if (!an) return { text: src, kept: [{ start: 0, end: src.length, reason: prep.open < Infinity ? 'unterminated' : 'error' }] };
  if (o.names) {
    const skip = new Set(); // statements (indexes into an.stmts) whose aliases are left out
    for (let attempt = 0; attempt < 3; attempt++) {
      const named = addDisplayNames(src, prep, an, o, skip);
      if (!named) break;
      const r = layout(named.src, named.prep, named.an, o, named.map, src.length);
      if (r.whole) break;
      const more = [...r.unformatted].filter(x => named.aliased.has(x) && !skip.has(x));
      if (!more.length) return r.result;
      for (const x of more) skip.add(x);
    }
  }
  return layout(src, prep, an, o, null, src.length).result;
}

// Lays out an analysed text and verifies the result: {result: {text, kept}, whole (the text could not be laid out
// and is returned unchanged), unformatted (the indexes into an.stmts of the statements kept 'unformatted')}. `map`
// turns offsets of src back into offsets of the caller's text (display names inserted; null when src is that
// text), whose length is `len`.
function layout(src, prep, an, o, map, len) {
  const back = map ?? (p => p);
  const none = new Set();
  const whole = reason => ({ result: { text: src, kept: [{ start: 0, end: len, reason }] }, whole: true, unformatted: none });
  const report = kept => kept.map(k => ({ start: back(k.start), end: back(k.end), reason: k.reason }));
  const items = itemsOf(an);
  for (const it of items) {
    it.asts = it.stmts.map(x => an.stmts[x]);
    // The text verify() reads in place of a kept piece: the analysed text there (failing statements filled, GO
    // counts made valid; comments between failing statements kept, with their warnings).
    if (it.kind === 'gofail' || it.kind === 'fail') it.check = an.text.slice(it.pos, it.end);
  }
  const levels = new Map();
  // Selection edges: a leading line break, and a final line break or final spaces, are kept as one.
  const head = prep.leadNl ? o.eol : '';
  const foot = an.tail < Infinity ? '' : prep.endNl ? o.eol : prep.endWs ? ' ' : '';
  // GO separators can only come from GO tokens: they need checking when a GO token is not an original GO line.
  const goItems = items.reduce((n, it) => n + (it.kind === 'go' || it.kind === 'gofail' ? 1 : 0), 0);
  const goCheck = prep.gos > goItems;
  const filled = an.failing.length > 0 || an.goFails.length > 0 || an.tail < Infinity;
  // Each round that fails moves at least one statement a level down (case kept, then unchanged).
  const rounds = 2 * items.length + 2;
  for (let round = 0; round < rounds; round++) {
    const b = new Builder(src, prep, o, items, levels, an.tail);
    let doc = null;
    try {
      doc = b.script();
    } catch {
      // An internal failure while laying out a statement: that statement is retried, then kept unchanged and
      // reported in `kept` ('case' / 'unformatted'), never dropped or altered.
      doc = null;
    }
    if (!doc) {
      if (!escalate(items, levels, [b.item])) return whole('unformatted');
      continue;
    }
    propagate(doc);
    const alts = filled ? [] : null;
    const text = render(doc, o, alts);
    fixMarks(items);
    if (goCheck) {
      const culprits = goCulprits(items, b.tailMark, text);
      if (!culprits) return whole('unformatted');
      if (culprits.length) {
        if (!escalate(items, levels, culprits)) return whole('unformatted');
        continue;
      }
    }
    const bad = verify(items, an.stmts.warnings ?? [], filled ? spliced(text, alts) : text, o.po, an.ctx);
    if (!bad.length) {
      const unformatted = new Set();
      for (const it of items) if (it.kind === 'stmt' && (levels.get(it.id) ?? 0) >= 2) for (const x of it.stmts) unformatted.add(x);
      return { result: { text: head + text + foot, kept: report(keptRanges(src, items, levels, an.tail)) }, whole: false, unformatted };
    }
    if (!escalate(items, levels, bad)) return whole('unformatted');
  }
  return whole('unformatted');
}

// ---------------------------------------------------------------------------------------------------------------
// Format › Add display names (03 §5): opts.displayNames(table, column, {schema, alias}) -> label | null. Before
// the layout, each select-list item that is a bare column reference without an alias, in the result select list of a
// SELECT statement or cursor declaration (the first query of a set operation; also inside BEGIN…END, IF, WHILE and
// TRY…CATCH), and that binds to a Dataverse table of that query's FROM clause, gets ` AS [label]` (sqlIdent), unless
// an ORDER BY item binds to it by name. The text with the aliases is analysed again and must parse to the same
// statements with exactly those aliases set, else no alias is added.

// Characters a label may not contain: control characters, line and paragraph separators, and the invisible characters
// that raise the parser's warning (01 §4.5).
const BAD_LABEL = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;

// The label displayNames gives for table.column, or null (not a string, blank, over 128 characters: an identifier's
// limit, 103; bad characters; or the callback threw).
function labelOf(fn, table, column, info) {
  let v;
  try {
    v = fn(table, column, info);
  } catch {
    return null;
  }
  if (typeof v !== 'string' || !v.trim() || v.length > 128 || BAD_LABEL.test(v) || !v.isWellFormed()) return null;
  return v;
}

// The names a query exposes as columns (lower case), or null when they cannot be told from the text (`*`).
function queryNames(q) {
  let b = q;
  while (b.type !== 'core') b = b.type === 'query' ? b.body : b.left;
  const names = new Set();
  for (const it of b.cols) {
    if (it.star) return null;
    if (it.alias != null) names.add(it.alias.toLowerCase());
    else if (it.expr && it.expr.type === 'col') names.add(it.expr.parts[it.expr.parts.length - 1].toLowerCase());
  }
  return names;
}

// The column names of a table-valued function source, or null when unknown: its alias column list, its OPENJSON …
// WITH schema, or the columns SQL Server defines for the built-in functions (01 §8): STRING_SPLIT value (ordinal
// with a third argument, which may be enable_ordinal = 1), GENERATE_SERIES value, OPENJSON key/value/type and
// sys.fn_helpcollations() name/description. Other functions (Dataverse messages) have unknown columns.
function tvfColumns(x) {
  if (x.columns) return x.columns;
  if (x.withSchema) return x.withSchema.map(c => c.name);
  const p = x.name.parts;
  const name = p[p.length - 1].toLowerCase();
  const schema = p.length > 1 ? p[p.length - 2].toLowerCase() : null;
  if (p.length === 1) {
    if (name === 'string_split') return x.args.length > 2 ? ['value', 'ordinal'] : ['value'];
    if (name === 'generate_series') return ['value'];
    if (name === 'openjson') return ['key', 'value', 'type'];
  }
  if (name === 'fn_helpcollations' && p.length <= 2 && (schema === null || schema === 'sys')) return ['name', 'description'];
  return null;
}

// The sources of a FROM clause: [{exposed (lower-case name a column qualifier matches), table, schema (as written,
// or null), alias, dv (a Dataverse table), cols (non-table sources: the column names, lower case, or null when
// unknown)}]. CTE references are sources with the CTE's columns; table variables (with the columns of their DECLARE
// in `tvars`, lower-case variable name -> Set), #temp tables and the metadata and sys schemas (columns unknown here:
// format.js does not import metatables.js, 00 §3) are not Dataverse tables.
function sourcesOf(from, ctes, tvars) {
  const out = [];
  const st = [from];
  const lc = s => (s == null ? null : s.toLowerCase());
  const named = cols => (cols ? new Set(cols.map(c => c.toLowerCase())) : null);
  while (st.length) {
    const x = st.pop();
    switch (x.type) {
      case 'join': st.push(x.right, x.left); break;
      case 'table': {
        const p = x.name.parts;
        const table = p[p.length - 1];
        const schema = p.length > 1 ? p[p.length - 2] : null;
        const exposed = lc(x.alias ?? table);
        const cte = schema === null ? ctes.get(lc(table)) : undefined;
        if (cte) { out.push({ exposed, dv: false, cols: cte.columns ? named(cte.columns) : queryNames(cte.query) }); break; }
        if (table.startsWith('@')) out.push({ exposed, dv: false, cols: tvars.get(lc(table)) ?? null });
        else if (table.startsWith('#') || lc(schema) === 'metadata' || lc(schema) === 'sys') out.push({ exposed, dv: false, cols: null });
        else out.push({ exposed, table, schema, alias: x.alias ?? null, dv: true, cols: null });
        break;
      }
      case 'derived': out.push({ exposed: lc(x.alias), dv: false, cols: x.columns ? named(x.columns) : queryNames(x.query) }); break;
      case 'values': case 'xmlnodes': out.push({ exposed: lc(x.alias), dv: false, cols: named(x.columns) }); break;
      case 'tvf': out.push({ exposed: lc(x.alias ?? x.name.parts[x.name.parts.length - 1]), dv: false, cols: named(tvfColumns(x)) }); break;
      default: out.push({ exposed: lc(x.alias), dv: false, cols: null }); break; // PIVOT, UNPIVOT
    }
  }
  return out;
}

// The lower-case names of the whole ORDER BY items that are a bare unqualified column (`ORDER BY name`, also in
// parentheses) of query q and of the queries on the way from q to its result select list (the left branch of each
// set operation): such an item binds to a select-list item by its name (01 §7.1).
function orderNames(q) {
  const out = new Set();
  for (let x = q; x.type !== 'core';) {
    if (x.type === 'setop') { x = x.left; continue; }
    for (const it of x.orderBy ?? []) {
      let e = it.expr;
      while (e && e.type === 'paren') e = e.e;
      if (e && e.type === 'col' && e.parts.length === 1) out.add(e.parts[0].toLowerCase());
    }
    x = x.body;
  }
  return out;
}

// True when an ORDER BY item of the query would bind differently once `it` (a column reference) is named `label`:
// an ORDER BY name equals the label, or equals the column's name while the column is qualified (the name then binds
// to the FROM sources, or on a set operation is not a result name: 104) or another item of the list is aliased with
// that name.
function orderBinds(it, label, cols, order) {
  if (!order.size) return false;
  if (order.has(label.toLowerCase())) return true;
  const own = it.expr.parts[it.expr.parts.length - 1].toLowerCase();
  if (!order.has(own)) return false;
  return it.expr.parts.length > 1 || cols.some(o => o !== it && o.alias != null && o.alias.toLowerCase() === own);
}

// The label of a column reference (col parts) over the FROM sources, or null. A qualified name binds to the one
// source it names (`schema.table.column` only to a table written without an alias); an unqualified one to the only
// Dataverse table that has a label for it, when no other source may have such a column.
function labelFor(fn, parts, sources) {
  const column = parts[parts.length - 1];
  let cands;
  if (parts.length === 1) {
    const key = column.toLowerCase();
    if (sources.some(s => !s.dv && (s.cols === null || s.cols.has(key)))) return null;
    cands = sources.filter(s => s.dv);
  } else {
    const q = parts[parts.length - 2].toLowerCase();
    const sch = parts.length > 2 ? parts[parts.length - 3].toLowerCase() : null;
    cands = sources.filter(s => s.exposed === q &&
      (sch === null || (s.dv && s.alias === null && (s.schema ?? 'dbo').toLowerCase() === sch)));
    if (cands.length !== 1 || !cands[0].dv) return null;
  }
  let found = null;
  for (const s of cands) {
    const label = labelOf(fn, s.table, column, Object.freeze({ schema: s.schema, alias: s.alias }));
    if (label === null) continue;
    if (found !== null) return null;
    found = label;
  }
  return found;
}

// The display-name aliases for the statements of an analysis: [{pos, text, item, label, stmt (index into stmts)}] in
// text order.
function displayAliases(src, stmts, o) {
  const out = [];
  const st = [];
  // The table variables the batch declared so far (text order: a DECLARE precedes every use, 137), with their columns.
  const tvars = new Map();
  for (let k = stmts.length - 1; k >= 0; k--) st.push([stmts[k], k]);
  while (st.length) {
    const [s, top] = st.pop();
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'go') { tvars.clear(); continue; }
    if (s.type === 'declare') {
      for (const v of s.vars) if (v.table) tvars.set(v.name.toLowerCase(), new Set(v.table.map(c => c.name.toLowerCase())));
      continue;
    }
    if (s.type === 'block') { for (let k = s.body.length - 1; k >= 0; k--) st.push([s.body[k], top]); continue; }
    if (s.type === 'if') { st.push([s.else, top], [s.then, top]); continue; }
    if (s.type === 'while') { st.push([s.body, top]); continue; }
    if (s.type === 'try') {
      for (let k = s.catch.length - 1; k >= 0; k--) st.push([s.catch[k], top]);
      for (let k = s.body.length - 1; k >= 0; k--) st.push([s.body[k], top]);
      continue;
    }
    // A cursor's columns are the result set of a FETCH without INTO (INTO assigns them by position).
    if (s.type !== 'select' && s.type !== 'declarecursor') continue;
    const q = s.query;
    // FOR JSON / FOR XML names become keys and elements, and SELECT … INTO names the #temp table's columns: the
    // aliases would change the data, not only the result headers.
    if (q.forJson || q.forXml) continue;
    let b = q.body;
    while (b.type !== 'core') b = b.type === 'query' ? b.body : b.left;
    if (b.into || !b.from) continue;
    const ctes = new Map((q.with ?? []).map(c => [c.name.toLowerCase(), c]));
    const sources = sourcesOf(b.from, ctes, tvars);
    const order = orderNames(q);
    const kwText = src.slice(b.pos, b.pos + 6);
    const as = o.kw === 'lower' ? 'as' : o.kw === 'upper' ? 'AS'
      : kwText === kwText.toLowerCase() ? 'as' : kwText === kwText.toUpperCase() ? 'AS' : 'As';
    for (const it of b.cols) {
      if (it.star || it.assign || it.alias != null || !it.expr || it.expr.type !== 'col' || it.expr.end !== it.end) continue;
      const label = labelFor(o.names, it.expr.parts, sources);
      if (label === null || orderBinds(it, label, b.cols, order)) continue;
      out.push({ pos: it.end, text: ` ${as} ${sqlIdent(label)}`, item: it, label, stmt: top });
    }
  }
  return out.sort((x, y) => x.pos - y.pos);
}

// src with the aliases inserted, and the map from its offsets back to offsets of src.
function withAliases(src, list) {
  const parts = [];
  const starts = []; // offset of each insertion in the new text
  let at = 0;
  let shift = 0;
  for (const x of list) {
    parts.push(src.slice(at, x.pos), x.text);
    starts.push(x.pos + shift);
    shift += x.text.length;
    at = x.pos;
  }
  parts.push(src.slice(at));
  const map = p => {
    let lo = 0;
    let hi = starts.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < p) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (k < 0) return p;
    const end = starts[k] + list[k].text.length;
    if (p < end) return list[k].pos;
    return p - (end - list[k].pos);
  };
  return { text: parts.join(''), map };
}

// The analysis of src with display names added: {src, prep, an, map, aliased (the indexes into an.stmts of the
// statements that got aliases)}, or null when there is nothing to add. The statements in `skip` get none. The new text
// must analyse to the same failing pieces and to the same statements with the aliases set; statements that do not are
// left without aliases (one retry), and when that fails too no alias is added.
function addDisplayNames(src, prep, an, o, skip) {
  let list = displayAliases(src, an.stmts, o).filter(x => !skip.has(x.stmt));
  for (let attempt = 0; attempt < 2 && list.length; attempt++) {
    const { text, map } = withAliases(src, list);
    const prep2 = prepare(text);
    const an2 = analyze(text, prep2, o.po);
    const bad = new Set();
    let ok = !!an2 && an2.failing.length === an.failing.length && an2.goFails.length === an.goFails.length &&
      (an2.tail === Infinity ? an.tail === Infinity : map(an2.tail) === an.tail) && an2.stmts.length === an.stmts.length &&
      an2.failing.every((r, k) => map(r.start) === an.failing[k].start && map(r.end) === an.failing[k].end);
    if (ok) {
      const before = list.map(x => x.item.alias);
      for (const x of list) x.item.alias = x.label;
      an.stmts.forEach((s, k) => { if (!sameAst(s, an2.stmts[k])) bad.add(k); });
      list.forEach((x, k) => { x.item.alias = before[k]; });
      const w1 = an.stmts.warnings ?? [];
      const w2 = an2.stmts.warnings ?? [];
      if (w1.length !== w2.length || w1.some((w, k) => w.text !== w2[k].text)) ok = false;
    }
    if (ok && !bad.size) return { src: text, prep: prep2, an: an2, map, aliased: new Set(list.map(x => x.stmt)) };
    if (!ok) return null;
    list = list.filter(x => !bad.has(x.stmt));
  }
  return null;
}

// The kept report of a layout (offsets of src): one entry per failing statement (a 'fail' item lists them in parts),
// failing GO line and statement formatted with its case kept or kept unformatted, then the unterminated tail.
function keptRanges(src, items, levels, tail) {
  const kept = [];
  for (const it of items) {
    const level = levels.get(it.id) ?? 0;
    if (it.kind === 'fail') for (const p of it.parts) kept.push({ start: p.start, end: p.end, reason: 'error' });
    else if (it.kind === 'gofail') kept.push({ start: it.pos, end: it.end, reason: 'error' });
    else if (it.kind === 'stmt' && level > 0) kept.push({ start: it.pos, end: it.end, reason: level === 1 ? 'case' : 'unformatted' });
  }
  if (tail < Infinity) kept.push({ start: tail, end: src.length, reason: 'unterminated' });
  return kept;
}

// Formats the statements in `bad` more conservatively next time (letter case kept, then unchanged). An unknown or
// exhausted culprit keeps every statement unchanged. False when nothing is left to try.
function escalate(items, levels, bad) {
  let changed = false;
  for (const it of bad) {
    if (it && it.kind === 'stmt' && (levels.get(it.id) ?? 0) < 2) {
      levels.set(it.id, (levels.get(it.id) ?? 0) + 1);
      changed = true;
    }
  }
  if (changed) return true;
  for (const x of items) {
    if (x.kind === 'stmt' && (levels.get(x.id) ?? 0) < 2) { levels.set(x.id, 2); changed = true; }
  }
  return changed;
}
