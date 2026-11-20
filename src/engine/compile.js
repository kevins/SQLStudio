// Expression compiler (01 §7, §7.1, §6.1-§6.2; every expression form of §4.4 with the value
// rules of §5.1-§5.8 and the xml methods of §8.3): AST expressions -> closures over positional rows, compiled once
// per plan; scopes, name resolution and binder helpers; subqueries with an exact-identity memo; variables with
// lineage; projectSchema/shiftSchema. Pure: no DOM; numbered errors come from messages.js msg(); function semantics
// from functions.js (lookupFunction, bindScalar, bindXmlMethod), value semantics from types.js (coerce, castValue,
// cmp, eq, keyOf, arithOp, unaryOp, likeMatcher, collation).
//
// Notes (extensions of 01 §7 that the spec does not state):
//
// Exports
// - compileExpr(expr, scope, cx) -> Compiled; compilePredicate(expr, scope, cx) -> Compiled whose fn gives
//   true|false|null; projectSchema(inSchema, compiled, names) -> {schema, extra}; shiftSchema(schema, offset) ->
//   Column[] (01 §7). projectSchema: column i is named by names[i], a string (the alias or the 01 §7 default name;
//   '' unnamed) or {name, hidden: true, role?} for a hidden column the planner adds (the root pk and etag, carried
//   ORDER BY keys, 01 §6.1); it has compiled[i]'s static type and ref, and qual null; a pass-through (src set) also
//   copies qual, attr, role and ci_ai from inSchema[src] (never srcKey, which is FetchScan's). The companions of
//   pass-through columns are appended as hidden columns (their input indexes in `extra`, which Project emits after
//   the expressions) and `companion` is rewritten to the new positions. shiftSchema returns the columns with every
//   `companion` index moved by offset (columns are never mutated; one without a companion is returned as it is).
//   projectSchema takes an optional fourth argument `{outermost: true}` for the outermost Project of a
//   statement that returns rows (01 §6.2): every column whose compiled ref is {entityFn} gets the ref {poly: true}
//   and a hidden role-'type' companion named `<name>type` (nvarchar(128)) computed per row by entityFn(row, env); the
//   result then also has `exprs`, the compiled list with those companion expressions appended (Project({kid, exprs,
//   schema, extra}) evaluates exprs, then copies the input values at extra). Without it `exprs` is `compiled` itself.
//   An input companion is appended once even when several columns pass it through; the appended copies are hidden,
//   keep their name, qual and role, and lose their own companion and srcKey.
// - matchGroupKey(expr, scope) -> index | null (01 §7.1): scope is a post-aggregate scope (Scopes below); the index of
//   the GROUP BY key that expr equals, else null (also when expr does not bind: a binding error is left to the
//   compilation that follows). groupKey(expr, scope) -> string: the canonical key of 01 §7.1 (parser.js exprKey of
//   expr after every column reference is replaced by its resolved source column, so `a.name` and `name` give one key
//   when they bind to one column), computed against the pre-aggregation scope; it raises 207/209/4104 for a name
//   that does not bind; the planner builds group.keys and deduplicates GROUP BY items with it.
// - resolveColumn(parts, scope, cx = null, node = null) -> {depth, index, column} | null: the 01 §6.1 / §7.1 resolution
//   (innermost scope first, then outward; `schema.table.col` and `table.col` too). It raises 207 (unknown name), 209
//   (two sources of one scope) and 4104 (unknown qualifier), with did-you-mean `suggestions` (util.suggest over the
//   visible names in scope) and, for a part written in double quotes (node._dq, parser.js), the string literal
//   'mark' as a suggestion and `fix` (01 §2); 107 (q.*) is the planner's. With cx.errors the error is appended
//   and null returned. The planner resolves names for pushdown and column pruning through it. A qualified
//   name binds to the innermost scope that has a source with that qualifier; when that source lacks the column it
//   is 207 there (it never searches further out), as SQL Server binds it. Among several matches the visible columns
//   win over hidden ones (a hidden pk or companion never makes a name ambiguous); two matches of one source (one
//   qual) take the first. The messages carry the name as written and no 'Did you mean' text;
//   suggestions are whole replacements of the identifier (`a.name`, `[my col]`).
// - compileAssignment(name, op, expr, scope, cx) -> {fn: (row, env) => void, pre, plans, cols, outer} (01 §4.1, 02 §9
//   Variables): `SET @v op expr` and `SELECT @v op expr` (op '=', '+=', '-=', '*=', '/=', '%=', also &= |= ^=).
//   fn converts the value with castValue to the variable's declared type (its env.vars entry), adds the warning
//   `Value truncated to <n> characters when assigned to @s.` through env.warn when a string is cut, and stores
//   {value, ref}: for a uniqueidentifier or entityreference variable (Type entityref, types.js) the value's lineage
//   per value ({entity, pid?}: a {entity} ref as it is; a {poly} source's per-row target from its companion type
//   column; an {entityFn}/{pidFn} ref evaluated for the row, also {entity, pidFn}); a value without ref clears it.
//   CAST(x AS entityreference) of a uniqueidentifier is a pass-through of x (src kept), so `SET @id =
//   CAST(parentcustomerid AS entityreference)` stores the row's target table as the bare column does. Other variables keep no
//   ref. A variable that is not declared raises 137 (the parser checks first). The conversion's
//   allowed-ness is the implicit one, checked once at compile time against the declared type of cx.rt.vars (257,
//   206 or 529: `DECLARE @i int = GETDATE()` raises 257, as SQL Server), while the value rules are castValue's (a
//   string is cut to the declared length); the warning is added only when the cut part holds a character other than
//   a space (trailing spaces are dropped silently, as in 2628). The entry is updated in place (entry.value,
//   entry.ref); the declared DataType is entry.dataType when the session keeps it, else types.dataTypeOf(entry), and
//   the truncation warning and the lineage decision read the entry's declared Type (its dt fields, else dtOf of its
//   dataType), so an entry that carries only {dataType} warns and keeps a uniqueidentifier's lineage too. A NULL
//   value clears the ref.
// - combineErrors(errors) -> SqlError | null: one SqlError carrying the first error in source order (message,
//   pos, end, number, severity, state, code, suggestions, fix) and `errors` = all of them sorted by pos (stable);
//   null for an empty list. The planner raises it once the statement's binding is done.
//
// Compiled = {fn(row, env), pre: null | async (rows, env) => void, dt, prec?, scale?, len?, dto?, unicode?, fixed?,
//   small?, numeric?, entityref?, xmlNode?, json?, ref, src: number | null, isConst, name, +text, +coll, +collImplicit,
//   +ci_ai, +attr, +plans, +cols, +outer} (01 §7; '+' marks extensions):
//   - fn's row is the input row (positional, scope.schema); an outer reference reads env.outer[depth - 1][index].
//     isConst expressions read no row: the planner folds them with fn([], cx.rt).
//   - text: the expression's SQL text for explain() (the cx.source slice at its pos/end, else rendered from the AST).
//   - coll: the types.collation() object of a COLLATE (01 §5.2), which comparisons, Sort keys, DISTINCT and hashing
//     use as `ai`; ci_ai: true when the value is a ci_ai (metadata) column passed through unchanged. Both
//     propagate as SQL Server's collation precedence does: through parentheses, `+` on strings, CAST/CONVERT of a
//     string to a string type, CASE/COALESCE/ISNULL results and string-valued functions of such an argument; two
//     different explicit collations in one comparison raise `Cannot resolve the collation conflict between "A" and
//     "B" in the equal to operation.` (SQL Server 468, unnumbered here: MESSAGES has no row); COLLATE on a non-string
//     raises `Expression type int is invalid for COLLATE clause.` (SQL Server 447, unnumbered).
//     Function arguments (extension of 01 §8 argTypes): a call's string operations use the collation that
//     SQL Server's precedence gives its string arguments (an explicit COLLATE on any of them wins, two different
//     explicit ones raise the 468 text naming the function in lower case; else the one implicit Column.coll; none when
//     two different implicit ones meet). That collation travels to functions.js as `coll` (+`collImplicit`) on the
//     argType of every string argument, beside ci_ai and attr, for functions.js to use as `ai` (cmp, eq, keyOf,
//     likeMatcher and the per-unit matching of REPLACE, CHARINDEX, PATINDEX, TRANSLATE and TRIM/LTRIM/RTRIM with
//     characters; NULLIF, GREATEST and LEAST compare in it, as `a = b` does); aggregate argTypes (MIN, MAX,
//     APPROX_COUNT_DISTINCT) carry it the same way. Guard: those functions (and the three aggregates) are probed once
//     per functions.js entry with arguments typed Latin1_General_CS_AS (BIN2 for the ordering ones); while an entry
//     still compares in the org collation, a call whose collation differs from the org collation (_CS, _AS on an AI
//     org, _BIN; for GREATEST, LEAST, MIN and MAX also another sort locale) raises `REPLACE() does not support the
//     collation Latin1_General_CS_AS yet: it would compare in the organization collation. Compare with COLLATE
//     outside the function instead.` rather than returning a case-insensitive result. The probe passes, and the guard
//     never fires, once functions.js honours argTypes coll.
//     Column.coll (extension of 01 §6.1): projectSchema gives a string column the coll of its expression, so a
//     derived table, CTE or subquery column defined with COLLATE keeps its collation in the enclosing query, as in SQL
//     Server (`SELECT DISTINCT n FROM (SELECT name COLLATE Latin1_General_CS_AS AS n FROM account) d` is
//     case-sensitive; exec.js reads Column.coll for Distinct, SetOp, HashAggregate and join keys). A reference to such
//     a column has that coll with SQL Server's implicit label (+collImplicit: true on the Compiled): an explicit
//     COLLATE of the expression wins over it, two different implicit collations in a comparison raise the conflict,
//     and in `+`, CASE and string functions they give no collation (SQL Server's no-collation label; SQL Server then
//     raises the conflict only when that result is compared, SQL Studio compares it with the org collation). An
//     implicit collation meeting an org-collated column uses the implicit one (SQL Server, which labels base columns
//     implicit too, raises the conflict there).
//   - attr: the source Column's AttrInfo when src is set (functions.js argTypes read attr, ci_ai and json).
//   - plans: PlanNode[] of the subqueries inside the expression, in source order (operators list them in explain()).
//   - cols: sorted indexes of scope.schema (depth 0) the expression reads, including what its subqueries read from
//     it; outer: [{depth, index}] of its references to parent scopes (depth ≥ 1), deduplicated (column pruning,
//     02 §3 phase 8; correlation, phase 3c).
//   - A nodes() xmlmethod node (the planner compiles it for a `x.nodes(path) AS t(c)` table source, 02 §3
//     phase 2) gives a Compiled whose fn returns the matching nodes (an array, not a SQL value), with `bound` (the
//     functions.js bindXmlMethod result, for TvfScan's opts.bound) and `operand` (the Compiled operand x, for
//     TvfScan's args). sql:column in its path binds like a column reference of the scope it is compiled in: for an
//     APPLY right side the planner compiles it in a scope with an empty schema whose parent is the left input's
//     scope, so the references read env.outer (XML_NODES calls the getters with row null).
//
// Scopes: `{schema: Column[], parent: Scope | null}` (01 §7). The post-aggregate scope of a grouped block (its SELECT,
//   HAVING and ORDER BY, and the outer references of their subqueries, 01 §7.1) adds `group: {input /* the
//   pre-aggregation Scope */, keys: Map<groupKey, index>, count /* number of keys */, gid /* index of the gid column
//   in schema, or -1 */}`; its schema is HashAggregate's output (keys…, aggs…, gid). 01 §7's cx.groupKeys is this
//   group.keys: it lives on the scope, so that subqueries compiled with their own cx see the grouping of the block
//   they reference (an outer reference to a column that is neither a key nor inside an aggregate raises
//   8120/8121/8127 by the referencing clause). In post-aggregate compilation every sub-expression is first looked up
//   in group.keys (then it reads row[index]); aggregate calls go to cx.aggregates; a column reference left over
//   raises 8120 (select), 8121 (having) or 8127 (order) naming the column as `qual.name`. GROUPING(col) and
//   GROUPING_ID(…) read bits of row[group.gid] (n = group.count; 02 §3 phase 5); an argument that is no key raises
//   `Argument 1 of the GROUPING function does not match any of the expressions in the GROUP BY clause.`
//   Names resolve in a grouped scope through group.input.schema (never the aggregate output's names), and
//   its parent is the next scope out. The referencing clause of an outer reference is the cx.clause of the compile
//   call (compileExpr, compilePredicate, compileAssignment) whose scope is the grouped scope, else 'select'.
//   Outer aggregates: an aggregate whose argument columns all bind to one outer block (SQL Server's outer
//   aggregate, `SELECT (SELECT MAX(a.revenue)) FROM account a GROUP BY a.name`, `HAVING … > (SELECT COUNT(*) FROM t2
//   WHERE t2.x = MAX(t1.y))`) is computed by that block: compile.js passes the fn node to the aggregates collector of
//   the active compile call whose scope is that grouped block (the select list, HAVING or ORDER BY being compiled
//   when the subquery is planned) and reads the result as an outer reference (env.outer, a correlation of the
//   subquery). An aggregate planned outside any compile call over that block (an APPLY body, a derived table) stays
//   the aggregate of its own block. When the compile call over the block has no collector (the block is not
//   grouped), it raises 147 when that call compiles the block's WHERE, else
//   `MAX(a.revenue) aggregates only columns of an outer query, so it belongs to that query, which is not grouped. Add
//   GROUP BY to the outer query or compute the aggregate there.` (SQL Server would group that query; documented
//   deviation). Columns of two different outer blocks raise SQL Server's 8124 text
//   (unnumbered: MESSAGES has no row). An aggregate that also reads a column of its own block stays the aggregate of
//   that block (standard SQL; SQL Server raises 8124 there: documented deviation for 01 §9).
//   GROUPING(x) whose x does not bind raises that binding error (207 with suggestions, 209, 4104; collected
//   with cx.errors) before the GROUPING mismatch error, which is kept for an expression that binds but is no key.
//   An optional `aliases: Map<lower-case alias, index | index[]>` on a scope binds a whole ORDER BY item
//   (compileExpr/compilePredicate with cx.clause 'order' whose expression is a one-part column name) to that
//   scope.schema column before any source column (two select items with the alias raise 209); inside an ORDER BY
//   expression names bind to the scope's columns only, so `ORDER BY companyname + ''` raises 207. An optional
//   `aliasOnly: Set<index> | index[]` names the scope.schema columns that exist only as select-item outputs (the
//   alias columns next to the source and hidden ORDER BY columns of 01 §6.1, a scope without group): ordinary name
//   resolution and did-you-mean skip them, so with one consistent scope that holds the alias column `name`
//   (revenue AS name) and the hidden source column `name`, `ORDER BY name` sorts by the alias and `ORDER BY name +
//   ''` by account.name, and `ORDER BY companyname + ''` raises 207 although a column companyname exists.
//
// cx (01 §7 plus extensions): {planSubquery(query, scope) -> PlanNode (synchronous), aggregates?(fnNode) -> index,
//   windows?(fnNode) -> index, settings, meta, fns?, +rt, +clause, +xmlns, +source, +errors, +explainOnly}:
//   - aggregates: the planner's collector for the post-aggregate scope; it deduplicates by exprKey, compiles the
//     arguments against group.input and returns the aggregate's column index in the post-aggregate schema, which
//     exists (scope.schema[index]) when it returns. compile.js checks first: 130 for an aggregate inside an
//     aggregate argument or over a subquery, 8117/174/189 through functions.js; without cx.aggregates an aggregate
//     raises 147. windows: the same for window functions (the index of the function's column in the scope's
//     schema after its Window node); compile.js checks the OVER clause first (4112, 10752, 4113, 10759; aggregates
//     with OVER keep their aggregate argument checks); without cx.windows a window function raises 4108. (impl)
//     STRING_AGG (an ordered-set aggregate: entry.orderable) and APPROX_COUNT_DISTINCT (noOver) with OVER raise 4113,
//     as in SQL Server; a windowed aggregate over a subquery raises 130, one over an aggregate (`SUM(SUM(x)) OVER ()`
//     in a grouped block) is valid.
//     The argument type check compiles the arguments once against the input scope with a private cx (no
//     collectors, binding errors kept private, so the collector's own compile reports them once); it is skipped
//     when an argument does not bind. A window function inside an aggregate or window argument raises `Windowed
//     functions cannot be used in the context of another windowed function or aggregate.` (SQL Server 4109); a
//     ranking or offset function without OVER raises `The function 'ROW_NUMBER' must have an OVER clause.` (10753);
//     WITHIN GROUP on an aggregate other than STRING_AGG raises `The function 'SUM' may not have a WITHIN GROUP
//     clause.` (10757); a scalar function with OVER raises 4113. These SQL Server texts are unnumbered here, as are
//     the 4145 non-boolean condition, 447 and 468 above and 8124 (severity 16, state 1): MESSAGES has no rows for them
//     and every number compile.js raises comes from msg().
//   - groupKeys: 01 §7's cx.groupKeys is scope.group.keys here (Scopes above); a cx that carries groupKeys is
//     refused with a TypeError, so a caller written for the other form fails at once instead of compiling without
//     the GROUP BY rules.
//   - rt: the runtime env for plan-time folding (02 §3 ctx.rt): variable types and values, tz, dateformat, datefirst,
//     language, now, user, org. Function consts slots (01 §8) are folded with it; a folding error leaves the slot
//     undefined, so the error surfaces when the call runs (never for a CASE branch that is not taken). A
//     variable's static type comes from cx.rt.vars (an entry without `dt` but with `dataType` is typed by dtOf);
//     without the entry it raises 137. A consts slot holds only a constant expression in SQL Server's sense: no
//     variable or @@ global (they are isConst for the planner's plan-time folding, 01 §7, but never fill a slot),
//     and no RAND() or NEWID(); so CREATELOOKUP(@t, id) has the {entityFn} lineage of 01 §6.2, LEFT(name, @n) has
//     the length of name, and DATEADD(@part, …) raises 1023, as in SQL Server.
//   - clause: 'select'|'having'|'order'|'where'|'on'|'group'|'other' (default 'other'): picks 8120/8121/8127.
//   - xmlns: the WITH XMLNAMESPACES declarations in scope (XmlNs[]), passed to functions.js bindXmlMethod.
//   - source: the text the AST positions index (the parsed statement text), for Compiled.text.
//   - errors: SqlError[]; when given, 207, 209, 4104 and 8120/8121/8127 are appended instead of thrown and
//     compilation continues with a placeholder of dt 'any' whose fn throws that error (the planner raises
//     combineErrors(cx.errors)). An expression that contains a placeholder is itself a placeholder (no type
//     checks run on it, so one unbound name never causes a second, unrelated error).
//   - explainOnly: subquery plans come from cx.planSubquery as usual (the planner honours ctx.explainOnly) and are
//     never run at plan time.
//   - fns: an optional override {lookupFunction, bindScalar, runWindow, bindXmlMethod} of functions.js.
//
// Subqueries (01 §7 pre, §5.1)
// - compile.js does not import exec.js (00 §3 DAG: compile ← exec). It drives subquery plans through the PlanNode
//   interface only: run(env) (an async generator of Row[] batches whose return() closes the plan), schema,
//   prepare(rows, env) and plans.
// - Correlation: compile.js calls cx.planSubquery(query, scope) with the scope of the expression that contains the
//   subquery, and records every column reference that the planning of that subquery resolves (compileExpr,
//   compilePredicate, resolveColumn, groupKey and matchGroupKey all report to it) into `scope` or an ancestor: one at
//   distance k from `scope` is the outer value row[index] (k = 0) or env.outer[k - 1][index] at `pre` time. These are
//   the subquery's memo key parts (01 §7: exact identity per type, NULL a distinct tag), memoised per statement and
//   bounded to 10,000 keys per subquery; a subquery whose AST contains NEWID() is not memoised, nor one whose planning
//   compiled a NEWID() call anywhere (a CTE or derived-table body it inlines) or whose plan has `nondet: true` (the
//   planner's flag for nondeterminism compile.js cannot see). So the planner resolves every name of a subquery through
//   compile.js, synchronously inside planSubquery. An execution sees only the outer values its planning
//   recorded: an uncorrelated subquery runs with env.outer = [] and a correlated one with [row, …parents up to the
//   deepest recorded reference], so a correlation that a planner path bound without compile.js fails loudly (no
//   outer row) instead of reusing one result for every row when it reads a level the planning did not record
//   (always for an uncorrelated subquery); a missed column of a recorded level is not detected, so the planner must
//   still resolve every name through compile.js.
// - Uncorrelated (no recorded outer value): run once per statement on the first pre call; {rows} or {error} cached
//   in env.subq under the compiled subquery's own key object. Correlated: per batch, the memo keys not cached yet
//   run with env.outer = [row, ...env.outer] (at most dop at once: env.api.dop, else 4) after one
//   `await plan.prepare(rowsOfThoseKeys, env)` (IndexSpools load the batch's keys). Row limits per execution
//: EXISTS 1, scalar 2, IN/ANY/ALL every row. fn reads the caches synchronously; a cached error is thrown only
//   when read (an untaken CASE branch never raises 512). Only per-row errors are cached (SqlError and
//   DataverseError): an abort, a statement limit (code 'LIMIT'), a Blocked: refusal ('blocked'), an expired session
//   ('auth'), a network failure ('network') and any internal error end pre() at once, and no further execution of
//   that batch starts.
// - Conditional evaluation: CASE (its WHEN conditions, THEN results and ELSE), AND and OR (any number of
//   operands; a chain compiles and evaluates as one node, without recursion), and the bindLazy functions COALESCE,
//   ISNULL, IIF and CHOOSE run a subquery's pre only over the rows whose evaluation reaches it: their pre evaluates the
//   node over the batch, sets each row aside at the first kid it reaches whose subqueries are not prepared for it,
//   prepares those rows and evaluates them again (a row whose evaluation raises is left to fn, which raises the same
//   error). So `CASE WHEN a.statecode = 1 THEN (SELECT …) END` sends no request for the other rows and the requests
//   of a skipped branch never count against maxRequests. Subqueries of the first kid (always evaluated) and of an
//   expression with a volatile part (NEWID, RAND) run over the whole batch, as before.
// - Results: scalar (0 rows NULL, a second row 512; exactly one visible column, else 116, also for IN/ANY/ALL);
//   EXISTS (never NULL); IN/NOT IN and ANY/ALL by the 01 §5.1 rules, comparing in the common type of x and the column.
//   A subquery whose column has json: true (FOR JSON) gives json: true; FOR XML … TYPE gives xml.
// - Memo keys: strings verbatim ('a' and 'A' are two keys), numbers by value (0 and -0 one key), booleans,
//   Dates by getTime(), tk and own tzo, binary by its hex, a sql_variant by its base type name and base value, NULL
//   as its own tag, any other object (an xml node) by identity. Past 10,000 memo keys, and for every row of an
//   unmemoised subquery, the result is kept with the row object (a WeakMap of rows to {key, result}, several keys when
//   one row object was prepared under different env.outer values), so an evaluator that buffers rows across batches
//   (Window, Sort) reads every row it prepared, and the results live only as long as those rows. Without NEWID() the
//   rows of one batch with the same key run once. A fn read with no pre() for its row is an internal error (an
//   evaluator that skipped `await c.pre?.(batch, env)`).
// - The plan's visible columns are its non-hidden schema columns; the value is the first one.
//
// Other rules this module owns (01 §7, §7.1, §8): @@ globals as env reads (01 §7 list; @@FETCH_STATUS from
//   env.session.fetchStatus, @@CURSOR_ROWS from env.session.cursorRows); a variable read carries the run-time lineage
//   {entityFn: (row, env) => <the variable's stored ref entity>}; xmlmethod nodes through functions.js
//   bindXmlMethod(node, operandType, {xmlns: cx.xmlns, resolve}), resolve binding sql:column in the enclosing scope
//   (207/209/4104) and sql:variable (137); a nodes() column (xmlNode) used other than with value/query/exist/nodes or
//   IS [NOT] NULL raises 493; the predicate-in-value and value-in-predicate errors of 01 §7; argument counts and types
//   (174, 189, 313, 8144, 8116, 8117 through functions.js lookupFunction and entry dt; 402/8117/206 through types.js
//   arithOp/unaryOp); the string lengths and unicode flags of 01 §5; a FetchXML condition function left in
//   a client expression raises functions.js fetchConditionError(name); AT TIME ZONE resolves only as the postfix node
//   (lookupFunction {atTimeZone: true}).
// - @@ globals and their types: @@ROWCOUNT, @@ERROR, @@DATEFIRST, @@TRANCOUNT, @@SPID, @@FETCH_STATUS and
//   @@CURSOR_ROWS int; @@LANGUAGE and @@SERVERNAME nvarchar(128); @@VERSION nvarchar(300); @@IDENTITY
//   uniqueidentifier from env.identity.value with the run-time lineage of env.identity.ref ({entityFn, pidFn});
//   @@ERROR reads env.lastError (a number, or an error object's number); any other @@ name raises 137. A
//   uniqueidentifier variable's lineage is {entityFn, pidFn} over its stored ref; the outermost Project turns it into
//   {poly} (projectSchema above).
// - Literals: an integer literal by types.js literalType of its source digits (int, else numeric(p, 0)), a
//   decimal one numeric(p, s), a float one float; '…' varchar(n) and N'…' nvarchar(n) with n = its length (at least
//   1; beyond 8,000 / 4,000 characters max); 0x… varbinary(bytes). Literal-only subexpressions without variables,
//   columns, subqueries, RAND or NEWID are evaluated once per statement (cached on env.now, tz, dateformat,
//   datefirst, language, error, user and org), so a constant date string compared with a datetime column is parsed
//   once, not per row.
// - Comparisons convert both operands to types.commonType of their static types (206 at compile time; xml 305)
//   with coerce, skipping conversions that cannot change the result (a string with another string, a decimal with
//   another decimal, datetime with datetime2); `x IN (list)` compares pairwise (01 §5.1) and, when all items are
//   constants of one common type, through a key set; BETWEEN unifies its three operands; LIKE converts a non-string
//   operand to nvarchar and builds its matcher once for a constant pattern; CASE converts each result to the
//   unified type with coerce and evaluates only the branch it takes. CAST/CONVERT check at compile time that the
//   conversion is allowed at all (529, 206: `CAST(CAST(x AS date) AS int)` raises even over no rows, as SQL Server);
//   a NULL style gives NULL. Runtime errors carry the position of the innermost call, cast, operator or subquery
//   that raised them; compile-time errors the position of their node.
// - The default column name of a column reference (also through parentheses, COLLATE and a GROUP BY key that is
//   a bare column) is the column's name; every other expression is unnamed (''). The non-boolean error names the
//   token after the expression in cx.source (else its last token), cut to 128 characters.
// - AT TIME ZONE adds its 01 §5.5 UserLocal warning through cx.rt.warn at compile time when cx.rt has a local
//   tz, else through env.warn on the first evaluation in a local tz.
// - Unseeded RAND() is evaluated once per reference per statement: its value is kept per env.subq (shared by
//   every env derived from the statement's env: correlated executions, APPLY) and env.now.
// - An expression too deep for the engine's stack (a chain of thousands of `+` terms) raises SQL Server's 191,
//   as the parser does for nesting; explain() text renders parts nested deeper than 200 levels as '…'.
// - A scalar subquery value keeps only a plain {entity[, pid]} lineage ({poly}, whose per-row table lives in a
//   companion column, and function-valued refs, which read the subquery's own row, are dropped); the outermost
//   Project also turns {entity, pidFn} into {entity} (a result-set column never keeps a function of the env).

