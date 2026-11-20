// Plan operators (02 §6; 01 §6-§7): PlanNode and every operator of the physical plan,
// as async iterators of positional row batches. FetchScan and PartitionedAggregate (fetchxml.js) and MetaScan
// (metatables.js) extend PlanNode in their own modules. Pure: no DOM; numbered errors come from messages.js msg(); FOR XML
// text is escaped only with core/xml.js xmlEsc; values follow types.js.
//
// Notes:
// The Prepare-phase contract (PlanNode, collect(), explainPlan(), explainNode(),
// stateOf(), the statement counters, emitInfo/emitWarn and every constructor's options, fields, validation, schema,
// explain() and prepare()) is as 02 §6 defines it; every operator's execute() is implemented, with the run-time rules listed
// under "Run-time rules" at the end of these notes.
//
// PlanNode protocol
// - Fields: op (the operator name explain() shows and 04 §4.1 `ops` checks match; set explicitly, because the bundle
//   mangles class names), kids (inputs in data-flow order), schema (Column[], 01 §6.1), stats {rows, ms, requests,
//   calls}, server (true: runs in Dataverse; false: in the browser; null: a pseudo-node), script (true for the 02 §9
//   control-flow pseudo-nodes), warnings (string[] shown on the node, e.g. the join warning; the planner
//   pushes to it), plans (PlanNode[]: the plans of the subqueries inside the node's compiled expressions, gathered
//   from their `plans` fields; explain() lists them after kids), est (estimated rows or null).
// - Every operator also takes the common options detail (replaces the default explain detail; e.g. a pushed condition
//   text), props ([{name, value}] appended to the operator's own), warnings and est. `new PlanNode({op, kids, schema,
//   server, script, detail, props, warnings, est})` makes a pseudo-node (e.g. 'Subquery (evaluated at run time)'
//   under ctx.explainOnly, server null); running one is an internal error.
// - Subclasses implement `async *execute(env)` yielding Row[] batches and never override run(). run(env) is the one
//   entry point: it counts calls, rows and ms (wall time inside the node, its kids included, its consumer's time
//   excluded), drops empty batches (02 §6: batches are non-empty), checks env.signal before and between batches
//   (signal.throwIfAborted(), the AbortError the session reports as `Query cancelled.`) and once more when execute()
//   ends, so a cancel inside a synchronous loop is never reported as a complete (or empty) result, and closes
//   execute()'s generator when its consumer stops early, so a Top's return() reaches every generator below it.
//   FetchScan, PartitionedAggregate and MetaScan implement execute() too and add stats.requests themselves.
// - rowsCounted() -> boolean (extension, count once; Statement counters below): true when every row the node yields
//   has already been counted against maxScanRows by the node or below it. Default false (scans, ConstantScan,
//   #temp/@table TempScan, ApiFnScan); true for the operators that hold or count their input; a streaming operator
//   answers for the input its rows come from. The operators of fetchxml.js and metatables.js keep the default unless they count their own rows.
// - rowGoal (extension, a number, 0 = none) and markGoalKids(n) (Row goals below): the fewest rows a consumer above may
//   need. markGoalKids passes a goal to the inputs early stop reaches (the streaming operators override it);
//   FetchScan may read rowGoal (e.g. for a smaller first page) but never needs to.
// - ioPerRun() -> boolean (extension): whether one run may send Dataverse requests (server true in the subtree or in
//   node.plans, not behind a Spool, IndexSpool or IndexSeek); NestedLoop APPLY runs executions ahead only then.
// - detail() -> string and props() -> [{name, value}] (value a string) are the operator's own explain parts.
//   explain() -> {op, detail, server, warnings, stats, kids, props, script?} (02 §6): stats is null until the node
//   has run (estimated plans have no stats, 03 §7), props = props(), then the planner's props, then
//   {name: 'Estimated rows', value} when est is set. FetchScan's explain() adds fetchXml (a string; PartitionedAggregate
//   a string[]: its tier-1 FetchXML and its first partition's); explainPlan() numbers them as fetchIndex.
// - prepare(outerRows, env): a correlated driver (compile.js `pre` (b) and NestedLoop with apply) calls it with a
//   batch of outer rows before it runs the plan once per outer row (each run with env.outer = [row, ...env.outer]).
//   The default awaits prepare() of every kid; IndexSeek loads its IndexSpool for the keys of the whole batch (one
//   keyed fetch per batch); NestedLoop with apply prepares its left input only (its right side is keyed by its
//   own left rows). node.plans are never prepared from outside: their own `pre` drives them.
//
// Run-time state and env (01 §7 env, extended)
// - A plan is built per execution of a statement (02 §3), but one node may run many times in it (correlated
//   executions, NestedLoop right sides, recursive iterations, a Spool under two CTE references). State that must
//   outlive one run() lives in env.subq (01 §7: the statement's cache Map), keyed by the node object: Spool rows,
//   IndexSpool's loaded keys and index, the statement counters. stateOf(env) returns env.subq, creating it when the
//   env has none, and run() creates it on an env without one before anything derives from it, so derived envs
//   (`{...env, outer: [row, ...env.outer]}`) share it. The session gives every statement a fresh env.subq.
// - env.api and env.meta (extension): the session's api and meta (02 §9). ApiFnScan sends its requests through its
//   `api` option or env.api; dop (correlated executions, NestedLoop parallel, IndexSpool chunks) is env.api.dop,
//   else 4. FetchScan may read env.api the same way. env.literals (extension): {guidParam, enumParam, dateParam},
//   api.js's typed-literal exports, for ApiFnScan's Guid, enum and Edm.Date parameters (engine/ cannot import data/,
//   00 §3). 01 §7 env does not list it; main.js/the session sets it from api.js's exports, or api.js's api object carries the
//   three functions; dateParam(text 'yyyy-MM-dd') -> typed literal written unquoted (Edm.Date), as guidParam is for Guid.
// - env.tally (extension, internal): {rows, up} chain of the TryCatch bodies in progress; countRows adds to every tally
//   of the chain, so a fallback can take its discarded body's rows back out of the statement counter.
// - env.work (extension): Map<lower-case CTE name, Row[]>, the working table of the RecursiveCte iteration in progress
//   (the rows of the previous iteration). The planner plans the recursive reference as TempScan({name: <cte name>,
//   schema}): a TempScan whose name starts with neither '#' nor '@' reads env.work ('#x' reads env.session.temps and
//   '@x' env.vars.get('@x').table, 01 §4.1).
// - env.scanArgs (extension; the contract with FetchScan for keyed spools and seeks): Map<FetchScan node,
//   {conds?: Condition[], rows?: Row[]}>. When the env given to a FetchScan's run() has an entry for that scan (set
//   by a node above it, wherever the scan sits below), the scan ANDs `conds` (02 §4 Condition shape {entityname,
//   attr, op, value, values}) into its fetch for that run, splitting an `in` condition's values into chunks per
//   02 §4.2 (at most 500 values, within the 60,000-character budget) that run in parallel up to dop and are
//   concatenated; with `rows` it yields exactly those rows (rows it returned before, in its own schema) and sends no
//   request. IndexSpool (keyed) sets {conds: [{entityname, attr: column, op: 'in', values}]} with a batch's new key
//   values; RecursiveCte sets {conds: [in]} per iteration, {conds: [{attr: column, op: 'not-null'}]} for its one full
//   read and {rows} for the probes after it. Values are JS values of the key column's type; the scan formats them
//   for its attribute as it formats plan-time constants (02 §4.2 condition values). An entry already present for the
//   same scan (set by a node further up) is kept: the new conds are appended to its conds.
// - env.info?(text) and env.warn?(text, kind?) (extension of 01 §7 warn): info adds a Messages 'info' line; warn adds a
//   'warn' line and, with kind 'limit'|'fallback'|'approx'|'legacy-paging', also a resultdone warning of that kind
//   (02 §9). emitInfo(env, text) and emitWarn(env, text, kind) call them when present. TryCatch emits its message
//   with kind 'fallback'.
// - Statement counters (02 §4.4), one per statement (stateOf), shared by every node and the scans of fetchxml.js:
//   countRows(env, n) adds rows read for client-side processing and raises `The query read more than <n> rows to
//   process in the browser. Add a filter or raise the limit in Settings.` (code 'LIMIT', no number) above
//   settings.maxScanRows (env.settings, else env.session.settings; default 500,000); countRequests(env, n = 1) adds
//   Dataverse requests and raises `The statement sent more than <n> requests to Dataverse (setting Max requests per
//   statement). Add a filter or raise the limit in Settings.` (code 'LIMIT'; 02 §4.4 gives no text) above
//   settings.maxRequests (default 500). A row counts once ("rows read", 02 §4.4): operators that hold their input
//   (Sort, HashAggregate, the HashJoin build side, Window, Distinct, SetOp except UNION ALL, Spool, IndexSpool,
//   TryCatch (body and fallback), RecursiveCte (anchor, levels, its one index read), Into, JsonOutput, XmlOutput, Pivot,
//   Unpivot, TOP … PERCENT and a NestedLoop's materialised right side) count its rows, and streaming operators count
//   the input rows they drop (Filter; a HashJoin probe row that adds to no output row; a NestedLoop left row that
//   gives no output row; the right rows an APPLY reads and does not pass on: those its predicate rejects and those a
//   semi/anti APPLY consumes) - each only when that input's rowsCounted() is false, so a row read once is counted
//   once whatever the number of holding operators above it (Sort over Window, Spool under a join, the working table
//   under a recursive step). TvfScan counts the rows it builds, and each call may build only the rows the statement
//   still allows (functions.js rows(limit) with that remainder; its limit error becomes the statement's); scans,
//   Project, Top, Offset, Concat and Assert count none. A TryCatch body counts into its own tally; a fallback takes
//   that tally back out (rows the body left in statement caches, a Spool's or an uncorrelated subquery's, are then
//   not counted again when the fallback reuses them).
//
// Operators (02 §6; '+' marks an option 02 §6 does not list). Compiled = a compileExpr/compilePredicate result
// (see the notes at the top of compile.js); every operator awaits `c.pre?.(batch, env)` before c.fn on a batch (01 §7). Key =
// Compiled & {desc}: Sort keys, Top WITH TIES keys, Window order and WITHIN GROUP order; it compares with key.coll
// (COLLATE) as `ai`, else key.ci_ai (01 §5.2), through types.sortKey/cmpKeys (NULL lowest).
// - Filter({kid, pred}): keeps the rows where pred is true.
// - Project({kid, exprs, schema, +extra}): output row = the exprs' values, then the input values at `extra` (the hidden
//   companion source indexes projectSchema returned, 01 §7); schema = projectSchema(…).schema, so schema.length =
//   exprs.length + extra.length. An `extra` entry may also be a function (row, env) => value, an object with
//   fn(row, env) or a ref {entityFn}: the value is then computed per input row (the role-'type' companion that the
//   outermost Project fills from an {entityFn} ref, 01 §6.2).
// - HashJoin({kind, left, right, lkeys, rkeys, residual, schema, lcorr, rcorr, +build}): kind inner|left|right|full|
//   semi|anti|antiNullAware; lkeys/rkeys Compiled[] over left/right.schema, already converted to their common type by
//   the planner (02 §6 Hash keys); residual a predicate over the joined row (left columns, then right columns
//   through shiftSchema) or null; lcorr/rcorr correlation keys of antiNullAware only; build 'left'|'right': the
//   side read fully, while the other streams; default: the side with the smaller `est` when both inputs have
//   one (02 §6 'build = smaller side when known'; not for antiNullAware), else 'right' ('left' for kind right). semi, anti and
//   antiNullAware emit left rows (schema left.schema); the others emit left + right columns, NULL-extended on the
//   unmatched side. schema defaults to exactly that.
// - NestedLoop({kind, left, right, pred, apply, schema, +parallel, +memo}): kind inner|left|right|full|cross|semi|anti
//   (cross is inner without pred); with apply only inner|cross (CROSS APPLY), left (OUTER APPLY), semi or anti. pred a
//   predicate over the joined row or null. With apply the right side runs once per left row with env.outer = [leftRow,
//   ...env.outer], after right.prepare(leftBatch, env); without apply it is uncorrelated, read once and kept. The
//   rows of one left row come before the next row's (02 §4.3 Sort pushdown). While a row goal of at most BATCH rows
//   (Row goals below) is not met, an APPLY runs one left row at a time and yields its rows before the next left row
//   runs the right side, so a Top above stops the loop after the left row that completes it (so a TVF is called
//   at most TOP n times). Otherwise (no goal, or the goal met) it runs up to dop executions of a left batch ahead,
//   still in left-row order, when parallel is set (hierarchy anchors) or the right side sends requests
//   (ioPerRun: 01 §7 pre (b) '≤ api.dop concurrently'), under a child AbortController linked to env.signal and
//   aborted when the loop ends or is closed early; a pure in-browser right side (a TVF) runs serially. parallel also
//   runs ahead under a goal. memo (number[] | null; the planner passes the left column indexes the right side
//   references, compile.js's depth-0 outer references of the body, and null when the body contains NEWID()): the raw
//   right rows are memoised per distinct tuple of those left values for the run (exact identity as compile.js: strings
//   verbatim, NULL a value), at most 10,000 keys and 50,000 memoised rows, so a repeated outer value sends no new
//   request; executions of one key in flight share their promise; [] = an uncorrelated body, run once. A semi/anti
//   APPLY with a predicate is never memoised. Results never depend on memo or the executions ahead. schema defaults
//   as for HashJoin.
// - Sort({kid, keys, top}): keys Key[]; stable; top null or a number of rows to keep (a Top above still applies; WITH
//   TIES never fuses into Sort).
// - Top({kid, n, percent, ties, keys}): n a number or a Compiled evaluated once per run with fn([], env) after its pre
//   (`TOP (@n)`, `TOP (SELECT …)`); negative raises 127; percent: 0..100 (else 1031), CEILING(n / 100 × count) rows,
//   reading its input fully; ties: keys = the ORDER BY keys (Key[]), cmp equality on all of them. Stops pulling as
//   soon as it has its rows.
// - Offset({kid, skip, take}): numbers or Compiled as for Top; take null = no FETCH; a negative skip raises 10742 and a
//   take ≤ 0 raises 10744 (variables at run time; literals are parse-time errors).
// - Distinct({kid}): rows unique by rowKey of the visible columns (NULLs equal; collation and per-column ci_ai); the
//   first occurrence streams. schema = kid's visible columns without `companion` (01 §6.1).
// - HashAggregate({kid, keys, aggs, sets, schema}): keys Compiled[] over kid.schema (deduplicated by the planner);
//   aggs [{def /* functions.js AGGREGATES entry */, args: Compiled[], distinct, consts, order: Key[] | null, +text}];
//   sets number[][] (02 §3 phase 5; default [[0..n-1]], or [[]] without keys). Output rows [keys…, aggs…, gid], keys
//   outside the row's set NULL, gid the GROUPING_ID bitmask (bit n-1-i set when key i is absent); the gid column is
//   present exactly when schema has keys.length + aggs.length + 1 columns (the last one hidden, role 'gid'). The empty
//   set yields its row also over zero input rows (COUNT 0, other aggregates NULL). Groups come out set by set, each
//   in order of first appearance. init/step/result get argTypes and env (01 §8).
// - Window({kid, partition, order, funcs, schema}): partition Compiled[], order Key[], funcs [{def /* WINDOWS or
//   AGGREGATES entry */, args: Compiled[], consts, frame /* 01 §4.4 over.frame or null */, +text}]; output row = the
//   input row followed by one value per func (schema = kid.schema + one Column per func); rows come out partition by
//   partition in window order.
// - Concat({kids, schema}): UNION ALL of the kids in order; schema the result columns (visible); each kid's visible
//   columns map by position (205 when a count differs), and a value whose kid column type differs from the result
//   column's is converted with types.coerce (conversion errors raise).
// - SetOp({op, all, left, right, +schema}): op 'UNION'|'INTERSECT'|'EXCEPT' as in the AST; all only with UNION (it then
//   behaves as Concat). schema, when not given: names from left's visible columns, types = types.commonType per
//   column (206 on a clash), qual null, ref and attr kept when identical in both, ci_ai when either has it, and a
//   string column's Column.coll (see the notes at the top of compile.js) from the left, else the right column; 205 when
//   the visible counts differ (the planner checks first, with the statement position) and 305 for an xml column
//   unless UNION ALL. INTERSECT and EXCEPT return distinct rows.
// - Spool({kid}): reads kid fully on its first run in the statement and replays the rows on every later run.
// - IndexSpool({kid, keys, mode, +seek}): keys Compiled[] over kid.schema, each converted to its pair's common type;
//   rows indexed by rowKey of the key values (a row with a NULL key part is never indexed). mode 'keyed' needs seek =
//   {scan /* the FetchScan of S holding the key column */, column /* its attribute */, entityname /* its link alias,
//   or null for the root */, key /* index into keys */}: load(tuples, env) fetches the not-yet-loaded values of
//   tuple[seek.key] in one run of kid under env.scanArgs; mode 'full' reads kid once on the first load. Rows count
//   against maxScanRows (countRows); requests are counted by the scan. group(tuple, +env) -> Row[] (synchronous, []
//   for an unknown or NULL tuple; env selects the statement's state, without it the state of the spool's most recent
//   load); load(tuples, env) -> Promise. Run directly, an IndexSpool yields the rows it has loaded (all of S in full
//   mode). Each load its seeks drive (outside its own run()) adds one call, the rows read and the time to stats, so
//   the Plan view shows the spool as run.
// - IndexSeek({spool, keyExprs}): kids [spool]; keyExprs Compiled[] (no subqueries) that reference only outer columns
//   (depth ≥ 1), variables and constants, evaluated with fn([], env); yields the spool's group for their values
//   (nothing when a part is NULL: the correlated equality is never true), loading that key first when no prepare()
//   did; prepare(outerRows, env) loads the keys of all the outer rows at once.
// - RecursiveCte({anchor, step, name, max, seek, +schema, +stream}): name the lower-case CTE name (the env.work key); max the
//   MAXRECURSION value (default 100; 0 caps at 32,767, 02 §3 phase 6); seek {scan /* T's FetchScan inside step */,
//   column /* c */, keyIndex /* index of k in the working rows */, +colIndex /* index of c in scan.schema; default
//   the scan column named column */} | null (per iteration env.scanArgs `c in (distinct non-NULL k)`; after an
//   iteration with more than 5,000 keys one `c not-null` read indexed by c and {rows} probes). schema defaults to
//   anchor.schema; step values whose type differs from the anchor column are converted with castValue. Exceeding
//   max raises 530. Without a row goal nothing is yielded before the recursion has ended (530 returns no rows). Under
//   a row goal (a Top, an Offset … FETCH, an EXISTS's TOP 1 or collect(limit) above, through streaming operators;
//   Row goals below), or with stream true (planner-set), the anchor rows and then each finished level are yielded as
//   soon as they exist, so the consumer's return() ends the recursion before the next iteration, as SQL Server's
//   stack spool under a TOP (`WITH n AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT TOP 50 i FROM n` returns 50
//   rows and no 530, also with MAXRECURSION 0); a goal the recursion cannot meet still raises 530 after the rows it
//   yielded, as SQL Server does.
// - Into({kid, name}): SELECT … INTO #name (02 §3 phase 5): reads kid fully (2714 when the name exists at run time),
//   then registers env.session.temps.set(lower name, {name (as written), columns (kid's visible columns, nullable,
//   with their static types), rows, identity: null}); yields nothing (schema []); `rowcount` is the number of rows
//   written once the run ends (@@ROWCOUNT, '(n rows affected)'), null before.
// - Pivot({kid, +keys, +pivot, +values, +agg, schema}) (02 §6 `…`): keys number[] (the implicit grouping columns, kid
//   indexes, 01 §4.3), pivot (the FOR column's kid index), values (the IN values converted to the FOR column's type,
//   in IN-list order), agg {def, args: Compiled[], consts, distinct}; output = the grouping columns, then one column
//   per value (a missing combination gives the aggregate over no rows: COUNT 0, others NULL). Without grouping
//   columns PIVOT is a scalar aggregate (GROUP BY ()): one row also over an empty input (SUM NULL, COUNT 0).
// - Unpivot({kid, +keep, +cols, +names, schema}): keep number[] (kid columns kept, in order), cols number[] (the
//   unpivoted columns), names string[] (their names as written, the FOR values); output = the kept values, then the
//   value column, then the FOR column (nvarchar), as written in `UNPIVOT (value FOR name IN …)`, one row per non-NULL
//   value; schema in that order.
// - JsonOutput({kid, mode, root, includeNulls, noArray, levels}): mode 'path'|'auto'; root string|null; levels (AUTO)
//   [{name, cols: number[] /* kid.schema indexes */}]. schema one Column `JSON_F52E2B61-18A1-11d1-B105-00805F49916B`,
//   nvarchar(max) with +`json: true` (a Column flag, so compile.js marks a FOR JSON subquery json).
// - XmlOutput({kid, mode, row, root, elements, type, levels, +xmlns}): mode 'raw'|'path'|'auto'|'explicit'; xmlns the
//   statement's WITH XMLNAMESPACES declarations (XmlNs[] | null) written on the root or top-level elements (01 §5.7).
//   schema one Column `XML_F52E2B61-18A1-11d1-B105-00805F49916B`: nvarchar(max), or xml with type. For 'explicit' the
//   constructor parses the universal table's column names (fewer than three columns 6801, the
//   TAGNAME!TAGID!ATTRIBUTENAME[!directive] form 6802, a redeclared tag 6812, an unknown directive 6824, ELEMENTS
//   6825) and keeps the first error as `planError` (SqlError | null) instead of throwing: the planner's binder raises
//   it at plan time (02 §3 phase 5: `if (node.planError) throw node.planError`), and the node raises it when it runs.
// - TryCatch({body, fallback, match, message}): message a string or (err) => string (02 §4.5: the line with the
//   server message), emitted with emitWarn(env, text, 'fallback').
// - Assert({kid, check}): check(row, env, n) runs for every row (n = 1-based row count) and throws to fail the
//   statement; rows pass unchanged.
// - ConstantScan({schema, rows}): rows Row[] (empty = a contradiction: no request at all).
// - TempScan({name, schema}): name as written ('#t', '@t' or a recursive CTE name, above); reads the rows present when
//   the run starts, so a statement never reads rows it inserts itself.
// - TvfScan({def, args, schema, +consts, +withSchema, +opts}): def a functions.js TVF entry or XML_NODES; args Compiled[]
//   evaluated once per run with fn([], env) after their pre (APPLY reads the left row through env.outer); calls
//   def.rows(values, env, limit, argTypes, withSchema ?? opts) (OPENJSON's WITH schema, or XML_NODES's {column,
//   bound, xmlns}) with limit = the rows maxScanRows still allows in the statement, and counts the rows it gets.
// - ApiFnScan({name, args, schema, +msg, +bound, +shape, +prop, +mapRow, +api, +literals}): msg the meta.messages() entry; args
//   Compiled[] in msg.params order; bound {entitySet, id: Compiled | null} | null; shape the 02 §9 response shape of
//   response property prop ('entity' (a), 'audit' (b), 'object' (c), 'array' (d); 'scalar' (e) with prop null) that
//   the planner chose when it built schema; mapRow(json, columns, ctx) is fetchxml.js mapRow (passed in: exec.js
//   cannot import fetchxml.js), used for entity and AuditRecord objects; other columns read their member through
//   Column.srcKey. Requests go through api.fn, count against maxRequests and add stats.requests. server true.
//
// Run-time rules
// - Batches: operators that build rows emit them in batches of at most 2,000 rows (02 §6: 1,000-5,000); loops check
//   env.signal every 10,000 rows. An APPLY's output batches grow from 1 row (first rows fast) by doubling to 2,000
//   (one batch per left row only while a row goal holds it to one left row at a time), so an operator above with a
//   `pre` (an IndexSpool-backed subquery: one keyed fetch per batch) runs a few times, not once per left row. Top and
//   Offset leave the loop over their input before they yield their last rows, so the generators below are closed
//   before the consumer works on those rows.
// - Row goals: a Top (not PERCENT; n once evaluated), an Offset with FETCH (skip + take), collect(node, env,
//   limit) with a finite limit, and a semi/anti APPLY for its right side (1) mark rowGoal on the operators that early
//   stop reaches (markGoalKids: Project, Filter, Assert, Distinct, Unpivot, Top, Offset (goal + skip), Concat, UNION
//   [ALL] and the left side of INTERSECT/EXCEPT, the HashJoin probe side (not for a semi/anti join built on the left),
//   the NestedLoop left side, the RecursiveCte anchor), keeping the smallest goal seen; holding operators stop it.
//   Under a goal: RecursiveCte streams its levels (above); an APPLY runs one left row at a time (goal ≤ 2,000 rows)
//   until it has yielded that many rows; Filter, Project, the HashJoin residual and the antiNullAware residual, when
//   their compiled expressions have a `pre`, process each incoming batch in slices of `goal` rows, then 4 times as
//   many each time (whole batches once a slice reaches 2,000 rows), awaiting pre and yielding per slice, so a
//   correlated subquery under `SELECT TOP 10 … WHERE <client filter>` runs for about 10 outer rows, not a whole
//   5,000-row page (SQL 4 CDS pulls row by row). Without a goal batches are never sliced.
// - A Compiled count (Top, Offset) and the arguments of TvfScan and ApiFnScan are evaluated as fn([], env) after
//   pre([[]], env): one empty row, so a `pre` that works per row and one that runs once both evaluate the
//   subquery. A count of NULL raises 1060 (TOP, FETCH) or 10743 (OFFSET), a count that is not a whole number raises
//   the same numbers (1060/10743), and so does a count whose static type is not an integer type (int, bigint, bit)
//   or a string, as SQL Server types it (decimal, float and money are accepted only with PERCENT; a sql_variant by
//   its base type); a string count is converted with types.coerce to bigint (float for PERCENT); a PERCENT outside
//   0..100, also a negative one, raises 1031.
// - Hash keys (HashJoin, IndexSpool, RecursiveCte seek): both sides are hashed in types.commonType of the key pair
//   (the left key's type when commonType raises), with ai = the pair's COLLATE (key.coll) or true when either key is
//   ci_ai (01 §5.2). Distinct, SetOp, HashAggregate, Pivot and the FOR JSON/XML AUTO levels hash NULLs as equal;
//   the AUTO levels use rowKey's {xmlText: true}, so xml columns group by their text.
// - HashJoin: when no build row has a key without a NULL part (also an empty build side), inner and semi joins return
//   without reading the probe side, and a preserved build side (LEFT or anti built on the left, RIGHT built on the
//   right) is emitted, NULL-extended, without reading it either (the FetchScan is not run). A residual with a
//   `pre` is evaluated per probe slice (pre over the slice's candidate joined rows, then fn over those same row
//   objects); a residual without `pre` is evaluated on one reused row and only a pair it accepts becomes an output
//   row. antiNullAware reads its right (subquery) side fully, whatever `build` says, and then streams the left rows;
//   with a residual, a probe row's group is the rows of its correlation group (or the whole right side) for which the
//   residual is true, and a residual `pre` sees exactly the joined rows its fn then reads (compile.js keys the memo of
//   a subquery with NEWID() by row identity). The build, probe-key and residual loops check env.signal every 10,000
//   rows.
// - NestedLoop without apply returns at once when its materialised right side is empty and the kind is inner, cross or
//   semi (the left side is not read).
// - Window: aggregates with OVER run init/step/result per row frame, incrementally when every frame starts at the same
//   row and the frame ends never move back (UNBOUNDED PRECEDING … CURRENT ROW / n FOLLOWING, the whole partition) and,
//   for aggregates that are not `orderable`, backwards when every frame ends at the same row. Sliding frames (both
//   ends move forward, ROWS BETWEEN n PRECEDING AND m FOLLOWING) wider than 64 rows use the two-stacks queue over the
//   aggregate's merge (O(N) instead of O(N × width); a float SUM or VAR may then differ from a row-by-row sum in the
//   last bits, as SQL Server's own modes do); narrower frames are evaluated row by row. A frame without an end bound
//   ends at CURRENT ROW; RANGE with n PRECEDING/FOLLOWING raises 4194 (a parse-time error the parser raises first).
//   The rows of consecutive partitions share output batches. The loops check env.signal every 10,000 rows stepped,
//   and after every 100,000 units of work (rows × (1 + functions)) Window lets the event loop run between partitions
//   (a scheduler task, else a timer), so the page stays responsive and a Stop reaches the run.
// - FOR JSON AUTO and FOR XML AUTO with an empty `levels` (no table source) raise 13600 and 6800 when they run (the
//   planner raises them at plan time first, 02 §3 phase 5).
// - FOR JSON (01 §5.6): an input without rows gives one row holding NULL (as FOR XML, 01 §5.7; also with ROOT). PATH: a
//   nested object whose properties are all NULL is left out (without INCLUDE_NULL_VALUES), the top-level object of a
//   row is always written ('{}'); names and path steps compare case-insensitively (SQL identifiers), the key keeps the
//   spelling of the first column that opened it. An unnamed visible column raises `Column expressions and data sources
//   without names or aliases cannot be formatted as JSON text using FOR JSON clause. Add alias to the unnamed column or
//   table.` and a name conflict `Property '<name>' cannot be generated in JSON output due to a conflict with another
//   column name or alias. Use different names and aliases for each column in SELECT list.` (the 01 §5.6 texts; their
//   SQL Server numbers 13605 and 13601 are not in messages.js, so they are raised without a number). AUTO: a level's nested array follows the level's own keys; a key equal to the nested level's
//   name is a conflict.
// - FOR XML values (01 §5.7): float as CONVERT style 2 (`1.500000000000000e+000`, SQL Server's FOR XML float form;
//   01 §5.7 says only "toSqlString"), money with 4 decimals (as FOR JSON), date/time and binary as types.jsonValue
//   writes them without the quotes. Every value goes through xmlEsc, so a character XML 1.0 cannot represent raises
//   xml.js's `Invalid XML: …` (SQL Server writes `&#x01;`). Names: RAW, AUTO and EXPLICIT encode
//   names (`_xHHHH_`, and `_x005F_` for a `_` that starts an `_xHHHH_` sequence, as SQL Server); PATH checks them
//   and raises 6850 with the character and its code as SQL Server writes it (`' '(0x0020)`). A `p:name` is kept only
//   when WITH XMLNAMESPACES declares p (RAW/AUTO/EXPLICIT otherwise encode the ':', PATH raises 6850). Element and
//   attribute names compare case-insensitively for 6810. PATH opens its nested elements by column adjacency (a column
//   with another path closes them, also when it is NULL) and writes an element only when something is written into
//   it; 6852 and 6864 are checked from the column names before any row. With ROOT the xmlns:xsi declaration of
//   ELEMENTS XSINIL goes on the root element (as the WITH XMLNAMESPACES declarations); without ROOT on each
//   top-level element. RAW and AUTO write an xml-typed column (also unnamed) as content; with ELEMENTS it is the
//   content of an element named by the column. EXPLICIT: the `cdata` directive with an AttributeName raises
//   `FOR XML EXPLICIT: the cdata directive in column '<name>' needs an empty attribute name.` and a non-string cdata
//   value `FOR XML EXPLICIT: the cdata directive in column '<name>' needs a string value.` (no SQL Server number
//   recorded); Tag and Parent are read as numbers (a sql_variant by its base value). TYPE re-serialises the text
//   with types.xmlValue(text, {preserveSpace: true}).
// - TryCatch: body rows beyond 50,000 count as a matching error, a SqlError `The result has more than 50,000 rows.`
//   (code 'FALLBACK') passed to message(err); an abort is never caught. On a fallback the body's maxScanRows tally is
//   taken back out of the statement counter (Statement counters above) and the fallback's rows stream, counted.
// - Into: before reading, a visible column without a name raises 1038 and two with one name (case-insensitive) 2705
//   (the binder checks first). The temp table's columns are {name, dt, prec?, scale?, len?, unicode?, fixed?, dto?,
//   small?, numeric?, nullable: true, coll?, dataType (types.dataTypeOf), ref?} (ref only a plain {entity[, pid]}
//   lineage; coll the source column's COLLATE collation, so the #temp column keeps it, as in SQL Server)
//   and its rows hold the visible values (new arrays). Into does not emit the session's `temps` event: the session
//   emits it after the statement.
// - TempScan: an unknown '#t' raises 208 and an undeclared '@t' 1087.
// - ApiFnScan: parameters by msg.params type (meta.js vocabulary): Guid as a typed literal through guidParam (api.js's
//   export: Dataverse refuses a Guid parameter sent as a string literal, 'The value of the parameter … has the wrong
//   type.'), EntityReference and table types as `{'@odata.id': '<set>(<id>)'}` (the set from env.meta.findEntity;
//   without it `{'@odata.type': 'Microsoft.Dynamics.CRM.<t>', '<pk>': id}`) from the argument's ref lineage
//   ({entity}, or {entityFn} evaluated), Boolean as true/false, numbers, String (toSqlString), DateTime (a Date
//   instant; a date or string argument converts as CAST(… AS datetime), in the session time zone), Date (Edm.Date: the
//   unquoted URL literal yyyy-MM-dd through dateParam, the date of the value as CAST(… AS date)), StringArray and T[]
//   as arrays (several trailing arguments, a JSON array text or one value), enum types through enumParam, other
//   complex types from a JSON object text; argument text that is not valid JSON raises `The argument for parameter
//   <p> of <fn> is not valid JSON: <reason>.` (a SqlError without number, so TRY/CATCH sees it). guidParam, enumParam
//   and dateParam come from the `literals` option, else env.literals, else members of the api object (+literals =
//   {guidParam, enumParam, dateParam}, api.js's exports, which engine/ cannot import, 00 §3; see above).
//   Without the one a parameter needs, the call is the internal error `Internal error: <fn> needs api.js's <factory> to
//   send its <type> parameter <p> (env.literals is not set).` and nothing is sent (a string literal would be refused by
//   Dataverse). Answer date-times are parsed with types.parseDate in env.tz: with Z or an offset an instant (a
//   datetimeoffset column keeps the offset), without one session-tz wall-clock time (01 §5.3), never the browser's
//   zone. A NULL optional parameter is left out; a NULL bound id gives no rows. Shape (b) follows PagingInfo
//   (PageNumber + 1, Count = the first page's size, PagingCookie) while MoreRecords is true when the statement did
//   not pass PagingInfo itself, and yields each page's rows before it requests the next one. prop '' means the
//   whole answer (meta.js responseEntity). mapRow gets env as its ctx. oldvalues and newvalues are the JSON of
//   OldValue/NewValue keyed by logical name (`_x_value` -> x; annotations, @odata.type and null members left out, as
//   the SDK entity SQL 4 CDS serialises has no null attributes). Another array or object property of the answer adds
//   the warning `<name> also returned <props>; run EXEC <name> to see every result.`

