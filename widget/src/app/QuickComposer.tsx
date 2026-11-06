import { Button, ButtonGroup, Callout, Classes, InputGroup, TextArea, Tooltip } from '@blueprintjs/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Kind, Thread } from '../shared/types';
import { useWidget } from './context';
import { kindIcon } from './labels';
import { PickedOutlines } from './Picker';
import { useDraft, type Draft, type Target } from './useDraft';

const WIDTH = 300;
const GAP = 14;
const MARGIN = 8;

/**
 * The tiny mode: a small box right at the picked element, as in Figma. Enter sends, Shift+Enter
 * starts a new line, Esc cancels; the screenshot is taken and attached on its own. With several
 * elements their numbered frames stay on the page and the box sits at the last one. "Expand" moves
 * the text to the full form.
 */
export function QuickComposer({
  target,
  route,
  onCreated,
  onCancel,
  onExpand,
}: {
  target: Target;
  route: string;
  onCreated: (t: Thread) => void;
  onCancel: () => void;
  onExpand: (draft: Draft) => void;
}) {
  const { t } = useWidget();
  const d = useDraft(target, route);
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(140);
  const [, setFrame] = useState(0);

  // The box follows the last element when the page scrolls: keep the click point relative to it.
  const last = target.picks[target.picks.length - 1];
  const offset = useRef<{ dx: number; dy: number } | null>(null);
  if (!offset.current) {
    const r = last.el.getBoundingClientRect();
    offset.current = { dx: last.point.x - r.left, dy: last.point.y - r.top };
  }
  useEffect(() => {
    const redraw = () => setFrame((n) => n + 1);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onCancel();
    };
    window.addEventListener('scroll', redraw, { capture: true, passive: true });
    window.addEventListener('resize', redraw);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', redraw, { capture: true });
      window.removeEventListener('resize', redraw);
      window.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);
  useLayoutEffect(() => {
    if (box.current) setHeight(box.current.offsetHeight);
  });

  const r = last.el.getBoundingClientRect();
  const point = { x: r.left + offset.current.dx, y: r.top + offset.current.dy };
  // Right and below the click point; flipped when the window ends, then kept inside it.
  let left = point.x + GAP;
  if (left + WIDTH > innerWidth - MARGIN) left = point.x - GAP - WIDTH;
  left = Math.max(MARGIN, Math.min(left, innerWidth - WIDTH - MARGIN));
  let top = point.y + GAP;
  if (top + height > innerHeight - MARGIN) top = point.y - GAP - height;
  top = Math.max(MARGIN, Math.min(top, innerHeight - height - MARGIN));

  const send = () => void d.submit(onCreated);
  return (
    <>
      <PickedOutlines picks={target.picks} />
      <div
        ref={box}
        className={`bugspot-quick ${Classes.CARD} ${Classes.ELEVATION_3}`}
        style={{ left, top, width: WIDTH }}
        role="dialog"
        aria-label={t.newComment}
      >
        <div className="bugspot-quick-head">
          <ButtonGroup variant="minimal">
            {(['issue', 'question', 'idea'] as Kind[]).map((k) => (
              <Tooltip key={k} content={t.kind[k]} placement="top">
                <Button
                  size="small"
                  icon={kindIcon[k]}
                  active={d.kind === k}
                  aria-label={t.kind[k]}
                  aria-pressed={d.kind === k}
                  onClick={() => d.setKind(k)}
                />
              </Tooltip>
            ))}
          </ButtonGroup>
          {target.picks.length > 1 && (
            <span className={`bugspot-quick-count ${Classes.TEXT_MUTED}`}>{t.elementsCount(target.picks.length)}</span>
          )}
          <Tooltip content={t.expand} placement="top" className="bugspot-push-right">
            <Button
              size="small"
              variant="minimal"
              icon="maximize"
              aria-label={t.expand}
              onClick={() => onExpand({ body: d.body, kind: d.kind })}
            />
          </Tooltip>
          <Button size="small" variant="minimal" icon="cross" aria-label={t.cancel} onClick={onCancel} />
        </div>
        <TextArea
          autoFocus
          fill
          autoResize
          rows={2}
          maxLength={d.maxLength}
          placeholder={t.quickPlaceholder}
          value={d.body}
          onChange={(e) => d.setBody(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {d.anonymous && (
          <InputGroup size="small" placeholder={t.yourName} value={d.name} maxLength={80} onValueChange={d.setName} />
        )}
        {d.error && (
          <Callout intent="danger" compact>
            {d.error}
          </Callout>
        )}
        <div className="bugspot-quick-foot">
          <span className={Classes.TEXT_MUTED}>
            {d.shot.kind === 'pending' ? t.capturing : d.shot.kind === 'ready' ? t.shotAttached : t.screenshotFailed}
            {' · '}
            {t.quickHint}
          </span>
          <Button
            size="small"
            intent="primary"
            icon="send-message"
            aria-label={t.send}
            loading={d.busy}
            disabled={!d.body.trim()}
            onClick={send}
          />
        </div>
      </div>
    </>
  );
}
