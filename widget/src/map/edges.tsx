import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';

import type { Point } from '../shared/types';

export type RoutedEdgeData = {
  /** The route ELK found around the screens; none — a curve between the two screens. */
  points?: Point[];
  /** Where the label goes; by default halfway along the route. */
  labelAt?: Point;
  /** The label shows only for the transitions of the screen in focus. */
  showLabel: boolean;
};
export type RoutedEdgeType = Edge<RoutedEdgeData, 'routed'>;

const RADIUS = 10;

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
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} interactionWidth={12} />
      {label && data?.showLabel && (
        <EdgeLabelRenderer>
          <div
            className="map-edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const edgeTypes = { routed: RoutedEdge };
