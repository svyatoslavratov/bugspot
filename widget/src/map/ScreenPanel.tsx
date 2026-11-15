// The panel of a screen: what it is called, which section it belongs to and what it is for, its
// states, where it leads and what leads to it, and its threads.

import {
  AnchorButton,
  Button,
  Callout,
  Card,
  EditableText,
  H4,
  HTMLSelect,
  Icon,
  InputGroup,
  Popover,
  Tag,
  TextArea,
} from '@blueprintjs/core';
import { useEffect, useId, useMemo, useState } from 'react';

import { useWidget } from '../app/context';
import { statusIntent } from '../app/labels';
import { ThreadView } from '../app/ThreadView';
import { useData } from '../app/useData';
import { ApiError } from '../shared/api';
import {
  ACTIVE_STATUSES,
  type Screen,
  type ScreenMap,
  type ScreenPatch,
  type ScreenState,
  type Edge,
} from '../shared/types';
import { useMap } from './context';
import { screenBack } from './history';
import { coverOf, screenLabel } from './layout';
import { Thumbnail } from './nodes';

interface Link {
  screen: string;
  names: string[];
  kind: Edge['source'] | 'nav';
}

const kindRank = { link: 0, nav: 1, observed: 2, declared: 3 } as const;

/** Transitions of the screen to (or from) other screens, one row per screen; the menu only when asked. */
export function linksOf(map: ScreenMap, key: string, dir: 'out' | 'in', auto: string, nav: boolean): Link[] {
  const out = new Map<string, Link>();
  for (const e of map.edges) {
    const [here, there] = dir === 'out' ? [e.from.screen, e.to.screen] : [e.to.screen, e.from.screen];
    if (here !== key || there === key || (e.via.kind === 'nav' && !nav)) continue;
    const link = out.get(there) ?? { screen: there, names: [], kind: 'link' as Link['kind'] };
    const kind = e.via.kind === 'nav' ? 'nav' : e.source;
    if (kindRank[kind] > kindRank[link.kind]) link.kind = kind;
    const name = e.via.name || (e.via.kind === 'auto' ? auto : '');
    if (name && !link.names.includes(name)) link.names.push(name);
    out.set(there, link);
  }
  return [...out.values()].sort((a, b) => kindRank[b.kind] - kindRank[a.kind]);
}

/** A text saved when the field is left (or with Ctrl/⌘+Enter), not on every key. */
function useDraft(value: string, save: (v: string) => void) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if (v !== value) save(v);
  };
  return { draft, setDraft, commit };
}

