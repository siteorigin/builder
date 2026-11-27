import { describe, expect, it, vi } from 'vitest';
import type { InstanceNode, ListItem, ListProp, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { getTheme, listThemes, registerPacks } from '@catalogue/index';
import { ICONS } from '@shared/icons';
import { applyOperations } from '@engine/apply';
import { RUNTIME_DIR, STYLES_DIR, defFile, effectiveTokens, generateProject, packFileCopies, pageFile } from '@generator/index';
import { derived } from '@generator/cache';
import * as fonts from '@catalogue/fonts';
import { GenerationCache } from '@generator/cache';
import { frozen } from '@engine/draft';
import { SEARCH_INDEX_FILE } from '@generator/search';
import { usedIcons } from '@generator/runtime-files';
import * as seoMetadata from '@generator/seo-metadata';
import { sameValue } from '@shared/same';
import { withPublished } from '@shared/published';
import { P, prop } from '@catalogue/dsl';
import { projectDesign } from './fixtures/packs';

/** The project once the website has been exported as it is now: its pages' addresses are kept working when they move (#890). */
const exported = (s: ProjectState): ProjectState => ({ ...s, published: withPublished(s.published, s) ?? s.published });

const apply = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const page = (id: string) => ({ kind: 'page' as const, id });
const firstInstance = (s: ProjectState, pageId: string, propType = 'string') =>
  Object.values(s.pages[pageId].nodes).find((n) => n.kind === 'instance' && Object.values(s.components[n.definitionId]?.properties ?? {}).some((p) => p.type === propType)) as InstanceNode;
const propOf = (s: ProjectState, n: InstanceNode, propType = 'string') => Object.entries(s.components[n.definitionId].properties).find(([, p]) => p.type === propType)![0];

/**
 * A 21-page site: the business starter, fifteen more service pages, a projects index listing two project pages, a
 * code component, and a managed design of the project's own on About and its copies (Foundation's sections are code,
 * so this is the design whose tree a definition edit changes).
 */
function multiPageSite() {
  let s = createStarterState('business', 'Incremental', false);
  const [home, about, contact] = s.site.pageOrder;
  const note = projectDesign(s, {
    componentId: 'project.note',
    name: 'Note',
    properties: { heading: P.str('Heading', 'A note'), body: P.str('Body', 'Kept short.') },
    parts: { root: { nodeId: 'root', label: 'Note' } },
    build: (b) => b.el('root', 'section', {}, [b.el('inner', 'div', {}, [b.text('heading', 'h2', prop('heading')), b.text('body', 'p', prop('body'))])])
  });
  s = apply(s, { type: 'node.insert', owner: page(about), definitionId: note.id } as EditOperation);
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
  return { s, home, about, contact, listId: listed.results[0].nodeId as string, codeId, noteId: note.id };
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
    const { s: start, home, about, contact, codeId, noteId } = multiPageSite();
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

    // A font named in page text is served by the token stylesheet, its licence listed beside its files.
    const lora = getTheme(s.site.themeId).fonts.find((f) => f.name === 'Lora')!;
    const homeInst = firstInstance(s, home);
    s = apply(s, { type: 'instance.setProp', owner: page(home), nodeId: homeInst.id, prop: propOf(s, homeInst), value: lora.family });
    made = check(s, cache);
    expect(made.clean).toEqual(['tokens.css', 'fonts/NOTICE.txt', `page:${home}#clean`]);
    expect(generateProject(s).get(`${STYLES_DIR}/tokens.css`)).toContain(`font-family: '${lora.family}'`);

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

    // A component definition: its file and stylesheet, and the pages that place it. A theme section copied into the
    // project, then a style in the tree of the project's own design.
    s = applyOperations(s, [{ type: 'component.fork', definitionId: inst.definitionId }]).state;
    check(s, cache);
    const def = s.components[noteId];
    s = apply(s, { type: 'node.setStyle', owner: { kind: 'component', id: def.id }, nodeId: def.tree!.rootIds[0], scope: 'base', property: 'paddingBlock', value: '40px' });
    made = check(s, cache);
    expect(made.clean).toEqual(expect.arrayContaining(['components.css']));

    // A code component's source, a new address for a page, a new Home page (its old address keeps working), then a
    // new and a removed page.
    s = apply(s, { type: 'component.updateSource', definitionId: codeId, source: s.components[codeId].source!.replace('Open', 'Opening') } as EditOperation);
    check(s, cache);
    s = exported(apply(exported(s), { type: 'page.update', pageId: about, route: '/about-us/' }));
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
    const { s: site, home, about, noteId } = multiPageSite();
    const INDEX = `${RUNTIME_DIR}/${SEARCH_INDEX_FILE}`;
    const cache = new GenerationCache();
    check(site, cache);
    // Placing Site search writes the index; nothing else changes it until a page it lists does.
    let s = apply(site, { type: 'node.insert', owner: page(home), componentId: 'site.search' });
    expect(check(s, cache).clean).toContain('search-index.js');
    expect(check(s, cache)).toEqual({ clean: [], dev: [] });

    // Words on a listed page: that page and the index, made once for both kinds of run. They are the About page's
    // design of its own: the index reads none of Foundation's sections but its forms, tables and videos (the Release
    // gap test below).
    const inst = Object.values(s.pages[about].nodes).find((n) => n.kind === 'instance' && n.definitionId === noteId) as InstanceNode;
    s = apply(s, { type: 'instance.setProp', owner: page(about), nodeId: inst.id, prop: 'body', value: 'Hand-built oak staircases' });
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

  // Release gap: Builder reads inside only the header, table, video and form code sections (shippedCode in src/generator/checks.ts), so the rest of the release's text counts as custom code.
  it.fails('writes the words of the release’s sections into the site search index', () => {
    const { s: site, home, about } = multiPageSite();
    let s = apply(site, { type: 'node.insert', owner: page(home), componentId: 'site.search' });
    const inst = firstInstance(s, about);
    s = apply(s, { type: 'instance.setProp', owner: page(about), nodeId: inst.id, prop: propOf(s, inst), value: 'Hand-built oak staircases' });
    expect(generateProject(s).get(`${RUNTIME_DIR}/${SEARCH_INDEX_FILE}`)).toContain('Hand-built oak staircases');
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

  it('follows a frozen state field by field, as an open one, so an edit makes again only what read what it changed', () => {
    const { s: site, about } = multiPageSite();
    const n = firstInstance(site, about);
    const edit = (s: ProjectState) => apply(s, { type: 'instance.setProp', owner: page(about), nodeId: n.id, prop: propOf(site, n), value: 'Changed' });
    const made = (s: ProjectState, freeze: boolean) => {
      const cache = new GenerationCache();
      const first = freeze ? frozen(structuredClone(s)) : structuredClone(s);
      generateProject(first, {}, cache);
      const next = edit(first);
      const files = generateProject(freeze ? frozen(next) : next, {}, cache);
      expect(files).toEqual(generateProject(structuredClone(next)));
      return [...cache.made].sort();
    };
    const open = made(site, false);
    expect(open.length).toBeGreaterThan(0);
    expect(made(site, true)).toEqual(open);
  });

  it('looks up again only what an edit changed in a frozen state, and still makes the bytes a full run does', () => {
    const { s: site, about } = multiPageSite();
    const n = firstInstance(site, about);
    const prop = propOf(site, n);
    const edit = (s: ProjectState, value: string) => apply(s, { type: 'instance.setProp', owner: page(about), nodeId: n.id, prop, value });
    // The same edits through one cache, on states frozen as the session holds them and on open ones.
    const looked = (freeze: boolean) => {
      const hold = (s: ProjectState) => (freeze ? frozen(s) : s);
      const cache = Object.assign(new GenerationCache(), { timing: true });
      const start = hold(structuredClone(site));
      check(start, cache);
      const changed = hold(edit(start, 'Changed'));
      generateProject(changed, {}, cache);
      const counts = { looked: cache.looked, made: [...cache.made] };
      expect([...generateProject(changed, { instrument: true }, cache)]).toEqual([...generateProject(structuredClone(changed), { instrument: true })]);
      // Back to the very first state, then on to another: each as a full run makes it.
      expect(check(start, cache).clean).toEqual([`page:${about}#clean`]);
      expect(check(hold(edit(start, 'Again')), cache).clean).toEqual([`page:${about}#clean`]);
      return counts;
    };
    const open = looked(false);
    const held = looked(true);
    expect(held.made).toEqual(open.made);
    // What the unchanged pages, nodes and entries hold is not looked up again: they are the very objects, frozen.
    expect(held.looked).toBeLessThan(open.looked / 4);
  });

  it('finds the fonts and icons a frozen state names as a search of the whole project does, as edits bring them in and take them away', () => {
    const { s: site, about, codeId } = multiPageSite();
    // The searches as they were, over the whole project at once.
    const wholeFonts = (s: ProjectState) => {
      const layouts = Object.values(s.collections ?? {}).flatMap((c) => [c?.settings?.template, c?.settings?.archiveTemplate]);
      const haystack = JSON.stringify([effectiveTokens(s).map((t) => t.value), s.site.shell, s.pages, s.components, layouts]).replace(/(\\[nrt]|\s)+/g, ' ').toLowerCase();
      return fonts.installedFonts(s).filter((f) => haystack.includes(f.family.toLowerCase()));
    };
    const wholeIcons = (s: ProjectState) => {
      const found = new Set<string>(['sparkles']);
      const visit = (v: unknown): void => {
        if (typeof v === 'string') {
          if (Object.hasOwn(ICONS, v)) found.add(v);
        } else if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === 'object') Object.values(v).forEach(visit);
      };
      visit(s.pages);
      visit(s.site.shell);
      for (const c of Object.values(s.collections ?? {})) visit(c?.settings?.template);
      for (const c of Object.values(s.collections ?? {})) visit(c?.settings?.archiveTemplate);
      for (const def of Object.values(s.components)) {
        if (def.kind === 'code') for (const m of (def.source ?? '').matchAll(/['"`]([a-z0-9-]+)['"`]/g)) if (Object.hasOwn(ICONS, m[1])) found.add(m[1]);
        visit(def.properties);
        visit(def.tree);
      }
      return Object.keys(ICONS).filter((k) => found.has(k));
    };
    const n = firstInstance(site, about);
    const prop = propOf(site, n);
    const lora = getTheme(site.site.themeId).fonts.find((f) => f.name === 'Lora')!;
    const icon = Object.keys(ICONS).find((k) => !wholeIcons(site).includes(k))!;
    const setText = (s: ProjectState, value: string) => apply(s, { type: 'instance.setProp', owner: page(about), nodeId: n.id, prop, value });
    let s = frozen(structuredClone(site));
    const states: ProjectState[] = [s];
    for (const step of [
      (x: ProjectState) => setText(x, `Set in ${lora.family}`),
      (x: ProjectState) => setText(x, 'Plain words'),
      (x: ProjectState) => setText(x, icon),
      (x: ProjectState) => setText(x, 'Plain words again'),
      (x: ProjectState) => apply(x, { type: 'component.updateSource', definitionId: codeId, source: `${x.components[codeId].source}\n<!-- ${lora.family} '${icon}' -->` } as EditOperation)
    ]) {
      s = frozen(step(s));
      states.push(s);
    }
    // Every state, in order and then back to the first, frozen and open: the same answer as the whole search.
    for (const state of [...states, states[0], structuredClone(states[1])]) {
      expect(fonts.usedPackFonts(state, effectiveTokens(state).map((t) => t.value))).toEqual(wholeFonts(state));
      expect(usedIcons(state)).toEqual(wholeIcons(state));
    }
    expect(wholeFonts(states[1]).map((f) => f.family)).toContain(lora.family);
    expect(wholeFonts(states[2]).map((f) => f.family)).not.toContain(lora.family);
    expect(wholeIcons(states[3])).toContain(icon);
    expect(wholeIcons(states[4])).not.toContain(icon);
    expect(wholeIcons(states[5])).toContain(icon);
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

  it('gives back a derived value a run worked out for that very state, and for no other (#964)', () => {
    const { s } = multiPageSite();
    const cache = new GenerationCache();
    let computed = 0;
    const count = (st: ProjectState) => (computed++, Object.keys(st.pages).length);
    const run = cache.run(s, false);
    run.file('a', (st) => String(derived(st, 'pages', count)));
    run.finish();
    expect(computed).toBe(1);
    expect(cache.derivedFor(s, 'pages')).toBe(Object.keys(s.pages).length);
    // Another state, even one equal to it, was never run: nothing is given for it.
    expect(cache.derivedFor(structuredClone(s), 'pages')).toBeUndefined();
    expect(cache.derivedFor(s, 'other')).toBeUndefined();
    expect(computed).toBe(1);
  });

  it('works a derived value out again only when something it read changed (#965)', () => {
    const { s: site, home, about } = multiPageSite();
    const cache = new GenerationCache();
    const computed: Record<string, number> = { title: 0, both: 0, every: 0 };
    // A value that reads one page's title, one that reads it through another, and one worked out every state.
    const title = (st: ProjectState) => derived(st, 'title', (x) => (computed.title++, x.pages[home].title));
    const both = (st: ProjectState) => derived(st, 'both', (x) => (computed.both++, `${title(x)} and ${x.pages[about].route}`));
    const every = (st: ProjectState) => derived(st, 'every', (x) => (computed.every++, Object.keys(x.pages).length), { opaque: true });
    const run = (st: ProjectState) => {
      const r = cache.run(st, false);
      const content = r.file('a', (x) => `${both(x)} / ${every(x)}`);
      r.finish();
      return content;
    };
    let s = frozen(structuredClone(site));
    expect(run(s)).toBe(`${s.pages[home].title} and ${s.pages[about].route} / ${Object.keys(s.pages).length}`);
    expect(computed).toEqual({ title: 1, both: 1, every: 1 });
    // Another page's heading: neither value read it, so neither is worked out again; the opaque one is.
    const n = firstInstance(s, about);
    s = frozen(apply(s, { type: 'instance.setProp', owner: page(about), nodeId: n.id, prop: propOf(s, n), value: 'Elsewhere' }));
    run(s);
    expect(computed).toEqual({ title: 1, both: 1, every: 2 });
    // The title one read: it is worked out again, and so is the value that read it through it.
    s = frozen(apply(s, { type: 'page.update', pageId: home, title: 'Start' }));
    expect(run(s)).toBe(`Start and ${s.pages[about].route} / ${Object.keys(s.pages).length}`);
    expect(computed).toEqual({ title: 2, both: 2, every: 3 });
    // Another field of that page: the title it read is the same, so neither is worked out again.
    s = frozen(apply(s, { type: 'page.update', pageId: home, description: 'Changed' }));
    run(s);
    expect(computed).toEqual({ title: 2, both: 2, every: 4 });
    // Open states are followed just the same.
    const open = apply(structuredClone(s), { type: 'page.update', pageId: about, route: '/about-us/' });
    expect(run(open)).toBe(`Start and /about-us/ / ${Object.keys(open.pages).length}`);
    expect(computed).toEqual({ title: 2, both: 3, every: 5 });
    // The theme packs replaced: everything is made again, for the very same state too.
    registerPacks([...listThemes()]);
    run(open);
    expect(computed).toEqual({ title: 3, both: 4, every: 6 });
    expect(cache.derivedFor(open, 'title')).toBe('Start');
    registerPacks([...listThemes()]);
    expect(cache.derivedFor(open, 'title')).toBeUndefined();
  });

  it('works a derived value that hands back what it read out from the plain state, every state (#965)', () => {
    const { s: site, home } = multiPageSite();
    const cache = new GenerationCache();
    let computed = 0;
    const run = (st: ProjectState) => {
      const r = cache.run(st, false);
      const content = r.file('a', (x) => derived(x, 'home', (y) => (computed++, { page: y.pages[home] })).page.title);
      r.finish();
      return content;
    };
    let s = frozen(structuredClone(site));
    expect(run(s)).toBe(s.pages[home].title);
    s = frozen(apply(s, { type: 'page.update', pageId: home, title: 'Start' }));
    expect(run(s)).toBe('Start');
    const before = computed;
    s = frozen(apply(s, { type: 'page.update', pageId: home, description: 'Changed' }));
    run(s);
    expect(computed).toBe(before + 1);
    // A getter may read the view it was made with whenever it is called: from the plain state as well.
    const named = (st: ProjectState) => {
      const r = cache.run(st, false);
      const content = r.file('b', (x) => derived(x, 'named', (y) => ({ get name() { return y.site.name; } })).name);
      r.finish();
      return content;
    };
    expect(named(s)).toBe(s.site.name);
    s = frozen(apply(s, { type: 'site.update', name: 'Renamed' } as EditOperation));
    expect(named(s)).toBe('Renamed');
  });

  it('gives what an uncached run gives when a derived value goes on past one it could not work out (#965)', () => {
    const { s: site, home } = multiPageSite();
    const make = (x: ProjectState) =>
      derived(x, 'outer', (y) => {
        try {
          return derived(y, 'inner', (z) => {
            if (z.pages[home].title === 'Broken') throw new Error('No title');
            return z.pages[home].title;
          });
        } catch {
          return 'fallback';
        }
      });
    const cache = new GenerationCache();
    for (const title of ['Fine', 'Broken', 'Fine again']) {
      const s = frozen(apply(structuredClone(site), { type: 'page.update', pageId: home, title }));
      const r = cache.run(s, false);
      expect(r.file('a', make)).toBe(make(s));
      r.finish();
    }
  });

  it('works out the agents\' listing once for every document a run asks about, not once each (#965)', () => {
    const { s: site } = multiPageSite();
    const s = frozen(apply(site, { type: 'site.update', markdownMirrors: true } as EditOperation));
    const full = [...generateProject(structuredClone(s))];
    const resolvers = vi.spyOn(seoMetadata, 'createSeoResolver');
    generateProject(s);
    const uncached = resolvers.mock.calls.length;
    resolvers.mockClear();
    const files = [...generateProject(s, {}, new GenerationCache())];
    const cached = resolvers.mock.calls.length;
    resolvers.mockRestore();
    expect(files).toEqual(full);
    expect(full.filter(([path]) => path.endsWith('.md')).length).toBeGreaterThan(10);
    expect(uncached).toBeGreaterThan(0);
    // Each document's address is read from one listing: a few more than an uncached run, never one per document.
    expect(cached).toBeLessThan(uncached + 5);
  });

  it('follows the posts before and after each post, and its summary, as posts are published, dated and written (#965)', () => {
    let s = createStarterState('business', 'Posts', false);
    const ops: EditOperation[] = [{ type: 'collection.create', collectionId: 'posts' } as EditOperation];
    for (let i = 1; i <= 6; i++) ops.push({ type: 'entry.create', collectionId: 'posts', entryId: `en_p${i}`, title: `Post ${i}`, publishedAt: `2024-01-0${i}`, draft: false, ...(i % 2 ? { excerpt: `Post ${i} in short.` } : {}), body: [`Post ${i} says this.`] } as EditOperation);
    s = frozen(apply(s, ...ops));
    const cache = new GenerationCache();
    check(s, cache);
    for (const op of [
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_p3', draft: true },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_p5', publishedAt: '2023-12-31' },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_p3', draft: false },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_p1', excerpt: null },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_p2', body: ['Written again.'] }
    ]) {
      s = frozen(apply(s, op as EditOperation));
      check(s, cache);
    }
  });

  it('copies the theme fonts a run found the site using, brief or not (#964)', () => {
    const { s } = multiPageSite();
    for (const state of [s, applyOperations(s, [{ type: 'brief.update', description: 'A studio', notes: 'Notes' }]).state]) {
      const cache = new GenerationCache();
      generateProject(state, {}, cache);
      generateProject(state, { instrument: true }, cache);
      // The fonts are not searched for again: the runs over this very state found them.
      const search = vi.spyOn(fonts, 'usedPackFonts');
      const copies = packFileCopies(state, cache);
      expect(search).not.toHaveBeenCalled();
      search.mockRestore();
      expect(copies.length).toBeGreaterThan(0);
      expect(copies).toEqual(packFileCopies(state));
      // A later state the cache has not run over is worked out for itself.
      const later = applyOperations(state, [{ type: 'token.set', tokenId: 'font.display', value: 'Lora' }]).state;
      expect(packFileCopies(later, cache)).toEqual(packFileCopies(later));
      expect(packFileCopies(later, cache)).not.toEqual(packFileCopies(state, cache));
    }
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
