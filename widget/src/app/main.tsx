import { BlueprintProvider, Classes } from '@blueprintjs/core';
import blueprintCss from '@blueprintjs/core/lib/css/blueprint.css?inline';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { dictionaries } from '../lib/i18n';
import type { PinpathHandle, MountOptions } from '../loader';
import { App, type AppHandle } from './App';
import { WidgetContext } from './context';
import { setupIcons } from './icons';
import widgetCss from './styles.css?inline';

// Variables Blueprint declares on :root must live on the shadow host to reach the widget.
const css = blueprintCss.replaceAll(':root', ':host') + widgetCss;

function adoptStyles(root: ShadowRoot) {
  // Constructed stylesheets need no 'unsafe-inline' in the page's CSP.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    root.append(style);
  }
}

export function mount(options: MountOptions): PinpathHandle {
  const host = document.createElement('pinpath-widget');
  host.setAttribute('data-pinpath-ignore', '');
  const shadow = host.attachShadow({ mode: 'open' });
  adoptStyles(shadow);
  const dark =
    options.settings.theme === 'dark' ||
    (options.settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const container = document.createElement('div');
  container.className = `pinpath ${dark ? Classes.DARK : ''}`;
  const portal = document.createElement('div');
  portal.className = `pinpath-portal ${dark ? Classes.DARK : ''}`;
  shadow.append(container, portal);
  document.body.append(host);

  const handle: { current: AppHandle | null } = { current: null };
  const root = createRoot(container);
  void setupIcons().finally(() =>
    root.render(
      <StrictMode>
        <WidgetContext.Provider value={{ ...options, t: dictionaries[options.settings.lang], host }}>
          <BlueprintProvider portalContainer={portal}>
            <App ref={(h) => void (handle.current = h)} />
          </BlueprintProvider>
        </WidgetContext.Provider>
      </StrictMode>,
    ),
  );
  return {
    open: (id) => handle.current?.open(id),
    close: () => handle.current?.close(),
    refresh: () => handle.current?.refresh(),
    destroy: () => {
      root.unmount();
      host.remove();
      options.capture.uninstall();
      delete window.pinpath;
      delete window.bugspot;
    },
  };
}
