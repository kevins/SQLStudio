// localStorage wrapper. Every access is guarded: the tool must work when storage is blocked or full.
const PREFIX = 'sqlstudio:';

export function get(key, fallback = null) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function set(key, value) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function del(key) {
  try { window.localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
}

export function keys(prefix = '') {
  const out = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i) || '';
      if (k.startsWith(PREFIX + prefix)) out.push(k.slice(PREFIX.length));
    }
  } catch { /* ignore */ }
  return out;
}
