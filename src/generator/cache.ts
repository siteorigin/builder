/**
 * Reuse of generated files between runs of `generateProject` on successive states of one project.
 *
 * Each state-dependent file is made by one generator call against a view of the state that records what it reads:
 * each field of a page node, page, component, site settings, collection settings and collection entry, every other
 * document whole, and which entries exist. A later run gives back the earlier content when everything that call read is the same, so the output is
 * the bytes a full run makes. What a file reads is found by watching it being made, never declared, so a generator
 * that starts reading something new is followed without any change here.
 *
 * Values are compared field for field (`sameValue`), never by their JSON: a key holding `undefined` can read
 * differently from a missing one.
 */
import type { ProjectState } from '@shared/types';
import { sameValue } from '@shared/same';

/**
 * Where reads are told apart: under a key listed here (`*` for any key) each entry is a view of its own, and reads
 * of its fields are recorded one by one. Anything else is handed out as it is and counts as read whole.
 */
interface Shape {
  [key: string]: Shape;
}
const SHAPE: Shape = { pages: { '*': { nodes: { '*': {} } } }, components: { '*': {} }, site: {}, collections: { '*': { settings: {}, entries: { '*': {} } } } };

/**
 * A thing read: `=` a value, `?` what kind of entry sits at a key (its fields are recorded one by one), `h` whether a
 * key is there at all (own or inherited), `#` how an own key is held (enumerable, a value or a getter), `*` the keys,
 * `@` a derived value (its path is its name).
 */
type Kind = '=' | '?' | 'h' | '#' | '*' | '@';

interface Dep {
  kind: Kind;
  path: string[];
  /** For a derived value: how it is worked out. */
  compute?: (state: ProjectState) => unknown;
  /** The last value seen for it, and the version number that value was given. */
  value?: unknown;
  v?: number;
  /** The state its version was last worked out for: a state never changes while it is generated from. */
  state?: ProjectState;
  stateV?: number;
}

interface Entry {
  content: string;
  /** Each thing the file read, with the version it had then. */
  deps: Array<[Dep, number]>;
}

const ABSENT = Symbol('absent');
/** Marks a value found on the prototype, so it never compares equal to the same value held as an own key. */
const INHERITED = Symbol('inherited');
const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null;

function refuse(): never {
  throw new Error('Generated files are made from the project documents and never change them.');
}

/** What a file is being made from; `deps` is null while nothing is being made. */
interface Recorder {
  deps: Set<string> | null;
  /** One view per path, so an entry read twice is the same object both times. */
  views: Map<string, object>;
}

type Deriver = <T>(name: string, compute: (state: ProjectState) => T) => T;
/** The tracked state of each run in progress, with how it reads a derived value. */
const deriving = new WeakMap<object, Deriver>();

/**
 * A value worked out from the whole project (`compute` must read nothing but the state it is given, and `name`
 * always name the same `compute`). In a cached run, a file that reads it depends on its result alone, worked out once
 * per state from the plain state, not on everything that went into it. Outside one it is simply `compute(state)`.
 */
export function derived<T>(state: ProjectState, name: string, compute: (state: ProjectState) => T): T {
  const read = deriving.get(state);
  return read ? read(name, compute) : compute(state);
}

/** Whether `state` is the tracked state of a cached run, where derived values are worked out once per state. */
export function isTracked(state: ProjectState): boolean {
  return deriving.has(state);
}

const childShape = (shape: Shape, key: string): Shape | undefined => (Object.hasOwn(shape, key) ? shape[key] : Object.hasOwn(shape, '*') ? shape['*'] : undefined);

/** A read-only view of `target`, found at `path` in the state, that records each read. */
function view<T extends object>(target: T, path: string[], shape: Shape, rec: Recorder): T {
  // The JSON of the path without its closing bracket: a key's dependency is one append away.
  const head = JSON.stringify(path).slice(0, -1) + (path.length ? ',' : '');
  const known = rec.views.get(head);
  if (known) return known as T;
  const note = (kind: Kind, key: string) => rec.deps?.add(kind + head + JSON.stringify(key) + ']');
  /** The shape of an own object field handed out as a view; none for a field that must be handed out as it is. */
  const nested = (t: object, key: string): Shape | undefined => {
    const sub = childShape(shape, key);
    if (!sub) return undefined;
    const d = Reflect.getOwnPropertyDescriptor(t, key);
    // A proxy must give a fixed field's own value back, so one that can never change is read whole.
    return d && 'value' in d && isObject(d.value) && (d.configurable || d.writable) ? sub : undefined;
  };
  const proxy = new Proxy(target, {
    get(t, key) {
      const v = Reflect.get(t, key);
      if (typeof key !== 'string') return v;
      const sub = nested(t, key);
      if (!sub) {
        note('=', key);
        return v;
      }
      note('?', key);
      return view(v as object, [...path, key], sub, rec);
    },
    has(t, key) {
      if (typeof key === 'string') note('h', key);
      return Reflect.has(t, key);
    },
    getOwnPropertyDescriptor(t, key) {
      const d = Reflect.getOwnPropertyDescriptor(t, key);
      if (typeof key !== 'string') return d;
      note('#', key);
      // A descriptor carries the value, so an entry read this way is handed out as a view as well.
      const sub = d?.configurable ? nested(t, key) : undefined;
      if (!sub) {
        note('=', key);
        return d;
      }
      note('?', key);
      return { ...d, value: view(d!.value as object, [...path, key], sub, rec) };
    },
    ownKeys(t) {
      rec.deps?.add('*' + JSON.stringify(path));
      return Reflect.ownKeys(t);
    },
    set: refuse,
    defineProperty: refuse,
    deleteProperty: refuse,
    setPrototypeOf: refuse,
    preventExtensions: refuse
  });
  rec.views.set(head, proxy);
  return proxy;
}

