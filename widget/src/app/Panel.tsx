import {
  Button,
  Card,
  Classes,
  Elevation,
  HTMLSelect,
  InputGroup,
  NonIdealState,
  Spinner,
  Switch,
  Tab as BpTab,
  Tabs,
  Tooltip,
} from '@blueprintjs/core';
import { useEffect, useState, type ReactNode } from 'react';

import { STATUSES, type Page, type Point, type Status, type Thread } from '../shared/types';
import type { View } from './App';
import { useWidget } from './context';
import { buttonPoint, panelBox } from './layout';
import { ThreadList } from './ThreadList';
import type { Loaded } from './useData';

export type Tab = 'page' | 'all';
export type StatusFilter = 'active' | 'all' | Status;

interface Props {
  buttonPosition: Point | null;
  tab: Tab;
  counts: { page: number; all: number };
  status: StatusFilter;
  query: string;
  pins: boolean;
  list: Loaded<Page<Thread>>;
  view: View;
  children: ReactNode;
  onTab: (tab: Tab) => void;
  onStatus: (s: StatusFilter) => void;
  onQuery: (q: string) => void;
  onPins: (on: boolean) => void;
  onNew: () => void;
  onClose: () => void;
  onHide: () => void;
  onSelect: (thread: Thread) => void;
}

export function Panel(p: Props) {
  const { t, session } = useWidget();
  const [, setViewport] = useState(0);
  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const box = panelBox(buttonPoint(p.buttonPosition, useWidget().settings.position));
  const canComment = session.can?.comment ?? false;

  return (
    <Card className="bugspot-panel" elevation={Elevation.FOUR} style={box} role="dialog" aria-label={t.title}>
      <header className="bugspot-panel-header">
        <div className="bugspot-panel-title">
          <strong>{t.title}</strong>
          <span className={Classes.TEXT_MUTED}>
            {t.signedAs}: {session.user?.name}
          </span>
        </div>
        {canComment && p.view.kind === 'list' && (
          <Button icon="add" intent="primary" text={t.newComment} onClick={p.onNew} />
        )}
        <Tooltip content={t.hide} placement="bottom">
          <Button icon="eye-off" variant="minimal" aria-label={t.hide} onClick={p.onHide} />
        </Tooltip>
        <Button icon="cross" variant="minimal" aria-label={t.close} onClick={p.onClose} />
      </header>
      {p.view.kind === 'list' ? (
        <>
          <div className="bugspot-toolbar">
            <Tabs id="bugspot-tabs" selectedTabId={p.tab} onChange={(id) => p.onTab(id as Tab)}>
              <BpTab id="page" title={t.thisPage} tagContent={p.counts.page || undefined} tagProps={{ round: true }} />
              <BpTab id="all" title={t.all} tagContent={p.counts.all || undefined} tagProps={{ round: true }} />
            </Tabs>
            <div className="bugspot-filters">
              <InputGroup
                leftIcon="search"
                placeholder={t.search}
                value={p.query}
                onValueChange={p.onQuery}
                type="search"
                fill
              />
              <HTMLSelect
                value={p.status}
                onChange={(e) => p.onStatus(e.currentTarget.value as StatusFilter)}
                aria-label={t.setStatus}
                options={[
                  { value: 'active', label: t.active },
                  { value: 'all', label: t.allStatuses },
                  ...STATUSES.map((s) => ({ value: s, label: t.status[s] })),
                ]}
              />
            </div>
            <Switch checked={p.pins} label={t.pins} onChange={(e) => p.onPins(e.currentTarget.checked)} />
          </div>
          <div className="bugspot-panel-body">
            <ListBody {...p} />
          </div>
        </>
      ) : (
        <div className="bugspot-panel-body">{p.children}</div>
      )}
    </Card>
  );
}

function ListBody({ list, query, status, tab, onSelect }: Props) {
  const { t } = useWidget();
  if (list.error && !list.data) {
    return (
      <NonIdealState
        icon="error"
        title={t.loadError}
        description={list.error}
        action={<Button icon="refresh" text={t.retry} onClick={list.reload} />}
      />
    );
  }
  if (!list.data) return <Spinner size={24} className="bugspot-spinner" />;
  if (!list.data.data.length) {
    const filtered = Boolean(query) || status !== 'active';
    return (
      <NonIdealState
        icon={filtered ? 'search' : 'comment'}
        title={filtered ? t.nothingFound : t.empty}
        description={filtered ? undefined : t.emptyHint}
      />
    );
  }
  return <ThreadList threads={list.data.data} showRoute={tab === 'all'} onSelect={onSelect} />;
}
