import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { anchorsOf, buildAnchor, combineAnchors, pinPoint, resolveAnchor } from '../lib/anchor';
import { pageContext } from '../lib/context';
import { DEFAULT_HOTKEY, formatHotkey, matchesHotkey, parseHotkey } from '../lib/hotkey';
import { loadPrefs, savePrefs, setPendingThread, takePendingThread, type Prefs } from '../lib/prefs';
import { currentRoute, onRouteChange } from '../lib/route';
import { ACTIVE_STATUSES, type ComposeMode, type Status, type Thread } from '../shared/types';
import { BugButton } from './BugButton';
import { useWidget } from './context';
import { Flash, FLASH_MS } from './Flash';
import { NewThread } from './NewThread';
import { Panel, type StatusFilter, type Tab } from './Panel';
import { Picker, type Pick } from './Picker';
import { PinLayer } from './PinLayer';
import { QuickComposer } from './QuickComposer';
import { SettingsMenu } from './SettingsMenu';
import { ThreadView } from './ThreadView';
import { useData } from './useData';
import type { Draft, Target } from './useDraft';

export interface AppHandle {
  open(threadId?: string): void;
  close(): void;
  refresh(): void;
}

export type View = { kind: 'list' } | { kind: 'thread'; id: string } | ({ kind: 'new'; draft?: Draft } & Target);

const POLL_MS = 30_000;

function statusesOf(filter: StatusFilter): Status[] | undefined {
  if (filter === 'all') return undefined;
  if (filter === 'active') return ACTIVE_STATUSES;
  return [filter];
}

