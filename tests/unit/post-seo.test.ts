/**
 * A post's Search & sharing settings edited in the SEO view (#703) save as they do from the post writer: the same
 * trimmed text, the same result in the project and the same undo step. When the writer holds that same post, it
 * follows each change as one of its own, so its Publish and Save draft wait for it and hear when it was refused; a
 * writer holding another post is left alone. The editor's own save runs against a real project session behind a
 * stand-in for the preload bridge, so the labels checked are the ones History keeps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryDoc } from '@shared/types';
import type { ProjectSnapshot } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { ProjectSession } from '../../src/main/project/session';
import { image as picture } from './fixtures/seo-site';

let session: ProjectSession;
const opening = 'opening#post-seo';
const bridge = {
  project: {
    apply: (batch: Parameters<ProjectSession['apply']>[0], opts: { label?: string; coalesceKey?: string } = {}) => session.apply(batch, { label: opts.label ?? 'Edit', coalesceKey: opts.coalesceKey, source: 'user' }).then(refresh),
    saveLocalState: async () => {}
  },
  ai: { stop: async () => {} },
  platform: 'darwin'
};
vi.stubGlobal('window', { builder: bridge });

// The editor's store and libraries are DOM code, outside this test project's types: loaded by a path the type checker
// does not follow, with just the shapes this test uses.
type PostRef = { collectionId: string; entryId: string };
type Edit = { fields: Record<string, unknown>; label: string };
type Change = { kind: 'title' | 'description'; text: string } | { kind: 'socialImage'; assetId: string | null } | { kind: 'canonical'; url: string } | { kind: 'noindex' | 'searchHidden'; on: boolean };
const load = (path: string) => import(/* @vite-ignore */ path);
const { postSeoEdit, savePostSeo } = (await load('../../src/renderer/src/lib/post-seo')) as {
  postSeoEdit: (entry: EntryDoc, change: Change) => Edit | null;
  savePostSeo: (post: PostRef, edit: Edit) => Promise<unknown[] | null>;
};
const { setOpenWriter } = (await load('../../src/renderer/src/lib/post-draft')) as {
  setOpenWriter: (flush: () => Promise<boolean>, all?: () => Promise<boolean>, post?: PostRef, follow?: (change: Promise<unknown>) => void) => () => void;
};
const store = (await load('../../src/renderer/src/store')) as {
  setState: (p: Record<string, unknown>) => void;
  getState: () => { snapshot: ProjectSnapshot | null; heldEdits: Array<{ phase?: string; currentText?: string }> };
  commitDraft: <T>(base: ProjectSnapshot | null, commit: () => T, text?: string | null, opts?: { control?: object }) => T;
  applyOps: (operations: unknown[], label: string) => Promise<unknown[] | null>;
};
const { setState } = store;

function refresh<T>(r: T): T {
  setState({ snapshot: { state: session.state, revision: session.revision, history: session.historyInfo(), workspaceKey: opening, aiBusy: false, dir: 'project' } as unknown as ProjectSnapshot });
  return r;
}

