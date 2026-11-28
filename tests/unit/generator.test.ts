import { describe, expect, it, vi } from 'vitest';
import { compile, parse } from 'svelte/compiler';
import type { AssetRecord, ComponentDefinition, GraphNode, InstanceNode, ProjectState, StyleProps } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { validateState } from '@engine/validate';
import { MEDIA_QUERIES, validateStyleValue } from '@shared/styles';
import { applyOperations } from '@engine/apply';
import { GEN_ROOT, RUNTIME_DIR, STYLES_DIR, defFile, generateManagedComponent, generateProject, js, packFileCopies, propLocals, publishedState, resolveLink } from '@generator/index';
import { catalogueEntries, getTheme } from '@catalogue/index';
import { externalLink } from '@shared/links';
import { GenerationCache } from '@generator/cache';
import { DRAFT_NOTE_CSS, DRAFTS_JS, usedIcons } from '@generator/runtime-files';
import { checkSvelteSource } from '../../src/main/codecheck';
import { pageIds, pageSections, placeholderImageCount, planSectionPick, sharedPageIds } from '@generator/checks';
import { withPublished } from '@shared/published';
import { P, prop } from '@catalogue/dsl';
import { FOUNDATION_AUTHOR, projectDesign, type DesignSpec } from './fixtures/packs';
import { SECTION } from './fixtures/insert-at-designs';
import { BANNER, DETAILS, FAQ, FOOTER, HERO_SPLIT, INTRO, LOGOS } from './fixtures/generator-designs';
import { pricingDesign } from './fixtures/unlinked-buttons-designs';
import { FEATURES } from './fixtures/wrap-designs';

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const instanceOf = (s: ProjectState, componentId: string, pageId = s.site.homePageId) => {
  const p = s.pages[pageId];
  return Object.values(p.nodes).find((n) => n.kind === 'instance' && s.components[n.definitionId]?.componentId === componentId) as InstanceNode;
};
const defOf = (s: ProjectState, componentId: string) => Object.values(s.components).find((d) => d.componentId === componentId)!;
const addToHome = (s: ProjectState, componentId: string, props: Record<string, unknown> = {}) => {
  const id = installComponent(s, componentId);
  const node = makeInstance(s.components[id], props);
  home(s).nodes[node.id] = node;
  home(s).rootIds.push(node.id);
  return node;
};

/** A copy of a design's spec whose schemas a test may change: a definition holds its spec's own objects. */
const own = (spec: DesignSpec): DesignSpec => ({
  ...spec,
  properties: structuredClone(spec.properties),
  parts: structuredClone(spec.parts),
  ...(spec.variantAxes ? { variantAxes: structuredClone(spec.variantAxes) } : {}),
  ...(spec.slots ? { slots: structuredClone(spec.slots) } : {})
});

/**
 * A placement of a design of the project's own (added the first time), on a page (Home unless named), first or at
 * `index`, or else last. Foundation's sections are code components, so what the generator writes for a design built
 * in the editor is tried on these.
 */
function placeDesign(s: ProjectState, spec: DesignSpec, opts: { index?: number; pageId?: string; props?: Record<string, unknown> } = {}): InstanceNode {
  const def = s.components[FOUNDATION_AUTHOR.definitionId(spec.componentId)] ?? projectDesign(s, own(spec));
  const node = makeInstance(def, opts.props ?? {}) as InstanceNode;
  const page = s.pages[opts.pageId ?? s.site.homePageId];
  page.nodes[node.id] = node;
  if (opts.index === undefined) page.rootIds.push(node.id);
  else page.rootIds.splice(opts.index, 0, node.id);
  return node;
}

/**
 * The Contact page made of designs of the project's own, worded as the starter words it: its introduction, contact
 * details and questions. Foundation's sections are code components, which take no anchor (see the Release gap tests).
 */
function managedContact(s: ProjectState) {
  const contact = s.site.pageOrder.map((id) => s.pages[id]).find((p) => p.route === '/contact/')!;
  contact.nodes = {};
  contact.rootIds = [];
  const intro = placeDesign(s, INTRO, { pageId: contact.id, props: { eyebrow: 'Contact', heading: 'Let’s talk' } });
  const details = placeDesign(s, DETAILS, { pageId: contact.id, props: { eyebrow: '', heading: 'Get in touch' } });
  const faq = placeDesign(s, FAQ, { pageId: contact.id, props: { heading: 'Frequently asked questions' } });
  return { contact, intro, details, faq };
}

function compileAll(files: Map<string, string>) {
  const errors: string[] = [];
  for (const [path, source] of files) {
    if (!path.endsWith('.svelte')) continue;
    for (const generate of ['server', 'client'] as const) {
      try {
        compile(source, { filename: path, generate, runes: true });
      } catch (e) {
        errors.push(`${path} (${generate}): ${(e as Error).message}`);
      }
    }
  }
  return errors;
}

describe('generated Svelte compiles', () => {
  it('compiles every file of both starters, including the contact form, the data table and site search', () => {
    const s = fresh();
    addToHome(s, 'contact.form');
    addToHome(s, 'data.table', { rowHeaders: true });
    addToHome(s, 'site.search');
    expect(compileAll(generateProject(s))).toEqual([]);
    expect(compileAll(generateProject(s, { instrument: true }))).toEqual([]);
    expect(compileAll(generateProject(createStarterState('blank', 'Blank', false)))).toEqual([]);
    expect(compileAll(generateProject(createStarterState('blank', 'Blank', false), { instrument: true }))).toEqual([]);
  });

  // Every section and block of a second theme, compiled: seconds of work, more under a busy machine.
  it('compiles and validates a site on another theme with every section, and exports it unchanged after a trip to Foundation (#390)', { timeout: 30_000 }, () => {
    const s = createStarterState('business', 'Magazine', false, 'foundation-alt');
    const entries = catalogueEntries('foundation-alt');
    expect(entries.length).toBeGreaterThan(25);
    for (const e of entries) if (!instanceOf(s, e.componentId)) addToHome(s, e.componentId);
    const placed = [...Object.values(s.pages), s.site.shell.header, s.site.shell.footer].flatMap((t) => Object.values(t.nodes)).filter((n): n is InstanceNode => n.kind === 'instance');
    expect(new Set(placed.map((n) => s.components[n.definitionId].componentId))).toEqual(new Set([...entries.map((e) => e.componentId), 'shell.header', 'shell.footer']));
    for (const n of placed) expect(n.definitionId).toMatch(/^foundation-alt\./);
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    const files = generateProject(s);
    expect(compileAll(files)).toEqual([]);
    expect(compileAll(generateProject(s, { instrument: true }))).toEqual([]);
    expect(files.get(`${STYLES_DIR}/theme.css`)).toContain('Foundation theme base styles');
    // Its fonts travel with the site as files from the pack, so it needs no network.
    const fonts = packFileCopies(s);
    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) expect([f.pack, /^fonts\//.test(f.file)], f.file).toEqual(['foundation-alt', true]);
    // To Foundation and back: the same site, file for file.
    const onFoundation = applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation' }]).state;
    expect(compileAll(generateProject(onFoundation))).toEqual([]);
    expect(generateProject(onFoundation).get(`${STYLES_DIR}/theme.css`)).toContain('Foundation theme base styles');
    expect(generateProject(applyOperations(onFoundation, [{ type: 'theme.apply', themeId: 'foundation-alt' }]).state)).toEqual(files);
  });
});

describe('the blank starter (#15)', () => {
  it('publishes nothing the author did not write: no editing directions, placeholder tagline or sample contact details', () => {
    const s = createStarterState('blank', 'Kloof', false);
    const home = s.pages[s.site.homePageId];
    expect(home.rootIds).toEqual([]);
    // The one thing to say of it: its Home page has nothing on it yet (#1550).
    expect(validateState(s).map((d) => [d.severity, d.code, d.owner])).toEqual([['warning', 'PAGE_EMPTY', { kind: 'page', id: home.id }]]);
    const files = generateProject(s);
    // What visitors get: the pages and the shared layout (a component's own file may name its defaults).
    const shown = [...files].filter(([path]) => path.startsWith('src/routes/')).map(([, src]) => src).join('\n');
    for (const leftover of ['Select this text', 'Insert panel', 'A short sentence', 'example.com', '555', 'Harbor Lane']) expect(shown).not.toContain(leftover);
    // The footer keeps what is true of any site: its name, the Home link and the copyright.
    const footer = s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode;
    expect(footer.props).toMatchObject({ siteName: 'Kloof', tagline: '', contact: [] });
    // The footer still renders, with what is true of any site: the copyright and the Home link.
    const layout = files.get('src/routes/+layout.svelte')!;
    const footerTag = /<C_foundation_shell_footer_\w+[^]*?\/>/.exec(layout)?.[0] ?? '';
    expect(footerTag).toContain('copyright={"© " + new globalThis.Date().getFullYear() + " Kloof."}');
    expect(footerTag).toMatch(/links=\{\[\{[^}]*"label":"Home","link":\{"href":"\/"\}\}\]\}/);
    expect(footerTag).toContain('contact={[]}');
  });
});

describe('the starters’ copyright year (#828)', () => {
  /** The footer's copyright as the generated layout passes it, worked out as a visitor's browser would in `year`. */
  const shownIn = (s: ProjectState, year: number, instrument = false) => {
    const layout = generateProject(s, instrument ? { instrument: true } : {}).get('src/routes/+layout.svelte')!;
    const expr = /<C_foundation_shell_footer_\w+[^]*?\scopyright=\{([^\n]*?)\}\s/.exec(layout)?.[1];
    expect(expr).toBeDefined();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(year, 6, 1));
      return new Function(`return (${expr});`)() as string;
    } finally {
      vi.useRealTimers();
    }
  };

  for (const [starter, line] of [['business', '© {year} Kloof. All rights reserved.'], ['blank', '© {year} Kloof.']] as const)
    it(`keeps the ${starter} starter's footer on the year the site is built in, not the year it was made`, () => {
      const s = createStarterState(starter, 'Kloof', false);
      const footer = s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode;
      expect(footer.props.copyright).toBe(line);
      // The same project, built in later years, says each of them, in the export and in the editor's preview.
      for (const year of [2031, 2032]) for (const instrument of [false, true]) expect(shownIn(s, year, instrument)).toBe(line.replace('{year}', String(year)));
    });

  it('reads only a {year} in the year position, and leaves a fixed year and every other brace as written', () => {
    const s = createStarterState('blank', 'Studio {year}', false);
    const footer = s.site.shell.footer.nodes[s.site.shell.footer.rootIds[0]] as InstanceNode;
    expect(shownIn(s, 2031)).toBe('© 2031 Studio {year}.');
    footer.props.copyright = '© 2019–{year} Studio.';
    expect(shownIn(s, 2031)).toBe('© 2019–2031 Studio.');
    footer.props.copyright = '© 2026 Studio.';
    expect(shownIn(s, 2031)).toBe('© 2026 Studio.');
    footer.props.copyright = 'Made in {year}. </script>';
    expect(shownIn(s, 2031)).toBe('Made in {year}. </script>');
  });

  it('says the About page’s team is as many people as its Team section shows', () => {
    const s = createStarterState('business', 'Kloof', false);
    const about = Object.values(s.pages).find((p) => p.route === '/about/')!;
    const sections = about.rootIds.map((id) => about.nodes[id] as InstanceNode);
    const def = (n: InstanceNode) => s.components[n.definitionId].componentId;
    const story = JSON.stringify(sections.find((n) => def(n) === 'content.media')!.props.body);
    const people = sections.find((n) => def(n) === 'team.grid')!.props.people as unknown[];
    expect(people).toHaveLength(3);
    expect(story).toContain('a team of three');
  });
});

