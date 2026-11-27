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

/** Every field is set when it is made (newDep(), child(), intern()), so none is added later outside the object itself. */
interface Dep {
  /** Its number, for telling groups of the same reads apart (intern). */
  id: number;
  kind: Kind;
  /** The key it reads of its holder; for a derived value, its name; nothing for the keys themselves (`*`). */
  key: string;
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
  id: number;
  parent: Holder | null;
  key: string;
  /** The holder of each of its keys read through a view of its own. */
  children: Map<string, Holder> | undefined;
  /** Each thing read of it, by kind and key, and the reading of its keys. */
  reads: Partial<Record<Exclude<Kind, '*' | '@'>, Map<string, Dep>>> | undefined;
  keys: Dep | undefined;
  /**
   * The state it was last looked up in (by its number), what that state holds there (ABSENT for nothing), and that
   * object's number when it is frozen through (so a group can tell it again without holding on to it).
   */
  state?: number;
  at?: unknown;
  atId?: number;
}

/**
 * What a file read of one holder, and the newest version any of it had then. Every version is a new number from one
 * counter, and a thing read keeps its number while its value is the same, so its reads are all the same while none
 * has a number past `max`: one that changed since has a number newer than every number there was then. The same
 * reads with the same `max` are therefore the same reads at the same versions, and are one group, whichever files and
 * derived values made them (intern): hundreds of posts read the same fields of the site. Nothing in a group changes
 * once it is made but `seen`, which says no more than its reads do.
 */
interface Group {
  holder: Holder | null;
  /** The number of the holder these reads were last found the same in, when it is frozen through: while it is that object, they are. */
  seen: number | undefined;
  deps: Dep[];
  max: number;
  /** What intern() files it under: worked out from the holder, the reads and `max`. */
  hash: number;
}

interface Entry {
  content: string;
  /** Each thing the file read, by the object it read it of, derived values last. */
  groups: Group[];
}

