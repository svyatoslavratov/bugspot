import { Button } from '@blueprintjs/core';
import { useEffect, useRef, useState } from 'react';

import { MAX_ELEMENTS } from '../lib/anchor';
import type { Point } from '../shared/types';
import { useWidget } from './context';

/** A picked element and the point it was clicked at. */
export interface Pick {
  el: Element;
  point: Point;
}

interface Hover {
  el: Element;
  rect: DOMRect;
}

/**
 * Element picking: the element under the pointer is outlined; a click picks it and is swallowed,
 * so the page does not react; Esc cancels. Shift+click collects several elements with the same
 * problem (Shift+click on a picked one drops it); a plain click on the last one or Enter finishes.
 * The widget itself cannot be picked.
 */
export function Picker({
  notice,
  onPick,
  onCancel,
}: {
  /** A line before the hint, such as "Comment #12 sent" when picking goes on after a comment. */
  notice?: string;
  onPick: (picks: Pick[]) => void;
  onCancel: () => void;
}) {
  const { t, host } = useWidget();
  const [hover, setHover] = useState<Hover | null>(null);
  const [picked, setPicked] = useState<Pick[]>([]);
  // Event handlers read the selection through a ref, so they are not re-attached on every change.
  const pickedRef = useRef<Pick[]>([]);
  pickedRef.current = picked;
  // Picked outlines follow scrolling: re-render on scroll and resize.
  const [, setFrame] = useState(0);

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
      if (!el) return;
      const current = pickedRef.current;
      const known = current.some((p) => p.el === el);
      const pick = { el, point: { x: e.clientX, y: e.clientY } };
      if (e.shiftKey) {
        if (known) setPicked(current.filter((p) => p.el !== el));
        else if (current.length < MAX_ELEMENTS) setPicked([...current, pick]);
        return;
      }
      onPick(known || current.length >= MAX_ELEMENTS ? current : [...current, pick]);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
      if (e.key === 'Enter' && pickedRef.current.length > 0) {
        e.preventDefault();
        onPick(pickedRef.current);
      }
    };
    const redraw = () => setFrame((n) => n + 1);
    const opts = { capture: true };
    window.addEventListener('pointermove', onMove, opts);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'touchstart'] as const) {
      window.addEventListener(type, swallow, { capture: true, passive: false });
    }
    window.addEventListener('click', onClick, opts);
    window.addEventListener('keydown', onKey, opts);
    window.addEventListener('scroll', redraw, { capture: true, passive: true });
    window.addEventListener('resize', redraw);
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
      window.removeEventListener('scroll', redraw, { capture: true });
      window.removeEventListener('resize', redraw);
      root.style.cursor = cursor;
    };
  }, [host, onPick, onCancel]);

  const full = picked.length >= MAX_ELEMENTS;
  return (
    <>
      {picked.map((p, i) => {
        const r = p.el.getBoundingClientRect();
        return (
          <div
            key={i}
            className="bugspot-picked"
            style={{ left: r.left - 2, top: r.top - 2, width: r.width + 4, height: r.height + 4 }}
          >
            <span className="bugspot-picked-number">{i + 1}</span>
          </div>
        );
      })}
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
        <span>
          {notice && <strong className="bugspot-pick-notice">{notice} · </strong>}
          {picked.length === 0 ? t.pickHint : full ? t.pickedFull(picked.length) : t.picked(picked.length)}
        </span>
        {picked.length > 0 && <Button size="small" intent="primary" text={t.pickDone} onClick={() => onPick(picked)} />}
        <Button size="small" text={notice ? t.pickFinish : t.pickCancel} onClick={onCancel} />
      </div>
    </>
  );
}
