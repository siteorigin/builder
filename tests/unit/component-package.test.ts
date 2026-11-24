/**
 * Portable component packages (#371). A project component exported with everything it needs (the components it places
 * or imports, its site styles, its images) lands in another project as one undoable change, with every reference
 * pointing at something that project has. A package that is damaged, unsafe or doesn't compile changes nothing.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { VariantRequest } from '../../src/main/project/media-client';
import type { ComponentDefinition, ElementNode, InstanceNode, ProjectState } from '@shared/types';
import type { ComponentPackage } from '@shared/component-package';

/** The media worker, run in this process by the code the real worker runs. */
class InlineMediaWorker extends EventEmitter {
  postMessage(m: VariantRequest) {
    void import('../../src/main/project/image-variants').then(({ handleVariantRequest }) => handleVariantRequest(m)).then((r) => this.emit('message', r));
  }
  kill() {
    return true;
  }
}

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  utilityProcess: { fork: () => new InlineMediaWorker() }
}));

const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { validateState } = await import('@engine/validate');
const { generateProject } = await import('@generator/index');
const { decodeComponentPackage } = await import('@shared/component-package');
const { LATEST_SCHEMA_VERSION } = await import('@shared/migrations');
const { importAsset, stopMediaWorker } = await import('../../src/main/project/assets');
const { ProjectSession } = await import('../../src/main/project/session');
const { buildComponentPackage, preparePackageImport, readComponentPackage } = await import('../../src/main/project/component-package');

type Session = InstanceType<typeof ProjectSession>;

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
afterAll(() => stopMediaWorker());

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const home = (s: Session) => ({ kind: 'page' as const, id: s.state.site.homePageId });
const ok = <T extends { ok: boolean; error?: { message: string } }>(r: T): T => {
  expect(r.ok, r.error?.message).toBe(true);
  return r;
};

async function blank(name: string): Promise<Session> {
  return ProjectSession.create(tmp('so-pkg-'), createStarterState('blank', name, false));
}

/** Add a picture file to a project's library, as the importer does. */
async function addImage(s: Session, name: string, bytes: Buffer): Promise<string> {
  const file = join(tmp('so-pkg-src-'), name);
  writeFileSync(file, bytes);
  const { record } = await importAsset(s.dir, file, Object.values(s.state.assets.assets));
  ok(await s.apply({ operations: [{ type: 'asset.add', asset: record }] }, { label: 'Import image' }));
  return record.id;
}

const png = (color: string) => sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toBuffer();

/**
 * A "Pricing card" on a blank site: the theme's Section holding a "Plan title" component of the project's own (a
 * heading in the site's own Sea colour) and a picture from the library.
 */
async function pricingCard() {
  const s = await blank('Source');
  const owner = home(s);
  const imageId = await addImage(s, 'Waves.png', await png('#0a6e8a'));
  const token = ok(await s.apply({ operations: [{ type: 'token.create', group: 'color', label: 'Sea', value: '#0a6e8a' }] }, { label: 'Add style' })).results![0].tokenId as string;
  const section = ok(await s.apply({ operations: [{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }] }, { label: 'Insert' })).results![0].nodeId as string;
  const filled = ok(
    await s.apply(
      {
        operations: [
          { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'heading', text: 'Pro plan' },
          { type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'image' }
        ]
      },
      { label: 'Fill' }
    )
  );
  const [heading, image] = filled.results!.map((r) => r.nodeId as string);
  ok(
    await s.apply(
      {
        operations: [
          { type: 'node.setStyle', owner, nodeId: heading, scope: 'base', property: 'color', value: { token } },
          { type: 'node.setContent', owner, nodeId: image, field: 'image', value: { assetId: imageId, alt: 'Waves' } }
        ]
      },
      { label: 'Style' }
    )
  );
  const childId = ok(await s.apply({ operations: [{ type: 'component.createFromNode', owner, nodeId: heading, name: 'Plan title' }] }, { label: 'Create' })).results![0].definitionId as string;
  const rootId = ok(await s.apply({ operations: [{ type: 'component.createFromNode', owner, nodeId: section, name: 'Pricing card' }] }, { label: 'Create' })).results![0].definitionId as string;
  return { s, rootId, childId, token, imageId };
}

