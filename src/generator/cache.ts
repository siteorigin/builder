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
 * differently from a missing one. The reads a file made of one object (a page, a node, an entry) are checked together:
 * while that object is the very one they were last found the same in, and it is frozen through (as the session holds
 * every state, src/engine/draft.ts), nothing it holds can have changed, so none of them is looked up again.
 *
 * A derived value (`derived`) is recorded the same way: worked out from a view of its own, it stands for a new state
 * while everything it read is the same, and is worked out again only when something it read changed. One declared
 * opaque, which reads too much of the project for its reads to be worth recording, is worked out from the plain state
 * for every new state.
 */
import type { ProjectState } from '@shared/types';
import { sameValue } from '@shared/same';
import { isFrozenThrough } from '@engine/draft';
import { packsGeneration } from '@catalogue/index';

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
  /** For a derived value: how it is worked out, and whether from the plain state every new state (see derived). */
  compute?: (state: ProjectState) => unknown;
  opaque?: boolean;
  /** For a derived value that is not opaque: what it read when last worked out. While all of it is the same, so is it. */
  reads?: Group[];
  /** The last value seen for it, and the version number that value was given. */
  value?: unknown;
  v?: number;
  /**
   * The state its version was last worked out for (by its number, idOf, so a read skipped since keeps no old state
   * alive): a state never changes while it is generated from.
   */
  state?: number;
  stateV?: number;
  /** The object it is read from (the object itself for its keys); null for a derived value. */
  holder: Holder | null;
}

/** An object at a path of the state, as a state holds it: looked up through its parent, once a state. */
interface Holder {
  parent: Holder | null;
  key: string;
  /**
   * The state it was last looked up in (by its number), what that state holds there (ABSENT for nothing), and that
   * object's number when it is frozen through (so a group can tell it again without holding on to it).
   */
  state?: number;
  at?: unknown;
  atId?: number;
}

/** What a file read of one holder, with the version each had then. */
interface Group {
  holder: Holder | null;
  /** The number of the holder these reads were last found the same in, when it is frozen through: while it is that object, they are. */
  seen?: number;
  deps: Array<[Dep, number]>;
}

interface Entry {
  content: string;
  /** Each thing the file read, by the object it read it of, derived values last. */
  groups: Group[];
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
  /** Set when a derived value read through it failed to be worked out, whether or not what read it went on. */
  failed?: boolean;
}

/** A number for each state, so the cache can tell states apart without holding on to them. */
const stateIds = new WeakMap<object, number>();
let lastStateId = 0;
function idOf(state: object): number {
  let id = stateIds.get(state);
  if (id === undefined) stateIds.set(state, (id = ++lastStateId));
  return id;
}

type Deriver = <T>(name: string, compute: (state: ProjectState) => T, opaque: boolean) => T;
/** The tracked state of each run in progress, and of each derived value being worked out, with how it reads a derived value. */
const deriving = new WeakMap<object, Deriver>();
/** Every view handed out: one never belongs in a derived value, which outlives the view it was worked out from. */
const views = new WeakSet<object>();

/**
 * A value worked out from the project (`compute` must read nothing but the state it is given, and `name` always name
 * the same `compute`). In a cached run, a file that reads it depends on its result alone, not on everything that went
 * into it, worked out once per state at most: from a view that records what it reads, so it is worked out again only
 * when something it read changed, or with `opaque` from the plain state for every new state (for a value that reads
 * too much of the project for that to pay, or is one of hundreds that each read much of it). A value read from the
 * state it is given is a view of it there: it is not handed back in the result. Outside a cached run it is simply
 * `compute(state)`.
 */
