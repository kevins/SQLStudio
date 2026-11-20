// Completion, signature help and hover cards for the SQL editor (03 §1.4, §1.5, §5 Completion,
// §5 Signature help and hover, §8.1 hoverCards, §9 Escape cascade step 4, §13; 01 §4.1 Hints, Cursors
// and SET QUOTED_IDENTIFIER, §5.2 COLLATE, §6.3, §7, §8.2, §8.3; 02 §2, §7, §8.1, §9). The logic is
// pure and exported: a tolerant token analysis of the batch around the caret (incl. the text
// after it), the item builders, ranking, the signature-help and hover-card models and the popup geometry.
// createCompletion() is the thin DOM part on top of editor.js.
//
// Notes (extensions of 03 §1.4 / §5; what 03 §5 states is not repeated):
// - Exports beyond 03 §1.4 (pure helpers): analyze, completions, complete,
//   createSource, rankItems, matchScore, acceptEdit, enterAccepts, triggerAt, callAt, signatureAt, docSignature,
//   messageSignature, hoverAt, cardFor, renderCard, renderSignature, problemsModel, popupPlacement, tipPlacement,
//   batchBounds, lexWindow, tableColumns, nameSql, uniqueAlias, hintDoc, hintKind, hintDocKind and IGNORED_HINT_TEXT.
// - HINT_DOCS follows parser.js HINTS and its `origin` (01 §1): hintDocKind(row) is 'sqlserver' for the SQL
//   Server USE HINT names and the SQL Server query hints with `implemented: false`, else 'studio' (SQL Studio's and SQL
//   4 CDS's hints, the SQL Server query hints SQL Studio implements such as MAXDOP, HASH GROUP and FORCE ORDER, the
//   table hint NOLOCK), because 03 §5 and §8.2 section 7 list the 'sqlserver' group as "the SQL Server USE HINT names"
//   with "accepted and ignored" or their <fetch options> effect, while the implemented query hints have effects of
//   their own. The 'studio'
//   entries are written here (syntax, effect, `typed` for BYPASS_CUSTOM_PLUGIN_EXECUTION,
//   BYPASS_BUSINESS_LOGIC_EXECUTION and USE_BULK_DELETE, 02 §8.1); the 'sqlserver' ones are made from the HINTS rows in
//   their order: syntax `OPTION (USE HINT('<name>'))` or the OPTION item with an example argument, text
//   IGNORED_HINT_TEXT, or the FetchXML option for the three USE HINT names 01 §4.1 maps. The syntax tells the
//   HINTS kind (hintKind(d)); BATCH_SIZE_n / FETCHXML_PAGE_SIZE_n show an example number. hintDoc(text) finds statement
//   hints only (an OPTION item or a USE HINT name as written, numbered names included); the NOLOCK entry feeds the
//   WITH ( item and the WITH (NOLOCK) card. After OPTION ( every statement hint is listed (USE HINT names as `USE
//   HINT('…')`); the number of an option item (MAXDOP 4, FAST 10) or of a numbered name (BATCH_SIZE_100) is selected
//   for typing over, never a number inside a name (QUERY_OPTIMIZER_COMPATIBILITY_LEVEL_150).
// - "Keywords valid here" use parser.js as the oracle. Alias position: a derived table, VALUES list, PIVOT /
//   UNPIVOT or nodes() call needs its alias, so only AS follows it; a JOIN source without its ON takes ON (first), AS,
//   WITH (NOLOCK) (Dataverse tables) and the qualified joins (`a JOIN b JOIN c ON … ON …`), never CROSS JOIN, APPLY or a
//   clause; any other source takes AS, WHERE, the joins and APPLY forms, GROUP BY, HAVING, ORDER BY, OPTION (, the set
//   operators, FOR JSON / FOR XML, WITH (NOLOCK) (Dataverse tables) and PIVOT / UNPIVOT (after an UPDATE / DELETE …
//   FROM source: WHERE, the joins, OPTION ( and NOLOCK), and OPENJSON(…) without a schema also `WITH (`; after its AS
//   nothing. After the alias of a source (kind 'after') the same lists without AS, and WITH (NOLOCK) only right after
//   the alias of a Dataverse table. A typed word is the alias, so a fresh analysis offers nothing for it; only a
//   list that was open at the empty position keeps filtering the same keywords by the word (completions(ctx, src,
//   {aliasKeywords: true})), and there Enter needs navigation (enterAccepts(it, prefix, navigated, kind)). Table hints
//   end the alias position (T-SQL writes the alias before WITH (…)); a WITH inside a statement (table hints, an OPENJSON
//   schema, WITH TIES / ROLLUP) changes no clause, and the FROM of `DELETE FROM t` names the target, so `DELETE FROM t |`
//   offers the DELETE clause words.
// - DML targets: the target position is after UPDATE / DELETE / INSERT [TOP (n) [PERCENT]] [FROM | INTO], also
//   the caret right before a FROM that follows DELETE (`DELETE | FROM c`). Besides 03 §5's writable targets it lists the
//   statement's CTEs and, after DELETE, the bin. tables; `dbo.` lists the tables, `bin.` the recycle-bin
//   tables for DELETE, other schemas nothing. The keyword INTO / FROM comes first only when it is not written and
//   (DELETE) no FROM clause follows; an alias item hides the table item of the same name. OUTPUT … INTO lists the #temp
//   tables and the table variables (00 §2, 01 §4.1 INTO targets; 03 §5 names only #temp tables).
// - sys objects: `sys.fn_helpcollations` inserts `sys.fn_helpcollations()` and is not offered without its schema;
//   `sys.` lists both objects, APPLY takes only the TVF; their columns are 01 §8's, and `sys.messages` has a card.
// - Web API function TVFs (02 §9 response shapes): a message with a responseEntity (meta.js) has that table's
//   columns; otherwise the first response property of shape (a)-(d), in response order, decides: (a) a table name or
//   '<table>[]' type gives the table's readable columns with the 01 §6.3 virtual ones ('Entity' / 'EntityCollection':
//   none before the answer), (b) AuditDetail / AuditDetailCollection the audit table's columns plus `oldvalues` and
//   `newvalues` nvarchar(max), (c) a type the metadata does not know one column of the property's name (nvarchar(max);
//   its `<property>_<member>` columns come with the answer), (d) StringArray or '<scalar>[]' one column of the property's
//   name; without one, every scalar property (e). Types are the meta.messages() type names.
// - EXEC: an OUTPUT item inserts `@Name = @var OUTPUT` with the batch's variable of that name, else
//   `@Name = @Name OUTPUT` with the variable's name selected; positional arguments use the parameters, then the
//   response properties, in meta.messages() order. After `@Name = @var` or a positional `@var` (a word may be typed)
//   the list is OUTPUT (when the argument is a response property, by name or position, or an OUTPUT parameter of the
//   constant @params of sp_executesql, or any later sp_executesql argument when @params is no constant; never after a
//   constant or @@ global, 179), then the statement starters. The EXEC list ends with `sp_executesql` (dynamic SQL),
//   and the messages EXEC always refuses (02 §8.1: Create … DeleteAndPromote) come last with the detail 'Refused:
//   use INSERT/UPDATE/DELETE' and insert only their name. For sp_executesql an OUTPUT parameter of the @params string is
//   offered as `@name = @var OUTPUT` too, and the third and later arguments get them; a @params value that is no single
//   string literal declares nothing. ',' is the trigger 'comma' of triggerAt(): the controller opens the list only when
//   the analysis is an EXEC parameter position. messageSignature(m, i, named, true) also lists the response properties
//   as optional `@Name type OUTPUT` parameters, and a response property has the card 'Response property of <message>'.
// - Messages (02 §2): createSource({messages, messagesFull}): `messagesFull` (default true) says whether the map
//   includes the $metadata messages. EXEC completion needs them (need 'messagesFull', loaded with meta.messages());
//   table lists, hover and signature help need 'messages' (meta.messages({csdl: false}), meta.js's option), so
//   $metadata is read only for EXEC. The controller shows the short map meanwhile, with a disabled 'Loading…' row
//   after its items (as after the items of any list whose data is still on its way), never lets a short map replace a
//   full one, and re-reads the kind it holds on refresh. An empty list shows 'Could not load the metadata: …' only for
//   a request of its own build that failed (kept per need until it loads or meta refreshes).
// - Variables: the general list has the scalar variables declared before the caret (after the aliases) and the
//   @@ globals of 01 §7 (after the functions); `@` lists scalar variables only (a table variable is no value), FETCH …
//   INTO the scalar variables without the globals.
// - COLLATE: the names come from types.js sqlCollations(); the _KS, _WS, _SC, _VSS and _UTF8 forms are valid
//   when typed but not listed; the detail is the fn_helpcollations description (collationInfo()), ORDER BY offers
//   COLLATE after an operand, and a collation name has a card.
// - xml: the xml expressions are xml variables, xml columns (#temp, table variable, nodes() column, and a CTE or
//   derived-table column whose select-list expression is one, also by position under a column list),
//   CAST/CONVERT to xml, `.query(…)` and `(SELECT … FOR XML …, TYPE)`; nodes( is offered alone where a table source
//   goes (a FROM item or an APPLY right side, never a DML target) and modify() never. There `alias.` lists the xml
//   columns of that earlier source as `col.nodes(`, and `@` (and the table list) the xml variables as `@x.nodes(`. The
//   '.' trigger stays 'after a name', so after ')' the list opens with Ctrl+Space. Signature help, hover and F1 of
//   `x.value(` etc. use the FUNCTION_DOCS entries 'xml.value' … A leading `WITH XMLNAMESPACES (…)` item is no CTE.
// - Cursors: OPEN / CLOSE / DEALLOCATE [GLOBAL] and FETCH … FROM [GLOBAL] complete the cursors declared in the
//   batch before the caret, then the GLOBAL ones (declared without LOCAL) that earlier batches of the script leave
//   declared: a later `DEALLOCATE [GLOBAL] c` in those batches removes one (without GLOBAL it names that batch's LOCAL c
//   when there is one), whatever IF or GOTO decides at run time. FETCH offers the directions, FROM after one and INTO
//   after the cursor; DECLARE c offers INSENSITIVE / SCROLL / CURSOR, after CURSOR the options that conflict with none
//   written as parser.js checks them (FAST_FORWARD goes with FORWARD_ONLY and READ_ONLY; the ISO form takes FOR
//   alone), then FOR and the query. The statement starters add OPEN, FETCH NEXT FROM, CLOSE, DEALLOCATE, GOTO, WAITFOR
//   TIME and SET QUOTED_IDENTIFIER OFF / ON.
// - Statement words (03 §5 'keywords valid here'; 01 §4.1, §4.2): `SET |` lists the batch's scalar variables, then the
//   SET options of 01 §4.1 (each with a card); `SET A, |` only the ON / OFF options not listed yet (nothing after a
//   DATEFORMAT, DATEFIRST, LANGUAGE or TRANSACTION); after an option come its values (for `SET A, B ON` those every
//   listed option accepts; DATEFIRST with the day names), and SET TRANSACTION ISOLATION LEVEL READ COMMITTED |
//   UNCOMMITTED word by word. After the value the statement is complete: the statement starters follow (also on the
//   next line), and an INSERT, UPDATE or DELETE after `SET … ON` starts its own statement. WAITFOR offers DELAY and
//   TIME, THROW an expression, and GOTO the labels of the batch (`name:`; those before an analysis window from the
//   fast scan) except those inside a TRY or CATCH body that is not around the GOTO too (1026), each with a card
//   ('Label · line n'). FOR offers XML and JSON (in a cursor's query only READ_ONLY), then their modes (also PATH('')
//   for the string-concatenation idiom), and after ',' the options not written yet, as parser.js reads them (ROOT and
//   WITHOUT_ARRAY_WRAPPER exclude each other; no ELEMENTS with EXPLICIT).
// - Unclosed quoted names and strings (03 §1.4 Accept, §5): a `[name` or `"name` still open that was opened on the
//   caret's line ends, for the analysis, at the name characters after the caret, and the rest of the batch is lexed as
//   code (so `SELECT [na| FROM account` sees account); the analysed range of any open name ends there too, and that of
//   an open USE HINT('… string at the hint-name characters after the caret, so accepting never removes later text. A
//   string or name opened on an earlier line keeps its T-SQL extent: nothing completes inside it.
// - SET QUOTED_IDENTIFIER OFF (03 §5 'completion treats it as a string'): analyze, complete, callAt, signatureAt,
//   hoverAt and lexWindow take `quotedIdentifier` (default true; a lexWindow() result passed as `lex` carries its
//   mode as `qi` and is reused only in it). OFF lexes `"…"` as a string: nothing completes, hovers or names a table
//   inside it, USE HINT("…") completes hint names, and sp_executesql's @params text parses in that mode. The
//   controller reads the mode from opts.session()'s `opts.quotedIdentifier` (02 §9), else editor.quotedIdentifier().
// - createCompletion(editor, {hoverText: true}) (03 §1.4 editor `hoverTips`): every hover card (the mouse's and Ctrl+K
//   Ctrl+I's) also shows editor.hoverText(offset) (marker messages, invisible characters), levels from
//   editor.markersAt(), in a 'Problems' group below its content, or alone in a card labelled 'Problems' where the
//   offset has no card of its own; main.js passes it and creates the editor with hoverTips: false, so one card shows
//   both. Default false (the editor keeps its own tooltip). settings.hoverCards false turns off the mouse's cards
//   of names (one open closes at the next mouse move) but not the Diagnostics tooltip (03 §5): the pointer resting
//   500 ms on a marked character still opens the problems-only card.
// - A FROM after an unclosed '(' of a call (not a subquery, not TRIM) is the statement's FROM (`SELECT COUNT(| FROM
//   account`). Data types: every TYPE_NAMES name (the usual ones first). Names are inserted through
//   util.sqlName (GO quoted too; nameSql adds only the #temp and empty-name cases); #temp names stay bare,
//   message names go through it, a parameter name that is no plain identifier is not offered, and an option value is
//   inserted only as an integer literal.
// - F1 (helpTarget): a built-in function name the hover analysis gives no card counts only as a call, a niladic
//   function or the last word of its statement (never LEFT / RIGHT of a join or a column named like a function).
// - Analysis windows (03 §13): a line longer than the window (one-line or generated SQL) is cut at a token boundary
//   (whitespace or ';' in code, found by lexing from a position right after whitespace) instead of a line start.
// - complete.js raises no numbered SQL Server error, so it needs no MESSAGES text.
// - Popup geometry: the list, its side panel and the signature popup are placed by popupPlacement / tipPlacement (the
//   same viewport rule as dom.js placeNear: below the anchor, above when there is no room, 8 px from the edges), not by
//   placeNear, because the side panel is placed beside the list's final position and the signature popup prefers the
//   space above (03 §5 Hover details), which placeNear (below first, no result returned) cannot express; the own hover
//   card (no shell) uses placeNear.
// - Motion: the list, side panel and signature popup use the shared `.pop` rise (.12s ease-out, none under
//   prefers-reduced-motion) when a popup is shown, never while the open list refilters; hover cards use the shell's.
//   Forced colours: the popups get a token-coloured border and the selected row a token-coloured outline. The
//   'Could not load the metadata: …' row of an empty list wraps its whole message.
// - Engine and core imports beyond 03 §1.4 (00 §3 DAG): parser.js parseParams, types.js dtOfAttr / typeName /
//   TYPE_NAMES / sqlCollations / collationInfo, functions.js tables, core/util.js sqlIdent / sqlName / sqlStr /
//   fmtInt / uid.

import { h, clear, placeNear } from './dom.js';
import { icon } from './icons.js';
import { tokenize, RESERVED } from '../engine/lexer.js';
import { parseParams, HINTS } from '../engine/parser.js';
import { docFor, paramAt, SCALARS, AGGREGATES, WINDOWS, TVFS, FETCH_CONDITIONS } from '../engine/functions.js';
import { TYPE_NAMES, dtOfAttr, typeName, sqlCollations, collationInfo } from '../engine/types.js';
import { META_TABLES } from '../engine/metatables.js';
import { sqlIdent, sqlName, sqlStr, fmtInt, uid } from '../core/util.js';
import { highlightSql } from './editor.js';

// ------------------------------------------------------------------------------------------------- constants

const ROW_H = 28;                 // list row height
const VISIBLE = 12;               // rows visible (03 §5)
const OVERSCAN = 4;
const DEBOUNCE_MS = 30;           // identifier-character trigger (03 §5)
const HOVER_MS = 500;             // pointer rest before a hover card (03 §5)
const HOVER_LEAVE_MS = 300;       // card closes this long after the pointer leaves (03 §5)
const WHOLE_MAX = 32 * 1024;      // batches up to this size are lexed whole
const WINDOW_MIN = 16 * 1024;     // first analysis window of a larger batch (doubled while it cuts the caret's statement)
const WINDOW_MAX = 128 * 1024;    // largest analysis window
const STMT_MAX = 32 * 1024;       // prescan() reads one DECLARE / CREATE TABLE before the window this far at most
const BACK_MAX = 20000;           // tokens a call search walks back
const SIDE_W = 320;               // side description panel width
const GAP = 4;
const EDGE = 8;
const FETCH_NOTE = 'Use only as a condition on a Dataverse column, e.g. createdon = lastxdays(7). Evaluated by Dataverse in your Dataverse time zone.';

const lower = s => String(s ?? '').toLowerCase();
const TEMP_PLAIN = /^##?[A-Za-z0-9_#]*[A-Za-z0-9_]$/;  // a #temp name written without brackets
const IDENT_CH = /[\p{L}\p{N}_@#$]/u;
const ALNUM = /[\p{L}\p{N}]/u;
const ASCII = /^[\x00-\x7f]*$/;
const EXCLUDED_TYPES = new Set(['Virtual', 'CalendarRules', 'PartyList']);
const LOOKUPS = new Set(['Lookup', 'Customer', 'Owner']);
const CHOICES = new Set(['Picklist', 'State', 'Status']);
const NAMED = new Set(['Lookup', 'Customer', 'Owner', 'Picklist', 'State', 'Status', 'Boolean', 'MultiSelectPicklist']);
const DATEPART_FNS = new Set(['DATEADD', 'DATEDIFF', 'DATEDIFF_BIG', 'DATEPART', 'DATENAME', 'DATETRUNC']);
const NILADIC = new Set(['CURRENT_USER', 'CURRENT_TIMESTAMP', 'SESSION_USER', 'SYSTEM_USER', 'USER']);
const OPERAND_KW = new Set(['NULL', 'END', 'CURRENT_USER', 'CURRENT_TIMESTAMP', 'SESSION_USER', 'SYSTEM_USER', 'USER', 'DEFAULT']);
const TABLE_HINT_WORDS = new Set(['NOLOCK', 'READUNCOMMITTED', 'UPDLOCK', 'HOLDLOCK', 'ROWLOCK', 'TABLOCK', 'NOWAIT', 'READPAST', 'SERIALIZABLE']);
const STOP_FROM = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'OPTION', 'UNION', 'EXCEPT', 'INTERSECT', 'FOR', 'SELECT', 'INSERT',
  'UPDATE', 'DELETE', 'SET', 'OUTPUT', 'INTO', 'VALUES', 'WINDOW', 'OFFSET']);
const JOIN_START = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER']);
const STMT_KW = new Set(('SELECT INSERT UPDATE DELETE MERGE DECLARE SET IF ELSE WHILE BEGIN END PRINT EXEC EXECUTE WITH CREATE DROP ' +
  'TRUNCATE RAISERROR WAITFOR RETURN BREAK CONTINUE REVERT USE COMMIT ROLLBACK SAVE GOTO THROW OPEN CLOSE FETCH DEALLOCATE').split(' '));
const DML_KW = new Set(['UPDATE', 'DELETE', 'INSERT']);
// The source kinds of Dataverse tables (dbo., archive. and bin.): the ones a table hint applies to (01 §4.3).
const TABLE_KINDS = new Set(['table', 'archive', 'bin']);
// Cursor options of DECLARE c … CURSOR … FOR (01 §4.1 Cursors): before CURSOR (ISO form) and after it.
const CURSOR_PRE = ['INSENSITIVE', 'SCROLL'];
const CURSOR_POST = ['LOCAL', 'GLOBAL', 'FORWARD_ONLY', 'SCROLL', 'STATIC', 'FAST_FORWARD', 'READ_ONLY'];
const FETCH_DIRS = new Set(['NEXT', 'PRIOR', 'FIRST', 'LAST', 'ABSOLUTE', 'RELATIVE']);
// The messages EXEC always refuses with 'Use INSERT/UPDATE/DELETE instead: …' (02 §8.1 EXEC), lower case.
const REFUSED_EXEC = new Set(['create', 'update', 'delete', 'upsert', 'createmultiple', 'updatemultiple', 'upsertmultiple', 'deletemultiple',
  'executemultiple', 'executetransaction', 'bulkdelete', 'merge', 'assign', 'setstate', 'associate', 'disassociate', 'importsolution',
  'importsolutionasync', 'uninstallsolution', 'deleteandpromote']);
// A parameter name that can be written as @name (01 §4.1).
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The xml data type methods completion offers after `x.` (01 §8.3); modify() raises an error, so it is not offered.
const XML_METHODS = ['value', 'query', 'exist', 'nodes'];
const XML_TYPE = /^xml\b/i;   // a type text of the xml data type
// Statement keywords that can never appear inside parentheses: seeing one there recovers from an unclosed '('.
const STRONG_KW = new Set('DECLARE INSERT PRINT IF WHILE BEGIN CREATE DROP TRUNCATE RETURN THROW RAISERROR WAITFOR REVERT GOTO'.split(' '));
const CLAUSE_OF = new Map([['SELECT', 'select'], ['FROM', 'from'], ['WHERE', 'where'], ['GROUP', 'group'], ['HAVING', 'having'],
  ['ORDER', 'order'], ['OPTION', 'option'], ['INTO', 'into'], ['VALUES', 'values'], ['OUTPUT', 'output'], ['OFFSET', 'offset'],
  ['FETCH', 'offset'], ['FOR', 'for'], ['UPDATE', 'update'], ['DELETE', 'delete'], ['INSERT', 'insert'], ['WITH', 'with']]);
const SCHEMAS = new Set(['metadata', 'archive', 'bin', 'dbo', 'sys']);
// The sys objects of 01 §8 / 02 §7: the view sys.messages and the TVF sys.fn_helpcollations().
const SYS_MESSAGES_COLS = [['message_id', 'int'], ['language_id', 'int'], ['severity', 'tinyint'], ['is_event_logged', 'bit'], ['text', 'nvarchar(2048)']];
const HELPCOLLATIONS_COLS = [['name', 'nvarchar(128)'], ['description', 'nvarchar(1000)']];
const DATEPARTS = [['year', 'yy, yyyy'], ['quarter', 'qq, q'], ['month', 'mm, m'], ['dayofyear', 'dy, y'], ['day', 'dd, d'],
  ['week', 'wk, ww'], ['weekday', 'dw, w'], ['hour', 'hh'], ['minute', 'mi, n'], ['second', 'ss, s'], ['millisecond', 'ms'],
  ['microsecond', 'mcs'], ['nanosecond', 'ns'], ['iso_week', 'isowk, isoww'], ['tzoffset', 'tz']];
// Date parts a function rejects with 9810 whatever the date type (01 §5.3, §8; functions.js); DATEPART and DATENAME
// take all of them.
const DATEPART_REJECTS = new Map([['DATEADD', ['iso_week', 'tzoffset']], ['DATEDIFF', ['iso_week', 'tzoffset']],
  ['DATEDIFF_BIG', ['iso_week', 'tzoffset']], ['DATETRUNC', ['weekday', 'nanosecond', 'tzoffset']]]);
// Data types in the order completion offers them (every name of types.js TYPE_NAMES, 01 §5).
const TYPE_ORDER = ['int', 'bigint', 'smallint', 'tinyint', 'bit', 'decimal', 'numeric', 'money', 'smallmoney', 'float', 'real', 'date',
  'datetime', 'datetime2', 'datetimeoffset', 'smalldatetime', 'time', 'nvarchar', 'varchar', 'nchar', 'char', 'ntext', 'text',
  'uniqueidentifier', 'varbinary', 'binary', 'rowversion', 'timestamp', 'entityreference', 'sql_variant', 'xml', 'sysname', 'integer', 'dec'];
// The @@ globals (01 §7) with their card text; the first six are SQL 4 CDS's list (03 §5), @@FETCH_STATUS and
// @@CURSOR_ROWS belong to cursors.
const GLOBALS = [
  ['@@ROWCOUNT', 'The number of rows the previous statement returned, read or wrote.'],
  ['@@IDENTITY', 'The id of the last record INSERT created in this query tab, or of the last BulkDelete system job.'],
  ['@@ERROR', 'The error number of the previous statement, or 0 when it succeeded.'],
  ['@@FETCH_STATUS', 'The result of the last FETCH in this query tab: 0 after a fetched row, -1 past either end or before any FETCH.'],
  ['@@VERSION', 'The SQL Studio version and the Dataverse version of the environment.'],
  ['@@SERVERNAME', "The host name of the environment, as SERVERPROPERTY('ServerName')."],
  ['@@CURSOR_ROWS', 'The row count of the cursor opened last in this query tab; 0 when it is closed or none was opened.'],
  ['@@DATEFIRST', 'The first day of the week set with SET DATEFIRST (7 = Sunday, the default).'],
  ['@@LANGUAGE', 'The language set with SET LANGUAGE.'],
  ['@@TRANCOUNT', 'Always 0: transactions are not supported.'],
  ['@@SPID', 'Always 0.'],
];
const REQUIRED_TEXT = { None: 'Optional', SystemRequired: 'System required', ApplicationRequired: 'Business required', Recommended: 'Business recommended' };
const BEHAVIOUR_TEXT = { UserLocal: 'User local', DateOnly: 'Date only', TimeZoneIndependent: 'Time zone independent' };

// ------------------------------------------------------------------------------------------------- HINT_DOCS

const opt = s => `OPTION (${s})`;
const useHint = n => `OPTION (USE HINT('${n}'))`;
const fetchOpt = o => `Passed to Dataverse as the FetchXML query option ${o}.`;
// The text of every SQL Server hint whose parser.js HINTS row has `implemented: false` (03 §1.4, §5).
export const IGNORED_HINT_TEXT = 'Accepted; SQL Studio ignores it with a warning.';
const S4C_TEXT = 'Accepted for SQL 4 CDS scripts, where it bypasses the TDS endpoint; SQL Studio has none and ignores it with a warning.';

// SQL Studio's own hints (kind 'studio'), in the order Help and completion list them: the hints with an effect in
// SQL Studio (its own, SQL 4 CDS's and the SQL Server query hints it implements, 01 §4.1, 02 §8.1), the SQL 4 CDS
// names it accepts without one, and the table hint NOLOCK. Rows are [name, syntax, text, typed?]: `typed` = the change
// confirmation then needs the record count typed (02 §8.1). A syntax `OPTION (USE HINT('…'))` marks a HINTS row of
// kind 'useHint', `WITH (…)` one of kind 'table' and any other `OPTION (…)` one of kind 'option'.
const STUDIO_HINTS = [
  ['MAXRECURSION', opt('MAXRECURSION 100'), 'Sets how many levels a recursive CTE may recurse (default 100); 0 removes the limit, but SQL Studio stops at 32,767.'],
  ['MAXDOP', opt('MAXDOP 4'), 'Sets how many write batches run in parallel, at most 32; 0 uses the value Dataverse recommends.'],
  ['BATCH_SIZE', opt('BATCH_SIZE(100)'), 'The largest number of records per $batch request (default 50) and per CreateMultiple request (default 100), 1 to 1000; batches are sized to take about 10 s each.'],
  ['HASH GROUP', opt('HASH GROUP'), 'Aggregates in the browser: skips the FetchXML aggregate and its createdon partitions, as SQL 4 CDS uses this hint to force in-memory aggregation.'],
  ['FORCE ORDER', opt('FORCE ORDER'), fetchOpt('ForceOrder')],
  ['RECOMPILE', opt('RECOMPILE'), fetchOpt('Recompile')],
  ['OPTIMIZE FOR UNKNOWN', opt('OPTIMIZE FOR UNKNOWN'), fetchOpt('OptimizeForUnknown')],
  ['LOOP JOIN', opt('LOOP JOIN'), fetchOpt('LoopJoin')],
  ['MERGE JOIN', opt('MERGE JOIN'), fetchOpt('MergeJoin')],
  ['HASH JOIN', opt('HASH JOIN'), fetchOpt('HashJoin')],
  ['NO_PERFORMANCE_SPOOL', opt('NO_PERFORMANCE_SPOOL'), 'Passed to Dataverse as the FetchXML query option NO_PERFORMANCE_SPOOL; SQL Studio keeps its own spools.'],
  ['BYPASS_CUSTOM_PLUGIN_EXECUTION', useHint('BYPASS_CUSTOM_PLUGIN_EXECUTION'), 'Writes skip custom synchronous plug-ins (MSCRM.BypassCustomPluginExecution); needs the privilege for it.', true],
  ['BYPASS_BUSINESS_LOGIC_EXECUTION', useHint('BYPASS_BUSINESS_LOGIC_EXECUTION'), 'Writes skip custom synchronous and asynchronous logic (MSCRM.BypassBusinessLogicExecution); needs the privilege for it.', true],
  ['SUPPRESS_DUPLICATE_DETECTION', useHint('SUPPRESS_DUPLICATE_DETECTION'), 'Writes skip the duplicate detection rules (MSCRM.SuppressDuplicateDetection).'],
  ['SUPPRESS_FLOWS', useHint('SUPPRESS_FLOWS'), 'Writes do not trigger cloud flows (MSCRM.SuppressCallbackRegistrationExpanderJob).'],
  ['CONTINUE_ON_ERROR', useHint('CONTINUE_ON_ERROR'), 'Keeps starting new write batches after a batch had failures; without it no new batch starts after a failure.'],
  ['IGNORE_DUP_KEY', useHint('IGNORE_DUP_KEY'), 'INSERT reports records that already exist (duplicate key) as skipped instead of failed.'],
  ['NO_MINIMAL_UPDATES', useHint('NO_MINIMAL_UPDATES'), 'UPDATE sends every SET column, also unchanged values; by default only changed columns are sent.'],
  ['MINIMAL_UPDATES', useHint('MINIMAL_UPDATES'), 'UPDATE sends only the columns whose values change and skips unchanged records; this is already the default.'],
  ['NO_DIRECT_DML', useHint('NO_DIRECT_DML'), 'Accepted for SQL 4 CDS scripts: SQL Studio always reads the records before it updates or deletes them.'],
  ['DISABLE_STATE_TRANSITIONS', useHint('DISABLE_STATE_TRANSITIONS'), 'Changes statecode and statuscode with one plain update instead of a close message such as WinOpportunity; Dataverse may reject it.'],
  ['USE_BULK_DELETE', useHint('USE_BULK_DELETE'), 'Runs a DELETE as a BulkDelete job of exactly the previewed records, without If-Match; needs one FetchXML query of a standard table. DELETE FROM audit always does.', true],
  ['RETRIEVE_TOTAL_RECORD_COUNT', useHint('RETRIEVE_TOTAL_RECORD_COUNT'), 'SELECT COUNT(*) FROM a table without WHERE or JOIN uses RetrieveTotalRecordCount: fast but approximate (a snapshot up to 24 hours old).'],
  ['DEBUG_BYPASS_OPTIMIZATION', useHint('DEBUG_BYPASS_OPTIMIZATION'), 'Runs the whole query in the browser without FetchXML pushdown (for debugging), like the setting Run everything in the browser.'],
  ['BATCH_SIZE_n', useHint('BATCH_SIZE_100'), 'The largest number of records per $batch and CreateMultiple request of a write, 1 to 1000; batches are sized to take about 10 s each. As OPTION (BATCH_SIZE(n)).'],
  ['FETCHXML_PAGE_SIZE_n', useHint('FETCHXML_PAGE_SIZE_1000'), 'Sets the FetchXML page size of reads, 1 to 5000, instead of the automatic 5000, 1000 or 500 records per page.'],
  ['FORCE_SQL_4_CDS', useHint('FORCE_SQL_4_CDS'), S4C_TEXT],
  ['FORCE_SQL4CDS', useHint('FORCE_SQL4CDS'), S4C_TEXT],
  ['USE_LEGACY_UPDATE_MESSAGES', useHint('USE_LEGACY_UPDATE_MESSAGES'), 'Accepted for SQL 4 CDS scripts; SQL Studio ignores it with a warning and keeps its own state-change rules.'],
  ['NOLOCK', 'WITH (NOLOCK)', 'Table hint: reads without locks (FetchXML no-lock), also written t (NOLOCK); no effect on results. Any other table hint is an error.'],
];
// The example argument of the SQL Server OPTION items that take one (01 §4.1 Hints); the others are written bare.
const SQLSERVER_ARGS = new Map([['FAST', 'FAST 10'], ['MAX_GRANT_PERCENT', 'MAX_GRANT_PERCENT = 10'], ['MIN_GRANT_PERCENT', 'MIN_GRANT_PERCENT = 10'],
  ['OPTIMIZE FOR', 'OPTIMIZE FOR (@p UNKNOWN)'], ['QUERYTRACEON', 'QUERYTRACEON 4199'], ['USE PLAN', "USE PLAN N'<ShowPlanXML/>'"],
  ['TABLE HINT', 'TABLE HINT (account, NOLOCK)']]);
// The SQL Server USE HINT names that reach <fetch options> (01 §4.1 fetchOptions) and their FetchXML option.
const SQLSERVER_FETCH = new Map([['DISABLE_OPTIMIZER_ROWGOAL', 'DisableRowGoal'], ['ENABLE_QUERY_OPTIMIZER_HOTFIXES', 'EnableOptimizerHotfixes'],
  ['ENABLE_HIST_AMENDMENT_FOR_ASC_KEYS', 'ENABLE_HIST_AMENDMENT_FOR_ASC_KEYS']]);

// The HINT_DOCS kind of a parser.js HINTS row (03 §1.4, §5, §8.2): 'sqlserver' for the documented SQL Server USE HINT
// names and the SQL Server query hints SQL Studio accepts without implementing them; 'studio' for every other row
// (SQL Studio's and SQL 4 CDS's hints, the SQL Server query hints SQL Studio implements, the table hint NOLOCK).
export function hintDocKind(row) {
  return row?.origin === 'sqlserver' && (row.kind === 'useHint' || (row.kind === 'option' && !row.implemented)) ? 'sqlserver' : 'studio';
}

// The 'sqlserver' rows of HINT_DOCS, made from parser.js HINTS in its order: [name, syntax, text]. The syntax is the
// USE HINT form of a USE HINT name and the OPTION item (with its example argument) of a query hint; the text is
// IGNORED_HINT_TEXT for a row with `implemented: false` and the FetchXML option of an implemented one. An
// implemented SQL Server name without a FetchXML option has no text here, so it is left out.
function sqlServerHints() {
  const out = [];
  for (const r of HINTS) {
    if (hintDocKind(r) !== 'sqlserver') continue;
    const text = !r.implemented ? IGNORED_HINT_TEXT : SQLSERVER_FETCH.has(r.name) ? fetchOpt(SQLSERVER_FETCH.get(r.name)) : null;
    if (text) out.push([r.name, r.kind === 'useHint' ? useHint(r.name) : opt(SQLSERVER_ARGS.get(r.name) ?? r.name), text]);
  }
  return out;
}

// Every hint name of parser.js HINTS documented, once and no other (01 §4.1 Hints, 00 §3): [{name, syntax, text,
// typed?, kind: 'studio'|'sqlserver'}] (03 §1.4), SQL Studio's hints first, then the SQL Server ones. Help's Query
// hints section (dialogs.js), completion after OPTION ( and USE HINT( and hover cards read it.
export const HINT_DOCS = Object.freeze([
  ...STUDIO_HINTS.map(([name, syntax, text, typed = false]) => [name, syntax, text, typed, 'studio']),
  ...sqlServerHints().map(([name, syntax, text]) => [name, syntax, text, false, 'sqlserver']),
].map(([name, syntax, text, typed, kind]) => Object.freeze(typed ? { name, syntax, text, typed: true, kind } : { name, syntax, text, kind })));

// The HINTS kind a HINT_DOCS entry documents, read from its syntax: 'useHint', 'table' or 'option'.
export function hintKind(d) {
  const s = String(d?.syntax ?? '');
  return s.startsWith("OPTION (USE HINT('") ? 'useHint' : s.startsWith('WITH (') ? 'table' : 'option';
}

let hintIndex = null;
// HINT_DOCS by name (statement hints only: an OPTION item or a USE HINT name; the table hint NOLOCK is not one).
const hintsByName = () => hintIndex ?? (hintIndex = new Map(HINT_DOCS.filter(d => hintKind(d) !== 'table').map(d => [d.name, d])));
const NOLOCK_DOC = () => HINT_DOCS.find(d => d.name === 'NOLOCK');

// The HINT_DOCS entry of a statement hint as written (an OPTION item or a USE HINT name, any case and spacing):
// 'MAXDOP', 'force order', 'BATCH_SIZE_100' (BATCH_SIZE_n), 'FETCHXML_PAGE_SIZE_2000' (FETCHXML_PAGE_SIZE_n); else null.
export function hintDoc(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!t || t.endsWith('_N')) return null;
  const exact = hintsByName().get(t);
  if (exact) return exact;
  const m = /^(BATCH_SIZE|FETCHXML_PAGE_SIZE)_\d+$/.exec(t);
  return m ? hintsByName().get(m[1] + '_n') ?? null : null;
}

// ------------------------------------------------------------------------------------------------- names

// A name as SQL text through util.sqlName (03 §1.1, §5 Accept: bare when it matches ^[A-Za-z_][A-Za-z0-9_]*$
// and is neither a reserved word nor GO, else [quoted]); a #temp name stays bare when its characters after the '#'
// are such characters; '' for an empty name (an empty quoted name names nothing, so there is nothing to insert).
export function nameSql(name) {
  const s = String(name ?? '');
  if (!s) return '';
  if (s.startsWith('#')) return TEMP_PLAIN.test(s) ? s : sqlIdent(s);
  return sqlName(s);
}

// A unique short alias for a table: the initials of its '_' parts ('new_project' -> 'np', 'contact' -> 'c'), then
// a number when that is taken, reserved or GO ('c1', 'c2', …). `used` holds lower-case names already in use.
export function uniqueAlias(table, used) {
  const parts = lower(table).replace(/^#+/, '').split('_').filter(Boolean);
  let base = parts.map(p => p[0]).join('').replace(/[^a-z0-9]/g, '') || 't';
  if (!/^[a-z]/.test(base)) base = 't' + base;
  const free = a => !used.has(a) && !RESERVED.has(a.toUpperCase()) && a !== 'go';
  let alias = base;
  for (let n = 1; !free(alias); n++) alias = base + n;
  used.add(alias);
  return alias;
}

// ------------------------------------------------------------------------------------------------- matching

// Folded text for matching (lower case, accents removed) and, when it differs in length, each character's source index.
function fold(s) {
  if (ASCII.test(s)) return { s: s.toLowerCase(), map: null };
  let out = '';
  const map = [];
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < f.length; k++) { out += f[k]; map.push(i); }
    i += ch.length;
  }
  map.push(s.length);
  return { s: out, map };
}

const NON_ALNUM = /[^\p{L}\p{N}]/gu;
const FOLD_MAX = 20000;   // texts the fold cache keeps before it starts over
let foldCache = new Map();

// The folded form of an item text (label, filter or display name), cached because the same texts are matched on
// every keystroke: {s, map} as fold() gives them, plus `starts` (word starts in s) and `flat` (s without spaces and
// punctuation), each computed on first use.
function folded(text) {
  let f = foldCache.get(text);
  if (f) return f;
  if (foldCache.size >= FOLD_MAX) foldCache = new Map();
  f = { ...fold(text), text, starts: null, flat: null };
  foldCache.set(text, f);
  return f;
}

