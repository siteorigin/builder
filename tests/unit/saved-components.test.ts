/**
 * The personal component library (#372): a component saved from one project is kept on this computer and inserted
 * into another in one click, imported and placed as one change that one Undo takes back. Listing never reads a
 * package; a saved component that would bring code into the project open is marked so Insert hides it without
 * Developer mode, and inserting one always asks first, whatever its card says.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SavedInsertPlace } from '@shared/api';

/** A stand-in for Electron's utility process (the preview's worker) that starts at once and exits when asked to stop. */
class FakeWorker extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exited = false;
  postMessage(m: { type: string }) {
    if (m.type === 'start') queueMicrotask(() => this.emit('message', { type: 'ready', url: 'http://127.0.0.1:1' }));
    if (m.type === 'stop') this.kill();
  }
  kill() {
    if (this.exited) return true;
    this.exited = true;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

const env = vi.hoisted(() => ({ userData: '', answers: [] as number[], asked: [] as string[] }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: {
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBox: async (_w: unknown, o: { message: string }) => {
      env.asked.push(o.message);
      return { response: env.answers.shift() ?? 0 };
    }
  },
  utilityProcess: { fork: () => new FakeWorker() }
}));

const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { codeBrought, packagedDefinitions } = await import('@engine/component-package');
const { ProjectSession } = await import('../../src/main/project/session');
const { buildComponentPackage, preparePackageImport, readComponentPackage } = await import('../../src/main/project/component-package');
const { Controller } = await import('../../src/main/controller');
const { updateSettings } = await import('../../src/main/settings');
const store = await import('../../src/main/saved-components');

type Session = InstanceType<typeof ProjectSession>;
const openFile = fsp.open.bind(fsp);
const readFile = fsp.readFile.bind(fsp);

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
const controllers: Array<InstanceType<typeof Controller>> = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  env.answers = [];
  env.asked = [];
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const ok = <T extends { ok: boolean; error?: { message: string } }>(r: T): T => {
  expect(r.ok, r.error?.message).toBe(true);
  return r;
};
const home = (s: { state: { site: { homePageId: string } } }) => ({ kind: 'page' as const, id: s.state.site.homePageId });
const blank = (name: string, themeId?: string) => {
  const st = createStarterState('blank', name, false);
  return themeId ? applyOperations(st, [{ type: 'theme.apply', themeId }]).state : st;
};

/** A "Pricing card" section of the project's own holding a "Plan title" heading component, on a blank site's home page. */
async function pricingCard(): Promise<{ s: Session; rootId: string; childId: string }> {
  const s = await ProjectSession.create(tmp('so-lib-src-'), blank('Source'));
  const owner = home(s);
  const section = ok(await s.apply({ operations: [{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }] }, { label: 'Insert' })).results![0].nodeId as string;
  const heading = ok(await s.apply({ operations: [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'heading', text: 'Pro plan' }] }, { label: 'Fill' })).results![0].nodeId as string;
  const childId = ok(await s.apply({ operations: [{ type: 'component.createFromNode', owner, nodeId: heading, name: 'Plan title' }] }, { label: 'Create' })).results![0].definitionId as string;
  const rootId = ok(await s.apply({ operations: [{ type: 'component.createFromNode', owner, nodeId: section, name: 'Pricing card' }] }, { label: 'Create' })).results![0].definitionId as string;
  return { s, rootId, childId };
}

/** What saving a component writes, as the controller makes it. */
async function saveInput(s: Session, defId: string) {
  const { text, pkg } = await buildComponentPackage(s.dir, s.state, defId, 'SiteOrigin Builder test');
  return { text, name: s.state.components[defId].name, role: 'section' as const, definitions: packagedDefinitions(pkg.definitions), from: 'Source', origin: { projectId: s.state.manifest.projectId, definitionId: defId } };
}

/** Everything one import-and-place must leave as it was when it is refused, or put back when it is undone. */
const documents = (s: Session) => structuredClone({ components: s.state.components, tokens: s.state.tokens, assets: s.state.assets, pages: s.state.pages });

