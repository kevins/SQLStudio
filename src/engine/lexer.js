// SQL tokenizer shared by the parser, the formatter and the editor highlighter.
// Tokens: { t, v, s, e, k?, raw?, int?, float? }  (see 01 §3)

export class SqlError extends Error {
  constructor(message, pos = null, end = null) {
    super(message);
    this.name = 'SqlError';
    this.pos = pos;
    this.end = end ?? (pos == null ? null : pos + 1);
  }
}

const TWO = new Set(['<>', '!=', '>=', '<=', '!<', '!>', '+=', '-=', '*=', '/=', '%=', '::', '||']);
const ONE = '=<>+-*/%(),.;!&|^~:';
const isWs = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff';
const isDigit = c => c >= '0' && c <= '9';
const isIdStart = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '#' || (c > '\u007f' && !isWs(c));
const isIdPart = c => isIdStart(c) || isDigit(c) || c === '$' || c === '@';

// keepAll: also emit whitespace ('ws'), comments ('cmt') and unknown characters ('bad'), and never throw
// (unterminated strings/comments/identifiers get `open: true`). Used by the editor.
export function tokenize(src, keepAll = false) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const s = i;
    if (isWs(c)) {
      while (i < n && isWs(src[i])) i++;
      if (keepAll) out.push({ t: 'ws', v: src.slice(s, i), s, e: i });
      continue;
    }
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i++;
      if (keepAll) out.push({ t: 'cmt', v: src.slice(s, i), s, e: i });
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth) {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2; }
        else if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      if (depth && !keepAll) throw new SqlError("Missing end comment mark '*/'.", s, n);
      if (keepAll) out.push({ t: 'cmt', v: src.slice(s, i), s, e: i, open: depth > 0 });
      continue;
    }
    if (c === "'" || ((c === 'N' || c === 'n') && src[i + 1] === "'")) {
      i += c === "'" ? 1 : 2;
      let v = '';
      let closed = false;
      while (i < n) {
        const ch = src[i];
        if (ch === "'") {
          if (src[i + 1] === "'") { v += "'"; i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        v += ch;
        i++;
      }
      if (!closed && !keepAll) throw new SqlError(`Unclosed quotation mark after the character string '${v.slice(0, 40)}'.`, s, n);
      out.push(closed ? { t: 'str', v, s, e: i } : { t: 'str', v, s, e: i, open: true });
      continue;
    }
    if (c === '[' || c === '"') {
      const close = c === '[' ? ']' : '"';
      i++;
      let v = '';
      let closed = false;
      while (i < n) {
        if (src[i] === close) {
          if (src[i + 1] === close) { v += close; i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        v += src[i++];
      }
      if (!closed && !keepAll) throw new SqlError(`Unclosed quotation mark after the identifier '${v.slice(0, 40)}'.`, s, n);
      out.push(closed ? { t: 'qid', v, s, e: i } : { t: 'qid', v, s, e: i, open: true });
      continue;
    }
    if (c === '@') {
      i++;
      if (src[i] === '@') i++;
      while (i < n && isIdPart(src[i])) i++;
      const raw = src.slice(s, i);
      out.push({ t: 'var', v: raw.toLowerCase(), raw, s, e: i });
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(src[i])) i++;
        // Binary literal: v is the lower-case hex digits without 0x ('' for a bare 0x).
        const raw = src.slice(s, i);
        out.push({ t: 'num', v: raw.slice(2).toLowerCase(), bin: true, raw, s, e: i });
        continue;
      }
      while (i < n && isDigit(src[i])) i++;
      let isInt = true;
      let isFloat = false;
      if (src[i] === '.') {
        isInt = false;
        i++;
        while (i < n && isDigit(src[i])) i++;
      }
      if ((src[i] === 'e' || src[i] === 'E') && (isDigit(src[i + 1] || '') || ((src[i + 1] === '+' || src[i + 1] === '-') && isDigit(src[i + 2] || '')))) {
        isInt = false;
        isFloat = true;
        i += 2;
        while (i < n && isDigit(src[i])) i++;
      }
      const raw = src.slice(s, i);
      const tok = { t: 'num', v: Number(raw), raw, s, e: i };
      if (isInt) tok.int = true;
      if (isFloat) tok.float = true;
      out.push(tok);
      continue;
    }
    if (isIdStart(c)) {
      i++;
      while (i < n && isIdPart(src[i])) i++;
      const v = src.slice(s, i);
      out.push({ t: 'id', v, k: v.toUpperCase(), s, e: i });
      continue;
    }
    const two = src.substr(i, 2);
    if (TWO.has(two)) {
      i += 2;
      out.push({ t: 'op', v: two, s, e: i });
      continue;
    }
    if (ONE.includes(c)) {
      i++;
      out.push({ t: 'op', v: c, s, e: i });
      continue;
    }
    i++;
    if (keepAll) { out.push({ t: 'bad', v: c, s, e: i }); continue; }
    throw new SqlError(`Incorrect syntax near '${c}'.`, s, i);
  }
  out.push({ t: 'end', v: '', s: n, e: n });
  return out;
}

// Line state for incremental highlighting: cmt = open block-comment nesting depth,
// quote = the closing character of an open string ("'") or bracketed/quoted identifier (']' or '"').
export const LINE0 = Object.freeze({ cmt: 0, quote: null });

// Block-comment nesting depth after scanning `text` from `depth` (stops early at depth 0 when `stop`).
function cmtScan(text, i, depth, stop) {
  while (i < text.length && (depth || !stop)) {
    if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2; }
    else if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2; if (!depth && stop) break; }
    else i++;
  }
  return { depth, i };
}

