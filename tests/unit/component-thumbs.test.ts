/**
 * Thumbnails of project components for Insert (#370): the key that decides when one is drawn again, the frame that
 * is photographed, the project's thumbnail cache, and the queue that answers the editor from memory, then the cache,
 * else a photograph, never keeping one of a component that changed while it was drawn.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { ComponentThumb } from '@shared/component-thumbs';
import type { PreparedComponentPreview } from '@shared/component-preview';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { installComponent } from '@engine/install';
import { getTheme, listThemes, registerPacks } from '@catalogue/index';
import { brandFingerprint, brandParts, colourProjection, ComponentThumbs, readThumb, thumbCrop, thumbKey, writeThumb, writeThumbReads, type CaptureResult, type ThumbHost } from '../../src/main/runtime/component-thumbs';

const apply = (state: ProjectState, operations: unknown[]) => applyOperations(state, operations as Parameters<typeof applyOperations>[1]);

/** A project with an "Exhibitor card" made from a stack with a heading, as the editor's Create component makes one. */
function withCard(state = createStarterState('blank', 'Thumb Studio', false)) {
  const owner = { kind: 'page', id: state.site.homePageId };
  let r = apply(state, [{ type: 'node.insert', owner, componentId: 'layout.section' }]);
  const section = r.results[0].nodeId as string;
  r = apply(r.state, [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'stack' }]);
  const stack = r.results[0].nodeId as string;
  r = apply(r.state, [{ type: 'node.insert', owner, parentId: stack, primitive: 'heading', text: 'Exhibitor' }]);
  r = apply(r.state, [{ type: 'component.createFromNode', owner, nodeId: stack, name: 'Exhibitor card' }]);
  const card = Object.values(r.state.components).find((d) => d.name === 'Exhibitor card')!;
  return { state: r.state, card: card.id, section, owner };
}

/** Style the root of a component's own design. */
const styleRoot = (state: ProjectState, definitionId: string, property: string, value: unknown) =>
  apply(state, [{ type: 'node.setStyle', owner: { kind: 'component', id: definitionId }, nodeId: state.components[definitionId].tree!.rootIds[0], scope: 'base', property, value }]).state;

