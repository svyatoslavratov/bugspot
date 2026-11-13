// Walks the app by itself to build the screen map: opens it in a frame of the same origin (or in a
// window when the app refuses frames), loads every screen it finds a link to, selects the tabs,
// opens the windows that buttons promise, and records each state with its real look and the
// transitions between them — what the collector records while people work, without the people.
//
// It never presses what may change data: buttons named like deleting, sending, saving, paying or
// signing out stay untouched, forms do not submit, confirm() answers "no", and other buttons are
// pressed only when asked (CrawlOptions.buttons) or when the app marks them (aria-haspopup="dialog",
// data-bugspot-crawl).

import { currentRoute } from '../lib/route';
import {
  cleanName,
  currentState,
  linkScreen,
  routeKey,
  screenKeyOf,
  structureHash,
  viaOf,
  type ScreenOptions,
  type Via,
} from '../lib/screen';
import type { Api } from '../shared/api';
import type { CaptureInfo, EdgeInput, Session, Settings, StateRef, VisitInput } from '../shared/types';
import { lookOptions, refOf, takeLook } from './look';

export interface CrawlOptions {
  /** The address to start from; links lead everywhere else. */
  start: string;
  /** Press any button that is not dangerous, not only those that say they open a window. */
  buttons: boolean;
  maxScreens: number;
  maxMinutes?: number;
}

export type CrawlPhase = 'starting' | 'running' | 'done' | 'stopped' | 'error';

export interface CrawlStatus {
  phase: CrawlPhase;
  screens: number;
  states: number;
  looks: number;
  edges: number;
  queued: number;
  /** The address being explored. */
  current: string;
  error?: string;
  /** The app refuses to open in a frame: a window opened by a click can do instead. */
  blocked?: boolean;
  /** Requests the walked app tried that were not reads: stopped, so its data stays as it was. */
  writesBlocked: number;
  /** The map page. */
  map: string;
}

/** Where the app is walked: a frame of the widget, or a window. */
export interface CrawlTarget {
  /** The app's window when it is readable (same origin, loaded), else null. */
  win(): Window | null;
  go(url: string): void;
  /** True once a load finished that the crawler cannot read: the app refused the frame. */
  refused(): boolean;
  close(): void;
}

export function frameTarget(frame: HTMLIFrameElement): CrawlTarget {
  // Loads since the last go(): the blank page a new frame starts with does not count.
  let loads = 0;
  frame.addEventListener('load', () => loads++);
  const readable = () => {
    try {
      const w = frame.contentWindow;
      return w && w.document && w.location.href !== 'about:blank' ? w : null;
    } catch {
      return null;
    }
  };
  return {
    win: readable,
    go: (url) => {
      loads = 0;
      frame.src = url;
    },
    refused: () => loads > 0 && readable() === null,
    close: () => frame.remove(),
  };
}

export function windowTarget(popup: Window): CrawlTarget {
  const readable = () => {
    try {
      return !popup.closed && popup.document && popup.location.href !== 'about:blank' ? popup : null;
    } catch {
      return null;
    }
  };
  return {
    win: readable,
    go: (url) => popup.location.replace(url),
    refused: () => popup.closed,
    close: () => popup.close(),
  };
}

const LOAD_MS = 25_000;
const QUIET_MS = 600;
const SETTLE_MAX_MS = 10_000;
const BUSY_MAX_MS = 5_000;
const MAX_TABS = 10;
const MAX_BUTTONS = 15;
const MAX_STATES = 16;
const MAX_LINKS = 300;
const RECAPTURE_MS = 24 * 3600_000;

