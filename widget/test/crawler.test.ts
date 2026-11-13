import { JSDOM } from 'jsdom';
import { describe, expect, test, vi } from 'vitest';

import { DANGER, guard, startCrawl, type CrawlStatus, type CrawlTarget } from '../src/app/crawler';
import type { Api } from '../src/shared/api';
import type { EdgeInput, Session, Settings, StateRef, VisitInput } from '../src/shared/types';

const ORIGIN = 'https://app.test';

// A small app: a home page with the menu, a list of authors with tabs and windows, author cards,
// and reports whose rows lead to a report by a click.
const pages: Record<string, string> = {
  '/': `<nav><a href="/authors">Авторы</a><a href="/reports">Отчёты</a><a href="/logout">Выйти</a>
    <a href="/bugspot/map">Карта</a></nav>
    <main><h1>Главная</h1><a href="/authors/7">Иванов</a><a href="/files/all.pdf">Выгрузка</a></main>`,
  '/authors': `<main><h1>Авторы</h1>
    <div role="tablist"><button role="tab" aria-selected="true" id="t1">Активные</button>
      <button role="tab" aria-selected="false" id="t2">Архив</button></div>
    <div role="tabpanel"><a href="/authors/8">Петров</a></div>
    <button type="button" aria-haspopup="dialog" id="new">Новый автор</button>
    <button type="button" aria-haspopup="dialog" id="del">Удалить всех</button>
    <button type="button" id="plain">Фильтры</button>
    <button type="button" id="icon"></button></main>
    <script>
      t2.addEventListener('click', () => { t1.setAttribute('aria-selected', 'false'); t2.setAttribute('aria-selected', 'true'); });
      t1.addEventListener('click', () => { t2.setAttribute('aria-selected', 'false'); t1.setAttribute('aria-selected', 'true'); });
      document.getElementById('new').addEventListener('click', () => {
        report('opened');
        const d = document.createElement('div');
        d.setAttribute('role', 'dialog');
        d.setAttribute('aria-label', 'Новый автор');
        d.innerHTML = '<h2>Новый автор</h2><form><input name="n"><button>Создать</button></form>';
        document.body.append(d);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') d.remove(); }, { once: true });
      });
      del.addEventListener('click', () => report('deleted'));
      plain.addEventListener('click', () => report('plain'));
      icon.addEventListener('click', () => report('icon'));
    </script>`,
  '/authors/{id}': `<main><h1>Автор</h1><a href="/authors">Назад</a></main>`,
  '/reports': `<main><h1>Отчёты</h1><table><thead><tr><th>Название</th></tr></thead>
    <tbody><tr id="row"><td style="cursor: pointer">Отчёт 5</td></tr></tbody></table></main>
    <script>
      row.addEventListener('click', () => {
        history.pushState({}, '', '/reports/5');
        document.body.innerHTML = '<main><h1>Отчёт</h1></main>';
      });
    </script>`,
  '/reports/{id}': `<main><h1>Отчёт</h1></main>`,
};

function fakeApp(events: string[], loaded: string[]): CrawlTarget {
  let current: JSDOM | null = null;
  return {
    win: () => (current ? (current.window as unknown as Window) : null),
    go: (url) => {
      setTimeout(() => {
        const path = new URL(url).pathname;
        const html = pages[path] ?? pages[path.replace(/\/\d+$/, '/{id}')] ?? '<h1>Не найдено</h1>';
        loaded.push(path);
        current = new JSDOM(html, {
          url,
          runScripts: 'dangerously',
          pretendToBeVisual: true,
          beforeParse(w) {
            Object.assign(w, { report: (e: string) => events.push(e) });
            w.HTMLElement.prototype.getBoundingClientRect = () =>
              ({
                x: 0,
                y: 0,
                left: 0,
                top: 0,
                width: 100,
                height: 20,
                right: 100,
                bottom: 20,
                toJSON: () => ({}),
              }) as DOMRect;
          },
        });
      }, 5);
    },
    refused: () => false,
    close: () => undefined,
  };
}

function fakeApi(visits: VisitInput[], edges: EdgeInput[], looks: StateRef[]): Api {
  const api = {
    base: `${ORIGIN}/bugspot/`,
    captures: async () => ({ states: [], aliases: {} }),
    map: async () => ({
      screens: [{ key: '/reports', exampleUrl: `${ORIGIN}/reports`, states: [] }],
      edges: [],
      aliases: {},
      threads: {},
    }),
    visits: async (v: VisitInput[], e: EdgeInput[]) => {
      visits.push(...v);
      edges.push(...e);
    },
    missingAssets: async (hashes: string[]) => ({ missing: hashes }),
    putAsset: async () => undefined,
    putSnapshot: async (ref: StateRef) => void looks.push(ref),
    putShot: async () => undefined,
  };
  return api as unknown as Api;
}

const session = {
  visible: true,
  can: { view: true, comment: true, reply: true, moderate: false, map: true, collect: true },
  map: { mask: 'none', snapshotMaxBytes: 8 << 20 },
} as Session;
const settings = { route: 'path', routeParams: [] } as unknown as Settings;

