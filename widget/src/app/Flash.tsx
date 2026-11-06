import { useEffect, useState } from 'react';

import { pinPoint, resolveAnchor } from '../lib/anchor';
import type { Anchor } from '../shared/types';

export const FLASH_MS = 1800;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A short highlight of a thread's element after "Show on the page": a frame that follows the
 * element while the page scrolls to it, then fades. A detached thread gets a ring at its point.
 */
export function Flash({ anchor }: { anchor: Partial<Anchor> }) {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    let frame = 0;
    const until = performance.now() + FLASH_MS;
    const track = () => {
      const el = resolveAnchor(anchor);
      if (el) {
        const r = el.getBoundingClientRect();
        setBox({ left: r.left - 6, top: r.top - 6, width: r.width + 12, height: r.height + 12 });
      } else {
        const p = pinPoint(anchor, null);
        setBox(p ? { left: p.x - 24, top: p.y - 24, width: 48, height: 48 } : null);
      }
      if (performance.now() < until) frame = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(frame);
  }, [anchor]);
  if (!box) return null;
  return <div className="bugspot-flash" style={box} aria-hidden />;
}
