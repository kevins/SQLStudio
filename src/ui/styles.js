// Design tokens and shared base CSS for the shadow root (03 §1.3, §3, §4).
// TOKENS: the light/dark token sets on the token root .ss, the editor and syntax tokens,
// the 03 §3 dimension tokens and the chart tokens. BASE: the shared components with their
// class names, every hard-coded colour replaced by its token, the shell layout classes of 03 §3 and the
// top-layer resets of 03 §1.3. Every other UI module ships its own prefixed CSS that uses only var(--token) colours;
// colorLiterals() is the check for that. switchTheme() changes the theme without colour transitions.
//
// Notes:
// - --sx-id (the .t-id identifier colour) is softer than fg1 (pure #fff identifiers
//   outweighed every other token in dark): #333 light (Fluent grey20, 12.63:1 on --ed-bg #fff) and #e0e0e0 dark (grey88, 12.49:1 on --ed-bg #1f1f1f,
//   11.02:1 on --ed-line). Identifiers stay the strongest syntax colour, every syntax colour keeps >= 4.5:1 on
//   --ed-bg/--ed-line/--bg2 and >= 4.17:1 on --ed-sel.
// - Editor font scope (03 §5):
//   --ed-font-family is the 03 §5 stack ending in monospace and --ed-font is `13px/20px var(--ed-font-family)`, both
//   declared on .ss only. A custom property's var() is substituted on the element that declares it and descendants
//   inherit the result, so --ed-font always carries the family of .ss, and a --ed-font-family set on a descendant
//   reaches only `font-family:var(--ed-font-family)` on that element and below. editor.js sets settings.editorFont
//   (with ', monospace') on its own root (see the notes in editor.js), so today the user's font reaches the editor only,
//   and the text view (results.js) and any other user of --ed-font or --ed-font-family keep the default stack.
//   The text view follows editorFont only if the shell sets --ed-font-family on .ss from the validated
//   settings.editorFont at mount and on `settings {keys: ['editorFont']}`; otherwise the text
//   view uses the default stack. --mono stays the fixed monospace stack of
//   .code, .kv and .err-box.
// - Theme switch (03 §4): while `.ss[data-theme-switch]` is set, BASE turns
//   every transition in the tool off (`transition:none!important` on .ss, its descendants and their
//   ::before/::after), so a theme change repaints every colour at once instead of fading each button, row, splitter
//   and switch on its own. switchTheme(root, theme) sets the attribute, changes data-theme, forces the style update
//   (offsetWidth) and removes the attribute, all synchronously (verified in Chromium: a plain attribute change starts
//   about 50 colour transitions in the shell, switchTheme none, and hover transitions work right after). The shell
//   meets the requirement (see the notes in shell.js): it sets the first theme directly at mount, before the tree has a
//   style (elements without a previous style never transition, and no layout is forced during launch, 00 §1
//   principle 6), and sends every later change (the theme button, a settings change, a prefers-color-scheme change
//   while Auto) through switchTheme(). Elements that are not rendered (closed popovers, a hidden host) never
//   transition either.
// - Disabled states and info toasts: `.switch:disabled` and `.fp:disabled` use the Fluent 2 disabled
//   tokens like `.btn:disabled`, not opacity (an opacity-faded control shows the page through it and has no token
//   per theme). A disabled switch keeps its state visible: off is outlined (--bg1 track, --dis-s border), on is
//   filled (--dis-bg track and border), both with a --dis-fg knob, as Fluent 2's Switch draws them. A disabled filter
//   pill is --dis-bg with a --dis-s border and --dis-fg text and icon. `.toast.info .ic` is --brand, so an
//   info icon is told apart from the toast text.
// - Split button (03 §3 Format ▾): `.split` (an inline-flex group, e.g. `<span class="split" role="group">`)
//   holds a default or subtle main `.btn` followed by its menu `.btn` (the chevron icon only, with its own aria-label,
//   aria-haspopup=menu and aria-expanded). The parts share one border (the menu part is 28px wide with margin-left:-1px
//   and no inner corners); a hovered or focused part is raised (z-index 1, focus 2), so its border and inset focus ring
//   are never covered by the other part. Pressed (aria-expanded=true) and disabled come from the .btn rules. Below
//   900px the main part loses its label like every toolbar button (`.tbar .btn:has(>svg)>.lbl`) while the menu part
//   keeps its 28px (it is excluded from the 8px label-less padding).
// - Standing approval in the mode pill (03 §3): `button.pill.amb.standing` (amber like 'Changes allowed') may
//   shrink in the top bar (`.top>.pill.standing{flex:0 1 auto;min-width:0}`), so its main text span ends with an
//   ellipsis (the title holds every approval); a `.cnt` child (' · +1') never shrinks, and an `.end` child holds
//   the trailing × glyph (16px, aria-hidden: the whole pill is the button that ends the approvals).
// - Plan properties panel and other key/value lists: `.kv .kh` is a group heading that spans both columns
//   (e.g. 'Estimated', 'After the run'), and `.kv .vc` holds a value with an action next to it (`.vc>.val` takes the
//   width and wraps, `.vc>.x` is the Copy button of a long value), on the .kv grid.
// - Inline `<code>` (Help and template text, 03 §8.2) is the monospace size, 12px, with the line
//   height of the surrounding text (an 18px line would make 12/16 caption lines taller).
// - Query-tab strip geometry: .qtabs is `calc(var(--tab-h) + 1px)` tall (36px tabs plus its 1px bottom border, like
//   .tabs), so the selected tab's 3px indicator overlaps the border at bottom:-1px exactly as on result tabs.
//   .qt-list scrolls horizontally, which forces overflow-y to clip; its box therefore extends 24px below the strip
//   (`padding-bottom:24px;margin-bottom:-24px`), the reach of --sh16, so neither the indicator nor the dragged tab's
//   shadow is clipped. .tbar is a later flex item of .main, so it still paints and hit-tests above that extension
//   (checked in Edge).
// - In the top bar only the org badge (`.org`), the impersonation pill (`.who`) and a standing-approval pill shrink;
//   the env badge and the mode pill keep their full text unless the panel is narrower than 720px. Badge and pill
//   text sits in a <span> so a shrunk badge ends with an ellipsis (its title holds the full text).
// - colorLiterals() (the 03 §1.3 colour check) skips @media (forced-colors:active) blocks, whose prelude is exactly
//   that feature, optionally followed by `and (…)` conditions; outside them it also reports system colour keywords
//   (CanvasText, Highlight, the deprecated CSS2 ones, -webkit-link and the like, any -internal- word), except as words
//   of properties that take names (transition, animation, font, grid areas, containers, counters, content, …). In
//   url() it percent-decodes data URIs (and SVG character references) before looking for #hex, colour functions and
//   named or system paints, and it reports every base64 data URI, whose content it cannot check. CSS escapes in values
//   are decoded first. colorLiterals() and cssDeclarations() are checking helpers; they build nothing at load time.

