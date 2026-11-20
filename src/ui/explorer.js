// Object explorer of SQL Studio (03 §1.4, §5 Hover cards, §6, §7 run lock, §8.4, §9, §12, §13; 00 §2, §3): one
// virtual tree with the tables (fuzzy search, type filters, private tables) and their columns, relationships and alternate keys, the
// metadata.* and sys.* objects, the long-term retention (archive.) and recycle-bin (bin.) schemas, the active query
// tab's #temp tables, the Web API functions and actions of meta.messages() with Script as SELECT / EXEC and the
// built-in functions of FUNCTION_DOCS; Select top 100, Count rows, Script as, drag to the editor, context menus, hover
// cards and WAI-ARIA tree keyboard navigation. The decisions (matching and filters, the flattened tree, the virtual
// window, keyboard moves, type-ahead, every generated SQL text) are pure exported helpers; createExplorer() is the thin
// DOM part on top of them. Data reaches the DOM only through h() and text nodes (03 §12); generated SQL quotes names
// and literals only through util.js sqlName / sqlIdent / sqlStr (00 §5 rule 10) and never runs unasked.
//
// Notes (extensions of 03 §1.4 / §6):
// - createExplorer(host, {meta, state, shell, editor, results}) as 03 §1.4; `state` is the state.js module namespace
//   (as mountShell and initDialogs take it). Options beyond 03 §1.4: `dialogs` (the initDialogs instance; default the
//   dialogs.js module functions of the last initialised instance): loadCsv(files) for .csv/.tsv files dropped on the
//   explorer (03 §6; the shell's loadCsv command takes no files) and openHelp('functions', name) for 'Open in Help' on
//   a built-in function; `io = {copyText, openUrl}` (default util.js, looked up per call); `onFile(file, kind)` (the
//   editor's onFile, 03 §1.4: when given, files dropped on the explorer go to it exactly as a drop on the editor does,
//   editor.js dropCalls, so a .sql file opens in a query tab; main.js passes the same handler to both); `mac`
//   (platform override, default shell.js isMacPlatform(): the search box's title 'Search tables (Ctrl+F)' and
//   aria-keyshortcuts come from KEYMAP); for injection `later(fn, ms) -> cancel`, `frame(fn)` (default
//   requestAnimationFrame, else synchronous), `searchDelay` (default 60 ms) and `viewHeight` (used while the scroller
//   reports no clientHeight). It returns {el (the .ex-root element), rowCount(logicalName, schema = null),
//   focusSearch(), focusTree(), refresh(), setQuery(text), expand(id), collapse(id), model(), destroy()}: rowCount is
//   complete.js's rowCount option (main.js passes it, so a table card reads '≈ 12,345 rows' after Count rows; with
//   'archive' or 'bin' it gives that schema's own count, which complete.js could pass for an archive. or bin. card) and
//   model() is an inspection hook (the flattened rows). It binds the KEYMAP command explorerSearch (Mod+F).
// - Groups, in this order: Tables (count), Metadata (the nine META_TABLES), System objects (sys.messages and
//   sys.fn_helpcollations() with the 02 §7 / 01 §8 columns: META_TABLES holds metadata.* only, so the sys.* list is
//   SYS_OBJECTS here; 03 §6 names no group for them), Archive (tables with IsRetentionEnabled or IsArchivalEnabled,
//   as archive.<t>), Recycle bin (meta.recycleBin(), read once the table list is loaded; a failure other than a
//   privilege error shows the group with the error and Try again), Temporary tables (always shown, 03 §6, also during
//   a search), Functions, Actions, Built-in functions. Tables and Temporary tables start expanded. Functions is built on first expand like Actions (03 §6
//   says so for Actions only): both read meta.messages() in its full form, which may read $metadata (02 §2: only on
//   an explicit use), so the launch sends no message request. Their first expand also reads the short form
//   (messages({csdl: false}): BUILTIN_MESSAGES and the custom APIs), which usually answers well before $metadata has
//   streamed: its rows show at once with a spinner row 'Loading the messages of the Web API service document…' until
//   the full Map replaces them; a full Map meta already holds (messagesSync()) fills the groups without a request. An
//   incomplete Map (meta.js `incomplete`), or a full read that fails after the short form answered, adds a warning
//   row with Try again (the rows stay); a failed read without rows shows an error row with Try again. meta's
//   {kind: 'refresh'} reads the messages again when either group is expanded.
// - Search covers the table names of 03 §6 (logical, display, entity set; complete.js matchScore: exact > prefix >
//   word start > subsequence, display names ignoring spaces and punctuation, and logical and entity set names too,
//   so 'Account Leads' and 'new project' find accountleads and new_project as completion's display names do) and, by
//   name, the other groups' items that are already built (metadata and sys objects, #temp tables, loaded messages,
//   built-in functions), so one box finds every object; a search never loads anything. The rows of each table group
//   are kept while the list, query, filter and metadata stay the same (expand, collapse and repaint never search
//   again), and a query that extends the previous one searches only the previous matches when refineQuery says that
//   gives the result of a full search: the folded query extends the folded previous one and the previous one has a
//   letter or digit (a query of only spaces and punctuation matches only names that contain it, its extensions also
//   match with punctuation ignored), so the rows never depend on how the query was typed. In the Archive and Recycle
//   bin groups a query that starts with 'archive.' / 'bin.' (case ignored) matches the rest against the logical,
//   display and entity set names (the prefix bold; the bare prefix shows the whole group), and any other query also
//   matches the shown name 'archive.task' as metadata.* and sys.* names do. Groups without a match are left out and
//   the others open (a collapse during the search lasts until the query changes), except Temporary tables, which stays
//   with its Load CSV / Load file actions: collapsed (count 0) when no #temp table matches, its rows then saying 'No
//   #temp tables match “xyz”' (or 'No #temp tables in this tab'). With no table match the Tables group shows 'No
//   tables match “xyz”' with Clear search, plus Show private tables when the private-table setting hides matches and
//   Show all types when the type filter does (03 §6 names the first two); with no match anywhere the tree is that
//   state followed by the collapsed Temporary tables group. Matched characters are bold brand, as in the completion
//   list. Filters (All, Custom, System, Activities,
//   Intersect, Virtual, Elastic; Show private tables) are memory only and also apply to the Archive and Recycle bin
//   groups. Tables sort by display name (then logical name) with a base-letter collator.
// - Table rows: icon, display name, logical name, tags Custom, Activity, N:N, Virtual and Elastic (as in the table
//   hover card), the count tag, and the hover (and focus-within) actions Select top 100 and Count rows. Those buttons
//   are pointer-only (tabindex -1, aria-hidden, so a row's accessible name is its name and tags): the row's context
//   menu (Shift+F10) has the same items, and resting on them opens no hover card (they have titles). Their mousedown
//   keeps focus out of the aria-hidden span and their click makes the row active (as a click on it does) before the
//   action runs. Their disabled state and title are read again on run:start / run:end, whenever the pointer enters
//   the row or a button, when the row takes focus and on click, since state.running also covers runs that send no
//   run events (03 §7: runQuiet, attachQuiet, Undo, Review changes; one bus event for every state.running
//   change would let them follow it directly). Expanding a
//   table loads meta.entity(), relationships() and keys() in parallel and shows Columns (n), Relationships (n) and
//   Keys (n) folders at once, each with skeleton rows until its data arrives (the task's 'keys'; 03 §6 names Columns
//   and Relationships); archive. and bin. tables show Columns only. Columns are complete.js tableColumns(info, 'any')
//   (the completion and hover set, incl. the virtual name / type / pid columns and the not-readable columns, dimmed).
//   A column row says its flags in its accessible name too: the primary key's key glyph is
//   role=img 'Primary key', the bold primary name and the dimmed not-readable column add visually hidden (.sr) text
//   ', Primary name' / ', Not readable', and a not-readable column has shell.tooltip TEXT.notReadable, which shows on
//   keyboard focus (:focus-visible; empty while the pointer is on the row, which gets the hover card instead).
//   The type text is types.js typeName(dtOfAttr()). Relationship rows: 'N:1 parentcustomerid → account' (one per
//   target of a polymorphic lookup), '1:N <schema name>' (sub: <table>.<column>), 'N:N <intersect>' (sub: the other
//   table and the schema name); key rows: the key's logical name and its columns.
// - Insert texts (double-click, Enter, drag; drag sets text/plain, so Edge's own textarea drop inserts it at the drop
//   caret as one undo step, except for a relationship, below): names through sqlName (archive.t, bin.t, metadata.t, sys.messages,
//   sys.fn_helpcollations(); #temp names through complete.js nameSql). A relationship inserts its JOIN, aliased like
//   the completion's join items (complete.js uniqueAlias): when the statement at the caret already has the table in
//   scope (complete.js analyze), only `INNER JOIN <other> <a> ON …` with that table's alias, else
//   `<table> <t> INNER JOIN <other> <a> ON …` (SQL 4 CDS inserts both tables too); N:N joins through the intersect
//   table. A dragged relationship cannot know its drop point at dragstart: its text/plain is the self-contained form
//   (for drops elsewhere), and it also sets 'application/x-sqlstudio-explorer'; a drop of it on the editor's textarea
//   is taken (preventDefault) and inserts, with editor.insert(text, {at}) as one undo step, the JOIN for the statement
//   at editor.offsetAt(clientX, clientY) (03 §1.4), spaced as an insert is and selected as a dropped text is. A key inserts its columns. A built-in function inserts as completion does (fnInsert): `NAME(`, `NAME()`
//   for argument-less functions, CURRENT_USER and the other niladic words bare, `NAME() OVER (` for ranking
//   functions; besides 03 §6's ` AT TIME ZONE `, the xml methods insert `.value(` etc. and FN_HELPCOLLATIONS
//   `sys.fn_helpcollations()`, because `NAME(` would not parse for them. Enter on a group, folder or category toggles
//   it; double-click on a table inserts its name (→, the chevron or a click on the chevron expand it). Double-click,
//   Enter and the Insert items replace the editor's selection and add a space where the text would run into the word,
//   closing bracket, quote or ')' before the caret or the word after it (spacedInsert: `FROM|` gives `FROM account`,
//   `a.|` gives `a.name`), then focus the editor; a drag is not spaced (the textarea inserts the drop itself), except
//   the relationship drop above.
// - Select top 100 (`SELECT TOP 100 * FROM <t>;`) and Select all columns (`SELECT TOP 100 <every readable column of
//   tableColumns(info, 'read'), virtual ones included> FROM <t>;`, after meta.entity()) put the query into the active
//   tab when the editor's text is blank, else into a new tab titled with the table name, and call
//   results.runTab(tabId, 'all'). Show columns (metadata.attribute) and Show relationships (metadata.relationship_1_n,
//   _n_1 and _n_n; one result set each) run the same way. Count rows sends 03 §6's text through results.runQuiet;
//   standard tables only get the RETRIEVE_TOTAL_RECORD_COUNT hint (02 §4.5: virtual, elastic, archive and bin tables
//   fall back to the plain COUNT(*)), the count comes from the first set's first cell and is approximate exactly when
//   that set carries a warning of kind 'approx'. The toast reads '<table>: ≈ 12,345 rows' with the 03 §6 note as its
//   second line; the Messages line is the run's own (runQuiet appends the handle's messages). Every run action is disabled with the run-lock title (shell.js
//   runLockTitle) while state.running is set, and with 'The results area is not available.' without results.js; one
//   started anyway (a menu opened before the lock) shows the run-lock toast with the action 'Go to tab' (00 §3, 03 §7), which
//   activates the running tab.
// - Table menu (03 §6): Open list in this app is util.listUrl(etn) with the app-wide known-table check (main.js
//   registers it after meta.init, 03 §11), so it fails closed as every record link does; an intersect table has no
//   views or forms, so its item is disabled ('This table has no list in this app.'). Both links open in a new tab
//   (util.openUrl): the page that holds SQL Studio stays, and their items have the hint 'Opens in a new tab' (part of
//   the menu item's accessible name). Every menu item's run is guarded: an action that fails (a
//   table whose metadata cannot be loaded, a failed copy) shows its message in an error toast, and run() resolves
//   when the action has finished.
// - Script as SELECT / INSERT / UPDATE / DELETE (tables, after meta.entity()) opens a new tab titled '<OP> <table>'
//   that does not run. SELECT lists the readable real columns; INSERT the creatable ones without the primary key,
//   UPDATE the updatable ones without it, each value line `    ,  -- <column>: <type>[, required]` (required ones first
//   after the primary name; the last line has no comma); DELETE is `DELETE FROM <t>\nWHERE <pk> = ;`. As with the
//   EXEC script the values are left empty on purpose: an INSERT, UPDATE or DELETE script does not parse until the
//   user fills it in, so a placeholder is never written. The caret goes to the first value. archive. tables script
//   SELECT only, bin. tables SELECT and DELETE (00 §2: read-only except DELETE FROM bin.t).
// - Script as for messages exactly as 03 §6, plus: a function bound to a record (binding 'entity') gets a first
//   `DECLARE @<pk of the bound table> uniqueidentifier = NULL; -- change this (required: the <table> record)` passed as
//   the first argument (02 §9: `RetrieveUserPrivileges(userid)`), and an action bound to a record gets
//   `    @Target = ,  -- entityreference (<table>), required` (02 §8.1: `EXEC <Action> @Target = CREATELOOKUP(…)`). SQL
//   types of the meta.messages() vocabulary: Boolean bit, String nvarchar(max), Guid uniqueidentifier, Integer int,
//   BigInt bigint, Decimal decimal(38,10), Money money, Float float, DateTime datetime, Date date, Time time, Binary
//   varbinary(max), Picklist int, EntityReference and a table-typed parameter entityreference, anything else
//   nvarchar(max) (03 §6: 'nvarchar(max) when unknown'); an EXEC comment adds the table to a table-typed parameter.
//   The SELECT script selects the first DECLARE's NULL, so typing replaces it. Names written as variables must be
//   identifiers (meta.js keeps only such names, so this is defensive): a SELECT script declares @p<n> for any other
//   (its arguments are positional), an EXEC script says how many it could not write, and every generated `--`
//   comment has its control and line-separator characters replaced by spaces, so no name can end the comment and
//   become code (00 §5 rule 10). An action that EXEC always refuses (02 §8.1: Create … DeleteAndPromote, REFUSED_EXEC;
//   complete.js marks the same names 'Refused' in completion but does not export its list, so this module keeps the
//   02 §8.1 list, which has to match complete.js's) is dimmed with the tag 'Refused', its Script as EXEC is disabled with the title 'Use
//   INSERT/UPDATE/DELETE instead: EXEC <name> would change records the preview cannot show.', its card adds that
//   sentence as its note (and is the one card it shows with hoverCards off), and the row has it as keyboard tooltip.
// - #temp tables (03 §6): Select top 100 and Script as SELECT are added to the active tab as dialogs.js 'Query it'
//   adds its query (appendQuery: a blank text is replaced, else the query goes on its own line and is selected); Select
//   top 100 then runs it (the selection, or the whole text when it was blank). Drop table asks first (shell.confirm,
//   danger: a dropped table's rows cannot come back) and then runs `DROP TABLE <name>` through results.runQuiet. The
//   group's hover actions and menu are Load CSV as #temp… and Load file as text… (the shell commands loadCsv and
//   loadFileAsText, so their run-lock state applies). Files dropped on the explorer go to `onFile` when given; else
//   its .csv/.tsv files open the Load CSV dialog (dialogs.loadCsv(files)) and the other files are named in a warning
//   ('“notes.sql” was not loaded. Only .csv and .tsv files can be dropped here; they load as #temp tables.'; a drop of
//   only other files says the second sentence).
// - Hover cards (03 §5, §6): the mouse resting 500 ms on a row opens complete.js's card for it (cardFor + renderCard:
//   tables, columns, metadata and sys objects, #temp tables, messages, built-in functions) in shell.popover(…, {role:
//   'tooltip'}) to the right of the tree at the row's height; relationships and keys get a card of their own in the
//   same model. It closes 300 ms after the pointer leaves the row and the card, and on scroll, keys, pointerdown and
//   collapse. A table card's row count is the count of that row's own table (archive.task's retained rows, not task's)
//   and reads '≈' only for an approximate count ('42 rows', '1 row'). settings.hoverCards false opens no card,
//   except the 'Not readable' note of a not-readable column (03 §6 asks for its tooltip) and a refused action's note. Choice option labels a column card needs are loaded with meta.options(); when that
//   fails, the card says 'Couldn’t load the details: <message>' instead of 'Loading…' (kept, without a new request on
//   every hover, until meta refreshes).
// - States: until the table list arrives the Tables group shows six skeleton rows and the
//   tree is aria-busy; a failed list (meta.init() rejecting, or meta.onChange {kind: 'error', source: 'entities'}
//   while the list is empty) shows a three-row error state with Try again (meta.init() again, or meta.refresh() when
//   init has resolved). Lazy children show skeleton rows and, on failure, an error row whose Enter (or Try again) loads
//   again. The refresh button runs meta.refresh() (busy while it runs; 'Reload metadata'); counts stay.
// - ARIA (03 §6): role=tree with treeitems carrying aria-level, aria-setsize, aria-posinset and
//   aria-expanded; roving tabindex (the active row is always rendered, also when scrolled away). When the active row
//   leaves the tree (Drop table, a collapse, a search) its nearest ancestor still shown takes its place (the parent
//   flattenTree recorded: a column's folder, a #temp table's group), else the first row; focus stays in the tree. Skeleton rows are
//   aria-hidden and not counted. Keys: ↑/↓, ←/→ (collapse or parent / expand or first child), Home/End, PageUp/PageDown,
//   Enter, type-ahead on the row labels, Shift+F10 / the context-menu key (the contextmenu event), F2 nothing; ↓ or
//   Enter in the search box moves to the first row; Mod+F (explorerSearch) focuses the search box.
// - Virtualisation (03 §13): the tree is one flat array of stable node objects (level, posinset, setsize and parent set
//   while flattening), rows are absolutely positioned slots of --tree-h (28 px) and only the slots in view ± 8 are in
//   the DOM, reusing their elements; a row is filled again only when its node's content changed (the bold ranges of a
//   search are made at paint), so a `temps` event (02 §9: one per INSERT of a WHILE loop) refills only the #temp rows
//   that changed, and an entity() load (meta.onChange {kind: 'entity'}, which meta.js reports with a new list array)
//   that changes none of the fields the list depends on replaces its entry in the sorted list, the kept search results
//   and its rows without sorting or searching again; a list taller than 16,000,000 px (about 571,000 rows) maps the scroll position
//   linearly onto it, so any length scrolls (Chromium's layout limit is about 33.5 million px).
// - icons.js has no 'action' alias yet (03 §1.2: action → bolt): the Actions group and its rows draw 'bolt'.
import { h, clear, append } from './dom.js';
import { icon } from './icons.js';
import { createSource, cardFor, renderCard, tableColumns, matchScore, nameSql, uniqueAlias, analyze } from './complete.js';
import { runLockTitle, quoteName, titleFor, ariaKeys, isMacPlatform } from './shell.js';
import { fileKind, dropCalls } from './editor.js';
import * as dialogsModule from './dialogs.js';
import { META_TABLES } from '../engine/metatables.js';
import { docList } from '../engine/functions.js';
import { typeName, dtOfAttr } from '../engine/types.js';
import * as util from '../core/util.js';

const { sqlName, sqlStr, fmtInt } = util;

// ------------------------------------------------------------------------------------------------------ constants

