import { expect, test } from 'vitest';

import { absoluteCss, maskText, serializeDocument, sha256 } from '../src/lib/snapshot';

test('css urls become absolute against the stylesheet', () => {
  expect(
    absoluteCss(
      'a{background:url(img/x.png)} b{src:url("/f.woff2")} c{x:url(data:image/png;base64,AA)}',
      'https://app.test/css/s.css',
    ),
  ).toBe(
    'a{background:url(https://app.test/css/img/x.png)} b{src:url("https://app.test/f.woff2")} c{x:url(data:image/png;base64,AA)}',
  );
});

test('masked text keeps its whitespace', () => {
  expect(maskText('Иван Петров')).toBe('•••• ••••••');
});

test('a snapshot: no scripts or handlers, absolute URLs, typed values masked, styles as assets', async () => {
  document.head.innerHTML = '<style>.x{color:red}</style><script>alert(1)</script>';
  document.body.innerHTML = `
    <main onclick="steal()">
      <img src="/a.png" loading="lazy" srcset="/a.png 1x, /a@2x.png 2x">
      <a href="#/author/1">Иванов</a><a href="javascript:void(0)">x</a>
      <input id="name" value="старое"><input type="password" id="pw">
      <input type="checkbox" id="cb"><textarea id="ta"></textarea>
      <p data-bugspot-mask>Секрет</p>
      <iframe src="https://other.test"></iframe>
      <form action="/send"><button type="submit">Отправить</button></form>
    </main>
    <bugspot-widget data-bugspot-ignore><span>widget</span></bugspot-widget>`;
  (document.getElementById('name') as HTMLInputElement).value = 'Анна';
  (document.getElementById('pw') as HTMLInputElement).value = 'secret';
  (document.getElementById('cb') as HTMLInputElement).checked = true;
  (document.getElementById('ta') as HTMLTextAreaElement).value = 'Текст';

  const snap = await serializeDocument(document, { mask: 'inputs' });
  const html = snap.html;
  expect(html.startsWith('<!DOCTYPE html><html')).toBe(true);
  expect(html).not.toMatch(/<script|onclick|steal|javascript:|loading=|action=/);
  expect(html).toContain(`src="${location.origin}/a.png"`);
  expect(html).toContain(`srcset="${location.origin}/a.png 1x, ${location.origin}/a@2x.png 2x"`);
  expect(html).toContain('value="••••"');
  expect(html).not.toContain('secret');
  expect(html).toContain('checked');
  expect(html).toContain('>•••••</textarea>');
  expect(html).toContain('>••••••</p>');
  expect(html).toContain('data-bugspot-frame');
  expect(html).not.toContain('widget');
  expect(snap.css).toHaveLength(1);
  expect(snap.css[0].text).toContain('color: red');
  expect(snap.css[0].hash).toBe(await sha256(snap.css[0].text));
  expect(html).toContain(`<style data-bugspot-asset="${snap.css[0].hash}"></style>`);

  const plain = await serializeDocument(document, { mask: 'none' });
  expect(plain.html).toContain('value="Анна"');
  expect(plain.html).not.toContain('secret');
  const text = await serializeDocument(document, { mask: 'text' });
  expect(text.html).not.toContain('Иванов');
});