// Token root .ss (light) and .ss[data-theme=dark], with the chart and dimension tokens.
export const TOKENS = `.ss{--brand:#0f6cbd;--brand-h:#115ea3;--brand-p:#0f548c;--brand-fill:#0f6cbd;--brand-fill-h:#115ea3;--brand-fill-p:#0f548c;--brand-bg:#ebf3fc;--brand-bg-h:#dcebfb;--brand-s:#b4d6fa;--on-brand:#fff;--link:#115ea3;--link-h:#0f548c;
--fg1:#242424;--fg2:#424242;--fg3:#616161;--fg4:#707070;--bg1:#fff;--bg2:#fafafa;--bg3:#f5f5f5;--bg4:#ebebeb;--s1:#d1d1d1;--s1-h:#c7c7c7;--s2:#e0e0e0;--s3:#f0f0f0;
--dis-fg:#bdbdbd;--dis-bg:#f0f0f0;--dis-s:#e0e0e0;--focus:#000;--focus-in:#fff;--knob-on:#fff;
--red:#c50f1f;--red-h:#a80d1a;--red-bg:#fdf3f4;--red-s:#eeacb2;--danger-fill:#c50f1f;--danger-fill-h:#a80d1a;--danger-fill-p:#960b18;--green:#0e700e;--green-bg:#f1faf1;--green-s:#9fd89f;--amber:#8a3707;--amber-bg:#fff9f5;--amber-s:#fdcfb4;
--scrim:rgba(0,0,0,.4);--sh16:0 0 2px rgba(0,0,0,.12),0 8px 16px rgba(0,0,0,.14);--sh64:0 0 2px rgba(0,0,0,.12),0 32px 64px rgba(0,0,0,.24);
--code-key:#a4262c;--code-str:#0f548c;--code-num:#0e700e;--code-bool:#8a3707;--diff-del:#fdeaea;--diff-add:#e9f7ec;--diff-del-mark:#f6c3c3;--diff-add-mark:#b6e3bf;--diff-old:#c50f1f;--diff-new:#0e700e;--diff-old-fg:#a4262c;--diff-new-fg:#0e700e;--chk-a:#f0f0f0;--chk-b:#fff;
--sx-kw:#0f548c;--sx-fn:#8a3707;--sx-type:#00666d;--sx-tbl:var(--sx-type);--sx-var:#5c2e91;--sx-str:#a4262c;--sx-num:#0e700e;--sx-cmt:#707070;--sx-op:#424242;--sx-punc:#616161;--sx-id:#333;--sx-warn:#bc4b09;
--ed-bg:#fff;--ed-fg:#242424;--ed-gutter-bg:#fff;--ed-gutter-s:var(--s3);--ed-gutter-fg:#707070;--ed-gutter-fg-active:#242424;--ed-line:#fafafa;--ed-sel:#cfe4fa;--ed-sel-blur:#ebebeb;--ed-caret:#242424;--ed-bracket:#ebf3fc;--ed-bracket-s:#b4d6fa;--ed-find:#fdcfb4;--ed-find-cur:#faa06b;--ed-find-cur-s:transparent;--ed-indent:#f0f0f0;
--mono:"Cascadia Mono",Consolas,"SF Mono",Menlo,ui-monospace,monospace;--ed-font-family:"Cascadia Mono",Consolas,"SF Mono",Menlo,ui-monospace,monospace;--ed-font:13px/20px var(--ed-font-family);
--chart-1:#637cef;--chart-2:#e3008c;--chart-3:#2aa0a4;--chart-4:#9373c0;--chart-5:#13a10e;--chart-6:#3a96dd;--chart-7:#ca5010;--chart-8:#57811b;--chart-grid:var(--s3);--chart-axis:var(--fg3);
--top-h:48px;--tab-h:36px;--tbar-h:44px;--status-h:28px;--row-h:28px;--row-h-c:24px;--head-h:32px;--tree-h:28px;--pop-w:340px;
color-scheme:light;font:14px/20px "Segoe UI","Segoe UI Web (West European)",-apple-system,BlinkMacSystemFont,Roboto,"Helvetica Neue",sans-serif;color:var(--fg1);letter-spacing:normal;text-align:left;text-transform:none;white-space:normal;visibility:visible;direction:ltr;unicode-bidi:isolate}
.ss[data-theme=dark]{--brand:#479ef5;--brand-h:#62abf5;--brand-p:#2886de;--brand-fill:#115ea3;--brand-fill-h:#0f6cbd;--brand-fill-p:#0c3b5e;--brand-bg:#082338;--brand-bg-h:#0a2e4a;--brand-s:#0e4775;--link:#479ef5;--link-h:#62abf5;
--fg1:#fff;--fg2:#d6d6d6;--fg3:#adadad;--fg4:#999;--bg1:#292929;--bg2:#1f1f1f;--bg3:#383838;--bg4:#424242;--s1:#666;--s1-h:#757575;--s2:#525252;--s3:#3d3d3d;
--dis-fg:#5c5c5c;--dis-bg:#141414;--dis-s:#424242;--focus:#fff;--focus-in:#000;--knob-on:#242424;
--red:#e37d80;--red-h:#eeacb2;--red-bg:#3b0509;--red-s:#6e0811;--danger-fill:#c50f1f;--danger-fill-h:#b10e1c;--green:#54b054;--green-bg:#052505;--green-s:#107c10;--amber:#faa06b;--amber-bg:#4a1e04;--amber-s:#8a3707;
--scrim:rgba(0,0,0,.5);--sh16:0 0 2px rgba(0,0,0,.24),0 8px 16px rgba(0,0,0,.28);--sh64:0 0 0 1px #3d3d3d,0 0 2px rgba(0,0,0,.24),0 32px 64px rgba(0,0,0,.48);
--code-key:#e37d80;--code-str:#62abf5;--code-num:#54b054;--code-bool:#faa06b;--diff-del:#3d2224;--diff-add:#1f3523;--diff-del-mark:#6b2a30;--diff-add-mark:#2d5a35;--diff-old:#e37d80;--diff-new:#54b054;--diff-old-fg:#e37d80;--diff-new-fg:#54b054;--chk-a:#3d3d3d;--chk-b:#292929;
--sx-kw:#62abf5;--sx-fn:#faa06b;--sx-type:#4cc2c9;--sx-var:#c6b1de;--sx-str:#eeacb2;--sx-num:#54b054;--sx-cmt:#999;--sx-op:#d6d6d6;--sx-punc:#adadad;--sx-id:#e0e0e0;--sx-warn:#faa06b;
--ed-bg:#1f1f1f;--ed-fg:#fff;--ed-gutter-bg:#1f1f1f;--ed-gutter-fg:#999;--ed-gutter-fg-active:#fff;--ed-line:#292929;--ed-sel:#0c3b5e;--ed-sel-blur:#383838;--ed-caret:#fff;--ed-bracket:#082338;--ed-bracket-s:#0e4775;--ed-find:#4a1e04;--ed-find-cur:#8a3707;--ed-find-cur-s:#faa06b;--ed-indent:#3d3d3d;
--chart-1:#637cef;--chart-2:#e3008c;--chart-3:#2aa0a4;--chart-4:#9373c0;--chart-5:#13a10e;--chart-6:#3a96dd;--chart-7:#ca5010;--chart-8:#57811b;
color-scheme:dark}
`;

// Search-clear and select-chevron icons drawn as data URIs; url() cannot use variables, so the
// stroke is fg3 written per theme.
const X_ICON = c => `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'><path d='M5 5l10 10M15 5 5 15' stroke='%23${c}' stroke-width='1.6' stroke-linecap='round'/></svg>")`;
const CHEVRON = c => `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'><path d='M6 8l4 4 4-4' fill='none' stroke='%23${c}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>")`;

