import {
  Button,
  Card,
  Classes,
  Elevation,
  InputGroup,
  NonIdealState,
  Spinner,
  Tab as BpTab,
  Tabs,
  Tooltip,
} from '@blueprintjs/core';
import { useEffect, useState, type ReactNode } from 'react';

import type { Page, Point, Thread } from '../shared/types';
import type { View } from './App';
import { useWidget } from './context';
import { StatusFilterPicker, type StatusFilter } from './labels';
import { buttonPoint, panelBox } from './layout';
import { ThreadList } from './ThreadList';
import type { Loaded } from './useData';

const PROJECT_URL = 'https://github.com/svyatoslavratov/bugspot';

export type Tab = 'page' | 'all';
export type { StatusFilter } from './labels';

interface Props {
  buttonPosition: Point | null;
  /** While a thread flashes on the page, the panel turns almost transparent to show it. */
  peek: boolean;
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
    <Card
      className={`bugspot-panel ${p.peek ? 'is-peeking' : ''}`}
      elevation={Elevation.FOUR}
      style={box}
      role="dialog"
      aria-label={t.title}
    >
      <header className="bugspot-panel-header">
        <div className="bugspot-panel-title">
          <strong>{t.title}</strong>
          <span className={Classes.TEXT_MUTED}>
            {t.signedAs}: {session.user?.name}
          </span>
        </div>
        {canComment && <Button icon="add" intent="primary" text={t.newComment} onClick={p.onNew} />}
        <Tooltip content={p.pins ? t.hidePins : t.showPins} placement="bottom">
          <Button
            icon={p.pins ? 'eye-open' : 'eye-off'}
            variant="minimal"
            active={!p.pins}
            aria-label={p.pins ? t.hidePins : t.showPins}
            aria-pressed={!p.pins}
            onClick={() => p.onPins(!p.pins)}
          />
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
              <StatusFilterPicker value={p.status} onChange={p.onStatus} />
            </div>
          </div>
          <div className="bugspot-panel-body">
            <ListBody {...p} />
          </div>
        </>
      ) : (
        <div className="bugspot-panel-body">{p.children}</div>
      )}
      <footer className="bugspot-panel-footer">
        <a href={PROJECT_URL} target="_blank" rel="noopener noreferrer" title={t.aboutProject}>
          bugspot ↗
        </a>
      </footer>
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