const ROW_H = 28;            // --tree-h (03 §3)
const INDENT = 16;           // px per tree level (03 §6)
const OVERSCAN = 8;          // slots rendered above and below the view
const MAX_PX = 16000000;     // the tallest spacer; longer lists map the scroll position onto it
const HOVER_MS = 500;        // 03 §5 / §6 hover delay
const LEAVE_MS = 300;        // a hover card closes this long after the pointer left
const TYPE_MS = 700;         // type-ahead: keys within this time extend the prefix
const SK_ROWS = 6;           // skeleton rows of the table list
const SK_CHILD = 3;          // skeleton rows of a loading folder or group
const STATE_SPAN = 3;        // slots of an empty / error state block

// The top groups in 03 §6 order: [id, label, icon].
export const GROUPS = Object.freeze([
  ['tables', 'Tables', 'table'], ['metadata', 'Metadata', 'db'], ['sys', 'System objects', 'settings'],
  ['archive', 'Archive', 'history'], ['bin', 'Recycle bin', 'trash'], ['temps', 'Temporary tables', 'rows'],
  ['functions', 'Functions', 'fx'], ['actions', 'Actions', 'bolt'], ['builtins', 'Built-in functions', 'sigma'],
].map(g => Object.freeze(g)));

// The filter menu's table types (03 §6): [value, label].
export const TABLE_TYPES = Object.freeze([
  ['all', 'All'], ['custom', 'Custom'], ['system', 'System'], ['activity', 'Activities'], ['intersect', 'Intersect'],
  ['virtual', 'Virtual'], ['elastic', 'Elastic'],
].map(t => Object.freeze(t)));

// The sys.* objects (02 §7, 01 §8): metatables.js META_TABLES lists only metadata.*.
export const SYS_OBJECTS = Object.freeze([
  Object.freeze({ name: 'messages', label: 'sys.messages', sql: 'sys.messages', kind: 'view',
    columns: Object.freeze([['message_id', 'int'], ['language_id', 'int'], ['severity', 'tinyint'], ['is_event_logged', 'bit'], ['text', 'nvarchar(2048)']]) }),
  Object.freeze({ name: 'fn_helpcollations', label: 'sys.fn_helpcollations()', sql: 'sys.fn_helpcollations()', kind: 'tvf',
    columns: Object.freeze([['name', 'nvarchar(128)'], ['description', 'nvarchar(1000)']]) }),
]);

// Texts of 03 §6 and of this module.
export const TEXT = Object.freeze({
  noTemps: 'No #temp tables in this tab',
  loadCsv: 'Load CSV as #temp…',
  loadFile: 'Load file as text…',
  approx: 'Approximate count from RetrieveTotalRecordCount (snapshot taken within the last 24 hours).',
  noResults: 'The results area is not available.',
  noEditor: 'The editor is not available.',
  tablesFailed: 'Couldn’t load the tables',
  clearSearch: 'Clear search',
  showPrivate: 'Show private tables',
  showAllTypes: 'Show all types',
  tryAgain: 'Try again',
  notReadable: 'Not readable: Dataverse does not return this column in queries.',
  dropOnly: 'Only .csv and .tsv files can be dropped here; they load as #temp tables.',
  noList: 'This table has no list in this app.',
  moreMessages: 'Loading the messages of the Web API service document…',
  newTab: 'Opens in a new tab',
  goToTab: 'Go to tab',
  refused: 'Refused',
  primaryKey: 'Primary key',
  primaryName: 'Primary name',
  notReadableTag: 'Not readable',
  copyFailed: 'Could not copy to the clipboard.',
});

// The messages EXEC always refuses (02 §8.1 EXEC: 'Use INSERT/UPDATE/DELETE instead: …'), lower case. complete.js
// keeps the same list unexported (REFUSED_EXEC); the two lists have to match.
export const REFUSED_EXEC = Object.freeze(['create', 'update', 'delete', 'upsert', 'createmultiple', 'updatemultiple', 'upsertmultiple',
  'deletemultiple', 'executemultiple', 'executetransaction', 'bulkdelete', 'merge', 'assign', 'setstate', 'associate', 'disassociate',
  'importsolution', 'importsolutionasync', 'uninstallsolution', 'deleteandpromote']);
const REFUSED = new Set(REFUSED_EXEC);

// Whether EXEC refuses an action (02 §8.1): its rows are tagged and its Script as EXEC is disabled.
export function isRefusedExec(m) {
  return !!m && m.kind === 'action' && typeof m.name === 'string' && REFUSED.has(m.name.toLowerCase());
}

// The 02 §8.1 refusal of `EXEC <name>`, as the row's keyboard tooltip, its card and its disabled script items say it.
export function refusedText(name) {
  return `Use INSERT/UPDATE/DELETE instead: EXEC ${String(name ?? '')} would change records the preview cannot show.`;
}

// SQL types of the meta.messages() parameter and response types (02 §2 vocabulary, lower-cased).
const MSG_SQL_TYPES = new Map([
  ['boolean', 'bit'], ['string', 'nvarchar(max)'], ['guid', 'uniqueidentifier'], ['integer', 'int'], ['int16', 'smallint'],
  ['int32', 'int'], ['byte', 'tinyint'], ['sbyte', 'smallint'], ['bigint', 'bigint'], ['int64', 'bigint'],
  ['decimal', 'decimal(38,10)'], ['money', 'money'], ['float', 'float'], ['double', 'float'], ['single', 'real'],
  ['datetime', 'datetime'], ['date', 'date'], ['time', 'time'], ['binary', 'varbinary(max)'], ['picklist', 'int'],
  ['entityreference', 'entityreference'],
]);

// The SQL types of the metadata.* column dts (complete.js shows the same names).
const META_TYPE = Object.freeze({ string: 'nvarchar', guid: 'uniqueidentifier', bit: 'bit', int: 'int', float: 'float', datetime: 'datetime', any: 'sql_variant' });

// Node id prefixes of table rows per schema (ids name tree positions: 'g:tables', 't:account/cols', …).
const ID_PREFIX = Object.freeze({ tables: 't:', archive: 'ar:', bin: 'bn:' });
// The drag data type of a relationship row, whose JOIN is made for the statement it is dropped into.
const DRAG_TYPE = 'application/x-sqlstudio-explorer';
const EMPTY = Object.freeze([]);
// The EntityInfo fields the table list's order, search, filters, groups and rows depend on: an entity() load that
// changes none of them replaces its entry without sorting or searching again.
const LIST_FIELDS = ['logicalName', 'displayName', 'entitySetName', 'isPrivate', 'isCustom', 'isActivity', 'isIntersect', 'kind', 'isRetentionEnabled', 'isArchivalEnabled'];
// Row kinds that insert a text (double-click, Enter, drag; 03 §6).
const INSERTS = new Set(['table', 'column', 'rel', 'key', 'meta', 'metaCol', 'sys', 'sysCol', 'temp', 'tempCol', 'msg', 'builtin']);
const NILADIC = new Set(['CURRENT_USER', 'CURRENT_TIMESTAMP', 'SESSION_USER', 'SYSTEM_USER', 'USER']);
const LOOKUPS = new Set(['Lookup', 'Customer', 'Owner']);
const REQUIRED = new Set(['SystemRequired', 'ApplicationRequired']);
const lower = s => String(s ?? '').toLowerCase();
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Text for a generated `--` comment: a line break (or any other control character) would end the comment and make the
// rest of a crafted name code, so they become spaces (00 §5 rule 10).
const note = s => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');

let collator = null;
// Base-letter comparison (case and accents ignored), one Intl.Collator created on first use.
const byText = (a, b) => (collator ?? (collator = new Intl.Collator('en', { sensitivity: 'base' }))).compare(a, b);

// ------------------------------------------------------------------------------------------------ pure helpers

// Whether a table passes the filter menu: {type: TABLE_TYPES value, showPrivate}.
export function passesFilter(e, filter = {}) {
  if (!e) return false;
  if (e.isPrivate && !filter.showPrivate) return false;
  return typeMatches(e, filter.type);
}

// Whether a table is of the filter menu's type ('all' or missing: every table).
export function typeMatches(e, type = 'all') {
  switch (type) {
    case 'custom': return !!e.isCustom;
    case 'system': return !e.isCustom;
    case 'activity': return !!e.isActivity;
    case 'intersect': return !!e.isIntersect;
    case 'virtual': return e.kind === 'virtual';
    case 'elastic': return e.kind === 'elastic';
    default: return true;
  }
}

// The table list in display order: display name (base letters), then logical name.
export function sortTables(list) {
  return [...(list ?? [])].filter(e => e && typeof e.logicalName === 'string')
    .sort((a, b) => byText(a.displayName || a.logicalName, b.displayName || b.logicalName) || byText(a.logicalName, b.logicalName) || (a.logicalName < b.logicalName ? -1 : a.logicalName > b.logicalName ? 1 : 0));
}

// How a search matches a table (03 §6): the best tier of its logical and entity set names and of its display name,
// each also ignoring spaces and punctuation (so 'Account Leads' finds accountleads and 'new project' new_project);
// `own` 1 when the logical name has that tier; the logical and display name ranges to show bold, and `name`: the
// ranges in the name as the row shows it (`<schema>.<logical name>` in the Archive and Recycle bin groups). With a
// `schema` ('archive', 'bin') a query that starts with '<schema>.' matches the rest against the table's names (an
// empty rest matches every table of the group), and any other query also matches the schema-qualified name, as
// metadata.* and sys.* names match. null without a match.
export function tableMatch(query, e, schema = null) {
  const q = String(query ?? '').trim();
  return q && e ? matchTable(q, e, schema, true) : null;
}

// The rest of a trimmed query after '<schema>.' (case ignored; trimmed), or null when it does not start with it.
export function schemaRest(q, schema) {
  if (!schema) return null;
  const p = schema + '.';
  const s = String(q ?? '').trim();
  return s.length >= p.length && s.slice(0, p.length).toLowerCase() === p ? s.slice(p.length).trim() : null;
}

// tableMatch() of a trimmed, non-empty query in a group (`schema` null for Tables); without `ranges` only {tier,
// own}.
function matchTable(q, e, schema, ranges) {
  if (!schema) {
    const m = scoreTable(q, e, ranges);
    if (m && ranges) m.name = m.logical;
    return m;
  }
  const at = schema.length + 1;
  const rest = schemaRest(q, schema);
  if (rest != null) {
    // 'archive.' + the table's names: the prefix is bold, the rest is matched as in the Tables group
    if (!rest) return ranges ? { tier: 3, own: 1, logical: [], display: [], name: [[0, at]] } : { tier: 3, own: 1 };
    const m = scoreTable(rest, e, ranges);
    if (m && ranges) m.name = [[0, at], ...m.logical.map(([a, b]) => [a + at, b + at])];
    return m;
  }
  const m = scoreTable(q, e, ranges);
  const qn = nameScore(q, schema + '.' + e.logicalName, PUNCT.test(q));
  if (!qn || (m && m.tier >= qn.tier)) {
    if (m && ranges) m.name = m.logical.map(([a, b]) => [a + at, b + at]);
    return m;
  }
  return ranges ? { tier: qn.tier, own: 1, logical: [], display: [], name: qn.ranges } : { tier: qn.tier, own: 1 };
}

// tableMatch() of a trimmed, non-empty query; without `ranges` only {tier, own}, which is all searchTables needs to
// filter and rank (the bold ranges are made for the rows that are painted).
function scoreTable(q, e, ranges) {
  const qp = PUNCT.test(q);
  const l = nameScore(q, e.logicalName, qp);
  const s = e.entitySetName ? nameScore(q, e.entitySetName, qp) : null;
  const d = e.displayName ? matchScore(q, e.displayName, true) : null;
  const tl = l?.tier ?? 0, tier = Math.max(tl, s?.tier ?? 0, d?.tier ?? 0);
  if (!tier) return null;
  const own = tl === tier ? 1 : 0;
  if (!ranges) return { tier, own };
  const dr = d && d.tier ? matchScore(q, e.displayName) : null;
  return { tier, own, logical: tl ? l.ranges : [], display: dr && dr.tier ? dr.ranges : [] };
}

const PUNCT = /[^\p{L}\p{N}]/u;
// A logical or entity set name's best match, strict or ignoring spaces and punctuation (the higher tier, the strict
// one on a tie: its ranges can be shown bold, a loose exact or prefix match has none). The loose form differs only
// when the query (`qp`) or the name has a character other than a letter or digit, so only then is it tried.
function nameScore(q, name, qp) {
  const strict = matchScore(q, name);
  const a = strict && strict.tier ? strict : null;
  if ((a && a.tier === 4) || (!qp && !PUNCT.test(name))) return a;
  const loose = matchScore(q, name, true);
  const b = loose && loose.tier ? loose : null;
  if (!a) return b;
  return b && b.tier > a.tier ? b : a;
}

// A plain name match (other groups' items): {tier, ranges} or null.
export function nameMatch(query, text) {
  const q = String(query ?? '').trim();
  if (!q) return null;
  const m = matchScore(q, String(text ?? ''));
  return m && m.tier ? m : null;
}

// The tables a search and the filter show, best first (search) or in list order: {items: [{e, m}], hiddenPrivate
// (matches only Show private tables would show), hiddenType (matches only the 'All' type would show), matched (every
// table the query matches, whatever the filter, in list order; the list itself without a query)}. `schema` names the
// Archive or Recycle bin group (tableMatch). Every match is a subsequence match, so a longer query matches a subset of
// what its prefix matched when refineQuery says so: searching `matched` again with the extended query then gives the
// same result as searching the whole list.
export function searchTables(list, query, filter = {}, schema = null) {
  const q = String(query ?? '').trim();
  const items = [];
  const src = list ?? [];
  const matched = q ? [] : src;
  let hiddenPrivate = 0, hiddenType = 0;
  for (let i = 0; i < src.length; i++) {
    const e = src[i];
    const m = q ? matchTable(q, e, schema, false) : null;
    if (q && !m) continue;
    if (q) matched.push(e);
    const typeOk = typeMatches(e, filter.type);
    const privOk = !e.isPrivate || !!filter.showPrivate;
    if (typeOk && privOk) { items.push({ e, m, i }); continue; }
    if (typeOk) hiddenPrivate++;
    else if (privOk) hiddenType++;
  }
  if (q) items.sort((a, b) => (b.m.tier - a.m.tier) || (b.m.own - a.m.own) || (a.i - b.i));
  return { items, hiddenPrivate, hiddenType, matched };
}

// Whether the matches of query `prev` contain every match of `next` (searchTables over the previous `matched` then
// gives the full result), in the group of `schema` (searchTables). A match is strict (the folded query is a
// subsequence of the folded name) or loose (both without spaces and punctuation), so this holds when the folded
// `next` starts with the folded `prev` and `prev` has a letter or digit: a query of only spaces and punctuation has no
// loose form and matches only names that contain it, while its extensions also match loosely ('-' then '-x_é').
// '<schema>.' queries compare their rests; a query that gains the prefix searches the whole list again.
export function refineQuery(prev, next, schema = null) {
  const rp = schemaRest(prev, schema), rn = schemaRest(next, schema);
  if (rp != null || rn != null) return rp != null && rn != null && refineQuery(rp, rn);
  const p = foldQuery(String(prev ?? '').trim()), n = foldQuery(String(next ?? '').trim());
  return p !== '' && n.startsWith(p) && p.replace(NON_ALNUM, '') !== '';
}

const NON_ALNUM = /[^\p{L}\p{N}]/gu;
// A query folded as complete.js matchScore folds it: per code point, accents removed and lower case.
function foldQuery(s) {
  let out = '';
  for (const ch of s) out += ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return out;
}

// The table row's icon name (03 §6 via the 03 §1.2 aliases).
export function tableIcon(e) {
  if (!e) return 'table';
  if (e.isActivity) return 'activity';
  if (e.isIntersect) return 'intersect';
  if (e.kind === 'virtual') return 'virtual';
  if (e.kind === 'elastic') return 'elastic';
  return 'table';
}

// The table row's tags (03 §6; Elastic as in the hover card).
export function tableTags(e) {
  if (!e) return [];
  return [e.isCustom && 'Custom', e.isActivity && 'Activity', e.isIntersect && 'N:N', e.kind === 'virtual' && 'Virtual', e.kind === 'elastic' && 'Elastic'].filter(Boolean);
}

// A column row's icon name (03 §6: text, number, money, calendar, choice, bool, lookup/link, guid/key, memo, image/file).
export function columnIcon(c) {
  const a = c?.attr;
  if (!a) return c?.virtual ? 'text' : 'column';
  if (a.isPk && !c.virtual) return 'key';
  if (c.virtual === 'type') return 'text';
  if (c.virtual === 'name') return 'text';
  switch (a.type) {
    case 'String': case 'EntityName': return 'text';
    case 'Memo': return 'memo';
    case 'Integer': case 'BigInt': case 'Decimal': case 'Double': return 'number';
    case 'Money': return 'money';
    case 'DateTime': return 'calendar';
    case 'Boolean': return 'bool';
    case 'Picklist': case 'State': case 'Status': return 'choice';
    case 'MultiSelectPicklist': return 'multiselect';
    case 'Lookup': case 'Customer': case 'Owner': return 'link';
    case 'Uniqueidentifier': return 'guid';
    case 'Image': return 'image';
    case 'File': return 'file';
    default: return 'column';
  }
}

// A column's SQL type text (types.js typeName of its static type; virtual name / type columns are nvarchar).
export function columnType(c) {
  if (!c) return '';
  if (c.virtual === 'name' || c.virtual === 'type') return c.attr ? typeName(dtOfAttr(c.attr)) : 'nvarchar';
  return c.attr ? typeName(dtOfAttr(c.attr)) : (c.type ?? '');
}

// A column's flags for its row (03 §6): {pk, primaryName, required, custom, notReadable, computed: 'Calculated' |
// 'Rollup' | null}.
export function columnFlags(c) {
  const a = c?.attr;
  if (!a || c.virtual) return { pk: false, primaryName: false, required: false, custom: false, notReadable: !!a && a.validForRead === false, computed: null };
  return {
    pk: !!a.isPk, primaryName: !!a.isPrimaryName, required: REQUIRED.has(a.requiredLevel), custom: !!a.isCustom,
    notReadable: a.validForRead === false, computed: a.sourceType === 1 ? 'Calculated' : a.sourceType === 2 ? 'Rollup' : null,
  };
}

// The type text of a script comment (Script as INSERT / UPDATE): 'lookup → account, contact', 'choice', 'bit', or the
// SQL type ('nvarchar(160)').
export function scriptTypeText(a) {
  if (!a) return '';
  if (LOOKUPS.has(a.type)) return `lookup → ${(a.targets ?? []).join(', ')}`.trimEnd();
  switch (a.type) {
    case 'Picklist': case 'State': case 'Status': return 'choice';
    case 'MultiSelectPicklist': return 'multi-select choice';
    case 'Boolean': return 'bit';
    default: return typeName(dtOfAttr(a));
  }
}

// A count as shown in the row tag and toast: '≈ 12,345' when approximate, else '12,345'.
export function countText(n, approx = false) {
  return (approx ? '≈ ' : '') + fmtInt(n);
}

// The SQL name of a table in a schema: account, archive.task, bin.account (names through sqlName).
export function tableRef(name, schema = null) {
  const n = sqlName(String(name));
  return schema ? `${schema}.${n}` : n;
}

// Select top 100 (03 §6).
export function selectTopSql(ref) {
  return `SELECT TOP 100 * FROM ${ref};`;
}

