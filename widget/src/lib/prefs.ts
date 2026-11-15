import type { LangChoice } from './i18n';
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
  /** The language of the widget and the map; "auto" — the browser's. */
  lang: LangChoice;
}

const KEY = 'pinpath:prefs';
/** Settings saved before the project was renamed; read until new ones are saved. */
const LEGACY_KEY = 'bugspot:prefs';

/** The site's defaults (script attributes) apply until the person changes a setting. */
export function loadPrefs(defaults: { mode: ComposeMode; hotkey: string }): Prefs {
  const base: Prefs = { button: null, pins: true, lang: 'auto', ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY) ?? '{}') as Partial<Prefs>;
    return {
      button: saved.button ?? null,
      pins: saved.pins ?? true,
      mode: saved.mode === 'tiny' || saved.mode === 'full' ? saved.mode : base.mode,
      hotkey: typeof saved.hotkey === 'string' ? saved.hotkey : base.hotkey,
      lang: saved.lang === 'ru' || saved.lang === 'en' ? saved.lang : 'auto',
    };
  } catch {
    return base;
  }
}

/**
 * Changes some settings in place: the map page shares the language and the picking shortcut with
 * the widget when both live on one origin.
 */
export function updatePrefs(patch: Partial<Prefs>, defaults: { mode: ComposeMode; hotkey: string }): Prefs {
  const next = { ...loadPrefs(defaults), ...patch };
  savePrefs(next);
  return next;
}

export function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage may be full or blocked; the settings then live until reload.
  }
}

const PENDING = 'pinpath:open';

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
