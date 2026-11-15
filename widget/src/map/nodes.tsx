// Screens and frames on the canvas, as in a design tool: a screen is drawn at its real size, and
// what belongs to the map — its name, counters, the frame titles — stays the same size on screen
// at any zoom (the --z variable of the canvas holds the zoom).

import { Icon } from '@blueprintjs/core';
import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react';
import { memo } from 'react';

import { useWidget } from '../app/context';
import { useCanvas } from './canvas';
import type { Screen, ScreenState } from '../shared/types';
import { useMap } from './context';
import { coverOf, screenLabel } from './layout';
import { LiveShot } from './LiveShot';
import { useShot } from './useShot';

export type ScreenNodeData = {
  screen: Screen;
  /** Its name on the canvas. */
  label: string;
  threads: number;
  dim: boolean;
  w: number;
  h: number;
};
export type ScreenNodeType = Node<ScreenNodeData, 'screen'>;

export type SectionNodeData = { name: string; auto: boolean };
export type SectionNodeType = Node<SectionNodeData, 'section'>;

export type TabsNodeData = { title: string; count: number };
export type TabsNodeType = Node<TabsNodeData, 'tabs'>;

/** A screen shows its live snapshot instead of a picture from this width on screen, in pixels. */
export const LIVE_WIDTH = 520;
/**
 * Names of screens show from this zoom: below it a name is taller than the gap between two rows of
 * screens (160) and would cover the screen above.
 */
export const LABEL_ZOOM = 0.125;

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
        <img src={url} alt={screenLabel(screen)} draggable={false} loading="lazy" decoding="async" />
      ) : (
        <span className="map-thumb-empty">{screen.planned ? t.planned : t.noLook}</span>
      )}
    </div>
  );
}

export const ScreenNode = memo(function ScreenNode({ data, selected }: NodeProps<ScreenNodeType>) {
  const { t } = useMap();
  const { screen, label, threads, dim, w } = data;
  const { onMoveStart } = useCanvas();
  // How large the screen is on screen decides what it shows (the selectors change only between
  // these steps, so zooming re-renders a node rarely): far away no name, only a dot for comments;
  // then the name; then its counters; up close its live snapshot instead of the picture (only the
  // nodes in view render).
  const step = useStore((s) => {
    const zoom = s.transform[2];
    const px = zoom * w;
    return zoom < LABEL_ZOOM || px < 64 ? 0 : px < 220 ? 1 : px < LIVE_WIDTH ? 2 : 3;
  });
  const near = step === 3;
  const live = near ? coverOf(screen, 'hasSnapshot') : undefined;
  const states = screen.states.filter((s) => s.hasShot || s.hasSnapshot).length;
  const classes = [
    'map-screen',
    dim && 'is-dim',
    screen.planned && 'is-planned',
    selected && 'is-selected',
    screen.hidden && 'is-hidden',
  ];
  return (
    <div className={classes.filter(Boolean).join(' ')} style={{ ['--w' as string]: w }}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {/* The name moves the screen; the rest of it pans the canvas, as in a design tool. */}
      {step > 0 && (
        <div
          className={`map-screen-label ${onMoveStart ? 'is-movable nopan' : ''}`}
          title={`${screenLabel(screen)} — ${screen.key}`}
          onPointerDown={onMoveStart && ((e) => onMoveStart(e, screen.key))}
        >
          <span className="map-screen-name">{label}</span>
          {step > 1 && screen.hidden && <Icon icon="eye-off" size={11} />}
          {step > 1 && states > 1 && <span className="map-chip">{t.states(states)}</span>}
          {threads > 0 && <span className="map-chip is-threads">{threads}</span>}
        </div>
      )}
      {step === 0 && threads > 0 && <span className="map-dot" aria-label={t.threads(threads)} />}
      {live ? <LiveShot screen={screen} state={live} /> : <Thumbnail screen={screen} state={coverOf(screen)} />}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

export const SectionNode = memo(function SectionNode({ data }: NodeProps<SectionNodeType>) {
  const { t } = useMap();
  return (
    <div className={`map-section ${data.auto ? 'is-auto' : ''}`}>
      <div className="map-frame-label" title={data.auto ? t.autoSectionHint : undefined}>
        {data.name}
        {data.auto && <span className="map-section-auto">{t.autoSection}</span>}
      </div>
    </div>
  );
});

/** Tabs of one page, each its own address: the box behind them, the page's title above. */
export const TabsNode = memo(function TabsNode({ data }: NodeProps<TabsNodeType>) {
  const { t } = useMap();
  return (
    <div className="map-tabs">
      <div className="map-tabs-label" title={t.tabsHint}>
        {data.title && <span className="map-tabs-title">{data.title}</span>}
        <span>{t.tabs(data.count)}</span>
      </div>
    </div>
  );
});

export const nodeTypes = { screen: ScreenNode, section: SectionNode, tabs: TabsNode };
