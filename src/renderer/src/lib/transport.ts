import type { BuilderApi, ProjectSnapshot } from '@shared/api';
import { ProjectFeedReader, type ProjectChange } from '@shared/project-feed';
import { perfHanded, perfMark } from './perf';

/**
 * The editor's API, whichever project it shows (#766): this computer's own, over Electron IPC (`window.builder`), or
 * another computer's, as a guest in its live session (the remote shell, lib/remote-session.ts). The editor reads one
 * `api` throughout; this routes each call when it is made, so a module that kept `api.project` or one of its methods
 * reaches whichever project is shown now.
 *
 * What is this computer's stays its own in either case: the app, its settings and AI keys, text-field Undo, the
 * menus, keys and appearance. What is the project's (`projects`, `project`, `ai`, `live`, `notes`) goes to the remote project
 * while one is shown, and there only what the remote shell answers is ever done: a method it does not answer is
 * refused, never passed to this computer's own project by mistake.
 */

/** The namespaces that are the shown project's. */
const PROJECT_NAMESPACES = ['projects', 'project', 'ai', 'live', 'notes'] as const;
type ProjectNamespace = (typeof PROJECT_NAMESPACES)[number];
/** Every namespace of the API. */
const NAMESPACES = ['app', 'edit', 'dialogs', ...PROJECT_NAMESPACES, 'remote'] as const;
type Namespace = (typeof NAMESPACES)[number];

/**
 * The events that are this computer's: the menus, real key presses, appearance and the app's own dialogs, and the
 * remote shell's own connection. Every other event is the shown project's, and comes from it alone.
 */
export const DEVICE_CHANNELS: ReadonlySet<string> = new Set([
  'menu:command',
  'menu:history',
  'input:key',
  'lifecycle:request',
  'appearance',
  'create:progress',
  'projects:unpacking',
  'remote:state',
  'remote:changed',
  'remote:reload',
  'remote:presence',
  'remote:ai',
  'remote:notes'
]);

/** What the remote shell answers, namespace by namespace: anything missing is refused while it is shown. */
export type RemoteApi = { [N in ProjectNamespace]?: Partial<Record<keyof BuilderApi[N] & string, (...args: never[]) => unknown>> };

/** The refusal for a project method the remote shell does not answer. */
export class HostOnlyError extends Error {
  constructor(readonly method: string) {
    super('That is only available on the host’s computer in a live session.');
    this.name = 'HostOnlyError';
  }
}

type Listener = (payload: unknown) => void;

export interface Transport {
  /** The API the editor uses. */
  readonly api: BuilderApi;
  /** Show another computer's project (its remote shell's answers), or this computer's own again (null). */
  use(remote: RemoteApi | null): void;
  /** Whether another computer's project is shown. */
  readonly remote: boolean;
  /** An event of the shown remote project, for the editor's listeners; dropped unless `remote` is the one shown. */
  emit(remote: RemoteApi, channel: string, payload: unknown): void;
  /**
   * This computer's open project as it is now, or null, for an editor page that has just loaded: the changes
   * `project:changed` brings from then on are made against it.
   */
  current(): Promise<ProjectSnapshot | null>;
}

