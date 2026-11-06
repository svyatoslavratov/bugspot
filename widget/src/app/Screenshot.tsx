import { Button, Classes, Dialog, DialogBody, Spinner } from '@blueprintjs/core';
import { useEffect, useState } from 'react';

import { useWidget } from './context';

/** Loads the screenshot through the API (cookies or a token), never by a bare <img src>. */
export function Screenshot({ threadId, version }: { threadId: string; version: string }) {
  const { api, t } = useWidget();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    let alive = true;
    api.screenshot(threadId).then(
      (blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (alive) setUrl(objectUrl);
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, threadId, version]);
  if (failed) return null;
  if (!url) return <Spinner size={20} className="bugspot-spinner" />;
  return (
    <>
      <Button variant="minimal" className="bugspot-shot" onClick={() => setZoom(true)} aria-label={t.screenshot}>
        <img src={url} alt={t.screenshot} />
      </Button>
      <Dialog isOpen={zoom} onClose={() => setZoom(false)} title={t.screenshot} className="bugspot-shot-dialog">
        <DialogBody className={Classes.DIALOG_BODY}>
          <img src={url} alt={t.screenshot} />
        </DialogBody>
      </Dialog>
    </>
  );
}
