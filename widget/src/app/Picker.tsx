import { Button } from '@blueprintjs/core';
import { useEffect, useState } from 'react';

import type { Point } from '../shared/types';
import { useWidget } from './context';

interface Hover {
  el: Element;
  rect: DOMRect;
}

/**
 * Element picking: the element under the pointer is outlined; a click picks it and is swallowed,
 * so the page does not react; Esc cancels. The widget itself cannot be picked.
 */
export function Picker({ onPick, onCancel }: { onPick: (el: Element, point: Point) => void; onCancel: () => void }) {
  const { t, host } = useWidget();
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const own = (e: Event) => e.composedPath().includes(host);
    const under = (x: number, y: number) =>
      document
        .elementsFromPoint(x, y)
        .find((el) => el !== host && !host.contains(el) && el !== document.documentElement) ?? null;
    const onMove = (e: PointerEvent) => {
      if (own(e)) return setHover(null);
      const el = under(e.clientX, e.clientY);
      setHover(el ? { el, rect: el.getBoundingClientRect() } : null);
    };
    const swallow = (e: Event) => {
      if (own(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const onClick = (e: MouseEvent) => {
      if (own(e)) return;
      swallow(e);
      const el = under(e.clientX, e.clientY);
      if (el) onPick(el, { x: e.clientX, y: e.clientY });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    const opts = { capture: true };
    window.addEventListener('pointermove', onMove, opts);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'touchstart'] as const) {
      window.addEventListener(type, swallow, { capture: true, passive: false });
    }
    window.addEventListener('click', onClick, opts);
    window.addEventListener('keydown', onKey, opts);
    const root = document.documentElement;
    const cursor = root.style.cursor;
    root.style.cursor = 'crosshair';
    return () => {
      window.removeEventListener('pointermove', onMove, opts);
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'touchstart'] as const) {
        window.removeEventListener(type, swallow, { capture: true });
      }
      window.removeEventListener('click', onClick, opts);
      window.removeEventListener('keydown', onKey, opts);
      root.style.cursor = cursor;
    };
  }, [host, onPick, onCancel]);

  return (
    <>
      {hover && (
        <div
          className="bugspot-highlight"
          style={{
            left: hover.rect.left - 2,
            top: hover.rect.top - 2,
            width: hover.rect.width + 4,
            height: hover.rect.height + 4,
          }}
        >
          <span className="bugspot-highlight-label">{hover.el.tagName.toLowerCase()}</span>
        </div>
      )}
      <div className="bugspot-pick-bar" role="status">
        <span>{t.pickHint}</span>
        <Button size="small" text={t.pickCancel} onClick={onCancel} />
      </div>
    </>
  );
}