describe('unsent form drafts (issue #274)', () => {
  /** Every element in a Svelte source, with the names of its attributes. */
  const elements = (source: string) => {
    const found: Array<{ name: string; attributes: string[] }> = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const n = node as { type?: string; name?: string; attributes?: Array<{ type: string; name?: string }> };
      if (n.type === 'RegularElement') found.push({ name: n.name!, attributes: (n.attributes ?? []).filter((a) => a.type === 'Attribute').map((a) => a.name!) });
      for (const [key, value] of Object.entries(node)) if (key !== 'metadata' && key !== 'parent') walk(value);
    };
    walk(parse(source, { modern: true }).fragment);
    return found;
  };

  it('ships the draft keeper with every site and runs it once from the root layout, in the export and the preview', () => {
    for (const files of [generateProject(fresh()), generateProject(fresh(), { instrument: true }), generateProject(createStarterState('blank', 'Blank', false))]) {
      expect(files.get(`${RUNTIME_DIR}/drafts.js`)).toBe(DRAFTS_JS);
      // A statement of the layout's own script, so it runs whenever the layout does.
      const body = (parse(files.get('src/routes/+layout.svelte')!, { modern: true }).instance?.content.body ?? []) as unknown as Array<{
        type: string;
        source?: { value: string };
        specifiers?: Array<{ imported?: { name: string }; local: { name: string } }>;
        expression?: { type: string; callee?: { type: string; name?: string }; arguments?: unknown[] };
      }>;
      expect(body.filter((n) => n.type === 'ImportDeclaration' && n.source?.value === '../lib/siteorigin/runtime/drafts.js').map((n) => n.specifiers?.map((sp) => [sp.imported?.name, sp.local.name]))).toEqual([[['keepDrafts', 'keepDrafts']]]);
      const calls = body.filter((n) => n.type === 'ExpressionStatement' && n.expression?.type === 'CallExpression' && n.expression.callee?.type === 'Identifier' && n.expression.callee.name === 'keepDrafts');
      // With the wording of the page, which its note after a form it gave a message back to is in.
      expect(calls.map((n) => n.expression?.arguments)).toEqual([[expect.objectContaining({ type: 'Identifier', name: 'text' })]]);
      expect(files.get(`${STYLES_DIR}/site.css`)).toContain(DRAFT_NOTE_CSS);
    }
    // Plain SvelteKit: no editor instrumentation, and nothing imported but Svelte and SvelteKit.
    expect(DRAFTS_JS).not.toMatch(/data-so-|__so|siteorigin-bridge/);
    expect([...DRAFTS_JS.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1])).toEqual(['svelte', '$app/navigation', '$app/state']);
  });

  it('marks the theme contact form and each answer for it, and keeps the form a component a customised copy can save', async () => {
    const source = getTheme('foundation').components.find((d) => d.componentId === 'contact.form')!.source!;
    const all = elements(source);
    expect(all.filter((e) => e.attributes.includes('data-keep-draft')).map((e) => e.name)).toEqual(['form']);
    // Every visible answer, and nothing else: not the provider's hidden fields or the spam trap. In the order the code
    // writes them: long text, the other text fields, a single-choice question's radio buttons and a checkbox (issue #238).
    expect(all.filter((e) => e.attributes.includes('data-draft-field')).map((e) => e.name)).toEqual(['textarea', 'input', 'input', 'input']);
    expect(all.filter((e) => e.attributes.includes('data-draft-field')).every((e) => e.attributes.includes('required') && e.attributes.includes('oninput'))).toBe(true);
    // Forking or duplicating the form makes it a project component, whose code must pass the ordinary check.
    expect((await checkSvelteSource(source)).filter((p) => p.severity === 'error')).toEqual([]);
  });
});

describe('escaping and identifiers', () => {
  it('escapes "<" so text can never close a <script> element', () => {
    expect(js('</script><script>alert(1)</script>')).not.toContain('<');
    const s = fresh();
    const def = projectDesign(s, own(HERO_SPLIT));
    (def.properties.heading as { default: string }).default = 'Hi </script><script>alert(1)</script>';
    const out = generateManagedComponent(s, def, {});
    expect(out.match(/<\/script/g)).toHaveLength(1);
  });

  it('renames properties that are reserved words or collide with generated names', () => {
    const s = fresh();
    placeDesign(s, HERO_SPLIT);
    const def = defOf(s, 'project.hero-split');
    for (const name of ['default', 'class', 'variant', 'has', 'so_o', 'item', 'new']) def.properties[name] = { type: 'string', label: name, default: name };
    def.tree!.nodes['heading'] = { ...def.tree!.nodes['heading'], kind: 'text', tag: 'h1', text: { $prop: 'default' } } as never;
    const locals = propLocals(def);
    expect(new Set(locals.values()).size).toBe(locals.size);
    for (const local of locals.values()) expect(['default', 'class', 'variant', 'has', 'so_o', 'item', 'new']).not.toContain(local);
    const files = generateProject(s);
    expect(compileAll(files)).toEqual([]);
    const component = files.get(defFile(def))!;
    expect(component).toContain('default: prop_default = "default"');
    expect(component).toContain('prop_class = "class"');
    expect(component).toMatch(/<h1 [^>]*>\{prop_default\}<\/h1>/);
    expect(files.get('src/routes/+page.svelte')).toContain('prop_class={"class"}');
  });

  it('keeps renamed keys unique and ignores inherited object properties', () => {
    const s = fresh();
    placeDesign(s, HERO_SPLIT);
    const def = defOf(s, 'project.hero-split');
    def.properties['class'] = { type: 'string', label: 'a', default: 'a' };
    def.properties['prop_class'] = { type: 'string', label: 'b', default: 'b' };
    def.properties['constructor'] = { type: 'string', label: 'c', default: 'c' };
    def.properties['$title'] = { type: 'string', label: 'd', default: 'd' };
    const files = generateProject(s);
    expect(compileAll(files)).toEqual([]);
    const page = files.get('src/routes/+page.svelte')!;
    expect(page).toContain('prop_prop_class={"a"}');
    expect(page).toContain('prop_class={"b"}');
    expect(page).toContain('constructor={"c"}');
  });
});

describe('style and token validation', () => {
  it('rejects CSS comments and url() in literal style values', () => {
    expect(validateStyleValue('border', '1px solid red /* x')).toMatch(/Invalid/);
    expect(validateStyleValue('shadow', '0 0 1px red */')).toMatch(/Invalid/);
    expect(validateStyleValue('border', '1px solid url(https://example.com/x.png)')).toMatch(/Invalid/);
    expect(validateStyleValue('width', 'calc(1px /* x */)')).toMatch(/Invalid/);
    expect(validateStyleValue('border', '1px solid red')).toBeNull();
  });

  it('rejects comment injection in token values', () => {
    const s = fresh();
    expect(() => applyOperations(s, [{ type: 'token.set', tokenId: 'space.md', value: '16px /* ' }])).toThrow();
    expect(() => applyOperations(s, [{ type: 'token.set', tokenId: 'text.body', value: { size: '1rem /*' } }])).toThrow();
  });

  it('never writes an unsafe declaration even from a hand-edited document', () => {
    const s = fresh();
    s.tokens.overrides['space.md'] = '16px; } body { display: none';
    const hero = instanceOf(s, 'hero.split');
    hero.overrides = { root: { base: { background: 'url(https://evil.example/x.png)' } } };
    const files = generateProject(s);
    expect(files.get(`${STYLES_DIR}/tokens.css`)).not.toContain('display: none');
    expect(files.get(`${STYLES_DIR}/site.css`)).not.toContain('evil.example');
  });
});

describe('responsive overrides', () => {
  it('applies a multi-column override for all sizes from tablet up, keeping the phone layout', () => {
    const s = fresh();
    const grid = instanceOf(s, 'features.grid');
    grid.overrides = { grid: { base: { columns: 4, gap: '40px' } } };
    const css = generateProject(s).get(`${STYLES_DIR}/site.css`)!;
    const wide = css.slice(css.indexOf('@media (min-width: 768px)'));
    expect(wide).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))');
    expect(css.slice(0, css.indexOf('@media'))).toContain('gap: 40px');
    expect(css.slice(0, css.indexOf('@media'))).not.toContain('repeat(4');
  });

  it('keeps an explicit phone column count alongside an all-sizes value', () => {
    const s = fresh();
    const grid = instanceOf(s, 'features.grid');
    grid.overrides = { grid: { base: { columns: 4 }, phone: { columns: 2 } } };
    const css = generateProject(s).get(`${STYLES_DIR}/site.css`)!;
    const cls = `so-o-${grid.id}-grid`;
    const block = (query: string) => {
      const start = css.indexOf(`@media ${query} {`);
      return css.slice(start, css.indexOf('\n}', start));
    };
    // The grid's part of the theme's code, whose own scoped rules these outrank.
    expect(block('(min-width: 768px)')).toContain(`.${cls}.${cls}.${cls} {\n\t\tgrid-template-columns: repeat(4, minmax(0, 1fr)) !important;`);
    expect(block('(max-width: 767.98px)')).toContain(`.${cls}.${cls}.${cls} {\n\t\tgrid-template-columns: repeat(2, minmax(0, 1fr)) !important;`);
  });

  /** The shared footer placing a managed footer of the theme's in place of the code one. */
  function managedFooter(s: ProjectState) {
    const def = FOUNDATION_AUTHOR.managed({ category: 'shell', tags: [], icon: 'square', description: '', ...FOOTER });
    s.components[def.id] = def;
    const footer = Object.values(s.site.shell.footer.nodes)[0] as InstanceNode;
    footer.definitionId = def.id;
    footer.props = {};
    return { def, footer };
  }

  it('shows a part again when an instance un-hides what the definition hides', () => {
    const s = fresh();
    const { def, footer } = managedFooter(s);
    def.tree!.nodes['brand-name'].styles = { base: { ...def.tree!.nodes['brand-name'].styles?.base, hidden: true } };
    footer.overrides = { brand: { base: { hidden: false } } };
    const css = generateProject(s).get(`${STYLES_DIR}/site.css`)!;
    expect(css).toMatch(/so-o-[^{]+-brand[^{]*\{[^}]*display: revert/);
  });

  it('keeps a part shown again after the placement is converted to code (#103)', async () => {
    const s = fresh();
    const { def, footer } = managedFooter(s);
    def.tree!.nodes['brand-name'].styles = { base: { ...def.tree!.nodes['brand-name'].styles?.base, hidden: true } };
    def.tree!.nodes.tagline.styles = { ...def.tree!.nodes.tagline.styles, phone: { ...def.tree!.nodes.tagline.styles?.phone, hidden: true } };
    footer.overrides = { brand: { base: { hidden: false } } };
    const r = applyOperations(s, [{ type: 'component.convertToCode', owner: { kind: 'shell', id: 'footer' }, nodeId: footer.id }]);
    const code = r.state.components[r.results[0].definitionId as string];
    const source = code.source!;
    const cls = (node: string) => `so-${code.id.replace(/[^a-zA-Z0-9]/g, '-')}__${node}`;
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mark = `so-shown--${code.id.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const gated = (node: string, size: 'phone' | 'tablet' | 'desktop') => `:global(.${cls(node)}:not(:where(.${mark}, .${mark}-${size}))) {`;
    // The design's hides stay in the code, each written for an element not marked shown at that size, and in no
    // other form: the node's own rule no longer hides it outright.
    const own = source.match(new RegExp(`:global\\(\\.${esc(cls('brand-name'))}\\) \\{[^}]*\\}`))![0];
    expect(own).not.toContain('display: none');
    for (const size of ['phone', 'tablet', 'desktop'] as const) {
      expect(source).toMatch(new RegExp(`@media ${esc(MEDIA_QUERIES[size])} \\{\\s*${esc(gated('brand-name', size))}\\s*display: none;`));
      // A hide at one size is gated at that size only.
      expect(source.includes(gated('tagline', size))).toBe(size === 'phone');
    }
    // Nothing writes a display of its own to show it: the element keeps whatever its other rules give it.
    expect(source).not.toMatch(/so-shown[^{]*\{\s*display: (?!none)/);
    expect(source).not.toMatch(/\.so-shown[,)]/);
    expect(() => compile(source, { filename: code.sourcePath, generate: 'server', runes: true })).not.toThrow();
    expect((await checkSvelteSource(source, { filename: code.sourcePath })).filter((p) => p.severity === 'error')).toEqual([]);
    // The placement marks it shown at every size, through the same hook its other part styles use.
    const placed = (st: ProjectState) => [...generateProject(st).values()].join('\n');
    expect(placed(r.state)).toContain(`-brand ${mark}"`);
    // Shown on phones only, it marks that size; with the override gone it marks nothing and stays hidden.
    const phone = structuredClone(r.state);
    (Object.values(phone.site.shell.footer.nodes)[0] as InstanceNode).overrides = { brand: { phone: { hidden: false } } };
    expect(placed(phone)).toContain(`-brand ${mark}-phone"`);
    const plain = structuredClone(r.state);
    delete (Object.values(plain.site.shell.footer.nodes)[0] as InstanceNode).overrides;
    expect(placed(plain)).not.toMatch(/"brand":"[^"]*so-shown/);
    // The site's own component stylesheet is unchanged: hides there stay plain.
    expect(generateProject(s).get(`${STYLES_DIR}/components.css`)).not.toContain('so-shown');
    // Code that does not gate its hides keeps one class per part, whatever its placement asks.
    const handwritten = structuredClone(r.state);
    handwritten.components[code.id].source = source.replaceAll(mark, 'so-other');
    expect(placed(handwritten)).toMatch(/"brand":"so-o-[\w-]+-brand"/);
  });

  it('drives button colours through --so-btn-bg / --so-btn-fg so hover follows them', () => {
    const s = fresh();
    const hero = placeDesign(s, HERO_SPLIT);
    hero.variants = { tone: 'brand' };
    const files = generateProject(s);
    const components = files.get(`${STYLES_DIR}/components.css`)!;
    const rule = components.match(/\.so-foundation-project-hero-split--tone-brand\.so-foundation-project-hero-split__primary \{[^}]*\}/)![0];
    expect(rule).toContain('--so-btn-bg: var(--so-color-on-brand)');
    expect(rule).toContain('--so-btn-bg-hover: initial');
    expect(rule).toContain('--so-btn-fg: var(--so-color-brand-strong)');
    // A direct background would beat the hover rule whenever the styling rule is more specific.
    expect(rule).not.toMatch(/(^|\s)background:/);
    const theme = files.get(`${STYLES_DIR}/theme.css`)!;
    expect(theme).toContain('--so-btn-bg-hover: var(--so-surface-ink-hover, var(--so-color-brand-strong))');
    expect(theme).toContain(':is(a, button).so-btn--primary:hover { background: var(--so-btn-bg-hover, color-mix(in srgb, var(--so-btn-bg) 84%, #000)); }');
  });

  it('keeps an explicit hide in one range when another range shows the part', () => {
    const s = fresh();
    const grid = instanceOf(s, 'features.grid');
    grid.overrides = { heading: { phone: { hidden: false }, tablet: { hidden: true } } };
    const css = generateProject(s).get(`${STYLES_DIR}/site.css`)!;
    expect(css.slice(css.indexOf(`@media (min-width: 768px) and (max-width: 1023.98px)`))).toContain('display: none');
  });
});

