// metadata.* tables (SQL 4 CDS compatible). 02 §7.
// META_TABLES must stay dependency-free (no imports): the editor
// (completion) and the explorer import it before the planner exists. MetaScan and loading come below it
// and keep the shape: [{ name, columns: [{ name, dt }] }]. Column names are lower-cased Web API property
// names; labels are user-language text, enums strings, arrays comma-joined, managed properties `.Value`.
//
// Notes (extensions and readings of 02 §6-§7, 01 §8 and 00 §3 that the spec does not state).
// META_TABLES itself is computed from the local tables below (it reads nothing
// imported); the imports serve MetaScan, which 02 §6 places in this module (DAG `exec ← metatables ← planner`).
//
// Exports beside META_TABLES (for the planner's binder and the UI):
// - SYS_TABLES: [{name, columns: [{name, dt, len?, unicode?}]}] of schema `sys`: `messages` (message_id int,
//   language_id int, severity int (tinyint shares int, 01 §5), is_event_logged bit, text nvarchar(2048); 02 §7, 01 §8,
//  ) and `time_zone_info` (name nvarchar(128) (sysname), current_utc_offset nvarchar(12), is_currently_dst bit:
//   SQL Server's types, Microsoft Learn sys.time_zone_info), SQL Server's view of the Windows zone names AT TIME ZONE
//   accepts (01 §5.5). sys.time_zone_info is a SQL Studio extension: 00 §2 names it as the source of the zone names
//   but no section lists it as a table. Its rows are the
//   types.js WIN_ZONES names in their order; current_utc_offset is the zone's offset at env.now ('+hh:mm'/'-hh:mm',
//   SQL Server's form), and is_currently_dst is 1 when that offset is above the zone's standard offset, the smaller
//   of its offsets on 15 January and 15 July of env.now's UTC year (the browser's IANA rules, 01 §9). A zone the
//   browser's Intl data lacks keeps its row with NULL offset and dst. explorer.js SYS_OBJECTS and complete.js list
//   only sys.messages and sys.fn_helpcollations(): adding sys.time_zone_info there is for I and E.
// - findMetaTable(schema, name) -> {schema: 'metadata'|'sys', name, full: 'metadata.entity', columns, pushable} |
//   null: case-insensitive; columns are frozen {name, dt, len?, unicode?} (every metadata string column is
//   nvarchar(max): len -1, unicode). The binder raises 208 for null (with did-you-mean over META_TABLES/SYS_TABLES).
// - metaColumns(table, qual = null) -> Column[] (fresh objects, 01 §6.1): {name, qual (lower case), dt, len?, unicode?}
//   plus `ci_ai: true` on every metadata.* column (01 §5.2); sys.* columns take the org collation. `table` is
//   'entity', 'metadata.entity' or 'sys.messages' (a name without a schema is a metadata table).
// - isPushable(table, column) and META_PUSHABLE (table -> frozen column list): the columns whose equality / IN
//   conjuncts with constant string values the planner may give MetaScan as `pushed` (02 §7): entity.logicalname;
//   attribute.entitylogicalname and attribute.logicalname; relationship_1_n and relationship_n_1 referencedentity and
//   referencingentity; relationship_n_n entity1logicalname and entity2logicalname; alternate_key.entitylogicalname;
//   optionsetvalue.entitylogicalname and optionsetvalue.attributelogicalname. attribute.logicalname,
//   entity2logicalname, referencingentity of relationship_1_n, referencedentity of relationship_n_1 and
//   attributelogicalname extend 02 §7's list (SQL 4 CDS folds them too). globaloptionset, globaloptionsetvalue and
//   the sys tables have none: their conditions stay client filters (02 §7).
// - isPropertyPushable(table, column) and META_PROPERTY_PUSHABLE (table -> frozen column list; an extension
//   of the planner's pushdown; SQL 4 CDS folds metadata property conditions too): base AttributeMetadata
//   properties whose equality / IN conjuncts with constant values of any type the planner may also give MetaScan in
//   `pushed`: attribute.attributetype (AttributeTypeCode), attributeof, iscustomattribute, ismanaged, islogical,
//   isprimaryid, isprimaryname, isvalidforcreate, isvalidforread, isvalidforupdate, issecured, isfilterable,
//   issearchable, isretrievable, isvalidodataattribute, columnnumber and sourcetype; no other table has any. They are
//   kept apart from isPushable, which stays the 02 §7 table-narrowing list (Dataverse's $filter cannot filter
//   attributes by type: 0x80044183; these go only into RetrieveMetadataChanges AttributeQuery.Criteria,
//   below). The planner keeps its Filter for them as for every pushed conjunct.
// - SYS_FUNCTIONS (lower-case name -> functions.js TVFS name) and sysFunction(name) -> the TVFS entry | null:
//   `sys.fn_helpcollations()` is FN_HELPCOLLATIONS, which the planner binds as a TvfScan (02 §7).
//
// MetaScan({table, schema, pushed, +meta, +api}) (02 §6), op 'MetaScan':
// - table as for metaColumns (or a findMetaTable descriptor); schema the Columns it outputs, by name, in any order
//   and any subset (column pruning: only the properties of these columns and of the pushed columns are requested);
//   default metaColumns(table). A name the table does not have is a TypeError.
// - pushed: [{column, op: 'eq' ('=')|'in', value | values}] (also `attr` for column, as in the 02 §4 Condition shape,
//   and a Map/object {column: values}); op defaults to 'in' with values, else 'eq'. A value is a JS value or a Compiled
//   (compileExpr result, evaluated once per run with fn([], env) after its pre). Entries on one column intersect. Per
//   run, after sql_variant unwrapping, each value gives a key, is dropped, or makes its entry unconstraining (the
//   planner's client Filter then decides; SQL Server would convert the column, not the value: 02 §4.2 Constants):
//   - NULL values are dropped (`= NULL` and `IN (NULL)` are never true).
//   - Logical-name columns (META_PUSHABLE, attributeof): a non-string value makes the entry unconstraining. A string
//     is folded with types.collKeyAI (lower case, accents and trailing spaces removed); a folded key that is not
//     1-128 characters of [a-z0-9_] can never equal a logical name and is dropped, so `IN (SELECT name FROM account)`
//     or `= REPLICATE('x', 70000)` sends nothing for those values. The key is what is sent (server-side metadata
//     filters are exact, Q53) and what MetaScan itself filters on, CI_AI, so its rows are a superset of what any
//     stricter collation keeps (the planner keeps its Filter, 02 §7).
//   - attributetype: a string folded to an AttributeTypeCode name (Boolean … EntityName) is that member (sent in its
//     own spelling); another single word of letters and digits (a member this list lacks) makes the entry
//     unconstraining; anything else is dropped.
//   - bit columns: 0/1 (number, bigint or boolean) are the keys, other numbers are dropped (the bit converts to the
//     number's type and never equals it); int columns: integers in the int range are the keys, other numbers dropped.
//     A string makes the entry unconstraining (its conversion, or error 245, is the Filter's).
//   A column whose values all drop yields no rows and sends nothing.
// - meta, api: default env.meta and env.api (exec.js Notes); labels use meta.lang (else 1033).
// - env.scanArgs (exec.js Notes) is honoured as for FetchScan: an entry for this node with `rows` replays
//   them; `conds` [{attr, op: 'eq'|'in'|'null'|'not-null', value, values}] are applied exactly (eq/in on a column of
//   META_PUSHABLE or META_PROPERTY_PUSHABLE take keys by the rules above and also narrow the request; on other
//   columns, or with values those rules leave unconstraining, CI_AI keyOf equality).
// - Requests go through api.get / api.fn with the signal of a child AbortController linked to env.signal (02 §6, as
//   for FetchScan). Each one sent counts in exec.js countRequests (setting Max requests per statement) and
//   stats.requests. Identical requests of one statement are sent once and shared (the statement state,
//   stateOf(env)), so a correlated re-run or two scans of one table cost one request; a failed one is not
//   kept. Requests run at most api.dop (1-32, default 4) at a time, and rows stream as each arrives, in request
//   order. A consumer that stops early (Top, EXISTS) stops the scheduling of further requests, and each request
//   of the run still in flight that no other run of the statement waits for is aborted (no 'Query cancelled.': nobody
//   reads it) and forgotten, so a later scan of the statement that needs it sends it again.
// - Loading per table (02 §7):
//   - entity: with meta.entities() loaded and every needed column one of meta's entity-list columns (metadataid,
//     logicalname, schemaname, entitysetname, logicalcollectionname, displayname, displaycollectionname,
//     description, objecttypecode, primaryidattribute, primarynameattribute, primaryimageattribute, ownershiptype,
//     tabletype, isactivity, iscustomentity, ismanaged, isintersect, isvalidforadvancedfind, isprivate,
//     islogicalentity, isretentionenabled, isarchivalenabled, dataproviderid, hasactivities,
//     isoptimisticconcurrencyenabled) no request , except one for pushed names the cached list lacks (a
//     table created since the list was cached, e.g. `IF NOT EXISTS (… WHERE logicalname = 'new_t')`); otherwise one
//     `EntityDefinitions?$select=<every needed
//     property>[&$filter=LogicalName eq 'a' or …]&LabelLanguages=<lang>` (50 names per request). Reading: the
//     request carries the list columns too, not only "the other referenced columns", so a table created since the
//     list was cached has all its values and no join to the cache is needed.
//   - attribute: per table whose attributes meta already holds (meta.entitySync) when every needed column is one of
//     metadataid, logicalname, schemaname, entitylogicalname, displayname, description, attributetype,
//     attributetypename, attributeof, columnnumber, isprimaryid, isprimaryname, iscustomattribute, ismanaged,
//     isvalidforcreate, isvalidforread, isvalidforupdate, isvalidforadvancedfind, issecured, islogical,
//     requiredlevel, targets, datetimebehavior, yomiof, maxlength (the columns meta loads for every attribute),
//     from meta; every other table through RetrieveMetadataChanges, ≤ 20 tables per request (api.fn moves a URL
//     over 16,000 characters into $batch): Criteria = an Or of `LogicalName Equals '<t>'` (System.String), the
//     documented form, equivalent to 02 §7's `LogicalName In […]` (the Web API's Object.Value is Edm.String and the
//     String[] form is not verified live); Properties ['LogicalName', 'Attributes'] (RetrieveMetadataChanges returns
//     only the properties it is asked for, besides MetadataId and HasChanged); AttributeQuery.Properties = the needed
//     properties (entitylogicalname is the entity's LogicalName, else the attribute's EntityLogicalName when the
//     answer has it, else NULL; optionset and optionsetname come from OptionSet); LabelQuery {FilterLanguages: [lang],
//     MissingLabelBehavior: 0} (Values below). AttributeQuery.Criteria: the pushed attribute logical names (at most
//     100) in the same Or form; else the pushed META_PROPERTY_PUSHABLE conditions: an And of the single-valued
//     columns' `Equals`, else the Or of the column with the fewest values (at most 100), with typed Values
//     (System.String; System.Boolean 'true'/'false'; System.Int32; AttributeType as
//     Microsoft.Xrm.Sdk.Metadata.AttributeTypeCode with the member name), the other pushed columns staying client
//     filters. Dataverse answering such a request with a 400 refuses the property conditions: they are remembered
//     per api object (not sent again) and the request is sent again without them; rows are unchanged, since
//     MetaScan filters on every pushed column itself.
//     Without a table condition: pushed attribute logical names give one request per 100 names without entity
//     Criteria, and pushed property conditions one request without entity Criteria (the attribute criteria keep the
//     answer small; SQL 4 CDS sends one too), with no info line. Otherwise the tables are meta.entities() (one request
//     per 20), else one request without Criteria.
//   - relationship_1_n and relationship_n_1 (the same 1:N relationship rows; 1_n lists each entity's
//     OneToManyRelationships, n_1 its ManyToOneRelationships): pushed referencedentity reads the
//     OneToManyRelationships, referencingentity the ManyToOneRelationships (the shorter list when both are pushed) of
//     `EntityDefinitions?$select=LogicalName&$filter=…&$expand=<nav>($select=…)`; without either, one
//     `RelationshipDefinitions/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata?$select=…`. The cascade columns
//     read CascadeConfiguration (Assign, Delete, Merge, Reparent, Share, Unshare, Archive, RollupView). relationship_n_n
//     the same with ManyToManyRelationships and ManyToManyRelationshipMetadata. Rows are de-duplicated by MetadataId.
//   - alternate_key: `EntityDefinitions?$select=LogicalName[&$filter=…]&$expand=Keys($select=…)`; entitylogicalname
//     and the other columns' owner come from the entity.
//   - optionsetvalue: RetrieveMetadataChanges as for attribute, with AttributeQuery.Properties LogicalName and
//     OptionSet (02 §7 names RetrieveMetadataChanges for the attribute subtype columns, and OptionSet is one of them;
//     the per-cast EntityDefinitions reads would take five requests per table). One row per option of each
//     attribute's OptionSet: Options, or FalseOption then TrueOption of a Boolean column's option set (an extension:
//     SQL 4 CDS lists EnumAttributeMetadata options only; meta.options gives Booleans the same 0/1 rows).
//     attributeid = the attribute's MetadataId; isglobal and optionsetname come from the option set.
//   - globaloptionset: meta.globalOptionSets() (cached per session) when every needed column is metadataid, name,
//     displayname, description, optionsettype, iscustomoptionset, ismanaged or isglobal (always 1); else
//     `GlobalOptionSetDefinitions?$select=…&LabelLanguages=<lang>`, without $select when trueoption, falseoption or
//     parentoptionsetname is needed (they exist only on the BooleanOptionSetMetadata and OptionSetMetadata
//     subtypes, which a $select on the OptionSetMetadataBase collection cannot name). globaloptionsetvalue:
//     meta.globalOptionSets() for optionsetid, optionsetname, value, label, description and color; else the full
//     GlobalOptionSetDefinitions (Options, or FalseOption then TrueOption).
//   - sys.messages: messages.js MESSAGES in Object.keys order (ascending), language_id 1033, is_event_logged 0; no
//     request. sys.time_zone_info: above; no request.
// - Values (02 §7): labels are the UserLocalizedLabel text, else the LocalizedLabels entry of the language, else
//   the first (meta.js labelOf's rule). One label rule on every path: every read asks for the user language only
//   (LabelLanguages=<lang> on EntityDefinitions, GlobalOptionSetDefinitions and meta's reads; FilterLanguages [lang]
//   with MissingLabelBehavior 0 on RetrieveMetadataChanges), so a label the user's language lacks is NULL whether a
//   column comes from meta's cache, EntityDefinitions or RetrieveMetadataChanges (02 §7 'user-language label
//   text'); a fallback to the base language would have to be added to meta.js and here together. A managed
//   property, enum wrapper or OptionMetadata gives `.Value`; a nested metadata object gives its
//   MetadataId and an EntityReference its Id (alternate_key.asyncjob); arrays are comma-joined; OwnershipType numbers
//   take their enum names; then the column's type: bit 1/0, int, float, guid lower case, datetime a Date, string as
//   text, and defaultvalue (sql_variant) a types.variant of bit, int, bigint, float or nvarchar(4000). A property the
//   answer leaves out is NULL.
// - A property Dataverse does not know (a 400 whose message names it as 'property named …', e.g. on an older
//   environment) is dropped from the request, which is sent again; its columns are NULL and Messages warns
//   `metadata.<table>: Dataverse has no <type> property '<Prop>', so the columns that read it are NULL.` The
//   property is remembered per api object.
// - A read of every table's attributes or option values (no table condition, more than one request) adds the info
//   line `Loading the <attributes|option values> of all <n> tables (<k> requests).`; above 100 tables it is the
//   warning `metadata.<table> has no condition on entitylogicalname, so it reads … of all <n> tables (<k>
//   requests). Add WHERE entitylogicalname = '…' to read only the tables you need.` (02 §7 'progress messages …
//   warn'). env.progress?.(text, pct) (extension of the 01 §7 env; J's session forwards it as the RunHandle
//   `progress {text, pct}` event, 02 §9) is called after each request of such a read. The line is given when the
//   run sends its first request (not when the statement cache answers every request), and each info line, warning
//   and progress series is given once per statement (the statement state), however often the node runs
//   (NestedLoop/APPLY right sides, correlated subqueries); so is the unknown-property warning above.
// - server: true for metadata.* (Dataverse data), false for sys.*. explain(): detail `metadata.attribute
//   (entitylogicalname in ('account'))` (string values as the folded keys that are sent); props Table, Columns,
//   Pushed, Source and, after a run, 'Read from'.
// - META_TABLES spells the column of EntityMetadata.DaysSinceRecordLastModified
//   'daysincerecordlastmodified' (one 's'; SQL 4 CDS lower-cases the property: 'dayssincerecordlastmodified'), and it
//   lacks EntityMetadata properties SQL 4 CDS exposes (isretrieveauditenabled, isretrievemultipleauditenabled,
//   issolutionaware, isslaenabled, ismsteamsintegrationenabled, haschanged, entityhelpurl, entityhelpurlenabled,
//   canchangetrackingbeenabled, canchangehierarchicalrelationship, isenabledfortrace, isvisibleinmobileclient,
//   isofflineinmobileclient) and AttributeMetadata ones (minsupportedvalue, maxsupportedvalue, haschanged), so a
//   SQL 4 CDS query naming them raises 207. MetaScan already reads both
//   spellings of the first and has readers for the others, so columns added under those names work at once.
// - Open for the 04 §5.2 live probe: what RetrieveMetadataChanges returns for entity
//   properties it was not asked for (LogicalName is always filled); whether an AttributeQuery condition on
//   AttributeType takes the AttributeTypeCode Type above (a refusal costs one extra request per api object); and
//   whether MissingLabelBehavior 0 gives the same labels as LabelLanguages=<lang> for a label the user's language
//   lacks.