const PNG = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([n, n, n, n])]);

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'so-thumbs-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('a thumbnail’s key', () => {
  it('is the same for the same component and brand, and ignores the rest of the project', () => {
    const { state, card, owner } = withCard();
    const key = thumbKey(state, card)!;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // Asked again (a preview's list items get fresh IDs each time; the key is not made from those).
    expect(thumbKey(structuredClone(state), card)).toBe(key);
    // Pages, their placements and other components do not show in this component's picture.
    const more = apply(state, [{ type: 'node.insert', owner, componentId: 'content.text' }]).state;
    expect(thumbKey(more, card)).toBe(key);
    const other = apply(more, [{ type: 'component.createCode', name: 'Other', source: '<p>Other</p>\n' }]);
    const otherId = other.results[0].definitionId as string;
    expect(thumbKey(other.state, card)).toBe(key);
    expect(thumbKey(styleRoot(withCard(other.state).state, card, 'background', '#00ff00'), otherId)).toBe(thumbKey(other.state, otherId));
  });

  it('changes with the component’s style, and with a style of a component it places', () => {
    const { state, card, owner, section } = withCard();
    const key = thumbKey(state, card);
    const red = styleRoot(state, card, 'background', '#ff0000');
    expect(thumbKey(red, card)).not.toBe(key);
    expect(thumbKey(styleRoot(red, card, 'background', '#0000ff'), card)).not.toBe(thumbKey(red, card));
    // A "Card row" that places the card: restyling the card redraws the row too.
    let r = apply(state, [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'row' }]);
    const row = r.results[0].nodeId as string;
    r = apply(r.state, [{ type: 'node.insert', owner, parentId: row, definitionId: card }]);
    r = apply(r.state, [{ type: 'component.createFromNode', owner, nodeId: row, name: 'Card row' }]);
    const rowDef = Object.values(r.state.components).find((d) => d.name === 'Card row')!.id;
    const before = thumbKey(r.state, rowDef);
    expect(thumbKey(styleRoot(r.state, card, 'background', '#ff0000'), rowDef)).not.toBe(before);
  });

  it('changes with a code component’s source', () => {
    const made = apply(createStarterState('blank', 'Thumb Studio', false), [{ type: 'component.createCode', name: 'Note', source: '<p>One</p>\n' }]);
    const id = made.results[0].definitionId as string;
    const key = thumbKey(made.state, id);
    const edited = apply(made.state, [{ type: 'component.updateSource', definitionId: id, source: '<p>Two</p>\n' }]).state;
    expect(thumbKey(edited, id)).not.toBe(key);
  });

  it('changes with the site’s brand colours, fonts, language and the way its text runs', () => {
    const { state, card } = withCard();
    const key = thumbKey(state, card);
    expect(thumbKey(apply(state, [{ type: 'token.set', tokenId: 'color.brand', value: '#123456' }]).state, card)).not.toBe(key);
    expect(thumbKey(apply(state, [{ type: 'token.set', tokenId: 'font.body', value: 'Georgia, serif' }]).state, card)).not.toBe(key);
    const french = structuredClone(state);
    french.site.language = 'fr';
    expect(thumbKey(french, card)).not.toBe(key);
    // The preview is drawn right to left for a site set to run that way in the same language (#972).
    const rtl = structuredClone(state);
    rtl.site.direction = 'rtl';
    expect(thumbKey(rtl, card)).not.toBe(key);
  });

  it('changes when a font of the project’s own is replaced, and when an article a list shows changes', () => {
    const { state, card } = withCard();
    const fonts = structuredClone(state);
    fonts.assets.assets.f1 = { id: 'f1', name: 'House', file: 'house.woff2', mime: 'font/woff2', bytes: 10, hash: 'one', kind: 'font', createdAt: '2026-01-01T00:00:00.000Z' };
    const before = thumbKey(fonts, card);
    fonts.assets.assets.f1.hash = 'two';
    expect(thumbKey(fonts, card)).not.toBe(before);
    // A News list shows the site's articles as they are now.
    const news = structuredClone(state);
    const list = installComponent(news, 'content.news');
    const made = apply(news, [{ type: 'page.create', title: 'Opening night', starter: 'article', articleDate: '2026-01-02' }]);
    const article = made.results[0].pageId as string;
    const listed = thumbKey(made.state, list);
    expect(thumbKey(apply(made.state, [{ type: 'page.update', pageId: article, title: 'Opening night, again' }]).state, list)).not.toBe(listed);
    // A component that shows no articles is not drawn again for one.
    expect(thumbKey(apply(made.state, [{ type: 'page.update', pageId: article, title: 'Opening night, again' }]).state, card)).toBe(thumbKey(made.state, card));
  });

  it('is null for a component the project does not have', () => {
    expect(thumbKey(withCard().state, 'no-such-component')).toBeNull();
  });
});

describe('the frame photographed', () => {
  it('is 16:10 around what the component paints, showing the top of something taller', () => {
    // A full-width section taller than the page's view: its top.
    expect(thumbCrop({ x: 0, y: 0, width: 1280, height: 1600 }, { x: 0, y: 0, width: 1280, height: 1600 })).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    // A full-width hero shorter than the frame: all of it, with the page's background below.
    expect(thumbCrop({ x: 0, y: 0, width: 1280, height: 500 }, { x: 0, y: 0, width: 1280, height: 500 })).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    // A heading in a full-width block: the heading, at its own size, not the empty width beside it.
    expect(thumbCrop({ x: 0, y: 0, width: 1280, height: 38 }, { x: 0, y: 0, width: 150, height: 38 })).toEqual({ x: 0, y: 0, width: 320, height: 200 });
    // Something small in the middle of the page: centred.
    expect(thumbCrop({ x: 0, y: 0, width: 1280, height: 700 }, { x: 540, y: 300, width: 200, height: 50 })).toEqual({ x: 480, y: 225, width: 320, height: 200 });
    // A tall card: its top, as wide as it is with room around it.
    expect(thumbCrop({ x: 20, y: 10, width: 300, height: 600 }, { x: 20, y: 10, width: 300, height: 600 })).toEqual({ x: 4, y: 0, width: 332, height: 208 });
    // Wider than the page: only what is in it.
    expect(thumbCrop({ x: -50, y: 0, width: 2000, height: 50 }, null)).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    // A page view shorter than a full-width frame: the frame narrows to fit it, still 16:10.
    expect(thumbCrop({ x: 0, y: 0, width: 1280, height: 1000 }, null, { width: 1280, height: 400 })).toEqual({ x: 320, y: 0, width: 640, height: 400 });
  });

  it('frames the component’s box when what it paints is not known', () => {
    expect(thumbCrop({ x: 0, y: 0, width: 300, height: 100 })).toEqual({ x: 0, y: 0, width: 320, height: 200 });
    expect(thumbCrop({ x: 0, y: 0, width: 300, height: 100 }, { x: Number.NaN, y: 0, width: 1, height: 1 })).toEqual({ x: 0, y: 0, width: 320, height: 200 });
  });

  it('is nothing for a component with no box, or none on the page', () => {
    expect(thumbCrop(null)).toBeNull();
    expect(thumbCrop({ x: 0, y: 0, width: 0, height: 0 })).toBeNull();
    expect(thumbCrop({ x: 0, y: 900, width: 400, height: 100 })).toBeNull();
    expect(thumbCrop({ x: 1300, y: 0, width: 400, height: 100 })).toBeNull();
    expect(thumbCrop({ x: -500, y: 0, width: 400, height: 100 })).toBeNull();
    expect(thumbCrop({ x: 0, y: -300, width: 400, height: 100 })).toBeNull();
    expect(thumbCrop({ x: Number.NaN, y: 0, width: 400, height: 100 })).toBeNull();
  });
});