/** Export a component to a package file, and the file's path. */
async function exportTo(s: Session, defId: string): Promise<{ path: string; notes: string[] }> {
  const { text, notes } = await buildComponentPackage(s.dir, s.state, defId, 'SiteOrigin Builder test');
  const path = join(tmp('so-pkg-file-'), 'component.socomponent.json');
  writeFileSync(path, text);
  return { path, notes };
}

/** Import a package file into a project as the editor does, in one change. */
async function importInto(s: Session, path: string, opts: { codeAllowed?: boolean } = {}) {
  const pkg = await readComponentPackage(path);
  const prepared = await preparePackageImport(s.dir, s.state, pkg, { codeAllowed: opts.codeAllowed ?? true });
  return s.apply({ operations: [...prepared.assets, { type: 'component.import', importId: prepared.input.id }] }, { label: 'Import component', source: 'user', codeAllowed: opts.codeAllowed ?? true, componentImport: prepared.input });
}

/** What an import must leave untouched when it is refused. */
const snapshot = (s: Session) => JSON.stringify({ revision: s.revision, history: s.historyInfo(), components: s.state.components, tokens: s.state.tokens, assets: s.state.assets });

/** Every `{ token }` and asset ID a definition names. */
function refs(def: ComponentDefinition) {
  const tokens = new Set<string>();
  const assets = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o.token === 'string') tokens.add(o.token);
    if (typeof o.assetId === 'string') assets.add(o.assetId);
    Object.values(o).forEach(walk);
  };
  walk(def);
  return { tokens, assets };
}

/** A package with one code component and the given source, as a hand-written file would be. */
function codePackage(source: string, extra: Partial<ComponentPackage> = {}): string {
  const def = {
    schemaVersion: 1,
    id: 'code.card-abcde',
    componentId: 'project.card',
    contractVersion: 1,
    kind: 'code',
    owner: 'project',
    name: 'Card',
    description: 'A card.',
    category: 'custom',
    tags: [],
    properties: { title: { type: 'string', label: 'Title', default: 'Hello' } },
    parts: { root: { nodeId: 'root', label: 'Root' } },
    source,
    sourcePath: 'src/lib/siteorigin/custom/Card-abcde.svelte',
    license: 'Project'
  };
  return JSON.stringify({ format: 'siteorigin.component', version: 1, rootId: def.id, definitions: [def], tokens: [], images: [], ...extra });
}

const writePackage = (text: string) => {
  const path = join(tmp('so-pkg-file-'), 'hand.socomponent.json');
  writeFileSync(path, text);
  return path;
};