import { MESSAGES } from './messages.js';
import { collKeyAI, keyOf, variant, variantValue, winZones, zoneTz } from './types.js';
import { TVFS } from './functions.js';
import { PlanNode, countRequests, stateOf, emitInfo, emitWarn } from './exec.js';

// Compact column lists: 'name' = string, 'name:dt' otherwise (dt codes below).
const DT = { g: 'guid', b: 'bit', i: 'int', f: 'float', d: 'datetime', a: 'any' };
const T = {
  entity:
    'metadataid:g logicalname schemaname entitysetname logicalcollectionname collectionschemaname displayname ' +
    'displaycollectionname description objecttypecode:i primaryidattribute primarynameattribute primaryimageattribute ' +
    'ownershiptype tabletype isactivity:b isactivityparty:b iscustomentity:b iscustomizable:b ismanaged:b isintersect:b ' +
    'isauditenabled:b isvalidforadvancedfind:b isvalidforqueue:b isprivate:b islogicalentity:b isretentionenabled:b ' +
    'isarchivalenabled:b changetrackingenabled:b dataproviderid:g datasourceid:g hasactivities:b hasnotes:b hasfeedback:b ' +
    'hasemailaddresses:b introducedversion iconsmallname iconmediumname iconlargename iconvectorname entitycolor ' +
    'enforcestatetransitions:b isbpfentity:b isstatemodelaware:b isduplicatedetectionenabled:b isquickcreateenabled:b ' +
    'isconnectionsenabled:b isdocumentmanagementenabled:b ismailmergeenabled:b isoptimisticconcurrencyenabled:b ' +
    'isavailableoffline:b isenabledforcharts:b isimportable:b ismappable:b isrenameable:b isreadingpaneenabled:b ' +
    'isknowledgemanagementenabled:b autocreateaccessteams:b autoroutetoownerqueue:b activitytypemask:i ' +
    'canbeinmanytomany:b canbeprimaryentityinrelationship:b canberelatedentityinrelationship:b cancreateattributes:b ' +
    'cancreatecharts:b cancreateforms:b cancreateviews:b canmodifyadditionalsettings:b cantriggerworkflow:b ' +
    'createdon:d modifiedon:d daysincerecordlastmodified:i externalname externalcollectionname ' +
    'recurrencebaseentitylogicalname reportviewname synctoexternalsearchindex:b usesbusinessdatalabeltable:b',
  attribute:
    'metadataid:g logicalname schemaname entitylogicalname displayname description attributetype attributetypename ' +
    'attributeof columnnumber:i isprimaryid:b isprimaryname:b iscustomattribute:b ismanaged:b iscustomizable:b ' +
    'isvalidforcreate:b isvalidforread:b isvalidforupdate:b isvalidforadvancedfind:b isvalidforform:b isvalidforgrid:b ' +
    'isfilterable:b issearchable:b issortableenabled:b issecured:b isauditenabled:b islogical:b isrenameable:b ' +
    'isretrievable:b isrequiredforform:b isvalidodataattribute:b isdatasourcesecret:b isglobalfilterenabled:b ' +
    'requiredlevel sourcetype:i sourcetypemask:i formuladefinition introducedversion deprecatedversion createdon:d ' +
    'modifiedon:d autonumberformat externalname linkedattributeid:g inheritsfrom:g canbesecuredforcreate:b ' +
    'canbesecuredforread:b canbesecuredforupdate:b maxlength:i databaselength:i format formatname imemode yomiof ' +
    'islocalizable:b minvalue:f maxvalue:f precision:i precisionsource:i isbasecurrency:b calculationof ' +
    'datetimebehavior canchangedatetimebehavior:b defaultformvalue:i defaultvalue:a optionset:g optionsetname targets ' +
    'maxheight:i maxwidth:i maxsizeinkb:i canstorefullimage:b isprimaryimage:b parentpicklistlogicalname ' +
    'childpicklistlogicalnames',
  relationship_1_n:
    'metadataid:g schemaname referencedentity referencedattribute referencingentity referencingattribute ' +
    'referencedentitynavigationpropertyname referencingentitynavigationpropertyname ishierarchical:b ' +
    'relationshipbehavior:i relationshiptype securitytypes iscustomrelationship:b iscustomizable:b ismanaged:b ' +
    'isvalidforadvancedfind:b introducedversion haschanged:b ' +
    // SQL Studio extension (00 §3, 02 §7): CascadeConfiguration flattened, values are the cascade type names.
    'cascadeassign cascadedelete cascademerge cascadereparent cascadeshare cascadeunshare cascadearchive cascaderollupview',
  relationship_n_n:
    'metadataid:g schemaname entity1logicalname entity1intersectattribute entity1navigationpropertyname ' +
    'entity2logicalname entity2intersectattribute entity2navigationpropertyname intersectentityname ' +
    'iscustomrelationship:b iscustomizable:b ismanaged:b relationshiptype securitytypes isvalidforadvancedfind:b ' +
    'introducedversion haschanged:b',
  alternate_key:
    'metadataid:g logicalname schemaname displayname entitylogicalname keyattributes entitykeyindexstatus asyncjob:g ' +
    'iscustomizable:b ismanaged:b introducedversion issynchronized:b isexportkey:b',
  optionsetvalue:
    'attributeid:g entitylogicalname attributelogicalname optionsetname value:i label description color isglobal:b ' +
    'state:i defaultstatus:i invariantname externalvalue ishidden:b ismanaged:b metadataid:g tag',
  globaloptionset:
    'metadataid:g name displayname description isglobal:b iscustomoptionset:b iscustomizable:b ismanaged:b ' +
    'optionsettype introducedversion externaltypename parentoptionsetname trueoption:i falseoption:i',
  globaloptionsetvalue:
    'optionsetid:g optionsetname value:i label description color externalvalue ishidden:b ismanaged:b metadataid:g',
};
T.relationship_n_1 = T.relationship_1_n;

