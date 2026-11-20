// SQL Studio message table: every numbered SQL Server error SQL Studio raises, with its severity and text.
// Contracts: 01 §1 (exports), §2.1 (numbers, texts and severities), §7.1
// (8120, 8121, 8127), §8 (sys.messages, BASE64_DECODE); 00 §3 (import DAG), §4 (Launch).
// Dependency-free: imports nothing, so core/* and data/* can use it without a cycle.
//
// Notes:
// - Exports: `MESSAGES`, a frozen object with a null prototype (so FORMATMESSAGE/RAISERROR lookups by a user's number
//   can never reach Object.prototype), keyed by error number, each value a frozen `{severity, text}`; and
//   `msg(number, ...args) -> {number, severity, message}`, which fills the placeholders. messages.js imports nothing
//   and cannot build a SqlError itself; a caller does `const m = msg(207, name)`, then `new SqlError(m.message, pos,
//   end)` with `number = m.number` and `severity = m.severity`. Object.keys(MESSAGES) lists the numbers in ascending
//   order (integer keys), which is the row order of `sys.messages` (metatables.js, 01 §8).
// - Placeholders: `<name>`, a letter followed by letters, digits or spaces, between `<` and `>` (so `<, <= , >` in 512
//   is plain text). Where 01 §2.1 writes a placeholder (`<v>`, `<n>`, `<digits>`, `<first 128 characters>`, …) the
//   text keeps it; where it shows one by example ('x', 'abc', int, dateadd, …) the example became a named
//   placeholder, and a value that 01 §2.1 never varies stays literal text (536 RIGHT, 13602 SELECT INTO, 1023
//   parameter 1, 168 8 bytes, 193 116 characters, 217 limit 32, 310 32767, 6850 'Column name', 9803 Base64Decode).
//   msg() binds its arguments, in order, to the distinct placeholder names in the order of their first appearance;
//   a name that appears twice takes the same argument (535: msg(535, 'datediff_big') fills both places). A value is
//   a string (also ''), a number or a bigint, inserted verbatim (never re-scanned, no `$&` patterns); callers apply
//   SQL Server's cuts themselves (near-texts to 128 characters, 01 §2). msg() throws RangeError for a number that
//   is not in MESSAGES and TypeError for a wrong argument count or a value of another type, so a mistyped call
//   fails at once instead of showing a half-filled message.
// - One text per number. Variants of 01 §2.1 are values of one template: 189 `The <function> function requires
//   <range> arguments.` with range '2 to 3' or 'at least 2' (COALESCE); 281 `<n> is not a valid style number when
//   converting <conversion>.` with conversion 'from datetime to a character string' (§2.1) or 'to datetime' (a
//   string to the date/time type named, §5.3); 214 parameter '@statement', '@params' or
//   'separator'; 402 operator 'modulo', 'boolean AND', 'boolean OR', 'boolean XOR' or 'add'; 529, 242, 245, 257, 8114
//   from/to type names; 8115 source 'expression' or 'numeric'; 8117 operator 'avg', 'add', …; 8144 'string_split' or
//   'sp_executesql'; 4199 the value as SQL Server shows it (123, or 'xml' quoted for STRING_ESCAPE); 9810, 8116 the
//   function name in lower case (or 'AT TIME ZONE'); 16911 the direction as written, upper case. The one text of 01
//   that is not an instance of its number's template, 102 `The second argument of ISJSON must be one of the
//   keywords VALUE, ARRAY, OBJECT or SCALAR.` (01 §8), is SQL Studio's own wording under SQL Server's number
//   and stays in functions.js; 01 §5.4's `Operand type clash: int is incompatible with date` without the final
//   period is the 206 text of the table (with the period, as every module writes it).
// - Numbers outside the 01 §2.1 table: the Dataverse fault numbers 547, 2627, 8152 and 10337 (2628 and 8115 have
//   table rows) have the text `<message>`, the whole message; so has 50000 (RAISERROR/THROW with a message text,
//   severity 16 as THROW raises it). 8120, 8121 and 8127 have the texts of §7.1; 9803 is the BASE64_DECODE error of
//   01 §8 (VERIFICATION).
// - Severities are the sys.messages values (01 §2.1; the list is in VERIFICATION): 15 for the syntax
//   errors of 01 §2 and most parse-time and binding errors, 14 for 2627, 11 for 3701 and 16 for every other number.
//   msg() returns them, so a module that takes `m.severity` needs no severity of its own (parser.js's 15 for 319 and
//   1033 becomes 16, the sys.messages value).
// - Raising without msg(): msg() refuses a number that is not in MESSAGES, so session.js raises these itself as
//   SqlError {number, severity, state}: THROW and RAISERROR user numbers (50001 and up; THROW 51000 is severity 16,
//   state 1), the 'Sql Number: n' number, and the severity and state that RAISERROR and THROW are given
//   (a MESSAGES severity never replaces them). The path of a DataverseError caught by TRY/CATCH builds its
//   SqlError the same way for every mapped number (547, 2627, 2628, 8115, 8152, 10337 or n): message = the trimmed
//   Dataverse message + ' (0x…)', severity 16, state 1. It never takes msg().severity (2627 is 14 in sys.messages,
//   ERROR_SEVERITY() must be 16 there) and never fills the 2628 or 8115 template with a Dataverse text; the 2628
//   that 02 §8.1 step 2 raises before sending is msg(2628, table, column, value).
// - Load (00 §4 Launch): MESSAGES is a constant built by one assign-and-freeze pass over TABLE (about 210 rows, no
//   parsing and no checks at load), because 01 §1 exports a frozen object.
// - Copies (04 §2.1): lexer.js keeps its own 102, 105 and 113 texts (import-free, 01 §1, §2).
//
// VERIFICATION (01 §2.1 intro): the numbers, texts and severities were checked against Microsoft Learn's
// 'Database Engine events and errors' pages, which are generated from sys.messages: the SQL Server 2017 tables for
// every number, and the SQL Server 2022 tables for 6800, 6801, 6803, 6804, 6820, 6832, 6861, 6864, 8172, 9400, 9803,
// 9810, 13613, 13621, 16911, 16924 and for the severities of 102-319, 1001-1911, 2627, 2628, 4108-4194, 8154-8159,
// 8748 and 10337-10760 (the two agree everywhere both were read). The 04 §5.2 live check on a SQL Server 2022 instance repeats
// it before 04 asserts the marked numbers.
// - Marked numbers whose sys.messages number and text match 01 §2.1: 148, 258, 305, 493, 6802, 6806, 6807, 6809,
//   6810, 6812, 6819, 6824, 6825, 6833, 6850, 6852, 6864, 8172. 9400 is sys.messages' text for the reason 'unexpected
//   end of input'; SQL Studio uses 9400 for every parseXml reason (documented deviation, 01 §5.8, §9). 16911 is
//   '%hs: The fetch type %hs cannot be used with forward only cursors.'; SQL Server fills the first %hs with 'fetch'
//   in lower case, as 01 §2.1 writes it.
// - FOR XML numbers (adopted from 01 §2.1): FOR XML AUTO without a table is 6800 (6820 is 'FOR XML
//   EXPLICIT requires column %d to be named …'); 'FOR XML EXPLICIT requires at least three columns, …' is 6801 (6832
//   is a FOR XML AUTO binary-URL error); 'requires the first column to hold positive integers …' is 6803; 'requires
//   the second column to hold NULL or nonnegative integers …' is 6804. MESSAGES has 6800, 6801, 6803 and 6804 with
//   those texts and no 6820 or 6832.
// - BASE64_DECODE (01 §8): invalid input raises 9803 'Invalid data for type "%ls".' (severity 16) with the type
//   name 'Base64Decode' (SQL Server 2025), at state 20 for a character outside both RFC 4648 alphabets, 21 for valid
//   characters in a wrong format and 23 for more than two padding characters or data after the padding. SQL Studio
//   raises 9803 only for that type name, so MESSAGES 9803 holds it as literal text (the placeholder rule above) and
//   functions.js sets the state.
// - Open questions (the 01 §2.1 texts and numbers are kept outside FOR XML; sys.messages differs):
//   6861 is "Empty root tag name can't be specified with FOR XML." in sys.messages (MESSAGES keeps the table's
//   'cannot'). 'Array cannot be found in the specified JSON path.' (JSON_MODIFY strict append) is 13621, severity 16;
//   13613 is 'Base64 encoded string cannot be converted to binary value. Binary data would be truncated.', so
//   ERROR_NUMBER() after a strict append differs from SQL Server until 13613 is renumbered to 13621 (01 §2.1, §8
//   JSON_MODIFY). A non-positive NTILE count is 4116, severity 16, "The function 'ntile' takes only a positive int or
//   bigint expression as its input."; 4110 is 'The argument type "%s" is invalid for argument %d of "%s".' (renumber
//   and reword to 4116 as for FOR XML, then confirm with the 04 §5.2 live check).
// - Unmarked texts kept as 01 §2.1 writes them, where sys.messages differs: 127 'rowcount' (01: 'rows count'); 206 has
//   no final period; 1001 and 1002 start with 'Line %d: '; 2749 reads '… with a scale of 0, unencrypted, and
//   constrained to be nonnullable.'; 8167 quotes the column in double quotes; 189 has only the '%d to %d arguments'
//   form; 281 has only the 'from %ls to a character string' form (a bad style for a string to date, time, datetime2
//   or datetimeoffset is 9809 'The style %d is not supported for conversions from %s to %s.').
// - Severities (sys.messages): 15 for 102, 103, 104, 105, 107, 109, 110, 113, 116, 119, 127, 131-137, 141, 145, 147,
//   148, 155, 156, 168, 174, 178, 179, 189, 191, 193, 195, 196, 258, 310, 1007, 1011, 1012, 1013, 1023, 1031, 1038,
//   1060, 1087, 4194, 7630, 8154, 8155, 8156, 8158, 8159, 10704, 10709, 10715, 10741-10744, 10752 and 10759; 14 for
//   2627; 11 for 3701; 16 for every other number (8748 is 16 in the 2022 table, it is not in 2017's). 319, 1001,
//   1002, 1033, 4108 and 4112 are 16 in sys.messages (2017 and 2022), although SQL Server is reported to raise
//   some parse-time errors (1033, 4108, 4112) at level 15; the 04 §5.2 live check records the raised level, and a
//   raise-time override would be the parser's, not a second MESSAGES severity.