describe('component packages: export and import (#371)', () => {
  it('lands a managed component with a nested component, a theme section, a custom style and an image in a blank project, working, in one undoable step', async () => {
    const src = await pricingCard();
    const { path, notes } = await exportTo(src.s, src.rootId);
    expect(notes).toEqual([]);
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as ComponentPackage;
    // The component first, then what it needs, each once; its style and its picture travel with it.
    expect(pkg.rootId).toBe(src.rootId);
    expect(pkg.definitions.map((d) => d.id)).toEqual(expect.arrayContaining([src.rootId, src.childId, 'foundation.layout.section']));
    expect(new Set(pkg.definitions.map((d) => d.id)).size).toBe(pkg.definitions.length);
    expect(pkg.tokens.find((t) => t.id === src.token)).toMatchObject({ custom: true, value: '#0a6e8a', resolved: '#0a6e8a' });
    expect(pkg.images.map((i) => i.id)).toEqual([src.imageId]);

    const dest = await blank('Destination');
    const before = { components: structuredClone(dest.state.components), tokens: structuredClone(dest.state.tokens), assets: structuredClone(dest.state.assets), entries: dest.historyInfo() };
    const r = ok(await importInto(dest, path, { codeAllowed: false }));
    const rootId = r.results!.at(-1)!.definitionId as string;
    const root = dest.state.components[rootId];
    expect(root).toMatchObject({ name: 'Pricing card', owner: 'project', kind: 'managed' });
    expect(rootId).not.toBe(src.rootId);

    // The nested component is a new one of this project's, and the design places it, not the source's.
    const placed = Object.values(root.tree!.nodes).filter((n): n is InstanceNode => n.kind === 'instance');
    const child = placed.map((n) => dest.state.components[n.definitionId]).find((d) => d?.name === 'Plan title')!;
    expect(child).toBeDefined();
    expect(child.id).not.toBe(src.childId);
    expect(child.owner).toBe('project');
    expect(placed.every((n) => Object.hasOwn(dest.state.components, n.definitionId))).toBe(true);
    // The theme's own section is the destination theme's, installed as the theme has it.
    expect(dest.state.components['foundation.layout.section']?.owner).toBe('theme');

    // Every style and image named is one this project has, and the image's file is in its folder.
    const named = [root, child].map(refs);
    const tokens = new Set(named.flatMap((n) => [...n.tokens]));
    const assets = new Set(named.flatMap((n) => [...n.assets]));
    expect(tokens.has('color.custom-sea')).toBe(true);
    expect(dest.state.tokens.custom.find((t) => t.id === 'color.custom-sea')).toMatchObject({ label: 'Sea', value: '#0a6e8a' });
    expect(assets.size).toBe(1);
    const asset = dest.state.assets.assets[[...assets][0]];
    expect(asset).toMatchObject({ kind: 'image', name: 'Waves' });
    expect(sha(readFileSync(join(dest.dir, asset.file)))).toBe(asset.hash);
    expect(validateState(dest.state).filter((d) => d.severity === 'error')).toEqual([]);

    // It works: placed on a page, the site generates with its style and its picture.
    ok(await dest.apply({ operations: [{ type: 'node.insert', owner: home(dest), parentId: null, definitionId: rootId }] }, { label: 'Place' }));
    const files = generateProject(dest.state);
    expect([...files.values()].join('\n')).toContain('--so-color-custom-sea');
    expect([...files.values()].some((f) => f.includes(asset.file.replace(/^static/, '')))).toBe(true);

    // One step: undoing the placement and then the import leaves the project as it was.
    expect(dest.historyInfo().canUndo).toBe(true);
    await dest.undo();
    await dest.undo();
    expect(dest.state.components).toEqual(before.components);
    expect(dest.state.tokens).toEqual(before.tokens);
    expect(dest.state.assets).toEqual(before.assets);
    await dest.redo();
    expect(dest.state.components[rootId]?.name).toBe('Pricing card');
    await Promise.all([src.s.close(), dest.close()]);
  });

  it('reuses a site style the destination already has, renames one that differs, and stands in for a theme style its theme lacks', async () => {
    const src = await pricingCard();
    const { path } = await exportTo(src.s, src.rootId);

    // The same Sea already there: the import uses it and makes no second one.
    const same = await blank('Same');
    ok(await same.apply({ operations: [{ type: 'token.create', group: 'color', label: 'Sea', value: '#0a6e8a' }] }, { label: 'Add' }));
    ok(await importInto(same, path));
    expect(same.state.tokens.custom.map((t) => t.id)).toEqual(['color.custom-sea']);

    // A different Sea: the destination's keeps its name and value; the import's is made under the next free name.
    const other = await blank('Other');
    ok(await other.apply({ operations: [{ type: 'token.create', group: 'color', label: 'Sea', value: '#ff0000' }] }, { label: 'Add' }));
    const r = ok(await importInto(other, path));
    const root = other.state.components[r.results!.at(-1)!.definitionId as string];
    expect(other.state.tokens.custom.map((t) => [t.id, t.value])).toEqual([
      ['color.custom-sea', '#ff0000'],
      ['color.custom-sea-2', '#0a6e8a']
    ]);
    const childOf = (s: Session, def: ComponentDefinition) => Object.values(def.tree!.nodes).flatMap((n) => (n.kind === 'instance' && s.state.components[n.definitionId]?.owner === 'project' ? [s.state.components[n.definitionId]] : []))[0];
    const child = childOf(other, root);
    expect([...refs(child).tokens].filter((t) => t.startsWith('color.'))).toEqual(['color.custom-sea-2']);
    expect(validateState(other.state).filter((d) => d.severity === 'error')).toEqual([]);

    // A theme style the destination's theme doesn't have becomes a style of the site's own with the value it had.
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as ComponentPackage;
    const sea = pkg.tokens.find((t) => t.id === 'color.custom-sea')!;
    Object.assign(sea, { id: 'color.lagoon', label: 'Lagoon', custom: false, value: { token: 'color.brand' }, resolved: '#123456' });
    const text = JSON.stringify(pkg).replaceAll('"color.custom-sea"', '"color.lagoon"');
    const theme = await blank('Theme');
    const t = ok(await importInto(theme, writePackage(text)));
    expect(theme.state.tokens.custom).toEqual([expect.objectContaining({ id: 'color.custom-lagoon', label: 'Lagoon', value: '#123456' })]);
    // Where a different Lagoon of the site's own is there, the stand-in takes the next name, and a second import of
    // the same package uses that stand-in again rather than making a third.
    const taken = await blank('Taken');
    ok(await taken.apply({ operations: [{ type: 'token.create', group: 'color', label: 'Lagoon', value: '#000000' }] }, { label: 'Add' }));
    ok(await importInto(taken, writePackage(text)));
    ok(await importInto(taken, writePackage(text)));
    expect(taken.state.tokens.custom.map((x) => [x.id, x.value])).toEqual([
      ['color.custom-lagoon', '#000000'],
      ['color.custom-lagoon-2', '#123456']
    ]);
    await taken.close();
    expect([...refs(childOf(theme, theme.state.components[t.results!.at(-1)!.definitionId as string])).tokens].filter((x) => x.startsWith('color.'))).toEqual(['color.custom-lagoon']);
    await Promise.all([src.s.close(), same.close(), other.close(), theme.close()]);
  });

  it('carries a code component with the code component it imports, relinking the import each time it lands', async () => {
    const s = await blank('Code');
    const token = ok(await s.apply({ operations: [{ type: 'token.create', group: 'color', label: 'Sea', value: '#0a6e8a' }] }, { label: 'Add' })).results![0].tokenId as string;
    const badge = ok(
      await s.apply(
        { operations: [{ type: 'component.createCode', name: 'Badge', source: '<script>\n  let { label = "New" } = $props();\n</script>\n\n<span class="badge">{label}</span>\n', properties: { label: { type: 'string', label: 'Label', default: 'New' } } }] },
        { label: 'Create', codeAllowed: true }
      )
    ).results![0];
    const file = (badge.sourcePath as string).split('/').pop()!;
    const cardSource = `<script>\n  import Badge from './${file}';\n  let { title = 'Hello' } = $props();\n</script>\n\n<div class="card" style="color: var(${'--so-' + token.replace(/\./g, '-')})">\n  <Badge label="Pro" />\n  <h3>{title}</h3>\n</div>\n`;
    const card = ok(await s.apply({ operations: [{ type: 'component.createCode', name: 'Card', source: cardSource, properties: { title: { type: 'string', label: 'Title', default: 'Hello' } } }] }, { label: 'Create', codeAllowed: true })).results![0];
    const { path } = await exportTo(s, card.definitionId as string);
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as ComponentPackage;
    expect(pkg.definitions.map((d) => d.name).sort()).toEqual(['Badge', 'Card']);
    expect(pkg.tokens.map((t) => t.id)).toEqual([token]);

    // Without Developer mode the package is refused before anything is written.
    const dest = await blank('Dest');
    const untouched = snapshot(dest);
    await expect(importInto(dest, path, { codeAllowed: false })).rejects.toThrow(/Developer mode/);
    expect(snapshot(dest)).toBe(untouched);

    // Imported twice: two independent copies, each card importing its own badge.
    const first = ok(await importInto(dest, path));
    const second = ok(await importInto(dest, path));
    const badgeOf = (r: typeof first) => dest.state.components[(r.results!.at(-1)!.definitionIds as string[])[1]];
    for (const r of [first, second]) {
      const c = dest.state.components[r.results!.at(-1)!.definitionId as string];
      const dep = badgeOf(r);
      expect(dep.name).toBe('Badge');
      expect(c.source).toContain(`import Badge from './${dep.sourcePath!.split('/').pop()}'`);
      expect(c.source).toContain('var(--so-color-custom-sea)');
    }
    const cards = [first, second].map((r) => dest.state.components[r.results!.at(-1)!.definitionId as string]);
    expect(cards[0].sourcePath).not.toBe(cards[1].sourcePath);
    expect(badgeOf(first).sourcePath).not.toBe(badgeOf(second).sourcePath);
    expect(dest.state.tokens.custom.map((t) => t.id)).toEqual(['color.custom-sea']);
    expect(validateState(dest.state).filter((d) => d.severity === 'error')).toEqual([]);

    // Where Sea means another colour, the code's variable follows the style it was written for, under its new name.
    const other = await blank('Other');
    ok(await other.apply({ operations: [{ type: 'token.create', group: 'color', label: 'Sea', value: '#ff0000' }] }, { label: 'Add' }));
    const moved = ok(await importInto(other, path));
    expect(other.state.components[moved.results!.at(-1)!.definitionId as string].source).toContain('var(--so-color-custom-sea-2)');
    await Promise.all([s.close(), dest.close(), other.close()]);
  });

  it('won’t export code that shows a library image by its address, which the other site would not have', async () => {
    const s = await blank('Code');
    const imageId = await addImage(s, 'Waves.png', await png('#0a6e8a'));
    const url = s.state.assets.assets[imageId].file.replace(/^static/, '');
    const made = ok(await s.apply({ operations: [{ type: 'component.createCode', name: 'Hero', source: `<img src="${url}" alt="Waves" />\n` }] }, { label: 'Create', codeAllowed: true })).results![0];
    await expect(buildComponentPackage(s.dir, s.state, made.definitionId as string)).rejects.toThrow(/The code of “Hero” shows “Waves” from this site's library by its address/);
    await s.close();
  });

  it('refuses unsafe or non-compiling code with the reason, changing nothing', async () => {
    const dest = await blank('Dest');
    const untouched = snapshot(dest);
    const unsafe = await importInto(dest, writePackage(codePackage(`<script>\n  let { title = 'Hello' } = $props();\n  fetch('https://example.com/track');\n</script>\n\n<h3>{title}</h3>\n`)));
    expect(unsafe.ok).toBe(false);
    expect(unsafe.error!.message).toMatch(/Code in a component package may not use network requests/);
    const broken = await importInto(dest, writePackage(codePackage(`<script>\n  let x = ;\n</script>\n\n<h3>{x}</h3>\n`)));
    expect(broken.ok).toBe(false);
    expect(broken.error!.message).toMatch(/The code for "Card" has problems/);
    // A component that imports a file the package doesn't carry can't be checked, so it is refused.
    const missing = await importInto(dest, writePackage(codePackage(`<script>\n  import Other from './Other-zzzzz.svelte';\n</script>\n\n<Other />\n`)));
    expect(missing.ok).toBe(false);
    expect(missing.error!.message).toMatch(/may not import "\.\/Other-zzzzz\.svelte", which is not a component in this project/);
    // Nor may it reach a runtime helper the site doesn't have: compiling the component alone never notices.
    const helper = await importInto(dest, writePackage(codePackage(`<script>\n  import Gone from '../runtime/Gone.svelte';\n</script>\n\n<Gone />\n`)));
    expect(helper.ok).toBe(false);
    expect(helper.error!.message).toMatch(/imports "\.\.\/runtime\/Gone\.svelte", which is not a file in this project/);
    expect(snapshot(dest)).toBe(untouched);
    // The same safe code lands.
    ok(await importInto(dest, writePackage(codePackage(`<script>\n  let { title = 'Hello' } = $props();\n</script>\n\n<h3>{title}</h3>\n`))));
    await dest.close();
  });

  it('stores a clean SVG from a package, and refuses one with scripts before writing anything', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0a6e8a"/></svg>');
    const src = await blank('Source');
    const imageId = await addImage(src, 'Mark.svg', svg);
    const owner = home(src);
    const section = ok(await src.apply({ operations: [{ type: 'node.insert', owner, parentId: null, componentId: 'layout.section' }] }, { label: 'Insert' })).results![0].nodeId as string;
    const image = ok(await src.apply({ operations: [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'image' }] }, { label: 'Insert' })).results![0].nodeId as string;
    ok(await src.apply({ operations: [{ type: 'node.setContent', owner, nodeId: image, field: 'image', value: { assetId: imageId, alt: 'Mark' } }] }, { label: 'Image' }));
    const defId = ok(await src.apply({ operations: [{ type: 'component.createFromNode', owner, nodeId: section, name: 'Logo band' }] }, { label: 'Create' })).results![0].definitionId as string;
    const { path } = await exportTo(src, defId);

    // What the library stored round-trips: the destination stores the same bytes.
    const dest = await blank('Dest');
    ok(await importInto(dest, path));
    const stored = Object.values(dest.state.assets.assets).find((a) => a.mime === 'image/svg+xml')!;
    expect(stored.hash).toBe(src.state.assets.assets[imageId].hash);
    expect(readFileSync(join(dest.dir, stored.file)).equals(readFileSync(join(src.dir, src.state.assets.assets[imageId].file)))).toBe(true);

    // The same package with a script in its SVG is refused, and no file or record is added.
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as ComponentPackage;
    const evil = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" onload="alert(2)"/></svg>');
    Object.assign(pkg.images[0], { data: evil.toString('base64'), hash: sha(evil) });
    const fresh = await blank('Fresh');
    const untouched = snapshot(fresh);
    await expect(importInto(fresh, writePackage(JSON.stringify(pkg)))).rejects.toThrow(/scripts, links or other content/);
    expect(snapshot(fresh)).toBe(untouched);
    expect(existsSync(join(fresh.dir, 'static/assets')) ? (await import('node:fs')).readdirSync(join(fresh.dir, 'static/assets')).filter((f) => f.endsWith('.svg')) : []).toEqual([]);
    await Promise.all([src.close(), dest.close(), fresh.close()]);
  });

  it('refuses damaged or foreign packages before reading them into the project, in plain words', async () => {
    const good = JSON.parse(codePackage(`<h3>Hi</h3>\n`));
    const cases: Array<[string, string, RegExp]> = [
      ['not JSON', '{"format": "siteorigin.comp', /not a complete JSON file/],
      ['another kind of file', JSON.stringify({ hello: 'world' }), /not a SiteOrigin Builder component package/],
      ['a newer format', JSON.stringify({ ...good, version: 2 }), /newer version of SiteOrigin Builder/],
      ['a reserved key', JSON.stringify(good).replace('"title":', '"__proto__":'), /reserved name "__proto__"/],
      ['no component it is for', JSON.stringify({ ...good, rootId: 'code.other-zzzzz' }), /component it is for is missing/],
      ['a definition twice', JSON.stringify({ ...good, definitions: [good.definitions[0], good.definitions[0]] }), /lists the component "code.card-abcde" twice/],
      ['a newer document', JSON.stringify({ ...good, definitions: [{ ...good.definitions[0], schemaVersion: 999 }] }), /newer version of SiteOrigin Builder/],
      ['a damaged image', JSON.stringify({ ...good, images: [{ id: 'a_x', name: 'X', mime: 'image/png', hash: 'f'.repeat(64), data: '%%%' }] }), /damaged/]
    ];
    for (const [what, text, message] of cases) await expect(readComponentPackage(writePackage(text)), what).rejects.toThrow(message);
    expect(() => decodeComponentPackage(codePackage('<h3>Hi</h3>'))).not.toThrow();

    // A design placing a component the package doesn't carry is refused when it would land.
    const dest = await blank('Dest');
    const untouched = snapshot(dest);
    const managed = {
      ...good.definitions[0],
      id: 'proj.band-abcde',
      kind: 'managed',
      name: 'Band',
      source: undefined,
      sourcePath: undefined,
      tree: { rootIds: ['root'], nodes: { root: { id: 'root', kind: 'instance', definitionId: 'proj.gone-zzzzz', props: {} } } },
      parts: { root: { nodeId: 'root', label: 'Root' } }
    };
    const r = await importInto(dest, writePackage(JSON.stringify({ ...good, rootId: managed.id, definitions: [managed] })));
    expect(r.ok).toBe(false);
    expect(r.error!.message).toMatch(/“Band” places a component the package doesn't include/);
    expect(snapshot(dest)).toBe(untouched);
    await dest.close();
  });

  it('refuses a package whose definitions are damaged, share a file, or name images no longer in the library, before anything lands', async () => {
    const good = JSON.parse(codePackage(`<h3>Hi</h3>\n`));
    const dest = await blank('Dest');
    const untouched = snapshot(dest);
    const managed = (nodes: Record<string, unknown>) => ({
      ...good.definitions[0],
      id: 'proj.band-abcde',
      kind: 'managed',
      name: 'Band',
      source: undefined,
      sourcePath: undefined,
      tree: { rootIds: ['root'], nodes },
      parts: { root: { nodeId: 'root', label: 'Root' } }
    });
    // An element without its list of children: named, never a script error.
    const noChildren = await importInto(dest, writePackage(JSON.stringify({ ...good, rootId: 'proj.band-abcde', definitions: [managed({ root: { id: 'root', kind: 'element', tag: 'div' } })] })));
    expect(noChildren.error?.message).toMatch(/“Band” is damaged: the element "root" has no list of children/);
    // Two code components saved as one file would land as one.
    const twin = { ...good.definitions[0], id: 'code.twin-fghij', name: 'Twin' };
    const shared = await importInto(dest, writePackage(JSON.stringify({ ...good, definitions: [good.definitions[0], twin] })));
    expect(shared.error?.message).toMatch(/two components saved as the same file/);
    // A design whose generated code would not compile (two slots that become the same name) is refused.
    const slots = managed({
      root: { id: 'root', kind: 'element', tag: 'div', children: ['s1', 's2'] },
      s1: { id: 's1', kind: 'slot', slot: 'hero-title' },
      s2: { id: 's2', kind: 'slot', slot: '_hero_title' }
    });
    const clash = await importInto(dest, writePackage(JSON.stringify({ ...good, rootId: slots.id, definitions: [{ ...slots, slots: { 'hero-title': { label: 'Title' }, _hero_title: { label: 'Title too' } } }] })));
    expect(clash.error?.message).toMatch(/“Band” can't be imported: its design doesn't compile \(Identifier 'slot__hero_title' has already been declared\)/);
    expect(snapshot(dest)).toBe(untouched);
    await dest.close();
  });

  it('refuses an import whose image left the library after it was stored', async () => {
    const src = await pricingCard();
    const { path } = await exportTo(src.s, src.rootId);
    const dest = await blank('Dest');
    const pkg = await readComponentPackage(path);
    const prepared = await preparePackageImport(dest.dir, dest.state, pkg, { codeAllowed: true });
    // The image record the import was to add never lands with it (an undo removed it meanwhile, say).
    const r = await dest.apply({ operations: [{ type: 'component.import', importId: prepared.input.id }] }, { label: 'Import', source: 'user', componentImport: prepared.input });
    expect(r.ok).toBe(false);
    expect(r.error!.message).toMatch(/The image “Waves” is no longer in this project's library/);
    await Promise.all([src.s.close(), dest.close()]);
  });

  it('lets only the editor import: the assistant, and an edit without the checked package, land nothing', async () => {
    const dest = await blank('Dest');
    const pkg = await readComponentPackage(writePackage(codePackage(`<h3>Hi</h3>\n`)));
    const prepared = await preparePackageImport(dest.dir, dest.state, pkg, { codeAllowed: true });
    const op = { type: 'component.import' as const, importId: prepared.input.id };
    const ai = await dest.apply({ operations: [op] }, { label: 'AI', source: 'ai', componentImport: prepared.input });
    expect(ai.ok).toBe(false);
    expect(ai.error!.code).toBe('SCOPE_MISMATCH');
    const bare = await dest.apply({ operations: [op] }, { label: 'Edit', source: 'user' });
    expect(bare.ok).toBe(false);
    expect(bare.error!.message).toMatch(/no longer open/);
    // A package checked for another import is not this one's.
    const stale = await dest.apply({ operations: [{ ...op, importId: 'imp_zzzzzzzz' }] }, { label: 'Edit', source: 'user', componentImport: prepared.input });
    expect(stale.ok).toBe(false);
    expect(stale.error!.message).toMatch(/no longer open/);
    // An import is a change of its own.
    const mixed = await dest.apply({ operations: [op, { type: 'page.create', title: 'Extra' }] }, { label: 'Edit', source: 'user', componentImport: prepared.input });
    expect(mixed.ok).toBe(false);
    expect(mixed.error!.message).toMatch(/change of its own/);
    expect(Object.values(dest.state.components).some((d) => d.name === 'Card')).toBe(false);
    await dest.close();
  });

  it('leaves out links to the source site’s pages, saying so, and the component still lands', async () => {
    const src = await pricingCard();
    const about = ok(await src.s.apply({ operations: [{ type: 'page.create', title: 'About' }] }, { label: 'Page' })).results![0].pageId as string;
    // A design with a button linking to the About page.
    const root = src.s.state.components[src.rootId];
    const owner = { kind: 'component' as const, id: src.rootId };
    const sectionNode = root.tree!.nodes[root.tree!.rootIds[0]] as InstanceNode | ElementNode;
    const button = ok(await src.s.apply({ operations: [{ type: 'node.insert', owner, parentId: sectionNode.id, slot: 'content', primitive: 'button', text: 'About us' }] }, { label: 'Button' })).results![0].nodeId as string;
    ok(await src.s.apply({ operations: [{ type: 'node.setContent', owner, nodeId: button, field: 'link', value: { type: 'page', target: about } }] }, { label: 'Link' }));
    const { path, notes } = await exportTo(src.s, src.rootId);
    expect(notes).toEqual(["A link to this site's pages or documents was left out, as another site doesn't have them."]);
    expect(readFileSync(path, 'utf8')).not.toContain(about);
    const dest = await blank('Dest');
    const r = ok(await importInto(dest, path));
    const landed = dest.state.components[r.results!.at(-1)!.definitionId as string];
    // The button keeps a link that goes nowhere, so it never falls back to another link.
    expect(Object.values(landed.tree!.nodes).flatMap((n) => (n.kind === 'link' ? [n.link] : []))).toEqual([{ type: 'none', target: '' }]);
    expect(validateState(dest.state).filter((d) => d.severity === 'error')).toEqual([]);
    await Promise.all([src.s.close(), dest.close()]);
  });

  it('migrates an older package with the rest of the project’s migrations (engine)', async () => {
    // A package saved in the first format: the pipeline stamps and upgrades it like any old document.
    const text = codePackage(`<h3>Hi</h3>\n`);
    const pkg = await readComponentPackage(writePackage(text));
    expect(pkg.definitions[0].schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    const state: ProjectState = createStarterState('blank', 'Engine', false);
    const prepared = { id: 'imp_abcdefgh', pkg, images: {} };
    const r = applyOperations(state, [{ type: 'component.import', importId: 'imp_abcdefgh' }], { componentImport: prepared });
    expect(r.state.components[r.results[0].definitionId as string]).toMatchObject({ name: 'Card', kind: 'code', owner: 'project' });
  });
});
