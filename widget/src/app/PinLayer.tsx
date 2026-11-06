import { Tooltip } from '@blueprintjs/core';
import { useEffect, useMemo, useState } from 'react';

import { pinPoint, resolveAnchor } from '../lib/anchor';
import type { Thread } from '../shared/types';
import { statusIntent } from './labels';

/**
 * Numbered pins for the active threads of the page. Positions follow scrolling (also inside
 * scrollable containers), resizing and DOM changes, recomputed at most once per frame.
 */
export function PinLayer({
  threads,
  selectedId,
  flashId,
  onOpen,
}: {
  threads: Thread[];
  selectedId: string | null;
  /** A pin that pulses after "Show on the page". */
  flashId: string | null;
  onOpen: (id: string) => void;
}) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        setFrame((n) => n + 1);
      });
    };
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    return () => {
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, []);

  const pins = useMemo(
    () =>
      threads
        .map((thread) => {
          const el = resolveAnchor(thread.anchor);
          return { thread, point: pinPoint(thread.anchor, el), detached: !el };
        })
        .filter(
          (p) =>
            p.point &&
            p.point.x >= -20 &&
            p.point.y >= -20 &&
            p.point.x <= innerWidth + 20 &&
            p.point.y <= innerHeight + 20,
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threads, frame],
  );

  return (
    <div className="bugspot-pins">
      {pins.map(({ thread, point, detached }) => (
        // The pin itself is the tooltip target: a wrapper around a fixed pin has no box of its
        // own and would anchor the tooltip to the top left corner of the page.
        <Tooltip
          key={thread.id}
          content={thread.body.slice(0, 140)}
          placement="top"
          renderTarget={({ isOpen: _isOpen, ref, className, ...target }) => (
            <button
              {...target}
              ref={ref}
              type="button"
              className={`${className ?? ''} bugspot-pin intent-${statusIntent[thread.status]} ${
                detached ? 'is-detached' : ''
              } ${thread.id === selectedId ? 'is-selected' : ''} ${thread.id === flashId ? 'is-flashing' : ''}`}
              style={{ left: point!.x, top: point!.y }}
              onClick={() => onOpen(thread.id)}
              aria-label={`#${thread.number}`}
            >
              {thread.number}
            </button>
          )}
        />
      ))}
    </div>
  );
}