// [number, severity, text]: one row per number, in ascending order.
const TABLE = [
  // Parser: syntax and lexical errors, names, batches and statements.
  [102, 15, "Incorrect syntax near '<token>'."],
  [103, 15, "The identifier that starts with '<first 128 characters>' is too long. Maximum length is 128."],
  [104, 15, 'ORDER BY items must appear in the select list if the statement contains a UNION, INTERSECT or EXCEPT operator.'],
  [105, 15, "Unclosed quotation mark after the character string '<text>'."],
  [107, 15, "The column prefix '<prefix>' does not match with a table name or alias name used in the query."],
  [108, 15, 'The ORDER BY position number <n> is out of range of the number of items in the select list.'],
  [109, 15, 'There are more columns in the INSERT statement than values specified in the VALUES clause. The number of values in the VALUES clause must match the number of columns specified in the INSERT statement.'],
  [110, 15, 'There are fewer columns in the INSERT statement than values specified in the VALUES clause. The number of values in the VALUES clause must match the number of columns specified in the INSERT statement.'],
  [113, 15, "Missing end comment mark '*/'."],
  [116, 15, 'Only one expression can be specified in the select list when the subquery is not introduced with EXISTS.'],
  [119, 15, "Must pass parameter number <n> and subsequent parameters as '@name = value'. After the form '@name = value' has been used, all subsequent parameters must be passed in the form '@name = value'."],
  [120, 15, 'The select list for the INSERT statement contains fewer items than the insert list. The number of SELECT values must match the number of INSERT columns.'],
  [121, 15, 'The select list for the INSERT statement contains more items than the insert list. The number of SELECT values must match the number of INSERT columns.'],
  [127, 15, 'A TOP N or FETCH rows count value may not be negative.'],
  [130, 16, 'Cannot perform an aggregate function on an expression containing an aggregate or a subquery.'],
  [131, 15, "The size (<size>) given to the type '<type>' exceeds the maximum allowed for any data type (<max>)."],
  [132, 15, "The label '<label>' has already been declared. Label names must be unique within a query batch or stored procedure."],
  [133, 15, "A GOTO statement references the label '<label>' but the label has not been declared."],
  [134, 15, "The variable name '<variable>' has already been declared. Variable names must be unique within a query batch or stored procedure."],
  [135, 15, 'Cannot use a BREAK statement outside the scope of a WHILE statement.'],
  [136, 15, 'Cannot use a CONTINUE statement outside the scope of a WHILE statement.'],
  [137, 15, 'Must declare the scalar variable "<variable>".'],
  [141, 15, 'A SELECT statement that assigns a value to a variable must not be combined with data-retrieval operations.'],
  [145, 15, 'ORDER BY items must appear in the select list if SELECT DISTINCT is specified.'],
  [147, 15, 'An aggregate may not appear in the WHERE clause unless it is in a subquery contained in a HAVING clause or a select list, and the column being aggregated is an outer reference.'],
  [148, 15, "Incorrect time syntax in time string '<time>' used with WAITFOR."],
  [155, 15, "'<datepart>' is not a recognized <function> option."],
  [156, 15, "Incorrect syntax near the keyword '<keyword>'."],
  [168, 15, "The floating point value '<value>' is out of the range of computer representation (8 bytes)."],
  [174, 15, 'The <function> function requires <count> argument(s).'],
  [178, 15, 'A RETURN statement with a return value cannot be used in this context.'],
  [179, 15, 'Cannot use the OUTPUT option when passing a constant to a stored procedure.'],
  [189, 15, 'The <function> function requires <range> arguments.'],
  [191, 15, 'Some part of your SQL statement is nested too deeply. Rewrite the query or break it up into smaller queries.'],
  [192, 16, 'The scale must be less than or equal to the precision.'],
  [193, 15, "The object or column name starting with '<name>' is too long. The maximum length is 116 characters."],
  [195, 15, "'<name>' is not a recognized built-in function name."],
  [196, 15, 'SELECT INTO must be the first query in a statement containing a UNION, INTERSECT or EXCEPT operator.'],
  // Binder, types and conversions.
  [205, 16, 'All queries combined using a UNION, INTERSECT or EXCEPT operator must have an equal number of expressions in their target lists.'],
  [206, 16, 'Operand type clash: <a> is incompatible with <b>.'],
  [207, 16, "Invalid column name '<name>'."],
  [208, 16, "Invalid object name '<name>'."],
  [209, 16, "Ambiguous column name '<name>'."],
  [214, 16, "Procedure expects parameter '<parameter>' of type '<type>'."],
  [217, 16, 'Maximum stored procedure, function, trigger, or view nesting level exceeded (limit 32).'],
  [220, 16, 'Arithmetic overflow error for data type <type>, value = <value>.'],
  [232, 16, 'Arithmetic overflow error for type <type>, value = <v>.'],
  [235, 16, 'Cannot convert a char value to money. The char value has incorrect syntax.'],
  [239, 16, "Duplicate common table expression name '<name>' was specified."],
  [240, 16, `Types don't match between the anchor and the recursive part in column "<column>" of recursive query "<cte>".`],
  [241, 16, 'Conversion failed when converting date and/or time from character string.'],
  [242, 16, 'The conversion of a <from> data type to a <to> data type resulted in an out-of-range value.'],
  [243, 16, 'Type <type> is not a defined system type.'],
  [245, 16, "Conversion failed when converting the <from> value '<value>' to data type <to>."],
  [246, 16, 'No anchor member was specified for recursive query "<cte>".'],
  [248, 16, "The conversion of the <from> value '<value>' overflowed an int column."],
  [252, 16, "Recursive common table expression '<cte>' does not contain a top-level UNION ALL operator."],
  [253, 16, "Recursive member of a common table expression '<cte>' has multiple recursive references."],
  [257, 16, 'Implicit conversion from data type <from> to <to> is not allowed. Use the CONVERT function to run this query.'],
  [258, 15, 'Cannot call methods on <type>.'],
  [264, 16, "The column name '<column>' is specified more than once in the SET clause or column list of an INSERT. A column cannot be assigned more than one value in the same clause. Modify the clause to make sure that a column is updated only once. If this statement updates or inserts columns into a view, column aliasing can conceal the duplication in your code."],
  [281, 16, '<n> is not a valid style number when converting <conversion>.'],
  [289, 16, 'Cannot construct data type <type>, some of the arguments have values which are not valid.'],
  [305, 16, 'The XML data type cannot be compared or sorted, except when using the IS NULL operator.'],
  [310, 15, 'The value <value> specified for the MAXRECURSION option exceeds the allowed maximum of 32767.'],
  [313, 16, 'An insufficient number of arguments were supplied for the procedure or function <function>.'],
  [319, 16, "Incorrect syntax near the keyword 'with'. If this statement is a common table expression, an xmlnamespaces clause or a change tracking context clause, the previous statement must be terminated with a semicolon."],
  [402, 16, 'The data types <left> and <right> are incompatible in the <operator> operator.'],
  [448, 16, "Invalid collation '<collation>'."],
  [460, 16, "DISTINCT operator is not allowed in the recursive part of a recursive common table expression '<cte>'."],
  [461, 16, "The TOP or OFFSET operator is not allowed in the recursive part of a recursive common table expression '<cte>'."],
  [462, 16, "Outer join is not allowed in the recursive part of a recursive common table expression '<cte>'."],
  [465, 16, 'Recursive references are not allowed in subqueries.'],
  [467, 16, "GROUP BY, HAVING, or aggregate functions are not allowed in the recursive part of a recursive common table expression '<cte>'."],
  [493, 16, "The column '<column>' that was returned from the nodes() method cannot be used directly. It can only be used with one of the four XML data type methods, exist(), nodes(), query(), and value(), or in IS NULL and IS NOT NULL checks."],
  [506, 16, 'The invalid escape character "<escape>" was specified in a LIKE predicate.'],
  [512, 16, 'Subquery returned more than 1 value. This is not permitted when the subquery follows =, !=, <, <= , >, >= or when the subquery is used as an expression.'],
  [515, 16, "Cannot insert the value NULL into column '<column>', table '<table>'; column does not allow nulls. <statement> fails."],
  [517, 16, "Adding a value to a '<type>' column caused an overflow."],
  [529, 16, 'Explicit conversion from data type <from> to <to> is not allowed.'],
  [530, 16, 'The statement terminated. The maximum recursion <max> has been exhausted before statement completion.'],
  [535, 16, 'The <function> function resulted in an overflow. The number of dateparts separating two date/time instances is too large. Try to use <function> with a less precise datepart.'],
  [536, 16, 'Invalid length parameter passed to the RIGHT function.'],
  [537, 16, 'Invalid length parameter passed to the LEFT or SUBSTRING function.'],
  [544, 16, "Cannot insert explicit value for identity column in table '<table>' when IDENTITY_INSERT is set to OFF."],
  // Dataverse fault mapped by SQL 4 CDS's FaultCodeToSqlError: the text is the Dataverse message.
  [547, 16, '<message>'],
  [1001, 16, 'Length or precision specification <n> is invalid.'],
  [1002, 16, 'Specified scale <scale> is invalid.'],
  [1007, 15, "The number '<digits>' is out of the range for numeric representation (maximum precision 38)."],
  [1011, 15, "The correlation name '<name>' is specified multiple times in a FROM clause."],
  [1012, 15, "The correlation name '<name>' has the same exposed name as table '<table>'."],
  [1013, 15, 'The objects "<first>" and "<second>" in the FROM clause have the same exposed names. Use correlation names to distinguish them.'],
  [1023, 15, 'Invalid parameter 1 specified for <function>.'],
  [1026, 16, 'GOTO cannot be used to jump into a TRY or CATCH scope.'],
  [1031, 15, 'Percent values must be between 0 and 100.'],
  [1033, 16, 'The ORDER BY clause is invalid in views, inline functions, derived tables, subqueries, and common table expressions, unless TOP, OFFSET or FOR XML is also specified.'],
  [1038, 15, 'An object or column name is missing or empty. For SELECT INTO statements, verify each column has a name. For other statements, look for empty alias names. Aliases defined as "" or [] are not allowed. Change the alias to a valid name.'],
  [1060, 15, 'The number of rows provided for a TOP or FETCH clauses row count parameter must be an integer.'],
  [1062, 16, 'The TOP N WITH TIES clause is not allowed without a corresponding ORDER BY clause.'],
  [1087, 15, 'Must declare the table variable "<variable>".'],
  [1911, 16, "Column name '<column>' does not exist in the target table or view."],
  // Objects, #temp tables, procedures and formats.
  [2225, 16, 'XQuery [<method>()]: A string literal was expected'],
  [2627, 14, '<message>'],
  [2628, 16, "String or binary data would be truncated in table '<table>', column '<column>'. Truncated value: '<value>'."],
  [2705, 16, "Column names in each table must be unique. Column name '<column>' in table '<table>' is specified more than once."],
  [2714, 16, "There is already an object named '<name>' in the database."],
  [2716, 16, 'Column, parameter, or variable #<n>: Cannot specify a column width on data type <type>.'],
  [2744, 16, "Multiple identity columns specified for table '<table>'. Only one identity column per table is allowed."],
  [2749, 16, "Identity column '<column>' must be of data type int, bigint, smallint, tinyint, or decimal or numeric with a scale of 0, and constrained to be nonnullable."],
  [2750, 16, 'Column or parameter #<n>: Specified column precision <precision> is greater than the maximum precision of <max>.'],
  [2786, 16, 'The data type of substitution parameter <n> does not match the expected type of the format specification.'],
  [2787, 16, "Invalid format specification: '<specification>'."],
  [2812, 16, "Could not find stored procedure '<name>'."],
  [3623, 16, 'An invalid floating point operation occurred.'],
  [3701, 11, "Cannot drop the table '<table>', because it does not exist or you do not have permission."],
  // Binding, windows, TVF arguments and updatable derived tables.
  [4104, 16, 'The multi-part identifier "<identifier>" could not be bound.'],
  [4108, 16, 'Windowed functions can only appear in the SELECT or ORDER BY clauses.'],
  [4110, 16, 'The argument of the NTILE function must be a positive integer.'],
  [4112, 16, "The function '<function>' must have an OVER clause with ORDER BY."],
  [4113, 16, "The function '<function>' is not a valid windowing function, and cannot be used with the OVER clause."],
  [4127, 16, 'At least one of the arguments to COALESCE must be an expression that is not the NULL constant.'],
  [4150, 16, "Hints are not allowed on recursive common table expression (CTE) references. Consider removing hint from recursive CTE reference '<cte>'."],
  [4151, 16, 'The type of the first argument to NULLIF cannot be the NULL constant because the type of the first argument has to be known.'],
  [4194, 15, 'RANGE is only supported with UNBOUNDED and CURRENT ROW window frame delimiters.'],
  [4199, 16, 'Argument value <value> is invalid for argument <n> of <function> function.'],
  [4405, 16, "View or function '<name>' is not updatable because the modification affects multiple base tables."],
  [4406, 16, "Update or insert of view or function '<name>' failed because it contains a derived or constant field."],
  [4417, 16, "Derived table '<name>' is not updatable because the definition contains a UNION operator."],
  [4418, 16, "Derived table '<name>' is not updatable because it contains aggregates, or a DISTINCT or GROUP BY clause, or PIVOT or UNPIVOT operator."],
  // FOR XML (01 §5.7; numbers as checked, VERIFICATION above).
  [6800, 16, 'FOR XML AUTO requires at least one table for generating XML tags. Use FOR XML RAW or add a FROM clause with a table name.'],
  [6801, 16, 'FOR XML EXPLICIT requires at least three columns, including the tag column, the parent column, and at least one data column.'],
  [6802, 16, "FOR XML EXPLICIT query contains the invalid column name '<name>'. Use the TAGNAME!TAGID!ATTRIBUTENAME[!..] format where TAGID is a positive integer."],
  [6803, 16, 'FOR XML EXPLICIT requires the first column to hold positive integers that represent XML tag IDs.'],
  [6804, 16, 'FOR XML EXPLICIT requires the second column to hold NULL or nonnegative integers that represent XML parent tag IDs.'],
  [6806, 16, 'Undeclared tag ID <n> is used in a FOR XML EXPLICIT query.'],
  [6807, 16, 'Undeclared parent tag ID <p> is used in a FOR XML EXPLICIT query.'],
  [6809, 16, 'Unnamed tables cannot be used as XML identifiers as well as unnamed columns cannot be used for attribute names. Name unnamed columns/tables using AS in the SELECT statement.'],
  [6810, 16, "Column name '<name>' is repeated. The same attribute cannot be generated more than once on the same XML tag."],
  [6812, 16, "XML tag ID <n> that was originally declared as '<a>' is being redeclared as '<b>'."],
  [6819, 16, 'The FOR XML clause is not allowed in a <statement> statement.'],
  [6824, 16, "In the FOR XML EXPLICIT clause, mode '<d>' in a column name is invalid."],
  [6825, 16, 'ELEMENTS option is only allowed in RAW, AUTO, and PATH modes of FOR XML.'],
  [6833, 16, 'Parent tag ID <p> is not among the open tags. FOR XML EXPLICIT requires parent tags to be opened first. Check the ordering of the result set.'],
  [6850, 16, "Column name '<name>' contains an invalid XML identifier as required by FOR XML; '<character>'(<code>) is the first character at fault."],
  [6852, 16, "Attribute-centric column '<column>' must not come after a non-attribute-centric sibling in XML hierarchy in FOR XML PATH."],
  [6861, 16, 'Empty root tag name cannot be specified with FOR XML.'],
  [6864, 16, 'Row tag omission (empty row tag name) cannot be used with attribute-centric FOR XML serialization.'],
  [7630, 15, "Syntax error near '<token>' in the full-text search condition '<condition>'."],
  [7645, 16, 'Null or empty full-text predicate.'],
  // CREATE TABLE, conversions, operators, grouping, derived-table naming and procedures.
  [8102, 16, "Cannot update identity column '<column>'."],
  [8110, 16, "Cannot add multiple PRIMARY KEY constraints to table '<table>'."],
  [8111, 16, "Cannot define PRIMARY KEY constraint on nullable column in table '<table>'."],
  [8114, 16, 'Error converting data type <from> to <to>.'],
  [8115, 16, 'Arithmetic overflow error converting <source> to data type <type>.'],
  [8116, 16, 'Argument data type <type> is invalid for argument <n> of <function> function.'],
  [8117, 16, 'Operand data type <type> is invalid for <operator> operator.'],
  [8120, 16, "Column '<column>' is invalid in the select list because it is not contained in either an aggregate function or the GROUP BY clause."],
  [8121, 16, "Column '<column>' is invalid in the HAVING clause because it is not contained in either an aggregate function or the GROUP BY clause."],
  [8127, 16, 'Column "<column>" is invalid in the ORDER BY clause because it is not contained in either an aggregate function or the GROUP BY clause.'],
  [8133, 16, 'At least one of the result expressions in a CASE specification must be an expression other than the NULL constant.'],
  [8134, 16, 'Divide by zero error encountered.'],
  [8144, 16, 'Procedure or function <name> has too many arguments specified.'],
  [8145, 16, '<parameter> is not a parameter for procedure <procedure>.'],
  [8147, 16, "Could not create IDENTITY attribute on nullable column '<column>', table '<table>'."],
  [8152, 16, '<message>'],
  [8154, 15, "The table '<table>' is ambiguous."],
  [8155, 15, "No column name was specified for column <n> of '<name>'."],
  [8156, 15, "The column '<column>' was specified multiple times for '<name>'."],
  [8158, 15, "'<name>' has more columns than were specified in the column list."],
  [8159, 15, "'<name>' has fewer columns than were specified in the column list."],
  [8167, 16, "The type of column '<column>' conflicts with the type of other columns specified in the UNPIVOT list."],
  [8169, 16, 'Conversion failed when converting from a character string to uniqueidentifier.'],
  [8170, 16, 'Insufficient result space to convert uniqueidentifier value to char.'],
  [8172, 16, 'The argument <n> of the XML data type method "<method>" must be a string literal.'],
  [8178, 16, "The parameterized query '<query>' expects the parameter '<parameter>', which was not supplied."],
  [8730, 16, 'Offset parameter for Lag and Lead functions cannot be a negative value.'],
  [8748, 16, 'The enable_ordinal argument for STRING_SPLIT only supports constant values (not variables or columns).'],
  // xml, BASE64_DECODE, dates, cultures, time zones and string functions.
  [9400, 16, 'XML parsing: line <l>, character <c>, <reason>'],
  [9803, 16, 'Invalid data for type "Base64Decode".'],
  [9810, 16, 'The datepart <datepart> is not supported by date function <function> for data type <type>.'],
  [9818, 16, "The culture parameter '<culture>' provided in the function call is not supported."],
  [9820, 16, "The time zone parameter '<zone>' provided to AT TIME ZONE clause is invalid."],
  [9828, 16, 'The second and third arguments of the TRANSLATE built-in function must contain an equal number of characters.'],
  [9829, 16, 'STRING_AGG aggregation result exceeded the limit of 8000 bytes. Use LOB types to avoid result truncation.'],
  // Dataverse fault without a mapped number.
  [10337, 16, '<message>'],
  [10704, 15, 'To rethrow an error, a THROW statement must be used inside a CATCH block. Insert the THROW statement inside a CATCH block, or add error parameters to the THROW statement.'],
  [10709, 15, 'The number of columns for each row in a table value constructor must be the same.'],
  [10715, 15, "'<name>' is not a valid hint."],
  [10741, 15, 'A TOP can not be used in the same query or sub-query as a OFFSET.'],
  [10742, 15, 'The offset specified in a OFFSET clause may not be negative.'],
  [10743, 15, 'The number of rows provided for a OFFSET clause must be an integer.'],
  [10744, 15, 'The number of rows provided for a FETCH clause must be greater then zero.'],
  [10752, 15, "The function '<function>' may not have a window frame."],
  [10759, 15, 'Use of DISTINCT is not allowed with the OVER clause.'],
  [10760, 16, 'Scale argument is not valid. Valid expressions for data type <type> scale argument are integer constants and integer constant expressions.'],
  // FOR JSON, JSON functions and OPENJSON.
  [13600, 16, 'FOR JSON AUTO requires at least one table for generating JSON objects. Use FOR JSON PATH or add a FROM clause with a table name.'],
  [13602, 16, 'The FOR JSON clause is not allowed in a SELECT INTO statement.'],
  [13607, 16, "JSON path is not properly formatted. Unexpected character '<character>' is found at position <position>."],
  [13608, 16, 'Property cannot be found on the specified JSON path.'],
  [13609, 16, "JSON text is not properly formatted. Unexpected character '<character>' is found at position <position>."],
  [13611, 16, 'Value referenced by JSON path is not an array or object and cannot be opened with OPENJSON.'],
  [13613, 16, 'Array cannot be found in the specified JSON path.'],
  [13618, 16, 'AS JSON option can be specified only for column of nvarchar(max) type in WITH clause.'],
  [13620, 16, 'ROOT option and WITHOUT_ARRAY_WRAPPER option cannot be used together in FOR JSON. Remove one of these options.'],
  [13623, 16, 'Scalar value cannot be found in the specified JSON path.'],
  [13624, 16, 'Object or array cannot be found in the specified JSON path.'],
  [13625, 16, 'String value in the specified JSON path would be truncated.'],
  // Cursors.
  [16905, 16, 'The cursor is already open.'],
  [16911, 16, 'fetch: The fetch type <direction> cannot be used with forward only cursors.'],
  [16915, 16, "A cursor with the name '<name>' already exists."],
  [16916, 16, "A cursor with the name '<name>' does not exist."],
  [16917, 16, 'Cursor is not open.'],
  [16924, 16, 'Cursorfetch: The number of variables declared in the INTO list must match that of selected columns.'],
  // THROW and RAISERROR.
  [35100, 16, 'Error number <number> in the THROW statement is outside the valid range. Specify an error number in the valid range of 50000 to 2147483647.'],
  [50000, 16, '<message>'],
];

