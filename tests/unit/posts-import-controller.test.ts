/**
 * Importing a WordPress export again through the controller (#1519): the review counts the posts already in the
 * project, skipping them changes nothing, and the author's choice to update them reaches the import, as one change.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostImportPreview } from '@shared/api';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => env.userData, getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  utilityProcess: { fork: () => undefined }
}));
// The import reader, read here rather than in its own process, with what the controller hands it.
vi.mock('../../src/main/posts-import/process', async () => {
  const { readWordPress } = await import('../../src/main/posts-import/wxr');
  return { postReader: { read: (_kind: string, file: string, pages: never, known: never) => readWordPress(file, pages, undefined, known), stop: () => undefined }, stopPostReads: () => undefined };
});

const { Controller } = await import('../../src/main/controller');
const { ProjectSession } = await import('../../src/main/project/session');
const { createStarterState } = await import('@catalogue/starters');
const sharp = (await import('sharp')).default;

const FIXTURES = join(__dirname, 'fixtures', 'posts-import');
const dirs: string[] = [];
const controllers: Array<InstanceType<typeof Controller>> = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-posts-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** The WordPress fixture with its pictures (each a small picture of its own colour), in a folder of its own. */
async function exportFolder(): Promise<string> {
  const dir = temp('wp');
  cpSync(join(FIXTURES, 'wordpress'), dir, { recursive: true });
  const files: Array<[string, number]> = [['uploads/2019/03/snow.jpg', 40], ['uploads/2019/03/loaf.jpg', 120], ['uploads/2019/04/tart.png', 200]];
  for (const [f, red] of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    const img = sharp({ create: { width: 16, height: 16, channels: 3, background: { r: red, g: 80, b: 60 } } });
    writeFileSync(join(dir, f), await (f.endsWith('.png') ? img.png() : img.jpeg()).toBuffer());
  }
  return dir;
}

async function open() {
  const dir = temp('project');
  await (await ProjectSession.create(dir, createStarterState('blank', 'Riverside Bakery', false))).close();
  const c = new Controller(() => null);
  c.send = () => undefined;
  c.startRuntime = async () => undefined;
  controllers.push(c);
  expect((await c.trustAndOpen(dir)).ok).toBe(true);
  await vi.waitFor(() => expect(c.snapshot()).not.toBeNull());
  return c;
}

const review = async (c: InstanceType<typeof Controller>, file: string): Promise<PostImportPreview> => {
  const r = await c.reviewPostImport('wordpress', c.snapshot()!.workspaceKey, file);
  if (!r.ok) throw new Error(r.message ?? 'no review');
  return r.preview;
};
const posts = (c: InstanceType<typeof Controller>) => Object.values(c.snapshot()!.state.collections.posts.entries);

