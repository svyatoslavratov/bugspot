// Attributes an app puts on its elements for the widget: data-pinpath and data-pinpath-<name>.
// Before the project was renamed they were data-bugspot-*; pages that still carry the old names
// work the same.

const NAMES = ['data-pinpath', 'data-bugspot'] as const;

const full = (base: string, name: string) => (name ? `${base}-${name}` : base);

/** A selector for the attribute under either name: [data-pinpath-to], [data-bugspot-to]. */
export function anyAttr(name: string): string {
  return NAMES.map((base) => `[${full(base, name)}]`).join(', ');
}

/** The attribute's value, under its name or the old one. */
export function attrOf(el: Element, name: string): string | null {
  for (const base of NAMES) {
    const v = el.getAttribute(full(base, name));
    if (v !== null) return v;
  }
  return null;
}

export function hasAttr(el: Element, name: string): boolean {
  return NAMES.some((base) => el.hasAttribute(full(base, name)));
}

/** Both full names of an attribute, for attribute filters of observers. */
export function attrNames(name: string): string[] {
  return NAMES.map((base) => full(base, name));
}

/** Elements that are not part of what is collected: the widget itself, or marked by the app. */
export const IGNORED = anyAttr('ignore');
