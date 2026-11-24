import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectSnapshot } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import type { AssetRecord, ElementNode, GraphNode, ImageNode, ImageValue, InstanceNode, OwnerRef } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { assetUsages } from '@engine/apply';
import { ProjectSession } from '../../src/main/project/session';
import { resetPendingForTests, savesInFlight, settle, trackApply } from '../../src/renderer/src/lib/pending';
import { BASICS, basicSpec } from '../../src/renderer/src/lib/insert-search';
import { elementWhere, sectionWhere } from '../../src/renderer/src/lib/insert-at';

/**
 * Choose image → Import on one section, then the author moves on before the import finishes (issue #262). The
 * renderer store and the placement flow, talking through a stand-in for the preload bridge to a real project
 * session, so revisions, validation and the stored value are real.
 */

/** What the tests use of the renderer store and lib/place. Both are renderer code (they read `window`), outside
 *  the Node type-check project, so they are loaded by path at run time rather than imported for their types. */
interface Toast {
  text: string;
  kind: string;
  action?: { label: string; run: () => void };
}
interface StoreState {
  snapshot: ProjectSnapshot | null;
  pendingSave: number;
  toasts: Toast[];
  leftTab: string | null;
  selection: unknown;
  pageId: string | null;
  mode: 'edit' | 'preview';
  definitionMode: unknown;
  rightTab: string;
  dockOpen: boolean;
  modal: { kind: string; id?: number; opening?: string } | null;
}
type Checked = { kind: string; where?: string; what?: string; message?: string };
interface StoreModule {
  commitIfUnchanged(base: ProjectSnapshot, commit: () => unknown, opts?: { checkOnly?: boolean }): Promise<Checked>;
  applyOps(operations: EditOperation[], label: string, coalesceKey?: string): Promise<unknown>;
  applyWith(edit: { operations: EditOperation[]; separate?: boolean } | undefined, operations: EditOperation[], label: string, coalesceKey?: string): Promise<unknown>;
  getState(): StoreState;
  setState(patch: Partial<StoreState>): void;
}
type PlaceResult = { kind: 'none' } | { kind: 'placed' | 'kept'; assetId: string };
interface PlaceModule {
  importAndPlace(opts: { paths?: string[]; base: ProjectSnapshot | null; place: (asset: AssetRecord) => string | void; holds?: (asset: AssetRecord) => boolean; shown: () => boolean }): Promise<PlaceResult>;
  SHOW_ASSET_EVENT: string;
}

type Placement = { at: { owner: OwnerRef; parentId: string | null; slot?: string; index?: number } | null; where?: { lead: string; target: string; node?: boolean }; page?: string; key?: string; reason?: string };
interface ActionsModule {
  imagePlacement(): Placement;
  placeAsset(assetId: string, shown: string): Promise<boolean>;
  insert(spec: { primitive?: string; componentId?: string; definitionId?: string; text?: string }, label: string): Promise<void>;
  insertPlan(spec: { primitive?: string; componentId?: string; definitionId?: string }): { role: string; at: Placement['at'] };
  insertionPoint(kind: 'section' | 'element', from?: unknown): Placement['at'];
}

interface ReviewModule {
  settleImportReview(id: number, webCopies: Set<string> | null): void;
}
const REVIEW_PATH = '../../src/renderer/src/lib/import-review';
let review: ReviewModule;
const STORE_PATH = '../../src/renderer/src/store';
const PLACE_PATH = '../../src/renderer/src/lib/place';
const ACTIONS_PATH = '../../src/renderer/src/lib/actions';
let store: StoreModule;
let place: PlaceModule;
let actions: ActionsModule;
let session: ProjectSession | null = null;
let opening = 1;
let aiBusy = false;
const dirs: string[] = [];
const events: Array<{ type: string; detail: unknown }> = [];
let applyCalls = 0;
/** Writes that reach the session without the renderer hearing of them yet (it is behind). */
let quiet = false;
/** Answers the renderer's request for the project's own copy instead of the session, when set. */
let onFetch: (() => ProjectSnapshot | null) | null = null;
/** The news of a change reaches the renderer this many ms after the change's answer (0: before it, as usual). */
let lateBroadcast = 0;
/** Runs once, just before the next write from the renderer reaches the session: something that lands meanwhile. */
let beforeApply: (() => Promise<unknown>) | null = null;
/** The import the author started, released by the test: the picture is still being copied until then. */
let importing: { paths?: string[]; choices?: unknown; release: (assetIds?: string[], message?: string) => Promise<void> } | null = null;
/** What the review says of each chosen file (see reviewImport): imported as it is, unless a test says otherwise. */
let reviewRow: Record<string, unknown> = { action: 'import' };
let reviews = 0;
/** The kind of file each call to the project asked for: an image field only ever takes images. */
const kinds: string[] = [];

const key = () => `${session!.dir}#${opening}`;
function snapshot(): ProjectSnapshot | null {
  if (!session) return null;
  return { dir: session.dir, workspaceKey: key(), state: structuredClone(session.state), revision: session.revision, aiBusy, aiRunId: null, conflicts: [] } as unknown as ProjectSnapshot;
}
/** The main process tells the renderer about every change, as it does after each write. */
const publish = () => store.setState({ snapshot: snapshot() });

async function write(operations: EditOperation[], label = 'Edit') {
  const r = await session!.apply({ operations }, { label, source: 'user' });
  expect(r.ok).toBe(true);
  if (!quiet) publish();
  return r;
}

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    dispatchEvent: (e: CustomEvent) => (events.push({ type: e.type, detail: e.detail }), true),
    builder: {
      platform: 'test',
      project: {
        snapshot: async () => (onFetch ? onFetch() : snapshot()),
        apply: async (batch: { operations: EditOperation[]; expectedRevision?: number }, opts?: { label?: string; coalesceKey?: string; opening?: string }) => {
          applyCalls++;
          const meanwhile = beforeApply;
          beforeApply = null;
          if (meanwhile) {
            quiet = true;
            await meanwhile();
            quiet = false;
          }
          if (opts?.opening !== undefined && opts.opening !== key()) return { ok: false, revision: 0, error: { code: 'INVALID_ARGUMENT', message: 'That project is no longer open.' } };
          if (aiBusy) return { ok: false, revision: session!.revision, error: { code: 'BUSY', message: 'The AI is making changes.' } };
          const r = await session!.apply(batch, { label: opts?.label ?? 'Edit', coalesceKey: opts?.coalesceKey, source: 'user' });
          if (r.ok && lateBroadcast) setTimeout(publish, lateBroadcast);
          else if (r.ok) publish();
          return r;
        },
        undoEntry: async (entryId: string) => {
          const r = await session!.undoEntry(entryId);
          if (r.ok) publish();
          return r;
        },
        // What the author chose, as the review says it: an ordinary picture unless a test asks for a photo to convert.
        reviewImport: async (paths?: string[], only?: string) => {
          reviews++;
          kinds.push(`review:${only}`);
          const chosen = paths ?? ['/photos/studio-at-sunrise.png'];
          return { paths: chosen, rows: chosen.map((path) => ({ path, name: path.split('/').pop(), bytes: 1000, fingerprint: `sha:${path}`, ...reviewRow })) };
        },
        importAssets: (paths?: string[], only?: string, choices?: unknown) =>
          new Promise((resolve) => {
            kinds.push(`import:${only}`);
            importing = {
              paths,
              choices,
              // The file is copied and its record saved, then the main process answers with the new asset's ID.
              release: async (assetIds, message) => {
                const ids = assetIds ?? [(await write([{ type: 'asset.add', asset: photo }], 'Import images')) && photo.id];
                resolve({ ok: !message, assetIds: ids, message });
              }
            };
          })
      }
    }
  };
  store = (await import(/* @vite-ignore */ STORE_PATH)) as StoreModule;
  place = (await import(/* @vite-ignore */ PLACE_PATH)) as PlaceModule;
  actions = (await import(/* @vite-ignore */ ACTIONS_PATH)) as ActionsModule;
  review = (await import(/* @vite-ignore */ REVIEW_PATH)) as ReviewModule;
});

