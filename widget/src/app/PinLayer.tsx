import { Tooltip } from '@blueprintjs/core';
import { useEffect, useMemo, useState } from 'react';

import { anchorsOf, pinPoint, resolveAnchor } from '../lib/anchor';
import type { Thread } from '../shared/types';
import { statusIntent } from './labels';

/**
 * Numbered pins for the active threads of the page, one on each element of a thread. Positions
 * follow scrolling (also inside scrollable containers), resizing and DOM changes, recomputed at
 * most once per frame.
 */
export function PinLayer({
  threads,
  selectedId,
  flashId,
  passive = false,
  onOpen,
}: {
  threads: Thread[];
  selectedId: string | null;
  /** A pin that pulses after "Show on the page". */
  flashId: string | null;
  /** While an element is being picked: pins stay in sight but let clicks through. */
  passive?: boolean;
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
        .flatMap((thread) =>
          anchorsOf(thread.anchor).map((anchor, index) => {
            // Only found elements get a pin: a click point without its element (a closed modal,
            // a removed row) would put the pin over something unrelated. When the element comes
            // back (the modal opens again) the next DOM change redraws the pin on it.
            const el = resolveAnchor(anchor);
            return { thread, index, point: el ? pinPoint(anchor, el) : null };
          }),
        )
        .filter(
          (p): p is typeof p & { point: NonNullable<typeof p.point> } =>
            p.point !== null &&
            p.point.x >= -20 &&
            p.point.y >= -20 &&
            p.point.x <= innerWidth + 20 &&
            p.point.y <= innerHeight + 20,
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threads, frame],
  );

  return (
    <div className={`bugspot-pins ${passive ? 'is-passive' : ''}`}>
      {pins.map(({ thread, index, point }) => (
        // The pin itself is the tooltip target: a wrapper around a fixed pin has no box of its
        // own and would anchor the tooltip to the top left corner of the page.
        <Tooltip
          key={`${thread.id}-${index}`}
          disabled={passive}
          content={thread.body.slice(0, 140)}
          placement="top"
          renderTarget={({ isOpen: _isOpen, ref, className, ...target }) => (
            <button
              {...target}
              ref={ref}
              type="button"
              className={`${className ?? ''} bugspot-pin intent-${statusIntent[thread.status]} ${
                thread.id === selectedId ? 'is-selected' : ''
              } ${thread.id === flashId ? 'is-flashing' : ''}`}
              style={{ left: point.x, top: point.y }}
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
