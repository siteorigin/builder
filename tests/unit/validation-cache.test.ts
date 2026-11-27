/**
 * A session's validation keeps each document's checks while the rest of the project reads the same (#966): an edit
 * of one page checks that page again, and every other page's findings are the ones worked out before. Whatever is
 * kept, each state's findings are exactly what a validation of that state on its own gives, in the same order.
 */
import { describe, expect, it } from 'vitest';
import type { AssetRecord, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { listThemes, registerPacks } from '@catalogue/index';
import { FOUNDATION_AUTHOR } from './fixtures/packs';
import { makeInstance } from '@engine/install';
import { applyOperations, assetUsages } from '@engine/apply';
import { adviceValidation, blocksSaving, coreValidation, joinValidation, type Diagnostic } from '@engine/validate';
import { ValidationCache } from '@engine/validation-cache';
import { trackedNestingChecker } from '@engine/semantic-tags';

const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;
const page = (id: string) => ({ kind: 'page' as const, id });
const IMAGE: AssetRecord = { id: 'a_photo', name: 'photo.jpg', file: 'static/assets/photo.jpg', mime: 'image/jpeg', bytes: 1, width: 1200, height: 800, hash: 'x', kind: 'image', createdAt: '' };

/** The cached core, advice, Project health's list and the save gate's problems of `state`, beside a validation of a copy of it alone. */
function expectFresh(cache: ValidationCache, state: ProjectState) {
  const alone = structuredClone(state);
  const core = coreValidation(state, cache);
  const advice = adviceValidation(state, cache);
  expect(core).toStrictEqual(coreValidation(alone));
  expect(advice).toStrictEqual(adviceValidation(alone));
  expect(joinValidation(core, advice)).toStrictEqual(joinValidation(coreValidation(alone), adviceValidation(alone)));
  expect(core.core.filter(blocksSaving)).toStrictEqual(coreValidation(alone).core.filter(blocksSaving));
  return joinValidation(core, advice);
}

/**
 * The Business starter with two more pages, a picture without a description on each so every page has a finding of
 * its own, and the home page's hero.
 */
function project() {
  let s = createStarterState('business', 'Kept', false);
  s = apply(s, [
    { type: 'asset.add', asset: IMAGE },
    { type: 'page.create', pageId: 'pg_one', title: 'One', route: '/one/' },
    { type: 'page.create', pageId: 'pg_two', title: 'Two', route: '/two/' }
  ] as EditOperation[]);
  for (const id of [s.site.homePageId, 'pg_one', 'pg_two'])
    s = apply(s, [
      { type: 'node.insert', owner: page(id), primitive: 'image', newNodeId: `n_pic_${id.slice(-4)}` },
      { type: 'node.setContent', owner: page(id), nodeId: `n_pic_${id.slice(-4)}`, field: 'image', value: { assetId: IMAGE.id, alt: '' } }
    ] as EditOperation[]);
  const home = s.pages[s.site.homePageId];
  const hero = Object.values(home.nodes).find((n) => n.kind === 'instance' && 'heading' in n.props)!;
  return { s, home: s.site.homePageId, hero: hero.id };
}

const heading = (home: string, hero: string, text: string): EditOperation => ({ type: 'instance.setProp', owner: page(home), nodeId: hero, prop: 'heading', value: text }) as EditOperation;
const altOn = (list: Diagnostic[], id: string) => list.find((d) => d.code === 'ALT_MISSING' && d.owner?.id === id);

describe('a session’s validation keeps what an edit leaves alone (#966)', () => {
  it('uses an unchanged page’s findings again, and checks the edited page again', () => {
    const { s, home, hero } = project();
    const cache = new ValidationCache();
    const before = expectFresh(cache, s);
    const after = expectFresh(cache, apply(s, [heading(home, hero, 'Changed')]));
    // The same objects for the pages the edit left alone, worked out again for the one it changed.
    expect(altOn(after, 'pg_one')).toBeDefined();
    expect(altOn(after, 'pg_one')).toBe(altOn(before, 'pg_one'));
    expect(altOn(after, 'pg_two')).toBe(altOn(before, 'pg_two'));
    expect(altOn(after, home)).toEqual(altOn(before, home));
    expect(altOn(after, home)).not.toBe(altOn(before, home));
  });

  it('checks every page again when something they read changes', () => {
    const { s, home, hero } = project();
    const edits: Array<[string, (st: ProjectState) => ProjectState]> = [
      ['another page renamed', (st) => apply(st, [{ type: 'page.update', pageId: 'pg_two', title: 'Second' } as EditOperation])],
      ['the library changed', (st) => apply(st, [{ type: 'asset.update', assetId: IMAGE.id, name: 'Renamed photo' } as EditOperation])],
      ['the shared header edited', (st) => {
        const header = st.site.shell.header;
        const node = Object.values(header.nodes).find((n) => n.kind === 'instance')!;
        return apply(st, [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: node.id, prop: 'ctaLabel', value: 'Call us' } as EditOperation]);
      }],
      // A card renders as its plain container once something interactive is inside it, wherever that card is shown.
      ['a card broken on another page', (st) =>
        apply(st, [
          { type: 'node.insert', owner: page(home), parentId: null, primitive: 'row', newNodeId: 'n_card01' },
          { type: 'node.setContent', owner: page(home), nodeId: 'n_card01', field: 'link', value: { type: 'url', target: 'https://example.com' } },
          { type: 'node.insert', owner: page(home), parentId: 'n_card01', primitive: 'button', newNodeId: 'n_cardbtn' }
        ] as EditOperation[])],
      ['the theme packs loaded again', (st) => {
        registerPacks([...listThemes()]);
        return apply(st, [heading(home, hero, 'Again')]);
      }]
    ];
    for (const [what, edit] of edits) {
      const cache = new ValidationCache();
      const before = expectFresh(cache, s);
      const after = expectFresh(cache, edit(s));
      if (what.startsWith('a card')) expect(after.map((d) => d.code)).toContain('CARD_LINK_INTERACTIVE');
      expect(altOn(after, 'pg_one'), what).toBeDefined();
      expect(altOn(after, 'pg_one'), what).not.toBe(altOn(before, 'pg_one'));
    }
  });

  it('finds a link broken on a page the edit left alone, when the edit removes the page it goes to', () => {
    const { s } = project();
    const cache = new ValidationCache();
    const linked = apply(s, [
      { type: 'node.insert', owner: page('pg_one'), primitive: 'button', newNodeId: 'n_btn_one' },
      { type: 'node.setContent', owner: page('pg_one'), nodeId: 'n_btn_one', field: 'link', value: { type: 'page', target: 'pg_two' } }
    ] as EditOperation[]);
    expect(expectFresh(cache, linked).filter((d) => d.code === 'LINK_BROKEN')).toEqual([]);
    // Removed by hand, as an outside change can (an edit asks where the link should go instead).
    const pages = { ...linked.pages };
    delete pages.pg_two;
    const gone = { ...linked, pages, site: { ...linked.site, pageOrder: linked.site.pageOrder.filter((id) => id !== 'pg_two') } };
    expect(gone.pages.pg_one).toBe(linked.pages.pg_one);
    expect(expectFresh(cache, gone).filter((d) => d.code === 'LINK_BROKEN').map((d) => d.owner?.id)).toEqual(['pg_one']);
  });

  it('finds a section link broken on a page the edit left alone, when the edit takes the section away', () => {
    const { s } = project();
    const cache = new ValidationCache();
    const anchored = apply(s, [
      { type: 'node.insert', owner: page('pg_two'), parentId: null, primitive: 'stack', newNodeId: 'n_prices' },
      { type: 'node.setContent', owner: page('pg_two'), nodeId: 'n_prices', field: 'anchor', value: 'prices' },
      { type: 'node.insert', owner: page('pg_one'), primitive: 'button', newNodeId: 'n_to_prices' },
      { type: 'node.setContent', owner: page('pg_one'), nodeId: 'n_to_prices', field: 'link', value: { type: 'page', target: 'pg_two', anchor: 'prices' } }
    ] as EditOperation[]);
    const missing = (st: ProjectState) => expectFresh(cache, st).filter((d) => d.code === 'LINK_SECTION_MISSING' && d.owner?.id === 'pg_one');
    expect(missing(anchored)).toEqual([]);
    const gone = apply(anchored, [{ type: 'node.remove', owner: page('pg_two'), nodeId: 'n_prices' } as EditOperation]);
    expect(gone.pages.pg_one).toBe(anchored.pages.pg_one);
    expect(missing(gone)).toHaveLength(1);
    expect(missing(anchored)).toEqual([]);
  });

  it('checks a state it has seen again once the theme packs are loaded again', () => {
    const { s } = project();
    const cache = new ValidationCache();
    const before = expectFresh(cache, s);
    expect(altOn(expectFresh(cache, s), 'pg_one')).toBe(altOn(before, 'pg_one'));
    registerPacks([...listThemes()]);
    expect(altOn(expectFresh(cache, s), 'pg_one')).not.toBe(altOn(before, 'pg_one'));
  });

  it('checks a design again when a placement on a page moves out of the description list its edge relies on', () => {
    // As semantic-tags.test.ts: a design whose edge is a description list's group is judged by where it is placed.
    let s = createStarterState('blank', 'Terms', false);
    const o = page(s.site.homePageId);
    s = apply(s, [
      { type: 'node.insert', newNodeId: 'n_stack01', owner: o, parentId: null, primitive: 'stack' },
      { type: 'node.insert', newNodeId: 'n_row0001', owner: o, parentId: 'n_stack01', primitive: 'row' },
      { type: 'node.insert', newNodeId: 'n_text0001', owner: o, parentId: 'n_row0001', primitive: 'paragraph', text: 'Price' },
      { type: 'node.insert', newNodeId: 'n_text0002', owner: o, parentId: 'n_row0001', primitive: 'paragraph', text: '$10' },
      { type: 'node.setContent', owner: o, nodeId: 'n_stack01', field: 'tag', value: 'dl' },
      { type: 'node.setContent', owner: o, nodeId: 'n_text0001', field: 'tag', value: 'dt' },
      { type: 'component.createFromNode', owner: o, nodeId: 'n_row0001', name: 'Term group' }
    ] as EditOperation[]);
    const def = Object.values(s.components).find((d) => d.name === 'Term group')!;
    const term = Object.values(def.tree!.nodes).find((n) => n.kind === 'text' && n.tag === 'dt')!.id;
    const cache = new ValidationCache();
    const termError = (list: Diagnostic[]) => list.find((d) => d.code === 'TAG_NESTING' && d.nodeId === term && d.severity === 'error');
    expect(termError(expectFresh(cache, s))).toBeUndefined();
    const loose = apply(s, [{ type: 'node.insert', owner: o, parentId: null, definitionId: def.id } as EditOperation]);
    // The design itself is the same object: only where it is placed changed.
    expect(loose.components[def.id]).toBe(s.components[def.id]);
    expect(termError(expectFresh(cache, loose))?.message).toMatch(/is a term or description/);
  });

  it('checks nesting in turn again when two designs hold each other through their slots', () => {
    // Edited by hand: each design shows the other's slot content inside its own slot, so a walk up from either meets
    // itself, and what it works out depends on where it began.
    let s = createStarterState('blank', 'Loop', false);
    s = apply(s, [{ type: 'page.create', pageId: 'pg_other', title: 'Other', route: '/other/' } as EditOperation]);
    s = structuredClone(s);
    const { managed } = FOUNDATION_AUTHOR;
    const make = (componentId: string, name: string, slot: string) => ({ ...managed({ category: 'content', tags: [], icon: 'sparkles', description: '', componentId, name, properties: {}, parts: {}, slots: { [slot]: { label: slot } }, build: (b) => b.el('root', 'div', {}, []) }), owner: 'project' as const });
    const one = make('test.loop-one', 'Loop one', 's');
    const two = make('test.loop-two', 'Loop two', 't');
    const hold = (outer: typeof one, inner: typeof two, outlet: string, slot: string) => {
      const placed = makeInstance(inner, {});
      placed.slots = { [slot]: [`out_${outlet}`] };
      outer.tree!.nodes[placed.id] = placed;
      outer.tree!.nodes[`out_${outlet}`] = { kind: 'slot', id: `out_${outlet}`, slot: outlet } as never;
      (outer.tree!.nodes.root as { children: string[] }).children.push(placed.id);
    };
    hold(one, two, 's', 't');
    hold(two, one, 't', 's');
    s.components[one.id] = one;
    s.components[two.id] = two;
    const place = (pageId: string, def: typeof one, slot: string) => {
      const placed = makeInstance(def, {});
      placed.slots = { [slot]: [`txt_${pageId}`] };
      s.pages[pageId].nodes[placed.id] = placed;
      s.pages[pageId].nodes[`txt_${pageId}`] = { kind: 'text', id: `txt_${pageId}`, tag: 'li', text: 'Item' } as never;
      s.pages[pageId].rootIds.push(placed.id);
    };
    place(s.site.homePageId, one, 's');
    place('pg_other', two, 't');
    const cache = new ValidationCache();
    const states = [s];
    for (const text of ['A', 'B', 'C']) states.push(apply(states.at(-1)!, [{ type: 'node.setContent', owner: page('pg_other'), nodeId: 'txt_pg_other', field: 'text', value: text } as EditOperation]));
    for (const text of ['D', 'E']) states.push(apply(states.at(-1)!, [{ type: 'node.setContent', owner: page(s.site.homePageId), nodeId: `txt_${s.site.homePageId}`, field: 'text', value: text } as EditOperation]));
    for (const st of states) expectFresh(cache, st);
    for (const st of [...states].reverse()) expectFresh(cache, st);
    // The walk does meet itself.
    const nesting = trackedNestingChecker(s);
    nesting.check(page(s.site.homePageId), s.pages[s.site.homePageId]);
    expect(nesting.cycles()).toBe(true);
  });

  it('gives each state of a run of edits exactly what a validation of it alone gives', () => {
    const { s, home, hero } = project();
    const { managed } = FOUNDATION_AUTHOR;
    const card = { ...managed({ category: 'content', tags: [], icon: 'sparkles', description: '', componentId: 'test.kept-card', name: 'Kept card', properties: {}, parts: {}, slots: { body: { label: 'Body' } }, build: (b) => b.el('root', 'div', {}, [b.slot('body-slot', 'body')]) }), owner: 'project' as const };
    const steps: Array<(st: ProjectState) => ProjectState> = [
      (st) => apply(st, [heading(home, hero, 'One')]),
      (st) => apply(st, [heading(home, hero, 'Two')]),
      // A section link that goes nowhere, on another page: advice only.
      (st) => apply(st, [
        { type: 'node.insert', owner: page('pg_one'), primitive: 'button', newNodeId: 'n_anchor1' },
        { type: 'node.setContent', owner: page('pg_one'), nodeId: 'n_anchor1', field: 'link', value: { type: 'page', target: 'pg_two', anchor: 'nowhere' } }
      ] as EditOperation[]),
      (st) => apply(st, [{ type: 'page.update', pageId: 'pg_two', title: 'Renamed' } as EditOperation]),
      (st) => apply(st, [{ type: 'node.setContent', owner: page('pg_two'), nodeId: 'n_pic__two', field: 'image', value: { assetId: IMAGE.id, alt: 'A photo' } } as EditOperation]),
      (st) => apply(st, [{ type: 'page.create', pageId: 'pg_three', title: 'Three', route: '/three/' } as EditOperation]),
      // A project component of its own, placed on a page, then a heading moved into its slot from outside a list.
      (st) => {
        const next = structuredClone(st);
        next.components[card.id] = card;
        const placed = makeInstance(card, {});
        next.pages.pg_three.nodes[placed.id] = placed;
        next.pages.pg_three.rootIds.push(placed.id);
        return next;
      },
      (st) => apply(st, [{ type: 'collection.create', collectionId: 'posts' } as EditOperation]),
      (st) => apply(st, [{ type: 'entry.create', collectionId: 'posts', entryId: 'en_one', title: 'A post', publishedAt: '2026-01-02', draft: false, body: ['Words.'] } as EditOperation]),
      (st) => apply(st, [heading(home, hero, 'Three')]),
      (st) => apply(st, [{ type: 'page.remove', pageId: 'pg_two', replacementPageId: home } as EditOperation]),
      // The picture gone from the library by hand while pages still show it.
      (st) => {
        const assets = { ...st.assets.assets };
        delete assets[IMAGE.id];
        return { ...st, assets: { ...st.assets, assets } };
      }
    ];
    const cache = new ValidationCache();
    const states = [s];
    for (const step of steps) states.push(step(states.at(-1)!));
    for (const st of states) {
      expectFresh(cache, st);
      // Asset usage counted part by part is the same totals, naming the assets in the same order.
      expect(Object.entries(assetUsages(st, cache.keeper(st)))).toStrictEqual(Object.entries(assetUsages(structuredClone(st))));
    }
    expect(expectFresh(cache, states.at(-1)!).filter((d) => d.code === 'ASSET_MISSING').length).toBeGreaterThan(0);
    // An earlier state again (undo), and every one of them once more.
    for (const st of [...states].reverse()) expectFresh(cache, st);
  });
});
