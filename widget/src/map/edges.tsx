// Transitions on the canvas. Their width, arrowheads and names stay the same size on screen at any
// zoom (CSS with the --z variable of the canvas), and which of them stand out — those of the
// screen in focus — is decided by a stylesheet, so hovering a screen re-renders no edge.

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import { memo, type CSSProperties } from 'react';

import type { Point } from '../shared/types';

export type RoutedEdgeData = {
  /** The route ELK found around the screens; none — a curve between the two screens. */
  points?: Point[];
  /** Where the label goes; by default halfway along the route. */
  labelAt?: Point;
  /** Classes of the label: the ids of both ends, for the focus stylesheet. */
  ends: string;
  /** Line width in screen pixels. */
  width: number;
};
export type RoutedEdgeType = Edge<RoutedEdgeData, 'routed'>;

const RADIUS = 24;

/** A polyline with rounded corners. */
export function roundedPath(points: Point[]): string {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const r = Math.min(RADIUS, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const from = toward(b, a, r);
    const to = toward(b, c, r);
    d += ` L ${from.x} ${from.y} Q ${b.x} ${b.y} ${to.x} ${to.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

function toward(from: Point, to: Point, distance: number): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: from.x + ((to.x - from.x) * distance) / length, y: from.y + ((to.y - from.y) * distance) / length };
}

/** The point halfway along a polyline, for its label. */
export function midpoint(points: Point[]): Point {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let left = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i]) return toward(points[i], points[i + 1], left);
    left -= lengths[i];
  }
  return points[points.length - 1];
}

export const RoutedEdge = memo(function RoutedEdge(props: EdgeProps<RoutedEdgeType>) {
  const { data, label, markerEnd, style } = props;
  let path: string;
  let at: Point;
  if (data?.points && data.points.length >= 2) {
    path = roundedPath(data.points);
    at = data.labelAt ?? midpoint(data.points);
  } else {
    const [bezier, x, y] = getBezierPath(props);
    path = bezier;
    at = { x, y };
  }
  const line = { ...style, ['--w' as string]: data?.width ?? 1.5 } as CSSProperties;
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={line} interactionWidth={0} />
      {label && (
        <EdgeLabelRenderer>
          <div
            className={`map-edge-label ${data?.ends ?? ''}`}
            style={{ transform: `translate(${at.x}px, ${at.y}px) scale(calc(1 / var(--z))) translate(-50%, -50%)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes = { routed: RoutedEdge };

/**
 * The stylesheet that makes the transitions of one screen stand out (its id from the class names
 * of the edges) and fades the rest; none — all of them in their quiet look.
 */
export function focusCss(id: string | null): string {
  if (!id) return '';
  const own = `.map-flow .react-flow__edge.f-${id}, .map-flow .react-flow__edge.t-${id}`;
  return (
    `.map-flow .react-flow__edge { opacity: 0.1; }\n` +
    `${own} { opacity: 1; display: inline; }\n` +
    `.map-flow .react-flow__edge.f-${id} .react-flow__edge-path, .map-flow .react-flow__edge.t-${id} .react-flow__edge-path { stroke-width: calc(var(--w, 1.5) * 1px / var(--z)); }\n` +
    `.map-flow .map-edge-label.f-${id}, .map-flow .map-edge-label.t-${id} { display: block; }\n`
  );
}
