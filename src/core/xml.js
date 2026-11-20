// The only XML parser in SQL Studio (01 §1, 00 §3): used by fetchxml.js (paging
// cookies, escaping), fetch2sql.js, the import-view flow, meta.js's $metadata scan and the xml
// data type and its methods (01 §5.8, §8.3). No module uses the browser's XML parser. Pure and DOM-free, so the
// same code runs in Edge 120 and in Node 22.
//
// Notes (01 §1 holds the contract: both shapes, the line/col/reason fields, the refusals, iterative linear
// parsing and the xmlEsc modes; XML 1.0 5th edition and Namespaces in XML 1.0 3rd edition are implemented, nothing
// else). Extensions beyond its text:
// - Options: parseXml(text, {mixed, label}); only `mixed: true` turns the mixed mode on (any other value, null
//   included, is the default mode). `label` names the document in error messages for callers that parse something
//   else than FetchXML in the default shape (meta.js's $metadata Function/Action elements, layoutxml, an XLSX part):
//   1 to 40 letters, digits, spaces, '$', '.', '-' or '_' (else TypeError).
// - Error prefix: `Invalid <label>: …`, the label being 'FetchXML' in the default mode and 'XML' in the mixed mode
//   unless one is given (an xml value is not FetchXML; types.js words its own 9400 from line, col and reason).
// - Mixed mode returns a document node {name: '#document', attrs: empty Map, kids, text} whose `parent` is null, not
//   the root element: an xml value may be a fragment (01 §5.8), so '' and whitespace-only text are valid documents
//   (no kids, or one #text kid), and text, CDATA, comments and processing instructions may appear at the top level.
//   It is the XPath root of 01 §8.3 (`/ROOT` is a child element of it, `..` of a top-level element reaches it). A
//   null or non-string text is an error in mixed mode too ('expected the XML text as a string').
// - Mixed-mode #text nodes are XPath text nodes: adjacent character data (text, CDATA sections and decoded
//   references) forms one #text node, which only a child element, a comment or a processing instruction splits;
//   whitespace-only ones are kept (01 §5.8's insignificant-whitespace rule is the serialiser's, types.js). A #pi
//   node's text is the content after the target and the whitespace that follows it. Elements keep `text` (their
//   direct character data) in mixed mode as well.
// - Namespaces (mixed mode only; 01 §8.3 matches names by namespace URI and local name): every element gets the
//   non-enumerable fields `prefix` ('' when none), `local`, `uri` (the namespace URI in scope, '' for none) and
//   `attrUris` (Map: attribute name as written -> '' when unprefixed, the declared URI when prefixed,
//   'http://www.w3.org/2000/xmlns/' for xmlns declarations); `xml` is bound to 'http://www.w3.org/XML/1998/namespace'.
//   Refused, as SQL Server's parser refuses them: a name that is not a QName (two colons, a leading or trailing
//   colon), an undeclared prefix, `xmlns:p=""`, declaring the prefix xmlns or binding the xml or xmlns namespace URI
//   to another prefix, the element prefix xmlns, and two attributes with one expanded name. The default mode does no
//   namespace processing (FetchXML has none, and meta.js hands it Function/Action elements cut out of $metadata,
//   whose prefixes are declared on an ancestor that is not part of the cut).
// - xmlEsc: any mode other than undefined, 'text' and 'attr' is a caller bug: TypeError `xmlEsc: unknown mode
//   '<mode>' (use 'text' or 'attr')`. In 'text' and 'attr' a character XML 1.0 cannot represent throws SqlError
//   `Invalid XML: the text contains U+XXXX, which XML 1.0 cannot represent.` (FOR XML output is not FetchXML); every
//   mode's error carries the extra field `codePoint`, so XmlOutput can word SQL Server's FOR XML error with the
//   node name. xmlSafe(s) does not depend on the mode: every mode refuses exactly the same values.

import { SqlError } from '../engine/lexer.js';