// Shared base CSS: host reset, shared components, shell layout (03 §3), top-layer resets (03 §1.3).
export const BASE = `:host{all:initial!important;direction:ltr!important;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important}
:host([hidden]){display:none!important}
*,::before,::after{box-sizing:border-box}
[hidden]{display:none!important}
.ss[data-theme-switch],.ss[data-theme-switch] *,.ss[data-theme-switch] ::before,.ss[data-theme-switch] ::after{transition:none!important}
button,input,select,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
.ss{-webkit-font-smoothing:antialiased}
.spacer{flex:1}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.quiet{color:var(--fg3)}
h2{font-size:20px;line-height:28px;font-weight:600;margin:0}
h2:focus{outline:none}
.sub{color:var(--fg3);margin:2px 0 0}
:where(a){color:var(--link)}
:where(a):hover{color:var(--link-h)}
:where(code){font-family:var(--mono);font-size:12px;padding:1px 4px;border-radius:3px;background:var(--bg3);color:var(--fg1)}
:where(.code) :where(code){padding:0;background:none;font-size:inherit}
:where(kbd){display:inline-block;min-width:20px;padding:0 5px;border:1px solid var(--s1);border-bottom-width:2px;border-radius:4px;background:var(--bg2);color:var(--fg1);font-family:inherit;font-size:12px;line-height:16px;font-weight:600;text-align:center;white-space:nowrap}
:where(mark){background:var(--ed-find);color:inherit;border-radius:2px}
@keyframes fade{from{opacity:0}}
@keyframes rise{from{opacity:0;transform:translateY(10px)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{from{background-position:100% 0}to{background-position:-100% 0}}
@keyframes toastOut{to{opacity:0;transform:translateY(8px)}}
@keyframes slideIn{from{opacity:0;transform:translateX(24px)}}
@keyframes indet{from{transform:translateX(-100%)}to{transform:translateX(400%)}}
:where([popover]){inset:auto;margin:0;padding:0;border:0;background:none;color:inherit;overflow:visible;pointer-events:auto}
:where(dialog.dialog){position:static;inset:auto;margin:0;border:0;padding:0;color:inherit;background:none;max-width:none;max-height:none}
[popover]:not(:popover-open),dialog.dialog:not([open]){display:none!important}
:is(.menu,.pop,.tip)[popover]{transition:opacity .1s ease-out,overlay .1s ease-out allow-discrete,display .1s ease-out allow-discrete}
:is(.menu,.pop,.tip)[popover]:not(:popover-open){opacity:0}
@starting-style{:is(.menu,.pop,.tip):popover-open{opacity:0}}
.app{position:fixed;inset:0;pointer-events:none;animation:fade .15s ease-out}
.app.moving,.app.sizing{pointer-events:auto}
.app.moving .panel,.app.sizing .panel{user-select:none}
.win{position:absolute;inset:16px;pointer-events:auto;display:flex}
.win.max{left:0!important;top:0!important;width:100%!important;height:100%!important}
.panel{flex:1;min-width:0;background:var(--bg1);color:var(--fg1);border-radius:8px;box-shadow:var(--sh64);display:flex;flex-direction:column;overflow:hidden;position:relative;z-index:0;container:ss-panel/inline-size;animation:rise .22s cubic-bezier(.1,.9,.2,1)}
.win.max .panel{border-radius:0}
.rz{position:absolute;z-index:1}
.win.max .rz{display:none}
.rz.n,.rz.s{left:14px;right:14px;height:8px;cursor:ns-resize}
.rz.n{top:-6px}
.rz.s{bottom:-6px}
.rz.e,.rz.w{top:14px;bottom:14px;width:8px;cursor:ew-resize}
.rz.e{right:-6px}
.rz.w{left:-6px}
.rz.ne,.rz.nw,.rz.se,.rz.sw{width:18px;height:18px}
.rz.ne{top:-6px;right:-6px;cursor:nesw-resize}
.rz.sw{bottom:-6px;left:-6px;cursor:nesw-resize}
.rz.nw{top:-6px;left:-6px;cursor:nwse-resize}
.rz.se{bottom:-6px;right:-6px;cursor:nwse-resize}
.top{display:flex;align-items:center;gap:12px;height:var(--top-h);padding:0 12px 0 24px;border-bottom:1px solid var(--s2);flex:none;cursor:move;user-select:none;min-width:0}
.top button{cursor:pointer}
.top .tbtns{display:flex;gap:2px;flex:none}
.top h1{font-size:16px;line-height:22px;font-weight:600;margin:0;white-space:nowrap;flex:none}
.top>.badge,.top>.pill{flex:none}
.top>.org,.top>.who{flex:0 1 auto;min-width:0}
.logo{width:28px;height:28px;border-radius:6px;background:var(--brand-fill);color:var(--on-brand);display:grid;place-items:center;flex:none}
.badge{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:10px;font-size:12px;line-height:16px;font-weight:600;background:var(--bg3);color:var(--fg2);border:1px solid var(--s2);white-space:nowrap;max-width:100%}
.badge.prod{background:var(--red-bg);color:var(--red);border-color:var(--red-s)}
.badge.dev{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-s)}
.badge>span,.pill>span{overflow:hidden;text-overflow:ellipsis;min-width:0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:4px;border:1px solid var(--s1);background:var(--bg1);color:var(--fg1);font-weight:600;font-size:14px;white-space:nowrap;cursor:pointer;transition:background .1s,border-color .1s,color .1s;flex:none}
.btn svg{flex:none}
.btn:hover{background:var(--bg3);border-color:var(--s1-h)}
.btn:active{background:var(--bg4)}
.btn.primary{background:var(--brand-fill);border-color:transparent;color:var(--on-brand)}
.btn.primary:hover{background:var(--brand-fill-h)}
.btn.primary:active{background:var(--brand-fill-p)}
.btn.danger{background:var(--danger-fill);border-color:transparent;color:var(--on-brand)}
.btn.danger:hover{background:var(--danger-fill-h)}
.btn.danger:active{background:var(--danger-fill-p)}
.btn.danger-o{color:var(--red);border-color:var(--red)}
.btn.danger-o:hover{background:var(--red-bg);border-color:var(--red-h);color:var(--red-h)}
.btn.subtle{border-color:transparent;background:transparent;color:var(--fg2)}
.btn.subtle:hover{background:var(--bg3);color:var(--fg1)}
.btn.subtle:active{background:var(--bg4)}
.btn:not(.primary,.danger)[aria-expanded=true]{background:var(--bg4)}
.btn.subtle[aria-pressed=true]{background:var(--brand-bg);color:var(--brand)}
.btn:disabled,.btn:disabled:hover{cursor:default;background:var(--dis-bg);border-color:var(--dis-s);color:var(--dis-fg)}
.btn.primary:disabled,.btn.danger:disabled{background:var(--dis-bg);border-color:transparent;color:var(--dis-fg)}
.btn.subtle:disabled,.btn.subtle:disabled:hover{background:transparent;border-color:transparent;color:var(--dis-fg)}
.btn.icon{width:32px;padding:0}
a.btn{text-decoration:none}
.btn:focus-visible{outline:0;border-color:var(--focus);box-shadow:inset 0 0 0 1px var(--focus)}
.btn.primary:focus-visible,.btn.danger:focus-visible{border-color:var(--focus);box-shadow:inset 0 0 0 1px var(--focus),inset 0 0 0 2px var(--focus-in)}
.split{display:inline-flex;align-items:stretch;flex:none}
.split>.btn{position:relative}
.split>.btn:not(:last-child){border-top-right-radius:0;border-bottom-right-radius:0}
.split>.btn+.btn{width:28px;padding:0;margin-left:-1px;border-top-left-radius:0;border-bottom-left-radius:0}
.split>.btn:hover:not(:disabled){z-index:1}
.split>.btn:focus-visible{z-index:2}
.x{width:24px;height:24px;padding:0;border:0;border-radius:4px;background:none;display:grid;place-items:center;color:var(--fg3);cursor:pointer;flex:none}
.x:hover{background:var(--bg3);color:var(--fg1)}
.x:disabled,.x:disabled:hover{cursor:default;background:none;color:var(--dis-fg)}
.link{border:0;background:none;padding:0;color:var(--link);font-weight:400;font-size:14px;line-height:20px;cursor:pointer;text-align:left}
.link:hover{color:var(--link-h);text-decoration:underline}
.link:disabled{color:var(--dis-fg);cursor:default;text-decoration:none}
details summary{cursor:pointer;color:var(--link);list-style:none;display:inline-flex;align-items:center;gap:4px}
details summary::-webkit-details-marker{display:none}
details summary svg{transform:rotate(-90deg);transition:transform .1s}
details[open] summary svg{transform:none}
.input{display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;border:1px solid var(--s1);border-bottom-color:var(--fg3);border-radius:4px;background:var(--bg1);color:var(--fg3)}
.input:focus-within{border-bottom-color:var(--brand);box-shadow:inset 0 -1px 0 var(--brand)}
.input input{border:0;outline:0;background:transparent;font:inherit;color:var(--fg1);flex:1;min-width:0;height:100%;padding:0}
.input input::placeholder{color:var(--fg4)}
.input input:disabled{color:var(--dis-fg)}
.input:has(input:disabled){background:var(--dis-bg);border-color:var(--dis-s)}
.input:has(input[aria-invalid=true]),.ta[aria-invalid=true]{border-bottom-color:var(--red);box-shadow:inset 0 -1px 0 var(--red)}
.input input::-webkit-search-cancel-button{-webkit-appearance:none;width:16px;height:16px;cursor:pointer;background:center/12px no-repeat ${X_ICON('616161')}}
.ss[data-theme=dark] .input input::-webkit-search-cancel-button{background-image:${X_ICON('adadad')}}
.ta{display:block;width:100%;min-height:96px;padding:6px 10px;border:1px solid var(--s1);border-bottom-color:var(--fg3);border-radius:4px;background:var(--bg1);color:var(--fg1);font:12px/18px var(--mono);resize:vertical;outline:0}
.ta:focus{border-bottom-color:var(--brand);box-shadow:inset 0 -1px 0 var(--brand)}
.ta::placeholder{color:var(--fg4)}
.ta:disabled{background:var(--dis-bg);border-color:var(--dis-s);color:var(--dis-fg)}
.field>label{display:block;font-weight:600;margin-bottom:4px;color:var(--fg1)}
.field .hint{font-size:12px;line-height:16px;color:var(--fg3);margin-top:8px}
input[type=checkbox],input[type=radio]{width:16px;height:16px;margin:0;accent-color:var(--brand);cursor:pointer;flex:none;display:block}
input[type=checkbox]:disabled,input[type=radio]:disabled{cursor:default}
.chk{display:inline-flex;align-items:center;gap:8px;cursor:pointer;white-space:nowrap;color:var(--fg2)}
.switch{width:40px;height:20px;border-radius:10px;border:1px solid var(--fg3);background:var(--bg1);position:relative;padding:0;cursor:pointer;flex:none;transition:background .15s,border-color .15s}
.switch i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--fg3);transition:transform .15s,background .15s}
.switch[aria-checked=true]{background:var(--brand);border-color:var(--brand)}
.switch[aria-checked=true] i{background:var(--knob-on);transform:translateX(20px)}
.switch:disabled{cursor:default;background:var(--bg1);border-color:var(--dis-s)}
.switch[aria-checked=true]:disabled{background:var(--dis-bg);border-color:var(--dis-bg)}
.switch:disabled i{background:var(--dis-fg)}
.seg{display:inline-flex;border:1px solid var(--s1);border-radius:4px;overflow:hidden;flex:none}
.seg button{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:0;background:var(--bg1);cursor:pointer;color:var(--fg2);white-space:nowrap}
.seg button+button{border-left:1px solid var(--s1)}
.seg button:hover{background:var(--bg3)}
.seg button[aria-pressed=true]{background:var(--brand-bg);color:var(--brand);font-weight:600}
.seg button:disabled,.seg button:disabled:hover{cursor:default;background:var(--dis-bg);color:var(--dis-fg);font-weight:400}
.seg button:focus-visible{outline-offset:-2px}
.fld{display:inline-flex;align-items:center;gap:8px;color:var(--fg2);white-space:nowrap}
select.sel{height:32px;max-width:280px;border:1px solid var(--s1);border-bottom-color:var(--fg3);border-radius:4px;font:inherit;color:var(--fg1);padding:0 32px 0 12px;cursor:pointer;appearance:none;-webkit-appearance:none;text-overflow:ellipsis;background:var(--bg1) no-repeat right 8px center/16px ${CHEVRON('616161')}}
.ss[data-theme=dark] select.sel{background-image:${CHEVRON('adadad')}}
select.sel.old{box-shadow:inset 3px 0 0 var(--diff-old)}
select.sel.new{box-shadow:inset 3px 0 0 var(--diff-new)}
select.sel:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
select.sel:disabled{cursor:default;color:var(--dis-fg);background-color:var(--dis-bg);border-color:var(--dis-s)}
.list{flex:1;overflow:auto;min-height:0}
.row{display:flex;align-items:center;gap:12px;height:53px;padding:0 16px;border-bottom:1px solid var(--s3);cursor:pointer;transition:background .08s}
.row:hover{background:var(--bg3)}
.row.on{background:var(--brand-bg)}
.row.on:hover{background:var(--brand-bg-h)}
.row:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.row .main{flex:1;min-width:0}
.row .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .un{font-size:12px;line-height:16px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .side{text-align:right;font-size:12px;color:var(--fg3);line-height:16px;flex:none;max-width:45%}
.row .side div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list.enter .row{animation:fade .15s ease-out}
.tl-tools{display:flex;align-items:center;gap:16px}
.tl-tools .input{flex:1}
.tl-list{border:1px solid var(--s2);border-radius:4px;height:min(360px,40vh);overflow:auto}
.tl-row{display:flex;align-items:center;gap:12px;height:44px;padding:0 12px;border-bottom:1px solid var(--s3);cursor:pointer}
.tl-row:hover{background:var(--bg3)}
.tl-row.on{background:var(--brand-bg)}
.tl-row:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.tl-row .main{flex:1;min-width:0}
.tl-row .nm{font-weight:600;color:var(--fg1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-row .un{font-size:12px;line-height:16px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-foot{display:flex;align-items:center;gap:16px;color:var(--fg3)}
.count{font-size:12px;line-height:20px;font-weight:600;color:var(--brand);background:var(--brand-bg);border-radius:10px;padding:0 8px;flex:none}
.count.amb{color:var(--amber);background:var(--amber-bg)}
.count.bad{color:var(--red);background:var(--red-bg)}
.tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:4px;background:var(--bg4);color:var(--fg2);font-size:12px;font-weight:600;line-height:16px;vertical-align:1px}
.ttag{display:inline-block;height:24px;line-height:24px;padding:0 8px;border-radius:4px;background:var(--bg3);color:var(--fg1);font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tags{display:flex;gap:4px;align-items:center;overflow:hidden;min-width:0}
.ptag{flex:0 1 auto;min-width:24px;height:20px;line-height:20px;padding:0 6px;border-radius:4px;background:var(--bg3);color:var(--fg2);font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.more{font-size:12px;color:var(--fg3);white-space:nowrap;flex:none}
.pill{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:10px;font-size:12px;font-weight:600;white-space:nowrap;background:var(--bg3);color:var(--fg2);flex:none}
.pill.ok{background:var(--green-bg);color:var(--green)}
.pill.bad{background:var(--red-bg);color:var(--red)}
.pill.amb{background:var(--amber-bg);color:var(--amber);box-shadow:inset 0 0 0 1px var(--amber-s)}
.pill svg{flex:none}
button.pill{border:0;cursor:pointer}
button.pill:hover{background:var(--bg4)}
button.pill.ok:hover{background:color-mix(in srgb,var(--green-bg) 85%,var(--green))}
button.pill.bad:hover{background:color-mix(in srgb,var(--red-bg) 85%,var(--red))}
button.pill.amb:hover{background:color-mix(in srgb,var(--amber-bg) 85%,var(--amber))}
button.pill:disabled{cursor:default;background:var(--dis-bg);color:var(--dis-fg);box-shadow:none}
.pill .x{width:16px;height:16px;margin-right:-4px;color:inherit;border-radius:8px}
.top>.pill.standing{flex:0 1 auto;min-width:0}
.pill>.cnt{flex:none}
.pill>.end{display:grid;place-items:center;width:16px;height:16px;margin-right:-4px;flex:none}
.fbar{display:flex;align-items:center;gap:8px;flex:1;min-width:0;flex-wrap:wrap}
.fp{display:inline-flex;align-items:center;gap:4px;height:28px;max-width:280px;min-width:0;padding:0 8px 0 12px;border-radius:14px;border:1px solid var(--s1);background:var(--bg1);color:var(--fg1);font-size:14px;cursor:pointer;white-space:nowrap;flex:0 1 auto;transition:background .1s,border-color .1s}
.fp:hover{background:var(--bg3)}
.fp .k{font-weight:600;flex:none}
.fp .v{color:var(--fg3);overflow:hidden;text-overflow:ellipsis;min-width:0}
.fp svg{flex:none;color:var(--fg3)}
.fp.on{background:var(--brand-bg);border-color:var(--brand)}
.fp.on .v,.fp.on svg{color:var(--brand)}
.fp[aria-expanded=true]{border-color:var(--brand)}
.fp:disabled,.fp:disabled:hover{cursor:default;background:var(--dis-bg);border-color:var(--dis-s);color:var(--dis-fg)}
.fp:disabled .v,.fp:disabled svg{color:var(--dis-fg)}
.fbar .link{white-space:nowrap}
.menu{position:fixed;min-width:240px;max-width:400px;max-height:min(480px,calc(100vh - 16px));overflow:auto;background:var(--bg1);color:var(--fg1);border-radius:4px;box-shadow:var(--sh16);padding:4px;animation:rise .12s ease-out}
.menu .mi{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;border:0;background:none;padding:6px 10px;border-radius:4px;cursor:pointer;text-align:left;color:var(--fg1)}
.menu .mi:hover,.menu .mi:focus-visible,.menu .mi[aria-expanded=true]{background:var(--bg3)}
.menu .mi:focus-visible,.pop .mi:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.menu .mi>svg{flex:none;color:var(--fg2)}
.menu .mi .tx{flex:1;min-width:0;display:flex;flex-direction:column}
.menu .mi .tx>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.menu .mi small{color:var(--fg3);font-size:12px;line-height:16px}
.menu .mi kbd{margin-left:auto;padding:0 0 0 16px;min-width:0;border:0;background:none;font-weight:400;color:var(--fg3)}
.menu .mi .chev{margin-left:auto;transform:rotate(-90deg);color:var(--fg3)}
.menu .ck{width:16px;flex:none;display:grid;color:var(--brand)}
.menu .mi.danger,.menu .mi.danger>svg{color:var(--red)}
.menu .mi:disabled,.menu .mi[aria-disabled=true]{cursor:default;background:none;color:var(--dis-fg)}
.menu .mi:disabled>svg,.menu .mi[aria-disabled=true]>svg,.menu .mi:disabled small,.menu .mi[aria-disabled=true] small,.menu .mi:disabled kbd,.menu .mi[aria-disabled=true] kbd{color:var(--dis-fg)}
.menu .sep{height:1px;background:var(--s2);margin:4px -4px}
.menu .mh{padding:6px 10px 2px;font-size:12px;line-height:16px;font-weight:600;color:var(--fg3)}
.m-empty{padding:12px;font-size:12px;line-height:16px;color:var(--fg3);max-width:320px}
.pop{position:fixed;width:var(--pop-w);max-width:calc(100vw - 16px);max-height:min(520px,calc(100vh - 16px));display:flex;flex-direction:column;background:var(--bg1);color:var(--fg1);border-radius:6px;box-shadow:var(--sh16);padding:4px 0;animation:rise .12s ease-out}
.pop .mi{display:flex;align-items:center;gap:8px;min-height:32px;border:0;background:none;padding:0 8px;margin:0 4px;border-radius:4px;cursor:pointer;text-align:left;flex:none;color:var(--fg1)}
.pop .mi:hover,.pop .mi:focus-visible{background:var(--bg3)}
.pop .mi:disabled{cursor:default;background:none;color:var(--dis-fg)}
.pop .mi .ck{width:16px;display:grid;color:var(--brand)}
.pop .mi .si{display:grid;color:var(--fg3)}
.pop .sep{height:1px;background:var(--s2);margin:4px 0;flex:none}
.pop .input{margin:4px 12px;flex:none}
.pop-list{flex:1;min-height:64px;overflow:auto;padding:2px 4px}
.pv{display:flex;align-items:center;gap:8px;min-height:30px;padding:0 8px;border-radius:4px;cursor:pointer}
.pv:hover{background:var(--bg3)}
.pv .v{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pv .n{color:var(--fg3);font-size:12px;flex:none}
.pv.all{font-weight:600}
.pop-more{padding:6px 12px;font-size:12px;line-height:16px;color:var(--fg3)}
.pop-foot{display:flex;align-items:center;gap:8px;padding:8px 12px 4px;border-top:1px solid var(--s2);margin-top:4px;flex:none}
.tip{position:fixed;max-width:320px;padding:4px 11px 6px;border-radius:4px;background:var(--bg1);color:var(--fg1);box-shadow:var(--sh16);font-size:12px;line-height:16px;white-space:pre-line;overflow-wrap:anywhere;pointer-events:none}
.tabs{display:flex;gap:4px;padding:0 14px;border-bottom:1px solid var(--s2);flex:none;min-width:0}
.tab{position:relative;display:inline-flex;align-items:center;gap:6px;height:var(--tab-h);padding:0 10px;border:0;background:none;color:var(--fg2);cursor:pointer;white-space:nowrap;flex:none}
.tab:hover{color:var(--fg1)}
.tab[aria-selected=true]{color:var(--fg1);font-weight:600}
.tab[aria-selected=true]::after{content:'';position:absolute;left:10px;right:10px;bottom:-1px;height:3px;border-radius:2px;background:var(--brand)}
.tab:focus-visible{outline-offset:-2px}
.tab:disabled{cursor:default;color:var(--dis-fg)}
.grid-wrap{flex:1;overflow:auto;min-height:0;border-top:1px solid var(--s2)}
table.grid{border-collapse:separate;border-spacing:0;width:100%;table-layout:fixed}
.grid th{position:sticky;top:0;z-index:1;background:var(--bg1);text-align:left;font-weight:600;color:var(--fg1);padding:0 12px;height:var(--head-h);border-bottom:1px solid var(--s2);white-space:nowrap;vertical-align:middle}
.grid td{padding:4px 12px;height:var(--row-h);border-bottom:1px solid var(--s3);vertical-align:middle}
.grid th.f{padding:0 4px}
.grid tbody tr:hover td{background:var(--bg3)}
.grid tbody tr.sel td{background:var(--brand-bg)}
.grid tbody tr.sel:hover td{background:var(--brand-bg-h)}
.grid .one{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hb{display:flex;align-items:center;gap:4px;width:100%;height:24px;padding:0 8px;border:0;border-radius:4px;background:none;font-weight:600;color:var(--fg1);cursor:pointer;text-align:left;min-width:0}
.hb:hover{background:var(--bg3)}
.hb[aria-expanded=true]{background:var(--bg4)}
.hb:disabled{cursor:default}
.hb:disabled:hover{background:none}
.hb:focus-visible{outline-offset:-2px}
.hb .l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.hb .ind{display:flex;align-items:center;gap:2px;flex:none;color:var(--fg3)}
.hb .ind .on{color:var(--brand);display:grid}
.fc-null{font-style:italic;color:var(--fg3)}
.fc-empty::after{content:'';display:inline-block;width:12px;vertical-align:middle;border-bottom:1px dotted var(--fg4)}
.fc-num{text-align:right;font-variant-numeric:tabular-nums}
.fc-guid{font-family:var(--mono);font-size:12px}
.sheet{position:absolute;left:0;right:0;top:var(--top-h);bottom:0;z-index:12;background:var(--bg1);display:flex;flex-direction:column;animation:slideIn .18s cubic-bezier(.1,.9,.2,1)}
.sh-head{display:flex;align-items:center;gap:8px;padding:12px 24px 12px 16px;flex:none}
.sh-title{flex:1;min-width:0}
.sh-title h2{font-size:18px;line-height:24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sh-title .sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:16px}
.sh-pos{color:var(--fg3);font-size:12px;white-space:nowrap;min-width:56px;text-align:center}
.sh-tools{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;padding:12px 24px;border-bottom:1px solid var(--s3);flex:none}
.sh-tools:empty{display:none}
.sh-body{flex:1;min-height:0;overflow:auto;padding:16px 24px 24px}
.scrim{position:absolute;inset:0;z-index:20;background:var(--scrim);display:flex;align-items:center;justify-content:center;padding:24px;animation:fade .12s ease-out}
.dialog{width:min(560px,100%);max-height:100%;display:flex;flex-direction:column;background:var(--bg1);color:var(--fg1);border-radius:8px;box-shadow:var(--sh64);padding:24px;gap:16px;animation:rise .18s cubic-bezier(.1,.9,.2,1)}
.dialog.wide{width:min(720px,100%)}
.dialog.xl{width:min(1040px,100%);height:calc(100% - 48px)}
.dialog.xl .dlg-body{flex:1}
.dialog h3{margin:0;font-size:20px;line-height:28px;font-weight:600}
.dlg-head{display:flex;flex-direction:column;gap:4px;flex:none}
.dlg-head .sub{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0}
.dlg-body{color:var(--fg2);overflow:auto;min-height:0;display:flex;flex-direction:column;gap:12px}
.dlg-body p{margin:0}
.dlg-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex:none}
.dlg-list{border:1px solid var(--s2);border-radius:4px;max-height:220px;overflow:auto}
.dlg-list div{display:flex;gap:12px;align-items:baseline;padding:8px 12px;border-bottom:1px solid var(--s3)}
.dlg-list div:last-child{border-bottom:0}
.dlg-list .t{color:var(--fg3);flex:none;width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlg-list .n{font-weight:600;color:var(--fg1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dlg-list .s{font-size:12px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.toasts{--toast-dx:0px;--toast-dy:0px;position:fixed;right:calc(24px + var(--toast-dx));bottom:calc(var(--status-h) + 16px + var(--toast-dy));width:min(360px,calc(100vw - 48px));display:flex;flex-direction:column;gap:8px;align-items:stretch;pointer-events:none}
.toast{pointer-events:auto;display:flex;align-items:flex-start;gap:8px;width:100%;padding:12px;border-radius:4px;background:var(--bg1);color:var(--fg1);box-shadow:var(--sh16);animation:rise .18s ease-out}
.toast.out{animation:toastOut .15s ease-in forwards}
.toast .ic{flex:none;margin-top:2px;display:grid}
.toast.ok .ic{color:var(--green)}
.toast.warn .ic{color:var(--amber)}
.toast.error .ic{color:var(--red)}
.toast.info .ic{color:var(--brand)}
.toast .txt{flex:1;min-width:0;overflow-wrap:anywhere}
.toast .act{display:block;margin-top:4px}
.toast .acts{display:flex;gap:16px;margin-top:4px}
.toast .progress{margin-top:8px}
.mini{position:fixed;right:24px;bottom:24px;z-index:2;pointer-events:auto;display:flex;align-items:center;gap:10px;height:44px;max-width:calc(100vw - 48px);padding:0 16px 0 14px;border-radius:22px;border:1px solid var(--s2);background:var(--bg1);color:var(--fg1);box-shadow:var(--sh16);font-weight:600;cursor:pointer;white-space:nowrap;animation:rise .18s ease-out}
.mini>span{overflow:hidden;text-overflow:ellipsis;min-width:0}
.mini:hover{background:var(--bg3)}
.mini .spin{color:var(--brand);width:16px;height:16px}
.mini .ok{color:var(--green);display:grid}
.mini small{font-weight:400;color:var(--fg3)}
.mini.amb{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-s)}
.mini.amb:hover{background:color-mix(in srgb,var(--amber-bg) 88%,var(--amber))}
.mini.amb small{color:inherit}
.progress{height:2px;background:var(--s3);overflow:hidden;flex:none}
.progress div{height:100%;width:0;background:var(--brand);transition:width .25s ease-out,opacity .2s}
.progress.off{background:transparent}
.progress.off div{opacity:0}
.progress.ind div{width:25%!important;animation:indet 1.2s cubic-bezier(.4,0,.6,1) infinite}
.step{display:flex;align-items:center;gap:8px;flex:1;min-width:0;color:var(--fg2);white-space:nowrap}
.step .spin{color:var(--brand)}
.step .txt{overflow:hidden;text-overflow:ellipsis;min-width:0}
.step .pct{color:var(--fg3);flex:none}
.spin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:spin .7s linear infinite;flex:none;display:inline-block}
.sk{display:flex;align-items:center;gap:12px;height:53px;padding:0 16px;border-bottom:1px solid var(--s3)}
.sk i,.sk-row i{display:block;border-radius:5px;background:linear-gradient(90deg,var(--bg3) 0,var(--bg4) 50%,var(--bg3) 100%);background-size:200% 100%;animation:shimmer 1.2s linear infinite}
.sk-row td{height:var(--row-h)}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:8px;padding:48px 24px;color:var(--fg3)}
.empty .ic{width:48px;height:48px;border-radius:24px;display:grid;place-items:center;background:var(--bg3);color:var(--fg3);margin-bottom:4px}
.empty .ic.ok{background:var(--green-bg);color:var(--green)}
.empty .ic.bad{background:var(--red-bg);color:var(--red)}
.empty b{color:var(--fg1);font-size:16px;line-height:22px;font-weight:600}
.empty .acts{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;justify-content:center}
.banner{display:flex;align-items:center;gap:10px;margin:0 24px 12px;padding:8px 12px;border-radius:4px;border:1px solid var(--s2);background:var(--bg3);color:var(--fg2);flex:none}
.banner .ic{flex:none;color:var(--fg3);display:grid}
.banner.warn{background:var(--amber-bg);border-color:var(--amber-s)}
.banner.warn .ic{color:var(--amber)}
.banner .txt{flex:1;min-width:0}
.note{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-radius:4px;background:var(--red-bg);color:var(--red);border:1px solid var(--red-s)}
.note.amb{background:var(--amber-bg);color:var(--amber);border-color:var(--amber-s)}
.note.info{background:var(--bg3);color:var(--fg2);border-color:var(--s2)}
.note svg{flex:none;margin-top:2px}
.sh-note{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:4px;background:var(--bg3);color:var(--fg2);margin-bottom:12px}
.err-box{margin-top:8px;padding:8px 10px;border-radius:4px;background:var(--bg3);font:12px/16px var(--mono);color:var(--fg2);overflow-wrap:anywhere;text-align:left;max-width:640px;white-space:pre-wrap}
.msg{color:var(--fg3);display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msg>span{overflow:hidden;text-overflow:ellipsis}
.msg.bad{color:var(--red)}
.msg b{color:var(--fg1);font-weight:600}
.msg.bad b{color:var(--red)}
.code{font:12px/18px var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:12px 16px;background:var(--bg2);border:1px solid var(--s2);border-radius:6px;color:var(--fg2);tab-size:4}
.code .k{color:var(--code-key)}
.code .s{color:var(--code-str)}
.code .n{color:var(--code-num)}
.code .b{color:var(--code-bool)}
.t-kw{color:var(--sx-kw)}
.t-fn{color:var(--sx-fn)}
.t-type{color:var(--sx-type)}
.t-tbl{color:var(--sx-tbl)}
.t-var{color:var(--sx-var)}
.t-str{color:var(--sx-str)}
.t-num{color:var(--sx-num)}
.t-cmt{color:var(--sx-cmt);font-style:italic}
.t-op{color:var(--sx-op)}
.t-punc{color:var(--sx-punc)}
.t-id{color:var(--sx-id)}
.t-lit{color:var(--sx-kw);font-style:italic}
.t-err{text-decoration:underline wavy var(--red) 1px;text-underline-offset:3px}
.t-warn{text-decoration:underline wavy var(--sx-warn) 1px;text-underline-offset:3px}
.props{display:flex;flex-direction:column;gap:12px}
.prop{border:1px solid var(--s2);border-radius:6px;overflow:hidden;flex:none}
.prop-h{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:0 12px;border:0;background:var(--bg2);text-align:left;cursor:pointer;color:var(--fg1)}
.prop-h:hover{background:var(--bg3)}
.prop-h:focus-visible{outline-offset:-2px}
.prop-h .k{font:600 13px/18px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.prop-h .cv{display:grid;transform:rotate(-90deg);transition:transform .1s;color:var(--fg3)}
.prop.ex .prop-h .cv{transform:none}
.prop-b{border-top:1px solid var(--s2)}
.kv{display:grid;grid-template-columns:minmax(120px,max-content) minmax(0,1fr);gap:6px 16px;padding:10px 12px;align-items:baseline}
.kv .lb{font-size:12px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kv .val{font:12px/18px var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;padding:2px 6px;border-radius:3px}
.kv .val.old{background:var(--diff-del)}
.kv .val.new{background:var(--diff-add)}
.kv i{color:var(--fg3);font-style:normal}
.kv .kh{grid-column:1/-1;margin-top:8px;font-size:12px;line-height:16px;font-weight:600;color:var(--fg1)}
.kv .kh:first-child{margin-top:0}
.kv .vc{display:flex;align-items:flex-start;gap:4px;min-width:0}
.kv .vc>.val{flex:1;min-width:0}
.kv .vc>.x{margin:-1px 0}
table.lt{border-collapse:collapse;width:100%}
.lt .one{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lt .lg{font-size:12px;line-height:16px;color:var(--fg3)}
.lt .nw{white-space:nowrap}
.lt th{text-align:left;font-weight:600;padding:8px 12px;border-bottom:1px solid var(--s2);white-space:nowrap;color:var(--fg1)}
.lt td{padding:10px 12px;border-bottom:1px solid var(--s3);vertical-align:middle}
.lt .acts{display:flex;gap:8px;justify-content:flex-end;white-space:nowrap}
.ct{margin-bottom:16px}
.ct h4{margin:0 0 8px;font-size:14px;font-weight:600}
.body{flex:1;min-height:0;display:flex;position:relative}
.body>.side{flex:none;width:280px;min-width:200px;max-width:520px;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.body>.main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.vsplit,.hsplit{flex:none;position:relative;z-index:3;background:var(--s2);touch-action:none;transition:background .1s ease-out .1s,box-shadow .1s ease-out .1s}
.vsplit{width:1px;cursor:ew-resize}
.hsplit{height:1px;cursor:ns-resize}
.vsplit::before,.hsplit::before{content:'';position:absolute}
.vsplit::before{top:0;bottom:0;left:-4px;right:-3px}
.hsplit::before{left:0;right:0;top:-4px;bottom:-3px}
.vsplit:hover,.vsplit.drag,.vsplit:focus-visible{background:var(--brand);box-shadow:1px 0 0 var(--brand)}
.hsplit:hover,.hsplit.drag,.hsplit:focus-visible{background:var(--brand);box-shadow:0 1px 0 var(--brand)}
.vsplit.drag,.hsplit.drag{transition:none}
.qtabs{display:flex;align-items:stretch;gap:2px;height:calc(var(--tab-h) + 1px);padding:0 8px 0 4px;border-bottom:1px solid var(--s2);flex:none;min-width:0}
.qtabs .qt-list{display:flex;gap:2px;min-width:0;margin-bottom:-24px;padding-bottom:24px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
.qtabs .qt-list::-webkit-scrollbar{display:none}
.qtabs .tab{max-width:240px;padding:0 4px 0 12px;user-select:none}
.qtabs .tab[aria-selected=true]::after{left:8px;right:8px}
.qtabs .tab .tt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.qtabs .tab .rn{width:160px;height:24px;padding:0 6px;border:1px solid var(--brand);border-radius:4px;background:var(--bg1);color:var(--fg1);font-weight:400;outline:0}
.qtabs .tab .dot{width:8px;height:8px;border-radius:50%;background:var(--fg3);flex:none}
.qtabs .tab .dot.edits{background:var(--amber)}
.qtabs .tab .spin{width:12px;height:12px;color:var(--brand)}
.qtabs .tab .x{width:20px;height:20px;visibility:hidden}
.qtabs .tab:hover .x,.qtabs .tab:focus-within .x,.qtabs .tab[aria-selected=true] .x{visibility:visible}
.qtabs .tab.drag{z-index:2;background:var(--bg1);box-shadow:var(--sh16);border-radius:4px 4px 0 0;cursor:grabbing}
.qtabs.reorder .tab:not(.drag){transition:transform .12s ease-out}
.qtabs>.btn{align-self:center}
.tbar{display:flex;align-items:center;gap:8px;height:var(--tbar-h);padding:0 12px;border-bottom:1px solid var(--s2);flex:none;min-width:0}
.tbar .sep{width:1px;height:20px;margin:0 4px;background:var(--s2);flex:none}
.tbar-hint{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;font-size:12px;line-height:16px;color:var(--fg3);white-space:nowrap}
.main>.progress{position:relative;z-index:4;margin-bottom:-2px}
.main>.ed{flex:none;min-height:80px;min-width:0;position:relative;display:flex;overflow:hidden;background:var(--ed-bg);color:var(--ed-fg)}
.main>.res{flex:1 1 0;min-height:140px;min-width:0;position:relative;display:flex;flex-direction:column}
.main[data-res=hidden]>.ed{flex:1 1 0;height:auto!important}
.main[data-res=hidden]>.hsplit,.main[data-res=hidden]>.res,.main[data-res=max]>.ed,.main[data-res=max]>.hsplit{display:none}
.status{display:flex;align-items:center;gap:12px;height:var(--status-h);padding:0 8px 0 12px;border-top:1px solid var(--s2);flex:none;min-width:0;overflow:hidden;font-size:12px;line-height:16px;color:var(--fg2);white-space:nowrap}
.status .st{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis}
.status button{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 6px;border:0;border-radius:4px;background:none;color:inherit;font-size:12px;cursor:pointer}
.status button:hover{background:var(--bg3);color:var(--fg1)}
.status button:disabled,.status button:disabled:hover{cursor:default;background:none;color:var(--dis-fg)}
.status .ok{color:var(--green)}
.status .bad{color:var(--red)}
.status .warn{color:var(--amber)}
.status.amb{background:var(--amber-bg);color:var(--amber)}
@container ss-panel (width < 1100px){.tbar-hint{display:none}}
@container ss-panel (width < 900px){.tbar .btn:has(>svg)>.lbl,.sh-head .btn .lbl{display:none}.tbar .btn:has(>svg):not(.icon,.split>.btn+.btn),.sh-head .btn:not(.icon,.split>.btn+.btn){padding:0 8px}.top h1{display:none}.top{gap:8px;padding-left:16px}}
@container ss-panel (width < 720px){.top>.badge,.top>.pill{flex-shrink:1;min-width:0}.body>.side:not(.keep),.body>.vsplit:not(.keep){display:none}.scrim:has(>.dialog.xl){padding:0}.dialog.xl{width:100%;height:100%;border-radius:0}}
@media (prefers-reduced-motion:reduce){.app,.panel,.dialog,.scrim,.menu,.toast,.toast.out,.pop,.tip,.sheet,.mini,.list.enter .row,.sk i,.sk-row i{animation:none}.progress div,:is(.menu,.pop,.tip)[popover],.qtabs.reorder .tab:not(.drag){transition:none}}
@media (forced-colors:active){.btn:focus-visible,.btn.primary:focus-visible,.btn.danger:focus-visible{outline:2px solid Highlight;outline-offset:1px}.tab[aria-selected=true]::after,.switch[aria-checked=true],.progress div,.vsplit:hover,.hsplit:hover{background:Highlight}.switch i{background:ButtonText}.switch[aria-checked=true] i{background:HighlightText}.badge,.pill,.count,.toast,.menu,.pop,.tip,.mini,.dialog{border:1px solid CanvasText}}
`;

