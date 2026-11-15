import { useEffect, useState } from 'react';

import type { Api } from '../shared/api';
import type { StateRef } from '../shared/types';

// Thumbnails go through the API (cookies or a token), never a bare <img src>; object URLs are kept
// per state and version, so a re-render or a re-layout does not load them again.
const cache = new Map<string, Promise<string>>();

export function useShot(api: Api, ref: StateRef | null, version: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!ref) return;
    const key = `${ref.screen}\u0000${ref.state}\u0000${version}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = api.shot(ref).then((blob) => URL.createObjectURL(blob));
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    let alive = true;
    pending.then(
      (u) => alive && setUrl(u),
      () => alive && setUrl(null),
    );
    return () => {
      alive = false;
    };
  }, [api, ref?.screen, ref?.state, version]);
  return ref ? url : null;
}
