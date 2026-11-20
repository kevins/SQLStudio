// Dataverse metadata cache (02 §2; 00 §5 rule 5 for the stored cache). Tables,
// columns, relationships, option sets, keys, Web API messages (BUILTIN_MESSAGES, custom APIs and the $metadata
// service document), the CreateMultiple table list, recycle-bin tables, the currency count, the System Administrator
// check, the user's settings and the time-zone check. Sync members never send requests; compile, planner and dml
// use only them after planQuery's prefetch. Requests go through api.js only. DOM-free.
//
// Notes:
// - messages() reads the custom APIs and, when the api has csdl() (api.js always has; other api implementations may not),
//   the $metadata service document in parallel. The stream scan cuts out every Function, Action, ComplexType and
//   EntityType element whole, as it arrives (any chunk boundaries); every other element is skipped tag by tag.
//   Comments, CDATA sections and processing instructions are skipped whole, inside a kept element too (a
//   '</Function>' in them ends nothing, XML 1.0 §2.5-2.7), and a skipped one is never held in memory; a DOCTYPE is
//   refused; a document that does not open and close edmx:Edmx, or ends inside markup, is not a service document
//   (DataverseError code 'notjson'). Each Function and Action element goes to parseXml when it is cut (a malformed
//   one fails the scan with parseXml's error). Of a ComplexType or EntityType only the start tag is parsed (Name,
//   BaseType); its other tags are walked unparsed and only its Property start tags are kept, so the scan never holds
//   the navigation properties, keys and annotations that make up most of the document (02 §1 csdl()). When the
//   document has ended, only the types a ReturnType references are parsed (with their BaseType chain, base
//   properties first); a referenced type whose tags do not nest is parsed whole, which fails the scan. Every string
//   the result keeps is copied out of the stream text, so the Map never keeps the document text alive. A failed scan
//   counts as a messages() failure (below).
// - $metadata entries: boundTo is the table of the first Parameter's type (lower case), and binding 'collection'
//   for Collection(...), else 'entity'; that first Parameter is not a request parameter. `response`: besides the
//   02 §2 ComplexType or EntityType properties (inherited ones first), [{name: 'value', type}] for a primitive, enum
//   or Collection(...) return (the Web API answers `{"value": …}`), [] without a ReturnType. Names that are not
//   identifiers are skipped (a message whose own name, or a parameter's or response property's name, is not one is
//   left out). Every overload of a name is kept (one bound function per type, e.g. RetrievePrincipalAccess bound to
//   systemuser and to team); of two with one name and one binding the first wins.
// - `responseEntity` (02 §2 says an entity type's properties become `response`, which gives the 02 §9
//   (a) shape no table to map the answer by): every entry has it. When the ReturnType is an EntityType the Web API
//   answers with that entity itself, so responseEntity names its table (lower case), 'Entity' for
//   mscrm.crmbaseentity (InitializeFrom, RetrieveUnpublished: any table, known from the answer's @odata.type) or
//   'expando' for the open type, and `response` keeps the 02 §2 properties (none for those two); ApiFnScan and EXEC
//   then apply shape (a), or (c) for expando, to the whole answer. It is null for every other return, and comes from
//   $metadata only.
// - Types use one vocabulary in every entry, the BUILTIN_MESSAGES and custom API one: Edm.Boolean Boolean,
//   Edm.String String, Edm.Guid Guid, Edm.Int16/Int32/Byte/SByte Integer, Edm.Int64 BigInt, Edm.Decimal Decimal,
//   Edm.Double/Single Float, Edm.DateTimeOffset DateTime, Edm.Date Date, Edm.TimeOfDay Time, Edm.Duration Duration,
//   Edm.Binary Binary; mscrm.crmbaseentity is EntityReference for a parameter and Entity in a response; any other
//   mscrm.X (or Microsoft.Dynamics.CRM.X) is X (a table, complex type or enum name); Collection(Edm.String) is
//   StringArray, Collection(mscrm.crmbaseentity) EntityCollection, any other Collection(T) T + '[]'. A custom API
//   parameter or response property of type Entity or EntityReference with a logicalentityname is that table, an
//   EntityCollection with one '<table>[]' (as $metadata types them: mscrm.<table>, Collection(mscrm.<table>)); without
//   one it keeps its type name. On a name clash "$metadata wins for parameter and response types" keeps the other
//   source's name when both are of one family (EntityReference/Entity, Money/Decimal, Picklist/Integer), so a custom
//   API's EntityReference or Money survives.
// - The merged entry of a name: kind, boundTo and binding come from BUILTIN_MESSAGES when it lists the
//   name (verified, 04 §5), else from $metadata, else from the custom API; the $metadata overload used is the one
//   bound like the BUILTIN_MESSAGES (else custom API) entry, else the first. The parameter list (names, order,
//   optional) comes from $metadata, else the custom API, else BUILTIN_MESSAGES. The response of a BUILTIN_MESSAGES
//   name keeps its names and position order (WhoAmI: UserId, BusinessUnitId, OrganizationId, whatever order
//   $metadata declares), with each type from $metadata (and $metadata's spelling of the name), followed by the
//   properties only $metadata declares, in its order; any other response comes from $metadata, else the custom
//   API. The name is $metadata's spelling, else the custom API's, else BUILTIN_MESSAGES'; the description and each
//   parameter's description come from the custom API, else BUILTIN_MESSAGES (null for a $metadata-only message);
//   isCustom is true when a custom API row has the name. The Map lists BUILTIN_MESSAGES first, then the
//   $metadata-only, then the custom-only names.
// - The custom API rows are read in a fixed order, because positional EXEC arguments and response columns follow it
//   whenever $metadata is not read: customapi by uniquename, request parameters and response properties by
//   createdon, then uniquename. $metadata's order wins when it is read.
// - messages({csdl: false}) never reads $metadata (02 §2 reads it only on first use of EXEC, a TVF call or EXEC
//   completion, so Help, hover and signature help use this form): it resolves to the full Map when that is loaded
//   or stored, else to BUILTIN_MESSAGES plus the custom APIs, whose read it shares with messages().
// - An incomplete Map: when a source failed (the $metadata read or scan, or a custom API read that is not a privilege
//   error), the Map messages() resolves carries a non-enumerable, read-only `incomplete` = frozen {source:
//   'messages', error} (error: the $metadata failure, else the custom APIs'), because a name it lacks may still be a
//   Web API message (one only $metadata lists, or a private custom API, which $metadata leaves out). session.js then
//   raises the failure (e.g. `Web API messages could not be loaded (<message>)`) instead of 2812 for a name it cannot
//   find. A complete Map has no such property. messagesSync() (sync, no request) is the Map the full form of
//   messages() resolved last, complete or marked incomplete (or the stored full Map), and null before that and after
//   refresh(), so the planner and the session bind through it after their `await meta.messages()` prefetch.
// - The store value is `{v: 4, at, rows, csdl, customUnreadable?}` (rows: custom API rows [name, kind, boundTo,
//   description, params, response, binding]; csdl: [name, kind, boundTo, binding, [[param, type, optional]],
//   [[property, type]], responseEntity] or null when the api has no csdl()). It is written when no source failed and
//   there is something to keep, and the value is ≤ 400 KB. A privilege error on the custom API tables is no failure:
//   it is stored as rows [] with customUnreadable true (02 §2: BUILTIN_MESSAGES, cached 24 h), so $metadata is not
//   read again on every launch. Any other version, an invalid row or flag, or csdl null while the api can read
//   $metadata, is read again. The custom API rows are kept 24 h in memory (a failure 30 s), and the full Map lives
//   24 h from their read. A failure of either source resolves to what the other sources give, kept 30 s, and each
//   failure is reported once as onChange {kind: 'error', error, source: 'messages'}.
// - createMeta option `inBody: () => boolean` (main.js passes `() => settings.queryInBody`, 00 §5 rule 6; default
//   `() => false`): every FetchXML read of meta (createMultipleTables, recycleBin, currencyCount,
//   isSystemAdministrator) passes `{inBody: inBody() === true}` to api.fetchXml, so the setting keeps those values
//   out of URLs too.
// - isSystemAdministrator(userId): a userId that is not a GUID rejects with TypeError. The two queries are on
//   role (roletemplateid eq the System Administrator template), linked to systemuserroles (systemuserid eq the user)
//   and to teamroles -> team -> teammembership (systemuserid eq the user). One query answering a row is enough; a
//   privilege error on a query counts as no row; any other failure rejects (when no query found a row), is kept 30 s
//   and is read again by the next call.
// - The SqlError 207 and 208 also carry `number` and `severity` (MESSAGES, 01 §2.1).

import { SqlError } from '../engine/lexer.js';
import { MESSAGES } from '../engine/messages.js';
import { suggest as didYouMean } from '../core/util.js';
import { parseXml, xmlEsc } from '../core/xml.js';
import { DataverseError, isGuid, isSegment, odataString, tableKind } from './api.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NS = 'Microsoft.Dynamics.CRM.';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const FAIL_MS = 30000;
const MESSAGES_VERSION = 4;
const CACHE_MAX = 400 * 1024;
const PAGE_LIMIT = 200;
const lower = s => String(s).toLowerCase();
const freeze = Object.freeze;

const ENTITY_SELECT = 'LogicalName,SchemaName,DisplayName,DisplayCollectionName,Description,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,' +
  'PrimaryImageAttribute,ObjectTypeCode,IsCustomEntity,IsActivity,IsIntersect,IsManaged,OwnershipType,LogicalCollectionName,IsValidForAdvancedFind,' +
  'TableType,IsPrivate,IsLogicalEntity,DataProviderId,HasActivities,IsRetentionEnabled,IsArchivalEnabled,IsOptimisticConcurrencyEnabled,MetadataId';
const ATTR_SELECT = 'LogicalName,SchemaName,AttributeType,AttributeTypeName,DisplayName,Description,IsValidForRead,IsValidForCreate,IsValidForUpdate,' +
  'IsValidForAdvancedFind,AttributeOf,IsPrimaryId,IsPrimaryName,IsCustomAttribute,IsLogical,SourceType,RequiredLevel,ColumnNumber,IsSecured,IsManaged,MetadataId';
const CASTS = [
  ['LookupAttributeMetadata', 'LogicalName,Targets'],
  ['DateTimeAttributeMetadata', 'LogicalName,Format,DateTimeBehavior'],
  ['StringAttributeMetadata', 'LogicalName,MaxLength,DatabaseLength,Format,YomiOf'],
  ['DecimalAttributeMetadata', 'LogicalName,Precision,MinValue,MaxValue'],
  ['MoneyAttributeMetadata', 'LogicalName,Precision'],
  ['IntegerAttributeMetadata', 'LogicalName,MinValue,MaxValue,Format'],
  ['MemoAttributeMetadata', 'LogicalName,MaxLength'],
];
const N1_SELECT = 'SchemaName,ReferencingAttribute,ReferencedEntity,ReferencedAttribute,ReferencingEntityNavigationPropertyName,IsHierarchical';
const ONEN_SELECT = 'SchemaName,ReferencingEntity,ReferencingAttribute,ReferencedAttribute,ReferencedEntityNavigationPropertyName,CascadeConfiguration';
const NN_SELECT = 'SchemaName,IntersectEntityName,Entity1LogicalName,Entity1IntersectAttribute,Entity1NavigationPropertyName,' +
  'Entity2LogicalName,Entity2IntersectAttribute,Entity2NavigationPropertyName';
const USER_SELECT = 'systemuserid,uilanguageid,timezonebias,timezonestandardbias,timezonedaylightbias,timezonedaylightmonth,timezonecode,' +
  'dateformatstring,timeformatstring,decimalsymbol,numberseparator';
