import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { WidgetContext, type Widget } from '../src/app/context';
import { QuickComposer } from '../src/app/QuickComposer';
import { SettingsMenu } from '../src/app/SettingsMenu';
import type { Target } from '../src/app/useDraft';
import { dictionaries } from '../src/lib/i18n';
import type { Prefs } from '../src/lib/prefs';

vi.mock('../src/lib/screenshot', () => ({
  captureViewport: vi.fn(async () => ({ blob: new Blob(['png']), url: 'blob:shot' })),
  captureTab: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
URL.revokeObjectURL = () => undefined;

let container: HTMLDivElement;
let root: Root;
let api: { create: ReturnType<typeof vi.fn>; putScreenshot: ReturnType<typeof vi.fn> };

beforeEach(() => {
  document.body.innerHTML = '<button id="save">Save</button>';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  api = {
    create: vi.fn(async () => ({ id: 't9', number: 9 })),
    putScreenshot: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  act(() => root.unmount());
});

function render(node: ReturnType<typeof createElement>) {
  const widget = {
    api,
    t: dictionaries.en,
    host: container,
    session: { visible: true, user: { id: 'u', name: 'Ann', provider: 'forward' } },
  } as unknown as Widget;
  act(() => root.render(createElement(WidgetContext.Provider, { value: widget }, node)));
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)));

function type(el: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(el: Element | Window, key: string, shiftKey = false) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  });
}

function target(): Target {
  const el = document.getElementById('save')!;
  return {
    picks: [{ el, point: { x: 10, y: 10 } }],
    anchor: {
      selector: '#save',
      text: 'Save',
      tag: 'button',
      offset: { x: 0.5, y: 0.5 },
      page: { x: 10, y: 10 },
      viewport: { w: 1, h: 1 },
    },
    context: {} as Target['context'],
  };
}

describe('QuickComposer', () => {
  test('Enter sends with the screenshot, Shift+Enter does not', async () => {
    const onCreated = vi.fn();
    render(
      createElement(QuickComposer, { target: target(), route: '/', onCreated, onCancel: vi.fn(), onExpand: vi.fn() }),
    );
    await flush();
    const area = container.querySelector('textarea')!;
    type(area, 'Too small');
    press(area, 'Enter', true);
    expect(api.create).not.toHaveBeenCalled();
    press(area, 'Enter');
    await flush();
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ body: 'Too small', kind: 'issue', route: '/' }));
    expect(api.putScreenshot).toHaveBeenCalledWith('t9', expect.any(Blob));
    expect(onCreated).toHaveBeenCalledWith({ id: 't9', number: 9 });
  });

  test('Esc cancels and "expand" hands the text and kind to the full form', async () => {
    const onCancel = vi.fn();
    const onExpand = vi.fn();
    render(createElement(QuickComposer, { target: target(), route: '/', onCreated: vi.fn(), onCancel, onExpand }));
    await flush();
    type(container.querySelector('textarea')!, 'Why?');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Question"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Open the full form"]')!.click());
    expect(onExpand).toHaveBeenCalledWith({ body: 'Why?', kind: 'question' });
    press(window, 'Escape');
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('SettingsMenu', () => {
  const prefs: Prefs = { button: null, pins: true, mode: 'full', hotkey: 'Alt+KeyC' };

  test('switches the mode and records a new shortcut', () => {
    const onMode = vi.fn();
    const onHotkey = vi.fn();
    const onRecording = vi.fn();
    render(createElement(SettingsMenu, { prefs, onMode, onHotkey, onRecording }));
    const item = (text: string) =>
      [...container.querySelectorAll<HTMLElement>('.bp6-menu-item')].find((el) => el.textContent?.includes(text))!;
    expect(item('Full — in the panel').closest('[aria-selected]')?.getAttribute('aria-selected')).toBe('true');
    act(() => item('Tiny — next to the element').click());
    expect(onMode).toHaveBeenCalledWith('tiny');

    act(() => item('change').click());
    expect(onRecording).toHaveBeenLastCalledWith(true);
    expect(container.textContent).toContain('Press a shortcut');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k' }));
    });
    expect(container.textContent).toContain('Hold Alt, Ctrl or ⌘ with a key');
    expect(onHotkey).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'K', ctrlKey: true, shiftKey: true }));
    });
    expect(onHotkey).toHaveBeenCalledWith('Ctrl+Shift+KeyK');
    expect(onRecording).toHaveBeenLastCalledWith(false);

    act(() => item('Turn off').click());
    expect(onHotkey).toHaveBeenLastCalledWith('');
  });

  test('Esc stops recording and keeps the shortcut', () => {
    const onHotkey = vi.fn();
    render(createElement(SettingsMenu, { prefs, onMode: vi.fn(), onHotkey, onRecording: vi.fn() }));
    const change = [...container.querySelectorAll<HTMLElement>('.bp6-menu-item')].find((el) =>
      el.textContent?.includes('change'),
    )!;
    act(() => change.click());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }));
    });
    expect(onHotkey).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Alt+C'); // jsdom is not a Mac
  });
});
