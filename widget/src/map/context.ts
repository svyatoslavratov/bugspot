import { createContext, useContext } from 'react';

import type { LangChoice } from '../lib/i18n';
import type { MapDict } from './i18n';

export interface MapEnv {
  t: MapDict;
  lang: 'ru' | 'en';
  /** What the person chose: a language or the browser's. */
  choice: LangChoice;
  setChoice: (choice: LangChoice) => void;
}

export const MapContext = createContext<MapEnv | null>(null);

export function useMap(): MapEnv {
  const m = useContext(MapContext);
  if (!m) throw new Error('useMap outside MapContext');
  return m;
}
