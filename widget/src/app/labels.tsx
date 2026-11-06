import { Icon, Tag, Tooltip, type Intent } from '@blueprintjs/core';
import type { IconName } from '@blueprintjs/icons';

import type { Kind, Status } from '../shared/types';
import { useWidget } from './context';

export const statusIntent: Record<Status, Intent> = {
  open: 'danger',
  in_progress: 'warning',
  fixed: 'primary',
  resolved: 'success',
  wontfix: 'none',
};

const kindIcon: Record<Kind, IconName> = { issue: 'bug', question: 'help', idea: 'lightbulb' };

export function StatusTag({ status }: { status: Status }) {
  const { t } = useWidget();
  return (
    <Tag intent={statusIntent[status]} minimal round>
      {t.status[status]}
    </Tag>
  );
}

export function KindIcon({ kind }: { kind: Kind }) {
  const { t } = useWidget();
  return (
    <Tooltip content={t.kind[kind]} placement="top">
      <Icon icon={kindIcon[kind]} size={14} aria-label={t.kind[kind]} className="bugspot-kind" />
    </Tooltip>
  );
}