const ORDER = ['entity', 'attribute', 'relationship_1_n', 'relationship_n_1', 'relationship_n_n', 'alternate_key',
  'optionsetvalue', 'globaloptionset', 'globaloptionsetvalue'];

// The nine metadata tables with their columns, in schema `metadata`.
export const META_TABLES = ORDER.map(name => ({
  name,
  columns: T[name].split(' ').map(c => {
    const [n, k] = c.split(':');
    return { name: n, dt: k ? DT[k] : 'string' };
  }),
}));

// ============================================================================ sys tables, lookups

const freeze = Object.freeze;
const lower = s => String(s).toLowerCase();
// A logical name of a Dataverse answer in lower case, else null (a missing, empty or non-string LogicalName).
const nameOf = v => (typeof v === 'string' && v !== '' ? v.toLowerCase() : null);

// [name, dt, nvarchar length] of the sys views (02 §7, 01 §8; time_zone_info: see the notes above).
const SYS_DEF = {
  messages: [['message_id', 'int'], ['language_id', 'int'], ['severity', 'int'], ['is_event_logged', 'bit'], ['text', 'string', 2048]],
  time_zone_info: [['name', 'string', 128], ['current_utc_offset', 'string', 12], ['is_currently_dst', 'bit']],
};

// The views of schema `sys`: sys.messages (02 §7) and sys.time_zone_info.
export const SYS_TABLES = freeze(Object.keys(SYS_DEF).map(name => freeze({
  name,
  columns: freeze(SYS_DEF[name].map(([n, dt, len]) => freeze(len ? { name: n, dt, len, unicode: true } : { name: n, dt }))),
})));

// Columns whose constant equality / IN conjuncts MetaScan accepts as `pushed`, per table.
export const META_PUSHABLE = freeze({
  entity: freeze(['logicalname']),
  attribute: freeze(['entitylogicalname', 'logicalname']),
  relationship_1_n: freeze(['referencedentity', 'referencingentity']),
  relationship_n_1: freeze(['referencingentity', 'referencedentity']),
  relationship_n_n: freeze(['entity1logicalname', 'entity2logicalname']),
  alternate_key: freeze(['entitylogicalname']),
  optionsetvalue: freeze(['entitylogicalname', 'attributelogicalname']),
  globaloptionset: freeze([]),
  globaloptionsetvalue: freeze([]),
});

// Base AttributeMetadata properties MetaScan folds into AttributeQuery.Criteria: column -> [Property, value kind].
const ATTR_CONDS = new Map([
  ['attributetype', ['AttributeType', 'enum']],
  ['attributeof', ['AttributeOf', 'name']],
  ...('IsCustomAttribute IsManaged IsLogical IsPrimaryId IsPrimaryName IsValidForCreate IsValidForRead IsValidForUpdate ' +
    'IsSecured IsFilterable IsSearchable IsRetrievable IsValidODataAttribute').split(' ').map(p => [p.toLowerCase(), [p, 'bit']]),
  ['columnnumber', ['ColumnNumber', 'int']],
  ['sourcetype', ['SourceType', 'int']],
]);
// The AttributeTypeCode members by folded name (the AttributeType values Dataverse returns and accepts).
const ATTRIBUTE_TYPES = new Map(('Boolean Customer DateTime Decimal Double Integer Lookup Memo Money Owner PartyList Picklist ' +
  'State Status String Uniqueidentifier CalendarRules Virtual BigInt ManagedProperty EntityName').split(' ').map(n => [n.toLowerCase(), n]));
const PROPERTY_PUSH = new Map([['attribute', freeze([...ATTR_CONDS.keys()])]]);
const NO_COLUMNS = freeze([]);

// Columns whose constant equality / IN conjuncts on base metadata properties MetaScan also accepts as `pushed`.
export const META_PROPERTY_PUSHABLE = freeze(Object.fromEntries(ORDER.map(n => [n, PROPERTY_PUSH.get(n) || NO_COLUMNS])));

// Whether MetaScan accepts pushed base-property conditions on that column of that table.
export function isPropertyPushable(table, column) {
  const d = tableOf(table);
  return !!d && typeof column === 'string' && propertyColumns(d).includes(lower(column));
}

// The value kind of a pushable column of a metadata table: 'name' (logical names), 'enum', 'bit' or 'int'.
function kindOf(table, column) {
  const c = table === 'attribute' ? ATTR_CONDS.get(column) : undefined;
  return c ? c[1] : 'name';
}

// The META_PROPERTY_PUSHABLE columns of a table descriptor.
function propertyColumns(d) {
  return (d.schema === 'metadata' && PROPERTY_PUSH.get(d.name)) || NO_COLUMNS;
}

// Whether the (lower-case) column of the table descriptor takes pushed conditions (either list).
const pushableIn = (d, column) => d.pushable.includes(column) || propertyColumns(d).includes(column);

// System table-valued functions by lower-case name -> functions.js TVFS name (02 §7).
export const SYS_FUNCTIONS = freeze(new Map([['fn_helpcollations', 'FN_HELPCOLLATIONS']]));

// The functions.js TVF entry of a sys function name (`fn_helpcollations`, any case), else null.
export function sysFunction(name) {
  const key = SYS_FUNCTIONS.get(lower(name ?? ''));
  return (key && TVFS.get(key)) || null;
}

let tableDefs = null;

// Descriptors of every metadata and sys table by full lower-case name ('metadata.entity'), built on first use.
function defs() {
  if (!tableDefs) {
    tableDefs = new Map();
    for (const t of META_TABLES) {
      const columns = freeze(t.columns.map(c => freeze(c.dt === 'string' ? { name: c.name, dt: 'string', len: -1, unicode: true } : { name: c.name, dt: c.dt })));
      const full = 'metadata.' + t.name;
      tableDefs.set(full, freeze({ schema: 'metadata', name: t.name, full, columns, pushable: META_PUSHABLE[t.name] }));
    }
    for (const t of SYS_TABLES) {
      tableDefs.set('sys.' + t.name, freeze({ schema: 'sys', name: t.name, full: 'sys.' + t.name, columns: t.columns, pushable: freeze([]) }));
    }
  }
  return tableDefs;
}

// The table `schema.name` (metadata or sys, any case) as {schema, name, full, columns, pushable}, else null.
export function findMetaTable(schema, name) {
  if (typeof schema !== 'string' || typeof name !== 'string') return null;
  return defs().get(lower(schema) + '.' + lower(name)) || null;
}

// The descriptor of 'entity', 'metadata.entity' or 'sys.messages' (a name without schema is a metadata table).
function tableOf(table) {
  if (typeof table !== 'string') return null;
  const dot = table.indexOf('.');
  return dot < 0 ? findMetaTable('metadata', table) : findMetaTable(table.slice(0, dot), table.slice(dot + 1));
}

// Fresh Column objects (01 §6.1) of a metadata or sys table; metadata columns are ci_ai (01 §5.2).
export function metaColumns(table, qual = null) {
  const d = tableOf(table);
  if (!d) throw new TypeError(`metaColumns: unknown table '${String(table)}'`);
  const q = qual == null ? null : lower(qual);
  return d.columns.map(c => (d.schema === 'metadata' ? { ...c, qual: q, ci_ai: true } : { ...c, qual: q }));
}

// Whether MetaScan accepts pushed conditions on that column of that table.
export function isPushable(table, column) {
  const d = tableOf(table);
  return !!d && typeof column === 'string' && d.pushable.includes(lower(column));
}

// ============================================================================================ value mapping

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNERSHIP = new Map([[0, 'None'], [1, 'UserOwned'], [2, 'TeamOwned'], [4, 'BusinessOwned'], [8, 'OrganizationOwned'],
  [16, 'BusinessParented'], [32, 'Filtered']]);
const T_BIT = freeze({ dt: 'bit' });
const T_INT = freeze({ dt: 'int' });
const T_BIGINT = freeze({ dt: 'bigint' });
const T_FLOAT = freeze({ dt: 'float' });
const T_NVARCHAR = freeze({ dt: 'string', len: 4000, unicode: true });
const INT_MIN = -2147483648, INT_MAX = 2147483647;

