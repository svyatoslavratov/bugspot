import {
  Button,
  Callout,
  Checkbox,
  Classes,
  FormGroup,
  InputGroup,
  SegmentedControl,
  Spinner,
  TextArea,
} from '@blueprintjs/core';

import type { Kind, Thread } from '../shared/types';
import type { View } from './App';
import { useWidget } from './context';
import { describeTarget, useDraft } from './useDraft';

/** The full form in the panel: kind, text, screenshot preview with retake. */
export function NewThread({
  view,
  route,
  onCancel,
  onCreated,
}: {
  view: Extract<View, { kind: 'new' }>;
  route: string;
  onCancel: () => void;
  onCreated: (t: Thread) => void;
}) {
  const { t } = useWidget();
  const d = useDraft(view, route, view.draft);

  return (
    <form
      className="bugspot-new"
      onSubmit={(e) => {
        e.preventDefault();
        void d.submit(onCreated);
      }}
    >
      <div className={`bugspot-meta ${Classes.TEXT_MUTED}`}>
        {t.element}: <span className="bugspot-code">{describeTarget(view.anchor, t.andMore)}</span>
      </div>
      <SegmentedControl
        fill
        size="small"
        value={d.kind}
        onValueChange={(v) => d.setKind(v as Kind)}
        options={(['issue', 'question', 'idea'] as Kind[]).map((k) => ({ value: k, label: t.kind[k] }))}
      />
      <TextArea
        autoFocus
        fill
        autoResize
        rows={4}
        maxLength={d.maxLength}
        placeholder={t.bodyPlaceholder}
        value={d.body}
        onChange={(e) => d.setBody(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void d.submit(onCreated);
        }}
      />
      {d.anonymous && (
        <FormGroup label={t.yourName}>
          <InputGroup value={d.name} maxLength={80} onValueChange={d.setName} />
        </FormGroup>
      )}
      <Checkbox checked={d.attach} label={t.attachScreenshot} onChange={(e) => d.setAttach(e.currentTarget.checked)} />
      {d.attach && (
        <div className="bugspot-preview">
          {d.shot.kind === 'pending' && (
            <div className="bugspot-preview-wait">
              <Spinner size={20} /> {t.capturing}
            </div>
          )}
          {d.shot.kind === 'ready' && <img src={d.shot.shot.url} alt={t.screenshot} />}
          {d.shot.kind === 'failed' && (
            <Callout intent="warning" compact>
              {t.screenshotFailed}: {d.shot.message}
            </Callout>
          )}
          <div className="bugspot-preview-actions">
            <Button size="small" icon="refresh" text={t.retake} onClick={() => void d.take('dom')} />
            {'getDisplayMedia' in (navigator.mediaDevices ?? {}) && (
              <Button size="small" icon="camera" text={t.captureTab} onClick={() => void d.take('tab')} />
            )}
          </div>
        </div>
      )}
      {d.error && (
        <Callout intent="danger" compact>
          {d.error}
        </Callout>
      )}
      <div className="bugspot-form-actions">
        <Button text={t.cancel} onClick={onCancel} />
        <Button
          type="submit"
          intent="primary"
          icon="send-message"
          text={t.send}
          loading={d.busy}
          disabled={!d.body.trim()}
        />
      </div>
    </form>
  );
}
