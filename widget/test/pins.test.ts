import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PinLayer } from '../src/app/PinLayer';
import type { Thread } from '../src/shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const thread = {
  id: 't1',
  number: 2,
  status: 'open',
  body: 'Put the label next to the checkbox',
  anchor: { page: { x: 120, y: 240 } },
} as Thread;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('PinLayer', () => {
  test('the pin itself is the tooltip target, so the tooltip opens at the pin', () => {
    const onOpen = vi.fn();
    act(() => root.render(createElement(PinLayer, { threads: [thread], selectedId: null, flashId: null, onOpen })));

    const pin = container.querySelector<HTMLButtonElement>('.bugspot-pin')!;
    // No wrapper between the layer and the pin: a wrapper of a fixed pin has no box and put the
    // tooltip in the top left corner of the page.
    expect(pin.parentElement?.classList.contains('bugspot-pins')).toBe(true);
    expect(pin.classList).toContain('bp6-popover-target');
    expect(pin.style.left).toBe('120px');
    expect(pin.style.top).toBe('240px');
    expect(pin.getAttribute('aria-label')).toBe('#2');

    act(() => pin.click());
    expect(onOpen).toHaveBeenCalledWith('t1');
  });
});

describe('PinLayer with several elements', () => {
  test('a pin with the same number on every element; picking makes the pins passive', () => {
    const several = {
      ...thread,
      anchor: { page: { x: 10, y: 20 }, more: [{ page: { x: 30, y: 40 } }, { page: { x: 50, y: 60 } }] },
    } as Thread;
    act(() =>
      root.render(
        createElement(PinLayer, {
          threads: [several],
          selectedId: null,
          flashId: null,
          passive: true,
          onOpen: vi.fn(),
        }),
      ),
    );
    const pins = [...container.querySelectorAll<HTMLButtonElement>('.bugspot-pin')];
    expect(pins.map((p) => [p.textContent, p.style.left, p.style.top])).toEqual([
      ['2', '10px', '20px'],
      ['2', '30px', '40px'],
      ['2', '50px', '60px'],
    ]);
    expect(container.querySelector('.bugspot-pins')!.classList).toContain('is-passive');
  });
});