// The text of a Label: UserLocalizedLabel, else the LocalizedLabels entry of lang, else the first (as meta.js).
function labelText(l, lang) {
  const u = l.UserLocalizedLabel;
  if (u && typeof u.Label === 'string') return u.Label;
  const list = Array.isArray(l.LocalizedLabels) ? l.LocalizedLabels : [];
  const m = list.find(x => x && x.LanguageCode === lang) || list[0];
  return m && typeof m.Label === 'string' ? m.Label : null;
}

// A Web API metadata value made plain: Label -> text, managed property / enum wrapper / option -> .Value, nested
// metadata -> MetadataId, EntityReference -> Id; other objects NULL; arrays and scalars as they are.
function flat(v, lang) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v) || v instanceof Date) return v;
  if (Object.hasOwn(v, 'LocalizedLabels') || Object.hasOwn(v, 'UserLocalizedLabel')) return labelText(v, lang);
  if (Object.hasOwn(v, 'Value')) return v.Value ?? null;
  if (Object.hasOwn(v, 'MetadataId')) return v.MetadataId ?? null;
  if (Object.hasOwn(v, 'Id')) return v.Id ?? null;
  return null;
}

// Value converters by column dt: a raw metadata value -> the SQL value (01 §5).
const CONV = {
  string(v, lang) {
    const x = flat(v, lang);
    if (x === null) return null;
    if (Array.isArray(x)) {
      const parts = [];
      for (const e of x) {
        const p = flat(e, lang);
        if (p !== null && typeof p !== 'object') parts.push(String(p));
      }
      return parts.join(',');
    }
    return typeof x === 'string' ? x : typeof x === 'object' ? null : String(x);
  },
  bit(v, lang) {
    const x = flat(v, lang);
    if (typeof x === 'boolean') return x ? 1 : 0;
    if (typeof x === 'number') return Number.isNaN(x) ? null : x ? 1 : 0;
    if (typeof x === 'string') {
      const s = x.toLowerCase();
      return s === 'true' || s === '1' ? 1 : s === 'false' || s === '0' ? 0 : null;
    }
    return null;
  },
  int(v, lang) {
    const x = flat(v, lang);
    if (typeof x === 'number') return Number.isInteger(x) ? x : null;
    if (typeof x === 'string' && /^-?\d{1,15}$/.test(x)) return Number(x);
    if (typeof x === 'boolean') return x ? 1 : 0;
    return null;
  },
  float(v, lang) {
    const x = flat(v, lang);
    if (typeof x === 'number') return Number.isFinite(x) ? x : null;
    if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
    return null;
  },
  guid(v, lang) {
    const x = flat(v, lang);
    return typeof x === 'string' && GUID_RE.test(x) ? x.toLowerCase() : null;
  },
  datetime(v, lang) {
    const x = flat(v, lang);
    if (x instanceof Date) return Number.isNaN(x.getTime()) ? null : x;
    if (typeof x !== 'string' || x === '') return null;
    const d = new Date(x);
    return Number.isNaN(d.getTime()) ? null : d;
  },
  any(v, lang) {
    const x = flat(v, lang);
    if (x === null) return null;
    if (typeof x === 'boolean') return variant(x ? 1 : 0, T_BIT);
    if (typeof x === 'number') {
      if (!Number.isFinite(x)) return null;
      if (Number.isInteger(x)) return variant(x, x >= INT_MIN && x <= INT_MAX ? T_INT : Number.isSafeInteger(x) ? T_BIGINT : T_FLOAT);
      return variant(x, T_FLOAT);
    }
    const s = CONV.string(x, lang);
    return s === null ? null : variant(s, T_NVARCHAR);
  },
};

// ============================================================================================ table specs

const NS = 'Microsoft.Dynamics.CRM.';
// The Web API property names (PascalCase) behind the columns: lower-casing gives the column name.
const PROPS = {
  entity: 'MetadataId LogicalName SchemaName EntitySetName LogicalCollectionName CollectionSchemaName DisplayName ' +
    'DisplayCollectionName Description ObjectTypeCode PrimaryIdAttribute PrimaryNameAttribute PrimaryImageAttribute ' +
    'OwnershipType TableType IsActivity IsActivityParty IsCustomEntity IsCustomizable IsManaged IsIntersect ' +
    'IsAuditEnabled IsValidForAdvancedFind IsValidForQueue IsPrivate IsLogicalEntity IsRetentionEnabled ' +
    'IsArchivalEnabled ChangeTrackingEnabled DataProviderId DataSourceId HasActivities HasNotes HasFeedback ' +
    'HasEmailAddresses IntroducedVersion IconSmallName IconMediumName IconLargeName IconVectorName EntityColor ' +
    'EnforceStateTransitions IsBPFEntity IsStateModelAware IsDuplicateDetectionEnabled IsQuickCreateEnabled ' +
    'IsConnectionsEnabled IsDocumentManagementEnabled IsMailMergeEnabled IsOptimisticConcurrencyEnabled ' +
    'IsAvailableOffline IsEnabledForCharts IsImportable IsMappable IsRenameable IsReadingPaneEnabled ' +
    'IsKnowledgeManagementEnabled AutoCreateAccessTeams AutoRouteToOwnerQueue ActivityTypeMask CanBeInManyToMany ' +
    'CanBePrimaryEntityInRelationship CanBeRelatedEntityInRelationship CanCreateAttributes CanCreateCharts ' +
    'CanCreateForms CanCreateViews CanModifyAdditionalSettings CanTriggerWorkflow CreatedOn ModifiedOn ' +
    'DaysSinceRecordLastModified ExternalName ExternalCollectionName RecurrenceBaseEntityLogicalName ReportViewName ' +
    'SyncToExternalSearchIndex UsesBusinessDataLabelTable ' +
    // EntityMetadata properties SQL 4 CDS exposes that META_TABLES has no column for yet.
    'IsRetrieveAuditEnabled IsRetrieveMultipleAuditEnabled IsSolutionAware IsSLAEnabled IsMSTeamsIntegrationEnabled ' +
    'HasChanged EntityHelpUrl EntityHelpUrlEnabled CanChangeTrackingBeEnabled CanChangeHierarchicalRelationship ' +
    'IsEnabledForTrace IsVisibleInMobileClient IsOfflineInMobileClient',
  attribute: 'MetadataId LogicalName SchemaName DisplayName Description AttributeType AttributeTypeName AttributeOf ' +
    'ColumnNumber IsPrimaryId IsPrimaryName IsCustomAttribute IsManaged IsCustomizable IsValidForCreate IsValidForRead ' +
    'IsValidForUpdate IsValidForAdvancedFind IsValidForForm IsValidForGrid IsFilterable IsSearchable IsSortableEnabled ' +
    'IsSecured IsAuditEnabled IsLogical IsRenameable IsRetrievable IsRequiredForForm IsValidODataAttribute ' +
    'IsDataSourceSecret IsGlobalFilterEnabled RequiredLevel SourceType SourceTypeMask FormulaDefinition ' +
    'IntroducedVersion DeprecatedVersion CreatedOn ModifiedOn AutoNumberFormat ExternalName LinkedAttributeId ' +
    'InheritsFrom CanBeSecuredForCreate CanBeSecuredForRead CanBeSecuredForUpdate MaxLength DatabaseLength Format ' +
    'FormatName ImeMode YomiOf IsLocalizable MinValue MaxValue Precision PrecisionSource IsBaseCurrency CalculationOf ' +
    'DateTimeBehavior CanChangeDateTimeBehavior DefaultFormValue DefaultValue Targets MaxHeight MaxWidth MaxSizeInKB ' +
    'CanStoreFullImage IsPrimaryImage ParentPicklistLogicalName ChildPicklistLogicalNames ' +
    // AttributeMetadata properties without a META_TABLES column yet.
    'MinSupportedValue MaxSupportedValue HasChanged',
  oneToMany: 'MetadataId SchemaName ReferencedEntity ReferencedAttribute ReferencingEntity ReferencingAttribute ' +
    'ReferencedEntityNavigationPropertyName ReferencingEntityNavigationPropertyName IsHierarchical RelationshipBehavior ' +
    'RelationshipType SecurityTypes IsCustomRelationship IsCustomizable IsManaged IsValidForAdvancedFind ' +
    'IntroducedVersion HasChanged',
  manyToMany: 'MetadataId SchemaName Entity1LogicalName Entity1IntersectAttribute Entity1NavigationPropertyName ' +
    'Entity2LogicalName Entity2IntersectAttribute Entity2NavigationPropertyName IntersectEntityName ' +
    'IsCustomRelationship IsCustomizable IsManaged RelationshipType SecurityTypes IsValidForAdvancedFind ' +
    'IntroducedVersion HasChanged',
  key: 'MetadataId LogicalName SchemaName DisplayName KeyAttributes EntityKeyIndexStatus AsyncJob IsCustomizable ' +
    'IsManaged IntroducedVersion IsSynchronized IsExportKey',
  optionSet: 'MetadataId Name DisplayName Description IsGlobal IsCustomOptionSet IsCustomizable IsManaged ' +
    'OptionSetType IntroducedVersion ExternalTypeName ParentOptionSetName TrueOption FalseOption',
  option: 'Value Label Description Color State DefaultStatus InvariantName ExternalValue IsHidden IsManaged MetadataId Tag',
  globalOption: 'Value Label Description Color ExternalValue IsHidden IsManaged MetadataId',
};
const CASCADES = ['Assign', 'Delete', 'Merge', 'Reparent', 'Share', 'Unshare', 'Archive', 'RollupView'];
// meta.js AttrInfo types that stand for AttributeType Virtual (02 §2 type mapping).
const VIRTUAL_TYPES = new Set(['MultiSelectPicklist', 'Image', 'File']);

const own = (o, p) => (o === null || o === undefined ? undefined : o[p]);

// Column readers {props, get} for a list of PascalCase properties of the object pick(record).
function propReaders(list, pick, m = new Map()) {
  for (const p of list.split(' ')) m.set(lower(p), { props: [p], get: r => own(pick(r), p) });
  return m;
}

// Column readers of meta.js objects (cache records): [column, field name | (record) => value].
function cacheReaders(pairs, pick = r => r) {
  return new Map(pairs.map(([c, f]) => [c, { props: [], get: typeof f === 'function' ? f : r => own(pick(r), f) }]));
}

const values = j => (j && Array.isArray(j.value) ? j.value : []);
const arr = v => (Array.isArray(v) ? v : []);

// The options of an option set: Options, else FalseOption then TrueOption (Boolean option sets).
function optionsOf(os) {
  if (!os || typeof os !== 'object') return [];
  if (Array.isArray(os.Options)) return os.Options;
  const out = [];
  if (os.FalseOption) out.push(os.FalseOption);
  if (os.TrueOption) out.push(os.TrueOption);
  return out;
}

let specs = null;