import { SqlError } from './lexer.js';
import { msg } from './messages.js';
import {
  commonType, keyOf, rowKey, sortKey, cmpKeys, coerce, castValue, dataTypeOf, toSqlString, jsonValue, jsonEscape,
  xmlValue, xmlDoc, variantValue, variantType, toHex, typeName, parseDate,
} from './types.js';
import { runWindow } from './functions.js';
import { shiftSchema } from './compile.js';
import { xmlEsc } from '../core/xml.js';

const DEFAULT_SCAN_ROWS = 500000;
const DEFAULT_REQUESTS = 500;
const COUNTS = { key: 'statement counters' };
const BATCH = 2000;
const TICK = 10000;
const SEEK_INDEX_KEYS = 5000;
const SLIDE_WIDTH = 64;
const TRY_CAP = 50000;
const MEMO_KEYS = 10000;
const MEMO_ROWS = 50000;
const YIELD_WORK = 100000;
const EMPTY = Object.freeze([]);
const ONE_ROW = Object.freeze([EMPTY]);

// ------------------------------------------------------------------------------------------------ helpers

// A numbered SqlError with the messages.js text, severity and state 1.
function sqlErr(number, ...args) {
  const m = msg(number, ...args);
  const e = new SqlError(m.message);
  e.number = m.number;
  e.severity = m.severity;
  e.state = 1;
  return e;
}

// An unnumbered SqlError (SQL Studio's own text, or a SQL Server text without a messages.js row), severity 16.
function plainErr(message, code) {
  const e = new SqlError(message);
  e.severity = 16;
  e.state = 1;
  if (code) e.code = code;
  return e;
}

// An unnumbered limit error (02 §4.4), code 'LIMIT'.
function limitErr(message) {
  return plainErr(message, 'LIMIT');
}

// Integer with ',' thousands separators (en-US), without Intl.
const digits = n => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// A setting of the statement (env.settings, else env.session.settings), else its default.
function setting(env, key, def) {
  const s = env && (env.settings || (env.session && env.session.settings));
  const v = s ? s[key] : undefined;
  return typeof v === 'number' && v > 0 ? v : def;
}

const isCompiled = c => !!c && typeof c === 'object' && typeof c.fn === 'function';
const textOf = c => (c == null ? '' : typeof c === 'object' ? String(c.text ?? '') : String(c));
const listText = cs => (cs || []).map(textOf).join(', ');
const keyText = k => textOf(k) + (k && k.desc ? ' DESC' : ' ASC');
const prop = (name, value) => ({ name, value: String(value) });
const colLabel = c => (c.name ? (c.qual ? c.qual + '.' + c.name : c.name) : '(No column name)');
const visible = schema => schema.filter(c => !c.hidden);
const visibleNames = schema => visible(schema).map(colLabel).join(', ');
const visibleIndexes = schema => schema.reduce((a, c, i) => (c.hidden ? a : (a.push(i), a)), []);

// The subquery plans inside compiled expressions (their `plans` fields), in order, for explain().
function plansOf(...items) {
  const out = [];
  const add = x => {
    if (Array.isArray(x)) { for (const y of x) add(y); return; }
    if (x && typeof x === 'object' && Array.isArray(x.plans)) for (const p of x.plans) out.push(p);
  };
  for (const x of items) add(x);
  return out;
}

function need(cond, what) {
  if (!cond) throw new TypeError(what);
}

function oneOf(value, values, what) {
  need(values.includes(value), `${what} must be one of ${values.join(', ')}; got ${String(value)}`);
  return value;
}

function isNode(x) {
  return x instanceof PlanNode;
}

// The common options of every operator (see the notes above), merged with the operator's own base fields.
function base(op, o, kids, schema, server = false) {
  return { op, kids, schema, server, detail: o.detail, props: o.props, warnings: o.warnings, est: o.est };
}

// ---------------------------------------------------------------------------------- run-time helpers

function checkSignal(env) {
  const s = env && env.signal;
  if (s) s.throwIfAborted();
}

// Lets the event loop run between long synchronous passes (a Stop click can then reach env.signal): a scheduler task
// where the browser has one (Edge; not clamped like nested timers), else a timer task.
const macrotask = () => new Promise(resolve => {
  const s = globalThis.scheduler;
  if (s && typeof s.postTask === 'function') s.postTask(resolve, { priority: 'user-visible' });
  else setTimeout(resolve, 0);
});

// Marks the row goal of a node and of the inputs early stop reaches from it (see the notes above, Row goals): rowGoal =
// the fewest rows a consumer above may need, the smallest goal seen.
function markGoal(node, n) {
  if (!node || !(n > 0)) return;
  const g = node.rowGoal;
  if (g > 0 && g <= n) return;
  node.rowGoal = n;
  node.markGoalKids(n);
}

// The slicer of an operator that awaits a `pre` per batch (see the notes above, Row goals): without a row goal (or a pre)
// whole batches; under one, slices of `goal` rows, then 4 times as many each time, whole batches from BATCH rows on.
// end(start, length) -> the end of the slice that starts at `start`.
function slicer(goal, pre) {
  let size = goal > 0 && pre ? Math.max(1, Math.min(goal, BATCH)) : Infinity;
  return (s, n) => {
    if (size === Infinity) return n;
    const e = Math.min(n, s + size);
    size = size * 4 >= BATCH ? Infinity : size * 4;
    return e;
  };
}

// Whether any compiled expression of a list has a `pre`.
const anyPre = cs => !!cs && cs.some(c => c && c.pre);

// Awaits the `pre` of a compiled expression (01 §7) for a batch.
async function preOf(c, rows, env) {
  if (c && c.pre) await c.pre(rows, env);
}

// Awaits the `pre` of every compiled expression of a list for a batch.
async function preList(cs, rows, env) {
  if (!cs) return;
  for (let i = 0; i < cs.length; i++) if (cs[i] && cs[i].pre) await cs[i].pre(rows, env);
}

// The comparison flavour of a key or column: its COLLATE, else true for ci_ai (01 §5.2).
const aiOf = c => (c && c.coll) || (c && c.ci_ai ? true : undefined);

// The comparison flavour of a hashed key pair: either side's COLLATE, else true when either side is ci_ai.
const pairAi = (a, b) => (a && a.coll) || (b && b.coll) || ((a && a.ci_ai) || (b && b.ci_ai) ? true : undefined);

// The type a key pair is hashed in: their common type, else the left key's type.
function pairType(a, b) {
  try {
    return commonType(a, b);
  } catch {
    return a;
  }
}

function hasNull(vals) {
  for (let i = 0; i < vals.length; i++) if (vals[i] == null) return true;
  return false;
}

const NUMERIC_DT = new Set(['bit', 'int', 'bigint', 'decimal', 'money', 'float']);
const sameFamily = (a, b) => !a || !b || a.dt === b.dt || a.dt === 'any' || a.dt === 'null' || b.dt === 'any' ||
  (NUMERIC_DT.has(a.dt) && NUMERIC_DT.has(b.dt)) || (a.dt === 'date' && b.dt === 'datetime') || (a.dt === 'datetime' && b.dt === 'date');

// A function from a tuple of values to its hash key (types.keyOf per part; NULLs equal as '\u0000').
// With `from` (the static types of the values), a value of another type family is first converted to the hashed type,
// as SQL Server compares them (a string compared with a datetime converts to datetime: 241 when it is not a date).
function tupleKeyer(types, ais, from = null, opts = undefined) {
  const n = types.length;
  const conv = types.map((t, i) => (from && !sameFamily(from[i], t) ? v => (v == null ? v : coerce(v, from[i], t, opts)) : null));
  if (n === 1) {
    const t = types[0], a = ais[0], c = conv[0];
    return c ? vals => keyOf(c(vals[0]), t, a) : vals => keyOf(vals[0], t, a);
  }
  const parts = new Array(n);
  return vals => {
    for (let i = 0; i < n; i++) parts[i] = keyOf(conv[i] ? conv[i](vals[i]) : vals[i], types[i], ais[i]);
    return JSON.stringify(parts);
  };
}

// A function from a row to the hash key of its values at idxs (NULLs equal).
function rowKeyer(idxs, types, ais) {
  const n = idxs.length;
  if (n === 0) return () => '';
  if (n === 1) {
    const i0 = idxs[0], t = types[0], a = ais[0];
    return row => keyOf(row[i0], t, a);
  }
  const parts = new Array(n);
  return row => {
    for (let i = 0; i < n; i++) parts[i] = keyOf(row[idxs[i]], types[i], ais[i]);
    return JSON.stringify(parts);
  };
}

const OBJ_IDS = new WeakMap();
let objSeq = 0;

// The exact-identity key of a value (01 §7 memo keys, as compile.js): strings verbatim, numbers by value, Dates by
// getTime(), tk and own tzo, binary by its hex, a sql_variant by base type and value, NULL as its own tag, any other
// object by identity.
function identityKey(v) {
  if (v === null || v === undefined) return '\u0000';
  switch (typeof v) {
    case 'string': return 's' + v;
    case 'number': return 'n' + (v === 0 ? '0' : String(v));
    case 'boolean': return v ? 'b1' : 'b0';
    case 'bigint': return 'i' + String(v);
    default: break;
  }
  if (v instanceof Date) return 'd' + v.getTime() + '.' + (v.tk || 0) + (v.tzo != null ? '@' + v.tzo : '');
  if (v instanceof Uint8Array) return 'x' + toHex(v, false);
  const base = variantValue(v);
  if (base !== v) return 'v' + typeName(variantType(v)) + ':' + identityKey(base);
  let id = OBJ_IDS.get(v);
  if (id === undefined) OBJ_IDS.set(v, (id = ++objSeq));
  return 'o' + id;
}

// A function from a row to the exact-identity key of its values at idxs ('' for none).
function identityKeyer(idxs) {
  if (!idxs.length) return () => '';
  if (idxs.length === 1) {
    const i0 = idxs[0];
    return row => identityKey(row[i0]);
  }
  return row => {
    let s = '';
    for (let i = 0; i < idxs.length; i++) {
      const k = identityKey(row[idxs[i]]);
      s += k.length + ':' + k;
    }
    return s;
  };
}

// Evaluates compiled expressions over a row into vals (reused).
function evalInto(cs, row, env, vals) {
  for (let i = 0; i < cs.length; i++) vals[i] = cs[i].fn(row, env);
  return vals;
}

// Batches of at most BATCH rows of an array (the array itself when it is small enough).
function* chunks(rows) {
  if (!rows.length) return;
  if (rows.length <= BATCH) { yield rows; return; }
  for (let i = 0; i < rows.length; i += BATCH) yield rows.slice(i, i + BATCH);
}

// The concatenation of two rows (a join output row).
function joinRow(a, b) {
  const na = a.length, nb = b.length;
  const r = new Array(na + nb);
  for (let i = 0; i < na; i++) r[i] = a[i];
  for (let i = 0; i < nb; i++) r[na + i] = b[i];
  return r;
}

const nullRow = n => new Array(n).fill(null);

// A Key[] comparator over decorated rows {k: sort keys, i: input position}: types.cmpKeys per key, DESC flips,
// stable by position.
function decoratedCmp(keys) {
  const n = keys.length, ais = keys.map(aiOf), dir = keys.map(k => (k.desc ? -1 : 1));
  return (a, b) => {
    for (let j = 0; j < n; j++) {
      const c = cmpKeys(a.k[j], b.k[j], keys[j], ais[j]);
      if (c) return c * dir[j];
    }
    return a.i - b.i;
  };
}

// The sort keys of a row for Key[] (types.sortKey; computed once per row).
function sortKeysOf(keys, ais, row, env) {
  const k = new Array(keys.length);
  for (let j = 0; j < keys.length; j++) k[j] = sortKey(keys[j].fn(row, env), keys[j], ais[j]);
  return k;
}

// Whether two sort-key tuples are equal on every key (cmp equality; NULLs equal).
function sameKeys(keys, ais, a, b) {
  for (let j = 0; j < keys.length; j++) if (cmpKeys(a[j], b[j], keys[j], ais[j]) !== 0) return false;
  return true;
}

const TYPE_FIELDS = ['dt', 'prec', 'scale', 'len', 'unicode', 'fixed', 'dto', 'small'];

// Whether a value of type a needs a conversion to type b (any static type field differs).
function differs(a, b) {
  for (const f of TYPE_FIELDS) {
    const x = a[f] ?? null, y = b[f] ?? null;
    if (x !== y && !((f === 'unicode' || f === 'fixed' || f === 'dto' || f === 'small') && !x && !y)) return true;
  }
  return false;
}

// Per output column: a converter from the source column's type to the target column's, or null.
function converters(src, idxs, target) {
  return idxs.map((i, j) => (differs(src[i], target[j]) ? { from: src[i], to: target[j] } : null));
}

// The source row's values at idxs, converted with types.coerce where the types differ.
function convertRow(row, idxs, convs, env) {
  const n = idxs.length, out = new Array(n);
  for (let j = 0; j < n; j++) {
    const v = row[idxs[j]], c = convs[j];
    out[j] = c && v != null ? coerce(v, c.from, c.to, env) : v;
  }
  return out;
}

// The dop of the statement: env.api.dop, else 4.
const dopOf = env => {
  const d = env && env.api && env.api.dop;
  return typeof d === 'number' && d >= 1 ? Math.floor(d) : 4;
};

// env.scanArgs with an entry for `scan`, kept and extended when one is there.
function withScanArgs(env, scan, entry) {
  const map = new Map(env.scanArgs || []);
  const cur = map.get(scan);
  if (cur && entry.conds && !entry.rows) map.set(scan, { ...cur, conds: [...(cur.conds || []), ...entry.conds] });
  else map.set(scan, entry);
  return map;
}

const COUNT_TYPES = new Set(['int', 'bigint', 'bit', 'string']);
const PERCENT_TYPES = new Set(['decimal', 'float', 'money']);

// A row count of Top or Offset (see the notes above): a number or a Compiled evaluated once.
async function countValue(c, env, kind) {
  let v = c, t = null;
  if (isCompiled(c)) {
    await preOf(c, ONE_ROW, env);
    v = c.fn(EMPTY, env);
    t = c;
  }
  const notInt = () => sqlErr(kind === 'offset' ? 10743 : 1060);
  if (v == null) throw notInt();
  if (t && (t.dt === 'any' || t.dt === 'null')) { t = variantType(v); v = variantValue(v); if (v == null) throw notInt(); }
  // SQL Server types the count: an integer type (or a string, converted); decimal, float and money only for PERCENT
  if (t && !COUNT_TYPES.has(t.dt) && !(kind === 'percent' && PERCENT_TYPES.has(t.dt))) throw notInt();
  if (typeof v === 'string') v = coerce(v, t || { dt: 'string' }, { dt: kind === 'percent' ? 'float' : 'bigint' }, env);
  if (typeof v === 'boolean') v = v ? 1 : 0;
  const n = Number(v);
  if (kind === 'percent') {
    if (!(n >= 0 && n <= 100)) throw sqlErr(1031);
    return n;
  }
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw notInt();
  if (kind === 'offset' && n < 0) throw sqlErr(10742);
  if (kind === 'fetch' && n <= 0) throw sqlErr(10744);
  if (kind === 'top' && n < 0) throw sqlErr(127);
  return n;
}

// CEILING(n / 100 × count), robust to the binary error of the product (0.1 × 30 is 3, not 4).
function percentRows(n, count) {
  const x = (n * count) / 100;
  let r = Math.ceil(x);
  if (r - x > 1 - 1e-9) r--;
  return Math.min(Math.max(r, 0), count);
}

// -------------------------------------------------------------------------------------- PlanNode

