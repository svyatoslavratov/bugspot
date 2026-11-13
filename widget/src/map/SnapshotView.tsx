import { Button, ButtonGroup, Callout, Card, NonIdealState, Spinner, Switch, Tooltip } from '@blueprintjs/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useWidget } from '../app/context';
import { statusIntent } from '../app/labels';
import { ThreadView } from '../app/ThreadView';
import { useData } from '../app/useData';
import { anchorsOf, buildAnchor, resolveAnchor } from '../lib/anchor';
import { interactiveOf } from '../lib/screen';
import {
  ACTIVE_STATUSES,
  type Edge,
  type ScreenMap,
  type SnapshotData,
  type StateRef,
  type Thread,
} from '../shared/types';
import { useMap } from './context';
import { screenLabel } from './layout';
import { SnapshotComposer, type Picked } from './SnapshotComposer';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Hotspot {
  box: Box;
  edges: Edge[];
  el: Element;
}

const INTERACTIVE = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], summary';

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Puts the stylesheets into the snapshot and restores the scroll positions of its containers. */
function prepare(doc: Document, snap: SnapshotData) {
  for (const style of doc.querySelectorAll('style[data-bugspot-asset]')) {
    style.textContent = snap.css[style.getAttribute('data-bugspot-asset') ?? ''] ?? '';
  }
  for (const el of doc.querySelectorAll('[data-bugspot-scroll]')) {
    const [x, y] = (el.getAttribute('data-bugspot-scroll') ?? '0,0').split(',').map(Number);
    el.scrollLeft = x;
    el.scrollTop = y;
  }
}