/** A transport over this computer's own API, read when first used (tests stand in a partial one). */
export function createTransport(local: () => BuilderApi): Transport {
  let shown: RemoteApi | null = null;
  const remoteListeners = new Map<string, Set<Listener>>();
  // This computer's project comes as changes from the copy sent before (shared/project-feed.ts), read once here into
  // the snapshot the editor's listeners are handed, whichever project is shown, so the copy held keeps up. One that
  // does not fit the copy held (a change missed) asks for the whole project, once until it comes, and again a while
  // later while asking fails. The messages come in order; a page's first copy, the answer to `current`, comes another
  // way and can overtake them or be overtaken.
  const feed = new ProjectFeedReader();
  const changedListeners = new Set<Listener>();
  let offFeed: (() => void) | null = null;
  /** The highest message number seen, read or not. */
  let seen = 0;
  /** The page's first copy's number, until a message after it has come: any before it is already in that copy. */
  let floor = 0;
  /** Changes that came before the copy they are made against (a page's first, still on its way), to be read on it. */
  let early: ProjectChange[] = [];
  /** Waiting for the whole project asked for again: the page's first copy, once it was found behind. */
  let wholeWaiters: Array<(s: ProjectSnapshot | null) => void> = [];
  /** Projects closed so far: what was asked for before the last close is not the open project's. */
  let closes = 0;
  let resyncing = false;
  let retryMs = 500;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const behind = () => feed.seq === null || feed.seq < seen;
  const stopAsking = () => {
    resyncing = false;
    retryMs = 500;
    if (retry) clearTimeout(retry);
    retry = null;
  };
  const ask = () => {
    if (resyncing || retry) return;
    resyncing = true;
    const asked = closes;
    void Promise.resolve()
      .then(() => local().project.resync())
      .then(
        // Nothing open to send: nothing to wait for.
        (sent) => asked === closes && sent === false && stopAsking(),
        () => {
          if (asked !== closes) return;
          resyncing = false;
          const wait = retryMs;
          retryMs = Math.min(retryMs * 2, 10_000);
          retry = setTimeout(() => {
            retry = null;
            if (behind()) ask();
          }, wait);
        }
      );
  };
  const settleWaiters = (s: ProjectSnapshot | null) => {
    for (const w of wholeWaiters.splice(0)) w(s);
  };
  const onChange = (payload: unknown) => {
    const change = payload as ProjectChange;
    perfMark('renderer.snapshotReceived', { revision: change.revision });
    // Sent before the page's first copy was made, which holds it already; and a change older than the copy held.
    if (floor && change.seq <= floor) return;
    floor = 0;
    if (change.base !== null && feed.seq !== null && change.seq <= feed.seq) return;
    seen = Math.max(seen, change.seq);
    const snapshot = feed.read(change);
    perfHanded(snapshot);
    if (change.base === null) {
      stopAsking();
      early = [];
      settleWaiters(snapshot);
    }
    if (!snapshot) {
      if (early.length < 64) early.push(change);
      ask();
      return;
    }
    if (!shown) for (const cb of [...changedListeners]) cb(snapshot);
  };
  const onClosed = () => {
    // Its copy is not kept once the project has gone, nor anything waiting on it.
    closes++;
    feed.forget();
    early = [];
    floor = 0;
    stopAsking();
    settleWaiters(null);
  };

  const route = (ns: Namespace, name: string) => {
    if (shown && (PROJECT_NAMESPACES as readonly string[]).includes(ns)) {
      const own = shown[ns as ProjectNamespace]?.[name as never] as ((...args: unknown[]) => unknown) | undefined;
      if (own) return own;
      return () => Promise.reject(new HostOnlyError(`${ns}.${name}`));
    }
    const target = (local() as unknown as Record<string, Record<string, unknown>>)[ns]?.[name];
    if (typeof target !== 'function') throw new TypeError(`api.${ns}.${name} is not a function`);
    return target as (...args: unknown[]) => unknown;
  };

  /** Each namespace's methods, made once and kept: the same function for the same name, routed when called. */
  const namespace = (ns: Namespace) => {
    const methods = new Map<string, (...args: unknown[]) => unknown>();
    return new Proxy({} as Record<string, unknown>, {
      get(_target, name) {
        if (typeof name !== 'string') return undefined;
        let method = methods.get(name);
        if (!method) {
          method = (...args: unknown[]) => route(ns, name)(...args);
          methods.set(name, method);
        }
        return method;
      },
      has: (_target, name) => typeof name === 'string'
    });
  };
  const namespaces = Object.fromEntries(NAMESPACES.map((ns) => [ns, namespace(ns)])) as Record<Namespace, Record<string, unknown>>;

  const on = (channel: string, cb: Listener): (() => void) => {
    const own = local().on as unknown as (channel: string, cb: Listener) => () => void;
    if (DEVICE_CHANNELS.has(channel)) return own(channel, cb);
    // This computer's project speaks only while it is the one shown; the remote one only while it is.
    let offLocal: () => void;
    if (channel === 'project:changed') {
      changedListeners.add(cb);
      if (!offFeed) {
        const offChanged = own(channel, onChange);
        const offClosed = own('project:closed', onClosed);
        offFeed = () => (offChanged(), offClosed(), stopAsking());
      }
      offLocal = () => {
        changedListeners.delete(cb);
        if (changedListeners.size) return;
        offFeed?.();
        offFeed = null;
      };
    } else
      offLocal = own(channel, (payload) => {
        if (!shown) cb(payload);
      });
    const set = remoteListeners.get(channel) ?? new Set<Listener>();
    remoteListeners.set(channel, set);
    set.add(cb);
    return () => {
      offLocal();
      set.delete(cb);
    };
  };

  const api = {
    get platform() {
      return local().platform;
    },
    ...namespaces,
    on,
    inspectResult: (...args: Parameters<BuilderApi['inspectResult']>) => local().inspectResult(...args),
    componentPreviewResult: (...args: Parameters<BuilderApi['componentPreviewResult']>) => local().componentPreviewResult(...args),
    previewControlResult: (...args: Parameters<BuilderApi['previewControlResult']>) => local().previewControlResult(...args),
    menuReady: () => local().menuReady(),
    menuReceived: (id: number) => local().menuReceived(id),
    leaveResult: (...args: Parameters<BuilderApi['leaveResult']>) => local().leaveResult(...args),
    pathForFile: (file: File) => local().pathForFile(file)
  } as unknown as BuilderApi;

  return {
    api,
    use(remote) {
      shown = remote;
    },
    get remote() {
      return shown !== null;
    },
    emit(remote, channel, payload) {
      if (shown !== remote) return;
      for (const cb of [...(remoteListeners.get(channel) ?? [])]) cb(payload);
    },
    async current() {
      const before = closes;
      const change = await local().project.feed();
      // None open, or closed while this was on its way.
      if (!change || closes !== before) return null;
      // A whole sent since, on project:changed, is newer than this answer.
      if (feed.seq !== null && feed.seq > change.seq) return feed.snapshot;
      feed.read(change);
      // Messages still to come that were sent before it are in it already.
      if (seen < change.seq) floor = change.seq;
      seen = Math.max(seen, change.seq);
      // Changes made against it that came before it are read on it, in order.
      for (const c of early.filter((c) => c.seq > change.seq).sort((a, b) => a.seq - b.seq)) feed.read(c);
      early = [];
      perfHanded(feed.snapshot);
      if (!behind()) return feed.snapshot;
      // Still behind a change it could not read: never the older copy, but the whole project asked for again.
      ask();
      return new Promise<ProjectSnapshot | null>((resolve) => wholeWaiters.push(resolve));
    }
  };
}