// Every table's spec, built on first use: {cols, cache, load, dedupe?, source, values?}.
function tableSpecs() {
  if (specs) return specs;
  specs = new Map();
  const entityCols = propReaders(PROPS.entity, r => r);
  // META_TABLES spells this column 'daysincerecordlastmodified'; the property is DaysSinceRecordLastModified,
  // whose lower-cased name (SQL 4 CDS's spelling) keeps its own reader for when the column is renamed.
  entityCols.set('daysincerecordlastmodified', entityCols.get('dayssincerecordlastmodified'));
  const ownership = v => (typeof v === 'number' ? OWNERSHIP.get(v) ?? String(v) : v);
  entityCols.set('ownershiptype', { props: ['OwnershipType'], get: r => ownership(r.OwnershipType) });
  specs.set('metadata.entity', {
    cols: entityCols,
    cache: cacheReaders([['metadataid', 'metadataId'], ['logicalname', 'logicalName'], ['schemaname', 'schemaName'],
      ['entitysetname', 'entitySetName'], ['logicalcollectionname', 'logicalCollectionName'], ['displayname', 'displayName'],
      ['displaycollectionname', 'displayCollectionName'], ['description', 'description'], ['objecttypecode', 'objectTypeCode'],
      ['primaryidattribute', 'primaryIdAttribute'], ['primarynameattribute', 'primaryNameAttribute'],
      ['primaryimageattribute', 'primaryImageAttribute'], ['ownershiptype', 'ownershipType'], ['tabletype', 'tableType'],
      ['isactivity', 'isActivity'], ['iscustomentity', 'isCustom'], ['ismanaged', 'isManaged'], ['isintersect', 'isIntersect'],
      ['isvalidforadvancedfind', 'validForAdvancedFind'], ['isprivate', 'isPrivate'], ['islogicalentity', 'isLogical'],
      ['isretentionenabled', 'isRetentionEnabled'], ['isarchivalenabled', 'isArchivalEnabled'], ['dataproviderid', 'dataProviderId'],
      ['hasactivities', 'hasActivities'], ['isoptimisticconcurrencyenabled', 'optimisticConcurrency']]),
    load: loadEntities,
    source: 'cached entity list, else EntityDefinitions',
  });

  const attrCols = propReaders(PROPS.attribute, r => r.a);
  attrCols.set('entitylogicalname', { props: [], get: r => r.e });
  attrCols.set('optionset', { props: ['OptionSet'], get: r => own(r.a, 'OptionSet') });
  attrCols.set('optionsetname', { props: ['OptionSet'], get: r => own(own(r.a, 'OptionSet'), 'Name') });
  specs.set('metadata.attribute', {
    cols: attrCols,
    cache: cacheReaders([['metadataid', 'metadataId'], ['logicalname', 'logicalName'], ['schemaname', 'schemaName'],
      ['entitylogicalname', r => r.e], ['displayname', 'displayName'], ['description', 'description'],
      ['attributetype', r => (VIRTUAL_TYPES.has(r.a.type) ? 'Virtual' : r.a.type)], ['attributetypename', 'typeName'],
      ['attributeof', 'attributeOf'], ['columnnumber', 'columnNumber'], ['isprimaryid', 'isPk'], ['isprimaryname', 'isPrimaryName'],
      ['iscustomattribute', 'isCustom'], ['ismanaged', 'isManaged'], ['isvalidforcreate', 'validForCreate'],
      ['isvalidforread', 'validForRead'], ['isvalidforupdate', 'validForUpdate'], ['isvalidforadvancedfind', 'validForAdvancedFind'],
      ['issecured', 'isSecured'], ['islogical', 'isLogical'], ['requiredlevel', 'requiredLevel'], ['targets', 'targets'],
      ['datetimebehavior', 'behavior'], ['yomiof', 'yomiOf'], ['maxlength', 'maxLength']], r => r.a),
    load: loadAttributes,
    source: 'RetrieveMetadataChanges (≤ 20 tables per request), or the attributes meta holds',
  });

  const relCols = propReaders(PROPS.oneToMany, r => r);
  for (const c of CASCADES) relCols.set('cascade' + lower(c), { props: ['CascadeConfiguration'], get: r => own(own(r, 'CascadeConfiguration'), c) });
  const relSpec = { cols: relCols, cache: null, load: loadOneToMany, dedupe: true, source: 'EntityDefinitions $expand, else RelationshipDefinitions' };
  specs.set('metadata.relationship_1_n', relSpec);
  specs.set('metadata.relationship_n_1', relSpec);
  specs.set('metadata.relationship_n_n', {
    cols: propReaders(PROPS.manyToMany, r => r), cache: null, load: loadManyToMany, dedupe: true,
    source: 'EntityDefinitions $expand, else RelationshipDefinitions',
  });

  const keyCols = propReaders(PROPS.key, r => r.k);
  keyCols.set('entitylogicalname', { props: [], get: r => r.e });
  specs.set('metadata.alternate_key', { cols: keyCols, cache: null, load: loadKeys, source: 'EntityDefinitions $expand=Keys' });

  const osvCols = propReaders(PROPS.option, r => r.o);
  osvCols.set('attributeid', { props: [], get: r => own(r.a, 'MetadataId') });
  osvCols.set('entitylogicalname', { props: [], get: r => r.e });
  osvCols.set('attributelogicalname', { props: [], get: r => own(r.a, 'LogicalName') });
  osvCols.set('optionsetname', { props: [], get: r => own(r.os, 'Name') });
  osvCols.set('isglobal', { props: [], get: r => own(r.os, 'IsGlobal') });
  specs.set('metadata.optionsetvalue', { cols: osvCols, cache: null, load: loadOptionValues, source: 'RetrieveMetadataChanges (≤ 20 tables per request)' });

  specs.set('metadata.globaloptionset', {
    cols: propReaders(PROPS.optionSet, r => r),
    cache: cacheReaders([['metadataid', 'metadataId'], ['name', 'name'], ['displayname', 'displayName'], ['description', 'description'],
      ['optionsettype', 'optionSetType'], ['iscustomoptionset', 'isCustom'], ['ismanaged', 'isManaged'], ['isglobal', () => true]]),
    load: loadGlobalOptionSets,
    source: 'meta.globalOptionSets(), else GlobalOptionSetDefinitions',
  });

  const gosvCols = propReaders(PROPS.globalOption, r => r.o);
  gosvCols.set('optionsetid', { props: [], get: r => own(r.s, 'MetadataId') });
  gosvCols.set('optionsetname', { props: [], get: r => own(r.s, 'Name') });
  specs.set('metadata.globaloptionsetvalue', {
    cols: gosvCols,
    cache: cacheReaders([['optionsetid', r => r.s.metadataId], ['optionsetname', r => r.s.name], ['value', r => r.o.value],
      ['label', r => r.o.label], ['description', r => r.o.description], ['color', r => r.o.color]]),
    load: loadGlobalOptionValues,
    source: 'meta.globalOptionSets(), else GlobalOptionSetDefinitions',
  });

  // sys tables: records are complete rows of SQL values in column order.
  for (const t of SYS_TABLES) {
    const cols = new Map(t.columns.map((c, i) => [c.name, { props: [], get: r => r[i] }]));
    specs.set('sys.' + t.name, { cols, cache: null, load: t.name === 'messages' ? loadMessages : loadTimeZones, values: true,
      source: t.name === 'messages' ? 'messages.js MESSAGES (no request)' : 'types.js WIN_ZONES at the statement time (no request)' });
  }
  return specs;
}

// ============================================================================================ requests

const REQUESTS = { key: 'metatables requests' };
const EMITTED = { key: 'metatables messages' };
const RMC_TABLES = 20;
const FILTER_NAMES = 50;
const ATTR_NAMES_MAX = 100;
const LARGE_LOAD = 100;
const BATCH = 2000;
const TICK = 10000;
const UNKNOWN_PROP = /property named '([A-Za-z_][A-Za-z0-9_.]*)'/i;
// Properties an environment does not know, per api object: Set of '<type>.<Prop>'.
const unknownProps = new WeakMap();
// AttributeMetadata properties whose RetrieveMetadataChanges conditions an environment refused, per api object.
const refusedConds = new WeakMap();

const odataStr = s => `'${String(s).replace(/'/g, "''")}'`;
const nameFilter = names => '&$filter=' + encodeURIComponent(names.map(n => `LogicalName eq ${odataStr(n)}`).join(' or '));

// The typed Object value of a MetadataConditionExpression for a pushed key, by value kind.
const COND_VALUE = {
  name: k => ({ Type: 'System.String', Value: k }),
  enum: k => ({ Type: 'Microsoft.Xrm.Sdk.Metadata.AttributeTypeCode', Value: ATTRIBUTE_TYPES.get(k) }),
  bit: k => ({ Type: 'System.Boolean', Value: k ? 'true' : 'false' }),
  int: k => ({ Type: 'System.Int32', Value: String(k) }),
};

// A MetadataConditionExpression `prop Equals key`.
const equalsCond = (prop, kind, k) => ({ PropertyName: prop, ConditionOperator: 'Equals', Value: COND_VALUE[kind](k) });
// A MetadataFilterExpression: an Or of `prop Equals key` over the keys.
const orOf = (prop, kind, keys) => ({ FilterOperator: 'Or', Conditions: keys.map(k => equalsCond(prop, kind, k)) });

// The list in slices of at most n items.
function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// The abort reason of a read whose scan was closed before it finished (never shown: nobody reads it).
const closedReason = () => new DOMException('The scan was closed.', 'AbortError');

// One Dataverse read of the statement: sent once per distinct key and shared by the runs that ask for it, with a child
// AbortController linked to env.signal; a failure is not kept. run(signal) sends it.
function send(ctx, key, run) {
  // a task of a closed run (a retry after an unknown property or refused conditions) sends nothing more
  if (ctx.closed) return Promise.reject(closedReason());
  const st = stateOf(ctx.env);
  let cache = st.get(REQUESTS);
  if (!cache) st.set(REQUESTS, (cache = new Map()));
  let r = cache.get(key);
  if (!r) {
    if (!ctx.api) throw new TypeError(`MetaScan: reading ${ctx.table} needs env.api (the session's Dataverse api)`);
    countRequests(ctx.env);
    ctx.node.stats.requests++;
    if (ctx.onSend) ctx.onSend();
    const entry = { p: null, ctl: new AbortController(), users: 0, settled: false, key, cache };
    const outer = ctx.env.signal;
    let unlink = null;
    if (outer) {
      if (outer.aborted) entry.ctl.abort(outer.reason);
      else {
        const onAbort = () => entry.ctl.abort(outer.reason);
        outer.addEventListener('abort', onAbort, { once: true });
        unlink = () => outer.removeEventListener('abort', onAbort);
      }
    }
    const settle = ok => {
      entry.settled = true;
      if (unlink) unlink();
      if (!ok && cache.get(key) === entry) cache.delete(key);
    };
    entry.p = Promise.resolve().then(() => run(entry.ctl.signal));
    entry.p.then(() => settle(true), () => settle(false));
    cache.set(key, (r = entry));
  }
  if (!ctx.held.has(r)) {
    ctx.held.add(r);
    r.users++;
  }
  return r.p;
}

