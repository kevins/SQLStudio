// SQL Studio parser: T-SQL (SQL Server 2022 + SQL 4 CDS dialect) source -> AST.
// Contracts: 01 §1 (exports), §2 and §2.1 (errors: numbers, texts and severities come from
// engine/messages.js MESSAGES), §4 (AST shapes and parser rules), §4.1 Hints (HINTS); 02 §9 (sp_executesql).
//
// Notes:
// - Exports beyond 01 §1: `parse(src, {quotedIdentifier = true, dynamic = false, vars = null, labelChecks = true})`:
//   `dynamic` (the text of sp_executesql or EXEC (…), 02 §9 (4)) makes a GO line raise 102 near 'GO'; `vars` lists
//   variable names that count as declared scalars in the first batch (the sp_executesql parameters, 01 §4.1
//   Variables), so 137/134 apply to the dynamic text as specified; `labelChecks: false` (for the editor's regions,
//   03 §5) skips 132/133/1026 and puts `labels: [{name, batch, scopes, pos, end}]` and `gotos: [{label, batch,
//   scopes, pos, end}]` (source order) on the result, where `scopes` lists the enclosing TRY and CATCH bodies,
//   outermost first, each as the offset of its BEGIN TRY / BEGIN CATCH. parse() itself raises 132 when it reaches
//   the second label of a name (so an earlier syntax error wins and a later one is never reached), and, after the
//   whole batch parsed, 133 or 1026 for the first GOTO in source order whose label is missing, or whose label's
//   scopes are not a prefix of its own. `parseParams(src, {quotedIdentifier})` parses the @params text of
//   sp_executesql (02 §9 (2)): `@name [AS] type [= constant] [OUT|OUTPUT]` items -> [{name (lower case), raw,
//   dataType, default: Expr|null (a literal, NULL or a signed number), output, pos, end}] with positions in that
//   text; every syntax error there is 102, also near a keyword (02 §9 (2)), a duplicate name raises 134, a CURSOR
//   type the cursor-variable error, '' gives []. `parseExpression(src, {quotedIdentifier})` and
//   `statementRanges(src, {quotedIdentifier})` take the mode too (completion, hover and the editor's marks parse with
//   the tab's mode, 02 §9).
// - HINTS rows (01 §1, §4.1): `origin` is 'sqlserver' for the documented SQL Server query hints (MAXRECURSION,
//   MAXDOP, HASH GROUP, FORCE ORDER, RECOMPILE, the JOIN hints and NO_PERFORMANCE_SPOOL too), the SQL Server USE HINT
//   names and NOLOCK; 'sql4cds' for the names SQL 4 CDS defines (its wiki Query-Hints page and engine:
//   BYPASS_CUSTOM_PLUGIN_EXECUTION, RETRIEVE_TOTAL_RECORD_COUNT, DEBUG_BYPASS_OPTIMIZATION, FETCHXML_PAGE_SIZE_n,
//   BATCH_SIZE_n, CONTINUE_ON_ERROR, IGNORE_DUP_KEY, NO_DIRECT_DML, MINIMAL_UPDATES, DISABLE_STATE_TRANSITIONS,
//   FORCE_SQL_4_CDS, FORCE_SQL4CDS, USE_LEGACY_UPDATE_MESSAGES); 'studio' for SQL Studio's additions (BATCH_SIZE(n),
//   BYPASS_BUSINESS_LOGIC_EXECUTION, SUPPRESS_DUPLICATE_DETECTION, SUPPRESS_FLOWS, NO_MINIMAL_UPDATES, USE_BULK_DELETE).
//   complete.js can take HINT_DOCS.kind (03 §1.4) from `origin` and `implemented` instead of keeping its own
//   STUDIO_HINTS / SQLSERVER_HINTS split. The rows: SQL Studio's and SQL 4 CDS's hints, where
//   FORCE_SQL_4_CDS, FORCE_SQL4CDS and USE_LEGACY_UPDATE_MESSAGES are implemented false (they give the 'not
//   supported and was ignored' warning); every documented SQL Server query hint (OPTION item
//   names as words: 'KEEP PLAN', 'FAST', 'OPTIMIZE FOR', 'TABLE HINT', 'DISABLE_OPTIMIZED_PLAN_FORCING', …) and every
//   SQL Server 2022 USE HINT name (QUERY_OPTIMIZER_COMPATIBILITY_LEVEL_n listed for n = 100..160; checked against the
//   SQL Server query-hint reference, which adds DISABLE_PARAMETER_SENSITIVE_PLAN_OPTIMIZATION; the names that apply
//   only to SQL Server 2025, Azure or Fabric are not listed); the table hint NOLOCK. 'HASH GROUP' (kind
//   option, implemented) goes into `use` as 01 §4.1 says; its effect is the planner's. A name of kind 'option' is not
//   valid inside USE HINT('…') (10715), as in SQL Server; a name of kind 'useHint' is also accepted bare. The 10715
//   `<name>` is the USE HINT string as written, or the leading words of the OPTION item as written (`'FORCE ORDR' is
//   not a valid hint.`). Its pos/end are those of the name alone: inside the quotes without the N prefix and the
//   white space around the name (a blank string: its whole content), or the OPTION item's leading words without
//   their argument, so replacing [pos, end) with `suggestions[0]` gives a valid hint (03 §7). `suggestions` come
//   from util.suggest over the names valid at that place; a numbered name is offered only with the number written
//   (BATCH_SIZE_100). An OPTION item's argument is checked by its hint's grammar (a number, `= number`, one
//   parenthesised group or a string; BATCH_SIZE takes exactly `(n)`); anything else is a syntax error. Table hints
//   also get `suggestions`.
// - EXEC: Dataverse message names are not T-SQL identifiers, so a reserved word that cannot start a
//   statement (not in STMT_START) is a one-part message name: `EXEC Restore @Target = …` (00 §2, 02 §8.1), also
//   after `@r =`; a statement keyword there (`EXEC Merge`, `EXEC Delete`) stays 156 and is written `EXEC [Merge]`.
//   179 also applies to an @@global (a function, not a variable); the error spans the value and OUTPUT.
// - execsql also carries `assignTo` ('@ret' | null): `EXEC @r = sp_executesql …` sets @r to 0 after success, as
//   for `exec`. `@stmt =` and `@params =` (case-insensitive) may name the first two arguments; a first argument named
//   otherwise, or none, raises 214 for '@statement' at parse time. OUTPUT on the statement or the parameter list is a
//   syntax error near OUTPUT. EXEC (…) takes string literals and scalar variables joined by '+' (its stmt is a
//   left-deep `bin` '+' tree); anything else is a syntax error.
// - `lit`: a '-' before a 0x… binary literal is never folded (it stays `neg`); a binary literal's `raw` is its source
//   text ('0xABC').
// - THROW and a leading WITH may also follow a label's ':' (a label ends the statement before it).
// - Labels: `name:` where name is an identifier or a bracketed identifier, with or without white space before
//   the ':'; an identifier followed by ':' is never an implicit alias or an EXEC argument, so `SELECT @i\nlbl:` is a
//   SELECT and a label. A label may be the single-statement body of IF/ELSE/WHILE (T-SQL grammar). 132 is raised at
//   the second label, 1026 at the GOTO. statementRanges() and parseExpression() never check labels.
// - Cursors: `declarecursor` also has `hints` (the OPTION clause of its SELECT, written before FOR READ_ONLY),
//   and `options` gets READ_ONLY for a trailing `FOR READ_ONLY` / ISO `FOR READ ONLY`. Options after CURSOR may come
//   in any order; a repeated one raises 102 near it; LOCAL with GLOBAL raises `Conflicting cursor options LOCAL and
//   GLOBAL.` (each conflict message names the pair in the order FORWARD_ONLY/SCROLL, FAST_FORWARD/SCROLL,
//   FAST_FORWARD/STATIC, LOCAL/GLOBAL). `FOR UPDATE [OF …]` raises at FOR … (its last token), and statementRanges()
//   keeps it in the range of its DECLARE. A cursor name `GLOBAL` alone is a cursor named GLOBAL. `FETCH NEXT|FIRST`
//   followed by a number or '(' is a syntax error at FETCH (an ORDER BY … FETCH without OFFSET). A variable where a
//   cursor name is expected (OPEN @c, FETCH … FROM @c, CLOSE, DEALLOCATE) raises the cursor-variable error.
// - WAITFOR: the argument is a string literal or a scalar variable (a number is a syntax error); the time text
//   and the 24-hour limit (148) are left to the session (02 §9).
// - FOR XML / FOR JSON: a FOR that is not followed by XML or JSON ends the query (a cursor's FOR READ_ONLY /
//   FOR UPDATE); after a SELECT statement's query a FOR that ends the batch raises 102 near FOR, the end-of-batch
//   rule of 01 §2 (the FOR clause is incomplete). As in SQL Server's grammar, a parenthesised query expression (a
//   set-operation operand, or the body of a SELECT, INSERT … SELECT or cursor query) has no FOR clause: 156 near
//   FOR; subqueries, derived tables and CTEs keep theirs. ROOT('') raises 6861 and RAW('') without ELEMENTS 6864 at
//   parse time (they are syntactic); 6819 is at the FOR XML clause. An assignment SELECT with FOR XML raises 141, as
//   with FOR JSON. XMLDATA / XMLSCHEMA ('uri') raise their error at the directive.
// - WITH XMLNAMESPACES: TRUNCATE's delete node has `xmlns: null`; for INSERT … SELECT `query.xmlns` is the
//   statement's array. Prefixes compare case-sensitively for duplicates; xml and xmlns are refused in any case.
//   `WITH xmlnamespaces AS (…)` and `WITH xmlnamespaces (a) AS (…)` stay CTEs.
// - xml methods: argument counts (174, `The value function requires 2 argument(s).`) and string-literal
//   arguments (8172) are checked at parse time, because they are syntactic. A column chain keeps at most 4 parts
//   before the method. `SET @x.modify(…)` and `UPDATE … SET c.modify(…)` raise `XML DML (modify) is not supported.`
//   at parse time (they have no node); any other method there is a syntax error. A method after nodes() is a syntax
//   error near '.'. `xml(…)` in any data type raises `XML schema collections are not supported.`
// - WHERE CURRENT OF [GLOBAL] c raises its error spanning the clause. Only COUNT(*) and COUNT_BIG(*) take `*` (102
//   near '*' otherwise, as in SQL Server).
// - Clear errors for things v1 does not have (no SQL Server number): MERGE, USE, INSERT … EXEC, EXEC of a variable,
//   EXECUTE AS CALLER/SELF/OWNER, NEXT VALUE FOR, CREATE of anything but a #table.
// - QUOTED_IDENTIFIER OFF: a "…" token is read as a varchar string literal everywhere (also in parseExpression
//   and statementRanges), invisible characters inside it are not warned, and an unclosed one raises 105. While it is
//   ON, a col or ObjectName node whose parts include one written in double quotes carries `_dq: [{part, pos, end}]`
//   (the part's index and source range), so the binder can offer the string 'mark' for `"mark"` (01 §2); exprKey
//   ignores it like every '_' property.
// - QUOTED_IDENTIFIER per batch (01 §4.1 'takes effect from the next batch', 02 §9): the `quotedIdentifier`
//   option of parse() and statementRanges() is the mode of the first batch. Each later batch is read with the mode
//   that the last SET QUOTED_IDENTIFIER of the batch before it sets, counting only the statements that run whenever
//   the batch runs to its end (top level and BEGIN … END blocks; not those in IF, ELSE, WHILE, TRY or CATCH bodies),
//   else with that batch's own mode; so a whole-script parse, the editor's marks and format.js's verification read a
//   batch after `SET QUOTED_IDENTIFIER OFF` + GO as the session will. statementRanges() also counts every
//   `SET … QUOTED_IDENTIFIER … ON|OFF` in the part of a batch that does not parse. A conditional SET (inside IF/WHILE)
//   is left to the session's re-parse of the later batches (02 §9). Hence 02 §9's 'every batch of a run is
//   parsed up front with the mode in force at the start of the run' then means parse(script, {quotedIdentifier: that
//   mode}), which reads a later batch with the mode the SETs before it give (else a valid script such as `SET
//   QUOTED_IDENTIFIER OFF` GO `SELECT ""` fails with 1038 before anything runs); SQL Server applies the option when
//   the SET is parsed (also later in the same batch and inside an IF that does not run), and 01 §4.1's next-batch
//   rule is not listed among the 01 §9 deviations.
// - 105 (unclosed string, [identifier] or "identifier") cuts the string to its first 40 characters, as lexer.js does
//   (01 §2's 128-character cut is for near-texts).
// - Legacy table hints (01 §4.3): a '(' after a one-part or sys.-qualified OPENJSON, STRING_SPLIT,
//   GENERATE_SERIES or fn_helpcollations always opens TVF arguments; after any other table name it opens a hint list
//   only when every comma-separated item is one table-hint keyword (as listed by SQL Server), INDEX (…) or INDEX =
//   name|(…). Table variables take the same forms as tables (`@t (NOLOCK)`, `@t a (NOLOCK)`, `@t WITH (NOLOCK)`).
// - Type synonyms (01 §4.1): BINARY VARYING → varbinary, as in SQL Server, besides the listed ones.
// - `CURRENT_USER()` (01 §3) gives the same node as CURRENT_USER; an argument raises 102 near it, and USER,
//   SESSION_USER or SYSTEM_USER followed by '(' raise 102 near the '('. SQL Server itself refuses
//   `CURRENT_USER()` (102 near '(').
// - FETCH ABSOLUTE | RELATIVE (n): a column, a subquery or an aggregate or window call (*, DISTINCT, OVER, WITHIN
//   GROUP) in n raises 102 near its first token (the SELECT of a subquery); variables and function calls are allowed.
// - exprKey keys a binary literal by its hex digits (`0x0A` = `0x0a`, never the number 10).
// - statementRanges(): the tolerant splitter ends a statement at every ';' (a ';' token never occurs inside
//   parentheses), and inside unclosed parentheses also at INSERT, UPDATE or DELETE that does not follow ON or FOR.
// - The index of each '(''s matching ')' is computed once per batch (nodes() table sources, legacy table hints, XML
//   DML and xml(…) errors).

import { tokenize, RESERVED, SqlError } from './lexer.js';
import { msg } from './messages.js';
import { suggest } from '../core/util.js';

const MAX_EXPR_DEPTH = 128;
const MAX_STMT_DEPTH = 256;
const MAX_GO_COUNT = 100000;
const MAX_MAXDOP = 32;
const INVISIBLE = /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

const DATEPART_FNS = new Set(['DATEADD', 'DATEDIFF', 'DATEDIFF_BIG', 'DATEPART', 'DATENAME', 'DATETRUNC']);
const DATEPARTS = new Set(('year yy yyyy quarter qq q month mm m dayofyear dy y day dd d week wk ww iso_week isowk isoww ' +
  'weekday dw w hour hh minute mi n second ss s millisecond ms microsecond mcs nanosecond ns tzoffset tz').split(' '));
// Reserved words that are still function names when '(' follows (01 §3).
const CALLABLE = new Set(['LEFT', 'RIGHT', 'COALESCE', 'NULLIF', 'CONVERT', 'TRY_CONVERT', 'CONTAINS', 'ON']);
const CAST_FNS = new Set(['CAST', 'TRY_CAST', 'CONVERT', 'TRY_CONVERT']);
const USER_FNS = new Set(['CURRENT_USER', 'USER', 'SESSION_USER', 'SYSTEM_USER']);
const CMP = new Map([['=', '='], ['<>', '<>'], ['!=', '<>'], ['<', '<'], ['>', '>'], ['<=', '<='], ['>=', '>='], ['!<', '>='], ['!>', '<=']]);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
const DATEFORMATS = new Set(['mdy', 'dmy', 'ymd', 'ydm', 'myd', 'dym']);
const NOOP_ON = new Set(['ANSI_NULLS', 'ANSI_PADDING', 'ANSI_WARNINGS', 'ARITHABORT', 'CONCAT_NULL_YIELDS_NULL', 'XACT_ABORT']);
const STMT_START = new Set(('SELECT INSERT UPDATE DELETE DECLARE SET IF WHILE BEGIN END ELSE PRINT EXEC EXECUTE WITH CREATE DROP ' +
  'TRUNCATE RAISERROR WAITFOR RETURN BREAK CONTINUE MERGE REVERT USE COMMIT ROLLBACK SAVE GOTO THROW OPEN CLOSE FETCH DEALLOCATE').split(' '));
const TABLE_HINT_WORDS = new Set(('NOLOCK READUNCOMMITTED UPDLOCK REPEATABLEREAD SERIALIZABLE READCOMMITTED READCOMMITTEDLOCK TABLOCK ' +
  'TABLOCKX PAGLOCK ROWLOCK NOWAIT READPAST XLOCK SNAPSHOT NOEXPAND HOLDLOCK INDEX FORCESEEK FORCESCAN KEEPIDENTITY KEEPDEFAULTS ' +
  'IGNORE_CONSTRAINTS IGNORE_TRIGGERS').split(' '));
// The built-in table-valued functions (01 §8 Table-valued): after one of these names '(' always opens the arguments,
// never a legacy table-hint list (01 §4.3), so `OPENJSON(snapshot)` and `STRING_SPLIT(nolock, ',')` are calls.
const BUILTIN_TVFS = new Set(['OPENJSON', 'STRING_SPLIT', 'GENERATE_SERIES', 'FN_HELPCOLLATIONS']);
// True for a one-part or sys.-qualified built-in TVF name.
const builtinTvf = name => {
  const p = name.parts;
  return (p.length === 1 || (p.length === 2 && lower(p[0]) === 'sys')) && BUILTIN_TVFS.has(p[p.length - 1].toUpperCase());
};
// xml data type methods (01 §4.4) and their argument counts.
const XML_METHODS = new Map([['value', 2], ['query', 1], ['exist', 1], ['nodes', 1], ['modify', 1]]);
// The operands an xml method may follow: a variable, a column, CAST/CONVERT, a parenthesised expression or
// subquery, or another method call.
const XML_BASES = new Set(['var', 'col', 'cast', 'paren', 'subq', 'xmlmethod']);
// Cursor options after CURSOR (01 §4.1 Cursors): the supported ones and those that raise CURSOR_RO_MSG.
const CURSOR_OPTS = new Set(['LOCAL', 'GLOBAL', 'FORWARD_ONLY', 'SCROLL', 'STATIC', 'FAST_FORWARD', 'READ_ONLY']);
const CURSOR_NO = new Set(['DYNAMIC', 'KEYSET', 'SCROLL_LOCKS', 'OPTIMISTIC', 'TYPE_WARNING']);
// Pairs of cursor options that cannot be combined, named in this order in CONFLICT_MSG.
const CURSOR_CONFLICTS = [['LOCAL', 'GLOBAL'], ['FORWARD_ONLY', 'SCROLL'], ['FAST_FORWARD', 'SCROLL'], ['FAST_FORWARD', 'STATIC']];
const FETCH_DIRS = new Set(['NEXT', 'PRIOR', 'FIRST', 'LAST', 'ABSOLUTE', 'RELATIVE']);

