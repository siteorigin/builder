/**
 * A batch's working copy of a project state, copied document by document as the batch reaches them.
 *
 * `draftOf(state)` looks like a whole copy of `state`: every key is there, in the same order, and anything read from
 * it is a copy that may be changed freely. But a document (a page, a component, a collection's settings or an entry,
 * a source, or one of the project's other documents) is copied only the first time it is read, so a batch that
 * reaches one page copies one page. `finished(draft)` then gives the state the batch leaves: a new plain object holding
 * every document the batch never read as the very object `state` holds, and one it read but left as it was as well.
 * `state` itself is never changed.
 *
 * Each key of a draft's object is an accessor until it is first read or written, then an ordinary property, so the
 * draft is read and written as a plain object is (keys, `in`, `delete`, spreading, copying, serializing). What it
 * cannot do is tell its descriptors apart from a plain object's: nothing that compares descriptors is handed a draft.
 */
import type { ProjectState } from '@shared/types';
import { sameValue } from '@shared/same';

/** Where a state is copied by its parts: under a key listed here (`*` for any key) the value is a map of documents. */
interface Shape {
  [key: string]: Shape | null;
}
/** A document: copied whole. */
const DOC = null;
const STATE: Shape = { pages: { '*': DOC }, components: { '*': DOC }, sources: { '*': DOC }, collections: { '*': { settings: DOC, entries: { '*': DOC } } } };

interface Lazy {
  /** The object of the state this stands for. */
  from: Record<string, unknown>;
  shape: Shape;
}
/** Every object of a draft that stands for one of the state's, with what it stands for. */
const lazy = new WeakMap<object, Lazy>();

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const child = (shape: Shape, key: string): Shape | null | undefined => (Object.hasOwn(shape, key) ? shape[key] : Object.hasOwn(shape, '*') ? shape['*'] : undefined);

function draftObject(from: Record<string, unknown>, shape: Shape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  lazy.set(out, { from, shape });
  const settle = (key: string, value: unknown) => Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
  for (const key of Object.keys(from)) {
    const sub = child(shape, key);
    Object.defineProperty(out, key, {
      enumerable: true,
      configurable: true,
      get() {
        const v = from[key];
        const made = sub && plainObject(v) ? draftObject(v, sub) : structuredClone(v);
        settle(key, made);
        return made;
      },
      set(value: unknown) {
        settle(key, value);
      }
    });
  }
  return out;
}

/** Every object `frozen` has frozen through and through. */
const frozenThrough = new WeakSet<object>();

/**
 * `state` frozen through and through, so nothing can change it in place. A part this froze before is not looked at
 * again, so freezing a state that shares most of its documents with one frozen before costs what it does not share; a
 * part frozen some other way is looked through, since what it holds may not be.
 */
export function frozen<T>(state: T): T {
  if (state && typeof state === 'object' && !frozenThrough.has(state) && !ArrayBuffer.isView(state)) {
    frozenThrough.add(state);
    Object.freeze(state);
    for (const key of Object.keys(state)) frozen((state as Record<string, unknown>)[key]);
  }
  return state;
}

/** Whether `frozen` froze `value` through and through: nothing in it can ever change. */
export function isFrozenThrough(value: object): boolean {
  return frozenThrough.has(value);
}

/** How many drafts have been made: how many times a batch was applied to a copy of a project, for tests. */
export const drafts = { made: 0 };

/** A working copy of `state` for a batch to change: see the module's comment. */
export function draftOf(state: ProjectState): ProjectState {
  drafts.made++;
  return draftObject(state as unknown as Record<string, unknown>, STATE) as unknown as ProjectState;
}

/** Whether `value` is part of a draft that still stands for the state's object (it may have been read from since). */
export function isDraft(value: unknown): boolean {
  return !!value && typeof value === 'object' && lazy.has(value);
}

/**
 * `container[key]` without copying it: the state's own object while the draft has not read it yet, otherwise what the
 * draft holds. What it gives must only be read.
 */
export function peek<T>(container: Record<string, T>, key: string): T {
  const at = lazy.get(container);
  if (at) {
    const d = Object.getOwnPropertyDescriptor(container, key);
    if (d?.get) return at.from[key] as T;
  }
  return container[key];
}

const put = (o: Record<string, unknown>, key: string, value: unknown) => Object.defineProperty(o, key, { value, writable: true, enumerable: true, configurable: true });

/**
 * What `value`, a draft's object or something put in one, leaves as plain objects: the state's own object `from` when
 * nothing in it changed. `shape` says how `from` is made of documents; a map put in place of the draft's (spread from
 * it, say) has the documents that are as they were given back as the state's own as well.
 */
function finish(value: unknown, from: unknown, shape: Shape | null | undefined): unknown {
  const at = lazy.get(value as object);
  if (at) {
    // One of the draft's own objects (wherever it was moved to): what it stands for, unless something in it changed.
    const out = value as Record<string, unknown>;
    const keys = Object.keys(out);
    const fromKeys = Object.keys(at.from);
    let same = keys.length === fromKeys.length;
    const result: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (same && fromKeys[i] !== key) same = false;
      const d = Object.getOwnPropertyDescriptor(out, key)!;
      const had = Object.hasOwn(at.from, key);
      const was = had ? at.from[key] : undefined;
      const v = d.get ? was : finish(d.value, was, child(at.shape, key));
      if (!had || v !== was) same = false;
      put(result, key, v);
    }
    return same ? at.from : result;
  }
  if (value === from) return value;
  // A document: the state's own while it is as it was.
  if (!shape) return from !== undefined && sameValue(value, from) ? from : value;
  // A map of documents put in place of the draft's own.
  if (!plainObject(value)) return value;
  const base = plainObject(from) ? from : {};
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) put(result, key, finish(value[key], Object.hasOwn(base, key) ? base[key] : undefined, child(shape, key)));
  return result;
}

/**
 * The state `draft` leaves, as plain objects: every document it never changed is the very object its state holds,
 * and so is every map of them in which nothing changed. The draft must not be used again.
 */
export function finished(draft: ProjectState): ProjectState {
  const from = lazy.get(draft)?.from;
  const done = finish(draft, from, STATE) as ProjectState;
  // Always a state of its own, even when the batch changed nothing.
  return (done as unknown) === from ? { ...done } : done;
}
