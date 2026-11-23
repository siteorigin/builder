import { describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { validateState } from '@engine/validate';
import { validateStyleValue } from '@shared/styles';
import { applyOperations } from '@engine/apply';
import { GEN_ROOT, RUNTIME_DIR, STYLES_DIR, generateManagedComponent, generateProject, js, propLocals, resolveLink } from '@generator/index';
import { externalLink } from '@shared/links';
import { usedIcons } from '@generator/runtime-files';
import { placeholderImageCount } from '@generator/checks';

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
    hero.variant = 'brand';
    const files = generateProject(s);
    const components = files.get(`${STYLES_DIR}/components.css`)!;
    const rule = components.match(/hero-centered--brand \.so-foundation-hero-centered__primary \{[^}]*\}/)![0];
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
    // Logo strip items without a logo show a wordmark, and testimonial portraits are optional: neither counts.
    expect(placeholderImageCount(fresh())).toBe(9);
    const s = fresh();
    s.assets.assets['a1'] = { id: 'a1', name: 'Hero', file: 'static/assets/hero.jpg', mime: 'image/jpeg', bytes: 1, width: 10, height: 10, hash: 'x', kind: 'image', createdAt: '' };
    instanceOf(s, 'hero.split').props.image = { assetId: 'a1', alt: 'Hero' };
    expect(placeholderImageCount(s)).toBe(8);
  });

  it('labels footer navigation regions by their headings', () => {
    const files = generateProject(fresh());
    const footer = [...files.entries()].find(([p]) => p.endsWith('shell-footer.svelte'))![1];
    expect(footer).toContain('const uid = $props.id();');
    expect(footer).toMatch(/<nav [^>]*aria-labelledby=\{`\$\{uid\}-explore-heading`\}/);
    expect(footer).toMatch(/<h2 [^>]*id=\{`\$\{uid\}-explore-heading`\}/);
    expect(footer).toMatch(/<nav [^>]*aria-labelledby=\{`\$\{uid\}-contact-heading`\}/);
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
