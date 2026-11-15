import {
  AnchorButton,
  Button,
  Callout,
  Card,
  Divider,
  EditableText,
  H4,
  HTMLSelect,
  Popover,
  Tag,
} from '@blueprintjs/core';
import { useMemo, useState } from 'react';

import { useWidget } from '../app/context';
import { statusIntent } from '../app/labels';
import { ThreadView } from '../app/ThreadView';
import { useData } from '../app/useData';
import { ApiError } from '../shared/api';
import { ACTIVE_STATUSES, type Screen, type ScreenMap, type ScreenPatch, type ScreenState } from '../shared/types';
import { useMap } from './context';
import { screenLabel } from './layout';
import { Thumbnail } from './nodes';

interface Link {
  screen: string;
  names: string[];
}

/** Transitions of the screen to (or from) other screens, one line per screen; the app's menu only when asked. */
function linksOf(map: ScreenMap, key: string, dir: 'out' | 'in', auto: string, nav: boolean): Link[] {
  const out = new Map<string, string[]>();
  for (const e of map.edges) {
    const [here, there] = dir === 'out' ? [e.from.screen, e.to.screen] : [e.to.screen, e.from.screen];
    if (here !== key || there === key || (e.via.kind === 'nav' && !nav)) continue;
    const names = out.get(there) ?? [];
    const name = e.via.name || (e.via.kind === 'auto' ? auto : '');
    if (name && !names.includes(name)) names.push(name);
    out.set(there, names);
  }
  return [...out].map(([screen, names]) => ({ screen, names }));
}

export function ScreenPanel({
  map,
  screen,
  version,
  showNav,
  onClose,
  onSelect,
  onOpen,
  onChanged,
}: {
  map: ScreenMap;
  screen: Screen;
  version: number;
  /** Transitions through the app's menu too. */
  showNav: boolean;
  onClose: () => void;
  onSelect: (key: string) => void;
  onOpen: (state: string) => void;
  onChanged: () => void;
}) {
  const { api, session } = useWidget();
  const { t } = useMap();
  const canEdit = session.can?.map ?? false;
  const [error, setError] = useState<string | null>(null);
  const [thread, setThread] = useState<string | null>(null);
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
  // A state only links pointed at (never seen, no look) says nothing about the screen.
  const states = screen.states.filter((s) => s.hasShot || s.hasSnapshot || s.lastSeen || s.description);
  const label = (key: string) => {
    const s = map.screens.find((x) => x.key === key);
    return s ? screenLabel(s) : key;
  };

  const save = (patch: Omit<ScreenPatch, 'key'>) => {
    setError(null);
    api
      .patchScreens([{ key: screen.key, ...patch }])
      .then(onChanged, (e: unknown) => setError(e instanceof ApiError || e instanceof Error ? e.message : String(e)));
  };
  const saveState = (state: ScreenState, description: string) => {
    if (description === state.description) return;
    setError(null);
    api
      .patchStates([{ screen: screen.key, state: state.key, description }])
      .then(onChanged, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const snapshotState =
    screen.states.find((s) => s.key === '' && s.hasSnapshot) ?? screen.states.find((s) => s.hasSnapshot);
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
              defaultValue={screen.name}
              placeholder={screen.title || t.namePlaceholder}
              maxLength={120}
              onConfirm={(name) => name !== screen.name && save({ name: name.trim() })}
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
      <label className="map-field">
        <span>{t.section}</span>
        {canEdit ? (
          <EditableText
            defaultValue={screen.section}
            placeholder={t.sectionPlaceholder}
            maxLength={120}
            onConfirm={(section) => section !== screen.section && save({ section: section.trim() })}
          />
        ) : (
          <span>{screen.section || t.sectionPlaceholder}</span>
        )}
      </label>
      <label className="map-field">
        <span>{t.description}</span>
        {canEdit ? (
          <EditableText
            multiline
            minLines={2}
            defaultValue={screen.description}
            placeholder={t.descriptionPlaceholder}
            maxLength={4000}
            onConfirm={(description) => description !== screen.description && save({ description: description.trim() })}
          />
        ) : (
          <p>{screen.description || '—'}</p>
        )}
      </label>
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
        {canEdit && (
          <Button
            icon={screen.hidden ? 'eye-open' : 'eye-off'}
            variant="minimal"
            text={screen.hidden ? t.unhide : t.hide}
            onClick={() => save({ hidden: !screen.hidden })}
          />
        )}
        {canEdit && (
          <Popover
            placement="bottom-start"
            content={
              <div className="map-merge">
                <p>{t.mergeHint}</p>
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
                    api.patchScreens([{ key: screen.key, mergeInto: target }]).then(
                      () => {
                        onChanged();
                        onSelect(target);
                      },
                      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
                    );
                  }}
                />
              </div>
            }
          >
            <Button icon="git-merge" variant="minimal" text={t.mergeInto} />
          </Popover>
        )}
      </div>
      <Divider />
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
      <Divider />
      <Transitions title={t.leadsTo} links={leads} label={label} onSelect={onSelect} empty={t.noTransitions} />
      <Transitions title={t.comesFrom} links={comes} label={label} onSelect={onSelect} empty={t.noTransitions} />
      <Divider />
      <div className="map-section-label">{t.threadList}</div>
      {threads.data?.data.length === 0 && <p className="map-muted">{t.noThreads}</p>}
      {threads.data?.data.map((th) => (
        <button key={th.id} type="button" className="map-thread" onClick={() => setThread(th.id)}>
          <Tag minimal round intent={statusIntent[th.status]}>
            #{th.number}
          </Tag>
          <span>{th.body}</span>
        </button>
      ))}
    </Card>
  );
}

function Transitions({
  title,
  links,
  label,
  onSelect,
  empty,
}: {
  title: string;
  links: Link[];
  label: (key: string) => string;
  onSelect: (key: string) => void;
  empty: string;
}) {
  return (
    <div className="map-links">
      <div className="map-section-label">{title}</div>
      {links.length === 0 && <p className="map-muted">{empty}</p>}
      {links.map((l) => (
        <button key={l.screen} type="button" className="map-link" onClick={() => onSelect(l.screen)}>
          <strong>{label(l.screen)}</strong>
          {l.names.length > 0 && <span className="map-muted"> · {l.names.join(', ')}</span>}
        </button>
      ))}
    </div>
  );
}