const NAMED = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['apos', "'"], ['quot', '"']]);
const START = ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NAME_RE = new RegExp(`^[${START}][${START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F\\u2040]*$`, 'u');
// Characters outside XML 1.0 Char: C0 controls except tab/LF/CR, U+FFFE, U+FFFF and lone surrogates.
const BAD_CHAR = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿\uD800-\uDFFF]/u;
const DECL_RE = /^<\?xml[ \t\n]+version[ \t\n]*=[ \t\n]*(["'])1\.[0-9]+\1([ \t\n]+encoding[ \t\n]*=[ \t\n]*(["'])[A-Za-z][A-Za-z0-9._-]*\3)?([ \t\n]+standalone[ \t\n]*=[ \t\n]*(["'])(yes|no)\5)?[ \t\n]*\?>/;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const LABEL_RE = /^[A-Za-z0-9 $._-]{1,40}$/;
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

const isWs = c => c === 32 || c === 10 || c === 9 || c === 13;
// Characters that end a name token while scanning (whitespace and markup delimiters).
const isNameEnd = c => isWs(c) || c === 62 || c === 47 || c === 61 || c === 60 || c === 34 || c === 39 || c === 63 || c === 38 || c === 59 || c === 33 || Number.isNaN(c);

const short = s => (s.length > 60 ? s.slice(0, 57) + '...' : s);
const hex4 = cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

// The SqlError of a malformed document: `<prefix>: <reason> at line L, column C.` plus line, col and reason (01 §1;
// an empty document and a text that is no string are reported at line 1, column 1 like every other error).
function xmlError(prefix, line, col, reason) {
  const e = new SqlError(`${prefix}: ${reason} at line ${line}, column ${col}.`);
  e.line = line;
  e.col = col;
  e.reason = reason;
  return e;
}

// Throws the error for offset `pos` of the (line-end normalised) document s.
function fail(prefix, s, pos, what) {
  const p = Math.max(0, Math.min(pos, s.length));
  const nl = s.lastIndexOf('\n', p - 1);
  let line = 1;
  for (let k = s.indexOf('\n'); k !== -1 && k < p; k = s.indexOf('\n', k + 1)) line++;
  throw xmlError(prefix, line, p - nl, what);
}

function isXmlChar(cp) {
  return cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);
}

// Decodes the references in src[a, b). Errors are reported at the offending '&', at offset `shift` + its
// index in src within the document s (src is s itself for text, a normalised attribute value otherwise).
function decode(prefix, s, src, a, b, shift) {
  let amp = src.indexOf('&', a);
  if (amp === -1 || amp >= b) return src.slice(a, b);
  let out = '';
  let j = a;
  while (amp !== -1 && amp < b) {
    out += src.slice(j, amp);
    const semi = src.indexOf(';', amp + 1);
    const ref = semi !== -1 && semi < b ? src.slice(amp + 1, semi) : null;
    if (ref !== null && ref[0] === '#') {
      const m = /^#(?:([0-9]+)|x([0-9a-fA-F]+))$/.exec(ref);
      if (!m) fail(prefix, s, amp + shift, `'&${short(ref)};' is not a valid character reference`);
      const digits = (m[1] ?? m[2]).replace(/^0+(?=.)/, '');
      const cp = digits.length > 8 ? -1 : parseInt(digits, m[1] ? 10 : 16);
      if (!isXmlChar(cp)) fail(prefix, s, amp + shift, `the character reference '&${short(ref)};' is not a valid XML character`);
      out += String.fromCodePoint(cp);
    } else if (ref !== null && NAME_RE.test(ref)) {
      const v = NAMED.get(ref);
      if (v === undefined) fail(prefix, s, amp + shift, `unknown entity '&${short(ref)};'`);
      out += v;
    } else {
      fail(prefix, s, amp + shift, "'&' must start a reference such as &amp; (write &amp; for a literal '&')");
    }
    j = semi + 1;
    amp = src.indexOf('&', j);
  }
  return out + src.slice(j, b);
}

// Defines non-enumerable, read-only fields on a node, so the enumerable 01 §1 shape stays unchanged.
function hidden(node, fields) {
  for (const k of Object.keys(fields)) Object.defineProperty(node, k, { value: fields[k], enumerable: false, writable: false, configurable: false });
  return node;
}

