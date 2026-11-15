// Undo and redo on the map, as in a design tool: every change made on the map — a screen moved,
// the layout reset, a name, a section, a description, a screen hidden — is a step that knows how to
// go back and forth. Steps run one after another, so a quick series of Ctrl/⌘+Z undoes them in
// order. The history lives in the page: it is gone after a reload.

import { useCallback, useMemo, useRef, useState } from 'react';

import type { Screen, ScreenPatch } from '../shared/types';

export interface Step {
  /** What was done, for the message after undoing or redoing it. */
  label: string;
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
}

export interface Stacks {
  done: Step[];
  undone: Step[];
}

export type Way = 'undo' | 'redo';

/** Steps kept to undo. */
export const HISTORY_LIMIT = 100;

export const emptyStacks: Stacks = { done: [], undone: [] };

/** A new step: it can be undone, and what was undone before can no longer be redone. */
export function pushStep(s: Stacks, step: Step, limit = HISTORY_LIMIT): Stacks {
  return { done: [...s.done, step].slice(-limit), undone: [] };
}

/** The step to undo (or redo) next, and the stacks once it is. */
export function takeStep(s: Stacks, way: Way): { step?: Step; next: Stacks } {
  if (way === 'undo') {
    const step = s.done.at(-1);
    return step ? { step, next: { done: s.done.slice(0, -1), undone: [...s.undone, step] } } : { next: s };
  }
  const step = s.undone.at(-1);
  return step ? { step, next: { done: [...s.done, step], undone: s.undone.slice(0, -1) } } : { next: s };
}

/**
 * Ctrl/⌘+Z undoes, Ctrl/⌘+Shift+Z or Ctrl+Y redoes. By the key's place, not its letter, so the
 * keys work in any keyboard layout.
 */
export function historyKey(e: {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): Way | null {
  if (e.altKey || !(e.ctrlKey || e.metaKey)) return null;
  if (e.code === 'KeyZ') return e.shiftKey ? 'redo' : 'undo';
  if (e.code === 'KeyY' && e.ctrlKey && !e.shiftKey) return 'redo';
  return null;
}

/** The patch that puts back what another patch of the screen changes. */
export function screenBack(screen: Screen, patch: Omit<ScreenPatch, 'key'>): Omit<ScreenPatch, 'key'> {
  const back: Omit<ScreenPatch, 'key'> = {};
  if (patch.name !== undefined) back.name = screen.name;
  if (patch.section !== undefined) back.section = screen.section;
  if (patch.description !== undefined) back.description = screen.description;
  if (patch.hidden !== undefined) back.hidden = screen.hidden;
  if (patch.position || patch.resetPosition) {
    if (screen.position) back.position = screen.position;
    else back.resetPosition = true;
  }
  return back;
}

export interface History {
  push: (step: Step) => void;
  /** Forgets every step: after a change that cannot be taken back, they would not fit the map. */
  clear: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * The history of the map's changes. done reports a step undone or redone; failed — one that could
 * not be: the map is then not what the other steps expect, and the history is cleared.
 */
export function useHistory(done: (way: Way, step: Step) => void, failed: (e: unknown) => void): History {
  const [stacks, setStacks] = useState<Stacks>(emptyStacks);
  const current = useRef(stacks);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const report = useRef({ done, failed });
  report.current = { done, failed };

  const update = useCallback((next: Stacks) => {
    current.current = next;
    setStacks(next);
  }, []);
  const push = useCallback((step: Step) => update(pushStep(current.current, step)), [update]);
  const clear = useCallback(() => update(emptyStacks), [update]);
  const go = useCallback(
    (way: Way) => {
      const { step, next } = takeStep(current.current, way);
      if (!step) return;
      update(next);
      queue.current = queue.current.then(async () => {
        try {
          await step[way]();
          report.current.done(way, step);
        } catch (e) {
          update(emptyStacks);
          report.current.failed(e);
        }
      });
    },
    [update],
  );
  return useMemo(
    () => ({
      push,
      clear,
      undo: () => go('undo'),
      redo: () => go('redo'),
      canUndo: stacks.done.length > 0,
      canRedo: stacks.undone.length > 0,
    }),
    [push, clear, go, stacks],
  );
}
