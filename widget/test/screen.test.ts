import { beforeEach, describe, expect, test } from 'vitest';

import {
  accessibleName,
  cleanName,
  currentState,
  foldRoute,
  idLike,
  interactiveOf,
  linkScreen,
  outlineOf,
  routeKey,
  screenKeyOf,
  structureHash,
  viaOf,
} from '../src/lib/screen';

function size(el: Element, w = 100, h = 20) {
  el.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: w,
    height: h,
    right: w,
    bottom: h,
    toJSON: () => ({}),
  });
}

function sized(html: string) {
  document.body.innerHTML = html;
  for (const el of document.querySelectorAll('*')) size(el);
}

describe('screen keys', () => {
  test('id-like segments fold into {id}, names stay', () => {
    for (const id of ['42', '0193a6b2-7d1c-7a3e-9f00-1234567890ab', 'deadbeefcafe12', '01JD8ZK4Q9M2X7T6R5W3N1B0VC']) {
      expect(idLike(id), id).toBe(true);
    }
    for (const name of ['campaigns', 'scout', 'new-authors', 'v2', 'responses']) expect(idLike(name), name).toBe(false);
    expect(foldRoute('/author/0193a6b2-7d1c-7a3e-9f00-1234567890ab/edit')).toBe('/author/{id}/edit');
    expect(foldRoute('/tasks/scout/responses')).toBe('/tasks/scout/responses');
  });

  test('a hash router keys by the hash path; named query parameters make screens', () => {
    const loc = { pathname: '/admin/', search: '', hash: '#/candidates?tab=cold&page=2' };
    expect(routeKey({ route: 'auto' }, loc)).toBe('/candidates');
    expect(routeKey({ route: 'auto', params: ['tab'] }, loc)).toBe('/candidates?tab=cold');
    expect(routeKey({ route: 'path', params: ['q'] }, { pathname: '/a/7', search: '?q=1', hash: '' })).toBe(
      '/a/{id}?q=1',
    );
  });

  test('the app may name its screen with data-bugspot-screen', () => {
    document.body.innerHTML = '<main data-bugspot-screen="author-card"></main>';
    expect(screenKeyOf({ route: 'auto' }, { pathname: '/', search: '', hash: '#/author/7' })).toBe('author-card');
    document.body.innerHTML = '';
    expect(screenKeyOf({ route: 'auto' }, { pathname: '/', search: '', hash: '#/author/7' })).toBe('/author/{id}');
  });

  test('links lead to screens of the same site only', () => {
    const base = 'https://app.test/admin/#/campaigns';
    expect(linkScreen('#/author/12', { route: 'auto' }, base)).toBe('/author/{id}');
    expect(linkScreen('/other/path', { route: 'path' }, base)).toBe('/other/path');
    expect(linkScreen('https://vk.com/club1', { route: 'auto' }, base)).toBeNull();
    expect(linkScreen('mailto:a@b.c', { route: 'auto' }, base)).toBeNull();
    expect(linkScreen('#section', { route: 'path' }, 'https://app.test/page')).toBeNull();
  });
});

describe('names', () => {
  test('counters at the end of a name go', () => {
    expect(cleanName('  Отклики   авторов 3 ')).toBe('Отклики авторов');
    expect(cleanName('Новые бренды0')).toBe('Новые бренды');
    expect(cleanName('Кампании (12)')).toBe('Кампании');
    expect(cleanName('Волна 5 и 20 число')).toBe('Волна 5 и 20 число');
  });

  test('accessible names: aria-label, labelledby, text, title, alt', () => {
    document.body.innerHTML = `
      <button id="a" aria-label="Закрыть">×</button>
      <span id="lbl">Скачать отчёт</span><button id="b" aria-labelledby="lbl"></button>
      <button id="c"> Сохранить </button>
      <button id="d"><svg></svg><span title="Удалить"></span></button>
      <a id="e" href="/"><img alt="Логотип"></a>`;
    const name = (id: string) => accessibleName(document.getElementById(id)!);
    expect([name('a'), name('b'), name('c'), name('d'), name('e')]).toEqual([
      'Закрыть',
      'Скачать отчёт',
      'Сохранить',
      'Удалить',
      'Логотип',
    ]);
  });
});

