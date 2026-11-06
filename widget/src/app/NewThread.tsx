import {
  Button,
  Callout,
  Checkbox,
  Classes,
  FormGroup,
  InputGroup,
  SegmentedControl,
  Spinner,
  TextArea,
} from '@blueprintjs/core';
import { useEffect, useRef, useState } from 'react';

import { captureTab, captureViewport, type Shot } from '../lib/screenshot';
import { ApiError } from '../shared/api';
import type { Kind, Thread } from '../shared/types';
import type { View } from './App';
import { useWidget } from './context';

type ShotState = { kind: 'pending' } | { kind: 'ready'; shot: Shot } | { kind: 'failed'; message: string };

export function NewThread({
  view,
  route,
  onCancel,
  onCreated,
}: {
  view: Extract<View, { kind: 'new' }>;
  route: string;
  onCancel: () => void;
  onCreated: (t: Thread) => void;
}) {
  const { api, t, session, host } = useWidget();
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<Kind>('issue');
  const [name, setName] = useState('');
  const [attach, setAttach] = useState(true);
  const [shot, setShot] = useState<ShotState>({ kind: 'pending' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const maxBytes = session.limits?.screenshotMaxBytes ?? 3 << 20;
  const anonymous = session.user?.provider === 'anonymous';
  const shotUrl = useRef<string | null>(null);

  const take = async (how: 'dom' | 'tab') => {
    setShot({ kind: 'pending' });
    try {
      // Let the panel finish rendering: the screenshot leaves the widget out anyway.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const next =
        how === 'dom' ? await captureViewport(host, view.target, view.point, maxBytes) : await captureTab(maxBytes);
      if (shotUrl.current) URL.revokeObjectURL(shotUrl.current);
      shotUrl.current = next.url;
      setShot({ kind: 'ready', shot: next });
    } catch (e) {
      setShot({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  };

  useEffect(() => {
    void take('dom');
    return () => {
      if (shotUrl.current) URL.revokeObjectURL(shotUrl.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.target]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const thread = await api.create({
        route,
        url: location.href,
        title: document.title.slice(0, 300),
        kind,
        body: body.trim(),
        anchor: view.anchor,
        context: view.context,
        authorName: anonymous && name.trim() ? name.trim() : undefined,
      });
      if (attach && shot.kind === 'ready') {
        await api.putScreenshot(thread.id, shot.shot.blob).catch(() => undefined);
      }
      onCreated(thread);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const element = view.anchor.text ? `${view.anchor.tag} «${view.anchor.text}»` : view.anchor.tag;
  return (
    <form
      className="bugspot-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim()) void submit();
      }}
    >
      <div className={`bugspot-meta ${Classes.TEXT_MUTED}`}>
        {t.element}: <span className="bugspot-code">{element}</span>
      </div>
      <SegmentedControl
        fill
        size="small"
        value={kind}
        onValueChange={(v) => setKind(v as Kind)}
        options={(['issue', 'question', 'idea'] as Kind[]).map((k) => ({ value: k, label: t.kind[k] }))}
      />
      <TextArea
        autoFocus
        fill
        autoResize
        rows={4}
        maxLength={session.limits?.bodyMaxLength}
        placeholder={t.bodyPlaceholder}
        value={body}
        onChange={(e) => setBody(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) void submit();
        }}
      />
      {anonymous && (
        <FormGroup label={t.yourName}>
          <InputGroup value={name} maxLength={80} onValueChange={setName} />
        </FormGroup>
      )}
      <Checkbox checked={attach} label={t.attachScreenshot} onChange={(e) => setAttach(e.currentTarget.checked)} />
      {attach && (
        <div className="bugspot-preview">
          {shot.kind === 'pending' && (
            <div className="bugspot-preview-wait">
              <Spinner size={20} /> {t.capturing}
            </div>
          )}
          {shot.kind === 'ready' && <img src={shot.shot.url} alt={t.screenshot} />}
          {shot.kind === 'failed' && (
            <Callout intent="warning" compact>
              {t.screenshotFailed}: {shot.message}
            </Callout>
          )}
          <div className="bugspot-preview-actions">
            <Button size="small" icon="refresh" text={t.retake} onClick={() => void take('dom')} />
            {'getDisplayMedia' in (navigator.mediaDevices ?? {}) && (
              <Button size="small" icon="camera" text={t.captureTab} onClick={() => void take('tab')} />
            )}
          </div>
        </div>
      )}
      {error && (
        <Callout intent="danger" compact>
          {error}
        </Callout>
      )}
      <div className="bugspot-form-actions">
        <Button text={t.cancel} onClick={onCancel} />
        <Button
          type="submit"
          intent="primary"
          icon="send-message"
          text={t.send}
          loading={busy}
          disabled={!body.trim()}
        />
      </div>
    </form>
  );
}