describe('the personal library on disk', () => {
  it('saves, lists by name without reading packages, replaces a component saved again, and removes', async () => {
    const root = join(tmp('so-lib-'), 'saved-components');
    const { s, rootId, childId } = await pricingCard();
    const first = await store.saveToLibrary(root, await saveInput(s, rootId));
    expect(first.replaced).toBe(false);
    const title = await store.saveToLibrary(root, { ...(await saveInput(s, childId)), role: 'element' });
    expect((await store.listSaved(root)).map((c) => [c.name, c.role])).toEqual([
      ['Plan title', 'element'],
      ['Pricing card', 'section']
    ]);
    // Renamed and saved again, it replaces its earlier copy rather than adding another.
    ok(await s.apply({ operations: [{ type: 'component.rename', definitionId: rootId, name: 'Pro card' }] }, { label: 'Rename' }));
    const again = await store.saveToLibrary(root, await saveInput(s, rootId));
    expect(again).toMatchObject({ replaced: true, card: { id: first.card.id, name: 'Pro card' } });
    expect((await store.listSaved(root)).map((c) => c.name)).toEqual(['Plan title', 'Pro card']);
    // The package is the file Export writes, read back through the package checks.
    expect(again.card.digest).not.toBe(first.card.digest);
    expect((await readComponentPackage(store.savedPackagePath(root, again.card))).definitions.find((d) => d.id === rootId)?.name).toBe('Pro card');
    // Listing reads cards alone, never a package (which may hold megabytes of images).
    const opened: string[] = [];
    const open = vi.spyOn(fsp, 'open').mockImplementation(((...args: Parameters<typeof fsp.open>) => (opened.push(String(args[0])), openFile(...args))) as typeof fsp.open);
    const read = vi.spyOn(fsp, 'readFile').mockImplementation(((...args: Parameters<typeof fsp.readFile>) => (opened.push(String(args[0])), readFile(...args))) as typeof fsp.readFile);
    writeFileSync(store.savedPackagePath(root, title.card), 'not a package');
    expect((await store.listSaved(root)).map((c) => c.name)).toEqual(['Plan title', 'Pro card']);
    open.mockRestore();
    read.mockRestore();
    expect(opened.filter((f) => f.endsWith('.socomponent.json'))).toEqual([]);
    expect(opened.filter((f) => f.endsWith('.card.json'))).toHaveLength(2);
    // A copy saved since the list was shown is never the one removed.
    expect(await store.removeSaved(root, again.card.id, first.card.digest)).toBe('changed');
    expect(await store.removeSaved(root, title.card.id, title.card.digest)).toBe('removed');
    expect(await store.removeSaved(root, title.card.id)).toBe('gone');
    expect((await store.listSaved(root)).map((c) => c.name)).toEqual(['Pro card']);
    // Only the copy its card names is kept.
    expect(readdirSync(root).sort()).toEqual([`${again.card.id}.${again.card.digest}.socomponent.json`, `${again.card.id}.card.json`].sort());
    await s.close();
  });

  it('leaves out damaged cards, cards whose package has gone, and files that are not saved components', async () => {
    const root = join(tmp('so-lib-'), 'saved-components');
    expect(await store.listSaved(root)).toEqual([]);
    const { s, rootId, childId } = await pricingCard();
    const kept = await store.saveToLibrary(root, await saveInput(s, rootId));
    const orphan = await store.saveToLibrary(root, await saveInput(s, childId));
    rmSync(store.savedPackagePath(root, orphan.card));
    writeFileSync(join(root, 'sc_damaged00000000.card.json'), '{ not json');
    writeFileSync(join(root, 'sc_damaged00000000.socomponent.json'), '{}');
    const card = JSON.parse(readFileSync(join(root, `${kept.card.id}.card.json`), 'utf8'));
    // A card copied under another ID, with a package of that ID beside it: it still names the component it was saved for.
    writeFileSync(join(root, 'sc_otherid000000000.card.json'), JSON.stringify(card));
    writeFileSync(join(root, `sc_otherid000000000.${card.digest}.socomponent.json`), '{}');
    writeFileSync(join(root, 'notes.card.json'), JSON.stringify({ ...card, id: 'notes' }));
    mkdirSync(join(root, 'sc_folder000000000.card.json'));
    expect((await store.listSaved(root)).map((c) => c.id)).toEqual([kept.card.id]);
    expect(await store.findSaved(root, orphan.card.id)).toBeNull();
    expect(await store.findSaved(root, '../settings')).toBeNull();
    expect(() => store.packagePath(root, '../../settings', kept.card.digest)).toThrow();
    expect(() => store.packagePath(root, kept.card.id, '../x')).toThrow();
    await s.close();
  });

  it('keeps the saved copy whole when a save stops part way, or is refused', async () => {
    const root = join(tmp('so-lib-'), 'saved-components');
    const { s, rootId } = await pricingCard();
    const first = (await store.saveToLibrary(root, await saveInput(s, rootId))).card;
    // A newer package written but its card never: the card still names the copy it describes.
    const stray = join(root, `${first.id}.${'f'.repeat(24)}.socomponent.json`);
    writeFileSync(stray, 'a newer copy, cut short');
    expect((await store.listSaved(root)).map((c) => [c.name, c.digest])).toEqual([['Pricing card', first.digest]]);
    expect((await store.findSaved(root, first.id))?.digest).toBe(first.digest);
    expect((await readComponentPackage(store.savedPackagePath(root, first))).rootId).toBe(rootId);
    // A card this app couldn't read back is refused before anything is replaced.
    const input = await saveInput(s, rootId);
    const many = Array.from({ length: 61 }, (_, i) => ({ ...input.definitions[0], id: `d${i}` }));
    await expect(store.saveToLibrary(root, { ...input, name: 'Too big', definitions: many })).rejects.toThrow(/more components/);
    expect((await store.listSaved(root)).map((c) => [c.name, c.digest])).toEqual([['Pricing card', first.digest]]);
    // The next save sweeps what no card names, and a copy it can't tidy away doesn't fail the save.
    const stuck = join(root, `${first.id}.${'e'.repeat(24)}.socomponent.json`);
    mkdirSync(join(stuck, 'inside'), { recursive: true });
    const rmFile = fsp.rm.bind(fsp);
    const rm = vi.spyOn(fsp, 'rm').mockImplementation(((path: Parameters<typeof fsp.rm>[0], o?: Parameters<typeof fsp.rm>[1]) => (String(path) === stuck ? Promise.reject(new Error('EBUSY')) : rmFile(path, o))) as typeof fsp.rm);
    const next = (await store.saveToLibrary(root, { ...input, name: 'Pricing card 2' })).card;
    rm.mockRestore();
    expect((await store.listSaved(root)).map((c) => [c.name, c.digest])).toEqual([['Pricing card 2', next.digest]]);
    rmSync(stuck, { recursive: true });
    expect((await store.removeSaved(root, next.id, next.digest))).toBe('removed');
    expect(readdirSync(root)).toEqual([]);
    // A card that is there but can't be read keeps every copy, whatever a stale menu asks.
    const again = (await store.saveToLibrary(root, input)).card;
    writeFileSync(join(root, `${again.id}.card.json`), '{ cut short');
    expect(await store.removeSaved(root, again.id, first.digest)).toBe('changed');
    expect(readdirSync(root)).toContain(`${again.id}.${again.digest}.socomponent.json`);
    await s.close();
  });

  it('accepts only a plain place to insert at', () => {
    const place: SavedInsertPlace = { owner: { kind: 'page', id: 'p_home' }, parentId: 'n_abc', slot: 'content', index: 2 };
    expect(store.readInsertPlace(place)).toEqual(place);
    expect(store.readInsertPlace({ owner: { kind: 'page', id: 'p_home' }, parentId: null })).toEqual({ owner: { kind: 'page', id: 'p_home' }, parentId: null });
    // Any page a project can hold, as an ordinary insert takes it.
    expect(store.readInsertPlace({ owner: { kind: 'page', id: '-landing' }, parentId: null })).toEqual({ owner: { kind: 'page', id: '-landing' }, parentId: null });
    expect(store.readInsertPlace({ owner: { kind: 'component', id: 'code.card-abcde' }, parentId: 'n_root' })).toMatchObject({ owner: { kind: 'component', id: 'code.card-abcde' } });
    // Never the shared header or footer, a reserved name, or anything that isn't a place.
    for (const bad of [null, {}, { owner: { kind: 'shell', id: 'header' }, parentId: null }, { owner: { kind: 'disk', id: 'x' }, parentId: null }, { owner: { kind: 'page', id: '__proto__' }, parentId: null }, { ...place, index: -1 }, { ...place, index: 1.5 }, { ...place, slot: 4 }, { ...place, parentId: undefined }])
      expect(store.readInsertPlace(bad)).toBeNull();
  });
});

