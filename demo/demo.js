// The demo glue: a pretend hash-routed app, the API in WebAssembly, and controls that switch the
// user and the access policy. The widget itself is the same build the Go service serves.
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
  const stored = (key, fallback) => localStorage.getItem(`bugspot-demo:${key}`) || fallback;
  const state = { persona: stored('persona', 'anna'), preset: stored('preset', 'team'), lang: stored('lang', navigator.language.startsWith('ru') ? 'ru' : 'en') };
  const jarKey = 'bugspot-demo:cookies';
  const jar = JSON.parse(localStorage.getItem(jarKey) || '{}');
  const base = new URL('./', document.baseURI).href;

  // --- the pretend app ---------------------------------------------------------------------
  function render() {
    const route = location.hash.startsWith('#/') ? location.hash.slice(1).split('?')[0] : '/campaigns';
    const template = document.getElementById(route === '/authors' ? 'authors' : 'campaigns');
    document.getElementById('page').replaceChildren(template.content.cloneNode(true));
    for (const a of document.querySelectorAll('.app-nav a')) a.classList.toggle('active', a.dataset.route === route);
  }
  if (!location.hash) history.replaceState(null, '', '#/campaigns');
  window.addEventListener('hashchange', render);
  render();

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
    const out = window.bugspotServer.serve({ method: init.method || 'GET', path, headers, body: await bodyBytes(init.body) });
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
  window.bugspotConfig = { fetch: demoFetch, appVersion: '0.4.1' };

  // --- mounting and the controls ------------------------------------------------------------
  const status = document.getElementById('status');
  function mount() {
    window.bugspot?.destroy();
    document.querySelector('script[data-bugspot-loader]')?.remove();
    window.bugspotServer.configure(presets[state.preset]);
    const s = document.createElement('script');
    s.src = 'widget.js';
    s.dataset.bugspotLoader = '';
    s.dataset.api = './';
    s.dataset.lang = state.lang;
    s.dataset.route = 'hash';
    document.body.append(s);
    const visible = state.preset === 'public' || (state.preset === 'closed' ? state.persona === 'anna' : state.persona !== 'guest');
    status.textContent = visible ? 'The widget is visible for this user.' : 'This user does not see the widget: the loader stops after one request.';
  }
  for (const id of ['persona', 'preset', 'lang']) {
    const select = document.getElementById(id);
    select.value = state[id];
    select.addEventListener('change', () => {
      state[id] = select.value;
      localStorage.setItem(`bugspot-demo:${id}`, select.value);
      if (id === 'persona') for (const k of Object.keys(jar)) delete jar[k];
      localStorage.setItem(jarKey, JSON.stringify(jar));
      mount();
    });
  }
  document.getElementById('reset').addEventListener('click', () => {
    window.bugspotServer.reset();
    localStorage.removeItem('bugspot:prefs');
    mount();
  });

  window.onBugspotServerReady = mount;
  status.textContent = 'Starting the API…';
  const go = new Go();
  WebAssembly.instantiateStreaming(fetch('bugspot.wasm'), go.importObject).then(
    (result) => go.run(result.instance),
    (error) => (status.textContent = `Could not start the API: ${error}`),
  );
})();
