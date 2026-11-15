import { Tag } from '@blueprintjs/core';
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react';
import { memo } from 'react';

import { useWidget } from '../app/context';
import type { Screen, ScreenState } from '../shared/types';
import { useMap } from './context';
import { LiveShot } from './LiveShot';
import { screenLabel } from './layout';
import { useShot } from './useShot';

export type ScreenNodeData = {
  screen: Screen;
  threads: number;
  dim: boolean;
  selected: boolean;
};
export type ScreenNodeType = Node<ScreenNodeData, 'screen'>;

export type SectionNodeData = { name: string; auto: boolean };
export type SectionNodeType = Node<SectionNodeData, 'section'>;

/** From this zoom a screen shows as its live DOM snapshot instead of a picture. */
export const LIVE_ZOOM = 1.3;

const kindOrder = { page: 0, tab: 1, dialog: 2 } as const;

/** The state whose look stands for the screen: the page itself, else a tab, else a window. */
export function coverState(screen: Screen, has: 'hasShot' | 'hasSnapshot' = 'hasShot'): ScreenState | undefined {
  return screen.states.filter((s) => s[has]).sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind])[0];
}

export function Thumbnail({
  screen,
  state,
  className,
}: {
  screen: Screen;
  state: ScreenState | undefined;
  className?: string;
}) {
  const { api } = useWidget();
  const { t } = useMap();
  const url = useShot(api, state ? { screen: screen.key, state: state.key } : null, state?.capturedAt ?? '');
  return (
    <div className={`map-thumb ${className ?? ''}`}>
      {url ? (
        <img src={url} alt={screenLabel(screen)} draggable={false} />
      ) : (
        <span className="map-thumb-empty">{screen.planned ? t.planned : t.noLook}</span>
      )}
    </div>
  );
}

export const ScreenNode = memo(function ScreenNode({ data }: NodeProps<ScreenNodeType>) {
  const { t } = useMap();
  const { screen, threads, dim, selected } = data;
  // Only the screens in view at a close zoom: the canvas renders the visible nodes only.
  const near = useStore((s) => s.transform[2] >= LIVE_ZOOM);
  const cover = coverState(screen);
  const live = near ? coverState(screen, 'hasSnapshot') : undefined;
  const classes = [
    'map-node',
    dim && 'is-dim',
    screen.planned && 'is-planned',
    selected && 'is-selected',
    screen.hidden && 'is-hidden',
  ];
  return (
    <div className={classes.filter(Boolean).join(' ')}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {live ? <LiveShot screen={screen} state={live} /> : <Thumbnail screen={screen} state={cover} />}
      <div className="map-node-title" title={screenLabel(screen)}>
        {screenLabel(screen)}
      </div>
      <div className="map-node-meta">
        <code title={screen.key}>{screen.key}</code>
        <span className="map-node-tags">
          {screen.states.length > 1 && <Tag minimal>{t.states(screen.states.length)}</Tag>}
          {threads > 0 && (
            <Tag intent="danger" round>
              {threads}
            </Tag>
          )}
        </span>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

export const SectionNode = memo(function SectionNode({ data }: NodeProps<SectionNodeType>) {
  const { t } = useMap();
  return (
    <div className={`map-section ${data.auto ? 'is-auto' : ''}`}>
      <div className="map-section-title" title={data.auto ? t.autoSectionHint : undefined}>
        {data.name}
        {data.auto && <span className="map-section-auto">{t.autoSection}</span>}
      </div>
    </div>
  );
});

export const nodeTypes = { screen: ScreenNode, section: SectionNode };
