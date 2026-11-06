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
   * More elements with the same problem, picked with Shift. The first element stays at the top
   * level, so readers that know one element keep working.
   */
  more?: ElementAnchor[];
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
}

export interface Session {
  visible: boolean;
  project?: string;
  user?: { id: string; name: string; provider: string };
  can?: Permissions;
  limits?: { screenshotMaxBytes: number; bodyMaxLength: number };
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
  status?: Status[];
  kind?: Kind;
  q?: string;
  page?: number;
  limit?: number;
}

/** Settings from the script tag and window.bugspotConfig. */
export interface Settings {
  /** Route mode: path, the hash path of a hash router, or auto (hash when the hash starts with #/). */
  route: 'auto' | 'path' | 'hash';
  appVersion?: string;
  theme: 'light' | 'dark' | 'auto';
  lang: 'ru' | 'en';
  position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
}
