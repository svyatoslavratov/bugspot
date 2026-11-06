import { Card, CardList, Classes, Icon, Tag } from '@blueprintjs/core';

import { when } from '../lib/i18n';
import type { Thread } from '../shared/types';
import { useWidget } from './context';
import { KindIcon, StatusTag } from './labels';

export function ThreadList({
  threads,
  showRoute,
  onSelect,
}: {
  threads: Thread[];
  showRoute: boolean;
  onSelect: (t: Thread) => void;
}) {
  const { t, settings } = useWidget();
  return (
    <CardList bordered={false} compact className="bugspot-list">
      {threads.map((thread) => (
        <Card key={thread.id} interactive onClick={() => onSelect(thread)} className="bugspot-item">
          <div className="bugspot-item-head">
            <span className="bugspot-number">#{thread.number}</span>
            <KindIcon kind={thread.kind} />
            <StatusTag status={thread.status} />
            {thread.hasScreenshot && <Icon icon="media" size={12} className={Classes.TEXT_MUTED} />}
            <span className={`bugspot-item-time ${Classes.TEXT_MUTED}`}>
              {when(thread.updatedAt, t, settings.lang)}
            </span>
          </div>
          <div className="bugspot-item-body">{thread.body}</div>
          <div className={`bugspot-item-meta ${Classes.TEXT_MUTED}`}>
            <span>{thread.author.name}</span>
            {thread.replyCount > 0 && (
              <Tag minimal round icon="comment">
                {thread.replyCount}
              </Tag>
            )}
            {showRoute && <span className="bugspot-route">{thread.route}</span>}
          </div>
        </Card>
      ))}
    </CardList>
  );
}
