import type { BuilderApi } from '@shared/api';

/**
 * The editor's API, whichever project it shows (#766): this computer's own, over Electron IPC (`window.builder`), or
 * another computer's, as a guest in its live session (the remote shell, lib/remote-session.ts). The editor reads one
 * `api` throughout; this routes each call when it is made, so a module that kept `api.project` or one of its methods
 * reaches whichever project is shown now.
 *
 * What is this computer's stays its own in either case: the app, its settings and AI keys, text-field Undo, the
 * menus, keys and appearance. What is the project's (`projects`, `project`, `ai`, `live`) goes to the remote project
 * while one is shown, and there only what the remote shell answers is ever done: a method it does not answer is
 * refused, never passed to this computer's own project by mistake.
 */

/** The namespaces that are the shown project's. */
const PROJECT_NAMESPACES = ['projects', 'project', 'ai', 'live'] as const;
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
  'remote:presence'
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
}

/** A transport over this computer's own API, read when first used (tests stand in a partial one). */
export function createTransport(local: () => BuilderApi): Transport {
  let shown: RemoteApi | null = null;
  const remoteListeners = new Map<string, Set<Listener>>();

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
    const offLocal = own(channel, (payload) => {
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
    }
  };
}
