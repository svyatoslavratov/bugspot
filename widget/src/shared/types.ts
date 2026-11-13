// API types: the same shapes as api/openapi.yaml.

export type Status = 'open' | 'in_progress' | 'fixed' | 'resolved' | 'wontfix';
export type Kind = 'issue' | 'question' | 'idea';

export const STATUSES: Status[] = ['open', 'in_progress', 'fixed', 'resolved', 'wontfix'];
/** Statuses that still need work; their pins stay on the page. */
export const ACTIVE_STATUSES: Status[] = ['open', 'in_progress', 'fixed'];

export interface Author {
  id: string;
  name: string;
  kind: 'user' | 'agent';
}

export interface Point {
  x: number;
  y: number;
}

/** Everything needed to find the element again after reloads and re-renders. */
export interface Anchor {
  selector: string;
  /** Normalized text of the element, up to 120 characters. */
  text: string;
  tag: string;
  /** Where inside the element the pin sits, as fractions of its width and height. */
  offset: Point;
  /** The click point on the page (document coordinates): the fallback position. */
  page: Point;
  viewport: { w: number; h: number };
  /** Source location from a data-bugspot-src attribute, when the app's dev build adds it. */
  source?: string;
  /**
   * The modal or popup the element was in: such an element is gone once the window closes, so its
   * pin shows only while the window is open, and the thread names the window.
   */
  layer?: Layer;
  /**
   * More elements with the same problem, picked with Shift. The first element stays at the top
   * level, so readers that know one element keep working.
   */
  more?: ElementAnchor[];
  /** The state of the screen (a tab or a dialog) a comment left on the screen map was made in. */
  state?: string;
}

/** A window that comes and goes over the page: a dialog (modal, alert) or a popup (menu, list). */
export interface Layer {
  kind: 'dialog' | 'popup';
  /** The window's title (aria-label, aria-labelledby or its first heading), up to 80 characters. */
  title?: string;
}

/** One element of an anchor. */
export type ElementAnchor = Omit<Anchor, 'more'>;

export interface ConsoleEntry {
  level: 'error' | 'warn';
  message: string;
  at: string;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  requestId?: string;
  durationMs: number;
  error?: string;
  at: string;
}

/** What the widget captures with a thread. */
export interface PageContext {
  userAgent: string;
  language: string;
  timeZone: string;
  viewport: { w: number; h: number; dpr: number };
  screen: { w: number; h: number };
  colorScheme: 'light' | 'dark';
  appVersion?: string;
  element?: { tag: string; text: string; selector: string; rect: { x: number; y: number; w: number; h: number } };
  console: ConsoleEntry[];
  network: NetworkEntry[];
}

export interface Allowed {
  edit: boolean;
  delete: boolean;
  reply: boolean;
  /** May tick "checked by a person" (people only, never agents). */
  verify: boolean;
  statuses: Status[];
}

export interface Thread {
  id: string;
  number: number;
  project: string;
  route: string;
  /** The screen of the map; a comment left on the map shows on every page of it. */
  screen?: string;
  url: string;
  title: string;
  kind: Kind;
  status: Status;
  statusBy?: Author;
  statusAt?: string;
  verified: boolean;
  verifiedBy?: Author;
  verifiedAt?: string;
  body: string;
  anchor: Partial<Anchor>;
  context: Partial<PageContext>;
  author: Author;
  hasScreenshot: boolean;
  replyCount: number;
  createdAt: string;
  updatedAt: string;
  allowed: Allowed;
}

export interface Reply {
  id: string;
  threadId: string;
  body: string;
  author: Author;
  createdAt: string;
}

export interface ThreadDetail extends Thread {
  replies: Reply[];
}

export interface Permissions {
  view: boolean;
  comment: boolean;
  reply: boolean;
  moderate: boolean;
  /** Open the screen map and edit it. */
  map?: boolean;
  /** Report screens and their look to the map while browsing. */
  collect?: boolean;
}

export interface Session {
  visible: boolean;
  project?: string;
  user?: { id: string; name: string; provider: string };
  can?: Permissions;
  limits?: { screenshotMaxBytes: number; bodyMaxLength: number };
  /** For those who build the screen map: what snapshots hide and how big they may be. */
  map?: { mask: 'none' | 'inputs' | 'text'; snapshotMaxBytes: number };
}