// Ends a run's use of its statement requests: one still in flight that no other run waits for is aborted and
// forgotten, so a later scan of the statement sends it again.
function release(ctx) {
  ctx.closed = true;
  for (const r of ctx.held) {
    if (--r.users === 0 && !r.settled) {
      if (r.cache.get(r.key) === r) r.cache.delete(r.key);
      r.ctl.abort(closedReason());
    }
  }
  ctx.held.clear();
}

// A GET of the statement (shared, counted) and a RetrieveMetadataChanges call of the statement.
const getJson = (ctx, path) => send(ctx, 'GET ' + path, signal => ctx.api.get(path, { signal }));
const rmcJson = (ctx, query) => send(ctx, 'RMC ' + JSON.stringify(query),
  signal => ctx.api.fn('RetrieveMetadataChanges', { Query: query }, { signal }));

// Adds a Messages info line or warning once per statement; true when it was added now.
function emitOnce(env, kind, text) {
  const st = stateOf(env);
  let seen = st.get(EMITTED);
  if (!seen) st.set(EMITTED, (seen = new Set()));
  const k = kind + ' ' + text;
  if (seen.has(k)) return false;
  seen.add(k);
  if (kind === 'warn') emitWarn(env, text);
  else emitInfo(env, text);
  return true;
}

// Whether a property of a metadata type is known to be missing in the environment of this api.
function isUnknown(api, type, prop) {
  const s = unknownProps.get(api);
  return !!s && s.has(type + '.' + prop);
}

// Records a property of a metadata type as missing in the environment of this api.
function markUnknown(api, type, prop) {
  let s = unknownProps.get(api);
  if (!s) unknownProps.set(api, (s = new Set()));
  s.add(type + '.' + prop);
}

// Runs call(props) with the properties the environment knows; a 400 naming one of them drops it and runs again.
async function withProps(ctx, type, props, call) {
  let list = [];
  for (const p of props) {
    if (isUnknown(ctx.api, type, p)) ctx.dropped.set(type + '.' + p, { type, prop: p });
    else list.push(p);
  }
  for (;;) {
    try {
      return await call(list);
    } catch (e) {
      const m = UNKNOWN_PROP.exec(e && typeof e.message === 'string' ? e.message : '');
      const bad = m ? list.find(p => lower(p) === lower(m[1].split('.').pop())) : null;
      if (!bad || bad === 'MetadataId' || bad === 'LogicalName' || (ctx.env.signal && ctx.env.signal.aborted)) throw e;
      markUnknown(ctx.api, type, bad);
      ctx.dropped.set(type + '.' + bad, { type, prop: bad });
      list = list.filter(p => p !== bad);
    }
  }
}

// Whether the environment of this api refused RetrieveMetadataChanges conditions on an AttributeMetadata property.
function condRefused(api, prop) {
  const s = api ? refusedConds.get(api) : null;
  return !!s && s.has(prop);
}

// Whether a failed request with property conditions is Dataverse refusing them (a 400, not a cancel).
const refusesConds = (e, ctx) => !!e && e.status === 400 && !(ctx.env.signal && ctx.env.signal.aborted);

// Records the properties of refused conditions for this api: later requests leave them to the client filter.
function refuseConds(api, props) {
  let s = refusedConds.get(api);
  if (!s) refusedConds.set(api, (s = new Set()));
  for (const p of props) s.add(p);
}

// AttributeQuery.Criteria from the pushed base-property conditions the environment has not refused:
// {crit, props} with an And of the single-valued columns, else the Or of the column with the fewest values (at most
// 100); null when there is none.
function propCrit(ctx) {
  if (ctx.table !== 'metadata.attribute') return null;
  const singles = [];
  let best = null;
  for (const [column, set] of ctx.keys) {
    const pc = ATTR_CONDS.get(column);
    if (!pc || condRefused(ctx.api, pc[0])) continue;
    if (set.size === 1) singles.push([pc, set]);
    else if (set.size <= ATTR_NAMES_MAX && (!best || set.size < best[1].size)) best = [pc, set];
  }
  if (singles.length) {
    const Conditions = singles.map(([[prop, kind], set]) => equalsCond(prop, kind, set.values().next().value));
    return { crit: { FilterOperator: 'And', Conditions }, props: singles.map(([[prop]]) => prop) };
  }
  if (!best) return null;
  const [[prop, kind], set] = best;
  return { crit: orOf(prop, kind, [...set]), props: [prop] };
}

// Runs tasks (functions returning promises) with at most dop in flight; yields their results in task order. The
// next task starts when the oldest one has finished, before its result is yielded, so the consumer's work overlaps
// the requests; a consumer that stops early leaves at most dop requests, which execute() aborts (release).
async function* inOrder(tasks, dop, onDone) {
  const running = [];
  let next = 0;
  const start = () => {
    const p = tasks[next++]();
    p.catch(() => {});
    running.push(p);
  };
  while (next < tasks.length && running.length < dop) start();
  let done = 0;
  while (running.length) {
    const v = await running.shift();
    if (next < tasks.length) start();
    done++;
    if (onDone) onDone(done, tasks.length);
    yield v;
  }
}

// The entity list meta holds, or null (not loaded, or no meta).
function entityList(meta) {
  const l = meta && typeof meta.entities === 'function' ? meta.entities() : null;
  return Array.isArray(l) && l.length ? l : null;
}

// Info line or warning for a read of every table's attributes or option values; the progress
// callback when this run gave the line (once per statement), else null.
function announceAll(ctx, what, n, k) {
  const fresh = n > LARGE_LOAD
    ? emitOnce(ctx.env, 'warn', `${ctx.table} has no condition on entitylogicalname, so it reads the ${what} of all ${n.toLocaleString('en-US')} tables (${k} requests). Add WHERE entitylogicalname = '…' to read only the tables you need.`)
    : emitOnce(ctx.env, 'info', `Loading the ${what} of all ${n.toLocaleString('en-US')} tables (${k} requests).`);
  const progress = ctx.env.progress;
  if (!fresh || typeof progress !== 'function') return null;
  return (done, total) => progress(`Loading the ${what} of all tables · ${done} of ${total} requests`, Math.round((done / total) * 100));
}

// ============================================================================================ loaders
// Each loader is an async generator of {cache: boolean, recs: record[]} (cache: meta.js objects, read by spec.cache).

async function* loadEntities(ctx) {
  let names = ctx.keys.get('logicalname');
  const list = entityList(ctx.meta);
  if (list && ctx.need.every(c => ctx.spec.cache.has(c))) {
    ctx.used.add('cached entity list');
    yield { cache: true, recs: list };
    if (!names) return;
    // a pushed name the cached list lacks may be a table created since the list was cached: ask for it
    const known = new Set(list.map(e => collKeyAI(e.logicalName)));
    names = new Set([...names].filter(n => !known.has(n)));
    if (!names.size) return;
  }
  ctx.used.add('EntityDefinitions');
  const props = ctx.props(['MetadataId', 'LogicalName']);
  const read = filter => () => withProps(ctx, 'EntityMetadata', props,
    sel => getJson(ctx, `EntityDefinitions?$select=${sel.join(',')}${filter}&LabelLanguages=${ctx.lang}`));
  const tasks = names ? chunk([...names], FILTER_NAMES).map(c => read(nameFilter(c))) : [read('')];
  for await (const j of inOrder(tasks, ctx.dop)) yield { cache: false, recs: values(j) };
}

// The Query of one RetrieveMetadataChanges request: tables (or every table), the needed attribute
// properties and the attribute criteria.
const rmcQuery = (ctx, tables, list, crit) => ({
  ...(tables ? { Criteria: orOf('LogicalName', 'name', tables) } : {}),
  Properties: { AllProperties: false, PropertyNames: ['LogicalName', 'Attributes'] },
  AttributeQuery: { Properties: { AllProperties: false, PropertyNames: list }, ...(crit ? { Criteria: crit } : {}) },
  LabelQuery: { FilterLanguages: [ctx.lang], MissingLabelBehavior: 0 },
});

// RetrieveMetadataChanges for attribute and optionsetvalue. nameColumn holds the pushed attribute
// logical names; cacheOf(table) returns cache records for a table meta already holds, or null.
async function* loadByTables(ctx, what, props, nameColumn, toRecs, cacheOf) {
  const pushed = ctx.keys.get('entitylogicalname');
  const names = ctx.keys.get(nameColumn) || null;
  const send1 = (tables, crit) => withProps(ctx, 'AttributeMetadata', props, list => rmcJson(ctx, rmcQuery(ctx, tables, list, crit)));
  if (!pushed) {
    // a narrow attribute condition without a table condition: requests without entity Criteria
    if (names) {
      ctx.used.add('RetrieveMetadataChanges');
      const tasks = chunk([...names], ATTR_NAMES_MAX).map(c => () => send1(null, orOf('LogicalName', 'name', c)));
      for await (const j of inOrder(tasks, ctx.dop)) yield { cache: false, recs: toRecs(j) };
      return;
    }
    for (let c = propCrit(ctx); c; c = propCrit(ctx)) {
      let j;
      try {
        j = await send1(null, c.crit);
      } catch (e) {
        if (!refusesConds(e, ctx)) throw e;
        refuseConds(ctx.api, c.props);
        continue;
      }
      ctx.used.add('RetrieveMetadataChanges');
      yield { cache: false, recs: toRecs(j) };
      return;
    }
  }
  let tables = pushed ? [...pushed] : null;
  let all = false;
  if (!tables) {
    const list = entityList(ctx.meta);
    if (list) {
      tables = list.map(e => e.logicalName);
      all = true;
    }
  }
  const rest = [];
  if (tables) {
    for (const t of tables) {
      const recs = cacheOf ? cacheOf(t) : null;
      if (recs) {
        ctx.used.add('attributes held by meta');
        yield { cache: true, recs };
      } else rest.push(t);
    }
    if (!rest.length) return;
  }
  // the attribute names when there are at most 100, else the property conditions; a refusal of those sends again
  const critOf = () => (names && names.size <= ATTR_NAMES_MAX ? { crit: orOf('LogicalName', 'name', [...names]), props: [] } : propCrit(ctx));
  const read = chunkNames => async () => {
    for (;;) {
      const c = critOf();
      try {
        return await send1(chunkNames, c ? c.crit : null);
      } catch (e) {
        if (!c || !c.props.length || !refusesConds(e, ctx)) throw e;
        refuseConds(ctx.api, c.props);
      }
    }
  };
  const tasks = tables ? chunk(rest, RMC_TABLES).map(read) : [read(null)];
  ctx.used.add('RetrieveMetadataChanges');
  // the info line or warning comes with the first request this run sends (none when the statement cache answers)
  let report = null;
  if (all && tasks.length > 1) {
    ctx.onSend = () => {
      ctx.onSend = null;
      report = announceAll(ctx, what, tables.length, tasks.length);
    };
  } else if (!tables) {
    ctx.onSend = () => {
      ctx.onSend = null;
      emitOnce(ctx.env, 'info', `Loading the ${what} of all tables (one request).`);
    };
  }
  try {
    for await (const j of inOrder(tasks, ctx.dop, (done, total) => { if (report) report(done, total); })) yield { cache: false, recs: toRecs(j) };
  } finally {
    ctx.onSend = null;
  }
}

