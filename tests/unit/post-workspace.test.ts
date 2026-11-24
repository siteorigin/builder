/**
 * The Posts workspace in front of the editor (#578): while the writer covers the canvas, or the open post is previewed
 * on it, the toolbar and the Inspector name the post (or where its preview's visitor went), never the page under it.
 */
import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { postShown, postWorkspace, type PostRef } from '../../src/renderer/src/lib/posts';

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;

function blog(): ProjectState {
  return run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', publishedAt: '2027-03-02', draft: false },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_winter', title: 'Winter hours', publishedAt: '2026-11-14' }
  );
}

const spring: PostRef = { collectionId: 'posts', entryId: 'en_spring' };
const winter: PostRef = { collectionId: 'posts', entryId: 'en_winter' };

describe('the Posts workspace in front of the editor', () => {
  const base = { leftTab: 'posts', postView: 'write', mode: 'edit', post: spring } as const;

  it('is the writer while the Posts panel shows it, with a post or none chosen, and while a Preview waits for a save', () => {
    expect(postWorkspace(base)).toBe('write');
    expect(postWorkspace({ ...base, post: null })).toBe('write');
    // Preview chosen in the toolbar: the writer stays until what was typed is saved.
    expect(postWorkspace({ ...base, mode: 'preview' })).toBe('write');
    expect(postWorkspace({ ...base, mode: 'preview', post: null })).toBe('write');
  });

  it('is the post’s preview whichever panel the sidebar shows, and nothing once the page is shown', () => {
    const previewing = { ...base, postView: 'preview', mode: 'preview' } as const;
    expect(postWorkspace(previewing)).toBe('preview');
    expect(postWorkspace({ ...previewing, leftTab: null })).toBe('preview');
    expect(postWorkspace({ ...previewing, leftTab: 'pages' })).toBe('preview');
    expect(postWorkspace({ ...previewing, leftTab: 'layers' })).toBe('preview');
    // Preview with no post open is the page's own preview.
    expect(postWorkspace({ ...previewing, post: null })).toBeNull();
    // Another panel while writing shows the page again.
    expect(postWorkspace({ ...base, leftTab: 'pages' })).toBeNull();
    expect(postWorkspace({ ...base, leftTab: null })).toBeNull();
    expect(postWorkspace({ ...base, leftTab: 'layers', mode: 'preview' })).toBeNull();
    // Edit chosen during a post's preview: the page is what shows, before the writer comes back.
    expect(postWorkspace({ ...previewing, mode: 'edit' })).toBeNull();
    expect(postWorkspace({ ...previewing, leftTab: null, mode: 'edit' })).toBeNull();
  });
});

describe('what the editor names while the Posts workspace is in front', () => {
  const s = blog();
  const home = s.pages[s.site.homePageId];
  const about = Object.values(s.pages).find((p) => p.id !== home.id)!;

  it('names the post being written, never the page under the writer', () => {
    expect(postShown(s, 'write', spring, null)).toEqual({ kind: 'post', ref: spring, title: 'Spring open studio', draft: false });
    expect(postShown(s, 'write', winter, null)).toMatchObject({ kind: 'post', ref: winter, title: 'Winter hours', draft: true });
    // Where the last preview's visitor went is not what the writer shows.
    expect(postShown(s, 'write', spring, home.route)).toMatchObject({ kind: 'post', ref: spring });
    // A post saved without its draft mark is a draft, as the Posts list says.
    const unmarked = structuredClone(s);
    delete (unmarked.collections.posts.entries.en_spring as { draft?: boolean }).draft;
    expect(postShown(unmarked, 'write', spring, null)).toMatchObject({ kind: 'post', draft: true });
  });

  it('names the Posts workspace itself while no post is open, or the open one has gone', () => {
    expect(postShown(s, 'write', null, null)).toEqual({ kind: 'post', ref: null, title: 'Posts', draft: false });
    expect(postShown(s, 'write', { collectionId: 'posts', entryId: 'en_gone' }, null)).toEqual({ kind: 'post', ref: null, title: 'Posts', draft: false });
    expect(postShown(s, 'preview', { collectionId: 'posts', entryId: 'en_gone' }, null)).toEqual({ kind: 'post', ref: null, title: 'Posts', draft: false });
    // A post with no title yet is named as the Posts list names it.
    const blank = structuredClone(s);
    blank.collections.posts.entries.en_spring.title = '';
    expect(postShown(blank, 'write', spring, null)).toMatchObject({ kind: 'post', ref: spring, title: 'Untitled' });
  });

  it('names the previewed post until the canvas reports where it is, then wherever a visitor went on to', () => {
    // On its way: the page being left is never named in its place.
    expect(postShown(s, 'preview', spring, null)).toMatchObject({ kind: 'post', ref: spring, title: 'Spring open studio' });
    expect(postShown(s, 'preview', spring, '/blog/spring-open-studio/')).toMatchObject({ kind: 'post', ref: spring, draft: false });
    expect(postShown(s, 'preview', spring, '/blog/spring-open-studio')).toMatchObject({ kind: 'post', ref: spring });
    // A visitor's link to the home page, to another page, or to another post.
    expect(postShown(s, 'preview', spring, home.route)).toEqual({ kind: 'page', pageId: home.id });
    expect(postShown(s, 'preview', spring, about.route)).toEqual({ kind: 'page', pageId: about.id });
    expect(about.route).toMatch(/.\/$/);
    expect(postShown(s, 'preview', spring, about.route.slice(0, -1))).toEqual({ kind: 'page', pageId: about.id });
    expect(postShown(s, 'preview', spring, '/blog/winter-hours/')).toMatchObject({ kind: 'post', ref: winter, title: 'Winter hours', draft: true });
    // An address that is neither (an old one, the not-found page) is named as it is.
    expect(postShown(s, 'preview', spring, '/no-such-page/')).toEqual({ kind: 'address', path: '/no-such-page/' });
  });
});