afterEach(async () => {
  await session?.close().catch(() => undefined);
  session = null;
  importing = null;
  reviewRow = { action: 'import' };
  reviews = 0;
  kinds.length = 0;
  opening = 1;
  aiBusy = false;
  quiet = false;
  beforeApply = null;
  lateBroadcast = 0;
  onFetch = null;
  applyCalls = 0;
  events.length = 0;
  resetPendingForTests();
  store.setState({ snapshot: null, pendingSave: 0, toasts: [], selection: null, leftTab: 'pages', pageId: null, mode: 'edit', definitionMode: null, rightTab: 'inspect', dockOpen: false, modal: null, leaving: false } as Partial<StoreState>);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const photo: AssetRecord = {
  id: 'img_sunrise',
  name: 'Studio at sunrise.png',
  file: 'static/assets/studio-at-sunrise.png',
  mime: 'image/png',
  bytes: 2_400_000,
  width: 3600,
  height: 2400,
  hash: 'sunrise',
  kind: 'image',
  altSuggestion: 'The studio at sunrise',
  createdAt: '2026-11-23T09:00:00.000Z'
};

/** A site with two empty Split heroes on Home, as in the report. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'so-place-'));
  dirs.push(dir);
  session = await ProjectSession.create(dir, createStarterState('business', 'Test', false));
  const home = session.state.site.homePageId;
  const owner: OwnerRef = { kind: 'page', id: home };
  const heroOf = () => Object.values(session!.state.pages[home].nodes).filter((n): n is InstanceNode => n.kind === 'instance' && n.definitionId === 'foundation.hero.split');
  const first = heroOf()[0];
  expect(first).toBeTruthy();
  await write([{ type: 'instance.setProp', owner, nodeId: first.id, prop: 'image', value: { assetId: null, alt: '' } }]);
  await write([{ type: 'node.duplicate', owner, nodeId: first.id }]);
  const [a, b] = heroOf();
  expect(b).toBeTruthy();
  publish();
  const image = (id: string) => session!.state.pages[home].nodes[id] && ((session!.state.pages[home].nodes[id] as InstanceNode).props.image as ImageValue);
  /** The image field's change handler, as the inspector builds it for one hero when it renders. */
  const field = (nodeId: string) => (v: ImageValue) => void store.applyWith(undefined, [{ type: 'instance.setProp', owner, nodeId, prop: 'image', value: v }], 'Edit Image', `${nodeId}:image`);
  return { home, owner, a: a.id, b: b.id, image, field };
}

/**
 * Choose image → Import on one hero: what the image editor does, with the handler and project it shows now. Returns
 * once the files are chosen (and reviewed) and the import has started.
 */
async function startImport(write: (v: ImageValue) => void, opts: { shown?: () => boolean; start?: ImageValue } = {}) {
  importing = null;
  const run = beginImport(write, opts);
  for (let i = 0; i < 50 && !importing; i++) await tick();
  expect(importing).not.toBeNull();
  return { run };
}

/** Start Choose image → Import without waiting for the import to begin (it may wait on the review). */
function beginImport(write: (v: ImageValue) => void, opts: { shown?: () => boolean; start?: ImageValue } = {}) {
  const start = opts.start ?? { assetId: null, alt: '' };
  const base = store.getState().snapshot;
  return place.importAndPlace({
    base,
    shown: opts.shown ?? (() => false),
    holds: (asset) => asset.id === start.assetId,
    place: (asset) => {
      if (asset.id === start.assetId) return write(start);
      write({ assetId: asset.id, alt: asset.altSuggestion || start.alt || '', decorative: start.decorative });
    }
  });
}

const lastToast = () => store.getState().toasts.at(-1);
/** A save in flight is let go once its outcome has been reported, a turn after the work itself ends. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('placing an imported image (issue #262)', () => {
  it('places it in the hero the import began from after the author selects another hero', async () => {
    const { a, b, owner, image, field } = await setup();
    const { run } = await startImport(field(a));
    // While the picture is being copied, a placement is still owed: the toolbar must not say "Saved".
    expect(store.getState().pendingSave).toBe(1);
    expect(savesInFlight()).toBe(1);

    // The author clicks the second hero (the first hero's editor goes away) and edits it.
    store.setState({ selection: { owner, instancePath: [], nodeId: b } });
    await write([{ type: 'instance.setProp', owner, nodeId: b, prop: 'heading', value: 'Second hero' }]);

    await importing!.release();
    expect(await run).toEqual({ kind: 'placed', assetId: photo.id });
    expect(image(a)).toEqual({ assetId: photo.id, alt: 'The studio at sunrise' });
    // Never the hero selected now.
    expect(image(b)).toEqual({ assetId: null, alt: '' });
    expect(store.getState().pendingSave).toBe(0);
    await tick();
    expect(savesInFlight()).toBe(0);
    // Made out of sight, so it is announced, naming the section.
    expect(lastToast()).toMatchObject({ kind: 'info', text: '“Studio at sunrise.png” is now in the Split hero on Home.' });
    expect(session!.historyInfo().entries.at(-1)?.label).toBe('Edit Image');
  });

  it('places it without a note while the hero is still shown', async () => {
    const { a, image, field } = await setup();
    const { run } = await startImport(field(a), { shown: () => true });
    await importing!.release();
    expect(await run).toEqual({ kind: 'placed', assetId: photo.id });
    expect(image(a).assetId).toBe(photo.id);
    expect(store.getState().toasts).toEqual([]);
  });

  it('keeps the image in Assets and says why when the hero was edited meanwhile, with a way to find it', async () => {
    const { a, b, owner, image, field } = await setup();
    const { run } = await startImport(field(a));
    await write([{ type: 'instance.setProp', owner, nodeId: a, prop: 'image', value: { assetId: null, alt: 'A newer description' } }]);
    await importing!.release();
    expect(await run).toEqual({ kind: 'kept', assetId: photo.id });
    // The newer edit stands, and the image is in Assets.
    expect(image(a)).toEqual({ assetId: null, alt: 'A newer description' });
    expect(image(b)).toEqual({ assetId: null, alt: '' });
    expect(session!.state.assets.assets[photo.id]).toBeTruthy();
    const note = lastToast()!;
    expect(note).toMatchObject({ kind: 'error', text: '“Studio at sunrise.png” was added to Assets but not placed: the Split hero on Home was edited while it was being added.' });
    expect(note.action?.label).toBe('Show image');
    note.action!.run();
    expect(store.getState().leftTab).toBe('assets');
    expect(events).toEqual([{ type: place.SHOW_ASSET_EVENT, detail: { opening: key(), assetId: photo.id } }]);
    expect(store.getState().pendingSave).toBe(0);
  });

  it('keeps the image and says why when the hero was removed meanwhile', async () => {
    const { a, owner, field } = await setup();
    const { run } = await startImport(field(a));
    await write([{ type: 'node.remove', owner, nodeId: a }]);
    await importing!.release();
    expect(await run).toEqual({ kind: 'kept', assetId: photo.id });
    expect(lastToast()).toMatchObject({ kind: 'error', text: '“Studio at sunrise.png” was added to Assets but not placed: the Split hero on Home was removed while it was being added.' });
    expect(lastToast()!.action?.label).toBe('Show image');
  });

  it('places it after an edit the window had not heard of yet, checking the field again first', async () => {
    const { a, b, owner, image, field } = await setup();
    const { run } = await startImport(field(a));
    // Saved in the main process between the check and the write, not yet in this window's copy: the write is
    // refused as stale.
    beforeApply = () => write([{ type: 'instance.setProp', owner, nodeId: b, prop: 'heading', value: 'Elsewhere' }]);
    await importing!.release();
    expect(await run).toEqual({ kind: 'placed', assetId: photo.id });
    expect(image(a).assetId).toBe(photo.id);
    expect(applyCalls).toBe(2);
  });

  it('checks the field again after a stale write, and keeps the image when it was edited', async () => {
    const { a, owner, image, field } = await setup();
    const { run } = await startImport(field(a));
    beforeApply = () => write([{ type: 'instance.setProp', owner, nodeId: a, prop: 'image', value: { assetId: null, alt: 'Typed elsewhere' } }]);
    await importing!.release();
    expect(await run).toEqual({ kind: 'kept', assetId: photo.id });
    expect(image(a)).toEqual({ assetId: null, alt: 'Typed elsewhere' });
    expect(applyCalls).toBe(1);
    expect(lastToast()!.text).toBe('“Studio at sunrise.png” was added to Assets but not placed: the Split hero on Home was edited while it was being added.');
  });

  it('places the second of two imports into the same hero only if the first did not', async () => {
    const { a, image, field } = await setup();
    const { run: first } = await startImport(field(a));
    const firstImport = importing!;
    const { run: second } = await startImport(field(a));
    await firstImport.release();
    expect(await first).toEqual({ kind: 'placed', assetId: photo.id });
    const other: AssetRecord = { ...photo, id: 'img_dusk', name: 'Dusk.png', file: 'static/assets/dusk.png', hash: 'dusk', altSuggestion: 'Dusk' };
    await write([{ type: 'asset.add', asset: other }]);
    await importing!.release([other.id]);
    expect(await second).toEqual({ kind: 'kept', assetId: other.id });
    expect(image(a).assetId).toBe(photo.id);
  });

  it('never places it in a project opened since', async () => {
    const { a, image, field } = await setup();
    const { run } = await startImport(field(a));
    // The project was closed and opened again while the picture was copied.
    opening = 2;
    await importing!.release();
    expect(await run).toEqual({ kind: 'none' });
    expect(image(a).assetId).toBeNull();
    expect(applyCalls).toBe(0);
  });

  it('keeps the image and says so while the AI is making changes', async () => {
    const { a, image, field } = await setup();
    const { run } = await startImport(field(a));
    // The AI started while the picture was being copied.
    aiBusy = true;
    publish();
    await importing!.release();
    expect(await run).toEqual({ kind: 'kept', assetId: photo.id });
    expect(image(a).assetId).toBeNull();
    expect(applyCalls).toBe(0);
    expect(lastToast()!.text).toBe('“Studio at sunrise.png” was added to Assets but not placed: the AI is making changes.');
  });

  it('does nothing more when the field already holds that image', async () => {
    const { a, field, owner } = await setup();
    await write([{ type: 'asset.add', asset: photo }]);
    await write([{ type: 'instance.setProp', owner, nodeId: a, prop: 'image', value: { assetId: photo.id, alt: 'Here' } }]);
    const { run } = await startImport(field(a), { start: { assetId: photo.id, alt: 'Here' } });
    await importing!.release([photo.id]);
    expect(await run).toEqual({ kind: 'placed', assetId: photo.id });
    expect(applyCalls).toBe(0);
    expect(store.getState().toasts).toEqual([]);
  });

  it('checks the hero when the same picture comes back, and says so when the hero was removed meanwhile', async () => {
    const { a, field, owner } = await setup();
    await write([{ type: 'asset.add', asset: photo }]);
    await write([{ type: 'instance.setProp', owner, nodeId: a, prop: 'image', value: { assetId: photo.id, alt: 'Here' } }]);
    const { run } = await startImport(field(a), { start: { assetId: photo.id, alt: 'Here' } });
    await write([{ type: 'node.remove', owner, nodeId: a }]);
    await importing!.release([photo.id]);
    expect(await run).toEqual({ kind: 'kept', assetId: photo.id });
    expect(applyCalls).toBe(0);
    expect(lastToast()).toMatchObject({ kind: 'error', text: '“Studio at sunrise.png” was added to Assets but not placed: the Split hero on Home was removed while it was being added.' });
  });

  it('asks the project before refusing on what this window last heard (the AI had already finished)', async () => {
    const { a, image, field } = await setup();
    const { run } = await startImport(field(a));
    // This window still thinks the AI is working, and has not heard of the imported picture yet.
    store.setState({ snapshot: { ...snapshot()!, aiBusy: true } });
    quiet = true;
    await importing!.release();
    quiet = false;
    expect(await run).toEqual({ kind: 'placed', assetId: photo.id });
    expect(image(a).assetId).toBe(photo.id);
    expect(applyCalls).toBe(1);
  });

  it('tells a save waiting on it that the image the author asked for did not arrive', async () => {
    const { a, field } = await setup();
    const { run } = await startImport(field(a));
    const saving = settle({ blur: () => undefined, wait: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) });
    await importing!.release([], 'Studio at sunrise.png is larger than 25 MB.');
    expect(await run).toEqual({ kind: 'none' });
    const { problems, finish } = await saving;
    finish();
    expect(problems).toEqual(['Studio at sunrise.png is larger than 25 MB.']);
  });

  it('tells a save waiting on it that the image was not placed', async () => {
    const { a, owner, field } = await setup();
    const { run } = await startImport(field(a));
    const saving = settle({ blur: () => undefined, wait: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) });
    await write([{ type: 'node.remove', owner, nodeId: a }]);
    await importing!.release();
    expect(await run).toMatchObject({ kind: 'kept' });
    const { problems, finish } = await saving;
    finish();
    expect(problems).toEqual(['“Studio at sunrise.png” was added to Assets but not placed: the Split hero on Home was removed while it was being added.']);
  });

  it('never writes a checked edit into a project opened since, even when it was asked for there', async () => {
    const { a, owner } = await setup();
    const base = store.getState().snapshot!;
    opening = 2;
    publish();
    const done = await store.commitIfUnchanged(base, () => store.applyOps([{ type: 'instance.setProp', owner, nodeId: a, prop: 'image', value: { assetId: null, alt: 'Late' } }], 'Edit Image'));
    expect(done).toEqual({ kind: 'closed' });
    expect(applyCalls).toBe(0);
  });

  it('applies one edit per checked commit, and reports a commit that made none', async () => {
    const { a, b, owner, image } = await setup();
    const base = store.getState().snapshot!;
    const set = (nodeId: string, alt: string) => store.applyOps([{ type: 'instance.setProp', owner, nodeId, prop: 'image', value: { assetId: null, alt } }], 'Edit Image');
    const done = await store.commitIfUnchanged(base, () => (set(a, 'First'), set(b, 'Second')));
    expect(done).toMatchObject({ kind: 'applied' });
    expect(image(a).alt).toBe('First');
    expect(image(b).alt).toBe('');
    expect(await store.commitIfUnchanged(base, () => undefined)).toEqual({ kind: 'failed', message: 'That change could not be made.' });
    // Outside a checked commit, edits apply as before.
    await set(b, 'Plain');
    expect(image(b).alt).toBe('Plain');
  });

  it('checks the same picture against the project itself, not a copy that is behind', async () => {
    const { a, field, owner } = await setup();
    await write([{ type: 'asset.add', asset: photo }]);
    await write([{ type: 'instance.setProp', owner, nodeId: a, prop: 'image', value: { assetId: photo.id, alt: 'Here' } }]);
    const { run } = await startImport(field(a), { start: { assetId: photo.id, alt: 'Here' } });
    // Removed in the main process; this window has not heard yet.
    quiet = true;
    await write([{ type: 'node.remove', owner, nodeId: a }]);
    quiet = false;
    await importing!.release([photo.id]);
    expect(await run).toEqual({ kind: 'kept', assetId: photo.id });
    expect(lastToast()!.text).toBe('“Studio at sunrise.png” was added to Assets but not placed: the Split hero on Home was removed while it was being added.');
  });

  it('offers the image it found in the project, even when this window has not heard of it yet', async () => {
    const { a, owner, image, field } = await setup();
    const { run } = await startImport(field(a));
    // The hero is edited and the picture recorded, all before this window hears of either.
    quiet = true;
    await write([{ type: 'instance.setProp', owner, nodeId: a, prop: 'image', value: { assetId: null, alt: 'Typed elsewhere' } }]);
    await importing!.release();
    expect(await run).toEqual({ kind: 'kept', assetId: photo.id });
    quiet = false;
    expect(image(a)).toEqual({ assetId: null, alt: 'Typed elsewhere' });
    const note = lastToast()!;
    expect(note.text).toBe('“Studio at sunrise.png” was added to Assets but not placed: the Split hero on Home was edited while it was being added.');
    expect(note.action?.label).toBe('Show image');
  });
});

describe('placing a library image from Assets (issue #13)', () => {
  const nook: AssetRecord = { ...photo, id: 'img_nook', name: 'Reading nook', file: 'static/assets/reading-nook.png', hash: 'nook', altSuggestion: 'A reading corner with an armchair and shelves of books' };

  /** Business Home, whose Gallery already shows the reading nook (with alt text of its own), and the studio photo
   *  imported but not used anywhere. The author is editing Home. */
  async function library() {
    const dir = mkdtempSync(join(tmpdir(), 'so-library-'));
    dirs.push(dir);
    session = await ProjectSession.create(dir, createStarterState('business', 'Test', false));
    const home = session.state.site.homePageId;
    const owner: OwnerRef = { kind: 'page', id: home };
    const page = () => session!.state.pages[home];
    const gallery = Object.values(page().nodes).find((n): n is InstanceNode => n.kind === 'instance' && session!.state.components[n.definitionId]?.componentId === 'media.gallery')!;
    expect(gallery).toBeTruthy();
    await write([{ type: 'asset.add', asset: nook }, { type: 'asset.add', asset: photo }], 'Import images');
    const item = (gallery.props.images as Array<{ id: string }>)[2].id;
    await write([{ type: 'instance.setProp', owner, nodeId: gallery.id, prop: 'images', itemId: item, field: 'image', value: { assetId: nook.id, alt: 'The reading room at the Old Mill' } }]);
    store.setState({ pageId: home, mode: 'edit', definitionMode: null, selection: null });
    const uses = (id: string) => assetUsages(session!.state)[id] ?? 0;
    const entries = () => session!.historyInfo().entries.length;
    const galleryName = session.state.components[gallery.definitionId].name;
    return { home, owner, page, gallery: gallery.id, item, galleryName, uses, entries };
  }
  const placed = (page: { nodes: Record<string, GraphNode> }, assetId: string) => Object.values(page.nodes).filter((n): n is ImageNode => n.kind === 'image' && (n.image as ImageValue).assetId === assetId);

  it('places another copy of an image used elsewhere after the selected Gallery, keeping that use, in one change', async () => {
    const { home, owner, page, gallery, galleryName, uses, entries } = await library();
    store.setState({ selection: { owner, instancePath: [], nodeId: gallery } });
    const before = structuredClone(page().nodes[gallery]);
    const at = page().rootIds.indexOf(gallery);
    const history = entries();
    const p = actions.imagePlacement();
    expect(p.where).toEqual({ lead: 'in a new section after', target: galleryName, node: true });
    expect(p.page).toBe('Home');
    expect(uses(nook.id)).toBe(1);

    expect(await actions.placeAsset(nook.id, p.key!)).toBe(true);
    // A new section right after the Gallery holds the image, with the image's suggested alt text.
    const section = page().nodes[page().rootIds[at + 1]] as InstanceNode;
    expect(session!.state.components[section.definitionId].componentId).toBe('layout.section');
    const [img] = section.slots!.content.map((id) => page().nodes[id]);
    expect(img).toMatchObject({ kind: 'image', image: { assetId: nook.id, alt: nook.altSuggestion } });
    // The Gallery's own use, with its own alt text and caption, is untouched; the library gains no record.
    expect(page().nodes[gallery]).toEqual(before);
    expect(uses(nook.id)).toBe(2);
    expect(Object.keys(session!.state.assets.assets).sort()).toEqual([nook.id, photo.id].sort());
    expect(applyCalls).toBe(1);
    expect(entries()).toBe(history + 1);
    // The new image is selected, with its inspector open.
    expect(store.getState()).toMatchObject({ selection: { owner, instancePath: [], nodeId: img.id }, rightTab: 'inspect', dockOpen: true });
    const note = lastToast()!;
    expect(note).toMatchObject({ kind: 'info', text: `Placed “Reading nook” in a new section after ${galleryName} on Home.` });

    // One Undo takes the image and the section made for it away again, and leaves the image in Assets.
    expect(note.action?.label).toBe('Undo');
    note.action!.run();
    await vi.waitFor(() => expect(page().rootIds).not.toContain(section.id));
    expect(placed(page(), nook.id)).toEqual([]);
    expect(uses(nook.id)).toBe(1);
    expect(session!.state.assets.assets[nook.id]).toBeTruthy();
    expect(session!.state.pages[home].nodes[gallery]).toEqual(before);
  });

  it('places an unused import inside the page’s flexible section when nothing is selected', async () => {
    const { owner, page, uses } = await library();
    // Two flexible sections: the image goes in the last one.
    await write([{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }]);
    const r = await write([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }]);
    const section = r.results![0].nodeId as string;
    const p = actions.imagePlacement();
    expect(p.where).toEqual({ lead: 'inside', target: 'Section', node: true });
    expect(uses(photo.id)).toBe(0);
    expect(await actions.placeAsset(photo.id, p.key!)).toBe(true);
    const content = (page().nodes[section] as InstanceNode).slots!.content;
    expect(content).toHaveLength(1);
    expect(page().nodes[content[0]]).toMatchObject({ kind: 'image', image: { assetId: photo.id, alt: 'The studio at sunrise' } });
    expect(uses(photo.id)).toBe(1);
    expect(lastToast()?.text).toBe('Placed “Studio at sunrise.png” inside Section on Home.');
  });

  it('places it beside the component when a picture inside it is selected, and on the page when the header is', async () => {
    const { owner, page, gallery, item, galleryName } = await library();
    const def = session!.state.components[(page().nodes[gallery] as InstanceNode).definitionId];
    const picture = Object.values(def.tree!.nodes).find((n) => n.kind === 'image')!;
    store.setState({ selection: { owner, instancePath: [gallery], nodeId: picture.id, itemPath: [item] } });
    const inGallery = actions.imagePlacement();
    expect(inGallery.where).toEqual({ lead: 'in a new section after', target: galleryName, node: true });
    expect(await actions.placeAsset(nook.id, inGallery.key!)).toBe(true);
    const after = page().nodes[page().rootIds[page().rootIds.indexOf(gallery) + 1]] as InstanceNode;
    expect(page().nodes[after.slots!.content[0]]).toMatchObject({ kind: 'image', image: { assetId: nook.id } });
    // The header is shared by every page: the image goes on the page, by the page's own rule, which is now the
    // flexible section just made for the reading nook.
    const header = session!.state.site.shell.header.rootIds[0];
    store.setState({ selection: { owner: { kind: 'shell', id: 'header' }, instancePath: [], nodeId: header } });
    const p = actions.imagePlacement();
    expect(p.at).toEqual({ owner, parentId: after.id, slot: 'content' });
    expect(p.where).toEqual({ lead: 'inside', target: 'Section', node: true });
    expect(await actions.placeAsset(photo.id, p.key!)).toBe(true);
    expect(placed(page(), photo.id)).toHaveLength(1);
    expect((page().nodes[after.id] as InstanceNode).slots!.content).toEqual([placed(page(), nook.id)[0].id, placed(page(), photo.id)[0].id]);
    expect(Object.values(session!.state.site.shell.header.nodes).some((n) => n.kind === 'image')).toBe(false);
  });

  it('says why it cannot place the image while a component is edited or the page is previewed', async () => {
    const { gallery, page } = await library();
    const definitionId = (page().nodes[gallery] as InstanceNode).definitionId;
    const shown = actions.imagePlacement().key!;
    store.setState({ definitionMode: { definitionId, returnPageId: page().id } });
    expect(actions.imagePlacement()).toEqual({ at: null, reason: 'Finish editing this component to place the image on a page.' });
    expect(await actions.placeAsset(photo.id, shown)).toBe(false);
    expect(lastToast()).toMatchObject({ kind: 'error', text: 'Finish editing this component to place the image on a page.' });
    store.setState({ definitionMode: null, mode: 'preview' });
    expect(actions.imagePlacement()).toEqual({ at: null, reason: 'Switch to Edit to place the image on a page.' });
    store.setState({ mode: 'edit' });
    // What the project itself says: the AI is working on it, it is read-only, or the picture's file is missing.
    store.setState({ snapshot: { ...snapshot()!, aiBusy: true } });
    expect(actions.imagePlacement()).toEqual({ at: null, reason: 'The AI is making changes. Stop it to place the image.' });
    store.setState({ snapshot: { ...snapshot()!, readOnly: { reason: 'Made by a newer version.' } } as unknown as ProjectSnapshot });
    expect(actions.imagePlacement()).toEqual({ at: null, reason: 'This project is open read-only, so the image can’t be placed.' });
    store.setState({ snapshot: { ...snapshot()!, missingAssets: [{ assetId: photo.id, original: true, variants: [] }] } as unknown as ProjectSnapshot });
    expect(await actions.placeAsset(photo.id, actions.imagePlacement().key!)).toBe(false);
    expect(lastToast()).toMatchObject({ kind: 'error', text: 'Locate the file to place this image.' });
    expect(applyCalls).toBe(0);
    // Smaller copies missing, with the original there: it is placed, and the copies are made again from it.
    store.setState({ snapshot: { ...snapshot()!, missingAssets: [{ assetId: photo.id, original: false, variants: [640] }] } as unknown as ProjectSnapshot });
    expect(await actions.placeAsset(photo.id, actions.imagePlacement().key!)).toBe(true);
  });

  it('places nothing when where it would go changed before the click was handled', async () => {
    const { owner, page, gallery } = await library();
    store.setState({ selection: { owner, instancePath: [], nodeId: gallery } });
    const shown = actions.imagePlacement().key!;
    // Another edit moves the Gallery to the top of the page: "after the Gallery" is now somewhere else.
    await write([{ type: 'node.move', owner, nodeId: gallery, parentId: null, index: 0 }]);
    const roots = [...page().rootIds];
    expect(await actions.placeAsset(nook.id, shown)).toBe(false);
    expect(page().rootIds).toEqual(roots);
    expect(applyCalls).toBe(0);
    expect(lastToast()).toMatchObject({ kind: 'info', text: 'Where the image would go has changed. Check the new place, then place it again.' });
  });

  it('places nothing when the page or the Gallery it goes after changed, even at the same position', async () => {
    const { owner, page, gallery } = await library();
    // Another page, where the image would go at the same position in a section of its own.
    store.setState({ selection: null });
    const onHome = actions.imagePlacement().key!;
    const about = session!.state.site.pageOrder.find((id) => id !== page().id)!;
    store.setState({ pageId: about });
    expect(await actions.placeAsset(nook.id, onHome)).toBe(false);
    // Two Galleries side by side: the first is removed and the second, now in its place, is selected.
    store.setState({ pageId: page().id });
    const twin = (await write([{ type: 'node.duplicate', owner, nodeId: gallery }])).results![0].nodeId as string;
    store.setState({ selection: { owner, instancePath: [], nodeId: gallery } });
    const afterFirst = actions.imagePlacement().key!;
    await write([{ type: 'node.remove', owner, nodeId: gallery }]);
    store.setState({ selection: { owner, instancePath: [], nodeId: twin } });
    expect(await actions.placeAsset(nook.id, afterFirst)).toBe(false);
    expect(placed(page(), nook.id)).toEqual([]);
    expect(applyCalls).toBe(0);
  });

  it('plans the placement again when the project moved on before it arrived, and places it only where it was shown', async () => {
    const { owner, page, gallery, entries } = await library();
    store.setState({ selection: { owner, instancePath: [], nodeId: gallery } });
    let shown = actions.imagePlacement().key!;
    // An edit this window has not heard of yet moves the Gallery: the image would now go somewhere else.
    beforeApply = () => write([{ type: 'node.move', owner, nodeId: gallery, parentId: null, index: 0 }]);
    expect(await actions.placeAsset(nook.id, shown)).toBe(false);
    expect(placed(page(), nook.id)).toEqual([]);
    expect(lastToast()).toMatchObject({ kind: 'info', text: 'Where the image would go has changed. Check the new place, then place it again.' });
    // One that leaves the destination as it was (a rename) does not stop it.
    publish();
    shown = actions.imagePlacement().key!;
    const history = entries();
    beforeApply = () => write([{ type: 'asset.update', assetId: photo.id, name: 'Studio at dawn' }]);
    expect(await actions.placeAsset(nook.id, shown)).toBe(true);
    expect(placed(page(), nook.id)).toHaveLength(1);
    expect(entries()).toBe(history + 2);
    expect(store.getState().toasts.filter((t) => t.kind === 'error')).toEqual([]);
  });

  it('uses a suggested alt text committed as the author clicks Place on page', async () => {
    const { owner, page, gallery } = await library();
    store.setState({ selection: { owner, instancePath: [], nodeId: gallery } });
    const shown = actions.imagePlacement().key!;
    const before = structuredClone(page().nodes[gallery]);
    // Leaving the field commits it; the click's placement starts before that change (and a rename before it) has
    // landed, and this window hears of each change only after its answer.
    lateBroadcast = 40;
    const renamed = store.applyOps([{ type: 'asset.update', assetId: nook.id, name: 'Reading corner' }], 'Rename image');
    const typed = store.applyOps([{ type: 'asset.update', assetId: nook.id, altSuggestion: 'Armchair and bookshelves by a window' }], 'Edit alt suggestion');
    expect(await actions.placeAsset(nook.id, shown)).toBe(true);
    await Promise.all([renamed, typed]);
    expect(placed(page(), nook.id).map((n) => (n.image as ImageValue).alt)).toEqual(['Armchair and bookshelves by a window']);
    // The Gallery keeps the alt text it had.
    expect(page().nodes[gallery]).toEqual(before);
    expect(lastToast()?.text).toBe('Placed “Reading corner” in a new section after Gallery on Home.');
  });

  it('inserts a basic element in a new section as one change (Insert panel)', async () => {
    const { owner, page, entries } = await library();
    const history = entries();
    store.setState({ rightTab: 'chat' });
    await actions.insert({ primitive: 'heading' }, 'Heading');
    expect(applyCalls).toBe(1);
    expect(entries()).toBe(history + 1);
    const section = page().nodes[page().rootIds.at(-1)!] as InstanceNode;
    const [heading] = section.slots!.content;
    expect(page().nodes[heading]).toMatchObject({ kind: 'text', tag: 'h2' });
    expect(store.getState().selection).toEqual({ owner, instancePath: [], nodeId: heading });
    expect(store.getState().rightTab).toBe('inspect');
  });

  it('inserts a bulleted or a numbered list as one change, with real list items (Insert panel)', async () => {
    const { owner, page, entries } = await library();
    for (const name of ['Bulleted list', 'Numbered list']) {
      const history = entries();
      await actions.insert(basicSpec(BASICS.find((b) => b.name === name)!), name);
      expect(entries()).toBe(history + 1);
      const { nodeId } = store.getState().selection as { nodeId: string };
      const node = page().nodes[nodeId];
      expect(node).toMatchObject({ kind: 'text', rich: true });
      const kind = name === 'Bulleted list' ? 'ul' : 'ol';
      const words = kind === 'ul' ? ['First item', 'Second item', 'Third item'] : ['First step', 'Second step', 'Third step'];
      expect(node.kind === 'text' && node.text).toEqual([{ type: kind, items: words.map((text) => [{ text }]) }]);
      expect(store.getState().selection).toMatchObject({ owner });
    }
  });

  it('inserts a column layout as one change and selects its Grid; each column then takes content as one change of its own (#514)', async () => {
    const { owner, page, entries } = await library();
    const sections = page().rootIds.length;
    const history = entries();
    await actions.insert(basicSpec(BASICS.find((b) => b.name === '2 columns')!), '2 columns');
    expect(applyCalls).toBe(1);
    expect(entries()).toBe(history + 1);
    // Nothing selected: the Grid goes in the page's last Section that takes content, and is what is selected, not
    // its last column.
    const gridId = store.getState().selection!.nodeId;
    const grid = page().nodes[gridId] as ElementNode;
    expect(grid).toMatchObject({ kind: 'element', name: 'Columns', styles: { desktop: { columns: 2 } } });
    expect(store.getState().selection).toEqual({ owner, instancePath: [], nodeId: gridId });
    const [left, right] = grid.children;
    // A click on a column's frame selects it (#511), and Insert fills it.
    for (const [column, text] of [[left, 'Left words'], [right, 'Right words']]) {
      store.setState({ selection: { owner, instancePath: [], nodeId: column } });
      const before = entries();
      await actions.insert({ primitive: 'paragraph', text }, 'Paragraph');
      expect(entries()).toBe(before + 1);
      const [added] = (page().nodes[column] as ElementNode).children;
      expect(page().nodes[added]).toMatchObject({ kind: 'text', text });
      expect(store.getState().selection).toEqual({ owner, instancePath: [], nodeId: added });
    }
    // Undo takes back one paragraph at a time, then the whole layout.
    await session!.undo();
    expect((page().nodes[right] as ElementNode).children).toEqual([]);
    expect((page().nodes[left] as ElementNode).children).toHaveLength(1);
    await session!.undo();
    expect((page().nodes[left] as ElementNode).children).toEqual([]);
    await session!.undo();
    expect(page().nodes[gridId]).toBeUndefined();
    expect(page().nodes[left]).toBeUndefined();
    expect(page().rootIds).toHaveLength(sections);
  });

  it('inserts a column layout on a page with no Section to take it, in a new Section that one Undo takes away with it (#514)', async () => {
    const { owner, page, gallery, entries } = await library();
    // The gallery takes no content: the columns go in a new Section after it.
    store.setState({ selection: { owner, instancePath: [], nodeId: gallery } });
    const roots = [...page().rootIds];
    const history = entries();
    await actions.insert({ primitive: 'grid', columns: 3 }, '3 columns');
    expect(entries()).toBe(history + 1);
    const gridId = store.getState().selection!.nodeId;
    const wrapper = page().rootIds[roots.indexOf(gallery) + 1];
    expect((page().nodes[wrapper] as InstanceNode).slots?.content).toEqual([gridId]);
    expect((page().nodes[gridId] as ElementNode).children).toHaveLength(3);
    await session!.undo();
    expect(page().rootIds).toEqual(roots);
  });

  it('inserts into the Section whose Container is picked in Layers, not the page’s last Section (#185)', async () => {
    const { owner, page } = await library();
    const sections = await write([
      { type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' },
      { type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }
    ]);
    const [first, last] = sections.results!.map((r) => r.nodeId as string);
    const stack = (await write([{ type: 'node.insert', owner, parentId: first, slot: 'content', primitive: 'stack' }])).results![0].nodeId as string;
    const made = await write([{ type: 'component.createFromNode', owner, nodeId: stack, name: 'Feature card' }]);
    const card = made.results![0].definitionId as string;
    const content = (id: string) => (page().nodes[id] as InstanceNode).slots?.content ?? [];
    const pickContainer = () => {
      const def = session!.state.components[(page().nodes[first] as InstanceNode).definitionId];
      store.setState({ selection: { owner, instancePath: [first], nodeId: def.parts.container.nodeId, partId: 'container' } });
    };
    // Layers › Section › Parts › Container: the Insert panel's line and the click agree on the Section it is part of.
    pickContainer();
    expect(actions.insertPlan({ definitionId: card })).toEqual({ role: 'element', at: { owner, parentId: first, slot: 'content' } });
    await actions.insert({ definitionId: card }, 'Feature card');
    expect(content(first)).toHaveLength(2);
    expect((page().nodes[content(first)[1]] as InstanceNode).definitionId).toBe(card);
    expect(content(last)).toEqual([]);
    // A basic element goes there too, and a whole section goes after that Section rather than at the end of the page.
    pickContainer();
    await actions.insert({ primitive: 'heading' }, 'Heading');
    expect(content(first)).toHaveLength(3);
    pickContainer();
    await actions.insert({ componentId: 'layout.section' }, 'Section');
    expect(page().rootIds.indexOf(first)).toBe(0);
    expect((page().nodes[page().rootIds[1]] as InstanceNode).definitionId).toBe('foundation.layout.section');
    expect(page().rootIds.at(-1)).toBe(last);
  });

  it('reads a part or repeated item of a placed section as that section when inserting, on a page and inside Edit everywhere (#510)', async () => {
    const { home, owner, page, gallery, item, galleryName } = await library();
    const state = () => session!.state;
    const rootIds = () => [...page().rootIds];
    const definitionOf = (id: string) => state().components[(page().nodes[id] as InstanceNode).definitionId];
    const content = (id: string) => (page().nodes[id] as InstanceNode).slots?.content ?? [];
    // The Gallery's own Image part, in one of its repeated items.
    const pick = { owner, instancePath: [gallery], nodeId: definitionOf(gallery).parts.image.nodeId, partId: 'image', itemPath: [item] };

    // A picture in one item of the Gallery, which takes no content: a section, and an element in a new section of its own,
    // go right after the Gallery, and the Insert line says so. First on Home as it is (it ends in a component that takes
    // no content), then with a flexible Section after that: the one section the insert used to be sent to.
    const checkGallery = async (last: string) => {
      const lastContent = content(last);
      store.setState({ selection: pick });
      const next = rootIds().indexOf(gallery) + 1;
      const sectionAt = actions.insertionPoint('section');
      const elementAt = actions.insertionPoint('element');
      expect(sectionAt).toEqual({ owner, parentId: null, index: next });
      expect(elementAt).toEqual({ owner, parentId: null, index: next });
      expect(sectionWhere(state(), sectionAt)).toEqual({ lead: 'after', target: galleryName });
      expect(elementWhere(state(), elementAt)).toEqual({ lead: 'in a new section after', target: galleryName, node: true });
      const before = rootIds();
      await actions.insert({ componentId: 'layout.section' }, 'Section');
      expect(rootIds()).toHaveLength(before.length + 1);
      expect(rootIds()[next - 1]).toBe(gallery);
      expect(rootIds().at(-1)).toBe(last);
      const added = rootIds()[next];
      expect(before).not.toContain(added);
      store.setState({ selection: pick });
      await actions.insert({ primitive: 'heading' }, 'Heading');
      expect(rootIds()).toHaveLength(before.length + 2);
      expect(rootIds()[next - 1]).toBe(gallery);
      expect(rootIds()[next + 1]).toBe(added);
      expect(rootIds().at(-1)).toBe(last);
      expect(page().nodes[content(rootIds()[next])[0]]).toMatchObject({ kind: 'text' });
      expect(content(last)).toEqual(lastContent);
    };
    await checkGallery(rootIds().at(-1)!);
    const last = (await write([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }])).results![0].nodeId as string;
    await checkGallery(last);
    const lastContent = content(last);

    // A part of a section that takes content, with another such section after it: the element goes into its slot and
    // the section after it, not into the page's last section.
    const [first] = (await write([{ type: 'node.insert', owner, parentId: null, index: 0, componentId: 'layout.section' }])).results!.map((r) => r.nodeId as string);
    const container = { owner, instancePath: [first], nodeId: definitionOf(first).parts.container.nodeId, partId: 'container' };
    store.setState({ selection: container });
    expect(actions.insertionPoint('element')).toEqual({ owner, parentId: first, slot: 'content' });
    expect(actions.insertionPoint('section')).toEqual({ owner, parentId: null, index: 1 });
    expect(sectionWhere(state(), actions.insertionPoint('section'))).toEqual({ lead: 'after', target: 'Section' });
    await actions.insert({ primitive: 'heading' }, 'Heading');
    expect(content(first)).toHaveLength(1);
    expect(content(last)).toEqual(lastContent);
    store.setState({ selection: container });
    const length = rootIds().length;
    const beforeSection = rootIds();
    await actions.insert({ componentId: 'layout.section' }, 'Section');
    expect(rootIds()).toHaveLength(length + 1);
    expect(rootIds()[0]).toBe(first);
    expect(beforeSection).not.toContain(rootIds()[1]);
    expect(rootIds().slice(2)).toEqual(beforeSection.slice(1));

    // Edit everywhere: a section placed in a component's design is read the same way, from a part of it.
    const stack = (await write([{ type: 'node.insert', owner, parentId: first, slot: 'content', primitive: 'stack' }])).results![0].nodeId as string;
    const card = (await write([{ type: 'component.createFromNode', owner, nodeId: stack, name: 'Feature card' }])).results![0].definitionId as string;
    const inside: OwnerRef = { kind: 'component', id: card };
    const root = state().components[card].tree!.rootIds[0];
    const nested = (await write([{ type: 'node.insert', owner: inside, parentId: root, componentId: 'layout.section' }])).results![0].nodeId as string;
    const nestedDef = state().components[(state().components[card].tree!.nodes[nested] as InstanceNode).definitionId];
    const part = { owner: inside, instancePath: [nested], nodeId: nestedDef.parts.container.nodeId, partId: 'container', itemPath: ['row-1'] };
    store.setState({ definitionMode: { definitionId: card, returnPageId: home }, selection: part });
    expect(actions.insertionPoint('element')).toEqual({ owner: inside, parentId: nested, slot: 'content' });
    expect(actions.insertionPoint('section')).toEqual({ owner: inside, parentId: root });
    // The part given outright is read the same, whatever the selection holds.
    store.setState({ selection: null });
    expect(actions.insertionPoint('element', part)).toEqual({ owner: inside, parentId: nested, slot: 'content' });
    expect(actions.insertionPoint('section', part)).toEqual({ owner: inside, parentId: root });
    // And the click puts the element in the nested section's slot.
    store.setState({ selection: part });
    await actions.insert({ primitive: 'heading' }, 'Heading');
    const slotted = (state().components[card].tree!.nodes[nested] as InstanceNode).slots?.content ?? [];
    expect(slotted).toHaveLength(1);
    expect(state().components[card].tree!.nodes[slotted[0]]).toMatchObject({ kind: 'text' });
  });

  it('keeps a formatting command its own Undo step, even right after typing in the same field', async () => {
    const { owner, entries } = await library();
    await actions.insert(basicSpec(BASICS.find((b) => b.name === 'Bulleted list')!), 'Bulleted list');
    const { nodeId } = store.getState().selection as { nodeId: string };
    const set = (value: string) => [{ type: 'node.setContent' as const, owner, nodeId, field: 'text' as const, value }];
    const history = entries();
    // Typing in one field joins its last edit; a command made in the same field a moment later does not.
    await store.applyWith(undefined, set('- One\n- Two'), 'Edit text', `${nodeId}:text`);
    await store.applyWith(undefined, set('- One\n- Two words'), 'Edit text', `${nodeId}:text`);
    expect(entries()).toBe(history + 1);
    await store.applyWith({ operations: [], separate: true }, set('- Two words\n- One'), 'Edit text', `${nodeId}:text`);
    await store.applyWith({ operations: [], separate: true }, set('1. Two words\n2. One'), 'Edit text', `${nodeId}:text`);
    expect(entries()).toBe(history + 3);
    // Typing again after a command starts a step of its own too.
    await store.applyWith(undefined, set('1. Two words\n2. One more'), 'Edit text', `${nodeId}:text`);
    expect(entries()).toBe(history + 4);
    await session!.undo();
    await session!.undo();
    expect(session!.state.pages[owner.id].nodes[nodeId]).toMatchObject({ text: [{ type: 'ul', items: [[{ text: 'Two words' }], [{ text: 'One' }]] }] });
  });

  it('does not wait on a long import elsewhere before placing', async () => {
    const { owner, page, gallery } = await library();
    store.setState({ selection: { owner, instancePath: [], nodeId: gallery } });
    const shown = actions.imagePlacement().key!;
    // An image field's import that is still copying a large file: it counts as a save in flight.
    trackApply(new Promise(() => {}));
    const t0 = Date.now();
    expect(await actions.placeAsset(nook.id, shown)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(placed(page(), nook.id)).toHaveLength(1);
  });

  it('leaves the selection and the dock as the author set them while the image was being placed', async () => {
    const { owner, page, gallery } = await library();
    store.setState({ selection: { owner, instancePath: [], nodeId: gallery }, rightTab: 'inspect', dockOpen: true });
    let shown = actions.imagePlacement().key!;
    // The author switches the dock to the AI meanwhile: the image is selected, but the AI stays open.
    beforeApply = async () => store.setState({ rightTab: 'chat' });
    expect(await actions.placeAsset(nook.id, shown)).toBe(true);
    const first = placed(page(), nook.id)[0].id;
    expect(store.getState()).toMatchObject({ selection: { nodeId: first }, rightTab: 'chat' });
    // Or closes the dock: it stays closed.
    store.setState({ rightTab: 'inspect', dockOpen: true });
    shown = actions.imagePlacement().key!;
    beforeApply = async () => store.setState({ dockOpen: false });
    expect(await actions.placeAsset(nook.id, shown)).toBe(true);
    expect(store.getState()).toMatchObject({ rightTab: 'inspect', dockOpen: false });
    // The author selects something else meanwhile: that selection stands.
    shown = actions.imagePlacement().key!;
    const other = { owner, instancePath: [], nodeId: gallery };
    beforeApply = async () => store.setState({ selection: other });
    expect(await actions.placeAsset(photo.id, shown)).toBe(true);
    expect(store.getState().selection).toBe(other);
  });

  it('puts the image in the slot a component’s design shows, not one it leaves out', async () => {
    const { owner, page } = await library();
    const section = (await write([{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }])).results![0].nodeId as string;
    const forked = (await write([{ type: 'component.fork', definitionId: (page().nodes[section] as InstanceNode).definitionId }])).results![0].definitionId as string;
    const design: OwnerRef = { kind: 'component', id: forked };
    const tree = () => session!.state.components[forked].tree!;
    const contentSlot = Object.values(tree().nodes).find((n) => n.kind === 'slot')!;
    const inner = Object.keys(tree().nodes).find((id) => (tree().nodes[id] as { children?: string[] }).children?.includes(contentSlot.id))!;
    // "content" stays declared first, but its place in the design is taken by a new "extras" slot.
    await write([
      { type: 'node.remove', owner: design, nodeId: contentSlot.id },
      { type: 'component.setSlot', definitionId: forked, slot: 'extras', label: 'Extras' },
      { type: 'node.insert', owner: design, parentId: inner, primitive: 'slot', bind: 'extras' }
    ]);
    expect(Object.keys(session!.state.components[forked].slots!)).toEqual(['content', 'extras']);
    expect((page().nodes[section] as InstanceNode).definitionId).toBe(forked);
    store.setState({ selection: { owner, instancePath: [], nodeId: section } });
    const p = actions.imagePlacement();
    expect(p.at).toMatchObject({ parentId: section, slot: 'extras' });
    expect(await actions.placeAsset(photo.id, p.key!)).toBe(true);
    expect((page().nodes[section] as InstanceNode).slots).toMatchObject({ extras: [placed(page(), photo.id)[0].id] });
  });

  it('stays a save in flight while it is planned again, so saving or leaving waits for it', async () => {
    const { owner, page, gallery } = await library();
    store.setState({ selection: { owner, instancePath: [], nodeId: gallery } });
    const shown = actions.imagePlacement().key!;
    beforeApply = () => write([{ type: 'asset.update', assetId: photo.id, name: 'Studio at dawn' }]);
    const during: number[] = [];
    onFetch = () => {
      during.push(savesInFlight(), store.getState().pendingSave);
      return snapshot();
    };
    expect(await actions.placeAsset(nook.id, shown)).toBe(true);
    expect(during).toHaveLength(2);
    expect(Math.min(...during)).toBeGreaterThan(0);
    expect(placed(page(), nook.id)).toHaveLength(1);
    await tick();
    expect(savesInFlight()).toBe(0);
    expect(store.getState().pendingSave).toBe(0);
  });

  it('lets a change already on its way land first, so the image gets the suggested alt text it sets', async () => {
    const { owner, page, gallery } = await library();
    store.setState({ selection: { owner, instancePath: [], nodeId: gallery } });
    const shown = actions.imagePlacement().key!;
    // A suggestion typed while the AI ran is checked before it is written, so its write goes out a moment after the
    // click that committed it.
    trackApply(
      (async () => {
        await new Promise((r) => setTimeout(r, 50));
        await write([{ type: 'asset.update', assetId: nook.id, altSuggestion: 'Armchair and bookshelves by a window' }]);
        return { ok: true };
      })()
    );
    expect(await actions.placeAsset(nook.id, shown)).toBe(true);
    expect(placed(page(), nook.id).map((n) => (n.image as ImageValue).alt)).toEqual(['Armchair and bookshelves by a window']);
  });

  it('places nothing once the project has been opened again, even when the old opening answers late', async () => {
    const { owner, page, gallery } = await library();
    store.setState({ selection: { owner, instancePath: [], nodeId: gallery } });
    const shown = actions.imagePlacement().key!;
    beforeApply = () => write([{ type: 'asset.update', assetId: photo.id, name: 'Studio at dawn' }]);
    // The project is opened again while the placement is planned again; the old opening's copy still arrives.
    onFetch = () => {
      const old = snapshot();
      opening++;
      publish();
      return old;
    };
    expect(await actions.placeAsset(nook.id, shown)).toBe(false);
    expect(placed(page(), nook.id)).toEqual([]);
    expect(applyCalls).toBe(1);
  });

  it('tells a save waiting on it when the project could not be checked again, and says so', async () => {
    const { owner, page, gallery } = await library();
    store.setState({ selection: { owner, instancePath: [], nodeId: gallery } });
    const shown = actions.imagePlacement().key!;
    beforeApply = () => write([{ type: 'asset.update', assetId: photo.id, name: 'Studio at dawn' }]);
    let release!: () => void;
    // The project's own copy is slow to come, then cannot be had.
    onFetch = () => {
      throw new Error('The project could not be read.');
    };
    const fetched = new Promise<void>((r) => (release = r));
    const fetching = onFetch;
    onFetch = () => {
      release();
      return fetching!();
    };
    const placing = actions.placeAsset(nook.id, shown);
    await fetched;
    const saving = settle({ blur: () => undefined, wait: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) });
    expect(await placing).toBe(false);
    const { problems, finish } = await saving;
    finish();
    const message = 'The image was not placed: the project could not be checked again. Try placing it again.';
    expect(problems).toEqual([message]);
    expect(lastToast()).toMatchObject({ kind: 'error', text: message });
    expect(placed(page(), nook.id)).toEqual([]);
  });
});

