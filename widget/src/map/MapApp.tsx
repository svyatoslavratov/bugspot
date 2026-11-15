// The screen map page: the canvas of screens, the toolbar, the panel of a screen, the full view of
// a state. The canvas works like a design tool: screens at their real size, names and arrows the
// same size on screen at any zoom, panning by dragging, the wheel or the keyboard, zoom with
// Ctrl/⌘ or a pinch, and comments right on the screens.

import {
  Button,
  Callout,
  Card,
  Checkbox,
  Divider,
  HTMLSelect,
  Icon,
  InputGroup,
  Menu,
  MenuItem,
  NonIdealState,
  Popover,
  Spinner,
  Tooltip,
} from '@blueprintjs/core';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge as FlowEdge,
  type Node,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { useWidget } from '../app/context';
import { buildAnchor } from '../lib/anchor';
import { DEFAULT_HOTKEY, isMac, matchesHotkey, parseHotkey } from '../lib/hotkey';
import { LANG_NAMES, type LangChoice } from '../lib/i18n';
import { loadPrefs } from '../lib/prefs';
import { useData } from '../app/useData';
import type { ScreenMap, ScreenPatch, StateRef } from '../shared/types';
import { CanvasContext, type Canvas, type CanvasPick } from './canvas';
import { useMap } from './context';
import { edgeTypes, focusCss, type RoutedEdgeData } from './edges';
import { historyKey, screenBack, useHistory } from './history';
import { typing, useGlide } from './keyboard';
import {
  coverOf,
  crawlAddress,
  defaultFilters,
  layoutMap,
  linksByDefault,
  screenLabel,
  withTabs,
  type EdgeKind,
  type Layout,
  type MapFilters,
} from './layout';
import { ManifestDialog } from './ManifestDialog';
import { LIVE_WIDTH, nodeTypes, type ScreenNodeData, type SectionNodeData, type TabsNodeData } from './nodes';
import { ScreenPanel } from './ScreenPanel';
import { SnapshotComposer } from './SnapshotComposer';
import { SnapshotView } from './SnapshotView';

const edgeColor: Record<EdgeKind, string> = {
  observed: '#2d72d2',
  declared: '#7961db',
  link: '#8f99a8',
  nav: '#abb3bf',
  tab: '#4c90f0',
};

const miniColor: Record<string, string> = { section: '#eef0f3', tabs: '#dce6f5', screen: '#abb3bf' };

/** The selection lives in the hash, so a link to the map can open a screen: #screen=/campaigns. */
function readHash(): { screen: string | null; view: StateRef | null } {
  const params = new URLSearchParams(location.hash.slice(1));
  const screen = params.get('screen');
  const state = params.get('state');
  return { screen, view: screen && state !== null ? { screen, state } : null };
}

function writeHash(screen: string | null, view: StateRef | null) {
  const params = new URLSearchParams();
  if (screen) params.set('screen', screen);
  if (view) params.set('state', view.state);
  const hash = params.toString();
  history.replaceState(history.state, '', hash ? `#${hash}` : location.pathname + location.search);
}

const prefDefaults = { mode: 'full' as const, hotkey: DEFAULT_HOTKEY };
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 4;

export function MapApp() {
  return (
    <ReactFlowProvider>
      <MapCanvas />
    </ReactFlowProvider>
  );
}

