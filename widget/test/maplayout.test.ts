import { expect, test } from 'vitest';

import {
  crawlAddress,
  defaultFilters,
  framesOf,
  layoutMap,
  linksByDefault,
  NODE_H,
  NODE_W,
  screenEdges,
  threadsOf,
  visibleScreens,
} from '../src/map/layout';
import type { Edge, Screen, ScreenMap } from '../src/shared/types';

function screen(key: string, patch: Partial<Screen> = {}): Screen {
  return {
    key,
    name: '',
    section: '',
    description: '',
    title: '',
    order: 0,
    roles: [],
    hidden: false,
    planned: false,
    states: [],
    updatedAt: '',
    ...patch,
  };
}

function edge(
  from: string,
  to: string,
  via: Partial<Edge['via']> = {},
  source: Edge['source'] = 'observed',
  count = 1,
): Edge {
  return {
    from: { screen: from, state: '' },
    to: { screen: to, state: '' },
    via: { name: '', kind: 'button', selector: '', ...via },
    source,
    count,
    lastSeen: '',
  };
}

const map: ScreenMap = {
  screens: [
    screen('/campaigns', { section: 'CRM', roles: ['superadmin'] }),
    screen('/brand/{id}', { section: 'CRM', roles: ['superadmin'] }),
    screen('/authors', { section: 'CRM', roles: ['scout'] }),
    screen('/reports', { section: 'Аналитика', planned: true }),
    screen('/old', { hidden: true }),
  ],
  edges: [
    edge('/campaigns', '/brand/{id}', { name: 'Бренд' }),
    edge('/campaigns', '/brand/{id}', { name: 'Открыть' }, 'link', 0),
    edge('/campaigns', '/brand/{id}', { name: 'Ещё' }, 'link', 0),
    edge('/campaigns', '/authors', { name: 'Авторы', kind: 'nav' }, 'link', 0),
    edge('/campaigns', '/campaigns', { name: 'Себе' }),
    edge('/authors', '/reports', { name: 'Отчёт' }, 'declared', 0),
  ],
  aliases: {},
  threads: { '/campaigns': { open: 2, fixed: 1, resolved: 4 } },
};

test('transitions: one per pair of screens, named by their elements, the menu and links on demand', () => {
  const keys = new Set(map.screens.map((s) => s.key));
  const edges = screenEdges(map.edges, keys, defaultFilters);
  expect(edges.map((e) => [e.from, e.to, e.kind, e.label])).toEqual([
    ['/campaigns', '/brand/{id}', 'observed', 'Бренд, Открыть +1'],
    ['/authors', '/reports', 'declared', 'Отчёт'],
  ]);
  expect(screenEdges(map.edges, keys, { ...defaultFilters, showNav: true }).some((e) => e.kind === 'nav')).toBe(true);
  expect(
    screenEdges([edge('/a', '/b', {}, 'link', 0)], new Set(['/a', '/b']), { ...defaultFilters, showLinks: false }),
  ).toEqual([]);
});

test('filters: hidden screens and other roles stay out, planned ones stay in', () => {
  expect(visibleScreens(map, defaultFilters).map((s) => s.key)).toEqual([
    '/campaigns',
    '/brand/{id}',
    '/authors',
    '/reports',
  ]);
  expect(visibleScreens(map, { ...defaultFilters, role: 'scout' }).map((s) => s.key)).toEqual(['/authors', '/reports']);
  expect(threadsOf(map, '/campaigns')).toBe(3);
});

const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + NODE_H && b.y < a.y + NODE_H;

