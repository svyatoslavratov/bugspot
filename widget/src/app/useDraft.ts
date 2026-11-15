import { useEffect, useRef, useState } from 'react';

import { captureTab, captureViewport, type Shot } from '../lib/screenshot';
import { ApiError } from '../shared/api';
import type { Anchor, Kind, PageContext, Thread } from '../shared/types';
import { useWidget } from './context';
import type { Pick } from './Picker';

/** The picked elements a new comment is about. */
export interface Target {
  picks: Pick[];
  /** The screen of the map the page belongs to. */
  screen?: string;
  anchor: Anchor;
  context: PageContext;
}

/** Text and kind carried from the tiny box to the full form. */
export interface Draft {
  body: string;
  kind: Kind;
}

export type ShotState = { kind: 'pending' } | { kind: 'ready'; shot: Shot } | { kind: 'failed'; message: string };

/**
 * A new comment being written, shared by the full form and the tiny box: the text, the kind, the
 * screenshot taken at once in the background, and sending (which waits for a capture in progress,
 * so a quick send still attaches the screenshot).
 */
export function useDraft(target: Target, route: string, initial?: Draft) {
  const { api, session, host } = useWidget();
  const [body, setBody] = useState(initial?.body ?? '');
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'issue');
  const [name, setName] = useState('');
  const [attach, setAttach] = useState(true);
  const [shot, setShot] = useState<ShotState>({ kind: 'pending' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const maxBytes = session.limits?.screenshotMaxBytes ?? 3 << 20;
  const anonymous = session.user?.provider === 'anonymous';
  const shotUrl = useRef<string | null>(null);
  const capturing = useRef<Promise<Shot | null> | null>(null);

  const capture = async (how: 'dom' | 'tab'): Promise<Shot | null> => {
    setShot({ kind: 'pending' });
    try {
      // Let the form finish rendering: the screenshot leaves the widget out anyway.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const next = how === 'dom' ? await captureViewport(host, target.picks, maxBytes) : await captureTab(maxBytes);
      if (shotUrl.current) URL.revokeObjectURL(shotUrl.current);
      shotUrl.current = next.url;
      setShot({ kind: 'ready', shot: next });
      return next;
    } catch (e) {
      setShot({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };
  const take = (how: 'dom' | 'tab') => {
    const run = capture(how);
    capturing.current = run;
    return run;
  };

  useEffect(() => {
    void take('dom');
    return () => {
      if (shotUrl.current) URL.revokeObjectURL(shotUrl.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.picks]);

  const submit = async (onCreated: (t: Thread) => void) => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const thread = await api.create({
        route,
        screen: target.screen,
        url: location.href,
        title: document.title.slice(0, 300),
        kind,
        body: body.trim(),
        anchor: target.anchor,
        context: target.context,
        authorName: anonymous && name.trim() ? name.trim() : undefined,
      });
      if (attach) {
        const ready = shot.kind === 'ready' ? shot.shot : await capturing.current;
        if (ready) await api.putScreenshot(thread.id, ready.blob).catch(() => undefined);
      }
      onCreated(thread);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return {
    body,
    setBody,
    kind,
    setKind,
    name,
    setName,
    attach,
    setAttach,
    shot,
    take,
    busy,
    error,
    submit,
    anonymous,
    maxLength: session.limits?.bodyMaxLength,
  };
}

/** "label «Save»" or "label «Save» and 2 more" for the picked elements. */
export function describeTarget(anchor: Anchor, andMore: (n: number) => string): string {
  const first = anchor.text ? `${anchor.tag} «${anchor.text}»` : anchor.tag;
  const more = anchor.more?.length ?? 0;
  return more ? `${first} ${andMore(more)}` : first;
}
