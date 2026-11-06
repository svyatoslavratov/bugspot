import { Button, Icon, Menu, MenuItem, Popover, Tag, Tooltip, type Intent } from '@blueprintjs/core';
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
const kinds: Kind[] = ['issue', 'question', 'idea'];

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

/** The status tag; when the caller may move the thread, the tag itself opens the status menu. */
export function StatusPicker({
  status,
  options,
  busy,
  onChange,
}: {
  status: Status;
  options: Status[];
  busy: boolean;
  onChange: (s: Status) => void;
}) {
  const { t } = useWidget();
  if (!options.length) return <StatusTag status={status} />;
  return (
    <Popover
      placement="bottom-start"
      content={
        <Menu>
          {options.map((s) => (
            <MenuItem key={s} text={t.status[s]} intent={statusIntent[s]} onClick={() => onChange(s)} />
          ))}
        </Menu>
      }
    >
      <Tag
        interactive
        minimal
        round
        intent={statusIntent[status]}
        endIcon="caret-down"
        className="bugspot-status-picker"
        aria-label={`${t.setStatus}: ${t.status[status]}`}
        aria-busy={busy}
      >
        {t.status[status]}
      </Tag>
    </Popover>
  );
}

/** The kind icon; the author changes the kind from it. */
export function KindPicker({
  kind,
  editable,
  onChange,
}: {
  kind: Kind;
  editable: boolean;
  onChange: (k: Kind) => void;
}) {
  const { t } = useWidget();
  if (!editable) return <KindIcon kind={kind} />;
  return (
    <Popover
      placement="bottom-start"
      content={
        <Menu>
          {kinds.map((k) => (
            <MenuItem key={k} icon={kindIcon[k]} text={t.kind[k]} active={k === kind} onClick={() => onChange(k)} />
          ))}
        </Menu>
      }
    >
      <Button size="small" variant="minimal" icon={kindIcon[kind]} aria-label={`${t.changeKind}: ${t.kind[kind]}`} />
    </Popover>
  );
}