// The frozen null-prototype table from TABLE rows: one assign-and-freeze pass (00 §4 Launch; no checks at load).
function build(rows) {
  const out = Object.create(null);
  for (const [number, severity, text] of rows) out[number] = Object.freeze({ severity, text });
  return Object.freeze(out);
}

// Every numbered SQL Server error SQL Studio raises: number -> frozen {severity, text} (01 §2.1).
export const MESSAGES = build(TABLE);

// A placeholder: `<` + a letter, then letters, digits or spaces, then `>`.
const PLACEHOLDER = /<([A-Za-z][A-Za-z0-9 ]*)>/g;
// Templates compiled on first use: number -> {names, parts} (parts: literal strings and argument indexes).
const compiled = new Map();

// Splits a text into literal parts and argument indexes, one index per distinct placeholder name.
function compile(text) {
  const names = [];
  const parts = [];
  let last = 0;
  PLACEHOLDER.lastIndex = 0;
  for (let m = PLACEHOLDER.exec(text); m; m = PLACEHOLDER.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    let k = names.indexOf(m[1]);
    if (k < 0) k = names.push(m[1]) - 1;
    parts.push(k);
    last = PLACEHOLDER.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return { names, parts };
}

// The text of one placeholder value: strings verbatim, numbers and bigints as String(); anything else throws.
function argText(v, number, i) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  throw new TypeError(`msg(${number}): argument ${i + 1} must be a string, number or bigint, got ${v === null ? 'null' : typeof v}.`);
}

// Error number + placeholder values -> {number, severity, message}, the values bound in placeholder order.
export function msg(number, ...args) {
  const entry = Number.isInteger(number) ? MESSAGES[number] : undefined;
  if (!entry) throw new RangeError(`msg: ${typeof number === 'number' ? number : typeof number} is not a message number of MESSAGES (01 §2.1).`);
  let c = compiled.get(number);
  if (!c) compiled.set(number, (c = compile(entry.text)));
  if (args.length !== c.names.length) {
    const want = c.names.length ? ` (${c.names.map(n => `<${n}>`).join(', ')})` : '';
    throw new TypeError(`msg(${number}): expected ${c.names.length} argument(s)${want}, got ${args.length}.`);
  }
  let message = '';
  for (const p of c.parts) message += typeof p === 'number' ? argText(args[p], number, p) : p;
  return { number, severity: entry.severity, message };
}