// Word starts of a folded text, as indices in its folded string.
function foldedStarts(t) {
  if (t.starts) return t.starts;
  let starts = wordStarts(t.text);
  if (t.map) {
    const first = new Map();
    t.map.forEach((src, j) => { if (j < t.s.length && !first.has(src)) first.set(src, j); });
    starts = starts.map(i => first.get(i)).filter(j => j != null);
  }
  t.starts = starts;
  return starts;
}

// Indices (in `s`) where words start: after a separator, at a lower->upper case change and at letter/digit changes.
function wordStarts(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!ALNUM.test(c)) continue;
    const p = i ? s[i - 1] : '';
    if (!p || !ALNUM.test(p)) out.push(i);
    else if (c !== c.toLowerCase() && p === p.toLowerCase() && p !== p.toUpperCase()) out.push(i);
    else if (/\d/.test(c) !== /\d/.test(p)) out.push(i);
  }
  return out;
}

// Word-start match: q split into prefixes of successive words of s (words may be skipped); ranges or null.
function wordStartMatch(q, s, starts) {
  const ends = starts.map((st, k) => {
    let e = st;
    const lim = k + 1 < starts.length ? starts[k + 1] : s.length;
    while (e < lim && ALNUM.test(s[e])) e++;
    return e;
  });
  const memo = new Map();
  const go = (qi, wi) => {
    if (qi === q.length) return [];
    const key = qi * 4096 + wi;
    if (memo.has(key)) return memo.get(key);
    let res = null;
    for (let w = wi; w < starts.length && !res; w++) {
      const st = starts[w];
      let n = 0;
      while (qi + n < q.length && st + n < ends[w] && s[st + n] === q[qi + n]) n++;
      for (let take = n; take >= 1 && !res; take--) {
        const rest = go(qi + take, w + 1);
        if (rest) res = [[st, st + take], ...rest];
      }
    }
    memo.set(key, res);
    return res;
  };
  return go(0, 0);
}

// Subsequence match ranges (greedy, merged), or null.
function subsequence(q, s) {
  const out = [];
  let j = 0;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] !== q[j]) continue;
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1; else out.push([i, i + 1]);
    j++;
  }
  return j === q.length ? out : null;
}

// How `query` matches `text` (03 §5 ranking): {tier: 4 exact | 3 prefix | 2 word start | 1 subsequence, ranges} with
// ranges [start, end) in `text`, or null. Case and accents are ignored; `loose` (display names) also ignores spaces
// and punctuation, so 'accountnumber' matches 'Account Number' exactly.
export function matchScore(query, text, loose = false) {
  const q0 = fold(String(query ?? '')).s;
  return matchFolded(loose ? q0.replace(NON_ALNUM, '') : q0, folded(String(text ?? '')), loose);
}

// matchScore() for a folded query q (without spaces and punctuation when `loose`) and a folded() text.
function matchFolded(q, t, loose) {
  if (!q) return { tier: 0, ranges: [] };
  const back = r => (t.map ? r.map(([a, b]) => [t.map[a], t.map[b]]) : r);
  if (loose) {
    const flat = t.flat ?? (t.flat = t.s.replace(NON_ALNUM, ''));
    if (flat === q) return { tier: 4, ranges: [] };
    if (flat.startsWith(q)) return { tier: 3, ranges: [] };
  } else {
    if (t.s === q) return { tier: 4, ranges: back([[0, t.s.length]]) };
    if (t.s.startsWith(q)) return { tier: 3, ranges: back([[0, q.length]]) };
  }
  // a word-start match is also a subsequence, so a text without the subsequence is no match at all (the cheap test
  // first: most items of a long list fail it)
  const sub = subsequence(q, loose ? (t.flat ?? (t.flat = t.s.replace(NON_ALNUM, ''))) : t.s);
  if (!sub) return null;
  const ws = wordStartMatch(q, t.s, foldedStarts(t));
  if (ws) return { tier: 2, ranges: back(ws) };
  return { tier: 1, ranges: loose ? [] : back(sub) };
}

let collator = null;
// Labels compared by base letters (case and accents ignored), with one Intl.Collator created on first use: a
// localeCompare() with options builds its collator on every call, which made ranking 2,000 tables miss a frame.
const byLabel = (a, b) => (collator ?? (collator = new Intl.Collator('en', { sensitivity: 'base' }))).compare(a, b);
const byBase = (a, b) => (a.group - b.group) || (a.sort - b.sort) || byLabel(a.label, b.label);

// Filters and orders items for the typed prefix: tier (exact > prefix > word start > subsequence; display-name
// matches count), own-label matches first, then the context's group and base order. Each result has `hl`: the
// label ranges to show bold.
export function rankItems(items, prefix) {
  const p = String(prefix ?? '');
  if (!p) return items.slice().sort(byBase).map(it => ({ ...it, hl: [] }));
  const out = [];
  const q = fold(p).s, ql = q.replace(NON_ALNUM, '');
  for (const it of items) {
    const f = it.filter ?? it.label;
    const m = matchFolded(q, folded(String(f)), false);
    const a = it.alt ? matchFolded(ql, folded(String(it.alt)), true) : null;
    const own = m ? m.tier : 0;
    const tier = Math.max(own, a ? a.tier : 0);
    if (!tier) continue;
    const off = it.fo ?? 0;
    const ranges = own === tier ? m.ranges : [];
    // within a tier, a match that starts the label and has fewer pieces reads better
    const fit = ranges.length ? (ranges[0][0] === 0 ? 1 : 0) - ranges.length / 100 : 0;
    out.push({ ...it, tier, own: own === tier ? 1 : 0, fit, hl: ranges.map(([x, y]) => [x + off, y + off]) });
  }
  return out.sort((a, b) => (b.tier - a.tier) || (b.own - a.own) || (b.fit - a.fit) || byBase(a, b) || (a.label.length - b.label.length));
}

// ------------------------------------------------------------------------------------------------- lexing

const CLEAN = Object.freeze({ cmt: 0, quote: null });
// A GO line (01 §4.5): GO alone on its line (lines end at \n), with an optional count and a line comment.
const GO_LINE = /(?<![^\n])[ \t]*go(?:[ \t]+\d+)?[ \t]*(?:--.*)?\r?(?=\n|(?![\s\S]))/gi;
const CODE_SPECIAL = /--|\/\*|['"[]/g;   // what can change the lexer state in code
const CMT_SPECIAL = /\/\*|\*\//g;        // … inside a block comment (they nest)

// Lexer state after text[from, to) when it starts in `st` ({cmt, quote, line?}): block comments (nested), strings,
// quoted names and line comments (`line`: `to` lies inside a -- comment; lexer.js has no such state because a line
// comment ends with its line, so only callers that stop mid-line see it). It jumps from one state-changing character
// to the next, so long texts scan fast; the searches run on a slice of the range (plus one character, for the
// two-character sequences that start at its last character), so they never scan past it.
function scanState(text, from, to, st) {
  let cmt = st.cmt, q = st.quote, line = !!st.line;
  if (to <= from) return cmt || q || line ? { cmt, quote: q, line } : CLEAN;
  const s = text.slice(from, to + 1);
  const lim = to - from;
  let i = 0;
  if (line) {
    const nl = s.indexOf('\n');
    if (nl < 0) return { cmt: 0, quote: null, line: true };
    i = nl;
    line = false;
  }
  while (i < lim) {
    if (cmt) {
      CMT_SPECIAL.lastIndex = i;
      const m = CMT_SPECIAL.exec(s);
      if (!m || m.index >= lim) break;
      cmt += m[0] === '/*' ? 1 : -1;
      i = m.index + 2;
    } else if (q) {
      const j = s.indexOf(q, i);
      if (j < 0 || j >= lim) break;
      if (s[j + 1] === q) i = j + 2; else { q = null; i = j + 1; }
    } else {
      CODE_SPECIAL.lastIndex = i;
      const m = CODE_SPECIAL.exec(s);
      if (!m || m.index >= lim) break;
      const c = m[0];
      if (c === '--') {
        // the comment runs to the end of its line: up to `to` when that line goes on past it
        const nl = s.indexOf('\n', m.index);
        if (nl < 0) { line = true; i = lim; } else i = nl;
      } else if (c === '/*') { cmt = 1; i = m.index + 2; }
      else { q = c === '[' ? ']' : c; i = m.index + 1; }
    }
  }
  return cmt || q || line ? { cmt, quote: q, line } : CLEAN;
}

// The GO lines of the last text batchBounds() read (03 §13: in a script with thousands of GO lines a keystroke must
// not re-read every batch before the caret's): {text, gos: [[ls, le]] (GO lines outside comments and strings, in text
// order, all ending before the caret of that call)}.
let goMemo = null;

// The batch around `caret`: {start, end, go}; go = the caret is on a GO line (01 §4.5: GO alone on its line, with an
// optional count and comment, outside comments and strings). The scan resumes after the last GO line the previous
// call found before the caret when the text up to that line's end is unchanged (the lexer state after a GO line is
// clean: it is code, and a comment on it ends with the line).
export function batchBounds(text, caret) {
  const n = text.length;
  let st = CLEAN, at = 0, start = 0, gos = [];
  GO_LINE.lastIndex = 0;
  const M = goMemo;
  if (M && M.gos.length) {
    let lo = 0, hi = M.gos.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (M.gos[mid][1] < caret) lo = mid + 1; else hi = mid; }
    const le = lo > 0 ? M.gos[lo - 1][1] : n;
    if (le < n) {
      const upto = le + 1;   // through the line break after that GO line
      if (M.text === text || text.slice(0, upto) === M.text.slice(0, upto)) {
        gos = M.gos;
        gos.length = lo;
        start = at = upto;
        GO_LINE.lastIndex = upto;
      }
    }
  }
  const done = r => { goMemo = { text, gos }; return r; };
  for (let m; (m = GO_LINE.exec(text)) !== null;) {
    const ls = m.index, le = ls + m[0].length;
    st = scanState(text, at, ls, st);
    at = ls;
    if (st.cmt || st.quote) continue;
    if (caret >= ls && caret <= le) return done({ start: ls, end: le, go: true });
    if (caret < ls) return done({ start, end: ls, go: false });
    gos.push([ls, le]);
    start = Math.min(n, le + 1);
  }
  return done({ start, end: n, go: false });
}

// Where the comment, string or quoted name open in state `st` at `from` ends: {at (the offset after it, or `to`),
// closed}.
function closeAt(text, from, to, st) {
  let cmt = st.cmt;
  const q = st.quote;
  const s = text.slice(from, to + 1);
  const lim = to - from;
  let i = 0;
  while (i < lim) {
    if (cmt) {
      CMT_SPECIAL.lastIndex = i;
      const m = CMT_SPECIAL.exec(s);
      if (!m || m.index >= lim) break;
      cmt += m[0] === '/*' ? 1 : -1;
      i = m.index + 2;
      if (!cmt) return { at: from + i, closed: true };
    } else {
      const j = s.indexOf(q, i);
      if (j < 0 || j >= lim) break;
      if (s[j + 1] === q) i = j + 2; else return { at: from + j + 1, closed: true };
    }
  }
  return { at: to, closed: false };
}

// The value of an open string or quoted name token cut to text[s, e): its characters after the opening ones (N', ',
// [ or "), with the doubled closing character read as one.
function openBody(text, s, e) {
  const olen = text[s] === 'N' || text[s] === 'n' ? 2 : 1;
  const o = text[s + olen - 1];
  const q = o === '[' ? ']' : o;
  return text.slice(Math.min(e, s + olen), e).split(q + q).join(q);
}

// keepAll tokens of text[start, end) with absolute offsets, starting in lexer state `st`: a comment, string or quoted
// name open at `start` is one token (as tokenize() gives it, without its opening characters; flagged `cont`, its
// opening characters lie before the range), the rest is tokenized. With `qi` false (SET QUOTED_IDENTIFIER OFF, 01 §4.1)
// a `"…"` is a string literal, so its token is a 'str' (the span is the same in both modes; only [ ] then quotes
// a name).
function lexRange(text, start, end, st, qi = true) {
  const out = [];
  let i = start;
  if ((st.cmt || st.quote) && i < end) {
    const c = closeAt(text, i, end, st);
    const raw = text.slice(i, c.at);
    const body = c.closed && st.quote ? raw.slice(0, -1) : raw;
    const v = st.cmt ? raw : body.split(st.quote + st.quote).join(st.quote);
    out.push({ t: st.cmt ? 'cmt' : st.quote === "'" || (st.quote === '"' && !qi) ? 'str' : 'qid', v, s: i, e: c.at, open: !c.closed, cont: true });
    i = c.at;
  }
  if (i < end) {
    const toks = tokenize(text.slice(i, end), true);
    toks.pop();
    for (const t of toks) {
      t.s += i;
      t.e += i;
      if (!qi && t.t === 'qid' && text[t.s] === '"') t.t = 'str';
      out.push(t);
    }
  }
  return out;
}

// Splits significant tokens into statements [{a, b, kind}] (token index ranges), tolerant of missing semicolons:
// statement keywords at parenthesis depth 0 start a new statement unless they continue the current one (UNION
// SELECT, INSERT … SELECT, WITH … SELECT, UPDATE … SET, OFFSET … FETCH); CASE … END (and its ELSE) is not a statement
// end, and a statement keyword that can never be parenthesised closes any unclosed '('.
function segment(sig) {
  const out = [];
  let cur = null, depth = 0, cases = 0;
  const close = i => { if (cur) { cur.b = i; out.push(cur); cur = null; } };
  const open = (i, kind) => { cur = { a: i, b: i, kind, main: null, hasSet: false, sel: false }; };
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    const k = t.t === 'id' ? t.k : null;
    if (t.t === 'op' && t.v === ';') { close(i); depth = 0; cases = 0; continue; }
    if (depth > 0 && k && STRONG_KW.has(k)) { close(i); depth = 0; cases = 0; open(i, k); continue; }
    if (t.t === 'op' && t.v === '(') { if (!cur) open(i, 'EXPR'); depth++; continue; }
    if (t.t === 'op' && t.v === ')') { if (depth) depth--; continue; }
    if (depth > 0) continue;
    if (k === 'CASE') cases++;
    else if (k === 'END' && cases > 0) { cases--; continue; }
    if (k && !(cases > 0 && k === 'ELSE') && startsStatement(sig, i, k, cur)) { close(i); cases = 0; open(i, k); continue; }
    if (!cur) open(i, k && STMT_KW.has(k) ? k : 'EXPR');
  }
  close(sig.length);
  return out;
}

function startsStatement(sig, i, k, cur) {
  if (!STMT_KW.has(k)) return false;
  const p = sig[i - 1];
  const pk = p && p.t === 'id' ? p.k : null;
  if (!cur) return true;
  switch (k) {
    case 'SELECT':
      if (pk === 'UNION' || pk === 'ALL' || pk === 'EXCEPT' || pk === 'INTERSECT') return false;
      if ((cur.kind === 'INSERT' || cur.main === 'INSERT') && !cur.sel) { cur.sel = true; return false; }
      if (cur.kind === 'WITH' && !cur.main) { cur.main = k; return false; }
      return true;
    case 'INSERT': case 'UPDATE': case 'DELETE': case 'MERGE':
      if (cur.kind === 'WITH' && !cur.main) { cur.main = k; return false; }
      // ON DELETE / ON UPDATE (a foreign key) and FOR UPDATE continue the statement; the ON or OFF value of a SET
      // option (`SET NOCOUNT ON` on the line before) ends it (01 §4.1 SET options)
      if (pk === 'FOR' || (pk === 'ON' && cur.kind !== 'SET')) return false;
      return true;
    case 'SET':
      if ((cur.kind === 'UPDATE' || cur.main === 'UPDATE') && !cur.hasSet) { cur.hasSet = true; return false; }
      if (pk === 'DELETE' || pk === 'UPDATE') return false;   // ON DELETE SET NULL
      return true;
    case 'WITH': {
      const n = sig[i + 1], n2 = sig[i + 2];
      if (!n || (n.t !== 'id' && n.t !== 'qid')) return false;
      if (n.t === 'id' && (RESERVED.has(n.k) || n.k === 'TIES' || n.k === 'ROLLUP' || n.k === 'CUBE' || n.k === 'NOLOCK')) return false;
      return !!n2 && ((n2.t === 'id' && n2.k === 'AS') || (n2.t === 'op' && n2.v === '('));
    }
    case 'FETCH': return !(pk === 'ROWS' || pk === 'ROW');
    case 'IF': return pk !== 'TABLE';   // DROP TABLE IF EXISTS
    case 'EXEC': case 'EXECUTE': return !((cur.kind === 'INSERT' || cur.main === 'INSERT') && !cur.sel);
    default: return true;
  }
}

// Matching parenthesis index for every '(' and ')' of sig (-1 when unbalanced), reset at each statement.
function pairUp(sig, stmts) {
  const m = new Int32Array(sig.length).fill(-1);
  for (const st of stmts) {
    const stack = [];
    for (let i = st.a; i < st.b; i++) {
      const t = sig[i];
      if (t.t !== 'op') continue;
      if (t.v === '(') stack.push(i);
      else if (t.v === ')' && stack.length) { const o = stack.pop(); m[o] = i; m[i] = o; }
    }
  }
  return m;
}

// Lexes text[ws, we) of the batch b, starting in lexer state st: {toks, sig, stmts, match, start, end, safeA, safeB}.
// [safeA, safeB] are the carets whose statement lies wholly inside the window: a window that cuts the batch may cut
// its first and last statements. qi: the QUOTED_IDENTIFIER mode (lexRange).
function lexSpan(text, b, ws, we, st, qi) {
  const toks = lexRange(text, ws, we, st, qi);
  const sig = toks.filter(t => t.t !== 'ws' && t.t !== 'cmt');
  const stmts = segment(sig);
  let safeA = ws, safeB = we;
  if (ws > b.start) safeA = stmts.length > 1 ? sig[stmts[1].a].s + 1 : Infinity;
  if (we < b.end) safeB = stmts.length > 1 ? sig[stmts[stmts.length - 1].a].s : -1;
  return { toks, sig, stmts, match: pairUp(sig, stmts), start: ws, end: we, safeA, safeB };
}

// One DECLARE or CREATE (TABLE #t) at offset s, before the analysis window, lexed from s only as far as its
// statement goes: the rest of its line, then 4 times as much while the declaration or column list goes on, at most
// STMT_MAX and never past `limit` (the end of the batch). A declaration that goes on into the window is so read whole
// (the window holds the rest without its DECLARE). st is the lexer state at s (kept so a later scan can resume
// there). qi: the QUOTED_IDENTIFIER mode (lexRange). Returns {s, st, e (end of the lexed text), vars, temps, cursors}.
function prescanStatement(text, s, limit, st, qi) {
  for (let len = 0; ; ) {
    const nl = text.indexOf('\n', Math.min(limit, s + len));
    const end = nl < 0 || nl > limit ? limit : nl;
    const sig = lexRange(text, s, end, CLEAN, qi).filter(t => t.t !== 'ws' && t.t !== 'cmt');
    const match = pairUp(sig, [{ a: 0, b: sig.length }]);
    const vars = [], temps = new Map(), cursors = [];
    let k;
    if (!isKw(sig[0], 'DECLARE')) k = parseCreateTemp(sig, 0, match, temps);
    else if (isName(sig[1])) k = parseCursorDecl(sig, 0, cursors);   // DECLARE c … CURSOR: complete once CURSOR is read
    else k = parseDeclare(sig, 0, sig.length, match, vars);
    // a statement that reaches the end of the slice may go on: lex a longer slice
    if (k >= sig.length && end < limit && end - s < STMT_MAX) { len = Math.min(STMT_MAX, Math.max(256, (end - s) * 4)); continue; }
    return { s, st, e: end, vars, temps, cursors, labels: [], marks: [] };
  }
}

// DECLARE / CREATE keywords, BEGIN TRY / END TRY / BEGIN CATCH / END CATCH (the scopes GOTO may not jump into;
// whitespace and comments may separate their words), and label definitions (a name and ':', not '::'), searched
// before the window.
const DECL_RE = /\b(?:declare|create)\b|\b(?:begin|end)(?:[ \t\r\n]|\/\*[^]*?\*\/|--[^\n]*\n)+(?:try|catch)\b|\b[A-Za-z_][A-Za-z0-9_]*[ \t]*:(?!:)/gi;
const LABEL_RE = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*:$/;
const MARK_RE = /^(begin|end)\b[^]*\b(try|catch)$/i;
const RESCAN = 512;   // how far before the end of an unchanged text a resumed scan starts at most
// The scan of the last text (03 §13: a keystroke after the window must not re-read the batch before it):
// {text, from, to, qi, entries (prescanStatement results in text order), end: {at, st, next} (where the scan stopped:
// the last DECLARE/CREATE looked at, the lexer state there and where the search goes on)}.
let preMemo = null;

// DECLAREd variables, cursors, CREATE TABLE #temps, labels and TRY / CATCH scope marks of the statements that start in
// text[from, to) (the part of a batch before the analysis window; `limit` is the end of the batch), each statement
// lexed on its own: {vars, temps, cursors, labels, marks: [{s, open (BEGIN TRY / BEGIN CATCH, else END …)}]}.
// Keywords inside comments (also line comments), strings and quoted names are skipped. The scan of the previous call
// is reused for what it read of an unchanged text[from, to): every statement whose lexed text lies there, and the
// position and lexer state where it went on (in the same QUOTED_IDENTIFIER mode, qi).
function prescan(text, from, to, limit, qi) {
  const M = preMemo;
  const entries = [];
  let at = from, st = CLEAN, next = from;
  const common = M ? Math.min(M.to, to) : 0;
  if (M && M.from === from && M.qi === qi && (M.text === text || text.slice(from, common) === M.text.slice(from, common))) {
    // keep each statement lexed wholly inside the unchanged text; resume the scan at the first one that must be read
    // again (when its state is known), else where the last scan stopped (when that is inside the unchanged text),
    // else after the last statement kept
    let resume = null, all = true;
    for (const en of M.entries) {
      if (en.e <= common) { entries.push(en); continue; }
      all = false;
      if (en.s < common) resume = { at: en.s, st: en.st, next: en.s };
      break;
    }
    // where the last scan stopped: it found no keyword after its last one up to its end (M.to), so the search goes on
    // only where the text may differ, from the line before the end of the unchanged part (a match that the end cuts,
    // a label name or BEGIN and TRY on two lines, starts there; at most RESCAN characters back, so a long line is not
    // read again), and a keystroke after the window never re-reads the batch before it (03 §13)
    if (!resume && all && M.end.at < common) {
      const ls = common > 0 ? text.lastIndexOf('\n', common - 1) : -1;
      const prev = ls > 0 ? text.lastIndexOf('\n', ls - 1) + 1 : 0;
      resume = { ...M.end, next: Math.max(M.end.next, prev, common - RESCAN) };
    }
    if (!resume && entries.length) { const l = entries[entries.length - 1]; resume = { at: l.s, st: l.st, next: l.s + 1 }; }
    if (resume) ({ at, st, next } = resume);
  }
  // the search runs on text[0, to) only, so it never reads on to the end of a long text after the window start
  const hay = to < text.length ? text.slice(0, to) : text;
  DECL_RE.lastIndex = next;
  for (let m; (m = DECL_RE.exec(hay)) !== null;) {
    st = scanState(text, at, m.index, st);
    at = m.index;
    next = m.index + 1;
    if (st.cmt || st.quote || st.line || (m.index > 0 && IDENT_CH.test(text[m.index - 1]))) continue;
    const entry = (labels, marks) => ({ s: m.index, st, e: m.index + m[0].length, vars: [], temps: new Map(), cursors: [], labels, marks });
    const mk = MARK_RE.exec(m[0]);
    if (mk) {
      // BEGIN TRY / BEGIN CATCH open a scope, END TRY / END CATCH close it
      entries.push(entry([], [{ s: m.index, open: lower(mk[1]) === 'begin' }]));
      continue;
    }
    const lb = LABEL_RE.exec(m[0]);
    if (lb) {
      // a label definition: its name is no keyword, and the ':' is not one of '::'
      if (!RESERVED.has(lb[1].toUpperCase()) && text[m.index - 1] !== '.') entries.push(entry([{ name: lb[1], s: m.index }], []));
      continue;
    }
    entries.push(prescanStatement(text, m.index, limit, st, qi));
  }
  preMemo = { text, from, to, qi, entries, end: { at, st, next } };
  const vars = [], temps = new Map(), cursors = [], labels = [], marks = [];
  for (const en of entries) {
    for (const v of en.vars) vars.push(v);
    for (const [n, d] of en.temps) temps.set(n, d);
    for (const c of en.cursors) cursors.push(c);
    for (const l of en.labels) labels.push(l);
    for (const x of en.marks) marks.push(x);
  }
  return { vars, temps, cursors, labels, marks };
}

// DECLARE / DEALLOCATE keywords, searched in the batches before the analysed one.
const CURSOR_RE = /\b(?:declare|deallocate)\b/gi;
// The cursors of the last earlierCursors() call: {text, end, qi, list}.
let curMemo = null;

// The GLOBAL cursors the batches before `end` (the start of the analysed batch) leave declared (00 §2 Cursors, 01 §4.1):
// a cursor declared without LOCAL is GLOBAL and outlives GO until DEALLOCATE (or the end of the session); a LOCAL
// one ends with its batch. `DEALLOCATE c` names the batch's LOCAL c when there is one, `DEALLOCATE GLOBAL c` always the
// global one. [{name, pre, post, options, s}] in declaration order; keywords inside comments, strings and quoted names
// are skipped. The result is reused while text[0, end) is unchanged (03 §13).
function earlierCursors(text, end, qi) {
  if (!(end > 0)) return [];
  const M = curMemo;
  if (M && M.end === end && M.qi === qi && (M.text === text || text.slice(0, end) === M.text.slice(0, end))) { M.text = text; return M.list; }
  const hay = text.slice(0, end);
  // the GO lines before `end` (01 §4.5) split it into batches
  const gos = [];
  let gst = CLEAN, gat = 0;
  GO_LINE.lastIndex = 0;
  for (let m; (m = GO_LINE.exec(hay)) !== null;) {
    gst = scanState(text, gat, m.index, gst);
    gat = m.index;
    if (!gst.cmt && !gst.quote) gos.push(m.index);
  }
  const live = new Map();
  let locals = new Set(), gi = 0, st = CLEAN, at = 0;
  CURSOR_RE.lastIndex = 0;
  for (let m; (m = CURSOR_RE.exec(hay)) !== null;) {
    while (gi < gos.length && gos[gi] < m.index) { gi++; locals = new Set(); }
    st = scanState(text, at, m.index, st);
    at = m.index;
    if (st.cmt || st.quote || st.line || (m.index > 0 && IDENT_CH.test(text[m.index - 1]))) continue;
    if (m[0].length === 7) {
      // DECLARE c [INSENSITIVE] [SCROLL] CURSOR [options]
      for (const c of prescanStatement(text, m.index, end, st, qi).cursors) {
        if (c.options.includes('LOCAL')) locals.add(lower(c.name)); else live.set(lower(c.name), c);
      }
      continue;
    }
    // DEALLOCATE [GLOBAL] c
    const nl = text.indexOf('\n', m.index);
    const sig = lexRange(text, m.index, nl < 0 || nl > end ? end : nl, CLEAN, qi).filter(t => t.t !== 'ws' && t.t !== 'cmt');
    const global = isKw(sig[1], 'GLOBAL') && isName(sig[2]);
    const n = sig[global ? 2 : 1];
    if (!isName(n) || !n.v) continue;
    const key = lower(n.v);
    if (!global && locals.has(key)) locals.delete(key); else live.delete(key);
  }
  const list = [...live.values()].sort((a, b) => a.s - b.s);
  curMemo = { text, end, qi, list };
  return list;
}

// The lexer state at the start of the last analysis window (03 §13: a keystroke must not re-read the batch before the
// window): {text, from (the batch start), at (a line start), st}.
let stateMemo = null;

// The lexer state at `pos` of the batch that starts at `from`: a line start, a position right after a whitespace
// character or the start of a ';' in code (boundaryBefore). The scan resumes where the previous call stopped while the
// text before that point is unchanged: such a position splits no token and no two-character sequence ('', */, --),
// so the state there is the one a scan from `from` gives.
function stateAt(text, from, pos) {
  const M = stateMemo;
  let at = from, st = CLEAN;
  if (M && M.from === from && M.at > from && M.at <= pos && (M.text === text || text.slice(from, M.at) === M.text.slice(from, M.at))) {
    at = M.at;
    st = M.st;
  }
  st = scanState(text, at, pos, st);
  stateMemo = { text, from, at: pos, st };
  return st;
}

const CUT_SCAN = 4096;   // how far a window boundary inside a long line is searched for a token boundary
const WS_CH = /[ \t\n\r\f\v ﻿]/;   // lexer.js whitespace
const WS_OR_SEMI = /[ \t\n\r\f\v ﻿;]/;

// A token boundary at or before `pos` in code, for a window start inside a line longer than the window (03 §13: a batch
// written on one line must not be lexed whole on every keystroke): the end of the last whitespace token, or the start
// of the last ';', in the text from about CUT_SCAN characters before `pos`, lexed from the lexer state there (a scan
// starts right after a whitespace character, so it splits no token and no two-character sequence such as '' or */);
// -1 when there is none (a long string, comment or name).
function boundaryBefore(text, from, pos) {
  let cs = from;
  if (pos - CUT_SCAN > from) {
    cs = -1;
    for (let k = pos - CUT_SCAN, lim = Math.max(from, pos - 2 * CUT_SCAN); k > lim && cs < 0; k--) if (WS_CH.test(text[k - 1])) cs = k;
    if (cs < 0) return -1;
  }
  const toks = lexRange(text, cs, pos, cs > from ? stateAt(text, from, cs) : CLEAN);
  for (let k = toks.length - 1; k >= 0; k--) {
    const t = toks[k];
    if (t.t === 'ws') return t.e;
    if (t.t === 'op' && t.v === ';') return t.s;
  }
  return -1;
}

// A window end at or after `pos`, before `lim`, inside a line longer than the window: the first whitespace or ';' in the
// CUT_SCAN characters from `pos` (a window end never needs the lexer state: a token it cuts is the last one, of a
// statement outside the window's safe range), else `lim`.
function boundaryAfter(text, pos, lim) {
  const m = WS_OR_SEMI.exec(text.slice(pos, Math.min(lim, pos + CUT_SCAN)));
  return m ? pos + m.index : lim;
}

// Lexes the batch (or an analysis window of a large batch) around `caret`: {toks, sig, stmts, match, start, end, go,
// clipped, safeA, safeB, pre, qi, batchStart}. toks keeps whitespace and comments; sig holds the significant tokens. A batch above
// WHOLE_MAX is lexed in a window of whole lines around the caret, 16 KB first and doubled up to WINDOW_MAX until the
// caret's statement lies wholly inside it; a line longer than the window is cut at a token boundary instead; the
// DECLAREs and CREATE TABLEs before the window are read by prescan() into `pre`. opts.quotedIdentifier false (the
// query tab's SET QUOTED_IDENTIFIER OFF, 01 §4.1) lexes `"…"` as a string literal, as parse() reads it; `qi`
// records the mode.
export function lexWindow(text, caret, { quotedIdentifier = true } = {}) {
  const qi = quotedIdentifier !== false;
  const b = batchBounds(text, caret);
  if (b.go) return { toks: [], sig: [], stmts: [], match: new Int32Array(0), start: b.start, end: b.end, go: true, clipped: false, safeA: b.start, safeB: b.end, pre: null, qi, batchStart: b.start };
  if (b.end - b.start <= WHOLE_MAX) return { ...lexSpan(text, b, b.start, b.end, CLEAN, qi), go: false, clipped: false, pre: null, qi, batchStart: b.start };
  let L = null;
  for (let half = WINDOW_MIN / 2; ; half *= 2) {
    const w0 = Math.max(b.start, caret - half), w1 = Math.min(b.end, caret + half);
    let ws = w0 === b.start ? b.start : Math.max(b.start, text.lastIndexOf('\n', w0 - 1) + 1);
    if (w0 - ws > half) { const cut = boundaryBefore(text, b.start, w0); if (cut > ws) ws = cut; }
    const nl = text.indexOf('\n', w1);
    let we = w1 >= b.end || nl < 0 ? b.end : Math.min(b.end, nl);
    if (we - w1 > half) we = boundaryAfter(text, w1, we);
    const st = ws > b.start ? stateAt(text, b.start, ws) : CLEAN;
    L = { ...lexSpan(text, b, ws, we, st, qi), go: false, clipped: ws > b.start || we < b.end, pre: null, qi, batchStart: b.start };
    if ((caret >= L.safeA && caret <= L.safeB) || half * 2 >= WINDOW_MAX) break;
  }
  if (L.start > b.start) L.pre = prescan(text, b.start, L.start, b.end, qi);
  return L;
}

// The QUOTED_IDENTIFIER mode of an options object of analyze(), callAt(), signatureAt() and hoverAt(): false
// only for `quotedIdentifier: false`, or, when the option is left out, for a lexWindow() result `lex` made in that mode.
const qiOf = o => !(o && (o.quotedIdentifier === false || (o.quotedIdentifier === undefined && !!o.lex && o.lex.qi === false)));

// Whether a lexWindow() result can analyse `pos` of `text` (the same text and QUOTED_IDENTIFIER mode, and pos in its
// safe range).
const fits = (L, text, pos, qi = true) => !!L && L.text === text && L.qi === qi && !L.go && pos >= L.safeA && pos <= L.safeB;

// ------------------------------------------------------------------------------------------------- token helpers

const isOp = (t, v) => !!t && t.t === 'op' && t.v === v;
const isKw = (t, k) => !!t && t.t === 'id' && t.k === k;
const kwOf = t => (t && t.t === 'id' ? t.k : null);
const isName = t => !!t && (t.t === 'id' || t.t === 'qid');
const nameText = t => (t.t === 'var' ? (t.raw ?? t.v) : t.v);

// First index in the sorted token array whose start is >= pos.
function firstAt(arr, pos) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].s < pos) lo = m + 1; else hi = m; }
  return lo;
}

// A dotted name chain ending at sig index j (`a.b.c`, also #temp, @table and [quoted] parts): {parts, a, b} or null.
function chainEndingAt(sig, j) {
  const t = sig[j];
  if (!t || !(isName(t) || t.t === 'var')) return null;
  const parts = [nameText(t)];
  let a = j;
  while (isOp(sig[a - 1], '.') && (isName(sig[a - 2]) || sig[a - 2]?.t === 'var')) { parts.unshift(nameText(sig[a - 2])); a -= 2; }
  return { parts, a, b: j };
}

// A dotted name chain starting at sig index i: {parts, a, b (last index)} or null.
function chainAt(sig, i, end) {
  const t = sig[i];
  if (!t || !(isName(t) || t.t === 'var') || i >= end) return null;
  const parts = [nameText(t)];
  let b = i;
  while (b + 2 < end && isOp(sig[b + 1], '.') && isName(sig[b + 2])) { parts.push(nameText(sig[b + 2])); b += 2; }
  return { parts, a: i, b };
}

