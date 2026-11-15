// A screen on the canvas as its real DOM snapshot instead of a picture: sharp at any zoom, with the
// pins of its threads, and in the comment mode any element of it can be picked.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { statusIntent } from '../app/labels';
import { useWidget } from '../app/context';
import { anchorsOf, resolveAnchor } from '../lib/anchor';
import { interactiveOf } from '../lib/screen';
import type { Api } from '../shared/api';
import { ACTIVE_STATUSES, type Screen, type ScreenState, type SnapshotData, type Thread } from '../shared/types';
import { useCanvas } from './canvas';
import { boxOf, prepare, type Box } from './snapshotDom';

const snapshots = new Map<string, Promise<SnapshotData>>();
const threadLists = new Map<string, Promise<Thread[]>>();

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let pending = cache.get(key);
  if (!pending) {
    pending = load();
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  return pending;
}

function useLoaded<T>(key: string | null, load: () => Promise<T>): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    load().then(
      (v) => alive && setValue(v),
      () => alive && setValue(null),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return value;
}

function threadsOf(api: Api, screen: Screen, version: number) {
  return cached(threadLists, `${screen.key}\u0000${version}`, () =>
    api
      .threads({ screen: screen.key, route: screen.exampleRoute, status: ACTIVE_STATUSES, limit: 100 })
      .then((p) => p.data),
  );
}

export function LiveShot({ screen, state }: { screen: Screen; state: ScreenState }) {
  const { api } = useWidget();
  const { commenting, version, onPick, onOpenThread, onEscape } = useCanvas();
  const ref = { screen: screen.key, state: state.key };
  const snapKey = `${screen.key}\u0000${state.key}\u0000${state.capturedAt ?? ''}`;
  const snap = useLoaded(snapKey, () => cached(snapshots, snapKey, () => api.snapshot(ref)));
  const threads = useLoaded(`${screen.key}\u0000${version}`, () => threadsOf(api, screen, version));
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [doc, setDoc] = useState<Document | null>(null);
  const [hover, setHover] = useState<Box | null>(null);
  const [tick, setTick] = useState(0);
  const vw = snap?.viewport.w || 1440;
  const vh = snap?.viewport.h || 900;
  const scale = width / vw;

  // The box is measured without the zoom of the canvas: offsetWidth ignores transforms.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onLoad = useCallback(
    (e: React.SyntheticEvent<HTMLIFrameElement>) => {
      const d = e.currentTarget.contentDocument;
      if (!d || !snap) return;
      prepare(d, snap);
      setDoc(d);
      // Fonts and images move elements a moment later: the pins follow.
      setTimeout(() => setTick((n) => n + 1), 400);
    },
    [snap],
  );

  useEffect(() => {
    if (!doc || !commenting) {
      setHover(null);
      return;
    }
    const onMove = (ev: MouseEvent) => {
      const target = ev.target instanceof doc.defaultView!.Element ? (ev.target as Element) : null;
      setHover(
        target && target !== doc.body && target !== doc.documentElement ? boxOf(interactiveOf(target) ?? target) : null,
      );
    };
    const onClick = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      const target = ev.target instanceof doc.defaultView!.Element ? (ev.target as Element) : null;
      if (target) onPick({ screen: screen.key, state: state.key, el: target, point: { x: ev.clientX, y: ev.clientY } });
    };
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && onEscape();
    const onLeave = () => setHover(null);
    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('mouseleave', onLeave);
    return () => {
      doc.removeEventListener('mousemove', onMove, true);
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('mouseleave', onLeave);
    };
  }, [doc, commenting, onPick, onEscape, screen.key, state.key]);

  const pins = (threads ?? []).flatMap((thread) => {
    if (!doc) return [];
    return anchorsOf(thread.anchor)
      .filter((a) => !a.state || a.state === state.key)
      .flatMap((anchor) => {
        const el = resolveAnchor(anchor, doc);
        if (!el) return [];
        const r = el.getBoundingClientRect();
        if (r.top > vh) return [];
        return [
          { thread, x: r.left + (anchor.offset?.x ?? 0.5) * r.width, y: r.top + (anchor.offset?.y ?? 0.5) * r.height },
        ];
      });
  });
  void tick;

  return (
    <div ref={box} className={`map-thumb map-live ${commenting ? 'is-commenting nodrag nopan' : ''}`}>
      {snap && width > 0 && (
        <iframe
          key={snapKey}
          title={screen.name || screen.title || screen.key}
          sandbox="allow-same-origin"
          srcDoc={snap.html}
          onLoad={onLoad}
          tabIndex={-1}
          style={{ width: vw, height: vh, transform: `scale(${scale})` }}
        />
      )}
      <div className="map-overlay">
        {hover && (
          <div
            className="map-hover"
            style={{ left: hover.x * scale, top: hover.y * scale, width: hover.w * scale, height: hover.h * scale }}
          />
        )}
        {pins.map((p, i) => (
          <button
            key={`${p.thread.id}-${i}`}
            type="button"
            className={`map-pin is-small intent-${statusIntent[p.thread.status]} nodrag`}
            style={{ left: p.x * scale, top: p.y * scale }}
            title={p.thread.body}
            onClick={(e) => {
              e.stopPropagation();
              onOpenThread(screen.key, p.thread.id);
            }}
          >
            {p.thread.number}
          </button>
        ))}
      </div>
    </div>
  );
}
