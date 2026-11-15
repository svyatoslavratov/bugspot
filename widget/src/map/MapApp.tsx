import {
  Button,
  Callout,
  Card,
  HTMLSelect,
  InputGroup,
  Menu,
  MenuDivider,
  MenuItem,
  NonIdealState,
  Popover,
  Spinner,
  Switch,
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useWidget } from '../app/context';
import { buildAnchor } from '../lib/anchor';
import { useData } from '../app/useData';
import type { ScreenMap, StateRef } from '../shared/types';
import { CanvasContext, type Canvas, type CanvasPick } from './canvas';
import { useMap } from './context';
import {
  crawlAddress,
  defaultFilters,
  layoutMap,
  linksByDefault,
  NODE_H,
  NODE_W,
  type EdgeKind,
  type Layout,
  type MapFilters,
} from './layout';
import { edgeTypes, type RoutedEdgeData } from './edges';
import { LIVE_ZOOM, nodeTypes, type ScreenNodeData, type SectionNodeData } from './nodes';
import { SnapshotComposer } from './SnapshotComposer';
import { ScreenPanel } from './ScreenPanel';
import { SnapshotView } from './SnapshotView';

const edgeStyle: Record<EdgeKind, { stroke: string; strokeDasharray?: string }> = {
  observed: { stroke: '#2d72d2' },
  declared: { stroke: '#7961db', strokeDasharray: '6 4' },
  link: { stroke: '#8f99a8', strokeDasharray: '4 4' },
  nav: { stroke: '#c5cbd3', strokeDasharray: '2 4' },
};

