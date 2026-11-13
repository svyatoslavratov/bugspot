// Where screens go on the map: each section is a frame, screens inside it in columns by how many
// transitions away from the section's entry they are, frames flow in rows like boards in a design
// tool. Screens nobody put in a section are framed by the first segment of their address. A screen
// moved by hand keeps its place.

import type { Edge, Screen, ScreenMap, Status } from '../shared/types';

export const NODE_W = 260;
export const NODE_H = 236;
const FRAME_PAD = 40;
const FRAME_TITLE = 44;
const FRAME_GAP = 80;
const ROW_WIDTH = 3200;
/** Screens in a column before it wraps: wide frames read better than tall ones. */
const COLUMN_ROWS = 4;
const GAP = 40;
const RANK_GAP = 60;
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
 * knows. The widget there opens the crawl when the address carries #bugspot-crawl.
 */
export function crawlAddress(map: ScreenMap): string | null {
  const page = map.screens.find((s) => s.key === '/' && s.exampleUrl) ?? map.screens.find((s) => s.exampleUrl);
  if (!page?.exampleUrl) return null;
  const url = new URL(page.exampleUrl);
  url.hash = 'bugspot-crawl';
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

/** A grid of screens, wider than tall, starting at (x, y). */
function grid(screens: Screen[], x: number, y: number, cols: number, out: Map<string, { x: number; y: number }>) {
  screens.forEach((s, i) =>
    out.set(s.key, { x: x + (i % cols) * (NODE_W + GAP), y: y + Math.floor(i / cols) * (NODE_H + GAP) }),
  );
}

/**
 * Steps from the entries of a section (screens that lead somewhere and nothing in it leads to;
 * in a cycle, the one that leads to most) along its transitions. Unlinked screens get none.
 */
export function ranksOf(screens: Screen[], edges: { from: string; to: string }[]): Map<string, number> {
  const next = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const e of edges) {
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
    incoming.add(e.to);
  }
  const rank = new Map<string, number>();
  const walk = (roots: string[]) => {
    let level = roots.filter((r) => !rank.has(r));
    for (const r of level) rank.set(r, 0);
    for (let depth = 1; level.length; depth++) {
      const following: string[] = [];
      for (const key of level)
        for (const to of next.get(key) ?? []) {
          if (rank.has(to)) continue;
          rank.set(to, depth);
          following.push(to);
        }
      level = following;
    }
  };
  walk(screens.filter((s) => next.has(s.key) && !incoming.has(s.key)).map((s) => s.key));
  // What only a cycle reaches: start from the screen that leads to most.
  for (;;) {
    const rest = screens.filter((s) => !rank.has(s.key) && next.has(s.key));
    if (!rest.length) break;
    rest.sort((a, b) => (next.get(b.key)?.length ?? 0) - (next.get(a.key)?.length ?? 0));
    walk([rest[0].key]);
  }
  return rank;
}

/**
 * Positions of the screens of one section inside its frame: linked screens in columns by their
 * steps from the entry, a column wrapping after a few rows; the rest in a grid under them.
 */
function placeSection(screens: Screen[], edges: PlacedEdge[]): Map<string, { x: number; y: number }> {
  const keys = new Set(screens.map((s) => s.key));
  const inner = edges.filter((e) => keys.has(e.from) && keys.has(e.to) && e.kind !== 'nav' && e.from !== e.to);
  const rank = ranksOf(screens, inner);
  const out = new Map<string, { x: number; y: number }>();
  const byRank = new Map<number, Screen[]>();
  for (const s of screens) {
    const r = rank.get(s.key);
    if (r !== undefined) byRank.set(r, [...(byRank.get(r) ?? []), s]);
  }
  let x = 0;
  let rows = 0;
  for (const r of [...byRank.keys()].sort((a, b) => a - b)) {
    const column = byRank.get(r)!;
    const width = Math.ceil(column.length / COLUMN_ROWS);
    column.forEach((s, i) => {
      out.set(s.key, {
        x: x + Math.floor(i / COLUMN_ROWS) * (NODE_W + GAP),
        y: (i % COLUMN_ROWS) * (NODE_H + GAP),
      });
    });
    rows = Math.max(rows, Math.min(column.length, COLUMN_ROWS));
    x += width * (NODE_W + GAP) + RANK_GAP;
  }
  const loose = screens.filter((s) => !rank.has(s.key));
  const linkedCols = Math.max(0, Math.round((x - RANK_GAP) / (NODE_W + GAP)));
  const cols = Math.max(linkedCols, Math.ceil(Math.sqrt(loose.length * 1.6)), 1);
  grid(loose, 0, rows ? rows * (NODE_H + GAP) + RANK_GAP : 0, cols, out);
  return out;
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

export function layoutMap(map: ScreenMap, filters: MapFilters, noSection: string): Layout {
  const screens = visibleScreens(map, filters);
  const keys = new Set(screens.map((s) => s.key));
  const edges = screenEdges(map.edges, keys, filters);
  const { frames, of } = framesOf(screens, noSection);
  const placed: PlacedScreen[] = [];
  const sections: PlacedSection[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const { name, auto } of frames) {
    const list = screens.filter((s) => of.get(s.key) === name);
    const local = placeSection(
      [...list].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)),
      edges,
    );
    let w = 0;
    let h = 0;
    for (const p of local.values()) {
      w = Math.max(w, p.x + NODE_W);
      h = Math.max(h, p.y + NODE_H);
    }
    const frameW = w + FRAME_PAD * 2;
    const frameH = h + FRAME_PAD * 2 + FRAME_TITLE;
    if (cursorX > 0 && cursorX + frameW > ROW_WIDTH) {
      cursorX = 0;
      cursorY += rowHeight + FRAME_GAP;
      rowHeight = 0;
    }
    const frame = { name, auto, x: cursorX, y: cursorY, w: frameW, h: frameH };
    for (const s of list) {
      const p = local.get(s.key)!;
      const at = s.position ?? { x: frame.x + FRAME_PAD + p.x, y: frame.y + FRAME_TITLE + FRAME_PAD + p.y };
      placed.push({ screen: s, x: at.x, y: at.y, dim: !matches(s, filters.search), threads: threadsOf(map, s.key) });
    }
    sections.push(frame);
    cursorX += frameW + FRAME_GAP;
    rowHeight = Math.max(rowHeight, frameH);
  }
  // Screens moved by hand stretch their frame.
  for (const section of sections) {
    const inside = placed.filter((p) => of.get(p.screen.key) === section.name);
    const minX = Math.min(...inside.map((p) => p.x)) - FRAME_PAD;
    const minY = Math.min(...inside.map((p) => p.y)) - FRAME_PAD - FRAME_TITLE;
    const maxX = Math.max(...inside.map((p) => p.x + NODE_W)) + FRAME_PAD;
    const maxY = Math.max(...inside.map((p) => p.y + NODE_H)) + FRAME_PAD;
    Object.assign(section, { x: minX, y: minY, w: maxX - minX, h: maxY - minY });
  }
  return { screens: placed, sections, edges };
}
