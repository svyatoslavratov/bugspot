import { Menu, MenuDivider, MenuItem } from '@blueprintjs/core';
import { useEffect, useState } from 'react';

import { DEFAULT_HOTKEY, formatHotkey, hotkeyFromEvent } from '../lib/hotkey';
import type { Prefs } from '../lib/prefs';
import type { ComposeMode } from '../shared/types';
import { useWidget } from './context';

const lone = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/**
 * The bug's context menu (right click): pick an element, where new comments are written (tiny box
 * at the element or the full form in the panel), the picking shortcut (press a new one, back to
 * the default, or off) and pins on the page. Settings stay in this browser.
 */
export function BugMenu({
  prefs,
  canComment,
  onPick,
  onMode,
  onHotkey,
  onPins,
  onRecording,
}: {
  prefs: Prefs;
  canComment: boolean;
  onPick: () => void;
  onMode: (mode: ComposeMode) => void;
  onHotkey: (hotkey: string) => void;
  onPins: (on: boolean) => void;
  /** While a new shortcut is being recorded the current one must not fire. */
  onRecording: (on: boolean) => void;
}) {
  const { t } = useWidget();
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    onRecording(recording);
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      // Before the page and the menu: Esc here cancels recording, not the menu.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') return setRecording(false);
      if (e.key === 'Backspace' || e.key === 'Delete') {
        onHotkey('');
        return setRecording(false);
      }
      const next = hotkeyFromEvent(e);
      if (next) {
        onHotkey(next);
        setRecording(false);
      } else if (!lone.test(e.code)) {
        setHint(t.hotkeyNeedsModifier);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      setHint(null);
      onRecording(false);
    };
  }, [recording, onHotkey, onRecording, t]);

  const current = formatHotkey(prefs.hotkey);
  return (
    <Menu className="bugspot-menu">
      {canComment && (
        <>
          <MenuItem icon="comment" text={t.pickElement} label={current || t.altClick} onClick={onPick} />
          <MenuDivider title={t.commentForm} />
          {(['tiny', 'full'] as ComposeMode[]).map((mode) => (
            <MenuItem
              key={mode}
              roleStructure="listoption"
              selected={prefs.mode === mode}
              text={mode === 'tiny' ? t.modeTiny : t.modeFull}
              shouldDismissPopover={false}
              onClick={() => onMode(mode)}
            />
          ))}
          <MenuDivider title={t.hotkeyTitle} />
          <MenuItem
            text={recording ? (hint ?? t.hotkeyPress) : current || t.hotkeyOff}
            label={recording ? undefined : t.hotkeyChange}
            intent={recording && hint ? 'warning' : undefined}
            active={recording}
            shouldDismissPopover={false}
            onClick={() => setRecording((r) => !r)}
          />
          {!recording && prefs.hotkey !== DEFAULT_HOTKEY && (
            <MenuItem
              text={t.hotkeyDefault(formatHotkey(DEFAULT_HOTKEY))}
              shouldDismissPopover={false}
              onClick={() => onHotkey(DEFAULT_HOTKEY)}
            />
          )}
          {!recording && prefs.hotkey && (
            <MenuItem text={t.hotkeyDisable} shouldDismissPopover={false} onClick={() => onHotkey('')} />
          )}
          <MenuDivider />
        </>
      )}
      <MenuItem
        icon={prefs.pins ? 'eye-off' : 'eye-open'}
        text={prefs.pins ? t.hidePins : t.showPins}
        shouldDismissPopover={false}
        onClick={() => onPins(!prefs.pins)}
      />
    </Menu>
  );
}
