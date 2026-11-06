import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../shared/api';

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads load() when deps change or reload() is called; the previous data stays on screen while the
 * next load runs. An answer that arrives after a newer request started is dropped.
 */
export function useData<T>(load: (() => Promise<T>) | null, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!load) return;
    const id = ++seq.current;
    setLoading(true);
    load().then(
      (value) => {
        if (id !== seq.current) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (id !== seq.current) return;
        setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, load === null]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}
