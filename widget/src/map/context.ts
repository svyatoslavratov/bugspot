import { createContext, useContext } from 'react';

import type { MapDict } from './i18n';

export interface MapEnv {
  t: MapDict;
  lang: 'ru' | 'en';
}

export const MapContext = createContext<MapEnv | null>(null);

export function useMap(): MapEnv {
  const m = useContext(MapContext);
  if (!m) throw new Error('useMap outside MapContext');
  return m;
}
