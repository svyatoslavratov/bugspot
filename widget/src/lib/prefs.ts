import type { ComposeMode, Point } from '../shared/types';

/** Per-browser widget settings. */
export interface Prefs {
  /** Bug button position (its top-left corner); null — the corner from settings. */
  button: Point | null;
  pins: boolean;
  /** Where a new comment is written: the full form in the panel or a tiny box at the element. */
  mode: ComposeMode;
  /** The shortcut that starts picking ("Alt+KeyC"); empty — none. */
  hotkey: string;
}

const KEY = 'bugspot:prefs';

/** The site's defaults (script attributes) apply until the person changes a setting. */
export function loadPrefs(defaults: { mode: ComposeMode; hotkey: string }): Prefs {
  const base: Prefs = { button: null, pins: true, ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      button: saved.button ?? null,
      pins: saved.pins ?? true,
      mode: saved.mode === 'tiny' || saved.mode === 'full' ? saved.mode : base.mode,
      hotkey: typeof saved.hotkey === 'string' ? saved.hotkey : base.hotkey,
    };
  } catch {
    return base;
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
