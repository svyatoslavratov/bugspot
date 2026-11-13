// The loader is the only thing every visitor downloads (~2 KB gzip). It asks the service whether
// this user may see the widget and loads the React app only then.
//
//   <script defer src="/bugspot/widget.js"></script>
//
// Attributes: data-api (service root; default: where widget.js came from), data-route
// (auto | path | hash), data-version, data-theme (light | dark | auto), data-lang (ru | en),
// data-route-params (query parameters that make different screens on the map, e.g. "tab"),
// data-position (bottom-right | bottom-left | top-right | top-left), data-mode (full | tiny: where a
// new comment is written by default), data-hotkey (the picking shortcut, "Alt+KeyC" by default;
// "off" — none). People can change the mode and the shortcut in the bug's menu.
// window.bugspotConfig = { token?: () => jwt, fetch?, appVersion? } is read when present.
// window.__bugspotCrawl = { token, auto, … } is what `bugspot map crawl` sets: it crawls at once.

import { DEFAULT_HOTKEY } from './lib/hotkey';
import { createApi, type Api } from './shared/api';
import { installCapture, type Capture } from './shared/capture';
import type { CrawlConfig, Session, Settings } from './shared/types';

declare const __APP_ENTRY__: string;

export interface BugspotConfig {
  token?: () => string | null | undefined | Promise<string | null | undefined>;
  fetch?: typeof fetch;
  appVersion?: string;
}

export interface MountOptions {
  api: Api;
  session: Session;
  capture: Capture;
  settings: Settings;
}

export interface BugspotHandle {
  open(threadId?: string): void;
  close(): void;
  /** Reload threads now instead of waiting for the next poll. */
  refresh(): void;
  destroy(): void;
}

declare global {
  interface Window {
    bugspotConfig?: BugspotConfig;
    __bugspotCrawl?: CrawlConfig;
    /** The progress of a crawl, read by `bugspot map crawl`. */
    __bugspotCrawlStatus?: unknown;
    __bugspotCrawlStop?: () => void;
    bugspot?: BugspotHandle;
    /** The number of the latest loader run: an older run that is still loading gives up. */
    __bugspotRun?: number;
  }
}

const KEY_PARAM = 'bugspot_key';

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Removes ?bugspot_key=… from the address bar (and from the hash of a hash router). */
function takeKey(): string | null {
  const url = new URL(location.href);
  let key = url.searchParams.get(KEY_PARAM);
  if (key) url.searchParams.delete(KEY_PARAM);
  const [hashPath, hashQuery] = url.hash.split('?');
  if (!key && hashQuery) {
    const params = new URLSearchParams(hashQuery);
    key = params.get(KEY_PARAM);
    params.delete(KEY_PARAM);
    const rest = params.toString();
    url.hash = rest ? `${hashPath}?${rest}` : hashPath;
  }
  if (key) history.replaceState(history.state, '', url.href);
  return key;
}

async function start(script: HTMLScriptElement) {
  // The crawler walks the app in a frame or window of this name: the widget there would report
  // the same pages again and show itself in their looks.
  if (window.bugspot || window.name.startsWith('bugspot-crawl')) return;
  // The script may run twice (included twice, or re-added after destroy()): only the newest run
  // mounts, and never over a widget that is already there.
  const run = (window.__bugspotRun = (window.__bugspotRun ?? 0) + 1);
  const stale = () => run !== window.__bugspotRun || window.bugspot !== undefined;
  const data = script.dataset;
  const scriptBase = new URL('.', script.src).href;
  const base = new URL(data.api || scriptBase, location.href).href;
  const config = window.bugspotConfig ?? {};
  const crawl = window.__bugspotCrawl;
  // A crawl from the command line acts with its agent token.
  const token = crawl?.token ? () => crawl.token : config.token;
  const api = createApi({ base: base.endsWith('/') ? base : `${base}/`, fetch: config.fetch, token });
  // Capture starts at once, so errors that happen before the user opens the widget are kept.
  const capture = installCapture(api.base);
  try {
    const key = takeKey();
    if (key) await api.openKey(key).catch(() => undefined);
    const session = await api.session();
    if (!session.visible || stale()) {
      if (crawl?.auto && !session.visible)
        window.__bugspotCrawlStatus = {
          phase: 'error',
          error: 'the widget is hidden for this token: it needs the read scope',
        };
      capture.uninstall();
      return;
    }
    const settings: Settings = {
      route: pick(data.route, ['auto', 'path', 'hash'] as const, 'auto'),
      routeParams: (data.routeParams ?? '').split(/[\s,]+/).filter(Boolean),
      appVersion: config.appVersion ?? data.version,
      theme: pick(data.theme, ['light', 'dark', 'auto'] as const, 'light'),
      lang: pick(data.lang ?? navigator.language.slice(0, 2), ['ru', 'en'] as const, 'en'),
      position: pick(data.position, ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const, 'bottom-right'),
      mode: pick(data.mode, ['full', 'tiny'] as const, 'full'),
      // Checked by the app: the loader stays small.
      hotkey: data.hotkey === 'off' ? '' : data.hotkey || DEFAULT_HOTKEY,
    };
    const app = (await import(/* @vite-ignore */ new URL(__APP_ENTRY__, scriptBase).href)) as {
      mount(o: MountOptions): BugspotHandle;
    };
    if (stale()) {
      capture.uninstall();
      return;
    }
    window.bugspot = app.mount({ api, session, capture, settings });
  } catch (error) {
    capture.uninstall();
    if (crawl?.auto)
      window.__bugspotCrawlStatus = { phase: 'error', error: `the widget did not start: ${String(error)}` };
    console.warn('bugspot: the widget did not start', error);
  }
}

const script = document.currentScript as HTMLScriptElement | null;
if (script) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void start(script), { once: true });
  } else {
    void start(script);
  }
}

export type { Api, Capture };
