import type { Capture } from '../shared/capture';
import type { PageContext } from '../shared/types';
import { selectorOf, textOf } from './anchor';

/** Collects what a developer needs to reproduce the report. */
export function pageContext(capture: Capture, appVersion: string | undefined, el?: Element): PageContext {
  const rect = el?.getBoundingClientRect();
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    screen: { w: screen.width, h: screen.height },
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    appVersion,
    element:
      el && rect
        ? {
            tag: el.tagName.toLowerCase(),
            text: textOf(el),
            selector: selectorOf(el),
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            },
          }
        : undefined,
    console: capture.console.slice(-20),
    network: capture.network.slice(-20),
  };
}

/** A short "Chrome 141 · macOS" for the context panel. */
export function browserLabel(ua: string): string {
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[0].replace('Edg/', 'Edge ') ??
    /Firefox\/(\d+)/.exec(ua)?.[0].replace('/', ' ') ??
    /Chrome\/(\d+)/.exec(ua)?.[0].replace('/', ' ') ??
    (/Version\/(\d+).*Safari/.exec(ua) ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}` : 'Browser');
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? /Mobile/.test(ua)
        ? 'iOS'
        : 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Linux/.test(ua)
          ? 'Linux'
          : '';
  return os ? `${browser} · ${os}` : browser;
}