// Tokenize one editor line (keepAll tokens, offsets relative to the line), continuing from `state`.
// Returns { tokens, state } where state is LINE0 or the open comment/quote carried to the next line.
export function tokenizeLine(line, state = LINE0) {
  const tokens = [];
  let i = 0;
  if (state.cmt) {
    const r = cmtScan(line, 0, state.cmt, true);
    i = r.i;
    tokens.push({ t: 'cmt', v: line.slice(0, i), s: 0, e: i, open: r.depth > 0 });
    if (r.depth) return { tokens, state: { cmt: r.depth, quote: null } };
  } else if (state.quote) {
    const q = state.quote;
    let closed = false;
    while (i < line.length) {
      if (line[i] === q) {
        if (line[i + 1] === q) { i += 2; continue; }
        i++;
        closed = true;
        break;
      }
      i++;
    }
    tokens.push({ t: q === "'" ? 'str' : 'qid', v: line.slice(0, i), s: 0, e: i, open: !closed });
    if (!closed) return { tokens, state };
  }
  const rest = tokenize(line.slice(i), true);
  rest.pop();
  for (const t of rest) { t.s += i; t.e += i; tokens.push(t); }
  const last = tokens[tokens.length - 1];
  let next = LINE0;
  if (last && last.open && last.s >= i) {
    if (last.t === 'cmt') next = { cmt: cmtScan(line.slice(last.s), 0, 0, false).depth, quote: null };
    else if (last.t === 'str') next = { cmt: 0, quote: "'" };
    else if (last.t === 'qid') next = { cmt: 0, quote: line[last.s] === '[' ? ']' : '"' };
  }
  return { tokens, state: next };
}

// T-SQL reserved keywords: cannot be used as bare identifiers or implicit aliases.
export const RESERVED = new Set(('ADD ALL ALTER AND ANY AS ASC AUTHORIZATION BACKUP BEGIN BETWEEN BREAK BROWSE BULK BY CASCADE CASE CHECK ' +
  'CHECKPOINT CLOSE CLUSTERED COALESCE COLLATE COLUMN COMMIT COMPUTE CONSTRAINT CONTAINS CONTAINSTABLE CONTINUE CONVERT CREATE CROSS ' +
  'CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE DBCC DEALLOCATE DECLARE DEFAULT DELETE DENY DESC ' +
  'DISK DISTINCT DISTRIBUTED DOUBLE DROP DUMP ELSE END ERRLVL ESCAPE EXCEPT EXEC EXECUTE EXISTS EXIT EXTERNAL FETCH FILE FILLFACTOR ' +
  'FOR FOREIGN FREETEXT FREETEXTTABLE FROM FULL FUNCTION GOTO GRANT GROUP HAVING HOLDLOCK IDENTITY IDENTITY_INSERT IDENTITYCOL IF IN ' +
  'INDEX INNER INSERT INTERSECT INTO IS JOIN KEY KILL LEFT LIKE LINENO LOAD MERGE NATIONAL NOCHECK NONCLUSTERED NOT NULL NULLIF OF OFF ' +
  'OFFSETS ON OPEN OPENDATASOURCE OPENQUERY OPENROWSET OPENXML OPTION OR ORDER OUTER OVER PERCENT PIVOT PLAN PRECISION PRIMARY PRINT ' +
  'PROC PROCEDURE PUBLIC RAISERROR READ READTEXT RECONFIGURE REFERENCES REPLICATION RESTORE RESTRICT RETURN REVERT REVOKE RIGHT ROLLBACK ' +
  'ROWCOUNT ROWGUIDCOL RULE SAVE SCHEMA SECURITYAUDIT SELECT SEMANTICKEYPHRASETABLE SEMANTICSIMILARITYDETAILSTABLE SEMANTICSIMILARITYTABLE ' +
  'SESSION_USER SET SETUSER SHUTDOWN SOME STATISTICS SYSTEM_USER TABLE TABLESAMPLE TEXTSIZE THEN TO TOP TRAN TRANSACTION TRIGGER TRUNCATE ' +
  'TRY_CONVERT TSEQUAL UNION UNIQUE UNPIVOT UPDATE UPDATETEXT USE USER VALUES VARYING VIEW WAITFOR WHEN WHERE WHILE WITH WITHIN WRITETEXT').split(' '));

// Contextual keywords: valid identifiers in T-SQL, but highlighted and completed as keywords.
const CONTEXTUAL = 'ABSENT ABSOLUTE APPLY AT AUTO CALLER CATCH CUBE DATEFIRST DATEFORMAT DELAY DELETED ELEMENTS EXPLICIT ' +
  'FAST_FORWARD FIRST FOLLOWING FORWARD_ONLY GLOBAL GO GROUPING HINT INCLUDE_NULL_VALUES INSENSITIVE INSERTED ' +
  'JSON LANGUAGE LAST LOCAL LOGIN MAXRECURSION NEXT NOCOUNT NOLOCK OFFSET ONLY OUT OUTPUT PARTITION PATH ' +
  'PRECEDING PRIOR RANGE RAW READ_ONLY RELATIVE ROLLUP ROOT ROW ROWS SCROLL SETS STATIC THROW TIES TIME TRY TYPE ' +
  'UNBOUNDED WITHOUT_ARRAY_WRAPPER XMLNAMESPACES XSINIL ZONE';

// Every keyword the editor highlights (reserved + contextual), upper case.
export const KEYWORDS = new Set([...RESERVED, ...CONTEXTUAL.split(' ')]);