const ORG_SELECT = 'organizationid,name,localeid,languagecode,fiscalcalendarstart,fiscalperiodtype,fiscalyeardisplaycode';
const OWNERSHIP = new Map([[0, 'None'], [1, 'UserOwned'], [2, 'TeamOwned'], [4, 'BusinessOwned'], [8, 'OrganizationOwned'], [16, 'BusinessParented'], [32, 'Filtered']]);
const VIRTUAL_TYPES = new Map([['MultiSelectPicklistType', 'MultiSelectPicklist'], ['ImageType', 'Image'], ['FileType', 'File']]);
const OPTION_CASTS = new Map([
  ['Picklist', ['PicklistAttributeMetadata', 'OptionSet($select=Options),GlobalOptionSet($select=Options)']],
  ['MultiSelectPicklist', ['MultiSelectPicklistAttributeMetadata', 'OptionSet($select=Options),GlobalOptionSet($select=Options)']],
  ['State', ['StateAttributeMetadata', 'OptionSet($select=Options)']],
  ['Status', ['StatusAttributeMetadata', 'OptionSet($select=Options)']],
  ['Boolean', ['BooleanAttributeMetadata', 'OptionSet($select=TrueOption,FalseOption)']],
]);
const CUSTOM_API_TYPES = ['Boolean', 'DateTime', 'Decimal', 'Entity', 'EntityCollection', 'EntityReference', 'Float', 'Integer', 'Money', 'Picklist', 'String', 'StringArray', 'Guid'];
const PRIVILEGE_CODES = new Set(['0x80040220', '0x80040225']);
// Well-known entity sets of system tables, used until the entity list is loaded.
const SYSTEM_SETS = new Map([['usersettings', 'usersettingscollection'], ['organization', 'organizations'], ['transactioncurrency', 'transactioncurrencies'],
  ['sdkmessagefilter', 'sdkmessagefilters'], ['recyclebinconfig', 'recyclebinconfigs'], ['customapi', 'customapis'],
  ['customapirequestparameter', 'customapirequestparameters'], ['customapiresponseproperty', 'customapiresponseproperties'], ['role', 'roles']]);
const ORG_TYPES = ['Customer', 'Monitoring', 'Support', 'BackEnd', 'Secondary', 'CustomerTest', 'CustomerFreeTest', 'CustomerPreview', 'Placeholder',
  'TestDrive', 'MsftInvestigation', 'EmailTrial', 'Default', 'Developer', 'Trial', 'Teams', 'Platform'];
const NON_PRODUCTION = new Set(['Developer', 'Trial', 'TestDrive', 'CustomerTest', 'CustomerFreeTest', 'Sandbox']);
// The roletemplateid of the System Administrator role, the same in every business unit (02 §2 isSystemAdministrator).
const SYSADMIN_TEMPLATE = '627090ff-40a3-4053-8790-584edc5be201';

// Web API messages that completion, signature help, hover, Help and templates know without a request (02 §2), and
// the messages dml.js writes with; response properties in position order.
// [name, kind, boundTo, description, [[parameter, type, optional, description]], [[response property, type]]]
export const BUILTIN_MESSAGES = [
  ['WhoAmI', 'function', null, 'Returns the ids of the calling user, their business unit and the organization.', [],
    [['UserId', 'Guid'], ['BusinessUnitId', 'Guid'], ['OrganizationId', 'Guid']]],
  ['RetrieveVersion', 'function', null, 'Returns the version of the Dataverse server.', [], [['Version', 'String']]],
  ['RetrieveTotalRecordCount', 'function', null, 'Returns the number of records in each table, from a snapshot that can be up to 24 hours old.',
    [['EntityNames', 'StringArray', false, "Logical names of the tables to count, e.g. 'account'."]], [['EntityRecordCountCollection', 'EntityRecordCountCollection']]],
  ['RetrieveCurrentOrganization', 'function', null, 'Returns the current environment: name, type, version, URLs and ids.',
    [['AccessType', 'EndpointAccessType', false, 'Which endpoints to return: Default, Internet or Intranet.']], [['Detail', 'OrganizationDetail']]],
  ['RetrieveOrganizationInfo', 'function', null, 'Returns the organization id, its type and its installed solutions.', [], [['organizationInfo', 'OrganizationInfo']]],
  ['RetrieveUserPrivileges', 'function', 'systemuser', 'Returns the privileges a user has through their security roles, with depth and business unit.', [],
    [['RolePrivileges', 'RolePrivilege[]']]],
  ['RetrieveTeamPrivileges', 'function', 'team', 'Returns the privileges a team has through its security roles.', [], [['RolePrivileges', 'RolePrivilege[]']]],
  ['RetrievePrincipalAccess', 'function', 'systemuser', 'Returns the access rights a user has to a record.',
    [['Target', 'EntityReference', false, "The record to check, e.g. CREATELOOKUP('account', id)."]], [['AccessRights', 'AccessRights']]],
  ['RetrieveRecordChangeHistory', 'function', null, 'Returns the audit history of a record.',
    [['Target', 'EntityReference', false, 'The record whose audit history is returned.'], ['PagingInfo', 'PagingInfo', true, 'Which page of audit details to return (PageNumber, Count).']],
    [['AuditDetailCollection', 'AuditDetailCollection']]],
  ['RetrieveAuditDetails', 'function', 'audit', 'Returns the details of one audit record: the old and new values.', [], [['AuditDetail', 'AuditDetail']]],
  ['RetrieveDependentComponents', 'function', null, 'Returns the solution components that depend on a component.',
    [['ObjectId', 'Guid', false, 'Id of the component.'], ['ComponentType', 'Integer', false, 'Solution component type of the component, e.g. 1 = table, 2 = column.']],
    [['EntityCollection', 'dependency[]']]],
  ['RetrieveRequiredComponents', 'function', null, 'Returns the solution components that a component requires.',
    [['ObjectId', 'Guid', false, 'Id of the component.'], ['ComponentType', 'Integer', false, 'Solution component type of the component, e.g. 1 = table, 2 = column.']],
    [['EntityCollection', 'dependency[]']]],
  ['RetrieveDependenciesForDelete', 'function', null, 'Returns the dependencies that prevent deleting a component.',
    [['ObjectId', 'Guid', false, 'Id of the component.'], ['ComponentType', 'Integer', false, 'Solution component type of the component, e.g. 1 = table, 2 = column.']],
    [['EntityCollection', 'dependency[]']]],
  ['RetrieveAvailableLanguages', 'function', null, 'Returns the language ids (LCIDs) that can be enabled in the environment.', [], [['LocaleIds', 'Integer[]']]],
  ['RetrieveProvisionedLanguages', 'function', null, 'Returns the language ids (LCIDs) enabled in the environment.', [], [['RetrieveProvisionedLanguages', 'Integer[]']]],
  ['RetrieveTimeStamp', 'function', null, 'Returns the current metadata time stamp of the environment.', [], [['TimeStamp', 'String']]],
  ['RetrieveExchangeRate', 'function', null, 'Returns the exchange rate of a currency against the base currency.',
    [['TransactionCurrencyId', 'Guid', false, 'Id of the currency (transactioncurrencyid).']], [['ExchangeRate', 'Decimal']]],
  ['IsValidStateTransition', 'function', null, 'Tells whether a record can move to a state and status reason.',
    [['Entity', 'EntityReference', false, 'The record to check.'], ['NewState', 'String', false, 'The target state as text, e.g. Resolved.'],
      ['NewStatus', 'Integer', false, 'The target status reason value (statuscode).']], [['IsValid', 'Boolean']]],
  ['LocalTimeFromUtcTime', 'function', null, 'Converts a UTC date and time to the local time of a Dataverse time zone.',
    [['TimeZoneCode', 'Integer', false, 'Dataverse time zone code (timezonedefinition.timezonecode).'], ['UtcTime', 'DateTime', false, 'The UTC date and time to convert.']],
    [['LocalTime', 'DateTime']]],
  ['UtcTimeFromLocalTime', 'function', null, 'Converts a local date and time of a Dataverse time zone to UTC.',
    [['TimeZoneCode', 'Integer', false, 'Dataverse time zone code (timezonedefinition.timezonecode).'], ['LocalTime', 'DateTime', false, 'The local date and time to convert.']],
    [['UtcTime', 'DateTime']]],
  ['WinOpportunity', 'action', null, 'Closes an opportunity as won.',
    [['OpportunityClose', 'opportunityclose', false, 'The opportunity close activity: the opportunity (opportunityid) and the details of the win.'],
      ['Status', 'Integer', false, 'Status reason of the won opportunity (statuscode), e.g. 3 = Won.']], []],
  ['LoseOpportunity', 'action', null, 'Closes an opportunity as lost.',
    [['OpportunityClose', 'opportunityclose', false, 'The opportunity close activity: the opportunity (opportunityid) and the details of the loss.'],
      ['Status', 'Integer', false, 'Status reason of the lost opportunity (statuscode), e.g. 4 = Canceled.']], []],
  ['CloseIncident', 'action', null, 'Resolves a case.',
    [['IncidentResolution', 'incidentresolution', false, 'The case resolution activity: the case (incidentid) and its subject.'],
      ['Status', 'Integer', false, 'Status reason of the resolved case (statuscode), e.g. 5 = Problem Solved.']], []],
  ['WinQuote', 'action', null, 'Closes a quote as won.',
    [['QuoteClose', 'quoteclose', false, 'The quote close activity: the quote (quoteid) and the details of the win.'],
      ['Status', 'Integer', false, 'Status reason of the won quote (statuscode), e.g. 4 = Won.']], []],
  ['CloseQuote', 'action', null, 'Closes a quote as lost, canceled or revised.',
    [['QuoteClose', 'quoteclose', false, 'The quote close activity: the quote (quoteid) and the reason for closing it.'],
      ['Status', 'Integer', false, 'Status reason of the closed quote (statuscode), e.g. 5 = Lost.']], []],
  ['FulfillSalesOrder', 'action', null, 'Marks an order as fulfilled.',
    [['OrderClose', 'orderclose', false, 'The order close activity: the order (salesorderid) and its subject.'],
      ['Status', 'Integer', false, 'Status reason of the fulfilled order (statuscode), e.g. 100001 = Complete.']], []],
  ['CancelSalesOrder', 'action', null, 'Cancels an order.',
    [['OrderClose', 'orderclose', false, 'The order close activity: the order (salesorderid) and its subject.'],
      ['Status', 'Integer', false, 'Status reason of the canceled order (statuscode), e.g. 4 = No Money.']], []],
  ['SetParentBusinessUnit', 'action', 'businessunit', 'Moves a business unit under another parent business unit.',
    [['ParentId', 'Guid', false, 'Id of the new parent business unit.']], []],
  ['AddMemberList', 'action', 'list', 'Adds an account, contact or lead to a static marketing list.',
    [['EntityId', 'Guid', false, 'Id of the record to add to the list.']], [['id', 'Guid']]],
  ['RemoveMemberList', 'action', 'list', 'Removes a member from a static marketing list.',
    [['EntityId', 'Guid', false, 'Id of the record to remove from the list.']], []],
  ['ExecuteWorkflow', 'action', 'workflow', 'Runs an on-demand workflow on a record.', [['EntityId', 'Guid', false, 'Id of the record the workflow runs on.']], [['Id', 'Guid']]],
  ['AddMembersTeam', 'action', 'team', 'Adds users to a team.', [['Members', 'systemuser[]', false, 'The users to add.']], []],
  ['RemoveMembersTeam', 'action', 'team', 'Removes users from a team.', [['Members', 'systemuser[]', false, 'The users to remove.']], []],
  ['GrantAccess', 'action', null, 'Shares a record with a user or team.',
    [['Target', 'EntityReference', false, 'The record to share.'], ['PrincipalAccess', 'PrincipalAccess', false, 'The user or team (Principal) and the rights to grant (AccessMask).']], []],
  ['ModifyAccess', 'action', null, 'Changes the access rights a user or team has to a shared record.',
    [['Target', 'EntityReference', false, 'The shared record.'], ['PrincipalAccess', 'PrincipalAccess', false, 'The user or team (Principal) and its new rights (AccessMask).']], []],
  ['RevokeAccess', 'action', null, 'Stops sharing a record with a user or team.',
    [['Target', 'EntityReference', false, 'The shared record.'], ['Revokee', 'EntityReference', false, 'The user or team that loses access.']], []],
  ['AddSolutionComponent', 'action', null, 'Adds a component to an unmanaged solution.',
    [['ComponentId', 'Guid', false, 'Id of the component.'], ['ComponentType', 'Integer', false, 'Solution component type of the component, e.g. 1 = table, 2 = column.'],
      ['SolutionUniqueName', 'String', false, 'Unique name of the solution.'], ['AddRequiredComponents', 'Boolean', false, 'Also adds the components that this one requires.'],
      ['DoNotIncludeSubcomponents', 'Boolean', true, 'Adds a table without its columns, forms and views.'],
      ['IncludedComponentSettingsValues', 'StringArray', true, 'Settings of the subcomponents to include.']], [['id', 'Guid']]],
  ['RemoveSolutionComponent', 'action', null, 'Removes a component from an unmanaged solution.',
    [['ComponentId', 'Guid', false, 'Id of the component.'], ['ComponentType', 'Integer', false, 'Solution component type of the component, e.g. 1 = table, 2 = column.'],
      ['SolutionUniqueName', 'String', false, 'Unique name of the solution.']], [['id', 'Guid']]],
  ['Restore', 'action', null, 'Restores a deleted record from the recycle bin.',
    [['Target', 'EntityReference', false, "The deleted record, e.g. CREATELOOKUP('account', id)."]], [['id', 'Guid']]],
  ['PublishAllXml', 'action', null, 'Publishes all unpublished customizations.', [], []],
  ['SendEmail', 'action', 'email', 'Sends an email activity.',
    [['IssueSend', 'Boolean', false, 'True sends the email; false only marks it as sent.'], ['TrackingToken', 'String', true, 'Tracking token to add to the subject.']],
    [['Subject', 'String']]],
];

