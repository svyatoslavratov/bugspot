import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PinLayer } from '../src/app/PinLayer';
import type { Thread } from '../src/shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A button the anchors find, with a fixed box (jsdom has no layout). */
function button(id: string, x: number, y: number) {
  const el = document.createElement('button');
  el.id = id;
  el.textContent = id;
  el.getBoundingClientRect = () =>
    ({ x, y, left: x, top: y, width: 100, height: 20, right: x + 100, bottom: y + 20, toJSON: () => ({}) }) as DOMRect;
  document.body.append(el);
  return el;
}

const anchor = (id: string) => ({ selector: `#${id}`, text: id, tag: 'button', offset: { x: 0.2, y: 0.5 } });

const thread = {
  id: 't1',
  number: 2,
  status: 'open',
  body: 'Put the label next to the checkbox',
  anchor: anchor('save'),
} as Thread;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

const render = (threads: Thread[], extra: object = {}) =>
  act(() =>
    root.render(createElement(PinLayer, { threads, selectedId: null, flashId: null, onOpen: vi.fn(), ...extra })),
  );
const pins = () =>
  [...container.querySelectorAll<HTMLButtonElement>('.bugspot-pin')].map((p) => [
    p.textContent,
    p.style.left,
    p.style.top,
  ]);

describe('PinLayer', () => {
  test('the pin itself is the tooltip target, so the tooltip opens at the pin', () => {
    button('save', 100, 230);
    const onOpen = vi.fn();
    render([thread], { onOpen });

    const pin = container.querySelector<HTMLButtonElement>('.bugspot-pin')!;
    // No wrapper between the layer and the pin: a wrapper of a fixed pin has no box and put the
    // tooltip in the top left corner of the page.
    expect(pin.parentElement?.classList.contains('bugspot-pins')).toBe(true);
    expect(pin.classList).toContain('bp6-popover-target');
    expect(pins()).toEqual([['2', '120px', '240px']]);
    expect(pin.getAttribute('aria-label')).toBe('#2');

    act(() => pin.click());
    expect(onOpen).toHaveBeenCalledWith('t1');
  });

  test('no pin without its element (a closed modal); it comes back with the element', async () => {
    const lost = { ...thread, anchor: { ...anchor('confirm'), page: { x: 600, y: 400 } } } as Thread;
    render([lost]);
    expect(pins()).toEqual([]);

    // The modal opens again: the DOM change redraws the pins on the next frame.
    await act(async () => {
      button('confirm', 300, 100);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(pins()).toEqual([['2', '320px', '110px']]);
  });
});

describe('PinLayer with several elements', () => {
  test('a pin with the same number on every found element; picking makes the pins passive', () => {
    button('a', 0, 10);
    button('b', 20, 30);
    button('c', 40, 50);
    const several = {
      ...thread,
      anchor: { ...anchor('a'), more: [anchor('b'), anchor('c'), anchor('gone')] },
    } as Thread;
    render([several], { passive: true });
    expect(pins()).toEqual([
      ['2', '20px', '20px'],
      ['2', '40px', '40px'],
      ['2', '60px', '60px'],
    ]);
    expect(container.querySelector('.bugspot-pins')!.classList).toContain('is-passive');
  });
});