// 1-based line number of an offset.
function lineOf(text, off) {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < off; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

// ------------------------------------------------------------------------------------------------- structure

const SUBQ = t => isKw(t, 'SELECT') || isKw(t, 'WITH');

// Text of tokens [a, b) rebuilt with SQL spacing ('decimal(10, 2)', 'nvarchar(max)').
function tokText(sig, a, b) {
  let out = '';
  for (let k = a; k < b; k++) {
    const t = sig[k];
    const v = t.t === 'num' ? (t.raw ?? String(t.v)) : t.t === 'qid' ? (t.v ? sqlIdent(t.v) : '[]') : t.t === 'var' ? (t.raw ?? t.v) : t.t === 'str' ? sqlStr(t.v) : String(t.v);
    const p = k > a ? sig[k - 1] : null;
    if (p && !(isOp(t, '(') || isOp(t, ')') || isOp(t, ',') || isOp(t, '.') || isOp(p, '(') || isOp(p, '.'))) out += ' ';
    out += v;
  }
  return out;
}

// Names (identifiers) at depth 0 of [a, b), separated by ','; an empty quoted name ([]) names nothing.
function namesIn(sig, a, b) {
  const out = [];
  let expect = true;
  for (let k = a; k < b; k++) {
    const t = sig[k];
    if (isOp(t, ',')) { expect = true; continue; }
    if (expect && isName(t) && t.v) out.push(t.v);
    expect = false;
  }
  return out;
}

// Column definitions in [a, b) (CREATE TABLE, DECLARE @t TABLE, OPENJSON WITH): [{name, type}].
function columnDefs(sig, a, b, match) {
  const out = [];
  let k = a;
  while (k < b) {
    let e = k;
    while (e < b && !isOp(sig[e], ',')) { if (isOp(sig[e], '(') && match[e] >= 0) e = Math.min(match[e], b); e++; }
    const n = sig[k];
    const kn = kwOf(n);
    if (isName(n) && n.v && !(kn && (kn === 'PRIMARY' || kn === 'CONSTRAINT' || kn === 'UNIQUE' || kn === 'CHECK' || kn === 'FOREIGN' || kn === 'INDEX'))) {
      let te = k + 1;
      if (te < e && sig[te].t === 'id') {
        te++;
        if (isOp(sig[te], '(') && match[te] >= 0 && match[te] < e) te = match[te] + 1;
      }
      out.push({ name: n.v, type: te > k + 1 ? lower(tokText(sig, k + 1, te)) : '' });
    }
    k = e + 1;
  }
  return out;
}

const isHintParen = (sig, k) => isOp(sig[k], '(') && sig[k + 1]?.t === 'id' && TABLE_HINT_WORDS.has(sig[k + 1].k) && (isOp(sig[k + 2], ')') || isOp(sig[k + 2], ','));

// Skips table hints after a table source: WITH (NOLOCK) and the old (NOLOCK) form.
function skipTableHints(sig, k, end, match) {
  for (;;) {
    if (isKw(sig[k], 'WITH') && isOp(sig[k + 1], '(') && !SUBQ(sig[k + 2])) { const m = match[k + 1]; k = (m >= 0 ? m : end) + 1; continue; }
    if (isHintParen(sig, k)) { const m = match[k]; k = (m >= 0 ? m : end) + 1; continue; }
    return k;
  }
}

// Join keywords at i: {text, next} for JOIN, INNER/LEFT/RIGHT/FULL [OUTER] [LOOP/HASH/MERGE] JOIN, CROSS JOIN,
// CROSS APPLY and OUTER APPLY, else null.
function joinAt(sig, i) {
  const k0 = kwOf(sig[i]);
  if (!k0 || !JOIN_START.has(k0)) return null;
  if (k0 === 'CROSS' || (k0 === 'OUTER' && isKw(sig[i + 1], 'APPLY'))) {
    const k1 = kwOf(sig[i + 1]);
    return k1 === 'APPLY' || (k0 === 'CROSS' && k1 === 'JOIN') ? { text: `${k0} ${k1}`, next: i + 2 } : null;
  }
  const words = [];
  for (let j = i; j < sig.length; j++) {
    const k = kwOf(sig[j]);
    if (k === 'JOIN') { words.push(k); return { text: words.join(' '), next: j + 1 }; }
    if (k === 'INNER' || k === 'LEFT' || k === 'RIGHT' || k === 'FULL' || k === 'OUTER' || k === 'LOOP' || k === 'HASH' || k === 'MERGE') { words.push(k); continue; }
    return null;
  }
  return null;
}

// Source kind for a name chain: tvar, temp, meta, archive, bin, cte or table.
function classify(parts, isVar, ctes) {
  const last = parts[parts.length - 1];
  const schema = parts.length > 1 ? lower(parts[parts.length - 2]) : null;
  if (isVar) return { kind: 'tvar', name: lower(last), schema: null };
  if (parts.length === 1 && last.startsWith('#')) return { kind: 'temp', name: last, schema: null };
  if (schema === 'metadata') return { kind: 'meta', name: lower(last), schema };
  if (schema === 'sys' && parts.length === 2) return { kind: 'sys', name: lower(last), schema };
  if (schema === 'archive' || schema === 'bin') return { kind: schema, name: last, schema };
  if (parts.length === 1 && ctes.has(lower(last))) return { kind: 'cte', name: last, schema: null };
  return { kind: 'table', name: last, schema };
}

// A name token that can be an alias: an identifier that is not reserved (nor APPLY, which follows CROSS / OUTER), or
// a [quoted] name.
const aliasName = t => isName(t) && !(t.t === 'id' && (RESERVED.has(t.k) || t.k === 'APPLY'));

// One table source at i: {list, next} or null. Derived tables, VALUES, parenthesised joins, TVFs (with OPENJSON
// WITH columns), table hints and aliases (with an optional column list) are understood. Each source records `endAt`
// (the index of its own last token: the name, or the ')' of a call, derived table or OPENJSON WITH list) and
// `aliasTok` (the index of the token written as its alias, also an empty [] that names nothing): the alias position
// of 03 §5.
function parseSource(sig, i, end, match, ctes) {
  const t = sig[i];
  if (!t || i >= end) return null;
  let src, k;
  if (isOp(t, '(')) {
    const j = match[i] >= 0 ? Math.min(match[i], end) : end;
    const f = kwOf(sig[i + 1]);
    if (f === 'SELECT' || f === 'WITH') src = { kind: 'derived', name: null, a: i + 1, b: j };
    else if (f === 'VALUES') src = { kind: 'values', name: null, a: i + 1, b: j };
    else return { list: parseFromList(sig, i + 1, j, match, ctes).sources, next: j + 1 };
    src.s = t.s;
    src.e = sig[Math.min(j, sig.length - 1)].e;
    src.endAt = j;
    k = j + 1;
  } else {
    if (t.t === 'id' && RESERVED.has(t.k)) return null;
    const ch = chainAt(sig, i, end);
    if (!ch) return null;
    src = { ...classify(ch.parts, t.t === 'var', ctes), parts: ch.parts, s: t.s, e: sig[ch.b].e, nameA: ch.a, nameB: ch.b, endAt: ch.b };
    k = ch.b + 1;
    // a call: a TVF, a Web API function or a method of an xml value (`@x.nodes('…')`, `t.c.nodes('…')`)
    if (isOp(sig[k], '(') && (src.kind !== 'tvar' || ch.parts.length > 1) && !isHintParen(sig, k)) {
      const j = match[k] >= 0 ? Math.min(match[k], end) : end;
      src.kind = 'tvf';
      src.args = { a: k + 1, b: j };
      src.e = sig[Math.min(j, sig.length - 1)].e;
      src.endAt = j;
      k = j + 1;
      if (isKw(sig[k], 'WITH') && isOp(sig[k + 1], '(') && !SUBQ(sig[k + 2])) {
        const j2 = match[k + 1] >= 0 ? Math.min(match[k + 1], end) : end;
        src.withCols = columnDefs(sig, k + 2, j2, match);
        src.endAt = j2;
        k = j2 + 1;
      }
    }
  }
  k = skipTableHints(sig, k, end, match);
  // an empty quoted alias ([] while typing) is read past but names nothing
  if (isKw(sig[k], 'AS') && aliasName(sig[k + 1])) { src.aliasTok = k + 1; if (sig[k + 1].v) { src.alias = sig[k + 1].v; src.aliasAt = k + 1; } k += 2; }
  else if (aliasName(sig[k])) { src.aliasTok = k; if (sig[k].v) { src.alias = sig[k].v; src.aliasAt = k; } k++; }
  if ((src.kind === 'derived' || src.kind === 'values' || src.kind === 'tvf') && src.alias && isOp(sig[k], '(')) {
    const j = match[k] >= 0 ? Math.min(match[k], end) : end;
    src.cols = namesIn(sig, k + 1, j);
    k = j + 1;
  }
  return { list: [src], next: skipTableHints(sig, k, end, match) };
}

// Skips a join condition: up to the next join keyword, ',' or clause keyword at depth 0.
function skipCondition(sig, k, end, match) {
  for (; k < end; k++) {
    const t = sig[k];
    if (isOp(t, '(')) { k = match[k] >= 0 ? Math.min(match[k], end) : end; continue; }
    if (isOp(t, ',') || joinAt(sig, k) || (t.t === 'id' && STOP_FROM.has(t.k))) return k;
  }
  return end;
}

// Table sources of a FROM list starting at i: {sources, next}; every source records how it was joined (`join`:
// null for the first, ',' or the join keywords) and where its ON is (`onAt`).
function parseFromList(sig, i, end, match, ctes) {
  const sources = [];
  let joinKw = null;
  while (i < end) {
    const r = parseSource(sig, i, end, match, ctes);
    if (!r) {
      // a source still being typed (`JOIN | JOIN b`): keep reading the list after it
      const jn = sources.length ? joinAt(sig, i) : null;
      if (jn) { joinKw = jn.text; i = jn.next; continue; }
      if (sources.length && isOp(sig[i], ',')) { joinKw = ','; i++; continue; }
      break;
    }
    for (const s of r.list) { if (s.join === undefined) s.join = joinKw; s.fromList = true; sources.push(s); }
    i = r.next;
    while ((isKw(sig[i], 'PIVOT') || isKw(sig[i], 'UNPIVOT')) && isOp(sig[i + 1], '(')) {
      const j = match[i + 1] >= 0 ? Math.min(match[i + 1], end) : end;
      // the pivot's own alias position follows its ')' (03 §5), also before an AS
      const pv = { kind: 'pivot', name: null, alias: null, s: sig[i].s, e: sig[Math.min(j, sig.length - 1)].e, endAt: j, join: null, fromList: true };
      i = j + 1;
      if (isKw(sig[i], 'AS') && aliasName(sig[i + 1])) i++;
      if (aliasName(sig[i])) {
        pv.aliasTok = i;
        if (sig[i].v) { pv.alias = sig[i].v; pv.aliasAt = i; }
        i++;
      }
      sources.push(pv);
    }
    if (isKw(sig[i], 'ON') && sources.length) { sources[sources.length - 1].onAt = i; i = skipCondition(sig, i + 1, end, match); }
    if (isOp(sig[i], ',')) { joinKw = ','; i++; continue; }
    const j = joinAt(sig, i);
    if (j) { joinKw = j.text; i = j.next; continue; }
    break;
  }
  return { sources, next: i };
}

// The reference name of a source (its alias, else its table name), lower case.
const refOf = s => lower(s.alias || s.name || '');

// Query segments of the block [a, b): split at SELECT / INSERT / UPDATE / DELETE at block depth.
function segmentsOf(sig, a, b, match) {
  const starts = [a];
  for (let k = a; k < b; k++) {
    const t = sig[k];
    if (isOp(t, '(')) { const m = match[k]; if (m < 0 || m >= b) break; k = m; continue; }
    const kk = kwOf(t);
    if (k > a && (kk === 'SELECT' || kk === 'INSERT' || kk === 'UPDATE' || kk === 'DELETE')) {
      const pk = kwOf(sig[k - 1]);
      if (pk !== 'ON' && pk !== 'FOR') starts.push(k);
    }
  }
  return starts.map((s, n) => ({ a: s, b: n + 1 < starts.length ? starts[n + 1] : b }));
}

// The index of the first keyword `kw` at the parenthesis depth of index i within [i, b), else -1. An unclosed '(' is
// read into when it is not a subquery or TRIM's argument list (`SELECT COUNT( FROM account` while typing: 03 §5's
// tolerant analysis takes that FROM as the statement's), and its closed parentheses are skipped.
function kwAtDepth(sig, i, b, match, kw) {
  for (let k = i; k < b; k++) {
    const t = sig[k];
    if (isOp(t, '(')) {
      const m = match[k];
      if (m >= 0 && m < b) { k = m; continue; }
      if (SUBQ(sig[k + 1]) || isKw(sig[k - 1], 'TRIM')) return -1;
      continue;
    }
    if (isKw(t, kw)) return k;
  }
  return -1;
}

// Sources and DML target of the segment [a, b): {kind, a, b, sources, target, targetAt, colsParen, fromAt}.
// `targetAt` is where an UPDATE, DELETE or INSERT target is written (after TOP (n) [PERCENT] and FROM / INTO). An
// UPDATE or DELETE target that is not an alias in FROM joins the sources (flagged `dmlTarget`), as the engine reads
// it (02 §8.1 step 1).
function segmentInfo(sig, a, b, match, ctes) {
  const kind = kwOf(sig[a]) || 'EXPR';
  const info = { kind, a, b, sources: [], target: null, targetAt: -1, colsParen: -1, fromAt: -1 };
  let i = a;
  if (DML_KW.has(kind)) {
    i++;
    if (isKw(sig[i], 'TOP') && isOp(sig[i + 1], '(')) { i = (match[i + 1] >= 0 ? match[i + 1] : b) + 1; if (isKw(sig[i], 'PERCENT')) i++; }
    if ((kind === 'DELETE' && isKw(sig[i], 'FROM')) || (kind === 'INSERT' && isKw(sig[i], 'INTO'))) i++;
    info.targetAt = i;
    const ch = i < b ? chainAt(sig, i, b) : null;
    if (ch && !(sig[i].t === 'id' && RESERVED.has(sig[i].k))) {
      const c = classify(ch.parts, sig[i].t === 'var', ctes);
      info.target = { ...c, parts: ch.parts, s: sig[ch.a].s, e: sig[ch.b].e, nameA: ch.a, nameB: ch.b, alias: null, join: null, dmlTarget: true };
      i = ch.b + 1;
      if (kind === 'INSERT' && isOp(sig[i], '(') && !SUBQ(sig[i + 1])) info.colsParen = i;
    }
  }
  const f = kwAtDepth(sig, i, b, match, 'FROM');
  if (f >= 0) { info.fromAt = f; info.sources = parseFromList(sig, f + 1, b, match, ctes).sources; }
  if (info.target && kind !== 'INSERT') {
    const tn = lower(info.target.parts[info.target.parts.length - 1]);
    const hit = info.sources.find(s => refOf(s) === tn);
    if (hit) info.target = hit;
    else info.sources.unshift(info.target);
  }
  return info;
}

// Unclosed '(' indices before i0 within [a, i0), outermost first.
function openParens(sig, a, i0, match) {
  const out = [];
  for (let k = a; k < i0; k++) {
    if (!isOp(sig[k], '(')) continue;
    const m = match[k];
    if (m >= 0 && m < i0) k = m; else out.push(k);
  }
  return out;
}

// The clause at i within the segment [a, i): {clause, nested}; nested = i is inside a parenthesis of the segment
// that is not a subquery (function arguments, IN lists). `targetKw` is the index of the FROM of `DELETE FROM t` (it
// names the target, it starts no FROM clause); a WITH inside a segment (table hints, an OPENJSON schema, WITH TIES,
// WITH ROLLUP) changes no clause.
function clauseAt(sig, a, i, match, segKind, targetKw = -1) {
  let clause = CLAUSE_OF.get(segKind) ?? lower(segKind);
  for (let k = a; k < i; k++) {
    const t = sig[k];
    if (isOp(t, '(')) {
      const m = match[k];
      if (m >= 0 && m < i) { k = m; continue; }
      return { clause, nested: true };
    }
    const kk = kwOf(t);
    if (!kk) { if (isOp(t, ',') && clause === 'on') clause = 'from'; continue; }
    if (kk === 'ON' && (clause === 'from' || clause === 'on')) clause = 'on';
    else if (kk === 'JOIN' || kk === 'APPLY') clause = 'from';
    else if (kk === 'SET' && segKind === 'UPDATE') clause = 'set';
    else if ((kk === 'INTO' && segKind === 'INSERT') || k === targetKw || kk === 'WITH') continue;
    else if (CLAUSE_OF.has(kk) && k > a) clause = CLAUSE_OF.get(kk);
  }
  return { clause, nested: false };
}

// Keywords after which a '(' opens a value or a subquery (not a call's argument list).
const PAREN_EXPR_KW = new Set(('IN ANY ALL SOME EXISTS WHERE AND OR NOT ON HAVING SELECT DISTINCT WHEN THEN ELSE CASE RETURN IF WHILE ' +
  'PRINT BY UNION EXCEPT INTERSECT BETWEEN LIKE').split(' '));

// What may start right after the unclosed '(' at q: 'exists' (EXISTS (: a query), 'cte' (WITH x AS (: a query),
// 'from' (FROM / JOIN / APPLY / ',' in FROM: a derived table, VALUES or a parenthesised join), 'over' (OVER (:
// PARTITION BY / ORDER BY), 'expr' (a grouping parenthesis or an IN / ANY / ALL list: a value or a subquery) or null
// (the argument list of a call, a column list, a VALUES row, …).
function parenKind(sig, q, stmt, clause) {
  const b = q - 1 >= stmt.a ? sig[q - 1] : null;
  if (!b) return 'expr';
  if (b.t === 'op') return b.v === ')' || b.v === '.' ? null : b.v === ',' && clause === 'from' ? 'from' : 'expr';
  const k = kwOf(b);
  if (!k) return null;
  if (k === 'EXISTS') return 'exists';
  if (k === 'OVER') return 'over';
  if (k === 'AS') return stmt.kind === 'WITH' ? 'cte' : null;
  if (k === 'FROM' || k === 'JOIN' || k === 'APPLY') return 'from';
  return PAREN_EXPR_KW.has(k) ? 'expr' : null;
}

// Index of the TOP keyword when the tokens just before i0 are `TOP n`, `TOP (expr)`, optionally followed by PERCENT
// and WITH TIES; else -1.
function topBefore(sig, i0, a, match) {
  let k = i0 - 1;
  if (isKw(sig[k], 'TIES') && isKw(sig[k - 1], 'WITH')) k -= 2;
  if (isKw(sig[k], 'PERCENT')) k--;
  if (k - 1 < a) return -1;
  const t = sig[k];
  if (isOp(t, ')')) { const o = match[k]; return o - 1 >= a && isKw(sig[o - 1], 'TOP') ? o - 1 : -1; }
  return (t.t === 'num' || t.t === 'var') && isKw(sig[k - 1], 'TOP') ? k - 1 : -1;
}

// The innermost CASE still open at i0 within [a, i0) (closed parentheses skipped): its last keyword ('CASE', 'WHEN',
// 'THEN' or 'ELSE'), or null outside a CASE.
function caseAt(sig, a, i0, match) {
  const stack = [];
  for (let k = a; k < i0; k++) {
    const t = sig[k];
    if (isOp(t, '(')) { const m = match[k]; if (m < 0 || m >= i0) break; k = m; continue; }
    const kk = kwOf(t);
    if (kk === 'CASE') stack.push('CASE');
    else if (kk === 'END') stack.pop();
    else if (stack.length && (kk === 'WHEN' || kk === 'THEN' || kk === 'ELSE')) stack[stack.length - 1] = kk;
  }
  return stack.length ? stack[stack.length - 1] : null;
}

// Where the caret is inside OVER (…) at the paren q: 'start' (nothing yet), 'frame' (after ROWS / RANGE),
// 'bound' (after BETWEEN of a frame), 'end' (after AND of a frame), 'offset' (after `n` of a frame bound) or
// 'after' (after an operand of PARTITION BY / ORDER BY).
function overState(sig, q, i0, match) {
  if (i0 - 1 === q) return 'start';
  const p1 = sig[i0 - 1], p2 = sig[i0 - 2];
  const k1 = kwOf(p1);
  let order = false, frame = false, between = false, and = false;
  for (let k = q + 1; k < i0; k++) {
    if (isOp(sig[k], '(') && match[k] >= 0 && match[k] < i0) { k = match[k]; continue; }
    const kk = kwOf(sig[k]);
    if (kk === 'ORDER') order = true;
    else if (kk === 'ROWS' || kk === 'RANGE') frame = true;
    else if (frame && kk === 'BETWEEN') between = true;
    else if (between && kk === 'AND') and = true;
  }
  if (frame) {
    if (k1 === 'ROWS' || k1 === 'RANGE') return 'frame';
    if (k1 === 'BETWEEN') return 'bound';
    if (k1 === 'AND') return 'end';
    if (p1.t === 'num') return 'offset';
    return (k1 === 'PRECEDING' || k1 === 'FOLLOWING' || k1 === 'ROW') && between && !and ? 'and' : 'done';
  }
  if (order && (k1 === 'ASC' || k1 === 'DESC')) return 'sorted';
  if (isOp(p1, ',') || k1 === 'BY' || !operandEnd(p1, p2)) return null;
  return order ? 'order' : 'partition';
}

// Keywords inside OVER (…) per overState().
const OVER_KW = {
  start: 'PARTITION~BY_ ORDER~BY_', partition: 'ORDER~BY_',
  order: 'ASC DESC ROWS~BETWEEN_ RANGE~BETWEEN_ ROWS~UNBOUNDED~PRECEDING RANGE~UNBOUNDED~PRECEDING',
  sorted: 'ROWS~BETWEEN_ RANGE~BETWEEN_ ROWS~UNBOUNDED~PRECEDING RANGE~UNBOUNDED~PRECEDING',
  frame: 'BETWEEN_ UNBOUNDED~PRECEDING CURRENT~ROW', bound: 'UNBOUNDED~PRECEDING CURRENT~ROW', end: 'CURRENT~ROW UNBOUNDED~FOLLOWING',
  offset: 'PRECEDING FOLLOWING', and: 'AND_', done: '',
};

// CTEs of a WITH statement starting at a: [{name, cols, a, b}] (body token range). A leading `XMLNAMESPACES (…)` item
// (01 §4.1) declares namespaces, not a CTE: the CTEs follow its ','.
function ctesOf(sig, a, b, match) {
  const out = [];
  if (!isKw(sig[a], 'WITH')) return out;
  let k = a + 1;
  if (isKw(sig[k], 'XMLNAMESPACES') && isOp(sig[k + 1], '(')) {
    const m = match[k + 1];
    if (m < 0 || m >= b || !isOp(sig[m + 1], ',')) return out;
    k = m + 2;
  }
  while (k < b && isName(sig[k])) {
    const name = sig[k].v;
    k++;
    let cols = null;
    if (isOp(sig[k], '(')) { const m = match[k] >= 0 ? match[k] : b; cols = namesIn(sig, k + 1, m); k = m + 1; }
    // an empty quoted CTE name ([] while typing) is read past but defines nothing
    if (!isKw(sig[k], 'AS') || !isOp(sig[k + 1], '(')) { if (name) out.push({ name, cols, a: k, b: k }); break; }
    const m = match[k + 1] >= 0 ? match[k + 1] : b;
    if (name) out.push({ name, cols, a: k + 2, b: m });
    k = m + 1;
    if (!isOp(sig[k], ',')) break;
    k++;
  }
  return out;
}

// The variables of the DECLARE at sig index d (their names before `limit`) pushed to `out` as {name, type, s, cols}
// (cols for table variables); returns the index after the declaration.
function parseDeclare(sig, d, limit, match, out) {
  let k = d + 1;
  while (k < limit && sig[k]?.t === 'var') {
    const v = sig[k];
    k++;
    if (isKw(sig[k], 'AS')) k++;
    let type = '', cols = null;
    if (isKw(sig[k], 'TABLE')) {
      type = 'TABLE';
      k++;
      if (isOp(sig[k], '(')) { const m = match[k] >= 0 ? match[k] : sig.length; cols = columnDefs(sig, k + 1, m, match); k = m + 1; }
    } else if (sig[k]?.t === 'id' && !isKw(sig[k], 'CURSOR')) {
      let te = k + 1;
      if (isOp(sig[te], '(') && match[te] >= 0) te = match[te] + 1;
      type = lower(tokText(sig, k, te));
      k = te;
    }
    out.push({ name: v.raw ?? v.v, type, s: v.s, cols });
    if (isOp(sig[k], '=')) {
      k++;
      while (k < sig.length && !isOp(sig[k], ',') && !isOp(sig[k], ';') && !(sig[k].t === 'id' && STMT_KW.has(sig[k].k) && !isKw(sig[k], 'SELECT'))) {
        if (isOp(sig[k], '(')) k = match[k] >= 0 ? match[k] : sig.length;
        k++;
      }
    }
    if (!isOp(sig[k], ',')) break;
    k++;
  }
  return k;
}

// Variables DECLAREd in the window before index i0: [{name, type, s, cols}] (cols for table variables).
function declaredVars(sig, i0, match) {
  const out = [];
  for (let d = 0; d < i0; d++) if (isKw(sig[d], 'DECLARE')) d = parseDeclare(sig, d, i0, match, out) - 1;
  return out;
}

// The cursor of `DECLARE c [INSENSITIVE] [SCROLL] CURSOR [options] FOR …` at sig index d (01 §4.1 Cursors) pushed
// to `out` as {name, pre (the options before CURSOR), post (after it), options (both, upper case, as written), s};
// returns the index after CURSOR and its options, or d + 1 when sig[d] declares no cursor (a variable, or a name not
// followed by CURSOR).
function parseCursorDecl(sig, d, out) {
  const n = sig[d + 1];
  if (!isKw(sig[d], 'DECLARE') || !isName(n) || !n.v || (n.t === 'id' && RESERVED.has(n.k))) return d + 1;
  const pre = [], post = [];
  let k = d + 2;
  while (sig[k]?.t === 'id' && CURSOR_PRE.includes(sig[k].k)) pre.push(sig[k++].k);
  // tokens that end before CURSOR (a slice of prescan()) may go on: sig.length asks for a longer slice
  if (!isKw(sig[k], 'CURSOR')) return k >= sig.length ? sig.length : d + 1;
  k++;
  while (sig[k]?.t === 'id' && CURSOR_POST.includes(sig[k].k)) post.push(sig[k++].k);
  out.push({ name: n.v, pre, post, options: [...pre, ...post], s: n.s });
  return k;
}

// Cursors DECLAREd in the window before index i0: [{name, options, s}].
function declaredCursors(sig, i0) {
  const out = [];
  for (let d = 0; d + 1 < i0; d++) if (isKw(sig[d], 'DECLARE') && isName(sig[d + 1])) d = parseCursorDecl(sig, d, out) - 1;
  return out;
}

// The #temp table of the CREATE TABLE at sig index k set in `out` (Map<lower name, {name, cols}>); returns the index
// after its column list (sig.length when the list is not closed), or k + 1 when sig[k] starts no CREATE TABLE #t.
function parseCreateTemp(sig, k, match, out) {
  if (!isKw(sig[k], 'CREATE') || !isKw(sig[k + 1], 'TABLE') || !isName(sig[k + 2]) || !sig[k + 2].v.startsWith('#')) return k + 1;
  const name = sig[k + 2].v;
  const p = k + 3;
  const close = isOp(sig[p], '(') ? (match[p] >= 0 ? match[p] : sig.length) : -1;
  out.set(lower(name), { name, cols: close >= 0 ? columnDefs(sig, p + 1, close, match) : [] });
  return close >= 0 ? Math.min(sig.length, close + 1) : p;
}

// #temp tables created by CREATE TABLE before index i0: Map<lower name, {name, cols}>.
function scriptTemps(sig, i0, match) {
  const out = new Map();
  for (let k = 0; k + 2 < i0; k++) if (isKw(sig[k], 'CREATE')) parseCreateTemp(sig, k, match, out);
  return out;
}

// Output names of the select list of the query block [a, b): [{name, xa, xb (the item's expression, without its
// alias)} | {star: true, qualifier}] in order; an item without a name (an expression without alias, or AS [] while
// typing) has name null.
function selectList(sig, a, b, match) {
  const out = [];
  let k = a;
  if (isKw(sig[k], 'WITH')) {   // CTE prelude: skip to the main SELECT
    for (; k < b && !isKw(sig[k], 'SELECT'); k++) if (isOp(sig[k], '(') && match[k] >= 0) k = match[k];
  }
  if (!isKw(sig[k], 'SELECT')) return out;
  k++;
  if (isKw(sig[k], 'DISTINCT') || isKw(sig[k], 'ALL')) k++;
  if (isKw(sig[k], 'TOP')) {
    k++;
    if (isOp(sig[k], '(')) k = (match[k] >= 0 ? match[k] : b) + 1; else k++;
    if (isKw(sig[k], 'PERCENT')) k++;
    if (isKw(sig[k], 'WITH') && isKw(sig[k + 1], 'TIES')) k += 2;
  }
  let s = k;
  // an item named by an empty quoted name (AS [] while typing) has no name to offer
  const named = (name, xa, xb) => { out.push({ name: name || null, xa, xb }); };
  const flush = e => {
    if (e <= s) return;
    const f = sig[s], l = sig[e - 1];
    if (isOp(l, '*')) { out.push({ star: true, qualifier: e - s >= 3 && isOp(sig[e - 2], '.') ? lower(nameText(sig[e - 3])) : null }); return; }
    if (e - s >= 3 && isName(f) && isOp(sig[s + 1], '=')) { named(f.v, s + 2, e); return; }
    const ch = chainEndingAt(sig, e - 1);
    if (ch && ch.a === s && l.t !== 'var') { named(ch.parts[ch.parts.length - 1], s, e); return; }
    if (e - s >= 2 && isName(l) && !(l.t === 'id' && RESERVED.has(l.k))) named(l.v, s, isKw(sig[e - 2], 'AS') ? e - 2 : e - 1);
    else named(null, s, e);
  };
  for (; k < b; k++) {
    const t = sig[k];
    if (isOp(t, '(')) { const m = match[k]; if (m < 0 || m >= b) break; k = m; continue; }
    if (isOp(t, ',')) { flush(k); s = k + 1; continue; }
    const kk = kwOf(t);
    if (kk === 'FROM' || kk === 'INTO' || kk === 'WHERE' || kk === 'GROUP' || kk === 'HAVING' || kk === 'ORDER' || kk === 'UNION' ||
      kk === 'EXCEPT' || kk === 'INTERSECT' || kk === 'OPTION' || kk === 'FOR') break;
  }
  flush(k);
  return out;
}

// ------------------------------------------------------------------------------------------------- analysis

// Statement containing sig index j, or null.
function stmtAt(stmts, j) {
  let lo = 0, hi = stmts.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const s = stmts[m];
    if (j < s.a) hi = m - 1; else if (j >= s.b) lo = m + 1; else return s;
  }
  return null;
}

// Whether token t ends an operand (a name, literal, variable, ')' or a '*' select item).
function operandEnd(t, before) {
  if (!t) return false;
  if (t.t === 'num' || t.t === 'str' || t.t === 'qid' || t.t === 'var') return true;
  if (t.t === 'op') return t.v === ')' || (t.v === '*' && (!before || isOp(before, ',') || isOp(before, '.') || isKw(before, 'SELECT') || isKw(before, 'DISTINCT')));
  if (t.t === 'id') return !RESERVED.has(t.k) || OPERAND_KW.has(t.k);
  return false;
}

// The join keywords that end at sig index j ('LEFT OUTER JOIN', 'JOIN').
function joinTextBefore(sig, j) {
  const words = [];
  for (let k = j; k >= 0; k--) {
    const kk = kwOf(sig[k]);
    if (kk === 'JOIN' || kk === 'INNER' || kk === 'LEFT' || kk === 'RIGHT' || kk === 'FULL' || kk === 'OUTER' || kk === 'LOOP' || kk === 'HASH' || kk === 'MERGE') words.unshift(kk);
    else break;
  }
  return words.join(' ') || 'JOIN';
}

const HINT_CH = /[A-Za-z0-9_]/;

// The end of the run of characters matching `re` from `pos`, at most `lim`.
function runEnd(text, pos, lim, re) {
  let k = pos;
  while (k < lim && re.test(text[k])) k++;
  return k;
}

// Context for a caret inside a string: the argument of USE HINT('…') completes hint names, nothing else does. The
// analysed range is the whole string; an open string (still being typed) ends at the hint-name characters after the
// caret, so accepting never replaces the text after them (03 §1.4).
function stringContext(ctx, tok, L) {
  const { sig, match } = L;
  const i = firstAt(sig, tok.s);
  const st = stmtAt(L.stmts, i);
  if (!st) return ctx;
  const ps = openParens(sig, st.a, i, match);
  const q = ps.length ? ps[ps.length - 1] : -1;
  if (q < 0 || !isKw(sig[q - 1], 'HINT') || !isKw(sig[q - 2], 'USE')) return ctx;
  const skip = tok.cont ? 0 : ctx.text[tok.s] === 'N' || ctx.text[tok.s] === 'n' ? 2 : 1;
  const to = tok.open ? runEnd(ctx.text, ctx.caret, tok.e, HINT_CH) : tok.e;
  return { ...ctx, kind: 'useHint', inString: true, prefix: ctx.text.slice(tok.s + skip, ctx.caret), from: tok.s, to };
}

// The lexWindow() result L with its open quoted-name token toks[ti] cut at `cut` (the end of the name characters after
// the caret) and the text from there to the token's old end lexed as code (03 §5: the text after the caret counts; an
// unclosed [name or "name" being typed takes in nothing after the name).
function cutOpenName(L, ti, cut, qi) {
  const t = L.toks[ti];
  const head = { ...t, e: cut, v: openBody(L.text, t.s, cut), open: true };
  const toks = [...L.toks.slice(0, ti), head, ...lexRange(L.text, cut, t.e, CLEAN, qi), ...L.toks.slice(ti + 1)];
  const sig = toks.filter(x => x.t !== 'ws' && x.t !== 'cmt');
  const stmts = segment(sig);
  return { ...L, toks, sig, stmts, match: pairUp(sig, stmts) };
}

// The alias position of 03 §5 at sig index i0 (the word under the caret, or the token after the caret): right
// after a FROM / JOIN / APPLY source (its name, or the ')' of a call, derived table or PIVOT) that has no alias yet,
// or after its AS, or on the word written as its alias. {source, afterAs} or null.
function aliasPosition(scope, sig, i0, word) {
  for (const s of scope) {
    if (!s.fromList || s.endAt == null) continue;
    if (word) {
      if (word.t !== 'var' && s.aliasTok === i0) return { source: s, afterAs: isKw(sig[i0 - 1], 'AS') };
      continue;
    }
    const free = s.aliasTok == null || s.aliasTok === i0;
    if (free && s.endAt === i0 - 1) return { source: s, afterAs: false };
    if (free && s.endAt === i0 - 2 && isKw(sig[i0 - 1], 'AS')) return { source: s, afterAs: true };
  }
  return null;
}

// The arguments of `EXEC <name> …` after the name chain ch (01 §4.1 exec) as the caret sees them (i0: the
// index of the word under the caret, or of the token after the caret): {message, dyn (sp_executesql), args:
// [{a, b, name (lower case, without '@', for `@name = …`), output}], cur (the caret's argument), used (the names of
// the other named arguments), positional (the arguments before the first named one, the caret's left out), paramPos
// (the caret starts its argument, outside parentheses), paramsText (sp_executesql: the constant @params string)}.
function execArgs(sig, ch, end, i0, match, nested) {
  const args = [];
  let a = ch.b + 1;
  for (let k = a; ; k++) {
    if (k >= end || isOp(sig[k], ',')) {
      args.push({ a, b: Math.min(k, end) });
      if (k >= end) break;
      a = k + 1;
      continue;
    }
    if (isOp(sig[k], '(')) { const m = match[k]; k = m >= 0 && m < end ? m : end - 1; }
  }
  for (const x of args) {
    const t = sig[x.a];
    x.name = t && t.t === 'var' && x.a + 1 < x.b && isOp(sig[x.a + 1], '=') ? lower(t.raw ?? t.v).replace(/^@/, '') : null;
    const l = x.b > x.a ? sig[x.b - 1] : null;
    x.output = isKw(l, 'OUTPUT') || isKw(l, 'OUT');
  }
  let cur = args.findIndex(x => i0 <= x.b);
  if (cur < 0) cur = args.length - 1;
  const message = ch.parts[ch.parts.length - 1];
  const dyn = lower(message) === 'sp_executesql' && (ch.parts.length === 1 || (ch.parts.length === 2 && ['sys', 'dbo'].includes(lower(ch.parts[0]))));
  // sp_executesql: the first two arguments are @stmt and @params, the parameter values follow them
  const first = dyn ? 2 : 0;
  const used = args.filter((x, n) => n !== cur && n >= first && x.name && !(dyn && (x.name === 'stmt' || x.name === 'params'))).map(x => x.name);
  let positional = 0;
  for (let n = first; n < args.length && !args[n].name; n++) if (n !== cur && args[n].b > args[n].a) positional++;
  let paramsText = null;
  if (dyn) {
    const pa = args.find(x => x.name === 'params') ?? (args[1] && !args[1].name ? args[1] : null);
    const v = pa ? pa.a + (pa.name ? 2 : 0) : -1;
    if (pa && pa.b - v === 1 && sig[v].t === 'str') paramsText = sig[v].v;
  }
  return { message, dyn, args, cur, argIndex: cur, used, positional, paramPos: !nested && i0 === args[cur].a, paramsText };
}

// Where the caret is in `FETCH [NEXT|PRIOR|FIRST|LAST|ABSOLUTE n|RELATIVE n] [FROM] [GLOBAL] c [INTO @a, …]` (01 §4.1
// Cursors): {kind: 'start' (directions and cursor names), 'from' (FROM after a direction), 'cursor' (cursor
// names), 'into' (INTO after the cursor), 'vars' (the INTO targets), 'n' (the number of ABSOLUTE n / RELATIVE n)} or
// null (past the end of the statement).
function fetchState(sig, st, i0) {
  let k = st.a + 1;
  if (i0 === k) return { kind: 'start' };
  let dir = false;
  if (sig[k]?.t === 'id' && FETCH_DIRS.has(sig[k].k)) {
    dir = true;
    const d = sig[k].k;
    k++;
    if (d === 'ABSOLUTE' || d === 'RELATIVE') {
      if (isOp(sig[k], '-') || isOp(sig[k], '+')) k++;
      if (i0 <= k) return { kind: 'n' };
      k++;
    }
    if (i0 === k) return { kind: 'from' };
  }
  if (isKw(sig[k], 'FROM')) k++;
  else if (dir) return null;
  // GLOBAL right before the caret, or before a name, is the keyword (`FETCH NEXT FROM GLOBAL c`)
  if (isKw(sig[k], 'GLOBAL') && (i0 === k + 1 || (k + 1 < st.b && isName(sig[k + 1])))) k++;
  if (i0 === k) return { kind: 'cursor' };
  if (!isName(sig[k])) return null;
  k++;
  if (i0 === k) return { kind: 'into' };
  if (!isKw(sig[k], 'INTO') || i0 <= k) return null;
  for (let j = k + 1; j < i0; j++) if (!(sig[j].t === 'var' || isOp(sig[j], ','))) return null;
  return isKw(sig[i0 - 1], 'INTO') || isOp(sig[i0 - 1], ',') ? { kind: 'vars' } : null;
}

// Where the caret is in `DECLARE c [INSENSITIVE] [SCROLL] CURSOR [options] FOR <select>` (01 §4.1 Cursors):
// {kind: 'pre' (before CURSOR) | 'post' (after CURSOR) | 'query' (after FOR), opts (the options written), iso (an
// ISO option before CURSOR: no other option may follow)} or null when the DECLARE declares variables or the caret is
// elsewhere.
function cursorDeclState(sig, st, i0) {
  const n = sig[st.a + 1];
  if (!isName(n) || n.t === 'var' || (n.t === 'id' && RESERVED.has(n.k)) || i0 < st.a + 2) return null;
  const opts = [];
  let k = st.a + 2;
  while (k < i0 && sig[k]?.t === 'id' && CURSOR_PRE.includes(sig[k].k)) opts.push(sig[k++].k);
  if (i0 === k) return { kind: 'pre', opts, iso: opts.length > 0 };
  if (!isKw(sig[k], 'CURSOR')) return null;
  const iso = opts.length > 0;
  k++;
  while (k < i0 && sig[k]?.t === 'id' && CURSOR_POST.includes(sig[k].k)) opts.push(sig[k++].k);
  if (i0 === k) return { kind: 'post', opts, iso };
  return isKw(sig[k], 'FOR') && i0 === k + 1 ? { kind: 'query', opts, iso } : null;
}

// The cursors a context can name: those declared in its batch before the caret, then the GLOBAL ones that the
// batches before it leave declared (earlierCursors).
function withEarlierCursors(ctx) {
  const g = earlierCursors(ctx.text, ctx.lex.batchStart ?? 0, ctx.qi !== false);
  return g.length ? [...ctx.cursors, ...g] : ctx.cursors;
}

// The index where the expression that ends with the ')' matching the '(' at index o starts: the callee of a call
// (`CAST(…)`, `x.query(…)`: the start of x; a method of a call's or parenthesised value, `CAST(… AS xml).query(…)`:
// the start of that value), else the '(' itself.
function exprStartOfParen(sig, o, match) {
  const f = sig[o - 1];
  if (!f || f.t !== 'id' || (RESERVED.has(f.k) && !['CAST', 'TRY_CAST', 'CONVERT', 'TRY_CONVERT'].includes(f.k))) return o;
  const ch = chainEndingAt(sig, o - 1);
  const a = ch ? ch.a : o - 1;
  return isOp(sig[a - 1], '.') && isOp(sig[a - 2], ')') && match[a - 2] >= 0 && match[a - 2] < a - 2 ? exprStartOfParen(sig, match[a - 2], match) : a;
}

// Whether the ')' at index c closes an expression of static type xml (01 §8.3): CAST / TRY_CAST (… AS xml),
// CONVERT / TRY_CONVERT (xml, …), an xml method `.query(…)` (it returns xml), or a parenthesised `(SELECT … FOR XML
// …, TYPE)` subquery.
function xmlParen(sig, c, match) {
  const o = match[c];
  if (o < 0) return false;
  const f = sig[o - 1];
  const kf = kwOf(f);
  const isXmlType = t => t && t.t === 'id' && t.k === 'XML';
  if (kf === 'CAST' || kf === 'TRY_CAST') {
    for (let k = o + 1; k < c; k++) {
      if (isOp(sig[k], '(') && match[k] >= 0 && match[k] < c) { k = match[k]; continue; }
      if (isKw(sig[k], 'AS')) return isXmlType(sig[k + 1]);
    }
    return false;
  }
  if (kf === 'CONVERT' || kf === 'TRY_CONVERT') return isXmlType(sig[o + 1]) && (isOp(sig[o + 2], ',') || isOp(sig[o + 2], '('));
  if (f && f.t === 'id' && lower(f.v) === 'query' && isOp(sig[o - 2], '.')) return true;
  if (SUBQ(sig[o + 1])) {
    let forXml = false;
    for (let k = o + 1; k < c; k++) {
      if (isOp(sig[k], '(') && match[k] >= 0 && match[k] < c) { k = match[k]; continue; }
      if (isKw(sig[k], 'FOR') && isKw(sig[k + 1], 'XML')) forXml = true;
      else if (forXml && isKw(sig[k], 'TYPE')) return true;
    }
  }
  return false;
}

