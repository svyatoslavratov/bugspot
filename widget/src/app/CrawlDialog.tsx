import {
  AnchorButton,
  Button,
  Callout,
  Card,
  Checkbox,
  Elevation,
  H5,
  InputGroup,
  ProgressBar,
} from '@blueprintjs/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { CrawlConfig } from '../shared/types';
import { useWidget } from './context';
import { frameTarget, startCrawl, windowTarget, type CrawlStatus, type CrawlTarget } from './crawler';

/** The crawler's frame and window are named so: the widget does not start inside them. */
export const CRAWL_FRAME = 'bugspot-crawl';
const CRAWL_WINDOW = 'bugspot-crawl-window';

/**
 * Builds the map by walking the app: the options, then the app in a frame shrunk to fit, the
 * progress, and the way to the map. With a config from the command line it starts at once.
 */
export function CrawlDialog({ auto, onClose }: { auto: CrawlConfig | null; onClose: () => void }) {
  const { api, session, settings, t } = useWidget();
  const [start, setStart] = useState(() => location.href);
  const [buttons, setButtons] = useState(auto?.buttons ?? false);
  const [max, setMax] = useState(auto?.maxScreens ?? 100);
  const [status, setStatus] = useState<CrawlStatus | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const run = useRef<{ stop(): void } | null>(null);
  // The app is laid out as in this window and shown smaller.
  const size = { w: innerWidth, h: innerHeight };
  const scale = Math.min(1, (innerWidth * 0.86 - 32) / size.w, (innerHeight * 0.5) / size.h);

  const begin = useCallback(
    (target: CrawlTarget, fallback?: () => void, closeAfter = false) => {
      const crawl = startCrawl({
        api,
        session,
        settings,
        target,
        options: { start, buttons, maxScreens: Math.max(1, max) },
        onStatus: (s) => {
          setStatus(s);
          window.__bugspotCrawlStatus = s;
        },
      });
      run.current = crawl;
      window.__bugspotCrawlStop = crawl.stop;
      void crawl.done.then((s) => {
        run.current = null;
        // A window of its own goes away with the crawl; the frame stays as the last view.
        if (closeAfter) target.close();
        if (s.blocked && fallback) fallback();
      });
    },
    [api, session, settings, start, buttons, max],
  );

  /** A window instead of the frame; opened right in the click, or pop-up blockers stop it. */
  const inWindow = useCallback(() => {
    const popup = window.open('about:blank', CRAWL_WINDOW, `popup,width=${size.w},height=${size.h}`);
    if (!popup) {
      setPopupBlocked(true);
      return;
    }
    setPopupBlocked(false);
    begin(windowTarget(popup), undefined, true);
  }, [begin, size.w, size.h]);

  const inFrame = useCallback(() => {
    if (frame.current) begin(frameTarget(frame.current), auto ? inWindow : undefined);
  }, [begin, auto, inWindow]);

  const started = useRef(false);
  useEffect(() => {
    if (auto && !started.current) {
      started.current = true;
      inFrame();
    }
  }, [auto, inFrame]);
  useEffect(() => () => run.current?.stop(), []);

  const running = status?.phase === 'starting' || status?.phase === 'running';
  // The map is worth opening once the crawl found something, or ended on its own.
  const finished = status && !running && (status.phase !== 'error' || status.screens > 0);

  return (
    <div className="bugspot-crawl">
      <Card className="bugspot-crawl-card" elevation={Elevation.FOUR} role="dialog" aria-label={t.crawlTitle}>
        <header className="bugspot-crawl-head">
          <H5>{t.crawlTitle}</H5>
          <Button
            icon="cross"
            variant="minimal"
            aria-label={t.close}
            onClick={() => {
              run.current?.stop();
              onClose();
            }}
          />
        </header>
        {!status && (
          <div className="bugspot-crawl-options">
            <p>{t.crawlIntro}</p>
            <p className="bp6-text-muted">{t.crawlSafe}</p>
            <label className="bugspot-crawl-field">
              <span>{t.crawlFrom}</span>
              <InputGroup value={start} onValueChange={setStart} fill />
            </label>
            <div className="bugspot-crawl-row">
              <Checkbox
                checked={buttons}
                label={t.crawlButtons}
                onChange={(e) => setButtons(e.currentTarget.checked)}
              />
              <label className="bugspot-crawl-max">
                <span>{t.crawlMax}</span>
                <InputGroup
                  type="number"
                  min={1}
                  max={2000}
                  value={String(max)}
                  onValueChange={(v) => setMax(Number(v) || 1)}
                />
              </label>
              <Button intent="primary" icon="play" text={t.crawlGo} onClick={inFrame} />
            </div>
          </div>
        )}
        {status && (
          <div className="bugspot-crawl-status">
            <div>
              <strong>{t.crawlPhase[status.phase]}</strong> · {t.crawlProgress(status)}
            </div>
            <code className="bugspot-crawl-current" title={status.current}>
              {status.current}
            </code>
            {running && <ProgressBar intent="primary" />}
            {status.phase === 'error' && status.blocked && (
              <Callout intent="warning" compact>
                {t.crawlBlocked} <Button size="small" icon="share" text={t.crawlInWindow} onClick={inWindow} />
              </Callout>
            )}
            {status.phase === 'error' && !status.blocked && (
              <Callout intent="danger" compact>
                {status.error}
              </Callout>
            )}
            {popupBlocked && (
              <Callout intent="danger" compact>
                {t.crawlPopupBlocked}
              </Callout>
            )}
            <div className="bugspot-crawl-actions">
              {running && <Button icon="stop" text={t.crawlStop} onClick={() => run.current?.stop()} />}
              {finished && (
                <AnchorButton
                  intent="primary"
                  icon="map"
                  text={t.mapShow}
                  href={status.map}
                  target="_blank"
                  rel="noopener"
                />
              )}
            </div>
          </div>
        )}
        <div className="bugspot-crawl-view" style={{ width: size.w * scale, height: size.h * scale }}>
          <iframe
            ref={frame}
            name={CRAWL_FRAME}
            title={t.crawlTitle}
            style={{ width: size.w, height: size.h, transform: `scale(${scale})` }}
          />
        </div>
      </Card>
    </div>
  );
}
