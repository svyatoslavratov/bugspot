// Moving around the map with the keyboard, smoothly: while the arrows or WASD are held, the camera
// glides — it picks up speed for a moment, goes at a steady pace (faster with Shift) and slows down
// once they are released — instead of jumping a step at each repeat of the key.

import { useEffect } from 'react';

export interface Vec {
  x: number;
  y: number;
}

/** Keys typed into a field are not shortcuts. */
export function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** Where each key moves the camera. */
export const GLIDE_KEYS: Record<string, Vec> = {
  ArrowLeft: { x: -1, y: 0 },
  KeyA: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  KeyD: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  KeyW: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  KeyS: { x: 0, y: 1 },
};

/** The pace of the camera in screen pixels a second: the same at any zoom; with Shift. */
export const GLIDE_SPEED = 900;
export const GLIDE_FAST = 2400;
/** How soon the camera gets up to speed and comes to rest, in seconds (time constants). */
const SPEED_UP = 0.08;
const SLOW_DOWN = 0.12;
/** Slower than this, in pixels a second, the camera stops. */
const REST = 4;
/** A key counts as held at least this long, in milliseconds: a tap moves the camera a little too. */
export const TAP_MS = 120;

/**
 * The way the held keys point: a unit vector, so a diagonal is not faster, and two keys of one way
 * (→ and D) are not either; opposite keys cancel out.
 */
export function directionOf(held: Iterable<string>): Vec {
  let x = 0;
  let y = 0;
  for (const code of held) {
    const d = GLIDE_KEYS[code];
    if (!d) continue;
    x += d.x;
    y += d.y;
  }
  x = Math.sign(x);
  y = Math.sign(y);
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

/** The velocity dt seconds later: it eases toward the target — the keys' pace, or rest. */
export function glideStep(v: Vec, target: Vec, dt: number): Vec {
  const moving = target.x !== 0 || target.y !== 0;
  const k = 1 - Math.exp(-dt / (moving ? SPEED_UP : SLOW_DOWN));
  return { x: v.x + (target.x - v.x) * k, y: v.y + (target.y - v.y) * k };
}

export interface Frames {
  request: (tick: (now: number) => void) => number;
  cancel: (id: number) => void;
  now: () => number;
}

const browserFrames: Frames = {
  request: (tick) => requestAnimationFrame(tick),
  cancel: (id) => cancelAnimationFrame(id),
  now: () => performance.now(),
};

export interface Glide {
  press: (code: string, fast: boolean) => void;
  release: (code: string) => void;
  /** Shift pressed or released while gliding. */
  fast: (on: boolean) => void;
  /** Every key let go at once: the window lost the focus and will not hear them released. */
  releaseAll: () => void;
  /** Stops at once. */
  stop: () => void;
}

/** The camera's motion while keys are held: move gets the shift of each frame, in screen pixels. */
export function createGlide(move: (dx: number, dy: number) => void, frames: Frames = browserFrames): Glide {
  const held = new Set<string>();
  const pressedAt = new Map<string, number>();
  /** Keys let go before they were held for a tap: when to let them go. */
  const letGo = new Map<string, number>();
  let fast = false;
  let v: Vec = { x: 0, y: 0 };
  let frame = 0;
  let last = 0;
  const tick = (now: number) => {
    // A late frame (a busy page, a hidden tab) does not make a jump.
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    for (const [code, at] of letGo) {
      if (now < at) continue;
      held.delete(code);
      letGo.delete(code);
    }
    const way = directionOf(held);
    const speed = fast ? GLIDE_FAST : GLIDE_SPEED;
    v = glideStep(v, { x: way.x * speed, y: way.y * speed }, dt);
    if (held.size === 0 && Math.hypot(v.x, v.y) < REST) {
      v = { x: 0, y: 0 };
      frame = 0;
      return;
    }
    if (dt > 0) move(v.x * dt, v.y * dt);
    frame = frames.request(tick);
  };
  return {
    press(code, on) {
      held.add(code);
      letGo.delete(code);
      pressedAt.set(code, frames.now());
      fast = on;
      if (frame) return;
      last = frames.now();
      frame = frames.request(tick);
    },
    release(code) {
      if (!held.has(code)) return;
      const at = (pressedAt.get(code) ?? 0) + TAP_MS;
      if (frames.now() >= at) held.delete(code);
      else letGo.set(code, at);
    },
    fast: (on) => void (fast = on),
    releaseAll() {
      held.clear();
      letGo.clear();
    },
    stop() {
      held.clear();
      letGo.clear();
      if (frame) frames.cancel(frame);
      frame = 0;
      v = { x: 0, y: 0 };
    },
  };
}

/**
 * Arrows and WASD glide the camera of the canvas while enabled (not while a dialog over the map is
 * open, nor while typing in a field).
 */
export function useGlide(
  flow: {
    getViewport: () => { x: number; y: number; zoom: number };
    setViewport: (v: Vec & { zoom: number }) => unknown;
  },
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    // The camera moves one way, the canvas the other.
    const glide = createGlide((dx, dy) => {
      const vp = flow.getViewport();
      void flow.setViewport({ x: vp.x - dx, y: vp.y - dy, zoom: vp.zoom });
    });
    const onDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') glide.fast(true);
      if (!GLIDE_KEYS[e.code] || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      e.preventDefault();
      if (!e.repeat) glide.press(e.code, e.shiftKey);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') glide.fast(false);
      glide.release(e.code);
    };
    const onLeave = () => glide.releaseAll();
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onLeave);
    document.addEventListener('visibilitychange', onLeave);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onLeave);
      document.removeEventListener('visibilitychange', onLeave);
      glide.stop();
    };
  }, [flow, enabled]);
}
