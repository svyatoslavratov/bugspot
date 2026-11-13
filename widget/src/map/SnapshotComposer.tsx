import { Button, Callout, Checkbox, SegmentedControl, TextArea } from '@blueprintjs/core';
import { useEffect, useState } from 'react';

import { useWidget } from '../app/context';
import { textOf, selectorOf } from '../lib/anchor';
import { fit } from '../lib/screenshot';
import { ApiError } from '../shared/api';
import type { Anchor, Kind, PageContext, Point, Screen, Thread } from '../shared/types';
import { useMap } from './context';
import { screenLabel } from './layout';

export interface Picked {
  el: Element;
  point: Point;
}

/** The part of the snapshot around the element, with the element framed, as the thread screenshot. */
async function captureSnapshot(el: Element, point: Point, maxBytes: number): Promise<Blob | null> {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (!win) return null;
  const { domToCanvas } = await import('modern-screenshot');
  const vw = win.innerWidth;
  const vh = Math.min(win.innerHeight, Math.round(vw * 0.625));
  const rect = el.getBoundingClientRect();
  const full = doc.documentElement.scrollHeight;
  const top = Math.max(0, Math.min(rect.top + rect.height / 2 - vh / 2, full - vh));
  const scale = Math.min(1, 1600 / vw);
  const canvas = await domToCanvas(doc.documentElement, {
    width: vw,
    height: vh,
    scale,
    backgroundColor: win.getComputedStyle(doc.body).backgroundColor || '#ffffff',
    style: { transform: `translate(0, ${-top}px)` },
    timeout: 8000,
    workerNumber: 0,
  });
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.save();
    ctx.scale(scale, scale);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#cd4246';
    ctx.strokeRect(rect.left - 3, rect.top - top - 3, rect.width + 6, rect.height + 6);
    ctx.fillStyle = '#cd4246';
    ctx.beginPath();
    ctx.arc(point.x, point.y - top, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  return fit(canvas, maxBytes);
}

/**
 * A comment on an element of a snapshot. It is an ordinary thread of the screen: the same anchor
 * pins it on the real page of the app, on every page of that screen.
 */
export function SnapshotComposer({
  screen,
  state,
  picked,
  onCancel,
  onCreated,
}: {
  screen: Screen;
  state: string;
  picked: Picked & { anchor: Anchor };
  onCancel: () => void;
  onCreated: (thread: Thread) => void;
}) {
  const { api, session, t: wt } = useWidget();
  const { t } = useMap();
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<Kind>('issue');
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<Promise<Blob | null> | null>(null);
  const maxBytes = session.limits?.screenshotMaxBytes ?? 3 << 20;

  useEffect(() => {
    setShot(captureSnapshot(picked.el, picked.point, maxBytes).catch(() => null));
  }, [picked.el, picked.point, maxBytes]);

  const send = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    const win = picked.el.ownerDocument.defaultView;
    const rect = picked.el.getBoundingClientRect();
    const context: PageContext = {
      userAgent: navigator.userAgent,
      language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      viewport: { w: win?.innerWidth ?? 0, h: win?.innerHeight ?? 0, dpr: devicePixelRatio },
      screen: { w: window.screen.width, h: window.screen.height },
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      element: {
        tag: picked.el.tagName.toLowerCase(),
        text: textOf(picked.el),
        selector: selectorOf(picked.el, picked.el.ownerDocument),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      },
      console: [],
      network: [],
    };
    try {
      const thread = await api.create({
        route: screen.exampleRoute || (screen.key.startsWith('/') ? screen.key : '/'),
        screen: screen.key,
        url: screen.exampleUrl || location.href,
        title: (screen.title || screenLabel(screen)).slice(0, 300),
        kind,
        body: body.trim(),
        anchor: state ? { ...picked.anchor, state } : picked.anchor,
        context,
      });
      if (attach) {
        const blob = await shot;
        if (blob) await api.putScreenshot(thread.id, blob).catch(() => undefined);
      }
      onCreated(thread);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="map-composer">
      <div className="map-section-label">
        {wt.element}: {picked.anchor.tag}
        {picked.anchor.text ? ` «${picked.anchor.text}»` : ''}
      </div>
      <SegmentedControl
        small
        value={kind}
        onValueChange={(v) => setKind(v as Kind)}
        options={[
          { value: 'issue', label: t.kindIssue },
          { value: 'question', label: t.kindQuestion },
          { value: 'idea', label: t.kindIdea },
        ]}
      />
      <TextArea
        autoFocus
        fill
        rows={5}
        placeholder={t.commentPlaceholder}
        value={body}
        maxLength={session.limits?.bodyMaxLength}
        onChange={(e) => setBody(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <Checkbox checked={attach} label={wt.attachScreenshot} onChange={(e) => setAttach(e.currentTarget.checked)} />
      {error && (
        <Callout intent="danger" compact>
          {error}
        </Callout>
      )}
      <div className="bugspot-form-actions">
        <Button text={t.cancel} variant="minimal" onClick={onCancel} />
        <Button
          intent="primary"
          icon="send-message"
          text={t.send}
          loading={busy}
          disabled={!body.trim()}
          onClick={() => void send()}
        />
      </div>
    </div>
  );
}
