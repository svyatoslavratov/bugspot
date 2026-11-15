// Where screens go on the map: each section is a frame, and inside it ELK lays the screens out in
// layers along their transitions with as few crossings as it can, routing the arrows around the
// screens; frames flow in rows like boards in a design tool. Screens nobody put in a section are
// framed by the first segment of their address. A screen moved by hand keeps its place.

import type { ElkNode } from 'elkjs/lib/elk-api';

import type { Edge, Point, Screen, ScreenMap, Status } from '../shared/types';

export const NODE_W = 260;
export const NODE_H = 236;
const FRAME_PAD = 48;
const FRAME_TITLE = 72;
const FRAME_GAP = 120;
/** Unsectioned screens under one address segment get their own frame from this many. */
const AUTO_SECTION_MIN = 3;

export interface MapFilters {
  search: string;
  role: string;
  showNav: boolean;
  showLinks: boolean;
  showHidden: boolean;
}

export const defaultFilters: MapFilters = { search: '', role: '', showNav: false, showLinks: true, showHidden: false };

export interface PlacedScreen {
  screen: Screen;
  x: number;
  y: number;
  /** Does not match the search: drawn faded. */
  dim: boolean;
  threads: number;
  /** Moved by hand: it stays where it was put, outside the layout of its frame. */
  manual: boolean;
}

export interface PlacedSection {
  name: string;
  /** A frame by address, not a section people or agents named. */
  auto: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type EdgeKind = 'observed' | 'declared' | 'link' | 'nav';

export interface PlacedEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: EdgeKind;
  count: number;
  /** The route ELK found, around the screens of the frame; none — a plain curve. */
  points?: Point[];
  /** Where the name goes; by default halfway along the route. */
  labelAt?: Point;
}

export interface Layout {
  screens: PlacedScreen[];
  sections: PlacedSection[];
  edges: PlacedEdge[];
}

const ACTIVE: Status[] = ['open', 'in_progress', 'fixed'];

/** Threads that still need work on the screen. */
export function threadsOf(map: ScreenMap, key: string): number {
  const counts = map.threads[key] ?? {};
  return ACTIVE.reduce((n, s) => n + (counts[s] ?? 0), 0);
}

/**
 * Where to start building the map: the app's root page if the map knows it, else any page it
 * knows. The widget there opens the crawl when the address carries #pinpath-crawl.
 */
export function crawlAddress(map: ScreenMap): string | null {
  const page = map.screens.find((s) => s.key === '/' && s.exampleUrl) ?? map.screens.find((s) => s.exampleUrl);
  if (!page?.exampleUrl) return null;
  const url = new URL(page.exampleUrl);
  url.hash = 'pinpath-crawl';
  return url.href;
}

export function screenLabel(screen: Screen): string {
  return screen.name || screen.title || screen.key;
}

function matches(screen: Screen, search: string): boolean {
  if (!search) return true;
  const q = search.toLocaleLowerCase();
  return [
    screen.key,
    screen.name,
    screen.title,
    screen.description,
    screen.section,
    ...screen.states.map((s) => s.name),
  ]
    .join(' ')
    .toLocaleLowerCase()
    .includes(q);
}

/** The screens shown with the filters: hidden ones and other roles' ones are left out. */
export function visibleScreens(map: ScreenMap, filters: MapFilters): Screen[] {
  return map.screens.filter(
    (s) =>
      (filters.showHidden || !s.hidden) &&
      (!filters.role || s.planned || s.roles.length === 0 || s.roles.includes(filters.role)),
  );
}

const rank: Record<EdgeKind, number> = { link: 0, nav: 1, observed: 2, declared: 3 };

