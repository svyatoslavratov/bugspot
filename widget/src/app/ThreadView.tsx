import {
  Alert,
  Button,
  ButtonGroup,
  Callout,
  Classes,
  Divider,
  Menu,
  MenuItem,
  NonIdealState,
  Popover,
  Spinner,
  TextArea,
} from '@blueprintjs/core';
import { useState } from 'react';

import { pinPoint, resolveAnchor } from '../lib/anchor';
import { when } from '../lib/i18n';
import { ApiError } from '../shared/api';
import type { Status, Thread } from '../shared/types';
import { ContextInfo } from './ContextInfo';
import { useWidget } from './context';
import { KindIcon, StatusTag, statusIntent } from './labels';
import { Screenshot } from './Screenshot';
import { useData } from './useData';

/** Scrolls to the thread's element and flashes it. */
function showOnPage(thread: Thread) {
  const el = resolveAnchor(thread.anchor);
  if (el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.animate?.(
      [
        { outline: '3px solid #cd4246', outlineOffset: '2px' },
        { outline: '3px solid transparent', outlineOffset: '6px' },
      ],
      { duration: 1200, iterations: 2 },
    );
    return;
  }
  const point = pinPoint(thread.anchor, null);
  if (point) scrollTo({ top: Math.max(0, point.y + scrollY - innerHeight / 2), behavior: 'smooth' });
}

export function ThreadView({
  id,
  version,
  currentRoute,
  onBack,
  onChanged,
  onGo,
}: {
  id: string;
  version: number;
  currentRoute: string;
  onBack: () => void;
  onChanged: () => void;
  onGo: (thread: Thread) => void;
}) {
  const { api, t, settings } = useWidget();
  const detail = useData(() => api.thread(id), [id, version]);
  const [reply, setReply] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      detail.reload();
      onChanged();
      after?.();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const back = <Button icon="arrow-left" variant="minimal" text={t.back} onClick={onBack} />;
  if (detail.error && !detail.data) {
    return (
      <>
        {back}
        <NonIdealState icon="error" title={t.loadError} description={detail.error} />
      </>
    );
  }
  const thread = detail.data;
  if (!thread) return <Spinner size={24} className="bugspot-spinner" />;
  const here = thread.route === currentRoute;
  const detached = here && !resolveAnchor(thread.anchor);

  return (
    <div className="bugspot-thread">
      <div className="bugspot-thread-nav">
        {back}
        <span className="bugspot-number">#{thread.number}</span>
        <KindIcon kind={thread.kind} />
        <StatusTag status={thread.status} />
        {here ? (
          <Button icon="map-marker" variant="minimal" text={t.showOnPage} onClick={() => showOnPage(thread)} />
        ) : (
          <Button icon="link" variant="minimal" text={t.openPage} onClick={() => onGo(thread)} />
        )}
      </div>
      {detached && (
        <Callout intent="warning" compact icon="warning-sign">
          {t.detached}
          {thread.anchor.text ? `: «${thread.anchor.text}»` : ''}
        </Callout>
      )}
      {error && (
        <Callout intent="danger" compact>
          {error}
        </Callout>
      )}

      <div className={`bugspot-meta ${Classes.TEXT_MUTED}`}>
        {thread.author.name} · {when(thread.createdAt, t, settings.lang)} · {thread.route}
      </div>
      {editing === null ? (
        <p className="bugspot-thread-body">{thread.body}</p>
      ) : (
        <div className="bugspot-edit">
          <TextArea fill autoResize value={editing} onChange={(e) => setEditing(e.currentTarget.value)} />
          <ButtonGroup>
            <Button
              intent="primary"
              text={t.save}
              loading={busy}
              disabled={!editing.trim()}
              onClick={() =>
                void act(
                  () => api.update(thread.id, { body: editing }),
                  () => setEditing(null),
                )
              }
            />
            <Button text={t.cancel} onClick={() => setEditing(null)} />
          </ButtonGroup>
        </div>
      )}

      <div className="bugspot-actions">
        {thread.allowed.statuses.length > 0 && (
          <Popover
            placement="bottom-start"
            content={
              <Menu>
                {thread.allowed.statuses.map((s: Status) => (
                  <MenuItem
                    key={s}
                    text={t.status[s]}
                    intent={statusIntent[s]}
                    onClick={() => void act(() => api.update(thread.id, { status: s }))}
                  />
                ))}
              </Menu>
            }
          >
            <Button endIcon="caret-down" text={t.setStatus} loading={busy} />
          </Popover>
        )}
        {thread.allowed.edit && editing === null && (
          <Button icon="edit" variant="minimal" text={t.edit} onClick={() => setEditing(thread.body)} />
        )}
        {thread.allowed.delete && (
          <Button
            icon="trash"
            variant="minimal"
            intent="danger"
            text={t.delete}
            onClick={() => setConfirmDelete(true)}
          />
        )}
      </div>
      {thread.statusBy && thread.statusAt && (
        <div className={`bugspot-meta ${Classes.TEXT_MUTED}`}>
          {t.statusChanged}: {t.status[thread.status]} — {thread.statusBy.name}
          {thread.statusBy.kind === 'agent' ? ` (${t.agent})` : ''}, {when(thread.statusAt, t, settings.lang)}
        </div>
      )}

      {thread.hasScreenshot && <Screenshot threadId={thread.id} version={thread.updatedAt} />}
      <ContextInfo context={thread.context} anchor={thread.anchor} />

      <Divider />
      <h4 className={Classes.HEADING}>
        {t.replies} {thread.replies.length > 0 && `· ${thread.replies.length}`}
      </h4>
      <div className="bugspot-replies">
        {thread.replies.map((r) => (
          <div key={r.id} className={`bugspot-reply ${r.author.kind === 'agent' ? 'is-agent' : ''}`}>
            <div className={`bugspot-meta ${Classes.TEXT_MUTED}`}>
              {r.author.name}
              {r.author.kind === 'agent' ? ` · ${t.agent}` : ''} · {when(r.createdAt, t, settings.lang)}
            </div>
            <p>{r.body}</p>
          </div>
        ))}
      </div>
      {thread.allowed.reply && (
        <div className="bugspot-reply-form">
          <TextArea
            fill
            autoResize
            placeholder={t.replyPlaceholder}
            value={reply}
            onChange={(e) => setReply(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && reply.trim()) {
                void act(
                  () => api.reply(thread.id, reply.trim()),
                  () => setReply(''),
                );
              }
            }}
          />
          <Button
            icon="send-message"
            intent="primary"
            text={t.reply}
            loading={busy}
            disabled={!reply.trim()}
            onClick={() =>
              void act(
                () => api.reply(thread.id, reply.trim()),
                () => setReply(''),
              )
            }
          />
        </div>
      )}
      <Alert
        isOpen={confirmDelete}
        intent="danger"
        icon="trash"
        confirmButtonText={t.delete}
        cancelButtonText={t.cancel}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void act(() => api.remove(thread.id), onBack);
        }}
      >
        {t.deleteConfirm}
      </Alert>
    </div>
  );
}
