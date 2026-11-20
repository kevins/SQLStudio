// Bookmarklet entry (03 §11): runs on a Dynamics 365 / Power Apps page, starts the app with the real
// Web API of this origin, and sets the launch guard so a second click on the favorite shows or hides the window.
import { createApi } from './data/api.js';
import { createMeta } from './data/meta.js';
import * as store from './core/store.js';
import { startApp } from './app.js';

const KEY = Symbol.for('sqlstudio');
const BUILD = __BUILD__;

// True on a model-driven app page whose origin serves the Dataverse Web API.
function onDynamics() {
  const h = location.hostname.toLowerCase();
  return location.protocol === 'https:' && (/\.dynamics\.com$/.test(h) || /\.crm\d*\.dynamics\.com$/.test(h) || /\.microsoftdynamics\.(com|de|cn)$/.test(h) || /\.appsplatform\.us$/.test(h));
}

// A copy already on the page: the same build shows or hides it; another build, or one whose window is gone (the page
// removed it, or it failed), is replaced, so a click on the favorite always ends with a working SQL Studio.
function boot() {
  const prev = window[KEY];
  if (prev) {
    if (prev.v === BUILD) { try { if (prev.toggle() !== false) return; } catch { /* broken: replaced below */ } }
    let r = true;
    try { r = prev.destroy(); } catch { r = true; }
    if (r === false) { alert('SQL Studio is busy writing changes. Try again when it has finished.'); return; }
    try { delete window[KEY]; } catch { /* frozen elsewhere */ }
  }
  if (!__DEV__ && !onDynamics()) {
    alert('SQL Studio runs on a Dynamics 365 or Power Apps page. Open your model-driven app (https://<org>.crm.dynamics.com) and click it again.');
    return;
  }
  const { api, writeCaps } = createApi({ origin: location.origin });
  const meta = createMeta(api, { store });
  const app = startApp({ api, writeCaps, meta });
  window[KEY] = Object.freeze({
    v: BUILD,
    toggle: () => (app.shell.alive() ? app.shell.toggle() : false),
    show: () => app.shell.show(),
    destroy: () => { const r = app.destroy(); if (r !== false) delete window[KEY]; return r; },
  });
  requestAnimationFrame(() => requestAnimationFrame(() => performance.mark('sqlstudio:usable')));
}

try { boot(); } catch (e) { alert('SQL Studio could not start: ' + (e && e.message || e)); }