const spring: PostRef = { collectionId: 'posts', entryId: 'en_spring' };
const winter: PostRef = { collectionId: 'posts', entryId: 'en_winter' };
const blog = applyOperations(createStarterState('business', 'Studio', false), [
  { type: 'collection.create', collectionId: 'posts' },
  { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring classes', publishedAt: '2027-03-02', draft: false, excerpt: 'Wheel classes.' },
  { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter hours', publishedAt: '2026-11-14' }
]).state;
blog.assets.assets.img_bowls = picture('img_bowls');
const image = blog.assets.assets.img_bowls;

const dirs: string[] = [];
const offs: Array<() => void> = [];
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'so-post-seo-'));
  dirs.push(dir);
  session = await ProjectSession.create(dir, blog);
  setState({ toasts: [], heldEdits: [] });
  refresh(null);
});
afterEach(async () => {
  offs.splice(0).forEach((off) => off());
  await session.close();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const entry = (ref: PostRef = spring) => session.state.collections[ref.collectionId].entries[ref.entryId];
const newest = () => session.historyInfo().entries.at(-1)!.label;
/** Save a change as the view's field does: worked out from the post as it shows, then saved. */
const change = async (c: Change, ref: PostRef = spring) => {
  const edit = postSeoEdit(entry(ref), c);
  return edit ? savePostSeo(ref, edit) : undefined;
};
/** A writer holding `post`, out of sight under the view, that records the changes it follows. */
const writerOn = (post: PostRef | undefined) => {
  const followed: Array<Promise<unknown>> = [];
  offs.push(setOpenWriter(async () => true, async () => true, post, (c) => void followed.push(c)));
  return followed;
};

describe('what a change to a post’s search settings writes', () => {
  const post = (seo: EntryDoc['seo']) => ({ ...blog.collections.posts.entries.en_spring, seo }) as EntryDoc;

  it('trims the title and description, and writes nothing when only spaces at their ends changed', () => {
    expect(postSeoEdit(post({}), { kind: 'title', text: '  Spring at Riverside  ' })).toEqual({ fields: { seoTitle: 'Spring at Riverside' }, label: 'Change post browser title' });
    expect(postSeoEdit(post({ title: 'Spring at Riverside' }), { kind: 'title', text: ' Spring at Riverside ' })).toBeNull();
    expect(postSeoEdit(post({}), { kind: 'description', text: ' Wheel and glaze. ' })).toEqual({ fields: { description: 'Wheel and glaze.' }, label: 'Change post description' });
    expect(postSeoEdit(post({ description: 'Wheel and glaze.' }), { kind: 'description', text: 'Wheel and glaze.\n' })).toBeNull();
    // Emptied, it clears the setting, so the fallback shows; spaces alone are emptied too.
    expect(postSeoEdit(post({ title: 'Spring at Riverside' }), { kind: 'title', text: '   ' })).toEqual({ fields: { seoTitle: '' }, label: 'Change post browser title' });
    expect(postSeoEdit(post({}), { kind: 'title', text: '' })).toBeNull();
  });

  it('names each setting’s change as the writer does', () => {
    const p = post({});
    expect(postSeoEdit(p, { kind: 'socialImage', assetId: 'as_1' })).toEqual({ fields: { socialImage: 'as_1' }, label: 'Change post sharing image' });
    expect(postSeoEdit(p, { kind: 'socialImage', assetId: null })).toEqual({ fields: { socialImage: null }, label: 'Use the default sharing image' });
    expect(postSeoEdit(p, { kind: 'canonical', url: 'https://elsewhere.example/spring/' })).toEqual({ fields: { canonical: 'https://elsewhere.example/spring/' }, label: 'Change post canonical URL' });
    expect(postSeoEdit(p, { kind: 'canonical', url: '' })).toEqual({ fields: { canonical: '' }, label: 'Clear post canonical URL' });
    expect(postSeoEdit(p, { kind: 'noindex', on: true })).toEqual({ fields: { noindex: true }, label: 'Hide post from search engines' });
    expect(postSeoEdit(p, { kind: 'noindex', on: false })).toEqual({ fields: { noindex: false }, label: 'Show post to search engines' });
    expect(postSeoEdit(p, { kind: 'searchHidden', on: true })).toEqual({ fields: { searchHidden: true }, label: 'Hide post from site search' });
    expect(postSeoEdit(p, { kind: 'searchHidden', on: false })).toEqual({ fields: { searchHidden: false }, label: 'Show post in site search' });
  });
});

describe('saving a post’s search settings from the SEO view', () => {
  it('saves every setting with no writer open, as one undo step each named as the writer names it', async () => {
    await change({ kind: 'title', text: '  Spring at Riverside  ' });
    expect(entry().seo?.title).toBe('Spring at Riverside');
    expect(newest()).toBe('Change post browser title');
    await change({ kind: 'description', text: 'Throw, glaze and fire at the spring open studio. ' });
    expect(entry().seo?.description).toBe('Throw, glaze and fire at the spring open studio.');
    expect(newest()).toBe('Change post description');
    await change({ kind: 'socialImage', assetId: image.id });
    expect(entry().seo?.socialImage).toBe(image.id);
    expect(newest()).toBe('Change post sharing image');
    await change({ kind: 'canonical', url: 'https://elsewhere.example/spring/' });
    expect(entry().seo?.canonical).toBe('https://elsewhere.example/spring/');
    expect(newest()).toBe('Change post canonical URL');
    await change({ kind: 'noindex', on: true });
    expect(entry().seo?.noindex).toBe(true);
    expect(newest()).toBe('Hide post from search engines');
    await change({ kind: 'searchHidden', on: true });
    expect(entry().seo?.searchHidden).toBe(true);
    expect(newest()).toBe('Hide post from site search');
    // Each back to its fallback.
    const steps = session.historyInfo().entries.length;
    await change({ kind: 'title', text: '' });
    await change({ kind: 'socialImage', assetId: null });
    await change({ kind: 'canonical', url: '' });
    expect(entry().seo?.title).toBeUndefined();
    expect(entry().seo?.socialImage).toBeUndefined();
    expect(entry().seo?.canonical).toBeUndefined();
    expect(session.historyInfo().entries.map((e) => e.label).slice(steps)).toEqual(['Change post browser title', 'Use the default sharing image', 'Clear post canonical URL']);
    // Only spaces changed: nothing is written.
    await change({ kind: 'description', text: '  Throw, glaze and fire at the spring open studio.' });
    expect(session.historyInfo().entries.length).toBe(steps + 3);
    // The other post is untouched throughout.
    expect(entry(winter).seo ?? {}).toEqual({});
  });

  it('leaves the post as the writer’s own save of the same change does', async () => {
    const edit = postSeoEdit(entry(), { kind: 'description', text: ' Wheel and glaze. ' })!;
    await savePostSeo(spring, edit);
    const fromView = entry();
    // The writer's own: the same edit, sent through its update (PostWriter's `update(edit.fields, edit.label)`).
    const writer = applyOperations(blog, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', ...edit.fields } as never]).state.collections.posts.entries.en_spring;
    expect(fromView.seo).toEqual(writer.seo);
    expect(fromView.body).toEqual(writer.body);
    expect(fromView.title).toBe(writer.title);
  });

  it('hands each change to the writer while it holds the same post, so Publish and Save draft wait for it', async () => {
    const followed = writerOn(spring);
    const saving = change({ kind: 'title', text: 'Spring at Riverside' });
    expect(followed).toHaveLength(1);
    // What the writer follows is the save itself: it settles once the change is in the project.
    const heard = await followed[0];
    expect(heard).toEqual(await saving);
    expect(heard).not.toBeNull();
    expect(entry().seo?.title).toBe('Spring at Riverside');
    await change({ kind: 'noindex', on: true });
    await change({ kind: 'socialImage', assetId: null });
    expect(followed).toHaveLength(3);
  });

  it('never hands a change to a writer holding another post, or not saying which', async () => {
    const other = writerOn(winter);
    await change({ kind: 'title', text: 'Spring at Riverside' });
    expect(other).toHaveLength(0);
    // The same entry ID in another collection is another post.
    const elsewhere = writerOn({ collectionId: 'news', entryId: 'en_spring' });
    await change({ kind: 'description', text: 'Wheel and glaze.' });
    expect(elsewhere).toHaveLength(0);
    const unnamed = writerOn(undefined);
    await change({ kind: 'noindex', on: true });
    expect(unnamed).toHaveLength(0);
    // Saved all the same.
    expect(entry().seo).toMatchObject({ title: 'Spring at Riverside', description: 'Wheel and glaze.', noindex: true });
  });

  it('lets the writer hear a change the project refused', async () => {
    const followed = writerOn(spring);
    const edit = postSeoEdit(entry(), { kind: 'title', text: 'Spring at Riverside' })!;
    // The post is removed after the view showed it: its change is refused, and the writer hears so.
    await session.apply({ operations: [{ type: 'entry.remove', collectionId: 'posts', entryId: 'en_spring' }] }, { label: 'Delete post', source: 'user' });
    refresh(null);
    expect(await savePostSeo(spring, edit)).toBeNull();
    expect(followed).toHaveLength(1);
    expect(await followed[0]).toBeNull();
  });

  it('stops handing changes over once the writer lets go of the post', async () => {
    const followed: Array<Promise<unknown>> = [];
    const off = setOpenWriter(async () => true, undefined, spring, (c) => void followed.push(c));
    off();
    await change({ kind: 'title', text: 'Spring at Riverside' });
    expect(followed).toHaveLength(0);
    expect(entry().seo?.title).toBe('Spring at Riverside');
  });
});

describe('the same search title typed in the writer and in the view', () => {
  /** Commit `text` as a typed edit of the post's browser title, typed in `control` from the project at `base`. */
  const typed = async (control: object, text: string, base: ProjectSnapshot | null) => {
    let done: Promise<unknown> = Promise.resolve();
    store.commitDraft(base, () => (done = store.applyOps([{ type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', seoTitle: text }], 'Change post browser title')), text, { control });
    await done;
  };

  it('never writes the writer’s text, typed before, over a title saved in the view since: it waits for the author', async () => {
    const writer = {};
    const view = {};
    // The writer's text was typed from the project as it was then (kept for being too long to save, say).
    const before = store.getState().snapshot;
    await typed(view, 'Saved in the view', before);
    expect(entry().seo?.title).toBe('Saved in the view');
    // Shortened and saved in the writer afterwards: the title saved in the view stays, and the writer's text is held.
    await typed(writer, 'Typed in the writer', before);
    expect(entry().seo?.title).toBe('Saved in the view');
    expect(store.getState().heldEdits[0]).toMatchObject({ phase: 'changed', currentText: 'Saved in the view' });
  });

  it('still writes over a control’s own save of the title that this window had not heard of', async () => {
    const view = {};
    const before = store.getState().snapshot;
    await typed(view, 'First words', before);
    await typed(view, 'Second words', before);
    expect(entry().seo?.title).toBe('Second words');
    expect(store.getState().heldEdits).toEqual([]);
  });
});
