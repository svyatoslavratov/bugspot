import type { Point, Settings } from '../shared/types';

export const BUTTON = 48;
const MARGIN = 20;

/** The bug button's top-left corner: the saved one (kept on screen) or the configured corner. */
export function buttonPoint(saved: Point | null, corner: Settings['position']): Point {
  const maxX = innerWidth - BUTTON - 8;
  const maxY = innerHeight - BUTTON - 8;
  if (saved) return { x: Math.min(Math.max(8, saved.x), maxX), y: Math.min(Math.max(8, saved.y), maxY) };
  return {
    x: corner.endsWith('left') ? MARGIN : innerWidth - BUTTON - MARGIN,
    y: corner.startsWith('top') ? MARGIN : innerHeight - BUTTON - MARGIN,
  };
}

/** The panel docks on the button's side and avoids covering it. */
export function panelBox(button: Point): { left: number; top: number; width: number; height: number } {
  const width = Math.min(420, innerWidth - 16);
  const right = button.x + BUTTON / 2 > innerWidth / 2;
  const left = right
    ? Math.max(8, Math.min(button.x + BUTTON - width, innerWidth - width - 8))
    : Math.max(8, Math.min(button.x, innerWidth - width - 8));
  const below = button.y + BUTTON / 2 < innerHeight / 2;
  const space = below ? innerHeight - (button.y + BUTTON + 12) - 8 : button.y - 12 - 8;
  const height = Math.max(Math.min(680, space), Math.min(360, innerHeight - 16));
  const top = below ? Math.min(button.y + BUTTON + 12, innerHeight - height - 8) : Math.max(8, button.y - 12 - height);
  return { left, top, width, height };
}
