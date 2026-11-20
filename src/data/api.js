// HTTP client for the Dataverse Web API (02 §1, §8.1, §8.3; 00 §5 rules 1, 2, 4, 5, 6,
// 9). The only network channel of SQL Studio: every request goes to this origin's /api/data/v9.2/, built here from
// validated parts. api.js alone owns read-only mode, the acting user (MSCRMCallerID), grants, write batching (incl.
// $batch change sets and the adaptive batch size), CreateMultiple (with its bisection), BulkDelete job ops,
// throttling and stop. Pure and DOM-free.
//
// Notes:
// - Action ops: an entity set or a record id needs its table (entity), so the key names the concrete table of
//   the record an op is about; `bound: 'collection'` refuses a record id; any other `bound` value, and `bound` on
//   another kind, is refused. `partitionId` is accepted only on create, update and delete (the kinds that use it),
//   so every op means exactly one request.
// - A grant never holds one request twice: two ops with the same fingerprint are refused at createGrant (`Blocked:
//   write op <n> repeats a request of the same statement.`), and so are two ops of another kind with the same key.
//   Action ops may share a key when their requests differ (one BulkDelete job per 20,000 ids of a table, one
//   AddMemberList or RemoveMemberList per member of a list, one GrantAccess, ModifyAccess or RevokeAccess per
//   principal of a record): the grant keeps one record per key and fingerprint (below), and 02 §8.3's
//   "not already sent" holds per record, so each of them can be sent once.
// - Change sets (02 §1 $batch): `changeSet` is a string of 1 to 200 characters without control characters or
//   lone surrogates; the ops of one change set are consecutive in op order and at most 1,000. `step` (an integer
//   0-999) needs a changeSet and a record id, and when one op of a record in a change set carries a step, every op of
//   that record in it does, numbered 0, 1, … in op order (else `Blocked: write op <n> …`). At write time a change set
//   is sent whole: exactly
//   its granted requests, consecutive and in the granted order, else `Blocked: request differs from the confirmed
//   preview` (so a step-1 PATCH with If-Match `*` never goes without its step-0 op). A change set is never sent by
//   CreateMultiple. When beforeBatch skips one op of a change set, every op of it is skipped (reason 'etag').
// - The answer to a change set decides all of its ops alike, as the set is atomic: a 2xx part for every op gives
//   each op its part's result. Otherwise the failing part decides: all parts 429 or 0x80048105 re-send the whole
//   set; throttled parts beside committed ones, or a 5xx part, make every op 'unknown'; an expired session (401)
//   fails every op and stops the write; any other error is judged by the rules of the op it answers (a skip: 412
//   'etag', 404 'missing', a duplicate under IGNORE_DUP_KEY; else 'failed' with its message) and applied to every op.
//   When the answer does not say which op a failing part answers (no Content-ID in a set of several ops), that
//   outcome is used only when it is the same for every op of the set, else every op is 'failed' with the part's
//   message.
// - $batch answers are matched part by part: parts with a Content-ID by it, and the items without one (Microsoft
//   documents Content-IDs inside change sets only) by position to the request items no Content-ID answered, only
//   when their counts agree; anything else makes every op of the batch 'unknown'.
// - IGNORE_DUP_KEY: a grant whose options carry ignoreDupKey (a boolean) decides it; a write option ignoreDupKey
//   that differs from it is `Blocked: request differs from the confirmed preview` (the confirmed preview fixes it,
//   02 §8.2). Without it in the grant the write option applies (02 §8.3). A write option that is not a boolean (or
//   null) is a TypeError.
// - Elastic CreateMultiple failures (02 §8.1 INSERT): a BulkApiErrorDetails entry names its target by RequestIndex
//   (0-based) and, when it has one, by Id, which must be that target's client id (case-insensitive); an entry with
//   an Id and no RequestIndex names the target with that id. Any disagreement, an Id that is no GUID or names no
//   target, or a target named twice, makes every op of the request 'unknown'.
// - checkVersion is accepted only on an action op with a record id: a non-negative integer (a number, a bigint
//   or a string of up to 20 digits), fingerprinted as its decimal text. beforeBatch's input includes these action
//   ops (02 §8.1 step 8), which 02 §8.3 still words as "the update and delete WriteOps".
// - BulkDelete: createGrant accepts only the 02 §8.1 DELETE job op, checked field by field (no `bound`, record
//   id, changeSet, step or checkVersion); the condition's attribute is `pk = op.pk`, else '<entity>id', so dml.js
//   passes `pk` for tables such as task, whose key is activityid, and JobName's k of n has 1 ≤ k ≤ n. Any other
//   BulkDelete op keeps the EXEC refusal text, or names what is wrong (`Blocked: write op <n> is not a BulkDelete job
//   of exactly its previewed ids (…).`). The jobs of one grant have distinct JobNames (the step-9 lookup relies on
//   it) and select disjoint ids of a table (each previewed record in exactly one job), else `Blocked: write op <n> …`
//   at createGrant. A 2xx answer without a GUID JobId makes the op 'unknown'; the parsed answer is in `json`.
//   `api.findBulkDeleteJob(jobName, since, {signal, inBody}) -> {id, statecode, statuscode} | null`
//   (a member 02 §1 does not list yet) is the 02 §8.1 step 9 lookup: one FetchXML read (top 10) on asyncoperation
//   (name eq jobName, operationtype eq 13, createdon ge `since` truncated to the second, because Dataverse stores
//   createdon to the second), sent in the request body when `inBody` is true (dml.js passes the setting, 00 §5 rule
//   6); null unless exactly one of the rows has exactly that name (Dataverse's eq ignores case and trailing spaces)
//   and fewer than 10 rows came back.
// - WriteOp fields a kind does not use (02 §1): `relatedSet` is refused on a disassociate (its URL has none) and
//   `pk` on every op but create, update, delete and the BulkDelete job op. If-Match, partitionId and changeSet must
//   not hold a lone surrogate (no request can carry one, and UTF-8 would turn every one into U+FFFD), and a body
//   whose toJSON gives no JSON object is refused like any other non-object body.
// - The grant's request records (02 §8.3): the grant keeps, per op, not the key and fingerprint strings
//   but the SHA-256 digest of the key (the 02 §8.3 JSON array of the key fields) followed by the 32 bytes of the
//   SHA-256 digest of the fingerprint: method, the URL relative to this api's fixed base, If-Match, changeSet,
//   checkVersion and the canonical body (keys sorted; the sent text itself when its keys are in order), each as
//   `<length>:<text>` ('-' when absent). SHA-256 is collision resistant, so a request matches a record exactly when
//   its key and fingerprint do. The granted option headers are kept once in the grant and every request of it is
//   sent with exactly them, so they are not repeated per op. A grant of 250,000 ops keeps about 17 MB (about 70
//   bytes per op) whatever the bodies. At write time each checked request's record leaves the consumed grant ("not
//   already sent"), and only what a request needs is kept per op (a CreateMultiple target is built when its chunk
//   is sent). `sha256(text)` (hex) is exported.
// - write's validation pass is asynchronous: after every 16 ms of work it lets the event loop run
//   (scheduler.postTask where the browser has it, else a timer task), sends nothing before the pass ends, and checks
//   the acting user and the changes window again after it, so a caller change or the end of the window during the
//   pass refuses the write (`Blocked: …`) before anything is sent. createGrant stays synchronous as 02 §8.3 defines
//   it; at 250,000 ops it takes about 1.5 s (updates) to 2.5 s (450-byte creates) of CPU on a desktop. An
//   asynchronous or sliced createGrant would end that pause in the confirm click (02 §8.3 and
//   dialogs.js's confirm handler would change).
// - Write options: `continueOnError` must be a boolean (null and undefined count as false), and `createMultiple`
//   undefined, null or {chunk: an integer 1-1000, elastic?: boolean}; anything else is a TypeError thrown before the
//   grant is looked at (02 §8.3), and a well-formed value that is not the grant's is `Blocked: request differs …`.
// - Action parts carry `Prefer: odata.include-annotations="*"` (02 §1 lists Prefer for GET parts only):
//   an action's answer becomes result sets by the 02 §9 response shapes, whose entities are mapped by 02 §5 with
//   their formatted values and lookup targets. It changes nothing that is written, and it is the same for every
//   action op, so the op kind in the key binds it.
// - fn() always sends `Prefer: odata.include-annotations="*"` (02 §9 shape (a) maps entities by 02 §5), and builds
//   its URL as fetchXml does: above 16,000 characters the same GET goes inside a `$batch` (its part carries the
//   Prefer header), above 64,000 nothing is sent (DataverseError code 'toolong'). fn has no inBody option (00 §5
//   rule 6 names FetchXML GETs).
// - batchGet sends its `$batch` requests of 100 paths concurrently through the read queue (at most dop at a time),
//   and the first failure rejects the call and aborts the others.
// - CreateMultiple requests are closed at the exact body size: at most 16 MiB (16,777,216 bytes) of UTF-8, the
//   targets with the commas between them.
// - Adaptive batch size (02 §8.1 step 8): `current` is the number of ops the request carried. A whole answer
//   that is not multipart halves the size for 502/503/504 or 0x80044151 and leaves it otherwise (429 and 0x80048105
//   included: nothing ran); a multipart answer resizes it by the duration rule, or halves it when a part answered
//   502/503/504 or 0x80044151; a request lost to the write timeout halves it and a network error leaves it. Single
//   creates of a bisection or of the CreateMultiple fallback are $batch requests like any other; the halves of a
//   bisection leave the CreateMultiple size alone. onProgress's `batchSize` is the size of the transport the last
//   answered request used (the $batch size, or the CreateMultiple size).
// - csdl(): the read slot is held while the body streams, stats.bytes counts the received bytes, a 2xx answer
//   without a readable body stream is yielded as one chunk, and a body that fails while it streams rejects the
//   iteration with DataverseError code 'network' (never re-read: text was already yielded).

import { xmlEsc } from '../core/xml.js';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_SEGMENT_RE = /^\$?[A-Za-z_][A-Za-z0-9_.]*(\(.*\))?$/;
const RAW_BAD_RE = /[\s\x00-\x1f]/;
const PATH_BAD_RE = /[\s\x00-\x1f\x7f\\#]/;
const HEADER_BAD_RE = /[\x00-\x1f\x7f]/;
// A lone surrogate, which neither a URL nor UTF-8 text can carry.
const LONE_SURROGATE_RE = /\p{Cs}/u;
const ETAG_RE = /^(\*|(W\/)?"[^"\x00-\x1f\x7f]*")$/;
const CHANGESET_RE = /^[^\x00-\x1f\x7f]{1,200}$/;
const VERSION_RE = /^\d{1,20}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$/;
const JOB_TAIL_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \((\d{1,6}) of (\d{1,6})\)$/;
const NS = 'Microsoft.Dynamics.CRM.';
const AUTH_MESSAGE = 'Your Dataverse session has expired. Reload the page, sign in, then run the query again.';
const MAX_GET_URL = 16000;
const MAX_BATCH_URL = 64000;
const RETRIES = 8;
const RETRY_AFTER_DEFAULT = 5;
const RETRY_AFTER_CAP = 120;
const CONCURRENT_WAIT_MS = 2000;
const BACKOFF_S = [1, 2, 4, 8];
const NETWORK_RETRIES = 2;
const BATCH_REREADS = 2;
const CONCURRENT = '0x80048105';
const DUPLICATE = '0x80040237';
const VERSION_MISMATCH = '0x80060882';
const TIMEOUT_FAULT = '0x80044151';
const GRANT_TTL_MS = 600000;
const IDLE_MS = 1800000;
const MAX_TIMER_MS = 2147483647;
const CM_MAX_BYTES = 16 * 1024 * 1024;
const BATCH_GET_MAX = 100;
const BATCH_PARTS_MAX = 1000;
const DOP_DEFAULT = 4;
const DOP_MAX = 32;
const BATCH_TARGET_MS = 10000;
const STEP_MAX = 999;
const BULK_DELETE_MAX = 20000;
const JOB_LOOKUP_MAX = 10;
// api.write's validation pass lets the event loop run whenever it has worked this many milliseconds since it last did.
const VALIDATE_SLICE_MS = 16;
const WRITE_KINDS = new Set(['create', 'update', 'delete', 'associate', 'disassociate', 'action']);
const METHOD = { create: 'POST', update: 'PATCH', delete: 'DELETE', associate: 'POST', disassociate: 'DELETE', action: 'POST' };
const GET_HEADERS = new Map([['prefer', 'Prefer'], ['if-none-match', 'If-None-Match'], ['consistency', 'Consistency'], ['mscrm.sessiontoken', 'MSCRM.SessionToken']]);
// Messages that change records the preview cannot show (02 §8.1 EXEC): never sent as an action op (BulkDelete only as
// the job op of a DELETE preview).
const REFUSED_ACTIONS = new Set(('create,update,delete,upsert,createmultiple,updatemultiple,upsertmultiple,deletemultiple,executemultiple,' +
  'executetransaction,bulkdelete,merge,assign,setstate,associate,disassociate,importsolution,importsolutionasync,uninstallsolution,' +
  'deleteandpromote').split(','));
// Granted option headers (02 §8.1 hints), in name order.
const OPTION_HEADERS = [
  ['bypassLogic', 'MSCRM.BypassBusinessLogicExecution', 'CustomSync,CustomAsync'],
  ['bypassPlugins', 'MSCRM.BypassCustomPluginExecution', 'true'],
  ['suppressFlows', 'MSCRM.SuppressCallbackRegistrationExpanderJob', 'true'],
  ['suppressDuplicateDetection', 'MSCRM.SuppressDuplicateDetection', 'true'],
].sort((a, b) => (a[1] < b[1] ? -1 : 1));
const PERSONAL_CREATE_KEYS = new Set(['userqueryid', 'name', 'description', 'returnedtypecode', 'fetchxml', 'layoutxml', 'querytype']);
const PERSONAL_CREATE_REQUIRED = ['userqueryid', 'name', 'returnedtypecode', 'fetchxml', 'layoutxml', 'querytype'];
const PERSONAL_UPDATE_KEYS = new Set(['fetchxml', 'layoutxml', 'description']);
const BULK_DETAILS = '@Microsoft.PowerApps.CDS.ErrorDetails.BulkApiErrorDetails';
// The body of a BulkDelete job op (02 §8.1 DELETE), keys in sorted order.
const BULK_DELETE_KEYS = 'CCRecipients,JobName,QuerySet,RecurrencePattern,SendEmailNotification,StartDateTime,ToRecipients';

// A Dataverse fault or an internal refusal: code is '0x' + 8 lower-case hex digits for faults, else a word.
export class DataverseError extends Error {
  constructor(message, { code = null, status = null, requestId = null, details = null } = {}) {
    super(message);
    this.name = 'DataverseError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }
}

// A typed function-parameter literal (guidParam / enumParam); its text is written into the alias as is.
class ODataLiteral {
  constructor(text) { this.text = text; Object.freeze(this); }
}

// A Guid function parameter, written as a bare GUID literal.
export function guidParam(id) {
  if (!isGuid(id)) throw new TypeError(`guidParam: '${id}' is not a GUID.`);
  return new ODataLiteral(String(id).toLowerCase());
}

// An enum function parameter, written as Type'Member' (e.g. Microsoft.Dynamics.CRM.EndpointAccessType'Default').
export function enumParam(type, member) {
  if (typeof type !== 'string' || !SEGMENT_RE.test(type)) throw new TypeError(`enumParam: invalid enum type '${type}'.`);
  if (typeof member !== 'string' || !IDENT_RE.test(member)) throw new TypeError(`enumParam: invalid enum member '${member}'.`);
  return new ODataLiteral(`${type}'${member}'`);
}

// True for a GUID without braces (any case).
export function isGuid(s) {
  return typeof s === 'string' && GUID_RE.test(s);
}

// True for a valid entity set, navigation property, function or action name (02 §1 URL rules).
export function isSegment(s) {
  return typeof s === 'string' && SEGMENT_RE.test(s);
}

// The 02 §2 table kind: 'elastic' for TableType Elastic, 'virtual' for Virtual or any DataProviderId, else 'standard'.
export function tableKind(tableType, dataProviderId) {
  return tableType === 'Elastic' ? 'elastic' : tableType === 'Virtual' || dataProviderId ? 'virtual' : 'standard';
}

// An OData string literal ('…' with quotes doubled), URI-encoded for a URL.
export function odataString(s) {
  return encodeURIComponent(`'${String(s).replace(/'/g, "''")}'`);
}

// Normalises a Dataverse error code (hex string or signed/unsigned decimal) to '0x' + 8 lower-case hex digits.
export function faultCode(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Number.isInteger(raw) && raw >= -2147483648 && raw <= 4294967295 ? '0x' + (raw >>> 0).toString(16).padStart(8, '0') : null;
  const s = String(raw).trim();
  if (/^0x[0-9a-f]{1,8}$/i.test(s)) return '0x' + s.slice(2).toLowerCase().padStart(8, '0');
  if (/^-?\d{1,10}$/.test(s)) return faultCode(Number(s));
  return null;
}

// Cuts stack-like tails from a server message (after CRLF, ' orgIndex:' or '   at ').
export function trimMessage(m) {
  let s = String(m ?? '');
  for (const cut of ['\r\n', ' orgIndex:', '   at ']) {
    const i = s.indexOf(cut);
    if (i >= 0) s = s.slice(0, i);
  }
  return s.trim();
}

const blocked = reason => new DataverseError(`Blocked: ${reason}`, { code: 'blocked' });
const DIFFERS = 'request differs from the confirmed preview';
const NO_IF_MATCH = 'update/delete without If-Match';
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
const lower = s => String(s).toLowerCase();
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keysOf = v => Object.keys(v).sort().join(',');

class NetFail extends Error {
  constructor(kind, cause) {
    super(kind === 'timeout' ? 'timeout' : String(cause?.message ?? cause ?? 'network error'));
    this.kind = kind;
  }
}

function utf8Length(s) {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c >= 0xd800 && c <= 0xdbff) { n += 2; i++; } else if (c > 0x7ff) n += 2; else n += 1;
  }
  return n;
}

