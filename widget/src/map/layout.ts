// Where screens go on the map, as in a design tool: every screen at its real size (the window it
// was seen in), each section a frame, and inside it ELK lays the screens out in layers along their
// transitions with as few crossings as it can, routing the arrows around the screens; frames flow
// in rows. Screens nobody put in a section are framed by the first segment of their address; the
// tabs of one page that each have an address stand side by side as a group. A screen moved by hand
// keeps its place. ELK runs in a worker, so the page stays responsive.

import type { ElkNode } from 'elkjs/lib/elk-api';

import type { Edge, Point, Screen, ScreenMap, Size, Status } from '../shared/types';

/** A screen without a known window: a laptop's. */
export const SCREEN_DEFAULT: Size = { w: 1440, h: 900 };
const FRAME_PAD = 160;
const FRAME_GAP = 480;
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
  /** The real size of the screen: the window its look was taken in. */
  w: number;
  h: number;
  /** Does not match the search: drawn faded. */
  dim: boolean;
  threads: number;
  /** Moved by hand: it stays where it was put, outside the layout of its frame. */
  manual: boolean;
  /** One of the tabs of a group: it goes by its tab's name there. */
  inGroup: boolean;
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

/** Tabs of one page, each its own address, side by side: the box behind them. */
export interface PlacedGroup {
  id: string;
  /** The title the tabs share, if they do. */
  title: string;
  count: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How one gets from screen to screen; 'tab' — by the tabs of a page: a group, not an arrow. */
export type EdgeKind = 'observed' | 'declared' | 'link' | 'nav' | 'tab';

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
  groups: PlacedGroup[];
  /** Arrows to draw: transitions between tabs of a group are not among them. */
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
  if (screen.name) return screen.name;
  if (screen.tab) return screen.title ? `${screen.title} · ${screen.tab}` : screen.tab;
  return screen.title || screen.key;
}

/**
 * Names the tabs: when an app gives every tab of a page its own address, all of them share the
 * page's title, and each is told apart by its tab — the name of the tab that most often leads to
 * it, else, for the page one opens first, the one tab it was seen with.
 */
export function withTabs(map: ScreenMap): ScreenMap {
  const names = new Map<string, Map<string, number>>();
  const linked = new Set<string>();
  for (const e of map.edges) {
    if (e.via.kind !== 'tab' || e.from.screen === e.to.screen) continue;
    linked.add(e.from.screen).add(e.to.screen);
    if (!e.via.name) continue;
    const counts = names.get(e.to.screen) ?? new Map<string, number>();
    counts.set(e.via.name, (counts.get(e.via.name) ?? 0) + e.count);
    names.set(e.to.screen, counts);
  }
  if (!linked.size) return map;
  return {
    ...map,
    screens: map.screens.map((s) => {
      if (!linked.has(s.key)) return s;
      const counts = names.get(s.key);
      const tabs = s.states.filter((st) => st.kind === 'tab' && st.name);
      const tab = counts ? [...counts].sort((a, b) => b[1] - a[1])[0][0] : tabs.length === 1 ? tabs[0].name : '';
      return tab ? { ...s, tab } : s;
    }),
  };
}

const kindOrder = { page: 0, tab: 1, dialog: 2 } as const;

/** The state that stands for the screen: the page itself, else a tab, else a window. */
export function coverOf(screen: Screen, has: 'hasShot' | 'hasSnapshot' = 'hasShot') {
  return screen.states.filter((s) => s[has]).sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind])[0];
}

