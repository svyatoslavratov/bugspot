import { Button, Callout, Classes, Dialog, DialogBody, DialogFooter } from '@blueprintjs/core';
import { useRef, useState } from 'react';

import { useWidget } from '../app/context';
import { useMap } from './context';

const EXAMPLE = `{"version": 1, "screens": [
  {"key": "/authors/:id", "name": "Author card", "section": "Authors",
   "description": "What the scout sees about one author",
   "states": [{"key": "tab:Responses", "description": "…"}],
   "to": ["/authors", {"screen": "/reports", "via": "Report", "kind": "link"}]}
]}`;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * What the manifest is, why one keeps it and how to use it, with its download and upload: the
 * part of the map people and agents wrote, as a file.
 */
export function ManifestDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { api, session } = useWidget();
  const { t } = useMap();
  const canEdit = session.can?.map ?? false;
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ intent: 'success' | 'danger'; text: string } | null>(null);

  const exportManifest = async () => {
    setBusy(true);
    try {
      download('pinpath-map.json', (await api.exportManifest()) + '\n');
    } catch (e) {
      setMessage({ intent: 'danger', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const importManifest = async (f: File) => {
    setBusy(true);
    try {
      setMessage({ intent: 'success', text: t.imported(await api.importManifest(await f.text())) });
      onImported();
    } catch (e) {
      setMessage({ intent: 'danger', text: `${t.importError}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog isOpen title={t.manifestTitle} icon="document" onClose={onClose} className="map-dialog">
      <DialogBody>
        <p>{t.manifestWhat}</p>
        <p>{t.manifestWhy}</p>
        <p>{t.manifestHow}</p>
        <div className="map-label">{t.manifestExample}</div>
        <pre className={`${Classes.CODE_BLOCK} map-code`}>{EXAMPLE}</pre>
        <div className="map-label">{t.manifestCli}</div>
        <pre className={`${Classes.CODE_BLOCK} map-code`}>
          {'pinpath map export -o map.json\npinpath map import map.json'}
        </pre>
        {message && (
          <Callout intent={message.intent} compact>
            {message.text}
          </Callout>
        )}
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button icon="export" text={t.download} loading={busy} onClick={() => void exportManifest()} />
            {canEdit && (
              <Button
                icon="import"
                intent="primary"
                text={t.upload}
                loading={busy}
                onClick={() => file.current?.click()}
              />
            )}
          </>
        }
      />
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (f) void importManifest(f);
        }}
      />
    </Dialog>
  );
}
