import { useEffect, useState } from 'react';

import { anchorsOf, pinPoint, resolveAnchor } from '../lib/anchor';
import type { Anchor } from '../shared/types';

export const FLASH_MS = 1800;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A short highlight of a thread's elements after "Show on the page": a frame around each element
 * that follows it while the page scrolls there, then fades. An element that is gone gets a ring at
 * its click point, unless it was in a modal or popup: that point means nothing once the window is
 * closed.
 */
export function Flash({ anchor }: { anchor: Partial<Anchor> }) {
  const [boxes, setBoxes] = useState<Box[]>([]);
  useEffect(() => {
    let frame = 0;
    const until = performance.now() + FLASH_MS;
    const track = () => {
      const next: Box[] = [];
      for (const a of anchorsOf(anchor)) {
        const el = resolveAnchor(a);
        if (el) {
          const r = el.getBoundingClientRect();
          next.push({ left: r.left - 6, top: r.top - 6, width: r.width + 12, height: r.height + 12 });
          continue;
        }
        if (a.layer) continue;
        const p = pinPoint(a, null);
        if (p) next.push({ left: p.x - 24, top: p.y - 24, width: 48, height: 48 });
      }
      setBoxes(next);
      if (performance.now() < until) frame = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(frame);
  }, [anchor]);
  return (
    <>
      {boxes.map((box, i) => (
        <div key={i} className="bugspot-flash" style={box} aria-hidden />
      ))}
    </>
  );
}