describe('reviewing a phone photo before it is placed (issue #230)', () => {
  const heic = { action: 'convert', format: 'HEIC', width: 3024, height: 4032, copy: { format: 'JPEG', width: 1920, height: 2560 } };
  /** The review the author is looking at, once it is on screen. */
  async function shownReview() {
    for (let i = 0; i < 50 && store.getState().modal?.kind !== 'import-review'; i++) await tick();
    const modal = store.getState().modal;
    expect(modal?.kind).toBe('import-review');
    return modal as { kind: 'import-review'; id: number; opening: string };
  }

  it('owes nothing while the review is open, and imports nothing when it is dismissed', async () => {
    const { a, image, field } = await setup();
    reviewRow = heic;
    const run = beginImport(field(a));
    await shownReview();
    // Leaving the project now must not wait on a question the author has not answered.
    expect(store.getState().pendingSave).toBe(0);
    expect(savesInFlight()).toBe(0);
    store.setState({ modal: null });
    expect(await run).toEqual({ kind: 'none' });
    expect(importing).toBeNull();
    expect(image(a).assetId).toBeNull();
  });

  it('imports the converted photo once confirmed, in the opening it was reviewed in, and places it', async () => {
    const { a, image, field } = await setup();
    reviewRow = heic;
    const run = beginImport(field(a));
    const modal = await shownReview();
    expect(modal.opening).toBe(key());
    review.settleImportReview(modal.id, new Set());
    for (let i = 0; i < 50 && !importing; i++) await tick();
    // From the moment the author confirms, a placement is owed.
    expect(store.getState().pendingSave).toBe(1);
    expect(importing!.choices).toEqual({ opening: key(), files: [{ path: '/photos/studio-at-sunrise.png', fingerprint: 'sha:/photos/studio-at-sunrise.png', webCopy: true }] });
    await importing!.release();
    expect(await run).toEqual({ kind: 'placed', assetId: photo.id });
    expect(image(a).assetId).toBe(photo.id);
    expect(kinds).toEqual(['review:image', 'import:image']);
  });

  it('imports nothing, and takes the review off screen, when the author starts leaving the project', async () => {
    const { a, field } = await setup();
    reviewRow = heic;
    const run = beginImport(field(a));
    await shownReview();
    store.setState({ leaving: true } as Partial<StoreState>);
    expect(await run).toEqual({ kind: 'none' });
    expect(store.getState().modal).toBeNull();
    expect(importing).toBeNull();
    store.setState({ leaving: false } as Partial<StoreState>);
  });

  it('never takes the place of another dialog opened while the files were read, and says to add them again', async () => {
    const { a, field } = await setup();
    reviewRow = heic;
    const find = { kind: 'find' };
    store.setState({ modal: find });
    expect(await beginImport(field(a))).toEqual({ kind: 'none' });
    expect(store.getState().modal).toBe(find);
    expect(importing).toBeNull();
    expect(lastToast()?.text).toBe('The files were not added because another dialog is open. Add them again once it is closed.');
  });

  it('imports nothing when the project is closed or opened again while the review is open', async () => {
    const { a, field } = await setup();
    reviewRow = heic;
    const run = beginImport(field(a));
    await shownReview();
    opening = 2;
    publish();
    expect(await run).toEqual({ kind: 'none' });
    expect(importing).toBeNull();
    // The next opening never finds the old review on screen.
    expect(store.getState().modal).toBeNull();
  });

  it('adds nothing, and owes nothing, when the only photo chosen can’t be converted here', async () => {
    const { a, image, field } = await setup();
    reviewRow = { action: 'refuse', format: 'HEIC', reason: 'it is a HEIC photo, which browsers can’t show, and this computer has no converter for it.' };
    const run = beginImport(field(a));
    const modal = await shownReview();
    review.settleImportReview(modal.id, new Set());
    for (let i = 0; i < 50 && !importing; i++) await tick();
    expect(importing!.paths).toEqual([]);
    await importing!.release([]);
    expect(await run).toEqual({ kind: 'none' });
    expect(image(a).assetId).toBeNull();
    expect(reviews).toBe(1);
  });
});