describe('the project’s thumbnail cache', () => {
  const key = (n: number) => n.toString(16).padStart(64, '0');

  it('keeps a thumbnail under .siteorigin/cache/thumbs by its key, and reads it back', async () => {
    const root = tempDir();
    expect(await readThumb(root, key(1))).toBeNull();
    await writeThumb(root, key(1), PNG(1));
    expect(existsSync(join(root, '.siteorigin/cache/thumbs', `${key(1)}.png`))).toBe(true);
    expect(await readThumb(root, key(1))).toEqual(PNG(1));
    // Only keys and pictures: nothing else is written or read.
    await writeThumb(root, '../../escape', PNG(2));
    await writeThumb(root, key(2), Buffer.from('not a png'));
    expect(readdirSync(join(root, '.siteorigin/cache/thumbs'))).toEqual([`${key(1)}.png`]);
    expect(await readThumb(root, '../thumbs/x')).toBeNull();
    writeFileSync(join(root, '.siteorigin/cache/thumbs', `${key(3)}.png`), 'not a png');
    expect(await readThumb(root, key(3))).toBeNull();
  });

  it('never reads or writes through a link planted on the way', async () => {
    const root = tempDir();
    const elsewhere = tempDir();
    mkdirSync(join(root, '.siteorigin/cache'), { recursive: true });
    symlinkSync(elsewhere, join(root, '.siteorigin/cache/thumbs'));
    writeFileSync(join(elsewhere, `${key(1)}.png`), PNG(1));
    expect(await readThumb(root, key(1))).toBeNull();
    await writeThumb(root, key(2), PNG(2));
    expect(readdirSync(elsewhere)).toEqual([`${key(1)}.png`]);
  });

  it('removes the oldest thumbnails beyond the number kept', async () => {
    const root = tempDir();
    const dir = join(root, '.siteorigin/cache/thumbs');
    for (let n = 1; n <= 3; n++) {
      await writeThumb(root, key(n), PNG(n), 3);
      utimesSync(join(dir, `${key(n)}.png`), n * 1000, n * 1000);
    }
    writeFileSync(join(dir, 'notes.txt'), 'not the editor’s');
    await writeThumb(root, key(4), PNG(4), 3);
    expect(readdirSync(dir).sort()).toEqual([`${key(2)}.png`, `${key(3)}.png`, `${key(4)}.png`, 'notes.txt']);
  });
});

/** A host for the queue, with the project, the preview server and photographs under the test's control. */
function fakeHost(state: ProjectState, opts: { root?: string; shots?: Array<CaptureResult | Promise<CaptureResult>>; settle?: () => void; prepareFails?: number; prepareGate?: () => Promise<void> } = {}) {
  let prepareFails = opts.prepareFails ?? 0;
  const host = {
    state,
    opening: 'open#1' as string | null,
    server: 'http://127.0.0.1:5173' as string | null,
    prepared: [] as string[],
    released: [] as string[],
    persisted: [] as string[],
    hinted: [] as string[],
    ownStyles: true,
    showsStyles: true,
    scheme: 'light' as 'light' | 'dark',
    captured: 0,
    shots: opts.shots ?? [],
    onCapture: null as (() => void) | null
  };
  const api: ThumbHost = {
    current: () => (host.opening ? { opening: host.opening, state: host.state, cacheRoot: opts.root ?? null, readRoot: opts.root ?? tempDir() } : null),
    previewServer: () => host.server,
    settle: async () => opts.settle?.(),
    prepare: async (definitionId): Promise<PreparedComponentPreview> => {
      await opts.prepareGate?.();
      if (prepareFails-- > 0) return { ok: false, message: 'Could not write the preview.' };
      const key = `p${host.prepared.length}`.padEnd(16, '0');
      host.prepared.push(definitionId);
      return { ok: true, key, path: `/__siteorigin/component/${key}/`, definitionId };
    },
    release: (key) => void host.released.push(key),
    capture: async () => {
      host.captured++;
      host.onCapture?.();
      return (await host.shots.shift()) ?? { ok: true, png: PNG(host.captured) };
    },
    persist: async (root, key, png) => {
      host.persisted.push(key);
      await writeThumb(root, key, png);
    },
    persistReads: async (root, base, reads) => {
      host.hinted.push(base);
      await writeThumbReads(root, base, reads);
    },
    ownStyles: () => host.ownStyles,
    showsStyles: async () => host.showsStyles,
    scheme: () => host.scheme
  };
  return { host, thumbs: new ComponentThumbs(api) };
}

