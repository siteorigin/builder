import type { ProjectSnapshot } from './api';

/**
 * What `project:changed` carries to this computer's editor (#967): the project as it changed since the copy the editor
 * was sent before, so a change costs what it changed, not the size of the project.
 *
 * The main process's state is frozen through and through, and a change shares every document it did not touch with the
 * state before it (src/main/project/session.ts), so a document that is the very object sent before is that document
 * unchanged: only the others are sent. The rest of the snapshot is worked out again for each message, and some of it is
 * changed in place (the conflicts list), so each of its other fields is sent when its text differs from the text it had
 * when it was last sent: a list by its items (a diagnostic gone, a History step added), naming those it keeps, and a
 * record by its members. A preview starting or an AI request going busy sends those few fields and no project content.
 *
 * The editor builds the new snapshot from the one it holds, keeping every object that did not change, so the documents
 * an edit did not touch keep their identity, and the state keeps its own when no document changed. It applies a patch
 * only to the copy the patch was made from (`base`); holding any other, it asks for the whole project again.
 */
export type ProjectChange = WholeProject | ProjectPatch;

export interface WholeProject {
  /** This message's number among those sent to the editor; the next patch names it as its base. */
  seq: number;
  base: null;
  revision: number;
  snapshot: ProjectSnapshot;
}

/** The snapshot's fields a patch sends whole when they change: all but the state, which is patched, and the revision. */
export type SnapshotFields = Omit<ProjectSnapshot, 'state' | 'revision'>;

export interface ProjectPatch {
  seq: number;
  /** The `seq` of the copy this patch applies to. */
  base: number;
  revision: number;
  /** The snapshot's fields that changed, each whole. */
  fields?: Partial<SnapshotFields>;
  /** The snapshot's fields that changed in part: a list or a record most of which is as it was. */
  parts?: Record<string, PartPatch>;
  /** Fields the snapshot no longer has. */
  dropped?: string[];
  /** The state's changes, when any of its documents changed. */
  state?: ObjectPatch;
}

/** How one object changed: the keys whose value is new, those whose object changed in part, and its keys' order. */
export interface ObjectPatch {
  /** Keys whose value is new, each sent whole. */
  set?: Record<string, unknown>;
  /** Keys whose object changed in part. */
  sub?: Record<string, ObjectPatch>;
  /** The object's keys in order, sent only when they are not the copy's (a key added, removed or moved). */
  keys?: string[];
}

/** How a list or a record among the snapshot's other fields changed, matched by the text of its items and members. */
export type PartPatch =
  /** Each item of the list: the index of the copy's item it is, or -1 for the next of `add`. */
  | { list: number[]; add?: unknown[] }
  | { members: { set?: Record<string, unknown>; parts?: Record<string, PartPatch>; keys?: string[] } };

/**
 * Where a patch goes below an object: a child named here (or by `*`) is patched in part, any other is sent whole. The
 * state's records of documents are patched a document at a time, and each collection's entries an entry at a time.
 */
interface Shape {
  readonly [key: string]: Shape;
}
const DOCS: Shape = {};
const STATE: Shape = { pages: DOCS, components: DOCS, sources: DOCS, collections: { '*': { entries: DOCS } } };

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const childShape = (shape: Shape, k: string): Shape | undefined => (own(shape, k) ? shape[k] : own(shape, '*') ? shape['*'] : undefined);
/** An own property, whatever its name (`__proto__` included). */
function put(o: Record<string, unknown>, k: string, v: unknown) {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
}

/** How `next` differs from `prev`, by identity, or undefined when nothing in it does. */
function diff(prev: Record<string, unknown>, next: Record<string, unknown>, shape: Shape): ObjectPatch | undefined {
  if (prev === next) return undefined;
  const before = Object.keys(prev);
  const after = Object.keys(next);
  let set: Record<string, unknown> | undefined;
  let sub: Record<string, ObjectPatch> | undefined;
  for (const k of after) {
    const had = own(prev, k);
    const b = had ? prev[k] : undefined;
    const a = next[k];
    if (had && b === a) continue;
    const child = had ? childShape(shape, k) : undefined;
    if (child && isRecord(b) && isRecord(a)) {
      const p = diff(b, a, child);
      if (p) put((sub ??= {}), k, p);
    } else put((set ??= {}), k, a);
  }
  // The keys' order is the copy's when they are the same keys in the same order; otherwise it is sent whole.
  const keys = before.length === after.length && before.every((k, i) => k === after[i]) ? undefined : after;
  if (!set && !sub && !keys) return undefined;
  return { ...(set ? { set } : {}), ...(sub ? { sub } : {}), ...(keys ? { keys } : {}) };
}