// Splits a QName into [prefix, local] ('' prefix when there is none), or null when the name is not a QName:
// more than one colon, a colon at either end, or a local part that does not start like an NCName.
function qname(name) {
  const c = name.indexOf(':');
  if (c === -1) return ['', name];
  if (c === 0 || c === name.length - 1 || name.indexOf(':', c + 1) !== -1) return null;
  const local = name.slice(c + 1);
  return NAME_RE.test(local) ? [name.slice(0, c), local] : null;
}

// Parses an XML document (see the notes at the top of this file): the root element by default, a #document node with mixed.
export function parseXml(text, options) {
  const mixed = options != null && typeof options === 'object' && options.mixed === true;
  const label = options != null && typeof options === 'object' ? options.label : undefined;
  if (label !== undefined && (typeof label !== 'string' || !LABEL_RE.test(label))) throw new TypeError("parseXml: label must be 1 to 40 letters, digits, spaces, '$', '.', '-' or '_'");
  const P = 'Invalid ' + (label ?? (mixed ? 'XML' : 'FetchXML'));
  if (text == null && !mixed) throw xmlError(P, 1, 1, 'the document is empty');
  if (typeof text !== 'string') throw xmlError(P, 1, 1, 'expected the XML text as a string');
  let s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  if (s.indexOf('\r') !== -1) s = s.replace(/\r\n?/g, '\n');
  if (!mixed && !/[^ \t\n]/.test(s)) throw xmlError(P, 1, 1, 'the document is empty');
  const bad = BAD_CHAR.exec(s);
  if (bad) fail(P, s, bad.index, `the character ${hex4(bad[0].codePointAt(0))} is not allowed in XML`);
  const n = s.length;
  let i = 0;
  let root = null;
  const doc = mixed ? hidden({ name: '#document', attrs: new Map(), kids: [], text: '' }, { parent: null }) : null;
  let cur = doc; // the open element (the document node at the top level in mixed mode, else null there)
  const stack = [];
  let lastText = null; // mixed: the #text node that new character data of `cur` extends, or null
  let cdEnd = s.indexOf(']]>'); // next ']]>' at or after the text being checked (keeps the scan linear)
  let ampNext = s.indexOf('&'); // next '&' at or after the text being decoded (likewise)
  // Mixed mode: prefix -> stack of namespace URIs in scope ('' key: the default namespace); every element start
  // pushes its declarations and its end pops them (frames on `declared`).
  const scope = mixed ? new Map([['xml', [XML_NS]]]) : null;
  const declared = [];

  const addText = t => {
    if (!t) return;
    cur.text += t;
    if (!mixed) return;
    if (lastText) lastText.text += t;
    else {
      lastText = hidden({ name: '#text', text: t }, { parent: cur });
      cur.kids.push(lastText);
    }
  };
  const addNode = node => {
    lastText = null;
    cur.kids.push(mixed ? hidden(node, { parent: cur }) : node);
  };

  if (s.startsWith('<?xml') && (isWs(s.charCodeAt(5)) || s.charCodeAt(5) === 63)) {
    const m = DECL_RE.exec(s);
    if (!m) fail(P, s, 0, 'malformed XML declaration');
    i = m[0].length;
  }

  const readName = (at, what) => {
    let k = at;
    while (k < n && !isNameEnd(s.charCodeAt(k))) k++;
    const name = s.slice(at, k);
    if (!name) fail(P, s, at, `expected ${what}`);
    if (!NAME_RE.test(name)) fail(P, s, at, `'${short(name)}' is not a valid XML name`);
    return [name, k];
  };
  const skipWs = at => {
    while (at < n && isWs(s.charCodeAt(at))) at++;
    return at;
  };
  const inScope = p => {
    const st = scope.get(p);
    return st && st.length ? st[st.length - 1] : null;
  };
  // Namespace processing of one element start (mixed mode); attrAt maps attribute names to their offsets.
  const bindNamespaces = (el, at, attrAt) => {
    const frame = [];
    for (const [a, v] of el.attrs) {
      if (a !== 'xmlns' && !a.startsWith('xmlns:')) continue;
      const p = a === 'xmlns' ? '' : a.slice(6);
      const where = attrAt.get(a);
      if (a !== 'xmlns' && (!p || p.indexOf(':') !== -1 || !NAME_RE.test(p))) fail(P, s, where, `'${short(a)}' is not a valid namespace declaration`);
      if (p === 'xmlns') fail(P, s, where, "the prefix 'xmlns' cannot be declared");
      if (p === 'xml' && v !== XML_NS) fail(P, s, where, `the prefix 'xml' can only be bound to ${XML_NS}`);
      if (p !== 'xml' && v === XML_NS) fail(P, s, where, `the namespace ${XML_NS} can only be bound to the prefix 'xml'`);
      if (v === XMLNS_NS) fail(P, s, where, `the namespace ${XMLNS_NS} cannot be declared`);
      if (p !== '' && v === '') fail(P, s, where, `the prefix '${short(p)}' cannot be bound to an empty namespace name`);
      let st = scope.get(p);
      if (!st) { st = []; scope.set(p, st); }
      st.push(v);
      frame.push(p);
    }
    declared.push(frame);
    const q = qname(el.name);
    if (!q) fail(P, s, at, `'${short(el.name)}' is not a valid qualified name`);
    const [prefix, local] = q;
    if (prefix === 'xmlns') fail(P, s, at, "the prefix 'xmlns' cannot be used for an element");
    const uri = inScope(prefix);
    if (prefix && uri === null) fail(P, s, at, `the prefix '${short(prefix)}' is not declared`);
    const attrUris = new Map();
    const expanded = new Set();
    for (const a of el.attrs.keys()) {
      const where = attrAt.get(a);
      let u;
      if (a === 'xmlns' || a.startsWith('xmlns:')) u = XMLNS_NS;
      else {
        const qa = qname(a);
        if (!qa) fail(P, s, where, `'${short(a)}' is not a valid qualified name`);
        if (qa[0]) {
          u = inScope(qa[0]);
          if (u === null) fail(P, s, where, `the prefix '${short(qa[0])}' is not declared`);
          const key = u + '\u0000' + qa[1];
          if (expanded.has(key)) fail(P, s, where, `duplicate attribute '${short(a)}' in <${short(el.name)}> (the same namespace and local name)`);
          expanded.add(key);
        } else u = '';
      }
      attrUris.set(a, u);
    }
    hidden(el, { prefix, local, uri: uri ?? '', attrUris });
  };
  const unbindNamespaces = () => {
    for (const p of declared.pop()) scope.get(p).pop();
  };

  while (i < n) {
    const lt = s.indexOf('<', i);
    const end = lt === -1 ? n : lt;
    if (end > i) {
      if (cur === null) {
        const k = skipWs(i);
        if (k < end) fail(P, s, k, root ? 'text is not allowed after the root element' : 'text is not allowed before the root element');
      } else {
        if (cdEnd !== -1 && cdEnd < i) cdEnd = s.indexOf(']]>', i);
        if (cdEnd !== -1 && cdEnd < end) fail(P, s, cdEnd, "']]>' is not allowed in text");
        if (ampNext !== -1 && ampNext < i) ampNext = s.indexOf('&', i);
        addText(ampNext === -1 || ampNext >= end ? s.slice(i, end) : decode(P, s, s, i, end, 0));
      }
    }
    if (lt === -1) break;
    i = lt;
    const c = s.charCodeAt(i + 1);
    if (c === 47) { // </name>
      const [name, k] = readName(i + 2, "an element name after '</'");
      const k2 = skipWs(k);
      if (s.charCodeAt(k2) !== 62) fail(P, s, k2, k2 >= n ? `the closing tag </${short(name)}> is not complete` : `expected '>' to end the closing tag </${short(name)}>`);
      if (cur === null || cur === doc) fail(P, s, i, `unexpected closing tag </${short(name)}>`);
      if (name !== cur.name) fail(P, s, i, `expected </${short(cur.name)}> but found </${short(name)}>`);
      stack.pop();
      if (mixed) unbindNamespaces();
      cur = stack.length ? stack[stack.length - 1] : doc;
      lastText = null;
      i = k2 + 1;
    } else if (c === 33) { // <!-- -->, <![CDATA[ ]]>, <!DOCTYPE
      if (s.startsWith('<!--', i)) {
        const close = s.indexOf('-->', i + 4);
        if (close === -1) fail(P, s, i, 'the comment is not closed');
        const dd = s.indexOf('--', i + 4); // finds the closing '-->' at the latest, earlier for '--' inside or '--->'
        if (dd < close) fail(P, s, dd, "'--' is not allowed inside a comment");
        if (mixed) addNode({ name: '#comment', text: s.slice(i + 4, close) });
        i = close + 3;
      } else if (s.startsWith('<![CDATA[', i)) {
        if (cur === null) fail(P, s, i, 'a CDATA section is only allowed inside an element');
        const close = s.indexOf(']]>', i + 9);
        if (close === -1) fail(P, s, i, 'the CDATA section is not closed');
        addText(s.slice(i + 9, close));
        i = close + 3;
      } else if (s.startsWith('<!DOCTYPE', i)) {
        fail(P, s, i, 'DOCTYPE declarations are not allowed');
      } else {
        fail(P, s, i, "'<!' must start a comment or a CDATA section");
      }
    } else if (c === 63) { // <?target ...?>
      const [target, k] = readName(i + 2, "a processing instruction target after '<?'");
      if (target.toLowerCase() === 'xml') fail(P, s, i, 'the XML declaration is only allowed at the very start of the document');
      const close = s.indexOf('?>', k);
      if (close === -1) fail(P, s, i, 'the processing instruction is not closed');
      if (close !== k && !isWs(s.charCodeAt(k))) fail(P, s, k, `expected whitespace after the processing instruction target '${short(target)}'`);
      if (mixed) {
        if (target.indexOf(':') !== -1) fail(P, s, i + 2, `'${short(target)}' is not a valid processing instruction target (no colon allowed)`);
        addNode({ name: '#pi', target, text: s.slice(skipWs(k), close) });
      }
      i = close + 2;
    } else { // <name attr="v" ...> or <name .../>
      const [name, k0] = readName(i + 1, "an element name after '<'");
      const el = { name, attrs: new Map(), kids: [], text: '' };
      const attrAt = mixed ? new Map() : null;
      let k = k0;
      let selfClose = false;
      for (;;) {
        const sep = k;
        k = skipWs(k);
        const ch = s.charCodeAt(k);
        if (ch === 62) { k++; break; }
        if (ch === 47) {
          if (s.charCodeAt(k + 1) !== 62) fail(P, s, k + 1, `expected '>' after '/' in <${short(name)}>`);
          k += 2;
          selfClose = true;
          break;
        }
        if (k >= n) fail(P, s, k, `the start tag <${short(name)}> is not complete`);
        if (k === sep) fail(P, s, k, `expected whitespace, '>' or '/>' in <${short(name)}>`);
        const [attr, a1] = readName(k, `an attribute name in <${short(name)}>`);
        let q = skipWs(a1);
        if (s.charCodeAt(q) !== 61) fail(P, s, q, `expected '=' after the attribute '${short(attr)}' in <${short(name)}>`);
        q = skipWs(q + 1);
        const quote = s.charCodeAt(q);
        if (quote !== 34 && quote !== 39) fail(P, s, q, `expected a quoted value for the attribute '${short(attr)}' in <${short(name)}>`);
        const close = s.indexOf(quote === 34 ? '"' : "'", q + 1);
        if (close === -1) fail(P, s, q, `the value of the attribute '${short(attr)}' in <${short(name)}> is not closed`);
        let raw = s.slice(q + 1, close);
        const ltIn = raw.indexOf('<'); // searched inside the value only, so each value is scanned once
        if (ltIn !== -1) fail(P, s, q + 1 + ltIn, `'<' is not allowed in the value of the attribute '${short(attr)}'`);
        if (el.attrs.has(attr)) fail(P, s, k, `duplicate attribute '${short(attr)}' in <${short(name)}>`);
        if (raw.indexOf('\n') !== -1 || raw.indexOf('\t') !== -1) raw = raw.replace(/[\n\t]/g, ' ');
        el.attrs.set(attr, raw.indexOf('&') === -1 ? raw : decode(P, s, raw, 0, raw.length, q + 1));
        if (attrAt) attrAt.set(attr, k);
        k = close + 1;
      }
      if (cur === null) {
        if (root !== null) fail(P, s, i, 'only one root element is allowed');
        root = el;
      } else {
        addNode(el);
      }
      if (mixed) {
        bindNamespaces(el, i + 1, attrAt);
        if (selfClose) unbindNamespaces();
      }
      if (!selfClose) {
        stack.push(el);
        cur = el;
        lastText = null;
      }
      i = k;
    }
  }
  if (cur !== null && cur !== doc) fail(P, s, n, `the element <${short(cur.name)}> is not closed`);
  if (mixed) return doc;
  if (root === null) fail(P, s, n, 'the document has no root element');
  return root;
}

