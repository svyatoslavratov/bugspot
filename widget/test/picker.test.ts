import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { WidgetContext, type Widget } from '../src/app/context';
import { Picker, type Pick } from '../src/app/Picker';
import { MAX_ELEMENTS } from '../src/lib/anchor';
import { dictionaries } from '../src/lib/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let under: Element | null = null;
let page: HTMLButtonElement[];

beforeEach(() => {
  document.body.innerHTML = '';
  page = [1, 2, 3].map((n) => {
    const b = document.createElement('button');
    b.textContent = `Button ${n}`;
    document.body.append(b);
    return b;
  });
  // jsdom has no layout: the element "under the pointer" is whatever the test says.
  document.elementsFromPoint = () => (under ? [under] : []);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

function render(onPick: (p: Pick[]) => void, onCancel = vi.fn(), notice?: string) {
  const widget = { t: dictionaries.en, host: container } as unknown as Widget;
  act(() =>
    root.render(
      createElement(WidgetContext.Provider, { value: widget }, createElement(Picker, { notice, onPick, onCancel })),
    ),
  );
  return onCancel;
}

function click(el: Element, shift = false) {
  under = el;
  act(() => {
    el.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: shift, clientX: 5, clientY: 5 }),
    );
  });
}

function key(name: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: name, cancelable: true }));
  });
}

const bar = () => container.querySelector('.bugspot-pick-bar')!.textContent;

describe('Picker', () => {
  test('a plain click picks one element and the page never sees the click', () => {
    const onPick = vi.fn();
    const pageClick = vi.fn();
    page[0].addEventListener('click', pageClick);
    render(onPick);
    click(page[0]);
    expect(onPick).toHaveBeenCalledWith([{ el: page[0], point: { x: 5, y: 5 } }]);
    expect(pageClick).not.toHaveBeenCalled();
  });

  test('Shift+click collects elements, a click on the last one finishes', () => {
    const onPick = vi.fn();
    render(onPick);
    click(page[0], true);
    click(page[1], true);
    expect(onPick).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.bugspot-picked')).toHaveLength(2);
    expect(bar()).toContain('2 picked');
    click(page[2]);
    expect(onPick.mock.calls[0][0].map((p: Pick) => p.el)).toEqual(page);
  });

  test('Shift+click on a picked element drops it; a click on a picked one does not add it twice', () => {
    const onPick = vi.fn();
    render(onPick);
    click(page[0], true);
    click(page[1], true);
    click(page[0], true);
    expect(container.querySelectorAll('.bugspot-picked')).toHaveLength(1);
    click(page[1]);
    expect(onPick.mock.calls[0][0].map((p: Pick) => p.el)).toEqual([page[1]]);
  });

  test('Enter finishes with the picked elements, only when there are some; Esc cancels', () => {
    const onPick = vi.fn();
    const onCancel = render(onPick);
    key('Enter');
    expect(onPick).not.toHaveBeenCalled();
    click(page[2], true);
    key('Enter');
    expect(onPick.mock.calls[0][0].map((p: Pick) => p.el)).toEqual([page[2]]);
    key('Escape');
    expect(onCancel).toHaveBeenCalled();
  });

  test(`no more than ${MAX_ELEMENTS} elements`, () => {
    const many = Array.from({ length: MAX_ELEMENTS + 2 }, () => document.body.appendChild(document.createElement('i')));
    const onPick = vi.fn();
    render(onPick);
    for (const el of many) click(el, true);
    expect(container.querySelectorAll('.bugspot-picked')).toHaveLength(MAX_ELEMENTS);
    expect(bar()).toContain('no more fit');
    click(page[0]);
    expect(onPick.mock.calls[0][0]).toHaveLength(MAX_ELEMENTS);
  });

  test('after a comment the bar says it was sent and offers to finish', () => {
    render(vi.fn(), vi.fn(), 'Comment #3 sent');
    expect(bar()).toContain('Comment #3 sent');
    expect(bar()).toContain('Finish (Esc)');
  });
});
