import { describe, expect, it, vi } from 'vitest';
import type { ProjectSnapshot } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { frozen } from '@engine/draft';
import { ProjectFeed, ProjectFeedReader, type ProjectChange } from '@shared/project-feed';

// What `project:changed` carries (#967): each change against the copy the editor was sent before, made back into the
// main process's snapshot by the editor. Messages go through structuredClone as IPC does.

const ipc = (change: ProjectChange): ProjectChange => structuredClone(change);
const bytes = (v: unknown) => JSON.stringify(v).length;

function snapshotOf(state: ProjectState, extra: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    dir: '/projects/riverside',
    state,
    revision: 1,
    history: { canUndo: false, canRedo: false, entries: [] },
    versions: { list: [], bytes: 0 },
    diagnostics: [],
    runtime: { state: 'ready', url: 'http://localhost:5173/' },
    recoveryNotes: [],
    aiBusy: false,
    aiRunId: null,
    assetUsage: {},
    missingAssets: [],
    conflicts: [],
    savedCopies: [],
    readOnly: null,
    themeUpdates: undefined,
    localState: {},
    workspaceKey: '/projects/riverside#1',
    recentExports: [],
    saveFailure: null,
    ...extra
  } as ProjectSnapshot;
}

const run = (s: ProjectState, ...ops: EditOperation[]) => frozen(applyOperations(s, ops).state);
/** A project as the session holds it, frozen through and through: the Business starter with a blog of three posts. */
const STARTED = run(
  createStarterState('business', 'Riverside Studio', false),
  { type: 'collection.create', collectionId: 'posts' } as EditOperation,
  ...['First post', 'Second post', 'Third post'].map((title) => ({ type: 'entry.create', collectionId: 'posts', title }) as EditOperation)
);
const start = () => STARTED;

/** The home page's first instance with a string property, and that property. */
function textOnHome(s: ProjectState): { nodeId: string; prop: string } {
  const home = s.pages[s.site.homePageId];
  for (const [nodeId, node] of Object.entries(home.nodes)) {
    if (node.kind !== 'instance') continue;
    const prop = Object.entries((node as InstanceNode).props).find(([, v]) => typeof v === 'string')?.[0];
    if (prop) return { nodeId, prop };
  }
  throw new Error('The starter’s home page has no text to edit.');
}
const setText = (s: ProjectState, value: string): EditOperation => {
  const { nodeId, prop } = textOnHome(s);
  return { type: 'instance.setProp', owner: { kind: 'page', id: s.site.homePageId }, nodeId, prop, value } as EditOperation;
};

/** A main process and an editor joined by IPC: each snapshot sent, and what the editor makes of it. */
function pair() {
  const feed = new ProjectFeed();
  const reader = new ProjectFeedReader();
  return {
    feed,
    reader,
    send(snap: ProjectSnapshot) {
      const change = ipc(feed.next(snap));
      return { change, got: reader.read(change) };
    }
  };
}

/** The same snapshot, key order included: what the editor holds is exactly what the main process does. */
function expectExactly(got: ProjectSnapshot | null, want: ProjectSnapshot) {
  expect(got).not.toBeNull();
  expect(JSON.stringify(got)).toBe(JSON.stringify(want));
  expect(got).toEqual(want);
}