// The attribute that suspends every transition while the theme changes (BASE's .ss[data-theme-switch] rule).
export const THEME_SWITCH_ATTR = 'data-theme-switch';

// Set the token root's data-theme ('light' | 'dark') without colour transitions: the switch attribute is set, the
// theme changed and the style update forced while every transition is off, then the attribute is removed (see
// the notes above). Returns true when the theme changed.
export function switchTheme(root, theme) {
  if (theme !== 'light' && theme !== 'dark') throw new TypeError(`switchTheme(): expected 'light' or 'dark', got ${typeof theme === 'string' ? `'${theme}'` : typeof theme}.`);
  if (!root || typeof root.setAttribute !== 'function') throw new TypeError('switchTheme(): expected the .ss token root element.');
  if (root.getAttribute('data-theme') === theme) return false;
  root.setAttribute(THEME_SWITCH_ATTR, '');
  try {
    root.setAttribute('data-theme', theme);
    void root.offsetWidth; // style (and layout) update now, while transitions are off
  } finally {
    root.removeAttribute(THEME_SWITCH_ATTR);
  }
  return true;
}

// CSS named colours (CSS Color 4) that colorLiterals() reports when one appears as a value word; the Set is built on
// the first colorLiterals() call, never at module load.
const NAMED_LIST = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown '
  + 'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod '
  + 'darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon '
  + 'darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray '
  + 'dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green '
  + 'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon '
  + 'lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon '
  + 'lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta '
  + 'maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen '
  + 'mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab '
  + 'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum '
  + 'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna '
  + 'silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet '
  + 'wheat white whitesmoke yellow yellowgreen';
