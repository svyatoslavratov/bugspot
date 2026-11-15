import {
  Button,
  Callout,
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
  type Edge as FlowEdge,
  type Node,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useWidget } from '../app/context';
import { useData } from '../app/useData';
import type { ScreenMap, StateRef } from '../shared/types';
import { useMap } from './context';
import {
  crawlAddress,
  defaultFilters,
  layoutMap,
  linksByDefault,
  NODE_H,
  NODE_W,
  type EdgeKind,
  type MapFilters,
} from './layout';
import { nodeTypes, type ScreenNodeData, type SectionNodeData } from './nodes';
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
  const canEdit = session.can?.map ?? false;
  const [version, setVersion] = useState(0);
  const map = useData(() => api.map(), [version]);
  const [filters, setFilters] = useState<MapFilters>(defaultFilters);
  const [selected, setSelected] = useState<string | null>(() => readHash().screen);
  const [view, setView] = useState<StateRef | null>(() => readHash().view);
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
  const layout = useMemo(() => (data ? layoutMap(data, filters, t.noSection) : null), [data, filters, t.noSection]);
  const roles = useMemo(() => [...new Set(data?.screens.flatMap((s) => s.roles) ?? [])].sort(), [data]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
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
  }, [layout, selected, setNodes]);

  const edges = useMemo<FlowEdge[]>(
    () =>
      (layout?.edges ?? []).map((e) => {
        const style = edgeStyle[e.kind];
        const touches = selected !== null && (e.from === selected || e.to === selected);
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          label: e.label || undefined,
          labelBgPadding: [4, 2] as [number, number],
          labelStyle: { fontSize: 11 },
          markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke },
          style: {
            ...style,
            strokeWidth: (e.kind === 'observed' ? 1.5 + Math.min(3, Math.log2(1 + e.count)) : 1.2) + (touches ? 1 : 0),
            opacity: selected === null || touches ? 1 : 0.25,
          },
          zIndex: touches ? 2 : 0,
        };
      }),
    [layout, selected],
  );

  const screen = data?.screens.find((s) => s.key === selected) ?? null;
  const set = <K extends keyof MapFilters>(key: K, value: MapFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const file = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ intent: 'success' | 'danger'; text: string } | null>(null);
  const say = (intent: 'success' | 'danger', text: string) => {
    setMessage({ intent, text });
    setTimeout(() => setMessage(null), 8000);
  };
  const exportManifest = () =>
    api.exportManifest().then(
      (text) => download('bugspot-map.json', text + '\n'),
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
      {message && (
        <Callout intent={message.intent} compact className="map-notice map-message">
          {message.text}
        </Callout>
      )}
      <div className="map-body">
        {data.screens.length === 0 ? (
          <NonIdealState icon="layers" title={t.empty} description={t.emptyHint} />
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            nodesDraggable={canEdit}
            nodesConnectable={false}
            elementsSelectable
            minZoom={0.05}
            maxZoom={2.5}
            fitView
            fitViewOptions={{ padding: 0.1 }}
            onNodeClick={(_, node) => node.type === 'screen' && setSelected(node.id)}
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
            onPaneClick={() => setSelected(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => (n.type === 'section' ? '#f6f7f9' : '#abb3bf')} />
          </ReactFlow>
        )}
        {screen && (
          <ScreenPanel
            key={screen.key}
            map={data}
            screen={screen}
            version={version}
            showNav={filters.showNav}
            onClose={() => setSelected(null)}
            onSelect={setSelected}
            onOpen={(state) => setView({ screen: screen.key, state })}
            onChanged={reload}
          />
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