function loadAttributes(ctx) {
  const props = ctx.props(['LogicalName']);
  const meta = ctx.meta;
  const cacheOk = meta && typeof meta.entitySync === 'function' && ctx.need.every(c => ctx.spec.cache.has(c));
  const cacheOf = cacheOk ? t => {
    const info = meta.entitySync(t);
    return info && info.logicalName === t && Array.isArray(info.attrList) ? info.attrList.map(a => ({ e: t, a })) : null;
  } : null;
  const toRecs = j => {
    const out = [];
    for (const em of arr(j && j.EntityMetadata)) {
      const e = nameOf(own(em, 'LogicalName'));
      for (const a of arr(own(em, 'Attributes'))) out.push({ e: e ?? nameOf(own(a, 'EntityLogicalName')), a });
    }
    return out;
  };
  return loadByTables(ctx, 'attributes', props, 'logicalname', toRecs, cacheOf);
}

function loadOptionValues(ctx) {
  const toRecs = j => {
    const out = [];
    for (const em of arr(j && j.EntityMetadata)) {
      const e = nameOf(own(em, 'LogicalName'));
      for (const a of arr(own(em, 'Attributes'))) {
        const os = own(a, 'OptionSet');
        const ae = e ?? nameOf(own(a, 'EntityLogicalName'));
        for (const o of optionsOf(os)) if (o && typeof o === 'object') out.push({ e: ae, a, os, o });
      }
    }
    return out;
  };
  return loadByTables(ctx, 'option values', ['LogicalName', 'OptionSet'], 'attributelogicalname', toRecs, null);
}

// EntityDefinitions with a relationship (or Keys) collection expanded, per ≤ 50 tables, or one unfiltered read.
async function* loadExpanded(ctx, type, nav, names, props, unfilteredPath, toRecs) {
  const expand = (filter, sel) => `EntityDefinitions?$select=LogicalName${filter}&$expand=${nav}($select=${sel.join(',')})&LabelLanguages=${ctx.lang}`;
  let tasks;
  if (names) {
    ctx.used.add(`EntityDefinitions $expand=${nav}`);
    tasks = chunk([...names], FILTER_NAMES).map(c => () => withProps(ctx, type, props, sel => getJson(ctx, expand(nameFilter(c), sel)))
      .then(j => toRecs(values(j), true)));
  } else if (unfilteredPath) {
    ctx.used.add(unfilteredPath.split('?')[0].replace(NS, ''));
    tasks = [() => withProps(ctx, type, props, sel => getJson(ctx, `${unfilteredPath}?$select=${sel.join(',')}`)).then(j => toRecs(values(j), false))];
  } else {
    ctx.used.add(`EntityDefinitions $expand=${nav}`);
    tasks = [() => withProps(ctx, type, props, sel => getJson(ctx, expand('', sel))).then(j => toRecs(values(j), true))];
  }
  for await (const recs of inOrder(tasks, ctx.dop)) yield { cache: false, recs };
}

// The relationships of the entities of an EntityDefinitions answer (expanded) or a RelationshipDefinitions answer.
const relRecs = nav => (list, expanded) => (expanded ? list.flatMap(em => arr(own(em, nav))) : list);

function loadOneToMany(ctx) {
  const refd = ctx.keys.get('referencedentity'), refg = ctx.keys.get('referencingentity');
  const props = ctx.props(['MetadataId']);
  let nav = null, names = null;
  if (refd && (!refg || refd.size <= refg.size)) [nav, names] = ['OneToManyRelationships', refd];
  else if (refg) [nav, names] = ['ManyToOneRelationships', refg];
  return loadExpanded(ctx, 'OneToManyRelationshipMetadata', nav, names, props,
    `RelationshipDefinitions/${NS}OneToManyRelationshipMetadata`, relRecs(nav));
}

function loadManyToMany(ctx) {
  const e1 = ctx.keys.get('entity1logicalname'), e2 = ctx.keys.get('entity2logicalname');
  const names = e1 && (!e2 || e1.size <= e2.size) ? e1 : e2 || null;
  return loadExpanded(ctx, 'ManyToManyRelationshipMetadata', 'ManyToManyRelationships', names, ctx.props(['MetadataId']),
    `RelationshipDefinitions/${NS}ManyToManyRelationshipMetadata`, relRecs('ManyToManyRelationships'));
}

function loadKeys(ctx) {
  const toRecs = list => {
    const out = [];
    for (const em of list) {
      const e = nameOf(own(em, 'LogicalName'));
      for (const k of arr(own(em, 'Keys'))) out.push({ e, k });
    }
    return out;
  };
  return loadExpanded(ctx, 'EntityKeyMetadata', 'Keys', ctx.keys.get('entitylogicalname') || null, ctx.props(['MetadataId']), null, toRecs);
}

// globaloptionset columns of the OptionSetMetadata / BooleanOptionSetMetadata subtypes, which a $select on the
// OptionSetMetadataBase collection cannot name: they need the full GlobalOptionSetDefinitions read.
const SUBTYPE_SET_COLS = new Set(['trueoption', 'falseoption', 'parentoptionsetname']);

// meta.globalOptionSets() when meta has it (the cache path).
const metaSets = ctx => (ctx.meta && typeof ctx.meta.globalOptionSets === 'function' ? ctx.meta : null);

async function* loadGlobalOptionSets(ctx) {
  if (metaSets(ctx) && ctx.need.every(c => ctx.spec.cache.has(c))) {
    ctx.used.add('meta.globalOptionSets()');
    yield { cache: true, recs: arr(await ctx.meta.globalOptionSets()) };
    return;
  }
  ctx.used.add('GlobalOptionSetDefinitions');
  if (ctx.need.some(c => SUBTYPE_SET_COLS.has(c))) {
    yield { cache: false, recs: values(await getJson(ctx, `GlobalOptionSetDefinitions?LabelLanguages=${ctx.lang}`)) };
    return;
  }
  const props = ctx.props(['MetadataId']);
  const j = await withProps(ctx, 'OptionSetMetadataBase', props,
    sel => getJson(ctx, `GlobalOptionSetDefinitions?$select=${sel.join(',')}&LabelLanguages=${ctx.lang}`));
  yield { cache: false, recs: values(j) };
}

async function* loadGlobalOptionValues(ctx) {
  if (metaSets(ctx) && ctx.need.every(c => ctx.spec.cache.has(c))) {
    ctx.used.add('meta.globalOptionSets()');
    const recs = [];
    for (const s of arr(await ctx.meta.globalOptionSets())) for (const o of arr(s.options)) recs.push({ s, o });
    yield { cache: true, recs };
    return;
  }
  ctx.used.add('GlobalOptionSetDefinitions');
  const recs = [];
  for (const s of values(await getJson(ctx, `GlobalOptionSetDefinitions?LabelLanguages=${ctx.lang}`))) {
    for (const o of optionsOf(s)) if (o && typeof o === 'object') recs.push({ s, o });
  }
  yield { cache: false, recs };
}

let messageRows = null;

// sys.messages: one row per MESSAGES entry, ascending (01 §8, 02 §7).
async function* loadMessages(ctx) {
  ctx.used.add('messages.js MESSAGES');
  if (!messageRows) {
    messageRows = freeze(Object.keys(MESSAGES).map(k => freeze([Number(k), 1033, MESSAGES[k].severity, 0, MESSAGES[k].text])));
  }
  yield { cache: false, recs: messageRows };
}

const two = n => (n < 10 ? '0' : '') + n;

// '+hh:mm' / '-hh:mm' of an offset in minutes east of UTC (SQL Server's current_utc_offset form).
function offsetText(m) {
  const a = Math.abs(m);
  return (m < 0 ? '-' : '+') + two(Math.floor(a / 60)) + ':' + two(a % 60);
}

// sys.time_zone_info at env.now.
async function* loadTimeZones(ctx) {
  ctx.used.add('types.js WIN_ZONES');
  const now = ctx.env.now instanceof Date && !Number.isNaN(ctx.env.now.getTime()) ? ctx.env.now.getTime() : Date.now();
  const y = new Date(now).getUTCFullYear();
  const jan = Date.UTC(y, 0, 15), jul = Date.UTC(y, 6, 15);
  const recs = [];
  for (const { name } of winZones().values()) {
    const z = zoneTz(name);
    if (!z) {
      recs.push([name, null, null]);
      continue;
    }
    const off = z.offset(now);
    recs.push([name, offsetText(off), off > Math.min(z.offset(jan), z.offset(jul)) ? 1 : 0]);
  }
  yield { cache: false, recs };
}

// ============================================================================================ MetaScan

const isCompiled = c => !!c && typeof c === 'object' && typeof c.fn === 'function';
const EMPTY_ROW = freeze([]);
const ONE_ROW = freeze([EMPTY_ROW]);

// The value text of a pushed item for explain(): a string as the folded key that is sent, a Compiled as its text.
function itemText(v) {
  if (isCompiled(v)) return String(v.text ?? '(expression)');
  v = variantValue(v);
  if (v === null || v === undefined) return 'NULL';
  return typeof v === 'string' ? odataStr(collKeyAI(v)) : String(v);
}