export function derived<T>(state: ProjectState, name: string, compute: (state: ProjectState) => T, opts: { opaque?: boolean } = {}): T {
  const read = deriving.get(state);
  return read ? read(name, compute, !!opts.opaque) : compute(state);
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
  // Each name is made once a view: a walk reads the same few fields of an object many times over (a sort, say).
  const names: Partial<Record<Kind, Map<string, string>>> = {};
  const note = (kind: Kind, key: string) => {
    if (!rec.deps) return;
    const made = (names[kind] ??= new Map());
    let name = made.get(key);
    if (name === undefined) made.set(key, (name = kind + head + JSON.stringify(key) + ']'));
    rec.deps.add(name);
  };
  // A frozen object (as the session holds every state, src/engine/draft.ts) is read through a stand-in of its own: a
  // proxy of the object itself would have to give each of its fixed fields back as it is, read whole.
  const standIn = Object.isFrozen(target);
  /** The shape of an own object field handed out as a view; none for a field that must be handed out as it is. */
  const nested = (key: string): Shape | undefined => {
    const sub = childShape(shape, key);
    if (!sub) return undefined;
    const d = Reflect.getOwnPropertyDescriptor(target, key);
    // A proxy must give a fixed field's own value back, so one that can never change is read whole.
    return d && 'value' in d && isObject(d.value) && (standIn || d.configurable || d.writable) ? sub : undefined;
  };
  /** Each key's view, once made, or null for a key whose value is handed out as it is (a state never changes while it is read). */
  const children = new Map<string, object | null>();
  const child = (key: string): object | null => {
    let c = children.get(key);
    if (c === undefined) {
      const sub = nested(key);
      children.set(key, (c = sub ? view(Reflect.get(target, key) as object, [...path, key], sub, rec) : null));
    }
    return c;
  };
  // Each trap reads the object itself, whatever the proxy stands on.
  const handler: ProxyHandler<T> = {
    get(_, key) {
      if (typeof key !== 'string') return Reflect.get(target, key);
      const c = child(key);
      if (!c) {
        note('=', key);
        return Reflect.get(target, key);
      }
      note('?', key);
      return c;
    },
    has(_, key) {
      if (typeof key === 'string') note('h', key);
      return Reflect.has(target, key);
    },
    getOwnPropertyDescriptor(_, key) {
      const d = Reflect.getOwnPropertyDescriptor(target, key);
      if (typeof key !== 'string') return standIn ? held(d, key) : d;
      note('#', key);
      // A descriptor carries the value, so an entry read this way is handed out as a view as well.
      const c = standIn || d?.configurable ? child(key) : null;
      if (!c) {
        note('=', key);
        return standIn ? held(d, key) : d;
      }
      note('?', key);
      return held({ ...d, value: c }, key);
    },
    ownKeys() {
      rec.deps?.add('*' + JSON.stringify(path));
      return Reflect.ownKeys(target);
    },
    set: refuse,
    defineProperty: refuse,
    deleteProperty: refuse,
    setPrototypeOf: refuse,
    preventExtensions: refuse
  };
  /** A frozen object's field as its stand-in can say it is: configurable (its stand-in has no such field), but an array's length as the stand-in's own. */
  const held = (d: PropertyDescriptor | undefined, key: string | symbol): PropertyDescriptor | undefined => {
    if (!d || !standIn) return d;
    return Array.isArray(target) && key === 'length' ? { value: d.value, writable: true, enumerable: false, configurable: false } : { ...d, configurable: true };
  };
  const proxy = new Proxy(standIn ? ((Array.isArray(target) ? [] : Object.create(Object.getPrototypeOf(target))) as T) : target, handler);
  rec.views.set(head, proxy);
  views.add(proxy);
  return proxy;
}

/** Whether `value` holds a view anywhere (a part of the state frozen through holds none). */
function holdsView(value: unknown, seen = new Set<object>()): boolean {
  if (!isObject(value) || seen.has(value) || isFrozenThrough(value)) return false;
  if (views.has(value)) return true;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const d = Reflect.getOwnPropertyDescriptor(value, key);
    // A getter may read the view it was made with whenever it is called.
    if (d && (!('value' in d) || holdsView(d.value, seen))) return true;
  }
  if (value instanceof Map) for (const [k, v] of value) if (holdsView(k, seen) || holdsView(v, seen)) return true;
  if (value instanceof Set) for (const v of value) if (holdsView(v, seen)) return true;
  return false;
}

