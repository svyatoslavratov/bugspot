import type { Settings } from '../shared/types';

/**
 * The page key pins are matched by. A hash router (#/campaigns?tab=2) is keyed by its hash path,
 * an ordinary app by location.pathname; queries are not part of the key.
 */
export function currentRoute(mode: Settings['route'], loc: Pick<Location, 'pathname' | 'hash'> = location): string {
  const hashPath = loc.hash.startsWith('#/') ? loc.hash.slice(1).split('?')[0] : '';
  if (mode === 'hash' || (mode === 'auto' && hashPath)) return hashPath || '/';
  return loc.pathname || '/';
}

type Listener = () => void;
const listeners = new Set<Listener>();
let patched = false;

function notify() {
  listeners.forEach((fn) => fn());
}

/** Calls fn after any navigation: pushState, replaceState, back and forward, hash changes. */
export function onRouteChange(fn: Listener): () => void {
  if (!patched) {
    patched = true;
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
        const result = original.apply(this, args);
        queueMicrotask(notify);
        return result;
      };
    }
    window.addEventListener('popstate', notify);
    window.addEventListener('hashchange', notify);
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}