// Canonical JSON (keys sorted at every level) of a JSON value; the grant fingerprint's body form.
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}

// Whether every object of a parsed JSON value lists its keys in sorted order: then the JSON text it was parsed from
// is already its canonical form (no second copy of the body is built).
function sortedDeep(v) {
  if (v === null || typeof v !== 'object') return true;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (!sortedDeep(v[i])) return false;
    return true;
  }
  const keys = Object.keys(v);
  for (let i = 0; i < keys.length; i++) {
    if (i && !(keys[i - 1] < keys[i])) return false;
    if (!sortedDeep(v[keys[i]])) return false;
  }
  return true;
}

// SHA-256 (FIPS 180-4) round constants.
const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA_BUF_KEEP = 1 << 20;
// The encoder, message buffer, schedule and state of the SHA-256 runs, made on first use (module top levels only
// define, 00 §4).
let shaState = null;

// One SHA-256 run (FIPS 180-4) over the UTF-8 bytes of a well-formed string (no lone surrogates, which UTF-8 cannot
// hold) followed by the raw bytes `tail` (or none); leaves the 8 digest words in shaState.h.
function shaRun(s, tail) {
  if (!shaState) {
    shaState = { enc: new TextEncoder(), buf: new Uint8Array(65536), w: new Int32Array(64), k: Int32Array.from(SHA_K), h: new Int32Array(8), tail: new Uint8Array(32) };
  }
  const st = shaState;
  const extra = tail ? tail.length : 0;
  if (st.buf.length < s.length * 3 + extra + 72) st.buf = new Uint8Array(s.length * 3 + extra + 72);
  const buf = st.buf, w = st.w, K = st.k;
  let n = st.enc.encodeInto(s, buf).written;
  if (tail) { buf.set(tail, n); n += extra; }
  // padding: 0x80, zeros, the bit length as a 64-bit big-endian number
  const total = (n + 72) & ~63;
  buf[n] = 0x80;
  buf.fill(0, n + 1, total);
  const hi = Math.floor(n / 0x20000000), lo = (n % 0x20000000) * 8;
  buf[total - 8] = hi >>> 24; buf[total - 7] = hi >>> 16; buf[total - 6] = hi >>> 8; buf[total - 5] = hi;
  buf[total - 4] = lo >>> 24; buf[total - 3] = lo >>> 16; buf[total - 2] = lo >>> 8; buf[total - 1] = lo;
  let h0 = 0x6a09e667, h1 = 0xbb67ae85 | 0, h2 = 0x3c6ef372, h3 = 0xa54ff53a | 0, h4 = 0x510e527f, h5 = 0x9b05688c | 0, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  for (let off = 0; off < total; off += 64) {
    for (let i = 0, j = off; i < 16; i++, j += 4) w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (s0 + s1 + w[i - 16] + w[i - 7]) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  // a buffer grown for one large body is not kept
  if (buf.length > SHA_BUF_KEEP) st.buf = new Uint8Array(65536);
  const H = st.h;
  H[0] = h0; H[1] = h1; H[2] = h2; H[3] = h3; H[4] = h4; H[5] = h5; H[6] = h6; H[7] = h7;
}
// The digest of the last run as 16 UTF-16 code units (each two bytes of it): a compact Set key, never encoded again.
function shaKey() {
  const h = shaState.h;
  return String.fromCharCode(h[0] >>> 16, h[0] & 0xffff, h[1] >>> 16, h[1] & 0xffff, h[2] >>> 16, h[2] & 0xffff, h[3] >>> 16, h[3] & 0xffff,
    h[4] >>> 16, h[4] & 0xffff, h[5] >>> 16, h[5] & 0xffff, h[6] >>> 16, h[6] & 0xffff, h[7] >>> 16, h[7] & 0xffff);
}
// The digest of the last run as 32 raw bytes (shaState.tail), to be hashed on as the tail of another run.
function shaBytes() {
  const { h, tail } = shaState;
  for (let i = 0; i < 8; i++) { const v = h[i]; tail[i * 4] = v >>> 24; tail[i * 4 + 1] = v >>> 16; tail[i * 4 + 2] = v >>> 8; tail[i * 4 + 3] = v; }
  return tail;
}

// SHA-256 of the UTF-8 text of a well-formed string, as 64 lower-case hex digits (the digest of the grant's request
// records, 02 §8.3, see the notes above).
export function sha256(text) {
  shaRun(String(text), null);
  return Array.from(shaState.h, v => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

// The decimal text of a checkVersion value (a non-negative integer as a number, bigint or digit string), else null.
function versionText(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  if (typeof v === 'bigint') return v >= 0n ? v.toString() : null;
  if (typeof v === 'string' && VERSION_RE.test(v)) return BigInt(v).toString();
  return null;
}

// Whether an answer status or fault code is a timeout of the server (02 §8.1 step 8: halves the batch size).
const timeoutLike = (status, code) => status === 502 || status === 503 || status === 504 || code === TIMEOUT_FAULT;

function defaultWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

// Lets the event loop run, so a long pass does not freeze the page: a scheduler task where the browser has one (Edge;
// not clamped like nested timers), else a timer task.
const macrotask = () => new Promise(resolve => {
  const s = globalThis.scheduler;
  if (typeof s?.postTask === 'function') s.postTask(resolve, { priority: 'user-visible' });
  else setTimeout(resolve, 0);
});

const headerGet = (h, name) => (typeof h?.get === 'function' ? h.get(name) : null);

// HTTP-date forms (RFC 9110 §5.6.7): IMF-fixdate, the obsolete RFC 850 form (two-digit year) and asctime. They are
// parsed here, never with Date.parse, which reads '-5', '+5', '.5' or '5.' as dates in 2001.
const MONTHS = 'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec'.split(',');
const IMF_DATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const RFC850_DATE_RE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME_DATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

// Milliseconds of an HTTP-date, or NaN when the text is not one; `ref` (ms) places an RFC 850 two-digit year.
function httpDate(t, ref) {
  let day, mon, year, hh, mm, ss, m;
  if ((m = IMF_DATE_RE.exec(t))) [, day, mon, year, hh, mm, ss] = m;
  else if ((m = ASCTIME_DATE_RE.exec(t))) [, mon, day, hh, mm, ss, year] = m;
  else if ((m = RFC850_DATE_RE.exec(t))) {
    [, day, mon, year, hh, mm, ss] = m;
    // RFC 9110: the year with those last two digits nearest to `ref`'s, where one more than 50 years ahead is the
    // most recent past year with those digits (so '00' in 2099 is 2100, '80' in 2026 is 1980)
    const cur = new Date(ref).getUTCFullYear();
    let y = Math.floor(cur / 100) * 100 + Number(year);
    if (y > cur + 50) y -= 100;
    else if (y <= cur - 50) y += 100;
    year = y;
  } else return NaN;
  const mi = MONTHS.indexOf(mon);
  const [d, H, M, S] = [day, hh, mm, ss].map(x => Number(String(x).trim()));
  if (mi < 0 || H > 23 || M > 59 || S > 59) return NaN;
  const ms = Date.UTC(Number(year), mi, d, H, M, S);
  return new Date(ms).getUTCDate() === d && new Date(ms).getUTCMonth() === mi ? ms : NaN;
}

// When an answer was sent: its Date header (the server's clock), else `fallback` (ms).
function sentAt(h, fallback) {
  const raw = headerGet(h, 'date');
  const ms = raw == null ? NaN : httpDate(String(raw).trim(), fallback);
  return Number.isNaN(ms) ? fallback : ms;
}

// Seconds a 429 asks to wait: Retry-After delay-seconds, or an HTTP-date measured against the answer's Date header
// (else against `ref`, the time the answer is taken to have been sent); default 5, cap 120.
function retryAfterSeconds(h, ref) {
  const raw = headerGet(h, 'retry-after');
  if (raw == null || raw === '') return RETRY_AFTER_DEFAULT;
  const t = String(raw).trim();
  let s = /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  if (Number.isNaN(s)) {
    const at = httpDate(t, ref);
    if (!Number.isNaN(at)) s = Math.ceil((at - sentAt(h, ref)) / 1000);
  }
  if (!Number.isFinite(s)) s = RETRY_AFTER_DEFAULT;
  return Math.min(RETRY_AFTER_CAP, Math.max(0, s));
}

function requestIdOf(h) {
  return headerGet(h, 'x-ms-service-request-id') ?? headerGet(h, 'req_id') ?? null;
}

function tryJson(text) {
  if (text == null || text === '') return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

// DataverseError for a non-2xx answer (top-level response or $batch part): {status, statusText, headers, text}.
function errorOf(r) {
  const requestId = requestIdOf(r.headers);
  if (r.type === 'opaqueredirect' || r.status === 401) return new DataverseError(AUTH_MESSAGE, { code: 'auth', status: r.status || 401, requestId });
  const json = tryJson(r.text);
  const e = json && typeof json === 'object' ? json.error : null;
  if (e && typeof e === 'object') {
    const code = faultCode(e.code);
    const message = trimMessage(e.message) || `Dataverse answered HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}.`;
    return new DataverseError(message, { code, status: r.status, requestId, details: e });
  }
  const what = r.statusText ? `${r.status} ${r.statusText}` : String(r.status);
  return new DataverseError(`Dataverse answered HTTP ${what} without a Dataverse error.`, {
    code: 'notjson', status: r.status, requestId, details: { notJson: true, text: String(r.text ?? '').slice(0, 500) },
  });
}

// Parses a 2xx body (empty -> null); a body that is not JSON is DataverseError 'notjson'.
function jsonOf(r) {
  if (r.status === 204 || r.status === 304 || r.text == null || r.text === '') return null;
  try { return JSON.parse(r.text); } catch {
    throw new DataverseError('Dataverse answered with a body that is not JSON. Open SQL Studio on a model-driven app page of a Dataverse environment.', {
      code: 'notjson', status: r.status, requestId: requestIdOf(r.headers), details: { notJson: true, text: String(r.text).slice(0, 500) },
    });
  }
}

// ----- multipart ($batch) ------------------------------------------------------------------------------

function boundaryOf(contentType) {
  const m = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  return m ? m[1] ?? m[2] : null;
}

// The lines of one $batch request part (02 §1 $batch): its MIME headers, the request line, its own headers, the body.
function partLines(out, boundary, p) {
  out.push(`--${boundary}`, 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${p.contentId}`, '', `${p.method} ${p.href} HTTP/1.1`);
  for (const [k, v] of p.headers) out.push(`${k}: ${v}`);
  out.push('', p.body ?? '');
}

// Request body of a $batch: CRLF lines, each part with its own headers; a unit with `set` parts is one change set
// (a nested multipart/mixed part, 02 §1 change sets).
function batchBody(boundary, units) {
  const out = [];
  for (const u of units) {
    if (!u.set) { partLines(out, boundary, u.part); continue; }
    const cs = 'changeset_' + crypto.randomUUID();
    out.push(`--${boundary}`, `Content-Type: multipart/mixed;boundary=${cs}`, '');
    for (const p of u.set) partLines(out, cs, p);
    out.push(`--${cs}--`);
  }
  out.push(`--${boundary}--`, '');
  return out.join('\r\n');
}

function parseHeaderLines(lines) {
  const h = new Map();
  for (const line of lines) {
    const c = line.indexOf(':');
    if (c <= 0) return null;
    h.set(line.slice(0, c).trim().toLowerCase(), line.slice(c + 1).trim());
  }
  return h;
}

function splitMultipart(lines, boundary) {
  const delim = '--' + boundary;
  const parts = [];
  let cur = null, closed = false;
  for (const line of lines) {
    const t = line.trimEnd();
    if (t === delim) { if (cur) parts.push(cur); cur = []; continue; }
    if (t === delim + '--') { if (cur) parts.push(cur); cur = null; closed = true; break; }
    if (cur) cur.push(line);
  }
  if (!closed) return null;
  return parts;
}

// One application/http response part {contentId, status, statusText, headers, text}, or null when it cannot be read.
function httpPart(mime, rest) {
  if (!/^application\/http/i.test(mime.get('content-type') ?? '')) return null;
  const m = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/.exec((rest[0] ?? '').trim());
  if (!m) return null;
  const hb = rest.indexOf('', 1);
  const headers = parseHeaderLines(hb < 0 ? rest.slice(1) : rest.slice(1, hb));
  if (!headers) return null;
  const bodyLines = hb < 0 ? [] : rest.slice(hb + 1);
  while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();
  return {
    contentId: mime.get('content-id') ?? headers.get('content-id') ?? null,
    status: Number(m[1]), statusText: m[2] ?? '', headers: { get: n => headers.get(lower(n)) ?? null }, text: bodyLines.join('\r\n'),
  };
}

// Splits a $batch response into its top-level items: {part} or {set: parts} (a change set answered by a nested
// multipart part); null when it cannot be read.
function parseBatchTree(text, contentType) {
  const b = boundaryOf(contentType);
  if (!b || typeof text !== 'string') return null;
  const raw = splitMultipart(text.split(/\r?\n/), b);
  if (!raw) return null;
  const out = [];
  for (const lines of raw) {
    const blank = lines.indexOf('');
    if (blank < 0) return null;
    const mime = parseHeaderLines(lines.slice(0, blank));
    if (!mime) return null;
    const rest = lines.slice(blank + 1);
    const ct = mime.get('content-type') ?? '';
    if (/^multipart\/mixed/i.test(ct)) {
      const ib = boundaryOf(ct);
      const inner = ib ? splitMultipart(rest, ib) : null;
      if (!inner) return null;
      const set = [];
      for (const p of inner) {
        const pb = p.indexOf('');
        const pm = pb < 0 ? null : parseHeaderLines(p.slice(0, pb));
        const q = pm ? httpPart(pm, p.slice(pb + 1)) : null;
        if (!q) return null;
        set.push(q);
      }
      out.push({ set });
    } else {
      const q = httpPart(mime, rest);
      if (!q) return null;
      out.push({ part: q });
    }
  }
  return out;
}

// The response parts of a $batch answer in order (change sets flattened); null when it cannot be read.
function parseBatchResponse(text, contentType) {
  const tree = parseBatchTree(text, contentType);
  return tree && tree.flatMap(t => (t.set ? t.set : [t.part]));
}

// Matches response parts to request Content-IDs (by id, else by order when the counts match); null otherwise.
function matchParts(parts, ids) {
  if (!parts || parts.length !== ids.length) return null;
  if (parts.every(p => p.contentId == null)) return parts.slice();
  const byId = new Map();
  for (const p of parts) {
    if (p.contentId == null || byId.has(p.contentId)) return null;
    byId.set(p.contentId, p);
  }
  const out = ids.map(id => byId.get(id));
  return out.every(Boolean) ? out : null;
}

const isOk = p => p.status >= 200 && p.status < 300;

// Matches a write $batch answer to its request units (02 §1 $batch and change sets): one entry per unit, {part}
// for a single request (part null when an answer that stopped early has none for it), and for a change set {parts}
// (a part per op), {fail, at} (one error part for the whole set; `at` is the position of the op it answers, null
// when the answer does not say), {missing: true} (an answer that stopped early has nothing for it) or {lost: true}
// (its parts cannot be matched). Parts with a Content-ID are matched by it; the top-level items without one are
// matched by position to the units no Content-ID answered, only when their counts agree. `complete` (a 2xx answer)
// requires a part for every single request. Null when the answer cannot be matched: every op of the batch is then
// 'unknown'.
function matchWrite(tree, units, complete) {
  if (!tree) return null;
  const owner = new Map(); // Content-ID -> [unit position, op position]
  units.forEach((u, k) => u.items.forEach((it, x) => owner.set(String(it.index), [k, x])));
  const got = units.map(u => new Array(u.items.length).fill(null));
  const answered = new Array(units.length).fill(false);
  const rest = [];
  for (const t of tree) {
    const parts = t.set ? t.set : [t.part];
    const withId = parts.filter(p => p.contentId != null).length;
    if (!withId) { rest.push(t); continue; }
    if (withId !== parts.length) return null;
    for (const p of parts) {
      const o = owner.get(p.contentId);
      if (!o || got[o[0]][o[1]]) return null;
      got[o[0]][o[1]] = p;
      answered[o[0]] = true;
    }
  }
  const open = [];
  units.forEach((u, k) => { if (!answered[k]) open.push(k); });
  if (rest.length && rest.length !== open.length) return null;
  const out = new Array(units.length);
  units.forEach((u, k) => {
    if (!answered[k]) return;
    const ps = got[k];
    if (!u.set) { out[k] = { part: ps[0] }; return; }
    const present = ps.filter(Boolean);
    if (present.length === ps.length) out[k] = { parts: ps };
    else if (present.length === 1 && !isOk(present[0])) out[k] = { fail: present[0], at: ps.indexOf(present[0]) };
    else out[k] = { lost: true };
  });
  // the units no Content-ID answered: by position, one top-level item per unit (none: an answer that stopped early)
  for (let n = 0; n < open.length; n++) {
    const k = open[n], u = units[k], t = rest[n];
    const unnamed = u.items.length === 1 ? 0 : null;
    if (!t) {
      if (!u.set) { if (complete) return null; out[k] = { part: null }; } else out[k] = complete ? { lost: true } : { missing: true };
    } else if (!u.set) {
      if (t.set) return null;
      out[k] = { part: t.part };
    } else if (t.set) {
      if (t.set.length === u.items.length) out[k] = { parts: t.set };
      else if (t.set.length === 1 && !isOk(t.set[0])) out[k] = { fail: t.set[0], at: unnamed };
      else out[k] = { lost: true };
    } else if (!isOk(t.part)) out[k] = { fail: t.part, at: unnamed };
    else return null;
  }
  return out;
}

// ----- createApi -----------------------------------------------------------------------------------------

// Creates the app-wide Dataverse client: {api, writeCaps: {createGrant, setReadOnly}} (02 §1).
export function createApi({
  origin = globalThis.location?.origin, version = '9.2', fetchImpl = globalThis.window?.fetch?.bind(globalThis.window),
  wait = defaultWait, now = Date.now, writeTimeoutMs = 300000, reportError = e => queueMicrotask(() => { throw e; }),
} = {}) {
  let originUrl;
  try { originUrl = new URL(String(origin)); } catch { throw new TypeError(`createApi: invalid origin '${origin}'.`); }
  if (originUrl.origin !== origin) throw new TypeError(`createApi: '${origin}' is not an origin.`);
  if (String(version) !== '9.2') throw new TypeError(`createApi: only the Web API version 9.2 is allowed (00 §5 rule 5), not '${version}'.`);
  if (typeof fetchImpl !== 'function') throw new TypeError('createApi: fetchImpl must be a function.');
  const prefix = `/api/data/v${version}/`;
  const base = origin + prefix;

  const stats = { requests: 0, bytes: 0, throttledMs: 0 };
  let dop = DOP_DEFAULT;
  let pausedUntil = 0, pauseSeq = 0;
  let caller = null;
  let allowed = false, expiresAt = null, idleMs = IDLE_MS, timer = null;
  let writesActive = 0, windowWrites = 0;
  const modeListeners = new Set();
  const throttleListeners = new Set();
  const grants = new WeakMap();
  const sessionTokens = new Map();
  const whoAmICache = new Map();
  let readActive = 0;
  const readQueue = [];

  const report = e => { try { reportError(e); } catch { /* the reporter itself failed */ } };
  const emit = (set, payload) => { for (const fn of [...set]) { try { fn(payload); } catch (e) { report(e); } } };
  // Retry-After of an answer, or of a $batch part (whose missing Date falls back to the outer answer's, then now()).
  const retryAfter = (h, outer = null) => retryAfterSeconds(h, outer ? sentAt(outer, now()) : now());

  // ----- URLs ------------------------------------------------------------------------------------------

  function seg(name, what) {
    if (typeof name !== 'string' || !SEGMENT_RE.test(name)) throw blocked(`invalid ${what} '${String(name).slice(0, 80)}'.`);
    return name;
  }
  function ident(name, what) {
    if (typeof name !== 'string' || !IDENT_RE.test(name)) throw blocked(`invalid ${what} '${String(name).slice(0, 80)}'.`);
    return name;
  }
  function guid(id, what) {
    if (!isGuid(id)) throw blocked(`invalid ${what} '${String(id).slice(0, 80)}' (not a GUID).`);
    return id.toLowerCase();
  }
  // Resolves a path relative to /api/data/v9.2/ under the 02 §1 URL rules; returns the absolute href.
  function resolve(path) {
    const bad = () => blocked(`invalid request path '${String(path).slice(0, 120)}'.`);
    if (typeof path !== 'string' || path === '' || path.startsWith('/') || PATH_BAD_RE.test(path)) throw bad();
    const q = path.indexOf('?');
    for (const s of (q < 0 ? path : path.slice(0, q)).split('/')) {
      let d;
      try { d = decodeURIComponent(s); } catch { throw bad(); }
      if (s === '' || d === '.' || d === '..' || /[/\\]/.test(d) || !PATH_SEGMENT_RE.test(s)) throw bad();
    }
    let u;
    try { u = new URL(path, base); } catch { throw bad(); }
    const segs = u.pathname.split('/');
    if (u.origin !== origin || !u.pathname.startsWith(prefix) || u.pathname.includes('//') || u.hash || u.username || u.password ||
      segs.some(x => x === '.' || x === '..' || /^(%2e|\.){1,2}$/i.test(x)) || RAW_BAD_RE.test(u.href)) throw bad();
    return u.href;
  }
  const firstSet = path => lower(/^[A-Za-z_][A-Za-z0-9_.]*/.exec(path)?.[0] ?? '');

  // ----- headers ---------------------------------------------------------------------------------------

  function readHeaders(set, extra) {
    const h = [['Accept', 'application/json'], ['OData-MaxVersion', '4.0'], ['OData-Version', '4.0']];
    if (extra) h.push(...extra);
    if (caller) h.push(['MSCRMCallerID', caller.id]);
    const token = set ? sessionTokens.get(set) : null;
    if (token && !h.some(([k]) => lower(k) === 'mscrm.sessiontoken')) h.push(['MSCRM.SessionToken', token]);
    return h;
  }
  const ANNOTATIONS = ['Prefer', 'odata.include-annotations="*"'];
  function outerBatchHeaders(boundary) {
    const h = { 'Content-Type': `multipart/mixed;boundary=${boundary}`, 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' };
    if (caller) h.MSCRMCallerID = caller.id;
    h.Prefer = 'odata.continue-on-error';
    return h;
  }
  const toObject = pairs => { const o = {}; for (const [k, v] of pairs) o[k] = v; return o; };

  // ----- transport -------------------------------------------------------------------------------------

  // Sends one request. With `stream`, a 2xx answer with a readable body comes back unread as `body` (csdl()).
  async function transmit(href, { method, headers, body, signal, timeoutMs, stream = false }) {
    const ctl = timeoutMs ? new AbortController() : null;
    let timedOut = false;
    const t = ctl ? setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs) : null;
    stats.requests++;
    try {
      const init = { method, headers, credentials: 'same-origin', redirect: 'manual' };
      if (body != null) init.body = body;
      const sig = signal ?? ctl?.signal;
      if (sig) init.signal = sig;
      const res = await fetchImpl(href, init);
      const hint = Number.parseInt(headerGet(res.headers, 'x-ms-dop-hint') ?? '', 10);
      if (Number.isFinite(hint)) dop = Math.min(DOP_MAX, Math.max(1, hint));
      const len = Number.parseInt(headerGet(res.headers, 'content-length') ?? '', 10);
      if (stream && res.status >= 200 && res.status < 300 && typeof res.body?.getReader === 'function') {
        return { status: res.status, statusText: res.statusText ?? '', type: res.type, headers: res.headers, text: null, body: res.body, length: Number.isFinite(len) && len >= 0 ? len : null };
      }
      const text = await res.text();
      stats.bytes += Number.isFinite(len) && len >= 0 ? len : utf8Length(text);
      return { status: res.status, statusText: res.statusText ?? '', type: res.type, headers: res.headers, text };
    } catch (e) {
      if (timedOut) throw new NetFail('timeout', e);
      if (signal?.aborted || e?.name === 'AbortError') throw abortError();
      throw new NetFail('network', e);
    } finally {
      if (t) clearTimeout(t);
    }
  }
  const isAuth = r => r.type === 'opaqueredirect' || r.status === 401;
  const ok = r => r.status >= 200 && r.status < 300;

  async function pauseGate(signal) {
    const left = pausedUntil - now();
    if (left > 0) await wait(left, signal);
  }
  // Pauses every request for `seconds` (service protection) and reports it once through onThrottle.
  async function throttleWait(seconds, signal, write) {
    const t = now();
    const until = t + seconds * 1000;
    if (until > pausedUntil) {
      stats.throttledMs += until - Math.max(t, pausedUntil);
      pausedUntil = until;
      pauseSeq++;
    }
    emit(throttleListeners, { seconds, until: pausedUntil, write });
    const left = pausedUntil - now();
    if (left > 0) await wait(left, signal);
  }

  // Reads run at most `dop` at a time; a released slot is handed to the next queued read. An aborted read never
  // queues, and one aborted while queued gives its slot straight back.
  async function acquireRead(signal) {
    if (signal?.aborted) throw abortError();
    if (readActive < dop && !readQueue.length) { readActive++; return; }
    await new Promise((resolve, reject) => {
      const w = { resolve };
      if (signal) {
        const onAbort = () => { const i = readQueue.indexOf(w); if (i >= 0) { readQueue.splice(i, 1); reject(abortError()); } };
        w.resolve = () => { signal.removeEventListener('abort', onAbort); resolve(); };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      readQueue.push(w);
    });
    if (signal?.aborted) { releaseRead(); throw abortError(); }
  }
  function releaseRead() {
    readActive--;
    while (readQueue.length && readActive < dop) { readActive++; readQueue.shift().resolve(); }
  }

  // A read request with the 02 §1 read retries; resolves to a 2xx/304 response, rejects with DataverseError/AbortError.
  // A streamed 2xx answer (req.stream) keeps its read slot: the caller releases it when the body is read.
  async function readRequest(req, signal) {
    let n429 = 0, nConc = 0, n5xx = 0, nNet = 0;
    for (;;) {
      if (signal?.aborted) throw abortError();
      await pauseGate(signal);
      const seq = pauseSeq;
      await acquireRead(signal);
      // A new 429 may have paused every request while this one waited for its slot: give the slot back and wait too.
      if (pauseSeq !== seq && pausedUntil > now()) { releaseRead(); continue; }
      let r = null, lost = null, keep = false;
      try {
        r = await transmit(req.href, { method: req.method, headers: req.headers, body: req.body, signal, stream: req.stream === true });
        keep = r.body != null;
      } catch (e) {
        if (!(e instanceof NetFail)) throw e;
        lost = e;
      } finally {
        if (!keep) releaseRead();
      }
      if (lost) {
        if (nNet < NETWORK_RETRIES) { nNet++; await wait(1000 * nNet, signal); continue; }
        throw new DataverseError(`Could not reach Dataverse (${lost.message}). Check the network connection and run the query again.`, { code: 'network' });
      }
      if (isAuth(r)) throw errorOf(r);
      if (ok(r) || r.status === 304) return r;
      const err = errorOf(r);
      if (r.status === 429) { if (n429++ < RETRIES) { await throttleWait(retryAfter(r.headers), signal, false); continue; } throw err; }
      if (err.code === CONCURRENT) { if (nConc++ < RETRIES) { await wait(CONCURRENT_WAIT_MS, signal); continue; } throw err; }
      if (r.status === 502 || r.status === 503 || r.status === 504) { if (n5xx < BACKOFF_S.length) { await wait(BACKOFF_S[n5xx++] * 1000, signal); continue; } throw err; }
      throw err;
    }
  }

  // GETs inside one $batch (read-only); per-part 429 / 0x80048105 / 502-504 are re-sent. Returns json | DataverseError.
  async function readBatch(entries, signal) {
    const out = new Array(entries.length);
    let pending = entries.map((e, i) => ({ ...e, i, tries: 0, t5: 0 }));
    let unmatched = 0;
    while (pending.length) {
      const boundary = 'batch_' + crypto.randomUUID();
      const body = batchBody(boundary, pending.map(p => ({ part: { method: 'GET', href: p.href, headers: p.headers, body: null, contentId: String(p.i) } })));
      const r = await readRequest({ href: base + '$batch', method: 'POST', headers: outerBatchHeaders(boundary), body }, signal);
      const parts = matchParts(parseBatchResponse(r.text, headerGet(r.headers, 'content-type')), pending.map(p => String(p.i)));
      if (!parts) {
        if (unmatched++ < BATCH_REREADS) continue;
        throw new DataverseError('Dataverse answered a $batch request with a response that does not match it.', { code: 'batch', status: r.status, requestId: requestIdOf(r.headers) });
      }
      const next = [];
      let waitS = 0, throttled = false, concurrent = false;
      pending.forEach((p, k) => {
        const part = parts[k];
        // 304 (Not Modified) carries no body: null like a 2xx without one (02 §1 batchGet)
        if (ok(part) || part.status === 304) {
          try { out[p.i] = jsonOf(part); } catch (e) { out[p.i] = e; }
          return;
        }
        const err = errorOf(part);
        if (err.code === 'auth') throw err;
        if (part.status === 429 || err.code === CONCURRENT) {
          if (p.tries++ < RETRIES) {
            next.push(p);
            if (part.status === 429) { throttled = true; waitS = Math.max(waitS, retryAfter(part.headers, r.headers)); } else concurrent = true;
          } else out[p.i] = err;
          return;
        }
        if ((part.status === 502 || part.status === 503 || part.status === 504) && p.t5 < BACKOFF_S.length) {
          next.push(p);
          waitS = Math.max(waitS, BACKOFF_S[p.t5++]);
          return;
        }
        out[p.i] = err;
      });
      if (next.length) {
        if (throttled) await throttleWait(waitS, signal, false);
        else await wait(Math.max(waitS * 1000, concurrent ? CONCURRENT_WAIT_MS : 0), signal);
      }
      pending = next;
    }
    return out;
  }

  // ----- reads -----------------------------------------------------------------------------------------

  function getHeaders(headers) {
    const extra = [];
    if (headers == null) return extra;
    const entries = headers instanceof Map ? [...headers] : typeof headers === 'object' ? Object.entries(headers) : null;
    if (!entries) throw new TypeError('get: headers must be an object.');
    for (const [k, v] of entries) {
      const name = GET_HEADERS.get(lower(k));
      if (!name) throw new TypeError(`get: the header '${k}' is not allowed (only Prefer, If-None-Match, Consistency and MSCRM.SessionToken).`);
      if (typeof v !== 'string' || HEADER_BAD_RE.test(v)) throw new TypeError(`get: invalid value for the header '${k}'.`);
      extra.push([name, v]);
    }
    return extra;
  }

  // GET <path> (relative to /api/data/v9.2/) -> parsed JSON (null for 204/304).
  async function get(path, { signal, headers } = {}) {
    const href = resolve(path);
    const r = await readRequest({ href, method: 'GET', headers: toObject(readHeaders(firstSet(path), getHeaders(headers))) }, signal);
    return jsonOf(r);
  }

  // Runs a FetchXML query: GET <set>?fetchXml=…, wrapped in $batch when long or when inBody is set (00 §5 rule 6).
  async function fetchXml(entitySet, xml, { signal, inBody = false } = {}) {
    const set = seg(entitySet, 'entity set name');
    if (typeof xml !== 'string' || xml === '') throw new TypeError('fetchXml: the FetchXML text is empty.');
    const href = resolve(`${set}?fetchXml=${encodeURIComponent(xml)}`);
    const headers = readHeaders(lower(set), [ANNOTATIONS]);
    if (!inBody && href.length <= MAX_GET_URL) return jsonOf(await readRequest({ href, method: 'GET', headers: toObject(headers) }, signal));
    if (href.length > MAX_BATCH_URL) {
      throw new DataverseError(`The query is too long to send: its FetchXML request is ${href.length.toLocaleString('en-US')} characters, and Dataverse accepts at most 64,000. Shorten the IN lists or split the query.`, { code: 'toolong' });
    }
    const [res] = await readBatch([{ href, headers }], signal);
    if (res instanceof DataverseError) throw res;
    return res;
  }

  // GETs up to 100 paths per $batch -> one slot per path: the part's JSON, or null when it answered 404 (or 2xx/304
  // without a body). Any other failed part rejects the whole call with its DataverseError, so a slot is never an error.
  // The $batch requests run concurrently through the read queue (at most dop at a time); the first failure aborts
  // the others and rejects the call.
  async function batchGet(paths, { signal } = {}) {
    if (!Array.isArray(paths)) throw new TypeError('batchGet: paths must be an array.');
    const entries = paths.map(p => ({ href: resolve(p), headers: readHeaders(firstSet(p), [ANNOTATIONS]) }));
    if (!entries.length) return [];
    if (signal?.aborted) throw abortError();
    const chunks = [];
    for (let i = 0; i < entries.length; i += BATCH_GET_MAX) chunks.push(entries.slice(i, i + BATCH_GET_MAX));
    const slot = x => {
      if (!(x instanceof DataverseError)) return x;
      if (x.status === 404) return null;
      throw x;
    };
    if (chunks.length === 1) return (await readBatch(chunks[0], signal)).map(slot);
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const lists = await Promise.all(chunks.map(c => readBatch(c, ctl.signal).then(list => list.map(slot))));
      return lists.flat();
    } catch (e) {
      if (signal?.aborted) throw abortError();
      throw e;
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
      // the other requests of a call that failed are not needed any more
      ctl.abort();
    }
  }

  // GET $metadata: the Web API service document as decoded UTF-8 text chunks, as the body delivers them.
  async function* csdl({ signal } = {}) {
    const href = resolve('$metadata');
    const headers = { Accept: 'application/xml', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' };
    if (caller) headers.MSCRMCallerID = caller.id;
    const r = await readRequest({ href, method: 'GET', headers, stream: true }, signal);
    if (!r.body) {
      if (r.text) yield r.text;
      return;
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let bytes = 0, finished = false;
    try {
      for (;;) {
        if (signal?.aborted) throw abortError();
        let step;
        try {
          step = await reader.read();
        } catch (e) {
          if (signal?.aborted || e?.name === 'AbortError') throw abortError();
          throw new DataverseError(`Could not read the Web API service document ($metadata): ${e?.message ?? e}.`, { code: 'network' });
        }
        if (step.done) break;
        const chunk = step.value;
        bytes += chunk?.byteLength ?? 0;
        const text = decoder.decode(chunk, { stream: true });
        if (text) yield text;
      }
      finished = true;
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      stats.bytes += r.length ?? bytes;
      releaseRead();
      if (!finished) { try { reader.cancel().catch(() => {}); } catch { /* the stream is already closed */ } }
    }
  }

  function paramLiteral(v) {
    if (v instanceof ODataLiteral) return v.text;
    if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new TypeError('fn: a number parameter must be finite.'); return String(v); }
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v == null) return 'null';
    if (v instanceof Date) { if (Number.isNaN(v.getTime())) throw new TypeError('fn: invalid Date parameter.'); return v.toISOString(); }
    return JSON.stringify(v);
  }

  // GET of an unbound, record-bound or collection-bound Web API function with parameter aliases (WhoAmI(), ...),
  // with the read annotations (formatted values, lookup targets); a URL over 16,000 characters goes inside a $batch,
  // one over 64,000 is never sent (code 'toolong'), as for fetchXml.
  async function fn(name, params, { signal, bound } = {}) {
    seg(name, 'function name');
    const entries = params == null ? [] : params instanceof Map ? [...params] : Object.entries(params);
    const args = [], aliases = [];
    entries.forEach(([k, v], i) => {
      ident(k, 'parameter name');
      args.push(`${k}=@p${i + 1}`);
      aliases.push(`@p${i + 1}=${encodeURIComponent(paramLiteral(v))}`);
    });
    let path = `${name}(${args.join(',')})`;
    if (bound) {
      // bound to one record: <set>(<id>)/NS.<name>(...); bound to the entity collection (no id): <set>/NS.<name>(...)
      const target = seg(bound.entitySet, 'entity set name') + (bound.id == null ? '' : `(${guid(bound.id, 'record id')})`);
      path = `${target}/${name.startsWith(NS) ? '' : NS}${path}`;
    }
    if (aliases.length) path += '?' + aliases.join('&');
    const href = resolve(path);
    const headers = readHeaders(firstSet(path), [ANNOTATIONS]);
    if (href.length <= MAX_GET_URL) return jsonOf(await readRequest({ href, method: 'GET', headers: toObject(headers) }, signal));
    if (href.length > MAX_BATCH_URL) {
      throw new DataverseError(`The call of ${name} is too long to send: its request is ${href.length.toLocaleString('en-US')} characters, and Dataverse accepts at most 64,000. Pass fewer or shorter parameter values.`, { code: 'toolong' });
    }
    const [res] = await readBatch([{ href, headers }], signal);
    if (res instanceof DataverseError) throw res;
    return res;
  }

  // WhoAmI of the current caller (shared per caller; a failed call is not kept).
  function whoAmI() {
    const key = caller?.id ?? '';
    let p = whoAmICache.get(key);
    if (!p) {
      p = fn('WhoAmI').then(j => Object.freeze({
        UserId: j?.UserId ? lower(j.UserId) : null, BusinessUnitId: j?.BusinessUnitId ? lower(j.BusinessUnitId) : null,
        OrganizationId: j?.OrganizationId ? lower(j.OrganizationId) : null,
      }), e => { if (whoAmICache.get(key) === p) whoAmICache.delete(key); throw e; });
      whoAmICache.set(key, p);
    }
    return p;
  }

  // RetrieveCurrentOrganization(AccessType=Default) -> its Detail object.
  async function org() {
    const j = await fn('RetrieveCurrentOrganization', { AccessType: enumParam(NS + 'EndpointAccessType', 'Default') });
    if (!j || typeof j.Detail !== 'object' || j.Detail === null) throw new DataverseError('RetrieveCurrentOrganization returned no Detail.', { code: 'notjson' });
    return j.Detail;
  }

  // RetrieveVersion() -> the version string.
  async function versionOf() {
    const j = await fn('RetrieveVersion');
    return j?.Version ?? null;
  }

  // The system job of a BulkDelete op whose outcome is unknown (02 §8.1 step 9): {id, statecode, statuscode}
  // when exactly one job with exactly that name (Dataverse compares names without case and trailing spaces, so the
  // rows are checked again here), operationtype 13 and createdon at or after `since` exists, else null.
  async function findBulkDeleteJob(jobName, since, { signal, inBody = false } = {}) {
    if (typeof jobName !== 'string' || jobName === '' || jobName.length > 256 || HEADER_BAD_RE.test(jobName)) {
      throw new TypeError('findBulkDeleteJob: the job name must be a string of 1 to 256 characters without control characters.');
    }
    const ms = since instanceof Date ? since.getTime() : typeof since === 'string' && ISO_UTC_RE.test(since) ? Date.parse(since) : Number.isFinite(since) ? since : NaN;
    if (!Number.isFinite(ms)) throw new TypeError('findBulkDeleteJob: since must be a Date, an ISO 8601 UTC text or milliseconds.');
    // createdon is stored to the second: the second the preview was built in counts.
    const from = new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
    const xml = `<fetch top="${JOB_LOOKUP_MAX}"><entity name="asyncoperation"><attribute name="asyncoperationid"/><attribute name="name"/><attribute name="statecode"/><attribute name="statuscode"/>` +
      `<filter><condition attribute="name" operator="eq" value="${xmlEsc(jobName)}"/><condition attribute="operationtype" operator="eq" value="13"/>` +
      `<condition attribute="createdon" operator="ge" value="${from}"/></filter></entity></fetch>`;
    // the job name holds the table and the time: with 'Send queries in the request body' it stays out of the URL
    const j = await fetchXml('asyncoperations', xml, { signal, inBody: inBody === true });
    const rows = Array.isArray(j?.value) ? j.value : [];
    const exact = rows.filter(r => r?.name === jobName);
    // More rows than the lookup reads could hide a second job with that name: then it is not known which one is ours.
    if (exact.length !== 1 || rows.length >= JOB_LOOKUP_MAX || !isGuid(exact[0].asyncoperationid)) return null;
    const r = exact[0];
    return Object.freeze({ id: lower(r.asyncoperationid), statecode: Number.isInteger(r.statecode) ? r.statecode : null, statuscode: Number.isInteger(r.statuscode) ? r.statuscode : null });
  }

  // ----- mode and caller -------------------------------------------------------------------------------

  function clearTimer() { if (timer != null) { clearTimeout(timer); timer = null; } }
  function arm() {
    clearTimer();
    if (idleMs == null) { expiresAt = null; return; }
    expiresAt = now() + idleMs;
    timer = setTimeout(onTimer, idleMs);
    if (typeof timer === 'object') timer?.unref?.();
  }
  function onTimer() {
    timer = null;
    if (!allowed || expiresAt == null) return;
    const left = expiresAt - now();
    if (left > 0) { timer = setTimeout(onTimer, Math.min(left, MAX_TIMER_MS)); if (typeof timer === 'object') timer?.unref?.(); return; }
    allowed = false;
    expiresAt = null;
    notify();
  }
  function checkExpiry() {
    if (allowed && expiresAt != null && now() >= expiresAt) { allowed = false; expiresAt = null; clearTimer(); notify(); }
  }
  const payload = () => ({ allowed, expiresAt, caller: caller ? { ...caller } : null, writing: writesActive > 0 });
  function notify() { emit(modeListeners, payload()); }

  // idleMs null: changes stay allowed until setReadOnly(true) (no idle timeout; Execute as and Revert keep them).
  function setReadOnly(readOnly, { idleMs: ms = IDLE_MS } = {}) {
    if (readOnly) {
      allowed = false;
      expiresAt = null;
      clearTimer();
    } else {
      if (ms !== null && (!Number.isFinite(ms) || ms < 1 || ms > MAX_TIMER_MS)) throw new RangeError(`setReadOnly: idleMs must be null or from 1 to ${MAX_TIMER_MS} milliseconds.`);
      allowed = true;
      idleMs = ms;
      if (windowWrites > 0 || ms === null) { clearTimer(); expiresAt = null; } else arm();
    }
    notify();
  }

  function setCaller(id, name = null) {
    if (writesActive > 0) throw blocked('the acting user cannot change while changes are being written.');
    if (id != null && !isGuid(id)) throw new TypeError(`setCaller: '${id}' is not a GUID.`);
    caller = id == null ? null : { id: lower(id), name: typeof name === 'string' && name ? name : null };
    whoAmICache.clear();
    // timed changes end at any caller change; changes allowed without a timeout stay (each write's preview names the
    // acting user)
    if (idleMs != null) allowed = false;
    expiresAt = null;
    clearTimer();
    notify();
  }

  function beginWrite(personal) {
    writesActive++;
    if (!personal) { windowWrites++; if (allowed) { clearTimer(); expiresAt = null; } }
    notify();
  }
  function endWrite(personal) {
    writesActive--;
    if (!personal) { windowWrites--; if (windowWrites === 0 && allowed) arm(); }
    notify();
  }

  // ----- grants ----------------------------------------------------------------------------------------

  function optionHeaders(options) {
    return OPTION_HEADERS.filter(([k]) => options[k] === true).map(([, n, v]) => [n, v]);
  }
  function normaliseOptions(options) {
    if (options == null) return {};
    if (typeof options !== 'object' || Array.isArray(options)) throw new TypeError('createGrant: options must be an object.');
    const o = { ...options };
    for (const k of [...OPTION_HEADERS.map(([name]) => name), 'ignoreDupKey']) {
      if (o[k] != null && typeof o[k] !== 'boolean') throw new TypeError(`createGrant: options.${k} must be a boolean.`);
    }
    if (o.createMultiple != null) {
      const cm = o.createMultiple;
      if (typeof cm !== 'object' || !Number.isInteger(cm.chunk) || cm.chunk < 1 || cm.chunk > 1000) throw new TypeError('createGrant: options.createMultiple.chunk must be an integer from 1 to 1000.');
      if (cm.elastic != null && typeof cm.elastic !== 'boolean') throw new TypeError('createGrant: options.createMultiple.elastic must be a boolean.');
      o.createMultiple = Object.freeze({ chunk: cm.chunk, ...(cm.elastic != null ? { elastic: cm.elastic } : {}) });
    } else o.createMultiple = null;
    return Object.freeze(o);
  }

  // Checks the body of a BulkDelete job op (02 §8.1 DELETE): one QueryExpression on the op's table that selects
  // exactly the listed ids (`<pk> In (…)`), and the fixed job parameters. Throws `Blocked: write op <n> …` otherwise.
  function checkBulkDelete(body, it, fail) {
    const why = reason => fail(`is not a BulkDelete job of exactly its previewed ids (${reason})`);
    if (it.changeSet != null || it.step != null || it.checkVersion != null) throw why('a job is never part of a change set and carries no checkVersion');
    if (keysOf(body) !== BULK_DELETE_KEYS) throw why(`its body must hold exactly ${BULK_DELETE_KEYS.split(',').join(', ')}`);
    const qs = body.QuerySet;
    if (!Array.isArray(qs) || qs.length !== 1 || !plain(qs[0]) || keysOf(qs[0]) !== 'Criteria,EntityName') throw why('QuerySet must hold exactly one QueryExpression {EntityName, Criteria}');
    const q = qs[0];
    if (q.EntityName !== it.entity) throw why(`the QueryExpression must be on '${it.entity}'`);
    const c = q.Criteria;
    if (!plain(c) || keysOf(c) !== 'Conditions,FilterOperator' || c.FilterOperator !== 'And' || !Array.isArray(c.Conditions) || c.Conditions.length !== 1) {
      throw why("Criteria must be {FilterOperator: 'And', Conditions: [one condition]}");
    }
    const pk = it.pk ?? `${it.entity}id`;
    const k = c.Conditions[0];
    if (!plain(k) || keysOf(k) !== 'AttributeName,Operator,Values' || k.AttributeName !== pk || k.Operator !== 'In') throw why(`the condition must be ${pk} In (the ids)`);
    if (!Array.isArray(k.Values) || k.Values.length < 1 || k.Values.length > BULK_DELETE_MAX) throw why('the condition must list 1 to 20,000 record ids');
    const seen = new Set();
    for (const v of k.Values) {
      if (!plain(v) || keysOf(v) !== 'Type,Value' || v.Type !== 'System.Guid' || !isGuid(v.Value)) throw why("each value must be {Value: <GUID>, Type: 'System.Guid'}");
      const id = lower(v.Value);
      if (seen.has(id)) throw why(`the id ${id} is listed twice`);
      seen.add(id);
    }
    const head = `SQL Studio ${it.entity} `;
    const m = typeof body.JobName === 'string' && body.JobName.startsWith(head) ? JOB_TAIL_RE.exec(body.JobName.slice(head.length)) : null;
    if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) throw why(`JobName must be '${head}<yyyy-MM-dd HH:mm:ss> (<k> of <n>)'`);
    if (body.SendEmailNotification !== false) throw why('SendEmailNotification must be false');
    if (!Array.isArray(body.ToRecipients) || body.ToRecipients.length || !Array.isArray(body.CCRecipients) || body.CCRecipients.length) throw why('ToRecipients and CCRecipients must be empty');
    if (body.RecurrencePattern !== '') throw why("RecurrencePattern must be '' (the job runs once)");
    if (typeof body.StartDateTime !== 'string' || !ISO_UTC_RE.test(body.StartDateTime) || Number.isNaN(Date.parse(body.StartDateTime))) throw why('StartDateTime must be an ISO 8601 UTC time');
    return { jobName: body.JobName, ids: seen };
  }

  // The BulkDelete jobs of one grant are the jobs of one DELETE (02 §8.1 DELETE): each JobName is unique, so the
  // step-9 lookup of an unknown job finds only its own, and each previewed id of a table is in exactly one job.
  // `jobs`: [{index, entity, jobName, ids}] in op order.
  function checkJobs(jobs) {
    const names = new Map(), owner = new Map();
    for (const j of jobs) {
      if (names.has(j.jobName)) throw blocked(`write op ${j.index + 1} has the JobName '${j.jobName}' of write op ${names.get(j.jobName) + 1}; each BulkDelete job of a statement has its own name.`);
      names.set(j.jobName, j.index);
      for (const id of j.ids) {
        const k = `${j.entity}|${id}`;
        const first = owner.get(k);
        if (first != null) throw blocked(`write op ${j.index + 1} selects the record ${id}, which write op ${first + 1} selects too; each previewed record is in exactly one BulkDelete job.`);
        owner.set(k, j.index);
      }
    }
  }

  // A fingerprint field: its length and text, or '-' when absent, so no two field lists give the same text.
  const fpField = v => (v == null ? '-' : `${v.length}:${v}`);
  // The JSON array of an op's key fields (02 §8.3: op|entity|id|partitionId|nav|relatedId|name|step).
  const keyOf = it => JSON.stringify([it.kind, it.entity ?? '', it.id ?? '', it.partitionId ?? '', it.nav ?? '', it.relatedId ?? '', it.name ?? '', it.step ?? '']);
  // Free-text fields (If-Match, partitionId, changeSet) must not hold a lone surrogate: no request can carry one, and
  // UTF-8 would turn every one into U+FFFD, so two different ops would read as one.
  const wellFormed = s => !LONE_SURROGATE_RE.test(s);

  // Reads one WriteOp once into a frozen item: what its request needs, and `request`, the grant's record of it
  // (02 §8.3, see the notes above): the SHA-256 digest of its key and of the digest of its fingerprint. With `sink`
  // (createGrant) the op's fingerprint digest and key text go to sink.fp and sink.key, and a BulkDelete job to
  // sink.jobs.
  function prepareOp(op, index, sink = null) {
    const n = index + 1;
    const fail = what => blocked(`write op ${n} ${what}.`);
    if (!op || typeof op !== 'object') throw fail('is not an object');
    const kind = op.op;
    if (!WRITE_KINDS.has(kind)) throw fail(`has an unknown kind '${String(kind).slice(0, 40)}'`);
    // Every field is read exactly once; '' counts as absent (02 §8.3: the key's name is '' for other ops).
    const field = v => (v === '' ? null : v);
    const entityRaw = field(op.entity), setRaw = field(op.entitySet), idRaw = field(op.id), partitionRaw = field(op.partitionId), pkRaw = field(op.pk);
    const ifMatchRaw = field(op.ifMatch), bodyRaw = op.body, navRaw = field(op.nav), relatedSetRaw = field(op.relatedSet), relatedIdRaw = field(op.relatedId);
    const nameRaw = field(op.name), boundRaw = field(op.bound), changeSetRaw = field(op.changeSet), stepRaw = field(op.step), versionRaw = field(op.checkVersion);
    const it = { index, op, kind, method: METHOD[kind], entity: null, entitySet: null, id: null, partitionId: null, pk: null, nav: null,
      relatedSet: null, relatedId: null, name: null, bound: null, changeSet: null, step: null, checkVersion: null, jobName: null,
      ifMatch: null, bodyText: null, hasType: false, href: null, request: null };
    if (kind === 'update' || kind === 'delete') {
      if (ifMatchRaw == null) throw blocked(NO_IF_MATCH);
      if (typeof ifMatchRaw !== 'string' || !ETAG_RE.test(ifMatchRaw) || !wellFormed(ifMatchRaw)) throw fail(`has an invalid If-Match '${String(ifMatchRaw).slice(0, 60)}'`);
      it.ifMatch = ifMatchRaw;
    } else if (ifMatchRaw != null) throw fail('carries If-Match, which only updates and deletes use');
    if (boundRaw != null) {
      if (kind !== 'action') throw fail('carries bound, which only actions use');
      if (boundRaw !== true && boundRaw !== 'collection') throw fail(`has an invalid bound value '${String(boundRaw).slice(0, 40)}' (true or 'collection')`);
      it.bound = boundRaw;
    }
    if (kind === 'action') {
      // The URL follows `bound` only (02 §1); without it, entity, entitySet and id serve the grant key and the preview.
      if (it.bound === true) {
        if (entityRaw == null) throw fail('is bound to a record but is missing its table (entity)');
        if (setRaw == null) throw fail('is bound to a record but is missing its entity set');
        if (idRaw == null) throw fail('is bound to a record but is missing its record id');
      } else if (it.bound === 'collection') {
        if (entityRaw == null) throw fail('is bound to an entity collection but is missing its table (entity)');
        if (setRaw == null) throw fail('is bound to an entity collection but is missing its entity set');
        if (idRaw != null) throw fail('is bound to an entity collection and carries a record id, which that binding does not use');
      } else if ((setRaw != null || idRaw != null) && entityRaw == null) throw fail('is missing its table (entity)');
      if (entityRaw != null) it.entity = lower(ident(entityRaw, 'table name'));
      if (setRaw != null) it.entitySet = seg(setRaw, 'entity set name');
      if (idRaw != null) it.id = guid(idRaw, 'record id');
    } else {
      if (entityRaw == null) throw fail('is missing its table (entity)');
      it.entity = lower(ident(entityRaw, 'table name'));
      if (setRaw == null) throw fail('is missing its entity set');
      it.entitySet = seg(setRaw, 'entity set name');
      if (idRaw == null) throw fail('is missing its record id');
      it.id = guid(idRaw, 'record id');
    }
    if (partitionRaw != null) {
      if (kind !== 'create' && kind !== 'update' && kind !== 'delete') throw fail('carries a partitionId, which only creates, updates and deletes use');
      if (typeof partitionRaw !== 'string' || HEADER_BAD_RE.test(partitionRaw) || !wellFormed(partitionRaw)) throw fail('has an invalid partitionId');
      it.partitionId = partitionRaw;
    }
    if (kind === 'associate' || kind === 'disassociate') {
      if (navRaw == null) throw fail('is missing its navigation property');
      it.nav = seg(navRaw, 'navigation property');
      if (relatedIdRaw == null) throw fail('is missing the related record id');
      it.relatedId = guid(relatedIdRaw, 'related record id');
      if (kind === 'associate') {
        if (relatedSetRaw == null) throw fail('is missing the related entity set');
        it.relatedSet = seg(relatedSetRaw, 'related entity set name');
      } else if (relatedSetRaw != null) throw fail('carries a related entity set, which disassociate does not use');
    } else if (navRaw != null || relatedIdRaw != null || relatedSetRaw != null) throw fail('carries relationship fields, which only associate and disassociate use');
    if (changeSetRaw != null) {
      if (typeof changeSetRaw !== 'string' || !CHANGESET_RE.test(changeSetRaw) || !wellFormed(changeSetRaw)) {
        throw fail('has an invalid changeSet (a string of 1 to 200 characters without control characters)');
      }
      it.changeSet = changeSetRaw;
    }
    if (stepRaw != null) {
      if (!Number.isInteger(stepRaw) || stepRaw < 0 || stepRaw > STEP_MAX) throw fail(`has an invalid step '${String(stepRaw).slice(0, 20)}' (an integer from 0 to ${STEP_MAX})`);
      if (it.changeSet == null) throw fail('carries a step but no changeSet');
      if (it.id == null) throw fail('carries a step but no record id');
      it.step = stepRaw;
    }
    if (versionRaw != null) {
      if (kind !== 'action' || it.id == null) throw fail('carries checkVersion, which only actions about a record use');
      it.checkVersion = versionText(versionRaw);
      if (it.checkVersion == null) throw fail('has an invalid checkVersion (a versionnumber: a non-negative integer)');
    }
    let job = false;
    if (kind === 'action') {
      it.name = ident(nameRaw, 'action name');
      if (REFUSED_ACTIONS.has(lower(it.name))) {
        // BulkDelete is granted only as the job op of a DELETE preview; EXEC BulkDelete stays refused.
        job = it.name === 'BulkDelete' && it.entity != null && it.bound == null && it.id == null;
        if (!job) throw blocked(`EXEC ${it.name} would change records the preview cannot show.`);
      }
    } else if (nameRaw != null) throw fail('carries an action name');
    // pk names the primary key of a create body, of an elastic record URL and of a BulkDelete job's condition
    if (pkRaw != null) {
      if (kind !== 'create' && kind !== 'update' && kind !== 'delete' && !job) throw fail('carries a primary id attribute (pk), which only creates, updates, deletes and BulkDelete jobs use');
      it.pk = ident(pkRaw, 'primary id attribute');
    }
    // body snapshot: read once, so what is fingerprinted is exactly what is sent
    let bodyCanon = null;
    if (kind === 'create' || kind === 'update' || kind === 'action') {
      const raw = bodyRaw === undefined && kind === 'action' ? {} : bodyRaw;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('needs a JSON object body');
      let text;
      try { text = JSON.stringify(raw); } catch (e) { throw fail(`has a body that cannot be written as JSON (${e.message})`); }
      if (typeof text !== 'string') throw fail('needs a JSON object body');
      const parsed = JSON.parse(text);
      if (!plain(parsed)) throw fail('needs a JSON object body');
      it.bodyText = text;
      // the canonical body (keys sorted) is the text itself when its keys are in order already
      bodyCanon = sortedDeep(parsed) ? text : canon(parsed);
      if (job) {
        const j = checkBulkDelete(parsed, it, fail);
        it.jobName = j.jobName;
        if (sink) sink.jobs.push({ index, entity: it.entity, jobName: j.jobName, ids: j.ids });
      }
      if (kind === 'create') {
        // The id fixed before the dialog (00 §5 rule 4) must be the primary key that is written: the pk column when
        // the op names it (or the body has <entity>id), else at least a top-level value of the body.
        const pkName = it.pk ?? (Object.hasOwn(parsed, `${it.entity}id`) ? `${it.entity}id` : null);
        if (pkName != null) {
          const v = Object.hasOwn(parsed, pkName) ? parsed[pkName] : null;
          if (typeof v !== 'string' || lower(v) !== it.id) throw fail(`does not carry its record id in its primary key column '${pkName}'`);
        } else if (!Object.values(parsed).some(v => typeof v === 'string' && lower(v) === it.id)) throw fail('does not carry its record id in its body');
        it.hasType = Object.hasOwn(parsed, '@odata.type');
      }
    } else if (bodyRaw != null) throw fail('carries a body, which this kind does not send');
    let path, key = it.id;
    if (it.partitionId != null && (kind === 'update' || kind === 'delete')) {
      // An elastic table is a custom table, whose primary key Dataverse always names <logical name>id; op.pk wins.
      key = `${it.pk ?? `${it.entity}id`}=${it.id},partitionid=${odataString(it.partitionId)}`;
    }
    switch (kind) {
      case 'create': path = it.entitySet; break;
      case 'update': case 'delete': path = `${it.entitySet}(${key})`; break;
      case 'associate':
        path = `${it.entitySet}(${it.id})/${it.nav}/$ref`;
        it.bodyText = JSON.stringify({ '@odata.id': `${base}${it.relatedSet}(${it.relatedId})` });
        bodyCanon = it.bodyText;
        break;
      case 'disassociate': path = `${it.entitySet}(${it.id})/${it.nav}(${it.relatedId})/$ref`; break;
      default: path = it.bound === true ? `${it.entitySet}(${it.id})/${NS}${it.name}` : it.bound === 'collection' ? `${it.entitySet}/${NS}${it.name}` : it.name;
    }
    it.href = resolve(path);
    // The fingerprint (02 §8.3): method, URL (relative to this api's fixed base), If-Match, changeSet, checkVersion
    // and the canonical body; the granted option headers are the grant's own, sent with every request of it.
    shaRun(fpField(it.method) + fpField(it.href.slice(base.length)) + fpField(it.ifMatch) + fpField(it.changeSet) + fpField(it.checkVersion) + fpField(bodyCanon), null);
    const keyText = keyOf(it);
    if (sink) { sink.fp = shaKey(); sink.key = keyText; }
    // the request record: the key, then the 32 bytes of the fingerprint digest
    shaRun(keyText, shaBytes());
    it.request = shaKey();
    return Object.freeze(it);
  }

  // The granted change sets (02 §1): changeSet -> the request records of its ops in op order. Checks that each
  // change set is consecutive and at most 1,000 ops, and that the ops of one record that carry a step are numbered
  // 0, 1, … in order.
  function grantChangeSets(items) {
    const sets = new Map();
    items.forEach(it => {
      if (it.changeSet == null) return;
      const i = it.index;
      const s = sets.get(it.changeSet);
      if (!s) { sets.set(it.changeSet, { last: i, items: [it] }); return; }
      if (s.last !== i - 1) throw blocked(`write op ${i + 1} is separated from the other requests of its change set.`);
      s.last = i;
      s.items.push(it);
    });
    for (const s of sets.values()) {
      if (s.items.length > BATCH_PARTS_MAX) throw blocked(`write op ${s.items[0].index + 1} starts a change set of more than 1,000 requests, which one $batch cannot hold.`);
      const byRecord = new Map();
      for (const it of s.items) {
        if (it.id == null) continue;
        const k = `${it.entity}|${it.id}`;
        if (!byRecord.has(k)) byRecord.set(k, []);
        byRecord.get(k).push(it);
      }
      for (const list of byRecord.values()) {
        if (!list.some(it => it.step != null)) continue;
        list.forEach((it, x) => {
          if (it.step !== x) throw blocked(`write op ${it.index + 1} has step ${it.step ?? 'none'}, but the requests of one record in a change set carry the steps 0, 1, … in op order.`);
        });
      }
    }
    return new Map([...sets].map(([cs, s]) => [cs, s.items.map(it => it.request)]));
  }

  const pvRefusal = () => blocked('a personal-view confirmation covers exactly one create or one update of a userquery.');
  // A personal-view grant covers exactly one userquery create or one If-Match update (02 §8.3). It checks the frozen
  // items prepareOp read once, so what it accepts is exactly what is fingerprinted and sent.
  function checkPersonalView(items) {
    const refuse = pvRefusal;
    if (items.length !== 1) throw refuse();
    const it = items[0];
    if (it.entity !== 'userquery' || it.entitySet !== 'userqueries' || it.partitionId != null || it.bodyText == null) throw refuse();
    if (it.changeSet != null || it.step != null || it.checkVersion != null || it.bound != null) throw refuse();
    const body = JSON.parse(it.bodyText);
    const keys = Object.keys(body);
    if (it.kind === 'create') {
      if (it.ifMatch != null || !keys.every(k => PERSONAL_CREATE_KEYS.has(k)) || !PERSONAL_CREATE_REQUIRED.every(k => keys.includes(k))) throw refuse();
      if (body.querytype !== 0 || typeof body.userqueryid !== 'string' || lower(body.userqueryid) !== it.id) throw refuse();
    } else if (it.kind === 'update') {
      if (it.ifMatch == null || it.ifMatch === '*' || !keys.length || !keys.every(k => PERSONAL_UPDATE_KEYS.has(k))) throw refuse();
    } else throw refuse();
  }

  // Mints a grant for the confirmed requests (dialogs.js only, 02 §8.3); returns a frozen opaque token.
  function createGrant(spec) {
    if (!spec || typeof spec !== 'object') throw new TypeError('createGrant: a grant spec {ops, options, callerId} is required.');
    const { ops } = spec;
    if (!Array.isArray(ops) || ops.length === 0) throw new TypeError('createGrant: ops must be a non-empty array.');
    const callerId = spec.callerId == null ? null : guid(spec.callerId, 'caller id');
    const personalView = spec.personalView === true;
    if (spec.personalView != null && typeof spec.personalView !== 'boolean') throw new TypeError('createGrant: personalView must be a boolean.');
    const rawOptions = spec.options;
    if (personalView) {
      if (caller) throw blocked('not available while acting as another user.');
      if (ops.length !== 1 || callerId != null) throw pvRefusal();
      if (rawOptions != null && (typeof rawOptions !== 'object' || Object.keys(rawOptions).length)) throw pvRefusal();
    }
    const options = normaliseOptions(rawOptions);
    const headers = optionHeaders(options);
    // Each op is read once, in op order, and only its request record is kept (see the notes above). Each request once: no
    // fingerprint twice, and no key twice except for actions, which share a key when their requests differ (one
    // BulkDelete job per 20,000 ids, one AddMemberList per member of a list, one GrantAccess per principal of a
    // record).
    const sink = { fp: null, key: null, jobs: [] };
    const requests = new Set(), fps = new Set(), keys = new Set(), inSets = [];
    for (let i = 0; i < ops.length; i++) {
      let it;
      try {
        it = prepareOp(ops[i], i, sink);
      } catch (e) {
        if (personalView && e instanceof DataverseError && e.code === 'blocked') throw pvRefusal();
        throw e;
      }
      if (personalView) checkPersonalView([it]);
      const repeated = () => blocked(`write op ${i + 1} repeats a request of the same statement.`);
      if (fps.has(sink.fp)) throw repeated();
      fps.add(sink.fp);
      if (it.kind !== 'action') {
        if (keys.has(sink.key)) throw repeated();
        keys.add(sink.key);
      }
      requests.add(it.request);
      if (it.changeSet != null) inSets.push(it);
    }
    const changeSets = grantChangeSets(inSets);
    checkJobs(sink.jobs);
    const token = Object.freeze(Object.create(null));
    grants.set(token, { requests, changeSets, callerId, options, headers, personalView, createdAt: now(), ttlMs: GRANT_TTL_MS, consumed: false });
    return token;
  }

  // ----- writes ----------------------------------------------------------------------------------------

  function writeOptions(opts) {
    if (opts == null || typeof opts !== 'object') throw new TypeError('write: options must be an object.');
    const batchSize = opts.batchSize ?? 50;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > BATCH_PARTS_MAX) throw new RangeError('write: batchSize must be an integer from 1 to 1000.');
    let maxdop = opts.maxdop == null || opts.maxdop === 0 ? dop : opts.maxdop;
    if (!Number.isInteger(maxdop) || maxdop < 1) throw new RangeError('write: maxdop must be a positive integer.');
    maxdop = Math.min(DOP_MAX, maxdop);
    for (const k of ['stop', 'beforeBatch', 'onProgress']) if (opts[k] != null && typeof opts[k] !== 'function') throw new TypeError(`write: ${k} must be a function.`);
    for (const k of ['continueOnError', 'ignoreDupKey']) if (opts[k] != null && typeof opts[k] !== 'boolean') throw new TypeError(`write: ${k} must be a boolean.`);
    // createMultiple: undefined (not given), null, or the 02 §8.2 {chunk, elastic?} that must equal the grant's
    let createMultiple;
    const cm = opts.createMultiple;
    if (cm === null) createMultiple = null;
    else if (cm !== undefined) {
      if (typeof cm !== 'object' || Array.isArray(cm) || !Number.isInteger(cm.chunk) || cm.chunk < 1 || cm.chunk > 1000) {
        throw new TypeError('write: createMultiple must be null or {chunk: an integer from 1 to 1000, elastic?: boolean}.');
      }
      if (cm.elastic != null && typeof cm.elastic !== 'boolean') throw new TypeError('write: createMultiple.elastic must be a boolean.');
      createMultiple = { chunk: cm.chunk, elastic: cm.elastic ?? undefined };
    }
    return { batchSize, maxdop, continueOnError: opts.continueOnError === true, ignoreDupKey: opts.ignoreDupKey ?? null,
      stop: opts.stop ?? null, beforeBatch: opts.beforeBatch ?? null, onProgress: opts.onProgress ?? null, createMultiple };
  }

  // At write time every change set is sent whole: exactly its granted requests, consecutive and in the granted order.
  function checkChangeSets(items, g) {
    const done = new Set();
    for (let i = 0; i < items.length;) {
      const cs = items[i].changeSet;
      if (cs == null) { i++; continue; }
      if (done.has(cs)) throw blocked(DIFFERS);
      const sent = [];
      let j = i;
      while (j < items.length && items[j].changeSet === cs) sent.push(items[j++].request);
      const want = g.changeSets.get(cs);
      if (!want || want.length !== sent.length || want.some((k, x) => k !== sent[x])) throw blocked(DIFFERS);
      done.add(cs);
      i = j;
    }
  }

  // Sends the granted requests (02 §8.3): validates everything first, then batches, CreateMultiple, retries, stop.
  async function write(grant, ops, opts = {}) {
    const o = writeOptions(opts);
    if (!Array.isArray(ops)) throw new TypeError('write: ops must be an array.');
    const g = grant != null && typeof grant === 'object' ? grants.get(grant) : undefined;
    if (!g) throw blocked('this change was not confirmed.');
    if (g.consumed) throw blocked('this confirmation was already used.');
    g.consumed = true;
    if (now() - g.createdAt > g.ttlMs) throw blocked('the confirmation expired; run the statement again to preview it.');
    // the acting user and the changes window: checked before the ops are read, and again before anything is sent
    const gate = () => {
      if (g.personalView && caller) throw blocked('not available while acting as another user.');
      if ((caller?.id ?? null) !== g.callerId) throw blocked('the acting user changed since the confirmation');
      if (!g.personalView) {
        checkExpiry();
        if (!allowed) throw blocked('SQL Studio is read-only. Select the Read-only pill in the top bar and run the statement again.');
      }
    };
    gate();
    const count = ops.length;
    if (g.personalView && count > 1) throw blocked(DIFFERS);
    // One pass over the ops, which lets the event loop run after every VALIDATE_SLICE_MS of work (nothing is sent
    // before it ends). Each op must be one of the granted requests, each of which is sent once: its record leaves the
    // consumed grant.
    const items = new Array(count);
    let sliceStart = performance.now();
    for (let i = 0; i < count; i++) {
      if (performance.now() - sliceStart >= VALIDATE_SLICE_MS) {
        await macrotask();
        sliceStart = performance.now();
      }
      let it;
      try {
        it = prepareOp(ops[i], i);
      } catch (e) {
        // An op that cannot be built cannot be one of the confirmed requests (02 §8.3); only the missing If-Match
        // keeps its own 02 §1 text.
        if (e instanceof DataverseError && e.message === `Blocked: ${NO_IF_MATCH}`) throw e;
        throw blocked(DIFFERS);
      }
      if (!g.requests.delete(it.request)) throw blocked(DIFFERS);
      items[i] = it;
    }
    // the pass may have let a caller change or the end of the changes window happen
    gate();
    checkChangeSets(items, g);
    // IGNORE_DUP_KEY: the confirmed preview fixes it when its grant carries it (02 §8.2); else the write option applies
    if (typeof g.options.ignoreDupKey === 'boolean') {
      if (o.ignoreDupKey != null && o.ignoreDupKey !== g.options.ignoreDupKey) throw blocked(DIFFERS);
      o.ignoreDupKey = g.options.ignoreDupKey;
    } else o.ignoreDupKey = o.ignoreDupKey === true;
    if (o.createMultiple !== undefined) {
      const want = o.createMultiple;
      const have = g.options.createMultiple;
      const same = want == null ? have == null : have != null && want.chunk === have.chunk && (want.elastic === undefined || want.elastic === have.elastic);
      if (!same) throw blocked(DIFFERS);
    }
    const results = [];
    results.createMultipleFallback = null;
    if (!items.length) return results;
    beginWrite(g.personalView);
    try {
      return await runWrite(g, items, o, results);
    } finally {
      endWrite(g.personalView);
    }
  }

  // Phase class of each op kind: deletes (and disassociates), updates (and actions), creates (and associates).
  const PHASE = new Map([['delete', 0], ['disassociate', 0], ['update', 1], ['action', 1], ['create', 2], ['associate', 2]]);
  const unitClass = u => {
    const first = PHASE.get(u.items[0].kind);
    return u.items.every(it => PHASE.get(it.kind) === first) ? first : -1;
  };

  // For each op inside a run of two or more consecutive CreateMultiple-eligible creates of one table: the run's end;
  // -1 for every other op (02 §8.1 INSERT: a single create is a $batch part).
  function cmRunEnds(items, g) {
    const ends = new Array(items.length).fill(-1);
    if (!g.options.createMultiple) return ends;
    const eligible = it => it.kind === 'create' && !it.hasType && it.changeSet == null;
    for (let i = 0; i < items.length;) {
      if (!eligible(items[i])) { i++; continue; }
      let j = i + 1;
      while (j < items.length && eligible(items[j]) && items[j].entity === items[i].entity && items[j].entitySet === items[i].entitySet) j++;
      if (j - i >= 2) for (let k = i; k < j; k++) ends[k] = j;
      i = j;
    }
    return ends;
  }

  // The CreateMultiple target of a create op (02 §1): exactly its granted body plus @odata.type, built when it is sent.
  const cmTarget = it => '{"@odata.type":' + JSON.stringify(NS + it.entity) + (it.bodyText === '{}' ? '' : ',' + it.bodyText.slice(1, -1)) + '}';
  // The UTF-8 size of cmTarget(it), without building it: '{"@odata.type":"<NS><entity>"' (17 + the names), the body
  // without its braces after a comma, and '}'.
  const cmTargetBytes = it => 18 + NS.length + it.entity.length + (it.bodyText === '{}' ? 0 : utf8Length(it.bodyText) - 1);

  // The next request from position `pos`, sized by the current adaptive sizes: a CreateMultiple chunk (at most the
  // CreateMultiple size and 16 MB of JSON), or a $batch of at most the batch size whose change sets stay whole.
  function cutUnit(items, pos, ctx, ends) {
    if (ends[pos] >= 0) {
      const end = ends[pos];
      const max = Math.min(ctx.g.options.createMultiple.chunk, ctx.cmSize);
      const chunk = [];
      let k = pos, bytes = 0;
      while (k < end && chunk.length < max) {
        // the body '{"Targets":[' + the targets joined by ',' + ']}' with this target added
        const size = cmTargetBytes(items[k]);
        if (chunk.length && 14 + bytes + size + chunk.length > CM_MAX_BYTES) break;
        chunk.push(items[k++]);
        bytes += size;
      }
      return { kind: 'cm', items: chunk, end: k };
    }
    const batch = [];
    let k = pos;
    while (k < items.length && batch.length < ctx.size && ends[k] < 0) {
      const cs = items[k].changeSet;
      if (cs == null) { batch.push(items[k++]); continue; }
      let j = k + 1;
      while (j < items.length && items[j].changeSet === cs) j++;
      if (batch.length && batch.length + (j - k) > ctx.size) break;
      while (k < j) batch.push(items[k++]);
    }
    return { kind: 'batch', items: batch, end: k };
  }

  async function runWrite(g, items, o, results) {
    const cm = g.options.createMultiple;
    const ctx = { g, o, results, failStop: false, authStop: false, userStop: false, cmFallback: null, kinds: new Map(),
      done: 0, failed: 0, skipped: 0, unknown: 0, size: o.batchSize, cmSize: cm ? cm.chunk : 0, shownSize: o.batchSize };
    results.length = items.length;
    const ends = cmRunEnds(items, g);
    if (ends[0] >= 0) ctx.shownSize = cm.chunk;
    // Requests run in phases (02 §8.2: deletes -> updates -> creates): consecutive requests of one class run together
    // up to maxdop; a request that mixes classes runs alone; a new class starts only after every request of the
    // previous one has its answer, and nothing starts after Stop, an expired session or (without continueOnError) a
    // failure. Each request is cut when it starts, so it takes the adaptive size of the moment.
    const inflight = new Set();
    let pos = 0, cls = null, error = null;
    const start = u => {
      const p = (u.kind === 'cm' ? runCmUnit(u, ctx) : runBatch(u.items, ctx, false)).then(
        failed => { if (failed && !o.continueOnError) ctx.failStop = true; },
        e => { if (!error) error = e; },
      ).finally(() => { inflight.delete(p); });
      inflight.add(p);
    };
    while (pos < items.length && !error) {
      if (inflight.size >= o.maxdop) { await Promise.race(inflight); continue; }
      if (halted(ctx)) break;
      const u = cutUnit(items, pos, ctx, ends);
      const c = unitClass(u);
      if (inflight.size && (c === -1 || c !== cls)) { await Promise.race(inflight); continue; }
      pos = u.end;
      cls = c;
      start(u);
    }
    while (inflight.size) await Promise.race(inflight);
    if (error) throw error;
    markNotSent(ctx, items);
    progress(ctx);
    results.createMultipleFallback = ctx.cmFallback;
    return results;
  }

  function halted(ctx, ignoreFailures = false) {
    if (ctx.authStop || ctx.userStop) return true;
    if (ctx.o.stop) {
      let s;
      try { s = ctx.o.stop(); } catch (e) { report(e); s = true; }
      if (s) { ctx.userStop = true; return true; }
    }
    return !ignoreFailures && ctx.failStop;
  }
  const notSentWhy = ctx => (ctx.authStop ? 'Not sent: the Dataverse session expired.'
    : ctx.userStop ? 'Not sent: the write was stopped.'
      : 'Not sent: an earlier batch failed (CONTINUE_ON_ERROR continues after failures).');
  // Gives every item without a result 'notAttempted' (the request was never sent).
  function markNotSent(ctx, items, message = notSentWhy(ctx)) {
    for (const it of items) if (!ctx.results[it.index]) setResult(ctx, it, 'notAttempted', { message });
  }

  // Sets an op's WriteResult once more or for the first time; the progress counters follow in O(1).
  function setResult(ctx, it, status, extra = {}) {
    const prev = ctx.results[it.index];
    if (prev) tally(ctx, prev.status, -1);
    ctx.results[it.index] = Object.freeze({ index: it.index, id: it.id, status, http: null, code: null, message: null, ...extra });
    tally(ctx, status, 1);
  }
  function tally(ctx, status, d) {
    if (status === 'notAttempted') return;
    ctx.done += d;
    if (status === 'failed') ctx.failed += d; else if (status === 'skipped') ctx.skipped += d; else if (status === 'unknown') ctx.unknown += d;
  }
  function progress(ctx) {
    if (!ctx.o.onProgress) return;
    try {
      ctx.o.onProgress({ done: ctx.done, total: ctx.results.length, failed: ctx.failed, skipped: ctx.skipped, unknown: ctx.unknown, batchSize: ctx.shownSize });
    } catch (e) { report(e); }
  }
  // A batch "with failures" (02 §8.1 step 8): an op 'failed'. 'unknown' ops are verified later and do not count.
  const unitFailed = (ctx, items) => items.some(it => ctx.results[it.index]?.status === 'failed');

  // The adaptive batch size (02 §8.1 step 8): after a request of n ops that took `ms`, the next request of that
  // transport takes round(n × 10 s / ms) ops, or half of n after a timeout, within 1 and BATCH_SIZE (the chunk for
  // CreateMultiple).
  function adapt(ctx, kind, n, ms, halve) {
    const max = kind === 'cm' ? ctx.g.options.createMultiple.chunk : ctx.o.batchSize;
    const next = halve ? Math.floor(n / 2) : Math.round(n * BATCH_TARGET_MS / Math.max(1, ms));
    const size = Math.min(max, Math.max(1, Number.isFinite(next) ? next : max));
    if (kind === 'cm') ctx.cmSize = size; else ctx.size = size;
    ctx.shownSize = size;
  }

  function writePartHeaders(it, headers) {
    const h = [['Accept', 'application/json'], ['OData-MaxVersion', '4.0'], ['OData-Version', '4.0']];
    // an action's answer becomes result sets by the 02 §9 response shapes, whose entities need the read annotations
    if (it.kind === 'action') h.push(ANNOTATIONS);
    if (it.bodyText != null) h.push(['Content-Type', 'application/json; charset=utf-8']);
    if (it.ifMatch != null) h.push(['If-Match', it.ifMatch]);
    if (caller) h.push(['MSCRMCallerID', caller.id]);
    h.push(...headers);
    return h;
  }
  // The x-ms-session-token of an answer, or null.
  const tokenOf = h => { const t = headerGet(h, 'x-ms-session-token'); return t && !HEADER_BAD_RE.test(t) ? t : null; };
  // Keeps a write answer's session token for later reads of the tables of the ops it wrote ('ok' results; 02 §1).
  function keepToken(ctx, token, items) {
    if (token == null) return;
    for (const it of items) if (it.entitySet && ctx.results[it.index]?.status === 'ok') sessionTokens.set(lower(it.entitySet), token);
  }
  // Sends one write request (sendGate has waited out any throttle pause); never receives the run's signal.
  async function writeTransmit(href, method, headers, body) {
    try {
      return { kind: 'response', r: await transmit(href, { method, headers, body, timeoutMs: writeTimeoutMs }) };
    } catch (e) {
      if (e instanceof NetFail) return { kind: e.kind };
      throw e;
    }
  }
  const lostMessage = kind => (kind === 'timeout'
    ? `Dataverse did not answer within ${Math.round(writeTimeoutMs / 1000)} s; the outcome is unknown.`
    : 'The connection failed before Dataverse answered; the outcome is unknown.');
  const entityIdOf = h => {
    const m = /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\s*$/i.exec(headerGet(h, 'odata-entityid') ?? '');
    return m ? lower(m[1]) : null;
  };

  // The statement op indexes beforeBatch skips. Its answer is a Set or array whose members are positions in the
  // `ops` array it received (0 to checked.length - 1) or those WriteOp objects themselves. Anything else (undefined,
  // another object, a position outside the array, a non-integer) is null: the check failed.
  function skipSet(result, checked) {
    if (!(result instanceof Set) && !Array.isArray(result)) return null;
    let byOp = null;
    const out = new Set();
    for (const x of result) {
      let it;
      if (Number.isInteger(x)) it = x >= 0 ? checked[x] : undefined;
      else if (x !== null && typeof x === 'object') {
        byOp ??= new Map(checked.map(c => [c.op, c]));
        it = byOp.get(x);
      }
      if (!it) return null;
      out.add(it.index);
    }
    return out;
  }
  // The ops beforeBatch re-reads (02 §8.3): updates, deletes and action ops with checkVersion.
  const checkedOp = it => it.kind === 'update' || it.kind === 'delete' || it.checkVersion != null;

  // Right before a write request (first send or re-send): waits out a throttle pause, checks Stop (after a wait, and
  // always for a re-send), then runs beforeBatch on the update, delete and checkVersion ops, checks Stop again when
  // it returns, and runs it again if a pause began meanwhile. Returns {items} to send, {stopped: true} or
  // {failed: true} (the check failed); every op left out has its result. A change set is sent whole or not at all.
  async function sendGate(ctx, items, ignoreFailures, resend) {
    let send = items;
    for (let round = 0; ; round++) {
      const waited = pausedUntil > now();
      if (waited) await pauseGate(null);
      const seq = pauseSeq;
      if ((waited || resend || round > 0) && halted(ctx, ignoreFailures)) { markNotSent(ctx, send); return { stopped: true }; }
      const checked = ctx.o.beforeBatch ? send.filter(checkedOp) : [];
      if (!checked.length) return { items: send };
      let result, threw = false, error = null;
      try {
        result = await ctx.o.beforeBatch(checked.map(it => it.op));
      } catch (e) {
        threw = true;
        error = e;
      }
      // The re-read can take seconds: a Stop confirmed (or a failed batch, an expired session) meanwhile keeps this
      // batch from being sent (02 §8.3: stop is checked before each new batch).
      if (halted(ctx, ignoreFailures)) { markNotSent(ctx, send); return { stopped: true }; }
      if (threw) {
        markNotSent(ctx, send, `Not sent: the check before the batch failed (${trimMessage(error?.message ?? error)}).`);
        return { failed: true };
      }
      const skip = skipSet(result, checked);
      if (!skip) {
        markNotSent(ctx, send, `Not sent: the check before the batch did not return the positions (0 to ${checked.length - 1}) of this batch's records to skip.`);
        return { failed: true };
      }
      const skippedSets = new Set(send.filter(it => it.changeSet != null && skip.has(it.index)).map(it => it.changeSet));
      const keep = [];
      for (const it of send) {
        if (skip.has(it.index) || (it.changeSet != null && skippedSets.has(it.changeSet))) setResult(ctx, it, 'skipped', { reason: 'etag', message: 'Changed by someone else since the preview.' });
        else keep.push(it);
      }
      send = keep;
      if (!send.length || pauseSeq === seq || !(pausedUntil > now())) return { items: send };
      // a new throttle pause began during the re-read: wait for it, then read again right before sending
    }
  }

  // Result of one answered write request part (or a single-part outcome) for op `it`.
  function partOutcome(ctx, it, part, outer) {
    const s = part.status;
    if (ok(part)) {
      const extra = { http: s };
      if (it.kind === 'create') extra.newId = entityIdOf(part.headers) ?? it.id;
      const etag = headerGet(part.headers, 'etag');
      if (etag) extra.etag = etag;
      if (it.kind === 'action') { const j = tryJson(part.text); extra.json = j === undefined ? null : j; }
      // A BulkDelete job is submitted when Dataverse answers with its JobId (02 §8.1 DELETE).
      if (it.jobName != null && !isGuid(extra.json?.JobId)) {
        return { status: 'unknown', extra: { ...extra, message: `BulkDelete answered without a JobId; check the system jobs named '${it.jobName}'.` } };
      }
      return { status: 'ok', extra };
    }
    const err = errorOf(part);
    const base2 = { http: s, code: err.code, message: err.message };
    if (s === 429 || err.code === CONCURRENT) return { retry: s === 429 ? retryAfter(part.headers, outer) : CONCURRENT_WAIT_MS / 1000, throttle: s === 429, err, extra: base2 };
    if (err.code === 'auth') return { status: 'failed', auth: true, extra: base2 };
    if (s >= 500) return { status: 'unknown', extra: { ...base2, message: `Dataverse answered HTTP ${s} (${err.message}); the outcome is unknown.` } };
    // 412 is the If-Match mismatch only with its own code or none; DuplicateRecord (a unique alternate key), duplicate
    // detection and any other 412 are failures (research dataverse-fetchxml §2.4).
    if ((it.kind === 'update' || it.kind === 'delete') && s === 412 && (err.code === VERSION_MISMATCH || err.code == null || err.code === 'notjson')) {
      return { status: 'skipped', extra: { ...base2, reason: 'etag', message: 'Changed by someone else since the preview.' } };
    }
    if (s === 404 && (it.kind === 'update' || it.kind === 'delete' || it.kind === 'associate' || it.kind === 'disassociate')) {
      return { status: 'skipped', extra: { ...base2, reason: 'missing', message: 'No longer exists.' } };
    }
    if (ctx.o.ignoreDupKey && (it.kind === 'create' || it.kind === 'associate') && (s === 409 || err.code === DUPLICATE)) {
      return { status: 'skipped', extra: { ...base2, reason: 'duplicate' } };
    }
    return { status: 'failed', extra: base2 };
  }

  // Counts one more try for each op; false when an op is past the 8 retries.
  function countTry(tries, items) {
    let within = true;
    for (const it of items) { const n = (tries.get(it) ?? 0) + 1; tries.set(it, n); if (n > RETRIES) within = false; }
    return within;
  }

  // The request units of a $batch in op order: a single op, or the consecutive ops of one change set.
  function requestUnits(send) {
    const units = [];
    for (let i = 0; i < send.length;) {
      const cs = send[i].changeSet;
      if (cs == null) { units.push({ items: [send[i]], set: false }); i++; continue; }
      let j = i + 1;
      while (j < send.length && send[j].changeSet === cs) j++;
      units.push({ items: send.slice(i, j), set: true });
      i = j;
    }
    return units;
  }

  // One write $batch (gate with beforeBatch, send, re-queue throttled parts). Returns true when an op failed or the
  // check before the batch failed.
  async function runBatch(items, ctx, ignoreFailures) {
    const tries = new Map();
    let send = items, resend = false, checkFailed = false;
    while (send.length) {
      const gate = await sendGate(ctx, send, resend || ignoreFailures, resend);
      if (gate.failed) { checkFailed = true; break; }
      if (gate.stopped) break;
      send = gate.items;
      if (!send.length) break;
      const units = requestUnits(send);
      const reqPart = it => ({ method: it.method, href: it.href, headers: writePartHeaders(it, ctx.g.headers), body: it.bodyText, contentId: String(it.index) });
      const boundary = 'batch_' + crypto.randomUUID();
      const body = batchBody(boundary, units.map(u => (u.set ? { set: u.items.map(reqPart) } : { part: reqPart(u.items[0]) })));
      const t0 = Date.now();
      const res = await writeTransmit(base + '$batch', 'POST', outerBatchHeaders(boundary), body);
      const ms = Date.now() - t0;
      if (res.kind !== 'response') {
        for (const it of send) setResult(ctx, it, 'unknown', { message: lostMessage(res.kind) });
        if (res.kind === 'timeout') adapt(ctx, 'batch', send.length, ms, true);
        break;
      }
      const r = res.r;
      if (isAuth(r)) {
        ctx.authStop = true;
        const err = errorOf(r);
        for (const it of send) setResult(ctx, it, 'failed', { http: r.status || 401, code: 'auth', message: err.message });
        break;
      }
      const contentType = headerGet(r.headers, 'content-type');
      if (!ok(r) && !/^multipart\/mixed/i.test(String(contentType ?? '').trim())) {
        // The whole request was answered without parts: nothing was executed, except after a 5xx (unknown).
        const err = errorOf(r);
        if (r.status === 429 || err.code === CONCURRENT) {
          if (!countTry(tries, send)) { for (const it of send) setResult(ctx, it, 'failed', { http: r.status, code: err.code, message: err.message }); break; }
          if (halted(ctx, true)) { markNotSent(ctx, send); break; }
          if (r.status === 429) await throttleWait(retryAfter(r.headers), null, true); else await wait(CONCURRENT_WAIT_MS, null);
          resend = true;
          continue;
        }
        if (timeoutLike(r.status, err.code)) adapt(ctx, 'batch', send.length, ms, true);
        const st = r.status >= 500 ? 'unknown' : 'failed';
        const message = st === 'unknown' ? `Dataverse answered HTTP ${r.status} (${err.message}); the outcome is unknown.` : err.message;
        for (const it of send) setResult(ctx, it, st, { http: r.status, code: err.code, message });
        break;
      }
      // A 2xx answer must hold one part per request; a non-2xx multipart answer holds the parts processed so far.
      const matched = matchWrite(parseBatchTree(r.text, contentType), units, ok(r));
      if (!matched) {
        for (const it of send) setResult(ctx, it, 'unknown', { http: r.status, message: 'The $batch response could not be matched to its requests; the outcome is unknown.' });
        adapt(ctx, 'batch', send.length, ms, false);
        break;
      }
      const again = [];
      let waitS = 0, throttled = false, partTokens = false, slow = false;
      const retry = (list, out) => {
        if (!countTry(tries, list)) { for (const it of list) setResult(ctx, it, 'failed', out.extra); return; }
        again.push(...list);
        waitS = Math.max(waitS, out.retry);
        throttled ||= out.throttle;
      };
      const single = (it, part) => {
        const token = tokenOf(part.headers);
        if (token != null) partTokens = true;
        const out = partOutcome(ctx, it, part, r.headers);
        if (timeoutLike(part.status, out.extra?.code ?? out.err?.code)) slow = true;
        if (out.retry != null) { retry([it], out); return; }
        if (out.auth) ctx.authStop = true;
        setResult(ctx, it, out.status, out.extra);
        keepToken(ctx, token, [it]);
      };
      // The outcome of an answer that names no op, for every op of a change set: the same for all of them, else
      // 'failed' with the part's message.
      const sameForAll = (items, part) => {
        const outs = items.map(it => partOutcome(ctx, it, part, r.headers));
        const a = outs[0];
        const alike = o => (o.retry != null) === (a.retry != null) && o.status === a.status && o.extra?.reason === a.extra?.reason && !!o.auth === !!a.auth;
        if (outs.every(alike)) return a;
        const err = errorOf(part);
        return { status: 'failed', extra: { http: part.status, code: err.code, message: err.message } };
      };
      // A change set that did not commit (02 §1: it is atomic, so one outcome holds for every op of it): all parts
      // throttled re-send it; throttled parts beside committed ones, or a 5xx part, make every op 'unknown'; an
      // expired session fails every op; otherwise the failing part decides, by the rules of the op it answers.
      const setFailed = (u, m) => {
        const parts = m.parts ?? [m.fail];
        if (parts.some(p => tokenOf(p.headers) != null)) partTokens = true;
        for (const p of parts) if (!isOk(p) && timeoutLike(p.status, errorOf(p).code)) slow = true;
        let out;
        if (m.parts) {
          const outs = m.parts.map((p, x) => partOutcome(ctx, u.items[x], p, r.headers));
          if (outs.every(o => o.retry != null)) { retry(u.items, outs[0]); return; }
          const bad = [];
          m.parts.forEach((p, x) => { if (!isOk(p)) bad.push(x); });
          const auth = bad.find(x => outs[x].auth);
          const server = bad.find(x => m.parts[x].status >= 500);
          if (auth != null) out = outs[auth];
          else if (server != null) out = outs[server];
          else if (bad.every(x => outs[x].retry != null)) {
            out = { status: 'unknown', extra: { ...outs[bad[0]].extra, message: 'Dataverse answered part of a change set with a throttling error and the rest as done; the outcome is unknown.' } };
          } else out = outs[bad.find(x => outs[x].retry == null)];
        } else {
          out = m.at != null ? partOutcome(ctx, u.items[m.at], m.fail, r.headers) : sameForAll(u.items, m.fail);
          if (out.retry != null) { retry(u.items, out); return; }
        }
        if (out.auth) ctx.authStop = true;
        for (const it of u.items) setResult(ctx, it, out.status, out.extra);
      };
      units.forEach((u, k) => {
        const m = matched[k];
        if (!u.set) {
          if (m.part) single(u.items[0], m.part);
          else setResult(ctx, u.items[0], 'unknown', { http: r.status, message: 'Dataverse stopped the $batch before answering this request; the outcome is unknown.' });
          return;
        }
        // a change set committed: each op has its own 2xx part
        if (m.parts?.every(isOk)) { u.items.forEach((it, x) => single(it, m.parts[x])); return; }
        if (m.parts || m.fail) { setFailed(u, m); return; }
        const message = m.missing ? 'Dataverse stopped the $batch before answering this change set; the outcome is unknown.'
          : 'The change set response could not be matched to its requests; the outcome is unknown.';
        for (const it of u.items) setResult(ctx, it, 'unknown', { http: r.status, message });
      });
      if (!partTokens) keepToken(ctx, tokenOf(r.headers), send);
      adapt(ctx, 'batch', send.length, ms, slow);
      progress(ctx);
      if (!again.length) break;
      if (halted(ctx, true)) { markNotSent(ctx, again); break; }
      if (throttled) await throttleWait(waitS, null, true); else await wait(waitS * 1000, null);
      send = again;
      resend = true;
    }
    progress(ctx);
    return checkFailed || unitFailed(ctx, items);
  }

  // Creates sent as single $batch POST parts at the adaptive batch size (bisection halves and the CreateMultiple
  // fallback).
  async function runSingles(items, ctx, insideFailedRequest) {
    let failed = false;
    for (let i = 0; i < items.length;) {
      if (halted(ctx, insideFailedRequest)) break;
      const slice = items.slice(i, i + ctx.size);
      i += slice.length;
      if (await runBatch(slice, ctx, insideFailedRequest)) {
        failed = true;
        if (!insideFailedRequest && !ctx.o.continueOnError) ctx.failStop = true;
      }
    }
    return failed;
  }

  function cmHeaders(g) {
    const h = { 'Accept': 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'Content-Type': 'application/json; charset=utf-8', 'Prefer': 'odata.include-annotations="*"' };
    if (caller) h.MSCRMCallerID = caller.id;
    for (const [k, v] of g.headers) h[k] = v;
    return h;
  }

  // The kind of the table behind a failed CreateMultiple: 'elastic' (not atomic), 'standard' (atomic, bisected), or
  // why it cannot be told: 'unread' (TableType could not be read), 'virtual' (neither standard nor elastic) or
  // 'contradictory' (the grant says standard, an op carries a partitionId); then every op of the request is
  // 'unknown', never re-sent. The grant's createMultiple.elastic decides; without it (the 02 §8.2 {chunk} shape) an
  // op with a partitionId means elastic, else the 02 §2 kind rule (tableKind) is applied to TableType and
  // DataProviderId, read once per table and write.
  function failureKind(ctx, items) {
    const flag = ctx.g.options.createMultiple?.elastic;
    const partitioned = items.some(it => it.partitionId != null);
    if (flag === true) return 'elastic';
    if (flag === false) return partitioned ? 'contradictory' : 'standard';
    if (partitioned) return 'elastic';
    const entity = items[0].entity;
    let p = ctx.kinds.get(entity);
    if (!p) {
      p = get(`EntityDefinitions(LogicalName=${odataString(entity)})?$select=TableType,DataProviderId`).then(j => {
        const t = typeof j?.TableType === 'string' ? j.TableType : j?.TableType?.Value;
        if (typeof t !== 'string' || t === '') return 'unread';
        return tableKind(t, isGuid(j?.DataProviderId) ? j.DataProviderId : null);
      }, e => {
        if (e instanceof DataverseError && e.code === 'auth') ctx.authStop = true;
        return 'unread';
      });
      ctx.kinds.set(entity, p);
    }
    return p;
  }
  const KIND_UNKNOWN = {
    unread: m => `CreateMultiple failed (${m}), and whether the table is elastic could not be read; the outcome is unknown.`,
    virtual: m => `CreateMultiple failed (${m}) on a table that is neither standard nor elastic; the outcome is unknown.`,
    contradictory: m => `CreateMultiple failed (${m}), and the confirmation names a standard table although its records carry a partition id; the outcome is unknown.`,
  };

  // One CreateMultiple request (whole re-send after 429 / 0x80048105, Stop checked before each). Sets the ops'
  // results, or returns {atomic: err} for a standard-table failure that created nothing (the caller bisects it).
  // `half` marks a bisection half, which leaves the adaptive CreateMultiple size alone.
  async function cmRequest(items, ctx, half) {
    const href = resolve(`${items[0].entitySet}/${NS}CreateMultiple`);
    const body = '{"Targets":[' + items.map(cmTarget).join(',') + ']}';
    const headers = cmHeaders(ctx.g);
    const all = (status, extra) => { for (const it of items) setResult(ctx, it, status, { bulk: true, ...extra }); };
    const sized = (ms, halve) => { if (!half) adapt(ctx, 'cm', items.length, ms, halve); };
    for (let tries = 0; ; tries++) {
      const gate = await sendGate(ctx, items, tries > 0 || half, tries > 0);
      if (!gate.items) return null;
      const t0 = Date.now();
      const res = await writeTransmit(href, 'POST', headers, body);
      const ms = Date.now() - t0;
      if (res.kind !== 'response') {
        if (res.kind === 'timeout') sized(ms, true);
        all('unknown', { message: lostMessage(res.kind) });
        return null;
      }
      const r = res.r;
      if (isAuth(r)) { ctx.authStop = true; all('failed', { http: r.status || 401, code: 'auth', message: errorOf(r).message }); return null; }
      if (ok(r)) {
        sized(ms, false);
        const ids = tryJson(r.text)?.Ids;
        if (!Array.isArray(ids) || ids.length !== items.length || !ids.every(isGuid)) {
          all('unknown', { http: r.status, message: 'CreateMultiple answered without one record id per target; the outcome is unknown.' });
          return null;
        }
        items.forEach((it, i) => setResult(ctx, it, 'ok', { http: r.status, newId: lower(ids[i]), bulk: true }));
        keepToken(ctx, tokenOf(r.headers), items);
        return null;
      }
      const err = errorOf(r);
      if (r.status === 429 || err.code === CONCURRENT) {
        if (tries >= RETRIES) { all('failed', { http: r.status, code: err.code, message: err.message }); return null; }
        if (halted(ctx, true)) { markNotSent(ctx, items); return null; }
        if (r.status === 429) await throttleWait(retryAfter(r.headers), null, true); else await wait(CONCURRENT_WAIT_MS, null);
        continue;
      }
      if (timeoutLike(r.status, err.code)) sized(ms, true);
      if (r.status >= 500 || err.code === 'notjson') {
        all('unknown', { http: r.status, code: err.code, message: `Dataverse answered HTTP ${r.status} (${err.message}); the outcome is unknown.` });
        return null;
      }
      const kind = await failureKind(ctx, items);
      if (kind === 'standard') return { atomic: err };
      if (kind === 'elastic') {
        applyBulkDetails(ctx, items, r, err);
        keepToken(ctx, tokenOf(r.headers), items);
        return null;
      }
      all('unknown', { http: r.status, code: err.code, message: KIND_UNKNOWN[kind](err.message) });
      return null;
    }
  }

  // Elastic CreateMultiple failure (not atomic): listed targets failed, every other target was created (02 §8.1).
  // A listed StatusCode 409 or 412 is a duplicate, 'skipped' under IGNORE_DUP_KEY.
  function applyBulkDetails(ctx, items, r, err) {
    const raw = err.details?.[BULK_DETAILS];
    let list = null;
    try { list = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { list = null; }
    const failedAt = new Map();
    let valid = Array.isArray(list) && list.length > 0;
    if (valid) {
      // An entry names its target by RequestIndex (0-based) and by Id (the target's client id), which must agree; an
      // Id alone names the target with that id. The property is unverified (02 §8.1), so details that disagree
      // with the request are garbled: the outcome of the request is then unknown, never guessed.
      const byId = new Map(items.map((it, i) => [it.id, i]));
      for (const d of list) {
        if (!plain(d)) { valid = false; break; }
        const id = d.Id == null ? null : isGuid(d.Id) ? lower(d.Id) : undefined;
        let i = d.RequestIndex;
        if (i == null) i = id == null ? undefined : byId.get(id);
        if (id === undefined || !Number.isInteger(i) || i < 0 || i >= items.length || (id != null && items[i].id !== id) || failedAt.has(i)) { valid = false; break; }
        failedAt.set(i, d);
      }
    }
    if (!valid) {
      for (const it of items) setResult(ctx, it, 'unknown', { http: r.status, code: err.code, bulk: true, message: `CreateMultiple failed (${err.message}) without saying which records; the outcome is unknown.` });
      return;
    }
    items.forEach((it, i) => {
      const d = failedAt.get(i);
      if (!d) { setResult(ctx, it, 'ok', { http: r.status, newId: it.id, bulk: true }); return; }
      const sc = Number.isInteger(d.StatusCode) ? d.StatusCode : r.status;
      if (ctx.o.ignoreDupKey && (sc === 409 || sc === 412)) setResult(ctx, it, 'skipped', { http: sc, code: err.code, reason: 'duplicate', message: err.message, bulk: true });
      else setResult(ctx, it, 'failed', { http: sc, code: err.code, message: err.message, bulk: true });
    });
  }

  async function runCmUnit(u, ctx) {
    if (ctx.cmFallback) return runSingles(u.items, ctx, false);
    const r = await cmRequest(u.items, ctx, false);
    progress(ctx);
    if (r?.atomic) await bisect(u.items, r.atomic, ctx);
    return unitFailed(ctx, u.items);
  }

  const errKey = e => e.code ?? e.message;

  // Standard-table bisection: halves re-sent as CreateMultiple, one-record halves as single creates (02 §8.1).
  async function bisect(items, err, ctx) {
    const mid = Math.ceil(items.length / 2);
    const outcomes = [];
    for (const h of [items.slice(0, mid), items.slice(mid)]) {
      if (halted(ctx, true)) { outcomes.push({ stopped: true }); continue; }
      if (ctx.cmFallback) { outcomes.push({ items: h, failed: true, pending: true, err }); continue; }
      if (h.length === 1) {
        await runBatch(h, ctx, true);
        const res = ctx.results[h[0].index];
        if (!res || res.status === 'notAttempted') { outcomes.push({ stopped: true }); continue; }
        outcomes.push({ items: h, failed: res.status === 'failed', key: res.code ?? res.message, pending: false });
      } else {
        const r = await cmRequest(h, ctx, true);
        progress(ctx);
        if (r?.atomic) outcomes.push({ items: h, failed: true, key: errKey(r.atomic), err: r.atomic, pending: true });
        else if (h.some(it => ctx.results[it.index]?.status === 'notAttempted')) outcomes.push({ stopped: true });
        else outcomes.push({ items: h, failed: false, pending: false });
      }
    }
    if (!ctx.cmFallback && outcomes.length === 2 && outcomes.every(x => x.failed && x.key === errKey(err))) {
      ctx.cmFallback = Object.freeze({ entity: items[0].entity, code: err.code, message: err.message });
      for (const x of outcomes) if (x.pending) await runSingles(x.items, ctx, true);
      return;
    }
    for (const x of outcomes) {
      if (!x.pending) continue;
      if (ctx.cmFallback) await runSingles(x.items, ctx, true);
      else await bisect(x.items, x.err, ctx);
    }
  }

  // ----- the api object --------------------------------------------------------------------------------

  const api = Object.freeze({
    origin,
    base,
    get,
    fetchXml,
    batchGet,
    csdl,
    fn,
    whoAmI,
    org,
    version: versionOf,
    findBulkDeleteJob,
    write,
    // True while changes are off (read-only), the default at launch.
    isReadOnly() { checkExpiry(); return !allowed; },
    // {allowed, expiresAt, writing}: the app-wide changes window (00 §5 rule 1).
    mode() { checkExpiry(); return { allowed, expiresAt, writing: writesActive > 0 }; },
    // Subscribes to mode, caller and write-state changes; returns the unsubscribe function.
    onModeChange(fn2) {
      if (typeof fn2 !== 'function') throw new TypeError('onModeChange: a function is required.');
      modeListeners.add(fn2);
      return () => { modeListeners.delete(fn2); };
    },
    setCaller,
    // The impersonated user {id, name}, or null.
    caller() { return caller ? { ...caller } : null; },
    // True while an api.write call is running.
    writing() { return writesActive > 0; },
    get stats() { return { ...stats }; },
    // Subscribes to service-protection waits ({seconds, until, write}); returns the unsubscribe function.
    onThrottle(cb) {
      if (typeof cb !== 'function') throw new TypeError('onThrottle: a function is required.');
      throttleListeners.add(cb);
      return () => { throttleListeners.delete(cb); };
    },
    get dop() { return dop; },
  });
  return { api, writeCaps: Object.freeze({ createGrant, setReadOnly }) };
}
