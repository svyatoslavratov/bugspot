// Builds the screen map while people use the app: which screens and states they see, what they
// clicked to get there, where the links of a page lead, and a real look of each state — a thumbnail
// and a DOM snapshot — taken when the page settles and the map has none or the layout changed.

import { currentRoute, onRouteChange } from '../lib/route';
import {
  cleanName,
  currentState,
  interactiveOf,
  linkScreen,
  screenKeyOf,
  structureHash,
  viaOf,
  type ScreenOptions,
  type Via,
} from '../lib/screen';
import type { Api } from '../shared/api';
import type { CaptureInfo, EdgeInput, Session, Settings, StateKind, StateRef, VisitInput } from '../shared/types';
import { lookOptions, refOf, takeLook } from './look';

const FLUSH_MS = 4000;
const SETTLE_MS = 1200;
const SETTLE_MAX_MS = 6000;
const CLICK_WINDOW_MS = 2500;
const CAPTURE_GAP_MS = 8000;
const RECAPTURE_AFTER_MS = 10 * 60_000;
const REVISIT_MS = 5 * 60_000;
const MAX_LINKS = 150;

interface Current extends StateRef {
  kind: StateKind;
  name: string;
  at: number;
}

export interface CollectorOptions {
  api: Api;
  session: Session;
  settings: Settings;
  /** The widget's host element: never part of what is collected. */
  host: Element;
}

const sameRef = (a: StateRef | null, b: StateRef | null) => !!a && !!b && a.screen === b.screen && a.state === b.state;