import { SqlError, tokenize } from './lexer.js';
import { msg } from './messages.js';
import { exprKey } from './parser.js';
import {
  commonType, coerce, castValue, cmp, eq, keyOf, arithOp, unaryOp, likeMatcher, collation, dtOf, dataTypeOf,
  literalType, fromHex, toHex, msgTypeName, typeName, variantValue, variantType, orgCollation,
} from './types.js';
import * as FUNCTIONS from './functions.js';
import { suggest, sqlName } from '../core/util.js';

const { SCALARS, AGGREGATES, WINDOWS } = FUNCTIONS;

// ------------------------------------------------------------------------------------------------- errors

// A numbered SqlError with the messages.js text, severity and state 1.
function E(number, ...args) {
  const m = msg(number, ...args);
  const e = new SqlError(m.message);
  e.number = m.number;
  e.severity = m.severity;
  e.state = 1;
  return e;
}

// A SQL Studio error without a SQL Server number (severity 16, state 1).
function plain(text) {
  const e = new SqlError(text);
  e.severity = 16;
  e.state = 1;
  return e;
}

// Gives a SqlError without a position the source range of node (the innermost failing expression wins).
function at(e, node) {
  if (e instanceof SqlError && e.pos == null && node && typeof node.pos === 'number') {
    e.pos = node.pos;
    e.end = typeof node.end === 'number' ? node.end : node.pos + 1;
  }
  return e;
}

const BIND_ERRORS = new Set([207, 209, 4104, 8120, 8121, 8127]);
const isBindError = e => e instanceof SqlError && BIND_ERRORS.has(e.number);
const isAbort = (err, env) => (err && err.name === 'AbortError') || !!(env && env.signal && env.signal.aborted);
const cut128 = s => (s.length > 128 ? s.slice(0, 128) : s);

const BOOL_HERE = 'A boolean expression is not allowed here. Use CASE WHEN ... THEN 1 ELSE 0 END instead.';
// SQL Server texts that messages.js has no rows for yet (raised unnumbered until it does).
const nonBool = near => plain(`An expression of non-boolean type specified in a context where a condition is expected, near '${near}'.`);
const nestedWindow = () => plain('Windowed functions cannot be used in the context of another windowed function or aggregate.');
const needsOver = up => plain(`The function '${up}' must have an OVER clause.`);
const noWithinGroup = up => plain(`The function '${up}' may not have a WITHIN GROUP clause.`);
const badCollate = type => plain(`Expression type ${type} is invalid for COLLATE clause.`);
const OUTER_MIX = 'Multiple columns are specified in an aggregated expression containing an outer reference. If an expression being aggregated contains an outer reference, then that outer reference must be the only column referenced in the expression.';
const OP_NAMES = new Map([['=', 'equal to'], ['<>', 'not equal to'], ['<', 'less than'], ['>', 'greater than'],
  ['<=', 'less than or equal to'], ['>=', 'greater than or equal to'], ['like', 'like'], ['between', 'between'],
  ['in', 'in'], ['distinct', 'is distinct from'], ['+', 'add'], ['case', 'case']]);

// ---------------------------------------------------------------------------------------------- types

// Type fields carried flat by Compiled and Column (01 §5 Type, §6.1).
const TF = ['prec', 'scale', 'len', 'dto', 'unicode', 'fixed', 'small', 'numeric', 'entityref', 'xmlNode', 'json'];
// The fields that decide a value conversion (the flags json, xmlNode and entityref never do).
const CONV_TF = ['prec', 'scale', 'len', 'dto', 'unicode', 'fixed', 'small'];

// A plain static Type with the type fields of x (a Type, a Column, a variable entry or a compile result).
function typeOf(x) {
  const t = { dt: (x && x.dt) || 'any' };
  if (x) for (const k of TF) if (x[k] != null && x[k] !== false) t[k] = x[k];
  return t;
}

const BIT = Object.freeze({ dt: 'bit' });
const INT = Object.freeze({ dt: 'int' });
const NVAR = Object.freeze({ dt: 'string', len: -1, unicode: true });
const NV128 = Object.freeze({ dt: 'string', len: 128, unicode: true });

// Whether a value of static type f needs coerce to compare in the common type T (conversions that cannot change a
// comparison are skipped: string with string, decimal with decimal, datetime kinds of the same offset model).
function needConv(f, T) {
  if (f.dt === 'null' || f.dt === 'any') return f.dt === 'null' ? false : T.dt !== 'any';
  if (f.dt !== T.dt) return true;
  if (f.dt === 'datetime') return !!f.dto !== !!T.dto;
  return false;
}

// Whether two Types convert values identically (CASE / COALESCE results need no coerce then).
function sameType(a, b) {
  if (a.dt !== b.dt) return false;
  for (const k of CONV_TF) if ((a[k] ?? null) !== (b[k] ?? null) && !(a[k] == null && b[k] === false) && !(a[k] === false && b[k] == null)) return false;
  return true;
}

// Probe values per static dt for the compile-time conversion checks (only type-level errors are kept).
const SAMPLES = new Map([
  ['int', 0], ['bigint', 0], ['decimal', 0], ['money', 0], ['float', 0], ['bit', 0], ['string', ''],
  ['binary', new Uint8Array([0])], ['xml', '<a/>'], ['datetime', new Date(0)], ['date', new Date(0)],
  ['time', '00:00:00'], ['guid', '00000000-0000-0000-0000-000000000000'],
]);
const PROBE_ENV = Object.freeze({ tz: Object.freeze({ utc: true, offset: () => 0 }), dateformat: 'mdy' });
const TYPE_ERRORS = new Set([206, 257, 529]);

// Raises at compile time when an explicit conversion from `from` to dataType is not allowed at all (529, 206).
function probeCast(from, dataType) {
  if (!SAMPLES.has(from.dt)) return;
  try {
    castValue(SAMPLES.get(from.dt), from, dataType, { tz: PROBE_ENV.tz, dateformat: 'mdy', defLen: 30 });
  } catch (e) {
    if (e instanceof SqlError && (e.number === 529 || e.number === 206)) throw e;
  }
}

// Raises at compile time when an implicit conversion (an assignment) from `from` to `to` is not allowed (257, 206, 529).
function probeImplicit(from, to) {
  if (!SAMPLES.has(from.dt) || to.dt === 'any') return;
  try {
    coerce(SAMPLES.get(from.dt), from, to, PROBE_ENV);
  } catch (e) {
    if (e instanceof SqlError && TYPE_ERRORS.has(e.number)) throw e;
  }
}

// --------------------------------------------------------------------------------------- compile state

// The column reads of one top-level compile call (Compiled.cols / outer).
const newAcc = () => ({ cols: new Set(), outer: new Map() });

function useCol(acc, depth, index) {
  if (depth === 0) acc.cols.add(index);
  else {
    const k = depth + ':' + index;
    if (!acc.outer.has(k)) acc.outer.set(k, { depth, index });
  }
}

// Active cx.planSubquery calls: {scope, refs: Map<'k:index', {k, index}>} (the subquery's correlation).
const RECORDERS = [];
// Active top-level compile calls: {scope, clause, cx} (the referencing clause of 8120/8121/8127; the aggregates
// collector of an outer aggregate's block).
const FRAMES = [];
const NO_SCOPE = Object.freeze({ schema: Object.freeze([]), parent: null });

// Lower-case names and qualifiers of a schema, computed once per schema array.
const NAMES = new WeakMap();
function namesOf(schema) {
  let n = NAMES.get(schema);
  if (!n || n.names.length !== schema.length) {
    n = {
      names: schema.map(c => String((c && c.name) ?? '').toLowerCase()),
      quals: schema.map(c => (c && c.qual != null ? String(c.qual).toLowerCase() : null)),
    };
    NAMES.set(schema, n);
  }
  return n;
}

// The number of parent steps from `from` up to `to`, or -1 when `to` is not in that chain.
function distance(from, to) {
  let k = 0;
  for (let s = from; s; s = s.parent, k++) if (s === to) return k;
  return -1;
}

// Reports a resolved column (found in scope `found` at `index`) to every active subquery recorder it is outer to.
function report(found, index) {
  for (let i = 0; i < RECORDERS.length; i++) {
    const r = RECORDERS[i];
    const k = distance(r.scope, found);
    if (k < 0) continue;
    const key = k + ':' + index;
    if (!r.refs.has(key)) r.refs.set(key, { k, index });
  }
}

// The clause of the innermost compile call over `scope` (8120/8121/8127), else cx.clause, else 'select'.
function clauseFor(scope, cx) {
  for (let i = FRAMES.length - 1; i >= 0; i--) if (FRAMES[i].scope === scope) return FRAMES[i].clause;
  return (cx && cx.clause) || 'select';
}