// The text of an escapable value (string, finite number, bigint, boolean), else null (see the notes at the top of this file).
function escText(s) {
  switch (typeof s) {
    case 'string': return s;
    case 'number': return Number.isFinite(s) ? String(s) : null;
    case 'bigint': case 'boolean': return String(s);
    default: return null;
  }
}

// The kind of value named in xmlEsc's TypeError: null, undefined, Date, Array, NaN, Infinity or the typeof name.
function kindOf(s) {
  if (s === null) return 'null';
  if (typeof s === 'number') return String(s);
  if (typeof s !== 'object') return typeof s;
  if (s instanceof Date) return 'Date';
  if (Array.isArray(s)) return 'Array';
  return 'object';
}

// Escape tables per mode: the characters each mode replaces and their replacements (01 §1, §5.7).
const FETCH_MAP = new Map([['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;'], ['"', '&quot;'], ["'", '&apos;'], ['\t', '&#9;'], ['\n', '&#10;'], ['\r', '&#13;']]);
const TEXT_MAP = new Map([['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;'], ['\r', '&#x0D;']]);
const ATTR_MAP = new Map([['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;'], ['"', '&quot;'], ['\r', '&#x0D;'], ['\n', '&#x0A;'], ['\t', '&#x09;']]);
const MODES = new Map([
  [undefined, { map: FETCH_MAP, re: /[&<>"'\t\n\r]/g, test: /[&<>"'\t\n\r]/, prefix: 'Invalid FetchXML' }],
  ['text', { map: TEXT_MAP, re: /[&<>\r]/g, test: /[&<>\r]/, prefix: 'Invalid XML' }],
  ['attr', { map: ATTR_MAP, re: /[&<>"\r\n\t]/g, test: /[&<>"\r\n\t]/, prefix: 'Invalid XML' }],
]);

// Escapes a value: FetchXML text and attributes (no mode), or SQL Server's element text ('text') and attribute
// values ('attr') of FOR XML and the xml type (see the notes at the top of this file).
export function xmlEsc(s, mode) {
  const m = MODES.get(mode);
  if (!m) throw new TypeError(`xmlEsc: unknown mode '${String(mode)}' (use 'text' or 'attr')`);
  const str = escText(s);
  if (str === null) throw new TypeError(`xmlEsc: expected a string, number, bigint or boolean, got ${kindOf(s)}`);
  const bad = BAD_CHAR.exec(str);
  if (bad) {
    const cp = bad[0].codePointAt(0);
    const e = new SqlError(`${m.prefix}: the text contains ${hex4(cp)}, which XML 1.0 cannot represent.`);
    e.codePoint = cp;
    throw e;
  }
  return m.test.test(str) ? str.replace(m.re, ch => m.map.get(ch)) : str;
}

// True when xmlEsc(s) can represent s (an accepted type with no character outside XML 1.0 Char), in every mode.
export function xmlSafe(s) {
  const str = escText(s);
  return str !== null && !BAD_CHAR.test(str);
}
