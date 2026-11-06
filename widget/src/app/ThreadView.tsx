import {
  Alert,
  Button,
  ButtonGroup,
  Callout,
  Checkbox,
  Classes,
  Divider,
  NonIdealState,
  Spinner,
  TextArea,
  Tooltip,
} from '@blueprintjs/core';
import { useState } from 'react';

import { anchorsOf, resolveAnchor } from '../lib/anchor';
import { when } from '../lib/i18n';
import { ApiError } from '../shared/api';
import type { Thread } from '../shared/types';
import { ContextInfo } from './ContextInfo';
import { useWidget } from './context';
import { KindPicker, StatusPicker } from './labels';
import { Screenshot } from './Screenshot';
import { useData } from './useData';

export function ThreadView({
  id,
  version,
  currentRoute,
  onBack,
  onChanged,
  onGo,
  onShow,
}: {
  id: string;
  version: number;
  currentRoute: string;
  onBack: () => void;
  onChanged: () => void;
  onGo: (thread: Thread) => void;
  onShow: (thread: Thread) => void;
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

  const back = (
    <Tooltip content={t.back} placement="bottom">
      <Button icon="arrow-left" variant="minimal" aria-label={t.back} onClick={onBack} />
    </Tooltip>
  );
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
  // Detached when none of the thread's elements is on the page any more.
  const detached = here && anchorsOf(thread.anchor).every((a) => !resolveAnchor(a));

  const save = (body: string) =>
    void act(
      () => api.update(thread.id, { body: body.trim() }),
      () => setEditing(null),
    );

  return (
    <div className="bugspot-thread">
      <div className="bugspot-thread-nav">
        {back}
        <span className="bugspot-number">#{thread.number}</span>
        <KindPicker
          kind={thread.kind}
          editable={thread.allowed.edit}
          onChange={(kind) => void act(() => api.update(thread.id, { kind }))}
        />
        <StatusPicker
          status={thread.status}
          options={thread.allowed.statuses}
          busy={busy}
          onChange={(status) => void act(() => api.update(thread.id, { status }))}
        />
        {here ? (
          <Button icon="map-marker" variant="minimal" text={t.showOnPage} onClick={() => onShow(thread)} />
        ) : (
          <Button icon="link" variant="minimal" text={t.openPage} onClick={() => onGo(thread)} />
        )}
        {thread.allowed.delete && (
          <Tooltip content={t.delete} placement="bottom" className="bugspot-push-right">
            <Button
              icon="trash"
              variant="minimal"
              intent="danger"
              aria-label={t.delete}
              onClick={() => setConfirmDelete(true)}
            />
          </Tooltip>
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
        thread.allowed.edit ? (
          // The text itself is the edit button: a click turns it into a field.
          <button
            type="button"
            className="bugspot-thread-body is-editable"
            title={t.clickToEdit}
            onClick={() => setEditing(thread.body)}
          >
            {thread.body}
          </button>
        ) : (
          <p className="bugspot-thread-body">{thread.body}</p>
        )
      ) : (
        <div className="bugspot-edit">
          <TextArea
            fill
            autoResize
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(null);
              }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && editing.trim()) save(editing);
            }}
          />
          <ButtonGroup>
            <Button
              intent="primary"
              text={t.save}
              loading={busy}
              disabled={!editing.trim()}
              onClick={() => save(editing)}
            />
            <Button text={t.cancel} onClick={() => setEditing(null)} />
          </ButtonGroup>
        </div>
      )}

      {thread.statusBy && thread.statusAt && (
        <div className={`bugspot-meta ${Classes.TEXT_MUTED}`}>
          {t.statusChanged}: {t.status[thread.status]} — {thread.statusBy.name}
          {thread.statusBy.kind === 'agent' ? ` (${t.agent})` : ''}, {when(thread.statusAt, t, settings.lang)}
        </div>
      )}

      <Checkbox
        className="bugspot-verified"
        checked={thread.verified}
        disabled={!thread.allowed.verify || busy}
        onChange={(e) => {
          const verified = e.currentTarget.checked;
          void act(() => api.update(thread.id, { verified }));
        }}
        labelElement={
          <>
            {t.verified}
            {thread.verifiedBy && thread.verifiedAt && (
              <span className={`bugspot-meta ${Classes.TEXT_MUTED}`}>
                {' '}
                · {t.verifiedBy(thread.verifiedBy.name)}, {when(thread.verifiedAt, t, settings.lang)}
              </span>
            )}
          </>
        }
      />

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