describe('project feed', () => {
  it('sends the first snapshot whole, then only the page an edit changed', () => {
    const p = pair();
    const a = start();
    const first = p.send(snapshotOf(a));
    expect(first.change.base).toBeNull();
    expectExactly(first.got, snapshotOf(a));

    const b = run(a, setText(a, 'A new heading'));
    const edit = p.send(snapshotOf(b, { revision: 2 }));
    expect(edit.change.base).toBe(first.change.seq);
    expectExactly(edit.got, snapshotOf(b, { revision: 2 }));
    // Only the home page went: no other document, no key order, and none of the snapshot's fields.
    expect(edit.change).toEqual({ seq: edit.change.seq, base: first.change.seq, revision: 2, state: { sub: { pages: { set: { [a.site.homePageId]: b.pages[a.site.homePageId] } } } } });
    expect(bytes(edit.change)).toBeLessThan(bytes(snapshotOf(b)) / 4);
  });

  it('keeps every object an edit did not change, in the editor', () => {
    const p = pair();
    const a = start();
    const before = p.send(snapshotOf(a)).got!;
    const b = run(a, setText(a, 'A new heading'));
    const after = p.send(snapshotOf(b, { revision: 2 })).got!;
    const home = a.site.homePageId;
    expect(after.state.pages[home]).not.toBe(before.state.pages[home]);
    for (const id of Object.keys(a.pages).filter((id) => id !== home)) expect(after.state.pages[id]).toBe(before.state.pages[id]);
    for (const id of Object.keys(a.components)) expect(after.state.components[id]).toBe(before.state.components[id]);
    for (const [id, c] of Object.entries(a.collections)) {
      expect(after.state.collections[id]).toBe(before.state.collections[id]);
      for (const e of Object.keys(c.entries)) expect(after.state.collections[id].entries[e]).toBe(before.state.collections[id].entries[e]);
    }
    for (const k of ['site', 'tokens', 'assets', 'manifest', 'themeLock'] as const) expect(after.state[k]).toBe(before.state[k]);
    // So are the snapshot's fields that did not change.
    expect(after.history).toBe(before.history);
    expect(after.localState).toBe(before.localState);

    // An edit to one post keeps the others, and the collection's settings.
    const [edited, ...others] = Object.keys(b.collections.posts.entries);
    const c = run(b, { type: 'entry.update', collectionId: 'posts', entryId: edited, title: 'Renamed post' } as EditOperation);
    const third = p.send(snapshotOf(c, { revision: 3 })).got!;
    expect(third.state.collections.posts.entries[edited].title).toBe('Renamed post');
    expect(others.length).toBe(2);
    for (const id of others) expect(third.state.collections.posts.entries[id]).toBe(after.state.collections.posts.entries[id]);
    expect(third.state.collections.posts.settings).toBe(after.state.collections.posts.settings);
    expect(third.state.pages).toBe(after.state.pages);
  });

  it('sends no project content when only the preview or the AI changed', () => {
    const p = pair();
    const a = start();
    const before = p.send(snapshotOf(a)).got!;
    // Worked out again for each message, equal to what was sent before: not sent.
    const busy = p.send(snapshotOf(a, { runtime: { state: 'starting' }, aiBusy: true, aiRunId: 'run_1', history: { canUndo: false, canRedo: false, entries: [] } }));
    expect(busy.change).toEqual({ seq: busy.change.seq, base: busy.change.base, revision: 1, fields: { runtime: { state: 'starting' }, aiBusy: true, aiRunId: 'run_1' } });
    expect(busy.got!.state).toBe(before.state);
    expect(busy.got!.history).toBe(before.history);
    expectExactly(busy.got, snapshotOf(a, { runtime: { state: 'starting' }, aiBusy: true, aiRunId: 'run_1' }));
  });

  it('follows pages and entries added, removed and moved, in the main process’s key order', () => {
    const p = pair();
    let s = start();
    p.send(snapshotOf(s));
    const steps: Array<(s: ProjectState) => ProjectState> = [
      (s) => run(s, { type: 'page.create', title: 'Workshops' } as EditOperation),
      (s) => run(s, { type: 'page.create', title: 'Visit us' } as EditOperation),
      (s) => {
        const [first, ...rest] = Object.keys(s.pages);
        // Moved: the same pages in another order (as reading the project's folder again could make them).
        return frozen({ ...s, pages: Object.fromEntries([...rest, first].map((id) => [id, s.pages[id]])) });
      },
      (s) => {
        const id = Object.values(s.pages).find((pg) => pg.title === 'Workshops')!.id;
        return run(s, { type: 'page.remove', pageId: id } as EditOperation);
      },
      (s) => run(s, { type: 'entry.create', collectionId: 'posts', title: 'Spring open day' } as EditOperation),
      (s) => run(s, { type: 'token.set', tokenId: 'color.brand', value: '#225588' } as EditOperation),
      // An undo puts the very documents of an earlier state back.
      () => start(),
      // A project read again from its files: every document a new object with the same content.
      (s) => frozen(structuredClone(s) as ProjectState)
    ];
    let revision = 1;
    const sent: ProjectChange[] = [];
    const states: ProjectState[] = [];
    for (const step of steps) {
      s = step(s);
      states.push(s);
      const want = snapshotOf(s, { revision: ++revision });
      const { change, got } = p.send(want);
      sent.push(change);
      expectExactly(got, want);
    }
    // Each was a change, not the whole project: the pages' order went when it moved, and the entry by itself.
    expect(sent.every((c) => c.base !== null)).toBe(true);
    const [, , moved, , entry] = sent as Array<Extract<ProjectChange, { base: number }>>;
    expect(moved.state?.sub?.pages?.keys).toEqual(Object.keys(states[2].pages));
    expect(moved.state?.sub?.pages?.set).toBeUndefined();
    const [collection] = Object.keys(entry.state?.sub?.collections?.sub ?? {});
    expect(collection).toBeDefined();
    expect(Object.keys(entry.state!.sub!.collections!.sub![collection].sub!.entries.set ?? {})).toHaveLength(1);
  });

  it('follows fields that come and go', () => {
    const p = pair();
    const a = start();
    p.send(snapshotOf(a));
    const updates = { definitions: [] } as unknown as ProjectSnapshot['themeUpdates'];
    for (const extra of [{ themeUpdates: updates }, { themeUpdates: undefined }, { saveFailure: { kind: 'failed', message: 'Disk full' } }, {}] as Array<Partial<ProjectSnapshot>>) {
      const want = snapshotOf(a, extra);
      expectExactly(p.send(want).got, want);
    }
    const without = snapshotOf(a);
    delete (without as Partial<ProjectSnapshot>).recentExports;
    const got = p.send(without).got!;
    expect(Object.hasOwn(got, 'recentExports')).toBe(false);
    expectExactly(got, without);
  });

  it('tells a field changed in place from one that is not, and keeps what IPC keeps apart', () => {
    const p = pair();
    const a = start();
    // The session pushes onto the very conflicts array it put in the snapshot before.
    const conflicts: ProjectSnapshot['conflicts'] = [];
    p.send(snapshotOf(a, { conflicts }));
    conflicts.push({ path: 'siteorigin/pages/home.json', reason: 'Changed outside the app', kind: 'canonical' });
    const pushed = p.send(snapshotOf(a, { conflicts }));
    expect(pushed.change).toMatchObject({ fields: { conflicts: [{ path: 'siteorigin/pages/home.json' }] } });
    expectExactly(pushed.got, snapshotOf(a, { conflicts }));
    // A property there but undefined is not the same as one that is not there, nor NaN null, nor -0 0.
    const history = (extra: object) => ({ canUndo: true, canRedo: false, entries: [], ...extra }) as ProjectSnapshot['history'];
    for (const h of [history({}), history({ undoLabel: undefined }), history({ undoLabel: '\u0000undefined' }), history({ undoLabel: undefined }), history({ undoLabel: 'Edit' }), history({})]) {
      const got = p.send(snapshotOf(a, { conflicts, history: h })).got!;
      expect(Object.keys(got.history)).toEqual(Object.keys(h));
      expect(got.history).toEqual(h);
    }
    for (const n of [0, -0, NaN, null, Infinity, 0]) {
      const got = p.send(snapshotOf(a, { conflicts, assetUsage: { as_1: n as number } })).got!;
      expect(Object.is(got.assetUsage.as_1, n)).toBe(true);
    }
  });

  it('sends a long list or record by what changed in it, keeping the rest in the editor', () => {
    const p = pair();
    const a = start();
    const diag = (i: number, message = `Problem ${i} on a page that has a fairly long description of what is wrong`) => ({ severity: 'warning', code: 'COMPONENT_UNBOUND_CONTENT', message, owner: { kind: 'page', id: `pg_${i}` } }) as ProjectSnapshot['diagnostics'][number];
    const entry = (i: number, applied = true) => ({ id: `h_${i}`, label: `Edit ${i}`, source: 'user', time: 1_700_000_000_000 + i, revision: i, applied, runId: undefined }) as unknown as ProjectSnapshot['history']['entries'][number];
    const history = (n: number, extra: object = {}) => ({ canUndo: true, canRedo: false, undoLabel: `Edit ${n - 1}`, entries: Array.from({ length: n }, (_, i) => entry(i)), ...extra }) as ProjectSnapshot['history'];
    const diagnostics = Array.from({ length: 60 }, (_, i) => diag(i));
    const first = p.send(snapshotOf(a, { diagnostics, history: history(100) })).got!;

    // One diagnostic changed, one gone, one new; History let its oldest step go for a new one.
    const fewer = [...diagnostics.slice(0, 10), diag(10, 'Changed'), ...diagnostics.slice(12), diag(99)];
    const moved = history(101);
    moved.entries.shift();
    const want = snapshotOf(a, { diagnostics: fewer, history: moved });
    const { change, got } = p.send(want);
    expectExactly(got, want);
    const patch = change as Extract<ProjectChange, { base: number }>;
    expect(patch.fields).toBeUndefined();
    expect(patch.parts?.diagnostics).toEqual({ list: [...Array.from({ length: 10 }, (_, i) => i), -1, ...Array.from({ length: 48 }, (_, i) => i + 12), -1], add: [diag(10, 'Changed'), diag(99)] });
    expect(patch.parts?.history).toMatchObject({ members: { set: { undoLabel: 'Edit 100' }, parts: { entries: { add: [entry(100)] } } } });
    expect(bytes(change)).toBeLessThan(bytes(want.diagnostics) / 10);
    // The items kept are the very objects the editor held.
    expect(got!.diagnostics[0]).toBe(first.diagnostics[0]);
    expect(got!.diagnostics[12 - 1]).toBe(first.diagnostics[12]);
    expect(got!.history.entries[0]).toBe(first.history.entries[1]);

    // Undo marks a step as not applied: that step goes, and nothing else.
    const undone = history(101);
    undone.entries.shift();
    undone.entries[99] = entry(100, false);
    const u = p.send(snapshotOf(a, { diagnostics: fewer, history: { ...undone, canUndo: true, canRedo: true } }));
    expectExactly(u.got, snapshotOf(a, { diagnostics: fewer, history: { ...undone, canUndo: true, canRedo: true } }));
    expect((u.change as Extract<ProjectChange, { base: number }>).parts?.history).toMatchObject({ members: { set: { canRedo: true }, parts: { entries: { add: [entry(100, false)] } } } });

    // A list that is mostly new, or no longer a list, goes whole.
    const fresh = Array.from({ length: 60 }, (_, i) => diag(i + 200));
    const f = p.send(snapshotOf(a, { diagnostics: fresh, history: undone }));
    expect((f.change as Extract<ProjectChange, { base: number }>).fields?.diagnostics).toEqual(fresh);
    expectExactly(f.got, snapshotOf(a, { diagnostics: fresh, history: undone }));
    const odd = snapshotOf(a, { diagnostics: { not: 'a list' } as never, history: undone });
    expectExactly(p.send(odd).got, odd);
    // Items repeated are each matched once, in order.
    const doubled = [...fresh.slice(0, 30), ...fresh.slice(0, 30).map((d) => ({ ...d }))];
    const held = p.send(snapshotOf(a, { diagnostics: doubled, history: undone })).got!;
    const twice = snapshotOf(a, { diagnostics: [...doubled, diag(1)], history: undone });
    const t = p.send(twice);
    expectExactly(t.got, twice);
    const list = (t.change as Extract<ProjectChange, { base: number }>).parts!.diagnostics as { list: number[] };
    expect(list.list.slice(0, 60)).toEqual(Array.from({ length: 60 }, (_, i) => i));
    expect(t.got!.diagnostics[30]).toBe(held.diagnostics[30]);
    expect(t.got!.diagnostics[30]).not.toBe(held.diagnostics[0]);

    // A long record whose members come, go and move.
    const drafts = (keys: string[]) => ({ chatDrafts: Object.fromEntries(keys.map((k) => [k, `A draft for ${k} `.repeat(40)])), pageId: 'pg_1', zoom: 1 }) as ProjectSnapshot['localState'];
    const r0 = p.send(snapshotOf(a, { diagnostics: [...doubled, diag(1)], history: undone, localState: drafts(['c1', 'c2', 'c3']) })).got!;
    const moved2 = { zoom: 2, chatDrafts: r0.localState.chatDrafts, pageId: 'pg_1', leftTab: 'layers' } as ProjectSnapshot['localState'];
    const r1 = p.send(snapshotOf(a, { diagnostics: [...doubled, diag(1)], history: undone, localState: moved2 }));
    expect((r1.change as Extract<ProjectChange, { base: number }>).parts?.localState).toEqual({ members: { set: { zoom: 2, leftTab: 'layers' }, keys: ['zoom', 'chatDrafts', 'pageId', 'leftTab'] } });
    expect(Object.keys(r1.got!.localState)).toEqual(['zoom', 'chatDrafts', 'pageId', 'leftTab']);
    expect(r1.got!.localState.chatDrafts).toBe(r0.localState.chatDrafts);
    expectExactly(r1.got, snapshotOf(a, { diagnostics: [...doubled, diag(1)], history: undone, localState: moved2 }));
  });

  it('takes documents named like an object’s own properties for documents', () => {
    const p = pair();
    const a = start();
    const page = Object.values(a.pages)[0];
    const withOdd = frozen({ ...a, pages: { ...a.pages, toString: { ...page, id: 'toString' }, ['__proto__']: { ...page, id: '__proto__' } } as ProjectState['pages'] });
    p.send(snapshotOf(a));
    const got = p.send(snapshotOf(withOdd, { revision: 2 })).got!;
    expect(Object.keys(got.state.pages)).toEqual(Object.keys(withOdd.pages));
    expect(Object.getPrototypeOf(got.state.pages)).toBe(Object.prototype);
    expect(got.state.pages['__proto__' as string].id).toBe('__proto__');
    const renamed = frozen({ ...withOdd, pages: { ...withOdd.pages, toString: { ...page, id: 'toString', title: 'Renamed' } } as ProjectState['pages'] });
    const sent = p.send(snapshotOf(renamed, { revision: 3 }));
    const again = sent.got!;
    expect(again.state.pages['toString' as string].title).toBe('Renamed');
    // Sent whole, a document like any other.
    expect(Object.keys((sent.change as Extract<ProjectChange, { base: number }>).state!.sub!.pages.set!)).toEqual(['toString']);
    expect(again.state.pages['__proto__' as string]).toBe(got.state.pages['__proto__' as string]);
  });

  it('never applies a change to a copy it was not made from', () => {
    const feed = new ProjectFeed();
    const a = start();
    const b = run(a, setText(a, 'Two'));
    const c = run(b, setText(b, 'Three'));
    const first = ipc(feed.next(snapshotOf(a)));
    const second = ipc(feed.next(snapshotOf(b, { revision: 2 })));
    const third = ipc(feed.next(snapshotOf(c, { revision: 3 })));

    // An editor that missed the second: the third does not fit, nor does anything after it until a whole one.
    const missed = new ProjectFeedReader();
    expect(missed.read(first)).not.toBeNull();
    expect(missed.read(third)).toBeNull();
    expect(missed.read(ipc(feed.next(snapshotOf(c, { revision: 3, aiBusy: true }))))).toBeNull();
    // A page loaded again holds nothing: a change is not taken for the project.
    expect(new ProjectFeedReader().read(second)).toBeNull();
    // Asked for again (project:resync), the whole project comes, and changes follow from it.
    feed.reset();
    const whole = ipc(feed.next(snapshotOf(c, { revision: 3 })));
    expect(whole.base).toBeNull();
    expectExactly(missed.read(whole), snapshotOf(c, { revision: 3 }));
    const d = run(c, setText(c, 'Four'));
    expectExactly(missed.read(ipc(feed.next(snapshotOf(d, { revision: 4 })))), snapshotOf(d, { revision: 4 }));
  });

  it('sends a component, an entry or a moved entry by itself, and nothing for a state rebuilt of the same documents', () => {
    const p = pair();
    const a = start();
    const before = p.send(snapshotOf(a)).got!;
    const [cid, ...otherComponents] = Object.keys(a.components);
    const b = frozen({ ...a, components: { ...a.components, [cid]: { ...a.components[cid], name: 'Renamed component' } } });
    const c1 = p.send(snapshotOf(b, { revision: 2 }));
    expect(c1.change).toMatchObject({ state: { sub: { components: { set: { [cid]: { name: 'Renamed component' } } } } } });
    expect(Object.keys((c1.change as Extract<ProjectChange, { base: number }>).state!.sub!.components.set!)).toEqual([cid]);
    for (const id of otherComponents) expect(c1.got!.state.components[id]).toBe(before.state.components[id]);
    // The posts in another order: their keys go, no post with them.
    const ids = Object.keys(b.collections.posts.entries);
    const reordered = frozen({ ...b, collections: { ...b.collections, posts: { ...b.collections.posts, entries: Object.fromEntries([...ids].reverse().map((id) => [id, b.collections.posts.entries[id]])) } } });
    const c2 = p.send(snapshotOf(reordered, { revision: 3 }));
    expect(c2.change).toEqual({ seq: c2.change.seq, base: c1.change.seq, revision: 3, state: { sub: { collections: { sub: { posts: { sub: { entries: { keys: [...ids].reverse() } } } } } } } });
    expect(Object.keys(c2.got!.state.collections.posts.entries)).toEqual([...ids].reverse());
    // A new state object of the very same documents: no state at all.
    const same = frozen({ ...reordered, pages: { ...reordered.pages } });
    const c3 = p.send(snapshotOf(same, { revision: 3 }));
    expect('state' in c3.change).toBe(false);
    expect(c3.got!.state).toBe(c2.got!.state);
  });

  it('refuses a change that does not fit the copy held rather than make a state the main process never had', () => {
    const reader = new ProjectFeedReader();
    const a = start();
    reader.read({ seq: 1, base: null, revision: 1, snapshot: snapshotOf(a) });
    expect(reader.read({ seq: 2, base: 1, revision: 2, state: { sub: { pages: { keys: ['pg_missing'] } } } })).toBeNull();
    // The copy it held is let go: nothing applies to it any more, the next change nor one made against the copy.
    expect(reader.seq).toBeNull();
    expect(reader.snapshot).toBeNull();
    expect(reader.read({ seq: 3, base: 2, revision: 3 })).toBeNull();
    expect(reader.read({ seq: 4, base: 1, revision: 3 })).toBeNull();
    expect(reader.read({ seq: 5, base: 1, revision: 3, parts: { history: { list: [0] } } })).toBeNull();
  });
});

