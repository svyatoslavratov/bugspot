// The screen map page (served at /map): the screens of the app laid out by section, what leads
// where, the real look of each state, and comments — the same threads the widget pins on pages.

import { BlueprintProvider, NonIdealState, Spinner } from '@blueprintjs/core';
import blueprintCss from '@blueprintjs/core/lib/css/blueprint.css?inline';
import flowCss from '@xyflow/react/dist/style.css?inline';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import widgetCss from '../app/styles.css?inline';
import { WidgetContext, type Widget } from '../app/context';
import { setupIcons } from '../app/icons';
import { DEFAULT_HOTKEY } from '../lib/hotkey';
import { dictionaries, resolveLang, type LangChoice } from '../lib/i18n';
import { loadPrefs, updatePrefs } from '../lib/prefs';
import { createApi } from '../shared/api';
import type { Capture } from '../shared/capture';
import type { Session, Settings } from '../shared/types';
import { mapDictionaries } from './i18n';
import { MapApp } from './MapApp';
import mapCss from './map.css?inline';
import { MapContext } from './context';

function adopt(css: string) {
  // Constructed stylesheets: the page's CSP needs no 'unsafe-inline' for its own styles.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

// A host page may hand in its own fetch, as the demo does with the API in WebAssembly.
const config = window.pinpathConfig ?? window.bugspotConfig;
const api = createApi({ base: new URL('./', location.href).href, fetch: config?.fetch, token: config?.token });
// The map page captures nothing of its own: threads made here describe the screen, not this page.
const noCapture: Capture = { console: [], network: [], uninstall: () => undefined };
const settings: Settings = {
  mode: 'full',
  hotkey: '',
  route: 'auto',
  routeParams: [],
  theme: 'light',
  lang: 'en',
  position: 'bottom-right',
};

// The language is shared with the widget when both live on one origin (the same settings in this
// browser); else the browser's.
const prefDefaults = { mode: 'full' as const, hotkey: DEFAULT_HOTKEY };

function Root() {
  const [session, setSession] = useState<Session | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [choice, setChoice] = useState<LangChoice>(() => loadPrefs(prefDefaults).lang);
  const lang = resolveLang(choice);
  const t = mapDictionaries[lang];
  const env = useMemo(
    () => ({
      t,
      lang,
      choice,
      setChoice: (next: LangChoice) => {
        updatePrefs({ lang: next }, prefDefaults);
        setChoice(next);
      },
    }),
    [t, lang, choice],
  );
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = `${t.title} · pinpath`;
  }, [lang, t.title]);
  useEffect(() => {
    api.session().then(setSession, (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
  }, []);
  if (failed) return <NonIdealState icon="error" title={t.loadError} description={failed} />;
  if (!session) return <NonIdealState icon={<Spinner />} title={t.loading} />;
  if (!session.visible || !session.can?.map) {
    return <NonIdealState icon="eye-off" title={t.noAccess} description={t.noAccessHint} />;
  }
  const widget: Widget = {
    api,
    session,
    capture: noCapture,
    settings: { ...settings, lang },
    t: dictionaries[lang],
    host: document.body,
  };
  return (
    <WidgetContext.Provider value={widget}>
      <MapContext.Provider value={env}>
        <MapApp />
      </MapContext.Provider>
    </WidgetContext.Provider>
  );
}

adopt(blueprintCss + flowCss + widgetCss + mapCss);
const container = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'));
void setupIcons().finally(() =>
  createRoot(container).render(
    <StrictMode>
      <BlueprintProvider>
        <Root />
      </BlueprintProvider>
    </StrictMode>,
  ),
);