const NAV = 'nav, aside, header, [role="navigation"], [data-bugspot-nav]';
const DIALOG = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
/** Names of buttons that may change data or end the session: never pressed. */
export const DANGER = new RegExp(
  [
    'удал|стер|очист|сброс|выйти|выход|отправ|сохран|примен|подтвер|оплат|куп|заказ|архив|блок|отклон|одобр|принят|принять',
    'публик|запуст|останов|отмен|отозв|деактив|активир|включ|выключ|отключ|подключ|импорт|загруз|синхрон|перев[её]д',
    'вывод|списа|возврат|восстанов|объедин|пригла|передат|отдат|назнач|верну|дублир|копир|экспорт|скача|выгруз|печат',
    'обнов|пересч|генер|отпис|подпис|продл|заверш',
    // English names as whole words: "Orders" is a list, "Order" a purchase.
    '\\b(delete|remove|erase|clear|reset|log ?out|sign ?out|send|submit|save|apply|confirm|pay|buy|order|archive',
    'block|ban|reject|decline|approve|accept|publish|launch|start|run|stop|cancel|revoke|deactivate|activate|enable',
    'disable|connect|disconnect|import|upload|sync|transfer|withdraw|charge|refund|restore|merge|lock|unlock|invite',
    'assign|duplicate|copy|export|download|print|refresh|reload|generate|unsubscribe|subscribe|renew|finish|complete)\\b',
  ].join('|'),
  'i',
);
/** Names of links that end the session. */
const LEAVE = /выйти|выход|\b(log ?out|sign ?out|log ?off)\b/i;
/** Addresses that end the session, anywhere in the path. */
const LEAVE_PATH = /(log-?out|sign-?out|logoff|exit|выход)/i;
/** Addresses of files, by their extension. */
const FILE_PATH = /\.(pdf|zip|csv|xlsx?|docx?|pptx?|png|jpe?g|gif|svg|webp|mp4|mp3|json|xml|txt)$/i;
const CLOSE_NAME = /^(закрыть|отмена|отменить|close|cancel|dismiss|×|✕|✖|x)$/i;

class Stopped extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Guarded = Window & { __bugspotGuard?: boolean; __bugspotInflight?: number };

/** Only reads go out of the walked app: anything else could change its data. */
const READ = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Makes the walked app harmless and observable: requests that are not reads fail as a network
 * error would, forms do not submit, dialogs that ask answer "no", new windows do not open, and
 * requests in flight are counted for settling. onBlocked hears of each request it stopped.
 */
export function guard(w: Window, onBlocked: (what: string) => void = () => undefined) {
  const g = w as Guarded;
  if (g.__bugspotGuard) return;
  g.__bugspotGuard = true;
  g.__bugspotInflight = 0;
  try {
    g.alert = () => undefined;
    g.confirm = () => false;
    g.prompt = () => null;
    g.print = () => undefined;
    g.open = () => null;
    w.addEventListener('submit', (e) => e.preventDefault(), true);
    const nav = w.navigator as Navigator & { sendBeacon?: Navigator['sendBeacon'] };
    if (nav.sendBeacon) {
      nav.sendBeacon = (url: string | URL) => {
        onBlocked(`beacon ${String(url)}`);
        return false;
      };
    }
    const fetch = g.fetch;
    if (fetch) {
      g.fetch = (...args: Parameters<typeof fetch>) => {
        const [input, init] = args;
        const method = (
          init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
        ).toUpperCase();
        if (!READ.has(method)) {
          onBlocked(`${method} ${typeof input === 'object' && 'url' in input ? input.url : String(input)}`);
          return Promise.reject(new TypeError('Failed to fetch: the bugspot crawl lets only reads through'));
        }
        g.__bugspotInflight! += 1;
        return fetch.apply(w, args).finally(() => (g.__bugspotInflight! -= 1));
      };
    }
    const XHR = (w as unknown as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
    if (XHR) {
      const methods = new WeakMap<XMLHttpRequest, string>();
      const open = XHR.prototype.open;
      XHR.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
        methods.set(this, String(args[0]).toUpperCase());
        return (open as (...a: unknown[]) => void).apply(this, args);
      } as XMLHttpRequest['open'];
      const send = XHR.prototype.send;
      XHR.prototype.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
        const method = methods.get(this) ?? 'GET';
        if (!READ.has(method)) {
          onBlocked(`${method} ${this.responseURL || 'xhr'}`);
          // As a request the network refused: an error, then the end.
          const PE = (w as unknown as { ProgressEvent: typeof ProgressEvent }).ProgressEvent;
          setTimeout(() => {
            this.dispatchEvent(new PE('error'));
            this.dispatchEvent(new PE('loadend'));
          });
          return;
        }
        g.__bugspotInflight! += 1;
        this.addEventListener('loadend', () => (g.__bugspotInflight! -= 1), { once: true });
        return send.apply(this, args);
      };
    }
  } catch {
    // A page that locks its globals is walked with the guards it allowed.
  }
}

