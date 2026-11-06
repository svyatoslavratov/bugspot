import { expect, test } from 'vitest';

import { redactUrl } from '../src/shared/capture';
import { currentRoute } from '../src/lib/route';

test('routes: hash routers by the hash path, others by the pathname', () => {
  expect(currentRoute('auto', { pathname: '/admin/', hash: '#/campaigns?tab=2' })).toBe('/campaigns');
  expect(currentRoute('auto', { pathname: '/campaigns', hash: '#section' })).toBe('/campaigns');
  expect(currentRoute('path', { pathname: '/x', hash: '#/y' })).toBe('/x');
  expect(currentRoute('hash', { pathname: '/x', hash: '' })).toBe('/');
});

test('captured URLs keep parameter names only', () => {
  expect(redactUrl('/api/authors?search=Ivanov&page=2')).toBe('/api/authors?search=…&page=…');
  expect(redactUrl('https://other.example/a?token=secret')).toBe('https://other.example/a?token=…');
});
