import { describe, expect, it } from 'vitest';
import type { InstanceNode, ListItem, ListProp, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { BUNDLED_FONTS } from '@catalogue/fonts';
import { ICONS } from '@catalogue/foundation/icons';
import { applyOperations } from '@engine/apply';
import { RUNTIME_DIR, defFile, generateProject, pageFile } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { SEARCH_INDEX_FILE } from '@generator/search';
import { usedIcons } from '@generator/runtime-files';
import { sameValue } from '@shared/same';

const apply = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const page = (id: string) => ({ kind: 'page' as const, id });
const firstInstance = (s: ProjectState, pageId: string, propType = 'string') =>
  Object.values(s.pages[pageId].nodes).find((n) => n.kind === 'instance' && Object.values(s.components[n.definitionId]?.properties ?? {}).some((p) => p.type === propType)) as InstanceNode;
const propOf = (s: ProjectState, n: InstanceNode, propType = 'string') => Object.entries(s.components[n.definitionId].properties).find(([, p]) => p.type === propType)![0];

/** A 21-page site: the business starter, fifteen more service pages, a projects index listing two project pages, and a code component. */
function multiPageSite() {
  let s = createStarterState('business', 'Incremental', false);
  const [home, about, contact] = s.site.pageOrder;
  for (let i = 0; i < 15; i++) s = apply(s, { type: 'page.duplicate', pageId: i % 2 ? about : contact, title: `Service ${i}` });
  s = apply(
    s,
    { type: 'page.create', pageId: 'pg_kitchens', title: 'Kitchens', route: '/projects/kitchens/' },
    { type: 'page.update', pageId: 'pg_kitchens', description: 'Three kitchens built around how families cook.' },
    { type: 'page.create', pageId: 'pg_gardens', title: 'Gardens', route: '/projects/gardens/' },
    { type: 'page.create', pageId: 'pg_projects', title: 'Projects', route: '/projects/' }
  );
  const listed = applyOperations(s, [
    {
      type: 'node.insert',
      owner: page('pg_projects'),
      componentId: 'content.pages',
      props: { heading: 'Our projects', items: [{ pageLink: { type: 'page', target: 'pg_kitchens' } }, { pageLink: { type: 'page', target: 'pg_gardens' }, title: 'Garden rooms' }] }
    }
  ]);
  s = listed.state;
  const coded = applyOperations(s, [{ type: 'component.createCode', name: 'Opening hours', source: '<p class="hours">Open {days}</p>\n\n<script>\n\tlet { days = "Mon to Fri" } = $props();\n</script>\n', properties: { days: { type: 'string', label: 'Days', default: 'Mon to Fri' } } }]);
  s = coded.state;
  const codeId = coded.results[0].definitionId as string;
  s = apply(s, { type: 'node.insert', owner: page(contact), definitionId: codeId } as EditOperation);
  return { s, home, about, contact, listId: listed.results[0].nodeId as string, codeId };
}

/** Runs both kinds of generation through `cache`, checks each against a full run, and says what each had to make. */
function check(state: ProjectState, cache: GenerationCache) {
  const made: Record<'clean' | 'dev', string[]> = { clean: [], dev: [] };
  for (const [mode, opts] of [['clean', {}], ['dev', { instrument: true }]] as const) {
    const incremental = generateProject(state, opts, cache);
    made[mode] = cache.made.slice();
    expect([...incremental]).toEqual([...generateProject(state, opts)]);
  }
  return made;
}

describe('incremental generation (#183)', () => {
  it('makes again only what an edit reaches, and the same bytes as a full run', () => {
    const { s: start, home, about, contact, codeId } = multiPageSite();
    expect(start.site.pageOrder.length).toBeGreaterThanOrEqual(20);
    const cache = new GenerationCache();
    let s = start;
    const first = check(s, cache);
    expect(first.clean.filter((k) => k.startsWith('page:'))).toHaveLength(s.site.pageOrder.length);
    // The instrumented run shares every file that does not differ between the two.
    expect(first.dev.every((k) => k.endsWith('#dev'))).toBe(true);
    expect(check(s, cache)).toEqual({ clean: [], dev: [] });

    // A heading on one page: that page alone, though other pages link to it and every page is scanned for icons and fonts.
    const inst = firstInstance(s, about);
    s = apply(s, { type: 'instance.setProp', owner: page(about), nodeId: inst.id, prop: propOf(s, inst), value: 'A new heading' });
    expect(check(s, cache)).toEqual({ clean: [`page:${about}#clean`], dev: [`page:${about}#dev`] });

    // A local style: that page and the page stylesheet.
    s = apply(s, { type: 'node.setStyle', owner: page(about), nodeId: inst.id, scope: 'base', property: 'paddingBlock', value: '48px' });
    expect(check(s, cache)).toEqual({ clean: [`site.css`, `page:${about}#clean`], dev: [`page:${about}#dev`] });

    // An icon used for the first time, and given up again: the icon map follows.
    const unused = Object.keys(ICONS).find((n) => !usedIcons(s).includes(n))!;
    s = apply(s, { type: 'instance.setProp', owner: page(about), nodeId: inst.id, prop: propOf(s, inst), value: unused });
    let made = check(s, cache);
    expect(made.clean).toContain('icons.js');
    expect(generateProject(s).get('src/lib/siteorigin/runtime/icons.js')).toContain(JSON.stringify(unused));
    s = apply(s, { type: 'instance.setProp', owner: page(about), nodeId: inst.id, prop: propOf(s, inst), value: 'About us' });
    expect(check(s, cache).clean).toContain('icons.js');

    // A font named in page text is imported by the layout.
    const lora = BUNDLED_FONTS.find((f) => f.name === 'Lora')!;
    const homeInst = firstInstance(s, home);
    s = apply(s, { type: 'instance.setProp', owner: page(home), nodeId: homeInst.id, prop: propOf(s, homeInst), value: lora.family });
    made = check(s, cache);
    expect(made.clean).toEqual(['layout#clean', `page:${home}#clean`]);
    expect(generateProject(s).get('src/routes/+layout.svelte')).toContain(lora.package);

    // The shared header: the layout, never a page.
    const headerInst = Object.values(s.site.shell.header.nodes).find((n) => n.kind === 'instance') as InstanceNode;
    const headerProp = Object.entries(s.components[headerInst.definitionId].properties).find(([, p]) => p.type === 'string' || p.type === 'list')![0];
    const headerValue = s.components[headerInst.definitionId].properties[headerProp].type === 'list' ? [] : 'Studio';
    s = apply(s, { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: headerInst.id, prop: headerProp, value: headerValue });
    made = check(s, cache);
    expect(made.clean).toContain('layout#clean');
    expect(made.clean.some((k) => k.startsWith('page:'))).toBe(false);

    // A token: stylesheets and everything else that reads it, byte for byte.
    s = apply(s, { type: 'token.set', tokenId: 'color.brand', value: '#0b6e4f' });
    expect(check(s, cache).clean).toContain('tokens.css');

    // A component definition: its file and stylesheet, and the pages that place it.
    const forked = applyOperations(s, [{ type: 'component.fork', definitionId: inst.definitionId }]);
    s = forked.state;
    check(s, cache);
    const def = s.components[forked.results[0].definitionId as string];
    s = apply(s, { type: 'node.setStyle', owner: { kind: 'component', id: def.id }, nodeId: def.tree!.rootIds[0], scope: 'base', property: 'paddingBlock', value: '40px' });
    made = check(s, cache);
    expect(made.clean).toEqual(expect.arrayContaining(['components.css']));

    // A code component's source, a new address for a page, a new Home page (its old address keeps working), then a
    // new and a removed page.
    s = apply(s, { type: 'component.updateSource', definitionId: codeId, source: s.components[codeId].source!.replace('Open', 'Opening') } as EditOperation);
    check(s, cache);
    s = apply(s, { type: 'page.update', pageId: about, route: '/about-us/' });
    check(s, cache);
    expect(generateProject(s).has('src/routes/about-us/+page.svelte')).toBe(true);
    s = apply(s, { type: 'page.setHome', pageId: about });
    made = check(s, cache);
    expect(made.clean.some((k) => k.startsWith('redirect:'))).toBe(true);
    s = apply(s, { type: 'page.create', title: 'Careers' });
    check(s, cache);
    s = apply(s, { type: 'page.remove', pageId: contact, replacementPageId: home } as EditOperation);
    check(s, cache);
    expect(generateProject(s).has(defFile(s.components[codeId]))).toBe(true);

    // Undo back to the start, then the other kind of run alone, then both again.
    check(start, cache);
    expect([...generateProject(s, {}, cache)]).toEqual([...generateProject(s)]);
    expect([...generateProject(s, {}, cache)]).toEqual([...generateProject(s)]);
    check(s, cache);
  });

  it('keeps the site search index in step with the pages it lists', () => {
    const { s: site, home, about } = multiPageSite();
    const INDEX = `${RUNTIME_DIR}/${SEARCH_INDEX_FILE}`;
    const cache = new GenerationCache();
    check(site, cache);
    // Placing Site search writes the index; nothing else changes it until a page it lists does.
    let s = apply(site, { type: 'node.insert', owner: page(home), componentId: 'site.search' });
    expect(check(s, cache).clean).toContain('search-index.js');
    expect(check(s, cache)).toEqual({ clean: [], dev: [] });

    // Words on a listed page: that page and the index, made once for both kinds of run.
    const inst = firstInstance(s, about);
    s = apply(s, { type: 'instance.setProp', owner: page(about), nodeId: inst.id, prop: propOf(s, inst), value: 'Hand-built oak staircases' });
    const made = check(s, cache);
    expect(made.clean).toEqual(expect.arrayContaining(['search-index.js', `page:${about}#clean`]));
    expect(made.dev).not.toContain('search-index.js');
    expect(generateProject(s, {}, cache).get(INDEX)).toContain('Hand-built oak staircases');

    // A token the index never reads leaves it alone; a page left out of search, or made a draft, does not.
    s = apply(s, { type: 'token.set', tokenId: 'color.brand', value: '#0b6e4f' });
    expect(check(s, cache).clean).not.toContain('search-index.js');
    s = apply(s, { type: 'page.update', pageId: about, searchHidden: true });
    expect(check(s, cache).clean).toContain('search-index.js');
    expect(generateProject(s, {}, cache).get(INDEX)).not.toContain('Hand-built oak staircases');
    s = apply(s, { type: 'page.update', pageId: about, searchHidden: false, draft: true });
    expect(check(s, cache).clean).toContain('search-index.js');
    expect(generateProject(s, {}, cache).get(INDEX)).not.toContain('Hand-built oak staircases');

    // With no component that searches, there is no index; once one searches again, it is made from the pages as they are.
    s = apply(s, { type: 'page.update', pageId: about, draft: false });
    const searchNode = Object.values(s.pages[home].nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === 'site.search') as InstanceNode;
    const without = structuredClone(apply(s, { type: 'node.remove', owner: page(home), nodeId: searchNode.id }));
    delete without.components[searchNode.definitionId];
    expect(check(without, cache).clean).not.toContain('search-index.js');
    expect(generateProject(without, {}, cache).has(INDEX)).toBe(false);
    expect(check(s, cache).clean).toContain('search-index.js');
    expect(generateProject(s, {}, cache).get(INDEX)).toContain('Hand-built oak staircases');
  });

  it('tells a field holding undefined from a missing one', () => {
    const { s: site, listId } = multiPageSite();
    const s = structuredClone(site);
    const node = s.pages.pg_projects.nodes[listId] as InstanceNode;
    // A card's own empty title follows its page; a title left out takes the list's default.
    (s.components[node.definitionId].properties.items as ListProp).fields.title.default = 'Default card title';
    delete (node.props.items as ListItem[])[0].title;
    const cache = new GenerationCache();
    check(s, cache);
    const cleared = structuredClone(s);
    const items = (cleared.pages.pg_projects.nodes[listId] as InstanceNode).props.items as ListItem[];
    expect(Object.hasOwn(items[0], 'title')).toBe(false);
    items[0].title = undefined;
    expect(JSON.stringify(cleared)).toBe(JSON.stringify(s));
    const file = pageFile(s.pages.pg_projects);
    expect(generateProject(cleared).get(file)).not.toBe(generateProject(s).get(file));
    expect(check(cleared, cache).clean).toEqual(['page:pg_projects#clean']);
  });

  it('follows reads of a page that does not exist yet', () => {
    const { s: site, home } = multiPageSite();
    const cache = new GenerationCache();
    const inst = firstInstance(site, home, 'link');
    // A link to a page that is not there (a document edited outside the app) renders as no link; once the page
    // exists, it links to its address.
    const s = structuredClone(site);
    (s.pages[home].nodes[inst.id] as InstanceNode).props[propOf(site, inst, 'link')] = { type: 'page', target: 'pg_later' };
    check(s, cache);
    const later = apply(s, { type: 'page.create', pageId: 'pg_later', title: 'Later', route: '/later/' });
    expect(check(later, cache).clean).toContain(`page:${home}#clean`);
    expect(generateProject(later).get(pageFile(later.pages[home]))).toContain('/later/');
  });

  it('reads a frozen state as a full run does', () => {
    const { s } = multiPageSite();
    const deepFreeze = <T>(v: T): T => {
      if (v && typeof v === 'object') for (const x of Object.values(v)) deepFreeze(x);
      return Object.freeze(v);
    };
    const frozen = deepFreeze(structuredClone(s));
    const cache = new GenerationCache();
    check(frozen, cache);
    expect(check(deepFreeze(structuredClone(s)), cache)).toEqual({ clean: [], dev: [] });
  });

  it('leaves managed components alone when a code component changes in a way none of them reads', () => {
    const { s: site, codeId } = multiPageSite();
    const cache = new GenerationCache();
    check(site, cache);
    const s = apply(site, { type: 'component.updateSource', definitionId: codeId, source: site.components[codeId].source!.replace('<p', '<!-- Shown in the footer too. -->\n<p') } as EditOperation);
    const made = check(s, cache);
    expect(made.clean.filter((k) => k.startsWith('component:') || k === 'components.css')).toEqual([]);
  });

  it('follows a card link that becomes broken and whole again', () => {
    const { s: site, about } = multiPageSite();
    const cache = new GenerationCache();
    check(site, cache);
    // A placed definition whose root holds other elements becomes a card linking to About.
    const placed = new Set(Object.values(site.pages).flatMap((p) => Object.values(p.nodes).flatMap((n) => (n.kind === 'instance' ? [n.definitionId] : []))));
    const linkFree = (d: (typeof site.components)[string]) => Object.values(d.tree!.nodes).every((n) => n.kind !== 'link' && n.kind !== 'instance' && !('link' in n && n.link));
    const def = Object.values(site.components).find((d) => placed.has(d.id) && d.kind === 'managed' && d.tree && linkFree(d) && Object.values(d.tree.nodes).filter((n) => n.kind === 'element').length > 1)!;
    const [rootId] = def.tree!.rootIds;
    const inner = Object.values(def.tree!.nodes).find((n) => n.kind === 'element' && n.id !== rootId)!;
    const card = structuredClone(site);
    Object.assign(card.components[def.id].tree!.nodes[rootId], { link: { type: 'page', target: about } });
    check(card, cache);
    // A link inside the card breaks it: the card renders as its plain container.
    const broken = structuredClone(card);
    Object.assign(broken.components[def.id].tree!.nodes[inner.id], { link: { type: 'url', target: 'https://example.com/' } });
    check(broken, cache);
    expect(generateProject(broken).get(defFile(def))).not.toBe(generateProject(card).get(defFile(def)));
    check(card, cache);
  });

  /** One file whose content is whatever `make` reads, run on each state in turn through one cache. */
  function readsAcross(states: ProjectState[], make: (s: ProjectState) => string) {
    const cache = new GenerationCache();
    return states.map((st) => {
      const run = cache.run(st, false);
      const content = run.file('probe', make);
      run.finish();
      expect(content).toBe(make(st));
      return content;
    });
  }

  it('follows every way a generator can ask about a key', () => {
    const { s } = multiPageSite();
    const unset = structuredClone(s);
    delete unset.site.baseUrl;
    const undef = structuredClone(unset);
    (undef.site as unknown as Record<string, unknown>).baseUrl = undefined;
    // Present but undefined, then missing: `in` and Object.hasOwn tell them apart.
    expect(readsAcross([undef, unset], (st) => String('baseUrl' in st.site))).toEqual(['true', 'false']);
    expect(readsAcross([undef, unset], (st) => String(Object.hasOwn(st.site, 'baseUrl')))).toEqual(['true', 'false']);
    // A page read through its descriptor.
    const home = s.site.homePageId;
    const renamed = apply(s, { type: 'page.update', pageId: home, title: 'Welcome' });
    expect(readsAcross([s, renamed], (st) => Object.getOwnPropertyDescriptor(st.pages, home)!.value.title)).toEqual([s.pages[home].title, 'Welcome']);
    // The order of keys, read whole.
    const reordered = structuredClone(s);
    reordered.tokens.overrides = Object.fromEntries(Object.entries({ ...s.tokens.overrides, 'a.first': '1', 'b.second': '2' }).reverse());
    const ordered = structuredClone(reordered);
    ordered.tokens.overrides = Object.fromEntries(Object.entries(reordered.tokens.overrides).reverse());
    const order = readsAcross([reordered, ordered], (st) => Object.keys(st.tokens.overrides).join(','));
    expect(order[0]).not.toBe(order[1]);
    // A node hidden from enumeration, then shown, with nothing else different.
    const page = s.pages[home];
    const nodeId = page.rootIds[0];
    const hidden = structuredClone(s);
    Object.defineProperty(hidden.pages[home].nodes, nodeId, { enumerable: false });
    expect(readsAcross([hidden, structuredClone(s)], (st) => Object.keys(st.pages[home].nodes).join(','))).toEqual([Object.keys(page.nodes).filter((k) => k !== nodeId).join(','), Object.keys(page.nodes).join(',')]);
  });

  it('hands out a field that can never change as it is', () => {
    const { s: site } = multiPageSite();
    const s = structuredClone(site);
    Object.defineProperty(s, 'site', { writable: false, configurable: false });
    const cache = new GenerationCache();
    check(s, cache);
    expect(check(s, cache)).toEqual({ clean: [], dev: [] });
  });

  it('forgets a file a run did not ask for, and makes it again when it is asked for', () => {
    const { s } = multiPageSite();
    const cache = new GenerationCache();
    const once = (keys: string[]) => {
      const run = cache.run(s, false);
      for (const k of keys) run.file(k, () => k);
      run.finish();
      return cache.made.slice();
    };
    expect(once(['a', 'b'])).toEqual(['a', 'b']);
    expect(once(['a'])).toEqual([]);
    expect(once(['a', 'b'])).toEqual(['b']);
  });

  it('forgets everything when a generator throws', () => {
    const { s } = multiPageSite();
    const cache = new GenerationCache();
    let run = cache.run(s, false);
    run.file('a', () => 'a');
    expect(() => run.file('b', () => { throw new Error('broken'); })).toThrow('broken');
    run = cache.run(s, false);
    run.file('a', () => 'a');
    expect(cache.made).toEqual(['a']);
  });

  it('compares values key by key, hidden keys and array names included', () => {
    expect(sameValue({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(sameValue({ a: undefined }, {})).toBe(false);
    expect(sameValue([1, , 3], [1, undefined, 3])).toBe(false);
    expect(sameValue(0, -0)).toBe(false);
    expect(sameValue(NaN, NaN)).toBe(true);
    expect(sameValue(Object.assign([1], { title: 'Old' }), Object.assign([1], { title: 'New' }))).toBe(false);
    expect(sameValue(Object.assign([1], { title: 'Old' }), Object.assign([1], { other: 'Old' }))).toBe(false);
    const hidden = Object.defineProperty({}, 'title', { value: 'Old', enumerable: false });
    expect(sameValue(hidden, {})).toBe(false);
    expect(sameValue(hidden, Object.defineProperty({}, 'title', { value: 'Old', enumerable: false }))).toBe(true);
    expect(sameValue(new Map(), new Map())).toBe(false);
  });

  it('never lets a generator change the state it reads', () => {
    const { s } = multiPageSite();
    const cache = new GenerationCache();
    const run = cache.run(s, false);
    expect(() => run.file('x', (t) => ((t.pages[s.site.homePageId].title = 'Changed'), ''))).toThrow(/never change/);
    expect(() => run.file('y', (t) => (delete (t.components as Record<string, unknown>)[Object.keys(s.components)[0]], ''))).toThrow(/never change/);
    expect(s.pages[s.site.homePageId].title).not.toBe('Changed');
  });
});