function MapCanvas() {
  const { api, session, t: wt } = useWidget();
  const { t, choice, setChoice } = useMap();
  const flow = useReactFlow();
  const canEdit = session.can?.map ?? false;
  const canComment = session.can?.comment ?? false;
  const [version, setVersion] = useState(0);
  const map = useData(() => api.map(), [version]);
  const [filters, setFilters] = useState<MapFilters>(defaultFilters);
  const [selected, setSelected] = useState<string | null>(() => readHash().screen);
  const [hovered, setHovered] = useState<string | null>(null);
  const [view, setView] = useState<StateRef | null>(() => readHash().view);
  const [commenting, setCommenting] = useState(false);
  const [pick, setPick] = useState<CanvasPick | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [pinsVersion, setPinsVersion] = useState(0);
  const [manifest, setManifest] = useState(false);
  const [message, setMessage] = useState<{ intent: 'success' | 'danger' | 'primary'; text: string } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const messageTimer = useRef(0);
  const say = useCallback((intent: 'success' | 'danger' | 'primary', text: string, ms = 8000) => {
    setMessage({ intent, text });
    clearTimeout(messageTimer.current);
    messageTimer.current = window.setTimeout(() => setMessage(null), ms);
  }, []);
  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // Undo and redo of what was changed on the map: each change below is a step of this history.
  const history = useHistory(
    (way, step) => say('primary', (way === 'undo' ? t.undone : t.redone)(step.label), 4000),
    (e) => say('danger', t.historyError(errorText(e))),
  );
  const { push: remember, clear: forget } = history;
  /** Makes a change on the map and remembers how to take it back. */
  const edit = useCallback(
    async (label: string, apply: () => Promise<unknown>, revert: () => Promise<unknown>) => {
      try {
        await apply();
      } finally {
        reload();
      }
      remember({ label, undo: () => revert().finally(reload), redo: () => apply().finally(reload) });
    },
    [remember, reload],
  );

  useEffect(() => writeHash(selected, view), [selected, view]);
  // A link to another screen opened in this tab (only the hash changes): follow it.
  useEffect(() => {
    const onHash = () => {
      const next = readHash();
      setSelected(next.screen);
      setView(next.view);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Tabs that have addresses of their own are told apart by their tabs' names.
  const data: ScreenMap | undefined = useMemo(() => map.data && withTabs(map.data), [map.data]);
  const dataRef = useRef(data);
  dataRef.current = data;
  // A crawled app has links from every page to many: they start hidden there, the clicks show.
  const linksDecided = useRef(false);
  useEffect(() => {
    if (!data || linksDecided.current) return;
    linksDecided.current = true;
    if (!linksByDefault(data)) setFilters((f) => ({ ...f, showLinks: false }));
  }, [data]);

  // The layout is computed by ELK in a worker; the old one stays on screen meanwhile.
  const [layout, setLayout] = useState<Layout | null>(null);
  const [laying, setLaying] = useState(false);
  useEffect(() => {
    if (!data) return;
    let alive = true;
    setLaying(true);
    layoutMap(data, filters, t.noSection).then(
      (l) => {
        if (!alive) return;
        setLayout(l);
        setLaying(false);
      },
      () => alive && setLaying(false),
    );
    return () => {
      alive = false;
    };
  }, [data, filters, t.noSection]);
  const roles = useMemo(() => [...new Set(data?.screens.flatMap((s) => s.roles) ?? [])].sort(), [data]);
  // Short ids for the class names of edges: the focus stylesheet picks them by these.
  const ids = useMemo(() => new Map((layout?.screens ?? []).map((p, i) => [p.screen.key, `n${i}`])), [layout]);
  const placedOf = useMemo(() => new Map((layout?.screens ?? []).map((p) => [p.screen.key, p])), [layout]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const fitted = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    if (!layout) return;
    const sectionNodes: Node<SectionNodeData>[] = layout.sections.map((s) => ({
      id: `section:${s.name}`,
      type: 'section',
      position: { x: s.x, y: s.y },
      data: { name: s.name, auto: s.auto },
      style: { width: s.w, height: s.h },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
    }));
    const groupNodes: Node<TabsNodeData>[] = layout.groups.map((g) => ({
      id: g.id,
      type: 'tabs',
      position: { x: g.x, y: g.y },
      data: { title: g.title, count: g.count },
      style: { width: g.w, height: g.h },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
    }));
    const screenNodes: Node<ScreenNodeData>[] = layout.screens.map((p) => ({
      id: p.screen.key,
      type: 'screen',
      position: { x: p.x, y: p.y },
      data: {
        screen: p.screen,
        // In a group the box tells the page: a tab goes by its tab's name.
        label: p.inGroup ? p.screen.name || p.screen.tab || screenLabel(p.screen) : screenLabel(p.screen),
        threads: p.threads,
        dim: p.dim,
        w: p.w,
        h: p.h,
      },
      style: { width: p.w, height: p.h },
      selected: p.screen.key === selectedRef.current,
      draggable: false,
    }));
    setNodes([...sectionNodes, ...groupNodes, ...screenNodes]);
    if (!fitted.current) {
      fitted.current = true;
      const focus =
        selectedRef.current && placedOf.has(selectedRef.current) ? [{ id: selectedRef.current }] : undefined;
      requestAnimationFrame(() => void flow.fitView({ padding: 0.06, nodes: focus, maxZoom: focus ? 0.6 : 1 }));
    }
  }, [layout, setNodes, flow, placedOf]);
  // The selection changes only the two nodes it concerns.
  useEffect(() => {
    setNodes((ns) =>
      ns.map((n) =>
        n.type !== 'screen' || !!n.selected === (n.id === selected) ? n : { ...n, selected: n.id === selected },
      ),
    );
  }, [selected, setNodes]);

  // Edges do not depend on the focus: the stylesheet below makes the focused ones stand out.
  const edges = useMemo<FlowEdge<RoutedEdgeData>[]>(
    () =>
      (layout?.edges ?? []).map((e) => {
        const ends = `f-${ids.get(e.from)} t-${ids.get(e.to)}`;
        return {
          id: e.id,
          type: 'routed' as const,
          source: e.from,
          target: e.to,
          label: e.label || undefined,
          className: `kind-${e.kind} ${ends} ${e.points ? '' : 'is-cross'}`,
          data: {
            points: e.points,
            labelAt: e.labelAt,
            ends,
            width: e.kind === 'observed' ? 1.5 + Math.min(1.5, Math.log2(1 + e.count) / 2) : 1.25,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor[e.kind], width: 10, height: 10 },
          style: { stroke: edgeColor[e.kind] },
          focusable: false,
        };
      }),
    [layout, ids],
  );
  const focus = hovered ?? selected;
  const dense = (layout?.edges.length ?? 0) > 40;

  // Names, counters and arrows stay the same size on screen: CSS divides by the zoom. Far out the
  // names of arrows would cover the screens: they show from a quarter of the real size.
  const setZoom = useCallback((zoom: number) => {
    const el = canvasRef.current;
    if (!el) return;
    el.style.setProperty('--z', String(zoom));
    el.dataset.far = zoom < 0.25 ? 'true' : 'false';
  }, []);

  // Ctrl/⌘ with the wheel or a pinch zooms around the pointer at a steady pace: a notch of a mouse
  // wheel about a quarter, not the fourfold jump the canvas makes of it as of a pinch.
  const ready = !!data;
  useEffect(() => {
    const el = canvasRef.current;
    if (!ready || !el) return;
    const onWheel = (e: WheelEvent) => {
      const pane = el.querySelector('.react-flow');
      if ((!e.ctrlKey && !e.metaKey) || !pane?.contains(e.target as globalThis.Node)) return;
      e.preventDefault();
      e.stopPropagation();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const step = Math.max(-0.35, Math.min(0.35, -e.deltaY * unit * 0.015));
      const vp = flow.getViewport();
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, vp.zoom * 2 ** step));
      const box = pane.getBoundingClientRect();
      const px = e.clientX - box.left;
      const py = e.clientY - box.top;
      void flow.setViewport({
        x: px - ((px - vp.x) * zoom) / vp.zoom,
        y: py - ((py - vp.y) * zoom) / vp.zoom,
        zoom,
      });
    };
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, [ready, flow]);

  // A screen moves when its name is dragged (the rest of it pans the canvas); a click that shakes
  // it a little does not count.
  const startMove = useCallback(
    (e: ReactPointerEvent, id: string) => {
      const node = flow.getNode(id);
      if (e.button !== 0 || !node) return;
      e.stopPropagation();
      const start = { x: e.clientX, y: e.clientY };
      const origin = { ...node.position };
      let at = origin;
      let frame = 0;
      const onMove = (ev: PointerEvent) => {
        const zoom = flow.getZoom();
        at = { x: origin.x + (ev.clientX - start.x) / zoom, y: origin.y + (ev.clientY - start.y) / zoom };
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() =>
          setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, position: at } : n))),
        );
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        const screen = dataRef.current?.screens.find((s) => s.key === id);
        const to = { x: Math.round(at.x), y: Math.round(at.y) };
        const back = screen ? screenBack(screen, { position: to }) : { resetPosition: true };
        edit(
          t.stepMove(screen ? screenLabel(screen) : id),
          () => api.patchScreens([{ key: id, position: to }]),
          () => api.patchScreens([{ key: id, ...back }]),
        ).catch((err: unknown) => say('danger', errorText(err)));
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [flow, setNodes, api, edit, t, say],
  );

  // Comments right on the canvas: a close screen shows its live snapshot, and an element picked in
  // it gets a thread — the same thread the real page pins.
  const stopCommenting = useCallback(() => {
    setCommenting(false);
    setPick(null);
  }, []);
  const canvas = useMemo<Canvas>(
    () => ({
      commenting,
      version: pinsVersion,
      onPick: (p) => {
        setPick(p);
        setSelected(p.screen);
      },
      onOpenThread: (key, id) => {
        setPick(null);
        setSelected(key);
        setOpenThread(id);
      },
      onEscape: stopCommenting,
      onMoveStart: canEdit && !commenting ? startMove : undefined,
    }),
    [commenting, pinsVersion, stopCommenting, canEdit, startMove],
  );
  /** Brings a screen close enough to be live: it fills most of the window. */
  const zoomTo = useCallback(
    (id: string) => void flow.fitView({ nodes: [{ id }], duration: 400, padding: 0.12, maxZoom: 1.5 }),
    [flow],
  );
  /** Goes to a screen at the current zoom. */
  const goTo = useCallback(
    (id: string) => {
      setSelected(id);
      setOpenThread(null);
      const p = placedOf.get(id);
      if (p) void flow.setCenter(p.x + p.w / 2, p.y + p.h / 2, { zoom: flow.getZoom(), duration: 400 });
    },
    [flow, placedOf],
  );

  // The keyboard: arrows or WASD glide around while held, + and − zoom, Shift+1 shows the map,
  // Shift+2 the selected screen, C (or the widget's shortcut) toggles comments, Esc leaves.
  useGlide(flow, !view && !manifest);
  useEffect(() => {
    const hotkey = parseHotkey(loadPrefs(prefDefaults).hotkey);
    const onKey = (e: KeyboardEvent) => {
      if (view || manifest || typing(e.target)) return;
      // In a field Ctrl/⌘+Z undoes the typing there; elsewhere a change of the map.
      const way = historyKey(e);
      if (way) {
        e.preventDefault();
        if (canEdit) history[way]();
        return;
      }
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (canComment && ((hotkey && matchesHotkey(e, hotkey)) || (plain && !e.shiftKey && e.code === 'KeyC'))) {
        e.preventDefault();
        setCommenting((c) => !c);
        setPick(null);
      } else if (e.key === 'Escape') {
        if (commenting) stopCommenting();
        else setSelected(null);
      } else if (plain && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
        e.preventDefault();
        void flow.zoomIn({ duration: 150 });
      } else if (plain && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        e.preventDefault();
        void flow.zoomOut({ duration: 150 });
      } else if (e.shiftKey && plain && e.code === 'Digit1') {
        e.preventDefault();
        void flow.fitView({ padding: 0.06, duration: 300 });
      } else if (e.shiftKey && plain && e.code === 'Digit2' && selected) {
        e.preventDefault();
        zoomTo(selected);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, manifest, canComment, canEdit, history, commenting, stopCommenting, flow, selected, zoomTo]);

  const screen = data?.screens.find((s) => s.key === selected) ?? null;
  const pickScreen = pick ? (data?.screens.find((s) => s.key === pick.screen) ?? null) : null;
  const set = <K extends keyof MapFilters>(key: K, value: MapFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const moved = data?.screens.filter((s) => s.position) ?? [];
  const resetLayout = async () => {
    const inBatches = (patches: ScreenPatch[]) => async () => {
      for (let i = 0; i < patches.length; i += 200) await api.patchScreens(patches.slice(i, i + 200));
    };
    try {
      await edit(
        t.stepReset(moved.length),
        inBatches(moved.map((s) => ({ key: s.key, resetPosition: true }))),
        inBatches(moved.map((s) => ({ key: s.key, position: s.position }))),
      );
    } catch (e) {
      say('danger', errorText(e));
    }
  };
  const mac = isMac();
  const crawlUrl = data ? crawlAddress(data) : null;
  const shown = [filters.showLinks, filters.showNav, filters.showHidden].filter(Boolean).length;

  if (map.error && !data) {
    return (
      <NonIdealState
        icon="error"
        title={t.loadError}
        description={map.error}
        action={<Button text={t.retry} onClick={map.reload} />}
      />
    );
  }
  if (!data) return <NonIdealState icon={<Spinner />} title={t.loading} />;

  return (
    <div className="map-page">
      <header className="map-toolbar">
        <strong className="map-title">{t.title}</strong>
        <InputGroup
          className="map-search"
          leftIcon="search"
          placeholder={t.search}
          value={filters.search}
          onValueChange={(v) => set('search', v)}
        />
        {roles.length > 0 && (
          <Tooltip content={t.rolesHint} placement="bottom" className="map-roles">
            <HTMLSelect value={filters.role} onChange={(e) => set('role', e.currentTarget.value)}>
              <option value="">{t.allRoles}</option>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </HTMLSelect>
          </Tooltip>
        )}
        <Popover
          placement="bottom-start"
          content={
            <div className="map-show">
              {(
                [
                  ['showLinks', t.showLinks, t.showLinksHint],
                  ['showNav', t.showNav, t.showNavHint],
                  ['showHidden', t.showHidden, t.showHiddenHint],
                ] as const
              ).map(([key, label, hint]) => (
                <Checkbox
                  key={key}
                  checked={filters[key]}
                  onChange={(e) => set(key, e.currentTarget.checked)}
                  labelElement={
                    <span className="map-show-item">
                      <strong>{label}</strong>
                      <span>{hint}</span>
                    </span>
                  }
                />
              ))}
              <Divider />
              <div className="map-label">{t.legend}</div>
              <ul className="map-legend">
                {(
                  [
                    ['observed', t.legendObserved],
                    ['declared', t.legendDeclared],
                    ['link', t.legendLink],
                    ['nav', t.legendNav],
                  ] as const
                ).map(([kind, text]) => (
                  <li key={kind}>
                    <svg width="36" height="8" aria-hidden="true">
                      <line
                        x1="0"
                        y1="4"
                        x2="36"
                        y2="4"
                        className={`map-legend-line kind-${kind}`}
                        stroke={edgeColor[kind]}
                      />
                    </svg>
                    {text}
                  </li>
                ))}
              </ul>
            </div>
          }
        >
          <Button icon="filter" endIcon="caret-down" text={shown ? `${t.show} · ${shown}` : t.show} />
        </Popover>
        {laying && layout && (
          <span className="map-busy">
            <Spinner size={14} /> {t.layingOut}
          </span>
        )}
        <span className="map-push" />
        {canComment && (
          <Tooltip content={t.commentCanvasHint} placement="bottom">
            <Button
              icon="comment"
              intent={commenting ? 'primary' : 'none'}
              text={t.comment}
              active={commenting}
              onClick={() => (commenting ? stopCommenting() : setCommenting(true))}
            />
          </Tooltip>
        )}
        <Tooltip content={crawlUrl ? t.crawl : t.crawlNoApp} placement="bottom">
          <Button
            icon="path-search"
            text={t.buildMap}
            disabled={!crawlUrl}
            onClick={() => crawlUrl && window.open(crawlUrl, '_blank', 'noopener')}
          />
        </Tooltip>
        {canEdit && moved.length > 0 && (
          <Tooltip content={t.resetLayoutHint} placement="bottom">
            <Button icon="layout-auto" text={t.resetLayout} onClick={() => void resetLayout()} />
          </Tooltip>
        )}
        <Button icon="document" text={t.manifest} onClick={() => setManifest(true)} />
        {canEdit && (
          <>
            <Tooltip content={`${t.undo} · ${mac ? '⌘Z' : 'Ctrl+Z'}`} placement="bottom">
              <Button
                icon="undo"
                variant="minimal"
                aria-label={t.undo}
                disabled={!history.canUndo}
                onClick={history.undo}
              />
            </Tooltip>
            <Tooltip content={`${t.redo} · ${mac ? '⇧⌘Z' : 'Ctrl+Y'}`} placement="bottom">
              <Button
                icon="redo"
                variant="minimal"
                aria-label={t.redo}
                disabled={!history.canRedo}
                onClick={history.redo}
              />
            </Tooltip>
          </>
        )}
        <Button
          icon="refresh"
          variant="minimal"
          aria-label={t.refresh}
          title={t.refresh}
          loading={map.loading}
          onClick={reload}
        />
        <Popover
          placement="bottom-end"
          content={
            <table className="map-keys">
              <tbody>
                {t.keysList.map(([keys, what]) => (
                  <tr key={keys}>
                    <th>{keys}</th>
                    <td>{what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        >
          <Button icon="help" variant="minimal" aria-label={t.keys} title={t.keys} />
        </Popover>
        <Popover
          placement="bottom-end"
          content={
            <Menu>
              <MenuItem icon="translate" text={wt.language} disabled />
              {(['auto', 'ru', 'en'] as LangChoice[]).map((c) => (
                <MenuItem
                  key={c}
                  roleStructure="listoption"
                  selected={choice === c}
                  text={c === 'auto' ? wt.languageAuto : LANG_NAMES[c]}
                  onClick={() => setChoice(c)}
                />
              ))}
            </Menu>
          }
        >
          <Button icon="cog" variant="minimal" aria-label={t.settings} title={t.settings} />
        </Popover>
      </header>
      {commenting && !pick && (
        <div className="map-hint">
          <Icon icon="comment" size={12} /> {t.commentCanvasHint}
        </div>
      )}
      {message && (
        <Callout intent={message.intent} compact className="map-notice map-message">
          {message.text}
        </Callout>
      )}
      <div ref={canvasRef} className={`map-body ${commenting ? 'is-commenting' : ''}`} style={{ ['--z' as string]: 1 }}>
        {data.screens.length === 0 ? (
          <NonIdealState icon="layers" title={t.empty} description={t.emptyHint} />
        ) : !layout ? (
          <NonIdealState icon={<Spinner />} title={t.layingOut} />
        ) : (
          <CanvasContext.Provider value={canvas}>
            <style>{focusCss(focus ? (ids.get(focus) ?? null) : null)}</style>
            <ReactFlow
              className={`map-flow ${dense ? 'is-dense' : ''} ${!focus && !dense ? 'show-labels' : ''}`}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              nodesDraggable={false}
              nodesConnectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              elementsSelectable={false}
              disableKeyboardA11y
              deleteKeyCode={null}
              selectionKeyCode={null}
              multiSelectionKeyCode={null}
              onlyRenderVisibleElements
              panOnScroll
              zoomOnScroll={false}
              zoomOnPinch
              zoomOnDoubleClick={false}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              onInit={(instance) => setZoom(instance.getZoom())}
              onMove={(_, vp) => setZoom(vp.zoom)}
              onNodeClick={(_, node) => {
                if (node.type !== 'screen') return;
                setSelected(node.id);
                setOpenThread(null);
                // In the comment mode a screen too far to pick from comes close.
                const p = placedOf.get(node.id);
                if (commenting && p && flow.getZoom() * p.w < LIVE_WIDTH) zoomTo(node.id);
              }}
              onNodeMouseEnter={(_, node) => node.type === 'screen' && setHovered(node.id)}
              onNodeMouseLeave={() => setHovered(null)}
              onNodeDoubleClick={(_, node) => {
                const sc = data.screens.find((s) => s.key === node.id);
                const state = sc && coverOf(sc, 'hasSnapshot');
                if (sc && state) setView({ screen: sc.key, state: state.key });
              }}
              onPaneClick={() => {
                setSelected(null);
                setPick(null);
              }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor={(n) => miniColor[n.type ?? 'screen'] ?? '#abb3bf'} />
            </ReactFlow>
          </CanvasContext.Provider>
        )}
        {pick && pickScreen ? (
          <Card className="map-panel" elevation={2}>
            <SnapshotComposer
              key={`${pick.screen}\u0000${pick.point.x}:${pick.point.y}`}
              screen={pickScreen}
              state={pick.state}
              picked={{ el: pick.el, point: pick.point, anchor: buildAnchor(pick.el, pick.point) }}
              onCancel={() => setPick(null)}
              onCreated={(thread) => {
                setPick(null);
                setPinsVersion((v) => v + 1);
                setSelected(pick.screen);
                setOpenThread(thread.id);
                say('success', t.sent);
                reload();
              }}
            />
          </Card>
        ) : (
          screen && (
            <ScreenPanel
              key={`${screen.key}\u0000${openThread ?? ''}`}
              map={data}
              screen={screen}
              version={version}
              showNav={filters.showNav}
              thread={openThread}
              onClose={() => {
                setSelected(null);
                setOpenThread(null);
              }}
              onSelect={goTo}
              onOpen={(state) => setView({ screen: screen.key, state })}
              onChanged={() => {
                setPinsVersion((v) => v + 1);
                reload();
              }}
              onEdit={edit}
              onMerged={(target) => {
                // A merge is not undone: the steps before it may name a screen that is gone.
                forget();
                setPinsVersion((v) => v + 1);
                reload();
                goTo(target);
              }}
            />
          )
        )}
      </div>
      {view && (
        <SnapshotView
          map={data}
          view={view}
          onView={(v) => {
            setView(v);
            // The panel and the address follow the screen the view went to.
            setSelected(v.screen);
          }}
          onSelect={(key) => {
            setView(null);
            setSelected(key);
          }}
          onClose={() => setView(null)}
          onChanged={reload}
        />
      )}
      {manifest && (
        <ManifestDialog
          onClose={() => setManifest(false)}
          onImported={() => {
            forget();
            reload();
          }}
        />
      )}
    </div>
  );
}
