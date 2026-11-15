// The DOM of a snapshot in a frame of the map page: its stylesheets put back, its scroll restored,
// and the boxes of its elements for overlays drawn over the frame.

import { anyAttr, attrOf } from '../lib/attrs';
import type { SnapshotData } from '../shared/types';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Puts the stylesheets into the snapshot and restores the scroll positions of its containers. */
export function prepare(doc: Document, snap: SnapshotData) {
  // Snapshots taken before the rename from bugspot carry data-bugspot-* attributes.
  for (const style of doc.querySelectorAll('style[data-pinpath-asset], style[data-bugspot-asset]')) {
    style.textContent = snap.css[attrOf(style, 'asset') ?? ''] ?? '';
  }
  for (const el of doc.querySelectorAll(anyAttr('scroll'))) {
    const [x, y] = (attrOf(el, 'scroll') ?? '0,0').split(',').map(Number);
    el.scrollLeft = x;
    el.scrollTop = y;
  }
}
