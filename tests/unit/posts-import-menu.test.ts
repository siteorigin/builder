/**
 * The blog an import makes gets its link in the header menu when the review asks for one (#1509), in the one change the
 * posts land as, and the result says whether the link joined. The controller reads, reviews and commits a real folder
 * of Markdown posts, read in this process rather than the reader's own.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectState } from '@shared/types';

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

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: {},
  utilityProcess: { fork: () => new FakeWorker() }
}));
// A picture's copies are made in a worker of the app's own: here it joins the library as its record alone.
vi.mock('../../src/main/project/assets', async (original) => ({
  ...(await original<typeof import('../../src/main/project/assets')>()),
  importPackageImage: async () => ({ existing: false, record: { id: 'a_oven', name: 'oven', file: 'static/assets/oven-1a2b3c4d.png', mime: 'image/png', bytes: 10, hash: 'oven', kind: 'image', createdAt: '2026-01-01T00:00:00.000Z' } })
}));
vi.mock('../../src/main/posts-import/process', async () => {
  const { readMarkdownFolder } = await import('../../src/main/posts-import/folder');
  return { postReader: { read: (_kind: string, path: string, pages: Parameters<typeof readMarkdownFolder>[1]) => readMarkdownFolder(path, pages) }, stopPostReads: () => undefined };
});

const { createStarterState } = await import('@catalogue/starters');
const { headerMenu } = await import('@engine/tree');
const { applyOperations } = await import('@engine/apply');
const { ProjectSession } = await import('../../src/main/project/session');
const { Controller } = await import('../../src/main/controller');

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
const controllers: Array<InstanceType<typeof Controller>> = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const links = (s: ProjectState) => (headerMenu(s)!.node.props.links ?? headerMenu(s)!.schema.default) as Array<{ label: string; link: unknown }>;
const titles = (s: ProjectState) => Object.values(s.collections.posts.entries).map((e) => e.title);

/** A new Business site, open, with a review of one post that shows a picture: its picture is added before the blog is. */
async function reviewed({ picture = true, fullMenu = false } = {}) {
  env.userData = tmp('so-import-userdata-');
  const dir = tmp('so-import-site-');
  let site = createStarterState('business', 'Riverside Bakery', false);
  if (fullMenu) {
    const menu = headerMenu(site)!;
    const value = Array.from({ length: menu.schema.max! }, (_, i) => ({ label: `Link ${i + 1}`, link: { type: 'page' as const, target: site.site.homePageId } }));
    site = applyOperations(site, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: menu.node.id, prop: 'links', value }]).state;
  }
  await (await ProjectSession.create(dir, site)).close();
  const posts = tmp('so-import-posts-');
  mkdirSync(join(posts, 'images'));
  writeFileSync(join(posts, 'images', 'oven.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  writeFileSync(join(posts, '2026-01-02-bread.md'), '---\ntitle: Bread\n---\nFresh today.\n' + (picture ? '\n![The oven](images/oven.png)\n' : ''));
  const c = new Controller(() => null);
  c.send = () => undefined;
  controllers.push(c);
  // No preview: starting one would install the website's packages.
  c.windowClosed();
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  const opening = c.snapshot()!.workspaceKey;
  const review = await c.reviewPostImport('markdown', opening, posts);
  if (!review.ok) throw new Error(review.message);
  return { c, commit: (addToNavigation: boolean) => c.commitPostImport(review.preview.id, opening, addToNavigation) };
}

describe('the header link of a blog an import makes (#1509)', () => {
  it('joins the header menu with the posts, and one Undo takes both back', async () => {
    const { c, commit } = await reviewed();
    const before = links(c.snapshot()!.state);
    const r = await commit(true);
    expect(r).toMatchObject({ ok: true, imported: 1, addedToNavigation: true });
    expect(r.notes).toBeUndefined();
    const after = c.snapshot()!.state;
    expect(Object.keys(after.assets.assets)).toContain('a_oven');
    expect(titles(after)).toEqual(['Bread']);
    expect(JSON.stringify(after.collections.posts.entries)).toContain('a_oven');
    expect(links(after).slice(0, before.length)).toEqual(before);
    expect(links(after).slice(before.length)).toMatchObject([{ label: 'Blog', link: { type: 'collection', target: 'posts' } }]);
    expect((await c.session!.undo()).ok).toBe(true);
    expect(c.snapshot()!.state.collections.posts).toBeUndefined();
    expect(links(c.snapshot()!.state)).toEqual(before);
  });

  it('leaves the menu as it is when no link is asked for, and says nothing of one', async () => {
    const { c, commit } = await reviewed();
    const before = links(c.snapshot()!.state);
    const r = await commit(false);
    expect(r).toMatchObject({ ok: true, imported: 1 });
    expect(r).not.toHaveProperty('addedToNavigation');
    expect(titles(c.snapshot()!.state)).toEqual(['Bread']);
    expect(links(c.snapshot()!.state)).toEqual(before);
  });

  it('still imports into a full menu, and says the link did not join', async () => {
    // No picture, so the collection is made by the batch's first operation.
    const { c, commit } = await reviewed({ picture: false, fullMenu: true });
    const before = links(c.snapshot()!.state);
    expect(await commit(true)).toMatchObject({ ok: true, imported: 1, addedToNavigation: false });
    expect(titles(c.snapshot()!.state)).toEqual(['Bread']);
    expect(links(c.snapshot()!.state)).toEqual(before);
  });
});