// Base class of every plan operator (02 §6): fields, the run() wrapper, explain() and prepare().
export class PlanNode {
  constructor(o = {}) {
    this.op = o.op || 'PlanNode';
    this.kids = o.kids ? o.kids.slice() : [];
    this.schema = o.schema || [];
    this.stats = { rows: 0, ms: 0, requests: 0, calls: 0 };
    this.server = o.server === undefined ? false : o.server;
    this.script = !!o.script;
    this.warnings = o.warnings ? o.warnings.slice() : [];
    this.plans = [];
    this.est = typeof o.est === 'number' ? o.est : null;
    this.detailText = typeof o.detail === 'string' ? o.detail : null;
    this.extraProps = o.props ? o.props.map(p => prop(p.name, p.value)) : [];
    this.rowGoal = 0;
    for (const k of this.kids) need(isNode(k), `${this.op}: every input must be a PlanNode`);
  }

  // True when every row the node yields is already counted against maxScanRows, by the node or below it (see the notes above,
  // Statement counters); a consumer that holds or drops rows counts them only when this is false.
  rowsCounted() {
    return false;
  }

  // Passes a row goal to the inputs that early stop reaches from this node (see the notes above, Row goals).
  markGoalKids() {}

  // True when one run of the node may send Dataverse requests (a server node, not behind a Spool, in its subtree or
  // in the plans of its expressions): APPLY then runs several right-side executions at once (see the notes above).
  ioPerRun() {
    return this.server === true || this.kids.some(k => k.ioPerRun()) || this.plans.some(p => p && typeof p.ioPerRun === 'function' && p.ioPerRun());
  }

  // Runs the node: yields its non-empty Row[] batches and keeps stats (see the notes above).
  async *run(env) {
    const st = this.stats;
    st.calls++;
    // the statement state lives in env.subq; creating it here, before any operator derives an env from this one,
    // makes every derived env ({...env, outer}) share it
    if (env && !env.subq) env.subq = new Map();
    const signal = env && env.signal;
    if (signal) signal.throwIfAborted();
    let t = performance.now();
    try {
      for await (const batch of this.execute(env)) {
        if (signal) signal.throwIfAborted();
        if (!batch || !batch.length) continue;
        st.rows += batch.length;
        st.ms += performance.now() - t;
        t = -1;
        yield batch;
        t = performance.now();
      }
      // a run cancelled inside a synchronous loop that ended without another batch is a cancel, never a complete result
      if (signal) signal.throwIfAborted();
    } finally {
      if (t >= 0) st.ms += performance.now() - t;
    }
  }

  // The operator's own batches; subclasses implement it (a pseudo-node cannot run).
  async *execute() {
    throw new Error(`${this.op} cannot run`);
  }

  // The default explain detail of the operator.
  detail() {
    return '';
  }

  // The operator's own options for the Plan properties panel.
  props() {
    return [];
  }

  // The ExplainNode of this node and its subtree (02 §6).
  explain() {
    const st = this.stats;
    const props = [...this.props(), ...this.extraProps];
    if (this.est != null) props.push(prop('Estimated rows', this.est));
    const node = {
      op: this.op,
      detail: this.detailText ?? this.detail(),
      server: this.server,
      warnings: this.warnings.slice(),
      stats: st.calls ? { rows: st.rows, ms: st.ms, requests: st.requests, calls: st.calls } : null,
      kids: [...this.kids, ...this.plans].map(k => k.explain()),
      props,
    };
    if (this.script) node.script = true;
    return node;
  }

  // Prepares the subtree for a batch of outer rows of a correlated driver (see the notes above).
  async prepare(outerRows, env) {
    for (const k of this.kids) await k.prepare(outerRows, env);
  }
}

// ------------------------------------------------------------------------------- shared run-time helpers