/** Starts collecting; the returned function stops it. */
export function startCollector({ api, session, settings, host }: CollectorOptions): () => void {
  const options: ScreenOptions = { route: settings.route, params: settings.routeParams };
  const looks = lookOptions(session, host);
  let current: Current | null = null;
  let click: { from: StateRef; via: Via; at: number } | null = null;
  // A transition waits for the page to settle: until then its target may be a passing state (the
  // page before its tabs render).
  let pending: { from: StateRef; via: Via } | null = null;
  let popAt = 0;
  let lastMutation = Date.now();
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let evaluateTimer: ReturnType<typeof setTimeout> | undefined;
  let capturing = false;
  let lastCapture = 0;
  let stopped = false;
  const visits: VisitInput[] = [];
  const edges: EdgeInput[] = [];
  const sentVisits = new Map<string, number>();
  const sentEdges = new Set<string>();
  const known = new Map<string, CaptureInfo>();
  let aliases: Record<string, string> = {};
  const keyOf = (r: StateRef) => `${aliases[r.screen] ?? r.screen}\u0000${r.state}`;

  api.captures().then(
    (c) => {
      aliases = c.aliases ?? {};
      for (const s of c.states) known.set(keyOf(s), s);
    },
    () => undefined,
  );

  const addVisit = (s: Current) => {
    const title = cleanName(document.querySelector('h1')?.textContent || document.title, 300);
    const key = `${keyOf(s)}\u0000${title}`;
    const last = sentVisits.get(key);
    if (last && Date.now() - last < REVISIT_MS) return;
    sentVisits.set(key, Date.now());
    visits.push({
      screen: s.screen,
      state: s.state,
      kind: s.kind,
      name: s.name,
      title,
      url: location.href.slice(0, 2048),
      route: currentRoute(settings.route).slice(0, 2048),
    });
  };

  const addEdge = (e: EdgeInput) => {
    if (sameRef(e.from, e.to)) return;
    const key = `${keyOf(e.from)}>${keyOf(e.to)}>${e.via.selector}>${e.source}`;
    if (sentEdges.has(key)) return;
    sentEdges.add(key);
    edges.push(e);
  };

  async function flush(keepalive = false) {
    if (visits.length === 0 && edges.length === 0) return;
    const v = visits.splice(0, 100);
    const e = edges.splice(0, 100);
    try {
      await api.visits(v, e, keepalive);
    } catch {
      // Lost: the next visit of the same states reports them again.
    }
  }

  /** Links and declared transitions of the state: where it can lead without a click. */
  function scanLinks(from: StateRef) {
    let n = 0;
    for (const el of document.querySelectorAll('a[href], [data-bugspot-to]')) {
      if (n >= MAX_LINKS) break;
      if (host.contains(el) || el.closest('[data-bugspot-ignore]')) continue;
      const declared = el.getAttribute('data-bugspot-to')?.trim();
      let to: string | null;
      if (declared) to = /^(\/|#|https?:)/.test(declared) ? linkScreen(declared, options) : declared;
      else to = linkScreen(el.getAttribute('href') ?? '', options);
      if (!to) continue;
      n++;
      addEdge({ from, to: { screen: to, state: '' }, via: viaOf(el), source: declared ? 'declared' : 'link' });
    }
  }

  async function capture(ref: Current) {
    if (capturing || stopped || document.visibilityState !== 'visible') return;
    if (Date.now() - lastCapture < CAPTURE_GAP_MS) {
      settleTimer = setTimeout(onSettled, CAPTURE_GAP_MS);
      return;
    }
    const hash = structureHash();
    const info = known.get(keyOf(ref));
    const recent = info?.capturedAt && Date.now() - Date.parse(info.capturedAt) < RECAPTURE_AFTER_MS;
    if (info?.hasShot && (info.hash === hash || recent)) return;
    capturing = true;
    lastCapture = Date.now();
    try {
      // The look of a state the page has already left would mix two states.
      const look = await takeLook(api, ref, document, looks, () => sameRef(current, ref) && !stopped, flush);
      if (!look) return;
      known.set(keyOf(ref), { screen: ref.screen, state: ref.state, ...look, capturedAt: new Date().toISOString() });
    } catch {
      // Capturing is best effort: the next settle tries again.
    } finally {
      capturing = false;
    }
  }

  function onSettled() {
    const ref = current;
    if (!ref || stopped) return;
    const quiet = Date.now() - lastMutation >= SETTLE_MS;
    if (!quiet && Date.now() - ref.at < SETTLE_MAX_MS) {
      settleTimer = setTimeout(onSettled, SETTLE_MS);
      return;
    }
    if (pending) {
      addEdge({ from: pending.from, to: refOf(ref), via: pending.via, source: 'observed' });
      pending = null;
    }
    addVisit(ref);
    scanLinks(refOf(ref));
    void capture(ref);
  }

  function evaluate() {
    if (stopped) return;
    const state = currentState();
    const next: Current = {
      screen: screenKeyOf(options),
      state: state.key,
      kind: state.kind,
      name: state.name,
      at: Date.now(),
    };
    if (sameRef(current, next)) return;
    const prev = current;
    current = next;
    const now = Date.now();
    if (prev) {
      let via: Via | null = null;
      if (click && now - click.at < CLICK_WINDOW_MS && sameRef(click.from, prev)) via = click.via;
      // A redirect or a navigation after a save: no element to name.
      else if (prev.screen !== next.screen && now - popAt > 1000 && !pending)
        via = { name: '', kind: 'auto', selector: '' };
      if (via) {
        // The page moved on before it settled: the earlier transition ends where it was.
        if (pending) addEdge({ from: pending.from, to: refOf(prev), via: pending.via, source: 'observed' });
        pending = { from: refOf(prev), via };
      } else if (pending && popAt > 0 && now - popAt <= 1000) {
        pending = null;
      }
    }
    click = null;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(onSettled, SETTLE_MS);
  }

  const evaluateSoon = (delay: number) => {
    clearTimeout(evaluateTimer);
    evaluateTimer = setTimeout(evaluate, delay);
  };

  const onClick = (e: MouseEvent) => {
    if (e.composedPath().includes(host)) return;
    const target = e.composedPath()[0];
    if (!(target instanceof Element) || !current) return;
    const el = interactiveOf(target);
    if (!el) return;
    click = { from: { screen: current.screen, state: current.state }, via: viaOf(el), at: Date.now() };
    for (const delay of [80, 700, 1800]) setTimeout(evaluate, delay);
  };
  const onPop = () => void (popAt = Date.now());
  const onHide = () => void flush(true);
  const observer = new MutationObserver(() => {
    lastMutation = Date.now();
    evaluateSoon(250);
  });

  document.addEventListener('click', onClick, { capture: true });
  window.addEventListener('popstate', onPop);
  window.addEventListener('pagehide', onHide);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-selected', 'aria-modal', 'open', 'hidden', 'role', 'data-bugspot-screen'],
  });
  const stopRoutes = onRouteChange(() => evaluateSoon(60));
  const flushTimer = setInterval(() => void flush(), FLUSH_MS);
  evaluate();

  return () => {
    stopped = true;
    void flush(true);
    document.removeEventListener('click', onClick, { capture: true });
    window.removeEventListener('popstate', onPop);
    window.removeEventListener('pagehide', onHide);
    observer.disconnect();
    stopRoutes();
    clearInterval(flushTimer);
    clearTimeout(settleTimer);
    clearTimeout(evaluateTimer);
  };
}

/** The screen of the current page, for pins and new comments. */
export function currentScreen(settings: Settings): string {
  return screenKeyOf({ route: settings.route, params: settings.routeParams });
}