const TRANSPORT = '../../src/renderer/src/lib/transport';
/** What these tests use of the renderer's transport (lib/transport.ts). */
interface Transport {
  api: { on(channel: 'project:changed', cb: (snap: ProjectSnapshot) => void): () => void };
  use(remote: object | null): void;
  current(): Promise<ProjectSnapshot | null>;
}

describe('the editor’s transport', () => {
  type Handler = (payload: unknown) => void;
  /**
   * This computer's API as the transport reads it: each registration its own IPC listener, as the preload makes one,
   * and the two feed requests, whose answers the test gives.
   */
  async function local(feedAnswer: () => ProjectChange | null | Promise<ProjectChange | null> = () => null) {
    const { createTransport } = (await import(/* @vite-ignore */ TRANSPORT)) as { createTransport: (local: () => never) => Transport };
    const listeners = new Map<string, Set<Handler>>();
    const asked = { resync: 0, failResync: false, open: true, registrations: new Map<string, number>() };
    const api = {
      on: (ch: string, cb: Handler) => {
        asked.registrations.set(ch, (asked.registrations.get(ch) ?? 0) + 1);
        const one: Handler = (p) => cb(p);
        listeners.set(ch, new Set([...(listeners.get(ch) ?? []), one]));
        return () => listeners.get(ch)!.delete(one);
      },
      project: {
        feed: async () => feedAnswer(),
        resync: async () => {
          asked.resync++;
          if (asked.failResync) throw new Error('Unreachable');
          return asked.open;
        }
      }
    };
    const t = createTransport(() => api as never);
    const fire = (change: ProjectChange) => listeners.get('project:changed')?.forEach((cb) => cb(ipc(change)));
    const close = () => listeners.get('project:closed')?.forEach((cb) => cb(undefined));
    return { t, fire, close, asked, raw: () => listeners.get('project:changed')?.size ?? 0 };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** An answer the test gives when it chooses. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('reads each change once, and hands every listener the same snapshot', async () => {
    const { t, fire, raw, asked } = await local();
    const feed = new ProjectFeed();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = t.api.on('project:changed', (s) => void a.push(s));
    const offB = t.api.on('project:changed', (s) => void b.push(s));
    expect(asked.registrations.get('project:changed')).toBe(1);
    expect(raw()).toBe(1);
    const s0 = start();
    fire(feed.next(snapshotOf(s0)));
    const s1 = run(s0, setText(s0, 'Once'));
    fire(feed.next(snapshotOf(s1, { revision: 2 })));
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a[1]).toBe(b[1]);
    expectExactly(a[1] as ProjectSnapshot, snapshotOf(s1, { revision: 2 }));
    offA();
    expect(raw()).toBe(1);
    offB();
    expect(raw()).toBe(0);
  });

  it('asks for the whole project once when a change does not fit, until it comes', async () => {
    const { t, fire, asked } = await local();
    const feed = new ProjectFeed();
    const got: ProjectSnapshot[] = [];
    t.api.on('project:changed', (s) => void got.push(s));
    const s0 = start();
    feed.next(snapshotOf(s0));
    // Its first message missed (sent before the page listened).
    fire(feed.next(snapshotOf(s0, { aiBusy: true })));
    fire(feed.next(snapshotOf(s0, { aiBusy: false })));
    await flush();
    // Asked, and the answer back: another change before the whole project comes asks nothing more.
    fire(feed.next(snapshotOf(s0, { aiBusy: true })));
    await flush();
    expect(asked.resync).toBe(1);
    expect(got).toHaveLength(0);
    feed.reset();
    fire(feed.next(snapshotOf(s0)));
    expect(got).toHaveLength(1);
    // Missed again: asked again.
    feed.next(snapshotOf(s0, { aiBusy: false }));
    fire(feed.next(snapshotOf(s0, { aiBusy: true })));
    await flush();
    expect(asked.resync).toBe(2);
  });

  it('asks again a while later when asking failed, though nothing else comes', async () => {
    vi.useFakeTimers();
    try {
      const { t, fire, asked } = await local();
      const feed = new ProjectFeed();
      t.api.on('project:changed', () => undefined);
      const s0 = start();
      feed.next(snapshotOf(s0));
      asked.failResync = true;
      fire(feed.next(snapshotOf(s0, { aiBusy: true })));
      await vi.advanceTimersByTimeAsync(0);
      expect(asked.resync).toBe(1);
      await vi.advanceTimersByTimeAsync(600);
      expect(asked.resync).toBe(2);
      asked.failResync = false;
      await vi.advanceTimersByTimeAsync(1200);
      expect(asked.resync).toBe(3);
      // Asked successfully: no more until another change does not fit.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(asked.resync).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a page that has just loaded from the project whole, and reads the changes after it', async () => {
    const feed = new ProjectFeed();
    const s0 = start();
    feed.next(snapshotOf(s0));
    const { t, fire, asked } = await local(() => {
      feed.reset();
      return ipc(feed.next(snapshotOf(s0)));
    });
    const got: ProjectSnapshot[] = [];
    t.api.on('project:changed', (s) => void got.push(s));
    const current = await t.current();
    expectExactly(current, snapshotOf(s0));
    const s1 = run(s0, setText(s0, 'After loading'));
    fire(feed.next(snapshotOf(s1, { revision: 2 })));
    expect(got).toHaveLength(1);
    expectExactly(got[0], snapshotOf(s1, { revision: 2 }));
    expect(got[0].state.components).toBe(current!.state.components);
    expect(asked.resync).toBe(0);
  });

  it('reads a change that came before the page’s first copy on that copy, never showing it older', async () => {
    const feed = new ProjectFeed();
    const s0 = start();
    const answer = deferred<ProjectChange | null>();
    const { t, fire } = await local(() => answer.promise);
    const got: ProjectSnapshot[] = [];
    t.api.on('project:changed', (s) => void got.push(s));
    const loading = t.current();
    const whole = ipc(feed.next(snapshotOf(s0)));
    const s1 = run(s0, setText(s0, 'Before the answer'));
    // The change made against it reaches the page first.
    fire(feed.next(snapshotOf(s1, { revision: 2 })));
    expect(got).toHaveLength(0);
    answer.resolve(whole);
    expectExactly(await loading, snapshotOf(s1, { revision: 2 }));
    // And what follows applies to it.
    const s2 = run(s1, setText(s1, 'After the answer'));
    fire(feed.next(snapshotOf(s2, { revision: 3 })));
    expectExactly(got.at(-1)!, snapshotOf(s2, { revision: 3 }));
  });

  it('waits for the whole project when the page’s first copy is behind a change it cannot read', async () => {
    const feed = new ProjectFeed();
    const s0 = start();
    const answer = deferred<ProjectChange | null>();
    const { t, fire, asked } = await local(() => answer.promise);
    t.api.on('project:changed', () => undefined);
    const loading = t.current();
    const whole = ipc(feed.next(snapshotOf(s0)));
    // One change missed, the next one seen.
    feed.next(snapshotOf(s0, { aiBusy: true }));
    fire(feed.next(snapshotOf(s0, { aiBusy: false, revision: 2 })));
    answer.resolve(whole);
    await flush();
    expect(asked.resync).toBe(1);
    const s1 = run(s0, setText(s0, 'Sent whole'));
    feed.reset();
    fire(feed.next(snapshotOf(s1, { revision: 3 })));
    expectExactly(await loading, snapshotOf(s1, { revision: 3 }));
  });

  it('never goes back to an answer older than a whole read while it was on its way', async () => {
    const feed = new ProjectFeed();
    const s0 = start();
    const answer = deferred<ProjectChange | null>();
    const { t, fire } = await local(() => answer.promise);
    const got: ProjectSnapshot[] = [];
    t.api.on('project:changed', (s) => void got.push(s));
    const loading = t.current();
    const old = ipc(feed.next(snapshotOf(s0)));
    feed.reset();
    const s1 = run(s0, setText(s0, 'Newer'));
    fire(feed.next(snapshotOf(s1, { revision: 2 })));
    answer.resolve(old);
    expectExactly(await loading, snapshotOf(s1, { revision: 2 }));
    const s2 = run(s1, setText(s1, 'Newest'));
    fire(feed.next(snapshotOf(s2, { revision: 3 })));
    expectExactly(got.at(-1)!, snapshotOf(s2, { revision: 3 }));
  });

  it('lets the copy go when the project closes, and takes no answer asked for before', async () => {
    const feed = new ProjectFeed();
    const s0 = start();
    const answer = deferred<ProjectChange | null>();
    const { t, fire, close, asked } = await local(() => answer.promise);
    const got: ProjectSnapshot[] = [];
    t.api.on('project:changed', (s) => void got.push(s));
    const held = ipc(feed.next(snapshotOf(s0)));
    fire(held);
    const loading = t.current();
    close();
    answer.resolve(ipc(feed.next(snapshotOf(s0))));
    expect(await loading).toBeNull();
    // The copy is gone: a change made against the very copy it held is not read.
    fire({ seq: 50, base: held.seq, revision: 1, fields: { aiBusy: true } });
    await flush();
    expect(got).toHaveLength(1);
    expect(asked.resync).toBe(1);
  });

  it('takes nothing older than the page’s first copy that comes after it', async () => {
    const feed = new ProjectFeed();
    const s0 = start();
    const s1 = run(s0, setText(s0, 'In the first copy'));
    const { t, fire, asked } = await local(() => {
      feed.reset();
      return ipc(feed.next(snapshotOf(s1, { revision: 2 })));
    });
    const old = new ProjectFeed();
    const got: ProjectSnapshot[] = [];
    t.api.on('project:changed', (s) => void got.push(s));
    expectExactly(await t.current(), snapshotOf(s1, { revision: 2 }));
    // A whole and a change sent before the answer was made, overtaken by it.
    fire({ ...ipc(old.next(snapshotOf(s0))), seq: 1 });
    fire({ seq: 1, base: 0, revision: 1, fields: { aiBusy: true } });
    expect(got).toHaveLength(0);
    expect(asked.resync).toBe(0);
    // What follows the answer applies to it.
    const s2 = run(s1, setText(s1, 'After it'));
    fire(feed.next(snapshotOf(s2, { revision: 3 })));
    expectExactly(got.at(-1)!, snapshotOf(s2, { revision: 3 }));
  });

  it('stops waiting for the whole project when none is open to send', async () => {
    const { t, fire, asked } = await local();
    const feed = new ProjectFeed();
    t.api.on('project:changed', () => undefined);
    const s0 = start();
    feed.next(snapshotOf(s0));
    asked.open = false;
    fire(feed.next(snapshotOf(s0, { aiBusy: true })));
    await flush();
    fire(feed.next(snapshotOf(s0, { aiBusy: false })));
    await flush();
    expect(asked.resync).toBe(2);
  });

  it('keeps this computer’s copy up to date while another computer’s project is shown', async () => {
    const { t, fire, asked } = await local();
    const feed = new ProjectFeed();
    const got: ProjectSnapshot[] = [];
    t.api.on('project:changed', (s) => void got.push(s));
    const s0 = start();
    fire(feed.next(snapshotOf(s0)));
    const remote = {};
    t.use(remote as never);
    // Changed on another page while away, and the home page after.
    const other = Object.keys(s0.pages).find((id) => id !== s0.site.homePageId)!;
    const s1 = frozen({ ...s0, pages: { ...s0.pages, [other]: { ...s0.pages[other], title: 'Changed while away' } } });
    fire(feed.next(snapshotOf(s1, { revision: 2 })));
    expect(got).toHaveLength(1);
    t.use(null);
    const s2 = run(s1, setText(s1, 'Back'));
    fire(feed.next(snapshotOf(s2, { revision: 3 })));
    expect(asked.resync).toBe(0);
    expectExactly(got.at(-1)!, snapshotOf(s2, { revision: 3 }));
    expect(got.at(-1)!.state.pages[other].title).toBe('Changed while away');
  });
});

describe('a state rebuilt from document texts', async () => {
  const { shareUnchanged, stateToDocs } = await import('../../src/main/project/documents');
  /** Rebuilt as an undo or a reload rebuilds it: every document a new object, read from its text. */
  const reread = (s: ProjectState) => JSON.parse(JSON.stringify(s)) as ProjectState;

  /** The project as a session opened from its files holds it. */
  const opened = () => frozen(reread(start()));

  it('takes the documents that are the same from the project, and leaves the rest as rebuilt', () => {
    const a = opened();
    const home = a.site.homePageId;
    const b = run(a, setText(a, 'Rebuilt'));
    const rebuilt = reread(b);
    const shared = shareUnchanged(a, stateToDocs(a), rebuilt, stateToDocs(frozen(rebuilt)));
    expect(shared).toEqual(rebuilt);
    expect(shared.pages[home]).toBe(rebuilt.pages[home]);
    for (const id of Object.keys(a.pages).filter((id) => id !== home)) expect(shared.pages[id]).toBe(a.pages[id]);
    expect(shared.components).toBe(a.components);
    expect(shared.collections).toBe(a.collections);
    expect(shared.site).toBe(a.site);
    // All of it the same: every record the project's own.
    const again = reread(a);
    const same = shareUnchanged(a, stateToDocs(a), again, stateToDocs(frozen(again)));
    expect(same.pages).toBe(a.pages);
    expect(same.collections.posts).toBe(a.collections.posts);
    // A definition as the theme installs it in memory holds fields that are undefined, which its file leaves out: it
    // is not the value rebuilt from that file, so it is not kept.
    const installed = start();
    const fresh = reread(installed);
    const kept = shareUnchanged(installed, stateToDocs(installed), fresh, stateToDocs(frozen(fresh)));
    const id = Object.keys(installed.components).find((k) => Object.values(installed.components[k]).includes(undefined))!;
    expect(id).toBeDefined();
    expect(kept.components[id]).toBe(fresh.components[id]);
    expect(kept.pages).toBe(installed.pages);
  });

  it('never keeps a document whose text reads the same but whose value is not', () => {
    const base = opened();
    const [pid, other] = Object.keys(base.pages).filter((id) => id !== base.site.homePageId);
    // A number too large to store reads as null; a field holding undefined is stored as none.
    const a = frozen({ ...base, pages: { ...base.pages, [pid]: { ...base.pages[pid], navLabel: Infinity as unknown as string }, [other]: { ...base.pages[other], navLabel: undefined } } });
    const rebuilt = reread(a);
    const shared = shareUnchanged(a, stateToDocs(a), rebuilt, stateToDocs(frozen(rebuilt)));
    expect(shared.pages[pid]).toBe(rebuilt.pages[pid]);
    expect(shared.pages[pid].navLabel).toBeNull();
    expect(shared.pages[other]).toBe(rebuilt.pages[other]);
    expect(Object.hasOwn(shared.pages[other], 'navLabel')).toBe(false);
    expect(shared.pages[base.site.homePageId]).toBe(a.pages[base.site.homePageId]);
  });

  it('keeps a source by its settings and its converter’s file, and takes a converter that changed', () => {
    const base = opened();
    const crew = { schemaVersion: 1, id: 'crew', name: 'Crew', adapter: 'rest', collectionId: 'posts', config: { url: 'https://example.com/crew' }, converter: { file: 'converter.mjs', code: 'export default (r) => r;' } };
    const a = frozen(reread({ ...base, sources: { crew } } as unknown as ProjectState));
    // A page edit rebuilt from the texts: the source is the project's own.
    const rebuilt = reread(run(a, setText(a, 'Rebuilt')));
    const shared = shareUnchanged(a, stateToDocs(a), rebuilt, stateToDocs(frozen(rebuilt)));
    expect(shared).toEqual(rebuilt);
    expect(shared.sources).toBe(a.sources);
    // Only its converter changed (its settings file reads the same): the source is the one rebuilt.
    const code = 'export default (r) => ({ ...r });';
    const changed = reread({ ...a, sources: { crew: { ...a.sources!.crew, converter: { file: 'converter.mjs', code } } } });
    expect(stateToDocs(frozen(changed)).get('siteorigin/sources/crew/source.json')).toBe(stateToDocs(a).get('siteorigin/sources/crew/source.json'));
    const taken = shareUnchanged(a, stateToDocs(a), changed, stateToDocs(frozen(changed)));
    expect(taken.sources!.crew).toBe(changed.sources!.crew);
    expect(taken.sources!.crew.converter!.code).toBe(code);
    expect(taken.pages).toBe(a.pages);
    // Its converter's file gone: the source rebuilt without it.
    const without = reread({ ...a, sources: { crew: { ...a.sources!.crew, converter: { file: 'converter.mjs' } } } });
    expect(shareUnchanged(a, stateToDocs(a), without, stateToDocs(frozen(without))).sources!.crew).toBe(without.sources!.crew);
  });

  it('keeps a post by its own file, and the collection when every post and its settings are the same', () => {
    const a = opened();
    const [eid, ...rest] = Object.keys(a.collections.posts.entries);
    const b = run(a, { type: 'entry.update', collectionId: 'posts', entryId: eid, title: 'Changed post' } as EditOperation);
    const rebuilt = reread(b);
    const shared = shareUnchanged(a, stateToDocs(a), rebuilt, stateToDocs(frozen(rebuilt)));
    expect(shared).toEqual(rebuilt);
    expect(shared.collections.posts).not.toBe(a.collections.posts);
    expect(shared.collections.posts.entries[eid]).toBe(rebuilt.collections.posts.entries[eid]);
    for (const id of rest) expect(shared.collections.posts.entries[id]).toBe(a.collections.posts.entries[id]);
    expect(shared.pages).toBe(a.pages);
  });
});