/** Transitions between screens, one per pair, named by the elements they go through. */
export function screenEdges(edges: Edge[], keys: Set<string>, filters: MapFilters): PlacedEdge[] {
  const pairs = new Map<
    string,
    { from: string; to: string; names: string[]; kind: EdgeKind; count: number; allNav: boolean }
  >();
  for (const e of edges) {
    if (e.from.screen === e.to.screen || !keys.has(e.from.screen) || !keys.has(e.to.screen)) continue;
    const id = `${e.from.screen}→${e.to.screen}`;
    const kind: EdgeKind = e.source === 'link' ? 'link' : e.source;
    const pair = pairs.get(id) ?? { from: e.from.screen, to: e.to.screen, names: [], kind, count: 0, allNav: true };
    if (rank[kind] > rank[pair.kind]) pair.kind = kind;
    pair.allNav &&= e.via.kind === 'nav';
    pair.count += e.count;
    if (e.via.name && !pair.names.includes(e.via.name)) pair.names.push(e.via.name);
    pairs.set(id, pair);
  }
  const out: PlacedEdge[] = [];
  for (const [id, p] of pairs) {
    const kind: EdgeKind = p.allNav ? 'nav' : p.kind;
    if (kind === 'nav' && !filters.showNav) continue;
    if (kind === 'link' && !filters.showLinks) continue;
    const label = p.names.length > 2 ? `${p.names.slice(0, 2).join(', ')} +${p.names.length - 2}` : p.names.join(', ');
    out.push({ id, from: p.from, to: p.to, label, kind, count: p.count });
  }
  return out;
}

/** Link transitions between screens worth showing at first: up to a few dozen pairs. */
export function linksByDefault(map: ScreenMap, limit = 40): boolean {
  const keys = new Set(map.screens.map((s) => s.key));
  return screenEdges(map.edges, keys, defaultFilters).filter((e) => e.kind === 'link').length <= limit;
}

/** The address segment that frames a screen without a section: /tasks/admin → /tasks. */
function prefixOf(key: string): string {
  return key.startsWith('/') ? `/${key.split(/[/?#]/)[1] ?? ''}` : '';
}

/**
 * The frame of each screen: its section; else, for addresses, the first segment when it holds a few
 * unsectioned screens; else the frame of screens without a section. Frames come in that order.
 */
export function framesOf(
  screens: Screen[],
  noSection: string,
): { frames: { name: string; auto: boolean }[]; of: Map<string, string> } {
  const counts = new Map<string, number>();
  for (const s of screens)
    if (!s.section && prefixOf(s.key)) counts.set(prefixOf(s.key), (counts.get(prefixOf(s.key)) ?? 0) + 1);
  const of = new Map<string, string>();
  const named: string[] = [];
  const auto = new Set<string>();
  let loose = false;
  for (const s of screens) {
    const prefix = prefixOf(s.key);
    let name = s.section;
    if (!name && prefix && (counts.get(prefix) ?? 0) >= AUTO_SECTION_MIN) {
      name = prefix;
      auto.add(name);
    } else if (!name) {
      name = noSection;
      loose = true;
    } else if (!named.includes(name)) named.push(name);
    of.set(s.key, name);
  }
  const frames = [
    ...named.map((name) => ({ name, auto: false })),
    ...[...auto]
      .filter((n) => !named.includes(n))
      .sort()
      .map((name) => ({ name, auto: true })),
    ...(loose && !named.includes(noSection) ? [{ name: noSection, auto: false }] : []),
  ];
  return { frames, of };
}

type Elk = { layout(graph: ElkNode): Promise<ElkNode> };
let elk: Promise<Elk> | null = null;

/** ELK is large (~400 KB gzipped): it loads with the first layout, on the map page only. */
function loadElk(): Promise<Elk> {
  elk ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default() as unknown as Elk);
  return elk;
}

const ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  'elk.spacing.nodeNode': '48',
  'elk.layered.spacing.nodeNodeBetweenLayers': '96',
  'elk.spacing.edgeNode': '24',
  'elk.spacing.edgeEdge': '10',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '10',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  // Unlinked groups of screens are packed next to each other, the whole frame wider than tall.
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '72',
  'elk.aspectRatio': '1.8',
  // A long chain of screens wraps into rows instead of one endless line.
  'elk.layered.wrapping.strategy': 'MULTI_EDGE',
};

interface FrameLayout {
  w: number;
  h: number;
  nodes: Map<string, Point>;
  routes: Map<string, { points: Point[]; labelAt?: Point }>;
}