// The 02 §2 environment object from RetrieveCurrentOrganization's Detail (fail-safe: unknown types are Production).
export function toEnv(detail, origin = null) {
  const d = detail && typeof detail === 'object' ? detail : {};
  let type = d.OrganizationType;
  if (typeof type === 'number') type = ORG_TYPES[type] ?? null;
  if (typeof type !== 'string' || type === '') type = null;
  let url = origin;
  const ep = d.Endpoints;
  if (ep && Array.isArray(ep.Keys) && Array.isArray(ep.Values)) {
    const i = ep.Keys.indexOf('WebApplication');
    if (i >= 0 && typeof ep.Values[i] === 'string') url = ep.Values[i];
  }
  return freeze({
    name: typeof d.FriendlyName === 'string' ? d.FriendlyName : null, url: url ?? null, type, isProduction: !NON_PRODUCTION.has(type),
    envId: d.EnvironmentId ?? null, orgId: d.OrganizationId ? lower(d.OrganizationId) : null, version: d.OrganizationVersion ?? null, uniqueName: d.UniqueName ?? null,
  });
}

// ----- mapping helpers -------------------------------------------------------------------------------------

function labelOf(l, lang) {
  if (!l || typeof l !== 'object') return null;
  const u = l.UserLocalizedLabel?.Label;
  if (typeof u === 'string') return u;
  const list = Array.isArray(l.LocalizedLabels) ? l.LocalizedLabels : [];
  const m = list.find(x => x?.LanguageCode === lang) ?? list[0];
  return typeof m?.Label === 'string' ? m.Label : null;
}
const flag = v => (v && typeof v === 'object' ? v.Value === true : v === true);
const str = v => (typeof v === 'string' && v !== '' ? v : null);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const lname = v => (typeof v === 'string' && v !== '' ? lower(v) : null);
const enumText = v => (v && typeof v === 'object' ? str(v.Value) : str(v));

// [field, check] of the stored entity rows (the EntityInfo fields without kind/attrs/attrList).
const ENTITY_FIELDS = [
  ['logicalName', 'ident'], ['schemaName', 'str?'], ['displayName', 'str?'], ['displayCollectionName', 'str?'], ['description', 'str?'],
  ['entitySetName', 'seg?'], ['primaryIdAttribute', 'ident?'], ['primaryNameAttribute', 'ident?'], ['primaryImageAttribute', 'ident?'],
  ['objectTypeCode', 'int?'], ['isCustom', 'bool'], ['isActivity', 'bool'], ['isIntersect', 'bool'], ['isManaged', 'bool'], ['ownershipType', 'str?'],
  ['logicalCollectionName', 'str?'], ['validForAdvancedFind', 'bool'], ['tableType', 'str'], ['isPrivate', 'bool'], ['isLogical', 'bool'],
  ['dataProviderId', 'guid?'], ['hasActivities', 'bool'], ['isRetentionEnabled', 'bool'], ['isArchivalEnabled', 'bool'], ['optimisticConcurrency', 'bool'],
  ['metadataId', 'guid?'],
];
const CHECKS = {
  'ident': v => typeof v === 'string' && IDENT_RE.test(v), 'ident?': v => v === null || (typeof v === 'string' && IDENT_RE.test(v)),
  'seg?': v => v === null || isSegment(v), 'str?': v => v === null || typeof v === 'string',
  'str': v => typeof v === 'string' && v !== '', 'int?': v => v === null || Number.isInteger(v), 'bool': v => typeof v === 'boolean',
  'guid?': v => v === null || (isGuid(v) && v === lower(v)),
};

function entityFrom(e, lang) {
  const tableType = str(e.TableType) ?? 'Standard';
  const dataProviderId = isGuid(e.DataProviderId) ? lower(e.DataProviderId) : null;
  const ownership = typeof e.OwnershipType === 'number' ? OWNERSHIP.get(e.OwnershipType) ?? null : str(e.OwnershipType);
  return {
    logicalName: lower(e.LogicalName), schemaName: str(e.SchemaName), displayName: labelOf(e.DisplayName, lang), displayCollectionName: labelOf(e.DisplayCollectionName, lang),
    description: labelOf(e.Description, lang), entitySetName: str(e.EntitySetName), primaryIdAttribute: lname(e.PrimaryIdAttribute),
    primaryNameAttribute: lname(e.PrimaryNameAttribute), primaryImageAttribute: lname(e.PrimaryImageAttribute), objectTypeCode: Number.isInteger(e.ObjectTypeCode) ? e.ObjectTypeCode : null,
    isCustom: flag(e.IsCustomEntity), isActivity: flag(e.IsActivity), isIntersect: flag(e.IsIntersect), isManaged: flag(e.IsManaged), ownershipType: ownership,
    logicalCollectionName: str(e.LogicalCollectionName), validForAdvancedFind: flag(e.IsValidForAdvancedFind), tableType, kind: tableKind(tableType, dataProviderId),
    isPrivate: flag(e.IsPrivate), isLogical: flag(e.IsLogicalEntity), dataProviderId, hasActivities: flag(e.HasActivities), isRetentionEnabled: flag(e.IsRetentionEnabled),
    isArchivalEnabled: flag(e.IsArchivalEnabled), optimisticConcurrency: flag(e.IsOptimisticConcurrencyEnabled), metadataId: isGuid(e.MetadataId) ? lower(e.MetadataId) : null,
    attrs: null, attrList: null,
  };
}

function attrFrom(entity, a, extra, lang) {
  const typeName = enumText(a.AttributeTypeName);
  let type = enumText(a.AttributeType);
  if (type === 'Virtual' && VIRTUAL_TYPES.has(typeName)) type = VIRTUAL_TYPES.get(typeName);
  const x = extra ?? {};
  return freeze({
    entity, logicalName: lower(a.LogicalName), schemaName: str(a.SchemaName), displayName: labelOf(a.DisplayName, lang), description: labelOf(a.Description, lang),
    type, typeName, attributeOf: lname(a.AttributeOf), yomiOf: lname(x.YomiOf), isPk: flag(a.IsPrimaryId), isPrimaryName: flag(a.IsPrimaryName),
    isCustom: flag(a.IsCustomAttribute), isLogical: flag(a.IsLogical), sourceType: num(a.SourceType) ?? 0, requiredLevel: enumText(a.RequiredLevel),
    columnNumber: num(a.ColumnNumber), isSecured: flag(a.IsSecured), isManaged: flag(a.IsManaged), metadataId: isGuid(a.MetadataId) ? lower(a.MetadataId) : null,
    validForRead: flag(a.IsValidForRead), validForCreate: flag(a.IsValidForCreate), validForUpdate: flag(a.IsValidForUpdate), validForAdvancedFind: flag(a.IsValidForAdvancedFind),
    targets: Array.isArray(x.Targets) ? freeze(x.Targets.filter(t => typeof t === 'string').map(lower)) : null,
    format: enumText(x.Format), behavior: enumText(x.DateTimeBehavior), maxLength: num(x.MaxLength), databaseLength: num(x.DatabaseLength),
    precision: num(x.Precision), minValue: num(x.MinValue), maxValue: num(x.MaxValue),
  });
}

function optionFrom(o, lang) {
  const out = { value: o?.Value ?? null, label: labelOf(o?.Label, lang), color: str(o?.Color), description: labelOf(o?.Description, lang) };
  if (o && Object.hasOwn(o, 'State')) out.state = o.State ?? null;
  if (o && Object.hasOwn(o, 'DefaultStatus')) out.defaultStatus = o.DefaultStatus ?? null;
  return freeze(out);
}
function optionsFromSet(set, lang) {
  if (!set || typeof set !== 'object') return null;
  if (Array.isArray(set.Options)) return set.Options.map(o => optionFrom(o, lang));
  if (set.TrueOption || set.FalseOption) {
    const f = optionFrom({ ...(set.FalseOption ?? {}), Value: 0 }, lang);
    const t = optionFrom({ ...(set.TrueOption ?? {}), Value: 1 }, lang);
    return [f, t];
  }
  return null;
}

const isPrivilegeError = e => e instanceof DataverseError && (e.status === 403 || PRIVILEGE_CODES.has(e.code));

// A fresh copy of a shared or cached error, so a caller that adds pos/end or suggestions to it never changes what
// the next caller receives (failures are kept for 30 s and shared by concurrent callers).
function copyError(e) {
  if (!(e instanceof Error)) return e;
  let c;
  try {
    c = typeof DOMException === 'function' && e instanceof DOMException ? new DOMException(e.message, e.name) : new e.constructor(e.message);
  } catch {
    return e;
  }
  for (const k of Object.keys(e)) {
    const v = e[k];
    try { c[k] = Array.isArray(v) ? v.slice() : v; } catch { /* a read-only field keeps the constructor's value */ }
  }
  return c;
}
const rethrowCopy = e => { throw copyError(e); };

// A table Dataverse answered 404 for. The shared job keeps this marker (30 s), and entity(), relationships() and
// keys() turn it into SqlError 208 with each caller's own spelling of the name (01 §2 message style).
class TableMissing extends Error {
  constructor(logical) {
    super(`Dataverse has no table '${logical}'.`);
    this.name = 'TableMissing';
    this.logical = logical;
  }
}

// The text of a MESSAGES entry with its placeholders filled in order (01 §2.1); values are inserted verbatim.
function messageText(number, ...values) {
  let i = 0;
  return MESSAGES[number].text.replace(/<[A-Za-z][A-Za-z0-9 ]*>/g, () => String(values[i++] ?? ''));
}
// A SqlError with a MESSAGES number: its text, number and severity.
function numbered(number, text) {
  const e = new SqlError(text);
  e.number = number;
  e.severity = MESSAGES[number].severity;
  return e;
}

function quoteList(names) {
  const q = names.map(n => `'${n}'`);
  return q.length <= 1 ? q.join('') : `${q.slice(0, -1).join(', ')} or ${q[q.length - 1]}`;
}

// ----- $metadata -------------------------------------------------------------------------------------