let named = null;
const isNamed = w => (named ??= new Set(NAMED_LIST.split(' '))).has(w.toLowerCase());
const isHexLen = n => n === 3 || n === 4 || n === 6 || n === 8;

// CSS system colours (CSS Color 4 §6.2 and the deprecated CSS2 ones of §6.3) and Chromium's -webkit- colour keywords,
// which module CSS may use only inside @media (forced-colors:active) (03 §1.3); every -internal- word counts too.
const SYSTEM_LIST = 'accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext field '
  + 'fieldtext graytext highlight highlighttext linktext mark marktext selecteditem selecteditemtext visitedtext '
  + 'activeborder activecaption appworkspace background buttonhighlight buttonshadow captiontext inactiveborder '
  + 'inactivecaption inactivecaptiontext infobackground infotext menu menutext scrollbar threeddarkshadow threedface '
  + 'threedhighlight threedlightshadow threedshadow window windowframe windowtext '
  + '-webkit-link -webkit-activelink -webkit-focus-ring-color -webkit-text';
let system = null;
const isSystem = w => {
  const l = w.toLowerCase();
  return l.startsWith('-internal-') || (system ??= new Set(SYSTEM_LIST.split(' '))).has(l);
};
// Properties whose words are names (properties, animations, grid areas, containers, counters, system fonts such as
// `font:menu`), so a word there that spells a system colour (`transition:background .1s`) is no colour.
const NAME_PROPS = new Set(['transition', 'transition-property', 'will-change', 'animation', 'animation-name', 'font', 'font-family',
  'grid-area', 'grid-row', 'grid-row-start', 'grid-row-end', 'grid-column', 'grid-column-start', 'grid-column-end', 'grid-template',
  'grid-template-areas', 'grid-template-rows', 'grid-template-columns', 'container', 'container-name', 'counter-reset',
  'counter-increment', 'counter-set', 'list-style', 'list-style-type', 'content', 'quotes', 'page', 'view-transition-name',
  'anchor-name', 'position-anchor', 'timeline-scope', 'scroll-timeline', 'scroll-timeline-name', 'view-timeline',
  'view-timeline-name', 'animation-timeline']);
