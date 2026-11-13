// A DOM snapshot of the page for the screen map: the document without scripts and event handlers,
// rendered later in a sandboxed frame. Stylesheets are cut out and sent once, named by their
// SHA-256; in the HTML they become <style data-bugspot-asset="HASH"></style>. What people typed is
// masked (inputs mode), or all text is (text mode); data-bugspot-mask masks a part always.

export type Mask = 'none' | 'inputs' | 'text';

export interface Stylesheet {
  hash: string;
  text: string;
}

export interface Snapshot {
  html: string;
  css: Stylesheet[];
  viewport: { w: number; h: number };
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const DROP = new Set(['script', 'noscript', 'template', 'object', 'embed', 'base']);
const URL_ATTRS = new Set(['src', 'href', 'poster', 'xlink:href', 'background']);
const KEEP_INPUT = new Set([
  'checkbox',
  'radio',
  'submit',
  'button',
  'reset',
  'color',
  'range',
  'hidden',
  'file',
  'image',
]);

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Masked text keeps its length (up to a point) and whitespace, so the layout stays. */
export function maskText(s: string): string {
  return s.replace(/\S/g, '•');
}

export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function absolute(value: string, base: string): string {
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

/** url(...) in CSS made absolute against the stylesheet's own address. */
export function absoluteCss(css: string, base: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote: string, url: string) => {
    if (/^(data:|blob:|#|[a-z][a-z0-9+.-]*:)/i.test(url)) return match;
    return `url(${quote}${absolute(url, base)}${quote})`;
  });
}

function sheetText(sheet: CSSStyleSheet, base: string): string | null {
  try {
    const text = [...sheet.cssRules].map((r) => r.cssText).join('\n');
    return absoluteCss(text, sheet.href ?? base);
  } catch {
    // A stylesheet of another origin without CORS: its rules cannot be read.
    return null;
  }
}

interface Context {
  base: string;
  mask: Mask;
  exclude?: Element;
  sheets: Map<Node, CSSStyleSheet>;
  css: Map<string, string>;
  pending: Promise<void>[];
  placeholders: Map<string, string>;
  counter: number;
}

/** Stylesheets become placeholders now; their hashes are filled in once computed. */
function placeholder(ctx: Context, text: string): string {
  const id = `@@bugspot-css-${ctx.counter++}@@`;
  ctx.pending.push(
    sha256(text).then((hash) => {
      ctx.css.set(hash, text);
      ctx.placeholders.set(id, hash);
    }),
  );
  return `<style data-bugspot-asset="${id}"></style>`;
}

function adoptedOf(root: Document | ShadowRoot): CSSStyleSheet[] {
  try {
    return [...(root.adoptedStyleSheets ?? [])];
  } catch {
    return [];
  }
}

function attributes(el: Element, ctx: Context, masked: boolean): string {
  let out = '';
  const tag = el.localName;
  for (const attr of el.attributes) {
    const name = attr.name;
    if (name.startsWith('on') || name === 'nonce' || name === 'integrity' || name === 'loading' || name === 'srcdoc')
      continue;
    let value = attr.value;
    if (URL_ATTRS.has(name) && value && !value.startsWith('#') && !/^javascript:/i.test(value)) {
      value = absolute(value, ctx.base);
    } else if (URL_ATTRS.has(name) && /^javascript:/i.test(value)) {
      continue;
    } else if (name === 'srcset') {
      value = value
        .split(',')
        .map((part) => {
          const [url, ...rest] = part.trim().split(/\s+/);
          return [absolute(url, ctx.base), ...rest].join(' ');
        })
        .join(', ');
    } else if (name === 'style') {
      value = absoluteCss(value, ctx.base);
    } else if (name === 'value' && tag === 'input') {
      continue; // written from the live value below
    } else if (name === 'action' || name === 'formaction') {
      continue;
    }
    out += ` ${name}="${escapeAttr(value)}"`;
  }
  // Elements of a frame belong to another realm: tag names find them where class checks would not.
  if (tag === 'input') {
    const input = el as HTMLInputElement;
    const type = (input.type || 'text').toLowerCase();
    if ((type === 'checkbox' || type === 'radio') && input.checked && !el.hasAttribute('checked')) out += ' checked';
    if (!KEEP_INPUT.has(type) && input.value) {
      const hide = type === 'password' || masked || ctx.mask !== 'none';
      out += ` value="${escapeAttr(hide ? maskText(input.value) : input.value)}"`;
    } else if (KEEP_INPUT.has(type) && input.value && type !== 'file') {
      out += ` value="${escapeAttr(input.value)}"`;
    }
  }
  if (tag === 'option' && (el as HTMLOptionElement).selected && !el.hasAttribute('selected')) out += ' selected';
  if (el.scrollTop > 0 || el.scrollLeft > 0) out += ` data-bugspot-scroll="${el.scrollLeft},${el.scrollTop}"`;
  return out;
}

function serializeChildren(parent: Node, ctx: Context, masked: boolean): string {
  let out = '';
  for (const child of parent.childNodes) out += serializeNode(child, ctx, masked);
  return out;
}

function serializeNode(node: Node, ctx: Context, masked: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    return escapeText(masked || ctx.mask === 'text' ? maskText(text) : text);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  if (el === ctx.exclude || el.hasAttribute('data-bugspot-ignore')) return '';
  const tag = el.localName;
  if (DROP.has(tag)) return '';
  if (tag === 'link') {
    const rel = (el.getAttribute('rel') ?? '').toLowerCase();
    if (rel.includes('stylesheet')) {
      const sheet = ctx.sheets.get(el);
      const text = sheet ? sheetText(sheet, ctx.base) : null;
      if (text !== null && text !== undefined) return placeholder(ctx, text);
      const href = el.getAttribute('href');
      return href ? `<link rel="stylesheet" href="${escapeAttr(absolute(href, ctx.base))}">` : '';
    }
    if (rel.includes('icon')) return `<link${attributes(el, ctx, false)}>`;
    return '';
  }
  if (tag === 'meta' && el.hasAttribute('http-equiv')) return '';
  if (tag === 'style') {
    const sheet = ctx.sheets.get(el);
    const text = sheet ? sheetText(sheet, ctx.base) : (el.textContent ?? '');
    return placeholder(ctx, text ?? '');
  }
  if (tag === 'iframe' || tag === 'frame') {
    const rect = el.getBoundingClientRect();
    return `<div data-bugspot-frame style="width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;background:#e5e8eb"></div>`;
  }
  if (tag === 'canvas') {
    try {
      const url = (el as HTMLCanvasElement).toDataURL('image/png');
      return `<img src="${url}"${attributes(el, ctx, false)}>`;
    } catch {
      return `<div${attributes(el, ctx, false)}></div>`;
    }
  }
  const isMasked = masked || el.hasAttribute('data-bugspot-mask');
  let out = `<${tag}${attributes(el, ctx, isMasked)}>`;
  if (VOID.has(tag)) return out;
  const shadow = (el as HTMLElement).shadowRoot;
  if (shadow) {
    out += '<template shadowrootmode="open">';
    for (const sheet of adoptedOf(shadow)) {
      const text = sheetText(sheet, ctx.base);
      if (text) out += placeholder(ctx, text);
    }
    out += serializeChildren(shadow, ctx, isMasked);
    out += '</template>';
  }
  if (tag === 'textarea') {
    const area = el as HTMLTextAreaElement;
    const value = isMasked || ctx.mask !== 'none' ? maskText(area.value) : area.value;
    out += escapeText(value);
  } else {
    out += serializeChildren(el, ctx, isMasked);
  }
  if (tag === 'head') {
    for (const sheet of adoptedOf(el.ownerDocument)) {
      const text = sheetText(sheet, ctx.base);
      if (text) out += placeholder(ctx, text);
    }
  }
  return `${out}</${tag}>`;
}

/** Stylesheets of the document and its open shadow roots by the node that owns them. */
function sheetsOf(doc: Document): Map<Node, CSSStyleSheet> {
  const out = new Map<Node, CSSStyleSheet>();
  const add = (list: StyleSheetList) => {
    for (const sheet of list)
      if (sheet.ownerNode && 'cssRules' in sheet) out.set(sheet.ownerNode, sheet as CSSStyleSheet);
  };
  add(doc.styleSheets);
  for (const el of doc.querySelectorAll('*')) {
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) add(shadow.styleSheets);
  }
  return out;
}

/** Serializes the document as it is now. */
export async function serializeDocument(doc: Document, options: { mask: Mask; exclude?: Element }): Promise<Snapshot> {
  const ctx: Context = {
    base: doc.baseURI,
    mask: options.mask,
    exclude: options.exclude,
    sheets: sheetsOf(doc),
    css: new Map(),
    pending: [],
    placeholders: new Map(),
    counter: 0,
  };
  let html = `<!DOCTYPE html>${serializeNode(doc.documentElement, ctx, false)}`;
  await Promise.all(ctx.pending);
  html = html.replace(/@@bugspot-css-\d+@@/g, (id) => ctx.placeholders.get(id) ?? '');
  const win = doc.defaultView ?? window;
  return {
    html,
    css: [...ctx.css].map(([hash, text]) => ({ hash, text })),
    viewport: { w: win.innerWidth, h: win.innerHeight },
  };
}