// The pushed list in its one shape: [{column, values: item[]}]; TypeError for anything else.
function normalisePushed(d, pushed) {
  if (pushed === undefined || pushed === null) return [];
  let entries;
  if (Array.isArray(pushed)) entries = pushed;
  else if (pushed instanceof Map) entries = [...pushed].map(([column, v]) => ({ column, values: Array.isArray(v) ? v : [v] }));
  else if (typeof pushed === 'object') {
    entries = Object.keys(pushed).map(column => ({ column, values: Array.isArray(pushed[column]) ? pushed[column] : [pushed[column]] }));
  }
  else throw new TypeError('MetaScan: pushed must be an array, a Map or an object');
  return freeze(entries.map(e => {
    if (!e || typeof e !== 'object') throw new TypeError('MetaScan: every pushed entry must be an object');
    const column = lower(e.column ?? e.attr ?? '');
    if (!pushableIn(d, column)) throw new TypeError(`MetaScan: ${d.full} cannot push conditions on '${column}'`);
    const op = e.op === undefined ? (e.values !== undefined ? 'in' : 'eq') : e.op === '=' ? 'eq' : lower(e.op);
    if (op !== 'eq' && op !== 'in') throw new TypeError(`MetaScan: pushed operator '${String(e.op)}' (only eq and in)`);
    let items;
    if (op === 'in') {
      if (!Array.isArray(e.values)) throw new TypeError('MetaScan: an in condition needs a values array');
      items = e.values.slice();
    } else items = [e.value === undefined ? (Array.isArray(e.values) && e.values.length === 1 ? e.values[0] : undefined) : e.value];
    if (items.some(v => v === undefined)) throw new TypeError('MetaScan: a pushed value is missing');
    return freeze({ column, values: freeze(items) });
  }));
}

// Marks of a pushed value that makes its entry unconstraining, or that can never be equal.
const NONE = Symbol('no constraint');
const DROP = Symbol('never equal');
const NAME_KEY_RE = /^[a-z0-9_]{1,128}$/;
const WORD_RE = /^[a-z][a-z0-9]*$/;
const BIG_MIN = BigInt(INT_MIN), BIG_MAX = BigInt(INT_MAX);

// The key of a pushed (non-NULL, unwrapped) value by its column's kind, or NONE or DROP.
const KEYS = {
  name(v) {
    if (typeof v !== 'string') return NONE;
    const k = collKeyAI(v);
    return NAME_KEY_RE.test(k) ? k : DROP;
  },
  enum(v) {
    if (typeof v !== 'string') return NONE;
    const k = collKeyAI(v);
    return ATTRIBUTE_TYPES.has(k) ? k : WORD_RE.test(k) ? NONE : DROP;
  },
  bit(v) {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return v === 1 ? 1 : v === 0 ? 0 : DROP;
    if (typeof v === 'bigint') return v === 1n ? 1 : v === 0n ? 0 : DROP;
    return NONE;
  },
  int(v) {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return Number.isInteger(v) && v >= INT_MIN && v <= INT_MAX ? v : DROP;
    if (typeof v === 'bigint') return v >= BIG_MIN && v <= BIG_MAX ? Number(v) : DROP;
    return NONE;
  },
};

// The keys of one pushed entry's values for this run, or null when it constrains nothing.
async function entryKeys(items, env, kind) {
  const keyOfValue = KEYS[kind];
  const set = new Set();
  for (let v of items) {
    if (isCompiled(v)) {
      if (v.pre) await v.pre(ONE_ROW, env);
      v = v.fn(EMPTY_ROW, env);
    }
    v = variantValue(v);
    if (v === null || v === undefined) continue;
    const k = keyOfValue(v);
    if (k === NONE) return null;
    if (k !== DROP) set.add(k);
  }
  return set;
}

// Adds a key set to the map, intersecting with the column's set when it has one.
function intersectInto(keys, column, set) {
  const cur = keys.get(column);
  if (!cur) {
    keys.set(column, set);
    return;
  }
  const both = new Set();
  for (const k of set) if (cur.has(k)) both.add(k);
  keys.set(column, both);
}

// Rows of a metadata.* table or a sys.* view (02 §6-§7).
export class MetaScan extends PlanNode {
  constructor(o = {}) {
    const d = o.table && typeof o.table === 'object' && typeof o.table.full === 'string' ? tableOf(o.table.full) : tableOf(o.table);
    if (!d) throw new TypeError(`MetaScan({table, schema, pushed}): unknown table '${String(o.table)}'`);
    const schema = o.schema === undefined || o.schema === null ? metaColumns(d.full) : o.schema;
    if (!Array.isArray(schema)) throw new TypeError('MetaScan: schema must be an array of Columns');
    for (const c of schema) {
      if (!c || typeof c.name !== 'string' || !d.columns.some(x => x.name === lower(c.name))) {
        throw new TypeError(`MetaScan: ${d.full} has no column '${c && c.name}'`);
      }
    }
    super({ op: 'MetaScan', kids: [], schema, server: d.schema === 'metadata', detail: o.detail, props: o.props, warnings: o.warnings, est: o.est });
    this.table = d.full;
    this.def = d;
    this.pushed = normalisePushed(d, o.pushed);
    this.meta = o.meta || null;
    this.api = o.api || null;
    this.used = new Set();
    this.plans = this.pushed.flatMap(p => p.values.filter(isCompiled).flatMap(c => (Array.isArray(c.plans) ? c.plans : [])));
  }

  detail() {
    if (!this.pushed.length) return this.table;
    return `${this.table} (${this.pushedText()})`;
  }

  pushedText() {
    const one = p => (p.values.length === 1 ? `${p.column} = ${itemText(p.values[0])}` : `${p.column} in (${p.values.map(itemText).join(', ')})`);
    return this.pushed.map(one).join(' and ');
  }

  props() {
    const out = [{ name: 'Table', value: this.table }, { name: 'Columns', value: this.schema.map(c => lower(c.name)).join(', ') }];
    if (this.pushed.length) out.push({ name: 'Pushed', value: this.pushedText() });
    out.push({ name: 'Source', value: tableSpecs().get(this.table).source });
    if (this.used.size) out.push({ name: 'Read from', value: [...this.used].join(', ') });
    return out;
  }

  async *execute(env) {
    const args = env.scanArgs ? env.scanArgs.get(this) : undefined;
    if (args && args.rows) {
      for (let i = 0; i < args.rows.length; i += BATCH) yield args.rows.slice(i, i + BATCH);
      return;
    }
    const spec = tableSpecs().get(this.table);
    const keys = new Map();
    for (const p of this.pushed) {
      const set = await entryKeys(p.values, env, kindOf(this.def.name, p.column));
      if (set) intersectInto(keys, p.column, set);
    }
    const extra = [];
    for (const c of (args && args.conds) || []) await this.scanCond(c, env, keys, extra);
    for (const set of keys.values()) if (!set.size) return;

    const meta = this.meta || env.meta || null;
    const api = this.api || env.api || null;
    const lang = meta && Number.isInteger(meta.lang) ? meta.lang : 1033;
    const dop = api && typeof api.dop === 'number' && api.dop >= 1 ? Math.min(32, Math.floor(api.dop)) : 4;
    const need = [...new Set([...this.schema.map(c => lower(c.name)), ...keys.keys(), ...extra.map(x => x.column)])];
    const ctx = {
      node: this, env, api, meta, lang, dop, spec, keys, need, table: this.table, used: this.used, dropped: new Map(),
      held: new Set(), onSend: null, closed: false,
      props: always => {
        const out = new Set(always);
        for (const c of need) for (const p of spec.cols.get(c).props) out.add(p);
        return [...out];
      },
    };
    const colDt = new Map(this.def.columns.map(c => [c.name, c.dt]));
    const readersOf = cache => {
      const m = cache ? spec.cache : spec.cols;
      const read = c => {
        const r = m.get(c);
        if (spec.values) return r.get;
        const conv = CONV[colDt.get(c)];
        return rec => conv(r.get(rec), lang);
      };
      const out = this.schema.map(c => read(lower(c.name)));
      const filters = [];
      for (const [c, set] of keys) {
        const get = read(c);
        const kind = kindOf(this.def.name, c);
        if (kind === 'bit' || kind === 'int') {
          filters.push(rec => {
            const v = get(rec);
            return v !== null && set.has(v);
          });
        } else {
          filters.push(rec => {
            const v = get(rec);
            return v !== null && set.has(collKeyAI(String(v)));
          });
        }
      }
      for (const x of extra) {
        const get = read(x.column);
        filters.push(rec => x.test(get(rec)));
      }
      return { out, filters };
    };
    let raw = null, cached = null;
    const seen = spec.dedupe ? new Set() : null;
    const n = this.schema.length;
    const signal = env.signal;
    let tick = 0;
    try {
      for await (const part of spec.load(ctx)) {
        const rd = part.cache ? (cached ||= readersOf(true)) : (raw ||= readersOf(false));
        let batch = [];
        for (const rec of part.recs) {
          // a long run of filtered-out records still notices a cancel (every 10,000 records, 02 §6)
          if (++tick === TICK) {
            tick = 0;
            if (signal) signal.throwIfAborted();
          }
          let ok = true;
          for (let i = 0; i < rd.filters.length && ok; i++) ok = rd.filters[i](rec);
          if (!ok) continue;
          if (seen) {
            const id = typeof rec.MetadataId === 'string' ? lower(rec.MetadataId) : null;
            if (id) {
              if (seen.has(id)) continue;
              seen.add(id);
            }
          }
          const row = new Array(n);
          for (let i = 0; i < n; i++) row[i] = rd.out[i](rec);
          batch.push(row);
          if (batch.length >= BATCH) {
            yield batch;
            batch = [];
          }
        }
        if (batch.length) yield batch;
      }
    } finally {
      release(ctx);
      for (const { type, prop } of ctx.dropped.values()) {
        emitOnce(env, 'warn', `${this.table}: Dataverse has no ${type} property '${prop}', so the columns that read it are NULL.`);
      }
    }
  }

  // One env.scanArgs condition: narrows the keys (eq/in on a pushable column) or adds a filter.
  async scanCond(c, env, keys, extra) {
    const column = lower((c && (c.attr ?? c.column)) || '');
    const dt = (this.def.columns.find(x => x.name === column) || {}).dt;
    if (!dt) throw new TypeError(`MetaScan: ${this.table} has no column '${column}' (env.scanArgs)`);
    const op = lower((c && c.op) || '');
    if (op === 'null' || op === 'not-null') {
      extra.push({ column, test: v => (op === 'null' ? v === null : v !== null) });
      return;
    }
    if (op !== 'eq' && op !== 'in') throw new TypeError(`MetaScan: env.scanArgs operator '${op}' (eq, in, null, not-null)`);
    const items = op === 'in' ? arr(c.values) : [c.value];
    const set = pushableIn(this.def, column) ? await entryKeys(items, env, kindOf(this.def.name, column)) : null;
    if (set) {
      intersectInto(keys, column, set);
      return;
    }
    const type = { dt };
    const want = new Set();
    for (const v of items) if (v !== null && v !== undefined) want.add(keyOf(variantValue(v), type, true));
    extra.push({ column, test: v => v !== null && want.has(keyOf(v, type, true)) });
  }
}
