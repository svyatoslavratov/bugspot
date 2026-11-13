import type { Anchor, ElementAnchor, Layer, Point } from '../shared/types';

const TEXT_LIMIT = 120;

/** Visible text of an element, whitespace collapsed. */
export function textOf(el: Element): string {
  // By tag name: elements of a frame are of another realm, where class checks miss them.
  const field = el.localName === 'input' || el.localName === 'textarea' ? (el as HTMLInputElement) : null;
  const raw = field ? field.placeholder || field.value || el.getAttribute('aria-label') || '' : (el.textContent ?? '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT);
}

// Ids that change between renders: React useId (:r1:), long numbers, uuids.
const unstableId = /[:\s]|\d{4,}|^[0-9a-f]{8}-/i;

function unique(selector: string, root: ParentNode, el: Element): boolean {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

/** A quoted attribute value: only quotes and backslashes need escaping there. */
const quoted = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`;

function stableAttribute(el: Element, root: ParentNode): string | null {
  const tag = el.tagName.toLowerCase();
  const candidates: string[] = [];
  const bugspot = el.getAttribute('data-bugspot');
  if (bugspot) candidates.push(`[data-bugspot=${quoted(bugspot)}]`);
  if (el.id && !unstableId.test(el.id)) candidates.push(`#${CSS.escape(el.id)}`);
  for (const attr of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'title', 'placeholder']) {
    const value = el.getAttribute(attr);
    if (value && value.length <= 80) candidates.push(`${tag}[${attr}=${quoted(value)}]`);
  }
  return candidates.find((s) => unique(s, root, el)) ?? null;
}

/**
 * A selector for el: a stable attribute of the element itself, or a short nth-of-type path from
 * the nearest ancestor with one (or from body). Hashed class names are avoided on purpose.
 */
export function selectorOf(el: Element, root: ParentNode = document): string {
  const own = stableAttribute(el, root);
  if (own) return own;
  const steps: string[] = [];
  let node: Element | null = el;
  const doc = el.ownerDocument;
  while (node && node !== doc.body && node !== doc.documentElement && steps.length < 10) {
    const anchor: string | null = steps.length ? stableAttribute(node, root) : null;
    if (anchor) {
      steps.unshift(anchor);
      break;
    }
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    const same = parent ? [...parent.children].filter((c) => c.tagName === node!.tagName) : [];
    steps.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
    node = parent;
  }
  const path = steps.join(' > ');
  return node === doc.body || node === doc.documentElement ? `body > ${path}` : path;
}

const DIALOGS = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const POPUPS = '[popover], [role="menu"], [role="listbox"], [role="tooltip"]';

/** The dialog or popup el is in, with its title; undefined for an element of the page itself. */
export function layerOf(el: Element): Layer | undefined {
  const dialog = el.closest(DIALOGS);
  const box = dialog ?? el.closest(POPUPS);
  if (!box) return undefined;
  const labelled = box
    .getAttribute('aria-labelledby')
    ?.split(/\s+/)
    .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ');
  const heading = box.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
  const title = (box.getAttribute('aria-label') || labelled || (heading ? textOf(heading) : ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return { kind: dialog ? 'dialog' : 'popup', ...(title ? { title } : {}) };
}

/**
 * Builds the anchor for a click at (clientX, clientY) on el, in the window of its document: the page
 * itself, or the frame of a DOM snapshot on the screen map (the same anchor then pins on the page).
 */
export function buildAnchor(el: Element, client: Point): Anchor {
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;
  const rect = el.getBoundingClientRect();
  const clamp = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));
  const source = el.closest('[data-bugspot-src]')?.getAttribute('data-bugspot-src') ?? undefined;
  return {
    selector: selectorOf(el, doc),
    text: textOf(el),
    tag: el.tagName.toLowerCase(),
    offset: {
      x: Math.round(clamp((client.x - rect.left) / rect.width) * 1000) / 1000,
      y: Math.round(clamp((client.y - rect.top) / rect.height) * 1000) / 1000,
    },
    page: { x: Math.round(client.x + win.scrollX), y: Math.round(client.y + win.scrollY) },
    viewport: { w: win.innerWidth, h: win.innerHeight },
    source,
    layer: layerOf(el),
  };
}

function visible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/**
 * Finds the anchored element: by selector when its text still matches, else by the same tag and
 * text (the closest to the original point), else null — the thread is then "detached".
 */
export function resolveAnchor(anchor: Partial<Anchor>, root: ParentNode = document): Element | null {
  const text = anchor.text ?? '';
  if (anchor.selector) {
    try {
      const el = root.querySelector(anchor.selector);
      if (el && visible(el) && (!text || textOf(el) === text || textOf(el).includes(text.slice(0, 40)))) return el;
    } catch {
      // A selector from an older page version may no longer parse; fall back to text.
    }
  }
  if (!text || !anchor.tag) return null;
  let best: Element | null = null;
  let bestDistance = Infinity;
  for (const el of root.querySelectorAll(anchor.tag)) {
    if (textOf(el) !== text || !visible(el)) continue;
    const rect = el.getBoundingClientRect();
    const distance = anchor.page
      ? Math.hypot(rect.left + scrollX - anchor.page.x, rect.top + scrollY - anchor.page.y)
      : 0;
    if (distance < bestDistance) {
      best = el;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Where the element's pin goes, in viewport coordinates. Without the element (null) it is the
 * original click point: only "show on the page" uses that, pins are drawn on found elements only.
 */
export function pinPoint(anchor: Partial<Anchor>, el: Element | null): Point | null {
  if (el) {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + (anchor.offset?.x ?? 0.5) * rect.width,
      y: rect.top + (anchor.offset?.y ?? 0.5) * rect.height,
    };
  }
  if (!anchor.page) return null;
  return { x: anchor.page.x - scrollX, y: anchor.page.y - scrollY };
}

/** Most elements one comment can mark: keeps the anchor well under the service's 16 KB limit. */
export const MAX_ELEMENTS = 10;

/** The elements of an anchor: the first one and those picked with Shift. */
export function anchorsOf(anchor: Partial<Anchor>): Partial<ElementAnchor>[] {
  const { more, ...first } = anchor;
  return [first, ...(Array.isArray(more) ? more : [])];
}

/** One anchor for several picked elements: the first at the top level, the rest in more. */
export function combineAnchors(list: ElementAnchor[]): Anchor {
  const [first, ...more] = list;
  return more.length ? { ...first, more } : first;
}
