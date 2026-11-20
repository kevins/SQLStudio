// Minimal DOM helpers. Data is only ever inserted as text (never parsed as HTML).
import { icon } from './icons.js';
import { safeUrl, localUrl } from '../core/util.js';

// Attributes holding URLs. Only <a>/<area> href is a click-only link (safeUrl: https allowed); everything else
// is loaded by the browser on its own, so it must stay on this origin (localUrl).
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'formaction', 'xlink:href', 'poster', 'data', 'ping', 'background']);
// Elements that load or run code or change how URLs resolve: never created by SQL Studio.
const BLOCKED_TAGS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'base', 'meta', 'portal', 'applet']);

// URL attribute value through core/util.js (safeUrl for click-only links, else localUrl); a disallowed URL throws.
function urlAttr(tag, k, v, svg) {
  if (k === 'srcset' || k === 'ping') throw new Error('h(): ' + k + ' is not allowed');
  const link = !svg && k === 'href' && (tag === 'a' || tag === 'area');
  const u = link ? safeUrl(v) : localUrl(v);
  if (u == null) throw new Error('h(): blocked URL in ' + k);
  return u;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// h('div', {class, style, text, title, dataset, ref, on<event>, ...attrs}, ...children)
// h('svg:rect', {...}) creates an SVG element (same rules); 'class' becomes the class attribute there.
// on* props must be functions (never inline handler strings); URL attributes go through safeUrl().
// children: Node | string | number | false/null/undefined (skipped) | arrays (flattened)
export function h(tag, props, ...children) {
  const svg = tag.startsWith('svg:');
  const name = (svg ? tag.slice(4) : tag).toLowerCase();
  if (BLOCKED_TAGS.has(name) || name === 'foreignobject') throw new Error('h(): <' + name + '> is not allowed');
  const el = svg ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') { if (svg) el.setAttribute('class', v); else el.className = v; }
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v; // compile-time constant markup only (icons/templates), never data
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v;
        else for (const s in v) el.style.setProperty(s.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), v[s]);
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'ref') v(el);
      else if (k.startsWith('on')) {
        if (typeof v !== 'function') throw new Error('h(): ' + k + ' must be a function');
        el.addEventListener(k.slice(2), v);
      } else if (k === 'srcdoc') throw new Error('h(): srcdoc is not allowed');
      else if (URL_ATTRS.has(k)) el.setAttribute(k, urlAttr(name, k, v, svg));
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'tabIndex' || k === 'hidden') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

// Append children (Node, text, arrays; null/false/true skipped) to el.
export function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}

export const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const setChildren = (el, ...children) => append(clear(el), children);

// Button with an icon and optional label: btn('play', 'Run', {class:'primary', onclick})
export function btn(iconName, label, props = {}) {
  const cls = 'btn' + (props.class ? ' ' + props.class : '') + (label ? '' : ' icon');
  const p = { type: 'button', ...props, class: cls };
  if (!label && props.title && !props['aria-label']) p['aria-label'] = props.title;
  return h('button', p, iconName ? icon(iconName, 20) : null, label ? h('span', { class: 'lbl', text: label }) : null);
}

// on(el, 'click', fn) -> returns an unsubscribe function
export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

// Keep Tab focus inside `root` (dialogs). Returns a release function.
export function trapFocus(root) {
  const sel = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const handler = e => {
    if (e.key !== 'Tab') return;
    const items = [...root.querySelectorAll(sel)].filter(x => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const active = root.getRootNode().activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };
  root.addEventListener('keydown', handler);
  return () => root.removeEventListener('keydown', handler);
}

let canvas;
export function measureText(text, font) {
  canvas = canvas || document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  return ctx.measureText(text).width;
}

// Position a floating element (menu/popup) near an anchor rect, kept inside the container rect.
export function placeNear(el, anchor, container, { gap = 4, align = 'start' } = {}) {
  const w = el.offsetWidth, hgt = el.offsetHeight;
  let x = align === 'end' ? anchor.right - w : anchor.left;
  let y = anchor.bottom + gap;
  if (y + hgt > container.bottom - 8) y = Math.max(container.top + 8, anchor.top - hgt - gap);
  x = Math.max(container.left + 8, Math.min(x, container.right - w - 8));
  el.style.left = (x - container.left) + 'px';
  el.style.top = (y - container.top) + 'px';
}
