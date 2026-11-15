// The demo glue: a pretend hash-routed app, the API in WebAssembly, and controls that switch the
// user and the access policy. The widget itself is the same build the Go service serves.
(() => {
  const { state, personas, presets, jar, jarKey, ready } = window.pinpathDemo;

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

  // --- mounting and the controls ------------------------------------------------------------
  const status = document.getElementById('status');
  function mount() {
    window.pinpath?.destroy();
    document.querySelector('script[data-pinpath-loader]')?.remove();
    window.pinpathServer.configure(presets[state.preset]);
    const s = document.createElement('script');
    s.src = 'widget.js';
    s.dataset.pinpathLoader = '';
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
      localStorage.setItem(`pinpath-demo:${id}`, select.value);
      if (id === 'persona') for (const k of Object.keys(jar)) delete jar[k];
      localStorage.setItem(jarKey, JSON.stringify(jar));
      mount();
    });
  }
  document.getElementById('reset').addEventListener('click', () => {
    window.pinpathServer.reset();
    localStorage.removeItem('pinpath:prefs');
    mount();
  });

  // The demo agent: what an agent does over MCP (list_threads, set_status, reply), through the same
  // API with an agent token — so it cannot resolve a thread or mark it checked either.
  const say = (line) => {
    status.textContent = `Agent: ${line}`;
    window.dispatchEvent(new CustomEvent('pinpath-demo-agent', { detail: line }));
  };
  const asAgent = async (method, path, body) => {
    const out = window.pinpathServer.serve({
      method,
      path,
      headers: { 'x-pinpath-token': window.pinpathServer.agentToken, 'content-type': 'application/json' },
      body: body ? new TextEncoder().encode(JSON.stringify(body)) : null,
    });
    return out.body.length ? JSON.parse(new TextDecoder().decode(out.body)) : null;
  };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  document.getElementById('agent').addEventListener('click', async () => {
    const { data } = await asAgent('GET', '/api/v1/threads?status=open&limit=1');
    const thread = data?.[0];
    if (!thread) return say('nothing open to fix.');
    say(`list_threads → #${thread.number} “${thread.body.slice(0, 48)}”`);
    await pause(1200);
    await asAgent('PATCH', `/api/v1/threads/${thread.id}`, { status: 'in_progress' });
    say(`set_status #${thread.number} in_progress`);
    window.pinpath?.refresh();
    await pause(1600);
    await asAgent('POST', `/api/v1/threads/${thread.id}/replies`, {
      body: 'Fixed in 0.4.2: the cell wraps now and keeps the currency. Please check.',
    });
    say(`reply #${thread.number} “Fixed in 0.4.2…”`);
    window.pinpath?.refresh();
    await pause(1200);
    await asAgent('PATCH', `/api/v1/threads/${thread.id}`, { status: 'fixed' });
    say(`set_status #${thread.number} fixed — waiting for a person to check`);
    window.pinpath?.refresh();
  });

  status.textContent = 'Starting the API…';
  ready.then(mount);
  window.addEventListener('pinpath-demo-failed', (e) => (status.textContent = `Could not start the API: ${e.detail}`));
})();