// Every row of a plan, or its first `limit` rows; stopping early closes the plan's generators.
export async function collect(node, env, limit = Infinity) {
  const out = [];
  if (!(limit > 0)) return out;
  if (limit !== Infinity) markGoal(node, limit);
  for await (const batch of node.run(env)) {
    for (let i = 0; i < batch.length; i++) {
      out.push(batch[i]);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// The statement's operator state map (env.subq), created when the env has none.
export function stateOf(env) {
  if (!env.subq) env.subq = new Map();
  return env.subq;
}

function counters(env) {
  const s = stateOf(env);
  let c = s.get(COUNTS);
  if (!c) s.set(COUNTS, (c = { rows: 0, requests: 0 }));
  return c;
}

// Counts rows read for client-side processing; raises the maxScanRows error beyond the limit (02 §4.4).
export function countRows(env, n) {
  const c = counters(env);
  c.rows += n;
  for (let t = env && env.tally; t; t = t.up) t.rows += n;
  if (c.rows > setting(env, 'maxScanRows', DEFAULT_SCAN_ROWS)) throw scanLimitErr(env);
}

// The maxScanRows error of the statement (02 §4.4).
function scanLimitErr(env) {
  const limit = setting(env, 'maxScanRows', DEFAULT_SCAN_ROWS);
  return limitErr(`The query read more than ${digits(limit)} rows to process in the browser. Add a filter or raise the limit in Settings.`);
}

// The rows still allowed by maxScanRows in the statement (TvfScan's limit).
function rowsLeft(env) {
  return Math.max(0, setting(env, 'maxScanRows', DEFAULT_SCAN_ROWS) - counters(env).rows);
}

// Takes the rows a TryCatch body counted back out of the statement counter and every enclosing body's tally.
function uncount(env, tally) {
  const n = tally.rows;
  if (!n) return;
  counters(env).rows -= n;
  for (let t = tally.up; t; t = t.up) t.rows -= n;
  tally.rows = 0;
}

// Counts Dataverse requests of the statement; raises the maxRequests error beyond the limit (02 §4.4).
export function countRequests(env, n = 1) {
  const c = counters(env);
  c.requests += n;
  const limit = setting(env, 'maxRequests', DEFAULT_REQUESTS);
  if (c.requests > limit) {
    throw limitErr(`The statement sent more than ${digits(limit)} requests to Dataverse (setting Max requests per statement). Add a filter or raise the limit in Settings.`);
  }
}

// Adds a Messages 'info' line through env.info when the env has it.
export function emitInfo(env, text) {
  if (env && typeof env.info === 'function') env.info(text);
}

// Adds a Messages warning (and a resultdone warning of `kind`) through env.warn when the env has it.
export function emitWarn(env, text, kind) {
  if (env && typeof env.warn === 'function') {
    if (kind) env.warn(text, kind);
    else env.warn(text);
  }
}

// The explain tree of a plan and the FetchXML texts of its nodes in pre-order; sets each node's fetchIndex.
export function explainPlan(node) {
  const plan = node.explain();
  const fetchXml = [];
  const stack = [plan];
  while (stack.length) {
    const n = stack.pop();
    if (n.fetchXml != null) {
      n.fetchIndex = fetchXml.length;
      if (Array.isArray(n.fetchXml)) fetchXml.push(...n.fetchXml);
      else fetchXml.push(n.fetchXml);
    }
    for (let i = n.kids.length - 1; i >= 0; i--) stack.push(n.kids[i]);
  }
  return { plan, fetchXml };
}

// An ExplainNode for a pseudo-node that is not a PlanNode (02 §9 Write, Conditional, Then, …; server null).
export function explainNode(op, detail = '', kids = [], { script = false, warnings = [], props = [] } = {}) {
  const node = { op, detail, server: null, warnings: warnings.slice(), stats: null, kids: kids.slice(), props: props.map(p => prop(p.name, p.value)) };
  if (script) node.script = true;
  return node;
}

// -------------------------------------------------------------------------------------- operators

const HASH_KINDS = ['inner', 'left', 'right', 'full', 'semi', 'anti', 'antiNullAware'];
const LOOP_KINDS = ['inner', 'left', 'right', 'full', 'cross', 'semi', 'anti'];
const APPLY_KINDS = ['inner', 'cross', 'left', 'semi', 'anti'];
const leftOnly = kind => kind === 'semi' || kind === 'anti' || kind === 'antiNullAware';
const joinSchema = (kind, left, right) => (leftOnly(kind) ? left.schema : [...left.schema, ...shiftSchema(right.schema, left.schema.length)]);
const countText = n => (isCompiled(n) ? textOf(n) : n == null ? '' : String(n));

// Rows of kid for which pred is true.
export class Filter extends PlanNode {
  constructor(o) {
    need(isNode(o.kid) && isCompiled(o.pred), 'Filter({kid, pred})');
    super(base('Filter', o, [o.kid], o.kid.schema));
    this.kid = o.kid;
    this.pred = o.pred;
    this.plans = plansOf(o.pred);
  }

  detail() { return textOf(this.pred); }
  props() { return [prop('Predicate', textOf(this.pred))]; }
  rowsCounted() { return this.kid.rowsCounted(); }
  markGoalKids(n) { markGoal(this.kid, n); }

  async *execute(env) {
    const pred = this.pred, fn = pred.fn, cin = !this.kid.rowsCounted();
    const end = slicer(this.rowGoal, pred.pre);
    for await (const whole of this.kid.run(env)) {
      for (let s = 0; s < whole.length;) {
        const e = end(s, whole.length);
        const batch = s === 0 && e === whole.length ? whole : whole.slice(s, e);
        s = e;
        await preOf(pred, batch, env);
        const out = [];
        let tick = 0;
        for (let i = 0; i < batch.length; i++) {
          if (++tick === TICK) { tick = 0; checkSignal(env); }
          if (fn(batch[i], env) === true) out.push(batch[i]);
        }
        if (cin && out.length < batch.length) countRows(env, batch.length - out.length);
        if (out.length) yield out.length === batch.length ? batch : out;
      }
    }
  }
}

// The value getter of a Project `extra` entry: an input index, or a per-row function (see the notes above).
function extraGetter(x) {
  if (typeof x === 'number') return null;
  if (typeof x === 'function') return x;
  if (x && typeof x.fn === 'function') return (row, env) => x.fn(row, env);
  if (x && typeof x.entityFn === 'function') return (row, env) => x.entityFn(row, env);
  throw new TypeError('Project: an extra entry is an input index, a function, {fn} or {entityFn}');
}

// The select list: one value per compiled expression, then the hidden companions at `extra`.
export class Project extends PlanNode {
  constructor(o) {
    need(isNode(o.kid) && Array.isArray(o.exprs) && Array.isArray(o.schema), 'Project({kid, exprs, schema})');
    const extra = o.extra || [];
    need(o.schema.length === o.exprs.length + extra.length, 'Project: schema must have one column per expression and per extra index');
    const getters = extra.map(extraGetter);
    super(base('Project', o, [o.kid], o.schema));
    this.kid = o.kid;
    this.exprs = o.exprs;
    this.extra = extra;
    this.getters = getters;
    this.plans = plansOf(o.exprs);
  }

  detail() { return visibleNames(this.schema); }
  props() {
    const hidden = this.schema.filter(c => c.hidden).map(colLabel);
    const out = [prop('Columns', visibleNames(this.schema))];
    if (hidden.length) out.push(prop('Hidden columns', hidden.join(', ')));
    return out;
  }

  rowsCounted() { return this.kid.rowsCounted(); }
  markGoalKids(n) { markGoal(this.kid, n); }

  async *execute(env) {
    const exprs = this.exprs, ne = exprs.length, extra = this.extra, nx = extra.length, w = ne + nx;
    const fns = exprs.map(e => e.fn);
    const getters = this.getters;
    const end = slicer(this.rowGoal, anyPre(exprs));
    for await (const whole of this.kid.run(env)) {
      for (let s = 0; s < whole.length;) {
        const e = end(s, whole.length);
        const batch = s === 0 && e === whole.length ? whole : whole.slice(s, e);
        s = e;
        await preList(exprs, batch, env);
        const out = new Array(batch.length);
        let tick = 0;
        for (let i = 0; i < batch.length; i++) {
          if (++tick === TICK) { tick = 0; checkSignal(env); }
          const row = batch[i], r = new Array(w);
          for (let j = 0; j < ne; j++) r[j] = fns[j](row, env);
          for (let j = 0; j < nx; j++) r[ne + j] = getters[j] ? getters[j](row, env) : row[extra[j]];
          out[i] = r;
        }
        yield out;
      }
    }
  }
}

// The build side of a HashJoin without an explicit one (02 §6: the smaller side when both estimates are known; else
// the right side, the left one for a RIGHT join, so the preserved side streams). antiNullAware always reads its
// subquery side first, so the estimate does not change it.
function defaultBuild(kind, left, right) {
  const l = left.est, r = right.est;
  if (kind !== 'antiNullAware' && typeof l === 'number' && typeof r === 'number' && l !== r) return l < r ? 'left' : 'right';
  return kind === 'right' ? 'left' : 'right';
}

// Hash join of every kind of 02 §6, incl. the correlated antiNullAware join.
export class HashJoin extends PlanNode {
  constructor(o) {
    oneOf(o.kind, HASH_KINDS, 'HashJoin kind');
    need(isNode(o.left) && isNode(o.right), 'HashJoin({left, right})');
    need(Array.isArray(o.lkeys) && Array.isArray(o.rkeys) && o.lkeys.length === o.rkeys.length && o.lkeys.length > 0,
      'HashJoin: lkeys and rkeys must be non-empty lists of the same length');
    const lcorr = o.lcorr || null, rcorr = o.rcorr || null;
    need(!lcorr === !rcorr && (!lcorr || (o.kind === 'antiNullAware' && lcorr.length === rcorr.length && lcorr.length > 0)),
      'HashJoin: lcorr and rcorr are lists of the same length, for antiNullAware only');
    const build = o.build || defaultBuild(o.kind, o.left, o.right);
    oneOf(build, ['left', 'right'], 'HashJoin build');
    super(base('HashJoin', o, [o.left, o.right], o.schema || joinSchema(o.kind, o.left, o.right)));
    this.kind = o.kind;
    this.left = o.left;
    this.right = o.right;
    this.lkeys = o.lkeys;
    this.rkeys = o.rkeys;
    this.residual = o.residual || null;
    this.lcorr = lcorr;
    this.rcorr = rcorr;
    this.build = build;
    this.plans = plansOf(o.lkeys, o.rkeys, this.residual, lcorr, rcorr);
  }

  detail() {
    const keys = this.lkeys.map((k, i) => `${textOf(k)} = ${textOf(this.rkeys[i])}`).join(' AND ');
    return `${this.kind} on ${keys}${this.residual ? ' AND ' + textOf(this.residual) : ''}`;
  }

  props() {
    const out = [prop('Join kind', this.kind), prop('Keys', this.lkeys.map((k, i) => `${textOf(k)} = ${textOf(this.rkeys[i])}`).join(', '))];
    if (this.residual) out.push(prop('Residual', textOf(this.residual)));
    if (this.lcorr) out.push(prop('Correlation keys', this.lcorr.map((k, i) => `${textOf(k)} = ${textOf(this.rcorr[i])}`).join(', ')));
    out.push(prop('Build side', this.build));
    return out;
  }

  // The side whose rows stream (the probe side; the left side of antiNullAware unless it is read first).
  rowsCounted() {
    if (this.kind === 'antiNullAware') return this.build === 'left' || this.left.rowsCounted();
    return (this.build === 'left' ? this.right : this.left).rowsCounted();
  }

  markGoalKids(n) {
    const kind = this.kind;
    if (kind === 'antiNullAware') { if (this.build !== 'left') markGoal(this.left, n); return; }
    // built on the left, semi and anti joins emit only after the probe side has ended
    if (this.build === 'left' && (kind === 'semi' || kind === 'anti')) return;
    markGoal(this.build === 'left' ? this.right : this.left, n);
  }

  async *execute(env) {
    if (this.kind === 'antiNullAware') {
      yield* this.nullAware(env);
      return;
    }
    const kind = this.kind, buildLeft = this.build === 'left';
    const nk = this.lkeys.length;
    const types = this.lkeys.map((k, i) => pairType(k, this.rkeys[i]));
    const ais = this.lkeys.map((k, i) => pairAi(k, this.rkeys[i]));
    const kopts = { tz: env.tz, dateformat: env.dateformat };
    const keyL = tupleKeyer(types, ais, this.lkeys, kopts), keyR = tupleKeyer(types, ais, this.rkeys, kopts);
    const bKey = buildLeft ? keyL : keyR, pKey = buildLeft ? keyR : keyL;
    const bNode = buildLeft ? this.left : this.right, pNode = buildLeft ? this.right : this.left;
    const bKeys = buildLeft ? this.lkeys : this.rkeys, pKeys = buildLeft ? this.rkeys : this.lkeys;
    const nl = this.left.schema.length, nr = this.right.schema.length;
    const bcin = !bNode.rowsCounted(), pcin = !pNode.rowsCounted();
    // build: every row, and an index from key to row positions (rows with a NULL key part are never indexed)
    const bRows = [], table = new Map(), vals = new Array(nk);
    let tick = 0;
    for await (const batch of bNode.run(env)) {
      if (bcin) countRows(env, batch.length);
      await preList(bKeys, batch, env);
      for (let i = 0; i < batch.length; i++) {
        if (++tick === TICK) { tick = 0; checkSignal(env); }
        const row = batch[i], at = bRows.length;
        bRows.push(row);
        evalInto(bKeys, row, env, vals);
        if (hasNull(vals)) continue;
        const k = bKey(vals), list = table.get(k);
        if (list) list.push(at); else table.set(k, [at]);
      }
    }
    checkSignal(env);
    if (!table.size) {
      // nothing can match (no build row, or none without a NULL key part): the probe side is not read for inner
      // and semi joins, and a preserved build side is emitted (NULL-extended) without it
      if (kind === 'inner' || kind === 'semi') return;
      if (buildLeft ? kind === 'left' || kind === 'anti' : kind === 'right') {
        const nulls = nullRow(buildLeft ? nr : nl);
        yield* chunks(kind === 'anti' ? bRows : bRows.map(b => (buildLeft ? joinRow(b, nulls) : joinRow(nulls, b))));
        return;
      }
    }
    const track = buildLeft ? kind !== 'inner' && kind !== 'right' : kind === 'right' || kind === 'full';
    const matched = track ? new Uint8Array(bRows.length) : null;
    const res = this.residual;
    const pairOf = buildLeft ? (b, p) => joinRow(b, p) : (b, p) => joinRow(p, b);
    const exists = kind === 'semi' || kind === 'anti';
    // a residual without `pre` is evaluated on one reused row; only a pair it accepts becomes an output row
    const scratch = res && !res.pre ? new Array(nl + nr) : null;
    const fill = (b, p) => {
      const l = buildLeft ? b : p, r = buildLeft ? p : b;
      for (let i = 0; i < nl; i++) scratch[i] = l[i];
      for (let i = 0; i < nr; i++) scratch[nl + i] = r[i];
      return scratch;
    };
    const nullsL = nullRow(nl), nullsR = nullRow(nr);
    const pvals = new Array(nk);
    // the probe rows that add to no output row (counted against maxScanRows unless their input counted them)
    const keepsUnmatched = buildLeft ? kind === 'right' || kind === 'full' : kind === 'left' || kind === 'full' || kind === 'anti';
    const dropsMatched = !buildLeft && kind === 'anti';
    const dropsAll = buildLeft && exists;
    const end = slicer(this.rowGoal, res && res.pre);
    for await (const whole of pNode.run(env)) {
      for (let s0 = 0; s0 < whole.length;) {
        const e0 = end(s0, whole.length);
        const batch = s0 === 0 && e0 === whole.length ? whole : whole.slice(s0, e0);
        s0 = e0;
        await preList(pKeys, batch, env);
        // per probe row its candidate build rows; with a residual `pre`, the candidate joined rows of the slice first
        const cands = new Array(batch.length);
        for (let i = 0; i < batch.length; i++) {
          if (++tick === TICK) { tick = 0; checkSignal(env); }
          evalInto(pKeys, batch[i], env, pvals);
          cands[i] = hasNull(pvals) ? null : table.get(pKey(pvals)) || null;
        }
        let joined = null;
        if (res && res.pre) {
          joined = new Array(batch.length);
          const all = [];
          for (let i = 0; i < batch.length; i++) {
            if (!cands[i]) continue;
            const js = cands[i].map(bi => pairOf(bRows[bi], batch[i]));
            joined[i] = js;
            for (const j of js) all.push(j);
          }
          if (all.length) await res.pre(all, env);
        }
        let out = [], dropped = 0;
        for (let i = 0; i < batch.length; i++) {
          const p = batch[i], idxs = cands[i];
          let any = false;
          if (idxs) {
            for (let c = 0; c < idxs.length; c++) {
              if (++tick === TICK) { tick = 0; checkSignal(env); }
              const bi = idxs[c], b = bRows[bi];
              if (res && res.fn(joined ? joined[i][c] : fill(b, p), env) !== true) continue;
              any = true;
              if (matched) matched[bi] = 1;
              if (exists) {
                if (!buildLeft) break;
                continue;
              }
              out.push(joined ? joined[i][c] : pairOf(b, p));
              if (out.length >= BATCH) { yield out; out = []; }
            }
          }
          if (!any) {
            if (buildLeft ? kind === 'right' || kind === 'full' : kind === 'left' || kind === 'full') {
              out.push(buildLeft ? joinRow(nullsL, p) : joinRow(p, nullsR));
            } else if (!buildLeft && kind === 'anti') out.push(p);
          } else if (!buildLeft && kind === 'semi') out.push(p);
          if (dropsAll || (any ? dropsMatched : !keepsUnmatched)) dropped++;
          if (out.length >= BATCH) { yield out; out = []; }
        }
        if (pcin && dropped) countRows(env, dropped);
        if (out.length) yield out;
      }
    }
    // the build rows the probe side left unmatched (or matched, for a semi join built on the left)
    if (!matched) return;
    let out = [];
    for (let bi = 0; bi < bRows.length; bi++) {
      if (++tick === TICK) { tick = 0; checkSignal(env); }
      const m = matched[bi] === 1, b = bRows[bi];
      let row = null;
      if (buildLeft) {
        if (kind === 'semi') row = m ? b : null;
        else if (kind === 'anti') row = m ? null : b;
        else if (!m) row = joinRow(b, nullsR);
      } else if (!m) row = joinRow(nullsL, b);
      if (row) out.push(row);
      if (out.length >= BATCH) { yield out; out = []; }
    }
    if (out.length) yield out;
  }

  // NOT IN / <> ALL (02 §6): the 01 §5.1 rule per probe row over its correlation group, or over the whole
  // right side when there are no correlation keys.
  async *nullAware(env) {
    const nk = this.lkeys.length, corr = this.lcorr;
    const kopts = { tz: env.tz, dateformat: env.dateformat };
    const kTypes = this.lkeys.map((k, i) => pairType(k, this.rkeys[i])), kAis = this.lkeys.map((k, i) => pairAi(k, this.rkeys[i]));
    const keyL = tupleKeyer(kTypes, kAis, this.lkeys, kopts), keyR = tupleKeyer(kTypes, kAis, this.rkeys, kopts);
    const cTypes = corr ? corr.map((k, i) => pairType(k, this.rcorr[i])) : null, cAis = corr ? corr.map((k, i) => pairAi(k, this.rcorr[i])) : null;
    const ckeyL = corr ? tupleKeyer(cTypes, cAis, corr, kopts) : null, ckeyR = corr ? tupleKeyer(cTypes, cAis, this.rcorr, kopts) : null;
    const res = this.residual, nl = this.left.schema.length, nr = this.right.schema.length;
    const keep = !!res;
    const lcin = !this.left.rowsCounted(), rcin = !this.right.rowsCounted();
    let tick = 0;
    // the build-left choice only changes which side is read first: both sides are read before any output
    let leftRows = null;
    if (this.build === 'left') {
      leftRows = [];
      for await (const batch of this.left.run(env)) {
        if (lcin) countRows(env, batch.length);
        for (const r of batch) leftRows.push(r);
      }
    }
    const newGroup = () => ({ n: 0, nulls: false, keys: new Set(), rows: keep ? [] : null });
    const whole = newGroup();
    const groups = corr ? new Map() : null;
    const vals = new Array(nk), cvals = corr ? new Array(corr.length) : null;
    for await (const batch of this.right.run(env)) {
      if (rcin) countRows(env, batch.length);
      await preList(this.rkeys, batch, env);
      if (corr) await preList(this.rcorr, batch, env);
      for (const row of batch) {
        if (++tick === TICK) { tick = 0; checkSignal(env); }
        let g = whole;
        if (corr) {
          evalInto(this.rcorr, row, env, cvals);
          if (hasNull(cvals)) continue;
          const ck = ckeyR(cvals);
          g = groups.get(ck);
          if (!g) groups.set(ck, (g = newGroup()));
        }
        evalInto(this.rkeys, row, env, vals);
        const isNull = hasNull(vals), k = isNull ? null : keyR(vals);
        g.n++;
        if (isNull) g.nulls = true; else g.keys.add(k);
        if (keep) g.rows.push({ row, k });
      }
    }
    checkSignal(env);
    const scratch = keep && !res.pre ? new Array(nl + nr) : null;
    const xs = new Array(nk), pc = corr ? new Array(corr.length) : null;
    const groupOf = p => {
      if (!corr) return whole;
      evalInto(this.lcorr, p, env, pc);
      return hasNull(pc) ? null : groups.get(ckeyL(pc)) || null;
    };
    // whether probe row p is kept, given its group g and (residual with pre) its candidate joined rows js
    const keepRow = (p, g, js) => {
      if (!g || !g.n) return true;
      evalInto(this.lkeys, p, env, xs);
      const xNull = hasNull(xs), xk = xNull ? null : keyL(xs);
      if (!keep) {
        if (xNull || g.nulls) return false;
        return !g.keys.has(xk);
      }
      // with a residual, only the group's rows for which it is true belong to the subquery's result
      let n = 0, nulls = false, hit = false;
      const rows = g.rows;
      for (let j = 0; j < rows.length; j++) {
        if (++tick === TICK) { tick = 0; checkSignal(env); }
        const e = rows[j];
        if (res.fn(js ? js[j] : fillRow(scratch, p, e.row, nl, nr), env) !== true) continue;
        n++;
        if (e.k == null) nulls = true; else if (e.k === xk) hit = true;
      }
      if (!n) return true;
      if (xNull || nulls) return false;
      return !hit;
    };
    // the dropped left rows count unless they were counted when read (build 'left') or below
    const countDropped = !leftRows && lcin;
    const end = slicer(this.rowGoal, keep && res.pre);
    const judge = async function* (batches) {
      for await (const whole of batches) {
        for (let s0 = 0; s0 < whole.length;) {
          const e0 = end(s0, whole.length);
          const batch = s0 === 0 && e0 === whole.length ? whole : whole.slice(s0, e0);
          s0 = e0;
          await preList(this.lkeys, batch, env);
          if (corr) await preList(this.lcorr, batch, env);
          const gs = new Array(batch.length);
          for (let i = 0; i < batch.length; i++) gs[i] = groupOf(batch[i]);
          // a residual `pre` sees exactly the joined rows its fn is evaluated on (compile.js keys some memos by row)
          let joined = null;
          if (keep && res.pre) {
            joined = new Array(batch.length);
            const all = [];
            for (let i = 0; i < batch.length; i++) {
              const g = gs[i];
              if (!g || !g.n) continue;
              const js = new Array(g.rows.length);
              for (let j = 0; j < js.length; j++) all.push((js[j] = joinRow(batch[i], g.rows[j].row)));
              joined[i] = js;
            }
            if (all.length) await res.pre(all, env);
          }
          const out = [];
          for (let i = 0; i < batch.length; i++) {
            if (++tick === TICK) { tick = 0; checkSignal(env); }
            if (keepRow(batch[i], gs[i], joined ? joined[i] : null)) out.push(batch[i]);
          }
          if (countDropped && out.length < batch.length) countRows(env, batch.length - out.length);
          if (out.length) yield out;
        }
      }
    }.bind(this);
    if (leftRows) yield* judge(chunks(leftRows));
    else yield* judge(this.left.run(env));
  }
}

function fillRow(scratch, a, b, na, nb) {
  for (let i = 0; i < na; i++) scratch[i] = a[i];
  for (let i = 0; i < nb; i++) scratch[na + i] = b[i];
  return scratch;
}

// Nested loop join with any predicate, and CROSS/OUTER APPLY with a correlated right side.
export class NestedLoop extends PlanNode {
  constructor(o) {
    const apply = !!o.apply;
    oneOf(o.kind, apply ? APPLY_KINDS : LOOP_KINDS, apply ? 'NestedLoop kind with apply' : 'NestedLoop kind');
    need(isNode(o.left) && isNode(o.right), 'NestedLoop({left, right})');
    need(o.pred == null || isCompiled(o.pred), 'NestedLoop: pred is a compiled predicate or null');
    need(!(o.kind === 'cross' && o.pred), 'NestedLoop: a cross join has no predicate');
    need(o.memo == null || (apply && Array.isArray(o.memo) && o.memo.every(i => Number.isInteger(i) && i >= 0 && i < o.left.schema.length)),
      'NestedLoop: memo is a list of left column indexes, with apply only');
    super(base('NestedLoop', o, [o.left, o.right], o.schema || joinSchema(o.kind, o.left, o.right)));
    this.kind = o.kind;
    this.left = o.left;
    this.right = o.right;
    this.pred = o.pred || null;
    this.apply = apply;
    this.parallel = !!o.parallel;
    this.memo = o.memo ? o.memo.slice() : null;
    this.rightIO = null;
    this.plans = plansOf(this.pred);
  }

  detail() {
    return `${this.kind}${this.apply ? ' apply' : ''}${this.pred ? ' on ' + textOf(this.pred) : ''}`;
  }

  props() {
    const out = [prop('Join kind', this.kind), prop('Apply', this.apply ? 'yes' : 'no')];
    if (this.pred) out.push(prop('Predicate', textOf(this.pred)));
    if (this.parallel) out.push(prop('Parallel', 'yes'));
    if (this.memo) out.push(prop('Memo keys', this.memo.length ? this.memo.map(i => colLabel(this.left.schema[i])).join(', ') : '(none)'));
    return out;
  }

  // The left side streams; APPLY right rows stream too (a semi/anti join emits left rows only).
  rowsCounted() {
    const exists = this.kind === 'semi' || this.kind === 'anti';
    return this.left.rowsCounted() && (!this.apply || exists || this.right.rowsCounted());
  }

  markGoalKids(n) { markGoal(this.left, n); }

  // With apply only the left input shares the driver's outer rows (see the notes above).
  async prepare(outerRows, env) {
    if (this.apply) await this.left.prepare(outerRows, env);
    else await super.prepare(outerRows, env);
  }

  async *execute(env) {
    if (this.apply) yield* this.applyLoop(env);
    else yield* this.joinLoop(env);
  }

  // The joined rows of left row l with right rows rs that satisfy pred (all of them without pred).
  async matches(l, rs, env) {
    const pred = this.pred;
    const out = [];
    if (!pred) {
      for (const r of rs) out.push(joinRow(l, r));
      return out;
    }
    if (pred.pre) {
      for (let s = 0; s < rs.length; s += BATCH) {
        const cand = [];
        for (let i = s; i < Math.min(rs.length, s + BATCH); i++) cand.push(joinRow(l, rs[i]));
        await pred.pre(cand, env);
        for (const c of cand) if (pred.fn(c, env) === true) out.push(c);
      }
      return out;
    }
    const nl = l.length, scratch = new Array(nl + (rs.length ? rs[0].length : 0));
    for (const r of rs) {
      fillRow(scratch, l, r, nl, r.length);
      if (pred.fn(scratch, env) === true) out.push(joinRow(l, r));
    }
    return out;
  }

  // An uncorrelated right side: read once per run, then joined to every left row.
  async *joinLoop(env) {
    const kind = this.kind, pred = this.pred;
    const lcin = !this.left.rowsCounted(), rcin = !this.right.rowsCounted();
    const R = [];
    for await (const batch of this.right.run(env)) {
      if (rcin) countRows(env, batch.length);
      for (const r of batch) R.push(r);
    }
    if (!R.length && (kind === 'inner' || kind === 'cross' || kind === 'semi')) return;
    const nl = this.left.schema.length, nr = this.right.schema.length;
    const nullsL = nullRow(nl), nullsR = nullRow(nr);
    const matchedR = kind === 'right' || kind === 'full' ? new Uint8Array(R.length) : null;
    const exists = kind === 'semi' || kind === 'anti';
    const scratch = pred && !pred.pre ? new Array(nl + nr) : null;
    for await (const batch of this.left.run(env)) {
      let out = [], dropped = 0, tick = 0;
      for (const l of batch) {
        let any = false;
        if (pred && pred.pre) {
          for (let s = 0; s < R.length && !(exists && any); s += BATCH) {
            const e = Math.min(R.length, s + BATCH), cand = new Array(e - s);
            for (let i = s; i < e; i++) cand[i - s] = joinRow(l, R[i]);
            await pred.pre(cand, env);
            for (let i = 0; i < cand.length; i++) {
              if (++tick === TICK) { tick = 0; checkSignal(env); }
              if (pred.fn(cand[i], env) !== true) continue;
              any = true;
              if (exists) break;
              if (matchedR) matchedR[s + i] = 1;
              out.push(cand[i]);
              if (out.length >= BATCH) { yield out; out = []; }
            }
          }
        } else {
          for (let ri = 0; ri < R.length; ri++) {
            if (++tick === TICK) { tick = 0; checkSignal(env); }
            const r = R[ri];
            if (pred && pred.fn(fillRow(scratch, l, r, nl, nr), env) !== true) continue;
            any = true;
            if (exists) break;
            if (matchedR) matchedR[ri] = 1;
            out.push(joinRow(l, r));
            if (out.length >= BATCH) { yield out; out = []; }
          }
        }
        if (kind === 'semi') { if (any) out.push(l); else dropped++; }
        else if (kind === 'anti') { if (!any) out.push(l); else dropped++; }
        else if (!any && (kind === 'left' || kind === 'full')) out.push(joinRow(l, nullsR));
        else if (!any && (kind === 'inner' || kind === 'cross' || kind === 'right')) dropped++;
        if (out.length >= BATCH) { yield out; out = []; }
      }
      if (lcin && dropped) countRows(env, dropped);
      if (out.length) yield out;
    }
    if (!matchedR) return;
    let out = [];
    for (let ri = 0; ri < R.length; ri++) {
      if (matchedR[ri]) continue;
      out.push(joinRow(nullsL, R[ri]));
      if (out.length >= BATCH) { yield out; out = []; }
    }
    if (out.length) yield out;
  }

  // The first joined row of left row l that satisfies pred ([] when none; semi/anti APPLY with a predicate): the
  // right side is closed at the first match. The right rows read count against maxScanRows (rcin).
  async firstMatch(l, e2, env, rcin) {
    let read = 0, first = null;
    for await (const rb of this.right.run(e2)) {
      read += rb.length;
      const ms = await this.matches(l, rb, env);
      if (ms.length) { first = ms[0]; break; }
    }
    if (rcin && read) countRows(env, read);
    return first ? [first] : EMPTY;
  }

  // CROSS/OUTER APPLY (and correlated semi/anti): the right side once per left row with env.outer = [row, ...]
  // (see the notes above, NestedLoop and Run-time rules).
  async *applyLoop(env) {
    const kind = this.kind, pred = this.pred, nullsR = nullRow(this.right.schema.length);
    const exists = kind === 'semi' || kind === 'anti';
    if (exists) markGoal(this.right, 1);
    const parent = env.outer || EMPTY;
    const lcin = !this.left.rowsCounted(), rcin = !this.right.rowsCounted();
    const goal = this.rowGoal, exactGoal = goal > 0 && goal <= BATCH, parallel = this.parallel;
    // later left rows run ahead (at most dop at once, in left-row order) for `parallel` and for a right side
    // that sends requests; while a row goal of at most BATCH rows is not met, one left row at a time
    if (this.rightIO == null) this.rightIO = this.right.ioPerRun();
    const ahead = parallel || this.rightIO;
    const dop = dopOf(env);
    const firstOnly = exists && !!pred;
    const limit = exists && !pred ? 1 : Infinity;
    const memo = this.memo && !firstOnly ? new Map() : null;
    const memoKeyOf = memo ? identityKeyer(this.memo) : null;
    let memoRows = 0;
    let ac = null, onAbort = null;
    const sig = env.signal;
    // the child AbortController of the executions that run ahead, linked to env.signal and aborted when the loop ends
    const child = () => {
      if (!ac) {
        ac = new AbortController();
        if (sig) {
          onAbort = () => ac.abort(sig.reason);
          if (sig.aborted) onAbort(); else sig.addEventListener('abort', onAbort, { once: true });
        }
      }
      return ac.signal;
    };
    const envOf = (l, signal) => {
      const outer = new Array(parent.length + 1);
      outer[0] = l;
      for (let i = 0; i < parent.length; i++) outer[i + 1] = parent[i];
      return signal ? { ...env, outer, signal } : { ...env, outer };
    };
    const remember = (k, rows) => {
      if (memo.size < MEMO_KEYS && memoRows + rows.length <= MEMO_ROWS) { memo.set(k, rows); memoRows += rows.length; }
    };
    // the raw right rows of left row l (at most one for EXISTS without a predicate; with firstOnly its first match):
    // from the memo, or one execution under the child signal; the executions of one key share their promise
    const rowsOf = l => {
      const run1 = () => (firstOnly ? this.firstMatch(l, envOf(l, child()), env, rcin) : collect(this.right, envOf(l, child()), limit));
      if (!memo) return run1();
      const k = memoKeyOf(l), m = memo.get(k);
      if (m) return m;
      const p = run1();
      if (memo.size < MEMO_KEYS) {
        memo.set(k, p);
        p.then(rows => { if (memo.get(k) === p) { memo.delete(k); remember(k, rows); } }, () => { if (memo.get(k) === p) memo.delete(k); });
      }
      return p;
    };
    let out = [], target = 1, emitted = 0, dropL = 0, dropR = 0;
    const counts = () => {
      if (dropL) { if (lcin) countRows(env, dropL); dropL = 0; }
      if (dropR) { if (rcin) countRows(env, dropR); dropR = 0; }
    };
    // output batches: one per left row while a row goal is not met, else growing from 1 row (first rows fast)
    // to BATCH rows (02 §6 batch sizes)
    const nextTarget = () => (exactGoal && emitted < goal ? 1 : Math.min(BATCH, target * 2));
    try {
      for await (const batch of this.left.run(env)) {
        await this.right.prepare(batch, env);
        const n = batch.length, pending = ahead ? new Array(n) : null;
        let next = 0;
        for (let i = 0; i < n; i++) {
          if (i % TICK === TICK - 1) checkSignal(env);
          const l = batch[i];
          const exact = !parallel && exactGoal && emitted + out.length < goal;
          if (ahead && !exact) {
            if (next < i) next = i;
            while (next < n && next < i + dop) {
              const p = rowsOf(batch[next]);
              if (p && typeof p.then === 'function') p.then(null, () => {});
              pending[next++] = p;
            }
          }
          let got = null, found = false;
          if (pending && pending[i] !== undefined) { got = await pending[i]; pending[i] = undefined; }
          else if (memo) { const m = memo.get(memoKeyOf(l)); if (m) got = await m; }
          if (got === null) {
            // one left row at a time: its right batches are joined and yielded as they come, so a Top above stops the
            // loop (and the right side's paging) inside the row
            let keep = memo && memo.size < MEMO_KEYS ? [] : null;
            for await (const rb of this.right.run(envOf(l, null))) {
              if (keep) {
                if (memoRows + keep.length + rb.length > MEMO_ROWS) keep = null;
                else for (const r of rb) keep.push(r);
              }
              if (exists) {
                if (!pred) { found = true; dropR++; if (keep) keep.length = 1; break; }
                dropR += rb.length;
                if ((await this.matches(l, rb, env)).length) { found = true; break; }
                continue;
              }
              const ms = await this.matches(l, rb, env);
              dropR += rb.length - ms.length;
              if (ms.length) found = true;
              for (const m of ms) {
                out.push(m);
                if (out.length >= BATCH) { counts(); emitted += out.length; yield out; out = []; target = nextTarget(); }
              }
            }
            if (keep) remember(memoKeyOf(l), keep);
          } else if (exists) {
            found = got.length > 0;
            if (!firstOnly) dropR += got.length;
          } else {
            const ms = await this.matches(l, got, env);
            dropR += got.length - ms.length;
            found = ms.length > 0;
            for (const m of ms) {
              out.push(m);
              if (out.length >= BATCH) { counts(); emitted += out.length; yield out; out = []; target = nextTarget(); }
            }
          }
          if (exists) { if (found === (kind === 'semi')) out.push(l); else dropL++; }
          else if (!found) { if (kind === 'left') out.push(joinRow(l, nullsR)); else dropL++; }
          if (out.length >= target) { counts(); emitted += out.length; yield out; out = []; target = nextTarget(); }
        }
        counts();
        if (out.length) { emitted += out.length; yield out; out = []; target = nextTarget(); }
      }
    } finally {
      if (onAbort) sig.removeEventListener('abort', onAbort);
      if (ac) ac.abort();
    }
  }
}

// Stable client sort by Key[], optionally keeping only the first `top` rows.
export class Sort extends PlanNode {
  constructor(o) {
    need(isNode(o.kid) && Array.isArray(o.keys) && o.keys.length > 0 && o.keys.every(isCompiled), 'Sort({kid, keys})');
    need(o.top == null || (Number.isInteger(o.top) && o.top >= 0), 'Sort: top is null or a non-negative integer');
    super(base('Sort', o, [o.kid], o.kid.schema));
    this.kid = o.kid;
    this.keys = o.keys;
    this.top = o.top == null ? null : o.top;
    this.plans = plansOf(o.keys);
  }

  detail() { return this.keys.map(keyText).join(', '); }
  props() {
    const out = [prop('Order by', this.keys.map(keyText).join(', '))];
    if (this.top != null) out.push(prop('Top', this.top));
    return out;
  }

  rowsCounted() { return true; }

  async *execute(env) {
    const keys = this.keys, ais = keys.map(aiOf), cmp = decoratedCmp(keys), top = this.top;
    if (top === 0) return;
    // with top: a bounded max-heap of the best `top` rows seen so far (largest at the root)
    const heap = [];
    const items = [];
    const up = i => {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (cmp(heap[i], heap[p]) <= 0) break;
        [heap[i], heap[p]] = [heap[p], heap[i]];
        i = p;
      }
    };
    const down = i => {
      const n = heap.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < n && cmp(heap[l], heap[m]) > 0) m = l;
        if (r < n && cmp(heap[r], heap[m]) > 0) m = r;
        if (m === i) return;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    };
    let seq = 0;
    const cin = !this.kid.rowsCounted();
    for await (const batch of this.kid.run(env)) {
      if (cin) countRows(env, batch.length);
      await preList(keys, batch, env);
      let tick = 0;
      for (let i = 0; i < batch.length; i++) {
        if (++tick === TICK) { tick = 0; checkSignal(env); }
        const it = { k: sortKeysOf(keys, ais, batch[i], env), i: seq++, row: batch[i] };
        if (top == null) items.push(it);
        else if (heap.length < top) { heap.push(it); up(heap.length - 1); }
        else if (cmp(it, heap[0]) < 0) { heap[0] = it; down(0); }
      }
    }
    const sorted = top == null ? items : heap;
    sorted.sort(cmp);
    const rows = new Array(sorted.length);
    for (let i = 0; i < sorted.length; i++) rows[i] = sorted[i].row;
    yield* chunks(rows);
  }
}

// TOP n [PERCENT] [WITH TIES]; returns as soon as it has its rows.
export class Top extends PlanNode {
  constructor(o) {
    need(isNode(o.kid) && (typeof o.n === 'number' || isCompiled(o.n)), 'Top({kid, n})');
    const ties = !!o.ties;
    need(!ties || (Array.isArray(o.keys) && o.keys.length > 0), 'Top: WITH TIES needs the ORDER BY keys');
    super(base('Top', o, [o.kid], o.kid.schema));
    this.kid = o.kid;
    this.n = o.n;
    this.percent = !!o.percent;
    this.ties = ties;
    this.keys = o.keys || null;
    this.plans = plansOf(o.n, o.keys);
  }

  detail() { return `${countText(this.n)}${this.percent ? ' PERCENT' : ''}${this.ties ? ' WITH TIES' : ''}`; }
  props() {
    const out = [prop('Rows', countText(this.n))];
    if (this.percent) out.push(prop('Percent', 'yes'));
    if (this.ties) out.push(prop('With ties', this.keys.map(keyText).join(', ')));
    return out;
  }

  rowsCounted() { return this.percent || this.kid.rowsCounted(); }
  markGoalKids(n) { if (!this.percent) markGoal(this.kid, typeof this.n === 'number' && !this.ties ? Math.min(n, this.n) : n); }

  async *execute(env) {
    if (this.percent) {
      yield* this.percentRows(env);
      return;
    }
    const n = await countValue(this.n, env, 'top');
    if (n === 0) return;
    markGoal(this.kid, n);
    const keys = this.keys, ais = keys ? keys.map(aiOf) : null, ties = this.ties;
    let taken = 0, last = null, final = null;
    for await (const batch of this.kid.run(env)) {
      let part = batch, stop = false;
      if (taken < n) {
        const m = Math.min(batch.length, n - taken);
        taken += m;
        if (taken === n) {
          if (!ties) {
            final = m === batch.length ? batch : batch.slice(0, m);
            break;
          }
          await preList(keys, batch, env);
          last = sortKeysOf(keys, ais, batch[m - 1], env);
          let e = m;
          while (e < batch.length && sameKeys(keys, ais, sortKeysOf(keys, ais, batch[e], env), last)) e++;
          if (e < batch.length) stop = true;
          part = e === batch.length ? batch : batch.slice(0, e);
        }
      } else {
        // ties after the nth row: the rows equal to it on every ORDER BY key
        await preList(keys, batch, env);
        let e = 0;
        while (e < batch.length && sameKeys(keys, ais, sortKeysOf(keys, ais, batch[e], env), last)) e++;
        if (e < batch.length) stop = true;
        part = e === batch.length ? batch : batch.slice(0, e);
      }
      if (stop) { final = part; break; }
      if (part.length) yield part;
    }
    if (final && final.length) yield final;
  }

  // TOP n PERCENT [WITH TIES]: reads its input fully, then keeps CEILING(n / 100 × count) rows (and their ties).
  async *percentRows(env) {
    const pct = await countValue(this.n, env, 'percent');
    const rows = [], cin = !this.kid.rowsCounted();
    for await (const batch of this.kid.run(env)) {
      if (cin) countRows(env, batch.length);
      for (const r of batch) rows.push(r);
    }
    let r = percentRows(pct, rows.length);
    if (this.ties && r > 0 && r < rows.length) {
      const keys = this.keys, ais = keys.map(aiOf);
      await preList(keys, rows.slice(r - 1), env);
      const last = sortKeysOf(keys, ais, rows[r - 1], env);
      while (r < rows.length && sameKeys(keys, ais, sortKeysOf(keys, ais, rows[r], env), last)) r++;
    }
    yield* chunks(r === rows.length ? rows : rows.slice(0, r));
  }
}

// OFFSET skip ROWS [FETCH NEXT take ROWS ONLY]; returns as soon as it has its rows.
export class Offset extends PlanNode {
  constructor(o) {
    need(isNode(o.kid) && (typeof o.skip === 'number' || isCompiled(o.skip)), 'Offset({kid, skip})');
    need(o.take == null || typeof o.take === 'number' || isCompiled(o.take), 'Offset: take is a number, a compiled expression or null');
    super(base('Offset', o, [o.kid], o.kid.schema));
    this.kid = o.kid;
    this.skip = o.skip;
    this.take = o.take == null ? null : o.take;
    this.plans = plansOf(o.skip, o.take);
  }

  detail() { return `offset ${countText(this.skip)}${this.take != null ? ', fetch ' + countText(this.take) : ''}`; }
  props() {
    const out = [prop('Offset', countText(this.skip))];
    if (this.take != null) out.push(prop('Fetch', countText(this.take)));
    return out;
  }

  rowsCounted() { return this.kid.rowsCounted(); }
  markGoalKids(n) { markGoal(this.kid, typeof this.skip === 'number' ? n + this.skip : n); }

  async *execute(env) {
    const skip = await countValue(this.skip, env, 'offset');
    const take = this.take == null ? Infinity : await countValue(this.take, env, 'fetch');
    if (take !== Infinity) markGoal(this.kid, skip + take);
    let skipped = 0, taken = 0, final = null;
    for await (const batch of this.kid.run(env)) {
      let start = 0;
      if (skipped < skip) {
        start = Math.min(batch.length, skip - skipped);
        skipped += start;
        if (start === batch.length) continue;
      }
      const m = Math.min(batch.length - start, take - taken);
      const part = start === 0 && m === batch.length ? batch : batch.slice(start, start + m);
      taken += m;
      if (taken >= take) { final = part; break; }
      yield part;
    }
    if (final && final.length) yield final;
  }
}

// DISTINCT over the visible columns; hidden columns are stripped (01 §6.1).
export class Distinct extends PlanNode {
  constructor(o) {
    need(isNode(o.kid), 'Distinct({kid})');
    const cols = visibleIndexes(o.kid.schema);
    const schema = cols.map(i => {
      const c = o.kid.schema[i];
      if (!c.companion) return c;
      const { companion, ...rest } = c;
      return rest;
    });
    super(base('Distinct', o, [o.kid], schema));
    this.kid = o.kid;
    this.cols = cols;
  }

  detail() { return visibleNames(this.schema); }
  props() { return [prop('Columns', visibleNames(this.schema))]; }

  rowsCounted() { return true; }
  markGoalKids(n) { markGoal(this.kid, n); }

  async *execute(env) {
    const cols = this.cols, sch = this.kid.schema;
    const types = cols.map(i => sch[i]);
    const key = rowKeyer(cols, types, types.map(aiOf));
    const whole = cols.length === sch.length;
    const seen = new Set();
    const cin = !this.kid.rowsCounted();
    for await (const batch of this.kid.run(env)) {
      if (cin) countRows(env, batch.length);
      const out = [];
      let tick = 0;
      for (let i = 0; i < batch.length; i++) {
        if (++tick === TICK) { tick = 0; checkSignal(env); }
        const row = batch[i], k = key(row);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(whole ? row : cols.map(c => row[c]));
      }
      if (out.length) yield out;
    }
  }
}

// GROUP BY (incl. ROLLUP, CUBE and GROUPING SETS in one pass) with every aggregate of 01 §8.
export class HashAggregate extends PlanNode {
  constructor(o) {
    need(isNode(o.kid) && Array.isArray(o.keys) && Array.isArray(o.aggs) && Array.isArray(o.schema), 'HashAggregate({kid, keys, aggs, schema})');
    for (const a of o.aggs) need(a && a.def && Array.isArray(a.args), 'HashAggregate: each aggregate is {def, args, distinct, consts, order}');
    const n = o.keys.length;
    const sets = o.sets || [n ? [...Array(n).keys()] : []];
    need(sets.length > 0 && sets.every(s => Array.isArray(s) && s.every(i => Number.isInteger(i) && i >= 0 && i < n)),
      'HashAggregate: sets are lists of key indexes');
    const width = n + o.aggs.length;
    need(o.schema.length === width || o.schema.length === width + 1, 'HashAggregate: schema is keys, aggregates and an optional gid column');
    super(base('HashAggregate', o, [o.kid], o.schema));
    this.kid = o.kid;
    this.keys = o.keys;
    this.aggs = o.aggs;
    this.sets = sets;
    this.gid = o.schema.length === width + 1;
    this.plans = plansOf(o.keys, o.aggs.map(a => a.args), o.aggs.map(a => a.order || []));
  }

  aggText(a) {
    return a.text || `${a.def.name}(${a.distinct ? 'DISTINCT ' : ''}${a.def.star ? '*' : listText(a.args)})`;
  }

  detail() {
    const aggs = this.aggs.map(a => this.aggText(a)).join(', ');
    return this.keys.length ? `group by ${listText(this.keys)}${aggs ? '; ' + aggs : ''}` : aggs;
  }

  props() {
    const out = [];
    if (this.keys.length) out.push(prop('Group by', listText(this.keys)));
    if (this.sets.length > 1) out.push(prop('Grouping sets', this.sets.map(s => '(' + s.map(i => textOf(this.keys[i])).join(', ') + ')').join(', ')));
    if (this.aggs.length) out.push(prop('Aggregates', this.aggs.map(a => this.aggText(a)).join(', ')));
    return out;
  }

  rowsCounted() { return true; }

  async *execute(env) {
    const keys = this.keys, nk = keys.length, sets = this.sets, schema = this.schema;
    const keyAis = keys.map(aiOf);
    const infos = this.aggs.map((a, j) => aggInfo(a, schema[nk + j]));
    const na = infos.length;
    const kv = new Array(nk);
    // one hash key function per grouping set, over the row's key values
    const setKeys = sets.map(s => {
      const types = s.map(i => keys[i]), ais = s.map(i => keyAis[i]);
      if (!s.length) return () => '';
      if (s.length === 1) { const i0 = s[0], t = types[0], a = ais[0]; return () => keyOf(kv[i0], t, a); }
      const parts = new Array(s.length);
      return () => {
        for (let j = 0; j < s.length; j++) parts[j] = keyOf(kv[s[j]], types[j], ais[j]);
        return JSON.stringify(parts);
      };
    });
    const gids = sets.map(s => {
      let g = 0;
      for (let i = 0; i < nk; i++) if (!s.includes(i)) g += 2 ** (nk - 1 - i);
      return g;
    });
    const maps = sets.map(() => new Map());
    const newGroup = si => {
      const s = sets[si], gk = new Array(nk);
      for (let i = 0; i < nk; i++) gk[i] = s.includes(i) ? kv[i] : null;
      return { keys: gk, states: infos.map(f => f.init(env)), seen: infos.map(f => (f.distinct ? new Set() : null)), ordered: infos.map(f => (f.order ? [] : null)) };
    };
    const argv = infos.map(f => new Array(f.args.length));
    const okeys = infos.map(f => (f.order ? new Array(f.order.length) : null));
    let seq = 0;
    const cin = !this.kid.rowsCounted();
    for await (const batch of this.kid.run(env)) {
      if (cin) countRows(env, batch.length);
      await preList(keys, batch, env);
      for (const f of infos) {
        await preList(f.args, batch, env);
        if (f.order) await preList(f.order, batch, env);
      }
      let tick = 0;
      for (let r = 0; r < batch.length; r++) {
        if (++tick === TICK) { tick = 0; checkSignal(env); }
        const row = batch[r];
        evalInto(keys, row, env, kv);
        for (let j = 0; j < na; j++) {
          evalInto(infos[j].args, row, env, argv[j]);
          if (infos[j].order) okeys[j] = sortKeysOf(infos[j].order, infos[j].orderAis, row, env);
        }
        const at = seq++;
        for (let si = 0; si < sets.length; si++) {
          const k = setKeys[si]();
          let g = maps[si].get(k);
          if (!g) maps[si].set(k, (g = newGroup(si)));
          for (let j = 0; j < na; j++) infos[j].feed(g, j, argv[j], okeys[j], at, env);
        }
      }
    }
    let out = [];
    for (let si = 0; si < sets.length; si++) {
      if (!maps[si].size && !sets[si].length) {
        for (let i = 0; i < nk; i++) kv[i] = null;
        maps[si].set('', newGroup(si));
      }
      for (const g of maps[si].values()) {
        const row = new Array(schema.length);
        for (let i = 0; i < nk; i++) row[i] = g.keys[i];
        for (let j = 0; j < na; j++) row[nk + j] = infos[j].finish(g, j, env);
        if (this.gid) row[nk + na] = gids[si];
        out.push(row);
        if (out.length >= BATCH) { yield out; out = []; }
      }
    }
    if (out.length) yield out;
  }
}

// The run-time helper of one aggregate call (HashAggregate, Pivot): init, feed (NULL skipping, DISTINCT, WITHIN GROUP
// collection) and finish (01 §8: the caller skips NULL value arguments, applies DISTINCT with keyOf and sorts by
// WITHIN GROUP before step).
function aggInfo(a, outType) {
  const def = a.def, args = a.args, consts = a.consts || [];
  const star = args.length === 0, distinct = !!a.distinct;
  const order = a.order && a.order.length ? a.order : null;
  const dType = star ? null : args[0], dAi = star ? undefined : aiOf(args[0]);
  const orderAis = order ? order.map(aiOf) : null;
  const ocmp = order ? decoratedCmp(order) : null;
  return {
    def, args, distinct, order, orderAis,
    init: env => def.init(consts, args, env),
    feed(g, j, vals, ok, at, env) {
      if (!star && vals[0] == null) return;
      if (distinct) {
        const k = keyOf(vals[0], dType, dAi);
        if (g.seen[j].has(k)) return;
        g.seen[j].add(k);
      }
      if (order) { g.ordered[j].push({ k: ok, i: at, v: vals.slice() }); return; }
      def.step(g.states[j], vals, env);
    },
    finish(g, j, env) {
      const st = g.states[j];
      if (order) {
        const list = g.ordered[j];
        list.sort(ocmp);
        for (const e of list) def.step(st, e.v, env);
      }
      return def.result(st, outType, env);
    },
  };
}

// The frame [start, end) of every row of a sorted partition (01 §4.4 over.frame; 01 §8 default frames).
function frames(frame, hasOrder, N, peerStart, peerEnd) {
  const fs = new Int32Array(N), fe = new Int32Array(N);
  if (!frame) {
    if (!hasOrder) { fe.fill(N); return [fs, fe]; }
    for (let i = 0; i < N; i++) fe[i] = peerEnd[i];
    return [fs, fe];
  }
  const rows = frame.unit !== 'RANGE';
  const start = frame.start || { kind: 'up' }, end = frame.end || { kind: 'cur' };
  if (!rows && (start.kind === 'p' || start.kind === 'f' || end.kind === 'p' || end.kind === 'f')) throw sqlErr(4194);
  const clamp = x => (x < 0 ? 0 : x > N ? N : x);
  for (let i = 0; i < N; i++) {
    let s, e;
    switch (start.kind) {
      case 'up': s = 0; break;
      case 'uf': s = N; break;
      case 'cur': s = rows ? i : peerStart[i]; break;
      case 'p': s = i - start.n; break;
      default: s = i + start.n; break;
    }
    switch (end.kind) {
      case 'up': e = 0; break;
      case 'uf': e = N; break;
      case 'cur': e = rows ? i + 1 : peerEnd[i]; break;
      case 'p': e = i - end.n + 1; break;
      default: e = i + end.n + 1; break;
    }
    s = clamp(s);
    e = clamp(e);
    fs[i] = s;
    fe[i] = e < s ? s : e;
  }
  return [fs, fe];
}

// The values of an aggregate with OVER over each row's frame (incremental where the frames allow it); tick() runs
// once per row stepped (the signal check of long loops).
function aggregateOver(f, part, fs, fe, type, env, tick) {
  const def = f.def, args = f.args, consts = f.consts || [], star = args.length === 0;
  const N = part.length, out = new Array(N), vals = new Array(args.length);
  const step = (st, r) => {
    tick();
    evalInto(args, r, env, vals);
    if (!star && vals[0] == null) return;
    def.step(st, vals, env);
  };
  const fresh = () => def.init(consts, args, env);
  let empty, emptyDone = false;
  const emptyResult = () => {
    if (!emptyDone) { empty = def.result(fresh(), type, env); emptyDone = true; }
    return empty;
  };
  let sameStart = true, growingEnd = true, sameEnd = true, growingStart = true, width = N ? fe[0] - fs[0] : 0;
  for (let i = 1; i < N; i++) {
    if (fs[i] !== fs[0]) sameStart = false;
    if (fe[i] < fe[i - 1]) growingEnd = false;
    if (fe[i] !== fe[0]) sameEnd = false;
    if (fs[i] < fs[i - 1]) growingStart = false;
    if (fe[i] - fs[i] > width) width = fe[i] - fs[i];
  }
  if (sameStart && growingEnd) {
    const st = fresh();
    let e = fs[0];
    for (let i = 0; i < N; i++) {
      while (e < fe[i]) step(st, part[e++]);
      out[i] = fe[i] > fs[i] ? def.result(st, type, env) : emptyResult();
    }
    return out;
  }
  if (sameEnd && growingStart && !def.orderable) {
    const st = fresh();
    let s = fe[0];
    for (let i = N - 1; i >= 0; i--) {
      while (s > fs[i]) step(st, part[--s]);
      out[i] = fe[i] > fs[i] ? def.result(st, type, env) : emptyResult();
    }
    return out;
  }
  if (growingStart && growingEnd && width > SLIDE_WIDTH && typeof def.merge === 'function' && !def.orderable) return slidingOver(def, part, fs, fe, type, env, step, fresh, emptyResult, out);
  for (let i = 0; i < N; i++) {
    if (fe[i] <= fs[i]) { out[i] = emptyResult(); continue; }
    const st = fresh();
    for (let j = fs[i]; j < fe[i]; j++) step(st, part[j]);
    out[i] = def.result(st, type, env);
  }
  return out;
}

// Sliding frames whose both ends move forward (ROWS BETWEEN n PRECEDING AND m FOLLOWING, wider than SLIDE_WIDTH
// rows): the two-stacks queue over def.merge, so every row is stepped at most twice (O(N) instead of O(N × width)).
// front[j] is the aggregate of rows [j, mid), back the aggregate of rows [mid, e); a frame [S, E) is front[S] merged
// with back. Narrower frames are evaluated row by row, in input order.
function slidingOver(def, part, fs, fe, type, env, step, fresh, emptyResult, out) {
  const N = part.length, front = new Array(N);
  let back = fresh(), mid = 0, e = 0, lo = 0;
  for (let i = 0; i < N; i++) {
    const S = fs[i], E = fe[i] > S ? fe[i] : S;
    if (S >= e) {
      // the frame starts at or after the rows held so far: start again at S
      back = fresh();
      mid = e = S;
    }
    while (e < E) step(back, part[e++]);
    if (S > mid) {
      // the start passed the front part: the suffix aggregates of [S, e) become the front part, the back part empties
      for (let j = e - 1; j >= S; j--) {
        const st = fresh();
        if (j + 1 < e) def.merge(st, front[j + 1]);
        step(st, part[j]);
        front[j] = st;
      }
      back = fresh();
      mid = e;
    }
    for (; lo < S; lo++) front[lo] = undefined;
    if (S >= E) out[i] = emptyResult();
    else if (S === mid) out[i] = def.result(back, type, env);
    else if (mid === e) out[i] = def.result(front[S], type, env);
    else {
      const st = fresh();
      def.merge(st, front[S]);
      def.merge(st, back);
      out[i] = def.result(st, type, env);
    }
  }
  return out;
}

const BOUND_TEXT = { up: 'UNBOUNDED PRECEDING', uf: 'UNBOUNDED FOLLOWING', cur: 'CURRENT ROW', p: 'PRECEDING', f: 'FOLLOWING' };
const boundText = b => (b.kind === 'p' || b.kind === 'f' ? `${b.n} ${BOUND_TEXT[b.kind]}` : BOUND_TEXT[b.kind] || '?');

// The SQL text of a window frame (01 §4.4 over.frame), for explain().
function frameText(fr) {
  return `${fr.unit === 'RANGE' ? 'RANGE' : 'ROWS'} BETWEEN ${boundText(fr.start || { kind: 'up' })} AND ${boundText(fr.end || { kind: 'cur' })}`;
}

// Window functions of one PARTITION BY / ORDER BY specification.
export class Window extends PlanNode {
  constructor(o) {
    need(isNode(o.kid) && Array.isArray(o.funcs) && o.funcs.length > 0 && Array.isArray(o.schema), 'Window({kid, funcs, schema})');
    need(o.schema.length === o.kid.schema.length + o.funcs.length, 'Window: schema is the input columns plus one column per function');
    super(base('Window', o, [o.kid], o.schema));
    this.kid = o.kid;
    this.partition = o.partition || [];
    this.order = o.order || [];
    this.funcs = o.funcs;
    this.plans = plansOf(this.partition, this.order, o.funcs.map(f => f.args || []));
  }

  funcText(f) {
    return f.text || `${f.def.name}(${listText(f.args)})`;
  }

  detail() { return this.funcs.map(f => this.funcText(f)).join(', '); }
  props() {
    const out = [];
    if (this.partition.length) out.push(prop('Partition by', listText(this.partition)));
    if (this.order.length) out.push(prop('Order by', this.order.map(keyText).join(', ')));
    out.push(prop('Functions', this.funcs.map(f => this.funcText(f)).join(', ')));
    const framed = this.funcs.filter(f => f.frame);
    if (framed.length) out.push(prop('Frames', framed.map(f => `${this.funcText(f)} ${frameText(f.frame)}`).join(', ')));
    return out;
  }

  rowsCounted() { return true; }

  async *execute(env) {
    const part = this.partition, order = this.order, funcs = this.funcs;
    const nIn = this.kid.schema.length, nf = funcs.length, w = nIn + nf;
    const rows = [];
    const cin = !this.kid.rowsCounted();
    for await (const batch of this.kid.run(env)) {
      if (cin) countRows(env, batch.length);
      await preList(part, batch, env);
      await preList(order, batch, env);
      for (const f of funcs) await preList(f.args, batch, env);
      for (let i = 0; i < batch.length; i++) rows.push(batch[i]);
    }
    if (!rows.length) return;
    let ticks = 0, work = 0;
    const tick = () => { if (++ticks === TICK) { ticks = 0; checkSignal(env); } };
    let groups;
    if (part.length) {
      const map = new Map(), key = tupleKeyer(part, part.map(aiOf)), vals = new Array(part.length);
      for (const r of rows) {
        tick();
        const k = key(evalInto(part, r, env, vals));
        const g = map.get(k);
        if (g) g.push(r); else map.set(k, [r]);
      }
      groups = map.values();
    } else groups = [rows];
    const oAis = order.map(aiOf), ocmp = order.length ? decoratedCmp(order) : null;
    // output rows of consecutive partitions share batches (many small partitions never make tiny batches)
    let out = [];
    for (const g of groups) {
      // a long pass lets the event loop run between partitions, so the page stays responsive and Stop reaches it
      if (work >= YIELD_WORK) { work = 0; await macrotask(); }
      checkSignal(env);
      work += g.length * (1 + funcs.length);
      let p = g, sk = null;
      if (ocmp) {
        const items = new Array(g.length);
        for (let i = 0; i < g.length; i++) items[i] = { k: sortKeysOf(order, oAis, g[i], env), i, row: g[i] };
        items.sort(ocmp);
        p = new Array(items.length);
        sk = new Array(items.length);
        for (let i = 0; i < items.length; i++) { p[i] = items[i].row; sk[i] = items[i].k; }
      }
      const N = p.length;
      const peerStart = new Int32Array(N), peerEnd = new Int32Array(N);
      if (!sk) peerEnd.fill(N);
      else {
        for (let i = 0; i < N; i++) peerStart[i] = i > 0 && sameKeys(order, oAis, sk[i], sk[i - 1]) ? peerStart[i - 1] : i;
        for (let i = N - 1; i >= 0; i--) peerEnd[i] = i < N - 1 && peerStart[i + 1] === peerStart[i] ? peerEnd[i + 1] : i + 1;
      }
      const values = funcs.map((f, j) => {
        const [fs, fe] = frames(f.def.window && !f.def.allowsFrame ? null : f.frame, !!sk, N, peerStart, peerEnd);
        if (f.def.window) return runWindow(f.def, p, f.args, { peerStart, peerEnd, frameStart: fs, frameEnd: fe, env });
        return aggregateOver(f, p, fs, fe, this.schema[nIn + j], env, tick);
      });
      for (let i = 0; i < N; i++) {
        const src = p[i], r = new Array(w);
        for (let c = 0; c < nIn; c++) r[c] = src[c];
        for (let j = 0; j < nf; j++) r[nIn + j] = values[j][i];
        out.push(r);
        if (out.length >= BATCH) { yield out; out = []; }
      }
    }
    if (out.length) yield out;
  }
}

// UNION ALL of any number of inputs.
export class Concat extends PlanNode {
  constructor(o) {
    need(Array.isArray(o.kids) && o.kids.length > 0 && Array.isArray(o.schema), 'Concat({kids, schema})');
    for (const k of o.kids) {
      need(isNode(k), 'Concat: every input must be a PlanNode');
      if (visibleIndexes(k.schema).length !== o.schema.length) throw sqlErr(205);
    }
    super(base('Concat', o, o.kids, o.schema));
    this.cols = o.kids.map(k => visibleIndexes(k.schema));
  }

  detail() { return `${this.kids.length} inputs`; }
  props() { return [prop('Inputs', this.kids.length), prop('Columns', visibleNames(this.schema))]; }

  rowsCounted() { return this.kids.every(k => k.rowsCounted()); }
  markGoalKids(n) { for (const k of this.kids) markGoal(k, n); }

  async *execute(env) {
    for (let k = 0; k < this.kids.length; k++) {
      const kid = this.kids[k], cols = this.cols[k];
      const convs = converters(kid.schema, cols, this.schema);
      const plain = cols.length === kid.schema.length && convs.every(c => !c);
      for await (const batch of kid.run(env)) {
        if (plain) { yield batch; continue; }
        const out = new Array(batch.length);
        for (let i = 0; i < batch.length; i++) out[i] = convertRow(batch[i], cols, convs, env);
        yield out;
      }
    }
  }
}

// Whether two lineages are the same (01 §7.1 set operations keep ref only when identical).
function sameRef(a, b) {
  if (a === b) return true;
  if (!a || !b || a.poly || b.poly || a.entityFn || b.entityFn || a.pidFn || b.pidFn) return false;
  return !!a.entity && a.entity === b.entity && (a.pid ?? null) === (b.pid ?? null);
}

// The result schema of a set operation (01 §7.1): left's names, the common type per column.
function setOpSchema(op, all, left, right) {
  const ls = visible(left.schema), rs = visible(right.schema);
  if (ls.length !== rs.length) throw sqlErr(205);
  return ls.map((l, i) => {
    const r = rs[i];
    if (!(op === 'UNION' && all) && (l.dt === 'xml' || r.dt === 'xml')) throw sqlErr(305);
    const col = { name: l.name, qual: null, ...commonType(l, r) };
    if (l.ref && sameRef(l.ref, r.ref)) col.ref = l.ref;
    if (l.attr && l.attr === r.attr) col.attr = l.attr;
    if (l.ci_ai || r.ci_ai) col.ci_ai = true;
    const coll = l.coll || r.coll;
    if (coll && col.dt === 'string') col.coll = coll;
    return col;
  });
}

// UNION [ALL], INTERSECT and EXCEPT of two inputs (rows compared with rowKey).
export class SetOp extends PlanNode {
  constructor(o) {
    oneOf(o.op, ['UNION', 'INTERSECT', 'EXCEPT'], 'SetOp op');
    need(isNode(o.left) && isNode(o.right), 'SetOp({op, all, left, right})');
    const all = !!o.all;
    need(!all || o.op === 'UNION', 'SetOp: ALL is valid with UNION only');
    super(base('SetOp', o, [o.left, o.right], o.schema || setOpSchema(o.op, all, o.left, o.right)));
    this.setOp = o.op;
    this.all = all;
    this.left = o.left;
    this.right = o.right;
    this.cols = [visibleIndexes(o.left.schema), visibleIndexes(o.right.schema)];
  }

  detail() { return this.setOp + (this.all ? ' ALL' : ''); }
  props() { return [prop('Operation', this.detail()), prop('Columns', visibleNames(this.schema))]; }

  rowsCounted() { return !this.all || (this.left.rowsCounted() && this.right.rowsCounted()); }
  markGoalKids(n) {
    markGoal(this.left, n);
    if (this.setOp === 'UNION') markGoal(this.right, n);
  }

  async *execute(env) {
    const sch = this.schema, [lc, rc] = this.cols;
    const lconv = converters(this.left.schema, lc, sch), rconv = converters(this.right.schema, rc, sch);
    const all = sch.map((c, i) => i);
    const key = rowKeyer(all, sch, sch.map(aiOf));
    if (this.all) {
      for (const [node, cols, convs] of [[this.left, lc, lconv], [this.right, rc, rconv]]) {
        const plain = cols.length === node.schema.length && convs.every(c => !c);
        for await (const b of node.run(env)) yield plain ? b : b.map(r => convertRow(r, cols, convs, env));
      }
      return;
    }
    if (this.setOp === 'UNION') {
      const seen = new Set();
      const side = async function* (node, cols, convs) {
        const cin = !node.rowsCounted();
        for await (const b of node.run(env)) {
          if (cin) countRows(env, b.length);
          const out = [];
          for (const r of b) {
            const v = convertRow(r, cols, convs, env), k = key(v);
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(v);
          }
          if (out.length) yield out;
        }
      };
      yield* side(this.left, lc, lconv);
      yield* side(this.right, rc, rconv);
      return;
    }
    const right = new Set(), rcin = !this.right.rowsCounted(), lcin = !this.left.rowsCounted();
    for await (const b of this.right.run(env)) {
      if (rcin) countRows(env, b.length);
      for (const r of b) right.add(key(convertRow(r, rc, rconv, env)));
    }
    const intersect = this.setOp === 'INTERSECT';
    if (intersect && !right.size) return;
    const emitted = new Set();
    for await (const b of this.left.run(env)) {
      if (lcin) countRows(env, b.length);
      const out = [];
      for (const r of b) {
        const v = convertRow(r, lc, lconv, env), k = key(v);
        if (right.has(k) !== intersect || emitted.has(k)) continue;
        emitted.add(k);
        out.push(v);
      }
      if (out.length) yield out;
    }
  }
}

// Reads its input once per statement and replays it (shared CTE references, uncorrelated right sides).
export class Spool extends PlanNode {
  constructor(o) {
    need(isNode(o.kid), 'Spool({kid})');
    super(base('Spool', o, [o.kid], o.kid.schema));
    this.kid = o.kid;
  }

  detail() { return 'read once per statement'; }
  props() { return [prop('Spool mode', 'replay'), prop('Columns', visibleNames(this.schema))]; }

  rowsCounted() { return true; }
  ioPerRun() { return false; }

  async *execute(env) {
    const st = stateOf(env);
    let p = st.get(this);
    if (!p) {
      p = (async () => {
        const rows = [], cin = !this.kid.rowsCounted();
        for await (const b of this.kid.run(env)) {
          if (cin) countRows(env, b.length);
          for (const r of b) rows.push(r);
        }
        return rows;
      })();
      st.set(this, p);
    }
    yield* chunks(await p);
  }
}

// The inner rows of a correlated subquery or APPLY body, indexed by their correlation key.
export class IndexSpool extends PlanNode {
  constructor(o) {
    need(isNode(o.kid) && Array.isArray(o.keys) && o.keys.length > 0 && o.keys.every(isCompiled), 'IndexSpool({kid, keys, mode})');
    oneOf(o.mode, ['keyed', 'full'], 'IndexSpool mode');
    const seek = o.seek || null;
    if (o.mode === 'keyed') {
      need(seek && isNode(seek.scan) && typeof seek.column === 'string' && Number.isInteger(seek.key) && seek.key >= 0 && seek.key < o.keys.length,
        'IndexSpool: keyed mode needs seek {scan, column, entityname, key}');
    }
    super(base('IndexSpool', o, [o.kid], o.kid.schema));
    this.kid = o.kid;
    this.keys = o.keys;
    this.mode = o.mode;
    this.seek = seek ? { scan: seek.scan, column: seek.column, entityname: seek.entityname || null, key: seek.key } : null;
    this.plans = plansOf(o.keys);
    this.seeks = [];
    this.last = null;
    this.keying = null;
  }

  keyText() {
    return this.keys.map(k => (k.src != null && this.kid.schema[k.src] ? colLabel(this.kid.schema[k.src]) : textOf(k))).join(', ');
  }

  detail() { return `key ${this.keyText()}, ${this.mode}`; }
  props() {
    const out = [prop('Keys', this.keyText()), prop('Spool mode', this.mode)];
    if (this.seek) out.push(prop('Seek column', (this.seek.entityname ? this.seek.entityname + '.' : '') + this.seek.column));
    return out;
  }

  // The key types, comparison flavours and tuple hash of the spool (its keys and the key expressions of its seeks).
  keyInfo() {
    if (!this.keying) {
      const ais = this.keys.map((k, i) => this.seeks.reduce((a, s) => a || pairAi(k, s.keyExprs[i]), aiOf(k)));
      this.keying = { ais, key: tupleKeyer(this.keys, ais) };
    }
    return this.keying;
  }

  // The statement state of the spool (index, loaded keys, rows in load order).
  state(env) {
    const st = stateOf(env);
    let s = st.get(this);
    if (!s) st.set(this, (s = { index: new Map(), loaded: new Map(), rows: [], full: null }));
    this.last = s;
    return s;
  }

  rowsCounted() { return true; }
  ioPerRun() { return false; }

  // Reads one run of kid (under env) into the state's index; a load outside run() adds one call, its rows and its
  // time to stats (the Plan view shows the loads of a spool that its seeks drive).
  async fill(s, env, runEnv, track) {
    const { key } = this.keyInfo();
    const vals = new Array(this.keys.length);
    const cin = !this.kid.rowsCounted(), st = this.stats, t0 = performance.now();
    let read = 0;
    if (track) st.calls++;
    try {
      for await (const b of this.kid.run(runEnv)) {
        if (cin) countRows(env, b.length);
        read += b.length;
        await preList(this.keys, b, runEnv);
        for (const row of b) {
          s.rows.push(row);
          evalInto(this.keys, row, runEnv, vals);
          if (hasNull(vals)) continue;
          const k = key(vals), g = s.index.get(k);
          if (g) g.push(row); else s.index.set(k, [row]);
        }
      }
    } finally {
      if (track) { st.rows += read; st.ms += performance.now() - t0; }
    }
  }

  // Loads the rows of the given key tuples that are not loaded yet (keyed) or every row (full); own: called by the
  // spool's own run(), which keeps the stats itself.
  async load(tuples, env, own = false) {
    const s = this.state(env);
    if (this.mode === 'full') {
      if (!s.full) s.full = this.fill(s, env, env, !own);
      await s.full;
      return;
    }
    const ki = this.seek.key, t = this.keys[ki], ai = this.keyInfo().ais[ki];
    const fresh = [], waits = [], seen = new Set();
    for (const tuple of tuples) {
      if (!tuple || hasNull(tuple)) continue;
      const v = tuple[ki], k = keyOf(v, t, ai);
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = s.loaded.get(k);
      if (cur === true) continue;
      if (cur) { waits.push(cur); continue; }
      fresh.push([k, v]);
    }
    if (fresh.length) {
      const runEnv = { ...env, scanArgs: withScanArgs(env, this.seek.scan, { conds: [{ entityname: this.seek.entityname, attr: this.seek.column, op: 'in', values: fresh.map(f => f[1]) }] }) };
      const p = this.fill(s, env, runEnv, !own);
      for (const [k] of fresh) s.loaded.set(k, p);
      p.then(() => { for (const [k] of fresh) s.loaded.set(k, true); }, () => {});
      waits.push(p);
    }
    if (waits.length) await Promise.all(waits);
  }

  // The loaded rows whose key equals tuple ([] when none).
  group(tuple, env) {
    const s = env ? stateOf(env).get(this) : this.last;
    if (!s || !tuple || hasNull(tuple)) return EMPTY;
    return s.index.get(this.keyInfo().key(tuple)) || EMPTY;
  }

  async *execute(env) {
    if (this.mode === 'full') await this.load(EMPTY, env, true);
    yield* chunks(this.state(env).rows.slice());
  }
}

// The group of an IndexSpool for the current outer values.
export class IndexSeek extends PlanNode {
  constructor(o) {
    need(o.spool instanceof IndexSpool, 'IndexSeek({spool, keyExprs}): spool must be an IndexSpool');
    need(Array.isArray(o.keyExprs) && o.keyExprs.length === o.spool.keys.length && o.keyExprs.every(isCompiled),
      'IndexSeek: one key expression per spool key');
    super(base('IndexSeek', o, [o.spool], o.spool.schema));
    this.spool = o.spool;
    this.keyExprs = o.keyExprs;
    o.spool.seeks.push(this);
    o.spool.keying = null;
  }

  detail() { return `key ${listText(this.keyExprs)}`; }
  props() { return [prop('Key values', listText(this.keyExprs))]; }

  // Loads the spool for the keys of every outer row of the batch at once.
  async prepare(outerRows, env) {
    const parent = env.outer || EMPTY;
    const outer = [null, ...parent];
    const e = { ...env, outer };
    const tuples = new Array(outerRows.length);
    for (let i = 0; i < outerRows.length; i++) {
      outer[0] = outerRows[i];
      tuples[i] = this.keyExprs.map(k => k.fn(EMPTY, e));
    }
    await this.spool.load(tuples, env);
  }

  rowsCounted() { return true; }
  ioPerRun() { return false; }

  async *execute(env) {
    const tuple = this.keyExprs.map(k => k.fn(EMPTY, env));
    if (hasNull(tuple)) return;
    await this.spool.load([tuple], env);
    const g = this.spool.group(tuple, env);
    if (g.length) yield* chunks(g.slice());
  }
}

// Recursive CTE iteration (02 §3 phase 6), with the per-iteration seek.
export class RecursiveCte extends PlanNode {
  constructor(o) {
    need(isNode(o.anchor) && isNode(o.step) && typeof o.name === 'string' && o.name !== '', 'RecursiveCte({anchor, step, name})');
    const max = o.max == null ? 100 : o.max;
    need(Number.isInteger(max) && max >= 0 && max <= 32767, 'RecursiveCte: max is MAXRECURSION 0..32767');
    const seek = o.seek || null;
    if (seek) {
      need(isNode(seek.scan) && typeof seek.column === 'string' && Number.isInteger(seek.keyIndex) && seek.keyIndex >= 0,
        'RecursiveCte: seek is {scan, column, keyIndex, colIndex} or null');
    }
    super(base('RecursiveCte', o, [o.anchor, o.step], o.schema || o.anchor.schema));
    this.anchor = o.anchor;
    this.step = o.step;
    this.name = o.name.toLowerCase();
    this.max = max;
    this.stream = !!o.stream;
    let seekOut = null;
    if (seek) {
      const colIndex = seek.colIndex != null ? seek.colIndex : seek.scan.schema.findIndex(c => c.name.toLowerCase() === seek.column.toLowerCase());
      need(Number.isInteger(colIndex) && colIndex >= 0 && colIndex < seek.scan.schema.length, 'RecursiveCte: seek.colIndex names no column of the scan');
      seekOut = { scan: seek.scan, column: seek.column, keyIndex: seek.keyIndex, colIndex };
    }
    this.seek = seekOut;
  }

  detail() { return `${this.name}, max recursion ${this.max === 0 ? '32767 (0)' : this.max}`; }
  props() {
    const out = [prop('CTE', this.name), prop('Max recursion', this.max)];
    if (this.seek) out.push(prop('Seek column', this.seek.column));
    if (this.stream) out.push(prop('Streaming', 'yes'));
    return out;
  }

  rowsCounted() { return true; }
  markGoalKids(n) { markGoal(this.anchor, n); }

  async *execute(env) {
    const name = this.name, max = this.max === 0 ? 32767 : this.max, schema = this.schema, width = schema.length;
    // under a row goal (or the stream option) the anchor rows and then every finished level are yielded as soon as
    // they exist, so a Top, Offset or EXISTS above ends the recursion before it reaches 530 (SQL Server's stack spool);
    // otherwise nothing is yielded before the recursion has ended (02 §3 phase 6: 530 returns no rows)
    const stream = this.stream || this.rowGoal > 0;
    const acin = !this.anchor.rowsCounted(), scin = !this.step.rowsCounted();
    // step columns whose type differs from the CTE column are converted with castValue (CAST semantics)
    const stepSch = this.step.schema;
    const casts = schema.map((c, i) => {
      const s = stepSch[i];
      if (!s || !differs(s, c)) return null;
      try { return { from: s, to: dataTypeOf(c), type: c }; } catch { return { from: s, to: null, type: c }; }
    });
    const needCast = casts.some(Boolean);
    const castRow = r => {
      const out = new Array(width);
      for (let i = 0; i < width; i++) {
        const v = r[i], c = casts[i];
        out[i] = c && v != null ? (c.to ? castValue(v, c.from, c.to, env) : coerce(v, c.from, c.type, env)) : v;
      }
      return out;
    };
    const result = stream ? null : [];
    let level = [];
    for await (const b of this.anchor.run(env)) {
      if (acin) countRows(env, b.length);
      for (const r of b) level.push(r);
      if (stream) yield b;
    }
    if (!stream) for (const r of level) result.push(r);
    const seek = this.seek;
    const kType = seek ? pairType(seek.scan.schema[seek.colIndex], schema[seek.keyIndex]) : null;
    const kAi = seek ? pairAi(seek.scan.schema[seek.colIndex], schema[seek.keyIndex]) : undefined;
    let index = null;
    let depth = 0;
    while (level.length) {
      checkSignal(env);
      depth++;
      const work = new Map(env.work || []);
      work.set(name, level);
      const e2 = { ...env, work };
      if (seek) {
        const keys = new Map();
        for (const r of level) {
          const v = r[seek.keyIndex];
          if (v == null) continue;
          const k = keyOf(v, kType, kAi);
          if (!keys.has(k)) keys.set(k, v);
        }
        if (!keys.size) break;
        if (!index && keys.size > SEEK_INDEX_KEYS) index = await this.readIndex(env, kType, kAi);
        if (index) {
          const rows = [];
          for (const k of keys.keys()) { const g = index.get(k); if (g) for (const r of g) rows.push(r); }
          e2.scanArgs = withScanArgs(env, seek.scan, { rows });
        } else {
          e2.scanArgs = withScanArgs(env, seek.scan, { conds: [{ entityname: null, attr: seek.column, op: 'in', values: [...keys.values()] }] });
        }
      }
      const next = [];
      for await (const b of this.step.run(e2)) {
        if (scin) countRows(env, b.length);
        for (const r of b) next.push(needCast ? castRow(r) : r);
      }
      if (next.length && depth > max) throw sqlErr(530, max);
      if (stream) yield* chunks(next);
      else for (const r of next) result.push(r);
      level = next;
    }
    if (!stream) yield* chunks(result);
  }

  // The one `c not-null` read of T for the rest of the recursion, indexed by c (SQL 4 CDS AdaptiveIndexSpool).
  async readIndex(env, kType, kAi) {
    const seek = this.seek;
    const e3 = { ...env, scanArgs: withScanArgs(env, seek.scan, { conds: [{ entityname: null, attr: seek.column, op: 'not-null' }] }) };
    const index = new Map(), cin = !seek.scan.rowsCounted();
    for await (const b of seek.scan.run(e3)) {
      if (cin) countRows(env, b.length);
      for (const r of b) {
        const v = r[seek.colIndex];
        if (v == null) continue;
        const k = keyOf(v, kType, kAi), g = index.get(k);
        if (g) g.push(r); else index.set(k, [r]);
      }
    }
    return index;
  }
}

// The temp-table column of a SELECT … INTO source column (see the notes above).
function tempColumn(c) {
  const col = { name: c.name, dt: c.dt };
  for (const f of ['prec', 'scale', 'len', 'unicode', 'fixed', 'dto', 'small', 'numeric']) if (c[f] != null && c[f] !== false) col[f] = c[f];
  col.nullable = true;
  if (c.coll && c.dt === 'string') col.coll = c.coll;
  try { col.dataType = dataTypeOf(c); } catch { /* a decimal without a scale has no exact DataType */ }
  if (c.ref && c.ref.entity && !c.ref.poly && !c.ref.entityFn && !c.ref.pidFn) col.ref = c.ref.pid != null ? { entity: c.ref.entity, pid: c.ref.pid } : { entity: c.ref.entity };
  return col;
}

// SELECT … INTO #temp: reads its input and registers the temp table.
export class Into extends PlanNode {
  constructor(o) {
    need(isNode(o.kid) && typeof o.name === 'string' && o.name.startsWith('#'), 'Into({kid, name}): name is a #temp name');
    super(base('Into', o, [o.kid], []));
    this.kid = o.kid;
    this.name = o.name;
    this.rowcount = null;
  }

  detail() { return this.name; }
  props() {
    const out = [prop('Table', this.name), prop('Columns', visibleNames(this.kid.schema))];
    if (this.rowcount != null) out.push(prop('Rows written', this.rowcount));
    return out;
  }

  rowsCounted() { return true; }

  async *execute(env) {
    const temps = env.session && env.session.temps;
    if (!temps || typeof temps.set !== 'function') throw new TypeError('Into: env.session.temps (a Map) is required');
    const key = this.name.toLowerCase();
    if (temps.has(key)) throw sqlErr(2714, this.name);
    const sch = this.kid.schema, cols = visibleIndexes(sch);
    const names = new Set();
    for (const i of cols) {
      const n = sch[i].name;
      if (!n) throw sqlErr(1038);
      if (names.has(n.toLowerCase())) throw sqlErr(2705, n, this.name);
      names.add(n.toLowerCase());
    }
    const columns = cols.map(i => tempColumn(sch[i]));
    const rows = [];
    const cin = !this.kid.rowsCounted();
    for await (const b of this.kid.run(env)) {
      if (cin) countRows(env, b.length);
      for (const r of b) {
        const v = new Array(cols.length);
        for (let j = 0; j < cols.length; j++) v[j] = r[cols[j]];
        rows.push(v);
      }
    }
    if (temps.has(key)) throw sqlErr(2714, this.name);
    temps.set(key, { name: this.name, columns, rows, identity: null });
    this.rowcount = rows.length;
  }
}

// PIVOT (01 §4.3): one output column per IN value.
export class Pivot extends PlanNode {
  constructor(o) {
    need(isNode(o.kid) && Array.isArray(o.keys) && Number.isInteger(o.pivot) && Array.isArray(o.values) && o.agg && o.agg.def && Array.isArray(o.schema),
      'Pivot({kid, keys, pivot, values, agg, schema})');
    need(o.schema.length === o.keys.length + o.values.length, 'Pivot: schema is the grouping columns plus one column per value');
    super(base('Pivot', o, [o.kid], o.schema));
    this.kid = o.kid;
    this.keys = o.keys;
    this.pivot = o.pivot;
    this.values = o.values;
    this.agg = { def: o.agg.def, args: o.agg.args || [], consts: o.agg.consts || [], distinct: !!o.agg.distinct };
    this.plans = plansOf(this.agg.args);
  }

  detail() {
    const forCol = this.kid.schema[this.pivot];
    return `${this.agg.def.name}(${listText(this.agg.args)}) FOR ${forCol ? colLabel(forCol) : '?'} IN (${this.schema.slice(this.keys.length).map(c => c.name).join(', ')})`;
  }
  props() {
    const forCol = this.kid.schema[this.pivot];
    return [prop('Aggregate', `${this.agg.def.name}(${this.agg.distinct ? 'DISTINCT ' : ''}${listText(this.agg.args)})`),
      prop('Pivot column', forCol ? colLabel(forCol) : '?'), prop('Values', this.schema.slice(this.keys.length).map(c => c.name).join(', ')),
      prop('Grouping columns', this.keys.map(i => colLabel(this.kid.schema[i])).join(', '))];
  }

  rowsCounted() { return true; }

  async *execute(env) {
    const sch = this.kid.schema, keys = this.keys, nk = keys.length, nv = this.values.length;
    const forT = sch[this.pivot], forAi = aiOf(forT);
    const byValue = new Map();
    this.values.forEach((v, j) => {
      if (v == null) return;
      const k = keyOf(v, forT, forAi), l = byValue.get(k);
      if (l) l.push(j); else byValue.set(k, [j]);
    });
    const keyTypes = keys.map(i => sch[i]);
    const gkey = rowKeyer(keys, keyTypes, keyTypes.map(aiOf));
    const infos = this.values.map((v, j) => aggInfo(this.agg, this.schema[nk + j]));
    const args = this.agg.args, vals = new Array(args.length);
    const groups = new Map();
    let seq = 0;
    const cin = !this.kid.rowsCounted();
    for await (const b of this.kid.run(env)) {
      if (cin) countRows(env, b.length);
      await preList(args, b, env);
      let tick = 0;
      for (const row of b) {
        if (++tick === TICK) { tick = 0; checkSignal(env); }
        const k = gkey(row);
        let g = groups.get(k);
        if (!g) {
          g = { keys: keys.map(i => row[i]), states: new Array(nv).fill(null), seen: new Array(nv).fill(null), ordered: new Array(nv).fill(null) };
          groups.set(k, g);
        }
        const pv = row[this.pivot];
        if (pv == null) continue;
        const js = byValue.get(keyOf(pv, forT, forAi));
        if (!js) continue;
        evalInto(args, row, env, vals);
        const at = seq++;
        for (const j of js) {
          if (!g.states[j]) { g.states[j] = infos[j].init(env); if (infos[j].distinct) g.seen[j] = new Set(); }
          infos[j].feed(g, j, vals, null, at, env);
        }
      }
    }
    // without grouping columns PIVOT is a scalar aggregate (GROUP BY ()): one row also over no input rows
    if (!nk && !groups.size) groups.set('', { keys: [], states: new Array(nv).fill(null), seen: new Array(nv).fill(null), ordered: new Array(nv).fill(null) });
    let out = [];
    for (const g of groups.values()) {
      const row = new Array(nk + nv);
      for (let i = 0; i < nk; i++) row[i] = g.keys[i];
      for (let j = 0; j < nv; j++) {
        if (!g.states[j]) g.states[j] = infos[j].init(env);
        row[nk + j] = infos[j].finish(g, j, env);
      }
      out.push(row);
      if (out.length >= BATCH) { yield out; out = []; }
    }
    if (out.length) yield out;
  }
}

// UNPIVOT (01 §4.3): one row per non-NULL value of the listed columns.
export class Unpivot extends PlanNode {
  constructor(o) {
    need(isNode(o.kid) && Array.isArray(o.keep) && Array.isArray(o.cols) && Array.isArray(o.names) && o.cols.length === o.names.length && o.cols.length > 0 && Array.isArray(o.schema),
      'Unpivot({kid, keep, cols, names, schema})');
    need(o.schema.length === o.keep.length + 2, 'Unpivot: schema is the kept columns, the value column and the name column');
    super(base('Unpivot', o, [o.kid], o.schema));
    this.kid = o.kid;
    this.keep = o.keep;
    this.cols = o.cols;
    this.names = o.names;
  }

  detail() { return `${this.schema[this.keep.length].name} FOR ${this.schema[this.keep.length + 1].name} IN (${this.names.join(', ')})`; }
  props() {
    const nk = this.keep.length;
    return [prop('Value column', this.schema[nk].name), prop('Name column', this.schema[nk + 1].name), prop('Columns', this.names.join(', ')),
      prop('Kept columns', this.keep.map(i => colLabel(this.kid.schema[i])).join(', '))];
  }

  rowsCounted() { return true; }
  markGoalKids(n) { markGoal(this.kid, n); }

  async *execute(env) {
    const sch = this.kid.schema, keep = this.keep, nk = keep.length, cols = this.cols, names = this.names;
    const vt = this.schema[nk];
    const convs = cols.map(i => (differs(sch[i], vt) ? sch[i] : null));
    const cin = !this.kid.rowsCounted();
    for await (const b of this.kid.run(env)) {
      if (cin) countRows(env, b.length);
      let out = [];
      for (const row of b) {
        for (let c = 0; c < cols.length; c++) {
          const v = row[cols[c]];
          if (v == null) continue;
          const r = new Array(nk + 2);
          for (let i = 0; i < nk; i++) r[i] = row[keep[i]];
          r[nk] = convs[c] ? coerce(v, convs[c], vt, env) : v;
          r[nk + 1] = names[c];
          out.push(r);
        }
        if (out.length >= BATCH) { yield out; out = []; }
      }
      if (out.length) yield out;
    }
  }
}

// ------------------------------------------------------------------------------------------- FOR JSON

const JSON_UNNAMED = 'Column expressions and data sources without names or aliases cannot be formatted as JSON text using FOR JSON clause. Add alias to the unnamed column or table.';
const jsonConflict = name => plainErr(`Property '${name}' cannot be generated in JSON output due to a conflict with another column name or alias. Use different names and aliases for each column in SELECT list.`);

// The JSON text of a value of column col, or null for NULL (01 §5.6; json columns embedded raw).
function jsonEncoder(col, env) {
  if (col.json) return v => (v == null ? null : String(v));
  const tz = env.tz;
  return v => jsonValue(v, col, tz);
}

// The FOR JSON PATH object tree of the visible columns (dotted names nest; 01 §5.6 conflicts).
function jsonPathTree(sch, cols) {
  const root = { kids: [], names: new Set() };
  const stack = [root], open = [];
  for (const i of cols) {
    const full = sch[i].name, segs = full.split('.');
    const parents = segs.slice(0, -1), leaf = segs[segs.length - 1];
    let k = 0;
    while (k < open.length && k < parents.length && open[k] === parents[k].toLowerCase()) k++;
    stack.length = k + 1;
    open.length = k;
    for (let j = k; j < parents.length; j++) {
      const top = stack[stack.length - 1], low = parents[j].toLowerCase();
      if (top.names.has(low)) throw jsonConflict(full);
      top.names.add(low);
      const obj = { esc: jsonEscape(parents[j]), kids: [], names: new Set() };
      top.kids.push(obj);
      stack.push(obj);
      open.push(low);
    }
    const top = stack[stack.length - 1], low = leaf.toLowerCase();
    if (top.names.has(low)) throw jsonConflict(full);
    top.names.add(low);
    top.kids.push({ esc: jsonEscape(leaf), col: i });
  }
  return root;
}

// One FOR JSON PATH object; null for a nested object with nothing to write.
function jsonPathObject(node, row, enc, nulls, top) {
  let s = '';
  let any = false;
  for (const k of node.kids) {
    let t;
    if (k.col != null) {
      t = enc[k.col](row[k.col]);
      if (t == null) { if (!nulls) continue; t = 'null'; }
    } else {
      t = jsonPathObject(k, row, enc, nulls, false);
      if (t == null) continue;
    }
    s += (any ? ',"' : '"') + k.esc + '":' + t;
    any = true;
  }
  if (!any && !top && !nulls) return null;
  return '{' + s + '}';
}

// The members of one FOR JSON AUTO level object (keys as written).
function jsonMembers(cols, escs, row, enc, nulls) {
  let s = '';
  for (let i = 0; i < cols.length; i++) {
    let t = enc[cols[i]](row[cols[i]]);
    if (t == null) { if (!nulls) continue; t = 'null'; }
    s += (s ? ',"' : '"') + escs[i] + '":' + t;
  }
  return s;
}

// The nesting of FOR JSON/XML AUTO (01 §5.6): one element per row at the deepest level, and at level i one per run of
// consecutive rows equal on the columns of levels 1..i. make(level, row) builds an element; add(parent, kid) nests.
function autoNest(levels, sch, make, add) {
  const L = levels.length;
  const keyers = levels.map((lv, i) => {
    const idx = levels.slice(0, i + 1).flatMap(l => l.cols);
    const types = idx.map(c => sch[c]), ais = types.map(aiOf), vals = new Array(idx.length);
    return row => {
      for (let j = 0; j < idx.length; j++) vals[j] = row[idx[j]];
      return rowKey(vals, types, ais, { xmlText: true });
    };
  });
  const open = new Array(L).fill(null), openKeys = new Array(L).fill(null);
  const tops = [];
  return {
    tops,
    push(row) {
      let d = 0;
      while (d < L - 1 && open[d] && openKeys[d] === keyers[d](row)) d++;
      for (let i = d; i < L; i++) {
        const el = make(i, row);
        if (i === 0) tops.push(el); else add(open[i - 1], el);
        open[i] = el;
        openKeys[i] = i < L - 1 ? keyers[i](row) : null;
      }
    },
  };
}

// FOR JSON PATH / AUTO (01 §5.6): one row, one column.
export class JsonOutput extends PlanNode {
  constructor(o) {
    need(isNode(o.kid), 'JsonOutput({kid, mode})');
    oneOf(o.mode, ['path', 'auto'], 'JsonOutput mode');
    need(o.mode !== 'auto' || Array.isArray(o.levels), 'JsonOutput: AUTO needs levels');
    const schema = [{ name: 'JSON_F52E2B61-18A1-11d1-B105-00805F49916B', qual: null, dt: 'string', len: -1, unicode: true, json: true }];
    super(base('JsonOutput', o, [o.kid], schema));
    this.kid = o.kid;
    this.mode = o.mode;
    this.root = o.root == null ? null : o.root;
    this.includeNulls = !!o.includeNulls;
    this.noArray = !!o.noArray;
    this.levels = o.levels || null;
  }

  detail() {
    const opts = [this.root != null ? `ROOT('${this.root}')` : '', this.includeNulls ? 'INCLUDE_NULL_VALUES' : '', this.noArray ? 'WITHOUT_ARRAY_WRAPPER' : ''];
    return ['FOR JSON ' + this.mode.toUpperCase(), ...opts].filter(Boolean).join(', ');
  }
  props() {
    const out = [prop('Mode', this.mode.toUpperCase())];
    if (this.root != null) out.push(prop('Root', this.root));
    if (this.includeNulls) out.push(prop('Include null values', 'yes'));
    if (this.noArray) out.push(prop('Without array wrapper', 'yes'));
    if (this.levels) out.push(prop('Levels', this.levels.map(l => l.name).join(' > ')));
    return out;
  }

  rowsCounted() { return true; }

  async *execute(env) {
    if (this.mode === 'auto' && !this.levels.length) throw sqlErr(13600);
    const sch = this.kid.schema, cols = visibleIndexes(sch), nulls = this.includeNulls;
    for (const i of cols) if (!sch[i].name) throw plainErr(JSON_UNNAMED);
    const enc = new Array(sch.length);
    for (const i of cols) enc[i] = jsonEncoder(sch[i], env);
    const objs = [];
    if (this.mode === 'path') {
      const tree = jsonPathTree(sch, cols);
      const cin = !this.kid.rowsCounted();
      for await (const b of this.kid.run(env)) {
        if (cin) countRows(env, b.length);
        for (const row of b) objs.push(jsonPathObject(tree, row, enc, nulls, true));
      }
    } else {
      const levels = this.levels, L = levels.length;
      const escs = levels.map(lv => lv.cols.map(c => jsonEscape(sch[c].name)));
      levels.forEach((lv, i) => {
        if (!lv.name) throw plainErr(JSON_UNNAMED);
        const seen = new Set();
        for (const c of lv.cols) {
          const low = sch[c].name.toLowerCase();
          if (seen.has(low)) throw jsonConflict(sch[c].name);
          seen.add(low);
        }
        if (i + 1 < L && seen.has(levels[i + 1].name.toLowerCase())) throw jsonConflict(levels[i + 1].name);
      });
      const nameEsc = levels.map(lv => jsonEscape(lv.name));
      const nest = autoNest(levels, sch, (i, row) => ({ m: jsonMembers(levels[i].cols, escs[i], row, enc, nulls), kids: [] }), (p, k) => p.kids.push(k));
      const cin = !this.kid.rowsCounted();
      for await (const b of this.kid.run(env)) {
        if (cin) countRows(env, b.length);
        for (const row of b) nest.push(row);
      }
      const render = (o, i) => {
        if (i === L - 1) return '{' + o.m + '}';
        return '{' + o.m + (o.m ? ',"' : '"') + nameEsc[i + 1] + '":[' + o.kids.map(k => render(k, i + 1)).join(',') + ']}';
      };
      for (const t of nest.tops) objs.push(render(t, 0));
    }
    if (!objs.length) { yield [[null]]; return; }
    let text = this.noArray ? objs.join(',') : '[' + objs.join(',') + ']';
    if (this.root != null) text = '{"' + jsonEscape(this.root) + '":' + text + '}';
    yield [[text]];
  }
}

// -------------------------------------------------------------------------------------------- FOR XML

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';

// XML 1.0 (5th edition) NameStartChar / NameChar for one UTF-16 unit (surrogates handled by the callers).
function nameStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || (c >= 0xC0 && c <= 0xD6) ||
    (c >= 0xD8 && c <= 0xF6) || (c >= 0xF8 && c <= 0x2FF) || (c >= 0x370 && c <= 0x37D) || (c >= 0x37F && c <= 0x1FFF) ||
    (c >= 0x200C && c <= 0x200D) || (c >= 0x2070 && c <= 0x218F) || (c >= 0x2C00 && c <= 0x2FEF) ||
    (c >= 0x3001 && c <= 0xD7FF) || (c >= 0xF900 && c <= 0xFDCF) || (c >= 0xFDF0 && c <= 0xFFFD);
}

