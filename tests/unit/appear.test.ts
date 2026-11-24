/**
 * Entrance presets (issue #355): setting and clearing them on sections, containers and lists through operations, and
 * what the generator writes for them: the preset on the element it belongs to, the observer and its rules only on a
 * site where a visitor can meet one, and nothing at all on a site without them.
 */
import { describe, expect, it } from 'vitest';
import type { ElementNode, InstanceNode, OwnerRef, ProjectState, RepeatNode } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { designAppear } from '@engine/tree';
import { RUNTIME_DIR, STYLES_DIR, defFile, generateProject, pageFile, publishedState } from '@generator/index';
import { APPEAR_FILE, usesAppear } from '@generator/appear';
import { compile } from 'svelte/compiler';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState): OwnerRef => ({ kind: 'page', id: s.site.homePageId });
const section = (s: ProjectState, componentId: string, pageId = s.site.homePageId) => {
  const p = s.pages[pageId];
  return p.rootIds.map((id) => p.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === componentId)!;
};
const appear = (o: OwnerRef, nodeId: string, value: unknown): EditOperation => ({ type: 'node.setContent', owner: o, nodeId, field: 'appear', value });
const stagger = (o: OwnerRef, nodeId: string, value: unknown): EditOperation => ({ type: 'node.setContent', owner: o, nodeId, field: 'appearStagger', value });
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;
const runtime = `${RUNTIME_DIR}/${APPEAR_FILE}`;

/** The business starter with Features forked into the project, so its design can be edited. */
function withGridDesign() {
  let s = fresh();
  const grid = section(s, 'features.grid');
  const fork = applyOperations(s, [{ type: 'component.fork', definitionId: grid.definitionId }]);
  s = fork.state;
  return { s, grid: section(s, 'features.grid'), design: { kind: 'component', id: fork.results[0].definitionId as string } as OwnerRef };
}

/** A blank site with one layout section on Home and a stack (a container) inside it. */
function withStack() {
  let s = createStarterState('blank', 'Blank', false);
  s = apply(s, [{ type: 'node.insert', owner: owner(s), componentId: 'layout.section' }]);
  const sec = home(s).nodes[home(s).rootIds[0]] as InstanceNode;
  s = apply(s, [{ type: 'node.insert', owner: owner(s), parentId: sec.id, slot: 'content', primitive: 'stack' }]);
  const stackId = (home(s).nodes[sec.id] as InstanceNode).slots!.content.at(-1)!;
  s = apply(s, [{ type: 'node.insert', owner: owner(s), parentId: stackId, primitive: 'heading', text: 'Opening hours' }]);
  return { s, section: sec.id, stack: stackId };
}

/** Every generated Svelte file compiles, for the client and the server. */
function compiles(files: Map<string, string>) {
  for (const [path, source] of files) {
    if (!path.endsWith('.svelte')) continue;
    for (const generate of ['client', 'server'] as const) expect(() => compile(source, { filename: path, generate, runes: true }), path).not.toThrow();
  }
}