/** A screen leads to this many screens that lead nowhere else, and they go into a grid block. */
const FAN_MIN = 5;
const GAP = 40;
/** Above each row of a block runs the line its arrows come along. */
const BUS = GAP / 2;

/**
 * Fans: screens linked only to one screen (a menu, a list of records and their cards). ELK would
 * stack them in one tall column; they become a grid block instead.
 */
export function fansOf(screens: Screen[], edges: { from: string; to: string }[]): Map<string, string[]> {
  const neighbours = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from],
    ]) {
      const set = neighbours.get(a) ?? new Set<string>();
      set.add(b);
      neighbours.set(a, set);
    }
  }
  const fans = new Map<string, string[]>();
  for (const s of screens) {
    const only = neighbours.get(s.key);
    if (only?.size !== 1) continue;
    const [parent] = only;
    // Two screens linked only to each other: a pair, not a fan.
    if (neighbours.get(parent)?.size === 1) continue;
    fans.set(parent, [...(fans.get(parent) ?? []), s.key]);
  }
  for (const [parent, leaves] of fans) if (leaves.length < FAN_MIN) fans.delete(parent);
  return fans;
}

function gridOf(n: number) {
  // About 1.6 times wider than tall.
  const cols = Math.max(1, Math.round(Math.sqrt((1.6 * n * NODE_H) / NODE_W)));
  const rows = Math.ceil(n / cols);
  return { cols, rows, w: cols * NODE_W + (cols - 1) * GAP, h: BUS * 2 + rows * NODE_H + (rows - 1) * GAP };
}

/** One frame: its screens and the transitions between them laid out by ELK, from (0, 0). */
async function layoutFrame(screens: Screen[], edges: PlacedEdge[]): Promise<FrameLayout> {
  const keys = new Set(screens.map((s) => s.key));
  const inner = edges.filter((e) => e.from !== e.to && keys.has(e.from) && keys.has(e.to));
  const fans = fansOf(screens, inner);
  const fanOf = new Map<string, string>();
  for (const [parent, leaves] of fans) for (const leaf of leaves) fanOf.set(leaf, parent);
  const blocks = [...fans].map(([parent, leaves]) => ({
    parent,
    leaves,
    id: `fan:${parent}`,
    ...gridOf(leaves.length),
  }));
  const graph: ElkNode = {
    id: 'frame',
    layoutOptions: ELK_OPTIONS,
    children: [
      ...screens.filter((s) => !fanOf.has(s.key)).map((s) => ({ id: s.key, width: NODE_W, height: NODE_H })),
      ...blocks.map((b) => ({ id: b.id, width: b.w, height: b.h })),
    ],
    edges: [
      ...inner
        .filter((e) => !fanOf.has(e.from) && !fanOf.has(e.to))
        .map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
      ...blocks.map((b) => ({ id: b.id, sources: [b.parent], targets: [b.id] })),
    ],
  };
  const out = await (await loadElk()).layout(graph);
  const nodes = new Map<string, Point>();
  const placed = new Map<string, Point>();
  for (const c of out.children ?? []) placed.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  const routes = new Map<string, { points: Point[]; labelAt?: Point }>();
  const routeOf = new Map<string, Point[]>();
  for (const e of out.edges ?? []) {
    const section = e.sections?.[0];
    if (section) routeOf.set(e.id, [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]);
  }
  for (const s of screens) if (!fanOf.has(s.key)) nodes.set(s.key, placed.get(s.key) ?? { x: 0, y: 0 });
  for (const e of inner) {
    const route = routeOf.get(e.id);
    if (route) routes.set(e.id, { points: route });
  }
  // A block: its screens in rows; an arrow comes along the route to the block, down a line at its
  // left, along the gap above the row and down into the screen — never across another screen.
  for (const b of blocks) {
    const at = placed.get(b.id) ?? { x: 0, y: 0 };
    const toBlock = routeOf.get(b.id);
    b.leaves.forEach((leaf, i) => {
      const col = i % b.cols;
      const row = Math.floor(i / b.cols);
      const pos = { x: at.x + col * (NODE_W + GAP), y: at.y + BUS * 2 + row * (NODE_H + GAP) };
      nodes.set(leaf, pos);
      if (!toBlock) return;
      const entry = toBlock[toBlock.length - 1];
      const busX = at.x - BUS;
      const lineY = pos.y - BUS;
      const centre = pos.x + NODE_W / 2;
      const down = [
        ...toBlock.slice(0, -1),
        { x: busX, y: entry.y },
        { x: busX, y: lineY },
        { x: centre, y: lineY },
        { x: centre, y: pos.y },
      ];
      const labelAt = { x: centre, y: lineY };
      for (const e of inner) {
        if (e.from === b.parent && e.to === leaf) routes.set(e.id, { points: down, labelAt });
        if (e.from === leaf && e.to === b.parent) routes.set(e.id, { points: [...down].reverse(), labelAt });
      }
    });
  }
  let w = 0;
  let h = 0;
  for (const p of nodes.values()) {
    w = Math.max(w, p.x + NODE_W);
    h = Math.max(h, p.y + NODE_H);
  }
  return { w, h, nodes, routes };
}

