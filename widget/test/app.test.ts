import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { App, type AppHandle } from '../src/app/App';
import { WidgetContext, type Widget } from '../src/app/context';
import { dictionaries } from '../src/lib/i18n';

vi.mock('../src/lib/screenshot', () => ({
  captureViewport: vi.fn(async () => ({ blob: new Blob(['png']), url: 'blob:shot' })),
  captureTab: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
URL.revokeObjectURL = () => undefined;
// jsdom has no matchMedia; the page context asks it for the color scheme.
window.matchMedia = ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;

let container: HTMLDivElement;
let root: Root;
let target: HTMLButtonElement;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<button id="save">Save</button>';
  target = document.querySelector('#save')!;
  // jsdom has no layout: the element under the pointer is the button.
  document.elementsFromPoint = () => [target];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

const page = { data: [], meta: { page: 1, limit: 100, total: 0, totalPages: 0 } };

function render(ref: React.Ref<AppHandle>, mode: 'full' | 'tiny' = 'full') {
  const widget = {
    api: {
      threads: vi.fn(async () => page),
      summary: vi.fn(async () => ({ route: {}, total: {} })),
      create: vi.fn(),
      putScreenshot: vi.fn(),
    },
    t: dictionaries.en,
    host: container,
    capture: { console: [], network: [], uninstall: () => undefined },
    session: { visible: true, can: { view: true, comment: true }, user: { id: 'u', name: 'Ann', provider: 'forward' } },
    settings: { route: 'path', theme: 'light', lang: 'en', position: 'bottom-right', mode, hotkey: 'Alt+KeyC' },
  } as unknown as Widget;
  act(() => root.render(createElement(WidgetContext.Provider, { value: widget }, createElement(App, { ref }))));
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)));

function key(init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

const picking = () => container.querySelector('.bugspot-pick-bar') !== null;

describe('App', () => {
  test('closing the panel cancels the form, so the shortcut picks again and the form is gone', async () => {
    const ref = createRef<AppHandle>();
    render(ref);
    await flush();

    key({ code: 'KeyC', key: 'c', altKey: true });
    expect(picking()).toBe(true);
    act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    await flush();
    expect(container.querySelector('.bugspot-new')).not.toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('.bugspot-panel-header [aria-label="Close"]')!.click());
    expect(container.querySelector('.bugspot-panel')).toBeNull();

    key({ code: 'KeyC', key: 'c', altKey: true });
    expect(picking()).toBe(true);
    key({ key: 'Escape' });
    expect(picking()).toBe(false);

    act(() => ref.current!.open());
    await flush();
    expect(container.querySelector('.bugspot-panel')).not.toBeNull();
    expect(container.querySelector('.bugspot-new')).toBeNull();
  });

  test('tiny box expanded to the full form, then the panel closed: the shortcut picks again', async () => {
    render(createRef<AppHandle>(), 'tiny');
    await flush();
    key({ code: 'KeyC', key: 'c', altKey: true });
    act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    await flush();
    act(() => container.querySelector<HTMLButtonElement>('.bugspot-quick [aria-label="Open the full form"]')!.click());
    await flush();
    expect(container.querySelector('.bugspot-new')).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('.bugspot-panel-header [aria-label="Close"]')!.click());
    key({ code: 'KeyC', key: 'c', altKey: true });
    expect(picking()).toBe(true);
  });
});