const CSDL_LABEL = '$metadata';
// The elements the scan cuts out whole; every other element is skipped tag by tag.
const CSDL_KEEP = new Set(['Function', 'Action', 'ComplexType', 'EntityType']);
// An element still open after this many characters is not part of a Web API service document.
const CSDL_MAX_ELEMENT = 8 * 1024 * 1024;
const EDM_TYPES = new Map([['Edm.Boolean', 'Boolean'], ['Edm.String', 'String'], ['Edm.Guid', 'Guid'], ['Edm.Int16', 'Integer'], ['Edm.Int32', 'Integer'],
  ['Edm.Byte', 'Integer'], ['Edm.SByte', 'Integer'], ['Edm.Int64', 'BigInt'], ['Edm.Decimal', 'Decimal'], ['Edm.Double', 'Float'], ['Edm.Single', 'Float'],
  ['Edm.DateTimeOffset', 'DateTime'], ['Edm.Date', 'Date'], ['Edm.TimeOfDay', 'Time'], ['Edm.Duration', 'Duration'], ['Edm.Binary', 'Binary']]);
// Type names of one family: a $metadata type keeps the other source's name when both are of one family.
const TYPE_FAMILY = new Map([['EntityReference', 'Entity'], ['Money', 'Decimal'], ['Picklist', 'Integer']]);
const COLLECTION_RE = /^Collection\((.+)\)$/;
// The responseEntity of the entity types that name no table: any entity (crmbaseentity) and the open type (expando).
const ENTITY_RETURNS = new Map([['crmbaseentity', 'Entity'], ['expando', 'expando']]);

const notCsdl = why => new DataverseError(`The Web API service document ($metadata) cannot be read: ${why}.`, { code: 'notjson' });
// The local name of a type of the Dataverse schema ('mscrm.X' or 'Microsoft.Dynamics.CRM.X'), else null.
function schemaType(t) {
  if (t.startsWith('mscrm.')) return t.slice(6);
  if (t.startsWith(NS)) return t.slice(NS.length);
  return null;
}
// A $metadata type in the BUILTIN_MESSAGES vocabulary (see the notes above); role 'param' or 'response'.
function vocabOf(t, role) {
  const m = COLLECTION_RE.exec(t);
  if (m) {
    if (m[1] === 'Edm.String') return 'StringArray';
    if (schemaType(m[1]) === 'crmbaseentity') return 'EntityCollection';
    return vocabOf(m[1], role) + '[]';
  }
  if (EDM_TYPES.has(t)) return EDM_TYPES.get(t);
  const local = schemaType(t);
  if (local === 'crmbaseentity') return role === 'param' ? 'EntityReference' : 'Entity';
  return local ?? t;
}
const familyOf = t => TYPE_FAMILY.get(t) ?? t;
// The type of a merged entry: $metadata's, unless the other source names the same family more precisely.
const mergedType = (other, csdl) => (other != null && familyOf(other) === familyOf(csdl) ? other : csdl);

// Finds the '>' that ends a tag, from `from` with the quote state `q` (0, or the open quote's code): {end}, or
// {resume, q} to go on from there when the text ends first, so a tag that spans chunks is scanned once.
function tagEnd(s, from, q = 0) {
  for (let k = from; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (q) { if (c === q) q = 0; } else if (c === 34 || c === 39) q = c; else if (c === 62) return { end: k };
  }
  return { resume: s.length, q };
}
const isSpace = c => c === 32 || c === 9 || c === 10 || c === 13;
// The end of the tag name that starts at `i` (whitespace, '/' or '>' ends it).
function nameEnd(s, i) {
  let k = i;
  while (k < s.length && !isSpace(s.charCodeAt(k)) && s.charCodeAt(k) !== 47 && s.charCodeAt(k) !== 62) k++;
  return k;
}
// Markup whose content is no markup: [opener, terminator] of a comment, a CDATA section, a processing instruction.
const SKIPPED = [['<!--', '-->'], ['<![CDATA[', ']]>'], ['<?', '?>']];
// The SKIPPED entry that starts at `i`, or null.
const skippedAt = (s, i) => SKIPPED.find(([open]) => s.startsWith(open, i)) ?? null;
// A copy of a string that keeps nothing of the text it was cut from alive (V8 keeps the parent of a slice).
const own = s => (s + ' ').slice(0, -1);
// A JSON value whose strings are all copies (see own), so it keeps nothing of the stream text alive.
const owned = v => JSON.parse(JSON.stringify(v));

// Finds the end tag of `name` in `s`, going on from the state {at, term} (term: the terminator of the comment,
// CDATA section or processing instruction the search is inside, whose '</name>' is no end tag): {end} (just after
// the end tag; whitespace may precede its '>'), or the state to go on from once more text arrives (markup cut by
// the end of the text is looked at again from its '<').
function closeOf(s, name, { at, term }) {
  const pat = '</' + name;
  let i = at;
  for (;;) {
    if (term) {
      const e = s.indexOf(term, i);
      if (e < 0) return { at: Math.max(i, s.length - term.length + 1), term };
      i = e + term.length;
      term = null;
    }
    const lt = s.indexOf('<', i);
    if (lt < 0) return { at: s.length, term: null };
    if (s.length - lt <= pat.length + 9) {
      const tail = s.slice(lt);
      if ([pat, ...SKIPPED.map(([open]) => open)].some(m => m.length > tail.length && m.startsWith(tail))) return { at: lt, term: null };
    }
    const k = skippedAt(s, lt);
    if (k) { term = k[1]; i = lt + k[0].length; continue; }
    if (s.startsWith(pat, lt)) {
      let j = lt + pat.length;
      while (j < s.length && isSpace(s.charCodeAt(j))) j++;
      if (j >= s.length) return { at: lt, term: null };
      if (s.charCodeAt(j) === 62) return { end: j + 1 };
    }
    i = lt + 1;
  }
}
// The local part of an element name (after its prefix, if any).
const localOf = n => n.slice(n.indexOf(':') + 1);
const startTagOnly = tag => (tag.endsWith('/>') ? tag : tag.slice(0, -1) + '/>');

// The Property start tags (made self-closing) among the children of the ComplexType or EntityType element `text`
// named `name`, whose start tag ends before `from`, as one string; its other tags are walked, not parsed. Null when
// its tags do not nest (the element is then parsed whole, and fails, if a ReturnType references it).
function propertyTags(text, from, name) {
  const kept = [];
  const open = [];
  for (let i = from; ;) {
    const lt = text.indexOf('<', i);
    if (lt < 0) return null;
    const k = skippedAt(text, lt);
    if (k) {
      const e = text.indexOf(k[1], lt + k[0].length);
      if (e < 0) return null;
      i = e + k[1].length;
      continue;
    }
    if (text.startsWith('<!', lt)) return null;
    const t = tagEnd(text, lt + 1);
    if (t.end == null) return null;
    const isClose = text.charCodeAt(lt + 1) === 47;
    const at = lt + (isClose ? 2 : 1);
    const tag = text.slice(at, nameEnd(text, at));
    const child = !open.length && localOf(tag) === 'Property';
    if (isClose) {
      if (!open.length) return tag === name && t.end === text.length - 1 ? own(kept.join('')) : null;
      if (open.pop() !== tag) return null;
    } else if (text.charCodeAt(t.end - 1) === 47) {
      if (child) kept.push(text.slice(lt, t.end + 1));
    } else {
      if (child) kept.push(text.slice(lt, t.end) + '/>');
      open.push(tag);
    }
    i = t.end + 1;
  }
}

// Scans the text chunks of $metadata (any boundaries) and returns its compact message rows
// [name, kind, boundTo, binding, [[param, type, optional]], [[property, type]], responseEntity] (see the notes above).
async function scanCsdl(chunks) {
  let buf = '', pos = 0, opened = false, closed = false;
  const ops = [];
  // type name -> {base, props: its Property start tags (null: its tags do not nest), text: the whole element when
  // they do not nest, list: [[property, type]] once parsed, entity: true for an EntityType}
  const types = new Map();
  const keep = (local, name, text, tag) => {
    if (local === 'Function' || local === 'Action') {
      const node = parseXml(text, { label: CSDL_LABEL });
      const params = node.kids.filter(k => localOf(k.name) === 'Parameter').map(k => [k.attrs.get('Name'), k.attrs.get('Type'), k.attrs.get('Nullable') !== 'false']);
      const ret = node.kids.find(k => localOf(k.name) === 'ReturnType')?.attrs.get('Type') ?? null;
      ops.push(owned({ name: node.attrs.get('Name'), kind: local === 'Function' ? 'function' : 'action', bound: node.attrs.get('IsBound') === 'true', params, ret }));
      return;
    }
    // ComplexType and EntityType: the start tag is parsed now, the Property tags only when a ReturnType references it.
    const head = parseXml(startTagOnly(tag), { label: CSDL_LABEL });
    const typeName = head.attrs.get('Name');
    if (typeof typeName !== 'string' || !typeName || types.has(typeName)) return;
    const base = head.attrs.get('BaseType');
    const props = tag.endsWith('/>') ? '' : propertyTags(text, tag.length, name);
    types.set(own(typeName), { base: typeof base === 'string' ? own(base) : null, props, text: props == null ? own(text) : null, list: null, entity: local === 'EntityType' });
  };
  // Consumes complete markup from `pos`; stops at markup that may continue in the next chunk. `pend` keeps how far
  // that markup was scanned: {term} (inside a comment, CDATA section or processing instruction; pos is where its
  // terminator is looked for), {tagFrom, q} (a tag) or {end, at, term} (a kept element: closeOf's state), offsets
  // from pos, so the next chunk resumes there.
  let pend = null;
  const step = () => {
    for (;;) {
      const p = pend;
      pend = null;
      if (p?.term != null && p.end == null) {
        // a skipped comment, CDATA section or processing instruction: only a possible start of its terminator is kept
        const e = buf.indexOf(p.term, pos);
        if (e < 0) { pos = Math.max(pos, buf.length - p.term.length + 1); pend = p; return; }
        pos = e + p.term.length;
        continue;
      }
      let lt = pos;
      if (!p) {
        lt = buf.indexOf('<', pos);
        if (lt < 0) { pos = buf.length; return; }
        pos = lt;
        if (buf.length - lt < 9) return; // '<!DOCTYPE', '<![CDATA[' and '<!--' are told apart by their first 9 characters
        const k = skippedAt(buf, lt);
        if (k) { pos = lt + k[0].length; pend = { term: k[1] }; continue; }
        if (buf.startsWith('<!', lt)) throw notCsdl('it holds a <!DOCTYPE> or another declaration');
      }
      const tooLong = what => { if (buf.length - lt > CSDL_MAX_ELEMENT) throw notCsdl(what); };
      let end;
      if (p?.end != null) end = lt + p.end;
      else {
        const t = tagEnd(buf, p ? lt + p.tagFrom : lt + 1, p ? p.q : 0);
        if (t.end == null) { pend = { tagFrom: t.resume - lt, q: t.q }; tooLong('a tag does not end'); return; }
        end = t.end;
      }
      const isClose = buf.charCodeAt(lt + 1) === 47;
      const at = lt + (isClose ? 2 : 1);
      const name = buf.slice(at, nameEnd(buf, at));
      const local = localOf(name);
      if (local === 'Edmx') { if (isClose) closed = true; else opened = true; }
      if (isClose || !CSDL_KEEP.has(local)) { pos = end + 1; continue; }
      let stop = end + 1;
      if (buf.charCodeAt(end - 1) !== 47) {
        const c = closeOf(buf, name, p?.end != null ? { at: lt + p.at, term: p.term } : { at: end + 1, term: null });
        if (c.end == null) { pend = { end: end - lt, at: c.at - lt, term: c.term }; tooLong(`the element <${name}> does not end`); return; }
        stop = c.end;
      }
      keep(local, name, buf.slice(lt, stop), buf.slice(lt, end + 1));
      pos = stop;
    }
  };
  for await (const chunk of chunks) {
    if (typeof chunk !== 'string') throw new TypeError('messages: api.csdl() must yield text chunks.');
    buf = buf.slice(pos) + chunk;
    pos = 0;
    step();
  }
  // The last characters may be fewer than the 9 that tell markup apart: finish with padding that is no markup.
  buf = buf.slice(pos) + ' '.repeat(9);
  pos = 0;
  step();
  if (pend || buf.slice(pos).trim() !== '') throw notCsdl('it ends inside an element');
  if (!opened || !closed) throw notCsdl('it is not an edmx:Edmx document');
  // The properties of a complex or entity type, inherited ones first (a BaseType cycle stops at the repeated type).
  const propsOf = (t, seen = new Set()) => {
    const local = schemaType(t) ?? t;
    const ty = types.get(local);
    if (!ty || seen.has(local)) return [];
    seen.add(local);
    if (!ty.list) {
      const node = parseXml(ty.props == null ? ty.text : `<Properties>${ty.props}</Properties>`, { label: CSDL_LABEL });
      ty.list = node.kids.filter(k => localOf(k.name) === 'Property').map(k => [k.attrs.get('Name'), k.attrs.get('Type')]);
    }
    return [...(ty.base ? propsOf(ty.base, seen) : []), ...ty.list];
  };
  const rows = [];
  const seen = new Set();
  const valid = n => typeof n === 'string' && IDENT_RE.test(n);
  for (const op of ops) {
    if (!valid(op.name)) continue;
    let params = op.params, boundTo = null, binding = null;
    if (op.bound) {
      const t = params[0]?.[1];
      if (typeof t !== 'string') continue;
      const m = COLLECTION_RE.exec(t);
      const local = schemaType(m ? m[1] : t);
      if (!local || !IDENT_RE.test(local)) continue;
      boundTo = lower(local);
      binding = m ? 'collection' : 'entity';
      params = params.slice(1);
    }
    const key = `${lower(op.name)}|${boundTo ?? ''}|${binding ?? ''}`;
    if (seen.has(key) || !params.every(p => valid(p[0]) && typeof p[1] === 'string')) continue;
    let response = [], responseEntity = null;
    if (op.ret != null) {
      const local = schemaType(op.ret);
      response = local && types.has(local) ? propsOf(op.ret).map(([n, t]) => [n, typeof t === 'string' ? vocabOf(t, 'response') : 'Unknown'])
        : [['value', vocabOf(op.ret, 'response')]];
      // an EntityType return: the answer is that entity itself (see the notes above)
      if (local && types.get(local)?.entity && IDENT_RE.test(local)) responseEntity = ENTITY_RETURNS.get(local) ?? lower(local);
    }
    if (!response.every(p => valid(p[0]))) continue;
    seen.add(key);
    rows.push([op.name, op.kind, boundTo, binding, params.map(([n, t, opt]) => [n, vocabOf(t, 'param'), opt]), response, responseEntity]);
  }
  return owned(rows);
}

