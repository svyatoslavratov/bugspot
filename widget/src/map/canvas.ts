import { createContext, useContext } from 'react';

import type { Point } from '../shared/types';

/** An element picked on a screen of the canvas, to comment on. */
export interface CanvasPick {
  screen: string;
  state: string;
  el: Element;
  point: Point;
}

/** What the screens on the canvas share: the comment mode and what to do with a pick. */
export interface Canvas {
  commenting: boolean;
  /** Changes when threads change: the pins on the screens load again. */
  version: number;
  onPick: (pick: CanvasPick) => void;
  onOpenThread: (screen: string, thread: string) => void;
  onEscape: () => void;
}

export const CanvasContext = createContext<Canvas>({
  commenting: false,
  version: 0,
  onPick: () => undefined,
  onOpenThread: () => undefined,
  onEscape: () => undefined,
});

export const useCanvas = () => useContext(CanvasContext);