const COLOR_FN = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|(?:^|[^\w-])(-internal-[\w-]+)\(/gi;
const URL_RE = /url\(\s*("[^"]*"|'[^']*'|[^)]*)\s*\)/gi;
// The @media prelude whose block 03 §1.3 exempts: (forced-colors:active), optionally `and` further conditions.
const FORCED_PRELUDE = /^\(\s*forced-colors\s*:\s*active\s*\)(?:\s+and\s+\([^(),]*\))*$/i;

// CSS escapes (`\72 ed`, `\r`) and SVG numeric character references (`&#114;`) as the characters they stand for.
const unescapeCss = s => s.replace(/\\([0-9a-f]{1,6})[ \t\n]?|\\([^\n0-9a-f])/gi, (_, hex, c) => (hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : c));
const unescapeRefs = s => s.replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));/gi, (_, hex, dec) => String.fromCodePoint(Math.min(hex ? parseInt(hex, 16) : Number(dec), 0x10ffff) || 0xfffd));

// The text of a CSS source without its @media (forced-colors:active) blocks (comments removed first). Quotes and
// parentheses are respected; an unclosed block is kept, so malformed CSS is still checked.
function withoutForcedColors(css) {
  const src = String(css).replace(/\/\*[\s\S]*?\*\//g, ' ');
  let out = '', from = 0, quote = null, paren = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') { paren++; continue; }
    if (c === ')') { if (paren) paren--; continue; }
    if (c !== '@' || paren || !/^@media(?![\w-])/i.test(src.slice(i, i + 7))) continue;
    const open = blockStart(src, i + 6);
    if (open < 0 || !FORCED_PRELUDE.test(src.slice(i + 6, open).trim())) continue;
    const close = blockEnd(src, open);
    if (close < 0) continue;
    out += src.slice(from, i) + ' ';
    from = close + 1;
    i = close;
  }
  return out + src.slice(from);
}