describe('importing a WordPress export again (#1519)', { timeout: 60_000 }, () => {
  it('skips the posts already in the project, changing nothing, and updates them in place when chosen', async () => {
    const c = await open();
    const dir = await exportFolder();
    const file = join(dir, 'export.xml');
    const key = () => c.snapshot()!.workspaceKey;

    const first = await review(c, file);
    expect(first.existing).toBe(0);
    expect(await c.commitPostImport(first.id, key())).toMatchObject({ ok: true, imported: 3, updated: 0 });
    const before = posts(c);
    const revision = c.snapshot()!.revision;

    // The same export again: every post is known, and skipping them is no change at all.
    const again = await review(c, file);
    expect(again).toMatchObject({ existing: 3, pictures: 0, problems: [], update: { posts: 3, problems: [] } });
    expect(await c.commitPostImport(again.id, key(), 'skip')).toEqual({ ok: true, imported: 0, updated: 0 });
    expect(c.snapshot()!.revision).toBe(revision);
    expect(posts(c)).toEqual(before);

    // A later export: Winter's title changed, and a post written since. Updating takes both in one change.
    const later = readFileSync(file, 'utf8')
      .replace('<title><![CDATA[Winter workshop &amp; tasting]]></title>', '<title><![CDATA[Winter workshop, revised]]></title>')
      .replace(
        '</channel>',
        '<item><title><![CDATA[Autumn]]></title><link>https://riverside.example/2019/09/autumn/</link><pubDate>Sun, 01 Sep 2019 09:00:00 +0000</pubDate><dc:creator><![CDATA[sam]]></dc:creator><content:encoded><![CDATA[<p>Apples.</p>]]></content:encoded><excerpt:encoded><![CDATA[]]></excerpt:encoded><wp:post_id>20</wp:post_id><wp:post_date><![CDATA[2019-09-01 09:00:00]]></wp:post_date><wp:post_name><![CDATA[autumn]]></wp:post_name><wp:status><![CDATA[publish]]></wp:status><wp:post_type><![CDATA[post]]></wp:post_type></item></channel>'
      );
    writeFileSync(join(dir, 'later.xml'), later);
    const mixed = await review(c, join(dir, 'later.xml'));
    expect(mixed).toMatchObject({ existing: 3, problems: [], update: { posts: 3 } });
    const r = await c.commitPostImport(mixed.id, key(), 'update');
    expect(r).toMatchObject({ ok: true, imported: 1, updated: 3 });
    const after = posts(c);
    expect(after).toHaveLength(4);
    const winter = after.find((e) => e.id === before[0].id)!;
    expect([winter.title, winter.slug]).toEqual(['Winter workshop, revised', before[0].slug]);
    // The new post opens, not the first post updated.
    expect(r.firstEntryId).toBe(after.find((e) => e.title === 'Autumn')!.id);
    expect(c.snapshot()!.history.undoLabel).toBe('Import a post and update 3');
  });

  it('imports with the posts already here skipped when only updating them is stopped', async () => {
    const c = await open();
    const dir = await exportFolder();
    const file = join(dir, 'export.xml');
    const key = () => c.snapshot()!.workspaceKey;
    const first = await review(c, file);
    await c.commitPostImport(first.id, key());
    // Winter, already here, now brings more tags than the collection may hold; a new post brings none.
    const tags = Array.from({ length: 205 }, (_, i) => `<category domain="post_tag" nicename="t${i}"><![CDATA[Tag ${i}]]></category>`).join('');
    const later = readFileSync(file, 'utf8')
      .replace('<wp:post_id>12</wp:post_id>', `<wp:post_id>12</wp:post_id>${tags}`)
      .replace(
        '</channel>',
        '<item><title><![CDATA[Autumn]]></title><link>https://riverside.example/2019/09/autumn/</link><content:encoded><![CDATA[<p>Apples.</p>]]></content:encoded><wp:post_id>20</wp:post_id><wp:post_date><![CDATA[2019-09-01 09:00:00]]></wp:post_date><wp:post_name><![CDATA[autumn]]></wp:post_name><wp:status><![CDATA[publish]]></wp:status><wp:post_type><![CDATA[post]]></wp:post_type></item></channel>'
      );
    writeFileSync(join(dir, 'later.xml'), later);
    const p = await review(c, join(dir, 'later.xml'));
    expect(p.problems).toEqual([]);
    expect(p.update?.problems[0]).toMatch(/it can have at most 200/);
    expect(await c.commitPostImport(p.id, key(), 'update')).toMatchObject({ ok: false, message: expect.stringMatching(/at most 200/) });
    // That review is spent: a fresh one imports the new post alone.
    const again = await review(c, join(dir, 'later.xml'));
    expect(await c.commitPostImport(again.id, key(), 'skip')).toMatchObject({ ok: true, imported: 1, updated: 0 });
    expect(posts(c).map((e) => e.title)).toContain('Autumn');
    expect(Object.keys(c.snapshot()!.state.collections.posts.settings.taxonomies.tags.terms)).toEqual(['bread']);
  });
});