// ---------------------------------------------------------------------------------------------------------------
// Hint names (01 §4.1 Hints): every OPTION item, USE HINT name and table hint SQL Studio accepts. A row is
// [name, kind, implemented, origin] (01 §1): origin 'sqlserver' for every documented SQL Server query hint, every USE
// HINT name of sys.dm_exec_valid_use_hints (SQL Server 2022) and the table hint NOLOCK; 'sql4cds' for the hint names
// SQL 4 CDS defines (its wiki Query-Hints page), also those SQL Studio accepts without an effect; 'studio' for the hints
// SQL Studio adds (01 §4.1, 02 §8.1). BATCH_SIZE_n and FETCHXML_PAGE_SIZE_n stand for the names with a number.
const HINT_ROWS = [
  // SQL Server query hints that SQL Studio implements: OPTION items.
  ['MAXRECURSION', 'option', true, 'sqlserver'], ['MAXDOP', 'option', true, 'sqlserver'], ['HASH GROUP', 'option', true, 'sqlserver'],
  ['FORCE ORDER', 'option', true, 'sqlserver'],
  ['RECOMPILE', 'option', true, 'sqlserver'], ['OPTIMIZE FOR UNKNOWN', 'option', true, 'sqlserver'],
  ['LOOP JOIN', 'option', true, 'sqlserver'], ['MERGE JOIN', 'option', true, 'sqlserver'], ['HASH JOIN', 'option', true, 'sqlserver'],
  ['NO_PERFORMANCE_SPOOL', 'option', true, 'sqlserver'],
  // SQL Studio's own hints: the OPTION item BATCH_SIZE(n) and USE HINT names (also accepted bare).
  ['BATCH_SIZE', 'option', true, 'studio'], ['BYPASS_BUSINESS_LOGIC_EXECUTION', 'useHint', true, 'studio'],
  ['SUPPRESS_DUPLICATE_DETECTION', 'useHint', true, 'studio'], ['SUPPRESS_FLOWS', 'useHint', true, 'studio'],
  ['NO_MINIMAL_UPDATES', 'useHint', true, 'studio'], ['USE_BULK_DELETE', 'useHint', true, 'studio'],
  // SQL 4 CDS's hints (USE HINT names, also accepted bare).
  ['BYPASS_CUSTOM_PLUGIN_EXECUTION', 'useHint', true, 'sql4cds'], ['CONTINUE_ON_ERROR', 'useHint', true, 'sql4cds'],
  ['IGNORE_DUP_KEY', 'useHint', true, 'sql4cds'],
  ['MINIMAL_UPDATES', 'useHint', true, 'sql4cds'], ['NO_DIRECT_DML', 'useHint', true, 'sql4cds'],
  ['DISABLE_STATE_TRANSITIONS', 'useHint', true, 'sql4cds'], ['RETRIEVE_TOTAL_RECORD_COUNT', 'useHint', true, 'sql4cds'],
  ['DEBUG_BYPASS_OPTIMIZATION', 'useHint', true, 'sql4cds'], ['BATCH_SIZE_n', 'useHint', true, 'sql4cds'],
  ['FETCHXML_PAGE_SIZE_n', 'useHint', true, 'sql4cds'],
  // SQL 4 CDS hints that have no effect in SQL Studio (no TDS endpoint; state changes go through 02 §8.1 step 2).
  ['FORCE_SQL_4_CDS', 'useHint', false, 'sql4cds'], ['FORCE_SQL4CDS', 'useHint', false, 'sql4cds'],
  ['USE_LEGACY_UPDATE_MESSAGES', 'useHint', false, 'sql4cds'],
  // The other SQL Server query hints.
  ['ORDER GROUP', 'option', false, 'sqlserver'],
  ['CONCAT UNION', 'option', false, 'sqlserver'], ['HASH UNION', 'option', false, 'sqlserver'],
  ['MERGE UNION', 'option', false, 'sqlserver'], ['EXPAND VIEWS', 'option', false, 'sqlserver'], ['FAST', 'option', false, 'sqlserver'],
  ['FORCE EXTERNALPUSHDOWN', 'option', false, 'sqlserver'], ['DISABLE EXTERNALPUSHDOWN', 'option', false, 'sqlserver'],
  ['FORCE SCALEOUTEXECUTION', 'option', false, 'sqlserver'], ['DISABLE SCALEOUTEXECUTION', 'option', false, 'sqlserver'],
  ['KEEP PLAN', 'option', false, 'sqlserver'], ['KEEPFIXED PLAN', 'option', false, 'sqlserver'],
  ['IGNORE_NONCLUSTERED_COLUMNSTORE_INDEX', 'option', false, 'sqlserver'], ['MAX_GRANT_PERCENT', 'option', false, 'sqlserver'],
  ['MIN_GRANT_PERCENT', 'option', false, 'sqlserver'], ['OPTIMIZE FOR', 'option', false, 'sqlserver'],
  ['PARAMETERIZATION SIMPLE', 'option', false, 'sqlserver'], ['PARAMETERIZATION FORCED', 'option', false, 'sqlserver'],
  ['QUERYTRACEON', 'option', false, 'sqlserver'], ['ROBUST PLAN', 'option', false, 'sqlserver'], ['USE PLAN', 'option', false, 'sqlserver'],
  ['TABLE HINT', 'option', false, 'sqlserver'], ['DISABLE_OPTIMIZED_PLAN_FORCING', 'option', false, 'sqlserver'],
  // SQL Server USE HINT names (sys.dm_exec_valid_use_hints); three of them reach <fetch options>.
  ['DISABLE_OPTIMIZER_ROWGOAL', 'useHint', true, 'sqlserver'], ['ENABLE_QUERY_OPTIMIZER_HOTFIXES', 'useHint', true, 'sqlserver'],
  ['ENABLE_HIST_AMENDMENT_FOR_ASC_KEYS', 'useHint', true, 'sqlserver'], ['ALLOW_BATCH_MODE', 'useHint', false, 'sqlserver'],
  ['ASSUME_FULL_INDEPENDENCE_FOR_FILTER_ESTIMATES', 'useHint', false, 'sqlserver'],
  ['ASSUME_JOIN_PREDICATE_DEPENDS_ON_FILTERS', 'useHint', false, 'sqlserver'],
  ['ASSUME_MIN_SELECTIVITY_FOR_FILTER_ESTIMATES', 'useHint', false, 'sqlserver'],
  ['ASSUME_PARTIAL_CORRELATION_FOR_FILTER_ESTIMATES', 'useHint', false, 'sqlserver'],
  ['DISABLE_BATCH_MODE_ADAPTIVE_JOINS', 'useHint', false, 'sqlserver'],
  ['DISABLE_BATCH_MODE_MEMORY_GRANT_FEEDBACK', 'useHint', false, 'sqlserver'],
  ['DISABLE_DEFERRED_COMPILATION_TV', 'useHint', false, 'sqlserver'], ['DISABLE_INTERLEAVED_EXECUTION_TVF', 'useHint', false, 'sqlserver'],
  ['DISABLE_OPTIMIZED_NESTED_LOOP', 'useHint', false, 'sqlserver'],
  ['DISABLE_PARAMETER_SENSITIVE_PLAN_OPTIMIZATION', 'useHint', false, 'sqlserver'],
  ['DISABLE_PARAMETER_SNIFFING', 'useHint', false, 'sqlserver'], ['DISABLE_ROW_MODE_MEMORY_GRANT_FEEDBACK', 'useHint', false, 'sqlserver'],
  ['DISABLE_TSQL_SCALAR_UDF_INLINING', 'useHint', false, 'sqlserver'], ['DISALLOW_BATCH_MODE', 'useHint', false, 'sqlserver'],
  ['FORCE_DEFAULT_CARDINALITY_ESTIMATION', 'useHint', false, 'sqlserver'],
  ['FORCE_LEGACY_CARDINALITY_ESTIMATION', 'useHint', false, 'sqlserver'],
  ['QUERY_OPTIMIZER_COMPATIBILITY_LEVEL_100', 'useHint', false, 'sqlserver'],
  ['QUERY_OPTIMIZER_COMPATIBILITY_LEVEL_110', 'useHint', false, 'sqlserver'],
  ['QUERY_OPTIMIZER_COMPATIBILITY_LEVEL_120', 'useHint', false, 'sqlserver'],
  ['QUERY_OPTIMIZER_COMPATIBILITY_LEVEL_130', 'useHint', false, 'sqlserver'],
  ['QUERY_OPTIMIZER_COMPATIBILITY_LEVEL_140', 'useHint', false, 'sqlserver'],
  ['QUERY_OPTIMIZER_COMPATIBILITY_LEVEL_150', 'useHint', false, 'sqlserver'],
  ['QUERY_OPTIMIZER_COMPATIBILITY_LEVEL_160', 'useHint', false, 'sqlserver'], ['QUERY_PLAN_PROFILE', 'useHint', false, 'sqlserver'],
  // Table hints (01 §4.3).
  ['NOLOCK', 'table', true, 'sqlserver'],
];

// Every hint name SQL Studio accepts: [{name, kind: 'option'|'useHint'|'table', implemented, origin:
// 'sqlserver'|'sql4cds'|'studio'}] (01 §1, §4.1 Hints).
export const HINTS = Object.freeze(HINT_ROWS.map(([name, kind, implemented, origin]) => Object.freeze({ name, kind, implemented, origin })));

// FetchXML `options` for hints (01 §4.1); the USE HINT names among them also go into `use`.
const FETCH_OPTIONS = new Map([['OPTIMIZE FOR UNKNOWN', 'OptimizeForUnknown'], ['FORCE ORDER', 'ForceOrder'], ['RECOMPILE', 'Recompile'],
  ['DISABLE_OPTIMIZER_ROWGOAL', 'DisableRowGoal'], ['ENABLE_QUERY_OPTIMIZER_HOTFIXES', 'EnableOptimizerHotfixes'],
  ['ENABLE_HIST_AMENDMENT_FOR_ASC_KEYS', 'ENABLE_HIST_AMENDMENT_FOR_ASC_KEYS'], ['LOOP JOIN', 'LoopJoin'], ['MERGE JOIN', 'MergeJoin'],
  ['HASH JOIN', 'HashJoin'], ['NO_PERFORMANCE_SPOOL', 'NO_PERFORMANCE_SPOOL']]);
// What follows the name of an OPTION item: nothing, a number, '= number', a parenthesised list or a string.
const OPTION_ARGS = new Map([['MAXRECURSION', 'int'], ['MAXDOP', 'int'], ['BATCH_SIZE', 'paren'], ['FAST', 'int'],
  ['QUERYTRACEON', 'int'], ['MAX_GRANT_PERCENT', 'eq'], ['MIN_GRANT_PERCENT', 'eq'], ['OPTIMIZE FOR', 'paren'], ['USE PLAN', 'str'],
  ['TABLE HINT', 'paren']]);
// Hint names with a number suffix: the HINTS name and its pattern.
const NUMBERED_HINTS = [['BATCH_SIZE_n', /^BATCH_SIZE_(\d+)$/], ['FETCHXML_PAGE_SIZE_n', /^FETCHXML_PAGE_SIZE_(\d+)$/]];

// Lookup tables over HINTS, built on first use: name -> row per kind.
let hintIndex = null;
function hintsBy() {
  if (!hintIndex) {
    hintIndex = { option: new Map(), useHint: new Map(), table: new Map() };
    for (const h of HINTS) hintIndex[h.kind].set(h.name, h);
  }
  return hintIndex;
}

// The HINTS row of a hint name in a USE HINT or bare (upper case), incl. the numbered names, else null.
function useHintRow(name) {
  const r = hintsBy().useHint.get(name);
  if (r) return r;
  for (const [n, re] of NUMBERED_HINTS) if (re.test(name)) return hintsBy().useHint.get(n);
  return null;
}

// Did-you-mean candidates among the names of these kinds. A suggestion is a one-click replacement (03 §7), so a
// numbered name is offered with the number written (BATCH_SIZE_100), and not at all when none is written.
function hintCandidates(kinds, name) {
  const num = /_(\d+)$/.exec(name);
  const out = [];
  for (const k of kinds) {
    for (const h of hintsBy()[k].values()) {
      if (!h.name.endsWith('_n')) out.push(h.name);
      else if (num) out.push(h.name.slice(0, -1) + num[1]);
    }
  }
  return out;
}

const TRAN_MSG = 'Transactions are not supported: every INSERT, UPDATE and DELETE is written immediately and cannot be rolled back. Remove BEGIN TRAN/ROLLBACK and use the preview dialog.';
const MAX_SETS_MSG = 'GROUPING SETS can have at most 4096 grouping sets (SQL Server limit).';
const GO_MSG = `The GO count must be between 1 and ${MAX_GO_COUNT}.`;
const SET_VAR_COL_MSG = 'SET @variable = column = expression is not supported. Write two SET items: column = expression, @variable = expression.';
const CURSOR_RO_MSG = 'Only static read-only cursors are supported.';
const CURSOR_VAR_MSG = 'Cursor variables are not supported. Use DECLARE c CURSOR FOR … with a cursor name.';
const CURRENT_OF_MSG = 'WHERE CURRENT OF is not supported; use the primary key.';
const CURSOR_JSON_MSG = 'The FOR JSON clause is not allowed in a CURSOR statement.';
const CONFLICT_MSG = (a, b) => `Conflicting cursor options ${a} and ${b}.`;
const XMLDATA_MSG = 'FOR XML XMLDATA and XMLSCHEMA are not supported.';
const XMLNS_MSG = p => `XML namespace prefix '${p}' cannot be declared here.`;
const NODES_MSG = "The nodes() method can only be used as a table source: CROSS APPLY x.nodes('…') AS t(c).";
const NODES_ALIAS_MSG = 'Column alias list for nodes() must have exactly one name.';
const XML_SCHEMA_MSG = 'XML schema collections are not supported.';
const XML_DML_MSG = 'XML DML (modify) is not supported.';
const OPENROWSET_MSG = 'OPENROWSET is not supported. Use Open › Load CSV as #temp… or Open › Load file as text… instead.';
const MERGE_MSG = 'MERGE is not supported. Use INSERT, UPDATE and DELETE; each one has its own preview.';

const isKw = (t, k) => !!t && t.t === 'id' && t.k === k;
const isOp = (t, v) => !!t && t.t === 'op' && t.v === v;
const isIntTok = t => t.t === 'num' && t.int === true;
const lower = s => s.toLowerCase();

// SqlError with the SQL Server number and severity.
function mkErr(message, number, pos, end, severity = 16) {
  const e = new SqlError(message, pos, end);
  if (number) e.number = number;
  e.severity = severity;
  return e;
}

// SqlError for SQL Server error n: the MESSAGES text with its placeholders filled from args, and its severity.
function err(n, pos, end, ...args) {
  const m = msg(n, ...args);
  return mkErr(m.message, n, pos, end, m.severity);
}

// The error that got further into the text (backtracking keeps the more informative one; ties keep the first).
const furthest = (a, b) => ((b.pos ?? -1) > (a.pos ?? -1) ? b : a);

// The numeric literal node of an expression (also through parentheses), else null.
function numLitOf(e) {
  while (e && e.type === 'paren') e = e.e;
  return e && e.type === 'lit' && typeof e.v === 'number' ? e : null;
}

// The source position of the first part of an expression that makes it non-constant, else null (FETCH ABSOLUTE |
// RELATIVE (n), 01 §4.1 Cursors): a column, a subquery (EXISTS, IN and ANY/ALL included; the position of its query),
// or an aggregate or window call written with *, DISTINCT, OVER or WITHIN GROUP. Variables are allowed.
function nonConstant(e) {
  const st = [e];
  let first = null;
  const note = p => { if (first === null || p < first) first = p; };
  while (st.length) {
    const x = st.pop();
    if (!x || typeof x !== 'object') continue;
    if (Array.isArray(x)) { for (const y of x) st.push(y); continue; }
    if (x.type === 'col' || (x.type === 'fn' && (x.star || x.distinct || x.over || x.withinGroup))) { note(x.pos); continue; }
    if (x.type === 'subq' || x.type === 'exists' || ((x.type === 'in' || x.type === 'quantified') && x.query)) note(x.query.pos);
    for (const k of Object.keys(x)) if (k !== 'query' && k !== 'dataType') st.push(x[k]);
  }
  return first;
}

// True when a numeric literal has an integer type: int, or a decimal written without a fraction part (beyond int).
const integralLit = l => l.dt === 'int' || (l.dt === 'decimal' && !String(l.raw ?? l.v).includes('.'));

const emptyHints = () => ({ use: new Set(), fetchOptions: [] });

// ---------------------------------------------------------------------------------------------------------------
// Batches: GO lines (01 §4.5) split the text before anything is parsed.

// A GO token is a separator when it is alone on its line, optionally followed by a count and a comment.
function goLine(all, k) {
  const prev = all[k - 1];
  if (prev && !(prev.t === 'ws' && (/[\r\n]/.test(prev.v) || k === 1))) return null;
  let j = k + 1;
  const skipWs = () => { while (all[j].t === 'ws' && !/[\r\n]/.test(all[j].v)) j++; };
  let last = all[k];
  let count = 1;
  let countTok = null;
  skipWs();
  if (all[j].t === 'num') {
    if (!isIntTok(all[j]) || !/^\d+$/.test(all[j].raw)) return null;
    countTok = all[j];
    count = countTok.v;
    last = all[j];
    j++;
    skipWs();
  }
  while (all[j].t === 'cmt') { last = all[j]; j++; skipWs(); }
  if (all[j].t !== 'end' && !(all[j].t === 'ws' && /[\r\n]/.test(all[j].v))) return null;
  // A line comment runs up to '\n', so with CRLF line ends it would include the '\r'.
  const end = last.t === 'cmt' && last.v.endsWith('\r') ? last.e - 1 : last.e;
  return { count, countTok, pos: all[k].s, end, next: j };
}

// With QUOTED_IDENTIFIER OFF (01 §4.1) a "…" token is a string literal: turns each such qid token of toks into
// a str token in place (the token objects are shared by the keepAll list and the batches). Both modes lex "…" the
// same way, so GO lines and lexical errors never depend on the mode.
function dqStrings(toks, src) {
  for (const t of toks) if (t.t === 'qid' && src.charCodeAt(t.s) === 34) t.t = 'str';
}

// The keepAll tokens of a text read with one QUOTED_IDENTIFIER mode.
function lexAll(src, qi) {
  const all = tokenize(src, true);
  if (!qi) dqStrings(all, src);
  return all;
}

// The QUOTED_IDENTIFIER mode after a batch's statements: the value of its last SET QUOTED_IDENTIFIER that runs
// whenever the batch runs to its end (at top level or in BEGIN … END blocks, not in IF, ELSE, WHILE, TRY or CATCH
// bodies), else the mode the batch was read with.
function modeAfter(stmts, qi) {
  for (const s of stmts) {
    if (s.type === 'setopt' && s.name === 'QUOTED_IDENTIFIER') qi = s.value;
    else if (s.type === 'block') qi = modeAfter(s.body, qi);
  }
  return qi;
}

// The same for a batch that does not parse: every `SET [options ,] QUOTED_IDENTIFIER [, options] ON|OFF` from token
// index `from` on counts (the tolerant statementRanges() only).
function modeAfterTokens(toks, from, qi) {
  for (let k = from; k < toks.length; k++) {
    if (!isKw(toks[k], 'SET')) continue;
    let j = k + 1;
    let named = false;
    while (toks[j] && toks[j].t === 'id') {
      if (toks[j].k === 'QUOTED_IDENTIFIER') named = true;
      if (!isOp(toks[j + 1], ',')) break;
      j += 2;
    }
    const v = toks[j + 1];
    if (named && (isKw(v, 'ON') || isKw(v, 'OFF'))) qi = v.k === 'ON';
  }
  return qi;
}

// Splits the keepAll token stream into batches of significant tokens (each ending with its own 'end' token). The
// tokens keep their lexer kinds: parse() and statementRanges() apply each batch's QUOTED_IDENTIFIER mode (dqStrings).
function scanBatches(src) {
  const all = tokenize(src, true);
  const batches = [];
  let toks = [];
  let lexErr = null;
  const close = (end, go) => {
    toks.push({ t: 'end', v: '', s: end, e: end });
    batches.push({ toks, go, lexErr });
    toks = [];
    lexErr = null;
  };
  for (let k = 0; k < all.length; k++) {
    const t = all[k];
    if (t.t === 'end') break;
    if (t.t === 'ws') continue;
    if (t.t === 'cmt') { if (t.open && !lexErr) lexErr = t; continue; }
    if (t.t === 'id' && t.k === 'GO') {
      const g = goLine(all, k);
      if (g) { close(t.s, g); k = g.next - 1; continue; }
    }
    if ((t.t === 'bad' || t.open) && !lexErr) lexErr = t;
    toks.push(t);
  }
  close(src.length, null);
  return { all, batches };
}

// The error for an unterminated or unknown token: 113 and 102 have the texts tokenize(src) without keepAll throws;
// 105 is the unclosed-string text also for an unclosed [identifier] or "identifier", as in SQL Server (01 §2.1 105,
// wave1b §6; lexer.js says 'after the identifier' there), with the string cut to 40 characters like lexer.js.
function lexError(t, src) {
  if (t.t === 'cmt') return err(113, t.s, src.length);
  if (t.t === 'str' || t.t === 'qid') return err(105, t.s, src.length, t.v.slice(0, 40));
  return err(102, t.s, t.e, t.v);
}

