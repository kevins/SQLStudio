// Build pipeline:
//   esbuild bundle (iife) -> swc second minify pass -> + sourceURL -> zopfli raw deflate
//   -> base85 (URL-safe alphabet) -> loader template -> validations -> dist/
// Outputs:
//   dist/sql-studio.js               minified bundle (what the bookmarklet runs)
//   dist/sql-studio.dev.js           readable bundle for debugging
//   dist/sql-studio.bookmarklet.txt  the javascript: URL
//   dist/sql-studio.console.txt      the same loader as a DevTools console snippet (where policy blocks javascript: favorites)
//   dist/install.html                drag-to-bookmarks page
//   dist/size.json                   size report
// Flags: --dev (skip swc + zopfli; faster), --no-check (size limit only warns), --sizes (print group sizes)
import { build } from 'esbuild';
import { minify } from '@swc/core';
import zopfli from '@gfx/zopfli';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Target browser: Microsoft Edge (Chromium) only. Chromium drops URLs longer than url::kMaxURLChars (2,097,152)
// when a favorite is sent to the page over Mojo. Verified in Edge: a 2,097,152-char favorite runs, a 2,100,000-char
// one does nothing.
const EDGE_CAP = 2_097_152;
const LIMIT = EDGE_CAP;
const SOFT_LIMIT = 1_000_000; // warn only: favorites sync of very large entries is unverified
const args = new Set(process.argv.slice(2));
const DEV = args.has('--dev');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
mkdirSync('dist', { recursive: true });

const common = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120', 'edge120'],
  legalComments: 'none',
  charset: 'utf8',
  write: false,
  logLevel: 'warning',
};