describe('links and buttons', () => {
  it('leaves unlinked buttons out of the site, with one class list per element, and flags them only in the editor', () => {
    const link = generateProject(fresh()).get(`${RUNTIME_DIR}/Link.svelte`)!;
    expect(link).not.toContain('so-btn--static');
    expect(link).not.toContain('data-so-unlinked');
    // The declaration, and one class list on each element it can render (link, button, text, card link, card).
    expect(link.match(/className/g)!.length).toBe(6);
    expect(link).toContain("import { resolve } from '$app/paths'");
    expect(generateProject(fresh()).get(`${STYLES_DIR}/theme.css`)).not.toContain('so-btn--static');
    const dev = generateProject(fresh(), { instrument: true }).get(`${RUNTIME_DIR}/Link.svelte`)!;
    expect(dev).toContain('data-so-unlinked');
    expect(dev.match(/className/g)!.length).toBe(7);
  });

  it('reports a labelled button without a link', () => {
    const s = fresh();
    expect(validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED')).toEqual([]);
    const hero = placeDesign(s, HERO_SPLIT);
    expect(validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED')).toEqual([]);
    hero.props.primaryLink = { type: 'none', target: '' };
    const found = validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('Start a project');
    expect(found[0].message).toContain('visitors won’t see it');
    // A pricing design whose three plans have nowhere to go.
    const pricing = makeInstance(pricingDesign(s), {});
    home(s).nodes[pricing.id] = pricing;
    home(s).rootIds.push(pricing.id);
    expect(validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED')).toHaveLength(4);
  });

  // Release gap: unlinkedButtons (src/generator/checks.ts) reads managed designs only, so a release button with no link goes unreported.
  it.fails('reports a labelled button of the release without a link', () => {
    const s = fresh();
    instanceOf(s, 'hero.split').props.primaryLink = { type: 'none', target: '' };
    const found = validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('Start a project');
  });

  it('survives a malformed component tree without crashing validation', () => {
    const s = fresh();
    placeDesign(s, HERO_SPLIT);
    const def = defOf(s, 'project.hero-split');
    const content = def.tree!.nodes['content'] as { children: string[] };
    content.children.push('grid');
    expect(() => validateState(s)).not.toThrow();
  });

  // Release gap: placeholderImageCount counts image nodes only, so it sees none of the release's placeholder images.
  it.fails('counts only images that render as placeholders', () => {
    // Logo strip items without a logo show a wordmark, and testimonial and team portraits are optional: none count.
    expect(placeholderImageCount(fresh())).toBe(6);
    const s = fresh();
    s.assets.assets['a1'] = { id: 'a1', name: 'Hero', file: 'static/assets/hero.jpg', mime: 'image/jpeg', bytes: 1, width: 10, height: 10, hash: 'x', kind: 'image', createdAt: '' };
    instanceOf(s, 'hero.split').props.image = { assetId: 'a1', alt: 'Hero' };
    expect(placeholderImageCount(s)).toBe(5);
  });

  it('counts a design’s image as a placeholder until it has a picture', () => {
    const s = fresh();
    const before = placeholderImageCount(s);
    const hero = placeDesign(s, HERO_SPLIT);
    expect(placeholderImageCount(s)).toBe(before + 1);
    s.assets.assets['a1'] = { id: 'a1', name: 'Hero', file: 'static/assets/hero.jpg', mime: 'image/jpeg', bytes: 1, width: 10, height: 10, hash: 'x', kind: 'image', createdAt: '' };
    hero.props.image = { assetId: 'a1', alt: 'Hero' };
    expect(placeholderImageCount(s)).toBe(before);
  });

  it('counts placeholder images inside components placed in a design and in its slots', () => {
    const s = fresh();
    // A banner of the project's own on Home and About, with no picture of its own.
    placeDesign(s, BANNER);
    placeDesign(s, BANNER, { pageId: s.site.pageOrder[1] });
    const before = placeholderImageCount(s);
    const banner = defOf(s, 'project.cta-banner');
    const placements = s.site.pageOrder.flatMap((id) => Object.values(s.pages[id].nodes)).filter((n) => n.kind === 'instance' && n.definitionId === banner.id).length;
    expect(placements).toBe(2);
    const root = banner.tree!.nodes[banner.tree!.rootIds[0]] as { children: string[] };
    // A hero inside the banner's design shows its placeholder wherever the banner is placed.
    const heroDef = projectDesign(s, own(HERO_SPLIT));
    const hero = makeInstance(heroDef, {});
    banner.tree!.nodes[hero.id] = hero;
    root.children.push(hero.id);
    expect(placeholderImageCount(s)).toBe(before + placements);
    // So does a hero in the slot of a section inside the design; a slot nothing fills adds nothing.
    const section = projectDesign(s, own(SECTION));
    const slot = (Object.values(section.tree!.nodes).find((n) => n.kind === 'slot') as { slot: string }).slot;
    const slotted = makeInstance(heroDef, {});
    const holder = makeInstance(section, {});
    holder.slots = { [slot]: [slotted.id] };
    const empty = makeInstance(section, {});
    for (const n of [slotted, holder, empty]) banner.tree!.nodes[n.id] = n;
    root.children.push(holder.id, empty.id);
    expect(placeholderImageCount(s)).toBe(before + 2 * placements);
  });

  it('labels the footer’s navigation region by its heading', () => {
    const files = generateProject(fresh());
    const footer = [...files.entries()].find(([p]) => p.endsWith('shell-footer.svelte'))![1];
    // A cleared heading is not rendered, so the landmark falls back to the heading's default name.
    expect(footer).toMatch(/<nav [^>]*aria-label=\{has\(linksHeading\) \? linksHeading : 'Explore'\}>/);
  });
});

describe('email links', () => {
  const href = (target: string) => resolveLink({ type: 'email', target }, { state: fresh() })!.href;

  it('writes valid mailto: URLs that the preview link check accepts', () => {
    expect(href('hello@example.com')).toBe('mailto:hello@example.com');
    expect(href('first.last+news@example.com')).toBe('mailto:first.last+news@example.com');
    expect(href('100%off@example.com')).toBe('mailto:100%25off@example.com');
    expect(externalLink(href('100%off@example.com'))).toMatchObject({ kind: 'email', target: '100%off@example.com' });
    expect(externalLink(href('a@example.com,b@example.com'))).toMatchObject({ kind: 'email', target: 'a@example.com, b@example.com' });
  });

  it('keeps a subject, escaping only what is unsafe', () => {
    expect(href('hi@example.com?subject=50% off today')).toBe('mailto:hi@example.com?subject=50%25%20off%20today');
    expect(href('hi@example.com?subject=Hello%20there')).toBe('mailto:hi@example.com?subject=Hello%20there');
    expect(externalLink(href('hi@example.com?subject=50% off #1'))).toMatchObject({ kind: 'email' });
  });

  it('cannot smuggle extra recipients or a fragment through the address', () => {
    expect(href('a#b@example.com')).toBe('mailto:a%23b@example.com');
  });
});

describe('SEO and performance', () => {
  it('keeps noindex pages crawlable but out of the sitemap', () => {
    const s = fresh();
    s.site.baseUrl = 'https://example.com';
    const about = s.site.pageOrder[1];
    s.pages[about].seo.noindex = true;
    const files = generateProject(s);
    expect(files.get('static/robots.txt')).not.toContain('Disallow');
    expect(files.get('static/sitemap.xml')).not.toContain('/about/');
    expect(files.get('src/routes/about/+page.svelte')).toContain('content="noindex"');
  });

  it('writes social tags, a default favicon and website structured data', () => {
    const s = fresh();
    let page = generateProject(s).get('src/routes/+page.svelte')!;
    expect(page).toContain('og:type');
    expect(page).toContain('twitter:card" content="summary"');
    expect(page).not.toContain('ld+json');
    s.site.baseUrl = 'https://example.com';
    s.assets.assets['a1'] = { id: 'a1', name: 'Social', file: 'static/assets/social.jpg', mime: 'image/jpeg', bytes: 1, width: 1200, height: 630, hash: 'x', kind: 'image', altSuggestion: 'Our studio', createdAt: '' };
    s.site.socialImage = 'a1';
    const files = generateProject(s);
    page = files.get('src/routes/+page.svelte')!;
    expect(page).toContain('summary_large_image');
    expect(page).toContain('og:image:width" content="1200"');
    expect(page).toContain('og:image:alt');
    expect(page).toContain('application/ld+json');
    expect(page).not.toContain('<script type');
    expect(files.get('static/favicon.svg')).toMatch(/^<svg[^]*>T<\/text>/);
    expect(files.get('src/routes/+layout.svelte')).toContain('href={asset("favicon.svg")}');
  });

  it('derives the base path from the public URL', () => {
    const s = fresh();
    expect(JSON.parse(generateProject(s).get(`${GEN_ROOT}/paths.json`)!)).toEqual({ base: '' });
    s.site.baseUrl = 'https://me.github.io/my-site/';
    expect(JSON.parse(generateProject(s).get(`${GEN_ROOT}/paths.json`)!)).toEqual({ base: '/my-site' });
  });

  it('loads the first section eagerly and gives images realistic sizes', () => {
    const files = generateProject(fresh());
    const page = files.get('src/routes/+page.svelte')!;
    expect(page.match(/so_eager=\{true\}/g)).toHaveLength(1);
    const hero = [...files.entries()].find(([p]) => p.endsWith('hero-split.svelte'))![1];
    expect(hero).toContain('eager={so_eager}');
    const gallery = [...files.entries()].find(([p]) => p.endsWith('media-gallery.svelte'))![1];
    expect(gallery).not.toContain('eager');
    expect(gallery).toContain('sizes="(min-width: 1024px) 400px, (min-width: 768px) 50vw, 100vw"');
    expect(files.get(`${RUNTIME_DIR}/Image.svelte`)).toContain("fetchpriority={eager ? 'high' : undefined}");
  });

  // Release gap: the release's hero.split and testimonials portraits give their images no sizes.
  it.fails('gives the hero’s picture and the testimonial portraits realistic sizes', () => {
    const files = generateProject(fresh());
    const hero = [...files.entries()].find(([p]) => p.endsWith('hero-split.svelte'))![1];
    expect(hero).toMatch(/\bsizes="[^"]+"/);
    const testimonials = [...files.entries()].find(([p]) => p.endsWith('testimonials-grid.svelte'))![1];
    expect(testimonials).toMatch(/\bsizes="[^"]+"/);
  });

  /**
   * A Section on the home page holding a Grid of three photos, built the way the editor builds it (issue #170). The
   * Section is of a managed design, whose Container the generator reads the content width from.
   */
  function manualGrid(s: ProjectState) {
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const photo: AssetRecord = { id: 'a_photo', name: 'Photo', file: 'static/assets/photo-1a2b3c4d.jpg', mime: 'image/jpeg', bytes: 10, width: 2400, height: 1600, hash: 'h', kind: 'image', createdAt: 'now', variants: [160, 480, 960, 1440].map((w) => ({ width: w, file: `static/assets/photo-1a2b3c4d-${w}w.jpg` })) };
    const sectionDef = s.components[FOUNDATION_AUTHOR.definitionId(SECTION.componentId)] ?? projectDesign(s, own(SECTION));
    let r = applyOperations(s, [{ type: 'asset.add', asset: photo }, { type: 'node.insert', owner, parentId: null, index: 1, definitionId: sectionDef.id }]);
    const section = r.results[1].nodeId as string;
    r = applyOperations(r.state, [{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'grid' }]);
    const grid = r.results[0].nodeId as string;
    for (let i = 0; i < 3; i++) {
      r = applyOperations(r.state, [{ type: 'node.insert', owner, parentId: grid, primitive: 'image' }]);
      r = applyOperations(r.state, [{ type: 'node.setContent', owner, nodeId: r.results[0].nodeId as string, field: 'image', value: { assetId: 'a_photo', alt: 'A room' } }]);
    }
    return { s: r.state, section, grid };
  }

  /** Each photo's `sizes`, in page order (null when it has none). */
  const photoSizes = (s: ProjectState) => {
    const images = generateProject(s).get('src/routes/+page.svelte')!.match(/<SoImage [^\n]*photo-1a2b3c4d[^\n]*/g) ?? [];
    expect(images).toHaveLength(3);
    return images.map((img) => img.match(/ sizes="([^"]*)"/)?.[1] ?? null);
  };
  const gridSizes = (s: ProjectState) => [...new Set(photoSizes(s))];
  const style = (s: ProjectState, nodeId: string, property: string, value: unknown, extra: Record<string, unknown> = {}) =>
    applyOperations(s, [{ type: 'node.setStyle', owner: { kind: 'page', id: s.site.homePageId }, nodeId, scope: 'base', property, value, ...extra } as never]).state;
  const photosOf = (s: ProjectState, grid: string) => (home(s).nodes[grid] as GraphNode & { children: string[] }).children;
  /** The photos straight in the Section, without the grid between. */
  const ungrid = (s: ProjectState, grid: string) => {
    const page = home(s);
    const photos = photosOf(s, grid);
    for (const n of Object.values(page.nodes)) if (n.kind === 'instance' && n.slots?.content?.includes(grid)) n.slots.content = [...photos];
    delete page.nodes[grid];
  };
  const DEFAULT = '(min-width: 1024px) 400px, (min-width: 768px) 100vw, 100vw';

  it('sizes images in a grid built on the page like the same grid in a preset (#170)', () => {
    // The Section's 1200px container holds a grid of three columns on desktop and one below it.
    expect(photoSizes(manualGrid(fresh()).s)).toEqual([DEFAULT, DEFAULT, DEFAULT]);
  });

  it('follows a placement that widens its container, so the grid is never undersized', () => {
    const { s, section } = manualGrid(fresh());
    expect(gridSizes(style(s, section, 'maxWidth', '1800px', { partId: 'container' }))).toEqual(['(min-width: 1024px) 600px, (min-width: 768px) 100vw, 100vw']);
    // A container with no fixed width leaves only the viewport to go by.
    expect(gridSizes(style(s, section, 'maxWidth', '100%', { partId: 'container' }))).toEqual(['(min-width: 1024px) 33.34vw, (min-width: 768px) 100vw, 100vw']);
  });

  it('gives an image that spans the whole grid the whole container', () => {
    const { s, grid } = manualGrid(fresh());
    const page = home(s);
    const gridNode = page.nodes[grid] as GraphNode & { children: string[] };
    // Wrap the first photo in a full-width row of the grid.
    const wrap: GraphNode = { id: 'n_wrap', kind: 'element', tag: 'div', children: [gridNode.children[0]], styles: { base: { columnSpan: 'full' } } };
    page.nodes[wrap.id] = wrap;
    gridNode.children[0] = wrap.id;
    expect(photoSizes(s)).toEqual(['(min-width: 1024px) 1200px, (min-width: 768px) 100vw, 100vw', DEFAULT, DEFAULT]);
    // Two of three columns: two thirds of the container.
    wrap.styles = { base: { columnSpan: '2' } };
    expect(photoSizes(s)).toEqual(['(min-width: 1024px) 800px, (min-width: 768px) 100vw, 100vw', DEFAULT, DEFAULT]);
    // Uneven columns: an item may sit in the widest one. For all sizes they apply from tablet up, so a phone keeps
    // one column.
    gridNode.styles = { base: { layout: 'grid', gridTemplate: '1fr 2fr' } };
    wrap.styles = {};
    expect(gridSizes(s)).toEqual(['(min-width: 1024px) 800px, (min-width: 768px) 66.67vw, 100vw']);
    // With a count and column sizes both set, a stronger rule sizing cannot see may pick either: the wider one is assumed.
    gridNode.styles = { base: { layout: 'grid', columns: 1, gridTemplate: '1fr 1fr' } };
    expect(gridSizes(s)).toEqual(['(min-width: 1024px) 1200px, (min-width: 768px) 100vw, 100vw']);
    // A column count that is not a whole number makes no columns.
    gridNode.styles = { base: { layout: 'grid', columns: 2.5 } };
    expect(gridSizes(s)).toEqual(['(min-width: 1024px) 1200px, (min-width: 768px) 100vw, 100vw']);
    // As many as fit: how many is unknown, so the whole width.
    gridNode.styles = { base: { layout: 'grid', gridTemplate: 'auto-fit-sm' } };
    expect(gridSizes(s)).toEqual(['(min-width: 1024px) 1200px, (min-width: 768px) 100vw, 100vw']);
    gridNode.styles = { base: { layout: 'grid', gridTemplate: 'repeat(auto-fill, minmax(18rem, 1fr))' } };
    expect(gridSizes(s)).toEqual(['(min-width: 1024px) 1200px, (min-width: 768px) 100vw, 100vw']);
    // Custom fr shares, repeats included, size like the presets (#352): an item may sit in the widest column.
    gridNode.styles = { base: { layout: 'grid', gridTemplate: '2fr repeat(2, minmax(0, 1fr))' } };
    expect(gridSizes(s)).toEqual(['(min-width: 1024px) 600px, (min-width: 768px) 50vw, 100vw']);
    // Spanning two of them: the widest run of two.
    wrap.styles = { base: { columnSpan: '2' } };
    expect(photoSizes(s)[0]).toBe('(min-width: 1024px) 900px, (min-width: 768px) 75vw, 100vw');
    // Starting on the last of them, the same span runs past it: the whole width.
    wrap.styles = { base: { columnStart: '3', columnSpan: '2' } };
    expect(photoSizes(s)[0]).toBe('(min-width: 1024px) 1200px, (min-width: 768px) 100vw, 100vw');
    // A span saved with spaces around it is the full width CSS gives it.
    wrap.styles = { base: { columnSpan: ' full ' } };
    expect(photoSizes(s)[0]).toBe('(min-width: 1024px) 1200px, (min-width: 768px) 100vw, 100vw');
    wrap.styles = {};
    // Shares adding up to less than one are read against their own total, an upper estimate whatever gaps and
    // implicit columns do with the rest.
    gridNode.styles = { base: { layout: 'grid', gridTemplate: '.25fr .25fr' } };
    expect(gridSizes(s)).toEqual(['(min-width: 1024px) 600px, (min-width: 768px) 50vw, 100vw']);
    // Spanning past them adds a column that can stretch over the rest: the whole width.
    wrap.styles = { base: { columnSpan: '3' } };
    expect(photoSizes(s)[0]).toBe('(min-width: 1024px) 1200px, (min-width: 768px) 100vw, 100vw');
    wrap.styles = {};
    // With a fixed or content-sized column, any column may be the widest: the whole width, as before.
    for (const template of ['16rem 1fr 14rem', 'minmax(10rem, 1fr) 1fr', 'auto 1fr']) {
      gridNode.styles = { base: { layout: 'grid', gridTemplate: template } };
      expect(gridSizes(s), template).toEqual(['(min-width: 1024px) 1200px, (min-width: 768px) 100vw, 100vw']);
    }
  });

  it('keeps a width the image holds whatever its column, even when it overflows the column', () => {
    const { s, grid } = manualGrid(fresh());
    const only = (width: StyleProps) => {
      for (const id of photosOf(s, grid)) home(s).nodes[id].styles = { base: width };
      return gridSizes(s);
    };
    // 600px in a 400px column stays 600px.
    expect(only({ width: '600px' })).toEqual(['600px']);
    expect(only({ width: '600px', maxWidth: '500px' })).toEqual(['500px']);
    // Growing only means something in a row or stack: in the grid, 200px holds.
    expect(only({ width: '200px', flexGrow: 1 })).toEqual(['200px']);
    // A viewport width is the viewport's, not the column's: the runtime default.
    expect(only({ width: '100vw' })).toEqual([null]);
    expect(only({ maxWidth: '300px' })).toEqual(['300px']);
    // Sized by its own picture, with its own max width in place of the theme's 100%: as wide as that max width.
    expect(only({ width: 'auto', maxWidth: '900px' })).toEqual(['900px']);
    expect(only({ width: 'auto' })).toEqual([DEFAULT]);
  });

  it('gives up where it cannot read the width, rather than guess too small', () => {
    const { s, grid } = manualGrid(fresh());
    const g = home(s).nodes[grid];
    const base = g.styles!.base!;
    for (const extra of [{ customCss: 'grid-template-columns: 1fr' }, { position: 'absolute' }] as StyleProps[]) {
      g.styles = { ...g.styles, base: { ...base, ...extra } };
      expect(gridSizes(s)).toEqual([null]);
    }
    g.styles = { ...g.styles, base: { ...base, customCss: 'filter: saturate(1.2)' } };
    expect(gridSizes(s)).toEqual([DEFAULT]);
    g.styles = { ...g.styles, base };
    // Widths that can leave their column: a minimum, a percentage, growing in a row.
    const only = (styles: StyleProps) => {
      for (const id of photosOf(s, grid)) home(s).nodes[id].styles = { base: styles };
      return gridSizes(s);
    };
    for (const styles of [{ minWidth: '500px' }, { minWidth: '40rem' }, { width: '200%' }, { marginInlineStart: '-100%' }] as StyleProps[]) expect(only(styles)).toEqual([null]);
    g.styles = { base: { layout: 'row' } };
    for (const styles of [{ width: '200px', flexGrow: 1 }, { width: '25%', flexGrow: 1 }] as StyleProps[]) expect(only(styles)).toEqual([null]);
    // Growing in a row from a viewport width too.
    expect(only({ width: '20vw', flexGrow: 1 })).toEqual([null]);
    // Straight in a row, a cropped picture stretches to the row's height; uncropped it is only as wide as the row.
    expect(only({})).toEqual([null]);
    expect(only({ objectFit: 'contain' })).toEqual(['(min-width: 1024px) 1200px, (min-width: 768px) 100vw, 100vw']);
    // In a row, a wrapper is as wide as its content needs, so the row's width no longer bounds the image.
    const page = home(s);
    for (const id of photosOf(s, grid)) {
      const wrap: GraphNode = { id: `w_${id}`, kind: 'element', tag: 'div', children: [id] };
      page.nodes[wrap.id] = wrap;
    }
    (page.nodes[grid] as GraphNode & { children: string[] }).children = photosOf(s, grid).map((id) => `w_${id}`);
    for (const id of Object.keys(page.nodes).filter((k) => k.startsWith('w_'))) page.nodes[id.slice(2)].styles = {};
    expect(gridSizes(s)).toEqual([null]);
    // Unless the image bounds itself.
    for (const id of Object.keys(page.nodes).filter((k) => k.startsWith('w_'))) page.nodes[id.slice(2)].styles = { base: { maxWidth: '300px' } };
    expect(gridSizes(s)).toEqual(['300px']);
    // A fixed width further in does not hide what an outer box does to it.
    g.styles = { base: { ...base, customCss: 'transform: scale(2)' } };
    expect(gridSizes(s)).toEqual([null]);
  });

  it('widens the estimate for a picture cropped to a narrower shape', () => {
    const { s, grid } = manualGrid(fresh());
    // A 3:2 photo filling a square tile is scaled to 1.5 times the tile's width before it is cropped.
    for (const id of photosOf(s, grid)) home(s).nodes[id].styles = { base: { aspectRatio: '1/1' } };
    expect(gridSizes(s)).toEqual(['(min-width: 1024px) 600px, (min-width: 768px) 150vw, 150vw']);
    for (const id of photosOf(s, grid)) home(s).nodes[id].styles = { base: { aspectRatio: '1/1', objectFit: 'contain' } };
    expect(gridSizes(s)).toEqual([DEFAULT]);
    // An explicit automatic height is no height of its own: the aspect ratio still shapes the box.
    for (const id of photosOf(s, grid)) home(s).nodes[id].styles = { base: { aspectRatio: '1/1', height: 'auto' } };
    expect(gridSizes(s)).toEqual(['(min-width: 1024px) 600px, (min-width: 768px) 150vw, 150vw']);
    // A fixed height, or a minimum one, needs the width that height gives the photo; with a fixed height the aspect
    // ratio no longer shapes the box.
    for (const styles of [{ height: '500px' }, { minHeight: '500px' }, { height: '500px', aspectRatio: '1/1' }] as StyleProps[]) {
      for (const id of photosOf(s, grid)) home(s).nodes[id].styles = { base: styles };
      expect(gridSizes(s)).toEqual(['(min-width: 1024px) 750px, (min-width: 768px) 100vw, 768px']);
    }
  });

  it('sizes a grid outside any container by its share of the viewport, per range', () => {
    const { s, grid } = manualGrid(fresh());
    const page = home(s);
    // The grid moves to the page itself, with two columns on tablets and one on phones.
    for (const n of Object.values(page.nodes)) if (n.kind === 'instance' && n.slots?.content?.includes(grid)) n.slots.content = [];
    page.rootIds.push(grid);
    const g = page.nodes[grid];
    g.styles = { ...g.styles, tablet: { columns: 2 } };
    expect(gridSizes(s)).toEqual(['(min-width: 1024px) 33.34vw, (min-width: 768px) 50vw, 100vw']);
  });

  it('reads columns a placement gives its container from tablet up, as the generated CSS does', () => {
    const { s, section, grid } = manualGrid(fresh());
    ungrid(s, grid);
    // The photos sit straight in the Section, whose container this placement turns into a two-column grid.
    let t = style(s, section, 'layout', 'grid', { partId: 'container' });
    t = style(t, section, 'columns', 2, { partId: 'container' });
    expect(gridSizes(t)).toEqual(['(min-width: 1024px) 600px, (min-width: 768px) 50vw, 100vw']);
  });

  it('gives up when the page styles a placement nested in another, whose own rules it competes with', () => {
    const { s, section } = manualGrid(fresh());
    const page = home(s);
    // The Section holding the grid moves into another Section's slot, and the page narrows it there.
    const outer = placeDesign(s, SECTION);
    page.rootIds = page.rootIds.filter((id) => id !== section);
    outer.slots = { content: [section] };
    expect(gridSizes(s)).toEqual([DEFAULT]);
    page.nodes[section].styles = { base: { maxWidth: '300px' } };
    expect(gridSizes(s)).toEqual([null]);
  });

  it('settles variant options the way the stylesheet does: a range value beats a later option\'s base value', () => {
    const { s, section, grid } = manualGrid(fresh());
    ungrid(s, grid);
    const def = defOf(s, 'project.section');
    const inner = def.parts.container.nodeId;
    // Two axes on the Section: the first makes the container one column on desktop, the second three columns.
    def.variantAxes = {
      ...def.variantAxes,
      stack: { label: 'Stack', default: 'desktop', options: { desktop: { label: 'Desktop', styles: { [inner]: { desktop: { columns: 1 } } } } } },
      cols: { label: 'Columns', default: 'three', options: { three: { label: 'Three', styles: { [inner]: { base: { layout: 'grid', columns: 3 } } } } } }
    } as never;
    // Desktop: the first axis's desktop rule comes after the second's tablet-up rule, so one column; tablets get three.
    expect(gridSizes(s)).toEqual(['(min-width: 1024px) 1200px, (min-width: 768px) 33.34vw, 100vw']);
    delete (def.variantAxes as Record<string, unknown>).stack;
    expect(gridSizes(s)).toEqual(['(min-width: 1024px) 400px, (min-width: 768px) 33.34vw, 100vw']);
  });

  it('keeps a definition\'s images to what the definition alone decides', () => {
    // A container with no grid can be widened by any placement, so the split hero without a grid keeps 100vw.
    const s = fresh();
    s.site.themeId = 'foundation-alt';
    addToHome(s, 'hero.split');
    const hero = [...generateProject(s).entries()].find(([p]) => p.endsWith('foundation-alt-hero-split.svelte'))![1];
    expect(hero).toContain('<SoImage');
    expect(hero).not.toMatch(/<SoImage[^>]*\ssizes=/);
  });

  it('passes the header logo its small copies, so its sizes hint can pick one', () => {
    const { s } = manualGrid(fresh());
    const header = Object.values(s.site.shell.header.nodes).find((n) => n.kind === 'instance') as InstanceNode;
    header.props = { ...header.props, logo: { assetId: 'a_photo', alt: 'Logo' } };
    const layout = generateProject(s).get('src/routes/+layout.svelte')!;
    expect(layout).toContain('/assets/photo-1a2b3c4d-160w.jpg 160w, /assets/photo-1a2b3c4d-480w.jpg 480w');
    expect(layout).toMatch(/"width":2400,"height":1600/);
  });
});

describe('first-screen image loading through code components', () => {
  const home = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
  const sourceOf = (files: Map<string, string>, name: string) => [...files.entries()].find(([p]) => p.endsWith(name))![1];
  /** The opening tag of a component placed on the page, found by the file it imports. */
  const tagOf = (page: string, file: string) => {
    const name = page.match(new RegExp(`import (C_\\w+) from "[^"]*${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))![1];
    const at = page.indexOf(`<${name}\n`);
    return page.slice(at, page.indexOf('/>', at));
  };
  /** A file that forwards or reads `{so_eager}` must declare it, or rendering throws a ReferenceError. */
  const expectEagerBound = (files: Map<string, string>) => {
    for (const [path, src] of files) {
      if (!path.endsWith('.svelte') || path === 'src/routes/+page.svelte') continue;
      if (/[={]so_eager\}/.test(src)) expect(src, path).toContain('so_eager = false');
    }
  };

  it('keeps a converted first hero eager and lower sections lazy', () => {
    let s = fresh();
    const hero = placeDesign(s, HERO_SPLIT, { index: 0 });
    s = applyOperations(s, [{ type: 'component.convertToCode', owner: home(s), nodeId: hero.id, name: 'Hero code' }]).state;
    const files = generateProject(s);
    const page = files.get('src/routes/+page.svelte')!;
    // Only the first section is told to load eagerly, and it is the converted component.
    expect(page.match(/so_eager=\{true\}/g)).toHaveLength(1);
    const code = Object.values(s.components).find((d) => d.name === 'Hero code')!;
    expect(code.source).toContain('so_eager = false');
    expect(code.source).toContain('eager={so_eager}');
    expect(files.get(defFile(code))).toContain('eager={so_eager}');
    expect(tagOf(page, defFile(code).split('/').pop()!)).toContain('so_eager={true}');
    expect(sourceOf(files, 'media-gallery.svelte')).not.toContain('eager');
    expectEagerBound(files);
    expect(compileAll(files)).toEqual([]);
  });

  it('passes the flag on from a reusable component wrapping a converted hero', () => {
    let s = fresh();
    const hero = placeDesign(s, HERO_SPLIT, { index: 0 });
    const wrap = applyOperations(s, [{ type: 'component.createFromNode', owner: home(s), nodeId: hero.id, name: 'Wrapper' }]);
    s = wrap.state;
    const wrapId = wrap.results[0].definitionId as string;
    const inner = Object.values(s.components[wrapId].tree!.nodes).find((n) => n.kind === 'instance')!;
    s = applyOperations(s, [{ type: 'component.convertToCode', owner: { kind: 'component', id: wrapId }, nodeId: inner.id, name: 'Inner code' }]).state;
    const files = generateProject(s);
    const page = files.get('src/routes/+page.svelte')!;
    expect(page.match(/so_eager=\{true\}/g)).toHaveLength(1);
    expect(tagOf(page, defFile(s.components[wrapId]).split('/').pop()!)).toContain('so_eager={true}');
    const wrapper = files.get(defFile(s.components[wrapId]))!;
    expect(wrapper).toContain('so_eager = false');
    expect(wrapper).toContain('so_eager={so_eager}');
    expectEagerBound(files);
    expect(compileAll(files)).toEqual([]);
  });

  it('does not make a wrapped hero eager lower on the page', () => {
    let s = fresh();
    const hero = instanceOf(s, 'hero.split');
    const wrap = applyOperations(s, [{ type: 'component.createFromNode', owner: home(s), nodeId: hero.id, name: 'Wrapper' }]);
    s = wrap.state;
    const page = s.pages[s.site.homePageId];
    // Move the wrapper below another section: it is no longer the first screen.
    const wrapperId = wrap.results[0].nodeId as string;
    page.rootIds = page.rootIds.filter((id) => id !== wrapperId);
    page.rootIds.push(wrapperId);
    const out = generateProject(s).get('src/routes/+page.svelte')!;
    expect(out).toContain('<C_proj_wrapper');
    expect(out).not.toContain('so_eager');
  });

  it('forwards the flag for a hero placed both inside and outside a list, whichever comes first', () => {
    const s = fresh();
    // A grid of the project's own design, placed on Home, holding a hero of its own design.
    const grid = projectDesign(s, own(FEATURES));
    placeDesign(s, FEATURES);
    const heroDef = projectDesign(s, own(HERO_SPLIT));
    const tree = grid.tree!;
    const repeat = Object.values(tree.nodes).find((n) => n.kind === 'repeat')!;
    const root = tree.nodes[tree.rootIds[0]] as Extract<GraphNode, { kind: 'element' }>;
    const inList = makeInstance(heroDef, {});
    const outside = makeInstance(heroDef, {});
    // The placement inside the list is visited first.
    tree.nodes = { [inList.id]: inList, ...tree.nodes, [outside.id]: outside };
    (repeat as Extract<GraphNode, { kind: 'repeat' }>).children.push(inList.id);
    root.children.push(outside.id);
    const files = generateProject(s);
    const out = files.get(defFile(grid))!;
    expect(out).toContain('so_eager = false');
    expect(out.match(/so_eager=\{so_eager\}/g)).toHaveLength(1);
    expectEagerBound(files);
  });

  it('hands the flag to a code component however it writes its props, but not to one that never names it', () => {
    let s = fresh();
    const hero = placeDesign(s, HERO_SPLIT, { index: 0 });
    s = applyOperations(s, [{ type: 'component.convertToCode', owner: home(s), nodeId: hero.id, name: 'Hero code' }]).state;
    const code = Object.values(s.components).find((d) => d.name === 'Hero code')!;
    const page = () => generateProject(s).get('src/routes/+page.svelte')!;
    code.source = `<div {...rest}>Hi</div>\n<script>\n\tlet { ...rest } = $props();\n</script>\n`;
    expect(page()).not.toContain('so_eager');
    // Renamed on the way in, bound with const, and after a line that holds "//" inside a string.
    code.source = `<div {...rest}>{eager}</div>\n<script>\n\tconst cdn = "//cdn.example/a//b.png"; const { so_eager: eager = false, ...rest } = $props();\n</script>\n`;
    expect(page().match(/so_eager=\{true\}/g)).toHaveLength(1);
    // A property the manifest declares is the author's own, and is never added twice.
    code.properties.so_eager = { type: 'boolean', default: false } as never;
    expect(page()).not.toContain('so_eager={true}');
  });
});

describe('icons', () => {
  it('ships social icons and only the icons a project uses', () => {
    const s = fresh();
    const used = usedIcons(s);
    expect(used).toContain('compass');
    expect(used).toContain('sparkles');
    expect(used).not.toContain('github');
    const grid = instanceOf(s, 'features.grid');
    (grid.props.items as Array<{ icon: string }>)[0].icon = 'github';
    const icons = generateProject(s).get(`${RUNTIME_DIR}/icons.js`)!;
    expect(icons).toContain('"github"');
    // The footer's social links start as Instagram, so that one ships; one nothing names does not.
    expect(icons).toContain('"instagram"');
    expect(icons).not.toContain('"facebook"');
  });

  it('includes icons named in code component source', () => {
    const s = fresh();
    const def: ComponentDefinition = { ...defOf(s, 'shell.header'), id: 'code.x', source: '<SoIcon name="instagram" />' };
    s.components[def.id] = def;
    expect(usedIcons(s)).toContain('instagram');
  });
});

describe('contact form', () => {
  it('warns until the form is connected to a service', () => {
    const s = fresh();
    const form = addToHome(s, 'contact.form');
    expect(validateState(s).some((d) => d.code === 'FORM_UNCONNECTED')).toBe(true);
    form.props.endpoint = 'http://insecure.example/f';
    expect(validateState(s).some((d) => d.code === 'FORM_UNCONNECTED')).toBe(true);
    form.props.endpoint = 'https://?x';
    expect(validateState(s).some((d) => d.code === 'FORM_UNCONNECTED')).toBe(true);
    form.props.endpoint = 'https://formspree.io/f/abc123';
    expect(validateState(s).some((d) => d.code === 'FORM_UNCONNECTED')).toBe(false);
    form.props.endpoint = '';
    form.props.provider = 'netlify';
    expect(validateState(s).some((d) => d.code === 'FORM_UNCONNECTED')).toBe(false);
    form.props.formName = '  ';
    expect(validateState(s).some((d) => d.code === 'FORM_UNCONNECTED')).toBe(true);
    form.props.provider = 'web3forms';
    form.props.accessKey = '   ';
    expect(validateState(s).some((d) => d.code === 'FORM_UNCONNECTED')).toBe(true);
    form.props.accessKey = 'abc-123';
    expect(validateState(s).some((d) => d.code === 'FORM_UNCONNECTED')).toBe(false);
  });

  it('posts to the endpoint with a honeypot and accessible status regions', () => {
    const s = fresh();
    addToHome(s, 'contact.form');
    const src = defOf(s, 'contact.form').source!;
    expect(src).toContain('method="POST"');
    expect(src).toContain('action={action}');
    expect(src).toContain("headers: { Accept: 'application/json' }");
    expect(src).toContain("_gotcha");
    expect(src).toMatch(/<input [^>]*type="checkbox" name=\{honeypot\} tabindex="-1"/);
    expect(src).toMatch(/<input [^>]*type="text" name=\{honeypot\} tabindex="-1"/);
    // Sending is refused until the form is ready and while a message is on its way.
    expect(src).toMatch(/type="submit" disabled=\{!ready\} aria-disabled=\{status === 'sending' \? 'true' : undefined\}/);
    expect(src).toContain("if (!ready || status === 'sending') return;");
    expect(src).toContain('HTMLFormElement.prototype.reset.call(form)');
    // The live regions sit outside the form, which is aria-busy while sending: the confirmation and the failure
    // both follow it.
    const [formStart, formEnd] = [src.indexOf('<form'), src.indexOf('</form>')];
    expect(formStart).toBeGreaterThan(0);
    expect(src.indexOf('role="status"')).toBeGreaterThan(formEnd);
    expect(src.indexOf('role="alert"')).toBeGreaterThan(formEnd);
    expect(src).toContain('role="status"');
    expect(src).toContain('role="alert"');
    expect(src).toContain('aria-busy');
  });
});

describe('editor variants and hot updates', () => {
  // #14: hydrated markup that starts with a component lost track of its own DOM once that component was
  // hot-updated alone, so the next update of the file left the old copy above the new one.
  /** The local name a generated file imports another generated file under. */
  const importOf = (source: string, file: string) => source.match(new RegExp(`import (\\w+) from "[^"]*/${file.split('/').pop()!.replace(/[.]/g, '\\.')}";`))?.[1];

  it('puts a page that starts with a component between boundaries of its own, in editor variants only', () => {
    const s = fresh();
    const hero = placeDesign(s, HERO_SPLIT, { index: 0 });
    expect(home(s).rootIds[0]).toBe(hero.id);
    const dev = generateProject(s, { instrument: true });
    const page = dev.get('src/routes/+page.svelte')!;
    const heroName = importOf(page, defFile(s.components[hero.definitionId]));
    expect(heroName).toBeTruthy();
    // The head stays outside; the boundary holds every section, starting with the hero.
    expect(page).toMatch(new RegExp(`</svelte:head>\\n\\n\\{#key 'siteorigin'\\}\\n<${heroName}\\n[\\s\\S]*\\n\\{/key\\}\\n$`));
    expect(page.match(/\{#key /g)).toHaveLength(1);
    expect(page.slice(0, page.indexOf('{#key'))).not.toMatch(/<C_/);
    // The layout starts and ends with markup of its own, and the exported files never carry the boundary.
    expect(dev.get('src/routes/+layout.svelte')).not.toContain('{#key');
    for (const [path, source] of generateProject(s)) if (path.endsWith('.svelte')) expect(source, path).not.toContain('{#key');
    expect(compileAll(dev)).toEqual([]);
  });

  it('leaves a component that is one native element as it is', () => {
    const s = fresh();
    placeDesign(s, HERO_SPLIT);
    const def = defOf(s, 'project.hero-split');
    const source = generateProject(s, { instrument: true }).get(defFile(def))!;
    expect(source).toMatch(/<\/script>\n\n<section [\s\S]*<\/section>\n$/);
    expect(source).not.toContain('{#key');
  });

  it('puts a component that starts with another component between boundaries of its own', () => {
    const base = fresh();
    const page = home(base);
    placeDesign(base, HERO_SPLIT, { index: 0 });
    const applied = applyOperations(base, [{ type: 'component.createFromNode', owner: { kind: 'page', id: page.id }, nodeId: page.rootIds[0], name: 'Hero band' }]);
    const s = applied.state;
    const created = applied.results[0] as { definitionId: string };
    const outer = s.components[created.definitionId];
    const inner = outer.tree!.nodes[outer.tree!.rootIds[0]] as InstanceNode;
    expect(inner.kind).toBe('instance');
    const dev = generateProject(s, { instrument: true });
    const source = dev.get(defFile(outer))!;
    const innerName = importOf(source, defFile(s.components[inner.definitionId]));
    expect(innerName).toBeTruthy();
    expect(source).toMatch(new RegExp(`</script>\\n\\n\\{#key 'siteorigin'\\}\\n<${innerName}\\n[\\s\\S]*\\n\\{/key\\}\\n$`));
    expect(generateProject(s).get(defFile(outer))).not.toContain('{#key');
    expect(compileAll(dev)).toEqual([]);
  });

  it('keeps an empty page valid', () => {
    const s = fresh();
    home(s).rootIds = [];
    home(s).nodes = {};
    const page = generateProject(s, { instrument: true }).get('src/routes/+page.svelte')!;
    expect(page).toMatch(/\{#key 'siteorigin'\}\n\n\{\/key\}\n$/);
    expect(compileAll(new Map([['src/routes/+page.svelte', page]]))).toEqual([]);
  });
});

describe('section links', () => {
  const contactOf = (s: ProjectState) => s.site.pageOrder.map((id) => s.pages[id]).find((p) => p.route === '/contact/')!;
  const headerOf = (s: ProjectState) => s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
  const missing = (s: ProjectState) => validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING');

  it('reports a link to a section the destination page does not have', () => {
    const s = fresh();
    const contact = contactOf(s);
    headerOf(s).props.ctaLink = { type: 'page', target: contact.id, anchor: 'get-in-touch-with-us' };
    const found = missing(s);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].owner).toEqual({ kind: 'shell', id: 'header' });
    expect(found[0].nodeId).toBe(headerOf(s).id);
    expect(found[0].message).toContain('Book a call');
    expect(found[0].message).toContain('#get-in-touch-with-us');
    expect(found[0].message).toContain('Contact');
    // An ID on another page does not count: the link goes to Contact.
    instanceOf(s, 'features.grid').anchor = 'get-in-touch-with-us';
    expect(missing(s)).toHaveLength(1);
  });

  it('accepts the section once it exists, and reports it again when the section is deleted', () => {
    let s = fresh();
    const { contact, details } = managedContact(s);
    headerOf(s).props.ctaLink = { type: 'page', target: contact.id, anchor: 'get-in-touch' };
    expect(missing(s)).toHaveLength(1);
    s = applyOperations(s, [{ type: 'node.setContent', owner: { kind: 'page', id: contact.id }, nodeId: details.id, field: 'anchor', value: 'get-in-touch' }]).state;
    expect(missing(s)).toEqual([]);
    s = applyOperations(s, [{ type: 'node.remove', owner: { kind: 'page', id: contact.id }, nodeId: details.id }]).state;
    expect(missing(s)).toHaveLength(1);
  });

  // Release gap: the engine refuses anchors and entrances on code components (anchorCapable in src/engine/tree.ts), though every release section renders id={so_id}.
  it.fails('takes an ID on a section of the release', () => {
    const s = fresh();
    const contact = contactOf(s);
    const details = instanceOf(s, 'contact.details', contact.id);
    expect(() => applyOperations(s, [{ type: 'node.setContent', owner: { kind: 'page', id: contact.id }, nodeId: details.id, field: 'anchor', value: 'get-in-touch' }])).not.toThrow();
  });

  it('checks same-page links against the page they render on', () => {
    const s = fresh();
    const hero = instanceOf(s, 'hero.split');
    hero.props.secondaryLink = { type: 'anchor', target: 'services' };
    const found = missing(s);
    expect(found).toHaveLength(1);
    expect(found[0].owner).toEqual({ kind: 'page', id: s.site.homePageId });
    expect(found[0].nodeId).toBe(hero.id);
    expect(found[0].message).toContain('About the studio');
    instanceOf(s, 'features.grid').anchor = 'services';
    expect(missing(s)).toEqual([]);
    // The same link on About looks for the section on About.
    const about = s.site.pageOrder[1];
    const banner = instanceOf(s, 'cta.banner', about);
    banner.props.primaryLink = { type: 'anchor', target: 'services' };
    const onAbout = missing(s);
    expect(onAbout).toHaveLength(1);
    expect(onAbout[0].owner).toEqual({ kind: 'page', id: about });
    expect(onAbout[0].nodeId).toBe(banner.id);
  });

  it('accepts the ids the generated layout always has', () => {
    const s = fresh();
    instanceOf(s, 'hero.split').props.secondaryLink = { type: 'anchor', target: 'main' };
    expect(missing(s)).toEqual([]);
    // "#top" goes to the top of the page without an element of that ID, in browsers and in the static build.
    instanceOf(s, 'hero.split').props.secondaryLink = { type: 'anchor', target: 'top' };
    expect(missing(s)).toEqual([]);
    // The header's code writes this one out literally, so it exists wherever the header shows.
    instanceOf(s, 'hero.split').props.secondaryLink = { type: 'anchor', target: 'so-site-nav' };
    expect(missing(s)).toEqual([]);
    // Only the header matters for an ID it writes: a page without the footer still has it.
    s.pages[s.site.homePageId].showFooter = false;
    expect(missing(s)).toEqual([]);
    s.pages[s.site.homePageId].showHeader = false;
    expect(missing(s)).toHaveLength(1);
  });

  it('checks a shared link on every page that shows the header, and only those', () => {
    const s = fresh();
    const about = s.site.pageOrder[1];
    const contact = contactOf(s);
    headerOf(s).props.links = [{ id: 'i1', label: 'Services', link: { type: 'anchor', target: 'services' } }];
    instanceOf(s, 'features.grid').anchor = 'services';
    // Only IDs every page with the header has are safe for its "on this page" links.
    expect([...sharedPageIds(s, 'header')].sort()).toEqual(['main', 'so-site-nav', 'top']);
    let found = missing(s);
    expect(found).toHaveLength(1);
    expect(found[0].nodeId).toBe(headerOf(s).id);
    expect(found[0].message).toContain('the “Services” link');
    expect(found[0].message).toContain('About and Contact have no section');
    // A page that keeps only the footer still limits the footer's links, not the header's.
    contact.showHeader = false;
    found = missing(s);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain(`${s.pages[about].title} has no section`);
    // A page without the header does not limit where the header's links can go.
    instanceOf(s, 'cta.banner', about).anchor = 'services';
    expect(sharedPageIds(s, 'header').has('services')).toBe(true);
    expect(sharedPageIds(s, 'footer').has('services')).toBe(false);
    expect(missing(s)).toEqual([]);
  });

  it('checks a code component link only when its label lets it render', () => {
    const s = fresh();
    headerOf(s).props.ctaLink = { type: 'page', target: contactOf(s).id, anchor: 'nowhere' };
    headerOf(s).props.ctaLabel = '';
    expect(missing(s)).toEqual([]);
    // The header shows its action for any label the template treats as present, spaces included.
    headerOf(s).props.ctaLabel = ' ';
    expect(missing(s)).toHaveLength(1);
  });

  it('reports links inside rich text, list items included', () => {
    const s = fresh();
    instanceOf(s, 'content.media').props.body = [
      { type: 'p', spans: [{ text: 'Read ' }, { text: 'how we work', link: { type: 'anchor', target: 'process' } }] },
      { type: 'ul', items: [[{ text: 'Our process', link: { type: 'anchor', target: 'process' } }]] }
    ];
    const found = missing(s);
    expect(found.map((d) => d.message.match(/“(.+?)”/)?.[1])).toEqual(['how we work', 'Our process']);
    expect(found[1].message).toContain('the “Our process” link in the text goes to #process');
    expect(found[1].message).toContain('Change the link in the text');
  });

  it('reports each broken link of a list, even with the same label', () => {
    const s = fresh();
    const grid = instanceOf(s, 'features.grid');
    const items = (grid.props.items as Array<Record<string, unknown>>).map((it) => ({ ...it, linkLabel: 'Learn more', link: { type: 'anchor', target: 'gone' } }));
    grid.props.items = items;
    expect(missing(s)).toHaveLength(3);
  });

  it('tells apart the same link in two placements of one component inside another', () => {
    const s = fresh();
    // A Section and a banner of the project's own designs, whose designs the links are put inside.
    const outer = placeDesign(s, SECTION);
    const id = projectDesign(s, own(BANNER)).id;
    const a = makeInstance(s.components[id], { primaryLink: { type: 'anchor', target: 'one' } });
    const b = makeInstance(s.components[id], { primaryLink: { type: 'anchor', target: 'two' } });
    home(s).nodes[a.id] = a;
    home(s).nodes[b.id] = b;
    outer.slots = { content: [a.id, b.id] };
    expect(missing(s).map((d) => d.message.match(/#(\w+)/)?.[1]).sort()).toEqual(['one', 'two']);
    // Inside a definition both report against the placement that holds them, and both still count.
    const wrap = defOf(s, 'project.section');
    const slotNode = Object.values(wrap.tree!.nodes).find((n) => n.kind === 'slot')!;
    const parentOf = Object.values(wrap.tree!.nodes).find((n) => n.kind === 'element' && n.children.includes(slotNode.id)) as { children: string[] };
    const ia = makeInstance(s.components[id], { primaryLink: { type: 'anchor', target: 'three' } });
    const ib = makeInstance(s.components[id], { primaryLink: { type: 'anchor', target: 'four' } });
    wrap.tree!.nodes[ia.id] = ia;
    wrap.tree!.nodes[ib.id] = ib;
    parentOf.children.push(ia.id, ib.id);
    expect(missing(s).filter((d) => d.nodeId === outer.id).map((d) => d.message.match(/#(\w+)/)?.[1]).sort()).toEqual(['four', 'three']);
  });

  it('walks slot content rendered once per list item only once', () => {
    const s = fresh();
    let parent = placeDesign(s, SECTION);
    const def = defOf(s, 'project.section');
    const slotNode = Object.values(def.tree!.nodes).find((n) => n.kind === 'slot')!;
    const holder = Object.values(def.tree!.nodes).find((n) => n.kind === 'element' && n.children.includes(slotNode.id)) as { children: string[] };
    // The slot renders once per item of a ten-item list; six sections nested through it stay quick to check.
    def.properties.rows = { type: 'list', label: 'Rows', itemLabel: 'Row', fields: {}, default: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}` })) } as never;
    def.tree!.nodes['rows'] = { id: 'rows', kind: 'repeat', list: { $prop: 'rows' }, children: [slotNode.id] };
    holder.children = holder.children.map((c) => (c === slotNode.id ? 'rows' : c));
    for (let i = 0; i < 6; i++) {
      const child = makeInstance(def, {});
      home(s).nodes[child.id] = child;
      parent.slots = { content: [child.id] };
      parent = child;
    }
    const leaf: GraphNode = { id: 'n_leaf', kind: 'link', label: 'Go', link: { type: 'anchor', target: 'nowhere' }, appearance: 'primary' };
    home(s).nodes[leaf.id] = leaf;
    parent.slots = { content: [leaf.id] };
    const started = Date.now();
    expect(missing(s)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('walks such slot content once inside a definition too', () => {
    const s = fresh();
    placeDesign(s, SECTION);
    const section = defOf(s, 'project.section');
    const slotNode = Object.values(section.tree!.nodes).find((n) => n.kind === 'slot')!;
    const holder = Object.values(section.tree!.nodes).find((n) => n.kind === 'element' && n.children.includes(slotNode.id)) as { children: string[] };
    section.properties.rows = { type: 'list', label: 'Rows', itemLabel: 'Row', fields: {}, default: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}` })) } as never;
    section.tree!.nodes['rows'] = { id: 'rows', kind: 'repeat', list: { $prop: 'rows' }, children: [slotNode.id] };
    holder.children = holder.children.map((c) => (c === slotNode.id ? 'rows' : c));
    // Six sections nested inside the banner's own definition, a button at the bottom.
    placeDesign(s, BANNER);
    placeDesign(s, BANNER, { pageId: s.site.pageOrder[1] });
    const banner = defOf(s, 'project.cta-banner');
    const root = banner.tree!.nodes[banner.tree!.rootIds[0]] as { children: string[] };
    const button: GraphNode = { id: 'b_leaf', kind: 'link', label: 'Go', link: { type: 'none', target: '' }, appearance: 'primary' };
    banner.tree!.nodes[button.id] = button;
    let inner: string = button.id;
    for (let i = 0; i < 6; i++) {
      const child = makeInstance(section, {});
      child.slots = { content: [inner] };
      banner.tree!.nodes[child.id] = child;
      inner = child.id;
    }
    root.children.push(inner);
    const started = Date.now();
    // One finding for each page that places the banner (Home and About), not one per rendering of the slot.
    expect(validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED' && d.message.includes('“Go”'))).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reads rich text links in a section converted to code', () => {
    let s = fresh();
    // A section of the project's own design with rich text, which is converted to code.
    const media = placeDesign(s, { componentId: 'project.media', name: 'Content with image', properties: { body: P.rich('Text', ['Before we draw anything we listen.']) }, parts: {}, build: (b) => b.el('root', 'section', {}, [b.rich('body', prop('body'))]) });
    const home = { kind: 'page' as const, id: s.site.homePageId };
    s = applyOperations(s, [{ type: 'component.convertToCode', owner: home, nodeId: media.id, name: 'Media code' }]).state;
    (s.pages[s.site.homePageId].nodes[media.id] as InstanceNode).props.body = [{ type: 'p', spans: [{ text: 'See the steps', link: { type: 'anchor', target: 'steps' } }] }];
    expect(missing(s).map((d) => d.message)).toEqual([expect.stringContaining('the “See the steps” link in the text goes to #steps')]);
  });

  it('gives a component root the id its placement sets, before its own', () => {
    const s = fresh();
    const banner = placeDesign(s, BANNER);
    const def = defOf(s, 'project.cta-banner');
    def.tree!.nodes[def.tree!.rootIds[0]].anchor = 'banner';
    expect(pageIds(s, s.site.homePageId).has('banner')).toBe(true);
    banner.anchor = 'start';
    const ids = pageIds(s, s.site.homePageId);
    expect(ids.has('start')).toBe(true);
    expect(ids.has('banner')).toBe(false);
  });

  it('leaves out ids inside a collapsing wrapper whose children all stay hidden', () => {
    const s = fresh();
    const banner = placeDesign(s, BANNER);
    const def = defOf(s, 'project.cta-banner');
    def.tree!.nodes['actions'].anchor = 'cta-actions';
    expect(pageIds(s, s.site.homePageId).has('cta-actions')).toBe(true);
    banner.props.primaryLabel = '';
    banner.props.secondaryLabel = 'More';
    expect(pageIds(s, s.site.homePageId).has('cta-actions')).toBe(true);
    banner.props.secondaryLabel = '';
    expect(pageIds(s, s.site.homePageId).has('cta-actions')).toBe(false);
    const out = generateManagedComponent(s, def, {});
    expect(out).toContain('{#if has(primaryLabel) || has(secondaryLabel)}');
  });

  it('walks nested collapsing wrappers the way the export renders them', () => {
    const s = fresh();
    const instance = placeDesign(s, DETAILS, { props: { eyebrow: '', heading: '', lead: '', actionLabel: '' } });
    const def = defOf(s, 'project.contact-details');
    def.tree!.nodes['content'].anchor = 'contact-column';
    def.tree!.nodes['intro'].anchor = 'contact-intro';
    const ids = () => pageIds(s, s.site.homePageId);
    expect(ids().has('contact-column')).toBe(false);
    expect(ids().has('contact-intro')).toBe(false);
    instance.props.actionLabel = 'Email us';
    expect(ids().has('contact-column')).toBe(true);
    expect(ids().has('contact-intro')).toBe(false);
    instance.props.actionLabel = '';
    instance.props.lead = 'Write to us';
    expect(ids().has('contact-column')).toBe(true);
    expect(ids().has('contact-intro')).toBe(true);
    // Text of only spaces counts as empty, as it does in the generated `has()`.
    instance.props.lead = '   ';
    expect(ids().has('contact-column')).toBe(false);
    expect(generateManagedComponent(s, def, {})).toContain('{#if (has(eyebrow) || has(heading) || has(lead)) || has(actionLabel)}');
  });

  it('walks a section placed inside another of the same kind', () => {
    const s = fresh();
    const outer = addToHome(s, 'layout.section');
    const id = installComponent(s, 'layout.section');
    const inner = makeInstance(s.components[id], {});
    const heading: GraphNode = { id: 'n_deep', kind: 'text', tag: 'h2', text: 'Deep', anchor: 'deep' };
    const button: GraphNode = { id: 'n_btn', kind: 'link', label: 'Go', link: { type: 'none', target: '' }, appearance: 'primary' };
    home(s).nodes[inner.id] = inner;
    home(s).nodes[heading.id] = heading;
    home(s).nodes[button.id] = button;
    // The inner section is not a root of its own; it lives in the outer one's content.
    home(s).rootIds = home(s).rootIds.filter((r) => r !== inner.id);
    outer.slots = { content: [inner.id] };
    inner.slots = { content: [heading.id, button.id] };
    expect(pageIds(s, s.site.homePageId).has('deep')).toBe(true);
    expect(validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED').map((d) => d.nodeId)).toContain('n_btn');
    // The anchored heading is listed; the sections around it, named only by it, are not.
    const listed = pageSections(s, s.site.homePageId);
    expect(listed.find((x) => x.nodeId === heading.id)).toMatchObject({ label: 'Deep', anchor: 'deep', nested: false });
    expect(listed.some((x) => x.nodeId === inner.id || x.nodeId === outer.id)).toBe(false);
  });

  it('counts slot content only where the definition shows the slot', () => {
    const s = fresh();
    const section = placeDesign(s, SECTION);
    const text: GraphNode = { id: 'n_note', kind: 'text', tag: 'p', text: 'Note', anchor: 'note' };
    home(s).nodes[text.id] = text;
    section.slots = { content: [text.id] };
    expect(pageIds(s, s.site.homePageId).has('note')).toBe(true);
    const def = s.components[section.definitionId];
    const slot = Object.values(def.tree!.nodes).find((n) => n.kind === 'slot')!;
    slot.when = { $prop: 'missing' };
    expect(pageIds(s, s.site.homePageId).has('note')).toBe(false);
  });
});

describe('choosing a section to link to', () => {
  const contactOf = (s: ProjectState) => s.site.pageOrder.map((id) => s.pages[id]).find((p) => p.route === '/contact/')!;
  const headerOf = (s: ProjectState) => s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
  const file = (files: Map<string, string>, end: string) => [...files.entries()].find(([p]) => p.endsWith(end))?.[1] ?? '';

  it("lists a page's sections by their visible headings", () => {
    const s = fresh();
    managedContact(s);
    expect(pageSections(s, contactOf(s).id).map((x) => x.label)).toEqual(['Let’s talk', 'Get in touch', 'Frequently asked questions']);
    expect(pageSections(s, contactOf(s).id).every((x) => !x.anchor && !x.nested)).toBe(true);
    const blank = createStarterState('blank', 'Blank', false);
    expect(pageSections(blank, blank.site.homePageId)).toEqual([]);
    // The logo strip shows its heading as a paragraph; its Heading property still names it.
    const logos = placeDesign(s, LOGOS, { props: { heading: 'Trusted by homeowners and local businesses' } });
    expect(pageSections(s, s.site.homePageId).find((x) => x.nodeId === logos.id)?.label).toBe('Trusted by homeowners and local businesses');
    // A heading placed straight on the page is a section of its own.
    const h: GraphNode = { id: 'n_h', kind: 'text', tag: 'h2', text: 'Opening hours' };
    contactOf(s).nodes[h.id] = h;
    contactOf(s).rootIds.push(h.id);
    expect(pageSections(s, contactOf(s).id).at(-1)).toMatchObject({ nodeId: 'n_h', label: 'Opening hours', nested: false });
  });

  // Release gap: the engine refuses anchors and entrances on code components (anchorCapable in src/engine/tree.ts), though every release section renders id={so_id}.
  it.fails("lists the release's sections on a page by their visible headings", () => {
    const s = fresh();
    const contact = contactOf(s);
    (contact.nodes[contact.rootIds[2]] as InstanceNode).props.heading = 'Frequently asked questions';
    expect(pageSections(s, contact.id).map((x) => x.label)).toEqual(['Let’s talk', 'Get in touch', 'Frequently asked questions']);
  });

  it('reuses the ID a section already renders with, so links to it keep working', () => {
    const s = fresh();
    // A banner of the project's own design, whose root renders an ID of its own.
    const banner = placeDesign(s, BANNER);
    const def = defOf(s, 'project.cta-banner');
    def.tree!.nodes[def.tree!.rootIds[0]].anchor = 'banner';
    expect(pageSections(s, s.site.homePageId).find((x) => x.nodeId === banner.id)?.anchor).toBe('banner');
    expect(planSectionPick(s, s.site.homePageId, banner.id)).toEqual({ anchor: 'banner', operations: [] });
    // A second placement inherits the same ID; it is offered as a section of its own and gets an ID of its own.
    const second = placeDesign(s, BANNER, { props: { heading: 'One more thing' } });
    const listed = pageSections(s, s.site.homePageId).find((x) => x.nodeId === second.id);
    expect(listed).toMatchObject({ label: 'One more thing', anchor: undefined });
    // With two elements rendering it, the ID no longer picks out the first one either: moving them would retarget it.
    expect(pageSections(s, s.site.homePageId).find((x) => x.nodeId === banner.id)?.anchor).toBeUndefined();
    expect(planSectionPick(s, s.site.homePageId, banner.id)!.operations).toHaveLength(1);
    expect(planSectionPick(s, s.site.homePageId, second.id)).toMatchObject({ anchor: 'one-more-thing', operations: [expect.objectContaining({ nodeId: second.id })] });
  });

  it('offers sections placed inside another section, and not the wrapper they name', () => {
    const s = fresh();
    managedContact(s);
    const contact = contactOf(s);
    const [intro, details, faq] = contact.rootIds;
    const wrapper = makeInstance(projectDesign(s, own(SECTION)), {});
    wrapper.slots = { content: [details, faq] };
    contact.nodes[wrapper.id] = wrapper;
    contact.rootIds = [intro, wrapper.id];
    const sections = pageSections(s, contact.id);
    expect(sections.map((x) => [x.label, x.nested])).toEqual([
      ['Let’s talk', false],
      ['Get in touch', false],
      ['Frequently asked questions', false]
    ]);
    // Once it has an ID of its own, the wrapper is offered too, by its name, with the sections inside it under it.
    wrapper.anchor = 'more';
    expect(pageSections(s, contact.id).map((x) => [x.label, x.anchor, x.nested])).toEqual([
      ['Let’s talk', undefined, false],
      ['Section', 'more', false],
      ['Get in touch', undefined, true],
      ['Frequently asked questions', undefined, true]
    ]);
  });

  it('gives a chosen section a stable ID in the same batch as the link, and keeps it through renames and moves', () => {
    let s = fresh();
    const { contact } = managedContact(s);
    const details = contact.rootIds[1];
    const plan = planSectionPick(s, contact.id, details)!;
    expect(plan.anchor).toBe('get-in-touch');
    expect(plan.operations).toHaveLength(1);
    s = applyOperations(s, [
      ...plan.operations,
      { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: headerOf(s).id, prop: 'ctaLink', value: { type: 'page', target: contact.id, anchor: plan.anchor } }
    ]).state;
    expect(validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING')).toEqual([]);
    // Choosing it again reuses the ID.
    expect(planSectionPick(s, contact.id, details)).toEqual({ anchor: 'get-in-touch', operations: [] });
    const page = { kind: 'page' as const, id: contact.id };
    s = applyOperations(s, [
      { type: 'instance.setProp', owner: page, nodeId: details, prop: 'heading', value: 'Talk to the studio' },
      { type: 'node.move', owner: page, nodeId: details, parentId: null, index: 0 }
    ]).state;
    expect(s.pages[contact.id].rootIds[0]).toBe(details);
    expect(pageSections(s, contact.id)[0]).toMatchObject({ label: 'Talk to the studio', anchor: 'get-in-touch' });
    expect(planSectionPick(s, contact.id, details)).toEqual({ anchor: 'get-in-touch', operations: [] });
    expect(validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING')).toEqual([]);
    const files = generateProject(s);
    expect(file(files, 'routes/contact/+page.svelte')).toContain('so_id={"get-in-touch"}');
    expect(file(files, 'routes/+layout.svelte')).toContain('ctaLink={{"href":"/contact/#get-in-touch"}}');
  });

  it('makes IDs that are valid and unused on the page', () => {
    const s = fresh();
    const { contact } = managedContact(s);
    const [intro, details, faq] = contact.rootIds;
    (contact.nodes[faq] as InstanceNode).anchor = 'get-in-touch';
    expect(planSectionPick(s, contact.id, details)!.anchor).toBe('get-in-touch-2');
    (contact.nodes[intro] as InstanceNode).props.heading = '2025: a new studio';
    expect(planSectionPick(s, contact.id, intro)!.anchor).toBe('a-new-studio');
    (contact.nodes[intro] as InstanceNode).props.heading = '';
    expect(planSectionPick(s, contact.id, intro)!.anchor).toMatch(/^[a-z][\w-]*$/);
    // A heading that matches an ID the site already uses gets a number.
    (contact.nodes[intro] as InstanceNode).props.heading = 'Main';
    expect(planSectionPick(s, contact.id, intro)!.anchor).toBe('main-2');
    // So does one that matches an ID inside a component on the page.
    (contact.nodes[faq] as InstanceNode).anchor = undefined;
    const def = defOf(s, 'project.faq');
    const inside = Object.values(def.tree!.nodes).find((n) => n.kind === 'text')!;
    inside.anchor = 'get-in-touch';
    expect(planSectionPick(s, contact.id, details)!.anchor).toBe('get-in-touch-2');
    (contact.nodes[intro] as InstanceNode).anchor = 'get-in-touch-2';
    expect(planSectionPick(s, contact.id, details)!.anchor).toBe('get-in-touch-3');
  });
});

describe('old addresses kept working (#37)', () => {
  /** The project once the website has been exported as it is now: its pages' addresses are kept working when they move (#890). */
  const exported = (s: ProjectState): ProjectState => ({ ...s, published: withPublished(s.published, s) ?? s.published });
  const titled = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!.id;
  const isRedirect = (f: string | undefined) => !!f && f.includes('http-equiv="refresh"');

  it('redirects through the published sub-path, beside a real page nested under the old address', () => {
    let s = exported(fresh());
    s.site.baseUrl = 'https://me.github.io/studio/';
    const about = titled(s, 'About');
    s = exported(applyOperations(s, [{ type: 'page.setHome', pageId: about }]).state);
    s = exported(applyOperations(s, [{ type: 'page.create', title: 'Team', route: '/about/team/' }]).state);
    expect(validateState(s).filter((d) => d.severity === 'error')).toEqual([]);
    const files = generateProject(s);
    const redirect = files.get('src/routes/about/+page.svelte')!;
    // resolve() adds the sub-path the site is published under, so /studio/about/ goes to /studio/.
    expect(redirect).toMatch(/^\timport \{ resolve \} from '\$app\/paths';$/m);
    expect(redirect).toContain('const to = resolve("/");');
    expect(redirect).toContain(`<meta http-equiv="refresh" content={'0; url=' + to} />`);
    // With scripts, the query and section of the old link come along.
    expect(redirect).toContain("' + location.search + location.hash);</' + 'script>'");
    expect(redirect).toContain('<meta name="robots" content="noindex" />');
    expect(redirect).toContain('<link rel="canonical" href={"https://me.github.io/studio/"} />');
    expect(files.get(`${GEN_ROOT}/paths.json`)).toContain('"/studio"');
    expect(files.get('src/routes/about/team/+page.svelte')).toContain('Generated by SiteOrigin Builder');
    expect(isRedirect(files.get('src/routes/about/team/+page.svelte'))).toBe(false);
    // It shows no header or footer while it sends visitors on.
    expect(files.get('src/routes/+layout.svelte')).toContain('const pagesWithoutHeader = new Set(["/about"]);');
    expect(files.get('src/routes/+layout.svelte')).toContain('const pagesWithoutFooter = new Set(["/about"]);');
    // An old address is no page: it stays out of the sitemap, which lists each page at its current address.
    const sitemap = files.get('static/sitemap.xml')!;
    expect(sitemap).not.toContain('/studio/about/<');
    expect(sitemap).toContain('<loc>https://me.github.io/studio/</loc>');
    expect(sitemap).toContain('<loc>https://me.github.io/studio/home/</loc>');
    expect(sitemap).toContain('<loc>https://me.github.io/studio/about/team/</loc>');
  });

  it('compiles, and its script reads the destination as data', () => {
    let s = exported(fresh());
    s = exported(applyOperations(s, [{ type: 'page.setHome', pageId: titled(s, 'About') }]).state);
    const file = generateProject(s).get('src/routes/about/+page.svelte')!;
    expect(file).toContain('\t{@html go}\n');
    // Reached by a link inside the running site, the head script never runs; the page goes once it is mounted.
    expect(file).toContain('onMount(() => location.replace(to + location.search + location.hash));');
    expect(() => compile(file, { generate: 'server', filename: 'src/routes/about/+page.svelte' })).not.toThrow();
    expect(() => compile(file, { generate: 'client', filename: 'src/routes/about/+page.svelte' })).not.toThrow();
    // The inline script the page writes, for a destination as the browser would get it.
    const go = new Function('to', `return ${file.match(/\tconst go = (.*);\n/)![1]};`);
    expect(go('/studio/')).toBe('<script>location.replace("/studio/" + location.search + location.hash);</script>');
    expect(go('/a</script>')).not.toContain('</script>"');
  });

  it('follows its page to a later address, at any depth', () => {
    let s = exported(fresh());
    const about = titled(s, 'About');
    const homeId = s.site.homePageId;
    s = exported(applyOperations(s, [{ type: 'page.update', pageId: about, route: '/work/about/' }]).state);
    s = exported(applyOperations(s, [{ type: 'page.setHome', pageId: about }]).state);
    s = exported(applyOperations(s, [{ type: 'page.update', pageId: about, title: 'Studio' }]).state);
    s = exported(applyOperations(s, [{ type: 'page.setHome', pageId: homeId }]).state);
    expect(s.pages[about].route).toBe('/studio/');
    const files = generateProject(s);
    expect(files.get('src/routes/work/about/+page.svelte')).toContain('const to = resolve("/studio/");');
    expect(files.get('src/routes/home/+page.svelte')).toContain('const to = resolve("/");');
    expect(files.get('src/routes/studio/+page.svelte')).toContain('A small studio with a long view');
  });

  it('writes the same files for the same project', () => {
    let s = exported(fresh());
    s = exported(applyOperations(s, [{ type: 'page.setHome', pageId: titled(s, 'About') }]).state);
    const files = generateProject(s);
    expect(isRedirect(files.get('src/routes/about/+page.svelte'))).toBe(true);
    expect([...files.entries()]).toEqual([...generateProject(structuredClone(s)).entries()]);
  });
});

describe('empty slots in the editor preview (issue #96)', () => {
  /** A blank site with a second Section placed empty, and the page file each run writes for Home. */
  function emptySection() {
    const base = createStarterState('blank', 'Blank', false);
    const r = applyOperations(base, [{ type: 'node.insert', owner: { kind: 'page', id: base.site.homePageId }, parentId: null, componentId: 'layout.section' }]);
    return { s: r.state, id: r.results[0].nodeId as string, page: { kind: 'page' as const, id: base.site.homePageId } };
  }
  const homeFile = 'src/routes/+page.svelte';
  const MARKER = /data-so-slot-|so-slot-empty/;

  it('marks only an empty slot, with its label and description, and only where the editor shows it', () => {
    const { s, id, page } = emptySection();
    const cache = new GenerationCache();
    const dev = generateProject(s, { instrument: true }, cache);
    const home = dev.get(homeFile)!;
    // The starter's section holds a heading and text: no marker. The new one is empty: one marker, labelled.
    expect(home.match(/data-so-slot-empty=/g)).toHaveLength(1);
    expect(home).toContain('data-so-editor-only=""');
    expect(home).toContain('<strong>{"Content"}</strong>');
    expect(home).toContain('<span>{"Headings, text, images, buttons and components placed inside the section."}</span>');
    for (const [path, src] of dev) if (path.endsWith('.svelte')) expect(() => compile(src, { filename: path, generate: 'client', runes: true }), path).not.toThrow();
    // No clean file holds the marker, the bridge's styling for it, or its label markup, from a fresh run or the shared cache.
    for (const files of [generateProject(s, {}, cache), generateProject(s)]) for (const [path, src] of files) expect(src, path).not.toMatch(MARKER);
    // Filled, the slot shows its content instead; emptied again, the marker comes back, and clean output stays free of it.
    const filled = applyOperations(s, [{ type: 'node.insert', owner: page, parentId: id, slot: 'content', primitive: 'heading', text: 'Now filled' }]).state;
    const filledHome = generateProject(filled, { instrument: true }, cache).get(homeFile)!;
    expect(filledHome).not.toMatch(MARKER);
    expect(filledHome.match(/Now filled/g)).toHaveLength(1);
    for (const [path, src] of generateProject(filled, {}, cache)) expect(src, path).not.toMatch(MARKER);
    const emptied = applyOperations(filled, [{ type: 'node.remove', owner: page, nodeId: (filled.pages[page.id].nodes[id] as InstanceNode).slots!.content[0] }]).state;
    for (const [path, src] of generateProject(emptied, {}, cache)) expect(src, path).not.toMatch(MARKER);
    expect(generateProject(emptied, { instrument: true }, cache).get(homeFile)!.match(/data-so-slot-empty=/g)).toHaveLength(1);
  });

  it('shows no marker for a slot closed to content, and a marker for one with room', () => {
    const { s, id } = emptySection();
    const def = (s.pages[s.site.homePageId].nodes[id] as InstanceNode).definitionId;
    s.components[def] = { ...s.components[def], slots: { content: { label: 'Content', max: 0 } } };
    expect(generateProject(s, { instrument: true }).get(homeFile)).not.toMatch(MARKER);
    s.components[def] = { ...s.components[def], slots: { content: { label: 'Body', max: 3 } } };
    // Phrasing content only, so a slot inside a paragraph keeps the paragraph whole. It names its placement where it
    // is placed, so the canvas can pick it and drop into it (#652).
    expect(generateProject(s, { instrument: true }).get(homeFile)).toContain(
      `<span class="so-slot-empty" data-so-editor-only="" data-so-slot-empty={"content"} data-so-slot-ctx={"page:${s.site.homePageId}"} data-so-slot-node={"${id}"}><strong>{"Body"}</strong></span>`
    );
  });

  it('names the placement an empty slot belongs to only where the page fills it, never inside a component’s design (#652)', () => {
    const { s, id, page } = emptySection();
    // A component whose design places an empty Section of its own, placed in the empty section on the page.
    const made = applyOperations(s, [
      { type: 'component.upsert', name: 'Framed', insertAs: 'element', properties: {}, nodes: [{ kind: 'element', id: 'root', children: [] }] }
    ]);
    const def = made.results[0].definitionId as string;
    const inner = applyOperations(made.state, [
      { type: 'node.insert', owner: { kind: 'component', id: def }, parentId: 'root', componentId: 'layout.section' },
      { type: 'node.insert', owner: page, parentId: id, slot: 'content', definitionId: def }
    ]).state;
    const files = generateProject(inner, { instrument: true });
    const home = files.get(homeFile)!;
    // The page's section is filled now; the design's section shows an empty slot, in the design's own file, with no
    // placement named.
    expect(home).not.toMatch(/data-so-slot-empty=/);
    const design = [...files.entries()].filter(([path, src]) => path.endsWith('.svelte') && src.includes('data-so-slot-empty='));
    expect(design.length).toBeGreaterThan(0);
    for (const [path, src] of design) expect(src, path).not.toMatch(/data-so-slot-(ctx|node|items)/);
  });
});

describe('the private project brief (#518)', () => {
  it('never reaches the website: every generated file, sitemap and meta tag is the same with or without it', () => {
    const s = fresh();
    applyAndKeep(s, [
      { type: 'site.update', baseUrl: 'https://harbour.example', description: 'Wheel classes and studio pottery in Leeds.' },
      { type: 'page.create', title: 'Classes', route: '/classes/' },
      // A draft, so the published run is a run of its own.
      { type: 'page.create', title: 'Prices', route: '/prices/' }
    ]);
    const draft = Object.values(s.pages).find((p) => p.title === 'Prices')!.id;
    applyAndKeep(s, [{ type: 'page.update', pageId: draft, draft: true }]);
    const cache = new GenerationCache();
    const outputs = (state: ProjectState) => [generateProject(state), generateProject(state, { instrument: true }), generateProject(publishedState(state)), generateProject(state, {}, cache)];
    const without = outputs(s);
    const markers = ['BRIEF-DESC-5c1e', 'BRIEF-NOTES-9a7f'];
    const withBrief = applyOperations(s, [{ type: 'brief.update', description: `For Ana's studio ${markers[0]}`, notes: `Client notes\n${markers[1]}` }]).state;
    expect(withBrief.brief?.notes).toContain(markers[1]);
    const withOut = outputs(withBrief);
    withOut.forEach((files, i) => {
      // Byte for byte the files made without a brief, in the clean, editor, published and cached runs alike.
      expect([...files.entries()]).toEqual([...without[i].entries()]);
      for (const [path, text] of files) for (const m of markers) expect(path.includes(m) || text.includes(m), `${path} holds ${m}`).toBe(false);
    });
    // The visitor-facing description still reaches the meta tags, and the sitemap is made, without the draft.
    const files = withOut[0];
    expect(files.get('static/sitemap.xml')).toContain('https://harbour.example/classes/');
    expect(withOut[2].get('static/sitemap.xml')).not.toContain('/prices/');
    expect([...files.values()].some((t) => t.includes('Wheel classes and studio pottery in Leeds.'))).toBe(true);
    // Nothing that makes the website is handed the brief at all, so no generator can start reading it.
    const handed: ProjectState[] = [];
    const original = GenerationCache.prototype.run;
    const run = vi.spyOn(GenerationCache.prototype, 'run').mockImplementation(function (this: GenerationCache, state: ProjectState, instrument: boolean) {
      handed.push(state);
      return original.call(this, state, instrument);
    });
    try {
      generateProject(withBrief, {}, new GenerationCache());
    } finally {
      run.mockRestore();
    }
    expect(handed.length).toBeGreaterThan(0);
    for (const state of handed) expect(Object.hasOwn(state, 'brief')).toBe(false);
  });
});

function applyAndKeep(s: ProjectState, ops: Parameters<typeof applyOperations>[1]) {
  Object.assign(s, applyOperations(s, ops).state);
}