describe('the thumbnail queue', () => {
  it('photographs a component once for every request of the same version, keeps it, and answers again from memory', async () => {
    const root = tempDir();
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state, { root });
    const [a, b] = await Promise.all([thumbs.get(card, 'open#1'), thumbs.get(card, 'open#1')]);
    expect(host.captured).toBe(1);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ state: 'ready', key: thumbKey(state, card), url: `data:image/png;base64,${PNG(1).toString('base64')}` });
    // Its preview's files are released once photographed, and the picture is kept in the project's cache.
    expect(host.released).toHaveLength(1);
    expect(existsSync(join(root, '.siteorigin/cache/thumbs', `${thumbKey(state, card)}.png`))).toBe(true);
    // Shown already: the answer leaves the picture out.
    expect(await thumbs.get(card, 'open#1', (a as { key: string }).key)).toEqual({ state: 'ready', key: (a as { key: string }).key });
    // Asked again, it is answered from memory, even with the cache gone.
    rmSync(join(root, '.siteorigin'), { recursive: true, force: true });
    expect(await thumbs.get(card, 'open#1')).toEqual(a);
    expect(host.captured).toBe(1);
  });

  it('works out the site’s brand once for each state of the project and theme, and again for a new one of either', async () => {
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state);
    // Asked for, checked again around its photograph, and asked for again: one brand for one state.
    const first = (await thumbs.get(card, 'open#1')) as { key: string };
    expect(await thumbs.get(card, 'open#1', first.key)).toEqual({ state: 'ready', key: first.key });
    expect(thumbs.brands).toBe(1);
    expect(first.key).toBe(thumbKey(state, card));
    // A colour changed: a new state, so a new brand and a new key, the same as worked out afresh.
    host.state = apply(state, [{ type: 'token.set', tokenId: 'color.brand', value: '#123456' }]).state;
    const recoloured = (await thumbs.get(card, 'open#1')) as { key: string };
    expect(thumbs.brands).toBe(2);
    expect(recoloured.key).not.toBe(first.key);
    expect(recoloured.key).toBe(thumbKey(host.state, card));
    // The same state with the theme's pack registered again, its styles changed: the brand is worked out again.
    const packs = listThemes();
    const themeId = host.state.site.themeId;
    registerPacks(packs.map((p) => (p.id === getTheme(themeId).id ? { ...p, baseCss: `${p.baseCss}\n/* changed */` } : p)));
    try {
      const restyled = (await thumbs.get(card, 'open#1')) as { key: string };
      expect(thumbs.brands).toBe(3);
      expect(restyled.key).not.toBe(recoloured.key);
      expect(restyled.key).toBe(thumbKey(host.state, card));
    } finally {
      registerPacks(packs);
    }
  });

  it('reads a thumbnail drawn in an earlier opening from the project’s cache, without photographing it', async () => {
    const root = tempDir();
    const { state, card } = withCard();
    await writeThumb(root, thumbKey(state, card)!, PNG(7));
    const { host, thumbs } = fakeHost(state, { root });
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ state: 'ready', url: `data:image/png;base64,${PNG(7).toString('base64')}` });
    expect(host.captured).toBe(0);
    expect(host.prepared).toEqual([]);
  });

  it('draws a component again once it changes, and keeps nothing when it changed while it was drawn', async () => {
    const root = tempDir();
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state, { root });
    const first = (await thumbs.get(card, 'open#1')) as { key: string };
    host.state = styleRoot(state, card, 'background', '#ff0000');
    const restyled = (await thumbs.get(card, 'open#1')) as { key: string; url: string };
    expect(restyled.key).not.toBe(first.key);
    expect(host.captured).toBe(2);
    // Restyled again while its photograph is taken: that picture may show either style, so it is not kept.
    host.state = styleRoot(host.state, card, 'background', '#00ff00');
    host.onCapture = () => (host.state = styleRoot(host.state, card, 'background', '#0000ff'));
    expect(await thumbs.get(card, 'open#1')).toEqual({ state: 'unavailable' });
    host.onCapture = null;
    expect(host.persisted).toEqual([first.key, restyled.key]);
    expect(host.released).toHaveLength(3);
  });

  it('answers nothing for another opening, an unknown or theme component, or a preview that is not running', async () => {
    const { state, card } = withCard();
    const theme = installComponent(state, 'content.news');
    const { host, thumbs } = fakeHost(state);
    expect(await thumbs.get(card, 'open#0')).toEqual({ state: 'unavailable' });
    expect(await thumbs.get('no-such-component', 'open#1')).toEqual({ state: 'unavailable' });
    expect(state.components[theme].owner).not.toBe('project');
    expect(await thumbs.get(theme, 'open#1')).toEqual({ state: 'unavailable' });
    expect(await thumbs.get(42, 'open#1')).toEqual({ state: 'unavailable' });
    host.server = null;
    expect(await thumbs.get(card, 'open#1')).toEqual({ state: 'unavailable' });
    expect(host.captured).toBe(0);
    // The preview server restarted while a photograph was taken: it may show another server's files.
    host.server = 'http://127.0.0.1:5173';
    host.onCapture = () => (host.server = 'http://127.0.0.1:5174');
    expect(await thumbs.get(card, 'open#1')).toEqual({ state: 'unavailable' });
    expect(host.persisted).toEqual([]);
  });

  it('remembers a component that cannot be pictured, and tries one that may have failed by chance once more', async () => {
    const { state, card } = withCard();
    const timedOut: CaptureResult = { ok: false, message: 'Timed out drawing the component.', transient: true };
    const { host, thumbs } = fakeHost(state, { shots: [timedOut, timedOut, timedOut] });
    expect(await thumbs.get(card, 'open#1')).toEqual({ state: 'unavailable' });
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ state: 'failed', message: 'Timed out drawing the component.' });
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ state: 'failed' });
    expect(host.captured).toBe(2);
    // The preview server started again: what may have been its doing is tried again there.
    host.server = 'http://127.0.0.1:5174';
    expect(await thumbs.get(card, 'open#1')).toEqual({ state: 'unavailable' });
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ state: 'ready' });
    expect(host.captured).toBe(4);
    // Code that throws is the component's own failure: not tried again until it changes, even on another server.
    const made = apply(state, [{ type: 'component.createCode', name: 'Broken', source: '<p>x</p>\n' }]);
    const broken = made.results[0].definitionId as string;
    host.state = made.state;
    host.shots.push({ ok: false, message: 'The component could not be shown: Boom' });
    const failed: ComponentThumb = await thumbs.get(broken, 'open#1');
    expect(failed).toMatchObject({ state: 'failed', message: 'The component could not be shown: Boom' });
    host.server = 'http://127.0.0.1:5175';
    expect(await thumbs.get(broken, 'open#1')).toEqual(failed);
    expect(host.captured).toBe(5);
    host.state = apply(made.state, [{ type: 'component.updateSource', definitionId: broken, source: '<p>Fixed</p>\n' }]).state;
    expect(await thumbs.get(broken, 'open#1')).toMatchObject({ state: 'ready' });
    // Another opening of the project starts with nothing remembered.
    host.state = made.state;
    host.opening = 'open#2';
    expect(await thumbs.get(broken, 'open#2')).toMatchObject({ state: 'ready' });
  });

  it('tries a component whose preview could not be prepared once more before remembering it', async () => {
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state, { prepareFails: 2 });
    expect(await thumbs.get(card, 'open#1')).toEqual({ state: 'unavailable' });
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ state: 'failed', message: 'Could not write the preview.' });
    expect(host.captured).toBe(0);
    host.server = 'http://127.0.0.1:5174';
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ state: 'ready' });
  });

  it('draws nothing for a component that changed while its files were being written', async () => {
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state, {
      settle: () => {
        host.state = styleRoot(host.state, card, 'background', '#ff0000');
      }
    });
    expect(await thumbs.get(card, 'open#1')).toEqual({ state: 'unavailable' });
    expect(host.prepared).toEqual([]);
    expect(host.captured).toBe(0);
  });

  it('photographs nothing for a project that closed while its preview was prepared, and lets the preview go (#822)', async () => {
    const { state, card } = withCard();
    let prepared!: () => void;
    const gate = new Promise<void>((r) => (prepared = r));
    let preparing!: () => void;
    const started = new Promise<void>((r) => (preparing = r));
    const { host, thumbs } = fakeHost(state, { prepareGate: () => (preparing(), gate) });
    const asked = thumbs.get(card, 'open#1');
    await started;
    // The project closes: the opening is gone and the thumbnails are forgotten.
    host.opening = null;
    thumbs.forget();
    prepared();
    expect(await asked).toEqual({ state: 'unavailable' });
    expect(host.captured).toBe(0);
    expect(host.released).toHaveLength(1);
  });

  it('keeps no thumbnail in memory once forgotten (#822)', async () => {
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state);
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ state: 'ready' });
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ state: 'ready' });
    expect(host.captured).toBe(1);
    thumbs.forget();
    // Nothing is held while the editor is at Welcome.
    const held = thumbs as unknown as { memory: Map<string, string>; failed: Map<string, unknown>; retried: Map<string, string> };
    expect([held.memory.size, held.failed.size, held.retried.size]).toEqual([0, 0, 0]);
    // Nothing kept on disk for it either (no cache root): the same opening asks again, so it is photographed afresh.
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ state: 'ready' });
    expect(host.captured).toBe(2);
  });

  it('keeps nothing on disk for a project it may not write to', async () => {
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state);
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ state: 'ready' });
    expect(host.persisted).toEqual([]);
  });
});