export function ScreenPanel({
  map,
  screen,
  version,
  showNav,
  thread: initialThread,
  onClose,
  onSelect,
  onOpen,
  onChanged,
  onEdit,
  onMerged,
}: {
  map: ScreenMap;
  screen: Screen;
  version: number;
  /** Transitions through the app's menu too. */
  showNav: boolean;
  /** A thread to open at once: a pin clicked on the canvas. */
  thread?: string | null;
  onClose: () => void;
  /** Go to another screen: select it and bring it into view. */
  onSelect: (key: string) => void;
  onOpen: (state: string) => void;
  onChanged: () => void;
  /** Makes a change and remembers how to take it back (Ctrl/⌘+Z). */
  onEdit: (label: string, apply: () => Promise<unknown>, revert: () => Promise<unknown>) => Promise<void>;
  /** The screen was merged into another one. */
  onMerged: (target: string) => void;
}) {
  const { api, session } = useWidget();
  const { t } = useMap();
  const canEdit = session.can?.map ?? false;
  const listId = useId();
  const [error, setError] = useState<string | null>(null);
  const [thread, setThread] = useState<string | null>(initialThread ?? null);
  const [mergeTarget, setMergeTarget] = useState('');
  const threads = useData(
    () => api.threads({ screen: screen.key, route: screen.exampleRoute, status: ACTIVE_STATUSES, limit: 100 }),
    [screen.key, version],
  );
  const leads = useMemo(
    () => linksOf(map, screen.key, 'out', t.viaAuto, showNav),
    [map, screen.key, t.viaAuto, showNav],
  );
  const comes = useMemo(
    () => linksOf(map, screen.key, 'in', t.viaAuto, showNav),
    [map, screen.key, t.viaAuto, showNav],
  );
  const sections = useMemo(() => [...new Set(map.screens.map((s) => s.section).filter(Boolean))].sort(), [map]);
  // A state only links pointed at (never seen, no look) says nothing about the screen.
  const states = screen.states.filter((s) => s.hasShot || s.hasSnapshot || s.lastSeen || s.description);
  const byKey = useMemo(() => new Map(map.screens.map((s) => [s.key, s])), [map]);

  const fail = (e: unknown) => setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
  const label = screenLabel(screen);
  const save = (what: string, patch: Omit<ScreenPatch, 'key'>) => {
    setError(null);
    const back = screenBack(screen, patch);
    onEdit(
      what,
      () => api.patchScreens([{ key: screen.key, ...patch }]),
      () => api.patchScreens([{ key: screen.key, ...back }]),
    ).catch(fail);
  };
  const saveState = (state: ScreenState, description: string) => {
    if (description === state.description) return;
    setError(null);
    const put = (d: string) => () => api.patchStates([{ screen: screen.key, state: state.key, description: d }]);
    onEdit(t.stepState(state.name || kindLabel[state.kind]), put(description), put(state.description)).catch(fail);
  };
  const section = useDraft(screen.section, (v) => save(t.stepSection(label), { section: v }));
  const description = useDraft(screen.description, (v) => save(t.stepDescription(label), { description: v }));
  const snapshotState = coverOf(screen, 'hasSnapshot');
  const kindLabel = { page: t.page, tab: t.tab, dialog: t.dialog };

  if (thread) {
    return (
      <Card className="map-panel" elevation={2}>
        <ThreadView
          id={thread}
          version={version}
          currentRoute=""
          onBack={() => setThread(null)}
          onChanged={() => {
            threads.reload();
            onChanged();
          }}
          onGo={(th) => window.open(th.url, '_blank', 'noopener')}
          onShow={() => snapshotState && onOpen(snapshotState.key)}
        />
      </Card>
    );
  }

  return (
    <Card className="map-panel" elevation={2}>
      <div className="map-panel-head">
        <H4 className="map-panel-name">
          {canEdit ? (
            <EditableText
              key={screen.name}
              defaultValue={screen.name}
              placeholder={screen.title || t.namePlaceholder}
              maxLength={120}
              onConfirm={(name) => name.trim() !== screen.name && save(t.stepName(label), { name: name.trim() })}
            />
          ) : (
            screenLabel(screen)
          )}
        </H4>
        <Button icon="cross" variant="minimal" aria-label={t.close} onClick={onClose} />
      </div>
      <div className="map-panel-meta">
        <code>{screen.key}</code>
        {screen.planned && <Tag minimal>{t.planned}</Tag>}
        {screen.roles.map((r) => (
          <Tag key={r} minimal round>
            {r}
          </Tag>
        ))}
      </div>
      {error && (
        <Callout intent="danger" compact>
          {t.saveError}: {error}
        </Callout>
      )}
      <div className="map-panel-actions">
        {(snapshotState || screen.exampleUrl) && (
          <Button
            icon="maximize"
            intent="primary"
            text={t.openSnapshot}
            onClick={() => onOpen(snapshotState?.key ?? '')}
          />
        )}
        {screen.exampleUrl && (
          <AnchorButton
            icon="share"
            variant="minimal"
            text={t.openInApp}
            href={screen.exampleUrl}
            target="_blank"
            rel="noopener"
          />
        )}
      </div>

      <label className="map-field">
        <span className="map-label">{t.section}</span>
        {canEdit ? (
          <>
            <InputGroup
              value={section.draft}
              placeholder={t.sectionPlaceholder}
              maxLength={120}
              list={listId}
              onValueChange={section.setDraft}
              onBlur={section.commit}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            <datalist id={listId}>
              {sections.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </>
        ) : (
          <span>{screen.section || t.sectionPlaceholder}</span>
        )}
      </label>
      <label className="map-field">
        <span className="map-label">{t.description}</span>
        {canEdit ? (
          <>
            <TextArea
              className="map-description"
              value={description.draft}
              placeholder={t.descriptionPlaceholder}
              maxLength={4000}
              rows={5}
              autoResize
              fill
              onChange={(e) => description.setDraft(e.currentTarget.value)}
              onBlur={description.commit}
              onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && e.currentTarget.blur()}
            />
            <span className="map-muted">{t.descriptionHint}</span>
          </>
        ) : (
          <p>{screen.description || '—'}</p>
        )}
      </label>

      <div className="map-panel-label">{t.states(states.length)}</div>
      <div className="map-states">
        {states.length === 0 && <p className="map-muted">{t.noLook}</p>}
        {states.map((state) => (
          <div key={state.key} className="map-state">
            <button
              type="button"
              className="map-state-thumb"
              disabled={!state.hasSnapshot}
              onClick={() => onOpen(state.key)}
              title={state.hasSnapshot ? t.openSnapshot : t.noSnapshot}
            >
              <Thumbnail screen={screen} state={state.hasShot ? state : undefined} />
            </button>
            <div className="map-state-text">
              <div>
                <Tag minimal>{kindLabel[state.kind]}</Tag> {state.name}
              </div>
              {canEdit ? (
                <EditableText
                  key={state.description}
                  multiline
                  defaultValue={state.description}
                  placeholder={t.stateDescription}
                  maxLength={4000}
                  onConfirm={(d) => saveState(state, d.trim())}
                />
              ) : (
                state.description && <p>{state.description}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      <Links title={t.leadsTo} links={leads} byKey={byKey} onSelect={onSelect} />
      <Links title={t.comesFrom} links={comes} byKey={byKey} onSelect={onSelect} />

      <div className="map-panel-label">{t.threadList}</div>
      {threads.data?.data.length === 0 && <p className="map-muted">{t.noThreads}</p>}
      {threads.data?.data.map((th) => (
        <button key={th.id} type="button" className="map-thread" onClick={() => setThread(th.id)}>
          <Tag minimal round intent={statusIntent[th.status]}>
            #{th.number}
          </Tag>
          <span>{th.body}</span>
        </button>
      ))}

      {canEdit && (
        <div className="map-panel-actions is-quiet">
          <Button
            icon={screen.hidden ? 'eye-open' : 'eye-off'}
            variant="minimal"
            text={screen.hidden ? t.unhide : t.hide}
            onClick={() => save((screen.hidden ? t.stepUnhide : t.stepHide)(label), { hidden: !screen.hidden })}
          />
          <Popover
            placement="top-start"
            content={
              <div className="map-merge">
                <p>{t.mergeExplain}</p>
                <HTMLSelect fill value={mergeTarget} onChange={(e) => setMergeTarget(e.currentTarget.value)}>
                  <option value="">{t.mergeInto}</option>
                  {map.screens
                    .filter((s) => s.key !== screen.key)
                    .map((s) => (
                      <option key={s.key} value={s.key}>
                        {screenLabel(s)} — {s.key}
                      </option>
                    ))}
                </HTMLSelect>
                <Button
                  intent="primary"
                  disabled={!mergeTarget}
                  text={t.merge}
                  onClick={() => {
                    const target = mergeTarget;
                    api.patchScreens([{ key: screen.key, mergeInto: target }]).then(() => onMerged(target), fail);
                  }}
                />
              </div>
            }
          >
            <Button icon="git-merge" variant="minimal" text={t.mergeAction} />
          </Popover>
        </div>
      )}
    </Card>
  );
}

const kindIcon = { observed: 'arrow-right', declared: 'link', link: 'link', nav: 'menu' } as const;

/** Where the screen leads or what leads to it: the screen, its picture and the elements on the way. */
function Links({
  title,
  links,
  byKey,
  onSelect,
}: {
  title: string;
  links: Link[];
  byKey: Map<string, Screen>;
  onSelect: (key: string) => void;
}) {
  const { t } = useMap();
  return (
    <div className="map-links">
      <div className="map-panel-label">{title}</div>
      {links.length === 0 && <p className="map-muted">{t.noScreensLink}</p>}
      {links.map((l) => {
        const target = byKey.get(l.screen);
        return (
          <button key={l.screen} type="button" className="map-link" onClick={() => onSelect(l.screen)}>
            {target ? (
              <Thumbnail screen={target} state={coverOf(target)} className="is-mini" />
            ) : (
              <span className="map-thumb is-mini" />
            )}
            <span className="map-link-text">
              <strong>{target ? screenLabel(target) : l.screen}</strong>
              <code>{l.screen}</code>
              {l.names.length > 0 && (
                <span className="map-link-via">
                  <Icon icon={kindIcon[l.kind]} size={11} /> {t.via}{' '}
                  {l.names.map((n) => (
                    <Tag key={n} minimal>
                      {n}
                    </Tag>
                  ))}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