test('layout: a frame per section, linked screens left to right, routes around them, moved screens keep their place', async () => {
  const layout = await layoutMap(map, { ...defaultFilters, search: 'brand' }, 'Без раздела');
  expect(layout.sections.map((s) => s.name)).toEqual(['CRM', 'Аналитика']);
  const at = (key: string) => layout.screens.find((p) => p.screen.key === key)!;
  expect(at('/brand/{id}').x).toBeGreaterThanOrEqual(at('/campaigns').x + NODE_W);
  for (const p of layout.screens) {
    const frame = layout.sections.find((s) => s.name === (p.screen.section || 'Без раздела'))!;
    expect(p.x).toBeGreaterThanOrEqual(frame.x);
    expect(p.y).toBeGreaterThanOrEqual(frame.y);
    expect(p.x + NODE_W).toBeLessThanOrEqual(frame.x + frame.w);
    expect(p.y + NODE_H).toBeLessThanOrEqual(frame.y + frame.h);
  }
  // Inside a frame the transition goes around the screens; across frames it is a plain curve.
  const inside = layout.edges.find((e) => e.from === '/campaigns' && e.to === '/brand/{id}')!;
  expect(inside.points!.length).toBeGreaterThanOrEqual(2);
  expect(inside.points![0].x).toBeGreaterThanOrEqual(at('/campaigns').x + NODE_W - 1);
  expect(layout.edges.find((e) => e.to === '/reports')!.points).toBeUndefined();
  expect(
    layout.screens
      .filter((p) => p.dim)
      .map((p) => p.screen.key)
      .sort(),
  ).toEqual(['/authors', '/campaigns', '/reports']);

  // A screen moved by hand stays there and does not stretch its frame over others.
  const moved = await layoutMap(
    { ...map, screens: map.screens.map((s) => (s.key === '/reports' ? { ...s, position: { x: -900, y: 10 } } : s)) },
    defaultFilters,
    '',
  );
  const reports = moved.screens.find((p) => p.screen.key === '/reports')!;
  expect([reports.x, reports.y, reports.manual]).toEqual([-900, 10, true]);
  expect(moved.sections.find((s) => s.name === 'Аналитика')!.x).toBeGreaterThan(0);
});

test('the crawl starts at the root page the map knows, with the hash that opens it', () => {
  const map = (screens: Screen[]): ScreenMap => ({ screens, edges: [], aliases: {}, threads: {} });
  expect(crawlAddress(map([screen('/reports')]))).toBeNull();
  expect(
    crawlAddress(
      map([
        screen('/reports', { exampleUrl: 'https://app.test/reports?x=1' }),
        screen('/', { exampleUrl: 'https://app.test/' }),
      ]),
    ),
  ).toBe('https://app.test/#pinpath-crawl');
  expect(crawlAddress(map([screen('/campaigns', { exampleUrl: 'https://app.test/#/campaigns' })]))).toBe(
    'https://app.test/#pinpath-crawl',
  );
});

test('screens without a section are framed by address when a few share it', () => {
  const screens = [
    screen('/tasks/admin'),
    screen('/tasks/scout'),
    screen('/tasks/ord'),
    screen('/portal/offers'),
    screen('/history'),
    screen('author-card'),
    screen('/campaigns', { section: 'CRM' }),
  ];
  const { frames, of } = framesOf(screens, 'Без раздела');
  expect(frames).toEqual([
    { name: 'CRM', auto: false },
    { name: '/tasks', auto: true },
    { name: 'Без раздела', auto: false },
  ]);
  expect(of.get('/tasks/ord')).toBe('/tasks');
  expect(of.get('/portal/offers')).toBe('Без раздела');
  expect(of.get('author-card')).toBe('Без раздела');
});

test('a hub with many screens makes a wide frame, not a tall one, and no screens overlap', async () => {
  const leaves = Array.from({ length: 20 }, (_, i) => screen(`/s/${String.fromCharCode(97 + i)}`, { section: 'S' }));
  const hub = screen('/s', { section: 'S' });
  const loose = Array.from({ length: 6 }, (_, i) => screen(`/s/x${i}`, { section: 'S' }));
  const layout = await layoutMap(
    { screens: [hub, ...leaves, ...loose], edges: leaves.map((l) => edge('/s', l.key)), aliases: {}, threads: {} },
    defaultFilters,
    '',
  );
  const frame = layout.sections[0];
  expect(frame.w).toBeGreaterThan(frame.h);
  // The 20 screens only the hub leads to form a block; their arrows run in the gaps between rows.
  for (const e of layout.edges.filter((e) => e.from === '/s')) {
    const leaf = layout.screens.find((p) => p.screen.key === e.to)!;
    const end = e.points![e.points!.length - 1];
    expect(end).toEqual({ x: leaf.x + NODE_W / 2, y: leaf.y });
  }
  const all = layout.screens;
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++)
      expect(overlaps(all[i], all[j]), `${all[i].screen.key} × ${all[j].screen.key}`).toBe(false);
});

test('links show at first only while they are few', () => {
  const many = Array.from({ length: 50 }, (_, i) => edge('/hub', `/s${i}`, {}, 'link', 0));
  const screens = [screen('/hub'), ...many.map((e) => screen(e.to.screen))];
  expect(linksByDefault({ screens, edges: many, aliases: {}, threads: {} })).toBe(false);
  expect(linksByDefault(map)).toBe(true);
});