function nameChar(c) {
  return nameStart(c) || c === 45 || c === 46 || (c >= 48 && c <= 57) || c === 0xB7 || (c >= 0x300 && c <= 0x36F) || (c >= 0x203F && c <= 0x2040);
}

const hex4 = c => c.toString(16).toUpperCase().padStart(4, '0');
const isHigh = c => c >= 0xD800 && c <= 0xDBFF;
const isLow = c => c >= 0xDC00 && c <= 0xDFFF;

// The SQL Server encoding of an XML name (01 §5.7 Names): invalid units as _xHHHH_, a `_` that starts an _xHHHH_
// sequence as _x005F_; a `p:` prefix declared by WITH XMLNAMESPACES is kept.
function encodeName(name, prefixes) {
  let s = String(name), pre = '';
  const colon = s.indexOf(':');
  if (colon > 0 && prefixes.has(s.slice(0, colon))) { pre = s.slice(0, colon + 1); s = s.slice(colon + 1); }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 95 && /^_x[0-9A-Fa-f]{4}_/.test(s.slice(i, i + 7))) { out += '_x005F_'; continue; }
    if (isHigh(c) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
      const cp = s.codePointAt(i);
      if (cp <= 0xEFFFF) { out += s[i] + s[i + 1]; i++; continue; }
    }
    const ok = c !== 58 && (out === '' && !pre ? nameStart(c) : nameChar(c));
    out += ok ? s[i] : '_x' + hex4(c) + '_';
  }
  return pre + out;
}

