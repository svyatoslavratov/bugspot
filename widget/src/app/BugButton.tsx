import { Button, Popover, Tooltip } from '@blueprintjs/core';
import { useEffect, useRef, useState, type JSX, type PointerEvent } from 'react';

import type { Point } from '../shared/types';
import { useWidget } from './context';
import { buttonPoint } from './layout';

const DRAG = 4;

/**
 * The floating bug: a click toggles the panel, a drag moves it (the place is remembered), Alt+click
 * starts picking an element at once, a right click opens its menu (settings).
 */
export function BugButton({
  count,
  open,
  position,
  hint,
  menu,
  menuOpen,
  onMenu,
  onMove,
  onClick,
  onQuick,
}: {
  count: number;
  open: boolean;
  position: Point | null;
  hint: string;
  menu: JSX.Element;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onMove: (p: Point) => void;
  onClick: () => void;
  /** Absent when the user may not comment: Alt+click then just opens the panel. */
  onQuick?: () => void;
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

  // The menu is portalled, yet React bubbles its events up here: only events that start on the bug
  // itself drag it or toggle the panel, or the bug would capture the pointer and eat menu clicks.
  const own = (e: { currentTarget: HTMLElement; target: EventTarget }) =>
    e.target instanceof Node && e.currentTarget.contains(e.target);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !own(e)) return;
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
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    if (s.moved && drag) onMove(drag);
    else if (e.altKey && onQuick) onQuick();
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
      onContextMenu={(e) => {
        if (!own(e)) return;
        e.preventDefault();
        onMenu(true);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDrag(null);
      }}
    >
      <Popover
        content={menu}
        isOpen={menuOpen}
        placement="left-end"
        autoFocus={false}
        enforceFocus={false}
        // Opened by the right click only; a click outside or Esc closes it.
        onInteraction={(next) => !next && onMenu(false)}
      >
        <Tooltip content={hint} placement="left" disabled={open || menuOpen || drag !== null}>
          <Button
            icon="bug"
            intent={open ? 'none' : 'primary'}
            size="large"
            aria-label={t.title}
            aria-expanded={open}
            aria-haspopup="menu"
            className="bugspot-bug-button"
          />
        </Tooltip>
      </Popover>
      {count > 0 && <span className="bugspot-bug-count">{count > 99 ? '99+' : count}</span>}
    </div>
  );
}
