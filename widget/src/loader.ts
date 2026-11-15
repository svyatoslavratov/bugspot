// The loader is the only thing every visitor downloads (~2 KB gzip). It asks the service whether
// this user may see the widget and loads the React app only then.
//
//   <script defer src="/pinpath/widget.js"></script>
//
// Attributes: data-api (service root; default: where widget.js came from), data-route
// (auto | path | hash), data-version, data-theme (light | dark | auto), data-lang (ru | en: the
// language when the person chose none in the settings and the browser speaks neither),
// data-route-params (query parameters that make different screens on the map, e.g. "tab"),
// data-position (bottom-right | bottom-left | top-right | top-left), data-mode (full | tiny: where a
// new comment is written by default), data-hotkey (the picking shortcut, "Alt+KeyC" by default;
// "off" — none). People can change the mode and the shortcut in the bug's menu.
// window.pinpathConfig = { token?: () => jwt, fetch?, appVersion? } is read when present (or
// window.bugspotConfig, its name before the project was renamed).
// window.__pinpathCrawl = { token, auto, … } is what `pinpath map crawl` sets: it crawls at once.

import { DEFAULT_HOTKEY } from './lib/hotkey';
import { createApi, type Api } from './shared/api';
import { installCapture, type Capture } from './shared/capture';
import type { CrawlConfig, Session, Settings } from './shared/types';

declare const __APP_ENTRY__: string;

export interface PinpathConfig {
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

export interface PinpathHandle {
  open(threadId?: string): void;
  close(): void;
  /** Reload threads now instead of waiting for the next poll. */
  refresh(): void;
  destroy(): void;
}

declare global {
  interface Window {
    pinpathConfig?: PinpathConfig;
    /** The config under the project's old name; read when pinpathConfig is absent. */
    bugspotConfig?: PinpathConfig;
    __pinpathCrawl?: CrawlConfig;
    /** The progress of a crawl, read by `pinpath map crawl`. */
    __pinpathCrawlStatus?: unknown;
    __pinpathCrawlStop?: () => void;
    pinpath?: PinpathHandle;
    /** The same handle under the project's old name. */
    bugspot?: PinpathHandle;
    /** The number of the latest loader run: an older run that is still loading gives up. */
    __pinpathRun?: number;
  }
}

// Links made before the rename carry ?bugspot_key=; they open the same way.
const KEY_PARAMS = ['pinpath_key', 'bugspot_key'];

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Removes ?pinpath_key=… from the address bar (and from the hash of a hash router). */
function takeKey(): string | null {
  const url = new URL(location.href);
  let key: string | null = null;
  for (const name of KEY_PARAMS) {
    key ??= url.searchParams.get(name);
    url.searchParams.delete(name);
  }
  const [hashPath, hashQuery] = url.hash.split('?');
  if (!key && hashQuery) {
    const params = new URLSearchParams(hashQuery);
    for (const name of KEY_PARAMS) {
      key ??= params.get(name);
      params.delete(name);
    }
    const rest = params.toString();
    url.hash = rest ? `${hashPath}?${rest}` : hashPath;
  }
  if (key) history.replaceState(history.state, '', url.href);
  return key;
}

async function start(script: HTMLScriptElement) {
  // The crawler walks the app in a frame or window of this name: the widget there would report
  // the same pages again and show itself in their looks.
  if (window.pinpath || window.name.startsWith('pinpath-crawl')) return;
  // The script may run twice (included twice, or re-added after destroy()): only the newest run
  // mounts, and never over a widget that is already there.
  const run = (window.__pinpathRun = (window.__pinpathRun ?? 0) + 1);
  const stale = () => run !== window.__pinpathRun || window.pinpath !== undefined;
  const data = script.dataset;
  const scriptBase = new URL('.', script.src).href;
  const base = new URL(data.api || scriptBase, location.href).href;
  const config = window.pinpathConfig ?? window.bugspotConfig ?? {};
  const crawl = window.__pinpathCrawl;
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
        window.__pinpathCrawlStatus = {
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
      // The site's language: used when the person chose none and the browser speaks neither.
      lang: pick(data.lang, ['ru', 'en'] as const, 'en'),
      position: pick(data.position, ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const, 'bottom-right'),
      mode: pick(data.mode, ['full', 'tiny'] as const, 'full'),
      // Checked by the app: the loader stays small.
      hotkey: data.hotkey === 'off' ? '' : data.hotkey || DEFAULT_HOTKEY,
    };
    const app = (await import(/* @vite-ignore */ new URL(__APP_ENTRY__, scriptBase).href)) as {
      mount(o: MountOptions): PinpathHandle;
    };
    if (stale()) {
      capture.uninstall();
      return;
    }
    window.pinpath = window.bugspot = app.mount({ api, session, capture, settings });
  } catch (error) {
    capture.uninstall();
    if (crawl?.auto)
      window.__pinpathCrawlStatus = { phase: 'error', error: `the widget did not start: ${String(error)}` };
    console.warn('pinpath: the widget did not start', error);
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