export function SnapshotView({
  map,
  view,
  onView,
  onSelect,
  onClose,
  onChanged,
}: {
  map: ScreenMap;
  view: StateRef;
  onView: (ref: StateRef) => void;
  onSelect: (key: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { api, session } = useWidget();
  const { t } = useMap();
  const screen = map.screens.find((s) => s.key === view.screen);
  // The live app in a frame instead of the snapshot: its own address stays while it is used, and
  // the view follows the screen its widget reports.
  const [live, setLive] = useState<{ url: string; heard: boolean; silent: boolean } | null>(null);
  const snap = useData(live ? null : () => api.snapshot(view), [view.screen, view.state, live === null]);
  const [threadsVersion, setThreadsVersion] = useState(0);
  const threads = useData(
    screen
      ? () => api.threads({ screen: screen.key, route: screen.exampleRoute, status: ACTIVE_STATUSES, limit: 100 })
      : null,
    [screen?.key, threadsVersion],
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [height, setHeight] = useState(0);
  const [scale, setScale] = useState(1);
  const [tick, setTick] = useState(0);
  const [showUnknown, setShowUnknown] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [hover, setHover] = useState<Box | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const liveFrame = useRef<HTMLIFrameElement>(null);
  const following = useRef({ view, onView });
  following.current = { view, onView };
  const viewport = snap.data?.viewport ?? { w: 1440, h: 900 };
  const canComment = session.can?.comment ?? false;

  useEffect(() => {
    if (!live?.url) return;
    const onMessage = (ev: MessageEvent) => {
      if (!liveFrame.current || ev.source !== liveFrame.current.contentWindow) return;
      const data = ev.data as { type?: unknown; screen?: unknown; state?: unknown } | null;
      if (data?.type !== 'bugspot:screen' || typeof data.screen !== 'string') return;
      const state = typeof data.state === 'string' ? data.state : '';
      setLive((l) => (l && !l.heard ? { ...l, heard: true, silent: false } : l));
      const { view: now, onView: go } = following.current;
      if (data.screen !== now.screen || state !== now.state) go({ screen: data.screen, state });
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => setLive((l) => (l && !l.heard ? { ...l, silent: true } : l)), 6000);
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
    };
  }, [live?.url]);

  const outgoing = useMemo(
    () =>
      map.edges.filter(
        (e) =>
          e.from.screen === view.screen &&
          e.from.state === view.state &&
          e.via.selector &&
          !e.via.selector.startsWith('declared:'),
      ),
    [map.edges, view.screen, view.state],
  );
  const declared = useMemo(
    () =>
      map.edges.filter(
        (e) =>
          e.from.screen === view.screen &&
          e.from.state === view.state &&
          (!e.via.selector || e.via.selector.startsWith('declared:')),
      ),
    [map.edges, view.screen, view.state],
  );

  // Fit the window width of the snapshot into the stage.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, (el.clientWidth - 32) / viewport.w));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewport.w]);

  const onLoad = useCallback(() => {
    const d = frame.current?.contentDocument;
    if (!d || !snap.data) return;
    prepare(d, snap.data);
    // Fonts and images settle the height a moment later.
    const measure = () => {
      setHeight(Math.max(viewport.h, d.documentElement.scrollHeight));
      setTick((n) => n + 1);
    };
    measure();
    setTimeout(measure, 300);
    setTimeout(measure, 1200);
    d.addEventListener('scroll', () => setTick((n) => n + 1), { capture: true, passive: true });
    setDoc(d);
  }, [snap.data, viewport.h]);

  useEffect(() => {
    setDoc(null);
    setPicked(null);
    setHover(null);
  }, [view.screen, view.state]);

  // Where the transitions of this state start: elements found by the selectors of their edges.
  const hotspots = useMemo<Hotspot[]>(() => {
    if (!doc) return [];
    const byEl = new Map<Element, Edge[]>();
    for (const e of outgoing) {
      let el: Element | null = null;
      try {
        el = doc.querySelector(e.via.selector);
      } catch {
        el = null;
      }
      if (el) byEl.set(el, [...(byEl.get(el) ?? []), e]);
    }
    return [...byEl].map(([el, edges]) => ({ el, edges, box: boxOf(el) }));
    // tick: positions follow scrolling inside the snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, outgoing, tick]);

  const unknown = useMemo<Box[]>(() => {
    if (!doc || !showUnknown) return [];
    const known = new Set(hotspots.map((h) => h.el));
    return [...doc.querySelectorAll(INTERACTIVE)]
      .filter((el) => !known.has(el) && ![...known].some((k) => k.contains(el) || el.contains(k)))
      .map(boxOf)
      .filter((b) => b.w > 0 && b.h > 0);
  }, [doc, hotspots, showUnknown]);

  const pins = useMemo(() => {
    if (!doc) return [];
    return (threads.data?.data ?? []).flatMap((thread) =>
      anchorsOf(thread.anchor).flatMap((anchor) => {
        const el = resolveAnchor(anchor, doc);
        if (!el) return [];
        const r = el.getBoundingClientRect();
        return [
          { thread, x: r.left + (anchor.offset?.x ?? 0.5) * r.width, y: r.top + (anchor.offset?.y ?? 0.5) * r.height },
        ];
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, threads.data, tick]);

  /** Goes where a transition leads: its state's snapshot, else the screen on the map. */
  const follow = useCallback(
    (e: Edge) => {
      const target = map.screens.find((s) => s.key === e.to.screen);
      const state =
        target?.states.find((s) => s.key === e.to.state && s.hasSnapshot) ?? target?.states.find((s) => s.hasSnapshot);
      if (target && state) onView({ screen: target.key, state: state.key });
      else onSelect(e.to.screen);
    },
    [map.screens, onView, onSelect],
  );

  // Clicks inside the snapshot never reach the page they came from: they follow a known
  // transition, or pick an element to comment on.
  useEffect(() => {
    if (!doc) return;
    const onClick = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      const target = ev.target instanceof doc.defaultView!.Element ? (ev.target as Element) : null;
      if (!target) return;
      if (commenting) {
        setPicked({ el: target, point: { x: ev.clientX, y: ev.clientY } });
        setCommenting(false);
        setHover(null);
        return;
      }
      const spot = hotspots.find((h) => h.el === target || h.el.contains(target));
      if (spot) follow(spot.edges[0]);
    };
    const onMove = (ev: MouseEvent) => {
      if (!commenting) return;
      const target = ev.target as Element | null;
      setHover(
        target && target !== doc.body && target !== doc.documentElement ? boxOf(interactiveOf(target) ?? target) : null,
      );
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setCommenting(false);
        setHover(null);
      }
    };
    const onSubmit = (ev: Event) => ev.preventDefault();
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('submit', onSubmit, true);
    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('keydown', onKey, true);
    window.addEventListener('keydown', onKey);
    return () => {
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('submit', onSubmit, true);
      doc.removeEventListener('mousemove', onMove, true);
      doc.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [doc, commenting, hotspots, follow]);

  const states = (screen?.states ?? []).filter((s) => s.hasSnapshot);
  const kindLabel = { page: t.page, tab: t.tab, dialog: t.dialog };
  const px = (b: Box) => ({ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale });

  const created = (thread: Thread) => {
    setPicked(null);
    setNotice(t.sent);
    setTimeout(() => setNotice(null), 4000);
    setThreadsVersion((v) => v + 1);
    setOpenThread(thread.id);
    onChanged();
  };

  return (
    <div className="map-snapshot" role="dialog" aria-label={screen ? screenLabel(screen) : view.screen}>
      <header className="map-toolbar">
        <Button icon="arrow-left" variant="minimal" aria-label={t.close} onClick={onClose} />
        <strong className="map-title">{screen ? screenLabel(screen) : view.screen}</strong>
        {(screen?.exampleUrl || live) && (
          <ButtonGroup>
            <Button icon="media" text={t.snapshot} active={!live} onClick={() => setLive(null)} />
            <Button
              icon="globe-network"
              text={t.live}
              active={!!live}
              onClick={() =>
                !live && screen?.exampleUrl && setLive({ url: screen.exampleUrl, heard: false, silent: false })
              }
            />
          </ButtonGroup>
        )}
        {live && view.state && (
          <span className="map-muted">
            {kindLabel[screen?.states.find((s) => s.key === view.state)?.kind ?? 'page']}:{' '}
            {screen?.states.find((s) => s.key === view.state)?.name ?? view.state}
          </span>
        )}
        <ButtonGroup variant="minimal" className={live ? 'is-hidden' : ''}>
          {states.map((s) => (
            <Button
              key={s.key}
              active={s.key === view.state}
              text={s.key === '' ? t.page : `${kindLabel[s.kind]}: ${s.name}`}
              onClick={() => onView({ screen: view.screen, state: s.key })}
            />
          ))}
        </ButtonGroup>
        <span className="map-push" />
        {!live && (
          <Tooltip content={t.unknownHint} placement="bottom">
            <Switch
              label={t.unknownLinks}
              checked={showUnknown}
              onChange={(e) => setShowUnknown(e.currentTarget.checked)}
            />
          </Tooltip>
        )}
        {canComment && !live && (
          <Button
            icon="comment"
            intent={commenting ? 'primary' : 'none'}
            text={t.comment}
            onClick={() => {
              setPicked(null);
              setCommenting((c) => !c);
            }}
          />
        )}
        {screen?.exampleUrl && (
          <Button
            icon="share"
            variant="minimal"
            text={t.openInApp}
            onClick={() => window.open(screen.exampleUrl, '_blank', 'noopener')}
          />
        )}
      </header>
      {commenting && !live && <div className="map-hint">{t.commentHint}</div>}
      {live && (
        <Callout intent={live.silent ? 'warning' : 'primary'} compact className="map-live-note">
          {live.silent ? t.liveSilent : t.liveHint}
        </Callout>
      )}
      {notice && (
        <Callout intent="success" compact className="map-notice">
          {notice}
        </Callout>
      )}
      <div className="map-snapshot-body">
        <div className="map-stage" ref={stage}>
          {live && (
            <div className="map-frame-box" style={{ width: viewport.w * scale, height: viewport.h * scale }}>
              <iframe
                key={live.url}
                ref={liveFrame}
                title={t.live}
                src={live.url}
                className="map-live"
                style={{ width: viewport.w, height: viewport.h, transform: `scale(${scale})` }}
              />
            </div>
          )}
          {!live && snap.error && <NonIdealState icon="media" title={t.noSnapshot} description={snap.error} />}
          {!live && !snap.data && !snap.error && <Spinner />}
          {!live && snap.data && (
            <div
              className="map-frame-box"
              style={{ width: viewport.w * scale, height: (height || viewport.h) * scale }}
            >
              <iframe
                key={`${view.screen}\u0000${view.state}\u0000${snap.data.capturedAt}`}
                ref={frame}
                title={screen ? screenLabel(screen) : view.screen}
                sandbox="allow-same-origin"
                srcDoc={snap.data.html}
                onLoad={onLoad}
                className={commenting ? 'is-picking' : ''}
                style={{ width: viewport.w, height: height || viewport.h, transform: `scale(${scale})` }}
              />
              <div className="map-overlay">
                {unknown.map((b, i) => (
                  <div key={i} className="map-unknown" style={px(b)} />
                ))}
                {!commenting &&
                  hotspots.map((h, i) => (
                    <div
                      key={i}
                      className={`map-hotspot ${h.edges.every((e) => e.via.kind === 'nav') ? 'is-nav' : ''}`}
                      style={px(h.box)}
                      title={t.hotspotTo(h.edges.map((e) => e.via.name || e.to.screen).join(', '))}
                    />
                  ))}
                {hover && <div className="map-hover" style={px(hover)} />}
                {picked && <div className="map-picked" style={px(boxOf(picked.el))} />}
                {pins.map((p, i) => (
                  <button
                    key={`${p.thread.id}-${i}`}
                    type="button"
                    className={`map-pin intent-${statusIntent[p.thread.status]}`}
                    style={{ left: p.x * scale, top: p.y * scale }}
                    onClick={() => setOpenThread(p.thread.id)}
                  >
                    {p.thread.number}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!live && declared.length > 0 && (
            <div className="map-declared">
              {declared.map((e, i) => (
                <Button
                  key={i}
                  variant="outlined"
                  size="small"
                  icon="link"
                  text={e.via.name || e.to.screen}
                  onClick={() => follow(e)}
                />
              ))}
            </div>
          )}
        </div>
        {(picked || openThread) && (
          <Card className="map-panel map-side" elevation={2}>
            {picked && screen ? (
              <SnapshotComposer
                screen={screen}
                state={view.state}
                picked={{ ...picked, anchor: buildAnchor(picked.el, picked.point) }}
                onCancel={() => setPicked(null)}
                onCreated={created}
              />
            ) : (
              openThread && (
                <ThreadView
                  id={openThread}
                  version={threadsVersion}
                  currentRoute=""
                  onBack={() => setOpenThread(null)}
                  onChanged={() => setThreadsVersion((v) => v + 1)}
                  onGo={(th) => window.open(th.url, '_blank', 'noopener')}
                  onShow={() => undefined}
                />
              )
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