describe('states', () => {
  beforeEach(() => document.body.replaceChildren());

  test('the page, a selected tab, an open dialog', () => {
    sized(`<main><div role="tablist"><button role="tab" aria-selected="false">Все</button>
      <button role="tab" aria-selected="true">Холодные отклики 3</button></div></main>`);
    expect(currentState()).toEqual({ key: 'tab:Холодные отклики', kind: 'tab', name: 'Холодные отклики' });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<h2>Отдать отклик скауту</h2><button>Отдать</button>';
    document.body.append(dialog);
    for (const el of dialog.querySelectorAll('*')) size(el);
    size(dialog);
    expect(currentState()).toEqual({
      key: 'dialog:Отдать отклик скауту',
      kind: 'dialog',
      name: 'Отдать отклик скауту',
    });
    dialog.remove();
    sized('<main><h1>Кампании</h1></main>');
    expect(currentState()).toEqual({ key: '', kind: 'page', name: '' });
  });

  test('tabs of the navigation are not states', () => {
    sized('<nav><a role="tab" aria-selected="true">Кампании</a></nav><main></main>');
    expect(currentState().kind).toBe('page');
  });

  test('a popup without a title that is not modal is not a window', () => {
    sized('<div role="dialog"><table><tr><td>1</td><td>2</td></tr></table></div>');
    expect(currentState().kind).toBe('page');
    sized('<div role="dialog" aria-modal="true"><p>Загрузка</p></div>');
    expect(currentState()).toEqual({ key: 'dialog:dialog', kind: 'dialog', name: 'dialog' });
  });

  test('a hidden dialog is not open', () => {
    sized('<div role="dialog" aria-label="Скрытое" hidden></div>');
    expect(currentState().kind).toBe('page');
  });
});

describe('transitions', () => {
  test('the element of a click and its kind', () => {
    document.body.innerHTML = `
      <nav><a id="menu" href="#/authors">Авторы</a></nav>
      <main><a id="link" href="#/author/7"><span id="inner">Иванов</span></a>
      <div role="tablist"><button id="tab" role="tab">Все</button></div>
      <button id="btn" aria-label="Создать"><svg id="icon"></svg></button>
      <div id="row" style="cursor:pointer"><span id="cell">Строка</span></div></main>`;
    const via = (id: string) => viaOf(interactiveOf(document.getElementById(id)!)!);
    expect(via('menu')).toMatchObject({ name: 'Авторы', kind: 'nav' });
    expect(via('inner')).toMatchObject({ name: 'Иванов', kind: 'link' });
    expect(via('tab')).toMatchObject({ name: 'Все', kind: 'tab' });
    expect(via('icon')).toMatchObject({ name: 'Создать', kind: 'button', selector: '#btn' });
    expect(via('cell')).toMatchObject({ name: 'Строка', kind: 'button' });
    expect(interactiveOf(document.querySelector('main')!)).toBeNull();
  });
});

describe('fingerprint and outline', () => {
  test('the structure hash ignores text but not layout', () => {
    document.body.innerHTML = '<main><h1>Кампании</h1><table><tr><td>1</td></tr></table></main>';
    const a = structureHash();
    document.querySelector('td')!.textContent = '2';
    expect(structureHash()).toBe(a);
    document.querySelector('main')!.append(document.createElement('section'));
    expect(structureHash()).not.toBe(a);
    const widget = document.createElement('bugspot-widget');
    widget.setAttribute('data-bugspot-ignore', '');
    const b = structureHash();
    document.body.append(widget);
    expect(structureHash()).toBe(b);
  });

  test('the outline lists what an agent needs to describe the screen', () => {
    document.body.innerHTML = `
      <main><h1>Пополнение базы</h1><h2>Холодные отклики</h2>
      <label for="q">Поиск</label><input id="q"><input type="hidden" name="secret">
      <button>Отдать скауту</button><button>Отдать скауту</button><a href="#/author/1">Иванов</a>
      <table><tr><th>Автор</th><th>Скаут 2</th></tr></table></main>`;
    const o = outlineOf();
    expect(o.title).toBe('Пополнение базы');
    expect(o.headings).toEqual(['Пополнение базы', 'Холодные отклики']);
    expect(o.actions).toEqual(['Отдать скауту', 'Иванов']);
    expect(o.fields).toEqual(['Поиск']);
    expect(o.tables).toEqual([{ headers: ['Автор', 'Скаут'] }]);
  });
});