/** What `dep` reads in `state`, in the form it is compared in. */
function current(state: ProjectState, dep: Dep): unknown {
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
  /** Every object such a thing is read from, by the JSON of its path. */
  private holders = new Map<string, Holder>();
  private counter = 0;
  /** The theme packs' generation everything cached was made under. */
  private packs = -1;
  /** Keys of the files the last run had to make, for tests and timing. */
  made: string[] = [];
  /**
   * With `timing` on (only while timing marks are, src/main/perf.ts), how long the last run spent checking whether each
   * file's dependencies are unchanged, in ms, how many files it checked, how many things read it looked up in its
   * state (`looked`, each once a state) and how many of those were derived values it worked out (`derived`). Off,
   * nothing is timed or counted.
   */
  timing = false;
  checkMs = 0;
  checked = 0;
  looked = 0;
  derived = 0;

  private dep(name: string): Dep {
    let d = this.deps.get(name);
    if (!d) {
      const kind = name[0] as Kind;
      const path = JSON.parse(name.slice(1)) as string[];
      this.deps.set(name, (d = { kind, path, holder: kind === '@' ? null : this.holder(kind === '*' ? path : path.slice(0, -1)) }));
    }
    return d;
  }

  private holder(path: string[]): Holder {
    const name = JSON.stringify(path);
    let h = this.holders.get(name);
    if (!h) this.holders.set(name, (h = { parent: path.length ? this.holder(path.slice(0, -1)) : null, key: path[path.length - 1] ?? '' }));
    return h;
  }

  /** What `state` holds at `h`'s path: the state itself at the root, ABSENT where a step is missing. */
  private at(state: ProjectState, h: Holder): unknown {
    const id = this.id(state);
    if (h.state !== id) {
      const parent = h.parent && this.at(state, h.parent);
      h.at = !h.parent ? state : isObject(parent) && Object.hasOwn(parent, h.key) ? (parent as Record<string, unknown>)[h.key] : ABSENT;
      h.atId = isObject(h.at) && isFrozenThrough(h.at) ? idOf(h.at) : undefined;
      h.state = id;
    }
    return h.at;
  }

  /** The state last asked about, and its number: a run asks about one state many times over. */
  private last?: { state: ProjectState; id: number };
  private id(state: ProjectState): number {
    if (this.last?.state !== state) this.last = { state, id: idOf(state) };
    return this.last.id;
  }

  /** The things `names` stand for, by holder, each with its version in `state`, and each holder as `state` holds it. */
  private groups(state: ProjectState, names: Iterable<string>): Group[] {
    const by = new Map<Holder | null, Group>();
    for (const name of names) {
      const dep = this.dep(name);
      let g = by.get(dep.holder);
      if (!g) by.set(dep.holder, (g = { holder: dep.holder, deps: [] }));
      g.deps.push([dep, this.version(state, dep)]);
    }
    const groups = [...by.values()];
    for (const g of groups) {
      if (!g.holder) continue;
      this.at(state, g.holder);
      g.seen = g.holder.atId;
    }
    // A derived value can cost a walk of the project: looked at once everything else is known to be the same.
    return [...groups.filter((g) => g.holder), ...groups.filter((g) => !g.holder)];
  }

  /**
   * Whether everything derived value `dep` read when last worked out is the same in `state`. One a derived value read
   * that can no longer be worked out is a change: the value is worked out again, and does with that what it does.
   */
  private stands(state: ProjectState, dep: Dep): boolean {
    if (!dep.reads) return false;
    try {
      return dep.reads.every((g) => this.holds(state, g));
    } catch {
      return false;
    }
  }

  /** Whether everything `g` read is the same in `state` as when it was read. */
  private holds(state: ProjectState, g: Group): boolean {
    if (g.holder) {
      this.at(state, g.holder);
      if (g.seen !== undefined && g.holder.atId === g.seen) return true;
    }
    for (const [dep, v] of g.deps) if (this.version(state, dep) !== v) return false;
    if (g.holder) g.seen = g.holder.atId;
    return true;
  }

  private version(state: ProjectState, dep: Dep): number {
    const id = this.id(state);
    if (dep.state === id) return dep.stateV!;
    if (this.timing) this.looked++;
    if (dep.kind === '@' && dep.v !== undefined && this.stands(state, dep)) {
      dep.state = id;
      dep.stateV = dep.v;
      return dep.v;
    }
    const worked = dep.kind === '@' ? this.workOut(state, dep) : undefined;
    const value = worked ? worked.value : current(state, dep);
    // A version number only ever stands for one value, so equal numbers mean the same value.
    if (dep.v === undefined || !sameValue(dep.value, value)) {
      dep.value = value;
      dep.v = ++this.counter;
    }
    dep.state = id;
    dep.stateV = dep.v;
    // What a derived value read stands for it only once it has its value and version.
    if (worked) dep.reads = worked.reads;
    return dep.v;
  }

  /** How a view over `state` reads a derived value: once a state, recorded by `rec` as read. */
  private deriver(state: ProjectState, rec: Recorder): Deriver {
    return <T>(name: string, compute: (state: ProjectState) => T, opaque: boolean): T => {
      const n = '@' + JSON.stringify([name]);
      rec.deps?.add(n);
      const dep = this.dep(n);
      dep.compute ??= compute;
      dep.opaque ??= opaque;
      try {
        this.version(state, dep);
      } catch (e) {
        rec.failed = true;
        throw e;
      }
      return dep.value as T;
    };
  }

  /**
   * A derived value worked out for `state`: from a view of its own that records what it reads (a view of its own, so
   * nothing another derived value worked out from a view, and kept, can stand in for a read), or from the plain state.
   */
  private workOut(state: ProjectState, dep: Dep): { value: unknown; reads?: Group[] } {
    if (this.timing) this.derived++;
    dep.reads = undefined;
    if (!dep.opaque) {
      const rec: Recorder = { deps: new Set(), views: new Map() };
      const root = view(state, [], SHAPE, rec);
      deriving.set(root, this.deriver(state, rec));
      const value = dep.compute!(root);
      const names = rec.deps!;
      rec.deps = null;
      if (!rec.failed && !holdsView(value)) {
        Object.freeze(value);
        return { value, reads: this.groups(state, names) };
      }
      // A value that hands back what it read would be read again by whoever is given it, and one that went on past a
      // derived value it could not work out cannot be told apart from it: from the plain state, always, as before.
      dep.opaque = true;
    }
    return { value: Object.freeze(dep.compute!(state)) };
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
    this.checkMs = 0;
    this.checked = 0;
    this.looked = 0;
    this.derived = 0;
    // Files and derived values read what the theme packs hold as well as the state: all made again once they are replaced.
    const packs = packsGeneration();
    if (packs !== this.packs) {
      this.clear();
      this.packs = packs;
    }
    deriving.set(tracked, this.deriver(state, rec));
    const file = (key: string, make: (state: ProjectState) => string): string => {
      used.add(key);
      try {
        const hit = this.entries.get(key);
        if (hit) {
          const started = this.timing ? performance.now() : 0;
          const same = hit.groups.every((g) => this.holds(state, g));
          if (this.timing) {
            this.checkMs += performance.now() - started;
            this.checked++;
          }
          if (same) return hit.content;
        }
        this.entries.delete(key);
        rec.deps = new Set();
        const content = make(tracked);
        const names = rec.deps;
        rec.deps = null;
        this.entries.set(key, { content, groups: this.groups(state, names) });
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
      // What a file read, and what each derived value it read read in turn.
      const live = new Set<Dep>();
      const keep = (dep: Dep) => {
        if (live.has(dep)) return;
        live.add(dep);
        for (const g of dep.reads ?? []) for (const [d] of g.deps) keep(d);
      };
      for (const e of this.entries.values()) for (const g of e.groups) for (const [dep] of g.deps) keep(dep);
      for (const [name, dep] of this.deps) if (!live.has(dep)) this.deps.delete(name);
      const held = new Set<Holder>();
      for (const dep of live) for (let h = dep.holder; h && !held.has(h); h = h.parent) held.add(h);
      for (const [name, h] of this.holders) if (!held.has(h)) this.holders.delete(name);
    };
    return { file, finish };
  }

  /**
   * The derived value named `name` (see derived) a run worked out for this very state, as a file it gave back read it;
   * undefined when no run since has (a state never changes, so the value still stands for it).
   */
  derivedFor<T>(state: ProjectState, name: string): T | undefined {
    const dep = this.deps.get('@' + JSON.stringify([name]));
    return dep && this.packs === packsGeneration() && dep.state === stateIds.get(state) ? (dep.value as T) : undefined;
  }

  clear() {
    this.entries.clear();
    this.deps.clear();
    this.holders.clear();
    this.last = undefined;
    this.made = [];
  }
}