/** The selection lives in the hash, so a link to the map can open a screen: #screen=/campaigns. */
function readHash(): { screen: string | null; view: StateRef | null } {
  const params = new URLSearchParams(location.hash.slice(1));
  const screen = params.get('screen');
  const state = params.get('state');
  return { screen, view: screen && state !== null ? { screen, state } : null };
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function writeHash(screen: string | null, view: StateRef | null) {
  const params = new URLSearchParams();
  if (screen) params.set('screen', screen);
  if (view) params.set('state', view.state);
  const hash = params.toString();
  history.replaceState(history.state, '', hash ? `#${hash}` : location.pathname + location.search);
}

export function MapApp() {
  return (
    <ReactFlowProvider>
      <MapCanvas />
    </ReactFlowProvider>
  );
}

function MapCanvas() {
  const { api, session } = useWidget();
  const { t } = useMap();
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
  const reload = useCallback(() => setVersion((v) => v + 1), []);

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

  const data: ScreenMap | undefined = map.data;
  // A crawled app has links from every page to many: they start hidden there, the clicks show.
  const linksDecided = useRef(false);
  useEffect(() => {
    if (!data || linksDecided.current) return;
    linksDecided.current = true;
    if (!linksByDefault(data)) setFilters((f) => ({ ...f, showLinks: false }));
  }, [data]);

  // The layout is computed by ELK in the background; the old one stays on screen meanwhile.
  const [layout, setLayout] = useState<Layout | null>(null);
  useEffect(() => {
    if (!data) return;
    let alive = true;
    layoutMap(data, filters, t.noSection).then(
      (l) => alive && setLayout(l),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [data, filters, t.noSection]);
  const roles = useMemo(() => [...new Set(data?.screens.flatMap((s) => s.roles) ?? [])].sort(), [data]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const fitted = useRef(false);
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
      zIndex: -1,
    }));
    const screenNodes: Node<ScreenNodeData>[] = layout.screens.map((p) => ({
      id: p.screen.key,
      type: 'screen',
      position: { x: p.x, y: p.y },
      data: { screen: p.screen, threads: p.threads, dim: p.dim, selected: p.screen.key === selected },
      style: { width: NODE_W, height: NODE_H },
    }));
    setNodes([...sectionNodes, ...screenNodes]);
    if (!fitted.current) {
      fitted.current = true;
      const focus = selected && layout.screens.some((p) => p.screen.key === selected) ? [{ id: selected }] : undefined;
      requestAnimationFrame(() => void flow.fitView({ padding: 0.08, nodes: focus, maxZoom: focus ? 1 : undefined }));
    }
  }, [layout, selected, setNodes, flow]);

  // The transitions of the screen in focus (selected or under the pointer) stand out with their
  // names; the rest stay thin, so a dense map still shows its shape.
  const focus = hovered ?? selected;
  const edges = useMemo<FlowEdge<RoutedEdgeData>[]>(() => {
    const list = layout?.edges ?? [];
    const dense = list.length > 40;
    // A transition between frames crosses the whole map: it shows for the screen in focus only.
    return list.flatMap((e) => {
      const style = edgeStyle[e.kind];
      const touches = focus !== null && (e.from === focus || e.to === focus);
      if (!e.points && !touches) return [];
      const opacity = focus === null ? (dense ? 0.35 : 1) : touches ? 1 : 0.1;
      return [
        {
          id: e.id,
          type: 'routed' as const,
          source: e.from,
          target: e.to,
          label: e.label || undefined,
          data: { points: e.points, labelAt: e.labelAt, showLabel: touches || (focus === null && !dense) },
          markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke },
          style: {
            ...style,
            strokeWidth:
              (e.kind === 'observed' ? 1.5 + Math.min(2.5, Math.log2(1 + e.count)) : 1.2) + (touches ? 1 : 0),
            opacity,
          },
          zIndex: touches ? 2 : 0,
        },
      ];
    });
  }, [layout, focus]);

  // Comments right on the canvas: a close screen shows its live snapshot, and an element picked in
  // it gets a thread — the same thread the real page pins.
  const stopCommenting = useCallback(() => {
    setCommenting(false);
    setPick(null);
  }, []);
  useEffect(() => {
    if (!commenting) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && stopCommenting();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commenting, stopCommenting]);
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
    }),
    [commenting, pinsVersion, stopCommenting],
  );
  const zoomTo = (id: string) => void flow.fitView({ nodes: [{ id }], duration: 400, padding: 0.25, maxZoom: 2.6 });

  const screen = data?.screens.find((s) => s.key === selected) ?? null;
  const pickScreen = pick ? (data?.screens.find((s) => s.key === pick.screen) ?? null) : null;
  const set = <K extends keyof MapFilters>(key: K, value: MapFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const file = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ intent: 'success' | 'danger'; text: string } | null>(null);
  const say = (intent: 'success' | 'danger', text: string) => {
    setMessage({ intent, text });
    setTimeout(() => setMessage(null), 8000);
  };
  const exportManifest = () =>
    api.exportManifest().then(
      (text) => download('pinpath-map.json', text + '\n'),
      (e: unknown) => say('danger', e instanceof Error ? e.message : String(e)),
    );
  const importManifest = async (f: File) => {
    try {
      say('success', t.imported(await api.importManifest(await f.text())));
      reload();
    } catch (e) {
      say('danger', `${t.importError}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const moved = data?.screens.filter((s) => s.position) ?? [];
  const resetLayout = async () => {
    try {
      for (let i = 0; i < moved.length; i += 200) {
        await api.patchScreens(moved.slice(i, i + 200).map((s) => ({ key: s.key, resetPosition: true })));
      }
      reload();
    } catch (e) {
      say('danger', e instanceof Error ? e.message : String(e));
    }
  };
  const crawlUrl = data ? crawlAddress(data) : null;

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
          <HTMLSelect value={filters.role} onChange={(e) => set('role', e.currentTarget.value)}>
            <option value="">{t.allRoles}</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </HTMLSelect>
        )}
        <Switch
          label={t.links}
          checked={filters.showLinks}
          onChange={(e) => set('showLinks', e.currentTarget.checked)}
        />
        <Switch
          label={t.navigation}
          checked={filters.showNav}
          onChange={(e) => set('showNav', e.currentTarget.checked)}
        />
        <Switch
          label={t.hidden}
          checked={filters.showHidden}
          onChange={(e) => set('showHidden', e.currentTarget.checked)}
        />
        <span className="map-push" />
        {canComment && (
          <Button
            icon="comment"
            intent={commenting ? 'primary' : 'none'}
            text={t.comment}
            title={t.commentCanvasHint}
            onClick={() => (commenting ? stopCommenting() : setCommenting(true))}
          />
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
            <Menu>
              <MenuItem
                icon="path-search"
                text={t.crawl}
                disabled={!crawlUrl}
                title={crawlUrl ? undefined : t.crawlNoApp}
                onClick={() => crawlUrl && window.open(crawlUrl, '_blank', 'noopener')}
              />
              {canEdit && (
                <MenuItem
                  icon="layout-auto"
                  text={t.resetLayout}
                  title={t.resetLayoutHint}
                  disabled={moved.length === 0}
                  onClick={() => void resetLayout()}
                />
              )}
              <MenuDivider />
              <MenuItem icon="export" text={t.exportManifest} onClick={() => void exportManifest()} />
              {canEdit && <MenuItem icon="import" text={t.importManifest} onClick={() => file.current?.click()} />}
            </Menu>
          }
        >
          <Button icon="more" variant="minimal" aria-label={t.more} title={t.more} />
        </Popover>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (f) void importManifest(f);
          }}
        />
      </header>
      {commenting && !pick && <div className="map-hint">{t.commentCanvasHint}</div>}
      {message && (
        <Callout intent={message.intent} compact className="map-notice map-message">
          {message.text}
        </Callout>
      )}
      <div className={`map-body ${commenting ? 'is-commenting' : ''}`}>
        {data.screens.length === 0 ? (
          <NonIdealState icon="layers" title={t.empty} description={t.emptyHint} />
        ) : (
          <CanvasContext.Provider value={canvas}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              nodesDraggable={canEdit && !commenting}
              nodesConnectable={false}
              elementsSelectable
              onlyRenderVisibleElements
              minZoom={0.05}
              maxZoom={6}
              onNodeClick={(_, node) => {
                if (node.type !== 'screen') return;
                setSelected(node.id);
                // In the comment mode a screen too far to pick from comes close.
                if (commenting && flow.getZoom() < LIVE_ZOOM) zoomTo(node.id);
              }}
              onNodeMouseEnter={(_, node) => node.type === 'screen' && setHovered(node.id)}
              onNodeMouseLeave={() => setHovered(null)}
              onNodeDoubleClick={(_, node) => {
                const sc = data.screens.find((s) => s.key === node.id);
                const state =
                  sc?.states.find((s) => s.key === '' && s.hasSnapshot) ?? sc?.states.find((s) => s.hasSnapshot);
                if (sc && state) setView({ screen: sc.key, state: state.key });
              }}
              onNodeDragStop={(_, node) => {
                if (node.type !== 'screen' || !canEdit) return;
                void api
                  .patchScreens([
                    { key: node.id, position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } },
                  ])
                  .then(reload, () => undefined);
              }}
              onPaneClick={() => {
                setSelected(null);
                setPick(null);
              }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor={(n) => (n.type === 'section' ? '#f6f7f9' : '#abb3bf')} />
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
              onSelect={(key) => {
                setOpenThread(null);
                setSelected(key);
              }}
              onOpen={(state) => setView({ screen: screen.key, state })}
              onChanged={() => {
                setPinsVersion((v) => v + 1);
                reload();
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
    </div>
  );
}