/** Frames in rows about as wide as the whole map is tall: a map that fits a screen when zoomed out. */
function rowWidth(frames: { w: number; h: number }[]): number {
  const area = frames.reduce((n, f) => n + (f.w + FRAME_GAP) * (f.h + FRAME_GAP), 0);
  const widest = Math.max(0, ...frames.map((f) => f.w));
  return Math.max(widest, Math.sqrt(area * 1.6));
}

export async function layoutMap(map: ScreenMap, filters: MapFilters, noSection: string): Promise<Layout> {
  const screens = visibleScreens(map, filters);
  const keys = new Set(screens.map((s) => s.key));
  const edges = screenEdges(map.edges, keys, filters);
  const { frames, of } = framesOf(screens, noSection);
  const laid = await Promise.all(
    frames.map(async (frame) => {
      const list = screens
        .filter((s) => of.get(s.key) === frame.name)
        .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
      const inner = await layoutFrame(list, edges);
      return { ...frame, list, inner, w: inner.w + FRAME_PAD * 2, h: inner.h + FRAME_PAD * 2 + FRAME_TITLE };
    }),
  );
  const limit = rowWidth(laid);
  const placed: PlacedScreen[] = [];
  const sections: PlacedSection[] = [];
  const at = new Map<string, Point>();
  const offsets = new Map<string, Point>();
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const f of laid) {
    if (cursorX > 0 && cursorX + f.w > limit) {
      cursorX = 0;
      cursorY += rowHeight + FRAME_GAP;
      rowHeight = 0;
    }
    const origin = { x: cursorX + FRAME_PAD, y: cursorY + FRAME_TITLE + FRAME_PAD };
    offsets.set(f.name, origin);
    sections.push({ name: f.name, auto: f.auto, x: cursorX, y: cursorY, w: f.w, h: f.h });
    for (const s of f.list) {
      const p = f.inner.nodes.get(s.key) ?? { x: 0, y: 0 };
      const auto = { x: origin.x + p.x, y: origin.y + p.y };
      // A screen moved by hand stays where it was put; its frame keeps the size of its layout.
      const pos = s.position ?? auto;
      at.set(s.key, pos);
      placed.push({
        screen: s,
        x: pos.x,
        y: pos.y,
        dim: !matches(s, filters.search),
        threads: threadsOf(map, s.key),
        manual: !!s.position,
      });
    }
    cursorX += f.w + FRAME_GAP;
    rowHeight = Math.max(rowHeight, f.h);
  }
  const manual = new Set(placed.filter((p) => p.manual).map((p) => p.screen.key));
  const routed = edges.map((e) => {
    const frame = of.get(e.from);
    if (!frame || frame !== of.get(e.to) || manual.has(e.from) || manual.has(e.to)) return e;
    const route = laid.find((f) => f.name === frame)?.inner.routes.get(e.id);
    const origin = offsets.get(frame);
    if (!route || !origin) return e;
    const shift = (p: Point) => ({ x: origin.x + p.x, y: origin.y + p.y });
    return { ...e, points: route.points.map(shift), labelAt: route.labelAt && shift(route.labelAt) };
  });
  return { screens: placed, sections, edges: routed };
}
