import { describe, expect, test } from 'vitest';

import { DEFAULT_HOTKEY, formatHotkey, hotkeyFromEvent, matchesHotkey, parseHotkey } from '../src/lib/hotkey';

const key = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) =>
  new KeyboardEvent('keydown', { code, ...mods });

describe('hotkeys', () => {
  test('the default is Alt+C by the physical key, so the Russian layout works too', () => {
    const hotkey = parseHotkey(DEFAULT_HOTKEY)!;
    expect(matchesHotkey(key('KeyC', { altKey: true }), hotkey)).toBe(true);
    expect(matchesHotkey(key('KeyC'), hotkey)).toBe(false);
    expect(matchesHotkey(key('KeyC', { altKey: true, shiftKey: true }), hotkey)).toBe(false);
    expect(matchesHotkey(key('KeyV', { altKey: true }), hotkey)).toBe(false);
  });

  test('a shortcut needs Ctrl, Alt or Meta, or a function key', () => {
    expect(parseHotkey('KeyC')).toBeNull();
    expect(parseHotkey('Shift+KeyC')).toBeNull();
    expect(parseHotkey('F2')).not.toBeNull();
    expect(parseHotkey('Ctrl+Shift+KeyK')).not.toBeNull();
    expect(parseHotkey('Hyper+KeyC')).toBeNull();
    expect(parseHotkey('Alt+AltLeft')).toBeNull();
    expect(parseHotkey('off')).toBeNull();
    expect(parseHotkey('')).toBeNull();
  });

  test('an event spells its shortcut in a fixed order; lone modifiers and plain keys spell none', () => {
    expect(hotkeyFromEvent(key('KeyK', { metaKey: true, shiftKey: true, ctrlKey: true }))).toBe('Ctrl+Shift+Meta+KeyK');
    expect(hotkeyFromEvent(key('AltLeft', { altKey: true }))).toBeNull();
    expect(hotkeyFromEvent(key('KeyK'))).toBeNull();
    expect(hotkeyFromEvent(key('F4'))).toBe('F4');
  });

  test('labels follow the platform', () => {
    expect(formatHotkey('Alt+KeyC', true)).toBe('⌥C');
    expect(formatHotkey('Alt+KeyC', false)).toBe('Alt+C');
    expect(formatHotkey('Ctrl+Shift+Meta+Digit1', true)).toBe('⌃⇧⌘1');
    expect(formatHotkey('Ctrl+Shift+Meta+Digit1', false)).toBe('Ctrl+Shift+Win+1');
    expect(formatHotkey('', false)).toBe('');
  });
});