// Count rows (03 §6): the RetrieveTotalRecordCount hint only with {hint: true} (standard tables, 02 §4.5).
export function countSql(ref, { hint = false } = {}) {
  return `SELECT COUNT(*) AS [count] FROM ${ref}${hint ? " OPTION (USE HINT('RETRIEVE_TOTAL_RECORD_COUNT'))" : ''}`;
}

// A SELECT of named columns, one per line aligned under the first: `SELECT [TOP n ]a,\n       b\nFROM t;` (`*`
// without names). `names` are SQL names already.
export function selectColumnsSql(names, ref, { top = null } = {}) {
  const head = top == null ? 'SELECT ' : `SELECT TOP ${top} `;
  if (!names || !names.length) return `${head}* FROM ${ref};`;
  return head + names.join(',\n' + ' '.repeat(head.length)) + `\nFROM ${ref};`;
}

// The columns of a loaded table a script lists: 'select' (readable real columns), 'all' (every readable column, the
// virtual ones included), 'insert' (creatable real columns but the primary key; primary name, then the required
// ones, then the rest), 'update' (updatable real columns but the primary key, in the same order).
export function scriptColumns(info, purpose) {
  if (!info || !(info.attrs instanceof Map || Array.isArray(info.attrList))) return [];
  if (purpose === 'all') return tableColumns(info, 'read');
  const real = c => c.attr && !c.virtual;
  if (purpose === 'select') return tableColumns(info, 'read').filter(real);
  const cols = tableColumns(info, purpose === 'insert' ? 'create' : 'update').filter(c => real(c) && !c.attr.isPk);
  const rank = c => (c.attr.isPrimaryName ? 0 : REQUIRED.has(c.attr.requiredLevel) ? 1 : 2);
  return cols.map((c, i) => [c, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([c]) => c);
}

// Script as (tables, 03 §6): {sql, caret: [start, end]} for 'select' | 'insert' | 'update' | 'delete' of a loaded
// table in `schema` (null, 'archive', 'bin'). Values are left empty, so a write script does not parse until filled.
export function scriptTable(op, info, { schema = null } = {}) {
  const ref = tableRef(info.logicalName, schema);
  const end = s => ({ sql: s, caret: [s.length, s.length] });
  const pk = sqlName(info.primaryIdAttribute || info.logicalName + 'id');
  switch (op) {
    case 'select': return end(selectColumnsSql(scriptColumns(info, 'select').map(c => sqlName(c.name)), ref));
    case 'delete': {
      const sql = `DELETE FROM ${ref}\nWHERE ${pk} = ;`;
      return { sql, caret: [sql.length - 1, sql.length - 1] };
    }
    case 'insert': {
      const cols = scriptColumns(info, 'insert');
      if (!cols.length) return end(`-- ${note(ref)} has no columns that can be set when a record is created.\nINSERT INTO ${ref} DEFAULT VALUES;`);
      const names = cols.map(c => sqlName(c.name));
      const head = `INSERT INTO ${ref} (\n` + names.map((n, i) => `    ${n}${i < names.length - 1 ? ',' : ''}`).join('\n') + '\n)\nVALUES (\n';
      const vals = cols.map((c, i) => `    ${i < cols.length - 1 ? ',' : ' '}  -- ${note(c.name)}: ${note(scriptTypeText(c.attr))}${REQUIRED.has(c.attr.requiredLevel) ? ', required' : ''}`);
      const sql = head + vals.join('\n') + '\n);';
      return { sql, caret: [head.length + 4, head.length + 4] };
    }
    case 'update': {
      const cols = scriptColumns(info, 'update');
      if (!cols.length) return end(`-- ${note(ref)} has no columns that can be updated.`);
      const lines = cols.map((c, i) => `${i ? '    ' : 'SET '}${sqlName(c.name)} = ${i < cols.length - 1 ? ',' : ''}  -- ${note(scriptTypeText(c.attr))}${REQUIRED.has(c.attr.requiredLevel) ? ', required' : ''}`);
      const head = `UPDATE ${ref}\n`;
      const sql = head + lines.join('\n') + `\nWHERE ${pk} = ;`;
      const at = head.length + lines[0].indexOf('= ') + 2;
      return { sql, caret: [at, at] };
    }
    default: throw new TypeError(`scriptTable(): unknown operation '${op}'.`);
  }
}

// Show columns (03 §6): the table's metadata.attribute rows.
export function showColumnsSql(name) {
  return 'SELECT logicalname, displayname, attributetypename, requiredlevel, isvalidforread, isvalidforcreate, isvalidforupdate, iscustomattribute, description\n'
    + `FROM metadata.attribute\nWHERE entitylogicalname = ${sqlStr(String(name))}\nORDER BY logicalname;`;
}

// Show relationships (03 §6): one result set each of the table's 1:N, N:1 and N:N relationships.
export function showRelationshipsSql(name) {
  const n = sqlStr(String(name));
  const oneN = 'SELECT schemaname, referencedentity, referencedattribute, referencingentity, referencingattribute';
  return `${oneN}, cascadedelete\nFROM metadata.relationship_1_n\nWHERE referencedentity = ${n}\nORDER BY schemaname;\n`
    + `${oneN}\nFROM metadata.relationship_n_1\nWHERE referencingentity = ${n}\nORDER BY schemaname;\n`
    + 'SELECT schemaname, entity1logicalname, entity2logicalname, intersectentityname\nFROM metadata.relationship_n_n\n'
    + `WHERE entity1logicalname = ${n} OR entity2logicalname = ${n}\nORDER BY schemaname;`;
}

// The SQL type of a meta.messages() parameter or response type (nvarchar(max) when unknown); `find`
// (logical name -> EntityInfo | null) tells a table-typed parameter.
export function messageSqlType(type, find = null) {
  const t = String(type ?? '');
  const known = MSG_SQL_TYPES.get(t.toLowerCase());
  if (known) return known;
  if (t && t === t.toLowerCase() && typeof find === 'function' && find(t)) return 'entityreference';
  return 'nvarchar(max)';
}

// The type text of an EXEC script comment: the SQL type, with the table of a table-typed parameter.
function messageTypeText(type, find, table = null) {
  const sqlType = messageSqlType(type, find);
  const t = String(type ?? '');
  const tbl = table ?? (sqlType === 'entityreference' && t && t === t.toLowerCase() && typeof find === 'function' && find(t) ? t : null);
  return tbl ? `${sqlType} (${tbl})` : sqlType;
}

// Script as SELECT of a Web API function (03 §6): {sql, caret} (the first DECLARE's NULL selected).
export function scriptFunctionSelect(m, { find = null } = {}) {
  const name = sqlName(m.name);
  const decls = [], args = [];
  const used = new Set((m.params ?? []).map(p => lower(p.name)));
  if (m.binding === 'entity' && m.boundTo) {
    const pk = find?.(m.boundTo)?.primaryIdAttribute;
    let v = IDENT.test(pk ?? '') ? pk : IDENT.test(`${m.boundTo}id`) ? `${m.boundTo}id` : 'id';
    while (used.has(lower(v))) v = '_' + v;
    used.add(lower(v));
    decls.push(`DECLARE @${v} uniqueidentifier = NULL; -- change this (required: the ${note(m.boundTo)} record)`);
    args.push('@' + v);
  }
  (m.params ?? []).forEach((p, i) => {
    // the arguments are positional, so a name that cannot be a variable name (meta.js leaves none) gets @p<n>
    let v = String(p.name ?? '');
    if (!IDENT.test(v)) { v = `p${i + 1}`; while (used.has(lower(v))) v = '_' + v; used.add(lower(v)); }
    decls.push(`DECLARE @${v} ${messageSqlType(p.type, find)} = NULL; -- change this (${p.optional ? 'optional' : 'required'})`);
    args.push('@' + v);
  });
  const call = `SELECT * FROM ${name}(${args.join(', ')});`;
  if (!decls.length) return { sql: call, caret: [call.length, call.length] };
  const sql = decls.join('\n') + '\n' + call;
  const at = decls[0].indexOf('= NULL;') + 2;
  return { sql, caret: [at, at + 4] };
}

// Script as EXEC of a Web API action (03 §6): {sql, caret} (after the first `= `).
export function scriptActionExec(m, { find = null } = {}) {
  const params = [];
  if (m.binding === 'entity' && m.boundTo && !(m.params ?? []).some(p => lower(p.name) === 'target')) {
    params.push({ name: 'Target', type: 'EntityReference', optional: false, table: m.boundTo, pos: -1 });
  }
  (m.params ?? []).forEach((p, i) => params.push({ ...p, pos: i }));
  params.sort((a, b) => (a.optional ? 1 : 0) - (b.optional ? 1 : 0) || a.pos - b.pos);
  const head = `EXEC ${sqlName(m.name)}`;
  // a name that is not an identifier (meta.js leaves none) cannot be written as `@Name =`: it is said, not dropped
  const ok = params.filter(p => IDENT.test(String(p.name ?? '')));
  const lines = ok.map((p, i) => `    @${p.name} = ${i < ok.length - 1 ? ',' : ''}  -- ${note(messageTypeText(p.type, find, p.table ?? null))}, ${p.optional ? 'optional' : 'required'}`);
  if (ok.length < params.length) lines.push(`    -- ${params.length - ok.length} more parameter(s): a name that is not an identifier cannot be written here`);
  const outs = (m.response ?? []).filter(r => IDENT.test(String(r.name ?? ''))).map(r => `    -- @${r.name} = @var OUTPUT  -- ${note(messageTypeText(r.type, find))}`);
  const sql = [head, ...lines, ...outs].join('\n');
  if (!ok.length) return { sql, caret: [head.length, head.length] };
  const at = head.length + 1 + lines[0].indexOf('= ') + 2;
  return { sql, caret: [at, at] };
}

// The text a built-in function row inserts (03 §6; completion's rules, plus AT TIME ZONE, the xml methods and
// sys.fn_helpcollations()).
export function builtinInsert(doc) {
  if (!doc) return '';
  const name = String(doc.name);
  const up = name.toUpperCase();
  if (up === 'AT TIME ZONE') return ' AT TIME ZONE ';
  if (/^xml\./i.test(name)) return '.' + name.slice(4) + '(';
  if (up === 'FN_HELPCOLLATIONS') return 'sys.fn_helpcollations()';
  if (NILADIC.has(up)) return name;
  const sig = String(doc.sig ?? '');
  if (sig.startsWith('()')) return name + '() OVER (';
  const args = (doc.params ?? []).filter(p => !p.clause);
  if (!args.length && !/\[/.test(sig)) return name + '()';
  return name + '(';
}

// Characters a name, literal or call ends with, and those one starts with (spacedInsert).
const WORD_END = /[\p{L}\p{N}_@#$\]"')]/u;
const WORD_START = /[\p{L}\p{N}_@#$\["']/u;
// The text an insert (double-click, Enter, Insert name) puts at the caret: a space before it when it would run into
// the word, closing bracket, quote or ')' before the caret, and one after it when it would run into the word after
// (`FROM|` + account gives `FROM account`, `a.|` + name `a.name`). A drag is not spaced: the textarea inserts the
// dropped text itself.
export function spacedInsert(text, before = '', after = '') {
  const t = String(text ?? '');
  if (!t) return t;
  const b = before && WORD_END.test(before) && WORD_START.test(t[0]) ? ' ' : '';
  const a = after && WORD_START.test(after) && WORD_END.test(t[t.length - 1]) ? ' ' : '';
  return b + t + a;
}

// The built-in function categories in docList() order (01 §8.2): [[category, docs[]]].
export function builtinCategories(docs = docList()) {
  const out = new Map();
  for (const d of docs ?? []) {
    if (!d) continue;
    if (!out.has(d.category)) out.set(d.category, []);
    out.get(d.category).push(d);
  }
  return [...out];
}

// A table's relationships as rows (03 §6): N:1 by column then target, 1:N and N:N by schema name.
export function relationshipItems(rels, table) {
  if (!rels) return [];
  const t = lower(table);
  const n1 = (rels.n1 ?? []).map(r => ({ kind: 'n1', id: `n1:${r.schemaName}:${r.target}`, label: `N:1 ${r.attr} → ${r.target}`, sub: r.schemaName, ...r }))
    .sort((a, b) => byText(a.attr, b.attr) || byText(a.target, b.target));
  const oneN = (rels.oneN ?? []).map(r => ({ kind: '1n', id: `1n:${r.schemaName}:${r.source}:${r.attr}`, label: `1:N ${r.schemaName}`, sub: `${r.source}.${r.attr}`, ...r }))
    .sort((a, b) => byText(a.schemaName, b.schemaName));
  const nn = (rels.nn ?? []).map(r => {
    const other = r.entity1 === t ? r.entity2 : r.entity1;
    return { kind: 'nn', id: `nn:${r.schemaName}`, label: `N:N ${r.intersect}`, sub: `${other} · ${r.schemaName}`, other, ...r };
  }).sort((a, b) => byText(a.schemaName, b.schemaName));
  return [...n1, ...oneN, ...nn];
}

// The JOIN a relationship row inserts (03 §6): with the table in `scope` (complete.js analyze sources at the caret)
// `INNER JOIN <other> <a> ON …` with its alias, else `<table> <t> INNER JOIN <other> <a> ON …`. `find` gives the
// primary keys of N:N tables.
export function joinSql(rel, table, { scope = [], find = () => null } = {}) {
  const t = lower(table);
  const used = new Set();
  for (const s of scope ?? []) { if (s?.alias) used.add(lower(s.alias)); if (s?.name) used.add(lower(s.name)); }
  const mine = (scope ?? []).find(s => s && s.kind === 'table' && !s.schema && (lower(s.name) === t || lower(find(s.name)?.logicalName) === t));
  let lead = '', ta;
  if (mine) ta = nameSql(mine.alias || mine.name);
  else { ta = uniqueAlias(t, used); lead = `${nameSql(t)} ${ta} `; }
  switch (rel.kind) {
    case 'n1': {
      const a = uniqueAlias(rel.target, used);
      return `${lead}INNER JOIN ${nameSql(rel.target)} ${a} ON ${a}.${nameSql(rel.targetAttr)} = ${ta}.${nameSql(rel.attr)}`;
    }
    case '1n': {
      const a = uniqueAlias(rel.source, used);
      return `${lead}INNER JOIN ${nameSql(rel.source)} ${a} ON ${a}.${nameSql(rel.attr)} = ${ta}.${nameSql(rel.sourceAttr)}`;
    }
    case 'nn': {
      const mine1 = rel.entity1 === t;
      const other = mine1 ? rel.entity2 : rel.entity1;
      const mineAttr = mine1 ? rel.entity1Attr : rel.entity2Attr, otherAttr = mine1 ? rel.entity2Attr : rel.entity1Attr;
      const ia = uniqueAlias(rel.intersect, used), oa = uniqueAlias(other, used);
      const myPk = find(t)?.primaryIdAttribute || `${t}id`, otherPk = find(other)?.primaryIdAttribute || `${other}id`;
      return `${lead}INNER JOIN ${nameSql(rel.intersect)} ${ia} ON ${ia}.${nameSql(mineAttr)} = ${ta}.${nameSql(myPk)} `
        + `INNER JOIN ${nameSql(other)} ${oa} ON ${oa}.${nameSql(otherPk)} = ${ia}.${nameSql(otherAttr)}`;
    }
    default: return '';
  }
}

// Flattens the visible tree (03 §6, §13): every expanded node's children after it. Sets each node's level,
// posinset, setsize (aria-hidden rows are not counted), idx (its index) and parent (the node it is listed under, null
// for a root; kept when the node leaves the tree, so focus can go to its nearest ancestor still shown) and returns
// {nodes, starts (slot of each node), slots}.
export function flattenTree(roots, { children, expanded }) {
  const nodes = [], starts = [];
  let slot = 0;
  const visit = (list, level, parent) => {
    let size = 0;
    for (const n of list) if (!n.hidden) size++;
    let pos = 0;
    for (const n of list) {
      n.level = level;
      n.parent = parent;
      if (n.hidden) { n.pos = 0; n.size = 0; } else { n.pos = ++pos; n.size = size; }
      n.idx = nodes.length;
      nodes.push(n);
      starts.push(slot);
      slot += n.span || 1;
      if (expanded(n)) {
        const kids = children(n);
        if (kids && kids.length) visit(kids, level + 1, n);
      }
    }
  };
  visit(roots ?? [], 1, null);
  return { nodes, starts, slots: slot };
}

// The index of the node that covers `slot` (binary search over starts), or -1 for an empty tree.
export function indexAtSlot(starts, slot) {
  if (!starts.length) return -1;
  let lo = 0, hi = starts.length - 1;
  if (slot <= 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= slot) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// The virtual window (03 §13): {spacer (px), shift, firstSlot, lastSlot (exclusive)}, where a slot's top is
// slot * rowH - shift. Above maxPx the scroll position maps linearly onto the whole list.
export function virtualWindow({ scrollTop = 0, viewH = 0, slots = 0, rowH = ROW_H, overscan = OVERSCAN, maxPx = MAX_PX } = {}) {
  const full = slots * rowH;
  const spacer = Math.min(full, maxPx);
  const scaled = full > maxPx && maxPx > viewH;
  const range = Math.max(0, spacer - viewH);
  const st = Math.min(Math.max(0, Number(scrollTop) || 0), range);
  const vtop = scaled ? (range > 0 ? st * (full - viewH) / range : 0) : st;
  const firstSlot = Math.max(0, Math.floor(vtop / rowH) - overscan);
  const lastSlot = Math.min(slots, Math.ceil((vtop + Math.max(0, viewH)) / rowH) + overscan);
  return { spacer, shift: vtop - st, firstSlot, lastSlot, scaled };
}

// The scrollTop that shows slots [slot, slot + span) with the least movement (03 §13), or the current one.
export function revealScrollTop(slot, span, { scrollTop = 0, viewH = 0, slots = 0, rowH = ROW_H, maxPx = MAX_PX } = {}) {
  const full = slots * rowH;
  const spacer = Math.min(full, maxPx);
  const range = Math.max(0, spacer - viewH);
  const ratio = full > maxPx && maxPx > viewH && range > 0 ? (full - viewH) / range : 1;
  const vtop = Math.min(Math.max(0, scrollTop), range) * ratio;
  const top = slot * rowH, bottom = (slot + Math.max(1, span)) * rowH;
  let v = vtop;
  if (top < vtop) v = top;
  else if (bottom > vtop + viewH) v = Math.max(0, bottom - viewH);
  return Math.min(range, Math.max(0, v / ratio));
}

// The tree's keyboard moves (WAI-ARIA tree; 03 §6): {to: index} | {expand: true} | {collapse: true} | null for `key`
// at index i. rows[k] = {level, focusable?, hidden?} (hidden rows and focusable false are skipped); `expandable(k)`
// and `expanded(k)` describe row k; `page` rows per page.
export function treeNav(rows, i, key, { page = 10, expandable = () => false, expanded = () => false } = {}) {
  const n = rows.length;
  if (!n) return null;
  const ok = k => k >= 0 && k < n && rows[k].focusable !== false && rows[k].hidden !== true;
  const next = (from, dir) => { for (let k = from; k >= 0 && k < n; k += dir) if (ok(k)) return k; return -1; };
  const cur = i >= 0 && i < n ? i : next(0, 1);
  const res = k => (k >= 0 && k !== cur ? { to: k } : null);
  switch (key) {
    case 'ArrowDown': return res(next(cur + 1, 1));
    case 'ArrowUp': return res(next(cur - 1, -1));
    case 'Home': return res(next(0, 1));
    case 'End': return res(next(n - 1, -1));
    case 'PageDown': { const k = next(Math.min(n - 1, cur + page), -1); return res(k > cur ? k : next(cur + 1, 1)); }
    case 'PageUp': { const k = next(Math.max(0, cur - page), 1); return res(k >= 0 && k < cur ? k : next(cur - 1, -1)); }
    case 'ArrowRight': {
      if (!expandable(cur)) return null;
      if (!expanded(cur)) return { expand: true };
      return ok(cur + 1) && rows[cur + 1].level === rows[cur].level + 1 ? { to: cur + 1 } : null;
    }
    case 'ArrowLeft': {
      if (expandable(cur) && expanded(cur)) return { collapse: true };
      for (let k = cur - 1; k >= 0; k--) if (rows[k].level < rows[cur].level) return ok(k) ? { to: k } : null;
      return null;
    }
    default: return null;
  }
}

// Type-ahead (WAI-ARIA tree): of rows 0..n-1, the first after `from` (wrapping, `from` itself last) whose label
// (labelAt(i): a string, or null for a row that cannot take focus) starts with `prefix` (case and accents ignored),
// or -1. A one-letter prefix starts after `from`, a longer one at `from`.
export function typeAhead(n, labelAt, from, prefix) {
  const p = fold(prefix);
  if (!p || !n) return -1;
  // a repeated single letter cycles through the matches; a longer prefix may stay on the current row
  const start = p.length > 1 ? from : from + 1;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    const l = labelAt(i);
    if (l != null && fold(l).startsWith(p)) return i;
  }
  return -1;
}
const fold = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Label text with bold matched ranges (h() nodes).
function marked(text, ranges, offset = 0) {
  const s = String(text ?? '');
  if (!ranges || !ranges.length) return [s];
  const out = [];
  let at = 0;
  for (const [a0, b0] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const a = a0 + offset, b = b0 + offset;
    if (a < at || b <= a || a >= s.length) continue;
    if (a > at) out.push(s.slice(at, a));
    out.push(h('b', null, s.slice(a, Math.min(b, s.length))));
    at = Math.min(b, s.length);
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}

// ------------------------------------------------------------------------------------------------------ the CSS

// Module CSS (03 §1.3): .ex- classes only, colours only from var(--token) (and color-mix of tokens).
export const CSS = `.ex-root{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;background:var(--bg1);color:var(--fg1)}
.ex-head{display:flex;align-items:center;gap:4px;padding:8px 8px 8px 12px;flex:none;border-bottom:1px solid var(--s3)}
.ex-head .input{flex:1;min-width:0}
.ex-head .btn.icon.on{color:var(--brand)}
.ex-head .btn.icon.on::after{content:'';position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:3px;background:var(--brand)}
.ex-head .btn.icon[aria-busy=true] svg{animation:spin .7s linear infinite}
.ex-scroll{flex:1;min-height:0;overflow:auto;position:relative;overscroll-behavior:contain}
.ex-scroll.ex-drop{box-shadow:inset 0 0 0 2px var(--brand);background:color-mix(in srgb,var(--brand-bg) 60%,var(--bg1))}
.ex-rows{position:relative;width:100%;min-height:100%;outline:0}
.ex-row{position:absolute;left:0;right:0;display:flex;align-items:center;gap:6px;height:var(--tree-h);box-sizing:border-box;padding:0 8px 0 calc(4px + var(--ex-lv,0) * 16px);cursor:pointer;white-space:nowrap;overflow:hidden;user-select:none;color:var(--fg1);background:var(--bg1);transition:background .08s}
.ex-row:hover{background:var(--bg3)}
.ex-row.on{background:var(--brand-bg)}
.ex-row.on:hover{background:var(--brand-bg-h)}
.ex-row:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.ex-cv{flex:none;width:16px;height:16px;display:grid;place-items:center;color:var(--fg3)}
.ex-cv svg{transform:rotate(-90deg);transition:transform .1s}
.ex-row[aria-expanded=true]>.ex-cv svg{transform:none}
.ex-ic{flex:none;display:grid;color:var(--fg2)}
.ex-nm{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}
.ex-nm b,.ex-sub b{font-weight:600;color:var(--brand)}
.ex-pn .ex-nm,.ex-grp .ex-nm{font-weight:600}
.ex-sub{min-width:0;flex:0 1000 auto;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:16px;color:var(--fg3)}
.ex-mono{font-family:var(--mono);font-size:12px}
.ex-row .tag{margin-left:0;flex:none}
.ex-end{margin-left:auto;padding-left:8px;flex:none;font-size:12px;line-height:16px;color:var(--fg3);font-variant-numeric:tabular-nums}
.ex-req{flex:none;width:6px;height:6px;border-radius:3px;background:var(--red)}
.ex-row.dim .ex-nm,.ex-row.dim .ex-ic,.ex-row.dim .ex-sub{color:var(--fg4)}
.ex-acts{position:absolute;top:2px;right:4px;display:none;gap:2px;background:inherit;padding-left:4px}
.ex-row:hover>.ex-acts,.ex-row:focus-within>.ex-acts,.ex-row:focus>.ex-acts{display:flex}
.ex-acts .btn.icon{width:24px;height:24px;color:var(--fg2)}
.ex-acts .btn.icon:hover{color:var(--fg1)}
.ex-acts .btn[aria-disabled=true],.ex-acts .btn[aria-disabled=true]:hover{color:var(--dis-fg);background:transparent;cursor:default}
.ex-row .link{font-size:12px;line-height:16px;flex:none}
.ex-msg{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--fg3)}
.ex-err .ex-ic{color:var(--red)}
.ex-warn .ex-ic{color:var(--amber)}
.ex-sk{position:absolute;left:0;right:0;display:flex;align-items:center;gap:8px;height:var(--tree-h);box-sizing:border-box;padding:0 12px 0 calc(24px + var(--ex-lv,0) * 16px);pointer-events:none}
.ex-sk i{display:block;height:10px;border-radius:5px;background:linear-gradient(90deg,var(--bg3) 0,var(--bg4) 50%,var(--bg3) 100%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}
.ex-sk i:first-child{width:16px;height:16px;border-radius:3px;flex:none}
.ex-st{position:absolute;left:0;right:0;box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:8px 12px 8px calc(8px + var(--ex-lv,0) * 16px);cursor:default;overflow:hidden;color:var(--fg3);background:var(--bg1)}
.ex-st:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.ex-st .ic{flex:none;width:32px;height:32px;border-radius:16px;display:grid;place-items:center;background:var(--bg3);color:var(--fg3)}
.ex-st .ic.bad{background:var(--red-bg);color:var(--red)}
.ex-st .ex-stt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ex-st b{color:var(--fg1);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ex-st .ex-msg{font-size:12px;line-height:16px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow-wrap:anywhere}
.ex-st .acts{display:flex;gap:12px;flex-wrap:wrap}
.ex-tl2{display:block;margin-top:2px;font-size:12px;line-height:16px;color:var(--fg3)}
@media (prefers-reduced-motion:reduce){.ex-row,.ex-cv svg{transition:none}.ex-sk i,.ex-head .btn.icon[aria-busy=true] svg{animation:none}}
@media (forced-colors:active){.ex-row.on{outline:1px solid Highlight;outline-offset:-1px}.ex-req{background:CanvasText}.ex-scroll.ex-drop{outline:2px dashed Highlight;outline-offset:-2px}}
`;

// ------------------------------------------------------------------------------------------------ the explorer

// Mounts the object explorer in `host` (the shell's side region; 03 §1.4, §6) and returns its controller.
export function createExplorer(host, opts = {}) {
  const meta = opts.meta ?? null;
  const S = opts.state ?? null;
  const shell = opts.shell ?? null;
  const editor = opts.editor ?? null;
  const results = opts.results ?? null;
  const later = typeof opts.later === 'function' ? opts.later : (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };
  const frame = typeof opts.frame === 'function' ? opts.frame
    : typeof globalThis.requestAnimationFrame === 'function' ? fn => globalThis.requestAnimationFrame(fn) : null;
  const searchDelay = Number.isFinite(opts.searchDelay) ? Math.max(0, opts.searchDelay) : 60;
  const io = () => ({ copyText: opts.io?.copyText ?? util.copyText, openUrl: opts.io?.openUrl ?? util.openUrl });
  const st = () => S?.state ?? {};
  const settings = () => { try { return (typeof S?.getSettings === 'function' ? S.getSettings() : null) ?? {}; } catch { return {}; } };
  const find = name => (meta && typeof meta.findEntity === 'function' && name ? meta.findEntity(String(name)) : null);
  const entities = () => { try { return (meta && typeof meta.entities === 'function' ? meta.entities() : null) ?? []; } catch { return []; } };
  const toast = (text, o) => shell?.toast?.(text, o);
  const fail = e => toast(String(e?.message ?? e ?? 'Something went wrong.'), { kind: 'error' });
  const announce = text => { try { shell?.announce?.(text); } catch { /* the live region is optional */ } };
  const offs = [];
  let destroyed = false;

  // ---- data state
  let listState = entities().length ? 'ready' : 'loading';
  let listError = null;
  let initDone = false;
  let query = '';
  const filter = { type: 'all', showPrivate: false };
  const expanded = new Set(['g:tables', 'g:temps']);
  const searchCollapsed = new Set();  // groups and categories collapsed during this search
  const searchOpened = new Set();     // groups that start collapsed in a search (no match) and were opened
  const loads = new Map();            // 'e:' | 'r:' | 'k:' + logical name -> {status, error, value}
  const counts = new Map();           // table ref ('account', 'archive.task') -> {n, approx}
  let bin = { status: 'idle', set: null, error: null };
  let msgs = { status: 'idle', map: null, error: null };
  let builtins = null;                // [[category, docs]] once the group was expanded (or searched)
  let refreshing = false;
  let generation = 0;
  let sortedFor = null, sorted = [];
  let lastMatches = 0;                // tables the current search matches (announced)

  // ---- nodes: stable objects per id (keyed DOM reuse); `v` changes with the row's content
  const nodes = new Map();
  function node(id, kind, data) {
    let n = nodes.get(id);
    if (!n) { n = { id, kind, v: 0, level: 1, pos: 0, size: 0, span: 1, hidden: false }; nodes.set(id, n); }
    for (const k in data) if (n[k] !== data[k]) { n[k] = data[k]; n.v++; }
    return n;
  }
  const bump = n => { if (n) n.v++; };

  // ---- DOM
  const treeId = util.uid('ex-tree');
  const mac = typeof opts.mac === 'boolean' ? opts.mac : isMacPlatform();
  const search = h('input', {
    type: 'search', placeholder: 'Search tables', 'aria-label': 'Search tables', title: titleFor('explorerSearch', { mac }),
    'aria-keyshortcuts': ariaKeys('explorerSearch', mac) || null, autocomplete: 'off', spellcheck: 'false', 'aria-controls': treeId,
  });
  const filterBtn = h('button', { class: 'btn subtle icon', type: 'button', title: 'Filter tables', 'aria-label': 'Filter tables', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('filter', 20));
  const refreshBtn = h('button', { class: 'btn subtle icon', type: 'button', title: 'Reload metadata', 'aria-label': 'Reload metadata' }, icon('refresh', 20));
  const rows = h('div', { class: 'ex-rows', role: 'tree', id: treeId, 'aria-label': 'Object explorer' });
  const scroller = h('div', { class: 'ex-scroll' }, rows);
  const root = h('div', { class: 'ex-root' }, h('div', { class: 'ex-head' }, h('label', { class: 'input ex-search' }, icon('search', 16), search), filterBtn, refreshBtn), scroller);
  host?.appendChild?.(root);

  // ---- run and insert capabilities
  function runLock() {
    const r = st().running;
    if (!r) return null;
    return runLockTitle(S?.getTab?.(r.tabId)?.title ?? '');
  }
  const canRunTab = () => typeof results?.runTab === 'function';
  const canQuiet = () => typeof results?.runQuiet === 'function';
  // {disabled, title} of a run action (03 §6, §7): the results area and the run lock.
  function runState(quiet = false) {
    if (!(quiet ? canQuiet() : canRunTab()) || !S) return { disabled: true, title: TEXT.noResults };
    const lock = runLock();
    return lock ? { disabled: true, title: lock } : { disabled: false, title: null };
  }
  const insertState = () => (typeof editor?.insert === 'function' ? { disabled: false, title: null } : { disabled: true, title: TEXT.noEditor });

  // ---- tree model
  let model = { nodes: [], starts: [], slots: 0 };
  let active = null;                  // the active (roving tabindex) node

  function isSearching() { return query.trim() !== ''; }
  function expandable(n) {
    switch (n.kind) {
      case 'group': case 'folder': case 'category': case 'meta': case 'sys': case 'temp': return true;
      case 'table': return true;
      default: return false;
    }
  }
  function isExpanded(n) {
    if (!expandable(n)) return false;
    if (isSearching() && (n.kind === 'group' || n.kind === 'category')) return n.searchClosed ? searchOpened.has(n.id) : !searchCollapsed.has(n.id);
    return expanded.has(n.id);
  }

  function sortedTables() {
    const list = entities();
    if (sortedFor !== list) { sortedFor = list; sorted = sortTables(list); sortedAt = null; }
    return sorted;
  }
  // An entity() load (meta.onChange {kind: 'entity'}): meta.js puts the loaded EntityInfo in place of its list entry
  // in a new list array. When nothing else changed and none of LIST_FIELDS did, the new object replaces the old one in
  // the sorted list, the kept search results and the table rows, so the list is neither sorted nor searched again
  // (03 §13: table loads land while the user types); false when the list must be sorted again.
  let sortedAt = null;                // logical name -> index in `sorted`, made on first patch
  function patchEntity(name) {
    const list = entities();
    if (sortedFor === null || list === sortedFor) return true;
    if (!Array.isArray(list) || !Array.isArray(sortedFor) || list.length !== sortedFor.length) return false;
    let old = null, nu = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i] === sortedFor[i]) continue;
      if (old || !list[i] || !sortedFor[i] || list[i].logicalName !== name || sortedFor[i].logicalName !== name) return false;
      old = sortedFor[i]; nu = list[i];
    }
    if (!old) { sortedFor = list; return true; }
    for (const f of LIST_FIELDS) if (old[f] !== nu[f]) return false;
    if (!sortedAt) { sortedAt = new Map(); sorted.forEach((e, i) => sortedAt.set(e.logicalName, i)); }
    const at = sortedAt.get(name);
    if (at == null || sorted[at] !== old) return false;
    sorted[at] = nu;
    sortedFor = list;
    const swap = arr => { if (arr && arr !== sorted) { const k = arr.indexOf(old); if (k >= 0) arr[k] = nu; } };
    for (const m of rowMemo.values()) swap(m.matched);
    for (const m of listMemo.values()) swap(m.list);
    for (const p of Object.values(ID_PREFIX)) {
      const n = nodes.get(p + name);
      if (n && n.e === old) { n.e = nu; n.v++; }
    }
    return true;
  }
  const skeleton = (parentId, count) => Array.from({ length: count }, (_, i) => node(`${parentId}/sk:${i}`, 'sk', { hidden: true, w: 30 + ((i * 37) % 45) }));
  const info = (id, text, links = [], o = {}) => node(id, 'info', { text, links, tone: o.tone ?? null, title: o.title ?? null });

  // The table rows of a group (03 §6): {items, hiddenPrivate, hiddenType}. Kept per group while the list, the query,
  // the filter and the metadata stay the same, so expanding, collapsing and repainting never search the list again
  // (03 §13: 500,000 rows stay smooth); a query that extends the previous one searches only its matches.
  const rowMemo = new Map();          // schema key -> {list, q, type, priv, epoch, matched, res}
  let metaEpoch = 0;                  // bumped by every metadata change, so no kept rows outlive one
  function tableRows(list, schema) {
    const key = schema ?? 'tables';
    const q = query.trim();
    const prev = rowMemo.get(key);
    const same = prev && prev.list === list && prev.epoch === metaEpoch;
    if (same && prev.q === q && prev.type === filter.type && prev.priv === filter.showPrivate) return prev.res;
    const r = searchTables(same && refineQuery(prev.q, q, schema) ? prev.matched : list, q, filter, schema);
    const prefix = ID_PREFIX[key];
    const items = r.items.map(({ e }) => node(prefix + e.logicalName, 'table', { e, schema, q }));
    const res = { items, hiddenPrivate: r.hiddenPrivate, hiddenType: r.hiddenType };
    rowMemo.set(key, { list, q, type: filter.type, priv: filter.showPrivate, epoch: metaEpoch, matched: r.matched, res });
    return res;
  }
  // The Archive and Recycle bin lists, kept like the rows.
  const listMemo = new Map();         // 'archive' | 'bin' -> {src, epoch, set, list}
  function derivedList(key, pred, set = null) {
    const src = sortedTables();
    const m = listMemo.get(key);
    if (m && m.src === src && m.epoch === metaEpoch && m.set === set) return m.list;
    const list = src.filter(pred);
    listMemo.set(key, { src, epoch: metaEpoch, set, list });
    return list;
  }

  function noTablesLinks(r) {
    const links = [{ label: TEXT.clearSearch, run: () => setQuery('') }];
    if (r.hiddenPrivate) links.push({ label: TEXT.showPrivate, run: () => setFilter({ showPrivate: true }) });
    if (r.hiddenType) links.push({ label: TEXT.showAllTypes, run: () => setFilter({ type: 'all' }) });
    return links;
  }

  // The top groups with their children and counts (rebuilt for every flatten).
  function rootsOf() {
    const searching = isSearching();
    const out = [];
    const ents = entities();
    const add = (id, items, count, extra = {}) => {
      const g = GROUPS.find(x => x[0] === id);
      const n = node('g:' + id, 'group', { group: id, label: g[1], ic: g[2], count, ...extra });
      n.items = items;
      out.push(n);
      return n;
    };
    let anyMatch = false;
    // Tables
    let tablesNoMatch = null;
    if (!ents.length && listState !== 'ready') {
      add('tables', listState === 'failed' ? [node('g:tables/failed', 'state', { variant: 'failed', title: TEXT.tablesFailed, text: String(listError?.message ?? listError ?? ''), span: STATE_SPAN })]
        : skeleton('g:tables', SK_ROWS), null, { busy: listState === 'loading' });
    } else {
      const r = tableRows(sortedTables(), null);
      if (r.items.length) anyMatch = true;
      else if (searching) tablesNoMatch = r;
      lastMatches = r.items.length;
      add('tables', r.items.length ? r.items : searching ? [info('g:tables/none', noMatchLine(query), noTablesLinks(r))] : [info('g:tables/empty', 'No tables to show.')],
        r.items.length, { busy: false });
    }
    // Metadata and System objects (the bold ranges are made when a row is painted, so a rebuild changes no row)
    const q = searching ? query : '';
    const metaItems = META_TABLES.filter(t => !searching || nameMatch(query, t.name) || nameMatch(query, 'metadata.' + t.name))
      .map(t => node('m:' + t.name, 'meta', { table: t, q }));
    if (!searching || metaItems.length) { add('metadata', metaItems, metaItems.length); if (metaItems.length) anyMatch = true; }
    const sysItems = SYS_OBJECTS.filter(o => !searching || nameMatch(query, o.label) || nameMatch(query, o.name))
      .map(o => node('s:' + o.name, 'sys', { obj: o, q }));
    if (!searching || sysItems.length) { add('sys', sysItems, sysItems.length); if (sysItems.length) anyMatch = true; }
    // Archive and Recycle bin
    if (ents.length) {
      const arch = derivedList('archive', e => e.isRetentionEnabled || e.isArchivalEnabled);
      if (arch.length) {
        const r = tableRows(arch, 'archive');
        if (!searching || r.items.length) { add('archive', r.items.length ? r.items : [info('g:archive/empty', 'No tables to show.')], r.items.length); if (r.items.length) anyMatch = true; }
      }
      // the group shows once meta.recycleBin() has answered (03 §6: only when it is non-empty), or with its error
      if (bin.status === 'error' && !searching) add('bin', [errorNode('g:bin/err', `Couldn’t load the recycle bin tables: ${errText(bin.error)}`, () => loadBin(true))], null);
      else if (bin.status === 'done' && bin.set && bin.set.size) {
        const list = derivedList('bin', e => bin.set.has(e.logicalName), bin.set);
        const r = tableRows(list, 'bin');
        if (!searching || r.items.length) { add('bin', r.items.length ? r.items : [info('g:bin/empty', 'No tables to show.')], r.items.length); if (r.items.length) anyMatch = true; }
      }
    }
    // Temporary tables: always shown (03 §6), also during a search, where a group without a matching #temp table
    // starts collapsed (expanding it says so, and its Load CSV / Load file actions stay)
    const all = tempList();
    const temps = searching ? all.filter(t => nameMatch(query, t.name)) : all;
    const tempRows = temps.map(t => node('tmp:' + lower(t.name), 'temp', { temp: t, name: t.name, rowsN: Array.isArray(t.rows) ? t.rows.length : 0, cols: t.columns ?? EMPTY, q }));
    const noTemp = !all.length ? info('g:temps/empty', TEXT.noTemps, [{ label: TEXT.loadCsv, run: () => runCommand('loadCsv') }])
      : info('g:temps/none', `No #temp tables match “${query.trim()}”`);
    const tempsGroup = add('temps', tempRows.length ? tempRows : [noTemp], temps.length, { searchClosed: searching && !temps.length });
    if (temps.length) anyMatch = true;
    // Functions and Actions: built on first expand (meta.messages(), which may read $metadata)
    if (!searching && msgs.status === 'idle' && (expanded.has('g:functions') || expanded.has('g:actions'))) loadMessages(false, true);
    for (const kind of ['function', 'action']) {
      const id = kind === 'function' ? 'functions' : 'actions';
      if ((msgs.status === 'done' || msgs.status === 'partial') && msgs.map) {
        const items = msgItems(msgs.map, kind);
        if (searching && !items.length) continue;
        if (items.length && searching) anyMatch = true;
        const warn = msgs.error && !searching ? [errorNode(`g:${id}/warn`, `Some Web API messages could not be loaded: ${errText(msgs.error)}`, () => loadMessages(true), 'warn')] : [];
        const more = msgs.status === 'partial' && !searching ? [info(`g:${id}/more`, TEXT.moreMessages, [], { tone: 'loading' })] : [];
        const none = items.length || more.length ? [] : [info(`g:${id}/empty`, kind === 'function' ? 'No functions.' : 'No actions.')];
        add(id, [...warn, ...items, ...none, ...more], items.length, { busy: msgs.status === 'partial' });
      } else if (!searching) {
        const items = msgs.status === 'loading' ? skeleton('g:' + id, SK_CHILD)
          : msgs.status === 'error' ? [errorNode(`g:${id}/err`, `Couldn’t load the Web API messages: ${errText(msgs.error)}`, () => loadMessages(true))] : [];
        add(id, items, null, { lazy: msgs.status === 'idle', busy: msgs.status === 'loading' });
      }
    }
    // Built-in functions
    if (searching) {
      const cats = (builtins ?? (builtins = builtinCategories())).map(([cat, docs]) => {
        const hits = docs.filter(d => nameMatch(query, d.name));
        if (!hits.length) return null;
        const c = node('bc:' + cat, 'category', { label: cat, count: hits.length });
        c.items = hits.map(d => node(`bf:${cat}:${d.name}`, 'builtin', { doc: d, q }));
        return c;
      }).filter(Boolean);
      if (cats.length) { add('builtins', cats, cats.reduce((s, c) => s + c.count, 0)); anyMatch = true; }
    } else {
      if (!builtins && expanded.has('g:builtins')) builtins = builtinCategories();
      const cats = builtins ? builtins.map(([cat, docs]) => {
        const c = node('bc:' + cat, 'category', { label: cat, count: docs.length });
        c.items = docs.map(d => node(`bf:${cat}:${d.name}`, 'builtin', { doc: d, q: '' }));
        return c;
      }) : [];
      add('builtins', cats, builtins ? builtins.reduce((s, [, d]) => s + d.length, 0) : null, { lazy: !builtins });
    }
    if (searching && !anyMatch) {
      const r = tablesNoMatch ?? { hiddenPrivate: 0, hiddenType: 0 };
      return [node('nomatch', 'state', { variant: 'nomatch', title: noMatchLine(query), text: '', links: noTablesLinks(r), span: STATE_SPAN, q: query }), tempsGroup];
    }
    return out;
  }

  // The message rows of a group, by name (kept while the Map and the query stay the same).
  const msgMemo = new Map();          // kind -> {map, q, items}
  function msgItems(map, kind) {
    const q = query.trim();
    const m = msgMemo.get(kind);
    if (m && m.map === map && m.q === q) return m.items;
    const list = [...map.values()].filter(x => x && x.kind === kind && typeof x.name === 'string' && (!q || nameMatch(q, x.name)))
      .sort((a, b) => byText(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const items = list.map(x => node(`msg:${kind[0]}:${lower(x.name)}:${x.boundTo ?? ''}`, 'msg', { msg: x, q }));
    msgMemo.set(kind, { map, q, items });
    return items;
  }

  const shiftMatch = (m, by) => (m ? { ...m, ranges: m.ranges.map(([a, b]) => [a + by, b + by]) } : null);
  const noMatchLine = q => `No tables match “${String(q ?? '').trim()}”`;
  const errText = e => String(e?.message ?? e ?? 'unknown error');
  function errorNode(id, text, retry, tone = 'error') {
    return node(id, 'error', { text, tone, links: retry ? [{ label: TEXT.tryAgain, run: retry }] : [], title: text });
  }

  // The children of a node (lazy loads start here: 03 §6 'built on first expand').
  function kidsOf(n) {
    switch (n.kind) {
      case 'group': return n.items ?? [];
      case 'category': return n.items ?? [];
      case 'table': {
        const name = n.e.logicalName;
        ensure('e', name);
        if (!n.schema) { ensure('r', name); ensure('k', name); }
        const cols = folderNode(n, 'cols', 'Columns', 'e');
        return n.schema ? [cols] : [cols, folderNode(n, 'rels', 'Relationships', 'r'), folderNode(n, 'keys', 'Keys', 'k')];
      }
      case 'folder': return folderKids(n);
      case 'meta': return n.table.columns.map(c => node(`${n.id}/c:${c.name}`, 'metaCol', { col: c, table: n.table.name }));
      case 'sys': return n.obj.columns.map(([name, type]) => node(`${n.id}/c:${name}`, 'sysCol', { name, type, obj: n.obj }));
      case 'temp': return (n.cols ?? []).map((c, i) => node(`${n.id}/c:${i}:${lower(c.name)}`, 'tempCol', { col: c, temp: n.name }));
      default: return [];
    }
  }

  function folderNode(t, part, label, kind) {
    const l = loads.get(`${kind}:${t.e.logicalName}`);
    let count = null;
    if (l?.status === 'done') count = part === 'cols' ? columnsOf(l.value).length : part === 'rels' ? relsOf(l.value, t.e.logicalName).length : (l.value ?? []).length;
    return node(`${t.id}/${part}`, 'folder', { part, label, table: t, loadKind: kind, count, status: l?.status ?? 'loading' });
  }

  // A loaded table's column rows and relationship rows, made once per metadata object.
  const colCache = new WeakMap(), relCache = new WeakMap();
  function columnsOf(info) {
    if (!info) return [];
    let c = colCache.get(info);
    if (!c) { c = tableColumns(info, 'any'); colCache.set(info, c); }
    return c;
  }
  function relsOf(rels, table) {
    if (!rels || typeof rels !== 'object') return [];
    let c = relCache.get(rels);
    if (!c) { c = relationshipItems(rels, table); relCache.set(rels, c); }
    return c;
  }

  function folderKids(f) {
    const t = f.table, name = t.e.logicalName;
    const l = loads.get(`${f.loadKind}:${name}`) ?? ensure(f.loadKind, name);
    if (l.status === 'loading') return skeleton(f.id, SK_CHILD);
    if (l.status === 'error') {
      const what = f.part === 'cols' ? 'columns' : f.part === 'rels' ? 'relationships' : 'keys';
      return [errorNode(`${f.id}/err`, `Couldn’t load the ${what}: ${errText(l.error)}`, () => { loads.delete(`${f.loadKind}:${name}`); ensure(f.loadKind, name); changed(); })];
    }
    if (f.part === 'cols') {
      const cols = columnsOf(l.value);
      return cols.length ? cols.map(c => node(`${t.id}/c:${c.name}`, 'column', { col: c, table: name, schema: t.schema })) : [info(`${f.id}/none`, 'No columns.')];
    }
    if (f.part === 'rels') {
      const list = relsOf(l.value, name);
      return list.length ? list.map(r => node(`${t.id}/r:${r.id}`, 'rel', { rel: r, table: name })) : [info(`${f.id}/none`, 'No relationships.')];
    }
    const keys = Array.isArray(l.value) ? l.value : [];
    return keys.length ? keys.map(k => node(`${t.id}/k:${k.logicalName}`, 'key', { key: k, table: name })) : [info(`${f.id}/none`, 'No alternate keys.')];
  }

  // ---- loads
  function ensure(kind, name) {
    const key = `${kind}:${name}`;
    let l = loads.get(key);
    if (l) return l;
    l = { status: 'loading', error: null, value: null };
    loads.set(key, l);
    const gen = generation;
    let p;
    try {
      p = kind === 'e' ? meta.entity(name) : kind === 'r' ? meta.relationships(name) : meta.keys(name);
    } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(v => {
      if (gen !== generation || loads.get(key) !== l) return;
      l.status = 'done'; l.value = v ?? null; changed();
    }, err => {
      if (gen !== generation || loads.get(key) !== l) return;
      l.status = 'error'; l.error = err; changed();
    });
    return l;
  }
  async function entityLoaded(name) {
    const l = ensure('e', name);
    if (l.status === 'done') return l.value;
    if (l.status === 'error') { loads.delete(`e:${name}`); }
    return meta.entity(name);
  }

  // Reads the Web API messages for the Functions and Actions groups (03 §6); `quiet`: called while building
  // the tree. The full form (meta.messages(), which reads $metadata) fills the groups; the short form
  // (messages({csdl: false}): BUILTIN_MESSAGES and the custom APIs, no $metadata) usually answers first, so its rows
  // show at once ('partial', with a loading row) until the full Map replaces them. A full Map that meta already holds
  // (messagesSync) is used without a request.
  let msgsToken = null;
  function loadMessages(force = false, quiet = false) {
    if (!meta || typeof meta.messages !== 'function') { msgs = { status: 'error', map: null, error: new Error('Web API messages are not available.') }; if (!quiet) changed(); return; }
    if (!force && msgs.status !== 'idle' && msgs.status !== 'error') return;
    const held = !force && typeof meta.messagesSync === 'function' ? safeCall(() => meta.messagesSync()) : null;
    if (held instanceof Map) { msgs = { status: 'done', map: held, error: held.incomplete?.error ?? null }; if (!quiet) changed(); return; }
    const token = msgsToken = {};
    const keep = msgs.status === 'done' || msgs.status === 'partial' ? msgs.map : null;   // Try again keeps the rows meanwhile
    msgs = keep ? { status: 'partial', map: keep, error: null } : { status: 'loading', map: null, error: null };
    const call = o => { try { return Promise.resolve(o ? meta.messages(o) : meta.messages()); } catch (e) { return Promise.reject(e); } };
    call(null).then(map => {
      if (msgsToken !== token) return;
      msgs = { status: 'done', map: map instanceof Map ? map : new Map(), error: map?.incomplete?.error ?? null };
      changed();
    }, err => {
      if (msgsToken !== token) return;
      // the rows of the short form stay, with the failure as a warning row
      msgs = msgs.map ? { status: 'done', map: msgs.map, error: err } : { status: 'error', map: null, error: err };
      changed();
    });
    if (!keep) {
      call({ csdl: false }).then(map => {
        if (msgsToken !== token || msgs.status !== 'loading' || !(map instanceof Map)) return;
        msgs = { status: 'partial', map, error: null };
        changed();
      }, () => { /* the full read reports the failure */ });
    }
    if (!quiet) changed();
  }
  function safeCall(fn) { try { return fn(); } catch { return null; } }

  function loadBin(force = false) {
    if (!meta || typeof meta.recycleBin !== 'function') return;
    if (!force && bin.status !== 'idle') return;
    const gen = generation;
    bin = { status: 'loading', set: null, error: null };
    let p;
    try { p = meta.recycleBin(); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(set => {
      if (gen !== generation) return;
      bin = { status: 'done', set: set instanceof Set ? set : new Set(), error: null };
      changed();
    }, err => {
      if (gen !== generation) return;
      bin = { status: 'error', set: null, error: err };
      changed();
    });
    changed();
  }

  function tempList() {
    const s = st().sessions?.get?.(st().activeTab);
    const temps = s?.temps;
    if (!(temps instanceof Map)) return [];
    return [...temps.values()].filter(t => t && typeof t.name === 'string').sort((a, b) => byText(a.name, b.name) || (a.name < b.name ? -1 : 1));
  }
  const activeSession = () => st().sessions?.get?.(st().activeTab) ?? null;

  // ---- rebuild and paint (coalesced)
  let rebuildQueued = false, paintQueued = false, epoch = 0;
  function changed() { queueRebuild(); }
  function queueRebuild() {
    if (destroyed || rebuildQueued) return;
    rebuildQueued = true;
    const run = () => { rebuildQueued = false; if (!destroyed) rebuild(); };
    if (frame) frame(run); else queueMicrotask(run);
  }
  function rebuild() {
    rebuildQueued = false;
    const focusedHere = rowHasFocus();
    model = flattenTree(rootsOf(), { children: kidsOf, expanded: isExpanded });
    if (!active || model.nodes[active.idx] !== active || active.hidden) active = pickActive(active);
    rows.setAttribute('aria-busy', listState === 'loading' && !entities().length ? 'true' : 'false');
    paint();
    if (focusedHere) focusActive(false);
  }
  function queuePaint() {
    if (destroyed || paintQueued) return;
    paintQueued = true;
    const run = () => { paintQueued = false; if (!destroyed) paint(); };
    if (frame) frame(run); else run();
  }
  // A new active node after the old one left the tree (WAI-ARIA tree: focus stays in place): its nearest ancestor
  // still shown (the parent recorded when it was last flattened: a column's folder, a #temp table's group), else the
  // first focusable row.
  function pickActive(old) {
    for (let p = old?.parent; p; p = p.parent) if (model.nodes[p.idx] === p && !p.hidden) return p;
    return model.nodes.find(n => !n.hidden) ?? null;
  }

  let rendered = new Map();   // node -> row element
  function viewHeight() { return scroller.clientHeight || opts.viewHeight || 560; }
  function paint() {
    if (destroyed) return;
    const viewH = viewHeight();
    const w = virtualWindow({ scrollTop: scroller.scrollTop || 0, viewH, slots: model.slots });
    rows.style.height = w.spacer + 'px';
    const want = [];
    if (model.nodes.length) {
      const a = indexAtSlot(model.starts, w.firstSlot), b = indexAtSlot(model.starts, Math.max(w.firstSlot, w.lastSlot - 1));
      for (let i = a; i <= b; i++) want.push(i);
      const ai = active && model.nodes[active.idx] === active ? active.idx : -1;
      if (ai >= 0 && (ai < a || ai > b)) { want.push(ai); want.sort((x, y) => x - y); }
    }
    const next = new Map();
    let k = 0;
    for (const i of want) {
      const n = model.nodes[i];
      let el = rendered.get(n);
      if (el) rendered.delete(n); else el = makeRow(n);
      syncRow(el, n, i, w);
      next.set(n, el);
      const at = rows.childNodes[k];
      if (at !== el) rows.insertBefore(el, at ?? null);
      k++;
    }
    for (const [n, el] of rendered) { if (hov.node === n) closeCard(); bindTip(el, null); if (pointerRow === el) pointerRow = null; el.remove(); }
    rendered = next;
  }

  function makeRow(n) {
    if (n.kind === 'sk') return h('div', { class: 'ex-sk', 'aria-hidden': 'true', role: 'none' }, h('i'), h('i', { style: `width:${n.w}%` }));
    const el = h('div', { class: n.kind === 'state' ? 'ex-st' : 'ex-row', role: 'treeitem', tabindex: '-1' });
    el._node = n;
    return el;
  }

  function syncRow(el, n, i, w) {
    const slot = model.starts[i];
    const top = slot * ROW_H - w.shift;
    setStyle(el, 'top', top + 'px');
    setStyle(el, '--ex-lv', String(Math.max(0, n.level - 1)));
    if ((n.span || 1) > 1) setStyle(el, 'height', (n.span * ROW_H) + 'px');
    if (n.kind === 'sk') return;
    el._node = n;
    if (el._v !== n.v || el._e !== epoch) { fill(el, n); el._v = n.v; el._e = epoch; }
    setAttr(el, 'aria-level', String(n.level));
    setAttr(el, 'aria-setsize', String(n.size));
    setAttr(el, 'aria-posinset', String(n.pos));
    if (expandable(n)) setAttr(el, 'aria-expanded', isExpanded(n) ? 'true' : 'false'); else if (el.hasAttribute('aria-expanded')) el.removeAttribute('aria-expanded');
    const on = n === active;
    setAttr(el, 'tabindex', on ? '0' : '-1');
    if (el.classList.contains('on') !== on) el.classList.toggle('on', on);
    const busy = (n.kind === 'folder' && n.status === 'loading' && isExpanded(n)) || (n.kind === 'group' && n.busy);
    setAttr(el, 'aria-busy', busy ? 'true' : 'false');
  }
  const setAttr = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
  const setStyle = (el, k, v) => { if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); };

  // ---- row content
  const put = (el, ...kids) => append(el, kids);   // dom.js append: null and false children are skipped
  const chev = n => h('span', { class: 'ex-cv', 'aria-hidden': 'true' }, expandable(n) ? icon('chevron', 12) : null);
  const ic = (name, size = 16) => h('span', { class: 'ex-ic', 'aria-hidden': 'true' }, icon(name, size));
  const nm = (text, ranges, extra = '') => h('span', { class: 'ex-nm' + extra }, marked(text, ranges));
  const sub = (text, ranges, extra = '') => (text ? h('span', { class: 'ex-sub' + extra }, marked(text, ranges)) : null);
  const end = text => (text != null && text !== '' ? h('span', { class: 'ex-end' }, String(text)) : null);
  const tag = text => h('span', { class: 'tag' }, text);
  function linkBtn(l) {
    return h('button', { class: 'link', type: 'button', tabindex: '-1', 'data-link': '1', onclick: ev => { ev.stopPropagation(); runSafe(l.run); } }, l.label);
  }
  // A row's hover action: pointer-only (tabindex -1 in the aria-hidden .ex-acts span). `stateOf()` gives {disabled,
  // title}; it is read again when the pointer enters the row, when the row takes focus and on click, because
  // state.running also covers runs that send no run:start / run:end (03 §7: runQuiet, attachQuiet, Undo, Review
  // changes). A mousedown leaves focus where it is (never inside the aria-hidden span); the click makes the row the
  // active one, as a click on the row does, and then runs the action.
  function actBtn(name, label, stateOf, run) {
    const b = h('button', { class: 'btn subtle icon ex-act', type: 'button', tabindex: '-1', 'aria-label': label }, icon(name, 16));
    b._label = label;
    b._state = stateOf;
    syncAct(b);
    b.addEventListener('mousedown', ev => ev.preventDefault());
    b.addEventListener('click', ev => {
      ev.stopPropagation();
      const s = syncAct(b);
      const r = rowEl(b);
      if (r && r._node) { closeCard(); setActive(r._node, true); }
      if (!s.disabled) runSafe(run);
    });
    b.addEventListener('dblclick', ev => ev.stopPropagation());
    return b;
  }
  function syncAct(b) {
    let s;
    try { s = b._state() ?? { disabled: false, title: null }; } catch { s = { disabled: true, title: null }; }
    setAttr(b, 'title', s.disabled && s.title ? s.title : b._label);
    if (s.disabled) setAttr(b, 'aria-disabled', 'true'); else if (b.hasAttribute('aria-disabled')) b.removeAttribute('aria-disabled');
    return s;
  }
  function syncActs(el) { for (const b of el?.querySelectorAll?.('.ex-act') ?? []) syncAct(b); }
  // The keyboard tooltip of a row (03 §1.4 shell.tooltip: shown on :focus-visible focus; 03 §6 'not readable (dimmed
  // + tooltip)', a refused action): the pointer gets the hover card instead, so it is empty while the pointer is on
  // the row. Bound once per element and text; unbound when the row leaves the DOM.
  let pointerRow = null;
  function bindTip(el, text) {
    if ((el._tipText ?? null) === (text ?? null)) return;
    if (el._tipOff) { try { el._tipOff(); } catch { /* already unbound */ } el._tipOff = null; }
    el._tipText = text ?? null;
    if (!text || typeof shell?.tooltip !== 'function') return;
    try { el._tipOff = shell.tooltip(el, () => (pointerRow === el ? '' : text)); } catch { el._tipOff = null; }
  }
  // The keyboard tooltip text of a node, or null.
  function tipOf(n) {
    if (n.kind === 'column' && columnFlags(n.col).notReadable) return TEXT.notReadable;
    if (n.kind === 'msg' && isRefusedExec(n.msg)) return refusedText(n.msg.name);
    return null;
  }

  function fill(el, n) {
    clear(el);
    el.className = n.kind === 'state' ? 'ex-st' : 'ex-row';
    el.removeAttribute('title');
    el.removeAttribute('aria-label');
    if (INSERTS.has(n.kind)) el.setAttribute('draggable', 'true'); else el.removeAttribute('draggable');
    switch (n.kind) {
      case 'group': {
        el.classList.add('ex-grp');
        put(el, chev(n), ic(n.ic), nm(n.label), end(n.count == null ? '' : fmtInt(n.count)));
        if (n.group === 'temps') {
          put(el, h('span', { class: 'ex-acts', 'aria-hidden': 'true' }, actBtn('csv', TEXT.loadCsv, () => commandState('loadCsv'), () => runCommand('loadCsv')),
            actBtn('text', TEXT.loadFile, () => commandState('loadFileAsText'), () => runCommand('loadFileAsText'))));
        }
        break;
      }
      case 'table': {
        // the bold ranges of the search, made only for the rows painted
        const e = n.e, m = n.q ? tableMatch(n.q, e, n.schema) : null;
        const shown = (n.schema ? n.schema + '.' : '') + e.logicalName;
        put(el, chev(n), ic(tableIcon(e)), nm(e.displayName || shown, e.displayName ? m?.display : m?.name));
        if (e.displayName) put(el, sub(shown, m?.name));
        for (const t of tableTags(e)) put(el, tag(t));
        const c = counts.get(countKey(n));
        if (c) put(el, tag(countText(c.n, c.approx)));
        put(el, h('span', { class: 'ex-acts', 'aria-hidden': 'true' }, actBtn('play', 'Select top 100', () => runState(), () => selectTop(n)), actBtn('number', 'Count rows', () => runState(true), () => countRows(n))));
        break;
      }
      case 'folder':
        put(el, chev(n), ic('folder'), nm(n.label), end(n.count != null ? fmtInt(n.count) : n.status === 'loading' ? '…' : ''));
        break;
      case 'column': {
        // the flags are in the row's accessible name too: the key glyph is an image named
        // 'Primary key', the bold primary name and the dimmed not-readable column say so in visually hidden text
        const c = n.col, f = columnFlags(c);
        if (f.primaryName) el.classList.add('ex-pn');
        if (f.notReadable) el.classList.add('dim');
        const glyph = f.pk ? h('span', { class: 'ex-ic', role: 'img', 'aria-label': TEXT.primaryKey }, icon(columnIcon(c), 16)) : ic(columnIcon(c));
        put(el, chev(n), glyph, nm(c.name));
        if (f.primaryName) put(el, h('span', { class: 'sr' }, `, ${TEXT.primaryName}`));
        if (f.notReadable) put(el, h('span', { class: 'sr' }, `, ${TEXT.notReadableTag}`));
        if (f.required) put(el, h('span', { class: 'ex-req', role: 'img', 'aria-label': 'Required', title: 'Required' }));
        const disp = c.attr && !c.virtual ? c.attr.displayName : c.virtual && c.base ? `${c.base.displayName || c.base.logicalName} (${c.virtual})` : '';
        put(el, sub(disp));
        if (f.custom) put(el, tag('Custom'));
        if (f.computed) put(el, tag(f.computed));
        put(el, end(columnType(c)));
        break;
      }
      case 'rel':
        put(el, chev(n), ic(n.rel.kind === 'nn' ? 'link' : 'relation'), nm(n.rel.label), sub(n.rel.sub));
        break;
      case 'key':
        put(el, chev(n), ic('key'), nm(n.key.logicalName || n.key.schemaName), sub((n.key.attrs ?? []).join(', ')));
        break;
      case 'meta': {
        const m = n.q ? nameMatch(n.q, 'metadata.' + n.table.name) ?? shiftMatch(nameMatch(n.q, n.table.name), 9) : null;
        put(el, chev(n), ic('db'), nm('metadata.' + n.table.name, m?.ranges, ' ex-mono'));
        break;
      }
      case 'metaCol':
        put(el, chev(n), ic(metaIcon(n.col.dt)), nm(n.col.name), end(META_TYPE[n.col.dt] ?? n.col.dt));
        break;
      case 'sys': {
        const m = n.q ? nameMatch(n.q, n.obj.label) ?? shiftMatch(nameMatch(n.q, n.obj.name), 4) : null;
        put(el, chev(n), ic(n.obj.kind === 'tvf' ? 'fx' : 'list'), nm(n.obj.label, m?.ranges, ' ex-mono'));
        break;
      }
      case 'sysCol':
        put(el, chev(n), ic(sqlTypeIcon(n.type)), nm(n.name), end(n.type));
        break;
      case 'temp':
        put(el, chev(n), ic('table'), nm(n.name, n.q ? nameMatch(n.q, n.name)?.ranges : null), tag(`${fmtInt(n.rowsN)} ${n.rowsN === 1 ? 'row' : 'rows'}`));
        break;
      case 'tempCol': {
        const t = safeTypeName(n.col);
        put(el, chev(n), ic(sqlTypeIcon(t)), nm(String(n.col.name ?? '')), end(t));
        break;
      }
      case 'msg': {
        const m = n.msg;
        // a name that is a reserved word shows bracketed ([Merge]): its bold ranges move by the bracket
        const shown = sqlName(m.name);
        put(el, chev(n), ic(m.kind === 'action' ? 'bolt' : 'fx'), nm(shown, shiftMatch(n.q ? nameMatch(n.q, m.name) : null, shown === m.name ? 0 : 1)?.ranges), sub(m.boundTo ?? ''));
        if (m.isCustom) put(el, tag('Custom API'));
        // EXEC refuses it (02 §8.1): dimmed and tagged, as completion marks it; the explanation is the keyboard
        // tooltip, the hover card's note and the disabled Script as EXEC's title
        if (isRefusedExec(m)) { el.classList.add('dim'); put(el, tag(TEXT.refused)); }
        break;
      }
      case 'category':
        el.classList.add('ex-grp');
        put(el, chev(n), ic('list'), nm(n.label), end(fmtInt(n.count)));
        break;
      case 'builtin':
        put(el, chev(n), ic('fx'), nm(n.doc.name, n.q ? nameMatch(n.q, n.doc.name)?.ranges : null, ' ex-mono'), sub(n.doc.display.replace(/\.\.\./g, '…'), null, ' ex-mono'));
        break;
      case 'info': case 'error': {
        if (n.kind === 'error') el.classList.add(n.tone === 'warn' ? 'ex-warn' : 'ex-err');
        const glyph = n.tone === 'loading' ? h('span', { class: 'ex-ic', 'aria-hidden': 'true' }, h('span', { class: 'spin' }))
          : ic(n.kind === 'error' ? (n.tone === 'warn' ? 'warn' : 'error') : 'info');
        put(el, chev(n), glyph, h('span', { class: 'ex-msg' }, n.text));
        for (const l of n.links ?? []) put(el, linkBtn(l));
        if (n.title) el.setAttribute('title', n.title);
        break;
      }
      case 'state': {
        const failed = n.variant === 'failed';
        const acts = failed ? [{ label: TEXT.tryAgain, run: retryList }] : n.links ?? [];
        el.setAttribute('aria-label', [n.title, n.text].filter(Boolean).join('. '));
        put(el, h('span', { class: failed ? 'ic bad' : 'ic', 'aria-hidden': 'true' }, icon(failed ? 'error' : 'search', 20)),
          h('span', { class: 'ex-stt' }, failed ? h('b', null, n.title) : h('b', null, 'No tables match “', h('bdi', null, query.trim()), '”'),
            n.text ? h('span', { class: 'ex-msg', title: n.text }, n.text) : null,
            acts.length ? h('span', { class: 'acts' }, acts.map(a => (failed ? h('button', { class: 'btn primary', type: 'button', tabindex: '-1', onclick: ev => { ev.stopPropagation(); runSafe(a.run); } }, icon('refresh', 20), h('span', { class: 'lbl' }, a.label)) : linkBtn(a)))) : null));
        el._acts = acts;
        break;
      }
      default: break;
    }
    bindTip(el, tipOf(n));
  }
  const metaIcon = dt => ({ string: 'text', guid: 'guid', bit: 'bool', int: 'number', float: 'number', datetime: 'calendar' }[dt] ?? 'column');
  function sqlTypeIcon(t) {
    const s = lower(t);
    if (/char|text|xml|sysname/.test(s)) return 'text';
    if (/^(tiny|small|big)?int|decimal|numeric|float|real/.test(s)) return 'number';
    if (/money/.test(s)) return 'money';
    if (/date|time/.test(s)) return 'calendar';
    if (s === 'bit') return 'bool';
    if (s === 'uniqueidentifier' || s === 'entityreference') return 'guid';
    if (/binary|image/.test(s)) return 'file';
    return 'column';
  }
  function safeTypeName(c) { try { return typeName(c); } catch { return ''; } }

  // ---- texts a node inserts (03 §6) and its label (type-ahead)
  function insertText(n) {
    switch (n.kind) {
      case 'table': return tableRef(n.e.logicalName, n.schema);
      case 'column': return sqlName(n.col.name);
      case 'rel': return relJoin(n);
      case 'key': return (n.key.attrs ?? []).map(a => sqlName(a)).join(', ');
      case 'meta': return 'metadata.' + sqlName(n.table.name);
      case 'metaCol': return sqlName(n.col.name);
      case 'sys': return n.obj.sql;
      case 'sysCol': return sqlName(n.name);
      case 'temp': return nameSql(n.name);
      case 'tempCol': return sqlName(String(n.col.name ?? ''));
      case 'msg': return sqlName(n.msg.name);
      case 'builtin': return builtinInsert(n.doc);
      default: return '';
    }
  }
  // The row's label as shown (the model hook's `label`).
  function labelOf(n) {
    switch (n.kind) {
      case 'group': case 'folder': case 'category': return n.label;
      case 'table': return n.e.displayName || n.e.logicalName;
      case 'column': return n.col.name;
      case 'rel': return n.rel.label;
      case 'key': return n.key.logicalName || n.key.schemaName;
      case 'meta': return n.table.name;
      case 'metaCol': return n.col.name;
      case 'sys': return n.obj.name;
      case 'sysCol': return n.name;
      case 'temp': return n.name;
      case 'tempCol': return String(n.col.name ?? '');
      case 'msg': return n.msg.name;
      case 'builtin': return n.doc.name;
      case 'info': case 'error': return n.text;
      case 'state': return n.title;
      default: return null;
    }
  }
  // The text type-ahead matches (WAI-ARIA tree): the label without the relationship kind and the #s of a temp
  // table, so typing a column or table name finds its row; null for a row that cannot take focus.
  function typeLabel(n) {
    if (n.hidden) return null;
    if (n.kind === 'rel') return n.rel.label.replace(/^(N:1|1:N|N:N) /, '');
    if (n.kind === 'temp') return n.name.replace(/^#+/, '');
    return labelOf(n);
  }
  // The JOIN of a relationship row for the editor's statement at the caret.
  function relJoin(n) {
    let text = null, caret = null;
    try {
      if (editor && typeof editor.getValue === 'function') {
        text = String(editor.getValue() ?? '');
        caret = editor.getSelection?.()?.start ?? text.length;
      }
    } catch { text = null; }
    return relJoinAt(n, text, caret);
  }
  // The JOIN of a relationship row for the statement at `caret` of `text` (complete.js analyze; the tab's
  // QUOTED_IDENTIFIER mode), or its self-contained form `<table> <t> INNER JOIN …` without a text.
  function relJoinAt(n, text, caret) {
    let scope = [];
    if (text != null) {
      try {
        const qi = activeSession()?.opts?.quotedIdentifier;
        scope = analyze(text, Math.max(0, Math.min(text.length, caret ?? text.length)), { quotedIdentifier: qi !== false }).scope ?? [];
      } catch { scope = []; }
    }
    return joinSql(n.rel, n.table, { scope, find });
  }
  // The text a dragged row carries as text/plain: its insert text, a relationship's self-contained JOIN (the drop
  // point is not known yet; a drop into the editor's text gets the JOIN for its own statement, onEditorDrop).
  const dragText = n => (n.kind === 'rel' ? relJoinAt(n, null, null) : insertText(n));

  // ---- actions
  function runSafe(fn) {
    try { const r = fn(); if (r && typeof r.then === 'function') r.then(null, fail); } catch (e) { fail(e); }
  }
  // Inserts at the caret (replacing the selection) with spacedInsert's spaces, and focuses the editor.
  function insert(text) {
    if (!text) return;
    if (typeof editor?.insert !== 'function') { toast(TEXT.noEditor, { kind: 'warn' }); return; }
    let t = text;
    try {
      const all = typeof editor.getValue === 'function' ? String(editor.getValue() ?? '') : '';
      const sel = typeof editor.getSelection === 'function' ? editor.getSelection() : null;
      if (sel && Number.isInteger(sel.start) && Number.isInteger(sel.end)) t = spacedInsert(text, all[sel.start - 1] ?? '', all[sel.end] ?? '');
    } catch { t = text; }
    editor.insert(t);
    editor.focus?.();
  }
  function activate(n) {
    if (!n) return;
    switch (n.kind) {
      case 'group': case 'folder': case 'category': toggle(n); return;
      case 'info': case 'error': if (n.links?.[0]) runSafe(n.links[0].run); return;
      case 'state': { const a = n.variant === 'failed' ? retryList : n.links?.[0]?.run; if (a) runSafe(a); return; }
      case 'sk': return;
      default: insert(insertText(n));
    }
  }
  function commandState(id) {
    const lock = runLock();
    if (lock) return { disabled: true, title: lock };
    return { disabled: !shell?.exec, title: shell?.exec ? null : 'Not available.' };
  }
  function runCommand(id) {
    if (!shell?.exec) return false;
    const lock = runLock();
    if (lock) { lockToast(lock); return false; }
    return shell.exec(id);
  }
  const countKey = n => (n.schema ? `${n.schema}.${n.e.logicalName}` : n.e.logicalName);

  // The run-lock toast (00 §3, 03 §7): 'A query is already running in “<tab>”.' with Go to tab.
  function lockToast(text) {
    const id = st().running?.tabId;
    const action = id != null && typeof S?.setActiveTab === 'function'
      ? { label: TEXT.goToTab, run: () => { if (!S.getTab || S.getTab(id)) S.setActiveTab(id); } } : null;
    toast(text, { kind: 'warn', action });
  }
  function guardRun(quiet = false) {
    const s = runState(quiet);
    if (!s.disabled) return true;
    if (runLock() === s.title) lockToast(s.title); else toast(s.title, { kind: 'warn' });
    return false;
  }
  // Puts `sql` into the active tab when the editor's text is blank, else into a new tab, and runs it (03 §6).
  function openAndRun(sql, title) {
    if (!guardRun()) return null;
    const cur = st().activeTab != null ? S.getTab?.(st().activeTab) : null;
    let tabId;
    if (cur && editor && typeof editor.getValue === 'function' && !String(editor.getValue() ?? '').trim()) {
      editor.setValue(sql);
      editor.select?.(sql.length, sql.length, { reveal: true });
      tabId = cur.id;
    } else {
      tabId = S.createTab({ title, sql, caret: [sql.length, sql.length] }).id;
      showInEditor(tabId, sql, [sql.length, sql.length]);
    }
    editor?.focus?.();
    return Promise.resolve(results.runTab(tabId, 'all')).catch(fail);
  }
  // Makes sure the editor shows a tab just created (main.js loads the active tab on tab:changed; when that is not
  // synchronous the text is put in without an undo step, as the tab switch would).
  function showInEditor(tabId, sql, caret) {
    if (!editor || typeof editor.getValue !== 'function' || st().activeTab !== tabId) return;
    if (editor.getValue() !== sql) editor.setValue?.(sql, { undo: false });
    editor.select?.(caret[0], caret[1], { reveal: true });
  }
  // A script in a new tab that does not run (03 §6).
  function openScript(title, script) {
    if (!S?.createTab) return;
    const tab = S.createTab({ title, sql: script.sql, caret: script.caret });
    showInEditor(tab.id, script.sql, script.caret);
    editor?.focus?.();
    announce(`Opened ${title} in a new tab. It has not run.`);
  }
  // Adds `sql` to the active tab as 'Query it' does (03 §6, §8.4) and runs it as the selection when `run`.
  function addToActive(sql, run) {
    if (run && !guardRun()) return null;
    if (!editor || typeof editor.getValue !== 'function') { toast(TEXT.noEditor, { kind: 'warn' }); return null; }
    const text = String(editor.getValue() ?? '');
    const r = dialogsModule.appendQuery(text, sql);
    if (r.start === 0) editor.setValue(r.text);
    else editor.insert(r.text.slice(text.length), { at: text.length });
    if (r.start === 0) editor.select?.(r.end, r.end, { reveal: true }); else editor.select?.(r.start, r.end, { reveal: true });
    editor.focus?.();
    if (!run) return null;
    return Promise.resolve(results.runTab(st().activeTab, r.start === 0 ? 'all' : 'selection')).catch(fail);
  }

  function selectTop(n) {
    if (n.kind === 'table') return openAndRun(selectTopSql(tableRef(n.e.logicalName, n.schema)), countKey(n));
    if (n.kind === 'meta') return openAndRun(selectTopSql('metadata.' + sqlName(n.table.name)), 'metadata.' + n.table.name);
    if (n.kind === 'sys') return openAndRun(selectTopSql(n.obj.sql), n.obj.label);
    if (n.kind === 'temp') return addToActive(dialogsModule.queryItSql(n.name), true);
    return null;
  }
  async function selectAll(n) {
    if (!guardRun()) return;
    const info = await entityLoaded(n.e.logicalName);
    const names = scriptColumns(info, 'all').map(c => sqlName(c.name));
    openAndRun(selectColumnsSql(names, tableRef(n.e.logicalName, n.schema), { top: 100 }), countKey(n));
  }
  async function countRows(n) {
    if (!guardRun(true)) return;
    const e = n.e;
    const ref = tableRef(e.logicalName, n.schema);
    const sql = countSql(ref, { hint: !n.schema && e.kind === 'standard' });
    let r;
    try { r = await results.runQuiet(sql); } catch (err) { toast(`Count rows failed: ${errText(err)}`, { kind: 'error' }); return; }
    const set = r?.sets?.[0];
    const v = set?.rows?.[0]?.[0];
    const num = typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : v == null ? NaN : Number(v);
    if (!Number.isFinite(num)) {
      const er = (r?.messages ?? []).find(m => m && m.kind === 'error');
      toast(`Count rows failed: ${er ? er.text : 'the query returned no count.'}`, { kind: 'error' });
      return;
    }
    const approx = (set.warnings ?? []).some(w => w && w.kind === 'approx');
    counts.set(countKey(n), { n: num, approx });
    for (const p of Object.values(ID_PREFIX)) bump(nodes.get(p + e.logicalName));
    changed();
    const line = `${countKey(n)}: ${countText(num, approx)} ${num === 1 && !approx ? 'row' : 'rows'}`;
    toast(approx ? h('span', null, line, h('small', { class: 'ex-tl2' }, TEXT.approx)) : line, { kind: 'ok' });
    announce(approx ? `${line}. ${TEXT.approx}` : line);
  }
  async function scriptAs(n, op) {
    const info = await entityLoaded(n.e.logicalName);
    const s = scriptTable(op, info, { schema: n.schema });
    openScript(`${op.toUpperCase()} ${countKey(n)}`, s);
  }
  function runMetaQuery(sql, title) { return openAndRun(sql, title); }
  async function dropTemp(n) {
    if (!guardRun(true)) return;
    const ok = typeof shell?.confirm === 'function' ? await shell.confirm({
      title: `Drop ${n.name}?`,
      body: `The table and its ${fmtInt(n.rowsN)} ${n.rowsN === 1 ? 'row are' : 'rows are'} removed from this query tab's session. This cannot be undone.`,
      ok: 'Drop table', cancel: 'Cancel', danger: true,
    }) : true;
    if (!ok || !guardRun(true)) return;
    let r;
    try { r = await results.runQuiet(`DROP TABLE ${nameSql(n.name)}`); } catch (err) { toast(`Drop table failed: ${errText(err)}`, { kind: 'error' }); return; }
    const er = (r?.messages ?? []).find(m => m && m.kind === 'error');
    if (er) toast(`Drop table failed: ${er.text}`, { kind: 'error' });
    else announce(`Dropped ${n.name}.`);
    changed();
  }
  async function copy(text) {
    let ok = false;
    try { ok = await io().copyText(text); } catch { ok = false; }
    toast(ok ? `Copied ${quoteName(text)}.` : TEXT.copyFailed, { kind: ok ? 'ok' : 'error' });
  }
  function openLink(url) {
    try { io().openUrl(url); } catch (e) { fail(e); }
  }
  function dialogsFn(name) {
    const d = opts.dialogs;
    if (d && typeof d[name] === 'function') return (...a) => d[name](...a);
    return (...a) => dialogsModule[name](...a);
  }
  function loadCsvFiles(files) {
    try { dialogsFn('loadCsv')(files); } catch (e) {
      // dialogs.js not initialised: the shell command opens the picker instead
      if (!runCommand('loadCsv')) fail(e);
    }
  }

  // ---- context menus (03 §6)
  // The row's menu items with every run guarded: an action that throws or rejects (a table whose metadata cannot be
  // loaded, a failed copy) shows its message in an error toast, and run() resolves once the action has finished.
  function menuFor(n) {
    return guardItems(menuItems(n));
  }
  function guardItems(list) {
    return list.map(it => {
      if (!it || it === '-') return it;
      const out = { ...it };
      if (Array.isArray(it.items)) out.items = guardItems(it.items);
      if (typeof it.run === 'function') {
        const run = it.run;
        out.run = () => { try { return Promise.resolve(run()).then(() => undefined, fail); } catch (e) { fail(e); return Promise.resolve(); } };
      }
      return out;
    });
  }
  function menuItems(n) {
    const rs = runState(), qs = runState(true), is = insertState();
    const insItem = (label = 'Insert name') => ({ label, disabled: is.disabled, title: is.title, run: () => insert(insertText(n)) });
    switch (n.kind) {
      case 'group':
        if (n.group === 'temps') {
          const cs = commandState('loadCsv'), fs = commandState('loadFileAsText');
          return [{ label: TEXT.loadCsv, icon: 'csv', disabled: cs.disabled, title: cs.title, run: () => runCommand('loadCsv') },
            { label: TEXT.loadFile, icon: 'text', disabled: fs.disabled, title: fs.title, run: () => runCommand('loadFileAsText') }];
        }
        if (n.group === 'tables') return [{ label: 'Reload metadata', icon: 'refresh', disabled: refreshing, run: () => refreshMeta() }];
        return [{ label: isExpanded(n) ? 'Collapse' : 'Expand', run: () => toggle(n) }];
      case 'table': {
        const e = n.e, schema = n.schema;
        const scripts = schema === 'archive' ? ['select'] : schema === 'bin' ? ['select', 'delete'] : ['select', 'insert', 'update', 'delete'];
        const items = [
          { label: 'Select top 100', icon: 'play', disabled: rs.disabled, title: rs.title, run: () => selectTop(n) },
          { label: 'Select all columns', disabled: rs.disabled, title: rs.title, run: () => selectAll(n) },
          { label: 'Count rows', icon: 'number', disabled: qs.disabled, title: qs.title, run: () => countRows(n) },
          '-',
          { label: 'Script as', icon: 'code', items: scripts.map(op => ({ label: op.toUpperCase(), run: () => scriptAs(n, op) })) },
          insItem(),
          { label: 'Copy logical name', icon: 'copy', run: () => copy(e.logicalName) },
          { label: 'Copy entity set name', disabled: !e.entitySetName, title: e.entitySetName ? null : 'This table has no entity set.', run: () => copy(e.entitySetName) },
        ];
        if (!schema) {
          items.push('-', { label: 'Show columns', hint: 'metadata.attribute', disabled: rs.disabled, title: rs.title, run: () => runMetaQuery(showColumnsSql(e.logicalName), `${e.logicalName} columns`) },
            { label: 'Show relationships', hint: 'metadata.relationship_*', disabled: rs.disabled, title: rs.title, run: () => runMetaQuery(showRelationshipsSql(e.logicalName), `${e.logicalName} relationships`) });
          // the app-wide known-table check (main.js registers it after meta.init, 03 §11), as every record link;
          // an intersect table has no views or forms, so no list page
          const list = e.isIntersect ? null : util.listUrl(e.logicalName);
          const maker = util.makerUrl(st().env?.envId, e.metadataId);
          items.push('-', { label: 'Open list in this app', icon: 'open', hint: TEXT.newTab, disabled: !list, title: list ? null : TEXT.noList, run: () => openLink(list) });
          if (maker) items.push({ label: 'Open in maker portal', icon: 'open', hint: TEXT.newTab, run: () => openLink(maker) });
        }
        return items;
      }
      case 'column': return [insItem(), { label: 'Insert qualified name', disabled: is.disabled, title: is.title, run: () => insert(`${tableRef(n.table, n.schema)}.${sqlName(n.col.name)}`) }, { label: 'Copy logical name', icon: 'copy', run: () => copy(n.col.name) }];
      case 'rel': return [insItem('Insert JOIN'), { label: 'Copy schema name', icon: 'copy', run: () => copy(n.rel.schemaName) }];
      case 'key': return [insItem('Insert columns'), { label: 'Copy key name', icon: 'copy', run: () => copy(n.key.logicalName || n.key.schemaName) }];
      case 'meta': case 'sys':
        return [{ label: 'Select top 100', icon: 'play', disabled: rs.disabled, title: rs.title, run: () => selectTop(n) },
          { label: 'Script as SELECT', icon: 'code', run: () => openScript(`SELECT ${n.kind === 'meta' ? 'metadata.' + n.table.name : n.obj.label}`, objectSelect(n)) },
          insItem()];
      case 'temp':
        return [{ label: 'Select top 100', icon: 'play', disabled: rs.disabled, title: rs.title, run: () => selectTop(n) },
          { label: 'Script as SELECT', icon: 'code', disabled: is.disabled, title: is.title, run: () => addToActive(selectColumnsSql((n.cols ?? []).map(c => sqlName(String(c.name ?? ''))), nameSql(n.name)), false) },
          insItem(), '-',
          { label: 'Drop table', icon: 'trash', danger: true, disabled: qs.disabled, title: qs.title, run: () => dropTemp(n) }];
      case 'metaCol': case 'sysCol': case 'tempCol': return [insItem(), { label: 'Copy name', icon: 'copy', run: () => copy(n.kind === 'sysCol' ? n.name : String(n.col.name ?? '')) }];
      case 'msg': {
        const m = n.msg;
        // EXEC refuses some actions whatever their parameters (02 §8.1): their script, which could never run, is
        // disabled with the refusal as its title
        const no = isRefusedExec(m) ? refusedText(m.name) : null;
        const first = m.kind === 'action'
          ? { label: 'Script as EXEC', icon: 'code', disabled: !!no, title: no, run: () => (no ? toast(no, { kind: 'warn' }) : openScript(m.name, scriptActionExec(m, { find }))) }
          : { label: 'Script as SELECT', icon: 'code', run: () => openScript(m.name, scriptFunctionSelect(m, { find })) };
        return [first, insItem()];
      }
      case 'builtin':
        return [insItem('Insert'), { label: 'Open in Help', icon: 'help', run: () => { try { dialogsFn('openHelp')('functions', n.doc.name); } catch (e) { fail(e); } } }];
      case 'category': return [{ label: isExpanded(n) ? 'Collapse' : 'Expand', run: () => toggle(n) }];
      case 'info': case 'error': case 'state': {
        const links = n.kind === 'state' && n.variant === 'failed' ? [{ label: TEXT.tryAgain, run: retryList }] : n.links ?? [];
        return links.map(l => ({ label: l.label, run: l.run }));
      }
      default: return [];
    }
  }
  // Script as SELECT of a metadata.* or sys.* object: every column, caret at the end.
  function objectSelect(n) {
    const sql = n.kind === 'meta' ? selectColumnsSql(n.table.columns.map(c => sqlName(c.name)), 'metadata.' + sqlName(n.table.name))
      : selectColumnsSql(n.obj.columns.map(([c]) => sqlName(c)), n.obj.sql);
    return { sql, caret: [sql.length, sql.length] };
  }

  // ---- hover cards (03 §5, §6)
  const hov = { node: null, el: null, pop: null, openT: null, leaveT: null, over: false };
  function cardSource() {
    return createSource({
      // a table card's count is the row's own (countNote), so the source gives none
      meta, session: () => activeSession(), rowCount: null,
      messages: () => msgs.map ?? (typeof meta?.messagesSync === 'function' ? meta.messagesSync() : null),
    });
  }
  // The row count note of a table card: the count of that row's own table (archive.task's retained rows are not
  // task's), '≈' only for an approximate count.
  function countNote(n) {
    const c = counts.get(countKey(n));
    return c ? `${countText(c.n, c.approx)} ${c.n === 1 && !c.approx ? 'row' : 'rows'}` : null;
  }
  // The card model of a row (complete.js cardFor), or null.
  function cardModel(n, src) {
    const on = settings().hoverCards !== false;
    if (!on) {
      // only what 03 §6 asks a tooltip for: a not-readable column, and why EXEC refuses an action
      if (n.kind === 'column' && columnFlags(n.col).notReadable) return { title: n.col.name, mono: true, text: TEXT.notReadable };
      if (n.kind === 'msg' && isRefusedExec(n.msg)) return { title: n.msg.name, mono: true, text: refusedText(n.msg.name) };
      return null;
    }
    switch (n.kind) {
      case 'table': {
        const card = cardFor({ t: 'table', name: n.e.logicalName, schema: n.schema }, src);
        if (card) card.note = countNote(n);
        return card;
      }
      case 'column': return cardFor({ t: 'column', col: n.col }, src);
      case 'meta': return cardFor({ t: 'meta', table: n.table.name }, src);
      case 'metaCol': return cardFor({ t: 'column', col: { name: n.col.name, meta: n.table, type: META_TYPE[n.col.dt] ?? n.col.dt } }, src);
      case 'sys': return n.obj.name === 'messages' ? cardFor({ t: 'sys' }, src) : cardFor({ t: 'function', name: 'FN_HELPCOLLATIONS' }, src);
      case 'sysCol': return { title: n.name, mono: true, sub: n.obj.label, rows: [['Type', n.type]] };
      case 'temp': return cardFor({ t: 'temp', name: n.name }, src);
      case 'tempCol': return { title: String(n.col.name ?? ''), mono: true, sub: `${n.temp}.${n.col.name}`, rows: [['Type', safeTypeName(n.col)]] };
      case 'msg': {
        const card = cardFor({ t: 'message', name: n.msg.name }, src);
        if (card && !card.loading && isRefusedExec(n.msg)) card.note = refusedText(n.msg.name);
        return card;
      }
      case 'builtin': return cardFor({ t: 'function', name: n.doc.name }, src);
      case 'rel': return relCard(n.rel, n.table);
      case 'key': return { title: n.key.logicalName || n.key.schemaName, mono: true, sub: `Alternate key of ${n.table}`, rows: [['Columns', (n.key.attrs ?? []).join(', ')], ['Schema name', n.key.schemaName ?? '']] };
      default: return null;
    }
  }
  function relCard(r, table) {
    const rows0 = [];
    if (r.kind === 'n1') rows0.push(['From', `${table}.${r.attr}`], ['To', `${r.target}.${r.targetAttr}`]);
    else if (r.kind === '1n') {
      rows0.push(['From', `${r.source}.${r.attr}`], ['To', `${table}.${r.sourceAttr}`]);
      const c = r.cascade;
      if (c) rows0.push(['Cascade', ['assign', 'delete', 'reparent', 'share', 'unshare'].filter(k => c[k]).map(k => `${k} ${c[k]}`).join(', ')]);
    } else rows0.push(['Tables', `${r.entity1}, ${r.entity2}`], ['Intersect', r.intersect]);
    return {
      title: r.schemaName, mono: true, sub: r.kind === 'n1' ? 'Many-to-one relationship' : r.kind === '1n' ? 'One-to-many relationship' : 'Many-to-many relationship',
      rows: rows0.filter(([, v]) => v), note: 'Double-click to insert the JOIN.',
    };
  }
  function openCard(n, el) {
    closeCard();
    if (destroyed || !shell?.popover || el.isConnected === false) return;
    const src = cardSource();
    const mdl = withFailures(cardModel(n, src), src);
    loadNeeds(src);
    if (!mdl) return;
    const body = renderCard(mdl);
    const tr = scroller.getBoundingClientRect(), rr = el.getBoundingClientRect();
    const x = tr.right + 4, y = rr.top - 4;
    const rect = { left: x, right: x, top: y, bottom: y, width: 0, height: 0 };
    let pop;
    try {
      pop = shell.popover(rect, body, { role: 'tooltip', label: mdl.title || 'Details', onClose: () => { if (hov.pop === pop) { hov.pop = null; hov.node = null; hov.over = false; if (hov.el) hov.el.removeAttribute('aria-describedby'); hov.el = null; } } });
    } catch (e) { fail(e); return; }
    hov.pop = pop; hov.node = n; hov.el = el; hov.over = false;
    if (pop?.el) {
      if (pop.el.id) el.setAttribute('aria-describedby', pop.el.id);
      pop.el.addEventListener('pointerenter', () => { hov.over = true; cancelT('leaveT'); });
      pop.el.addEventListener('pointerleave', () => { hov.over = false; scheduleLeave(); });
    }
  }
  // Loads what a card is waiting for (choice options, a table's columns) and refreshes it; a failure is kept (until
  // meta refreshes) and the card says so instead of 'Loading…'.
  const needFail = new Map();         // createSource need key -> error text
  function loadNeeds(src) {
    for (const nd of src.needs ?? []) {
      if (needFail.has(nd.key)) continue;
      const load = nd.kind === 'options' && typeof meta?.options === 'function' ? () => meta.options(nd.name, nd.attr)
        : nd.kind === 'entity' && typeof meta?.entity === 'function' ? () => meta.entity(nd.name) : null;
      if (!load) continue;
      let pr;
      try { pr = Promise.resolve(load()); } catch (e) { pr = Promise.reject(e); }
      pr.then(() => refreshCard(), e => { needFail.set(nd.key, errText(e)); refreshCard(); });
    }
  }
  // A card still loading something that failed: the failure in place of 'Loading…'.
  function withFailures(mdl, src) {
    if (!mdl || !mdl.loading) return mdl;
    const failed = (src.needs ?? []).map(nd => needFail.get(nd.key)).find(Boolean);
    return failed ? { ...mdl, loading: false, note: `Couldn’t load the details: ${failed}` } : mdl;
  }
  function refreshCard() {
    if (!hov.pop || !hov.node) return;
    const src = cardSource();
    const mdl = withFailures(cardModel(hov.node, src), src);
    if (!mdl) { closeCard(); return; }
    const fresh = renderCard(mdl);
    const body = hov.pop.el?.firstChild;
    if (body) { clear(body); while (fresh.firstChild) body.appendChild(fresh.firstChild); }
    hov.pop.reposition?.();
  }
  function cancelT(k) { if (hov[k]) { hov[k](); hov[k] = null; } }
  function closeCard() {
    cancelT('openT'); cancelT('leaveT');
    const p = hov.pop;
    if (hov.el) hov.el.removeAttribute('aria-describedby');
    hov.pop = null; hov.node = null; hov.el = null; hov.over = false;
    if (p) { try { p.close(); } catch { /* already closed */ } }
  }
  function scheduleLeave() {
    cancelT('leaveT');
    hov.leaveT = later(() => { hov.leaveT = null; if (!hov.over) closeCard(); }, LEAVE_MS);
  }
  function hoverRow(el) {
    const n = el._node;
    if (!n || n.kind === 'sk' || n.kind === 'state' || n.kind === 'info' || n.kind === 'error' || n.kind === 'group' || n.kind === 'folder' || n.kind === 'category') {
      cancelT('openT');
      if (hov.pop) scheduleLeave();
      return;
    }
    if (hov.node === n && hov.pop) { cancelT('leaveT'); return; }
    if (hov.pop) scheduleLeave();
    cancelT('openT');
    hov.openT = later(() => { hov.openT = null; if (el.isConnected !== false && el._node === n) openCard(n, el); }, HOVER_MS);
  }

  // ---- expand / collapse / focus
  function toggle(n, open = !isExpanded(n)) {
    if (!expandable(n)) return;
    if (isSearching() && (n.kind === 'group' || n.kind === 'category')) {
      if (open) { searchCollapsed.delete(n.id); searchOpened.add(n.id); } else { searchCollapsed.add(n.id); searchOpened.delete(n.id); }
    }
    else if (open) expanded.add(n.id); else expanded.delete(n.id);
    if (!open && hov.node && hov.node.id.startsWith(n.id + '/')) closeCard();
    bump(n);
    rebuild();
  }
  function setActive(n, focus = true) {
    if (!n) return;
    const prev = active;
    active = n;
    if (prev !== n) {
      const pe = rendered.get(prev);
      if (pe) { pe.setAttribute('tabindex', '-1'); pe.classList.toggle('on', false); }
    }
    reveal(n);
    paint();
    if (focus) focusActive(true);
  }
  function reveal(n) {
    const i = n.idx;
    if (model.nodes[i] !== n) return;
    const viewH = viewHeight();
    const top = revealScrollTop(model.starts[i], n.span || 1, { scrollTop: scroller.scrollTop || 0, viewH, slots: model.slots });
    if (Math.abs(top - (scroller.scrollTop || 0)) >= 0.5) scroller.scrollTop = top;
  }
  function focusActive(scroll) {
    const el = active ? rendered.get(active) : null;
    if (!el) return;
    if (scroll) reveal(active);
    try { el.focus({ preventScroll: true }); } catch { el.focus?.(); }
  }
  function rowHasFocus() {
    const a = root.getRootNode?.()?.activeElement ?? globalThis.document?.activeElement;
    return !!a && rows.contains(a);
  }
  const rowEl = t => {
    for (let x = t; x && x !== rows; x = x.parentNode) if (x._node && (x.classList?.contains('ex-row') || x.classList?.contains('ex-st'))) return x;
    return null;
  };

  // ---- events
  const listen = (el, type, fn, o) => { el.addEventListener(type, fn, o); offs.push(() => el.removeEventListener(type, fn, o)); };
  let ta = { text: '', at: 0 };
  listen(rows, 'click', e => {
    const el = rowEl(e.target);
    if (!el) return;
    const n = el._node;
    closeCard();
    const onChevron = (() => { for (let x = e.target; x && x !== el; x = x.parentNode) if (x.classList?.contains('ex-cv')) return true; return false; })();
    setActive(n, true);
    if (onChevron) toggle(n);
  });
  // double-click (SSMS): a group, folder or category toggles, any other row inserts its text (03 §6); a double-click
  // on a chevron was two toggles already
  listen(rows, 'dblclick', e => {
    const el = rowEl(e.target);
    if (!el) return;
    for (let x = e.target; x && x !== el; x = x.parentNode) if (x.classList?.contains('ex-cv') || x.localName === 'button') return;
    e.preventDefault?.();
    activate(el._node);
  });
  listen(rows, 'keydown', e => {
    if (e.defaultPrevented || e.isComposing) return;
    const el = rowEl(e.target);
    const n = el?._node ?? active;
    if (!n) return;
    closeCard();
    const i = model.nodes[n.idx] === n ? n.idx : -1;
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); activate(n); return; }
    if (e.key === 'F2') { e.preventDefault(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const page = Math.max(1, Math.floor(viewHeight() / ROW_H) - 1);
    const r = treeNav(model.nodes, i, e.key, { page, expandable: k => expandable(model.nodes[k]), expanded: k => isExpanded(model.nodes[k]) });
    if (r) {
      e.preventDefault();
      if (r.expand) toggle(n, true);
      else if (r.collapse) toggle(n, false);
      else setActive(model.nodes[r.to], true);
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) { e.preventDefault(); return; }
    if (e.key.length === 1 && e.key !== ' ') {
      const now = Date.now();
      ta = { text: now - ta.at < TYPE_MS ? ta.text + e.key : e.key, at: now };
      const labelAt = k2 => typeLabel(model.nodes[k2]);
      let k = typeAhead(model.nodes.length, labelAt, i, ta.text);
      if (k < 0 && ta.text.length > 1) { ta.text = e.key; k = typeAhead(model.nodes.length, labelAt, i, e.key); }
      if (k >= 0) { e.preventDefault(); setActive(model.nodes[k], true); }
    }
  });
  listen(rows, 'contextmenu', e => {
    const el = rowEl(e.target);
    if (!el || !shell?.contextMenu) return;
    const n = el._node;
    closeCard();
    setActive(n, true);
    const items = menuFor(n);
    if (!items.length) { e.preventDefault?.(); return; }
    shell.contextMenu(e, items);
  });
  // focus that arrives otherwise (Tab, F6, a click on a row's link) makes that row the active one; its hover
  // actions (shown on focus-within) read their state again
  listen(rows, 'focusin', e => {
    const el = rowEl(e.target);
    if (el) syncActs(el);
    if (el && el._node && el._node !== active) { active = el._node; paint(); }
  });
  // a drag carries the row's text as text/plain (Edge's textarea drop inserts it at the drop caret); a relationship
  // also carries its id, so a drop into the editor's text gets the JOIN for the statement at the drop point
  let dragNode = null;
  listen(rows, 'dragstart', e => {
    const el = rowEl(e.target);
    const n = el ? el._node : null;
    const text = n ? dragText(n) : '';
    if (!text || !e.dataTransfer) { e.preventDefault?.(); return; }
    closeCard();
    e.dataTransfer.setData('text/plain', text);
    if (n.kind === 'rel') { try { e.dataTransfer.setData(DRAG_TYPE, n.id); } catch { /* text/plain still drops */ } }
    e.dataTransfer.effectAllowed = 'copy';
    dragNode = n;
  });
  listen(rows, 'dragend', () => { dragNode = null; });
  // the drop of a dragged relationship on the editor's text (03 §6 'drag inserts at drop'): the JOIN for the
  // statement at the drop offset (editor.offsetAt, 03 §1.4), spaced as an insert is, one undoable insert, selected
  // as a dropped text is; anything else is left to the textarea and the editor
  function onEditorDrop(e) {
    const n = dragNode;
    const dt = e.dataTransfer;
    if (!n || n.kind !== 'rel' || !dt || !dt.types || ![...dt.types].includes(DRAG_TYPE)) return;
    if (typeof editor.offsetAt !== 'function' || typeof editor.insert !== 'function' || typeof editor.getValue !== 'function') return;
    let at = null;
    try { at = editor.offsetAt(e.clientX, e.clientY); } catch { at = null; }
    const text = String(editor.getValue() ?? '');
    if (!Number.isInteger(at) || at < 0 || at > text.length) return;
    e.preventDefault();
    e.stopPropagation?.();
    dragNode = null;
    const sql = spacedInsert(relJoinAt(n, text, at), text[at - 1] ?? '', text[at] ?? '');
    try {
      editor.insert(sql, { at });
      editor.select?.(at, at + sql.length, { reveal: true });
      editor.focus?.();
    } catch (err) { fail(err); }
  }
  const dropTarget = editor?.textarea && typeof editor.textarea.addEventListener === 'function' ? editor.textarea : null;
  if (dropTarget) listen(dropTarget, 'drop', onEditorDrop);
  // the row's buttons (Select top 100, Count rows, links) have titles of their own: no card over them; entering a row
  // reads its hover actions' state again (the run lock)
  listen(rows, 'pointerover', e => {
    const el = rowEl(e.target);
    if (!el) return;
    pointerRow = el;
    syncActs(el);
    for (let x = e.target; x && x !== el; x = x.parentNode) if (x.localName === 'button') { cancelT('openT'); return; }
    hoverRow(el);
  });
  listen(rows, 'pointerleave', () => { pointerRow = null; cancelT('openT'); if (hov.pop) scheduleLeave(); });
  listen(rows, 'pointerdown', () => closeCard());
  listen(scroller, 'scroll', () => { closeCard(); queuePaint(); });
  // files dropped on the explorer (03 §6): .csv/.tsv open the Load CSV dialog
  const hasFiles = e => { const t = e.dataTransfer?.types; return !!t && [...t].includes('Files'); };
  listen(scroller, 'dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; scroller.classList.toggle('ex-drop', true); });
  listen(scroller, 'dragleave', e => { if (e.target === scroller || !scroller.contains(e.relatedTarget ?? null)) scroller.classList.toggle('ex-drop', false); });
  // With the editor's onFile (opts.onFile) a drop here does what a drop on the editor does (dropCalls: one call per
  // .sql/.txt or other file, one for all .csv/.tsv files); without it the .csv/.tsv files load and any other file is
  // named in a warning (03 §12: no input is ignored silently).
  listen(scroller, 'drop', e => {
    scroller.classList.toggle('ex-drop', false);
    if (!hasFiles(e)) return;
    e.preventDefault();
    const all = [...(e.dataTransfer.files ?? [])].filter(Boolean);
    if (typeof opts.onFile === 'function') {
      for (const [f, kind] of dropCalls(all)) { try { opts.onFile(f, kind); } catch (err) { fail(err); } }
      return;
    }
    const files = all.filter(f => fileKind(f.name) === 'csv');
    const skipped = all.filter(f => fileKind(f.name) !== 'csv');
    if (!files.length) { toast(TEXT.dropOnly, { kind: 'warn' }); return; }
    loadCsvFiles(files);
    if (skipped.length) toast(skippedText(skipped), { kind: 'warn' });
  });
  // The warning for the files of a drop that were not loaded: '“notes.sql” was not loaded. Only .csv …'.
  function skippedText(files) {
    const names = files.slice(0, 3).map(f => quoteName(String(f.name ?? ''))).join(', ');
    const more = files.length > 3 ? ` and ${fmtInt(files.length - 3)} more` : '';
    return `${names}${more} ${files.length === 1 ? 'was' : 'were'} not loaded. ${TEXT.dropOnly}`;
  }

  // search box
  let pendingQuery = null, searchTimer = null;
  const applyQuery = () => { searchTimer = null; if (pendingQuery == null) return; const q = pendingQuery; pendingQuery = null; setQuery(q, { fromInput: true }); };
  listen(search, 'input', () => {
    pendingQuery = search.value;
    if (searchTimer) searchTimer();
    if (!searchDelay) applyQuery(); else searchTimer = later(applyQuery, searchDelay);
  });
  listen(search, 'keydown', e => {
    if ((e.key === 'ArrowDown' || e.key === 'Enter') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (searchTimer) { searchTimer(); applyQuery(); }
      const first = model.nodes.find(x => !x.hidden && x.kind !== 'group') ?? model.nodes.find(x => !x.hidden);
      if (first) setActive(first, true);
    }
  });
  listen(filterBtn, 'click', () => {
    if (!shell?.menu) return;
    shell.menu(filterBtn, filterItems, { label: 'Filter tables', align: 'end' });
  });
  listen(refreshBtn, 'click', () => refreshMeta());
  // The filter menu (03 §6): one table type, and Show private tables.
  function filterItems() {
    return [
      ...TABLE_TYPES.map(([v, label]) => ({ label, checked: filter.type === v, run: () => setFilter({ type: v }) })),
      '-',
      { label: TEXT.showPrivate, checked: filter.showPrivate, run: () => setFilter({ showPrivate: !filter.showPrivate }) },
    ];
  }

  function setQuery(q, { fromInput = false } = {}) {
    const next = String(q ?? '');
    if (!fromInput && search.value !== next) search.value = next;
    if (next === query) return;
    query = next;
    searchCollapsed.clear();
    searchOpened.clear();
    epoch++;
    scroller.scrollTop = 0;
    rebuild();
    if (isSearching()) scheduleAnnounce();
  }
  let announceT = null;
  function scheduleAnnounce() {
    if (announceT) announceT();
    announceT = later(() => {
      announceT = null;
      const n = lastMatches;
      announce(n ? `${fmtInt(n)} ${n === 1 ? 'table matches' : 'tables match'}.` : noMatchLine(query) + '.');
    }, 500);
  }
  function setFilter(patch) {
    if (patch.type !== undefined && TABLE_TYPES.some(([v]) => v === patch.type)) filter.type = patch.type;
    if (patch.showPrivate !== undefined) filter.showPrivate = !!patch.showPrivate;
    const on = filter.type !== 'all' || filter.showPrivate;
    filterBtn.classList.toggle('on', on);
    filterBtn.setAttribute('title', on ? `Filter tables: ${[TABLE_TYPES.find(([v]) => v === filter.type)[1], filter.showPrivate ? 'private tables shown' : null].filter(Boolean).join(', ')}` : 'Filter tables');
    epoch++;
    rebuild();
  }
  async function refreshMeta() {
    if (refreshing || !meta || typeof meta.refresh !== 'function') return;
    refreshing = true;
    refreshBtn.setAttribute('aria-busy', 'true');
    refreshBtn.disabled = true;
    try { await meta.refresh(); metaEpoch++; listState = 'ready'; listError = null; } catch (e) {
      if (!entities().length) { listState = 'failed'; listError = e; }
      toast(`The metadata could not be reloaded: ${errText(e)}`, { kind: 'error' });
    } finally {
      refreshing = false;
      refreshBtn.removeAttribute('aria-busy');
      refreshBtn.disabled = false;
      changed();
    }
  }
  function retryList() {
    listState = 'loading'; listError = null;
    changed();
    const p = initDone && typeof meta?.refresh === 'function' ? meta.refresh() : typeof meta?.init === 'function' ? meta.init() : null;
    watchList(p);
  }
  function watchList(p) {
    if (!p || typeof p.then !== 'function') return;
    p.then(() => { metaEpoch++; initDone = true; listState = 'ready'; listError = null; listReady(); changed(); }, e => {
      if (!entities().length) { listState = 'failed'; listError = e; } else listState = 'ready';
      changed();
    });
  }
  function listReady() { if (entities().length) loadBin(); }

  // ---- outside events
  const onBus = (type, fn) => { if (typeof S?.on === 'function') offs.push(S.on(type, fn)); };
  onBus('meta:loaded', () => { metaEpoch++; listState = entities().length ? 'ready' : listState; listReady(); changed(); });
  // 02 §9 emits `temps` after every #temp change (each INSERT of a WHILE loop): only the Temporary tables rows whose
  // name, row count or columns changed are filled again (node versions), not every visible row
  onBus('temps', p => { if (!p || p.tabId == null || p.tabId === st().activeTab) changed(); });
  onBus('tab:changed', () => { closeCard(); epoch++; changed(); });
  onBus('tab:list', () => changed());
  // the run lock changes the row actions' state (03 §6, §7): the visible rows' hover actions read it again (and every
  // row's on pointer enter and focus, for the runs that send no run events)
  const syncAllActs = () => {
    const run = () => { if (!destroyed) for (const el of rendered.values()) syncActs(el); };
    if (frame) frame(run); else queueMicrotask(run);
  };
  onBus('run:start', syncAllActs);
  onBus('run:end', syncAllActs);
  onBus('settings', p => { if (!p?.keys || p.keys.includes('hoverCards')) { if (settings().hoverCards === false) closeCard(); } });
  if (meta && typeof meta.onChange === 'function') {
    offs.push(meta.onChange(ev => {
      // a table load keeps the sorted list and the kept search results when it changes nothing they depend on
      // (patchEntity); every other change of the metadata makes them again
      if (ev?.kind !== 'error' && !(ev?.kind === 'entity' && patchEntity(lower(ev.name)))) metaEpoch++;
      switch (ev?.kind) {
        case 'entities': if (entities().length) { listState = 'ready'; listError = null; listReady(); } epoch++; changed(); break;
        case 'entity': {
          const key = `e:${lower(ev.name)}`;
          const l = loads.get(key);
          if (l && l.status !== 'loading' && typeof meta.entitySync === 'function') { const v = meta.entitySync(ev.name); if (v) { l.status = 'done'; l.value = v; l.error = null; } }
          changed();
          break;
        }
        case 'refresh':
          generation++;
          loads.clear();
          needFail.clear();
          msgsToken = null;
          if (msgs.status !== 'idle') { msgs = { status: 'idle', map: null, error: null }; if (expanded.has('g:functions') || expanded.has('g:actions')) loadMessages(true); }
          bin = { status: 'idle', set: null, error: null };
          listState = entities().length ? 'ready' : listState;
          listReady();
          epoch++;
          changed();
          break;
        case 'error':
          if (ev.source === 'entities' && !entities().length) { listState = 'failed'; listError = ev.error; changed(); }
          break;
        default: break;
      }
    }));
  }
  if (shell?.shortcut) {
    try { offs.push(shell.shortcut('explorerSearch', () => { focusSearch(); return true; })); } catch (e) { fail(e); }
  }
  if (typeof globalThis.ResizeObserver === 'function') {
    try { const ro = new globalThis.ResizeObserver(() => queuePaint()); ro.observe(scroller); offs.push(() => ro.disconnect()); } catch { /* sizes are read on every paint */ }
  }

  // ---- start
  if (listState === 'ready') { initDone = true; listReady(); }
  else if (meta && typeof meta.init === 'function') watchList((() => { try { return meta.init(); } catch (e) { return Promise.reject(e); } })());
  rebuild();

  function focusSearch() { search.focus(); search.select?.(); }

  return {
    el: root,
    // The row count Count rows found for a table (complete.js rowCount: '≈ 12,345 rows'), or null; `schema`
    // ('archive', 'bin') asks for that schema's table, whose count is its own.
    rowCount: (name, schema = null) => counts.get(schema ? `${lower(schema)}.${lower(name)}` : lower(name))?.n ?? null,
    focusSearch,
    focusTree: () => { if (!active) active = model.nodes.find(n => !n.hidden) ?? null; paint(); focusActive(true); },
    refresh: () => { epoch++; rebuild(); },
    setQuery: q => setQuery(q),
    expand: id => { const n = nodes.get(id); if (n) toggle(n, true); else { expanded.add(id); rebuild(); } },
    collapse: id => { const n = nodes.get(id); if (n) toggle(n, false); else { expanded.delete(id); rebuild(); } },
    // Inspection hook: the flattened rows {id, kind, level, label, expanded, count} and the rendered ones.
    model: () => ({
      rows: model.nodes.map(n => ({ id: n.id, kind: n.kind, level: n.level, pos: n.pos, size: n.size, label: labelOf(n), expanded: isExpanded(n), node: n })),
      slots: model.slots, rendered: rendered.size, active: active?.id ?? null, query, filter: { ...filter },
      menu: id => { const n = nodes.get(id); return n ? menuFor(n) : null; },
      insertText: id => { const n = nodes.get(id); return n ? insertText(n) : null; },
      card: id => { const n = nodes.get(id); return n ? cardModel(n, cardSource()) : null; },
      rowEl: id => { const n = nodes.get(id); return n ? rendered.get(n) ?? null : null; },
      activate: id => { const n = nodes.get(id); if (n) activate(n); },
      setActive: id => { const n = nodes.get(id); if (n) setActive(n, true); },
      flush: () => { if (searchTimer) { searchTimer(); applyQuery(); } if (rebuildQueued) rebuild(); if (paintQueued) { paintQueued = false; paint(); } },
    }),
    destroy() {
      if (destroyed) return;
      closeCard();
      destroyed = true;
      if (searchTimer) searchTimer();
      if (announceT) announceT();
      for (const off of offs.splice(0)) { try { off?.(); } catch { /* already removed */ } }
      for (const el of rendered.values()) bindTip(el, null);
      rendered.clear();
      root.remove();
    },
  };
}
