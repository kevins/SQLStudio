// 20x20 stroke icons in a Fluent 2 style (round caps/joins, currentColor).
// The first group is copied verbatim from that tool; the rest follow the same grid and weight.
const P = {
  layers: 'M10 2.5 2.5 6.5 10 10.5l7.5-4L10 2.5ZM2.5 10l7.5 4 7.5-4M2.5 13.5l7.5 4 7.5-4',
  close: 'M5 5l10 10M15 5 5 15',
  back: 'M12.5 4.5 7 10l5.5 5.5',
  search: 'M8.5 3.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10ZM12.2 12.2 16.5 16.5',
  refresh: 'M15.5 8A6 6 0 1 0 16 11.5M15.5 3.5V8H11',
  download: 'M10 3v9.5M6 9l4 4 4-4M4 16.5h12',
  chevron: 'M6 8l4 4 4-4',
  open: 'M11 4h5v5M16 4l-7 7M14.5 11.5v3a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 14.5V7a1.5 1.5 0 0 1 1.5-1.5h3',
  check: 'M4.5 10.5 8 14l7.5-8',
  warn: 'M10 3.5 17 16H3L10 3.5ZM10 8.5v3.5M10 14v.2',
  trash: 'M4 6h12M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6M8.5 9v4M11.5 9v4',
  save: 'M5.5 3.5h9v13L10 13.5l-4.5 3V3.5Z',
  info: 'M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM10 9v4.5M10 6.5v.2',
  error: 'M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM7.5 7.5l5 5M12.5 7.5l-5 5',
  okc: 'M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM7 10.2l2 2 4-4.4',
  filter: 'M3.5 4.5h13l-5 6.2v4.3l-3 1.5v-5.8l-5-6.2Z',
  sortUp: 'M10 16V4.5M5.5 9 10 4.5 14.5 9',
  sortDown: 'M10 4v11.5M5.5 11 10 15.5 14.5 11',
  maximize: 'M4.5 4.5h11v11h-11Z',
  restore: 'M4.5 7.5h8v8h-8ZM7.5 7.5v-3h8v8h-3',
  up: 'M5 12.5l5-5 5 5',
  down: 'M5 7.5l5 5 5-5',
  diff: 'M6 3.5h5.5L15 7v9a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5ZM8 13.5h4M10 7.5v4M8 9.5h4',
  copy: 'M7.5 6.5V4a.5.5 0 0 1 .5-.5h7.5a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5H13M4.5 6.5h8v10h-8Z',
  table: 'M3.5 4.5h13v11h-13ZM3.5 8.5h13M3.5 12h13M8 8.5v7',
  // SQL Studio additions
  db: 'M4 5.5C4 4.1 6.7 3 10 3s6 1.1 6 2.5S13.3 8 10 8 4 6.9 4 5.5ZM4 5.5v9C4 15.9 6.7 17 10 17s6-1.1 6-2.5v-9M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5',
  play: 'M6.5 4.5v11l9-5.5-9-5.5Z',
  stop: 'M5.5 5.5h9v9h-9Z',
  lock: 'M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9M4.5 9h11v7.5h-11ZM10 12v2',
  unlock: 'M6.5 9V6.5a3.5 3.5 0 0 1 6.8-1.2M4.5 9h11v7.5h-11ZM10 12v2',
  history: 'M3.5 10a6.5 6.5 0 1 0 1.9-4.6M3.5 3.5v3.3h3.3M10 6.5V10l2.5 2',
  settings: 'M3.5 6h8M15.5 6h1M3.5 14h1M8.5 14h8M13.5 4v4M6.5 12v4',
  help: 'M10 3.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM8 8.2a2 2 0 1 1 2.9 1.8c-.6.3-.9.7-.9 1.3v.4M10 13.6v.2',
  minimize: 'M5 10h10',
  plus: 'M10 4.5v11M4.5 10h11',
  more: 'M5 10h.01M10 10h.01M15 10h.01',
  format: 'M4 5h12M7 8.5h9M7 12h9M4 15.5h12',
  comment: 'M4 5h12v8.5H9l-3 2.5v-2.5H4Z',
  folder: 'M3.5 5.5h4.3l1.5 1.5h7.2v8.5h-13Z',
  column: 'M3.5 3.5h13v13h-13ZM8 3.5v13M12 3.5v13',
  key: 'M12.5 3.5a4 4 0 1 1-3.4 6.1L4 14.7v1.8h1.8l.7-.7v-1.3h1.3v-1.3h1.3l1-1a4 4 0 0 1 2.4-8.7ZM13.5 6.5v.2',
  link: 'M8.5 11.5l3-3M9 5.5l1-1a3.5 3.5 0 0 1 5 5l-1 1M11 14.5l-1 1a3.5 3.5 0 0 1-5-5l1-1',
  fx: 'M11.5 4.5c-1.4 0-2 .8-2.3 2.3L7.8 13.5c-.3 1.4-1 2-2.3 2M6.2 8.5h4.6M12.5 10l3.5 5M16 10l-3.5 5',
  text: 'M3.5 15l3-9.5 3 9.5M4.6 12h3.8M12.5 10.8c.4-.6 1-.8 1.8-.8 1.1 0 1.7.6 1.7 1.8V15M16 12.8c-1.5 0-3.8.1-3.8 1.3 0 .6.5.9 1.2.9 1.4 0 2.6-.9 2.6-2.2',
  number: 'M8 4l-1.5 12M13.5 4 12 16M4.5 8h12M3.5 12h12',
  calendar: 'M4.5 5.5h11v10h-11ZM4.5 8.5h11M7.5 3.5v3M12.5 3.5v3',
  choice: 'M8 6h8M8 10h8M8 14h8M4.5 6h.01M4.5 10h.01M4.5 14h.01',
  bool: 'M6.5 6.5h7a3.5 3.5 0 0 1 0 7h-7a3.5 3.5 0 0 1 0-7ZM13.5 10h.01',
  money: 'M10 3.5v13M13.4 6.6c-.5-1-1.7-1.6-3.4-1.6-2 0-3.3.9-3.3 2.3 0 3.1 7 1.8 7 5.2 0 1.5-1.4 2.5-3.7 2.5-1.8 0-3.2-.7-3.7-1.8',
  guid: 'M3.5 4.5h13v11h-13ZM7 8v4M10 8v4h1.3a2 2 0 0 0 0-4Z',
  relation: 'M5.5 3.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM14.5 12.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM7 7l6 6.5',
  right: 'M8 6l4 4-4 4',
  left: 'M12 6l-4 4 4 4',
  moon: 'M15.5 12.3A6.2 6.2 0 0 1 7.7 4.5a6.2 6.2 0 1 0 7.8 7.8Z',
  sun: 'M10 6.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7ZM10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1 1M14.3 14.3l1 1M4.7 15.3l1-1M14.3 5.7l1-1',
  plan: 'M3.5 4h5v3.5h-5ZM11.5 12.5h5V16h-5ZM6 7.5v6.8h5.5M6 10.5h5.5',
  code: 'M7 6l-4 4 4 4M13 6l4 4-4 4M11.2 4.5l-2.4 11',
  list: 'M4 5.5h12M4 10h12M4 14.5h8',
  eye: 'M2.5 10s3-5.5 7.5-5.5S17.5 10 17.5 10s-3 5.5-7.5 5.5S2.5 10 2.5 10ZM10 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z',
  edit: 'M12.5 4.5l3 3L7 16H4v-3l8.5-8.5ZM11 6l3 3',
  undo: 'M7.5 7.5H13a3.5 3.5 0 0 1 0 7H8M7.5 7.5l3-3M7.5 7.5l3 3',
  upload: 'M10 13V3.5M6 7.5l4-4 4 4M4 16.5h12',
  bolt: 'M11 3 5 11h5l-1 6 6-8h-5l1-6Z',
  cloud: 'M6.2 15.5a3.6 3.6 0 0 1-.5-7.2 4.6 4.6 0 0 1 8.8-1.1 3.9 3.9 0 0 1-.1 8.3Z',
  monitor: 'M3.5 4.5h13v9h-13ZM7.5 16.5h5M10 13.5v3',
  rows: 'M3.5 4.5h13v11h-13ZM3.5 8.2h13M3.5 11.8h13',
  pin: 'M7.5 3.5h5l-1 4 2.5 2.5v1.5h-8V10l2.5-2.5-1-4ZM10 11.5v5',
  sparkle: 'M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6L10 3Z',
  grip: 'M8 6h.01M12 6h.01M8 10h.01M12 10h.01M8 14h.01M12 14h.01',
  expand: 'M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4',
  collapse: 'M8 4v4H4M12 4v4h4M8 16v-4H4M12 16v-4h4',
  user: 'M10 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM4.5 16.5c.5-3 2.7-4.5 5.5-4.5s5 1.5 5.5 4.5',
  sigma: 'M14.5 4.5h-9l4.5 5.5-4.5 5.5h9',
  wrap: 'M4 5.5h12M4 10h10a2.5 2.5 0 0 1 0 5h-3M12.5 13.5 11 15l1.5 1.5M4 14.5h4',
  chartColumn: 'M3.5 16.5h13M5.5 16.5v-5h2.5v5M9 16.5V5h2.5v11.5M12.5 16.5v-8H15v8',
  chartBar: 'M3.5 3.5v13M3.5 5.5h7v2.5h-7M3.5 9h11.5v2.5H3.5M3.5 12.5h5V15h-5',
  chartLine: 'M3.5 3.5v13h13M5.5 13l3.5-4.5 3 2.5 4.5-6',
  chartPie: 'M10 3.5a6.5 6.5 0 1 0 6.5 6.5H10V3.5ZM12 2.5a5.5 5.5 0 0 1 5.5 5.5H12V2.5Z',
  shieldCheck: 'M10 2.8 4 5.2v4.3c0 3.6 2.5 6.4 6 7.7 3.5-1.3 6-4.1 6-7.7V5.2L10 2.8ZM7.3 10.1l1.9 1.9 3.6-3.8',
  chartScatter: 'M3.5 3.5v13h13M6.5 12.5h.01M9 9.5h.01M11.5 11h.01M13 6.5h.01M15 8.5h.01',
};

// Aliases for Dataverse table/attribute kinds (no module defines its own SVG paths).
const ALIAS = { activity: 'calendar', intersect: 'link', virtual: 'cloud', elastic: 'bolt', memo: 'list', file: 'folder', image: 'folder', multiselect: 'choice', csv: 'upload' };

// Path data for a name; unknown names throw in dev builds and fall back to 'info' in production.
function pathOf(name) {
  const d = P[ALIAS[name] || name];
  if (d) return d;
  if (typeof __DEV__ !== 'undefined' && __DEV__) throw new Error('Unknown icon: ' + name);
  return P.info;
}

const NS = 'http://www.w3.org/2000/svg';

// SVG element for an icon name (20x20 grid scaled to size).
export function icon(name, size = 16, cls) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', size >= 20 ? '1.25' : '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', pathOf(name));
  svg.appendChild(path);
  return svg;
}

// String form for static (compile-time) templates only.
export const iconHtml = (name, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${size >= 20 ? 1.25 : 1.5}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${pathOf(name)}"/></svg>`;

export const ICON_NAMES = [...Object.keys(P), ...Object.keys(ALIAS)];