// The first character of a PATH name step that is not allowed in an XML name, or null (01 §5.7 6850).
function badNameChar(s, prefixes) {
  const colon = s.indexOf(':');
  let local = s, from = 0;
  if (colon > 0 && prefixes.has(s.slice(0, colon))) { local = s.slice(colon + 1); from = colon + 1; }
  if (!local.length) return { ch: s[from - 1] || '', code: 0 };
  for (let i = 0; i < local.length; i++) {
    const c = local.charCodeAt(i);
    if (isHigh(c) && i + 1 < local.length && isLow(local.charCodeAt(i + 1)) && local.codePointAt(i) <= 0xEFFFF) { i++; continue; }
    const ok = c !== 58 && (i === 0 ? nameStart(c) : nameChar(c));
    if (!ok) return { ch: local[i], code: c };
  }
  return null;
}

// Raises 6850 for an invalid PATH name step (the column's name, the character and its code).
function checkPathName(step, column, prefixes) {
  const bad = badNameChar(step, prefixes);
  if (bad) throw sqlErr(6850, column, bad.ch, '0x' + hex4(bad.code));
  return step;
}

// The text content of an xml value (data() of an xml column).
function xmlTextContent(v) {
  const walk = n => (n.name === '#text' ? n.text || '' : n.name && n.name[0] === '#' && n.name !== '#document' ? '' : (n.kids || []).map(walk).join(''));
  return walk(xmlDoc(v));
}