// Index of the `{` that opens the block of the at-rule prelude starting at i, or -1 (a `;` or `}` comes first).
function blockStart(src, i) {
  let quote = null, paren = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') paren++;
    else if (c === ')') { if (paren) paren--; }
    else if (!paren && c === '{') return i;
    else if (!paren && (c === ';' || c === '}')) return -1;
  }
  return -1;
}

// Index of the `}` that closes the block opened at `open`, or -1.
function blockEnd(src, open) {
  let quote = null, depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

// Colours inside one url() argument: %23hex anywhere; in a data: URI also #hex and paint attributes or properties
// (fill, stroke, …) that name a colour, after percent-decoding (%23 stays encoded, so it is reported once) and
// character references; a base64 data URI cannot be checked and is reported itself. Returns the decoded text, in which
// the caller looks for colour functions.
function urlColors(prop, raw, add) {
  const u = raw.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  for (const m of u.matchAll(/%23([0-9a-f]+)(?![0-9a-z])/gi)) if (isHexLen(m[1].length)) add(prop, m[0]);
  const head = /^\s*data:([^,]*),/i.exec(u);
  if (!head) return u;
  if (/;\s*base64\s*$/i.test(head[1])) { add(prop, `data:${head[1].trim()}`); return ''; }
  const body = unescapeRefs(u.slice(head[0].length).replace(/%([0-9a-f]{2})/gi, (m, h) => (h === '23' ? m : String.fromCharCode(parseInt(h, 16)))));
  for (const m of body.matchAll(/#([0-9a-f]+)(?![\w-])/gi)) if (isHexLen(m[1].length)) add(prop, m[0]);
  const paint = /(?:^|[\s;"'{(<])(?:fill|stroke|stop-color|flood-color|lighting-color|solid-color|color)\s*[:=]\s*\\?["']?\s*(-{0,2}[a-z][a-z0-9-]*)/gi;
  for (const m of body.matchAll(paint)) if (isNamed(m[1]) || isSystem(m[1])) add(prop, m[1]);
  return body;
}

// Declarations of a CSS text as [{prop, value}] (comments dropped; ; { } inside strings or parentheses don't split).
export function cssDeclarations(css) {
  const out = [];
  const src = String(css).replace(/\/\*[\s\S]*?\*\//g, ' ');
  let start = 0, depth = 0, quote = null;
  for (let i = 0; i <= src.length; i++) {
    const c = i < src.length ? src[i] : '}';
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') { depth++; continue; }
    if (c === ')') { if (depth) depth--; continue; }
    if (depth || (c !== ';' && c !== '{' && c !== '}')) continue;
    const seg = src.slice(start, i).trim();
    start = i + 1;
    if (c === '{' || !seg || seg[0] === '@') continue;
    const k = seg.indexOf(':');
    if (k > 0) out.push({ prop: seg.slice(0, k).trim().toLowerCase(), value: seg.slice(k + 1).trim() });
  }
  return out;
}

// Literal colours in a CSS text (03 §1.3): #hex; rgb()/hsl()/hwb()/lab()/lch()/oklab()/oklch()/color() and
// -internal- functions; named colours and system colour keywords used as values (CSS escapes decoded); in url()
// %23hex, and in a data: URI its decoded #hex, colour functions and named or system paint colours; base64 data URIs.
// Blocks of @media (forced-colors:active) are skipped (system colours belong there). Module CSS outside styles.js must
// return []; var(--token), color-mix() of tokens, transparent and currentColor are allowed.
export function colorLiterals(css) {
  const found = [];
  const add = (prop, literal) => found.push({ prop, literal });
  for (const { prop, value } of cssDeclarations(withoutForcedColors(css))) {
    const urls = [];
    const noUrls = unescapeCss(value.replace(URL_RE, (_, u) => { urls.push(u); return ' '; }));
    const decoded = urls.map(u => urlColors(prop, u, add));
    for (const text of [noUrls, ...decoded]) for (const m of text.matchAll(COLOR_FN)) add(prop, m[1] ? m[0] : `${m[2]}(`);
    const rest = noUrls.replace(/"[^"]*"|'[^']*'/g, ' ');
    for (const m of rest.matchAll(/#([0-9a-f]+)(?![\w-])/gi)) if (isHexLen(m[1].length)) add(prop, m[0]);
    const names = NAME_PROPS.has(prop);
    for (const m of rest.matchAll(/(^|[\s,(/])(-{0,2}[a-z][a-z0-9-]*)(?=$|[\s,)!/])/gi)) {
      if (isNamed(m[2]) || (!names && isSystem(m[2]))) add(prop, m[2]);
    }
  }
  return found;
}