/** The size a screen takes on the map: the window of its look, within sane bounds. */
export function sizeOf(screen: Screen): Size {
  const v = (coverOf(screen, 'hasSnapshot') ?? coverOf(screen))?.viewport;
  if (!v?.w || !v?.h) return SCREEN_DEFAULT;
  return { w: Math.min(2560, Math.max(320, v.w)), h: Math.min(1600, Math.max(480, v.h)) };
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

const rank: Record<EdgeKind, number> = { link: 0, nav: 1, tab: 2, observed: 3, declared: 4 };

/**
 * Transitions between screens, one per pair, named by the elements they go through. Screens one
 * goes between by tabs are tabs of one page whatever else links them: such a pair is a 'tab'.
 */
export function screenEdges(edges: Edge[], keys: Set<string>, filters: MapFilters): PlacedEdge[] {
  const pairs = new Map<
    string,
    { from: string; to: string; names: string[]; kind: EdgeKind; count: number; allNav: boolean; tab: boolean }
  >();
  for (const e of edges) {
    if (e.from.screen === e.to.screen || !keys.has(e.from.screen) || !keys.has(e.to.screen)) continue;
    const id = `${e.from.screen}→${e.to.screen}`;
    const kind: EdgeKind = e.source === 'link' ? 'link' : e.source;
    const pair = pairs.get(id) ?? {
      from: e.from.screen,
      to: e.to.screen,
      names: [],
      kind,
      count: 0,
      allNav: true,
      tab: false,
    };
    if (rank[kind] > rank[pair.kind]) pair.kind = kind;
    pair.allNav &&= e.via.kind === 'nav';
    pair.tab ||= e.via.kind === 'tab';
    pair.count += e.count;
    if (e.via.name && !pair.names.includes(e.via.name)) pair.names.push(e.via.name);
    pairs.set(id, pair);
  }
  const out: PlacedEdge[] = [];
  for (const [id, p] of pairs) {
    const kind: EdgeKind = p.tab ? 'tab' : p.allNav ? 'nav' : p.kind;
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

/**
 * ELK is large (~400 KB gzipped): it loads with the first layout, on the map page only, into a
 * worker where the browser has them, so a layout never freezes the page.
 */
function loadElk(): Promise<Elk> {
  elk ??= (async () => {
    if (typeof Worker !== 'undefined') {
      try {
        const [{ default: ELK }, { default: workerUrl }] = await Promise.all([
          import('elkjs/lib/elk-api'),
          import('elkjs/lib/elk-worker.min.js?url'),
        ]);
        return new ELK({ workerUrl }) as unknown as Elk;
      } catch {
        // A page that refuses workers lays out in place.
      }
    }
    const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
    return new ELK() as unknown as Elk;
  })();
  return elk;
}

const ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  'elk.spacing.nodeNode': '160',
  'elk.layered.spacing.nodeNodeBetweenLayers': '360',
  'elk.spacing.edgeNode': '64',
  'elk.spacing.edgeEdge': '24',
  'elk.layered.spacing.edgeNodeBetweenLayers': '64',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '24',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  // Unlinked groups of screens are packed next to each other, the whole frame wider than tall.
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '240',
  'elk.aspectRatio': '1.8',
  // A long chain of screens wraps into rows instead of one endless line.
  'elk.layered.wrapping.strategy': 'MULTI_EDGE',
};

interface FrameLayout {
  w: number;
  h: number;
  nodes: Map<string, Point>;
  routes: Map<string, { points: Point[]; labelAt?: Point }>;
  /** Groups of tabs, from the frame's corner. */
  groups: PlacedGroup[];
  /** The arrows inside the frame worth drawing: not those between the tabs of one group. */
  inner: Set<string>;
  /** Screens in a group of tabs. */
  grouped: Set<string>;
}

/** A screen leads to this many screens that lead nowhere else, and they go into a grid block. */
const FAN_MIN = 5;
const GAP = 160;
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

/** A grid of screens about 1.6 times wider than tall; cells as large as the largest screen. */
function gridOf(sizes: Size[]) {
  const cw = Math.max(...sizes.map((s) => s.w));
  const ch = Math.max(...sizes.map((s) => s.h));
  const n = sizes.length;
  const cols = Math.max(1, Math.round(Math.sqrt((1.6 * n * ch) / cw)));
  const rows = Math.ceil(n / cols);
  return { cols, rows, cw, ch, w: cols * cw + (cols - 1) * GAP, h: BUS * 2 + rows * ch + (rows - 1) * GAP };
}

/** Tabs of a group stand in rows of at most this many. */
const TABS_PER_ROW = 4;
/** The room in a group's box around its tabs; above them, the gap between rows (for their names). */
const TABS_PAD = 64;

/**
 * Groups of tabs: screens one goes between by the tabs of a page, when the app gives every tab its
 * own address. Every tab leads to every other, and as arrows that is a tangle: they stand side by
 * side in a box instead. The screens come in their order.
 */
export function tabGroupsOf(screens: Screen[], edges: { from: string; to: string; kind: EdgeKind }[]): string[][] {
  const root = new Map<string, string>(screens.map((s) => [s.key, s.key]));
  const find = (key: string): string => {
    let r = key;
    while (root.get(r) !== r) r = root.get(r)!;
    root.set(key, r);
    return r;
  };
  for (const e of edges) {
    if (e.kind !== 'tab' || e.from === e.to || !root.has(e.from) || !root.has(e.to)) continue;
    root.set(find(e.from), find(e.to));
  }
  const groups = new Map<string, string[]>();
  for (const s of screens) groups.set(find(s.key), [...(groups.get(find(s.key)) ?? []), s.key]);
  return [...groups.values()].filter((g) => g.length > 1);
}

/** The grid of a group of tabs and its box: rows of up to four, as even as they go. */
function tabGridOf(sizes: Size[]) {
  const n = sizes.length;
  const rows = Math.ceil(n / TABS_PER_ROW);
  const cols = Math.ceil(n / rows);
  const cw = Math.max(...sizes.map((s) => s.w));
  const ch = Math.max(...sizes.map((s) => s.h));
  return {
    cols,
    cw,
    ch,
    w: TABS_PAD * 2 + cols * cw + (cols - 1) * GAP,
    h: GAP + TABS_PAD + rows * ch + (rows - 1) * GAP,
  };
}

/** The most common of the titles, if any. */
function commonTitle(screens: Screen[]): string {
  const counts = new Map<string, number>();
  for (const s of screens) if (s.title) counts.set(s.title, (counts.get(s.title) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/** One frame: its screens and the transitions between them laid out by ELK, from (0, 0). */
async function layoutFrame(screens: Screen[], edges: PlacedEdge[]): Promise<FrameLayout> {
  const keys = new Set(screens.map((s) => s.key));
  const size = new Map(screens.map((s) => [s.key, sizeOf(s)]));
  const byKey = new Map(screens.map((s) => [s.key, s]));
  const within = edges.filter((e) => e.from !== e.to && keys.has(e.from) && keys.has(e.to));
  const tabs = tabGroupsOf(screens, within).map((members) => ({
    members,
    id: `tabs:${members[0]}`,
    title: commonTitle(members.map((m) => byKey.get(m)!)),
    ...tabGridOf(members.map((m) => size.get(m)!)),
  }));
  const groupOf = new Map<string, string>();
  for (const g of tabs) for (const m of g.members) groupOf.set(m, g.id);
  // The arrows: none between the tabs of one group; one to a tab ends at its group's box.
  const inner = within.filter(
    (e) => e.kind !== 'tab' && (!groupOf.has(e.from) || groupOf.get(e.from) !== groupOf.get(e.to)),
  );
  const end = (key: string) => groupOf.get(key) ?? key;
  const fans = fansOf(
    screens.filter((s) => !groupOf.has(s.key)),
    inner,
  );
  for (const parent of fans.keys()) if (groupOf.has(parent)) fans.delete(parent);
  const fanOf = new Map<string, string>();
  for (const [parent, leaves] of fans) for (const leaf of leaves) fanOf.set(leaf, parent);
  const blocks = [...fans].map(([parent, leaves]) => ({
    parent,
    leaves,
    id: `fan:${parent}`,
    ...gridOf(leaves.map((l) => size.get(l)!)),
  }));
  const graph: ElkNode = {
    id: 'frame',
    layoutOptions: ELK_OPTIONS,
    children: [
      ...screens
        .filter((s) => !fanOf.has(s.key) && !groupOf.has(s.key))
        .map((s) => ({ id: s.key, width: size.get(s.key)!.w, height: size.get(s.key)!.h })),
      ...blocks.map((b) => ({ id: b.id, width: b.w, height: b.h })),
      ...tabs.map((g) => ({ id: g.id, width: g.w, height: g.h })),
    ],
    edges: [
      ...inner
        .filter((e) => !fanOf.has(e.from) && !fanOf.has(e.to))
        .map((e) => ({ id: e.id, sources: [end(e.from)], targets: [end(e.to)] })),
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
  for (const s of screens) {
    if (!fanOf.has(s.key) && !groupOf.has(s.key)) nodes.set(s.key, placed.get(s.key) ?? { x: 0, y: 0 });
  }
  for (const e of inner) {
    const route = routeOf.get(e.id);
    if (route) routes.set(e.id, { points: route });
  }
  // A group: its tabs in rows inside the box, the names of the tabs in the gaps above them.
  const groups: PlacedGroup[] = tabs.map((g) => {
    const at = placed.get(g.id) ?? { x: 0, y: 0 };
    g.members.forEach((m, i) => {
      const col = i % g.cols;
      const row = Math.floor(i / g.cols);
      nodes.set(m, { x: at.x + TABS_PAD + col * (g.cw + GAP), y: at.y + GAP + row * (g.ch + GAP) });
    });
    return { id: g.id, title: g.title, count: g.members.length, x: at.x, y: at.y, w: g.w, h: g.h };
  });
  // A block: its screens in rows; an arrow comes along the route to the block, down a line at its
  // left, along the gap above the row and down into the screen — never across another screen.
  for (const b of blocks) {
    const at = placed.get(b.id) ?? { x: 0, y: 0 };
    const toBlock = routeOf.get(b.id);
    b.leaves.forEach((leaf, i) => {
      const col = i % b.cols;
      const row = Math.floor(i / b.cols);
      const pos = { x: at.x + col * (b.cw + GAP), y: at.y + BUS * 2 + row * (b.ch + GAP) };
      nodes.set(leaf, pos);
      if (!toBlock) return;
      const entry = toBlock[toBlock.length - 1];
      const busX = at.x - BUS;
      const lineY = pos.y - BUS;
      const centre = pos.x + size.get(leaf)!.w / 2;
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
  for (const [key, p] of nodes) {
    w = Math.max(w, p.x + size.get(key)!.w);
    h = Math.max(h, p.y + size.get(key)!.h);
  }
  for (const g of groups) {
    w = Math.max(w, g.x + g.w);
    h = Math.max(h, g.y + g.h);
  }
  return { w, h, nodes, routes, groups, inner: new Set(inner.map((e) => e.id)), grouped: new Set(groupOf.keys()) };
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
      return { ...frame, list, inner, w: inner.w + FRAME_PAD * 2, h: inner.h + FRAME_PAD * 2 };
    }),
  );
  const limit = rowWidth(laid);
  const placed: PlacedScreen[] = [];
  const sections: PlacedSection[] = [];
  const groups: PlacedGroup[] = [];
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
    const origin = { x: cursorX + FRAME_PAD, y: cursorY + FRAME_PAD };
    offsets.set(f.name, origin);
    sections.push({ name: f.name, auto: f.auto, x: cursorX, y: cursorY, w: f.w, h: f.h });
    for (const g of f.inner.groups) groups.push({ ...g, x: origin.x + g.x, y: origin.y + g.y });
    for (const s of f.list) {
      const p = f.inner.nodes.get(s.key) ?? { x: 0, y: 0 };
      const auto = { x: origin.x + p.x, y: origin.y + p.y };
      // A screen moved by hand stays where it was put; its frame keeps the size of its layout.
      const pos = s.position ?? auto;
      const { w, h } = sizeOf(s);
      placed.push({
        screen: s,
        x: pos.x,
        y: pos.y,
        w,
        h,
        dim: !matches(s, filters.search),
        threads: threadsOf(map, s.key),
        manual: !!s.position,
        inGroup: f.inner.grouped.has(s.key),
      });
    }
    cursorX += f.w + FRAME_GAP;
    rowHeight = Math.max(rowHeight, f.h);
  }
  const manual = new Set(placed.filter((p) => p.manual).map((p) => p.screen.key));
  const frameOf = new Map(laid.map((f) => [f.name, f]));
  const routed: PlacedEdge[] = [];
  for (const e of edges) {
    const frame = of.get(e.from);
    const inside = !!frame && frame === of.get(e.to);
    // Between tabs of one group there is no arrow; between frames tabs are linked as any screens.
    if (e.kind === 'tab' && inside) continue;
    if (inside && !frameOf.get(frame)?.inner.inner.has(e.id)) continue;
    const route =
      inside && !manual.has(e.from) && !manual.has(e.to) ? frameOf.get(frame)?.inner.routes.get(e.id) : undefined;
    const origin = frame ? offsets.get(frame) : undefined;
    if (!route || !origin) {
      routed.push(e);
      continue;
    }
    const shift = (p: Point) => ({ x: origin.x + p.x, y: origin.y + p.y });
    routed.push({ ...e, points: route.points.map(shift), labelAt: route.labelAt && shift(route.labelAt) });
  }
  return { screens: placed, sections, groups, edges: routed };
}
