import { expect, test } from 'vitest';

import { createGlide, directionOf, GLIDE_FAST, GLIDE_SPEED, glideStep, type Frames } from '../src/map/keyboard';

test('the way of the held keys: diagonals and doubled keys are not faster, opposite keys cancel', () => {
  expect(directionOf(['KeyD'])).toEqual({ x: 1, y: 0 });
  expect(directionOf(['ArrowRight', 'KeyD'])).toEqual({ x: 1, y: 0 });
  const diagonal = directionOf(['KeyW', 'KeyD']);
  expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1);
  expect([diagonal.x > 0, diagonal.y < 0]).toEqual([true, true]);
  expect(directionOf(['KeyA', 'KeyD'])).toEqual({ x: 0, y: 0 });
  expect(directionOf(['Space'])).toEqual({ x: 0, y: 0 });
});

test('the velocity eases toward the pace of the keys and back to rest', () => {
  let v = { x: 0, y: 0 };
  for (let i = 0; i < 60; i++) v = glideStep(v, { x: 900, y: 0 }, 1 / 60);
  expect(v.x).toBeGreaterThan(890);
  for (let i = 0; i < 60; i++) v = glideStep(v, { x: 0, y: 0 }, 1 / 60);
  expect(v.x).toBeLessThan(5);
});

/** Frames by hand: each call of frame() runs the scheduled tick 1/60 s later. */
function manualFrames() {
  let now = 0;
  let next: ((t: number) => void) | null = null;
  const frames: Frames = {
    request: (tick) => {
      next = tick;
      return 1;
    },
    cancel: () => {
      next = null;
    },
    now: () => now,
  };
  const frame = () => {
    const tick = next;
    next = null;
    now += 1000 / 60;
    tick?.(now);
  };
  return { frames, frame, running: () => next !== null };
}

test('holding a key glides at a steady pace, releasing it slows down to a stop', () => {
  const { frames, frame, running } = manualFrames();
  let dx = 0;
  let dy = 0;
  const glide = createGlide((x, y) => {
    dx += x;
    dy += y;
  }, frames);
  glide.press('KeyD', false);
  for (let i = 0; i < 60; i++) frame();
  // A second at the pace, less the moment of speeding up.
  expect(dx).toBeGreaterThan(GLIDE_SPEED * 0.85);
  expect(dx).toBeLessThan(GLIDE_SPEED);
  expect(dy).toBe(0);
  glide.release('KeyD');
  const held = dx;
  for (let i = 0; i < 120 && running(); i++) frame();
  expect(running()).toBe(false);
  // It slows down over a short way, not at once and not far.
  expect(dx - held).toBeGreaterThan(50);
  expect(dx - held).toBeLessThan(200);
});

test('Shift is faster, a diagonal is not, and keys lost with the focus stop the glide', () => {
  const { frames, frame, running } = manualFrames();
  let dx = 0;
  let dy = 0;
  const glide = createGlide((x, y) => {
    dx += x;
    dy += y;
  }, frames);
  glide.press('KeyD', true);
  for (let i = 0; i < 60; i++) frame();
  expect(dx).toBeGreaterThan(GLIDE_FAST * 0.85);
  glide.releaseAll();
  for (let i = 0; i < 120 && running(); i++) frame();
  expect(running()).toBe(false);

  dx = 0;
  dy = 0;
  glide.press('KeyW', false);
  glide.press('KeyD', false);
  for (let i = 0; i < 60; i++) frame();
  expect(Math.hypot(dx, dy)).toBeLessThan(GLIDE_SPEED);
  expect([dx > 0, dy < 0]).toEqual([true, true]);
  glide.stop();
  expect(running()).toBe(false);
});

test('a tap, let go before the first frame, still moves the camera a little and smoothly', () => {
  const { frames, frame, running } = manualFrames();
  const moves: number[] = [];
  const glide = createGlide((x) => moves.push(x), frames);
  glide.press('KeyA', false);
  glide.release('KeyA');
  for (let i = 0; i < 120 && running(); i++) frame();
  expect(running()).toBe(false);
  const total = moves.reduce((a, b) => a + b, 0);
  expect(total).toBeLessThan(-80);
  expect(total).toBeGreaterThan(-250);
  // No frame jumps: each moves at most the pace of a frame.
  expect(Math.max(...moves.map(Math.abs))).toBeLessThanOrEqual(GLIDE_SPEED / 60 + 0.01);
});