/** MurmurHash3's step and finish, for 32-bit numbers. */
function mix(hash: number, n: number): number {
  let k = Math.imul(n, 0xcc9e2d51);
  k = Math.imul((k << 15) | (k >>> 17), 0x1b873593);
  hash ^= k;
  hash = (hash << 13) | (hash >>> 19);
  return (Math.imul(hash, 5) + 0xe6546b64) | 0;
}
function settle(hash: number): number {
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) | 0;
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
  deps: Set<Dep> | null;
  /** One view per path, so an entry read twice is the same object both times. */
  views: Map<Holder, object>;
  /** The cache's holder of a key of a holder, and its thing read of a holder by kind and key. */
  child: (holder: Holder, key: string) => Holder;
  read: (holder: Holder, kind: Kind, key: string) => Dep;
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
 * `compute(state)`. The cache keeps `compute` for as long as a file reads the value, and with it everything it can
 * reach: a function of its own, or one that holds only names and IDs, never one made beside a closure over the state
 * a generator was given (V8 keeps a scope's variables for every function made in it), which would keep that state.
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

/** A read-only view of `target`, found at `holder`'s path in the state, that records each read. */
function view<T extends object>(target: T, holder: Holder, shape: Shape, rec: Recorder): T {
  const known = rec.views.get(holder);
  if (known) return known as T;
  const note = (kind: Kind, key: string) => {
    if (rec.deps) rec.deps.add(rec.read(holder, kind, key));
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
      children.set(key, (c = sub ? view(Reflect.get(target, key) as object, rec.child(holder, key), sub, rec) : null));
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
      note('*', '');
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
  rec.views.set(holder, proxy);
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

/** What `dep` reads of `at`, the object its holder is in a state (ABSENT for none), in the form it is compared in. */
function current(at: unknown, dep: Dep): unknown {
  if (!isObject(at)) return ABSENT;
  if (dep.kind === '*') return Reflect.ownKeys(at);
  const key = dep.key;
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
  /**
   * The state itself, as the holder every other is found under by its keys: each thing read by a file still cached is
   * filed under the holder it is read of, by kind and key (each derived value by its name).
   */
  private top: Holder | undefined;
  private derivations = new Map<string, Dep>();
  /** Every group a cached file or derived value holds, by its hash: one of each. */
  private interned = new Map<number, Group | Group[]>();
  private counter = 0;
  /** The last number given to a thing read and to a holder. */
  private lastDep = 0;
  private lastHolder = 0;
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

  private newDep(kind: Kind, key: string, holder: Holder | null): Dep {
    return { id: ++this.lastDep, kind, key, compute: undefined, opaque: undefined, reads: undefined, value: undefined, v: undefined, state: undefined, stateV: undefined, holder };
  }

  private newHolder(parent: Holder | null, key: string): Holder {
    return { id: ++this.lastHolder, parent, key, children: undefined, reads: undefined, keys: undefined, state: undefined, at: undefined, atId: undefined };
  }

  /** The holder of the state itself. */
  private root(): Holder {
    return (this.top ??= this.newHolder(null, ''));
  }

  private child(h: Holder, key: string): Holder {
    let c = h.children?.get(key);
    if (!c) (h.children ??= new Map()).set(key, (c = this.newHolder(h, key)));
    return c;
  }

  /** What is read of `h` as `kind` at `key`: one thing for each, while a file still cached reads it. */
  private read(h: Holder, kind: Kind, key: string): Dep {
    if (kind === '*') return (h.keys ??= this.newDep('*', '', h));
    const by = ((h.reads ??= {})[kind as Exclude<Kind, '*' | '@'>] ??= new Map());
    let d = by.get(key);
    if (!d) by.set(key, (d = this.newDep(kind, key, h)));
    return d;
  }

  private recorder(deps: Set<Dep> | null): Recorder {
    return { deps, views: new Map(), child: (h, key) => this.child(h, key), read: (h, kind, key) => this.read(h, kind, key) };
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

  /** The things read, by holder, each with its version in `state`, and each holder as `state` holds it. */
  private groups(state: ProjectState, read: Iterable<Dep>): Group[] {
    const by = new Map<Holder | null, { deps: Dep[]; max: number }>();
    for (const dep of read) {
      let g = by.get(dep.holder);
      if (!g) by.set(dep.holder, (g = { deps: [], max: 0 }));
      g.deps.push(dep);
      g.max = Math.max(g.max, this.version(state, dep));
    }
    const groups: Group[] = [];
    for (const [holder, { deps, max }] of by) {
      if (holder) this.at(state, holder);
      groups.push(this.intern(holder, deps, max, holder?.atId));
    }
    // A derived value can cost a walk of the project: looked at once everything else is known to be the same.
    return [...groups.filter((g) => g.holder), ...groups.filter((g) => !g.holder)];
  }

  /**
   * The group of these reads at these versions: the one already held when there is one (its reads were just found the
   * same in the state `seen` is of, so it is seen there too), else a new one.
   */
  private intern(holder: Holder | null, deps: Dep[], max: number, seen: number | undefined): Group {
    // Each number mixed in on its own: IDs and versions rise together, and a plain combination of them cancels out.
    let hash = mix(mix(deps.length, holder ? holder.id : 0), max);
    for (const dep of deps) hash = mix(hash, dep.id);
    hash = settle(hash);
    const filed = this.interned.get(hash);
    for (const g of filed === undefined ? [] : Array.isArray(filed) ? filed : [filed]) {
      if (g.holder !== holder || g.max !== max || g.deps.length !== deps.length) continue;
      let same = true;
      for (let i = 0; same && i < deps.length; i++) same = g.deps[i] === deps[i];
      if (!same) continue;
      g.seen = seen;
      return g;
    }
    // Copied to its length: an array grown one push at a time keeps room for more.
    const g: Group = { holder, seen, deps: deps.slice(), max, hash };
    this.file(g);
    return g;
  }

  /** File a group not filed yet. */
  private file(g: Group) {
    const filed = this.interned.get(g.hash);
    if (filed === undefined) this.interned.set(g.hash, g);
    else if (Array.isArray(filed)) filed.push(g);
    else this.interned.set(g.hash, [filed, g]);
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
    for (const dep of g.deps) if (this.version(state, dep) > g.max) return false;
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
    const value = worked ? worked.value : current(this.at(state, dep.holder!), dep);
    // A version number only ever stands for one value, so equal numbers mean the same value. The value is the one
    // just seen either way, so an equal one from an earlier state does not keep that state's objects.
    if (dep.v === undefined || !sameValue(dep.value, value)) dep.v = ++this.counter;
    dep.value = value;
    dep.state = id;
    dep.stateV = dep.v;
    // What a derived value read stands for it only once it has its value and version.
    if (worked) dep.reads = worked.reads;
    return dep.v;
  }

  /** How a view over `state` reads a derived value: once a state, recorded by `rec` as read. */
  private deriver(state: ProjectState, rec: Recorder): Deriver {
    return <T>(name: string, compute: (state: ProjectState) => T, opaque: boolean): T => {
      let dep = this.derivations.get(name);
      if (!dep) this.derivations.set(name, (dep = this.newDep('@', name, null)));
      rec.deps?.add(dep);
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
      const rec = this.recorder(new Set());
      const root = view(state, this.root(), SHAPE, rec);
      deriving.set(root, this.deriver(state, rec));
      let value: unknown;
      try {
        value = dep.compute!(root);
      } finally {
        // Its view is read through the deriver only while it is worked out.
        deriving.delete(root);
      }
      const read = rec.deps!;
      rec.deps = null;
      if (!rec.failed && !holdsView(value)) {
        Object.freeze(value);
        return { value, reads: this.groups(state, read) };
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
    // Files and derived values read what the theme packs hold as well as the state: all made again once they are replaced.
    const packs = packsGeneration();
    if (packs !== this.packs) {
      this.clear();
      this.packs = packs;
    }
    const rec = this.recorder(null);
    const tracked = view(state, this.root(), SHAPE, rec);
    const used = new Set<string>();
    this.made = [];
    this.checkMs = 0;
    this.checked = 0;
    this.looked = 0;
    this.derived = 0;
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
        const read = rec.deps;
        rec.deps = null;
        this.entries.set(key, { content, groups: this.groups(state, read) });
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
      // Only the groups still held stay filed, each looked at once however many files share it.
      this.interned.clear();
      const filed = new Set<Group>();
      const keepGroup = (g: Group) => {
        if (filed.has(g)) return;
        filed.add(g);
        this.file(g);
        for (const dep of g.deps) keep(dep);
      };
      const keep = (dep: Dep) => {
        if (live.has(dep)) return;
        live.add(dep);
        for (const g of dep.reads ?? []) keepGroup(g);
      };
      for (const e of this.entries.values()) for (const g of e.groups) keepGroup(g);
      for (const [name, dep] of this.derivations) if (!live.has(dep)) this.derivations.delete(name);
      // Each holder keeps what is still read of it and the holders under it that do; one that keeps nothing goes. And
      // nothing of the state stays between runs: each holder is looked up again in the next state (by its number, it
      // can still tell the object it last found).
      const prune = (h: Holder): boolean => {
        h.state = undefined;
        h.at = undefined;
        if (h.keys && !live.has(h.keys)) h.keys = undefined;
        let kept = !!h.keys;
        for (const by of Object.values(h.reads ?? {})) {
          for (const [key, dep] of by) if (!live.has(dep)) by.delete(key);
          kept ||= by.size > 0;
        }
        for (const [key, c] of h.children ?? []) if (!prune(c)) h.children!.delete(key);
        return kept || !!h.children?.size;
      };
      if (this.top) prune(this.top);
      this.last = undefined;
      deriving.delete(tracked);
    };
    return { file, finish };
  }

  /**
   * The derived value named `name` (see derived) a run worked out for this very state, as a file it gave back read it;
   * undefined when no run since has (a state never changes, so the value still stands for it).
   */
  derivedFor<T>(state: ProjectState, name: string): T | undefined {
    const dep = this.derivations.get(name);
    return dep && this.packs === packsGeneration() && dep.state === stateIds.get(state) ? (dep.value as T) : undefined;
  }

  clear() {
    this.entries.clear();
    this.top = undefined;
    this.derivations.clear();
    this.interned.clear();
    this.last = undefined;
    this.made = [];
  }
}