function shown(el: Element): boolean {
  if (el.closest('[hidden], [aria-hidden="true"], [data-bugspot-ignore], [inert]')) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none'))
    return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

const disabled = (el: Element) =>
  el.hasAttribute('disabled') ||
  el.getAttribute('aria-disabled') === 'true' ||
  el.closest('fieldset[disabled]') !== null;

/** A real click as a person makes it: pointer and mouse events at the middle of the element. */
export function press(el: Element) {
  const w = el.ownerDocument.defaultView;
  if (!w) return;
  (el as HTMLElement).scrollIntoView?.({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: w,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
    button: 0,
  };
  const ctors = w as unknown as {
    MouseEvent: typeof MouseEvent;
    PointerEvent?: new (type: string, init: PointerEventInit) => Event;
  };
  const Pointer: new (type: string, init: PointerEventInit) => Event = ctors.PointerEvent ?? ctors.MouseEvent;
  const pointer = { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  el.dispatchEvent(new Pointer('pointerdown', { ...pointer, buttons: 1 }));
  el.dispatchEvent(new ctors.MouseEvent('mousedown', { ...init, buttons: 1 }));
  (el as HTMLElement).focus?.({ preventScroll: true });
  el.dispatchEvent(new Pointer('pointerup', pointer));
  el.dispatchEvent(new ctors.MouseEvent('mouseup', init));
  el.dispatchEvent(new ctors.MouseEvent('click', { ...init, detail: 1 }));
}

function escape(el: Element) {
  const w = el.ownerDocument.defaultView;
  if (!w) return;
  const K = (w as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  for (const type of ['keydown', 'keyup'])
    el.dispatchEvent(
      new K(type, {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
}

/** A thing to press on a state, found again by its selector after the page reloads. */
interface Candidate {
  via: Via;
  kind: 'tab' | 'button' | 'row';
}

/** Tabs to select: of tab lists that are not the app's menu, not selected, not disabled. */
export function tabsOf(doc: Document): Candidate[] {
  return [...doc.querySelectorAll('[role="tab"]')]
    .filter((t) => t.getAttribute('aria-selected') !== 'true' && !t.closest(NAV) && !disabled(t) && shown(t))
    .slice(0, MAX_TABS)
    .map((el) => ({ via: viaOf(el), kind: 'tab' }));
}

/**
 * Buttons that may open a window and rows that may lead to a record. Buttons are pressed when they
 * say they open a dialog or the app marks them; with all set, any named button that is not
 * dangerous. A row of each table is clicked when it looks clickable.
 */
export function pressablesOf(root: ParentNode, all: boolean): Candidate[] {
  const out: Candidate[] = [];
  const names = new Set<string>();
  for (const el of root.querySelectorAll(
    'button, [role="button"], input[type="button"], [aria-haspopup], [data-bugspot-crawl], [role="link"]:not([href])',
  )) {
    if (out.length >= MAX_BUTTONS) break;
    if (el.closest(NAV) || el.closest('[role="tablist"]') || el.matches('a[href], [role="tab"]') || disabled(el))
      continue;
    const marked = el.hasAttribute('data-bugspot-crawl') && el.getAttribute('data-bugspot-crawl') !== 'skip';
    if (el.getAttribute('data-bugspot-crawl') === 'skip' || (el.getAttribute('type') === 'submit' && !marked)) continue;
    const via = viaOf(el);
    // A button without a name may be a trash can: nothing tells.
    if (!marked && (!via.name || DANGER.test(via.name))) continue;
    const opens = el.getAttribute('aria-haspopup') === 'dialog' || el.matches('[role="link"]');
    if (!marked && !opens && !all) continue;
    if (el.closest('form') && !marked && !opens) continue;
    if (names.has(via.name) || !shown(el)) continue;
    names.add(via.name);
    out.push({ via, kind: 'button' });
  }
  for (const table of root.querySelectorAll('table, [role="grid"], [role="table"]')) {
    const row = [...table.querySelectorAll('tbody tr, [role="row"]')].find(
      (r) => !r.querySelector('th, [role="columnheader"]') && shown(r),
    );
    if (!row || row.querySelector('a[href]')) continue;
    const cells = [...row.querySelectorAll('td, [role="gridcell"], [role="cell"]')];
    const cell = cells.find((c) => !c.querySelector('input, button, [role="checkbox"]')) ?? row;
    const cursor = cell.ownerDocument.defaultView?.getComputedStyle(cell).cursor;
    if (cursor !== 'pointer') continue;
    out.push({ via: { ...viaOf(cell), kind: 'link' }, kind: 'row' });
  }
  return out;
}

function find(doc: Document, c: Candidate): Element | null {
  try {
    return doc.querySelector(c.via.selector);
  } catch {
    return null;
  }
}

interface Ref extends StateRef {
  kind: 'page' | 'tab' | 'dialog';
  name: string;
}

export interface CrawlerOptions {
  api: Api;
  session: Session;
  settings: Settings;
  target: CrawlTarget;
  options: CrawlOptions;
  onStatus: (s: CrawlStatus) => void;
  /** How long a page must stay still to count as settled; tests shorten it. */
  quietMs?: number;
}

/** Starts a crawl; stop() ends it after the current step, and what it found stays on the map. */
export function startCrawl({ api, session, settings, target, options, onStatus, quietMs = QUIET_MS }: CrawlerOptions): {
  stop(): void;
  done: Promise<CrawlStatus>;
} {
  const screenOptions: ScreenOptions = { route: settings.route, params: settings.routeParams };
  const looks = lookOptions(session, null);
  const start = new URL(options.start);
  const deadline = Date.now() + (options.maxMinutes ?? 30) * 60_000;
  const apiBase = new URL(api.base, location.href);
  let stopped = false;
  const status: CrawlStatus = {
    phase: 'starting',
    screens: 0,
    states: 0,
    looks: 0,
    edges: 0,
    queued: 0,
    current: options.start,
    writesBlocked: 0,
    map: new URL('map', apiBase).href,
  };
  const report = () => onStatus({ ...status });
  const blocked = () => {
    status.writesBlocked++;
    report();
  };

  const queue: string[] = [];
  const queuedKeys = new Set<string>();
  const explored = new Set<string>();
  const states = new Set<string>();
  const sentEdges = new Set<string>();
  // Buttons that changed nothing once (a sort menu, a date picker): the same name on the next
  // screen is the same control, not worth a press.
  const inert = new Set<string>();
  const visits: VisitInput[] = [];
  const edges: EdgeInput[] = [];
  const known = new Map<string, CaptureInfo>();
  let aliases: Record<string, string> = {};
  const keyOf = (r: StateRef) => `${aliases[r.screen] ?? r.screen}\u0000${r.state}`;

  const check = () => {
    if (stopped) throw new Stopped();
  };

  /** The screen a same-origin address leads to, or null for what is not walked. */
  function screenOfUrl(href: string): string | null {
    let url: URL;
    try {
      url = new URL(href, start);
    } catch {
      return null;
    }
    if (url.origin !== start.origin || LEAVE_PATH.test(url.pathname) || FILE_PATH.test(url.pathname)) return null;
    // The service itself may live on the app's origin (/bugspot/): it is not the app.
    if (url.origin === apiBase.origin && url.pathname.startsWith(apiBase.pathname)) return null;
    return routeKey(screenOptions, url);
  }

  function enqueue(href: string) {
    const key = screenOfUrl(href);
    if (!key || queuedKeys.has(key) || explored.has(key)) return;
    queuedKeys.add(key);
    queue.push(new URL(href, start).href);
    status.queued = queue.length;
  }

  async function flush() {
    while (visits.length || edges.length) {
      await api.visits(visits.splice(0, 100), edges.splice(0, 100));
    }
  }

  function addEdge(from: StateRef, to: StateRef, via: Via, source: EdgeInput['source']) {
    if (from.screen === to.screen && from.state === to.state) return;
    const key = `${keyOf(from)}>${keyOf(to)}>${via.selector}>${source}`;
    if (sentEdges.has(key)) return;
    sentEdges.add(key);
    edges.push({ from: refOf(from), to: refOf(to), via, source });
    status.edges++;
  }

  /** Waits until the page stops changing: no DOM mutations and no requests for a moment. */
  async function settle(w: Window, max = SETTLE_MAX_MS) {
    const doc = w.document;
    let last = Date.now();
    const Observer = (w as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver;
    const observer = new Observer(() => (last = Date.now()));
    observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const begin = Date.now();
    try {
      while (Date.now() - begin < max) {
        await sleep(100);
        check();
        if (target.win()?.document !== doc) return;
        const inflight = (w as Guarded).__bugspotInflight ?? 0;
        const busy = Date.now() - begin < BUSY_MAX_MS && doc.querySelector('[aria-busy="true"]') !== null;
        if (inflight <= 0 && !busy && Date.now() - last >= quietMs) break;
      }
      await Promise.race([doc.fonts?.ready, sleep(2000)]);
    } finally {
      observer.disconnect();
    }
  }

  /** Waits for a new document after a navigation, guards it and lets it settle. */
  async function arrive(before: Document | null): Promise<Window> {
    const begin = Date.now();
    while (Date.now() - begin < LOAD_MS) {
      await sleep(100);
      check();
      const w = target.win();
      if (!w) {
        if (target.refused()) throw Object.assign(new Error('refused'), { refused: true });
        continue;
      }
      if (w.document === before) continue;
      // As early as the new page shows: before it can send anything on its own.
      guard(w, blocked);
      if (w.document.readyState === 'complete') {
        await settle(w);
        return target.win() ?? w;
      }
    }
    throw new Error('the page did not load in time');
  }

  async function load(url: string): Promise<Window> {
    const w = target.win();
    const before = w?.document ?? null;
    const now = w ? new URL(w.location.href) : null;
    const next = new URL(url);
    const samePage =
      w && now && now.origin === next.origin && now.pathname === next.pathname && now.search === next.search;
    if (samePage && now.hash !== next.hash) {
      // A hash router moves inside one document: no new page comes.
      w.location.href = url;
      await sleep(150);
      await settle(w);
      return w;
    }
    // The same address with a hash would not load again: reload it.
    if (samePage && next.hash) w.location.reload();
    else target.go(url);
    return arrive(before);
  }

  /** After a press: a new document, the same one changed, or the app left for another origin. */
  async function afterPress(w: Window): Promise<Window | null> {
    const before = w.document;
    await sleep(150);
    const now = target.win();
    if (!now) return null;
    if (now.document !== before) return arrive(before);
    await settle(now, 6000);
    return target.win();
  }

  function refIn(w: Window): Ref {
    const state = currentState(w.document);
    return {
      screen: screenKeyOf(screenOptions, w.location, w.document),
      state: state.key,
      kind: state.kind,
      name: state.name,
    };
  }

  /** Records what the window shows: the visit, its look, and where its links lead. */
  async function record(w: Window, ref: Ref, from?: StateRef, via?: Via) {
    const doc = w.document;
    if (from && via) addEdge(from, ref, via, 'observed');
    const id = keyOf(ref);
    if (!states.has(id)) {
      states.add(id);
      status.states = states.size;
      visits.push({
        screen: ref.screen,
        state: ref.state,
        kind: ref.kind,
        name: ref.name,
        title: cleanName(doc.querySelector('h1')?.textContent || doc.title, 300),
        url: w.location.href.slice(0, 2048),
        route: currentRoute(settings.route, w.location).slice(0, 2048),
      });
      const info = known.get(id);
      const hash = structureHash(doc);
      const fresh = info?.capturedAt && Date.now() - Date.parse(info.capturedAt) < RECAPTURE_MS;
      if (!info?.hasShot || info.hash !== hash || !fresh) {
        const look = await takeLook(api, ref, doc, looks, () => target.win()?.document === doc, flush).catch(
          () => null,
        );
        if (look?.hasShot) status.looks++;
      }
    }
    // Links of a window are its own; a tab's are those of its panel; a page's are all.
    const scope =
      ref.kind === 'dialog'
        ? ([...doc.querySelectorAll(DIALOG)].at(-1) ?? null)
        : ref.kind === 'tab'
          ? doc.querySelector('[role="tabpanel"]:not([hidden])')
          : doc;
    let n = 0;
    for (const el of scope?.querySelectorAll('a[href], [data-bugspot-to]') ?? []) {
      if (n >= MAX_LINKS) break;
      if (el.closest('[data-bugspot-ignore]')) continue;
      const declared = el.getAttribute('data-bugspot-to')?.trim();
      const href = declared ?? el.getAttribute('href') ?? '';
      const to =
        declared && !/^(\/|#|https?:)/.test(declared) ? declared : linkScreen(href, screenOptions, w.location.href);
      if (!to) continue;
      n++;
      addEdge(ref, { screen: to, state: '' }, viaOf(el), declared ? 'declared' : 'link');
      if (!declared && !LEAVE.test(viaOf(el).name) && el.getAttribute('download') === null)
        enqueue(new URL(href, w.location.href).href);
    }
    report();
  }

  /** Closes a window the crawl opened: Escape, then a closing button; false if it stays. */
  async function closeDialog(w: Window): Promise<boolean> {
    const isOpen = () => currentState(w.document).kind === 'dialog';
    const dialog = [...w.document.querySelectorAll(DIALOG)].at(-1);
    escape(w.document.activeElement ?? w.document.body);
    await sleep(300);
    if (isOpen() && dialog) escape(dialog);
    await sleep(300);
    if (!isOpen()) return true;
    const close = [...(dialog?.querySelectorAll('button, [role="button"]') ?? [])].find((b) => {
      const name = viaOf(b).name;
      return CLOSE_NAME.test(name) || /close|закрыть/i.test(b.getAttribute('aria-label') ?? '');
    });
    if (close) {
      press(close);
      await settle(w, 3000);
    }
    return !isOpen();
  }

  /** Presses each candidate of the state and records where it leads, coming back after each. */
  async function tryAll(
    base: Ref,
    candidates: Candidate[],
    restore: () => Promise<Window>,
    tried: Set<string>,
    perScreen: { states: number },
  ) {
    let w = target.win();
    for (const c of candidates) {
      check();
      if (perScreen.states >= MAX_STATES) return;
      const id = `${c.kind}:${c.via.name}:${c.kind === 'row' ? c.via.selector : ''}`;
      if (tried.has(id) || (c.kind === 'button' && inert.has(c.via.name))) continue;
      tried.add(id);
      if (!w || refIn(w).state !== base.state || refIn(w).screen !== base.screen) w = await restore();
      const el = find(w.document, c);
      if (!el || !shown(el)) continue;
      press(el);
      const after = await afterPress(w);
      if (!after) {
        w = await restore();
        continue;
      }
      const now = refIn(after);
      if (now.screen === base.screen && now.state === base.state) {
        if (c.kind === 'button') inert.add(c.via.name);
        escape(after.document.activeElement ?? after.document.body);
        w = after;
        continue;
      }
      if (now.screen !== base.screen) {
        addEdge(base, now, c.via, 'observed');
        enqueue(after.location.href);
        w = await restore();
        continue;
      }
      perScreen.states++;
      await record(after, now, base, c.via);
      if (now.kind === 'dialog' && (await closeDialog(after))) w = after;
      else w = await restore();
    }
  }

  async function explore(url: string) {
    let w = await load(url);
    const base = refIn(w);
    if (explored.has(base.screen)) return;
    explored.add(base.screen);
    status.screens = explored.size;
    status.current = w.location.href;
    await record(w, base);
    const perScreen = { states: 1 };
    const tried = new Set<string>();
    const home = () => load(url);
    const tabs = tabsOf(w.document);
    await tryAll(base, pressablesOf(w.document, options.buttons), home, tried, perScreen);
    for (const tab of tabs) {
      check();
      if (perScreen.states >= MAX_STATES) break;
      w = target.win() ?? (await home());
      if (refIn(w).state !== base.state) w = await home();
      const el = find(w.document, tab);
      if (!el) continue;
      press(el);
      const after = await afterPress(w);
      if (!after) continue;
      const now = refIn(after);
      if (now.screen !== base.screen) {
        addEdge(base, now, tab.via, 'observed');
        enqueue(after.location.href);
        continue;
      }
      if (now.state === base.state) continue;
      perScreen.states++;
      await record(after, now, base, tab.via);
      const panel = after.document.querySelector('[role="tabpanel"]:not([hidden])') ?? after.document;
      const inTab = async () => {
        const fresh = await home();
        const t = find(fresh.document, tab);
        if (t) {
          press(t);
          return (await afterPress(fresh)) ?? fresh;
        }
        return fresh;
      };
      await tryAll(now, pressablesOf(panel, options.buttons), inTab, tried, perScreen);
    }
    await flush();
  }

  async function seed() {
    try {
      const c = await api.captures();
      aliases = c.aliases ?? {};
      for (const s of c.states) known.set(keyOf(s), s);
    } catch {
      // Without them every state gets a new look.
    }
    enqueue(options.start);
    if (!session.can?.map) return;
    try {
      const map = await api.map();
      const hashRouter = settings.route === 'hash' || (settings.route === 'auto' && start.hash.startsWith('#/'));
      for (const s of map.screens) {
        if (s.exampleUrl) enqueue(s.exampleUrl);
        else if (s.key.startsWith('/') && !s.key.includes('{')) {
          enqueue(hashRouter ? `${start.origin}${start.pathname}${start.search}#${s.key}` : start.origin + s.key);
        }
      }
    } catch {
      // The known screens are found again through links.
    }
  }

  const done = (async (): Promise<CrawlStatus> => {
    try {
      await seed();
      status.phase = 'running';
      report();
      while (queue.length && explored.size < options.maxScreens && Date.now() < deadline) {
        check();
        const url = queue.shift()!;
        status.queued = queue.length;
        status.current = url;
        report();
        try {
          await explore(url);
        } catch (e) {
          if (e instanceof Stopped || (e as { refused?: boolean }).refused) throw e;
          // One screen that fails does not stop the walk.
        }
      }
      await flush();
      status.phase = 'done';
    } catch (e) {
      await flush().catch(() => undefined);
      if (e instanceof Stopped) status.phase = 'stopped';
      else {
        status.phase = 'error';
        status.blocked = (e as { refused?: boolean }).refused === true;
        status.error = status.blocked
          ? 'the app refuses to open in a frame (X-Frame-Options or CSP frame-ancestors)'
          : e instanceof Error
            ? e.message
            : String(e);
      }
    }
    status.queued = queue.length;
    report();
    return { ...status };
  })();

  return {
    stop: () => void (stopped = true),
    done,
  };
}
