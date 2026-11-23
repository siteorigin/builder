import { describe, expect, it } from 'vitest';
import { compile, parse } from 'svelte/compiler';
import type { ComponentDefinition, GraphNode, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { validateState } from '@engine/validate';
import { validateStyleValue } from '@shared/styles';
import { applyOperations } from '@engine/apply';
import { GEN_ROOT, RUNTIME_DIR, STYLES_DIR, defFile, generateManagedComponent, generateProject, js, propLocals, resolveLink } from '@generator/index';
import { externalLink } from '@shared/links';
import { DRAFTS_JS, usedIcons } from '@generator/runtime-files';
import { contactForm } from '@catalogue/foundation/form';
import { checkSvelteSource } from '../../src/main/codecheck';
import { pageIds, pageSections, placeholderImageCount, planSectionPick, sharedPageIds } from '@generator/checks';

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
  it('compiles every file of both starters, including the contact form', () => {
    const s = fresh();
    addToHome(s, 'contact.form');
    expect(compileAll(generateProject(s))).toEqual([]);
    expect(compileAll(generateProject(s, { instrument: true }))).toEqual([]);
    expect(compileAll(generateProject(createStarterState('blank', 'Blank', false)))).toEqual([]);
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
      expect(calls.map((n) => n.expression?.arguments)).toEqual([[]]);
    }
    // Plain SvelteKit: no editor instrumentation, and nothing imported but Svelte and SvelteKit.
    expect(DRAFTS_JS).not.toMatch(/data-so-|__so|siteorigin-bridge/);
    expect([...DRAFTS_JS.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1])).toEqual(['svelte', '$app/navigation', '$app/state']);
  });

  it('marks the theme contact form and each answer for it, and keeps the form a component a customised copy can save', async () => {
    const source = contactForm.source!;
    const all = elements(source);
    expect(all.filter((e) => e.attributes.includes('data-keep-draft')).map((e) => e.name)).toEqual(['form']);
    // Every visible answer, and nothing else: not the provider's hidden fields or the spam trap.
    expect(all.filter((e) => e.attributes.includes('data-draft-field')).map((e) => e.name)).toEqual(['textarea', 'input']);
    expect(all.filter((e) => e.attributes.includes('data-draft-field')).every((e) => e.attributes.includes('required') && e.attributes.includes('oninput'))).toBe(true);
    // Forking or duplicating the form makes it a project component, whose code must pass the ordinary check.
    expect((await checkSvelteSource(source)).filter((p) => p.severity === 'error')).toEqual([]);
  });
});