// The unescaped FOR XML text of a non-xml value (01 §5.7 Values; see the notes above).
function xmlScalar(v, t, env) {
  let type = t;
  if (type.dt === 'any' || type.dt === 'null') { type = variantType(v); v = variantValue(v); }
  switch (type.dt) {
    case 'string': return String(v);
    case 'xml': return xmlTextContent(v);
    case 'bit': return v ? '1' : '0';
    case 'int': case 'bigint': case 'decimal': return toSqlString(v, type);
    case 'money': return toSqlString(v, { dt: 'decimal', prec: 19, scale: 4 });
    case 'float': return toSqlString(v, type, { style: 2 });
    case 'guid': return String(v).toUpperCase();
    case 'date': case 'datetime': case 'time': case 'binary': {
      const j = jsonValue(v, type, env.tz);
      return j.slice(1, -1);
    }
    default: return typeof v === 'string' ? v : toSqlString(v, type);
  }
}

// Whether a value of column col is written unescaped (an xml-typed value, 01 §5.7).
function isXmlValue(v, col) {
  if (col.dt === 'xml') return true;
  if ((col.dt === 'any' || col.dt === 'null') && v != null) return variantType(v).dt === 'xml';
  return false;
}

// Element content of a value: raw xml or escaped text.
function xmlContent(v, col, env) {
  if (isXmlValue(v, col)) return String(variantValue(v));
  return xmlEsc(xmlScalar(v, col, env), 'text');
}

// An attribute value of a value (escaped; an xml value as its serialised text).
function xmlAttrValue(v, col, env) {
  if (isXmlValue(v, col)) return xmlEsc(String(variantValue(v)), 'attr');
  return xmlEsc(xmlScalar(v, col, env), 'attr');
}

// An element under construction: start tag name, attributes text, content parts (strings and elements).
class XEl {
  constructor(name) {
    this.name = name;
    this.attrs = '';
    this.anames = null;
    this.kids = [];
    this.lastData = false;
  }

  attr(name, value, column) {
    const low = name.toLowerCase();
    if (!this.anames) this.anames = new Set();
    if (this.anames.has(low)) throw sqlErr(6810, column);
    this.anames.add(low);
    this.attrs += ' ' + name + '="' + value + '"';
  }

  add(part) {
    this.kids.push(part);
    this.lastData = false;
  }
}

// The serialised text of an element (decl: namespace declarations written into its start tag).
function xmlSerialize(el, decl) {
  let s = '<' + el.name + (decl || '') + el.attrs;
  if (!el.kids.length) return s + '/>';
  s += '>';
  for (const k of el.kids) s += typeof k === 'string' ? k : xmlSerialize(k, '');
  return s + '</' + el.name + '>';
}

// The xmlns declarations text of WITH XMLNAMESPACES (and xsi for ELEMENTS XSINIL).
function xmlnsDecl(xmlns, xsi) {
  let s = '';
  for (const ns of xmlns || EMPTY) s += (ns.prefix == null ? ' xmlns="' : ' xmlns:' + ns.prefix + '="') + xmlEsc(ns.uri, 'attr') + '"';
  if (xsi) s += ' xmlns:xsi="' + XSI + '"';
  return s;
}

const EXPLICIT_DIRECTIVES = new Set(['', 'element', 'xml', 'cdata', 'hide', 'id', 'idref']);
const EXPLICIT_UNSUPPORTED = new Set(['elementxsinil', 'xmltext', 'idrefs', 'nmtoken', 'nmtokens']);

// The universal table of FOR XML EXPLICIT (01 §5.7): {tagCol, parentCol, tags: Map<n, {name, cols}>} or {error}.
function explicitPlan(o) {
  try {
    if (o.elements) throw sqlErr(6825);
    const sch = o.kid.schema, cols = visibleIndexes(sch);
    if (cols.length < 3) throw sqlErr(6801);
    const tags = new Map();
    for (const c of cols.slice(2)) {
      const name = sch[c].name || '';
      const parts = name.split('!');
      if (parts.length < 2 || parts.length > 4 || !parts[0] || !/^[0-9]+$/.test(parts[1]) || Number(parts[1]) <= 0) throw sqlErr(6802, name);
      const tag = Number(parts[1]), attr = parts[2] ?? '', written = parts[3] ?? '', dir = written.toLowerCase();
      if (!EXPLICIT_DIRECTIVES.has(dir)) {
        if (EXPLICIT_UNSUPPORTED.has(dir)) throw plainErr(`FOR XML EXPLICIT directive '${written}' is not supported.`);
        throw sqlErr(6824, written);
      }
      if (dir === 'cdata' && attr) throw plainErr(`FOR XML EXPLICIT: the cdata directive in column '${name}' needs an empty attribute name.`);
      let t = tags.get(tag);
      if (!t) tags.set(tag, (t = { name: parts[0], cols: [] }));
      else if (t.name !== parts[0]) throw sqlErr(6812, tag, t.name, parts[0]);
      t.cols.push({ col: c, attr, dir, column: name });
    }
    return { tagCol: cols[0], parentCol: cols[1], tags };
  } catch (e) {
    if (e instanceof SqlError) return { error: e };
    throw e;
  }
}

// The number of a Tag or Parent value (a sql_variant by its base value), or NaN.
function tagNumber(v) {
  const x = variantValue(v);
  return typeof x === 'number' ? x : typeof x === 'boolean' ? (x ? 1 : 0) : NaN;
}

// FOR XML RAW / PATH / AUTO / EXPLICIT (01 §5.7): one row, one column.
export class XmlOutput extends PlanNode {
  constructor(o) {
    need(isNode(o.kid), 'XmlOutput({kid, mode})');
    oneOf(o.mode, ['raw', 'path', 'auto', 'explicit'], 'XmlOutput mode');
    oneOf(o.elements == null ? null : o.elements, [null, 'absent', 'xsinil'], 'XmlOutput elements');
    need(o.mode !== 'auto' || Array.isArray(o.levels), 'XmlOutput: AUTO needs levels');
    const type = !!o.type;
    const schema = [{ name: 'XML_F52E2B61-18A1-11d1-B105-00805F49916B', qual: null, dt: type ? 'xml' : 'string', len: -1, unicode: true }];
    super(base('XmlOutput', o, [o.kid], schema));
    this.kid = o.kid;
    this.mode = o.mode;
    this.row = o.row == null ? null : o.row;
    this.root = o.root == null ? null : o.root;
    this.elements = o.elements == null ? null : o.elements;
    this.type = type;
    this.levels = o.levels || null;
    this.xmlns = o.xmlns || null;
    this.explicit = o.mode === 'explicit' ? explicitPlan(o) : null;
    this.planError = this.explicit && this.explicit.error ? this.explicit.error : null;
  }

  detail() {
    const head = 'FOR XML ' + this.mode.toUpperCase() + (this.row != null ? `('${this.row}')` : '');
    const opts = [this.type ? 'TYPE' : '', this.root != null ? `ROOT('${this.root}')` : '',
      this.elements ? 'ELEMENTS' + (this.elements === 'xsinil' ? ' XSINIL' : '') : ''];
    return [head, ...opts].filter(Boolean).join(', ');
  }
  props() {
    const out = [prop('Mode', this.mode.toUpperCase())];
    if (this.row != null) out.push(prop('Row element', this.row));
    if (this.root != null) out.push(prop('Root', this.root));
    if (this.elements) out.push(prop('Elements', this.elements === 'xsinil' ? 'XSINIL' : 'ABSENT'));
    if (this.type) out.push(prop('Type', 'xml'));
    if (this.levels) out.push(prop('Levels', this.levels.map(l => l.name).join(' > ')));
    return out;
  }

  rowsCounted() { return true; }

  async *execute(env) {
    if (this.planError) throw this.planError;
    if (this.mode === 'auto' && !this.levels.length) throw sqlErr(6800);
    if (this.root === '') throw sqlErr(6861);
    const prefixes = new Set((this.xmlns || EMPTY).filter(n => n.prefix != null).map(n => n.prefix));
    const xsi = this.elements === 'xsinil' && this.mode !== 'explicit';
    const decl = xmlnsDecl(this.xmlns, xsi);
    const topDecl = this.root != null ? '' : decl;
    const writer = this.mode === 'raw' ? this.rawWriter(env, prefixes)
      : this.mode === 'path' ? this.pathWriter(env, prefixes)
        : this.mode === 'auto' ? this.autoWriter(env, prefixes) : this.explicitWriter(env, prefixes);
    let rows = 0;
    const cin = !this.kid.rowsCounted();
    for await (const b of this.kid.run(env)) {
      if (cin) countRows(env, b.length);
      rows += b.length;
      for (const row of b) writer.row(row);
    }
    if (!rows) { yield [[null]]; return; }
    let text = '';
    for (const part of writer.parts()) text += typeof part === 'string' ? part : xmlSerialize(part, topDecl);
    if (this.root != null) {
      const r = encodeName(this.root, prefixes);
      text = text ? '<' + r + decl + '>' + text + '</' + r + '>' : '<' + r + decl + '/>';
    }
    if (this.type) text = xmlValue(text, { preserveSpace: true });
    yield [[text]];
  }

  // The leaf element of an element-centric column: `<c>value</c>`, `<c xsi:nil="true"/>` or nothing.
  leaf(name, v, col, env, xsiTop) {
    if (v == null) return this.elements === 'xsinil' ? '<' + name + (xsiTop || '') + ' xsi:nil="true"/>' : null;
    return '<' + name + (xsiTop || '') + '>' + xmlContent(v, col, env) + '</' + name + '>';
  }

  // RAW: one element per row, attributes or (ELEMENTS) child elements; RAW('') writes the elements only.
  rawWriter(env, prefixes) {
    const sch = this.kid.schema, cols = visibleIndexes(sch), elements = !!this.elements;
    if (this.row === '' && !elements) throw sqlErr(6864);
    const names = cols.map(i => {
      const c = sch[i];
      if (!c.name && !(c.dt === 'xml' && !elements)) throw sqlErr(6809);
      return c.name ? encodeName(c.name, prefixes) : '';
    });
    if (!elements) {
      const seen = new Set();
      cols.forEach((i, j) => {
        if (sch[i].dt === 'xml') return;
        const low = names[j].toLowerCase();
        if (seen.has(low)) throw sqlErr(6810, sch[i].name);
        seen.add(low);
      });
    }
    const out = [];
    const rowName = this.row == null ? 'row' : this.row === '' ? null : encodeName(this.row, prefixes);
    const topDecl = this.root != null ? '' : xmlnsDecl(this.xmlns, this.elements === 'xsinil');
    return {
      row: r => {
        if (!rowName) {
          for (let j = 0; j < cols.length; j++) {
            const s = this.leaf(names[j], r[cols[j]], sch[cols[j]], env, topDecl);
            if (s != null) out.push(s);
          }
          return;
        }
        const el = new XEl(rowName);
        for (let j = 0; j < cols.length; j++) {
          const i = cols[j], v = r[i], c = sch[i];
          if (elements) {
            const s = this.leaf(names[j], v, c, env);
            if (s != null) el.add(s);
          } else if (v == null) continue;
          else if (isXmlValue(v, c)) el.add(xmlContent(v, c, env));
          else el.attr(names[j], xmlAttrValue(v, c, env), c.name);
        }
        out.push(el);
      },
      parts: () => out,
    };
  }

  // AUTO: elements named by source, nested by the levels of 01 §5.6.
  autoWriter(env, prefixes) {
    const sch = this.kid.schema, levels = this.levels, elements = !!this.elements;
    const lv = levels.map(l => {
      if (!l.name) throw sqlErr(6809);
      const names = l.cols.map(i => {
        const c = sch[i];
        if (!c.name && !(c.dt === 'xml' && !elements)) throw sqlErr(6809);
        return c.name ? encodeName(c.name, prefixes) : '';
      });
      if (!elements) {
        const seen = new Set();
        l.cols.forEach((i, j) => {
          if (sch[i].dt === 'xml') return;
          const low = names[j].toLowerCase();
          if (seen.has(low)) throw sqlErr(6810, sch[i].name);
          seen.add(low);
        });
      }
      return { name: encodeName(l.name, prefixes), cols: l.cols, names };
    });
    const make = (li, r) => {
      const L = lv[li], el = new XEl(L.name);
      for (let j = 0; j < L.cols.length; j++) {
        const i = L.cols[j], v = r[i], c = sch[i];
        if (elements) {
          const s = this.leaf(L.names[j], v, c, env);
          if (s != null) el.add(s);
        } else if (v == null) continue;
        else if (isXmlValue(v, c)) el.add(xmlContent(v, c, env));
        else el.attr(L.names[j], xmlAttrValue(v, c, env), c.name);
      }
      return el;
    };
    const nest = autoNest(levels, sch, make, (p, k) => p.add(k));
    return { row: r => nest.push(r), parts: () => nest.tops };
  }

  // PATH: column names as XPath-like paths (01 §5.7), elements opened by column adjacency.
  pathWriter(env, prefixes) {
    const sch = this.kid.schema, cols = visibleIndexes(sch);
    const omit = this.row === '';
    const rowName = omit ? null : checkPathName(this.row == null ? 'row' : this.row, this.row == null ? 'row' : this.row, prefixes);
    // the column specs, with the static 6852 / 6864 checks
    const specs = cols.map(i => {
      const name = sch[i].name || '';
      if (name === '' || name === '*') return { col: i, elems: [], kind: 'text', name: '' };
      const steps = name.split('/');
      const last = steps[steps.length - 1];
      const elems = steps.slice(0, -1).map(s => checkPathName(s, name, prefixes));
      if (last === 'text()' || last === 'node()' || last === '*') return { col: i, elems, kind: 'text' };
      if (last === 'data()') return { col: i, elems, kind: 'data' };
      if (last === 'comment()') return { col: i, elems, kind: 'comment' };
      const pi = /^processing-instruction\((.*)\)$/.exec(last);
      if (pi) return { col: i, elems, kind: 'pi', name: checkPathName(pi[1], name, prefixes) };
      if (last[0] === '@') return { col: i, elems, kind: 'attr', name: checkPathName(last.slice(1), name, prefixes) };
      return { col: i, elems, kind: 'elem', name: checkPathName(last, name, prefixes) };
    });
    const st = [{ name: null, content: false }];
    for (const s of specs) {
      let k = 0;
      while (k + 1 < st.length && k < s.elems.length && st[k + 1].name === s.elems[k]) k++;
      st.length = k + 1;
      for (let j = k; j < s.elems.length; j++) {
        st[st.length - 1].content = true;
        st.push({ name: s.elems[j], content: false });
      }
      const top = st[st.length - 1];
      if (s.kind === 'attr') {
        if (top.content) throw sqlErr(6852, sch[s.col].name);
        if (omit && st.length === 1) throw sqlErr(6864);
      } else top.content = true;
    }
    const container = new XEl('');
    const topDecl = this.root != null ? '' : xmlnsDecl(this.xmlns, this.elements === 'xsinil');
    const xsinil = this.elements === 'xsinil';
    const out = [];
    return {
      row: r => {
        const R = omit ? container : new XEl(rowName);
        // the logical element stack: names and the element once something has been written into it
        const stack = [{ name: null, el: R }];
        const mat = () => {
          for (let j = 1; j < stack.length; j++) {
            if (stack[j].el) continue;
            const el = new XEl(stack[j].name);
            stack[j - 1].el.add(el);
            stack[j].el = el;
          }
          return stack[stack.length - 1].el;
        };
        const atTop = () => omit && stack.length === 1;
        for (const s of specs) {
          let k = 0;
          while (k + 1 < stack.length && k < s.elems.length && stack[k + 1].name === s.elems[k]) k++;
          stack.length = k + 1;
          for (let j = k; j < s.elems.length; j++) stack.push({ name: s.elems[j], el: null });
          const v = r[s.col], c = sch[s.col];
          switch (s.kind) {
            case 'elem': {
              if (v == null && !xsinil) break;
              const top = atTop() ? topDecl : '';
              mat().add(this.leaf(s.name, v, c, env, top));
              break;
            }
            case 'attr':
              if (v != null) mat().attr(s.name, xmlAttrValue(v, c, env), c.name);
              break;
            case 'text':
              if (v != null) mat().add(xmlContent(v, c, env));
              break;
            case 'data': {
              if (v == null) break;
              const el = mat(), t = xmlEsc(isXmlValue(v, c) ? xmlTextContent(variantValue(v)) : xmlScalar(v, c, env), 'text');
              const sep = el.lastData;
              el.add(sep ? ' ' + t : t);
              el.lastData = true;
              break;
            }
            case 'comment':
              if (v != null) mat().add('<!--' + (isXmlValue(v, c) ? String(v) : xmlScalar(v, c, env)) + '-->');
              break;
            default:
              if (v != null) mat().add('<?' + s.name + ' ' + (isXmlValue(v, c) ? String(v) : xmlScalar(v, c, env)) + '?>');
              break;
          }
        }
        if (!omit) out.push(R);
      },
      parts: () => (omit ? container.kids : out),
    };
  }