describe('entrance operations', () => {
  it('sets, changes, turns off and clears a section’s entrance', () => {
    let s = fresh();
    const hero = section(s, 'hero.split');
    s = apply(s, [appear(owner(s), hero.id, 'lift')]);
    expect((home(s).nodes[hero.id] as InstanceNode).appear).toBe('lift');
    s = apply(s, [appear(owner(s), hero.id, 'scale-subtle')]);
    expect((home(s).nodes[hero.id] as InstanceNode).appear).toBe('scale-subtle');
    // A placement keeps "none": it turns off whatever its design chooses.
    s = apply(s, [appear(owner(s), hero.id, 'none')]);
    expect((home(s).nodes[hero.id] as InstanceNode).appear).toBe('none');
    s = apply(s, [appear(owner(s), hero.id, null)]);
    expect(Object.hasOwn(home(s).nodes[hero.id], 'appear')).toBe(false);
  });

  it('sets and clears a container’s entrance, where "none" simply clears it', () => {
    let { s, stack } = withStack();
    s = apply(s, [appear(owner(s), stack, 'fade')]);
    expect((home(s).nodes[stack] as ElementNode).appear).toBe('fade');
    s = apply(s, [appear(owner(s), stack, 'none')]);
    expect(Object.hasOwn(home(s).nodes[stack], 'appear')).toBe(false);
    s = apply(s, [appear(owner(s), stack, 'lift'), appear(owner(s), stack, '')]);
    expect(Object.hasOwn(home(s).nodes[stack], 'appear')).toBe(false);
  });

  it('sets a design’s container entrance and staggers its list, and the design’s root is what placements follow', () => {
    let { s, design } = withGridDesign();
    s = apply(s, [appear(design, 'card', 'lift'), stagger(design, 'cards', true), appear(design, 'root', 'fade')]);
    const tree = s.components[design.id].tree!;
    expect((tree.nodes.card as ElementNode).appear).toBe('lift');
    expect((tree.nodes.cards as RepeatNode).appearStagger).toBe(true);
    expect(designAppear(s, s.components[design.id])).toBe('fade');
    s = apply(s, [stagger(design, 'cards', false)]);
    expect(Object.hasOwn(s.components[design.id].tree!.nodes.cards, 'appearStagger')).toBe(false);
  });

  it('refuses what has no entrance, unknown presets, and code components', () => {
    const { s, design } = withGridDesign();
    const hero = section(s, 'hero.split');
    expect(() => apply(s, [appear(owner(s), hero.id, 'spin')])).toThrow(/fade, lift, scale-subtle or none/);
    expect(() => apply(s, [appear(owner(s), hero.id, true)])).toThrow(/fade, lift, scale-subtle or none/);
    expect(() => apply(s, [appear(design, 'card-title', 'fade')])).toThrow(/Only sections and containers/);
    expect(() => apply(s, [appear(design, 'cards', 'fade')])).toThrow(/Only sections and containers/);
    expect(() => apply(s, [stagger(design, 'card', true)])).toThrow(/Only a repeated list/);
    expect(() => apply(s, [stagger(design, 'cards', 'yes')])).toThrow(/true or false/);
    // The shared header is a code component: its markup is its own.
    const header = s.site.shell.header.rootIds[0];
    expect(() => apply(s, [appear({ kind: 'shell', id: 'header' }, header, 'fade')])).toThrow(/not on code components/);
  });

  it('keeps a container’s entrance with its placement when it becomes a component', () => {
    let { s, stack } = withStack();
    s = apply(s, [appear(owner(s), stack, 'lift')]);
    const r = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: stack, name: 'Hours card' }]);
    const def = r.state.components[r.results[0].definitionId as string];
    expect(Object.hasOwn(def.tree!.nodes[def.tree!.rootIds[0]], 'appear')).toBe(false);
    expect((home(r.state).nodes[r.results[0].nodeId as string] as InstanceNode).appear).toBe('lift');
    expect(generateProject(r.state).get(defFile(def))).toContain(`data-appear={so_appear === 'none' ? undefined : so_appear}`);
  });

  it('writes a converted code copy’s entrance into its source, and nothing for a copy without one', () => {
    let s = fresh();
    const hero = section(s, 'hero.split');
    // Another section animates, so the site's designs take entrances from their placements while converting.
    s = apply(s, [{ type: 'component.makeUnique', owner: owner(s), nodeId: hero.id, name: 'Hero copy' }, appear(owner(s), section(s, 'cta.banner').id, 'fade')]);
    const plain = applyOperations(s, [{ type: 'component.convertToCode', owner: owner(s), nodeId: hero.id, name: 'Hero plain' }]);
    expect(plain.state.components[plain.results[0].definitionId as string].source).not.toMatch(/data-appear|so_appear|so_stagger/);
    s = apply(s, [appear(owner(s), hero.id, 'lift')]);
    const c = applyOperations(s, [{ type: 'component.convertToCode', owner: owner(s), nodeId: hero.id, name: 'Hero code' }]);
    const code = c.state.components[c.results[0].definitionId as string];
    expect(code.source).toMatch(/<section [^>]*data-appear="lift"/);
    expect(code.source).not.toMatch(/so_appear|so_stagger/);
    expect(Object.hasOwn(home(c.state).nodes[hero.id], 'appear')).toBe(false);
    // The copy alone still turns the observer on.
    s = apply(c.state, [appear(owner(c.state), section(c.state, 'cta.banner').id, null)]);
    expect(usesAppear(s)).toBe(true);
    expect(generateProject(s).has(runtime)).toBe(true);
  });

  it('writes a converted copy’s entrance onto a heading root, and passes it to a design at its root', () => {
    let { s, stack } = withStack();
    const heading = (home(s).nodes[stack] as ElementNode).children[0];
    const made = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: heading, name: 'Big heading' }]);
    s = apply(made.state, [appear(owner(made.state), made.results[0].nodeId as string, 'lift')]);
    const c = applyOperations(s, [{ type: 'component.convertToCode', owner: owner(s), nodeId: made.results[0].nodeId as string, name: 'Heading code' }]);
    expect(c.state.components[c.results[0].definitionId as string].source).toMatch(/<h\d [^>]*data-appear="lift"/);
    expect(usesAppear(c.state)).toBe(true);

    // A design whose root places another design: the copy passes the entrance on, and the site keeps its observer.
    let t = fresh();
    const hero = section(t, 'hero.split');
    const wrap = applyOperations(t, [{ type: 'component.createFromNode', owner: owner(t), nodeId: hero.id, name: 'Hero wrap' }]);
    t = wrap.state;
    const placed = wrap.results[0].nodeId as string;
    t = apply(t, [appear(owner(t), placed, 'scale-subtle')]);
    const w = applyOperations(t, [{ type: 'component.convertToCode', owner: owner(t), nodeId: placed, name: 'Wrap code' }]);
    expect(w.state.components[w.results[0].definitionId as string].source).toContain('so_appear={"scale-subtle"}');
    expect(usesAppear(w.state)).toBe(true);
    const files = generateProject(w.state);
    expect(files.get(defFile(w.state.components[hero.definitionId]))).toContain(`data-appear={so_appear === 'none' ? undefined : so_appear}`);
    compiles(files);
  });

  it('can always clear an entrance a code placement was left with, which never turns the observer on', () => {
    let s = fresh();
    const header = s.site.shell.header.rootIds[0];
    (s.site.shell.header.nodes[header] as InstanceNode).appear = 'lift';
    expect(usesAppear(s)).toBe(false);
    s = apply(s, [appear({ kind: 'shell', id: 'header' }, header, null)]);
    expect(Object.hasOwn(s.site.shell.header.nodes[header], 'appear')).toBe(false);
  });
});

