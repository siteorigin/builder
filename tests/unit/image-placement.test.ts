import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectSnapshot } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import type { AssetRecord, ImageValue, InstanceNode, OwnerRef } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { ProjectSession } from '../../src/main/project/session';
import { resetPendingForTests, savesInFlight } from '../../src/renderer/src/lib/pending';

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
}
interface StoreModule {
  applyOps(operations: EditOperation[], label: string, coalesceKey?: string): Promise<unknown>;
  applyWith(edit: undefined, operations: EditOperation[], label: string, coalesceKey?: string): Promise<unknown>;
  getState(): StoreState;
  setState(patch: Partial<StoreState>): void;
}
type PlaceResult = { kind: 'none' } | { kind: 'placed' | 'kept'; assetId: string };
interface PlaceModule {
  importAndPlace(opts: { paths?: string[]; base: ProjectSnapshot | null; place: (asset: AssetRecord) => unknown; shown: () => boolean }): Promise<PlaceResult>;
  SHOW_ASSET_EVENT: string;
}

let store: StoreModule;
let place: PlaceModule;
let session: ProjectSession | null = null;
let opening = 1;
let aiBusy = false;
const dirs: string[] = [];
const events: Array<{ type: string; detail: unknown }> = [];
let applyCalls = 0;
/** Writes that reach the session without the renderer hearing of them yet (it is behind). */
let quiet = false;
/** Runs once, just before the next write from the renderer reaches the session: something that lands meanwhile. */
let beforeApply: (() => Promise<unknown>) | null = null;
/** The import the author started, released by the test: the picture is still being copied until then. */
let importing: { paths?: string[]; release: (assetIds?: string[]) => Promise<void> } | null = null;

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
        snapshot: async () => snapshot(),
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
          if (r.ok) publish();
          return r;
        },
        importAssets: (paths?: string[]) =>
          new Promise((resolve) => {
            importing = {
              paths,
              // The file is copied and its record saved, then the main process answers with the new asset's ID.
              release: async (assetIds) => {
                const ids = assetIds ?? [(await write([{ type: 'asset.add', asset: photo }], 'Import images')) && photo.id];
                resolve({ ok: true, assetIds: ids });
              }
            };
          })
      }
    }
  };
  store = (await import(/* @vite-ignore */ '../../src/renderer/src/store')) as StoreModule;
  place = (await import(/* @vite-ignore */ '../../src/renderer/src/lib/place')) as PlaceModule;
});

afterEach(async () => {
  await session?.close().catch(() => undefined);
  session = null;
  importing = null;
  opening = 1;
  aiBusy = false;
  quiet = false;
  beforeApply = null;
  applyCalls = 0;
  events.length = 0;
  resetPendingForTests();
  store.setState({ snapshot: null, pendingSave: 0, toasts: [], selection: null, leftTab: 'pages' });
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

/** Choose image → Import on one hero: what the image editor does, with the handler and project it shows now. */
function startImport(write: (v: ImageValue) => void, opts: { shown?: () => boolean; start?: ImageValue } = {}) {
  const start = opts.start ?? { assetId: null, alt: '' };
  const base = store.getState().snapshot;
  const run = place.importAndPlace({
    base,
    shown: opts.shown ?? (() => false),
    place: (asset) => {
      if (asset.id === start.assetId) return;
      write({ assetId: asset.id, alt: asset.altSuggestion || start.alt || '', decorative: start.decorative });
    }
  });
  expect(importing).not.toBeNull();
  return run;
}

const lastToast = () => store.getState().toasts.at(-1);
/** A save in flight is let go once its outcome has been reported, a turn after the work itself ends. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('placing an imported image (issue #262)', () => {
  it('places it in the hero the import began from after the author selects another hero', async () => {
    const { a, b, owner, image, field } = await setup();
    const run = startImport(field(a));
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
    const run = startImport(field(a), { shown: () => true });
    await importing!.release();
    expect(await run).toEqual({ kind: 'placed', assetId: photo.id });
    expect(image(a).assetId).toBe(photo.id);
    expect(store.getState().toasts).toEqual([]);
  });

  it('keeps the image in Assets and says why when the hero was edited meanwhile, with a way to find it', async () => {
    const { a, b, owner, image, field } = await setup();
    const run = startImport(field(a));
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
    const run = startImport(field(a));
    await write([{ type: 'node.remove', owner, nodeId: a }]);
    await importing!.release();
    expect(await run).toEqual({ kind: 'kept', assetId: photo.id });
    expect(lastToast()).toMatchObject({ kind: 'error', text: '“Studio at sunrise.png” was added to Assets but not placed: the Split hero on Home was removed while it was being added.' });
    expect(lastToast()!.action?.label).toBe('Show image');
  });

  it('places it after an edit the window had not heard of yet, checking the field again first', async () => {
    const { a, b, owner, image, field } = await setup();
    const run = startImport(field(a));
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
    const run = startImport(field(a));
    beforeApply = () => write([{ type: 'instance.setProp', owner, nodeId: a, prop: 'image', value: { assetId: null, alt: 'Typed elsewhere' } }]);
    await importing!.release();
    expect(await run).toEqual({ kind: 'kept', assetId: photo.id });
    expect(image(a)).toEqual({ assetId: null, alt: 'Typed elsewhere' });
    expect(applyCalls).toBe(1);
  });

  it('places the second of two imports into the same hero only if the first did not', async () => {
    const { a, image, field } = await setup();
    const first = startImport(field(a));
    const firstImport = importing!;
    const second = startImport(field(a));
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
    const run = startImport(field(a));
    // The project was closed and opened again while the picture was copied.
    opening = 2;
    await importing!.release();
    expect(await run).toEqual({ kind: 'none' });
    expect(image(a).assetId).toBeNull();
    expect(applyCalls).toBe(0);
  });

  it('keeps the image and says so while the AI is making changes', async () => {
    const { a, image, field } = await setup();
    const run = startImport(field(a));
    // The AI started while the picture was being copied.
    aiBusy = true;
    publish();
    await importing!.release();
    expect(await run).toEqual({ kind: 'kept', assetId: photo.id });
    expect(image(a).assetId).toBeNull();
    expect(lastToast()!.text).toBe('“Studio at sunrise.png” was added to Assets but not placed: the AI is making changes.');
  });

  it('does nothing more when the field already holds that image', async () => {
    const { a, field, owner } = await setup();
    await write([{ type: 'asset.add', asset: photo }]);
    await write([{ type: 'instance.setProp', owner, nodeId: a, prop: 'image', value: { assetId: photo.id, alt: 'Here' } }]);
    const run = startImport(field(a), { start: { assetId: photo.id, alt: 'Here' } });
    await importing!.release([photo.id]);
    expect(await run).toEqual({ kind: 'placed', assetId: photo.id });
    expect(applyCalls).toBe(0);
    expect(store.getState().toasts).toEqual([]);
  });
});