export interface Summary {
  total: Record<Status, number>;
  route: Record<Status, number>;
}

export interface Page<T> {
  data: T[];
  meta: { page: number; limit: number; total: number };
}

export interface ThreadInput {
  route: string;
  screen?: string;
  url: string;
  title: string;
  kind: Kind;
  body: string;
  anchor: Anchor;
  context: PageContext;
  authorName?: string;
}

export interface ThreadQuery {
  route?: string;
  /** With route: threads of the route or of the screen. */
  screen?: string;
  status?: Status[];
  kind?: Kind;
  q?: string;
  page?: number;
  limit?: number;
}

/** Where a new comment is written: the panel form, or a tiny box next to the element. */
export type ComposeMode = 'full' | 'tiny';

/** Settings from the script tag and window.bugspotConfig. */
export interface Settings {
  /** The default compose mode (data-mode); each person can switch it in the bug's menu. */
  mode: ComposeMode;
  /** The default picking shortcut (data-hotkey, "Alt+KeyC"; "off" — none); people can change it. */
  hotkey: string;
  /** Route mode: path, the hash path of a hash router, or auto (hash when the hash starts with #/). */
  route: 'auto' | 'path' | 'hash';
  /** Query parameters that make different screens on the map (data-route-params), e.g. ["tab"]. */
  routeParams: string[];
  appVersion?: string;
  theme: 'light' | 'dark' | 'auto';
  lang: 'ru' | 'en';
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
}

// The screen map.

export type StateKind = 'page' | 'tab' | 'dialog';
export type EdgeSource = 'observed' | 'link' | 'declared';

export interface StateRef {
  screen: string;
  state: string;
}

export interface ScreenState {
  key: string;
  kind: StateKind;
  name: string;
  description: string;
  hasShot: boolean;
  hasSnapshot: boolean;
  hash?: string;
  viewport?: { w: number; h: number };
  capturedAt?: string;
  lastSeen?: string;
}

export interface Screen {
  key: string;
  name: string;
  section: string;
  description: string;
  title: string;
  order: number;
  exampleUrl?: string;
  exampleRoute?: string;
  roles: string[];
  hidden: boolean;
  planned: boolean;
  position?: { x: number; y: number };
  states: ScreenState[];
  firstSeen?: string;
  lastSeen?: string;
  updatedAt: string;
}

export interface Edge {
  from: StateRef;
  to: StateRef;
  via: { name: string; kind: 'link' | 'button' | 'tab' | 'nav' | 'auto'; selector: string };
  source: EdgeSource;
  count: number;
  lastSeen: string;
}

export interface ScreenMap {
  screens: Screen[];
  edges: Edge[];
  aliases: Record<string, string>;
  /** Threads that still need work, by screen and status. */
  threads: Record<string, Partial<Record<Status, number>>>;
}

export interface VisitInput {
  screen: string;
  state: string;
  kind: StateKind;
  name: string;
  title?: string;
  url?: string;
  route?: string;
}

export interface EdgeInput {
  from: StateRef;
  to: StateRef;
  via: { name: string; kind: Edge['via']['kind']; selector: string };
  source: EdgeSource;
}

export interface CaptureInfo extends StateRef {
  hash?: string;
  hasShot: boolean;
  capturedAt?: string;
}

export interface SnapshotInput {
  html: string;
  css: string[];
  outline: object;
  viewport: { w: number; h: number };
  hash: string;
}

export interface SnapshotData extends StateRef {
  html: string;
  css: Record<string, string>;
  outline: object;
  viewport: { w: number; h: number };
  capturedAt: string;
}

export interface ScreenPatch {
  key: string;
  name?: string;
  section?: string;
  description?: string;
  order?: number;
  hidden?: boolean;
  position?: { x: number; y: number };
  mergeInto?: string;
}

/** What `bugspot map crawl` puts on the page before it loads (window.__bugspotCrawl). */
export interface CrawlConfig {
  /** An agent token with the read and map scopes: the crawl acts with it. */
  token?: string;
  /** Crawl at once, without asking. */
  auto?: boolean;
  buttons?: boolean;
  maxScreens?: number;
}

/** What applying a manifest changed. */
export interface ImportResult {
  created: number;
  updated: number;
  states: number;
  edges: number;
}
