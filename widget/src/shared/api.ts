import type {
  CaptureInfo,
  ImportResult,
  EdgeInput,
  ScreenMap,
  ScreenPatch,
  SnapshotData,
  SnapshotInput,
  StateRef,
  VisitInput,
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

const stateQuery = (ref: StateRef) => new URLSearchParams({ screen: ref.screen, state: ref.state }).toString();

export function createApi(options: ApiOptions) {
  const base = options.base.endsWith('/') ? options.base : `${options.base}/`;
  const doFetch = options.fetch ?? window.fetch.bind(window);

  async function request(
    method: string,
    path: string,
    body?: BodyInit,
    json = true,
    keepalive = false,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['X-Bugspot-Request'] = '1';
    if (body !== undefined && json) headers['Content-Type'] = 'application/json';
    const token = await options.token?.();
    if (token) headers['X-Bugspot-Token'] = token;
    let res: Response;
    try {
      res = await doFetch(base + path, { method, headers, body, credentials: 'include', keepalive });
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
    if (q.screen) params.set('screen', q.screen);
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
    summary: (route: string, screen?: string) =>
      send<Summary>('GET', `api/v1/threads/summary${query({ route, screen })}`),
    thread: (id: string) => send<ThreadDetail>('GET', `api/v1/threads/${encodeURIComponent(id)}`),
    create: (input: ThreadInput) => send<Thread>('POST', 'api/v1/threads', input),
    update: (id: string, patch: { status?: Status; body?: string; kind?: Kind; verified?: boolean }) =>
      send<Thread>('PATCH', `api/v1/threads/${encodeURIComponent(id)}`, patch),
    remove: (id: string) => send<void>('DELETE', `api/v1/threads/${encodeURIComponent(id)}`),
    reply: (id: string, body: string) =>
      send<Reply>('POST', `api/v1/threads/${encodeURIComponent(id)}/replies`, { body }),
    putScreenshot: async (id: string, image: Blob) => {
      await request('PUT', `api/v1/threads/${encodeURIComponent(id)}/screenshot`, image, false);
    },
    screenshot: async (id: string) =>
      (await request('GET', `api/v1/threads/${encodeURIComponent(id)}/screenshot`)).blob(),

    // The screen map.
    map: () => send<ScreenMap>('GET', 'api/v1/map'),
    captures: () => send<{ states: CaptureInfo[]; aliases: Record<string, string> }>('GET', 'api/v1/map/captures'),
    visits: async (visits: VisitInput[], edges: EdgeInput[], keepalive = false) => {
      await request('POST', 'api/v1/map/visits', JSON.stringify({ visits, edges }), true, keepalive);
    },
    missingAssets: (hashes: string[]) => send<{ missing: string[] }>('POST', 'api/v1/map/assets/missing', { hashes }),
    putAsset: async (hash: string, css: string) => {
      await request('PUT', `api/v1/map/assets/${hash}`, new Blob([css], { type: 'text/css' }), false);
    },
    putShot: async (ref: StateRef, image: Blob) => {
      await request('PUT', `api/v1/map/shot?${stateQuery(ref)}`, image, false);
    },
    shot: async (ref: StateRef) => (await request('GET', `api/v1/map/shot?${stateQuery(ref)}`)).blob(),
    putSnapshot: async (ref: StateRef, snapshot: SnapshotInput) => {
      await request('PUT', `api/v1/map/snapshot?${stateQuery(ref)}`, JSON.stringify(snapshot));
    },
    snapshot: (ref: StateRef) => send<SnapshotData>('GET', `api/v1/map/snapshot?${stateQuery(ref)}`),
    patchScreens: (patches: ScreenPatch[]) => send<void>('PATCH', 'api/v1/map/screens', patches),
    patchStates: (patches: { screen: string; state: string; name?: string; description?: string }[]) =>
      send<void>('PATCH', 'api/v1/map/states', patches),
    /** The manifest of the map as the service writes it (pretty JSON text). */
    exportManifest: async () => JSON.stringify(await send<unknown>('GET', 'api/v1/map/manifest'), null, 2),
    importManifest: async (text: string) => {
      const res = await request('POST', 'api/v1/map/manifest', text);
      return (await res.json()) as ImportResult;
    },
  };
}