describe('escaping and identifiers', () => {
  it('escapes "<" so text can never close a <script> element', () => {
    expect(js('</script><script>alert(1)</script>')).not.toContain('<');
    const s = fresh();
    const def = defOf(s, 'hero.split');
    (def.properties.heading as { default: string }).default = 'Hi </script><script>alert(1)</script>';
    const out = generateManagedComponent(s, def, {});
    expect(out.match(/<\/script/g)).toHaveLength(1);
  });

  it('renames properties that are reserved words or collide with generated names', () => {
    const s = fresh();
    const def = defOf(s, 'hero.split');
    for (const name of ['default', 'class', 'variant', 'has', 'so_o', 'item', 'new']) def.properties[name] = { type: 'string', label: name, default: name };
    def.tree!.nodes['heading'] = { ...def.tree!.nodes['heading'], kind: 'text', tag: 'h1', text: { $prop: 'default' } } as never;
    const locals = propLocals(def);
    expect(new Set(locals.values()).size).toBe(locals.size);
    for (const local of locals.values()) expect(['default', 'class', 'variant', 'has', 'so_o', 'item', 'new']).not.toContain(local);
    const files = generateProject(s);
    expect(compileAll(files)).toEqual([]);
    const component = [...files.entries()].find(([p]) => p.includes('hero-split'))![1];
    expect(component).toContain('default: prop_default = "default"');
    expect(component).toContain('prop_class = "class"');
    expect(component).toMatch(/<h1 [^>]*>\{prop_default\}<\/h1>/);
    expect(files.get('src/routes/+page.svelte')).toContain('prop_class={"class"}');
  });

  it('keeps renamed keys unique and ignores inherited object properties', () => {
    const s = fresh();
    const def = defOf(s, 'hero.split');
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
    expect(block('(min-width: 768px)')).toContain(`.${cls}.${cls} {\n\t\tgrid-template-columns: repeat(4, minmax(0, 1fr));`);
    expect(block('(max-width: 767.98px)')).toContain(`.${cls}.${cls} {\n\t\tgrid-template-columns: repeat(2, minmax(0, 1fr));`);
  });

  it('shows a part again when an instance un-hides what the definition hides', () => {
    const s = fresh();
    const def = defOf(s, 'shell.footer');
    def.tree!.nodes['brand-name'].styles = { base: { ...def.tree!.nodes['brand-name'].styles?.base, hidden: true } };
    const footer = Object.values(s.site.shell.footer.nodes)[0] as InstanceNode;
    footer.overrides = { brand: { base: { hidden: false } } };
    const css = generateProject(s).get(`${STYLES_DIR}/site.css`)!;
    expect(css).toMatch(/so-o-[^{]+-brand[^{]*\{[^}]*display: revert/);
  });

  it('drives button colours through --so-btn-bg / --so-btn-fg so hover follows them', () => {
    const s = fresh();
    const hero = addToHome(s, 'hero.centered');
    hero.variants = { tone: 'brand' };
    const files = generateProject(s);
    const components = files.get(`${STYLES_DIR}/components.css`)!;
    const rule = components.match(/hero-centered--tone-brand \.so-foundation-hero-centered__primary \{[^}]*\}/)![0];
    expect(rule).toContain('--so-btn-bg: var(--so-color-on-brand)');
    expect(rule).toContain('--so-btn-bg-hover: initial');
    expect(rule).toContain('--so-btn-fg: var(--so-color-brand-strong)');
    // A direct background would beat the hover rule whenever the styling rule is more specific.
    expect(rule).not.toMatch(/(^|\s)background:/);
    const theme = files.get(`${STYLES_DIR}/theme.css`)!;
    expect(theme).toContain('--so-btn-bg-hover: var(--so-color-brand-strong)');
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
  it('renders unlinked buttons as static text with one class list', () => {
    const link = generateProject(fresh()).get(`${RUNTIME_DIR}/Link.svelte`)!;
    expect(link).toContain("'so-btn--static'");
    expect(link.match(/className/g)!.length).toBe(3);
    expect(link).toContain("import { resolve } from '$app/paths'");
  });

  it('reports a labelled button without a link', () => {
    const s = fresh();
    expect(validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED')).toEqual([]);
    instanceOf(s, 'hero.split').props.primaryLink = { type: 'none', target: '' };
    const found = validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('Start a project');
    addToHome(s, 'pricing.plans');
    expect(validateState(s).filter((d) => d.code === 'BUTTON_UNLINKED')).toHaveLength(4);
  });

  it('survives a malformed component tree without crashing validation', () => {
    const s = fresh();
    const def = defOf(s, 'hero.split');
    const content = def.tree!.nodes['content'] as { children: string[] };
    content.children.push('grid');
    expect(() => validateState(s)).not.toThrow();
  });

  it('counts only images that render as placeholders', () => {
    // Logo strip items without a logo show a wordmark, and testimonial and team portraits are optional: none count.
    expect(placeholderImageCount(fresh())).toBe(6);
    const s = fresh();
    s.assets.assets['a1'] = { id: 'a1', name: 'Hero', file: 'static/assets/hero.jpg', mime: 'image/jpeg', bytes: 1, width: 10, height: 10, hash: 'x', kind: 'image', createdAt: '' };
    instanceOf(s, 'hero.split').props.image = { assetId: 'a1', alt: 'Hero' };
    expect(placeholderImageCount(s)).toBe(5);
  });

  it('labels footer navigation regions by their headings', () => {
    const files = generateProject(fresh());
    const footer = [...files.entries()].find(([p]) => p.endsWith('shell-footer.svelte'))![1];
    expect(footer).toContain('const uid = $props.id();');
    // A cleared heading is not rendered, so the landmark falls back to the heading's default name.
    expect(footer).toMatch(/<nav [^>]*aria-labelledby=\{has\(linksHeading\) \? `\$\{uid\}-explore-heading` : undefined\} aria-label=\{has\(linksHeading\) \? undefined : "Explore"\}/);
    expect(footer).toMatch(/<h2 [^>]*id=\{`\$\{uid\}-explore-heading`\}/);
    expect(footer).toMatch(/<h2 [^>]*id=\{`\$\{uid\}-contact-heading`\}/);
    expect(footer).toMatch(/<nav [^>]*aria-labelledby=\{has\(contactHeading\) \? `\$\{uid\}-contact-heading` : undefined\} aria-label=\{has\(contactHeading\) \? undefined : "Contact"\}/);
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
    expect(hero).toContain('sizes="(min-width: 1024px) 600px, (min-width: 768px) 100vw, 100vw"');
    const gallery = [...files.entries()].find(([p]) => p.endsWith('media-gallery.svelte'))![1];
    expect(gallery).not.toContain('eager');
    expect(gallery).toContain('sizes="(min-width: 1024px) 400px, (min-width: 768px) 50vw, 100vw"');
    const testimonials = [...files.entries()].find(([p]) => p.endsWith('testimonials-grid.svelte'))![1];
    expect(testimonials).toContain('sizes="44px"');
    expect(files.get(`${RUNTIME_DIR}/Image.svelte`)).toContain("fetchpriority={eager ? 'high' : undefined}");
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
    const hero = instanceOf(s, 'hero.split');
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
    const hero = instanceOf(s, 'hero.split');
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
    const grid = defOf(s, 'features.grid');
    const heroDef = defOf(s, 'hero.split');
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
    const hero = instanceOf(s, 'hero.split');
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
    expect(icons).not.toContain('"instagram"');
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
    expect(src).toContain('<input type="checkbox" name={honeypot}');
    expect(src).toContain('<input type="text" name={honeypot} tabindex="-1"');
    expect(src).toContain("disabled={!ready || status === 'sending'}");
    expect(src).toContain('HTMLFormElement.prototype.reset.call(form)');
    // The live regions sit outside the form, which is aria-busy while sending.
    expect(src.indexOf('role="status"')).toBeGreaterThan(src.indexOf('</form>'));
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
    const hero = home(s).nodes[home(s).rootIds[0]] as InstanceNode;
    expect(s.components[hero.definitionId].componentId).toBe('hero.split');
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
    const def = defOf(s, 'hero.split');
    const source = generateProject(s, { instrument: true }).get(defFile(def))!;
    expect(source).toMatch(/<\/script>\n\n<section [\s\S]*<\/section>\n$/);
    expect(source).not.toContain('{#key');
  });

  it('puts a component that starts with another component between boundaries of its own', () => {
    const base = fresh();
    const page = home(base);
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
    const contact = contactOf(s);
    const details = instanceOf(s, 'contact.details', contact.id);
    headerOf(s).props.ctaLink = { type: 'page', target: contact.id, anchor: 'get-in-touch' };
    expect(missing(s)).toHaveLength(1);
    s = applyOperations(s, [{ type: 'node.setContent', owner: { kind: 'page', id: contact.id }, nodeId: details.id, field: 'anchor', value: 'get-in-touch' }]).state;
    expect(missing(s)).toEqual([]);
    s = applyOperations(s, [{ type: 'node.remove', owner: { kind: 'page', id: contact.id }, nodeId: details.id }]).state;
    expect(missing(s)).toHaveLength(1);
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
    s.pages[s.site.homePageId].shell = 'none';
    expect(missing(s)).toHaveLength(1);
  });

  it('checks a shared link on every page that shows the header, and only those', () => {
    const s = fresh();
    const about = s.site.pageOrder[1];
    const contact = contactOf(s);
    headerOf(s).props.links = [{ id: 'i1', label: 'Services', link: { type: 'anchor', target: 'services' } }];
    instanceOf(s, 'features.grid').anchor = 'services';
    // Only IDs every page with the header has are safe for its "on this page" links.
    expect([...sharedPageIds(s)].sort()).toEqual(['main', 'so-site-nav', 'top']);
    let found = missing(s);
    expect(found).toHaveLength(1);
    expect(found[0].nodeId).toBe(headerOf(s).id);
    expect(found[0].message).toContain('the “Services” link');
    expect(found[0].message).toContain('About and Contact have no section');
    contact.shell = 'none';
    found = missing(s);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain(`${s.pages[about].title} has no section`);
    // A page without the header does not limit where the header's links can go.
    instanceOf(s, 'cta.banner', about).anchor = 'services';
    expect(sharedPageIds(s).has('services')).toBe(true);
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
    const outer = addToHome(s, 'layout.section');
    const id = installComponent(s, 'cta.banner');
    const a = makeInstance(s.components[id], { primaryLink: { type: 'anchor', target: 'one' } });
    const b = makeInstance(s.components[id], { primaryLink: { type: 'anchor', target: 'two' } });
    home(s).nodes[a.id] = a;
    home(s).nodes[b.id] = b;
    outer.slots = { content: [a.id, b.id] };
    expect(missing(s).map((d) => d.message.match(/#(\w+)/)?.[1]).sort()).toEqual(['one', 'two']);
    // Inside a definition both report against the placement that holds them, and both still count.
    const wrap = defOf(s, 'layout.section');
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
    let parent = addToHome(s, 'layout.section');
    const def = defOf(s, 'layout.section');
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
    addToHome(s, 'layout.section');
    const section = defOf(s, 'layout.section');
    const slotNode = Object.values(section.tree!.nodes).find((n) => n.kind === 'slot')!;
    const holder = Object.values(section.tree!.nodes).find((n) => n.kind === 'element' && n.children.includes(slotNode.id)) as { children: string[] };
    section.properties.rows = { type: 'list', label: 'Rows', itemLabel: 'Row', fields: {}, default: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}` })) } as never;
    section.tree!.nodes['rows'] = { id: 'rows', kind: 'repeat', list: { $prop: 'rows' }, children: [slotNode.id] };
    holder.children = holder.children.map((c) => (c === slotNode.id ? 'rows' : c));
    // Six sections nested inside the banner's own definition, a button at the bottom.
    const banner = defOf(s, 'cta.banner');
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
    const media = instanceOf(s, 'content.media');
    const home = { kind: 'page' as const, id: s.site.homePageId };
    s = applyOperations(s, [{ type: 'component.convertToCode', owner: home, nodeId: media.id, name: 'Media code' }]).state;
    (s.pages[s.site.homePageId].nodes[media.id] as InstanceNode).props.body = [{ type: 'p', spans: [{ text: 'See the steps', link: { type: 'anchor', target: 'steps' } }] }];
    expect(missing(s).map((d) => d.message)).toEqual([expect.stringContaining('the “See the steps” link in the text goes to #steps')]);
  });

  it('gives a component root the id its placement sets, before its own', () => {
    const s = fresh();
    const def = defOf(s, 'cta.banner');
    def.tree!.nodes[def.tree!.rootIds[0]].anchor = 'banner';
    const banner = instanceOf(s, 'cta.banner');
    expect(pageIds(s, s.site.homePageId).has('banner')).toBe(true);
    banner.anchor = 'start';
    const ids = pageIds(s, s.site.homePageId);
    expect(ids.has('start')).toBe(true);
    expect(ids.has('banner')).toBe(false);
  });

  it('leaves out ids inside a collapsing wrapper whose children all stay hidden', () => {
    const s = fresh();
    const def = defOf(s, 'cta.banner');
    def.tree!.nodes['actions'].anchor = 'cta-actions';
    const banner = instanceOf(s, 'cta.banner');
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
    const instance = addToHome(s, 'contact.details', { eyebrow: '', heading: '', lead: '', actionLabel: '' });
    const def = defOf(s, 'contact.details');
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
    const section = addToHome(s, 'layout.section');
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
    expect(pageSections(s, contactOf(s).id).map((x) => x.label)).toEqual(['Let’s talk', 'Get in touch', 'Frequently asked questions']);
    expect(pageSections(s, contactOf(s).id).every((x) => !x.anchor && !x.nested)).toBe(true);
    const blank = createStarterState('blank', 'Blank', false);
    expect(pageSections(blank, blank.site.homePageId).map((x) => x.label)).toEqual(['Welcome to Blank']);
    // The logo strip shows its heading as a paragraph; its Heading property still names it.
    expect(pageSections(s, s.site.homePageId)[1].label).toBe('Trusted by homeowners and local businesses');
    // A heading placed straight on the page is a section of its own.
    const h: GraphNode = { id: 'n_h', kind: 'text', tag: 'h2', text: 'Opening hours' };
    contactOf(s).nodes[h.id] = h;
    contactOf(s).rootIds.push(h.id);
    expect(pageSections(s, contactOf(s).id).at(-1)).toMatchObject({ nodeId: 'n_h', label: 'Opening hours', nested: false });
  });

  it('reuses the ID a section already renders with, so links to it keep working', () => {
    const s = fresh();
    const def = defOf(s, 'cta.banner');
    def.tree!.nodes[def.tree!.rootIds[0]].anchor = 'banner';
    const banner = instanceOf(s, 'cta.banner');
    expect(pageSections(s, s.site.homePageId).find((x) => x.nodeId === banner.id)?.anchor).toBe('banner');
    expect(planSectionPick(s, s.site.homePageId, banner.id)).toEqual({ anchor: 'banner', operations: [] });
    // A second placement inherits the same ID; it is offered as a section of its own and gets an ID of its own.
    const second = addToHome(s, 'cta.banner', { heading: 'One more thing' });
    const listed = pageSections(s, s.site.homePageId).find((x) => x.nodeId === second.id);
    expect(listed).toMatchObject({ label: 'One more thing', anchor: undefined });
    // With two elements rendering it, the ID no longer picks out the first one either: moving them would retarget it.
    expect(pageSections(s, s.site.homePageId).find((x) => x.nodeId === banner.id)?.anchor).toBeUndefined();
    expect(planSectionPick(s, s.site.homePageId, banner.id)!.operations).toHaveLength(1);
    expect(planSectionPick(s, s.site.homePageId, second.id)).toMatchObject({ anchor: 'one-more-thing', operations: [expect.objectContaining({ nodeId: second.id })] });
  });

  it('offers sections placed inside another section, and not the wrapper they name', () => {
    const s = fresh();
    const contact = contactOf(s);
    const [intro, details, faq] = contact.rootIds;
    const id = installComponent(s, 'layout.section');
    const wrapper = makeInstance(s.components[id], {});
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
    const contact = contactOf(s);
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
    const contact = contactOf(s);
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
    const def = defOf(s, 'faq.list');
    const inside = Object.values(def.tree!.nodes).find((n) => n.kind === 'text')!;
    inside.anchor = 'get-in-touch';
    expect(planSectionPick(s, contact.id, details)!.anchor).toBe('get-in-touch-2');
    (contact.nodes[intro] as InstanceNode).anchor = 'get-in-touch-2';
    expect(planSectionPick(s, contact.id, details)!.anchor).toBe('get-in-touch-3');
  });
});

describe('old addresses kept working (#37)', () => {
  const titled = (s: ProjectState, title: string) => Object.values(s.pages).find((p) => p.title === title)!.id;
  const isRedirect = (f: string | undefined) => !!f && f.includes('http-equiv="refresh"');

  it('redirects through the published sub-path, beside a real page nested under the old address', () => {
    let s = fresh();
    s.site.baseUrl = 'https://me.github.io/studio/';
    const about = titled(s, 'About');
    s = applyOperations(s, [{ type: 'page.setHome', pageId: about }]).state;
    s = applyOperations(s, [{ type: 'page.create', title: 'Team', route: '/about/team/' }]).state;
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
    expect(files.get('src/routes/+layout.svelte')).toContain('const pagesWithoutShell = new Set(["/about"]);');
    // An old address is no page: it stays out of the sitemap, which lists each page at its current address.
    const sitemap = files.get('static/sitemap.xml')!;
    expect(sitemap).not.toContain('/studio/about/<');
    expect(sitemap).toContain('<loc>https://me.github.io/studio/</loc>');
    expect(sitemap).toContain('<loc>https://me.github.io/studio/home/</loc>');
    expect(sitemap).toContain('<loc>https://me.github.io/studio/about/team/</loc>');
  });

  it('compiles, and its script reads the destination as data', () => {
    let s = fresh();
    s = applyOperations(s, [{ type: 'page.setHome', pageId: titled(s, 'About') }]).state;
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
    let s = fresh();
    const about = titled(s, 'About');
    const homeId = s.site.homePageId;
    s = applyOperations(s, [{ type: 'page.update', pageId: about, route: '/work/about/' }]).state;
    s = applyOperations(s, [{ type: 'page.setHome', pageId: about }]).state;
    s = applyOperations(s, [{ type: 'page.update', pageId: about, title: 'Studio' }]).state;
    s = applyOperations(s, [{ type: 'page.setHome', pageId: homeId }]).state;
    expect(s.pages[about].route).toBe('/studio/');
    const files = generateProject(s);
    expect(files.get('src/routes/work/about/+page.svelte')).toContain('const to = resolve("/studio/");');
    expect(files.get('src/routes/home/+page.svelte')).toContain('const to = resolve("/");');
    expect(files.get('src/routes/studio/+page.svelte')).toContain('A small studio with a long view');
  });

  it('writes the same files for the same project', () => {
    let s = fresh();
    s = applyOperations(s, [{ type: 'page.setHome', pageId: titled(s, 'About') }]).state;
    const files = generateProject(s);
    expect(isRedirect(files.get('src/routes/about/+page.svelte'))).toBe(true);
    expect([...files.entries()]).toEqual([...generateProject(structuredClone(s)).entries()]);
  });
});