// The SET options of 01 §4.1 (SET options) in the order completion offers them: [name, values ('|'-separated, in
// order), text]. ANSI_NULLS and the other options SQL Studio keeps fixed accept only ON; TRANSACTION takes ISOLATION
// LEVEL READ COMMITTED | READ UNCOMMITTED.
const SET_OPTIONS = [
  ['NOCOUNT', 'ON|OFF', 'ON leaves out the "(n rows affected)" messages.'],
  ['QUOTED_IDENTIFIER', 'ON|OFF', 'OFF makes "text" a string literal from the next batch on; names are then quoted with [ ] only.'],
  ['DATEFORMAT', 'mdy|dmy|ymd|ydm|myd|dym', 'The order of month, day and year in date strings (default mdy).'],
  ['DATEFIRST', '1|2|3|4|5|6|7', 'The first day of the week for DATEPART(weekday, …) and @@DATEFIRST (7 = Sunday, the default).'],
  ['LANGUAGE', 'us_english|British', 'us_english (or English): mdy and Sunday first; British: dmy and Monday first.'],
  ['ANSI_NULLS', 'ON', 'Always on in SQL Studio; only ON is accepted.'],
  ['ANSI_PADDING', 'ON', 'Always on in SQL Studio; only ON is accepted.'],
  ['ANSI_WARNINGS', 'ON', 'Always on in SQL Studio; only ON is accepted.'],
  ['ARITHABORT', 'ON', 'Always on in SQL Studio; only ON is accepted.'],
  ['CONCAT_NULL_YIELDS_NULL', 'ON', 'Always on in SQL Studio; only ON is accepted.'],
  ['XACT_ABORT', 'ON', 'Always on in SQL Studio; only ON is accepted.'],
  ['TRANSACTION', 'ISOLATION LEVEL', 'Accepted for READ COMMITTED and READ UNCOMMITTED; reads never lock in Dataverse.'],
];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
let setIndex = null;
// SET_OPTIONS by name.
const setOptionsByName = () => setIndex ?? (setIndex = new Map(SET_OPTIONS.map(r => [r[0], r])));

// Where the caret is in a SET statement (01 §4.1): {stage: 'name' (option names; `withVars`: also the variables;
// `listed`: the options of a `SET A, B ON` list written before the caret), 'value' (`option`'s values, `options`: every
// option of an `SET A, B ON` list), 'isolation' (after TRANSACTION), 'level' (after ISOLATION LEVEL), 'read' (after
// ISOLATION LEVEL READ), 'done' (right after the option's value: the statement is complete, a new one follows)} or null
// (an assignment, or elsewhere).
function setOptionState(sig, st, i0) {
  const n = st.a + 1;
  if (i0 === n) return { stage: 'name', withVars: true, listed: [] };
  const t = sig[n];
  if (!t || t.t !== 'id' || i0 < n) return null;
  if (t.k === 'TRANSACTION') {
    if (i0 === n + 1) return { stage: 'isolation' };
    if (isKw(sig[n + 1], 'ISOLATION') && isKw(sig[n + 2], 'LEVEL')) {
      if (i0 === n + 3) return { stage: 'level' };
      if (isKw(sig[n + 3], 'READ')) {
        if (i0 === n + 4) return { stage: 'read' };
        if (i0 === n + 5 && (isKw(sig[n + 4], 'COMMITTED') || isKw(sig[n + 4], 'UNCOMMITTED'))) return { stage: 'done' };
      }
    }
    return null;
  }
  // SET A [, B]… value: the option names separated by ',', then the value (ON, OFF, a word, number or string)
  const options = [];
  let k = n;
  for (; k < i0; k++) {
    const x = sig[k];
    if ((k - n) % 2 === 0) { if (x.t !== 'id' || x.k === 'ON' || x.k === 'OFF') return null; options.push(x.k); continue; }
    if (isOp(x, ',')) continue;
    // the value: the statement ends after it
    return k + 1 === i0 && (x.t === 'id' || x.t === 'num' || x.t === 'str') ? { stage: 'done' } : null;
  }
  if ((k - n) % 2 === 0) return { stage: 'name', withVars: false, listed: options };
  return { stage: 'value', option: options[options.length - 1], options };
}

// Whether the statement st is the query of `DECLARE c [INSENSITIVE] [SCROLL] CURSOR [options] FOR <select>` (segment()
// starts a statement at its SELECT; 01 §4.1 Cursors).
function isCursorQuery(sig, st) {
  let k = st.a - 1;
  if (!isKw(sig[k], 'FOR')) return false;
  k--;
  while (k >= 0 && sig[k].t === 'id' && CURSOR_POST.includes(sig[k].k)) k--;
  if (!isKw(sig[k], 'CURSOR')) return false;
  k--;
  while (k >= 0 && sig[k].t === 'id' && CURSOR_PRE.includes(sig[k].k)) k--;
  return isName(sig[k]) && isKw(sig[k - 1], 'DECLARE');
}

// The labels of the analysed batch (01 §4.1 GOTO and labels): a name followed by ':' (a label definition; '::' is
// one token), in text order, with those before an analysis window from prescan(): [{name, s, scopes}]. `scopes` are the
// TRY and CATCH bodies around the label, outermost first (the offset of each one's BEGIN), and `at` (a sig index) asks
// for those around that token too: {labels, scopes (at's, or null)}. A GOTO may jump to a label only when every scope
// around the label is also around the GOTO (1026 otherwise, 02 §9).
function batchLabels(L, at = -1) {
  const stack = [];
  const out = [];
  let scopes = null;
  if (L.pre) {
    const evs = [...L.pre.marks.map(m => ({ s: m.s, mark: m })), ...L.pre.labels.map(l => ({ s: l.s, label: l }))].sort((a, b) => a.s - b.s);
    for (const ev of evs) {
      if (ev.mark) { if (ev.mark.open) stack.push(ev.s); else stack.pop(); } else out.push({ name: ev.label.name, s: ev.label.s, scopes: stack.slice() });
    }
  }
  const sig = L.sig;
  for (let k = 0; k < sig.length; k++) {
    if (k === at) scopes = stack.slice();
    const t = sig[k];
    if ((isKw(t, 'BEGIN') || isKw(t, 'END')) && (isKw(sig[k + 1], 'TRY') || isKw(sig[k + 1], 'CATCH'))) {
      if (t.k === 'BEGIN') stack.push(t.s); else stack.pop();
    } else if (t.t === 'id' && !RESERVED.has(t.k) && isOp(sig[k + 1], ':') && (k === 0 || !isOp(sig[k - 1], '.'))) {
      out.push({ name: t.v, s: t.s, scopes: stack.slice() });
    }
  }
  if (at >= sig.length) scopes = stack.slice();
  return { labels: out, scopes };
}

// Where the caret is in a FOR XML / FOR JSON clause (01 §4.2) whose FOR is the last clause keyword of the segment
// [a, i0): {stage: 'kind' (XML, JSON; READ_ONLY for a cursor), 'mode' (RAW, PATH, AUTO, EXPLICIT / PATH, AUTO),
// 'option' (after ','), 'elements' (after ELEMENTS), 'after' (after the mode or an option), for: 'xml'|'json'|null,
// mode, used (the options written)} or null.
function forClauseState(sig, a, i0, match) {
  let f = -1;
  for (let k = a; k < i0; k++) {
    if (isOp(sig[k], '(')) { const m = match[k]; if (m < 0 || m >= i0) return null; k = m; continue; }
    if (isKw(sig[k], 'FOR')) f = k;
  }
  if (f < 0) return null;
  if (i0 === f + 1) return { stage: 'kind', for: null, mode: null, used: [] };
  const kind = kwOf(sig[f + 1]);
  if (kind !== 'XML' && kind !== 'JSON') return null;
  const fr = kind === 'XML' ? 'xml' : 'json';
  if (i0 === f + 2) return { stage: 'mode', for: fr, mode: null, used: [] };
  const mode = kwOf(sig[f + 2]);
  const used = [];
  let last = f + 2;
  for (let k = f + 3; k < i0; k++) {
    if (isOp(sig[k], '(')) { const m = match[k]; if (m < 0 || m >= i0) return null; k = m; last = k; continue; }
    if (isOp(sig[k], ',')) { last = k; continue; }
    const w = kwOf(sig[k]);
    if (w && isOp(sig[k - 1], ',')) used.push(w);
    last = k;
  }
  const p1 = sig[i0 - 1];
  if (isOp(p1, ',')) return { stage: 'option', for: fr, mode, used };
  if (isKw(p1, 'ELEMENTS') && fr === 'xml') return { stage: 'elements', for: fr, mode, used };
  return last === i0 - 1 ? { stage: 'after', for: fr, mode, used } : null;
}

// Where the caret is, from a tolerant token analysis of its batch including the text after it (03 §5 Contexts):
// {kind, prefix, from, to, quoted, clause, nested, scope, outer, ctes, vars, cursors, temps, stmt, seg, empty, …}.
// kind is none, statement, query (a subquery, CTE or cursor body), table, join, alias, member, xmlMethod,
// on, value, set, insertCols, variable, execParam, hint, useHint, tableHint, exec, executeAs, collation,
// cursor, fetch, cursorDecl, setOption, waitfor, label, forClause, datepart, type, is, over (inside
// OVER (…)), after (after an operand; `execOut`: after the variable of an EXEC argument) or expr;
// [from, to) is what an accepted item replaces (the whole word under the caret; of an unclosed quoted name, up to the
// name characters after the caret). opts: {lex (a lexWindow() result to
// reuse), quotedIdentifier (default true; false = the query tab's SET QUOTED_IDENTIFIER OFF: `"…"` is a string)}.
export function analyze(text, caret, opts = {}) {
  const src = String(text ?? '');
  const pos = Math.max(0, Math.min(Math.trunc(Number(caret) || 0), src.length));
  const O = opts.lex;
  const qi = qiOf(opts);
  const L = fits(O, src, pos, qi) ? O : { ...lexWindow(src, pos, { quotedIdentifier: qi }), text: src };
  const ctx = {
    kind: 'none', text: src, caret: pos, lex: L, qi, prefix: '', from: pos, to: pos, quoted: false, word: null, empty: src.trim() === '',
    clause: '', nested: false, scope: [], outer: [], ctes: [], vars: [], cursors: [], temps: new Map(), stmt: null, seg: null, cteNames: new Set(),
  };
  if (L.go) return ctx;
  const ti = firstAt(L.toks, pos) - 1;
  const at = ti >= 0 ? L.toks[ti] : null;
  // an unclosed [name or "name" being typed (opened on the caret's line) ends with the name characters after the
  // caret, and the text after them is code (03 §1.4, §5)
  if (at && at.t === 'qid' && at.open && !at.cont && pos > at.s && pos <= at.e && src.lastIndexOf('\n', pos - 1) < at.s) {
    const cut = runEnd(src, pos, at.e, IDENT_CH);
    if (cut < at.e) return analyze(src, pos, { ...opts, quotedIdentifier: qi, lex: cutOpenName(L, ti, cut, qi) });
  }
  const { sig, match } = L;
  let word = null;
  if (at && pos <= at.e) {
    if (at.t === 'cmt') { if (pos < at.e || at.open || at.v.startsWith('--')) return ctx; }
    else if (at.t === 'str') { if (pos < at.e || at.open) return stringContext(ctx, at, L); }
    else if (at.t === 'num') return ctx;
    else if (at.t === 'id' || at.t === 'var') word = at;
    else if (at.t === 'qid' && (pos < at.e || at.open)) word = at;
  }
  const i0 = firstAt(sig, word ? word.s : pos);
  if (word) {
    ctx.word = word;
    ctx.from = word.s;
    // an unclosed quoted name: accepting replaces it up to the name characters after the caret, never the rest
    ctx.to = word.open ? runEnd(src, pos, word.e, IDENT_CH) : word.e;
    ctx.quoted = word.t === 'qid';
    ctx.prefix = src.slice(word.s + (ctx.quoted && !word.cont ? 1 : 0), pos);
  }
  // a declaration before the window is read whole, also where it goes on into the window, so only the variables
  // declared before the caret count (it can hold the caret only in a statement longer than the largest window)
  ctx.vars = L.pre ? [...L.pre.vars.filter(v => v.s < pos), ...declaredVars(sig, i0, match)] : declaredVars(sig, i0, match);
  ctx.temps = L.pre ? new Map([...L.pre.temps, ...scriptTemps(sig, i0, match)]) : scriptTemps(sig, i0, match);
  ctx.cursors = L.pre ? [...L.pre.cursors.filter(c => c.s < pos), ...declaredCursors(sig, i0)] : declaredCursors(sig, i0);
  const sj = word ? i0 : i0 - 1;
  const stmt = sj >= 0 && !isOp(sig[sj], ';') ? stmtAt(L.stmts, sj) : null;
  ctx.stmt = stmt;
  if (!stmt) { ctx.kind = word?.t === 'var' ? 'variable' : 'statement'; return ctx; }
  if (stmt.kind === 'WITH') ctx.ctes = ctesOf(sig, stmt.a, stmt.b, match);
  const cteNames = ctx.cteNames = new Set(ctx.ctes.map(c => lower(c.name)));

  // query blocks around the caret (subquery parentheses), the segment of each and its sources
  const ps = openParens(sig, stmt.a, i0, match);
  const blocks = [{ a: stmt.a, b: stmt.b, p: -1 }];
  for (const p of ps) if (SUBQ(sig[p + 1])) blocks.push({ a: p + 1, b: match[p] >= 0 ? match[p] : stmt.b, p });
  const levels = blocks.map((bl, n) => {
    const where = n + 1 < blocks.length ? blocks[n + 1].p : Math.max(bl.a, sj);
    let seg = null;
    for (const s of segmentsOf(sig, bl.a, bl.b, match)) if (!seg || s.a <= where) seg = s;
    return { ...bl, seg, info: segmentInfo(sig, seg.a, seg.b, match, cteNames) };
  });
  const cur = levels[levels.length - 1];
  ctx.seg = cur.info;
  ctx.scope = cur.info.sources;
  for (let n = levels.length - 1; n > 0; n--) {
    const p = levels[n].p, lv = levels[n - 1];
    const pk = kwOf(sig[p - 1]);
    if (pk === 'FROM' || pk === 'JOIN' || pk === 'AS' || (isOp(sig[p - 1], ',') && clauseAt(sig, lv.seg.a, p, match, lv.info.kind).clause === 'from')) break;
    ctx.outer.push(...lv.info.sources);
  }
  const ca = clauseAt(sig, cur.seg.a, i0, match, cur.info.kind, cur.info.kind === 'DELETE' && isKw(sig[cur.info.targetAt - 1], 'FROM') ? cur.info.targetAt - 1 : -1);
  ctx.clause = ca.clause;
  ctx.nested = ca.nested;

  const P = k => (i0 - k >= stmt.a ? sig[i0 - k] : null);
  const p1 = P(1), p2 = P(2), p3 = P(3);
  const k1 = kwOf(p1), k2 = kwOf(p2);
  const done = (kind, extra) => Object.assign(ctx, { kind }, extra);
  const info = cur.info;
  // the target of UPDATE, DELETE or INSERT (03 §5): `DELETE | FROM c` (no word yet) is read by segmentInfo as
  // `DELETE FROM c`, so a caret right before that FROM is the target position too
  const atTarget = DML_KW.has(info.kind) && !ca.nested && (i0 === info.targetAt ||
    (info.kind === 'DELETE' && !word && i0 === info.targetAt - 1 && isKw(sig[i0], 'FROM')));
  const dmlExtra = () => {
    const f = kwAtDepth(sig, i0 + (word ? 1 : 0), info.b, match, 'FROM');
    const t = atTarget ? sig[info.targetAt - 1] : null;
    return {
      dml: info.kind,
      dmlSources: f >= 0 && info.kind !== 'INSERT' ? parseFromList(sig, f + 1, info.b, match, cteNames).sources : [],
      kwFirst: info.kind === 'INSERT' && !isKw(t, 'INTO') ? 'INTO' : info.kind === 'DELETE' && f < 0 && !isKw(t, 'FROM') ? 'FROM' : null,
    };
  };

  // COLLATE <name> (03 §5)
  if (k1 === 'COLLATE') return done('collation');

  // EXEC <message> [@p = value, …] and EXEC sp_executesql
  let exec = null;
  if (stmt.kind === 'EXEC' || stmt.kind === 'EXECUTE') {
    let n = stmt.a + 1;
    if (isKw(sig[n], 'AS')) return done(i0 === n + 1 ? 'executeAs' : 'none');
    if (sig[n]?.t === 'var' && isOp(sig[n + 1], '=')) n += 2;
    if (i0 <= n) return done('exec');
    const ch = chainAt(sig, n, stmt.b);
    if (ch && i0 > ch.b) exec = execArgs(sig, ch, stmt.b, i0, match, ca.nested);
  }
  // cursors (01 §4.1 Cursors): FETCH … [INTO @v, …], OPEN / CLOSE / DEALLOCATE <cursor>, DECLARE c … CURSOR … FOR
  const fetch = stmt.kind === 'FETCH' && !ca.nested ? fetchState(sig, stmt, i0) : null;

  if (word && word.t === 'var') {
    if (exec && exec.paramPos) return done('execParam', exec);
    if (fetch && fetch.kind === 'vars') return done('variable', { assign: true });
    const tablePos = !ca.nested && (k1 === 'FROM' || k1 === 'JOIN' || k1 === 'APPLY' || k1 === 'UPDATE' || k1 === 'INTO' || k1 === 'INSERT' ||
      k1 === 'DELETE' || (isOp(p1, ',') && ca.clause === 'from'));
    // a FROM item or an APPLY right side also takes an xml variable's nodes(), a DML target never
    const nodesOk = tablePos && (k1 === 'FROM' || k1 === 'JOIN' || k1 === 'APPLY' || isOp(p1, ',')) && !atTarget;
    return done('variable', { tableVars: tablePos, nodesOk });
  }
  if (exec && exec.paramPos) return done('execParam', exec);
  // right after the variable of `@Name = @var` or of a positional `@var` argument (a word may be typed): OUTPUT may
  // follow (02 §8.1: never after a constant, 179)
  if (exec && !ca.nested && (!word || word.t === 'id')) {
    const x = exec.args[exec.cur], v = sig[i0 - 1];
    if (x && v && v.t === 'var' && !String(v.raw ?? v.v).startsWith('@@') && (i0 - 1 === x.a || (x.name && i0 - 1 === x.a + 2))) {
      return done('after', { execOut: exec, last: null, needOn: false, inCase: null, sorted: false });
    }
  }
  if (fetch) {
    if (fetch.kind === 'vars') return done('variable', { assign: true });
    if (fetch.kind === 'n') return done('none');
    if (fetch.kind === 'cursor' || fetch.kind === 'start') ctx.cursors = withEarlierCursors(ctx);
    return fetch.kind === 'cursor' ? done('cursor', { global: !isKw(p1, 'GLOBAL') }) : done('fetch', { fetch: fetch.kind });
  }
  // a FETCH statement has no clauses (CLAUSE_OF's FETCH is the OFFSET … FETCH of a query): after it, statements follow
  if (stmt.kind === 'FETCH') ctx.clause = 'fetch';
  if ((stmt.kind === 'OPEN' || stmt.kind === 'CLOSE' || stmt.kind === 'DEALLOCATE') && !ca.nested &&
    (i0 === stmt.a + 1 || (i0 === stmt.a + 2 && isKw(sig[stmt.a + 1], 'GLOBAL')))) {
    ctx.cursors = withEarlierCursors(ctx);
    return done('cursor', { global: i0 === stmt.a + 1 });
  }
  if (stmt.kind === 'DECLARE' && !ca.nested) {
    const d = cursorDeclState(sig, stmt, i0);
    if (d) return d.kind === 'query' ? done('query', { subq: 'cursor' }) : done('cursorDecl', { cursorOpts: d.opts, iso: d.iso, stage: d.kind });
  }
  // statements with words of their own (01 §4.1): SET <option> <value> (a SET statement's operands are no UPDATE SET
  // clause), WAITFOR DELAY | TIME, GOTO <label>, THROW <arguments>, and the FOR XML / FOR JSON clause
  if (stmt.kind === 'SET' && info.kind === 'SET') {
    if (ctx.clause === 'set') ctx.clause = 'setstmt';
    const so = !ca.nested ? setOptionState(sig, stmt, i0) : null;
    if (so) return so.stage === 'done' ? done('statement') : done('setOption', so);
  }
  if (!ca.nested && i0 === stmt.a + 1) {
    if (stmt.kind === 'WAITFOR') return done('waitfor');
    if (stmt.kind === 'GOTO') {
      // the labels this GOTO may jump to: none inside a TRY or CATCH body that is not around it too (1026)
      const bl = batchLabels(L, stmt.a);
      const here = bl.scopes ?? [];
      return done('label', { labels: bl.labels.filter(l => l.scopes.every((id, k) => here[k] === id)) });
    }
    if (stmt.kind === 'THROW') return done('expr');
  }
  if (ca.clause === 'for' && !ca.nested) {
    const fs = forClauseState(sig, cur.seg.a, i0, match);
    if (fs) return done('forClause', { ...fs, cursor: isCursorQuery(sig, stmt) });
  }

  // a.| / schema.| / an xml value's methods
  if (isOp(p1, '.')) {
    const ch = chainEndingAt(sig, i0 - 2);
    const start = ch ? ch.a : isOp(sig[i0 - 2], ')') && match[i0 - 2] >= 0 ? exprStartOfParen(sig, match[i0 - 2], match) : -1;
    if (start < stmt.a) return done('none');
    const before = start - 1 >= stmt.a ? sig[start - 1] : null;
    const bk = kwOf(before);
    const tablePos = !ca.nested && (bk === 'FROM' || bk === 'JOIN' || bk === 'APPLY' || bk === 'INTO' || bk === 'UPDATE' || bk === 'DELETE' ||
      bk === 'INSERT' || (bk === 'TABLE' && (!ch || ch.parts.length === 1)) || (isOp(before, ',') && ca.clause === 'from'));
    // where a nodes() call may be a table source: a FROM item or an APPLY right side, never a DML target (00 §2)
    const nodesOk = !ca.nested && (bk === 'FROM' || bk === 'JOIN' || bk === 'APPLY' || (isOp(before, ',') && ca.clause === 'from')) &&
      !(DML_KW.has(info.kind) && start === info.targetAt);
    if (!ch) return done(xmlParen(sig, i0 - 2, match) ? 'xmlMethod' : 'none', { tablePos, nodesOk });
    const dml = DML_KW.has(info.kind) && !ca.nested && start === info.targetAt ? dmlExtra() : {};
    if (tablePos && ch.parts.length === 1 && SCHEMAS.has(lower(ch.parts[0]))) return done('table', { schema: lower(ch.parts[0]), apply: bk === 'APPLY', ...dml });
    const setPos = info.kind === 'UPDATE' && ca.clause === 'set' && !ca.nested && (bk === 'SET' || isOp(before, ','));
    return done('member', { qualifier: ch.parts, purpose: setPos ? 'update' : 'read', tablePos, nodesOk });
  }

  // inside parentheses: OPTION (…), USE HINT (…), WITH (…) hints, IN (…), containvalues(…), INSERT columns,
  // column definitions, date parts and data types of calls, OVER (…), subqueries
  const q = ps.length ? ps[ps.length - 1] : -1;
  let subq = false;
  if (q >= 0) {
    const b1 = sig[q - 1], b2 = sig[q - 2];
    const atStart = i0 - 1 === q || (isOp(p1, ',') && !openParens(sig, q + 1, i0, match).length);
    if (isKw(b1, 'OPTION')) return done(atStart ? 'hint' : 'none');
    if (isKw(b1, 'HINT') && isKw(b2, 'USE')) return done(atStart ? 'useHint' : 'none');
    if (isKw(b1, 'WITH') && isName(b2) && !(b2.t === 'id' && RESERVED.has(b2.k))) return done(atStart ? 'tableHint' : 'none');
    const pk = parenKind(sig, q, stmt, ca.clause);
    subq = pk === 'expr' && i0 - 1 === q;
    if (atStart && isKw(b1, 'IN')) {
      const ch = chainEndingAt(sig, isKw(b2, 'NOT') ? q - 3 : q - 2);
      if (ch && ch.a >= stmt.a && sig[ch.b].t !== 'var') return done('value', { column: ch.parts, op: 'in', subq });
    }
    if (pk === 'over') {
      const os = overState(sig, q, i0, match);
      if (os) return done('over', { over: os });
    } else if (i0 - 1 === q) {
      if (pk === 'exists' || pk === 'cte') return done('query', { subq: pk });
      if (pk === 'from') return done('table', { derived: true });
    }
    if (atStart && (isKw(b1, 'CONTAINVALUES') || isKw(b1, 'NOTCONTAINVALUES')) && isOp(b2, '=')) {
      const ch = chainEndingAt(sig, q - 3);
      if (ch && ch.a >= stmt.a) return done('value', { column: ch.parts, op: 'contain' });
    }
    if (q === cur.info.colsParen) return done(atStart ? 'insertCols' : 'none', { used: namesIn(sig, q + 1, i0).map(lower).filter(n => !word || n !== lower(word.v)) });
    const defs = (isKw(b1, 'TABLE') && (isKw(b2, 'DECLARE') || b2?.t === 'var' || isKw(b2, 'AS'))) || (isName(b1) && b1.v.startsWith('#') && isKw(b2, 'TABLE')) ||
      (isKw(b1, 'WITH') && isOp(b2, ')'));
    if (defs) return done(isName(p1) && !isKw(p1, 'AS') && (i0 - 2 === q || isOp(p2, ',')) ? 'type' : 'none');
    const fn = kwOf(b1);
    if (fn && !isOp(b2, '.')) {
      let commas = 0;
      for (let k = q + 1; k < i0; k++) { if (isOp(sig[k], '(') && match[k] >= 0 && match[k] < i0) k = match[k]; else if (isOp(sig[k], ',')) commas++; }
      if (DATEPART_FNS.has(fn) && commas === 0) return done('datepart', { fn });
      if ((fn === 'CONVERT' || fn === 'TRY_CONVERT') && commas === 0) return done('type');
      if ((fn === 'CAST' || fn === 'TRY_CAST') && k1 === 'AS') return done('type');
    }
  }

  if (k1 === 'IS') return done('is', { not: false });
  if (k1 === 'NOT' && k2 === 'IS') return done('is', { not: true });
  if (stmt.kind === 'DECLARE' && !ca.nested) {
    if (p1?.t === 'var' && (k2 === 'DECLARE' || isOp(p2, ','))) return done('type', { declare: true });
    if (k1 === 'AS' && p2?.t === 'var') return done('type', { declare: true });
  }
  if (p1 && p1.t === 'op' && (p1.v === '=' || p1.v === '<>' || p1.v === '!=')) {
    const ch = chainEndingAt(sig, i0 - 2);
    if (ch && ch.a >= stmt.a && sig[ch.b].t !== 'var') return done('value', { column: ch.parts, op: p1.v === '=' ? '=' : '<>' });
  }
  if (info.kind === 'UPDATE' && ca.clause === 'set' && !ca.nested && (k1 === 'SET' || isOp(p1, ','))) return done('set', { target: info.target });
  if (!ca.nested) {
    if (k1 === 'JOIN') return done('join', { joinKw: joinTextBefore(sig, i0 - 1) });
    // UPDATE / DELETE [FROM] / INSERT [INTO] <target>: writable tables (03 §5)
    if (atTarget) return done('table', dmlExtra());
    if (k1 === 'FROM' || k1 === 'APPLY') return done('table', { apply: k1 === 'APPLY' });
    if (k1 === 'INTO') {
      // OUTPUT … INTO: a #temp table or a table variable (01 §4.1 INTO targets)
      for (let k = cur.seg.a; k < i0; k++) if (isKw(sig[k], 'OUTPUT')) return done('table', { only: 'output' });
      return done('none');
    }
    // TOP n [PERCENT] [WITH TIES]: the select list starts here
    const top = topBefore(sig, i0, cur.seg.a, match);
    if (top >= 0) {
      const tk = kwOf(sig[top - 1]);
      if (tk === 'SELECT' || tk === 'DISTINCT' || tk === 'ALL') return done('expr', { afterTop: k1 === 'TIES' ? 'ties' : k1 === 'PERCENT' ? 'percent' : 'n' });
    }
    if (k1 === 'TABLE' && k2 === 'TRUNCATE') return done('table', { only: 'truncate' });
    if (k1 === 'TABLE' && k2 === 'DROP') return done('table', { only: 'temp' });
    if (k1 === 'EXISTS' && k2 === 'IF' && kwOf(p3) === 'TABLE') return done('table', { only: 'temp' });
    if (k1 === 'TABLE' && k2 === 'CREATE') return done('none');
    if (isOp(p1, ',') && ca.clause === 'from') return done('table');
    if (k1 === 'ON' && ca.clause === 'on') return done('on', { joined: ctx.scope.find(s => s.onAt === i0 - 1) ?? null });
    if ((k1 === 'AND' || k1 === 'OR') && ca.clause === 'on') {
      let joined = null;
      for (const s of ctx.scope) if (s.onAt != null && s.onAt < i0) joined = s;
      return done('on', { joined });
    }
    // right after a table source in FROM / JOIN / APPLY, or after its AS: the typed word is an alias
    const al = ca.clause === 'from' ? aliasPosition(ctx.scope, sig, i0, word) : null;
    if (al) {
      const s = al.source;
      const needOn = !!s.join && s.join !== ',' && !/APPLY|CROSS/.test(s.join) && s.onAt == null;
      return done('alias', { source: s, afterAs: al.afterAs, needOn });
    }
  }
  // the innermost CASE open at the caret (its WHEN / THEN / ELSE expressions are not statements or clauses)
  const inCase = caseAt(sig, q >= 0 ? q + 1 : cur.seg.a, i0, match);
  if (i0 === stmt.a || k1 === 'BEGIN' || (k1 === 'ELSE' && inCase !== 'ELSE') || ((k1 === 'TRY' || k1 === 'CATCH') && (k2 === 'BEGIN' || k2 === 'END')) ||
    (k1 === 'END' && stmt.kind === 'END' && i0 - 1 === stmt.a)) return done('statement');
  const sorted = (k1 === 'ASC' || k1 === 'DESC') && ca.clause === 'order' && !ca.nested;
  if (operandEnd(p1, p2) || sorted) {
    let last = null;
    for (const s of ctx.scope) if (s.s < pos) last = s;
    const lastJoin = last && last.join && last.join !== ',' && !/APPLY|CROSS/.test(last.join);
    // WITH (NOLOCK) right after the alias of a Dataverse table (table hints follow the alias)
    const hintable = ca.clause === 'from' && !!last && TABLE_KINDS.has(last.kind) && last.aliasAt === i0 - 1;
    return done('after', { last, needOn: ca.clause === 'from' && !!lastJoin && last.onAt == null, inCase, sorted, hintable });
  }
  return done('expr', { afterSelect: k1 === 'SELECT', afterDistinct: k1 === 'DISTINCT' && k2 === 'SELECT', afterCase: k1 === 'CASE', subq });
}

// ------------------------------------------------------------------------------------------------- data

// A synchronous view of the completion data: meta's sync members (02 §2), the session's #temp tables, the
// templates, the loaded message map and recycle-bin set. What is missing is recorded in `needs`
// ([{kind: 'entity'|'rels'|'options'|'messages'|'messagesFull'|'bin', name, attr, key}]) so the caller can load it
// and refresh. `messagesFull` (a boolean or a function giving one, default true) says whether `messages` includes
// the Functions and Actions of $metadata (02 §2): EXEC completion asks for them ('messagesFull', meta.messages()),
// everything else makes do with BUILTIN_MESSAGES and the custom APIs ('messages', meta.messages({csdl: false})).
export function createSource({ meta = null, session = null, templates = null, rowCount = null, messages = null, messagesFull = true, bin = null } = {}) {
  const needs = [];
  const seen = new Set();
  const need = (kind, name = '', attr = '') => {
    const key = `${kind}:${name}:${attr}`;
    if (!seen.has(key)) { seen.add(key); needs.push({ kind, name, attr, key }); }
  };
  const val = v => (typeof v === 'function' ? v() : v);
  const find = name => (meta && typeof meta.findEntity === 'function' && name ? meta.findEntity(String(name)) ?? null : null);
  return {
    needs,
    need,
    entities: () => (meta && typeof meta.entities === 'function' ? meta.entities() ?? [] : []),
    find,
    entity(name) {
      const e = find(name);
      if (!e) return null;
      const full = typeof meta.entitySync === 'function' ? meta.entitySync(e.logicalName) : null;
      if (!full || !full.attrs) { need('entity', e.logicalName); return null; }
      return full;
    },
    rels(name) {
      const e = find(name);
      if (!e) return null;
      const r = typeof meta.relationshipsSync === 'function' ? meta.relationshipsSync(e.logicalName) : null;
      if (!r) need('rels', e.logicalName);
      return r ?? null;
    },
    options(entity, attr) {
      const r = meta && typeof meta.optionsSync === 'function' ? meta.optionsSync(entity, attr) : null;
      if (!r) need('options', entity, attr);
      return r ?? null;
    },
    // The messages Map, or null (recorded as needed); `full`: the caller needs the $metadata messages too (EXEC).
    messages(full = false) {
      const m = val(messages);
      if (!(m instanceof Map)) { need(full ? 'messagesFull' : 'messages'); return null; }
      if (full && val(messagesFull) === false) need('messagesFull');
      return m;
    },
    bin() { const b = val(bin); if (!(b instanceof Set)) { need('bin'); return null; } return b; },
    temps() { const s = val(session); return s && s.temps instanceof Map ? s.temps : new Map(); },
    templates() { const t = val(templates); return Array.isArray(t) ? t : []; },
    rowCount(name) { const n = typeof rowCount === 'function' ? rowCount(name) : null; return Number.isFinite(n) ? n : null; },
  };
}

// The messages Map a context reads (`full`: with $metadata, for EXEC) and whether it is still loading: {map, loading}.
function msgsOf(src, full) {
  const map = src.messages(full);
  return { map, loading: !map || (full && src.needs.some(n => n.kind === 'messagesFull')) };
}