/** `prev` with `patch` applied: a new object in the patch's key order, every value the patch does not name kept. */
function apply(prev: Record<string, unknown>, patch: ObjectPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of patch.keys ?? Object.keys(prev)) {
    if (patch.set && own(patch.set, k)) put(out, k, patch.set[k]);
    else if (patch.sub && own(patch.sub, k)) {
      const b = own(prev, k) ? prev[k] : undefined;
      if (!isRecord(b)) throw new Error(`The project's change does not fit the copy held: ${k} is not an object.`);
      put(out, k, apply(b, patch.sub[k]));
    } else if (own(prev, k)) put(out, k, prev[k]);
    else throw new Error(`The project's change does not fit the copy held: ${k} is missing.`);
  }
  return out;
}

const PATCHED = new Set(['state', 'revision']);
/** A field shorter than this as text is sent whole when it changes: a patch of it would save nothing worth having. */
const PART_MIN = 1024;

/**
 * A field's value as text that tells apart everything IPC carries of it: a property that is there but undefined, NaN,
 * the infinities and -0, which JSON would take for one another (as text starting with a NUL, which no other string is
 * left to start with).
 */
export function fieldText(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => {
    if (x === undefined) return '\u0000undefined';
    if (typeof x === 'number' && (!Number.isFinite(x) || Object.is(x, -0))) return `\u0000${Object.is(x, -0) ? '-0' : String(x)}`;
    if (typeof x === 'string' && x.startsWith('\u0000')) return `\u0000${x}`;
    return x;
  });
}

/** A field's text, with its items' texts when it is a list and its members' when it is a record (one level down). */
interface Texts {
  text: string;
  items?: string[];
  members?: Map<string, Texts>;
}
function textsOf(v: unknown, members: boolean): Texts {
  if (Array.isArray(v)) {
    const items = Array.from(v, (x: unknown) => fieldText(x));
    return { text: `[${items.join(',')}]`, items };
  }
  if (members && isRecord(v)) {
    const m = new Map(Object.keys(v).map((k) => [k, textsOf(v[k], false)] as const));
    return { text: `{${[...m].map(([k, t]) => `${JSON.stringify(k)}:${t.text}`).join(',')}}`, members: m };
  }
  return { text: fieldText(v) };
}

/** How `next` differs from the value `prev` describes, in part, or undefined when it is best sent whole. */
function diffPart(prev: Texts, next: Texts, value: unknown): PartPatch | undefined {
  if (prev.items && next.items) {
    // Each item is the copy's item with the same text, each of those taken once.
    const at = new Map<string, number[]>();
    prev.items.forEach((t, i) => (at.get(t) ?? at.set(t, []).get(t)!).push(i));
    const list: number[] = [];
    const add: unknown[] = [];
    next.items.forEach((t, i) => {
      const from = at.get(t)?.shift();
      if (from === undefined) {
        list.push(-1);
        add.push((value as unknown[])[i]);
      } else list.push(from);
    });
    // Mostly new: as cheap whole.
    if (add.length * 2 > list.length) return undefined;
    return add.length ? { list, add } : { list };
  }
  if (prev.members && next.members) {
    const v = value as Record<string, unknown>;
    let set: Record<string, unknown> | undefined;
    let parts: Record<string, PartPatch> | undefined;
    for (const [k, t] of next.members) {
      const was = prev.members.get(k);
      if (was?.text === t.text) continue;
      const p = was ? diffPart(was, t, v[k]) : undefined;
      if (p) put((parts ??= {}), k, p);
      else put((set ??= {}), k, v[k]);
    }
    const before = [...prev.members.keys()];
    const after = [...next.members.keys()];
    const keys = before.length === after.length && before.every((k, i) => k === after[i]) ? undefined : after;
    return { members: { ...(set ? { set } : {}), ...(parts ? { parts } : {}), ...(keys ? { keys } : {}) } };
  }
  return undefined;
}

