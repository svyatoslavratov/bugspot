import type { ConsoleEntry, NetworkEntry } from './types';

/** Recent console errors and failed requests of the page, attached to new threads. */
export interface Capture {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  uninstall(): void;
}

const LIMIT = 30;
const MESSAGE = 500;

function push<T>(list: T[], item: T) {
  list.push(item);
  if (list.length > LIMIT) list.shift();
}

function text(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Keeps the origin, the path and the query parameter names; values may hold personal data. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw, location.href);
    const names = [...new Set(url.searchParams.keys())];
    const query = names.length ? `?${names.map((n) => `${n}=…`).join('&')}` : '';
    const origin = url.origin === location.origin ? '' : url.origin;
    return `${origin}${url.pathname}${query}`;
  } catch {
    return raw.slice(0, 200);
  }
}

/**
 * Wraps console.error/warn, fetch and XMLHttpRequest and listens to uncaught errors. Requests to
 * the bugspot service itself (ignorePrefix) are not recorded. uninstall() restores everything.
 */
export function installCapture(ignorePrefix: string): Capture {
  const capture: Capture = { console: [], network: [], uninstall: () => undefined };
  const restore: (() => void)[] = [];
  const now = () => new Date().toISOString();
  const own = (url: string) => {
    try {
      return new URL(url, location.href).href.startsWith(ignorePrefix);
    } catch {
      return false;
    }
  };

  for (const level of ['error', 'warn'] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      push(capture.console, { level, message: args.map(text).join(' ').slice(0, MESSAGE), at: now() });
      original.apply(console, args);
    };
    restore.push(() => (console[level] = original));
  }

  const onError = (e: ErrorEvent) =>
    push(capture.console, {
      level: 'error',
      message: `${e.message} (${e.filename}:${e.lineno})`.slice(0, MESSAGE),
      at: now(),
    });
  const onRejection = (e: PromiseRejectionEvent) =>
    push(capture.console, {
      level: 'error',
      message: `Unhandled rejection: ${text(e.reason)}`.slice(0, MESSAGE),
      at: now(),
    });
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  restore.push(() => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  });

  const originalFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const started = performance.now();
    try {
      const res = await originalFetch.call(window, input, init);
      if (!res.ok && !own(url)) {
        push(capture.network, {
          method,
          url: redactUrl(url),
          status: res.status,
          requestId: res.headers.get('X-Request-ID') ?? undefined,
          durationMs: Math.round(performance.now() - started),
          at: now(),
        });
      }
      return res;
    } catch (error) {
      if (!own(url)) {
        push(capture.network, {
          method,
          url: redactUrl(url),
          status: 0,
          durationMs: Math.round(performance.now() - started),
          error: text(error).slice(0, MESSAGE),
          at: now(),
        });
      }
      throw error;
    }
  };
  restore.push(() => (window.fetch = originalFetch));

  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const sendXhr = proto.send;
  type Tracked = XMLHttpRequest & { __bugspot?: { method: string; url: string; started: number } };
  proto.open = function (this: Tracked, method: string, url: string | URL, ...rest: unknown[]) {
    this.__bugspot = { method: method.toUpperCase(), url: String(url), started: 0 };
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;
  proto.send = function (this: Tracked, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = this.__bugspot;
    if (info && !own(info.url)) {
      info.started = performance.now();
      this.addEventListener('loadend', () => {
        if (this.status === 0 || this.status >= 400) {
          push(capture.network, {
            method: info.method,
            url: redactUrl(info.url),
            status: this.status,
            requestId: this.getResponseHeader('X-Request-ID') ?? undefined,
            durationMs: Math.round(performance.now() - info.started),
            at: now(),
          });
        }
      });
    }
    return sendXhr.call(this, body);
  };
  restore.push(() => {
    proto.open = open;
    proto.send = sendXhr;
  });

  capture.uninstall = () => restore.splice(0).forEach((fn) => fn());
  return capture;
}