describe('pictures kept by the colours their page reads', () => {
  /** What the card's page is found to read: its page's ground and text, never the brand. */
  const READS = ['--so-color-background', '--so-color-text'];
  const shot = (n: number, reads: string[] | null = READS): CaptureResult => ({ ok: true, png: PNG(n), reads });
  const recolour = (state: ProjectState, tokenId: string, value: string) => apply(state, [{ type: 'token.set', tokenId, value }]).state;

  it('finds the picture again after a change of a colour its page does not read, and draws it again for one it reads', async () => {
    const root = tempDir();
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state, { root, shots: [shot(1), shot(2)] });
    const first = (await thumbs.get(card, 'open#1')) as { key: string; url: string };
    expect(first.url).toBe(`data:image/png;base64,${PNG(1).toString('base64')}`);
    // Kept under a key of its own: not the version's, which holds every colour.
    expect(first.key).not.toBe(thumbKey(state, card));
    expect(existsSync(join(root, '.siteorigin/cache/thumbs', `${first.key}.png`))).toBe(true);
    expect(host.hinted).toHaveLength(1);
    // The brand changes: the page never read it, so the same picture, without a photograph or its bytes again.
    host.state = recolour(state, 'color.brand', '#123456');
    expect(thumbKey(host.state, card)).not.toBe(thumbKey(state, card));
    expect(await thumbs.get(card, 'open#1', first.key)).toEqual({ state: 'ready', key: first.key });
    expect(await thumbs.get(card, 'open#1')).toEqual(first);
    expect(host.captured).toBe(1);
    // The text colour, which it reads: drawn again.
    host.state = recolour(host.state, 'color.text', '#202020');
    const second = (await thumbs.get(card, 'open#1')) as { key: string; url: string };
    expect(host.captured).toBe(2);
    expect(second.key).not.toBe(first.key);
    expect(second.url).toBe(`data:image/png;base64,${PNG(2).toString('base64')}`);
  });

  it('finds it in a later opening from what the page read, kept beside the pictures', async () => {
    const root = tempDir();
    const { state, card } = withCard();
    const before = fakeHost(state, { root, shots: [shot(1)] });
    const first = (await before.thumbs.get(card, 'open#1')) as { key: string };
    // Another launch, after a brand change: nothing in memory.
    const { host, thumbs } = fakeHost(recolour(state, 'color.brand', '#123456'), { root });
    host.opening = 'open#2';
    expect(await thumbs.get(card, 'open#2')).toMatchObject({ state: 'ready', key: first.key, url: `data:image/png;base64,${PNG(1).toString('base64')}` });
    expect(host.captured).toBe(0);
  });

  it('finds nothing with what pages read that is out of date or made up', async () => {
    const root = tempDir();
    const { state, card } = withCard();
    const before = fakeHost(state, { root, shots: [shot(1)] });
    await before.thumbs.get(card, 'open#1');
    // What the page read, rewritten to claim it reads nothing at all (or every file's hint swapped for nonsense).
    const dir = join(root, '.siteorigin/cache/thumbs');
    const hint = readdirSync(dir).find((n) => n.endsWith('.json'))!;
    for (const lie of [JSON.stringify({ reads: [] }), JSON.stringify({ reads: ['--so-color-text'] }), 'not json', JSON.stringify({ reads: ['b', 'a'] })]) {
      writeFileSync(join(dir, hint), lie);
      const { host, thumbs } = fakeHost(recolour(state, 'color.brand', '#123456'), { root, shots: [shot(9)] });
      host.opening = 'open#2';
      expect(await thumbs.get(card, 'open#2')).toMatchObject({ state: 'ready', url: `data:image/png;base64,${PNG(9).toString('base64')}` });
      expect(host.captured).toBe(1);
    }
  });

  it('keeps by its version a picture whose page could not tell, a code component’s, or one shown with styles edited outside the app', async () => {
    const { state, card } = withCard();
    const unknown = fakeHost(state, { shots: [shot(1, null)] });
    expect(await unknown.thumbs.get(card, 'open#1')).toMatchObject({ key: thumbKey(state, card) });
    const edited = fakeHost(state, { shots: [shot(1)] });
    edited.host.ownStyles = false;
    expect(await edited.thumbs.get(card, 'open#1')).toMatchObject({ key: thumbKey(state, card) });
    // While they are edited, any colour change draws it again.
    edited.host.shots.push(shot(2));
    edited.host.state = recolour(state, 'color.brand', '#123456');
    expect(await edited.thumbs.get(card, 'open#1')).toMatchObject({ key: thumbKey(edited.host.state, card) });
    expect(edited.host.captured).toBe(2);
    // Restored: kept by what it reads again, and the brand no longer draws it again.
    edited.host.ownStyles = true;
    edited.host.shots.push(shot(3));
    edited.host.state = recolour(state, 'color.brand', '#234567');
    const kept = (await edited.thumbs.get(card, 'open#1')) as { key: string };
    expect(kept.key).not.toBe(thumbKey(edited.host.state, card));
    expect(edited.host.captured).toBe(3);
    edited.host.state = recolour(state, 'color.brand', '#345678');
    expect(await edited.thumbs.get(card, 'open#1')).toMatchObject({ key: kept.key });
    expect(edited.host.captured).toBe(3);
    // A code component's script can read any colour.
    const made = apply(state, [{ type: 'component.createCode', name: 'Note', source: '<p>Note</p>\n' }]);
    const code = made.results[0].definitionId as string;
    const scripted = fakeHost(made.state, { shots: [shot(1)] });
    expect(await scripted.thumbs.get(code, 'open#1')).toMatchObject({ key: thumbKey(made.state, code) });
    scripted.host.state = recolour(made.state, 'color.brand', '#123456');
    expect(await scripted.thumbs.get(code, 'open#1')).toMatchObject({ key: thumbKey(scripted.host.state, code) });
    expect(scripted.host.captured).toBe(2);
  });

  it('keeps by its version a picture shown with stylesheets on disk that are not the generated ones', async () => {
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state, { shots: [shot(1), shot(2)] });
    host.showsStyles = false;
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ key: thumbKey(state, card) });
    host.state = recolour(state, 'color.brand', '#123456');
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ key: thumbKey(host.state, card) });
    expect(host.captured).toBe(2);
    expect(host.hinted).toEqual([]);
  });

  it('keeps a picture by the palette the window drew it in', async () => {
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state, { shots: [shot(1), shot(2)] });
    const light = (await thumbs.get(card, 'open#1')) as { key: string };
    host.scheme = 'dark';
    const dark = (await thumbs.get(card, 'open#1')) as { key: string; url: string };
    expect(host.captured).toBe(2);
    expect(dark.key).not.toBe(light.key);
    expect(dark.url).toBe(`data:image/png;base64,${PNG(2).toString('base64')}`);
    host.scheme = 'light';
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ key: light.key, url: `data:image/png;base64,${PNG(1).toString('base64')}` });
    // The palette changing while it is photographed: kept by its version alone, never by the colours it reads.
    host.state = recolour(state, 'color.text', '#202020');
    host.shots.push(shot(3));
    host.onCapture = () => (host.scheme = 'dark');
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ key: thumbKey(host.state, card) });
  });

  it('finds a picture kept by its version when what its page read before is out of date', async () => {
    const root = tempDir();
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state, { root, shots: [shot(1), shot(2, null)] });
    await thumbs.get(card, 'open#1');
    // A colour it reads changes, and this time its page cannot tell what it reads: kept by its version.
    host.state = recolour(state, 'color.text', '#202020');
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ key: thumbKey(host.state, card), url: `data:image/png;base64,${PNG(2).toString('base64')}` });
    // Asked again, and in a later opening: found by its version, never photographed again.
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ key: thumbKey(host.state, card) });
    const later = fakeHost(host.state, { root });
    later.host.opening = 'open#2';
    expect(await later.thumbs.get(card, 'open#2')).toMatchObject({ key: thumbKey(host.state, card), url: `data:image/png;base64,${PNG(2).toString('base64')}` });
    expect(host.captured + later.host.captured).toBe(2);
  });

  it('keeps nothing of a hint it was still reading when the project closed', async () => {
    const root = tempDir();
    const { state, card } = withCard();
    await fakeHost(state, { root, shots: [shot(1)] }).thumbs.get(card, 'open#1');
    const { thumbs } = fakeHost(recolour(state, 'color.brand', '#123456'), { root });
    const asked = thumbs.get(card, 'open#1');
    thumbs.forget();
    expect(await asked).toEqual({ state: 'unavailable' });
    const held = thumbs as unknown as { hints: Map<string, unknown>; keys: unknown };
    expect([held.hints.size, held.keys]).toEqual([0, null]);
  });

  it('keeps by its version a design that places a code component', async () => {
    const { state, card } = withCard();
    const made = apply(state, [{ type: 'component.createCode', name: 'Note', source: '<p>Note</p>\n' }]);
    const code = made.results[0].definitionId as string;
    const root = made.state.components[card].tree!.rootIds[0];
    const placed = apply(made.state, [{ type: 'node.insert', owner: { kind: 'component', id: card }, parentId: root, definitionId: code }]).state;
    const { thumbs } = fakeHost(placed, { shots: [shot(1)] });
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ key: thumbKey(placed, card) });
  });

  it('answers every request that shared a photograph with the key the picture is kept under', async () => {
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state, { shots: [shot(1)] });
    const [a, b] = (await Promise.all([thumbs.get(card, 'open#1'), thumbs.get(card, 'open#1', thumbKey(state, card))])) as Array<{ key: string; url?: string }>;
    expect(host.captured).toBe(1);
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(thumbKey(state, card));
    // The second asked with the version's key, not the picture's: it gets the picture.
    expect(b.url).toBe(a.url);
  });

  it('keeps nothing of a photograph taken while a colour changed, even one its page does not read', async () => {
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state, { shots: [shot(1), shot(2)] });
    host.onCapture = () => (host.state = recolour(host.state, 'color.brand', '#123456'));
    expect(await thumbs.get(card, 'open#1')).toEqual({ state: 'unavailable' });
    host.onCapture = null;
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ state: 'ready', url: `data:image/png;base64,${PNG(2).toString('base64')}` });
    // Forgotten with the project.
    thumbs.forget();
    expect((thumbs as unknown as { hints: Map<string, unknown> }).hints.size).toBe(0);
  });

  it('is told apart only by the colours a page reads, and the rest of the brand stays whole', () => {
    const { state, card } = withCard();
    const parts = brandParts(state);
    expect(parts.colours.has('--so-color-brand')).toBe(true);
    const projected = colourProjection(parts.tokens, parts.colours, new Set(READS));
    const changed = brandParts(recolour(state, 'color.brand', '#123456'));
    expect(colourProjection(changed.tokens, changed.colours, new Set(READS))).toBe(projected);
    expect(changed.tokens).not.toBe(parts.tokens);
    // A spacing token is not a colour: it stays in, whatever the page reads.
    const spaced = brandParts(apply(state, [{ type: 'token.set', tokenId: 'space.lg', value: '3.25rem' }]).state);
    expect(colourProjection(spaced.tokens, spaced.colours, new Set(READS))).not.toBe(projected);
    expect(brandFingerprint(parts, READS)).toBe(brandFingerprint(changed, READS));
    expect(brandFingerprint(parts, READS)).not.toBe(brandFingerprint(parts, [...READS, '--so-color-brand'].sort()));
    expect(brandFingerprint(parts)).not.toBe(brandFingerprint(changed));
    expect(thumbKey(state, card, brandFingerprint(parts, READS))).toBe(thumbKey(state, card, brandFingerprint(changed, READS)));
  });
});
