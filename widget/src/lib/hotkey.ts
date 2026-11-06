/**
 * Keyboard shortcuts as strings like "Alt+KeyC": modifiers in a fixed order and the physical key
 * (KeyboardEvent.code), so a shortcut works in any keyboard layout (KeyC is also the Russian С).
 */

/** Alt+C (⌥C on a Mac): C for comment, as in Figma; not taken by the browsers. */
export const DEFAULT_HOTKEY = 'Alt+KeyC';

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
type Modifier = (typeof MODIFIERS)[number];

export interface Hotkey {
  mods: Set<Modifier>;
  code: string;
}

const modifierCodes = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;
const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/;

/** Parses a stored shortcut; empty or "off" means none. */
export function parseHotkey(value: string | null | undefined): Hotkey | null {
  if (!value || value === 'off') return null;
  const parts = value.split('+');
  const code = parts.pop()!;
  if (!code || modifierCodes.test(code)) return null;
  const mods = new Set<Modifier>();
  for (const p of parts) {
    if (!(MODIFIERS as readonly string[]).includes(p)) return null;
    mods.add(p as Modifier);
  }
  // A plain key would fire while typing: a shortcut needs Ctrl, Alt or Meta, or is a function key.
  if (!mods.has('Ctrl') && !mods.has('Alt') && !mods.has('Meta') && !functionKey.test(code)) return null;
  return { mods, code };
}

/** The shortcut an event spells, or null for a lone modifier or a plain key. */
export function hotkeyFromEvent(e: KeyboardEvent): string | null {
  if (!e.code || modifierCodes.test(e.code)) return null;
  const mods: Modifier[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  const value = [...mods, e.code].join('+');
  return parseHotkey(value) ? value : null;
}

export function matchesHotkey(e: KeyboardEvent, hotkey: Hotkey): boolean {
  return (
    e.code === hotkey.code &&
    e.ctrlKey === hotkey.mods.has('Ctrl') &&
    e.altKey === hotkey.mods.has('Alt') &&
    e.shiftKey === hotkey.mods.has('Shift') &&
    e.metaKey === hotkey.mods.has('Meta')
  );
}

export function isMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform || navigator.platform || navigator.userAgent);
}

function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.replace(/^Arrow/, '').replace(/^Numpad/, 'Num ');
}

/** "⌥C" on a Mac, "Alt+C" elsewhere; empty for no shortcut. */
export function formatHotkey(value: string | null | undefined, mac = isMac()): string {
  const hotkey = parseHotkey(value);
  if (!hotkey) return '';
  const key = keyLabel(hotkey.code);
  if (mac) {
    const symbols: Record<Modifier, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
    return (
      MODIFIERS.filter((m) => hotkey.mods.has(m))
        .map((m) => symbols[m])
        .join('') + key
    );
  }
  const names: Record<Modifier, string> = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };
  return [...MODIFIERS.filter((m) => hotkey.mods.has(m)).map((m) => names[m]), key].join('+');
}
