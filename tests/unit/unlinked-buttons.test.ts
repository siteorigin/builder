import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { ComponentDefinition, InstanceNode, LinkNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { unlinkedButtons, unlinkedMenuLinks } from '@generator/checks';
import { linkSvelte } from '@generator/runtime-files';
import { unlinkedButtonWarnings, unlinkedMenuLinkWarnings } from '../../src/main/export';
import { hideAt, hideButtonOp, unlinkedAt, unlinkedField, unlinkedNote } from '../../src/renderer/src/lib/unlinked';
import { bannerDesign, heroDesign, pricingDesign, sectionDesign } from './fixtures/unlinked-buttons-designs';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const pageNamed = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!;

/** Place a component at the end of a page (Home unless another is given). */
function place(s: ProjectState, def: ComponentDefinition, props: Record<string, unknown> = {}, page = home(s)): InstanceNode {
  const node = makeInstance(def, props);
  page.nodes[node.id] = node;
  page.rootIds.push(node.id);
  return node;
}

/**
 * The Business starter with a Pricing section added to Home, none of its cards' buttons with a destination, and a
 * standalone button placed on Home. Foundation's Pricing unless `design` asks for one made in the editor, whose cards'
 * buttons the editor finds node by node.
 */
function withPricing(design = false) {
  const s = fresh();
  const def = design ? pricingDesign(s) : s.components[installComponent(s, 'pricing.plans')];
  const plans = (def.properties.plans as { default: Array<Record<string, unknown>> }).default.map((p) => ({ ...p, actionLink: { type: 'none', target: '' } }));
  const pricing = place(s, def, { plans });
  const button: LinkNode = { id: 'n_standalone', kind: 'link', link: { type: 'none', target: '' }, label: 'Call us today', appearance: 'primary' };
  home(s).nodes[button.id] = button;
  home(s).rootIds.push(button.id);
  return { s, pricing: pricing as InstanceNode, button };
}

/** Give one pricing card a destination, keeping the other cards as they are. */
function linkPlan(s: ProjectState, pricing: InstanceNode, index: number, link: unknown) {
  const def = s.components[pricing.definitionId];
  const plans = structuredClone((pricing.props.plans ?? (def.properties.plans as { default: unknown[] }).default) as Array<Record<string, unknown>>);
  plans[index] = { ...plans[index], actionLink: link };
  pricing.props.plans = plans;
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * Server-render the generated Home page the way the exported site (or, with `instrument`, the editor's preview)
 * renders it: every generated Svelte file compiled for the server, with SvelteKit's `$app/paths` stubbed as a site
 * published under /studio, so a page link that skips resolve() shows.
 */
async function renderHome(s: ProjectState, opts: { instrument?: boolean } = {}): Promise<string> {
  return (await renderSite(s, opts))('src/routes/+page.svelte');
}

/** The same render for any generated route file: the site is compiled once, then each file is rendered on request. */
async function renderSite(s: ProjectState, opts: { instrument?: boolean } = {}): Promise<(file: string) => Promise<string>> {
  mkdirSync(resolve('.tmp'), { recursive: true });
  const dir = mkdtempSync(join(resolve('.tmp'), 'unlinked-'));
  roots.push(dir);
  const paths = join(dir, 'app-paths.js');
  writeFileSync(paths, 'export const resolve = (p) => "/studio" + p; export const asset = (p) => "/studio/" + p; export const base = "/studio";\n');
  // Navigation callbacks never run while rendering on the server.
  const navigation = join(dir, 'app-navigation.js');
  writeFileSync(navigation, 'export const beforeNavigate = () => {}; export const afterNavigate = () => {}; export const onNavigate = () => {}; export const snapshot = () => {};\n');
  const state = join(dir, 'app-state.js');
  writeFileSync(state, 'export const page = { url: new URL("https://example.com/studio/"), status: 200, error: null, params: {}, data: {}, route: { id: "/" } };\n');
  for (const [path, source] of generateProject(s, opts)) {
    if (!path.startsWith('src/') || !/\.(svelte|js)$/.test(path)) continue;
    const out = join(dir, path.endsWith('.svelte') ? `${path}.js` : path);
    mkdirSync(dirname(out), { recursive: true });
    const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
    writeFileSync(
      out,
      code
        .replace(/(["'])([^"'\n]+?\.svelte)\1/g, '$1$2.js$1')
        .replace(/^\s*import\s+(["'])[^"'\n]+\.css\1;?$/gm, '')
        .replace(/(["'])\$app\/paths\1/g, JSON.stringify(paths))
        .replace(/(["'])\$app\/navigation\1/g, JSON.stringify(navigation))
        .replace(/(["'])\$app\/state\1/g, JSON.stringify(state))
    );
  }
  return async (file) => {
    const Page = (await import(/* @vite-ignore */ join(dir, `${file}.js`))).default as Component<Record<string, unknown>>;
    // A layout renders what is inside it; the pages are rendered on their own.
    return render(Page, { props: { children: () => {} } }).body.replace(/<!--[\s\S]*?-->/g, '');
  };
}

/** The element that carries `text` as its whole content, or undefined. */
const elementWith = (html: string, text: string) => new RegExp(`<(a|span)\\b[^>]*>\\s*${text}\\s*</\\1>`).exec(html)?.[0];
/** The Pricing section and what follows it on Home (the standalone button comes last). */
const fromPricing = (html: string) => html.slice(html.indexOf('<section class="pricing '));

/** The Business starter with a split hero on Home after its own sections, its buttons going to Contact and About. */
function withHero(s = fresh()) {
  const def = heroDesign(s);
  const hero = place(s, def, { primaryLink: { type: 'page', target: pageNamed(s, 'Contact').id }, secondaryLink: { type: 'page', target: pageNamed(s, 'About').id } });
  return { s, hero, heroDef: def };
}

/** A call to action banner on Home, whose design a test puts more inside, its own button going to Contact. */
function withBanner(s = fresh()) {
  const banner = bannerDesign(s);
  const placed = place(s, banner, { primaryLink: { type: 'page', target: pageNamed(s, 'Contact').id } });
  return { banner, placed };
}

describe('buttons without a destination in visitor output', () => {
  it('leaves unlinked pricing actions and a standalone button out of the exported page', async () => {
    const { s } = withPricing();
    const page = await renderHome(s);
    const html = fromPricing(page);
    // The section and every card still render, and so does the hero's working "Start a project".
    for (const text of ['Clear packages, fixed fees', 'Consultation', 'Full service', '$4,800']) expect(html).toContain(text);
    expect(page).toMatch(/<a\b[^>]*href="\/studio\/contact\/"[^>]*>Start a project<\/a>/);
    for (const label of ['Book a visit', 'Start a project', 'Talk to us', 'Call us today']) expect(html).not.toContain(label);
    expect(page).not.toContain('so-btn--static');
    expect(page).not.toMatch(/<span\b[^>]*class="[^"]*so-btn/);
    // Nothing stands in for a button that has no anchor.
    expect(html).not.toMatch(/<span\b[^>]*><\/span>/);
  });

  it('keeps an unlinked button’s anchor so links to it still land', async () => {
    const { s, button } = withPricing();
    button.anchor = 'booking';
    const html = fromPricing(await renderHome(s));
    expect(html).toMatch(/<span id="booking"><\/span>/);
    expect(html.match(/id="booking"/g)).toHaveLength(1);
    expect(html).not.toContain('Call us today');
  });

  it('keeps working calls to action as real links that navigate', async () => {
    const { s, pricing, button } = withPricing();
    const about = pageNamed(s, 'About');
    linkPlan(s, pricing, 1, { type: 'page', target: about.id });
    linkPlan(s, pricing, 2, { type: 'email', target: 'hello@example.com' });
    button.link = { type: 'url', target: 'https://example.com/book', newTab: true };
    const html = fromPricing(await renderHome(s));
    const start = elementWith(html, 'Start a project');
    expect(start).toMatch(new RegExp(`^<a\\b[^>]*href="/studio${about.route}"[^>]*class="[^"]*so-btn so-btn--primary`));
    expect(start).not.toMatch(/target=|rel=/);
    expect(elementWith(html, 'Talk to us')).toMatch(/^<a\b[^>]*href="mailto:hello@example\.com"/);
    expect(elementWith(html, 'Call us today')).toMatch(/^<a\b[^>]*href="https:\/\/example\.com\/book"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    // Only the card still without a destination is left out.
    expect(html).not.toContain('Book a visit');
  });

  it('still renders a text link without a destination as its text', async () => {
    const { s, button } = withPricing();
    button.appearance = 'link';
    const html = fromPricing(await renderHome(s));
    expect(elementWith(html, 'Call us today')).toMatch(/^<span\b/);
    // It is not left out, so it is not reported as a button visitors won't see.
    expect(unlinkedButtons(s, home(s)).map((b) => b.label)).not.toContain('Call us today');
    expect(validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED' && d.message.includes('Call us today'))).toEqual([]);
  });
});

describe('a fresh starter', () => {
  for (const starter of ['business', 'showcase'] as const)
    it(`has no unfinished link on any page of the ${starter} starter`, async () => {
      const s = createStarterState(starter, 'Test Studio', false);
      const files = [...generateProject(s, { instrument: true }).keys()].filter((f) => /^src\/routes\/.*\+(page|layout)\.svelte$/.test(f));
      expect(files.length).toBeGreaterThan(Object.keys(s.pages).length);
      const render = await renderSite(s, { instrument: true });
      const found: string[] = [];
      for (const file of files)
        for (const m of (await render(file)).matchAll(/<(\w+)\b[^>]*data-so-unlinked[^>]*>([\s\S]*?)<\/\1>/g)) found.push(`${file}: ${m[2].replace(/<[^>]*>/g, '').trim()}`);
      expect(found).toEqual([]);
    });

  it('keeps the showcase’s buttons, each going to another of its pages unless it already had a destination', async () => {
    const s = createStarterState('showcase', 'Test Studio', false);
    const render = await renderSite(s);
    const pricing = await render('src/routes/pricing/+page.svelte');
    // The comparison table's three plans come with no destination, so each goes to Contact.
    for (const label of ['Book a session', 'Start a project', 'Talk to us']) expect(pricing).toMatch(new RegExp(`<a\\b[^>]*href="/studio/contact/"[^>]*>\\s*${label}\\s*</a>`));
    // The plans that come with a destination keep it.
    const placedProps = (id: string) => Object.values(s.pages).flatMap((p) => Object.values(p.nodes)).find((n): n is InstanceNode => n.kind === 'instance' && s.components[n.definitionId].componentId === id)!.props;
    for (const id of ['pricing.plans', 'pricing.toggle']) {
      const plans = placedProps(id).plans as Array<{ actionLink: { type: string } }>;
      expect(plans.map((p) => p.actionLink.type), id).toEqual(plans.map(() => 'email'));
    }
    // On Contact itself, a button goes on to Pricing.
    const contact = await render('src/routes/contact/+page.svelte');
    expect(elementWith(contact, 'See our packages')).toMatch(/^<a\b[^>]*href="\/studio\/pricing\/"/);
    // Rows without a button's words stay as they are: facts, contact details and the footer's address lead nowhere.
    for (const id of ['block.facts', 'contact.details']) {
      const rows = placedProps(id).items as Array<{ label: string; link: { type: string } }>;
      expect(rows.filter((r) => r.link.type === 'page'), id).toEqual([]);
    }
  });

  it('leaves a section a person adds asking where its buttons go', () => {
    const s = createStarterState('showcase', 'Test Studio', false);
    const added = makeInstance(s.components[installComponent(s, 'content.media')]);
    expect([added.props.actionLink, added.props.link]).toEqual([
      { type: 'none', target: '' },
      { type: 'none', target: '' }
    ]);
  });
});

describe('buttons without a destination in the editor preview', () => {
  it('shows each unlinked button of a design flagged, selectable and not a link', async () => {
    const { s, pricing } = withPricing(true);
    const about = pageNamed(s, 'About');
    linkPlan(s, pricing, 1, { type: 'page', target: about.id });
    const page = await renderHome(s, { instrument: true });
    // The design's section and what follows it on Home (the standalone button comes last).
    const html = page.slice(page.indexOf('so-foundation-project-pricing__root'));
    for (const label of ['Book a session', 'Talk to us', 'Call us today']) {
      const el = elementWith(html, label);
      expect(el, label).toMatch(/^<span\b/);
      expect(el).toContain('data-so-unlinked');
      expect(el).toMatch(/class="[^"]*so-btn so-btn--primary/);
      expect(el).toMatch(/data-so-node="[^"]+"/);
      expect(el).toMatch(/data-so-ctx="[^"]+"/);
      expect(el).toMatch(/title="[^"]*no link[^"]*"/i);
    }
    // Each card's button carries its own item, so a click selects that card.
    const items = [...html.matchAll(/data-so-unlinked=""[^>]*data-so-items="([^"]+)"|data-so-items="([^"]+)"[^>]*data-so-unlinked=""/g)].map((m) => m[1] ?? m[2]);
    expect(items).toHaveLength(2);
    expect(new Set(items).size).toBe(2);
    expect(elementWith(html, 'Start a project')).toMatch(new RegExp(`^<a\\b[^>]*href="/studio${about.route}"`));
    expect(elementWith(html, 'Start a project')).not.toContain('data-so-unlinked');
  });

  it('flags a button a code component places, which has no editor identity of its own', async () => {
    const build = async (source: string) => {
      const dir = mkdtempSync(join(resolve('.tmp'), 'unlinked-link-'));
      roots.push(dir);
      writeFileSync(join(dir, 'paths.js'), 'export const resolve = (p) => p;\n');
      writeFileSync(join(dir, 'Link.js'), compile(source, { filename: 'Link.svelte', generate: 'server', runes: true }).js.code.replace(/(["'])\$app\/paths\1/g, "'./paths.js'"));
      return (await import(/* @vite-ignore */ join(dir, 'Link.js'))).default as Component<Record<string, unknown>>;
    };
    mkdirSync(resolve('.tmp'), { recursive: true });
    const [dev, clean] = [await build(linkSvelte(true)), await build(linkSvelte())];
    for (const appearance of ['primary', 'secondary', 'text', 'light']) {
      const props = { link: null, appearance, class: 'x' };
      expect(render(dev, { props }).body).toMatch(new RegExp(`<span class="so-btn so-btn--${appearance} x" data-so-unlinked=""`));
      expect(render(clean, { props }).body.replace(/<!--[\s\S]*?-->/g, '')).toBe('');
    }
    // A button the code gives a click handler is an action, not a missing link: a real button for visitors too.
    for (const Link of [dev, clean]) {
      const action = (props: Record<string, unknown>) => /<button\b[^>]*>/.exec(render(Link, { props: { link: null, appearance: 'primary', class: 'x', onclick: () => undefined, ...props } }).body)?.[0] ?? '';
      expect(action({})).toContain('class="so-btn so-btn--primary x"');
      expect(action({})).toContain('type="button"');
      expect(action({})).not.toContain('data-so-unlinked');
      // A type the code leaves undefined still never submits a form; one it asks for is kept.
      expect(action({ type: undefined })).toContain('type="button"');
      expect(action({ type: 'submit' })).toContain('type="submit"');
      expect(action({ type: 'RESET' })).toContain('type="RESET"');
      // Code that gives a text link or a plain link a click handler keeps the text it always had; a control (a design's
      // button that changes what its component shows) is a real button whatever it looks like.
      for (const appearance of ['link', 'plain']) {
        const shown = (props: Record<string, unknown>) => render(Link, { props: { link: null, appearance, onclick: () => undefined, ...props } }).body;
        expect(shown({})).not.toContain('<button');
        expect(shown({ control: true })).not.toContain('<button');
        expect(shown({ so_control: true })).toMatch(/<button\b[^>]*type="button"/);
      }
    }
  });

  it('keeps editor-only markup out of the project source', () => {
    const { s } = withPricing();
    for (const [path, source] of generateProject(s)) expect(source, path).not.toContain('data-so-unlinked');
    expect(generateProject(s, { instrument: true }).get('src/lib/siteorigin/runtime/Link.svelte')).toContain('data-so-unlinked');
  });
});

describe('finding buttons without a destination', () => {
  const plans = (s: ProjectState, pricing: InstanceNode) => pricing.props.plans as Array<{ id: string; actionLabel: string }>;

  it('names the exact pricing card fields that set and show each button', () => {
    const { s, pricing } = withPricing(true);
    const found = unlinkedAt(s, { kind: 'page', id: s.site.homePageId }, pricing.id);
    const ids = plans(s, pricing).map((p) => p.id);
    expect(found).toEqual(
      ids.map((itemId, i) => ({
        nodeId: pricing.id,
        label: ['Book a session', 'Start a project', 'Talk to us'][i],
        defNodeId: 'plan-action',
        itemPath: [itemId],
        link: { prop: 'plans', itemId, field: 'actionLink' },
        hide: { prop: 'plans', itemId, field: 'actionLabel' }
      }))
    );
    expect(unlinkedField(found, 'plans', ids[1], 'actionLink')?.label).toBe('Start a project');
    expect(unlinkedNote(found[0])).toContain('or hide it');
  });

  it('names a section property, and reports a standalone button as itself', () => {
    const { s, button } = withPricing(true);
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const { hero } = withHero(s);
    hero.props.secondaryLink = { type: 'none', target: '' };
    expect(unlinkedAt(s, owner, hero.id)).toEqual([{ nodeId: hero.id, label: 'About the studio', defNodeId: 'secondary', link: { prop: 'secondaryLink' }, hide: { prop: 'secondaryLabel' } }]);
    expect(unlinkedAt(s, owner, button.id)).toEqual([{ nodeId: button.id, label: 'Call us today' }]);
    expect(unlinkedNote(unlinkedAt(s, owner, button.id)[0])).not.toContain('hide');
    // A label that cannot be empty, or that is not the button's condition, is no way to hide it.
    const heroDef = s.components[hero.definitionId];
    heroDef.properties.secondaryLabel = { type: 'enum', label: 'Secondary label', default: 'About the studio', options: [{ value: 'About the studio', label: 'About' }] };
    expect(unlinkedAt(s, owner, hero.id)[0].hide).toBeUndefined();
    heroDef.properties.secondaryLabel = { type: 'string', label: 'Secondary label', default: '' };
    (heroDef.tree!.nodes['secondary'] as LinkNode).when = { $prop: 'heading' };
    expect(unlinkedAt(s, owner, hero.id)[0]).toMatchObject({ link: { prop: 'secondaryLink' } });
    expect(unlinkedAt(s, owner, hero.id)[0].hide).toBeUndefined();
  });

  it('never points at a placement’s own field for a button a component inside it sets', () => {
    const s = fresh();
    // The banner has its own primaryLink and primaryLabel; a hero inside its design has fields of the same names.
    const { banner } = withBanner(s);
    const heroDef = heroDesign(s);
    const inner = makeInstance(heroDef, { primaryLabel: 'Inner go', primaryLink: { type: 'none', target: '' }, secondaryLabel: '' });
    banner.tree!.nodes[inner.id] = inner;
    (banner.tree!.nodes[banner.tree!.rootIds[0]] as { children: string[] }).children.push(inner.id);
    const placed = Object.values(home(s).nodes).find((n) => n.kind === 'instance' && n.definitionId === banner.id)!;
    const found = unlinkedAt(s, { kind: 'page', id: s.site.homePageId }, placed.id).find((b) => b.label === 'Inner go');
    expect(found).toEqual({ nodeId: placed.id, label: 'Inner go', defNodeId: 'primary' });
    // The banner's own button, with the same field names, still points at the banner's fields.
    (placed as InstanceNode).props.primaryLink = { type: 'none', target: '' };
    expect(unlinkedAt(s, { kind: 'page', id: s.site.homePageId }, placed.id).find((b) => b.label !== 'Inner go')).toMatchObject({ link: { prop: 'primaryLink' }, hide: { prop: 'primaryLabel' } });
  });

  it('follows a component inside a design back to the placement field its bindings read', () => {
    const s = fresh();
    const { banner } = withBanner(s);
    const heroDef = heroDesign(s);
    // The inner hero's primary button takes the banner's own "inner" label and link, which nothing else reads.
    banner.properties.innerLabel = { type: 'string', label: 'Inner label', default: '' };
    banner.properties.innerLink = { type: 'link', label: 'Inner link', default: { type: 'none', target: '' } };
    const inner = makeInstance(heroDef, { primaryLabel: { $prop: 'innerLabel' }, primaryLink: { $prop: 'innerLink' }, secondaryLabel: '' });
    banner.tree!.nodes[inner.id] = inner;
    (banner.tree!.nodes[banner.tree!.rootIds[0]] as { children: string[] }).children.push(inner.id);
    const placed = Object.values(home(s).nodes).find((n) => n.kind === 'instance' && n.definitionId === banner.id) as InstanceNode;
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    placed.props.innerLabel = 'Forwarded';
    expect(unlinkedAt(s, owner, placed.id).filter((b) => b.label === 'Forwarded')).toEqual([{ nodeId: placed.id, label: 'Forwarded', defNodeId: 'primary', link: { prop: 'innerLink' }, hide: { prop: 'innerLabel' } }]);
    // Once the banner's own working button shows the same label, clearing it would hide that one too.
    (inner.props as Record<string, unknown>).primaryLabel = { $prop: 'primaryLabel' };
    const shared = unlinkedAt(s, owner, placed.id).find((b) => b.defNodeId === 'primary' && b.link?.prop === 'innerLink');
    expect(shared).toMatchObject({ link: { prop: 'innerLink' } });
    expect(shared?.hide).toBeUndefined();
  });

  it('offers no Hide when anything else around the button reads its label, or it carries an id', () => {
    const { s, hero, heroDef } = withHero();
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    hero.props.secondaryLink = { type: 'none', target: '' };
    expect(unlinkedAt(s, owner, hero.id)[0].hide).toEqual({ prop: 'secondaryLabel' });
    // The wrapper around both buttons shows only with the secondary label: hiding would take the working primary too.
    const wrapper = Object.values(heroDef.tree!.nodes).find((n) => n.kind === 'element' && n.children.includes('secondary'))!;
    wrapper.when = { $prop: 'secondaryLabel' };
    expect(unlinkedAt(s, owner, hero.id)[0]).toMatchObject({ link: { prop: 'secondaryLink' } });
    expect(unlinkedAt(s, owner, hero.id)[0].hide).toBeUndefined();
    delete wrapper.when;
    // An anchored button may be where another link goes.
    heroDef.tree!.nodes['secondary'].anchor = 'more';
    expect(unlinkedAt(s, owner, hero.id)[0].hide).toBeUndefined();
  });

  it('names every list a button sits in, and offers no Hide inside a list within a list', () => {
    const { s, pricing } = withPricing(true);
    const def = s.components[pricing.definitionId];
    const none = { type: 'none', target: '' };
    def.properties.extras = { type: 'list', label: 'Extras', itemLabel: 'Extra', fields: { label: { type: 'string', label: 'Label', default: '' }, link: { type: 'link', label: 'Link', default: none } }, default: [] } as never;
    pricing.props.extras = [{ id: 'x1', label: 'Add-on', link: none }];
    def.tree!.nodes['extra-link'] = { id: 'extra-link', kind: 'link', link: { $item: 'link' }, label: { $item: 'label' }, appearance: 'secondary', when: { $item: 'label' } } as LinkNode;
    def.tree!.nodes['extra-items'] = { id: 'extra-items', kind: 'repeat', list: { $prop: 'extras' }, children: ['extra-link'] };
    (def.tree!.nodes['plan'] as { children: string[] }).children.push('extra-items');
    const found = unlinkedAt(s, { kind: 'page', id: s.site.homePageId }, pricing.id).filter((b) => b.defNodeId === 'extra-link');
    const plans = (pricing.props.plans as Array<{ id: string }>).map((p) => p.id);
    expect(found.map((b) => b.itemPath)).toEqual(plans.map((id) => [id, 'x1']));
    expect(found.every((b) => b.link?.prop === 'extras' && b.link.itemId === 'x1' && !b.hide)).toBe(true);
  });

  it('offers no Hide for a button a second slot of the same name shows again', () => {
    const s = fresh();
    const section = sectionDesign(s);
    const slotNode = Object.values(section.tree!.nodes).find((n) => n.kind === 'slot')!;
    const holder = Object.values(section.tree!.nodes).find((n) => n.kind === 'element' && n.children.includes(slotNode.id)) as { children: string[] };
    section.tree!.nodes['slot-again'] = { ...slotNode, id: 'slot-again' };
    holder.children.push('slot-again');
    const { banner } = withBanner(s);
    banner.properties.innerLabel = { type: 'string', label: 'Inner label', default: 'Again' };
    banner.properties.innerLink = { type: 'link', label: 'Inner link', default: { type: 'none', target: '' } };
    const heroDef = heroDesign(s);
    const hero = makeInstance(heroDef, { primaryLabel: { $prop: 'innerLabel' }, primaryLink: { $prop: 'innerLink' }, secondaryLabel: '' });
    const holderInstance = makeInstance(section, {});
    holderInstance.slots = { [(slotNode as { slot: string }).slot]: [hero.id] };
    banner.tree!.nodes[hero.id] = hero;
    banner.tree!.nodes[holderInstance.id] = holderInstance;
    (banner.tree!.nodes[banner.tree!.rootIds[0]] as { children: string[] }).children.push(holderInstance.id);
    const placed = Object.values(home(s).nodes).find((n) => n.kind === 'instance' && n.definitionId === banner.id) as InstanceNode;
    const found = unlinkedAt(s, { kind: 'page', id: s.site.homePageId }, placed.id).filter((b) => b.label === 'Again');
    // Reported once, like any slot content, but the label it would clear shows twice.
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ link: { prop: 'innerLink' } });
    expect(found[0].hide).toBeUndefined();
  });

  it('walks content one child placed in two slots shows once per supplier, however deep', () => {
    const s = fresh();
    const section = sectionDesign(s);
    const slotNode = Object.values(section.tree!.nodes).find((n) => n.kind === 'slot') as { id: string; slot: string };
    const holder = Object.values(section.tree!.nodes).find((n) => n.kind === 'element' && n.children.includes(slotNode.id)) as { children: string[] };
    section.tree!.nodes['slot-b'] = { ...slotNode, id: 'slot-b', slot: 'b' } as never;
    holder.children.push('slot-b');
    const button: LinkNode = { id: 'n_deep_button', kind: 'link', link: { type: 'none', target: '' }, label: 'Deep', appearance: 'primary' };
    home(s).nodes[button.id] = button;
    let inner = button.id;
    for (let i = 0; i < 12; i++) {
      const level = makeInstance(section, {});
      level.slots = { [slotNode.slot]: [inner], b: [inner] };
      home(s).nodes[level.id] = level;
      inner = level.id;
    }
    home(s).rootIds = [inner];
    const started = Date.now();
    // The innermost section shows the button through both its slots; nothing above multiplies that.
    expect(unlinkedButtons(s, home(s)).filter((b) => b.label === 'Deep')).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('offers no Hide for a button a slot inside a list shows more than once', () => {
    const s = fresh();
    const section = sectionDesign(s);
    const slotNode = Object.values(section.tree!.nodes).find((n) => n.kind === 'slot')!;
    const holder = Object.values(section.tree!.nodes).find((n) => n.kind === 'element' && n.children.includes(slotNode.id)) as { children: string[] };
    section.properties.rows = { type: 'list', label: 'Rows', itemLabel: 'Row', fields: {}, default: [{ id: 'r1' }, { id: 'r2' }] } as never;
    section.tree!.nodes['rows'] = { id: 'rows', kind: 'repeat', list: { $prop: 'rows' }, children: [slotNode.id] };
    holder.children = holder.children.map((c) => (c === slotNode.id ? 'rows' : c));
    // The banner's design puts a section inside it, and in the section's slot a hero whose button reads the banner's fields.
    const { banner } = withBanner(s);
    banner.properties.innerLabel = { type: 'string', label: 'Inner label', default: 'Twice' };
    banner.properties.innerLink = { type: 'link', label: 'Inner link', default: { type: 'none', target: '' } };
    const heroDef = heroDesign(s);
    const hero = makeInstance(heroDef, { primaryLabel: { $prop: 'innerLabel' }, primaryLink: { $prop: 'innerLink' }, secondaryLabel: '' });
    const holderInstance = makeInstance(section, {});
    holderInstance.slots = { [slotNode.kind === 'slot' ? slotNode.slot : 'content']: [hero.id] };
    banner.tree!.nodes[hero.id] = hero;
    banner.tree!.nodes[holderInstance.id] = holderInstance;
    (banner.tree!.nodes[banner.tree!.rootIds[0]] as { children: string[] }).children.push(holderInstance.id);
    const placed = Object.values(home(s).nodes).find((n) => n.kind === 'instance' && n.definitionId === banner.id) as InstanceNode;
    const found = unlinkedAt(s, { kind: 'page', id: s.site.homePageId }, placed.id).find((b) => b.label === 'Twice');
    expect(found).toMatchObject({ link: { prop: 'innerLink' } });
    expect(found?.hide).toBeUndefined();
  });

  it('offers Hide only for a label that clears and belongs to that one button', () => {
    const { s, pricing } = withPricing(true);
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const def = s.components[pricing.definitionId];
    const action = def.tree!.nodes['plan-action'] as LinkNode;
    const ids = (pricing.props.plans as Array<{ id: string }>).map((p) => p.id);
    // One link shared by every card, labels per card: each card's Hide is its own, never offered at the shared field.
    def.properties.sharedLink = { type: 'link', label: 'Shared link', default: { type: 'none', target: '' } };
    action.link = { $prop: 'sharedLink' };
    let found = unlinkedAt(s, owner, pricing.id);
    expect(found.map((b) => [b.itemPath, b.link, b.hide])).toEqual(ids.map((id) => [[id], { prop: 'sharedLink' }, { prop: 'plans', itemId: id, field: 'actionLabel' }]));
    expect(hideAt(unlinkedField(found, 'sharedLink'))).toBeUndefined();
    // One label shared by every card: clearing it would hide every card's button, so no Hide.
    action.link = { $item: 'actionLink' };
    def.properties.sharedLabel = { type: 'string', label: 'Shared label', default: 'Enquire' };
    action.label = { $prop: 'sharedLabel' };
    action.when = { $prop: 'sharedLabel' };
    found = unlinkedAt(s, owner, pricing.id);
    expect(found.map((b) => b.label)).toEqual(['Enquire', 'Enquire', 'Enquire']);
    expect(found.every((b) => b.link && !b.hide)).toBe(true);
    expect(hideAt(unlinkedField(found, 'plans', ids[0], 'actionLink'), ids[0])).toBeUndefined();
    // A label that cannot be empty.
    def.properties.sharedLabel = { type: 'enum', label: 'Shared label', default: 'Book', options: [{ value: 'Book', label: 'Book' }, { value: 'Enquire', label: 'Enquire' }] };
    action.label = { $item: 'actionLabel' };
    action.when = { $item: 'actionLabel' };
    expect(unlinkedAt(s, owner, pricing.id).every((b) => b.hide)).toBe(true);
    def.properties.plans = { ...(def.properties.plans as object), fields: { ...(def.properties.plans as { fields: object }).fields, actionLabel: def.properties.sharedLabel } } as never;
    expect(unlinkedAt(s, owner, pricing.id).some((b) => b.hide)).toBe(false);
  });

  it('counts a broken page link and a rejected address as no destination, and a section link as one', () => {
    const { s, pricing } = withPricing(true);
    linkPlan(s, pricing, 0, { type: 'page', target: 'pg_gone' });
    linkPlan(s, pricing, 1, { type: 'url', target: 'javascript:alert(1)' });
    linkPlan(s, pricing, 2, { type: 'anchor', target: 'contact' });
    expect(unlinkedButtons(s, home(s)).map((b) => b.label)).toEqual(['Book a session', 'Start a project', 'Call us today']);
  });
});

describe('fixing a button without a destination', () => {
  it('hides one card’s button, or gives it a page, without touching the other cards', () => {
    const { s: start, pricing } = withPricing(true);
    const owner = { kind: 'page' as const, id: start.site.homePageId };
    const [first, second] = unlinkedAt(start, owner, pricing.id);
    let s = applyOperations(start, [hideButtonOp(owner, pricing.id, first.hide!)]).state;
    expect(unlinkedAt(s, owner, pricing.id).map((b) => b.label)).toEqual(['Start a project', 'Talk to us']);
    const about = pageNamed(s, 'About');
    const to = second.link!;
    s = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId: pricing.id, prop: to.prop, itemId: to.itemId!, field: to.field!, value: { type: 'page', target: about.id } }]).state;
    expect(unlinkedAt(s, owner, pricing.id).map((b) => b.label)).toEqual(['Talk to us']);
    const after = (s.pages[s.site.homePageId].nodes[pricing.id] as InstanceNode).props.plans as Array<Record<string, unknown>>;
    const before = pricing.props.plans as Array<Record<string, unknown>>;
    expect(after.map((p) => p.actionLabel)).toEqual(['', 'Start a project', 'Talk to us']);
    expect(after.map((p) => p.actionLink)).toEqual([before[0].actionLink, { type: 'page', target: about.id }, before[2].actionLink]);
    expect(after.map((p) => [p.id, p.name, p.price])).toEqual(before.map((p) => [p.id, p.name, p.price]));
  });

  it('fixes a card of a placement that still shows the design’s own list', () => {
    const { s: start, pricing } = withPricing(true);
    delete pricing.props.plans;
    const owner = { kind: 'page' as const, id: start.site.homePageId };
    const [first, second] = unlinkedAt(start, owner, pricing.id);
    expect(first.itemPath).toEqual(['item-1']);
    const design = JSON.stringify(start.components[pricing.definitionId].properties.plans);
    let s = applyOperations(start, [hideButtonOp(owner, pricing.id, first.hide!)]).state;
    const to = second.link!;
    s = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId: pricing.id, prop: to.prop, itemId: to.itemId!, field: to.field!, value: { type: 'page', target: pageNamed(s, 'About').id } }]).state;
    expect(unlinkedAt(s, owner, pricing.id).map((b) => b.label)).toEqual(['Talk to us']);
    expect(((s.pages[s.site.homePageId].nodes[pricing.id] as InstanceNode).props.plans as Array<{ id: string }>).map((p) => p.id)).toEqual(['item-1', 'item-2', 'item-3']);
    // The design's own list is untouched.
    expect(JSON.stringify(s.components[pricing.definitionId].properties.plans)).toBe(design);
  });

  it('hides a section’s own button by clearing its label', () => {
    const { s: s0, hero } = withHero();
    const owner = { kind: 'page' as const, id: s0.site.homePageId };
    const s1 = applyOperations(s0, [{ type: 'instance.setProp', owner, nodeId: hero.id, prop: 'secondaryLink', value: { type: 'none', target: '' } }]).state;
    const [found] = unlinkedAt(s1, owner, hero.id);
    const s2 = applyOperations(s1, [hideButtonOp(owner, hero.id, found.hide!)]).state;
    expect(unlinkedAt(s2, owner, hero.id)).toEqual([]);
    expect((s2.pages[s2.site.homePageId].nodes[hero.id] as InstanceNode).props.secondaryLabel).toBe('');
  });
});

describe('reporting buttons without a destination', () => {
  const unlinked = (s: ProjectState) => validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED').map((d) => d.message);

  it('says visitors will not see the button', () => {
    // The Pricing built in the editor (fixtures/unlinked-buttons-designs.ts): the release's is code (the Release gap
    // test below).
    const { s } = withPricing(true);
    expect(unlinked(s)).toEqual(expect.arrayContaining([expect.stringContaining('the “Book a session” button has no link, so visitors won’t see it')]));
  });

  it('says visitors will not see a button of the page’s own beside the shipped theme’s Pricing', () => {
    expect(unlinked(withPricing().s)).toEqual(expect.arrayContaining([expect.stringContaining('the “Call us today” button has no link, so visitors won’t see it')]));
  });

  // Release gap: unlinkedButtons (src/generator/checks.ts) reads managed designs only, so a release button with no link goes unreported.
  it.fails('says visitors will not see a button of the shipped theme’s Pricing', () => {
    expect(unlinked(withPricing().s)).toEqual(expect.arrayContaining([expect.stringContaining('the “Book a visit” button has no link, so visitors won’t see it')]));
  });

  it('warns on export about each button left out, naming where it is', () => {
    expect(unlinkedButtonWarnings(fresh())).toEqual([]);
    const { s, pricing } = withPricing(true);
    expect(unlinkedButtonWarnings(s)).toEqual([
      '4 buttons have no link, so they were left out of the site. Choose where each one goes in the editor, or hide it:',
      'Home · Pricing: “Book a session”',
      'Home · Pricing: “Start a project”',
      'Home · Pricing: “Talk to us”',
      'Home: “Call us today”'
    ]);
    linkPlan(s, pricing, 0, { type: 'page', target: pageNamed(s, 'About').id });
    linkPlan(s, pricing, 1, { type: 'page', target: pageNamed(s, 'About').id });
    linkPlan(s, pricing, 2, { type: 'page', target: pageNamed(s, 'About').id });
    expect(unlinkedButtonWarnings(s)).toEqual(['A button has no link, so it was left out of the site. Choose where it goes in the editor, or hide it:', 'Home: “Call us today”']);
  });

  it('sums up a long list', () => {
    const { s } = withPricing(true);
    for (let i = 0; i < 6; i++) {
      const b: LinkNode = { id: `n_more${i}`, kind: 'link', link: { type: 'none', target: '' }, label: `More ${i}`, appearance: 'secondary' };
      home(s).nodes[b.id] = b;
      home(s).rootIds.push(b.id);
    }
    const w = unlinkedButtonWarnings(s);
    expect(w[0]).toMatch(/^10 buttons/);
    expect(w).toHaveLength(8);
    expect(w[7]).toBe('…and 4 more.');
  });
});

describe('header menu links without a destination (#208)', () => {
  const none = { type: 'none', target: '' };
  const headerOf = (s: ProjectState) => s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
  const about = (s: ProjectState) => ({ type: 'page', target: pageNamed(s, 'About').id });

  it('finds each menu link with words and nowhere to go, but not a heading whose submenu still opens', () => {
    const s = fresh();
    const header = headerOf(s);
    expect(unlinkedMenuLinks(s, s.site.shell.header)).toEqual([]);
    header.props.links = [
      { id: 'svc', label: 'Services', link: none },
      { id: 'dsg', label: 'Design', link: none, sub: true },
      { id: 'abt', label: 'About', link: about(s), sub: true },
      { id: 'soon', label: 'Soon', link: none },
      { id: 'blank', label: '  ', link: none },
      { id: 'gone', label: 'Gone', link: { type: 'page', target: 'pg_missing' } }
    ];
    expect(unlinkedMenuLinks(s, s.site.shell.header)).toEqual([
      { nodeId: header.id, itemId: 'dsg', label: 'Design' },
      { nodeId: header.id, itemId: 'soon', label: 'Soon' },
      { nodeId: header.id, itemId: 'gone', label: 'Gone' }
    ]);
    // A first link marked to go under the one above has none above it: it heads the next one's submenu.
    header.props.links = [
      { id: 'shop', label: 'Shop', link: none, sub: true },
      { id: 'gifts', label: 'Gifts', link: none, sub: true }
    ];
    expect(unlinkedMenuLinks(s, s.site.shell.header)).toEqual([{ nodeId: header.id, itemId: 'gifts', label: 'Gifts' }]);
    // An item saved without its label shows the field's default words.
    header.props.links = [{ id: 'bare', link: none }];
    expect(unlinkedMenuLinks(s, s.site.shell.header)).toEqual([{ nodeId: header.id, itemId: 'bare', label: 'Page' }]);
    // A code component that is not a header is not read as one, whatever its properties are called.
    expect(unlinkedMenuLinks(s, { ...s.site.shell.footer })).toEqual([]);
  });

  it('says so in Project health, on the header', () => {
    const s = fresh();
    headerOf(s).props.links = [{ id: 'i1', label: 'About', link: about(s) }, { id: 'i2', label: 'Soon', link: none }];
    const found = validateState(s).filter((d) => d.code === 'MENU_LINK_UNLINKED');
    expect(found).toEqual([expect.objectContaining({ severity: 'warning', owner: { kind: 'shell', id: 'header' }, nodeId: headerOf(s).id })]);
    expect(found[0].message).toMatch(/the “Soon” menu link has no destination/);
    // It is not a button left out of the site.
    expect(validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED')).toEqual([]);
  });

  it('warns on export about each one, and not when no page shows the header', () => {
    const s = fresh();
    headerOf(s).props.links = [{ id: 'i1', label: 'Soon', link: none }, { id: 'i2', label: 'Later', link: none }];
    expect(unlinkedMenuLinkWarnings(s)).toEqual([
      '2 menu links have no destination, so they go nowhere. Choose where each one goes in the editor, or remove it from the menu:',
      'Header: “Soon”',
      'Header: “Later”'
    ]);
    expect(unlinkedButtonWarnings(s)).toEqual([]);
    headerOf(s).props.links = [{ id: 'i1', label: 'Soon', link: none }];
    const one = ['A menu link has no destination, so it goes nowhere. Choose where it goes in the editor, or remove it from the menu:', 'Header: “Soon”'];
    expect(unlinkedMenuLinkWarnings(s)).toEqual(one);
    // One page showing the header is enough; with none, nothing visitors see goes nowhere.
    const [first, ...rest] = s.site.pageOrder;
    for (const id of rest) s.pages[id].showHeader = false;
    expect(unlinkedMenuLinkWarnings(s)).toEqual(one);
    s.pages[first].showHeader = false;
    expect(unlinkedMenuLinkWarnings(s)).toEqual([]);
    // A collection's index (#397) shows the header too, before anything in it is published, and so does a published entry.
    const drafted = applyOperations(s, [{ type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_soon', title: 'Coming soon' }]).state;
    expect(unlinkedMenuLinkWarnings(drafted)).toEqual(one);
    const published = applyOperations(drafted, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_soon', draft: false }]).state;
    expect(unlinkedMenuLinkWarnings(published)).toEqual(one);
  });

  it('names one menu link once, however often a design repeats the header around it', () => {
    const s = fresh();
    const headerDef = s.components[headerOf(s).definitionId];
    const { banner } = withBanner(s);
    // The banner's design shows a header for each of its two rows.
    banner.properties.rows = { type: 'list', label: 'Rows', itemLabel: 'Row', fields: { label: { type: 'string', label: 'Label', default: '' } }, default: [{ id: 'r1', label: 'One' }, { id: 'r2', label: 'Two' }] } as never;
    const inner = makeInstance(headerDef, { links: [{ id: 'soon', label: 'Soon', link: none }] });
    banner.tree!.nodes[inner.id] = inner;
    banner.tree!.nodes.rows = { id: 'rows', kind: 'repeat', list: { $prop: 'rows' }, children: [inner.id] } as never;
    (banner.tree!.nodes[banner.tree!.rootIds[0]] as { children: string[] }).children.push('rows');
    const placed = Object.values(home(s).nodes).find((n) => n.kind === 'instance' && n.definitionId === banner.id)!;
    const soon = (inner.props.links as Array<{ id: string }>)[0].id;
    expect(unlinkedMenuLinks(s, home(s))).toEqual([{ nodeId: placed.id, itemId: soon, label: 'Soon' }]);
    // Each placement of the banner is its own finding.
    const again = { ...structuredClone(placed), id: 'n_banner_again' };
    home(s).nodes[again.id] = again;
    home(s).rootIds.push(again.id);
    expect(unlinkedMenuLinks(s, home(s)).map((m) => m.nodeId)).toEqual([placed.id, again.id]);
  });
});