  // EXPLICIT: the universal table written in input order (01 §5.7).
  explicitWriter(env, prefixes) {
    const { tagCol, parentCol, tags } = this.explicit, sch = this.kid.schema;
    const enc = new Map();
    for (const [n, t] of tags) {
      enc.set(n, {
        name: encodeName(t.name, prefixes),
        cols: t.cols.map(c => ({ ...c, aname: c.attr ? encodeName(c.attr, prefixes) : '' })),
      });
    }
    const tops = [];
    let stack = [];
    return {
      row: r => {
        const tag = tagNumber(r[tagCol]), pv = r[parentCol];
        if (!(Number.isInteger(tag) && tag > 0)) throw sqlErr(6803);
        const parent = pv == null ? null : tagNumber(pv);
        if (parent != null && !(Number.isInteger(parent) && parent >= 0)) throw sqlErr(6804);
        const T = enc.get(tag);
        if (!T) throw sqlErr(6806, tag);
        if (parent && !tags.has(parent)) throw sqlErr(6807, parent);
        const el = new XEl(T.name);
        for (const c of T.cols) {
          const v = r[c.col], col = sch[c.col];
          if (v == null || c.dir === 'hide') continue;
          switch (c.dir) {
            case 'element':
              el.add(c.aname ? '<' + c.aname + '>' + xmlContent(v, col, env) + '</' + c.aname + '>' : xmlContent(v, col, env));
              break;
            case 'xml': {
              const raw = isXmlValue(v, col) ? String(variantValue(v)) : xmlScalar(v, col, env);
              el.add(c.aname ? '<' + c.aname + '>' + raw + '</' + c.aname + '>' : raw);
              break;
            }
            case 'cdata': {
              const x = variantValue(v);
              if (typeof x !== 'string') throw plainErr(`FOR XML EXPLICIT: the cdata directive in column '${c.column}' needs a string value.`);
              el.add('<![CDATA[' + x.replace(/]]>/g, ']]]]><![CDATA[>') + ']]>');
              break;
            }
            default:
              if (c.aname) el.attr(c.aname, xmlAttrValue(v, col, env), c.column);
              else el.add(xmlContent(v, col, env));
          }
        }
        if (!parent) {
          stack = [{ tag, el }];
          tops.push(el);
          return;
        }
        let j = stack.length - 1;
        while (j >= 0 && stack[j].tag !== parent) j--;
        if (j < 0) throw sqlErr(6833, parent);
        stack.length = j + 1;
        stack[j].el.add(el);
        stack.push({ tag, el });
      },
      parts: () => tops,
    };
  }
}

// ---------------------------------------------------------------------------------------- the rest

// Runs body completely; on a matching error discards it and streams fallback (02 §6, §4.5).
export class TryCatch extends PlanNode {
  constructor(o) {
    need(isNode(o.body) && isNode(o.fallback) && typeof o.match === 'function', 'TryCatch({body, fallback, match, message})');
    need(typeof o.message === 'string' || typeof o.message === 'function', 'TryCatch: message is a string or a function');
    super(base('TryCatch', o, [o.body, o.fallback], o.body.schema));
    this.body = o.body;
    this.fallback = o.fallback;
    this.match = o.match;
    this.message = o.message;
  }

  detail() { return typeof this.message === 'string' ? this.message : ''; }
  props() {
    const out = [prop('Buffer limit', digits(TRY_CAP) + ' rows')];
    if (typeof this.message === 'string') out.push(prop('Fallback message', this.message));
    return out;
  }

  rowsCounted() { return true; }

  async *execute(env) {
    let rows = null, failure = null;
    // the body counts into its own tally, so a fallback takes the discarded body's rows back out of the statement's
    // maxScanRows counter (and out of the tallies of enclosing bodies)
    const tally = { rows: 0, up: env.tally || null };
    const benv = { ...env, tally };
    const bcin = !this.body.rowsCounted();
    try {
      rows = [];
      for await (const b of this.body.run(benv)) {
        if (bcin) countRows(benv, b.length);
        for (const r of b) rows.push(r);
        if (rows.length > TRY_CAP) {
          failure = plainErr(`The result has more than ${digits(TRY_CAP)} rows.`, 'FALLBACK');
          break;
        }
      }
    } catch (e) {
      if ((env && env.signal && env.signal.aborted) || (e && e.name === 'AbortError') || !this.match(e)) throw e;
      failure = e;
    }
    if (failure) {
      rows = null;
      uncount(env, tally);
      emitWarn(env, typeof this.message === 'function' ? this.message(failure) : this.message, 'fallback');
      // the fallback's rows stream; they count here unless they were counted below (a TryCatch counts its input)
      const fcin = !this.fallback.rowsCounted();
      for await (const b of this.fallback.run(env)) {
        if (fcin) countRows(env, b.length);
        yield b;
      }
      return;
    }
    yield* chunks(rows);
  }
}

// COUNT(*) under OPTION (USE HINT('RETRIEVE_TOTAL_RECORD_COUNT')) (02 §4.5): RetrieveTotalRecordCount's count of one
// table, labelled approximate (warning kind 'approx'). A missing or 0 count raises, so that the TryCatch around it
// falls back to the exact plan.
export class TotalCount extends PlanNode {
  constructor(o) {
    need(typeof o.entity === 'string' && o.entity !== '' && Array.isArray(o.schema) && o.schema.length === 1, 'TotalCount({entity, schema})');
    super(base('TotalCount', o, [], o.schema, true));
    this.entity = o.entity;
    this.api = o.api || null;
  }

  detail() { return `RetrieveTotalRecordCount(${this.entity})`; }
  props() { return [prop('Table', this.entity)]; }

  async *execute(env) {
    const api = this.api || env.api;
    const r = await api.fn('RetrieveTotalRecordCount', { EntityNames: [this.entity] }, { signal: env.signal || undefined });
    const c = r && r.EntityRecordCountCollection;
    const i = c && Array.isArray(c.Keys) ? c.Keys.findIndex(k => String(k).toLowerCase() === this.entity) : -1;
    const n = i >= 0 && Array.isArray(c.Values) ? Number(c.Values[i]) : 0;
    if (!Number.isFinite(n) || n <= 0) throw plainErr(`RetrieveTotalRecordCount returned no count for ${this.entity}.`, 'FALLBACK');
    if (this.schema[0].dt === 'int' && n > 2147483647) throw plainErr(`RetrieveTotalRecordCount returned ${n}, more than an int holds.`, 'FALLBACK');
    emitWarn(env, `Approximate count from RetrieveTotalRecordCount (hint RETRIEVE_TOTAL_RECORD_COUNT): it can lag recent changes by a few hours.`, 'approx');
    yield [[n]];
  }
}

// Checks every row with check(row, env, n); rows pass unchanged.
export class Assert extends PlanNode {
  constructor(o) {
    need(isNode(o.kid) && typeof o.check === 'function', 'Assert({kid, check})');
    super(base('Assert', o, [o.kid], o.kid.schema));
    this.kid = o.kid;
    this.check = o.check;
  }

  rowsCounted() { return this.kid.rowsCounted(); }
  markGoalKids(n) { markGoal(this.kid, n); }

  async *execute(env) {
    let n = 0;
    for await (const b of this.kid.run(env)) {
      for (const r of b) this.check(r, env, ++n);
      yield b;
    }
  }
}

// Constant rows (VALUES, folded results, contradictions).
export class ConstantScan extends PlanNode {
  constructor(o) {
    need(Array.isArray(o.schema) && Array.isArray(o.rows), 'ConstantScan({schema, rows})');
    super(base('ConstantScan', o, [], o.schema));
    this.rows = o.rows;
  }

  detail() { return this.rows.length === 1 ? '1 row' : `${digits(this.rows.length)} rows`; }
  props() { return [prop('Rows', this.rows.length), prop('Columns', visibleNames(this.schema))]; }

  async *execute() {
    yield* chunks(this.rows);
  }
}

// A #temp table, a table variable or a recursive CTE's working table (see the notes above).
export class TempScan extends PlanNode {
  constructor(o) {
    need(typeof o.name === 'string' && o.name !== '' && Array.isArray(o.schema), 'TempScan({name, schema})');
    super(base('TempScan', o, [], o.schema));
    this.name = o.name;
  }

  detail() { return this.name; }
  props() { return [prop('Table', this.name), prop('Columns', visibleNames(this.schema))]; }

  // a recursive CTE's working table holds rows the RecursiveCte has counted
  rowsCounted() { return this.name[0] !== '#' && this.name[0] !== '@'; }

  async *execute(env) {
    const name = this.name, low = name.toLowerCase();
    if (name[0] === '#') {
      const t = env.session && env.session.temps ? env.session.temps.get(low) : null;
      if (!t) throw sqlErr(208, name);
      yield* chunks(t.rows.slice());
      return;
    }
    if (name[0] === '@') {
      const v = env.vars ? env.vars.get(low) || env.vars.get(name) : null;
      if (!v || !v.table) throw sqlErr(1087, name);
      yield* chunks(v.table.rows.slice());
      return;
    }
    const w = env.work ? env.work.get(low) : null;
    if (!w) throw new Error(`TempScan: no working table '${name}' in env.work`);
    yield* chunks(w);
  }
}

// A table-valued function of functions.js (STRING_SPLIT, OPENJSON, GENERATE_SERIES, XML_NODES, …).
export class TvfScan extends PlanNode {
  constructor(o) {
    need(o.def && typeof o.def.rows === 'function' && Array.isArray(o.args) && o.args.every(isCompiled) && Array.isArray(o.schema),
      'TvfScan({def, args, schema})');
    super(base('TvfScan', o, [], o.schema));
    this.def = o.def;
    this.args = o.args;
    this.consts = o.consts || [];
    this.withSchema = o.withSchema || null;
    this.opts = o.opts || null;
    this.plans = plansOf(o.args);
  }

  detail() { return `${this.def.name}(${listText(this.args)})`; }
  props() {
    const out = [prop('Function', this.def.name)];
    if (this.args.length) out.push(prop('Arguments', listText(this.args)));
    out.push(prop('Columns', visibleNames(this.schema)));
    return out;
  }

  rowsCounted() { return true; }

  async *execute(env) {
    await preList(this.args, ONE_ROW, env);
    const values = this.args.map(a => a.fn(EMPTY, env));
    // one call may build at most the rows the statement still allows; they count against maxScanRows (02 §4.4)
    let rows;
    try {
      rows = await this.def.rows(values, env, rowsLeft(env), this.args, this.withSchema ?? this.opts);
    } catch (e) {
      // the function's own limit error names the rows left; the statement's names its setting
      if (e && e.code === 'LIMIT' && !(e.number > 0) && / rows to process in the browser./.test(e.message)) throw scanLimitErr(env);
      throw e;
    }
    rows = rows || EMPTY;
    countRows(env, rows.length);
    yield* chunks(rows);
  }
}

// --------------------------------------------------------------------------------------------- ApiFnScan

const SCALAR_PARAM_TYPES = new Set(['Boolean', 'String', 'Integer', 'BigInt', 'Decimal', 'Float', 'Money', 'Picklist', 'DateTime', 'Date', 'Time', 'Duration', 'Binary']);

// A response property by name (exact, else case-insensitive); '' is the whole answer.
function responseProp(json, name) {
  if (name === '' || name == null) return json;
  if (!json || typeof json !== 'object') return undefined;
  if (Object.hasOwn(json, name)) return json[name];
  const low = name.toLowerCase();
  for (const k of Object.keys(json)) if (k.toLowerCase() === low) return json[k];
  return undefined;
}

// A JSON value of the answer as a value of column col (scalar shapes; 02 §9 (c)-(e)).
function jsonCell(v, col, env) {
  if (v === undefined || v === null) return null;
  switch (col.dt) {
    case 'guid': return String(v).toLowerCase();
    case 'bit': return v === true || v === 1 || v === 'true' || v === '1' ? 1 : 0;
    case 'int': case 'bigint': case 'float': case 'decimal': case 'money': {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case 'datetime': case 'date': {
      if (v instanceof Date) return v;
      const s = String(v);
      if (col.dt === 'date' && /^\d{4}-\d{2}-\d{2}/.test(s)) {
        const d = new Date(0);
        d.setUTCFullYear(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
        return d;
      }
      // types.js parseDate: an instant with Z or an offset is that instant; a date-time without one is session-tz
      // wall-clock time (01 §5.3), never the browser's zone
      let d;
      try {
        d = parseDate(s, { tz: env.tz, dateformat: env.dateformat });
        if (col.dt === 'date') return coerce(d, { dt: 'datetime' }, { dt: 'date' }, env);
      } catch {
        return null;
      }
      if (col.dto || d.tzo == null) return d;
      const x = new Date(d.getTime());
      if (d.tk) x.tk = d.tk;
      return x;
    }
    case 'string': case 'xml': return typeof v === 'object' ? JSON.stringify(v) : String(v);
    default: return typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
  }
}

// OldValue / NewValue of an AttributeAuditDetail as JSON keyed by logical name (02 §9 (b), see the notes above).
function auditJson(o) {
  if (!o || typeof o !== 'object') return null;
  const out = Object.create(null);
  for (const k of Object.keys(o)) {
    if (k.includes('@') || o[k] === null) continue;
    const m = /^_(.+)_value$/.exec(k);
    out[m ? m[1] : k] = o[k];
  }
  return JSON.stringify(out);
}

const isAuditCol = c => /^(oldvalues|newvalues)$/i.test(c.name || '');

// A Web API function as a table source (02 §9).
export class ApiFnScan extends PlanNode {
  constructor(o) {
    need(typeof o.name === 'string' && o.name !== '' && Array.isArray(o.args) && o.args.every(isCompiled) && Array.isArray(o.schema),
      'ApiFnScan({name, args, schema})');
    const shape = o.shape || 'scalar';
    oneOf(shape, ['entity', 'audit', 'object', 'array', 'scalar'], 'ApiFnScan shape');
    need(shape === 'scalar' ? o.prop == null : typeof o.prop === 'string', 'ApiFnScan: prop names the response property (null for scalar)');
    need(!(shape === 'entity' || shape === 'audit') || typeof o.mapRow === 'function', 'ApiFnScan: entity and audit shapes need mapRow');
    const bound = o.bound || null;
    need(!bound || (typeof bound.entitySet === 'string' && (bound.id == null || isCompiled(bound.id))), 'ApiFnScan: bound is {entitySet, id} or null');
    super(base('ApiFnScan', o, [], o.schema, true));
    this.name = o.name;
    this.args = o.args;
    this.msg = o.msg || null;
    this.bound = bound ? { entitySet: bound.entitySet, id: bound.id || null } : null;
    this.shape = shape;
    this.prop = shape === 'scalar' ? null : o.prop;
    this.mapRow = o.mapRow || null;
    this.api = o.api || null;
    this.literals = o.literals || null;
    this.plans = plansOf(o.args, bound && bound.id);
  }

  detail() { return `${this.name}(${listText(this.args)})`; }
  props() {
    const out = [prop('Function', this.name), prop('Response shape', this.shape)];
    if (this.prop) out.push(prop('Response property', this.prop));
    if (this.bound) out.push(prop('Bound to', this.bound.entitySet + (this.bound.id ? `(${textOf(this.bound.id)})` : '')));
    if (this.args.length) {
      const ps = this.msg && Array.isArray(this.msg.params) ? this.msg.params : [];
      out.push(prop('Parameters', this.args.map((a, i) => (ps[i] ? `${ps[i].name} = ${textOf(a)}` : textOf(a))).join(', ')));
    }
    out.push(prop('Columns', visibleNames(this.schema)));
    return out;
  }

  // The table of an entity-reference argument from its lineage (or the parameter type naming a table).
  refEntity(arg, type, env) {
    const ref = arg && arg.ref;
    if (ref && ref.entity) return String(ref.entity).toLowerCase();
    if (ref && typeof ref.entityFn === 'function') {
      const t = ref.entityFn(EMPTY, env);
      if (t) return String(t).toLowerCase();
    }
    if (type && type !== 'EntityReference' && !SCALAR_PARAM_TYPES.has(type) && env.meta && typeof env.meta.findEntity === 'function') {
      const e = env.meta.findEntity(type);
      if (e) return e.logicalName;
    }
    return null;
  }

  // guidParam, enumParam or dateParam from the literals option, env.literals or the api object (see the notes above);
  // without one the parameter cannot be sent with its type: an internal error naming the missing factory.
  literal(env, api, name, p) {
    for (const src of [this.literals, env.literals, api]) if (src && typeof src[name] === 'function') return src[name];
    throw new Error(`Internal error: ${this.name} needs api.js's ${name} to send its ${p.type} parameter ${p.name} (env.literals is not set).`);
  }

  // JSON.parse of an argument text; text that is not valid JSON raises a SqlError naming the parameter.
  parseJson(text, p) {
    try {
      return JSON.parse(text);
    } catch (e) {
      const why = String((e && e.message) || 'invalid JSON').replace(/\.$/, '');
      throw plainErr(`The argument for parameter ${p.name} of ${this.name} is not valid JSON: ${why}.`);
    }
  }

  // One parameter value in the form api.fn sends (see the notes above).
  encode(v, arg, p, env, api) {
    const type = p.type || '';
    if (v == null) return null;
    if (arg && (arg.dt === 'any' || arg.dt === 'null')) v = variantValue(v);
    const arr = type === 'StringArray' ? 'String' : type.endsWith('[]') ? type.slice(0, -2) : null;
    if (arr != null) {
      let list = v;
      if (!Array.isArray(list)) {
        if (typeof list === 'string' && /^\s*\[/.test(list)) list = this.parseJson(list, p);
        else list = [list];
        if (!Array.isArray(list)) list = [list];
      }
      return list.map(x => this.encode(x, null, { name: p.name, type: arr }, env, api));
    }
    switch (type) {
      case 'Guid': return this.literal(env, api, 'guidParam', p)(String(v).toLowerCase());
      case 'Boolean': return v === true || v === 1 || v === 'true' || v === '1';
      case 'Integer': case 'BigInt': case 'Decimal': case 'Float': case 'Money': case 'Picklist':
        return typeof v === 'number' ? v : Number(coerce(v, arg || { dt: 'string' }, { dt: 'float' }, env));
      case 'String': return typeof v === 'string' ? v : toSqlString(v, arg || { dt: 'any' }, { tz: env.tz });
      case 'DateTime': {
        // an instant (api.fn writes it with toISOString); a date or a string converts as CAST(… AS datetime)
        if (v instanceof Date && (!arg || arg.dt === 'datetime')) return v;
        return coerce(v, arg || (v instanceof Date ? { dt: 'datetime' } : { dt: 'string' }), { dt: 'datetime' }, env);
      }
      case 'Date': {
        // Edm.Date is the URL literal yyyy-MM-dd, never an ISO instant: the date of the value (a date's UTC fields)
        const d = v instanceof Date && arg && arg.dt === 'date' ? v
          : coerce(v, arg || (v instanceof Date ? { dt: 'datetime' } : { dt: 'string' }), { dt: 'date' }, env);
        const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
        return this.literal(env, api, 'dateParam', p)(`${String(y).padStart(4, '0')}-${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`);
      }
      case 'Time': case 'Duration': case 'Binary': return v;
      default: break;
    }
    const entity = typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? this.refEntity(arg, type, env) : null;
    if (entity) {
      const id = v.toLowerCase();
      const info = env.meta && typeof env.meta.findEntity === 'function' ? env.meta.findEntity(entity) : null;
      if (info && info.entitySetName) return { '@odata.id': `${info.entitySetName}(${id})` };
      const out = Object.create(null);
      out['@odata.type'] = `Microsoft.Dynamics.CRM.${entity}`;
      out[(info && info.primaryIdAttribute) || entity + 'id'] = id;
      return out;
    }
    if (typeof v === 'string' && /^\s*[[{]/.test(v)) return this.parseJson(v, p);
    if (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) && type !== 'EntityReference' && type !== 'Entity') {
      return this.literal(env, api, 'enumParam', p)(`Microsoft.Dynamics.CRM.${type}`, v);
    }
    if (type === 'EntityReference' || (env.meta && typeof env.meta.findEntity === 'function' && env.meta.findEntity(type))) {
      throw plainErr(`The argument for parameter ${p.name} of ${this.name} must be a record reference: use CREATELOOKUP('<table>', <id>).`);
    }
    return v;
  }

  // The request parameters: Map<name, value> in msg.params order (a last collection parameter takes the remaining
  // arguments).
  params(values, env, api) {
    const ps = this.msg && Array.isArray(this.msg.params) ? this.msg.params : [];
    if (values.length && !ps.length) throw new TypeError(`ApiFnScan ${this.name}: arguments need msg.params`);
    const out = new Map();
    for (let i = 0; i < ps.length && i < values.length; i++) {
      const p = ps[i];
      const rest = i === ps.length - 1 && values.length > ps.length;
      if (rest && !(p.type === 'StringArray' || String(p.type || '').endsWith('[]'))) throw new TypeError(`ApiFnScan ${this.name}: more arguments than parameters`);
      if (rest) {
        out.set(p.name, values.slice(i).filter(x => x != null).map((x, j) => this.encode(x, this.args[i + j], { name: p.name, type: p.type === 'StringArray' ? 'String' : p.type.slice(0, -2) }, env, api)));
        break;
      }
      const v = this.encode(values[i], this.args[i], p, env, api);
      if (v == null && p.optional) continue;
      out.set(p.name, v);
    }
    return out;
  }

  // One call of the function (counted against maxRequests).
  async call(api, params, bound, env) {
    countRequests(env, 1);
    this.stats.requests++;
    const opts = { signal: env.signal };
    if (bound) opts.bound = bound;
    return api.fn(this.name, params, opts);
  }

  async *execute(env) {
    const api = this.api || env.api;
    if (!api || typeof api.fn !== 'function') throw new TypeError(`ApiFnScan ${this.name}: no api (env.api or the api option)`);
    await preList(this.args, ONE_ROW, env);
    const values = this.args.map(a => a.fn(EMPTY, env));
    const params = this.params(values, env, api);
    let bound = null;
    if (this.bound) {
      if (this.bound.id) {
        await preOf(this.bound.id, ONE_ROW, env);
        const id = this.bound.id.fn(EMPTY, env);
        if (id == null) return;
        bound = { entitySet: this.bound.entitySet, id: String(variantValue(id)).toLowerCase() };
      } else bound = { entitySet: this.bound.entitySet };
    }
    const json = await this.call(api, params, bound, env);
    this.others(json, env);
    const sch = this.schema, rows = [];
    switch (this.shape) {
      case 'scalar':
        rows.push(sch.map(c => jsonCell(responseProp(json, c.srcKey ?? c.name), c, env)));
        break;
      case 'object': {
        const o = responseProp(json, this.prop);
        if (o == null) break;
        const pre = this.prop + '_';
        rows.push(sch.map((c, i) => {
          if (i === 0) return typeof o === 'object' ? JSON.stringify(o) : jsonCell(o, c, env);
          const key = c.srcKey ?? (c.name.toLowerCase().startsWith(pre.toLowerCase()) ? c.name.slice(pre.length) : c.name);
          return jsonCell(responseProp(o, key), c, env);
        }));
        break;
      }
      case 'array': {
        const a = responseProp(json, this.prop);
        if (Array.isArray(a)) for (const x of a) rows.push(sch.map((c, i) => (i === 0 ? jsonCell(x, c, env) : null)));
        else if (a != null) rows.push(sch.map((c, i) => (i === 0 ? jsonCell(a, c, env) : null)));
        break;
      }
      case 'entity': {
        const v = responseProp(json, this.prop);
        const list = Array.isArray(v) ? v : v && Array.isArray(v.Entities) ? v.Entities : v && Array.isArray(v.value) ? v.value : v ? [v] : [];
        for (const e of list) rows.push(this.mapRow(e, sch, env));
        break;
      }
      default:
        yield* this.auditRows(api, params, bound, json, env);
        return;
    }
    yield* chunks(rows);
  }

  // Shape (b): one row per AuditDetail, following PagingInfo while MoreRecords is true; each page's rows are yielded
  // before the next page is requested, so a Top above sends no further page.
  async *auditRows(api, params, bound, json, env) {
    const sch = this.schema;
    const auditIdx = [], auditCols = [];
    let oldIdx = -1, newIdx = -1;
    sch.forEach((c, i) => {
      if (isAuditCol(c)) { if (/^old/i.test(c.name)) oldIdx = i; else newIdx = i; return; }
      auditIdx.push(i);
      auditCols.push(c);
    });
    const ps = this.msg && Array.isArray(this.msg.params) ? this.msg.params : [];
    const paging = ps.find(p => p.name.toLowerCase() === 'paginginfo');
    const autoPage = !!paging && !params.has(paging.name);
    let page = 1, size = 0;
    for (;;) {
      const rows = [];
      const v = responseProp(json, this.prop);
      const details = v && Array.isArray(v.AuditDetails) ? v.AuditDetails : v && (v.AuditRecord || v['@odata.type']) ? [v] : [];
      if (page === 1) size = details.length;
      for (const d of details) {
        const mapped = d && d.AuditRecord ? this.mapRow(d.AuditRecord, auditCols, env) : auditCols.map(() => null);
        const row = new Array(sch.length).fill(null);
        auditIdx.forEach((i, j) => { row[i] = mapped[j] ?? null; });
        if (oldIdx >= 0) row[oldIdx] = d ? auditJson(d.OldValue) : null;
        if (newIdx >= 0) row[newIdx] = d ? auditJson(d.NewValue) : null;
        rows.push(row);
      }
      yield* chunks(rows);
      if (!autoPage || !v || v.MoreRecords !== true || !details.length) break;
      page++;
      checkSignal(env);
      params.set(paging.name, { PageNumber: page, Count: size || 5000, PagingCookie: v.PagingCookie ?? null, ReturnTotalRecordCount: false });
      json = await this.call(api, params, bound, env);
    }
  }

  // The warning for the other array and object properties of the answer (02 §9: a TVF shows the first).
  others(json, env) {
    if (this.shape === 'scalar' || this.prop === '' || !json || typeof json !== 'object') return;
    const low = this.prop.toLowerCase();
    const more = Object.keys(json).filter(k => !k.startsWith('@') && k.toLowerCase() !== low && json[k] && typeof json[k] === 'object');
    if (more.length) emitWarn(env, `${this.name} also returned ${more.join(', ')}; run EXEC ${this.name} to see every result.`);
  }
}
