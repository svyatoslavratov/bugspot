// Screens, states and transitions of the app, as the screen map sees them. Everything here works
// from the URL, the DOM and ARIA, so it does not care which framework built the page.

import type { Settings } from '../shared/types';
import { currentRoute } from './route';
import { selectorOf, textOf } from './anchor';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{12,}$/i;
const NUM = /^\d+$/;
const TOKEN = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Whether a path segment is an id rather than a name: a number, a UUID, a long hex string or a
 * long token with digits (ULIDs, hashes). The service folds old routes by the same rule.
 */
export function idLike(segment: string): boolean {
  return NUM.test(segment) || UUID.test(segment) || HEX.test(segment) || (TOKEN.test(segment) && /\d/.test(segment));
}

/** The route with its id-like segments folded: /author/0193…/edit → /author/{id}/edit. */
export function foldRoute(route: string): string {
  return route
    .split('/')
    .map((s) => (idLike(s) ? '{id}' : s))
    .join('/');
}

/** Query parameters of the location: of the hash of a hash router, else of the search. */
function queryOf(mode: Settings['route'], loc: Pick<Location, 'search' | 'hash'>): URLSearchParams {
  const hashQuery = loc.hash.startsWith('#/') ? (loc.hash.split('?')[1] ?? '') : '';
  if (mode === 'hash' || (mode === 'auto' && loc.hash.startsWith('#/'))) return new URLSearchParams(hashQuery);
  return new URLSearchParams(loc.search);
}

export interface ScreenOptions {
  route: Settings['route'];
  /** Query parameters that make different screens (data-route-params), e.g. ["tab"]. */
  params?: string[];
}

/** The key of a location: the route with ids folded, plus the query parameters that make screens. */
export function routeKey(
  options: ScreenOptions,
  loc: Pick<Location, 'pathname' | 'hash' | 'search'> = location,
): string {
  let key = foldRoute(currentRoute(options.route, loc));
  if (options.params?.length) {
    const query = queryOf(options.route, loc);
    const parts = [...options.params]
      .sort()
      .filter((p) => query.has(p))
      .map((p) => `${p}=${query.get(p) ?? ''}`);
    if (parts.length) key += `?${parts.join('&')}`;
  }
  return key.slice(0, 512);
}

/**
 * The key of the screen on the map: the app's own name for it (data-bugspot-screen on any element
 * of the page), else the key of the location.
 */
export function screenKeyOf(
  options: ScreenOptions,
  loc: Pick<Location, 'pathname' | 'hash' | 'search'> = location,
  doc: Document = document,
): string {
  const own = doc.querySelector('[data-bugspot-screen]')?.getAttribute('data-bugspot-screen')?.trim();
  return own ? own.slice(0, 512) : routeKey(options, loc);
}

/** Text for a name: whitespace collapsed, counters at the end dropped («Отклики 3» → «Отклики»). */
export function cleanName(text: string, limit = 120): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s·•:]*\(?\d+\)?$/, '')
    .trim()
    .slice(0, limit);
}

/** The name people see on an element: aria-label, aria-labelledby, title or alt, else its text. */
export function accessibleName(el: Element): string {
  const doc = el.ownerDocument;
  const label = el.getAttribute('aria-label');
  if (label?.trim()) return cleanName(label);
  const labelledBy = el
    .getAttribute('aria-labelledby')
    ?.split(/\s+/)
    .map((id) => doc.getElementById(id)?.textContent ?? '')
    .join(' ');
  if (labelledBy?.trim()) return cleanName(labelledBy);
  const text = textOf(el);
  if (text) return cleanName(text);
  const titled = el.getAttribute('title') ?? el.querySelector('[title]')?.getAttribute('title');
  if (titled?.trim()) return cleanName(titled);
  const img = el.localName === 'img' ? el : el.querySelector('img[alt]');
  return cleanName(img?.getAttribute('alt') ?? '');
}

const DIALOGS = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const TABS = '[role="tab"][aria-selected="true"]';
const NAV = 'nav, aside, header, [role="navigation"], [data-bugspot-nav]';

