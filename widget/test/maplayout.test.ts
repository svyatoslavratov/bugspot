import { expect, test } from 'vitest';

import {
  crawlAddress,
  defaultFilters,
  framesOf,
  layoutMap,
  linksByDefault,
  NODE_H,
  NODE_W,
  ranksOf,
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

test('layout: a frame per section, linked screens left to right, moved screens keep their place', () => {
  const layout = layoutMap(map, { ...defaultFilters, search: 'brand' }, 'Без раздела');
  expect(layout.sections.map((s) => s.name)).toEqual(['CRM', 'Аналитика']);
  const at = (key: string) => layout.screens.find((p) => p.screen.key === key)!;
  expect(at('/brand/{id}').x).toBeGreaterThanOrEqual(at('/campaigns').x + NODE_W);
  for (const p of layout.screens) {
    const frame = layout.sections.find((s) => s.name === (p.screen.section || 'Без раздела'))!;
    expect(p.x).toBeGreaterThanOrEqual(frame.x);
    expect(p.y).toBeGreaterThanOrEqual(frame.y);
    expect(p.x + NODE_W).toBeLessThanOrEqual(frame.x + frame.w);
  }
  expect(layout.screens.filter((p) => p.dim).map((p) => p.screen.key)).toEqual(['/campaigns', '/authors', '/reports']);
  const moved = layoutMap(
    { ...map, screens: map.screens.map((s) => (s.key === '/reports' ? { ...s, position: { x: 5000, y: 10 } } : s)) },
    defaultFilters,
    '',
  );
  const reports = moved.screens.find((p) => p.screen.key === '/reports')!;
  expect([reports.x, reports.y]).toEqual([5000, 10]);
  expect(moved.sections.find((s) => s.name === 'Аналитика')!.x).toBeLessThanOrEqual(5000);
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
  ).toBe('https://app.test/#bugspot-crawl');
  expect(crawlAddress(map([screen('/campaigns', { exampleUrl: 'https://app.test/#/campaigns' })]))).toBe(
    'https://app.test/#bugspot-crawl',
  );
});

test('steps from the entry: a hub first, what it leads to next, cycles start where most leads out', () => {
  const screens = ['/a', '/b', '/c', '/d', '/x'].map((k) => screen(k));
  const ranks = ranksOf(screens, [
    { from: '/a', to: '/b' },
    { from: '/a', to: '/c' },
    { from: '/c', to: '/d' },
  ]);
  expect(Object.fromEntries(ranks)).toEqual({ '/a': 0, '/b': 1, '/c': 1, '/d': 2 });
  const cycle = ranksOf(screens.slice(0, 3), [
    { from: '/a', to: '/b' },
    { from: '/b', to: '/a' },
    { from: '/b', to: '/c' },
  ]);
  expect(Object.fromEntries(cycle)).toEqual({ '/b': 0, '/a': 1, '/c': 1 });
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

test('a hub with many screens makes a wide frame, not a tall one', () => {
  const leaves = Array.from({ length: 20 }, (_, i) => screen(`/s/${String.fromCharCode(97 + i)}`, { section: 'S' }));
  const hub = screen('/s', { section: 'S' });
  const layout = layoutMap(
    { screens: [hub, ...leaves], edges: leaves.map((l) => edge('/s', l.key)), aliases: {}, threads: {} },
    defaultFilters,
    '',
  );
  const frame = layout.sections[0];
  expect(frame.h).toBeLessThan(5 * (NODE_H + 40) + 200);
  expect(frame.w).toBeGreaterThan(frame.h);
});

test('links show at first only while they are few', () => {
  const many = Array.from({ length: 50 }, (_, i) => edge('/hub', `/s${i}`, {}, 'link', 0));
  const screens = [screen('/hub'), ...many.map((e) => screen(e.to.screen))];
  expect(linksByDefault({ screens, edges: many, aliases: {}, threads: {} })).toBe(false);
  expect(linksByDefault(map)).toBe(true);
});
