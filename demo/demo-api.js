// The demo API: the real API handler compiled to WebAssembly, behind a fetch for the widget and the
// map page. Both pages load this file; the state lives in IndexedDB (with the looks of the screen
// map) and the chosen user and access policy in localStorage.
(() => {
  const personas = {
    anna: { id: 'anna', name: 'Anna (admin)', roles: 'admin' },
    boris: { id: 'boris', name: 'Boris (developer)', roles: 'developer' },
    guest: null,
  };
  const presets = {
    team: { view: 'authenticated', comment: 'authenticated', moderate: 'role:admin' },
    closed: { view: 'role:admin', comment: 'role:admin', moderate: 'role:admin' },
    public: { view: '*', comment: '*', moderate: 'role:admin' },
  };
  const stored = (key, fallback) => localStorage.getItem(`pinpath-demo:${key}`) || fallback;
  const state = { persona: stored('persona', 'anna'), preset: stored('preset', 'team'), lang: stored('lang', navigator.language.startsWith('ru') ? 'ru' : 'en') };
  const jarKey = 'pinpath-demo:cookies';
  const jar = JSON.parse(localStorage.getItem(jarKey) || '{}');
  const base = new URL('./', document.baseURI).href;

  // --- the API in the browser ---------------------------------------------------------------
  async function bodyBytes(body) {
    if (body == null) return null;
    if (typeof body === 'string') return new TextEncoder().encode(body);
    if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return new TextEncoder().encode(String(body));
  }

  async function demoFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = '/' + url.href.slice(base.length).replace(/^\//, '');
    const headers = {};
    new Headers(init.headers || {}).forEach((v, k) => (headers[k] = v));
    const persona = personas[state.persona];
    if (persona) {
      headers['x-demo-user'] = persona.id;
      headers['x-demo-name'] = persona.name;
      headers['x-demo-roles'] = persona.roles;
    }
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const out = window.pinpathServer.serve({ method: init.method || 'GET', path, headers, body: await bodyBytes(init.body) });
    const resHeaders = new Headers();
    for (const [name, value] of out.headers) {
      if (name === 'set-cookie') {
        const [pair] = value.split(';');
        const [k, v] = pair.split('=');
        if (/max-age=-1|max-age=0/i.test(value)) delete jar[k];
        else jar[k] = v;
        localStorage.setItem(jarKey, JSON.stringify(jar));
      } else resHeaders.append(name, value);
    }
    const empty = out.status === 204 || out.status === 304;
    return new Response(empty ? null : out.body, { status: out.status, headers: resHeaders });
  }


  // --- saving in IndexedDB ------------------------------------------------------------------
  const db = new Promise((resolve) => {
    try {
      const open = indexedDB.open('pinpath-demo', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('state');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  const stateStore = (mode, run) =>
    db.then(
      (d) =>
        d &&
        new Promise((resolve) => {
          const tx = d.transaction('state', mode);
          const request = run(tx.objectStore('state'));
          tx.oncomplete = () => resolve(request.result);
          tx.onerror = () => resolve(null);
        }),
    );
  window.pinpathDemoSave = (data) => void stateStore('readwrite', (s) => s.put(data, 'state'));

  // --- starting the API ---------------------------------------------------------------------
  let started;
  const ready = new Promise((resolve) => (started = resolve));
  window.onPinpathServerReady = () => started();
  const fetchWhenReady = async (input, init) => {
    await ready;
    return demoFetch(input, init);
  };
  window.pinpathConfig = { fetch: fetchWhenReady, appVersion: '0.4.1' };
  window.pinpathDemo = { state, personas, presets, jar, jarKey, ready, failed: null };
  stateStore('readonly', (s) => s.get('state')).then(async (saved) => {
    if (typeof saved === 'string') window.pinpathDemoSaved = saved;
    try {
      const go = new Go();
      const result = await WebAssembly.instantiateStreaming(fetch('pinpath.wasm'), go.importObject);
      go.run(result.instance);
    } catch (error) {
      window.pinpathDemo.failed = String(error);
      window.dispatchEvent(new CustomEvent('pinpath-demo-failed', { detail: String(error) }));
    }
  });
})();