// ------------------------------------------------------------------------------------------ resolution

const schemaOf = s => (s.group && s.group.input ? s.group.input.schema : s.schema) || [];
const qualOf = c => (c && c.qual != null ? String(c.qual).toLowerCase() : null);
const label = c => (c.qual ? c.qual + '.' : '') + c.name;

const ALIAS_ONLY = new WeakMap();
// The scope.aliasOnly indexes of a scope without group as a Set, or null.
function aliasOnlyOf(s) {
  const a = s.aliasOnly;
  if (!a || (s.group && s.group.input)) return null;
  if (a instanceof Set) return a.size ? a : null;
  if (!Array.isArray(a) || !a.length) return null;
  let set = ALIAS_ONLY.get(a);
  if (!set) ALIAS_ONLY.set(a, (set = new Set(a)));
  return set;
}

// The visible column names of a scope chain (did-you-mean candidates), optionally of one qualifier.
function visibleNames(scope, qual) {
  const out = [];
  for (let s = scope; s; s = s.parent) {
    const skip = aliasOnlyOf(s);
    const schema = schemaOf(s);
    for (let i = 0; i < schema.length; i++) {
      const c = schema[i];
      if (c && !c.hidden && c.name && !(skip && skip.has(i)) && (qual === null || qualOf(c) === qual)) out.push(String(c.name));
    }
  }
  return out;
}

// The distinct qualifiers of a scope chain.
function qualifiers(scope) {
  const out = [];
  const seen = new Set();
  for (let s = scope; s; s = s.parent) {
    for (const c of schemaOf(s)) {
      if (c && c.qual != null && !seen.has(String(c.qual))) {
        seen.add(String(c.qual));
        out.push(String(c.qual));
      }
    }
  }
  return out;
}