/** What `dep` reads in `state`, in the form it is compared in. */
function current(state: ProjectState, dep: Dep): unknown {
  // Worked out from the plain state: a derived value is as cheap to recompute as a walk of the documents.
  if (dep.kind === '@') return Object.freeze(dep.compute!(state));
  let at: unknown = state;
  const steps = dep.kind === '*' ? dep.path.length : dep.path.length - 1;
  for (let i = 0; i < steps; i++) {
    if (!isObject(at) || !Object.hasOwn(at, dep.path[i])) return ABSENT;
    at = (at as Record<string, unknown>)[dep.path[i]];
  }
  if (!isObject(at)) return ABSENT;
  if (dep.kind === '*') return Reflect.ownKeys(at);
  const key = dep.path[dep.path.length - 1];
  if (dep.kind === 'h') return Reflect.has(at, key);
  const d = Reflect.getOwnPropertyDescriptor(at, key);
  if (dep.kind === '#') return d ? `${d.enumerable}:${d.configurable}:${'value' in d ? d.writable : 'get'}` : ABSENT;
  if (!d) {
    if (dep.kind === '?') return ABSENT;
    const v = Reflect.get(at, key);
    return v === undefined ? ABSENT : { [INHERITED]: v };
  }
  const v = Reflect.get(at, key);
  if (dep.kind === '?' && isObject(v)) return Array.isArray(v) ? 'array' : 'object';
  return v;
}

export class GenerationCache {
  private entries = new Map<string, Entry>();
  /** Every thing read by a file still cached, by its recorded name. */
  private deps = new Map<string, Dep>();
  private counter = 0;
  /** Keys of the files the last run had to make, for tests and timing. */
  made: string[] = [];

  private dep(name: string): Dep {
    let d = this.deps.get(name);
    if (!d) this.deps.set(name, (d = { kind: name[0] as Kind, path: JSON.parse(name.slice(1)) as string[] }));
    return d;
  }

  private version(state: ProjectState, dep: Dep): number {
    if (dep.state === state) return dep.stateV!;
    const value = current(state, dep);
    // A version number only ever stands for one value, so equal numbers mean the same value.
    if (dep.v === undefined || !sameValue(dep.value, value)) {
      dep.value = value;
      dep.v = ++this.counter;
    }
    dep.state = state;
    dep.stateV = dep.v;
    return dep.v;
  }

  /**
   * One run over `state`: `file(key, make)` gives `make`'s content for the tracked state, or the content an earlier
   * run made under the same key when everything it read is the same. `finish()` forgets files this run did not make
   * or reuse, of its own kind: keys ending in `#dev` or `#clean` belong to one kind of run, every other key to both.
   */
  run(state: ProjectState, instrument: boolean) {
    const rec: Recorder = { deps: null, views: new Map() };
    const tracked = view(state, [], SHAPE, rec);
    const used = new Set<string>();
    this.made = [];
    deriving.set(tracked, <T>(name: string, compute: (state: ProjectState) => T): T => {
      const n = '@' + JSON.stringify([name]);
      rec.deps?.add(n);
      const dep = this.dep(n);
      dep.compute ??= compute;
      this.version(state, dep);
      return dep.value as T;
    });
    const file = (key: string, make: (state: ProjectState) => string): string => {
      used.add(key);
      try {
        const hit = this.entries.get(key);
        if (hit && hit.deps.every(([dep, v]) => this.version(state, dep) === v)) return hit.content;
        this.entries.delete(key);
        rec.deps = new Set();
        const content = make(tracked);
        const names = rec.deps;
        rec.deps = null;
        this.entries.set(key, { content, deps: [...names].map((name) => [this.dep(name), this.version(state, this.dep(name))]) });
        this.made.push(key);
        return content;
      } catch (e) {
        // A failed run is never finished: forget everything rather than keep what it made from a state no one holds.
        rec.deps = null;
        this.clear();
        throw e;
      }
    };
    const finish = () => {
      const other = instrument ? '#clean' : '#dev';
      for (const key of this.entries.keys()) if (!used.has(key) && !key.endsWith(other)) this.entries.delete(key);
      const live = new Set<Dep>();
      for (const e of this.entries.values()) for (const [dep] of e.deps) live.add(dep);
      for (const [name, dep] of this.deps) if (!live.has(dep)) this.deps.delete(name);
    };
    return { file, finish };
  }

  clear() {
    this.entries.clear();
    this.deps.clear();
    this.made = [];
  }
}
