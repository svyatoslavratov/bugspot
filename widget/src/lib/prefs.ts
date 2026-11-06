import type { Point } from '../shared/types';

/** Per-browser widget settings. */
export interface Prefs {
  /** Bug button position (its top-left corner); null — the corner from settings. */
  button: Point | null;
  pins: boolean;
}

const KEY = 'bugspot:prefs';

export function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return { button: saved.button ?? null, pins: saved.pins ?? true };
  } catch {
    return { button: null, pins: true };
  }
}

export function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage may be full or blocked; the settings then live until reload.
  }
}

const PENDING = 'bugspot:open';

/** A thread to open after navigating to its page. */
export function setPendingThread(id: string) {
  try {
    sessionStorage.setItem(PENDING, id);
  } catch {
    // ignore
  }
}

export function takePendingThread(): string | null {
  try {
    const id = sessionStorage.getItem(PENDING);
    sessionStorage.removeItem(PENDING);
    return id;
  } catch {
    return null;
  }
}