// Adds suggestions and, for a double-quoted one-part name (QUOTED_IDENTIFIER ON), the 'mark' string fix (01 §2).
function withHints(e, parts, node, sugg) {
  const list = sugg.slice();
  if (node && Array.isArray(node._dq) && node._dq.length && parts.length === 1) {
    const lit = "'" + String(parts[0]).replace(/'/g, "''") + "'";
    list.unshift(lit);
    e.fix = { pos: node.pos, end: node.end, text: lit };
  }
  e.suggestions = [...new Set(list)].slice(0, 3);
  return at(e, node);
}

// 207 for a name of scope's chain (qualified: of the source `qual` found in scope `s`).
function unknownColumn(parts, scope, node, qual) {
  const name = String(parts[parts.length - 1]);
  const prefix = qual !== null ? parts.slice(0, -1).map(String).join('.') + '.' : '';
  const sugg = suggest(name, visibleNames(scope, qual)).map(n => prefix + sqlName(n));
  return withHints(E(207, name), parts, node, sugg);
}

// The index among several matches of one name: visible before hidden; two sources raise 209.
function pick(hits, schema, parts, node) {
  if (hits.length === 1) return hits[0];
  const vis = hits.filter(i => !schema[i].hidden);
  const cand = vis.length ? vis : hits;
  const q0 = qualOf(schema[cand[0]]);
  for (const i of cand) {
    if (qualOf(schema[i]) !== q0) {
      const name = String(parts[parts.length - 1]);
      const sugg = [...new Set(cand.map(j => schema[j].qual).filter(q => q != null))].map(q => sqlName(String(q)) + '.' + sqlName(name));
      throw withHints(E(209, name), parts, node, sugg);
    }
  }
  return cand[0];
}

// 8120 / 8121 / 8127 for a column of a grouped scope that is no GROUP BY key (01 §7.1).
function groupError(col, s, cx, node) {
  const clause = clauseFor(s, cx);
  const n = clause === 'having' ? 8121 : clause === 'order' ? 8127 : 8120;
  return at(E(n, label(col)), node);
}

// Resolves a column reference: {depth, index, column, scope} or throws 207/209/4104/8120/8121/8127 (01 §6.1, §7.1).
function resolveCore(parts, scope, cx, node) {
  if (!Array.isArray(parts) || !parts.length) throw new TypeError('compile.js: a column reference needs its parts.');
  const n = parts.length;
  const lname = String(parts[n - 1]).toLowerCase();
  const qual = n >= 2 ? String(parts[n - 2]).toLowerCase() : null;
  let depth = 0;
  for (let s = scope; s; s = s.parent, depth++) {
    const grouped = !!(s.group && s.group.input);
    const schema = grouped ? s.group.input.schema : s.schema;
    if (!schema || !schema.length) continue;
    const { names, quals } = namesOf(schema);
    const skip = aliasOnlyOf(s);
    let hits = null;
    let qualHere = false;
    for (let i = 0; i < names.length; i++) {
      if (skip && skip.has(i)) continue;
      if (qual !== null) {
        if (quals[i] !== qual) continue;
        qualHere = true;
      }
      if (names[i] === lname) (hits || (hits = [])).push(i);
    }
    if (!hits) {
      if (qualHere) throw unknownColumn(parts, s, node, qual);
      continue;
    }
    const index = pick(hits, schema, parts, node);
    if (grouped) {
      const keyIdx = s.group.keys ? s.group.keys.get(exprKey({ type: 'colref', d: 0, i: index })) : undefined;
      if (keyIdx === undefined) throw groupError(schema[index], s, cx, node);
      report(s, keyIdx);
      return { depth, index: keyIdx, column: s.schema[keyIdx], scope: s };
    }
    report(s, index);
    return { depth, index, column: schema[index], scope: s };
  }
  if (qual !== null) {
    const name = String(parts[n - 1]);
    const sugg = suggest(String(parts[n - 2]), qualifiers(scope)).map(q => sqlName(q) + '.' + sqlName(name));
    throw withHints(E(4104, parts.map(String).join('.')), parts, node, sugg);
  }
  throw unknownColumn(parts, scope, node, null);
}

// Resolves a column reference to its scope depth, index and Column (01 §6.1, §7.1); 207/209/4104.
export function resolveColumn(parts, scope, cx = null, node = null) {
  try {
    const r = resolveCore(parts, scope || NO_SCOPE, cx, node);
    return { depth: r.depth, index: r.index, column: r.column };
  } catch (e) {
    if (cx && Array.isArray(cx.errors) && isBindError(e)) {
      cx.errors.push(e);
      return null;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------- group keys

// The expression with every column reference replaced by its resolved {type: 'colref', d, i} (subqueries kept as
// written; ISJSON keywords stay names).
function keyTree(x, scope) {
  if (!x || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(y => keyTree(y, scope));
  switch (x.type) {
    case 'col': {
      const r = resolveCore(x.parts, scope, null, x);
      return { type: 'colref', d: r.depth, i: r.index };
    }
    case 'lit': case 'var': case 'datepart': case 'default': case 'subq': case 'exists': return x;
    case 'in': return x.query ? { type: 'in', e: keyTree(x.e, scope), query: x.query, not: x.not } : copyKey(x, scope);
    case 'quantified': return { type: 'quantified', op: x.op, quant: x.quant, l: keyTree(x.l, scope), query: x.query };
    case 'fn': {
      const entry = SCALARS.get(String(x.name).toUpperCase());
      const kw = entry && entry.keywords;
      if (!kw) return copyKey(x, scope);
      const out = copyKey({ ...x, args: [] }, scope);
      out.args = (x.args || []).map((a, i) => (kw[i] && a && a.type === 'col' && a.parts.length === 1 && kw[i].has(String(a.parts[0]).toUpperCase()) ? a : keyTree(a, scope)));
      return out;
    }
    default: return copyKey(x, scope);
  }
}

function copyKey(x, scope) {
  const out = {};
  for (const k of Object.keys(x)) {
    if (k === 'pos' || k === 'end' || k.charCodeAt(0) === 95) continue;
    const v = x[k];
    out[k] = v && typeof v === 'object' ? keyTree(v, scope) : v;
  }
  return out;
}

// The canonical GROUP BY key of an expression: exprKey after column resolution (01 §7.1).
export function groupKey(expr, scope) {
  return exprKey(keyTree(expr, scope || NO_SCOPE));
}

// The index of the GROUP BY key an expression equals in a post-aggregate scope, or null (01 §7.1).
export function matchGroupKey(expr, scope) {
  if (!scope || !scope.group || !scope.group.keys || !scope.group.input) return null;
  let k;
  try {
    k = groupKey(expr, scope.group.input);
  } catch (e) {
    if (e instanceof SqlError) return null;
    throw e;
  }
  const i = scope.group.keys.get(k);
  return i === undefined ? null : i;
}

// ------------------------------------------------------------------------------------- AST inspection

// The child expression nodes of an expression (never the inside of a subquery).
function kidsOf(x) {
  switch (x.type) {
    case 'bin': case 'distinctfrom': return [x.l, x.r];
    case 'neg': case 'not': case 'paren': case 'isnull': case 'collate': return [x.e];
    case 'between': return [x.e, x.lo, x.hi];
    case 'in': return x.list ? [x.e, ...x.list] : [x.e];
    case 'like': return x.escape ? [x.e, x.pattern, x.escape] : [x.e, x.pattern];
    case 'quantified': return [x.l];
    case 'case': {
      const o = x.operand ? [x.operand] : [];
      for (const [w, t] of x.whens || []) o.push(w, t);
      if (x.else) o.push(x.else);
      return o;
    }
    case 'cast': return x.style ? [x.e, x.style] : [x.e];
    case 'fn': {
      const o = (x.args || []).slice();
      if (x.over) {
        for (const p of x.over.partitionBy || []) o.push(p);
        for (const it of x.over.orderBy || []) o.push(it.expr);
      }
      for (const it of x.withinGroup || []) o.push(it.expr);
      return o;
    }
    case 'xmlmethod': return [x.e, ...(x.args || [])];
    default: return [];
  }
}

const INFO = new WeakMap();
// Flags of an expression tree: column references, aggregates (incl. GROUPING), window functions, subqueries; size
// counts its nodes other than parentheses and literals (each adds at least `{}` to its exprKey, keyHit).
function exprInfo(x) {
  if (!x || typeof x !== 'object') return { col: false, agg: false, win: false, sub: false, size: 0 };
  let r = INFO.get(x);
  if (r) return r;
  r = { col: false, agg: false, win: false, sub: false, size: x.type === 'paren' || x.type === 'lit' ? 0 : 1 };
  switch (x.type) {
    case 'col': r.col = true; break;
    case 'subq': case 'exists': case 'quantified': r.sub = true; break;
    case 'in': if (x.query) r.sub = true; break;
    case 'fn': {
      const up = String(x.name).toUpperCase();
      if (x.over) r.win = true;
      else if (AGGREGATES.has(up) || up === 'GROUPING' || up === 'GROUPING_ID') r.agg = true;
      break;
    }
    default: break;
  }
  for (const k of kidsOf(x)) {
    const i = exprInfo(k);
    r.col = r.col || i.col;
    r.agg = r.agg || i.agg;
    r.win = r.win || i.win;
    r.sub = r.sub || i.sub;
    r.size += i.size;
  }
  INFO.set(x, r);
  return r;
}

const NEWIDS = new WeakMap();
// Whether a query or expression AST calls NEWID() anywhere (its subqueries included).
function hasNewid(x) {
  if (!x || typeof x !== 'object') return false;
  if (NEWIDS.has(x)) return NEWIDS.get(x);
  let r = false;
  if (Array.isArray(x)) r = x.some(hasNewid);
  else if (x.type === 'fn' && String(x.name).toUpperCase() === 'NEWID') r = true;
  else {
    for (const k of Object.keys(x)) {
      if (k === 'pos' || k === 'end' || k.charCodeAt(0) === 95) continue;
      const v = x[k];
      if (v && typeof v === 'object' && hasNewid(v)) { r = true; break; }
    }
  }
  NEWIDS.set(x, r);
  return r;
}

const unparen = x => { while (x && x.type === 'paren') x = x.e; return x; };

// ------------------------------------------------------------------------------------- compile results

// An internal compile result: fn, static Type t and the facts its consumers combine.
function mk(fn, t, p = {}) {
  return {
    fn, t, pred: false, bad: null,
    pres: p.pres || [], plans: p.plans || [],
    ref: p.ref, src: p.src ?? null, name: p.name ?? '',
    isConst: !!p.isConst, pure: !!p.pure, vol: !!p.vol, cv: p.cv || null, usesVar: !!p.usesVar,
    coll: p.coll || null, collImplicit: !!(p.coll && p.collImplicit), ci_ai: !!p.ci_ai, attr: p.attr,
  };
}

// The collation facts of a read of Column col: its carried collation is implicit.
const colColl = col => (col && col.coll ? { coll: col.coll, collImplicit: true } : {});

// The placeholder of an expression that did not bind (cx.errors): dt 'any', fn throws the error.
function badC(err) {
  const c = mk(() => { throw err; }, { dt: 'any' });
  c.bad = err;
  return c;
}

function firstBad(list) {
  for (const c of list) if (c && c.bad) return c;
  return null;
}

// The combined facts of child results: pre functions, plans, isConst, pure, volatile, variable reads.
function kidsInfo(list) {
  const pres = [], plans = [];
  let isConst = true, pure = true, vol = false, usesVar = false;
  for (const c of list) {
    if (!c) continue;
    if (c.pres.length) pres.push(...c.pres);
    if (c.plans.length) plans.push(...c.plans);
    isConst = isConst && c.isConst;
    pure = pure && c.pure;
    vol = vol || c.vol;
    usesVar = usesVar || c.usesVar;
  }
  return { pres, plans, isConst, pure: pure && !vol, vol, usesVar };
}

// The pres of a node that evaluates its kids conditionally (CASE, AND, OR and the bindLazy functions COALESCE, ISNULL,
// IIF and CHOOSE), so a subquery runs only for the rows whose evaluation reaches it. make(kids) builds
// the node's function from kid results (it reads each kid's fn through fnOf/convFn/convResult). The returned pre
// evaluates that function over the batch with every kid that has pres replaced by a guard: the first time a row
// reaches such a kid, the row is set aside for it; the kid's pres then run over the rows set aside, and those rows
// are evaluated again, until no row reaches a kid it has not prepared. A row whose evaluation raises is dropped (fn
// raises the same error when it reads the row). Kid 0 is reached by every row, so with no pres beyond it, or with a
// volatile kid (NEWID, RAND: a second evaluation could take another branch), this is the plain list.
function lazyPres(kids, make, info) {
  let last = -1;
  for (let i = 0; i < kids.length; i++) if (kids[i] && kids[i].pres.length) last = i;
  if (last <= 0 || info.vol) return info.pres;
  const pres = kids.map(k => (k && k.pres.length ? preOf(k.pres) : null));
  const need = { i: -1 };
  let cur = null;
  const shadow = kids.map((k, i) => {
    if (!pres[i]) return k;
    const f = k.fn;
    return {
      ...k,
      fn: (row, env) => {
        if (!cur[i].has(row)) {
          need.i = i;
          throw need;
        }
        return f(row, env);
      },
    };
  });
  const probe = make(shadow);
  const lazy = async (rows, env) => {
    const done = pres.map(p => (p ? new Set() : null));
    let live = rows;
    while (live.length) {
      if (env && env.signal) env.signal.throwIfAborted();
      const groups = new Map();
      cur = done;
      try {
        for (let r = 0; r < live.length; r++) {
          const row = live[r];
          try {
            probe(row, env);
          } catch (e) {
            if (e !== need) {
              if (e && e.name === 'AbortError') throw e;
              continue;
            }
            const g = groups.get(need.i);
            if (g) g.push(row);
            else groups.set(need.i, [row]);
          }
        }
      } finally {
        cur = null;
      }
      if (!groups.size) return;
      live = [];
      for (const i of [...groups.keys()].sort((a, b) => a - b)) {
        const rs = groups.get(i);
        await pres[i](rs, env);
        const d = done[i];
        for (let r = 0; r < rs.length; r++) {
          d.add(rs[r]);
          live.push(rs[r]);
        }
      }
    }
  };
  return [lazy];
}

// Wraps a run-time function so a SqlError it raises carries node's position.
function guard(fn, node) {
  if (!node || typeof node.pos !== 'number') return fn;
  return (row, env) => {
    try {
      return fn(row, env);
    } catch (e) {
      throw at(e, node);
    }
  };
}

// Caches a constant function's value per statement (env.now, tz, dateformat, datefirst, language, error, user, org).
function cached(f) {
  let has = false, val, k0, k1, k2, k3, k4, k5, k6, k7;
  return (row, env) => {
    if (!env) return f(row, env);
    if (has && env.now === k0 && env.tz === k1 && env.dateformat === k2 && env.datefirst === k3 && env.language === k4 &&
      env.error === k5 && env.user === k6 && env.org === k7) return val;
    const v = f(row, env);
    k0 = env.now; k1 = env.tz; k2 = env.dateformat; k3 = env.datefirst; k4 = env.language;
    k5 = env.error; k6 = env.user; k7 = env.org;
    val = v;
    has = true;
    return v;
  };
}

// A function evaluated once per statement (unseeded RAND(), 01 §7): its value is kept for env.subq, the statement
// cache that every env derived from the statement's env shares (correlated executions, APPLY), and env.now.
function perStatement(f) {
  let has = false, val, k0, k1;
  return (row, env) => {
    const a = env ? env.subq || env : null, b = env ? env.now : undefined;
    if (has && a === k0 && b === k1) return val;
    const v = f(row, env);
    k0 = a;
    k1 = b;
    val = v;
    has = true;
    return v;
  };
}

// The function to read a child result with: cached when it is a constant subtree and its parent is not.
const fnOf = (c, parentPure) => (c.pure && !c.cv && !parentPure ? cached(c.fn) : c.fn);

// The child value converted to T (for a comparison), cached when the child is constant.
function convFn(c, T, parentPure) {
  if (!needConv(c.t, T)) return fnOf(c, parentPure);
  const f = c.t;
  const base = c.cv ? null : c.fn;
  const g = c.cv ? ((v) => (row, env) => coerce(v, f, T, env))(c.cv.v) : (row, env) => coerce(base(row, env), f, T, env);
  return c.pure && !parentPure ? cached(g) : g;
}

// The child value converted to the unified result type T (CASE, 01 §5.1).
function convResult(c, T, parentPure) {
  if (c.t.dt === 'null') return () => null;
  const f0 = fnOf(c, parentPure);
  if (sameType(c.t, T)) return f0;
  const f = c.t;
  return (row, env) => coerce(f0(row, env), f, T, env);
}

const collName = c => String((c && c.name) || '').toLowerCase();

function collConflict(a, b, what) {
  const op = OP_NAMES.get(what) || what;
  return plain(`Cannot resolve the collation conflict between "${a.name}" and "${b.name}" in the ${op} operation.`);
}

// The collations of operands by SQL Server's collation precedence: {ex, im, clash}, where ex is a
// COLLATE of the expression, im the collation a column carries (Column.coll) and clash the first two different
// implicit ones that meet (else false); two different explicit ones raise the collation conflict.
function collLabels(list, what) {
  let ex = null, im = null, clash = false;
  for (const x of list) {
    if (!x || !x.coll) continue;
    if (x.collImplicit) {
      if (im && collName(im) !== collName(x.coll)) clash = clash || [im, x.coll];
      im = im || x.coll;
    } else {
      if (ex && collName(ex) !== collName(x.coll)) throw collConflict(ex, x.coll, what);
      ex = ex || x.coll;
    }
  }
  return { ex, im, clash };
}

// The `ai` argument of a comparison of operands (01 §5.2): the explicit collation, else the implicit one a column
// carries (two different ones conflict), else true for a ci_ai operand.
function cmpColl(list, what) {
  const { ex, im, clash } = collLabels(list, what);
  if (ex) return ex;
  if (clash) throw collConflict(clash[0], clash[1], what);
  if (im) return im;
  return list.some(x => x && x.ci_ai) ? true : undefined;
}

const collOf = (a, b, what) => cmpColl([a, b], what);

// The collation facts {coll, collImplicit} of a string result built from string operands: an explicit collation
// wins; otherwise the one implicit collation of the operands (none when two different ones meet, as SQL Server's
// no-collation label).
function resultColl(list, what) {
  const { ex, im, clash } = collLabels(list, what);
  if (ex) return { coll: ex, collImplicit: false };
  if (im && !clash) return { coll: im, collImplicit: true };
  return { coll: null, collImplicit: false };
}

// Three-valued NOT.
const not3 = v => (v === null ? null : !v);
// A predicate value from a function result (CONTAINS): true / false / null.
const truth = v => (v == null ? null : v === true || v === 1);

// Whether two lineages are the same (01 §6.2): one object, or one table with one partition id; per-row lineages
// (entityFn, pidFn) equal only themselves.
function refEq(a, b) {
  if (a === b) return true;
  if (!a || !b || a.poly || b.poly || a.entityFn || b.entityFn || a.pidFn || b.pidFn) return false;
  return !!a.entity && !!b.entity && String(a.entity).toLowerCase() === String(b.entity).toLowerCase() && (a.pid ?? null) === (b.pid ?? null);
}

// ----------------------------------------------------------------------------------------- dispatcher

// Compiles a value expression (a predicate here raises the 01 §7 boolean error).
function compValue(node, ctx) {
  const c = comp(node, ctx);
  if (!c.bad && c.pred) throw at(plain(BOOL_HERE), node);
  return c;
}

// Compiles a predicate (a value here raises the 01 §7 non-boolean error).
function compPred(node, ctx) {
  const c = comp(node, ctx);
  if (!c.bad && !c.pred) throw at(nonBool(nearText(node, ctx.cx)), node);
  return c;
}

function comp(node, ctx) {
  if (!node || typeof node !== 'object') throw new TypeError('compile.js: expected an expression node.');
  try {
    const g = ctx.scope.group;
    if (g && g.keys && g.input && node.type !== 'lit' && node.type !== 'paren') {
      const hit = keyHit(node, ctx);
      if (hit) return hit;
    }
    switch (node.type) {
      case 'lit': return litC(node);
      case 'default': throw E(156, 'DEFAULT');
      case 'col': return colC(node, ctx);
      case 'var': return varC(node, ctx);
      case 'bin': return binC(node, ctx);
      case 'neg': return negC(node, ctx);
      case 'not': return notC(node, ctx);
      case 'paren': return comp(node.e, ctx);
      case 'isnull': return isnullC(node, ctx);
      case 'between': return betweenC(node, ctx);
      case 'in': return node.query ? inSubC(node, ctx) : inListC(node, ctx);
      case 'like': return likeC(node, ctx);
      case 'exists': return existsC(node, ctx);
      case 'quantified': return quantC(node, ctx);
      case 'distinctfrom': return distinctC(node, ctx);
      case 'case': return caseC(node, ctx);
      case 'cast': return castC(node, ctx);
      case 'collate': return collateC(node, ctx);
      case 'fn': return fnC(node, ctx);
      case 'datepart': return constC(String(node.v).toLowerCase(), { dt: 'datepart' });
      case 'subq': return scalarSubC(node, ctx);
      case 'xmlmethod': return xmlC(node, ctx);
      default: throw new TypeError(`compile.js: unknown expression node '${node.type}'.`);
    }
  } catch (e) {
    throw at(e, node);
  }
}

// A constant result (literals, dateparts, ISJSON keywords).
function constC(v, t) {
  return mk(() => v, t, { isConst: true, pure: true, cv: { v } });
}

const KEY_LENS = new WeakMap();
// The length of the longest key of group.keys (cached per keys Map and size).
function maxKeyLen(keys) {
  let m = KEY_LENS.get(keys);
  if (!m || m.n !== keys.size) {
    let max = 0;
    for (const k of keys.keys()) if (typeof k === 'string' && k.length > max) max = k.length;
    KEY_LENS.set(keys, (m = { n: keys.size, max }));
  }
  return m.max;
}

// The GROUP BY key an expression of a post-aggregate scope equals, read from the aggregate output (01 §7.1). A
// subtree whose key would be longer than every key (2 characters per node at least) is not keyed, so compiling a
// large grouped expression stays linear in its size.
function keyHit(node, ctx) {
  const info = exprInfo(node);
  if (!info.col || info.agg || info.sub || info.win) return null;
  const g = ctx.scope.group;
  if (2 * info.size > maxKeyLen(g.keys)) return null;
  let k;
  try {
    k = groupKey(node, g.input);
  } catch (e) {
    if (e instanceof SqlError) return null;
    throw e;
  }
  const idx = g.keys.get(k);
  if (idx === undefined) return null;
  const col = ctx.scope.schema[idx];
  if (!col) throw new TypeError(`compile.js: group.keys names the index ${idx}, which the post-aggregate schema lacks.`);
  report(ctx.scope, idx);
  useCol(ctx.acc, 0, idx);
  const bare = unparen(node);
  return mk(row => row[idx], typeOf(col), {
    src: idx, ref: col.ref, attr: col.attr, ci_ai: !!col.ci_ai, ...colColl(col),
    name: bare && bare.type === 'col' ? String(col.name ?? bare.parts[bare.parts.length - 1]) : '',
  });
}

// ------------------------------------------------------------------------------------ leaves

function litC(node) {
  let t;
  let v = node.v;
  switch (node.dt) {
    case 'null': t = { dt: 'null' }; v = null; break;
    case 'int': case 'decimal': case 'float': t = literalType(node.raw != null ? String(node.raw) : String(node.v)); break;
    case 'string': {
      const s = String(v ?? '');
      const uni = !!node.unicode;
      const n = s.length;
      t = { dt: 'string', len: uni ? (n > 4000 ? -1 : Math.max(n, 1)) : (n > 8000 ? -1 : Math.max(n, 1)) };
      if (uni) t.unicode = true;
      v = s;
      break;
    }
    case 'binary': {
      const hex = String(v ?? '');
      t = literalType('0x' + hex);
      v = fromHex(hex);
      break;
    }
    default: throw new TypeError(`compile.js: unknown literal type '${node.dt}'.`);
  }
  return constC(v, t);
}

function colC(node, ctx) {
  const cx = ctx.cx;
  let r;
  try {
    r = resolveCore(node.parts, ctx.scope, cx, node);
  } catch (e) {
    if (cx.errors && isBindError(e)) {
      cx.errors.push(at(e, node));
      return badC(e);
    }
    throw e;
  }
  const col = r.column || {};
  if (col.xmlNode && ctx.xmlOk !== node) throw E(493, String(col.name ?? ''));
  useCol(ctx.acc, r.depth, r.index);
  const i = r.index, d = r.depth;
  const fn = d === 0 ? row => row[i] : (row, env) => env.outer[d - 1][i];
  return mk(fn, typeOf(col), {
    ref: col.ref, src: d === 0 ? i : null, name: String(col.name ?? ''), attr: col.attr, ci_ai: !!col.ci_ai, ...colColl(col),
  });
}

// The plan-time entry of a variable (cx.rt.vars), or undefined.
function rtVar(cx, name) {
  const vars = cx && cx.rt && cx.rt.vars;
  return vars && typeof vars.get === 'function' ? vars.get(name) : undefined;
}

// The declared static Type of a variable entry.
function varType(entry) {
  if (entry.dt) return typeOf(entry);
  if (entry.dataType) return typeOf(dtOf(entry.dataType, 1));
  return { dt: 'any' };
}

function readVar(env, name) {
  const e = env && env.vars && env.vars.get(name);
  if (!e || e.table) throw E(137, name);
  return e.value === undefined ? null : e.value;
}

// The run-time lineage of a uniqueidentifier variable's stored ref.
function varRef(name) {
  const refOf = env => {
    const e = env && env.vars && env.vars.get(name);
    return e && e.ref ? e.ref : null;
  };
  return {
    entityFn: (row, env) => { const r = refOf(env); return r && r.entity ? String(r.entity).toLowerCase() : null; },
    pidFn: (row, env) => { const r = refOf(env); return r && r.pid != null ? String(r.pid) : null; },
  };
}

const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';

// The @@ globals (01 §7): [name, Type, read(env), lineage?].
const GLOBALS = new Map([
  ['@@rowcount', [INT, env => (env && typeof env.rowcount === 'number' ? env.rowcount : 0)]],
  ['@@identity', [{ dt: 'guid' }, env => (env && env.identity && env.identity.value != null ? env.identity.value : null), true]],
  ['@@error', [INT, env => {
    const e = env && env.lastError;
    return typeof e === 'number' ? e : e && typeof e.number === 'number' ? e.number : 0;
  }]],
  ['@@datefirst', [INT, env => (env && env.datefirst != null ? env.datefirst : 7)]],
  ['@@language', [NV128, env => (env && env.language) || 'us_english']],
  ['@@trancount', [INT, () => 0]],
  ['@@version', [{ dt: 'string', len: 300, unicode: true }, env => `SQL Studio ${VERSION} on Dataverse ${(env && env.org && env.org.version) || 'unknown'}`]],
  ['@@servername', [NV128, env => (env && env.org && env.org.host) || null]],
  ['@@spid', [INT, () => 0]],
  ['@@fetch_status', [INT, env => (env && env.session && typeof env.session.fetchStatus === 'number' ? env.session.fetchStatus : -1)]],
  ['@@cursor_rows', [INT, env => (env && env.session && typeof env.session.cursorRows === 'number' ? env.session.cursorRows : 0)]],
]);

const identityRef = () => ({
  entityFn: (row, env) => { const r = env && env.identity && env.identity.ref; return r && r.entity ? String(r.entity).toLowerCase() : null; },
  pidFn: (row, env) => { const r = env && env.identity && env.identity.ref; return r && r.pid != null ? String(r.pid) : null; },
});

function varC(node, ctx) {
  const name = String(node.name).toLowerCase();
  if (name.startsWith('@@')) {
    const g = GLOBALS.get(name);
    if (!g) throw E(137, name);
    const read = g[1];
    return mk((row, env) => read(env), typeOf(g[0]), { isConst: true, usesVar: true, ref: g[2] ? identityRef() : undefined });
  }
  const entry = rtVar(ctx.cx, name);
  if (!entry || entry.table) throw E(137, name);
  const t = varType(entry);
  return mk((row, env) => readVar(env, name), t, { isConst: true, usesVar: true, ref: t.dt === 'guid' ? varRef(name) : undefined });
}

// ---------------------------------------------------------------------------------------- operators

const CMP_OPS = new Set(['=', '<>', '<', '>', '<=', '>=']);

function binC(node, ctx) {
  const op = String(node.op).toUpperCase();
  if (op === 'AND' || op === 'OR') return logicC(node, op, ctx);
  if (CMP_OPS.has(op)) return cmpC(node, ctx);
  return arithC(node, ctx);
}

// The operands of a chain of one logical operator, left to right (`a OR b OR c` and its parenthesised forms),
// collected without recursion, so a generated condition of thousands of terms compiles and evaluates in a loop.
function chainOf(node, op) {
  const out = [];
  const stack = [node];
  while (stack.length) {
    const x = stack.pop();
    const y = unparen(x);
    if (y && y.type === 'bin' && String(y.op).toUpperCase() === op) stack.push(y.r, y.l);
    else out.push(x);
  }
  return out;
}

// AND / OR over any number of operands, left to right with three-valued short-circuit (01 §5.1).
function logicC(node, op, ctx) {
  const ops = chainOf(node, op);
  const cs = new Array(ops.length);
  for (let i = 0; i < ops.length; i++) cs[i] = compPred(ops[i], ctx);
  const b = firstBad(cs);
  if (b) return b;
  const info = kidsInfo(cs);
  const stop = op === 'AND' ? false : true;
  const make = ks => {
    const F = ks.map(k => fnOf(k, info.pure));
    const n = F.length;
    if (n === 2) {
      const L = F[0], R = F[1];
      return (row, env) => {
        const a = L(row, env);
        if (a === stop) return stop;
        const x = R(row, env);
        if (x === stop) return stop;
        return a === null || x === null ? null : !stop;
      };
    }
    return (row, env) => {
      let unknown = false;
      for (let i = 0; i < n; i++) {
        const v = F[i](row, env);
        if (v === stop) return stop;
        if (v === null) unknown = true;
      }
      return unknown ? null : !stop;
    };
  };
  const fn = make(cs);
  // an operand's subqueries run only for the rows the operands before it leave undecided
  info.pres = lazyPres(cs, make, info);
  const c = mk(fn, BIT, info);
  c.pred = true;
  return c;
}

// The comparator of two compiled operands in their common type (01 §5.1): (row, env) => true|false|null.
function comparator(op, l, r, parentPure) {
  if (l.t.dt === 'xml' || r.t.dt === 'xml') throw E(305);
  const T = commonType(l.t, r.t);
  const ai = collOf(l, r, op);
  const L = convFn(l, T, parentPure), R = convFn(r, T, parentPure);
  switch (op) {
    case '=': return (row, env) => { const a = L(row, env); if (a == null) return null; const b = R(row, env); return b == null ? null : eq(a, b, T, ai); };
    case '<>': return (row, env) => { const a = L(row, env); if (a == null) return null; const b = R(row, env); return b == null ? null : !eq(a, b, T, ai); };
    case '<': return (row, env) => { const a = L(row, env); if (a == null) return null; const b = R(row, env); return b == null ? null : cmp(a, b, T, ai) < 0; };
    case '>': return (row, env) => { const a = L(row, env); if (a == null) return null; const b = R(row, env); return b == null ? null : cmp(a, b, T, ai) > 0; };
    case '<=': return (row, env) => { const a = L(row, env); if (a == null) return null; const b = R(row, env); return b == null ? null : cmp(a, b, T, ai) <= 0; };
    default: return (row, env) => { const a = L(row, env); if (a == null) return null; const b = R(row, env); return b == null ? null : cmp(a, b, T, ai) >= 0; };
  }
}

function cmpC(node, ctx) {
  const l = compValue(node.l, ctx), r = compValue(node.r, ctx);
  const b = firstBad([l, r]);
  if (b) return b;
  const info = kidsInfo([l, r]);
  const c = mk(guard(comparator(node.op, l, r, info.pure), node), BIT, info);
  c.pred = true;
  return c;
}

function arithC(node, ctx) {
  const l = compValue(node.l, ctx), r = compValue(node.r, ctx);
  const b = firstBad([l, r]);
  if (b) return b;
  const P = arithOp(node.op, l.t, r.t);
  const info = kidsInfo([l, r]);
  const L = fnOf(l, info.pure), R = fnOf(r, info.pure), f = P.fn;
  const t = typeOf(P.type);
  const o = { ...info };
  if (t.dt === 'string') {
    Object.assign(o, resultColl([l, r], '+'));
    o.ci_ai = !o.coll && ((l.ci_ai && l.t.dt === 'string') || (r.ci_ai && r.t.dt === 'string'));
  }
  return mk(guard((row, env) => f(L(row, env), R(row, env), env), node), t, o);
}

function negC(node, ctx) {
  const e = compValue(node.e, ctx);
  if (e.bad) return e;
  const U = unaryOp(node.op, e.t);
  const info = kidsInfo([e]);
  const F = fnOf(e, info.pure), f = U.fn;
  return mk(guard((row, env) => f(F(row, env), env), node), typeOf(U.type), info);
}

function notC(node, ctx) {
  const e = compPred(node.e, ctx);
  if (e.bad) return e;
  const info = kidsInfo([e]);
  const F = fnOf(e, info.pure);
  const c = mk((row, env) => not3(F(row, env)), BIT, info);
  c.pred = true;
  return c;
}

function isnullC(node, ctx) {
  const prev = ctx.xmlOk;
  ctx.xmlOk = unparen(node.e);
  let e;
  try {
    e = compValue(node.e, ctx);
  } finally {
    ctx.xmlOk = prev;
  }
  if (e.bad) return e;
  const info = kidsInfo([e]);
  const F = fnOf(e, info.pure);
  const c = mk(node.not ? (row, env) => F(row, env) != null : (row, env) => F(row, env) == null, BIT, info);
  c.pred = true;
  return c;
}

function noXml(list) {
  for (const c of list) if (c && c.t.dt === 'xml') throw E(305);
}

function betweenC(node, ctx) {
  const e = compValue(node.e, ctx), lo = compValue(node.lo, ctx), hi = compValue(node.hi, ctx);
  const b = firstBad([e, lo, hi]);
  if (b) return b;
  noXml([e, lo, hi]);
  const T = commonType(commonType(e.t, lo.t), hi.t);
  const ai = cmpColl([e, lo, hi], 'between');
  const info = kidsInfo([e, lo, hi]);
  const E0 = convFn(e, T, info.pure), LO = convFn(lo, T, info.pure), HI = convFn(hi, T, info.pure);
  const not = !!node.not;
  const fn = (row, env) => {
    const a = E0(row, env);
    if (a == null) return null;
    const x = LO(row, env), y = HI(row, env);
    const c1 = x == null ? null : cmp(a, x, T, ai) >= 0;
    const c2 = y == null ? null : cmp(a, y, T, ai) <= 0;
    const r = c1 === false || c2 === false ? false : c1 === null || c2 === null ? null : true;
    return not ? not3(r) : r;
  };
  const c = mk(guard(fn, node), BIT, info);
  c.pred = true;
  return c;
}

function inListC(node, ctx) {
  const x = compValue(node.e, ctx);
  const items = (node.list || []).map(it => compValue(it, ctx));
  const b = firstBad([x, ...items]);
  if (b) return b;
  noXml([x, ...items]);
  const info = kidsInfo([x, ...items]);
  const not = !!node.not;
  const pairs = items.map(it => {
    const T = commonType(x.t, it.t);
    return { T, ai: collOf(x, it, 'in'), X: convFn(x, T, info.pure), I: convFn(it, T, info.pure), it, need: needConv(x.t, T) };
  });
  let fn;
  const T0 = pairs.length ? pairs[0].T : null;
  const sameT = pairs.length >= 6 && pairs.every(p => p.it.isConst && p.it.pure && sameType(p.T, T0) && p.ai === pairs[0].ai);
  if (sameT) {
    // a key set of the constant items in their one common type (keyOf equality is eq's, 01 §5.2)
    const ai = pairs[0].ai;
    const X = pairs[0].X;
    const keys = cached((row, env) => {
      const set = new Set();
      let hasNull = false;
      for (const p of pairs) {
        const v = p.I(row, env);
        if (v == null) hasNull = true;
        else set.add(keyOf(v, T0, ai));
      }
      return { set, hasNull };
    });
    fn = (row, env) => {
      const a = X(row, env);
      if (a == null) return null;
      const k = keys(row, env);
      const r = k.set.has(keyOf(a, T0, ai)) ? true : k.hasNull ? null : false;
      return not ? not3(r) : r;
    };
  } else {
    const n = pairs.length;
    const X0 = fnOf(x, info.pure);
    const xt = x.t;
    // x converts once per row for each distinct common type of the items (slot), not once per item
    const slotTs = [];
    for (const p of pairs) {
      p.slot = -1;
      if (!p.need) continue;
      let s = slotTs.findIndex(t => sameType(t, p.T));
      if (s < 0) s = slotTs.push(p.T) - 1;
      p.slot = s;
    }
    const vals = new Array(slotTs.length).fill(null);
    const stamp = new Array(slotTs.length).fill(0);
    let gen = 0;
    fn = (row, env) => {
      const a0 = X0(row, env);
      if (a0 == null) return null;
      const g = ++gen;
      let sawNull = false;
      for (let i = 0; i < n; i++) {
        const p = pairs[i];
        const b2 = p.I(row, env);
        if (b2 == null) { sawNull = true; continue; }
        let a = a0;
        if (p.slot >= 0) {
          if (stamp[p.slot] !== g) {
            vals[p.slot] = coerce(a0, xt, p.T, env);
            stamp[p.slot] = g;
          }
          a = vals[p.slot];
        }
        if (eq(a, b2, p.T, p.ai) === true) return not ? false : true;
      }
      const r = sawNull ? null : false;
      return not ? not3(r) : r;
    };
  }
  const c = mk(guard(fn, node), BIT, info);
  c.pred = true;
  return c;
}

// A string-valued function of a compiled operand for LIKE (a non-string converts to nvarchar, 01 §5.1).
function strFn(c, parentPure) {
  if (c.t.dt === 'null') return () => null;
  const f = fnOf(c, parentPure);
  if (c.t.dt === 'string') return f;
  const t = c.t;
  return (row, env) => {
    const v = f(row, env);
    return v == null ? null : coerce(v, t, NVAR, env);
  };
}

function likeC(node, ctx) {
  const e = compValue(node.e, ctx), p = compValue(node.pattern, ctx);
  const x = node.escape ? compValue(node.escape, ctx) : null;
  const b = firstBad([e, p, x]);
  if (b) return b;
  noXml([e, p, x]);
  const ai = collOf(e, p, 'like');
  const info = kidsInfo([e, p, x]);
  const S = strFn(e, info.pure), P = strFn(p, info.pure), X = x ? strFn(x, info.pure) : null;
  const escClause = !!node.escape;
  const not = !!node.not;
  let fixed = null;
  if (p.cv && typeof p.cv.v === 'string' && (!x || (x.cv && (x.cv.v == null || typeof x.cv.v === 'string')))) {
    fixed = likeMatcher(p.cv.v, x ? x.cv.v : null, ai, escClause);
  } else if (p.cv && p.cv.v === null) {
    fixed = likeMatcher(null, null, ai, escClause);
  }
  const fn = fixed
    ? (row, env) => { const r = fixed(S(row, env)); return not ? not3(r) : r; }
    : (row, env) => {
      const m = likeMatcher(P(row, env), X ? X(row, env) : null, ai, escClause);
      const r = m(S(row, env));
      return not ? not3(r) : r;
    };
  const c = mk(guard(fn, node), BIT, info);
  c.pred = true;
  return c;
}

function distinctC(node, ctx) {
  const l = compValue(node.l, ctx), r = compValue(node.r, ctx);
  const b = firstBad([l, r]);
  if (b) return b;
  noXml([l, r]);
  const T = commonType(l.t, r.t);
  const ai = collOf(l, r, 'distinct');
  const info = kidsInfo([l, r]);
  const L = convFn(l, T, info.pure), R = convFn(r, T, info.pure);
  const not = !!node.not;
  const fn = (row, env) => {
    const a = L(row, env), x = R(row, env);
    const same = a == null ? x == null : x != null && eq(a, x, T, ai) === true;
    return not ? same : !same;
  };
  const c = mk(guard(fn, node), BIT, info);
  c.pred = true;
  return c;
}

function caseC(node, ctx) {
  const simple = !!node.operand;
  const op = simple ? compValue(node.operand, ctx) : null;
  const conds = [], results = [];
  for (const [w, t] of node.whens || []) {
    conds.push(simple ? compValue(w, ctx) : compPred(w, ctx));
    results.push(compValue(t, ctx));
  }
  const els = node.else ? compValue(node.else, ctx) : null;
  const all = els ? [...results, els] : results;
  const b = firstBad([op, ...conds, ...all]);
  if (b) return b;
  const typed = all.filter(c => c.t.dt !== 'null');
  if (!typed.length) throw E(8133);
  let T = typeOf(typed[0].t);
  for (let i = 1; i < typed.length; i++) T = commonType(T, typed[i].t);
  T = typeOf(T);
  const info = kidsInfo([op, ...conds, ...all]);
  const n = results.length;
  let tests = null;
  if (simple) {
    noXml([op, ...conds]);
    tests = conds.map(v => {
      const Ti = commonType(op.t, v.t);
      return { Ti, ai: collOf(op, v, '='), need: needConv(op.t, Ti) };
    });
  }
  // the kids in evaluation order ([operand,] when, then, …, [else]) and the CASE function over them (lazyPres)
  const make = ks => {
    let p = 0;
    const OPk = simple ? ks[p++] : null;
    const W = [], Rk = [];
    for (let i = 0; i < n; i++) {
      W.push(ks[p++]);
      Rk.push(ks[p++]);
    }
    const R = Rk.map(c => convResult(c, T, info.pure));
    const EL = els ? convResult(ks[p], T, info.pure) : null;
    if (simple) {
      const OP = fnOf(OPk, info.pure);
      const V = W.map((v, i) => convFn(v, tests[i].Ti, info.pure));
      const ot = op.t;
      return (row, env) => {
        const a0 = OP(row, env);
        if (a0 != null) {
          for (let i = 0; i < n; i++) {
            const ti = tests[i];
            const v = V[i](row, env);
            if (v == null) continue;
            if (eq(ti.need ? coerce(a0, ot, ti.Ti, env) : a0, v, ti.Ti, ti.ai) === true) return R[i](row, env);
          }
        }
        return EL ? EL(row, env) : null;
      };
    }
    const C = W.map(c => fnOf(c, info.pure));
    return (row, env) => {
      for (let i = 0; i < n; i++) if (C[i](row, env) === true) return R[i](row, env);
      return EL ? EL(row, env) : null;
    };
  };
  const kids = simple ? [op] : [];
  for (let i = 0; i < n; i++) kids.push(conds[i], results[i]);
  if (els) kids.push(els);
  const fn = make(kids);
  info.pres = lazyPres(kids, make, info);
  // §6.2: the ref of the non-NULL results when they all carry the same one; src when they all read one column
  const valued = all.filter(c => !(c.cv && c.cv.v === null));
  let ref;
  if (valued.length && valued.every(c => c.ref && refEq(c.ref, valued[0].ref))) ref = valued[0].ref;
  const src = ref !== undefined && els && all.every(c => c.src != null && c.src === all[0].src) ? all[0].src : null;
  const o = { ...info, ref, src };
  if (T.dt === 'string') {
    Object.assign(o, resultColl(all, 'case'));
    o.ci_ai = !o.coll && all.some(c => c.ci_ai && c.t.dt === 'string');
  }
  return mk(guard(fn, node), T, o);
}

// A CAST/CONVERT style value as castValue takes it (an integer; NULL stays NULL).
function styleNum(v) {
  const b = variantValue(v);
  if (b == null) return null;
  const n = typeof b === 'number' ? b : Number(b);
  return Number.isFinite(n) ? Math.trunc(n) : n;
}

// castValue options for an env: the style, the session tz and dateformat, TRY_ and the bigint warning.
function castOpts(env, style, tryIt) {
  const o = { tz: env ? env.tz : undefined, dateformat: env ? env.dateformat : undefined, try: tryIt, defLen: 30 };
  if (style != null) o.style = style;
  if (env && typeof env.warn === 'function') o.warn = text => env.warn(text);
  return o;
}

function castC(node, ctx) {
  const e = compValue(node.e, ctx);
  const s = node.style ? compValue(node.style, ctx) : null;
  const b = firstBad([e, s]);
  if (b) return b;
  const dataType = node.dataType;
  const t = typeOf(dtOf(dataType, 30));
  probeCast(e.t, dataType);
  const info = kidsInfo([e, s]);
  const F = fnOf(e, info.pure);
  const from = e.t;
  const tryIt = !!node.try;
  let fn;
  if (!s || s.cv) {
    const style = s ? styleNum(s.cv.v) : null;
    if (s && style == null) fn = () => null;
    else {
      let lastEnv = null, lastOpts = null;
      const opts = env => {
        if (!lastOpts || env !== lastEnv) {
          lastEnv = env;
          lastOpts = castOpts(env, style, tryIt);
        }
        return lastOpts;
      };
      fn = (row, env) => castValue(F(row, env), from, dataType, opts(env));
    }
  } else {
    const S = fnOf(s, info.pure);
    fn = (row, env) => {
      const st = styleNum(S(row, env));
      return st == null ? null : castValue(F(row, env), from, dataType, castOpts(env, st, tryIt));
    };
  }
  const o = { ...info, ref: t.entityref ? e.ref : undefined };
  // CAST(x AS entityreference) of a uniqueidentifier passes the value through with its lineage, so a {poly}
  // lookup keeps its per-row target table (src, the companions projectSchema appends); a string cast to a string type
  // keeps its collation (SQL Server's collation precedence)
  if (t.entityref && e.t.dt === 'guid' && e.src != null) { o.src = e.src; o.attr = e.attr; }
  if (t.dt === 'string' && e.t.dt === 'string') { o.coll = e.coll; o.collImplicit = e.collImplicit; o.ci_ai = e.ci_ai; }
  return mk(guard(fn, node), t, o);
}

function collateC(node, ctx) {
  const e = compValue(node.e, ctx);
  if (e.bad) return e;
  if (e.t.dt !== 'string' && e.t.dt !== 'null') throw badCollate(msgTypeName(e.t));
  const coll = collation(node.name);
  return { ...e, coll, collImplicit: false, ci_ai: false };
}

// --------------------------------------------------------------------------------------------- functions

const lookupFn = (cx, ...a) => ((cx.fns && cx.fns.lookupFunction) || FUNCTIONS.lookupFunction)(...a);
const bindFn = (cx, ...a) => ((cx.fns && cx.fns.bindScalar) || FUNCTIONS.bindScalar)(...a);
const bindXml = (cx, ...a) => ((cx.fns && cx.fns.bindXmlMethod) || FUNCTIONS.bindXmlMethod)(...a);

// The function name as written (for 195), without brackets, from cx.source; else the lower-case name.
function writtenName(node, cx) {
  const src = cx.source;
  if (typeof src === 'string' && typeof node.pos === 'number') {
    const part = String.raw`(?:\[(?:[^\]]|\]\])*\]|"(?:[^"]|"")*"|[^\s.(\[\]"]+)`;
    const m = new RegExp(String.raw`^\s*(${part}(?:\s*\.\s*${part})*)\s*\(`).exec(src.slice(node.pos, node.pos + 600));
    if (m) {
      const parts = m[1].split(/\s*\.\s*/).map(p => (p[0] === '[' ? p.slice(1, -1).replace(/\]\]/g, ']') : p[0] === '"' ? p.slice(1, -1).replace(/""/g, '"') : p));
      return parts.join('.');
    }
  }
  return (node.schema ? node.schema + '.' + node.name : String(node.name)).toLowerCase();
}

// Positions whose arguments carry the value of ISNULL / COALESCE / IIF / CHOOSE (the §6.2 pass-through src).
const PASS = new Map([['ISNULL', 0], ['COALESCE', 0], ['IIF', 1], ['CHOOSE', 1]]);

function passSrc(up, cs, ref) {
  if (ref === undefined || !PASS.has(up)) return null;
  let src = null;
  for (let i = PASS.get(up); i < cs.length; i++) {
    const c = cs[i];
    if (c.cv && c.cv.v === null) continue;
    if (c.src == null) return null;
    if (src === null) src = c.src;
    else if (src !== c.src) return null;
  }
  return src;
}

// The static Type of a compiled argument as functions.js takes it (Type fields plus json, ci_ai and attr; a string
// argument also carries the call's collation cc).
function argTypeOf(c, cc = null) {
  const t = { ...c.t };
  if (c.ci_ai) t.ci_ai = true;
  if (c.attr) t.attr = c.attr;
  if (cc && t.dt === 'string') {
    t.coll = cc.coll;
    if (cc.collImplicit) t.collImplicit = true;
  }
  return t;
}

// The collation of a call's string operations by SQL Server's collation precedence over its string arguments: an
// explicit COLLATE wins (two different ones raise 468), else the one implicit collation; null for none or when two
// different implicit ones meet.
function callColl(cs, what) {
  const strs = cs.filter(c => c && c.t.dt === 'string');
  if (!strs.length) return null;
  const { ex, im, clash } = collLabels(strs, what);
  if (ex) return { coll: ex, collImplicit: false };
  if (im && !clash) return { coll: im, collImplicit: true };
  return null;
}

// Whether a collation compares (order: also orders) differently from the org collation.
function nonOrgColl(c, order) {
  const o = orgCollation();
  if (c.bin || !c.ci || !!c.ai !== !!o.ai) return true;
  if (!order) return false;
  const a = String(c.locale || ''), b = String(o.locale || '');
  return a !== b && !(a.indexOf('-') < 0 && b.split('-')[0] === a && b.indexOf('-u-') < 0);
}

// Behaviour probes of the functions.js entries that compare or match strings: the call with every
// argument typed with `coll` gives `want` only when the entry honours argTypes coll.
const PROBE_CS = 'Latin1_General_CS_AS';
const PROBE_BIN = 'Latin1_General_BIN2';
const COLL_PROBES = new Map([
  ['NULLIF', { coll: PROBE_CS, args: ['a', 'A'], want: 'a' }],
  ['GREATEST', { coll: PROBE_BIN, args: ['a', 'B'], want: 'a', order: true }],
  ['LEAST', { coll: PROBE_BIN, args: ['a', 'B'], want: 'B', order: true }],
  ['REPLACE', { coll: PROBE_CS, args: ['ABC', 'b', 'x'], want: 'ABC' }],
  ['CHARINDEX', { coll: PROBE_CS, args: ['b', 'ABC'], want: '0' }],
  ['PATINDEX', { coll: PROBE_CS, args: ['%b%', 'ABC'], want: '0' }],
  ['TRANSLATE', { coll: PROBE_CS, args: ['ABC', 'b', 'x'], want: 'ABC' }],
  ['LTRIM', { coll: PROBE_CS, args: ['Aa', 'a'], want: 'Aa', min: 2 }],
  ['RTRIM', { coll: PROBE_CS, args: ['aA', 'a'], want: 'aA', min: 2 }],
  ['TRIM', { coll: PROBE_CS, args: ['a', 'aAa'], want: 'A', min: 2 }],
]);
const AGG_PROBES = new Map([
  ['MIN', { coll: PROBE_BIN, args: ['a', 'B'], want: 'B', order: true }],
  ['MAX', { coll: PROBE_BIN, args: ['a', 'B'], want: 'a', order: true }],
  ['APPROX_COUNT_DISTINCT', { coll: PROBE_CS, args: ['a', 'A'], want: '2' }],
]);
const COLL_AWARE = new WeakMap();

// Whether a functions.js entry honours the argTypes collation (its probe, run once per entry).
function collAware(entry, p, cx, agg) {
  let r = COLL_AWARE.get(entry);
  if (r !== undefined) return r;
  try {
    const coll = collation(p.coll);
    if (agg) {
      const ts = [{ dt: 'string', len: 1, coll }];
      const st = entry.init([undefined], ts, PROBE_ENV);
      for (const v of p.args) entry.step(st, [v], PROBE_ENV);
      r = String(entry.result(st, entry.dt(ts), PROBE_ENV)) === p.want;
    } else {
      const ts = p.args.map(s => ({ dt: 'string', len: s.length, coll }));
      const f = bindFn(cx, entry, ts, ts.map(() => undefined), cx, { type: 'fn', name: entry.name, args: [], trimMode: 'BOTH' });
      r = String(f(p.args.slice(), PROBE_ENV)) === p.want;
    }
  } catch {
    r = false;
  }
  COLL_AWARE.set(entry, r);
  return r;
}

// Raises when a call would compare strings in a collation other than the org collation and its functions.js entry
// does not honour argTypes coll yet: an error instead of a silently case-insensitive result.
function collGuard(up, entry, n, cc, cx, agg) {
  const p = cc && (agg ? AGG_PROBES : COLL_PROBES).get(up);
  if (!p || n < (p.min || 1) || !nonOrgColl(cc.coll, !!p.order) || collAware(entry, p, cx, agg)) return;
  const name = cc.coll.name || 'of this expression';
  throw plain(`${up}() does not support the collation ${name} yet: it would compare in the organization collation. Compare with COLLATE outside the function instead.`);
}

// The folded value of a constant argument for an entry's consts slot (01 §8), or undefined. A constant expression
// reads no variable (SQL Server's rule), so CREATELOOKUP(@t, id) keeps its run-time {entityFn}.
function constOf(c, cx) {
  if (c.cv) return c.cv.v;
  if (!c.isConst || c.vol || c.usesVar || c.pres.length || !cx.rt) return undefined;
  try {
    const v = c.fn([], cx.rt);
    return v === undefined ? null : v;
  } catch {
    return undefined;
  }
}

// A per-row call of a bound scalar with its argument values (one argument buffer per call site).
function callFn(bound, fns) {
  const n = fns.length;
  if (n === 0) {
    const a = [];
    return (row, env) => bound(a, env);
  }
  if (n === 1) {
    const f0 = fns[0], a = [null];
    return (row, env) => { a[0] = f0(row, env); return bound(a, env); };
  }
  if (n === 2) {
    const f0 = fns[0], f1 = fns[1], a = [null, null];
    return (row, env) => { a[0] = f0(row, env); a[1] = f1(row, env); return bound(a, env); };
  }
  const a = new Array(n).fill(null);
  return (row, env) => {
    for (let i = 0; i < n; i++) a[i] = fns[i](row, env);
    return bound(a, env);
  };
}

const isUserLocal = attr => !!attr && attr.type === 'DateTime' && attr.behavior !== 'DateOnly' && attr.behavior !== 'TimeZoneIndependent';

function fnC(node, ctx) {
  const cx = ctx.cx;
  const up = String(node.name).toUpperCase();
  const args = node.args || [];
  if (node.schema) lookupFn(cx, `${node.schema}.${up}`, args.length, { written: writtenName(node, cx) });
  if (up === 'GROUPING' || up === 'GROUPING_ID') return groupingC(node, up, ctx);
  if (node.over) return windowC(node, up, ctx);
  if (AGGREGATES.has(up)) return aggC(node, up, ctx);
  if (WINDOWS.has(up)) throw needsOver(up);
  const { kind, entry } = lookupFn(cx, up, node.star ? 0 : args.length, { star: !!node.star, written: writtenName(node, cx), atTimeZone: !!node.postfix });
  if (kind === 'fetch') throw FUNCTIONS.fetchConditionError(up);
  if (kind !== 'scalar') throw E(195, writtenName(node, cx));
  if (node.distinct) throw E(156, 'DISTINCT');
  if (node.withinGroup && node.withinGroup.length) throw noWithinGroup(up);
  return scalarC(node, up, entry, ctx);
}

function scalarC(node, up, entry, ctx) {
  const cx = ctx.cx;
  const args = node.args || [];
  const preds = Array.isArray(entry.preds) ? entry.preds : null;
  const kw = entry.keywords || null;
  const cs = args.map((a, i) => {
    if (preds && preds.includes(i)) return compPred(a, ctx);
    if (kw && kw[i] && a && a.type === 'col' && a.parts.length === 1 && kw[i].has(String(a.parts[0]).toUpperCase())) {
      const word = String(a.parts[0]).toUpperCase();
      return constC(word, { dt: 'string', len: word.length });
    }
    return compValue(a, ctx);
  });
  const b = firstBad(cs);
  if (b) return b;
  const cc = callColl(cs, up.toLowerCase());
  collGuard(up, entry, cs.length, cc, cx, false);
  const argTypes = cs.map(c => argTypeOf(c, cc));
  const consts = cs.map(c => constOf(c, cx));
  const t = typeOf(entry.dt(argTypes, consts));
  const info = kidsInfo(cs);
  const vol = info.vol || !!entry.nondet || up === 'RAND';
  const isConst = info.isConst && !entry.nondet;
  const pure = info.pure && !vol;
  // a NEWID() inside a subquery being planned makes that subquery unmemoised (CTE and derived bodies included)
  if (entry.nondet) for (const r of RECORDERS) r.nondet = true;
  let fn;
  if (typeof entry.bindLazy === 'function') {
    const lazy = entry.bindLazy(argTypes, consts, cx, node);
    const make = ks => {
      const fns = ks.map(c => fnOf(c, pure));
      return (row, env) => lazy(fns, env, row);
    };
    fn = make(cs);
    // only the arguments the call evaluates for a row run their subqueries for it (COALESCE, ISNULL, IIF, CHOOSE)
    info.pres = lazyPres(cs, make, info);
  } else {
    fn = callFn(bindFn(cx, entry, argTypes, consts, cx, node), cs.map(c => fnOf(c, pure)));
  }
  if (entry.predicate) {
    const f0 = fn;
    fn = (row, env) => truth(f0(row, env));
  }
  if (up === 'AT_TIME_ZONE') fn = atTimeZoneWarning(fn, cs, ctx);
  if (up === 'RAND' && !cs.length) fn = perStatement(fn);
  const ref = typeof entry.ref === 'function' ? entry.ref(cs.map(c => c.ref), consts, cs.map(c => c.fn)) : undefined;
  const o = { ...info, isConst, pure, vol, ref, src: passSrc(up, cs, ref) };
  if (t.dt === 'string') {
    const strs = cs.filter(c => c.t.dt === 'string');
    Object.assign(o, resultColl(strs, up.toLowerCase()));
    o.ci_ai = !o.coll && strs.some(c => c.ci_ai);
  }
  if (o.src != null) {
    const s0 = cs.find(c => c.src === o.src);
    if (s0 && s0.attr) o.attr = s0.attr;
  }
  const c = mk(guard(fn, node), t, o);
  if (entry.predicate) c.pred = true;
  return c;
}

// The 01 §5.5 warning of `<UserLocal column> AT TIME ZONE 'UTC'` in a local session tz: at compile time through
// cx.rt.warn, else on the first evaluation through env.warn.
function atTimeZoneWarning(fn, cs, ctx) {
  const x = cs[0], z = cs[1];
  if (!x || !z || !isUserLocal(x.attr) || !z.cv || typeof z.cv.v !== 'string' || z.cv.v.trim().toUpperCase() !== 'UTC') return fn;
  const text = `AT TIME ZONE reads '${x.name}' as the browser-local time shown in the grid. Set Settings › Time zone to UTC to read it as UTC, as the TDS endpoint does.`;
  const rt = ctx.cx.rt;
  if (rt && rt.tz) {
    if (!rt.tz.utc && typeof rt.warn === 'function') rt.warn(text);
    return fn;
  }
  let warned = false;
  return (row, env) => {
    if (!warned && env && env.tz && !env.tz.utc && typeof env.warn === 'function') {
      warned = true;
      env.warn(text);
    }
    return fn(row, env);
  };
}

// 130 for an aggregate or a subquery inside an aggregate argument; the 4109 text for a window function there.
function checkAggArgs(node) {
  const list = [...(node.args || []), ...((node.withinGroup || []).map(it => it.expr))];
  for (const a of list) {
    const i = exprInfo(a);
    if (i.win) throw at(nestedWindow(), a);
    if (i.agg || i.sub) throw at(E(130), a);
  }
}

// The aggregate argument type check (8117, 305, …) of functions.js entry.dt over the input scope, with the argument
// collation and its guard.
function aggArgCheck(node, entry, up, scope, ctx) {
  if (node.star || !(node.args || []).length) return;
  const cx2 = { rt: ctx.cx.rt, meta: ctx.cx.meta, settings: ctx.cx.settings, xmlns: ctx.cx.xmlns, source: ctx.cx.source, fns: ctx.cx.fns, errors: [], clause: 'other' };
  const ctx2 = { scope, cx: cx2, acc: newAcc(), xmlOk: null };
  const cs = node.args.map(a => compValue(a, ctx2));
  if (cx2.errors.length || firstBad(cs)) return;
  const cc = callColl(cs, up.toLowerCase());
  entry.dt(cs.map(c => argTypeOf(c, cc)), cs.map(c => constOf(c, cx2)));
  collGuard(up, entry, cs.length, cc, ctx.cx, true);
}

// The scope (and its distance from scope) a column reference binds to, without reporting it or applying the GROUP BY
// rules; null when it binds nowhere (a keyword argument, or a 207 the compile that follows raises).
function bindingScope(parts, scope) {
  const n = parts.length;
  const lname = String(parts[n - 1]).toLowerCase();
  const qual = n >= 2 ? String(parts[n - 2]).toLowerCase() : null;
  let depth = 0;
  for (let s = scope; s; s = s.parent, depth++) {
    const schema = schemaOf(s);
    if (!schema.length) continue;
    const { names, quals } = namesOf(schema);
    const skip = aliasOnlyOf(s);
    let qualHere = false;
    for (let i = 0; i < names.length; i++) {
      if (skip && skip.has(i)) continue;
      if (qual !== null) {
        if (quals[i] !== qual) continue;
        qualHere = true;
      }
      if (names[i] === lname) return { s, depth };
    }
    if (qualHere) return null;
  }
  return null;
}

// The outer block of an aggregate whose arguments read columns of outer blocks only (SQL Server's outer aggregate):
// {s, depth, two /* columns of two different outer blocks */}, else null (no column, or a column of this block: the
// aggregate of this block).
function outerAggScope(node, ctx) {
  const cols = [];
  const walk = x => {
    if (!x || typeof x !== 'object') return;
    if (x.type === 'col') cols.push(x);
    else for (const k of kidsOf(x)) walk(k);
  };
  for (const a of node.args || []) walk(a);
  for (const it of node.withinGroup || []) walk(it.expr);
  let found = null, two = false;
  for (const c of cols) {
    const b = bindingScope(c.parts, ctx.scope);
    if (!b) continue;
    if (b.depth === 0) return null;
    if (found && found.s !== b.s) two = true;
    found = found || b;
  }
  return found ? { s: found.s, depth: found.depth, two } : null;
}

// The innermost active compile call over scope s (the outer block an outer aggregate belongs to), or null.
function frameOf(s) {
  for (let i = FRAMES.length - 1; i >= 0; i--) if (FRAMES[i].scope === s) return FRAMES[i];
  return null;
}

// An outer aggregate of a subquery planned while an expression of the outer block s compiles
// (frame): computed by that grouped block through the aggregates collector of that compile call, and read here as an
// outer reference. Columns of two different outer blocks raise SQL Server's 8124 text.
function outerAggC(node, up, entry, outer, frame, ctx) {
  const { s, depth } = outer;
  if (outer.two) throw at(plain(OUTER_MIX), node);
  const collect = frame.cx && typeof frame.cx.aggregates === 'function' && s.group && s.group.input ? frame.cx.aggregates : null;
  if (!collect) {
    if (frame.clause === 'where') throw E(147);
    throw plain(`${textOf(node, ctx.cx)} aggregates only columns of an outer query, so it belongs to that query, which is not grouped. Add GROUP BY to the outer query or compute the aggregate there.`);
  }
  aggArgCheck(node, entry, up, s.group.input, ctx);
  const idx = collect(node);
  const col = s.schema[idx];
  if (!Number.isInteger(idx) || !col) throw new TypeError(`compile.js: cx.aggregates returned ${idx}, which is not an index of the outer scope schema.`);
  report(s, idx);
  useCol(ctx.acc, depth, idx);
  const d = depth;
  return mk((row, env) => env.outer[d - 1][idx], typeOf(col), { ref: col.ref, attr: col.attr, ci_ai: !!col.ci_ai, ...colColl(col) });
}

// A read of the post-aggregate or window output column idx.
function slotC(idx, ctx, what) {
  const col = ctx.scope.schema[idx];
  if (!Number.isInteger(idx) || !col) throw new TypeError(`compile.js: cx.${what} returned ${idx}, which is not an index of the scope schema.`);
  useCol(ctx.acc, 0, idx);
  return mk(row => row[idx], typeOf(col), { src: idx, ref: col.ref, attr: col.attr, ci_ai: !!col.ci_ai, ...colColl(col) });
}

function aggC(node, up, ctx) {
  const cx = ctx.cx;
  // an aggregate of outer columns only, inside a subquery of an expression of that outer block, belongs to it; in an
  // APPLY body or derived table (no such compile call) it stays the aggregate of its own block
  const outer = outerAggScope(node, ctx);
  const frame = outer ? frameOf(outer.s) : null;
  if (!frame && typeof cx.aggregates !== 'function') throw E(147);
  checkAggArgs(node);
  lookupFn(cx, up, node.star ? 0 : (node.args || []).length, { star: !!node.star, written: writtenName(node, cx) });
  const entry = AGGREGATES.get(up);
  if (node.withinGroup && node.withinGroup.length && !entry.orderable) throw noWithinGroup(up);
  if (frame) return outerAggC(node, up, entry, outer, frame, ctx);
  aggArgCheck(node, entry, up, ctx.scope.group && ctx.scope.group.input ? ctx.scope.group.input : ctx.scope, ctx);
  return slotC(cx.aggregates(node), ctx, 'aggregates');
}

function windowC(node, up, ctx) {
  const cx = ctx.cx;
  const args = node.args || [];
  const n = node.star ? 0 : args.length;
  const written = writtenName(node, cx);
  let entry, kind;
  if (WINDOWS.has(up)) { entry = WINDOWS.get(up); kind = 'window'; }
  else if (AGGREGATES.has(up)) { entry = AGGREGATES.get(up); kind = 'aggregate'; }
  else {
    lookupFn(cx, up, n, { star: !!node.star, written, atTimeZone: !!node.postfix });
    throw E(4113, up);
  }
  if (typeof cx.windows !== 'function') throw E(4108);
  lookupFn(cx, up, n, { star: !!node.star, written });
  if (node.distinct) throw E(10759);
  const over = node.over || {};
  if (kind === 'aggregate') {
    // STRING_AGG (an ordered-set aggregate) and APPROX_COUNT_DISTINCT are not windowing functions in SQL Server
    if (entry.noOver || entry.orderable) throw E(4113, up);
    if (node.withinGroup && node.withinGroup.length) throw noWithinGroup(up);
  } else {
    if (entry.needsOrder && !(over.orderBy && over.orderBy.length)) throw E(4112, up);
    if (!entry.allowsFrame && over.frame) throw E(10752, up);
  }
  for (const a of args) if (exprInfo(a).win) throw at(nestedWindow(), a);
  if (kind === 'aggregate') {
    // a windowed aggregate over a subquery is 130, as without OVER; over an aggregate (SUM(SUM(x)) OVER ()) it is valid
    for (const a of args) if (exprInfo(a).sub) throw at(E(130), a);
    if (!args.some(a => exprInfo(a).agg)) aggArgCheck(node, entry, up, ctx.scope, ctx);
  }
  return slotC(cx.windows(node), ctx, 'windows');
}

function groupingC(node, up, ctx) {
  const args = node.args || [];
  if (up === 'GROUPING' && args.length !== 1) throw E(174, 'grouping', 1);
  if (up === 'GROUPING_ID' && args.length < 1) throw E(189, 'grouping_id', 'at least 1');
  const g = ctx.scope.group;
  const count = g && Number.isInteger(g.count) ? g.count : 0;
  const ks = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let k = null;
    if (g && g.keys && g.input) {
      // a name that does not bind is its own error (207/209/4104 with suggestions), not a GROUPING mismatch
      let key;
      try {
        key = groupKey(a, g.input);
      } catch (e) {
        if (ctx.cx.errors && isBindError(e)) {
          ctx.cx.errors.push(at(e, a));
          return badC(e);
        }
        throw at(e, a);
      }
      const hit = g.keys.get(key);
      if (hit !== undefined) k = hit;
    }
    if (k == null || k >= count) throw at(plain(`Argument ${i + 1} of the ${up} function does not match any of the expressions in the GROUP BY clause.`), a);
    ks.push(k);
  }
  const gi = g && Number.isInteger(g.gid) ? g.gid : -1;
  if (gi < 0) return mk(() => 0, INT, {});
  useCol(ctx.acc, 0, gi);
  const shifts = ks.map(k => count - 1 - k);
  if (shifts.length === 1) {
    const s = shifts[0];
    return mk(row => (row[gi] >> s) & 1, INT, {});
  }
  return mk(row => {
    const v = row[gi];
    let r = 0;
    for (const s of shifts) r = (r << 1) | ((v >> s) & 1);
    return r;
  }, INT, {});
}

// --------------------------------------------------------------------------------------------- xml methods

function xmlC(node, ctx) {
  const cx = ctx.cx;
  const method = String(node.method).toLowerCase();
  if (method === 'modify') bindXml(cx, node, { dt: 'xml' }, { xmlns: cx.xmlns });
  const prev = ctx.xmlOk;
  ctx.xmlOk = unparen(node.e);
  let x;
  try {
    x = compValue(node.e, ctx);
  } finally {
    ctx.xmlOk = prev;
  }
  if (x.bad) return x;
  const refs = [];
  const resolve = ref => {
    if (ref && ref.kind === 'column') {
      const parts = Array.isArray(ref.parts) && ref.parts.length ? ref.parts : String(ref.name).split('.');
      const c = colC({ type: 'col', parts, pos: node.pos, end: node.end }, ctx);
      refs.push(c);
      return { fn: c.fn, type: c.t };
    }
    const name = String(ref && ref.name).toLowerCase();
    const entry = rtVar(cx, name);
    if (!entry || entry.table) throw E(137, name);
    refs.push(mk(null, varType(entry), { isConst: true, usesVar: true }));
    return { fn: (row, env) => readVar(env, name), type: varType(entry) };
  };
  const b = bindXml(cx, node, x.t, { xmlns: cx.xmlns, resolve });
  const bad = firstBad(refs);
  if (bad) return bad;
  const info = kidsInfo([x, ...refs]);
  const pure = info.pure && !refs.length;
  const X = fnOf(x, pure);
  const t = typeOf(b.type);
  if (method === 'nodes') {
    const nodesOf = b.nodes;
    const c = mk(guard((row, env) => nodesOf(X(row, env), row, env), node), t, { ...info, pure: false });
    c.bound = b;
    c.operand = x;
    return c;
  }
  const f = b.fn;
  return mk(guard((row, env) => f(X(row, env), row, env), node), t, { ...info, pure });
}

// --------------------------------------------------------------------------------------------- subqueries

const SUB_LIMIT = new Map([['scalar', 2], ['exists', 1], ['in', Infinity], ['any', Infinity], ['all', Infinity]]);
const MEMO_MAX = 10000;
const OBJ_IDS = new WeakMap();
let objSeq = 0;

// The exact-identity memo key of one outer value.
function memoKey(v) {
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
  if (base !== v) return 'v' + typeName(variantType(v)) + ':' + memoKey(base);
  let id = OBJ_IDS.get(v);
  if (id === undefined) OBJ_IDS.set(v, (id = ++objSeq));
  return 'o' + id;
}

// The rows of a plan, at most limit of them; stopping early closes its generators.
async function take(plan, env, limit) {
  const out = [];
  if (!(limit > 0)) return out;
  for await (const batch of plan.run(env)) {
    for (let i = 0; i < batch.length; i++) {
      out.push(batch[i]);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

const dopOf = env => (env && env.api && env.api.dop > 0 ? Math.floor(env.api.dop) : 4);

// Runs f over items with at most dop calls in flight; after a failure no new call starts.
async function pool(items, dop, f) {
  let next = 0, failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const it = items[next++];
      try {
        await f(it);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  const n = Math.max(1, Math.min(dop, items.length));
  const ws = [];
  for (let i = 0; i < n; i++) ws.push(worker());
  await Promise.all(ws);
}

// Plans a subquery through cx.planSubquery and records the outer references its planning resolved, and whether that
// planning compiled a nondeterministic call (NEWID) anywhere (its CTE and derived-table bodies included).
function subPlan(query, ctx) {
  const cx = ctx.cx;
  if (typeof cx.planSubquery !== 'function') throw new TypeError('compile.js: cx.planSubquery is required to compile a subquery.');
  const rec = { scope: ctx.scope, refs: new Map(), nondet: false };
  RECORDERS.push(rec);
  let plan;
  try {
    plan = cx.planSubquery(query, ctx.scope);
  } finally {
    const i = RECORDERS.lastIndexOf(rec);
    if (i >= 0) RECORDERS.splice(i, 1);
  }
  if (!plan || typeof plan.run !== 'function' || !Array.isArray(plan.schema)) throw new TypeError('compile.js: cx.planSubquery must return a PlanNode.');
  const refs = [...rec.refs.values()].sort((a, b) => a.k - b.k || a.index - b.index);
  for (const r of refs) useCol(ctx.acc, r.k, r.index);
  return { plan, refs, noMemo: rec.nondet || hasNewid(query) || !!plan.nondet };
}

const NO_OUTER = Object.freeze([]);

// Whether a subquery execution error ends the statement at once instead of being cached until a row reads it: an
// abort, a statement limit (code 'LIMIT'), a Blocked: refusal, an expired session or a network failure, and anything
// that is neither a SqlError nor a DataverseError (an internal error).
function fatalErr(err, env) {
  if (isAbort(err, env)) return true;
  if (!err || typeof err !== 'object') return true;
  const code = err.code;
  if (code === 'LIMIT' || code === 'blocked' || code === 'auth' || code === 'network') return true;
  return !(err instanceof SqlError) && err.name !== 'DataverseError';
}

// The per-row results of a subquery (the rows past the memo and every row of an unmemoised subquery): a row maps to
// {k, r} for its key, or to a Map key -> result when it was prepared under several keys (other env.outer values).
function keepRow(map, row, k, r) {
  const o = map.get(row);
  if (!o) map.set(row, { k, r });
  else if (o instanceof Map) o.set(k, r);
  else if (o.k === k) o.r = r;
  else map.set(row, new Map([[o.k, o.r], [k, r]]));
}

function readRow(map, row, k) {
  const o = map.get(row);
  if (!o) return undefined;
  if (o instanceof Map) return o.get(k);
  return o.k === k ? o.r : undefined;
}

// The run-time driver of a compiled subquery: pre(rows, env) fills the caches, result(row, env) reads them.
function subRunner(plan, refs, kind, noMemo) {
  const self = { kind };
  const correlated = refs.length > 0;
  const limit = SUB_LIMIT.get(kind);
  // the outer levels an execution may read: the row's level and the parents up to the deepest recorded reference
  const levels = correlated ? refs[refs.length - 1].k + 1 : 0;
  const parts = refs.map(r => (r.k === 0 ? row => row[r.index] : (row, env) => env.outer[r.k - 1][r.index]));
  const keyOfRow = parts.length === 1
    ? (row, env) => memoKey(parts[0](row, env))
    : (row, env) => {
      let s = '';
      for (let i = 0; i < parts.length; i++) {
        const k = memoKey(parts[i](row, env));
        s += k.length + ':' + k;
      }
      return s;
    };
  const stateOf = env => {
    const m = env.subq || (env.subq = new Map());
    let s = m.get(self);
    if (!s) m.set(self, (s = { memo: new Map(), once: null, result: null, rows: new WeakMap() }));
    return s;
  };
  const exec = async (env, row) => {
    // an execution sees only the outer values its planning recorded: a missed correlation fails loudly instead of
    // reusing one result for every row
    let outer = NO_OUTER;
    if (row) {
      const parent = env.outer || NO_OUTER;
      outer = [row];
      for (let i = 0; i + 1 < levels && i < parent.length; i++) outer.push(parent[i]);
    }
    const e2 = { ...env, outer };
    try {
      return { rows: await take(plan, e2, limit) };
    } catch (err) {
      if (fatalErr(err, env)) throw err;
      return { error: err };
    }
  };
  const pre = async (rows, env) => {
    const s = stateOf(env);
    if (!correlated) {
      if (!s.once) s.once = exec(env, null).then(r => { s.result = r; });
      await s.once;
      return;
    }
    // one execution per key not answered yet (per row object without the memo); rows of the batch that share it
    const todo = new Map();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const k = keyOfRow(row, env);
      if (!noMemo && (s.memo.has(k) || readRow(s.rows, row, k) !== undefined)) continue;
      const tk = noMemo ? row : k;
      const t = todo.get(tk);
      if (!t) todo.set(tk, { k, row, more: null });
      else if (t.row !== row) (t.more || (t.more = [])).push(row);
    }
    if (!todo.size) return;
    const items = [...todo.values()];
    if (typeof plan.prepare === 'function') await plan.prepare(items.map(x => x.row), env);
    await pool(items, dopOf(env), async it => {
      if (env.signal) env.signal.throwIfAborted();
      const r = await exec(env, it.row);
      if (!noMemo && s.memo.size < MEMO_MAX) s.memo.set(it.k, r);
      else {
        // past the memo the result lives with the row objects, as long as the evaluator keeps them (a Window or
        // Sort buffers rows of earlier batches and reads them after later pre calls)
        keepRow(s.rows, it.row, it.k, r);
        if (it.more) for (const x of it.more) keepRow(s.rows, x, it.k, r);
      }
    });
  };
  const result = (row, env) => {
    const s = env && env.subq && env.subq.get(self);
    if (s) {
      if (!correlated) {
        if (s.result) return s.result;
      } else if (row && typeof row === 'object') {
        const k = keyOfRow(row, env);
        const r = (!noMemo && s.memo.get(k)) || readRow(s.rows, row, k);
        if (r) return r;
      }
    }
    throw new Error('Internal error: a subquery was read before its pre() ran for this batch of rows.');
  };
  return { pre, result };
}

// The visible column indexes of a plan schema.
const visibleIdx = schema => schema.reduce((a, c, i) => (c && c.hidden ? a : (a.push(i), a)), []);

// The one visible column of a subquery used as a value (116 otherwise).
function oneColumn(plan) {
  const vis = visibleIdx(plan.schema);
  if (vis.length !== 1) throw E(116);
  return vis[0];
}

// The lineage a scalar subquery value keeps: a plain {entity[, pid]} only. A {poly} column's per-row table lives in
// its companion, which no scalar value carries, and a function-valued ref reads the subquery's own row (01 §6.2).
const subRef = ref => (ref && ref.entity && !ref.poly && !ref.entityFn && !ref.pidFn ? ref : undefined);

function scalarSubC(node, ctx) {
  const { plan, refs, noMemo } = subPlan(node.query, ctx);
  const j = oneColumn(plan);
  const col = plan.schema[j];
  const run = subRunner(plan, refs, 'scalar', noMemo);
  const fn = (row, env) => {
    const r = run.result(row, env);
    if (r.error) throw r.error;
    const rows = r.rows;
    if (!rows.length) return null;
    if (rows.length > 1) throw E(512);
    const v = rows[0][j];
    return v === undefined ? null : v;
  };
  return mk(guard(fn, node), typeOf(col), { pres: [run.pre], plans: [plan], ref: subRef(col.ref), ci_ai: !!col.ci_ai, ...colColl(col) });
}

function existsC(node, ctx) {
  const { plan, refs, noMemo } = subPlan(node.query, ctx);
  const run = subRunner(plan, refs, 'exists', noMemo);
  const fn = (row, env) => {
    const r = run.result(row, env);
    if (r.error) throw r.error;
    return r.rows.length > 0;
  };
  const c = mk(guard(fn, node), BIT, { pres: [run.pre], plans: [plan] });
  c.pred = true;
  return c;
}

// The comparison set of one subquery result in the common type T: non-NULL keys, NULL seen and, with range (ANY/ALL
// with <, <=, > or >=), min and max. Long results check env.signal every 8,192 values.
function deriveSet(r, j, ct, T, ai, env, memo, range) {
  let d = memo.get(r);
  if (d) return d;
  const keys = new Set();
  let hasNull = false, min = null, max = null, only = null;
  const conv = needConv(ct, T);
  const rows = r.rows, signal = env && env.signal;
  for (let i = 0; i < rows.length; i++) {
    if (signal && (i & 8191) === 8191) signal.throwIfAborted();
    let v = rows[i][j];
    if (v == null) { hasNull = true; continue; }
    if (conv) v = coerce(v, ct, T, env);
    const k = keyOf(v, T, ai);
    if (!keys.has(k)) { keys.add(k); if (only === null) only = k; }
    if (range) {
      if (min === null || cmp(v, min, T, ai) < 0) min = v;
      if (max === null || cmp(v, max, T, ai) > 0) max = v;
    }
  }
  d = { n: r.rows.length, keys, hasNull, min, max, only };
  memo.set(r, d);
  return d;
}

function inSubC(node, ctx) {
  const x = compValue(node.e, ctx);
  const { plan, refs, noMemo } = subPlan(node.query, ctx);
  if (x.bad) return x;
  const j = oneColumn(plan);
  const col = plan.schema[j];
  const ct = typeOf(col);
  if (x.t.dt === 'xml' || ct.dt === 'xml') throw E(305);
  const T = commonType(x.t, ct);
  const ai = collOf(x, { ci_ai: !!col.ci_ai, ...colColl(col) }, 'in');
  const run = subRunner(plan, refs, 'in', noMemo);
  const info = kidsInfo([x]);
  const X = convFn(x, T, false);
  const memo = new WeakMap();
  const not = !!node.not;
  const fn = (row, env) => {
    const r = run.result(row, env);
    if (r.error) throw r.error;
    let res;
    if (!r.rows.length) res = false;
    else {
      const a = X(row, env);
      if (a == null) res = null;
      else {
        const d = deriveSet(r, j, ct, T, ai, env, memo, false);
        res = d.keys.has(keyOf(a, T, ai)) ? true : d.hasNull ? null : false;
      }
    }
    return not ? not3(res) : res;
  };
  const c = mk(guard(fn, node), BIT, { pres: [...info.pres, run.pre], plans: [...info.plans, plan] });
  c.pred = true;
  return c;
}

// x op ANY|ALL S by the 01 §5.1 rules over the derived set d (n > 0) of S and a non-NULL x.
function quantified(op, all, a, d, T, ai) {
  const ka = keyOf(a, T, ai);
  const none = d.keys.size === 0;
  if (!all) {
    let t;
    switch (op) {
      case '=': t = d.keys.has(ka); break;
      case '<>': t = d.keys.size > 1 || (d.keys.size === 1 && d.only !== ka); break;
      case '<': t = !none && cmp(a, d.max, T, ai) < 0; break;
      case '<=': t = !none && cmp(a, d.max, T, ai) <= 0; break;
      case '>': t = !none && cmp(a, d.min, T, ai) > 0; break;
      default: t = !none && cmp(a, d.min, T, ai) >= 0; break;
    }
    return t ? true : d.hasNull ? null : false;
  }
  let f;
  switch (op) {
    case '=': f = d.keys.size > 1 || (d.keys.size === 1 && d.only !== ka); break;
    case '<>': f = d.keys.has(ka); break;
    case '<': f = !none && cmp(a, d.min, T, ai) >= 0; break;
    case '<=': f = !none && cmp(a, d.min, T, ai) > 0; break;
    case '>': f = !none && cmp(a, d.max, T, ai) <= 0; break;
    default: f = !none && cmp(a, d.max, T, ai) < 0; break;
  }
  return f ? false : d.hasNull ? null : true;
}

function quantC(node, ctx) {
  const l = compValue(node.l, ctx);
  const { plan, refs, noMemo } = subPlan(node.query, ctx);
  if (l.bad) return l;
  const j = oneColumn(plan);
  const col = plan.schema[j];
  const ct = typeOf(col);
  if (l.t.dt === 'xml' || ct.dt === 'xml') throw E(305);
  const T = commonType(l.t, ct);
  const op = String(node.op);
  const all = String(node.quant).toUpperCase() === 'ALL';
  const ai = collOf(l, { ci_ai: !!col.ci_ai, ...colColl(col) }, op);
  const run = subRunner(plan, refs, all ? 'all' : 'any', noMemo);
  const info = kidsInfo([l]);
  const L = convFn(l, T, false);
  const memo = new WeakMap();
  const range = op !== '=' && op !== '<>';
  const fn = (row, env) => {
    const r = run.result(row, env);
    if (r.error) throw r.error;
    if (!r.rows.length) return all;
    const a = L(row, env);
    if (a == null) return null;
    return quantified(op, all, a, deriveSet(r, j, ct, T, ai, env, memo, range), T, ai);
  };
  const c = mk(guard(fn, node), BIT, { pres: [...info.pres, run.pre], plans: [...info.plans, plan] });
  c.pred = true;
  return c;
}

// ------------------------------------------------------------------------------------------ top level

// The SQL text of an expression for explain(): the cx.source slice, else rendered from the AST.
function textOf(node, cx) {
  const src = cx && cx.source;
  if (typeof src === 'string' && node && Number.isInteger(node.pos) && Number.isInteger(node.end) && node.end <= src.length && node.end > node.pos) {
    return src.slice(node.pos, node.end);
  }
  return render(node);
}

// The token the non-boolean error names: the one after the expression in cx.source, else its last token.
function nearText(node, cx) {
  const src = cx && cx.source;
  const toks = text => {
    try {
      return tokenize(text).filter(t => t.t !== 'end');
    } catch {
      const m = /^\s*(\S+)/.exec(text);
      return m ? [{ s: text.indexOf(m[1]), e: text.indexOf(m[1]) + m[1].length }] : [];
    }
  };
  if (typeof src === 'string' && node && Number.isInteger(node.end) && node.end <= src.length) {
    const tail = src.slice(node.end, node.end + 512);
    const t = toks(tail)[0];
    if (t) return cut128(tail.slice(t.s, t.e));
    if (Number.isInteger(node.pos) && node.pos < node.end) {
      const own = src.slice(node.pos, node.end);
      const all = toks(own);
      if (all.length) { const z = all[all.length - 1]; return cut128(own.slice(z.s, z.e)); }
    }
  }
  const text = render(node);
  const all = toks(text);
  if (!all.length) return cut128(text);
  const z = all[all.length - 1];
  return cut128(text.slice(z.s, z.e));
}

// A pre function running every subquery pre of an expression in order, or null.
function preOf(pres) {
  if (!pres.length) return null;
  if (pres.length === 1) return pres[0];
  return async (rows, env) => {
    for (const p of pres) await p(rows, env);
  };
}

// The public Compiled of an internal result (01 §7).
function finish(c, acc, node, cx, pred) {
  const fn = c.pure && !c.cv && !c.bad ? cached(c.fn) : c.fn;
  const out = { fn, pre: preOf(c.pres), dt: pred ? 'bit' : c.t.dt };
  if (!pred) for (const k of TF) if (c.t[k] != null && c.t[k] !== false) out[k] = c.t[k];
  out.ref = c.ref;
  out.src = c.src ?? null;
  out.isConst = !!c.isConst;
  out.name = c.name || '';
  out.text = textOf(node, cx);
  if (c.coll && !pred) {
    out.coll = c.coll;
    if (c.collImplicit) out.collImplicit = true;
  }
  if (c.ci_ai) out.ci_ai = true;
  if (c.attr) out.attr = c.attr;
  out.plans = c.plans.slice();
  out.cols = [...acc.cols].sort((a, b) => a - b);
  out.outer = [...acc.outer.values()];
  if (c.bound) {
    out.bound = c.bound;
    out.operand = finish(c.operand, acc, node && node.e, cx, false);
  }
  return out;
}

// A whole ORDER BY item that names a select alias of scope.aliases, or null.
function aliasHit(expr, ctx) {
  const al = ctx.scope.aliases;
  if (ctx.cx.clause !== 'order' || !(al instanceof Map) || !expr || expr.type !== 'col' || expr.parts.length !== 1) return null;
  const hits = al.get(String(expr.parts[0]).toLowerCase());
  if (hits == null) return null;
  const list = Array.isArray(hits) ? hits : [hits];
  if (!list.length) return null;
  if (list.length > 1) throw withHints(E(209, String(expr.parts[0])), expr.parts, expr, []);
  const idx = list[0];
  const col = ctx.scope.schema[idx];
  if (!col) throw new TypeError(`compile.js: scope.aliases names the index ${idx}, which the scope schema lacks.`);
  useCol(ctx.acc, 0, idx);
  return mk(row => row[idx], typeOf(col), { src: idx, ref: col.ref, attr: col.attr, ci_ai: !!col.ci_ai, ...colColl(col), name: String(col.name ?? '') });
}

// SQL Server's 191 for an expression too deep to compile (the engine's stack ran out), as the parser raises it for
// nesting; any other error as it is.
function tooDeep(e, expr) {
  if (e instanceof RangeError && /call stack/i.test(String(e.message))) return at(E(191), expr);
  return e;
}

// cx.groupKeys of 01 §7 is scope.group.keys here: a cx that carries it was written for
// another contract, and compiling with it would silently skip the GROUP BY rules.
function checkCx(cx) {
  if (cx.groupKeys !== undefined) throw new TypeError('compile.js: pass the grouping of a post-aggregate scope as scope.group = {input, keys, count, gid}; cx.groupKeys is not read.');
}

function compileTop(expr, scope, cx, pred) {
  cx = cx || {};
  scope = scope || NO_SCOPE;
  const acc = newAcc();
  const ctx = { scope, cx, acc, xmlOk: null };
  checkCx(cx);
  FRAMES.push({ scope, clause: cx.clause || 'other', cx });
  try {
    let c;
    try {
      c = aliasHit(expr, ctx);
    } catch (e) {
      if (cx.errors && isBindError(e)) { cx.errors.push(e); c = badC(e); } else throw e;
    }
    if (!c) c = pred ? compPred(expr, ctx) : compValue(expr, ctx);
    return finish(c, acc, expr, cx, pred);
  } catch (e) {
    throw tooDeep(e, expr);
  } finally {
    FRAMES.pop();
  }
}

// Compiles a value expression against a scope (01 §7).
export function compileExpr(expr, scope, cx) {
  return compileTop(expr, scope, cx, false);
}

// Compiles a predicate (true/false/null, three-valued logic) against a scope (01 §7).
export function compilePredicate(expr, scope, cx) {
  return compileTop(expr, scope, cx, true);
}

// ---------------------------------------------------------------------------------------------- schemas

// The flat type fields of a compiled result as Column fields.
function columnOf(c, name) {
  const col = { name, qual: null, dt: c.dt || 'any' };
  for (const k of TF) if (k !== 'entityref' && c[k] != null && c[k] !== false) col[k] = c[k];
  if (c.ref !== undefined) col.ref = c.ref;
  if (c.coll && col.dt === 'string') col.coll = c.coll;
  return col;
}

// The output schema of a projection, with pass-through lineage and hidden companions (01 §7).
export function projectSchema(inSchema, compiled, names, opts = {}) {
  const n = compiled.length;
  const schema = new Array(n);
  const needs = [];
  for (let i = 0; i < n; i++) {
    const c = compiled[i];
    const nm = names ? names[i] : undefined;
    const name = typeof nm === 'string' ? nm : nm && typeof nm === 'object' && typeof nm.name === 'string' ? nm.name : String(c.name ?? '');
    const col = columnOf(c, name);
    const s = c.src != null ? inSchema[c.src] : null;
    if (s) {
      col.qual = s.qual ?? null;
      if (s.attr) col.attr = s.attr;
      if (s.role) col.role = s.role;
      if (s.ci_ai) col.ci_ai = true;
      if (s.companion) needs.push([i, s.companion]);
    } else if (c.ci_ai) col.ci_ai = true;
    if (nm && typeof nm === 'object' && nm.hidden) {
      col.hidden = true;
      if (nm.role) col.role = nm.role;
    }
    schema[i] = col;
  }
  let exprs = compiled;
  if (opts && opts.outermost) {
    const added = [];
    for (let i = 0; i < n; i++) {
      const c = compiled[i];
      const ref = c.ref;
      if (ref && typeof ref.entityFn !== 'function' && typeof ref.pidFn === 'function') {
        // {entity, pidFn} (CREATEELASTICLOOKUP with a per-row partition id): the cell keeps its table, never a
        // function that reads the run's env
        const rest = { ...ref };
        delete rest.pidFn;
        schema[i] = { ...schema[i], ref: rest };
        continue;
      }
      if (!ref || typeof ref.entityFn !== 'function') continue;
      const f = ref.entityFn;
      const pos = n + added.length;
      added.push({
        fn: (row, env) => { const v = f(row, env); return v == null ? null : String(v); },
        pre: null, dt: 'string', len: 128, unicode: true, ref: undefined, src: null, isConst: false, name: '',
        text: `type of ${c.text || schema[i].name || 'column'}`, plans: [], cols: c.cols ? c.cols.slice() : [], outer: c.outer ? c.outer.slice() : [],
      });
      schema[i] = { ...schema[i], ref: { poly: true }, companion: { ...(schema[i].companion || {}), type: pos } };
      schema.push({ name: (schema[i].name || '') + 'type', qual: null, dt: 'string', len: 128, unicode: true, hidden: true, role: 'type' });
    }
    if (added.length) exprs = [...compiled, ...added];
  }
  const extra = [];
  const at0 = schema.length;
  const posOf = new Map();
  for (const [i, comp] of needs) {
    const out = {};
    for (const k of Object.keys(comp)) {
      const idx = comp[k];
      let p = posOf.get(idx);
      if (p === undefined) {
        p = at0 + extra.length;
        posOf.set(idx, p);
        extra.push(idx);
        const { companion, srcKey, ...rest } = inSchema[idx] || {};
        schema.push({ ...rest, hidden: true });
      }
      out[k] = p;
    }
    schema[i] = { ...schema[i], companion: { ...(schema[i].companion || {}), ...out } };
  }
  return { schema, extra, exprs };
}

// The schema of a join's right input placed after `offset` left columns: companion indexes moved (01 §7).
export function shiftSchema(schema, offset) {
  if (!offset) return schema.slice();
  return schema.map(c => {
    if (!c.companion) return c;
    const companion = {};
    for (const k of Object.keys(c.companion)) companion[k] = c.companion[k] + offset;
    return { ...c, companion };
  });
}

// -------------------------------------------------------------------------------------------- assignment

const DATATYPES = new WeakMap();
// The declared DataType of a variable entry (entry.dataType when the session keeps it).
function dataTypeFor(e) {
  if (e.dataType) return e.dataType;
  let d = DATATYPES.get(e);
  if (!d) DATATYPES.set(e, (d = dataTypeOf(typeOf(e))));
  return d;
}

const ENTRY_TYPES = new WeakMap();
// The declared static Type of a run-time variable entry ({dt, …} or only {dataType}), cached per entry.
function entryType(e) {
  let t = ENTRY_TYPES.get(e);
  if (!t) ENTRY_TYPES.set(e, (t = varType(e)));
  return t;
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=']);
const SPACES = /^ *$/;

// The lineage function of an assigned value: (row, env) => {entity, pid?} | undefined, or null for none.
function lineageOf(c, scope) {
  const ref = c.ref;
  if (!ref) return null;
  if (typeof ref.entityFn === 'function') {
    return (row, env) => {
      const en = ref.entityFn(row, env);
      if (!en) return undefined;
      const r = { entity: String(en).toLowerCase() };
      const pid = typeof ref.pidFn === 'function' ? ref.pidFn(row, env) : ref.pid;
      if (pid != null) r.pid = String(pid);
      return r;
    };
  }
  if (ref.poly) {
    const col = c.src != null ? scope.schema[c.src] : null;
    const ti = col && col.companion ? col.companion.type : undefined;
    if (ti == null) return null;
    return row => {
      const t = row[ti];
      return t ? { entity: String(t).toLowerCase() } : undefined;
    };
  }
  if (ref.entity) {
    const entity = String(ref.entity).toLowerCase();
    if (typeof ref.pidFn === 'function') {
      // an elastic lookup whose partition id is read per row (CREATEELASTICLOOKUP with a non-constant partition id)
      const pidFn = ref.pidFn;
      return (row, env) => {
        const pid = pidFn(row, env);
        return pid != null ? { entity, pid: String(pid) } : { entity };
      };
    }
    const r = Object.freeze(ref.pid != null ? { entity, pid: String(ref.pid) } : { entity });
    return () => r;
  }
  return null;
}

// Compiles `@v op expr` (SET and SELECT assignments): conversion, truncation warning and lineage.
export function compileAssignment(name, op, expr, scope, cx) {
  cx = cx || {};
  scope = scope || NO_SCOPE;
  const lname = String(name).toLowerCase();
  const o = String(op || '=');
  if (!ASSIGN_OPS.has(o)) throw new TypeError(`compile.js: unknown assignment operator '${o}'.`);
  const acc = newAcc();
  const ctx = { scope, cx, acc, xmlOk: null };
  checkCx(cx);
  FRAMES.push({ scope, clause: cx.clause || 'select', cx });
  try {
    const entry = rtVar(cx, lname);
    if (!entry || entry.table) throw at(E(137, lname), expr);
    const vt = varType(entry);
    const node = o === '=' ? expr
      : { type: 'bin', op: o.slice(0, -1), l: { type: 'var', name: lname, pos: expr.pos, end: expr.end }, r: expr, pos: expr.pos, end: expr.end };
    const c = compValue(node, ctx);
    const pre = preOf(c.pres);
    const done = fn => ({ fn, pre, plans: c.plans.slice(), cols: [...acc.cols].sort((a, b) => a - b), outer: [...acc.outer.values()] });
    if (c.bad) return done(() => { throw c.bad; });
    try {
      probeImplicit(c.t, vt);
    } catch (e) {
      throw at(e, expr);
    }
    const from = c.t;
    const value = c.pure && !c.cv ? cached(c.fn) : c.fn;
    const lineage = vt.dt === 'guid' ? lineageOf(c, scope) : null;
    let lastEnv = null, lastOpts = null;
    const optsFor = env => {
      if (!lastOpts || env !== lastEnv) {
        lastEnv = env;
        // a declared type without a length is (1), as in DECLARE (01 §4.1)
        lastOpts = { tz: env ? env.tz : undefined, dateformat: env ? env.dateformat : undefined, defLen: 1 };
        if (env && typeof env.warn === 'function') lastOpts.warn = text => env.warn(text);
      }
      return lastOpts;
    };
    const fn = (row, env) => {
      const v = value(row, env);
      const e = env && env.vars && env.vars.get(lname);
      if (!e || e.table) throw E(137, lname);
      const dt = dataTypeFor(e);
      const et = entryType(e);
      const opts = optsFor(env);
      const out = castValue(v, from, dt, opts);
      if (et.dt === 'string' && et.len > 0 && typeof out === 'string' && v != null) {
        let full = null;
        if (from.dt === 'string' && typeof v === 'string') full = v;
        else if (from.dt !== 'int' && from.dt !== 'bigint' && from.dt !== 'decimal' && from.dt !== 'money' && from.dt !== 'float' && from.dt !== 'bit' && from.dt !== 'guid') {
          try {
            full = castValue(v, from, { name: et.unicode ? 'nvarchar' : 'varchar', args: ['max'] }, opts);
          } catch {
            full = null;
          }
        }
        if (typeof full === 'string' && full.length > et.len && !SPACES.test(full.slice(et.len)) && env && typeof env.warn === 'function') {
          env.warn(`Value truncated to ${et.len} characters when assigned to ${lname}.`);
        }
      }
      e.value = out;
      if (et.dt === 'guid') e.ref = out == null || !lineage ? undefined : lineage(row, env);
      else if (e.ref !== undefined) e.ref = undefined;
    };
    return done(guard(fn, expr));
  } catch (e) {
    throw tooDeep(e, expr);
  } finally {
    FRAMES.pop();
  }
}

// ------------------------------------------------------------------------------------------ errors

const FIELDS = ['number', 'severity', 'state', 'code', 'suggestions', 'fix'];

// One SqlError for every binding error of a statement, the first in source order leading.
export function combineErrors(errors) {
  if (!errors || !errors.length) return null;
  const list = errors
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.pos ?? Infinity) - (b.e.pos ?? Infinity) || a.i - b.i)
    .map(x => x.e);
  const first = list[0];
  const out = new SqlError(first.message, first.pos ?? null, first.end ?? null);
  for (const k of FIELDS) if (first[k] !== undefined) out[k] = first[k];
  out.errors = list;
  return out;
}

// ------------------------------------------------------------------------------------------ rendering

const BARE = /^[A-Za-z_#@][A-Za-z0-9_#@$]*$/;
const ident = p => (BARE.test(String(p)) ? String(p) : '[' + String(p).replace(/\]/g, ']]') + ']');
const typeText = d => (d ? String(d.name).toUpperCase() + (d.args && d.args.length ? '(' + d.args.join(', ') + ')' : '') : '');
const list = xs => (xs || []).map(render).join(', ');
const orderText = items => (items || []).map(it => render(it.expr) + (it.desc ? ' DESC' : '')).join(', ');

function litText(x) {
  switch (x.dt) {
    case 'null': return 'NULL';
    case 'string': return (x.unicode ? 'N' : '') + "'" + String(x.v).replace(/'/g, "''") + "'";
    case 'binary': return '0x' + String(x.v).toUpperCase();
    default: return x.raw != null ? String(x.raw) : String(x.v);
  }
}

function frameText(f) {
  const b = x => (x.kind === 'up' ? 'UNBOUNDED PRECEDING' : x.kind === 'uf' ? 'UNBOUNDED FOLLOWING' : x.kind === 'cur' ? 'CURRENT ROW' : `${x.n} ${x.kind === 'p' ? 'PRECEDING' : 'FOLLOWING'}`);
  return f.end ? `${f.unit} BETWEEN ${b(f.start)} AND ${b(f.end)}` : `${f.unit} ${b(f.start)}`;
}

function overText(o) {
  const parts = [];
  if (o.partitionBy && o.partitionBy.length) parts.push('PARTITION BY ' + list(o.partitionBy));
  if (o.orderBy && o.orderBy.length) parts.push('ORDER BY ' + orderText(o.orderBy));
  if (o.frame) parts.push(frameText(o.frame));
  return ' OVER (' + parts.join(' ') + ')';
}

const RENDER_DEPTH = 200;
let renderDepth = 0;

// SQL text of an expression AST (explain() text when no source text is at hand); parts nested deeper than 200
// levels show as '…'.
function render(x) {
  if (!x || typeof x !== 'object') return '';
  if (renderDepth >= RENDER_DEPTH) return '…';
  renderDepth++;
  try {
    return renderNode(x);
  } finally {
    renderDepth--;
  }
}

function renderNode(x) {
  switch (x.type) {
    case 'lit': return litText(x);
    case 'col': return (x.parts || []).map(ident).join('.');
    case 'colref': return `$${x.d}.${x.i}`;
    case 'var': return String(x.name);
    case 'default': return 'DEFAULT';
    case 'bin': return `${render(x.l)} ${x.op} ${render(x.r)}`;
    case 'neg': return String(x.op) + render(x.e);
    case 'not': return 'NOT ' + render(x.e);
    case 'paren': return '(' + render(x.e) + ')';
    case 'isnull': return render(x.e) + (x.not ? ' IS NOT NULL' : ' IS NULL');
    case 'between': return `${render(x.e)} ${x.not ? 'NOT ' : ''}BETWEEN ${render(x.lo)} AND ${render(x.hi)}`;
    case 'in': return `${render(x.e)} ${x.not ? 'NOT ' : ''}IN (${x.query ? 'SELECT …' : list(x.list)})`;
    case 'like': return `${render(x.e)} ${x.not ? 'NOT ' : ''}LIKE ${render(x.pattern)}${x.escape ? ' ESCAPE ' + render(x.escape) : ''}`;
    case 'exists': return 'EXISTS (SELECT …)';
    case 'quantified': return `${render(x.l)} ${x.op} ${x.quant} (SELECT …)`;
    case 'distinctfrom': return `${render(x.l)} IS ${x.not ? 'NOT ' : ''}DISTINCT FROM ${render(x.r)}`;
    case 'case': {
      let s = 'CASE' + (x.operand ? ' ' + render(x.operand) : '');
      for (const [w, t] of x.whens || []) s += ` WHEN ${render(w)} THEN ${render(t)}`;
      if (x.else) s += ' ELSE ' + render(x.else);
      return s + ' END';
    }
    case 'cast': return x.style
      ? `${x.try ? 'TRY_' : ''}CONVERT(${typeText(x.dataType)}, ${render(x.e)}, ${render(x.style)})`
      : `${x.try ? 'TRY_' : ''}CAST(${render(x.e)} AS ${typeText(x.dataType)})`;
    case 'collate': return `${render(x.e)} COLLATE ${x.name}`;
    case 'datepart': return String(x.v);
    case 'subq': return '(SELECT …)';
    case 'xmlmethod': return `${render(x.e)}.${x.method}(${list(x.args)})`;
    case 'fn': {
      if (x.postfix && String(x.name).toUpperCase() === 'AT_TIME_ZONE') return `${render(x.args[0])} AT TIME ZONE ${render(x.args[1])}`;
      const name = (x.schema ? ident(x.schema) + '.' : '') + String(x.name).toUpperCase();
      const args = x.star ? '*' : (x.distinct ? 'DISTINCT ' : '') + list(x.args);
      let s = `${name}(${args})`;
      if (x.withinGroup && x.withinGroup.length) s += ` WITHIN GROUP (ORDER BY ${orderText(x.withinGroup)})`;
      if (x.over) s += overText(x.over);
      return s;
    }
    default: return '';
  }
}
