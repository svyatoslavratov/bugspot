import { Button, Tooltip } from '@blueprintjs/core';
import { useEffect, useRef, useState, type PointerEvent } from 'react';

import type { Point } from '../shared/types';
import { useWidget } from './context';
import { buttonPoint } from './layout';

const DRAG = 4;

/** The floating bug: click toggles the panel, drag moves it (the place is remembered). */
export function BugButton({
  count,
  open,
  position,
  onMove,
  onClick,
}: {
  count: number;
  open: boolean;
  position: Point | null;
  onMove: (p: Point) => void;
  onClick: () => void;
}) {
  const { t, settings } = useWidget();
  const [, setViewport] = useState(0);
  const [drag, setDrag] = useState<Point | null>(null);
  const start = useRef<{ pointer: Point; origin: Point; moved: boolean } | null>(null);
  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const point = drag ?? buttonPoint(position, settings.position);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { pointer: { x: e.clientX, y: e.clientY }, origin: point, moved: false };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.pointer.x;
    const dy = e.clientY - s.pointer.y;
    if (!s.moved && Math.hypot(dx, dy) < DRAG) return;
    s.moved = true;
    setDrag(buttonPoint({ x: s.origin.x + dx, y: s.origin.y + dy }, settings.position));
  };
  const up = () => {
    const s = start.current;
    start.current = null;
    if (s?.moved && drag) onMove(drag);
    else onClick();
    setDrag(null);
  };

  return (
    <div
      className={`bugspot-bug ${drag ? 'is-dragging' : ''}`}
      style={{ left: point.x, top: point.y }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        start.current = null;
        setDrag(null);
      }}
    >
      <Tooltip content={t.title} placement="left" disabled={open || drag !== null}>
        <Button
          icon="bug"
          intent={open ? 'none' : 'primary'}
          size="large"
          aria-label={t.title}
          aria-expanded={open}
          className="bugspot-bug-button"
        />
      </Tooltip>
      {count > 0 && <span className="bugspot-bug-count">{count > 99 ? '99+' : count}</span>}
    </div>
  );
}