describe('whether a saved component brings code', () => {
  it('depends on the project: a theme component the theme there has unchanged is no code of the project’s own', async () => {
    const s = await ProjectSession.create(tmp('so-lib-src-'), blank('Source'));
    const owner = home(s);
    const section = ok(await s.apply({ operations: [{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }] }, { label: 'Insert' })).results![0].nodeId as string;
    ok(await s.apply({ operations: [{ type: 'node.insert', owner, parentId: section, slot: 'content', componentId: 'media.video' }] }, { label: 'Video' }));
    const withVideo = ok(await s.apply({ operations: [{ type: 'component.createFromNode', owner, nodeId: section, name: 'Video band' }] }, { label: 'Create' })).results![0].definitionId as string;
    const badge = ok(await s.apply({ operations: [{ type: 'component.createCode', name: 'Badge', source: '<span class="badge">New</span>\n' }] }, { label: 'Create', codeAllowed: true })).results![0].definitionId as string;
    const video = packagedDefinitions((await buildComponentPackage(s.dir, s.state, withVideo)).pkg.definitions);
    expect(video.some((d) => d.kind === 'code' && d.owner === 'theme')).toBe(true);
    // The same theme has that video, and the Section around it (both code components): nothing of the project's own.
    // A theme without them gets each as code.
    expect(codeBrought(blank('Same theme'), video)).toEqual([]);
    expect(codeBrought(blank('Other theme', 'foundation-alt'), video).map((d) => [d.kind, d.id]).sort()).toEqual([
      ['code', 'foundation.layout.section'],
      ['code', 'foundation.media.video']
    ]);
    // Code of the project's own is code wherever it goes.
    const own = packagedDefinitions((await buildComponentPackage(s.dir, s.state, badge)).pkg.definitions);
    expect(codeBrought(blank('Same theme'), own).map((d) => d.name)).toEqual(['Badge']);
    await s.close();
  });

  it('lists a component that its design places and its dependencies name only once', async () => {
    const { s, rootId, childId } = await pricingCard();
    const defs = (await buildComponentPackage(s.dir, s.state, rootId)).pkg.definitions.map((d) => (d.id === rootId ? { ...d, dependencies: [childId] } : d));
    expect(packagedDefinitions(defs).find((d) => d.id === rootId)?.needs.filter((n) => n === childId)).toEqual([childId]);
    await s.close();
  });
});

