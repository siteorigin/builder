import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { seeded } from '../../scripts/perf/fixtures';

/** `v` and everything in it frozen: writing to any of it throws (modules are strict). */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/** The business starter with a page more, a blog of two posts and a project component placed on the new page. */
function project(): ProjectState {
  let s = createStarterState('business', 'Sharing', false);
  s = applyOperations(s, [
    { type: 'page.create', pageId: 'pg_extra', title: 'Extra', route: '/extra/', starter: 'about' },
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_one', title: 'One', publishedAt: '2026-01-01', draft: false, body: ['One.'] },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_two', title: 'Two', publishedAt: '2026-01-02', draft: false, body: ['Two.'] }
  ] as EditOperation[]).state;
  const made = applyOperations(s, [
    {
      type: 'component.upsert',
      name: 'Card',
      properties: {},
      nodes: [
        { kind: 'element', id: 'root', tag: 'article', children: ['title'] },
        { kind: 'text', id: 'title', tag: 'h3', text: 'A card' }
      ]
    } as EditOperation
  ]);
  const section = applyOperations(made.state, [{ type: 'node.insert', owner: { kind: 'page', id: 'pg_extra' }, parentId: null, componentId: 'layout.section' } as EditOperation]);
  return applyOperations(section.state, [{ type: 'node.insert', owner: { kind: 'page', id: 'pg_extra' }, parentId: section.results[0].nodeId as string, slot: 'content', definitionId: made.results[0].definitionId as string } as EditOperation]).state;
}

const hero = (s: ProjectState) => Object.values(s.pages[s.site.homePageId].nodes).find((n): n is InstanceNode => n.kind === 'instance' && typeof n.props.heading === 'string')!;
const setHeading = (s: ProjectState, value: string): EditOperation => ({ type: 'instance.setProp', owner: { kind: 'page', id: s.site.homePageId }, nodeId: hero(s).id, prop: 'heading', value }) as EditOperation;

describe('applying a batch to part of a project', () => {
  it('keeps every page, component, entry and document the edit does not change as the very object it was', () => {
    const s = project();
    const { state: next } = applyOperations(s, [setHeading(s, 'A new heading')]);
    const homeId = s.site.homePageId;
    expect(hero(next).props.heading).toBe('A new heading');
    expect(next).not.toBe(s);
    expect(next.pages[homeId]).not.toBe(s.pages[homeId]);
    for (const id of Object.keys(s.pages)) if (id !== homeId) expect(next.pages[id], id).toBe(s.pages[id]);
    for (const id of Object.keys(s.components)) expect(next.components[id], id).toBe(s.components[id]);
    expect(next.collections.posts).toBe(s.collections.posts);
    for (const k of ['manifest', 'site', 'tokens', 'assets', 'themeLock'] as const) expect(next[k], k).toBe(s[k]);
    // The same keys, in the same order, as a copy of the whole would have.
    expect(Object.keys(next)).toEqual(Object.keys(s));
    expect(Object.keys(next.pages)).toEqual(Object.keys(s.pages));
  });

  it('keeps a document the batch read but left as it was', () => {
    const s = project();
    // Renaming a page reads the header (its menu follows the pages) and changes only the page.
    const { state: next } = applyOperations(s, [{ type: 'page.update', pageId: 'pg_extra', title: 'Extra, renamed' } as EditOperation]);
    expect(next.pages.pg_extra.title).toBe('Extra, renamed');
    expect(next.pages[s.site.homePageId]).toBe(s.pages[s.site.homePageId]);
    expect(next.collections.posts.entries.en_one).toBe(s.collections.posts.entries.en_one);
  });

  it('gives the same state and results as applying it to a copy of the whole project, and never writes to what it was handed', () => {
    const s = project();
    const homeId = s.site.homePageId;
    const extraRoot = s.pages.pg_extra.rootIds[0];
    const ops = [
      setHeading(s, 'Changed'),
      { type: 'node.insert', owner: { kind: 'page', id: homeId }, parentId: null, componentId: 'layout.section' },
      { type: 'node.move', owner: { kind: 'page', id: 'pg_extra' }, nodeId: extraRoot, parentId: null, index: 0 },
      { type: 'page.create', pageId: 'pg_more', title: 'More', route: '/more/', starter: 'faq' },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_two', title: 'Two, again' },
      { type: 'page.update', pageId: 'pg_extra', route: '/extra-moved/' },
      { type: 'page.remove', pageId: 'pg_more' }
    ] as EditOperation[];
    // The same new IDs both times.
    const copy = seeded('apply-sharing', () => applyOperations(structuredClone(s), ops));
    const before = JSON.stringify(s);
    const frozen = seeded('apply-sharing', () => applyOperations(deepFreeze(s), ops));
    expect(JSON.stringify(frozen.state)).toBe(JSON.stringify(copy.state));
    expect(frozen.results).toEqual(copy.results);
    expect(JSON.stringify(s)).toBe(before);
    // What the batch left of the frozen project is still the project's own.
    expect(frozen.state.collections.posts.entries.en_one).toBe(s.collections.posts.entries.en_one);
  });

  it('leaves the state it was handed as it was when a batch is refused part way', () => {
    const s = deepFreeze(project());
    const before = JSON.stringify(s);
    expect(() => applyOperations(s, [setHeading(s, 'Changed'), { type: 'page.remove', pageId: 'pg_missing' } as EditOperation])).toThrow(EngineError);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('never writes through what an operation brings, even an object the state it was handed holds', () => {
    const s = project();
    const homeId = s.site.homePageId;
    const contact = Object.values(s.pages).find((p) => p.title === 'Contact')!.id;
    const about = Object.values(s.pages).find((p) => p.title === 'About')!.id;
    const [nodeId, prop] = Object.values(s.pages[homeId].nodes).flatMap((n) => (n.kind === 'instance' ? Object.entries(n.props).filter(([, v]) => (v as { target?: unknown })?.target === contact).map(([k]) => [n.id, k] as const) : []))[0];
    // An edit elsewhere: the next state holds Home, and the link in it, as the very objects this one does.
    const next = applyOperations(s, [{ type: 'page.update', pageId: 'pg_extra', title: 'Extra, renamed' } as EditOperation]).state;
    const kept = (next.pages[homeId].nodes[nodeId] as InstanceNode).props[prop];
    const before = JSON.stringify(next);
    // The link set to itself, then its page removed (which points links to it elsewhere), then a failure.
    const ops = [
      { type: 'instance.setProp', owner: { kind: 'page', id: homeId }, nodeId, prop, value: kept },
      { type: 'page.remove', pageId: contact, replacementPageId: about },
      { type: 'page.remove', pageId: 'pg_missing' }
    ] as EditOperation[];
    expect(() => applyOperations(next, ops)).toThrow(EngineError);
    expect(JSON.stringify(next)).toBe(before);
    expect((kept as { target: string }).target).toBe(contact);
  });

  it('fixes a managed design’s dependencies on a copy of it, never on the one it was handed', () => {
    const s = project();
    const card = Object.values(s.components).find((d) => d.owner === 'project' && d.kind === 'managed')!;
    // Stale, as a hand edit could leave it: the batch puts it right whatever it changes.
    const stale = { ...s, components: { ...s.components, [card.id]: { ...card, dependencies: ['missing'] } } };
    deepFreeze(stale);
    const { state: next } = applyOperations(stale, [setHeading(stale, 'Changed')]);
    expect(next.components[card.id].dependencies).toEqual(card.dependencies);
    expect(stale.components[card.id].dependencies).toEqual(['missing']);
  });
});
