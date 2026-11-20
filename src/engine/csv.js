// Load CSV as #temp and Load file as text (02 §9 CSV import): decoding (BOM,
// strict UTF-8, Windows-1252), RFC 4180 records with the quote/escape options, delimiter detection, header detection,
// per-column type inference (rules 1-10) and the conversion of every value with types.js castValue under the tab's
// SET DATEFORMAT. Nothing here touches the network; the rows live only in the session's memory.
import { castValue } from './types.js';
import { msg } from './messages.js';
import { sqlIdent } from '../core/util.js';

export const CSV_NAME_RE = /^#[A-Za-z_][A-Za-z0-9_]{0,114}$/;
export const CSV_NAME_MESSAGE = 'Temp table names start with # followed by a letter or _, then letters, digits or _ (at most 116 characters).';
const MB50 = 50 * 1024 * 1024;
const GUID_RE = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;
const REFUSED_TYPES = new Set(['xml', 'sql_variant', 'text', 'ntext']);
const STRING_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar']);
const NUMERIC_TYPES = new Set(['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney']);

const lower = s => String(s ?? '').toLowerCase();
const int = n => Number(n).toLocaleString('en-US');
const abortError = () => Object.assign(new Error('Import cancelled.'), { name: 'AbortError' });

// Decodes CSV or text bytes (02 §9 Decoding): BOM UTF-8 / UTF-16 LE / BE, else strict UTF-8, else Windows-1252.
export function decodeBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? new ArrayBuffer(0));
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'utf-8' };
  if (u8[0] === 0xff && u8[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16le' };
  if (u8[0] === 0xfe && u8[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'utf-16be' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8' }; } catch {
    return { text: new TextDecoder('windows-1252').decode(u8), encoding: 'windows-1252', warn: 'The file is not valid UTF-8; it was read as Windows-1252.' };
  }
}

// The records of a CSV text: [{f: [{v, q}], line}] (RFC 4180 with the quote and escape options).
export function splitRecords(text, delim, quote, escape) {
  const out = [];
  let i = 0, line = 1;
  const n = text.length;
  while (i < n) {
    const startLine = line;
    if (text[i] === '\n' || text[i] === '\r') { if (text[i] === '\r' && text[i + 1] === '\n') i++; i++; line++; continue; }
    const f = [];
    let cur = '', q = false, quotedField = false, after = false;
    for (;;) {
      if (i >= n) { if (q) throw new Error(`CSV line ${startLine}: a quoted field is not closed.`); f.push({ v: cur, q: quotedField }); break; }
      const c = text[i];
      if (escape && c === escape && i + 1 < n && text[i + 1] !== '\n' && text[i + 1] !== '\r') { cur += text[i + 1]; i += 2; continue; }
      if (q) {
        if (c === quote) { if (!escape && text[i + 1] === quote) { cur += quote; i += 2; continue; } q = false; after = true; i++; continue; }
        if (c === '\n' || c === '\r') { line++; if (c === '\r' && text[i + 1] === '\n') { cur += '\r\n'; i += 2; continue; } }
        cur += c; i++; continue;
      }
      if (c === delim) { f.push({ v: cur, q: quotedField }); cur = ''; quotedField = false; after = false; i++; continue; }
      if (c === '\n' || c === '\r') { f.push({ v: cur, q: quotedField }); if (c === '\r' && text[i + 1] === '\n') i++; i++; line++; break; }
      if (after) throw new Error(`CSV line ${startLine}: unexpected text after a closing quote.`);
      if (quote && c === quote && cur === '' && !quotedField) { q = true; quotedField = true; i++; continue; }
      cur += c; i++;
    }
    out.push({ f, line: startLine });
  }
  return out;
}

// The delimiter of 'auto' (02 §9 Delimiter): `.tsv` -> tab; else the candidate whose same non-zero count outside quotes
// appears on the most of the first 20 lines (ties in the order , ; tab |); none -> ','.
export function detectDelimiter(text, name) {
  if (/\.tsv$/i.test(name ?? '')) return '\t';
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.length).slice(0, 20);
  let best = ',', bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = new Map();
    for (const l of lines) {
      let k = 0, q = false;
      for (const c of l) { if (c === '"') q = !q; else if (c === d && !q) k++; }
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const score = Math.max(0, ...counts.values());
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

const pad0 = v => String(v ?? '').replace(/^[ \t]+|[ \t]+$/g, '');
const INT_RE = /^[+-]?(0|[1-9][0-9]*)$/;
const decRe = d => new RegExp(`^[+-]?((0|[1-9][0-9]*)(${d === ',' ? ',' : '\\.'}[0-9]*)?|${d === ',' ? ',' : '\\.'}[0-9]+)$`);
const floatRe = d => new RegExp(`^[+-]?((0|[1-9][0-9]*)(${d === ',' ? ',' : '\\.'}[0-9]*)?|${d === ',' ? ',' : '\\.'}[0-9]+)([eE][+-]?[0-9]+)?$`);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?$/;
const DTO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(Z|[+-]\d{2}:\d{2})$/;
const validDate = (y, m, d) => { const t = new Date(Date.UTC(+y, +m - 1, +d)); return t.getUTCFullYear() === +y && t.getUTCMonth() === +m - 1 && t.getUTCDate() === +d; };
const NVAR = [50, 100, 255, 500, 1000, 4000];

function dt(name, args = []) {
  return { dataType: { name, args }, typeText: args.length ? `${name}(${args.join(',')})` : name };
}
export const typeText = d => (d?.args?.length ? `${d.name}(${d.args.join(',')})` : d?.name ?? 'nvarchar(max)');

// The inferred DataType of a column (02 §9 Type inference, rules 1-10): {dataType, typeText}.
export function inferType(values, dec) {
  const vals = values.filter(v => v != null).map(pad0);
  const raw = values.filter(v => v != null);
  const all = test => vals.length > 0 && vals.every(test);
  if (all(v => /^(true|false)$/i.test(v))) return dt('bit');
  if (all(v => INT_RE.test(v) && Number(v) >= -2147483648 && Number(v) <= 2147483647)) return dt('int');
  if (all(v => INT_RE.test(v) && Number.isSafeInteger(Number(v)))) return dt('bigint');
  const dr = decRe(dec);
  if (all(v => dr.test(v))) {
    let s = 0, ip = 0;
    for (const v of vals) { const [a, b = ''] = v.replace(/^[+-]/, '').split(dec); s = Math.max(s, b.length); ip = Math.max(ip, a.replace(/^0+(?=\d)/, '').length); }
    if (ip + s <= 38) return dt('decimal', [Math.max(1, ip + s), s]);
  }
  const fr = floatRe(dec);
  if (all(v => fr.test(v) && Number.isFinite(Number(v.replace(',', '.'))))) return dt('float');
  if (all(v => GUID_RE.test(v))) return dt('uniqueidentifier');
  if (all(v => { const m = DATE_RE.exec(v); return !!m && validDate(m[1], m[2], m[3]); })) return dt('date');
  if (all(v => { const m = DT_RE.exec(v); return !!m && validDate(m[1], m[2], m[3]); })) return dt('datetime2', [Math.max(0, ...vals.map(v => (DT_RE.exec(v)[7] ?? '').length))]);
  if (all(v => { const m = DTO_RE.exec(v); return !!m && validDate(m[1], m[2], m[3]); })) return dt('datetimeoffset', [Math.max(0, ...vals.map(v => (DTO_RE.exec(v)[7] ?? '').length))]);
  const longest = Math.max(0, ...raw.map(v => v.length));
  if (!raw.length) return dt('nvarchar', [255]);
  return dt('nvarchar', [NVAR.find(L => longest <= L) ?? 'max']);
}
const isTyped = v => { const x = pad0(v); return /^(true|false)$/i.test(x) || INT_RE.test(x) || decRe('.').test(x) || floatRe('.').test(x) || GUID_RE.test(x) || DATE_RE.test(x) || DT_RE.test(x) || DTO_RE.test(x); };

// The #temp name suggested for a file (02 §9 Name).
export function tempName(fileName) {
  let b = lower(String(fileName ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')).replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
  if (b && !/^[a-z_]/.test(b)) b = 't_' + b;
  b = b.slice(0, 115);
  return '#' + (b || 'csv');
}

// Parses and infers one or several CSV files (02 §9 previewCsv): a CsvPreview.
export async function previewCsvFiles(files, opt = {}) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (opt.signal?.aborted) throw abortError();
  if (!list.length) throw new Error('The file contains no rows.');
  const total = list.reduce((a, f) => a + (f.bytes?.byteLength ?? 0), 0);
  if (total > MB50) throw new Error('The file is larger than 50 MB. Split it or remove columns first.');
  const quote = opt.quote === undefined ? '"' : opt.quote;
  const escape = opt.escape ?? null;
  const firstRow = Number.isInteger(opt.firstRow) && opt.firstRow >= 1 ? opt.firstRow : 1;
  const lastRow = Number.isInteger(opt.lastRow) ? opt.lastRow : null;
  if (lastRow != null && lastRow < firstRow) throw new Error('Last row must not be before first row.');
  const nullWord = opt.nullWord !== false;
  const warnings = [];
  let encoding = null, delimiter = null, header = null, names = null, m = 0;
  const rows = [], lines = [];
  let ragged = 0;
  for (let fi = 0; fi < list.length; fi++) {
    const f = list[fi];
    const dec = decodeBytes(f.bytes);
    if (fi === 0) encoding = dec.encoding;
    if (dec.warn && !warnings.includes(dec.warn)) warnings.push(dec.warn);
    let text = dec.text;
    let lineShift = 0;
    const sep = /^sep=(.)\r?\n/.exec(text);
    let d = opt.delimiter && opt.delimiter !== 'auto' ? opt.delimiter : null;
    if (sep) { if (!d) d = sep[1]; text = text.slice(sep[0].length); lineShift = 1; }
    if (!d) d = detectDelimiter(text, f.name);
    if (fi === 0) delimiter = d;
    const recs = splitRecords(text, d, quote, escape).map(r => ({ ...r, line: r.line + lineShift }));
    if (!recs.length) { if (fi === 0) throw new Error('The file contains no rows.'); continue; }
    let hdr;
    if (opt.header === true || opt.header === 'yes') hdr = true;
    else if (opt.header === false || opt.header === 'no') hdr = false;
    else {
      const first = recs[0].f.map(x => x.v);
      const seen = new Set();
      hdr = first.every(v => v.trim() !== '' && !seen.has(lower(v.trim())) && seen.add(lower(v.trim())) && !isTyped(v));
    }
    const fileNames = hdr ? recs[0].f.map(x => x.v.trim()) : null;
    if (fi === 0) {
      header = hdr;
      m = recs[0].f.length;
      const out = [];
      for (let i = 0; i < m; i++) {
        let nm = hdr ? (fileNames[i] || `column${i + 1}`).slice(0, 128) : `column${i + 1}`;
        const base = nm;
        let k = 2;
        while (out.some(x => lower(x) === lower(nm))) nm = `${base}_${k++}`;
        out.push(nm);
      }
      names = out;
      if (m > 1024) throw new Error(`The file has ${int(m)} columns; a table can have at most 1,024.`);
    } else if (recs[0].f.length !== m || (header && fileNames && fileNames.some((x, i) => lower(x) !== lower(names[i])))) {
      throw new Error(`${f.name} has different columns than ${list[0].name}.`);
    }
    const data = hdr ? recs.slice(1) : recs;
    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      if (r.f.length > m) throw new Error(`CSV line ${r.line} has ${r.f.length} fields; expected ${m}.`);
      const k = i + 1;
      if (k < firstRow || (lastRow != null && k > lastRow)) continue;
      if (r.f.length < m) ragged++;
      const vals = [];
      for (let j = 0; j < m; j++) {
        const x = r.f[j];
        if (!x) { vals.push(null); continue; }
        if (!x.q && (x.v === '' || (nullWord && /^null$/i.test(x.v)))) { vals.push(null); continue; }
        vals.push(x.v);
      }
      if (list.length > 1) vals.push(f.name.replace(/^.*[\\/]/, ''));
      rows.push(vals);
      lines.push(r.line);
      if (rows.length % 10000 === 0) {
        await new Promise(res => setTimeout(res, 0));
        if (opt.signal?.aborted) throw abortError();
      }
    }
  }
  if (!rows.length) throw new Error('The file contains no rows.');
  const max = opt.maxScanRows ?? 500000;
  if (rows.length > max) throw new Error(`The file has more than ${int(max)} rows (setting Max rows processed in the browser). Raise the limit in Settings or split the file.`);
  if (ragged) warnings.push(`${int(ragged)} rows had fewer than ${m} fields; the missing values are NULL.`);
  const dsym = opt.decimal === '.' || opt.decimal === ',' ? opt.decimal : delimiter !== ',' && opt.decimalSymbol === ',' ? ',' : '.';
  const allNames = list.length > 1 ? [...names, 'filename'] : names;
  const columns = allNames.map((name, j) => {
    const vals = rows.map(r => r[j]);
    const isFile = list.length > 1 && j === allNames.length - 1;
    const t = isFile ? dt('nvarchar', [260]) : inferType(vals, dsym);
    return {
      name, dataType: t.dataType, typeText: t.typeText, nullCount: vals.filter(v => v == null).length,
      maxLength: Math.max(0, ...vals.filter(v => v != null).map(v => v.length)), samples: vals.filter(v => v != null).slice(0, 5), ...(isFile ? { fixed: true } : {}),
    };
  });
  const nm = tempName(list[0].name);
  return {
    fileName: list[0].name, files: list.map(f => f.name), encoding, delimiter, decimal: dsym, header, quote, escape, firstRow, lastRow, name: nm,
    exists: false, columns, rowCount: rows.length, sampleRows: rows.slice(0, 20), warnings, rows, lines,
  };
}

// Converts one CSV text to a column type with castValue (02 §9 loadCsv): the value, or throws SQL Server's message.
export function convertValue(text, dataType, { decimal = '.', dateformat = 'mdy', tz = null, table = '#t', column = 'c' } = {}) {
  if (text == null) return null;
  const name = lower(dataType?.name ?? 'nvarchar');
  if (STRING_TYPES.has(name)) {
    const L = dataType.args?.[0];
    if (Number.isInteger(L) && text.length > L) {
      const m = msg(2628, table, column, text.slice(0, L));
      throw Object.assign(new Error(m.message), { number: m.number, severity: m.severity, state: 1 });
    }
    return text;
  }
  let v = pad0(text);
  if (v === '') return null;
  if (NUMERIC_TYPES.has(name) && decimal === ',') v = v.replace(',', '.');
  if (name === 'uniqueidentifier') v = v.replace(/^\{(.*)\}$/, '$1');
  if (name === 'bit' && /^(true|false)$/i.test(v)) return /^true$/i.test(v) ? 1 : 0;
  return castValue(v, { dt: 'string', len: -1, unicode: true }, dataType, { dateformat, tz });
}

// Converts a CsvPreview's rows to the chosen column types (02 §9 loadCsv): {columns, rows, messages, createText(name)}.
export async function convertCsv(preview, { columns, onError = 'fail', maxErrors = 10, dateformat = 'mdy', tz = null, signal = null, progress = null, name = '#t' } = {}) {
  const cols = Array.isArray(columns) && columns.length ? columns : preview.columns;
  const seen = new Set();
  for (const c of cols) {
    const n = String(c.name ?? '');
    if (!n.trim() || n.length > 128 || seen.has(lower(n))) throw new Error(`The column name '${n}' is empty, repeated or longer than 128 characters.`);
    seen.add(lower(n));
    const t = lower(c.dataType?.name ?? 'nvarchar');
    if (REFUSED_TYPES.has(t)) throw new Error(`Column '${n}' cannot have the type ${t}: choose nvarchar(max) or another type.`);
  }
  const out = [], bad = [];
  const dsym = preview.decimal ?? '.';
  const total = preview.rows.length;
  progress?.(0);
  for (let i = 0; i < total; i++) {
    const src = preview.rows[i];
    const row = new Array(cols.length);
    let err = null;
    for (let j = 0; j < cols.length; j++) {
      try {
        row[j] = convertValue(src[j], cols[j].dataType ?? { name: 'nvarchar', args: ['max'] }, { decimal: dsym, dateformat, tz, table: name, column: cols[j].name });
      } catch (e) { err = `CSV line ${preview.lines?.[i] ?? i + 2}, column '${cols[j].name}': ${e.message}`; break; }
    }
    if (err) {
      if (onError !== 'skip') throw new Error(err);
      bad.push(err);
      continue;
    }
    out.push(row);
    if (i && i % 5000 === 0) {
      progress?.(Math.round((i / total) * 100));
      await new Promise(res => setTimeout(res, 0));
      if (signal?.aborted) throw abortError();
    }
  }
  const limit = Number.isInteger(maxErrors) ? maxErrors : 10;
  if (bad.length > limit) throw new Error(`${int(bad.length)} rows could not be converted (limit ${int(limit)}).`);
  const messages = bad.slice(0, 100);
  if (bad.length > 100) messages.push(`… and ${int(bad.length - 100)} more.`);
  progress?.(100);
  return {
    columns: cols.map(c => ({ name: String(c.name), dataType: c.dataType ?? { name: 'nvarchar', args: ['max'] } })), rows: out, messages,
    createText: n => `CREATE TABLE ${n} (${cols.map(c => `${sqlIdent(String(c.name))} ${typeText(c.dataType ?? { name: 'nvarchar', args: ['max'] })} NULL`).join(', ')});`,
  };
}

// 'Load file as text' (02 §9): the one value of BulkColumn (nvarchar(max) text, or varbinary(max) bytes).
export function loadFileRows(file, { binary = false } = {}) {
  const bytes = file?.bytes instanceof ArrayBuffer ? new Uint8Array(file.bytes) : file?.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(0);
  if (bytes.byteLength > MB50) throw new Error('The file is larger than 50 MB.');
  if (binary) return { value: bytes.slice(), size: bytes.byteLength };
  const d = decodeBytes(bytes);
  return { value: d.text, size: d.text.length, warn: d.warn ?? null };
}