async function crawl(buttons: boolean) {
  const events: string[] = [];
  const loaded: string[] = [];
  const visits: VisitInput[] = [];
  const edges: EdgeInput[] = [];
  const looks: StateRef[] = [];
  const statuses: CrawlStatus[] = [];
  const run = startCrawl({
    api: fakeApi(visits, edges, looks),
    session,
    settings,
    target: fakeApp(events, loaded),
    options: { start: `${ORIGIN}/`, buttons, maxScreens: 20 },
    onStatus: (s) => statuses.push(s),
    quietMs: 30,
  });
  const status = await run.done;
  return { status, events, loaded, visits, edges, looks, statuses };
}

const has = (edges: EdgeInput[], from: string, to: string, source: string, name?: string) =>
  edges.some(
    (e) =>
      `${e.from.screen}|${e.from.state}` === from &&
      `${e.to.screen}|${e.to.state}` === to &&
      e.source === source &&
      (name === undefined || e.via.name === name),
  );

describe('crawler', () => {
  test('walks links, tabs, windows and rows, and never presses what is dangerous', async () => {
    const { status, events, loaded, visits, edges, looks } = await crawl(false);
    expect(status.phase).toBe('done');
    const screens = [...new Set(visits.map((v) => v.screen))].sort();
    expect(screens).toEqual(['/', '/authors', '/authors/{id}', '/reports', '/reports/{id}']);
    // Signing out, files and the service itself are not walked.
    expect(loaded).not.toContain('/logout');
    expect(loaded).not.toContain('/files/all.pdf');
    expect(loaded.some((p) => p.startsWith('/bugspot'))).toBe(false);
    // One card is enough for a screen with ids.
    expect(loaded.filter((p) => p.startsWith('/authors/')).length).toBe(1);

    const states = visits.filter((v) => v.screen === '/authors').map((v) => v.state);
    expect(states).toEqual(expect.arrayContaining(['tab:Активные', 'tab:Архив', 'dialog:Новый автор']));
    expect(has(edges, '/authors|tab:Активные', '/authors|tab:Архив', 'observed', 'Архив')).toBe(true);
    expect(has(edges, '/authors|tab:Активные', '/authors|dialog:Новый автор', 'observed', 'Новый автор')).toBe(true);
    // The row is named by its text without the trailing number.
    expect(has(edges, '/reports|', '/reports/{id}|', 'observed', 'Отчёт')).toBe(true);
    expect(has(edges, '/|', '/authors|', 'link', 'Авторы')).toBe(true);
    // A window's links are its own: the page's links do not start from it.
    expect(edges.some((e) => e.from.state === 'dialog:Новый автор' && e.source === 'link')).toBe(false);

    expect(events).toContain('opened');
    expect(events).not.toContain('deleted');
    expect(events).not.toContain('plain');
    expect(events).not.toContain('icon');
    expect(looks.length).toBeGreaterThanOrEqual(6);
    expect(status.screens).toBe(5);
    expect(status.map).toBe(`${ORIGIN}/bugspot/map`);
  }, 30_000);

  test('presses other buttons when asked, still not the dangerous or nameless ones', async () => {
    const { events } = await crawl(true);
    expect(events).toContain('plain');
    expect(events).not.toContain('deleted');
    expect(events).not.toContain('icon');
  }, 30_000);

  test('stops when asked and keeps what it found', async () => {
    const statuses: CrawlStatus[] = [];
    const visits: VisitInput[] = [];
    const run = startCrawl({
      api: fakeApi(visits, [], []),
      session,
      settings,
      target: fakeApp([], []),
      options: { start: `${ORIGIN}/`, buttons: false, maxScreens: 20 },
      onStatus: (s) => statuses.push(s),
      quietMs: 30,
    });
    setTimeout(run.stop, 400);
    const status = await run.done;
    expect(status.phase).toBe('stopped');
    expect(visits.length).toBeGreaterThan(0);
  }, 30_000);

  test('only reads leave the walked app', async () => {
    const w = new JSDOM('<p>app</p>', { url: `${ORIGIN}/` }).window;
    const sent = vi.fn(async () => new Response('ok'));
    Object.assign(w, { fetch: sent });
    const blocked: string[] = [];
    guard(w, (what) => blocked.push(what));
    await expect(w.fetch('/api/evaluation', { method: 'PUT' })).rejects.toThrow(TypeError);
    await expect(w.fetch(new Request(`${ORIGIN}/api/a`, { method: 'POST' }))).rejects.toThrow(TypeError);
    await w.fetch('/api/list');
    expect(sent).toHaveBeenCalledTimes(1);
    const xhr = new w.XMLHttpRequest();
    const failed = new Promise((resolve) => xhr.addEventListener('error', resolve));
    xhr.open('DELETE', '/api/item/1');
    xhr.send();
    await failed;
    expect(blocked).toEqual(['PUT /api/evaluation', `POST ${ORIGIN}/api/a`, 'DELETE xhr']);
    expect(w.confirm('Удалить?')).toBe(false);
  });

  test('danger words', () => {
    for (const name of [
      'Удалить',
      'Сохранить изменения',
      'Отправить',
      'Delete all',
      'Log out',
      'Оплатить',
      'Выйти',
      'Publish',
      'Place order',
    ])
      expect(DANGER.test(name), name).toBe(true);
    for (const name of ['Новый автор', 'Создать кампанию', 'Фильтры', 'Подробнее', 'Orders', 'Sprint', 'Открыть'])
      expect(DANGER.test(name), name).toBe(false);
  });
});