/** `prev` with `patch` applied, keeping every item and member the patch names as kept. */
function applyPart(prev: unknown, patch: PartPatch): unknown {
  if ('list' in patch) {
    if (!Array.isArray(prev)) throw new Error('The project\'s change does not fit the copy held: not a list.');
    let n = 0;
    return patch.list.map((i) => {
      if (i < 0) return patch.add![n++];
      if (i >= prev.length) throw new Error('The project\'s change does not fit the copy held: no such item.');
      return prev[i];
    });
  }
  if (!isRecord(prev)) throw new Error('The project\'s change does not fit the copy held: not a record.');
  const { set, parts, keys } = patch.members;
  const out: Record<string, unknown> = {};
  for (const k of keys ?? Object.keys(prev)) {
    if (set && own(set, k)) put(out, k, set[k]);
    else if (parts && own(parts, k)) put(out, k, applyPart(own(prev, k) ? prev[k] : undefined, parts[k]));
    else if (own(prev, k)) put(out, k, prev[k]);
    else throw new Error(`The project's change does not fit the copy held: ${k} is missing.`);
  }
  return out;
}

/**
 * The main process's side: each snapshot made into the message the editor is sent, against the last one sent to it.
 * `reset` when the editor's copy is gone or is not this one's (another page loaded, another window, another project),
 * so the next message is whole. The numbering goes on across resets, so a message is never taken for another.
 */
export class ProjectFeed {
  private seq = 0;
  private sent: { seq: number; snapshot: ProjectSnapshot; texts: Map<string, Texts> } | null = null;

  reset(): void {
    this.sent = null;
  }

  next(snapshot: ProjectSnapshot): ProjectChange {
    const seq = ++this.seq;
    const prev = this.sent;
    const record = snapshot as unknown as Record<string, unknown>;
    const texts = new Map<string, Texts>();
    for (const k of Object.keys(record)) if (!PATCHED.has(k)) texts.set(k, textsOf(record[k], true));
    this.sent = { seq, snapshot, texts };
    if (!prev) return { seq, base: null, revision: snapshot.revision, snapshot };
    let fields: Record<string, unknown> | undefined;
    let parts: Record<string, PartPatch> | undefined;
    for (const [k, t] of texts) {
      const was = prev.texts.get(k);
      if (was?.text === t.text) continue;
      const p = was && was.text.length >= PART_MIN ? diffPart(was, t, record[k]) : undefined;
      if (p) put((parts ??= {}), k, p);
      else put((fields ??= {}), k, record[k]);
    }
    let dropped: string[] | undefined;
    for (const k of prev.texts.keys()) if (!texts.has(k)) (dropped ??= []).push(k);
    const state = diff(prev.snapshot.state as unknown as Record<string, unknown>, snapshot.state as unknown as Record<string, unknown>, STATE);
    return {
      seq,
      base: prev.seq,
      revision: snapshot.revision,
      ...(fields ? { fields: fields as Partial<SnapshotFields> } : {}),
      ...(parts ? { parts } : {}),
      ...(dropped ? { dropped } : {}),
      ...(state ? { state } : {})
    };
  }
}

/**
 * The editor's side: the snapshot each message makes from the copy held, or null when a patch was made from another
 * copy than the one held (one missed, or none held yet): the caller then asks for the whole project again, and this
 * applies nothing until it comes.
 */
export class ProjectFeedReader {
  private held: { seq: number; snapshot: ProjectSnapshot } | null = null;

  /** The `seq` of the copy held, or null. */
  get seq(): number | null {
    return this.held?.seq ?? null;
  }

  /** The copy held, or null. */
  get snapshot(): ProjectSnapshot | null {
    return this.held?.snapshot ?? null;
  }

  /** The project closed: its copy is let go. */
  forget(): void {
    this.held = null;
  }

  read(change: ProjectChange): ProjectSnapshot | null {
    if (change.base === null) {
      this.held = { seq: change.seq, snapshot: change.snapshot };
      return change.snapshot;
    }
    if (!this.held || this.held.seq !== change.base) {
      this.held = null;
      return null;
    }
    const prev = this.held.snapshot;
    const snapshot = { ...prev } as unknown as Record<string, unknown>;
    snapshot.revision = change.revision;
    for (const k of Object.keys(change.fields ?? {})) put(snapshot, k, (change.fields as Record<string, unknown>)[k]);
    for (const k of change.dropped ?? []) delete snapshot[k];
    try {
      for (const k of Object.keys(change.parts ?? {})) put(snapshot, k, applyPart(own(prev, k) ? (prev as unknown as Record<string, unknown>)[k] : undefined, change.parts![k]));
      if (change.state) snapshot.state = apply(prev.state as unknown as Record<string, unknown>, change.state);
    } catch {
      // Never a state the main process does not hold: the whole project is asked for instead.
      this.held = null;
      return null;
    }
    this.held = { seq: change.seq, snapshot: snapshot as unknown as ProjectSnapshot };
    return this.held.snapshot;
  }
}
