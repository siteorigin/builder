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
import { ComponentThumbs, readThumb, thumbCrop, thumbKey, writeThumb, type CaptureResult, type ThumbHost } from '../../src/main/runtime/component-thumbs';

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

  it('changes with the site’s brand colours, fonts and language', () => {
    const { state, card } = withCard();
    const key = thumbKey(state, card);
    expect(thumbKey(apply(state, [{ type: 'token.set', tokenId: 'color.brand', value: '#123456' }]).state, card)).not.toBe(key);
    expect(thumbKey(apply(state, [{ type: 'token.set', tokenId: 'font.body', value: 'Georgia, serif' }]).state, card)).not.toBe(key);
    const french = structuredClone(state);
    french.site.language = 'fr';
    expect(thumbKey(french, card)).not.toBe(key);
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
function fakeHost(state: ProjectState, opts: { root?: string; shots?: Array<CaptureResult | Promise<CaptureResult>>; settle?: () => void; prepareFails?: number } = {}) {
  let prepareFails = opts.prepareFails ?? 0;
  const host = {
    state,
    opening: 'open#1' as string | null,
    server: 'http://127.0.0.1:5173' as string | null,
    prepared: [] as string[],
    released: [] as string[],
    persisted: [] as string[],
    captured: 0,
    shots: opts.shots ?? [],
    onCapture: null as (() => void) | null
  };
  const api: ThumbHost = {
    current: () => (host.opening ? { opening: host.opening, state: host.state, cacheRoot: opts.root ?? null, readRoot: opts.root ?? tempDir() } : null),
    previewServer: () => host.server,
    settle: async () => opts.settle?.(),
    prepare: async (definitionId): Promise<PreparedComponentPreview> => {
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
    }
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

  it('keeps nothing on disk for a project it may not write to', async () => {
    const { state, card } = withCard();
    const { host, thumbs } = fakeHost(state);
    expect(await thumbs.get(card, 'open#1')).toMatchObject({ state: 'ready' });
    expect(host.persisted).toEqual([]);
  });
});
