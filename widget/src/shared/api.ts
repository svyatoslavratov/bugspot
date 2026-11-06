import type {
  Page,
  Session,
  Status,
  Summary,
  Thread,
  ThreadDetail,
  ThreadInput,
  ThreadQuery,
  Reply,
  Kind,
} from './types';

export interface ApiOptions {
  /** Service root, ending with a slash: https://app.example.com/bugspot/ */
  base: string;
  /** A custom fetch (the demo runs the API in WebAssembly). */
  fetch?: typeof fetch;
  /** A short-lived JWT for the jwt provider, sent in X-Bugspot-Token. */
  token?: () => string | null | undefined | Promise<string | null | undefined>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Api = ReturnType<typeof createApi>;

export function createApi(options: ApiOptions) {
  const base = options.base.endsWith('/') ? options.base : `${options.base}/`;
  const doFetch = options.fetch ?? window.fetch.bind(window);

  async function request(method: string, path: string, body?: BodyInit, json = true): Promise<Response> {
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['X-Bugspot-Request'] = '1';
    if (body !== undefined && json) headers['Content-Type'] = 'application/json';
    const token = await options.token?.();
    if (token) headers['X-Bugspot-Token'] = token;
    let res: Response;
    try {
      res = await doFetch(base + path, { method, headers, body, credentials: 'include' });
    } catch (cause) {
      throw new ApiError(0, 'network', cause instanceof Error ? cause.message : 'Network error');
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      throw new ApiError(res.status, err.code ?? 'error', err.error ?? res.statusText);
    }
    return res;
  }

  const send = async <T>(method: string, path: string, payload?: unknown): Promise<T> => {
    const res = await request(method, path, payload === undefined ? undefined : JSON.stringify(payload));
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  };

  const query = (q: ThreadQuery) => {
    const params = new URLSearchParams();
    if (q.route) params.set('route', q.route);
    if (q.status?.length) params.set('status', q.status.join(','));
    if (q.kind) params.set('kind', q.kind);
    if (q.q) params.set('q', q.q);
    if (q.page) params.set('page', String(q.page));
    if (q.limit) params.set('limit', String(q.limit));
    const s = params.toString();
    return s ? `?${s}` : '';
  };

  return {
    base,
    session: () => send<Session>('GET', 'api/v1/session'),
    openKey: (key: string) => send<Session>('POST', 'api/v1/session/key', { key }),
    closeKey: () => send<void>('DELETE', 'api/v1/session/key'),
    threads: (q: ThreadQuery) => send<Page<Thread>>('GET', `api/v1/threads${query(q)}`),
    summary: (route: string) => send<Summary>('GET', `api/v1/threads/summary${query({ route })}`),
    thread: (id: string) => send<ThreadDetail>('GET', `api/v1/threads/${encodeURIComponent(id)}`),
    create: (input: ThreadInput) => send<Thread>('POST', 'api/v1/threads', input),
    update: (id: string, patch: { status?: Status; body?: string; kind?: Kind }) =>
      send<Thread>('PATCH', `api/v1/threads/${encodeURIComponent(id)}`, patch),
    remove: (id: string) => send<void>('DELETE', `api/v1/threads/${encodeURIComponent(id)}`),
    reply: (id: string, body: string) =>
      send<Reply>('POST', `api/v1/threads/${encodeURIComponent(id)}/replies`, { body }),
    putScreenshot: async (id: string, image: Blob) => {
      await request('PUT', `api/v1/threads/${encodeURIComponent(id)}/screenshot`, image, false);
    },
    screenshot: async (id: string) =>
      (await request('GET', `api/v1/threads/${encodeURIComponent(id)}/screenshot`)).blob(),
  };
}
