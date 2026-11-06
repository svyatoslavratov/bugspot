import { createContext, useContext } from 'react';

import type { Dict } from '../lib/i18n';
import type { Api } from '../shared/api';
import type { Capture } from '../shared/capture';
import type { Session, Settings } from '../shared/types';

export interface Widget {
  api: Api;
  session: Session;
  capture: Capture;
  settings: Settings;
  t: Dict;
  /** The element that holds the shadow root: excluded from picking and screenshots. */
  host: HTMLElement;
}

export const WidgetContext = createContext<Widget | null>(null);

export function useWidget(): Widget {
  const w = useContext(WidgetContext);
  if (!w) throw new Error('useWidget outside WidgetContext');
  return w;
}