// Parse warnings for invisible and bidirectional control characters outside string literals (01 §4.5).
function invisibleWarnings(src, all, out) {
  INVISIBLE.lastIndex = 0;
  let m;
  let k = 0;
  while ((m = INVISIBLE.exec(src))) {
    const p = m.index;
    while (all[k].e <= p && all[k].t !== 'end') k++;
    if (all[k].t === 'str' && all[k].s <= p) continue;
    const hex = src.charCodeAt(p).toString(16).toUpperCase().padStart(4, '0');
    out.push({ pos: p, end: p + 1, text: `Invisible or bidirectional control character U+${hex} outside a string literal.` });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Recursive-descent parser over one batch of significant tokens.

class Parser {
  constructor(src, toks, opts) {
    this.src = src;
    this.t = toks;
    this.i = 0;
    this.warnings = opts.warnings;
    // Batch-level variable checks (parse() and parseParams() only): 134, 137, 1087.
    this.checks = opts.checks;
    // Every syntax error is 102, also near a keyword (parseParams, 02 §9 (2)).
    this.only102 = opts.only102 === true;
    this.vars = new Map();
    if (opts.vars) for (const v of opts.vars) this.vars.set(lower(v), 'scalar');
    this.depth = 0;
    this.sdepth = 0;
    this.catchDepth = 0;
    this.loopDepth = 0;
    // GOTO and labels: 'check' resolves them per batch (parse()), 'collect' only lists them (parse() with
    // labelChecks false), 'off' ignores them. Labels by lower-case name, labels and GOTOs in source order, and the
    // open TRY/CATCH scopes, each identified by the offset of its BEGIN TRY / BEGIN CATCH.
    this.labelMode = opts.labels ?? (opts.checks ? 'check' : 'off');
    this.labelMap = new Map();
    this.labels = [];
    this.gotos = [];
    this.scopes = [];
    // Nested-query parses by token index: {depth, q, end, w} or {depth, err} (see queryExpr).
    this.memo = new Map();
    // Index of the matching ')' of each '(' (built on first use), and FOR XML clause positions by Query.
    this.closeAt = null;
    this.forPos = new WeakMap();
  }

  // ----- token helpers
  get peek() { return this.t[this.i]; }
  la(n) { return this.t[Math.min(this.i + n, this.t.length - 1)]; }
  next() { const t = this.t[this.i]; if (t.t !== 'end') this.i++; return t; }
  end() { return this.i ? this.t[this.i - 1].e : this.t[0].s; }
  kw(k) { return isKw(this.peek, k); }
  kwAt(n, k) { return isKw(this.la(n), k); }
  op(v) { return isOp(this.peek, v); }
  eatKw(k) { if (this.kw(k)) { this.i++; return true; } return false; }
  eatOp(v) { if (this.op(v)) { this.i++; return true; } return false; }
  expectKw(k) { if (!this.kw(k)) throw this.syntax(); return this.next(); }
  expectOp(v) { if (!this.op(v)) throw this.syntax(); return this.next(); }
  save() { return { i: this.i, depth: this.depth, sdepth: this.sdepth, w: this.warnings.length }; }
  restore(s) { this.i = s.i; this.depth = s.depth; this.sdepth = s.sdepth; this.warnings.length = s.w; }
  enter() { if (++this.depth > MAX_EXPR_DEPTH) throw err(191, this.peek.s, this.peek.e); }
  warn(pos, end, text) { this.warnings.push({ pos, end, text }); }

  nearText(t) {
    const s = t.t === 'str' || t.t === 'qid' ? t.v : this.src.slice(t.s, t.e);
    return s.length > 128 ? s.slice(0, 128) : s;
  }

  // 102 `Incorrect syntax near 'x'.` or 156 `Incorrect syntax near the keyword 'FROM'.` at a token. At the end of the
  // batch it is always 102 naming the batch's last token, keyword or not (`SELECT * FROM` gives `Incorrect syntax near
  // 'FROM'.`, 01 §2), as SQL Server does. `only102` (parseParams, 02 §9 (2)) makes every syntax error 102.
  syntax(tok = this.peek, force102 = false) {
    let t = tok;
    let atEnd = false;
    if (t.t === 'end') {
      t = this.t[this.t.length - 2];
      if (!t) return err(102, tok.s, tok.e, '');
      atEnd = true;
    }
    const kw = !(force102 || atEnd || this.only102) && t.t === 'id' && RESERVED.has(t.k);
    return err(kw ? 156 : 102, t.s, t.e, this.nearText(t));
  }

  // Index of the ')' that closes the '(' at token index j, or -1 when the batch never closes it.
  closeOf(j) {
    if (!this.closeAt) {
      this.closeAt = new Int32Array(this.t.length).fill(-1);
      const open = [];
      this.t.forEach((t, k) => {
        if (isOp(t, '(')) open.push(k);
        else if (isOp(t, ')') && open.length) this.closeAt[open.pop()] = k;
      });
    }
    return this.closeAt[j] ?? -1;
  }

  // True when the tokens at j are `. method (` of an xml data type method (01 §4.4).
  methodAt(j) {
    const m = this.t[j + 1];
    return isOp(this.t[j], '.') && !!m && m.t === 'id' && XML_METHODS.has(lower(m.v)) && isOp(this.t[j + 2], '(');
  }

  // ----- identifiers
  isIdent(t) { return !!t && (t.t === 'qid' || (t.t === 'id' && !RESERVED.has(t.k))); }

  idText(t) {
    if ((t.t === 'qid' || t.t === 'str') && t.v === '') throw err(1038, t.s, t.e);
    if (t.v.length > 128) throw err(103, t.s, t.e, t.v.slice(0, 128));
    return t.v;
  }

  readIdent() {
    const t = this.peek;
    if (!this.isIdent(t)) throw this.syntax();
    this.i++;
    return this.idText(t);
  }

  identList() {
    const out = [];
    do out.push(this.readIdent()); while (this.eatOp(','));
    return out;
  }

  parenIdentList() {
    this.expectOp('(');
    const out = this.identList();
    this.expectOp(')');
    return out;
  }

  objectName() {
    const t = this.peek;
    const dq = [];
    const parts = [this.readPart(dq, 0)];
    while (this.op('.')) {
      if (parts.length === 4) throw this.syntax();
      this.i++;
      parts.push(this.readPart(dq, parts.length));
    }
    return this.withDq({ parts, pos: t.s, end: this.end() }, dq);
  }

  // readIdent() for part k of a multi-part name; a part written in double quotes ("mark", only while
  // QUOTED_IDENTIFIER is ON) is noted in dq as {part, pos, end}, so the binder can offer 'mark' (01 §2).
  readPart(dq, k) {
    const t = this.peek;
    const v = this.readIdent();
    if (t.t === 'qid' && this.src.charCodeAt(t.s) === 34) dq.push({ part: k, pos: t.s, end: t.e });
    return v;
  }

  // Adds the `_dq` note of a col or ObjectName node when one of its parts was written in double quotes.
  withDq(node, dq) {
    if (dq.length) node._dq = dq;
    return node;
  }

  checkTempName(name) {
    const s = name.parts[0];
    if (s.startsWith('#') && s.length > 116) {
      throw err(193, name.pos, name.end, s);
    }
  }

  // ----- variables (batch scope, SQL Server compile-time checks)
  checkVarTok(t) {
    if (t.v === '@' || t.v === '@@') throw this.syntax(t);
    if (t.v.length > 128) throw err(103, t.s, t.e, t.raw.slice(0, 128));
  }

  useVar(t, kind) {
    this.checkVarTok(t);
    if (!this.checks || t.v.startsWith('@@')) return;
    if (this.vars.get(t.v) === kind) return;
    throw err(kind === 'table' ? 1087 : 137, t.s, t.e, t.raw);
  }

  // 134 when the name is already declared in the batch (earlier entries of the same DECLARE included).
  checkNewVar(t) {
    if (this.checks && this.vars.has(t.v)) throw err(134, t.s, t.e, t.raw);
  }

  // ----- statements
  // The statements of the batch; then every GOTO is resolved against the batch's labels (01 §4.1).
  batch() {
    const out = [];
    for (;;) {
      while (this.op(';')) this.i++;
      if (this.peek.t === 'end') break;
      const st = this.statement(false);
      if (Array.isArray(st)) out.push(...st); else out.push(st);
    }
    if (this.labelMode === 'check') this.resolveGotos();
    return out;
  }

  // 133 for a GOTO to a label the batch does not declare; 1026 for one into a TRY or CATCH block it is not in.
  resolveGotos() {
    for (const g of this.gotos) {
      const l = this.labelMap.get(lower(g.label));
      if (!l) throw err(133, g.pos, g.end, g.label);
      if (l.scopes.some((id, k) => g.scopes[k] !== id)) throw err(1026, g.pos, g.end);
    }
  }

  // Statements until stop() is true or the batch ends (block, TRY and CATCH bodies).
  list(stop) {
    const out = [];
    for (;;) {
      while (this.op(';')) this.i++;
      if (this.peek.t === 'end' || stop()) return out;
      const st = this.statement(false);
      if (Array.isArray(st)) out.push(...st); else out.push(st);
    }
  }

  // The single statement of an IF / ELSE / WHILE body.
  body() {
    if (this.peek.t === 'end' || this.op(';')) throw this.syntax();
    const st = this.statement(true);
    if (!Array.isArray(st)) return st;
    return { type: 'block', body: st, pos: st[0].pos, end: st[st.length - 1].end };
  }

  statement(body) {
    if (++this.sdepth > MAX_STMT_DEPTH) throw err(191, this.peek.s, this.peek.e);
    try { return this.statementInner(body); } finally { this.sdepth--; }
  }

  // THROW and a leading WITH must start the batch or follow ';', BEGIN, TRY, CATCH or a label (or be a
  // control-flow body).
  placementOk(body) {
    const prev = this.t[this.i - 1];
    return body || !prev || isOp(prev, ';') || isOp(prev, ':') || isKw(prev, 'BEGIN') || isKw(prev, 'TRY') || isKw(prev, 'CATCH');
  }

  // True when the token at j starts a label definition `name:` (01 §4.1 GOTO and labels).
  labelAt(j) {
    return this.isIdent(this.t[j]) && isOp(this.t[j + 1], ':');
  }

  statementInner(body) {
    const t = this.peek;
    if (isOp(t, '(')) return this.selectStmt(null, t);
    if (this.labelAt(this.i)) return this.labelStmt();
    if (t.t !== 'id') throw this.syntax();
    switch (t.k) {
      case 'SELECT': return this.selectStmt(null, t);
      case 'WITH': return this.withStmt(body);
      case 'INSERT': return this.insertStmt(null, t);
      case 'UPDATE': return this.updateStmt(null, t);
      case 'DELETE': return this.deleteStmt(null, t);
      case 'TRUNCATE': return this.truncateStmt();
      case 'DECLARE': return this.declareStmt();
      case 'SET': return this.setStmt();
      case 'PRINT': { this.i++; const expr = this.expr(); return { type: 'print', expr, pos: t.s, end: this.end() }; }
      case 'IF': return this.ifStmt();
      case 'WHILE': return this.whileStmt();
      case 'BEGIN': return this.beginStmt();
      case 'BREAK': case 'CONTINUE': {
        if (!this.loopDepth) throw err(t.k === 'BREAK' ? 135 : 136, t.s, t.e);
        this.i++;
        return { type: t.k.toLowerCase(), pos: t.s, end: t.e };
      }
      case 'RETURN': return this.returnStmt();
      case 'CREATE': return this.createStmt();
      case 'DROP': return this.dropStmt();
      case 'THROW': return this.throwStmt(body);
      case 'RAISERROR': return this.raiserrorStmt();
      case 'WAITFOR': return this.waitforStmt();
      case 'EXEC': case 'EXECUTE': return this.execStmt();
      case 'REVERT': return this.revertStmt();
      case 'GOTO': return this.gotoStmt();
      case 'OPEN': case 'CLOSE': case 'DEALLOCATE': return this.cursorStmt();
      case 'FETCH': return this.fetchStmt();
      case 'COMMIT': case 'ROLLBACK': case 'SAVE': return this.tranError();
      case 'MERGE': throw mkErr(MERGE_MSG, 0, t.s, t.e);
      case 'USE': throw mkErr('USE is not supported: SQL Studio always queries the current environment.', 0, t.s, t.e);
      default: throw this.syntax();
    }
  }

  // ----- GOTO and labels (01 §4.1)
  // `name:` defines a label of the batch (132 when it is defined twice).
  labelStmt() {
    const t = this.peek;
    const name = this.readIdent();
    this.i++;
    const st = { type: 'label', name, pos: t.s, end: this.end() };
    if (this.labelMode === 'check') {
      const key = lower(name);
      if (this.labelMap.has(key)) throw err(132, st.pos, st.end, name);
      this.labelMap.set(key, { scopes: this.scopes.slice() });
    } else if (this.labelMode === 'collect') {
      this.labels.push({ name, scopes: this.scopes.slice(), pos: st.pos, end: st.end });
    }
    return st;
  }

  // GOTO name: resolved when the batch has been parsed (resolveGotos).
  gotoStmt() {
    const t = this.next();
    const label = this.readIdent();
    const st = { type: 'goto', label, pos: t.s, end: this.end() };
    if (this.labelMode !== 'off') this.gotos.push({ label, scopes: this.scopes.slice(), pos: st.pos, end: st.end });
    return st;
  }

  // ----- cursors (01 §4.1 Cursors)
  // A cursor variable (`@c` where a cursor name is expected) is refused.
  cursorVarError(t, endTok = t) {
    return mkErr(CURSOR_VAR_MSG, 0, t.s, endTok.e);
  }

  // [GLOBAL] cursor_name of OPEN, CLOSE, DEALLOCATE and FETCH: {name, global}.
  cursorName() {
    let global = false;
    if (this.kw('GLOBAL') && (this.isIdent(this.la(1)) || this.la(1).t === 'var')) { this.i++; global = true; }
    if (this.peek.t === 'var') throw this.cursorVarError(this.peek);
    return { name: this.readIdent(), global };
  }

  // OPEN, CLOSE and DEALLOCATE [GLOBAL] c.
  cursorStmt() {
    const t = this.next();
    const { name, global } = this.cursorName();
    return { type: lower(t.k), name, global, pos: t.s, end: this.end() };
  }

  // FETCH [[NEXT | PRIOR | FIRST | LAST | ABSOLUTE n | RELATIVE n] FROM] [GLOBAL] c [INTO @a, …]
  fetchStmt() {
    const t = this.next();
    let dir = 'next';
    let n = null;
    const d = this.peek;
    if (d.t === 'id' && FETCH_DIRS.has(d.k)) {
      const takesN = d.k === 'ABSOLUTE' || d.k === 'RELATIVE';
      const after = this.la(1);
      // `… ORDER BY a FETCH NEXT 5 ROWS ONLY` without OFFSET is a syntax error, not a cursor FETCH.
      if ((d.k === 'NEXT' || d.k === 'FIRST') && (after.t === 'num' || isOp(after, '('))) throw this.syntax(t);
      if (takesN || isKw(after, 'FROM')) {
        this.i++;
        dir = lower(d.k);
        if (takesN) n = this.fetchCount();
        this.expectKw('FROM');
      }
    } else this.eatKw('FROM');
    const { name, global } = this.cursorName();
    let into = null;
    if (this.eatKw('INTO')) {
      into = [];
      do {
        const v = this.peek;
        if (v.t !== 'var' || v.v.startsWith('@@')) throw this.syntax();
        this.i++;
        this.useVar(v, 'scalar');
        into.push(v.v);
      } while (this.eatOp(','));
    }
    return { type: 'fetch', name, global, dir, n, into, pos: t.s, end: this.end() };
  }

  // The n of ABSOLUTE / RELATIVE: an integer literal (with an optional sign), a variable or a parenthesised constant
  // expression (01 §4.1 Cursors): one without columns, subqueries and aggregate or window calls.
  fetchCount() {
    const t = this.peek;
    if (isOp(t, '(')) {
      const e = this.parenExpr();
      const bad = nonConstant(e);
      if (bad !== null) throw this.syntax(this.t.find(x => x.s === bad) ?? t, true);
      return e;
    }
    if (t.t === 'var') { this.i++; return this.varRef(t); }
    const neg = isOp(t, '-') || isOp(t, '+');
    const n = neg ? this.la(1) : t;
    if (!isIntTok(n)) throw this.syntax(n);
    this.i += neg ? 2 : 1;
    return this.numLit(n, t.v === '-' ? '-' : '', t.s);
  }

  // DECLARE c [INSENSITIVE] [SCROLL] CURSOR [LOCAL|GLOBAL] [FORWARD_ONLY|SCROLL] [STATIC|FAST_FORWARD] [READ_ONLY]
  // FOR select [FOR READ_ONLY]. The ISO options (before CURSOR) and the extended ones (after it) do not mix.
  declareCursor(declTok) {
    const name = this.readIdent();
    const options = [];
    let iso = false;
    while (this.kw('INSENSITIVE') || this.kw('SCROLL')) {
      const o = this.next();
      if (options.includes(o.k)) throw this.syntax(o);
      options.push(o.k);
      iso = true;
    }
    this.expectKw('CURSOR');
    for (;;) {
      const o = this.peek;
      if (o.t !== 'id' || !(CURSOR_OPTS.has(o.k) || CURSOR_NO.has(o.k))) break;
      if (iso) throw this.syntax(o, true);
      if (CURSOR_NO.has(o.k)) throw mkErr(CURSOR_RO_MSG, 0, o.s, o.e);
      if (options.includes(o.k)) throw this.syntax(o, true);
      for (const [a, b] of CURSOR_CONFLICTS) {
        if ((o.k === a && options.includes(b)) || (o.k === b && options.includes(a))) throw mkErr(CONFLICT_MSG(a, b), 0, o.s, o.e);
      }
      this.i++;
      options.push(o.k);
    }
    this.expectKw('FOR');
    let ctes = null;
    let xmlns = null;
    if (this.kw('WITH') && this.isIdent(this.la(1))) ({ ctes, xmlns } = this.withClause());
    else if (!(this.kw('SELECT') || this.op('('))) throw this.syntax();
    const query = this.queryExpr({ nested: false, with: ctes, xmlns, into: { first: true, cursor: true }, assign: true });
    this.checkCursorQuery(query);
    const hints = this.optionClause();
    if (this.kw('FOR')) {
      const f = this.next();
      if (this.kw('UPDATE')) {
        this.i++;
        if (this.eatKw('OF')) this.identList();
        throw mkErr(CURSOR_RO_MSG, 0, f.s, this.end());
      }
      if (this.kw('READ_ONLY')) this.i++;
      else if (this.kw('READ') && this.kwAt(1, 'ONLY')) this.i += 2;
      else throw this.syntax();
      if (!options.includes('READ_ONLY')) options.push('READ_ONLY');
    }
    return { type: 'declarecursor', name, options, query, hints, pos: declTok.s, end: this.end() };
  }

  // FOR XML (6819), FOR JSON and variable assignments (141) are not allowed in a cursor's query.
  checkCursorQuery(q) {
    if (q.forXml) { const p = this.forPos.get(q); throw err(6819, p.pos, p.end, 'CURSOR'); }
    if (q.forJson) { const p = this.forPos.get(q); throw mkErr(CURSOR_JSON_MSG, 0, p.pos, p.end); }
    for (const c of this.cores(q)) {
      const a = c.cols.find(x => x.assign);
      if (a) throw err(141, a.pos, a.end);
    }
  }

  tranError() {
    const t = this.next();
    if (t.k === 'BEGIN') this.eatKw('DISTRIBUTED');
    if (this.kw('TRAN') || this.kw('TRANSACTION') || this.kw('WORK')) this.i++;
    const n = this.peek;
    if (n.t === 'var' || n.t === 'qid' || (n.t === 'id' && !RESERVED.has(n.k) && !STMT_START.has(n.k))) this.i++;
    throw mkErr(TRAN_MSG, 0, t.s, this.end());
  }

  beginStmt() {
    const t = this.peek;
    const n1 = this.la(1);
    if (isKw(n1, 'TRAN') || isKw(n1, 'TRANSACTION') || isKw(n1, 'DISTRIBUTED')) return this.tranError();
    if (isKw(n1, 'TRY')) return this.tryStmt();
    if (isKw(n1, 'CATCH')) throw this.syntax(n1);
    this.i++;
    const body = this.list(() => this.kw('END'));
    if (!body.length) throw this.syntax();
    this.expectKw('END');
    return { type: 'block', body, pos: t.s, end: this.end() };
  }

  // BEGIN TRY … END TRY BEGIN CATCH … END CATCH; each body is a scope that GOTO may not jump into (1026).
  tryStmt() {
    const pos = this.peek.s;
    this.i += 2;
    this.scopes.push(pos);
    let body;
    // END always closes the body (a nested BEGIN … END consumes its own), so TRY or CATCH must follow it.
    try { body = this.list(() => this.kw('END')); } finally { this.scopes.pop(); }
    if (!body.length) throw this.syntax();
    this.expectKw('END');
    this.expectKw('TRY');
    while (this.op(';')) this.i++;
    const catchPos = this.expectKw('BEGIN').s;
    this.expectKw('CATCH');
    this.catchDepth++;
    this.scopes.push(catchPos);
    let cat;
    try { cat = this.list(() => this.kw('END')); } finally { this.catchDepth--; this.scopes.pop(); }
    this.expectKw('END');
    this.expectKw('CATCH');
    return { type: 'try', body, catch: cat, pos, end: this.end() };
  }

  // WHILE cond body: BREAK and CONTINUE are valid anywhere inside the body (135 / 136 elsewhere).
  whileStmt() {
    const t = this.next();
    const cond = this.expr();
    this.loopDepth++;
    let body;
    try { body = this.body(); } finally { this.loopDepth--; }
    return { type: 'while', cond, body, pos: t.s, end: this.end() };
  }

  ifStmt() {
    const pos = this.next().s;
    const cond = this.expr();
    const then = this.body();
    let els = null;
    let j = this.i;
    while (isOp(this.t[j], ';')) j++;
    if (isKw(this.t[j], 'ELSE')) { this.i = j + 1; els = this.body(); }
    return { type: 'if', cond, then, else: els, pos, end: this.end() };
  }

  returnStmt() {
    const t = this.next();
    const n = this.peek;
    if (n.t === 'num' || n.t === 'str' || n.t === 'var' || (n.t === 'op' && '(-+~'.includes(n.v)) ||
      (n.t === 'id' && !RESERVED.has(n.k) && !STMT_START.has(n.k) && isOp(this.la(1), '('))) {
      throw err(178, n.s, n.e);
    }
    return { type: 'return', pos: t.s, end: t.e };
  }

  // A literal (optionally negative) or a variable: THROW, RAISERROR, WAITFOR and EXECUTE AS arguments.
  constOrVar() {
    const t = this.peek;
    if (t.t === 'num') { this.i++; return this.numLit(t, '', t.s); }
    if (t.t === 'op' && t.v === '-' && this.la(1).t === 'num' && !this.la(1).bin) { this.i++; const n = this.next(); return this.numLit(n, '-', t.s); }
    if (t.t === 'str') { this.i++; return this.strLit(t); }
    if (t.t === 'var') { this.i++; return this.varRef(t); }
    throw this.syntax();
  }

  throwStmt(body) {
    const t = this.peek;
    if (!this.placementOk(body)) throw this.syntax(t);
    this.i++;
    const n = this.peek;
    const args = [];
    if (n.t === 'num' || n.t === 'str' || n.t === 'var' || (isOp(n, '-') && this.la(1).t === 'num')) {
      args.push(this.constOrVar());
      this.expectOp(',');
      args.push(this.constOrVar());
      this.expectOp(',');
      args.push(this.constOrVar());
    } else if (!this.catchDepth) {
      throw err(10704, t.s, t.e);
    }
    return { type: 'throw', args, pos: t.s, end: this.end() };
  }

  raiserrorStmt() {
    const t = this.next();
    this.expectOp('(');
    const args = [this.constOrVar()];
    while (this.eatOp(',')) args.push(this.constOrVar());
    if (args.length < 3) throw this.syntax();
    this.expectOp(')');
    const options = [];
    if (this.eatKw('WITH')) {
      do {
        const o = this.peek;
        if (!(isKw(o, 'NOWAIT') || isKw(o, 'LOG') || isKw(o, 'SETERROR'))) throw this.syntax();
        this.i++;
        if (!options.includes(o.k)) options.push(o.k);
      } while (this.eatOp(','));
    }
    return { type: 'raiserror', args, options, pos: t.s, end: this.end() };
  }

  // WAITFOR DELAY 'hh:mm:ss[.mmm]' | TIME 'hh:mm[:ss[.mmm]]': a string literal or a variable (the time text
  // and the 24-hour limit are checked when it runs, 02 §9).
  waitforStmt() {
    const t = this.next();
    const k = this.peek;
    if (!(isKw(k, 'DELAY') || isKw(k, 'TIME'))) throw this.syntax();
    this.i++;
    const a = this.peek;
    if (!(a.t === 'str' || (a.t === 'var' && !a.v.startsWith('@@')))) throw this.syntax();
    const expr = this.constOrVar();
    return { type: 'waitfor', kind: lower(k.k), expr, pos: t.s, end: this.end() };
  }

  revertStmt() {
    const t = this.next();
    if (this.kw('WITH')) throw this.syntax();
    return { type: 'revert', pos: t.s, end: t.e };
  }

  // EXEC [@ret =] name [args]: a Web API message (`exec`), or dynamic SQL (`execsql`) for sp_executesql and
  // EXEC (string [+ …]) (01 §4.1).
  execStmt() {
    const t = this.next();
    if (this.kw('AS')) return this.executeAs(t);
    if (this.op('(')) return this.execString(t);
    let assignTo = null;
    const v = this.peek;
    if (v.t === 'var' && isOp(this.la(1), '=')) {
      this.i += 2;
      this.useVar(v, 'scalar');
      assignTo = v.v;
    }
    if (this.peek.t === 'var') throw mkErr('EXEC of a variable is not supported. Write the message name, e.g. EXEC WhoAmI.', 0, t.s, this.peek.e);
    const name = this.messageName();
    const params = this.startsExpr(this.peek) ? this.execArgs() : [];
    const p = name.parts;
    const last = lower(p[p.length - 1]);
    if (last === 'sp_executesql' && (p.length === 1 || (p.length === 2 && (lower(p[0]) === 'sys' || lower(p[0]) === 'dbo')))) {
      return this.execSql(t, name, params, assignTo);
    }
    return { type: 'exec', name, params, assignTo, pos: t.s, end: this.end() };
  }

  // The message name of EXEC: an ObjectName. Dataverse message names are not T-SQL identifiers, so a reserved word
  // that cannot start a statement is a one-part message name too: `EXEC Restore @Target = …` (00 §2, 02 §8.1).
  messageName() {
    const t = this.peek;
    if (t.t === 'id' && RESERVED.has(t.k) && !STMT_START.has(t.k) && !isOp(this.la(1), '.')) {
      this.i++;
      return { parts: [t.v], pos: t.s, end: t.e };
    }
    return this.objectName();
  }

  // The argument list of EXEC: `value | @name = value [OUT|OUTPUT]`, positional ones first (119 otherwise).
  execArgs() {
    const out = [];
    let named = false;
    do {
      const p = this.execParam();
      if (p.name !== null) named = true;
      else if (named) throw err(119, p.pos, p.end, out.length + 1);
      out.push(p);
    } while (this.eatOp(','));
    return out;
  }

  // One EXEC argument; OUTPUT needs a variable (179 for anything else).
  execParam() {
    const t = this.peek;
    let name = null;
    if (t.t === 'var' && isOp(this.la(1), '=')) {
      this.checkVarTok(t);
      if (t.v.startsWith('@@')) throw this.syntax(t);
      name = t.raw;
      this.i += 2;
    }
    const expr = this.kw('DEFAULT') ? this.defaultNode() : this.expr();
    let output = false;
    if (this.kw('OUTPUT') || this.kw('OUT')) {
      if (expr.type !== 'var' || expr.name.startsWith('@@')) throw err(179, expr.pos, this.peek.e);
      this.i++;
      output = true;
    }
    return { name, expr, output, pos: t.s, end: this.end() };
  }

  // EXEC sp_executesql [@stmt =] stmt [, [@params =] params [, value | @name = value [OUTPUT] …]]. Without a
  // statement it raises 214; the values after params map to its parameters when the EXEC runs (02 §9).
  execSql(t, name, list, assignTo) {
    const fixed = (k, pname) => {
      const a = list[k];
      if (!a || (a.name !== null && lower(a.name) !== pname)) return null;
      if (a.output) throw this.syntax(this.tokAfter(a.expr.end));
      return a;
    };
    const st = fixed(0, '@stmt');
    if (!st) throw err(214, list.length ? list[0].pos : t.s, list.length ? list[0].end : name.end, '@statement', 'ntext/nchar/nvarchar');
    const pa = fixed(1, '@params');
    const args = list.slice(pa ? 2 : 1);
    return { type: 'execsql', stmt: st.expr, params: pa ? pa.expr : null, args, dynamic: false, assignTo, pos: t.s, end: this.end() };
  }

  // The first token that starts at or after offset p.
  tokAfter(p) {
    let k = 0;
    while (k < this.t.length - 1 && this.t[k].s < p) k++;
    return this.t[k];
  }

  // EXEC ( string_or_variable [+ …] ): dynamic SQL without parameters.
  execString(t) {
    this.i++;
    let stmt = null;
    do {
      const a = this.peek;
      if (!(a.t === 'str' || (a.t === 'var' && !a.v.startsWith('@@')))) throw this.syntax();
      const e = this.constOrVar();
      stmt = stmt ? { type: 'bin', op: '+', l: stmt, r: e, pos: stmt.pos, end: e.end } : e;
    } while (this.eatOp('+'));
    this.expectOp(')');
    return { type: 'execsql', stmt, params: null, args: [], dynamic: true, assignTo: null, pos: t.s, end: this.end() };
  }

  executeAs(execTok) {
    this.i++;
    const k = this.peek;
    if (isKw(k, 'CALLER') || isKw(k, 'SELF') || isKw(k, 'OWNER')) {
      throw mkErr(`EXECUTE AS ${k.k} is not supported. Use EXECUTE AS USER = '<systemuserid>' or EXECUTE AS LOGIN = '<domain name>'.`, 0, execTok.s, k.e);
    }
    if (!(isKw(k, 'USER') || isKw(k, 'LOGIN'))) throw this.syntax();
    this.i++;
    this.expectOp('=');
    const expr = this.constOrVar();
    return { type: 'executeas', kind: k.k.toLowerCase(), expr, pos: execTok.s, end: this.end() };
  }

  // Tokens that can start an expression (EXEC parameters); a label `name:` starts the next statement instead.
  startsExpr(t) {
    if (t === this.peek && this.labelAt(this.i)) return false;
    if (t.t === 'num' || t.t === 'str' || t.t === 'var' || t.t === 'qid') return true;
    if (t.t === 'op') return t.v === '(' || t.v === '-' || t.v === '+' || t.v === '~';
    if (t.t !== 'id') return false;
    if (t.k === 'NULL' || t.k === 'CASE' || t.k === 'DEFAULT' || t.k === 'CURRENT_TIMESTAMP' || USER_FNS.has(t.k) || CALLABLE.has(t.k)) return true;
    return !RESERVED.has(t.k) && t.k !== 'THROW';
  }

  defaultNode() {
    const t = this.next();
    return { type: 'default', pos: t.s, end: t.e };
  }

  // Declares left to right, as SQL Server: each variable is visible from the end of its own entry (initializer
  // included), so `DECLARE @a int = 1, @b int = @a + 1` is valid and `DECLARE @x int = @x` raises 137.
  declareStmt() {
    const declTok = this.next();
    const pos = declTok.s;
    const vars = [];
    if (this.isIdent(this.peek)) {
      const n = this.la(1);
      if (isKw(n, 'CURSOR') || isKw(n, 'INSENSITIVE') || isKw(n, 'SCROLL')) return this.declareCursor(declTok);
    }
    do {
      const t = this.peek;
      if (t.t !== 'var' || t.v.startsWith('@@')) throw this.syntax();
      this.checkVarTok(t);
      this.i++;
      this.eatKw('AS');
      if (this.kw('CURSOR')) throw this.cursorVarError(t, this.peek);
      this.checkNewVar(t);
      if (this.kw('TABLE')) {
        this.i++;
        const table = this.columnDefs(t.raw);
        this.declareVar(t.v, 'table');
        vars.push({ name: t.v, table, pos: t.s, end: this.end() });
      } else {
        const dataType = this.dataType();
        const init = this.eatOp('=') ? this.expr() : null;
        this.declareVar(t.v, 'scalar');
        vars.push({ name: t.v, dataType, init, pos: t.s, end: this.end() });
      }
    } while (this.eatOp(','));
    return { type: 'declare', vars, pos, end: this.end() };
  }

  // Makes a DECLAREd variable visible to the rest of the batch.
  declareVar(name, kind) {
    if (this.checks) this.vars.set(name, kind);
  }

  setStmt() {
    const setTok = this.next();
    const v = this.peek;
    if (v.t === 'var') {
      if (v.v.startsWith('@@')) throw this.syntax(v);
      if (this.methodAt(this.i + 1)) this.xmlDmlStatement(this.i + 1);
      if (isOp(this.la(1), '=') && this.kwAt(2, 'CURSOR')) throw this.cursorVarError(v, this.la(2));
      this.i++;
      this.useVar(v, 'scalar');
      const o = this.peek;
      if (o.t !== 'op' || !ASSIGN_OPS.has(o.v)) throw this.syntax();
      this.i++;
      const expr = this.expr();
      return { type: 'setvar', name: v.v, op: o.v, expr, pos: setTok.s, end: this.end() };
    }
    return this.setOption(setTok);
  }

  // `SET @x.modify(…)` / `UPDATE t SET c.modify(…)` (XML DML) is refused; another method there is a syntax
  // error. j is the index of the '.' before the method name.
  xmlDmlStatement(j) {
    const m = this.t[j + 1];
    if (lower(m.v) !== 'modify') throw this.syntax(this.t[j]);
    const close = this.closeOf(j + 2);
    throw mkErr(XML_DML_MSG, 0, m.s, close >= 0 ? this.t[close].e : m.e);
  }

  // Text of the tokens [a, b) for `SET <option> <value> is not supported.`
  optionText(a, b) {
    const parts = [];
    for (let j = a; j < b; j++) {
      const t = this.t[j];
      if (t.t === 'id') parts.push(/^[#@]/.test(t.v) ? t.v : t.k);
      else if (t.t === 'qid') parts.push(`[${t.v}]`);
      else if (t.t === 'str') parts.push(`'${t.v}'`);
      else parts.push(this.src.slice(t.s, t.e));
    }
    return parts.join(' ').replace(/ ,/g, ',');
  }

  setOption(setTok) {
    const pos = setTok.s;
    const t1 = this.peek;
    if (t1.t !== 'id') throw this.syntax();
    const unsupported = text => mkErr(`SET ${text} is not supported.`, 0, pos, this.end());
    // SET opt [, opt]... ON | OFF
    const names = [];
    let j = this.i;
    for (;;) {
      const t = this.t[j];
      if (t.t !== 'id' || t.k === 'ON' || t.k === 'OFF') break;
      names.push(t);
      j++;
      if (!isOp(this.t[j], ',')) break;
      j++;
      const n = this.t[j];
      if (n.t !== 'id' || n.k === 'ON' || n.k === 'OFF') { this.i = j; throw this.syntax(); }
    }
    const onoff = this.t[j];
    if (names.length && (isKw(onoff, 'ON') || isKw(onoff, 'OFF'))) {
      this.i = j + 1;
      const end = this.end();
      const on = onoff.k === 'ON';
      const out = [];
      for (const n of names) {
        if (n.k === 'NOCOUNT' || n.k === 'QUOTED_IDENTIFIER') out.push({ type: 'setopt', name: n.k, value: on, pos, end });
        else if (on && NOOP_ON.has(n.k)) out.push({ type: 'noop', what: n.k + ' ON', pos, end });
        else throw unsupported(`${n.k} ${onoff.k}`);
      }
      return out.length === 1 ? out[0] : out;
    }
    const k1 = t1.k;
    if (k1 === 'DATEFORMAT' || k1 === 'LANGUAGE' || k1 === 'DATEFIRST') {
      this.i++;
      const v = this.peek;
      if (v.t === 'var') { this.i++; throw unsupported(`${k1} ${v.raw}`); }
      if (k1 === 'DATEFIRST') {
        if (v.t !== 'num') throw this.syntax();
        this.i++;
        if (!isIntTok(v) || v.v < 1 || v.v > 7) throw unsupported(`DATEFIRST ${v.raw}`);
        return { type: 'setopt', name: 'DATEFIRST', value: v.v, pos, end: this.end() };
      }
      if (!(v.t === 'id' || v.t === 'str' || v.t === 'qid')) throw this.syntax();
      this.i++;
      const s = lower(v.v);
      if (k1 === 'DATEFORMAT') {
        if (!DATEFORMATS.has(s)) throw unsupported(`DATEFORMAT ${v.v}`);
        return { type: 'setopt', name: 'DATEFORMAT', value: s, pos, end: this.end() };
      }
      let value = null;
      if (s === 'us_english' || s === 'english') value = 'us_english';
      else if (s === 'british') value = 'British';
      if (!value) throw mkErr(`Language '${v.v}' is not supported.`, 0, pos, this.end());
      return { type: 'setopt', name: 'LANGUAGE', value, pos, end: this.end() };
    }
    if (k1 === 'TRANSACTION' && this.kwAt(1, 'ISOLATION') && this.kwAt(2, 'LEVEL')) {
      this.i += 3;
      const words = [];
      while (this.peek.t === 'id' && !STMT_START.has(this.peek.k) && words.length < 2) words.push(this.next().k);
      const level = words.join(' ');
      if (level === 'READ COMMITTED' || level === 'READ UNCOMMITTED') return { type: 'noop', what: 'TRANSACTION ISOLATION LEVEL ' + level, pos, end: this.end() };
      if (!words.length) throw this.syntax();
      throw unsupported('TRANSACTION ISOLATION LEVEL ' + level);
    }
    const a = this.i;
    while (!(this.peek.t === 'end' || this.op(';') || (this.peek.t === 'id' && STMT_START.has(this.peek.k) && this.i > a))) this.i++;
    throw unsupported(this.optionText(a, this.i));
  }

  createStmt() {
    const t = this.next();
    const only = () => mkErr('Only #temp tables can be created. Use CREATE TABLE #name (...).', 0, t.s, this.peek.e);
    if (!this.kw('TABLE')) throw only();
    this.i++;
    if (!this.isIdent(this.peek)) throw this.syntax();
    const name = this.objectName();
    if (name.parts.length !== 1 || !name.parts[0].startsWith('#')) throw mkErr('Only #temp tables can be created. Use CREATE TABLE #name (...).', 0, t.s, name.end);
    this.checkTempName(name);
    const cols = this.columnDefs(name.parts[0]);
    return { type: 'create', name, cols, pos: t.s, end: this.end() };
  }

  dropStmt() {
    const t = this.next();
    this.expectKw('TABLE');
    let ifExists = false;
    if (this.kw('IF')) { this.i++; this.expectKw('EXISTS'); ifExists = true; }
    const names = [];
    do names.push(this.objectName()); while (this.eatOp(','));
    return { type: 'drop', names, ifExists, pos: t.s, end: this.end() };
  }

  truncateStmt() {
    const t = this.next();
    this.expectKw('TABLE');
    const target = this.objectName();
    return { type: 'delete', with: null, xmlns: null, top: null, target, output: null, from: null, where: null, hints: emptyHints(), truncate: true, pos: t.s, end: this.end() };
  }

  // ----- CREATE TABLE / DECLARE @t TABLE column definitions (01 §4.1)
  columnDefs(tableName) {
    this.expectOp('(');
    const cols = [];
    const st = { tableName, names: new Set(), pk: false, identity: false, pkCols: [], explicitNull: new Set() };
    for (;;) {
      const t = this.peek;
      if (isKw(t, 'CONSTRAINT') || isKw(t, 'PRIMARY') || isKw(t, 'UNIQUE') || isKw(t, 'CHECK') || isKw(t, 'FOREIGN')) this.tableConstraint(st);
      else cols.push(this.columnDef(st));
      if (!this.eatOp(',')) break;
      if (this.op(')') && cols.length) break;
    }
    if (!cols.length) throw this.syntax();
    this.expectOp(')');
    for (const pc of st.pkCols) {
      const c = cols.find(x => lower(x.name) === lower(pc.name));
      if (!c) throw err(1911, pc.pos, pc.end, pc.name);
      if (st.explicitNull.has(c)) throw err(8111, pc.pos, pc.end, tableName);
      c.pk = true;
      c.nullable = false;
    }
    return cols;
  }

  columnDef(st) {
    const t = this.peek;
    const name = this.readIdent();
    if (st.names.has(lower(name))) throw err(2705, t.s, t.e, name, st.tableName);
    st.names.add(lower(name));
    const dataType = this.dataType();
    const col = { name, dataType, nullable: true, identity: null, default: null, pk: false };
    let explicitNull = false;
    for (;;) {
      const k = this.peek;
      if (isKw(k, 'NULL')) { this.i++; col.nullable = true; explicitNull = true; continue; }
      if (isKw(k, 'NOT') && this.kwAt(1, 'NULL')) { this.i += 2; col.nullable = false; continue; }
      if (isKw(k, 'IDENTITY')) {
        this.i++;
        if (st.identity) throw err(2744, k.s, k.e, st.tableName);
        st.identity = true;
        let seed = 1;
        let step = 1;
        if (this.eatOp('(')) {
          seed = this.signedInt();
          this.expectOp(',');
          step = this.signedInt();
          this.expectOp(')');
        }
        const dn = dataType.name;
        const okType = ['int', 'bigint', 'smallint', 'tinyint'].includes(dn) || ((dn === 'decimal' || dn === 'numeric') && (dataType.args[1] ?? 0) === 0);
        if (!okType) throw err(2749, t.s, this.end(), name);
        col.identity = { seed, step };
        col.nullable = false;
        continue;
      }
      const cstart = k.s;
      let named = false;
      if (isKw(k, 'CONSTRAINT')) { this.i++; this.readIdent(); named = true; }
      const c = this.peek;
      if (isKw(c, 'DEFAULT')) { this.i++; col.default = this.expr(); continue; }
      if (isKw(c, 'PRIMARY')) {
        this.i++;
        this.expectKw('KEY');
        if (!this.eatKw('CLUSTERED')) this.eatKw('NONCLUSTERED');
        if (st.pk) throw err(8110, cstart, this.end(), st.tableName);
        st.pk = true;
        col.pk = true;
        col.nullable = false;
        this.warn(cstart, this.end(), 'Constraint not enforced: PRIMARY KEY.');
        continue;
      }
      if (isKw(c, 'UNIQUE')) {
        this.i++;
        if (!this.eatKw('CLUSTERED')) this.eatKw('NONCLUSTERED');
        this.warn(cstart, this.end(), 'Constraint not enforced: UNIQUE.');
        continue;
      }
      if (isKw(c, 'CHECK')) {
        this.i++;
        this.expectOp('(');
        this.expr();
        this.expectOp(')');
        this.warn(cstart, this.end(), 'Constraint not enforced: CHECK.');
        continue;
      }
      if (isKw(c, 'FOREIGN') || isKw(c, 'REFERENCES')) {
        if (this.eatKw('FOREIGN')) this.expectKw('KEY');
        this.references();
        this.warn(cstart, this.end(), 'Constraint not enforced: FOREIGN KEY.');
        continue;
      }
      if (named) throw this.syntax();
      break;
    }
    if (explicitNull && col.pk) throw err(8111, t.s, this.end(), st.tableName);
    if (explicitNull && col.identity) throw err(8147, t.s, this.end(), name, st.tableName);
    if (explicitNull) st.explicitNull.add(col);
    return col;
  }

  tableConstraint(st) {
    const start = this.peek.s;
    if (this.eatKw('CONSTRAINT')) this.readIdent();
    const c = this.peek;
    if (isKw(c, 'PRIMARY') || isKw(c, 'UNIQUE')) {
      this.i++;
      if (c.k === 'PRIMARY') this.expectKw('KEY');
      if (!this.eatKw('CLUSTERED')) this.eatKw('NONCLUSTERED');
      this.expectOp('(');
      const cols = [];
      do {
        const t = this.peek;
        const name = this.readIdent();
        if (!this.eatKw('ASC')) this.eatKw('DESC');
        cols.push({ name, pos: t.s, end: t.e });
      } while (this.eatOp(','));
      this.expectOp(')');
      if (c.k === 'PRIMARY') {
        if (st.pk) throw err(8110, start, this.end(), st.tableName);
        st.pk = true;
        st.pkCols.push(...cols);
      }
      this.warn(start, this.end(), `Constraint not enforced: ${c.k === 'PRIMARY' ? 'PRIMARY KEY' : 'UNIQUE'}.`);
      return;
    }
    if (isKw(c, 'CHECK')) {
      this.i++;
      this.expectOp('(');
      this.expr();
      this.expectOp(')');
      this.warn(start, this.end(), 'Constraint not enforced: CHECK.');
      return;
    }
    if (isKw(c, 'FOREIGN')) {
      this.i++;
      this.expectKw('KEY');
      this.parenIdentList();
      this.references();
      this.warn(start, this.end(), 'Constraint not enforced: FOREIGN KEY.');
      return;
    }
    throw this.syntax();
  }

  references() {
    this.expectKw('REFERENCES');
    if (this.peek.t === 'var') throw this.syntax();
    this.objectName();
    if (this.op('(')) this.parenIdentList();
    while (this.kw('ON')) {
      this.i++;
      if (!(this.eatKw('DELETE') || this.eatKw('UPDATE'))) throw this.syntax();
      if (this.eatKw('CASCADE')) continue;
      if (this.kw('NO') && this.kwAt(1, 'ACTION')) { this.i += 2; continue; }
      if (this.eatKw('SET')) { if (!(this.eatKw('NULL') || this.eatKw('DEFAULT'))) throw this.syntax(); continue; }
      throw this.syntax();
    }
    if (this.kw('NOT') && this.kwAt(1, 'FOR') && this.kwAt(2, 'REPLICATION')) this.i += 3;
  }

  signedInt() {
    const neg = this.eatOp('-');
    const t = this.peek;
    if (!isIntTok(t)) throw this.syntax();
    this.i++;
    return neg ? -t.v : t.v;
  }

  // DataType = { name /* lower case */, args: (number|'max')[] } (01 §4.1)
  dataType() {
    const t = this.peek;
    if (!(t.t === 'id' || t.t === 'qid')) throw this.syntax();
    let name;
    if (isKw(t, 'DOUBLE') && this.kwAt(1, 'PRECISION')) {
      this.i += 2;
      return { name: 'float', args: [53], pos: t.s, end: this.end() };
    }
    // Synonyms (01 §4.1 Type synonyms): NATIONAL CHAR[ACTER] [VARYING], NATIONAL TEXT, CHAR[ACTER] VARYING, NCHAR
    // VARYING, BINARY VARYING and a lone CHARACTER map to one type name, as in SQL Server.
    if (isKw(t, 'NATIONAL')) {
      this.i++;
      if (this.eatKw('TEXT')) name = 'ntext';
      else if (this.eatKw('CHAR') || this.eatKw('CHARACTER')) name = this.eatKw('VARYING') ? 'nvarchar' : 'nchar';
      else throw this.syntax();
    } else if ((isKw(t, 'CHAR') || isKw(t, 'CHARACTER')) && this.kwAt(1, 'VARYING')) {
      this.i += 2;
      name = 'varchar';
    } else if (isKw(t, 'NCHAR') && this.kwAt(1, 'VARYING')) {
      this.i += 2;
      name = 'nvarchar';
    } else if (isKw(t, 'BINARY') && this.kwAt(1, 'VARYING')) {
      this.i += 2;
      name = 'varbinary';
    } else if (isKw(t, 'CHARACTER')) {
      this.i++;
      name = 'char';
    } else {
      if (t.t === 'id' && RESERVED.has(t.k)) throw this.syntax();
      this.i++;
      name = lower(this.idText(t));
    }
    if (name === 'xml' && this.op('(')) {
      const close = this.closeOf(this.i);
      throw mkErr(XML_SCHEMA_MSG, 0, t.s, close >= 0 ? this.t[close].e : this.peek.e);
    }
    const args = [];
    if (this.eatOp('(')) {
      do {
        const a = this.peek;
        if (isKw(a, 'MAX')) { this.i++; args.push('max'); } else if (isIntTok(a)) { this.i++; args.push(a.v); } else throw this.syntax();
      } while (this.eatOp(','));
      this.expectOp(')');
    }
    return { name, args, pos: t.s, end: this.end() };
  }

  // ----- SELECT / WITH
  // A statement that starts with WITH: CTEs and/or WITH XMLNAMESPACES before SELECT, INSERT, UPDATE or DELETE (
  //); any other keyword after them raises 156.
  withStmt(body) {
    const w = this.peek;
    if (!this.isIdent(this.la(1))) throw this.syntax(w);
    if (!this.placementOk(body)) throw err(319, w.s, w.e);
    const { ctes, xmlns } = this.withClause();
    const n = this.peek;
    if (isOp(n, '(') || isKw(n, 'SELECT')) return this.selectStmt(ctes, w, xmlns);
    if (isKw(n, 'INSERT')) return this.insertStmt(ctes, w, xmlns);
    if (isKw(n, 'UPDATE')) return this.updateStmt(ctes, w, xmlns);
    if (isKw(n, 'DELETE')) return this.deleteStmt(ctes, w, xmlns);
    if (isKw(n, 'MERGE')) throw mkErr(MERGE_MSG, 0, n.s, n.e);
    throw this.syntax();
  }

  // WITH [XMLNAMESPACES (…) [, ]] [cte [(cols)] AS (query) [, …]] -> {ctes: Cte[]|null, xmlns: XmlNs[]|null}.
  withClause() {
    this.i++;
    let xmlns = null;
    if (this.kw('XMLNAMESPACES') && isOp(this.la(1), '(') && (this.la(2).t === 'str' || this.kwAt(2, 'DEFAULT'))) {
      xmlns = this.xmlNamespaces();
      if (!this.eatOp(',')) return { ctes: null, xmlns };
    }
    const ctes = [];
    const seen = new Set();
    do {
      const t = this.peek;
      const name = this.readIdent();
      if (seen.has(lower(name))) throw err(239, t.s, t.e, name);
      seen.add(lower(name));
      const columns = this.op('(') ? this.parenIdentList() : null;
      this.expectKw('AS');
      this.expectOp('(');
      const query = this.queryExpr({ nested: true });
      this.expectOp(')');
      ctes.push({ name, columns, query, pos: t.s, end: this.end() });
    } while (this.eatOp(','));
    return { ctes, xmlns };
  }

  // XMLNAMESPACES ('uri' AS prefix [, …] [, DEFAULT 'uri']) (01 §4.2): XmlNs[] in written order.
  xmlNamespaces() {
    this.i += 2;
    const list = [];
    const seen = new Set();
    let def = false;
    do {
      const t = this.peek;
      if (this.eatKw('DEFAULT')) {
        const u = this.peek;
        if (u.t !== 'str') throw this.syntax();
        this.i++;
        if (def) throw mkErr(XMLNS_MSG('DEFAULT'), 0, t.s, this.end());
        def = true;
        list.push({ prefix: null, uri: u.v, pos: t.s });
        continue;
      }
      if (t.t !== 'str') throw this.syntax();
      this.i++;
      this.expectKw('AS');
      const prefix = this.readIdent();
      const lp = lower(prefix);
      if (lp === 'xml' || lp === 'xmlns' || seen.has(prefix) || t.v === '') throw mkErr(XMLNS_MSG(prefix), 0, t.s, this.end());
      seen.add(prefix);
      list.push({ prefix, uri: t.v, pos: t.s });
    } while (this.eatOp(','));
    this.expectOp(')');
    return list;
  }

  selectStmt(ctes, startTok, xmlns = null) {
    const into = { first: true };
    const query = this.queryExpr({ nested: false, with: ctes, xmlns, into, assign: true });
    // A FOR that ends the batch leaves the FOR clause incomplete: 102 near FOR, as at every end of a batch (01 §2).
    if (this.kw('FOR') && this.la(1).t === 'end') throw this.syntax(this.la(1));
    const hints = this.optionClause();
    const st = { type: 'select', query, hints, pos: startTok.s, end: this.end() };
    this.checkSelectStatement(query);
    return st;
  }

  // The query blocks of a query, through set operations and parenthesised queries.
  cores(q) {
    const out = [];
    const walk = b => { if (b.type === 'core') out.push(b); else if (b.type === 'setop') { walk(b.left); walk(b.right); } else walk(b.body); };
    walk(q.body);
    return out;
  }

  // 141, 13602 and 6819: rules that need the whole top-level query.
  checkSelectStatement(q) {
    const cores = this.cores(q);
    let body = q.body;
    while (body.type === 'query') body = body.body;
    for (const c of cores) {
      const a = c.cols.find(x => x.assign);
      if (!a) continue;
      if (body.type !== 'core' || c.cols.some(x => !x.assign) || c.into || q.forJson || q.forXml) throw err(141, a.pos, a.end);
    }
    if (q.forJson && cores[0] && cores[0].into) throw err(13602, cores[0].into.pos, cores[0].into.end);
    if (q.forXml && cores[0] && cores[0].into) { const p = this.forPos.get(q); throw err(6819, p.pos, p.end, 'INTO'); }
  }

  // Query = { type:'query', with, xmlns, body, orderBy, offset, fetch, forJson?, forXml? } (01 §4.2). A plain
  // nested query (no WITH, INTO or assignment context) parses the same way wherever it is reached from, so its
  // outcome is memoised per token index and depth: the alternatives tried for `((`, `FROM ((` and `IN ((` then
  // never re-parse it, which keeps nested and incomplete text linear instead of 2^depth. Expression parsing adds no
  // warnings, but any are replayed on a memo hit; callers never mutate the returned node.
  queryExpr(ctx) {
    if (!(ctx.nested === true && !ctx.with && !ctx.xmlns && !ctx.into && !ctx.assign)) return this.queryExprAt(ctx);
    const at = this.i;
    const depth = this.depth;
    const m = this.memo.get(at);
    if (m && m.depth === depth) {
      if (m.err) throw m.err;
      this.i = m.end;
      for (const w of m.w) this.warnings.push(w);
      return m.q;
    }
    const w0 = this.warnings.length;
    try {
      const q = this.queryExprAt(ctx);
      this.memo.set(at, { depth, q, end: this.i, w: this.warnings.slice(w0) });
      return q;
    } catch (e) {
      if (e instanceof SqlError) this.memo.set(at, { depth, err: e });
      throw e;
    }
  }

  // The query parse itself (queryExpr adds the memo).
  queryExprAt(ctx) {
    this.enter();
    try {
      const pos = this.peek.s;
      const body = this.setUnion(ctx);
      let orderBy = null;
      let orderTok = null;
      let offset = null;
      let fetch = null;
      let forJson = null;
      let forXml = null;
      let forAt = null;
      if (this.kw('ORDER')) {
        orderTok = this.next();
        this.expectKw('BY');
        orderBy = this.orderList();
        if (this.kw('OFFSET')) {
          this.i++;
          offset = this.expr();
          if (!(this.eatKw('ROW') || this.eatKw('ROWS'))) throw this.syntax();
          if (this.kw('FETCH')) {
            this.i++;
            if (!(this.eatKw('FIRST') || this.eatKw('NEXT'))) throw this.syntax();
            fetch = this.expr();
            if (!(this.eatKw('ROW') || this.eatKw('ROWS'))) throw this.syntax();
            this.expectKw('ONLY');
          }
        }
      }
      if (this.forFollows()) {
        const f = this.next();
        if (this.kw('XML')) forXml = this.forXml(); else forJson = this.forJson();
        forAt = { pos: f.s, end: this.end() };
        if (this.forFollows()) throw this.syntax(this.peek, true);
      }
      const q = { type: 'query', with: ctx.with ?? null, xmlns: ctx.xmlns ?? null, body, orderBy, offset, fetch, pos, end: this.end() };
      if (forJson) q.forJson = forJson;
      if (forXml) q.forXml = forXml;
      if (forAt) this.forPos.set(q, forAt);
      this.checkQuery(q, ctx, orderTok);
      return q;
    } finally {
      this.depth--;
    }
  }

  checkQuery(q, ctx, orderTok) {
    const core = q.body.type === 'core' ? q.body : null;
    if (core && core.top && q.offset) throw err(10741, core.top.pos, core.top.end);
    const off = numLitOf(q.offset);
    if (off && !integralLit(off)) throw err(10743, q.offset.pos, q.offset.end);
    if (off && off.v < 0) throw err(10742, q.offset.pos, q.offset.end);
    const fe = numLitOf(q.fetch);
    if (fe && !integralLit(fe)) throw err(1060, q.fetch.pos, q.fetch.end);
    if (fe && fe.v <= 0) throw err(10744, q.fetch.pos, q.fetch.end);
    const ties = b => {
      if (b.type === 'core') { if (b.top && b.top.ties && !(b === core && q.orderBy)) throw err(1062, b.top.pos, b.top.end); }
      else if (b.type === 'setop') { ties(b.left); ties(b.right); }
    };
    ties(q.body);
    if (ctx.nested && q.orderBy && !(core && core.top) && !q.offset && !q.forJson && !q.forXml) throw err(1033, orderTok.s, orderTok.e);
  }

  // FOR XML or FOR JSON follows (any other FOR, such as a cursor's FOR READ_ONLY, ends the query).
  forFollows() {
    return this.kw('FOR') && (this.kwAt(1, 'XML') || this.kwAt(1, 'JSON'));
  }

  // FOR XML { RAW [('name')] | AUTO | PATH [('name')] | EXPLICIT } [, BINARY BASE64] [, TYPE] [, ROOT [('name')]]
  // [, ELEMENTS [XSINIL | ABSENT]] (01 §4.2): {mode, row, root, elements, type}.
  forXml() {
    this.i++;
    const m = this.peek;
    const mode = m.t === 'id' && (m.k === 'RAW' || m.k === 'AUTO' || m.k === 'PATH' || m.k === 'EXPLICIT') ? lower(m.k) : null;
    if (!mode) throw this.syntax();
    this.i++;
    let row = null;
    let rowTok = null;
    if ((mode === 'raw' || mode === 'path') && this.op('(')) {
      this.i++;
      rowTok = this.peek;
      if (rowTok.t !== 'str') throw this.syntax();
      this.i++;
      row = rowTok.v;
      this.expectOp(')');
    }
    const fx = { mode, row, root: null, elements: null, type: false };
    const seen = new Set();
    while (this.eatOp(',')) {
      const t = this.peek;
      if (isKw(t, 'XMLDATA') || isKw(t, 'XMLSCHEMA')) {
        this.i++;
        if (t.k === 'XMLSCHEMA' && this.op('(')) { this.i++; if (this.peek.t === 'str') this.i++; this.expectOp(')'); }
        throw mkErr(XMLDATA_MSG, 0, t.s, this.end());
      }
      const key = t.t === 'id' ? t.k : '';
      if (seen.has(key)) throw this.syntax(t, true);
      if (key === 'BINARY') {
        this.i++;
        this.expectKw('BASE64');
      } else if (key === 'TYPE') {
        this.i++;
        fx.type = true;
      } else if (key === 'ROOT') {
        this.i++;
        fx.root = 'root';
        if (this.eatOp('(')) {
          const s = this.peek;
          if (s.t !== 'str') throw this.syntax();
          this.i++;
          if (s.v === '') throw err(6861, t.s, this.op(')') ? this.peek.e : s.e);
          fx.root = s.v;
          this.expectOp(')');
        }
      } else if (key === 'ELEMENTS') {
        if (mode === 'explicit') throw err(6825, t.s, t.e);
        this.i++;
        if (this.eatKw('XSINIL')) fx.elements = 'xsinil';
        else { this.eatKw('ABSENT'); fx.elements = 'absent'; }
      } else throw this.syntax();
      seen.add(key);
    }
    if (mode === 'raw' && row === '' && !fx.elements) throw err(6864, m.s, this.end());
    return fx;
  }

  // FOR JSON { PATH | AUTO } [, ROOT [('name')]] [, INCLUDE_NULL_VALUES] [, WITHOUT_ARRAY_WRAPPER] (01 §4.1).
  forJson() {
    this.expectKw('JSON');
    let mode;
    if (this.eatKw('PATH')) mode = 'path';
    else if (this.eatKw('AUTO')) mode = 'auto';
    else throw this.syntax();
    const fj = { mode, root: null, includeNulls: false, withoutArrayWrapper: false };
    const seen = new Set();
    let rootTok = null;
    while (this.eatOp(',')) {
      const t = this.peek;
      if (seen.has(t.k)) throw this.syntax(t);
      if (isKw(t, 'ROOT')) {
        this.i++;
        rootTok = t;
        let root = 'root';
        if (this.eatOp('(')) {
          const s = this.peek;
          if (s.t !== 'str') throw this.syntax();
          this.i++;
          root = s.v;
          this.expectOp(')');
        }
        fj.root = root;
      } else if (isKw(t, 'INCLUDE_NULL_VALUES')) { this.i++; fj.includeNulls = true; } else if (isKw(t, 'WITHOUT_ARRAY_WRAPPER')) { this.i++; fj.withoutArrayWrapper = true; } else throw this.syntax();
      seen.add(t.k);
    }
    if (rootTok && fj.withoutArrayWrapper) throw err(13620, rootTok.s, this.end());
    return fj;
  }

  // UNION and EXCEPT: equal precedence, left-associative; INTERSECT binds tighter (01 §4.2).
  setUnion(ctx) {
    let left = this.setIntersect(ctx);
    for (;;) {
      const t = this.peek;
      const op = isKw(t, 'UNION') ? 'UNION' : isKw(t, 'EXCEPT') ? 'EXCEPT' : null;
      if (!op) return left;
      this.i++;
      let all = false;
      if (this.kw('ALL')) {
        if (op === 'EXCEPT') throw this.syntax(this.peek, true);
        this.i++;
        all = true;
      }
      const right = this.setIntersect(ctx);
      left = { type: 'setop', op, all, left, right, pos: left.pos, end: this.end() };
    }
  }

  setIntersect(ctx) {
    let left = this.setPrimary(ctx);
    while (this.kw('INTERSECT')) {
      this.i++;
      if (this.kw('ALL')) throw this.syntax(this.peek, true);
      const right = this.setPrimary(ctx);
      left = { type: 'setop', op: 'INTERSECT', all: false, left, right, pos: left.pos, end: this.end() };
    }
    return left;
  }

  // A query block or a parenthesised query expression. As in SQL Server's grammar, a parenthesised query expression
  // (a set-operation operand, or the body of a SELECT, INSERT … SELECT or cursor query) has no FOR XML / FOR JSON
  // clause: 156 near FOR. Subqueries, derived tables and CTEs keep theirs (01 §4.2), so INTO, INSERT and cursor
  // queries never hide one inside parentheses from 6819, 13602 and 141.
  setPrimary(ctx) {
    const t = this.peek;
    if (isOp(t, '(')) {
      this.i++;
      const q = this.queryExpr({ nested: true, into: ctx.into, assign: ctx.assign });
      if (q.forXml || q.forJson) throw this.syntax(this.tokAfter(this.forPos.get(q).pos));
      this.expectOp(')');
      return q.orderBy || q.offset ? q : q.body;
    }
    if (isKw(t, 'SELECT')) return this.core(ctx);
    throw this.syntax();
  }

  // Core = { type:'core', distinct, top, cols, into, from, where, groupBy, having }
  core(ctx) {
    const sel = this.next();
    let distinct = false;
    if (this.eatKw('DISTINCT')) distinct = true; else this.eatKw('ALL');
    const top = this.kw('TOP') ? this.topClause(true) : null;
    const cols = [];
    do cols.push(this.selectItem(ctx.assign === true)); while (this.eatOp(','));
    let into = null;
    if (this.kw('INTO')) {
      const t = this.peek;
      if (!ctx.into) throw this.syntax(t);
      if (ctx.into.cursor) throw this.syntax(t, true);
      if (!ctx.into.first) throw err(196, t.s, t.e);
      this.i++;
      into = this.intoTarget(true);
    }
    if (ctx.into) ctx.into.first = false;
    const from = this.eatKw('FROM') ? this.fromClause() : null;
    const where = this.eatKw('WHERE') ? this.expr() : null;
    let groupBy = null;
    if (this.kw('GROUP')) {
      this.i++;
      this.expectKw('BY');
      groupBy = this.groupByClause();
    }
    const having = this.eatKw('HAVING') ? this.expr() : null;
    return { type: 'core', distinct, top, cols, into, from, where, groupBy, having, pos: sel.s, end: this.end() };
  }

  topClause(select) {
    const t = this.next();
    let expr;
    if (this.op('(')) {
      this.i++;
      expr = this.expr();
      this.expectOp(')');
    } else if (select && this.peek.t === 'num') {
      const n = this.next();
      expr = this.numLit(n, '', n.s);
    } else throw this.syntax();
    const percent = this.eatKw('PERCENT');
    const top = { expr, percent, pos: t.s, end: 0 };
    if (select) {
      top.ties = false;
      if (this.kw('WITH') && this.kwAt(1, 'TIES')) { this.i += 2; top.ties = true; }
    }
    top.end = this.end();
    const l = numLitOf(expr);
    if (l && percent && (l.v < 0 || l.v > 100)) throw err(1031, expr.pos, expr.end);
    if (l && !percent && !integralLit(l)) throw err(1060, expr.pos, expr.end);
    if (l && !percent && l.v < 0) throw err(127, expr.pos, expr.end);
    return top;
  }

  // SelectItem = { expr, alias } | { star, qualifier? } | { assign:'@var', op, expr }
  selectItem(assignOk) {
    const t = this.peek;
    if (isOp(t, '*')) { this.i++; return { star: true, pos: t.s, end: t.e }; }
    if (this.isIdent(t)) {
      let j = this.i;
      while (this.isIdent(this.t[j]) && isOp(this.t[j + 1], '.')) j += 2;
      if (j > this.i && isOp(this.t[j], '*')) {
        const parts = [];
        while (this.i < j) { parts.push(this.readIdent()); this.i++; }
        this.i++;
        return { star: true, qualifier: parts[parts.length - 1], qualParts: parts, pos: t.s, end: this.end() };
      }
    }
    if (assignOk && t.t === 'var' && !t.v.startsWith('@@')) {
      const o = this.la(1);
      if (o.t === 'op' && ASSIGN_OPS.has(o.v)) {
        this.i += 2;
        this.useVar(t, 'scalar');
        const expr = this.expr();
        return { assign: t.v, op: o.v, expr, pos: t.s, end: this.end() };
      }
    }
    if ((this.isIdent(t) || t.t === 'str') && isOp(this.la(1), '=')) {
      this.i += 2;
      const alias = this.idText(t);
      const expr = this.expr();
      return { expr, alias, pos: t.s, end: this.end() };
    }
    const expr = this.expr();
    let alias = null;
    if (this.eatKw('AS')) {
      const a = this.peek;
      if (!(this.isIdent(a) || a.t === 'str')) throw this.syntax();
      this.i++;
      alias = this.idText(a);
    } else if (this.implicitAlias(true)) {
      alias = this.idText(this.next());
    }
    return { expr, alias, pos: t.s, end: this.end() };
  }

  // An identifier (or, in select lists, a string) right after an expression or table source is its alias; one that
  // a ':' follows is the next statement's label.
  implicitAlias(strOk) {
    const a = this.peek;
    if (isOp(this.la(1), ':')) return false;
    if (a.t === 'qid') return true;
    if (a.t === 'str') return strOk;
    if (a.t !== 'id' || RESERVED.has(a.k)) return false;
    if (a.k === 'THROW') {
      const n = this.la(1);
      if (n.t === 'num' || n.t === 'var' || n.t === 'str' || n.t === 'end' || isOp(n, ';') || isOp(n, '-') || (n.t === 'id' && STMT_START.has(n.k))) return false;
    }
    return true;
  }

  // SELECT … INTO accepts only #temp; OUTPUT … INTO a #temp or a table variable (01 §4.1).
  intoTarget(select) {
    const t = this.peek;
    if (t.t === 'var') {
      if (select || t.v.startsWith('@@')) throw this.syntax(t);
      this.i++;
      this.useVar(t, 'table');
      return { parts: [t.v], pos: t.s, end: t.e };
    }
    if (!this.isIdent(t)) throw this.syntax();
    const name = this.objectName();
    if (name.parts.length !== 1 || !name.parts[0].startsWith('#')) {
      throw mkErr(`INTO can only target #temp tables and table variables. Use INSERT INTO ${name.parts.join('.')} SELECT ... (it has its own preview).`, 0, name.pos, name.end);
    }
    if (select) this.checkTempName(name);
    return name;
  }

  orderList() {
    const items = [];
    do {
      const expr = this.expr();
      let desc = false;
      if (this.eatKw('DESC')) desc = true; else this.eatKw('ASC');
      items.push({ expr, desc, pos: expr.pos, end: this.end() });
    } while (this.eatOp(','));
    return items;
  }

  // ----- GROUP BY (01 §4.2)
  groupByClause() {
    let items = [];
    do items.push(this.groupItem()); while (this.eatOp(','));
    if (this.kw('WITH') && (this.kwAt(1, 'ROLLUP') || this.kwAt(1, 'CUBE'))) {
      this.i++;
      const k = this.next();
      if (items.some(it => it.type === 'rollup' || it.type === 'cube' || it.type === 'sets')) throw this.syntax(k);
      items = [{ type: k.k.toLowerCase(), exprs: items.map(e => [e]), pos: items[0].pos, end: k.e }];
    }
    // The grouping sets of the whole clause are the cross product of its items (at most 4096, SQL Server's limit).
    let sets = 1;
    for (const it of items) {
      sets *= it.type === 'rollup' ? it.exprs.length + 1 : it.type === 'cube' ? 2 ** Math.min(it.exprs.length, 13)
        : it.type === 'sets' ? it.sets.length : 1;
      if (sets > 4096) throw mkErr(MAX_SETS_MSG, 0, items[0].pos, this.end());
    }
    return { items };
  }

  groupItem() {
    const t = this.peek;
    if ((isKw(t, 'ROLLUP') || isKw(t, 'CUBE')) && isOp(this.la(1), '(')) {
      this.i += 2;
      const exprs = this.groupElems();
      this.expectOp(')');
      return { type: t.k.toLowerCase(), exprs, pos: t.s, end: this.end() };
    }
    if (isKw(t, 'GROUPING') && this.kwAt(1, 'SETS')) {
      this.i += 2;
      this.expectOp('(');
      const sets = [];
      do {
        sets.push(...this.groupingSet());
        if (sets.length > 4096) throw mkErr(MAX_SETS_MSG, 0, t.s, this.end());
      } while (this.eatOp(','));
      this.expectOp(')');
      return { type: 'sets', sets, pos: t.s, end: this.end() };
    }
    if (isOp(t, '(') && isOp(this.la(1), ')')) {
      this.i += 2;
      return { type: 'sets', sets: [[]], pos: t.s, end: this.end() };
    }
    return this.expr();
  }

  groupElems() {
    const elems = [];
    do elems.push(this.groupElem()); while (this.eatOp(','));
    return elems;
  }

  // One ROLLUP/CUBE element or GROUPING SETS entry: `(a, b)` is a composite, anything else one expression.
  groupElem() {
    if (this.op('(')) {
      const s = this.save();
      try {
        this.i++;
        const list = [];
        do list.push(this.expr()); while (this.eatOp(','));
        this.expectOp(')');
        if (this.op(',') || this.op(')')) return list;
      } catch (e) {
        if (!(e instanceof SqlError)) throw e;
      }
      this.restore(s);
    }
    return [this.expr()];
  }

  groupingSet() {
    const t = this.peek;
    if (isOp(t, '(') && isOp(this.la(1), ')')) { this.i += 2; return [[]]; }
    if ((isKw(t, 'ROLLUP') || isKw(t, 'CUBE')) && isOp(this.la(1), '(')) {
      this.i += 2;
      const elems = this.groupElems();
      this.expectOp(')');
      const sets = [];
      if (t.k === 'ROLLUP') {
        for (let n = elems.length; n >= 0; n--) sets.push(elems.slice(0, n).flat());
      } else {
        const n = elems.length;
        if (n > 12) throw mkErr(MAX_SETS_MSG, 0, t.s, this.end());
        for (let mask = (1 << n) - 1; mask >= 0; mask--) {
          const set = [];
          for (let b = 0; b < n; b++) if (mask & (1 << (n - 1 - b))) set.push(...elems[b]);
          sets.push(set);
        }
      }
      return sets;
    }
    return [this.groupElem()];
  }

  // ----- OPTION (…) statement hints (01 §4.1 Hints)
  optionClause() {
    const h = emptyHints();
    if (!this.kw('OPTION')) return h;
    this.i++;
    this.expectOp('(');
    do this.hint(h); while (this.eatOp(','));
    this.expectOp(')');
    return h;
  }

  // One OPTION item: USE HINT('…'), or a HINTS name of kind 'option' (or a bare USE HINT name) with its argument.
  // Any other name raises 10715 with did-you-mean; a SQL Server hint SQL Studio does not implement only warns.
  hint(h) {
    const t = this.peek;
    if (t.t !== 'id') throw this.syntax();
    if (t.k === 'USE' && this.kwAt(1, 'HINT')) {
      this.i += 2;
      this.expectOp('(');
      do {
        const s = this.peek;
        if (s.t !== 'str') throw this.syntax();
        this.i++;
        this.useHint(s.v, s, h);
      } while (this.eatOp(','));
      this.expectOp(')');
      return;
    }
    // The item's tokens [a, b), up to ',' or ')' at depth 0.
    const a = this.i;
    let depth = 0;
    for (;;) {
      const x = this.peek;
      if (x.t === 'end') throw this.syntax();
      if (depth === 0 && (isOp(x, ',') || isOp(x, ')'))) break;
      if (isOp(x, '(')) depth++;
      else if (isOp(x, ')')) depth--;
      this.i++;
    }
    const b = this.i;
    const first = this.t[a];
    const last = this.t[b - 1];
    // The longest run of leading words that names an OPTION hint; else one word that is a bare USE HINT name.
    let words = 0;
    while (a + words < b && this.t[a + words].t === 'id') words++;
    let row = null;
    let len = 0;
    for (let k = Math.min(words, 3); k >= 1 && !row; k--) {
      row = hintsBy().option.get(this.t.slice(a, a + k).map(x => x.k).join(' ')) ?? null;
      len = k;
    }
    if (!row) {
      const r = useHintRow(first.k);
      if (r) {
        if (b - a > 1) throw this.syntax(this.t[a + 1]);
        this.applyUseHint(r, first.k, first, h);
        return;
      }
      // The name is the item's leading words as written, and so is the error range (its argument is not part of
      // either), so replacing the range with a suggestion gives a valid item (03 §7).
      const nameEnd = this.t[a + words - 1].e;
      const written = this.src.slice(first.s, nameEnd).replace(/\s+/g, ' ');
      throw this.invalidHint(written, first.s, nameEnd, ['option', 'useHint']);
    }
    const arg = this.hintArg(row.name, a + len, b);
    if (!row.implemented) {
      this.warn(first.s, last.e, `Hint '${this.hintText(a, b)}' is not supported and was ignored.`);
      return;
    }
    if (row.name === 'MAXRECURSION') {
      if (arg.v > 32767) throw err(310, first.s, last.e, arg.raw);
      h.maxrecursion = arg.v;
    } else if (row.name === 'MAXDOP') {
      // 0 = the default parallelism (api.dop, SQL 4 CDS's server-recommended value); at most 32 (02 §8.1).
      if (arg.v === 0) delete h.maxdop;
      else if (arg.v > MAX_MAXDOP) {
        this.warn(first.s, last.e, `MAXDOP ${arg.raw.replace(/^0+(?=\d)/, '')} is above the maximum of ${MAX_MAXDOP}; ${MAX_MAXDOP} is used.`);
        h.maxdop = MAX_MAXDOP;
      } else h.maxdop = arg.v;
    } else if (row.name === 'BATCH_SIZE') {
      this.batchSize(arg.v, h, first.s, last.e);
    } else if (row.name === 'HASH GROUP') {
      h.use.add('HASH GROUP');
    } else this.fetchOption(row.name, h);
  }

  // Checks what follows an OPTION hint's name (tokens [k, b)); returns the number token of an 'int' or 'paren'
  // argument (BATCH_SIZE(n)), else null.
  hintArg(name, k, b) {
    const kind = OPTION_ARGS.get(name) ?? 'none';
    const at = j => (j < b ? this.t[j] : this.t[b]);
    if (kind === 'none') {
      if (k < b) throw this.syntax(at(k));
      return null;
    }
    if (kind === 'int') {
      if (!isIntTok(at(k)) || k >= b) throw this.syntax(at(k));
      if (k + 1 < b) throw this.syntax(at(k + 1));
      return this.t[k];
    }
    if (kind === 'eq') {
      if (!isOp(at(k), '=') || k >= b) throw this.syntax(at(k));
      const n = at(k + 1);
      if (k + 1 >= b || n.t !== 'num' || n.bin) throw this.syntax(n);
      if (k + 2 < b) throw this.syntax(at(k + 2));
      return null;
    }
    if (kind === 'str') {
      if (k >= b || at(k).t !== 'str') throw this.syntax(at(k));
      if (k + 1 < b) throw this.syntax(at(k + 1));
      return null;
    }
    // 'paren': one parenthesised group; BATCH_SIZE takes exactly one integer in it.
    if (k >= b || !isOp(at(k), '(')) throw this.syntax(at(k));
    const close = this.closeOf(k);
    if (close + 1 < b) throw this.syntax(at(close + 1));
    if (name !== 'BATCH_SIZE') return null;
    if (!isIntTok(at(k + 1))) throw this.syntax(at(k + 1));
    if (k + 2 !== close) throw this.syntax(at(k + 2));
    return this.t[k + 1];
  }

  // The text of an OPTION item for the 'not supported' warning: words in upper case, punctuation as written.
  hintText(a, b) {
    const words = this.t.slice(a, b).map(x => (x.t === 'id' ? x.k : x.t === 'str' ? `'${x.v}'` : x.t === 'qid' ? `[${x.v}]` : this.src.slice(x.s, x.e)));
    return words.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/ ,/g, ',');
  }

  // A name inside USE HINT('…'): a HINTS name of kind 'useHint' (BATCH_SIZE_n and FETCHXML_PAGE_SIZE_n with a
  // number), else 10715 with did-you-mean.
  useHint(text, tok, h) {
    const name = text.trim().toUpperCase();
    const row = useHintRow(name);
    if (!row) {
      const [pos, end] = this.stringNameSpan(tok);
      throw this.invalidHint(text, pos, end, ['useHint']);
    }
    this.applyUseHint(row, name, tok, h);
  }

  // The source range of the name inside a string token: without the N prefix, the quotes and the white space around
  // the name, so replacing it with a did-you-mean suggestion gives a valid USE HINT (03 §7). A string of white space
  // only gives its whole content.
  stringNameSpan(tok) {
    const c = this.src.charCodeAt(tok.s);
    const from = tok.s + (c === 78 || c === 110 ? 2 : 1);
    const to = tok.open ? tok.e : tok.e - 1;
    const raw = this.src.slice(from, to);
    const name = raw.trim();
    if (!name) return [from, to];
    const pos = from + (raw.length - raw.trimStart().length);
    return [pos, pos + name.length];
  }

  // The effect of a USE HINT name (written in USE HINT or bare).
  applyUseHint(row, name, tok, h) {
    if (!row.implemented) {
      this.warn(tok.s, tok.e, `Hint '${name}' is not supported and was ignored.`);
      return;
    }
    if (row.name === 'BATCH_SIZE_n') {
      this.batchSize(Number(name.slice('BATCH_SIZE_'.length)), h, tok.s, tok.e);
      return;
    }
    if (row.name === 'FETCHXML_PAGE_SIZE_n') {
      const n = Number(name.slice('FETCHXML_PAGE_SIZE_'.length));
      if (n < 1 || n > 5000) throw mkErr('The FETCHXML_PAGE_SIZE hint must be between 1 and 5000.', 0, tok.s, tok.e);
      h.pageSize = n;
      return;
    }
    h.use.add(name);
    this.fetchOption(name, h);
  }

  // Adds the FetchXML option of a hint, once, in statement order.
  fetchOption(name, h) {
    const fo = FETCH_OPTIONS.get(name);
    if (fo && !h.fetchOptions.includes(fo)) h.fetchOptions.push(fo);
  }

  // 10715 `'<name>' is not a valid hint.` with did-you-mean over the HINTS names of these kinds.
  invalidHint(written, pos, end, kinds) {
    const e = err(10715, pos, end, written);
    const s = suggest(written.trim().toUpperCase(), hintCandidates(kinds, written.trim().toUpperCase()));
    if (s.length) e.suggestions = s;
    return e;
  }

  batchSize(n, h, pos, end) {
    if (n < 1 || n > 1000) throw mkErr('The BATCH_SIZE hint must be between 1 and 1000.', 0, pos, end);
    h.batchSize = n;
  }

  // ----- FROM (01 §4.3)
  fromClause() {
    let left = this.joinChain();
    while (this.op(',')) {
      this.i++;
      const right = this.joinChain();
      left = { type: 'join', kind: 'cross', left, right, on: null, comma: true, pos: left.pos, end: this.end() };
    }
    return left;
  }

  // INNER/LEFT/RIGHT/FULL [OUTER] JOIN or JOIN: the join kind, else null (nothing consumed).
  joinKind() {
    const t = this.peek;
    if (isKw(t, 'JOIN')) { this.i++; return 'inner'; }
    if (isKw(t, 'INNER')) { this.i++; this.expectKw('JOIN'); return 'inner'; }
    const kind = isKw(t, 'LEFT') ? 'left' : isKw(t, 'RIGHT') ? 'right' : isKw(t, 'FULL') ? 'full' : null;
    if (!kind) return null;
    this.i++;
    this.eatKw('OUTER');
    this.expectKw('JOIN');
    return kind;
  }

  joinChain() {
    let left = this.tablePrimary();
    for (;;) {
      const t = this.peek;
      if (isKw(t, 'PIVOT')) { left = this.pivot(left); continue; }
      if (isKw(t, 'UNPIVOT')) { left = this.unpivot(left); continue; }
      if (isKw(t, 'CROSS')) {
        const n = this.la(1);
        if (isKw(n, 'JOIN')) {
          this.i += 2;
          const right = this.tablePrimary();
          left = { type: 'join', kind: 'cross', left, right, on: null, pos: left.pos, end: this.end() };
          continue;
        }
        if (isKw(n, 'APPLY')) {
          this.i += 2;
          const right = this.tablePrimary();
          left = { type: 'join', kind: 'cross apply', left, right, on: null, pos: left.pos, end: this.end() };
          continue;
        }
        throw this.syntax(n);
      }
      if (isKw(t, 'OUTER') && this.kwAt(1, 'APPLY')) {
        this.i += 2;
        const right = this.tablePrimary();
        left = { type: 'join', kind: 'outer apply', left, right, on: null, pos: left.pos, end: this.end() };
        continue;
      }
      const kind = this.joinKind();
      if (!kind) return left;
      const right = this.joinRight();
      this.expectKw('ON');
      const on = this.expr();
      left = { type: 'join', kind, left, right, on, pos: left.pos, end: this.end() };
    }
  }

  // The right side of a qualified join: nested joins (`a JOIN b JOIN c ON … ON …`) close with their own ON first.
  joinRight() {
    let r = this.tablePrimary();
    for (;;) {
      const kind = this.joinKind();
      if (!kind) return r;
      const rr = this.joinRight();
      this.expectKw('ON');
      const on = this.expr();
      r = { type: 'join', kind, left: r, right: rr, on, pos: r.pos, end: this.end() };
    }
  }

  tablePrimary() {
    this.enter();
    try {
      const t = this.peek;
      if (this.nodesAhead(this.i)) return this.xmlNodesSource();
      if (isOp(t, '(')) return this.parenSource();
      if (t.t === 'var') {
        if (t.v.startsWith('@@')) throw this.syntax();
        this.i++;
        this.useVar(t, 'table');
        const name = { parts: [t.v], pos: t.s, end: t.e };
        return this.tableRest(name, t, this.op('(') && this.oldHintFollows() ? this.tableHintList() : null);
      }
      if (isKw(t, 'OPENROWSET')) throw mkErr(OPENROWSET_MSG, 0, t.s, t.e);
      if (!this.isIdent(t)) throw this.syntax();
      const name = this.objectName();
      // A built-in TVF always takes arguments; another name followed by a list of table-hint keywords has hints.
      if (this.op('(') && (builtinTvf(name) || !this.oldHintFollows())) return this.tvf(name);
      return this.tableRest(name, t, this.op('(') ? this.tableHintList() : null);
    } finally {
      this.depth--;
    }
  }

  // True when a table source starting at token j is an xml nodes() call: a variable, column, CAST/CONVERT call or
  // parenthesised expression followed by a chain of xml methods that ends with .nodes(…) (01 §4.3).
  nodesAhead(j) {
    const t = this.t[j];
    let k;
    if (t.t === 'var') k = j + 1;
    else if (isOp(t, '(')) k = this.closeOf(j) + 1;
    else if (t.t === 'id' && CAST_FNS.has(t.k) && isOp(this.t[j + 1], '(')) k = this.closeOf(j + 1) + 1;
    else if (this.isIdent(t)) {
      k = j + 1;
      while (isOp(this.t[k], '.') && this.isIdent(this.t[k + 1]) && !this.methodAt(k)) k += 2;
    } else return false;
    if (k <= 0) return false;
    while (this.methodAt(k)) {
      if (lower(this.t[k + 1].v) === 'nodes') return true;
      const close = this.closeOf(k + 2);
      if (close < 0) return false;
      k = close + 1;
    }
    return false;
  }

  // x.nodes('path') [AS] t(c) as a table source: {type: 'xmlnodes', e, alias, columns: [c]} (01 §4.3).
  xmlNodesSource() {
    const start = this.peek;
    const e = this.postfix(this.primary(), true);
    if (e.type !== 'xmlmethod' || e.method !== 'nodes' || this.op('.')) throw this.syntax();
    const alias = this.tableAlias();
    if (alias === null || !this.op('(')) throw mkErr(NODES_ALIAS_MSG, 0, e.pos, this.end());
    const open = this.peek;
    const columns = this.parenIdentList();
    if (columns.length !== 1) throw mkErr(NODES_ALIAS_MSG, 0, open.s, this.end());
    return { type: 'xmlnodes', e, alias, columns, pos: start.s, end: this.end() };
  }

  // The rest of a table or table-variable source after its name (and a legacy hint list right after it): the alias,
  // then `WITH (hints)` or the legacy `(hints)` after the alias (01 §4.3).
  tableRest(name, first, hints) {
    const alias = this.tableAlias();
    if (this.kw('WITH') && isOp(this.la(1), '(')) {
      this.i++;
      hints = this.tableHintList();
    } else if (!hints && this.op('(') && this.oldHintFollows()) hints = this.tableHintList();
    return { type: 'table', name, alias, hints, pos: first.s, end: this.end() };
  }

  // True when the '(' at the current token opens a legacy table-hint list (`t (NOLOCK)`, 01 §4.3): every
  // comma-separated item up to its ')' is one table-hint keyword, INDEX (…) or INDEX = name|(…). Anything else makes
  // the parentheses TVF arguments (or, after an alias, a syntax error).
  oldHintFollows() {
    const close = this.closeOf(this.i);
    if (close < 0) return false;
    let j = this.i + 1;
    for (;;) {
      const h = this.t[j];
      if (h.t !== 'id' || !TABLE_HINT_WORDS.has(h.k)) return false;
      j++;
      if (h.k === 'INDEX') {
        const eq = isOp(this.t[j], '=');
        if (eq) j++;
        if (isOp(this.t[j], '(')) j = this.closeOf(j) + 1;
        else if (eq && (this.isIdent(this.t[j]) || isIntTok(this.t[j]))) j++;
        else if (eq) return false;
        if (j <= 0 || j > close) return false;
      }
      if (j === close) return true;
      if (!isOp(this.t[j], ',')) return false;
      j++;
    }
  }

  // ( hint [, hint]… ): only the HINTS table hints (NOLOCK) are allowed, with did-you-mean (01 §4.3).
  tableHintList() {
    this.expectOp('(');
    const hints = [];
    do {
      const h = this.peek;
      if (h.t !== 'id') throw this.syntax();
      if (!hintsBy().table.has(h.k)) {
        const e = mkErr(`Table hint '${h.k}' is not supported.`, 0, h.s, h.e);
        const s = suggest(h.k, hintCandidates(['table'], h.k));
        if (s.length) e.suggestions = s;
        throw e;
      }
      this.i++;
      if (!hints.includes(h.k)) hints.push(h.k);
    } while (this.eatOp(','));
    this.expectOp(')');
    return hints;
  }

  tableAlias() {
    if (this.eatKw('AS')) {
      const a = this.peek;
      if (!this.isIdent(a)) throw this.syntax();
      this.i++;
      return this.idText(a);
    }
    if (this.implicitAlias(false)) return this.idText(this.next());
    return null;
  }

  requiredAlias() {
    const alias = this.tableAlias();
    if (alias === null) throw this.syntax();
    return alias;
  }

  tvf(name) {
    this.i++;
    const args = [];
    if (!this.op(')')) {
      do args.push(this.expr()); while (this.eatOp(','));
    }
    this.expectOp(')');
    let withSchema = null;
    if (name.parts.length === 1 && name.parts[0].toUpperCase() === 'OPENJSON' && this.kw('WITH') && isOp(this.la(1), '(')) {
      this.i += 2;
      withSchema = this.openJsonSchema();
    }
    const alias = this.tableAlias();
    const columns = alias !== null && this.op('(') ? this.parenIdentList() : null;
    return { type: 'tvf', name, args, alias, columns, withSchema, pos: name.pos, end: this.end() };
  }

  openJsonSchema() {
    const cols = [];
    do {
      const name = this.readIdent();
      const dataType = this.dataType();
      let path = null;
      if (this.peek.t === 'str') path = this.next().v;
      let asJson = false;
      if (this.kw('AS')) {
        const a = this.next();
        this.expectKw('JSON');
        if (!(dataType.name === 'nvarchar' && dataType.args[0] === 'max')) throw err(13618, a.s, this.end());
        asJson = true;
      }
      cols.push({ name, dataType, path, asJson });
    } while (this.eatOp(','));
    this.expectOp(')');
    return cols;
  }

  parenSource() {
    const open = this.peek;
    const n = this.la(1);
    if (isKw(n, 'VALUES')) return this.valuesSource();
    if (isKw(n, 'SELECT')) return this.derived();
    if (isOp(n, '(')) {
      const s = this.save();
      let e1;
      try { return this.derived(); } catch (e) { if (!(e instanceof SqlError)) throw e; e1 = e; }
      this.restore(s);
      try { return this.parenJoin(open); } catch (e) { if (!(e instanceof SqlError)) throw e; throw furthest(e1, e); }
    }
    return this.parenJoin(open);
  }

  parenJoin(open) {
    this.i++;
    const j = this.joinChain();
    this.expectOp(')');
    return j;
  }

  derived() {
    const open = this.next();
    const query = this.queryExpr({ nested: true });
    this.expectOp(')');
    const alias = this.requiredAlias();
    const columns = this.op('(') ? this.parenIdentList() : null;
    return { type: 'derived', query, alias, columns, pos: open.s, end: this.end() };
  }

  valuesSource() {
    const open = this.next();
    this.i++;
    const rows = this.valuesRows(false);
    this.expectOp(')');
    const alias = this.requiredAlias();
    const columns = this.op('(') ? this.parenIdentList() : null;
    return { type: 'values', rows, alias, columns, pos: open.s, end: this.end() };
  }

  valuesRows(defaultOk) {
    const rows = [];
    do {
      const rt = this.expectOp('(');
      const row = [];
      do row.push(defaultOk && this.kw('DEFAULT') ? this.defaultNode() : this.expr()); while (this.eatOp(','));
      this.expectOp(')');
      if (rows.length && row.length !== rows[0].length) throw err(10709, rt.s, this.end());
      rows.push(row);
    } while (this.eatOp(','));
    return rows;
  }

  colRef() {
    const t = this.peek;
    const dq = [];
    const parts = [this.readPart(dq, 0)];
    while (this.op('.')) {
      if (parts.length === 4) throw this.syntax();
      this.i++;
      parts.push(this.readPart(dq, parts.length));
    }
    return this.withDq({ type: 'col', parts, pos: t.s, end: this.end() }, dq);
  }

  // source PIVOT (agg(col) FOR forCol IN ([v1], [v2], …)) [AS] alias (01 §4.3)
  pivot(source) {
    this.next();
    this.expectOp('(');
    const f = this.peek;
    if (!(f.t === 'id' && !RESERVED.has(f.k))) throw this.syntax();
    this.i++;
    this.expectOp('(');
    if (!this.isIdent(this.peek)) throw this.syntax();
    const col = this.colRef();
    this.expectOp(')');
    const agg = { type: 'fn', name: f.k, schema: null, args: [col], pos: f.s, end: this.end() };
    this.expectKw('FOR');
    const forCol = this.colRef();
    this.expectKw('IN');
    this.expectOp('(');
    const values = [];
    do {
      const v = this.peek;
      if (!this.isIdent(v)) throw this.syntax();
      this.i++;
      const s = this.idText(v);
      values.push({ v: s, name: s });
    } while (this.eatOp(','));
    this.expectOp(')');
    this.expectOp(')');
    const alias = this.requiredAlias();
    return { type: 'pivot', source, agg, forCol, values, alias, pos: source.pos, end: this.end() };
  }

  // source UNPIVOT (valueCol FOR forCol IN (c1, c2, …)) [AS] alias
  unpivot(source) {
    this.next();
    this.expectOp('(');
    const valueCol = this.readIdent();
    this.expectKw('FOR');
    const forCol = this.readIdent();
    this.expectKw('IN');
    const cols = this.parenIdentList();
    this.expectOp(')');
    const alias = this.requiredAlias();
    return { type: 'unpivot', source, valueCol, forCol, cols, alias, pos: source.pos, end: this.end() };
  }

  // ----- INSERT / UPDATE / DELETE (01 §4.1, 02 §8.1)
  dmlTarget() {
    const t = this.peek;
    if (t.t === 'var') {
      if (t.v.startsWith('@@')) throw this.syntax();
      this.i++;
      this.useVar(t, 'table');
      return { parts: [t.v], pos: t.s, end: t.e };
    }
    if (!this.isIdent(t)) throw this.syntax();
    return this.objectName();
  }

  dupColumn(name, t) {
    return err(264, t.s, t.e, name);
  }

  insertStmt(ctes, startTok, xmlns = null) {
    this.next();
    this.eatKw('INTO');
    const target = this.dmlTarget();
    let cols = null;
    if (this.op('(') && !(this.kwAt(1, 'SELECT') || isOp(this.la(1), '('))) {
      this.i++;
      cols = [];
      const seen = new Set();
      do {
        const c = this.peek;
        const name = this.readIdent();
        if (seen.has(lower(name))) throw this.dupColumn(name, c);
        seen.add(lower(name));
        cols.push({ name, pos: c.s, end: c.e });
      } while (this.eatOp(','));
      this.expectOp(')');
    }
    const output = this.kw('OUTPUT') ? this.outputClause() : null;
    let values = null;
    let query = null;
    let defaultValues = false;
    const t = this.peek;
    if (isKw(t, 'VALUES')) {
      this.i++;
      values = this.valuesRows(true);
      if (cols) {
        for (const row of values) {
          if (row.length < cols.length) throw err(109, t.s, this.end());
          if (row.length > cols.length) throw err(110, t.s, this.end());
        }
      }
    } else if (isKw(t, 'DEFAULT') && this.kwAt(1, 'VALUES') && !cols) {
      this.i += 2;
      values = [[]];
      defaultValues = true;
    } else if (isKw(t, 'SELECT') || isOp(t, '(')) {
      query = this.queryExpr({ nested: false, with: ctes, xmlns });
      if (query.forXml) { const p = this.forPos.get(query); throw err(6819, p.pos, p.end, 'INSERT'); }
    } else if (isKw(t, 'EXEC') || isKw(t, 'EXECUTE')) {
      throw mkErr('INSERT ... EXEC is not supported. Use INSERT INTO ... SELECT * FROM <function>(...) instead.', 0, t.s, t.e);
    } else throw this.syntax();
    const hints = this.optionClause();
    const st = { type: 'insert', with: ctes ?? null, xmlns, target, cols, values, query, output, hints, pos: startTok.s, end: this.end() };
    if (defaultValues) st.defaultValues = true;
    return st;
  }

  updateStmt(ctes, startTok, xmlns = null) {
    this.next();
    const top = this.kw('TOP') ? this.topClause(false) : null;
    const target = this.dmlTarget();
    this.expectKw('SET');
    const sets = [];
    const seen = new Set();
    do {
      const t = this.peek;
      if (t.t === 'var') {
        if (t.v.startsWith('@@')) throw this.syntax();
        if (this.methodAt(this.i + 1)) this.xmlDmlStatement(this.i + 1);
        this.i++;
        this.useVar(t, 'scalar');
        const o = this.peek;
        if (o.t !== 'op' || !ASSIGN_OPS.has(o.v)) throw this.syntax();
        this.i++;
        if (o.v === '=') {
          // T-SQL `SET @v = column = expression` / `@v = column += expression`: refused, never `@v = (column = …)`.
          let j = this.i;
          while (this.isIdent(this.t[j]) && isOp(this.t[j + 1], '.')) j += 2;
          const a = this.t[j + 1];
          if (this.isIdent(this.t[j]) && a && a.t === 'op' && ASSIGN_OPS.has(a.v)) throw mkErr(SET_VAR_COL_MSG, 0, t.s, a.e);
        }
        const expr = this.expr();
        sets.push({ variable: t.v, op: o.v, expr, pos: t.s, end: this.end() });
        continue;
      }
      if (!this.isIdent(t)) throw this.syntax();
      let j = this.i + 1;
      while (isOp(this.t[j], '.') && this.isIdent(this.t[j + 1]) && !this.methodAt(j)) j += 2;
      if (this.methodAt(j)) this.xmlDmlStatement(j);
      const col = this.objectName();
      const key = lower(col.parts[col.parts.length - 1]);
      if (seen.has(key)) throw this.dupColumn(col.parts[col.parts.length - 1], t);
      seen.add(key);
      const o = this.peek;
      if (o.t !== 'op' || !ASSIGN_OPS.has(o.v)) throw this.syntax();
      this.i++;
      const expr = o.v === '=' && this.kw('DEFAULT') ? this.defaultNode() : this.expr();
      sets.push({ col, op: o.v, expr, pos: t.s, end: this.end() });
    } while (this.eatOp(','));
    const output = this.kw('OUTPUT') ? this.outputClause() : null;
    const from = this.eatKw('FROM') ? this.fromClause() : null;
    const where = this.whereClause();
    const hints = this.optionClause();
    return { type: 'update', with: ctes ?? null, xmlns, top, target, sets, output, from, where, hints, pos: startTok.s, end: this.end() };
  }

  // WHERE condition; WHERE CURRENT OF [GLOBAL] cursor (a positioned write) is refused (01 §4.1 Cursors).
  whereClause() {
    if (!this.kw('WHERE')) return null;
    this.i++;
    if (this.kw('CURRENT') && this.kwAt(1, 'OF')) {
      const c = this.peek;
      this.i += 2;
      if (this.kw('GLOBAL') && this.isIdent(this.la(1))) this.i++;
      if (this.isIdent(this.peek) || this.peek.t === 'var') this.i++;
      throw mkErr(CURRENT_OF_MSG, 0, c.s, this.end());
    }
    return this.expr();
  }

  deleteStmt(ctes, startTok, xmlns = null) {
    this.next();
    const top = this.kw('TOP') ? this.topClause(false) : null;
    this.eatKw('FROM');
    const target = this.dmlTarget();
    const output = this.kw('OUTPUT') ? this.outputClause() : null;
    const from = this.eatKw('FROM') ? this.fromClause() : null;
    const where = this.whereClause();
    const hints = this.optionClause();
    return { type: 'delete', with: ctes ?? null, xmlns, top, target, output, from, where, hints, pos: startTok.s, end: this.end() };
  }

  outputClause() {
    const t = this.next();
    const cols = [];
    do cols.push(this.selectItem(false)); while (this.eatOp(','));
    let into = null;
    let intoCols = null;
    if (this.eatKw('INTO')) {
      into = this.intoTarget(false);
      if (this.op('(')) intoCols = this.parenIdentList();
    }
    return { cols, into, intoCols, pos: t.s, end: this.end() };
  }

  // ----- expressions (01 §4.4): OR < AND < NOT < predicates < + - & | ^ < * / % < unary < postfix < primary
  expr() {
    this.enter();
    try { return this.orExpr(); } finally { this.depth--; }
  }

  orExpr() {
    let l = this.andExpr();
    while (this.kw('OR')) {
      this.i++;
      const r = this.andExpr();
      l = { type: 'bin', op: 'OR', l, r, pos: l.pos, end: this.end() };
    }
    return l;
  }

  andExpr() {
    let l = this.notExpr();
    while (this.kw('AND')) {
      this.i++;
      const r = this.notExpr();
      l = { type: 'bin', op: 'AND', l, r, pos: l.pos, end: this.end() };
    }
    return l;
  }

  notExpr() {
    if (!this.kw('NOT')) return this.predicate();
    const t = this.next();
    this.enter();
    try {
      const e = this.notExpr();
      return { type: 'not', e, pos: t.s, end: this.end() };
    } finally {
      this.depth--;
    }
  }

  predicate() {
    const t = this.peek;
    if (isKw(t, 'EXISTS')) {
      this.i++;
      this.expectOp('(');
      const query = this.queryExpr({ nested: true });
      this.expectOp(')');
      return { type: 'exists', query, pos: t.s, end: this.end() };
    }
    return this.predicateTail(this.additive());
  }

  // Comparisons and predicates do not chain: `a = b = c` is a syntax error, as in SQL Server.
  noChain(node) {
    const t = this.peek;
    if ((t.t === 'op' && CMP.has(t.v)) || isKw(t, 'IS') || isKw(t, 'BETWEEN') || isKw(t, 'LIKE') || isKw(t, 'IN') ||
      (isKw(t, 'NOT') && (this.kwAt(1, 'IN') || this.kwAt(1, 'LIKE') || this.kwAt(1, 'BETWEEN')))) throw this.syntax(t);
    return node;
  }

  predicateTail(l) {
    const t = this.peek;
    if (t.t === 'op' && CMP.has(t.v)) {
      this.i++;
      const op = CMP.get(t.v);
      const q = this.peek;
      if ((isKw(q, 'ANY') || isKw(q, 'SOME') || isKw(q, 'ALL')) && isOp(this.la(1), '(')) {
        this.i += 2;
        const query = this.queryExpr({ nested: true });
        this.expectOp(')');
        return this.noChain({ type: 'quantified', op, quant: q.k === 'ALL' ? 'ALL' : 'ANY', l, query, pos: l.pos, end: this.end() });
      }
      const r = this.additive();
      return this.noChain({ type: 'bin', op, l, r, pos: l.pos, end: this.end() });
    }
    if (isKw(t, 'IS')) {
      this.i++;
      const not = this.eatKw('NOT');
      if (this.eatKw('NULL')) return this.noChain({ type: 'isnull', e: l, not, pos: l.pos, end: this.end() });
      if (this.eatKw('DISTINCT')) {
        this.expectKw('FROM');
        const r = this.additive();
        return this.noChain({ type: 'distinctfrom', l, r, not, pos: l.pos, end: this.end() });
      }
      throw this.syntax();
    }
    let not = false;
    if (isKw(t, 'NOT') && (this.kwAt(1, 'IN') || this.kwAt(1, 'LIKE') || this.kwAt(1, 'BETWEEN'))) { this.i++; not = true; }
    const k = this.peek;
    if (isKw(k, 'BETWEEN')) {
      this.i++;
      const lo = this.additive();
      this.expectKw('AND');
      const hi = this.additive();
      return this.noChain({ type: 'between', e: l, lo, hi, not, pos: l.pos, end: this.end() });
    }
    if (isKw(k, 'LIKE')) {
      this.i++;
      const pattern = this.additive();
      const escape = this.eatKw('ESCAPE') ? this.additive() : null;
      return this.noChain({ type: 'like', e: l, pattern, escape, not, pos: l.pos, end: this.end() });
    }
    if (isKw(k, 'IN')) {
      this.i++;
      this.expectOp('(');
      if (this.kw('SELECT')) {
        const query = this.queryExpr({ nested: true });
        this.expectOp(')');
        return this.noChain({ type: 'in', e: l, query, not, pos: l.pos, end: this.end() });
      }
      const s = this.save();
      let e1 = null;
      try {
        const list = [];
        do list.push(this.expr()); while (this.eatOp(','));
        this.expectOp(')');
        return this.noChain({ type: 'in', e: l, list, not, pos: l.pos, end: this.end() });
      } catch (e) {
        if (!(e instanceof SqlError) || !isOp(this.t[s.i], '(')) throw e;
        e1 = e;
      }
      this.restore(s);
      try {
        const query = this.queryExpr({ nested: true });
        this.expectOp(')');
        return this.noChain({ type: 'in', e: l, query, not, pos: l.pos, end: this.end() });
      } catch (e) {
        if (!(e instanceof SqlError)) throw e;
        throw furthest(e1, e);
      }
    }
    if (not) throw this.syntax();
    return l;
  }

  additive() {
    let l = this.multiplicative();
    for (;;) {
      const t = this.peek;
      if (t.t !== 'op' || !(t.v === '+' || t.v === '-' || t.v === '&' || t.v === '|' || t.v === '^')) return l;
      this.i++;
      const r = this.multiplicative();
      l = { type: 'bin', op: t.v, l, r, pos: l.pos, end: this.end() };
    }
  }

  multiplicative() {
    let l = this.unary();
    for (;;) {
      const t = this.peek;
      if (t.t !== 'op' || !(t.v === '*' || t.v === '/' || t.v === '%')) return l;
      this.i++;
      const r = this.unary();
      l = { type: 'bin', op: t.v, l, r, pos: l.pos, end: this.end() };
    }
  }

  unary() {
    const t = this.peek;
    if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '~')) {
      this.i++;
      const n = this.peek;
      if (t.v !== '~' && n.t === 'num' && !n.bin) {
        this.i++;
        return this.postfix(this.numLit(n, t.v === '-' ? '-' : '', t.s));
      }
      this.enter();
      try {
        const e = this.unary();
        return t.v === '+' ? e : { type: 'neg', op: t.v, e, pos: t.s, end: this.end() };
      } finally {
        this.depth--;
      }
    }
    return this.postfix(this.primary());
  }

  // COLLATE name, AT TIME ZONE zone and the xml methods .value(…), .query(…), .exist(…), .nodes(…) and .modify(…):
  // postfix, tighter than every binary operator, left to right (01 §4.4). nodes() only ends a table source
  // (nodesOk, 01 §4.3); elsewhere it raises NODES_MSG.
  postfix(e, nodesOk = false) {
    for (;;) {
      if (this.kw('COLLATE')) {
        this.i++;
        const n = this.peek;
        if (!(n.t === 'id' || n.t === 'qid')) throw this.syntax();
        this.i++;
        e = { type: 'collate', e, name: n.v, pos: e.pos, end: this.end() };
        continue;
      }
      if (this.kw('AT') && this.kwAt(1, 'TIME') && this.kwAt(2, 'ZONE')) {
        this.i += 3;
        const z = this.primary();
        e = { type: 'fn', name: 'AT_TIME_ZONE', schema: null, args: [e, z], postfix: true, pos: e.pos, end: this.end() };
        continue;
      }
      if (this.methodAt(this.i) && XML_BASES.has(e.type)) {
        e = this.xmlMethod(e, nodesOk);
        if (e.method === 'nodes') return e;
        continue;
      }
      return e;
    }
  }

  // operand.method(args): an `xmlmethod` node. Its arguments are string literals (8172) and their number is the
  // method's (174), both checked here because they are syntactic (01 §8.3).
  xmlMethod(e, nodesOk) {
    this.i++;
    const m = this.next();
    const method = lower(m.v);
    if (method === 'nodes' && !nodesOk) throw mkErr(NODES_MSG, 0, m.s, m.e);
    this.expectOp('(');
    const args = [];
    if (!this.op(')')) {
      do args.push(this.expr()); while (this.eatOp(','));
    }
    this.expectOp(')');
    const want = XML_METHODS.get(method);
    if (args.length !== want) throw err(174, m.s, this.end(), method, want);
    args.forEach((a, k) => {
      if (!(a.type === 'lit' && a.dt === 'string')) throw err(8172, a.pos, a.end, k + 1, method);
    });
    return { type: 'xmlmethod', e, method, args, pos: e.pos, end: this.end() };
  }

  // A literal. 0x… is binary: `v` holds the lower-case hex digits, padded to whole bytes with a leading 0.
  numLit(t, sign, pos) {
    let raw = t.raw;
    let v = t.v;
    let dt;
    if (t.bin) return { type: 'lit', v: v.length % 2 ? '0' + v : v, dt: 'binary', raw, pos, end: t.e };
    if (t.float) {
      if (!Number.isFinite(v)) throw err(168, t.s, t.e, raw);
      dt = 'float';
    } else {
      const [ip, fp = ''] = raw.split('.');
      const digits = ip.replace(/^0+/, '').length + fp.length;
      if (digits > 38) throw err(1007, pos, t.e, raw.length > 128 ? raw.slice(0, 128) : raw);
      dt = t.int && (sign === '-' ? -v >= INT_MIN : v <= INT_MAX) ? 'int' : 'decimal';
    }
    if (sign === '-') {
      v = v === 0 ? 0 : -v;
      raw = '-' + raw;
    }
    return { type: 'lit', v, dt, raw, pos, end: t.e };
  }

  strLit(t) {
    const c = this.src[t.s];
    return { type: 'lit', v: t.v, dt: 'string', unicode: c === 'N' || c === 'n', pos: t.s, end: t.e };
  }

  varRef(t) {
    this.useVar(t, 'scalar');
    return { type: 'var', name: t.v, pos: t.s, end: t.e };
  }

  primary() {
    const t = this.peek;
    if (t.t === 'num') { this.i++; return this.numLit(t, '', t.s); }
    if (t.t === 'str') { this.i++; return this.strLit(t); }
    if (t.t === 'var') { this.i++; return this.varRef(t); }
    if (t.t === 'qid') return this.nameExpr();
    if (isOp(t, '(')) return this.parenExpr();
    if (t.t !== 'id') throw this.syntax();
    const k = t.k;
    if (k === 'NULL') { this.i++; return { type: 'lit', v: null, dt: 'null', pos: t.s, end: t.e }; }
    if (k === 'CASE') return this.caseExpr();
    if (k === 'CURRENT_TIMESTAMP') { this.i++; return { type: 'fn', name: 'GETDATE', schema: null, args: [], pos: t.s, end: t.e }; }
    if (USER_FNS.has(k)) {
      // CURRENT_USER is also callable with an empty argument list (01 §3); the other three take no parentheses.
      if (isOp(this.la(1), '(')) {
        if (k !== 'CURRENT_USER') throw this.syntax(this.la(1));
        if (!isOp(this.la(2), ')')) throw this.syntax(this.la(2), true);
        this.i += 3;
        return { type: 'fn', name: 'CURRENT_USER', schema: null, args: [], pos: t.s, end: this.end() };
      }
      this.i++;
      return { type: 'fn', name: 'CURRENT_USER', schema: null, args: [], pos: t.s, end: t.e };
    }
    if (k === 'NEXT' && this.kwAt(1, 'VALUE') && this.kwAt(2, 'FOR')) throw mkErr('NEXT VALUE FOR is not supported: Dataverse has no sequences.', 0, t.s, this.la(2).e);
    if (RESERVED.has(k) && !(CALLABLE.has(k) && isOp(this.la(1), '('))) throw this.syntax();
    return this.nameExpr();
  }

  // col (a, a.b, …, up to 4 parts) or a function call (name(…) or schema.name(…)).
  nameExpr() {
    const first = this.peek;
    if (first.t === 'id' && RESERVED.has(first.k)) {
      this.i++;
      return this.call(first.v, null, first.s);
    }
    const dq = [];
    const parts = [this.readPart(dq, 0)];
    while (this.op('.') && !this.methodAt(this.i)) {
      if (!this.isIdent(this.la(1)) || parts.length === 4) throw this.syntax(this.la(1));
      this.i++;
      parts.push(this.readPart(dq, parts.length));
    }
    if (this.op('(')) {
      if (parts.length > 2) throw this.syntax();
      return this.call(parts[parts.length - 1], parts.length === 2 ? parts[0] : null, first.s);
    }
    return this.withDq({ type: 'col', parts, pos: first.s, end: this.end() }, dq);
  }

  parenExpr() {
    const open = this.peek;
    const n = this.la(1);
    if (isKw(n, 'SELECT')) {
      this.i++;
      const query = this.queryExpr({ nested: true });
      this.expectOp(')');
      return { type: 'subq', query, pos: open.s, end: this.end() };
    }
    if (isOp(n, '(')) {
      const s = this.save();
      let e1;
      try {
        this.i++;
        const e = this.expr();
        this.expectOp(')');
        return { type: 'paren', e, pos: open.s, end: this.end() };
      } catch (e) {
        if (!(e instanceof SqlError)) throw e;
        e1 = e;
      }
      this.restore(s);
      try {
        this.i++;
        const query = this.queryExpr({ nested: true });
        this.expectOp(')');
        return { type: 'subq', query, pos: open.s, end: this.end() };
      } catch (e) {
        if (!(e instanceof SqlError)) throw e;
        throw furthest(e1, e);
      }
    }
    this.i++;
    const e = this.expr();
    this.expectOp(')');
    return { type: 'paren', e, pos: open.s, end: this.end() };
  }

  caseExpr() {
    const t = this.next();
    const operand = this.kw('WHEN') ? null : this.expr();
    const whens = [];
    while (this.eatKw('WHEN')) {
      const w = this.expr();
      this.expectKw('THEN');
      whens.push([w, this.expr()]);
    }
    if (!whens.length) throw this.syntax();
    const els = this.eatKw('ELSE') ? this.expr() : null;
    this.expectKw('END');
    return { type: 'case', operand, whens, else: els, pos: t.s, end: this.end() };
  }

  call(name, schema, pos) {
    this.expectOp('(');
    const up = name.toUpperCase();
    if (!schema) {
      if (up === 'CAST' || up === 'TRY_CAST') {
        const e = this.expr();
        this.expectKw('AS');
        const dataType = this.dataType();
        this.expectOp(')');
        return { type: 'cast', e, dataType, try: up === 'TRY_CAST', style: null, pos, end: this.end() };
      }
      if (up === 'CONVERT' || up === 'TRY_CONVERT') {
        const dataType = this.dataType();
        this.expectOp(',');
        const e = this.expr();
        const style = this.eatOp(',') ? this.expr() : null;
        this.expectOp(')');
        return { type: 'cast', e, dataType, try: up === 'TRY_CONVERT', style, pos, end: this.end() };
      }
      if (up === 'TRIM') return this.trimCall(pos);
    }
    const node = { type: 'fn', name: up, schema, args: [], pos, end: pos };
    if (this.op('*')) {
      // Only COUNT(*) and COUNT_BIG(*) take *, as in SQL Server; any other call is a syntax error at the *.
      if (schema || !(up === 'COUNT' || up === 'COUNT_BIG')) throw this.syntax();
      this.i++;
      node.star = true;
      this.expectOp(')');
    } else if (this.op(')')) {
      this.i++;
    } else {
      if (this.kw('DISTINCT')) {
        if (up === 'APPROX_COUNT_DISTINCT' || up === 'STRING_AGG') throw this.syntax();
        this.i++;
        node.distinct = true;
      } else this.eatKw('ALL');
      const d = this.peek;
      if (!schema && DATEPART_FNS.has(up) && d.t === 'id' && isOp(this.la(1), ',')) {
        const v = lower(d.v);
        if (!DATEPARTS.has(v)) throw err(155, d.s, d.e, d.v, lower(up));
        this.i += 2;
        node.args.push({ type: 'datepart', v, pos: d.s, end: d.e });
      }
      do node.args.push(this.expr()); while (this.eatOp(','));
      this.expectOp(')');
    }
    if (this.kw('WITHIN') && this.kwAt(1, 'GROUP')) {
      this.i += 2;
      this.expectOp('(');
      this.expectKw('ORDER');
      this.expectKw('BY');
      node.withinGroup = this.orderList();
      this.expectOp(')');
    }
    if (this.kw('OVER')) {
      this.i++;
      node.over = this.overClause();
    }
    node.end = this.end();
    return node;
  }

  // TRIM([LEADING|TRAILING|BOTH] [chars FROM] s): args in written order.
  trimCall(pos) {
    const t = this.peek;
    let mode = null;
    if (isKw(t, 'LEADING') || isKw(t, 'TRAILING') || isKw(t, 'BOTH')) {
      const n = this.la(1);
      if (isKw(n, 'FROM') || n.t === 'str' || n.t === 'num' || n.t === 'var' || n.t === 'qid' || isOp(n, '(') ||
        (n.t === 'id' && (!RESERVED.has(n.k) || n.k === 'NULL' || n.k === 'CASE' || CALLABLE.has(n.k)))) {
        this.i++;
        mode = t.k;
      }
    }
    let chars = null;
    let s;
    if (mode && this.eatKw('FROM')) {
      s = this.expr();
    } else {
      const e1 = this.expr();
      if (this.eatKw('FROM')) { chars = e1; s = this.expr(); } else s = e1;
    }
    this.expectOp(')');
    const node = { type: 'fn', name: 'TRIM', schema: null, args: chars ? [chars, s] : [s], pos, end: this.end() };
    if (mode) node.trimMode = mode;
    return node;
  }

  // over = { partitionBy, orderBy, frame } (01 §4.4)
  overClause() {
    this.expectOp('(');
    const over = { partitionBy: [], orderBy: [], frame: null };
    if (this.kw('PARTITION')) {
      this.i++;
      this.expectKw('BY');
      do over.partitionBy.push(this.expr()); while (this.eatOp(','));
    }
    if (this.kw('ORDER')) {
      this.i++;
      this.expectKw('BY');
      over.orderBy = this.orderList();
    }
    if (this.kw('ROWS') || this.kw('RANGE')) {
      const u = this.next();
      let start;
      let end;
      if (this.eatKw('BETWEEN')) {
        start = this.bound(true, false);
        this.expectKw('AND');
        end = this.bound(false, false);
      } else {
        start = this.bound(true, true);
        end = { kind: 'cur' };
      }
      if (u.k === 'RANGE' && (start.kind === 'p' || start.kind === 'f' || end.kind === 'p' || end.kind === 'f')) {
        throw err(4194, u.s, this.end());
      }
      over.frame = { unit: u.k, start, end };
    }
    this.expectOp(')');
    return over;
  }

  bound(isStart, short) {
    const t = this.peek;
    if (isKw(t, 'UNBOUNDED')) {
      this.i++;
      const d = this.peek;
      if (isStart && isKw(d, 'PRECEDING')) { this.i++; return { kind: 'up' }; }
      if (!isStart && isKw(d, 'FOLLOWING')) { this.i++; return { kind: 'uf' }; }
      throw this.syntax(d);
    }
    if (isKw(t, 'CURRENT')) {
      this.i++;
      this.expectKw('ROW');
      return { kind: 'cur' };
    }
    if (isIntTok(t)) {
      this.i++;
      const d = this.peek;
      if (isKw(d, 'PRECEDING')) { this.i++; return { kind: 'p', n: t.v }; }
      if (!short && isKw(d, 'FOLLOWING')) { this.i++; return { kind: 'f', n: t.v }; }
      throw this.syntax(d);
    }
    throw this.syntax();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tolerant statement splitter for statementRanges(): used from the first statement the parser cannot parse.

const SPLIT_STARTERS = new Set(('SELECT INSERT UPDATE DELETE DECLARE SET IF WHILE BEGIN END ELSE PRINT EXEC EXECUTE CREATE DROP TRUNCATE ' +
  'RAISERROR WAITFOR RETURN BREAK CONTINUE MERGE REVERT USE COMMIT ROLLBACK SAVE GOTO THROW OPEN CLOSE DEALLOCATE ALTER GRANT DENY ' +
  'REVOKE DBCC BACKUP RESTORE').split(' '));
// Starters that never occur inside parentheses: they end a statement even when its parentheses are unbalanced.
const SPLIT_STRONG = new Set(('DECLARE IF WHILE BEGIN END ELSE PRINT EXEC EXECUTE CREATE DROP TRUNCATE RAISERROR WAITFOR RETURN BREAK ' +
  'CONTINUE MERGE REVERT COMMIT ROLLBACK SAVE GOTO THROW DEALLOCATE ALTER GRANT DENY REVOKE DBCC BACKUP RESTORE').split(' '));
// DML keywords that occur inside parentheses only after ON (a foreign key's ON DELETE / ON UPDATE action) or FOR.
const SPLIT_DML = new Set(['INSERT', 'UPDATE', 'DELETE']);

// WITH followed by these words continues the statement (WITH TIES, WITH ROLLUP, RAISERROR … WITH NOWAIT, …).
const WITH_CONTINUES = new Set(['TIES', 'ROLLUP', 'CUBE', 'NOWAIT', 'LOG', 'SETERROR', 'RESULT', 'RECOMPILE']);

class Splitter {
  constructor(toks) {
    this.t = toks;
    this.n = toks.length - 1;
  }

  k(i) { const t = this.t[i]; return t && t.t === 'id' ? t.k : null; }
  semi(i) { return isOp(this.t[i], ';'); }
  done(i) { return i >= this.n; }

  // A label `name:` (an identifier and ':') starts a statement of its own.
  label(i) {
    const t = this.t[i];
    return !!t && ((t.t === 'id' && !RESERVED.has(t.k)) || t.t === 'qid') && isOp(this.t[i + 1], ':');
  }

  // True when the keyword K at i ends a statement whose parentheses are still open: a SPLIT_STRONG word, or INSERT,
  // UPDATE or DELETE that does not follow ON or FOR.
  strong(i, K) {
    if (SPLIT_STRONG.has(K)) return true;
    if (!SPLIT_DML.has(K)) return false;
    const P = this.k(i - 1);
    return P !== 'ON' && P !== 'FOR';
  }

  // True when the keyword at i is the message name of EXEC [@r =]: a reserved word there that cannot start a
  // statement (EXEC Restore …) is the name, as in the parser (messageName).
  execName(i) {
    const K = this.k(i);
    if (!K || STMT_START.has(K)) return false;
    let p = i - 1;
    if (isOp(this.t[p], '=') && this.t[p - 1] && this.t[p - 1].t === 'var') p -= 2;
    const P = this.k(p);
    return P === 'EXEC' || P === 'EXECUTE';
  }

  starter(i) {
    if (this.label(i)) return true;
    const K = this.k(i);
    if (this.execName(i)) return false;
    if (K === 'WITH') {
      const a = this.t[i + 1];
      const b = this.t[i + 2];
      if (a && a.t === 'id' && WITH_CONTINUES.has(a.k)) return false;
      return !!a && (a.t === 'id' || a.t === 'qid') && (isKw(b, 'AS') || isOp(b, '('));
    }
    if (K === 'FETCH') { const p = this.k(i - 1); return p !== 'ROW' && p !== 'ROWS'; }
    return SPLIT_STARTERS.has(K);
  }

  ranges(i, batch, out) {
    for (;;) {
      while (this.semi(i)) i++;
      if (this.done(i)) return;
      let j = this.stmt(i, 0);
      if (j <= i) j = i + 1;
      let last = j - 1;
      while (last > i && this.semi(last)) last--;
      out.push({ start: this.t[i].s, end: this.t[last].e, batch });
      i = j;
    }
  }

  stmt(i, d) {
    if (d > 400) return this.simple(i);
    const K = this.k(i);
    if (K === 'BEGIN') {
      const K1 = this.k(i + 1);
      if (K1 === 'TRAN' || K1 === 'TRANSACTION' || K1 === 'DISTRIBUTED') return this.simple(i);
      if (K1 === 'TRY') {
        let j = this.list(i + 2, 'TRY', d);
        if (!(this.k(j) === 'END' && this.k(j + 1) === 'TRY')) return j;
        j += 2;
        let m = j;
        while (this.semi(m)) m++;
        if (this.k(m) === 'BEGIN' && this.k(m + 1) === 'CATCH') {
          j = this.list(m + 2, 'CATCH', d);
          if (this.k(j) === 'END' && this.k(j + 1) === 'CATCH') j += 2;
        }
        return j;
      }
      const j = this.list(i + 1, '', d);
      return this.k(j) === 'END' ? j + 1 : j;
    }
    if (K === 'IF' || K === 'WHILE') {
      let j = this.cond(i + 1);
      if (this.done(j) || this.semi(j) || this.k(j) === 'END' || this.k(j) === 'ELSE') return j;
      j = this.stmt(j, d + 1);
      if (K === 'IF') {
        let m = j;
        while (this.semi(m)) m++;
        if (this.k(m) === 'ELSE') {
          m++;
          j = this.done(m) || this.semi(m) || this.k(m) === 'END' ? m : this.stmt(m, d + 1);
        }
      }
      return j;
    }
    return this.simple(i);
  }

  list(i, kind, d) {
    for (;;) {
      while (this.semi(i)) i++;
      if (this.done(i)) return i;
      if (this.k(i) === 'END' && (!kind || this.k(i + 1) === kind)) return i;
      const j = this.stmt(i, d + 1);
      i = j > i ? j : i + 1;
    }
  }

  cond(i) {
    let depth = 0;
    let cs = 0;
    for (; !this.done(i); i++) {
      const t = this.t[i];
      if (t.t === 'op') {
        // A ';' token never occurs inside parentheses in T-SQL, so it ends the statement at any depth.
        if (t.v === '(') depth++;
        else if (t.v === ')') { if (depth) depth--; } else if (t.v === ';') return i;
        continue;
      }
      if (t.t === 'qid' && !depth && this.label(i)) return i;
      if (t.t !== 'id') continue;
      const K = t.k;
      if (K === 'CASE') { cs++; continue; }
      if (K === 'END') { if (cs) { cs--; continue; } return i; }
      if (cs && K === 'ELSE') continue;
      if (depth) { if (this.strong(i, K)) return i; continue; }
      if (this.starter(i)) return i;
    }
    return i;
  }

  simple(i) {
    const K0 = this.k(i);
    if (K0 === 'END' || K0 === 'ELSE') return i + 1;
    let mode = K0 ?? 'SELECT';
    let depth = 0;
    let cs = 0;
    let haveSrc = false;
    let haveSet = false;
    if (this.label(i)) return i + 2;
    let j = this.t[i].t === 'id' ? i + 1 : i;
    for (; !this.done(j); j++) {
      const t = this.t[j];
      if (t.t === 'op') {
        // A ';' token never occurs inside parentheses in T-SQL, so it ends the statement at any depth.
        if (t.v === '(') depth++;
        else if (t.v === ')') { if (depth) depth--; } else if (t.v === ';') break;
        continue;
      }
      if (t.t === 'qid' && !depth && this.label(j)) break;
      if (t.t !== 'id') continue;
      const K = t.k;
      if (K === 'CASE') { cs++; continue; }
      if (K === 'END') { if (cs) { cs--; continue; } break; }
      if (cs && K === 'ELSE') continue;
      if (depth) { if (this.strong(j, K)) break; continue; }
      if (!this.starter(j)) {
        if (mode === 'INSERT' && (K === 'VALUES' || K === 'DEFAULT')) haveSrc = true;
        continue;
      }
      const P = this.k(j - 1);
      if (K === 'SELECT' && (P === 'UNION' || P === 'ALL' || P === 'EXCEPT' || P === 'INTERSECT')) continue;
      if (mode === 'WITH' && (K === 'SELECT' || K === 'INSERT' || K === 'UPDATE' || K === 'DELETE' || K === 'MERGE')) { mode = K; continue; }
      if (mode === 'INSERT' && !haveSrc && (K === 'SELECT' || K === 'EXEC' || K === 'EXECUTE' || K === 'WITH')) { haveSrc = true; continue; }
      if (mode === 'UPDATE' && !haveSet && K === 'SET') { haveSet = true; continue; }
      if (mode === 'DROP' && K === 'IF' && P === 'TABLE') continue;
      if (mode === 'DECLARE' && (K === 'SELECT' || K === 'WITH') && P === 'FOR') { if (K === 'WITH') mode = 'WITH'; continue; }
      // A cursor's FOR UPDATE [OF …] belongs to its DECLARE (the parser refuses it with its own error).
      if (K0 === 'DECLARE' && K === 'UPDATE' && P === 'FOR') continue;
      break;
    }
    return j;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Exports

// Parses a script (all GO batches) into Statement[] with a `warnings: [{pos, end, text}]` property; throws SqlError.
// Options: quotedIdentifier (false: "…" is a string literal); dynamic (the text of sp_executesql or EXEC (…):
// a GO line raises 102); vars (the names that count as declared scalar variables in the first batch: the
// sp_executesql parameters); labelChecks (false: no 132/133/1026; the result lists `labels` and `gotos` instead, so
// the editor can resolve them across the regions of a batch it parses one by one, 03 §5).
export function parse(src, { quotedIdentifier = true, dynamic = false, vars = null, labelChecks = true } = {}) {
  const { all, batches } = scanBatches(src);
  const warnings = [];
  const out = [];
  const collect = labelChecks === false;
  const labels = [];
  const gotos = [];
  // The QUOTED_IDENTIFIER mode of the batch being read: the option for the first batch, then modeAfter.
  let qi = quotedIdentifier !== false;
  try {
    for (const [k, b] of batches.entries()) {
      if (!qi) dqStrings(b.toks, src);
      if (b.lexErr) throw lexError(b.lexErr, src);
      const p = new Parser(src, b.toks, { warnings, checks: true, labels: collect ? 'collect' : 'check', vars: k === 0 ? vars : null });
      const stmts = p.batch();
      qi = modeAfter(stmts, qi);
      out.push(...stmts);
      if (collect) {
        for (const l of p.labels) labels.push({ name: l.name, batch: k, scopes: l.scopes, pos: l.pos, end: l.end });
        for (const g of p.gotos) gotos.push({ label: g.label, batch: k, scopes: g.scopes, pos: g.pos, end: g.end });
      }
      if (b.go) {
        if (dynamic) throw err(102, b.go.pos, b.go.pos + 2, src.slice(b.go.pos, b.go.pos + 2));
        const c = b.go.countTok;
        if (c && (c.v < 1 || c.v > MAX_GO_COUNT)) throw mkErr(GO_MSG, 0, c.s, c.e);
        out.push({ type: 'go', count: b.go.count, pos: b.go.pos, end: b.go.end });
      }
    }
  } catch (e) {
    if (e instanceof RangeError) throw err(191, 0, src.length);
    throw e;
  }
  // After the batches were read, so that each "…" token has its batch's kind (a string while OFF is never warned);
  // they go first, so at an equal position they stay before the other warnings.
  const inv = [];
  invisibleWarnings(src, all, inv);
  out.warnings = inv.concat(warnings).sort((a, b) => a.pos - b.pos);
  if (collect) {
    out.labels = labels;
    out.gotos = gotos;
  }
  return out;
}

// The significant tokens of a text that GO never splits (expressions, sp_executesql parameter lists).
function plainTokens(src, qi) {
  const toks = [];
  for (const t of lexAll(src, qi)) {
    if (t.t === 'ws') continue;
    if (t.t === 'cmt') { if (t.open) throw lexError(t, src); continue; }
    if (t.t === 'bad' || t.open) throw lexError(t, src);
    toks.push(t);
  }
  return toks;
}

// Parses one expression (no GO splitting, no variable declaration checks); throws SqlError.
export function parseExpression(src, { quotedIdentifier = true } = {}) {
  const p = new Parser(src, plainTokens(src, quotedIdentifier !== false), { warnings: [], checks: false });
  try {
    const e = p.expr();
    if (p.peek.t !== 'end') throw p.syntax();
    return e;
  } catch (e) {
    if (e instanceof RangeError) throw err(191, 0, src.length);
    throw e;
  }
}

// Parses the @params text of sp_executesql (02 §9): `@name type [= constant] [OUT|OUTPUT]` items, comma
// separated, into [{name (lower case), raw, dataType, default: Expr|null, output, pos, end}] with positions in that
// text; a syntax error raises 102 there (also near a keyword, 02 §9 (2)) and a duplicate name 134. '' gives [].
export function parseParams(src, { quotedIdentifier = true } = {}) {
  const p = new Parser(src, plainTokens(src, quotedIdentifier !== false), { warnings: [], checks: true, only102: true });
  const out = [];
  try {
    if (p.peek.t === 'end') return out;
    do {
      const t = p.peek;
      if (t.t !== 'var' || t.v.startsWith('@@')) throw p.syntax();
      p.checkVarTok(t);
      p.i++;
      p.eatKw('AS');
      if (p.kw('CURSOR')) throw p.cursorVarError(t, p.peek);
      p.checkNewVar(t);
      const dataType = p.dataType();
      let def = null;
      if (p.eatOp('=')) {
        const d = p.peek;
        if (isKw(d, 'NULL')) { p.i++; def = { type: 'lit', v: null, dt: 'null', pos: d.s, end: d.e }; } else {
          if (!(d.t === 'num' || d.t === 'str' || (isOp(d, '-') && p.la(1).t === 'num'))) throw p.syntax();
          def = p.constOrVar();
        }
      }
      const output = p.eatKw('OUTPUT') || p.eatKw('OUT');
      p.declareVar(t.v, 'scalar');
      out.push({ name: t.v, raw: t.raw, dataType, default: def, output, pos: t.s, end: p.end() });
    } while (p.eatOp(','));
    if (p.peek.t !== 'end') throw p.syntax();
    return out;
  } catch (e) {
    if (e instanceof RangeError) throw err(191, 0, src.length);
    throw e;
  }
}

// Top-level statement ranges [{start, end, batch}] of a script; tolerant of incomplete text and never throws.
export function statementRanges(src, { quotedIdentifier = true } = {}) {
  const out = [];
  try {
    const { batches } = scanBatches(src);
    // Each batch is read with the QUOTED_IDENTIFIER mode that parse() gives it.
    let qi = quotedIdentifier !== false;
    batches.forEach((b, batch) => {
      if (!qi) dqStrings(b.toks, src);
      const p = new Parser(src, b.toks, { warnings: [], checks: false });
      let start = 0;
      try {
        for (;;) {
          while (p.op(';')) p.i++;
          if (p.peek.t === 'end') return;
          start = p.i;
          const st = p.statement(false);
          const list = Array.isArray(st) ? st : [st];
          qi = modeAfter(list, qi);
          out.push({ start: list[0].pos, end: list[list.length - 1].end, batch });
        }
      } catch {
        qi = modeAfterTokens(b.toks, start, qi);
        try { new Splitter(b.toks).ranges(start, batch, out); } catch { /* keep the ranges found so far */ }
      }
    });
  } catch { /* never throws: return what was found */ }
  return out;
}

// Fields whose string values are identifiers (compared case-insensitively); every other string is kept as written.
const KEY_LOWER = new Set(['parts', 'alias', 'columns', 'name', 'schema', 'qualifier', 'qualParts', 'valueCol', 'forCol', 'cols', 'v', 'assign', 'variable']);

// Canonical value of a numeric literal: ints and floats by value (`1E2` = `1e2`), decimals by their digits with
// leading zeros dropped and the scale kept (`01.50` -> `1.50`, which differs from `1.5`, a decimal(2,1)).
function numKey(x) {
  if (x.dt !== 'decimal' || typeof x.raw !== 'string' || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(x.raw)) return String(x.v);
  let r = x.raw;
  const neg = r[0] === '-';
  if (neg || r[0] === '+') r = r.slice(1);
  const [ip, fp = ''] = r.split('.');
  return (neg && /[1-9]/.test(r) ? '-' : '') + (ip.replace(/^0+/, '') || '0') + (fp ? '.' + fp : '');
}

// Key text of a literal node: its type and its value.
function litKey(x) {
  const v = x.v;
  let t;
  if (v === null || v === undefined) t = 'null';
  else if (typeof v === 'string') t = (x.unicode ? 'N' : '') + JSON.stringify(v);
  else if (typeof v === 'number' || typeof v === 'bigint') t = numKey(x);
  else if (v instanceof Date) t = 'D' + v.getTime();
  else t = JSON.stringify(String(v));
  return `lit(${x.dt}:${t})`;
}

// Properties that take part in a key: not the type (written first), not null/undefined/false/[] (the same as absent:
// `args: []`, `partitionBy: []`), not functions or '_' annotations of other modules, and pos/end only when they are
// not source offsets.
function keyProp(x, k) {
  if (k === 'type' || k.charCodeAt(0) === 95) return false;
  const v = x[k];
  if (v === null || v === undefined || v === false || typeof v === 'function') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return !((k === 'pos' || k === 'end') && typeof v === 'number');
}

const byKey = (a, b) => { const x = String(a[0]); const y = String(b[0]); return x < y ? -1 : x > y ? 1 : 0; };

// Canonical text of an expression: identifiers lower-cased, parens stripped, literal type and value kept, pos ignored.
export function exprKey(expr) {
  let s = '';
  const st = [expr];
  const fl = [0];
  const RAW = 2;
  const EXIT = 3;
  const path = new Set();
  const push = (x, f) => { st.push(x); fl.push(f); };
  while (st.length) {
    const x = st.pop();
    const f = fl.pop();
    if (f === RAW) { s += x; continue; }
    if (f === EXIT) { path.delete(x); continue; }
    if (x === null || x === undefined || typeof x === 'function') { s += '~'; continue; }
    if (typeof x === 'string') { s += JSON.stringify(f ? x.toLowerCase() : x); continue; }
    if (typeof x !== 'object') { s += String(x); continue; }
    if (x instanceof Date) { s += 'D' + x.getTime(); continue; }
    if (path.has(x)) throw new Error('exprKey: the expression contains a cycle.');
    if (x.type === 'lit') { s += litKey(x); continue; }
    path.add(x);
    push(x, EXIT);
    if (Array.isArray(x)) {
      push(']', RAW);
      for (let k = x.length - 1; k >= 0; k--) { push(x[k], f); if (k) push(',', RAW); }
      push('[', RAW);
      continue;
    }
    if (x instanceof Set) { push([...x].sort(), f); s += 'S'; continue; }
    if (x instanceof Map) { push([...x].sort(byKey), f); s += 'M'; continue; }
    if (x.type === 'paren') { push(x.e, 0); continue; }
    const keys = Object.keys(x).filter(k => keyProp(x, k)).sort();
    push('}', RAW);
    for (let k = keys.length - 1; k >= 0; k--) {
      push(';', RAW);
      push(x[keys[k]], KEY_LOWER.has(keys[k]) ? 1 : 0);
      push(keys[k] + ':', RAW);
    }
    s += (typeof x.type === 'string' ? x.type : '') + '{';
  }
  return s;
}
