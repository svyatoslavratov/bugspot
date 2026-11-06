import { beforeEach, describe, expect, test } from 'vitest';

import { anchorsOf, buildAnchor, combineAnchors, pinPoint, resolveAnchor, selectorOf, textOf } from '../src/lib/anchor';

function rect(el: Element, x: number, y: number, w: number, h: number) {
  el.getBoundingClientRect = () => ({
    x,
    y,
    left: x,
    top: y,
    width: w,
    height: h,
    right: x + w,
    bottom: y + h,
    toJSON: () => ({}),
  });
}

beforeEach(() => {
  document.body.innerHTML = `
    <main>
      <input aria-label="Search campaigns" placeholder="Search" />
      <button id=":r12:">Export</button>
      <table><tbody>
        <tr><td>Northwind</td><td data-bugspot="budget-1">480 000 ₽</td></tr>
        <tr><td>Contoso</td><td>1 250   000 ₽</td></tr>
      </tbody></table>
      <section data-testid="cards"><article><h3>Maria</h3></article><article><h3>Pavel</h3></article></section>
    </main>`;
  for (const el of document.querySelectorAll('*')) rect(el, 10, 10, 100, 20);
});

describe('selectorOf', () => {
  test('quotes attribute values safely', () => {
    const input = document.querySelector('input')!;
    input.setAttribute('aria-label', 'Say "hi" \\ there');
    expect(document.querySelector(selectorOf(input))).toBe(input);
  });

  test('prefers stable attributes and skips generated ids', () => {
    expect(selectorOf(document.querySelector('[data-bugspot]')!)).toBe('[data-bugspot="budget-1"]');
    expect(selectorOf(document.querySelector('input')!)).toBe('input[aria-label="Search campaigns"]');
    const button = document.querySelector('button')!;
    expect(selectorOf(button)).not.toContain(':r12:');
    expect(document.querySelector(selectorOf(button))).toBe(button);
  });

  test('builds a path from the nearest stable ancestor', () => {
    const pavel = document.querySelectorAll('h3')[1];
    const selector = selectorOf(pavel);
    expect(selector).toBe('section[data-testid="cards"] > article:nth-of-type(2) > h3');
    expect(document.querySelector(selector)).toBe(pavel);
  });
});

describe('anchors', () => {
  test('collapse whitespace in text', () => {
    expect(textOf(document.querySelectorAll('td')[3])).toBe('1 250 000 ₽');
    expect(textOf(document.querySelector('input')!)).toBe('Search');
  });

  test('round trip: build, then resolve the same element and the pin point', () => {
    const cell = document.querySelectorAll('td')[3];
    rect(cell, 200, 100, 80, 20);
    const anchor = buildAnchor(cell, { x: 260, y: 105 });
    expect(anchor.tag).toBe('td');
    expect(anchor.offset).toEqual({ x: 0.75, y: 0.25 });
    expect(resolveAnchor(anchor)).toBe(cell);
    expect(pinPoint(anchor, cell)).toEqual({ x: 260, y: 105 });
  });

  test('finds the element by text when the layout changed', () => {
    const cell = document.querySelectorAll('td')[3];
    const anchor = buildAnchor(cell, { x: 20, y: 15 });
    // A new row above shifts every nth-of-type path.
    document.querySelector('tbody')!.insertAdjacentHTML('afterbegin', '<tr><td>Fabrikam</td><td>300 000 ₽</td></tr>');
    for (const el of document.querySelectorAll('td')) rect(el, 10, 10, 100, 20);
    expect(resolveAnchor(anchor)?.textContent?.replace(/\s+/g, ' ')).toBe('1 250 000 ₽');
  });

  test('detached anchors fall back to the page point', () => {
    const anchor = { selector: '#gone', text: 'Nowhere', tag: 'div', page: { x: 300, y: 400 } };
    expect(resolveAnchor(anchor)).toBeNull();
    expect(pinPoint(anchor, null)).toEqual({ x: 300 - scrollX, y: 400 - scrollY });
  });

  test('a broken selector from an old page does not throw', () => {
    expect(resolveAnchor({ selector: 'td:nth-of-type(', text: '', tag: 'td' })).toBeNull();
  });
});

describe('several elements', () => {
  test('combineAnchors keeps the first element on top and anchorsOf lists them all', () => {
    const [a, b] = [document.querySelector('input')!, document.querySelector('[data-bugspot]')!];
    const one = buildAnchor(a, { x: 20, y: 15 });
    const two = buildAnchor(b, { x: 30, y: 15 });
    expect(combineAnchors([one])).toEqual(one);
    const both = combineAnchors([one, two]);
    expect(both.selector).toBe(one.selector);
    expect(both.more).toEqual([two]);
    expect(anchorsOf(both).map((x) => x.selector)).toEqual([one.selector, two.selector]);
    expect(anchorsOf({ selector: '#x', more: 'junk' as never })).toEqual([{ selector: '#x' }]);
    expect(resolveAnchor(anchorsOf(both)[1])).toBe(b);
  });
});