describe('importing and placing in one change', () => {
  /** Import a saved package into `dest`, placed at `place` as `role`, as the controller does. */
  async function insertInto(dest: Session, path: string, place: SavedInsertPlace, role: 'section' | 'element', revision?: number) {
    const pkg = await readComponentPackage(path);
    const prepared = await preparePackageImport(dest.dir, dest.state, pkg, { codeAllowed: false });
    prepared.input.place = { ...place, role, nodeId: 'n_placed01' };
    return dest.apply({ operations: [...prepared.assets, { type: 'component.import', importId: prepared.input.id }], ...(revision === undefined ? {} : { expectedRevision: revision }) }, { label: 'Insert', source: 'user', codeAllowed: false, componentImport: prepared.input });
  }

  it('places a section among the page’s sections and an element in a new section of its own, each undone in one step', async () => {
    const root = join(tmp('so-lib-'), 'saved-components');
    const { s, rootId, childId } = await pricingCard();
    const card = (await store.saveToLibrary(root, await saveInput(s, rootId))).card;
    const title = (await store.saveToLibrary(root, { ...(await saveInput(s, childId)), role: 'element' })).card;
    await s.close();

    const dest = await ProjectSession.create(tmp('so-lib-dest-'), blank('Destination'));
    const owner = home(dest);
    const before = documents(dest);
    const entries = dest.historyInfo().entries.length;
    const r = ok(await insertInto(dest, store.savedPackagePath(root, card), { owner, parentId: null }, 'section', dest.revision));
    const last = r.results!.at(-1)!;
    expect(last.nodeId).toBe('n_placed01');
    const placed = dest.state.pages[owner.id].nodes.n_placed01;
    expect(placed).toMatchObject({ kind: 'instance', definitionId: last.definitionId });
    expect(dest.state.pages[owner.id].rootIds).toContain('n_placed01');
    expect(dest.state.components[last.definitionId as string]).toMatchObject({ owner: 'project', name: 'Pricing card' });
    expect(dest.historyInfo().entries.length).toBe(entries + 1);
    ok(await dest.undo());
    expect(documents(dest)).toEqual(before);

    // An element dropped straight onto the page goes in a section of its own, as Insert's tiles put one.
    const el = ok(await insertInto(dest, store.savedPackagePath(root, title), { owner, parentId: null }, 'element'));
    const tree = dest.state.pages[owner.id];
    const wrapper = tree.nodes[tree.rootIds.at(-1)!];
    expect(wrapper).toMatchObject({ kind: 'instance', definitionId: 'foundation.layout.section' });
    expect((wrapper as { slots: Record<string, string[]> }).slots.content).toEqual(['n_placed01']);
    expect(tree.nodes.n_placed01).toMatchObject({ kind: 'instance', definitionId: el.results!.at(-1)!.definitionId });
    ok(await dest.undo());
    expect(documents(dest)).toEqual(before);
    await dest.close();
  });

  it('lands nothing when the place is gone or the project moved on', async () => {
    const root = join(tmp('so-lib-'), 'saved-components');
    const { s, rootId } = await pricingCard();
    const card = (await store.saveToLibrary(root, await saveInput(s, rootId))).card;
    await s.close();
    const dest = await ProjectSession.create(tmp('so-lib-dest-'), blank('Destination'));
    const before = documents(dest);
    const revision = dest.revision;
    const gone = await insertInto(dest, store.savedPackagePath(root, card), { owner: home(dest), parentId: 'n_missing' }, 'element');
    expect(gone.ok).toBe(false);
    const stale = await insertInto(dest, store.savedPackagePath(root, card), { owner: home(dest), parentId: null }, 'section', revision - 1);
    expect(stale.error?.code).toBe('STALE_REVISION');
    expect(documents(dest)).toEqual(before);
    expect(dest.revision).toBe(revision);
    await dest.close();
  });
});