describe('entrances in the generated site', () => {
  it('adds nothing to a site without entrances', () => {
    const s = fresh();
    // The editor's own variant too.
    for (const instrument of [false, true]) {
      const files = generateProject(s, { instrument });
      expect(files.has(runtime)).toBe(false);
      for (const [path, content] of files) expect(content, path).not.toMatch(/data-appear|so_appear|so_stagger|observeAppear|so-appear/);
    }
  });

  it('puts a section’s entrance on its design’s root element and starts the observer from the layout', () => {
    let s = fresh();
    const hero = section(s, 'hero.split');
    s = apply(s, [appear(owner(s), hero.id, 'lift')]);
    const files = generateProject(s);
    expect(files.get(pageFile(home(s)))).toContain('so_appear={"lift"}');
    const heroFile = files.get(defFile(s.components[hero.definitionId]))!;
    expect(heroFile).toContain('so_appear = undefined,');
    expect(heroFile).toMatch(/<section [^>]*data-appear=\{so_appear === 'none' \? undefined : so_appear\} data-appear-stagger=\{so_stagger\}/);
    const layout = files.get('src/routes/+layout.svelte')!;
    expect(layout).toContain(`import { observeAppear } from '../lib/siteorigin/runtime/${APPEAR_FILE}';`);
    expect(layout).toContain("import { onMount } from 'svelte';");
    expect(layout).toContain('onMount(observeAppear);');
    const js = files.get(runtime)!;
    expect(js).toContain('export function observeAppear()');
    expect(js).not.toContain('data-so-editing');
    const css = files.get(`${STYLES_DIR}/site.css`)!;
    expect(css).toContain('@media screen and (prefers-reduced-motion: no-preference) {');
    // Every rule that hides or moves anything is inside that block: printouts and reduced motion never match one.
    const outside = css.replace(/@media screen and \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}\n/, '');
    expect(outside).not.toBe(css);
    expect(outside).not.toMatch(/\[data-appear/);
    compiles(files);
  });

  it('writes the editor’s variant of the observer, which waits for Preview', () => {
    let s = fresh();
    s = apply(s, [appear(owner(s), section(s, 'cta.banner').id, 'fade')]);
    const files = generateProject(s, { instrument: true });
    expect(files.get(runtime)).toContain("document.documentElement.hasAttribute('data-so-editing')");
    // The editor's layout imports onMount once, for its bridge and the observer alike.
    const layout = files.get('src/routes/+layout.svelte')!;
    expect(layout.match(/import \{ onMount \} from 'svelte';/g)).toHaveLength(1);
    expect(layout).toContain('onMount(observeAppear);');
    compiles(files);
  });

  it('lets a placement turn its design’s entrance off, and a design’s nested root pass one on', () => {
    let { s, design, grid } = withGridDesign();
    s = apply(s, [appear(design, 'root', 'fade'), appear(owner(s), grid.id, 'none')]);
    // Nothing else animates: the site has no entrances, and says none.
    expect(generateProject(s).get(defFile(s.components[design.id]))).not.toContain('data-appear');
    s = apply(s, [appear(owner(s), section(s, 'cta.banner').id, 'lift')]);
    const files = generateProject(s);
    expect(files.get(pageFile(home(s)))).toContain('so_appear={"none"}');
    expect(files.get(defFile(s.components[design.id]))).toContain(`data-appear={so_appear === 'none' ? undefined : so_appear ?? "fade"}`);
    compiles(files);
  });

  it('marks each item of a staggered list with its item, and only while the list staggers', () => {
    let { s, design } = withGridDesign();
    s = apply(s, [appear(design, 'card', 'lift')]);
    const file = () => generateProject(s).get(defFile(s.components[design.id]))!;
    expect(file()).toMatch(/data-appear="lift"(?! data-appear-stagger)/);
    s = apply(s, [stagger(design, 'cards', true)]);
    expect(file()).toContain('data-appear="lift" data-appear-stagger={item.id}');
    compiles(generateProject(s));
  });

  it('passes a staggered list’s item on to a component placed as the item', () => {
    let { s, design } = withGridDesign();
    // The card becomes a component of its own, placed once per item.
    const r = applyOperations(s, [stagger(design, 'cards', true), { type: 'component.createFromNode', owner: design, nodeId: 'card', name: 'Feature card' }]);
    s = r.state;
    const card = r.results[1].definitionId as string;
    s = apply(s, [appear({ kind: 'component', id: card }, s.components[card].tree!.rootIds[0], 'lift')]);
    const files = generateProject(s);
    expect(files.get(defFile(s.components[design.id]))).toMatch(/<C_\w+\s[^>]*so_stagger=\{item\.id\}/);
    expect(files.get(defFile(s.components[card]))).toContain('data-appear={so_appear === \'none\' ? undefined : so_appear ?? "lift"} data-appear-stagger={so_stagger}');
    compiles(files);
  });

  it('leaves the observer out when only a draft, or a component nothing places, has an entrance', () => {
    let s = fresh();
    const about = s.site.pageOrder.find((id) => id !== s.site.homePageId)!;
    const sec = s.pages[about].rootIds[0];
    s = apply(s, [appear({ kind: 'page', id: about }, sec, 'lift'), { type: 'page.update', pageId: about, draft: true }]);
    // The editor still previews the draft with its entrance; the published site has none.
    expect(generateProject(s).has(runtime)).toBe(true);
    const published = generateProject(publishedState(s));
    expect(published.has(runtime)).toBe(false);
    expect(published.get('src/routes/+layout.svelte')).not.toContain('observeAppear');

    // A copy nothing places.
    let t = fresh();
    const d = applyOperations(t, [{ type: 'component.duplicate', definitionId: section(t, 'cta.banner').definitionId, name: 'Spare banner' }]);
    t = d.state;
    const spare = d.results[0].definitionId as string;
    t = apply(t, [appear({ kind: 'component', id: spare }, t.components[spare].tree!.rootIds[0], 'fade')]);
    expect(usesAppear(t)).toBe(false);
    expect(generateProject(t).has(runtime)).toBe(false);
    // Placed on a page, it counts.
    t = apply(t, [{ type: 'node.insert', owner: owner(t), definitionId: spare }]);
    expect(usesAppear(t)).toBe(true);
    expect(generateProject(t).has(runtime)).toBe(true);
  });

  it('ignores a hand-edited preset it does not know', () => {
    let s = fresh();
    (section(s, 'hero.split') as { appear?: string }).appear = 'spin';
    expect(usesAppear(s)).toBe(false);
    expect([...generateProject(s).values()].some((c) => c.includes('spin'))).toBe(false);
    // Nor while the site has entrances elsewhere.
    s = apply(s, [appear(owner(s), section(s, 'cta.banner').id, 'fade')]);
    expect(generateProject(s).get(pageFile(home(s)))).not.toContain('spin');
  });

  it('counts the shared footer only while a page shows it, and a design’s entrance only where a placement keeps it', () => {
    let s = fresh();
    const footer = s.site.shell.footer.rootIds[0];
    s = apply(s, [appear({ kind: 'shell', id: 'footer' }, footer, 'fade')]);
    expect(usesAppear(s)).toBe(true);
    s = apply(s, s.site.pageOrder.map((pageId): EditOperation => ({ type: 'page.update', pageId, showFooter: false })));
    expect(usesAppear(s)).toBe(false);
    expect(generateProject(s).has(runtime)).toBe(false);

    // The grid design's root fades in, but its only placement turns that off.
    let { s: t, design, grid } = withGridDesign();
    t = apply(t, [appear(design, 'root', 'fade'), appear(owner(t), grid.id, 'none')]);
    expect(usesAppear(t)).toBe(false);
    // A preset deeper in the design still counts.
    t = apply(t, [appear(design, 'card', 'lift')]);
    expect(usesAppear(t)).toBe(true);
  });

  it('passes a placement’s entrance through a design whose root places another design', () => {
    let s = fresh();
    const hero = section(s, 'hero.split');
    s = apply(s, [appear(owner(s), hero.id, 'scale-subtle')]);
    const wrap = applyOperations(s, [{ type: 'component.createFromNode', owner: owner(s), nodeId: hero.id, name: 'Hero wrap' }]);
    s = wrap.state;
    const wrapDef = wrap.results[0].definitionId as string;
    // The section's own choice stays with its placement; the new design's root (the hero placed inside) has none.
    expect((home(s).nodes[wrap.results[0].nodeId as string] as InstanceNode).appear).toBe('scale-subtle');
    const inner = s.components[wrapDef].tree!.rootIds[0];
    expect(Object.hasOwn(s.components[wrapDef].tree!.nodes[inner], 'appear')).toBe(false);
    s = apply(s, [appear({ kind: 'component', id: wrapDef }, inner, 'fade')]);
    expect(designAppear(s, s.components[wrapDef])).toBe('fade');
    const files = generateProject(s);
    expect(files.get(defFile(s.components[wrapDef]))).toContain('so_appear={so_appear ?? "fade"}');
    expect(files.get(defFile(s.components[hero.definitionId]))).toContain(`data-appear={so_appear === 'none' ? undefined : so_appear}`);
    compiles(files);
  });
});