// Columns of a loaded table for completion and hover (01 §6.3, 03 §5): [{name, attr, virtual, base, entity}] in the
// 03 §5 order (primary name, primary key, then alphabetical; virtual xname/xtype/xpid right after their column).
// purpose 'read' (default), 'update' (SET: IsValidForUpdate), 'create' (INSERT: IsValidForCreate) or 'any' (hover
// cards: every listable column, also those that are not valid for read, so their card can say 'Not readable').
export function tableColumns(info, purpose = 'read') {
  const list = info.attrList ?? [...(info.attrs?.values() ?? [])];
  const byName = info.attrs instanceof Map ? info.attrs : new Map(list.map(a => [a.logicalName, a]));
  const any = purpose === 'any', reading = purpose === 'read' || any;
  const ok = a => (any ? true : purpose === 'update' ? a.validForUpdate === true : purpose === 'create' ? a.validForCreate === true : a.validForRead !== false);
  const out = [];
  const add = (name, attr, virtual = null, base = null) => out.push({ name, attr, virtual, base, entity: info.logicalName });
  for (const a of list) {
    if (a.attributeOf || EXCLUDED_TYPES.has(a.type)) continue;
    const n = a.logicalName;
    if (ok(a)) add(n, a);
    const readable = any || a.validForRead !== false;
    const virt = (suffix, kind, allowed) => {
      if (!allowed) return;
      const real = byName.get(n + suffix);
      if (real && real.attributeOf !== n) return;
      add(n + suffix, real ?? null, kind, a);
    };
    if (LOOKUPS.has(a.type)) {
      virt('name', 'name', reading && readable && info.logicalName !== 'solutioncomponent');
      virt('type', 'type', (reading ? readable : ok(a)) && Array.isArray(a.targets) && a.targets.length !== 1);
      const pid = byName.get(n + 'pid');
      if (pid && pid.attributeOf === n && (reading ? readable : ok(pid))) add(n + 'pid', pid, 'pid', a);
    } else if (NAMED.has(a.type)) virt('name', 'name', reading && readable);
  }
  const pn = info.primaryNameAttribute, pk = info.primaryIdAttribute;
  const rank = c => (c.virtual ? 2 : c.name === pn ? 0 : c.name === pk ? 1 : 2);
  return out.sort((x, y) => rank(x) - rank(y) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

const META_TYPE = { string: 'nvarchar', guid: 'uniqueidentifier', bit: 'bit', int: 'int', float: 'float', datetime: 'datetime', any: 'sql_variant' };

// SQL type text of a completion column ('nvarchar(100)', 'decimal(14,2)', 'uniqueidentifier', …).
function colType(c) {
  if (c.type != null) return c.type;
  if (c.attr) return typeName(dtOfAttr(c.attr));
  return c.virtual ? 'nvarchar' : '';
}

function colIcon(c) {
  if (c.virtual || !c.attr) return c.virtual ? 'text' : 'column';
  const a = c.attr;
  if (a.isPk) return 'key';
  switch (a.type) {
    case 'String': case 'EntityName': return 'text';
    case 'Memo': return 'memo';
    case 'Integer': case 'BigInt': case 'Decimal': case 'Double': return 'number';
    case 'Money': return 'money';
    case 'DateTime': return 'calendar';
    case 'Boolean': return 'bool';
    case 'Picklist': case 'State': case 'Status': return 'choice';
    case 'MultiSelectPicklist': return 'multiselect';
    case 'Lookup': case 'Customer': case 'Owner': return 'relation';
    case 'Uniqueidentifier': return 'guid';
    case 'Image': return 'image';
    case 'File': return 'file';
    default: return 'column';
  }
}

function tableIcon(e) {
  if (!e) return 'table';
  if (e.isActivity) return 'activity';
  if (e.isIntersect) return 'intersect';
  if (e.kind === 'virtual') return 'virtual';
  if (e.kind === 'elastic') return 'elastic';
  return 'table';
}

// Whether the argument `n` (0-based) of the call whose arguments are [r.a, r.b) is the constant 1, also written in
// parentheses or as a string ('1'): STRING_SPLIT's enable_ordinal (functions.js: the constant compared with
// Number(), 1 adds the column ordinal; 0, NULL and an omitted argument do not).
function constArgIsOne(sig, r, match, n) {
  if (!r || r.b <= r.a) return false;
  let at = r.a, idx = 0;
  for (let k = r.a; k < r.b && idx < n; k++) {
    if (isOp(sig[k], '(') && match[k] >= 0) k = match[k];
    else if (isOp(sig[k], ',')) { idx++; at = k + 1; }
  }
  if (idx < n) return false;
  let a = at, b = a;
  while (b < r.b && !isOp(sig[b], ',')) { if (isOp(sig[b], '(') && match[b] >= 0) b = match[b]; b++; }
  while (b - a >= 3 && isOp(sig[a], '(') && match[a] === b - 1) { a++; b--; }
  const t = b - a === 1 ? sig[a] : null;
  return !!t && (t.t === 'num' || t.t === 'str') && Number(t.v) === 1;
}

// The scalar types of meta.messages() responses (02 §2's type vocabulary; EntityReference gives the record's id).
const SCALAR_RESPONSE = /^(Guid|String|Boolean|Integer|Int16|Int32|Int64|BigInt|Decimal|Double|Float|Single|Byte|DateTime|Date|Time|Duration|Binary|Money|Picklist|EntityReference)$/i;
const AUDIT_RESPONSE = /^AuditDetail(Collection)?$/i;

// The 02 §9 response shape of a meta.messages() response property type: {shape: 'scalar' (e), 'entity' (a: a
// table's rows; table null when any table may come), 'audit' (b), 'array' (d: of scalars; item = the element type),
// 'object' (c: a type the metadata does not know)}.
function responseShape(type, src) {
  const t = String(type ?? '');
  if (SCALAR_RESPONSE.test(t)) return { shape: 'scalar' };
  if (AUDIT_RESPONSE.test(t)) return { shape: 'audit' };
  if (/^StringArray$/i.test(t)) return { shape: 'array', item: 'String' };
  if (/^Entity(Collection)?$/i.test(t)) return { shape: 'entity', table: null };
  const el = t.endsWith('[]') ? t.slice(0, -2) : t;
  if (t.endsWith('[]') && SCALAR_RESPONSE.test(el)) return { shape: 'array', item: el };
  // a table is named by its logical name (lower case, meta.js); a complex type (OrganizationDetail) never is one
  const e = el && el === el.toLowerCase() ? src.find(el) : null;
  return e ? { shape: 'entity', table: e.logicalName } : { shape: 'object' };
}

// Columns of a Web API function used as a table (02 §9 response shapes; 02 §2): a function whose answer is an
// entity (responseEntity) gives that table's columns; otherwise the first response property of shape (a)-(d) decides,
// in response order: (a) the readable columns of its table with the 01 §6.3 virtual columns, (b) the audit table's
// columns plus `oldvalues` and `newvalues` nvarchar(max), (c) one column named after the property (its JSON text; the
// `<property>_<member>` columns depend on the answer), (d) one column named after the property; without such a property
// every scalar property is a column (e). {cols, loading}.
function messageCols(m, src, purpose) {
  const tableCols = (name, extra = []) => {
    const e = name ? src.find(name) : null;
    if (!e) return { cols: extra, loading: false };
    const full = src.entity(e.logicalName);
    return full ? { cols: [...tableColumns(full, purpose), ...extra], loading: false } : { cols: [], loading: true };
  };
  const re = m.responseEntity;
  if (re) return re === 'Entity' || re === 'expando' ? { cols: [], loading: false } : tableCols(re);
  const response = m.response ?? [];
  for (const r of response) {
    const sh = responseShape(r.type, src);
    if (sh.shape === 'scalar') continue;
    if (sh.shape === 'entity') return tableCols(sh.table);
    if (sh.shape === 'audit') return tableCols('audit', [{ name: 'oldvalues', type: 'nvarchar(max)' }, { name: 'newvalues', type: 'nvarchar(max)' }]);
    return { cols: [{ name: r.name, type: sh.shape === 'array' ? sh.item : 'nvarchar(max)' }], loading: false };
  }
  return { cols: response.map(r => ({ name: r.name, type: r.type })), loading: false };
}

// Whether a table source is the nodes() method of an xml value (`CROSS APPLY @x.nodes('/a') AS t(c)`, 01 §8.3).
const isNodesCall = s => s.kind === 'tvf' && Array.isArray(s.parts) && s.parts.length > 1 && lower(s.parts[s.parts.length - 1]) === 'nodes' &&
  !(s.parts.length === 2 && SCHEMAS.has(lower(s.parts[0])));

// Columns of a source in the analysed statement: {cols, loading}; derived tables and CTEs are read from their
// select lists (`*` expanded from their own sources, at most 3 levels deep).
function sourceCols(s, ctx, src, purpose = 'read', depth = 0) {
  const none = { cols: [], loading: false };
  if (!s) return none;
  const sig = ctx.lex.sig, match = ctx.lex.match;
  const named = list => ({ cols: list.map(n => ({ name: n, type: '' })), loading: false });
  switch (s.kind) {
    case 'table': case 'archive': case 'bin': {
      const e = src.find(s.name);
      if (!e) return none;
      const full = src.entity(e.logicalName);
      return full ? { cols: tableColumns(full, purpose), loading: false } : { cols: [], loading: true };
    }
    case 'meta': {
      const m = META_TABLES.find(t => t.name === lower(s.name));
      return { cols: m ? m.columns.map(c => ({ name: c.name, type: META_TYPE[c.dt] ?? c.dt, meta: m.name })) : [], loading: false };
    }
    case 'sys':
      return { cols: lower(s.name) === 'messages' ? SYS_MESSAGES_COLS.map(([name, type]) => ({ name, type, sys: 'messages' })) : [], loading: false };
    case 'temp': {
      const t = src.temps().get(lower(s.name));
      if (t && Array.isArray(t.columns)) return { cols: t.columns.map(c => ({ name: c.name, type: typeName(c) })), loading: false };
      const d = ctx.temps.get(lower(s.name));
      return { cols: d ? d.cols.map(c => ({ name: c.name, type: c.type })) : [], loading: false };
    }
    case 'tvar': {
      const v = ctx.vars.find(x => lower(x.name) === lower(s.name));
      return { cols: v && v.cols ? v.cols.map(c => ({ name: c.name, type: c.type })) : [], loading: false };
    }
    case 'cte': {
      const c = ctx.ctes.find(x => lower(x.name) === lower(s.name));
      if (!c) return none;
      if (c.cols) return depth < 3 ? typedNames(c.cols, blockCols(c.a, c.b, ctx, src, depth + 1, true)) : named(c.cols);
      return depth < 3 ? blockCols(c.a, c.b, ctx, src, depth + 1) : none;
    }
    case 'derived': case 'values':
      if (s.cols) return s.kind === 'derived' && depth < 3 ? typedNames(s.cols, blockCols(s.a, s.b, ctx, src, depth + 1, true)) : named(s.cols);
      return s.kind === 'derived' && depth < 3 ? blockCols(s.a, s.b, ctx, src, depth + 1) : none;
    case 'tvf': {
      // `x.nodes('…') AS t(c)` (01 §8.3): its columns are xml
      if (isNodesCall(s)) return { cols: (s.cols ?? []).map(n => ({ name: n, type: 'xml' })), loading: false };
      if (s.cols) return named(s.cols);
      const up = String(s.name).toUpperCase();
      if (up === 'STRING_SPLIT') return { cols: [{ name: 'value', type: 'nvarchar' }, ...(constArgIsOne(sig, s.args, match, 2) ? [{ name: 'ordinal', type: 'bigint' }] : [])], loading: false };
      if (up === 'GENERATE_SERIES') return { cols: [{ name: 'value', type: '' }], loading: false };
      if (up === 'OPENJSON') return s.withCols && s.withCols.length ? { cols: s.withCols, loading: false } : { cols: [{ name: 'key', type: 'nvarchar(4000)' }, { name: 'value', type: 'nvarchar(max)' }, { name: 'type', type: 'int' }], loading: false };
      if (up === 'FN_HELPCOLLATIONS') return { cols: HELPCOLLATIONS_COLS.map(([name, type]) => ({ name, type })), loading: false };
      const msgs = src.messages();
      if (!msgs) return { cols: [], loading: true };
      const m = msgs.get(lower(s.name));
      return m ? messageCols(m, src, purpose) : none;
    }
    default: return none;
  }
}

// Output columns of the query block [a, b): the select list's names, typed xml where the expression is (exprIsXml;
// other types are not derived), and `*` expanded from the block's sources. `positional`: the items without a name
// too (name ''), for a column list that names them by position (typedNames).
function blockCols(a, b, ctx, src, depth, positional = false) {
  const sig = ctx.lex.sig, match = ctx.lex.match;
  const items = selectList(sig, a, b, match);
  const cols = [];
  let info = null;
  let loading = false;
  const sources = () => {
    if (!info) {
      let sa = a;
      for (const seg of segmentsOf(sig, a, b, match)) if (isKw(sig[seg.a], 'SELECT')) { sa = seg.a; break; }
      const seg = segmentsOf(sig, sa, b, match)[0];
      info = segmentInfo(sig, seg.a, seg.b, match, ctx.cteNames);
    }
    return info.sources;
  };
  for (const it of items) {
    if (!it.star) {
      if (it.name || positional) cols.push({ name: it.name ?? '', type: exprIsXml(sig, it.xa, it.xb, match, ctx, src, sources, depth) ? 'xml' : '' });
      continue;
    }
    for (const s of sources()) {
      if (it.qualifier && refOf(s) !== it.qualifier) continue;
      const r = sourceCols(s, ctx, src, 'read', depth);
      loading = loading || r.loading;
      cols.push(...r.cols);
    }
  }
  return { cols, loading };
}

// Whether the expression sig[xa, xb) of a select-list item has static type xml (01 §8.3): CAST / TRY_CAST (… AS
// xml), CONVERT / TRY_CONVERT (xml, …), an xml method `.query(…)`, `(SELECT … FOR XML …, TYPE)`, an xml variable, or a
// column typed xml of the block's own sources (`sources()`: a #temp, table variable, CTE, derived table or nodes()
// column; a Dataverse or metadata column is never xml).
function exprIsXml(sig, xa, xb, match, ctx, src, sources, depth) {
  while (xb - xa >= 2 && isOp(sig[xa], '(') && match[xa] === xb - 1 && !SUBQ(sig[xa + 1])) { xa++; xb--; }
  if (!(xb > xa)) return false;
  const l = sig[xb - 1];
  if (isOp(l, ')')) {
    const o = match[xb - 1];
    return o >= xa && exprStartOfParen(sig, o, match) === xa && xmlParen(sig, xb - 1, match);
  }
  if (xb - xa === 1 && l.t === 'var') {
    const v = ctx.vars.find(x => lower(x.name) === lower(l.raw ?? l.v));
    return !!v && !v.cols && XML_TYPE.test(String(v.type ?? ''));
  }
  const ch = chainEndingAt(sig, xb - 1);
  if (!ch || ch.a !== xa || sig[ch.a].t === 'var') return false;
  const name = lower(ch.parts[ch.parts.length - 1]);
  const q = ch.parts.length > 1 ? lower(ch.parts[ch.parts.length - 2]) : null;
  for (const s of sources()) {
    if (TABLE_KINDS.has(s.kind) || s.kind === 'meta' || s.kind === 'sys' || (q && refOf(s) !== q)) continue;
    const col = sourceCols(s, ctx, src, 'read', depth).cols.find(c => lower(c.name) === name);
    if (col) return XML_TYPE.test(String(col.type ?? ''));
  }
  return false;
}

// Names of a CTE's or derived table's column list typed from its query's columns by position, when the counts agree.
function typedNames(names, r) {
  const same = r.cols.length === names.length;
  return { cols: names.map((n, k) => ({ name: n, type: same ? r.cols[k].type ?? '' : '' })), loading: false };
}

// The source a qualifier names (alias, else unaliased table name), in the scope and outer scopes, else a table,
// #temp or CTE named directly.
function sourceFor(ctx, qualifier, src) {
  const parts = Array.isArray(qualifier) ? qualifier : [qualifier];
  // `x..name` / `..name`: the '.' before the name follows no name, so nothing qualifies it (the parser refuses it)
  if (!parts.length || parts.some(p => typeof p !== 'string')) return null;
  const qn = lower(parts[parts.length - 1]);
  const all = [...ctx.scope, ...ctx.outer];
  const hit = all.find(s => refOf(s) === qn) ?? (parts.length === 1 ? all.find(s => lower(s.name) === qn) : null);
  if (hit) return hit;
  const c = classify(parts, parts[0].startsWith('@'), ctx.cteNames);
  if (c.kind === 'table' && !src.find(c.name)) return null;
  return { ...c, parts, alias: null };
}

// The column a reference names (`a.col` or an unambiguous bare `col`): {col, source} | {loading: true} | null.
// `purposes` are tried in order (tableColumns purposes): hover cards try 'read' and then 'any', so a column that is
// not valid for read still has a card, while the readable columns alone decide whether a bare name is ambiguous. A
// bare name is resolved only once every source of its scope level is loaded: until then a single hit may still
// turn out ambiguous, so it is {loading: true}.
function resolveColumn(ctx, parts, src, purposes = ['read']) {
  const name = lower(parts[parts.length - 1]);
  if (parts.length > 1) {
    const s = sourceFor(ctx, parts.slice(0, -1), src);
    if (!s) return null;
    let loading = false;
    for (const purpose of purposes) {
      const r = sourceCols(s, ctx, src, purpose);
      const col = r.cols.find(c => lower(c.name) === name);
      if (col) return { col, source: s };
      loading = loading || r.loading;
    }
    return loading ? { loading: true } : null;
  }
  for (const level of [ctx.scope, ctx.outer]) {
    for (const purpose of purposes) {
      const hits = [];
      let loading = false;
      for (const s of level) {
        const r = sourceCols(s, ctx, src, purpose);
        loading = loading || r.loading;
        const col = r.cols.find(c => lower(c.name) === name);
        if (col) hits.push({ col, source: s });
      }
      if (hits.length > 1) return null;
      if (loading) return { loading: true };
      if (hits.length === 1) return hits[0];
    }
  }
  return null;
}

// Whether the qualifier `parts` of `parts.|` names a value of static type xml (01 §8.3): an xml variable, or an
// xml column (a #temp, table-variable or CTE column declared xml, or a nodes() column). A table or alias of that name
// wins, as in T-SQL name resolution.
function qualifierIsXml(ctx, parts, src) {
  if (!parts.length || parts.some(p => typeof p !== 'string' || !p)) return false;
  if (parts[0].startsWith('@')) {
    const v = parts.length === 1 ? ctx.vars.find(x => lower(x.name) === lower(parts[0])) : null;
    return !!v && !v.cols && XML_TYPE.test(String(v.type ?? ''));
  }
  if (parts.length === 1 && sourceFor(ctx, parts, src)) return false;
  const r = resolveColumn(ctx, parts, src);
  return !!r && !r.loading && !!r.col && XML_TYPE.test(String(r.col.type ?? ''));
}

// ------------------------------------------------------------------------------------------------- items

const KIND_ICON = {
  table: 'table', column: 'column', alias: 'table', function: 'fx', message: 'cloud', keyword: 'code', snippet: 'sparkle',
  template: 'list', variable: 'sigma', temp: 'rows', cte: 'layers', meta: 'db', hint: 'settings', join: 'link', condition: 'link',
  value: 'choice', type: 'code', datepart: 'calendar', param: 'pin', cursor: 'rows', label: 'right',
};
const item = (kind, label, insert, o = {}) => ({ kind, label, insert, detail: '', icon: KIND_ICON[kind], group: 0, sort: 0, ...o });

// Keyword list from a compact spec: '~' = a space inside the keyword, '_' suffix = insert a trailing space,
// '>' suffix = reopen the list after inserting it.
function kws(spec, group = 3) {
  return spec.split(' ').filter(Boolean).map((w, n) => {
    let s = w;
    const re = s.endsWith('>');
    if (re) s = s.slice(0, -1);
    const sp = s.endsWith('_');
    if (sp) s = s.slice(0, -1);
    const label = s.replace(/~/g, ' ');
    return item('keyword', label, label + (sp ? ' ' : ''), { group, sort: n, retrigger: re });
  });
}

const KW = {
  starters: 'SELECT_ INSERT~INTO_> UPDATE_> DELETE~FROM_> DECLARE_ SET_ IF_ ELSE WHILE_ BEGIN END BEGIN~TRY END~TRY BEGIN~CATCH END~CATCH PRINT_ ' +
    'EXEC_> WITH_ CREATE~TABLE_ DROP~TABLE_> DROP~TABLE~IF~EXISTS_> TRUNCATE~TABLE_> EXECUTE~AS~USER~=_ REVERT THROW_ RAISERROR( RETURN BREAK ' +
    'CONTINUE WAITFOR~DELAY_ WAITFOR~TIME_ GOTO_ OPEN_> FETCH~NEXT~FROM_> CLOSE_> DEALLOCATE_> SET~NOCOUNT~ON SET~DATEFORMAT_ SET~DATEFIRST_ ' +
    'SET~LANGUAGE_ SET~QUOTED_IDENTIFIER~OFF SET~QUOTED_IDENTIFIER~ON',
  setops: 'UNION_ UNION~ALL_ EXCEPT_ INTERSECT_',
  forjson: 'FOR~JSON~PATH FOR~JSON~AUTO FOR~XML~PATH FOR~XML~RAW FOR~XML~AUTO',
  joins: 'JOIN_> INNER~JOIN_> LEFT~JOIN_> RIGHT~JOIN_> FULL~JOIN_> CROSS~JOIN_> CROSS~APPLY_> OUTER~APPLY_>',
  nestedJoins: 'JOIN_> INNER~JOIN_> LEFT~JOIN_> RIGHT~JOIN_> FULL~JOIN_>',
  logic: 'AND_ OR_ IS~NULL IS~NOT~NULL IN~( NOT~IN~( LIKE_ NOT~LIKE_ BETWEEN_ NOT~BETWEEN_',
  exprStart: 'CASE_ NULL NOT_',
  predStart: 'NOT_ EXISTS~( CASE_ NULL',
};

// CASE keywords after an operand, by the last keyword of the innermost open CASE.
const CASE_KW = { CASE: 'WHEN_', WHEN: 'THEN_', THEN: 'WHEN_ ELSE_ END', ELSE: 'END' };

// Keyword items valid after an operand in clause `clause` (03 §5 'keywords valid here').
function afterKeywords(ctx) {
  const c = ctx.clause;
  if (ctx.inCase) return kws(CASE_KW[ctx.inCase], 2).concat(ctx.inCase === 'WHEN' ? kws(KW.logic) : []);
  if (ctx.nested) return kws('AND_ OR_ IS~NULL IS~NOT~NULL IN~( LIKE_ BETWEEN_ AS_ FROM_ ORDER~BY_ DESC ASC');
  const tail = `OPTION~(> ${KW.setops} ${KW.forjson}`;
  const hint = ctx.hintable ? ' WITH~(NOLOCK)' : '';
  const dml = !!ctx.seg && (ctx.seg.kind === 'UPDATE' || ctx.seg.kind === 'DELETE');
  const spec = {
    select: `FROM_> AS_ INTO_ ORDER~BY_ ${tail}`,
    // AS is offered at the alias position (aliasKeywords), never after an alias, table hints or an ON condition; a
    // JOIN source without its ON takes only ON, its table hints and further joins (whose ONs come first), and the
    // FROM, ON and WHERE of an UPDATE / DELETE take no GROUP BY, HAVING, ORDER BY, set operator or FOR (the parser as
    // the oracle); HAVING without GROUP BY is valid
    from: ctx.needOn ? `ON_>${hint} ${KW.nestedJoins}` : dml ? `WHERE_ ${KW.joins} OPTION~(>${hint}` :
      `WHERE_ ${KW.joins} GROUP~BY_ HAVING_ ORDER~BY_ ${tail}${hint} PIVOT~( UNPIVOT~(`,
    on: dml ? `${KW.logic} WHERE_ ${KW.joins} OPTION~(>` : `${KW.logic} WHERE_ ${KW.joins} GROUP~BY_ HAVING_ ORDER~BY_ ${tail}`,
    where: dml ? `${KW.logic} OPTION~(>` : `${KW.logic} GROUP~BY_ HAVING_ ORDER~BY_ ${tail}`,
    having: `${KW.logic} ORDER~BY_ ${tail}`,
    group: `HAVING_ ORDER~BY_ WITH~ROLLUP WITH~CUBE ${tail}`,
    order: `${ctx.sorted ? '' : 'ASC DESC COLLATE_> '}OFFSET_ ${tail}`,
    offset: 'ROWS ROW FETCH~NEXT_ ONLY',
    set: 'FROM_> WHERE_ OUTPUT_ OPTION~(>',
    update: 'SET_ WITH~(NOLOCK)',
    delete: 'FROM_> WHERE_ OUTPUT_ OPTION~(>',
    insert: 'VALUES~( SELECT_ OUTPUT_ DEFAULT~VALUES',
    output: 'INTO_> FROM_> WHERE_ VALUES~( SELECT_',
    into: 'FROM_> WHERE_',
    if: `${KW.logic} BEGIN`,
    while: `${KW.logic} BEGIN`,
  }[c];
  const items = spec ? kws(spec) : [];
  // a JOIN that still needs its ON ends no statement
  return c === 'from' && ctx.needOn ? items : items.concat(kws(KW.starters, 6));
}

// Keyword items at an alias position (03 §5): only what may follow a FROM / JOIN / APPLY source that has no alias
// yet, with the parser as the oracle. A derived table, VALUES list, PIVOT / UNPIVOT or nodes() call needs its alias, so
// only AS follows it; a JOIN source without its ON takes ON (first), AS, its table hints and further joins (their ONs
// come first: `a JOIN b JOIN c ON … ON …`); OPENJSON(…) without a WITH schema also takes `WITH (` (01 §8).
function aliasKeywords(ctx) {
  const s = ctx.source;
  if (s && (s.kind === 'derived' || s.kind === 'values' || s.kind === 'pivot' || isNodesCall(s))) return kws('AS_', 3);
  const hint = s && TABLE_KINDS.has(s.kind) ? ' WITH~(NOLOCK)' : '';
  const schema = s && s.kind === 'tvf' && String(s.name).toUpperCase() === 'OPENJSON' && !s.withCols && (s.parts ?? []).length === 1 ? ' WITH~(' : '';
  if (ctx.needOn) return kws(`ON_> AS_${hint}${schema} ${KW.nestedJoins}`, 3);
  const dml = !!ctx.seg && (ctx.seg.kind === 'UPDATE' || ctx.seg.kind === 'DELETE');
  const rest = dml ? `WHERE_ ${KW.joins} OPTION~(>${hint}${schema}` :
    `WHERE_ ${KW.joins} GROUP~BY_ HAVING_ ORDER~BY_ OPTION~(> ${KW.setops} ${KW.forjson}${hint}${schema} PIVOT~( UNPIVOT~(`;
  return kws(`AS_ ${rest}`, 3);
}

// Keyword items at the start of an expression in the current clause.
function exprKeywords(ctx) {
  if (ctx.afterSelect) return kws(`DISTINCT_ TOP_ ${KW.exprStart}`);
  if (ctx.afterDistinct) return kws(`TOP_ ${KW.exprStart}`);
  if (ctx.afterTop) return kws(`${ctx.afterTop === 'n' ? 'PERCENT_ ' : ''}${ctx.afterTop !== 'ties' ? 'WITH~TIES_ ' : ''}${KW.exprStart}`);
  if (ctx.afterCase) return kws(`WHEN_ ${KW.exprStart}`);
  const c = ctx.clause;
  if (c === 'where' || c === 'on' || c === 'having' || c === 'if' || c === 'while') return kws(KW.predStart);
  if (c === 'values') return kws('NULL DEFAULT CASE_');
  if (c === 'group' || c === 'order') return kws('CASE_');
  return kws(KW.exprStart);
}

let fnCache = null;
// Built-in functions callable in expressions: FUNCTION_DOCS names of the scalar, aggregate and window tables plus
// the special forms (AT TIME ZONE and the FetchXML conditions are not callable here, 01 §8).
function functionItems() {
  if (fnCache) return fnCache;
  const names = new Set([...SCALARS.keys(), ...AGGREGATES.keys(), ...WINDOWS.keys(), 'CAST', 'TRY_CAST', 'CONVERT', 'TRY_CONVERT', 'GROUPING', 'GROUPING_ID']);
  names.delete('AT_TIME_ZONE');
  fnCache = [...names].map(n => {
    const doc = docFor(n);
    const label = doc ? doc.name : n;
    return item('function', label, fnInsert(label, doc), { detail: doc ? doc.display.replace(/\.\.\./g, '…') : '', group: 4, ref: { t: 'function', name: label } });
  });
  return fnCache;
}

// The text a function item inserts: NAME( / NAME() / CURRENT_USER / NAME() OVER (.
function fnInsert(name, doc) {
  if (NILADIC.has(name.toUpperCase())) return name;
  if (!doc) return name + '(';
  const args = doc.params.filter(p => !p.clause);
  if (doc.sig.startsWith('()')) return name + '() OVER (';
  if (!args.length && !/\[/.test(doc.sig)) return name + '()';
  return name + '(';
}

// FetchXML condition function items of the given kinds (02 §4.2, 01 §8).
function fetchItems(kinds) {
  const out = [];
  for (const f of FETCH_CONDITIONS.values()) {
    if (!kinds.includes(f.kind)) continue;
    const doc = docFor(f.name);
    out.push(item('function', f.name, f.name + (f.max === 0 ? '()' : '('), { detail: doc ? doc.display.replace(/\.\.\./g, '…') : '', icon: f.kind === 'user' || f.kind === 'business' ? 'user' : f.kind === 'hierarchy' ? 'relation' : f.kind === 'string' ? 'text' : 'calendar', group: -1, ref: { t: 'function', name: f.name } }));
  }
  return out;
}

const SNIPPETS = [['sel', 'SELECT TOP 100 * FROM ', null, true], ['cnt', 'SELECT COUNT(*) FROM ', null, true], ['upd', 'UPDATE  SET  WHERE ', 7, false]];

// Snippet items (03 §5); `query` = only the ones that are a query (inside a subquery or derived table).
function snippetItems(group, query = false) {
  return SNIPPETS.filter(s => !query || s[1].startsWith('SELECT ')).map(([label, insert, caret, re], n) => item('snippet', label, insert, {
    detail: insert.trim().replace(/\s+/g, ' '), group, sort: n, sel: caret != null ? [caret, caret] : null, retrigger: re, ref: { t: 'snippet', sql: insert },
  }));
}

function templateItems(src) {
  return src.templates().filter(t => t && typeof t.sql === 'string' && t.title).map((t, n) => item('template', String(t.title), t.sql, {
    detail: 'Template', group: -2, sort: n, ref: { t: 'template', tpl: t },
  }));
}

// Column items of one source list; names that appear in several sources are qualified.
function columnItems(ctx, src, sources, group, forceQualify, purpose = 'read') {
  const lists = sources.map(s => ({ s, ...sourceCols(s, ctx, src, purpose) }));
  const counts = new Map();
  for (const l of lists) for (const c of l.cols) counts.set(lower(c.name), (counts.get(lower(c.name)) ?? 0) + 1);
  const items = [];
  let loading = false;
  lists.forEach((l, si) => {
    loading = loading || l.loading;
    const ref = l.s.alias || l.s.name || '';
    l.cols.forEach((c, ci) => {
      if (!c.name) return;
      const q = !!ref && (forceQualify || counts.get(lower(c.name)) > 1);
      const display = c.attr?.displayName || '';
      const type = colType(c);
      items.push(item('column', q ? `${ref}.${c.name}` : c.name, q ? `${nameSql(ref)}.${nameSql(c.name)}` : nameSql(c.name), {
        filter: c.name, fo: q ? String(ref).length + 1 : 0, detail: [display, type].filter(Boolean).join(' · '), alt: display || null,
        icon: colIcon(c), group, sort: si * 100000 + ci, ref: { t: 'column', col: c, source: l.s },
      }));
    });
  });
  return { items, loading };
}

function aliasItems(ctx) {
  const out = [];
  const seen = new Set();
  for (const s of [...ctx.scope, ...ctx.outer]) {
    const r = s.alias || s.name;
    if (!r || seen.has(lower(r))) continue;
    seen.add(lower(r));
    out.push(item('alias', r, nameSql(r), { detail: s.alias && s.name ? s.name : sourceKindText(s), icon: s.kind === 'meta' ? 'db' : s.kind === 'temp' ? 'rows' : 'table', group: 2, ref: refForSource(s, ctx) }));
  }
  return out;
}

const sourceKindText = s => ({ derived: 'Derived table', values: 'VALUES table', tvf: 'Table-valued function', cte: 'Common table expression', temp: 'Temporary table', tvar: 'Table variable', meta: 'Metadata table', pivot: 'Pivot' }[s.kind] ?? 'Table');

// The card target of a source (its alias item's side panel).
function refForSource(s, ctx) {
  switch (s.kind) {
    case 'table': case 'archive': case 'bin': return { t: 'table', name: s.name, schema: s.kind === 'table' ? null : s.kind };
    case 'meta': return { t: 'meta', table: lower(s.name) };
    case 'temp': return { t: 'temp', name: s.name };
    case 'tvar': { const v = ctx.vars.find(x => lower(x.name) === lower(s.name)); return v ? { t: 'variable', v, text: ctx.text } : null; }
    case 'cte': return { t: 'cte', name: s.name };
    default: return { t: 'source', source: s };
  }
}

// Table-position items (03 §5): tables, metadata.*, sys.messages and sys.fn_helpcollations(), archive./bin.
// tables, #temp tables, table variables, CTEs, TVFs and the xml variables' nodes(). At the target of UPDATE, DELETE or INSERT (`ctx.dml`)
// only writable targets: Dataverse tables, #temp tables, table variables, the statement's CTEs and, for DELETE,
// bin. tables, after the aliases of the statement's FROM clause and the keyword INTO / FROM that may come first.
function tableItems(ctx, src) {
  const out = [];
  const p = lower(ctx.prefix);
  const dml = ctx.dml ?? null;
  let loading = false;
  const tempItems = () => {
    const seen = new Set();
    for (const t of src.temps().values()) {
      if (!t || !t.name || seen.has(lower(t.name))) continue;
      seen.add(lower(t.name));
      out.push(item('temp', t.name, nameSql(t.name), { detail: `Temporary table · ${fmtInt(Array.isArray(t.rows) ? t.rows.length : 0)} rows`, ref: { t: 'temp', name: t.name } }));
    }
    for (const t of ctx.temps.values()) if (!seen.has(lower(t.name))) { seen.add(lower(t.name)); out.push(item('temp', t.name, nameSql(t.name), { detail: 'Temporary table (created by this script)', ref: { t: 'temp', name: t.name } })); }
  };
  // table variables of the batch, where a table is expected (03 §5 otherwise)
  const tvarItems = () => {
    const seen = new Set();
    for (const v of ctx.vars) {
      if (!v.cols || seen.has(lower(v.name))) continue;
      seen.add(lower(v.name));
      out.push(item('variable', v.name, v.name, { detail: 'Table variable', icon: 'rows', group: 1, ref: { t: 'variable', v, text: ctx.text } }));
    }
  };
  if (ctx.only === 'temp' || ctx.only === 'output') {
    tempItems();
    if (ctx.only === 'output') tvarItems();
    return { items: out, loading };
  }
  const entityItem = (e, prefix, group, detailSuffix = '') => item('table', prefix + e.logicalName, prefix + nameSql(e.logicalName), {
    filter: prefix ? e.logicalName : undefined, fo: prefix.length, detail: (e.displayName || '') + detailSuffix, alt: e.displayName || null,
    icon: tableIcon(e), group, ref: { t: 'table', name: e.logicalName, schema: prefix ? prefix.slice(0, -1) : null },
  });
  const archived = e => e.isRetentionEnabled === true || e.isArchivalEnabled === true;
  const visible = e => !e.isPrivate || (p && lower(e.logicalName).startsWith(p));
  const schema = ctx.schema ?? null;
  const ents = src.entities();
  const binItems = (prefix, group, suffix) => {
    const b = src.bin();
    if (!b) { loading = true; return; }
    for (const e of ents) if (b.has(e.logicalName)) out.push(entityItem(e, prefix, group, suffix));
  };
  if (ctx.only === 'truncate') {
    // TRUNCATE TABLE: a Dataverse table (an unfiltered delete, 02 §8.1) or a #temp table
    for (const e of ents) if (visible(e)) out.push(entityItem(e, '', 0));
    tempItems();
    return { items: out, loading };
  }
  if (dml) {
    if (schema === 'bin') { if (dml === 'DELETE') binItems('', 0, ''); return { items: out, loading }; }
    if (schema && schema !== 'dbo') return { items: out, loading };
    for (const s of ctx.dmlSources ?? []) {
      const r = s.alias || s.name;
      if (!r || schema) continue;
      out.push(item('alias', r, nameSql(r), { detail: s.alias && s.name ? s.name : sourceKindText(s), icon: s.kind === 'temp' ? 'rows' : 'table', group: -2, ref: refForSource(s, ctx) }));
    }
    if (ctx.kwFirst && !schema) out.push(...kws(`${ctx.kwFirst}_>`, -1));
    for (const e of ents) if (visible(e)) out.push(entityItem(e, '', 0));
    if (schema) return { items: dedupe(out), loading };
    tempItems();
    tvarItems();
    for (const c of ctx.ctes) out.push(item('cte', c.name, nameSql(c.name), { detail: 'Common table expression', ref: { t: 'cte', name: c.name } }));
    if (dml === 'DELETE') binItems('bin.', 2, ' (recycle bin)');
    return { items: dedupe(out), loading };
  }
  // APPLY takes a table-valued function: of the schemas only sys. has one
  if (ctx.apply && schema && schema !== 'sys') return { items: out, loading };
  if (schema === 'metadata') {
    for (const m of META_TABLES) out.push(item('meta', m.name, m.name, { detail: 'Metadata table', ref: { t: 'meta', table: m.name } }));
    return { items: out, loading };
  }
  if (schema === 'sys') {
    if (!ctx.apply) out.push(item('meta', 'messages', 'messages', { detail: 'System view', ref: { t: 'sys', name: 'messages' } }));
    out.push(item('function', 'fn_helpcollations', 'fn_helpcollations()', { detail: 'Table-valued function', ref: { t: 'function', name: 'FN_HELPCOLLATIONS' } }));
    return { items: out, loading };
  }
  if (schema === 'archive') { for (const e of ents) if (archived(e)) out.push(entityItem(e, '', 0)); return { items: out, loading }; }
  if (schema === 'bin') { binItems('', 0, ''); return { items: out, loading }; }
  if (!ctx.apply) for (const e of ents) if (visible(e)) out.push(entityItem(e, '', 0));
  if (schema) return { items: out, loading };
  if (!ctx.apply) {
    tempItems();
    tvarItems();
    for (const c of ctx.ctes) out.push(item('cte', c.name, nameSql(c.name), { detail: 'Common table expression', ref: { t: 'cte', name: c.name } }));
    for (const m of META_TABLES) out.push(item('meta', `metadata.${m.name}`, `metadata.${m.name}`, { detail: 'Metadata table', group: 1, ref: { t: 'meta', table: m.name } }));
    out.push(item('meta', 'sys.messages', 'sys.messages', { detail: 'System view', group: 1, ref: { t: 'sys', name: 'messages' } }));
    for (const e of ents) if (archived(e)) out.push(entityItem(e, 'archive.', 2, ' (long-term retention)'));
    const b = src.bin();
    if (b) { for (const e of ents) if (b.has(e.logicalName)) out.push(entityItem(e, 'bin.', 2, ' (recycle bin)')); }
  }
  // the xml variables' nodes() (`CROSS APPLY @x.nodes('…') AS t(c)`)
  if (!ctx.derived) out.push(...xmlVarItems(ctx, ctx.apply ? 0 : 2));
  for (const n of TVFS.keys()) {
    const doc = docFor(n);
    const sys = n === 'FN_HELPCOLLATIONS';
    const label = sys ? 'sys.fn_helpcollations' : n;
    out.push(item('function', label, sys ? 'sys.fn_helpcollations()' : n + '(', { detail: doc ? doc.display.replace(/\.\.\./g, '…') : '', group: ctx.apply ? 0 : 2, ref: { t: 'function', name: n } }));
  }
  const msgs = src.messages();
  if (!msgs) loading = true;
  else {
    for (const m of msgs.values()) {
      if (m.kind !== 'function') continue;
      out.push(item('message', m.name, nameSql(m.name) + (m.params.length ? '(' : '()'), { detail: 'Web API function', group: ctx.apply ? 0 : 2, ref: { t: 'message', name: m.name } }));
    }
  }
  return { items: out, loading };
}

// Items without the repeats of a label (an alias of the FROM clause that is also a table name: the alias stays).
function dedupe(items) {
  const seen = new Set();
  return items.filter(i => { const k = i.label; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Join clauses from relationships with the tables already in scope (03 §5): N:1, 1:N and N:N (a double join through
// the intersect table), each with aliases unused in the statement.
function joinItems(ctx, src) {
  const out = [];
  let loading = false;
  const used = new Set();
  for (const s of [...ctx.scope, ...ctx.outer]) { if (s.alias) used.add(lower(s.alias)); if (s.name) used.add(lower(s.name)); }
  const kw = ctx.joinKw || 'JOIN';
  const seen = new Set();
  const push = (label, target, te, detail, sort) => {
    if (seen.has(label)) return;
    seen.add(label);
    out.push(item('join', label, label, { filter: target, alt: te.displayName || null, detail, group: -1, sort, ref: { t: 'table', name: target, code: label } }));
  };
  for (const s of ctx.scope) {
    if (s.kind !== 'table' || s.s >= ctx.from) continue;
    const e = src.find(s.name);
    if (!e) continue;
    const rels = src.rels(e.logicalName);
    if (!rels) { loading = true; continue; }
    const sa = nameSql(s.alias || s.name);
    for (const r of rels.n1) {
      const te = src.find(r.target);
      if (!te) continue;
      const al = uniqueAlias(te.logicalName, new Set(used));
      push(`${nameSql(te.logicalName)} ${al} ON ${al}.${nameSql(r.targetAttr)} = ${sa}.${nameSql(r.attr)}`, te.logicalName, te, `N:1 · ${r.schemaName}`, 0);
    }
    for (const r of rels.oneN) {
      const re = src.find(r.source);
      if (!re) continue;
      const al = uniqueAlias(re.logicalName, new Set(used));
      push(`${nameSql(re.logicalName)} ${al} ON ${al}.${nameSql(r.attr)} = ${sa}.${nameSql(r.sourceAttr)}`, re.logicalName, re, `1:N · ${r.schemaName}`, 1);
    }
    for (const m of rels.nn) {
      const mine1 = m.entity1 === e.logicalName;
      const other = mine1 ? m.entity2 : m.entity1;
      const mineAttr = mine1 ? m.entity1Attr : m.entity2Attr, otherAttr = mine1 ? m.entity2Attr : m.entity1Attr;
      const oe = src.find(other);
      if (!oe || !src.find(m.intersect)) continue;
      const u = new Set(used);
      const ia = uniqueAlias(m.intersect, u), oa = uniqueAlias(other, u);
      push(`${nameSql(m.intersect)} ${ia} ON ${ia}.${nameSql(mineAttr)} = ${sa}.${nameSql(e.primaryIdAttribute)} ${kw} ${nameSql(oe.logicalName)} ${oa} ON ${oa}.${nameSql(oe.primaryIdAttribute)} = ${ia}.${nameSql(otherAttr)}`,
        oe.logicalName, oe, `N:N · ${m.schemaName}`, 2);
    }
  }
  return { items: out, loading };
}

// Relationship-based join conditions between the source just joined and the sources before it (03 §5 ON).
function conditionItems(ctx, src) {
  const out = [];
  let loading = false;
  const J = ctx.joined;
  if (!J || J.kind !== 'table') return { items: out, loading };
  const je = src.find(J.name);
  if (!je) return { items: out, loading };
  const relsJ = src.rels(je.logicalName);
  if (!relsJ) loading = true;
  const ja = nameSql(J.alias || J.name);
  const seen = new Set();
  const push = (label, detail) => { if (!seen.has(label)) { seen.add(label); out.push(item('condition', label, label, { detail, group: -1, sort: out.length })); } };
  for (const E of ctx.scope) {
    if (E === J || E.kind !== 'table' || E.s >= J.s) continue;
    const ee = src.find(E.name);
    if (!ee) continue;
    const ea = nameSql(E.alias || E.name);
    const relsE = src.rels(ee.logicalName);
    if (!relsE) loading = true;
    if (relsJ) {
      for (const r of relsJ.n1) if (r.target === ee.logicalName) push(`${ja}.${nameSql(r.attr)} = ${ea}.${nameSql(r.targetAttr)}`, `N:1 · ${r.schemaName}`);
      for (const m of relsJ.nn) if (m.intersect === ee.logicalName) push(`${ja}.${nameSql(je.primaryIdAttribute)} = ${ea}.${nameSql(m.entity1 === je.logicalName ? m.entity1Attr : m.entity2Attr)}`, `N:N · ${m.schemaName}`);
    }
    if (relsE) {
      for (const r of relsE.n1) if (r.target === je.logicalName) push(`${ja}.${nameSql(r.targetAttr)} = ${ea}.${nameSql(r.attr)}`, `1:N · ${r.schemaName}`);
      for (const m of relsE.nn) if (m.intersect === je.logicalName) push(`${ja}.${nameSql(m.entity1 === ee.logicalName ? m.entity1Attr : m.entity2Attr)} = ${ea}.${nameSql(ee.primaryIdAttribute)}`, `N:N · ${m.schemaName}`);
    }
  }
  return { items: out, loading };
}

// Value items after `<col> =`, `<>`, `IN (` and in containvalues( (03 §5): option values, 0/1, FetchXML date, user,
// hierarchy and text conditions, table names; null when the column is not special (the caller falls back).
function valueItems(ctx, src) {
  const r = resolveColumn(ctx, ctx.column, src);
  if (!r) return null;
  if (r.loading) return { items: [], loading: true };
  const { col } = r;
  const a = col.attr, base = col.base;
  const out = [];
  let loading = false;
  const options = (ent, attr) => { const o = src.options(ent, attr); if (!o) loading = true; return o ?? []; };
  const optionItems = (ent, attr, icon) => {
    // an option value is an integer literal (02 §2); anything else is no value to insert
    for (const o of options(ent, attr)) if (Number.isSafeInteger(o.value)) out.push(item('value', `${o.value} — ${o.label ?? ''}`, String(o.value), { icon, group: -1, sort: out.length, ref: { t: 'option', option: o, col } }));
  };
  if (col.virtual === 'name' && base && (CHOICES.has(base.type) || base.type === 'Boolean' || base.type === 'MultiSelectPicklist')) {
    for (const o of options(col.entity, base.logicalName)) if (o.label) out.push(item('value', o.label, sqlStr(o.label), { detail: String(o.value), group: -1, sort: out.length, ref: { t: 'option', option: o, col } }));
    return { items: out, loading };
  }
  if (col.virtual === 'type' && base) {
    for (const t of base.targets ?? []) { const e = src.find(t); out.push(item('value', t, sqlStr(t), { detail: e?.displayName ?? '', icon: tableIcon(e), group: -1, sort: out.length, ref: { t: 'table', name: t } })); }
    return { items: out, loading };
  }
  if (!a || col.virtual) return null;
  if (ctx.op === 'contain') { if (a.type === 'MultiSelectPicklist') optionItems(col.entity, a.logicalName, 'choice'); return { items: out, loading }; }
  if (CHOICES.has(a.type)) { optionItems(col.entity, a.logicalName, 'choice'); return { items: out, loading }; }
  if (a.type === 'Boolean') { optionItems(col.entity, a.logicalName, 'bool'); return { items: out, loading }; }
  if (a.type === 'EntityName') {
    for (const e of src.entities()) if (!e.isPrivate) out.push(item('value', e.logicalName, sqlStr(e.logicalName), { detail: e.displayName || '', alt: e.displayName || null, icon: tableIcon(e), group: -1, ref: { t: 'table', name: e.logicalName } }));
    return { items: out, loading };
  }
  if (ctx.op !== '=') return null;
  // FetchXML condition functions are conditions on a Dataverse column, valid only in WHERE and ON (01 §8)
  if (ctx.clause !== 'where' && ctx.clause !== 'on') return null;
  if (a.type === 'MultiSelectPicklist') return { items: fetchItems(['multi']), loading };
  if (a.type === 'DateTime') return { items: fetchItems(['date', 'fiscal']), loading };
  if (a.type === 'String' || a.type === 'Memo') return { items: fetchItems(['string']), loading };
  if (a.type === 'Integer' && /language/.test(a.logicalName)) return { items: fetchItems(['language']), loading };
  if (LOOKUPS.has(a.type) || (a.type === 'Uniqueidentifier' && a.isPk)) {
    const targets = LOOKUPS.has(a.type) ? (a.targets ?? []) : [col.entity];
    const kinds = ['hierarchy'];
    if (targets.includes('systemuser') || targets.includes('team')) {
      out.push(item('function', 'CURRENT_USER', 'CURRENT_USER', { detail: 'The current user (systemuserid)', group: -2, ref: { t: 'function', name: 'CURRENT_USER' } }));
      kinds.unshift('user');
    }
    if (targets.includes('businessunit')) kinds.unshift('business');
    out.push(...fetchItems(kinds));
    return { items: out, loading };
  }
  return null;
}

// `@Name = @var OUTPUT` for an output parameter or response property `name`: the variable is the one of
// that name declared in the batch, else `@Name` with its name selected for typing over. {insert, sel}.
function outputArg(ctx, name) {
  const v = ctx.vars.find(x => !x.cols && lower(x.name) === lower('@' + name));
  const head = `@${name} = `;
  if (v) return { insert: `${head}${v.name} OUTPUT`, sel: null };
  return { insert: `${head}@${name} OUTPUT`, sel: [head.length + 1, head.length + 1 + name.length] };
}

// Items for the parameters of `EXEC <message>` that are not given yet (03 §5): the request parameters as
// `@Name = ` (required ones first, each group in position order), then the response properties as `@Name = @var
// OUTPUT`. Positional arguments use the parameters, then the properties, in order.
function paramItems(ctx, src) {
  const { map, loading } = msgsOf(src, true);
  if (!map) return { items: [], loading: true };
  const m = map.get(lower(ctx.message));
  if (!m) return { items: [], loading };
  const used = new Set(ctx.used ?? []);
  const params = m.params ?? [], response = m.response ?? [];
  const pos = Math.max(0, ctx.positional ?? 0);
  // a name that is no plain identifier cannot be written as @name (meta.js lists none such)
  const free = (p, n) => n >= pos && !used.has(lower(p.name)) && PARAM_NAME.test(String(p.name));
  const items = [];
  const req = params.map((p, n) => [p, n]).filter(([p, n]) => free(p, n));
  req.sort((a, b) => (a[0].optional === true) - (b[0].optional === true) || a[1] - b[1]);
  for (const [p] of req) {
    items.push(item('param', '@' + p.name, `@${p.name} = `, {
      detail: p.type + (p.optional ? ' · optional' : ''), sort: items.length, ref: { t: 'param', message: m.name, param: p.name },
    }));
  }
  response.forEach((r, n) => {
    if (!free(r, params.length + n)) return;
    const o = outputArg(ctx, r.name);
    items.push(item('param', '@' + r.name, o.insert, {
      detail: `${r.type} · output`, sort: items.length, sel: o.sel, ref: { t: 'param', message: m.name, param: r.name, output: true },
    }));
  });
  return { items, loading };
}

// Whether OUTPUT may follow the variable of the EXEC argument at the caret (`ctx.execOut`, an execArgs() result,
// 02 §8.1): for a message, when the argument names one of its response properties (`@Prop = @var`) or, given by
// position, falls on one (positional arguments map to the request parameters, then to the response properties); for
// sp_executesql, when it is a parameter the constant @params string declares OUTPUT (any third or later argument when
// @params is no constant string). {ok, loading}.
function execOutputOk(ctx, src) {
  const e = ctx.execOut, x = e.args[e.cur];
  if (!x) return { ok: false, loading: false };
  if (e.dyn) {
    if (x.name === 'stmt' || x.name === 'params' || (!x.name && e.cur < 2)) return { ok: false, loading: false };
    if (e.paramsText == null) return { ok: true, loading: false };
    let decl;
    try { decl = parseParams(e.paramsText, { quotedIdentifier: ctx.qi !== false }); } catch { return { ok: false, loading: false }; }
    const p = x.name ? decl.find(d => lower(String(d.raw ?? d.name).replace(/^@/, '')) === x.name) : decl[e.cur - 2];
    return { ok: !!p && !!p.output, loading: false };
  }
  const { map, loading } = msgsOf(src, true);
  if (!map) return { ok: false, loading: true };
  const m = map.get(lower(e.message));
  if (!m) return { ok: false, loading };
  const params = m.params ?? [], response = m.response ?? [];
  const ok = x.name ? response.some(r => lower(r.name) === x.name) : e.cur >= params.length && e.cur < params.length + response.length;
  return { ok, loading };
}

// Items for the parameter values of `EXEC sp_executesql @stmt, @params, …` (03 §5): from the third argument the
// parameters declared in a constant @params string that are not given yet, as `@name = ` (an OUTPUT parameter as
// `@name = @var OUTPUT`).
function dynParamItems(ctx) {
  if ((ctx.argIndex ?? 0) < 2 || ctx.paramsText == null) return [];
  let decl;
  try { decl = parseParams(ctx.paramsText, { quotedIdentifier: ctx.qi !== false }); } catch { return []; }
  const used = new Set(ctx.used ?? []);
  const pos = Math.max(0, ctx.positional ?? 0);
  const out = [];
  decl.forEach((p, n) => {
    const name = String(p.raw ?? p.name).replace(/^@/, '');
    if (n < pos || used.has(lower(name))) return;
    const type = p.dataType ? lower(p.dataType.name) + (p.dataType.args && p.dataType.args.length ? `(${p.dataType.args.join(', ')})` : '') : '';
    const o = p.output ? outputArg(ctx, name) : { insert: `@${name} = `, sel: null };
    out.push(item('param', '@' + name, o.insert, { detail: type + (p.output ? ' · output' : ''), sort: out.length, sel: o.sel }));
  });
  return out;
}

// Variable items: the variables declared earlier in the batch (scalar ones; table variables only where a table is
// expected, `tableVars`, and there, where a table source goes, `nodesOk`, the xml variables as `@x.nodes(`) and the @@
// globals (not as assignment targets, `assign`: FETCH … INTO).
function variableItems(ctx, group = 0) {
  const out = [];
  const globalsOnly = ctx.prefix.startsWith('@@');
  if (!globalsOnly) {
    const seen = new Set();
    for (const v of ctx.vars) {
      if (seen.has(lower(v.name)) || (ctx.tableVars ? !v.cols : !!v.cols)) continue;
      seen.add(lower(v.name));
      out.push(item('variable', v.name, v.name, { detail: v.type, group, sort: out.length, ref: { t: 'variable', v, text: ctx.text } }));
    }
    // a FROM item or an APPLY right side also takes an xml variable's nodes()
    if (ctx.tableVars && ctx.nodesOk) out.push(...xmlVarItems(ctx, group + 1));
  }
  if (!ctx.tableVars && !ctx.assign) GLOBALS.forEach(([n, text], k) => out.push(item('variable', n, n, { detail: text, group: group + 1, sort: k, ref: { t: 'global', name: n, text } })));
  return out;
}

// The text an OPTION ( item of a hint inserts and the range of its number, selected for typing over (an OPTION item's
// argument, or the n of BATCH_SIZE_n / FETCHXML_PAGE_SIZE_n): {insert, sel}.
function hintInsert(d) {
  const body = d.syntax.slice('OPTION ('.length, -1);
  const m = hintKind(d) === 'option' || d.name.endsWith('_n') ? /\d+/.exec(body) : null;
  return { insert: body, sel: m ? [m.index, m.index + m[0].length] : null };
}

// Hint items after OPTION ( (03 §5): SQL Studio's hints first, then the SQL Server ones (detail 'SQL Server
// hint'); each inserts its syntax.
function hintItems() {
  return HINT_DOCS.filter(d => hintKind(d) !== 'table').map((d, n) => {
    const { insert, sel } = hintInsert(d);
    const sqlserver = d.kind === 'sqlserver';
    return item('hint', d.name, insert, { detail: sqlserver ? 'SQL Server hint' : d.text, group: sqlserver ? 1 : 0, sort: n, sel, ref: { t: 'hint', name: d.name } });
  });
}

// USE HINT('…') names, quoted (SQL Studio's first; a numbered name with its example number selected).
function useHintItems() {
  const out = [];
  HINT_DOCS.forEach((d, n) => {
    if (hintKind(d) !== 'useHint') return;
    const name = /USE HINT\('([A-Z_0-9]+)'\)/.exec(d.syntax)[1];
    const ins = `'${name}'`;
    const dm = d.name.endsWith('_n') ? /\d+/.exec(ins) : null;
    const sqlserver = d.kind === 'sqlserver';
    out.push(item('hint', d.name, ins, { filter: name, detail: sqlserver ? 'SQL Server hint' : d.text, group: sqlserver ? 1 : 0, sort: n, sel: dm ? [dm.index, dm.index + dm[0].length] : null, ref: { t: 'hint', name: d.name } }));
  });
  return out;
}

// Items after EXEC (03 §5): the actions and functions of meta.messages() (with $metadata), each inserting its
// required parameters, then sp_executesql (dynamic SQL).
function execItems(src) {
  const { map, loading } = msgsOf(src, true);
  if (!map) return { items: [], loading: true };
  const out = [];
  for (const m of map.values()) {
    const name = nameSql(m.name);
    if (!name) continue;
    // a message EXEC always refuses (02 §8.1) is listed last, as such, without parameters
    if (REFUSED_EXEC.has(lower(m.name))) {
      out.push(item('message', m.name, name, { detail: 'Refused: use INSERT/UPDATE/DELETE', group: 2, ref: { t: 'message', name: m.name } }));
      continue;
    }
    const req = (m.params ?? []).filter(p => !p.optional && PARAM_NAME.test(String(p.name)));
    const ins = req.length ? `${name} ${req.map(p => `@${p.name} = `).join(', ')}` : name;
    const caret = req.length ? name.length + 1 + `@${req[0].name} = `.length : ins.length;
    out.push(item('message', m.name, ins, { detail: (m.kind === 'action' ? 'Action' : 'Function') + (m.boundTo ? ` · bound to ${m.boundTo}` : ''), sel: [caret, caret], sort: m.kind === 'action' ? 0 : 1, ref: { t: 'message', name: m.name } }));
  }
  out.push(item('keyword', 'sp_executesql', 'sp_executesql ', { detail: 'Dynamic SQL', icon: 'code', group: 1 }));
  return { items: out, loading };
}

// Data type items: every types.js TYPE_NAMES name, in TYPE_ORDER and then any other name alphabetically.
function typeItems(ctx) {
  const names = [...TYPE_ORDER.filter(t => TYPE_NAMES.has(t)), ...[...TYPE_NAMES].filter(t => !TYPE_ORDER.includes(t)).sort()];
  const out = names.map((t, n) => item('type', t, t, { sort: n }));
  if (ctx.declare) out.unshift(...kws('TABLE~(', -1));
  return out;
}

let collCache = null;
// Collation items after COLLATE (03 §5): every SQL_COLLATIONS language base and SQL collation with the
// _CI/_CS × _AI/_AS, _BIN and _BIN2 variants (the _KS, _WS, _SC, _VSS and _UTF8 forms are accepted when typed but
// not listed), built on first use.
function collationItems() {
  if (collCache) return collCache;
  const VARIANT = /_(?:C[IS]_A[IS]|BIN2?)$/;
  collCache = sqlCollations().filter(c => VARIANT.test(c.name)).map((c, n) => item('value', c.name, c.name, {
    detail: c.description, icon: 'text', sort: n, ref: { t: 'collation', name: c.name },
  }));
  return collCache;
}

// Items of a SET statement (01 §4.1 SET options): option names (and the variables right after SET), their values, and
// the words of SET TRANSACTION ISOLATION LEVEL.
function setOptionItems(ctx) {
  const opt = (name, insert, detail, sort, extra = {}) => item('keyword', name, insert, { detail, group: 0, sort, ...extra });
  switch (ctx.stage) {
    case 'name': {
      // after `SET A, ` only the ON / OFF options: `SET A, B value` is a form of theirs alone (01 §4.1)
      const listed = ctx.listed ?? [];
      const onOff = r => r[1] === 'ON' || r[1] === 'ON|OFF';
      if (listed.some(n => !setOptionsByName().has(n) || !onOff(setOptionsByName().get(n)))) return [];
      const rows = listed.length ? SET_OPTIONS.filter(r => onOff(r) && !listed.includes(r[0])) : SET_OPTIONS;
      const out = rows.map(([n, vals], k) => opt(n, n + ' ', vals ==='ISOLATION LEVEL' ? 'ISOLATION LEVEL …' : vals.split('|').join(' | '), k, { retrigger: true, ref: { t: 'setopt', name: n } }));
      if (ctx.withVars) out.unshift(...variableItems({ ...ctx, tableVars: false, assign: true }, -1));
      return out;
    }
    case 'value': {
      // every option of `SET A, B ON` must take the value: the values all of them accept
      const lists = (ctx.options ?? [ctx.option]).map(n => setOptionsByName().get(n));
      if (lists.some(r => !r)) return [];
      const [first, ...rest] = lists;
      const vals = first[1].split('|').filter(v => rest.every(r => r[1].split('|').includes(v)));
      if (first[0] === 'TRANSACTION') return [];
      return vals.map((v, k) => opt(v, v, first[0] === 'DATEFIRST' ? DAY_NAMES[Number(v) - 1] : first[0] === 'LANGUAGE' && v === 'us_english' ? 'also English' : '', k, { ref: { t: 'setopt', name: first[0] } }));
    }
    case 'isolation': return kws('ISOLATION~LEVEL_>', 0);
    case 'level': return kws('READ~COMMITTED READ~UNCOMMITTED', 0);
    case 'read': return kws('COMMITTED UNCOMMITTED', 0);
    default: return [];
  }
}

// Items of a FOR clause (01 §4.2): XML / JSON (a cursor's FOR READ_ONLY), their modes, and the options not written
// yet (ROOT and WITHOUT_ARRAY_WRAPPER exclude each other, 13620; ELEMENTS is not valid with EXPLICIT, 6825).
function forClauseItems(ctx) {
  const used = new Set(ctx.used ?? []);
  switch (ctx.stage) {
    case 'kind': return ctx.cursor ? kws('READ_ONLY', 0) : kws('XML_> JSON_>', 0);
    case 'mode': {
      if (ctx.for === 'json') return kws('PATH AUTO', 0);
      const out = kws('PATH RAW AUTO EXPLICIT', 0);
      out.splice(1, 0, item('keyword', "PATH('')", "PATH('')", { detail: 'String concatenation: STUFF((SELECT …), 1, n, \'\')', group: 0, sort: 0.5 }));
      return out;
    }
    case 'option': {
      const rootIt = () => item('keyword', "ROOT('…')", "ROOT('root')", { detail: 'A root element with this name', group: 0, sort: 1.5, sel: [6, 10] });
      if (ctx.for === 'json') {
        const out = [];
        if (!used.has('ROOT') && !used.has('WITHOUT_ARRAY_WRAPPER')) out.push(...kws('ROOT', 0), rootIt());
        if (!used.has('INCLUDE_NULL_VALUES')) out.push(...kws('INCLUDE_NULL_VALUES', 0).map(i => ({ ...i, sort: 2 })));
        if (!used.has('WITHOUT_ARRAY_WRAPPER') && !used.has('ROOT')) out.push(...kws('WITHOUT_ARRAY_WRAPPER', 0).map(i => ({ ...i, sort: 3 })));
        return out;
      }
      const out = [];
      if (!used.has('TYPE')) out.push(...kws('TYPE', 0));
      if (!used.has('ROOT')) out.push(...kws('ROOT', 0).map(i => ({ ...i, sort: 1 })), rootIt());
      if (!used.has('ELEMENTS') && ctx.mode !== 'EXPLICIT') out.push(...kws('ELEMENTS ELEMENTS~XSINIL ELEMENTS~ABSENT', 0).map(i => ({ ...i, sort: 2 + i.sort / 10 })));
      if (!used.has('BINARY')) out.push(...kws('BINARY~BASE64', 0).map(i => ({ ...i, sort: 3 })));
      return out;
    }
    case 'elements': return kws('XSINIL ABSENT', 0);
    default: return [];
  }
}

// Label items after GOTO: the labels of the batch, each once.
function labelItems(ctx) {
  const seen = new Set();
  const out = [];
  for (const l of ctx.labels ?? []) {
    if (seen.has(lower(l.name))) continue;
    seen.add(lower(l.name));
    out.push(item('label', l.name, nameSql(l.name), { detail: 'Label', sort: out.length, ref: { t: 'label', name: l.name, s: l.s, text: ctx.text } }));
  }
  return out;
}

// Cursor names declared in the batch, with GLOBAL first where it may be written.
function cursorItems(ctx) {
  const out = ctx.global ? kws('GLOBAL_', 1) : [];
  const seen = new Set();
  for (const c of ctx.cursors) {
    if (seen.has(lower(c.name))) continue;
    seen.add(lower(c.name));
    out.push(item('cursor', c.name, nameSql(c.name), { detail: 'Cursor', sort: out.length, ref: { t: 'cursor', c, text: ctx.text } }));
  }
  return out;
}

// The cursor options that exclude each other (01 §4.1 Cursors); FAST_FORWARD may be written together with
// FORWARD_ONLY and READ_ONLY, as SQL Server 2005 and later allow.
const CURSOR_CONFLICTS = [['LOCAL', 'GLOBAL'], ['FORWARD_ONLY', 'SCROLL'], ['FAST_FORWARD', 'SCROLL'], ['FAST_FORWARD', 'STATIC']];

// Items of DECLARE c … CURSOR … FOR (01 §4.1 Cursors): before CURSOR the ISO options and CURSOR; after it the
// options not written yet that do not conflict with one written, then FOR (an ISO declaration takes FOR alone).
function cursorDeclItems(ctx) {
  const used = new Set(ctx.cursorOpts ?? []);
  if (ctx.stage === 'pre') return kws([...CURSOR_PRE.filter(o => !used.has(o)), 'CURSOR'].map(w => w + '_>').join(' '), 0);
  const blocked = o => used.has(o) || CURSOR_CONFLICTS.some(([x, y]) => (o === x && used.has(y)) || (o === y && used.has(x)));
  const opts = ctx.iso ? [] : CURSOR_POST.filter(o => !blocked(o));
  return kws([...opts, 'FOR'].map(w => w + '_>').join(' '), 0);
}

// Items of FETCH: the directions, FROM after one, INTO after the cursor name.
function fetchStmtItems(ctx) {
  if (ctx.fetch === 'start') return [...kws('NEXT~FROM_> PRIOR~FROM_> FIRST~FROM_> LAST~FROM_> ABSOLUTE_ RELATIVE_ FROM_>', 0), ...cursorItems({ ...ctx, global: true }).map(i => ({ ...i, group: i.group + 1 }))];
  if (ctx.fetch === 'from') return kws('FROM_>', 0);
  if (ctx.fetch === 'into') return kws('INTO_', 0);
  return [];
}

// At a table position `alias.` (a FROM item or an APPLY right side): the xml columns of that source, an earlier one of
// the statement (a #temp, table variable, CTE, derived table or nodes() column), each inserting `col.nodes(` (01 §8.3,
//: `CROSS APPLY t.x.nodes('…') AS n(c)`). {items, loading}.
function xmlColumnItems(ctx, src) {
  const none = { items: [], loading: false };
  if (ctx.qualifier.length !== 1) return none;
  const q = lower(ctx.qualifier[0]);
  const s = [...ctx.scope, ...ctx.outer].find(x => refOf(x) === q && x.s < ctx.from);
  if (!s || TABLE_KINDS.has(s.kind) || s.kind === 'meta' || s.kind === 'sys') return none;
  const r = sourceCols(s, ctx, src);
  const items = r.cols.filter(c => c.name && XML_TYPE.test(String(c.type ?? ''))).map((c, n) => item('column', c.name, `${nameSql(c.name)}.nodes(`, {
    detail: 'xml · nodes()', sort: n, ref: { t: 'column', col: c, source: s },
  }));
  return { items, loading: r.loading };
}

// The xml variables declared before the caret where a table source goes, each inserting `@x.nodes(`.
function xmlVarItems(ctx, group) {
  const seen = new Set();
  const out = [];
  for (const v of ctx.vars) {
    if (v.cols || !XML_TYPE.test(String(v.type ?? '')) || seen.has(lower(v.name))) continue;
    seen.add(lower(v.name));
    out.push(item('variable', v.name, `${v.name}.nodes(`, { detail: 'xml · nodes()', group, sort: out.length, ref: { t: 'variable', v, text: ctx.text } }));
  }
  return out;
}

// The methods of an xml value after `x.` (01 §8.3): value(, query( and exist( in expressions, nodes( where a
// table source goes (`CROSS APPLY x.nodes('…') AS t(c)`).
function xmlMethodItems(tablePos) {
  return XML_METHODS.filter(n => (n === 'nodes') === !!tablePos).map((n, k) => {
    const doc = docFor('xml.' + n);
    return item('function', n, n + '(', { detail: doc ? doc.display.replace(/\.\.\./g, '…') : '', sort: k, ref: { t: 'function', name: 'xml.' + n } });
  });
}

// Completion items for an analysed context (03 §5 Contexts), unranked: {items: [{kind, label, insert, detail, alt?,
// filter?, fo?, icon, group, sort, ref?, sel?, retrigger?, value?}], loading, values?} — loading = data the context
// needs is not loaded yet (src.needs says what); values = the list starts with the value items of a `<col> =` / IN (
// context (flagged value: true), followed by the expression items. opts.aliasKeywords: at an alias position with a
// word typed, the keywords that may follow the source still filter by it (an open list that was opened there before
// the word was typed, 03 §5); otherwise the word is an alias and nothing completes it.
export function completions(ctx, src, opts = {}) {
  const res = (items, loading = false) => ({ items, loading });
  const expr = () => {
    const cur = columnItems(ctx, src, ctx.scope, 0, false);
    const outer = columnItems(ctx, src, ctx.outer, 1, true);
    // the variables declared earlier in the batch and the @@ globals (03 §5 otherwise): variables after the
    // aliases, the globals after the functions
    const vars = variableItems({ ...ctx, tableVars: false, assign: false }).map(v => ({ ...v, group: v.ref?.t === 'global' ? 5 : 2, sort: 1000 + v.sort }));
    const items = [...cur.items, ...outer.items, ...aliasItems(ctx), ...vars, ...exprKeywords(ctx), ...functionItems()];
    if (ctx.clause === 'order' && ctx.seg) {
      const names = selectList(ctx.lex.sig, ctx.seg.a, ctx.seg.b, ctx.lex.match).filter(x => x.name);
      const have = new Set(items.filter(i => i.kind === 'column').map(i => lower(i.filter ?? i.label)));
      for (const x of names) if (!have.has(lower(x.name))) items.push(item('alias', x.name, nameSql(x.name), { detail: 'Select list alias', icon: 'column', group: 0 }));
    }
    if (ctx.subq) items.push(...kws('SELECT_', -1), ...snippetItems(5, true));
    if (ctx.empty) items.push(...templateItems(src));
    return res(items, cur.loading || outer.loading);
  };
  switch (ctx.kind) {
    case 'statement': return res([...(ctx.empty ? templateItems(src) : []), ...snippetItems(0), ...kws(KW.starters, 1)]);
    case 'query': return res([...kws('SELECT_', -2), ...snippetItems(-1, true)]);
    case 'table': {
      const t = tableItems(ctx, src);
      return ctx.derived ? res([...kws('SELECT_ VALUES~(', -2), ...snippetItems(-1, true), ...t.items], t.loading) : t;
    }
    case 'over': return res(kws(OVER_KW[ctx.over] ?? '', 0));
    case 'join': {
      const t = tableItems(ctx, src), j = joinItems(ctx, src);
      return res([...j.items, ...t.items], t.loading || j.loading);
    }
    case 'member': {
      // `x.` on an xml value: its methods (01 §8.3); a table position takes only nodes()
      if (qualifierIsXml(ctx, ctx.qualifier, src)) return res(ctx.tablePos && !ctx.nodesOk ? [] : xmlMethodItems(ctx.tablePos));
      // at a table position `alias.`: that source's xml columns, going on to nodes()
      if (ctx.tablePos) return ctx.nodesOk ? xmlColumnItems(ctx, src) : res([]);
      const s = sourceFor(ctx, ctx.qualifier, src);
      if (!s) return res([]);
      const r = sourceCols(s, ctx, src, ctx.purpose ?? 'read');
      return res(r.cols.map((c, n) => item('column', c.name, nameSql(c.name), {
        detail: [c.attr?.displayName, colType(c)].filter(Boolean).join(' · '), alt: c.attr?.displayName || null, icon: colIcon(c), sort: n, ref: { t: 'column', col: c, source: s },
      })), r.loading);
    }
    case 'xmlMethod': return res(ctx.tablePos && !ctx.nodesOk ? [] : xmlMethodItems(ctx.tablePos));
    case 'alias': return res(ctx.afterAs || (ctx.word && !opts.aliasKeywords) ? [] : aliasKeywords(ctx));
    case 'collation': return res(collationItems());
    case 'cursor': return res(cursorItems(ctx));
    case 'fetch': return res(fetchStmtItems(ctx));
    case 'cursorDecl': return res(cursorDeclItems(ctx));
    case 'setOption': return res(setOptionItems(ctx));
    case 'waitfor': return res(kws('DELAY_ TIME_', 0));
    case 'label': return res(labelItems(ctx));
    case 'forClause': return res(ctx.stage === 'after' ? kws(KW.starters, 6) : forClauseItems(ctx));
    case 'on': {
      const c = conditionItems(ctx, src), e = expr();
      return res([...c.items, ...e.items], c.loading || e.loading);
    }
    case 'value': {
      // the column's values come first; the expression items follow (a variable, GETDATE(), another column)
      const v = valueItems(ctx, src), e = expr();
      if (v && (v.items.length || v.loading)) return { items: [...v.items.map(i => ({ ...i, group: i.group - 10, value: true })), ...e.items], loading: v.loading || e.loading, values: true };
      return e;
    }
    case 'set': {
      if (!ctx.target) return res([]);
      return columnItems(ctx, src, [ctx.target], 0, false, 'update');
    }
    case 'insertCols': {
      const t = ctx.seg && ctx.seg.target;
      if (!t) return res([]);
      const r = columnItems(ctx, src, [t], 0, false, 'create');
      const used = new Set(ctx.used ?? []);
      return res(r.items.filter(i => !used.has(lower(i.filter ?? i.label))), r.loading);
    }
    case 'variable': return res(variableItems(ctx));
    case 'execParam': {
      // the message's parameters not given yet, then the variables and @@ globals (03 §5)
      const vars = variableItems({ ...ctx, tableVars: false, assign: false }, 2);
      if (ctx.dyn) return res([...dynParamItems(ctx), ...vars]);
      const p = paramItems(ctx, src);
      return res([...p.items, ...vars], p.loading);
    }
    case 'hint': return res(hintItems());
    case 'useHint': return res(useHintItems());
    case 'tableHint': return res([item('hint', 'NOLOCK', 'NOLOCK', { detail: NOLOCK_DOC().text, ref: { t: 'nolock' } })]);
    case 'exec': return execItems(src);
    case 'executeAs': return res(kws('USER~=_ LOGIN~=_', 0));
    case 'datepart': {
      // only the parts this function accepts (01 §5.3, §8: the others raise 9810)
      const rejects = DATEPART_REJECTS.get(ctx.fn) ?? [];
      return res(DATEPARTS.filter(([n]) => !rejects.includes(n)).map(([n, abbr], k) => item('datepart', n, n, { detail: abbr, alt: abbr, sort: k })));
    }
    case 'type': return res(typeItems(ctx));
    case 'is': return res(ctx.not ? kws('NULL', 0) : kws('NULL NOT~NULL', 0));
    case 'after': {
      // after an EXEC argument's variable: OUTPUT where it is valid, else only what may follow any argument
      if (ctx.execOut) {
        const o = execOutputOk(ctx, src);
        return res([...(o.ok ? kws('OUTPUT', -1) : []), ...kws(KW.starters, 6)], o.loading);
      }
      return res(afterKeywords(ctx));
    }
    case 'expr': return expr();
    default: return res([]);
  }
}

// Analyses, builds and ranks in one call (the list Ctrl+Space shows): {ctx, items (ranked), loading, needs}.
export function complete(text, caret, src, opts = {}) {
  const ctx = analyze(text, caret, opts);
  const r = completions(ctx, src, opts);
  return { ctx, items: rankItems(r.items, ctx.prefix), loading: r.loading, needs: src.needs ?? [] };
}

// The edit accepting `item` makes in `ctx`: {from, to, text, sel: [start, end]} (absolute offsets; sel is where the
// caret or selection goes afterwards). The analysed range is replaced whole (word, [quoted name], @variable or the
// string of USE HINT('…'); an unclosed one up to the name characters after the caret, analyze()).
export function acceptEdit(ctx, it) {
  const text = String(it.insert ?? it.label);
  const from = ctx.from, to = ctx.to;
  const sel = it.sel ? [from + it.sel[0], from + it.sel[1]] : [from + text.length, from + text.length];
  return { from, to, text, sel };
}

// Whether Enter accepts `it` (03 §5): when the list was navigated, or when the typed prefix is non-empty and the
// item's label, inserted text or matched name (`filter`: `name` of a qualified `a.name`) starts with it and is longer;
// at an alias position (`kind` 'alias') only when the list was navigated, so an alias `le` never becomes LEFT JOIN.
export function enterAccepts(it, prefix, navigated, kind = null) {
  if (!it || it.disabled) return false;
  if (navigated) return true;
  if (kind === 'alias') return false;
  const p = fold(String(prefix ?? '')).s;
  if (!p) return false;
  const grows = s => s.startsWith(p) && s.length > p.length;
  const l = fold(String(it.label)).s, ins = fold(String(it.insert ?? '')).s.trimEnd();
  return grows(l) || grows(ins) || (it.filter != null && grows(fold(String(it.filter)).s));
}

const TRIGGER_WORDS = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'INSERT', 'DELETE', 'TABLE', 'EXEC', 'EXECUTE', 'COLLATE']);

// What typing the character before `caret` does (03 §5 Triggers): 'open' (show the list now), 'debounce' (show it
// after 30 ms: an identifier character after a non-identifier character), 'paren' ('(': signature help, and the
// option list of `<choice col> IN (`), 'comma' (',': the list opens only inside an EXEC parameter list) or null.
// Strings, comments and numbers are excluded by the analysis.
export function triggerAt(text, caret, { inputType = 'insertText' } = {}) {
  if (inputType !== 'insertText') return null;
  const s = String(text ?? '');
  const ch = s[caret - 1];
  if (!ch) return null;
  if (ch === '(') return 'paren';
  if (ch === ',') return 'comma';
  if (ch === '.') {
    const p = s[caret - 2] ?? '';
    if (p === ']' || p === '"') return 'open';
    let k = caret - 2;
    while (k >= 0 && IDENT_CH.test(s[k])) k--;
    return k < caret - 2 && !/\d/.test(s[k + 1]) ? 'open' : null;   // a name, not a number (1.)
  }
  if (ch === ' ' || ch === '\t') {
    const m = /(?:^|[^\p{L}\p{N}_@#$])([A-Za-z]+)[ \t]$/u.exec(s.slice(Math.max(0, caret - 24), caret));
    return m && TRIGGER_WORDS.has(m[1].toUpperCase()) ? 'open' : null;
  }
  if (IDENT_CH.test(ch) && ch !== '$' && !/\d/.test(ch)) {
    const p = s[caret - 2];
    return p === undefined || !IDENT_CH.test(p) ? 'debounce' : null;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------- signature help

// The function a '(' at sig index k opens: {name, doc, message} or null. FetchXML condition names count only as
// `col = name(` (01 §8), Web API functions come from the messages map.
function callTarget(sig, k, messages) {
  const n = sig[k - 1];
  if (!n || n.t !== 'id') return null;
  if (isOp(sig[k - 2], '.')) {
    // `x.value(`, `x.query(`, `x.exist(`, `x.nodes(`, `x.modify(`: the xml methods (01 §8.3)
    const doc = /^(value|query|exist|nodes|modify)$/i.test(n.v) ? docFor('xml.' + lower(n.v)) : null;
    return doc ? { name: doc.name, doc, message: null } : null;
  }
  const f = FETCH_CONDITIONS.get(n.k);
  if (f) return isOp(sig[k - 2], '=') ? { name: f.name, doc: docFor(f.name), message: null } : null;
  if (n.k !== 'AT_TIME_ZONE') {
    const doc = docFor(n.k);
    if (doc) return { name: doc.name, doc, message: null };
  }
  const m = messages instanceof Map ? messages.get(lower(n.v)) : null;
  return m && m.kind === 'function' ? { name: m.name, doc: null, message: m } : null;
}

// The function call around `caret` (03 §5 Signature help): {name, doc, message, open, a (offset of its '('),
// argIndex, as, from, fromAfter} or null. Commas count only at the call's own depth, so commas inside nested
// parentheses, strings and comments never count; grouping parentheses are looked through, and a call closed before
// the caret is not around it. `as` / `from` = AS / FROM at the call's depth before the caret (CAST, TRIM),
// `fromAfter` = FROM after it. quotedIdentifier: as for analyze().
export function callAt(text, caret, { lex = null, messages = null, quotedIdentifier } = {}) {
  const src = String(text ?? '');
  const pos = Math.max(0, Math.min(Math.trunc(Number(caret) || 0), src.length));
  const qi = qiOf({ lex, quotedIdentifier });
  const L = fits(lex, src, pos, qi) ? lex : lexWindow(src, pos, { quotedIdentifier: qi });
  if (L.go) return null;
  const { sig, match } = L;
  const i0 = firstAt(sig, pos);
  const st = i0 > 0 ? stmtAt(L.stmts, i0 - 1) : null;
  const stop = Math.max(st ? st.a : 0, i0 - BACK_MAX);
  let depth = 0, commas = 0, as = false, from = false;
  for (let k = i0 - 1; k >= stop; k--) {
    const t = sig[k];
    if (isOp(t, ';')) return null;
    if (isOp(t, ')')) { depth++; continue; }
    if (isOp(t, '(')) {
      if (depth) { depth--; continue; }
      const c = callTarget(sig, k, messages);
      if (c) {
        let fromAfter = false;
        const end = match[k] >= 0 ? match[k] : (st ? st.b : sig.length);
        for (let j = i0; j < end; j++) {
          if (isOp(sig[j], '(') && match[j] >= 0) j = match[j];
          else if (isKw(sig[j], 'FROM')) { fromAfter = true; break; }
        }
        return { ...c, open: k, a: t.s, argIndex: commas, as, from, fromAfter };
      }
      commas = 0; as = false; from = false;
      continue;
    }
    if (depth === 0) {
      if (isOp(t, ',')) commas++;
      else if (isKw(t, 'AS')) as = true;
      else if (isKw(t, 'FROM')) from = true;
    }
  }
  return null;
}

// `display` split around the parameter name `pname` (bold), searched after the function name.
function boldParam(display, pname, fname) {
  if (!pname) return [{ text: display, bold: false }];
  const re = new RegExp(`(?<![A-Za-z0-9_])${pname}(?![A-Za-z0-9_])`, 'g');
  re.lastIndex = display.startsWith(fname) ? fname.length : 0;
  const m = re.exec(display);
  if (!m) return [{ text: display, bold: false }];
  return [{ text: display.slice(0, m.index), bold: false }, { text: pname, bold: true }, { text: display.slice(m.index + pname.length), bold: false }].filter(x => x.text);
}

// Signature help for a built-in function (03 §5): {parts: [{text, bold}], summary, param, note}. Line 1 is
// doc.display with the current parameter (paramAt) bold, optional parameters in brackets and a repeating one as
// `value1, value2[, …]` (arguments past it keep it bold); line 2 the summary; line 3 `name: description`; line 4 the
// FetchXML note for condition functions. CAST/TRY_CAST follow AS, TRIM follows FROM.
export function docSignature(doc, argIndex, { as = false, from = false, fromAfter = false } = {}) {
  let idx = argIndex;
  if (doc.name === 'CAST' || doc.name === 'TRY_CAST') idx = as ? 1 : 0;
  else if (doc.name === 'TRIM') idx = from ? 1 : fromAfter ? 0 : 1;
  const p = paramAt(doc, idx);
  return {
    parts: boldParam(doc.display.replace(/\.\.\./g, '…'), p ? p.name : null, doc.name),
    summary: doc.summary || null,
    param: p && p.desc ? `${p.name}: ${p.desc}` : null,
    note: doc.category === 'FetchXML conditions' ? FETCH_NOTE : null,
  };
}

// Signature help for a Web API function or action of meta.messages() (03 §5): line 1 lists the parameters with their
// types, optional ones in brackets, the current one bold (by position, or `named` for EXEC @Name = …); line 2 the
// message description and line 3 the current parameter's description, each left out when empty. For EXEC (`exec`)
// line 1 also lists the response properties, as optional `@Name type OUTPUT` parameters after the request ones.
export function messageSignature(m, argIndex, named = null, exec = false) {
  const req = (m.params ?? []).map(p => ({ ...p, out: false }));
  const ps = exec ? [...req, ...(m.response ?? []).map(r => ({ name: r.name, type: r.type, optional: true, description: '', out: true }))] : req;
  const want = named ? lower(String(named).replace(/^@/, '')) : null;
  const cur = want ? ps.find(p => lower(p.name) === want) ?? null : ps[argIndex] ?? null;
  const parts = [];
  let buf = exec ? `EXEC ${m.name}${ps.length ? ' ' : ''}` : `${m.name}(`;
  ps.forEach((p, n) => {
    if (n) buf += ', ';
    const txt = `${exec ? '@' : ''}${p.name} ${p.type}${p.out ? ' OUTPUT' : ''}`;
    const open = p.optional ? '[' : '', close = p.optional ? ']' : '';
    if (p === cur) { parts.push({ text: buf + open, bold: false }, { text: txt, bold: true }); buf = close; } else buf += open + txt + close;
  });
  if (!exec) buf += ')';
  parts.push({ text: buf, bold: false });
  return { parts: parts.filter(x => x.text), summary: m.description || null, param: cur && cur.description ? `${cur.name}: ${cur.description}` : null, note: null };
}

// The EXEC statement around the caret: {message, argIndex, named, a} or null.
function execCallAt(ctx) {
  const st = ctx.stmt;
  if (!st || (st.kind !== 'EXEC' && st.kind !== 'EXECUTE')) return null;
  const { sig, match } = ctx.lex;
  let n = st.a + 1;
  if (isKw(sig[n], 'AS')) return null;
  if (sig[n]?.t === 'var' && isOp(sig[n + 1], '=')) n += 2;
  const ch = chainAt(sig, n, st.b);
  if (!ch || sig[ch.b].e > ctx.caret || (ctx.word && firstAt(sig, ctx.word.s) <= ch.b)) return null;
  const i0 = ctx.word ? firstAt(sig, ctx.word.s) : firstAt(sig, ctx.caret);
  let argIndex = 0, argStart = ch.b + 1;
  for (let k = ch.b + 1; k < i0; k++) {
    if (isOp(sig[k], '(') && match[k] >= 0 && match[k] < i0) { k = match[k]; continue; }
    if (isOp(sig[k], ',')) { argIndex++; argStart = k + 1; }
  }
  const a0 = sig[argStart];
  const named = a0 && a0.t === 'var' && isOp(sig[argStart + 1], '=') && argStart + 1 < i0 ? (a0.raw ?? a0.v) : null;
  return { message: ch.parts[ch.parts.length - 1], argIndex, named, a: sig[ch.a].s };
}

// Signature help at the caret (03 §5): {sig, a (offset to anchor at), name} or null. src: a createSource() view
// (its messages map gives Web API functions and EXEC'd messages). opts: {lex, quotedIdentifier} as for analyze().
export function signatureAt(text, caret, src, opts = {}) {
  const s0 = String(text ?? '');
  const pos = Math.max(0, Math.min(Math.trunc(Number(caret) || 0), s0.length));
  const O = opts.lex;
  const qi = qiOf(opts);
  const lex = fits(O, s0, pos, qi) ? O : { ...lexWindow(s0, pos, { quotedIdentifier: qi }), text: s0 };
  const msgs = src ? src.messages() : null;
  const call = callAt(s0, pos, { lex, messages: msgs, quotedIdentifier: qi });
  if (call) return { sig: call.doc ? docSignature(call.doc, call.argIndex, call) : messageSignature(call.message, call.argIndex), a: call.a, name: call.name };
  const ctx = analyze(s0, pos, { lex, quotedIdentifier: qi });
  const e = execCallAt(ctx);
  if (e && msgs) {
    const m = msgs.get(lower(e.message));
    if (m) return { sig: messageSignature(m, e.argIndex, e.named, true), a: e.a, name: m.name };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------- hover

const tablePosKw = new Set(['FROM', 'JOIN', 'APPLY', 'INTO', 'UPDATE', 'DELETE', 'INSERT', 'TABLE']);

// Purposes hover resolves columns with: the readable columns first, then every listable one (03 §5: a column that is
// not readable still has a card, flagged 'Not readable').
const HOVER_PURPOSES = ['read', 'any'];

// Hover target of a column `name` of source `s` (any listable column, also one that is not valid for read).
function columnTarget(s, name, ctx, src) {
  const r = sourceCols(s, ctx, src, 'any');
  const col = r.cols.find(c => lower(c.name) === lower(name));
  if (col) return { t: 'column', col, source: s };
  return r.loading ? { t: 'loading', name, source: s } : null;
}

// Hover target of a table source (its name or alias).
function sourceTarget(s, ctx, src) {
  switch (s.kind) {
    case 'table': case 'archive': case 'bin': return src.find(s.name) ? { t: 'table', name: s.name, schema: s.kind === 'table' ? null : s.kind } : null;
    case 'meta': return META_TABLES.some(m => m.name === lower(s.name)) ? { t: 'meta', table: lower(s.name) } : null;
    case 'temp': return src.temps().has(lower(s.name)) || ctx.temps.has(lower(s.name)) ? { t: 'temp', name: s.name, cols: sourceCols(s, ctx, src).cols } : null;
    case 'tvar': { const v = ctx.vars.find(x => lower(x.name) === lower(s.name)); return v ? { t: 'variable', v, text: ctx.text } : null; }
    case 'cte': return { t: 'cte', name: s.name, cols: sourceCols(s, ctx, src).cols };
    case 'tvf': {
      if (isNodesCall(s)) return { t: 'function', name: 'xml.nodes' };
      const up = String(s.name).toUpperCase();
      if (TVFS.has(up)) return { t: 'function', name: up };
      const m = src.messages();
      return m && m.get(lower(s.name)) ? { t: 'message', name: m.get(lower(s.name)).name } : null;
    }
    case 'sys': return lower(s.name) === 'messages' ? { t: 'sys', name: 'messages' } : null;
    default: return { t: 'source', source: s, cols: sourceCols(s, ctx, src).cols };
  }
}

// The cursor a name token at sig index i names: in `DECLARE c … CURSOR`, `OPEN [GLOBAL] c`, `CLOSE [GLOBAL] c`,
// `DEALLOCATE [GLOBAL] c` and `FETCH … FROM [GLOBAL] c` / `FETCH c`, a cursor declared in the batch; else null.
function cursorAt(ctx, sig, i, st) {
  const t = sig[i];
  if (!st || !isName(t) || (t.t === 'id' && RESERVED.has(t.k))) return null;
  const at = sig[i - 1]?.t === 'id' && sig[i - 1].k === 'GLOBAL' ? i - 1 : i;
  const k = st.kind;
  const named = (k === 'OPEN' || k === 'CLOSE' || k === 'DEALLOCATE') && at === st.a + 1;
  const fetched = k === 'FETCH' && (at === st.a + 1 || isKw(sig[at - 1], 'FROM'));
  const declared = k === 'DECLARE' && i === st.a + 1;
  if (!named && !fetched && !declared) return null;
  const all = declared ? [...ctx.cursors, ...declaredCursors(sig, i + 1)] : withEarlierCursors(ctx);
  return all.find(c => (declared ? c.s === t.s : lower(c.name) === lower(t.v))) ?? null;
}

// What a name token refers to, in its analysed context.
function targetOf(ctx, t, src) {
  const { sig, match } = ctx.lex;
  const i = firstAt(sig, t.s);
  const prev = sig[i - 1], next = sig[i + 1];
  const st = ctx.stmt;
  if (t.t === 'var') {
    const v = t.raw ?? t.v;
    if (v.startsWith('@@')) { const g = GLOBALS.find(([n]) => n === v.toUpperCase()); return g ? { t: 'global', name: g[0], text: g[1] } : null; }
    if (ctx.kind === 'execParam' && isOp(next, '=')) return { t: 'param', message: ctx.message, param: v.slice(1) };
    // a variable declared earlier, or the one this DECLARE declares here
    const d = ctx.vars.find(x => lower(x.name) === lower(v)) ?? declaredVars(sig, i + 1, match).find(x => x.s === t.s);
    return d ? { t: 'variable', v: d, text: ctx.text } : null;
  }
  const name = t.v, up = t.t === 'id' ? t.k : name.toUpperCase();
  if (st) {
    const ps = openParens(sig, st.a, i, match);
    const q = ps.length ? ps[ps.length - 1] : -1;
    if (q >= 0 && isKw(sig[q - 1], 'OPTION')) {
      if (t.t !== 'id') return null;
      let a = i, b = i;
      while (a - 1 > q && sig[a - 1].t === 'id') a--;
      while (b + 1 < sig.length && sig[b + 1].t === 'id') b++;
      const words = k0 => sig.slice(k0[0], k0[1] + 1).map(x => x.v).join(' ');
      const d = hintDoc(words([a, b])) ?? hintDoc(words([a, i])) ?? hintDoc(words([i, b])) ?? hintDoc(name);
      return d ? { t: 'hint', name: d.name } : null;
    }
    if (q >= 0 && isKw(sig[q - 1], 'WITH') && up === 'NOLOCK') return { t: 'nolock' };
  }
  // a collation name after COLLATE
  if (isKw(prev, 'COLLATE') && t.t === 'id') { const c = collationInfo(name); return c ? { t: 'collation', name: c.name } : null; }
  // `x.value(…)` and the other xml methods (01 §8.3)
  if (isOp(next, '(') && isOp(prev, '.') && t.t === 'id' && /^(value|query|exist|nodes|modify)$/i.test(name)) {
    const d = docFor('xml.' + lower(name));
    if (d) return { t: 'function', name: d.name };
  }
  // a cursor name in DECLARE c CURSOR, OPEN, FETCH … FROM, CLOSE and DEALLOCATE
  const cur = cursorAt(ctx, sig, i, st);
  if (cur) return { t: 'cursor', c: cur, text: ctx.text };
  if (isOp(next, '(') && !isOp(prev, '.') && t.t === 'id') {
    const f = FETCH_CONDITIONS.get(up);
    if (f) { if (isOp(prev, '=')) return { t: 'function', name: f.name }; }
    else if (up !== 'AT_TIME_ZONE' && docFor(up)) return { t: 'function', name: docFor(up).name };
    const msgs = src.messages();
    const m = msgs ? msgs.get(lower(name)) : null;
    if (m) return { t: 'message', name: m.name };
  }
  if (t.t === 'id' && NILADIC.has(up) && docFor(up) && !isOp(prev, '.')) return { t: 'function', name: up };
  // `x AT TIME ZONE z` (01 §4.4): each of its three words shows the AT TIME ZONE entry of FUNCTION_DOCS
  if (t.t === 'id' && (up === 'AT' || up === 'TIME' || up === 'ZONE')) {
    for (let a = i - 2; a <= i; a++) if (a >= 0 && isKw(sig[a], 'AT') && isKw(sig[a + 1], 'TIME') && isKw(sig[a + 2], 'ZONE')) return { t: 'function', name: 'AT TIME ZONE' };
  }
  // a label: its definition `name:` and the name after GOTO, when the batch defines it
  if (t.t === 'id' && !RESERVED.has(up) && (isOp(next, ':') || isKw(prev, 'GOTO'))) {
    const l = batchLabels(ctx.lex).labels.find(x => lower(x.name) === lower(name));
    if (l) return { t: 'label', name: l.name, s: l.s, text: ctx.text };
  }
  // a SET option name (01 §4.1 SET options): SET NOCOUNT ON, SET DATEFORMAT dmy, SET A, B ON
  if (t.t === 'id' && st && st.kind === 'SET' && setOptionsByName().has(up) && (i === st.a + 1 || (isOp(prev, ',') && kwOf(sig[i - 2]) && setOptionsByName().has(kwOf(sig[i - 2]))))) {
    return { t: 'setopt', name: up };
  }
  if (t.t === 'id' && RESERVED.has(up)) return null;   // a keyword, never a name unless [quoted]
  if (ctx.kind === 'exec' && st) {
    const msgs = src.messages();
    if (!msgs) return { t: 'loading', name };
    const m = msgs.get(lower(name));
    return m ? { t: 'message', name: m.name } : null;
  }
  if (isOp(prev, '.')) {
    const ch = chainEndingAt(sig, i);
    const quals = ch.parts.slice(0, -1);
    if (!quals.length) return null;   // `uat..account`: the '.' follows another '.', not a name
    const before = sig[ch.a - 1];
    if (quals.length === 1 && before && (tablePosKw.has(kwOf(before)) || (isOp(before, ',') && ctx.clause === 'from')) && SCHEMAS.has(lower(quals[0]))) {
      const sch = lower(quals[0]);
      if (sch === 'metadata') return META_TABLES.some(m => m.name === lower(name)) ? { t: 'meta', table: lower(name) } : null;
      if (sch === 'sys') return lower(name) === 'messages' ? { t: 'sys', name: 'messages' } : lower(name) === 'fn_helpcollations' ? { t: 'function', name: 'FN_HELPCOLLATIONS' } : null;
      return src.find(name) ? { t: 'table', name, schema: sch === 'dbo' ? null : sch } : null;
    }
    const s = sourceFor(ctx, quals, src);
    return s ? columnTarget(s, name, ctx, src) : null;
  }
  const all = [...ctx.scope, ...ctx.outer];
  const seg = ctx.seg;
  if (seg && seg.target && !all.includes(seg.target)) all.push(seg.target);
  const hit = all.find(s => s.nameB === i || s.aliasAt === i);
  if (hit) return sourceTarget(hit, ctx, src);
  // a name in the column list of INSERT INTO t (…) is a column of the target (03 §5: an unambiguous bare name)
  if (seg && seg.kind === 'INSERT' && seg.target && seg.colsParen >= 0 && i > seg.colsParen && (match[seg.colsParen] < 0 || i < match[seg.colsParen]) &&
    !isOp(next, '.')) return columnTarget(seg.target, name, ctx, src);
  if (isOp(next, '.')) {
    if (SCHEMAS.has(lower(name)) && !all.some(s => refOf(s) === lower(name))) return null;
    const s = sourceFor(ctx, [name], src);
    return s ? sourceTarget(s, ctx, src) : null;
  }
  const r = resolveColumn(ctx, [name], src, HOVER_PURPOSES);
  if (r && r.loading) return { t: 'loading', name };
  if (r) return { t: 'column', col: r.col, source: r.source };
  if (name.startsWith('#')) return src.temps().has(lower(name)) || ctx.temps.has(lower(name)) ? { t: 'temp', name, cols: sourceCols({ kind: 'temp', name }, ctx, src).cols } : null;
  const cte = ctx.ctes.find(c => lower(c.name) === lower(name));
  if (cte) return { t: 'cte', name: cte.name, cols: sourceCols({ kind: 'cte', name: cte.name }, ctx, src).cols };
  if (src.find(name)) return { t: 'table', name, schema: null };
  return null;
}

// The hover target at `offset` (03 §5 Hover cards): {target, s, e} (the name's range) or null for keywords, literals,
// unknown names and ambiguous bare names. target.t: table, column, function, message, variable, global, param,
// temp, meta, hint, nolock, cte, source or loading (metadata needed first; src.needs says what). opts: {lex,
// quotedIdentifier} as for analyze(): with QUOTED_IDENTIFIER OFF a `"…"` is a string, so it names nothing.
export function hoverAt(text, offset, src, opts = {}) {
  const s0 = String(text ?? '');
  const off = Math.max(0, Math.min(Math.trunc(Number(offset) || 0), s0.length));
  const qi = qiOf(opts);
  const L = fits(opts.lex, s0, off, qi) ? opts.lex : { ...lexWindow(s0, off, { quotedIdentifier: qi }), text: s0 };
  if (L.go) return null;
  const k = firstAt(L.toks, off + 1) - 1;
  const t = k >= 0 ? L.toks[k] : null;
  if (!t || off >= t.e) return null;
  if (t.t === 'str') {
    const c = stringContext({ text: s0, caret: t.e, kind: 'none' }, t, L);
    const d = c.kind === 'useHint' ? hintDoc(t.v) : null;
    return d ? { target: { t: 'hint', name: d.name }, s: t.s, e: t.e } : null;
  }
  if (t.t !== 'id' && t.t !== 'qid' && t.t !== 'var') return null;
  const ctx = analyze(s0, t.e, { lex: L, quotedIdentifier: qi });
  const target = targetOf(ctx, t, src);
  return target ? { target, s: t.s, e: t.e } : null;
}

const VIRTUAL_NOTE = {
  name: b => (LOOKUPS.has(b.type) ? `Virtual column: the name of the record that ${b.logicalName} points to.` :
    b.type === 'MultiSelectPicklist' ? `Virtual column: the labels of ${b.logicalName}, separated by '; '.` : `Virtual column: the label of ${b.logicalName}.`),
  type: b => `Virtual column: the table of the record that ${b.logicalName} points to.`,
  pid: b => `Virtual column: the partition id of the record that ${b.logicalName} points to.`,
};

// Type text of an attribute for its hover card: 'nvarchar(100)', 'Lookup → account, contact', 'Choice · 3 options',
// 'datetime · User local', …
function attrTypeText(a, opts) {
  const plural = (n, w) => `${fmtInt(n)} ${w}${n === 1 ? '' : 's'}`;
  switch (a.type) {
    case 'Lookup': case 'Customer': case 'Owner': return `Lookup → ${(a.targets ?? []).join(', ')}`;
    case 'Picklist': case 'State': case 'Status': return opts ? `Choice · ${plural(opts.length, 'option')}` : 'Choice';
    case 'MultiSelectPicklist': return opts ? `Multi-select choice · ${plural(opts.length, 'option')}` : 'Multi-select choice';
    case 'Boolean': return 'Yes/No (bit)';
    case 'DateTime': return BEHAVIOUR_TEXT[a.behavior] ? `${typeName(dtOfAttr(a))} · ${BEHAVIOUR_TEXT[a.behavior]}` : typeName(dtOfAttr(a));
    default: return typeName(dtOfAttr(a));
  }
}

// The card of a Dataverse column (03 §5): display name, table.column, type details, required level, flags,
// metadata description; virtual columns say which column they describe.
function columnCard(c, src) {
  const a = c.attr, b = c.base;
  const rows = [];
  let list = null, loading = false;
  let typeText = a ? attrTypeText(a, null) : 'nvarchar';
  if (a && !c.virtual && (CHOICES.has(a.type) || a.type === 'MultiSelectPicklist' || a.type === 'Boolean')) {
    const opts = src.options(c.entity, a.logicalName);
    if (!opts) loading = true;
    else {
      typeText = attrTypeText(a, opts);
      if (opts.length) list = { title: a.type === 'Boolean' ? 'Values' : 'Options', items: opts.slice(0, 10).map(o => `${o.value} ${o.label ?? ''}`.trim()), more: opts.length > 10 ? `+${fmtInt(opts.length - 10)} more` : null };
    }
  }
  rows.push(['Type', typeText]);
  if (a && !c.virtual && REQUIRED_TEXT[a.requiredLevel]) rows.push(['Required', REQUIRED_TEXT[a.requiredLevel]]);
  const tags = a && !c.virtual ? [a.isPk && 'Primary key', a.isPrimaryName && 'Primary name', a.isCustom && 'Custom', a.isSecured && 'Secured',
    a.sourceType === 1 && 'Calculated', a.sourceType === 2 && 'Rollup', a.validForRead === false && 'Not readable'].filter(Boolean) : [];
  const title = (a && a.displayName) || (c.virtual && b ? `${b.displayName || b.logicalName} (${c.virtual})` : c.name);
  return {
    title, sub: `${c.entity}.${c.name}`, tags, rows, text: (a && a.description) || null, list,
    note: c.virtual && b ? VIRTUAL_NOTE[c.virtual](b) : null, loading,
  };
}

const colLines = cols => cols.map(c => `${c.name} ${c.type ?? ''}`.trim());

// The card model for a hover target, a completion item's side panel or Ctrl+K Ctrl+I (03 §5): {title, mono?, sub?,
// tags?, rows?: [[label, value]], text?, params?: [{name, text}], list?: {title, items, more?}, code?, note?,
// loading?} or null. Text comes only from FUNCTION_DOCS, meta.messages(), metadata, HINT_DOCS and the script.
export function cardFor(target, src) {
  if (!target) return null;
  switch (target.t) {
    case 'table': {
      const e = src.find(target.name);
      if (!e) return null;
      const tags = [e.isCustom && 'Custom', e.isActivity && 'Activity', e.isIntersect && 'N:N', e.kind === 'virtual' && 'Virtual', e.kind === 'elastic' && 'Elastic',
        target.schema === 'archive' && 'Long-term retention', target.schema === 'bin' && 'Recycle bin'].filter(Boolean);
      const rows = [];
      if (e.primaryIdAttribute) rows.push(['Primary key', e.primaryIdAttribute]);
      if (e.primaryNameAttribute) rows.push(['Primary name', e.primaryNameAttribute]);
      const n = src.rowCount(e.logicalName);
      const card = { title: e.displayName || e.logicalName, sub: [e.logicalName, e.entitySetName].filter(Boolean).join(' · '), tags, rows, text: e.description || null, note: n != null ? `≈ ${fmtInt(n)} rows` : null };
      // a join completion item's side panel also shows the whole clause it inserts
      if (target.code) card.code = target.code;
      return card;
    }
    case 'column': {
      const c = target.col;
      if (c.meta) return { title: c.name, mono: true, sub: `metadata.${c.meta}`, rows: [['Type', c.type]] };
      if (!c.attr && !c.virtual) {
        const s = target.source;
        const ref = s ? (s.alias || s.name || '') : '';
        return { title: c.name, mono: true, sub: ref ? `${ref}.${c.name}` : s ? sourceKindText(s) : null, rows: c.type ? [['Type', c.type]] : [] };
      }
      return columnCard(c, src);
    }
    case 'loading': return { title: target.name, mono: true, loading: true };
    case 'function': {
      const d = docFor(target.name);
      if (!d) return null;
      return {
        title: d.display.replace(/\.\.\./g, '…'), mono: true, sub: d.category, text: d.summary,
        params: d.params.filter(p => p.desc).map(p => ({ name: p.name + (p.optional ? ' (optional)' : ''), text: p.desc })),
        note: d.category === 'FetchXML conditions' ? FETCH_NOTE : null,
      };
    }
    case 'message': {
      const msgs = src.messages();
      if (!msgs) return { title: target.name, mono: true, loading: true };
      const m = msgs.get(lower(target.name));
      if (!m) return null;
      return {
        title: m.name, mono: true, sub: [m.kind === 'action' ? 'Action' : 'Function', m.boundTo ? `bound to ${m.boundTo}` : null, m.isCustom ? 'Custom API' : null].filter(Boolean).join(' · '),
        text: m.description || null,
        params: m.params.map(p => ({ name: `${p.name} ${p.type}${p.optional ? ' (optional)' : ''}`, text: p.description || '' })),
        list: m.response.length ? { title: 'Returns', items: m.response.map(r => `${r.name} ${r.type}`) } : null,
      };
    }
    case 'param': {
      const msgs = src.messages();
      const m = msgs ? msgs.get(lower(target.message)) : null;
      const p = m ? m.params.find(x => lower(x.name) === lower(target.param)) : null;
      if (p) return { title: `@${p.name} ${p.type}`, mono: true, sub: `Parameter of ${m.name}${p.optional ? ' · optional' : ''}`, text: p.description || null };
      // a response property given as `@Name = @var OUTPUT`
      const r = m ? (m.response ?? []).find(x => lower(x.name) === lower(target.param)) : null;
      return r ? { title: `@${r.name} ${r.type} OUTPUT`, mono: true, sub: `Response property of ${m.name}`, text: 'Assigned to the variable after a successful call.' } : null;
    }
    case 'cursor': {
      // DECLARE c CURSOR …: its options, and the static read-only snapshot every cursor is (00 §2, 01 §4.1)
      const c = target.c;
      const o = new Set(c.options);
      const forward = o.has('FORWARD_ONLY') || o.has('FAST_FORWARD');
      return {
        title: ['DECLARE', nameSql(c.name), ...c.pre, 'CURSOR', ...c.post].join(' '), mono: true, sub: `Cursor · declared on line ${lineOf(String(target.text ?? ''), c.s)}`,
        rows: [['Scope', o.has('LOCAL') ? 'Local: until the end of the batch' : "Global: until the query tab's session ends"],
          ['Fetch', forward ? 'Forward only: FETCH NEXT' : 'Scrollable: NEXT, PRIOR, FIRST, LAST, ABSOLUTE, RELATIVE']],
        text: 'A static, read-only snapshot of its query, taken at OPEN.',
      };
    }
    case 'collation': {
      const c = collationInfo(target.name);
      if (!c) return null;
      return { title: c.name, mono: true, sub: 'Collation', text: c.description, rows: [['Code page', c.codePage ? String(c.codePage) : 'Unicode only'], ['LCID', String(c.lcid)]] };
    }
    case 'sys':
      return {
        title: 'sys.messages', mono: true, sub: 'System view', text: 'The error messages SQL Studio raises, one row per message number; read-only, no Dataverse request.',
        list: { title: 'Columns', items: SYS_MESSAGES_COLS.map(([n, ty]) => `${n} ${ty}`) },
      };
    case 'variable': {
      // the line is counted only for the card shown (variable items carry the text, not a line per item)
      const v = target.v;
      const line = target.line ?? lineOf(String(target.text ?? ''), v.s);
      return { title: `${v.name} ${v.type}`.trim(), mono: true, sub: `declared on line ${line}`, list: v.cols ? { title: 'Columns', items: colLines(v.cols) } : null };
    }
    case 'global': return { title: target.name, mono: true, text: target.text };
    case 'temp': {
      const t = src.temps().get(lower(target.name));
      if (t) return { title: t.name, mono: true, sub: `Temporary table · ${fmtInt(Array.isArray(t.rows) ? t.rows.length : 0)} rows`, list: { title: 'Columns', items: colLines((t.columns ?? []).map(c => ({ name: c.name, type: typeName(c) }))) } };
      return { title: target.name, mono: true, sub: 'Temporary table, created by this script (not run yet)', list: target.cols && target.cols.length ? { title: 'Columns', items: colLines(target.cols) } : null };
    }
    case 'meta': {
      const m = META_TABLES.find(x => x.name === target.table);
      if (!m) return null;
      return { title: `metadata.${m.name}`, mono: true, sub: 'Metadata table', list: { title: 'Columns', items: m.columns.map(c => `${c.name} ${META_TYPE[c.dt] ?? c.dt}`) } };
    }
    case 'hint': {
      const d = HINT_DOCS.find(x => x.name === target.name);
      if (!d) return null;
      const sub = hintKind(d) === 'table' ? 'Table hint' : d.kind === 'sqlserver' ? 'SQL Server query hint' : 'Query hint';
      return { title: d.syntax, mono: true, sub, text: d.text, note: d.typed ? 'A change with this hint needs the record count typed in its confirmation.' : null };
    }
    case 'nolock': return { title: 'WITH (NOLOCK)', mono: true, sub: 'Table hint', text: NOLOCK_DOC().text };
    case 'setopt': {
      const r = setOptionsByName().get(target.name);
      if (!r) return null;
      const vals = r[1] === 'ISOLATION LEVEL' ? 'ISOLATION LEVEL READ COMMITTED | READ UNCOMMITTED' : r[1].split('|').join(' | ');
      return { title: `SET ${r[0]}`, mono: true, sub: 'SET option · kept per query tab', rows: [['Values', vals]], text: r[2] };
    }
    case 'label':
      return { title: `${target.name}:`, mono: true, sub: `Label · line ${lineOf(String(target.text ?? ''), target.s)}`, text: `GOTO ${target.name} jumps here, within the same batch.` };
    case 'cte': return { title: target.name, mono: true, sub: 'Common table expression', list: target.cols && target.cols.length ? { title: 'Columns', items: colLines(target.cols) } : null };
    case 'source': {
      const s = target.source;
      return { title: s.alias || s.name || sourceKindText(s), mono: true, sub: sourceKindText(s), list: target.cols && target.cols.length ? { title: 'Columns', items: colLines(target.cols) } : null };
    }
    case 'option': {
      const o = target.option, c = target.col;
      return { title: o.label ?? String(o.value), sub: `${c.entity}.${c.virtual ? c.base?.logicalName ?? c.name : c.name} = ${o.value}`, text: o.description || null };
    }
    case 'snippet': return { title: 'Snippet', code: target.sql };
    case 'template': return { title: target.tpl.title, text: target.tpl.description || null, code: target.tpl.sql };
    default: return null;
  }
}

// ------------------------------------------------------------------------------------------------- geometry

// Where the completion list and its side panel go, in viewport px: below the caret line (above it when there is no
// room below), clamped into the viewport; the side panel right of the list, else left of it, else hidden (sideX
// null).
export function popupPlacement(anchor, vp, list, side = null) {
  const below = anchor.bottom + 2;
  const above = below + list.h > vp.height - EDGE && anchor.top - 2 - list.h >= EDGE;
  const y = above ? anchor.top - 2 - list.h : Math.max(EDGE, Math.min(below, vp.height - EDGE - list.h));
  const x = Math.max(EDGE, Math.min(anchor.left, vp.width - EDGE - list.w));
  let sideX = null, sideY = y;
  if (side) {
    if (x + list.w + GAP + side.w <= vp.width - EDGE) sideX = x + list.w + GAP;
    else if (x - GAP - side.w >= EDGE) sideX = x - GAP - side.w;
    sideY = Math.max(EDGE, Math.min(y, vp.height - EDGE - side.h));
  }
  return { x, y, above, sideX, sideY };
}

// Where the signature popup goes: above the caret line, or below it when there is no room above.
export function tipPlacement(anchor, vp, size) {
  const up = anchor.top - GAP - size.h;
  const y = up >= EDGE ? up : Math.min(anchor.bottom + GAP, Math.max(EDGE, vp.height - EDGE - size.h));
  const x = Math.max(EDGE, Math.min(anchor.left, vp.width - EDGE - size.w));
  return { x, y, above: up >= EDGE };
}

// ------------------------------------------------------------------------------------------------- rendering

// Label text with the matched ranges bold.
function labelNodes(label, ranges) {
  const out = [];
  let at = 0;
  for (const [a, b] of [...(ranges ?? [])].sort((x, y) => x[0] - y[0])) {
    if (a < at || b <= a) continue;
    if (a > at) out.push(label.slice(at, a));
    out.push(h('b', null, label.slice(a, b)));
    at = b;
  }
  if (at < label.length) out.push(label.slice(at));
  return out;
}

// Fills `el` with a card model (h()/textContent only, 03 §12).
function fillCard(el, card) {
  clear(el);
  if (card.title != null) {
    const head = h('div', { class: 'cp-ch' }, h('span', { class: card.mono ? 'cp-ct cp-mono' : 'cp-ct' }, card.title));
    for (const t of card.tags ?? []) head.appendChild(h('span', { class: 'tag' }, t));
    el.appendChild(head);
  }
  if (card.sub) el.appendChild(h('div', { class: 'cp-cs' }, card.sub));
  if (card.rows && card.rows.length) {
    const kv = h('div', { class: 'cp-kv' });
    for (const [k, v] of card.rows) kv.append(h('span', { class: 'cp-k' }, k), h('span', { class: 'cp-v' }, v));
    el.appendChild(kv);
  }
  if (card.text) el.appendChild(h('p', { class: 'cp-cd' }, card.text));
  if (card.params && card.params.length) {
    el.appendChild(h('div', { class: 'cp-ps' }, card.params.map(p => h('div', { class: 'cp-p' }, h('span', { class: 'cp-pn' }, p.name), p.text ? h('span', { class: 'cp-pd' }, ' ' + p.text) : null))));
  }
  if (card.list && card.list.items.length) {
    el.appendChild(h('div', { class: 'cp-lt' }, card.list.title));
    el.appendChild(h('ul', { class: 'cp-ul' }, card.list.items.map(x => h('li', null, x))));
    if (card.list.more) el.appendChild(h('div', { class: 'cp-note' }, card.list.more));
  }
  if (card.code != null) el.appendChild(h('pre', { class: 'code cp-code' }, highlightSql(card.code)));
  if (card.note) el.appendChild(h('div', { class: 'cp-note' }, card.note));
  if (card.loading) el.appendChild(h('div', { class: 'cp-load' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Loading…'));
  // the editor's text at the hovered offset (marker messages, invisible characters; createCompletion opts.hoverText)
  if (card.problems && card.problems.length) {
    el.appendChild(h('div', { class: card.title != null ? 'cp-pb cp-pb-sep' : 'cp-pb', role: 'group', 'aria-label': 'Problems' }, card.problems.map(p => {
      const level = PROBLEM_LEVELS.has(p.level) ? p.level : 'info';
      return h('div', { class: 'cp-pr cp-' + level }, h('span', { class: 'cp-pi', 'aria-hidden': 'true' }, icon(level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info', 16)),
        h('span', { class: 'cp-pt' }, String(p.text ?? '')));
    })));
  }
  return el;
}

const PROBLEM_LEVELS = new Set(['error', 'warn', 'info']);

// The problems part of a card from the editor's text at an offset (editor.hoverText(): marker messages, then the code
// points of invisible characters, one per line) and its markers there (editor.markersAt(): their levels and range):
// {items: [{text, level: 'error'|'warn'|'info'}], s, e} (the range a problems-only card is anchored at and kept open
// over), or null when there is none.
export function problemsModel(text, markers, off) {
  const lines = String(text ?? '').split('\n').filter(Boolean);
  if (!lines.length) return null;
  const level = new Map();
  let s = Infinity, e = -Infinity;
  for (const m of Array.isArray(markers) ? markers : []) {
    if (!m || typeof m.message !== 'string') continue;
    if (!level.has(m.message) || m.level !== 'warn') level.set(m.message, m.level === 'warn' ? 'warn' : 'error');
    if (Number.isFinite(m.start) && Number.isFinite(m.end)) { s = Math.min(s, m.start); e = Math.max(e, m.end); }
  }
  const at = Math.max(0, Math.trunc(Number(off) || 0));
  if (!(s <= at && at <= e)) { s = at; e = at + 1; }
  if (e <= s) e = s + 1;
  return { items: lines.map(t => ({ text: t, level: level.get(t) ?? 'info' })), s, e };
}

// The DOM of a card model (hover card, side panel), built with h() and text nodes only.
export function renderCard(card) {
  return fillCard(h('div', { class: 'cp-card' }), card);
}

// The DOM of a signature model: line 1 (the current parameter in <b>), summary, parameter, note.
export function renderSignature(sig) {
  return h('div', { class: 'cp-sg' },
    h('div', { class: 'cp-s1' }, sig.parts.map(p => (p.bold ? h('b', null, p.text) : p.text))),
    sig.summary ? h('div', { class: 'cp-s2' }, sig.summary) : null,
    sig.param ? h('div', { class: 'cp-s3' }, sig.param) : null,
    sig.note ? h('div', { class: 'cp-s4' }, sig.note) : null);
}

// Module CSS (03 §1.3): .cp- classes only, colours only from var(--token); the list keeps the shared .pop
// look (28px rows, 16px kind icon in fg3, matched characters 600 + brand).
export const CSS = `.cp-list,.cp-side,.cp-sig{position:fixed;box-sizing:border-box;background:var(--bg1);color:var(--fg1);border-radius:6px;box-shadow:var(--sh16)}
.cp-list{width:var(--pop-w);max-width:calc(100vw - 16px);padding:4px 0;animation:rise .12s ease-out}
.cp-scroll{position:relative;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}
.cp-inner{position:relative}
.cp-it{position:absolute;left:4px;right:4px;height:${ROW_H}px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:0 8px;border-radius:4px;cursor:pointer;white-space:nowrap;font-size:13px;line-height:20px}
.cp-it:hover{background:var(--bg3)}
.cp-it[aria-selected=true]{background:var(--brand-bg)}
.cp-it[aria-selected=true]:hover{background:var(--brand-bg-h)}
.cp-it[aria-disabled=true]{cursor:default;color:var(--fg3);background:none}
.cp-ic{flex:none;display:grid;place-items:center;width:16px;color:var(--fg3)}
.cp-it[aria-selected=true] .cp-ic{color:var(--brand)}
.cp-lb{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.cp-lb b{font-weight:600;color:var(--brand)}
.cp-dt{flex:1 1000 auto;min-width:0;text-align:right;font-size:12px;line-height:16px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis}
.cp-msg{position:relative;left:auto;right:auto;height:auto;min-height:${ROW_H}px;margin:0 4px;padding:4px 8px;gap:6px;white-space:normal;overflow-wrap:anywhere}
.cp-side{width:${SIDE_W}px;max-width:calc(100vw - 16px);max-height:min(420px,calc(100vh - 16px));overflow:auto;animation:rise .12s ease-out}
.cp-sig{max-width:min(600px,calc(100vw - 16px));padding:6px 10px;font-size:12px;line-height:16px;pointer-events:none;animation:rise .12s ease-out}
.cp-s1{font-family:var(--mono);font-size:12px;line-height:18px;color:var(--fg1);white-space:pre-wrap;overflow-wrap:anywhere}
.cp-s1 b{font-weight:600;color:var(--brand)}
.cp-s2,.cp-s3{margin-top:2px;color:var(--fg2)}
.cp-s4{margin-top:4px;color:var(--fg3)}
.cp-card{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;min-width:0;max-width:min(440px,calc(100vw - 16px));max-height:min(480px,calc(100vh - 16px));overflow:auto;padding:10px 12px;font-size:12px;line-height:16px;color:var(--fg1);user-select:text;cursor:auto}
.cp-pop{width:auto;max-width:min(440px,calc(100vw - 16px));padding:0}
.cp-ch{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 6px}
.cp-ch .tag{margin-left:0}
.cp-ct{font-size:14px;line-height:20px;font-weight:600;overflow-wrap:anywhere}
.cp-ct.cp-mono{font-family:var(--mono);font-size:13px;line-height:18px}
.cp-cs{font-family:var(--mono);color:var(--fg3);overflow-wrap:anywhere}
.cp-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 12px}
.cp-k{color:var(--fg3)}
.cp-v{overflow-wrap:anywhere}
.cp-cd{margin:0;color:var(--fg2);white-space:pre-line}
.cp-ps{display:flex;flex-direction:column;gap:4px}
.cp-pn{font-family:var(--mono);font-weight:600;color:var(--fg1)}
.cp-pd{color:var(--fg2)}
.cp-lt{font-weight:600;color:var(--fg3)}
.cp-ul{margin:0;padding:0 0 0 16px;font-family:var(--mono);color:var(--fg2);overflow-wrap:anywhere}
.cp-code{padding:6px 8px;border-radius:4px;color:var(--fg1);overflow:auto;max-height:180px}
.cp-note{color:var(--fg3)}
.cp-load{display:flex;align-items:center;gap:6px;color:var(--fg3)}
.cp-pb{display:flex;flex-direction:column;gap:4px}
.cp-pb-sep{padding-top:6px;border-top:1px solid var(--s2)}
.cp-pr{display:flex;align-items:flex-start;gap:6px;color:var(--fg1);overflow-wrap:anywhere;white-space:pre-wrap}
.cp-pi{flex:none;display:grid;color:var(--fg3)}
.cp-error .cp-pi{color:var(--red)}
.cp-warn .cp-pi{color:var(--sx-warn)}
.cp-info .cp-pt{font-family:var(--mono);color:var(--fg2)}
@media (prefers-reduced-motion:reduce){.cp-list,.cp-side,.cp-sig{animation:none}}
@media (forced-colors:active){.cp-list,.cp-side,.cp-sig{border:1px solid var(--fg1)}.cp-it[aria-selected=true]{outline:2px solid var(--brand);outline-offset:-2px}}
`;

// ------------------------------------------------------------------------------------------------- controller

const viewport = () => {
  const d = globalThis.document?.documentElement;
  return { width: globalThis.innerWidth || d?.clientWidth || 1024, height: globalThis.innerHeight || d?.clientHeight || 768 };
};
const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const FAIL_MS = 30000;
const RECHECK_MS = 60000;   // the messages map and recycle-bin set are asked of meta again at most this often
// Whether an element is under the pointer (:hover); false where the selector is not supported.
const hovered = el => { try { return !!el && typeof el.matches === 'function' && el.matches(':hover'); } catch { return false; } };

// Wires completion, signature help and hover cards to an editor (03 §5); options and members: see the notes at the top of this file.
export function createCompletion(editor, opts = {}) {
  const o = opts || {};
  const meta = o.meta ?? null;
  const shell = o.shell ?? null;
  const ta = editor.textarea;
  const host = o.container ?? editor.el;
  const listId = uid('cp-l'), sideId = uid('cp-d'), sigId = uid('cp-s'), cardId = uid('cp-c');
  const innerEl = h('div', { class: 'cp-inner' });
  const scrollEl = h('div', { class: 'cp-scroll' }, innerEl);
  const listEl = h('div', { class: 'cp-list', popover: 'manual', id: listId, role: 'listbox', 'aria-label': 'Suggestions' }, scrollEl);
  const sideEl = h('div', { class: 'cp-side', popover: 'manual', id: sideId });
  const sigEl = h('div', { class: 'cp-sig', popover: 'manual', id: sigId, role: 'tooltip' });
  const ownCard = shell && typeof shell.popover === 'function' ? null : h('div', { class: 'pop cp-pop', popover: 'manual', id: cardId, role: 'tooltip' });
  host.append(listEl, sideEl, sigEl);
  if (ownCard) {
    host.append(ownCard);
    cardEvents(ownCard);
  }
  ta.setAttribute('aria-controls', listId);
  if (!ta.hasAttribute('aria-expanded')) ta.setAttribute('aria-expanded', 'false');

  let destroyed = false;
  let messagesMap = null, binSet = null;
  let messagesFull = false;   // messagesMap includes the $metadata messages (meta.messages(), read for EXEC; 02 §2)
  let messagesAt = 0, binAt = 0, messagesGen = 0, lightGen = 0, binGen = 0;
  // failedAt / failedErr: when and why the load of a need key failed (kept until it loads or meta refreshes)
  const pending = new Map(), failedAt = new Map(), failedErr = new Map();
  let shown = false, ctx = null, items = [], loading = false, selIdx = 0, navigated = false, explicit = false, sideShown = false;
  let builtSel = null;   // the selection the open list was built for
  let builtNeeds = [];   // the need keys of the open list's build (errorOf)
  let sigShown = false;
  let sigWait = null;    // {text, caret}: an automatic signature help waiting for meta.messages()
  let card = null;
  let overCard = false;  // the pointer is on the hover card (pointerenter … pointerleave)
  let cardPress = false; // a pointerdown inside the hover card, until the blur it causes
  let hoverPt = null, hoverTimer = 0, leaveTimer = 0, openTimer = 0;
  let accepting = false;
  let lexCache = null;
  let seen = null;   // the text the open popups were built for

  const settings = () => { const s = typeof o.settings === 'function' ? o.settings() : o.settings; return s && typeof s === 'object' ? s : {}; };
  const auto = () => settings().autocomplete !== false;
  // Settings › Editor › Hover cards: off, the mouse opens no hover card; Ctrl+K Ctrl+I, F1, signature help and
  // the side panel still show the same information.
  const hoverCards = () => settings().hoverCards !== false;
  // opts.hoverText (03 §1.4 editor hoverTips): hover cards, the mouse's and Ctrl+K Ctrl+I's, also show the editor's
  // text at the offset (editor.hoverText(): marker messages and invisible characters, levels from markersAt()), below
  // their own content or alone where the name has no card; the host then creates the editor with hoverTips: false.
  const withProblems = o.hoverText === true && typeof editor.hoverText === 'function';
  const problemsAt = off => {
    if (!withProblems) return null;
    try {
      return problemsModel(editor.hoverText(off), typeof editor.markersAt === 'function' ? editor.markersAt(off) : [], off);
    } catch { return null; }
  };
  // The active query tab's SET QUOTED_IDENTIFIER mode (Session.opts.quotedIdentifier, 02 §9), else the editor's
  // (editor.quotedIdentifier(), which main.js keeps equal to it): while it is OFF a `"…"` is a string literal, so
  // nothing completes, hovers or signs inside it (03 §5).
  const quotedIdentifier = () => {
    const sess = typeof o.session === 'function' ? o.session() : o.session;
    const v = sess && sess.opts ? sess.opts.quotedIdentifier : undefined;
    if (typeof v === 'boolean') return v;
    return typeof editor.quotedIdentifier === 'function' ? editor.quotedIdentifier() !== false : true;
  };
  const makeSrc = () => createSource({ meta, session: o.session ?? null, templates: o.templates ?? null, rowCount: o.rowCount ?? null, messages: () => messagesMap, messagesFull: () => messagesFull, bin: () => binSet });
  const textNow = () => editor.getValue();
  const selNow = () => editor.getSelection();
  const describe = (id, on) => {
    const cur = (ta.getAttribute('aria-describedby') || '').split(/\s+/).filter(x => x && x !== id);
    if (on) cur.push(id);
    if (cur.length) ta.setAttribute('aria-describedby', cur.join(' ')); else ta.removeAttribute('aria-describedby');
  };
  const show = el => { if (typeof el.showPopover === 'function') el.showPopover(); };
  const hide = el => { if (typeof el.hidePopover === 'function') { try { el.hidePopover(); } catch { /* already hidden */ } } };

  // ---- metadata loading (02 §2): what a context needs is loaded once; the open popups refresh when it arrives
  function load(needs) {
    if (!meta) return;
    for (const n of needs) {
      if (pending.has(n.key)) continue;
      const f = failedAt.get(n.key);
      if (f != null && Date.now() - f < FAIL_MS) continue;
      let p = null;
      if (n.kind === 'entity' && typeof meta.entity === 'function') p = meta.entity(n.name);
      else if (n.kind === 'rels' && typeof meta.relationships === 'function') p = meta.relationships(n.name);
      else if (n.kind === 'options' && typeof meta.options === 'function') p = meta.options(n.name, n.attr);
      else if ((n.kind === 'messages' || n.kind === 'messagesFull') && typeof meta.messages === 'function') {
        // 'messages' reads BUILTIN_MESSAGES and the custom APIs (meta.messages({csdl: false})), 'messagesFull' also the
        // Functions and Actions of $metadata, which meta reads only on first use of EXEC (02 §2). A newer request
        // (after meta's refresh) wins over an older one still on its way, and a short map never replaces the full one;
        // an unchanged map (meta's cache) refreshes nothing.
        const full = n.kind === 'messagesFull';
        if (!full && messagesFull && messagesMap) continue;
        const g = full ? ++messagesGen : ++lightGen;
        p = Promise.resolve(full ? meta.messages() : meta.messages({ csdl: false })).then(m => {
          if (full ? g !== messagesGen : g !== lightGen || messagesFull) return false;
          const next = m instanceof Map ? m : new Map();
          messagesAt = Date.now();
          const was = messagesFull;
          if (full) messagesFull = true;
          if (next === messagesMap && was === messagesFull) return false;
          messagesMap = next;
          return true;
        });
      } else if (n.kind === 'bin' && typeof meta.recycleBin === 'function') {
        const g = ++binGen;
        p = Promise.resolve(meta.recycleBin()).then(set => {
          if (g !== binGen) return false;
          const next = set instanceof Set ? set : new Set();
          binAt = Date.now();
          if (next === binSet) return false;
          binSet = next;
          return true;
        });
      }
      if (!p) continue;
      const q = Promise.resolve(p);
      pending.set(n.key, q);
      const settle = () => { if (pending.get(n.key) === q) pending.delete(n.key); };
      q.then(changed => { settle(); failedErr.delete(n.key); if (changed !== false) arrived(); }, e => {
        settle();
        failedAt.set(n.key, Date.now());
        failedErr.set(n.key, e instanceof Error ? e : new Error(String(e)));
        arrived();
      });
    }
  }
  // Loads what a source view found missing, and re-reads the messages map and recycle-bin set once they are older
  // than RECHECK_MS (meta answers from its own 24 h cache, so this costs nothing until that cache is renewed).
  function loadFor(src) {
    load(src.needs);
    revalidate(false);
  }
  // Re-reads the messages map and the recycle-bin set (all: now, after meta's refresh() or a new table list); the
  // data in use stays until the new data arrives.
  function revalidate(all) {
    const now = Date.now();
    const needs = [];
    if (messagesMap && (all || now - messagesAt >= RECHECK_MS)) {
      const kind = messagesFull ? 'messagesFull' : 'messages';
      needs.push({ kind, name: '', attr: '', key: `${kind}::` });
    }
    if (binSet && (all || now - binAt >= RECHECK_MS)) needs.push({ kind: 'bin', name: '', attr: '', key: 'bin::' });
    if (all) for (const n of needs) pending.delete(n.key);
    load(needs);
  }
  function arrived() {
    if (destroyed || dropStale()) return;
    // a list the caret has left meanwhile (a command moved it) closes instead of being rebuilt somewhere else
    if (shown) { if (listCurrent()) refresh(true); else closeList(); }
    if (sigShown) updateSignature();
    else if (sigWait) {
      // the automatic signature help that waited for meta.messages(), when the text and caret are unchanged
      const w = sigWait, sel = selNow();
      sigWait = null;
      if (textNow() === w.text && sel.start === sel.end && sel.end === w.caret) signatureHelp(true);
    }
    if (card && card.loading) refreshCard();
  }
  // The lexWindow() result for `pos` of `text` in the tab's QUOTED_IDENTIFIER mode: the cached one when it covers pos
  // (and was made in that mode), else a new one (cached when `keep`: the caret's).
  function lexFor(text, pos, keep) {
    const qi = quotedIdentifier();
    if (fits(lexCache, text, pos, qi)) return lexCache;
    const L = { ...lexWindow(text, pos, { quotedIdentifier: qi }), text };
    if (keep) lexCache = L;
    return L;
  }

  // A text replaced without an input event (setValue(…, {undo: false}) on a query-tab switch) closes the popups built
  // for the old text, so nothing is shown for, or inserted at, offsets of a text that is gone. Returns true when it
  // closed something.
  function dropStale() {
    if (!(shown || sigShown || card) || textNow() === seen) return false;
    closeList();
    closeSignature();
    closeHover();
    return true;
  }

  // ---- the list
  // `keep`: the open list is being refiltered; at an alias position it keeps the keywords it was opened with.
  function build(keep = false) {
    const text = textNow();
    seen = text;
    const sel = selNow();
    const caret = sel.end;
    const src = makeSrc();
    const c = analyze(text, caret, { lex: lexFor(text, caret, true) });
    const aliasKeywords = keep && !!ctx && ctx.kind === 'alias' && c.kind === 'alias' && c.from === ctx.from;
    const r = completions(c, src, { aliasKeywords });
    loadFor(src);
    return {
      ctx: c, items: rankItems(r.items, c.prefix), loading: r.loading, values: !!r.values, sel: { start: sel.start, end: sel.end },
      needs: src.needs.map(n => n.key),
    };
  }
  // The load error of one of a build's needs (keys), or null: an empty list explains only its own missing data.
  const errorOf = keys => { for (const k of keys ?? []) { const e = failedErr.get(k); if (e) return e; } return null; };
  // Whether a build is worth showing: items, data still loading (the list says so and refreshes), or an explicit open
  // whose metadata failed to load (the list says why). Typing never opens the list at an alias position (03 §5).
  const worth = (r, isExplicit) => r.ctx.kind !== 'none' && (isExplicit || r.ctx.kind !== 'alias') &&
    (r.items.length > 0 || (r.loading && pending.size > 0) || (isExplicit && (r.loading || !!errorOf(r.needs))));
  // Whether the open list shows a 'Loading…' row after its items: some of its data is still on its way (03 §5).
  const loadingRow = () => items.length > 0 && loading && pending.size > 0;

  function openList(isExplicit) {
    clearTimeout(openTimer);
    dropStale();
    const s = selNow();
    if (s.start !== s.end && !isExplicit) return false;
    const r = build();
    if (!worth(r, isExplicit)) { closeList(); return false; }
    ctx = r.ctx;
    items = r.items;
    loading = r.loading;
    builtSel = r.sel;
    builtNeeds = r.needs;
    explicit = isExplicit;
    selIdx = 0;
    navigated = false;
    scrollEl.scrollTop = 0;
    if (!shown) {
      shown = true;
      ta.setAttribute('aria-expanded', 'true');
      ta.setAttribute('aria-controls', listId);
      show(listEl);
    }
    render();
    return true;
  }

  // Rebuilds the list for the current text; `keep` keeps the item the user navigated to (data arrived, same prefix).
  function refresh(keep = false) {
    if (!shown) return;
    const prev = items[selIdx] ? items[selIdx].label : null;
    const r = build(true);
    if (!worth(r, explicit)) { closeList(); return; }
    ctx = r.ctx;
    items = r.items;
    loading = r.loading;
    builtSel = r.sel;
    builtNeeds = r.needs;
    const k = keep && navigated && prev != null ? items.findIndex(i => i.label === prev) : -1;
    if (k >= 0) selIdx = k; else { selIdx = 0; navigated = false; scrollEl.scrollTop = 0; }
    render();
  }

  function closeList() {
    clearTimeout(openTimer);
    if (!shown) return false;
    shown = false;
    explicit = false;
    ctx = null;
    items = [];
    builtSel = null;
    builtNeeds = [];
    navigated = false;
    hide(listEl);
    hideSide();
    clear(innerEl);
    ta.setAttribute('aria-expanded', 'false');
    ta.removeAttribute('aria-activedescendant');
    return true;
  }

  function hideSide() {
    if (!sideShown) return;
    sideShown = false;
    hide(sideEl);
    clear(sideEl);
  }

  function render() {
    if (items.length) {
      const rows = items.length + (loadingRow() ? 1 : 0);
      const view = Math.min(rows, VISIBLE) * ROW_H;
      scrollEl.style.height = view + 'px';
      innerEl.style.height = rows * ROW_H + 'px';
      const top = scrollEl.scrollTop || 0;
      if (selIdx * ROW_H < top) scrollEl.scrollTop = selIdx * ROW_H;
      else if ((selIdx + 1) * ROW_H > top + view) scrollEl.scrollTop = (selIdx + 1) * ROW_H - view;
    } else {
      // the one message row is as tall as its text (a metadata error can be long)
      scrollEl.style.height = 'auto';
      innerEl.style.height = 'auto';
    }
    renderSide();
    renderRows();
    position();
  }

  function renderRows() {
    clear(innerEl);
    if (!items.length) {
      const err = errorOf(builtNeeds);
      const text = loading && pending.size ? null : err ? `Could not load the metadata: ${err.message}` : 'No suggestions';
      const msg = text ?? [h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Loading…'];
      innerEl.appendChild(h('div', { class: 'cp-it cp-msg', role: 'option', id: `${listId}-0`, 'aria-disabled': 'true', 'aria-selected': 'false', title: text }, msg));
      ta.removeAttribute('aria-activedescendant');
      return;
    }
    const top = scrollEl.scrollTop || 0;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(items.length, Math.floor(top / ROW_H) + VISIBLE + OVERSCAN);
    for (let i = first; i < last; i++) innerEl.appendChild(row(items[i], i));
    // more items are on their way (a table's columns, the $metadata messages): a disabled row says so (03 §5)
    if (loadingRow() && last === items.length) {
      innerEl.appendChild(h('div', { class: 'cp-it cp-more', role: 'option', id: `${listId}-more`, 'aria-disabled': 'true', 'aria-selected': 'false', style: `top:${items.length * ROW_H}px` },
        h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Loading…'));
    }
    ta.setAttribute('aria-activedescendant', `${listId}-${selIdx}`);
  }

  function row(it, i) {
    return h('div', {
      class: 'cp-it', role: 'option', id: `${listId}-${i}`, 'aria-selected': String(i === selIdx), 'aria-setsize': String(items.length),
      'aria-posinset': String(i + 1), 'aria-describedby': i === selIdx && sideShown ? sideId : null, title: it.label.length > 32 ? it.label : null,
      style: `top:${i * ROW_H}px`, dataset: { i: String(i) },
    },
    h('span', { class: 'cp-ic', 'aria-hidden': 'true' }, icon(it.icon || 'code', 16)),
    h('span', { class: 'cp-lb' }, labelNodes(it.label, it.hl)),
    it.detail ? h('span', { class: 'cp-dt' }, it.detail) : null);
  }

  // The side description panel: the hover card of the selected item (03 §5).
  function renderSide() {
    const it = items[selIdx];
    let model = null;
    if (it && it.ref) {
      const src = makeSrc();
      model = cardFor(it.ref, src);
      loadFor(src);
    }
    if (!model) { hideSide(); return; }
    clear(sideEl);
    sideEl.appendChild(renderCard(model));
    if (!sideShown) { sideShown = true; show(sideEl); }
  }

  function position() {
    if (!shown || !ctx) return;
    const a = editor.coordsAt(ctx.from);
    const n = items.length + (loadingRow() ? 1 : 0) || 1;
    const list = { w: listEl.offsetWidth || 340, h: listEl.offsetHeight || Math.min(n, VISIBLE) * ROW_H + 8 };
    const side = sideShown ? { w: sideEl.offsetWidth || SIDE_W, h: sideEl.offsetHeight || 160 } : null;
    const p = popupPlacement(a, viewport(), list, side);
    listEl.style.left = p.x + 'px';
    listEl.style.top = p.y + 'px';
    if (side) {
      if (p.sideX == null) hideSide();
      else { sideEl.style.left = p.sideX + 'px'; sideEl.style.top = p.sideY + 'px'; }
    }
  }

  function move(d, wrap) {
    if (!items.length) return;
    const n = items.length;
    let i = selIdx + d;
    i = wrap ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    selIdx = i;
    navigated = true;
    render();
  }

  // Whether the open list still belongs to the selection: the caret inside the analysed word, or the very selection
  // it was built for (Ctrl+Space over a selection). A caret moved by a command the list did not see (F3, Replace)
  // makes it stale, so it never accepts at offsets the user has left.
  function listCurrent() {
    if (!ctx) return false;
    const s = selNow();
    if (builtSel && s.start === builtSel.start && s.end === builtSel.end) return true;
    return s.start === s.end && s.end >= ctx.from && s.end <= ctx.to;
  }

  function accept(i = selIdx) {
    const it = items[i];
    if (!it || !ctx || dropStale()) return false;
    if (!listCurrent()) { closeList(); return false; }
    const ed = acceptEdit(ctx, it);
    closeList();
    accepting = true;
    try {
      editor.select(ed.from, ed.to, { reveal: false });
      editor.insert(ed.text);
      if (ed.sel[0] !== ed.from + ed.text.length || ed.sel[1] !== ed.sel[0]) editor.select(ed.sel[0], ed.sel[1], { reveal: false });
    } finally { accepting = false; }
    seen = textNow();
    if (it.retrigger && auto()) openList(false);
    // an inserted `NAME(` opens signature help as a typed '(' does (an automatic popup: only with autocomplete on)
    if (sigShown) updateSignature();
    else if (auto() && /\($/.test(ed.text)) signatureHelp(true);
    return true;
  }

  // ---- signature help
  function signatureHelp(autoOpen = false) {
    if (destroyed) return false;
    dropStale();
    const src = makeSrc();
    const text = textNow();
    const caret = selNow().end;
    const r = signatureAt(text, caret, src, { lex: lexFor(text, caret, true) });
    loadFor(src);
    if (!r) {
      // a Web API function is known only once meta.messages() is loaded: an automatic open waits for it (arrived())
      sigWait = autoOpen && !sigShown && !messagesMap && src.needs.some(n => n.kind === 'messages') ? { text, caret } : null;
      if (!autoOpen || sigShown) closeSignature();
      return false;
    }
    sigWait = null;
    seen = text;
    clear(sigEl);
    sigEl.appendChild(renderSignature(r.sig));
    if (!sigShown) { sigShown = true; show(sigEl); describe(sigId, true); }
    const at = editor.coordsAt(r.a);
    const cur = editor.coordsAt(caret);
    const p = tipPlacement({ left: at.left, top: cur.top, bottom: cur.bottom }, viewport(), { w: sigEl.offsetWidth || 400, h: sigEl.offsetHeight || 60 });
    sigEl.style.left = p.x + 'px';
    sigEl.style.top = p.y + 'px';
    return true;
  }
  function updateSignature() { if (sigShown) signatureHelp(true); }
  function closeSignature() {
    sigWait = null;
    if (!sigShown) return false;
    sigShown = false;
    hide(sigEl);
    clear(sigEl);
    describe(sigId, false);
    return true;
  }

  // ---- hover cards
  function scheduleLeave() {
    clearTimeout(leaveTimer);
    // the pointer on the card keeps it open (in Edge a mouseleave of the textarea can follow the card's pointerenter)
    leaveTimer = setTimeout(() => { if (card && !card.kbd && !overCard && !hovered(card.el)) closeHover(); }, HOVER_LEAVE_MS);
  }
  // Pointer listeners of a hover card element: while the pointer is on it the card stays, leaving it closes the card
  // 300 ms later, and a pointerdown in it keeps a Ctrl+K Ctrl+I card open through the blur it causes, so its text
  // can be selected and copied.
  function cardEvents(el) {
    el.addEventListener('pointerenter', () => { overCard = true; clearTimeout(leaveTimer); clearTimeout(hoverTimer); });
    el.addEventListener('pointerleave', () => { overCard = false; if (card && !card.kbd) scheduleLeave(); });
    el.addEventListener('pointerdown', () => { cardPress = true; });
  }
  // The card at `off`: the hover target's card with the editor's problems there (opts.hoverText), or a card of the
  // problems alone (also `problemsOnly`: Settings › Hover cards is off, and the mouse rests on a marker, 03 §5
  // Diagnostics): {hv: {target, s, e}, model} or null.
  function cardAt(text, off, src, problemsOnly = false) {
    const hv = problemsOnly ? null : hoverAt(text, off, src, { lex: lexFor(text, off, false) });
    const model = hv ? cardFor(hv.target, src) : null;
    const pr = problemsAt(off);
    if (hv && model) return { hv, model: pr ? { ...model, problems: pr.items } : model };
    return pr ? { hv: { target: { t: 'problems' }, s: pr.s, e: pr.e }, model: { title: null, problems: pr.items } } : null;
  }
  function showHover(off, kbd, problemsOnly = false) {
    dropStale();
    const text = textNow();
    const src = makeSrc();
    const r = cardAt(text, off, src, problemsOnly);
    loadFor(src);
    if (!r) { if (kbd) closeHover(); return false; }
    seen = text;
    openCard(r.hv, r.model, kbd, off, problemsOnly);
    return true;
  }
  function openCard(hv, model, kbd, off, problemsOnly = false) {
    closeHover();
    const body = renderCard(model);
    const c1 = editor.coordsAt(hv.s), c2 = editor.coordsAt(hv.e);
    const right = c2.top === c1.top ? Math.max(c2.left, c1.left + 1) : c1.left + 1;
    const rect = { left: c1.left, top: c1.top, right, bottom: c1.bottom, width: right - c1.left, height: c1.bottom - c1.top };
    let pop;
    if (!ownCard) {
      pop = shell.popover(rect, body, {
        role: 'tooltip', label: model.title || (model.problems ? 'Problems' : 'Details'),
        onClose: () => { if (card && card.pop === pop) { describe(card.el.id, false); card = null; overCard = false; } },
      });
    } else {
      clear(ownCard);
      ownCard.appendChild(body);
      show(ownCard);
      const vp = viewport();
      const place = () => placeNear(ownCard, rect, { left: 0, top: 0, right: vp.width, bottom: vp.height }, { gap: GAP });
      place();
      pop = { el: ownCard, close: () => hide(ownCard), reposition: place };
    }
    card = { s: hv.s, e: hv.e, off, target: hv.target, pop, el: pop.el, body, kbd, loading: !!model.loading, problemsOnly };
    overCard = false;
    if (card.el.id) describe(card.el.id, true);
    if (!ownCard) cardEvents(card.el);
  }
  function refreshCard() {
    if (!card) return;
    const text = textNow();
    const src = makeSrc();
    const r = cardAt(text, card.off ?? card.s, src, !!card.problemsOnly);
    loadFor(src);
    if (!r) { closeHover(); return; }
    card.target = r.hv.target;
    card.loading = !!r.model.loading;
    const fresh = renderCard(r.model);
    clear(card.body);
    while (fresh.firstChild) card.body.appendChild(fresh.firstChild);
    if (card.pop.reposition) card.pop.reposition();
  }
  function closeHover() {
    clearTimeout(leaveTimer);
    overCard = false;
    if (!card) return false;
    const c = card;
    card = null;
    if (c.el.id) describe(c.el.id, false);
    c.pop.close();
    return true;
  }
  function hoverAtCaret() {
    const s = selNow();
    return showHover(s.start, true) || (s.start > 0 && showHover(s.start - 1, true));
  }

  // F1: the built-in function, or the Web API function or action of meta.messages(), whose name is at (or just
  // before) the caret; Help › Functions lists both by name (03 §8.2).
  function helpTarget() {
    const text = textNow();
    const p0 = selNow().start;
    const src = makeSrc();
    try {
      for (const p of [p0, p0 - 1]) {
        if (p < 0) continue;
        const L = lexFor(text, p, false);
        const hv = hoverAt(text, p, src, { lex: L });
        if (hv && hv.target.t === 'function') { const d = docFor(hv.target.name); if (d) return { section: 'functions', anchor: d.name }; }
        if (hv && hv.target.t === 'message') return { section: 'functions', anchor: hv.target.name };
        // a function name the analysis gives no card (a FetchXML condition outside `col =`, a name just typed): a call,
        // a niladic function or the last word of its statement, never LEFT / RIGHT of a join or a column named like a
        // function (year)
        const k = firstAt(L.toks, p + 1) - 1;
        const t = k >= 0 ? L.toks[k] : null;
        if (t && t.t === 'id' && p < t.e && !hv) {
          const si = firstAt(L.sig, t.s);
          const st = stmtAt(L.stmts, si);
          const call = isOp(L.sig[si + 1], '(') || NILADIC.has(t.k) || !st || st.b === si + 1;
          const d = call && t.k !== 'AT_TIME_ZONE' && !isOp(L.sig[si - 1], '.') ? docFor(t.k) : null;
          if (d) return { section: 'functions', anchor: d.name };
        }
      }
      return null;
    } finally { loadFor(src); }
  }

  // ---- scrolling, resizing and pointers elsewhere (03 §1.5)
  // Whether the caret position `off` is inside the editor's visible area (true when the scroller has no layout).
  function anchorVisible(off) {
    const sc = editor.scroller;
    if (!sc || typeof sc.getBoundingClientRect !== 'function') return true;
    const r = sc.getBoundingClientRect();
    const w = sc.clientWidth || r.width, hgt = sc.clientHeight || r.height;
    if (!(w > 0 && hgt > 0)) return true;
    const a = editor.coordsAt(off);
    return a.bottom > r.top && a.top < r.top + hgt && a.left >= r.left && a.left <= r.left + w;
  }
  // A scroll of the editor's scroller: the hover card closes (03 §5); the list and the signature popup follow their
  // anchor (the editor scrolls to reveal the caret while typing at its edge) and close once it is out of view.
  function onScroll() {
    closeHover();
    if (dropStale()) return;
    if (shown) { if (ctx && anchorVisible(ctx.from)) position(); else closeList(); }
    if (sigShown) { if (anchorVisible(selNow().end)) updateSignature(); else closeSignature(); }
  }
  const inPopups = t => !!t && (listEl.contains(t) || sideEl.contains(t) || sigEl.contains(t) || (!!card && card.el.contains(t)));
  // The user scrolls the editor (wheel) or resizes the window: every popup closes.
  function closeAll(e) {
    if (e && inPopups(e.target)) return;
    closeList();
    closeSignature();
    closeHover();
  }
  // A pointerdown anywhere in the tool: outside the popups and the textarea it closes them all; in the textarea it
  // closes the hover card (the caret move decides about the list, onCaret).
  function onPointerDown(e) {
    const t = e && e.target;
    if (inPopups(t)) return;
    if (t && ta.contains(t)) { closeHover(); return; }
    closeAll();
  }

  // ---- events
  function onInput(e) {
    if (accepting || destroyed) return;
    seen = textNow();   // an edit with an input event: every open popup is rebuilt or closed below
    sigWait = null;
    closeHover();
    const inputType = e && typeof e.inputType === 'string' && e.inputType ? e.inputType : 'insertText';
    if (inputType === 'insertCompositionText' || (e && e.isComposing)) return;
    const text = textNow();
    const s = selNow();
    if (s.start !== s.end) { closeList(); closeSignature(); return; }
    const caret = s.end;
    if (shown) {
      if (/^delete/.test(inputType)) {
        if (!ctx || caret < ctx.from || (caret === ctx.from && !explicit)) closeList(); else refresh(false);
      } else if (inputType === 'insertText') {
        const ch = text[caret - 1] ?? '';
        if (ch === '.') { if (!openList(explicit)) closeList(); } else if (IDENT_CH.test(ch) || (ctx && ctx.quoted)) refresh(false); else { closeList(); trigger(text, caret, inputType); }
      } else closeList();
    } else trigger(text, caret, inputType);
    if (sigShown) updateSignature();
    settleAfterEdit(text, caret, inputType);
  }

  // The editor applies some edits itself (an auto-closed pair, Enter between parentheses) and sets the caret only after
  // execCommand returns, so the browser's input event above still saw the caret after the inserted text: typing '('
  // with auto-close on reads as a ')' before the caret. Once the edit is complete (a microtask after the editor's
  // handler returns) the triggers are checked again where the edit left the caret, so '(' opens signature help and
  // `IN (` the value list whatever auto-close inserted (03 §5). A text that changed meanwhile or an unmoved caret
  // means there is nothing to redo.
  function settleAfterEdit(text, caret, inputType) {
    queueMicrotask(() => {
      if (destroyed || accepting || textNow() !== text) return;
      const s = selNow();
      if (s.start !== s.end || s.end === caret) return;
      if (shown && !listCurrent()) closeList();
      if (!shown) trigger(text, s.end, inputType);
      if (sigShown) updateSignature();
    });
  }

  function trigger(text, caret, inputType) {
    const tr = triggerAt(text, caret, { inputType });
    // every trigger opens an automatic popup: with autocomplete off only Ctrl+Space / Ctrl+Shift+Space open them
    if (!tr || !auto()) return;
    if (tr === 'paren') {
      signatureHelp(true);
      const r = build();
      if (r.ctx.kind === 'value' && r.ctx.op === 'in' && r.values && r.items.length) openList(false);
      return;
    }
    if (tr === 'comma') {
      // ',' opens the list only inside an EXEC parameter list (03 §5); the analysis alone decides that
      if (analyze(text, caret, { lex: lexFor(text, caret, true) }).kind === 'execParam') openList(false);
      return;
    }
    if (tr === 'open') { openList(false); return; }
    clearTimeout(openTimer);
    const len = text.length;
    openTimer = setTimeout(() => {
      if (destroyed || shown) return;
      const now = selNow();
      if (now.start === caret && now.end === caret && textNow().length === len) openList(false);
    }, DEBOUNCE_MS);
  }

  function onKey(e) {
    if (destroyed || e.isComposing) return false;
    dropStale();
    const k = e.key;
    if (!bound && e.ctrlKey && !e.altKey && !e.metaKey && (k === ' ' || e.code === 'Space' || (!e.shiftKey && e.code === 'KeyJ'))) {
      e.preventDefault();
      if (e.shiftKey) signatureHelp(false); else openList(true);
      return true;
    }
    if (k === 'Escape') {
      if (e.defaultPrevented) return false;
      if (closeList() || closeSignature() || closeHover()) { e.preventDefault(); return true; }
      return false;
    }
    if (!shown) return false;
    if (k === 'F5' || (k === 'Enter' && (e.ctrlKey || e.metaKey))) { closeList(); closeSignature(); return false; }
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    // a list the caret has left (a command moved it without a caret key) takes no key: it closes
    if (!listCurrent()) { closeList(); return false; }
    switch (k) {
      case 'ArrowDown': case 'ArrowUp': case 'PageDown': case 'PageUp':
        if (e.shiftKey) { closeList(); return false; }
        if (k === 'ArrowDown') move(1, true);
        else if (k === 'ArrowUp') move(-1, true);
        else move(k === 'PageDown' ? VISIBLE - 1 : -(VISIBLE - 1), false);
        break;
      case 'Tab':
        if (e.shiftKey || !items.length) { closeList(); return false; }
        accept();
        break;
      case 'Enter':
        if (e.shiftKey || !enterAccepts(items[selIdx], ctx ? ctx.prefix : '', navigated, ctx ? ctx.kind : null)) { closeList(); return false; }
        accept();
        break;
      default: return false;
    }
    e.preventDefault();
    return true;
  }

  function onCaret() {
    if (destroyed || accepting || dropStale()) return;
    sigWait = null;
    if (shown && !listCurrent()) closeList();
    if (sigShown) updateSignature();
  }

  const listeners = [];
  const listen = (el, type, fn, opt) => { el.addEventListener(type, fn, opt); listeners.push([el, type, fn, opt]); };
  listen(ta, 'input', onInput);
  listen(ta, 'keyup', e => { if (CARET_KEYS.has(e.key) && !(shown && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'PageUp' || e.key === 'PageDown'))) onCaret(); });
  listen(ta, 'mouseup', onCaret);
  listen(ta, 'focus', () => { cardPress = false; });
  listen(ta, 'blur', e => {
    const to = e && e.relatedTarget;
    const press = cardPress;
    cardPress = false;
    if (to && inPopups(to)) return;
    closeList();
    closeSignature();
    // a click inside a Ctrl+K Ctrl+I card blurs the textarea (the card is not focusable): the card stays for copying
    if (card && card.kbd && !press) closeHover();
  });
  listen(ta, 'pointerdown', () => closeHover());
  listen(ta, 'mousemove', e => {
    if (e.buttons) return;
    dropStale();
    // hover cards off: no mouse card of a name opens, and one the mouse opened before closes; the editor's problems
    // (opts.hoverText) still show where the pointer rests on a marker, as the editor's own tooltip would (03 §5
    // Diagnostics: they are no hover card)
    const cards = hoverCards();
    if (!cards && card && !card.kbd && !card.problemsOnly) closeHover();
    if (!cards && !withProblems) {
      clearTimeout(hoverTimer);
      hoverPt = null;
      return;
    }
    hoverPt = [e.clientX, e.clientY];
    if (card && !card.kbd) {
      const off = editor.offsetAt(e.clientX, e.clientY);
      if (off != null && off >= card.s && off < card.e) { clearTimeout(leaveTimer); return; }
      scheduleLeave();
    }
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      if (destroyed || !hoverPt) return;
      const on = hoverCards();
      if (!on && !withProblems) return;
      const off = editor.offsetAt(hoverPt[0], hoverPt[1]);
      if (off == null || (card && off >= card.s && off < card.e)) return;
      showHover(off, false, !on);
    }, HOVER_MS);
  });
  // The pointer leaves the text: pointerleave comes before the card's pointerenter; the mouseleave that Edge sends
  // after both changes nothing while the pointer is on the card.
  const onLeave = () => {
    clearTimeout(hoverTimer);
    hoverPt = null;
    if (card && !card.kbd && !overCard) scheduleLeave();
  };
  listen(ta, 'pointerleave', onLeave);
  listen(ta, 'mouseleave', onLeave);
  if (editor.scroller) {
    listen(editor.scroller, 'scroll', onScroll, { passive: true });
    listen(editor.scroller, 'wheel', closeAll, { passive: true });
  }
  const win = ta.ownerDocument?.defaultView ?? (typeof globalThis.addEventListener === 'function' ? globalThis : null);
  if (win && typeof win.addEventListener === 'function') listen(win, 'resize', () => closeAll(), { passive: true });
  const root = typeof ta.getRootNode === 'function' ? ta.getRootNode() : null;
  if (root && root !== ta && typeof root.addEventListener === 'function') listen(root, 'pointerdown', onPointerDown, true);
  listen(listEl, 'mousedown', e => e.preventDefault());
  listen(listEl, 'click', e => {
    const rowEl = e.target && typeof e.target.closest === 'function' ? e.target.closest('.cp-it') : null;
    const i = rowEl ? Number(rowEl.dataset.i) : NaN;
    if (Number.isInteger(i) && items[i]) { selIdx = i; accept(i); }
  });
  listen(scrollEl, 'scroll', () => { if (shown) renderRows(); }, { passive: true });
  listen(sideEl, 'mousedown', e => e.preventDefault());

  const offKey = editor.onKey(onKey);
  const offs = [];
  let bound = false;
  if (shell && typeof shell.shortcut === 'function') {
    bound = true;
    const bind = (id, fn) => { const off = shell.shortcut(id, fn); if (typeof off === 'function') offs.push(off); };
    bind('complete', () => { openList(true); return true; });
    bind('signatureHelp', () => { signatureHelp(false); return true; });
    bind('hover', () => { hoverAtCaret(); return true; });
  }
  if (shell && typeof shell.onEscape === 'function') offs.push(shell.onEscape('popup', () => closeList() || closeSignature() || closeHover()));
  if (meta && typeof meta.onChange === 'function') {
    offs.push(meta.onChange(ev => {
      if (ev && ev.kind === 'error') return;
      // meta dropped its caches (refresh()) or has a new table list: earlier failures may be gone, and the messages
      // map and recycle-bin set are read again
      if (ev && (ev.kind === 'refresh' || ev.kind === 'entities')) { failedAt.clear(); failedErr.clear(); revalidate(true); }
      arrived();
    }));
  }

  return {
    open: () => openList(true),
    close: () => { const a = closeList(); const b = closeSignature(); const c = closeHover(); return a || b || c; },
    isOpen: () => shown,
    signatureHelp: () => signatureHelp(false),
    closeSignature,
    hoverAtCaret,
    closeHover,
    helpTarget,
    refresh: () => { if (dropStale()) return; if (shown) refresh(true); if (sigShown) updateSignature(); if (card) refreshCard(); },
    // Inspection hook: what is shown.
    state: () => ({
      open: shown, kind: ctx ? ctx.kind : null, prefix: ctx ? ctx.prefix : '', labels: items.map(i => i.label), selected: selIdx, navigated, loading,
      signature: sigShown ? sigEl.textContent : null, hover: card ? { s: card.s, e: card.e, t: card.target.t, text: card.el.textContent } : null,
    }),
    destroy() {
      if (destroyed) return;
      closeList();
      closeSignature();
      closeHover();
      destroyed = true;
      clearTimeout(openTimer);
      clearTimeout(hoverTimer);
      clearTimeout(leaveTimer);
      for (const [el, type, fn, opt] of listeners) el.removeEventListener(type, fn, opt);
      listeners.length = 0;
      offKey();
      for (const off of offs) if (typeof off === 'function') off();
      offs.length = 0;
      listEl.remove();
      sideEl.remove();
      sigEl.remove();
      if (ownCard) ownCard.remove();
      ta.setAttribute('aria-expanded', 'false');
      ta.removeAttribute('aria-activedescendant');
      ta.removeAttribute('aria-controls');
    },
  };
}