export const App = forwardRef<AppHandle>(function App(_, ref) {
  const { api, settings, capture, session, t } = useWidget();
  const canComment = session.can?.comment ?? false;
  const [prefs, setPrefs] = useState<Prefs>(() =>
    loadPrefs({
      mode: settings.mode,
      // The site's shortcut is checked here (the loader stays small); a bad one falls back.
      hotkey: settings.hotkey === '' || parseHotkey(settings.hotkey) ? settings.hotkey : DEFAULT_HOTKEY,
    }),
  );
  const recordingHotkey = useRef(false);
  // The tiny box at the element (tiny mode) instead of the form in the panel.
  const [quick, setQuick] = useState<Target | null>(null);
  const [route, setRoute] = useState(() => currentRoute(settings.route));
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  // After a comment is sent, picking goes on with a note about it; Esc then restores the panel as
  // it was before picking began (closed after a right-click on the bug).
  const [pickNotice, setPickNotice] = useState<string | undefined>();
  const openBeforePicking = useRef(false);
  const [flash, setFlash] = useState<{ thread: Thread; key: number } | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [tab, setTab] = useState<Tab>('page');
  const [status, setStatus] = useState<StatusFilter>('active');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [version, setVersion] = useState(0);

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => onRouteChange(() => setRoute(currentRoute(settings.route))), [settings.route]);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);
  // Polling keeps pins and lists fresh while someone else (or an agent) answers.
  useEffect(() => {
    const tickIfVisible = () => document.visibilityState === 'visible' && refresh();
    const id = setInterval(tickIfVisible, POLL_MS);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  const pins = useData(() => api.threads({ route, status: ACTIVE_STATUSES, limit: 100 }), [route, version]);
  const summary = useData(() => api.summary(route), [route, version]);
  const list = useData(
    open && view.kind === 'list'
      ? () =>
          api.threads({
            route: tab === 'page' ? route : undefined,
            status: statusesOf(status),
            q: debouncedQuery || undefined,
            limit: 100,
          })
      : null,
    [open, view.kind, tab, route, status, debouncedQuery, version],
  );

  const openThread = useCallback((id: string) => {
    setOpen(true);
    setPicking(false);
    setPickNotice(undefined);
    setView({ kind: 'thread', id });
  }, []);

  const startPicking = useCallback(() => {
    openBeforePicking.current = open;
    setPickNotice(undefined);
    setPicking(true);
  }, [open]);
  const cancelPicking = useCallback(() => {
    setPicking(false);
    setPickNotice(undefined);
    setQuick(null);
    setOpen(openBeforePicking.current);
  }, []);
  /** After a comment is sent the next element can be picked at once; Esc finishes. */
  const pickNext = useCallback(
    (thread: Thread) => {
      refresh();
      setPickNotice(t.sentNumber(thread.number));
      setPicking(true);
    },
    [refresh, t],
  );

  // The picking shortcut: starts picking, a second press cancels it. Not while a comment is being
  // written or a new shortcut is being recorded.
  const hotkey = useMemo(() => parseHotkey(prefs.hotkey), [prefs.hotkey]);
  const composing = quick !== null || (open && view.kind === 'new');
  useEffect(() => {
    if (!hotkey || !canComment) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || recordingHotkey.current || !matchesHotkey(e, hotkey)) return;
      if (composing && !picking) return;
      e.preventDefault();
      e.stopPropagation();
      if (picking) cancelPicking();
      else startPicking();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [hotkey, canComment, composing, picking, startPicking, cancelPicking]);

  const setMode = useCallback((mode: ComposeMode) => updatePrefs({ mode }), [updatePrefs]);
  const setHotkey = useCallback((value: string) => updatePrefs({ hotkey: value }), [updatePrefs]);
  const setPins = useCallback((on: boolean) => updatePrefs({ pins: on }), [updatePrefs]);
  const setRecording = useCallback((on: boolean) => void (recordingHotkey.current = on), []);

  // Closing the panel cancels a comment being written there, as "Cancel" does: a forgotten draft
  // must not come back on the next open or keep the shortcut from picking.
  useEffect(() => {
    if (!open) setView((v) => (v.kind === 'new' ? { kind: 'list' } : v));
  }, [open]);

  useEffect(() => {
    const pending = takePendingThread();
    if (pending) openThread(pending);
  }, [openThread]);

  useImperativeHandle(ref, () => ({
    open: (id?: string) => (id ? openThread(id) : setOpen(true)),
    close: () => setOpen(false),
    refresh,
  }));

  /** Scrolls to the thread's element and highlights it and its pin for a moment. */
  const showOnPage = useCallback((thread: Thread) => {
    const el = anchorsOf(thread.anchor)
      .map((a) => resolveAnchor(a))
      .find((e) => e !== null);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else if (thread.anchor.layer) {
      // The element is in a closed modal or popup: nothing to show, the thread says where it is.
      return;
    } else {
      const point = pinPoint(thread.anchor, null);
      if (point) scrollTo({ top: Math.max(0, point.y + scrollY - innerHeight / 2), behavior: 'smooth' });
    }
    setFlash({ thread, key: Date.now() });
  }, []);
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(id);
  }, [flash]);

  const goToThread = useCallback(
    (thread: Thread) => {
      if (thread.route === route) {
        openThread(thread.id);
        return;
      }
      setPendingThread(thread.id);
      location.href = thread.url;
    },
    [route, openThread],
  );

  const onPick = useCallback(
    (picks: Pick[]) => {
      if (picks.length === 0) return;
      setPicking(false);
      setPickNotice(undefined);
      const target: Target = {
        picks,
        anchor: combineAnchors(picks.map((p) => buildAnchor(p.el, p.point))),
        context: pageContext(capture, settings.appVersion, picks[0].el),
      };
      if (prefs.mode === 'tiny') {
        setQuick(target);
        return;
      }
      setOpen(true);
      setView({ kind: 'new', ...target });
    },
    [capture, settings.appVersion, prefs.mode],
  );

  const counts = useMemo(() => {
    const sum = (m: Record<Status, number> | undefined) => ACTIVE_STATUSES.reduce((n, s) => n + (m?.[s] ?? 0), 0);
    return { page: sum(summary.data?.route), all: sum(summary.data?.total) };
  }, [summary.data]);

  const selectedId = view.kind === 'thread' ? view.id : null;

  return (
    <>
      {prefs.pins && (
        <PinLayer
          threads={pins.data?.data ?? []}
          selectedId={selectedId}
          flashId={flash?.thread.id ?? null}
          passive={picking}
          onOpen={openThread}
        />
      )}
      {flash && !picking && <Flash key={flash.key} anchor={flash.thread.anchor} />}
      {picking && <Picker notice={pickNotice} onPick={onPick} onCancel={cancelPicking} />}
      {quick && !picking && (
        <QuickComposer
          key={quick.picks.map((p) => p.point.x + ':' + p.point.y).join()}
          target={quick}
          route={route}
          onCreated={(thread) => {
            setQuick(null);
            pickNext(thread);
          }}
          onCancel={cancelPicking}
          onExpand={(draft) => {
            setQuick(null);
            setOpen(true);
            setView({ kind: 'new', ...quick, draft });
          }}
        />
      )}
      <BugButton
        count={counts.page}
        open={open}
        position={prefs.button}
        hint={canComment ? t.bugHint(formatHotkey(prefs.hotkey)) : t.title}
        onMove={(button) => updatePrefs({ button })}
        onClick={() => setOpen((o) => !o)}
        onQuick={canComment ? startPicking : undefined}
      />
      {open && !picking && (
        <Panel
          buttonPosition={prefs.button}
          peek={flash !== null}
          tab={tab}
          counts={counts}
          status={status}
          query={query}
          pins={prefs.pins}
          list={list}
          view={view}
          onTab={setTab}
          onStatus={setStatus}
          onQuery={setQuery}
          onPins={setPins}
          settings={
            canComment ? (
              <SettingsMenu prefs={prefs} onMode={setMode} onHotkey={setHotkey} onRecording={setRecording} />
            ) : undefined
          }
          onNew={startPicking}
          onClose={() => setOpen(false)}
          onSelect={goToThread}
        >
          {view.kind === 'thread' && (
            <ThreadView
              id={view.id}
              version={version}
              currentRoute={route}
              onBack={() => setView({ kind: 'list' })}
              onChanged={refresh}
              onGo={goToThread}
              onShow={showOnPage}
            />
          )}
          {view.kind === 'new' && (
            <NewThread
              view={view}
              route={route}
              onCancel={() => setView({ kind: 'list' })}
              onCreated={(thread) => {
                setView({ kind: 'thread', id: thread.id });
                pickNext(thread);
              }}
            />
          )}
        </Panel>
      )}
    </>
  );
});