// ----- createMeta ------------------------------------------------------------------------------------------

// Creates the app-wide metadata cache over api (02 §2).
export function createMeta(api, {
  store = null, lang = null, browserTz = { offset: ms => -new Date(ms).getTimezoneOffset() }, now = Date.now,
  reportError = e => queueMicrotask(() => { throw e; }), inBody = () => false,
} = {}) {
  if (!api || typeof api.get !== 'function') throw new TypeError('createMeta: an api is required.');
  if (typeof inBody !== 'function') throw new TypeError('createMeta: inBody must be a function.');
  // Every FetchXML read of meta follows the setting 'Send queries in the request body' (00 §5 rule 6).
  const fetchXml = async (entitySet, xml) => api.fetchXml(entitySet, xml, { inBody: inBody() === true });
  let host = 'default';
  try { if (api.origin) host = new URL(api.origin).host; } catch { /* keep the default key */ }
  const KEY_ENTITIES = `meta:${host}:entities`, KEY_MESSAGES = `meta:${host}:messages`, KEY_LANG = `meta:${host}:lang`;

  let list = freeze([]);
  let listLang = null;
  let byName = new Map(), bySet = new Map(), bySchema = new Map();
  const loaded = new Map(), loadedLang = new Map();
  const jobs = new Map(), probes = new Map();
  const rels = new Map(), opts = new Map(), keyCache = new Map();
  let user = null, org = null, userLang = null, tzMatch = false;
  let initPromise = null, listJob = null;
  let messagesCache = null, fullMessages = null, customCache = null, partialMessages = null, currencyPromise = null;
  const sessionJobs = new Map();
  let generation = 0;
  const listeners = new Set();

  const emit = ev => { for (const cb of [...listeners]) { try { cb(ev); } catch (e) { try { reportError(e); } catch { /* the reporter itself failed */ } } } };
  const storeGet = k => { try { return store?.get ? store.get(k, null) : null; } catch { return null; } };
  const storeSet = (k, v) => { try { return store?.set ? store.set(k, v) : false; } catch { return false; } };
  const storeDel = k => { try { store?.del?.(k); } catch { /* storage unavailable */ } };
  const validLang = v => Number.isInteger(v) && v > 0 && v < 100000;
  const currentLang = () => userLang ?? listLang ?? (validLang(lang) ? lang : null) ?? (validLang(storeGet(KEY_LANG)) ? storeGet(KEY_LANG) : 1033);
  const setOf = name => list.length ? (byName.get(name)?.entitySetName ?? SYSTEM_SETS.get(name)) : SYSTEM_SETS.get(name);
  const defPath = logical => `EntityDefinitions(LogicalName=${odataString(logical)})`;

  // ----- entity list ---------------------------------------------------------------------------------------

  function setList(entries, lng) {
    const next = entries.map(e => loaded.get(e.logicalName) ?? freeze(e));
    byName = new Map(); bySet = new Map(); bySchema = new Map();
    for (const e of next) {
      byName.set(e.logicalName, e);
      if (e.entitySetName) bySet.set(lower(e.entitySetName), e);
      if (e.schemaName) bySchema.set(lower(e.schemaName), e);
    }
    list = freeze(next);
    listLang = lng;
    emit({ kind: 'entities' });
  }
  // Puts a freshly loaded EntityInfo in place of its list entry; names the old entry had are dropped first.
  function replaceInList(info) {
    const old = byName.get(info.logicalName);
    if (!old) return;
    list = freeze(list.map(e => (e === old ? info : e)));
    byName.set(info.logicalName, info);
    for (const [map, k] of [[bySet, old.entitySetName], [bySchema, old.schemaName]]) if (k && map.get(lower(k)) === old) map.delete(lower(k));
    if (info.entitySetName) bySet.set(lower(info.entitySetName), info);
    if (info.schemaName) bySchema.set(lower(info.schemaName), info);
  }
  // Adds a table found after the list was read (logicalOf's check) to the list, and reports it.
  function addToList(info) {
    if (byName.has(info.logicalName)) return;
    const e = freeze(info);
    list = freeze([...list, e]);
    byName.set(e.logicalName, e);
    if (e.entitySetName && !bySet.has(lower(e.entitySetName))) bySet.set(lower(e.entitySetName), e);
    if (e.schemaName && !bySchema.has(lower(e.schemaName))) bySchema.set(lower(e.schemaName), e);
    emit({ kind: 'entities' });
  }

  function readCache(lng) {
    const v = storeGet(KEY_ENTITIES);
    if (!v || typeof v !== 'object' || v.v !== 1 || !Number.isFinite(v.at) || v.at > now() || v.lang !== lng || !Array.isArray(v.rows)) return null;
    if (now() - v.at >= DAY) return null;
    const out = [];
    const names = new Set(), sets = new Set();
    for (const row of v.rows) {
      if (!Array.isArray(row) || row.length !== ENTITY_FIELDS.length) return discard();
      const e = {};
      for (let i = 0; i < ENTITY_FIELDS.length; i++) {
        const [k, check] = ENTITY_FIELDS[i];
        if (!CHECKS[check](row[i])) return discard();
        e[k] = row[i];
      }
      if (e.logicalName !== lower(e.logicalName) || names.has(e.logicalName)) return discard();
      names.add(e.logicalName);
      if (e.entitySetName) {
        if (sets.has(lower(e.entitySetName))) return discard();
        sets.add(lower(e.entitySetName));
      }
      e.kind = tableKind(e.tableType, e.dataProviderId);
      e.attrs = null;
      e.attrList = null;
      out.push(e);
    }
    return { at: v.at, entries: out };
  }
  function discard() { storeDel(KEY_ENTITIES); return null; }
  function writeCache(entries, lng) {
    const value = { v: 1, at: now(), lang: lng, rows: entries.map(e => ENTITY_FIELDS.map(([k]) => e[k])) };
    if (JSON.stringify(value).length > CACHE_MAX) { storeDel(KEY_ENTITIES); return; }
    storeSet(KEY_ENTITIES, value);
    storeSet(KEY_LANG, lng);
  }

  async function fetchList(lng) {
    const gen = generation;
    const j = await api.get(`EntityDefinitions?$select=${ENTITY_SELECT}&LabelLanguages=${lng}`);
    if (!Array.isArray(j?.value)) throw new DataverseError('The table list from Dataverse has no value array.', { code: 'notjson' });
    const entries = j.value.filter(e => typeof e?.LogicalName === 'string' && IDENT_RE.test(e.LogicalName)).map(e => entityFrom(e, lng));
    if (gen !== generation) return;
    // A list in another language never replaces one in the language now wanted (a refresh in the stored language
    // can end after the one in the user's language).
    if (lng !== currentLang() && listLang === currentLang()) return;
    setList(entries, lng);
    writeCache(entries, lng);
  }
  // Reloads the list in `lng` unless a reload in that language is already running.
  function refreshListInBackground(lng) {
    if (listJob && listJob.lang === lng) return;
    const job = { lang: lng };
    listJob = job;
    fetchList(lng).catch(error => emit({ kind: 'error', error, source: 'entities' })).finally(() => { if (listJob === job) listJob = null; });
  }
  async function loadList(lng) {
    const cached = readCache(lng);
    if (cached) {
      setList(cached.entries, lng);
      if (now() - cached.at >= HOUR) refreshListInBackground(lng);
      return;
    }
    await fetchList(lng);
  }

  // ----- user, organization, time zone ------------------------------------------------------------------

  function computeTz(u) {
    if (!u || !Number.isFinite(u.tzBias) || !Number.isFinite(u.tzStandardBias)) return false;
    const server = new Set([u.tzBias + u.tzStandardBias]);
    if (u.tzDaylightMonth && Number.isFinite(u.tzDaylightBias)) server.add(u.tzBias + u.tzDaylightBias);
    const y = new Date(now()).getUTCFullYear();
    const browser = new Set([-browserTz.offset(Date.UTC(y, 0, 15)), -browserTz.offset(Date.UTC(y, 6, 15))]);
    return server.size === browser.size && [...server].every(x => browser.has(x));
  }
  async function loadUser() {
    const who = await api.whoAmI();
    const id = who?.UserId;
    if (!isGuid(id)) throw new DataverseError('WhoAmI returned no user id.', { code: 'notjson' });
    const j = await api.get(`usersettingscollection?$select=${USER_SELECT}&$filter=systemuserid%20eq%20${lower(id)}`);
    const s = Array.isArray(j?.value) ? j.value[0] : null;
    if (!s) throw new DataverseError(`Dataverse returned no usersettings for the user ${lower(id)}.`, { code: 'notjson' });
    user = freeze({
      id: lower(id), lcid: num(s.uilanguageid), tzBias: num(s.timezonebias), tzStandardBias: num(s.timezonestandardbias), tzDaylightBias: num(s.timezonedaylightbias),
      tzDaylightMonth: num(s.timezonedaylightmonth), tzCode: num(s.timezonecode), dateFormat: str(s.dateformatstring), timeFormat: str(s.timeformatstring),
      decimalSymbol: str(s.decimalsymbol), numberSeparator: str(s.numberseparator),
    });
    tzMatch = computeTz(user);
    if (validLang(user.lcid)) userLang = user.lcid;
  }
  async function loadOrg() {
    const j = await api.get(`organizations?$select=${ORG_SELECT}`);
    const o = Array.isArray(j?.value) ? j.value[0] : null;
    if (!o) throw new DataverseError('Dataverse returned no organization record.', { code: 'notjson' });
    org = freeze({
      id: o.organizationid ? lower(o.organizationid) : null, name: str(o.name), lcid: num(o.localeid), languageCode: num(o.languagecode),
      fiscalCalendarStart: str(o.fiscalcalendarstart), fiscalPeriodType: num(o.fiscalperiodtype), fiscalYearDisplayCode: num(o.fiscalyeardisplaycode),
    });
  }

  // Loads the entity list, the organization and the user's settings in parallel (02 §2).
  function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const lng = currentLang();
      const results = await Promise.allSettled([loadList(lng), loadOrg(), loadUser()]);
      if (userLang != null && listLang != null && userLang !== listLang) refreshListInBackground(userLang);
      const failed = results.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    initPromise.catch(() => { initPromise = null; });
    return initPromise;
  }

  // ----- name resolution ----------------------------------------------------------------------------------

  // Finds a table by logical, entity set or schema name (case-insensitive); null when unknown.
  function findEntity(name) {
    if (typeof name !== 'string' || name === '') return null;
    const k = lower(name);
    return byName.get(k) ?? bySet.get(k) ?? bySchema.get(k) ?? null;
  }
  function tableCandidates() {
    return list.map(e => [e.logicalName, e.displayName]);
  }
  // SqlError 208 for a table name as the caller wrote it; `gone` (a listed table Dataverse no longer has) is never
  // suggested.
  function notFound(name, gone = null) {
    const s = didYouMean(String(name), gone ? tableCandidates().filter(([n]) => n !== gone) : tableCandidates(), 3);
    const e = numbered(208, messageText(208, name) + (s.length ? ` Did you mean ${quoteList(s)}?` : ''));
    e.suggestions = s;
    return e;
  }
  // A TableMissing marker as this caller's 208 (the name as the caller wrote it); any other error as it is.
  const missingAs = (e, name) => (e instanceof TableMissing ? notFound(name, e.logical) : e);
  // Resolves a table name to its logical name (awaiting a running init); rejects with 208 when unknown.
  async function logicalOf(name) {
    if (typeof name !== 'string' || name === '') throw notFound(String(name ?? ''));
    let e = findEntity(name);
    if (e) return e.logicalName;
    if (!list.length && initPromise) { try { await initPromise; } catch { /* resolved below */ } e = findEntity(name); if (e) return e.logicalName; }
    if (!IDENT_RE.test(name)) throw notFound(name);
    if (list.length) await probe(lower(name), name);
    return lower(name);
  }
  // A name missing from the loaded list (up to 24 h old) may be a table created since: one light request checks it
  // and adds it to the list. A 404 (208 with did-you-mean) or any other failure is kept for 30 s, so typing or
  // re-running never sends a request storm.
  async function probe(logical, name) {
    let p = probes.get(logical);
    if (p && !p.promise && now() - p.at >= FAIL_MS) p = null;
    if (!p) {
      const gen = generation;
      const lng = currentLang();
      const entry = { promise: null, missing: false, error: null, at: 0 };
      entry.promise = api.get(`${defPath(logical)}?$select=${ENTITY_SELECT}&LabelLanguages=${lng}`).then(j => {
        if (!j || lower(j.LogicalName ?? '') !== logical) throw new DataverseError(`Dataverse returned no definition for the table '${logical}'.`, { code: 'notjson' });
        if (gen === generation) addToList(entityFrom(j, lng));
        if (probes.get(logical) === entry) probes.delete(logical);
      }).catch(e => {
        if (e instanceof DataverseError && e.status === 404) entry.missing = true; else entry.error = e;
        entry.at = now();
        if (gen !== generation && probes.get(logical) === entry) probes.delete(logical);
      }).finally(() => { entry.promise = null; });
      probes.set(logical, entry);
      p = entry;
    }
    if (p.promise) await p.promise;
    if (findEntity(logical)) return;
    if (p.missing) throw notFound(name);
    if (p.error) throw copyError(p.error);
  }
  // Shared in-flight request per key, failures kept for 30 s (02 §2: no request storms while typing). Every caller
  // gets its own copy of a failure. With `lang`, an entry loaded in another language is reloaded; its value stays
  // readable as `stale` for the sync getters until then.
  function shared(map, key, load, lang = null) {
    const job = map.get(key);
    if (job && (lang == null || job.lang === lang)) {
      if (job.value !== undefined) return Promise.resolve(job.value);
      if (job.error && now() - job.at < FAIL_MS) return Promise.reject(copyError(job.error));
      if (job.promise) return job.promise.catch(rethrowCopy);
    }
    const gen = generation;
    const entry = { promise: null, value: undefined, error: null, at: 0, lang, stale: job?.value ?? job?.stale };
    entry.promise = load().then(v => {
      if (gen === generation) { entry.value = v; entry.promise = null; } else if (map.get(key) === entry) map.delete(key);
      return v;
    }, e => {
      if (gen === generation) { entry.error = e; entry.at = now(); entry.promise = null; } else if (map.get(key) === entry) map.delete(key);
      throw e;
    });
    map.set(key, entry);
    return entry.promise.catch(rethrowCopy);
  }
  const syncValue = entry => entry?.value ?? entry?.stale ?? null;

  // ----- entity() -----------------------------------------------------------------------------------------

  async function loadEntity(logical) {
    const lng = currentLang();
    const base = defPath(logical);
    const gen = generation;
    let parts;
    try {
      parts = await Promise.all([
        api.get(`${base}?$select=${ENTITY_SELECT}&$expand=Attributes($select=${ATTR_SELECT})&LabelLanguages=${lng}`),
        ...CASTS.map(([cast, select]) => api.get(`${base}/Attributes/${NS}${cast}?$select=${select}`)),
      ]);
    } catch (e) {
      if (e instanceof DataverseError && e.status === 404) throw new TableMissing(logical);
      throw e;
    }
    const [def, ...casts] = parts;
    if (!def || lower(def.LogicalName ?? '') !== logical || !Array.isArray(def.Attributes)) throw new DataverseError(`Dataverse returned no definition for the table '${logical}'.`, { code: 'notjson' });
    const extra = new Map();
    for (const c of casts) for (const x of Array.isArray(c?.value) ? c.value : []) if (typeof x?.LogicalName === 'string') extra.set(lower(x.LogicalName), { ...(extra.get(lower(x.LogicalName)) ?? {}), ...x });
    const info = entityFrom(def, lng);
    const attrList = def.Attributes.filter(a => typeof a?.LogicalName === 'string')
      .map(a => attrFrom(info.logicalName, a, extra.get(lower(a.LogicalName)), lng))
      .sort((a, b) => (a.columnNumber ?? Infinity) - (b.columnNumber ?? Infinity) || (a.logicalName < b.logicalName ? -1 : a.logicalName > b.logicalName ? 1 : 0));
    info.attrList = freeze(attrList);
    info.attrs = new Map(attrList.map(a => [a.logicalName, a]));
    const frozen = freeze(info);
    if (gen === generation) {
      loaded.set(logical, frozen);
      loadedLang.set(logical, lng);
      replaceInList(frozen);
      emit({ kind: 'entity', name: logical });
    }
    return frozen;
  }

  // Loads a table with its attributes (8 parallel requests, shared, failures kept 30 s); rejects with SqlError 208
  // (named as this caller wrote it). A table loaded in another language (before usersettings arrived) is reloaded
  // once in the current one; while that fails for any reason other than 208, the loaded table is still returned.
  async function entity(name) {
    const logical = await logicalOf(name);
    const have = loaded.get(logical);
    const lng = currentLang();
    if (have && loadedLang.get(logical) === lng) return have;
    try {
      return await shared(jobs, logical, () => loadEntity(logical), lng);
    } catch (e) {
      if (e instanceof TableMissing) throw missingAs(e, name);
      if (have && !(e instanceof SqlError)) return have;
      throw e;
    }
  }

  // The loaded table (attributes included), or null when entity() has not resolved for it.
  function entitySync(name) {
    const e = findEntity(name);
    return loaded.get(e ? e.logicalName : lower(String(name ?? ''))) ?? null;
  }

  // ----- relationships, options, keys ---------------------------------------------------------------------

  async function loadRels(logical) {
    const j = await api.get(`${defPath(logical)}?$select=LogicalName&$expand=ManyToOneRelationships($select=${N1_SELECT}),` +
      `OneToManyRelationships($select=${ONEN_SELECT}),ManyToManyRelationships($select=${NN_SELECT})`).catch(e => {
      if (e instanceof DataverseError && e.status === 404) throw new TableMissing(logical);
      throw e;
    });
    const arr = v => (Array.isArray(v) ? v : []);
    const n1 = [];
    for (const r of arr(j?.ManyToOneRelationships)) {
      const target = lname(r.ReferencedEntity);
      const base = { schemaName: str(r.SchemaName), attr: lname(r.ReferencingAttribute), nav: str(r.ReferencingEntityNavigationPropertyName), hierarchical: flag(r.IsHierarchical) };
      if (target === 'owner') {
        for (const t of ['systemuser', 'team']) n1.push(freeze({ ...base, target: t, targetAttr: byName.get(t)?.primaryIdAttribute ?? `${t}id` }));
      } else n1.push(freeze({ ...base, target, targetAttr: lname(r.ReferencedAttribute) }));
    }
    const oneN = arr(j?.OneToManyRelationships).map(r => {
      const c = r.CascadeConfiguration ?? {};
      return freeze({
        schemaName: str(r.SchemaName), attr: lname(r.ReferencingAttribute), source: lname(r.ReferencingEntity), sourceAttr: lname(r.ReferencedAttribute),
        nav: str(r.ReferencedEntityNavigationPropertyName),
        cascade: freeze({ assign: str(c.Assign), delete: str(c.Delete), reparent: str(c.Reparent), share: str(c.Share), unshare: str(c.Unshare) }),
      });
    });
    const nn = arr(j?.ManyToManyRelationships).map(r => freeze({
      schemaName: str(r.SchemaName), intersect: lname(r.IntersectEntityName), entity1: lname(r.Entity1LogicalName), entity1Attr: lname(r.Entity1IntersectAttribute),
      entity1Nav: str(r.Entity1NavigationPropertyName), entity2: lname(r.Entity2LogicalName), entity2Attr: lname(r.Entity2IntersectAttribute),
      entity2Nav: str(r.Entity2NavigationPropertyName),
    }));
    return freeze({ n1: freeze(n1), oneN: freeze(oneN), nn: freeze(nn) });
  }

  // N:1, 1:N and N:N relationships of a table (02 §2 Rels).
  async function relationships(name) {
    const logical = await logicalOf(name);
    return shared(rels, logical, () => loadRels(logical)).catch(e => { throw missingAs(e, name); });
  }
  // The cached relationships of a table, or null.
  function relationshipsSync(name) {
    const e = findEntity(name);
    return syncValue(rels.get(e ? e.logicalName : lower(String(name ?? ''))));
  }

  async function loadOptions(info, a) {
    const cast = OPTION_CASTS.get(a.type);
    if (!cast) return freeze([]);
    const lng = currentLang();
    const j = await api.get(`${defPath(info.logicalName)}/Attributes(LogicalName=${odataString(a.logicalName)})/${NS}${cast[0]}?$select=LogicalName&$expand=${cast[1]}&LabelLanguages=${lng}`);
    return freeze(optionsFromSet(j?.OptionSet, lng) ?? optionsFromSet(j?.GlobalOptionSet, lng) ?? []);
  }

  // Options of a choice, multi-select, state, status or Boolean column (Boolean -> values 0 and 1).
  async function options(entityName, attrName) {
    const info = await entity(entityName);
    const a = info.attrs.get(lower(String(attrName ?? '')));
    if (!a) {
      const e = numbered(207, messageText(207, attrName));
      e.suggestions = didYouMean(String(attrName ?? ''), info.attrList.map(x => [x.logicalName, x.displayName]), 3);
      throw e;
    }
    return shared(opts, `${info.logicalName}.${a.logicalName}`, () => loadOptions(info, a), currentLang());
  }
  // The cached options of a column, or null.
  function optionsSync(entityName, attrName) {
    const e = findEntity(entityName);
    return syncValue(opts.get(`${e ? e.logicalName : lower(String(entityName ?? ''))}.${lower(String(attrName ?? ''))}`));
  }

  // Alternate keys of a table: [{schemaName, logicalName, attrs}].
  async function keys(name) {
    const logical = await logicalOf(name);
    return shared(keyCache, logical, async () => {
      const j = await api.get(`${defPath(logical)}/Keys?$select=SchemaName,LogicalName,KeyAttributes`).catch(e => {
        if (e instanceof DataverseError && e.status === 404) throw new TableMissing(logical);
        throw e;
      });
      return freeze((Array.isArray(j?.value) ? j.value : []).map(k => freeze({
        schemaName: str(k.SchemaName), logicalName: lname(k.LogicalName), attrs: freeze((Array.isArray(k.KeyAttributes) ? k.KeyAttributes : []).map(lower)),
      })));
    }).catch(e => { throw missingAs(e, name); });
  }

  // Global option sets with their options (cached for the session, per language; a failure is kept 30 s).
  function globalOptionSets() {
    const lng = currentLang();
    const setFrom = s => freeze({
      metadataId: isGuid(s.MetadataId) ? lower(s.MetadataId) : null, name: str(s.Name), displayName: labelOf(s.DisplayName, lng), description: labelOf(s.Description, lng),
      optionSetType: enumText(s.OptionSetType), isCustom: flag(s.IsCustomOptionSet), isManaged: flag(s.IsManaged), options: freeze(optionsFromSet(s, lng) ?? []),
    });
    return shared(sessionJobs, 'globalOptionSets', async () => {
      const j = await api.get(`GlobalOptionSetDefinitions?LabelLanguages=${lng}`);
      return freeze((Array.isArray(j?.value) ? j.value : []).map(setFrom));
    }, lng);
  }

  // ----- messages -----------------------------------------------------------------------------------------

  const csdlReadable = () => typeof api.csdl === 'function';
  const paramRow = p => Array.isArray(p) && p.length === 4 && typeof p[0] === 'string' && IDENT_RE.test(p[0]) && typeof p[1] === 'string' && typeof p[2] === 'boolean' && (p[3] === null || typeof p[3] === 'string');
  const responseRow = p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && IDENT_RE.test(p[0]) && typeof p[1] === 'string';
  const bindingOk = (boundTo, binding) => (boundTo === null ? binding === null : binding === 'entity' || binding === 'collection');
  // A stored custom API row: [name, kind, boundTo, description, params, response, binding].
  const validRow = r => Array.isArray(r) && r.length === 7 && typeof r[0] === 'string' && IDENT_RE.test(r[0]) && (r[1] === 'function' || r[1] === 'action') &&
    (r[2] === null || (typeof r[2] === 'string' && IDENT_RE.test(r[2]))) && (r[3] === null || typeof r[3] === 'string') && bindingOk(r[2], r[6]) &&
    Array.isArray(r[4]) && r[4].every(paramRow) && Array.isArray(r[5]) && r[5].every(responseRow);
  // A stored $metadata row: [name, kind, boundTo, binding, [[param, type, optional]], [[property, type]], responseEntity].
  const validCsdlRow = r => Array.isArray(r) && r.length === 7 && typeof r[0] === 'string' && IDENT_RE.test(r[0]) && (r[1] === 'function' || r[1] === 'action') &&
    (r[2] === null || (typeof r[2] === 'string' && IDENT_RE.test(r[2]))) && bindingOk(r[2], r[3]) &&
    Array.isArray(r[4]) && r[4].every(p => Array.isArray(p) && p.length === 3 && typeof p[0] === 'string' && IDENT_RE.test(p[0]) && typeof p[1] === 'string' && typeof p[2] === 'boolean') &&
    Array.isArray(r[5]) && r[5].every(responseRow) && (r[6] === null || (typeof r[6] === 'string' && IDENT_RE.test(r[6])));

  async function getAll(path) {
    const rows = [];
    let next = path;
    for (let page = 0; next; page++) {
      if (page >= PAGE_LIMIT) throw new DataverseError(`Reading ${path.split('?')[0]} did not end after ${PAGE_LIMIT} pages.`, { code: 'paging' });
      const j = await api.get(next);
      if (Array.isArray(j?.value)) rows.push(...j.value);
      const link = typeof j?.['@odata.nextLink'] === 'string' ? j['@odata.nextLink'] : null;
      if (!link) break;
      if (!link.startsWith(api.base)) throw new DataverseError('Dataverse returned a next-page link outside the Web API.', { code: 'paging' });
      next = link.slice(api.base.length);
    }
    return rows;
  }
  // The custom API rows: {rows, unreadable} (unreadable: a privilege error, so BUILTIN_MESSAGES and $metadata stand).
  async function loadCustomApis() {
    const f = '&$filter=statecode%20eq%200';
    // a fixed order (see the notes above): positional EXEC arguments follow the parameter order when $metadata is absent
    const order = '&$orderby=createdon,uniquename';
    let apis, reqs, resps;
    try {
      [apis, reqs, resps] = await Promise.all([
        getAll(`${setOf('customapi')}?$select=customapiid,uniquename,displayname,description,isfunction,bindingtype,boundentitylogicalname${f}&$orderby=uniquename`),
        getAll(`${setOf('customapirequestparameter')}?$select=_customapiid_value,uniquename,type,isoptional,description,logicalentityname${f}${order}`),
        getAll(`${setOf('customapiresponseproperty')}?$select=_customapiid_value,uniquename,type,description,logicalentityname${f}${order}`),
      ]);
    } catch (e) {
      if (isPrivilegeError(e)) return { rows: [], unreadable: true };
      throw e;
    }
    // An Entity or EntityReference with its logicalentityname is that table, an EntityCollection that table's rows
    // ('<table>[]'), as $metadata types them (mscrm.<table>, Collection(mscrm.<table>)).
    const typeOf = (t, table) => {
      const type = CUSTOM_API_TYPES[t] ?? 'Unknown';
      const etn = typeof table === 'string' && IDENT_RE.test(table) ? lower(table) : null;
      if (etn == null) return type;
      return type === 'Entity' || type === 'EntityReference' ? etn : type === 'EntityCollection' ? etn + '[]' : type;
    };
    const group = (items, mk) => {
      const m = new Map();
      for (const x of items) {
        const k = x._customapiid_value ? lower(x._customapiid_value) : null;
        if (!k || typeof x.uniquename !== 'string' || !IDENT_RE.test(x.uniquename)) continue;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(mk(x));
      }
      return m;
    };
    const pm = group(reqs, x => [x.uniquename, typeOf(x.type, x.logicalentityname), x.isoptional === true, str(x.description)]);
    const rm = group(resps, x => [x.uniquename, typeOf(x.type, x.logicalentityname)]);
    const rows = [];
    for (const a of apis) {
      if (typeof a.uniquename !== 'string' || !IDENT_RE.test(a.uniquename) || !a.customapiid) continue;
      const id = lower(a.customapiid);
      // bindingtype 0 Global, 1 Entity (one record), 2 EntityCollection (the table's collection)
      const bound = (a.bindingtype === 1 || a.bindingtype === 2) && typeof a.boundentitylogicalname === 'string' && IDENT_RE.test(a.boundentitylogicalname) ? lower(a.boundentitylogicalname) : null;
      const binding = bound == null ? null : a.bindingtype === 2 ? 'collection' : 'entity';
      rows.push([a.uniquename, a.isfunction === true ? 'function' : 'action', bound, str(a.description) ?? str(a.displayname), pm.get(id) ?? [], rm.get(id) ?? [], binding]);
    }
    return { rows, unreadable: false };
  }
  // The $metadata rows, or null when the api cannot read $metadata.
  const loadCsdl = () => (csdlReadable() ? scanCsdl(api.csdl()) : Promise.resolve(null));

  // The custom API rows, read once for messages() with and without $metadata: kept 24 h, a failure 30 s (reported
  // once, as onChange {kind: 'error', source: 'messages'}). Resolves to the entry {value, error, at}.
  function customRows() {
    const c = customCache;
    if (c && (c.promise || now() - c.at < (c.error ? FAIL_MS : DAY))) return c.promise ?? Promise.resolve(c);
    const gen = generation;
    const entry = { promise: null, value: null, error: null, at: 0 };
    entry.promise = loadCustomApis().then(v => { entry.value = v; }, error => {
      entry.error = error;
      if (gen === generation) emit({ kind: 'error', error, source: 'messages' });
    }).then(() => {
      entry.at = now();
      entry.promise = null;
      return entry;
    });
    customCache = entry;
    return entry.promise;
  }

  // The stored value {at, rows, csdl} when it is valid, current and complete for this api; otherwise it is dropped.
  function readStoredMessages() {
    const v = storeGet(KEY_MESSAGES);
    if (v == null) return null;
    const fresh = v && typeof v === 'object' && v.v === MESSAGES_VERSION && Number.isFinite(v.at) && v.at <= now() && now() - v.at < DAY;
    const rowsOk = fresh && Array.isArray(v.rows) && v.rows.every(validRow);
    const flagOk = rowsOk && (v.customUnreadable === undefined || v.customUnreadable === false || (v.customUnreadable === true && v.rows.length === 0));
    const csdlOk = flagOk && (v.csdl === null ? !csdlReadable() : Array.isArray(v.csdl) && v.csdl.every(validCsdlRow));
    if (!csdlOk) { storeDel(KEY_MESSAGES); return null; }
    return { at: v.at, rows: v.rows, csdl: v.csdl };
  }

  // One message entry from the rows of the sources that have its name: the BUILTIN_MESSAGES row, the custom API row
  // and every $metadata overload (any may be absent; see the notes above).
  function mergeMessage(b, c, overloads) {
    const params = list => list.map(([name, type, optional, description]) => ({ name, type, optional, description: description ?? null }));
    const response = list => list.map(([name, type]) => ({ name, type }));
    const builtin = b && { name: b[0], kind: b[1], boundTo: b[2], binding: b[2] ? 'entity' : null, description: b[3], params: params(b[4]), response: response(b[5]) };
    const custom = c && { name: c[0], kind: c[1], boundTo: c[2], binding: c[6] ?? (c[2] ? 'entity' : null), description: c[3], params: params(c[4]), response: response(c[5]) };
    // the $metadata overload bound like the BUILTIN_MESSAGES (else custom API) entry, else the first
    const like = builtin ?? custom;
    const x = overloads.length ? (like && overloads.find(r => r[2] === like.boundTo && r[3] === like.binding)) || overloads[0] : null;
    const csdl = x && { name: x[0], kind: x[1], boundTo: x[2], binding: x[3], params: params(x[4]), response: response(x[5]), responseEntity: x[6] };
    const others = [custom, builtin].filter(Boolean);
    const find = (list, name) => {
      for (const o of others) {
        const hit = o[list].find(p => lower(p.name) === lower(name));
        if (hit) return hit;
      }
      return null;
    };
    const describe = name => { for (const o of others) { const hit = o.params.find(p => lower(p.name) === lower(name)); if (hit?.description) return hit.description; } return null; };
    const shape = builtin ?? csdl ?? custom;
    const base = csdl ?? custom ?? builtin;
    let props;
    if (builtin) {
      // the verified response: BUILTIN_MESSAGES' names and position order, each type from $metadata, then the
      // properties only $metadata declares
      const declared = csdl ? csdl.response : [];
      const used = new Set();
      props = builtin.response.map(p => {
        const hit = declared.find(q => !used.has(q) && lower(q.name) === lower(p.name));
        if (!hit) return p;
        used.add(hit);
        return { name: hit.name, type: mergedType(p.type, hit.type) };
      });
      for (const q of declared) if (!used.has(q)) props.push({ name: q.name, type: mergedType(find('response', q.name)?.type, q.type) });
    } else props = base.response.map(p => ({ name: p.name, type: csdl ? mergedType(find('response', p.name)?.type, p.type) : p.type }));
    return freeze({
      name: base.name, kind: shape.kind, boundTo: shape.boundTo, binding: shape.binding, isCustom: !!c,
      description: custom?.description ?? builtin?.description ?? null,
      params: freeze(base.params.map(p => freeze({ name: p.name, type: csdl ? mergedType(find('params', p.name)?.type, p.type) : p.type, optional: p.optional,
        description: base === csdl ? describe(p.name) : p.description ?? describe(p.name) }))),
      response: freeze(props.map(p => freeze({ name: p.name, type: p.type }))),
      // the answer is one entity of this table ('Entity': any table, 'expando': an open entity), from $metadata
      responseEntity: csdl?.responseEntity ?? null,
    });
  }
  // The messages Map from the custom API and $metadata rows: BUILTIN_MESSAGES names first, then $metadata-only,
  // then custom-only names; keys are lower case.
  function mapOf(rows, csdlRows) {
    const byLower = list => { const m = new Map(); for (const r of list) if (!m.has(lower(r[0]))) m.set(lower(r[0]), r); return m; };
    const b = byLower(BUILTIN_MESSAGES), c = byLower(rows);
    const x = new Map();
    for (const r of csdlRows) {
      const k = lower(r[0]);
      if (!x.has(k)) x.set(k, []);
      x.get(k).push(r);
    }
    const map = new Map();
    for (const k of [...b.keys(), ...x.keys(), ...c.keys()]) if (!map.has(k)) map.set(k, mergeMessage(b.get(k), c.get(k), x.get(k) ?? []));
    return map;
  }

  // A messages Map, marked when a source failed (see the notes above): a non-enumerable, read-only `incomplete`
  // {source: 'messages', error}, so a name it lacks may still be a Web API message.
  function messagesMap(rows, csdlRows, error) {
    const map = mapOf(rows, csdlRows);
    if (error != null) Object.defineProperty(map, 'incomplete', { value: freeze({ source: 'messages', error }), enumerable: false });
    return map;
  }

  // Loads the full Map: the stored value, else the custom APIs and $metadata (see the notes above).
  function loadMessages() {
    const gen = generation;
    const entry = { promise: null, map: null, at: 0, failed: false };
    const finish = (rows, csdlRows, at, error) => {
      entry.map = messagesMap(rows, csdlRows ?? [], error);
      entry.at = at;
      entry.failed = error != null;
      entry.promise = null;
      // messagesSync() serves the Map the full form resolved last, complete or not
      if (gen === generation) fullMessages = entry.map;
      return entry.map;
    };
    entry.promise = (async () => {
      await null; // finish() runs after entry.promise is set
      const stored = readStoredMessages();
      if (stored) return finish(stored.rows, stored.csdl, stored.at, null);
      const [custom, scan] = await Promise.all([customRows(), loadCsdl().then(rows => ({ rows, error: null }), error => ({ rows: null, error }))]);
      if (scan.error && gen === generation) emit({ kind: 'error', error: scan.error, source: 'messages' });
      const rows = custom.value ? custom.value.rows : [];
      // $metadata's failure leaves out every message only it lists, the custom APIs' the private ones
      const error = scan.error ?? custom.error ?? null;
      // the Map lives 24 h from the custom API read; a failure is kept 30 s from now
      const at = error != null ? now() : Math.min(custom.at, now());
      if (error == null && (rows.length || scan.rows?.length) && gen === generation) {
        const value = { v: MESSAGES_VERSION, at, rows, csdl: scan.rows };
        if (custom.value.unreadable) value.customUnreadable = true;
        if (JSON.stringify(value).length <= CACHE_MAX) storeSet(KEY_MESSAGES, value);
      }
      return finish(rows, scan.rows, at, error);
    })().catch(e => {
      if (messagesCache === entry) messagesCache = null;
      throw e;
    });
    messagesCache = entry;
    return entry.promise;
  }

  // Web API messages: BUILTIN_MESSAGES, the custom APIs and the Functions and Actions of $metadata, keyed by lower-case
  // name (cached 24 h). When a source cannot be read, the others still resolve; that Map is kept for 30 s, then the
  // next call reads again, and each failure is reported as onChange {kind: 'error', source: 'messages'}. With
  // {csdl: false} $metadata is never read: the full Map when it is loaded or stored, else BUILTIN_MESSAGES and the
  // custom APIs.
  function messages(options = {}) {
    if (options === null || typeof options !== 'object') throw new TypeError('messages: options must be an object.');
    const withCsdl = options.csdl ?? true;
    if (typeof withCsdl !== 'boolean') throw new TypeError('messages: options.csdl must be a boolean.');
    const c = messagesCache;
    const current = c && (c.promise || now() - c.at < (c.failed ? FAIL_MS : DAY));
    if (withCsdl) return current ? c.promise ?? Promise.resolve(c.map) : loadMessages();
    if (current && !c.promise) return Promise.resolve(c.map);
    if (!current) {
      // a stored value gives the full Map without a request
      const stored = readStoredMessages();
      if (stored) {
        const map = messagesMap(stored.rows, stored.csdl ?? [], null);
        messagesCache = { promise: null, map, at: stored.at, failed: false };
        fullMessages = map;
        return Promise.resolve(map);
      }
    }
    return customRows().then(entry => {
      if (partialMessages?.from !== entry) partialMessages = { from: entry, map: messagesMap(entry.value ? entry.value.rows : [], [], entry.error) };
      return partialMessages.map;
    });
  }

  // ----- FetchXML lookups (CreateMultiple tables, recycle bin, currencies) ---------------------------------

  async function fetchAll(entitySet, xml) {
    const rows = [];
    let cookie = null, last = null;
    for (let page = 1; ; page++) {
      if (page > PAGE_LIMIT) throw new DataverseError(`Reading ${entitySet} did not end after ${PAGE_LIMIT} pages.`, { code: 'paging' });
      const head = `<fetch count="5000" page="${page}"` + (cookie ? ` paging-cookie="${xmlEsc(cookie)}"` : '');
      const j = await fetchXml(entitySet, head + xml.slice('<fetch'.length));
      if (Array.isArray(j?.value)) rows.push(...j.value);
      if (j?.['@Microsoft.Dynamics.CRM.morerecords'] !== true) break;
      const ann = j['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie'];
      cookie = null;
      if (typeof ann === 'string' && ann) {
        const raw = parseXml(ann).attrs.get('pagingcookie');
        if (raw) cookie = decodeURIComponent(decodeURIComponent(raw));
      }
      if (cookie != null && cookie === last) throw new DataverseError('Paging did not advance; the query was stopped to avoid duplicate rows.', { code: 'paging' });
      last = cookie;
    }
    return rows;
  }
  const softSet = load => load().catch(e => { if (isPrivilegeError(e)) return freeze(new Set()); throw e; });

  // Tables for which sdkmessagefilter lists CreateMultiple (cached per session; empty on a privilege error; another
  // failure is kept 30 s).
  function createMultipleTables() {
    const xml = '<fetch><entity name="sdkmessagefilter"><attribute name="primaryobjecttypecode"/><link-entity name="sdkmessage" from="sdkmessageid" ' +
      'to="sdkmessageid" link-type="inner"><filter><condition attribute="name" operator="eq" value="CreateMultiple"/></filter></link-entity></entity></fetch>';
    return shared(sessionJobs, 'createMultipleTables', () => softSet(async () => {
      const rows = await fetchAll(setOf('sdkmessagefilter'), xml);
      return new Set(rows.map(r => r.primaryobjecttypecode).filter(v => typeof v === 'string' && v && v !== 'none').map(lower));
    }));
  }

  // Tables with an active recycle bin (cached per session; empty on a privilege error; another failure is kept 30 s,
  // so completion asking for bin. tables never re-sends a failing query on every keystroke).
  function recycleBin() {
    const xml = '<fetch><entity name="recyclebinconfig"><attribute name="recyclebinconfigid"/><filter><condition attribute="statecode" operator="eq" value="0"/>' +
      '<condition attribute="isreadyforrecyclebin" operator="eq" value="1"/></filter><link-entity name="entity" from="entityid" to="extensionofrecordid" ' +
      'link-type="inner" alias="e"><attribute name="logicalname"/></link-entity></entity></fetch>';
    return shared(sessionJobs, 'recycleBin', () => softSet(async () => {
      const rows = await fetchAll(setOf('recyclebinconfig'), xml);
      return new Set(rows.map(r => r['e.logicalname']).filter(v => typeof v === 'string' && v).map(lower));
    }));
  }

  // 1 or 2: whether more than one transactioncurrency exists (cached per session, 02 §4.5).
  function currencyCount() {
    if (!currencyPromise) {
      currencyPromise = fetchXml(setOf('transactioncurrency'), '<fetch top="2"><entity name="transactioncurrency"><attribute name="transactioncurrencyid"/></entity></fetch>')
        .then(j => ((Array.isArray(j?.value) ? j.value.length : 0) >= 2 ? 2 : 1), e => { currencyPromise = null; throw e; });
    }
    return currencyPromise.catch(rethrowCopy);
  }

  // Whether a user holds the System Administrator role, directly (systemuserroles) or through a team
  // (teammembership -> teamroles): two top="1" FetchXML queries in parallel, cached per user for the session; false
  // on a privilege error (02 §2).
  function isSystemAdministrator(userId) {
    if (!isGuid(userId)) return Promise.reject(new TypeError(`isSystemAdministrator: '${userId}' is not a GUID.`));
    const id = lower(userId);
    const role = '<fetch top="1"><entity name="role"><attribute name="roleid"/><filter><condition attribute="roletemplateid" operator="eq" value="' + SYSADMIN_TEMPLATE + '"/></filter>';
    const user = `<filter><condition attribute="systemuserid" operator="eq" value="${id}"/></filter>`;
    const direct = role + `<link-entity name="systemuserroles" from="roleid" to="roleid" intersect="true">${user}</link-entity></entity></fetch>`;
    const viaTeam = role + '<link-entity name="teamroles" from="roleid" to="roleid" intersect="true"><link-entity name="team" from="teamid" to="teamid">' +
      `<link-entity name="teammembership" from="teamid" to="teamid" intersect="true">${user}</link-entity></link-entity></link-entity></entity></fetch>`;
    return shared(sessionJobs, `isSystemAdministrator:${id}`, async () => {
      const answers = await Promise.allSettled([fetchXml(setOf('role'), direct), fetchXml(setOf('role'), viaTeam)]);
      if (answers.some(a => a.status === 'fulfilled' && Array.isArray(a.value?.value) && a.value.value.length > 0)) return true;
      const failed = answers.find(a => a.status === 'rejected' && !isPrivilegeError(a.reason));
      if (failed) throw failed.reason;
      return false;
    });
  }

  // ----- misc ----------------------------------------------------------------------------------------------

  // Did-you-mean over candidates (default: the table names), through util.suggest.
  function suggestNames(name, candidates) {
    return didYouMean(String(name ?? ''), candidates ?? tableCandidates(), 3);
  }

  // Drops every cache (memory and stored) and reloads the table list.
  async function refresh() {
    generation++;
    loaded.clear(); loadedLang.clear(); jobs.clear(); probes.clear(); rels.clear(); opts.clear(); keyCache.clear();
    sessionJobs.clear();
    messagesCache = null; fullMessages = null; customCache = null; partialMessages = null; currencyPromise = null; listJob = null;
    storeDel(KEY_ENTITIES);
    storeDel(KEY_MESSAGES);
    await fetchList(currentLang());
    emit({ kind: 'refresh' });
  }

  return freeze({
    init,
    get user() { return user; },
    get org() { return org; },
    get lang() { return currentLang(); },
    get tzMatchesBrowser() { return tzMatch; },
    // The table list (sync; [] before init).
    entities() { return list; },
    findEntity,
    entity,
    entitySync,
    relationships,
    relationshipsSync,
    options,
    optionsSync,
    keys,
    globalOptionSets,
    messages,
    // The Map messages() (the full form) resolved last, complete or marked incomplete, or null (sync; see the notes above).
    messagesSync() { return fullMessages; },
    createMultipleTables,
    recycleBin,
    currencyCount,
    isSystemAdministrator,
    suggest: suggestNames,
    // The 02 §2 env object of a RetrieveCurrentOrganization Detail; url falls back to this origin.
    toEnv(detail) { return toEnv(detail, typeof api.origin === 'string' ? api.origin : null); },
    refresh,
    // Subscribes to metadata changes; returns the unsubscribe function.
    onChange(cb) {
      if (typeof cb !== 'function') throw new TypeError('onChange: a function is required.');
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  });
}