describe('the library through the app (#372)', () => {
  /** A project folder made from `state`, closed, ready for the Controller to open. */
  async function projectFolder(state: ReturnType<typeof blank>): Promise<string> {
    const dir = tmp('so-lib-project-');
    await (await ProjectSession.create(dir, state)).close();
    return dir;
  }

  async function opened(dir: string) {
    const c = new Controller(() => null);
    c.send = () => undefined;
    controllers.push(c);
    expect((await c.trustAndOpen(dir)).ok).toBe(true);
    return c;
  }

  it('neither exports nor saves code another project would refuse, keeping the copy saved before (#1417)', async () => {
    env.userData = tmp('so-lib-userdata-');
    await updateSettings({ developerMode: true });
    const properties = { heading: { type: 'string', label: 'Heading', default: 'Hello' } };
    const made = applyOperations(blank('Studio A'), [{ type: 'component.createCode', name: 'Shore window', source: `<script>\n  let { heading = 'Hello' } = $props();\n</script>\n\n<h3>{heading}</h3>\n`, properties }]);
    const id = made.results[0].definitionId as string;
    const a = await opened(await projectFolder(made.state));
    const first = await a.saveComponentToLibrary(id, a.openingKey!);
    expect(first).toMatchObject({ ok: true, name: 'Shore window' });
    const library = join(env.userData, 'saved-components');
    const files = () => readdirSync(library, { recursive: true }).map(String).sort().map((f) => [f, readFileSync(join(library, f), 'utf8')]);
    const before = await store.listSaved(library);
    const kept = files();
    // A default the author's project only warns about: a project importing the package refuses it.
    ok(await a.session!.apply({ operations: [{ type: 'component.updateSource', definitionId: id, source: `<script>\n  let { heading = 'Choose a short shore window' } = $props();\n</script>\n\n<h3>{heading}</h3>\n` }] }, { label: 'Edit', codeAllowed: true }));
    const resaved = await a.saveComponentToLibrary(id, a.openingKey!);
    expect(resaved.ok).toBe(false);
    expect(resaved.message).toMatch(/^“Shore window” was not saved to your library: another project would refuse it on import\. .*line 2: The code's default for heading/);
    expect(await store.listSaved(library)).toEqual(before);
    expect(files()).toEqual(kept);
    const file = join(tmp('so-lib-export-'), 'shore.socomponent.json');
    const exported = await a.exportComponent(id, file);
    expect(exported.ok).toBe(false);
    expect(exported.message).toMatch(/^“Shore window” was not exported: another project would refuse it on import\./);
    expect(readdirSync(join(file, '..'))).toEqual([]);
    await a.close();
  });

  it('saves in one project and inserts in another, asking before any code comes in, whatever was saved', async () => {
    env.userData = tmp('so-lib-userdata-');
    await updateSettings({ developerMode: true });
    // Project A: a managed card and a code badge.
    const a0 = blank('Studio A');
    const homeA = { kind: 'page' as const, id: a0.site.homePageId };
    const sec = applyOperations(a0, [{ type: 'node.insert', owner: homeA, parentId: null, componentId: 'layout.section' }]);
    const sectionId = sec.results[0].nodeId as string;
    const made = applyOperations(sec.state, [
      { type: 'component.createFromNode', owner: homeA, nodeId: sectionId, name: 'Feature band' },
      { type: 'component.createCode', name: 'Badge', source: '<span class="badge">New</span>\n' }
    ]);
    const [bandId, badgeId] = made.results.map((r) => r.definitionId as string);
    // A band holding the theme's video: code of the theme's, which a project on the same theme already has.
    const vsec = applyOperations(made.state, [{ type: 'node.insert', owner: homeA, parentId: null, componentId: 'layout.section' }]);
    const vid = applyOperations(vsec.state, [{ type: 'node.insert', owner: homeA, parentId: vsec.results[0].nodeId as string, slot: 'content', componentId: 'media.video' }]);
    const withVideo = applyOperations(vid.state, [{ type: 'component.createFromNode', owner: homeA, nodeId: vsec.results[0].nodeId as string, name: 'Video band' }]);
    const videoId = withVideo.results[0].definitionId as string;
    const a = await opened(await projectFolder(withVideo.state));
    const saved = await a.saveComponentToLibrary(bandId, a.openingKey!);
    expect(saved).toMatchObject({ ok: true, name: 'Feature band', replaced: false });
    expect(await a.saveComponentToLibrary(badgeId, a.openingKey!)).toMatchObject({ ok: true, name: 'Badge' });
    expect(await a.saveComponentToLibrary(videoId, a.openingKey!)).toMatchObject({ ok: true, name: 'Video band' });
    expect(await a.saveComponentToLibrary(bandId, 'another opening')).toMatchObject({ ok: false });
    await a.close();

    // Project B lists both, the badge marked as code.
    const b = await opened(await projectFolder(blank('Studio B')));
    const s = b.session!;
    const list = await b.savedComponents(b.openingKey!);
    // Whether each brings code is worked out for Studio B: the theme's video is no code of its own there.
    expect(list.map((c) => [c.name, c.code, c.role, c.from])).toEqual([
      ['Badge', true, 'section', 'Studio A'],
      ['Feature band', false, 'section', 'Studio A'],
      ['Video band', false, 'section', 'Studio A']
    ]);
    const band = list.find((c) => c.name === 'Feature band')!;
    const badge = list.find((c) => c.name === 'Badge')!;
    expect(await b.savedComponents('another opening')).toEqual([]);

    // A managed one goes in at once, imported and placed as one change.
    const place: SavedInsertPlace = { owner: home(s), parentId: null };
    const entries = s.historyInfo().entries.length;
    const r = await b.insertSavedComponent(band.id, band.digest, place, b.openingKey!, s.revision);
    expect(r).toMatchObject({ ok: true, name: 'Feature band' });
    expect(s.state.pages[place.owner.id].nodes[r.nodeId!]).toMatchObject({ kind: 'instance', definitionId: r.definitionId });
    expect(s.historyInfo().entries.length).toBe(entries + 1);
    expect(env.asked).toEqual([]);
    // Out of date: the project has moved on since the place was worked out.
    expect(await b.insertSavedComponent(band.id, band.digest, place, b.openingKey!, s.revision - 1)).toMatchObject({ ok: false, message: expect.stringMatching(/changed/) });
    // Nor a revision the project hasn't reached, even code it would ask about: refused before anything is asked.
    expect(await b.insertSavedComponent(badge.id, badge.digest, place, b.openingKey!, s.revision + 1)).toMatchObject({ ok: false, message: expect.stringMatching(/changed/) });
    expect(env.asked).toEqual([]);
    // A copy other than the one listed is never inserted: the list is out of date.
    expect(await b.insertSavedComponent(band.id, 'f'.repeat(24), place, b.openingKey!, s.revision)).toMatchObject({ ok: false, gone: true });

    // Code asks first, every time; Cancel lands nothing.
    const before = s.revision;
    env.answers = [0];
    expect(await b.insertSavedComponent(badge.id, badge.digest, place, b.openingKey!, s.revision)).toEqual({ ok: false });
    expect(env.asked).toEqual(['“Badge” includes code']);
    expect(s.revision).toBe(before);
    // A card edited to say it has no code changes nothing: the package is what is checked.
    const root = join(env.userData, 'saved-components');
    const cardFile = join(root, `${badge.id}.card.json`);
    const card = JSON.parse(readFileSync(cardFile, 'utf8'));
    writeFileSync(cardFile, JSON.stringify({ ...card, definitions: card.definitions.map((d: { kind: string }) => ({ ...d, kind: 'managed' })) }));
    expect((await b.savedComponents(b.openingKey!)).find((c) => c.id === badge.id)?.code).toBe(false);
    env.answers = [1];
    const code = await b.insertSavedComponent(badge.id, badge.digest, place, b.openingKey!, s.revision);
    expect(code).toMatchObject({ ok: true, name: 'Badge' });
    expect(env.asked).toHaveLength(2);
    expect(s.state.components[code.definitionId!]).toMatchObject({ kind: 'code', owner: 'project' });

    // Without Developer mode, code is refused before anything is asked.
    await updateSettings({ developerMode: false });
    expect(await b.insertSavedComponent(badge.id, badge.digest, place, b.openingKey!, s.revision)).toMatchObject({ ok: false, message: expect.stringMatching(/Developer mode/) });
    expect(env.asked).toHaveLength(2);

    // Gone from the library: the list is out of date.
    expect(await b.removeSavedComponent(band.id, band.digest)).toBe('removed');
    expect(await b.insertSavedComponent(band.id, band.digest, place, b.openingKey!, s.revision)).toMatchObject({ ok: false, gone: true });
  });
});
