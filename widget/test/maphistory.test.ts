import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  emptyStacks,
  historyKey,
  pushStep,
  screenBack,
  takeStep,
  useHistory,
  type History,
  type Step,
} from '../src/map/history';
import type { Screen } from '../src/shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (label: string, log: string[] = []): Step => ({
  label,
  undo: async () => void log.push(`undo ${label}`),
  redo: async () => void log.push(`redo ${label}`),
});

test('steps: undo takes the last one, redo brings it back, a new step forgets what was undone', () => {
  let s = pushStep(pushStep(emptyStacks, step('a')), step('b'));
  const undone = takeStep(s, 'undo');
  expect(undone.step?.label).toBe('b');
  s = undone.next;
  expect(s.done.map((x) => x.label)).toEqual(['a']);
  expect(s.undone.map((x) => x.label)).toEqual(['b']);
  const redone = takeStep(s, 'redo');
  expect(redone.step?.label).toBe('b');
  expect(redone.next.done.map((x) => x.label)).toEqual(['a', 'b']);
  // A new change after an undo: the undone step cannot be redone any more.
  s = pushStep(s, step('c'));
  expect(s.undone).toEqual([]);
  expect(takeStep(emptyStacks, 'undo').step).toBeUndefined();
  // Only the last steps are kept.
  let many = emptyStacks;
  for (let i = 0; i < 5; i++) many = pushStep(many, step(String(i)), 3);
  expect(many.done.map((x) => x.label)).toEqual(['2', '3', '4']);
});

test('keys: Ctrl/⌘+Z undoes, with Shift or Ctrl+Y redoes, in any keyboard layout', () => {
  const key = (code: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>>) =>
    historyKey({ code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
  expect(key('KeyZ', { ctrlKey: true })).toBe('undo');
  expect(key('KeyZ', { metaKey: true })).toBe('undo');
  expect(key('KeyZ', { metaKey: true, shiftKey: true })).toBe('redo');
  expect(key('KeyZ', { ctrlKey: true, shiftKey: true })).toBe('redo');
  expect(key('KeyY', { ctrlKey: true })).toBe('redo');
  expect(key('KeyY', { metaKey: true })).toBeNull();
  expect(key('KeyZ', {})).toBeNull();
  expect(key('KeyZ', { ctrlKey: true, altKey: true })).toBeNull();
});

test('the way back of a change: the old values, and the layout for a screen it placed itself', () => {
  const screen = {
    key: '/a',
    name: 'Old',
    section: '',
    description: 'Why',
    hidden: false,
    position: undefined,
  } as unknown as Screen;
  expect(screenBack(screen, { name: 'New', section: 'S' })).toEqual({ name: 'Old', section: '' });
  expect(screenBack(screen, { hidden: true, description: '' })).toEqual({ hidden: false, description: 'Why' });
  expect(screenBack(screen, { position: { x: 1, y: 2 } })).toEqual({ resetPosition: true });
  expect(screenBack({ ...screen, position: { x: 5, y: 6 } }, { position: { x: 1, y: 2 } })).toEqual({
    position: { x: 5, y: 6 },
  });
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

function mount(done: (way: string, s: Step) => void, failed: (e: unknown) => void): { current: History } {
  const ref = {} as { current: History };
  function Probe() {
    ref.current = useHistory(done, failed);
    return null;
  }
  act(() => root.render(createElement(Probe)));
  return ref;
}

test('a quick series of undos runs one after another, in order; a failed one clears the history', async () => {
  const log: string[] = [];
  const done = vi.fn();
  const failed = vi.fn();
  const history = mount(done, failed);
  act(() => {
    history.current.push(step('a', log));
    history.current.push(step('b', log));
  });
  expect(history.current.canUndo).toBe(true);
  await act(async () => {
    history.current.undo();
    history.current.undo();
    history.current.undo(); // nothing left: ignored
  });
  expect(log).toEqual(['undo b', 'undo a']);
  expect(done.mock.calls.map(([way, s]) => `${way} ${(s as Step).label}`)).toEqual(['undo b', 'undo a']);
  expect([history.current.canUndo, history.current.canRedo]).toEqual([false, true]);
  await act(async () => history.current.redo());
  expect(log.at(-1)).toBe('redo a');

  const broken: Step = { label: 'x', undo: () => Promise.reject(new Error('offline')), redo: async () => undefined };
  act(() => history.current.push(broken));
  await act(async () => history.current.undo());
  expect(failed).toHaveBeenCalledWith(new Error('offline'));
  expect([history.current.canUndo, history.current.canRedo]).toEqual([false, false]);
});
