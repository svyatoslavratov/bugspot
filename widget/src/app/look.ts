// The look of a state for the screen map: a real thumbnail and a DOM snapshot without scripts,
// uploaded with the stylesheets the service does not have yet. The collector takes looks of the
// page people are on; the crawler takes them of the app it walks in a frame.

import { outlineOf, structureHash } from '../lib/screen';
import { captureThumbnail } from '../lib/screenshot';
import { serializeDocument } from '../lib/snapshot';
import type { Api } from '../shared/api';
import type { Session, StateRef } from '../shared/types';

const THUMBNAIL_WIDTH = 640;
const THUMBNAIL_MAX_BYTES = 400 << 10;

export interface LookOptions {
  mask: 'inputs' | 'text' | 'none';
  snapshotMaxBytes: number;
  shotMaxBytes: number;
  /** An element of the page that is not part of the look (the widget). */
  exclude?: Element | null;
}

export function lookOptions(session: Session, exclude?: Element | null): LookOptions {
  return {
    mask: session.map?.mask ?? 'inputs',
    snapshotMaxBytes: session.map?.snapshotMaxBytes ?? 8 << 20,
    shotMaxBytes: Math.min(THUMBNAIL_MAX_BYTES, session.limits?.screenshotMaxBytes ?? THUMBNAIL_MAX_BYTES),
    exclude,
  };
}

/** Only the screen and the state: the API takes nothing else in a reference. */
export const refOf = (s: StateRef): StateRef => ({ screen: s.screen, state: s.state });

/**
 * Takes the look of the state doc shows and uploads it. still() is asked after the slow part: a
 * page that has moved on to another state must not get this look. Returns whether a thumbnail went.
 */
export async function takeLook(
  api: Api,
  ref: StateRef,
  doc: Document,
  options: LookOptions,
  still: () => boolean = () => true,
  before?: () => Promise<void>,
): Promise<{ hash: string; hasShot: boolean } | null> {
  const hash = structureHash(doc);
  const outline = outlineOf(doc, options.exclude ?? undefined);
  const [thumb, snap] = await Promise.allSettled([
    captureThumbnail(options.exclude ?? null, THUMBNAIL_WIDTH, options.shotMaxBytes, doc),
    serializeDocument(doc, { mask: options.mask, exclude: options.exclude ?? undefined }),
  ]);
  if (!still()) return null;
  await before?.();
  if (snap.status === 'fulfilled' && snap.value.html.length <= options.snapshotMaxBytes) {
    try {
      const { missing } = await api.missingAssets(snap.value.css.map((c) => c.hash));
      for (const c of snap.value.css) if (missing.includes(c.hash)) await api.putAsset(c.hash, c.text);
      await api.putSnapshot(refOf(ref), {
        html: snap.value.html,
        css: snap.value.css.map((c) => c.hash),
        outline,
        viewport: snap.value.viewport,
        hash,
      });
    } catch {
      // A stylesheet too large or a snapshot over the limit: the thumbnail still goes.
    }
  }
  if (thumb.status === 'fulfilled') await api.putShot(refOf(ref), thumb.value);
  return { hash, hasShot: thumb.status === 'fulfilled' };
}