// Source rules: network, storage, HTML parsing and window.open each live in one module.
// The only network channel in SQL Studio is api.js's fetch to this origin's /api/data/v9.2/.
const SRC_RULES = [
  { re: /\bfetch\s*\(|\b(window|globalThis|self)\s*(\.\s*fetch\b|\[\s*['"`]fetch)|=\s*fetch\s*[;,)]/, only: ['src/data/api.js'], what: 'fetch' },
  { re: /\blocation\s*\.\s*(assign|replace|reload)\s*\(|\blocation\s*(\.\s*href\s*)?=[^=]/, only: ['src/core/util.js'], what: 'navigation (util.openUrl is the only one)' },
  { re: /\bh\(\s*['"`](svg:)?(script|iframe|frame|frameset|object|embed|link|base|meta|portal|applet)['"`]/i, only: [], what: 'an element that loads or runs code' },
  // Built-ins that Node 22 has but Edge 120 lacks.
  { re: /\bIterator\s*\.\s*from\b|\bArray\s*\.\s*fromAsync\b|\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\s*\(/, only: [], what: 'a built-in newer than Edge 120' },
  { re: /\b(localStorage|sessionStorage|indexedDB)\b/, only: ['src/core/store.js'], what: 'browser storage' },
  { re: /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|createContextualFragment/, only: ['src/ui/dom.js', 'src/ui/icons.js'], what: 'HTML parsing' },
  { re: /\bDOMParser\b/, only: [], what: 'DOMParser (core/xml.js is the only XML parser)' },
  { re: /window\.open\s*\(/, only: ['src/core/util.js'], what: 'window.open(' },
];
const walk = d => readdirSync(d).flatMap(n => { const p = d + '/' + n; return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });
const srcProblems = [];
for (const file of walk('src')) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const r of SRC_RULES) if (r.re.test(line) && !r.only.includes(file)) srcProblems.push(`${file}:${i + 1} uses ${r.what} (allowed only in ${r.only.join(', ')})`);
  });
}
if (srcProblems.length) { console.error('Source checks failed:\n - ' + srcProblems.join('\n - ')); process.exit(1); }

// The launch guard's build id: a click on a favorite of another build replaces the SQL Studio already on the page
// instead of showing that older copy (main.js).
const BUILD = pkg.version + '+' + Date.now().toString(36);
const define = dev => ({ __VERSION__: JSON.stringify(pkg.version), __BUILD__: JSON.stringify(BUILD), __DEV__: String(dev) });
const [minRes, devRes] = await Promise.all([
  build({ ...common, define: define(DEV), minify: true, drop: ['debugger'], metafile: true }),
  build({ ...common, define: define(true), minify: false }),
]);
writeFileSync('dist/sql-studio.dev.js', devRes.outputFiles[0].text);
let code = minRes.outputFiles[0].text;
const esbuildBytes = Buffer.byteLength(code);
if (!DEV) {
  const out = await minify(code, {
    compress: { passes: 2, toplevel: true, pure_getters: false },
    mangle: { toplevel: true },
    module: false,
    ecma: 2022,
    format: { comments: false },
  });
  code = out.code;
}
code = code.replace(/\s+$/, '');
writeFileSync('dist/sql-studio.js', code);

// Static checks on the bundle: the security rules.
const BANNED = [
  [/\beval\s*\(|\(0,\s*eval\)/, 'eval'],
  [/\bFunction\s*\(/, 'Function('],
  [/WebAssembly/, 'WebAssembly'],
  [/\bset(Timeout|Interval)\s*\(\s*["'`]/, 'a string timer'],
  [/document\.write/, 'document.write'],
  [/\.postMessage\s*\(/, 'postMessage('],
  [/sendBeacon/, 'sendBeacon'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bimportScripts\b|\bimport\s*\(/, 'a dynamic import'],
  // No other network channel: workers, peer connections, beacons, preloads, external CSS/images.
  [/\b(SharedWorker|Worker|ServiceWorker|serviceWorker|RTCPeerConnection|WebTransport|fetchLater|BroadcastChannel)\b/, 'a worker, service worker or peer channel'],
  [/\bnew\s+(Image|Audio)\s*\(/, 'new Image()/Audio()'],
  [/createElement(NS)?\s*\([^)]*?["'`](script|iframe|frame|object|embed|link|base|meta|portal)["'`]/i, 'createElement of an element that loads or runs code'],
  [/@import\b/, 'a CSS @import'],
  [/url\(\s*["']?\s*(https?:|\/\/)/i, 'a CSS url() to another host'],
  [/document\.cookie/, 'document.cookie'],
  [/\.submit\s*\(/, 'form submit()'],
  [/\bnavigator\s*\.\s*(sendBeacon|connection)\b/, 'navigator network APIs'],
  [/\b[\w$]+\.prototype\.[\w$]+\s*=[^=]/, 'a prototype assignment'],
  [/__proto__/, '__proto__'],
];
const problems = BANNED.filter(([re]) => re.test(code)).map(([, what]) => 'bundle contains ' + what);
if (problems.length) { console.error('Bundle checks failed:\n - ' + problems.join('\n - ')); process.exit(1); }

const bundle = code + '\n//# sourceURL=sql-studio.js\n';
const input = Buffer.from(bundle, 'utf8');
const raw = DEV
  ? deflateRawSync(input, { level: 9, memLevel: 9 })
  : Buffer.from(await zopfli.deflateAsync(input, { numiterations: 15 }));
if (!inflateRawSync(raw).equals(input)) { console.error('Deflate round trip failed'); process.exit(1); }

// base85 with an alphabet that survives javascript: URL handling untouched (no " # % ' < > ? \ `).
const EXCL = [34, 35, 37, 39, 60, 62, 63, 92, 96];
const A = [];
for (let c = 33; c < 127; c++) if (!EXCL.includes(c)) A.push(String.fromCharCode(c));
if (A.length !== 85) throw new Error('alphabet size ' + A.length);
const L = raw.length, PAD = Math.ceil(L / 4) * 4, buf = Buffer.concat([raw, Buffer.alloc(PAD - L)]);
let s = '';
for (let i = 0; i < PAD; i += 4) {
  let n = buf.readUInt32BE(i), t = '';
  for (let k = 0; k < 5; k++) { t = A[n % 85] + t; n = Math.floor(n / 85); }
  s += t;
}
const dec = 'n*85+c-33' + EXCL.map(x => `-(c>${x})`).join('');
const body =
  'void(async()=>{let w=window,K=Symbol.for("sqlstudio"),S,E=0;try{if(w[K]&&w[K].v===' + JSON.stringify(BUILD) + '&&w[K].toggle()!==false)return}catch{}try{' +
  `let s="${s}",a=new Uint8Array(${PAD}),i=0,j=0,n,k,c;` +
  `for(;i<s.length;a[j++]=n>>>24,a[j++]=n>>16&255,a[j++]=n>>8&255,a[j++]=n&255)for(n=0,k=5;k--;)c=s.charCodeAt(i++),n=${dec};` +
  `S=await new Response(new Blob([a.subarray(0,${L})]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();` +
  'performance.mark("sqlstudio:decompressed");' +
  'try{(0,eval)("0")}catch{E=1}' +
  'if(E){let u=URL.createObjectURL(new Blob([S],{type:"text/javascript"})),t=document.createElement("script");' +
  't.src=u;t.onload=()=>URL.revokeObjectURL(u);t.onerror=()=>alert("SQL Studio: blocked by the Content Security Policy of this page");document.head.append(t)}' +
  'else(0,eval)(S)}catch(e){alert("SQL Studio could not start: "+(e&&e.message||e))}})()';
const loader = 'javascript:' + body;

// ---- validations ----
const fail = m => { console.error('FAIL:', m); process.exit(1); };
if (/[%\t\n\r]/.test(loader)) fail('loader contains % or a tab/newline');
if (/[^\x20-\x7e]/.test(loader)) fail('non-ASCII character in the bookmarklet');
const qi = loader.search(/[?#]/);
if (qi >= 0) fail('? or # at index ' + qi + ' (would start a URL query/fragment)');
if (new URL(loader).href !== loader) fail('URL serializer changed the bookmarklet');
// Simulate the browser: run the loader body with stubbed globals and capture the evaluated source.
let captured = null;
const run = new Function('window', 'eval', 'document', 'alert', 'URL', 'Symbol', 'return ' + body.replace(/^void/, ''));
await run({}, x => { if (x !== '0') captured = x; }, {}, m => fail('alert: ' + m), URL, Symbol);
await new Promise(r => setTimeout(r, 50));
if (captured !== bundle) fail('loader round trip mismatch');

writeFileSync('dist/sql-studio.bookmarklet.txt', loader);
writeFileSync('dist/sql-studio.console.txt', body + ';\n');
const sha = createHash('sha256').update(loader).digest('hex');
const esc = x => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
writeFileSync('dist/install.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Install SQL Studio</title>
<style>
:root{--bg:#fafafa;--card:#fff;--fg:#242424;--muted:#616161;--line:#e0e0e0;--brand:#0f6cbd;--brand-h:#115ea3}
@media (prefers-color-scheme:dark){:root{--bg:#1f1f1f;--card:#292929;--fg:#f5f5f5;--muted:#adadad;--line:#3d3d3d;--brand:#479ef5;--brand-h:#62abf5}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 "Segoe UI",system-ui,sans-serif}
main{max-width:720px;margin:48px auto;padding:0 16px}h1{font-size:24px;font-weight:600;margin:0}h2{font-size:16px;font-weight:600;margin:28px 0 6px}
p,li{color:var(--muted)}b{color:var(--fg)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px 20px;margin-top:16px}
a.bm{display:inline-flex;align-items:center;padding:8px 18px;border-radius:6px;background:var(--brand);color:#fff;font-weight:600;text-decoration:none;cursor:grab}
button{font:inherit;font-size:14px;padding:5px 14px;border-radius:4px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}button:hover{border-color:var(--brand)}
code,textarea{font:12px Consolas,"Cascadia Mono",monospace}textarea{box-sizing:border-box;width:100%;height:90px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:4px}
small{color:var(--muted)}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
</style></head>
<body><main>
<h1>SQL Studio ${pkg.version}</h1>
<p>SQL for Dynamics 365 and Dataverse, right inside your model-driven app. For Microsoft Edge.</p>
<div class="card">
<h2>1. Drag to your favorites bar</h2>
<p>Show the favorites bar with <b>Ctrl+Shift+B</b>, then drag this button onto it.</p>
<p class="row"><a class="bm" id="bm" href="#">SQL Studio</a></p>
<h2>2. If dragging does not work</h2>
<p class="row"><button id="copy" type="button">Copy bookmarklet</button><span id="copied"></span></p>
<p>Add any page as a favorite with <b>Ctrl+D</b>, open it for editing (choose <b>More</b> in that dialog, or right-click the favorite and choose <b>Edit</b>), and paste into its <b>URL</b> field. Do not paste it into the address bar: Edge removes <code>javascript:</code> from pasted text there.</p>
<h2>3. Use it</h2>
<p>Open your Dynamics 365 / Power Apps app (<code>https://&lt;org&gt;.crm.dynamics.com</code>) and click <b>SQL Studio</b> on the favorites bar. It opens read-only; nothing can change until you choose <b>Allow changes</b>.</p>
</div>
<div class="card">
<h2>If your organisation blocks bookmarklets</h2>
<p>Open the developer tools (<b>F12</b>) on the Dynamics page, go to <b>Console</b>, and paste this:</p>
<textarea readonly id="snippet">${esc(body)};</textarea>
<p class="row"><button id="copy2" type="button">Copy console snippet</button><span id="copied2"></span></p>
</div>
<p><small>Bookmarklet: ${loader.length.toLocaleString('en-US')} characters (Edge limit ${EDGE_CAP.toLocaleString('en-US')}). SHA-256 ${sha}</small></p>
</main>
<script>
const BM=${JSON.stringify(loader)};
const bm=document.getElementById('bm');bm.href=BM;
bm.addEventListener('click',e=>{e.preventDefault();alert('Drag this button onto the favorites bar, then click the favorite on your Dynamics page.')});
const cp=(id,out,text)=>document.getElementById(id).addEventListener('click',()=>navigator.clipboard.writeText(text).then(()=>{document.getElementById(out).textContent='Copied'},()=>{document.getElementById(out).textContent='Copy failed: select and copy manually'}));
cp('copy','copied',BM);cp('copy2','copied2',document.getElementById('snippet').value);
</script></body></html>`);

// Per-module sizes: esbuild bytesInOutput scaled by the swc/esbuild ratio, summed into groups (KB minified).
// Budgets are advisory (warnings only): they flag unexpected growth such as an accidentally bundled dependency.
const BUDGETS = {
  'lexer+parser+format': [160, ['engine/lexer', 'engine/parser', 'engine/format']],
  'types+functions+messages': [240, ['engine/types', 'engine/functions', 'engine/messages']],
  'compile+exec': [150, ['engine/compile', 'engine/exec']],
  'planner+fetchxml+metatables': [220, ['engine/planner', 'engine/fetchxml', 'engine/metatables']],
  'dml+session+fetch2sql': [160, ['engine/dml', 'engine/session', 'engine/fetch2sql']],
  'api+meta+xml': [110, ['data/api', 'data/meta', 'core/xml']],
  'styles': [50, ['ui/styles']],
  'shell+state+dialogs': [280, ['ui/shell', 'ui/state', 'ui/dialogs']],
  'editor+complete': [210, ['ui/editor', 'ui/complete']],
  'grid+results+export': [180, ['ui/grid', 'ui/results', 'ui/export']],
  'explorer': [60, ['ui/explorer']],
  'icons+dom+store+util+main': [50, ['ui/icons', 'ui/dom', 'core/store', 'core/util', 'main']],
};
const ratio = Buffer.byteLength(code) / esbuildBytes;
const modules = {};
for (const out of Object.values(minRes.metafile.outputs))
  for (const [p, v] of Object.entries(out.inputs)) modules[p.replace(/\\/g, '/')] = Math.round(v.bytesInOutput * ratio);
const groups = {};
for (const [p, b] of Object.entries(modules)) {
  const g = Object.keys(BUDGETS).find(k => BUDGETS[k][1].some(m => p === 'src/' + m + '.js')) || 'other';
  groups[g] = (groups[g] || 0) + b;
}
const overBudget = Object.entries(groups)
  .filter(([g, b]) => BUDGETS[g] && b > BUDGETS[g][0] * 1024 * 1.1)
  .map(([g, b]) => `${g}: ${(b / 1024).toFixed(1)} KB > ${BUDGETS[g][0]} KB + 10%`);

const report = {
  version: pkg.version,
  minifiedBytes: Buffer.byteLength(code),
  deflatedBytes: L,
  bookmarkletChars: loader.length,
  limit: LIMIT,
  headroom: LIMIT - loader.length,
  edgeCap: EDGE_CAP,
  sha256: sha,
  groups: Object.fromEntries(Object.entries(groups).map(([g, b]) => [g, { bytes: b, budget: BUDGETS[g] ? BUDGETS[g][0] * 1024 : null }])),
  modules,
};
writeFileSync('dist/size.json', JSON.stringify(report, null, 2));
console.log(`minified ${report.minifiedBytes.toLocaleString('en-US')} B -> deflate ${L.toLocaleString('en-US')} B -> bookmarklet ${loader.length.toLocaleString('en-US')} chars (limit ${LIMIT.toLocaleString('en-US')}, headroom ${report.headroom.toLocaleString('en-US')})${DEV ? ' [dev build]' : ''}`);
if (args.has('--sizes')) for (const [g, v] of Object.entries(report.groups)) console.log(`  ${g.padEnd(30)} ${(v.bytes / 1024).toFixed(1).padStart(6)} KB${v.budget ? ' / ' + v.budget / 1024 + ' KB' : ''}`);
const strict = !args.has('--no-check');
if (overBudget.length) console.warn('WARNING: module groups over their advisory budget:\n - ' + overBudget.join('\n - '));
if (loader.length > SOFT_LIMIT) console.warn('WARNING: bookmarklet is over ' + SOFT_LIMIT.toLocaleString('en-US') + ' chars');
if (loader.length > LIMIT) { console.error((strict ? 'ERROR' : 'WARNING') + ': bookmarklet exceeds the Edge size limit'); if (strict) process.exit(1); }