function shown(el: Element): boolean {
  if (el.closest('[data-bugspot-ignore], [hidden], [aria-hidden="true"]')) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/** A state of the screen: the page itself, a selected tab or an open dialog. */
export interface ScreenState {
  key: string;
  kind: 'page' | 'tab' | 'dialog';
  name: string;
}

function dialogName(dialog: Element, doc: Document): string {
  const labelled = dialog
    .getAttribute('aria-labelledby')
    ?.split(/\s+/)
    .map((id) => doc.getElementById(id)?.textContent ?? '')
    .join(' ');
  const heading = dialog.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
  return cleanName(dialog.getAttribute('aria-label') || labelled || heading?.textContent || '');
}

/**
 * The state the page is in: the topmost open dialog, else the selected tabs (several tab lists
 * are joined), else the page itself. Keys: "dialog:<title>", "tab:<names>", "".
 *
 * A dialog is a window: modal, or with a title. A date picker or a sort menu that calls itself a
 * dialog without either is a popup of the page, not a state of the screen.
 */
export function currentState(doc: Document = document): ScreenState {
  const dialogs = [...doc.querySelectorAll(DIALOGS)].filter(
    (d) =>
      shown(d) && (d.matches('dialog[open], [aria-modal="true"], [role="alertdialog"]') || dialogName(d, doc) !== ''),
  );
  const top = dialogs.at(-1);
  if (top) {
    const name = dialogName(top, doc) || 'dialog';
    return { key: `dialog:${name}`.slice(0, 300), kind: 'dialog', name };
  }
  const tabs = [...doc.querySelectorAll(TABS)]
    .filter((t) => shown(t) && !t.closest(NAV))
    .map((t) => accessibleName(t))
    .filter(Boolean);
  if (tabs.length) {
    const name = [...new Set(tabs)].join(' · ');
    return { key: `tab:${name}`.slice(0, 300), kind: 'tab', name };
  }
  return { key: '', kind: 'page', name: '' };
}

export type ViaKind = 'link' | 'button' | 'tab' | 'nav' | 'auto';

export interface Via {
  name: string;
  kind: ViaKind;
  selector: string;
}

const INTERACTIVE =
  'a[href], button, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], ' +
  'input[type="button"], input[type="submit"], [data-bugspot-to]';

/** The element a click went to: the interactive element under it, else a clickable-looking one. */
export function interactiveOf(target: Element): Element | null {
  const el = target.closest(INTERACTIVE);
  if (el) return el;
  // Rows and cards clicked through an onClick handler show a pointer cursor.
  let node: Element | null = target;
  for (let i = 0; node && i < 4; i++, node = node.parentElement) {
    if (node.ownerDocument.defaultView?.getComputedStyle(node).cursor === 'pointer') return node;
  }
  return null;
}

/** What a transition goes through: the element's name, its kind and a selector to find it again. */
export function viaOf(el: Element): Via {
  let kind: ViaKind = 'button';
  if (el.closest(NAV)) kind = 'nav';
  else if (el.getAttribute('role') === 'tab') kind = 'tab';
  else if (el.matches('a[href], [role="link"]')) kind = 'link';
  return { name: accessibleName(el), kind, selector: selectorOf(el, el.ownerDocument) };
}

/**
 * The screen a same-origin link leads to, or null for other sites, downloads, mail and the page
 * itself (#anchors).
 */
export function linkScreen(href: string, options: ScreenOptions, base: string = location.href): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  const here = new URL(base);
  if (url.origin !== here.origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  if (url.pathname === here.pathname && url.search === here.search && url.hash && !url.hash.startsWith('#/'))
    return null;
  return routeKey(options, url);
}

/**
 * A fingerprint of the page structure (tags, roles, headings): it changes when the layout does, not
 * when a number in a cell does, so a screen is captured again only after a real change.
 */
export function structureHash(doc: Document = document): string {
  let hash = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  const stack: Element[] = doc.body ? [doc.body] : [];
  let count = 0;
  while (stack.length && count < 4000) {
    const node = stack.pop()!;
    if (node.hasAttribute('data-bugspot-ignore') || node.localName === 'script' || node.localName === 'style') continue;
    count++;
    feed(node.localName);
    const role = node.getAttribute('role');
    if (role) feed(role);
    if (/^h[1-3]$/.test(node.localName)) feed(textOf(node));
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return (hash >>> 0).toString(16).padStart(8, '0') + count.toString(16);
}

/** What is on the page, for agents that describe screens: title, headings, actions, fields, tables. */
export interface Outline {
  title: string;
  headings: string[];
  actions: string[];
  fields: string[];
  tables: { headers: string[] }[];
  text: string;
}

function uniq(list: string[], limit: number): string[] {
  return [...new Set(list.filter(Boolean))].slice(0, limit);
}

export function outlineOf(doc: Document = document, exclude?: Element): Outline {
  const all = (selector: string) =>
    [...doc.querySelectorAll(selector)].filter(
      (el) => (!exclude || !exclude.contains(el)) && !el.closest('[data-bugspot-ignore]'),
    );
  const fieldName = (el: Element) => {
    const id = el.getAttribute('id');
    const label = id ? doc.querySelector(`label[for="${CSS.escape(id)}"]`) : el.closest('label');
    return cleanName(
      el.getAttribute('aria-label') ||
        label?.textContent ||
        el.getAttribute('placeholder') ||
        el.getAttribute('name') ||
        '',
    );
  };
  const main = doc.querySelector('main') ?? doc.body;
  return {
    title: cleanName(doc.querySelector('h1')?.textContent || doc.title, 200),
    headings: uniq(
      all('h1, h2, h3, [role="heading"]').map((h) => cleanName(h.textContent ?? '')),
      40,
    ),
    actions: uniq(all(INTERACTIVE).map(accessibleName), 80),
    fields: uniq(
      all(
        'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select, [role="combobox"]',
      ).map(fieldName),
      50,
    ),
    tables: all('table, [role="table"], [role="grid"]')
      .slice(0, 6)
      .map((t) => ({
        headers: uniq(
          [...t.querySelectorAll('th, [role="columnheader"]')].map((h) => cleanName(h.textContent ?? '')),
          30,
        ),
      })),
    text: (main?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 1500),
  };
}
